"""Two-stage Excel import: the whole file is previewed before anything is written, repeats are
skipped, and an existing product's stock waits for review in Stock Overview."""
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.files.uploadedfile import SimpleUploadedFile
from rest_framework.test import APIClient

from apps.financial.tests.helpers import make_warehouse
from apps.inventory.models import StockAdjustment, StockLedger
from apps.products import import_engine
from apps.products.import_engine import run_import_job
from apps.products.models import ImportBatch, ImportPreviewRow, Product
from apps.products.tests.test_import_engine import HEADERS, ImportCase, row, sheet_rows, write_xlsx

REVIEW = '/api/inventory/stock-overview/import-review/'


class PreviewCase(ImportCase):
    def upload(self, rows, strategy='UPDATE'):
        self.seq += 1
        path = f'{self.tmp}/up{self.seq}.xlsx'
        write_xlsx(path, {'Stock': sheet_rows(rows)})
        with open(path, 'rb') as f, mock.patch.object(import_engine, 'start_import_thread'):
            res = APIClient().post('/api/import/upload/', {
                'file': SimpleUploadedFile('up.xlsx', f.read()), 'duplicate_strategy': strategy})
        self.assertEqual(res.status_code, 202, res.data)
        run_import_job(res.data['batch_id'])
        return ImportBatch.objects.get(id=res.data['batch_id'])

    def preview(self, batch, **params):
        res = APIClient().get(f'/api/import/{batch.id}/preview/', {'page_size': 500, **params})
        self.assertEqual(res.status_code, 200, res.data)
        return res.data

    def confirm(self, batch):
        with mock.patch.object(import_engine, 'start_import_thread'):
            res = APIClient().post(f'/api/import/{batch.id}/confirm/')
        self.assertEqual(res.status_code, 202, res.data)
        run_import_job(batch.id)
        return ImportBatch.objects.get(id=batch.id)


class PreviewTests(PreviewCase):
    def messy(self):
        rows = [row(i) for i in range(6)]
        rows.append(dict(rows[2]))                 # true repeat of the third row
        rows.append(row(7, Stock=-1))              # invalid
        rows.append(row(8, Code=None, Barcode=None, Item_Name=None))   # nothing to identify it
        return rows

    def test_upload_writes_nothing_and_previews_every_row(self):
        b = self.upload(self.messy())
        self.assertEqual(b.status, 'AWAITING_CONFIRMATION', b.remarks)
        self.assertEqual(Product.objects.count(), 0)
        data = self.preview(b)
        self.assertEqual(data['column_headers'], HEADERS)
        self.assertEqual(data['summary'], dict(total=9, valid=6, new=6, update=0, duplicate=1, error=2))
        kinds = [r['kind'] for r in data['results']]
        self.assertEqual(kinds, ['NEW'] * 6 + ['DUPLICATE', 'ERROR', 'ERROR'])
        self.assertEqual(data['results'][6]['message'], 'Repeats row 4 of Stock')
        self.assertEqual(data['results'][0]['cells']['Item Name'], 'Frame 0')
        self.assertEqual([r['row_number'] for r in self.preview(b, kind='skipped')['results']], [8, 9, 10])
        self.assertEqual(len(self.preview(b, kind='valid')['results']), 6)

    def test_confirm_imports_only_valid_rows_and_records_history(self):
        b = self.confirm(self.upload(self.messy()))
        self.assertEqual((b.imported_rows, b.duplicate_rows, b.failed_rows), (6, 1, 2), b.remarks)
        self.assertEqual(Product.objects.count(), 6)
        self.assertIsNotNone(b.completed_at)
        hist = APIClient().get('/api/import/history/').data[0]
        self.assertEqual((hist['batch_number'], hist['imported_rows'], hist['skipped_rows']), (b.batch_number, 6, 3))
        self.assertTrue(hist['completed_at'])
        self.assertFalse(ImportPreviewRow.objects.filter(batch=b).exists())    # only UPDATE rows are kept

    def test_nothing_valid_cannot_be_confirmed(self):
        b = self.upload([row(1, Stock=-1)])
        self.assertEqual(APIClient().post(f'/api/import/{b.id}/confirm/').status_code, 400)
        self.assertEqual(ImportBatch.objects.get(id=b.id).status, 'AWAITING_CONFIRMATION')

    def test_skip_strategy_shows_existing_products_as_duplicates(self):
        self.run_rows([row(1)])
        data = self.preview(self.upload([row(1), row(2)], strategy='SKIP'))
        self.assertEqual([r['kind'] for r in data['results']], ['DUPLICATE', 'NEW'])
        self.assertIn('Already in Products', data['results'][0]['message'])

    def test_update_row_shows_current_and_file_stock(self):
        self.run_rows([row(1, Stock=4)])
        data = self.preview(self.upload([row(1, Stock=9)]))
        r = data['results'][0]
        self.assertEqual((r['kind'], r['existing_stock'], r['file_stock']), ('UPDATE', 4, 9))


class StockReviewTests(PreviewCase):
    def setUp(self):
        super().setUp()
        self.wh = make_warehouse()
        self.admin = get_user_model().objects.create_user(username='boss', password='x', role='SUPER_ADMIN')
        self.api = APIClient()
        self.api.force_authenticate(self.admin)
        self.run_rows([row(1, Stock=4), row(2, Stock=6), row(3, Stock=8)])
        self.batch = self.confirm(self.upload([row(1, Stock=10), row(2, Stock=6), row(3, Stock=2), row(4, Stock=5)]))

    def review(self, section):
        res = self.api.get(REVIEW, {'batch': self.batch.id, 'section': section})
        self.assertEqual(res.status_code, 200, res.data)
        return res.data

    def test_import_keeps_existing_stock_and_lists_it_apart(self):
        self.assertEqual(dict(Product.objects.values_list('sku', 'stock')),
                         {'SKU00001': 4, 'SKU00002': 6, 'SKU00003': 8, 'SKU00004': 5})
        data = self.review('existing')
        self.assertEqual(data['batch']['new_products'], 1)
        self.assertEqual(data['batch']['existing_products'], 3)
        self.assertEqual(data['batch']['pending_stock'], 2)
        rows = {r['sku']: r for r in data['results']}
        self.assertEqual((rows['SKU00001']['file_quantity'], rows['SKU00001']['current_stock'],
                          rows['SKU00001']['review_status']), (10, 4, 'PENDING'))
        self.assertEqual(rows['SKU00002']['review_status'], 'NO_CHANGE')
        new = self.review('new')['results']
        self.assertEqual([(r['sku'], r['imported_quantity']) for r in new], [('SKU00004', 5)])
        grid = self.api.get('/api/inventory/stock-overview/', {'import_batch': self.batch.id}).data
        self.assertEqual(grid['count'], 4)

    def test_apply_goes_through_a_ledgered_adjustment_once(self):
        pending = self.review('pending')['results']
        first = next(r for r in pending if r['sku'] == 'SKU00001')
        res = self.api.post(REVIEW, {'batch': str(self.batch.id), 'row_ids': [first['id']], 'decision': 'apply'},
                            format='json')
        self.assertEqual((len(res.data['done']), res.data['failed']), (1, []), res.data)
        self.assertEqual(Product.objects.get(sku='SKU00001').stock, 10)
        adj = StockAdjustment.objects.get()
        self.assertEqual((adj.previous_quantity, adj.new_quantity, adj.reference), (4, 10, self.batch.batch_number))
        self.assertTrue(StockLedger.objects.filter(product__sku='SKU00001', transaction_type='ADJ_ADD').exists())
        again = self.api.post(REVIEW, {'batch': str(self.batch.id), 'row_ids': [first['id']], 'decision': 'apply'},
                              format='json')
        self.assertEqual(again.data['done'], [])
        self.assertEqual(StockAdjustment.objects.count(), 1)
        self.assertEqual(again.data['batch']['pending_stock'], 1)

    def test_keep_all_leaves_stock_alone(self):
        res = self.api.post(REVIEW, {'batch': str(self.batch.id), 'all': True, 'decision': 'keep'}, format='json')
        self.assertEqual(len(res.data['done']), 2)
        self.assertEqual(res.data['batch']['pending_stock'], 0)
        self.assertEqual(Product.objects.get(sku='SKU00003').stock, 8)
        self.assertFalse(StockAdjustment.objects.exists())

    def test_batches_list_and_permissions(self):
        listed = self.api.get('/api/inventory/stock-overview/import-batches/').data
        mine = next(b for b in listed if b['id'] == str(self.batch.id))
        self.assertEqual((mine['pending_stock'], mine['new_products']), (2, 1))
        cashier = get_user_model().objects.create_user(username='till', password='x', role='CASHIER')
        other = APIClient()
        other.force_authenticate(cashier)
        res = other.post(REVIEW, {'batch': str(self.batch.id), 'all': True, 'decision': 'apply'}, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertIn(APIClient().get(REVIEW, {'batch': self.batch.id}).status_code, (401, 403))
