"""Purchase Entry save: stock/ledger correctness of the batched path, and a query budget that
does not grow with the number of lines (every query is a network round trip when hosted)."""
from django.db import connection
from django.test.utils import CaptureQueriesContext
from rest_framework.test import APITestCase

from apps.company.models import BranchStock
from apps.financial.tests.helpers import TODAY, make_product, make_warehouse
from apps.inventory.models import StockLedger
from apps.products.models import Product
from apps.purchasing.models import Supplier


class PurchaseEntrySaveTests(APITestCase):
    def setUp(self):
        self.wh = make_warehouse()
        self.supplier = Supplier.objects.create(name='Hoya', supplier_code='SUP-10')

    def body(self, items, **kw):
        return {'invoice_number': 'PE-PERF', 'supplier': str(self.supplier.pk), 'purchase_date': TODAY.isoformat(),
                'purchase_type': 'CREDIT', 'payment_method': 'CREDIT', 'status': 'CONFIRMED',
                'grand_total': 2000, 'balance_amount': 2000, 'items': items, **kw}

    def line(self, product, qty, free=0, rate=100, price=200):
        return {'product': str(product.pk), 'quantity': qty, 'free_quantity': free, 'purchase_rate': rate,
                'selling_price': price, 'line_total': qty * rate}

    def post(self, body):
        with self.captureOnCommitCallbacks(execute=True):
            res = self.client.post('/api/purchase/invoices/', body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res

    def test_query_count_does_not_grow_with_lines(self):
        def queries_for(n, number):
            prods = [make_product(name=f'{number}-{i}') for i in range(n)]
            with CaptureQueriesContext(connection) as ctx:
                self.post(self.body([self.line(p, 2) for p in prods], invoice_number=number))
            return len(ctx.captured_queries)
        queries_for(1, 'PE-WARM')  # first posting creates voucher types / sequences once
        self.assertEqual(queries_for(2, 'PE-A'), queries_for(12, 'PE-B'))

    def test_stock_prices_and_ledger(self):
        a, b = make_product(name='A', stock=10), make_product(name='B', stock=0)
        res = self.post(self.body([self.line(a, 3, free=1, rate=150, price=300), self.line(b, 5),
                                   self.line(a, 2)]))  # A on two lines: both count
        self.assertEqual(res.data['items'][0]['product_name'], 'A')
        a.refresh_from_db(); b.refresh_from_db()
        self.assertEqual((a.stock, b.stock), (16, 5))
        self.assertEqual(BranchStock.objects.get(product=a).quantity, 16)
        self.assertEqual(a.retail_price, 200)  # last line wins, as before
        self.assertEqual(list(StockLedger.objects.filter(reference_id=res.data['id'], product=a)
                              .values_list('quantity', flat=True)), [6])

        # Edit: reverse what was received, then apply the new lines.
        with self.captureOnCommitCallbacks(execute=True):
            put = self.client.put(f"/api/purchase/invoices/{res.data['id']}/",
                                  self.body([self.line(a, 1)]), format='json')
        self.assertEqual(put.status_code, 200, put.content)
        a.refresh_from_db(); b.refresh_from_db()
        self.assertEqual((a.stock, b.stock), (11, 0))
        self.assertEqual(StockLedger.objects.filter(reference_id=res.data['id']).count(), 1)

    def test_unknown_product_is_rejected(self):
        bad = self.line(make_product(name='C'), 1)
        bad['product'] = '00000000-0000-0000-0000-000000000000'
        res = self.client.post('/api/purchase/invoices/', self.body([bad]), format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('items', res.data)
        self.assertFalse(Product.objects.filter(pk=bad['product']).exists())
