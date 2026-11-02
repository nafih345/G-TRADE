"""Profit & Loss statement (Accounts → Profit & Loss), grouped the standard way:

    Direct Income  − Direct Expenses   = Gross Profit
    Gross Profit   + Indirect Income − Indirect Expenses = Net Profit / (Loss)

Figures come from posted ledger lines only, with the same cut-off as reports.py (journal date,
POSTED + REVERSED entries, so a reversal pair nets to zero). Each Income / Expense account is
placed in a bucket by `pl_bucket` — its account group name first ("Indirect Expenses",
"Direct Incomes", ...), then its subtype — so moving an account to another group in the Chart
of Accounts is how a user re-classifies it. Contra revenue (sales returns) sits in Direct
Income with a negative amount, which is what nets it off sales.
"""
import datetime
from decimal import Decimal

from django.db.models import Sum

from .models import ChartOfAccount, JournalEntry, LedgerEntry, DEBIT_NORMAL_TYPES
from .services import money

DIRECT_INCOME, INDIRECT_INCOME = 'DIRECT_INCOME', 'INDIRECT_INCOME'
DIRECT_EXPENSE, INDIRECT_EXPENSE = 'DIRECT_EXPENSE', 'INDIRECT_EXPENSE'
BUCKETS = {
    DIRECT_INCOME: 'Direct Income',
    DIRECT_EXPENSE: 'Direct Expenses',
    INDIRECT_INCOME: 'Indirect Income',
    INDIRECT_EXPENSE: 'Indirect Expenses',
}
BREAKDOWNS = ('day', 'month', 'quarter')
MAX_PERIODS = 400  # a day-wise breakdown over more than ~13 months is not a readable table
ZERO = Decimal('0')


def pl_bucket(account_type, subtype, group_name):
    """Direct / indirect bucket for an Income or Expense account (None for balance-sheet types)."""
    group = (group_name or '').lower()
    if account_type == 'Income':
        if 'indirect' in group or 'other income' in group or subtype == 'OTHER_INCOME':
            return INDIRECT_INCOME
        if subtype in ('REVENUE', 'CONTRA_REVENUE') or any(w in group for w in ('direct', 'sales', 'revenue', 'service')):
            return DIRECT_INCOME
        return INDIRECT_INCOME
    if account_type == 'Expense':
        if 'indirect' in group:
            return INDIRECT_EXPENSE
        if subtype == 'COGS' or any(w in group for w in ('direct', 'purchase', 'cost of')):
            return DIRECT_EXPENSE
        return INDIRECT_EXPENSE
    return None


def _lines(date_from, date_to, branch_ids):
    qs = LedgerEntry.objects.filter(journal_entry__status__in=JournalEntry.LEDGER_STATUSES,
                                    journal_entry__is_deleted=False,
                                    account__account_group__account_type__in=('Income', 'Expense'))
    if date_from:
        qs = qs.filter(journal_entry__date__gte=date_from)
    if date_to:
        qs = qs.filter(journal_entry__date__lte=date_to)
    if branch_ids is not None:
        qs = qs.filter(journal_entry__branch_id__in=branch_ids)
    return qs


def _totals(date_from, date_to, branch_ids):
    return {r['account']: (r['dr'] or ZERO, r['cr'] or ZERO)
            for r in _lines(date_from, date_to, branch_ids).values('account').annotate(dr=Sum('debit'), cr=Sum('credit'))}


def _signed(acc_type, dr, cr):
    return (dr - cr) if acc_type in DEBIT_NORMAL_TYPES else (cr - dr)


def _pl_accounts():
    return list(ChartOfAccount.all_objects.filter(account_group__account_type__in=('Income', 'Expense'))
                .select_related('account_group').order_by('code'))


def _pct(part, whole):
    return str(money(part * 100 / whole)) if whole else None


def _summary(t):
    gross = t[DIRECT_INCOME] - t[DIRECT_EXPENSE]
    net = gross + t[INDIRECT_INCOME] - t[INDIRECT_EXPENSE]
    revenue = t[DIRECT_INCOME]
    return {
        'direct_income': str(money(t[DIRECT_INCOME])), 'direct_expenses': str(money(t[DIRECT_EXPENSE])),
        'indirect_income': str(money(t[INDIRECT_INCOME])), 'indirect_expenses': str(money(t[INDIRECT_EXPENSE])),
        'total_income': str(money(t[DIRECT_INCOME] + t[INDIRECT_INCOME])),
        'total_expenses': str(money(t[DIRECT_EXPENSE] + t[INDIRECT_EXPENSE])),
        'gross_profit': str(money(gross)), 'net_profit': str(money(net)),
        'gross_margin_pct': _pct(gross, revenue), 'net_margin_pct': _pct(net, revenue),
    }


def _bucket_totals(accounts, totals):
    t = dict.fromkeys(BUCKETS, ZERO)
    for acc, bucket in accounts:
        dr, cr = totals.get(acc.pk, (ZERO, ZERO))
        t[bucket] += _signed(acc.account_type, dr, cr)
    return t


def previous_range(date_from, date_to):
    """The same-length range immediately before [date_from, date_to]. Whole calendar months
    compare with the same number of whole months before them."""
    if not (date_from and date_to):
        return None, None
    if date_from.day == 1 and (date_to + datetime.timedelta(days=1)).day == 1:
        months = (date_to.year - date_from.year) * 12 + date_to.month - date_from.month + 1
        idx = date_from.year * 12 + date_from.month - 1 - months
        prev_from = datetime.date(idx // 12, idx % 12 + 1, 1)
        return prev_from, date_from - datetime.timedelta(days=1)
    span = (date_to - date_from).days + 1
    return date_from - datetime.timedelta(days=span), date_from - datetime.timedelta(days=1)


def _period_key(d, breakdown, fy_month=1):
    if breakdown == 'day':
        return d
    if breakdown == 'month':
        return datetime.date(d.year, d.month, 1)
    # Quarters run from the fiscal-year start month (April by default: Q1 = Apr–Jun).
    start_month = (fy_month - 1 + (d.month - fy_month) % 12 // 3 * 3) % 12 + 1
    return datetime.date(d.year if start_month <= d.month else d.year - 1, start_month, 1)


def _period_end(start, breakdown):
    if breakdown == 'day':
        return start
    months = 1 if breakdown == 'month' else 3
    idx = start.year * 12 + start.month - 1 + months
    return datetime.date(idx // 12, idx % 12 + 1, 1) - datetime.timedelta(days=1)


def _period_label(start, breakdown, fy_month=1):
    if breakdown == 'day':
        return start.strftime('%d %b %Y')
    if breakdown == 'month':
        return start.strftime('%b %Y')
    q = (start.month - fy_month) % 12 // 3 + 1
    if fy_month == 1:
        return f"Q{q} {start.year}"
    fy = start.year if start.month >= fy_month else start.year - 1
    return f"Q{q} FY {fy}-{str(fy + 1)[-2:]}"


def fiscal_year_start_month():
    try:
        from apps.company.localization import get_preference
        return int(get_preference('fiscal_year_start_month') or 1)
    except Exception:  # preferences unavailable (e.g. tables not migrated) -> calendar quarters
        return 1


def _periods(accounts, date_from, date_to, branch_ids, breakdown):
    fy_month = fiscal_year_start_month() if breakdown == 'quarter' else 1
    bucket_of = {acc.pk: (acc.account_type, bucket) for acc, bucket in accounts}
    per = {}
    rows = (_lines(date_from, date_to, branch_ids)
            .values('account', 'journal_entry__date').annotate(dr=Sum('debit'), cr=Sum('credit')))
    for r in rows:
        info = bucket_of.get(r['account'])
        if not info:
            continue
        key = _period_key(r['journal_entry__date'], breakdown, fy_month)
        t = per.setdefault(key, dict.fromkeys(BUCKETS, ZERO))
        t[info[1]] += _signed(info[0], r['dr'] or ZERO, r['cr'] or ZERO)

    # Every period in the range is listed, including quiet ones, so gaps are visible.
    start = _period_key(date_from or min(per, default=date_to or datetime.date.today()), breakdown, fy_month)
    end = date_to or max(per, default=start)
    out, cursor = [], start
    while cursor <= end:
        if len(out) >= MAX_PERIODS:
            raise ValueError(f'Too many periods for a {breakdown}-wise breakdown; choose a shorter range or a coarser breakdown.')
        p_end = _period_end(cursor, breakdown)
        out.append({'key': cursor.isoformat(), 'label': _period_label(cursor, breakdown, fy_month),
                    'date_from': max(cursor, date_from).isoformat() if date_from else cursor.isoformat(),
                    'date_to': min(p_end, date_to).isoformat() if date_to else p_end.isoformat(),
                    **_summary(per.get(cursor, dict.fromkeys(BUCKETS, ZERO)))})
        cursor = p_end + datetime.timedelta(days=1)
    return out


def profit_and_loss_statement(date_from=None, date_to=None, branch_ids=None, compare=False, breakdown=None):
    """Grouped P&L for the range. `branch_ids` None = every branch. `compare` adds the previous
    same-length period per account and in the summary; `breakdown` (day|month|quarter) adds a
    per-period profit table."""
    if date_from and date_to and date_from > date_to:
        raise ValueError('The From date is after the To date.')
    if breakdown and breakdown not in BREAKDOWNS:
        raise ValueError(f"breakdown must be one of {', '.join(BREAKDOWNS)}.")

    accounts = []
    for acc in _pl_accounts():
        bucket = pl_bucket(acc.account_type, acc.account_subtype,
                           acc.account_group.name if acc.account_group_id else '')
        accounts.append((acc, bucket))

    totals = _totals(date_from, date_to, branch_ids)
    prev_from, prev_to = previous_range(date_from, date_to) if compare else (None, None)
    prev_totals = _totals(prev_from, prev_to, branch_ids) if prev_from else None

    sections = {b: {'key': b, 'label': label, 'groups': {}, 'total': ZERO, 'previous_total': ZERO}
                for b, label in BUCKETS.items()}
    for acc, bucket in accounts:
        dr, cr = totals.get(acc.pk, (ZERO, ZERO))
        amount = _signed(acc.account_type, dr, cr)
        prev = None
        if prev_totals is not None:
            pdr, pcr = prev_totals.get(acc.pk, (ZERO, ZERO))
            prev = _signed(acc.account_type, pdr, pcr)
        if amount == 0 and dr == 0 and cr == 0 and not prev:
            continue
        sec = sections[bucket]
        gname = acc.account_group.name if acc.account_group_id else 'Ungrouped'
        group = sec['groups'].setdefault(gname, {'group': gname, 'accounts': [], 'total': ZERO, 'previous_total': ZERO})
        group['accounts'].append({'id': str(acc.pk), 'code': acc.code, 'name': acc.name,
                                  'subtype': acc.account_subtype, 'amount': str(money(amount)),
                                  'previous_amount': str(money(prev)) if prev is not None else None})
        group['total'] += amount
        sec['total'] += amount
        if prev is not None:
            group['previous_total'] += prev
            sec['previous_total'] += prev

    out_sections = []
    for b in BUCKETS:
        sec = sections[b]
        groups = sorted(sec['groups'].values(), key=lambda g: g['group'])
        for g in groups:
            g['total'] = str(money(g['total']))
            g['previous_total'] = str(money(g['previous_total'])) if prev_totals is not None else None
        out_sections.append({'key': b, 'label': sec['label'], 'groups': groups, 'total': str(money(sec['total'])),
                             'previous_total': str(money(sec['previous_total'])) if prev_totals is not None else None})

    result = {
        'date_from': date_from.isoformat() if date_from else None,
        'date_to': date_to.isoformat() if date_to else None,
        'sections': out_sections,
        'summary': _summary({b: sections[b]['total'] for b in BUCKETS}),
        'previous': None,
        'periods': None,
        'breakdown': breakdown or None,
        'fiscal_year_start_month': fiscal_year_start_month(),
    }
    if prev_totals is not None:
        result['previous'] = {'date_from': prev_from.isoformat(), 'date_to': prev_to.isoformat(),
                              **_summary(_bucket_totals(accounts, prev_totals))}
    if breakdown:
        result['periods'] = _periods(accounts, date_from, date_to, branch_ids, breakdown)
    return result
