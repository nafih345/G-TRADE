"""Wholesale POS invoices move stock on the server (sales.wholesale_stock).

Reported: a wholesale sale never reduced the product's stock. The POS screen posted its own
stock adjustments only when a warehouse was selected (none exist on a fresh install) and
swallowed every error. Now every save of a WholesaleInvoice deducts / restores stock to match.
"""
from unittest import mock

from rest_framework.test import APITestCase

from apps.company.models import Branch, Warehouse
from apps.inventory.models import StockAdjustment
from apps.products.models import Product
from apps.sales.models import Dealer, WholesaleInvoice

URL = '/api/sales/wholesale/invoices/'


class WholesaleStockTests(APITestCase):
    def setUp(self):
        self.dealer = Dealer.objects.create(dealer_code='DL-S1', business_name='Stock Optics', phone='9999999990')
        self.frame = Product.objects.create(name='Frame', sku='FR-1', stock=100)
        self.lens = Product.objects.create(name='Lens', sku='LN-1', stock=50)

    def _stock(self, product):
        product.refresh_from_db()
        return product.stock

    def _body(self, number='WINV-200001', items=None, status='Partial', **details):
        items = items if items is not None else [{'id': str(self.frame.id), 'code': 'FR-1', 'qty': 25, 'rate': 100}]
        return {
            'invoice_number': number, 'dealer': str(self.dealer.id), 'invoice_date': '2026-10-23',
            'due_date': '2026-11-22', 'grand_total': 2500, 'paid_amount': 0, 'due_amount': 2500,
            'status': status, 'details': {'items': items, 'orderStatus': 'Confirmed', **details},
        }

    def _create(self, **kw):
        res = self.client.post(URL, self._body(**kw), format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def _patch(self, inv, body):
        res = self.client.patch(f"{URL}{inv['id']}/", body, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        return res.data

    def test_sale_deducts_without_any_branch_or_warehouse(self):
        Branch.objects.all().delete()
        self._create()
        self.assertEqual(self._stock(self.frame), 75)          # 100 - 25

    def test_free_qty_service_lines_and_resave(self):
        items = [{'id': str(self.frame.id), 'qty': 10, 'freeQty': 2},
                 {'id': 'svc-1', 'itemType': 'SERVICE', 'qty': 1},
                 {'id': str(self.frame.id), 'qty': 3}]
        inv = self._create(items=items)
        self.assertEqual(self._stock(self.frame), 85)          # 10 + 2 free + 3
        self._patch(inv, {'paid_amount': 100})                  # unrelated re-save: no double count
        self.assertEqual(self._stock(self.frame), 85)

    def test_edit_moves_only_the_difference(self):
        inv = self._create()
        body = self._body(items=[{'id': str(self.frame.id), 'qty': 20}, {'id': str(self.lens.id), 'qty': 5}])
        self._patch(inv, {'details': body['details']})
        self.assertEqual(self._stock(self.frame), 80)
        self.assertEqual(self._stock(self.lens), 45)

    def test_cancel_return_and_delete_restore(self):
        inv = self._create()
        body = self._body(status='Cancelled')
        self._patch(inv, {'status': 'Cancelled', 'details': {**body['details'], 'orderStatus': 'Cancelled'}})
        self.assertEqual(self._stock(self.frame), 100)

        inv2 = self._create(number='WINV-200002')
        self.assertEqual(self._stock(self.frame), 75)
        self._patch(inv2, {'details': self._body(stockReturned='Returned')['details']})
        self.assertEqual(self._stock(self.frame), 100)

        self._create(number='WINV-200003')
        inv3 = WholesaleInvoice.objects.get(invoice_number='WINV-200003')
        self.assertEqual(self.client.delete(f'{URL}{inv3.id}/').status_code, 204)
        self.assertEqual(self._stock(self.frame), 100)

    def test_draft_moves_nothing_until_completed(self):
        inv = self._create(status='Draft', orderStatus='Draft')
        self.assertEqual(self._stock(self.frame), 100)
        self._patch(inv, {'status': 'Partial', 'details': self._body()['details']})
        self.assertEqual(self._stock(self.frame), 75)

    def test_shortfall_refused_when_negative_stock_off(self):
        with mock.patch('apps.inventory.stock_utils.negative_stock_blocked', return_value=True):
            res = self.client.post(URL, self._body(items=[{'id': str(self.frame.id), 'qty': 150}]), format='json')
        self.assertEqual(res.status_code, 400)
        self.assertFalse(WholesaleInvoice.objects.exists())   # the invoice rolled back too
        self.assertEqual(self._stock(self.frame), 100)

    def test_adjustment_rows_and_legacy_guard_with_warehouse(self):
        wh = Warehouse.objects.filter(branch=Branch.get_default()).order_by('created_at').first()             or Warehouse.objects.create(branch=Branch.get_default(), name='Main WH', code='WH-T')
        self._create()
        self.assertEqual(self._stock(self.frame), 75)
        adj = StockAdjustment.objects.get(reason='Wholesale POS sale WINV-200001')
        self.assertEqual((adj.adjustment_type, adj.quantity, adj.warehouse_id), ('SUB', 25, wh.id))

        # An old cached POS build still posts its own adjustment: refused, not counted twice.
        res = self.client.post('/api/inventory/adjustments/', {
            'product': str(self.frame.id), 'warehouse': str(wh.id), 'quantity': 25,
            'adjustment_type': 'SUB', 'reason': 'Wholesale POS sale WINV-200001'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(self._stock(self.frame), 75)

    def test_legacy_invoice_cancel_restores_what_the_old_pos_took(self):
        wh = Warehouse.objects.filter(branch=Branch.get_default()).order_by('created_at').first()             or Warehouse.objects.create(branch=Branch.get_default(), name='Main WH', code='WH-T')
        # Saved before this fix: the POS posted the deduction itself; stock_applied is null.
        inv = WholesaleInvoice.objects.create(
            invoice_number='WINV-100100', dealer=self.dealer, invoice_date='2026-10-01', due_date='2026-10-01',
            grand_total=2500, status='Partial',
            details={'items': [{'id': str(self.frame.id), 'qty': 25}], 'orderStatus': 'Confirmed'})
        res = self.client.post('/api/inventory/adjustments/', {
            'product': str(self.frame.id), 'warehouse': str(wh.id), 'quantity': 25,
            'adjustment_type': 'SUB', 'reason': 'Wholesale POS sale WINV-100100'}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(self._stock(self.frame), 75)

        self._patch({'id': str(inv.id)}, {'status': 'Cancelled', 'details': {**inv.details, 'orderStatus': 'Cancelled'}})
        self.assertEqual(self._stock(self.frame), 100)

    def test_bare_legacy_row_is_left_alone(self):
        inv = WholesaleInvoice.objects.create(
            invoice_number='WINV-100200', dealer=self.dealer, invoice_date='2026-10-01', due_date='2026-10-01',
            grand_total=2500, status='Partial')
        self._patch({'id': str(inv.id)}, {'status': 'Cancelled'})
        self.assertEqual(self._stock(self.frame), 100)
