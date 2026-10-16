"""Bill & Invoice Designer: layout validation, compatibility, seeding, versioning,
assignment rules and permissions. Templates are presentation only — the last test checks
that no transaction table is touched by template operations."""
import copy
import re
from pathlib import Path

from django.contrib.auth import get_user_model
from django.test import SimpleTestCase
from rest_framework.test import APITestCase

from apps.billing import views as billing_views
from apps.billing.bill_fields import (
    COLUMN_KEYS, FIELD_IDS, LayoutError, compatible_document_types, incompatibility_reason, validate_config,
)
from apps.billing.bill_presets import VISUAL_DEFAULT_ASSIGNMENTS, VISUAL_PRESETS, all_visual_presets, visual_preset
from apps.billing.models import BillTemplate, BillTemplateVersion, BillingSettings, DocumentTemplateAssignment

T = '/api/billing/templates/'
A = '/api/billing/assignments/'
FRONTEND_FIELDS = Path(__file__).resolve().parents[3] / 'frontend' / 'src' / 'billing' / 'billFields.js'


def user(role, username=None):
    return get_user_model().objects.create_user(username=username or role.lower(), password='x', role=role)


def receipt_config():
    cfg = copy.deepcopy(visual_preset('receipt-a5')['config'])
    return cfg


class ValidationTests(SimpleTestCase):
    def test_every_preset_validates_and_is_stable(self):
        for spec in all_visual_presets():
            self.assertEqual(validate_config(spec['config']), spec['config'], spec['preset_key'])

    def test_unknown_field_and_element_rejected(self):
        cfg = visual_preset('classic-a4')['config']
        bad = copy.deepcopy(cfg)
        bad['bands']['header']['elements'].append({'id': 'x', 'type': 'field', 'field': 'customer.password', 'x': 0, 'y': 0, 'w': 5, 'h': 5})
        with self.assertRaisesMessage(LayoutError, 'unknown field'):
            validate_config(bad)
        bad = copy.deepcopy(cfg)
        bad['bands']['header']['elements'].append({'id': 'x', 'type': 'script', 'x': 0, 'y': 0, 'w': 5, 'h': 5})
        with self.assertRaises(LayoutError):
            validate_config(bad)
        bad = copy.deepcopy(cfg)
        bad['bands']['summary']['elements'].append({'id': 't', 'type': 'text', 'text': 'Hi {{user.password}}', 'x': 0, 'y': 0, 'w': 5, 'h': 5})
        with self.assertRaisesMessage(LayoutError, 'Unknown data field'):
            validate_config(bad)

    def test_markup_and_bad_values_are_cleaned(self):
        cfg = copy.deepcopy(visual_preset('classic-a4')['config'])
        el = cfg['bands']['header']['elements'][0]
        el['style'] = {'color': 'red;background:url(javascript:x)', 'fontSize': 999, 'onclick': 'x'}
        el['evil'] = '<script>'
        cfg['theme']['fontFamily'] = 'Comic</style><script>'
        out = validate_config(cfg)
        cleaned = out['bands']['header']['elements'][0]
        self.assertNotIn('evil', cleaned)
        self.assertNotIn('onclick', cleaned['style'])
        self.assertEqual(cleaned['style']['color'], '')
        self.assertEqual(cleaned['style']['fontSize'], 72)
        self.assertNotIn('script', out['theme']['fontFamily'])

    def test_images_must_be_small_rasters(self):
        cfg = copy.deepcopy(visual_preset('classic-a4')['config'])
        cfg['bands']['summary']['elements'].append({'id': 'img', 'type': 'image', 'src': 'data:image/svg+xml;base64,PHN2Zz4=', 'x': 0, 'y': 0, 'w': 5, 'h': 5})
        with self.assertRaises(LayoutError):
            validate_config(cfg)

    def test_legacy_config_passes_through(self):
        legacy = {'sections': [{'id': 'company', 'visible': True, 'config': {}}]}
        self.assertEqual(validate_config(legacy), legacy)
        self.assertEqual(len(compatible_document_types(legacy)), 8)

    def test_compatibility(self):
        self.assertEqual(compatible_document_types(visual_preset('receipt-a5')['config']), ['PAYMENT_RECEIPT'])
        self.assertEqual(compatible_document_types(visual_preset('purchase-a4')['config']), ['PURCHASE_BILL', 'PURCHASE_RETURN'])
        self.assertNotIn('PAYMENT_RECEIPT', compatible_document_types(visual_preset('classic-a4')['config']))
        self.assertIn('line items', incompatibility_reason(visual_preset('classic-a4')['config'], 'PAYMENT_RECEIPT'))
        # every recommended starter can print the document it is recommended for
        for dt, key in VISUAL_DEFAULT_ASSIGNMENTS.items():
            self.assertIn(dt, compatible_document_types(visual_preset(key)['config']), key)

    def test_field_catalog_matches_frontend(self):
        if not FRONTEND_FIELDS.exists():
            self.skipTest('frontend not checked out next to backend')
        src = FRONTEND_FIELDS.read_text(encoding='utf-8')
        js_fields = set(re.findall(r"^\s*f\('([a-zA-Z]+\.[a-zA-Z]+)'", src, re.M))
        js_cols = set(re.findall(r"^\s*c\('([a-zA-Z]+)'", src, re.M))
        self.assertEqual(js_fields, FIELD_IDS)
        self.assertEqual(js_cols, COLUMN_KEYS)


class ApiTests(APITestCase):
    def setUp(self):
        billing_views.reset_seed_flag()
        self.admin = user('SUPER_ADMIN', 'boss')
        self.client.force_authenticate(self.admin)

    def tearDown(self):
        billing_views.reset_seed_flag()

    def tpl(self, key):
        return BillTemplate.objects.get(preset_key=key, is_preset=True)

    def test_fresh_install_seeds_presets_and_assignments(self):
        res = self.client.get(T)
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.data), len(VISUAL_PRESETS))
        self.assertEqual(BillTemplate.objects.filter(is_default=True).count(), 1)
        rows = {a.document_type: a.template.preset_key for a in DocumentTemplateAssignment.objects.select_related('template')}
        self.assertEqual(rows, VISUAL_DEFAULT_ASSIGNMENTS)
        self.client.get(T)  # idempotent
        billing_views.reset_seed_flag()
        self.client.get(T)
        self.assertEqual(BillTemplate.objects.count(), len(VISUAL_PRESETS))

    def test_existing_install_keeps_its_choices(self):
        legacy = BillTemplate.objects.create(name='Standard Invoice', config={'sections': []}, is_default=True, is_preset=True, preset_key='legacy-standard')
        DocumentTemplateAssignment.objects.create(document_type='SALES_INVOICE', template=legacy)
        DocumentTemplateAssignment.objects.create(document_type='QUOTATION', template=None)
        self.client.get(T)
        self.assertEqual(DocumentTemplateAssignment.objects.get(document_type='SALES_INVOICE').template, legacy)
        self.assertIsNone(DocumentTemplateAssignment.objects.get(document_type='QUOTATION').template)  # "use default" kept
        self.assertEqual(DocumentTemplateAssignment.objects.get(document_type='PURCHASE_RETURN').template.preset_key, 'purchase-return-a4')
        self.assertTrue(BillTemplate.objects.get(pk=legacy.pk).is_default)

    def test_save_versioning_and_conflict(self):
        self.client.get(T)
        t = self.tpl('classic-a4')
        cfg = copy.deepcopy(t.config)
        cfg['bands']['header']['height'] = 70
        res = self.client.patch(f'{T}{t.id}/', {'config': cfg, 'expected_version': 1}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['version'], 2)
        self.assertEqual(BillTemplate.objects.get(pk=t.pk).config['bands']['header']['height'], 70)
        self.assertEqual(BillTemplateVersion.objects.get(template=t).config['bands']['header']['height'], 62)
        stale = self.client.patch(f'{T}{t.id}/', {'config': cfg, 'expected_version': 1}, format='json')
        self.assertEqual(stale.status_code, 409)
        back = self.client.post(f'{T}{t.id}/restore-version/', {'version': 1}, format='json')
        self.assertEqual(back.status_code, 200)
        self.assertEqual(back.data['version'], 3)
        self.assertEqual(back.data['config']['bands']['header']['height'], 62)

    def test_reload_reproduces_saved_design(self):
        self.client.get(T)
        t = self.tpl('modern-a4')
        cfg = copy.deepcopy(t.config)
        cfg['bands']['summary']['elements'][0]['x'] = 12.34
        self.client.patch(f'{T}{t.id}/', {'config': cfg, 'paper_size': 'A5', 'orientation': 'landscape'}, format='json')
        again = self.client.get(f'{T}{t.id}/').data
        self.assertEqual(again['config'], validate_config(cfg))
        self.assertEqual((again['paper_size'], again['orientation']), ('A5', 'landscape'))

    def test_duplicate_is_independent_and_rename_unique(self):
        self.client.get(T)
        src = self.tpl('classic-a4')
        dup = self.client.post(f'{T}{src.id}/duplicate/', {}, format='json').data
        cfg = copy.deepcopy(dup['config'])
        cfg['theme']['primary'] = '#ff0000'
        self.client.patch(f"{T}{dup['id']}/", {'config': cfg}, format='json')
        self.assertNotEqual(BillTemplate.objects.get(pk=src.pk).config['theme']['primary'], '#ff0000')
        clash = self.client.post(f"{T}{dup['id']}/rename/", {'name': src.name}, format='json')
        self.assertEqual(clash.status_code, 400)
        ok = self.client.post(f"{T}{dup['id']}/rename/", {'name': 'Shop invoice'}, format='json')
        self.assertEqual(ok.data['name'], 'Shop invoice')

    def test_incompatible_assignment_rejected(self):
        self.client.get(T)
        classic = self.tpl('classic-a4')
        receipt = self.tpl('receipt-a5')
        res = self.client.put(f'{A}bulk/', {'assignments': [{'document_type': 'PAYMENT_RECEIPT', 'template': str(classic.id)}]}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('PAYMENT_RECEIPT', res.data['errors'])
        res = self.client.post(f'{T}{receipt.id}/assign/', {'document_types': ['SALES_INVOICE']}, format='json')
        self.assertEqual(res.status_code, 400)
        ok = self.client.post(f'{T}{classic.id}/assign/', {'document_types': ['SALES_INVOICE', 'QUOTATION', 'RETURN_BILL'], 'replace': True}, format='json')
        self.assertEqual(ok.status_code, 200, ok.data)
        self.assertEqual(sorted(ok.data['used_by']), ['QUOTATION', 'SALES_INVOICE', 'SALES_RETURN'])

    def test_edit_cannot_break_assigned_documents(self):
        self.client.get(T)
        t = self.tpl('classic-a4')  # assigned to SALES_INVOICE
        cfg = copy.deepcopy(t.config)
        cfg['bands']['summary']['elements'].append({'id': 'r', 'type': 'field', 'field': 'receipt.amount', 'x': 0, 'y': 0, 'w': 5, 'h': 5})
        res = self.client.patch(f'{T}{t.id}/', {'config': cfg}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('Sales Invoice', str(res.data))

    def test_delete_releases_assignments_and_can_be_undone(self):
        self.client.get(T)
        t = self.tpl('wholesale-a4')
        self.assertEqual(self.client.delete(f'{T}{t.id}/').status_code, 204)
        self.assertIsNone(DocumentTemplateAssignment.objects.get(document_type='WHOLESALE_BILL').template)
        self.assertEqual(self.client.delete(f'{T}{self.tpl("classic-a4").id}/').status_code, 400)  # the default
        self.assertEqual(len(self.client.get(f'{T}deleted/').data), 1)
        self.assertEqual(self.client.post(f'{T}{t.id}/undelete/').status_code, 200)

    def test_restore_defaults(self):
        self.client.get(T)
        t = self.tpl('compact-a5')
        cfg = copy.deepcopy(t.config)
        cfg['theme']['primary'] = '#123456'
        self.client.patch(f'{T}{t.id}/', {'config': cfg}, format='json')
        self.client.delete(f"{T}{self.tpl('quotation-a4').id}/")
        res = self.client.post(f'{T}restore-defaults/', {'reset_modified': True, 'reassign': True}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.data['created']), 1)
        self.assertIn(t.name, res.data['reset'])
        self.assertNotEqual(BillTemplate.objects.get(pk=t.pk).config['theme']['primary'], '#123456')
        self.assertTrue(BillTemplateVersion.objects.filter(template=t).exists())
        self.assertEqual(DocumentTemplateAssignment.objects.get(document_type='QUOTATION').template.preset_key, 'quotation-a4')

    def test_from_preset_and_create(self):
        res = self.client.post(f'{T}from-preset/', {'preset_key': 'thermal-80'}, format='json')
        self.assertEqual(res.status_code, 201)
        self.assertEqual(res.data['paper_size'], '80mm')
        self.assertFalse(res.data['is_preset'])
        bad = self.client.post(T, {'name': 'X', 'paper_size': 'B9', 'config': {}}, format='json')
        self.assertEqual(bad.status_code, 400)
        custom = self.client.post(T, {'name': 'Label bill', 'paper_size': 'CUSTOM', 'custom_width_mm': 100, 'config': visual_preset('compact-a5')['config']}, format='json')
        self.assertEqual(custom.status_code, 201, custom.data)

    def test_permissions(self):
        self.client.get(T)
        t = self.tpl('classic-a4')
        self.client.force_authenticate(user('SALES_EXECUTIVE', 'clerk'))
        self.assertEqual(self.client.get(T).status_code, 200)
        self.assertEqual(self.client.patch(f'{T}{t.id}/', {'description': 'x'}, format='json').status_code, 403)
        self.assertEqual(self.client.post(f'{T}{t.id}/duplicate/').status_code, 403)
        self.assertEqual(self.client.patch('/api/billing/settings/', {'primary_color': '#000000'}, format='json').status_code, 403)
        self.assertFalse(self.client.get('/api/billing/meta/').data['can_design'])
        self.client.force_authenticate(None)
        self.assertEqual(self.client.get(T).status_code, 200)  # printing reads stay open
        self.assertEqual(self.client.delete(f'{T}{t.id}/').status_code in (401, 403), True)
        self.client.force_authenticate(user('MANAGER', 'mgr'))
        self.assertTrue(self.client.get('/api/billing/meta/').data['can_design'])

    def test_settings_validation(self):
        res = self.client.patch('/api/billing/settings/', {'logo_data_url': 'data:image/svg+xml;base64,AA'}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.client.patch('/api/billing/settings/', {'themes': [{'name': 'Mine', 'primary': '#112233', 'accent': 'javascript:x'}], 'business_info': {'upiId': 'shop@upi'}}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['themes'], [{'name': 'Mine', 'primary': '#112233'}])

    def test_template_operations_never_touch_transactions(self):
        from apps.sales.models import Invoice, Payment
        from apps.purchasing.models import PurchaseInvoice
        before = (Invoice.all_objects.count(), Payment.all_objects.count(), PurchaseInvoice.all_objects.count())
        self.client.get(T)
        t = self.tpl('classic-a4')
        self.client.post(f'{T}{t.id}/duplicate/')
        self.client.post(f'{T}restore-defaults/', {'reset_modified': True, 'reassign': True}, format='json')
        self.assertEqual(before, (Invoice.all_objects.count(), Payment.all_objects.count(), PurchaseInvoice.all_objects.count()))
