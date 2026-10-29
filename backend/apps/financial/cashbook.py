"""Cashbook: the posted movements of the cash accounts, read from the ledger.

There is no cashbook table. A row is one posted journal's net effect on the selected cash
account(s) — the same LedgerEntry lines the Ledger, Trial Balance and Balance Sheet read, under
the same cut-off (reports.posted_lines: journal POSTED or REVERSED, not deleted). So a credit
sale (Dr Receivable / Cr Revenue) never shows up here; its cash receipt (Dr Cash / Cr
Receivable) does, once. Bank-only movements never touch a cash account and never show up.

Rules:
- Cash accounts are debit-normal assets: balance = debit - credit. Net debit = Cash In,
  net credit = Cash Out; lines of one journal on the account are netted first, so a row never
  has both. A journal that nets to zero on the account is not a cash movement and is skipped.
- "All cash accounts" nets each journal across every cash account, so a transfer between two
  cash accounts (zero net) drops out instead of being counted twice.
- A reversed journal and its reversal stay on the books as a pair that nets to zero. Both are
  hidden when the pair falls inside the listed rows (they are a void, not cash that moved) unless
  show_reversed is set; a half pair straddling the range stays, so balances always reconcile:
  closing = opening + cash in - cash out.
- The opening balance comes from every posted line dated before date_from under the same
  account and branch scope, never from the first visible row.
- Search only narrows the rows listed. Each row keeps its true running balance and the summary
  stays the period's, so the summary identity still holds.
"""
from collections import defaultdict
from decimal import Decimal

from django.db.models import Q, Sum

from .models import ChartOfAccount, JournalEntry, LedgerEntry
from .reports import posted_lines
from .services import money

ZERO = Decimal('0')
MAX_PAGE_SIZE = 500
MAX_EXPORT_ROWS = 20000

KIND_LABELS = {
    'OPENING': 'Opening Balance',
    'CASH_SALE': 'Cash Sale',
    'RECEIPT': 'Cash Receipt',
    'PAYMENT': 'Cash Payment',
    'PETTY_CASH': 'Petty Cash',
    'DEPOSIT': 'Cash Deposit',
    'WITHDRAWAL': 'Cash Withdrawal',
    'TRANSFER': 'Cash Transfer',
}


class CashbookError(ValueError):
    pass


def cash_account_q():
    """CASH-subtype assets, plus unclassified assets kept under a cash group (accounts users
    created before subtypes existed, e.g. a 'Petty Cash' ledger under 'Cash Accounts')."""
    return Q(account_group__account_type='Asset') & (
        Q(account_subtype='CASH') | (Q(account_subtype='') & Q(account_group__name__icontains='cash')))


def cash_accounts():
    """Cash accounts for the picker, inactive ones included (they still hold history)."""
    from .mapping import _candidates
    default = next(iter(_candidates('CASH')), None)
    default_id = default.account_id if default else None
    rows = []
    for acc in ChartOfAccount.objects.select_related('account_group').filter(cash_account_q()).order_by('code'):
        rows.append({'id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'status': acc.status,
                     'account_group': acc.account_group.name if acc.account_group_id else '',
                     'is_default': acc.pk == default_id})
    return rows


def default_cash_account_id():
    rows = cash_accounts()
    for r in rows:
        if r['is_default']:
            return r['id']
    return rows[0]['id'] if rows else None


def _is_cash(acc):
    if not acc.account_group_id or acc.account_group.account_type != 'Asset':
        return False
    return acc.account_subtype == 'CASH' or (
        acc.account_subtype == '' and 'cash' in (acc.account_group.name or '').lower())


def _is_bank(acc):
    if acc.account_subtype == 'BANK':
        return True
    return acc.account_subtype == '' and 'bank' in (acc.account_group.name if acc.account_group_id else '').lower()


def _kind(je, net, counters, payment_same_day):
    """Voucher type for a cash row, from the journal's source and the accounts on the other side."""
    vtype = je.voucher_type.code if je.voucher_type_id else ''
    if vtype == 'OB' or je.reference_type == 'OPENING_BALANCE' or je.source_event == 'opening_balance':
        return 'OPENING'
    if counters and all(_is_cash(a) for a in counters):
        return 'TRANSFER'
    if counters and all(_is_cash(a) or _is_bank(a) for a in counters):
        return 'DEPOSIT' if net < 0 else 'WITHDRAWAL'
    if net > 0:
        if je.source_key == 'sales.payment' and payment_same_day.get(je.reference_id):
            return 'CASH_SALE'
        return 'RECEIPT'
    if counters and all(a.account_group_id and a.account_group.account_type == 'Expense' for a in counters):
        return 'PETTY_CASH'
    return 'PAYMENT'


def cashbook(account_ids, all_accounts=False, date_from=None, date_to=None, branch_ids=None, search='',
             show_reversed=False, page=1, page_size=100, export=False):
    """`account_ids`: the cash account(s) to read. `branch_ids`: None = every branch (and
    journals with no branch), else a list of branch ids the rows must belong to."""
    if date_from and date_to and date_from > date_to:
        raise CashbookError('From date must be on or before To date.')
    accounts = list(ChartOfAccount.all_objects.select_related('account_group').filter(pk__in=account_ids))
    if not accounts:
        raise CashbookError('Select a cash account.')
    for acc in accounts:
        if not _is_cash(acc):
            raise CashbookError(f"'{acc.code} - {acc.name}' is not a cash account.")
    cash_ids = {a.pk for a in accounts}

    def scoped(qs):
        qs = qs.filter(account_id__in=cash_ids)
        if branch_ids is not None:
            qs = qs.filter(journal_entry__branch_id__in=branch_ids)
        return qs

    opening = ZERO
    if date_from:
        agg = scoped(posted_lines()).filter(journal_entry__date__lt=date_from).aggregate(dr=Sum('debit'), cr=Sum('credit'))
        opening = (agg['dr'] or ZERO) - (agg['cr'] or ZERO)

    # One aggregate row per journal (netted across the selected account(s)), oldest first; the
    # entry number breaks ties between journals posted at the same moment.
    grouped = (scoped(posted_lines(date_from, date_to))
               .values('journal_entry_id', 'journal_entry__date', 'journal_entry__created_at',
                       'journal_entry__entry_number', 'journal_entry__is_reversal',
                       'journal_entry__reversed_entry_id')
               .annotate(dr=Sum('debit'), cr=Sum('credit'))
               .order_by('journal_entry__date', 'journal_entry__created_at', 'journal_entry__entry_number'))
    moves = []
    for g in grouped:
        net = (g['dr'] or ZERO) - (g['cr'] or ZERO)
        if net != 0:
            moves.append({'id': g['journal_entry_id'], 'net': net, 'is_reversal': g['journal_entry__is_reversal'],
                          'reversed_id': g['journal_entry__reversed_entry_id']})

    hidden = set()
    if not show_reversed:
        net_by_id = {m['id']: m['net'] for m in moves}
        for m in moves:
            rid = m['reversed_id']
            if m['is_reversal'] and rid in net_by_id and rid not in hidden and net_by_id[rid] == -m['net']:
                hidden.update((m['id'], rid))
    moves = [m for m in moves if m['id'] not in hidden]

    running, total_in, total_out = opening, ZERO, ZERO
    for m in moves:
        running += m['net']
        m['balance'] = running
        if m['net'] > 0:
            total_in += m['net']
        else:
            total_out -= m['net']
    closing = opening + total_in - total_out

    listed = moves
    s = (search or '').strip()
    if s:
        matched = JournalEntry.objects.filter(status__in=JournalEntry.LEDGER_STATUSES, is_deleted=False).filter(
            Q(entry_number__icontains=s) | Q(narration__icontains=s) | Q(source_number__icontains=s)
            | Q(lines__memo__icontains=s) | Q(lines__account__name__icontains=s) | Q(lines__account__code__icontains=s))
        if date_from:
            matched = matched.filter(date__gte=date_from)
        if date_to:
            matched = matched.filter(date__lte=date_to)
        matched = set(matched.values_list('pk', flat=True).distinct())
        listed = [m for m in moves if m['id'] in matched]

    count = len(listed)
    if export:
        page, page_size = 1, MAX_EXPORT_ROWS
    else:
        page_size = max(1, min(int(page_size or 100), MAX_PAGE_SIZE))
    num_pages = max(1, -(-count // page_size))
    page = max(1, min(int(page or 1), num_pages))
    start = (page - 1) * page_size
    window = listed[start:start + page_size]

    rows = _detail_rows(window, cash_ids, start)
    matched_in = sum((m['net'] for m in listed if m['net'] > 0), ZERO)
    matched_out = sum((-m['net'] for m in listed if m['net'] < 0), ZERO)
    return {
        'accounts': [{'id': str(a.pk), 'code': a.code, 'name': a.name, 'status': a.status} for a in accounts],
        'all_accounts': all_accounts,
        'date_from': date_from.isoformat() if date_from else None,
        'date_to': date_to.isoformat() if date_to else None,
        'summary': {'opening_balance': str(money(opening)), 'total_cash_in': str(money(total_in)),
                    'total_cash_out': str(money(total_out)), 'closing_balance': str(money(closing)),
                    'transactions': len(moves), 'hidden_reversals': len(hidden)},
        'search': s,
        'matched': {'count': count, 'cash_in': str(money(matched_in)), 'cash_out': str(money(matched_out))},
        'page': page, 'page_size': page_size, 'num_pages': num_pages, 'count': count,
        'truncated': export and count > MAX_EXPORT_ROWS,
        'rows': rows,
    }


def _detail_rows(window, cash_ids, offset):
    """Display fields for one page of movements (one query for journals, one for their lines)."""
    ids = [m['id'] for m in window]
    if not ids:
        return []
    entries = {je.pk: je for je in JournalEntry.objects.select_related('voucher_type', 'branch').filter(pk__in=ids)}
    counters = defaultdict(list)
    memos = defaultdict(list)
    for l in LedgerEntry.objects.select_related('account__account_group').filter(journal_entry_id__in=ids).order_by('id'):
        if l.account_id in cash_ids:
            if l.memo:
                memos[l.journal_entry_id].append(l.memo)
        elif l.account not in counters[l.journal_entry_id]:
            counters[l.journal_entry_id].append(l.account)

    # A retail receipt taken the day its invoice was raised is a cash sale; later ones are receipts.
    payment_refs = [je.reference_id for je in entries.values() if je.source_key == 'sales.payment' and je.reference_id]
    same_day = {}
    if payment_refs:
        from apps.sales.models import Payment
        for p in Payment.all_objects.filter(pk__in=payment_refs).values('pk', 'payment_date', 'invoice__invoice_date',
                                                                       'invoice__document_type'):
            inv_date = p['invoice__invoice_date']
            same_day[p['pk']] = bool(inv_date and p['payment_date'] and str(p['invoice__document_type'] or 'INVOICE').upper() == 'INVOICE'
                                     and _as_date(p['payment_date']) == _as_date(inv_date))

    rows = []
    for i, m in enumerate(window):
        je = entries[m['id']]
        net, accs = m['net'], counters[m['id']]
        kind = _kind(je, net, accs, same_day)
        rows.append({
            'row_no': offset + i + 1,
            'entry_id': str(je.pk), 'entry_number': je.entry_number, 'date': je.date.isoformat(),
            'branch_id': str(je.branch_id) if je.branch_id else None,
            'branch_name': je.branch.name if je.branch_id else '',
            'voucher_kind': kind, 'voucher_kind_label': KIND_LABELS[kind],
            'voucher_type': je.voucher_type.code if je.voucher_type_id else '',
            'particulars': ', '.join(a.name for a in accs) or ('Opening Balance' if kind == 'OPENING' else ''),
            'description': je.narration or '', 'memo': ' · '.join(dict.fromkeys(memos[m['id']])),
            'cash_in': str(money(net)) if net > 0 else None,
            'cash_out': str(money(-net)) if net < 0 else None,
            'balance': str(money(m['balance'])),
            'status': je.status, 'is_reversal': je.is_reversal,
            'source_module': je.source_module, 'source_event': je.source_event, 'source_number': je.source_number,
            'reference_id': str(je.reference_id) if je.reference_id else None,
        })
    return rows


def _as_date(value):
    return value.date() if hasattr(value, 'date') and callable(value.date) else value
