"""Out-of-stock lens special order, end to end: New Sale books a customer Order at
'Pending Supplier Purchase' -> Sales > Orders > Lenses queue -> Lens PO from the order -> receive ->
Purchase Entry brings the stock in (order 'Ready for Delivery', lenses held for that customer) ->
the order is billed in place and the held stock goes out on its invoice.
"""
from rest_framework.test import APITestCase  # noqa: F401  (LensPOBase is an APITestCase)

from .test_lens_purchase_orders import LensPOBase, RX_A, URL

QUEUE = f'{URL}sales-queue/'
RESERVED = f'{URL}reserved-stock/'


class LensOrderWorkflowTests(LensPOBase):
    def queue_row(self, order, **params):
        rows = self.client.get(QUEUE, params).data
        return next((r for r in rows if r['id'] == str(order.pk)), None)

    def test_full_cycle_pair_order(self):
        order = self.pair_order(self.asha)
        order.fulfillment_status = 'Pending Supplier Purchase'
        order.save(update_fields=['fulfillment_status'])

        row = self.queue_row(order)
        self.assertEqual(row['queue_status'], 'PENDING_PURCHASE')
        self.assertEqual(row['customer_name'], 'Asha')
        self.assertEqual(row['patient_code'], 'P-1')
        re = next(l for l in row['lenses'] if l['eye'] == 'RE')
        self.assertEqual((re['rx']['sph'], re['rx']['cyl'], re['rx']['axis']), ('-2.50', '-0.75', '90'))
        self.assertEqual((re['required'], re['ordered']), (1, 0))

        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], status='ORDERED')
        self.assertEqual(self.stage(order), 'In Lab Processing')  # moves on from Pending Supplier Purchase
        row = self.queue_row(order)
        self.assertEqual(row['queue_status'], 'PURCHASE_PLACED')
        self.assertEqual([p['po_number'] for p in row['purchase_orders']], [po['po_number']])

        po = self.receive(po, [{'id': p['id'], 'status': 'RECEIVED'} for p in self.pieces_of(po)])
        self.assertEqual(self.stage(order), 'Lens Arrived')
        self.assertEqual(self.queue_row(order)['queue_status'], 'RECEIVED_NOT_STOCKED')
        self.assertEqual(self.client.get(RESERVED).data, [])  # not in stock yet, nothing held

        _, res = self.convert(po)
        self.assertEqual(self.stock(self.hmc), 1)
        self.assertEqual(self.stage(order), 'Ready for Delivery')
        row = self.queue_row(order)
        self.assertEqual((row['queue_status'], row['queue_status_label']), ('READY', 'Received / Ready for Delivery'))
        self.assertEqual(row['purchase_orders'][0]['purchase_invoice'], res.data['id'])

        held = self.client.get(RESERVED).data
        self.assertEqual([(h['sales_order'], h['units'], h['customer_name']) for h in held], [(str(order.pk), 1, 'Asha')])
        self.assertEqual(self.client.get(RESERVED, {'exclude_order': str(order.pk)}).data, [])

        # Billing the order in place takes the held pair out of stock and ends the hold.
        res = self.client.post(f'/api/sales/invoices/{order.pk}/convert/', {'document_type': 'INVOICE'}, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)
        self.assertEqual(self.stock(self.hmc), 0)
        self.assertEqual(self.client.get(RESERVED).data, [])
        row = self.queue_row(order)  # still listed until handed over
        self.assertTrue(row['billed'])
        self.assertEqual(row['queue_status'], 'READY')

        order.refresh_from_db()
        order.fulfillment_status = 'Delivered'
        order.save(update_fields=['fulfillment_status'])
        self.assertIsNone(self.queue_row(order))
        self.assertEqual(self.queue_row(order, include_delivered=1)['queue_status'], 'DELIVERED')

    def test_single_lens_order_and_partial_receipt(self):
        a = self.piece_order(self.asha, 'LE')
        b = self.pair_order(self.ravi)
        po = self.create([self.item('SINGLE_PIECE', [self.piece(a, 'LE')]),
                          self.item('SINGLE_PAIR', [self.piece(b, 'RE'), self.piece(b, 'LE')])], status='ORDERED')
        row = self.queue_row(a)
        self.assertEqual([l['eye'] for l in row['lenses']], ['LE'])
        self.assertEqual(row['queue_status'], 'PURCHASE_PLACED')
        b_re = next(p for p in self.pieces_of(po) if str(p['sales_order']) == str(b.pk) and p['eye'] == 'RE')
        self.receive(po, [{'id': b_re['id'], 'status': 'RECEIVED'}])
        self.assertEqual(self.queue_row(b)['queue_status'], 'PARTIALLY_RECEIVED')
        self.assertEqual(self.queue_row(a)['queue_status'], 'PURCHASE_PLACED')

    def test_in_stock_lens_order_needs_no_purchase(self):
        self.hmc.stock = 3
        self.hmc.save(update_fields=['stock'])
        order = self.pair_order(self.asha)
        self.assertEqual(self.queue_row(order)['queue_status'], 'IN_STOCK')
        self.hmc.stock = 0
        self.hmc.save(update_fields=['stock'])
        self.assertEqual(self.queue_row(order)['queue_status'], 'PENDING_PURCHASE')

    def test_queue_filters(self):
        a = self.pair_order(self.asha)
        b = self.pair_order(self.ravi)
        self.assertEqual({r['id'] for r in self.client.get(QUEUE, {'customer': str(self.ravi.pk)}).data}, {str(b.pk)})
        self.assertEqual({r['id'] for r in self.client.get(QUEUE, {'search': 'P-1'}).data}, {str(a.pk)})
        self.assertEqual(self.client.get(QUEUE, {'status': 'READY'}).data, [])
        # A plain invoice with a lens from stock (never on a lens PO) is not a lens order.
        inv = self.sales_order(self.asha, [(self.blue, 'PAIR', 'BOTH', RX_A)], doc_type='INVOICE')
        self.assertIsNone(self.queue_row(inv))
