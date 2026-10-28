"""Lens Purchase Order: lenses ordered from a lab with each physical lens mapped to the customer
order it is for. A PO never moves stock or posts accounting by itself; receiving updates the
linked sales orders lens by lens; converting into a Purchase Entry brings the stock in exactly once.
"""
from decimal import Decimal

from rest_framework.test import APITestCase

from apps.company.models import BranchStock
from apps.financial.models import JournalEntry
from apps.financial.tests.helpers import TODAY, ledger_is_balanced, live, make_warehouse
from apps.inventory.models import StockLedger
from apps.products.models import Product
from apps.purchasing.models import LensPurchaseOrder, LensPurchaseOrderPiece, PurchaseInvoice, Supplier
from apps.sales.models import Customer, Invoice

URL = '/api/purchase/lens-orders/'
RX_A = {'re': {'sph': '-2.50', 'cyl': '-0.75', 'axis': '90'}, 'le': {'sph': '-1.75', 'cyl': '-0.50', 'axis': '85'}}
RX_B = {'re': {'sph': '-1.00'}, 'le': {'sph': '-3.25', 'cyl': '-1.00', 'axis': '180'}}


class LensPOBase(APITestCase):
    def setUp(self):
        self.wh = make_warehouse()
        self.lab = Supplier.objects.create(name='Essilor Lab', supplier_code='SUP-LAB')
        self.hmc = Product.objects.create(name='HMC 1.56', sku='LPO-HMC', category_name='Prescription Lenses',
                                          stock=0, cost_price=Decimal('400'), retail_price=Decimal('1200'))
        self.blue = Product.objects.create(name='Blue Cut 1.56', sku='LPO-BLU', category_name='Prescription Lenses',
                                           stock=0, cost_price=Decimal('600'), retail_price=Decimal('1800'))
        self.asha = Customer.objects.create(name='Asha', patient_code='P-1')
        self.ravi = Customer.objects.create(name='Ravi', patient_code='P-2')

    # ---- sales side -----------------------------------------------------------------------

    def sales_order(self, customer, lines, doc_type='ORDER'):
        items = []
        for product, unit, eye, rx in lines:
            items.append({'product': str(product.id), 'item_type': 'LENS', 'description': product.name, 'quantity': 1,
                          'unit_price': 1200, 'tax_rate': 0, 'tax_amount': 0, 'subtotal': 1200,
                          'selling_unit': unit, 'lens_eye': eye, 'pricing_unit': unit, 'lens_details': {'rx': rx}})
        res = self.client.post('/api/sales/invoices/', {
            'document_type': doc_type, 'invoice_date': TODAY.isoformat(), 'status': 'UNPAID', 'customer': str(customer.id),
            'customer_name': customer.name, 'total_amount': 1200 * len(items), 'net_amount': 1200 * len(items),
            'paid_amount': 0, 'items': items, 'fulfillment_status': 'Order Received',
        }, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return Invoice.objects.get(pk=res.data['id'])

    def pair_order(self, customer, product=None, rx=RX_A):
        return self.sales_order(customer, [(product or self.hmc, 'PAIR', 'BOTH', rx)])

    def piece_order(self, customer, eye, product=None, rx=RX_A):
        return self.sales_order(customer, [(product or self.hmc, 'PIECE', eye, rx)])

    # ---- purchase side --------------------------------------------------------------------

    def piece(self, order, eye, **kw):
        return {'sales_order': str(order.pk), 'eye': eye, **kw}

    def item(self, order_type, pieces, product=None, price='800', **kw):
        return {'product': str((product or self.hmc).pk), 'order_type': order_type, 'unit_price': price,
                'pricing_unit': 'PAIR', 'lens_index': '', 'pieces': pieces, **kw}

    def create(self, items, status='PENDING', expect=201):
        res = self.client.post(URL, {'supplier': str(self.lab.pk), 'order_date': TODAY.isoformat(),
                                     'status': status, 'items': items}, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def receive(self, po, rows, expect=200):
        res = self.client.post(f"{URL}{po['id']}/receive/", {'pieces': rows}, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return res.data

    def pieces_of(self, po):
        return [p for it in po['items'] for p in it['pieces']]

    def stage(self, order):
        order.refresh_from_db()
        return order.fulfillment_status

    def stock(self, product):
        product.refresh_from_db()
        return product.stock

    def convert(self, po, lines=None, expect=201):
        draft = self.client.get(f"{URL}{po['id']}/invoice-draft/").data
        lines = lines or draft['lines']
        body = {'invoice_number': f"PE-{po['po_number']}", 'supplier': str(self.lab.pk),
                'purchase_date': TODAY.isoformat(), 'purchase_type': 'CREDIT', 'payment_method': 'CREDIT',
                'status': 'CONFIRMED', 'purchase_order_ref': po['po_number'], 'lens_purchase_order': po['id'],
                'items': [{'product': l['product'], 'quantity': l['quantity'], 'purchase_rate': l['purchase_rate'],
                           'line_total': str(Decimal(l['purchase_rate']) * l['quantity'])} for l in lines]}
        total = sum(Decimal(i['line_total']) for i in body['items'])
        body.update(grand_total=str(total), balance_amount=str(total))
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post('/api/purchase/invoices/', body, format='json')
        self.assertEqual(res.status_code, expect, res.content)
        return draft, res


class CreateTests(LensPOBase):
    def test_draft_changes_no_stock_invoice_or_accounting(self):
        order = self.pair_order(self.asha)
        with self.captureOnCommitCallbacks(execute=True):
            po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], status='DRAFT')
        self.assertEqual(po['status'], 'DRAFT')
        self.assertTrue(po['po_number'])
        self.assertEqual(self.stock(self.hmc), 0)
        self.assertFalse(PurchaseInvoice.objects.exists())
        self.assertFalse(StockLedger.objects.exists())
        self.assertFalse(JournalEntry.objects.filter(reference_id=po['id']).exists())
        self.assertEqual(self.stage(order), 'Order Received')  # a draft isn't at the lab yet
        self.assertEqual(po['history'][0]['action'], 'CREATED')

    def test_submitted_po_stays_an_order(self):
        order = self.pair_order(self.asha)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], status='DRAFT')
        res = self.client.post(f"{URL}{po['id']}/submit/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['status'], 'PENDING')
        res = self.client.post(f"{URL}{po['id']}/mark-ordered/")
        self.assertEqual(res.data['status'], 'ORDERED')
        self.assertIsNone(res.data['purchase_invoice'])
        self.assertFalse(PurchaseInvoice.objects.exists())
        self.assertEqual(self.stock(self.hmc), 0)
        self.assertEqual(self.stage(order), 'In Lab Processing')

    def test_single_customer_pair_takes_rx_from_the_sales_order(self):
        order = self.pair_order(self.asha)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])])
        item = po['items'][0]
        self.assertEqual((item['commercial_quantity'], item['commercial_unit'], item['physical_quantity'],
                          item['quantity_label']), (1, 'PAIR', 2, '1 Pair (2 Pieces)'))
        re, le = sorted(item['pieces'], key=lambda p: p['eye'], reverse=True)
        self.assertEqual((re['eye'], re['rx']['sph'], re['rx']['cyl'], re['rx']['axis']), ('RE', '-2.50', '-0.75', '90'))
        self.assertEqual((le['eye'], le['rx']['sph'], le['rx']['axis']), ('LE', '-1.75', '85'))
        self.assertEqual({re['customer_name'], le['customer_name']}, {'Asha'})
        self.assertEqual({re['sales_order_number'], le['sales_order_number']}, {order.invoice_number})
        self.assertFalse(re['rx_changed'])

    def test_split_pair_maps_each_lens_to_its_own_customer(self):
        a = self.piece_order(self.asha, 'RE', rx=RX_A)
        b = self.piece_order(self.ravi, 'LE', rx=RX_B)
        po = self.create([self.item('SPLIT_PAIR', [self.piece(a, 'RE'), self.piece(b, 'LE')])])
        p1, p2 = self.pieces_of(po)
        self.assertEqual((p1['customer_name'], p1['sales_order_number'], p1['eye'], p1['rx']['sph']),
                         ('Asha', a.invoice_number, 'RE', '-2.50'))
        self.assertEqual((p2['customer_name'], p2['sales_order_number'], p2['eye'], p2['rx']['sph'], p2['rx']['axis']),
                         ('Ravi', b.invoice_number, 'LE', '-3.25', '180'))
        self.assertEqual(po['items'][0]['quantity_label'], '1 Pair (2 Pieces)')
        self.assertEqual(Decimal(po['items'][0]['line_total']), Decimal('800.00'))  # pair-priced
        self.assertEqual(po['summary']['customers'], ['Asha', 'Ravi'])

    def test_single_piece_label(self):
        a = self.piece_order(self.asha, 'LE')
        po = self.create([self.item('SINGLE_PIECE', [self.piece(a, 'LE')], pricing_unit='PIECE', price='450')])
        self.assertEqual(po['items'][0]['quantity_label'], '1 Piece (1 Lens)')
        self.assertEqual(Decimal(po['items'][0]['line_total']), Decimal('450.00'))


class ValidationTests(LensPOBase):
    def test_same_requirement_cannot_be_ordered_twice(self):
        order = self.pair_order(self.asha)
        self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])])
        res = self.client.get(f'{URL}pending-requirements/', {'search': order.invoice_number})
        self.assertEqual(res.data, [])  # nothing outstanding any more
        other = self.pair_order(self.ravi)
        err = self.create([self.item('SPLIT_PAIR', [self.piece(order, 'RE'), self.piece(other, 'LE')])], expect=400)
        self.assertIn('already been ordered', str(err))

    def test_cancelled_po_frees_the_requirement(self):
        order = self.pair_order(self.asha)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])])
        self.assertEqual(self.client.post(f"{URL}{po['id']}/cancel/", {'reason': 'wrong lab'}).status_code, 200)
        self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])])

    def test_incompatible_lens_model_is_blocked(self):
        a = self.piece_order(self.asha, 'RE', product=self.hmc)
        b = self.piece_order(self.ravi, 'LE', product=self.blue)
        err = self.create([self.item('SPLIT_PAIR', [self.piece(a, 'RE'), self.piece(b, 'LE')], product=self.hmc)], expect=400)
        self.assertIn(f'{b.invoice_number} has no Left (OS) requirement for HMC 1.56', str(err))

    def test_wrong_eye_and_same_customer_split_are_blocked(self):
        a = self.piece_order(self.asha, 'RE')
        err = self.create([self.item('SINGLE_PIECE', [self.piece(a, 'LE')])], expect=400)
        self.assertIn('no Left (OS) requirement', str(err))
        a2 = self.piece_order(self.asha, 'LE')
        err = self.create([self.item('SPLIT_PAIR', [self.piece(a, 'RE'), self.piece(a2, 'LE')])], expect=400)
        self.assertIn('two different customers', str(err))

    def test_fulfilled_cancelled_and_quotation_orders_are_refused(self):
        delivered = self.pair_order(self.asha)
        Invoice.objects.filter(pk=delivered.pk).update(fulfillment_status='Delivered')
        cancelled = self.pair_order(self.ravi)
        Invoice.objects.filter(pk=cancelled.pk).update(status='CANCELLED')
        quote = self.sales_order(self.ravi, [(self.hmc, 'PAIR', 'BOTH', RX_A)], doc_type='QUOTATION')
        for order, words in ((delivered, 'already been delivered'), (cancelled, 'is cancelled'), (quote, 'quotation')):
            err = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], expect=400)
            self.assertIn(words, str(err))

    def test_prescription_change_needs_a_reason_and_never_touches_the_sale(self):
        order = self.pair_order(self.asha)
        changed = {'sph': '-2.75', 'cyl': '-0.75', 'axis': '90'}
        err = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE', rx=changed), self.piece(order, 'LE')])], expect=400)
        self.assertIn('Give a reason', str(err))
        po = self.create([self.item('SINGLE_PAIR', [
            self.piece(order, 'RE', rx=changed, rx_change_reason='Re-checked by optometrist'), self.piece(order, 'LE')])])
        re = next(p for p in self.pieces_of(po) if p['eye'] == 'RE')
        self.assertEqual((re['rx']['sph'], re['original_rx']['sph'], re['rx_changed']), ('-2.75', '-2.50', True))
        self.assertTrue(any(h['action'] == 'RX_CHANGED' for h in po['history']))
        order.refresh_from_db()
        self.assertEqual(order.items.get().lens_details['rx']['re']['sph'], '-2.50')

    def test_ordered_po_lenses_are_locked(self):
        order = self.pair_order(self.asha)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], status='ORDERED')
        res = self.client.patch(f"{URL}{po['id']}/", {'items': []}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.client.patch(f"{URL}{po['id']}/", {'remarks': 'Call lab Friday'}, format='json')
        self.assertEqual((res.status_code, res.data['remarks'], res.data['status']), (200, 'Call lab Friday', 'ORDERED'))


class ReceivingTests(LensPOBase):
    def split_po(self):
        a = self.piece_order(self.asha, 'RE', rx=RX_A)
        b = self.piece_order(self.ravi, 'LE', rx=RX_B)
        return a, b, self.create([self.item('SPLIT_PAIR', [self.piece(a, 'RE'), self.piece(b, 'LE')])], status='ORDERED')

    def test_one_piece_updates_only_its_own_order(self):
        a, b, po = self.split_po()
        p1, p2 = self.pieces_of(po)
        po = self.receive(po, [{'id': p1['id'], 'status': 'RECEIVED', 'piece_reference': 'LAB-778'}])
        self.assertEqual(po['status'], 'PARTIALLY_RECEIVED')
        self.assertEqual(self.stage(a), 'Lens Arrived')        # Asha needed only this lens
        self.assertEqual(self.stage(b), 'In Lab Processing')   # Ravi's lens is still at the lab
        self.assertEqual(self.pieces_of(po)[0]['fitting_status'], 'READY_FOR_FITTING')
        self.assertEqual(self.stock(self.hmc), 0)               # receiving alone moves no stock

        po = self.receive(po, [{'id': p2['id'], 'status': 'RECEIVED'}])
        self.assertEqual(po['status'], 'RECEIVED')
        self.assertEqual(self.stage(b), 'Lens Arrived')
        self.assertTrue(any(h['action'] == 'SALES_ORDER_STATUS' and 'Lens Arrived' in h['detail'] for h in po['history']))

    def test_pair_order_waits_for_its_second_lens(self):
        order = self.pair_order(self.asha)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], status='ORDERED')
        re, le = self.pieces_of(po)
        self.receive(po, [{'id': re['id'], 'status': 'RECEIVED'}])
        self.assertEqual(self.stage(order), 'Awaiting Remaining Lens')
        self.receive(po, [{'id': le['id'], 'status': 'RECEIVED'}])
        self.assertEqual(self.stage(order), 'Lens Arrived')

    def test_duplicate_receipt_and_discrepancies(self):
        a, b, po = self.split_po()
        p1, p2 = self.pieces_of(po)
        self.receive(po, [{'id': p1['id'], 'status': 'RECEIVED'}])
        err = self.receive(po, [{'id': p1['id'], 'status': 'RECEIVED'}], expect=400)
        self.assertIn('already been received', err['detail'])
        err = self.receive(po, [{'id': p2['id'], 'status': 'DAMAGED'}], expect=400)
        self.assertIn('discrepancy note', err['detail'])
        po = self.receive(po, [{'id': p2['id'], 'status': 'DAMAGED', 'notes': 'Chipped edge'}])
        self.assertEqual((po['status'], po['summary']['discrepancies']), ('PARTIALLY_RECEIVED', 1))
        self.assertEqual(self.stage(b), 'In Lab Processing')   # a damaged lens doesn't count as arrived
        # The lab's replacement is received against the same piece later.
        po = self.receive(po, [{'id': p2['id'], 'status': 'RECEIVED', 'notes': ''}])
        self.assertEqual(po['status'], 'RECEIVED')
        self.assertEqual(self.stage(b), 'Lens Arrived')

    def test_missing_and_incorrect_keep_po_open(self):
        a, b, po = self.split_po()
        p1, p2 = self.pieces_of(po)
        po = self.receive(po, [{'id': p1['id'], 'status': 'MISSING', 'notes': 'Not in parcel'},
                               {'id': p2['id'], 'status': 'INCORRECT', 'notes': 'Axis 170 not 180'}])
        self.assertEqual(po['status'], 'ORDERED')
        self.assertEqual(po['summary']['discrepancies'], 2)
        self.assertEqual(self.client.post(f"{URL}{po['id']}/cancel/").status_code, 200)  # nothing received yet

    def test_cancel_refused_after_receipt(self):
        a, b, po = self.split_po()
        self.receive(po, [{'id': self.pieces_of(po)[0]['id'], 'status': 'RECEIVED'}])
        self.assertEqual(self.client.post(f"{URL}{po['id']}/cancel/").status_code, 400)


class ConversionTests(LensPOBase):
    def received_split(self):
        a = self.piece_order(self.asha, 'RE')
        b = self.piece_order(self.ravi, 'LE', rx=RX_B)
        po = self.create([self.item('SPLIT_PAIR', [self.piece(a, 'RE'), self.piece(b, 'LE')])], status='ORDERED')
        return self.receive(po, [{'id': p['id'], 'status': 'RECEIVED'} for p in self.pieces_of(po)])

    def test_convert_moves_stock_once_and_links_both_ways(self):
        po = self.received_split()
        self.assertFalse(self.client.post(f"{URL}{po['id']}/receive/", {'pieces': []}, format='json').status_code == 200)
        draft, res = self.convert(po)
        line = draft['lines'][0]
        # Pair-stocked lens split between two customers: each one's sale will take a whole pair
        # (lens_units rounds a bill's single lens up), so it comes in as 2 units at the PO's cost.
        self.assertEqual((line['quantity'], line['stock_unit'], Decimal(line['purchase_rate'])), (2, 'PAIR', Decimal('400.00')))
        self.assertEqual(self.stock(self.hmc), 2)
        self.assertEqual(BranchStock.objects.get(product=self.hmc).quantity, 2)
        self.assertEqual(StockLedger.objects.filter(reference_id=res.data['id']).count(), 1)
        lpo = LensPurchaseOrder.objects.get(pk=po['id'])
        self.assertEqual(str(lpo.purchase_invoice_id), res.data['id'])
        self.assertEqual(res.data['purchase_order_ref'], po['po_number'])
        # Supplier payable + exactly one purchase journal, balanced.
        self.lab.refresh_from_db()
        self.assertEqual(self.lab.outstanding_balance, Decimal('800.00'))
        self.assertEqual(live('purchasing', 'purchase_invoice', res.data['id']).count(), 1)
        self.assertTrue(ledger_is_balanced())
        self.assertFalse(JournalEntry.objects.filter(reference_id=po['id']).exists())

        # Converting again is refused and moves nothing; the draft points at the existing entry.
        _, again = self.convert(po, lines=draft['lines'], expect=400)
        self.assertIn('already billed', str(again.data))
        self.assertEqual(self.stock(self.hmc), 2)
        self.assertEqual(PurchaseInvoice.objects.count(), 1)
        self.assertEqual(self.client.get(f"{URL}{po['id']}/invoice-draft/").data['existing']['id'], res.data['id'])

    def test_piece_stocked_lens_converts_by_pieces(self):
        self.hmc.extra_data = {'lens_stock_unit': 'PIECE'}
        self.hmc.save()
        po = self.received_split()
        draft, _ = self.convert(po)
        self.assertEqual((draft['lines'][0]['quantity'], Decimal(draft['lines'][0]['purchase_rate'])), (2, Decimal('400.00')))
        self.assertEqual(self.stock(self.hmc), 2)

    def test_single_customer_pair_converts_to_one_pair_and_both_sales_balance(self):
        order = self.pair_order(self.asha)
        po = self.create([self.item('SINGLE_PAIR', [self.piece(order, 'RE'), self.piece(order, 'LE')])], status='ORDERED')
        po = self.receive(po, [{'id': p['id'], 'status': 'RECEIVED'} for p in self.pieces_of(po)])
        draft, _ = self.convert(po)
        self.assertEqual((draft['lines'][0]['quantity'], Decimal(draft['lines'][0]['purchase_rate'])), (1, Decimal('800.00')))
        self.assertEqual(self.stock(self.hmc), 1)
        # Billing the order takes exactly the pair that came in.
        res = self.client.post(f'/api/sales/invoices/{order.pk}/convert/', {'document_type': 'INVOICE'}, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)
        self.assertEqual(self.stock(self.hmc), 0)

    def test_nothing_received_cannot_convert(self):
        a = self.piece_order(self.asha, 'RE')
        po = self.create([self.item('SINGLE_PIECE', [self.piece(a, 'RE')])], status='ORDERED')
        self.assertEqual(self.client.get(f"{URL}{po['id']}/invoice-draft/").status_code, 400)
        _, res = self.convert(po, lines=[{'product': str(self.hmc.pk), 'quantity': 1, 'purchase_rate': '400'}], expect=400)
        self.assertIn('Receive at least one lens', str(res.data))
        self.assertEqual(self.stock(self.hmc), 0)
        self.assertFalse(PurchaseInvoice.objects.exists())  # the entry rolled back with the refusal


class ExistingFlowsUnchangedTests(LensPOBase):
    def test_plain_purchase_entry_and_sales_order_untouched(self):
        order = self.pair_order(self.asha)
        before = (order.fulfillment_status, order.status, order.net_amount)
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post('/api/purchase/invoices/', {
                'invoice_number': 'PE-PLAIN', 'supplier': str(self.lab.pk), 'purchase_date': TODAY.isoformat(),
                'purchase_type': 'CASH', 'payment_method': 'CASH', 'status': 'CONFIRMED', 'grand_total': 1600,
                'paid_amount': 1600, 'items': [{'product': str(self.blue.pk), 'quantity': 2, 'purchase_rate': 800,
                                                'line_total': 1600}]}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(self.stock(self.blue), 2)
        order.refresh_from_db()
        self.assertEqual((order.fulfillment_status, order.status, order.net_amount), before)
        self.assertFalse(LensPurchaseOrderPiece.objects.exists())
