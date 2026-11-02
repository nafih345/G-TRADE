"""Excel import at volume: the sheet's own text survives, partial sheets are safe, jobs queue."""
import datetime
import os
from decimal import Decimal
from unittest import mock

from django.test import SimpleTestCase
from openpyxl import Workbook
from rest_framework.test import APIClient

from apps.products import import_engine
from apps.products.import_engine import _numeric_format, _number_text, run_import_job
from apps.products.models import ImportBatch, ImportErrorLog, Product
from apps.products.tests.test_import_engine import ImportCase, row, sheet_rows


class NumberFormatTests(SimpleTestCase):
    def assertShows(self, value, number_format, expected):
        self.assertEqual(_number_text(value, _numeric_format(number_format)), expected)

    def test_formats(self):
        self.assertShows(123, '00000', '00123')
        self.assertShows(12.5, '0.00', '12.50')
        self.assertShows(1234567.5, '#,##0.00', '1,234,567.50')
        self.assertShows(0.18, '0%', '18%')
        self.assertShows(1200, '"₹"#,##0.00', '1,200.00')
        self.assertShows(1200, '[$₹-4009] #,##0.00', '1,200.00')
        self.assertShows(1200, '_(* #,##0.00_);_(* (#,##0.00);_(* "-"??_);_(@_)', '1,200.00')

    def test_formats_with_no_plain_reading_keep_the_raw_value(self):
        for fmt in ('General', '0.00E+00', 'dd-mm-yyyy', '@', ''):
            self.assertIsNone(_numeric_format(fmt), fmt)


class FormatPreservationTests(ImportCase):
    def formatted(self, cells):
        """cells: header -> (value, number_format). Imports one row."""
        wb = Workbook()
        ws = wb.active
        ws.append(list(cells))
        ws.append([v for v, _f in cells.values()])
        for i, (_v, fmt) in enumerate(cells.values(), start=1):
            if fmt:
                ws.cell(row=2, column=i).number_format = fmt
        path = os.path.join(self.tmp, f'fmt{self.seq}.xlsx')
        wb.save(path)
        return self.run_file(path)

    def test_leading_zeros_from_a_number_format(self):
        b = self.formatted({'Barcode': (12345678905, '000000000000'), 'Code': (42, '00000'), 'Item Name': ('Frame', None)})
        p = Product.objects.get()
        self.assertEqual((p.barcode, p.sku), ('012345678905', '00042'), b.remarks)

    def test_long_barcode_in_scientific_format_keeps_every_digit(self):
        self.formatted({'Barcode': (8901234567890, '0.00E+00'), 'Item Name': ('Frame', None)})
        self.assertEqual(Product.objects.get().barcode, '8901234567890')

    def test_sheet_text_is_kept_and_the_numbers_still_parse(self):
        self.formatted({'Code': ('A1', None), 'Item Name': ('Frame', None), 'Cost': (1250.5, '#,##0.00'),
                        'MRP': (2000, '"₹"#,##0.00'), 'Discount': (0.1, '0%'),
                        'Received': (datetime.datetime(2026, 11, 2), 'dd-mm-yyyy')})
        p = Product.objects.get()
        self.assertEqual((p.cost_price, p.retail_price), (Decimal('1250.50'), Decimal('2000.00')))
        self.assertEqual(p.extra_data['Cost'], '1,250.50')
        self.assertEqual(p.extra_data['Discount'], '10%')
        self.assertEqual(p.extra_data['Received'], '2026-11-02')

    def test_text_cells_are_untouched(self):
        self.run_rows([row(1, Code='007', Barcode='0012', Item_Name='Ray-Ban  "Aviator" 58/14')])
        p = Product.objects.get()
        self.assertEqual((p.sku, p.barcode, p.name), ('007', '0012', 'Ray-Ban  "Aviator" 58/14'))

    def test_preview_returns_the_sheet_in_its_own_order(self):
        order = ['Stock', 'Item Name', 'Barcode', 'Code', 'Discount Note']
        rows = [dict(row(i), **{'Item Name': f'Z{9 - i}', 'Discount Note': f'note {i}'}) for i in range(5)]
        b = self.run_rows(rows, headers=order)
        res = APIClient().get(f'/api/import/{b.id}/rows/').data
        self.assertEqual(res['column_headers'], order)
        self.assertEqual([r['source']['Discount Note'] for r in res['results']], [f'note {i}' for i in range(5)])

    def test_multi_sheet_preview_stays_in_file_order(self):
        b = self.run_sheets({'One': sheet_rows([row(i) for i in range(3)]),
                             'Two': sheet_rows([row(i) for i in range(3, 6)])})
        res = APIClient().get(f'/api/import/{b.id}/rows/').data
        self.assertEqual([r['sku'] for r in res['results']], [f'SKU{i:05d}' for i in range(6)])


class PartialSheetTests(ImportCase):
    def setUp(self):
        super().setUp()
        self.run_rows([row(1, Cost=100, MRP=200, Stock=7, Supplier='Essilor')],
                      headers=[*row(1), 'Supplier'])

    def assertKept(self, p):
        self.assertEqual((p.cost_price, p.stock, p.brand_name, p.supplier_name, p.color),
                         (100, 7, 'RayBan', 'Essilor', 'Black'))

    def test_two_column_price_list_changes_only_the_price(self):
        b = self.run_sheets({'S': [['Barcode', 'MRP'], ['BC00001', 555]]})
        self.assertEqual((b.imported_rows, b.updated_rows), (0, 1), b.remarks)
        p = Product.objects.get()
        self.assertEqual(p.retail_price, 555)
        self.assertKept(p)
        self.assertEqual(p.extra_data['Item Name'], 'Frame 1')      # earlier columns survive too

    def test_update_ignores_blank_cells(self):
        self.run_sheets({'S': [['Code', 'Cost', 'Stock', 'MRP'], ['SKU00001', None, None, 300]]})
        p = Product.objects.get()
        self.assertEqual(p.retail_price, 300)
        self.assertKept(p)

    def test_replace_clears_blank_cells_but_not_missing_columns(self):
        self.run_sheets({'S': [['Code', 'Stock', 'MRP'], ['SKU00001', None, 300]]}, strategy='REPLACE')
        p = Product.objects.get()
        self.assertEqual((p.stock, p.retail_price, p.cost_price, p.brand_name), (0, 300, 100, 'RayBan'))


class ValueIntegrityTests(ImportCase):
    def test_blank_stock_is_zero_not_one(self):
        self.run_rows([row(1, Stock=None)])
        self.assertEqual(Product.objects.get().stock, 0)

    def test_price_that_is_not_a_number_fails_the_row_instead_of_becoming_zero(self):
        b = self.run_rows([row(1, MRP='ask manager'), row(2)])
        self.assertEqual((b.imported_rows, b.failed_rows), (1, 1), b.remarks)
        self.assertIn('ask manager', ImportErrorLog.objects.get(batch=b).error_message)

    def test_common_price_spellings_parse(self):
        for i, text in enumerate(['Rs. 1,250', '₹1,250', '1250/-', 'INR 1250']):
            self.run_rows([row(i, MRP=text)])
            self.assertEqual(Product.objects.get(sku=f'SKU{i:05d}').retail_price, 1250, text)


class QueueTests(ImportCase):
    def queued(self, name, rows, status='PENDING', **kw):
        path = os.path.join(self.tmp, name)
        from apps.products.tests.test_import_engine import write_xlsx
        write_xlsx(path, {'Stock': sheet_rows(rows)})
        with open(path, 'rb') as f:
            return ImportBatch.objects.create(batch_number=name, file_name=name, file_data=f.read(), status=status, **kw)

    def test_second_import_waits_then_runs_after_the_first(self):
        first = self.queued('a.xlsx', [row(i) for i in range(3)])
        second = self.queued('b.xlsx', [row(i) for i in range(3, 6)])

        started = []
        with mock.patch.object(import_engine, 'start_import_thread', lambda pk: started.append(pk)):
            ImportBatch.objects.filter(id=first.id).update(status='PROCESSING')
            run_import_job(second.id)
            second.refresh_from_db()
            self.assertEqual(second.status, 'PENDING')
            self.assertIn('a.xlsx', second.remarks)

            run_import_job(first.id)
        self.assertEqual(started, [second.id])
        run_import_job(second.id)
        self.assertEqual(Product.objects.count(), 6)
        self.assertEqual(ImportBatch.objects.get(id=second.id).status, 'SUCCESS')

    def test_stale_running_batch_does_not_block_the_queue(self):
        dead = self.queued('dead.xlsx', [row(1)], status='PROCESSING')
        ImportBatch.objects.filter(id=dead.id).update(
            updated_at=import_engine.timezone.now() - datetime.timedelta(seconds=import_engine.STALE_AFTER_SECONDS + 5))
        waiting = self.queued('b.xlsx', [row(2)])
        with mock.patch.object(import_engine, 'start_import_thread'):
            run_import_job(waiting.id)
        self.assertEqual(ImportBatch.objects.get(id=waiting.id).status, 'SUCCESS')

    def test_job_stops_when_another_copy_takes_over(self):
        rows = [row(i) for i in range(import_engine.CHUNK_SIZE * 2 + 1)]
        b = self.queued('gone.xlsx', rows)
        real = import_engine._process_chunk
        calls = []

        def other_copy_moves_on(batch, *args):
            calls.append(1)
            return real(batch, *args)

        real_save = ImportBatch.save

        def save(batch, *args, **kwargs):
            real_save(batch, *args, **kwargs)
            if batch.processed_rows:     # first chunk committed; a second copy advances past it
                ImportBatch.objects.filter(pk=batch.pk).update(processed_rows=batch.processed_rows + 1)

        with mock.patch.object(import_engine, '_process_chunk', other_copy_moves_on), \
                mock.patch.object(ImportBatch, 'save', save):
            run_import_job(b.id)
        self.assertEqual(len(calls), 1)
        self.assertEqual(ImportBatch.objects.get(id=b.id).status, 'PROCESSING')

    def test_restarts_are_only_fatal_when_stuck_on_one_row(self):
        logs = [f'10:00:00 - Resuming after interruption at row {n}' for n in range(500, 5000, 500)]
        b = self.queued('many.xlsx', [row(i) for i in range(5)], status='PROCESSING', logs=logs)
        run_import_job(b.id)
        self.assertEqual(ImportBatch.objects.get(id=b.id).status, 'SUCCESS')

        logs = ['10:00:00 - Resuming after interruption at row 0'] * import_engine.MAX_RESUMES
        c = self.queued('stuck.xlsx', [row(9)], status='PROCESSING', logs=logs)
        run_import_job(c.id)
        self.assertEqual(ImportBatch.objects.get(id=c.id).status, 'FAILED')

    def test_failed_records_export_has_the_original_columns(self):
        b = self.run_rows([row(1, MRP='ask', Item_Name='Frame, "quoted"')])
        res = APIClient().get(f'/api/import/{b.id}/export-failed/')
        body =b''.join(res.streaming_content).decode()
        self.assertIn('Item Name', body.splitlines()[0])
        self.assertIn('"Frame, ""quoted"""', body)
