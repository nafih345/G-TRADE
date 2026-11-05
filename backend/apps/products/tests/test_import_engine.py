"""Excel import accounting: every source row ends up in the database or in a named bucket."""
import csv
import os
import re
import shutil
import tempfile
import zipfile

from unittest import mock

from django.core.files.base import ContentFile
from django.core.files.uploadedfile import SimpleUploadedFile
from django.db import OperationalError
from django.test import SimpleTestCase, TransactionTestCase, override_settings
from openpyxl import Workbook
from rest_framework.test import APIClient

from apps.products import import_engine
from apps.products.import_engine import resolve_field_headers, run_import_job
from apps.products.models import ImportBatch, ImportErrorLog, Product

HEADERS = ['Barcode', 'Category', 'Brand', 'Item Name', 'Code', 'Color', 'Size', 'Cost', 'MRP', 'Stock']


def row(i, **over):
    data = dict(zip(HEADERS, [f'BC{i:05d}', 'Frames', 'RayBan', f'Frame {i}', f'SKU{i:05d}', 'Black', '52', 100, 200, 5]))
    data.update({k.replace('_', ' '): v for k, v in over.items()})
    return data


def sheet_rows(rows, headers=HEADERS):
    return [headers] + [[r.get(h) for h in headers] for r in rows]


def write_xlsx(path, sheets):
    wb = Workbook()
    wb.remove(wb.active)
    for title, rows in sheets.items():
        ws = wb.create_sheet(title)
        for r in rows:
            ws.append(r)
    wb.save(path)


def with_stale_dimension(path, ref):
    """Rewrites the sheet's <dimension> the way exporters that don't maintain it leave it."""
    out = path + '.tmp'
    with zipfile.ZipFile(path) as src, zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED) as dst:
        for name in src.namelist():
            data = src.read(name)
            if name.startswith('xl/worksheets/'):
                data = re.sub(rb'<dimension[^>]*>', f'<dimension ref="{ref}"/>'.encode(), data)
            dst.writestr(name, data)
    shutil.move(out, path)


class ImportCase(TransactionTestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
        media = override_settings(MEDIA_ROOT=self.tmp)
        media.enable()
        self.addCleanup(media.disable)
        self.seq = 0

    def run_file(self, path, strategy='UPDATE'):
        self.seq += 1
        with open(path, 'rb') as f:
            data = f.read()
        batch = ImportBatch(batch_number=f'T-{self.seq}-{os.getpid()}', file_name=os.path.basename(path),
                            duplicate_strategy=strategy, file_data=data)
        batch.file.save(os.path.basename(path), ContentFile(data), save=False)
        batch.save()
        run_import_job(batch.id)
        return ImportBatch.objects.get(id=batch.id)

    def run_sheets(self, sheets, strategy='UPDATE'):
        path = os.path.join(self.tmp, f'in{self.seq}.xlsx')
        write_xlsx(path, sheets)
        return self.run_file(path, strategy)

    def run_rows(self, rows, strategy='UPDATE', headers=HEADERS):
        return self.run_sheets({'Stock': sheet_rows(rows, headers)}, strategy)

    def assertAccounted(self, b):
        """total = created + updated + duplicates + failed, and the table agrees."""
        self.assertEqual(b.total_rows, b.imported_rows + b.updated_rows + b.duplicate_rows + b.failed_rows,
                         (b.status, b.remarks))
        self.assertEqual(Product.objects.filter(import_batch=b).count(), b.imported_rows + b.updated_rows,
                         (b.status, b.remarks))


class CompletenessTests(ImportCase):
    def test_stale_dimension_does_not_truncate(self):
        path = os.path.join(self.tmp, 'stale.xlsx')
        write_xlsx(path, {'Stock': sheet_rows([row(i) for i in range(2400)])})
        with_stale_dimension(path, 'A1:J1801')
        b = self.run_file(path)
        self.assertEqual(b.status, 'SUCCESS', b.remarks)
        self.assertEqual((b.total_rows, b.imported_rows), (2400, 2400))
        self.assertEqual(Product.objects.count(), 2400)
        self.assertAccounted(b)

    def test_one_undefined_row_does_not_fail_its_chunk(self):
        rows = [row(i) for i in range(2400)]
        rows[700]['Cost'] = 123456789012345      # overflows DecimalField(12,2)
        b = self.run_rows(rows)
        self.assertEqual((b.imported_rows, b.failed_rows), (2399, 1), b.remarks)
        self.assertEqual(Product.objects.count(), 2399)
        self.assertEqual(ImportErrorLog.objects.filter(batch=b).count(), 1)
        self.assertAccounted(b)

    def test_soft_deleted_product_does_not_block_its_sku(self):
        Product.objects.create(name='Old', sku='SKU00003', barcode='BC00003', retail_price=1, cost_price=1)
        Product.objects.filter(sku='SKU00003').delete()
        b = self.run_rows([row(i) for i in range(600)])
        self.assertEqual((b.imported_rows, b.failed_rows), (600, 0), b.remarks)
        self.assertEqual(Product.objects.count(), 600)
        self.assertAccounted(b)

    def test_replace_strategy_replaces(self):
        self.run_rows([row(i) for i in range(50)])
        b = self.run_rows([row(i, MRP=999) for i in range(50)], strategy='REPLACE')
        self.assertEqual((b.failed_rows, b.updated_rows), (0, 50), b.remarks)
        self.assertEqual(Product.objects.count(), 50)
        self.assertEqual(Product.objects.get(sku='SKU00007').retail_price, 999)
        self.assertAccounted(b)

    def test_second_worksheet_is_imported(self):
        b = self.run_sheets({'Frames': sheet_rows([row(i) for i in range(1800)]),
                             'Lenses': sheet_rows([row(i) for i in range(1800, 2400)])})
        self.assertEqual((b.imported_rows, Product.objects.count()), (2400, 2400), b.remarks)
        self.assertAccounted(b)

    def test_rows_without_any_identifier_are_reported(self):
        rows = [row(i) for i in range(5)] + [{'Category': 'Frames', 'Brand': 'RayBan'}]
        b = self.run_rows(rows)
        self.assertEqual((b.imported_rows, b.failed_rows), (5, 1), b.remarks)
        self.assertAccounted(b)

    def test_blank_rows_are_not_counted(self):
        rows = [row(0), {}, row(1), {}, {}]
        b = self.run_rows(rows)
        self.assertEqual((b.total_rows, b.imported_rows), (2, 2), b.remarks)
        self.assertAccounted(b)

    def test_csv_with_nul_byte(self):
        path = os.path.join(self.tmp, 'nul.csv')
        with open(path, 'w', newline='', encoding='utf-8') as f:
            w = csv.writer(f)
            w.writerows(sheet_rows([row(i, Item_Name=f'Bad\x00{i}') for i in range(600)]))
        b = self.run_file(path)
        self.assertEqual((b.imported_rows, b.failed_rows), (600, 0), b.remarks)
        self.assertAccounted(b)

    def test_numeric_codes_stay_clean(self):
        rows = [row(1, Barcode=8901234567890.0, Code=1001.0), row(2, Barcode=0, Code=1002)]
        b = self.run_rows(rows)
        self.assertEqual(b.imported_rows, 2, b.remarks)
        self.assertTrue(Product.objects.filter(sku='1001', barcode='8901234567890').exists())
        self.assertNotEqual(Product.objects.get(sku='1002').barcode, '0')


class DuplicateTests(ImportCase):
    def test_same_code_different_colours_are_separate_products(self):
        rows = [row(i, Code='RB3025', Color=c, Barcode=None) for i, c in enumerate(['Black', 'Gold', 'Silver', 'Blue'])]
        b = self.run_rows(rows)
        self.assertEqual((b.imported_rows, b.duplicate_rows, b.failed_rows), (4, 0, 0), b.remarks)
        self.assertEqual(Product.objects.count(), 4)
        self.assertAccounted(b)

    def test_repeated_row_is_a_duplicate_and_neighbours_survive(self):
        rows = [row(i) for i in range(600)]
        rows[100] = dict(rows[99])
        rows[550] = dict(rows[98])
        b = self.run_rows(rows)
        self.assertEqual((b.imported_rows, b.duplicate_rows, b.failed_rows), (598, 2, 0), b.remarks)
        self.assertEqual(Product.objects.count(), 598)
        self.assertEqual(b.total_rows, 600)

    def test_reimport_updates_every_row_without_new_products(self):
        rows = [row(i, Code='RB3025', Color=f'C{i}', Barcode=None) for i in range(6)] + [row(i) for i in range(10, 16)]
        rows += [row(30 + i, Code=None, Barcode=None, Item_Name=f'Nameless {i}') for i in range(4)]
        first = self.run_rows(rows)
        self.assertEqual((first.imported_rows, first.failed_rows), (16, 0), first.remarks)
        again = self.run_rows(rows)
        self.assertEqual((again.imported_rows, again.updated_rows, again.failed_rows), (0, 16, 0), again.remarks)
        self.assertEqual(Product.objects.count(), 16)
        self.assertAccounted(again)

    def test_skip_strategy_counts_existing_rows_as_duplicates(self):
        self.run_rows([row(i) for i in range(20)])
        b = self.run_rows([row(i) for i in range(30)], strategy='SKIP')
        self.assertEqual((b.imported_rows, b.duplicate_rows, b.failed_rows), (10, 20, 0), b.remarks)
        self.assertEqual(Product.objects.count(), 30)

    def test_barcode_on_another_code_fails_only_that_row(self):
        rows = [row(i) for i in range(600)]
        rows[10]['Barcode'] = rows[9]['Barcode']
        b = self.run_rows(rows)
        self.assertEqual((b.imported_rows, b.failed_rows), (599, 1), b.remarks)
        self.assertEqual(ImportErrorLog.objects.get(batch=b).error_type, 'DUPLICATE_BARCODE')
        self.assertAccounted(b)

    def test_row_without_code_matches_by_barcode(self):
        self.run_rows([row(1)])
        b = self.run_rows([row(1, Code=None, MRP=777)])
        self.assertEqual((b.imported_rows, b.updated_rows, b.failed_rows), (0, 1, 0), b.remarks)
        self.assertEqual(Product.objects.get().retail_price, 777)

    def test_duplicate_strategy_creates_copies(self):
        self.run_rows([row(1)])
        b = self.run_rows([row(1), row(1)], strategy='DUPLICATE')
        self.assertEqual((b.imported_rows, b.failed_rows), (2, 0), b.remarks)
        self.assertEqual(Product.objects.count(), 3)


class ResilienceTests(ImportCase):
    def interrupted(self, rows, strategy='UPDATE', after_chunks=1):
        """Runs an import that dies after some chunks, then resumes it the way the watchdog does."""
        path = os.path.join(self.tmp, 'resume.xlsx')
        write_xlsx(path, {'Stock': sheet_rows(rows)})
        real = import_engine._process_chunk
        calls = []

        def die_later(*args):
            calls.append(1)
            if len(calls) > after_chunks:
                raise KeyboardInterrupt    # not an Exception: like the thread being killed
            return real(*args)

        with mock.patch.object(import_engine, '_process_chunk', die_later):
            with self.assertRaises(KeyboardInterrupt):
                self.run_file(path, strategy)
        batch = ImportBatch.objects.get()
        self.assertEqual((batch.status, batch.processed_rows), ('PROCESSING', after_chunks * import_engine.CHUNK_SIZE))
        run_import_job(batch.id)
        return ImportBatch.objects.get(id=batch.id)

    def test_resume_finishes_without_loss_or_double_counting(self):
        b = self.interrupted([row(i) for i in range(1200)])
        self.assertEqual((b.status, b.total_rows, b.imported_rows), ('SUCCESS', 1200, 1200), b.remarks)
        self.assertEqual(Product.objects.count(), 1200)
        self.assertAccounted(b)

    def test_resume_still_recognises_rows_written_before_the_crash(self):
        rows = [row(i) for i in range(700)]
        rows[650] = dict(rows[3])                                               # true repeat across the crash
        rows[651] = row(651, Code=rows[4]['Code'], Color='Gold', Barcode=None)  # variant across the crash
        b = self.interrupted(rows)
        self.assertEqual((b.imported_rows, b.duplicate_rows, b.failed_rows), (699, 1, 0), b.remarks)
        self.assertEqual(Product.objects.count(), 699)
        self.assertAccounted(b)

    def test_database_blip_retries_the_chunk(self):
        real = import_engine._apply_plans
        fails = [OperationalError('server closed the connection')]

        def flaky(*args):
            if fails:
                raise fails.pop()
            return real(*args)

        with mock.patch.object(import_engine, '_apply_plans', flaky), mock.patch.object(import_engine.time, 'sleep'):
            b = self.run_rows([row(i) for i in range(600)])
        self.assertEqual((b.status, b.imported_rows, b.failed_rows), ('SUCCESS', 600, 0), b.remarks)
        self.assertEqual(Product.objects.count(), 600)

    def test_database_outage_leaves_the_job_resumable(self):
        def down(*args):
            raise OperationalError('could not connect')

        with mock.patch.object(import_engine, '_apply_plans', down), mock.patch.object(import_engine.time, 'sleep'):
            b = self.run_rows([row(i) for i in range(100)])
        self.assertEqual((b.status, b.failed_rows), ('PROCESSING', 0))
        self.assertIsNotNone(ImportBatch.objects.get(id=b.id).file_data)
        run_import_job(b.id)
        b = ImportBatch.objects.get(id=b.id)
        self.assertEqual((b.status, b.imported_rows), ('SUCCESS', 100), b.remarks)

    def test_failed_write_does_not_poison_later_rows(self):
        rows = [row(i) for i in range(10)]
        real = Product.objects.bulk_create

        def reject_bad(objs, **kw):
            if any(o.sku == 'SKU00003' for o in objs):
                raise ValueError('rejected')
            return real(objs, **kw)

        with mock.patch.object(Product.objects, 'bulk_create', reject_bad):
            b = self.run_rows(rows + [dict(rows[3])])       # the later copy of the rejected row
        self.assertEqual(b.failed_rows, 1, b.remarks)
        self.assertEqual(b.duplicate_rows, 1, b.remarks)    # a repeat is skipped, never a second attempt
        self.assertEqual(b.imported_rows, 9, b.remarks)
        self.assertAccounted(b)


@override_settings(LOGIN_ENABLED_ROLES=['SUPER_ADMIN'])
class ApiTests(ImportCase):
    def test_upload_to_history_for_a_2400_row_messy_file(self):
        """The reported case end to end: shuffled columns, repeats, variants, junk, stale dimension."""
        order = ['Barcode', 'Category', 'Brand', 'Stock', 'Color', 'Item Name', 'Code', 'MRP', 'Cost', 'Size']
        rows = [row(i) for i in range(2400)]
        for i in range(0, 300):                     # 300 colours of one model code, no barcodes
            rows[i].update({'Code': 'RB-3025', 'Color': f'Colour {i}', 'Barcode': None})
        rows[2000] = dict(rows[1999])               # true repeat
        rows[2100]['Stock'] = -3                    # invalid
        rows[2200].update({'Code': None, 'Barcode': None, 'Item Name': None})   # nothing to identify it
        path = os.path.join(self.tmp, 'stock.xlsx')
        write_xlsx(path, {'Stock': sheet_rows(rows, order)})
        with_stale_dimension(path, 'A1:J1801')

        with open(path, 'rb') as f:
            upload = SimpleUploadedFile('stock.xlsx', f.read())
        with mock.patch.object(import_engine, 'start_import_thread', lambda pk: run_import_job(pk)):
            res = APIClient().post('/api/import/upload/', {'file': upload}, format='multipart')
            self.assertEqual(res.status_code, 202, res.data)
            self.assertEqual(Product.objects.count(), 0)    # only the preview so far
            self.assertEqual(APIClient().post(f"/api/import/{res.data['batch_id']}/confirm/").status_code, 202)

        hist = APIClient().get('/api/import/history/').data[0]
        self.assertEqual(hist['status'], 'PARTIAL', hist['remarks'])
        self.assertEqual((hist['total_rows'], hist['imported_rows'], hist['updated_rows'], hist['duplicate_rows'],
                          hist['failed_rows']), (2400, 2397, 0, 1, 2), hist['remarks'])
        self.assertEqual(Product.objects.count(), 2397)
        grid = APIClient().get(f"/api/import/{hist['id']}/rows/").data
        self.assertEqual(grid['count'], 2397)
        errors = APIClient().get(f"/api/import/{hist['id']}/errors/").data
        self.assertEqual(sorted(e['row_number'] for e in errors['results']), [2102, 2202])


class LayoutTests(ImportCase):
    def test_any_column_order(self):
        order = ['Stock', 'MRP', 'Brand', 'Barcode', 'Cost', 'Category', 'Item Name', 'Code', 'Size', 'Color']
        b = self.run_rows([row(1)], headers=order)
        p = Product.objects.get()
        self.assertEqual((p.barcode, p.sku, p.name, p.brand_name, p.stock), ('BC00001', 'SKU00001', 'Frame 1', 'RayBan', 5))
        self.assertEqual((float(p.cost_price), float(p.retail_price), p.color), (100.0, 200.0, 'Black'))
        self.assertAccounted(b)

    def test_barcode_only_rows_import(self):
        b = self.run_sheets({'S': [['Barcode', 'Category', 'Brand']] + [[f'89{i}', 'Frames', 'RayBan'] for i in range(10)]})
        self.assertEqual((b.imported_rows, b.failed_rows), (10, 0), b.remarks)
        self.assertEqual(Product.objects.filter(barcode='895').count(), 1)
        self.assertAccounted(b)

    def test_title_rows_above_the_header(self):
        rows = [['G Opticals'], ['Stock report 01-11-2026'], []] + sheet_rows([row(i) for i in range(5)])
        b = self.run_sheets({'S': rows})
        self.assertEqual(b.imported_rows, 5, b.remarks)
        self.assertEqual(Product.objects.get(sku='SKU00002').barcode, 'BC00002')

    def test_repeated_header_keeps_both_columns(self):
        headers = ['Code', 'Item Name', 'Stock', 'Stock']
        b = self.run_sheets({'S': [headers, ['A1', 'Frame', 4, 9]]})
        self.assertEqual(Product.objects.get().stock, 4)
        self.assertEqual(len(set(b.column_headers)), 4)

    def test_sheet_without_product_columns_is_skipped_and_logged(self):
        b = self.run_sheets({'Notes': [['Prepared by', 'Date'], ['Ravi', '01-11']],
                             'Stock': sheet_rows([row(1)])})
        self.assertEqual((b.status, b.imported_rows), ('SUCCESS', 1), b.remarks)
        self.assertTrue(any("'Notes' skipped" in line for line in b.logs))

    def test_file_with_no_recognisable_columns_fails_with_a_reason(self):
        b = self.run_sheets({'S': [['Foo', 'Bar'], ['1', '2']]})
        self.assertEqual(b.status, 'FAILED')
        self.assertIn('No product columns', b.remarks)


class HeaderMappingTests(SimpleTestCase):
    def assertMapped(self, headers, **expected):
        got = resolve_field_headers(headers)
        for field, header in expected.items():
            self.assertEqual(got.get(field), header, got)

    def test_codes_of_other_things_are_not_the_sku(self):
        for h in ('Color Code', 'HSN Code', 'Brand Code', 'Bar Code'):
            self.assertNotEqual(resolve_field_headers([h, 'Item Name']).get('sku'), h)

    def test_leftover_name_column_is_the_product_name(self):
        self.assertMapped(['Brand Name', 'Frame Name', 'Supplier Name'],
                          brand='Brand Name', name='Frame Name', supplier='Supplier Name')

    def test_spelling_variants(self):
        self.assertMapped(['BAR CODE', 'Item Name', 'Brand Name', 'Sale Rate', 'Purchase Rate', 'Qty'],
                          barcode='BAR CODE', name='Item Name', brand='Brand Name',
                          selling_price='Sale Rate', cost_price='Purchase Rate', stock='Qty')
        self.assertMapped(['SellingPrice', 'Colour', 'Product Code', 'Quantity'],
                          selling_price='SellingPrice', color_code='Colour', sku='Product Code', stock='Quantity')

    def test_sample_template_headers(self):
        self.assertMapped(['Barcode', 'SKU/Code', 'Product Name', 'Category', 'Brand', 'Cost Price (INR)',
                           'Selling Price (INR)', 'Stock Quantity', 'Supplier', 'Rack Location'],
                          barcode='Barcode', sku='SKU/Code', name='Product Name', cost_price='Cost Price (INR)',
                          selling_price='Selling Price (INR)', stock='Stock Quantity', address='Rack Location')

    def test_words_are_not_matched_inside_words(self):
        got = resolve_field_headers(['Display', 'Stage', 'Item Name'])
        self.assertNotIn('selling_price', got)
        self.assertNotIn('barcode', got)
