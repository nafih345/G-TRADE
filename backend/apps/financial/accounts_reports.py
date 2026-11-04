"""Accounts → Reports, beyond the Payment / Receipt Voucher reports (voucher_report.py):

- Expense Report: every posted line on an Expense ledger, bucketed Direct / Indirect (Operating)
  the same way the Profit & Loss statement buckets them (pl_statement.pl_bucket), then by account
  group and account. Lines of POSTED and REVERSED journals both count, so a reversal pair nets to
  zero and the total always equals the P&L's expenses for the same range.
- Customer / Supplier Outstanding: the open bills settlements.open_bills computes (the same dues
  Bill-to-Bill vouchers settle), rolled up per party with aging, last payment and collection
  status, plus the control-ledger balances so a difference (an on-account voucher not matched to
  a bill, an opening balance) is visible instead of silently ignored.
- Accounts Activity: a register of every journal (voucher, automated posting, reversal) and a
  per-account activity summary (opening, period debit / credit, closing).

Nothing here keeps its own state: a voucher, sale, purchase or receipt shows up the moment its
journal or document is saved.
"""
from collections import OrderedDict, defaultdict
import uuid
from decimal import Decimal

from django.db.models import Count, Max, Q, Sum
from django.utils import timezone

from .accounting_catalog import SOURCES
from .daybook import MODES, _local_time, _mode, _money_account_ids, _reference_and_party, _source_lookups
from .models import DEBIT_NORMAL_TYPES, ChartOfAccount, JournalEntry, LedgerEntry
from .pl_statement import DIRECT_EXPENSE, INDIRECT_EXPENSE, pl_bucket
from .services import money

ZERO = Decimal('0')
MAX_PAGE_SIZE = 500
MAX_EXPORT_ROWS = 20000
EXPENSE_BUCKETS = (DIRECT_EXPENSE, INDIRECT_EXPENSE)
EXPENSE_LABELS = {DIRECT_EXPENSE: 'Direct Expenses', INDIRECT_EXPENSE: 'Indirect (Operating) Expenses'}
JOURNAL_STATUSES = ('POSTED', 'REVERSED', 'DRAFT', 'PENDING_APPROVAL')
SIDES = {'receivable': ('customer', 'dealer'), 'payable': ('supplier',)}
KIND_LABELS = {'customer': 'Customer', 'dealer': 'Dealer', 'supplier': 'Supplier'}
# (key, label, first day, last day) of days past due.
AGING = (('current', '0–30 days', 0, 30), ('d31_60', '31–60 days', 31, 60),
         ('d61_90', '61–90 days', 61, 90), ('d90_plus', 'Over 90 days', 91, None))


class AccountsReportError(ValueError):
    pass


def _check_range(date_from, date_to):
    if not date_from or not date_to:
        raise AccountsReportError('Choose a From and To date.')
    if date_from > date_to:
        raise AccountsReportError('From date must be on or before To date.')


def _paginate(rows, page, page_size, export):
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
    return {'page': page, 'page_size': page_size, 'num_pages': num_pages, 'count': count,
            'truncated': export and count > MAX_EXPORT_ROWS,
            'rows': [{k: v for k, v in r.items() if not k.startswith('_')} for r in window]}


def _is_manual(je):
    return je.source_key in ('financial.voucher', '') or not je.source_module


def _origin_label(je):
    if _is_manual(je):
        return je.voucher_type.name if je.voucher_type_id else 'Manual entry'
    return SOURCES.get(je.source_key, (je.source_key,))[0]


def _reference_party(je, look):
    """(reference / bill number, party) of a journal: a voucher's typed Reference No and party,
    an automated posting's bill and customer / dealer / supplier."""
    if _is_manual(je):
        meta = je.metadata or {}
        return meta.get('reference') or '', (meta.get('party') or {}).get('name') or je.source_number or ''
    return _reference_and_party(je, None, look)


def _time(je):
    t = _local_time(je.posted_at or je.created_at) if (je.posted_at or je.created_at) else None
    return t.strftime('%H:%M') if t else ''


# ---------------------------------------------------------------------------
# Expense Report
# ---------------------------------------------------------------------------

def _expense_accounts():
    out = {}
    for acc in (ChartOfAccount.all_objects.filter(account_group__account_type='Expense')
                .select_related('account_group')):
        out[acc.pk] = (acc, pl_bucket('Expense', acc.account_subtype, acc.account_group.name))
    return out


def expense_report(date_from, date_to, branch_ids=None, search='', bucket='', group='', account=None,
                   page=1, page_size=100, export=False):
    """`bucket`: DIRECT_EXPENSE / INDIRECT_EXPENSE / '' for both. `group`: account group id.
    Amounts are signed debit − credit, so a reversal or an expense refund is negative."""
    _check_range(date_from, date_to)
    bucket = (bucket or '').upper()
    if bucket and bucket not in EXPENSE_BUCKETS:
        raise AccountsReportError(f"Unknown expense category '{bucket}'.")
    accounts = _expense_accounts()
    wanted = [pk for pk, (acc, b) in accounts.items()
              if (not bucket or b == bucket) and (not group or str(acc.account_group_id) == str(group))
              and (not account or str(pk) == str(account))]

    qs = (LedgerEntry.objects.filter(account_id__in=wanted, journal_entry__status__in=JournalEntry.LEDGER_STATUSES,
                                     journal_entry__is_deleted=False, journal_entry__date__gte=date_from,
                                     journal_entry__date__lte=date_to)
          .select_related('journal_entry__voucher_type', 'journal_entry__branch', 'journal_entry__created_by',
                          'journal_entry__reversed_entry')
          .order_by('journal_entry__date', 'journal_entry__created_at', 'id'))
    if branch_ids is not None:
        qs = qs.filter(journal_entry__branch_id__in=branch_ids)
    lines = list(qs)

    entries = {l.journal_entry_id: l.journal_entry for l in lines}
    look = _source_lookups(list(entries.values()))
    money_ids = _money_account_ids()
    paid_via = defaultdict(list)  # journal -> pay modes of its cash / bank lines
    for l in (LedgerEntry.objects.filter(journal_entry_id__in=list(entries), account_id__in=money_ids)
              .select_related('account__account_group')):
        m = _mode(l, l.account, money_ids)
        if m and m not in paid_via[l.journal_entry_id]:
            paid_via[l.journal_entry_id].append(m)

    rows = []
    for l in lines:
        je = l.journal_entry
        acc, b = accounts[l.account_id]
        reference, party = _reference_party(je, look)
        row = {
            'id': str(l.pk), 'journal_id': str(je.pk), 'date': je.date.isoformat(), 'time': _time(je),
            'voucher_no': je.entry_number, 'voucher_type': je.voucher_type.code if je.voucher_type_id else '',
            'origin': 'manual' if _is_manual(je) else 'auto', 'origin_label': _origin_label(je),
            'status': je.status, 'is_reversal': je.is_reversal,
            'bucket': b, 'bucket_label': EXPENSE_LABELS[b],
            'group_id': str(acc.account_group_id), 'group': acc.account_group.name,
            'account_id': str(acc.pk), 'account_code': acc.code, 'account_name': acc.name,
            'reference': reference or '', 'party': party or '',
            'narration': je.narration or '', 'memo': l.memo or '',
            'paid_via': paid_via.get(je.pk) or ['Credit'],
            'amount': str(money(money(l.debit or 0) - money(l.credit or 0))),
            'branch': je.branch.name if je.branch_id else '',
            'created_by': je.created_by.username if je.created_by_id else '',
        }
        row['_text'] = ' '.join([row['voucher_no'], row['reference'], row['party'], row['narration'], row['memo'],
                                 row['account_code'], row['account_name'], row['group'], row['origin_label']]).lower()
        rows.append(row)

    s = (search or '').strip()
    if s:
        rows = [r for r in rows if s.lower() in r['_text']]

    groups = [{'id': str(g['account_group']), 'name': g['account_group__name']} for g in
              ChartOfAccount.all_objects.filter(account_group__account_type='Expense')
              .values('account_group', 'account_group__name').distinct().order_by('account_group__name')]
    return {
        'date_from': date_from.isoformat(), 'date_to': date_to.isoformat(), 'search': s,
        'bucket': bucket, 'group': str(group or ''), 'account': str(account or ''),
        'summary': _expense_summary(rows, date_from, date_to),
        'bucket_options': [{'key': k, 'label': EXPENSE_LABELS[k]} for k in EXPENSE_BUCKETS],
        'group_options': groups,
        **_paginate(rows, page, page_size, export),
    }


def _expense_summary(rows, date_from, date_to):
    """Category tree (bucket → group → account), month trend and pay-mode split over every
    matching line, not only the page."""
    tree = OrderedDict((b, {'key': b, 'label': EXPENSE_LABELS[b], 'amount': ZERO, 'count': 0, 'groups': OrderedDict()})
                       for b in EXPENSE_BUCKETS)
    by_month, by_mode = OrderedDict(), OrderedDict()
    for r in rows:
        amt = Decimal(r['amount'])
        b = tree[r['bucket']]
        b['amount'] += amt
        b['count'] += 1
        g = b['groups'].setdefault(r['group_id'], {'id': r['group_id'], 'name': r['group'], 'amount': ZERO,
                                                    'count': 0, 'accounts': OrderedDict()})
        g['amount'] += amt
        g['count'] += 1
        a = g['accounts'].setdefault(r['account_id'], {'id': r['account_id'], 'code': r['account_code'],
                                                        'name': r['account_name'], 'amount': ZERO, 'count': 0})
        a['amount'] += amt
        a['count'] += 1
        month = r['date'][:7]
        by_month[month] = by_month.get(month, ZERO) + amt
        mode = r['paid_via'][0] if len(r['paid_via']) == 1 else 'Mixed'
        by_mode[mode] = by_mode.get(mode, ZERO) + amt

    total = sum((b['amount'] for b in tree.values()), ZERO)
    fmt = lambda d: str(money(d))  # noqa: E731
    categories = []
    for b in tree.values():
        categories.append({
            'key': b['key'], 'label': b['label'], 'amount': fmt(b['amount']), 'count': b['count'],
            'share_pct': fmt(b['amount'] * 100 / total) if total else None,
            'groups': [{**{k: v for k, v in g.items() if k != 'accounts'}, 'amount': fmt(g['amount']),
                        'accounts': sorted(({**a, 'amount': fmt(a['amount'])} for a in g['accounts'].values()),
                                           key=lambda a: -Decimal(a['amount']))}
                       for g in sorted(b['groups'].values(), key=lambda g: -g['amount'])],
        })
    days = (date_to - date_from).days + 1
    return {
        'lines': len(rows), 'total': fmt(total),
        'direct': fmt(tree[DIRECT_EXPENSE]['amount']), 'indirect': fmt(tree[INDIRECT_EXPENSE]['amount']),
        'daily_average': fmt(total / days) if days else '0.00',
        'categories': categories,
        'by_month': [{'month': m, 'amount': fmt(v)} for m, v in sorted(by_month.items())],
        'by_mode': [{'mode': m, 'amount': fmt(v)} for m, v in sorted(by_mode.items(), key=lambda kv: -kv[1])],
    }


# ---------------------------------------------------------------------------
# Customer / Supplier Outstanding
# ---------------------------------------------------------------------------

def _aging_key(days):
    for key, _label, lo, hi in AGING:
        if days >= lo and (hi is None or days <= hi):
            return key
    return AGING[0][0]


def _bill_branches(kind, bill_ids):
    if kind == 'customer':
        from apps.sales.models import Invoice
        return dict(Invoice.all_objects.filter(pk__in=bill_ids).values_list('pk', 'branch_id'))
    if kind == 'supplier':
        from apps.purchasing.models import PurchaseInvoice
        return dict(PurchaseInvoice.all_objects.filter(pk__in=bill_ids).values_list('pk', 'branch_id'))
    return {}


def _last_payments(kind, party_ids):
    """{party_id: (date, amount)} of the latest money received from / paid to each party."""
    if not party_ids:
        return {}
    out = {}

    def keep(pid, d, amount):
        if d and (pid not in out or d > out[pid][0]):
            out[pid] = (d, money(amount or 0))

    if kind == 'customer':
        from apps.sales.models import Payment
        dead = ('CANCELLED', 'VOID', 'VOIDED', 'FAILED', 'REVERSED')
        for p in (Payment.objects.filter(customer_id__in=party_ids).order_by('payment_date', 'created_at')
                  .values('customer_id', 'payment_date', 'amount', 'status')):
            if (p['status'] or '').upper() not in dead and money(p['amount'] or 0) > 0:
                keep(p['customer_id'], p['payment_date'], p['amount'])
    elif kind == 'dealer':
        from apps.sales.models import WholesalePaymentCollection
        for c in (WholesalePaymentCollection.objects.filter(dealer_id__in=party_ids)
                  .order_by('payment_date', 'created_at').values('dealer_id', 'payment_date', 'amount_paid')):
            keep(c['dealer_id'], c['payment_date'], c['amount_paid'])
    else:
        from apps.purchasing.models import PurchaseInvoice
        for pi in (PurchaseInvoice.objects.filter(supplier_id__in=party_ids, paid_amount__gt=0)
                   .exclude(status__in=('DRAFT', 'CANCELLED')).values('supplier_id', 'purchase_date', 'paid_amount')):
            keep(pi['supplier_id'], pi['purchase_date'], pi['paid_amount'])
        wanted = {str(p): p for p in party_ids}
        for je in (JournalEntry.objects.filter(voucher_type__code='PV', status='POSTED', is_reversal=False,
                                               metadata__has_key='party')
                   .values('date', 'total_amount', 'metadata')):
            party = (je['metadata'] or {}).get('party') or {}
            if party.get('kind') == 'supplier' and party.get('id') in wanted:
                keep(wanted[party['id']], je['date'], je['total_amount'])
    return out


def _control_balances(side, branch_ids):
    """Ledger balances of the receivable / payable accounts the bills settle against."""
    from .mapping import resolve_role
    roles = ('RETAIL_RECEIVABLE', 'WHOLESALE_RECEIVABLE') if side == 'receivable' else ('SUPPLIER_PAYABLE',)
    ids = set()
    for role in roles:
        try:
            ids.add(resolve_role(role).pk)
        except Exception:  # an unmapped role just has no balance to show
            pass
    if side == 'payable':
        from apps.purchasing.models import Supplier
        ids |= set(Supplier.objects.exclude(ledger_account__isnull=True).values_list('ledger_account_id', flat=True))
    else:
        from apps.sales.models import Dealer
        ids |= set(Dealer.objects.exclude(ledger_account__isnull=True).values_list('ledger_account_id', flat=True))
    qs = LedgerEntry.objects.filter(account_id__in=ids, journal_entry__status__in=JournalEntry.LEDGER_STATUSES,
                                    journal_entry__is_deleted=False)
    if branch_ids is not None:
        qs = qs.filter(journal_entry__branch_id__in=branch_ids)
    sums = {r['account']: (r['dr'] or ZERO, r['cr'] or ZERO)
            for r in qs.values('account').annotate(dr=Sum('debit'), cr=Sum('credit'))}
    rows = []
    for acc in ChartOfAccount.all_objects.filter(pk__in=ids).order_by('code'):
        dr, cr = sums.get(acc.pk, (ZERO, ZERO))
        bal = (dr - cr) if side == 'receivable' else (cr - dr)
        if bal or acc.pk in sums:
            rows.append({'account_id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'balance': str(money(bal))})
    return rows


def outstanding_report(side, date_from=None, date_to=None, branch_ids=None, search='', kind='', aging='',
                       overdue_only=False, page=1, page_size=100, export=False, today=None):
    """Customer (side='receivable': retail customers + wholesale dealers) or Supplier
    (side='payable') dues as on today, one row per party with its open bills. date_from /
    date_to narrow by bill date. Bills are aged from their due date when they have one, else
    from the bill date. Wholesale bills carry no branch, so a branch filter leaves dealers out."""
    from .settlements import _party_models, _party_row, open_bills

    if side not in SIDES:
        raise AccountsReportError("side must be 'receivable' or 'payable'.")
    if date_from and date_to and date_from > date_to:
        raise AccountsReportError('From date must be on or before To date.')
    if aging and aging not in {a[0] for a in AGING}:
        raise AccountsReportError(f"Unknown aging bucket '{aging}'.")
    today = today or timezone.localdate()
    kinds = [k for k in SIDES[side] if not kind or k == kind]
    if branch_ids is not None:
        kinds = [k for k in kinds if k != 'dealer']

    parties = []
    for k in kinds:
        bills_by_party = open_bills(k, date_from=date_from, date_to=date_to)
        if branch_ids is not None:
            branch_of = _bill_branches(k, [b['id'] for bills in bills_by_party.values() for b in bills])
            allowed = {str(b) for b in branch_ids}
            bills_by_party = {pid: kept for pid, bills in bills_by_party.items()
                              if (kept := [b for b in bills if str(branch_of.get(_as_uuid(b['id']))) in allowed])}
        if not bills_by_party:
            continue
        model = _party_models()[k]
        records = {p.pk: p for p in model._base_manager.filter(pk__in=list(bills_by_party))}
        last = _last_payments(k, list(bills_by_party))
        for pid, bills in bills_by_party.items():
            p = records.get(pid)
            parties.append(_party_outstanding(k, p, pid, bills, last.get(pid), today, _party_row))

    totals_all = _outstanding_totals(parties)
    s = (search or '').strip().lower()
    if s:
        parties = [r for r in parties if s in r['_text']]
    if aging:
        parties = [r for r in parties if Decimal(r['aging'][aging]) > 0]
    if overdue_only:
        parties = [r for r in parties if Decimal(r['overdue']) > 0]
    parties.sort(key=lambda r: (-Decimal(r['due']), r['name'].lower()))

    summary = _outstanding_totals(parties)
    ledger = _control_balances(side, branch_ids)
    ledger_total = sum((Decimal(a['balance']) for a in ledger), ZERO)
    return {
        'side': side, 'title': 'Customer Outstanding' if side == 'receivable' else 'Supplier Outstanding',
        'as_of': today.isoformat(),
        'date_from': date_from.isoformat() if date_from else None, 'date_to': date_to.isoformat() if date_to else None,
        'search': (search or '').strip(), 'kind': kind, 'aging_filter': aging, 'overdue_only': overdue_only,
        'kind_options': [{'key': k, 'label': KIND_LABELS[k]} for k in SIDES[side]],
        'aging_buckets': [{'key': key, 'label': label} for key, label, _lo, _hi in AGING],
        'dealers_hidden': side == 'receivable' and branch_ids is not None and (not kind or kind == 'dealer'),
        'summary': summary,
        # Ledger cross-check over every open bill (before search / aging filters). A difference is
        # money on the control accounts that no bill explains: on-account vouchers, opening balances.
        'ledger': {'accounts': ledger, 'ledger_total': str(money(ledger_total)), 'bills_total': totals_all['due'],
                   'difference': str(money(ledger_total - Decimal(totals_all['due']))),
                   'comparable': not (date_from or date_to or kind)},
        **_paginate(parties, page, page_size, export),
    }


def _as_uuid(value):
    try:
        return uuid.UUID(str(value))
    except ValueError:
        return value


def _party_outstanding(kind, record, pid, bills, last, today, party_row):
    if record is not None:
        info = party_row(kind, record)
    else:
        info = {'kind': kind, 'id': str(pid), 'code': '', 'name': '(deleted party)', 'mobile': '', 'area': ''}
    aging = dict.fromkeys((a[0] for a in AGING), ZERO)
    out_bills, total, paid, due, overdue, oldest, max_days = [], ZERO, ZERO, ZERO, ZERO, None, 0
    for b in bills:
        basis = b['due_date'] or b['date']
        days = (today - basis).days if basis else 0
        key = _aging_key(max(days, 0))
        aging[key] += b['due']
        total += b['total']
        paid += b['paid']
        due += b['due']
        is_overdue = bool(b['due_date'] and b['due_date'] < today) or (not b['due_date'] and days > 30)
        if is_overdue:
            overdue += b['due']
        oldest = b['date'] if oldest is None or (b['date'] and b['date'] < oldest) else oldest
        max_days = max(max_days, days)
        out_bills.append({
            'id': b['id'], 'kind': b['kind'], 'number': b['number'], 'ref': b['ref'],
            'date': b['date'].isoformat() if b['date'] else None,
            'due_date': b['due_date'].isoformat() if b['due_date'] else None,
            'total': str(b['total']), 'paid': str(b['paid']), 'due': str(b['due']),
            'days': days, 'aging': key, 'overdue': is_overdue,
            'status': 'Unpaid' if b['paid'] <= 0 else 'Partly paid',
            'account': f"{b['account_code']} - {b['account_name']}",
        })
    if max_days > 90:
        status = 'Critical'
    elif overdue > 0:
        status = 'Overdue'
    else:
        status = 'Current'
    row = {
        **info, 'kind_label': KIND_LABELS[kind], 'bills': out_bills, 'bill_count': len(out_bills),
        'total': str(money(total)), 'paid': str(money(paid)), 'due': str(money(due)), 'overdue': str(money(overdue)),
        'collected_pct': str(money(paid * 100 / total)) if total else '0.00',
        'aging': {k: str(money(v)) for k, v in aging.items()},
        'oldest_bill': oldest.isoformat() if oldest else None, 'max_days': max_days,
        'last_payment_date': last[0].isoformat() if last else None,
        'last_payment_amount': str(last[1]) if last else None,
        'collection_status': status,
    }
    row['_text'] = ' '.join([info['code'], info['name'], info['mobile'], info['area'],
                             *(f"{b['number']} {b['ref']}" for b in out_bills)]).lower()
    return row


def _outstanding_totals(parties):
    aging = dict.fromkeys((a[0] for a in AGING), ZERO)
    total = paid = due = overdue = ZERO
    statuses = defaultdict(int)
    by_kind = OrderedDict()
    for r in parties:
        total += Decimal(r['total'])
        paid += Decimal(r['paid'])
        due += Decimal(r['due'])
        overdue += Decimal(r['overdue'])
        statuses[r['collection_status']] += 1
        for k in aging:
            aging[k] += Decimal(r['aging'][k])
        k = by_kind.setdefault(r['kind'], {'kind': r['kind'], 'label': r['kind_label'], 'parties': 0, 'due': ZERO})
        k['parties'] += 1
        k['due'] += Decimal(r['due'])
    return {
        'parties': len(parties), 'bills': sum(r['bill_count'] for r in parties),
        'total': str(money(total)), 'paid': str(money(paid)), 'due': str(money(due)),
        'overdue': str(money(overdue)), 'not_due': str(money(due - overdue)),
        'aging': {k: str(money(v)) for k, v in aging.items()},
        'status_counts': {s: statuses[s] for s in ('Current', 'Overdue', 'Critical')},
        'by_kind': [{**k, 'due': str(money(k['due']))} for k in by_kind.values()],
    }


# ---------------------------------------------------------------------------
# Accounts Activity: journal register + account summary
# ---------------------------------------------------------------------------

def activity_register(date_from, date_to, branch_ids=None, search='', voucher_types=None, origin='all',
                      status='', account=None, page=1, page_size=100, export=False):
    """Every journal in the range, reversal entries included (they are entries too), newest
    last. Totals count POSTED and REVERSED journals (what is on the ledger)."""
    _check_range(date_from, date_to)
    status = (status or '').upper()
    if status and status not in JOURNAL_STATUSES:
        raise AccountsReportError(f"Unknown status '{status}'.")
    qs = (JournalEntry.objects.filter(is_deleted=False, date__gte=date_from, date__lte=date_to,
                                      status__in=JOURNAL_STATUSES)
          .select_related('voucher_type', 'branch', 'reversed_entry', 'created_by')
          .order_by('date', 'created_at', 'entry_number'))
    if branch_ids is not None:
        qs = qs.filter(branch_id__in=branch_ids)
    if voucher_types:
        qs = qs.filter(voucher_type__code__in=voucher_types)
    manual = Q(source_module='financial', source_event='voucher') | Q(source_module='')
    if origin == 'manual':
        qs = qs.filter(manual)
    elif origin == 'auto':
        qs = qs.exclude(manual)
    elif origin and origin != 'all':
        module, _, event = origin.partition('.')
        qs = qs.filter(source_module=module, source_event=event)
    if status:
        qs = qs.filter(status=status)
    if account:
        qs = qs.filter(lines__account_id=account).distinct()
    entries = list(qs)

    lines_by_entry = defaultdict(list)
    for l in (LedgerEntry.objects.filter(journal_entry_id__in=[je.pk for je in entries])
              .select_related('account').order_by('id')):
        lines_by_entry[l.journal_entry_id].append(l)
    look = _source_lookups(entries)

    rows = []
    for je in entries:
        lines = lines_by_entry[je.pk]
        reference, party = _reference_party(je, look)
        linked = je.reversed_entry.entry_number if je.reversed_entry_id and je.reversed_entry else ''
        out_lines = [{'code': l.account.code, 'name': l.account.name, 'memo': l.memo or '',
                      'debit': str(money(l.debit or 0)), 'credit': str(money(l.credit or 0))} for l in lines]
        row = {
            'id': str(je.pk), 'date': je.date.isoformat(), 'time': _time(je), 'voucher_no': je.entry_number,
            'voucher_type': je.voucher_type.code if je.voucher_type_id else '',
            'voucher_type_name': je.voucher_type.name if je.voucher_type_id else 'Journal',
            'origin': 'manual' if _is_manual(je) else 'auto', 'origin_label': _origin_label(je),
            'source_key': je.source_key, 'reference_id': str(je.reference_id) if je.reference_id else None,
            'status': je.status, 'is_reversal': je.is_reversal,
            # reversed_entry links both ways: a reversal -> the voucher it reverses, and a
            # reversed voucher -> its reversal.
            'reverses': linked if je.is_reversal else '',
            'reversed_by': '' if je.is_reversal else linked,
            'reference': reference or '', 'party': party or '', 'narration': je.narration or '',
            'debit_accounts': list(dict.fromkeys(l.account.name for l in lines if l.debit)),
            'credit_accounts': list(dict.fromkeys(l.account.name for l in lines if l.credit)),
            'lines': out_lines, 'amount': str(money(je.total_amount or 0)),
            'branch': je.branch.name if je.branch_id else '',
            'created_by': je.created_by.username if je.created_by_id else '',
        }
        row['_text'] = ' '.join([row['voucher_no'], row['reference'], row['party'], row['narration'],
                                 row['origin_label'], row['voucher_type_name'],
                                 *(f"{l['code']} {l['name']} {l['memo']}" for l in out_lines)]).lower()
        rows.append(row)

    s = (search or '').strip()
    if s:
        rows = [r for r in rows if s.lower() in r['_text']]

    on_ledger = [r for r in rows if r['status'] in JournalEntry.LEDGER_STATUSES]
    by_type, by_origin = OrderedDict(), OrderedDict()
    for r in on_ledger:
        t = by_type.setdefault(r['voucher_type'] or '—', {'code': r['voucher_type'], 'label': r['voucher_type_name'],
                                                          'count': 0, 'amount': ZERO})
        t['count'] += 1
        t['amount'] += Decimal(r['amount'])
        o = by_origin.setdefault(r['origin_label'], {'label': r['origin_label'], 'count': 0, 'amount': ZERO})
        o['count'] += 1
        o['amount'] += Decimal(r['amount'])
    total_dr = sum((Decimal(l['debit']) for r in on_ledger for l in r['lines']), ZERO)
    total_cr = sum((Decimal(l['credit']) for r in on_ledger for l in r['lines']), ZERO)
    statuses = defaultdict(int)
    for r in rows:
        statuses[r['status']] += 1
    fmt = lambda d: {**d, 'amount': str(money(d['amount']))}  # noqa: E731
    origins = [{'key': 'manual', 'label': 'Manual vouchers'}, {'key': 'auto', 'label': 'Automated postings'}]
    origins += [{'key': k, 'label': v[0]} for k, v in SOURCES.items()]
    return {
        'date_from': date_from.isoformat(), 'date_to': date_to.isoformat(), 'search': s,
        'summary': {
            'entries': len(rows), 'on_ledger': len(on_ledger),
            'reversals': sum(1 for r in rows if r['is_reversal']),
            'manual': sum(1 for r in on_ledger if r['origin'] == 'manual'),
            'automated': sum(1 for r in on_ledger if r['origin'] == 'auto'),
            'total_debit': str(money(total_dr)), 'total_credit': str(money(total_cr)),
            'balanced': total_dr == total_cr,
            'status_counts': dict(statuses),
            'by_type': sorted((fmt(t) for t in by_type.values()), key=lambda t: -t['count']),
            'by_origin': sorted((fmt(o) for o in by_origin.values()), key=lambda o: -o['count']),
        },
        'voucher_type_options': list(JournalEntry.objects.exclude(voucher_type__isnull=True)
                                     .values_list('voucher_type__code', 'voucher_type__name').distinct()
                                     .order_by('voucher_type__code')),
        'origin_options': origins,
        **_paginate(rows, page, page_size, export),
    }


def account_activity(date_from, date_to, branch_ids=None, search='', account_type='', include_zero=False,
                     page=1, page_size=200, export=False):
    """One row per ledger account: opening balance (before date_from), period debit / credit
    and closing balance, all in the account's normal sign. Accounts with no balance and no
    movement are left out unless include_zero."""
    _check_range(date_from, date_to)
    base = LedgerEntry.objects.filter(journal_entry__status__in=JournalEntry.LEDGER_STATUSES,
                                      journal_entry__is_deleted=False)
    if branch_ids is not None:
        base = base.filter(journal_entry__branch_id__in=branch_ids)
    before = {r['account']: (r['dr'] or ZERO, r['cr'] or ZERO) for r in
              base.filter(journal_entry__date__lt=date_from).values('account')
              .annotate(dr=Sum('debit'), cr=Sum('credit'))}
    during = {r['account']: (r['dr'] or ZERO, r['cr'] or ZERO, r['n'], r['last']) for r in
              base.filter(journal_entry__date__gte=date_from, journal_entry__date__lte=date_to).values('account')
              .annotate(dr=Sum('debit'), cr=Sum('credit'), n=Count('id'), last=Max('journal_entry__date'))}

    accounts = ChartOfAccount.all_objects.select_related('account_group').order_by('code')
    if account_type:
        accounts = accounts.filter(account_group__account_type=account_type)
    rows = []
    for acc in accounts:
        if acc.pk not in before and acc.pk not in during and not (include_zero and not acc.is_deleted):
            continue
        sign = 1 if acc.account_type in DEBIT_NORMAL_TYPES else -1
        bdr, bcr = before.get(acc.pk, (ZERO, ZERO))
        dr, cr, n, last = during.get(acc.pk, (ZERO, ZERO, 0, None))
        opening = (bdr - bcr) * sign
        closing = opening + (dr - cr) * sign
        if not (opening or dr or cr or closing or include_zero):
            continue
        row = {'account_id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'type': acc.account_type,
               'group': acc.account_group.name, 'normal': 'Dr' if sign == 1 else 'Cr',
               'opening': str(money(opening)), 'debit': str(money(dr)), 'credit': str(money(cr)),
               'closing': str(money(closing)), 'lines': n or 0, 'last_date': last.isoformat() if last else None}
        row['_text'] = f"{acc.code} {acc.name} {acc.account_group.name} {acc.account_type}".lower()
        rows.append(row)
    s = (search or '').strip()
    if s:
        rows = [r for r in rows if s.lower() in r['_text']]
    by_type = OrderedDict((t, {'type': t, 'debit': ZERO, 'credit': ZERO, 'accounts': 0})
                          for t in ('Asset', 'Liability', 'Equity', 'Income', 'Expense'))
    for r in rows:
        t = by_type.setdefault(r['type'], {'type': r['type'], 'debit': ZERO, 'credit': ZERO, 'accounts': 0})
        t['debit'] += Decimal(r['debit'])
        t['credit'] += Decimal(r['credit'])
        t['accounts'] += 1
    total_dr = sum((Decimal(r['debit']) for r in rows), ZERO)
    total_cr = sum((Decimal(r['credit']) for r in rows), ZERO)
    return {
        'date_from': date_from.isoformat(), 'date_to': date_to.isoformat(), 'search': s,
        'account_type': account_type,
        'summary': {'accounts': len(rows), 'active': sum(1 for r in rows if r['lines']),
                    'total_debit': str(money(total_dr)), 'total_credit': str(money(total_cr)),
                    'by_type': [{**t, 'debit': str(money(t['debit'])), 'credit': str(money(t['credit']))}
                                for t in by_type.values() if t['accounts']]},
        **_paginate(rows, page, page_size, export),
    }
