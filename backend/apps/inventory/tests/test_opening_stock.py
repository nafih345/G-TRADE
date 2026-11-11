"""Inventory → Opening Stock: manual / Excel loads become tagged products with ledgered stock,
one accounting entry per batch, duplicate checks, and the Stock Overview source filter."""
import io
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from openpyxl import Workbook
from rest_framework.test import APITestCase

from apps.company.models import BranchStock
from apps.financial.models import JournalEntry
from apps.financial.tests.helpers import lines_of, live, make_warehouse
from apps.inventory.models import OpeningStockBatch, StockLedger
from apps.products.models import Product

URL = '/api/inventory/opening-stock/'
OVERVIEW = '/api/inventory/stock-overview/'
D = Decimal


def item(name, qty, cost, **kw):
    return {'name': name, 'quantity': qty, 'cost_price': cost, **kw}


class OpeningStockTests(APITestCase):
    def setUp(self):
        self.wh = make_warehouse()
        User = get_user_model()
        self.admin = User.objects.create_user(username='boss', password='x', role='SUPER_ADMIN')
        self.cashier = User.objects.create_user(username='till', password='x', role='CASHIER')
        self.client.force_authenticate(self.admin)

    def save(self, rows, path='manual/', **body):
        with self.captureOnCommitCallbacks(execute=True):
            return self.client.post(URL + path, {'rows': rows, **body}, format='json')

    def test_manual_rows_become_tagged_products_with_ledgered_stock(self):
        res = self.save([
            item('Ray Aviator', 3, '400', barcode='8901', brand='RayBan', category='Frames', mrp='1200'),
            item('Lens Cloth', '1,000', '₹ 2.50'),
        ], client_token='t-1')
        self.assertEqual(res.status_code, 201, res.content)
        batch = OpeningStockBatch.objects.get()
        self.assertEqual((batch.batch_number, batch.method, batch.product_count, batch.total_quantity),
                         ('OS-000001', 'MANUAL', 2, 1003))
        self.assertEqual(batch.total_value, D('3700.00'))  # 3*400 + 1000*2.50
        av = Product.objects.get(barcode='8901')
        self.assertEqual((av.stock, av.opening_stock, av.stock_source, av.brand_name, av.category_name),
                         (3, 3, 'OPENING_STOCK', 'RayBan', 'Frames'))
        self.assertEqual((av.retail_price, av.wholesale_price, av.extra_data['mrp']), (D('1200'), D('1200'), 1200.0))
        self.assertTrue(av.sku)
        self.assertEqual(BranchStock.objects.get(product=av).quantity, 3)
        led = StockLedger.objects.get(product=av)
        self.assertEqual((led.transaction_type, led.quantity, led.source_type, led.reference_id, led.reference_number,
                          led.balance_after, led.unit_cost),
                         ('IN', 3, 'OPENING_STOCK', batch.pk, 'OS-000001', 3, D('400.00')))
        # One journal for the whole load, none per product.
        entry = live('inventory', 'opening_stock', batch.pk).get()
        self.assertEqual(lines_of(entry), {'1003': D('3700'), '3001': D('-3700')})
        self.assertFalse(JournalEntry.objects.filter(source_module='products').exists())
        # Editing the product later does not book its opening stock a second time.
        with self.captureOnCommitCallbacks(execute=True):
            av.cost_price = D('450')
            av.save()
        self.assertFalse(JournalEntry.objects.filter(source_module='products').exists())

    def test_retry_with_same_token_is_applied_once(self):
        rows = [item('Case', 5, '20')]
        self.assertEqual(self.save(rows, client_token='t-2').status_code, 201)
        again = self.save(rows, client_token='t-2')
        self.assertEqual(again.status_code, 200)
        self.assertTrue(again.data['replayed'])
        self.assertEqual(Product.objects.filter(name='Case').count(), 1)

    def test_invalid_rows_block_the_whole_save(self):
        res = self.save([item('Good', 2, '10'), item('', 0, ''), item('Neg', 1, '-5')])
        self.assertEqual(res.status_code, 400)
        errors = [r['errors'] for r in res.data['results']]
        self.assertEqual(errors[0], {})
        self.assertEqual(set(errors[1]), {'name', 'quantity', 'cost_price'})
        self.assertIn('cost_price', errors[2])
        self.assertFalse(Product.objects.exists())
        self.assertFalse(OpeningStockBatch.objects.exists())

    def test_duplicates_are_reported(self):
        Product.objects.create(name='Old Frame', sku='OLD-1', barcode='555')
        res = self.client.post(URL + 'validate/', {'rows': [
            item('A', 1, '1', barcode='555'),
            item('B', 1, '1', barcode='777'),
            item('C', 1, '1', barcode='777'),
            item('Wipe', 1, '1'), item('wipe', 2, '1'),
            item('old frame', 1, '1'),
        ]}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        r = res.data['results']
        self.assertEqual([x['status'] for x in r], ['error', 'ok', 'error', 'ok', 'duplicate', 'warning'])
        self.assertIn('Old Frame (OLD-1)', r[0]['errors']['barcode'])
        self.assertIn('row 2', r[2]['errors']['barcode'])
        self.assertTrue(r[0]['duplicate'] and r[2]['duplicate'])
        self.assertEqual(res.data['summary']['valid'], 4)
        # A soft duplicate (same name, no barcode) can still be saved deliberately.
        self.assertEqual(self.save([item('Wipe', 1, '1'), item('wipe', 2, '1')]).status_code, 201)

    def test_auto_barcode_fills_only_blank_codes(self):
        res = self.save([item('X', 1, '1'), item('Y', 1, '1', barcode='OWN-1')], auto_barcode=True)
        self.assertEqual(res.status_code, 201, res.content)
        x, y = Product.objects.get(name='X'), Product.objects.get(name='Y')
        self.assertTrue(x.barcode)
        self.assertEqual(y.barcode, 'OWN-1')

    def test_cashier_cannot_add_opening_stock(self):
        self.client.force_authenticate(self.cashier)
        self.assertEqual(self.save([item('X', 1, '1')]).status_code, 403)
        self.assertEqual(self.client.get(URL).status_code, 200)

    def test_parse_returns_headers_rows_and_suggested_mapping(self):
        wb = Workbook()
        ws = wb.active
        ws.append(['My Optical Shop stock list'])
        ws.append(['Sl', 'Item Name', 'Bar Code', 'Qty', 'Cost Price', 'MRP', 'Remarks'])
        ws.append([1, 'Frame A', 8901001, 4, 350, 900, 'x'])
        ws.append([])
        ws.append([2, 'Frame B', None, 2, 300, None, ''])
        buf = io.BytesIO()
        wb.save(buf)
        upload = SimpleUploadedFile('stock.xlsx', buf.getvalue())
        res = self.client.post(URL + 'parse/', {'file': upload}, format='multipart')
        self.assertEqual(res.status_code, 200, res.content)
        sheet = res.data['sheets'][0]
        self.assertEqual(sheet['header_row'], 2)
        self.assertEqual(sheet['headers'][1:4], ['Item Name', 'Bar Code', 'Qty'])
        self.assertEqual(sheet['suggested_mapping'],
                         {'name': 1, 'barcode': 2, 'quantity': 3, 'cost_price': 4, 'mrp': 5})
        self.assertEqual([r['row_number'] for r in sheet['rows']], [3, 5])
        self.assertEqual(sheet['rows'][0]['cells'][2], '8901001')

    def test_import_endpoint_and_stock_overview_source_filter(self):
        Product.objects.create(name='Bought', sku='B-1', stock=2)
        Product.objects.create(name='Imported', sku='I-1', stock=2, stock_source='EXCEL_IMPORT')
        res = self.save([item('Legacy', 7, '10', row_number=4)], path='import/', file_name='old.xlsx')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(res.data['batch']['method'], 'IMPORT')

        def names(source):
            data = self.client.get(OVERVIEW, {'source': source}).data
            return sorted(r['name'] for r in data['results'])
        self.assertEqual(names('ALL'), ['Bought', 'Imported', 'Legacy'])
        self.assertEqual(names('OPENING_STOCK'), ['Legacy'])
        self.assertEqual(names('EXCEL_IMPORT'), ['Imported'])
        self.assertEqual(names('PURCHASE'), ['Bought'])
        row = self.client.get(OVERVIEW, {'source': 'OPENING_STOCK'}).data['results'][0]
        self.assertEqual(row['stock_source'], 'OPENING_STOCK')
        counts = self.client.get(OVERVIEW + 'summary/', {'source': 'OPENING_STOCK'}).data['source_counts']
        self.assertEqual(counts, {'ALL': 3, 'OPENING_STOCK': 1, 'EXCEL_IMPORT': 1, 'PURCHASE': 1, 'RETURN': 0})
        batches = self.client.get(URL).data
        self.assertEqual([b['batch_number'] for b in batches], ['OS-000001'])
