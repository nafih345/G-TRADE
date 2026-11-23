"""Vendor licence keys, end to end, with REAL servers on this PC (no stubs):

  vendor side   the cloud console (config.settings, `manage.py runserver`) on a disposable PostgreSQL 17
                cluster, signing with a throwaway development Ed25519 key (gtl-dev-e2e, never a
                production key) -> Vendor Super Admin signs in, creates a plan and Windows Local
                clients + licences through the real API;
  customer side the STAGED Windows stack (embedded Python, PostgreSQL, nginx, HTTPS), installed by
                `gtrade-ctl install` like the NSIS wizard does, using a copy of the staged app WITHOUT
                the release marker (development keys are refused in a release build), pointed at the
                vendor server as its licence authority.

Flow: evaluation -> key bound to another installation refused -> tampered key refused -> unbound key
activated by copy/paste (signature verified locally, bound online) -> the same key on a second
installation refused by the authority -> renewal and plan upgrade delivered by "Check with vendor"
-> suspension (read-only, writes 402) and reactivation -> another client's key refused -> offline
activation by licence FILE of an installation-bound key after moving the licence (replacement key)
-> revocation. Evidence: windows/out/evidence/licence_activation_e2e.json.

Opt-in (slow: two full migrations): GTRADE_E2E=1, after restaging windows/out/stage.

PRODUCTION mode (after the cloud deploy + key ceremony + rebuild with the production public key):
    GTRADE_E2E=1 GTRADE_LIC_E2E_VENDOR_URL=https://g-trade-backend.onrender.com
    GTRADE_LIC_E2E_VENDOR_USER=<vendor console user> GTRADE_LIC_E2E_VENDOR_PASSWORD=<password>
uses the REAL licence authority and the staged app exactly as shipped (release marker, embedded
production public key, default production authority URL, no dev mode). It creates only "ZZ TEST"
plans / clients / licences, revokes every test licence and deactivates the test plans at the end.
The vendor server cannot be stopped there, so the offline file import is checked without the
"check-in fails" step.
"""

import base64
import json
import os
import secrets
import shutil
import ssl
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from tests.stack import STAGE, Stack

WIN = Path(__file__).resolve().parents[1]
ROOT = WIN.parent
BACKEND = ROOT / 'backend'
VENV_PY = BACKEND / 'venv' / 'Scripts' / 'python.exe'
EVIDENCE = WIN / 'out' / 'evidence'
OWNER, OWNER_PW = 'owner', 'Own-' + uuid.uuid4().hex[:12] + '!9'
VENDOR, VENDOR_PW = 'vendor', 'Vend-' + uuid.uuid4().hex[:12] + '!9'
PORTS = dict(https_port=18497, app_port=18057, db_port=15597)
VENDOR_DB_PORT, VENDOR_HTTP_PORT = 57490, 18096
OTHER_INSTALL = '0f0f0f0f-aaaa-4222-8333-444455556666'
PROD_URL = os.environ.get('GTRADE_LIC_E2E_VENDOR_URL', '').rstrip('/')
PROD = bool(PROD_URL)
if PROD:
    VENDOR = os.environ.get('GTRADE_LIC_E2E_VENDOR_USER', '')
    VENDOR_PW = os.environ.get('GTRADE_LIC_E2E_VENDOR_PASSWORD', '')
TAG = ('ZZ TEST ' + time.strftime('%m%d%H%M')) if PROD else ''


class LicenceStack(Stack):
    extra: dict = {}

    def env(self, app_dir=None):
        env = super().env(app_dir)
        env.update(self.extra)
        return env


def _http(method, url, body=None, token=None, ctx=None, timeout=120):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Content-Type', 'application/json')
    if token:
        req.add_header('Authorization', f'Bearer {token}')
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
            code, raw = r.status, r.read()
    except urllib.error.HTTPError as e:
        code, raw = e.code, e.read()
    try:
        return code, (json.loads(raw) if raw else None)
    except ValueError:
        return code, raw[:300]


@unittest.skipUnless(os.environ.get('GTRADE_E2E') == '1' and (STAGE / 'runtime' / 'python' / 'python.exe').exists()
                     and VENV_PY.exists(), 'set GTRADE_E2E=1 after building windows/out/stage (needs backend/venv)')
class LicenceActivationE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-lic-e2e-'))
        cls.evidence = {'started': time.strftime('%Y-%m-%dT%H:%M:%S'), 'steps': {}}
        cls.procs = []
        cls.pg = None
        cls.vendor_token = None
        cls.made = {'licences': [], 'plans': []}
        try:
            if PROD:
                if not (PROD_URL.startswith('https://') and VENDOR and VENDOR_PW):
                    raise RuntimeError('production mode needs an https vendor URL, user and password')
                cls.vendor = PROD_URL
                cls.evidence['mode'] = 'production'
                cls.evidence['vendor_health'] = _http('GET', f'{cls.vendor}/api/licence-authority/v1/health')[1]
            else:
                cls.evidence['mode'] = 'local vendor + dev key'
                cls._start_vendor()
            cls._start_windows()
        except Exception:
            cls._cleanup()
            raise

    # ---- vendor (cloud console) ---------------------------------------------------------------
    @classmethod
    def _start_vendor(cls):
        sys.path.insert(0, str(WIN))
        from gtrade_ctl.pg import PgRuntime, find_free_port, find_pg_bin
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        key = Ed25519PrivateKey.generate()
        pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                serialization.NoEncryption()).decode('ascii')
        pub = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw,
                                                             serialization.PublicFormat.Raw)).decode('ascii')
        (cls.tmp / 'vendor-signing.pem').write_text(pem, encoding='ascii')
        cls.pubfile = cls.tmp / 'pubkeys.json'
        cls.pubfile.write_text(json.dumps({'gtl-dev-e2e': pub}), encoding='utf-8')

        port = find_free_port(VENDOR_DB_PORT)
        su_pw, app_pw = secrets.token_urlsafe(24), secrets.token_urlsafe(24)
        cls.pg = PgRuntime(find_pg_bin(), cls.tmp / 'vendor-pg' / 'data', port, cls.tmp / 'vendor-pg-logs')
        cls.pg.initdb(su_pw)
        cls.pg.start()
        cls.pg.wait_ready()
        cls.pg.psql(f"CREATE ROLE vendor LOGIN PASSWORD '{app_pw}'; CREATE DATABASE vendor OWNER vendor;",
                    user='postgres', password=su_pw)
        env = {k: v for k, v in os.environ.items()
               if not k.startswith(('GTRADE_', 'DATABASE_URL', 'POSTGRES_', 'DB_', 'EXPECTED_DATABASE', 'DJANGO_'))}
        for k in ('VERCEL', 'RENDER', 'RENDER_EXTERNAL_HOSTNAME', 'AWS_LAMBDA_FUNCTION_NAME', 'ELECTRON_RUN_AS_NODE'):
            env.pop(k, None)
        env.update(DJANGO_SETTINGS_MODULE='config.settings', SECRET_KEY=secrets.token_urlsafe(64), DEBUG='True',
                   DATABASE_URL=f'postgres://vendor:{app_pw}@127.0.0.1:{port}/vendor?sslmode=disable',
                   AUTO_MIGRATE='False', BACKUP_SCHEDULER='False', OPENBLAS_NUM_THREADS='1', PYTHONUTF8='1',
                   GTRADE_LICENSE_SIGNING_KEY_ID='gtl-dev-e2e',
                   GTRADE_LICENSE_SIGNING_KEY_FILE=str(cls.tmp / 'vendor-signing.pem'))
        cls.vendor_env = env
        mig = subprocess.run([str(VENV_PY), 'manage.py', 'migrate', '--noinput'], cwd=BACKEND, env=env,
                             capture_output=True, text=True, timeout=1800, encoding='utf-8', errors='replace')
        if mig.returncode != 0:
            raise RuntimeError(f'vendor migrate failed: {mig.stderr[-2000:]}')
        make_admin = ("from django.contrib.auth import get_user_model; from apps.common.models import Tenant; "
                      f"get_user_model().objects.create_superuser({VENDOR!r}, password={VENDOR_PW!r}, "
                      "tenant=Tenant.objects.get(pk=1))")
        sh = subprocess.run([str(VENV_PY), 'manage.py', 'shell', '-c', make_admin], cwd=BACKEND, env=env,
                            capture_output=True, text=True, timeout=600, encoding='utf-8', errors='replace')
        if sh.returncode != 0:
            raise RuntimeError(f'vendor admin failed: {sh.stderr[-2000:]}')
        cls.vendor_port = find_free_port(VENDOR_HTTP_PORT)
        log = open(cls.tmp / 'vendor-server.log', 'wb')
        cls._vendor_log = log
        cls.procs.append(subprocess.Popen([str(VENV_PY), 'manage.py', 'runserver', f'127.0.0.1:{cls.vendor_port}',
                                           '--noreload'], cwd=BACKEND, env=env, stdout=log, stderr=subprocess.STDOUT))
        cls.vendor = f'http://127.0.0.1:{cls.vendor_port}'
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                code, body = _http('GET', f'{cls.vendor}/api/licence-authority/v1/health', timeout=5)
                if code == 200:
                    cls.evidence['vendor_health'] = body
                    return
            except OSError:
                pass
            time.sleep(1)
        raise RuntimeError('vendor server did not start')

    # ---- customer (staged Windows stack) ------------------------------------------------------
    @classmethod
    def _start_windows(cls):
        # Local mode: a copy of the staged app without the release marker (dev keys are refused in a
        # release build). Production mode: the staged app exactly as shipped.
        if PROD:
            cls.dev_app = STAGE / 'app' / '1.0.0'
            if not (cls.dev_app / 'RELEASE').is_file():
                raise RuntimeError('production mode needs the release-marked staged app')
        else:
            cls.dev_app = cls.tmp / 'app-dev' / '1.0.0'
            shutil.copytree(STAGE / 'app' / '1.0.0', cls.dev_app)
            (cls.dev_app / 'RELEASE').unlink(missing_ok=True)
        cls.stack = LicenceStack(cls.tmp / 'data', **PORTS)
        answers = cls.tmp / 'answers.json'
        answers.write_text(json.dumps({'company_name': 'Sunrise Opticals', 'branch_name': 'MG Road',
                                       'admin_username': OWNER, 'admin_password': OWNER_PW,
                                       'admin_full_name': 'Store Owner', 'admin_email': 'owner@example.invalid'}))
        env = cls.stack.env()
        env['GTRADE_CLIENT_DIR'] = str(cls.tmp / 'client')
        proc = subprocess.run([str(cls.stack.python), '-m', 'gtrade_ctl', '--install-root', str(STAGE),
                               '--data-root', str(cls.stack.data_root), 'install', '--mode', 'standalone',
                               '--version', '1.0.0', '--https-port', str(PORTS['https_port']),
                               '--app-port', str(PORTS['app_port']), '--db-port', str(PORTS['db_port']),
                               '--answers', str(answers), '--no-services', '--no-firewall', '--no-acl'],
                              env=env, capture_output=True, text=True, timeout=1800, encoding='utf-8', errors='replace')
        if proc.returncode != 0:
            raise RuntimeError(f'install failed: {proc.stdout[-1500:]} {proc.stderr[-1500:]}')
        sys.path.insert(0, str(WIN))
        from gtrade_ctl import install_config
        cls.install_id = install_config.read_env(cls.stack.data_root / 'config' / 'gtrade.env')['GTRADE_INSTALL_ID']
        # Production mode: nothing injected; settings_local's default production authority URL applies.
        LicenceStack.extra = {} if PROD else {
            'GTRADE_LICENSE_DEV_MODE': '1', 'GTRADE_LICENSE_DEV_PUBKEYS': str(cls.pubfile),
            'GTRADE_LICENSE_SERVICE_URL': f'{cls.vendor}/api/licence-authority'}
        cls.stack.stop_app()
        cls.stack.start_app(app_dir=cls.dev_app)
        cls.stack.start_web()
        cls.stack.wait_health()
        cls.ctx = ssl.create_default_context(cafile=str(cls.stack.data_root / 'config' / 'tls' / 'ca.crt'))
        cls.base = f'https://localhost:{PORTS["https_port"]}'

    @classmethod
    def _cleanup(cls):
        try:
            if getattr(cls, 'stack', None):
                cls.stack.down()
        finally:
            for p in cls.procs:
                p.terminate()
                try:
                    p.wait(20)
                except subprocess.TimeoutExpired:
                    p.kill()
            if getattr(cls, '_vendor_log', None):
                cls._vendor_log.close()
            if cls.pg is not None:
                try:
                    cls.pg.stop('immediate')
                except Exception:
                    pass
            shutil.rmtree(cls.tmp, ignore_errors=True)

    @classmethod
    def _cleanup_production_records(cls):
        """Production mode: revoke every test licence and deactivate the test plans (best effort)."""
        if not (PROD and cls.vendor_token):
            return
        L = f'{cls.vendor}/api/superadmin/licensing/'
        for lic in cls.made['licences']:
            _http('POST', f"{L}licences/{lic['id']}/revoke/", {'reason': 'Automated production licence test',
                                                              'confirm_lic_id': lic['lic_id']}, cls.vendor_token)
        for plan in cls.made['plans']:
            _http('POST', f"{L}plans/{plan['id']}/deactivate/", {}, cls.vendor_token)
        cls.evidence['cleanup'] = {'revoked': [l['lic_id'] for l in cls.made['licences']],
                                   'plans_deactivated': [p['code'] for p in cls.made['plans']]}

    @classmethod
    def tearDownClass(cls):
        try:
            cls._cleanup_production_records()
        except Exception as exc:  # never hide the test result behind cleanup
            cls.evidence['cleanup_error'] = repr(exc)
        try:
            cls._cleanup()
        finally:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            (EVIDENCE / 'licence_activation_e2e.json').write_text(json.dumps(cls.evidence, indent=1, default=str))

    # ---- helpers ------------------------------------------------------------------------------
    def win(self, method, path, body=None, token=None):
        return _http(method, self.base + path, body, token, ctx=self.ctx)

    def ven(self, method, path, body=None, token=None):
        return _http(method, self.vendor + path, body, token)

    def login(self, call, username, password):
        code, res = call('POST', '/api/auth/login/', {'username': username, 'password': password})
        self.assertEqual(code, 200, res)
        token = res['access']
        call('POST', '/api/security/reauth/', {'password': password}, token)
        return token

    # ---- the flow ------------------------------------------------------------------------------
    def test_vendor_key_to_windows_activation(self):
        ev = self.evidence['steps']
        L = '/api/superadmin/licensing/'
        vt = self.login(self.ven, VENDOR, VENDOR_PW)
        type(self).vendor_token = vt
        code, cat = self.ven('GET', f'{L}catalog/', token=vt)
        self.assertEqual(code, 200, cat)
        self.assertTrue(cat['signing']['configured'], cat['signing'])
        if PROD:
            self.assertFalse(cat['signing']['key_id'].startswith('gtl-dev-'), 'production signs with a production key')
        else:
            self.assertEqual(cat['signing']['key_id'], 'gtl-dev-e2e')
        ev['signing_key_id'] = cat['signing']['key_id']
        plan_body = {'name': f'{TAG} Windows Pro Yearly'.strip(), 'edition': 'WINDOWS_LOCAL', 'billing_cycle': 'YEARLY', 'duration': 1,
                     'price': '15000.00', 'currency': 'INR', 'max_clients': 0, 'max_companies': 1, 'max_branches': 2,
                     'max_users': 3, 'modules': ['optical', 'sales', 'inventory', 'purchase', 'accounts', 'admin',
                                                 'reports', 'settings']}
        code, plan = self.ven('POST', f'{L}plans/', plan_body, vt)
        self.assertEqual(code, 201, plan)
        self.made['plans'].append(plan)
        code, plan_max = self.ven('POST', f'{L}plans/', {**plan_body, 'name': f'{TAG} Windows Max Yearly'.strip(),
                                                         'max_users': None, 'max_branches': 10}, vt)
        self.assertEqual(code, 201, plan_max)
        self.made['plans'].append(plan_max)

        def issue(name, installation='', starts_on=None):
            body = {'plan_id': plan['id'], 'installation': installation,
                    'client': {'name': f'{TAG} {name}'.strip(), 'owner_name': 'Owner'}}
            if starts_on:
                body['starts_on'] = starts_on
            c, lic = self.ven('POST', f'{L}licences/', body, vt)
            self.assertEqual(c, 201, lic)
            self.made['licences'].append(lic)
            return lic
        lic_a = issue('Sunrise Opticals')                    # unbound: first online activation binds it
        lic_other = issue('Elsewhere Optics', OTHER_INSTALL)  # bound to another installation
        lic_foreign = issue('Another Client', self.install_id)
        lic_expired = issue('Lapsed Optics', self.install_id, starts_on='2023-01-01')  # yearly: ended 2023-12-31
        ev['vendor'] = {'plans': [plan['code'], plan_max['code']], 'licences': [lic_a['lic_id'], lic_other['lic_id'],
                                                                                lic_foreign['lic_id']],
                        'key_length': len(lic_a['key'])}

        ot = self.login(self.win, OWNER, OWNER_PW)
        code, st = self.win('GET', '/api/licensing/status/', token=ot)
        self.assertEqual((code, st['status']), (200, 'EVALUATION'), st)
        self.assertEqual(st['install_id'], self.install_id)
        ev['evaluation'] = {'status': st['status'], 'days_left': st['days_left']}

        # Refusals, verified locally (signature + binding), nothing installed.
        code, res = self.win('POST', '/api/licensing/activate/', {'key': lic_other['key']}, ot)
        self.assertEqual(code, 400, res)
        self.assertIn('bound to another installation', res['error'])
        head, body, sig = lic_a['key'].split('.')
        payload = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)))
        payload['limits']['users'] = 999
        forged = head + '.' + base64.urlsafe_b64encode(json.dumps(payload).encode()).rstrip(b'=').decode() + '.' + sig
        code, res = self.win('POST', '/api/licensing/activate/', {'key': forged}, ot)
        self.assertEqual(code, 400, res)
        self.assertIn('signature', res['error'])
        code, res = self.win('POST', '/api/licensing/activate/', {'key': lic_expired['key']}, ot)
        self.assertEqual(code, 400, res)
        self.assertIn('expired', res['error'])
        # A licence signed by any other key under a development key id: never trusted by this build
        # (production mode: release build ignores gtl-dev-* entirely).
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        payload_dev = {**payload, 'limits': {'users': 999}, 'install_id': self.install_id, 'key_id': 'gtl-dev-e2e'}
        sys.path.insert(0, str(BACKEND))
        from apps.licensing import licfmt
        dev_key = licfmt.encode(payload_dev, 'GTL1', Ed25519PrivateKey.generate().sign)
        code, res = self.win('POST', '/api/licensing/activate/', {'key': dev_key}, ot)
        self.assertEqual(code, 400, res)
        ev['refusals'] = {'other_installation': True, 'tampered': True, 'expired': True,
                          'foreign_dev_signed': res['error']}

        # Copy / paste activation of the unbound key (wrapped like an e-mail would).
        pasted = '\n'.join(lic_a['key'][i:i + 76] for i in range(0, len(lic_a['key']), 76))
        code, st = self.win('POST', '/api/licensing/activate/', {'key': pasted}, ot)
        self.assertEqual(code, 200, st)
        self.assertEqual(st['status'], 'VALID', st)
        self.assertEqual(st['plan']['name'], 'Windows Pro Yearly')
        self.assertEqual(st['client']['id'], lic_a['client']['client_code'])
        self.assertEqual(st['binding'], 'INSTALLATION')
        self.assertEqual(st['limits']['users'], 3)
        self.assertEqual(st['expires_on'], lic_a['expires_on'])
        code, row = self.ven('GET', f"{L}licences/{lic_a['id']}/", token=vt)
        self.assertEqual(row['activation_status'], 'ACTIVATED')
        self.assertEqual(row['install_id'], self.install_id)
        self.assertTrue(row['hardware_bound'])
        ev['activated'] = {'status': st['status'], 'revision': st['revision'], 'install_id': row['install_id']}

        # The same key from a second installation: refused by the authority.
        code, res = self.ven('POST', '/api/licence-authority/v1/activate',
                             {'key': lic_a['key'], 'install_id': OTHER_INSTALL, 'fp': {'v': 1, 'hashes': {}}})
        self.assertEqual(code, 409, res)
        ev['second_installation'] = res['error']

        # Renewal and upgrade arrive through "Check with vendor".
        code, out = self.ven('POST', f"{L}licences/{lic_a['id']}/renew/", {'periods': 1, 'confirm': True}, vt)
        self.assertEqual(code, 200, out)
        code, st = self.win('POST', '/api/licensing/checkin/', token=ot)
        self.assertEqual(code, 200, st)
        self.assertEqual(st['expires_on'], out['expires_on'])
        code, prev = self.ven('POST', f"{L}licences/{lic_a['id']}/change-plan/", {'plan_id': plan_max['id']}, vt)
        self.assertEqual(prev['preview']['classification'], 'UPGRADE', prev)
        code, out = self.ven('POST', f"{L}licences/{lic_a['id']}/change-plan/", {'plan_id': plan_max['id'],
                                                                                'confirm': True}, vt)
        self.assertEqual(code, 200, out)
        code, st = self.win('POST', '/api/licensing/checkin/', token=ot)
        self.assertIn('users', st['unlimited'], st)
        self.assertEqual(st['plan']['name'], 'Windows Max Yearly')
        ev['renew_upgrade'] = {'expires_on': st['expires_on'], 'plan': st['plan']['name'], 'revision': st['revision']}

        # Suspension: read-only (writes 402, reads fine), then reactivation.
        self.ven('POST', f"{L}licences/{lic_a['id']}/suspend/", {'reason': 'Invoice overdue'}, vt)
        code, st = self.win('POST', '/api/licensing/checkin/', token=ot)
        self.assertEqual((st['status'], st['read_only']), ('SUSPENDED', True), st)
        code, _ = self.win('POST', '/api/masters/brands/', {'name': 'Blocked'}, ot)
        self.assertEqual(code, 402)
        self.assertEqual(self.win('GET', '/api/masters/brands/', token=ot)[0], 200)
        self.ven('POST', f"{L}licences/{lic_a['id']}/reactivate/", {'reason': 'Paid'}, vt)
        code, st = self.win('POST', '/api/licensing/checkin/', token=ot)
        self.assertEqual(st['status'], 'VALID', st)
        # Writes reach the application again (not the licence's 402), whatever the form validation says.
        self.assertNotEqual(self.win('POST', '/api/masters/brands/', {'name': 'Allowed'}, ot)[0], 402)
        ev['suspend_reactivate'] = 'SUSPENDED read-only (402 on write) -> VALID'

        # Another client's licence (even bound to THIS installation) is refused.
        code, res = self.win('POST', '/api/licensing/import/', {'license': lic_foreign['key']}, ot)
        self.assertEqual(code, 400, res)
        self.assertIn('different client', res['error'])
        ev['cross_client'] = res['error']

        # Offline: the vendor re-binds licence A to this installation id explicitly (replacement key)
        # and the customer imports it as a FILE with the server unable to reach the vendor.
        code, rep = self.ven('POST', f"{L}licences/{lic_a['id']}/replace-key/",
                             {'reason': 'Offline file', 'installation': self.install_id}, vt)
        self.assertEqual(code, 200, rep)
        if not PROD:
            self.procs[0].terminate()  # the vendor goes offline
            self.procs[0].wait(20)
        code, st = self.win('POST', '/api/licensing/import/', {'license': rep['key'] + '\n'}, ot)
        self.assertEqual(code, 200, st)
        self.assertEqual((st['status'], st['revision']), ('VALID', rep['revision']), st)
        ev['offline_file'] = {'revision': st['revision']}
        if not PROD:
            code, res = self.win('POST', '/api/licensing/checkin/', token=ot)
            self.assertEqual(code, 502, res)
            ev['offline_file']['checkin_offline'] = res.get('error')
            # Revocation (vendor back online): read-only.
            self.procs[0] = subprocess.Popen([str(VENV_PY), 'manage.py', 'runserver', f'127.0.0.1:{self.vendor_port}',
                                              '--noreload'], cwd=BACKEND, env=self.vendor_env,
                                             stdout=self._vendor_log, stderr=subprocess.STDOUT)
            for _ in range(60):
                try:
                    if _http('GET', f'{self.vendor}/api/licence-authority/v1/health', timeout=5)[0] == 200:
                        break
                except OSError:
                    time.sleep(1)
            vt = self.login(self.ven, VENDOR, VENDOR_PW)
            type(self).vendor_token = vt
        code, out = self.ven('POST', f"{L}licences/{lic_a['id']}/revoke/", {'reason': 'Refund',
                                                                           'confirm_lic_id': lic_a['lic_id']}, vt)
        self.assertEqual(code, 200, out)
        self.made['licences'] = [l for l in self.made['licences'] if l['id'] != lic_a['id']]
        code, st = self.win('POST', '/api/licensing/checkin/', token=ot)
        self.assertEqual((st['status'], st['read_only']), ('REVOKED', True), st)
        code, audit = self.ven('GET', f"{L}audit/?licence={lic_a['id']}", token=vt)
        actions = {a['action'] for a in audit}
        for a in ('LICENCE_CREATED', 'ACTIVATED', 'ACTIVATION_REFUSED', 'RENEWED', 'PLAN_UPGRADED', 'LICENCE_SUSPENDED',
                  'LICENCE_REACTIVATED', 'KEY_REPLACED', 'LICENCE_REVOKED', 'CHECKIN'):
            self.assertIn(a, actions)
        ev['revoked'] = {'status': st['status'], 'audit_actions': sorted(actions)}
        self.evidence['result'] = 'PASS'
