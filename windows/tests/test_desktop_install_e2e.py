"""Phase 5 + 6 on real Windows (opt-in, GTRADE_E2E=1):

* `gtrade-ctl install --mode standalone --no-services` from the staged payload (real SPA) into a
  disposable data root: every installer step except service registration (needs elevation).
* Start app + nginx exactly as the services would, then drive the **real Electron app**:
  pinned TLS, sandbox/contextIsolation, bridge surface, blocked navigation, real login.
* Rogue CA in client.json -> the window must refuse the server (offline page, TLS error).
* LAN workstation pairing with `gtrade-ctl pair`: right code accepted, wrong code refused.
Evidence: windows/out/evidence/desktop_install_e2e.json
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from tests.stack import STAGE, Stack

WIN = Path(__file__).resolve().parents[1]
DESKTOP = WIN / 'desktop'
ELECTRON = DESKTOP / 'node_modules' / 'electron' / 'dist' / 'electron.exe'
EVIDENCE = WIN / 'out' / 'evidence'
ADMIN_USER = 'shopowner'
ADMIN_PASS = 'Gtrade-e2e-Pass-2026!'


def electron_smoke(client_config: Path, user_data: Path, out_file: Path, login=True, timeout=120) -> dict:
    env = {k: v for k, v in os.environ.items() if k != 'ELECTRON_RUN_AS_NODE'}
    env['GTRADE_CLIENT_CONFIG'] = str(client_config)
    if login:
        env.update(GTRADE_SMOKE_USER=ADMIN_USER, GTRADE_SMOKE_PASS=ADMIN_PASS)
    subprocess.run([str(ELECTRON), str(DESKTOP), f'--user-data-dir={user_data}', f'--smoke-test={out_file}'],
                   env=env, timeout=timeout, capture_output=True)
    return json.loads(out_file.read_text()) if out_file.exists() else {'ok': False, 'error': 'no smoke output'}


@unittest.skipUnless(os.environ.get('GTRADE_E2E') == '1' and ELECTRON.exists()
                     and (STAGE / 'app' / '1.0.0' / 'frontend' / 'index.html').exists(), 'set GTRADE_E2E=1 and build first')
class DesktopInstallE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-p56-'))
        os.environ['GTRADE_CLIENT_DIR'] = str(cls.tmp / 'client')
        cls.stack = Stack(cls.tmp / 'data', https_port=18453, app_port=18011, db_port=15554)
        cls.evidence = {'started': time.strftime('%Y-%m-%dT%H:%M:%S')}
        answers = cls.tmp / 'answers.json'
        answers.write_text(json.dumps({'company_name': 'Sunrise Opticals', 'branch_name': 'MG Road',
                                       'admin_username': ADMIN_USER, 'admin_password': ADMIN_PASS,
                                       'admin_full_name': 'Shop Owner', 'admin_email': 'owner@example.com'}))
        cls.answers = answers
        env = cls.stack.env()
        env['GTRADE_CLIENT_DIR'] = str(cls.tmp / 'client')
        t = time.monotonic()
        proc = subprocess.run([str(cls.stack.python), '-m', 'gtrade_ctl', '--install-root', str(STAGE),
                               '--data-root', str(cls.stack.data_root), 'install', '--mode', 'standalone',
                               '--version', '1.0.0', '--https-port', '18453', '--app-port', '18011', '--db-port', '15554',
                               '--answers', str(answers), '--no-services', '--no-firewall', '--no-acl'],
                              env=env, capture_output=True, text=True, timeout=1800)
        cls.install_exit = proc.returncode
        cls.install = json.loads(proc.stdout) if proc.stdout.strip().startswith('{') else {'raw': proc.stdout[-3000:], 'err': proc.stderr[-3000:]}
        cls.evidence['install'] = {'exit': proc.returncode, 'seconds': round(time.monotonic() - t, 1),
                                   'steps': [s['step'] for s in cls.install.get('steps', [])],
                                   'warnings': cls.install.get('warnings')}
        cls.stack.start_app()
        cls.stack.start_web()
        cls.evidence['health'] = cls.stack.wait_health().get('ok')

    @classmethod
    def tearDownClass(cls):
        try:
            cls.stack.down()
        finally:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            (EVIDENCE / 'desktop_install_e2e.json').write_text(json.dumps(cls.evidence, indent=1, default=str))
            shutil.rmtree(cls.tmp, ignore_errors=True)
            os.environ.pop('GTRADE_CLIENT_DIR', None)

    def test_01_installer_engine_completed(self):
        self.assertEqual(self.install_exit, 0, self.install)
        steps = {s['step']: s['result'] for s in self.install['steps']}
        self.assertEqual(steps['create-org']['company'], 'Sunrise Opticals')
        self.assertEqual(steps['create-org']['admin'], ADMIN_USER)
        self.assertFalse(self.answers.exists(), 'answers file (admin password) must be deleted')
        self.assertTrue((self.tmp / 'client' / 'client.json').exists())
        self.assertTrue((self.stack.data_root / 'config' / 'install.complete').exists(), 'completed install is marked')
        self.assertTrue(self.evidence['health'])
        logs = list((self.stack.data_root / 'logs' / 'install').glob('*.jsonl'))
        text = ''.join(p.read_text() for p in logs)
        self.assertNotIn(ADMIN_PASS, text)

    def test_02_electron_loads_pinned_server_securely_and_logs_in(self):
        res = electron_smoke(self.tmp / 'client' / 'client.json', self.tmp / 'ud1', self.tmp / 'smoke1.json')
        self.evidence['electron_ok'] = {k: v for k, v in res.items() if k != 'page'} | {'page': res.get('page')}
        self.assertTrue(res.get('ok'), res)
        self.assertTrue(res['url'].startswith('https://localhost:18453/'), res['url'])
        self.assertEqual(res['status']['state'], 'online')
        wp = res['webPreferences']
        self.assertTrue(wp['contextIsolation'])
        self.assertTrue(wp['sandbox'])
        self.assertFalse(wp['nodeIntegration'])
        page = res['page']
        self.assertEqual(page['requireType'], 'undefined')
        self.assertEqual(page['processType'], 'undefined')
        self.assertEqual(page['bridge'], 'object')
        self.assertTrue(page['connProbeBlocked'], 'server content must not manage connections')
        self.assertEqual(page['info']['appVersion'], '1.0.0')
        self.assertNotIn('caPem', json.dumps(page['info']))
        self.assertTrue(res['externalNavigationBlocked'])
        # The blocked probe was routed to the external opener and suppressed: no browser tab opened.
        self.assertTrue(res['externalOpenSuppressed'], res)
        self.assertEqual(res['login']['loginStatus'], 200)
        self.assertTrue(res['login']['gotToken'])
        self.assertEqual(res['login']['profileStatus'], 200)
        self.assertEqual(res['login']['role'], 'SUPER_ADMIN')
        self.assertIn(res['login']['wrongPasswordStatus'], (400, 401))
        # Interface size: a first run (no ui-settings.json) opens the server page at the 100% default.
        self.assertAlmostEqual(res['uiScale']['zoomFactor'], 1.0, places=3)
        self.assertEqual(page['uiScale'], {'scale': 1, 'defaultScale': 1, 'options': [0.75, 0.8, 0.9, 1]})
        self.assertIn('uiScale', page['bridgeKeys'])

    def test_02b_interface_size_survives_restart_and_bad_files(self):
        # A saved choice is applied on the next start (restart persistence) ...
        ud = self.tmp / 'ud-scale'
        ud.mkdir()
        (ud / 'ui-settings.json').write_text(json.dumps({'scale': 0.9}))
        res = electron_smoke(self.tmp / 'client' / 'client.json', ud, self.tmp / 'smoke-scale.json', login=False)
        self.assertTrue(res.get('ok'), res)
        self.assertAlmostEqual(res['uiScale']['zoomFactor'], 0.9, places=3)
        self.assertEqual(res['page']['uiScale']['scale'], 0.9)
        # ... and an unsupported or corrupt value falls back to the default instead of failing.
        for n, body in enumerate(['{"scale": 0.3}', 'not json']):
            (ud / 'ui-settings.json').write_text(body)
            res = electron_smoke(self.tmp / 'client' / 'client.json', ud, self.tmp / f'smoke-scale-bad{n}.json', login=False)
            self.assertAlmostEqual(res['uiScale']['zoomFactor'], 1.0, places=3, msg=body)
        self.evidence['interface_size'] = {'default': 1.0, 'restart_restores': 0.9, 'bad_file_falls_back_to': 1.0}

    def test_03_rogue_ca_is_refused(self):
        good = json.loads((self.tmp / 'client' / 'client.json').read_text())
        rogue_pem = (DESKTOP / 'test' / 'fixtures' / 'rogue-ca.crt').read_text()
        import hashlib, ssl
        der = ssl.PEM_cert_to_DER_cert(rogue_pem)
        fp = ':'.join(hashlib.sha256(der).hexdigest().upper()[i:i + 2] for i in range(0, 64, 2))
        bad = dict(good, caPem=rogue_pem, caFingerprint=fp)
        cfg = self.tmp / 'rogue-client.json'
        cfg.write_text(json.dumps(bad))
        res = electron_smoke(cfg, self.tmp / 'ud2', self.tmp / 'smoke2.json', login=False)
        self.evidence['electron_rogue_ca'] = {'url': res.get('url'), 'status': res.get('status')}
        self.assertTrue(res.get('ok'), res)
        self.assertIn('offline.html', res['url'])
        self.assertEqual(res['status']['state'], 'offline')

    def test_04_workstation_pairing(self):
        env = self.stack.env()
        env['GTRADE_CLIENT_DIR'] = str(self.tmp / 'ws-client')
        ws_data = self.tmp / 'ws-data'
        base = [str(self.stack.python), '-m', 'gtrade_ctl', '--install-root', str(STAGE), '--data-root', str(ws_data)]
        sheet = self.stack.ctl('connection-sheet')
        wrong = subprocess.run(base + ['install', '--mode', 'workstation', '--version', '1.0.0',
                                       '--server', 'localhost:18453', '--code', '0000-0000'],
                               env=env, capture_output=True, text=True, timeout=120)
        self.assertNotEqual(wrong.returncode, 0)
        self.assertIn('pairing code does not match', wrong.stdout)
        ok = subprocess.run(base + ['install', '--mode', 'workstation', '--version', '1.0.0',
                                    '--server', 'localhost:18453', '--code', sheet['pairing_code']],
                            env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(ok.returncode, 0, ok.stdout + ok.stderr)
        paired = json.loads(ok.stdout)
        self.assertEqual(paired['paired'], 'https://localhost:18453')
        # A workstation gets no database, no env file, no secrets: only install.json + client.json.
        self.assertFalse((ws_data / 'pgsql').exists())
        self.assertFalse((ws_data / 'config' / 'secrets.dpapi').exists())
        self.assertFalse((ws_data / 'config' / 'gtrade.env').exists())
        res = electron_smoke(self.tmp / 'ws-client' / 'client.json', self.tmp / 'ud3', self.tmp / 'smoke3.json', login=False)
        self.assertEqual(res['status']['state'], 'online')
        self.assertAlmostEqual(res['uiScale']['zoomFactor'], 1.0, places=3)  # workstations default to 100% too
        self.evidence['workstation'] = {'pairing_refused_wrong_code': True, 'paired': paired['paired'],
                                        'electron_state': res['status']['state'], 'db_created': False}

    def test_05_reset_lost_admin_password_on_server(self):
        import ssl
        import urllib.error
        import urllib.request
        env = self.stack.env()
        base = [str(self.stack.python), '-m', 'gtrade_ctl', '--install-root', str(STAGE),
                '--data-root', str(self.stack.data_root), 'reset-password']

        def run(*args, stdin=''):
            p = subprocess.run(base + list(args), env=env, input=stdin, capture_output=True, text=True, timeout=300)
            return p.returncode, (json.loads(p.stdout) if p.stdout.strip().startswith('{') else {'raw': p.stdout + p.stderr})

        def login(password):
            ctx = ssl.create_default_context(cafile=str(self.stack.data_root / 'config' / 'tls' / 'ca.crt'))
            req = urllib.request.Request('https://localhost:18453/api/auth/login/', method='POST',
                                         data=json.dumps({'username': ADMIN_USER, 'password': password}).encode(),
                                         headers={'Content-Type': 'application/json'})
            try:
                with urllib.request.urlopen(req, context=ctx, timeout=60) as r:
                    return r.status
            except urllib.error.HTTPError as e:
                return e.code

        code, listed = run('--list-admins')
        self.assertEqual(code, 0, listed)
        self.assertIn(ADMIN_USER, [a['username'] for a in listed['administrators']])
        code, res = run('--user', ADMIN_USER, stdin='123\n')                      # too weak: refused
        self.assertNotEqual(code, 0, res)
        code, res = run('--user', 'nobody', stdin='Another-e2e-Pass-2026!\n')     # unknown user: refused
        self.assertNotEqual(code, 0, res)
        self.assertEqual(login(ADMIN_PASS), 200, 'nothing changed by the refused attempts')

        new_pass = 'Recovered-e2e-Pass-2026!'
        code, res = run('--user', ADMIN_USER, stdin=new_pass + '\n')
        self.assertEqual(code, 0, res)
        self.assertTrue(res['ok'])
        self.assertEqual(login(new_pass), 200)
        self.assertIn(login(ADMIN_PASS), (400, 401))
        logs = ''.join(p.read_text(errors='replace') for p in (self.stack.data_root / 'logs').rglob('*.*') if p.is_file())
        self.assertNotIn(new_pass, logs)
        self.evidence['reset_password'] = {'refused_weak': True, 'refused_unknown': True, 'login_with_new': 200}


if __name__ == '__main__':
    unittest.main()
