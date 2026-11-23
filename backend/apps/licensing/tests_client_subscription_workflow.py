"""Windows Local: permanent platform-owner entitlement + customer subscriptions managed from
Client Management (2026-11-19 correction).

1  the owner installation is permanent / unlimited WITHOUT any manual step
2  ... and never shows an evaluation countdown (customers still do)
3  Monthly = one calendar month          4  Quarterly / Half-Yearly / Yearly durations
5  Lifetime never expires                6  generate from Client Management (client-centric API,
                                            Installation ID added later, edit client, overview)
7  customer activation with a production (non-dev) trusted key, offline; activation recorded
8  invalid signatures refused            9  wrong client / installation refused
10 expired customer becomes read-only    11 renewal for the same client and installation
12 customer data intact throughout

Production code paths only (release build, non-dev key id, DPAPI key file, trusted public key),
same harness as tests_local_vendor_workflow.py. Runs under config.settings_local.
"""

import datetime as dt
import json
import os
import unittest
from unittest import mock

from django.conf import settings

if 'apps.licensing' not in settings.INSTALLED_APPS:  # cloud settings: nothing to test here
    raise unittest.SkipTest('local edition only')

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey  # noqa: E402
from django.contrib.auth import get_user_model  # noqa: E402
from django.test import override_settings  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.common.models import Tenant  # noqa: E402
from apps.licensing import fingerprint, licfmt, state  # noqa: E402
from apps.licensing.models import LicenseState  # noqa: E402
from apps.licensing.tests_local_client_management import _NoNetwork  # noqa: E402
from apps.licensing.tests_local_vendor_workflow import (  # noqa: E402
    CUSTOMER_INSTALL, KEY_FILE, KEY_ID, LIC, OTHER_PC, VENDOR_INSTALL, LocalVendorBase,
)
from apps.vendor_licensing import tokens  # noqa: E402
from apps.vendor_licensing.models import ClientLicense, LicenseAuditEvent  # noqa: E402

BANNER_STATUSES = ('EVALUATION', 'GRACE', 'REVOKED', 'EXPIRED', 'EVALUATION_ENDED', 'INVALID', 'SUSPENDED')


@override_settings(GTRADE_INSTALL_ID=VENDOR_INSTALL, GTRADE_LICENSE_DEV_MODE=False, GTRADE_RELEASE_BUILD=True,
                   GTRADE_LICENSE_SIGNING_KEY_FILE=str(KEY_FILE), GTRADE_LICENSE_SIGNING_KEY_ID='',
                   GTRADE_LICENSE_SIGNING_KEY='', GTRADE_LICENSE_SERVICE_URL='')
class ClientSubscriptionWorkflowTests(LocalVendorBase):

    # ---- helpers ---------------------------------------------------------------------------------
    def new_client(self, plan_code, *, installation='', starts_on=None, name='CLEAR OPTICS'):
        """Client Management → Customers & Subscriptions → New client (client + subscription)."""
        body = {'plan_id': self.plans()[plan_code]['id'], 'installation': installation,
                'starts_on': (starts_on or timezone.localdate()).isoformat(),
                'client': {'name': name, 'owner_name': 'Asha', 'phone': '9876500000', 'country': 'IN'}}
        r = self.sa.post(f'{LIC}licences/', body, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        return r.json()

    def customer_request_code(self):
        r = self.customer_admin.post('/api/licensing/request/', {}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()['request_code']

    def overview_row(self, client_id):
        r = self.sa.get(f'{LIC}clients/overview/')
        self.assertEqual(r.status_code, 200, r.content)
        return next(row for row in r.json()['results'] if row['id'] == client_id)

    def brand(self, name, code):
        return self.customer_admin.post('/api/masters/brands/', {'name': name, 'code': code}, format='json')

    # ---- 1 + 2: owner -----------------------------------------------------------------------------
    def test_01_02_owner_installation_is_permanent_with_no_evaluation_countdown(self):
        LicenseState.objects.all().delete()  # a freshly installed / upgraded owner PC: no licence at all
        state.invalidate()
        self.assertEqual(state.evaluate(persist=False).status, 'EVALUATION')   # what the owner used to see
        with _NoNetwork():
            r = self.sa.get('/api/licensing/status/')                          # nothing pressed, nothing typed
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual((d['status'], d['read_only'], d['platform_owner'], d['lifetime']), ('VALID', False, True, True))
        self.assertIsNone(d['days_left'])
        self.assertIsNone(d['valid_until'])
        self.assertNotIn(d['status'], BANNER_STATUSES)                         # LicenseBanner stays hidden
        self.assertNotIn('evaluation', d['message'].lower())
        self.assertNotIn('days left', d['message'].lower())
        self.assertEqual(d['edition'], 'WINDOWS_LOCAL')
        self.assertEqual(d['plan']['name'], 'Platform Owner / Lifetime')
        self.assertEqual(set(d['unlimited']), {'clients', 'companies', 'branches_total', 'branches_per_company', 'users'})
        self.assertEqual(state.health_summary()['license']['status'], 'VALID')
        ev = LicenseAuditEvent.objects.filter(action='PLATFORM_OWNER_ISSUED').latest('created_at')
        self.assertTrue(ev.details['automatic'])
        self.assertEqual(ev.details['previous_status'], 'EVALUATION')
        # Long after the 30-day evaluation would have ended: still permanent.
        for days in (31, 400, 3650):
            v = state.evaluate(now=timezone.now() + dt.timedelta(days=days), persist=False)
            self.assertEqual((v.status, v.read_only, v.platform_owner, v.days_left), ('VALID', False, True, None))
        # Hardware change on the owner PC (fingerprint grace) -> refreshed automatically, never EXPIRED.
        new_pc = {n: f'replaced-{n}' for n in ('machine_guid', 'volume', 'bios_uuid', 'cpu', 'mac')}
        try:
            with mock.patch.dict(os.environ, {'GTRADE_FP_OVERRIDE': json.dumps(new_pc)}):
                fingerprint.reset_cache()
                self.assertEqual(state.evaluate(persist=False).status, 'GRACE')
                state.invalidate()
                v = state.current(force=True)
                self.assertEqual((v.status, v.platform_owner, v.read_only), ('VALID', True, False))
                self.assertEqual(state.evaluate(persist=False).status, 'VALID')
        finally:
            fingerprint.reset_cache()

    def test_02_customer_installations_still_count_down_and_end(self):
        # The automatic entitlement does not weaken customers: no vendor key = ordinary evaluation.
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        with _NoNetwork():
            d = self.customer_admin.get('/api/licensing/status/').json()
        self.assertEqual((d['status'], d['platform_owner']), ('EVALUATION', False))
        self.assertIn('days left', d['message'])
        self.assertFalse(LicenseAuditEvent.objects.filter(action='PLATFORM_OWNER_ISSUED',
                                                          details__install_id=CUSTOMER_INSTALL).exists())
        self.assertFalse(self.sa.get('/api/licensing/platform-owner/').json()['available'])
        later = timezone.now() + dt.timedelta(days=31)
        with mock.patch('django.utils.timezone.now', return_value=later):
            state.invalidate()
            v = state.current(force=True)
        self.assertEqual((v.status, v.read_only), ('EVALUATION_ENDED', True))

    # ---- 3 + 4 + 5: durations ---------------------------------------------------------------------
    def test_03_04_05_subscription_durations_are_calendar_based(self):
        for start, plan, expiry in [
            (dt.date(2026, 11, 19), 'local-monthly', dt.date(2026, 12, 19)),
            (dt.date(2026, 1, 31), 'local-monthly', dt.date(2026, 2, 28)),      # month end
            (dt.date(2026, 11, 19), 'local-quarterly', dt.date(2027, 2, 19)),
            (dt.date(2026, 11, 19), 'local-half-yearly', dt.date(2027, 5, 19)),
            (dt.date(2026, 11, 19), 'local-yearly', dt.date(2027, 11, 19)),
            (dt.date(2028, 2, 29), 'local-yearly', dt.date(2029, 2, 28)),       # leap day
        ]:
            r = self.sa.post(f'{LIC}preview/', {'plan_id': self.plans()[plan]['id'], 'starts_on': start.isoformat()},
                             format='json')
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual(r.json()['expires_on'], expiry.isoformat(), (plan, start))
        labels = {code: self.plans()[code] for code in ('local-monthly', 'local-quarterly', 'local-half-yearly',
                                                        'local-yearly', 'local-lifetime')}
        self.assertEqual(len(labels), 5)
        lifetime = self.sa.post(f'{LIC}preview/', {'plan_id': labels['local-lifetime']['id']}, format='json').json()
        self.assertTrue(lifetime['lifetime'])
        self.assertIsNone(lifetime['expires_on'])
        # Renewal status shown in Client Management (window scales with the plan length).
        from apps.vendor_licensing.service import renewal_status
        today = dt.date(2026, 11, 19)
        for cycle, duration, days_left, expected in [
            ('MONTHLY', 1, 20, 'OK'), ('MONTHLY', 1, 7, 'DUE'), ('MONTHLY', 3, 15, 'DUE'), ('MONTHLY', 3, 16, 'OK'),
            ('YEARLY', 1, 30, 'DUE'), ('YEARLY', 1, 0, 'DUE'), ('YEARLY', 1, -1, 'OVERDUE'),
        ]:
            lic = ClientLicense(billing_cycle=cycle, duration=duration, status='ACTIVE',
                                expires_on=today + dt.timedelta(days=days_left))
            self.assertEqual(renewal_status(lic, today), expected, (cycle, duration, days_left))
        self.assertEqual(renewal_status(ClientLicense(billing_cycle='LIFETIME', duration=1, status='ACTIVE'), today),
                         'NOT_REQUIRED')
        self.assertEqual(renewal_status(None), 'NONE')

    def test_03_monthly_customer_expires_after_one_calendar_month(self):
        today = timezone.localdate()
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        code = self.customer_request_code()
        self.as_installation(VENDOR_INSTALL)
        lic = self.new_client('local-monthly', installation=code)
        self.assertEqual(lic['subscription'], 'Monthly')
        expires = tokens.add_months(today, 1)
        self.assertEqual(lic['expires_on'], expires.isoformat())
        self.as_installation(CUSTOMER_INSTALL)
        with _NoNetwork():
            self.assertEqual(self.activate(lic['key']).status_code, 200)
        noon = dt.datetime.combine(expires, dt.time(12), tzinfo=dt.timezone.utc)
        self.assertEqual(state.evaluate(now=noon, persist=False).status, 'VALID')            # the expiry day itself
        self.assertEqual(state.evaluate(now=noon + dt.timedelta(days=2), persist=False).status, 'EXPIRED')

    def test_04_05_quarterly_half_yearly_yearly_and_lifetime_activate_with_their_terms(self):
        today = timezone.localdate()
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        code = self.customer_request_code()
        self.as_installation(VENDOR_INSTALL)
        first = self.new_client('local-quarterly', installation=code)
        client_id = first['client']['id']
        cases = [(first, 3, 'Quarterly')]
        for plan, months, label in (('local-half-yearly', 6, 'Half-Yearly'), ('local-yearly', 12, 'Yearly')):
            r = self.sa.post(f'{LIC}licences/', {'plan_id': self.plans()[plan]['id'], 'client_id': client_id,
                                                 'installation': code}, format='json')
            self.assertEqual(r.status_code, 201, r.content)
            cases.append((r.json(), months, label))
        r = self.sa.post(f'{LIC}licences/', {'plan_id': self.plans()['local-lifetime']['id'], 'client_id': client_id,
                                             'installation': code}, format='json')
        lifetime = r.json()
        for lic, months, label in cases:
            self.assertEqual((lic['subscription'], lic['expires_on']), (label, tokens.add_months(today, months).isoformat()))
            self.as_installation(CUSTOMER_INSTALL)
            with _NoNetwork():
                d = self.activate(lic['key']).json()
            self.assertEqual((d['status'], d['expires_on']), ('VALID', lic['expires_on']), label)
            self.as_installation(VENDOR_INSTALL)
        self.assertEqual((lifetime['subscription'], lifetime['lifetime'], lifetime['expires_on']), ('Lifetime', True, None))
        self.assertEqual(lifetime['renewal_status'], 'NOT_REQUIRED')
        self.as_installation(CUSTOMER_INSTALL)
        with _NoNetwork():
            d = self.activate(lifetime['key']).json()
        self.assertEqual((d['status'], d['lifetime'], d['valid_until'], d['days_left']), ('VALID', True, None, None))
        for years in (2, 30):
            v = state.evaluate(now=timezone.now() + dt.timedelta(days=365 * years), persist=False)
            self.assertEqual((v.status, v.read_only), ('VALID', False))

    # ---- 6: generate from Client Management ---------------------------------------------------------
    def test_06_client_management_creates_client_binds_installation_later_and_tracks_it(self):
        with _NoNetwork():
            created = self.new_client('local-monthly')                           # no Installation ID yet
        self.assertFalse(created['key_available'])
        self.assertNotIn('key', created)                                         # an unusable key is never handed out
        self.assertEqual(created['activation_status'], 'NOT_ACTIVATED')
        lic_id, cid = created['id'], created['client']['id']
        r = self.sa.post(f'{LIC}licences/{lic_id}/key/', {}, format='json')
        self.assertEqual((r.status_code, r.json()['code']), (400, 'awaiting_installation'))
        row = self.overview_row(cid)
        self.assertEqual((row['name'], row['licence']['subscription'], row['licence']['effective_status'],
                          row['licence']['activation_status'], row['renewal_status']),
                         ('CLEAR OPTICS', 'Monthly', 'ACTIVE', 'NOT_ACTIVATED', 'OK'))
        for field in ('issued_at', 'expires_on', 'install_id', 'lic_id'):
            self.assertIn(field, row['licence'])
        # Edit the client in Client Management (identity = client code; keys stay valid).
        r = self.sa.patch(f'{LIC}clients/{cid}/', {'name': 'Clear Optics Pvt Ltd', 'phone': '9000000001'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['name'], r.json()['phone'], r.json()['client_code']),
                         ('Clear Optics Pvt Ltd', '9000000001', created['client']['client_code']))
        self.assertEqual(self.sa.patch(f'{LIC}clients/{cid}/', {'name': '  '}, format='json').status_code, 400)
        # The customer installs, copies its installation request code; the vendor binds it.
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        code = self.customer_request_code()
        self.as_installation(VENDOR_INSTALL)
        with _NoNetwork():
            bound = self.sa.post(f'{LIC}licences/{lic_id}/bind/', {'installation': code}, format='json')
        self.assertEqual(bound.status_code, 200, bound.content)
        b = bound.json()
        self.assertEqual((b['install_id'], b['activation_status'], b['key_available'], b['revision']),
                         (CUSTOMER_INSTALL, 'BOUND', True, 2))
        self.assertTrue(b['hardware_bound'])
        p = licfmt.decode_unverified(b['key'])
        self.assertEqual((p['install_id'], p['binding'], p['client']['id'], p['client']['name']),
                         (CUSTOMER_INSTALL, 'INSTALLATION', created['client']['client_code'], 'Clear Optics Pvt Ltd'))
        self.assertEqual(self.sa.post(f'{LIC}licences/{lic_id}/key/', {}, format='json').json()['key'], b['key'])
        # Binding again to another PC is refused (moving needs a replacement key that voids the old one).
        r = self.sa.post(f'{LIC}licences/{lic_id}/bind/', {'installation': OTHER_PC}, format='json')
        self.assertEqual((r.status_code, r.json()['code']), (400, 'bound_elsewhere'))
        detail = self.sa.get(f'{LIC}clients/{cid}/').json()
        self.assertEqual([lic['lic_id'] for lic in detail['licences']], [created['lic_id']])
        self.assertTrue(LicenseAuditEvent.objects.filter(action='INSTALLATION_BOUND').exists())
        self.assertTrue(LicenseAuditEvent.objects.filter(action='CLIENT_UPDATED').exists())
        # The customer activates offline and sends the confirmation code back.
        self.as_installation(CUSTOMER_INSTALL)
        with _NoNetwork():
            act = self.activate(b['key'])
        self.assertEqual(act.status_code, 200, act.content)
        confirmation = self.customer_admin.get('/api/licensing/status/').json()['activation_confirmation']
        self.assertTrue(confirmation.startswith('GTA1.'))
        self.as_installation(VENDOR_INSTALL)
        r = self.sa.post(f'{LIC}licences/{lic_id}/record-activation/', {'code': confirmation}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(r.json()['activation_status'], 'ACTIVATED')
        self.assertEqual(self.overview_row(cid)['licence']['activation_status'], 'ACTIVATED')
        # Filters used by the Client Management table.
        self.assertEqual(self.sa.get(f'{LIC}clients/overview/', {'renewal': 'OVERDUE'}).json()['count'], 0)
        self.assertEqual(self.sa.get(f'{LIC}clients/overview/', {'search': CUSTOMER_INSTALL[:8]}).json()['count'], 1)
        # Only the Local Super Admin manages clients.
        self.assertEqual(self.customer_admin.get(f'{LIC}clients/overview/').status_code, 403)

    # ---- 7 + 8 + 9: activation, signatures, binding -------------------------------------------------
    def test_07_08_09_production_key_activation_and_refusals(self):
        self.assertFalse(KEY_ID.startswith('gtl-dev-'))
        self.assertTrue(settings.GTRADE_RELEASE_BUILD)
        lic = self.new_client('local-monthly', installation=CUSTOMER_INSTALL)
        other_pc = self.new_client('local-monthly', installation=OTHER_PC, name='ELSEWHERE OPTICS')
        second_client = self.new_client('local-monthly', installation=CUSTOMER_INSTALL, name='ANOTHER CLIENT')
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        key = lic['key']
        # 8: tampered payload, and a key signed by a different private key under the trusted key id.
        head, body, sig = key.split('.')
        payload = json.loads(licfmt.b64u_decode(body))
        payload['expires_on'] = '2099-12-31'
        tampered = f'{head}.{licfmt.b64u_encode(json.dumps(payload).encode())}.{sig}'
        forged = licfmt.encode({**licfmt.decode_unverified(key)}, 'GTL1', Ed25519PrivateKey.generate().sign)
        bad_sig = f'{head}.{body}.{licfmt.b64u_encode(b"x" * 64)}'
        with _NoNetwork():
            for bad in (tampered, forged, bad_sig):
                r = self.activate(bad)
                self.assertEqual(r.status_code, 400, r.content)
                self.assertIn('signature', r.json()['error'])
            # 9: a key bound to another installation.
            r = self.activate(other_pc['key'])
            self.assertEqual(r.status_code, 400)
            self.assertIn('another installation', r.json()['error'])
            # 7: the right key activates offline with the embedded (production) public key.
            r = self.activate('  ' + key[:50] + '\n' + key[50:] + '  ')
        self.assertEqual(r.status_code, 200, r.content)
        d = r.json()
        self.assertEqual((d['status'], d['development'], d['client']['id'], d['install_id']),
                         ('VALID', False, lic['client']['client_code'], CUSTOMER_INSTALL))
        # 9: a valid key of ANOTHER client for this very installation is refused.
        with _NoNetwork():
            r = self.activate(second_client['key'])
        self.assertEqual(r.status_code, 400)
        self.assertIn('different client', r.json()['error'])
        self.assertEqual(state.current(force=True).lic_id, lic['lic_id'])
        # The vendor rejects a confirmation code that belongs to another licence.
        code = self.customer_admin.get('/api/licensing/status/').json()['activation_confirmation']
        self.as_installation(VENDOR_INSTALL)
        r = self.sa.post(f'{LIC}licences/{second_client["id"]}/record-activation/', {'code': code}, format='json')
        self.assertEqual(r.status_code, 400)
        self.assertIn('not', r.json()['detail'])

    # ---- 10 + 11 + 12: expiry, renewal, data -------------------------------------------------------
    def test_10_11_12_expired_customer_read_only_renewed_same_installation_data_intact(self):
        start = timezone.localdate()
        lic = self.new_client('local-monthly', installation=CUSTOMER_INSTALL, starts_on=start)
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        with _NoNetwork():
            self.assertEqual(self.activate(lic['key']).status_code, 200)
        self.assertIn(self.brand('Customer Brand A', 'CBA1').status_code, (200, 201))
        users = get_user_model().objects.filter(is_active=True).count()
        expires = tokens.add_months(start, 1)
        after = timezone.now() + dt.timedelta(days=(expires - start).days + 2)
        with mock.patch('django.utils.timezone.now', return_value=after):
            state.invalidate()
            v = state.current(force=True)
            self.assertEqual((v.status, v.read_only), ('EXPIRED', True))
            self.assertEqual(self.brand('Blocked', 'BLK9').status_code, 402)                 # 10: read-only
            listing = self.customer_admin.get('/api/masters/brands/')
            self.assertEqual(listing.status_code, 200)
            self.assertIn('Customer Brand A', json.dumps(listing.json()))
            # 11: the vendor sees it overdue in Client Management and renews it.
            self.as_installation(VENDOR_INSTALL)
            row = self.overview_row(lic['client']['id'])
            self.assertEqual((row['licence']['effective_status'], row['renewal_status']), ('EXPIRED', 'OVERDUE'))
            r = self.sa.post(f'{LIC}licences/{lic["id"]}/renew/', {'periods': 1, 'confirm': True}, format='json')
            self.assertEqual(r.status_code, 200, r.content)
            renewed = r.json()
            self.assertEqual((renewed['lic_id'], renewed['install_id'], renewed['client']['client_code'], renewed['revision']),
                             (lic['lic_id'], CUSTOMER_INSTALL, lic['client']['client_code'], 2))
            self.assertEqual(renewed['expires_on'], tokens.add_months(timezone.localdate(after), 1).isoformat())
            self.assertEqual(self.overview_row(lic['client']['id'])['renewal_status'], 'OK')
            self.as_installation(CUSTOMER_INSTALL)
            with _NoNetwork():
                r = self.activate(renewed['key'])
            self.assertEqual(r.status_code, 200, r.content)
            d = r.json()
            self.assertEqual((d['status'], d['read_only'], d['lic_id'], d['revision'], d['install_id']),
                             ('VALID', False, lic['lic_id'], 2, CUSTOMER_INSTALL))
            self.assertIn(self.brand('Customer Brand B', 'CBB1').status_code, (200, 201))
            # 12: nothing was lost or deactivated at any point.
            names = json.dumps(self.customer_admin.get('/api/masters/brands/').json())
            self.assertIn('Customer Brand A', names)
            self.assertIn('Customer Brand B', names)
            self.assertEqual(get_user_model().objects.filter(is_active=True).count(), users)
            self.assertTrue(Tenant.objects.get(pk=1).is_active)
            self.assertEqual(LicenseState.load().client_id, lic['client']['client_code'])
            # The old revision cannot be re-installed.
            self.assertEqual(self.activate(lic['key']).status_code, 400)
        self.assertEqual(ClientLicense.objects.get(lic_id=lic['lic_id']).issuances.count(), 2)


@override_settings(GTRADE_INSTALL_ID=VENDOR_INSTALL, GTRADE_LICENSE_DEV_MODE=False, GTRADE_RELEASE_BUILD=True,
                   GTRADE_LICENSE_SIGNING_KEY_FILE=str(KEY_FILE), GTRADE_LICENSE_SIGNING_KEY_ID='',
                   GTRADE_LICENSE_SIGNING_KEY='', GTRADE_LICENSE_SERVICE_URL='')
class CurrentSubscriptionSelectionTests(LocalVendorBase):
    """Regression (2026-11-19): Client Management showed the NEWEST-CREATED licence as the client's
    current subscription, so a later backdated / expired licence hid an active one. The current
    licence is now chosen by validity dates and status (vendor_licensing.service.current_licence)."""

    def setUp(self):
        super().setUp()
        self.today = timezone.localdate()
        self.cid = None

    def lic(self, plan, start_offset_days=0, name='SELECTION OPTICS'):
        body = {'plan_id': self.plans()[plan]['id'], 'installation': CUSTOMER_INSTALL,
                'starts_on': (self.today + dt.timedelta(days=start_offset_days)).isoformat()}
        body.update({'client_id': self.cid} if self.cid else {'client': {'name': name}})
        r = self.sa.post(f'{LIC}licences/', body, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        self.cid = r.json()['client']['id']
        return r.json()

    def row(self):
        r = self.sa.get(f'{LIC}clients/overview/')
        self.assertEqual(r.status_code, 200, r.content)
        return next(x for x in r.json()['results'] if x['id'] == self.cid)

    def current(self):
        row = self.row()
        detail = self.sa.get(f'{LIC}clients/{self.cid}/').json()
        self.assertEqual(detail['current_licence_id'], row['current_licence_id'])
        return row['licence']['lic_id'], row['licence']['effective_status'], row['renewal_status']

    def snapshot(self):
        return list(ClientLicense.objects.filter(client_id=self.cid).order_by('lic_id').values(
            'lic_id', 'revision', 'status', 'starts_on', 'expires_on', 'key_hash', 'install_id', 'updated_at'))

    def test_active_licence_beats_a_newer_backdated_expired_one(self):
        active = self.lic('local-monthly')
        backdated = self.lic('local-monthly', -70)                 # created later, expired long ago
        self.assertEqual(self.current(), (active['lic_id'], 'ACTIVE', 'OK'))
        self.assertNotEqual(backdated['lic_id'], active['lic_id'])

    def test_no_active_licence_shows_the_latest_expired_as_overdue(self):
        older = self.lic('local-monthly', -100)
        newest_ending = self.lic('local-monthly', -40)
        self.lic('local-monthly', -70)                              # created last, ended in between
        self.assertNotEqual(older['lic_id'], newest_ending['lic_id'])
        self.assertEqual(self.current(), (newest_ending['lic_id'], 'EXPIRED', 'OVERDUE'))

    def test_expired_plus_future_dated_licence_shows_the_upcoming_one(self):
        self.lic('local-monthly', -40)
        later = self.lic('local-quarterly', 20)
        first = self.lic('local-monthly', 5)                         # starts sooner
        self.assertNotEqual(later['lic_id'], first['lic_id'])
        self.assertEqual(self.current(), (first['lic_id'], 'PENDING', 'UPCOMING'))

    def test_active_due_licence_with_a_future_dated_next_one_is_renewed(self):
        due = self.lic('local-monthly', -27)                         # ends in ~3 days: renewal due
        self.assertEqual(self.current(), (due['lic_id'], 'ACTIVE', 'DUE'))
        self.lic('local-monthly', 3)                                  # next subscription issued
        self.assertEqual(self.current(), (due['lic_id'], 'ACTIVE', 'RENEWED'))

    def test_lifetime_licence_is_current_over_a_newer_subscription(self):
        lifetime = self.lic('local-lifetime', -400)
        self.lic('local-yearly')
        self.assertEqual(self.current(), (lifetime['lic_id'], 'ACTIVE', 'NOT_REQUIRED'))

    def test_renewed_in_place_licence_becomes_current_again(self):
        expired = self.lic('local-monthly', -70)
        self.lic('local-monthly', -100)
        self.assertEqual(self.current(), (expired['lic_id'], 'EXPIRED', 'OVERDUE'))
        r = self.sa.post(f'{LIC}licences/{expired["id"]}/renew/', {'periods': 1, 'confirm': True}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.current(), (expired['lic_id'], 'ACTIVE', 'OK'))

    def test_suspended_and_revoked_licences(self):
        a = self.lic('local-monthly')
        self.lic('local-monthly', -70)
        r = self.sa.post(f'{LIC}licences/{a["id"]}/suspend/', {'reason': 'payment pending'}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual(self.current(), (a['lic_id'], 'SUSPENDED', 'SUSPENDED'))   # blocks the customer now
        r = self.sa.post(f'{LIC}licences/{a["id"]}/revoke/', {'reason': 'closed', 'confirm_lic_id': a['lic_id']},
                         format='json')
        self.assertEqual(r.status_code, 200, r.content)
        lic_id, status, renewal = self.current()                        # the expired one outranks a revoked one
        self.assertEqual((status, renewal), ('EXPIRED', 'OVERDUE'))
        self.assertNotEqual(lic_id, a['lic_id'])

    def test_only_revoked_licence_is_closed(self):
        a = self.lic('local-yearly')
        self.sa.post(f'{LIC}licences/{a["id"]}/revoke/', {'reason': 'closed', 'confirm_lic_id': a['lic_id']}, format='json')
        self.assertEqual(self.current(), (a['lic_id'], 'REVOKED', 'CLOSED'))

    def test_selection_never_changes_licence_records(self):
        self.lic('local-monthly')
        self.lic('local-monthly', -70)
        self.lic('local-quarterly', 15)
        self.lic('local-lifetime', -10)
        before = self.snapshot()
        for _ in range(3):
            self.current()
            self.sa.get(f'{LIC}clients/overview/', {'renewal': 'OVERDUE'})
        self.assertEqual(self.snapshot(), before)
