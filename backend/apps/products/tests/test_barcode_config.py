"""Configurable product barcode series (BarcodeSeriesConfig + /api/products/barcode-config/)."""
from datetime import date

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from apps.products.barcode_utils import (
    BarcodeConfigError, gs1_check_digit, preview_series, reserve_product_barcodes, series_layout,
)
from apps.products.models import BarcodeSeriesConfig, Product, ProductBarcode

URL = '/api/products/barcode-config/'


class SeriesFormatTests(SimpleTestCase):
    def test_default_matches_legacy_ean13_series(self):
        self.assertEqual(preview_series('20', 13, 'MOD10', 1)['samples'],
                         ['2000000000015', '2000000000022', '2000000000039'])

    def test_check_digit_any_length(self):
        self.assertEqual(gs1_check_digit('9638507'), '4')       # EAN-8 96385074
        self.assertEqual(gs1_check_digit('03600029145'), '2')   # UPC-A 036000291452

    def test_date_tokens_and_no_check_digit(self):
        p = preview_series('GO{YY}{MM}', 12, 'NONE', 7, today=date(2026, 10, 16))
        self.assertEqual(p['resolved_prefix'], 'GO2610')
        self.assertEqual(p['samples'][0], 'GO2610000007')
        self.assertEqual(p['sequence_digits'], 6)

    def test_validation(self):
        for args in [('AB', 13, 'MOD10'), ('2{XX}', 13, 'MOD10'), ('20', 4, 'MOD10'),
                     ('1234567890', 13, 'MOD10'), ('a b', 13, 'NONE')]:
            with self.assertRaises(BarcodeConfigError, msg=args):
                series_layout(*args)

    def test_series_full(self):
        p = preview_series('20', 6, 'MOD10', 998)
        self.assertEqual(len(p['samples']), 2)   # 998, 999 then exhausted
        self.assertEqual(p['remaining'], 2)


class ReserveTests(APITestCase):
    def test_reserve_uses_config_and_skips_taken_codes(self):
        cfg = BarcodeSeriesConfig.load()
        cfg.prefix_pattern, cfg.total_length, cfg.check_digit, cfg.last_number = '77', 8, 'NONE', 0
        cfg.save()
        Product.objects.create(name='A', sku='A1', barcode='77000002')
        p = Product.objects.create(name='B', sku='B1')
        ProductBarcode.objects.create(product=p, code='77000003')
        self.assertEqual(reserve_product_barcodes(3, avoid={'77000005'}), ['77000001', '77000004', '77000006'])


class ConfigApiTests(APITestCase):
    def setUp(self):
        self.client.force_authenticate(get_user_model().objects.create_user(
            username='admin', password='x', role='SUPER_ADMIN'))

    def test_get_put_and_generate(self):
        r = self.client.get(URL)
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.data['total_length'], 13)

        r = self.client.put(URL, {'prefix_pattern': '89', 'total_length': 10, 'check_digit': 'MOD10',
                                  'next_number': 50, 'dry_run': True}, format='json')
        self.assertEqual(r.status_code, 200, r.data)
        self.assertEqual(r.data['preview']['samples'][0], '8900000502')
        self.assertEqual(BarcodeSeriesConfig.load().total_length, 13)   # dry run saved nothing

        r = self.client.put(URL, {'prefix_pattern': '89', 'total_length': 10, 'check_digit': 'MOD10',
                                  'next_number': 50}, format='json')
        self.assertEqual(r.status_code, 200, r.data)
        r = self.client.post('/api/products/items/next_barcode_candidate/')
        self.assertEqual(r.data['barcode'], '8900000502')

        prod = Product.objects.create(name='C', sku='C1')
        r = self.client.post(f'/api/products/items/{prod.id}/generate_barcode/')
        self.assertEqual(r.data['barcode'][:2], '89')
        self.assertEqual(len(r.data['barcode']), 10)

    def test_invalid_config_rejected(self):
        r = self.client.put(URL, {'prefix_pattern': 'XY', 'check_digit': 'MOD10'}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertIn('numeric', str(r.data['detail']))

    def test_save_without_next_number_keeps_counter(self):
        cfg = BarcodeSeriesConfig.load()
        cfg.last_number = 41
        cfg.save()
        self.client.put(URL, {'prefix_pattern': '21'}, format='json')
        self.assertEqual(BarcodeSeriesConfig.load().last_number, 41)


class SecondaryBarcodeTests(APITestCase):
    ITEMS = '/api/products/items/'

    def setUp(self):
        self.a = Product.objects.create(name='Alpha', sku='A1', barcode='1111')
        self.b = Product.objects.create(name='Beta', sku='B1', barcode='2222')
        ProductBarcode.objects.create(product=self.b, code='2223')

    def patch(self, product, **data):
        return self.client.patch(f'{self.ITEMS}{product.id}/', data, format='json')

    def test_manual_primary_and_secondary_edit(self):
        r = self.patch(self.a, barcode='1112', secondary_barcode=' 890123 ')
        self.assertEqual(r.status_code, 200, r.data)
        self.a.refresh_from_db()
        self.assertEqual((self.a.barcode, self.a.secondary_barcode), ('1112', '890123'))
        self.assertIn('890123', r.data['extra_barcodes'])   # scanners match it like any other code
        self.assertTrue(self.a.barcode_history.filter(new_barcode='890123').exists())
        r = self.patch(self.a, secondary_barcode='')
        self.a.refresh_from_db()
        self.assertIsNone(self.a.secondary_barcode)

    def test_secondary_must_be_unique_everywhere(self):
        for code in ('2222', '2223'):                      # B's primary, B's label code
            r = self.patch(self.a, secondary_barcode=code)
            self.assertEqual(r.status_code, 400)
            self.assertIn('Beta', str(r.data['secondary_barcode']))
        r = self.patch(self.a, secondary_barcode='1111')   # same as own primary
        self.assertEqual(r.status_code, 400)
        self.patch(self.a, secondary_barcode='5555')
        r = self.patch(self.b, barcode='5555')             # primary can't take A's secondary
        self.assertEqual(r.status_code, 400)
        self.assertIn('Alpha', str(r.data['barcode']))

    def test_secondary_scans_and_is_skipped_by_series(self):
        self.patch(self.a, secondary_barcode='77000001')
        r = self.client.get(f'{self.ITEMS}resolve_barcode/?code=77000001')
        self.assertEqual(r.data['product']['id'], str(self.a.id))
        r = self.client.get(f'{self.ITEMS}check_barcode/?barcode=77000001&exclude_id={self.b.id}')
        self.assertEqual(r.data['product_name'], 'Alpha')
        r = self.client.get(f'{self.ITEMS}?search=77000001')
        self.assertEqual([p['id'] for p in r.data], [str(self.a.id)])
        cfg = BarcodeSeriesConfig.load()
        cfg.prefix_pattern, cfg.total_length, cfg.check_digit, cfg.last_number = '77', 8, 'NONE', 0
        cfg.save()
        self.assertEqual(reserve_product_barcodes(1), ['77000002'])
