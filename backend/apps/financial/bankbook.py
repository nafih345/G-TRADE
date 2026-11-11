"""Bank Book: every posted movement of the bank accounts, read from the ledger, plus the bank
settlements parties have promised but not yet made.

Like the Cashbook there is no bank book table for money: a row is one posted journal's net effect
on one bank ledger — the same LedgerEntry lines the Ledger, Trial Balance and Balance Sheet read,
under the same cut-off (reports.posted_lines). So every bank receipt and payment shows up, from
whatever screen booked it: New Sale / POS split payments (UPI, Card, Bank), Record Payment,
wholesale collections, purchase payments, eye test fees, Receipt / Payment / Contra vouchers,
bill-to-bill settlements and opening balances.

Bank accounts are BANK-subtype assets (Settings > Bank Master), unclassified assets under a "bank"
group, and whatever asset the Bank / Card / UPI roles are mapped to (card and UPI money lands in
the bank even when nobody picked a bank).

Rules:
- Banks are debit-normal assets: balance = debit - credit. Net debit on the bank = a deposit (the
  bank statement's "Credit"); net credit = a withdrawal (the statement's "Debit"). Lines of one
  journal on one bank are netted first; a journal that nets to zero on a bank is skipped.
- With "All bank accounts" each bank keeps its own rows, so a transfer between two banks shows as
  a withdrawal from one and a deposit into the other (the combined balance is unchanged).
- A reversed journal and its reversal both inside the listed rows are a void: hidden unless
  show_reversed. A half pair straddling the range stays, so closing = opening + in - out holds.
- Mode (NEFT / RTGS / IMPS / UPI / Cheque / Card / POS / Bank Transfer / Cash) comes from what was
  recorded: the Bank Book detail if someone set one, a cheque on the voucher, else the line memo
  (the pay method the screen saved), else a contra with a cash account (cash deposit / withdrawal).
- Reference (UTR / cheque no.) comes from the Bank Book detail, else the cheque number(s), else the
  reference the voucher or settlement was saved with.
- Filters (type, mode, search) narrow the rows listed; the summary always covers the period.

Pending settlements (models.PendingBankSettlement) are tracking only. They never touch the
balance; the summary shows them separately with a projected balance.
"""
import datetime
import re
from collections import defaultdict
from decimal import Decimal

from django.db.models import Count, Q, Sum
from django.utils import timezone
from rest_framework import serializers

from .accounting_catalog import PAYMENT_METHOD_ROLES
from .cashbook import _is_cash
from .models import (
    BANK_MODE_CHOICES, AccountMapping, BankEntryDetail, ChartOfAccount, Cheque, JournalEntry, LedgerEntry,
    PendingBankSettlement,
)
from .reports import posted_lines
from .services import AccountingError, audit, money

ZERO = Decimal('0')
MAX_PAGE_SIZE = 500
MAX_EXPORT_ROWS = 20000
BANK_ROLES = ('BANK', 'PAYMENT_CARD', 'PAYMENT_UPI')
MODE_LABELS = dict(BANK_MODE_CHOICES)

KIND_LABELS = {
    'OPENING': 'Opening Balance',
    'CUSTOMER_RECEIPT': 'Customer Receipt',
    'REFUND': 'Customer Refund',
    'EYE_TEST_FEE': 'Eye Test Fee',
    'DEALER_COLLECTION': 'Dealer Collection',
    'SUPPLIER_PAYMENT': 'Supplier Payment',
    'SALES_RETURN': 'Sales Return Refund',
    'PURCHASE_RETURN': 'Purchase Return Refund',
    'RECEIPT': 'Bank Receipt',
    'PAYMENT': 'Bank Payment',
    'BANK_CHARGES': 'Bank Charges / Expense',
    'CASH_DEPOSIT': 'Cash Deposit',
    'CASH_WITHDRAWAL': 'Cash Withdrawal',
    'TRANSFER_IN': 'Transfer In',
    'TRANSFER_OUT': 'Transfer Out',
}


class BankBookError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Bank accounts
# ---------------------------------------------------------------------------

def _mapped_bank_ids():
    return set(AccountMapping.objects.filter(role__in=BANK_ROLES, is_active=True).values_list('account_id', flat=True))


def bank_account_q(mapped_ids=None):
    """BANK-subtype assets, unclassified assets under a bank group, and assets the Bank / Card /
    UPI roles post to. Never a cash account."""
    mapped_ids = _mapped_bank_ids() if mapped_ids is None else mapped_ids
    asset = Q(account_group__account_type='Asset')
    return asset & ~Q(account_subtype='CASH') & (
        Q(account_subtype='BANK') | (Q(account_subtype='') & Q(account_group__name__icontains='bank'))
        | Q(pk__in=mapped_ids))


def _is_bank_account(acc, mapped_ids):
    if not acc.account_group_id or acc.account_group.account_type != 'Asset' or acc.account_subtype == 'CASH':
        return False
    return (acc.account_subtype == 'BANK' or acc.pk in mapped_ids
            or (acc.account_subtype == '' and 'bank' in (acc.account_group.name or '').lower()))


def bank_accounts():
    """Bank accounts for the picker, inactive ones included (they still hold history)."""
    from .mapping import _candidates
    default = next(iter(_candidates('BANK')), None)
    default_id = default.account_id if default else None
    rows = []
    qs = (ChartOfAccount.objects.select_related('account_group', 'bank_detail')
          .filter(bank_account_q()).order_by('code'))
    for acc in qs:
        detail = getattr(acc, 'bank_detail', None)
        rows.append({'id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'status': acc.status,
                     'account_group': acc.account_group.name if acc.account_group_id else '',
                     'bank_name': detail.bank_name if detail else '',
                     'account_number': detail.account_number if detail else '',
                     'ifsc_code': detail.ifsc_code if detail else '',
                     'is_default': acc.pk == default_id})
    return rows


def default_bank_account_id():
    rows = bank_accounts()
    for r in rows:
        if r['is_default']:
            return r['id']
    return rows[0]['id'] if rows else None


def _account_label(acc):
    return f"{acc.code} - {acc.name}"


# ---------------------------------------------------------------------------
# Bank Book
# ---------------------------------------------------------------------------

def _mode_from_text(text):
    """Instrument named in a memo / note, or ''."""
    t = (text or '').lower()
    if not t:
        return ''
    if 'cheque' in t or re.search(r'\bche?que?\b|\bchq\b', t):
        return 'CHEQUE'
    for needle, code in (('rtgs', 'RTGS'), ('neft', 'NEFT'), ('imps', 'IMPS'), ('pos', 'POS'), ('swipe', 'POS')):
        if re.search(rf'\b{needle}\b', t):
            return code
    for needle, role in PAYMENT_METHOD_ROLES:
        if needle in t:
            if role == 'PAYMENT_UPI':
                return 'UPI'
            if role == 'PAYMENT_CARD':
                return 'CARD'
            if role == 'BANK':
                return 'BANK_TRANSFER'
            if role == 'CASH':
                return 'CASH'
    return ''


_METHOD_WORDS = re.compile(r'^\s*(cash|upi|card|bank(\s+transfer)?|cheque|neft|rtgs|imps|gpay|phonepe|paytm|pos)\b[\s:.-]*',
                           re.IGNORECASE)


def _memo_reference(memo):
    """'NEFT UTR123 2026-10-01' -> 'UTR123 2026-10-01': the reference a pay line was saved with
    (settlements store "<method> <ref no> <ref date>"). Blank when the memo is only a method."""
    if not memo or ' · ' in memo:
        return ''
    rest = _METHOD_WORDS.sub('', memo, count=1).strip()
    return rest if rest and rest != memo.strip() else ''


def _kind(je, net, counters, mapped_ids):
    vtype = je.voucher_type.code if je.voucher_type_id else ''
    if vtype == 'OB' or je.reference_type == 'OPENING_BALANCE' or je.source_event == 'opening_balance':
        return 'OPENING'
    if counters and all(_is_bank_account(a, mapped_ids) for a in counters):
        return 'TRANSFER_IN' if net > 0 else 'TRANSFER_OUT'
    if counters and all(_is_cash(a) or _is_bank_account(a, mapped_ids) for a in counters):
        return 'CASH_DEPOSIT' if net > 0 else 'CASH_WITHDRAWAL'
    key = je.source_key
    if key == 'sales.payment':
        return 'CUSTOMER_RECEIPT' if net > 0 else 'REFUND'
    if key == 'sales.eye_test_fee':
        return 'EYE_TEST_FEE' if net > 0 else 'REFUND'
    if key in ('sales.wholesale_collection', 'sales.wholesale_invoice'):
        return 'DEALER_COLLECTION' if net > 0 else 'PAYMENT'
    # Sales → Sales Return / Purchase → Purchase Return refunds (apps/inventory/returns.py).
    if key == 'sales.sales_return':
        return 'SALES_RETURN'
    if key == 'purchasing.purchase_return':
        return 'PURCHASE_RETURN'
    if key.startswith('purchasing.'):
        return 'SUPPLIER_PAYMENT' if net < 0 else 'RECEIPT'
    if net > 0:
        return 'RECEIPT'
    if counters and all(a.account_group_id and a.account_group.account_type == 'Expense' for a in counters):
        return 'BANK_CHARGES'
    return 'PAYMENT'


def _moves(account_ids, date_from, date_to, branch_ids, show_reversed):
    """(opening, movements, hidden reversal count). A movement = one journal's net on one bank."""
    def scoped(qs):
        qs = qs.filter(account_id__in=account_ids)
        if branch_ids is not None:
            qs = qs.filter(journal_entry__branch_id__in=branch_ids)
        return qs

    opening = ZERO
    opening_by_acc = defaultdict(lambda: ZERO)
    if date_from:
        for r in (scoped(posted_lines()).filter(journal_entry__date__lt=date_from)
                  .values('account_id').annotate(dr=Sum('debit'), cr=Sum('credit'))):
            opening_by_acc[r['account_id']] = (r['dr'] or ZERO) - (r['cr'] or ZERO)
            opening += opening_by_acc[r['account_id']]

    grouped = (scoped(posted_lines(date_from, date_to))
               .values('journal_entry_id', 'account_id', 'journal_entry__date', 'journal_entry__created_at',
                       'journal_entry__entry_number', 'journal_entry__is_reversal', 'journal_entry__reversed_entry_id')
               .annotate(dr=Sum('debit'), cr=Sum('credit'))
               .order_by('journal_entry__date', 'journal_entry__created_at', 'journal_entry__entry_number', 'account_id'))
    moves = []
    for g in grouped:
        net = (g['dr'] or ZERO) - (g['cr'] or ZERO)
        if net != 0:
            moves.append({'id': g['journal_entry_id'], 'account_id': g['account_id'], 'net': net,
                          'is_reversal': g['journal_entry__is_reversal'], 'reversed_id': g['journal_entry__reversed_entry_id']})

    hidden = set()
    if not show_reversed:
        effect, first = defaultdict(dict), {}
        for m in moves:
            effect[m['id']][m['account_id']] = m['net']
            first.setdefault(m['id'], m)
        for jid, eff in effect.items():
            m = first[jid]
            rid = m['reversed_id']
            if m['is_reversal'] and rid in effect and rid not in hidden \
                    and effect[rid] == {a: -v for a, v in eff.items()}:
                hidden.update((jid, rid))
        moves = [m for m in moves if m['id'] not in hidden]
    return opening, opening_by_acc, moves, len(hidden)


def _cheques_for(entries):
    """journal id -> its cheques. Bill-to-bill receipts (BR- numbers) have no journal FK: they are
    matched through the receipt number the retail Payment / dealer collection notes carry."""
    out = defaultdict(list)
    ids = [je.pk for je in entries]
    for c in Cheque.objects.filter(journal_entry_id__in=ids).order_by('cheque_date'):
        out[c.journal_entry_id].append(c)
    return out


def _receipt_numbers(entries, look):
    """journal id -> BR-/receipt number its source document names (settlement receipts)."""
    out = {}
    for je in entries:
        text = ''
        if je.source_key == 'sales.payment':
            text = (look['payment_notes'].get(je.reference_id) or '')
        elif je.source_key == 'sales.wholesale_collection':
            text = (look['collection_notes'].get(je.reference_id) or '')
        found = re.search(r'BR-\d{4}-\d+(?:/\d+)?', text)
        if found:
            out[je.pk] = found.group(0)
    return out


def _lookups(entries):
    from .daybook import _source_lookups
    look = _source_lookups(entries)
    pay_ids = [je.reference_id for je in entries if je.source_key == 'sales.payment' and je.reference_id]
    col_ids = [je.reference_id for je in entries if je.source_key == 'sales.wholesale_collection' and je.reference_id]
    look['payment_notes'], look['collection_notes'], look['payment_refs'] = {}, {}, {}
    if pay_ids:
        from apps.sales.models import Payment
        rows = list(Payment.all_objects.filter(pk__in=pay_ids).values_list('pk', 'notes', 'reference_no'))
        look['payment_notes'] = {pk: notes for pk, notes, _ in rows}
        # Reference / UTR typed with the Card / UPI / Bank Transfer amount at billing.
        look['payment_refs'] = {pk: ref for pk, _, ref in rows if ref}
    if col_ids:
        from apps.sales.models import WholesalePaymentCollection
        look['collection_notes'] = dict(WholesalePaymentCollection.all_objects.filter(pk__in=col_ids)
                                        .values_list('pk', 'reference_note'))
    return look


def _local_time(dt):
    if dt is None:
        return None
    return timezone.localtime(dt) if timezone.is_aware(dt) else dt


def _detail_rows(moves, accounts):
    """Display fields for movements (a fixed number of queries whatever the row count)."""
    from .daybook import _reference_and_party

    ids = list(dict.fromkeys(m['id'] for m in moves))
    if not ids:
        return []
    mapped_ids = _mapped_bank_ids()
    entries = {je.pk: je for je in JournalEntry.objects.select_related('voucher_type', 'branch', 'created_by')
               .filter(pk__in=ids)}
    # Counter accounts are everything else on the journal, other banks included (a transfer).
    journal_accounts, memos = defaultdict(list), defaultdict(list)
    for l in LedgerEntry.objects.select_related('account__account_group').filter(journal_entry_id__in=ids):
        if l.memo:
            memos[(l.journal_entry_id, l.account_id)].append(l.memo)
        if l.account not in journal_accounts[l.journal_entry_id]:
            journal_accounts[l.journal_entry_id].append(l.account)

    entry_list = list(entries.values())
    look = _lookups(entry_list)
    cheques = _cheques_for(entry_list)
    br_numbers = _receipt_numbers(entry_list, look)
    if br_numbers:
        q = Q()
        for n in set(br_numbers.values()):
            q |= Q(voucher_number__icontains=n.split('/')[0])
        br_cheques = list(Cheque.objects.filter(q, journal_entry__isnull=True))
        for jid, n in br_numbers.items():
            cheques[jid].extend(c for c in br_cheques if n.split('/')[0] in c.voucher_number and c not in cheques[jid])
    details = {(d.journal_entry_id, d.bank_account_id): d
               for d in BankEntryDetail.objects.filter(journal_entry_id__in=ids).select_related('updated_by')}
    settled = defaultdict(list)
    for p in PendingBankSettlement.objects.filter(journal_entry_id__in=ids, status='SETTLED').values('journal_entry_id', 'number'):
        settled[p['journal_entry_id']].append(p['number'])

    rows = []
    for m in moves:
        je, acc = entries[m['id']], accounts[m['account_id']]
        net = m['net']
        others = [a for a in journal_accounts[m['id']] if a.pk != acc.pk]
        kind = _kind(je, net, others, mapped_ids)
        detail = details.get((je.pk, acc.pk))
        line_memos = list(dict.fromkeys(memos[(je.pk, acc.pk)]))
        chqs = [c for c in cheques[je.pk] if not c.bank_account_id or c.bank_account_id == acc.pk]

        derived_mode = ''
        if chqs:
            derived_mode = 'CHEQUE'
        if not derived_mode:
            for text in line_memos + [look['payment_notes'].get(je.reference_id) or '',
                                      look['collection_notes'].get(je.reference_id) or '', je.narration or '']:
                derived_mode = _mode_from_text(text)
                if derived_mode:
                    break
        if kind in ('CASH_DEPOSIT', 'CASH_WITHDRAWAL'):
            derived_mode = derived_mode if derived_mode not in ('', 'BANK_TRANSFER') else 'CASH'
        elif kind in ('TRANSFER_IN', 'TRANSFER_OUT') and not derived_mode:
            derived_mode = 'BANK_TRANSFER'
        if derived_mode == 'CASH' and kind not in ('CASH_DEPOSIT', 'CASH_WITHDRAWAL'):
            derived_mode = 'BANK_TRANSFER'   # a "Cash" memo on a bank line was booked to the bank
        mode = (detail.mode if detail and detail.mode else derived_mode) or ('' if kind == 'OPENING' else 'BANK_TRANSFER')

        derived_ref = ', '.join(dict.fromkeys(c.cheque_number for c in chqs))
        if not derived_ref and je.source_key == 'sales.payment':
            derived_ref = look['payment_refs'].get(je.reference_id) or ''
        if not derived_ref:
            derived_ref = next((r for r in (_memo_reference(x) for x in line_memos) if r), '')
        if not derived_ref and je.source_module in ('financial', '') and je.source_number:
            derived_ref = je.source_number
        reference = (detail.reference if detail and detail.reference else derived_ref)

        bill_ref, party = _reference_and_party(je, kind, look)
        if not party and chqs:
            party = next((c.party_name for c in chqs if c.party_name), '')
        if not party and kind not in ('OPENING', 'CASH_DEPOSIT', 'CASH_WITHDRAWAL', 'TRANSFER_IN', 'TRANSFER_OUT'):
            party = ', '.join(a.name for a in others)
        cheque_status = ''
        if chqs:
            order = ['BOUNCED', 'PENDING', 'DEPOSITED', 'CANCELLED', 'CLEARED']
            cheque_status = min((c.status for c in chqs), key=order.index)
        when = _local_time(je.posted_at or je.created_at)
        bank = getattr(acc, 'bank_detail', None)
        rows.append({
            'row_id': f"{je.pk}:{acc.pk}",
            'entry_id': str(je.pk), 'entry_number': je.entry_number, 'date': je.date.isoformat(),
            'time': when.strftime('%H:%M') if when else '',
            'posted_at': when.isoformat() if when else None,
            'branch_id': str(je.branch_id) if je.branch_id else None,
            'branch_name': je.branch.name if je.branch_id else '',
            'bank_account_id': str(acc.pk), 'bank_account': _account_label(acc),
            'bank_name': bank.bank_name if bank else '', 'bank_account_number': bank.account_number if bank else '',
            'voucher_kind': kind, 'voucher_kind_label': KIND_LABELS[kind],
            'voucher_type': je.voucher_type.code if je.voucher_type_id else '',
            # Bank-statement convention: money into the bank is a Credit, money out a Debit.
            'txn_type': 'CREDIT' if net > 0 else 'DEBIT',
            'mode': mode, 'mode_label': MODE_LABELS.get(mode, ''), 'mode_is_set': bool(detail and detail.mode),
            'reference': reference, 'reference_is_set': bool(detail and detail.reference),
            'party': party, 'bill_number': bill_ref if bill_ref != je.entry_number else '',
            'particulars': ', '.join(a.name for a in others) or ('Opening Balance' if kind == 'OPENING' else ''),
            'description': je.narration or '', 'memo': ' · '.join(line_memos),
            'deposit': str(money(net)) if net > 0 else None,
            'withdrawal': str(money(-net)) if net < 0 else None,
            'balance': str(money(m['balance'])),
            'value_date': detail.value_date.isoformat() if detail and detail.value_date else None,
            'remarks': detail.remarks if detail else '',
            'cheques': [{'id': str(c.pk), 'number': c.cheque_number, 'status': c.status,
                         'status_label': c.get_status_display()} for c in chqs],
            'cheque_status': cheque_status,
            'settlements': settled.get(je.pk, []),
            'entered_by': je.created_by.username if je.created_by_id else '',
            'status': je.status, 'is_reversal': je.is_reversal,
            'source_module': je.source_module, 'source_event': je.source_event, 'source_number': je.source_number,
            'reference_id': str(je.reference_id) if je.reference_id else None,
        })
    return rows


def _pending_summary(account_ids, all_accounts, branch_ids, today):
    qs = PendingBankSettlement.objects.filter(status='PENDING')
    if branch_ids is not None:
        qs = qs.filter(branch_id__in=branch_ids)
    if not all_accounts:
        default_id = default_bank_account_id()
        q = Q(bank_account_id__in=account_ids)
        if default_id and str(default_id) in {str(a) for a in account_ids}:
            q |= Q(bank_account__isnull=True)
        qs = qs.filter(q)

    def agg(q):
        r = q.aggregate(n=Count('id'), amt=Sum('amount'))
        return {'count': r['n'] or 0, 'amount': money(r['amt'] or ZERO)}
    rec, pay = agg(qs.filter(direction='RECEIVE')), agg(qs.filter(direction='PAY'))
    overdue = agg(qs.filter(expected_date__lt=today))
    chq = Cheque.objects.filter(status__in=Cheque.OPEN_STATUSES)
    if branch_ids is not None:
        chq = chq.filter(branch_id__in=branch_ids)
    if not all_accounts:
        chq = chq.filter(bank_account_id__in=account_ids)

    def cagg(q):
        r = q.aggregate(n=Count('id'), amt=Sum('amount'))
        return {'count': r['n'] or 0, 'amount': str(money(r['amt'] or ZERO))}
    return rec, pay, overdue, cagg(chq.filter(direction='RECEIVED')), cagg(chq.filter(direction='ISSUED'))


def bankbook(account_ids, all_accounts=False, date_from=None, date_to=None, branch_ids=None, search='',
             txn_type='', modes=None, show_reversed=False, page=1, page_size=100, export=False):
    """`branch_ids`: None = every branch (and journals with no branch), else the branch ids rows
    must belong to. `txn_type`: CREDIT / DEBIT. `modes`: list of BANK_MODE_CHOICES codes."""
    if date_from and date_to and date_from > date_to:
        raise BankBookError('From date must be on or before To date.')
    mapped_ids = _mapped_bank_ids()
    accounts = {a.pk: a for a in ChartOfAccount.all_objects.select_related('account_group', 'bank_detail')
                .filter(pk__in=account_ids)}
    if not accounts:
        raise BankBookError('Select a bank account.')
    for acc in accounts.values():
        if not _is_bank_account(acc, mapped_ids):
            raise BankBookError(f"'{_account_label(acc)}' is not a bank account.")
    txn_type = (txn_type or '').upper()
    if txn_type not in ('', 'CREDIT', 'DEBIT'):
        raise BankBookError('type must be CREDIT or DEBIT.')
    modes = [m for m in (modes or []) if m]
    if any(m not in MODE_LABELS for m in modes):
        raise BankBookError(f"mode must be one of {', '.join(MODE_LABELS)}.")

    opening, opening_by_acc, moves, hidden = _moves(list(accounts), date_from, date_to, branch_ids, show_reversed)
    running, total_in, total_out = opening, ZERO, ZERO
    per_acc = {a: {'in': ZERO, 'out': ZERO, 'count': 0} for a in accounts}
    for m in moves:
        running += m['net']
        m['balance'] = running
        bucket = per_acc[m['account_id']]
        bucket['count'] += 1
        if m['net'] > 0:
            total_in += m['net']
            bucket['in'] += m['net']
        else:
            total_out -= m['net']
            bucket['out'] -= m['net']
    closing = opening + total_in - total_out

    s = (search or '').strip()
    narrowed = bool(s or txn_type or modes)
    if narrowed:
        rows_all = _detail_rows(moves, accounts)
        if txn_type:
            rows_all = [r for r in rows_all if r['txn_type'] == txn_type]
        if modes:
            rows_all = [r for r in rows_all if r['mode'] in modes]
        if s:
            needle = s.lower()
            fields = ('entry_number', 'source_number', 'reference', 'party', 'bill_number', 'particulars',
                      'description', 'memo', 'remarks', 'bank_account', 'mode_label', 'voucher_kind_label')
            rows_all = [r for r in rows_all
                        if any(needle in (r[f] or '').lower() for f in fields)
                        or any(needle in (c['number'] or '').lower() for c in r['cheques'])
                        or needle in (r['deposit'] or r['withdrawal'] or '')]
        listed = rows_all
    else:
        listed = moves

    count = len(listed)
    if export:
        page, page_size = 1, MAX_EXPORT_ROWS
    else:
        page_size = max(1, min(int(page_size or 100), MAX_PAGE_SIZE))
    num_pages = max(1, -(-count // page_size))
    page = max(1, min(int(page or 1), num_pages))
    start = (page - 1) * page_size
    window = listed[start:start + page_size]
    rows = window if narrowed else _detail_rows(window, accounts)
    for i, r in enumerate(rows):
        r['row_no'] = start + i + 1

    if narrowed:
        matched_in = sum((money(r['deposit']) for r in listed if r['deposit']), ZERO)
        matched_out = sum((money(r['withdrawal']) for r in listed if r['withdrawal']), ZERO)
    else:
        matched_in, matched_out = total_in, total_out

    today = timezone.localdate()
    rec, pay, overdue, chq_in, chq_out = _pending_summary(list(accounts), all_accounts, branch_ids, today)
    ordered = sorted(accounts.values(), key=lambda a: a.code)
    return {
        'accounts': [{'id': str(a.pk), 'code': a.code, 'name': a.name, 'status': a.status} for a in ordered],
        'all_accounts': all_accounts,
        'date_from': date_from.isoformat() if date_from else None,
        'date_to': date_to.isoformat() if date_to else None,
        'summary': {
            'opening_balance': str(money(opening)), 'total_deposits': str(money(total_in)),
            'total_withdrawals': str(money(total_out)), 'closing_balance': str(money(closing)),
            'transactions': len(moves), 'hidden_reversals': hidden,
            'pending_receive': {'count': rec['count'], 'amount': str(rec['amount'])},
            'pending_pay': {'count': pay['count'], 'amount': str(pay['amount'])},
            'pending_overdue': {'count': overdue['count'], 'amount': str(overdue['amount'])},
            'uncleared_cheques_received': chq_in, 'uncleared_cheques_issued': chq_out,
            'projected_balance': str(money(closing + rec['amount'] - pay['amount'])),
            'by_account': [{
                'id': str(a.pk), 'label': _account_label(a),
                'opening': str(money(opening_by_acc[a.pk])), 'deposits': str(money(per_acc[a.pk]['in'])),
                'withdrawals': str(money(per_acc[a.pk]['out'])), 'transactions': per_acc[a.pk]['count'],
                'closing': str(money(opening_by_acc[a.pk] + per_acc[a.pk]['in'] - per_acc[a.pk]['out'])),
            } for a in ordered],
        },
        'search': s, 'type': txn_type, 'modes': modes,
        'matched': {'count': count, 'deposits': str(money(matched_in)), 'withdrawals': str(money(matched_out))},
        'page': page, 'page_size': page_size, 'num_pages': num_pages, 'count': count,
        'truncated': export and count > MAX_EXPORT_ROWS,
        'mode_options': [{'value': v, 'label': l} for v, l in BANK_MODE_CHOICES],
        'rows': rows,
    }


# ---------------------------------------------------------------------------
# Bank Book details (UTR / mode / value date) on a posted movement
# ---------------------------------------------------------------------------

class EntryDetailSerializer(serializers.Serializer):
    reference = serializers.CharField(required=False, allow_blank=True, max_length=80)
    mode = serializers.ChoiceField(choices=[''] + [c for c, _ in BANK_MODE_CHOICES], required=False, allow_blank=True)
    value_date = serializers.DateField(required=False, allow_null=True)
    remarks = serializers.CharField(required=False, allow_blank=True, max_length=500)


def save_entry_detail(journal, account, data, user=None, check_account=True):
    """Set the Bank Book details of `journal`'s movement on bank `account`. The Transaction Report
    keeps cash movements' details in the same table (it checks the account itself)."""
    if journal.status not in JournalEntry.LEDGER_STATUSES or journal.is_deleted:
        raise AccountingError('Only posted entries are in the Bank Book.')
    if check_account and not _is_bank_account(account, _mapped_bank_ids()):
        raise AccountingError(f"'{_account_label(account)}' is not a bank account.")
    if not LedgerEntry.objects.filter(journal_entry=journal, account=account).exists():
        raise AccountingError(f"{journal.entry_number} does not touch {_account_label(account)}.")
    if data.get('value_date') and data['value_date'] < journal.date:
        raise AccountingError('The bank date cannot be before the voucher date.')
    detail, _ = BankEntryDetail.objects.get_or_create(journal_entry=journal, bank_account=account,
                                                      defaults={'created_by': user if getattr(user, 'is_authenticated', False) else None})
    before = {f: str(getattr(detail, f) or '') for f in ('reference', 'mode', 'value_date', 'remarks')}
    for f in ('reference', 'mode', 'remarks'):
        if f in data:
            setattr(detail, f, (data[f] or '').strip())
    if 'value_date' in data:
        detail.value_date = data['value_date']
    if getattr(user, 'is_authenticated', False):
        detail.updated_by = user
    detail.save()
    after = {f: str(getattr(detail, f) or '') for f in ('reference', 'mode', 'value_date', 'remarks')}
    if before != after:
        audit('BANK_ENTRY_DETAIL', 'journal', journal.pk,
              f"{'Bank Book' if check_account else 'Transaction'} {journal.entry_number} @ {account.code}: ref {detail.reference or '—'}",
              before=before, after=after, user=user)
    return detail


# ---------------------------------------------------------------------------
# Pending bank settlements
# ---------------------------------------------------------------------------

PENDING_TRANSITIONS = {
    'PENDING': {'SETTLED', 'CANCELLED'},
    'SETTLED': {'PENDING'},       # undo a mistaken settle
    'CANCELLED': {'PENDING'},     # re-open
}
PARTY_KINDS = ('customer', 'dealer', 'supplier', 'other')
DUE_FILTERS = ('overdue', 'today', 'week')


class PendingInputSerializer(serializers.Serializer):
    direction = serializers.ChoiceField(choices=[c for c, _ in PendingBankSettlement.DIRECTION_CHOICES])
    party_kind = serializers.ChoiceField(choices=PARTY_KINDS, required=False, default='other')
    party_id = serializers.CharField(required=False, allow_blank=True, default='', max_length=64)
    party_name = serializers.CharField(max_length=200)
    party_phone = serializers.CharField(required=False, allow_blank=True, default='', max_length=40)
    bill_numbers = serializers.CharField(required=False, allow_blank=True, default='', max_length=255)
    amount = serializers.DecimalField(max_digits=14, decimal_places=2)
    agreed_date = serializers.DateField(required=False)
    expected_date = serializers.DateField()
    bank_account = serializers.UUIDField(required=False, allow_null=True, default=None)
    mode = serializers.ChoiceField(choices=[c for c, _ in BANK_MODE_CHOICES if c != 'CASH'], required=False,
                                   default='BANK_TRANSFER')
    reference = serializers.CharField(required=False, allow_blank=True, default='', max_length=80)
    notes = serializers.CharField(required=False, allow_blank=True, default='', max_length=500)

    def validate_party_name(self, value):
        value = value.strip()
        if not value:
            raise serializers.ValidationError('Enter the party name.')
        return value

    def validate_amount(self, value):
        if value <= 0:
            raise serializers.ValidationError('Amount must be more than zero.')
        return value

    def validate(self, attrs):
        attrs['agreed_date'] = attrs.get('agreed_date') or timezone.localdate()
        if attrs['expected_date'] < attrs['agreed_date']:
            raise serializers.ValidationError({'expected_date': 'Expected date cannot be before the agreed date.'})
        return attrs


class PendingUpdateSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=[c for c, _ in PendingBankSettlement.STATUS_CHOICES], required=False)
    settled_date = serializers.DateField(required=False, allow_null=True)
    settled_amount = serializers.DecimalField(max_digits=14, decimal_places=2, required=False, allow_null=True)
    voucher_number = serializers.CharField(required=False, allow_blank=True, max_length=50)
    journal_entry = serializers.UUIDField(required=False, allow_null=True)
    status_note = serializers.CharField(required=False, allow_blank=True, max_length=255)
    # Detail edits (while pending).
    party_name = serializers.CharField(required=False, max_length=200)
    party_phone = serializers.CharField(required=False, allow_blank=True, max_length=40)
    bill_numbers = serializers.CharField(required=False, allow_blank=True, max_length=255)
    amount = serializers.DecimalField(max_digits=14, decimal_places=2, required=False)
    expected_date = serializers.DateField(required=False)
    bank_account = serializers.UUIDField(required=False, allow_null=True)
    mode = serializers.ChoiceField(choices=[c for c, _ in BANK_MODE_CHOICES if c != 'CASH'], required=False)
    reference = serializers.CharField(required=False, allow_blank=True, max_length=80)
    notes = serializers.CharField(required=False, allow_blank=True, max_length=500)


def _bank_or_none(pk):
    if not pk:
        return None
    acc = ChartOfAccount.objects.select_related('account_group').filter(pk=pk).first()
    if acc is None or not _is_bank_account(acc, _mapped_bank_ids()):
        raise AccountingError('Select a valid bank account.')
    return acc


def _next_pending_number(date):
    from apps.common.sequences import bump_sequence
    from .models import JournalSequence
    return f"PBS-{date.year}-{bump_sequence(JournalSequence, {'prefix': 'PBS', 'year': date.year}):05d}"


def create_pending(data, user=None, branch=None):
    acc = _bank_or_none(data.get('bank_account'))
    actor = user if getattr(user, 'is_authenticated', False) else None
    row = PendingBankSettlement.objects.create(
        number=_next_pending_number(data['agreed_date']), direction=data['direction'],
        party_kind=data.get('party_kind') or 'other', party_id=data.get('party_id') or '',
        party_name=data['party_name'], party_phone=(data.get('party_phone') or '').strip(),
        bill_numbers=(data.get('bill_numbers') or '').strip(), amount=money(data['amount']),
        agreed_date=data['agreed_date'], expected_date=data['expected_date'], bank_account=acc,
        mode=data.get('mode') or 'BANK_TRANSFER', reference=(data.get('reference') or '').strip(),
        notes=(data.get('notes') or '').strip(), branch=branch, created_by=actor, updated_by=actor)
    audit('PENDING_BANK_CREATED', 'pending_bank_settlement', row.pk,
          f"{row.number} {row.get_direction_display()} {row.party_name} ₹{row.amount} by {row.expected_date}", user=user)
    return row


def _resolve_journal(data):
    if data.get('journal_entry'):
        je = JournalEntry.objects.filter(pk=data['journal_entry']).first()
    elif (data.get('voucher_number') or '').strip():
        n = data['voucher_number'].strip()
        je = JournalEntry.objects.filter(Q(entry_number__iexact=n) | Q(source_number__iexact=n)) \
            .filter(status__in=JournalEntry.LEDGER_STATUSES, is_deleted=False).order_by('-date').first()
        if je is None:
            raise AccountingError(f"No posted voucher or bill numbered '{n}'.")
    else:
        return None
    if je is None or je.status not in JournalEntry.LEDGER_STATUSES or je.is_deleted:
        raise AccountingError('The linked voucher is not posted.')
    return je


def update_pending(row, data, user=None):
    today = timezone.localdate()
    before = pending_row(row, today)
    new = data.get('status') or row.status
    if new != row.status and new not in PENDING_TRANSITIONS[row.status]:
        raise AccountingError(f"A {row.get_status_display().lower()} settlement cannot be marked "
                              f"{dict(PendingBankSettlement.STATUS_CHOICES)[new].lower()}.")
    edits = ('party_name', 'party_phone', 'bill_numbers', 'amount', 'expected_date', 'bank_account', 'mode', 'notes')
    if any(f in data for f in edits) and row.status != 'PENDING' and new != 'PENDING':
        raise AccountingError('Details can only be changed while the settlement is pending.')
    for f in ('party_name', 'party_phone', 'bill_numbers', 'mode', 'notes', 'reference', 'status_note'):
        if f in data:
            setattr(row, f, (data[f] or '').strip())
    if 'party_name' in data and not row.party_name:
        raise AccountingError('Enter the party name.')
    if 'amount' in data:
        if data['amount'] <= 0:
            raise AccountingError('Amount must be more than zero.')
        row.amount = money(data['amount'])
    if 'expected_date' in data:
        if data['expected_date'] < row.agreed_date:
            raise AccountingError('Expected date cannot be before the agreed date.')
        row.expected_date = data['expected_date']
    if 'bank_account' in data:
        row.bank_account = _bank_or_none(data['bank_account'])

    if new == 'SETTLED' and row.status != 'SETTLED':
        je = _resolve_journal(data)
        row.journal_entry = je
        row.settled_date = data.get('settled_date') or (je.date if je else today)
        row.settled_amount = money(data['settled_amount']) if data.get('settled_amount') else row.amount
        if row.settled_amount <= 0:
            raise AccountingError('Settled amount must be more than zero.')
        if row.settled_date < row.agreed_date:
            raise AccountingError('Settled date cannot be before the agreed date.')
        if je and row.reference:
            # Carry the UTR onto the Bank Book row the voucher posted, unless one is already set.
            for line in je.lines.select_related('account__account_group'):
                if _is_bank_account(line.account, _mapped_bank_ids()):
                    d = BankEntryDetail.objects.filter(journal_entry=je, bank_account=line.account).first()
                    if not d or not d.reference:
                        save_entry_detail(je, line.account, {'reference': row.reference}, user=user)
    elif new == 'PENDING' and row.status != 'PENDING':
        row.settled_date, row.settled_amount, row.journal_entry = None, None, None
    elif new == 'CANCELLED' and row.status != 'CANCELLED' and not (data.get('status_note') or '').strip():
        raise AccountingError('Give a reason for cancelling.')

    if new != row.status:
        row.status = new
        row.status_changed_at = timezone.now()
    if getattr(user, 'is_authenticated', False):
        row.updated_by = user
    row.save()
    after = pending_row(row, today)
    keys = ('status', 'amount', 'expected_date', 'reference', 'settled_date', 'settled_amount', 'voucher_number')
    audit('PENDING_BANK_UPDATED', 'pending_bank_settlement', row.pk,
          f"{row.number} {before['status']} → {row.status}" if before['status'] != row.status else f"{row.number} details updated",
          before={k: str(before[k]) for k in keys}, after={k: str(after[k]) for k in keys}, user=user)
    return row


def pending_row(p, today=None):
    today = today or timezone.localdate()
    days = (p.expected_date - today).days if p.status == 'PENDING' else None
    return {
        'id': str(p.pk), 'number': p.number, 'direction': p.direction, 'direction_label': p.get_direction_display(),
        'party_kind': p.party_kind, 'party_id': p.party_id, 'party_name': p.party_name, 'party_phone': p.party_phone,
        'bill_numbers': p.bill_numbers, 'amount': str(p.amount),
        'agreed_date': p.agreed_date, 'expected_date': p.expected_date, 'days_left': days,
        'bank_account': str(p.bank_account_id) if p.bank_account_id else None,
        'bank_account_name': _account_label(p.bank_account) if p.bank_account_id else '',
        'mode': p.mode, 'mode_label': MODE_LABELS.get(p.mode, ''), 'reference': p.reference, 'notes': p.notes,
        'status': p.status, 'status_label': p.get_status_display(), 'status_note': p.status_note,
        'settled_date': p.settled_date, 'settled_amount': str(p.settled_amount) if p.settled_amount is not None else None,
        'journal_entry': str(p.journal_entry_id) if p.journal_entry_id else None,
        'voucher_number': p.journal_entry.entry_number if p.journal_entry_id else '',
        'branch': str(p.branch_id) if p.branch_id else None, 'branch_name': p.branch.name if p.branch_id else '',
        'created_at': p.created_at, 'created_by': p.created_by.username if p.created_by_id else '',
        'updated_by': p.updated_by.username if p.updated_by_id else '',
        'allowed_status': sorted(PENDING_TRANSITIONS[p.status]),
    }


def pending_list(*, direction='', statuses=(), due='', search='', bank_account='', branch_ids=None,
                 date_from=None, date_to=None, page=1, page_size=100, export=False):
    today = timezone.localdate()
    qs = PendingBankSettlement.objects.select_related('bank_account', 'branch', 'created_by', 'updated_by', 'journal_entry')
    if branch_ids is not None:
        qs = qs.filter(branch_id__in=branch_ids)
    if bank_account:
        qs = qs.filter(bank_account_id=bank_account)
    if date_from:
        qs = qs.filter(expected_date__gte=date_from)
    if date_to:
        qs = qs.filter(expected_date__lte=date_to)
    if search:
        s = search.strip()
        qs = qs.filter(Q(number__icontains=s) | Q(party_name__icontains=s) | Q(party_phone__icontains=s)
                       | Q(bill_numbers__icontains=s) | Q(reference__icontains=s) | Q(notes__icontains=s))
    base = qs
    if direction:
        qs = qs.filter(direction=direction)
    if statuses:
        qs = qs.filter(status__in=statuses)
    if due:
        if due not in DUE_FILTERS:
            raise AccountingError(f"due must be one of {', '.join(DUE_FILTERS)}.")
        qs = qs.filter(status='PENDING')
        qs = {'overdue': qs.filter(expected_date__lt=today), 'today': qs.filter(expected_date=today),
              'week': qs.filter(expected_date__gte=today, expected_date__lte=today + datetime.timedelta(days=7))}[due]
    qs = qs.order_by('status', 'expected_date', 'created_at')
    count = qs.count()
    matched = qs.aggregate(amt=Sum('amount'))['amt'] or ZERO
    if export:
        rows, page, num_pages = list(qs[:MAX_EXPORT_ROWS]), 1, 1
    else:
        page_size = max(1, min(int(page_size or 100), MAX_PAGE_SIZE))
        num_pages = max(1, -(-count // page_size))
        page = max(1, min(int(page or 1), num_pages))
        rows = list(qs[(page - 1) * page_size: page * page_size])

    def agg(q):
        r = q.aggregate(n=Count('id'), amt=Sum('amount'))
        return {'count': r['n'] or 0, 'amount': str(money(r['amt'] or ZERO))}
    open_qs = base.filter(status='PENDING')
    return {
        'today': today, 'count': count, 'page': page, 'num_pages': num_pages,
        'matched_amount': str(money(matched)), 'truncated': export and count > MAX_EXPORT_ROWS,
        'rows': [pending_row(p, today) for p in rows],
        'summary': {
            'to_receive': agg(open_qs.filter(direction='RECEIVE')),
            'to_pay': agg(open_qs.filter(direction='PAY')),
            'overdue': agg(open_qs.filter(expected_date__lt=today)),
            'due_today': agg(open_qs.filter(expected_date=today)),
            'due_week': agg(open_qs.filter(expected_date__gte=today, expected_date__lte=today + datetime.timedelta(days=7))),
            'settled': agg(base.filter(status='SETTLED')),
            'cancelled': agg(base.filter(status='CANCELLED')),
        },
        'mode_options': [{'value': v, 'label': l} for v, l in BANK_MODE_CHOICES if v != 'CASH'],
    }


def settlement_matches(row, branch_ids=None, limit=20):
    """Posted bank movements that could be the money for a pending settlement: the same
    direction, on or after the agreed date, not already linked, closest amount first."""
    accounts = {a.pk: a for a in ChartOfAccount.objects.select_related('account_group', 'bank_detail')
                .filter(bank_account_q())}
    if row.bank_account_id and row.bank_account_id in accounts:
        accounts = {row.bank_account_id: accounts[row.bank_account_id]}
    if not accounts:
        return []
    _o, _ob, moves, _h = _moves(list(accounts), row.agreed_date, None, branch_ids, False)
    sign = 1 if row.direction == 'RECEIVE' else -1
    linked = set(PendingBankSettlement.objects.filter(status='SETTLED', journal_entry__isnull=False)
                 .exclude(pk=row.pk).values_list('journal_entry_id', flat=True))
    moves = [m for m in moves if m['net'] * sign > 0 and m['id'] not in linked]
    for m in moves:
        m['balance'] = ZERO
    moves.sort(key=lambda m: (abs(abs(m['net']) - row.amount), m['id']))
    rows = _detail_rows(moves[:limit], accounts)
    party = row.party_name.lower()
    for r in rows:
        amt = money(r['deposit'] or r['withdrawal'])
        r['exact_amount'] = amt == row.amount
        r['party_match'] = bool(party) and party in (r['party'] or '').lower()
    rows.sort(key=lambda r: (not r['exact_amount'], not r['party_match']))
    return rows
