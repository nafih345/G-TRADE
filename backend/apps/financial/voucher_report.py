"""Voucher Reports (Accounts → Reports): one row per voucher.

There is no voucher table. It reads the same journals the Ledger and Day Book read, of voucher
type RV (Receipt Voucher), PV (Payment Voucher), CV (Contra Entry) or JV (Journal Voucher):
vouchers entered on the voucher screens (Normal and Bill to Bill) and the entries posted
automatically under those types (retail receipts, eye test fees, wholesale collections, purchase
payments, sales returns). `origin` narrows that down.

Every row also carries `debits` / `credits`: each ledger account on that side with its amount.
Contra and Journal reports show those (From → To, Dr / Cr) instead of accounts vs pay modes.

A row shows:
- the ledger accounts on the other side of the cash / bank lines (what was paid for, or received
  against), and the pay mode of each money line, read the way the Day Book reads it;
- the party and reference: for a voucher, the party it was entered for and the Reference No typed
  on it (metadata['reference']); for an automated posting, its bill and customer / dealer /
  supplier.

Reversal entries are not rows: the voucher they reverse is listed as REVERSED with the reversal's
number. Totals count POSTED vouchers only, so a reversed or draft voucher never inflates them.
"""
from collections import OrderedDict, defaultdict
from decimal import Decimal

from django.db.models import Q

from .accounting_catalog import SOURCES
from .daybook import MODES, _local_time, _mode, _money_account_ids, _reference_and_party, _source_lookups
from .models import JournalEntry, LedgerEntry
from .services import money

ZERO = Decimal('0')
MAX_PAGE_SIZE = 500
MAX_EXPORT_ROWS = 20000
MANUAL = Q(source_module='financial', source_event='voucher') | Q(source_module='')
STATUSES = ('POSTED', 'REVERSED', 'DRAFT', 'PENDING_APPROVAL')
TITLES = {'RV': 'Receipt Voucher', 'PV': 'Payment Voucher', 'CV': 'Contra Entry', 'JV': 'Journal Voucher'}


class VoucherReportError(ValueError):
    pass


def _origin_label(je):
    if je.source_key in ('financial.voucher', '') or not je.source_module:
        meta = je.metadata or {}
        return f"{TITLES[je.voucher_type.code]} (Bill to Bill)" if meta.get('bill_allocations') else TITLES[je.voucher_type.code]
    return SOURCES.get(je.source_key, (je.source_key,))[0]


def _row(je, lines, money_ids, look):
    voucher = je.voucher_type.code
    meta = je.metadata or {}
    manual = je.source_key in ('financial.voucher', '') or not je.source_module
    if manual:
        party = (meta.get('party') or {}).get('name') or je.source_number or ''
        reference = meta.get('reference') or ''
    else:
        reference, party = _reference_and_party(je, None, look)
    accounts, payments = OrderedDict(), OrderedDict()
    sides = {'debits': OrderedDict(), 'credits': OrderedDict()}
    for l in lines:
        acc = l.account
        amount = money(l.debit or 0) - money(l.credit or 0)
        if amount:
            d = sides['debits' if amount > 0 else 'credits'].setdefault(
                acc.pk, {'account_id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'amount': ZERO, 'memo': []})
            d['amount'] += abs(amount)
            if l.memo and l.memo not in d['memo']:
                d['memo'].append(l.memo)
        mode = _mode(l, acc, money_ids)
        if mode:
            p = payments.setdefault((mode, acc.pk), {'mode': mode, 'account_name': acc.name, 'amount': ZERO, 'memo': []})
            p['amount'] += abs(amount)
            if l.memo and l.memo not in p['memo']:
                p['memo'].append(l.memo)
        else:
            a = accounts.setdefault(acc.pk, {'account_id': str(acc.pk), 'code': acc.code, 'name': acc.name,
                                             'amount': ZERO, 'memo': []})
            a['amount'] += abs(amount)
            if l.memo and l.memo not in a['memo']:
                a['memo'].append(l.memo)
    reversed_by = je.reversed_entry.entry_number if je.reversed_entry_id and je.reversed_entry else ''
    allocations = meta.get('bill_allocations') or []
    row = {
        'id': str(je.pk), 'voucher_no': je.entry_number, 'voucher_type': voucher,
        'date': je.date.isoformat(),
        'time': (_local_time(je.posted_at or je.created_at).strftime('%H:%M') if (je.posted_at or je.created_at) else ''),
        'status': je.status, 'reversed_by': reversed_by,
        'origin': 'manual' if manual else 'auto', 'origin_label': _origin_label(je),
        'source_key': je.source_key, 'source_number': je.source_number or '',
        'reference': reference or '', 'party': party or '',
        'narration': je.narration or '',
        'amount': str(money(je.total_amount or 0)),
        'accounts': [{**a, 'amount': str(money(a['amount'])), 'memo': ' · '.join(a['memo'])} for a in accounts.values()],
        'payments': [{**p, 'amount': str(money(p['amount'])), 'memo': ' · '.join(p['memo'])}
                     for p in sorted(payments.values(), key=lambda p: MODES.index(p['mode']))],
        **{side: [{**d, 'amount': str(money(d['amount'])), 'memo': ' · '.join(d['memo'])} for d in rows.values()]
           for side, rows in sides.items()},
        'bills': [{'number': a.get('number') or '', 'amount': str(a.get('amount') or '')} for a in allocations],
        'branch': je.branch.name if je.branch_id else '',
        'created_by': je.created_by.username if je.created_by_id else '',
    }
    row['_text'] = ' '.join([row['voucher_no'], row['reference'], row['party'], row['narration'], row['source_number'],
                             *(f"{a['code']} {a['name']} {a['memo']}" for a in row['debits'] + row['credits']),
                             *(p['memo'] for p in row['payments'])]).lower()
    return row


def voucher_report(voucher, date_from, date_to, branch_ids=None, search='', status='', origin='all', modes=None,
                   account=None, page=1, page_size=100, export=False):
    """`voucher`: RV, PV, CV or JV. `branch_ids`: None = every branch, else the branches the vouchers must
    belong to. `status`: one of STATUSES or '' for all. `origin`: all / manual / auto."""
    voucher = (voucher or '').upper()
    if voucher not in TITLES:
        raise VoucherReportError('voucher must be RV (Receipt), PV (Payment), CV (Contra) or JV (Journal).')
    if not date_from or not date_to:
        raise VoucherReportError('Choose a From and To date.')
    if date_from > date_to:
        raise VoucherReportError('From date must be on or before To date.')

    qs = (JournalEntry.objects.filter(voucher_type__code=voucher, is_reversal=False, is_deleted=False,
                                      date__gte=date_from, date__lte=date_to, status__in=STATUSES)
          .select_related('voucher_type', 'branch', 'reversed_entry', 'created_by')
          .order_by('date', 'created_at', 'entry_number'))
    if branch_ids is not None:
        qs = qs.filter(branch_id__in=branch_ids)
    if origin == 'manual':
        qs = qs.filter(MANUAL)
    elif origin == 'auto':
        qs = qs.exclude(MANUAL)
    status = (status or '').upper()
    if status:
        if status not in STATUSES:
            raise VoucherReportError(f"Unknown status '{status}'.")
        qs = qs.filter(status=status)
    if account:
        qs = qs.filter(lines__account_id=account).distinct()
    entries = list(qs)

    lines_by_entry = defaultdict(list)
    for l in (LedgerEntry.objects.filter(journal_entry_id__in=[je.pk for je in entries])
              .select_related('account__account_group').order_by('id')):
        lines_by_entry[l.journal_entry_id].append(l)
    look = _source_lookups(entries)
    money_ids = _money_account_ids()
    rows = [_row(je, lines_by_entry[je.pk], money_ids, look) for je in entries]

    modes = [m for m in (modes or []) if m in MODES]
    if modes:
        rows = [r for r in rows if any(p['mode'] in modes for p in r['payments'])]
    s = (search or '').strip()
    if s:
        needle = s.lower()
        rows = [r for r in rows if needle in r['_text']]

    summary = _summary(rows)
    count = len(rows)
    if export:
        page, page_size = 1, MAX_EXPORT_ROWS
    else:
        page_size = max(1, min(int(page_size or 100), MAX_PAGE_SIZE))
    num_pages = max(1, -(-count // page_size))
    page = max(1, min(int(page or 1), num_pages))
    start = (page - 1) * page_size
    window = rows[start:start + page_size]
    for i, r in enumerate(window):
        r['row_no'] = start + i + 1

    return {
        'voucher': voucher, 'title': TITLES[voucher],
        'date_from': date_from.isoformat(), 'date_to': date_to.isoformat(),
        'search': s, 'status': status, 'origin': origin, 'modes': modes, 'account': str(account or ''),
        'summary': summary,
        'page': page, 'page_size': page_size, 'num_pages': num_pages, 'count': count,
        'truncated': export and count > MAX_EXPORT_ROWS,
        'mode_options': [m for m in MODES if m != 'Credit'],
        'rows': [{k: v for k, v in r.items() if not k.startswith('_')} for r in window],
    }


def _summary(rows):
    """Totals over every matching row (not just the page). Amounts count POSTED vouchers only."""
    posted = [r for r in rows if r['status'] == 'POSTED']
    by_mode = OrderedDict((m, {'mode': m, 'count': 0, 'amount': ZERO}) for m in MODES)
    by_origin = OrderedDict()
    by_account = OrderedDict()
    for r in posted:
        for p in r['payments']:
            by_mode[p['mode']]['count'] += 1
            by_mode[p['mode']]['amount'] += Decimal(p['amount'])
        o = by_origin.setdefault(r['origin_label'], {'label': r['origin_label'], 'count': 0, 'amount': ZERO})
        o['count'] += 1
        o['amount'] += Decimal(r['amount'])
        for a in r['accounts']:
            b = by_account.setdefault(a['account_id'], {'account_id': a['account_id'], 'code': a['code'],
                                                         'name': a['name'], 'count': 0, 'amount': ZERO})
            b['count'] += 1
            b['amount'] += Decimal(a['amount'])
    status_counts = defaultdict(int)
    for r in rows:
        status_counts[r['status']] += 1
    fmt = lambda d: {**d, 'amount': str(money(d['amount']))}  # noqa: E731
    return {
        'vouchers': len(rows),
        'posted': len(posted),
        'reversed': status_counts['REVERSED'],
        'drafts': status_counts['DRAFT'] + status_counts['PENDING_APPROVAL'],
        'total': str(money(sum((Decimal(r['amount']) for r in posted), ZERO))),
        'by_mode': [fmt(m) for m in by_mode.values() if m['count']],
        'by_origin': [fmt(o) for o in by_origin.values()],
        'by_account': sorted((fmt(a) for a in by_account.values()), key=lambda a: -Decimal(a['amount']))[:10],
    }
