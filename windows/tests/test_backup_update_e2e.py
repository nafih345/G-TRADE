"""Phase 8 on real Windows (opt-in, GTRADE_E2E=1): backups, restore, safe update, automatic
rollback on three kinds of failure, downgrade / irreversible refusals, retention, in-app backup
API, uninstall keeping / deleting data. Disposable install root (junction to the staged runtime)
and data root; the dev database is never touched.
Evidence: windows/out/evidence/backup_update_e2e.json
"""

import datetime as dt
import json
import os
import shutil
import ssl
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

from tests.stack import STAGE, Stack

from gtrade_ctl import backup, install_config, nginx, update
from gtrade_ctl.paths import layout

EVIDENCE = Path(__file__).resolve().parents[1] / 'out' / 'evidence'
ADMIN, PASSWORD = 'owner', 'Update-E2E-Pass-2026!'
PROBE_MIGRATION = """from django.db import migrations

class Migration(migrations.Migration):
    dependencies = [('licensing', '{dep}')]
    operations = [migrations.RunSQL({sql!r}, reverse_sql=migrations.RunSQL.noop)]
"""


class StackController(update.Controller):
    def __init__(self, stack):
        self.s = stack
        self.app_dir = stack.app_dir

    def stop(self):
        self.s.stop_app()

    def start(self):
        # Like SCM: starting a running service is a no-op.
        if self.s.server_proc is not None and self.s.server_proc.poll() is None:
            return
        self.s.start_app(app_dir=self.app_dir)

    def start_db(self, lay, cfg):
        backup._pg(lay, cfg).start()

    # Never touch the real GTrade-* services from a test: account snapshot/cleanup are stand-ins that
    # record what the update engine asked for (restored accounts are asserted by the tests).
    def accounts(self):
        return {'GTrade-DB': 'NT AUTHORITY\\NetworkService', 'GTrade-App': 'LocalSystem', 'GTrade-Web': 'LocalSystem'}

    def finalize(self, lay):
        self.s.finalized = getattr(self.s, 'finalized', 0) + 1
        return []

    def prepare(self, lay, cfg, app_dir, accounts=None):
        self.s.prepared = [*getattr(self.s, 'prepared', []), accounts]
        if accounts is None and getattr(self, 'access_defect', None):
            # = services.ensure_service_files when winacl.require_service_access finds a folder the new
            #   accounts cannot use (the 2026-11-17 error 70 cause, now caught before anything starts).
            from gtrade_ctl import services
            raise services.ServiceError(self.access_defect)
        return {'test': 'no Windows services'}

    def switch_version(self, lay, cfg, app_dir, accounts=None):
        if Path(app_dir) != self.app_dir:
            self.stop()  # the running process keeps its code until restarted
        self.app_dir = Path(app_dir)
        nginx.write(lay, cfg, self.app_dir / 'frontend')
        self.s.stop_web()
        self.s.start_web()


@unittest.skipUnless(os.environ.get('GTRADE_E2E') == '1' and (STAGE / 'app' / '1.0.0').exists(), 'GTRADE_E2E=1 + staged build')
class BackupUpdateE2E(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        try:
            cls._setup()
        except BaseException:
            cls.tearDownClass()  # never leave a disposable PostgreSQL running
            raise

    @classmethod
    def _setup(cls):
        cls.evidence = {}
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-p8-'))
        cls.install_root = cls.tmp / 'install'
        (cls.install_root / 'app').mkdir(parents=True)
        subprocess.run(['cmd', '/c', 'mklink', '/J', str(cls.install_root / 'runtime'), str(STAGE / 'runtime')],
                       check=True, capture_output=True)
        shutil.copytree(STAGE / 'app' / '1.0.0', cls.install_root / 'app' / '1.0.0')
        cls.stack = Stack(cls.tmp / 'data', install_root=cls.install_root, https_port=18463, app_port=18021, db_port=15564)
        cls.lay = layout(cls.install_root, cls.stack.data_root)
        os.environ['GTRADE_CLIENT_DIR'] = str(cls.tmp / 'client')
        os.environ['GTRADE_SKIP_ACL'] = '1'
        answers = cls.tmp / 'a.json'
        answers.write_text(json.dumps({'company_name': 'Update Test Opticals', 'admin_username': ADMIN,
                                       'admin_password': PASSWORD, 'branch_name': 'Main'}))
        env = cls.stack.env()
        env['GTRADE_CLIENT_DIR'] = str(cls.tmp / 'client')
        proc = subprocess.run([str(cls.stack.python), '-m', 'gtrade_ctl', '--install-root', str(cls.install_root),
                               '--data-root', str(cls.stack.data_root), 'install', '--mode', 'standalone', '--version', '1.0.0',
                               '--https-port', '18463', '--app-port', '18021', '--db-port', '15564', '--answers', str(answers),
                               '--no-services', '--no-firewall', '--no-acl'], env=env, capture_output=True, text=True, timeout=1800)
        assert proc.returncode == 0, proc.stdout[-3000:] + proc.stderr[-3000:]
        cls.ctrl = StackController(cls.stack)
        cls.stack.start_app()
        cls.stack.start_web()
        assert cls.stack.wait_health().get('ok')
        cls.ctx = ssl.create_default_context(cafile=str(cls.stack.data_root / 'config' / 'tls' / 'ca.crt'))
        cls.base = 'https://localhost:18463'
        # Our tests call gtrade_ctl in-process too: it reads secrets through DPAPI (same user).
        for k in ('GTRADE_DB_PASSWORD', 'GTRADE_DB_USER'):
            os.environ.pop(k, None)

    @classmethod
    def tearDownClass(cls):
        try:
            cls.stack.down()
        finally:
            EVIDENCE.mkdir(parents=True, exist_ok=True)
            (EVIDENCE / 'backup_update_e2e.json').write_text(json.dumps(cls.evidence, indent=1, default=str))
            subprocess.run(['cmd', '/c', 'rmdir', str(cls.install_root / 'runtime')], capture_output=True)
            shutil.rmtree(cls.tmp, ignore_errors=True)
            os.environ.pop('GTRADE_CLIENT_DIR', None)

    # ---- helpers -----------------------------------------------------------------------------------
    def api(self, method, path, body=None, token=None):
        req = urllib.request.Request(self.base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Content-Type': 'application/json', **({'Authorization': f'Bearer {token}'} if token else {})})
        try:
            with urllib.request.urlopen(req, context=self.ctx, timeout=120) as r:
                return r.status, json.loads(r.read() or b'{}')
        except urllib.error.HTTPError as e:
            return e.code, json.loads(e.read() or b'{}')

    def token(self):
        code, body = self.api('POST', '/api/auth/login/', {'username': ADMIN, 'password': PASSWORD})
        self.assertEqual(code, 200, body)
        return body.get('access') or body['tokens']['access']

    def brands(self):
        code, body = self.api('GET', '/api/masters/brands/?page_size=200', token=self.token())
        rows = body['results'] if isinstance(body, dict) and 'results' in body else body
        return sorted(r['name'] for r in rows)

    def add_brand(self, name):
        code, body = self.api('POST', '/api/masters/brands/', {'name': name, 'code': name.upper().replace(' ', '')[:20]},
                              token=self.token())
        self.assertIn(code, (200, 201), body)

    def sql(self, q):
        from gtrade_ctl import secrets_store
        from gtrade_ctl.pg import PgRuntime
        su = secrets_store.load(self.lay.secrets_file)['db_superuser_password']
        return PgRuntime(self.lay.pg_bin, self.lay.pg_data, 15564, self.lay.logs_dir / 'db').psql(q, user='postgres', password=su, db='gtrade')

    def make_version(self, version, migrations=(), release=None, break_server=False):
        src = self.install_root / 'app' / install_config.read(self.lay.install_json).version
        dst = self.install_root / 'app' / version
        if dst.exists():
            shutil.rmtree(dst)
        shutil.copytree(src, dst)
        (dst / 'VERSION').write_text(version)
        mig_dir = dst / 'backend' / 'apps' / 'licensing' / 'migrations'
        existing = sorted(p.stem for p in mig_dir.glob('0*.py'))
        dep = existing[-1]
        for i, sql in enumerate(migrations):
            name = f'{int(dep[:4]) + 1:04d}_probe_{version.replace(".", "_")}_{i}'
            (mig_dir / f'{name}.py').write_text(PROBE_MIGRATION.format(dep=dep, sql=sql))
            dep = name
        rel = {'version': version, 'release_date': dt.date.today().isoformat(), 'min_upgrade_from': '1.0.0',
               'irreversible_migrations': [], 'requires_pg_major': 17, **(release or {})}
        (dst / 'release.json').write_text(json.dumps(rel))
        if break_server:
            p = dst / 'windows' / 'gtrade_server' / '__init__.py'
            p.write_text('raise RuntimeError("simulated broken release")\n' + p.read_text())
        return dst

    def table_exists(self, name):
        return self.sql(f"SELECT to_regclass('public.{name}') IS NOT NULL") == 't'

    # ---- tests -------------------------------------------------------------------------------------
    def test_01_backup_verify_and_tamper_detection(self):
        self.add_brand('Before Backup')
        (self.lay.media_dir / 'public').mkdir(parents=True, exist_ok=True)
        (self.lay.media_dir / 'public' / 'logo.txt').write_text('logo-v1')
        cfg = install_config.read(self.lay.install_json)
        m = backup.create_backup(self.lay, cfg, kind='manual')
        self.assertTrue(m['verified'])
        self.assertIn('media.zip', m['files'])
        deep = backup.verify_backup(Path(m['path']), lay=self.lay, cfg=cfg, deep=True)
        self.assertTrue(deep['ok'], deep)
        self.assertGreater(deep['restored_tables'], 100)
        bad = self.tmp / 'tampered'
        shutil.copytree(m['path'], bad)
        with open(bad / 'db.dump', 'r+b') as fh:
            fh.seek(2000)
            fh.write(b'\x00\xff' * 8)
        rep = backup.verify_backup(bad, lay=self.lay, cfg=cfg)
        self.assertFalse(rep['ok'])
        self.assertIn('checksum mismatch', ' '.join(rep['errors']))
        type(self).backup_name = m['name']
        self.evidence['backup'] = {'name': m['name'], 'bytes': sum(f['bytes'] for f in m['files'].values()),
                                   'deep_restored_tables': deep['restored_tables'], 'tamper_detected': True}

    def test_02_restore_workflow(self):
        self.add_brand('After Backup')
        (self.lay.media_dir / 'public' / 'logo.txt').write_text('logo-v2')
        cfg = install_config.read(self.lay.install_json)
        rep = backup.restore_backup(self.lay, cfg, self.lay.backups_dir / 'db' / self.backup_name,
                                    stop_app=self.ctrl.stop, start_app=self.ctrl.start)
        self.assertTrue(self.stack.wait_health().get('ok'))
        names = self.brands()
        self.assertIn('Before Backup', names)
        self.assertNotIn('After Backup', names)
        self.assertEqual((self.lay.media_dir / 'public' / 'logo.txt').read_text(), 'logo-v1')
        kept = rep['previous_database_kept_as']
        self.assertEqual(self.sql(f"SELECT count(*) FROM pg_database WHERE datname = '{kept}'"), '1')
        self.evidence['restore'] = {'restored': rep['restored'], 'previous_db_kept': kept, 'media_restored': True}

    def test_03_successful_update(self):
        self.add_brand('Before Update 1.0.1')
        self.make_version('1.0.1', ['CREATE TABLE gtrade_probe_101 (id int)'])
        rep = update.apply_update(self.lay, new_version='1.0.1', previous_app_dir=None, controller=self.ctrl, health_timeout=120)
        self.assertTrue(rep['ok'])
        self.assertEqual(len(rep['pending_migrations']), 1)
        self.assertTrue(self.table_exists('gtrade_probe_101'))
        self.assertEqual(install_config.read(self.lay.install_json).version, '1.0.1')
        self.assertIn('Before Update 1.0.1', self.brands())
        code, h = self.api('GET', '/api/health/')
        self.assertEqual(h['server_version'], '1.0.1')
        self.assertFalse((self.lay.run_dir / 'update-state.json').exists())
        # Success: services moved to the hardened accounts (accounts=None) and old grants dropped.
        self.assertIsNone(self.stack.prepared[-1])
        self.assertEqual(rep['previous_accounts'], self.ctrl.accounts())
        self.assertGreaterEqual(getattr(self.stack, 'finalized', 0), 1)
        self.evidence['update_ok'] = {k: rep[k] for k in ('from', 'to', 'backup', 'pending_migrations', 'ok')}

    def test_03b_update_starts_stopped_database_first(self):
        """2026-11-13 incident: the installer left PostgreSQL stopped and prechecks ran psql against it
        (connection refused on 5544). The update must start the database and prove SQL first."""
        self.add_brand('Before DB-stopped update')
        self.ctrl.stop()
        self.s_stop_web_and_db()
        # Same version over itself = the installer's repair/re-run path (what the owner ran).
        rep = update.apply_update(self.lay, new_version='1.0.1', previous_app_dir=None, controller=self.ctrl, health_timeout=120)
        self.assertTrue(rep['ok'], rep)
        self.assertTrue(rep['database']['sql_ok'])
        self.assertIn('Before DB-stopped update', self.brands())
        self.evidence['update_with_db_stopped'] = {'ok': rep['ok'], 'database': rep['database']}

    def s_stop_web_and_db(self):
        self.stack.stop_web()
        self.stack.stop_db()
        from gtrade_ctl.pg import PgRuntime
        self.assertFalse(PgRuntime(self.lay.pg_bin, self.lay.pg_data, 15564, self.lay.logs_dir / 'db').is_ready())

    def test_06b_early_failure_restarts_previous_version_and_proves_it(self):
        """A refusal after the installer stopped everything must not leave the shop with no server, and
        must report the previous version as running only when health proves it."""
        self.ctrl.stop()
        self.s_stop_web_and_db()
        self.make_version('1.0.5', release={'requires_pg_major': 99})
        with self.assertRaises(update.UpdateError) as cm:
            update.apply_update(self.lay, new_version='1.0.5', previous_app_dir=None, controller=self.ctrl, health_timeout=120)
        rep = json.loads(str(cm.exception))
        self.assertFalse(rep['changed'])
        self.assertTrue(rep['rolled_back'], rep)
        self.assertTrue(rep['rollback']['ok'])
        self.assertTrue(self.stack.wait_health().get('ok'))
        self.assertEqual(install_config.read(self.lay.install_json).version, '1.0.1')
        # The previous service accounts were put back, not left on the new ones.
        self.assertEqual(self.stack.prepared[-1], self.ctrl.accounts())
        self.assertEqual(rep['rollback']['accounts'], self.ctrl.accounts())
        self.evidence['early_failure_restores_previous'] = {'error': rep['error'][:160], 'previous_running': rep['rolled_back']}

    def test_06c_service_access_defect_stops_update_before_backup_and_migration(self):
        """Error 70 (2026-11-17): the web account could not list temp\\ -> nginx exited at 'switch',
        AFTER the migration, so the database had to be restored. The access check now runs in step 0:
        no backup, no migration, previous version + previous accounts running, proven healthy."""
        self.make_version('1.0.6', ['CREATE TABLE gtrade_probe_106 (id int)'])
        n_backups = len(backup.list_backups(self.lay))
        before_brands = self.brands()
        self.ctrl.access_defect = ('the service accounts cannot use their folders (nothing was started): '
                                   'C:\\ProgramData\\G-TRADE\\temp: *S-1-5-80-x has 0x0, needs 0x21 (RX)')
        try:
            with self.assertRaises(update.UpdateError) as cm:
                update.apply_update(self.lay, new_version='1.0.6', previous_app_dir=None, controller=self.ctrl,
                                    health_timeout=120)
        finally:
            self.ctrl.access_defect = None
        rep = json.loads(str(cm.exception))
        self.assertFalse(rep['changed'])
        self.assertIn('needs 0x21', rep['error'])
        self.assertTrue(rep['rolled_back'], rep)
        self.assertEqual(len(backup.list_backups(self.lay)), n_backups, 'no backup/restore was needed')
        self.assertFalse(self.table_exists('gtrade_probe_106'), 'nothing was migrated')
        self.assertEqual(install_config.read(self.lay.install_json).version, '1.0.1')
        self.assertEqual(self.brands(), before_brands)
        self.assertEqual(self.stack.prepared[-1], self.ctrl.accounts(), 'previous accounts restored')
        self.assertTrue(self.stack.wait_health().get('ok'))
        log = Path(rep['log']).read_text(encoding='utf-8')
        self.assertIn('failed-before-changes', log)
        self.assertNotIn('"migrate"', log)
        self.evidence['access_defect_before_changes'] = {'error': rep['error'][:160], 'rolled_back': rep['rolled_back']}

    def _failed_update(self, version, **kw):
        before_brands = self.brands()
        with self.assertRaises(update.UpdateError) as cm:
            update.apply_update(self.lay, new_version=version, previous_app_dir=self.install_root / 'app' / '1.0.1',
                                controller=self.ctrl, health_timeout=60)
        rep = json.loads(str(cm.exception))
        self.assertTrue(rep['rolled_back'], rep)
        self.assertEqual(install_config.read(self.lay.install_json).version, '1.0.1')
        self.assertTrue(self.stack.wait_health().get('ok'))
        code, h = self.api('GET', '/api/health/')
        self.assertEqual(h['server_version'], '1.0.1')
        self.assertEqual(self.brands(), before_brands)
        self.assertTrue(self.table_exists('gtrade_probe_101'))
        self.assertEqual(self.stack.prepared[-1], self.ctrl.accounts(), 'rollback must restore the old accounts')
        return rep

    def test_04_failed_migration_rolls_back_database(self):
        self.make_version('1.0.2', ['CREATE TABLE gtrade_probe_102 (id int)', 'SELECT 1/0'])
        rep = self._failed_update('1.0.2')
        self.assertFalse(self.table_exists('gtrade_probe_102'), 'half-applied migration must be gone')
        self.evidence['failed_migration'] = {'error': rep['error'][:200], 'rolled_back': rep['rolled_back'],
                                             'failed_db_kept_as': rep['rollback']['restored']['previous_database_kept_as']}

    def test_05_unhealthy_new_version_rolls_back(self):
        self.make_version('1.0.3', ['CREATE TABLE gtrade_probe_103 (id int)'], break_server=True)
        rep = self._failed_update('1.0.3')
        self.assertFalse(self.table_exists('gtrade_probe_103'))
        self.evidence['failed_health'] = {'error': rep['error'][:200], 'rolled_back': rep['rolled_back']}

    def test_06_downgrade_and_irreversible_refused_before_any_change(self):
        n_backups = len(backup.list_backups(self.lay))
        with self.assertRaises(update.UpdateError) as cm:
            update.apply_update(self.lay, new_version='1.0.0', previous_app_dir=None, controller=self.ctrl)
        self.assertIn('Downgrades are not supported', str(cm.exception))
        self.make_version('1.0.4', ['CREATE TABLE gtrade_probe_104 (id int)'])
        rel = json.loads((self.install_root / 'app' / '1.0.4' / 'release.json').read_text())
        migs = [p.stem for p in (self.install_root / 'app' / '1.0.4' / 'backend/apps/licensing/migrations').glob('*probe_1_0_4*')]
        rel['irreversible_migrations'] = [f'licensing.{m}' for m in migs]
        (self.install_root / 'app' / '1.0.4' / 'release.json').write_text(json.dumps(rel))
        with self.assertRaises(update.UpdateError) as cm:
            update.apply_update(self.lay, new_version='1.0.4', previous_app_dir=None, controller=self.ctrl)
        self.assertIn('irreversible', str(cm.exception))
        self.assertEqual(len(backup.list_backups(self.lay)), n_backups, 'refused updates take no backup and change nothing')
        self.assertFalse(self.table_exists('gtrade_probe_104'))
        self.assertTrue(self.stack.wait_health().get('ok'))
        self.evidence['refusals'] = {'downgrade': True, 'irreversible_without_ack': True}

    def test_07_in_app_backup_api(self):
        tok = self.token()
        code, body = self.api('POST', '/api/local/backups/', {}, token=tok)
        self.assertEqual(code, 201, body)
        self.assertTrue(body['verified'])
        code, idx = self.api('GET', '/api/local/backups/', token=tok)
        self.assertEqual(code, 200)
        self.assertEqual(idx['backups'][0]['name'], body['name'])
        self.assertNotIn('path', idx['backups'][0])
        self.assertEqual(self.api('GET', '/api/local/backups/')[0], 401)
        self.evidence['in_app_backup'] = {'name': body['name'], 'listed': True}

    def test_08_retention_policy(self):
        root = self.lay.backups_dir / 'db'
        now = dt.datetime.now(dt.timezone.utc)
        for d in range(40):
            name = f'gtrade-scheduled-fake-{d:02d}'
            (root / name).mkdir()
            (root / name / 'manifest.json').write_text(json.dumps({
                'name': name, 'kind': 'scheduled', 'created_at': (now - dt.timedelta(days=d)).isoformat(),
                'app_version': '1.0.1', 'verified': True, 'files': {'db.dump': {'sha256': 'x', 'bytes': 1}}}))
        manual_before = [b['name'] for b in backup.list_backups(self.lay) if b['kind'] == 'manual']
        deleted = backup.apply_retention(self.lay, now=now)
        left = [b for b in backup.list_backups(self.lay) if b['kind'] == 'scheduled']
        self.assertGreater(len(deleted), 0)
        self.assertGreaterEqual(len(left), 14)
        self.assertEqual([b['name'] for b in backup.list_backups(self.lay) if b['kind'] == 'manual'], manual_before)
        self.evidence['retention'] = {'fake_scheduled': 40, 'deleted': len(deleted), 'kept_scheduled': len(left)}

    def test_09_scheduler_due_logic(self):
        from gtrade_server import _db_backup_due
        tz = dt.datetime.now().astimezone().tzinfo
        at = lambda h, m=0, d=12: dt.datetime(2026, 11, d, h, m, tzinfo=tz)  # noqa: E731
        self.assertFalse(_db_backup_due(at(20), at(21, 31, 11).isoformat(), '21:30'))
        self.assertTrue(_db_backup_due(at(21, 31), at(21, 31, 11).isoformat(), '21:30'))
        self.assertTrue(_db_backup_due(at(9), at(10, 0, 10).isoformat(), '21:30'))  # catch-up after downtime
        self.assertTrue(_db_backup_due(at(9), None, '21:30'))

    def test_99_uninstall_keeps_data_unless_confirmed(self):
        self.stack.stop_web()
        self.stack.stop_app()
        env = self.stack.env()
        env['GTRADE_CLIENT_DIR'] = str(self.tmp / 'client')
        base = [str(self.stack.python), '-m', 'gtrade_ctl', '--install-root', str(self.install_root),
                '--data-root', str(self.stack.data_root), 'uninstall', '--no-services']
        r = subprocess.run(base, env=env, capture_output=True, text=True, timeout=600)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(self.lay.pg_data.exists())
        r = subprocess.run(base + ['--delete-data', '--confirm-company', 'Wrong Name'], env=env, capture_output=True, text=True, timeout=600)
        self.assertNotEqual(r.returncode, 0)
        self.assertTrue(self.lay.pg_data.exists())
        final = self.tmp / 'final-backup'
        r = subprocess.run(base + ['--delete-data', '--confirm-company', 'Update Test Opticals', '--final-backup-dir', str(final)],
                           env=env, capture_output=True, text=True, timeout=900)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse(self.stack.data_root.exists())
        self.assertTrue(backup.verify_backup(final)['ok'])
        self.evidence['uninstall'] = {'kept_by_default': True, 'wrong_confirmation_refused': True,
                                      'final_backup_verified_before_delete': True}


if __name__ == '__main__':
    unittest.main()
