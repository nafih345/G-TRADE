"""Phase 4: PostgreSQL 17 runtime against a real, disposable cluster (scratch folder + free port)."""

import os
import unittest

from tests.helpers import PG_BIN, TempRoots, requires_pg

from gtrade_ctl import secrets_store
from gtrade_ctl.pg import PgError, PgRuntime, find_free_port


@requires_pg
class ClusterTests(TempRoots):
    @classmethod
    def setUpClass(cls):
        cls.port = find_free_port(56440)

    def setUp(self):
        super().setUp()
        self.secrets = secrets_store.generate_all()
        self.pg = PgRuntime(PG_BIN, self.layout.pg_data, self.port, self.layout.logs_dir / 'db')

    def tearDown(self):
        try:
            self.pg.stop('immediate')
        except Exception:
            pass
        super().tearDown()

    def _init_and_start(self):
        self.pg.initdb(self.secrets['db_superuser_password'])
        self.pg.start()
        self.pg.wait_ready()
        return self.pg.provision(superuser_password=self.secrets['db_superuser_password'], app_user='gtrade',
                                 app_password=self.secrets['db_app_password'], db_name='gtrade')

    def test_fresh_cluster_least_privilege_loopback(self):
        prov = self._init_and_start()
        self.assertTrue(prov['database_created'])
        rep = self.pg.verify(app_user='gtrade', app_password=self.secrets['db_app_password'], db_name='gtrade',
                             superuser_password=self.secrets['db_superuser_password'])
        self.assertTrue(rep['ok'], rep)
        self.assertEqual(rep['binary_major'], 17)
        self.assertEqual(rep['cluster_major'], 17)
        self.assertFalse(rep['app_is_superuser'])
        self.assertFalse(rep['app_can_create_db'])
        self.assertFalse(rep['app_can_create_role'])
        self.assertEqual(rep['listen_addresses'], 'localhost')
        hba = (self.layout.pg_data / 'pg_hba.conf').read_text()
        self.assertNotIn('trust', hba.replace('# ', ''))
        self.assertNotIn('0.0.0.0', hba)
        # No password file left behind next to the cluster.
        self.assertFalse(list(self.layout.pg_data.parent.glob('gtrade-pw-*')))

    def test_wrong_password_rejected_and_public_cannot_connect(self):
        self._init_and_start()
        with self.assertRaises(PgError):
            self.pg.psql('SELECT 1', user='gtrade', password='wrong', db='gtrade')
        su = self.secrets['db_superuser_password']
        self.pg.psql("CREATE ROLE intruder LOGIN PASSWORD 'intruder-pass-123'", user='postgres', password=su)
        with self.assertRaises(PgError):
            self.pg.psql('SELECT 1', user='intruder', password='intruder-pass-123', db='gtrade')

    def test_app_role_can_create_tables_in_its_database(self):
        self._init_and_start()
        pw = self.secrets['db_app_password']
        self.pg.psql('CREATE TABLE t (id int); INSERT INTO t VALUES (1);', user='gtrade', password=pw, db='gtrade')
        self.assertEqual(self.pg.psql('SELECT count(*) FROM t', user='gtrade', password=pw, db='gtrade'), '1')

    def test_existing_cluster_is_never_reinitialised_and_data_survives(self):
        self._init_and_start()
        pw = self.secrets['db_app_password']
        self.pg.psql('CREATE TABLE keep (v text); INSERT INTO keep VALUES (\'customer data\');',
                     user='gtrade', password=pw, db='gtrade')
        with self.assertRaises(PgError):
            self.pg.initdb('another-password')
        # Re-provisioning (repair) keeps data and is idempotent.
        prov = self.pg.provision(superuser_password=self.secrets['db_superuser_password'], app_user='gtrade',
                                 app_password=pw, db_name='gtrade')
        self.assertFalse(prov['database_created'])
        self.assertTrue(prov['role_existed'])
        self.assertEqual(self.pg.psql('SELECT v FROM keep', user='gtrade', password=pw, db='gtrade'), 'customer data')
        # Restart (service restart equivalent) keeps data.
        self.pg.stop()
        self.pg.start()
        self.pg.wait_ready()
        self.assertEqual(self.pg.psql('SELECT v FROM keep', user='gtrade', password=pw, db='gtrade'), 'customer data')

    def test_foreign_folder_is_refused_untouched(self):
        self.layout.pg_data.mkdir(parents=True)
        marker = self.layout.pg_data / 'someone-elses-file.txt'
        marker.write_text('not ours')
        with self.assertRaises(PgError):
            self.pg.initdb(self.secrets['db_superuser_password'])
        self.assertEqual(marker.read_text(), 'not ours')
        self.assertEqual(self.pg.cluster_state(), 'foreign')

    def test_identifiers_are_validated(self):
        self._init_and_start()
        with self.assertRaises(PgError):
            self.pg.provision(superuser_password=self.secrets['db_superuser_password'], app_user='x"; DROP ROLE postgres; --',
                              app_password='p', db_name='gtrade')

    def test_managed_config_block_is_idempotent(self):
        self._init_and_start()
        self.pg.write_config()
        self.pg.write_config()
        conf = (self.layout.pg_data / 'postgresql.conf').read_text()
        self.assertEqual(conf.count('# >>> G-TRADE managed settings >>>'), 1)
        self.assertIn(f'port = {self.port}', conf)


if __name__ == '__main__':
    unittest.main()


class ModeAndUpgradeGuards(TempRoots):
    def test_workstation_never_initialises_a_database(self):
        import io
        from contextlib import redirect_stdout
        from gtrade_ctl import cli, install_config
        cfg = install_config.InstallConfig(mode='workstation', version='1.0.0', server_url='https://srv:8443')
        install_config.write(self.layout.install_json, cfg)
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(['--install-root', str(self.install_root), '--data-root', str(self.data_root), 'init-db'])
        self.assertEqual(code, cli.EXIT['config'])
        self.assertIn('never hosts a database', buf.getvalue())
        self.assertFalse(self.layout.pg_data.exists())
        # And no env file (no backend settings) is written for a workstation.
        self.assertFalse(self.layout.env_file.exists())

    def test_configure_cannot_change_mode_on_upgrade(self):
        import io
        from contextlib import redirect_stdout
        from gtrade_ctl import cli
        base = ['--install-root', str(self.install_root), '--data-root', str(self.data_root)]
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(base + ['configure', '--mode', 'standalone', '--version', '1.0.0']), 0)
        first = __import__('json').loads(self.layout.install_json.read_text())
        buf = io.StringIO()
        with redirect_stdout(buf):
            code = cli.main(base + ['configure', '--mode', 'server', '--version', '1.0.1'])
        self.assertEqual(code, cli.EXIT['config'])
        with redirect_stdout(io.StringIO()):
            self.assertEqual(cli.main(base + ['configure', '--version', '1.0.1']), 0)
        after = __import__('json').loads(self.layout.install_json.read_text())
        self.assertEqual(after['install_id'], first['install_id'])
        self.assertEqual(after['mode'], 'standalone')
        self.assertEqual(after['version'], '1.0.1')

    @requires_pg
    def test_major_version_mismatch_is_reported_not_started(self):
        data = self.layout.pg_data
        data.mkdir(parents=True)
        (data / 'PG_VERSION').write_text('16\n')
        pg = PgRuntime(PG_BIN, data, 56999, self.layout.logs_dir / 'db')
        rep = pg.verify(app_user='gtrade', app_password='x', db_name='gtrade')
        self.assertIn('pg_upgrade is required', rep['error'])
        with self.assertRaises(PgError):
            pg.initdb('pw')  # an existing (older) cluster is never re-initialised
