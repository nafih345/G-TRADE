"""Wholesale Dealers / Customers master: separate shipping address + the directory roll-up.

`directory` lists every dealer with billed business and what it still owes, worked out from the
invoices themselves (drafts and cancelled bills excluded, paid amounts and credit notes netted).
"""
from rest_framework.test import APITestCase

from apps.sales.models import Dealer, WholesaleInvoice, WholesaleReturn


class DealerDirectoryTests(APITestCase):
    url = '/api/sales/wholesale/dealers/'

    def setUp(self):
        self.dealer = Dealer.objects.create(dealer_code='DL-D1', business_name='Alpha Optics', phone='9000000001')
        self.idle = Dealer.objects.create(dealer_code='DL-D2', business_name='Beta Optics', phone='9000000002')

    def _invoice(self, number, total, paid, status='Partial', day='2026-11-01'):
        return WholesaleInvoice.objects.create(
            invoice_number=number, dealer=self.dealer, invoice_date=day, due_date=day,
            grand_total=total, paid_amount=paid, due_amount=total - paid, status=status)

    def test_shipping_address_is_stored_separately(self):
        res = self.client.post(self.url, {
            'dealer_code': 'DL-D3', 'business_name': 'Gamma Optics', 'phone': '9000000003',
            'address': '1 Billing Road', 'shipping_address': '9 Warehouse Lane',
        }, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data['address'], '1 Billing Road')
        self.assertEqual(res.data['shipping_address'], '9 Warehouse Lane')
        # Rows from before the column read blank (= ship to the billing address).
        self.assertEqual(self.client.get(f'{self.url}{self.idle.id}/').data['shipping_address'], '')

    def test_unused_dealer_can_be_deleted(self):
        res = self.client.delete(f'{self.url}{self.idle.id}/')
        self.assertEqual(res.status_code, 204, res.content)
        codes = [r['dealer_code'] for r in self.client.get(f'{self.url}directory/').data]
        self.assertNotIn('DL-D2', codes)

    def test_dealer_with_transactions_cannot_be_deleted(self):
        self._invoice('WINV-900010', 500, 0, status='Draft')  # even a draft points at the dealer
        res = self.client.delete(f'{self.url}{self.dealer.id}/')
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn('Inactive', str(res.data['detail']))
        self.assertTrue(Dealer.objects.filter(pk=self.dealer.pk).exists())

    def test_directory_rolls_up_business_and_bills_due(self):
        self._invoice('WINV-900001', 1000, 400, day='2026-10-01')
        self._invoice('WINV-900002', 500, 500, status='Paid', day='2026-11-02')
        self._invoice('WINV-900003', 700, 0, status='Draft')        # never billed
        self._invoice('WINV-900004', 300, 0, status='Cancelled')    # reversed
        WholesaleReturn.objects.create(return_number='WRET-1', invoice_number='WINV-900001', dealer=self.dealer,
                                       return_date='2026-10-05', return_amount=100, action_taken='Credit Note Issued')

        res = self.client.get(f'{self.url}directory/')
        self.assertEqual(res.status_code, 200, res.content)
        rows = {r['dealer_code']: r for r in res.data}
        alpha = rows['DL-D1']
        self.assertEqual(alpha['invoice_count'], 2)
        self.assertEqual(float(alpha['total_business']), 1500.0)
        self.assertEqual(str(alpha['last_invoice_date']), '2026-11-02')
        self.assertEqual(float(alpha['bills_due']), 500.0)   # 1000 − 400 paid − 100 credit note
        self.assertEqual(alpha['open_bill_count'], 1)

        beta = rows['DL-D2']
        self.assertEqual(beta['invoice_count'], 0)
        self.assertEqual(float(beta['bills_due']), 0.0)
        self.assertIsNone(beta['last_invoice_date'])
