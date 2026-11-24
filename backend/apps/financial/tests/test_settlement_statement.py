"""Bill-to-Bill settlement records, on-account advances, the Settlement Statement, the party
ledger, the backfill migration and the bill_settlement feature switch."""
import importlib

from django.apps import apps as django_apps

from apps.financial.models import BillAllocation, BillSettlement, Cheque, JournalEntry
from apps.purchasing.models import PurchaseInvoice, Supplier
from apps.sales.models import Customer, Dealer, Invoice, Payment, WholesaleInvoice, WholesalePaymentCollection

from .helpers import D, TODAY, balance, ledger_is_balanced
from .test_payment_banks import make_bank
from .test_settlements import API, SettlementApiBase


class CustomerSettlementRecordTests(SettlementApiBase):
    """The spec's example: four bills 1,500 + 1,000 + 500 + 2,000; the customer pays 3,000
    (2,000 by cheque + 1,000 cash). Oldest-first allocation closes the first three."""

    def setUp(self):
        super().setUp()
        self.bank = make_bank()
        with self.captureOnCommitCallbacks(execute=True):
            self.cust = Customer.objects.create(name='Fathima K', phone='9847000001', patient_code='P-2001')
            self.invs = [
                Invoice.objects.create(invoice_number=f'INV-F{i}', invoice_date=TODAY, customer=self.cust,
                                       customer_name='Fathima K', total_amount=D(a), net_amount=D(a))
                for i, a in enumerate(('1500', '1000', '500', '2000'), start=1)]

    def receipt(self, allocations, payments, key='f-1', on_account=None):
        body = {'party_kind': 'customer', 'party': str(self.cust.pk), 'date': str(TODAY), 'idempotency_key': key,
                'allocations': [{'bill': str(b.pk), 'amount': a} for b, a in allocations], 'payments': payments}
        if on_account is not None:
            body['on_account'] = on_account
        return self.post('receipt', body)

    def cheque_and_cash(self):
        return [
            {'method': 'Cheque', 'amount': '2000', 'bank_account': str(self.bank.pk), 'ref_no': '458921',
             'cheque': {'cheque_number': '458921', 'cheque_date': str(TODAY), 'bank_name': 'Federal Bank'}},
            {'method': 'Cash', 'amount': '1000'},
        ]

    def test_fifo_settlement_is_recorded_with_due_before_and_after(self):
        b1, b2, b3, b4 = self.invs
        res = self.receipt([(b1, '1500'), (b2, '1000'), (b3, '500')], self.cheque_and_cash())
        self.assertEqual(res.status_code, 201, res.data)
        number = res.data['number']

        s = BillSettlement.objects.get(number=number)
        self.assertEqual((s.voucher_type, s.party_kind, s.party_code), ('RV', 'customer', 'P-2001'))
        self.assertEqual((s.total_amount, s.allocated_amount, s.on_account_amount), (D('3000'), D('3000'), D('0')))
        self.assertEqual([(p['method'], p['amount'], p['cheque_number']) for p in s.payments],
                         [('Cheque', '2000.00', '458921'), ('Cash', '1000.00', '')])
        rows = list(s.allocations.all())
        self.assertEqual([(a.bill_number, a.previous_due, a.allocated_amount, a.new_due, a.settlement_status) for a in rows],
                         [('INV-F1', D('1500'), D('1500'), D('0'), 'CLOSED'),
                          ('INV-F2', D('1000'), D('1000'), D('0'), 'CLOSED'),
                          ('INV-F3', D('500'), D('500'), D('0'), 'CLOSED')])
        self.assertTrue(all(a.receipt_numbers for a in rows))
        # Bill 4 stays open in full.
        self.assertEqual([(b['number'], D(b['due'])) for b in self.bills('customer', self.cust)['bills']],
                         [('INV-F4', D('2000'))])
        self.assertEqual(Cheque.objects.get().cheque_number, '458921')
        self.assertTrue(ledger_is_balanced())

        # Statement list
        st = self.client.get(f'{API}/statement/', {'voucher': 'RV'}).data
        self.assertEqual(len(st['results']), 1)
        row = st['results'][0]
        self.assertEqual((row['number'], row['status'], row['bills_closed'], row['bills_partial']), (number, 'POSTED', 3, 0))
        self.assertIn('Cheque #458921', row['payments'][0]['detail'])
        self.assertEqual(D(st['summary']['total']), D('3000'))
        self.assertEqual({k: D(v) for k, v in st['summary']['by_mode'].items()}, {'Cheque': D('2000'), 'Cash': D('1000')})

        # Breakdown by number, by one receipt's number, and by a receipt's journal.
        for params in ({'number': number}, {'number': f'{number}/2'}):
            d = self.client.get(f'{API}/voucher/', params)
            self.assertEqual(d.status_code, 200, d.data)
            self.assertEqual(d.data['number'], number)
            self.assertEqual([D(b['current_due']) for b in d.data['bills']], [D('0')] * 3)
            self.assertEqual(D(d.data['party_outstanding']), D('2000'))
        pay = Payment.objects.filter(receipt_no__startswith=f'{number}/').first()
        journal = JournalEntry.objects.get(source_module='sales', source_event='payment', reference_id=pay.pk)
        self.assertEqual(self.client.get(f'{API}/voucher/', {'journal': journal.entry_number}).data['number'], number)
        self.assertEqual(self.client.get(f'{API}/voucher/', {'number': 'NOPE-1'}).status_code, 400)

    def test_partial_allocation_leaves_the_exact_balance_open(self):
        res = self.receipt([(self.invs[3], '700')], [{'method': 'Cash', 'amount': '700'}])
        self.assertEqual(res.status_code, 201, res.data)
        a = BillAllocation.objects.get()
        self.assertEqual((a.previous_due, a.new_due, a.settlement_status), (D('2000'), D('1300'), 'PARTIAL'))

    def test_excess_kept_on_account_books_a_customer_advance(self):
        res = self.receipt([(self.invs[0], '1500')], [{'method': 'Cash', 'amount': '2000'}], on_account='500')
        self.assertEqual(res.status_code, 201, res.data)
        advance = Payment.objects.get(invoice__isnull=True)
        self.assertEqual((advance.amount, advance.customer_id), (D('500'), self.cust.pk))
        self.assertEqual(balance('2030'), D('500'))   # Customer Advances
        self.assertEqual(balance('1001'), D('2000'))
        self.assertTrue(ledger_is_balanced())
        s = BillSettlement.objects.get()
        self.assertEqual((s.total_amount, s.allocated_amount, s.on_account_amount), (D('2000'), D('1500'), D('500')))

    def test_on_account_only_and_mismatch(self):
        res = self.receipt([], [{'method': 'Cash', 'amount': '300'}], on_account='300')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(BillSettlement.objects.get().allocations.count(), 0)
        bad = self.receipt([(self.invs[0], '100')], [{'method': 'Cash', 'amount': '300'}], key='f-2', on_account='100')
        self.assertEqual(bad.status_code, 400)
        self.assertIn('on account', str(bad.data))
        none = self.receipt([], [{'method': 'Cash', 'amount': '300'}], key='f-3')
        self.assertEqual(none.status_code, 400)

    def test_deleting_the_receipts_shows_the_settlement_reversed(self):
        res = self.receipt([(self.invs[0], '1500')], [{'method': 'Cash', 'amount': '1500'}])
        Payment.objects.filter(receipt_no__startswith=f"{res.data['number']}/").update(status='Cancelled')
        row = self.client.get(f'{API}/statement/').data['results'][0]
        self.assertEqual(row['status'], 'REVERSED')
        self.assertEqual(self.client.get(f'{API}/statement/').data['summary']['vouchers'], 0)

    def test_party_ledger_running_balance_and_mapping(self):
        b1, b2, *_ = self.invs
        self.receipt([(b1, '1500'), (b2, '400')], [{'method': 'Cash', 'amount': '1900'}])
        res = self.client.get(f'{API}/party-ledger/', {'party_kind': 'customer', 'party': str(self.cust.pk)})
        self.assertEqual(res.status_code, 200, res.data)
        data = res.data
        self.assertEqual(D(data['total_billed']), D('5000'))
        self.assertEqual(D(data['total_paid']), D('1900'))
        self.assertEqual(D(data['closing_balance']), D('3100'))
        self.assertEqual(D(data['outstanding_bills']), D('3100'))
        bill1 = next(r for r in data['rows'] if r['number'] == 'INV-F1')
        self.assertEqual([D(x['amount']) for x in bill1['settled_by']], [D('1500')])
        receipt = next(r for r in data['rows'] if r['type'] == 'RECEIPT')
        self.assertEqual([x['bill_number'] for x in receipt['settles']], ['INV-F1', 'INV-F2'])
        self.assertTrue(receipt['settlement'].startswith('BR-'))
        xlsx = self.client.get(f'{API}/party-ledger/', {'party_kind': 'customer', 'party': str(self.cust.pk), 'export': 'xlsx'})
        self.assertEqual(xlsx.status_code, 200)
        self.assertIn('spreadsheetml', xlsx['Content-Type'])
        self.assertIn('spreadsheetml', self.client.get(f'{API}/statement/', {'export': 'xlsx'})['Content-Type'])


class DealerOnAccountTests(SettlementApiBase):
    def test_dealer_excess_is_an_on_account_collection(self):
        with self.captureOnCommitCallbacks(execute=True):
            dealer = Dealer.objects.create(dealer_code='DL-OA', business_name='Vision Hub', outstanding_balance=D('1000'))
            w1 = WholesaleInvoice.objects.create(invoice_number='W-OA1', dealer=dealer, invoice_date=TODAY, due_date=TODAY,
                                                 grand_total=D('1000'), paid_amount=D('0'), due_amount=D('1000'))
        res = self.post('receipt', {'party_kind': 'dealer', 'party': str(dealer.pk), 'date': str(TODAY),
                                    'idempotency_key': 'oa-1', 'allocations': [{'bill': str(w1.pk), 'amount': '1000'}],
                                    'on_account': '250', 'payments': [{'method': 'Cash', 'amount': '1250'}]})
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(sorted(WholesalePaymentCollection.objects.values_list('invoice_number', 'amount_paid')),
                         sorted([('W-OA1', D('1000')), ('', D('250'))]))
        dealer.refresh_from_db()
        self.assertEqual(dealer.outstanding_balance, D('-250'))
        self.assertTrue(ledger_is_balanced())
        a = BillSettlement.objects.get().allocations.get()
        self.assertEqual((a.bill_number, a.settlement_status), ('W-OA1', 'CLOSED'))


class SupplierSettlementTests(SettlementApiBase):
    def setUp(self):
        super().setUp()
        from apps.purchasing.supplier_utils import get_or_create_supplier_ledger_account
        with self.captureOnCommitCallbacks(execute=True):
            self.sup = Supplier.objects.create(name='Hoya Lens', supplier_code='SUP-88', outstanding_balance=D('1000'))
            self.sup.ledger_account = get_or_create_supplier_ledger_account(self.sup)
            self.sup.save()
            self.pe = PurchaseInvoice.objects.create(invoice_number='PE-H1', supplier=self.sup, purchase_date=TODAY,
                                                     purchase_type='CREDIT', payment_method='CREDIT', grand_total=D('1000'),
                                                     supplier_invoice_number='HOYA-55')
        self.ap = self.sup.ledger_account.code

    def test_payment_with_advance_and_reversal(self):
        res = self.post('payment', {'party_kind': 'supplier', 'party': str(self.sup.pk), 'date': str(TODAY),
                                    'idempotency_key': 'h-1', 'allocations': [{'bill': str(self.pe.pk), 'amount': '600'}],
                                    'on_account': '200', 'payments': [{'method': 'Cash', 'amount': '800'}]})
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(balance(self.ap), D('200'))   # 1000 - 600 - 200 advance
        self.assertEqual([(b['number'], D(b['due'])) for b in self.bills('supplier', self.sup)['bills']],
                         [('PE-H1', D('400'))])
        s = BillSettlement.objects.get(voucher_type='PV')
        self.assertEqual((s.number, str(s.journal_entry_id)), (res.data['entry_number'], str(res.data['id'])))
        a = s.allocations.get()
        self.assertEqual((a.bill_ref, a.previous_due, a.new_due, a.settlement_status), ('HOYA-55', D('1000'), D('400'), 'PARTIAL'))
        self.assertEqual(self.client.get(f'{API}/voucher/', {'journal': res.data['entry_number']}).data['number'], s.number)
        ledger = self.client.get(f'{API}/party-ledger/', {'party_kind': 'supplier', 'party': str(self.sup.pk)}).data
        self.assertEqual(D(ledger['closing_balance']), D('200'))
        self.assertEqual(D(ledger['outstanding_bills']), D('400'))   # the advance is not against a bill

        rev = self.client.post(f"/api/financial/journals/{res.data['id']}/reverse/", {'reason': 'wrong'}, format='json')
        self.assertEqual(rev.status_code, 200, rev.data)
        s.refresh_from_db()
        self.assertEqual(s.status, 'REVERSED')
        self.sup.refresh_from_db()
        self.assertEqual(self.sup.outstanding_balance, D('1000'))
        self.assertEqual(balance(self.ap), D('1000'))
        st = self.client.get(f'{API}/statement/', {'voucher': 'PV', 'status': 'REVERSED'}).data
        self.assertEqual([r['number'] for r in st['results']], [s.number])


class BackfillTests(SettlementApiBase):
    def test_older_vouchers_are_rebuilt_once(self):
        with self.captureOnCommitCallbacks(execute=True):
            cust = Customer.objects.create(name='Old Receipt', patient_code='P-3001')
            inv = Invoice.objects.create(invoice_number='INV-OLD', invoice_date=TODAY, customer=cust,
                                         customer_name='Old Receipt', net_amount=D('900'), paid_amount=D('900'))
            Payment.objects.create(receipt_no='BR-2025-00007/1', invoice=inv, customer=cust, amount=D('600'),
                                   method='Cash', payment_date=TODAY, status='Completed')
            Payment.objects.create(receipt_no='BR-2025-00007/2', invoice=inv, customer=cust, amount=D('300'),
                                   method='UPI', payment_date=TODAY, status='Completed')
        mod = importlib.import_module('apps.financial.migrations.0014_backfill_bill_settlements')
        mod.backfill(django_apps, None)
        mod.backfill(django_apps, None)   # idempotent
        s = BillSettlement.objects.get(number='BR-2025-00007')
        self.assertEqual((s.origin, s.party_code, s.total_amount), ('backfill', 'P-3001', D('900')))
        a = s.allocations.get()
        self.assertEqual((a.bill_number, a.allocated_amount, a.receipt_numbers),
                         ('INV-OLD', D('900'), ['BR-2025-00007/1', 'BR-2025-00007/2']))


class FeatureSwitchTests(SettlementApiBase):
    def test_switching_bill_settlement_off_blocks_its_endpoints_only(self):
        from apps.common import hot_cache, module_access, tenancy
        from apps.common.models import Tenant
        config = module_access.tenant_access_config(tenancy.DEFAULT_TENANT_ID)
        self.assertIn('bill_settlement', module_access.enabled_module_features(config))   # on by default
        self.assertIn('bill_settlement', module_access.enabled_module_features(
            {'modules': ['accounts'], 'module_features': {}}))
        self.assertNotIn('bill_settlement', module_access.enabled_module_features(
            {'modules': ['sales'], 'module_features': {}}))

        Tenant.objects.filter(pk=tenancy.DEFAULT_TENANT_ID).update(module_features={'bill_settlement': False})
        try:
            hot_cache.clear()
        except Exception:
            pass
        self.assertNotIn('bill_settlement', module_access.enabled_module_features(
            module_access.tenant_access_config(tenancy.DEFAULT_TENANT_ID)))
        cust = Customer.objects.create(name='Gate Test')
        self.assertEqual(self.client.get(f'{API}/statement/').status_code, 403)
        res = self.post('receipt', {'party_kind': 'customer', 'party': str(cust.pk), 'date': str(TODAY),
                                    'idempotency_key': 'g-1', 'on_account': '10', 'payments': [{'method': 'Cash', 'amount': '10'}]})
        self.assertEqual(res.status_code, 403)
        # The party / due-bill lookups stay open (the Bank Book's pending settlements use them).
        self.assertEqual(self.client.get(f'{API}/parties/', {'voucher': 'RV'}).status_code, 200)
