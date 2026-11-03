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
DEACTIVATE = {'category': 'NON_PAYMENT', 'reason': 'Subscription unpaid for 3 months'}


def _rows(res):
    rows = res.data['results'] if isinstance(res.data, dict) else res.data
    return [r['name'] for r in rows]


class SuperAdminFixture(TestCase):
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


class SuperAdminTenantTests(SuperAdminFixture):
    def test_only_platform_admin_gets_in(self):
        self.assertTrue(self.api.login_payload['user']['is_platform_admin'])
        for username in ('otheradmin', 't1admin'):
            client = self._login(username)
            self.assertFalse(client.login_payload['user']['is_platform_admin'])
            self.assertEqual(client.get(URL).status_code, 403)
            self.assertEqual(client.post(URL, {}, format='json').status_code, 403)
            self.assertEqual(client.post(f'{URL}{self.other.pk}/deactivate/', DEACTIVATE,
                                         format='json').status_code, 403)
            self.assertEqual(client.get(f'{URL}catalog/').status_code, 403)
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
        self.assertEqual(self.api.post(f'{URL}{self.other.pk}/deactivate/', {'category': 'OTHER'},
                                       format='json').status_code, 400)  # reason is mandatory
        res = self.api.post(f'{URL}{self.other.pk}/deactivate/', DEACTIVATE, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertFalse(res.data['is_active'])
        self.assertEqual(res.data['status'], 'INACTIVE')
        self.assertEqual(res.data['deactivation_reason'], DEACTIVATE['reason'])
        self.assertEqual(res.data['deactivated_by'], 'platform')
        self.assertIn(client.get('/api/auth/profile/').status_code, (401, 403))
        # Views that skip authentication (AllowAny) get no tenant scope from the stale token.
        self.assertEqual(_rows(client.get('/api/company/branches/')), [])
        res = APIClient().post('/api/auth/login/', {'username': 'otheradmin', 'password': PASSWORD}, format='json')
        self.assertEqual(res.data['code'], 'tenant_inactive')

        res = self.api.post(f'{URL}{self.other.pk}/reactivate/', {'reason': 'Paid'}, format='json')
        self.assertEqual(res.data['status'], 'ACTIVE')
        self.assertEqual(res.data['deactivation_reason'], '')
        self._login('otheradmin')
        actions = [r['action'] for r in self.api.get(f'{URL}{self.other.pk}/audit/').data]
        self.assertEqual(actions[:2], ['REACTIVATED', 'DEACTIVATED'])

    def test_platform_tenant_cannot_be_deactivated(self):
        res = self.api.post(f'{URL}{self.t1.pk}/deactivate/', DEACTIVATE, format='json')
        self.assertEqual(res.status_code, 400)
        self.t1.refresh_from_db()
        self.assertTrue(self.t1.is_active)


class ClientManagementTests(SuperAdminFixture):
    """Modules, seats, users, branches and scheduled deactivation (on top of the base fixture)."""

    def _new_client(self, **overrides):
        res = self._onboard(**overrides)
        self.assertEqual(res.status_code, 201, res.content)
        return Tenant.objects.get(pk=res.data['id'])

    def _users(self, tenant):
        return {u['username']: u for u in self.api.get(f'{URL}{tenant.pk}/').data['users']}

    def test_packages_and_dependencies(self):
        from apps.common import module_access as ma
        self.assertEqual(ma.normalize_modules('ACCOUNTS_ONLY', ['sales']),
                         ('ACCOUNTS_ONLY', ['financial', 'admin', 'reports', 'settings']))
        # Financial with any operational module is integrated: it brings all of them.
        package, modules = ma.normalize_modules('CUSTOM', ['financial', 'optical'])
        self.assertEqual(package, 'CUSTOM')
        self.assertTrue(set(ma.OPERATIONAL) <= set(modules))
        # ... without any it stays standalone.
        self.assertEqual(ma.normalize_modules('CUSTOM', ['financial', 'admin']), ('CUSTOM', ['financial', 'admin']))
        self.assertEqual(ma.normalize_modules('CUSTOM', list(ma.MODULE_KEYS))[0], 'FULL_SUITE')
        self.assertEqual(ma.normalize_modules('CUSTOM', ['sales'])[1], ['sales', 'inventory'])
        with self.assertRaises(ValueError):
            ma.normalize_modules('CUSTOM', ['reports'])

        tenant = self._new_client(package='ACCOUNTS_ONLY', max_users=3)
        self.assertEqual((tenant.package, tenant.max_users), ('ACCOUNTS_ONLY', 3))
        res = self.api.patch(f'{URL}{tenant.pk}/', {'package': 'CUSTOM', 'modules': ['optical']}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['modules'], ['optical'])
        self.assertEqual(self.api.patch(f'{URL}{self.t1.pk}/', {'package': 'OPERATIONS'},
                                        format='json').status_code, 400)

    def test_module_gate_on_api_writes(self):
        tenant = self._new_client(package='ACCOUNTS_ONLY')
        owner = self._login('cityadmin', 'Gl4sses-Dubai-77')
        self.assertEqual(owner.login_payload['user']['module_access']['sales'], 'none')
        self.assertEqual(owner.login_payload['user']['module_access']['financial'], 'full')
        res = owner.post('/api/sales/customers/', {'name': 'Walk-in'}, format='json')
        self.assertEqual((res.status_code, res.data['code']), (403, 'module_disabled'))
        # Reads stay open; settings (enabled) still writable.
        self.assertEqual(owner.get('/api/sales/customers/').status_code, 200)
        self.assertNotEqual(owner.post('/api/company/branches/', {'name': 'X', 'code': 'X'},
                                       format='json').status_code, 403)

        # Role level: only differences from the defaults are stored.
        self.api.patch(f'{URL}{tenant.pk}/', {'package': 'FULL_SUITE', 'role_permissions': {
            'SALES_EXECUTIVE': {'optical': 'view', 'reports': 'none'}}}, format='json')
        tenant.refresh_from_db()
        self.assertEqual(tenant.role_permissions, {'SALES_EXECUTIVE': {'reports': 'none'}})
        from apps.common.module_access import effective_access
        staff = get_user_model().objects.create_user('citysales', password=PASSWORD, role='SALES_EXECUTIVE',
                                                     tenant=tenant)
        access = effective_access(staff)
        self.assertEqual((access['sales'], access['optical'], access['reports'], access['financial']),
                         ('full', 'view', 'none', 'none'))

    def test_seat_limit_and_users(self):
        tenant = self._new_client(max_users=2)
        branch_id = self.api.get(f'{URL}{tenant.pk}/').data['branches'][0]['id']
        body = {'username': 'optom1', 'password': 'Opt0m-Strong-55', 'role': 'OPTOMETRIST',
                'branch_ids': [branch_id], 'default_branch_id': branch_id}
        res = self.api.post(f'{URL}{tenant.pk}/users/', body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        optom = self._users(tenant)['optom1']
        self.assertEqual(optom['branch_access']['branch_ids'], [str(branch_id)])
        res = self.api.post(f'{URL}{tenant.pk}/users/', {**body, 'username': 'optom2'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('seats', res.data['max_users'][0])
        self.assertEqual(self.api.patch(f'{URL}{tenant.pk}/', {'max_users': 1}, format='json').status_code, 400)

        # The only Super Admin can't be demoted or disabled.
        admin = self._users(tenant)['cityadmin']
        self.assertEqual(self.api.patch(f'{URL}{tenant.pk}/users/{admin["id"]}/', {'role': 'MANAGER'},
                                        format='json').status_code, 400)
        res = self.api.patch(f'{URL}{tenant.pk}/users/{optom["id"]}/', {'is_active': False, 'role': 'DOCTOR'},
                             format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(self.api.post(f'{URL}{tenant.pk}/users/', {**body, 'username': 'optom2'},
                                       format='json').status_code, 201)  # seat freed
        self.assertEqual(self.api.patch(f'{URL}{tenant.pk}/users/{optom["id"]}/', {'is_active': True},
                                        format='json').status_code, 400)  # no seat to come back to
        res = self.api.post(f'{URL}{tenant.pk}/users/{optom["id"]}/reset-password/', {'password': 'x'}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.api.post(f'{URL}{tenant.pk}/users/{optom["id"]}/reset-password/',
                            {'password': 'N3w-Strong-pass-9'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)

    def test_branches(self):
        tenant = self._new_client()
        res = self.api.post(f'{URL}{tenant.pk}/branches/', {'name': 'Karama', 'code': 'krm', 'city': 'Dubai'},
                            format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(self.api.post(f'{URL}{tenant.pk}/branches/', {'name': 'Dup', 'code': 'KRM'},
                                       format='json').status_code, 400)
        karama = next(b for b in res.data['branches'] if b['code'] == 'KRM')
        res = self.api.patch(f'{URL}{tenant.pk}/branches/{karama["id"]}/', {'is_default': True}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual([b['code'] for b in res.data['branches'] if b['is_default']], ['KRM'])
        res = self.api.patch(f'{URL}{tenant.pk}/branches/{karama["id"]}/', {'is_active': False}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.api.patch(f'{URL}{tenant.pk}/', {'multi_branch_enabled': True}, format='json')
        self.assertTrue(res.data['multi_branch_enabled'])
        with tenancy.use_tenant(self.t1.pk):
            self.assertFalse(Branch.objects.filter(code='KRM').exists())  # stayed in the client's tenant

    def test_scheduled_deactivation(self):
        import datetime
        from django.utils import timezone
        tenant = self._new_client()
        later = timezone.localdate() + datetime.timedelta(days=10)
        res = self.api.post(f'{URL}{tenant.pk}/deactivate/', {**DEACTIVATE, 'effective_date': later.isoformat()},
                            format='json')
        self.assertEqual(res.data['status'], 'SCHEDULED')
        client = self._login('cityadmin', 'Gl4sses-Dubai-77')  # still works until the date
        self.assertEqual(client.get('/api/auth/profile/').status_code, 200)
        Tenant.objects.filter(pk=tenant.pk).update(deactivation_effective_date=timezone.localdate())
        self.assertIn(client.get('/api/auth/profile/').status_code, (401, 403))
        rows = {r['id']: r for r in self.api.get(URL).data}
        self.assertEqual((rows[tenant.pk]['status'], rows[tenant.pk]['is_active']), ('INACTIVE', False))
        actions = [r['action'] for r in self.api.get(f'{URL}{tenant.pk}/audit/').data]
        self.assertEqual(actions[:2], ['DEACTIVATION_EFFECTIVE', 'DEACTIVATION_SCHEDULED'])
