"""Accounts → Profit & Loss: direct/indirect grouping, gross and net profit, previous-period
comparison and the day/month/quarter breakdown, all from posted ledger lines."""
import datetime
from decimal import Decimal

from rest_framework.test import APITestCase

from apps.financial.models import AccountGroup, ChartOfAccount
from apps.financial.pl_statement import (DIRECT_EXPENSE, DIRECT_INCOME, INDIRECT_EXPENSE, INDIRECT_INCOME,
                                         pl_bucket, previous_range)
from apps.financial.services import create_journal, reverse_entry

from .helpers import make_user

URL = '/api/financial/reports/profit-loss-statement/'
d = lambda m, day: datetime.date(2026, m, day)  # noqa: E731


def acc(code):
    return ChartOfAccount.objects.get(code=code)


def post(dr, cr, amount, date):
    return create_journal(lines=[{'account': dr, 'debit': amount}, {'account': cr, 'credit': amount}],
                          date=date, voucher_type_code='JV', source_module='financial', source_event='voucher')


class BucketRules(APITestCase):
    def test_seeded_accounts(self):
        cases = {'4001': DIRECT_INCOME, '4003': DIRECT_INCOME, '4090': DIRECT_INCOME, '4080': INDIRECT_INCOME,
                 '5001': DIRECT_EXPENSE, '5060': DIRECT_EXPENSE, '5050': INDIRECT_EXPENSE, '5100': INDIRECT_EXPENSE}
        for code, bucket in cases.items():
            a = acc(code)
            self.assertEqual(pl_bucket(a.account_type, a.account_subtype, a.account_group.name), bucket, code)

    def test_group_name_overrides_subtype(self):
        self.assertEqual(pl_bucket('Income', 'REVENUE', 'Indirect Incomes'), INDIRECT_INCOME)
        self.assertEqual(pl_bucket('Expense', '', 'Direct Expenses'), DIRECT_EXPENSE)
        self.assertEqual(pl_bucket('Expense', '', 'Office'), INDIRECT_EXPENSE)
        self.assertEqual(pl_bucket('Income', '', 'Misc'), INDIRECT_INCOME)
        self.assertIsNone(pl_bucket('Asset', 'CASH', 'Cash Accounts'))

    def test_fiscal_quarters(self):
        from apps.financial.pl_statement import _period_key, _period_label
        self.assertEqual(_period_key(d(5, 9), 'quarter', 4), d(4, 1))
        self.assertEqual(_period_key(d(2, 9), 'quarter', 4), d(1, 1))
        self.assertEqual(_period_key(datetime.date(2026, 12, 1), 'quarter', 4), d(10, 1))
        self.assertEqual(_period_key(d(2, 9), 'quarter', 1), d(1, 1))
        self.assertEqual(_period_label(d(10, 1), 'quarter', 4), 'Q3 FY 2026-27')
        self.assertEqual(_period_label(d(7, 1), 'quarter', 1), 'Q3 2026')

    def test_previous_range(self):
        self.assertEqual(previous_range(d(3, 1), d(3, 31)), (d(2, 1), d(2, 28)))
        self.assertEqual(previous_range(d(4, 1), d(6, 30)), (d(1, 1), d(3, 31)))
        self.assertEqual(previous_range(d(3, 10), d(3, 19)), (d(2, 28), d(3, 9)))


class StatementApi(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))
        cash, stock = acc('1001'), acc('1003')
        self.interest = ChartOfAccount.objects.create(
            code='4500', name='Interest Received', account_subtype='OTHER_INCOME',
            account_group=AccountGroup.objects.get_or_create(name='Indirect Incomes', defaults={'account_type': 'Income'})[0])
        post(cash, acc('4001'), Decimal('10000'), d(3, 5))      # sales
        post(cash, acc('4003'), Decimal('2000'), d(3, 6))       # services
        post(acc('4090'), cash, Decimal('500'), d(3, 7))        # sales return
        post(acc('5001'), stock, Decimal('6000'), d(3, 5))      # COGS
        post(acc('5100'), cash, Decimal('3000'), d(3, 10))      # rent
        post(cash, self.interest, Decimal('100'), d(3, 20))     # interest
        post(cash, acc('4001'), Decimal('4000'), d(2, 10))      # previous month sale
        wrong = post(acc('5110'), cash, Decimal('999'), d(3, 15))
        reverse_entry(wrong, reason='mistake')                  # reversal pair nets to zero

    def get(self, **params):
        res = self.client.get(URL, {'date_from': '2026-03-01', 'date_to': '2026-03-31', **params})
        self.assertEqual(res.status_code, 200, res.content)
        return res.json()

    def test_gross_and_net_profit(self):
        s = self.get()['summary']
        self.assertEqual(Decimal(s['direct_income']), Decimal('11500'))   # 10000 + 2000 - 500 return
        self.assertEqual(Decimal(s['direct_expenses']), Decimal('6000'))
        self.assertEqual(Decimal(s['gross_profit']), Decimal('5500'))
        self.assertEqual(Decimal(s['indirect_income']), Decimal('100'))
        self.assertEqual(Decimal(s['indirect_expenses']), Decimal('3000'))
        self.assertEqual(Decimal(s['net_profit']), Decimal('2600'))
        self.assertEqual(Decimal(s['gross_margin_pct']), Decimal('47.83'))

    def test_sections_and_reversal_hidden_in_totals(self):
        data = self.get()
        by_key = {sec['key']: sec for sec in data['sections']}
        self.assertEqual([sec['key'] for sec in data['sections']],
                         [DIRECT_INCOME, DIRECT_EXPENSE, INDIRECT_INCOME, INDIRECT_EXPENSE])
        names = [a['name'] for g in by_key[INDIRECT_EXPENSE]['groups'] for a in g['accounts']]
        self.assertIn('Rent', names)
        salaries = [a for g in by_key[INDIRECT_EXPENSE]['groups'] for a in g['accounts'] if a['name'] == 'Salaries & Wages']
        self.assertEqual(Decimal(salaries[0]['amount']), Decimal('0'))   # posted + reversed, still listed
        self.assertEqual(Decimal(by_key[INDIRECT_EXPENSE]['total']), Decimal('3000'))

    def test_compare_previous_period(self):
        data = self.get(compare='1')
        self.assertEqual(data['previous']['date_from'], '2026-02-01')
        self.assertEqual(Decimal(data['previous']['net_profit']), Decimal('4000'))
        sales = [a for sec in data['sections'] for g in sec['groups'] for a in g['accounts'] if a['code'] == '4001'][0]
        self.assertEqual(Decimal(sales['previous_amount']), Decimal('4000'))

    def test_breakdown(self):
        days = self.get(breakdown='day')['periods']
        self.assertEqual(len(days), 31)
        self.assertEqual(Decimal(next(p for p in days if p['key'] == '2026-03-05')['gross_profit']), Decimal('4000'))
        quarters = self.client.get(URL, {'date_from': '2026-01-01', 'date_to': '2026-06-30', 'breakdown': 'quarter'}).json()['periods']
        # Fiscal year from April (the default): Jan–Mar is Q4 of FY 2025-26, Apr–Jun is Q1 of FY 2026-27.
        self.assertEqual([p['label'] for p in quarters], ['Q4 FY 2025-26', 'Q1 FY 2026-27'])
        self.assertEqual(Decimal(quarters[0]['net_profit']), Decimal('6600'))
        months = self.client.get(URL, {'date_from': '2026-02-01', 'date_to': '2026-03-31', 'breakdown': 'month'}).json()['periods']
        self.assertEqual(sum(Decimal(p['net_profit']) for p in months), Decimal('6600'))

    def test_bad_input(self):
        self.assertEqual(self.client.get(URL, {'date_from': '2026-03-31', 'date_to': '2026-03-01'}).status_code, 400)
        self.assertEqual(self.client.get(URL, {'breakdown': 'week'}).status_code, 400)
