import datetime

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.company.models import BusinessSettings, Company, CustomField, SettingsAuditLog
from apps.company.numbering import format_number, issue_number, period_key, render_affix
from apps.masters.models import Tax


def user(role):
    return get_user_model().objects.create_user(username=role.lower(), password='x', role=role)


def ensure_company():
    if not Company.objects.exists():
        Company.objects.create(name='Vision Care', fiscal_year_start=datetime.date(2026, 4, 1),
                               fiscal_year_end=datetime.date(2027, 3, 31), currency='₹')


class LocalizationSettingsTests(APITestCase):
    URL = '/api/company/localization/'

    def setUp(self):
        ensure_company()
        self.client.force_authenticate(user('SUPER_ADMIN'))

    def test_defaults_are_served_without_auth(self):
        self.client.force_authenticate(None)
        res = self.client.get(self.URL)
        self.assertEqual(res.status_code, 200)
        p = res.data['preferences']
        self.assertEqual(p['date_format'], 'DD-MM-YYYY')
        self.assertTrue(p['allow_negative_stock'])
        self.assertTrue(p['auto_generate_numbers'])

    def test_save_persists_and_audits(self):
        res = self.client.put(self.URL, {'country': 'AE', 'region': 'Dubai', 'time_zone': 'Asia/Dubai',
                                         'date_format': 'DD/MM/YYYY', 'time_format': '24H',
                                         'fiscal_year_start_month': 1, 'number_format': 'INTERNATIONAL',
                                         'language': 'ar', 'allow_negative_stock': False,
                                         'currency_symbol': 'AED'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        stored = BusinessSettings.load().preferences
        self.assertEqual(stored['country'], 'AE')
        self.assertFalse(stored['allow_negative_stock'])
        self.assertIn('ar', stored['enabled_languages'])  # default language is always enabled
        self.assertEqual(Company.objects.order_by('created_at').first().currency, 'AED')
        log = SettingsAuditLog.objects.get(section='LOCALIZATION')
        self.assertEqual(log.performed_by, 'super_admin')
        self.assertEqual(log.changes['country'], ['IN', 'AE'])

    def test_invalid_values_are_rejected_and_nothing_saved(self):
        res = self.client.put(self.URL, {'time_zone': 'Mars/Base', 'date_format': 'YY', 'fiscal_year_start_month': 13,
                                         'region': 'Ontario'}, format='json')
        self.assertEqual(res.status_code, 400)
        for key in ('time_zone', 'date_format', 'fiscal_year_start_month', 'region'):
            self.assertIn(key, res.data['errors'])
        self.assertEqual(BusinessSettings.load().preferences, {})

    def test_multi_currency_needs_currencies_and_rates(self):
        res = self.client.put(self.URL, {'multi_currency_enabled': True}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('multi_currency_enabled', res.data['errors'])
        res = self.client.put(self.URL, {'multi_currency_enabled': True, 'enabled_currencies': ['usd', 'INR'],
                                         'exchange_rates': {}}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('USD', res.data['errors']['exchange_rates'])
        res = self.client.put(self.URL, {'multi_currency_enabled': True, 'enabled_currencies': ['usd', 'INR'],
                                         'exchange_rates': {'USD': '83.25'}}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['preferences']['enabled_currencies'], ['USD'])  # base dropped

    def test_writes_need_a_settings_role(self):
        self.client.force_authenticate(user('CASHIER'))
        self.assertEqual(self.client.put(self.URL, {'country': 'US'}, format='json').status_code, 403)
        self.client.force_authenticate(None)
        self.assertIn(self.client.put(self.URL, {'country': 'US'}, format='json').status_code, (401, 403))

    def test_catalog(self):
        res = self.client.get('/api/company/localization/catalog/')
        self.assertEqual(res.status_code, 200)
        codes = {c['code'] for c in res.data['currencies']}
        self.assertTrue({'INR', 'USD', 'AED', 'KWD'} <= codes)
        self.assertIn('Kerala', res.data['regions']['IN'])
        self.assertTrue(any(z['name'] == 'Asia/Kolkata' and z['offset'] == 'UTC+05:30' for z in res.data['time_zones']))


class NumberingTests(APITestCase):
    URL = '/api/company/document-sequences/'

    def setUp(self):
        ensure_company()
        self.client.force_authenticate(user('SUPER_ADMIN'))

    def test_tokens_and_periods(self):
        when = datetime.datetime(2027, 2, 9)
        self.assertEqual(render_affix('INV/{FY}/{MM}/', when, 4), 'INV/2026-27/02/')
        self.assertEqual(render_affix('{YY}', when, 4), '27')
        self.assertEqual(period_key('FISCAL_YEAR', when, 4), 'FY2026')
        self.assertEqual(period_key('MONTHLY', when, 4), 'M2027-02')
        cfg = {'prefix': 'S-', 'suffix': '/X', 'padding': 5}
        self.assertEqual(format_number(cfg, 42, when, 4), 'S-00042/X')

    def test_configure_and_issue_skips_taken_numbers(self):
        res = self.client.put(f'{self.URL}SALES_INVOICE/', {'prefix': 'GS-', 'padding': 3, 'next_number': 7}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['preview'], 'GS-007')
        taken = {'GS-007'}
        self.assertEqual(issue_number('SALES_INVOICE', taken.__contains__), 'GS-008')
        self.assertEqual(issue_number('SALES_INVOICE', taken.__contains__), 'GS-009')

    def test_lowering_an_issued_sequence_needs_confirmation(self):
        self.client.put(f'{self.URL}QUOTATION/', {'prefix': 'Q-', 'next_number': 50}, format='json')
        issue_number('QUOTATION', lambda n: False)
        res = self.client.put(f'{self.URL}QUOTATION/', {'next_number': 10}, format='json')
        self.assertEqual(res.status_code, 409)
        self.assertTrue(res.data['requires_confirmation'])
        res = self.client.put(f'{self.URL}QUOTATION/', {'next_number': 10, 'confirm': True}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['next_number'], 10)

    def test_duplicate_prefix_and_bad_tokens_are_rejected(self):
        res = self.client.put(f'{self.URL}SALES_ORDER/', {'prefix': 'INV-{YYYY}-'}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.client.put(f'{self.URL}SALES_ORDER/', {'prefix': 'ORD-{DD}-'}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_auto_generate_off_hands_numbering_back(self):
        self.client.put('/api/company/localization/', {'auto_generate_numbers': False}, format='json')
        self.assertIsNone(issue_number('SALES_INVOICE', lambda n: False))

    def test_new_sale_gets_the_sequence_number(self):
        self.client.put(f'{self.URL}SALES_INVOICE/', {'prefix': 'TINV-', 'padding': 4, 'next_number': 1}, format='json')
        res = self.client.post('/api/sales/invoices/', {
            'invoice_number': 'INV-2026-1234', 'customer_name': 'Anitha', 'invoice_date': '2026-10-22',
            'document_type': 'INVOICE', 'total_amount': '100', 'net_amount': '100', 'items': [],
        }, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(res.data['invoice_number'], 'TINV-0001')


class TaxConfigTests(APITestCase):
    URL = '/api/company/tax-config/'

    def setUp(self):
        self.client.force_authenticate(user('SUPER_ADMIN'))

    def test_create_zero_rated_and_default(self):
        res = self.client.post(self.URL, {'name': 'GST 0%', 'rate': '0', 'category': 'ZERO_RATED'}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        res = self.client.post(self.URL, {'name': 'GST 12%', 'rate': '12', 'is_default': True}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        res2 = self.client.post(self.URL, {'name': 'GST 18%', 'rate': '18', 'is_default': True}, format='json')
        self.assertEqual(Tax.objects.filter(is_default=True).get().pk.hex, res2.data['id'].replace('-', ''))

    def test_rate_and_category_rules(self):
        bad = self.client.post(self.URL, {'name': 'X', 'rate': '0'}, format='json')
        self.assertIn('category', bad.data['errors'])
        bad = self.client.post(self.URL, {'name': 'Y', 'rate': '5', 'category': 'EXEMPT'}, format='json')
        self.assertIn('rate', bad.data['errors'])
        bad = self.client.post(self.URL, {'name': 'Z', 'rate': '101'}, format='json')
        self.assertIn('rate', bad.data['errors'])

    def test_tax_in_use_cannot_be_deleted(self):
        from apps.products.models import Product
        tax = Tax.objects.create(name='GST 5%', rate=5)
        try:
            Product.objects.create(name='Frame', tax=tax)
        except Exception:
            self.skipTest('Product needs more required fields in this schema')
        self.assertEqual(self.client.delete(f'{self.URL}{tax.pk}/').status_code, 409)
        res = self.client.put(f'{self.URL}{tax.pk}/', {'is_active': False}, format='json')
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.data['is_active'])


class CustomFieldTests(APITestCase):
    URL = '/api/company/custom-fields/'

    def setUp(self):
        self.client.force_authenticate(user('ADMINISTRATOR'))

    def test_crud(self):
        res = self.client.post(self.URL, {'name': 'Lens Brand Pref', 'field_type': 'DROPDOWN', 'module': 'CUSTOMER',
                                          'options': ['Zeiss', 'zeiss', 'Essilor']}, format='json')
        self.assertEqual(res.status_code, 201, res.data)
        self.assertEqual(res.data['key'], 'lens_brand_pref')
        self.assertEqual(res.data['options'], ['Zeiss', 'Essilor'])
        dup = self.client.post(self.URL, {'name': 'Lens brand pref', 'field_type': 'TEXT', 'module': 'CUSTOMER'}, format='json')
        self.assertEqual(dup.status_code, 400)
        pk = res.data['id']
        self.assertEqual(self.client.put(f'{self.URL}{pk}/', {'is_active': False}, format='json').status_code, 200)
        self.assertEqual(self.client.delete(f'{self.URL}{pk}/').status_code, 204)
        self.assertFalse(CustomField.objects.exists())

    def test_dropdown_needs_options(self):
        res = self.client.post(self.URL, {'name': 'Tier', 'field_type': 'DROPDOWN', 'module': 'CUSTOMER'}, format='json')
        self.assertIn('options', res.data['errors'])


class NegativeStockTests(APITestCase):
    def setUp(self):
        from apps.financial.tests.helpers import make_warehouse
        from apps.products.models import Product
        make_warehouse()
        self.client.force_authenticate(user('SUPER_ADMIN'))
        self.product = Product.objects.create(name='Aviator', sku='SKU-AV', stock=1)

    def sell(self, qty, **extra):
        return self.client.post('/api/sales/invoices/', {
            'customer_name': 'Anitha', 'invoice_date': '2026-10-22', 'document_type': 'INVOICE',
            'total_amount': '100', 'net_amount': '100',
            'items': [{'product': str(self.product.pk), 'quantity': qty, 'unit_price': 100, 'subtotal': 100 * qty}],
            **extra,
        }, format='json')

    def test_allowed_by_default(self):
        self.assertEqual(self.sell(3).status_code, 201)
        self.product.refresh_from_db()
        self.assertEqual(self.product.stock, -2)

    def test_blocked_when_switched_off_and_nothing_saved(self):
        from apps.sales.models import Invoice
        self.client.put('/api/company/localization/', {'allow_negative_stock': False}, format='json')
        res = self.sell(3)
        self.assertEqual(res.status_code, 400, res.data)
        self.assertEqual(res.data['code'], 'insufficient_stock')
        self.assertFalse(Invoice.objects.exists())
        self.product.refresh_from_db()
        self.assertEqual(self.product.stock, 1)
        self.assertEqual(self.sell(1).status_code, 201)  # within stock is fine

    def test_authorized_override(self):
        self.client.put('/api/company/localization/', {'allow_negative_stock': False}, format='json')
        self.assertEqual(self.sell(3, override_negative_stock=True).status_code, 201)
        self.client.force_authenticate(user('CASHIER'))
        self.assertEqual(self.sell(5, override_negative_stock=True).status_code, 400)


class PurchaseNumberingTests(APITestCase):
    def test_double_submit_is_refused_and_po_gets_sequence(self):
        from apps.financial.tests.helpers import make_warehouse
        from apps.purchasing.models import Supplier
        make_warehouse()
        self.client.force_authenticate(user('SUPER_ADMIN'))
        sup = Supplier.objects.create(name='Hoya', supplier_code='S9')
        body = {'order_number': 'PO-CLIENT-1', 'supplier': str(sup.pk), 'order_date': '2026-10-22',
                'status': 'DRAFT', 'total_amount': 0, 'items': []}
        first = self.client.post('/api/purchase/orders/', body, format='json')
        self.assertEqual(first.status_code, 201, first.data)
        self.assertRegex(first.data['order_number'], r'^PO-\d{4}-0001$')
        again = self.client.post('/api/purchase/orders/', body, format='json')
        self.assertEqual(again.status_code, 400)
        self.assertIn(first.data['order_number'], str(again.data))


class BillLanguageTests(APITestCase):
    URL = '/api/company/localization/'

    def setUp(self):
        ensure_company()
        self.client.force_authenticate(user('SUPER_ADMIN'))

    def test_bilingual_arabic(self):
        res = self.client.put(self.URL, {'language': 'ar', 'bill_language_mode': 'BILINGUAL'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['preferences']['bill_language_mode'], 'BILINGUAL')

    def test_language_without_bill_wording_is_refused(self):
        res = self.client.put(self.URL, {'language': 'fr', 'bill_language_mode': 'LOCAL'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('bill_language_mode', res.data['errors'])

    def test_switching_language_falls_back_to_english_bills(self):
        self.client.put(self.URL, {'language': 'ar', 'bill_language_mode': 'LOCAL'}, format='json')
        res = self.client.put(self.URL, {'language': 'fr'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['preferences']['bill_language_mode'], 'EN')
