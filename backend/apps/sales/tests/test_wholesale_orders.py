"""Wholesale Orders & Quotations (sales.wholesale_orders) and their Stock Overview figures.

    Quotation saved        -> Ordered 0, nothing moved
    Order confirmed (X)    -> Ordered +X, Available -X, on hand untouched
    Order edited (±Δ)      -> Ordered ±Δ
    Order cancelled        -> Ordered back to 0
    Order billed in POS    -> Ordered -X, Sold +X, on hand -X (Available stays down)
    Direct POS sale        -> Sold +X, on hand -X
"""
from rest_framework.test import APITestCase

from apps.inventory.stock_lifecycle import lifecycle_for
from apps.products.models import Product
from apps.sales.models import Dealer, WholesaleInvoice, WholesaleOrder, WholesaleQuotation

ORDERS = '/api/sales/wholesale/orders/'
QUOTES = '/api/sales/wholesale/quotations/'
INVOICES = '/api/sales/wholesale/invoices/'


class WholesaleOrderFlowTests(APITestCase):
    def setUp(self):
        self.dealer = Dealer.objects.create(dealer_code='DL-O1', business_name='Order Optics', phone='9999999991')
        self.other = Dealer.objects.create(dealer_code='DL-O2', business_name='Other Optics', phone='9999999992')
        self.frame = Product.objects.create(name='Frame', sku='FR-O1', stock=100)
        self.lens = Product.objects.create(name='Lens', sku='LN-O1', stock=40)

    # -- helpers -------------------------------------------------------------------------------
    def _life(self, product):
        product.refresh_from_db()
        return lifecycle_for([product])[product.pk]

    def _items(self, frame_qty=10, lens_qty=0):
        items = [{'id': str(self.frame.id), 'name': 'Frame', 'qty': frame_qty, 'rate': 100}]
        if lens_qty:
            items.append({'id': str(self.lens.id), 'name': 'Lens', 'qty': lens_qty, 'rate': 50})
        return items

    def _order(self, **kw):
        body = {'dealer': str(self.dealer.id), 'total_amount': 1000,
                'details': {'items': kw.pop('items', self._items())}, **kw}
        res = self.client.post(ORDERS, body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def _bill(self, order=None, number='WINV-300001', items=None, status='Partial', **details):
        details = {'items': items or self._items(), 'orderStatus': 'Confirmed', **details}
        if order:
            details['linkedOrder'] = {'id': order['id'], 'orderNumber': order['order_number']}
        return self.client.post(INVOICES, {
            'invoice_number': number, 'dealer': str(self.dealer.id), 'invoice_date': '2026-11-10',
            'due_date': '2026-12-10', 'grand_total': 1000, 'paid_amount': 0, 'due_amount': 1000,
            'status': status, 'details': details}, format='json')

    # -- orders --------------------------------------------------------------------------------
    def test_order_number_series_and_reservation(self):
        a = self._order()
        b = self._order(items=self._items(5, lens_qty=2))
        self.assertRegex(a['order_number'], r'^WO-\d{4}-\d{4}$')
        self.assertNotEqual(a['order_number'], b['order_number'])
        self.assertEqual(a['status'], 'CONFIRMED')
        life = self._life(self.frame)
        self.assertEqual((life['ordered'], life['ordered_wholesale'], life['on_hand'], life['available'], life['sold']),
                         (15, 15, 100, 85, 0))
        self.assertEqual(self._life(self.lens)['ordered'], 2)

    def test_edit_and_cancel_move_the_reservation(self):
        order = self._order()
        res = self.client.patch(f"{ORDERS}{order['id']}/", {'details': {'items': self._items(14)}}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self._life(self.frame)['ordered'], 14)
        res = self.client.post(f"{ORDERS}{order['id']}/cancel/")
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['status'], 'CANCELLED')
        life = self._life(self.frame)
        self.assertEqual((life['ordered'], life['available'], life['on_hand']), (0, 100, 100))
        # A cancelled order can't be edited or billed.
        res = self.client.patch(f"{ORDERS}{order['id']}/", {'details': {'items': self._items(3)}}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self._bill(order).status_code, 400)
        self.assertFalse(WholesaleInvoice.objects.exists())

    def test_billing_closes_order_and_moves_ordered_to_sold(self):
        order = self._order()
        res = self._bill(order)
        self.assertEqual(res.status_code, 201, res.content)
        o = WholesaleOrder.objects.get(pk=order['id'])
        self.assertEqual((o.status, o.invoice.invoice_number, o.reserved_items), ('BILLED', 'WINV-300001', {}))
        self.assertEqual(WholesaleInvoice.objects.get(invoice_number='WINV-300001').order_ref, order['order_number'])
        life = self._life(self.frame)
        self.assertEqual((life['ordered'], life['sold'], life['on_hand'], life['available']), (0, 10, 90, 90))
        # Can't bill it again, can't edit or cancel it.
        self.assertEqual(self._bill(order, number='WINV-300002').status_code, 400)
        self.assertEqual(self.client.post(f"{ORDERS}{order['id']}/cancel/").status_code, 400)
        self.assertEqual(self.client.patch(f"{ORDERS}{order['id']}/", {'details': {'items': self._items(1)}}, format='json').status_code, 400)
        self.assertEqual(self._life(self.frame)['on_hand'], 90)

    def test_cancelling_or_deleting_the_bill_reopens_the_order(self):
        order = self._order()
        inv = self._bill(order).data
        res = self.client.patch(f"{INVOICES}{inv['id']}/", {
            'status': 'Cancelled', 'details': {**inv['details'], 'orderStatus': 'Cancelled'}}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        o = WholesaleOrder.objects.get(pk=order['id'])
        self.assertEqual((o.status, o.invoice_id), ('CONFIRMED', None))
        life = self._life(self.frame)
        self.assertEqual((life['ordered'], life['on_hand'], life['sold']), (10, 100, 0))

        inv2 = self._bill(order, number='WINV-300003').data
        self.assertEqual(WholesaleOrder.objects.get(pk=order['id']).status, 'BILLED')
        self.assertEqual(self.client.delete(f"{INVOICES}{inv2['id']}/").status_code, 204)
        self.assertEqual(WholesaleOrder.objects.get(pk=order['id']).status, 'CONFIRMED')
        self.assertEqual(self._life(self.frame)['ordered'], 10)

    def test_draft_bill_keeps_the_order_open(self):
        order = self._order()
        res = self._bill(order, status='Draft', orderStatus='Draft')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(WholesaleOrder.objects.get(pk=order['id']).status, 'CONFIRMED')
        self.assertEqual(self._life(self.frame)['ordered'], 10)
        inv = res.data
        res = self.client.patch(f"{INVOICES}{inv['id']}/", {
            'status': 'Partial', 'details': {**inv['details'], 'orderStatus': 'Confirmed'}}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(WholesaleOrder.objects.get(pk=order['id']).status, 'BILLED')

    def test_other_dealers_bill_cannot_take_the_order(self):
        order = self._order()
        res = self._bill(order)
        self.assertEqual(res.status_code, 201)
        o2 = self._order()
        body = {'invoice_number': 'WINV-300009', 'dealer': str(self.other.id), 'invoice_date': '2026-11-10',
                'due_date': '2026-12-10', 'grand_total': 1, 'paid_amount': 0, 'due_amount': 1, 'status': 'Partial',
                'details': {'items': self._items(1), 'orderStatus': 'Confirmed',
                            'linkedOrder': {'id': o2['id'], 'orderNumber': o2['order_number']}}}
        self.assertEqual(self.client.post(INVOICES, body, format='json').status_code, 400)
        self.assertEqual(WholesaleOrder.objects.get(pk=o2['id']).status, 'CONFIRMED')

    def test_direct_sale_counts_as_sold_only(self):
        self.assertEqual(self._bill().status_code, 201)
        life = self._life(self.frame)
        self.assertEqual((life['ordered'], life['sold'], life['on_hand']), (0, 10, 90))

    def test_unknown_product_refused_and_availability_endpoint(self):
        res = self.client.post(ORDERS, {'dealer': str(self.dealer.id), 'details': {
            'items': [{'id': 'local-123', 'name': 'Ghost', 'qty': 1}]}}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self.client.post(ORDERS, {'dealer': str(self.dealer.id), 'details': {'items': []}}, format='json').status_code, 400)
        a = self._order()
        self._order(items=self._items(3))
        res = self.client.get(f'{ORDERS}availability/')
        self.assertEqual(res.data['wholesale'][str(self.frame.id)], 13)
        res = self.client.get(f'{ORDERS}availability/', {'exclude': a['id']})
        self.assertEqual(res.data['wholesale'][str(self.frame.id)], 3)

    def test_search_filters(self):
        a = self._order()
        res = self.client.get(ORDERS, {'status': 'CONFIRMED', 'search': 'order optics'})
        rows = res.data['results'] if isinstance(res.data, dict) else res.data
        self.assertEqual([r['order_number'] for r in rows], [a['order_number']])
        self.assertEqual(rows[0]['dealer_name'], 'Order Optics')

    # -- quotations ----------------------------------------------------------------------------
    def test_quotation_reserves_nothing_and_converts_once(self):
        res = self.client.post(QUOTES, {'dealer': str(self.dealer.id), 'grand_total': 1000,
                                        'details': {'items': self._items(7)}}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        q = res.data
        self.assertRegex(q['quotation_number'], r'^WQ-\d{4}-\d{4}$')
        self.assertEqual(q['status'], 'QUOTATION')
        self.assertIsNotNone(q['expiry_date'])
        self.assertEqual(self._life(self.frame)['ordered'], 0)

        res = self.client.post(f"{QUOTES}{q['id']}/convert-to-order/")
        self.assertEqual(res.status_code, 200, res.content)
        order = res.data['order']
        self.assertEqual((order['status'], order['quotation_ref']), ('CONFIRMED', q['quotation_number']))
        self.assertEqual(self._life(self.frame)['ordered'], 7)
        qq = WholesaleQuotation.objects.get(pk=q['id'])
        self.assertEqual((qq.status, qq.converted_order_number), ('CONVERTED_TO_ORDER', order['order_number']))
        # Converting again returns the same order, no second reservation.
        res = self.client.post(f"{QUOTES}{q['id']}/convert-to-order/")
        self.assertEqual((res.data['created'], res.data['order']['id']), (False, order['id']))
        self.assertEqual(self._life(self.frame)['ordered'], 7)
        # Converted quotation is locked.
        self.assertEqual(self.client.patch(f"{QUOTES}{q['id']}/", {'details': {'items': self._items(1)}}, format='json').status_code, 400)

    def test_quotation_billed_directly(self):
        q = self.client.post(QUOTES, {'dealer': str(self.dealer.id), 'details': {'items': self._items(2)}}, format='json').data
        res = self._bill(items=self._items(2), linkedQuotation={'id': q['id'], 'quotationNumber': q['quotation_number']})
        self.assertEqual(res.status_code, 201, res.content)
        qq = WholesaleQuotation.objects.get(pk=q['id'])
        self.assertEqual((qq.status, qq.converted_invoice_number), ('CONVERTED_TO_SALE', 'WINV-300001'))
