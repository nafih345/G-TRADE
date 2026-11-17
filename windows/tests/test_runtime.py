"""Phase 3: local production runtime (config, secrets, TLS, nginx, services, firewall, logging)."""

import json
import os
import ssl
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

from tests.helpers import TempRoots

from gtrade_ctl import certs, firewall, install_config, nginx, secrets_store, services
from gtrade_ctl.log import StepLog, redact
from gtrade_ctl.paths import validate_data_root


class RedactionTests(unittest.TestCase):
    def test_masks_pairs_urls_keys_and_licence_keys(self):
        text = ('password=hunter2 DB_PASSWORD: s3cr3t postgres://gtrade:p%40ss@127.0.0.1:5544/gtrade '
                'token="abc def" licence GTAB-1234-ABCD-5678-EFGH')
        out = redact(text)
        for secret in ('hunter2', 's3cr3t', 'p%40ss', 'abc def', '1234-ABCD-5678'):
            self.assertNotIn(secret, out)
        self.assertIn('postgres://gtrade:********@127.0.0.1', out)

    def test_masks_dict_keys_recursively(self):
        out = redact({'db_app_password': 'x', 'nested': {'django_secret_key': 'y', 'port': 5544}, 'list': ['pwd=z']})
        self.assertEqual(out['db_app_password'], '********')
        self.assertEqual(out['nested']['django_secret_key'], '********')
        self.assertEqual(out['nested']['port'], 5544)
        self.assertNotIn('z', out['list'][0].split('=')[1])

    def test_step_log_records_failures_redacted(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            log = StepLog(Path(d) / 'x.jsonl')
            with self.assertRaises(RuntimeError):
                with log.step('init-db'):
                    raise RuntimeError('password=topsecret failed')
            events = log.read()
            self.assertEqual([e['status'] for e in events], ['start', 'failed'])
            self.assertNotIn('topsecret', json.dumps(events))


class LayoutTests(TempRoots):
    def test_data_tree_created(self):
        created = self.layout.ensure_data_tree()
        self.assertTrue((self.data_root / 'config' / 'tls').is_dir())
        self.assertTrue((self.data_root / 'backups' / 'db').is_dir())
        self.assertTrue(created)
        self.assertEqual(self.layout.ensure_data_tree(), [])  # idempotent

    def test_data_root_inside_program_files_or_install_root_refused(self):
        with self.assertRaises(ValueError):
            validate_data_root(self.install_root / 'data', self.install_root)
        pf = Path(os.environ.get('ProgramFiles', r'C:\Program Files'))
        with self.assertRaises(ValueError):
            validate_data_root(pf / 'G-TRADE-data', self.install_root)
        validate_data_root(self.data_root, self.install_root)


@unittest.skipUnless(sys.platform == 'win32', 'DPAPI is Windows-only')
class SecretsTests(TempRoots):
    def test_dpapi_roundtrip_and_no_plaintext_on_disk(self):
        os.environ.pop('GTRADE_INSECURE_SECRETS', None)
        path = self.layout.secrets_file
        values, created = secrets_store.init(path)
        self.assertTrue(created)
        raw = path.read_bytes()
        for v in values.values():
            self.assertNotIn(v.encode(), raw)
        self.assertEqual(secrets_store.load(path), values)

    def test_init_never_overwrites(self):
        os.environ.pop('GTRADE_INSECURE_SECRETS', None)
        first, _ = secrets_store.init(self.layout.secrets_file)
        second, created = secrets_store.init(self.layout.secrets_file)
        self.assertFalse(created)
        self.assertEqual(first, second)

    def test_generated_values_are_strong_and_connection_safe(self):
        values = secrets_store.generate_all()
        self.assertGreaterEqual(len(values['django_secret_key']), 80)
        for name in ('db_app_password', 'db_superuser_password'):
            self.assertEqual(len(values[name]), 32)
            self.assertFalse(set(values[name]) & set('\'"\\%:@/ '))
        self.assertNotEqual(values['db_app_password'], values['db_superuser_password'])

    def test_tampered_file_is_rejected(self):
        os.environ.pop('GTRADE_INSECURE_SECRETS', None)
        secrets_store.init(self.layout.secrets_file)
        blob = bytearray(self.layout.secrets_file.read_bytes())
        blob[-5] ^= 0xFF
        self.layout.secrets_file.write_bytes(bytes(blob))
        with self.assertRaises(secrets_store.SecretsError):
            secrets_store.load(self.layout.secrets_file)

    def test_insecure_test_file_refused_outside_test_mode(self):
        os.environ['GTRADE_INSECURE_SECRETS'] = '1'
        try:
            secrets_store.init(self.layout.secrets_file)
        finally:
            os.environ.pop('GTRADE_INSECURE_SECRETS')
        with self.assertRaises(secrets_store.SecretsError):
            secrets_store.load(self.layout.secrets_file)


class InstallConfigTests(TempRoots):
    def test_validation(self):
        with self.assertRaises(install_config.ConfigError):
            install_config.InstallConfig(mode='kiosk', version='1.0.0').validate()
        with self.assertRaises(install_config.ConfigError):
            install_config.InstallConfig(mode='standalone', version='1', https_port=8443, app_port=8443).validate()
        with self.assertRaises(install_config.ConfigError):
            install_config.InstallConfig(mode='workstation', version='1', server_url='http://srv:8443').validate()
        install_config.InstallConfig(mode='workstation', version='1', server_url='https://srv:8443').validate()

    def test_roundtrip_and_env_has_no_secrets(self):
        cfg = install_config.InstallConfig(mode='server', version='1.0.0', hostnames=['SHOP-SRV'], ip_addresses=['192.168.1.20'])
        install_config.write(self.layout.install_json, cfg)
        again = install_config.read(self.layout.install_json)
        self.assertEqual(again.install_id, cfg.install_id)
        env = install_config.env_values(again, self.layout)
        self.assertEqual(env['DJANGO_SETTINGS_MODULE'], 'config.settings_local')
        self.assertEqual(env['AUTO_MIGRATE'], 'False')
        self.assertIn('https://SHOP-SRV:8443', env['GTRADE_ORIGINS'])
        self.assertIn('192.168.1.20', env['GTRADE_ALLOWED_HOSTS'])
        self.assertFalse([k for k in env if 'PASSWORD' in k or 'SECRET' in k])
        install_config.write_env(self.layout.env_file, env)
        self.assertEqual(install_config.read_env(self.layout.env_file), env)

    def test_bind_address_by_mode(self):
        self.assertEqual(install_config.InstallConfig(mode='standalone', version='1').bind_address, '127.0.0.1')
        self.assertEqual(install_config.InstallConfig(mode='server', version='1').bind_address, '0.0.0.0')


class CertTests(TempRoots):
    def test_ca_and_server_cert_chain_verifies_for_all_hosts(self):
        tls = self.layout.tls_dir
        rep = certs.ensure(tls, '6f1c2f7e-0000-4000-8000-000000000001', ['SHOP-SRV', '192.168.1.20'])
        self.assertTrue(rep['renewed'])
        self.assertRegex(rep['ca_fingerprint'], r'^([0-9A-F]{2}:){31}[0-9A-F]{2}$')
        srv = certs.info(tls / 'server.crt')
        for h in ('localhost', '127.0.0.1', 'SHOP-SRV', '192.168.1.20'):
            self.assertIn(h, srv.sans)
        self.assertLessEqual(srv.days_left, certs.SERVER_DAYS)
        # The chain verifies with Python's TLS stack and the CA file only.
        ctx = ssl.create_default_context(cafile=str(tls / 'ca.crt'))
        ctx.load_cert_chain(str(tls / 'server.crt'), str(tls / 'server.key'))

    def test_ensure_keeps_ca_and_only_renews_when_needed(self):
        tls = self.layout.tls_dir
        first = certs.ensure(tls, '6f1c2f7e-0000-4000-8000-000000000001', ['A'])
        second = certs.ensure(tls, '6f1c2f7e-0000-4000-8000-000000000001', ['A'])
        self.assertFalse(second['renewed'])
        self.assertEqual(first['ca_fingerprint'], second['ca_fingerprint'])
        third = certs.ensure(tls, '6f1c2f7e-0000-4000-8000-000000000001', ['A', 'NEW-HOST'])
        self.assertTrue(third['renewed'])
        self.assertEqual(third['reason'], 'host list changed')
        self.assertEqual(first['ca_fingerprint'], third['ca_fingerprint'])

    def test_incomplete_ca_is_not_replaced(self):
        tls = self.layout.tls_dir
        certs.init_ca(tls, '6f1c2f7e-0000-4000-8000-000000000001')
        (tls / 'ca.key').unlink()
        with self.assertRaises(RuntimeError):
            certs.init_ca(tls, '6f1c2f7e-0000-4000-8000-000000000001')


class NginxTests(TempRoots):
    def _render(self, mode):
        cfg = install_config.InstallConfig(mode=mode, version='1.0.0')
        self.layout.ensure_data_tree()
        nginx.write(self.layout, cfg, self.install_root / 'app' / '1.0.0' / 'frontend')
        return self.layout.nginx_conf.read_text()

    def test_standalone_binds_loopback_tls_only(self):
        conf = self._render('standalone')
        self.assertIn('listen 127.0.0.1:8443 ssl;', conf)
        self.assertNotIn('listen 80', conf)
        self.assertIn('ssl_protocols        TLSv1.2 TLSv1.3;', conf)
        self.assertIn('server_tokens off;', conf)
        self.assertIn('proxy_pass http://gtrade_app;', conf)
        self.assertIn('server 127.0.0.1:8001;', conf)
        self.assertIn("frame-ancestors 'self'", conf)

    def test_server_binds_all_interfaces_and_media_goes_through_django(self):
        conf = self._render('server')
        self.assertIn('listen 0.0.0.0:8443 ssl;', conf)
        self.assertIn('location ~ ^/(api|admin|media)/', conf)
        self.assertNotIn('location /media/', conf)
        self.assertEqual(conf.count('{'), conf.count('}'))

    def test_ipv6_loopback_listener_only_when_bindable_and_never_network_wide(self):
        from unittest import mock
        for mode in ('standalone', 'server'):
            with mock.patch.object(nginx, 'ipv6_loopback_available', return_value=True):
                conf = self._render(mode)
            self.assertIn('listen [::1]:8443 ssl;', conf)       # "localhost" resolves to ::1 first
            self.assertNotIn('listen [::]', conf)                # no IPv6 LAN exposure
            with mock.patch.object(nginx, 'ipv6_loopback_available', return_value=False):
                conf = self._render(mode)
            self.assertNotIn('[::1]', conf)                      # IPv6 removed: IPv4 only, nginx still starts
        self.assertIsInstance(nginx.ipv6_loopback_available(), bool)


class ServiceTests(TempRoots):
    def test_app_and_web_xml(self):
        cfg = install_config.InstallConfig(mode='server', version='1.0.0')
        app = ET.fromstring(services.app_service_xml(self.layout, cfg, '1.0.0'))
        self.assertEqual(app.findtext('id'), 'GTrade-App')
        self.assertEqual(app.findtext('arguments'), '-m gtrade_server')
        self.assertEqual([d.text for d in app.findall('depend')], ['GTrade-DB'])
        self.assertEqual(len(app.findall('onfailure')), 3)
        # The account is set through SCM (sc config obj=), never in the XML: WinSW 2.12 ignored
        # <serviceaccount><username>, which is why App/Web silently ran as LocalSystem until 2026-11-13.
        self.assertIsNone(app.find('serviceaccount'))
        self.assertIsNone(app.find('delayedAutoStart'))
        self.assertEqual(services.HARDENED_ACCOUNTS['GTrade-App'], r'NT SERVICE\GTrade-App')
        env = {e.get('name'): e.get('value') for e in app.findall('env')}
        self.assertFalse([k for k in env if 'PASSWORD' in k or 'SECRET' in k])
        web = ET.fromstring(services.web_service_xml(self.layout))
        self.assertEqual([d.text for d in web.findall('depend')], ['GTrade-App'])
        self.assertIn('-s quit', web.findtext('stoparguments'))
        self.assertIn(str(self.layout.run_dir / 'nginx'), web.findtext('arguments'))

    def test_db_registration_uses_network_service_and_auto_start(self):
        cfg = install_config.InstallConfig(mode='standalone', version='1.0.0')
        cmd = services.plan_register_db(self.layout, cfg)
        self.assertIn('register', cmd)
        self.assertEqual(cmd[cmd.index('-S') + 1], 'auto')
        self.assertEqual(cmd[cmd.index('-U') + 1], r'NT AUTHORITY\NetworkService')

    def test_install_without_elevation_is_refused_but_dry_run_plans(self):
        cfg = install_config.InstallConfig(mode='standalone', version='1.0.0')
        plan = services.install_all(self.layout, cfg, '1.0.0', dry_run=True)
        # 'install' is planned only where GTrade-App is not registered yet (it is on a dev PC with an
        # installation), the SCM configuration always.
        if services.query('GTrade-App') == 'NOT_INSTALLED':
            self.assertTrue(any(c[0].endswith('GTrade-App.exe') and c[1] == 'install' for c in plan))
        self.assertFalse([c for c in plan if 'refresh' in c])
        self.assertFalse(self.layout.services_dir.exists(), 'a dry run must not write anything')
        self.assertIn(['sc.exe', 'config', 'GTrade-App', 'start=', 'auto', 'obj=', r'NT SERVICE\GTrade-App',
                       'depend=', 'GTrade-DB'], plan)
        if not services.is_elevated():
            with self.assertRaises(services.ServiceError):
                services.install_all(self.layout, cfg, '1.0.0')

    def test_workstation_gets_no_services(self):
        cfg = install_config.InstallConfig(mode='workstation', version='1.0.0', server_url='https://s:8443')
        self.assertEqual(services.install_all(self.layout, cfg, '1.0.0', dry_run=True), [])


class FirewallTests(unittest.TestCase):
    def test_rule_is_private_profile_local_subnet_single_port(self):
        cmd = firewall.plan_add(8443)
        self.assertIn('profile=private', cmd)
        self.assertIn('remoteip=localsubnet', cmd)
        self.assertIn('localport=8443', cmd)
        self.assertIn('protocol=TCP', cmd)
        self.assertNotIn('profile=public', ' '.join(cmd))


if __name__ == '__main__':
    unittest.main()
