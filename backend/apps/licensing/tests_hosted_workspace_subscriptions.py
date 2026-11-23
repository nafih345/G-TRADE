"""Client Management → Hosted Workspaces: New client step 5 "Subscription" and Manage → Subscription
Plans (Windows Local Super Admin, 2026-11-20).

The subscription of a hosted workspace IS its Windows Local licence record (no second system):
    Tenant 1--1 LicensedClient (tenant FK) 1--n ClientLicense
Subscription ID = ClientLicense.lic_id (unique DB record, also signed into the key). The customer's
Installation ID is a different value that binds the key. The workspace's plan / start / expiry
mirror its current subscription (chosen by dates and status).

Production paths: release build, non-dev vendor key in a DPAPI file, trusted public key.
Runs under config.settings_local.
"""

import datetime as dt
import unittest

from django.conf import settings

if 'apps.licensing' not in settings.INSTALLED_APPS:  # cloud settings: nothing to test here
    raise unittest.SkipTest('local edition only')

from django.test import override_settings  # noqa: E402
from django.utils import timezone  # noqa: E402

from apps.common.models import Tenant, TenantAuditLog  # noqa: E402
from apps.licensing import licfmt, state  # noqa: E402
from apps.licensing.tests_local_client_management import CLIENT_PW, _NoNetwork  # noqa: E402
from apps.licensing.tests_local_vendor_workflow import (  # noqa: E402
    CUSTOMER_INSTALL, KEY_FILE, LIC, OTHER_PC, VENDOR_INSTALL, LocalVendorBase,
)
from apps.vendor_licensing import tokens  # noqa: E402
from apps.vendor_licensing.models import ClientLicense, LicenseAuditEvent, LicensedClient  # noqa: E402

URL = '/api/superadmin/tenants/'
MODULES = ['optical', 'sales', 'inventory', 'admin', 'reports']


@override_settings(GTRADE_INSTALL_ID=VENDOR_INSTALL, GTRADE_LICENSE_DEV_MODE=False, GTRADE_RELEASE_BUILD=True,
                   GTRADE_LICENSE_SIGNING_KEY_FILE=str(KEY_FILE), GTRADE_LICENSE_SIGNING_KEY_ID='',
                   GTRADE_LICENSE_SIGNING_KEY='', GTRADE_LICENSE_SERVICE_URL='')
class HostedWorkspaceSubscriptionTests(LocalVendorBase):

    # ---- helpers ---------------------------------------------------------------------------------
    def onboard(self, name='Lakeview Optics', username='lakeadmin', plan='local-monthly', starts_on=None,
                installation='', expect=201, **extra):
        body = {'tenant_name': name, 'admin_username': username, 'password': CLIENT_PW, 'branch_name': 'Main',
                'owner_name': 'Ravi', 'contact_phone': '9876511111', 'admin_email': f'{username}@example.com',
                'max_users': 4, 'max_branches': 2, 'package': 'CUSTOM', 'modules': MODULES, **extra}
        if plan:
            body.update({'licence_plan_id': self.plans()[plan]['id'], 'installation': installation,
                         'licence_starts_on': (starts_on or timezone.localdate()).isoformat()})
        r = self.sa.post(URL, body, format='json')
        self.assertEqual(r.status_code, expect, r.content)
        return r.json()

    def row(self, tenant_id):
        r = self.sa.get(URL, {'page': 1, 'page_size': 100})
        self.assertEqual(r.status_code, 200, r.content)
        return next(t for t in r.json()['results'] if t['id'] == tenant_id)

    def subs(self, tenant_id):
        r = self.sa.get(f'{LIC}tenants/{tenant_id}/subscriptions/')
        self.assertEqual(r.status_code, 200, r.content)
        return r.json()

    def act(self, lic_id, action, body=None, expect=200):
        r = self.sa.post(f'{LIC}licences/{lic_id}/{action}/', body or {}, format='json')
        self.assertEqual(r.status_code, expect, r.content)
        return r.json()

    def customer_request_code(self):
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        r = self.customer_admin.post('/api/licensing/request/', {}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        self.as_installation(VENDOR_INSTALL)
        return r.json()['request_code']

    # ---- creating clients + assigning subscriptions + Subscription ID ------------------------------
    def test_new_client_creates_subscription_with_real_subscription_id_without_reentering_details(self):
        start = timezone.localdate()
        with _NoNetwork():
            data = self.onboard()
        tenant = Tenant.objects.get(pk=data['id'])
        lic_data = data['licence']
        sub_id = lic_data['lic_id']
        self.assertRegex(sub_id, r'^GOL-\d{4}-[0-9A-F]{8}$')
        lic = ClientLicense.objects.get(lic_id=sub_id)                     # a real DB record
        self.assertEqual(str(lic.pk), lic_data['id'])
        client = LicensedClient.objects.get(tenant=tenant)                 # linked to THIS workspace, once
        self.assertEqual(lic.client_id, client.pk)
        self.assertEqual((client.name, client.owner_name, client.phone, client.edition),
                         ('Lakeview Optics', 'Ravi', '9876511111', 'WINDOWS_LOCAL'))
        # Plan, start, expiry, modules preserved; seats / branches from the wizard.
        expires = tokens.add_months(start, 1)
        self.assertEqual((lic_data['subscription'], lic_data['starts_on'], lic_data['expires_on']),
                         ('Monthly', start.isoformat(), expires.isoformat()))
        self.assertEqual(sorted(lic.modules), sorted(tenant.modules))
        self.assertEqual((lic.limits['users'], lic.limits['branches']), (4, 2))
        # No Installation ID yet: saved, no key handed out, Subscription ID is not an Installation ID.
        self.assertEqual(lic.install_id, '')
        self.assertNotIn('key', lic_data)
        self.assertFalse(lic_data['key_available'])
        # The workspace mirrors it.
        self.assertEqual((tenant.subscription_plan, tenant.subscription_starts_on, tenant.subscription_expires_on),
                         ('MONTHLY', start, expires))
        # (Nothing to mirror yet: the wizard already set these from the plan; later changes are logged.)
        # The Hosted Workspaces list shows it.
        row = self.row(tenant.pk)['subscription']
        self.assertEqual((row['subscription_id'], row['plan'], row['install_id'], row['status'], row['starts_on'],
                          row['expires_on']), (sub_id, 'Monthly', '', 'ACTIVE', start.isoformat(), expires.isoformat()))
        self.assertEqual(sorted(row['modules']), sorted(MODULES))
        # Subscription IDs are unique per subscription.
        other = self.onboard(name='Hilltop Optics', username='hilladmin')
        self.assertNotEqual(other['licence']['lic_id'], sub_id)
        # A hosted client is managed in Hosted Workspaces, not duplicated in Customers & Subscriptions.
        ov = self.sa.get(f'{LIC}clients/overview/').json()
        self.assertFalse([r for r in ov['results'] if r['tenant_id'] in (tenant.pk, other['id'])])

    def test_installation_id_bound_later_produces_an_offline_key_for_that_installation(self):
        data = self.onboard()
        tid, sub_id, lic_pk = data['id'], data['licence']['lic_id'], data['licence']['id']
        code = self.customer_request_code()
        self.assertNotEqual(code, sub_id)
        # A Subscription ID is not an Installation ID.
        for wrong in (sub_id, sub_id.lower(), LicensedClient.objects.get(tenant_id=tid).client_code):
            r = self.sa.post(f'{LIC}licences/{lic_pk}/bind/', {'installation': wrong}, format='json')
            self.assertEqual(r.status_code, 400, r.content)
            self.assertIn('not an Installation ID', r.json()['detail'])
        r = self.sa.post(URL, {'tenant_name': 'Wrong Id Optics', 'admin_username': 'wrongid', 'password': CLIENT_PW,
                               'branch_name': 'Main', 'max_users': 2, 'licence_plan_id': self.plans()['local-monthly']['id'],
                               'installation': sub_id}, format='json')
        self.assertEqual(r.status_code, 400, r.content)
        self.assertFalse(Tenant.objects.filter(name='Wrong Id Optics').exists())   # nothing half-created
        with _NoNetwork():
            bound = self.act(lic_pk, 'bind', {'installation': code})
        self.assertEqual((bound['lic_id'], bound['install_id'], bound['key_available'], bound['revision']),
                         (sub_id, CUSTOMER_INSTALL, True, 2))
        p = licfmt.decode_unverified(bound['key'])
        self.assertEqual((p['lic_id'], p['install_id'], p['binding'], p['edition']),
                         (sub_id, CUSTOMER_INSTALL, 'INSTALLATION', 'WINDOWS_LOCAL'))
        self.assertEqual(p['client']['id'], LicensedClient.objects.get(tenant_id=tid).client_code)
        self.assertEqual(self.row(tid)['subscription']['install_id'], CUSTOMER_INSTALL)
        key = self.sa.post(f'{LIC}licences/{lic_pk}/key/', {}, format='json').json()['key']
        self.assertEqual(key, bound['key'])
        # The customer activates it offline; another PC's installation is refused.
        self.as_installation(CUSTOMER_INSTALL)
        with _NoNetwork():
            r = self.activate(key)
        self.assertEqual(r.status_code, 200, r.content)
        self.assertEqual((r.json()['status'], r.json()['lic_id']), ('VALID', sub_id))
        self.as_installation(OTHER_PC, fresh=True)
        with _NoNetwork():
            r = self.activate(key)
        self.assertEqual(r.status_code, 400)
        self.assertIn('another installation', r.json()['error'])

    def test_installation_id_given_at_creation_returns_the_key_immediately(self):
        data = self.onboard(installation=CUSTOMER_INSTALL)
        self.assertTrue(data['licence']['key_available'])
        self.assertEqual(licfmt.decode_unverified(data['licence']['key'])['install_id'], CUSTOMER_INSTALL)
        self.assertEqual(self.row(data['id'])['subscription']['install_id'], CUSTOMER_INSTALL)

    def test_plans_and_statuses_in_the_list(self):
        today = timezone.localdate()
        cases = [('local-quarterly', 0, 'QUARTERLY', 'ACTIVE'), ('local-half-yearly', 0, 'HALF_YEARLY', 'ACTIVE'),
                 ('local-yearly', 0, 'ANNUAL', 'ACTIVE'), ('local-lifetime', 0, 'PERPETUAL', 'LIFETIME'),
                 ('local-monthly', 10, 'MONTHLY', 'UPCOMING'), ('local-monthly', -27, 'MONTHLY', 'RENEWAL_DUE'),
                 ('local-monthly', -40, 'MONTHLY', 'EXPIRED')]
        for i, (plan, offset, tenant_plan, status) in enumerate(cases):
            data = self.onboard(name=f'Client {i}', username=f'client{i}', plan=plan,
                                starts_on=today + dt.timedelta(days=offset))
            tenant = Tenant.objects.get(pk=data['id'])
            self.assertEqual(tenant.subscription_plan, tenant_plan, plan)
            self.assertEqual(self.row(tenant.pk)['subscription']['status'], status, (plan, offset))
            if plan == 'local-lifetime':
                self.assertIsNone(tenant.subscription_expires_on)
        # The expired one: the workspace itself is past its expiry too.
        self.assertEqual(self.row(data['id'])['status'], 'EXPIRED')

    # ---- Manage → Subscription Plans --------------------------------------------------------------
    def test_manage_renew_change_plan_change_start_suspend_reactivate_revoke(self):
        today = timezone.localdate()
        data = self.onboard(plan='local-monthly', starts_on=today - dt.timedelta(days=40), installation=CUSTOMER_INSTALL)
        tid, lic_pk, sub_id = data['id'], data['licence']['id'], data['licence']['lic_id']
        s = self.subs(tid)
        self.assertEqual((s['current_licence_id'], s['subscription']['status'], len(s['licences'])), (lic_pk, 'EXPIRED', 1))
        self.assertEqual(s['subscription']['renewal_status'], 'OVERDUE')
        # Renew: same Subscription ID, same installation, new expiry; the workspace follows.
        renewed = self.act(lic_pk, 'renew', {'periods': 1, 'confirm': True})
        self.assertEqual((renewed['lic_id'], renewed['install_id'], renewed['revision']), (sub_id, CUSTOMER_INSTALL, 2))
        self.assertEqual(renewed['expires_on'], tokens.add_months(today, 1).isoformat())
        self.assertEqual(Tenant.objects.get(pk=tid).subscription_expires_on, tokens.add_months(today, 1))
        self.assertEqual(self.row(tid)['subscription']['status'], 'ACTIVE')
        self.assertTrue(TenantAuditLog.objects.filter(tenant_id=tid, action='SUBSCRIPTION_APPLIED').exists())
        # Change plan to Yearly: workspace plan follows.
        yearly = self.plans()['local-yearly']['id']
        self.act(lic_pk, 'change-plan', {'plan_id': yearly, 'restart_period': True, 'confirm': True})
        self.assertEqual(Tenant.objects.get(pk=tid).subscription_plan, 'ANNUAL')
        self.assertEqual(self.subs(tid)['subscription']['plan'], 'Yearly')
        # Change start date: needs a reason; expiry moves with it; re-signed; audited.
        r = self.sa.post(f'{LIC}licences/{lic_pk}/change-start/', {'starts_on': (today + dt.timedelta(days=5)).isoformat()},
                         format='json')
        self.assertEqual(r.status_code, 400, r.content)
        new_start = today + dt.timedelta(days=5)
        moved = self.act(lic_pk, 'change-start', {'starts_on': new_start.isoformat(), 'reason': 'customer go-live date'})
        self.assertEqual((moved['starts_on'], moved['expires_on']),
                         (new_start.isoformat(), tokens.add_months(new_start, 12).isoformat()))
        self.assertEqual(licfmt.decode_unverified(moved['key'])['starts_on'], new_start.isoformat())
        self.assertEqual(Tenant.objects.get(pk=tid).subscription_starts_on, new_start)
        self.assertEqual(self.row(tid)['subscription']['status'], 'UPCOMING')
        self.assertTrue(LicenseAuditEvent.objects.filter(action='START_DATE_CHANGED', licence_id=lic_pk).exists())
        self.act(lic_pk, 'change-start', {'starts_on': today.isoformat(), 'reason': 'back to today'})
        # Suspend / reactivate.
        self.act(lic_pk, 'suspend', {'reason': 'payment pending'})
        self.assertEqual(self.row(tid)['subscription']['status'], 'SUSPENDED')
        self.act(lic_pk, 'reactivate', {'reason': 'paid'})
        self.assertEqual(self.row(tid)['subscription']['status'], 'ACTIVE')
        # A second subscription for the same client keeps the history; current = by dates.
        r = self.sa.post(f'{LIC}licences/', {'tenant_id': tid, 'plan_id': self.plans()['local-monthly']['id'],
                                             'starts_on': (today - dt.timedelta(days=70)).isoformat(),
                                             'installation': CUSTOMER_INSTALL}, format='json')
        self.assertEqual(r.status_code, 201, r.content)
        s = self.subs(tid)
        self.assertEqual((len(s['licences']), s['current_licence_id']), (2, lic_pk))   # not the newer, expired one
        self.assertEqual(LicensedClient.objects.filter(tenant_id=tid).count(), 1)     # one client record
        # Revoke: permanent; history kept; the current subscription is now the remaining (expired) one,
        # which the workspace mirrors (no active subscription = expired workspace).
        self.act(lic_pk, 'revoke', {'reason': 'closed', 'confirm_lic_id': sub_id})
        self.assertEqual(ClientLicense.objects.filter(client__tenant_id=tid).count(), 2)
        s = self.subs(tid)
        self.assertNotEqual(s['current_licence_id'], lic_pk)
        self.assertEqual(s['subscription']['status'], 'EXPIRED')
        self.assertEqual(Tenant.objects.get(pk=tid).subscription_expires_on,
                         tokens.add_months(today - dt.timedelta(days=70), 1))
        # Only revoked subscriptions left: the workspace keeps its last terms (no silent change).
        other = s['current_licence_id']
        other_lic = ClientLicense.objects.get(pk=other)
        before = Tenant.objects.get(pk=tid).subscription_expires_on
        self.act(other, 'revoke', {'reason': 'closed', 'confirm_lic_id': other_lic.lic_id})
        self.assertEqual(Tenant.objects.get(pk=tid).subscription_expires_on, before)
        self.assertEqual(self.row(tid)['subscription']['status'], 'REVOKED')
        self.assertEqual(self.act(lic_pk, 'renew', {'periods': 1, 'confirm': True}, expect=400)['code'], 'revoked')

    def test_existing_hosted_clients_keep_working(self):
        # A client created without a subscription (older clients / no signing key): unchanged behaviour.
        legacy = self.onboard(name='Old Optics', username='oldadmin', plan=None, subscription_plan='ANNUAL',
                              subscription_starts_on=timezone.localdate().isoformat(),
                              subscription_expires_on=(timezone.localdate() + dt.timedelta(days=365)).isoformat())
        self.assertIsNone(self.row(legacy['id'])['subscription'])
        self.assertEqual(self.subs(legacy['id'])['client'], None)
        r = self.sa.patch(f'{URL}{legacy["id"]}/', {'subscription_plan': 'MONTHLY',
                                                    'subscription_expires_on': timezone.localdate().isoformat()},
                          format='json')
        self.assertEqual(r.status_code, 200, r.content)
        # It can be given a subscription later from Manage (its details are reused).
        r = self.sa.post(f'{LIC}licences/', {'tenant_id': legacy['id'], 'plan_id': self.plans()['local-yearly']['id']},
                         format='json')
        self.assertEqual(r.status_code, 201, r.content)
        self.assertEqual(r.json()['client']['name'], 'Old Optics')
        self.assertEqual(Tenant.objects.get(pk=legacy['id']).subscription_plan, 'ANNUAL')
        # A subscribed workspace: plan / dates only through the subscription; seats stay editable.
        r = self.sa.patch(f'{URL}{legacy["id"]}/', {'subscription_expires_on': '2099-01-01'}, format='json')
        self.assertEqual((r.status_code, r.json()['code']), (400, 'licence_managed'))
        r = self.sa.patch(f'{URL}{legacy["id"]}/', {'max_users': 7}, format='json')
        self.assertEqual(r.status_code, 200, r.content)
        # The workspace still opens and its admin can sign in.
        self.assertEqual(self.sa.get(f'{URL}{legacy["id"]}/').status_code, 200)
        # The platform account itself never gets a subscription.
        r = self.sa.post(f'{LIC}licences/', {'tenant_id': 1, 'plan_id': self.plans()['local-yearly']['id']}, format='json')
        self.assertEqual(r.status_code, 400, r.content)

    def test_expired_customer_installation_is_read_only_and_renewal_restores_it(self):
        today = timezone.localdate()
        data = self.onboard(installation=CUSTOMER_INSTALL)
        lic_pk = data['licence']['id']
        self.as_installation(CUSTOMER_INSTALL, fresh=True)
        with _NoNetwork():
            self.assertEqual(self.activate(data['licence']['key']).status_code, 200)
        expires = tokens.add_months(today, 1)
        later = dt.datetime.combine(expires + dt.timedelta(days=2), dt.time(12), tzinfo=dt.timezone.utc)
        from unittest import mock
        with mock.patch('django.utils.timezone.now', return_value=later):
            state.invalidate()
            self.assertEqual((state.current(force=True).status, state.current().read_only), ('EXPIRED', True))
            self.as_installation(VENDOR_INSTALL)
            renewed = self.act(lic_pk, 'renew', {'periods': 1, 'confirm': True})
            self.as_installation(CUSTOMER_INSTALL)
            with _NoNetwork():
                r = self.activate(renewed['key'])
            self.assertEqual(r.status_code, 200, r.content)
            self.assertEqual((r.json()['status'], r.json()['read_only']), ('VALID', False))
