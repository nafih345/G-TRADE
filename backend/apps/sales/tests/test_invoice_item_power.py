"""Prescribed power on a billing line survives the round trip to the database.

New Sale only fills `power` when an eye power was actually entered, and only for the eye(s)
prescribed for — the bill prints the line's power block exactly when this field is non-empty,
so a line with no prescription must come back empty rather than with a placeholder.
"""
from rest_framework.test import APITestCase

from apps.products.models import Product


class InvoiceItemPowerTests(APITestCase):
    url = '/api/sales/invoices/'

    def setUp(self):
        self.lens = Product.objects.create(name='Power Test Lens', sku='PWR-LNS-1', stock=10)

    def _post(self, items):
        res = self.client.post(self.url, {
            'document_type': 'INVOICE', 'invoice_date': '2026-09-30', 'status': 'PAID',
            'total_amount': 100, 'net_amount': 100, 'paid_amount': 100,
            'customer_name': 'Power Test Patient', 'items': items,
        }, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data['items']

    def _line(self, **extra):
        line = {'product': str(self.lens.id), 'item_type': 'PRODUCT', 'description': self.lens.name,
                'quantity': 1, 'unit_price': 100, 'tax_rate': 0, 'tax_amount': 0, 'subtotal': 100}
        line.update(extra)
        return line

    def test_power_is_stored_and_returned_for_each_prescribed_eye(self):
        right_only = 'RE: SPH -1.25 CYL -0.50 AXIS 180 [Idx: 1.56]'
        left_only = 'LE: SPH -2.00 [Idx: 1.56]'
        both = 'RE: SPH -1.25 | LE: SPH -2.00 [Idx: 1.56]'
        items = self._post([
            self._line(power=right_only), self._line(power=left_only), self._line(power=both),
        ])
        self.assertEqual([i['power'] for i in items], [right_only, left_only, both])

    def test_line_with_no_prescription_stores_no_power_text(self):
        # Both a missing key and an explicit blank — neither may become a placeholder.
        items = self._post([self._line(), self._line(power='')])
        self.assertEqual([i['power'] for i in items], ['', ''])
