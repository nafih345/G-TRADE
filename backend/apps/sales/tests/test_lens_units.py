"""Spectacle lenses sold as Both Eyes (1 Pair = 2 lenses) or Single Lens (1 Piece = 1 lens).

`quantity` on the line is the commercial quantity; stock moves by the lenses (physical quantity)
converted to the product's stock unit — pairs unless the product counts single lenses — and the
COGS journal costs exactly those stock units. Lines without a selling unit behave as before.
"""
from decimal import Decimal

from rest_framework.test import APITestCase

from apps.financial.posting_rules import build_sales_invoice
from apps.products.models import Product
from apps.sales.lens_units import ONE_EYE_MESSAGE
from apps.sales.models import Invoice

RX_BOTH = {'re': {'sph': '-2.50', 'cyl': '-0.75', 'axis': '90'}, 'le': {'sph': '-1.75', 'cyl': '-0.50', 'axis': '85'}}
RX_RIGHT = {'re': {'sph': '-2.50'}, 'le': {}}


class LensUnitTests(APITestCase):
    url = '/api/sales/invoices/'

    def setUp(self):
        self.pair_lens = Product.objects.create(
            name='Progressive Lens', sku='LU-PRG', category_name='Prescription Lenses', stock=10,
            cost_price=Decimal('800'), retail_price=Decimal('2000'))
        self.piece_lens = Product.objects.create(
            name='SV Lens (pcs)', sku='LU-SV', category_name='Prescription Lenses', stock=10,
            cost_price=Decimal('300'), retail_price=Decimal('1000'), extra_data={'lens_stock_unit': 'PIECE'})
        self.frame = Product.objects.create(name='LU Frame', sku='LU-FRM', stock=10, cost_price=Decimal('100'))

    def _lens(self, product, unit, qty, price, rx, eye=None):
        return {'product': str(product.id), 'item_type': 'LENS', 'description': product.name,
                'quantity': qty, 'unit_price': price, 'tax_rate': 0, 'tax_amount': 0, 'subtotal': qty * price,
                'selling_unit': unit, 'lens_eye': eye or ('BOTH' if unit == 'PAIR' else ''), 'pricing_unit': unit,
                'physical_quantity': 999,  # never trusted — the server recomputes it
                'lens_details': {'rx': rx}}

    def _frame(self, qty=1):
        return {'product': str(self.frame.id), 'item_type': 'PRODUCT', 'description': 'LU Frame',
                'quantity': qty, 'unit_price': 500, 'tax_rate': 0, 'tax_amount': 0, 'subtotal': qty * 500}

    def _post(self, items, doc_type='INVOICE', expect=201):
        total = sum(i['subtotal'] for i in items)
        res = self.client.post(self.url, {
            'document_type': doc_type, 'invoice_date': '2026-10-26', 'status': 'PAID' if doc_type != 'QUOTATION' else 'DRAFT',
            'total_amount': total, 'net_amount': total, 'paid_amount': 0, 'customer_name': 'Lens Patient',
            'items': items,
        }, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res

    def _stock(self, product):
        product.refresh_from_db()
        return product.stock

    def test_pair_sale_saves_units_and_deducts_one_pair(self):
        res = self._post([self._lens(self.pair_lens, 'PAIR', 1, 2000, RX_BOTH)])
        line = res.data['items'][0]
        self.assertEqual((line['selling_unit'], line['lens_eye'], line['quantity'], line['physical_quantity']),
                         ('PAIR', 'BOTH', 1, 2))
        self.assertEqual(line['lens_details']['rx']['re']['sph'], '-2.50')
        self.assertEqual(line['lens_details']['stock_unit'], 'PAIR')
        self.assertEqual(self._stock(self.pair_lens), 9)  # one pair, not two

    def test_pairs_against_piece_stock_take_two_lenses_each(self):
        self._post([self._lens(self.piece_lens, 'PAIR', 3, 1800, RX_BOTH)])
        self.assertEqual(self._stock(self.piece_lens), 4)  # 3 pairs = 6 lenses

    def test_single_lens_against_piece_stock_takes_one(self):
        res = self._post([self._lens(self.piece_lens, 'PIECE', 1, 1000, RX_RIGHT, eye='RE')])
        self.assertEqual(res.data['items'][0]['physical_quantity'], 1)
        self.assertEqual(self._stock(self.piece_lens), 9)

    def test_single_lenses_of_a_pair_stocked_lens_round_up_per_bill(self):
        # RE and LE singles of the same pair-counted lens = one pair; a lone single uses a whole pair.
        left = {'re': {}, 'le': {'sph': '-1.00'}}
        self._post([self._lens(self.pair_lens, 'PIECE', 1, 1000, RX_RIGHT, eye='RE'),
                    self._lens(self.pair_lens, 'PIECE', 1, 1000, left, eye='LE')])
        self.assertEqual(self._stock(self.pair_lens), 9)
        self._post([self._lens(self.pair_lens, 'PIECE', 1, 1000, RX_RIGHT, eye='RE')])
        self.assertEqual(self._stock(self.pair_lens), 8)

    def test_one_eye_on_a_pair_is_refused_and_nothing_is_saved(self):
        before = Invoice.objects.count()
        res = self._post([self._lens(self.pair_lens, 'PAIR', 1, 2000, RX_RIGHT)], expect=400)
        self.assertIn(ONE_EYE_MESSAGE, str(res.data))
        self.assertEqual(Invoice.objects.count(), before)
        self.assertEqual(self._stock(self.pair_lens), 10)

    def test_single_lens_needs_an_eye(self):
        res = self._post([self._lens(self.pair_lens, 'PIECE', 1, 1000, RX_RIGHT, eye='')], expect=400)
        self.assertIn('select the eye', str(res.data))

    def test_invalid_power_is_refused(self):
        bad = {'re': {'sph': '-2.30'}, 'le': {'sph': '-1.00', 'cyl': '-0.50'}}
        res = self._post([self._lens(self.pair_lens, 'PAIR', 1, 2000, bad)], expect=400)
        self.assertIn('0.25 steps', str(res.data))
        self.assertIn('AXIS is required', str(res.data))

    def test_quotation_may_be_incomplete_but_cannot_be_converted_until_complete(self):
        res = self._post([self._lens(self.pair_lens, 'PAIR', 1, 2000, RX_RIGHT)], doc_type='QUOTATION')
        conv = self.client.post(f"{self.url}{res.data['id']}/convert/", {'document_type': 'INVOICE'}, format='json')
        self.assertEqual(conv.status_code, 400)
        self.assertIn(ONE_EYE_MESSAGE, conv.data['detail'])
        self.assertEqual(self._stock(self.pair_lens), 10)

    def test_edit_pair_to_piece_moves_only_the_difference(self):
        inv = self._post([self._lens(self.piece_lens, 'PAIR', 1, 1800, RX_BOTH)]).data['id']
        self.assertEqual(self._stock(self.piece_lens), 8)
        res = self.client.patch(f'{self.url}{inv}/', {'items': [self._lens(self.piece_lens, 'PIECE', 1, 1000, RX_RIGHT, eye='RE')]},
                                format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['items'][0]['selling_unit'], 'PIECE')
        self.assertEqual(self._stock(self.piece_lens), 9)  # one lens back on the shelf
        # Reducing / removing the lens line (the return path) restores exactly what was taken.
        self.client.patch(f'{self.url}{inv}/', {'items': [self._frame()]}, format='json')
        self.assertEqual(self._stock(self.piece_lens), 10)

    def test_frames_and_old_style_lines_are_unchanged(self):
        self._post([self._frame(2)])
        self.assertEqual(self._stock(self.frame), 8)
        plain = self._frame(1)
        plain['product'] = str(self.pair_lens.id)  # a lens line saved the old way (no unit)
        self._post([plain])
        self.assertEqual(self._stock(self.pair_lens), 9)

    def test_cogs_costs_the_stock_units_issued(self):
        inv_id = self._post([self._lens(self.pair_lens, 'PAIR', 2, 2000, RX_BOTH), self._frame(1)]).data['id']
        entry = build_sales_invoice(Invoice.objects.get(pk=inv_id))
        cogs = sum(l['debit'] for l in entry['lines'] if l['role'] == 'COGS')
        self.assertEqual(cogs, Decimal('1700.00'))  # 2 pairs × 800 + 1 frame × 100
