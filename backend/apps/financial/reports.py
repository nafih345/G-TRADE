"""Financial statements, computed from posted ledger lines only.

One cut-off policy for every report: a line counts when its journal is POSTED or REVERSED
(the reversal is its own POSTED entry, so the pair nets to zero) and its journal date falls
in the requested range. Drafts / pending vouchers never count. ChartOfAccount.current_balance
is a display cache and is never read here.
"""
import datetime
from decimal import Decimal

from django.db.models import Count, Sum, Q

from .models import ChartOfAccount, JournalEntry, LedgerEntry, DEBIT_NORMAL_TYPES
from .services import money

TYPE_ORDER = ['Asset', 'Liability', 'Equity', 'Income', 'Expense']


def parse_date(value, default=None):
    if not value:
        return default
    if isinstance(value, datetime.date):
        return value
    return datetime.date.fromisoformat(str(value)[:10])


def posted_lines(date_from=None, date_to=None, branch=None):
    qs = LedgerEntry.objects.filter(journal_entry__status__in=JournalEntry.LEDGER_STATUSES,
                                    journal_entry__is_deleted=False)
    if date_from:
        qs = qs.filter(journal_entry__date__gte=date_from)
    if date_to:
        qs = qs.filter(journal_entry__date__lte=date_to)
    if branch:
        qs = qs.filter(journal_entry__branch_id=branch)
    return qs


def _totals(date_from=None, date_to=None, branch=None):
    return {
        row['account']: (row['dr'] or Decimal('0'), row['cr'] or Decimal('0'))
        for row in posted_lines(date_from, date_to, branch).values('account').annotate(dr=Sum('debit'), cr=Sum('credit'))
    }


def _signed(acc_type, dr, cr):
    """Balance in the account's normal direction (positive = normal)."""
    return (dr - cr) if acc_type in DEBIT_NORMAL_TYPES else (cr - dr)


def _accounts():
    return list(ChartOfAccount.all_objects.select_related('account_group', 'parent_account').order_by('code'))


def account_balances(as_of=None, branch=None, include_zero=True):
    """COA rows with ledger totals up to as_of — the Chart of Accounts screen's balances."""
    totals = _totals(date_to=as_of, branch=branch)
    rows = []
    for acc in _accounts():
        dr, cr = totals.get(acc.pk, (Decimal('0'), Decimal('0')))
        if acc.is_deleted and dr == 0 and cr == 0:
            continue
        if not include_zero and dr == 0 and cr == 0:
            continue
        rows.append({
            'id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'account_type': acc.account_type,
            'account_group': acc.account_group.name if acc.account_group_id else '',
            'account_subtype': acc.account_subtype, 'status': acc.status, 'is_system': acc.is_system,
            'parent_account': str(acc.parent_account_id) if acc.parent_account_id else None,
            'normal_balance': acc.normal_balance,
            'total_debit': str(money(dr)), 'total_credit': str(money(cr)),
            'balance': str(money(_signed(acc.account_type, dr, cr))),
        })
    return rows


def trial_balance(as_of=None, branch=None):
    totals = _totals(date_to=as_of, branch=branch)
    rows, sum_dr, sum_cr = [], Decimal('0'), Decimal('0')
    for acc in _accounts():
        dr, cr = totals.get(acc.pk, (Decimal('0'), Decimal('0')))
        net = dr - cr
        if net == 0 and dr == 0:
            continue
        closing_dr, closing_cr = (net, Decimal('0')) if net > 0 else (Decimal('0'), -net)
        sum_dr += closing_dr
        sum_cr += closing_cr
        rows.append({'id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'account_type': acc.account_type,
                     'account_group': acc.account_group.name if acc.account_group_id else '',
                     'total_debit': str(money(dr)), 'total_credit': str(money(cr)),
                     'debit': str(money(closing_dr)), 'credit': str(money(closing_cr))})
    rows.sort(key=lambda r: (TYPE_ORDER.index(r['account_type']) if r['account_type'] in TYPE_ORDER else 9, r['code']))
    return {'as_of': as_of.isoformat() if as_of else None, 'rows': rows,
            'total_debit': str(money(sum_dr)), 'total_credit': str(money(sum_cr)),
            'balanced': money(sum_dr) == money(sum_cr), 'difference': str(money(sum_dr - sum_cr))}


def _section(acc_type, totals):
    groups, total = {}, Decimal('0')
    for acc in _accounts():
        if acc.account_type != acc_type:
            continue
        dr, cr = totals.get(acc.pk, (Decimal('0'), Decimal('0')))
        amount = _signed(acc_type, dr, cr)
        if amount == 0:
            continue
        g = acc.account_group.name if acc.account_group_id else 'Ungrouped'
        groups.setdefault(g, {'group': g, 'accounts': [], 'total': Decimal('0')})
        groups[g]['accounts'].append({'id': str(acc.pk), 'code': acc.code, 'name': acc.name, 'amount': str(money(amount))})
        groups[g]['total'] += amount
        total += amount
    out = sorted(groups.values(), key=lambda g: g['group'])
    for g in out:
        g['total'] = str(money(g['total']))
    return out, money(total)


def profit_and_loss(date_from=None, date_to=None, branch=None):
    totals = _totals(date_from, date_to, branch)
    income, total_income = _section('Income', totals)
    expenses, total_expense = _section('Expense', totals)
    return {'date_from': date_from.isoformat() if date_from else None, 'date_to': date_to.isoformat() if date_to else None,
            'income': income, 'expenses': expenses, 'total_income': str(total_income),
            'total_expense': str(total_expense), 'net_profit': str(money(total_income - total_expense))}


def balance_sheet(as_of=None, branch=None):
    totals = _totals(date_to=as_of, branch=branch)
    assets, total_assets = _section('Asset', totals)
    liabilities, total_liabilities = _section('Liability', totals)
    equity, total_equity = _section('Equity', totals)
    _, income = _section('Income', totals)
    _, expense = _section('Expense', totals)
    # No year-end closing entries are posted, so accumulated profit is shown as its own
    # equity line — that is what makes Assets = Liabilities + Equity hold from the ledger.
    earnings = money(income - expense)
    total_equity_incl = money(total_equity + earnings)
    return {'as_of': as_of.isoformat() if as_of else None,
            'assets': assets, 'liabilities': liabilities, 'equity': equity,
            'retained_earnings': str(earnings),
            'total_assets': str(total_assets), 'total_liabilities': str(total_liabilities),
            'total_equity': str(total_equity_incl),
            'total_liabilities_and_equity': str(money(total_liabilities + total_equity_incl)),
            'balanced': total_assets == money(total_liabilities + total_equity_incl),
            'difference': str(money(total_assets - total_liabilities - total_equity_incl))}


def general_ledger(account, date_from=None, date_to=None, branch=None, limit=2000):
    acc_type = account.account_type
    opening = Decimal('0')
    if date_from:
        agg = posted_lines(date_to=date_from - datetime.timedelta(days=1), branch=branch) \
            .filter(account=account).aggregate(dr=Sum('debit'), cr=Sum('credit'))
        opening = _signed(acc_type, agg['dr'] or Decimal('0'), agg['cr'] or Decimal('0'))
    lines = (posted_lines(date_from, date_to, branch).filter(account=account)
             .select_related('journal_entry', 'journal_entry__voucher_type')
             .order_by('journal_entry__date', 'journal_entry__created_at', 'id'))
    running, out, sum_dr, sum_cr = opening, [], Decimal('0'), Decimal('0')
    for l in lines[:limit]:
        je = l.journal_entry
        running += _signed(acc_type, l.debit, l.credit)
        sum_dr += l.debit
        sum_cr += l.credit
        out.append({'id': str(l.pk), 'date': je.date.isoformat(), 'entry_id': str(je.pk), 'entry_number': je.entry_number,
                    'voucher_type': je.voucher_type.code if je.voucher_type_id else '', 'narration': je.narration or '',
                    'memo': l.memo, 'status': je.status, 'is_reversal': je.is_reversal,
                    'source_module': je.source_module, 'source_event': je.source_event,
                    'source_number': je.source_number, 'reference_id': str(je.reference_id) if je.reference_id else None,
                    'debit': str(l.debit), 'credit': str(l.credit), 'balance': str(money(running))})
    return {'account': {'id': str(account.pk), 'code': account.code, 'name': account.name,
                        'account_type': acc_type, 'normal_balance': account.normal_balance},
            'date_from': date_from.isoformat() if date_from else None, 'date_to': date_to.isoformat() if date_to else None,
            'opening_balance': str(money(opening)), 'total_debit': str(money(sum_dr)), 'total_credit': str(money(sum_cr)),
            'closing_balance': str(money(running)), 'lines': out, 'truncated': lines.count() > limit}


def source_breakdown(date_from=None, date_to=None, branch=None):
    from .accounting_catalog import SOURCES
    qs = JournalEntry.objects.filter(status__in=JournalEntry.LEDGER_STATUSES)
    if date_from:
        qs = qs.filter(date__gte=date_from)
    if date_to:
        qs = qs.filter(date__lte=date_to)
    if branch:
        qs = qs.filter(branch_id=branch)
    rows = []
    for r in qs.values('source_module', 'source_event').annotate(
            entries=Count('id'), posted=Sum('total_amount', filter=Q(is_reversal=False)),
            reversed=Sum('total_amount', filter=Q(is_reversal=True))).order_by('source_module', 'source_event'):
        key = f"{r['source_module']}.{r['source_event']}" if r['source_module'] else 'manual'
        posted, rev = money(r['posted'] or 0), money(r['reversed'] or 0)
        rows.append({'source_key': key, 'label': SOURCES.get(key, (key.replace('.', ' ').title(),))[0] if r['source_module'] else 'Manual / legacy entries',
                     'entries': r['entries'], 'posted_amount': str(posted), 'reversed_amount': str(rev),
                     'net_amount': str(money(posted - rev))})
    return rows
