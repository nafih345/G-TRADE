"""Platform console: /api/superadmin/tenants/ (apps/common/superadmin_views.py)."""
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient

from apps.common import tenancy
from apps.common.models import Tenant
from apps.company.models import Branch, Company

PASSWORD = 'Str0ng-pass-123'
URL = '/api/superadmin/tenants/'


def _rows(res):
    rows = res.data['results'] if isinstance(res.data, dict) else res.data
    return [r['name'] for r in rows]


class SuperAdminTenantTests(TestCase):
    def setUp(self):
        cache.clear()  # login throttle counters; these tests sign in a lot
        self.addCleanup(cache.clear)
        User = get_user_model()
        self.t1 = Tenant.objects.get(pk=tenancy.DEFAULT_TENANT_ID)
        User.objects.create_superuser('platform', password=PASSWORD, tenant=self.t1)
        self.other = Tenant.objects.create(name='Other Shop', code='other-shop')
        User.objects.create_user('otheradmin', password=PASSWORD, role='SUPER_ADMIN', tenant=self.other)
        User.objects.create_user('t1admin', password=PASSWORD, role='SUPER_ADMIN', tenant=self.t1)
        self.api = self._login('platform')

    def _login(self, username, password=PASSWORD):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': password}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.post('/api/security/reauth/', {'password': password}, format='json')
        client.login_payload = res.data
        return client

    def _onboard(self, **overrides):
        body = {'tenant_name': 'City Opticals UAE', 'admin_username': 'cityadmin', 'password': 'Gl4sses-Dubai-77',
                'admin_email': 'owner@city.example', 'contact_phone': '+971500000000', 'branch_name': 'Deira'}
        body.update(overrides)
        return self.api.post(URL, body, format='json')

    def test_only_platform_admin_gets_in(self):
        self.assertTrue(self.api.login_payload['user']['is_platform_admin'])
        for username in ('otheradmin', 't1admin'):
            client = self._login(username)
            self.assertFalse(client.login_payload['user']['is_platform_admin'])
            self.assertEqual(client.get(URL).status_code, 403)
            self.assertEqual(client.post(URL, {}, format='json').status_code, 403)
            self.assertEqual(client.post(f'{URL}{self.other.pk}/set-active/', {'is_active': False},
                                         format='json').status_code, 403)
        self.assertEqual(APIClient().get(URL).status_code, 401)

    def test_onboarded_admin_can_sign_in_immediately_into_own_tenant(self):
        res = self._onboard()
        self.assertEqual(res.status_code, 201, res.content)
        tenant = Tenant.objects.get(pk=res.data['id'])
        self.assertEqual(res.data['admin_username'], 'cityadmin')
        self.assertEqual(res.data['branch_count'], 1)
        admin = get_user_model().objects.get(username='cityadmin')
        self.assertEqual((admin.tenant_id, admin.role, admin.is_superuser, admin.is_staff),
                         (tenant.pk, 'SUPER_ADMIN', False, False))
        with tenancy.use_tenant(tenant.pk):
            self.assertEqual(Company.objects.get().name, 'City Opticals UAE')
            self.assertEqual(Branch.get_default().name, 'Deira')

        from rest_framework_simplejwt.tokens import AccessToken
        client = self._login('cityadmin', 'Gl4sses-Dubai-77')
        self.assertEqual(AccessToken(client.login_payload['access'])['tenant_id'], tenant.pk)
        # Sees its own branch only, not the platform tenant's.
        self.assertEqual(_rows(client.get('/api/company/branches/')), ['Deira'])

    def test_validation_errors_are_per_field(self):
        res = self._onboard(admin_username='otheradmin')
        self.assertEqual(res.status_code, 400)
        self.assertIn('already taken', res.data['admin_username'][0])
        res = self._onboard(tenant_name='other shop', admin_username='fresh')
        self.assertIn('tenant_name', res.data)
        res = self._onboard(tenant_name='', admin_username='', password='')
        self.assertEqual(set(res.data) >= {'tenant_name', 'admin_username', 'password'}, True)
        res = self._onboard(password='123')
        self.assertIn('password', res.data)
        self.assertFalse(Tenant.objects.filter(name='City Opticals UAE').exists())

    def test_list_and_detail(self):
        self._onboard()
        rows = {r['name']: r for r in self.api.get(URL).data}
        self.assertEqual(rows['City Opticals UAE']['primary_admin'], 'cityadmin')
        self.assertEqual(rows['City Opticals UAE']['user_count'], 1)
        self.assertEqual(rows['Other Shop']['primary_admin'], 'otheradmin')
        detail = self.api.get(f"{URL}{rows['City Opticals UAE']['id']}/").data
        self.assertEqual([u['username'] for u in detail['users']], ['cityadmin'])
        self.assertEqual([b['name'] for b in detail['branches']], ['Deira'])

    def test_deactivate_blocks_sign_in_and_live_tokens(self):
        import datetime
        with tenancy.use_tenant(self.other.pk):
            company = Company.objects.create(name='Other', fiscal_year_start=datetime.date(2026, 4, 1),
                                             fiscal_year_end=datetime.date(2027, 3, 31))
            Branch.objects.create(company=company, name='Other HO', code='HO', is_default=True)
        client = self._login('otheradmin')
        self.assertEqual(_rows(client.get('/api/company/branches/')), ['Other HO'])
        res = self.api.post(f'{URL}{self.other.pk}/set-active/', {'is_active': False}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.data['is_active'])
        self.assertIn(client.get('/api/auth/profile/').status_code, (401, 403))
        # Views that skip authentication (AllowAny) get no tenant scope from the stale token.
        self.assertEqual(_rows(client.get('/api/company/branches/')), [])
        res = APIClient().post('/api/auth/login/', {'username': 'otheradmin', 'password': PASSWORD}, format='json')
        self.assertEqual(res.data['code'], 'tenant_inactive')

        self.api.post(f'{URL}{self.other.pk}/set-active/', {'is_active': True}, format='json')
        self._login('otheradmin')

    def test_platform_tenant_cannot_be_deactivated(self):
        res = self.api.post(f'{URL}{self.t1.pk}/set-active/', {'is_active': False}, format='json')
        self.assertEqual(res.status_code, 400)
        self.t1.refresh_from_db()
        self.assertTrue(self.t1.is_active)
