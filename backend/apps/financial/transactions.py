"""Accounts → Transaction Report: every cash and bank movement in the system, in one register.

GET /api/financial/reports/transactions/

Like the Cashbook and Bank Book there is no table for money here. A row is one posted journal's net
effect on one cash or bank ledger, read from the same LedgerEntry lines (reports.posted_lines
cut-off) the Ledger, Trial Balance and Balance Sheet read. Every screen that moves money therefore
shows up the moment its journal posts: New Sale / POS split payments, Record Payment, wholesale
collections, purchase payments, eye test fees, Receipt / Payment / Contra / Journal vouchers,
bill-to-bill settlements and opening balances.

- A transfer between two money accounts shows on both: out of one, into the other (with "All"
  accounts the combined balance is unchanged, exactly as the books say).
- Reversed pairs inside the listed rows are a void and hidden unless show_reversed (half pairs
  straddling the range stay, so closing = opening + in - out always holds).
- The summary always covers the period for the chosen accounts; direction / mode / kind / origin
  / search narrow the rows listed only.

Administrative control (views + JournalEntryViewSet.correct):
- Details (UTR / reference, mode, bank / value date, remarks) are tracking-only annotations kept in
  BankEntryDetail — one per (journal, money account), cash accounts included. They never post.
- Narration / reference of any posted journal may be corrected in place (audited).
- Amounts, accounts and dates of a *manual* voucher are corrected by reversal + re-post in one
  transaction (`correct_entry`): the ledger keeps both, linked through metadata. Automated entries
  are corrected from their source document (the sale, purchase, receipt ...), never here.
- Missing transactions are appended as ordinary Receipt / Payment / Contra vouchers through the
  posting service, so they land on the same books.
"""
from collections import defaultdict
from decimal import Decimal

from django.db.models import Count, Max

from . import bankbook
from .accounting_catalog import SOURCES
from .cashbook import _is_cash, cash_account_q
from .models import BANK_MODE_CHOICES, BankEntryDetail, ChartOfAccount, JournalEntry, LedgerEntry
from .services import AccountingError, audit, create_journal, money, reverse_entry

ZERO = Decimal('0')
MAX_PAGE_SIZE = 500
MAX_EXPORT_ROWS = 20000
MODE_LABELS = dict(BANK_MODE_CHOICES)
CHANNELS = ('all', 'cash', 'bank')
ORIGINS = ('all', 'manual', 'auto')

KIND_LABELS = {
    **bankbook.KIND_LABELS,
    'RECEIPT': 'Receipt',
    'PAYMENT': 'Payment',
    'BANK_CHARGES': 'Expense / Charges',
    'CASH_DEPOSIT': 'Cash Deposited to Bank',
    'CASH_WITHDRAWAL': 'Cash Withdrawn from Bank',
    'TRANSFER_IN': 'Transfer In',
    'TRANSFER_OUT': 'Transfer Out',
}


class TransactionReportError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Money accounts
# ---------------------------------------------------------------------------

def money_account_q():
    return cash_account_q() | bankbook.bank_account_q()


def _channel_of(acc, mapped_ids):
    if _is_cash(acc):
        return 'CASH'
    return 'BANK' if bankbook._is_bank_account(acc, mapped_ids) else None


def money_accounts():
    """Cash and bank accounts for the pickers, inactive ones included (they hold history)."""
    mapped_ids = bankbook._mapped_bank_ids()
    out = []
    for acc in (ChartOfAccount.objects.select_related('account_group')
                .filter(money_account_q()).order_by('code')):
        channel = _channel_of(acc, mapped_ids)
        if channel:
            out.append({'id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'status': acc.status,
                        'channel': channel, 'label': f"{acc.code} - {acc.name}"})
    return out


def is_money_account(acc):
    return _channel_of(acc, bankbook._mapped_bank_ids()) is not None


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def _is_manual(source_module):
    return source_module in ('', 'financial')


def _origin_label(r):
    if _is_manual(r['source_module']):
        return 'Manual voucher'
    key = f"{r['source_module']}.{r['source_event']}"
    return SOURCES.get(key, (key.replace('.', ' ').replace('_', ' ').title(),))[0]


def _journal_channels(journal_ids, mapped_ids):
    """journal id -> {account id: 'CASH' | 'BANK' | None} for every account on the journal."""
    out = defaultdict(dict)
    for l in (LedgerEntry.objects.filter(journal_entry_id__in=journal_ids)
              .select_related('account__account_group')):
        out[l.journal_entry_id][l.account_id] = _channel_of(l.account, mapped_ids)
    return out


def _rows(moves, accounts, mapped_ids):
    """Bank Book display rows for the movements, re-labelled from each account's side."""
    raw = bankbook._detail_rows(moves, accounts)
    if not raw:
        return []
    channels_by_journal = _journal_channels({m['id'] for m in moves}, mapped_ids)
    out = []
    for m, r in zip(moves, raw):
        acc = accounts[m['account_id']]
        channel = _channel_of(acc, mapped_ids)
        net = m['net']
        kind, mode = r['voucher_kind'], r['mode']
        others = [c for a, c in channels_by_journal[m['id']].items() if a != acc.pk]
        if channel == 'CASH':
            if kind != 'OPENING' and others and all(c == 'CASH' for c in others):
                kind = 'TRANSFER_IN' if net > 0 else 'TRANSFER_OUT'
            elif kind != 'OPENING' and others and all(c in ('CASH', 'BANK') for c in others):
                kind = 'CASH_WITHDRAWAL' if net > 0 else 'CASH_DEPOSIT'
            mode = mode if r['mode_is_set'] else ('' if kind == 'OPENING' else 'CASH')
        out.append({
            'row_id': r['row_id'], 'row_no': None,
            'entry_id': r['entry_id'], 'entry_number': r['entry_number'], 'date': r['date'], 'time': r['time'],
            'posted_at': r['posted_at'], 'branch_id': r['branch_id'], 'branch_name': r['branch_name'],
            'channel': channel, 'account_id': r['bank_account_id'], 'account': r['bank_account'],
            'kind': kind, 'kind_label': KIND_LABELS.get(kind, kind.title()),
            'voucher_type': r['voucher_type'],
            'direction': 'IN' if net > 0 else 'OUT',
            'mode': mode, 'mode_label': MODE_LABELS.get(mode, ''), 'mode_is_set': r['mode_is_set'],
            'reference': r['reference'], 'reference_is_set': r['reference_is_set'],
            'party': r['party'], 'bill_number': r['bill_number'], 'particulars': r['particulars'],
            'narration': r['description'], 'memo': r['memo'],
            'amount_in': r['deposit'], 'amount_out': r['withdrawal'], 'balance': r['balance'],
            'value_date': r['value_date'], 'remarks': r['remarks'],
            'cheques': r['cheques'], 'entered_by': r['entered_by'],
            'status': r['status'], 'is_reversal': r['is_reversal'],
            'source_module': r['source_module'], 'source_event': r['source_event'],
            'source_number': r['source_number'], 'reference_id': r['reference_id'],
            'origin': 'manual' if _is_manual(r['source_module']) else 'auto',
            'origin_label': _origin_label(r),
            # A posted manual voucher (not itself a reversal) can be corrected by reversal + re-post.
            'can_correct': _is_manual(r['source_module']) and r['status'] == 'POSTED' and not r['is_reversal'],
        })
    return out


def _account_ids(channel, account_id, mapped_ids):
    if channel not in CHANNELS:
        raise TransactionReportError('channel must be all, cash or bank.')
    accounts = [a for a in ChartOfAccount.all_objects.select_related('account_group', 'bank_detail')
                .filter(money_account_q()) if _channel_of(a, mapped_ids)]
    if account_id:
        accounts = [a for a in accounts if str(a.pk) == str(account_id)]
        if not accounts:
            raise TransactionReportError('Select a cash or bank account.')
    elif channel != 'all':
        accounts = [a for a in accounts if _channel_of(a, mapped_ids) == channel.upper()]
    if not accounts:
        raise TransactionReportError('No cash or bank accounts in the Chart of Accounts.')
    return {a.pk: a for a in accounts}


def report(date_from=None, date_to=None, branch_ids=None, channel='all', account_id=None, direction='',
           modes=None, kinds=None, origin='all', search='', show_reversed=False, page=1, page_size=100,
           export=False):
    """`branch_ids`: None = every branch (and journals without one), else the permitted ids."""
    if date_from and date_to and date_from > date_to:
        raise TransactionReportError('From date must be on or before To date.')
    direction = (direction or '').upper()
    if direction not in ('', 'IN', 'OUT'):
        raise TransactionReportError('direction must be IN or OUT.')
    origin = (origin or 'all').lower()
    if origin not in ORIGINS:
        raise TransactionReportError('origin must be all, manual or auto.')
    modes = [x for x in (modes or []) if x]
    if any(x not in MODE_LABELS for x in modes):
        raise TransactionReportError(f"mode must be one of {', '.join(MODE_LABELS)}.")
    kinds = [x for x in (kinds or []) if x]
    if any(x not in KIND_LABELS for x in kinds):
        raise TransactionReportError(f"kind must be one of {', '.join(KIND_LABELS)}.")

    mapped_ids = bankbook._mapped_bank_ids()
    accounts = _account_ids((channel or 'all').lower(), account_id, mapped_ids)
    opening, opening_by_acc, moves, hidden = bankbook._moves(list(accounts), date_from, date_to, branch_ids,
                                                             show_reversed)

    running = opening
    per_acc = {pk: {'in': ZERO, 'out': ZERO, 'count': 0} for pk in accounts}
    per_channel = {c: {'opening': ZERO, 'in': ZERO, 'out': ZERO, 'count': 0} for c in ('CASH', 'BANK')}
    for pk, value in opening_by_acc.items():
        if pk in accounts:
            per_channel[_channel_of(accounts[pk], mapped_ids)]['opening'] += value
    for mv in moves:
        running += mv['net']
        mv['balance'] = running
        a, ch = per_acc[mv['account_id']], per_channel[_channel_of(accounts[mv['account_id']], mapped_ids)]
        a['count'] += 1
        ch['count'] += 1
        if mv['net'] > 0:
            a['in'] += mv['net']
            ch['in'] += mv['net']
        else:
            a['out'] -= mv['net']
            ch['out'] -= mv['net']
    total_in = sum((c['in'] for c in per_channel.values()), ZERO)
    total_out = sum((c['out'] for c in per_channel.values()), ZERO)

    if direction:
        moves_listed = [mv for mv in moves if (mv['net'] > 0) == (direction == 'IN')]
    else:
        moves_listed = moves
    s = (search or '').strip()
    narrowed = bool(s or modes or kinds or origin != 'all')
    if narrowed:
        listed = _rows(moves_listed, accounts, mapped_ids)
        if modes:
            listed = [r for r in listed if r['mode'] in modes]
        if kinds:
            listed = [r for r in listed if r['kind'] in kinds]
        if origin != 'all':
            listed = [r for r in listed if r['origin'] == origin]
        if s:
            needle = s.lower()
            fields = ('entry_number', 'source_number', 'reference', 'party', 'bill_number', 'particulars',
                      'narration', 'memo', 'remarks', 'account', 'mode_label', 'kind_label', 'origin_label',
                      'entered_by', 'branch_name')
            listed = [r for r in listed
                      if any(needle in (r[f] or '').lower() for f in fields)
                      or any(needle in (c['number'] or '').lower() for c in r['cheques'])
                      or needle in (r['amount_in'] or r['amount_out'] or '')]
    else:
        listed = moves_listed

    count = len(listed)
    if export:
        page, page_size = 1, MAX_EXPORT_ROWS
    else:
        page_size = max(1, min(int(page_size or 100), MAX_PAGE_SIZE))
    num_pages = max(1, -(-count // page_size))
    page = max(1, min(int(page or 1), num_pages))
    start = (page - 1) * page_size
    window = listed[start:start + page_size]
    rows = window if narrowed else _rows(window, accounts, mapped_ids)
    for i, r in enumerate(rows):
        r['row_no'] = start + i + 1

    if narrowed or direction:
        def _sum(key):
            if narrowed:
                return sum((money(r[key]) for r in listed if r[key]), ZERO)
            return sum((abs(mv['net']) for mv in listed if (mv['net'] > 0) == (key == 'amount_in')), ZERO)
        matched_in, matched_out = _sum('amount_in'), _sum('amount_out')
    else:
        matched_in, matched_out = total_in, total_out

    ordered = sorted(accounts.values(), key=lambda a: a.code)
    channel_summary = {
        c.lower(): {'opening': str(money(v['opening'])), 'in': str(money(v['in'])), 'out': str(money(v['out'])),
                    'closing': str(money(v['opening'] + v['in'] - v['out'])), 'transactions': v['count']}
        for c, v in per_channel.items()
    }
    return {
        'date_from': date_from.isoformat() if date_from else None,
        'date_to': date_to.isoformat() if date_to else None,
        'channel': (channel or 'all').lower(), 'account_id': str(account_id) if account_id else None,
        'summary': {
            'opening_balance': str(money(opening)), 'total_in': str(money(total_in)),
            'total_out': str(money(total_out)), 'closing_balance': str(money(opening + total_in - total_out)),
            'transactions': len(moves), 'hidden_reversals': hidden,
            'cash': channel_summary['cash'], 'bank': channel_summary['bank'],
            'by_account': [{
                'id': str(a.pk), 'label': f"{a.code} - {a.name}", 'channel': _channel_of(a, mapped_ids),
                'opening': str(money(opening_by_acc[a.pk])), 'in': str(money(per_acc[a.pk]['in'])),
                'out': str(money(per_acc[a.pk]['out'])), 'transactions': per_acc[a.pk]['count'],
                'closing': str(money(opening_by_acc[a.pk] + per_acc[a.pk]['in'] - per_acc[a.pk]['out'])),
            } for a in ordered],
        },
        'matched': {'count': count, 'in': str(money(matched_in)), 'out': str(money(matched_out))},
        'page': page, 'page_size': page_size, 'num_pages': num_pages, 'count': count,
        'truncated': export and count > MAX_EXPORT_ROWS,
        'stamp': stamp(),
        'rows': rows,
    }


def options():
    return {
        'accounts': money_accounts(),
        'modes': [{'value': v, 'label': l} for v, l in BANK_MODE_CHOICES],
        'kinds': [{'value': k, 'label': v} for k, v in KIND_LABELS.items()],
    }


def stamp():
    """A cheap fingerprint of the books: changes whenever a journal is posted / reversed / edited
    or a transaction detail is saved. The screen polls it to refresh in real time."""
    j = JournalEntry.all_objects.aggregate(n=Count('id'), at=Max('updated_at'))
    d = BankEntryDetail.objects.aggregate(n=Count('id'), at=Max('updated_at'))
    parts = (j['n'], j['at'].isoformat() if j['at'] else '', d['n'], d['at'].isoformat() if d['at'] else '')
    return '|'.join(str(p) for p in parts)


# ---------------------------------------------------------------------------
# Administrative control
# ---------------------------------------------------------------------------

def save_detail(journal, account, data, user=None):
    """Reference / mode / value date / remarks of one cash or bank movement (tracking only)."""
    if not is_money_account(account):
        raise AccountingError(f"'{account.code} - {account.name}' is not a cash or bank account.")
    return bankbook.save_entry_detail(journal, account, data, user=user, check_account=False)


def edit_text(entry, narration=None, reference=None, user=None):
    """Correct the narration / voucher reference of a posted journal in place. Never touches an
    amount, account or date, so the books are unchanged; the change is audited."""
    if entry.is_deleted:
        raise AccountingError('This entry was deleted.')
    before = {'narration': entry.narration or '', 'reference': (entry.metadata or {}).get('reference', '')}
    fields = []
    if narration is not None and narration.strip() != (entry.narration or ''):
        entry.narration = narration.strip()
        fields.append('narration')
    if reference is not None and reference.strip() != before['reference']:
        if not _is_manual(entry.source_module):
            raise AccountingError('The reference of an automated entry is its source document number; '
                                  'add a UTR / reference in the transaction details instead.')
        entry.metadata = {**(entry.metadata or {}), 'reference': reference.strip()}
        fields.append('metadata')
    if not fields:
        return entry, False
    entry.save(update_fields=[*fields, 'updated_at'])
    after = {'narration': entry.narration or '', 'reference': (entry.metadata or {}).get('reference', '')}
    audit('JOURNAL_DETAILS_EDITED', 'journal', entry.pk, f"{entry.entry_number}: narration / reference corrected",
          before=before, after=after, user=user)
    return entry, True


def correct_entry(entry, data, reason, user=None, branch=None):
    """Replace a posted manual voucher: reverse it and post the corrected voucher in one
    transaction. Returns (reversal, corrected). `data` is a validated VoucherInputSerializer
    payload (POSTED)."""
    from . import cheques, settlements

    if not _is_manual(entry.source_module):
        raise AccountingError(f"{entry.entry_number} was posted automatically from {entry.source_key} "
                              f"{entry.source_number}. Correct the source document instead.")
    if entry.status != 'POSTED' or entry.is_reversal:
        raise AccountingError(f"{entry.entry_number} is {'a reversal' if entry.is_reversal else entry.status} "
                              "and cannot be corrected.")
    if not (reason or '').strip():
        raise AccountingError('Give a reason for the correction.')
    if any(l.get('cheque') for l in data['lines']):
        raise AccountingError('Cheque details cannot be changed by a correction; record the cheque in the Cheque Register.')
    if not data['lines']:
        raise AccountingError('A voucher needs lines.')
    reason = reason.strip()
    reversal = reverse_entry(entry, user=user, reason=f"Corrected — {reason}")
    settlements.on_voucher_reversed(entry)
    cheques.on_voucher_reversed(entry)
    meta = {'corrected_from': entry.entry_number, 'correction_reason': reason[:500]}
    if data.get('reference', '').strip():
        meta['reference'] = data['reference'].strip()
    corrected = create_journal(
        lines=[{k: v for k, v in l.items() if k != 'cheque'} for l in data['lines']], date=data['date'],
        narration=data['narration'], status='POSTED', voucher_type_code=data['voucher_type_code'],
        source_module='financial', source_event='voucher', source_number=data['reference_no'],
        reference_type={'RV': 'RECEIPT_VOUCHER', 'PV': 'PAYMENT_VOUCHER', 'CV': 'CONTRA_ENTRY',
                        'JV': 'JOURNAL_VOUCHER'}[data['voucher_type_code']],
        branch=branch if branch is not None else entry.branch, user=user, metadata=meta,
    )
    entry.refresh_from_db()
    entry.metadata = {**(entry.metadata or {}), 'corrected_by': corrected.entry_number}
    entry.save(update_fields=['metadata', 'updated_at'])
    audit('JOURNAL_CORRECTED', 'journal', entry.pk,
          f"{entry.entry_number} reversed by {reversal.entry_number}, replaced by {corrected.entry_number}: {reason}",
          before={'total': str(entry.total_amount)}, after={'total': str(corrected.total_amount)}, user=user)
    return reversal, corrected


def correction_template(entry):
    """The voucher as an editable payload (what the correction dialog starts from)."""
    lines = [{'account': str(l.account_id), 'account_label': f"{l.account.code} - {l.account.name}",
              'debit': str(money(l.debit)), 'credit': str(money(l.credit)), 'memo': l.memo or ''}
             for l in entry.lines.select_related('account').order_by('-debit', 'id')]
    return {
        'entry_id': str(entry.pk), 'entry_number': entry.entry_number,
        'voucher_type_code': entry.voucher_type.code if entry.voucher_type_id else '',
        'date': entry.date.isoformat(), 'narration': entry.narration or '',
        'reference_no': entry.source_number or '', 'reference': (entry.metadata or {}).get('reference', ''),
        'status': entry.status, 'is_reversal': entry.is_reversal,
        'manual': _is_manual(entry.source_module), 'source_key': entry.source_key,
        'branch': str(entry.branch_id) if entry.branch_id else None,
        'has_cheques': entry.cheques.exists(),
        'has_bill_allocations': bool((entry.metadata or {}).get('bill_allocations')),
        'lines': lines,
    }
