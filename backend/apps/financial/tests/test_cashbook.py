"""Cashbook: only posted movements on cash accounts, in the right direction, with balances that
reconcile (closing = opening + cash in - cash out) under every account / branch / date filter."""
import datetime

from rest_framework.test import APITestCase

from apps.company.models import Branch, BusinessSettings, UserBranchAccess
from apps.financial.models import AccountGroup, ChartOfAccount, JournalEntry
from apps.financial.services import create_journal, reverse_entry
from apps.purchasing.models import PurchaseInvoice, Supplier
from apps.sales.models import Invoice, Payment

from .helpers import D, TODAY, make_user, make_warehouse

URL = '/api/financial/reports/cashbook/'
JAN1, JAN5, JAN10, JAN20 = (datetime.date(2026, 1, d) for d in (1, 5, 10, 20))
FEB1, FEB10 = datetime.date(2026, 2, 1), datetime.date(2026, 2, 10)


def acc(code):
    return ChartOfAccount.objects.get(code=code)


def post(code, dr, cr, amount, date, **kw):
    """Two-line journal: Dr `dr` / Cr `cr` for `amount`."""
    return create_journal(lines=[{'account': dr, 'debit': amount}, {'account': cr, 'credit': amount}],
                          date=date, voucher_type_code=code, source_module='financial', source_event='voucher', **kw)


class CashbookBase(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))
        self.cash = acc('1001')
        self.petty = ChartOfAccount.objects.create(code='1010', name='Petty Cash', account_subtype='CASH',
                                                   account_group=AccountGroup.objects.get(name='Cash Accounts'))
        self.bank = acc('1002')

    def book(self, **params):
        params.setdefault('account', str(self.cash.pk))
        res = self.client.get(URL, params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.data

    def opening(self, amount=D('50000'), date=JAN1, account=None):
        return create_journal(lines=[{'account': account or self.cash, 'debit': amount},
                                     {'account': acc('3001'), 'credit': amount}],
                              date=date, voucher_type_code='OB', source_module='financial',
                              source_event='opening_balance', reference_type='OPENING_BALANCE')

    def assertReconciles(self, data):
        s = data['summary']
        self.assertEqual(D(s['closing_balance']),
                         D(s['opening_balance']) + D(s['total_cash_in']) - D(s['total_cash_out']))


class CashbookBalanceTests(CashbookBase):
    def test_opening_balance_with_no_transactions(self):
        self.opening()
        data = self.book(date_from=FEB1, date_to=FEB10)
        self.assertEqual(data['rows'], [])
        self.assertEqual(data['summary']['opening_balance'], '50000.00')
        self.assertEqual(data['summary']['closing_balance'], '50000.00')
        # An account with no history at all is simply zero.
        empty = self.book(account=str(self.petty.pk))
        self.assertEqual((empty['rows'], empty['summary']['closing_balance']), ([], '0.00'))

    def test_opening_balance_row_inside_the_range(self):
        self.opening()
        row, = self.book(date_from=JAN1)['rows']
        self.assertEqual((row['voucher_kind'], row['cash_in'], row['cash_out']), ('OPENING', '50000.00', None))

    def test_reference_example_closing_balance(self):
        self.opening()
        for amount, day in ((D('60000'), JAN5), (D('36150'), JAN10)):
            post('RV', self.cash, acc('1004'), amount, day)
        for amount, day in ((D('40000'), JAN10), (D('8100'), JAN20)):
            post('PV', acc('2001'), self.cash, amount, day)
        data = self.book(date_from=JAN5, date_to=JAN20)
        s = data['summary']
        self.assertEqual((s['opening_balance'], s['total_cash_in'], s['total_cash_out'], s['closing_balance']),
                         ('50000.00', '96150.00', '48100.00', '98050.00'))
        self.assertEqual([r['balance'] for r in data['rows']], ['110000.00', '146150.00', '106150.00', '98050.00'])
        self.assertReconciles(data)

    def test_running_balance_carries_across_pages(self):
        self.opening(D('1000'))
        for i in range(5):
            post('RV', self.cash, acc('1004'), D('100'), JAN5 + datetime.timedelta(days=i))
        page2 = self.book(date_from=JAN5, page=2, page_size=2)
        self.assertEqual((page2['count'], page2['num_pages'], page2['page']), (5, 3, 2))
        self.assertEqual([r['balance'] for r in page2['rows']], ['1300.00', '1400.00'])
        self.assertEqual([r['row_no'] for r in page2['rows']], [3, 4])
        self.assertEqual(page2['summary']['closing_balance'], '1500.00')

    def test_chronological_with_entry_number_tie_break(self):
        a = post('RV', self.cash, acc('1004'), D('1'), JAN10)
        b = post('RV', self.cash, acc('1004'), D('2'), JAN5)
        c = post('RV', self.cash, acc('1004'), D('3'), JAN10)
        numbers = [r['entry_number'] for r in self.book()['rows']]
        self.assertEqual(numbers, [b.entry_number, a.entry_number, c.entry_number])

    def test_decimal_amounts_total_exactly(self):
        for amount in ('0.10', '0.20', '1234567.89'):
            post('RV', self.cash, acc('1004'), D(amount), JAN5)
        post('PV', acc('5130'), self.cash, D('0.30'), JAN5)
        s = self.book()['summary']
        self.assertEqual((s['total_cash_in'], s['total_cash_out'], s['closing_balance']),
                         ('1234568.19', '0.30', '1234567.89'))


class CashbookVoucherTypeTests(CashbookBase):
    def test_cash_sale_and_later_receipt(self):
        with self.captureOnCommitCallbacks(execute=True):
            inv = Invoice.objects.create(invoice_number='INV-1', invoice_date=JAN5, customer_name='Asha',
                                         total_amount=D('1000'), net_amount=D('1000'))
            Payment.objects.create(invoice=inv, amount=D('600'), method='Cash', payment_date=JAN5)
            Payment.objects.create(invoice=inv, amount=D('400'), method='Cash', payment_date=JAN10)
        rows = self.book()['rows']
        self.assertEqual([(r['voucher_kind'], r['cash_in']) for r in rows],
                         [('CASH_SALE', '600.00'), ('RECEIPT', '400.00')])
        self.assertTrue(all(r['source_event'] == 'payment' and r['reference_id'] for r in rows))

    def test_cash_receipt_payment_and_petty_cash(self):
        post('RV', self.cash, acc('1004'), D('500'), JAN5)
        post('PV', acc('2001'), self.cash, D('200'), JAN5)
        post('PV', acc('5120'), self.cash, D('50'), JAN5)
        rows = self.book()['rows']
        self.assertEqual([(r['voucher_kind'], r['cash_in'], r['cash_out']) for r in rows],
                         [('RECEIPT', '500.00', None), ('PAYMENT', None, '200.00'), ('PETTY_CASH', None, '50.00')])
        self.assertEqual(rows[2]['particulars'], 'Electricity & Utilities')
        self.assertEqual(rows[2]['balance'], '250.00')

    def test_cash_purchase_payment_decreases_cash(self):
        from apps.purchasing.supplier_utils import get_or_create_supplier_ledger_account
        supplier = Supplier.objects.create(name='Essilor', supplier_code='SUP-1')
        supplier.ledger_account = get_or_create_supplier_ledger_account(supplier)
        supplier.save()
        with self.captureOnCommitCallbacks(execute=True):
            PurchaseInvoice.objects.create(invoice_number='PE-1', supplier=supplier, purchase_date=TODAY,
                                           purchase_type='CASH', payment_method='CASH', payment_status='PAID',
                                           paid_amount=D('1000'), tax_amount=D('0'), grand_total=D('1000'))
            # Purchases auto-post only from the go-live date, hence TODAY. A credit purchase never touches cash.
            PurchaseInvoice.objects.create(invoice_number='PE-2', supplier=supplier, purchase_date=TODAY,
                                           purchase_type='CREDIT', payment_method='CREDIT', grand_total=D('700'))
        row, = self.book()['rows']
        self.assertEqual((row['voucher_kind'], row['cash_out'], row['source_number']), ('PAYMENT', '1000.00', 'PE-1'))

    def test_deposit_and_withdrawal_directions(self):
        self.opening(D('5000'))
        post('CV', self.bank, self.cash, D('3000'), JAN5)   # cash taken to the bank
        post('CV', self.cash, self.bank, D('1000'), JAN10)  # cash drawn from the bank
        rows = self.book(date_from=JAN5)['rows']
        self.assertEqual([(r['voucher_kind'], r['cash_in'], r['cash_out'], r['balance']) for r in rows],
                         [('DEPOSIT', None, '3000.00', '2000.00'), ('WITHDRAWAL', '1000.00', None, '3000.00')])

    def test_transfer_between_two_cash_accounts(self):
        post('CV', self.petty, self.cash, D('750'), JAN5)
        main, = self.book()['rows']
        petty, = self.book(account=str(self.petty.pk))['rows']
        self.assertEqual((main['voucher_kind'], main['cash_out']), ('TRANSFER', '750.00'))
        self.assertEqual((petty['voucher_kind'], petty['cash_in']), ('TRANSFER', '750.00'))
        # Across all cash accounts the money never left cash: no row, no double count.
        combined = self.book(account='all')
        self.assertEqual(combined['rows'], [])
        self.assertEqual(combined['summary']['total_cash_in'], '0.00')


class CashbookScopeTests(CashbookBase):
    def test_excludes_credit_and_bank_only_transactions(self):
        with self.captureOnCommitCallbacks(execute=True):
            inv = Invoice.objects.create(invoice_number='INV-C', invoice_date=JAN5, customer_name='Ravi',
                                         total_amount=D('900'), net_amount=D('900'))  # credit sale, unpaid
            Payment.objects.create(invoice=inv, amount=D('300'), method='UPI', payment_date=JAN5)  # bank side
        post('PV', acc('2001'), self.bank, D('100'), JAN5)
        self.assertTrue(JournalEntry.objects.filter(source_number='INV-C').exists())
        data = self.book()
        self.assertEqual(data['rows'], [])
        self.assertEqual(data['summary']['closing_balance'], '0.00')

    def test_excludes_drafts_and_hides_reversed_pairs(self):
        post('RV', self.cash, acc('1004'), D('100'), JAN5, status='DRAFT')
        keep = post('RV', self.cash, acc('1004'), D('250'), JAN5)
        voided = post('RV', self.cash, acc('1004'), D('999'), JAN5)
        reverse_entry(voided, reason='Wrong amount')
        data = self.book()
        self.assertEqual([r['entry_number'] for r in data['rows']], [keep.entry_number])
        self.assertEqual(data['summary']['hidden_reversals'], 2)
        self.assertEqual(data['summary']['total_cash_in'], '250.00')
        shown = self.book(show_reversed=1)
        self.assertEqual(len(shown['rows']), 3)
        self.assertEqual(shown['summary']['closing_balance'], '250.00')
        self.assertReconciles(shown)

    def test_reversal_straddling_the_range_keeps_balances_right(self):
        voided = post('RV', self.cash, acc('1004'), D('400'), JAN5)
        reverse_entry(voided, date=JAN20, reason='Bounced')
        data = self.book(date_from=JAN10)
        self.assertEqual(data['summary']['opening_balance'], '400.00')
        row, = data['rows']
        self.assertTrue(row['is_reversal'])
        self.assertEqual((row['cash_out'], row['balance']), ('400.00', '0.00'))
        self.assertReconciles(data)

    def test_one_row_per_voucher_even_with_several_cash_lines(self):
        create_journal(lines=[{'account': self.cash, 'debit': D('100'), 'memo': 'Cash'},
                              {'account': self.cash, 'debit': D('50'), 'memo': 'Cash'},
                              {'account': acc('4001'), 'credit': D('150')}],
                       date=JAN5, voucher_type_code='JV', source_module='financial', source_event='voucher')
        rows = self.book(search='Retail')['rows']  # matches through a joined line: still one row
        self.assertEqual([(r['cash_in'], r['cash_out']) for r in rows], [('150.00', None)])

    def test_search_narrows_rows_but_not_the_summary(self):
        post('RV', self.cash, acc('1004'), D('100'), JAN5, source_number='RCPT-77', narration='From Asha')
        post('RV', self.cash, acc('1004'), D('200'), JAN10, narration='From Ravi')
        data = self.book(search='rcpt-77')
        self.assertEqual([r['source_number'] for r in data['rows']], ['RCPT-77'])
        self.assertEqual(data['matched'], {'count': 1, 'cash_in': '100.00', 'cash_out': '0.00'})
        self.assertEqual(data['summary']['closing_balance'], '300.00')
        self.assertEqual([r['description'] for r in self.book(search='ravi')['rows']], ['From Ravi'])
        self.assertEqual(self.book(search='nothing-like-this')['rows'], [])

    def test_date_range_filter(self):
        post('RV', self.cash, acc('1004'), D('10'), JAN5)
        post('RV', self.cash, acc('1004'), D('20'), JAN10)
        post('RV', self.cash, acc('1004'), D('40'), JAN20)
        data = self.book(date_from=JAN10, date_to=JAN10)
        self.assertEqual([r['cash_in'] for r in data['rows']], ['20.00'])
        self.assertEqual((data['summary']['opening_balance'], data['summary']['closing_balance']), ('10.00', '30.00'))

    def test_export_returns_every_row(self):
        for i in range(3):
            post('RV', self.cash, acc('1004'), D('5'), JAN5)
        data = self.book(page_size=1, export=1)
        self.assertEqual(len(data['rows']), 3)
        self.assertFalse(data['truncated'])

    def test_account_list_and_default(self):
        res = self.client.get(URL + 'accounts/')
        self.assertEqual(res.status_code, 200)
        codes = {a['code']: a for a in res.data['accounts']}
        self.assertIn('1001', codes)
        self.assertIn('1010', codes)
        self.assertNotIn('1002', codes)
        self.assertTrue(codes['1001']['is_default'])
        self.assertEqual(self.book(account='')['accounts'][0]['code'], '1001')


class CashbookValidationTests(CashbookBase):
    def test_invalid_requests(self):
        cases = [
            {'account': str(self.cash.pk), 'date_from': '2026-02-01', 'date_to': '2026-01-01'},
            {'account': str(self.cash.pk), 'date_from': 'not-a-date'},
            {'account': str(self.bank.pk)},
            {'account': 'nope'},
            {'account': '00000000-0000-0000-0000-000000000000'},
        ]
        for params in cases:
            res = self.client.get(URL, params)
            self.assertEqual(res.status_code, 400, params)
            self.assertIn('error', res.data)

    def test_requires_a_finance_role(self):
        self.client.force_authenticate(make_user('SALES_EXECUTIVE', username='seller'))
        self.assertEqual(self.client.get(URL).status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(URL).status_code, (401, 403))


class CashbookBranchTests(CashbookBase):
    def setUp(self):
        super().setUp()
        self.main = make_warehouse().branch
        self.north = Branch.objects.create(company=self.main.company, name='North', code='NTH')
        settings_obj = BusinessSettings.load()
        settings_obj.multi_branch_enabled = True
        settings_obj.save()
        self.opening(D('1000'))  # no branch: head-office opening
        post('RV', self.cash, acc('1004'), D('100'), JAN5, branch=self.main)
        post('RV', self.cash, acc('1004'), D('30'), JAN10, branch=self.north)

    def test_branch_filter_scopes_rows_and_opening(self):
        data = self.book(branch=str(self.north.pk))
        self.assertEqual([(r['branch_name'], r['cash_in']) for r in data['rows']], [('North', '30.00')])
        self.assertEqual(data['branch']['label'], 'North')
        self.assertEqual(self.book(branch=str(self.main.pk), date_from=JAN10)['summary']['opening_balance'], '100.00')
        self.assertEqual(self.book()['summary']['closing_balance'], '1130.00')

    def test_restricted_user_only_sees_their_branches(self):
        access = UserBranchAccess.objects.create(username='nina')
        access.branches.add(self.north)
        headers = {'HTTP_X_USER_NAME': 'nina', 'HTTP_X_USER_ROLE': 'ACCOUNTANT'}
        res = self.client.get(URL, {'account': str(self.cash.pk), 'branch': str(self.main.pk)}, **headers)
        self.assertEqual(res.status_code, 403)
        res = self.client.get(URL, {'account': str(self.cash.pk), 'branch': 'all'}, **headers)
        self.assertEqual(res.status_code, 200)
        self.assertEqual([r['cash_in'] for r in res.data['rows']], ['30.00'])
        self.assertEqual(res.data['summary']['closing_balance'], '30.00')

    def test_unknown_branch_is_rejected(self):
        res = self.client.get(URL, {'account': str(self.cash.pk), 'branch': 'garbage'})
        self.assertEqual(res.status_code, 400)
