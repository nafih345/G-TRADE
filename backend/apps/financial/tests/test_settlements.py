"""Receipt / Payment Voucher "Bill to Bill": party search, due bills, allocation and posting."""
from rest_framework.test import APITestCase

from apps.financial.models import JournalEntry
from apps.purchasing.models import PurchaseInvoice, Supplier
from apps.sales.models import (
    Customer, Dealer, Invoice, Payment, WholesaleInvoice, WholesalePaymentCollection, WholesaleReturn,
)

from .helpers import D, TODAY, balance, ledger_is_balanced, make_user
from .test_payment_banks import make_bank

API = '/api/financial/settlements'


class SettlementApiBase(APITestCase):
    def setUp(self):
        self.user = make_user('ACCOUNTANT')
        self.client.force_authenticate(self.user)

    def post(self, path, body):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(f'{API}/{path}/', body, format='json')

    def bills(self, kind, party):
        return self.client.get(f'{API}/due-bills/', {'party_kind': kind, 'party': str(party.pk)}).data


class CustomerReceiptTests(SettlementApiBase):
    def setUp(self):
        super().setUp()
        with self.captureOnCommitCallbacks(execute=True):
            self.asha = Customer.objects.create(name='Asha Menon', phone='9847012345', place='Kochi')
            self.other = Customer.objects.create(name='Ravi', phone='9000000000')
            self.inv1 = Invoice.objects.create(invoice_number='INV-S1', invoice_date=TODAY, customer=self.asha,
                                               customer_name='Asha Menon', total_amount=D('1000'),
                                               net_amount=D('1000'), paid_amount=D('200'), status='PARTIAL')
            self.inv2 = Invoice.objects.create(invoice_number='INV-S2', invoice_date=TODAY, customer=self.asha,
                                               customer_name='Asha Menon', total_amount=D('500'), net_amount=D('500'))
            # Not eligible: fully paid, an order, cancelled, another customer's.
            Invoice.objects.create(invoice_number='INV-S3', invoice_date=TODAY, customer=self.asha, customer_name='Asha',
                                   net_amount=D('300'), paid_amount=D('300'), status='PAID')
            Invoice.objects.create(invoice_number='ORD-S4', invoice_date=TODAY, customer=self.asha, customer_name='Asha',
                                   net_amount=D('300'), document_type='ORDER')
            Invoice.objects.create(invoice_number='INV-S5', invoice_date=TODAY, customer=self.asha, customer_name='Asha',
                                   net_amount=D('300'), status='CANCELLED')
            Invoice.objects.create(invoice_number='INV-S6', invoice_date=TODAY, customer=self.other, customer_name='Ravi',
                                   net_amount=D('700'))

    def receipt(self, allocations, payments, key='k-1'):
        return self.post('receipt', {
            'party_kind': 'customer', 'party': str(self.asha.pk), 'date': str(TODAY), 'idempotency_key': key,
            'allocations': [{'bill': str(b.pk), 'amount': a} for b, a in allocations],
            'payments': payments,
        })

    def test_party_search_by_name_mobile_and_area_with_outstanding(self):
        for term in ('asha', 'ASHA', '98470', 'koch'):
            res = self.client.get(f'{API}/parties/', {'voucher': 'RV', 'search': term})
            self.assertEqual(res.status_code, 200)
            rows = [r for r in res.data['results'] if r['kind'] == 'customer']
            self.assertEqual([r['name'] for r in rows], ['Asha Menon'], term)
            self.assertEqual(D(rows[0]['outstanding']), D('1300'))
            self.assertEqual(rows[0]['open_bills'], 2)
            self.assertNotIn('address', rows[0])

    def test_due_bills_lists_only_eligible_invoices(self):
        data = self.bills('customer', self.asha)
        self.assertEqual([b['number'] for b in data['bills']], ['INV-S1', 'INV-S2'])
        self.assertEqual([D(b['due']) for b in data['bills']], [D('800'), D('500')])
        self.assertEqual(data['bills'][0]['account_code'], '1004')
        self.assertEqual(D(data['total_due']), D('1300'))

    def test_partial_receipt_across_bills_and_split_modes(self):
        bank = make_bank()
        res = self.receipt([(self.inv1, '800'), (self.inv2, '200')], [
            {'method': 'Cash', 'amount': '600'},
            {'method': 'Bank Transfer', 'amount': '400', 'bank_account': str(bank.pk), 'ref_no': 'UTR77'},
        ])
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(D(res.data['total']), D('1000'))
        # Each receipt is booked by the engine as its own Receipt Voucher.
        receipts = Payment.objects.filter(receipt_no__startswith=res.data['number'])
        self.assertEqual(JournalEntry.objects.filter(source_module='sales', source_event='payment', status='POSTED',
                                                     reference_id__in=receipts.values('pk')).count(), 3)
        # Cash 600 -> INV-S1; bank 200 -> INV-S1, 200 -> INV-S2.
        self.assertEqual(Payment.objects.filter(receipt_no__startswith=res.data['number']).count(), 3)
        self.inv1.refresh_from_db(); self.inv2.refresh_from_db()
        self.assertEqual((self.inv1.paid_amount, self.inv1.status), (D('1000'), 'PAID'))
        self.assertEqual((self.inv2.paid_amount, self.inv2.status), (D('200'), 'PARTIAL'))
        self.assertEqual(balance('1001'), D('600'))
        self.assertEqual(balance('100201'), D('400'))
        self.assertTrue(ledger_is_balanced())
        # Remaining balance after the allocation.
        data = self.bills('customer', self.asha)
        self.assertEqual([(b['number'], D(b['due'])) for b in data['bills']], [('INV-S2', D('300'))])

    def test_repeated_submit_posts_once(self):
        first = self.receipt([(self.inv2, '500')], [{'method': 'Cash', 'amount': '500'}], key='dup')
        again = self.receipt([(self.inv2, '500')], [{'method': 'Cash', 'amount': '500'}], key='dup')
        self.assertEqual(first.status_code, 201)
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.data['duplicate'])
        self.assertEqual(again.data['number'], first.data['number'])
        self.assertEqual(Payment.objects.filter(invoice=self.inv2).count(), 1)
        self.assertEqual(balance('1001'), D('500'))

    def test_over_allocation_is_refused(self):
        res = self.receipt([(self.inv2, '501')], [{'method': 'Cash', 'amount': '501'}])
        self.assertEqual(res.status_code, 400)
        self.assertIn('more than its due', res.data['error'])
        self.assertFalse(Payment.objects.exists())

    def test_totals_must_reconcile(self):
        res = self.receipt([(self.inv2, '300')], [{'method': 'Cash', 'amount': '250'}])
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Payment.objects.exists())

    def test_duplicate_bill_and_foreign_bill_are_refused(self):
        res = self.receipt([(self.inv2, '100'), (self.inv2, '100')], [{'method': 'Cash', 'amount': '200'}])
        self.assertEqual(res.status_code, 400)
        foreign = Invoice.objects.get(invoice_number='INV-S6')
        res = self.receipt([(foreign, '100')], [{'method': 'Cash', 'amount': '100'}], key='k-2')
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Payment.objects.exists())

    def test_finance_role_required(self):
        self.client.force_authenticate(make_user('MANAGER', 'mgr'))   # view only
        self.assertEqual(self.client.get(f'{API}/parties/', {'voucher': 'RV'}).status_code, 200)
        res = self.receipt([(self.inv2, '100')], [{'method': 'Cash', 'amount': '100'}])
        self.assertEqual(res.status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.get(f'{API}/parties/', {'voucher': 'RV'}).status_code, (401, 403))


class DealerReceiptTests(SettlementApiBase):
    def test_dealer_bills_net_of_credit_notes_and_settlement(self):
        with self.captureOnCommitCallbacks(execute=True):
            dealer = Dealer.objects.create(dealer_code='DL-MA', business_name='MIRACLE AQUA', phone='9446000000',
                                           city='Thrissur', outstanding_balance=D('1500'))
            w1 = WholesaleInvoice.objects.create(invoice_number='W-1', dealer=dealer, invoice_date=TODAY, due_date=TODAY,
                                                 grand_total=D('1000'), paid_amount=D('0'), due_amount=D('1000'),
                                                 status='Partial')
            WholesaleInvoice.objects.create(invoice_number='W-2', dealer=dealer, invoice_date=TODAY, due_date=TODAY,
                                            grand_total=D('700'), paid_amount=D('200'), status='Partial')
            WholesaleInvoice.objects.create(invoice_number='W-3', dealer=dealer, invoice_date=TODAY, due_date=TODAY,
                                            grand_total=D('400'), status='Cancelled')
            WholesaleReturn.objects.create(return_number='CN-1', invoice_number='W-1', dealer=dealer, return_date=TODAY,
                                           return_amount=D('100'), action_taken='Credit Note Issued')
        res = self.client.get(f'{API}/parties/', {'voucher': 'RV', 'search': 'miracle'})
        self.assertEqual([r['name'] for r in res.data['results']], ['MIRACLE AQUA'])
        bills = self.bills('dealer', dealer)['bills']
        self.assertEqual([(b['number'], D(b['due'])) for b in bills], [('W-1', D('900')), ('W-2', D('500'))])

        res = self.post('receipt', {'party_kind': 'dealer', 'party': str(dealer.pk), 'date': str(TODAY),
                                    'idempotency_key': 'w-1', 'allocations': [{'bill': str(w1.pk), 'amount': '400'}],
                                    'payments': [{'method': 'Cash', 'amount': '400'}]})
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(WholesalePaymentCollection.objects.get().invoice_number, 'W-1')
        w1.refresh_from_db(); dealer.refresh_from_db()
        self.assertEqual((w1.paid_amount, w1.due_amount), (D('400'), D('600')))
        self.assertEqual(dealer.outstanding_balance, D('1100'))
        self.assertEqual(D(self.bills('dealer', dealer)['bills'][0]['due']), D('500'))
        self.assertTrue(ledger_is_balanced())


class SupplierPaymentTests(SettlementApiBase):
    def setUp(self):
        super().setUp()
        from apps.purchasing.supplier_utils import get_or_create_supplier_ledger_account
        with self.captureOnCommitCallbacks(execute=True):
            self.sup = Supplier.objects.create(name='Essilor India', supplier_code='SUP-77', phone='8000011111',
                                               city='Chennai', outstanding_balance=D('1600'))
            self.sup.ledger_account = get_or_create_supplier_ledger_account(self.sup)
            self.sup.save()
            self.pe1 = PurchaseInvoice.objects.create(invoice_number='PE-1', supplier=self.sup, purchase_date=TODAY,
                                                      purchase_type='CREDIT', payment_method='CREDIT', grand_total=D('1000'))
            self.pe2 = PurchaseInvoice.objects.create(invoice_number='PE-2', supplier=self.sup, purchase_date=TODAY,
                                                      purchase_type='CREDIT', payment_method='CASH', paid_amount=D('400'),
                                                      grand_total=D('1000'))
            PurchaseInvoice.objects.create(invoice_number='PE-3', supplier=self.sup, purchase_date=TODAY,
                                           purchase_type='CASH', payment_method='CASH', payment_status='PAID',
                                           paid_amount=D('500'), grand_total=D('500'))
        self.ap = self.sup.ledger_account.code

    def pay(self, allocations, payments, key='p-1'):
        return self.post('payment', {
            'party_kind': 'supplier', 'party': str(self.sup.pk), 'date': str(TODAY), 'idempotency_key': key,
            'allocations': [{'bill': str(b.pk), 'amount': a} for b, a in allocations], 'payments': payments,
        })

    def test_due_bills_match_the_payable(self):
        bills = self.bills('supplier', self.sup)['bills']
        self.assertEqual([(b['number'], D(b['due'])) for b in bills], [('PE-1', D('1000')), ('PE-2', D('600'))])
        self.assertEqual(balance(self.ap), D('1600'))

    def test_partial_payment_voucher_settles_bills_and_reversal_reopens(self):
        res = self.pay([(self.pe1, '1000'), (self.pe2, '250')], [{'method': 'Cash', 'amount': '1250'}])
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(res.data['voucher_type_code'], 'PV')
        self.assertEqual(balance(self.ap), D('350'))
        self.assertEqual(balance('1001'), D('-2150'))   # 900 paid at entry (PE-2, PE-3) + 1250
        self.assertTrue(ledger_is_balanced())
        bills = self.bills('supplier', self.sup)['bills']
        self.assertEqual([(b['number'], D(b['due'])) for b in bills], [('PE-2', D('350'))])
        self.sup.refresh_from_db()
        self.assertEqual(self.sup.outstanding_balance, D('350'))

        again = self.pay([(self.pe1, '1000'), (self.pe2, '250')], [{'method': 'Cash', 'amount': '1250'}])
        self.assertEqual(again.status_code, 200)
        self.assertEqual(JournalEntry.objects.filter(voucher_type__code='PV', source_module='financial').count(), 1)

        rev = self.client.post(f"/api/financial/journals/{res.data['id']}/reverse/", {'reason': 'wrong'}, format='json')
        self.assertEqual(rev.status_code, 200, rev.data)
        self.assertEqual(len(self.bills('supplier', self.sup)['bills']), 2)
        self.sup.refresh_from_db()
        self.assertEqual(self.sup.outstanding_balance, D('1600'))
        self.assertEqual(balance(self.ap), D('1600'))

    def test_over_allocation_and_wrong_voucher_are_refused(self):
        self.assertEqual(self.pay([(self.pe2, '601')], [{'method': 'Cash', 'amount': '601'}]).status_code, 400)
        res = self.post('receipt', {'party_kind': 'supplier', 'party': str(self.sup.pk), 'date': str(TODAY),
                                    'idempotency_key': 'x', 'allocations': [{'bill': str(self.pe1.pk), 'amount': '1'}],
                                    'payments': [{'method': 'Cash', 'amount': '1'}]})
        self.assertEqual(res.status_code, 400)
        self.assertEqual(balance(self.ap), D('1600'))


class AccountSearchTests(SettlementApiBase):
    def test_search_by_code_name_group_and_parent(self):
        def codes(term):
            res = self.client.get('/api/financial/accounts/', {'search': term, 'page_size': 50})
            return {r['code'] for r in res.data['results']}
        self.assertIn('1001', codes('100'))
        self.assertIn('1001', codes('cash in'))
        self.assertIn('1002', codes('bank acc'))     # group "Bank Accounts"
        self.assertEqual(codes('zzzz-none'), set())


class DateRangeAndBatchTests(SettlementApiBase):
    def setUp(self):
        import datetime
        super().setUp()
        self.old = TODAY - datetime.timedelta(days=40)
        with self.captureOnCommitCallbacks(execute=True):
            self.asha = Customer.objects.create(name='Asha', phone='1')
            self.ravi = Customer.objects.create(name='Ravi', phone='2')
            self.dealer = Dealer.objects.create(dealer_code='DL-1', business_name='Metro Optics', phone='3')
            self.a_old = Invoice.objects.create(invoice_number='INV-OLD', invoice_date=self.old, customer=self.asha,
                                                customer_name='Asha', net_amount=D('300'))
            self.a_new = Invoice.objects.create(invoice_number='INV-NEW', invoice_date=TODAY, customer=self.asha,
                                                customer_name='Asha', net_amount=D('200'))
            self.r_old = Invoice.objects.create(invoice_number='INV-R', invoice_date=self.old, customer=self.ravi,
                                                customer_name='Ravi', net_amount=D('500'))
            self.w = WholesaleInvoice.objects.create(invoice_number='W-9', dealer=self.dealer, invoice_date=TODAY,
                                                     due_date=TODAY, grand_total=D('800'), status='Unpaid')

    def item(self, kind, party, bills, cash, key):
        return {'party_kind': kind, 'party': str(party.pk), 'date': str(TODAY), 'idempotency_key': key,
                'allocations': [{'bill': str(b.pk), 'amount': a} for b, a in bills],
                'payments': [{'method': 'Cash', 'amount': cash}]}

    def test_date_range_filters_parties_and_bills(self):
        res = self.client.get(f'{API}/parties/', {'voucher': 'RV', 'date_from': str(TODAY), 'date_to': str(TODAY)})
        rows = {r['name']: D(r['outstanding']) for r in res.data['results']}
        self.assertEqual(rows, {'Asha': D('200'), 'Metro Optics': D('800')})   # Ravi only has an old bill
        bills = self.client.get(f'{API}/due-bills/', {'party_kind': 'customer', 'party': str(self.asha.pk),
                                                      'date_to': str(self.old)}).data['bills']
        self.assertEqual([b['number'] for b in bills], ['INV-OLD'])
        bad = self.client.get(f'{API}/parties/', {'voucher': 'RV', 'date_from': 'yesterday'})
        self.assertEqual(bad.status_code, 400)

    def test_batch_receipt_settles_several_parties_in_one_go(self):
        res = self.post('batch/rv', {'settlements': [
            self.item('customer', self.asha, [(self.a_old, '300'), (self.a_new, '50')], '350', 'b-1:asha'),
            self.item('customer', self.ravi, [(self.r_old, '500')], '500', 'b-1:ravi'),
            self.item('dealer', self.dealer, [(self.w, '800')], '800', 'b-1:dealer'),
        ]})
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(len({r['number'] for r in res.data['results']}), 3)
        self.assertEqual(balance('1001'), D('1650'))
        self.assertTrue(ledger_is_balanced())
        self.a_new.refresh_from_db(); self.w.refresh_from_db()
        self.assertEqual(self.a_new.paid_amount, D('50'))
        self.assertEqual(self.w.due_amount, D('0'))
        again = self.post('batch/rv', {'settlements': [
            self.item('customer', self.asha, [(self.a_old, '300'), (self.a_new, '50')], '350', 'b-1:asha'),
            self.item('customer', self.ravi, [(self.r_old, '500')], '500', 'b-1:ravi'),
            self.item('dealer', self.dealer, [(self.w, '800')], '800', 'b-1:dealer'),
        ]})
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.data['duplicate'])
        self.assertEqual(balance('1001'), D('1650'))

    def test_batch_is_all_or_nothing(self):
        res = self.post('batch/rv', {'settlements': [
            self.item('customer', self.asha, [(self.a_new, '200')], '200', 'b-2:asha'),
            self.item('customer', self.ravi, [(self.r_old, '999')], '999', 'b-2:ravi'),   # above due
        ]})
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Payment.objects.exists())
        self.a_new.refresh_from_db()
        self.assertEqual(self.a_new.paid_amount, D('0'))
        self.assertEqual(balance('1001'), 0)

    def test_batch_refuses_repeated_party_and_wrong_voucher(self):
        res = self.post('batch/rv', {'settlements': [
            self.item('customer', self.asha, [(self.a_new, '100')], '100', 'k1'),
            self.item('customer', self.asha, [(self.a_old, '100')], '100', 'k2'),
        ]})
        self.assertEqual(res.status_code, 400)
        res = self.post('batch/pv', {'settlements': [self.item('customer', self.asha, [(self.a_new, '100')], '100', 'k3')]})
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Payment.objects.exists())
