"""Windows local edition: Local Super Admin bootstrap + login, Client Management, licence-bounded
clients, installation-admin rules, tenant isolation and offline operation.

Runs only under config.settings_local (windows/tests/run_local_django_tests.py starts a disposable
PostgreSQL 17 cluster), like apps.licensing.tests.
"""

import io
import json
import socket
import sys
import unittest
from unittest import mock

from django.conf import settings

if 'apps.licensing' not in settings.INSTALLED_APPS:  # cloud settings: nothing to test here
    raise unittest.SkipTest('local edition only')

from django.contrib.auth import get_user_model  # noqa: E402
from django.core.cache import cache  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.core.management.base import CommandError  # noqa: E402
from django.test import TestCase  # noqa: E402
from rest_framework.test import APIClient  # noqa: E402

from apps.common import tenancy  # noqa: E402
from apps.common.models import Organization, Tenant, TenantAuditLog  # noqa: E402
from apps.licensing.tests import LicensingBase, make_license  # noqa: E402

URL = '/api/superadmin/tenants/'
SA_PW = 'Local-Owner-Strong-26'
CLIENT_PW = 'Client-Admin-Strong-26'


def run_superadmin(payload=None, *args):
    """local_superadmin with JSON on stdin; returns (parsed last JSON line, CommandError or None)."""
    out, old = io.StringIO(), sys.stdin
    sys.stdin = io.StringIO(json.dumps(payload) if payload is not None else '')
    err = None
    try:
        call_command('local_superadmin', *args, stdout=out)
    except CommandError as exc:
        err = exc
    finally:
        sys.stdin = old
    lines = [line for line in out.getvalue().strip().splitlines() if line.strip().startswith('{')]
    return (json.loads(lines[-1]) if lines else {}), err


class _NoNetwork:
    """Any outbound connection attempt fails the test: the local edition must work offline."""

    def __enter__(self):
        def refuse(*a, **k):
            raise AssertionError(f'unexpected network access: {a[:1]}')
        self._patches = [mock.patch.object(socket, 'create_connection', refuse),
                         mock.patch.object(socket.socket, 'connect', refuse)]
        for p in self._patches:
            p.start()
        return self

    def __exit__(self, *exc):
        for p in self._patches:
            p.stop()


class LocalSuperAdminBootstrapTests(TestCase):
    def test_create_hashes_password_audits_and_is_idempotent(self):
        from apps.security.models import SecurityAuditLog
        res, err = run_superadmin({'username': 'localsa', 'password': SA_PW, 'full_name': 'Asha Rao'})
        self.assertIsNone(err, res)
        self.assertTrue(res['created'])
        user = get_user_model().objects.get(username='localsa')
        self.assertTrue(user.is_superuser)
        self.assertEqual(user.tenant_id, tenancy.DEFAULT_TENANT_ID)
        self.assertNotEqual(user.password, SA_PW)
        from django.contrib.auth.hashers import get_hasher, identify_hasher
        self.assertEqual(identify_hasher(user.password).algorithm, get_hasher().algorithm)  # configured hasher
        self.assertTrue(user.check_password(SA_PW))
        self.assertTrue(SecurityAuditLog.objects.filter(event='LOCAL_SUPER_ADMIN_CREATED').exists())
        # Re-running is a no-op, never a duplicate.
        res, err = run_superadmin({'username': 'localsa', 'password': SA_PW})
        self.assertIsNone(err)
        self.assertFalse(res['created'])
        res, err = run_superadmin({'username': 'second-sa', 'password': SA_PW})
        self.assertIsNotNone(err)
        self.assertIn('already has a Local Super Admin', res['errors']['username'])
        self.assertEqual(get_user_model().objects.filter(is_superuser=True).count(), 1)

    def test_weak_password_and_taken_username_refused(self):
        res, err = run_superadmin({'username': 'localsa', 'password': '123'})
        self.assertIsNotNone(err)
        self.assertIn('password', res['errors'])
        get_user_model().objects.create_user('shopowner', password=SA_PW, role='SUPER_ADMIN',
                                             tenant_id=tenancy.DEFAULT_TENANT_ID)
        res, err = run_superadmin({'username': 'ShopOwner', 'password': SA_PW})
        self.assertIsNotNone(err)
        self.assertFalse(get_user_model().objects.get(username='shopowner').is_superuser)  # never promoted
        self.assertFalse(get_user_model().objects.filter(is_superuser=True).exists())

    def test_status_and_reset_password(self):
        res, _ = run_superadmin(None, '--status')
        self.assertFalse(res['exists'])
        run_superadmin({'username': 'localsa', 'password': SA_PW})
        res, _ = run_superadmin(None, '--status')
        self.assertEqual([a['username'] for a in res['super_admins']], ['localsa'])
        self.assertNotIn('password', json.dumps(res).lower().replace('usable_password', ''))
        res, err = run_superadmin({'username': 'localsa', 'password': 'New-Local-Owner-77'}, '--reset-password')
        self.assertIsNone(err, res)
        self.assertTrue(get_user_model().objects.get(username='localsa').check_password('New-Local-Owner-77'))
        res, err = run_superadmin({'username': 'nobody', 'password': 'New-Local-Owner-77'}, '--reset-password')
        self.assertIsNotNone(err)

    def test_company_setup_still_possible_after_super_admin(self):
        """The installer's create-org runs on a database whose only user is the Local Super Admin."""
        run_superadmin({'username': 'localsa', 'password': SA_PW})
        payload = json.dumps({'company_name': 'Sunrise Opticals', 'branch_name': 'MG Road', 'admin_username': 'owner',
                              'admin_password': 'Sunrise-Strong-Pass-26', 'admin_full_name': 'Asha Rao'})
        old, sys.stdin = sys.stdin, io.StringIO(payload)
        try:
            call_command('local_create_admin', stdout=io.StringIO())
        finally:
            sys.stdin = old
        owner = get_user_model().objects.get(username='owner')
        self.assertEqual((owner.role, owner.is_superuser), ('SUPER_ADMIN', False))

    def test_status_command_reports_local_owner(self):
        with self.assertRaises(CommandError):
            call_command('platform_admin_status', stdout=io.StringIO())
        run_superadmin({'username': 'localsa', 'password': SA_PW})
        out = io.StringIO()
        call_command('platform_admin_status', stdout=out)
        self.assertIn('localsa', out.getvalue())


class LocalClientManagementTests(LicensingBase):
    """LicensingBase: tenant #1 with 'owner' (SUPER_ADMIN) + 'cashier', dev licence keys."""

    def setUp(self):
        super().setUp()
        cache.clear()
        self.addCleanup(cache.clear)
        from apps.common.organizations import ensure_organization
        ensure_organization(self.tenant)  # the installation owner's organization
        run_superadmin({'username': 'localsa', 'password': SA_PW})
        self.sa = self._login('localsa', SA_PW, portal='platform')

    def _login(self, username, password, portal=None):
        client = APIClient()
        body = {'username': username, 'password': password}
        if portal:
            body['portal'] = portal
        res = client.post('/api/auth/login/', body, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.post('/api/security/reauth/', {'password': password}, format='json')
        client.login_payload = res.data
        return client

    def _onboard(self, name='Lakeview Optics', username='lakeadmin', **extra):
        body = {'tenant_name': name, 'admin_username': username, 'password': CLIENT_PW, 'branch_name': 'Main',
                'max_users': 3, **extra}
        return self.sa.post(URL, body, format='json')

    def test_local_super_admin_portal_login_offline(self):
        with _NoNetwork():
            res = APIClient().post('/api/auth/login/', {'username': 'localsa', 'password': SA_PW, 'portal': 'platform'},
                                   format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertTrue(res.data['user']['is_platform_admin'])
        # The customer's own company owner is not the Local Super Admin.
        res = APIClient().post('/api/auth/login/', {'username': 'owner', 'password': 'x-Very-Long-Pass-1',
                                                    'portal': 'platform'}, format='json')
        self.assertEqual(res.status_code, 403)
        self.assertEqual(res.data['code'], 'not_platform_admin')

    def test_create_edit_suspend_reactivate_client_offline(self):
        with _NoNetwork():
            res = self._onboard()
            self.assertEqual(res.status_code, 201, res.content)
            client_id = res.data['id']
            tenant = Tenant.objects.get(pk=client_id)
            self.assertIsNotNone(tenant.organization_id)
            self.assertNotEqual(tenant.organization_id, self.tenant.organization_id)  # its own organization
            listing = self.sa.get(URL, {'search': 'Lakeview'})
            self.assertEqual(listing.status_code, 200)
            summary = self.sa.get(f'{URL}summary/').json()
            self.assertEqual(summary['edition'], 'local')
            self.assertEqual(summary['license']['clients_used'], 1)
            # edit
            res = self.sa.patch(f'{URL}{client_id}/', {'owner_name': 'Ravi K', 'max_users': 4}, format='json')
            self.assertEqual(res.status_code, 200, res.content)
            tenant.refresh_from_db()
            self.assertEqual((tenant.owner_name, tenant.max_users), ('Ravi K', 4))
            # client admin signs in to its own company
            self._login('lakeadmin', CLIENT_PW)
            # suspend → the client cannot sign in
            res = self.sa.post(f'{URL}{client_id}/deactivate/', {'category': 'NON_PAYMENT', 'reason': 'Unpaid invoice'},
                               format='json')
            self.assertEqual(res.status_code, 200, res.content)
            res = APIClient().post('/api/auth/login/', {'username': 'lakeadmin', 'password': CLIENT_PW}, format='json')
            self.assertNotEqual(res.status_code, 200)
            # reactivate → works again
            res = self.sa.post(f'{URL}{client_id}/reactivate/', {'reason': 'Paid'}, format='json')
            self.assertEqual(res.status_code, 200, res.content)
            self._login('lakeadmin', CLIENT_PW)
            actions = set(TenantAuditLog.objects.filter(tenant_id=client_id).values_list('action', flat=True))
            self.assertTrue({'DEACTIVATED', 'REACTIVATED'} <= actions, actions)

    def test_client_users_and_branches(self):
        client_id = self._onboard().data['id']
        res = self.sa.post(f'{URL}{client_id}/users/', {'username': 'lakecash', 'password': CLIENT_PW,
                                                        'role': 'CASHIER'}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.assertEqual(get_user_model().objects.get(username='lakecash').tenant_id, client_id)
        # The evaluation licence allows one branch per company: the console enforces it too.
        res = self.sa.post(f'{URL}{client_id}/branches/', {'name': 'Second', 'code': 'B2'}, format='json')
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn('licence', json.dumps(res.json()).lower())
        self.install(make_license(limits={'users': 9, 'companies': 1, 'branches_per_company': 3, 'branches_total': 9}))
        res = self.sa.post(f'{URL}{client_id}/branches/', {'name': 'Second', 'code': 'B2'}, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)

    def test_clients_bounded_by_licence(self):
        self.install(make_license(limits={'users': 9, 'companies': 1, 'clients': 1}))
        self.assertEqual(self._onboard().status_code, 201)
        res = self._onboard(name='Second Client', username='second')
        self.assertEqual(res.status_code, 400, res.content)
        self.assertIn('licence', json.dumps(res.json()).lower())
        self.assertFalse(Tenant.objects.filter(name='Second Client').exists())
        self.assertEqual(Organization.objects.count(), 2)

    def test_super_admin_takes_no_licence_seat(self):
        from apps.common.tenant_onboarding import check_seat_available
        self.install(make_license(limits={'users': 3, 'companies': 1}))
        self.tenant.max_users = 3
        self.tenant.save(update_fields=['max_users'])
        check_seat_available(self.tenant)  # owner + cashier (+ Local Super Admin not counted) → 1 left

    def test_stray_organization_still_refused(self):
        from apps.common.edition import LocalEditionGuardError
        with self.assertRaises(LocalEditionGuardError):
            Organization.objects.create(name='Sneaky', code='sneaky')

    def test_only_platform_owner_reaches_client_management(self):
        client_id = self._onboard().data['id']
        for username, pw in (('owner', 'x-Very-Long-Pass-1'), ('lakeadmin', CLIENT_PW)):
            api = self._login(username, pw)
            self.assertFalse(api.login_payload['user']['is_platform_admin'])
            self.assertEqual(api.get(URL).status_code, 403)
            self.assertEqual(api.post(URL, {}, format='json').status_code, 403)
            self.assertEqual(api.post(f'{URL}{client_id}/deactivate/', {'category': 'OTHER', 'reason': 'x'},
                                      format='json').status_code, 403)

    def test_client_admin_cannot_touch_installation_licence_or_backups(self):
        self._onboard()
        client = self._login('lakeadmin', CLIENT_PW)
        self.assertEqual(client.post('/api/licensing/import/', {'license': 'x'}, format='json').status_code, 403)
        self.assertEqual(client.get('/api/local/backups/').status_code, 403)
        status = client.get('/api/licensing/status/').json()
        self.assertFalse(status['can_manage'])
        self.assertNotIn('usage', status)
        owner = self._login('owner', 'x-Very-Long-Pass-1')
        self.assertTrue(owner.get('/api/licensing/status/').json()['can_manage'])
        self.assertTrue(self.sa.get('/api/licensing/status/').json()['can_manage'])

    def test_tenant_isolation_between_installation_and_client(self):
        self._onboard()
        owner = self._login('owner', 'x-Very-Long-Pass-1')
        client = self._login('lakeadmin', CLIENT_PW)
        res = owner.post('/api/masters/brands/', {'name': 'OwnerOnlyBrand', 'code': 'OWN1'}, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)
        brand_id = res.json()['id']
        listing = json.dumps(client.get('/api/masters/brands/').json())
        self.assertNotIn('OwnerOnlyBrand', listing)
        self.assertEqual(client.get(f'/api/masters/brands/{brand_id}/').status_code, 404)
        self.assertIn(client.patch(f'/api/masters/brands/{brand_id}/', {'name': 'hijack'}, format='json').status_code,
                      (403, 404))
        self.assertIn(client.delete(f'/api/masters/brands/{brand_id}/').status_code, (403, 404))
        res = client.post('/api/masters/brands/', {'name': 'ClientBrand', 'code': 'CLI1'}, format='json')
        self.assertIn(res.status_code, (200, 201), res.content)
        from apps.masters.models import Brand
        with tenancy.unscoped():
            self.assertEqual(Brand.objects.get(name='ClientBrand').tenant_id,
                             Tenant.objects.get(name='Lakeview Optics').pk)
            self.assertEqual(Brand.objects.get(name='OwnerOnlyBrand').tenant_id, self.tenant.pk)

    def test_django_admin_is_off(self):
        self.assertEqual(APIClient().get('/admin/').status_code, 404)
