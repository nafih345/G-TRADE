"""Windows edition: activating licences issued by the vendor console (payload v2).

The tokens are built with the vendor's own payload code (apps/vendor_licensing/tokens.py) and the
shared wire format, signed with a throwaway development key, then pasted / imported through the
real API: signature, client, edition, status, dates and installation binding, the online first
activation, check-in status updates, the per-revision CRL, explicit unlimited limits and the
evaluation period. Runs under config.settings_local (windows/tests/run_local_django_tests.py)."""

import base64
import datetime as dt
import json
import threading
import unittest

from django.conf import settings

if 'apps.licensing' not in settings.INSTALLED_APPS:  # cloud settings: nothing to test here
    raise unittest.SkipTest('licensing is part of the Windows local edition only')

from django.contrib.auth import get_user_model  # noqa: E402
from django.test import override_settings  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.licensing import enforcement, licfmt, service, state  # noqa: E402
from apps.licensing.models import LicenseState  # noqa: E402
from apps.licensing.tests import _DEV_KEY, _OTHER_KEY, INSTALL_ID, LicensingBase, fp_hashes  # noqa: E402
from apps.vendor_licensing import tokens  # noqa: E402  (pure module: the vendor's payload builder)

MODULES = ['optical', 'sales', 'inventory', 'purchase', 'accounts', 'admin', 'reports', 'settings']


def vendor_key(*, lic_id='GOL-2026-AAAA0001', rev=1, client_id='CL-000001', client_name='Sunrise Opticals',
               edition='WINDOWS_LOCAL', cycle='YEARLY', starts_on=None, expires_on='auto', status='ACTIVE',
               install_id=INSTALL_ID, fp=None, limits=None, modules=MODULES, settings_features=None,
               issued_at=None, key=_DEV_KEY, key_id='gtl-dev-test', plan_name='Windows Pro Yearly'):
    today = timezone.localdate()
    starts_on = starts_on or today
    if expires_on == 'auto':
        expires_on = tokens.compute_expiry(cycle, 1, starts_on)
    payload = tokens.build_payload(
        lic_id=lic_id, rev=rev, issued_at=issued_at or timezone.now(), client_id=client_id, client_name=client_name,
        edition=edition, plan_code='win-pro', plan_name=plan_name, cycle=cycle, duration=1, starts_on=starts_on,
        expires_on=expires_on, limits=limits or {'clients': 0, 'companies': 2, 'branches': 3, 'users': 5},
        modules=modules, settings_features=settings_features, status=status, status_reason='Unpaid' if status != 'ACTIVE' else '',
        install_id=install_id, fp_hashes=fp)
    return licfmt.encode({**payload, 'key_id': key_id}, 'GTL1', key.sign)


class VendorKeyActivationTests(LicensingBase):
    def activate(self, key, user=None):
        self.api.force_authenticate(user or self.admin)
        return self.api.post('/api/licensing/activate/', {'key': key}, format='json')

    def test_copy_paste_activation_shows_plan_limits_and_modules(self):
        key = vendor_key(limits={'clients': 1, 'companies': 2, 'branches': 3, 'users': None})
        # E-mail / chat clients wrap long keys: the pasted key may contain line breaks and spaces.
        pasted = '\n'.join(key[i:i + 70] for i in range(0, len(key), 70)) + '  '
        r = self.activate(pasted)
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual(d['status'], 'VALID')
        self.assertEqual(d['plan']['name'], 'Windows Pro Yearly')
        self.assertEqual(d['plan']['cycle'], 'YEARLY')
        self.assertEqual(d['edition'], 'WINDOWS_LOCAL')
        self.assertEqual(d['client']['id'], 'CL-000001')
        self.assertEqual(d['lic_id'], 'GOL-2026-AAAA0001')
        self.assertIn(d['days_left'], (364, 365, 366))  # 1 calendar year: to the same date
        self.assertEqual(d['limits']['companies'], 2)
        self.assertIn('users', d['unlimited'])
        self.assertEqual(d['modules'], MODULES)
        self.assertEqual(LicenseState.load().client_id, 'CL-000001')
        # Unlimited users really are unlimited; the branch cap still applies.
        enforcement.check_users(self.tenant, adding=500)

    def test_lifetime_licence_never_expires(self):
        r = self.activate(vendor_key(cycle='LIFETIME', expires_on=None))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertTrue(r.json()['lifetime'])
        self.assertIsNone(r.json()['days_left'])
        self.assertIsNone(r.json()['valid_until'])
        later = state.evaluate(now=timezone.now() + dt.timedelta(days=3650), persist=False)
        self.assertEqual(later.status, 'VALID')

    def test_licence_file_uses_the_same_rules(self):
        self.api.force_authenticate(self.admin)
        r = self.api.post('/api/licensing/import/', {'license': vendor_key()}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['status'], 'VALID')
        bad = vendor_key(install_id='0f0f0f0f-other-4222-8333-444455556666', lic_id='GOL-2026-BBBB0001')
        for endpoint, field in (('/api/licensing/import/', 'license'), ('/api/licensing/activate/', 'key')):
            r = self.api.post(endpoint, {field: bad}, format='json')
            self.assertEqual(r.status_code, 400)
            self.assertIn('bound to another installation', r.json()['error'])

    def test_clear_errors_and_nothing_installed(self):
        head, body, sig = vendor_key().split('.')
        p = json.loads(licfmt.b64u_decode(body))
        p['limits']['users'] = 999
        tampered = f'{head}.{licfmt.b64u_encode(json.dumps(p).encode())}.{sig}'
        yesterday = timezone.localdate() - dt.timedelta(days=1)
        cases = {
            'signature is not valid': tampered,
            'unknown key': vendor_key(key_id='gtl-dev-unknown'),
            'not valid (file altered': vendor_key(key=_OTHER_KEY),
            'Cloud Edition licence': vendor_key(edition='CLOUD', install_id=''),
            # The expiry day lasts until it ends in the latest time zone (UTC-12): two days ago is over.
            'expired on': vendor_key(cycle='MONTHLY', starts_on=yesterday - dt.timedelta(days=60),
                                     expires_on=yesterday - dt.timedelta(days=1)),
            'suspended by your vendor': vendor_key(status='SUSPENDED'),
            'revoked by your vendor': vendor_key(status='REVOKED'),
            'starts on': vendor_key(starts_on=timezone.localdate() + dt.timedelta(days=10)),
            'bound to another installation': vendor_key(install_id='0f0f0f0f-aaaa-4222-8333-444455556666'),
            'not a G OPTICALS licence': 'hello world',
        }
        for expected, key in cases.items():
            r = self.activate(key)
            self.assertEqual(r.status_code, 400, (expected, r.content))
            self.assertIn(expected.lower(), r.json()['error'].lower(), expected)
        self.assertEqual(state.current(force=True).status, 'EVALUATION', 'nothing was installed')

    def test_unbound_key_offline_explains_installation_id(self):
        r = self.activate(vendor_key(install_id=''))
        self.assertEqual(r.status_code, 502)
        self.assertIn('activated online once', r.json()['error'])
        self.assertIn(INSTALL_ID, r.json()['error'])
        self.assertEqual(state.current(force=True).status, 'EVALUATION')

    def test_client_identity_and_replay(self):
        self.assertEqual(self.activate(vendor_key(rev=2)).status_code, 200)
        r = self.activate(vendor_key(rev=1, issued_at=timezone.now() - dt.timedelta(minutes=5)))
        self.assertEqual(r.status_code, 400)
        self.assertIn('older', r.json()['error'])
        r = self.activate(vendor_key(lic_id='GOL-2026-CCCC0001', client_id='CL-000099', client_name='Another Shop'))
        self.assertEqual(r.status_code, 400)
        self.assertIn('different client', r.json()['error'])
        # A renewal of the same client (new revision) is accepted.
        r = self.activate(vendor_key(rev=3, expires_on=timezone.localdate() + dt.timedelta(days=700)))
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['revision'], 3)

    def test_only_installation_admins_activate(self):
        r = self.activate(vendor_key(), user=self.cashier)
        self.assertEqual(r.status_code, 403)
        self.api.force_authenticate(self.cashier)
        self.assertEqual(self.api.get('/api/licensing/status/').status_code, 200)

    def test_suspension_via_checkin_is_read_only_until_reactivated(self):
        self.assertEqual(self.activate(vendor_key(rev=1)).status_code, 200)
        service.install_blob(vendor_key(rev=2, status='SUSPENDED'), source='checkin')
        v = state.current(force=True)
        self.assertEqual(v.status, 'SUSPENDED')
        self.assertTrue(v.read_only)
        self.assertIn('suspended by your vendor', v.message)
        self.api.force_authenticate(self.admin)
        self.assertEqual(self.api.post('/api/masters/brands/', {'name': 'X'}, format='json').status_code, 402)
        self.assertNotEqual(self.api.get('/api/masters/brands/').status_code, 402)
        # The older ACTIVE key cannot be re-pasted to escape the suspension.
        self.assertEqual(self.activate(vendor_key(rev=1)).status_code, 400)
        service.install_blob(vendor_key(rev=3), source='checkin')
        self.assertEqual(state.current(force=True).status, 'VALID')

    def test_crl_voids_only_revisions_before_a_move(self):
        self.activate(vendor_key(rev=2))
        crl = licfmt.encode({'key_id': 'gtl-dev-test', 'issued_at': timezone.now().isoformat(),
                             'revoked': [{'lic_id': 'GOL-2026-AAAA0001', 'below_rev': 2, 'reason': 'moved'}]},
                            'GTC1', _DEV_KEY.sign)
        service.apply_crl(crl)
        self.assertEqual(state.current(force=True).status, 'VALID', 'revision 2 is the current one')
        crl = licfmt.encode({'key_id': 'gtl-dev-test', 'issued_at': (timezone.now() + dt.timedelta(seconds=5)).isoformat(),
                             'revoked': [{'lic_id': 'GOL-2026-AAAA0001', 'below_rev': 3, 'reason': 'moved'}]},
                            'GTC1', _DEV_KEY.sign)
        service.apply_crl(crl)
        self.assertEqual(state.current(force=True).status, 'REVOKED')

    def test_zero_clients_means_none_and_settings_sections_follow_the_licence(self):
        self.activate(vendor_key(settings_features=['store']))
        with self.assertRaises(enforcement.LicenseLimitError):
            enforcement.check_clients()
        self.assertEqual(enforcement.client_summary()['clients_limit'], 0)
        from apps.common.module_access import tenant_access_config
        self.assertEqual(tenant_access_config(1)['settings_features'], ['store'])

    def test_installation_request_code_round_trips_to_the_vendor(self):
        self.api.force_authenticate(self.admin)
        r = self.api.post('/api/licensing/request/', {}, format='json')
        self.assertEqual(r.status_code, 200)
        parsed = tokens.parse_installation(r.json()['request_code'])
        self.assertEqual(parsed['install_id'], INSTALL_ID)
        self.assertEqual(parsed['fp'], fp_hashes())
        # A key bound with that code (install + machine) activates offline.
        r = self.activate(vendor_key(fp=parsed['fp']))
        self.assertEqual(r.status_code, 200, r.content)


class EvaluationCompatibilityTests(LicensingBase):
    def test_existing_evaluation_installation_activates_and_is_never_made_lifetime(self):
        self.set_installed_days_ago(10)
        v = state.current(force=True)
        self.assertEqual(v.status, 'EVALUATION')
        self.assertFalse(v.lifetime)
        self.set_installed_days_ago(45)
        v = state.current(force=True)
        self.assertEqual(v.status, 'EVALUATION_ENDED')
        self.assertTrue(v.read_only)
        self.assertFalse(v.lifetime)
        self.api.force_authenticate(self.admin)
        r = self.api.post('/api/licensing/activate/', {'key': vendor_key()}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['status'], 'VALID')
        self.assertFalse(r.json()['read_only'])


class OnlineFirstActivationTests(LicensingBase):
    """A key issued before the vendor knew the installation is bound by one online call. The stub
    answers like the vendor authority (apps/vendor_licensing/service.activate_online): it signs the
    licence again for the calling installation, and refuses a second one."""

    def setUp(self):
        super().setUp()
        from wsgiref.simple_server import WSGIRequestHandler, make_server
        bound = {}

        def app(environ, start_response):
            body = json.loads(environ['wsgi.input'].read(int(environ.get('CONTENT_LENGTH') or 0)) or b'{}')
            path = environ['PATH_INFO']
            code, out = 404, {'error': 'not found'}
            if path == '/v1/activate':
                p = licfmt.verify(body['key'], 'GTL1', {'gtl-dev-test': base64.b64encode(_DEV_KEY.public_key().public_bytes(
                    *_raw())).decode()})
                if bound.get(p['lic_id']) not in (None, body['install_id']):
                    code, out = 409, {'error': 'already bound to another installation'}
                else:
                    bound[p['lic_id']] = body['install_id']
                    code, out = 200, {'license': vendor_key(rev=2, install_id=body['install_id'],
                                                            fp=body['fp']['hashes'])}
            data = json.dumps(out).encode()
            start_response(f'{code} X', [('Content-Type', 'application/json'), ('Content-Length', str(len(data)))])
            return [data]

        class Quiet(WSGIRequestHandler):
            def log_message(self, *a):
                pass
        self.httpd = make_server('127.0.0.1', 0, app, handler_class=Quiet)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.ovr = override_settings(GTRADE_LICENSE_SERVICE_URL=f'http://127.0.0.1:{self.httpd.server_port}')
        self.ovr.enable()
        self.bound = bound

    def tearDown(self):
        self.ovr.disable()
        self.httpd.shutdown()
        super().tearDown()

    def test_first_activation_binds_this_installation(self):
        self.api.force_authenticate(self.admin)
        # Already bound to another installation at the vendor: refused with the reason, nothing installed.
        self.bound['GOL-2026-AAAA0001'] = 'someone-else'
        r = self.api.post('/api/licensing/activate/', {'key': vendor_key(install_id='')}, format='json')
        self.assertEqual(r.status_code, 502)
        self.assertIn('another installation', r.json()['error'])
        self.assertEqual(state.current(force=True).status, 'EVALUATION')
        del self.bound['GOL-2026-AAAA0001']
        r = self.api.post('/api/licensing/activate/', {'key': vendor_key(install_id='')}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['status'], 'VALID')
        self.assertEqual(r.json()['binding'], 'INSTALLATION')
        self.assertEqual(self.bound['GOL-2026-AAAA0001'], INSTALL_ID)


def _raw():
    from cryptography.hazmat.primitives import serialization
    return serialization.Encoding.Raw, serialization.PublicFormat.Raw

