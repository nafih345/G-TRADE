"""A wholesale invoice's full POS record (lines, summary, delivery) round-trips through the DB.

The Wholesale POS used to keep line items only in the browser's localStorage, so a reprint,
report or dealer history from another machine had nothing to show. `details` now carries the
whole record, and the list can be narrowed to one dealer for its order history.
"""
from rest_framework.test import APITestCase

from apps.sales.models import Dealer


class WholesaleInvoiceDetailsTests(APITestCase):
    url = '/api/sales/wholesale/invoices/'

    def setUp(self):
        self.dealer = Dealer.objects.create(dealer_code='DL-T1', business_name='Test Optics', phone='9999999999')
        self.other = Dealer.objects.create(dealer_code='DL-T2', business_name='Other Optics', phone='8888888888')

    def _post(self, number, dealer, **extra):
        body = {
            'invoice_number': number, 'dealer': str(dealer.id), 'invoice_date': '2026-10-06',
            'due_date': '2026-11-05', 'grand_total': 1180, 'paid_amount': 180, 'due_amount': 1000,
            'status': 'Partial',
        }
        body.update(extra)
        res = self.client.post(self.url, body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def test_details_round_trip_and_update(self):
        details = {
            'items': [{'id': 'p1', 'name': 'Frame A', 'qty': 2, 'rate': 500, 'gst': 18}],
            'summary': {'subtotal': 1000, 'totalGst': 180, 'grandTotal': 1180},
            'delivery': {'mode': 'Courier'},
        }
        created = self._post('WINV-100001', self.dealer, details=details)
        self.assertEqual(created['details'], details)

        res = self.client.patch(f"{self.url}{created['id']}/", {
            'status': 'Cancelled', 'details': {**details, 'orderStatus': 'Cancelled'},
        }, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        fetched = self.client.get(f"{self.url}{created['id']}/").data
        self.assertEqual(fetched['status'], 'Cancelled')
        self.assertEqual(fetched['details']['orderStatus'], 'Cancelled')
        self.assertEqual(fetched['details']['items'][0]['name'], 'Frame A')

    def test_details_defaults_to_empty(self):
        self.assertEqual(self._post('WINV-100002', self.dealer)['details'], {})

    def test_duplicate_invoice_number_is_rejected(self):
        self._post('WINV-100003', self.dealer)
        res = self.client.post(self.url, {
            'invoice_number': 'WINV-100003', 'dealer': str(self.dealer.id), 'invoice_date': '2026-10-06',
            'due_date': '2026-10-06', 'grand_total': 1,
        }, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('invoice_number', res.data)

    def test_filter_by_dealer_and_number(self):
        self._post('WINV-200001', self.dealer)
        self._post('WINV-200002', self.other)
        rows = self.client.get(self.url, {'dealer': str(self.dealer.id)}).data['results']
        self.assertEqual([r['invoice_number'] for r in rows], ['WINV-200001'])
        rows = self.client.get(self.url, {'invoice_number': 'WINV-200002'}).data['results']
        self.assertEqual(len(rows), 1)
