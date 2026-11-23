"""Every row of an uploaded sheet is accounted for: a product, an update, or another listing of an
item merged into it. Reproduces the reported 2,046-row stock sheet (1,787 imported) by its shape:
an untitled colour column, items listed once per lot, and barcodes reused for a different item."""
import random
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.db.models import Sum
from django.test import SimpleTestCase
from rest_framework.test import APIClient

from apps.products import import_engine
from apps.products.import_engine import _looks_like_colour, run_import_job
from apps.products.models import ImportBatch, ImportPreviewRow, Product
from apps.products.tests.test_import_engine import ImportCase, write_xlsx

# The reported sheet's own header row: the serial and colour columns have no title.
SHOP_HEADERS = [None, 'BAR CODE', None, 'ITEM_NAME_L', 'Model No.', 'Category', 'Sub Category', 'Group', 'Brand',
                None, 'Size', 'Sales Price', 'Cost Price', 'stock qty']


def shop_row(serial, barcode, model, colour, qty, brand='CHARLIE DUKE', category='FRAME', group='KIDS', cost=15):
    return [serial, barcode, None, None, model, category, 'TR', group, brand, colour, None, 25, cost, qty]


def shop_sheet(seed=7, items=1650):
    """
    A sheet shaped like the reported one: models in several colours, about a quarter of the
    rows without a barcode, items listed again for another lot, three barcodes reused for a
    different item. Returns (rows, distinct items, total quantity).
    """
    rnd = random.Random(seed)
    rows, keys, next_barcode = [], [], 1000
    while len(keys) < items:
        model = f'{rnd.randint(1000, 99999)}{rnd.choice(["", "A", "B"])}'
        brand = rnd.choice(['CHARLIE DUKE', 'MISTY', 'TED LASSO', 'MARK PHILIP'])
        for c in range(1, rnd.randint(2, 9)):
            key = (model, brand, f'C{c:02d}')
            if key in keys:
                continue
            barcode = None if rnd.random() < 0.25 else (next_barcode := next_barcode + 1)
            keys.append((key, barcode))
    for (model, brand, colour), barcode in keys[:items]:
        rows.append(shop_row(0, barcode, model, colour, rnd.randint(1, 30), brand=brand))
        if rnd.random() < 0.15:     # the same item, another lot
            rows.append(shop_row(0, barcode, model, colour, rnd.randint(1, 9), brand=brand))
    # Three barcodes typed onto a second, different item (another model / colour).
    for i in (40, 400, 900):
        donor = next(r for r in rows[i:] if r[1])
        rows.insert(i + 5, shop_row(0, donor[1], donor[4] + 'X', 'C01', 4, brand=donor[8]))
    for serial, r in enumerate(rows, start=1):
        r[0] = serial
    return rows, len(keys[:items]) + 3, sum(r[13] for r in rows)


class ColourColumnTests(SimpleTestCase):
    def test_colour_values(self):
        for v in ('C01', 'c1', 'COL 3', 'CLR-12', 'Colour 4', 'BLACK', 'Matt Black', 'gold/black'):
            self.assertTrue(_looks_like_colour(v), v)
        for v in ('1', '2045', 'TR', 'ACETATE', 'KIDS', '52-18', 'C01 2024', 'Rack A1'):
            self.assertFalse(_looks_like_colour(v), v)


class ReportedSheetTests(ImportCase):
    def write(self, rows, headers=SHOP_HEADERS):
        self.seq += 1
        path = f'{self.tmp}/shop{self.seq}.xlsx'
        write_xlsx(path, {'Sheet1': [headers] + rows})
        return path

    def post(self, path, strategy='UPDATE'):
        with open(path, 'rb') as f, mock.patch.object(import_engine, 'start_import_thread'):
            return APIClient().post('/api/import/upload/', {
                'file': SimpleUploadedFile('stock.xlsx', f.read()), 'duplicate_strategy': strategy})

    def upload(self, rows_or_path, strategy='UPDATE'):
        path = rows_or_path if isinstance(rows_or_path, str) else self.write(rows_or_path)
        res = self.post(path, strategy)
        self.assertEqual(res.status_code, 202, res.data)
        run_import_job(res.data['batch_id'])
        return ImportBatch.objects.get(id=res.data['batch_id'])

    def preview(self, batch, **params):
        res = APIClient().get(f'/api/import/{batch.id}/preview/', {'page_size': 500, **params})
        self.assertEqual(res.status_code, 200, res.data)
        return res.data

    def confirm(self, batch):
        with mock.patch.object(import_engine, 'start_import_thread'):
            self.assertEqual(APIClient().post(f'/api/import/{batch.id}/confirm/').status_code, 202)
        run_import_job(batch.id)
        return ImportBatch.objects.get(id=batch.id)

    def test_every_row_of_a_shop_stock_sheet_is_imported(self):
        rows, items, quantity = shop_sheet()
        b = self.upload(rows)
        s = b.preview_summary
        self.assertEqual((s['total'], s['error'], s['duplicate']), (len(rows), 0, 0), b.remarks)
        self.assertEqual(s['valid'], len(rows))
        self.assertEqual(s['new'], items)
        self.assertEqual(s['new'] + s['merged'], len(rows))
        self.assertIn('Colour', b.column_headers)

        b = self.confirm(b)
        self.assertEqual((b.status, b.total_rows, b.failed_rows, b.duplicate_rows), ('SUCCESS', len(rows), 0, 0),
                         b.remarks)
        self.assertEqual((b.imported_rows, b.merged_rows), (items, len(rows) - items), b.remarks)
        self.assertAccounted(b)
        self.assertEqual(Product.objects.count(), items)
        # Nothing is lost: the products hold every row's quantity, and no barcode twice.
        self.assertEqual(Product.objects.aggregate(q=Sum('stock'))['q'], quantity)
        codes = list(Product.objects.exclude(barcode=None).values_list('barcode', flat=True))
        self.assertEqual(len(codes), len(set(codes)))
        self.assertFalse(Product.objects.filter(color=None).exists())     # the untitled column is the colour

    def test_untitled_colour_column_keeps_colours_apart(self):
        rows = [shop_row(i, None, '030', f'C{i:02d}', 5) for i in range(1, 9)]
        b = self.confirm(self.upload(rows))
        self.assertEqual((b.imported_rows, b.merged_rows), (8, 0), b.remarks)
        self.assertEqual(sorted(Product.objects.values_list('color', flat=True)), [f'C{i:02d}' for i in range(1, 9)])

    def test_same_item_on_two_rows_is_one_product_with_both_quantities(self):
        rows = [shop_row(1, 1094, '72050', 'C01', 3), shop_row(2, 1094, '72050', 'C01', 2),
                shop_row(3, 1098, '72050', 'C05', 5)]
        b = self.upload(rows)
        data = self.preview(b)
        self.assertEqual([r['kind'] for r in data['results']], ['NEW', 'MERGED', 'NEW'])
        self.assertEqual(data['results'][1]['message'], 'Same item as row 2 of Sheet1: quantity 2 added to it')
        self.assertIn('quantities combined (5 in total)', data['results'][0]['message'])
        b = self.confirm(b)
        self.assertEqual(Product.objects.get(barcode='1094').stock, 5)
        self.assertEqual(Product.objects.count(), 2)

    def test_barcode_reused_for_another_model_imports_both(self):
        rows = [shop_row(1, 9247, '027', 'C01', 30), shop_row(2, 9247, '027A', 'C01', 12)]
        b = self.upload(rows)
        data = self.preview(b)
        self.assertEqual([r['kind'] for r in data['results']], ['NEW', 'NEW'])
        self.assertIn('Barcode 9247 is already on row 2 of Sheet1 (027), a different item; this row is imported '
                      'without it', data['results'][1]['message'])
        self.confirm(b)
        self.assertEqual(Product.objects.get(sku='027').barcode, '9247')
        self.assertIsNone(Product.objects.get(sku='027A').barcode)

    def test_reimport_leaves_stock_and_reviews_the_combined_quantity(self):
        path = self.write([shop_row(1, 1094, '72050', 'C01', 3), shop_row(2, 1094, '72050', 'C01', 2)])
        self.confirm(self.upload(path))
        Product.objects.filter(barcode='1094').update(stock=4)      # one sold since
        again = self.upload(path)
        first = ImportPreviewRow.objects.get(batch=again, row_number=2)
        self.assertEqual((first.kind, first.file_stock, first.existing_stock), ('UPDATE', 5, 4))
        self.assertEqual(again.preview_summary['previous_import']['batch_number'],
                         ImportBatch.objects.exclude(id=again.id).get().batch_number)
        again = self.confirm(again)
        self.assertEqual((again.updated_rows, again.merged_rows, again.imported_rows), (1, 1, 0), again.remarks)
        self.assertEqual(Product.objects.get(barcode='1094').stock, 4)    # never written by an import
        self.assertEqual(ImportPreviewRow.objects.get(batch=again).file_stock, 5)    # waits for the review

    def test_reimport_after_an_import_that_missed_the_colour_column(self):
        """
        The reported sheet was first imported by a version that didn't read the untitled colour
        column: its products have no colour and SKUs derived without one, and they hold the
        barcodes. Importing the same sheet now must find each of them (no DUPLICATE_BARCODE, no
        second product beside it), fill in its colour, and add only the items it missed.
        """
        rows, items, _quantity = shop_sheet(seed=11, items=1000)
        path = self.write(rows)
        with mock.patch.object(import_engine, '_name_unnamed_columns', lambda headers, *a: headers):
            old = self.confirm(self.upload(path))
        self.assertNotIn('Colour', old.column_headers)
        legacy = old.imported_rows
        self.assertLess(legacy, items)      # colours of one model looked like one item
        self.assertEqual(Product.objects.exclude(color=None).count(), 0)

        b = self.upload(path)
        s = b.preview_summary
        errors = list(ImportPreviewRow.objects.filter(batch=b, kind='ERROR').values_list('row_number', 'product_code', 'message', 'cells'))
        self.assertEqual((s['error'], s['duplicate'], s['update'], s['new']), (0, 0, legacy, items - legacy), (s, errors))
        self.assertEqual(s['valid'], len(rows))
        notes = ImportPreviewRow.objects.filter(batch=b, kind='UPDATE', message__contains='colour C').count()
        self.assertGreater(notes, 0)

        b = self.confirm(b)
        self.assertEqual((b.status, b.failed_rows, b.updated_rows, b.imported_rows), ('SUCCESS', 0, legacy, items - legacy),
                         b.remarks)
        self.assertAccounted(b)
        self.assertEqual(Product.objects.count(), items)        # the same products a fresh import makes
        self.assertFalse(Product.objects.filter(color=None).exists())
        codes = list(Product.objects.exclude(barcode=None).values_list('barcode', flat=True))
        self.assertEqual(len(codes), len(set(codes)))
        # Each old product took the colour of the very row it was made from.
        for colour, cells in Product.objects.filter(extra_data__has_key='Column 10').values_list('color', 'extra_data'):
            self.assertEqual(cells['Column 10'], colour)

        again = self.confirm(self.upload(path))
        self.assertEqual((again.imported_rows, again.updated_rows, again.failed_rows), (0, items, 0), again.remarks)
        self.assertEqual(Product.objects.count(), items)

    def test_barcode_already_on_an_item_listed_later_in_the_file(self):
        # An earlier import gave 9247 to 027A; this file lists 027 with it first, then 027A.
        Product.objects.create(name='CHARLIE DUKE FRAME', sku='027A', barcode='9247', retail_price=25, cost_price=15)
        Product.objects.create(name='Shop item', sku='OLD-1', barcode='5555', retail_price=1, cost_price=1)
        b = self.upload([shop_row(1, 9247, '027', 'C01', 30), shop_row(2, 9247, '027A', 'C01', 12),
                         shop_row(3, 5555, '031', 'C02', 1)])
        data = self.preview(b)
        self.assertEqual([r['kind'] for r in data['results']], ['NEW', 'UPDATE', 'ERROR'])
        self.assertIn('Barcode 9247 is already on 027A, a different item of this file; this row is imported '
                      'without it', data['results'][0]['message'])
        self.assertIn('Existing Product: Shop item (OLD-1)', data['results'][2]['message'])   # not in the file
        self.confirm(b)
        self.assertEqual(Product.objects.get(sku='027A').barcode, '9247')
        self.assertIsNone(Product.objects.get(sku='027').barcode)

    def test_uploading_the_same_file_again_replaces_its_unconfirmed_preview(self):
        path = self.write([shop_row(1, 1094, '72050', 'C01', 3)])
        first = self.upload(path)
        second = self.upload(path)
        self.assertFalse(ImportBatch.objects.filter(id=first.id).exists())
        self.assertFalse(ImportPreviewRow.objects.filter(batch_id=first.id).exists())
        self.assertEqual(ImportPreviewRow.objects.filter(batch=second).count(), 1)

        ImportBatch.objects.filter(id=second.id).update(status='PROCESSING')
        res = self.post(path)
        self.assertEqual(res.status_code, 409, res.data)
        self.assertIn(second.batch_number, res.data['error'])

    def test_a_preview_from_before_file_hashes_is_replaced_too(self):
        path = self.write([shop_row(1, 1094, '72050', 'C01', 3)])
        old = self.upload(path)
        ImportBatch.objects.filter(id=old.id).update(file_hash='')     # uploaded by the previous version
        new = self.upload(path)
        self.assertFalse(ImportBatch.objects.filter(id=old.id).exists())
        self.assertEqual(ImportBatch.objects.get().id, new.id)
