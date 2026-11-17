"""Local Super Admin + Client Management on a real Windows stack built from the STAGED payload.

Same path the NSIS wizard runs (engine `install`, services/firewall/ACLs left out as non-elevated),
then exactly what the owner does:
  gtrade-ctl create-superadmin (password on stdin) -> idempotent re-run -> --status
  HTTPS via nginx: /api/auth/login/ portal=platform -> Client Management summary/catalog ->
  create client -> client admin signs in -> suspend (client refused) -> reactivate ->
  client admin cannot reach licence admin / server backups / Client Management ->
  data isolation between the installation company and the client -> Django admin is off ->
  COLD stop of nginx/app/PostgreSQL (a Windows restart) -> cold start -> Local Super Admin and
  client still sign in, client still listed.
Everything is loopback: the stack never needs the internet.

Opt-in (slow: full migration): GTRADE_E2E=1, after restaging windows/out/stage.
"""

import json
import os
import shutil
import ssl
import subprocess
import tempfile
import time
import unittest
import urllib.error
import urllib.request
import uuid
from pathlib import Path

from tests.stack import STAGE, Stack

EVIDENCE = Path(__file__).resolve().parents[1] / 'out' / 'evidence'
OWNER, OWNER_PW = 'owner', 'Own-' + uuid.uuid4().hex[:12] + '!9'
SA, SA_PW = 'localsa', 'Sa-' + uuid.uuid4().hex[:12] + '!9'
CLIENT_ADMIN, CLIENT_PW = 'lakeadmin', 'Cl-' + uuid.uuid4().hex[:12] + '!9'
PORTS = dict(https_port=18493, app_port=18051, db_port=15594)


@unittest.skipUnless(os.environ.get('GTRADE_E2E') == '1' and (STAGE / 'runtime' / 'python' / 'python.exe').exists(),
                     'set GTRADE_E2E=1 after building windows/out/stage')
class LocalSuperAdminE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-sa-'))
        cls.stack = Stack(cls.tmp / 'data', **PORTS)
        cls.evidence = {'started': time.strftime('%Y-%m-%dT%H:%M:%S'), 'steps': {}}
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
        cls.install_exit = proc.returncode
        cls.install_tail = (proc.stdout[-1500:], proc.stderr[-1500:])
        cls.evidence['install_exit'] = proc.returncode
        cls.stack.start_app()
        cls.stack.start_web()
        cls.stack.wait_health()
        cls.ctx = ssl.create_default_context(cafile=str(cls.stack.data_root / 'config' / 'tls' / 'ca.crt'))
        cls.base = f'https://localhost:{PORTS["https_port"]}'

    @classmethod
    def tearDownClass(cls):
        try:
            cls.stack.down()
        finally:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            (EVIDENCE / 'superadmin_e2e.json').write_text(json.dumps(cls.evidence, indent=1, default=str))
            shutil.rmtree(cls.tmp, ignore_errors=True)

    # ---- helpers ------------------------------------------------------------------------------
    def ctl_stdin(self, args, stdin_text):
        proc = subprocess.run([str(self.stack.python), '-m', 'gtrade_ctl', '--install-root', str(STAGE),
                               '--data-root', str(self.stack.data_root), *args],
                              input=stdin_text, env=self.stack.env(), capture_output=True, text=True, timeout=600,
                              encoding='utf-8', errors='replace')
        try:
            data = json.loads(proc.stdout)
        except ValueError:
            data = {'raw': proc.stdout[-1500:], 'err': proc.stderr[-1500:]}
        return proc.returncode, data

    def call(self, method, path, body=None, token=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method)
        req.add_header('Content-Type', 'application/json')
        if token:
            req.add_header('Authorization', f'Bearer {token}')
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=120) as r:
                code, raw = r.status, r.read()
        except urllib.error.HTTPError as e:
            code, raw = e.code, e.read()
        try:
            return code, (json.loads(raw) if raw else None)
        except ValueError:
            return code, raw[:300]

    def login(self, username, password, portal=None, expect=200):
        body = {'username': username, 'password': password}
        if portal:
            body['portal'] = portal
        code, res = self.call('POST', '/api/auth/login/', body)
        self.assertEqual(code, expect, res)
        if code != 200:
            return None
        token = res['access']
        self.call('POST', '/api/security/reauth/', {'password': password}, token)  # sensitive writes
        return token

    # ---- the flow (one ordered test: each step builds on the previous) -----------------------
    def test_local_super_admin_full_flow(self):
        self.assertEqual(self.install_exit, 0, self.install_tail)
        ev = self.evidence['steps']

        # 1. bootstrap (password on stdin, never argv), idempotent, status
        code, res = self.ctl_stdin(['create-superadmin', '--user', SA, '--full-name', 'Local Owner'], SA_PW + '\n')
        self.assertEqual(code, 0, res)
        self.assertTrue(res['created'], res)
        code, res = self.ctl_stdin(['create-superadmin', '--user', SA], SA_PW + '\n')
        self.assertEqual((code, res.get('created')), (0, False), res)
        code, res = self.ctl_stdin(['create-superadmin', '--user', 'another'], SA_PW + '\n')
        self.assertEqual(code, 1, res)
        code, res = self.ctl_stdin(['create-superadmin', '--status'], '')
        self.assertEqual([a['username'] for a in res['super_admins']], [SA], res)
        ev['bootstrap'] = 'created once; re-run no-op; second name refused; status lists one'

        # 2. Local Super Admin signs in on the platform portal; the company owner may not
        sa = self.login(SA, SA_PW, portal='platform')
        self.login(OWNER, OWNER_PW, portal='platform', expect=403)
        code, summary = self.call('GET', '/api/superadmin/tenants/summary/', token=sa)
        self.assertEqual(code, 200, summary)
        self.assertEqual(summary['edition'], 'local')
        code, catalog = self.call('GET', '/api/superadmin/tenants/catalog/', token=sa)
        self.assertEqual(code, 200)
        ev['login'] = {'summary_license': summary.get('license')}

        # 3. create a client
        code, client = self.call('POST', '/api/superadmin/tenants/', {
            'tenant_name': 'Lakeview Optics', 'admin_username': CLIENT_ADMIN, 'password': CLIENT_PW,
            'branch_name': 'Main', 'max_users': 3, 'country': 'IN'}, sa)
        self.assertEqual(code, 201, client)
        cid = client['id']
        code, listing = self.call('GET', '/api/superadmin/tenants/?search=Lakeview&page=1', token=sa)
        self.assertEqual(code, 200)
        self.assertIn('Lakeview Optics', json.dumps(listing))
        code, res = self.call('PATCH', f'/api/superadmin/tenants/{cid}/', {'owner_name': 'Ravi K'}, sa)
        self.assertEqual(code, 200, res)
        code, res = self.call('POST', f'/api/superadmin/tenants/{cid}/users/',
                              {'username': 'lakecash', 'password': CLIENT_PW, 'role': 'CASHIER'}, sa)
        self.assertEqual(code, 201, res)
        ev['client'] = {'id': cid, 'code': client.get('code')}

        # 4. client admin signs in; suspend -> refused; reactivate -> works
        client_token = self.login(CLIENT_ADMIN, CLIENT_PW)
        code, res = self.call('POST', f'/api/superadmin/tenants/{cid}/deactivate/',
                              {'category': 'NON_PAYMENT', 'reason': 'Unpaid subscription'}, sa)
        self.assertEqual(code, 200, res)
        code, _ = self.call('POST', '/api/auth/login/', {'username': CLIENT_ADMIN, 'password': CLIENT_PW})
        self.assertNotEqual(code, 200)
        code, res = self.call('POST', f'/api/superadmin/tenants/{cid}/reactivate/', {'reason': 'Paid'}, sa)
        self.assertEqual(code, 200, res)
        client_token = self.login(CLIENT_ADMIN, CLIENT_PW)
        ev['lifecycle'] = 'suspended client refused at login; reactivated client signs in'

        # 5. client admin cannot reach installation-level administration
        self.assertEqual(self.call('GET', '/api/superadmin/tenants/', token=client_token)[0], 403)
        self.assertEqual(self.call('POST', '/api/licensing/import/', {'license': 'x'}, client_token)[0], 403)
        self.assertEqual(self.call('GET', '/api/local/backups/', token=client_token)[0], 403)
        code, lic = self.call('GET', '/api/licensing/status/', token=client_token)
        self.assertEqual(code, 200)
        self.assertFalse(lic['can_manage'])

        # 6. data isolation between the installation company and the client
        owner = self.login(OWNER, OWNER_PW)
        code, brand = self.call('POST', '/api/masters/brands/', {'name': 'OwnerBrandE2E', 'code': 'OBE2E'}, owner)
        self.assertIn(code, (200, 201), brand)
        code, rows = self.call('GET', '/api/masters/brands/', token=client_token)
        self.assertNotIn('OwnerBrandE2E', json.dumps(rows))
        self.assertEqual(self.call('GET', f'/api/masters/brands/{brand["id"]}/', token=client_token)[0], 404)
        ev['isolation'] = 'client cannot list/read the owner company brand'

        # 7. Django admin is off behind nginx
        code, _ = self.call('GET', '/admin/')
        self.assertEqual(code, 404)

        # 8. cold restart (what a Windows restart does), then everything still works
        self.stack.down()
        self.stack.start_db()
        self.stack.start_app()
        self.stack.start_web()
        self.assertTrue(self.stack.wait_health().get('ok'))
        sa = self.login(SA, SA_PW, portal='platform')
        code, listing = self.call('GET', '/api/superadmin/tenants/?search=Lakeview&page=1', token=sa)
        self.assertEqual(code, 200)
        self.assertIn('Lakeview Optics', json.dumps(listing))
        self.login(CLIENT_ADMIN, CLIENT_PW)
        self.login(OWNER, OWNER_PW)
        ev['cold_restart'] = 'Local Super Admin, client admin and owner sign in; client still listed'


if __name__ == '__main__':
    unittest.main()
