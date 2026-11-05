"""Financial → Statements: every book and final account behind one endpoint, in one shape.

GET /api/financial/statements/?type=<type>&from_date=&to_date=&account_id=&...

Nothing here is a second set of books. Each statement reads the same posted ledger lines the
dedicated screens read (reports.py cut-off: POSTED + REVERSED journals by journal date), and the
books with their own rules — Day Book, Cashbook, Bank Book, Cheque Register, Profit & Loss — are
called as they are, then re-shaped. That keeps a statement figure identical to the figure on the
screen it summarises.

Every statement comes back as:

    {type, title, subtitle, entity, date_from, date_to, as_of, layout,
     summary: [{label, value, format}], notes: [...], balanced, difference, truncated,
     tables: [{key, title, columns: [{key, label, format}], rows: [...], footer: [...]}]}

A row is {cells: {column key: value}, style, level, ref}. `style` is '' (a plain line),
'section' / 'group' (headings), 'parent' (an account with sub-accounts, its own figures
including theirs), 'opening' / 'closing', 'subtotal', 'result' (gross / net profit) or 'info'
(shown, never totalled). `ref` is the journal a line came from (what "Show Bill" opens).
Money is a decimal string; a 'drcr' column holds a signed net-debit figure (positive = Dr).
"""
import datetime
from collections import OrderedDict, defaultdict
from decimal import Decimal
from io import BytesIO

from django.db.models import Count, Q, Sum

from . import bankbook, cashbook, cheques, daybook, pl_statement
from .accounting_catalog import SOURCES
from .models import AccountGroup, ChartOfAccount, JournalEntry, LedgerEntry, PostingFailure
from .reports import TYPE_ORDER, posted_lines
from .services import money

ZERO = Decimal('0')
MAX_ROWS = 20000
ONE_DAY = datetime.timedelta(days=1)


class StatementError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Catalog
# ---------------------------------------------------------------------------

STATEMENTS = OrderedDict([
    ('chart_of_accounts', ('Master Accounts', 'Chart of Accounts Statement')),
    ('vouchers', ('Vouchers', 'Voucher Statement')),
    ('day_book', ('Cash & Bank Books', 'Day Book')),
    ('cash_book', ('Cash & Bank Books', 'Cash Book')),
    ('bank_book', ('Cash & Bank Books', 'Bank Book')),
    ('cheque_register', ('Cash & Bank Books', 'Cheque Register')),
    ('ledger', ('Ledgers', 'Ledger Statement')),
    ('trial_balance', ('Final Accounts', 'Trial Balance')),
    ('profit_loss', ('Final Accounts', 'Profit & Loss Statement')),
    ('balance_sheet', ('Final Accounts', 'Balance Sheet')),
    ('accounting_integration', ('Integrations & Audit', 'Accounting Integration Audit')),
])

# Chart of Accounts scopes: the five account types, and the classes inside them.
SCOPES = OrderedDict([
    ('ALL', ('Full account hierarchy', None)),
    ('ASSETS', ('All Assets', None)),
    ('CURRENT_ASSETS', ('Current Assets (Cash, Bank, Debtors, Stock)', 'ASSETS')),
    ('FIXED_ASSETS', ('Fixed Assets (Furniture, Equipment, Machinery)', 'ASSETS')),
    ('LIABILITIES', ('All Liabilities', None)),
    ('CURRENT_LIABILITIES', ('Current Liabilities', 'LIABILITIES')),
    ('LONG_TERM_LIABILITIES', ('Long-term Liabilities', 'LIABILITIES')),
    ('EQUITY', ('Equity & Retained Earnings', None)),
    ('INCOME', ('All Income', None)),
    ('DIRECT_INCOME', ('Direct Income', 'INCOME')),
    ('INDIRECT_INCOME', ('Indirect Income', 'INCOME')),
    ('EXPENSES', ('All Expenses', None)),
    ('DIRECT_EXPENSE', ('Direct Expenses', 'EXPENSES')),
    ('INDIRECT_EXPENSE', ('Indirect Expenses', 'EXPENSES')),
])
TYPE_SCOPE = {'Asset': 'ASSETS', 'Liability': 'LIABILITIES', 'Equity': 'EQUITY', 'Income': 'INCOME',
              'Expense': 'EXPENSES'}
TYPE_TITLES = {'Asset': 'Assets', 'Liability': 'Liabilities', 'Equity': 'Equity', 'Income': 'Income',
               'Expense': 'Expenses'}

VOUCHER_TYPES = OrderedDict([
    ('ALL', 'All Vouchers'), ('RV', 'Receipt Vouchers'), ('PV', 'Payment Vouchers'),
    ('CV', 'Contra Entries'), ('JV', 'Journal Vouchers'),
])
MANUAL = Q(source_module='') | Q(source_module='financial')


def account_class(acc):
    """The fine scope an account falls in (CURRENT_ASSETS, FIXED_ASSETS, DIRECT_INCOME, ...).
    Classified by subtype and account-group name, the same way the P&L buckets accounts — so
    moving an account to another group in the Chart of Accounts re-classifies it."""
    acc_type = acc.account_type
    group = (acc.account_group.name if acc.account_group_id else '').lower()
    if acc_type == 'Asset':
        return 'FIXED_ASSETS' if acc.account_subtype == 'FIXED_ASSET' or 'fixed' in group else 'CURRENT_ASSETS'
    if acc_type == 'Liability':
        long_term = 'long' in group or ('loan' in group and 'short' not in group) or 'non-current' in group
        return 'LONG_TERM_LIABILITIES' if long_term else 'CURRENT_LIABILITIES'
    if acc_type == 'Equity':
        return 'EQUITY'
    if acc_type in ('Income', 'Expense'):
        return pl_statement.pl_bucket(acc_type, acc.account_subtype, group)
    return None


def _in_scope(acc, scope):
    if scope == 'ALL':
        return True
    return TYPE_SCOPE.get(acc.account_type) == scope or account_class(acc) == scope


def options():
    """What the Statements screen offers in its selectors."""
    accounts = list(ChartOfAccount.objects.select_related('account_group').order_by('code'))
    return {
        'statements': [{'value': k, 'group': g, 'label': t} for k, (g, t) in STATEMENTS.items()],
        'scopes': [{'value': k, 'label': label, 'parent': parent} for k, (label, parent) in SCOPES.items()],
        'groups': [{'id': str(g.pk), 'name': g.name, 'account_type': g.account_type}
                   for g in AccountGroup.objects.order_by('account_type', 'name')],
        'accounts': [{'id': str(a.pk), 'code': a.code, 'name': a.name, 'account_type': a.account_type,
                      'group': a.account_group.name if a.account_group_id else '',
                      'parent': str(a.parent_account_id) if a.parent_account_id else None,
                      'scope': account_class(a), 'status': a.status} for a in accounts],
        'cash_accounts': cashbook.cash_accounts(),
        'bank_accounts': bankbook.bank_accounts(),
        'voucher_types': [{'value': k, 'label': v} for k, v in VOUCHER_TYPES.items()],
        'cheque_statuses': [{'value': s, 'label': l} for s, l in cheques.Cheque.STATUS_CHOICES],
        'sources': [{'value': k, 'label': v[0]} for k, v in SOURCES.items()],
    }


# ---------------------------------------------------------------------------
# Shape helpers
# ---------------------------------------------------------------------------

def col(key, label, fmt='text'):
    return {'key': key, 'label': label, 'format': fmt}


def row(cells, style='', level=0, ref=None):
    return {'cells': cells, 'style': style, 'level': level, 'ref': ref}


def table(key, title, columns, rows, footer=None):
    return {'key': key, 'title': title, 'columns': columns, 'rows': rows, 'footer': footer or []}


def m(value):
    """Decimal -> money string; None / zero-length stays None (a blank cell)."""
    if value is None or value == '':
        return None
    return str(money(Decimal(str(value))))


def nz(value):
    """Money string, blank when zero (debit / credit columns)."""
    return m(value) if value else None


REF_KEYS = ('entry_id', 'entry_number', 'date', 'source_module', 'source_event', 'source_number',
            'reference_id', 'is_reversal')


def ref_of(je):
    return {'entry_id': str(je.pk), 'entry_number': je.entry_number, 'date': je.date.isoformat(),
            'source_module': je.source_module, 'source_event': je.source_event, 'source_number': je.source_number,
            'reference_id': str(je.reference_id) if je.reference_id else None, 'is_reversal': je.is_reversal}


def ref_from(d):
    return {k: d.get(k) for k in REF_KEYS} if d.get('entry_id') else None


def _scoped(qs, branch_ids):
    return qs.filter(journal_entry__branch_id__in=branch_ids) if branch_ids is not None else qs


def _sums(branch_ids, date_from=None, date_to=None):
    """{account id: (debit, credit)} over posted lines in the range."""
    return {r['account']: (r['dr'] or ZERO, r['cr'] or ZERO)
            for r in _scoped(posted_lines(date_from, date_to), branch_ids)
            .values('account').annotate(dr=Sum('debit'), cr=Sum('credit'))}


def _accounts(include_deleted=False):
    qs = ChartOfAccount.all_objects if include_deleted else ChartOfAccount.objects
    return list(qs.select_related('account_group', 'parent_account').order_by('code'))


def _descendants(root_id, accounts):
    children = defaultdict(list)
    for a in accounts:
        if a.parent_account_id:
            children[a.parent_account_id].append(a.pk)
    out, stack = set(), [root_id]
    while stack:
        pk = stack.pop()
        if pk in out:
            continue
        out.add(pk)
        stack.extend(children.get(pk, ()))
    return out


def _account_label(acc):
    return f"{acc.code} - {acc.name}"


def _uuid_param(params, name):
    import uuid
    value = (params.get(name) or '').strip()
    if not value or value == 'all':
        return None
    try:
        return uuid.UUID(value)
    except ValueError:
        raise StatementError(f'{name} must be a valid id.')


def _flag(params, name, default=False):
    v = params.get(name)
    if v is None or v == '':
        return default
    return str(v).lower() in ('1', 'true', 'yes')


def _period(date_from, date_to):
    if date_from and date_to and date_from > date_to:
        raise StatementError('From date must be on or before To date.')


def _require_range(date_from, date_to, what, max_days=366):
    if not date_from or not date_to:
        raise StatementError(f'Choose a From and To date for the {what}.')
    if (date_to - date_from).days > max_days:
        raise StatementError(f'The {what} covers at most one year at a time. Narrow the dates.')


# ---------------------------------------------------------------------------
# Chart of Accounts statement
# ---------------------------------------------------------------------------

def _hierarchy_rows(accounts, values, money_cols, label_fn=_account_label, base_level=1):
    """Rows for accounts as a parent → child tree. `values[pk]` is {column: Decimal} for the
    account's own lines; a parent's row carries its sub-accounts' figures as well. Returns
    (rows, totals of the top-level rows)."""
    ids = {a.pk for a in accounts}
    children = defaultdict(list)
    roots = []
    for a in accounts:
        if a.parent_account_id in ids:
            children[a.parent_account_id].append(a)
        else:
            roots.append(a)

    def rolled(a, seen=()):
        own = dict(values.get(a.pk) or {})
        for c in children.get(a.pk, ()):
            if c.pk in seen:
                continue
            for k, v in rolled(c, seen + (a.pk,)).items():
                own[k] = own.get(k, ZERO) + v
        return own

    rows, totals = [], dict.fromkeys(money_cols, ZERO)

    def walk(a, level, seen=()):
        figures = rolled(a)
        kids = children.get(a.pk, ())
        rows.append(row({'code': a.code, 'name': a.name, 'group': a.account_group.name if a.account_group_id else '',
                         **{k: m(figures.get(k, ZERO)) for k in money_cols}},
                        style='parent' if kids else '', level=level, ref=None) | {'account_id': str(a.pk)})
        for c in kids:
            if c.pk not in seen:
                walk(c, level + 1, seen + (a.pk,))

    for a in roots:
        walk(a, base_level)
        for k, v in rolled(a).items():
            if k in totals:
                totals[k] += v
    return rows, totals


def chart_of_accounts(params, date_from, date_to, branch_ids):
    scope = (params.get('scope') or params.get('group') or 'ALL').upper()
    group_id = _uuid_param(params, 'account_group')
    account_id = _uuid_param(params, 'account_id')
    hide_zero = _flag(params, 'hide_zero')
    if scope not in SCOPES:
        raise StatementError(f"scope must be one of {', '.join(SCOPES)}.")
    _period(date_from, date_to)

    all_accounts = _accounts()
    accounts = [a for a in all_accounts if _in_scope(a, scope)]
    entity = SCOPES[scope][0]
    if group_id:
        accounts = [a for a in accounts if a.account_group_id == group_id]
        g = AccountGroup.objects.filter(pk=group_id).first()
        entity = f"Group: {g.name}" if g else entity
    if account_id:
        root = next((a for a in all_accounts if a.pk == account_id), None)
        if root is None:
            raise StatementError('Account not found.')
        keep = _descendants(root.pk, all_accounts)
        accounts = [a for a in all_accounts if a.pk in keep]
        entity = _account_label(root) + (' and sub-accounts' if len(keep) > 1 else '')

    opening = _sums(branch_ids, date_to=date_from - ONE_DAY) if date_from else {}
    period = _sums(branch_ids, date_from, date_to)
    values = {}
    for a in accounts:
        odr, ocr = opening.get(a.pk, (ZERO, ZERO))
        pdr, pcr = period.get(a.pk, (ZERO, ZERO))
        values[a.pk] = {'opening': odr - ocr, 'debit': pdr, 'credit': pcr, 'closing': odr - ocr + pdr - pcr}
    if hide_zero:
        active = {pk for pk, v in values.items() if any(v.values())}
        # keep a parent whose sub-account moved
        for a in accounts:
            if a.pk in active:
                p = a.parent_account_id
                while p and p not in active:
                    active.add(p)
                    p = next((x.parent_account_id for x in accounts if x.pk == p), None)
        accounts = [a for a in accounts if a.pk in active]

    cols = ['opening', 'debit', 'credit', 'closing']
    rows, grand = [], dict.fromkeys(cols, ZERO)
    for acc_type in TYPE_ORDER:
        of_type = [a for a in accounts if a.account_type == acc_type]
        if not of_type:
            continue
        rows.append(row({'name': TYPE_TITLES[acc_type]}, style='section'))
        type_tot = dict.fromkeys(cols, ZERO)
        by_group = OrderedDict()
        for a in sorted(of_type, key=lambda a: ((a.account_group.name if a.account_group_id else 'zz'), a.code)):
            by_group.setdefault(a.account_group.name if a.account_group_id else 'Ungrouped', []).append(a)
        for gname, members in by_group.items():
            body, gtot = _hierarchy_rows(members, values, cols)
            rows.append(row({'name': gname, **{k: m(v) for k, v in gtot.items()}}, style='group'))
            rows.extend(body)
            for k in cols:
                type_tot[k] += gtot[k]
        rows.append(row({'name': f"Total {TYPE_TITLES[acc_type]}", **{k: m(v) for k, v in type_tot.items()}},
                        style='subtotal'))
        for k in cols:
            grand[k] += type_tot[k]

    notes = []
    if scope in ('ALL', 'EQUITY') and not account_id and not group_id:
        # No year-end closing entries are posted: accumulated profit sits in Income / Expense
        # accounts, so it is shown here for reference, never added to the totals.
        pl_open, pl_close = _accumulated_profit(branch_ids, date_from - ONE_DAY if date_from else None), \
            _accumulated_profit(branch_ids, date_to)
        rows.append(row({'name': 'Retained Earnings (unclosed profit, for reference)',
                         'opening': m(-pl_open) if date_from else None, 'closing': m(-pl_close)}, style='info'))
        notes.append('Retained earnings are the accumulated profit still in Income and Expense accounts '
                     '(no closing entries are posted). Shown for reference; not included in the totals.')

    columns = [col('code', 'Code'), col('name', 'Account'), col('opening', 'Opening Balance', 'drcr'),
               col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money'),
               col('closing', 'Closing Balance', 'drcr')]
    footer = [row({'name': 'Grand Total', **{k: m(v) for k, v in grand.items()}}, style='total')]
    full = scope == 'ALL' and not account_id and not group_id
    return {
        'title': 'Chart of Accounts Statement', 'entity': entity,
        'summary': [
            {'label': 'Accounts', 'value': len(accounts), 'format': 'count'},
            {'label': 'Opening', 'value': m(grand['opening']), 'format': 'drcr'},
            {'label': 'Debits in period', 'value': m(grand['debit']), 'format': 'money'},
            {'label': 'Credits in period', 'value': m(grand['credit']), 'format': 'money'},
            {'label': 'Closing', 'value': m(grand['closing']), 'format': 'drcr'},
        ],
        'balanced': (money(grand['debit']) == money(grand['credit']) and money(grand['closing']) == 0) if full else None,
        'difference': m(grand['closing']) if full else None,
        'notes': notes,
        'tables': [table('accounts', None, columns, rows, footer)],
    }


def _accumulated_profit(branch_ids, as_of):
    """Income − Expense from the first entry up to as_of (positive = profit)."""
    qs = _scoped(posted_lines(date_to=as_of), branch_ids).filter(
        account__account_group__account_type__in=('Income', 'Expense'))
    agg = qs.aggregate(dr=Sum('debit'), cr=Sum('credit'))
    return (agg['cr'] or ZERO) - (agg['dr'] or ZERO)


# ---------------------------------------------------------------------------
# Voucher statement (RV / PV / CV / JV / all)
# ---------------------------------------------------------------------------

def _counter_accounts(entry_ids):
    """{journal id: (debit account names, credit account names)} in one query."""
    out = defaultdict(lambda: ([], []))
    for l in (LedgerEntry.objects.filter(journal_entry_id__in=entry_ids).select_related('account')
              .order_by('journal_entry_id', '-debit', 'id')):
        dr, cr = out[l.journal_entry_id]
        target = dr if l.debit else cr
        if l.account.name not in target:
            target.append(l.account.name)
    return out


def _hide_reversal_pairs(entries):
    ids = {je.pk for je in entries}
    hidden = set()
    for je in entries:
        if je.is_reversal and je.reversed_entry_id in ids:
            hidden.update((je.pk, je.reversed_entry_id))
    return [je for je in entries if je.pk not in hidden], len(hidden)


def vouchers(params, date_from, date_to, branch_ids):
    vtype = (params.get('voucher_type') or 'ALL').upper()
    if vtype not in VOUCHER_TYPES:
        raise StatementError(f"voucher_type must be one of {', '.join(VOUCHER_TYPES)}.")
    origin = (params.get('origin') or 'all').lower()
    _require_range(date_from, date_to, 'voucher statement')
    qs = (JournalEntry.objects.filter(status__in=JournalEntry.LEDGER_STATUSES, is_deleted=False,
                                      date__gte=date_from, date__lte=date_to)
          .select_related('voucher_type', 'branch').order_by('date', 'created_at', 'entry_number'))
    if vtype != 'ALL':
        qs = qs.filter(voucher_type__code=vtype)
    if branch_ids is not None:
        qs = qs.filter(branch_id__in=branch_ids)
    if origin == 'manual':
        qs = qs.filter(MANUAL)
    elif origin == 'auto':
        qs = qs.exclude(MANUAL)
    account_id = _uuid_param(params, 'account_id')
    if account_id:
        qs = qs.filter(lines__account_id=account_id).distinct()
    entries = list(qs[:MAX_ROWS + 1])
    truncated = len(entries) > MAX_ROWS
    entries = entries[:MAX_ROWS]
    hidden = 0
    if not _flag(params, 'show_reversed'):
        entries, hidden = _hide_reversal_pairs(entries)

    accounts = _counter_accounts([je.pk for je in entries])
    rows, total, by_type = [], ZERO, OrderedDict()
    for je in entries:
        dr, cr = accounts[je.pk]
        sign = -1 if je.is_reversal else 1
        amount = money(je.total_amount or 0)
        total += sign * amount
        code = je.voucher_type.code if je.voucher_type_id else ''
        t = by_type.setdefault(code or '—', {'count': 0, 'amount': ZERO,
                                             'name': je.voucher_type.name if je.voucher_type_id else 'Unclassified'})
        t['count'] += 1
        t['amount'] += sign * amount
        meta = je.metadata or {}
        reference = meta.get('reference') or je.source_number or ''
        rows.append(row({
            'date': je.date.isoformat(), 'voucher_no': je.entry_number, 'voucher_type': code,
            'debit_accounts': ', '.join(dr), 'credit_accounts': ', '.join(cr),
            'reference': reference, 'narration': je.narration or '',
            'origin': 'Manual' if (je.source_module in ('', 'financial')) else
            SOURCES.get(je.source_key, (je.source_key,))[0],
            'amount': m(sign * amount),
            'status': 'Reversal' if je.is_reversal else je.status.title(),
        }, ref=ref_of(je)))
    columns = [col('date', 'Date', 'date'), col('voucher_no', 'Voucher No', 'voucher'), col('voucher_type', 'Type'),
               col('debit_accounts', 'Debited Account(s)'), col('credit_accounts', 'Credited Account(s)'),
               col('reference', 'Reference'), col('narration', 'Narration'), col('origin', 'Origin'),
               col('amount', 'Amount', 'money'), col('status', 'Status')]
    notes = []
    if hidden:
        notes.append(f'{hidden} reversed voucher(s) and their reversals cancel out and are hidden. '
                     'Tick "Show reversed" to list them.')
    if truncated:
        notes.append(f'Only the first {MAX_ROWS} vouchers are listed. Narrow the dates.')
    type_rows = [row({'voucher_type': k, 'name': v['name'], 'count': v['count'], 'amount': m(v['amount'])})
                 for k, v in by_type.items()]
    return {
        'title': 'Voucher Statement', 'entity': VOUCHER_TYPES[vtype],
        'summary': [{'label': 'Vouchers', 'value': len(rows), 'format': 'count'},
                    {'label': 'Net amount', 'value': m(total), 'format': 'money'},
                    *[{'label': v['name'], 'value': m(v['amount']), 'format': 'money'} for v in by_type.values()][:4]],
        'notes': notes, 'truncated': truncated,
        'tables': [
            table('vouchers', None, columns, rows,
                  [row({'narration': 'Total', 'amount': m(total)}, style='total')]),
            *([table('by_type', 'By voucher type',
                     [col('voucher_type', 'Code'), col('name', 'Voucher Type'), col('count', 'Vouchers', 'count'),
                      col('amount', 'Amount', 'money')], type_rows)] if vtype == 'ALL' and type_rows else []),
        ],
    }


# ---------------------------------------------------------------------------
# Books: Day Book, Cash Book, Bank Book, Cheque Register
# ---------------------------------------------------------------------------

def day_book(params, date_from, date_to, branch_ids):
    _require_range(date_from, date_to, 'Day Book')
    try:
        data = daybook.daybook(date_from, date_to, branch_ids=branch_ids, search=params.get('search') or '',
                               show_reversed=_flag(params, 'show_reversed'), export=True)
    except daybook.DayBookError as exc:
        raise StatementError(str(exc))
    rows = []
    for g in data['rows']:
        modes = ', '.join(p['mode'] for p in g['payments'])
        rows.append(row({
            'date': g['date'], 'time': g['time'], 'voucher_no': g['entry_number'], 'kind': g['kind_label'],
            'reference': g['reference'], 'party': g['party'], 'modes': modes, 'amount': m(g['amount']),
            'money_in': nz(Decimal(g['money_in'])), 'money_out': nz(Decimal(g['money_out'])),
        }, ref=ref_from(g)))
    s, mt = data['summary'], data['matched']
    columns = [col('date', 'Date', 'date'), col('time', 'Time'), col('voucher_no', 'Voucher No', 'voucher'),
               col('kind', 'Type'), col('reference', 'Reference'), col('party', 'Party'),
               col('modes', 'Pay Mode'), col('amount', 'Bill / Amount', 'money'),
               col('money_in', 'Money In', 'money'), col('money_out', 'Money Out', 'money')]
    mode_rows = [row({'mode': b['mode'], 'count': b['count'], 'in': nz(Decimal(b['amount_in'])),
                      'out': nz(Decimal(b['amount_out'])), 'net': m(b['net'])}) for b in s['by_mode']]
    return {
        'title': 'Day Book', 'entity': 'All transactions',
        'summary': [{'label': 'Transactions', 'value': s['transactions'], 'format': 'count'},
                    {'label': 'Sales', 'value': s['sales_total'], 'format': 'money'},
                    {'label': 'Purchases', 'value': s['purchases_total'], 'format': 'money'},
                    {'label': 'Money in', 'value': s['money_in'], 'format': 'money'},
                    {'label': 'Money out', 'value': s['money_out'], 'format': 'money'},
                    {'label': 'Net money', 'value': s['net_money'], 'format': 'money'}],
        'notes': ([f"{s['hidden_reversals']} reversed entr(ies) hidden."] if s['hidden_reversals'] else [])
        + ([f'Only the first {daybook.MAX_EXPORT_ROWS} transactions are listed.'] if data['truncated'] else []),
        'truncated': data['truncated'],
        'tables': [
            table('daybook', None, columns, rows,
                  [row({'party': 'Total', 'money_in': mt['money_in'], 'money_out': mt['money_out']}, style='total')]),
            *([table('by_mode', 'By pay mode',
                     [col('mode', 'Mode'), col('count', 'Entries', 'count'), col('in', 'In', 'money'),
                      col('out', 'Out', 'money'), col('net', 'Net', 'money')], mode_rows)] if mode_rows else []),
        ],
    }


def _book_accounts(params, list_fn, default_fn, what):
    wanted = (params.get('account_id') or '').strip()
    if wanted == 'all':
        ids = [a['id'] for a in list_fn()]
        if not ids:
            raise StatementError(f'No {what} accounts in the Chart of Accounts.')
        return ids, True
    wanted = wanted or default_fn()
    if not wanted:
        raise StatementError(f'No {what} accounts in the Chart of Accounts.')
    _uuid_param({'account_id': wanted}, 'account_id')
    return [wanted], False


def cash_book(params, date_from, date_to, branch_ids):
    ids, all_accounts = _book_accounts(params, cashbook.cash_accounts, cashbook.default_cash_account_id, 'cash')
    try:
        data = cashbook.cashbook(ids, all_accounts=all_accounts, date_from=date_from, date_to=date_to,
                                 branch_ids=branch_ids, search=params.get('search') or '',
                                 show_reversed=_flag(params, 'show_reversed'), export=True)
    except cashbook.CashbookError as exc:
        raise StatementError(str(exc))
    s = data['summary']
    rows = [row({'particulars': 'Opening Balance', 'balance': s['opening_balance']}, style='opening')]
    for r in data['rows']:
        rows.append(row({'date': r['date'], 'voucher_no': r['entry_number'], 'kind': r['voucher_kind_label'],
                         'particulars': r['particulars'], 'narration': ' · '.join(x for x in (r['description'], r['memo']) if x),
                         'cash_in': r['cash_in'], 'cash_out': r['cash_out'], 'balance': r['balance']},
                        ref=ref_from(r)))
    rows.append(row({'particulars': 'Closing Balance', 'balance': s['closing_balance']}, style='closing'))
    columns = [col('date', 'Date', 'date'), col('voucher_no', 'Voucher No', 'voucher'), col('kind', 'Type'),
               col('particulars', 'Particulars'), col('narration', 'Narration'),
               col('cash_in', 'Cash In (Dr)', 'money'), col('cash_out', 'Cash Out (Cr)', 'money'),
               col('balance', 'Balance', 'money')]
    entity = 'All cash accounts' if all_accounts else ', '.join(f"{a['code']} - {a['name']}" for a in data['accounts'])
    return {
        'title': 'Cash Book', 'entity': entity,
        'summary': [{'label': 'Opening', 'value': s['opening_balance'], 'format': 'money'},
                    {'label': 'Cash in', 'value': s['total_cash_in'], 'format': 'money'},
                    {'label': 'Cash out', 'value': s['total_cash_out'], 'format': 'money'},
                    {'label': 'Closing', 'value': s['closing_balance'], 'format': 'money'},
                    {'label': 'Transactions', 'value': s['transactions'], 'format': 'count'}],
        'notes': ([f"{s['hidden_reversals']} reversed entr(ies) hidden."] if s['hidden_reversals'] else []),
        'truncated': data['truncated'],
        'tables': [table('cashbook', None, columns, rows,
                         [row({'narration': 'Total', 'cash_in': s['total_cash_in'], 'cash_out': s['total_cash_out'],
                               'balance': s['closing_balance']}, style='total')])],
    }


def bank_book(params, date_from, date_to, branch_ids):
    ids, all_accounts = _book_accounts(params, bankbook.bank_accounts, bankbook.default_bank_account_id, 'bank')
    try:
        data = bankbook.bankbook(ids, all_accounts=all_accounts, date_from=date_from, date_to=date_to,
                                 branch_ids=branch_ids, search=params.get('search') or '',
                                 show_reversed=_flag(params, 'show_reversed'), export=True)
    except bankbook.BankBookError as exc:
        raise StatementError(str(exc))
    s = data['summary']
    rows = [row({'particulars': 'Opening Balance', 'balance': s['opening_balance']}, style='opening')]
    for r in data['rows']:
        refno = r['reference'] or ', '.join(c['number'] for c in r['cheques'])
        rows.append(row({'date': r['date'], 'voucher_no': r['entry_number'], 'kind': r['voucher_kind_label'],
                         'bank': r['bank_account'] if all_accounts else '', 'particulars': r['particulars'],
                         'party': r['party'], 'mode': r['mode_label'], 'reference': refno,
                         'deposit': r['deposit'], 'withdrawal': r['withdrawal'], 'balance': r['balance']},
                        ref=ref_from(r)))
    rows.append(row({'particulars': 'Closing Balance', 'balance': s['closing_balance']}, style='closing'))
    columns = [col('date', 'Date', 'date'), col('voucher_no', 'Voucher No', 'voucher'), col('kind', 'Type'),
               *([col('bank', 'Bank Account')] if all_accounts else []),
               col('particulars', 'Particulars'), col('party', 'Party'), col('mode', 'Mode'),
               col('reference', 'Ref / Cheque No'), col('deposit', 'Deposit', 'money'),
               col('withdrawal', 'Withdrawal', 'money'), col('balance', 'Balance', 'money')]
    per_bank = [row({'bank': b['label'], 'opening': b['opening'], 'deposits': b['deposits'],
                     'withdrawals': b['withdrawals'], 'closing': b['closing'], 'count': b['transactions']})
                for b in s['by_account']]
    entity = 'All bank accounts' if all_accounts else ', '.join(f"{a['code']} - {a['name']}" for a in data['accounts'])
    return {
        'title': 'Bank Book', 'entity': entity,
        'summary': [{'label': 'Opening', 'value': s['opening_balance'], 'format': 'money'},
                    {'label': 'Deposits', 'value': s['total_deposits'], 'format': 'money'},
                    {'label': 'Withdrawals', 'value': s['total_withdrawals'], 'format': 'money'},
                    {'label': 'Closing', 'value': s['closing_balance'], 'format': 'money'},
                    {'label': 'Uncleared cheques in', 'value': s['uncleared_cheques_received']['amount'], 'format': 'money'},
                    {'label': 'Uncleared cheques out', 'value': s['uncleared_cheques_issued']['amount'], 'format': 'money'}],
        'notes': ([f"{s['hidden_reversals']} reversed entr(ies) hidden."] if s['hidden_reversals'] else []),
        'truncated': data['truncated'],
        'tables': [
            table('bankbook', None, columns, rows,
                  [row({'reference': 'Total', 'deposit': s['total_deposits'], 'withdrawal': s['total_withdrawals'],
                        'balance': s['closing_balance']}, style='total')]),
            *([table('by_bank', 'Per-bank breakdown',
                     [col('bank', 'Bank Account'), col('opening', 'Opening', 'money'),
                      col('deposits', 'Deposits', 'money'), col('withdrawals', 'Withdrawals', 'money'),
                      col('closing', 'Closing', 'money'), col('count', 'Entries', 'count')], per_bank)]
              if len(per_bank) > 1 else []),
        ],
    }


def cheque_register(params, date_from, date_to, branch_ids):
    _period(date_from, date_to)
    direction = (params.get('direction') or '').upper()
    if direction and direction not in ('RECEIVED', 'ISSUED'):
        raise StatementError('direction must be RECEIVED or ISSUED.')
    statuses = [s for s in (params.get('status') or '').upper().split(',') if s]
    valid = {s for s, _ in cheques.Cheque.STATUS_CHOICES}
    if any(s not in valid for s in statuses):
        raise StatementError(f"status must be one of {', '.join(sorted(valid))}.")
    bank = _uuid_param(params, 'account_id')
    data = cheques.cheque_register(direction=direction, statuses=statuses, date_field='cheque',
                                   date_from=date_from, date_to=date_to, search=params.get('search') or '',
                                   bank_account=str(bank) if bank else '', branch_ids=branch_ids,
                                   sort='cheque_date', export=True)
    rows, received, issued = [], ZERO, ZERO
    for c in sorted(data['rows'], key=lambda c: (str(c['cheque_date'] or ''), c['cheque_number'])):
        amount = Decimal(c['amount'])
        live = c['status'] not in ('CANCELLED', 'BOUNCED')
        if live:
            if c['direction'] == 'RECEIVED':
                received += amount
            else:
                issued += amount
        ref = None
        if c['journal_entry']:
            ref = {'entry_id': c['journal_entry'], 'entry_number': c['voucher_number'],
                   'date': str(c['cheque_date'] or ''), 'source_module': 'financial', 'source_event': 'voucher',
                   'source_number': c['voucher_number'], 'reference_id': None, 'is_reversal': False}
        rows.append(row({
            'cheque_date': str(c['cheque_date'] or ''), 'cheque_no': c['cheque_number'],
            'direction': c['direction_label'], 'party': c['party_name'],
            'bank': ' · '.join(x for x in (c['bank_name'], c['bank_branch']) if x),
            'voucher_no': c['voucher_number'], 'due_date': str(c['due_date'] or ''),
            'cleared_date': str(c['cleared_date'] or ''), 'status': c['status_label'],
            'received': m(amount) if c['direction'] == 'RECEIVED' else None,
            'issued': m(amount) if c['direction'] == 'ISSUED' else None,
        }, style='' if live else 'muted', ref=ref))
    by_status = data['summary']['by_status']
    status_rows = [row({'status': label, 'count': by_status[s]['count'], 'amount': by_status[s]['amount']})
                   for s, label in cheques.Cheque.STATUS_CHOICES]
    columns = [col('cheque_date', 'Cheque Date', 'date'), col('cheque_no', 'Cheque No'), col('direction', 'Type'),
               col('party', 'Party'), col('bank', 'Bank'), col('voucher_no', 'Voucher No', 'voucher'),
               col('due_date', 'Due', 'date'), col('cleared_date', 'Cleared', 'date'), col('status', 'Status'),
               col('received', 'Received', 'money'), col('issued', 'Issued', 'money')]
    summary = data['summary']
    return {
        'title': 'Cheque Register',
        'entity': {'RECEIVED': 'Cheques received', 'ISSUED': 'Cheques issued'}.get(direction, 'All cheques'),
        'summary': [{'label': 'Cheques', 'value': data['count'], 'format': 'count'},
                    {'label': 'Pending / deposited (in)', 'value': summary['received_open']['amount'], 'format': 'money'},
                    {'label': 'Pending / deposited (out)', 'value': summary['issued_open']['amount'], 'format': 'money'},
                    {'label': 'Cleared', 'value': by_status['CLEARED']['amount'], 'format': 'money'},
                    {'label': 'Bounced', 'value': by_status['BOUNCED']['amount'], 'format': 'money'},
                    {'label': 'Overdue', 'value': summary['overdue']['amount'], 'format': 'money'}],
        'notes': ['Totals leave out bounced and cancelled cheques (listed greyed).']
        + ([f'Only the first {cheques.MAX_EXPORT} cheques are listed.'] if data['truncated'] else []),
        'truncated': data['truncated'],
        'tables': [
            table('cheques', None, columns, rows,
                  [row({'status': 'Total', 'received': m(received), 'issued': m(issued)}, style='total')]),
            table('by_status', 'By status', [col('status', 'Status'), col('count', 'Cheques', 'count'),
                                             col('amount', 'Amount', 'money')], status_rows),
        ],
    }


# ---------------------------------------------------------------------------
# Ledger statement
# ---------------------------------------------------------------------------

def ledger(params, date_from, date_to, branch_ids):
    account_id = _uuid_param(params, 'account_id')
    if not account_id:
        raise StatementError('Choose a ledger account.')
    _period(date_from, date_to)
    all_accounts = _accounts(include_deleted=True)
    acc = next((a for a in all_accounts if a.pk == account_id), None)
    if acc is None:
        raise StatementError('Account not found.')
    ids = _descendants(acc.pk, all_accounts)
    with_children = len(ids) > 1

    opening = ZERO
    if date_from:
        agg = _scoped(posted_lines(date_to=date_from - ONE_DAY), branch_ids).filter(account_id__in=ids) \
            .aggregate(dr=Sum('debit'), cr=Sum('credit'))
        opening = (agg['dr'] or ZERO) - (agg['cr'] or ZERO)
    lines = list(_scoped(posted_lines(date_from, date_to), branch_ids).filter(account_id__in=ids)
                 .select_related('journal_entry', 'journal_entry__voucher_type', 'account')
                 .order_by('journal_entry__date', 'journal_entry__created_at', 'journal_entry__entry_number', 'id')
                 [:MAX_ROWS + 1])
    truncated = len(lines) > MAX_ROWS
    lines = lines[:MAX_ROWS]
    counters = defaultdict(list)
    for l in (LedgerEntry.objects.filter(journal_entry_id__in={l.journal_entry_id for l in lines})
              .exclude(account_id__in=ids).select_related('account')):
        if l.account.name not in counters[l.journal_entry_id]:
            counters[l.journal_entry_id].append(l.account.name)

    rows = [row({'particulars': 'Opening Balance', 'balance': m(opening)}, style='opening')]
    running, sum_dr, sum_cr = opening, ZERO, ZERO
    for l in lines:
        je = l.journal_entry
        running += l.debit - l.credit
        sum_dr += l.debit
        sum_cr += l.credit
        rows.append(row({
            'date': je.date.isoformat(), 'voucher_no': je.entry_number,
            'voucher_type': je.voucher_type.code if je.voucher_type_id else '',
            **({'account': l.account.name} if with_children else {}),
            'particulars': ', '.join(counters[je.pk]) or '—',
            'narration': ' · '.join(x for x in (je.narration, l.memo) if x),
            'reference': je.source_number or '',
            'debit': nz(l.debit), 'credit': nz(l.credit), 'balance': m(running),
        }, ref=ref_of(je)))
    rows.append(row({'particulars': 'Closing Balance', 'balance': m(running)}, style='closing'))
    columns = [col('date', 'Date', 'date'), col('voucher_no', 'Voucher No', 'voucher'), col('voucher_type', 'Type'),
               *([col('account', 'Account')] if with_children else []),
               col('particulars', 'Particulars'), col('narration', 'Narration'), col('reference', 'Reference'),
               col('debit', 'Debit', 'money'), col('credit', 'Credit', 'money'), col('balance', 'Balance', 'drcr')]
    return {
        'title': 'Ledger Statement',
        'entity': _account_label(acc) + (' (with sub-accounts)' if with_children else ''),
        'subtitle': f"{acc.account_type} · {acc.account_group.name if acc.account_group_id else ''}",
        'summary': [{'label': 'Opening', 'value': m(opening), 'format': 'drcr'},
                    {'label': 'Total debit', 'value': m(sum_dr), 'format': 'money'},
                    {'label': 'Total credit', 'value': m(sum_cr), 'format': 'money'},
                    {'label': 'Closing', 'value': m(running), 'format': 'drcr'},
                    {'label': 'Entries', 'value': len(lines), 'format': 'count'}],
        'notes': [f'Only the first {MAX_ROWS} lines are listed; the closing balance stops there.'] if truncated else [],
        'truncated': truncated,
        'tables': [table('ledger', None, columns, rows,
                         [row({'reference': 'Total', 'debit': m(sum_dr), 'credit': m(sum_cr), 'balance': m(running)},
                              style='total')])],
    }


# ---------------------------------------------------------------------------
# Final accounts
# ---------------------------------------------------------------------------

def _split(net):
    return (net, ZERO) if net > 0 else (ZERO, -net)


def trial_balance(params, date_from, date_to, branch_ids):
    detailed = (params.get('mode') or 'summary').lower() == 'detailed'
    _period(date_from, date_to)
    accounts = _accounts(include_deleted=True)
    closing_sums = _sums(branch_ids, date_to=date_to)
    if detailed:
        opening_sums = _sums(branch_ids, date_to=date_from - ONE_DAY) if date_from else {}
        period_sums = _sums(branch_ids, date_from, date_to)
    cols = ['op_dr', 'op_cr', 'dr', 'cr', 'cl_dr', 'cl_cr'] if detailed else ['cl_dr', 'cl_cr']
    rows, grand = [], dict.fromkeys(cols, ZERO)
    for acc_type in TYPE_ORDER:
        type_rows, type_tot = [], dict.fromkeys(cols, ZERO)
        for a in accounts:
            if a.account_type != acc_type:
                continue
            cdr, ccr = closing_sums.get(a.pk, (ZERO, ZERO))
            figures = {}
            figures['cl_dr'], figures['cl_cr'] = _split(cdr - ccr)
            if detailed:
                odr, ocr = opening_sums.get(a.pk, (ZERO, ZERO))
                figures['op_dr'], figures['op_cr'] = _split(odr - ocr)
                figures['dr'], figures['cr'] = period_sums.get(a.pk, (ZERO, ZERO))
            if not any(figures.values()) and not (cdr or ccr):
                continue
            for k in cols:
                type_tot[k] += figures[k]
            type_rows.append(row({'code': a.code, 'name': a.name,
                                  'group': a.account_group.name if a.account_group_id else '',
                                  **{k: nz(figures[k]) for k in cols}}, level=1) | {'account_id': str(a.pk)})
        if not type_rows:
            continue
        rows.append(row({'name': TYPE_TITLES[acc_type]}, style='section'))
        rows.extend(type_rows)
        rows.append(row({'name': f"Total {TYPE_TITLES[acc_type]}", **{k: m(v) for k, v in type_tot.items()}},
                        style='subtotal'))
        for k in cols:
            grand[k] += type_tot[k]
    labels = {'op_dr': 'Opening Dr', 'op_cr': 'Opening Cr', 'dr': 'Period Debit', 'cr': 'Period Credit',
              'cl_dr': 'Closing Dr' if detailed else 'Debit', 'cl_cr': 'Closing Cr' if detailed else 'Credit'}
    columns = [col('code', 'Code'), col('name', 'Account'), col('group', 'Group'),
               *[col(k, labels[k], 'money') for k in cols]]
    diff = grand['cl_dr'] - grand['cl_cr']
    return {
        'title': 'Trial Balance', 'entity': 'Detailed (opening, period, closing)' if detailed else 'Summary',
        'as_of': date_to.isoformat() if date_to else None,
        'summary': [{'label': 'Total debit', 'value': m(grand['cl_dr']), 'format': 'money'},
                    {'label': 'Total credit', 'value': m(grand['cl_cr']), 'format': 'money'},
                    {'label': 'Difference', 'value': m(diff), 'format': 'money'}],
        'balanced': money(diff) == 0, 'difference': m(diff),
        'notes': [] if detailed else ['Closing balances as on the To date (every posting up to that day).'],
        'tables': [table('trial_balance', None, columns, rows,
                         [row({'name': 'Grand Total', **{k: m(v) for k, v in grand.items()}}, style='total')])],
    }


def profit_loss(params, date_from, date_to, branch_ids):
    compare = _flag(params, 'compare')
    try:
        data = pl_statement.profit_and_loss_statement(date_from, date_to, branch_ids=branch_ids, compare=compare)
    except ValueError as exc:
        raise StatementError(str(exc))
    s, prev = data['summary'], data['previous'] or {}
    rows = []

    def result(label, key):
        rows.append(row({'name': label, 'amount': s[key], 'previous': prev.get(key)}, style='result'))

    for sec in data['sections']:
        rows.append(row({'name': sec['label']}, style='section'))
        for g in sec['groups']:
            rows.append(row({'name': g['group'], 'amount': g['total'], 'previous': g['previous_total']}, style='group'))
            for a in g['accounts']:
                rows.append(row({'code': a['code'], 'name': a['name'], 'amount': a['amount'],
                                 'previous': a['previous_amount']}, level=2) | {'account_id': a['id']})
        if not sec['groups']:
            rows.append(row({'name': 'No entries'}, style='info', level=1))
        rows.append(row({'name': f"Total {sec['label']}", 'amount': sec['total'], 'previous': sec['previous_total']},
                        style='subtotal'))
        if sec['key'] == pl_statement.DIRECT_EXPENSE:
            result('Gross Profit / (Loss)', 'gross_profit')
    result('Net Profit / (Loss)', 'net_profit')
    columns = [col('code', 'Code'), col('name', 'Particulars'), col('amount', 'Amount', 'money'),
               *([col('previous', f"Previous ({prev.get('date_from')} – {prev.get('date_to')})", 'money')]
                 if compare and prev else [])]
    net = Decimal(s['net_profit'])
    return {
        'title': 'Profit & Loss Statement', 'entity': 'Income Statement',
        'summary': [{'label': 'Total income', 'value': s['total_income'], 'format': 'money'},
                    {'label': 'Total expenses', 'value': s['total_expenses'], 'format': 'money'},
                    {'label': 'Gross profit', 'value': s['gross_profit'], 'format': 'money'},
                    {'label': 'Net profit' if net >= 0 else 'Net loss', 'value': s['net_profit'], 'format': 'money'},
                    *([{'label': 'Net margin', 'value': s['net_margin_pct'], 'format': 'percent'}]
                      if s['net_margin_pct'] is not None else [])],
        'notes': [],
        'tables': [table('profit_loss', None, columns, rows)],
    }


def _bs_side(acc_types, accounts, open_sums, close_sums, extra=()):
    """Rows for one side of the Balance Sheet: type → group → accounts (hierarchy), figures in
    each account's normal direction."""
    cols = ['opening', 'closing']
    rows, total = [], dict.fromkeys(cols, ZERO)
    for acc_type in acc_types:
        debit_normal = acc_type == 'Asset'
        values = {}
        of_type = []
        for a in accounts:
            if a.account_type != acc_type:
                continue
            odr, ocr = open_sums.get(a.pk, (ZERO, ZERO))
            cdr, ccr = close_sums.get(a.pk, (ZERO, ZERO))
            o, c = (odr - ocr, cdr - ccr) if debit_normal else (ocr - odr, ccr - cdr)
            values[a.pk] = {'opening': o, 'closing': c}
            of_type.append(a)
        # drop accounts (and their branches) with nothing in either column
        live = {pk for pk, v in values.items() if v['opening'] or v['closing']}
        for a in of_type:
            if a.pk in live:
                p = a.parent_account_id
                while p and p not in live and p in values:
                    live.add(p)
                    p = next((x.parent_account_id for x in of_type if x.pk == p), None)
        of_type = [a for a in of_type if a.pk in live]
        type_extra = [e for e in extra if e[0] == acc_type]
        if not of_type and not type_extra:
            continue
        rows.append(row({'name': TYPE_TITLES[acc_type]}, style='section'))
        type_tot = dict.fromkeys(cols, ZERO)
        by_group = OrderedDict()
        for a in sorted(of_type, key=lambda a: ((a.account_group.name if a.account_group_id else 'zz'), a.code)):
            by_group.setdefault(a.account_group.name if a.account_group_id else 'Ungrouped', []).append(a)
        for gname, members in by_group.items():
            body, gtot = _hierarchy_rows(members, values, cols, base_level=2)
            rows.append(row({'name': gname, **{k: m(v) for k, v in gtot.items()}}, style='group', level=1))
            rows.extend(body)
            for k in cols:
                type_tot[k] += gtot[k]
        for _t, label, o, c in type_extra:
            rows.append(row({'name': label, 'opening': m(o), 'closing': m(c)}, style='group', level=1))
            type_tot['opening'] += o
            type_tot['closing'] += c
        rows.append(row({'name': f"Total {TYPE_TITLES[acc_type]}", **{k: m(v) for k, v in type_tot.items()}},
                        style='subtotal'))
        for k in cols:
            total[k] += type_tot[k]
    return rows, total


def balance_sheet(params, date_from, date_to, branch_ids):
    _period(date_from, date_to)
    layout = 'horizontal' if (params.get('layout') or '').lower() == 'horizontal' else 'vertical'
    as_of = date_to
    open_as_of = date_from - ONE_DAY if date_from else None
    accounts = _accounts(include_deleted=True)
    close_sums = _sums(branch_ids, date_to=as_of)
    open_sums = _sums(branch_ids, date_to=open_as_of) if open_as_of else {}
    pl_open = _accumulated_profit(branch_ids, open_as_of) if open_as_of else ZERO
    pl_close = _accumulated_profit(branch_ids, as_of)

    assets, a_tot = _bs_side(['Asset'], accounts, open_sums, close_sums)
    liab, l_tot = _bs_side(['Liability', 'Equity'], accounts, open_sums, close_sums,
                           extra=[('Equity', 'Profit & Loss A/c (accumulated)', pl_open, pl_close)])
    opening_label = f"As on {open_as_of.isoformat()}" if open_as_of else 'Opening'
    closing_label = f"As on {as_of.isoformat()}" if as_of else 'Closing'
    columns = [col('code', 'Code'), col('name', 'Particulars'), col('opening', opening_label, 'money'),
               col('closing', closing_label, 'money')]
    diff = a_tot['closing'] - l_tot['closing']
    liab_table = table('liabilities', 'Liabilities & Equity', columns, liab,
                       [row({'name': 'Total Liabilities & Equity', **{k: m(v) for k, v in l_tot.items()}}, style='total')])
    asset_table = table('assets', 'Assets', columns, assets,
                        [row({'name': 'Total Assets', **{k: m(v) for k, v in a_tot.items()}}, style='total')])
    return {
        'title': 'Balance Sheet', 'entity': 'Horizontal (T-format)' if layout == 'horizontal' else 'Vertical',
        'as_of': as_of.isoformat() if as_of else None, 'layout': layout,
        'summary': [{'label': 'Total assets', 'value': m(a_tot['closing']), 'format': 'money'},
                    {'label': 'Liabilities + equity', 'value': m(l_tot['closing']), 'format': 'money'},
                    {'label': 'Accumulated profit', 'value': m(pl_close), 'format': 'money'},
                    {'label': 'Difference', 'value': m(diff), 'format': 'money'}],
        'balanced': money(diff) == 0, 'difference': m(diff),
        'notes': ['The opening column is the position the day before the From date; the closing column is as on '
                  'the To date. Accumulated profit is income less expenses posted up to each date '
                  '(no closing entries are posted).'],
        # T-format puts Liabilities on the left, Assets on the right; vertical lists Assets first.
        'tables': [liab_table, asset_table] if layout == 'horizontal' else [asset_table, liab_table],
    }


# ---------------------------------------------------------------------------
# Accounting integration audit
# ---------------------------------------------------------------------------

def accounting_integration(params, date_from, date_to, branch_ids):
    _require_range(date_from, date_to, 'integration audit')
    source = (params.get('source') or '').strip()
    qs = (JournalEntry.objects.filter(status__in=JournalEntry.LEDGER_STATUSES, is_deleted=False,
                                      date__gte=date_from, date__lte=date_to).exclude(MANUAL))
    if branch_ids is not None:
        qs = qs.filter(branch_id__in=branch_ids)
    if source:
        module, _, event = source.partition('.')
        qs = qs.filter(source_module=module, source_event=event)

    by_source = []
    t_entries, t_posted, t_rev = 0, ZERO, ZERO
    for r in (qs.values('source_module', 'source_event')
              .annotate(n=Count('id'), posted=Sum('total_amount', filter=Q(is_reversal=False)),
                        rev=Sum('total_amount', filter=Q(is_reversal=True)))
              .order_by('source_module', 'source_event')):
        key = f"{r['source_module']}.{r['source_event']}"
        posted, rev = money(r['posted'] or 0), money(r['rev'] or 0)
        t_entries += r['n']
        t_posted += posted
        t_rev += rev
        by_source.append(row({'source': SOURCES.get(key, (key.replace('.', ' ').title(),))[0], 'key': key,
                              'entries': r['n'], 'posted': m(posted), 'reversed': nz(rev),
                              'net': m(posted - rev)}))

    entries = list(qs.select_related('voucher_type').order_by('date', 'created_at', 'entry_number')[:MAX_ROWS + 1])
    truncated = len(entries) > MAX_ROWS
    entries = entries[:MAX_ROWS]
    accounts = _counter_accounts([je.pk for je in entries])
    detail = []
    for je in entries:
        dr, cr = accounts[je.pk]
        detail.append(row({
            'date': je.date.isoformat(), 'voucher_no': je.entry_number,
            'source': SOURCES.get(je.source_key, (je.source_key,))[0], 'document': je.source_number or '',
            'debit_accounts': ', '.join(dr), 'credit_accounts': ', '.join(cr), 'narration': je.narration or '',
            'amount': m(-(je.total_amount or 0) if je.is_reversal else je.total_amount or 0),
            'status': 'Reversal' if je.is_reversal else je.status.title(),
        }, ref=ref_of(je)))

    failures = PostingFailure.objects.filter(status='OPEN')
    open_failures = failures.count()
    notes = ['Auto-posted journals only: sales, receipts, eye-test fees, purchases, stock and opening entries. '
             'Manual vouchers are in the Voucher Statement.']
    if open_failures:
        notes.append(f'{open_failures} posting failure(s) are waiting in Financial → Accounting Integration; '
                     'those documents are not on the books yet.')
    if truncated:
        notes.append(f'Only the first {MAX_ROWS} journals are listed. Narrow the dates.')
    return {
        'title': 'Accounting Integration Audit',
        'entity': SOURCES.get(source, (source,))[0] if source else 'All automated sources',
        'summary': [{'label': 'Auto-posted journals', 'value': t_entries, 'format': 'count'},
                    {'label': 'Posted amount', 'value': m(t_posted), 'format': 'money'},
                    {'label': 'Reversed amount', 'value': m(t_rev), 'format': 'money'},
                    {'label': 'Open posting failures', 'value': open_failures, 'format': 'count'}],
        'notes': notes, 'truncated': truncated,
        'tables': [
            table('by_source', 'By source', [col('source', 'Source'), col('entries', 'Journals', 'count'),
                                             col('posted', 'Posted', 'money'), col('reversed', 'Reversed', 'money'),
                                             col('net', 'Net', 'money')], by_source,
                  [row({'source': 'Total', 'entries': t_entries, 'posted': m(t_posted), 'reversed': m(t_rev),
                        'net': m(t_posted - t_rev)}, style='total')]),
            table('entries', 'Auto-posted entries',
                  [col('date', 'Date', 'date'), col('voucher_no', 'Voucher No', 'voucher'), col('source', 'Source'),
                   col('document', 'Document No'), col('debit_accounts', 'Debited'), col('credit_accounts', 'Credited'),
                   col('narration', 'Narration'), col('amount', 'Amount', 'money'), col('status', 'Status')], detail),
        ],
    }


BUILDERS = {
    'chart_of_accounts': chart_of_accounts, 'vouchers': vouchers, 'day_book': day_book, 'cash_book': cash_book,
    'bank_book': bank_book, 'cheque_register': cheque_register, 'ledger': ledger, 'trial_balance': trial_balance,
    'profit_loss': profit_loss, 'balance_sheet': balance_sheet, 'accounting_integration': accounting_integration,
}


def build(statement_type, params, date_from=None, date_to=None, branch_ids=None):
    """One statement, in the shape described at the top of this module."""
    statement_type = (statement_type or '').strip().lower()
    fn = BUILDERS.get(statement_type)
    if fn is None:
        raise StatementError(f"type must be one of {', '.join(BUILDERS)}.")
    data = fn(params, date_from, date_to, branch_ids)
    base = {'type': statement_type, 'group': STATEMENTS[statement_type][0], 'subtitle': '', 'entity': '',
            'date_from': date_from.isoformat() if date_from else None,
            'date_to': date_to.isoformat() if date_to else None,
            'as_of': None, 'layout': None, 'summary': [], 'notes': [], 'balanced': None, 'difference': None,
            'truncated': False}
    return {**base, **data}


# ---------------------------------------------------------------------------
# Excel export
# ---------------------------------------------------------------------------

def to_xlsx(data, company_name=''):
    """The statement as an .xlsx workbook (bytes): report header, then each table with its
    footer, money as numbers so the sheet can be summed."""
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    ws = wb.active
    ws.title = (data.get('title') or 'Statement')[:31]
    bold = Font(bold=True)
    head_fill = PatternFill('solid', fgColor='E2E8F0')
    group_fill = PatternFill('solid', fgColor='F1F5F9')
    thin = Side(style='thin', color='94A3B8')
    money_fmt = '#,##0.00;-#,##0.00;""'
    drcr_fmt = '#,##0.00 "Dr";#,##0.00 "Cr";"0.00"'

    period = (f"As on {data['as_of']}" if data.get('as_of') and not data.get('date_from')
              else f"{data.get('date_from') or '…'} to {data.get('date_to') or '…'}")
    header = [company_name, data.get('title'), data.get('entity'),
              f"Branch: {(data.get('branch') or {}).get('label') or 'All branches'}", f"Period: {period}"]
    r = 1
    for i, text in enumerate(h for h in header if h):
        ws.cell(row=r, column=1, value=text).font = Font(bold=True, size=14 if i == 0 else 11)
        r += 1
    for s in data.get('summary') or []:
        ws.cell(row=r, column=1, value=s['label'])
        c = ws.cell(row=r, column=2, value=_num(s['value']) if s['format'] in ('money', 'drcr') else s['value'])
        if s['format'] == 'money':
            c.number_format = money_fmt
        elif s['format'] == 'drcr':
            c.number_format = drcr_fmt
        r += 1
    r += 1

    widths = defaultdict(int)
    for t in data.get('tables') or []:
        cols = t['columns']
        if t.get('title'):
            ws.cell(row=r, column=1, value=t['title']).font = Font(bold=True, size=12)
            r += 1
        for j, c in enumerate(cols, start=1):
            cell = ws.cell(row=r, column=j, value=c['label'])
            cell.font, cell.fill, cell.border = bold, head_fill, Border(bottom=thin)
            widths[j] = max(widths[j], len(c['label']))
        r += 1
        for line in list(t['rows']) + list(t.get('footer') or []):
            style = line.get('style') or ''
            for j, c in enumerate(cols, start=1):
                v = line['cells'].get(c['key'])
                if c['format'] in ('money', 'drcr'):
                    v = _num(v)
                cell = ws.cell(row=r, column=j, value=v)
                if c['format'] == 'money':
                    cell.number_format = money_fmt
                elif c['format'] == 'drcr':
                    cell.number_format = drcr_fmt
                if j == 2 or (j == 1 and c['key'] in ('name', 'particulars')):
                    cell.alignment = Alignment(indent=min(int(line.get('level') or 0), 10))
                if style in ('section', 'group', 'parent', 'subtotal', 'total', 'result', 'opening', 'closing'):
                    cell.font = bold
                if style in ('section', 'subtotal', 'total', 'result'):
                    cell.fill = group_fill
                if style == 'total':
                    cell.border = Border(top=thin, bottom=thin)
                if v is not None:
                    widths[j] = max(widths[j], len(f'{v:,.2f}' if isinstance(v, float) else str(v)))
            r += 1
        r += 1
    for note in data.get('notes') or []:
        ws.cell(row=r, column=1, value=note).font = Font(italic=True, color='64748B')
        r += 1
    for j, w in widths.items():
        ws.column_dimensions[get_column_letter(j)].width = min(max(w + 2, 10), 60)
    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def _num(value):
    if value is None or value == '':
        return None
    try:
        return float(Decimal(str(value)))
    except Exception:
        return value
