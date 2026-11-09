"""Purchase Entry -> Search Order Number: a customer order's waiting lenses (not ordered yet, or
placed on a Lens PO) become entry lines next to frames / accessories; saving the entry receives
them on the actual received date and bills their Lens POs.
"""
from datetime import timedelta
from decimal import Decimal

from django.utils import timezone

from apps.products.models import Product
from apps.purchasing.models import LensPurchaseOrder, LensPurchaseOrderPiece, PurchaseInvoice, Supplier

from .test_lens_purchase_orders import TODAY, URL, LensPOBase

DRAFT = f'{URL}order-draft/'
QUEUE = f'{URL}sales-queue/'


class PurchaseEntryByOrderTests(LensPOBase):
    def setUp(self):
        super().setUp()
        self.frame = Product.objects.create(name='Ray Frame', sku='PE-FR', category_name='Frames', stock=0,
                                            cost_price=Decimal('900'), retail_price=Decimal('2500'))

    def draft(self, order, supplier=None, expect=200):
        params = {'sales_order': str(order.pk)}
        if supplier:
            params['supplier'] = str(supplier.pk)
        res = self.client.get(DRAFT, params)
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def save_entry(self, orders, lens_lines, other_lines=(), received=None, status='CONFIRMED', expect=201, supplier=None):
        items = [{'product': l['product'], 'quantity': l['quantity'], 'purchase_rate': l['purchase_rate'],
                  'line_total': str(Decimal(l['purchase_rate']) * l['quantity']), 'item_group': 'LENS'} for l in lens_lines]
        items += [{'product': str(p.pk), 'quantity': q, 'purchase_rate': str(r), 'line_total': str(Decimal(r) * q)}
                  for p, q, r in other_lines]
        total = sum(Decimal(i['line_total']) for i in items)
        body = {'invoice_number': f'PE-ORD-{PurchaseInvoice.all_objects.count() + 1}', 'supplier': str((supplier or self.lab).pk),
                'purchase_date': TODAY.isoformat(), 'purchase_type': 'CREDIT', 'payment_method': 'CREDIT',
                'status': status, 'items': items, 'grand_total': str(total), 'balance_amount': str(total),
                'lens_sales_orders': [str(o.pk) for o in orders]}
        if received:
            body['lens_received_date'] = received.isoformat()
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post('/api/purchase/invoices/', body, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res

    def test_order_not_yet_ordered_is_bought_with_frames_on_one_entry(self):
        order = self.pair_order(self.asha)
        d = self.draft(order, self.lab)
        self.assertEqual(d['sales_order_number'], order.invoice_number)
        self.assertEqual(len(d['lines']), 1)
        line = d['lines'][0]
        # One pair-stocked pair -> 1 stock unit at the product's cost; no PO tax yet.
        self.assertEqual((line['product'], line['quantity'], line['purchase_rate'], line['source']),
                         (str(self.hmc.pk), 1, '400.00', 'PENDING'))
        self.assertIsNone(line['gst_percent'])

        received = TODAY - timedelta(days=2)
        res = self.save_entry([order], d['lines'], [(self.frame, 2, 900)], received=received)
        self.assertEqual(self.stock(self.hmc), 1)
        self.assertEqual(self.stock(self.frame), 2)
        groups = sorted((i['item_group'], str(i['product'])) for i in res.data['items'])
        self.assertEqual(groups, sorted([('LENS', str(self.hmc.pk)), ('', str(self.frame.pk))]))

        po = LensPurchaseOrder.objects.get(purchase_invoice_id=res.data['id'])
        self.assertEqual(po.status, 'RECEIVED')
        pieces = LensPurchaseOrderPiece.objects.filter(item__order=po)
        self.assertEqual(sorted(p.eye for p in pieces), ['LE', 'RE'])
        self.assertTrue(all(timezone.localtime(p.received_at).date() == received for p in pieces))
        self.assertEqual(self.stage(order), 'Ready for Delivery')
        # Nothing left to bring in: the order can't be pulled in twice.
        self.assertEqual(self.draft(order, self.lab)['lines'], [])
        self.save_entry([order], [], [(self.frame, 1, 900)], expect=400)

    def test_placed_po_is_received_on_the_actual_date_and_billed(self):
        order = self.pair_order(self.asha)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')], price='700')],
                         status='ORDERED')
        LensPurchaseOrder.objects.filter(pk=po['id']).update(expected_delivery_date=TODAY - timedelta(days=5))
        d = self.draft(order)  # supplier taken from the placed PO
        self.assertEqual(d['supplier'], str(self.lab.pk))
        self.assertEqual(d['expected_delivery_date'], TODAY - timedelta(days=5))
        self.assertEqual([(l['quantity'], l['purchase_rate'], l['source']) for l in d['lines']], [(1, '700.00', 'PLACED')])

        received = TODAY - timedelta(days=1)
        res = self.save_entry([order], d['lines'], received=received)
        db = LensPurchaseOrder.objects.get(pk=po['id'])
        self.assertEqual((db.status, str(db.purchase_invoice_id)), ('RECEIVED', res.data['id']))
        self.assertTrue(all(timezone.localtime(p.received_at).date() == received
                            for p in LensPurchaseOrderPiece.objects.filter(item__order=db)))
        self.assertIn('expected', db.history[-2]['detail'] + db.history[-1]['detail'] + str(db.history))
        self.assertEqual(self.stock(self.hmc), 1)
        self.assertEqual(self.stage(order), 'Ready for Delivery')

    def test_shared_po_is_split_so_other_orders_stay_billable(self):
        a = self.pair_order(self.asha)
        b = self.pair_order(self.ravi, product=self.blue)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(a, 'RE'), self.piece(a, 'LE')]),
                          self.item('SINGLE_PAIR', [self.piece(b, 'RE'), self.piece(b, 'LE')], product=self.blue)],
                         status='ORDERED')
        res = self.save_entry([a], self.draft(a, self.lab)['lines'])
        billed = LensPurchaseOrder.objects.get(purchase_invoice_id=res.data['id'])
        self.assertNotEqual(str(billed.pk), po['id'])
        original = LensPurchaseOrder.objects.get(pk=po['id'])
        self.assertIsNone(original.purchase_invoice_id)
        self.assertEqual(original.status, 'ORDERED')
        # Ravi's lenses are still on the original PO and can be pulled into a later entry.
        d = self.draft(b, self.lab)
        self.assertEqual([(l['product'], l['source']) for l in d['lines']], [(str(self.blue.pk), 'PLACED')])
        res2 = self.save_entry([b], d['lines'])
        original.refresh_from_db()
        self.assertEqual(str(original.purchase_invoice_id), res2.data['id'])

    def test_po_with_another_supplier_is_left_out(self):
        other = Supplier.objects.create(name='Zeiss Lab', supplier_code='SUP-Z')
        order = self.pair_order(self.asha)
        self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], status='ORDERED')
        d = self.draft(order, other)
        self.assertEqual(d['lines'], [])
        self.assertTrue(any('Essilor Lab' in s for s in d['skipped']))
        self.save_entry([order], [], [(self.frame, 1, 900)], supplier=other, expect=400)

    def test_draft_save_and_future_date_are_refused(self):
        order = self.pair_order(self.asha)
        lines = self.draft(order, self.lab)['lines']
        self.save_entry([order], lines, status='DRAFT', expect=400)
        self.save_entry([order], lines, received=TODAY + timedelta(days=1), expect=400)
        self.assertEqual(self.stock(self.hmc), 0)
        self.assertFalse(LensPurchaseOrder.objects.exists())

    def test_queue_search_finds_order_by_lens_po_number(self):
        order = self.pair_order(self.asha)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], status='ORDERED')
        rows = self.client.get(QUEUE, {'search': po['po_number']}).data
        self.assertEqual([r['id'] for r in rows], [str(order.pk)])

    def test_receive_endpoint_takes_the_actual_received_date(self):
        order = self.pair_order(self.asha)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], status='ORDERED')
        day = TODAY - timedelta(days=3)
        res = self.client.post(f"{URL}{po['id']}/receive/", {
            'received_date': day.isoformat(),
            'pieces': [{'id': p['id'], 'status': 'RECEIVED'} for p in self.pieces_of(po)]}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(all(timezone.localtime(p.received_at).date() == day
                            for p in LensPurchaseOrderPiece.objects.filter(item__order_id=po['id'])))
