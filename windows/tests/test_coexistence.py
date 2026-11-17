"""Coexistence with other database servers on the same PC (developer PCs, shops with other software).

The local edition must never reuse or collide with an existing PostgreSQL/MySQL: it runs its own
cluster on its own loopback port, refuses ports that are already taken, and ignores any inherited
DATABASE_URL. These run without elevation and change nothing on the PC.
"""

import os
import socket
import tempfile
import unittest
from pathlib import Path

from gtrade_ctl import install_config
from gtrade_ctl.installer_cmds import preflight
from gtrade_ctl.paths import layout

COMMON_DB_PORTS = {5432, 5433, 3306, 33060, 1433, 27017}


class CoexistenceTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-coexist-'))
        self.lay = layout(self.tmp / 'install', self.tmp / 'data')

    def test_default_ports_avoid_common_database_ports(self):
        defaults = {install_config.DEFAULT_DB_PORT, install_config.DEFAULT_APP_PORT, install_config.DEFAULT_HTTPS_PORT}
        self.assertEqual(defaults, {5544, 8001, 8443})
        self.assertFalse(defaults & COMMON_DB_PORTS)

    def test_preflight_blocks_a_port_already_in_use(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.bind(('127.0.0.1', 0))
            s.listen(1)
            busy = s.getsockname()[1]
            rep = preflight('standalone', self.lay, [busy], need_admin=False)
        self.assertFalse(rep['ok'])
        self.assertIn(busy, rep['checks']['ports_busy'])
        self.assertTrue(any('already used' in b for b in rep['blocking']))

    def test_preflight_passes_free_ports_on_fresh_data_root(self):
        free = []
        for _ in range(3):
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.bind(('127.0.0.1', 0))
                free.append(s.getsockname()[1])
        rep = preflight('standalone', self.lay, free, need_admin=False)
        self.assertEqual(rep['checks']['ports_busy'], [])
        self.assertFalse(rep['checks']['existing_installation'])

    def test_inherited_database_url_never_reaches_the_app(self):
        from gtrade_ctl import django_bridge
        os.environ['DATABASE_URL'] = 'postgresql://someone:pw@127.0.0.1:5432/other_db'
        try:
            # child_env needs secrets; patch the loader so nothing is written to the PC.
            orig = django_bridge.secrets_store.load
            django_bridge.secrets_store.load = lambda _p: {'django_secret_key': 'k', 'db_app_password': 'p',
                                                           'license_store_key': 'l'}
            try:
                env = django_bridge.child_env(self.lay)
            finally:
                django_bridge.secrets_store.load = orig
        finally:
            os.environ.pop('DATABASE_URL', None)
        self.assertNotIn('DATABASE_URL', env)
        self.assertEqual(env['DJANGO_SETTINGS_MODULE'], 'config.settings_local')

    def test_local_settings_refuse_database_url(self):
        src = (Path(__file__).resolve().parents[2] / 'backend' / 'config' / 'settings_local.py').read_text(encoding='utf-8')
        self.assertIn("for _forbidden in ('DATABASE_URL', 'POSTGRES_URL', 'POSTGRES_URL_NON_POOLING')", src)
        self.assertIn("'PORT': os.environ.get('GTRADE_DB_PORT', '5544')", src)


if __name__ == '__main__':
    unittest.main()
