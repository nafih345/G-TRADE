"""Financial → Statements: every statement type answers in the common shape, its figures agree
with the ledger (and with the dedicated screens), and the .xlsx export opens."""
import datetime
from io import BytesIO

from rest_framework.test import APITestCase

from apps.financial.models import ChartOfAccount
from apps.financial.services import create_journal, reverse_entry

from .helpers import D, make_user

URL = '/api/financial/statements/'
JAN1, JAN10, JAN20, FEB5 = datetime.date(2026, 1, 1), datetime.date(2026, 1, 10), datetime.date(2026, 1, 20), \
    datetime.date(2026, 2, 5)


def acc(code):
    return ChartOfAccount.objects.get(code=code)


def post(code, dr, cr, amount, date, **kw):
    kw.setdefault('source_module', 'financial')
    kw.setdefault('source_event', 'voucher')
    return create_journal(lines=[{'account': acc(dr), 'debit': amount}, {'account': acc(cr), 'credit': amount}],
                          date=date, voucher_type_code=code, **kw)


def cells(data, table=0):
    return [r['cells'] for r in data['tables'][table]['rows']]


class StatementTests(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))
        post('OB', '1001', '3001', D('50000'), JAN1, source_event='opening_balance')   # capital in cash
        post('CV', '1002', '1001', D('20000'), JAN10)                                  # cash → bank
        post('PV', '1510', '1002', D('8000'), JAN10, narration='Lensmeter')            # fixed asset
        post('RV', '1001', '4003', D('3000'), JAN20, narration='Eye test fees')        # income
        post('PV', '5100', '1001', D('1500'), FEB5, narration='Shop rent')             # expense, next month

    def get(self, **params):
        res = self.client.get(URL, params)
        self.assertEqual(res.status_code, 200, res.content)
        for key in ('type', 'title', 'tables', 'summary', 'notes', 'branch'):
            self.assertIn(key, res.data)
        return res.data

    def test_options_lists_every_statement_and_scope(self):
        res = self.client.get(URL + 'options/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.data['statements']), 13)
        self.assertIn('FIXED_ASSETS', [s['value'] for s in res.data['scopes']])
        equipment = next(a for a in res.data['accounts'] if a['code'] == '1510')
        self.assertEqual(equipment['scope'], 'FIXED_ASSETS')

    def test_unknown_type_and_bad_range_are_400(self):
        self.assertEqual(self.client.get(URL, {'type': 'nope'}).status_code, 400)
        self.assertEqual(self.client.get(URL, {'type': 'ledger', 'account_id': str(acc('1001').pk),
                                               'from_date': '2026-02-01', 'to_date': '2026-01-01'}).status_code, 400)
        self.assertEqual(self.client.get(URL, {'type': 'ledger'}).status_code, 400)  # no account

    def test_full_chart_of_accounts_balances_and_rolls_forward(self):
        data = self.get(type='chart_of_accounts', from_date='2026-01-15', to_date='2026-01-31')
        self.assertTrue(data['balanced'])
        cash = next(c for c in cells(data) if c.get('code') == '1001')
        self.assertEqual(D(cash['opening']), D('30000'))          # 50000 - 20000 before the 15th
        self.assertEqual(D(cash['debit']), D('3000'))
        self.assertEqual(D(cash['closing']), D('33000'))
        total = data['tables'][0]['footer'][0]['cells']
        self.assertEqual(D(total['debit']), D(total['credit']))

    def test_fixed_assets_scope_only_lists_fixed_assets(self):
        data = self.get(type='chart_of_accounts', scope='FIXED_ASSETS', to_date='2026-01-31')
        codes = {c.get('code') for c in cells(data) if c.get('code')}
        self.assertIn('1510', codes)
        self.assertNotIn('1001', codes)
        self.assertEqual(D(data['tables'][0]['footer'][0]['cells']['closing']), D('8000'))

    def test_voucher_statement_filters_by_type_and_hides_reversal_pairs(self):
        data = self.get(type='vouchers', voucher_type='PV', from_date='2026-01-01', to_date='2026-02-28')
        self.assertEqual([c['voucher_type'] for c in cells(data)], ['PV', 'PV'])
        self.assertTrue(all(r['ref']['entry_id'] for r in data['tables'][0]['rows']))
        rv = post('RV', '1001', '4003', D('99'), JAN20)
        reverse_entry(rv, reason='typo')
        data = self.get(type='vouchers', voucher_type='RV', from_date='2026-01-01', to_date='2026-01-31')
        self.assertEqual(len(cells(data)), 1)
        self.assertEqual(D(data['tables'][0]['footer'][0]['cells']['amount']), D('3000'))
        shown = self.get(type='vouchers', voucher_type='RV', from_date='2026-01-01', to_date='2026-01-31',
                         show_reversed=1)
        self.assertEqual(len(cells(shown)), 3)
        self.assertEqual(D(shown['tables'][0]['footer'][0]['cells']['amount']), D('3000'))

    def test_ledger_has_opening_running_and_closing_balance(self):
        data = self.get(type='ledger', account_id=str(acc('1001').pk), from_date='2026-01-05', to_date='2026-02-28')
        rows = data['tables'][0]['rows']
        self.assertEqual(rows[0]['style'], 'opening')
        self.assertEqual(D(rows[0]['cells']['balance']), D('50000'))
        self.assertEqual([D(r['cells']['balance']) for r in rows[1:-1]], [D('30000'), D('33000'), D('31500')])
        self.assertEqual(rows[-1]['style'], 'closing')
        self.assertEqual(D(rows[-1]['cells']['balance']), D('31500'))

    def test_cash_and_bank_books_match_the_ledger(self):
        cash = self.get(type='cash_book', account_id=str(acc('1001').pk), from_date='2026-01-01', to_date='2026-02-28')
        self.assertEqual(D(cash['tables'][0]['rows'][-1]['cells']['balance']), D('31500'))
        bank = self.get(type='bank_book', account_id=str(acc('1002').pk), from_date='2026-01-01', to_date='2026-02-28')
        self.assertEqual(D(bank['tables'][0]['rows'][-1]['cells']['balance']), D('12000'))

    def test_day_book_and_cheque_register_answer(self):
        day = self.get(type='day_book', from_date='2026-01-10', to_date='2026-01-10')
        self.assertEqual(len(cells(day)), 2)
        chq = self.get(type='cheque_register', from_date='2026-01-01', to_date='2026-01-31')
        self.assertEqual(cells(chq), [])

    def test_trial_balance_summary_and_detailed_balance(self):
        tb = self.get(type='trial_balance', to_date='2026-02-28')
        self.assertTrue(tb['balanced'])
        detailed = self.get(type='trial_balance', mode='detailed', from_date='2026-02-01', to_date='2026-02-28')
        self.assertTrue(detailed['balanced'])
        rent = next(c for c in cells(detailed) if c.get('code') == '5100')
        self.assertEqual(D(rent['dr']), D('1500'))
        self.assertIsNone(rent['op_dr'])

    def test_profit_loss_and_balance_sheet_agree(self):
        pl = self.get(type='profit_loss', from_date='2026-01-01', to_date='2026-02-28')
        net = next(c for c in cells(pl) if c.get('name') == 'Net Profit / (Loss)')
        self.assertEqual(D(net['amount']), D('1500'))
        bs = self.get(type='balance_sheet', from_date='2026-02-01', to_date='2026-02-28')
        self.assertTrue(bs['balanced'])
        assets = next(t for t in bs['tables'] if t['key'] == 'assets')
        self.assertEqual(D(assets['footer'][0]['cells']['closing']), D('51500'))
        self.assertEqual(D(assets['footer'][0]['cells']['opening']), D('53000'))
        horizontal = self.get(type='balance_sheet', layout='horizontal', to_date='2026-02-28')
        self.assertEqual(horizontal['tables'][0]['key'], 'liabilities')

    def test_integration_audit_lists_only_automated_postings(self):
        data = self.get(type='accounting_integration', from_date='2026-01-01', to_date='2026-02-28')
        self.assertEqual(cells(data, 1), [])  # every journal above is a manual voucher / opening
        post('SV', '1004', '4001', D('700'), JAN20, source_module='sales', source_event='invoice',
             source_number='INV-1')
        data = self.get(type='accounting_integration', from_date='2026-01-01', to_date='2026-02-28')
        self.assertEqual([c['document'] for c in cells(data, 1)], ['INV-1'])
        self.assertEqual(D(data['tables'][0]['footer'][0]['cells']['net']), D('700'))

    def test_excel_export_is_a_workbook(self):
        from openpyxl import load_workbook
        res = self.client.get(URL, {'type': 'trial_balance', 'to_date': '2026-02-28', 'export': 'xlsx'})
        self.assertEqual(res.status_code, 200)
        self.assertIn('spreadsheetml', res['Content-Type'])
        ws = load_workbook(BytesIO(res.content)).active
        values = [c.value for row in ws.iter_rows() for c in row if c.value is not None]
        self.assertIn('Trial Balance', values)
        self.assertIn('Grand Total', values)

    def test_non_finance_role_is_refused(self):
        self.client.force_authenticate(make_user('CASHIER'))
        self.assertEqual(self.client.get(URL, {'type': 'trial_balance'}).status_code, 403)
