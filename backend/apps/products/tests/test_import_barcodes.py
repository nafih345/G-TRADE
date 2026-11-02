"""Excel import barcodes: the file's own come first, the rest fill in after a confirmed preview."""
import csv
from unittest import mock

from django.core.files.uploadedfile import SimpleUploadedFile
from django.test import SimpleTestCase
from rest_framework.test import APIClient

from apps.products import import_engine
from apps.products.barcode_utils import detect_file_sequence, gs1_check_digit
from apps.products.import_engine import run_import_job
from apps.products.models import (
    BarcodeSeriesConfig, ImportBarcodeRow, ImportBatch, Product, ProductBarcode,
)
from apps.products.tests.test_import_engine import ImportCase, row, sheet_rows, write_xlsx


def ean(body):
    return f'{body}{gs1_check_digit(str(body))}'


class DetectionTests(SimpleTestCase):
    def test_plain_numbers_continue_from_the_highest(self):
        rule = detect_file_sequence(['1003', '1001', '1002'])
        self.assertEqual((rule['last'], rule['prefix'], rule['width'], rule['check']), (1003, '', 0, False))

    def test_prefix_and_padding_are_kept(self):
        rule = detect_file_sequence([f'FR-{i:05d}' for i in range(1, 50)])
        self.assertEqual((rule['prefix'], rule['width'], rule['last']), ('FR-', 5, 49))

    def test_ean_series_runs_on_the_body_and_recomputes_the_check_digit(self):
        rule = detect_file_sequence([ean(200000000000 + i) for i in range(1, 6)])
        self.assertTrue(rule['check'])
        self.assertEqual(rule['last'], 200000000005)

    def test_series_crossing_a_digit_boundary_stays_one_series(self):
        self.assertEqual(detect_file_sequence(['9998', '9999', '10000', '10001'])['last'], 10001)

    def test_stray_manufacturer_code_does_not_become_the_last_value(self):
        codes = [str(2000000000 + i) for i in range(100)] + ['8901234567']
        self.assertEqual(detect_file_sequence(codes)['last'], 2000000099)

    def test_unrelated_codes_are_not_a_series(self):
        self.assertIsNone(detect_file_sequence(['8901234567890', '5012345678900', 'ABC', '7612345678901']))
        self.assertIsNone(detect_file_sequence([]))


class BarcodeImportCase(ImportCase):
    def preview(self, rows, strategy='UPDATE', headers=None):
        """Uploads with the toggle on and runs the analysis; nothing is imported yet."""
        self.seq += 1
        path = f'{self.tmp}/in{self.seq}.xlsx'
        write_xlsx(path, {'Stock': sheet_rows(rows, *([headers] if headers else []))})
        with open(path, 'rb') as f, mock.patch.object(import_engine, 'start_import_thread'):
            res = APIClient().post('/api/import/upload/', {
                'file': SimpleUploadedFile('in.xlsx', f.read()), 'duplicate_strategy': strategy, 'auto_barcode': 'true',
            })
        self.assertEqual(res.status_code, 202, res.data)
        run_import_job(res.data['batch_id'])
        return ImportBatch.objects.get(id=res.data['batch_id'])

    def shown(self, batch, **params):
        return APIClient().get(f'/api/import/{batch.id}/barcode-preview/', {'page_size': 500, **params}).data

    def confirm(self, batch):
        with mock.patch.object(import_engine, 'start_import_thread') as start:
            res = APIClient().post(f'/api/import/{batch.id}/confirm/')
        self.assertEqual(res.status_code, 202, res.data)
        start.assert_called_once()
        run_import_job(batch.id)
        return ImportBatch.objects.get(id=batch.id)

    def exclude(self, batch, row_ids, excluded=True):
        return APIClient().post(f'/api/import/{batch.id}/barcode-preview/exclude/',
                                {'row_ids': row_ids, 'excluded': excluded}, format='json')

    def barcodes_by_row(self, batch):
        return list(Product.objects.filter(import_batch=batch).order_by('import_row').values_list('barcode', flat=True))


def partial_rows(with_codes=20, missing=5, start=1001):
    rows = [row(i, Barcode=str(start + i)) for i in range(with_codes)]
    return rows + [row(with_codes + i, Barcode=None) for i in range(missing)]


class ToggleTests(BarcodeImportCase):
    def test_off_leaves_missing_barcodes_blank_and_touches_no_counter(self):
        b = self.run_rows(partial_rows())
        self.assertEqual((b.status, b.imported_rows), ('SUCCESS', 25), b.remarks)
        self.assertEqual(Product.objects.filter(barcode__isnull=True).count(), 5)
        self.assertEqual(Product.objects.filter(barcode='1001').count(), 1)
        self.assertEqual(BarcodeSeriesConfig.load().last_number, 0)
        self.assertAccounted(b)

    def test_on_imports_nothing_until_confirmed(self):
        b = self.preview(partial_rows())
        self.assertEqual(b.status, 'AWAITING_CONFIRMATION', b.remarks)
        self.assertEqual(Product.objects.count(), 0)
        self.assertTrue(b.file_data)

    def test_confirm_only_counts_once(self):
        b = self.confirm(self.preview(partial_rows()))
        self.assertEqual(APIClient().post(f'/api/import/{b.id}/confirm/').status_code, 409)

    def test_cancelling_leaves_nothing_behind(self):
        b = self.preview(partial_rows())
        self.assertEqual(APIClient().delete(f'/api/import/{b.id}/?delete_mode=option1').status_code, 200)
        self.assertFalse(ImportBarcodeRow.objects.exists())
        self.assertEqual(BarcodeSeriesConfig.load().last_number, 0)

    def test_unreadable_sheet_fails_the_preview(self):
        b = self.preview([{'Stock': 1}], headers=['Stock'])
        self.assertEqual(b.status, 'FAILED')


class SequenceTests(BarcodeImportCase):
    def test_partial_file_continues_its_series_without_a_break(self):
        b = self.preview(partial_rows(2000, 400))
        summary = self.shown(b)['summary']
        self.assertEqual((summary['with_barcode'], summary['to_generate']), (2000, 400))
        self.assertEqual((summary['first_new_code'], summary['last_new_code']), ('3001', '3400'))

        b = self.confirm(b)
        self.assertEqual((b.status, b.imported_rows), ('SUCCESS', 2400), b.remarks)
        self.assertEqual(self.barcodes_by_row(b), [str(1001 + i) for i in range(2400)])
        self.assertFalse(ImportBarcodeRow.objects.exists())
        self.assertAccounted(b)

    def test_preview_shows_exactly_what_gets_written(self):
        b = self.preview(partial_rows())
        promised = {r['product_code']: r['barcode'] for r in self.shown(b)['results']}
        self.confirm(b)
        self.assertEqual(promised, {sku: Product.objects.get(sku=sku).barcode for sku in promised})

    def test_used_numbers_are_stepped_over(self):
        Product.objects.create(name='Taken', sku='X1', barcode='1022', cost_price=1, retail_price=1)
        keep = Product.objects.create(name='Second', sku='X2', barcode='Z', secondary_barcode='1023', cost_price=1, retail_price=1)
        ProductBarcode.objects.create(product=keep, code='1024')
        gone = Product.objects.create(name='Gone', sku='X3', barcode='1025', cost_price=1, retail_price=1)
        gone.delete()
        b = self.preview(partial_rows(20, 3))
        self.assertEqual(self.shown(b)['summary']['stepped_over'], 4)
        b = self.confirm(b)
        self.assertEqual(self.barcodes_by_row(b)[20:], ['1021', '1026', '1027'])

    def test_number_taken_after_the_preview_is_not_reused(self):
        b = self.preview(partial_rows(20, 3))
        Product.objects.create(name='Sneaked in', sku='X1', barcode='1022', cost_price=1, retail_price=1)
        b = self.confirm(b)
        self.assertEqual(b.status, 'SUCCESS', b.remarks)
        self.assertEqual(self.barcodes_by_row(b)[20:], ['1021', '1023', '1024'])

    def test_new_codes_stay_off_the_files_own_codes_outside_the_run(self):
        rows = partial_rows(20, 2)
        rows.append(row(40, Barcode='5000'))
        rows[19]['Barcode'] = '3000'      # alone, far from the run
        rows[18]['Barcode'] = '1021'      # exactly the next number after the run's end
        b = self.confirm(self.preview(rows))
        self.assertEqual(b.status, 'SUCCESS', b.remarks)
        self.assertEqual(len(set(self.barcodes_by_row(b))), 23)

    def test_file_with_no_series_uses_barcode_settings(self):
        BarcodeSeriesConfig.objects.update_or_create(id=1, defaults=dict(
            prefix_pattern='77', total_length=8, check_digit='NONE', last_number=40))
        b = self.preview([row(i, Barcode=None) for i in range(3)])
        self.assertEqual(self.shown(b)['summary']['rule']['source'], 'settings')
        self.assertEqual(BarcodeSeriesConfig.load().last_number, 40)    # a preview reserves nothing

        b = self.confirm(b)
        self.assertEqual(self.barcodes_by_row(b), ['77000041', '77000042', '77000043'])
        self.assertEqual(BarcodeSeriesConfig.load().last_number, 43)

    def test_import_inside_the_settings_series_moves_its_counter_past_the_block(self):
        BarcodeSeriesConfig.objects.update_or_create(id=1, defaults=dict(
            prefix_pattern='77', total_length=8, check_digit='NONE', last_number=5))
        rows = [row(i, Barcode=f'7700{1000 + i}') for i in range(50)] + [row(60, Barcode=None)]
        self.confirm(self.preview(rows))
        self.assertEqual(BarcodeSeriesConfig.load().last_number, 1050)


class WhichRowsTests(BarcodeImportCase):
    def test_existing_product_keeps_its_barcode(self):
        self.run_rows([row(i) for i in range(5)])
        b = self.preview([row(i, Barcode=None) for i in range(5)])
        summary = self.shown(b)['summary']
        self.assertEqual((summary['missing'], summary['keeps_existing']), (0, 5))
        b = self.confirm(b)
        self.assertEqual(Product.objects.get(sku='SKU00002').barcode, 'BC00002')
        self.assertAccounted(b)

    def test_existing_product_without_a_barcode_gets_one(self):
        self.run_rows([row(0, Barcode=None), row(1, Barcode='1001'), row(2, Barcode='1002')])
        b = self.preview([row(0, Barcode=None), row(1, Barcode='1001'), row(2, Barcode='1002')])
        self.confirm(b)
        self.assertEqual(Product.objects.get(sku='SKU00000').barcode, '1003')

    def test_repeated_row_does_not_use_a_second_number(self):
        rows = partial_rows(5, 2)
        rows.insert(6, dict(rows[5]))
        b = self.preview(rows)
        self.assertEqual(self.shown(b)['summary']['missing'], 2)
        b = self.confirm(b)
        self.assertEqual(self.barcodes_by_row(b), ['1001', '1002', '1003', '1004', '1005', '1006', '1007'])
        self.assertAccounted(b)

    def test_rows_that_will_fail_or_be_skipped_take_no_number(self):
        rows = partial_rows(5, 3)
        rows[5]['Cost'] = 'abc'
        self.run_rows([row(6, Barcode='1100')])
        b = self.preview(rows, strategy='SKIP')
        self.assertEqual(self.shown(b)['summary']['missing'], 1)
        b = self.confirm(b)
        self.assertEqual(Product.objects.get(sku='SKU00007').barcode, '1006')
        self.assertAccounted(b)


class ExclusionTests(BarcodeImportCase):
    def test_excluded_rows_stay_blank_and_the_numbers_close_up(self):
        b = self.preview(partial_rows(20, 5))
        rows = self.shown(b)['results']
        self.exclude(b, [rows[1]['id'], rows[3]['id']])

        shown = self.shown(b)
        self.assertEqual([r['barcode'] for r in shown['results']], ['1021', None, '1022', None, '1023'])
        self.assertEqual((shown['summary']['to_generate'], shown['summary']['excluded']), (3, 2))
        self.assertEqual(shown['summary']['last_new_code'], '1023')

        b = self.confirm(b)
        self.assertEqual(self.barcodes_by_row(b)[20:], ['1021', None, '1022', None, '1023'])
        self.assertAccounted(b)

    def test_restoring_a_row_gives_it_its_number_back(self):
        b = self.preview(partial_rows(20, 3))
        rows = self.shown(b)['results']
        self.exclude(b, [rows[0]['id']])
        self.exclude(b, [rows[0]['id']], excluded=False)
        self.assertEqual([r['barcode'] for r in self.shown(b)['results']], ['1021', '1022', '1023'])

    def test_exclude_all(self):
        b = self.preview(partial_rows(20, 3))
        APIClient().post(f'/api/import/{b.id}/barcode-preview/exclude/', {'all': True, 'excluded': True}, format='json')
        self.assertEqual(self.shown(b)['summary']['to_generate'], 0)
        b = self.confirm(b)
        self.assertEqual(self.barcodes_by_row(b)[20:], [None, None, None])
        self.assertEqual(b.status, 'SUCCESS', b.remarks)

    def test_codes_are_right_on_a_searched_page(self):
        b = self.preview(partial_rows(20, 4))
        rows = self.shown(b)['results']
        self.exclude(b, [rows[0]['id']])
        found = self.shown(b, search='Frame 23')['results']
        self.assertEqual([r['barcode'] for r in found], ['1023'])

    def test_exclusions_lock_once_confirmed(self):
        b = self.preview(partial_rows(20, 3))
        row_id = self.shown(b)['results'][0]['id']
        ImportBatch.objects.filter(id=b.id).update(status='PROCESSING')
        self.assertEqual(self.exclude(b, [row_id]).data['updated'], 0)


class ResumeTests(BarcodeImportCase):
    def test_resumed_job_keeps_its_numbers_and_the_series_unbroken(self):
        b = self.preview(partial_rows(495, 30))
        real_flush = import_engine._process_chunk
        calls = []

        def die_on_second_chunk(*args, **kwargs):
            calls.append(1)
            if len(calls) == 2:
                raise SystemExit
            return real_flush(*args, **kwargs)

        with mock.patch.object(import_engine, '_process_chunk', die_on_second_chunk), \
                mock.patch.object(import_engine, '_start_next_import'):
            ImportBatch.objects.filter(id=b.id).update(status='PENDING')
            with self.assertRaises(SystemExit):
                run_import_job(b.id)

        self.assertEqual(ImportBatch.objects.get(id=b.id).processed_rows, 500)
        run_import_job(b.id)
        b = ImportBatch.objects.get(id=b.id)
        self.assertEqual((b.status, b.imported_rows), ('SUCCESS', 525), b.remarks)
        self.assertEqual(self.barcodes_by_row(b), [str(1001 + i) for i in range(525)])
        self.assertAccounted(b)


class DataPreviewTests(BarcodeImportCase):
    def test_generated_barcode_shows_in_the_batch_preview(self):
        b = self.confirm(self.preview(partial_rows(20, 1)))
        data = APIClient().get(f'/api/import/{b.id}/rows/', {'page_size': 500}).data
        self.assertEqual(data['results'][20]['source']['Barcode'], '1021')

    def test_sheet_with_no_barcode_column_gets_one_in_the_preview(self):
        headers = ['Item Name', 'Code', 'MRP']
        b = self.confirm(self.preview([row(i) for i in range(2)], headers=headers))
        data = APIClient().get(f'/api/import/{b.id}/rows/', {'page_size': 500}).data
        self.assertIn('Barcode', data['column_headers'])
        self.assertTrue(data['results'][0]['source']['Barcode'])


class RealSheetTests(BarcodeImportCase):
    def test_placeholder_cells_count_as_missing(self):
        marks = ['-', '--', 'N/A', 'na', 'NIL', 'None', '#N/A']
        rows = [row(i, Barcode=str(1001 + i)) for i in range(5)]
        rows += [row(5 + i, Barcode=mark) for i, mark in enumerate(marks)]
        b = self.preview(rows)
        self.assertEqual(self.shown(b)['summary']['with_barcode'], 5)
        self.assertEqual(self.shown(b)['summary']['to_generate'], len(marks))
        b = self.confirm(b)
        self.assertEqual((b.status, b.imported_rows), ('SUCCESS', 12), b.remarks)
        self.assertEqual(self.barcodes_by_row(b), [str(1001 + i) for i in range(12)])

    def test_placeholder_cells_stay_blank_with_the_toggle_off(self):
        b = self.run_rows([row(0, Barcode='-'), row(1, Barcode='-'), row(2, Barcode='N/A')])
        self.assertEqual((b.status, b.imported_rows), ('SUCCESS', 3), b.remarks)
        self.assertEqual(Product.objects.filter(barcode__isnull=True).count(), 3)

    def test_numeric_cells_continue_as_numbers(self):
        rows = [row(i, Barcode=8901234567001 + i) for i in range(4)] + [row(4, Barcode=None)]
        b = self.confirm(self.preview(rows))
        self.assertEqual(self.barcodes_by_row(b)[-1], '8901234567005')

    def test_repeat_row_that_brings_the_barcode_uses_no_number(self):
        rows = partial_rows(5, 2)
        rows.append(dict(rows[5], Barcode='9000000'))     # blank first, the same product's code later
        b = self.preview(rows)
        self.assertEqual(self.shown(b)['summary']['missing'], 1)
        b = self.confirm(b)
        self.assertEqual(Product.objects.get(sku='SKU00005').barcode, '9000000')
        self.assertEqual(Product.objects.get(sku='SKU00006').barcode, '1006')
        self.assertAccounted(b)

    def test_csv_upload_previews_and_imports(self):
        path = f'{self.tmp}/in.csv'
        with open(path, 'w', newline='') as f:
            csv.writer(f).writerows(sheet_rows(partial_rows(4, 2)))
        with open(path, 'rb') as f, mock.patch.object(import_engine, 'start_import_thread'):
            res = APIClient().post('/api/import/upload/', {
                'file': SimpleUploadedFile('in.csv', f.read()), 'auto_barcode': 'true'})
        run_import_job(res.data['batch_id'])
        b = self.confirm(ImportBatch.objects.get(id=res.data['batch_id']))
        self.assertEqual(self.barcodes_by_row(b), [str(1001 + i) for i in range(6)])
