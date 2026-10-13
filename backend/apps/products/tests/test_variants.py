"""Add Multiple Items / Product Variant Master: bulk variant save, validation, purchase + stock rules."""
import io

from django.test import SimpleTestCase
from openpyxl import Workbook
from rest_framework.test import APITestCase

from apps.products.models import Product, ProductBarcode, ProductVariantGroup, ProductVariantTemplate
from apps.products.variant_service import attr_code, build_variant_sku, variant_key
from apps.purchasing.models import Supplier

URL = '/api/products/variant-groups/'
COLOURS = ['Black', 'Brown']
SIZES = ['S', 'M', 'L', 'XL', 'XXL']


def frame_rows(**extra):
    return [dict({'attributes': {'color': c, 'size': s}, 'mrp': 1500, 'sales_price': 1200, 'cost_price': 500}, **extra)
            for c in COLOURS for s in SIZES]


class HelperTests(SimpleTestCase):
    def test_attribute_codes(self):
        self.assertEqual(attr_code('Black'), 'BLK')
        self.assertEqual(attr_code('Brown'), 'BRN')
        self.assertEqual(attr_code('XXL'), 'XXL')
        self.assertEqual(attr_code('-1.25'), 'M125')
        self.assertEqual(attr_code('+2.00'), 'P200')

    def test_sku_and_key(self):
        self.assertEqual(build_variant_sku('FRAME-001', {'color': 'Black', 'size': 'S'}, ['color', 'size']), 'FRAME-001-BLK-S')
        self.assertEqual(variant_key({'Size': 'm', 'colour': 'BLACK'}), variant_key({'color': 'black', 'size': 'M'}))


class BulkSaveTests(APITestCase):
    def save(self, body, expect=None):
        res = self.client.post(f'{URL}bulk-save/', body, format='json')
        if expect is not None:
            self.assertEqual(res.status_code, expect, res.content)
        return res

    def test_single_product_without_variants(self):
        res = self.save({'group': {}, 'variants': [{'name': 'Lens Cloth', 'sales_price': 50}]}, 201)
        self.assertIsNone(res.data['group'])
        p = Product.objects.get(name='Lens Cloth')
        self.assertIsNone(p.variant_group)
        self.assertTrue(p.sku)

    def test_two_colours_five_sizes_make_ten_variants(self):
        res = self.save({'group': {'name': 'Optical Frame', 'base_sku': 'FRAME-001', 'category': 'Frames', 'tax_percent': 12,
                                   'attribute_keys': ['color', 'size']},
                         'variants': frame_rows()}, 201)
        self.assertEqual(res.data['created'], 10)
        group = ProductVariantGroup.objects.get(name='Optical Frame')
        skus = set(group.variants.values_list('sku', flat=True))
        self.assertEqual(len(skus), 10)
        self.assertIn('FRAME-001-BLK-S', skus)
        self.assertIn('FRAME-001-BRN-XXL', skus)
        v = group.variants.get(sku='FRAME-001-BLK-M')
        self.assertEqual((v.color, v.size, v.name), ('Black', 'M', 'Optical Frame Black / M'))
        self.assertEqual(v.extra_data['gst'], '12%')
        self.assertEqual(float(v.retail_price), 1200)

    def test_duplicate_combination_rejected_and_nothing_saved(self):
        rows = frame_rows()
        rows.append({'attributes': {'colour': 'black', 'size': 's'}})
        res = self.save({'group': {'name': 'Dup Frame'}, 'variants': rows}, 400)
        self.assertIn('attributes', res.data['row_errors']['10'])
        self.assertFalse(Product.objects.exists())

    def test_existing_sku_and_barcode_rejected(self):
        other = Product.objects.create(name='Old', sku='TAKEN-1', barcode='2000000000015')
        ProductBarcode.objects.create(product=other, code='2000000000022')
        res = self.save({'group': {'name': 'Clash'}, 'variants': [
            {'attributes': {'color': 'Red'}, 'sku': 'TAKEN-1'},
            {'attributes': {'color': 'Blue'}, 'barcode': '2000000000015'},
            {'attributes': {'color': 'Green'}, 'barcode': '2000000000022'},
            {'attributes': {'color': 'Pink'}, 'sku': 'SAME'},
            {'attributes': {'color': 'Grey'}, 'sku': 'same'},
        ]}, 400)
        errs = res.data['row_errors']
        self.assertIn('sku', errs['0'])
        self.assertIn('barcode', errs['1'])
        self.assertIn('barcode', errs['2'])
        self.assertIn('sku', errs['4'])
        other.refresh_from_db()
        self.assertEqual(other.barcode, '2000000000015')  # never overwritten

    def test_price_rules(self):
        res = self.save({'group': {}, 'variants': [{'name': 'X', 'mrp': 100, 'sales_price': 150},
                                                   {'name': 'Y', 'cost_price': -1},
                                                   {'name': 'Z', 'tax_percent': 'abc'}]}, 400)
        self.assertIn('sales_price', res.data['row_errors']['0'])
        self.assertIn('cost_price', res.data['row_errors']['1'])
        self.assertIn('tax_percent', res.data['row_errors']['2'])

    def test_variants_without_parent_name_are_rejected(self):
        res = self.save({'group': {}, 'variants': frame_rows()[:2]}, 400)
        self.assertIn('name', res.data['row_errors']['0'])
        self.assertFalse(Product.objects.exists())

    def test_dry_run_writes_nothing(self):
        res = self.save({'dry_run': True, 'group': {'name': 'Preview', 'base_sku': 'PRV'}, 'variants': frame_rows()}, 200)
        self.assertEqual(len(res.data['variants']), 10)
        self.assertEqual(res.data['variants'][0]['sku'], 'PRV-BLK-S')
        self.assertFalse(Product.objects.exists())
        self.assertFalse(ProductVariantGroup.objects.exists())

    def test_retry_with_same_token_does_not_duplicate(self):
        body = {'client_token': 'tok-123', 'group': {'name': 'Retry Frame'}, 'variants': frame_rows()}
        self.save(body, 201)
        res = self.save(body, 200)
        self.assertTrue(res.data['replayed'])
        self.assertEqual(Product.objects.count(), 10)

    def test_auto_barcode_assigns_unique_codes_with_history(self):
        Product.objects.create(name='Holder', sku='H1', barcode='2000000000015')
        self.save({'auto_barcode': True, 'group': {'name': 'BC Frame'}, 'variants': frame_rows()}, 201)
        codes = list(Product.objects.filter(variant_group__isnull=False).values_list('barcode', flat=True))
        self.assertEqual(len(set(codes)), 10)
        self.assertNotIn('2000000000015', codes)
        self.assertTrue(all(len(c) == 13 for c in codes))

    def test_inventory_opening_stock_goes_through_stock_helper(self):
        self.save({'context': 'inventory', 'group': {}, 'variants': [{'name': 'Case', 'opening_stock': 7}]}, 201)
        self.assertEqual(Product.objects.get(name='Case').stock, 7)

    def test_purchase_context_creates_master_only(self):
        self.save({'context': 'purchase', 'group': {'name': 'PE Frame'},
                   'variants': frame_rows(opening_stock=9)}, 201)
        for p in Product.objects.all():
            self.assertEqual(p.stock, 0)
            self.assertEqual(float(p.cost_price), 0)  # supplier cost lives on the purchase line

    def test_manage_variants_update_add_and_deactivate(self):
        res = self.save({'group': {'name': 'Edit Frame'}, 'variants': frame_rows()}, 201)
        gid = res.data['group']['id']
        detail = self.client.get(f'{URL}{gid}/').data
        variants = detail['variants']
        first, gone = variants[0], variants[1]
        rows = [dict(first, sales_price=999)] + [v for v in variants[2:]] + [{'attributes': {'color': 'Gold', 'size': 'M'}}]
        res = self.save({'group_id': gid, 'group': {'name': 'Edit Frame'}, 'variants': rows, 'remove_ids': [gone['id']]}, 201)
        self.assertEqual((res.data['created'], res.data['updated'], res.data['deactivated']), (1, 9, 1))
        self.assertEqual(float(Product.objects.get(pk=first['id']).retail_price), 999)
        self.assertFalse(Product.objects.get(pk=gone['id']).is_active)
        # Re-adding an existing combination through a new row is rejected.
        res = self.save({'group_id': gid, 'group': {'name': 'Edit Frame'},
                         'variants': [{'attributes': {'color': 'Gold', 'size': 'M'}}]}, 400)
        self.assertIn('attributes', res.data['row_errors']['0'])

    def test_search_list_counts_each_variant_once(self):
        self.save({'group': {'name': 'Count Frame', 'base_sku': 'CNT'}, 'variants': frame_rows()}, 201)
        for params in ({}, {'search': 'CNT'}, {'search': 'Count'}):
            rows = self.client.get(URL, params).data
            self.assertEqual([r['variant_count'] for r in rows], [10], params)

    def test_manage_variants_on_standalone_product(self):
        p = Product.objects.create(name='Solo Frame', sku='SOLO-1', color='Black')
        data = self.client.get(f'{URL}for-product/', {'product': str(p.id)}).data
        self.assertTrue(data['standalone'])
        rows = data['variants'] + [{'attributes': {'color': 'Brown'}}]
        self.save({'group': {'name': 'Solo Frame', 'base_sku': 'SOLO'}, 'variants': rows}, 201)
        p.refresh_from_db()
        self.assertIsNotNone(p.variant_group)
        self.assertEqual(p.variant_group.variants.count(), 2)


class PurchaseFlowTests(APITestCase):
    """Variants created from Purchase Entry only gain stock when the purchase is posted."""

    def setUp(self):
        self.supplier = Supplier.objects.create(name='Lens House')
        res = self.client.post(f'{URL}bulk-save/', {'context': 'purchase', 'group': {'name': 'PF Frame'},
                                                    'variants': frame_rows()[:2]}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.variants = res.data['variants']

    def _invoice(self, status, number='PINV-T1'):
        return {
            'invoice_number': number, 'supplier': str(self.supplier.id), 'purchase_date': '2026-10-13',
            'status': status, 'purchase_type': 'CASH',
            'items': [{'product': v['id'], 'quantity': 4, 'purchase_rate': 450, 'selling_price': 1200, 'line_total': 1800}
                      for v in self.variants],
        }

    def _stock(self):
        return [Product.objects.get(pk=v['id']).stock for v in self.variants]

    def test_draft_does_not_move_stock_and_posting_does_once(self):
        res = self.client.post('/api/purchase/invoices/', self._invoice('DRAFT'), format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(self._stock(), [0, 0])

        inv_id = res.data['id']
        self.client.put(f'/api/purchase/invoices/{inv_id}/', self._invoice('CONFIRMED'), format='json')
        self.assertEqual(self._stock(), [4, 4])
        self.assertEqual(float(Product.objects.get(pk=self.variants[0]['id']).cost_price), 450)

        # Re-saving the posted entry must not add the quantity again.
        self.client.put(f'/api/purchase/invoices/{inv_id}/', self._invoice('CONFIRMED'), format='json')
        self.assertEqual(self._stock(), [4, 4])

    def test_repeated_post_of_same_entry_is_rejected(self):
        first = self.client.post('/api/purchase/invoices/', self._invoice('CONFIRMED'), format='json')
        self.assertEqual(first.status_code, 201, first.content)
        again = self.client.post('/api/purchase/invoices/', self._invoice('CONFIRMED'), format='json')
        self.assertEqual(again.status_code, 400)
        self.assertEqual(self._stock(), [4, 4])  # the duplicate post moved nothing


class ImportTests(APITestCase):
    def _sheet(self, rows):
        wb = Workbook()
        ws = wb.active
        ws.append(['Product Name', 'Base SKU', 'Colour', 'Size', 'Barcode', 'MRP', 'Sales Price', 'Tax %'])
        for r in rows:
            ws.append(r)
        buf = io.BytesIO()
        wb.save(buf)
        buf.seek(0)
        buf.name = 'variants.xlsx'
        return buf

    def test_preview_flags_bad_rows_and_commit_saves_only_valid_ones(self):
        Product.objects.create(name='Owner', sku='OWN', barcode='999')
        sheet = self._sheet([
            ['Imp Frame', 'IMP', 'Black', 'M', '', 1500, 1200, 12],
            ['Imp Frame', 'IMP', 'Brown', 'M', '999', 1500, 1200, 12],   # barcode clash
            ['Imp Frame', 'IMP', 'Black', 'M', '', 1500, 1200, 12],      # duplicate combination
            ['Imp Frame', 'IMP', 'Grey', 'L', '', 1000, 1200, 12],       # sales > MRP
            ['Imp Sun', '', 'Green', '', '', 900, 800, 18],
        ])
        res = self.client.post(f'{URL}import-preview/', {'file': sheet, 'context': 'inventory'}, format='multipart')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual((res.data['total_rows'], res.data['valid_rows'], res.data['error_rows']), (5, 2, 3))
        self.assertFalse(Product.objects.exclude(sku='OWN').exists())  # preview writes nothing

        commit = self.client.post(f'{URL}import-commit/', {'context': 'inventory', 'groups': res.data['groups']}, format='json')
        self.assertEqual(commit.status_code, 200, commit.content)
        self.assertEqual((commit.data['imported_rows'], commit.data['failed_rows']), (2, 3))
        self.assertEqual({e['row_number'] for e in commit.data['errors']}, {3, 4, 5})
        self.assertTrue(Product.objects.filter(sku='IMP-BLK-M').exists())
        self.assertEqual(Product.objects.get(barcode='999').name, 'Owner')

    def test_template_and_export_download(self):
        self.assertEqual(self.client.get(f'{URL}import-template/').status_code, 200)
        self.client.post(f'{URL}bulk-save/', {'group': {'name': 'Exp Frame'}, 'variants': frame_rows()}, format='json')
        res = self.client.get(f'{URL}export/')
        self.assertEqual(res.status_code, 200)
        self.assertTrue(res['Content-Type'].startswith('application/vnd.openxmlformats'))


class TemplateTests(APITestCase):
    def test_template_crud_and_no_transaction_data(self):
        url = '/api/products/variant-templates/'
        res = self.client.post(url, {'name': 'Optical Frame Template', 'category_name': 'Frames',
                                     'config': {'axes': [{'key': 'color', 'values': ['Black']}], 'tax_percent': 12}}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        bad = self.client.post(url, {'name': 'Bad', 'config': {'supplier_invoice_number': 'X1'}}, format='json')
        self.assertEqual(bad.status_code, 400)
        dup = self.client.post(f"{url}{res.data['id']}/duplicate/", {}, format='json')
        self.assertEqual(dup.data['name'], 'Optical Frame Template (copy)')
        self.client.delete(f"{url}{res.data['id']}/")
        self.assertEqual(ProductVariantTemplate.objects.count(), 1)
