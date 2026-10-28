"""Ledger register: every posted document (retail + services, wholesale, purchase) is listed
once, with the bill reference the Ledger's "Show Bill" opens and the accounts it posted to."""
from rest_framework.test import APITestCase

from apps.purchasing.models import PurchaseInvoice, Supplier
from apps.sales.models import Dealer, Invoice, InvoiceItem, WholesaleInvoice

from .helpers import D, TODAY, make_user


class LedgerRegisterTests(APITestCase):
    def setUp(self):
        self.client.force_authenticate(make_user('ACCOUNTANT'))
        with self.captureOnCommitCallbacks(execute=True):
            self.retail = Invoice.objects.create(invoice_number='INV-1', invoice_date=TODAY, customer_name='Asha',
                                                 total_amount=D('300'), net_amount=D('300'))
            InvoiceItem.objects.create(invoice=self.retail, item_type='SERVICE', description='Eye test', quantity=1,
                                       unit_price=D('300'), subtotal=D('300'))
            self.retail.save()
            dealer = Dealer.objects.create(dealer_code='DL-1', business_name='Metro Optical', phone='1')
            self.wholesale = WholesaleInvoice.objects.create(
                invoice_number='W-1', dealer=dealer, invoice_date=TODAY, due_date=TODAY, grand_total=D('1180'),
                details={'summary': {'subtotal': 1000, 'totalGst': 180, 'grandTotal': 1180}})
            supplier = Supplier.objects.create(name='Essilor', supplier_code='SUP-1')
            self.purchase = PurchaseInvoice.objects.create(
                invoice_number='PE-1', supplier=supplier, purchase_date=TODAY, purchase_type='CREDIT',
                payment_method='CREDIT', grand_total=D('500'))

    def register(self, **params):
        res = self.client.get('/api/financial/reports/ledger-register/', params)
        self.assertEqual(res.status_code, 200, res.content)
        return res.data

    def test_lists_every_source_with_bill_reference_and_accounts(self):
        data = self.register()
        by_number = {r['source_number']: r for r in data['rows']}
        self.assertEqual(set(by_number), {'INV-1', 'W-1', 'PE-1'})
        self.assertEqual(data['count'], 3)
        inv = by_number['INV-1']
        self.assertEqual((inv['source_module'], inv['source_event']), ('sales', 'invoice'))
        self.assertEqual(inv['reference_id'], str(self.retail.pk))
        self.assertTrue(inv['has_service'])
        self.assertTrue(inv['debit_accounts'] and inv['credit_accounts'])
        self.assertEqual(by_number['W-1']['reference_id'], str(self.wholesale.pk))
        self.assertFalse(by_number['W-1']['has_service'])
        self.assertEqual(by_number['PE-1']['reference_id'], str(self.purchase.pk))

    def test_source_service_and_search_filters(self):
        rows = self.register(source='sales.wholesale_invoice,purchasing.purchase_invoice')['rows']
        self.assertEqual({r['source_number'] for r in rows}, {'W-1', 'PE-1'})
        rows = self.register(services='1')['rows']
        self.assertEqual([r['source_number'] for r in rows], ['INV-1'])
        rows = self.register(search='PE-1')['rows']
        self.assertEqual([r['source_number'] for r in rows], ['PE-1'])
        self.assertEqual(self.register(source='manual')['rows'], [])
