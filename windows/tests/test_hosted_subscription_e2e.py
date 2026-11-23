"""Hosted Workspaces → New client with a Subscription, end to end, on TWO REAL staged installations
(vendor PC + customer PC with no internet), using the release build exactly as staged.

Vendor PC: real `gtrade-ctl vendor-key generate`, permanent owner licence (automatic), Local Super
Admin creates an existing hosted client (no subscription) and a NEW hosted client through the New
client wizard API with a Monthly subscription (Subscription ID, no Installation ID yet), refuses a
Subscription ID typed as Installation ID, binds the customer's Installation ID (signed key).
Customer PC: activates offline, expires (read-only), refuses a suspended key, accepts the renewal.
Vendor PC: suspend / reactivate / renew from Manage → Subscription Plans; existing clients intact.

Opt-in (slow): GTRADE_E2E=1 after restaging windows/out/stage. Evidence:
windows/out/evidence/hosted_subscription_e2e.json. Shares the harness (ports, installs) of
test_local_vendor_licensing_e2e, so run the two one after the other, never together.
"""

import datetime as dt
import json
import sys
import time

from tests import test_local_vendor_licensing_e2e as base
from tests.test_local_vendor_licensing_e2e import (
    CUSTOMER_PORTS, EVIDENCE, KEY_ID, OWNER, OWNER_PW, SA, SA_PW, VENDOR_PORTS, WIN, _ctl_stdin,
)

T = '/api/superadmin/tenants/'
L = '/api/superadmin/licensing/'


# Imported as a module attribute (not a name) so unittest does not also collect the base flow here.
class HostedSubscriptionE2E(base.LocalVendorLicensingE2E):
    # Only this module's flow (the inherited own-installation flow runs in its own module).
    test_owner_permanent_and_customer_subscription_lifecycle = None

    @classmethod
    def tearDownClass(cls):
        try:
            cls._cleanup()
        finally:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            (EVIDENCE / 'hosted_subscription_e2e.json').write_text(json.dumps(cls.ev, indent=1, default=str))

    def _vendor(self):
        V = self.up(self.vendor, VENDOR_PORTS)
        return V, self.login(V, SA, SA_PW, portal='platform')

    def _row(self, V, vt, tenant_id):
        code, page = V('GET', f'{T}?page=1&page_size=100', token=vt)
        self.assertEqual(code, 200, page)
        return next(t for t in page['results'] if t['id'] == tenant_id)

    def test_hosted_client_monthly_subscription_lifecycle(self):
        ev = self.ev['steps']
        today = dt.date.fromisoformat(time.strftime('%Y-%m-%d'))
        # Vendor PC: signing key (real CLI) trusted by this app copy, Local Super Admin.
        code, key = _ctl_stdin(self.vendor, ['vendor-key', 'generate', '--key-id', KEY_ID], '', self.app)
        self.assertEqual(code, 0, key)
        sys.path.insert(0, str(WIN / 'tooling'))
        import embed_licence_public_key as tool
        tool.embed(KEY_ID, key['public_key'], 'https://unused.invalid',
                   self.app / 'backend' / 'apps' / 'licensing' / 'vendor_public_keys.json', proof_token=key['proof'])
        code, sa = _ctl_stdin(self.vendor, ['create-superadmin', '--user', SA], SA_PW + '\n', self.app)
        self.assertEqual(code, 0, sa)
        V, vt = self._vendor()
        code, st = V('GET', '/api/licensing/status/', token=vt)
        self.assertEqual((st['status'], st['platform_owner'], st['days_left']), ('VALID', True, None))

        # An EXISTING hosted client (created without a subscription, like clients made before).
        code, legacy = V('POST', T, {'tenant_name': 'Legacy Hosted Optics', 'admin_username': 'legacyadmin',
                                     'password': 'Legacy-Strong-26!x', 'branch_name': 'Main', 'max_users': 3,
                                     'subscription_plan': 'ANNUAL', 'subscription_starts_on': today.isoformat(),
                                     'subscription_expires_on': (today + dt.timedelta(days=365)).isoformat()}, vt)
        self.assertEqual(code, 201, legacy)
        legacy_before = {k: legacy[k] for k in ('subscription_plan', 'subscription_starts_on', 'subscription_expires_on',
                                                'modules', 'max_users')}

        # New client wizard → step 5 Subscription: Monthly, no Installation ID yet.
        code, cat = V('GET', f'{L}catalog/', token=vt)
        self.assertTrue(cat['signing']['configured'], cat['signing'])
        monthly_id = next(p['id'] for p in cat['plans'] if p['code'] == 'local-monthly')
        modules = ['optical', 'sales', 'inventory', 'admin', 'reports']
        code, made = V('POST', T, {'tenant_name': 'Hosted Monthly Optics', 'owner_name': 'Meera',
                                   'contact_phone': '9876522222', 'admin_email': 'meera@example.invalid',
                                   'admin_username': 'meeraadmin', 'password': 'Meera-Strong-26!x',
                                   'branch_name': 'Main', 'max_users': 4, 'max_branches': 2, 'package': 'CUSTOM',
                                   'modules': modules, 'licence_plan_id': monthly_id,
                                   'licence_starts_on': today.isoformat(), 'installation': ''}, vt)
        self.assertEqual(code, 201, made)
        tid, sub = made['id'], made['licence']
        sub_id = sub['lic_id']
        expires = self._months(today, 1)
        self.assertRegex(sub_id, r'^GOL-\d{4}-[0-9A-F]{8}$')
        self.assertEqual((sub['subscription'], sub['starts_on'], sub['expires_on'], sub['install_id'], sub['key_available']),
                         ('Monthly', today.isoformat(), expires.isoformat(), '', False))
        self.assertNotIn('key', sub)
        self.assertEqual(sorted(sub['modules']), sorted(modules))
        row = self._row(V, vt, tid)
        self.assertEqual((row['subscription']['subscription_id'], row['subscription']['status'],
                          row['subscription']['install_id'], row['subscription_plan'], row['subscription_expires_on']),
                         (sub_id, 'ACTIVE', '', 'MONTHLY', expires.isoformat()))
        ev['A_created'] = {'tenant_id': tid, 'subscription_id': sub_id, 'row': row['subscription']}

        # Installation ID: a Subscription ID is refused; the customer's Installation ID binds the key.
        code, r = V('POST', f'{L}licences/{sub["id"]}/bind/', {'installation': sub_id}, vt)
        self.assertEqual(code, 400, r)
        self.assertIn('not an Installation ID', r['detail'])
        code, bound = V('POST', f'{L}licences/{sub["id"]}/bind/', {'installation': self.customer_install}, vt)
        self.assertEqual(code, 200, bound)
        self.assertEqual((bound['lic_id'], bound['install_id'], bound['key_available']),
                         (sub_id, self.customer_install, True))
        hosted_key = bound['key']
        ev['B_bound'] = {'subscription_id': sub_id, 'install_id': bound['install_id'], 'revision': bound['revision']}
        self.vendor.down()

        # Customer PC (no internet): offline activation, then expiry -> read-only.
        C = self.up(self.customer, CUSTOMER_PORTS)
        ct = self.login(C, OWNER, OWNER_PW)
        started = time.monotonic()
        code, act = C('POST', '/api/licensing/activate/', {'key': hosted_key}, ct)
        self.assertEqual(code, 200, act)
        self.assertLess(time.monotonic() - started, 30)
        self.assertEqual((act['status'], act['lic_id'], act['install_id'], act['expires_on'], act['plan']['name']),
                         ('VALID', sub_id, self.customer_install, expires.isoformat(), 'Monthly'))
        code, b = C('POST', '/api/masters/brands/', {'name': 'Hosted Customer Brand', 'code': 'HCB1'}, ct)
        self.assertIn(code, (200, 201), b)
        after = self.travel(dt.datetime.combine(expires + dt.timedelta(days=2), dt.time(12), tzinfo=dt.timezone.utc))
        self.assertEqual((after['status'], after['read_only'], after['write_status'], after['read_status']),
                         ('EXPIRED', True, 402, 200))
        self.assertIn('Hosted Customer Brand', after['brands'])
        ev['C_activated'] = {'status': act['status'], 'lic_id': act['lic_id'], 'expires_on': act['expires_on']}
        ev['C_expired'] = after
        self.customer.down()

        # Vendor PC: Manage → Subscription Plans: suspend, reactivate, renew.
        V, vt = self._vendor()
        code, subs = V('GET', f'{L}tenants/{tid}/subscriptions/', token=vt)
        self.assertEqual((code, subs['current_licence_id'], subs['subscription']['subscription_id']), (200, sub['id'], sub_id))
        code, s = V('POST', f'{L}licences/{sub["id"]}/suspend/', {'reason': 'payment pending'}, vt)
        self.assertEqual(code, 200, s)
        self.assertEqual(self._row(V, vt, tid)['subscription']['status'], 'SUSPENDED')
        suspended_key = s['key']
        code, s = V('POST', f'{L}licences/{sub["id"]}/reactivate/', {'reason': 'paid'}, vt)
        self.assertEqual(code, 200, s)
        self.assertEqual(self._row(V, vt, tid)['subscription']['status'], 'ACTIVE')
        code, renewed = V('POST', f'{L}licences/{sub["id"]}/renew/', {'periods': 1, 'confirm': True}, vt)
        self.assertEqual(code, 200, renewed)
        new_expiry = self._months(expires, 1)
        self.assertEqual((renewed['lic_id'], renewed['install_id'], renewed['expires_on']),
                         (sub_id, self.customer_install, new_expiry.isoformat()))
        row = self._row(V, vt, tid)
        self.assertEqual((row['subscription_expires_on'], row['subscription']['status']), (new_expiry.isoformat(), 'ACTIVE'))
        # Existing clients and subscriptions are intact.
        legacy_now = self._row(V, vt, legacy['id'])
        self.assertEqual({k: legacy_now[k] for k in legacy_before}, legacy_before)
        self.assertIsNone(legacy_now['subscription'])
        code, subs = V('GET', f'{L}tenants/{tid}/subscriptions/', token=vt)
        self.assertEqual([x['lic_id'] for x in subs['licences']], [sub_id])
        self.assertGreaterEqual(subs['licences'][0]['revision'], 5)  # created, bound, suspended, reactivated, renewed
        ev['D_manage'] = {'renewed_expires_on': renewed['expires_on'], 'revision': subs['licences'][0]['revision'],
                          'legacy_unchanged': True}
        self.vendor.down()

        # Customer PC: the suspended key is refused; the renewal restores full use, data intact.
        C = self.up(self.customer, CUSTOMER_PORTS)
        ct = self.login(C, OWNER, OWNER_PW)
        code, r = C('POST', '/api/licensing/activate/', {'key': suspended_key}, ct)
        self.assertEqual(code, 400, r)
        self.assertIn('suspended', r['error'])
        code, act2 = C('POST', '/api/licensing/activate/', {'key': renewed['key']}, ct)
        self.assertEqual(code, 200, act2)
        self.assertEqual((act2['status'], act2['lic_id'], act2['expires_on']), ('VALID', sub_id, new_expiry.isoformat()))
        later = self.travel(dt.datetime.combine(expires + dt.timedelta(days=2), dt.time(12), tzinfo=dt.timezone.utc))
        self.assertEqual((later['status'], later['read_only']), ('VALID', False))
        self.assertIn(later['write_status'], (200, 201))
        self.assertIn('Hosted Customer Brand', later['brands'])
        ev['E_renewed_on_customer'] = {'status': act2['status'], 'expires_on': act2['expires_on'], 'after_old_expiry': later}
        ev['data_intact'] = True
        ev['finished'] = time.strftime('%Y-%m-%dT%H:%M:%S')
