"""Phase 3/4 end-to-end on real Windows: bundled PG17 -> Waitress (gtrade_server) -> nginx TLS.

Slow (full migration from an empty database), so opt-in: set GTRADE_E2E=1.
Evidence is written to windows/out/evidence/stack_e2e.json.
"""

import json
import os
import shutil
import socket
import ssl
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from pathlib import Path

from tests.stack import STAGE, Stack

EVIDENCE = Path(__file__).resolve().parents[1] / 'out' / 'evidence'


def _get(url, ctx, method='GET'):
    req = urllib.request.Request(url, method=method)
    try:
        with urllib.request.urlopen(req, context=ctx, timeout=15) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()


@unittest.skipUnless(os.environ.get('GTRADE_E2E') == '1' and (STAGE / 'runtime' / 'python' / 'python.exe').exists(),
                     'set GTRADE_E2E=1 after building windows/out/stage')
class StackE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-e2e-'))
        cls.stack = Stack(cls.tmp / 'data')
        cls.evidence = {'started': time.strftime('%Y-%m-%dT%H:%M:%S'), 'data_root': 'temp (deleted after run)'}
        t = time.monotonic()
        cls.evidence['provision'] = cls.stack.provision()
        cls.evidence['provision_seconds'] = round(time.monotonic() - t, 1)
        cls.stack.start_app()
        cls.stack.start_web()
        cls.evidence['first_health'] = cls.stack.wait_health()
        cls.ctx = ssl.create_default_context(cafile=str(cls.stack.data_root / 'config' / 'tls' / 'ca.crt'))
        cls.base = f'https://localhost:{cls.stack.ports["https"]}'

    @classmethod
    def tearDownClass(cls):
        try:
            cls.stack.down()
        finally:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            (EVIDENCE / 'stack_e2e.json').write_text(json.dumps(cls.evidence, indent=1, default=str))
            shutil.rmtree(cls.tmp, ignore_errors=True)

    def test_01_provisioned_from_scratch(self):
        p = self.evidence['provision']
        self.assertTrue(p['init_db']['initialised'])
        self.assertTrue(p['verify_db']['least_privilege'])
        self.assertTrue(p['verify_db']['loopback_only'])
        self.assertEqual(p['verify_db']['binary_major'], 17)
        self.assertGreater(p['plan_before'], 100)
        self.assertTrue(p['migrate'])
        self.assertEqual(p['plan_after'], 0)
        self.assertTrue(p['collectstatic'])

    def test_02_health_over_pinned_tls(self):
        h = self.evidence['first_health']
        self.assertTrue(h.get('ok'), h)
        body = h['health']
        self.assertEqual(body['edition'], 'local')
        self.assertIs(body['debug'], False)
        self.assertEqual(body['database'], 'connected')
        self.assertEqual(body['migrations'], 'up_to_date')
        self.assertEqual(body['cors'], 'same-origin')
        self.assertNotIn('PASSWORD', json.dumps(body).upper().replace('PASSWORD_', ''))

    def test_03_security_headers_spa_and_static(self):
        code, headers, body = _get(self.base + '/', self.ctx)
        self.assertEqual(code, 200)
        self.assertIn('nosniff', headers.get('X-Content-Type-Options', ''))
        self.assertIn("frame-ancestors 'self'", headers.get('Content-Security-Policy', ''))
        self.assertNotIn('nginx/', headers.get('Server', ''))  # server_tokens off
        code, _, _ = _get(self.base + '/static/admin/css/base.css', self.ctx)
        self.assertEqual(code, 200)  # Django admin static collected and served by nginx
        code, _, _ = _get(self.base + '/api/products/', self.ctx)
        self.assertEqual(code, 401)  # API needs a token
        self.evidence['headers'] = {k: v for k, v in headers.items() if k.lower() in (
            'content-security-policy', 'x-frame-options', 'x-content-type-options', 'strict-transport-security',
            'referrer-policy', 'server')}

    def test_04_untrusted_certificate_rejected(self):
        with self.assertRaises(urllib.error.URLError):
            _get(self.base + '/api/health/live/', ssl.create_default_context())

    def test_05_plain_http_and_lan_exposure(self):
        # No plaintext listener: an HTTP request to the TLS port gets nginx's 400, never the app.
        code, _, body = _get(f'http://localhost:{self.stack.ports["https"]}/api/health/', None)
        self.assertEqual(code, 400)
        # Standalone: nothing listens on a non-loopback address.
        lan_ip = next((ip for ip in socket.gethostbyname_ex(socket.gethostname())[2] if not ip.startswith('127.')), None)
        if lan_ip:
            for port in self.stack.ports.values():
                with socket.socket() as s:
                    s.settimeout(1)
                    self.assertNotEqual(s.connect_ex((lan_ip, port)), 0, f'{lan_ip}:{port} is reachable')
            self.evidence['lan_ip_checked'] = True

    def test_06_maintenance_flag_gates_api_not_health(self):
        flag = self.stack.data_root / 'run' / 'maintenance.flag'
        flag.write_text(json.dumps({'reason': 'update to 1.0.1'}))
        try:
            code, _, body = _get(self.base + '/api/products/', self.ctx)
            self.assertEqual(code, 503)
            self.assertEqual(json.loads(body)['error'], 'maintenance')
            code, _, body = _get(self.base + '/api/health/', self.ctx)
            self.assertEqual(code, 200)
            self.assertEqual(json.loads(body)['maintenance'], 'update to 1.0.1')
        finally:
            flag.unlink()

    def test_07_graceful_stop_and_restart(self):
        t = time.monotonic()
        code = self.stack.stop_app()
        self.evidence['graceful_stop'] = {'exit_code': code, 'seconds': round(time.monotonic() - t, 1)}
        self.assertEqual(code, 0)
        c, _, _ = _get(self.base + '/api/health/live/', self.ctx)
        self.assertEqual(c, 502)  # nginx up, app down
        self.stack.start_app()
        self.assertTrue(self.stack.wait_health().get('ok'))

    def test_08_crash_recovery(self):
        self.stack.server_proc.kill()  # hard crash; WinSW would restart it after 5 s
        self.stack.server_proc.wait(10)
        self.stack.start_app()
        h = self.stack.wait_health()
        self.assertTrue(h.get('ok'))
        self.evidence['crash_recovery'] = 'ok'

    def test_09_logs_written_without_secrets(self):
        from gtrade_ctl import secrets_store
        os.environ.pop('GTRADE_INSECURE_SECRETS', None)
        values = secrets_store.load(self.stack.data_root / 'config' / 'secrets.dpapi')
        logs = list((self.stack.data_root / 'logs').rglob('*.log'))
        self.assertTrue(any(p.name == 'backend.log' for p in logs))
        for p in logs:
            text = p.read_text(encoding='utf-8', errors='replace')
            for v in values.values():
                self.assertNotIn(v, text, p.name)
        for f in ('gtrade.env', 'install.json', 'nginx.conf'):
            text = (self.stack.data_root / 'config' / f).read_text()
            for v in values.values():
                self.assertNotIn(v, text, f)
        self.evidence['log_files'] = sorted(str(p.relative_to(self.stack.data_root)) for p in logs)

    def test_10_runserver_and_debug_refused(self):
        env = self.stack.env()
        env.update(GTRADE_SECRET_KEY='x' * 60, GTRADE_DATA_ROOT=str(self.stack.data_root), GTRADE_DB_NAME='gtrade',
                   GTRADE_DB_USER='gtrade', GTRADE_DB_PASSWORD='x', DJANGO_SETTINGS_MODULE='config.settings_local',
                   DEBUG='True')
        import subprocess
        proc = subprocess.run([str(self.stack.python), 'manage.py', 'runserver', '--noreload'], cwd=str(self.stack.app_dir / 'backend'),
                              env=env, capture_output=True, text=True, timeout=120)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn('development server is disabled', proc.stderr)
        proc = subprocess.run([str(self.stack.python), '-c', 'import django;django.setup();from django.conf import settings;print(settings.DEBUG)'],
                              cwd=str(self.stack.app_dir / 'backend'), env=env, capture_output=True, text=True, timeout=120)
        self.assertEqual(proc.stdout.strip(), 'False')
        env['GTRADE_SECRET_KEY'] = 'django-insecure-' + 'x' * 60
        proc = subprocess.run([str(self.stack.python), '-c', 'import django;django.setup()'], cwd=str(self.stack.app_dir / 'backend'),
                              env=env, capture_output=True, text=True, timeout=120)
        self.assertIn('too weak', proc.stderr)


if __name__ == '__main__':
    unittest.main()
