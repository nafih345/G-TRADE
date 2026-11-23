"""Vendor licence authority (cloud console): plans, client licences, signed keys, renewal, plan
changes, suspension / revocation, replacement keys, online activation, isolation and permissions.

Runs under config.settings (cloud). The signing key is a throwaway development key made here; the
customer-side verification of these exact tokens is covered by apps/licensing/tests_vendor_keys.py
(Windows settings) and windows/tests/test_licence_activation_e2e.py (real servers)."""

import base64
import datetime as dt
import io
import json
import os
import tempfile
import unittest
from pathlib import Path

from django.apps import apps as django_apps
from django.conf import settings

# Cloud console tests (workspaces, public authority endpoints). The Windows owner installation's
# offline issuing is covered by apps/licensing/tests_local_vendor_workflow.py.
if not django_apps.is_installed('apps.vendor_licensing') or getattr(settings, 'GTRADE_EDITION', '') == 'local':
    raise unittest.SkipTest('cloud licence authority tests (config.settings)')

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.core.cache import cache  # noqa: E402
from django.core.management import CommandError, call_command  # noqa: E402
from django.test import TestCase, override_settings  # noqa: E402
from django.utils import timezone  # noqa: E402
from rest_framework.test import APIClient  # noqa: E402

from apps.common import tenancy  # noqa: E402
from apps.common.models import Tenant, TenantAuditLog  # noqa: E402
from apps.licensing import licfmt  # noqa: E402
from apps.vendor_licensing import service, signing, tokens  # noqa: E402
from apps.vendor_licensing.models import ClientLicense, LicenseAuditEvent, LicensedClient, LicensePlan  # noqa: E402

PASSWORD = 'Plat-Form-Pass-2026!'
BASE = '/api/superadmin/licensing/'
AUTH = '/api/licence-authority/v1/'
_KEY = Ed25519PrivateKey.generate()
_PEM = _KEY.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                          serialization.NoEncryption()).decode('ascii')
_PUB = base64.b64encode(_KEY.public_key().public_bytes(serialization.Encoding.Raw,
                                                       serialization.PublicFormat.Raw)).decode('ascii')
KEY_SETTINGS = dict(GTRADE_LICENSE_SIGNING_KEY_ID='gtl-dev-vendortest', GTRADE_LICENSE_SIGNING_KEY=_PEM,
                    GTRADE_LICENSE_SIGNING_KEY_FILE='', GTRADE_LICENSE_VERIFY_KEYS='')
FP = {'machine_guid': 'sha256:aa', 'volume': 'sha256:bb', 'bios_uuid': 'sha256:cc', 'cpu': 'sha256:dd', 'mac': 'sha256:ee'}
INSTALL_A = '5b0c1f7e-aaaa-4222-8333-444455556666'
INSTALL_B = '5b0c1f7e-bbbb-4222-8333-444455556666'
ALL_MODULES = ['optical', 'sales', 'inventory', 'purchase', 'accounts', 'admin', 'reports', 'settings']


def decode(token):
    return licfmt.verify(token, licfmt.LICENSE_PREFIX, {'gtl-dev-vendortest': _PUB})


@override_settings(**KEY_SETTINGS)
class Fixture(TestCase):
    def setUp(self):
        cache.clear()
        self.addCleanup(cache.clear)
        signing.reset_cache()
        self.addCleanup(signing.reset_cache)
        User = get_user_model()
        self.t1 = Tenant.objects.get(pk=tenancy.DEFAULT_TENANT_ID)
        User.objects.create_superuser('platform', password=PASSWORD, tenant=self.t1)
        self.shop = Tenant.objects.create(name='Other Shop', code='other-shop')
        User.objects.create_user('shopowner', password=PASSWORD, role='SUPER_ADMIN', tenant=self.shop)
        User.objects.create_user('t1admin', password=PASSWORD, role='SUPER_ADMIN', tenant=self.t1)
        self.api = self.login('platform')

    def login(self, username):
        client = APIClient()
        res = client.post('/api/auth/login/', {'username': username, 'password': PASSWORD}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        client.credentials(HTTP_AUTHORIZATION=f"Bearer {res.data['access']}")
        client.post('/api/security/reauth/', {'password': PASSWORD}, format='json')
        return client

    def plan(self, **kw):
        body = {'name': 'Windows Pro Yearly', 'edition': 'WINDOWS_LOCAL', 'billing_cycle': 'YEARLY', 'duration': 1,
                'price': '12000.00', 'currency': 'INR', 'max_clients': 0, 'max_companies': 2, 'max_branches': 3,
                'max_users': 5, 'modules': ALL_MODULES, 'settings_features': None}
        body.update(kw)
        res = self.api.post(f'{BASE}plans/', body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data

    def windows_licence(self, plan=None, installation='', starts_on=None, name='Sunrise Opticals'):
        plan = plan or self.plan()
        body = {'plan_id': plan['id'], 'client': {'name': name, 'owner_name': 'Ravi', 'email': 'ravi@sunrise.example'},
                'installation': installation}
        if starts_on:
            body['starts_on'] = starts_on
        res = self.api.post(f'{BASE}licences/', body, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        return res.data


class PlanTests(Fixture):
    def test_monthly_yearly_lifetime_plans_and_explicit_unlimited(self):
        m = self.plan(name='Cloud Monthly', edition='CLOUD', billing_cycle='MONTHLY', max_clients=7)
        y = self.plan(name='Win Yearly', billing_cycle='YEARLY', duration=2)
        life = self.plan(name='Win Lifetime', billing_cycle='LIFETIME', duration=5, max_users=None, max_branches=None)
        self.assertIsNone(m['max_clients'], 'client counts apply to the Windows edition only')
        self.assertEqual(y['duration'], 2)
        self.assertEqual(life['duration'], 1)
        self.assertIsNone(life['max_users'])
        # A limit that is not sent is an error, never a silent "unlimited".
        body = {'name': 'Missing', 'edition': 'WINDOWS_LOCAL', 'billing_cycle': 'MONTHLY', 'price': '1',
                'currency': 'INR', 'max_clients': 0, 'max_companies': 1, 'max_branches': 1, 'modules': ALL_MODULES}
        res = self.api.post(f'{BASE}plans/', body, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('max_users', res.data)
        # Unknown modules / both accounting tiers are refused by the shared module rules.
        res = self.api.post(f'{BASE}plans/', {**body, 'max_users': 2, 'modules': ['accounts', 'financial']}, format='json')
        self.assertEqual(res.status_code, 400)
        # Duplicate code.
        res = self.api.post(f'{BASE}plans/', {**body, 'name': 'Win Yearly', 'max_users': 1}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_edit_activate_deactivate_are_audited_and_deactivated_plans_cannot_be_sold(self):
        p = self.plan()
        res = self.api.patch(f"{BASE}plans/{p['id']}/", {'price': '15000.00', 'max_users': 8}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['max_users'], 8)
        self.assertEqual(self.api.post(f"{BASE}plans/{p['id']}/deactivate/", {}, format='json').status_code, 200)
        res = self.api.post(f'{BASE}licences/', {'plan_id': p['id'], 'client': {'name': 'X'}}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('deactivated', res.data['detail'])
        self.assertEqual(self.api.post(f"{BASE}plans/{p['id']}/activate/", {}, format='json').status_code, 200)
        actions = list(LicenseAuditEvent.objects.filter(plan_id=p['id']).values_list('action', flat=True))
        for a in ('PLAN_CREATED', 'PLAN_UPDATED', 'PLAN_DEACTIVATED', 'PLAN_ACTIVATED'):
            self.assertIn(a, actions)

    def test_plan_edit_never_changes_a_sold_licence_and_edition_is_locked(self):
        p = self.plan()
        lic = self.windows_licence(p)
        self.api.patch(f"{BASE}plans/{p['id']}/", {'max_users': 50}, format='json')
        self.assertEqual(ClientLicense.objects.get(pk=lic['id']).limits['users'], 5)
        res = self.api.patch(f"{BASE}plans/{p['id']}/", {'edition': 'CLOUD'}, format='json')
        self.assertEqual(res.status_code, 400)


class IssueTests(Fixture):
    def test_monthly_yearly_lifetime_expiry_and_signed_contents(self):
        start = '2026-11-18'
        monthly = self.windows_licence(self.plan(name='M', billing_cycle='MONTHLY'), starts_on=start, name='A')
        yearly = self.windows_licence(self.plan(name='Y', billing_cycle='YEARLY'), starts_on=start, name='B')
        life = self.windows_licence(self.plan(name='L', billing_cycle='LIFETIME', max_users=None), starts_on=start,
                                    name='C', installation=INSTALL_A)
        self.assertEqual(monthly['expires_on'], '2026-12-18')  # 1 calendar month: to the same date
        self.assertEqual(yearly['expires_on'], '2027-11-18')
        self.assertIsNone(life['expires_on'])
        self.assertTrue(life['lifetime'])
        p = decode(life['key'])
        self.assertEqual(p['v'], 2)
        self.assertEqual(p['product'], 'G-OPTICALS')
        self.assertEqual(p['lic_id'], life['lic_id'])
        self.assertEqual(p['client']['id'], life['client']['client_code'])
        self.assertEqual(p['edition'], 'WINDOWS_LOCAL')
        self.assertEqual(p['plan']['cycle'], 'LIFETIME')
        self.assertTrue(p['lifetime'])
        self.assertIsNone(p['valid_until'])
        self.assertEqual(p['starts_on'], start)
        self.assertIn('users', p['unlimited'])
        self.assertEqual(p['limits']['companies'], 2)
        self.assertEqual(p['limits']['branches_total'], 3)
        self.assertEqual(p['limits']['clients'], 0)
        self.assertEqual(p['status'], 'ACTIVE')
        self.assertEqual(p['install_id'], INSTALL_A)
        self.assertEqual(p['binding'], 'INSTALLATION')
        self.assertIn('issued_at', p)
        pm = decode(monthly['key'])
        self.assertEqual(pm['binding'], 'FIRST_ACTIVATION')
        self.assertEqual(pm['valid_until'], '2026-12-18T23:59:59-12:00')
        self.assertTrue(pm['client']['id'].startswith('CL-'))

    def test_keys_and_licence_ids_are_unique_and_masked_in_lists(self):
        plan = self.plan()
        made = [self.windows_licence(plan, name=f'Shop {i}') for i in range(6)]
        self.assertEqual(len({m['lic_id'] for m in made}), 6)
        self.assertEqual(len({m['key'] for m in made}), 6)
        res = self.api.get(f'{BASE}licences/')
        self.assertEqual(res.data['count'], 6)
        for row in res.data['results']:
            self.assertNotIn('key', row)
            self.assertTrue(row['key_masked'].startswith('GTL1.••••'))
            self.assertNotIn('key_token', row)
        lic = made[0]
        res = self.api.post(f"{BASE}licences/{lic['id']}/key/", {}, format='json')
        self.assertEqual(res.data['key'], lic['key'])
        self.assertTrue(LicenseAuditEvent.objects.filter(licence_id=lic['id'], action='KEY_COPIED').exists())

    def test_tampered_or_foreign_signatures_never_verify(self):
        lic = self.windows_licence()
        head, body, sig = lic['key'].split('.')
        p = json.loads(licfmt.b64u_decode(body))
        p['limits']['users'] = 999
        forged = f"{head}.{licfmt.b64u_encode(json.dumps(p).encode())}.{sig}"
        with self.assertRaises(licfmt.LicenseFormatError):
            signing.verify_token(forged)
        other = Ed25519PrivateKey.generate()
        foreign = licfmt.encode({**p, 'key_id': 'gtl-dev-vendortest'}, 'GTL1', other.sign)
        with self.assertRaises(licfmt.LicenseFormatError):
            signing.verify_token(foreign)
        self.assertEqual(signing.verify_token(lic['key'])['lic_id'], lic['lic_id'])
        detail = self.api.get(f"{BASE}licences/{lic['id']}/").data
        self.assertTrue(detail['signature']['valid'])
        self.assertEqual(detail['issuances'][0]['reason'], 'CREATED')

    def test_no_signing_key_means_nothing_is_issued(self):
        plan = self.plan()
        with override_settings(GTRADE_LICENSE_SIGNING_KEY='', GTRADE_LICENSE_SIGNING_KEY_ID=''):
            signing.reset_cache()
            res = self.api.post(f'{BASE}licences/', {'plan_id': plan['id'], 'client': {'name': 'Nope'}}, format='json')
            self.assertEqual(res.status_code, 503)
            self.assertEqual(res.data['code'], 'signing_unavailable')
            self.assertFalse(self.api.get(f'{BASE}catalog/').data['signing']['configured'])
            crl = APIClient().get(f'{AUTH}crl')
            self.assertEqual((crl.status_code, crl.json()['crl']), (200, None), 'nothing to publish is not a fault')
            act = APIClient().post(f'{AUTH}activate', json.dumps({'key': 'x', 'install_id': 'y'}),
                                   content_type='application/json')
            self.assertEqual(act.status_code, 503)
        self.assertFalse(LicensedClient.objects.filter(name='Nope').exists())
        self.assertEqual(ClientLicense.objects.count(), 0)

    def test_development_key_refused_on_a_production_server(self):
        with override_settings(DEBUG=False, RUNNING_TESTS=False):
            signing.reset_cache()
            with self.assertRaises(signing.SigningKeyError):
                signing.key_id()
        signing.reset_cache()

    def test_installation_request_code_binds_install_and_machine(self):
        code = 'GTR1.' + base64.urlsafe_b64encode(json.dumps(
            {'install_id': INSTALL_A, 'fp': {'v': 1, 'hashes': FP}}).encode()).rstrip(b'=').decode()
        lic = self.windows_licence(installation=code)
        p = decode(lic['key'])
        self.assertEqual(p['install_id'], INSTALL_A)
        self.assertEqual(p['fp']['hashes'], FP)
        res = self.api.post(f'{BASE}licences/', {'plan_id': lic['plan']['id'], 'client': {'name': 'Bad'},
                                                 'installation': 'GTR1.%%%'}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertIn('installation', res.data)


class CloudClientTests(Fixture):
    def onboard(self, plan, **kw):
        body = {'tenant_name': 'City Opticals UAE', 'admin_username': 'cityadmin', 'password': 'Gl4sses-Dubai-77',
                'admin_email': 'owner@city.example', 'branch_name': 'Deira', 'licence_plan_id': plan['id'],
                'licence_starts_on': '2026-11-18', 'max_users': 99, 'package': 'FULL_SUITE'}
        body.update(kw)
        return self.api.post('/api/superadmin/tenants/', body, format='json')

    def test_create_client_with_cloud_plan_applies_terms_and_returns_key(self):
        plan = self.plan(name='Cloud Monthly', edition='CLOUD', billing_cycle='MONTHLY', max_users=3, max_branches=2,
                         max_companies=1, modules=['optical', 'sales', 'inventory', 'admin', 'reports', 'settings'],
                         settings_features=['store', 'localization'])
        res = self.onboard(plan)
        self.assertEqual(res.status_code, 201, res.content)
        lic = res.data['licence']
        self.assertTrue(lic['key'].startswith('GTL1.'))
        tenant = Tenant.objects.get(pk=res.data['id'])
        self.assertEqual(tenant.max_users, 3, 'the plan wins over the form')
        self.assertEqual(tenant.max_branches, 2)
        self.assertEqual(tenant.subscription_plan, 'MONTHLY')
        self.assertEqual(tenant.subscription_expires_on, dt.date(2026, 12, 18))
        self.assertEqual(sorted(tenant.modules), sorted(['optical', 'sales', 'inventory', 'admin', 'reports', 'settings']))
        self.assertEqual(tenant.settings_features, ['store', 'localization'])
        p = decode(lic['key'])
        self.assertEqual(p['edition'], 'CLOUD')
        self.assertEqual(p['tenant_id'], tenant.pk)
        self.assertEqual(p['binding'], 'CLOUD')
        self.assertTrue(TenantAuditLog.objects.filter(tenant=tenant, action='LICENCE_CREATED').exists())
        # The workspace's own copy of the terms is licence-managed now.
        res = self.api.patch(f'/api/superadmin/tenants/{tenant.pk}/', {'max_users': 50}, format='json')
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.data['code'], 'licence_managed')
        res = self.api.patch(f'/api/superadmin/tenants/{tenant.pk}/', {'owner_name': 'New Owner'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['licence']['lic_id'], lic['lic_id'])
        # A second licence for the same cloud workspace is refused.
        res = self.api.post(f'{BASE}licences/', {'plan_id': plan['id'], 'tenant_id': tenant.pk}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_windows_plan_cannot_create_a_cloud_workspace_and_failure_rolls_back(self):
        win = self.plan()
        res = self.onboard(win)
        self.assertEqual(res.status_code, 400)
        self.assertFalse(Tenant.objects.filter(name='City Opticals UAE').exists())
        cloud = self.plan(name='Cloud Y', edition='CLOUD')
        with override_settings(GTRADE_LICENSE_SIGNING_KEY=''):
            signing.reset_cache()
            res = self.onboard(cloud)
            self.assertEqual(res.status_code, 503)
        signing.reset_cache()
        self.assertFalse(Tenant.objects.filter(name='City Opticals UAE').exists())

    def test_existing_cloud_client_can_be_licensed(self):
        plan = self.plan(name='Cloud Y', edition='CLOUD', max_users=10)
        res = self.api.post(f'{BASE}licences/', {'plan_id': plan['id'], 'tenant_id': self.shop.pk}, format='json')
        self.assertEqual(res.status_code, 201, res.content)
        self.shop.refresh_from_db()
        self.assertEqual(self.shop.max_users, 10)
        self.assertEqual(LicensedClient.objects.get(tenant=self.shop).edition, 'CLOUD')
        res = self.api.post(f'{BASE}licences/', {'plan_id': plan['id'], 'tenant_id': 1}, format='json')
        self.assertEqual(res.status_code, 400)

    def test_suspend_blocks_cloud_client_reactivate_restores_revoke_is_permanent(self):
        plan = self.plan(name='Cloud Y', edition='CLOUD')
        lic = self.api.post(f'{BASE}licences/', {'plan_id': plan['id'], 'tenant_id': self.shop.pk}, format='json').data
        self.assertEqual(self.api.post(f"{BASE}licences/{lic['id']}/suspend/", {'reason': ''}, format='json').status_code, 400)
        res = self.api.post(f"{BASE}licences/{lic['id']}/suspend/", {'reason': 'Unpaid invoice'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(decode(res.data['key'])['status'], 'SUSPENDED')
        self.shop.refresh_from_db()
        self.assertFalse(self.shop.is_active)
        self.assertEqual(self.shop.deactivation_category, 'LICENCE_SUSPENDED')
        r = APIClient().post('/api/auth/login/', {'username': 'shopowner', 'password': PASSWORD}, format='json')
        self.assertNotEqual(r.status_code, 200)
        # The workspace lifecycle cannot bypass the licence.
        res = self.api.post(f'/api/superadmin/tenants/{self.shop.pk}/reactivate/', {'reason': 'x'}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.api.post(f"{BASE}licences/{lic['id']}/reactivate/", {'reason': 'Paid'}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.shop.refresh_from_db()
        self.assertTrue(self.shop.is_active)
        self.assertEqual(self.login('shopowner').get('/api/auth/profile/').status_code, 200)
        res = self.api.post(f"{BASE}licences/{lic['id']}/revoke/", {'reason': 'Fraud', 'confirm_lic_id': 'nope'}, format='json')
        self.assertEqual(res.status_code, 400)
        res = self.api.post(f"{BASE}licences/{lic['id']}/revoke/", {'reason': 'Fraud', 'confirm_lic_id': lic['lic_id']},
                            format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.shop.refresh_from_db()
        self.assertEqual(self.shop.deactivation_category, 'LICENCE_REVOKED')
        for path, body in (('reactivate/', {'reason': 'oops'}), ('renew/', {'confirm': True}),
                           ('suspend/', {'reason': 'again'})):
            self.assertEqual(self.api.post(f"{BASE}licences/{lic['id']}/{path}", body, format='json').status_code, 400)
        self.assertTrue(get_user_model().objects.filter(username='shopowner').exists(), 'no data is deleted')
        actions = set(LicenseAuditEvent.objects.filter(licence_id=lic['id']).values_list('action', flat=True))
        self.assertTrue({'LICENCE_CREATED', 'LICENCE_SUSPENDED', 'LICENCE_REACTIVATED', 'LICENCE_REVOKED'} <= actions)


class RenewAndChangeTests(Fixture):
    def test_renew_preview_then_confirm(self):
        plan = self.plan(name='M', billing_cycle='MONTHLY')
        today = timezone.localdate()
        lic = self.windows_licence(plan, starts_on=today.isoformat())
        res = self.api.post(f"{BASE}licences/{lic['id']}/renew/", {'periods': 2}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertIn('preview', res.data)
        self.assertNotIn('licence', res.data)
        self.assertEqual(ClientLicense.objects.get(pk=lic['id']).revision, 1, 'a preview changes nothing')
        expected = tokens.extend_expiry('MONTHLY', 1, dt.date.fromisoformat(lic['expires_on']), today, 2)
        self.assertEqual(res.data['preview']['proposed']['expires_on'], expected.isoformat())
        res = self.api.post(f"{BASE}licences/{lic['id']}/renew/", {'periods': 2, 'confirm': True}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['expires_on'], expected.isoformat())
        self.assertEqual(res.data['revision'], 2)
        self.assertNotEqual(res.data['key'], lic['key'])
        p = decode(res.data['key'])
        self.assertEqual(p['rev'], 2)
        self.assertEqual(p['lic_id'], lic['lic_id'])
        self.assertEqual(p['client']['id'], lic['client']['client_code'], 'renewal keeps the client')
        life = self.windows_licence(self.plan(name='L', billing_cycle='LIFETIME'), name='Life')
        self.assertEqual(self.api.post(f"{BASE}licences/{life['id']}/renew/", {'confirm': True},
                                       format='json').status_code, 400)

    def test_expired_licence_renews_from_today(self):
        plan = self.plan(name='M', billing_cycle='MONTHLY')
        lic = self.windows_licence(plan, starts_on='2025-01-01')
        self.assertEqual(self.api.get(f"{BASE}licences/{lic['id']}/").data['effective_status'], 'EXPIRED')
        res = self.api.post(f"{BASE}licences/{lic['id']}/renew/", {'confirm': True}, format='json')
        today = timezone.localdate()
        self.assertEqual(res.data['expires_on'], tokens.compute_expiry('MONTHLY', 1, today).isoformat())
        self.assertEqual(res.data['effective_status'], 'ACTIVE')

    def test_upgrade_and_downgrade_show_changes_and_need_confirmation(self):
        basic = self.plan(name='Cloud Basic', edition='CLOUD', max_users=10, max_branches=5)
        pro = self.plan(name='Cloud Pro', edition='CLOUD', max_users=20, max_branches=None)
        mini = self.plan(name='Cloud Mini', edition='CLOUD', max_users=1, max_branches=1,
                         modules=['sales', 'inventory', 'admin'])
        win = self.plan(name='Win', edition='WINDOWS_LOCAL')
        lic = self.api.post(f'{BASE}licences/', {'plan_id': basic['id'], 'tenant_id': self.shop.pk}, format='json').data
        res = self.api.post(f"{BASE}licences/{lic['id']}/change-plan/", {'plan_id': pro['id']}, format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['preview']['classification'], 'UPGRADE')
        labels = {c['label']: c for c in res.data['preview']['changes']}
        self.assertEqual(labels['Branches']['to'], 'Unlimited')
        self.assertEqual(str(ClientLicense.objects.get(pk=lic['id']).plan_id), basic['id'], 'preview changes nothing')
        res = self.api.post(f"{BASE}licences/{lic['id']}/change-plan/", {'plan_id': pro['id'], 'confirm': True},
                            format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(res.data['plan']['name'], 'Cloud Pro')
        self.shop.refresh_from_db()
        self.assertIsNone(self.shop.max_branches)
        # Downgrade below what the client uses: warned, nothing removed.
        User = get_user_model()
        User.objects.create_user('shopcashier', password=PASSWORD, role='CASHIER', tenant=self.shop)
        res = self.api.post(f"{BASE}licences/{lic['id']}/change-plan/", {'plan_id': mini['id']}, format='json')
        self.assertEqual(res.data['preview']['classification'], 'DOWNGRADE')
        self.assertTrue(any('Named users' in w for w in res.data['preview']['warnings']))
        self.assertTrue(any(c['label'] == 'Modules removed' for c in res.data['preview']['changes']))
        res = self.api.post(f"{BASE}licences/{lic['id']}/change-plan/", {'plan_id': mini['id'], 'confirm': True},
                            format='json')
        self.assertEqual(res.status_code, 200, res.content)
        self.assertEqual(User.objects.filter(tenant=self.shop, is_active=True).count(), 2, 'no user was deactivated')
        self.shop.refresh_from_db()
        self.assertEqual(self.shop.max_users, 1)
        self.assertTrue(LicenseAuditEvent.objects.filter(licence_id=lic['id'], action='PLAN_DOWNGRADED').exists())
        self.assertTrue(LicenseAuditEvent.objects.filter(licence_id=lic['id'], action='PLAN_UPGRADED').exists())
        # Another edition's plan is refused.
        res = self.api.post(f"{BASE}licences/{lic['id']}/change-plan/", {'plan_id': win['id'], 'confirm': True},
                            format='json')
        self.assertEqual(res.status_code, 400)


class AuthorityTests(Fixture):
    def call(self, path, body=None, method='post'):
        client = APIClient()
        fn = getattr(client, method)
        res = fn(f'{AUTH}{path}', json.dumps(body or {}), content_type='application/json') if method == 'post' \
            else fn(f'{AUTH}{path}')
        return res.status_code, res.json()

    def test_first_activation_binds_one_installation_only(self):
        lic = self.windows_licence()
        code, out = self.call('activate', {'key': lic['key'], 'install_id': INSTALL_A, 'fp': {'v': 1, 'hashes': FP}})
        self.assertEqual(code, 200, out)
        p = decode(out['license'])
        self.assertEqual(p['install_id'], INSTALL_A)
        self.assertEqual(p['fp']['hashes'], FP)
        self.assertEqual(p['binding'], 'INSTALLATION')
        self.assertEqual(p['rev'], 2)
        row = ClientLicense.objects.get(pk=lic['id'])
        self.assertEqual(row.activation_status(), 'ACTIVATED')
        # The same key on a second installation is refused.
        code, out = self.call('activate', {'key': lic['key'], 'install_id': INSTALL_B, 'fp': {'v': 1, 'hashes': FP}})
        self.assertEqual(code, 409)
        self.assertIn('another installation', out['error'])
        # Re-activation on the same installation (reinstall) gets the current licence back.
        code, out = self.call('activate', {'key': lic['key'], 'install_id': INSTALL_A, 'fp': {'v': 1, 'hashes': FP}})
        self.assertEqual(code, 200)
        self.assertEqual(decode(out['license'])['rev'], 2)
        self.assertTrue(LicenseAuditEvent.objects.filter(licence_id=lic['id'], action='ACTIVATION_REFUSED').exists())

    def test_checkin_delivers_renewal_suspension_and_revocation(self):
        lic = self.windows_licence(installation=INSTALL_A)
        body = {'lic_id': lic['lic_id'], 'install_id': INSTALL_A, 'fp': {'v': 1, 'hashes': FP}}
        code, out = self.call('checkin', body)
        self.assertEqual(code, 200, out)
        self.api.post(f"{BASE}licences/{lic['id']}/suspend/", {'reason': 'Unpaid'}, format='json')
        code, out = self.call('checkin', body)
        self.assertEqual(decode(out['license'])['status'], 'SUSPENDED')
        code, out = self.call('activate', {'key': lic['key'], 'install_id': INSTALL_A, 'fp': {'v': 1, 'hashes': FP}})
        self.assertEqual(code, 403)
        self.assertIn('suspended', out['error'])
        self.api.post(f"{BASE}licences/{lic['id']}/reactivate/", {'reason': 'Paid'}, format='json')
        self.api.post(f"{BASE}licences/{lic['id']}/revoke/", {'reason': 'Chargeback', 'confirm_lic_id': lic['lic_id']},
                      format='json')
        code, out = self.call('checkin', body)
        self.assertEqual(decode(out['license'])['status'], 'REVOKED')
        crl = licfmt.verify(out['crl'], licfmt.CRL_PREFIX, {'gtl-dev-vendortest': _PUB})
        self.assertIn(lic['lic_id'], [r['lic_id'] for r in crl['revoked']])
        # Another installation cannot check in for this licence.
        code, out = self.call('checkin', {**body, 'install_id': INSTALL_B})
        self.assertEqual(code, 404)

    def test_replacement_key_moves_installation_and_voids_old_revisions(self):
        lic = self.windows_licence(installation=INSTALL_A)
        res = self.api.post(f"{BASE}licences/{lic['id']}/replace-key/", {'reason': 'New PC', 'installation': INSTALL_B},
                            format='json')
        self.assertEqual(res.status_code, 200, res.content)
        p = decode(res.data['key'])
        self.assertEqual(p['install_id'], INSTALL_B)
        code, out = self.call('crl', method='get')
        crl = licfmt.verify(out['crl'], licfmt.CRL_PREFIX, {'gtl-dev-vendortest': _PUB})
        entry = next(r for r in crl['revoked'] if r['lic_id'] == lic['lic_id'])
        self.assertEqual(entry['below_rev'], p['rev'])
        code, _ = self.call('checkin', {'lic_id': lic['lic_id'], 'install_id': INSTALL_A})
        self.assertEqual(code, 404)
        # The old key, even on its old installation, can no longer activate.
        code, _ = self.call('activate', {'key': lic['key'], 'install_id': INSTALL_A, 'fp': {'v': 1, 'hashes': FP}})
        self.assertEqual(code, 409)
        self.assertTrue(LicenseAuditEvent.objects.filter(licence_id=lic['id'], action='KEY_REPLACED').exists())

    def test_refusals(self):
        win = self.windows_licence()
        cloud_plan = self.plan(name='Cloud', edition='CLOUD')
        cloud = self.api.post(f'{BASE}licences/', {'plan_id': cloud_plan['id'], 'tenant_id': self.shop.pk},
                              format='json').data
        bad = {'key': 'GTL1.abc.def', 'install_id': INSTALL_A, 'fp': {'hashes': FP}}
        self.assertEqual(self.call('activate', bad)[0], 400)
        self.assertEqual(self.call('activate', {'key': cloud['key'], 'install_id': INSTALL_A})[0], 400)
        self.assertEqual(self.call('activate', {'key': win['key']})[0], 400)
        self.assertEqual(self.call('deactivate', {'lic_id': win['lic_id'], 'install_id': INSTALL_A})[0], 403)
        expired = self.windows_licence(self.plan(name='M', billing_cycle='MONTHLY'), starts_on='2025-01-01', name='Old')
        code, out = self.call('activate', {'key': expired['key'], 'install_id': INSTALL_A, 'fp': {'hashes': FP}})
        self.assertEqual(code, 403)
        self.assertIn('expired', out['error'])
        self.assertEqual(self.call('health', method='get')[1]['signing'], True)

    def test_rate_limited(self):
        codes = [self.call('activate', {'key': 'x', 'install_id': 'y'})[0] for _ in range(35)]
        self.assertIn(429, codes)


class PermissionAndIsolationTests(Fixture):
    def test_only_the_platform_owner_reaches_the_console(self):
        plan = self.plan()
        lic = self.windows_licence(plan)
        for username in ('shopowner', 't1admin'):
            client = self.login(username)
            for method, path in (('get', 'catalog/'), ('get', 'plans/'), ('post', 'plans/'), ('get', 'licences/'),
                                 ('post', 'licences/'), ('get', f"licences/{lic['id']}/"),
                                 ('post', f"licences/{lic['id']}/key/"), ('post', f"licences/{lic['id']}/renew/"),
                                 ('post', f"licences/{lic['id']}/suspend/"), ('get', 'audit/'), ('get', 'clients/')):
                res = getattr(client, method)(f'{BASE}{path}', {}, format='json')
                self.assertEqual(res.status_code, 403, f'{username} {method} {path}')
        self.assertEqual(APIClient().get(f'{BASE}licences/').status_code, 401)

    def test_client_filter_and_licences_stay_with_their_client(self):
        plan = self.plan()
        a = self.windows_licence(plan, name='Client A')
        b = self.windows_licence(plan, name='Client B')
        rows = self.api.get(f'{BASE}licences/', {'client': a['client']['id']}).data['results']
        self.assertEqual([r['lic_id'] for r in rows], [a['lic_id']])
        self.assertNotEqual(decode(a['key'])['client']['id'], decode(b['key'])['client']['id'])
        # Client A's licence data grafted onto client B's licence id fails the signature check.
        head, body, sig = a['key'].split('.')
        p = json.loads(licfmt.b64u_decode(body))
        p['lic_id'] = b['lic_id']
        forged = f"{head}.{licfmt.b64u_encode(json.dumps(p, sort_keys=True, separators=(',', ':')).encode())}.{sig}"
        res = APIClient().post(f'{AUTH}activate', json.dumps({'key': forged, 'install_id': INSTALL_A}),
                               content_type='application/json')
        self.assertEqual(res.status_code, 400)


class SigningKeyCommandTests(TestCase):
    def test_generate_writes_private_key_to_file_and_prints_only_public(self):
        tmp = Path(tempfile.mkdtemp())
        out = io.StringIO()
        call_command('licence_signing_key', 'generate', '--key-id', 'gtl-prod-test1', '--out', str(tmp / 'k.pem'),
                     stdout=out)
        printed = out.getvalue()
        self.assertNotIn('PRIVATE KEY', printed)
        data = json.loads(printed)
        self.assertEqual(len(base64.b64decode(data['public_key'])), 32)
        self.assertIn('PRIVATE KEY', (tmp / 'k.pem').read_text())
        with self.assertRaises(CommandError):
            call_command('licence_signing_key', 'generate', '--key-id', 'gtl-prod-test1', '--out', str(tmp / 'k.pem'))
        with self.assertRaises(CommandError):
            call_command('licence_signing_key', 'generate', '--key-id', 'gtl-prod-test2',
                         '--out', str(Path(settings.BASE_DIR) / 'leak.pem'))
        self.assertFalse((Path(settings.BASE_DIR) / 'leak.pem').exists())
        os.remove(tmp / 'k.pem')
