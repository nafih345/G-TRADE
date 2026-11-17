"""Super Admin / Client Management completion (2026-11-13): platform portal sign-in, full client
onboarding (client, company, branch, admin, localization, logo), invitations, subscription terms
and their enforcement, branch limits, module read gating, list filters / pagination / summary,
audit, tenant isolation and platform-owner provisioning."""
import datetime
import io
import os
from unittest import mock

from django.contrib.auth import get_user_model
from django.core.management import CommandError, call_command
from django.test import override_settings
from django.utils import timezone
from rest_framework.test import APIClient

from apps.common import tenancy
from apps.common.models import IdempotencyRecord, Tenant, TenantAuditLog
from apps.common.tests_superadmin import PASSWORD, URL, SuperAdminFixture
from apps.company.models import Branch, BusinessSettings, Company

ADMIN_PW = 'Gl4sses-Dubai-77'
LOGO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='


def _full_body(**overrides):
    body = {
        'tenant_name': 'Vision Group LLC', 'owner_name': 'Aisha Rahman', 'admin_email': 'owner@vision.example',
        'contact_phone': '+971501234567', 'country': 'AE', 'address': 'PO Box 1, Dubai',
        'tax_registration_no': '100123456700003', 'logo_data_url': LOGO,
        'company_name': 'Vision Opticals', 'company_registration_no': 'CN-778899',
        'business_address': 'Shop 4, Al Rigga Road, Deira', 'currency': '', 'language': '', 'time_zone': '',
        'tax_enabled': True,
        'branch_name': 'Deira Main', 'branch_address': 'Al Rigga Road', 'branch_phone': '+97142223333',
        'branch_email': 'deira@vision.example',
        'admin_username': 'visionadmin', 'admin_name': 'Aisha Rahman', 'password': ADMIN_PW,
        'package': 'RETAIL', 'max_users': 4, 'max_branches': 2,
        'subscription_plan': 'ANNUAL', 'subscription_starts_on': '2026-11-01',
        'subscription_expires_on': '2027-10-31',
    }
    body.update(overrides)
    return body


class PlatformPortalTests(SuperAdminFixture):
    def test_platform_portal_admits_only_the_platform_owner(self):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': 'platform', 'password': PASSWORD, 'portal': 'platform'},
                          format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.data['user']['is_platform_admin'])
        for username in ('otheradmin', 't1admin'):  # client owners: role SUPER_ADMIN, not platform owners
            res = APIClient().post('/api/auth/login/', {'username': username, 'password': PASSWORD,
                                                        'portal': 'platform'}, format='json')
            self.assertEqual(res.status_code, 403)
            self.assertEqual(res.data['code'], 'not_platform_admin')
            self.assertNotIn('access', res.data)
            # The normal sign-in page still works for them.
            self.assertEqual(APIClient().post('/api/auth/login/', {'username': username, 'password': PASSWORD},
                                              format='json').status_code, 200)

    def test_wrong_password_on_platform_portal_is_plain_invalid_credentials(self):
        res = APIClient().post('/api/auth/login/', {'username': 'otheradmin', 'password': 'wrong-Pass-1',
                                                    'portal': 'platform'}, format='json')
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.data['code'], 'invalid_credentials')

    def test_logout_ends_platform_session(self):
        res = self.api.post('/api/auth/logout/', {}, format='json')
        self.assertIn(res.status_code, (200, 204))
        self.assertEqual(self.api.get(URL).status_code, 401)


class OnboardingTests(SuperAdminFixture):
    def test_full_onboarding_fills_client_company_branch_admin_and_localization(self):
        res = self.api.post(URL, _full_body(), format='json')
        self.assertEqual(res.status_code, 201, res.content)
        tenant = Tenant.objects.get(pk=res.data['id'])
        self.assertTrue(tenant.code)  # generated identifier
        self.assertEqual((tenant.owner_name, tenant.country, tenant.address),
                         ('Aisha Rahman', 'AE', 'PO Box 1, Dubai'))
        self.assertEqual((tenant.subscription_plan, tenant.subscription_expires_on, tenant.max_branches),
                         ('ANNUAL', datetime.date(2027, 10, 31), 2))
        self.assertEqual(res.data['company_name'], 'Vision Opticals')
        self.assertFalse(res.data['invitation_pending'])
        admin = get_user_model().objects.get(username='visionadmin')
        self.assertEqual((admin.first_name, admin.last_name, admin.role, admin.is_superuser),
                         ('Aisha', 'Rahman', 'SUPER_ADMIN', False))
        with tenancy.use_tenant(tenant.pk):
            company = Company.objects.get()
            self.assertEqual((company.name, company.business_reg_no, company.gstin, company.country),
                             ('Vision Opticals', 'CN-778899', '100123456700003', 'United Arab Emirates'))
            from apps.company.localization import CURRENCY_BY_CODE
            self.assertEqual(company.currency, CURRENCY_BY_CODE['AED'][2])
            self.assertEqual(company.fiscal_year_start.month, 1)  # UAE fiscal year starts in January
            prefs = BusinessSettings.load().preferences
            self.assertEqual((prefs['country'], prefs['base_currency'], prefs['time_zone'], prefs['language']),
                             ('AE', 'AED', 'Asia/Dubai', 'en'))
            branch = Branch.get_default()
            self.assertEqual((branch.name, branch.address, branch.phone, branch.email),
                             ('Deira Main', 'Al Rigga Road', '+97142223333', 'deira@vision.example'))
            from apps.billing.models import BillingSettings
            self.assertEqual(BillingSettings.objects.get().logo_data_url, LOGO)
        log = TenantAuditLog.objects.get(tenant=tenant, action='ONBOARDED')
        self.assertEqual(log.actor, 'platform')
        self.assertEqual(log.details['subscription']['subscription_plan'], 'ANNUAL')
        # The new admin signs in to their own business only.
        client = self._login('visionadmin', ADMIN_PW)
        self.assertEqual(client.login_payload['user']['tenant_name'], 'Vision Group LLC')
        self.assertFalse(client.login_payload['user']['is_platform_admin'])

    def test_explicit_localization_overrides_country_defaults(self):
        res = self.api.post(URL, _full_body(currency='USD', language='ar', time_zone='Asia/Riyadh'), format='json')
        self.assertEqual(res.status_code, 201, res.content)
        with tenancy.use_tenant(res.data['id']):
            prefs = BusinessSettings.load().preferences
        self.assertEqual((prefs['base_currency'], prefs['language'], prefs['time_zone']), ('USD', 'ar', 'Asia/Riyadh'))

    def test_validation_errors_are_per_field_and_nothing_is_created(self):
        res = self.api.post(URL, _full_body(country='XX', currency='ZZZ', tax_registration_no='bad reg!!',
                                            logo_data_url='data:text/html;base64,AAAA',
                                            subscription_plan='TRIAL', subscription_expires_on=None),
                            format='json')
        self.assertEqual(res.status_code, 400)
        for field in ('country', 'currency', 'logo_data_url', 'subscription_expires_on'):
            self.assertIn(field, res.data)
        self.assertFalse(Tenant.objects.filter(name='Vision Group LLC').exists())
        self.assertFalse(get_user_model().objects.filter(username='visionadmin').exists())

    def test_perpetual_plan_refuses_an_expiry_and_dates_must_be_ordered(self):
        res = self.api.post(URL, _full_body(subscription_plan='PERPETUAL'), format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('subscription_expires_on', res.data)
        res = self.api.post(URL, _full_body(subscription_starts_on='2027-01-01', subscription_expires_on='2026-12-01'),
                            format='json')
        self.assertEqual(res.status_code, 400)

    def test_password_or_invitation_is_required(self):
        res = self.api.post(URL, _full_body(password=''), format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('password', res.data)


class InvitationTests(SuperAdminFixture):
    def _invite_onboard(self):
        res = self.api.post(URL, _full_body(password='', invite_admin=True), format='json',
                            HTTP_IDEMPOTENCY_KEY='onboard-1')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertTrue(res.data['invitation_pending'])
        self.assertNotIn('token', res.data)
        return res.data

    def test_invited_admin_sets_password_once_and_signs_in(self):
        data = self._invite_onboard()
        tenant_id, user_id = data['id'], data['admin_user_id']
        # No usable password yet: nobody can sign in as the new admin.
        self.assertEqual(APIClient().post('/api/auth/login/', {'username': 'visionadmin', 'password': ''},
                                          format='json').status_code, 400)
        detail = self.api.get(f'{URL}{tenant_id}/').data
        self.assertTrue(next(u for u in detail['users'] if u['username'] == 'visionadmin')['setup_pending'])

        res = self.api.post(f'{URL}{tenant_id}/users/{user_id}/invitation/', {}, format='json',
                            HTTP_IDEMPOTENCY_KEY='invite-1')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res['Cache-Control'], 'no-store')
        # The secret is never kept for idempotent replays.
        self.assertFalse(IdempotencyRecord.objects.filter(key='invite-1').exists())
        link = {'uid': res.data['uid'], 'token': res.data['token']}

        anon = APIClient()
        check = anon.post('/api/auth/invitation/check/', link, format='json')
        self.assertEqual(check.status_code, 200)
        self.assertEqual((check.data['username'], check.data['business']), ('visionadmin', 'Vision Group LLC'))
        weak = anon.post('/api/auth/invitation/accept/', {**link, 'password': '123'}, format='json')
        self.assertEqual(weak.status_code, 400)
        self.assertIn('password', weak.data)
        ok = anon.post('/api/auth/invitation/accept/', {**link, 'password': 'Fresh-Vision-2026'}, format='json')
        self.assertEqual(ok.status_code, 200, ok.content)
        # Single use.
        again = anon.post('/api/auth/invitation/accept/', {**link, 'password': 'Other-Vision-2026'}, format='json')
        self.assertEqual(again.status_code, 400)
        self.assertEqual(again.data['code'], 'invitation_invalid')
        self._login('visionadmin', 'Fresh-Vision-2026')
        actions = set(TenantAuditLog.objects.filter(tenant_id=tenant_id).values_list('action', flat=True))
        self.assertTrue({'ONBOARDED', 'INVITATION_ISSUED', 'INVITATION_ACCEPTED'} <= actions)

    def test_tampered_or_foreign_tokens_are_refused(self):
        data = self._invite_onboard()
        res = self.api.post(f"{URL}{data['id']}/users/{data['admin_user_id']}/invitation/", {}, format='json')
        anon = APIClient()
        for bad in ({'uid': res.data['uid'], 'token': res.data['token'][:-2] + 'xx'},
                    {'uid': 'not-base64', 'token': res.data['token']},
                    {'uid': '', 'token': ''}):
            self.assertEqual(anon.post('/api/auth/invitation/check/', bad, format='json').status_code, 400)
        # A password-reset token for the same user is not an invitation token.
        from django.contrib.auth.tokens import default_token_generator
        user = get_user_model().objects.get(username='visionadmin')
        self.assertEqual(anon.post('/api/auth/invitation/check/',
                                   {'uid': res.data['uid'], 'token': default_token_generator.make_token(user)},
                                   format='json').status_code, 400)

    def test_expired_invitation_is_refused(self):
        data = self._invite_onboard()
        res = self.api.post(f"{URL}{data['id']}/users/{data['admin_user_id']}/invitation/", {}, format='json')
        from apps.common import invitations
        later = invitations.token_generator._now() + datetime.timedelta(hours=invitations.INVITATION_TIMEOUT_HOURS + 1)
        with mock.patch.object(invitations.token_generator, '_now', return_value=later):
            self.assertEqual(APIClient().post('/api/auth/invitation/check/',
                                              {'uid': res.data['uid'], 'token': res.data['token']},
                                              format='json').status_code, 400)

    def test_client_admin_cannot_issue_invitations(self):
        data = self._invite_onboard()
        client = self._login('otheradmin')
        self.assertEqual(client.post(f"{URL}{data['id']}/users/{data['admin_user_id']}/invitation/", {},
                                     format='json').status_code, 403)

    def test_add_user_by_invitation(self):
        data = self._invite_onboard()
        res = self.api.post(f"{URL}{data['id']}/users/", {'username': 'visioncashier', 'role': 'CASHIER',
                                                          'invite': True}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertTrue(res.data['invitation_pending'])
        self.assertFalse(get_user_model().objects.get(username='visioncashier').has_usable_password())


class SubscriptionTests(SuperAdminFixture):
    def setUp(self):
        super().setUp()
        res = self.api.post(URL, _full_body(), format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.tenant = Tenant.objects.get(pk=res.data['id'])

    def test_expired_subscription_blocks_sign_in_and_open_sessions_until_renewed(self):
        client = self._login('visionadmin', ADMIN_PW)
        self.assertEqual(client.get('/api/company/branches/').status_code, 200)
        yesterday = timezone.localdate() - datetime.timedelta(days=1)
        res = self.api.patch(f'{URL}{self.tenant.pk}/', {'subscription_expires_on': yesterday.isoformat(),
                                                         'subscription_starts_on': '2026-01-01'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['status'], 'EXPIRED')
        # Open session: refused on the next request.
        self.assertIn(client.get('/api/company/branches/').status_code, (401, 403))
        # New sign-in: a clear "subscription ended" message.
        res = APIClient().post('/api/auth/login/', {'username': 'visionadmin', 'password': ADMIN_PW}, format='json')
        self.assertEqual(res.status_code, 401)
        self.assertEqual(res.data['code'], 'subscription_expired')
        # Expiry day itself is still usable; renewing restores access.
        res = self.api.patch(f'{URL}{self.tenant.pk}/', {'subscription_expires_on': timezone.localdate().isoformat()},
                             format='json')
        self.assertEqual(res.data['status'], 'ACTIVE')
        self._login('visionadmin', ADMIN_PW)
        audit = TenantAuditLog.objects.filter(tenant=self.tenant, action='SUBSCRIPTION_CHANGED')
        self.assertEqual(audit.count(), 2)
        self.assertEqual(audit.first().details['changes']['subscription_expires_on']['to'],
                         timezone.localdate().isoformat())

    def test_trial_status_and_switch_to_perpetual_clears_expiry(self):
        res = self.api.patch(f'{URL}{self.tenant.pk}/', {'subscription_plan': 'TRIAL'}, format='json')
        self.assertEqual(res.data['status'], 'TRIAL')
        res = self.api.patch(f'{URL}{self.tenant.pk}/', {'subscription_plan': 'PERPETUAL'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIsNone(res.data['subscription_expires_on'])

    def test_platform_account_has_no_subscription_terms(self):
        res = self.api.patch(f'{URL}{tenancy.DEFAULT_TENANT_ID}/', {'subscription_plan': 'TRIAL',
                                                                     'subscription_expires_on': '2030-01-01'},
                             format='json')
        self.assertEqual(res.status_code, 400)

    def test_module_and_subscription_changes_are_audited_separately(self):
        res = self.api.patch(f'{URL}{self.tenant.pk}/', {'package': 'OPERATIONS', 'max_branches': 3,
                                                         'owner_name': 'A. Rahman'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        actions = list(TenantAuditLog.objects.filter(tenant=self.tenant).exclude(action='ONBOARDED')
                       .values_list('action', flat=True))
        self.assertCountEqual(actions, ['MODULES_CHANGED', 'SUBSCRIPTION_CHANGED', 'PROFILE_UPDATED'])

    def test_branch_limit_applies_to_console_and_client(self):
        add = self.api.post(f'{URL}{self.tenant.pk}/branches/', {'name': 'Karama', 'code': 'KRM'}, format='json')
        self.assertEqual(add.status_code, 201, add.content)
        over = self.api.post(f'{URL}{self.tenant.pk}/branches/', {'name': 'Bur Dubai', 'code': 'BUR'}, format='json')
        self.assertEqual(over.status_code, 400)
        self.assertIn('max_branches', over.data)
        client = self._login('visionadmin', ADMIN_PW)
        res = client.post('/api/company/branches/', {'name': 'Satwa', 'code': 'STW'}, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['code'], 'branch_limit')
        # Lowering the limit below what is in use is refused; raising it lets the client add one.
        self.assertEqual(self.api.patch(f'{URL}{self.tenant.pk}/', {'max_branches': 1}, format='json').status_code, 400)
        self.assertEqual(self.api.patch(f'{URL}{self.tenant.pk}/', {'max_branches': 3}, format='json').status_code, 200)
        self.assertEqual(client.post('/api/company/branches/', {'name': 'Satwa', 'code': 'STW'},
                                     format='json').status_code, 201)


class ModuleReadGateTests(SuperAdminFixture):
    """A module switched off for a client can't be read through a direct API call either."""

    def _client_with(self, username, package, modules=()):
        res = self.api.post(URL, _full_body(tenant_name=f'{username} shop', admin_username=username,
                                            package=package, modules=list(modules), max_branches=None,
                                            subscription_plan='PERPETUAL', subscription_expires_on=None),
                            format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return self._login(username, ADMIN_PW)

    def test_disabled_modules_refuse_reads(self):
        client = self._client_with('nowhole', 'CUSTOM',
                                   ['sales', 'optical', 'inventory', 'admin', 'reports', 'settings'])
        for path in ('/api/sales/wholesale/invoices/', '/api/sales/wholesale/dealers/', '/api/purchase/invoices/',
                     '/api/purchase/orders/'):
            res = client.get(path)
            self.assertEqual(res.status_code, 403, path)
            self.assertEqual(res.data['code'], 'module_disabled')
        # Read by a module this client has: still open.
        for path in ('/api/sales/appointments/', '/api/sales/eye-examinations/', '/api/purchase/suppliers/',
                     '/api/purchase/lens-orders/', '/api/products/items/', '/api/sales/invoices/'):
            self.assertEqual(client.get(path).status_code, 200, path)

    def test_accounts_only_client(self):
        client = self._client_with('booksonly', 'ACCOUNTS_ONLY')
        for path in ('/api/sales/appointments/', '/api/purchase/lens-orders/'):
            self.assertEqual(client.get(path).status_code, 403, path)
        # The books read other modules' bills and parties (vouchers, settlements, show bill).
        for path in ('/api/purchase/invoices/', '/api/purchase/suppliers/', '/api/sales/wholesale/dealers/'):
            self.assertEqual(client.get(path).status_code, 200, path)

    def test_disabled_module_refuses_writes(self):
        client = self._client_with('noopt', 'CUSTOM', ['sales', 'inventory', 'admin', 'reports', 'settings'])
        res = client.post('/api/sales/appointments/', {}, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['code'], 'module_disabled')


class ClientListTests(SuperAdminFixture):
    def setUp(self):
        super().setUp()
        today = timezone.localdate()
        bodies = [
            _full_body(tenant_name='Alpha Optics', admin_username='alpha', country='IN', currency='INR',
                       tax_registration_no='', subscription_plan='TRIAL',
                       subscription_starts_on=today.isoformat(),
                       subscription_expires_on=(today + datetime.timedelta(days=10)).isoformat()),
            _full_body(tenant_name='Beta Vision', admin_username='beta'),
            _full_body(tenant_name='Gamma Eyecare', admin_username='gamma', subscription_plan='PERPETUAL',
                       subscription_expires_on=None),
        ]
        for body in bodies:
            self.assertEqual(self.api.post(URL, body, format='json').status_code, 201)

    def test_search_filters_and_pagination(self):
        names = lambda res: [r['name'] for r in (res.data['results'] if isinstance(res.data, dict) else res.data)]  # noqa: E731
        self.assertEqual(names(self.api.get(URL, {'search': 'beta'})), ['Beta Vision'])
        self.assertEqual(names(self.api.get(URL, {'search': 'gamma'})), ['Gamma Eyecare'])  # admin username
        self.assertEqual(names(self.api.get(URL, {'status': 'TRIAL'})), ['Alpha Optics'])
        self.assertEqual(names(self.api.get(URL, {'plan': 'PERPETUAL', 'search': 'a'}))[-1], 'Gamma Eyecare')
        self.assertEqual(names(self.api.get(URL, {'country': 'IN'})), ['Alpha Optics'])
        self.assertEqual(names(self.api.get(URL, {'expiring': '1'})), ['Alpha Optics'])
        page = self.api.get(URL, {'page': 1, 'page_size': 2})
        self.assertEqual((page.data['count'], len(page.data['results'])), (Tenant.objects.count(), 2))
        page2 = self.api.get(URL, {'page': 2, 'page_size': 2})
        self.assertEqual(len(page2.data['results']), min(2, Tenant.objects.count() - 2))
        all_ids = [r['id'] for p in (1, 2, 3) for r in self.api.get(URL, {'page': p, 'page_size': 2}).data['results']]
        self.assertEqual(sorted(all_ids), sorted(Tenant.objects.values_list('pk', flat=True)))
        row = next(r for r in self.api.get(URL).data if r['name'] == 'Beta Vision')
        for key in ('id', 'code', 'company_name', 'country', 'subscription_plan', 'modules', 'active_user_count',
                    'branch_count', 'status', 'subscription_expires_on'):
            self.assertIn(key, row)

    def test_summary(self):
        res = self.api.get(f'{URL}summary/')
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.data['clients'], Tenant.objects.count() - 1)
        self.assertEqual([r['name'] for r in res.data['expiring_soon']], ['Alpha Optics'])
        self.assertEqual(self._login('otheradmin').get(f'{URL}summary/').status_code, 403)

    def test_suspend_and_reactivate_from_the_console(self):
        tenant = Tenant.objects.get(name='Beta Vision')
        client = self._login('beta', ADMIN_PW)
        res = self.api.post(f'{URL}{tenant.pk}/deactivate/', {'category': 'NON_PAYMENT',
                                                              'reason': 'Invoice overdue 60 days'}, format='json')
        self.assertEqual(res.data['status'], 'INACTIVE')
        self.assertIn(client.get('/api/company/branches/').status_code, (401, 403))
        self.assertEqual(APIClient().post('/api/auth/login/', {'username': 'beta', 'password': ADMIN_PW},
                                          format='json').data['code'], 'tenant_inactive')
        res = self.api.post(f'{URL}{tenant.pk}/reactivate/', {'reason': 'Paid'}, format='json')
        self.assertEqual(res.data['status'], 'ACTIVE')
        self._login('beta', ADMIN_PW)


class IsolationTests(SuperAdminFixture):
    def test_client_supplied_tenant_ids_are_ignored(self):
        res = self.api.post(URL, _full_body(), format='json')
        tenant_a = Tenant.objects.get(pk=res.data['id'])
        client = self._login('visionadmin', ADMIN_PW)
        # Body field and header naming another tenant: the row still lands in the caller's tenant.
        res = client.post('/api/sales/customers/', {'name': 'Spoof Patient', 'phone': '0500000001',
                                                     'tenant': self.other.pk, 'tenant_id': self.other.pk},
                          format='json', HTTP_X_TENANT_ID=str(self.other.pk))
        self.assertEqual(res.status_code, 201, res.content)
        from apps.sales.models import Customer
        with tenancy.unscoped():
            self.assertEqual(Customer.objects.get(name='Spoof Patient').tenant_id, tenant_a.pk)
        # Another client's admin sees none of it.
        other = self._login('otheradmin')
        rows = other.get('/api/sales/customers/', {'search': 'Spoof'}).data
        rows = rows['results'] if isinstance(rows, dict) else rows
        self.assertEqual(rows, [])

    def test_client_admin_cannot_reach_platform_endpoints(self):
        res = self.api.post(URL, _full_body(), format='json')
        client = self._login('visionadmin', ADMIN_PW)
        for method, path in (('get', URL), ('get', f'{URL}summary/'), ('get', f'{URL}{self.other.pk}/'),
                             ('patch', f'{URL}{self.other.pk}/'), ('post', f"{URL}{res.data['id']}/workspace/"),
                             ('get', f"{URL}{self.other.pk}/data/")):
            self.assertEqual(getattr(client, method)(path, {}, format='json').status_code, 403, path)

    def test_workspace_access_is_audited(self):
        res = self.api.post(URL, _full_body(), format='json')
        ws = self.api.post(f"{URL}{res.data['id']}/workspace/", {}, format='json')
        self.assertEqual(ws.status_code, 200, ws.content)
        self.assertTrue(TenantAuditLog.objects.filter(tenant_id=res.data['id'], action='WORKSPACE_OPENED',
                                                      actor='platform').exists())


class PlatformOwnerProvisioningTests(SuperAdminFixture):
    def _run(self, *args, env=None):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env or {}, clear=False):
            for key in ('DJANGO_SUPERUSER_USERNAME', 'DJANGO_SUPERUSER_PASSWORD'):
                if env is None or key not in env:
                    os.environ.pop(key, None)
            call_command('bootstrap_admin', *args, stdout=out, stderr=err)
        return out.getvalue(), err.getvalue()

    @override_settings(DEBUG=True)
    def test_no_built_in_default_account(self):
        before = get_user_model().objects.count()
        out, _ = self._run()
        self.assertIn('not set', out)
        self.assertEqual(get_user_model().objects.count(), before)
        self.assertFalse(get_user_model().objects.filter(username='superadmin').exists())

    def test_never_promotes_another_tenants_user(self):
        _, err = self._run('--reset-password', env={'DJANGO_SUPERUSER_USERNAME': 'OtherAdmin',
                                                    'DJANGO_SUPERUSER_PASSWORD': 'Plat-form-Owner-9'})
        self.assertIn('belongs to client', err)
        self.assertFalse(get_user_model().objects.get(username='otheradmin').is_superuser)

    def test_reports_and_repairs_a_platform_tenant_account_without_rights(self):
        _, err = self._run(env={'DJANGO_SUPERUSER_USERNAME': 't1admin', 'DJANGO_SUPERUSER_PASSWORD': 'Plat-form-Owner-9'})
        self.assertIn('not a superuser', err)
        self._run('--reset-password', env={'DJANGO_SUPERUSER_USERNAME': 't1admin',
                                           'DJANGO_SUPERUSER_PASSWORD': 'Plat-form-Owner-9'})
        client = self._login('t1admin', 'Plat-form-Owner-9')
        self.assertTrue(client.login_payload['user']['is_platform_admin'])
        self.assertEqual(client.get(URL).status_code, 200)

    def test_weak_password_creates_nothing(self):
        _, err = self._run(env={'DJANGO_SUPERUSER_USERNAME': 'newowner', 'DJANGO_SUPERUSER_PASSWORD': '123'})
        self.assertIn('too weak', err)
        self.assertFalse(get_user_model().objects.filter(username='newowner').exists())

    def test_status_command(self):
        out = io.StringIO()
        call_command('platform_admin_status', stdout=out)
        self.assertIn('platform', out.getvalue())
        self.assertIn('OK', out.getvalue())
        get_user_model().objects.filter(username='platform').update(is_active=False)
        with self.assertRaises(CommandError):
            call_command('platform_admin_status', stdout=io.StringIO())


class RoleReadGateTests(SuperAdminFixture):
    """A role at level 'none' on every module that reads an endpoint can't read it through the
    API either (2026-11-13 readiness audit). 'view' still reads; shared dependencies stay open."""

    def setUp(self):
        super().setUp()
        res = self.api.post(URL, _full_body(max_users=10), format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.tenant_id = res.data['id']
        for username, role in (('vcashier', 'CASHIER'), ('vdoctor', 'DOCTOR'), ('vaccountant', 'ACCOUNTANT'),
                               ('voptom', 'OPTOMETRIST')):
            add = self.api.post(f'{URL}{self.tenant_id}/users/', {'username': username, 'password': ADMIN_PW,
                                                                  'role': role, 'access_all_branches': True},
                                format='json')
            self.assertEqual(add.status_code, 201, add.content)

    def _get(self, client, path):
        return client.get(path).status_code

    def test_cashier_cannot_pull_ledger_purchase_costs_or_appointments(self):
        cashier = self._login('vcashier', ADMIN_PW)
        for path in ('/api/financial/accounts/', '/api/financial/journals/', '/api/financial/reports/trial-balance/',
                     '/api/purchase/invoices/', '/api/purchase/orders/', '/api/sales/wholesale/invoices/',
                     '/api/sales/appointments/'):
            # 403 from the module gate (module_forbidden / module_disabled) or, first, from the
            # view's own finance-role permission — either way nothing is returned.
            res = cashier.get(path)
            self.assertEqual(res.status_code, 403, path)
            self.assertNotIn('results', res.data, path)
        # Everything the till's own screens read stays open.
        for path in ('/api/sales/invoices/', '/api/sales/customers/', '/api/sales/payments/', '/api/sales/eye-examinations/',
                     '/api/sales/services/', '/api/purchase/suppliers/', '/api/purchase/lens-orders/',
                     '/api/products/items/', '/api/financial/bank-accounts/', '/api/sales/dashboard-summary/'):
            self.assertEqual(self._get(cashier, path), 200, path)

    def test_doctor_reads_clinical_data_only(self):
        doctor = self._login('vdoctor', ADMIN_PW)
        for path in ('/api/sales/appointments/', '/api/sales/eye-examinations/', '/api/sales/customers/',
                     '/api/sales/invoices/'):  # patient history shows the patient's bills
            self.assertEqual(self._get(doctor, path), 200, path)
        for path in ('/api/purchase/suppliers/', '/api/financial/journals/', '/api/sales/services/'):
            self.assertEqual(self._get(doctor, path), 403, path)

    def test_accountant_reads_the_books_and_bills(self):
        accountant = self._login('vaccountant', ADMIN_PW)
        # RETAIL = the Accounts tier; Financial-only screens (trial balance) are refused by plan.
        self.assertEqual(self._get(accountant, '/api/financial/reports/trial-balance/'), 403)
        for path in ('/api/financial/journals/', '/api/financial/reports/vouchers/', '/api/purchase/invoices/',
                     '/api/sales/wholesale/dealers/', '/api/sales/invoices/', '/api/sales/customers/'):
            # Not refused (a report may still answer 400 for missing date parameters).
            self.assertNotEqual(self._get(accountant, path), 403, path)

    def test_view_level_reads_and_custom_none_is_enforced(self):
        optom = self._login('voptom', ADMIN_PW)
        self.assertEqual(self._get(optom, '/api/sales/invoices/'), 200)  # sales: view
        # The platform switches OPTOMETRIST to 'none' on every module that shows sales bills.
        res = self.api.patch(f'{URL}{self.tenant_id}/', {'role_permissions': {'OPTOMETRIST': {
            'sales': 'none', 'optical': 'none', 'reports': 'none'}}}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        from apps.common import hot_cache
        hot_cache.clear()
        res = optom.get('/api/sales/invoices/')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['code'], 'module_forbidden')

    def test_platform_owner_in_workspace_follows_the_client_plan_not_roles(self):
        ws = self.api.post(f'{URL}{self.tenant_id}/workspace/', {}, format='json')
        self.assertEqual(ws.status_code, 200, ws.content)
        client = APIClient()
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {ws.data['access']}")
        # RETAIL package has the Accounts tier, not Financial: the owner gets the client's view.
        self.assertEqual(client.get('/api/sales/invoices/').status_code, 200)
        self.assertEqual(client.get('/api/purchase/invoices/').status_code, 200)
