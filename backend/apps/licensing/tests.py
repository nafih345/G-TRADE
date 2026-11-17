"""Licensing + local-edition guards. Runs only under config.settings_local
(windows/tests/run_local_django_tests.py starts a disposable PostgreSQL 17 cluster for it)."""

import base64
import datetime as dt
import json
import os
import sys
import tempfile
import threading
import unittest
from pathlib import Path

from django.conf import settings

if 'apps.licensing' not in settings.INSTALLED_APPS:  # cloud settings: nothing to test here
    raise unittest.SkipTest('licensing is part of the Windows local edition only')

from cryptography.hazmat.primitives import serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.core.exceptions import ImproperlyConfigured  # noqa: E402
from django.core.management import call_command  # noqa: E402
from django.core.management.base import CommandError  # noqa: E402
from django.test import TestCase, override_settings  # noqa: E402
from django.utils import timezone  # noqa: E402
from rest_framework.test import APIClient  # noqa: E402

from apps.licensing import enforcement, fingerprint, service, state  # noqa: E402
from apps.licensing.models import LicenseState  # noqa: E402

REPO = Path(settings.BASE_DIR).parent
sys.path.insert(0, str(REPO / 'licensing_service'))
from gtrade_licensing import format as vendor_fmt  # noqa: E402  (signing side, cross-compat)

INSTALL_ID = '5b0c1f7e-1111-4222-8333-444455556666'
FP_VALUES = {'machine_guid': 'MG-1', 'volume': 'VOL-1', 'bios_uuid': 'BIOS-1', 'cpu': 'CPU-1', 'mac': 'MAC-1'}
_TMP = Path(tempfile.mkdtemp(prefix='gtrade-lic-'))
_DEV_KEY = Ed25519PrivateKey.generate()
_OTHER_KEY = Ed25519PrivateKey.generate()
_PUBFILE = _TMP / 'pub.json'
_PUBFILE.write_text(json.dumps({'gtl-dev-test': base64.b64encode(_DEV_KEY.public_key().public_bytes(
    serialization.Encoding.Raw, serialization.PublicFormat.Raw)).decode()}))


def fp_hashes(values=FP_VALUES):
    return {k: fingerprint._hash(k, v) for k, v in values.items()}


def make_license(*, key=_DEV_KEY, key_id='gtl-dev-test', install_id=INSTALL_ID, days=365, grace=30, limits=None,
                 modules=None, issued_at=None, checkin_days=None, updates_until=None, fp=None, lic_id='L-TEST-1'):
    now = timezone.now()
    payload = {'lic_id': lic_id, 'activation_id': 'A-1', 'install_id': install_id, 'key_id': key_id,
               'customer': {'name': 'Sunrise Opticals'}, 'edition': 'PROFESSIONAL', 'deployment': 'LAN',
               'type': 'subscription' if checkin_days else 'perpetual',
               'limits': limits or {'users': 5, 'companies': 2, 'branches_total': 3, 'branches_per_company': 2},
               'modules': modules, 'issued_at': (issued_at or now).isoformat(),
               'valid_until': (now + dt.timedelta(days=days)).isoformat() if days is not None else None,
               'updates_until': updates_until, 'grace_days': grace, 'checkin_days': checkin_days,
               'fp': {'v': 1, 'hashes': fp if fp is not None else fp_hashes(), 'tolerance': 2}}
    return vendor_fmt.encode(payload, 'GTL1', key.sign)


def make_crl(revoked, issued_at=None):
    return vendor_fmt.encode({'key_id': 'gtl-dev-test', 'issued_at': (issued_at or timezone.now()).isoformat(),
                              'revoked': revoked}, 'GTC1', _DEV_KEY.sign)


@override_settings(GTRADE_INSTALL_ID=INSTALL_ID, GTRADE_LICENSE_DEV_MODE=True, GTRADE_LICENSE_DEV_PUBKEYS=str(_PUBFILE),
                   GTRADE_RELEASE_BUILD=False)
class LicensingBase(TestCase):
    def setUp(self):
        os.environ['GTRADE_FP_OVERRIDE'] = json.dumps(FP_VALUES)
        fingerprint.reset_cache()
        state.invalidate()
        User = get_user_model()
        from apps.common.models import Tenant
        self.tenant = Tenant.objects.get(pk=1)
        self.admin = User.objects.create_user(username='owner', password='x-Very-Long-Pass-1', role='SUPER_ADMIN', tenant=self.tenant)
        self.cashier = User.objects.create_user(username='cashier', password='x-Very-Long-Pass-1', role='CASHIER', tenant=self.tenant)
        self.api = APIClient()

    def tearDown(self):
        os.environ.pop('GTRADE_FP_OVERRIDE', None)
        fingerprint.reset_cache()
        state.invalidate()

    def install(self, blob):
        return service.install_blob(blob, actor='test')

    def set_installed_days_ago(self, days):
        LicenseState.load()
        LicenseState.objects.filter(pk=1).update(installed_at=timezone.now() - dt.timedelta(days=days))
        state.invalidate()


class EvaluationAndReadOnlyTests(LicensingBase):
    def test_evaluation_period_then_read_only_but_reads_and_recovery_work(self):
        v = state.current(force=True)
        self.assertEqual(v.status, 'EVALUATION')
        self.assertFalse(v.read_only)
        self.assertEqual(v.limits['users'], 2)
        self.set_installed_days_ago(31)
        self.assertEqual(state.current(force=True).status, 'EVALUATION_ENDED')
        self.api.force_authenticate(self.admin)
        r = self.api.post('/api/masters/brands/', {'name': 'X'}, format='json')
        self.assertEqual(r.status_code, 402)
        self.assertEqual(r.json()['error'], 'license_read_only')
        self.assertEqual(self.api.get('/api/licensing/status/').status_code, 200)
        self.assertNotEqual(self.api.get('/api/masters/brands/').status_code, 402)  # data stays readable
        r = self.api.post('/api/licensing/import/', {'license': make_license()}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['status'], 'VALID')
        self.assertNotEqual(self.api.post('/api/masters/brands/', {'name': 'Y'}, format='json').status_code, 402)


class SignatureAndBindingTests(LicensingBase):
    def test_valid_licence(self):
        v = self.install(make_license())
        self.assertEqual(v.status, 'VALID')
        self.assertTrue(v.development)
        self.assertIn('Development licence', ' '.join(v.warnings))

    def test_tampered_foreign_key_other_install_refused(self):
        blob = make_license()
        head, body, sig = blob.split('.')
        payload = json.loads(vendor_fmt.b64u_decode(body))
        payload['limits']['users'] = 999
        tampered = f'{head}.{vendor_fmt.b64u(json.dumps(payload).encode())}.{sig}'
        for bad in (tampered, make_license(key=_OTHER_KEY), make_license(install_id='other-install'),
                    make_license(key_id='gtl-dev-unknown'), 'garbage', make_crl([])):
            with self.assertRaises(Exception):
                self.install(bad)
        self.assertEqual(state.current(force=True).status, 'EVALUATION')

    def test_dev_keys_ignored_without_dev_mode_and_dev_mode_refused_in_release(self):
        blob = make_license()
        with override_settings(GTRADE_LICENSE_DEV_MODE=False):
            with self.assertRaises(Exception):
                self.install(blob)
        with override_settings(GTRADE_RELEASE_BUILD=True):
            with self.assertRaises(ImproperlyConfigured):
                self.install(blob)

    def test_admin_only_and_tampered_file_via_api(self):
        self.api.force_authenticate(self.cashier)
        self.assertEqual(self.api.post('/api/licensing/import/', {'license': make_license()}, format='json').status_code, 403)
        self.assertEqual(self.api.get('/api/licensing/status/').status_code, 200)
        self.api.force_authenticate(self.admin)
        r = self.api.post('/api/licensing/import/', {'license': make_license(key=_OTHER_KEY)}, format='json')
        self.assertEqual(r.status_code, 400)

    def test_older_licence_cannot_replace_newer(self):
        self.install(make_license(lic_id='L-NEW'))
        with self.assertRaises(Exception):
            self.install(make_license(lic_id='L-OLD', issued_at=timezone.now() - dt.timedelta(days=10)))


class ExpiryGraceClockTests(LicensingBase):
    def test_grace_then_read_only(self):
        self.install(make_license(days=-5, grace=30))
        v = state.current(force=True)
        self.assertEqual(v.status, 'GRACE')
        self.assertFalse(v.read_only)
        self.install(make_license(days=-40, grace=30))
        v = state.current(force=True)
        self.assertEqual(v.status, 'EXPIRED')
        self.assertTrue(v.read_only)

    def test_clock_rollback_cannot_extend(self):
        self.install(make_license(days=10, grace=0))
        future = timezone.now() + dt.timedelta(days=20)
        self.assertEqual(state.evaluate(now=future).status, 'EXPIRED')   # records last_seen in the future
        v = state.evaluate(now=timezone.now())                            # clock set back
        self.assertEqual(v.status, 'EXPIRED')
        self.assertTrue(v.clock_tamper)

    def test_subscription_checkin_overdue_goes_to_grace(self):
        self.install(make_license(checkin_days=30, grace=7))
        LicenseState.objects.filter(pk=1).update(last_checkin_at=timezone.now() - dt.timedelta(days=33))
        self.assertEqual(state.current(force=True).status, 'GRACE')
        LicenseState.objects.filter(pk=1).update(last_checkin_at=timezone.now() - dt.timedelta(days=40))
        self.assertEqual(state.current(force=True).status, 'EXPIRED')


class MachineAndRevocationTests(LicensingBase):
    def test_hardware_tolerance_and_other_machine(self):
        self.install(make_license())
        os.environ['GTRADE_FP_OVERRIDE'] = json.dumps(dict(FP_VALUES, mac='NEW-NIC', volume='NEW-DISK'))
        fingerprint.reset_cache()
        self.assertEqual(state.current(force=True).status, 'VALID')  # 2 changes tolerated
        os.environ['GTRADE_FP_OVERRIDE'] = json.dumps({k: 'OTHER-' + v for k, v in FP_VALUES.items()})
        fingerprint.reset_cache()
        v = state.current(force=True)
        self.assertEqual(v.status, 'GRACE')
        self.assertIn('another computer', v.message)
        LicenseState.objects.filter(pk=1).update(fp_mismatch_since=timezone.now() - dt.timedelta(days=15))
        self.assertTrue(state.current(force=True).read_only)

    def test_revocation_notice_then_read_only_and_old_crl_cannot_lift(self):
        self.install(make_license())
        service.apply_crl(make_crl([{'lic_id': 'L-TEST-1', 'reason': 'refund'}]))
        v = state.current(force=True)
        self.assertEqual(v.status, 'REVOKED')
        self.assertFalse(v.read_only)
        LicenseState.objects.filter(pk=1).update(revoked_at=timezone.now() - dt.timedelta(days=8))
        self.assertTrue(state.current(force=True).read_only)
        self.assertFalse(service.apply_crl(make_crl([], issued_at=timezone.now() - dt.timedelta(days=30))))
        self.assertTrue(state.current(force=True).read_only)


class LimitTests(LicensingBase):
    def test_named_user_limit(self):
        from apps.common.tenant_onboarding import OnboardingError, check_seat_available
        self.install(make_license(limits={'users': 2, 'companies': 1}))
        with self.assertRaises(OnboardingError):
            check_seat_available(self.tenant)   # owner + cashier already active

    def test_branch_limit_via_api(self):
        from apps.common import tenancy
        from apps.common.tenant_onboarding import ensure_tenant_defaults
        from apps.company.models import Branch
        with tenancy.use_tenant(self.tenant.pk):
            ensure_tenant_defaults(self.tenant, branch_name='Main', fresh=True)
            self.assertEqual(Branch.objects.filter(is_active=True).count(), 1)
        self.install(make_license(limits={'users': 9, 'companies': 1, 'branches_total': 9, 'branches_per_company': 1}))
        self.api.force_authenticate(self.admin)
        token = self._token()
        r = self.api.post('/api/company/branches/', {'name': 'Second', 'code': 'B2'}, format='json',
                          HTTP_AUTHORIZATION=f'Bearer {token}')
        self.assertEqual(r.status_code, 403, r.content)
        self.assertIn('licence allows 1 active branches per company', r.json()['detail'])
        with tenancy.use_tenant(self.tenant.pk):
            self.assertEqual(Branch.objects.count(), 1)

    def _token(self):
        from rest_framework_simplejwt.tokens import RefreshToken
        tok = RefreshToken.for_user(self.admin).access_token
        tok['tenant_id'] = self.tenant.pk
        return str(tok)

    def test_company_limit_and_modules_come_from_licence(self):
        from apps.common.models import Organization
        from apps.common.module_access import subscribed_modules
        self.install(make_license(limits={'users': 9, 'companies': 3}, modules=['sales', 'inventory']))
        org = Organization.objects.first()
        self.assertEqual(enforcement.company_limit(org, fallback=1), 3)
        self.assertEqual(sorted(subscribed_modules(self.tenant)), ['inventory', 'sales'])

    def test_update_entitlement(self):
        self.install(make_license(updates_until=(timezone.now() + dt.timedelta(days=30)).isoformat()))
        self.assertTrue(enforcement.update_allowed(timezone.now().isoformat())[0])
        ok, reason = enforcement.update_allowed((timezone.now() + dt.timedelta(days=90)).isoformat())
        self.assertFalse(ok)
        self.assertIn('keeps working', reason)

    def test_health_reports_license(self):
        self.install(make_license())
        body = self.client.get('/api/health/').json()
        self.assertEqual(body['edition'], 'local')
        self.assertEqual(body['license']['status'], 'VALID')
        self.assertNotIn('license_blob', json.dumps(body))


class OnlineActivationTests(LicensingBase):
    """Real HTTP round trip against the vendor service (dev key provider) on loopback."""

    def setUp(self):
        super().setUp()
        from wsgiref.simple_server import WSGIRequestHandler, make_server
        from gtrade_licensing.app import LicensingService
        from gtrade_licensing.keys import DevFileKeyProvider
        d = Path(tempfile.mkdtemp(prefix='gtrade-vendor-'))
        self.vendor = LicensingService(d, DevFileKeyProvider(d / 'k.pem', key_id='gtl-dev-svc'))
        pub = d / 'pub.json'
        self.vendor.keys.export_public(pub)

        class Quiet(WSGIRequestHandler):
            def log_message(self, *a):
                pass
        self.httpd = make_server('127.0.0.1', 0, self.vendor, handler_class=Quiet)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.httpd.server_port}'
        self.key, self.lic = self.vendor.store.create_key(customer='Sunrise', edition='ENTERPRISE', type_='subscription',
                                                          limits={'users': 10, 'companies': 2}, checkin_days=30,
                                                          valid_until=(timezone.now() + dt.timedelta(days=365)).isoformat())
        self.ovr = override_settings(GTRADE_LICENSE_SERVICE_URL=self.url, GTRADE_LICENSE_DEV_PUBKEYS=str(pub))
        self.ovr.enable()

    def tearDown(self):
        self.ovr.disable()
        self.httpd.shutdown()
        super().tearDown()

    def test_activate_checkin_revoke(self):
        v = service.activate(self.key, actor='test')
        self.assertEqual(v.status, 'VALID')
        self.assertEqual(v.edition, 'ENTERPRISE')
        self.assertEqual(service.checkin().status, 'VALID')
        self.vendor.store.update_key(self.lic, revoked_at=timezone.now().isoformat(), revoke_reason='chargeback')
        self.assertEqual(service.checkin().status, 'REVOKED')
        with self.assertRaises(service.LicenseServiceError):
            service.activate('GTZZ-AAAAA-BBBBB-CCCCC-DDDDD')

    def test_https_required_outside_dev_loopback(self):
        with override_settings(GTRADE_LICENSE_SERVICE_URL='http://licence.example.com'):
            with self.assertRaises(service.LicenseServiceError):
                service.activate(self.key)


class LocalEditionGuardTests(TestCase):
    def test_single_organization_per_installation(self):
        from apps.common.edition import LocalEditionGuardError
        from apps.common.models import Organization
        if not Organization.objects.exists():
            Organization.objects.create(name='First', code='first')
        with self.assertRaises(LocalEditionGuardError):
            Organization.objects.create(name='Second customer', code='second')

    def test_wipe_database_disabled(self):
        with self.assertRaises(CommandError):
            call_command('wipe_database', '--noinput')

    def test_create_admin_once_never_superuser(self):
        import io
        User = get_user_model()
        payload = json.dumps({'company_name': 'Sunrise Opticals', 'branch_name': 'MG Road', 'admin_username': 'owner2',
                              'admin_password': 'Sunrise-Strong-Pass-26', 'admin_full_name': 'Asha Rao'})
        old_stdin = sys.stdin
        try:
            sys.stdin = io.StringIO(json.dumps({'company_name': 'X', 'admin_username': 'u', 'admin_password': '123'}))
            with self.assertRaises(CommandError):
                call_command('local_create_admin', stdout=io.StringIO())
            sys.stdin = io.StringIO(payload)
            call_command('local_create_admin', stdout=io.StringIO())
            u = User.objects.get(username='owner2')
            self.assertEqual(u.role, 'SUPER_ADMIN')
            self.assertFalse(u.is_superuser)
            self.assertFalse(u.is_staff)
            from apps.common.models import Tenant
            self.assertEqual(Tenant.objects.get(pk=1).name, 'Sunrise Opticals')
            # The store profile and default branch print on every bill: they must carry the
            # customer's names, not the seed placeholders "Main Company" / "Head Office".
            from apps.common.tenancy import use_tenant
            from apps.company.models import Branch, Company
            with use_tenant(1):
                self.assertEqual(Company.objects.order_by('created_at').first().name, 'Sunrise Opticals')
                default = Branch.objects.get(is_default=True, is_active=True)
                self.assertEqual(default.name, 'MG Road')
                self.assertFalse(Company.objects.filter(name='Main Company').exists())
            sys.stdin = io.StringIO(payload.replace('owner2', 'owner3'))
            with self.assertRaises(CommandError):
                call_command('local_create_admin', stdout=io.StringIO())
        finally:
            sys.stdin = old_stdin

    def test_reset_password_on_server_pc(self):
        """gtrade-ctl reset-password: lost administrator password, recovered on the server PC only."""
        import io
        from apps.security.models import AuthSession, SecurityAuditLog
        User = get_user_model()
        admin = User.objects.create_user(username='owner9', password='Original-Strong-Pass-26', role='SUPER_ADMIN')
        AuthSession.objects.create(user=admin, username='owner9')
        old_stdin = sys.stdin
        try:
            out = io.StringIO()
            call_command('local_reset_password', '--list-admins', stdout=out)
            listed = json.loads(out.getvalue().strip().splitlines()[-1])
            self.assertIn('owner9', [a['username'] for a in listed['administrators']])
            self.assertNotIn('password', out.getvalue().lower().replace('"ok"', ''))

            for bad in ({'username': 'owner9', 'password': '123'}, {'username': 'nobody', 'password': 'Another-Strong-Pass-26'},
                        {'username': '', 'password': 'Another-Strong-Pass-26'}):
                sys.stdin = io.StringIO(json.dumps(bad))
                with self.assertRaises(CommandError):
                    call_command('local_reset_password', stdout=io.StringIO())
            admin.refresh_from_db()
            self.assertTrue(admin.check_password('Original-Strong-Pass-26'))

            sys.stdin = io.StringIO(json.dumps({'username': 'owner9', 'password': 'Recovered-Strong-Pass-26'}))
            out = io.StringIO()
            call_command('local_reset_password', stdout=out)
            result = json.loads(out.getvalue().strip().splitlines()[-1])
            self.assertEqual((result['ok'], result['sessions_ended']), (True, 1))
            admin.refresh_from_db()
            self.assertTrue(admin.check_password('Recovered-Strong-Pass-26'))
            self.assertEqual((admin.role, admin.is_active), ('SUPER_ADMIN', True))  # nothing else changed
            self.assertFalse(AuthSession.objects.filter(user=admin, ended_at__isnull=True).exists())
            self.assertTrue(SecurityAuditLog.objects.filter(event='PASSWORD_RESET_LOCAL', category='AUTH').exists())
            self.assertNotIn('Recovered-Strong-Pass-26', json.dumps(list(SecurityAuditLog.objects.values('summary', 'details'))))
        finally:
            sys.stdin = old_stdin

    def test_reset_password_refused_in_cloud_edition(self):
        with override_settings(GTRADE_EDITION='cloud'):
            with self.assertRaises(CommandError):
                call_command('local_reset_password', '--list-admins')
