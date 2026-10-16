import datetime
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db.models import Sum

from apps.financial.models import ChartOfAccount, JournalEntry, LedgerEntry

D = Decimal
TODAY = datetime.date.today()


def account(code):
    return ChartOfAccount.all_objects.select_related('account_group').get(code=code)


def balance(code):
    """Normal-sign ledger balance of an account (posted lines only)."""
    acc = account(code)
    agg = LedgerEntry.objects.filter(account=acc, journal_entry__status__in=JournalEntry.LEDGER_STATUSES) \
        .aggregate(dr=Sum('debit'), cr=Sum('credit'))
    dr, cr = agg['dr'] or D('0'), agg['cr'] or D('0')
    return (dr - cr) if acc.normal_balance == 'DEBIT' else (cr - dr)


def live(module, event, ref):
    return JournalEntry.objects.filter(source_module=module, source_event=event, reference_id=ref,
                                       status='POSTED', is_reversal=False)


def lines_of(entry):
    """{account code: net debit(+)/credit(-)} for one journal."""
    out = {}
    for l in entry.lines.select_related('account'):
        out[l.account.code] = out.get(l.account.code, D('0')) + l.debit - l.credit
    return out


def ledger_is_balanced():
    agg = LedgerEntry.objects.filter(journal_entry__status__in=JournalEntry.LEDGER_STATUSES) \
        .aggregate(dr=Sum('debit'), cr=Sum('credit'))
    return (agg['dr'] or 0) == (agg['cr'] or 0)


def make_user(role='SUPER_ADMIN', username=None):
    User = get_user_model()
    return User.objects.create_user(username=username or f"u_{role.lower()}", password='x', role=role)


def make_product(name='Frame A', cost='400.00', stock=10):
    from apps.products.models import Product
    return Product.objects.create(name=name, sku=f"SKU-{name}", cost_price=D(cost), stock=stock)


def make_warehouse():
    from apps.company.models import Company, Branch, Warehouse
    company = Company.objects.create(name='Greensol', fiscal_year_start=TODAY, fiscal_year_end=TODAY)
    branch = Branch.objects.create(company=company, name='Main', code='MAIN', is_default=True)
    return Warehouse.objects.create(branch=branch, name='Main WH', code='WH1')
