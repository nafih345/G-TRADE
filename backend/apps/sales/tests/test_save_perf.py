"""New Sale save: a query budget that does not grow with the number of lines (every query is a
network round trip when hosted), and the stock it moves — including a product billed on two
lines, which the old per-line loop deducted only once."""
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from apps.company.models import BranchStock
from apps.financial.tests.helpers import make_product, make_warehouse
from apps.inventory.models import StockLedger


class SaleSaveTests(APITestCase):
    url = '/api/sales/invoices/'

    def setUp(self):
        make_warehouse()

    def line(self, product, qty=1, price=100):
        return {'product': str(product.pk), 'quantity': qty, 'unit_price': price, 'subtotal': qty * price}

    def post(self, items, number, splits=None):
        body = {'document_type': 'INVOICE', 'invoice_number': number, 'invoice_date': '2026-09-11',
                'status': 'PARTIAL', 'customer_name': 'Perf Patient', 'total_amount': 1000,
                'net_amount': 1000, 'paid_amount': 0, 'items': items,
                'payment_splits': splits or {'cash': 50, 'upi': 20}}
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post(self.url, body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res

    def test_query_count_does_not_grow_with_lines(self):
        def queries_for(n, number):
            prods = [make_product(name=f'{number}-{i}') for i in range(n)]
            with CaptureQueriesContext(connection) as ctx:
                self.post([self.line(p) for p in prods], number)
            return len(ctx.captured_queries)
        queries_for(1, 'INV-WARM')  # first posting creates voucher types / sequences once
        self.assertEqual(queries_for(2, 'INV-A'), queries_for(10, 'INV-B'))

    def test_product_on_two_lines_is_deducted_for_both(self):
        frame = make_product(name='Twice', stock=10)
        res = self.post([self.line(frame, 2), self.line(frame, 3)], 'INV-TWICE')
        frame.refresh_from_db()
        self.assertEqual(frame.stock, 5)
        self.assertEqual(BranchStock.objects.get(product=frame).quantity, 5)
        self.assertEqual(list(StockLedger.objects.filter(reference_id=res.data['id'], product=frame)
                              .values_list('quantity', flat=True)), [-5])
        # The response carries the saved lines and receipts (prefetched once, not re-read per field).
        self.assertEqual(len(res.data['items']), 2)
        self.assertEqual(res.data['payment_splits']['cash'], '50.00')

    def test_edit_moves_stock_both_ways_in_one_save(self):
        a, b = make_product(name='EA', stock=10), make_product(name='EB', stock=10)
        res = self.post([self.line(a, 4), self.line(b, 1)], 'INV-EDIT')
        with self.captureOnCommitCallbacks(execute=True):
            put = self.client.patch(f"{self.url}{res.data['id']}/",
                                    {'items': [self.line(a, 1), self.line(b, 3)]}, format='json')
        self.assertEqual(put.status_code, 200, put.content)
        a.refresh_from_db(); b.refresh_from_db()
        self.assertEqual((a.stock, b.stock), (9, 7))  # 3 of A back on the shelf, 2 more of B out
