"""Record Expense → "+ Add New Category": each category is a new Expense ledger that the P&L,
Trial Balance and Ledger pick up; names are unique per tenant; ledgers with postings can't be deleted."""
import datetime
from decimal import Decimal

from rest_framework.test import APITestCase

from apps.financial.models import ChartOfAccount
from apps.financial.pl_statement import DIRECT_EXPENSE, INDIRECT_EXPENSE

from .helpers import make_user

URL = '/api/financial/accounts/expense-category/'
TODAY = datetime.date.today().isoformat()


class ExpenseCategoryApi(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))

    def add(self, **body):
        return self.client.post(URL, body, format='json')

    def pay(self, account_id, amount):
        res = self.client.post('/api/financial/journals/', {
            'voucher_type_code': 'PV', 'date': TODAY, 'narration': 'Expense',
            'lines': [{'account': account_id, 'debit': amount, 'credit': 0},
                      {'account': str(ChartOfAccount.objects.get(code='1001').pk), 'debit': 0, 'credit': amount,
                       'memo': 'Cash'}]}, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)

    def test_creates_indirect_expense_ledger_by_default(self):
        res = self.add(name='  Digital   Marketing ', description='Ads')
        self.assertEqual(res.status_code, 201, res.content)
        acc = ChartOfAccount.objects.get(pk=res.data['id'])
        self.assertEqual((acc.name, acc.account_type, acc.account_subtype, acc.status),
                         ('Digital Marketing', 'Expense', 'EXPENSE', 'Active'))
        self.assertEqual(acc.account_group.name, 'Indirect Expenses')
        self.assertEqual(res.data['expense_type'], 'INDIRECT')
        self.assertEqual(acc.description, 'Ads')
        self.assertRegex(acc.code, r'^5\d{3}$')

    def test_codes_are_unique_and_increasing(self):
        a = self.add(name='Electricity Bill').data['code']
        b = self.add(name='Internet').data['code']
        self.assertNotEqual(a, b)
        self.assertGreater(int(b), int(a))

    def test_direct_type_uses_direct_group(self):
        res = self.add(name='Freight Inward', expense_type='direct')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data['account_group_name'], 'Direct Expenses')
        self.assertEqual(res.data['expense_type'], 'DIRECT')

    def test_duplicate_names_rejected_case_insensitively(self):
        first = self.add(name='Electricity Bill')
        res = self.add(name='electricity bill')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data['existing_id'], first.data['id'])
        clash = self.add(name='cash in hand')          # an Asset ledger
        self.assertEqual(clash.status_code, 400)
        self.assertNotIn('existing_id', clash.data)

    def test_validation(self):
        self.assertEqual(self.add(name='  ').status_code, 400)
        self.assertEqual(self.add(name='X', expense_type='OTHER').status_code, 400)

    def test_flows_into_pl_trial_balance_and_ledger(self):
        ind = self.add(name='Digital Marketing').data['id']
        dirc = self.add(name='Lab Fitting Charges', expense_type='DIRECT').data['id']
        self.pay(ind, 1200)
        self.pay(dirc, 300)

        pl = self.client.get('/api/financial/reports/profit-loss-statement/',
                             {'date_from': TODAY, 'date_to': TODAY}).json()
        found = {a['name']: (sec['key'], Decimal(a['amount']))
                 for sec in pl['sections'] for g in sec['groups'] for a in g['accounts']}
        self.assertEqual(found['Digital Marketing'], (INDIRECT_EXPENSE, Decimal('1200')))
        self.assertEqual(found['Lab Fitting Charges'], (DIRECT_EXPENSE, Decimal('300')))

        tb = self.client.get('/api/financial/reports/trial-balance/').data
        self.assertTrue(tb['balanced'])
        self.assertIn('Digital Marketing', [r.get('name') or r.get('account_name') for r in tb['rows']])

        led = self.client.get(f'/api/financial/accounts/{ind}/ledger/')
        self.assertEqual(led.status_code, 200, led.content)

    def test_category_with_postings_cannot_be_deleted(self):
        acc_id = self.add(name='Electricity Bill').data['id']
        self.pay(acc_id, 500)
        res = self.client.delete(f'/api/financial/accounts/{acc_id}/')
        self.assertEqual(res.status_code, 400)
        self.assertFalse(ChartOfAccount.all_objects.get(pk=acc_id).is_deleted)

    def test_unused_category_soft_deletes_and_name_stays_reserved(self):
        acc_id = self.add(name='Misc Petty').data['id']
        self.assertEqual(self.client.delete(f'/api/financial/accounts/{acc_id}/').status_code, 200)
        self.assertTrue(ChartOfAccount.all_objects.get(pk=acc_id).is_deleted)
        self.assertEqual(self.add(name='Misc Petty').status_code, 400)

    def test_read_only_role_cannot_add(self):
        self.client.force_authenticate(make_user('MANAGER'))
        self.assertEqual(self.add(name='Sneaky').status_code, 403)
