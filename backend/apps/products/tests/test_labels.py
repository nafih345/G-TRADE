"""Barcode label designer: template persistence, validation, versioning, permissions and
dynamic field resolution."""
import copy

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from apps.products.label_fields import LayoutError, resolve_product_fields, validate_template
from apps.products.label_presets import PRESETS, preset_spec
from apps.products.models import (
    LabelPrintSettings, LabelTemplate, LabelTemplateVersion, Product, ProductVariantGroup,
)

URL = '/api/products/label-templates/'


def user(role, username=None):
    return get_user_model().objects.create_user(username=username or role.lower(), password='x', role=role)


def field_el(eid, field, **kw):
    return dict({'id': eid, 'type': 'field', 'field': field, 'x': 1, 'y': 1, 'w': 20, 'h': 4,
                 'style': {'fontSizePt': 7}}, **kw)


def body(name='My Label', elements=None, **kw):
    return dict({'name': name, 'printer_type': 'thermal', 'width_mm': 38, 'height_mm': 25,
                 'layout': {'elements': elements if elements is not None else [
                     field_el('n', 'product_name'),
                     {'id': 'b', 'type': 'barcode', 'x': 1, 'y': 10, 'w': 36, 'h': 12},
                 ]}}, **kw)


class ValidationTests(SimpleTestCase):
    def test_presets_are_valid(self):
        for p in PRESETS:
            validate_template(p['printer_type'], p['width_mm'], p['height_mm'], p['layout'], True)

    def test_unknown_field_rejected(self):
        with self.assertRaisesMessage(LayoutError, 'unknown field'):
            validate_template('thermal', 38, 25, {'elements': [field_el('a', 'secret_column')]}, True)

    def test_restricted_field_needs_permission(self):
        layout = {'elements': [field_el('a', 'cost_price')]}
        with self.assertRaisesMessage(LayoutError, 'restricted'):
            validate_template('thermal', 38, 25, layout, False)
        validate_template('thermal', 38, 25, layout, True)

    def test_dimensions_bounded(self):
        with self.assertRaises(LayoutError):
            validate_template('thermal', 0, 25, {}, True)
        with self.assertRaises(LayoutError):
            validate_template('thermal', 38, 900, {}, True)

    def test_a4_sheet_must_fit(self):
        with self.assertRaisesMessage(LayoutError, 'A4 is'):
            validate_template('a4', 70, 30, {'sheet': {'cols': 3, 'rows': 8, 'marginLeftMm': 10}}, True)

    def test_unknown_keys_and_markup_are_not_persisted(self):
        _, _, clean = validate_template('thermal', 38, 25, {'elements': [
            dict(field_el('a', 'product_name'), onclick='alert(1)', style={'fontSizePt': 7, 'css': 'x:url(evil)'}),
        ], 'script': '<script>'}, True)
        self.assertNotIn('script', clean)
        self.assertNotIn('onclick', clean['elements'][0])
        self.assertNotIn('css', clean['elements'][0]['style'])

    def test_duplicate_element_ids_rejected(self):
        with self.assertRaisesMessage(LayoutError, 'duplicate id'):
            validate_template('thermal', 38, 25, {'elements': [field_el('a', 'sku'), field_el('a', 'size')]}, True)

    def test_bad_colour_rejected(self):
        with self.assertRaisesMessage(LayoutError, 'hex'):
            validate_template('thermal', 38, 25, {'elements': [field_el('a', 'sku', style={'color': 'red;background:url(x)'})]}, True)


class FieldResolutionTests(APITestCase):
    def test_resolves_real_columns_and_extra_data(self):
        group = ProductVariantGroup.objects.create(name='Aviator', model_number='RB3025')
        p = Product.objects.create(
            name='Aviator Gold / 58', sku='RB-GLD-58', barcode='8901234567890', brand_name='Ray-Ban',
            retail_price='4590', wholesale_price='3000', cost_price='2100', color='Gold', size='58',
            frame_type='Full Rim', category_name='Sunglasses', variant_group=group,
            variant_attributes={'color': 'Gold', 'size': '58'}, extra_data={'mrp': 4990},
        )
        v = resolve_product_fields(p, include_restricted=False)
        self.assertEqual(v['product_name'], 'Aviator Gold / 58')
        self.assertEqual(v['brand'], 'Ray-Ban')
        self.assertEqual(v['model_number'], 'RB3025')
        self.assertEqual(v['selling_price'], '4590.00')
        self.assertEqual(v['mrp'], '4990.00')
        self.assertEqual((v['colour'], v['size'], v['variant']), ('Gold', '58', 'Gold / 58'))
        self.assertNotIn('wholesale_price', v)
        self.assertNotIn('cost_price', v)
        v = resolve_product_fields(p, include_restricted=True)
        self.assertEqual((v['wholesale_price'], v['cost_price']), ('3000.00', '2100.00'))

    def test_missing_mrp_is_blank_not_guessed(self):
        p = Product.objects.create(name='Case', sku='CASE-1', retail_price='150', wholesale_price='90')
        self.assertEqual(resolve_product_fields(p)['mrp'], '')

    def test_label_data_hides_restricted_from_anonymous(self):
        p = Product.objects.create(name='Frame', sku='F-1', barcode='123456789012', retail_price='999', cost_price='400')
        res = self.client.post('/api/products/label-data/', {'product_ids': [str(p.id), 'local-123']}, format='json')
        self.assertEqual(res.status_code, 200)
        fields = res.data['products'][str(p.id)]['fields']
        self.assertEqual(fields['selling_price'], '999.00')
        self.assertNotIn('cost_price', fields)
        self.assertFalse(res.data['restricted_included'])

        self.client.force_authenticate(user('ACCOUNTANT'))
        res = self.client.post('/api/products/label-data/', {'product_ids': [str(p.id)]}, format='json')
        self.assertEqual(res.data['products'][str(p.id)]['fields']['cost_price'], '400.00')

    def test_field_catalog_marks_restricted(self):
        res = self.client.get('/api/products/label-fields/')
        cost = next(f for f in res.data['fields'] if f['id'] == 'cost_price')
        self.assertTrue(cost['restricted'])
        self.assertFalse(cost['allowed'])
        self.assertFalse(res.data['can_design'])


class TemplateApiTests(APITestCase):
    def setUp(self):
        self.admin = user('SUPER_ADMIN', 'admin')
        self.client.force_authenticate(self.admin)

    def test_seeds_presets_with_one_default(self):
        res = self.client.get(URL)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.data), len(PRESETS))
        self.assertEqual(sum(1 for t in res.data if t['is_default']), 1)

    def test_create_reload_update_duplicate(self):
        res = self.client.post(URL, body(), format='json')
        self.assertEqual(res.status_code, 201, res.content)
        tid = res.data['id']
        self.assertEqual(res.data['version'], 1)

        # reload restores the saved design
        got = self.client.get(f'{URL}{tid}/').data
        self.assertEqual([e['field'] for e in got['layout']['elements'] if e['type'] == 'field'], ['product_name'])

        # update bumps the version and keeps the previous state
        layout = copy.deepcopy(got['layout'])
        layout['elements'].append(field_el('p', 'selling_price', y=6))
        res = self.client.put(f'{URL}{tid}/', dict(body(), layout=layout, expected_version=1), format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['version'], 2)
        self.assertEqual(LabelTemplateVersion.objects.filter(template_id=tid, version=1).count(), 1)

        # duplicate is independent
        dup = self.client.post(f'{URL}{tid}/duplicate/', {}, format='json').data
        self.assertEqual(dup['name'], 'My Label (Copy)')
        layout2 = copy.deepcopy(dup['layout'])
        layout2['elements'] = layout2['elements'][:1]
        self.client.patch(f'{URL}{dup["id"]}/', {'layout': layout2, 'expected_version': 1}, format='json')
        self.assertEqual(len(LabelTemplate.objects.get(pk=tid).layout['elements']), 3)

    def test_stale_update_conflicts(self):
        tid = self.client.post(URL, body(), format='json').data['id']
        self.client.patch(f'{URL}{tid}/', {'name': 'Renamed', 'expected_version': 1}, format='json')
        res = self.client.patch(f'{URL}{tid}/', {'name': 'Again', 'expected_version': 1}, format='json')
        self.assertEqual(res.status_code, 409)
        self.assertEqual(LabelTemplate.objects.get(pk=tid).name, 'Renamed')

    def test_restore_version(self):
        tid = self.client.post(URL, body(), format='json').data['id']
        self.client.patch(f'{URL}{tid}/', {'layout': {'elements': []}, 'expected_version': 1}, format='json')
        res = self.client.post(f'{URL}{tid}/restore-version/', {'version': 1}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.data['layout']['elements']), 2)
        self.assertEqual(res.data['version'], 3)

    def test_restore_default_resets_preset(self):
        self.client.get(URL)
        tpl = LabelTemplate.objects.get(preset_key='jewel_card_38x25')
        self.client.patch(f'{URL}{tpl.id}/', {'layout': {'elements': []}, 'expected_version': tpl.version}, format='json')
        res = self.client.post(f'{URL}{tpl.id}/restore-default/')
        self.assertEqual(len(res.data['layout']['elements']), len(preset_spec('jewel_card_38x25')['layout']['elements']))

    def test_delete_is_soft_and_restorable(self):
        self.client.get(URL)  # seed presets so this isn't the last template
        tid = self.client.post(URL, body(), format='json').data['id']
        self.assertEqual(self.client.delete(f'{URL}{tid}/').status_code, 204)
        self.assertFalse(LabelTemplate.objects.filter(pk=tid).exists())
        self.assertEqual([t['id'] for t in self.client.get(f'{URL}deleted/').data], [tid])
        self.assertEqual(self.client.post(f'{URL}{tid}/undelete/').status_code, 200)
        self.assertTrue(LabelTemplate.objects.filter(pk=tid).exists())

    def test_default_cannot_be_deleted(self):
        self.client.get(URL)
        default = LabelTemplate.objects.get(is_default=True)
        self.assertEqual(self.client.delete(f'{URL}{default.id}/').status_code, 400)

    def test_set_default_is_exclusive(self):
        tid = self.client.post(URL, body(), format='json').data['id']
        self.client.post(f'{URL}{tid}/set-default/')
        self.assertEqual(list(LabelTemplate.objects.filter(is_default=True).values_list('id', flat=True)), [LabelTemplate.objects.get(pk=tid).id])

    def test_duplicate_name_rejected(self):
        self.client.post(URL, body(), format='json')
        res = self.client.post(URL, body(), format='json')
        self.assertEqual(res.status_code, 400)

    def test_from_preset(self):
        res = self.client.post(f'{URL}from-preset/', {'preset_key': 'standard_50x25'}, format='json')
        self.assertEqual(res.status_code, 201)
        self.assertEqual(float(res.data['width_mm']), 50)

    def test_workflow_defaults_and_calibration(self):
        tid = self.client.post(URL, body(), format='json').data['id']
        res = self.client.put('/api/products/label-settings/', {'purchase_template': tid, 'h_offset_mm': '1.5',
                                                                 'print_scale_percent': '98'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        s = LabelPrintSettings.load()
        self.assertEqual(str(s.purchase_template_id), tid)
        bad = self.client.put('/api/products/label-settings/', {'print_scale_percent': '400'}, format='json')
        self.assertEqual(bad.status_code, 400)

    def test_legacy_import_runs_once(self):
        payload = {'templates': [dict(body('Old browser design'), make_default=True)]}
        res = self.client.post('/api/products/label-settings/import-legacy/', payload, format='json')
        self.assertEqual(res.data['imported'], 1)
        self.assertTrue(LabelTemplate.objects.get(name='Old browser design').is_default)
        res = self.client.post('/api/products/label-settings/import-legacy/', payload, format='json')
        self.assertEqual(res.data['imported'], 0)


class TemplatePermissionTests(APITestCase):
    def test_anonymous_can_read_but_not_write(self):
        self.assertEqual(self.client.get(URL).status_code, 200)
        self.assertIn(self.client.post(URL, body(), format='json').status_code, (401, 403))

    def test_cashier_cannot_design(self):
        self.client.force_authenticate(user('CASHIER'))
        self.assertEqual(self.client.post(URL, body(), format='json').status_code, 403)

    def test_inventory_manager_cannot_add_restricted_pricing(self):
        self.client.force_authenticate(user('INVENTORY_MANAGER'))
        res = self.client.post(URL, body(elements=[field_el('w', 'wholesale_price')]), format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('restricted', str(res.data))
        self.assertEqual(self.client.post(URL, body(), format='json').status_code, 201)

    def test_inventory_manager_may_keep_existing_restricted_element(self):
        self.client.force_authenticate(user('MANAGER'))
        tid = self.client.post(URL, body(elements=[field_el('w', 'wholesale_price')]), format='json').data['id']
        self.client.force_authenticate(user('INVENTORY_MANAGER'))
        tpl = self.client.get(f'{URL}{tid}/').data
        layout = copy.deepcopy(tpl['layout'])
        layout['elements'][0]['x'] = 3
        res = self.client.patch(f'{URL}{tid}/', {'layout': layout, 'expected_version': 1}, format='json')
        self.assertEqual(res.status_code, 200, res.content)


class ConcurrentSeedTests(APITestCase):
    def test_seeding_twice_does_not_duplicate_presets(self):
        from apps.products.label_views import ensure_seeded
        ensure_seeded()
        LabelTemplate.objects.all().update()  # no-op; table now non-empty
        ensure_seeded()
        self.assertEqual(LabelTemplate.all_objects.count(), len(PRESETS))
        self.assertEqual(LabelPrintSettings.objects.count(), 1)
        self.assertEqual(LabelPrintSettings.load().pk, LabelPrintSettings.SINGLETON_ID)


class ShortInternalCodeTests(APITestCase):
    def test_internal_code_never_alters_sku_or_barcode(self):
        from apps.products.models import ProductBarcode
        p = Product.objects.create(name='Long code frame', sku='TIT-TW1234-GUN-54-XL', barcode='TITTW1234GUN54XL')
        fields = self.client.post('/api/products/label-data/', {'product_ids': [str(p.id)]}, format='json').data['products'][str(p.id)]['fields']
        self.assertEqual(fields['internal_code'], '')  # none yet — reading never mints
        series = self.client.post(f'/api/products/items/{p.id}/label_barcode_series/', {'count': 2}, format='json').data['barcodes']
        p.refresh_from_db()
        self.assertEqual((p.sku, p.barcode), ('TIT-TW1234-GUN-54-XL', 'TITTW1234GUN54XL'))
        fields = self.client.post('/api/products/label-data/', {'product_ids': [str(p.id)]}, format='json').data['products'][str(p.id)]['fields']
        self.assertEqual(fields['internal_code'], series[1])
        self.assertTrue(series[1].isdigit() and len(series[1]) == 13)
        self.assertEqual(ProductBarcode.objects.get(code=series[1]).product_id, p.id)

    def test_numeric_barcode_is_its_own_internal_code(self):
        p = Product.objects.create(name='Cloth', sku='ACC-1', barcode='200000100017')
        fields = self.client.post('/api/products/label-data/', {'product_ids': [str(p.id)]}, format='json').data['products'][str(p.id)]['fields']
        self.assertEqual(fields['internal_code'], '200000100017')

    def test_when_too_long_option_validated(self):
        el = {'id': 'b', 'type': 'barcode', 'x': 1, 'y': 1, 'w': 30, 'h': 10, 'barcode': {'whenTooLong': 'internal'}}
        _, _, clean = validate_template('thermal', 38, 25, {'elements': [el]}, True)
        self.assertEqual(clean['elements'][0]['barcode']['whenTooLong'], 'internal')
        with self.assertRaises(LayoutError):
            validate_template('thermal', 38, 25, {'elements': [dict(el, barcode={'whenTooLong': 'truncate'})]}, True)
