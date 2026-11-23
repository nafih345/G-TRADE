"""Windows Local vendor licensing, end to end, with TWO REAL staged installations on this PC:

  vendor PC     installed by `gtrade-ctl install` (like the NSIS wizard); the owner's signing key is
                created by the REAL `gtrade-ctl vendor-key generate` (DPAPI file, protected ACL); its
                public half is embedded in the app copy both installations run (as the final build
                does); the installation receives its permanent platform-owner licence automatically
                and the Local Super Admin (`gtrade-ctl create-superadmin`) issues customer keys in
                Client Management -> Customers & Subscriptions, offline;
  customer PC   a second installation (its own Installation ID, database, HTTPS server) whose licence
                server URL points at a closed port: nothing can be fetched online. Its owner pastes
                the keys into Licence Details -> Activate.

Both run the app as shipped: RELEASE marker (development keys refused), no dev mode, a NON-dev
key id. Time after the expiry date is checked inside the customer installation's own Python and
database with the clock pinned (tests/lic_timetravel.py, rolled back afterwards).

Opt-in (slow: two full installations): GTRADE_E2E=1, after restaging windows/out/stage.
Evidence: windows/out/evidence/local_vendor_licensing_e2e.json.
"""

import datetime as dt
import json
import os
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
import uuid
from pathlib import Path

from tests.stack import STAGE, Stack
from tests.test_licence_activation_e2e import _http

WIN = Path(__file__).resolve().parents[1]
EVIDENCE = WIN / 'out' / 'evidence'
KEY_ID = 'gtl-e2e-vendor'
SA, SA_PW = 'vendorsa', 'Vsa-' + uuid.uuid4().hex[:12] + '!9'
OWNER, OWNER_PW = 'clearowner', 'Own-' + uuid.uuid4().hex[:12] + '!9'
VENDOR_PORTS = dict(https_port=18521, app_port=18081, db_port=15621)
CUSTOMER_PORTS = dict(https_port=18522, app_port=18082, db_port=15622)
OTHER_PC = '0f0f0f0f-bbbb-4222-8333-444455556666'


class AppStack(Stack):
    extra: dict = {}

    def env(self, app_dir=None):
        env = super().env(app_dir)
        env.update(type(self).extra)
        return env


class CustomerStack(AppStack):
    # "No internet": the licence server is a closed local port; any online attempt fails at once.
    extra = {'GTRADE_LICENSE_SERVICE_URL': 'https://127.0.0.1:9/api/licence-authority'}


def _install(stack, ports, company, admin, password, tmp):
    answers = tmp / f'answers-{ports["https_port"]}.json'
    answers.write_text(json.dumps({'company_name': company, 'branch_name': 'Main', 'admin_username': admin,
                                   'admin_password': password, 'admin_full_name': admin,
                                   'admin_email': f'{admin}@example.invalid'}))
    env = stack.env()
    env['GTRADE_CLIENT_DIR'] = str(tmp / f'client-{ports["https_port"]}')
    proc = subprocess.run([str(stack.python), '-m', 'gtrade_ctl', '--install-root', str(STAGE),
                           '--data-root', str(stack.data_root), 'install', '--mode', 'standalone',
                           '--version', '1.0.0', '--https-port', str(ports['https_port']),
                           '--app-port', str(ports['app_port']), '--db-port', str(ports['db_port']),
                           '--answers', str(answers), '--no-services', '--no-firewall', '--no-acl'],
                          env=env, capture_output=True, text=True, timeout=2400, encoding='utf-8', errors='replace')
    if proc.returncode != 0:
        raise RuntimeError(f'install failed: {proc.stdout[-1500:]} {proc.stderr[-1500:]}')
    sys.path.insert(0, str(WIN))
    from gtrade_ctl import install_config
    return install_config.read_env(stack.data_root / 'config' / 'gtrade.env')['GTRADE_INSTALL_ID']


def _ctl_stdin(stack, args, text, app_dir):
    proc = subprocess.run([str(stack.python), '-m', 'gtrade_ctl', '--install-root', str(STAGE), '--data-root',
                           str(stack.data_root), *args], input=text, capture_output=True, text=True,
                          env=stack.env(app_dir), timeout=900, encoding='utf-8', errors='replace')
    try:
        data = json.loads(proc.stdout)
    except ValueError:
        data = {'raw': proc.stdout[-1500:], 'stderr': proc.stderr[-1500:]}
    return proc.returncode, data


@unittest.skipUnless(os.environ.get('GTRADE_E2E') == '1' and (STAGE / 'runtime' / 'python' / 'python.exe').exists(),
                     'set GTRADE_E2E=1 after building windows/out/stage')
class LocalVendorLicensingE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-vlic-e2e-'))
        cls.ev = {'started': time.strftime('%Y-%m-%dT%H:%M:%S'), 'steps': {}}
        cls.vendor = cls.customer = None
        try:
            cls.app = cls.tmp / 'app' / '1.0.0'
            shutil.copytree(STAGE / 'app' / '1.0.0', cls.app)
            if not (cls.app / 'RELEASE').is_file():
                raise RuntimeError('the staged app must be a release build')
            cls.customer = CustomerStack(cls.tmp / 'customer-data', **CUSTOMER_PORTS)
            cls.customer_install = _install(cls.customer, CUSTOMER_PORTS, 'CLEAR OPTICS', OWNER, OWNER_PW, cls.tmp)
            cls.customer.down()
            cls.vendor = AppStack(cls.tmp / 'vendor-data', **VENDOR_PORTS)
            cls.vendor_install = _install(cls.vendor, VENDOR_PORTS, 'GREENSOL SOLUTION', 'greensoladmin',
                                          'Gsa-' + uuid.uuid4().hex[:12] + '!9', cls.tmp)
            cls.ev['installations'] = {'vendor': cls.vendor_install, 'customer': cls.customer_install}
        except Exception:
            cls._cleanup()
            raise

    @classmethod
    def _cleanup(cls):
        for st in (cls.vendor, cls.customer):
            if st is not None:
                try:
                    st.down()
                except Exception:
                    pass
        shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def tearDownClass(cls):
        try:
            cls._cleanup()
        finally:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            (EVIDENCE / 'local_vendor_licensing_e2e.json').write_text(json.dumps(cls.ev, indent=1, default=str))

    # ---- helpers ------------------------------------------------------------------------------
    def up(self, stack, ports):
        stack.start_db()
        stack.stop_app()
        stack.start_app(app_dir=self.app)
        stack.start_web()
        stack.wait_health(timeout=240)
        ctx = ssl.create_default_context(cafile=str(stack.data_root / 'config' / 'tls' / 'ca.crt'))
        base = f'https://localhost:{ports["https_port"]}'
        return lambda method, path, body=None, token=None: _http(method, base + path, body, token, ctx=ctx, timeout=180)

    def login(self, call, user, pw, portal=None):
        body = {'username': user, 'password': pw, **({'portal': portal} if portal else {})}
        code, res = call('POST', '/api/auth/login/', body)
        self.assertEqual(code, 200, res)
        call('POST', '/api/security/reauth/', {'password': pw}, res['access'])
        return res['access']

    def travel(self, when: dt.datetime):
        proc = subprocess.run([str(self.customer.python), str(WIN / 'tests' / 'lic_timetravel.py'),
                               str(self.customer.data_root), str(self.app), when.isoformat(), OWNER],
                              env=self.customer.env(self.app), capture_output=True, text=True, timeout=600,
                              encoding='utf-8', errors='replace')
        self.assertEqual(proc.returncode, 0, proc.stderr[-2000:])
        return json.loads(proc.stdout.strip().splitlines()[-1])

    # ---- the flow ------------------------------------------------------------------------------
    def test_owner_permanent_and_customer_subscription_lifecycle(self):
        ev, L = self.ev['steps'], '/api/superadmin/licensing/'
        # 1. The owner's signing key, made on the vendor installation by the real CLI.
        code, key = _ctl_stdin(self.vendor, ['vendor-key', 'generate', '--key-id', KEY_ID], '', self.app)
        self.assertEqual(code, 0, key)
        self.assertNotIn('PRIVATE', json.dumps(key))  # public material only
        key_file = self.vendor.data_root / 'config' / 'license' / 'vendor-signing.dpapi'
        self.assertTrue(key_file.is_file())
        self.assertNotIn(b'PRIVATE KEY', key_file.read_bytes())
        self.assertFalse(key['trusted_by_installed_build'])
        code, again = _ctl_stdin(self.vendor, ['vendor-key', 'generate', '--key-id', 'gtl-e2e-other'], '', self.app)
        self.assertNotEqual(code, 0, 'an existing vendor key is never replaced')
        # The release tool embeds the public key only with a valid proof (as finalize_release does).
        sys.path.insert(0, str(WIN / 'tooling'))
        import embed_licence_public_key as tool
        keys_file = self.app / 'backend' / 'apps' / 'licensing' / 'vendor_public_keys.json'
        out = tool.embed(KEY_ID, key['public_key'], 'https://unused.invalid', keys_file, proof_token=key['proof'])
        ev['vendor_key'] = {'key_id': KEY_ID, 'public_key': key['public_key'], 'embedded': out['key_ids']}

        # 2. Vendor installation: Local Super Admin -> permanent platform-owner licence.
        code, sa = _ctl_stdin(self.vendor, ['create-superadmin', '--user', SA], SA_PW + '\n', self.app)
        self.assertEqual(code, 0, sa)
        V = self.up(self.vendor, VENDOR_PORTS)
        vt = self.login(V, SA, SA_PW, portal='platform')
        # Automatic (2026-11-19): nobody presses anything. The first status read on the installation
        # that holds the trusted vendor key already reports the permanent owner licence; there is no
        # evaluation and no countdown (apps/licensing/owner.py).
        code, owner = V('GET', '/api/licensing/status/', token=vt)
        self.assertEqual(code, 200, owner)
        self.assertEqual((owner['status'], owner['platform_owner'], owner['lifetime'], owner['tier'], owner['read_only']),
                         ('VALID', True, True, 'ENTERPRISE', False))
        self.assertIsNone(owner['days_left'])
        self.assertIsNone(owner['valid_until'])
        self.assertNotIn('evaluation', owner['message'].lower())
        code, health = V('GET', '/api/health/')
        self.assertEqual((health['license']['status'], health['license']['days_left']), ('VALID', None))
        self.assertIsNone(owner['modules'])
        self.assertEqual(set(owner['unlimited']), {'clients', 'companies', 'branches_total', 'branches_per_company', 'users'})
        ev['A_platform_owner'] = {k: owner[k] for k in ('status', 'platform_owner', 'lic_id', 'plan', 'tier', 'lifetime',
                                                         'days_left', 'valid_until', 'unlimited', 'modules', 'install_id')}
        # Unlimited clients: more than the evaluation's 1 client.
        made = []
        for i in range(3):
            code, c = V('POST', '/api/superadmin/tenants/', {
                'tenant_name': f'Hosted Client {i}', 'admin_username': f'hosted{i}', 'password': 'Hosted-Strong-26!' + str(i),
                'branch_name': 'Main', 'max_users': 3}, vt)
            self.assertEqual(code, 201, c)
            made.append(c['id'])
        ev['A_clients_created'] = len(made)

        # 3. Customer subscription keys, issued on the vendor installation (no internet needed).
        code, cat = V('GET', f'{L}catalog/', token=vt)
        self.assertEqual(code, 200, cat)
        self.assertTrue(cat['local'] and cat['signing']['configured'], cat['signing'])
        self.assertEqual(cat['signing']['key_id'], KEY_ID)
        plans = {p['code']: p for p in cat['plans']}
        self.assertTrue({'local-monthly', 'local-quarterly', 'local-half-yearly', 'local-yearly', 'local-lifetime'} <= set(plans))
        today = dt.date.fromisoformat(time.strftime('%Y-%m-%d'))
        terms = {'tier': 'PROFESSIONAL', 'limits': {'users': 4, 'companies': 1, 'branches': 2, 'branches_per_company': 2,
                                                     'clients': 0},
                 'modules': ['optical', 'sales', 'inventory', 'purchase', 'accounts', 'admin', 'reports', 'settings']}

        def issue(plan, client=None, client_id=None, installation=None, starts_on=today, t=terms):
            body = {'plan_id': plans[plan]['id'], 'starts_on': starts_on.isoformat(),
                    'installation': self.customer_install if installation is None else installation, 'terms': t}
            body.update({'client_id': client_id} if client_id else {'client': client or {'name': 'CLEAR OPTICS'}})
            code, lic = V('POST', f'{L}licences/', body, vt)
            self.assertEqual(code, 201, lic)
            return lic

        monthly = issue('local-monthly', {'name': 'CLEAR OPTICS', 'owner_name': 'Asha', 'phone': '9876500000'})
        cid = monthly['client']['id']
        wrong_client = issue('local-monthly', {'name': 'Some Other Shop'})
        wrong_pc = issue('local-monthly', client_id=cid, installation=OTHER_PC)
        expired = issue('local-monthly', client_id=cid, starts_on=today - dt.timedelta(days=70))
        # Client Management -> Customers & Subscriptions lists the client with its subscription.
        code, ov = V('GET', f'{L}clients/overview/', token=vt)
        self.assertEqual(code, 200, ov)
        row = next(r for r in ov['results'] if r['id'] == cid)
        self.assertEqual((row['name'], row['licence_count']), ('CLEAR OPTICS', 3))
        code, detail = V('GET', f'{L}clients/{cid}/', token=vt)
        self.assertEqual(code, 200, detail)
        m = next(x for x in detail['licences'] if x['lic_id'] == monthly['lic_id'])
        self.assertEqual((m['subscription'], m['install_id'], m['activation_status'], m['effective_status'],
                          m['renewal_status']), ('Monthly', self.customer_install, 'BOUND', 'ACTIVE', 'OK'))
        # The client's CURRENT subscription is the valid Monthly licence, not the expired one that
        # was created after it with a backdated start (regression 2026-11-19).
        # (wrong_pc is an equally valid Monthly licence of the same client, issued later: either is current.)
        self.assertIn(row['current_licence_id'], (monthly['id'], wrong_pc['id']))
        self.assertNotEqual(row['current_licence_id'], expired['id'])
        self.assertEqual((row['licence']['effective_status'], row['renewal_status']), ('ACTIVE', 'OK'))
        ev['B_client_management'] = {'monthly': {k: m[k] for k in ('lic_id', 'subscription', 'effective_status',
                                                                    'activation_status', 'issued_at', 'expires_on',
                                                                    'install_id', 'renewal_status')},
                                     'overview_current': {'lic_id': row['licence']['lic_id'],
                                                          'renewal_status': row['renewal_status']}}
        ev['B_issued'] = {'lic_id': monthly['lic_id'], 'client': monthly['client']['client_code'],
                          'starts_on': monthly['starts_on'], 'expires_on': monthly['expires_on'], 'tier': monthly['tier'],
                          'install_id': monthly['install_id'], 'key_prefix': monthly['key'][:12]}
        self.vendor.down()

        # 4. Customer installation: evaluation -> refusals -> paste the monthly key -> VALID, offline.
        C = self.up(self.customer, CUSTOMER_PORTS)
        ct = self.login(C, OWNER, OWNER_PW)
        code, st = C('GET', '/api/licensing/status/', token=ct)
        self.assertEqual((st['status'], st['install_id']), ('EVALUATION', self.customer_install))
        code, po = C('POST', '/api/licensing/platform-owner/', {}, ct)
        self.assertEqual(code, 403, po)  # a customer can never make itself the platform owner
        refusals = {}
        head, body, sig = monthly['key'].split('.')
        code, r = C('POST', '/api/licensing/activate/', {'key': wrong_pc['key']}, ct)
        refusals['wrong_pc'] = (code, r.get('error'))
        self.assertEqual(code, 400)
        self.assertIn('another installation', r['error'])
        code, r = C('POST', '/api/licensing/activate/', {'key': expired['key']}, ct)
        refusals['expired'] = (code, r.get('error'))
        self.assertEqual(code, 400)
        self.assertIn('expired', r['error'])
        tampered = f'{head}.{body[:-4]}{"AAAA" if not body.endswith("AAAA") else "BBBB"}.{sig}'
        code, r = C('POST', '/api/licensing/activate/', {'key': tampered}, ct)
        refusals['tampered'] = (code, r.get('error'))
        self.assertEqual(code, 400)
        code, r = C('POST', '/api/licensing/activate/', {'key': 'hello world'}, ct)
        self.assertEqual(code, 400)
        started = time.monotonic()
        code, act = C('POST', '/api/licensing/activate/', {'key': monthly['key']}, ct)
        self.assertEqual(code, 200, act)
        self.assertLess(time.monotonic() - started, 30, 'an installation-bound key activates without any online call')
        self.assertEqual((act['status'], act['lic_id'], act['tier'], act['expires_on'], act['install_id']),
                         ('VALID', monthly['lic_id'], 'PROFESSIONAL', monthly['expires_on'], self.customer_install))
        self.assertEqual(act['plan']['name'], 'Monthly')
        self.assertEqual(act['limits']['users'], 4)
        code, r = C('POST', '/api/licensing/activate/', {'key': wrong_client['key']}, ct)
        refusals['wrong_client'] = (code, r.get('error'))
        self.assertEqual(code, 400)
        self.assertIn('different client', r['error'])
        ev['F_refusals'] = refusals
        ev['B_activated'] = {k: act[k] for k in ('status', 'lic_id', 'plan', 'tier', 'starts_on', 'expires_on', 'days_left',
                                                  'install_id', 'limits', 'unlimited', 'modules', 'client')}
        code, b = C('POST', '/api/masters/brands/', {'name': 'Clear Optics House Brand', 'code': 'COHB'}, ct)
        self.assertIn(code, (200, 201), b)

        # 5. After the expiry date (customer's own Python + DB, clock pinned, rolled back).
        exp = dt.date.fromisoformat(monthly['expires_on'])
        self.assertEqual(exp, self._months(today, 1))
        on_expiry_day = self.travel(dt.datetime.combine(exp, dt.time(12, 0), tzinfo=dt.timezone.utc))
        after = self.travel(dt.datetime.combine(exp + dt.timedelta(days=2), dt.time(12, 0), tzinfo=dt.timezone.utc))
        self.assertEqual(on_expiry_day['status'], 'VALID')
        self.assertEqual((after['status'], after['read_only'], after['write_status'], after['read_status']),
                         ('EXPIRED', True, 402, 200))
        self.assertIn('Clear Optics House Brand', after['brands'])
        ev['B_expiry'] = {'on_expiry_day': on_expiry_day, 'two_days_after': after}

        # 6. Renewal on the vendor installation, pasted on the customer installation.
        self.customer.down()
        V = self.up(self.vendor, VENDOR_PORTS)
        vt = self.login(V, SA, SA_PW, portal='platform')
        code, lst = V('GET', f'{L}licences/', token=vt)
        lic_pk = next(x['id'] for x in lst['results'] if x['lic_id'] == monthly['lic_id'])
        code, prev = V('POST', f'{L}licences/{lic_pk}/renew/', {'periods': 1}, vt)
        self.assertEqual(code, 200, prev)
        code, renewed = V('POST', f'{L}licences/{lic_pk}/renew/', {'periods': 1, 'confirm': True, 'reason': 'Paid December',
                                                                  'terms': {'limits': {'users': 6}}}, vt)
        self.assertEqual(code, 200, renewed)
        self.assertEqual((renewed['revision'], renewed['expires_on']), (2, self._months(exp, 1).isoformat()))
        others = {p: issue(p, client_id=cid) for p in ('local-quarterly', 'local-half-yearly', 'local-yearly')}
        self.vendor.down()
        C = self.up(self.customer, CUSTOMER_PORTS)
        ct = self.login(C, OWNER, OWNER_PW)
        code, act2 = C('POST', '/api/licensing/activate/', {'key': renewed['key']}, ct)
        self.assertEqual(code, 200, act2)
        self.assertEqual((act2['status'], act2['revision'], act2['expires_on'], act2['limits']['users'], act2['install_id']),
                         ('VALID', 2, renewed['expires_on'], 6, self.customer_install))
        code, r = C('POST', '/api/licensing/activate/', {'key': monthly['key']}, ct)
        self.assertEqual(code, 400, 'the old revision can never be re-installed')
        later = self.travel(dt.datetime.combine(exp + dt.timedelta(days=2), dt.time(12, 0), tzinfo=dt.timezone.utc))
        self.assertEqual(later['status'], 'VALID')
        self.assertIn(later['write_status'], (200, 201))
        self.assertIn('Clear Optics House Brand', later['brands'])
        ev['C_renewal'] = {'activated': {k: act2[k] for k in ('status', 'lic_id', 'revision', 'expires_on', 'limits')},
                           'two_days_after_old_expiry': later}

        # 7. Quarterly / half-yearly / yearly subscriptions for the same customer and installation.
        ev['D_plans'] = {}
        for plan, months in (('local-quarterly', 3), ('local-half-yearly', 6), ('local-yearly', 12)):
            lic = others[plan]
            self.assertEqual(lic['expires_on'], self._months(today, months).isoformat())
            code, a = C('POST', '/api/licensing/activate/', {'key': lic['key']}, ct)
            self.assertEqual(code, 200, a)
            self.assertEqual((a['status'], a['lic_id'], a['expires_on']), ('VALID', lic['lic_id'], lic['expires_on']))
            ev['D_plans'][plan] = {'lic_id': a['lic_id'], 'expires_on': a['expires_on'], 'days_left': a['days_left']}
        code, brands = C('GET', '/api/masters/brands/', token=ct)
        self.assertIn('Clear Optics House Brand', json.dumps(brands))
        ev['data_intact'] = True
        ev['finished'] = time.strftime('%Y-%m-%dT%H:%M:%S')

    @staticmethod
    def _months(day, n):
        sys.path.insert(0, str(WIN.parent / 'backend'))
        from apps.vendor_licensing.tokens import add_months
        return add_months(day, n)
