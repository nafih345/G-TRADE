import datetime

from django.contrib.auth import get_user_model
from rest_framework.test import APITestCase

from apps.billing.models import BillingSettings
from apps.company.models import Branch, Company

URL = '/api/company/store-profile/'
PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='


def user(role):
    return get_user_model().objects.create_user(username=role.lower(), password='x', role=role)


def body(**kw):
    return dict({
        'name': 'Vision Care Opticals', 'display_name': 'Vision Care', 'store_type': 'OPTICAL_AND_CLINIC',
        'gstin': '32abcde1234f1z5', 'phone': '98470 12345', 'email': 'Hello@VisionCare.in',
        'website': 'www.visioncare.in', 'address': '12 MG Road', 'city': 'Kochi', 'state': 'Kerala',
        'pin_code': '682001', 'country': 'India', 'tagline': 'Clear vision', 'logo_data_url': PNG,
        'opening_time': '09:30', 'closing_time': '20:00', 'working_days': ['SAT', 'MON'],
        'holidays': [{'date': '2026-12-25', 'name': 'Christmas'}], 'provides_eye_exams': True,
        'clinic_settings': {'exam_start': '10:00', 'exam_end': '18:00', 'slot_minutes': '20'},
        'branch_code': 'ho-1', 'contact_person': 'Dr. Mehta', 'clinical_reg_no': 'KMC-123',
    }, **kw)


class StoreProfileTests(APITestCase):
    def setUp(self):
        self.client.force_authenticate(user('SUPER_ADMIN'))

    def test_empty_install_defaults_to_india(self):
        Company.objects.all().delete()  # migration 0003 seeds a 'Main Company' row
        self.client.force_authenticate(None)
        res = self.client.get(URL)
        self.assertEqual(res.status_code, 200)
        self.assertFalse(res.data['exists'])
        self.assertEqual(res.data['country'], 'India')

    def test_save_normalises_and_shares_branding(self):
        res = self.client.put(URL, body(), format='json')
        self.assertEqual(res.status_code, 200, res.data)
        d = res.data
        self.assertEqual(d['phone'], '+91 98470 12345')
        self.assertEqual(d['gstin'], '32ABCDE1234F1Z5')
        self.assertEqual(d['email'], 'hello@visioncare.in')
        self.assertEqual(d['working_days'], ['MON', 'SAT'])
        self.assertEqual(d['branch_code'], 'HO-1')
        self.assertEqual(d['clinic_settings']['slot_minutes'], 20)
        # logo / tagline / website live on BillingSettings, shared with the Branding panel
        b = BillingSettings.load()
        self.assertEqual(b.logo_data_url, PNG)
        self.assertEqual(b.business_info['tagline'], 'Clear vision')
        self.assertEqual(Branch.get_default().code, 'HO-1')
        self.assertIn('completeness', d)

    def test_saving_twice_updates_the_same_row(self):
        before = Company.objects.count()
        self.client.put(URL, body(), format='json')
        self.client.put(URL, body(name='Renamed Store'), format='json')
        self.assertEqual(Company.objects.count(), max(before, 1))
        self.assertEqual(Company.objects.get().name, 'Renamed Store')

    def test_oldest_company_row_is_updated_when_duplicates_exist(self):
        today = datetime.date.today()
        first = Company.objects.order_by('created_at').first() or Company.objects.create(
            name='Old', fiscal_year_start=today, fiscal_year_end=today)
        dup = Company.objects.create(name='Dup', fiscal_year_start=today, fiscal_year_end=today)
        self.client.put(URL, body(), format='json')
        first.refresh_from_db()
        dup.refresh_from_db()
        self.assertEqual(first.name, 'Vision Care Opticals')
        self.assertEqual(dup.name, 'Dup')

    def test_field_errors(self):
        before = list(Company.objects.values_list('name', flat=True))
        res = self.client.put(URL, body(name='', phone='abc', email='nope', gstin='123',
                                        website='not a site', pin_code='012345',
                                        closing_time='08:00', working_days=['XYZ']), format='json')
        self.assertEqual(res.status_code, 400)
        for f in ('name', 'phone', 'email', 'gstin', 'website', 'pin_code', 'closing_time', 'working_days'):
            self.assertIn(f, res.data['errors'])
        self.assertEqual(list(Company.objects.values_list('name', flat=True)), before)

    def test_bad_logo_rejected(self):
        res = self.client.put(URL, body(logo_data_url='data:text/html;base64,PHA+'), format='json')
        self.assertIn('logo_data_url', res.data['errors'])

    def test_branch_code_must_be_unique(self):
        self.client.put(URL, body(), format='json')
        Branch.objects.create(company=Company.objects.order_by('created_at').first(), name='Second', code='B2')
        res = self.client.put(URL, body(branch_code='b2'), format='json')
        self.assertIn('branch_code', res.data['errors'])

    def test_patch_currency_keeps_other_fields(self):
        self.client.put(URL, body(), format='json')
        res = self.client.patch(URL, {'currency': '$'}, format='json')
        self.assertEqual(res.status_code, 200, res.data)
        self.assertEqual(res.data['currency'], '$')
        self.assertEqual(res.data['city'], 'Kochi')

    def test_completeness_reflects_saved_data(self):
        res = self.client.put(URL, body(logo_data_url='', email=''), format='json')
        sections = {s['key']: s for s in res.data['completeness']['sections']}
        self.assertTrue(sections['identity']['complete'])
        self.assertFalse(sections['contact']['complete'])
        self.assertIn('Email address', sections['contact']['missing'])
        self.assertIn('Store logo', sections['branding']['missing'])
        self.assertLess(res.data['completeness']['percent'], 100)

    def test_only_admins_can_write(self):
        self.client.force_authenticate(None)
        self.assertIn(self.client.put(URL, body(), format='json').status_code, (401, 403))
        self.client.force_authenticate(user('CASHIER'))
        self.assertEqual(self.client.put(URL, body(), format='json').status_code, 403)
        self.assertIn(self.client.post('/api/company/profile/', {'name': 'x'}, format='json').status_code, (401, 403))
