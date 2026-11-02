"""Accounts → Reports: Expense Report, Customer / Supplier Outstanding, Accounts Activity."""
import datetime

from rest_framework.test import APITestCase

from apps.financial.models import ChartOfAccount
from apps.financial.services import reverse_entry
from apps.purchasing.models import PurchaseInvoice, Supplier
from apps.sales.models import Customer, Dealer, Invoice, Payment, WholesaleInvoice

from .helpers import D, TODAY, make_user

API = '/api/financial/reports'
JAN5, JAN10, JAN20 = datetime.date(2026, 1, 5), datetime.date(2026, 1, 10), datetime.date(2026, 1, 20)


def acc(code):
    return ChartOfAccount.objects.get(code=code)


class ReportBase(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))

    def get(self, path, expect=200, **params):
        res = self.client.get(f'{API}/{path}/', params)
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def journal(self, code, lines, date=JAN5, narration='', party='', reference=''):
        res = self.client.post('/api/financial/journals/', {
            'voucher_type_code': code, 'date': date, 'narration': narration, 'reference_no': party,
            'reference': reference,
            'lines': [{'account': str(acc(c).pk), 'debit': dr, 'credit': cr, 'memo': m} for c, dr, cr, m in lines]},
            format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def expense(self, code, amount, date=JAN5, pay='1001', narration='Expense', party=''):
        return self.journal('PV', [(code, amount, '0', narration), (pay, '0', amount, 'Cash' if pay == '1001' else 'Bank')],
                            date=date, narration=narration, party=party)


class ExpenseReportTests(ReportBase):
    def test_categorised_by_direct_and_indirect_with_pay_mode(self):
        self.expense('5100', '1000', narration='Shop rent', party='Landlord')
        self.expense('5120', '250', date=JAN10, pay='1002', narration='KSEB bill')
        self.expense('5060', '80', narration='Broken frame')
        # A journal on a non-expense account is not an expense.
        self.journal('PV', [('2001', '500', '0', 'Supplier'), ('1001', '0', '500', 'Cash')])

        data = self.get('expenses', date_from=JAN5, date_to=JAN20)
        s = data['summary']
        self.assertEqual((s['total'], s['direct'], s['indirect'], s['lines']), ('1330.00', '80.00', '1250.00', 3))
        indirect = next(c for c in s['categories'] if c['key'] == 'INDIRECT_EXPENSE')
        self.assertEqual([a['code'] for g in indirect['groups'] for a in g['accounts']], ['5100', '5120'])
        rent = next(r for r in data['rows'] if r['account_code'] == '5100')
        self.assertEqual((rent['party'], rent['paid_via'], rent['amount']), ('Landlord', ['Cash'], '1000.00'))
        self.assertEqual(next(r for r in data['rows'] if r['account_code'] == '5120')['paid_via'], ['Bank'])

        self.assertEqual(self.get('expenses', date_from=JAN5, date_to=JAN20, bucket='DIRECT_EXPENSE')['summary']['total'], '80.00')
        self.assertEqual([r['account_code'] for r in self.get('expenses', date_from=JAN5, date_to=JAN20, search='kseb')['rows']], ['5120'])
        self.assertEqual(self.get('expenses', date_from=JAN10, date_to=JAN10)['summary']['total'], '250.00')

    def test_reversal_nets_to_zero_like_the_pl(self):
        saved = self.expense('5100', '1000')
        reverse_entry(saved['id'], reason='Wrong')
        data = self.get('expenses', date_from=JAN5, date_to=JAN20)
        self.assertEqual(data['summary']['total'], '0.00')
        self.assertEqual(sorted(r['amount'] for r in data['rows']), ['-1000.00', '1000.00'])
        pl = self.get('profit-loss-statement', date_from=JAN5, date_to=JAN20)
        self.assertEqual(pl['summary']['total_expenses'], data['summary']['total'])

    def test_bad_inputs(self):
        self.get('expenses', expect=400, date_from=JAN10, date_to=JAN5)
        self.get('expenses', expect=400, date_from=JAN5, date_to=JAN10, bucket='NOPE')


class OutstandingReportTests(ReportBase):
    def setUp(self):
        super().setUp()
        self.old = TODAY - datetime.timedelta(days=45)
        with self.captureOnCommitCallbacks(execute=True):
            self.asha = Customer.objects.create(name='Asha Menon', phone='9847012345', place='Kochi')
            self.ravi = Customer.objects.create(name='Ravi', phone='9000000000')
            self.inv1 = Invoice.objects.create(invoice_number='INV-1', invoice_date=self.old, customer=self.asha,
                                               customer_name='Asha Menon', total_amount=D('1000'),
                                               net_amount=D('1000'), paid_amount=D('200'), status='PARTIAL')
            Payment.objects.create(invoice=self.inv1, customer=self.asha, customer_name='Asha Menon', amount=D('200'),
                                   method='Cash', payment_date=self.old)
            Invoice.objects.create(invoice_number='INV-2', invoice_date=TODAY, customer=self.ravi, customer_name='Ravi',
                                   total_amount=D('300'), net_amount=D('300'))
            Invoice.objects.create(invoice_number='INV-3', invoice_date=TODAY, customer=self.ravi, customer_name='Ravi',
                                   net_amount=D('300'), paid_amount=D('300'), status='PAID')
            dealer = Dealer.objects.create(dealer_code='DL-1', business_name='Metro Optics', phone='3')
            WholesaleInvoice.objects.create(invoice_number='W-1', dealer=dealer, invoice_date=self.old,
                                            due_date=TODAY - datetime.timedelta(days=100), grand_total=D('700'),
                                            status='Unpaid')
            self.sup = Supplier.objects.create(name='Essilor India', supplier_code='SUP-1', phone='8')
            PurchaseInvoice.objects.create(invoice_number='PE-1', supplier=self.sup, purchase_date=self.old,
                                           due_date=TODAY + datetime.timedelta(days=10), purchase_type='CREDIT',
                                           payment_method='CASH', paid_amount=D('400'), grand_total=D('1000'))

    def test_customer_outstanding_per_party_with_aging_and_last_payment(self):
        data = self.get('customer-outstanding')
        s = data['summary']
        self.assertEqual((s['parties'], s['bills'], s['due']), (3, 3, '1800.00'))
        self.assertEqual(s['aging'], {'current': '300.00', 'd31_60': '800.00', 'd61_90': '0.00', 'd90_plus': '700.00'})
        rows = {r['name']: r for r in data['rows']}
        asha = rows['Asha Menon']
        self.assertEqual((asha['due'], asha['overdue'], asha['collection_status']), ('800.00', '800.00', 'Overdue'))
        self.assertEqual((asha['last_payment_date'], asha['last_payment_amount']), (self.old.isoformat(), '200.00'))
        self.assertEqual(asha['bills'][0]['status'], 'Partly paid')
        self.assertEqual(rows['Metro Optics']['collection_status'], 'Critical')
        self.assertEqual(rows['Ravi']['collection_status'], 'Current')
        # Largest due first; filters.
        self.assertEqual(data['rows'][0]['name'], 'Asha Menon')
        self.assertEqual([r['name'] for r in self.get('customer-outstanding', kind='dealer')['rows']], ['Metro Optics'])
        self.assertEqual([r['name'] for r in self.get('customer-outstanding', search='INV-2')['rows']], ['Ravi'])
        self.assertEqual({r['name'] for r in self.get('customer-outstanding', overdue=1)['rows']}, {'Asha Menon', 'Metro Optics'})
        self.assertEqual([r['name'] for r in self.get('customer-outstanding', aging='d90_plus')['rows']], ['Metro Optics'])

    def test_receipt_voucher_settlement_reflects_immediately(self):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post('/api/financial/settlements/receipt/', {
                'party_kind': 'customer', 'party': str(self.asha.pk), 'date': str(TODAY), 'idempotency_key': 'k1',
                'allocations': [{'bill': str(self.inv1.pk), 'amount': '800'}],
                'payments': [{'method': 'Cash', 'amount': '800'}]}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        names = [r['name'] for r in self.get('customer-outstanding')['rows']]
        self.assertNotIn('Asha Menon', names)

    def test_supplier_outstanding_and_ledger_cross_check(self):
        data = self.get('supplier-outstanding')
        row, = data['rows']
        self.assertEqual((row['name'], row['due'], row['paid'], row['overdue']), ('Essilor India', '600.00', '400.00', '0.00'))
        self.assertEqual(row['bills'][0]['aging'], 'current')  # aged from its due date, not yet due
        self.assertEqual(data['ledger']['bills_total'], '600.00')
        self.assertIn('difference', data['ledger'])


class AccountsActivityTests(ReportBase):
    def test_register_lists_vouchers_and_reversals(self):
        rent = self.expense('5100', '1000', party='Landlord')
        self.journal('RV', [('1001', '300', '0', 'Cash'), ('4001', '0', '300', 'Misc')], date=JAN10, narration='Scrap sale')
        reversal = reverse_entry(rent['id'], reason='Typo')

        data = self.get('accounts-activity', date_from=JAN5, date_to=JAN20)
        s = data['summary']
        self.assertEqual((s['entries'], s['reversals'], s['balanced']), (3, 1, True))
        by_no = {r['voucher_no']: r for r in data['rows']}
        self.assertEqual(by_no[rent['entry_number']]['reversed_by'], reversal.entry_number)
        self.assertEqual(by_no[reversal.entry_number]['reverses'], rent['entry_number'])
        self.assertEqual(by_no[rent['entry_number']]['party'], 'Landlord')
        self.assertEqual(len(self.get('accounts-activity', date_from=JAN5, date_to=JAN20, voucher_type='RV')['rows']), 1)
        self.assertEqual(len(self.get('accounts-activity', date_from=JAN5, date_to=JAN20, search='scrap')['rows']), 1)
        self.assertEqual(len(self.get('accounts-activity', date_from=JAN5, date_to=JAN20, status='REVERSED')['rows']), 1)

    def test_account_summary_opening_movement_closing(self):
        self.expense('5100', '1000', date=JAN5)
        self.expense('5100', '200', date=JAN10)
        data = self.get('accounts-activity', view='accounts', date_from=JAN10, date_to=JAN20)
        rows = {r['code']: r for r in data['rows']}
        self.assertEqual((rows['5100']['opening'], rows['5100']['debit'], rows['5100']['closing']),
                         ('1000.00', '200.00', '1200.00'))
        self.assertEqual((rows['1001']['opening'], rows['1001']['credit'], rows['1001']['closing']),
                         ('-1000.00', '200.00', '-1200.00'))
        s = data['summary']
        self.assertEqual(s['total_debit'], s['total_credit'])
