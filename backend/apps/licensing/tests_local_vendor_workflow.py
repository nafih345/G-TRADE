"""Windows Local: the owner's permanent platform-owner licence + customer subscriptions issued
OFFLINE by the Local Super Admin, activated on the customer's installation, expiring and renewed.

Production code paths only: release build (dev keys refused, dev mode off), a NON-development
vendor key id, the vendor key held in a DPAPI-protected key file exactly as `gtrade-ctl vendor-key
generate` writes it (gtrade_ctl/vendor_key.py), and its public half in the build's trusted keys
(keys.PRODUCTION_KEYS, i.e. what vendor_public_keys.json ships). Two installations are simulated by
switching GTRADE_INSTALL_ID and starting the customer side with no licence state. The real
two-installation run is windows/tests/test_local_vendor_licensing_e2e.py.

Runs under config.settings_local (windows/tests/run_local_django_tests.py).
"""

import base64
import datetime as dt
import json
import shutil
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from django.conf import settings

if 'apps.licensing' not in settings.INSTALLED_APPS:  # cloud settings: nothing to test here
    raise unittest.SkipTest('local edition only')

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.core.cache import cache  # noqa: E402
from django.test import override_settings  # noqa: E402
from django.utils import timezone  # noqa: E402
from rest_framework.test import APIClient  # noqa: E402

from apps.common.models import Tenant  # noqa: E402
from apps.licensing import enforcement, keys, licfmt, owner, state  # noqa: E402
from apps.licensing.models import LicenseEvent, LicenseState  # noqa: E402
from apps.licensing.tests import LicensingBase  # noqa: E402
from apps.licensing.tests_local_client_management import SA_PW, _NoNetwork, run_superadmin  # noqa: E402
from apps.vendor_licensing import signing, tokens  # noqa: E402
from apps.vendor_licensing.models import ClientLicense, LicenseAuditEvent, LicenseIssuance  # noqa: E402

_WIN = Path(settings.BASE_DIR).parent / 'windows'
if str(_WIN) not in sys.path:
    sys.path.insert(0, str(_WIN))
from gtrade_ctl import vendor_key, winacl  # noqa: E402

VENDOR_INSTALL = '7a1d0c55-aaaa-4bbb-8ccc-000011112222'
CUSTOMER_INSTALL = '3c9e2f10-dddd-4eee-8fff-333344445555'
OTHER_PC = '9e8d7c6b-1234-4321-8888-999900001111'
KEY_ID = 'gtl-vendor-test'
LIC = '/api/superadmin/licensing/'

_TMP = Path(tempfile.mkdtemp(prefix='gtrade-vendorkey-'))
KEY_FILE = _TMP / 'license' / vendor_key.FILE_NAME
_principals = [p for p in [winacl.current_user_sid()] if p] if sys.platform == 'win32' else []
_PUBLIC = vendor_key.generate(KEY_FILE, KEY_ID, _principals or ['*S-1-5-18'])['public_key']


def _tearDownModule():
    shutil.rmtree(_TMP, ignore_errors=True)


tearDownModule = _tearDownModule


@override_settings(GTRADE_INSTALL_ID=VENDOR_INSTALL, GTRADE_LICENSE_DEV_MODE=False, GTRADE_RELEASE_BUILD=True,
                   GTRADE_LICENSE_SIGNING_KEY_FILE=str(KEY_FILE), GTRADE_LICENSE_SIGNING_KEY_ID='',
                   GTRADE_LICENSE_SIGNING_KEY='', GTRADE_LICENSE_SERVICE_URL='')
class LocalVendorBase(LicensingBase):
    """LicensingBase: tenant #1 with 'owner' (SUPER_ADMIN) + 'cashier'. Here: release build, the
    vendor key trusted as a production key, and a Local Super Admin."""

    def setUp(self):
        super().setUp()
        owner.reset()
        self.addCleanup(owner.reset)
        cache.clear()
        self.addCleanup(cache.clear)
        trust = mock.patch.dict(keys.PRODUCTION_KEYS, {KEY_ID: _PUBLIC})
        trust.start()
        self.addCleanup(trust.stop)
        signing.reset_cache()
        self.addCleanup(signing.reset_cache)
        from apps.common.organizations import ensure_organization
        ensure_organization(self.tenant)
        run_superadmin({'username': 'localsa', 'password': SA_PW})
        self.sa_user = get_user_model().objects.get(username='localsa')
        self.sa = APIClient()
        self.sa.force_authenticate(self.sa_user)
        self.customer_admin = APIClient()
        self.customer_admin.force_authenticate(self.admin)

    # ---- helpers ---------------------------------------------------------------------------------
    def plans(self):
        r = self.sa.get(f'{LIC}catalog/')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()['local'])
        self.assertTrue(r.json()['signing']['configured'], r.json()['signing'])
        return {p['code']: p for p in r.json()['plans']}

    def issue(self, plan_code, *, client=None, client_id=None, installation=CUSTOMER_INSTALL, starts_on=None,
              terms=None, expect=201):
        body = {'plan_id': self.plans()[plan_code]['id'], 'installation': installation,
                'starts_on': (starts_on or timezone.localdate()).isoformat()}
        if client_id:
            body['client_id'] = client_id
        else:
            body['client'] = client or {'name': 'CLEAR OPTICS', 'owner_name': 'Asha', 'phone': '9876500000'}
        if terms is not None:
            body['terms'] = terms
        r = self.sa.post(f'{LIC}licences/', body, format='json')
        self.assertEqual(r.status_code, expect, r.content)
        return r.json()

    def as_installation(self, install_id, *, fresh=False):
        """Switch this process to another installation: its own Installation ID and its own licence
        state (each installation has its own database; here they share one, so the state row is
        swapped). `fresh` = a new installation with no licence yet."""
        if not hasattr(self, '_states'):
            self._states = {}
        self._states[settings.GTRADE_INSTALL_ID] = list(LicenseState.objects.values())
        LicenseState.objects.all().delete()
        if not fresh:
            for row in self._states.get(install_id, []):
                LicenseState.objects.create(**row)
        # Only the vendor's own PC holds the vendor signing key; every other installation has none.
        key_file = str(KEY_FILE) if install_id == VENDOR_INSTALL else str(_TMP / 'no-key-on-this-pc.dpapi')
        ctx = override_settings(GTRADE_INSTALL_ID=install_id, GTRADE_LICENSE_SIGNING_KEY_FILE=key_file)
        ctx.enable()
        self.addCleanup(ctx.disable)
        signing.reset_cache()
        owner.reset()
        state.invalidate()

    def activate(self, key, client=None):
        return (client or self.customer_admin).post('/api/licensing/activate/', {'key': key}, format='json')

    @staticmethod
    def payload(key):
        return licfmt.decode_unverified(key)


@override_settings(GTRADE_INSTALL_ID=VENDOR_INSTALL, GTRADE_LICENSE_DEV_MODE=False, GTRADE_RELEASE_BUILD=True,
                   GTRADE_LICENSE_SIGNING_KEY_FILE=str(KEY_FILE), GTRADE_LICENSE_SIGNING_KEY_ID='',
                   GTRADE_LICENSE_SIGNING_KEY='', GTRADE_LICENSE_SERVICE_URL='')
class LocalVendorWorkflowTests(LocalVendorBase):

    # ---- TEST A: platform owner ------------------------------------------------------------------
    def test_a_platform_owner_is_permanent_unlimited_and_only_on_the_vendor_installation(self):
        # Without the automatic entitlement the vendor PC would still be an unlicensed evaluation.
        v = state.evaluate(persist=False)
        self.assertEqual((v.status, v.limits['clients']), ('EVALUATION', 1))
        with _NoNetwork():
            st = self.sa.get('/api/licensing/platform-owner/')
            self.assertEqual(st.status_code, 200, st.content)
            self.assertTrue(st.json()['available'], st.json())
            # Only the Local Super Admin, never a company administrator.
            self.assertEqual(self.customer_admin.post('/api/licensing/platform-owner/').status_code, 403)
            r = self.sa.post('/api/licensing/platform-owner/')
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual(d['status'], 'VALID')
        self.assertTrue(d['platform_owner'])
        self.assertTrue(d['lifetime'])
        self.assertIsNone(d['valid_until'])
        self.assertIsNone(d['days_left'])
        self.assertIsNone(d['modules'])                      # every module
        self.assertIsNone(d['settings_features'])
        self.assertEqual(d['tier'], 'ENTERPRISE')
        self.assertEqual(d['plan']['name'], 'Platform Owner / Lifetime')
        self.assertEqual(d['plan']['cycle'], 'LIFETIME')
        self.assertEqual(set(d['unlimited']), {'clients', 'companies', 'branches_total', 'branches_per_company', 'users'})
        self.assertFalse(d['development'])
        self.assertEqual(d['client']['id'], 'PLATFORM-OWNER')
        self.assertTrue(d['lic_id'].startswith('GOL-OWNER-'))
        # Genuinely unlimited in the enforcement points, and it never expires.
        enforcement.check_clients(adding=500)
        enforcement.check_users(self.tenant, adding=5000)
        enforcement.check_branches(self.tenant, adding=500)
        self.assertEqual(enforcement.company_limit(None, 1), enforcement.UNLIMITED_COMPANIES)
        self.assertEqual(enforcement.filter_modules(['optical', 'accounts', 'financial']), ['optical', 'accounts', 'financial'])
        for years in (1, 10, 50):
            later = state.evaluate(now=timezone.now() + dt.timedelta(days=365 * years), persist=False)
            self.assertEqual((later.status, later.read_only, later.platform_owner), ('VALID', False, True))
        self.assertTrue(LicenseAuditEvent.objects.filter(action='PLATFORM_OWNER_ISSUED').exists())
        # Its key cannot make any other installation a platform owner.
        owner_key = LicenseState.load().license_blob
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        r = self.activate(owner_key)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn('another installation', r.json()['error'])
        self.assertEqual(state.current(force=True).status, 'EVALUATION')

    def test_a_customer_installation_without_the_key_cannot_become_platform_owner(self):
        monthly = self.plans()['local-monthly']['id']
        with override_settings(GTRADE_LICENSE_SIGNING_KEY_FILE=str(_TMP / 'missing.dpapi')):
            signing.reset_cache()
            self.assertFalse(self.sa.get('/api/licensing/platform-owner/').json()['available'])
            r = self.sa.post('/api/licensing/platform-owner/')
            self.assertEqual(r.status_code, 503, r.content)
            self.assertIn('no vendor signing key', r.json()['error'])
            # ... and its licence console cannot issue a customer key either.
            r = self.sa.post(f'{LIC}licences/', {'plan_id': monthly, 'client': {'name': 'X'}}, format='json')
            self.assertEqual(r.status_code, 503, r.content)
        signing.reset_cache()
        # A forged owner licence (role set, signed by an untrusted key) is refused.
        payload = tokens.build_payload(
            lic_id='GOL-OWNER-FAKE', rev=1, issued_at=timezone.now(), client_id='PLATFORM-OWNER', client_name='x',
            edition='WINDOWS_LOCAL', plan_code='platform-owner', plan_name='Platform Owner / Lifetime',
            cycle='LIFETIME', duration=None, starts_on=timezone.localdate(), expires_on=None,
            limits={}, modules=[], settings_features=None, install_id=VENDOR_INSTALL, role='PLATFORM_OWNER')
        forged = licfmt.encode({**payload, 'key_id': KEY_ID}, 'GTL1', Ed25519PrivateKey.generate().sign)
        r = self.activate(forged)
        self.assertEqual(r.status_code, 400, r.content)
        self.assertIn('signature', r.json()['error'])

    def test_a_untrusted_vendor_key_never_signs(self):
        with mock.patch.dict(keys.PRODUCTION_KEYS, {KEY_ID: base64.b64encode(b'\x01' * 32).decode()}):
            signing.reset_cache()
            r = self.sa.post('/api/licensing/platform-owner/')
            self.assertEqual(r.status_code, 503, r.content)
            self.assertIn('not yet trusted', r.json()['error'])
        signing.reset_cache()

    # ---- TEST B / C: monthly customer, expiry, renewal ---------------------------------------------
    def test_b_c_monthly_customer_offline_issue_activate_expire_and_renew(self):
        start = timezone.localdate()
        with _NoNetwork():
            created = self.issue('local-monthly', starts_on=start, terms={
                'tier': 'PROFESSIONAL', 'limits': {'users': 3, 'companies': 1, 'branches': 2, 'branches_per_company': 2,
                                                   'clients': 0},
                'modules': ['optical', 'sales', 'inventory', 'accounts', 'admin', 'reports', 'settings'],
                'settings_features': ['store', 'bill-designer']})
        key = created['key']
        expires = tokens.add_months(start, 1)
        self.assertEqual(created['expires_on'], expires.isoformat())
        self.assertEqual(created['tier'], 'PROFESSIONAL')
        self.assertTrue(created['custom_terms'])
        p = self.payload(key)
        self.assertEqual((p['client']['name'], p['client']['id']), ('CLEAR OPTICS', created['client']['client_code']))
        self.assertEqual((p['edition'], p['plan']['code'], p['plan']['cycle'], p['plan']['duration']),
                         ('WINDOWS_LOCAL', 'local-monthly', 'MONTHLY', 1))
        self.assertEqual((p['starts_on'], p['expires_on']), (start.isoformat(), expires.isoformat()))
        self.assertEqual((p['install_id'], p['binding']), (CUSTOMER_INSTALL, 'INSTALLATION'))
        self.assertEqual(p['limits'], {'clients': 0, 'companies': 1, 'branches_total': 2, 'branches_per_company': 2,
                                       'users': 3})
        self.assertEqual(p['unlimited'], [])
        self.assertEqual(p['settings_features'], ['store', 'bill-designer'])
        self.assertEqual(p['key_id'], KEY_ID)
        self.assertTrue(p['lic_id'].startswith('GOL-'))

        # The customer's own installation: paste the key, Activate, offline.
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        with _NoNetwork():
            r = self.activate('\n'.join(key[i:i + 64] for i in range(0, len(key), 64)))
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual((d['status'], d['read_only'], d['platform_owner']), ('VALID', False, False))
        self.assertEqual((d['plan']['name'], d['tier'], d['expires_on']), ('Monthly', 'PROFESSIONAL', expires.isoformat()))
        self.assertIn(d['days_left'], ((expires - start).days, (expires - start).days - 1, (expires - start).days + 1))
        self.assertEqual(d['install_id'], CUSTOMER_INSTALL)
        self.assertEqual(d['modules'], ['optical', 'sales', 'inventory', 'accounts', 'admin', 'reports', 'settings'])
        # Its purchased limits are enforced: 3 users (owner + cashier in use), 2 branches per company.
        enforcement.check_users(self.tenant, adding=1)
        with self.assertRaises(enforcement.LicenseLimitError):
            enforcement.check_users(self.tenant, adding=2)
        self.assertEqual(enforcement.filter_modules(['optical', 'wholesale', 'financial']), ['optical'])
        # Customer data written while the subscription runs.
        r = self.customer_admin.post('/api/masters/brands/', {'name': 'Rayban Test Brand', 'code': 'RBT1'}, format='json')
        self.assertIn(r.status_code, (200, 201), r.content)
        users_before = get_user_model().objects.filter(is_active=True).count()

        # ---- the clock passes the expiry date -------------------------------------------------------
        after = timezone.now() + dt.timedelta(days=(expires - start).days + 2)
        with mock.patch('django.utils.timezone.now', return_value=after):
            state.invalidate()
            v = state.current(force=True)
            self.assertEqual((v.status, v.read_only), ('EXPIRED', True))
            self.assertIn('expired', v.message.lower())
            r = self.customer_admin.post('/api/masters/brands/', {'name': 'Blocked', 'code': 'BLK1'}, format='json')
            self.assertEqual(r.status_code, 402)                                   # paid features restricted
            listing = self.customer_admin.get('/api/masters/brands/')
            self.assertEqual(listing.status_code, 200)                             # data still readable
            self.assertIn('Rayban Test Brand', json.dumps(listing.json()))
            self.assertEqual(self.customer_admin.get('/api/licensing/status/').json()['status'], 'EXPIRED')
            self.assertTrue(Tenant.objects.get(pk=1).is_active)                    # account not deactivated
            self.assertEqual(get_user_model().objects.filter(is_active=True).count(), users_before)
            # An expired key is refused if pasted again.
            r = self.activate(key)
            self.assertEqual(r.status_code, 400)
            self.assertIn('expired', r.json()['error'])

            # ---- renewal on the vendor installation (offline), months later --------------------------
            self.as_installation(VENDOR_INSTALL)
            lic = ClientLicense.objects.get(lic_id=p['lic_id'])
            with _NoNetwork():
                preview = self.sa.post(f'{LIC}licences/{lic.pk}/renew/', {'periods': 1}, format='json')
                self.assertEqual(preview.status_code, 200, preview.content)
                renewed = self.sa.post(f'{LIC}licences/{lic.pk}/renew/', {'periods': 1, 'confirm': True,
                                                                         'terms': {'limits': {'users': 5}}}, format='json')
            self.assertEqual(renewed.status_code, 200, renewed.content)
            new_key = renewed.json()['key']
            new_expiry = tokens.add_months(timezone.localdate(after), 1)
            q = self.payload(new_key)
            self.assertEqual((q['lic_id'], q['rev'], q['expires_on']), (p['lic_id'], 2, new_expiry.isoformat()))
            self.assertEqual((q['limits']['users'], q['limits']['branches_total'], q['tier']), (5, 2, 'PROFESSIONAL'))
            self.assertEqual(q['install_id'], CUSTOMER_INSTALL)                    # same installation

            # ---- the customer pastes the renewal key ---------------------------------------------------
            self.as_installation(CUSTOMER_INSTALL)
            with _NoNetwork():
                r = self.activate(new_key)
            self.assertEqual(r.status_code, 200, r.content)
            d = r.json()
            self.assertEqual((d['status'], d['read_only'], d['revision'], d['expires_on']),
                             ('VALID', False, 2, new_expiry.isoformat()))
            self.assertEqual(d['install_id'], CUSTOMER_INSTALL)
            r = self.customer_admin.post('/api/masters/brands/', {'name': 'After Renewal', 'code': 'AFR1'}, format='json')
            self.assertIn(r.status_code, (200, 201), r.content)
            names = json.dumps(self.customer_admin.get('/api/masters/brands/').json())
            self.assertIn('Rayban Test Brand', names)                              # previous data intact
            self.assertEqual(get_user_model().objects.filter(is_active=True).count(), users_before)
            # The old (expired) revision can never come back.
            r = self.activate(key)
            self.assertEqual(r.status_code, 400)
        # History kept on both sides.
        self.assertEqual(LicenseIssuance.objects.filter(licence=lic).count(), 2)
        self.assertGreaterEqual(LicenseEvent.objects.filter(event='install').count(), 2)

    def test_c_create_new_subscription_for_an_expired_customer_replaces_the_licence(self):
        old_start = timezone.localdate() - dt.timedelta(days=40)
        with mock.patch('django.utils.timezone.now', return_value=timezone.now() - dt.timedelta(days=40)):
            first = self.issue('local-monthly', starts_on=old_start)
            self.as_installation(CUSTOMER_INSTALL, fresh=True)
            self.assertEqual(self.activate(first['key']).status_code, 200)
        state.invalidate()
        self.assertEqual(state.current(force=True).status, 'EXPIRED')
        self.as_installation(VENDOR_INSTALL)
        second = self.issue('local-quarterly', client_id=first['client']['id'])
        self.assertNotEqual(second['lic_id'], first['lic_id'])
        self.assertEqual(second['client']['client_code'], first['client']['client_code'])
        self.as_installation(CUSTOMER_INSTALL)
        r = self.activate(second['key'])
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['status'], r.json()['lic_id'], r.json()['plan']['duration']),
                         ('VALID', second['lic_id'], 3))
        self.assertEqual(LicenseState.load().client_id, first['client']['client_code'])

    # ---- TEST D: other plans -------------------------------------------------------------------------
    def test_d_quarterly_half_yearly_yearly_and_lifetime(self):
        start = dt.date(2026, 11, 19)
        expected = {'local-monthly': '2026-12-19', 'local-quarterly': '2027-02-19', 'local-half-yearly': '2027-05-19',
                    'local-yearly': '2027-11-19', 'local-lifetime': None}
        today = timezone.localdate()
        for code, exp in expected.items():
            with self.subTest(code):
                self.as_installation(VENDOR_INSTALL)
                created = self.issue(code, starts_on=start, client={'name': f'Customer {code}'},
                                     installation=CUSTOMER_INSTALL)
                self.assertEqual(created['expires_on'], exp)
                p = self.payload(created['key'])
                self.assertEqual(p['expires_on'], exp)
                self.assertEqual(p['lifetime'], exp is None)
                self.as_installation(CUSTOMER_INSTALL, fresh=True)
                r = self.activate(created['key'])
                if exp is not None and dt.date.fromisoformat(exp) < today:
                    self.assertEqual(r.status_code, 400)  # (only if this suite runs after that date)
                    continue
                self.assertEqual(r.status_code, 200, r.content)
                self.assertEqual(r.json()['status'], 'VALID')
                if exp:
                    end = dt.datetime.fromisoformat(f'{exp}T12:00:00+00:00')
                    self.assertEqual(state.evaluate(now=end, persist=False).status, 'VALID')      # usable on the expiry day
                    self.assertEqual(state.evaluate(now=end + dt.timedelta(days=2), persist=False).status, 'EXPIRED')
                else:
                    later = timezone.now() + dt.timedelta(days=3650)
                    self.assertEqual(state.evaluate(now=later, persist=False).status, 'VALID')

    # ---- TEST E: offline -----------------------------------------------------------------------------
    def test_e_whole_workflow_runs_without_any_network(self):
        with _NoNetwork():
            # No Installation ID yet: the subscription is saved, but no key is handed out (an unbound key
            # would need an online licence authority, which this offline vendor installation is not).
            created = self.issue('local-yearly', installation='')
            self.assertNotIn('key', created)
            self.assertFalse(created['key_available'])
            unbound_key = ClientLicense.objects.get(pk=created['id']).key_token
            bound = self.issue('local-yearly', client={'name': 'Offline Optics'})
            self.as_installation(CUSTOMER_INSTALL, fresh=True)
            r = self.activate(unbound_key)             # even if such a key leaked: explained, never silently online
            self.assertIn(r.status_code, (400, 502))
            r = self.activate(bound['key'])
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(r.json()['status'], 'VALID')
            # .lic file import: the same rules.
            LicenseState.objects.all().delete()
            state.invalidate()
            r = self.customer_admin.post('/api/licensing/import/', {'license': bound['key'] + '\n'}, format='json')
            self.assertEqual(r.status_code, 200, r.content)

    # ---- TEST F: security ----------------------------------------------------------------------------
    def test_f_wrong_client_wrong_pc_tampered_expired_and_untrusted_keys_are_refused(self):
        mine = self.issue('local-monthly', client={'name': 'CLEAR OPTICS'})
        other_client = self.issue('local-monthly', client={'name': 'Somebody Else'})
        other_pc = self.issue('local-monthly', client_id=mine['client']['id'], installation=OTHER_PC)
        expired = self.issue('local-monthly', client_id=mine['client']['id'],
                             starts_on=timezone.localdate() - dt.timedelta(days=90))
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        self.assertEqual(self.activate(mine['key']).status_code, 200)

        def refused(key, words):
            r = self.activate(key)
            self.assertEqual(r.status_code, 400, r.content)
            self.assertIn(words, r.json()['error'].lower())

        refused(other_client['key'], 'different client')
        refused(other_pc['key'], 'another installation')
        refused(expired['key'], 'expired')
        head, body, sig = mine['key'].split('.')
        data = json.loads(licfmt.b64u_decode(body))
        data['limits']['users'] = 999
        refused(f'{head}.{licfmt.b64u_encode(json.dumps(data).encode())}.{sig}', 'signature')
        refused(mine['key'][:-6] + ('AAAAAA' if not mine['key'].endswith('AAAAAA') else 'BBBBBB'), 'signature')
        rogue = licfmt.encode({**self.payload(mine['key']), 'key_id': KEY_ID}, 'GTL1', Ed25519PrivateKey.generate().sign)
        refused(rogue, 'signature')
        unknown = licfmt.encode({**self.payload(mine['key']), 'key_id': 'gtl-someone-else'}, 'GTL1',
                                Ed25519PrivateKey.generate().sign)
        refused(unknown, 'unknown key')
        dev = licfmt.encode({**self.payload(mine['key']), 'key_id': 'gtl-dev-test'}, 'GTL1',
                            Ed25519PrivateKey.generate().sign)
        refused(dev, 'unknown key')                    # development keys are never trusted in a release build
        self.assertEqual(state.current(force=True).status, 'VALID')        # the good licence is untouched
        self.assertEqual(LicenseState.load().lic_id, self.payload(mine['key'])['lic_id'])
        # A customer installation's company administrator can never reach the vendor console.
        self.assertEqual(self.customer_admin.get(f'{LIC}catalog/').status_code, 403)

    def test_f_vendor_key_proof_and_encrypted_backup(self):
        key_id, key = vendor_key.load(KEY_FILE)
        self.assertEqual(key_id, KEY_ID)
        proof = vendor_key.proof(key_id, key, VENDOR_INSTALL)
        self.assertEqual(vendor_key.verify_proof(proof, KEY_ID, _PUBLIC)['install_id'], VENDOR_INSTALL)
        with self.assertRaises(vendor_key.VendorKeyError):
            vendor_key.verify_proof(proof, KEY_ID, base64.b64encode(b'\x02' * 32).decode())
        self.assertNotIn(b'PRIVATE', KEY_FILE.read_bytes())         # DPAPI-encrypted at rest
        backup = vendor_key.export_encrypted(KEY_FILE, 'correct horse battery staple')
        self.assertEqual(json.loads(backup)['format'], 'GTKB1')              # scrypt + AES-256-GCM
        self.assertNotIn(b'correct horse', backup)
        restored = _TMP / 'restore' / vendor_key.FILE_NAME
        with self.assertRaises(vendor_key.VendorKeyError):
            vendor_key.import_encrypted(restored, backup, 'wrong passphrase!!', _principals or ['*S-1-5-18'])
        info = vendor_key.import_encrypted(restored, backup, 'correct horse battery staple', _principals or ['*S-1-5-18'])
        self.assertEqual(info, {'key_id': KEY_ID, 'public_key': _PUBLIC})
        with self.assertRaises(vendor_key.VendorKeyError):               # never overwritten
            vendor_key.generate(restored, KEY_ID, _principals or ['*S-1-5-18'])
