"""Financial API: permissions, manual vouchers, and statements that reconcile with the ledger."""
from decimal import Decimal

from rest_framework.test import APITestCase

from apps.financial.models import JournalEntry, FiscalPeriod, FinancialAuditLog
from apps.financial.services import create_journal

from .helpers import D, TODAY, account, balance, make_user


class PermissionTests(APITestCase):
    def test_anonymous_and_non_finance_roles_are_refused(self):
        self.assertIn(self.client.get('/api/financial/accounts/').status_code, (401, 403))
        self.client.force_authenticate(make_user('CASHIER'))
        self.assertEqual(self.client.get('/api/financial/accounts/').status_code, 403)

    def test_manager_can_view_but_not_post(self):
        self.client.force_authenticate(make_user('MANAGER'))
        self.assertEqual(self.client.get('/api/financial/reports/trial-balance/').status_code, 200)
        res = self.client.post('/api/financial/journals/', {
            'voucher_type_code': 'JV', 'date': TODAY.isoformat(),
            'lines': [{'account': '5100', 'debit': 10}, {'account': '1001', 'credit': 10}]}, format='json')
        self.assertEqual(res.status_code, 403)


class VoucherApiTests(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))

    def post_voucher(self, **kw):
        body = {'voucher_type_code': 'PV', 'date': TODAY.isoformat(), 'narration': 'Shop rent',
                'lines': [{'account': account('5100').pk.hex, 'debit': '15000'}, {'account': '1002', 'credit': '15000'}]}
        body.update(kw)
        return self.client.post('/api/financial/journals/', body, format='json')

    def test_payment_voucher_posts_and_repeat_request_is_idempotent(self):
        first = self.post_voucher(idempotency_key='pv-form-1')
        self.assertEqual(first.status_code, 201, first.content)
        again = self.post_voucher(idempotency_key='pv-form-1')
        self.assertEqual(again.data['id'], first.data['id'])
        self.assertEqual(JournalEntry.objects.count(), 1)
        self.assertEqual(balance('5100'), D('15000'))
        self.assertTrue(FinancialAuditLog.objects.filter(action='VOUCHER_CREATED').exists())

    def test_unbalanced_or_rule_breaking_voucher_is_refused(self):
        res = self.post_voucher(lines=[{'account': '5100', 'debit': '100'}, {'account': '1002', 'credit': '90'}])
        self.assertEqual(res.status_code, 400)
        res = self.post_voucher(lines=[{'account': '5100', 'debit': '100'}, {'account': '2001', 'credit': '100'}])
        self.assertEqual(res.status_code, 400)  # PV must credit cash/bank
        self.assertFalse(JournalEntry.objects.exists())

    def test_draft_stays_off_the_books_until_posted(self):
        res = self.post_voucher(status='DRAFT')
        self.assertEqual(res.data['status'], 'DRAFT')
        self.assertEqual(balance('5100'), 0)
        tb = self.client.get('/api/financial/reports/trial-balance/').data
        self.assertEqual(tb['rows'], [])
        posted = self.client.post(f"/api/financial/journals/{res.data['id']}/post/")
        self.assertEqual(posted.data['status'], 'POSTED')
        self.assertEqual(balance('5100'), D('15000'))

    def test_posted_journal_cannot_be_edited_or_deleted_only_reversed(self):
        jid = self.post_voucher().data['id']
        self.assertEqual(self.client.patch(f'/api/financial/journals/{jid}/', {}, format='json').status_code, 400)
        self.assertEqual(self.client.delete(f'/api/financial/journals/{jid}/').status_code, 400)
        res = self.client.post(f'/api/financial/journals/{jid}/reverse/', {'reason': 'wrong account'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(balance('5100'), 0)

    def test_closed_period_refuses_vouchers(self):
        FiscalPeriod.objects.create(name='FY', start_date=TODAY, end_date=TODAY, status='CLOSED')
        res = self.post_voucher()
        self.assertEqual(res.status_code, 400)
        self.assertIn('closed', res.data['error'])

    def test_system_account_cannot_be_deleted_or_deactivated(self):
        acc = account('1001')
        self.assertEqual(self.client.delete(f'/api/financial/accounts/{acc.pk}/').status_code, 400)
        res = self.client.patch(f'/api/financial/accounts/{acc.pk}/', {'status': 'Inactive'}, format='json')
        self.assertEqual(res.status_code, 400)


class StatementTests(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('SUPER_ADMIN'))
        create_journal(lines=[{'account': '1002', 'debit': 50000}, {'account': '3001', 'credit': 50000}])   # capital
        create_journal(lines=[{'account': '1003', 'debit': 20000}, {'account': '2001', 'credit': 20000}])   # stock on credit
        create_journal(lines=[{'account': '1001', 'debit': 11800}, {'account': '4001', 'credit': 10000},
                              {'account': '2020', 'credit': 1800}])                                          # cash sale
        create_journal(lines=[{'account': '5001', 'debit': 6000}, {'account': '1003', 'credit': 6000}])     # COGS
        create_journal(lines=[{'account': '5100', 'debit': 1500}, {'account': '1001', 'credit': 1500}])     # rent

    def test_trial_balance_agrees(self):
        tb = self.client.get('/api/financial/reports/trial-balance/').data
        self.assertTrue(tb['balanced'])
        self.assertEqual(tb['total_debit'], tb['total_credit'])

    def test_profit_and_loss_and_balance_sheet_reconcile_with_the_ledger(self):
        pl = self.client.get('/api/financial/reports/profit-loss/').data
        self.assertEqual(Decimal(pl['net_profit']), D('2500'))  # 10000 − 6000 − 1500
        bs = self.client.get('/api/financial/reports/balance-sheet/').data
        self.assertTrue(bs['balanced'], bs)
        self.assertEqual(Decimal(bs['retained_earnings']), D('2500'))
        self.assertEqual(Decimal(bs['total_assets']), D('74300'))  # 50000 + 14000 stock + 10300 cash

    def test_general_ledger_running_balance_and_period_opening(self):
        acc = account('1001')
        gl = self.client.get(f'/api/financial/accounts/{acc.pk}/ledger/').data
        self.assertEqual([l['balance'] for l in gl['lines']], ['11800.00', '10300.00'])
        self.assertEqual(gl['closing_balance'], '10300.00')

    def test_coa_with_balances_and_integration_status(self):
        rows = self.client.get('/api/financial/accounts/?with_balances=1&search=cash').data
        self.assertEqual({r['code']: r['ledger_balance'] for r in rows}['1001'], '10300.00')
        status = self.client.get('/api/financial/integration/status/').data
        self.assertTrue(status['ledger_balanced'])
        self.assertEqual(status['unmapped_roles'], [])
        rec = self.client.get('/api/financial/integration/reconciliation/').data
        self.assertTrue(rec['trial_balance']['balanced'])
