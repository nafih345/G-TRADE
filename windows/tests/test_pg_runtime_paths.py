"""Where the bundled PostgreSQL programs (pg_dump / pg_restore / psql) are found.

Regression for the 2026-11-14 backup failure: run without ``--install-root`` / ``GTRADE_INSTALL_ROOT``,
gtrade_ctl fell back to the hardcoded ``C:\\Program Files\\G-TRADE ERP`` and looked for
``...\\G-TRADE ERP\\runtime\\pgsql\\bin\\pg_dump.exe``, while the installer puts the runtime in
``$INSTDIR\\resources\\server\\runtime\\pgsql\\bin``.

Scenarios: installed (Program Files), packaged (win-unpacked / out\\stage), development (env/explicit
roots, GTRADE_PG_BIN) and missing runtime (workstation, nothing installed). Nothing here starts
PostgreSQL, contacts a database or takes a backup; the only real program run is ``pg_dump --version``.
"""

import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from tests.helpers import WINDOWS_DIR

from gtrade_ctl import backup, paths
from gtrade_ctl.paths import Layout, layout, resolve_install_root
from gtrade_ctl.pg import BACKUP_TOOLS, PgRuntimeMissing, require_pg_tools

EXE = '.exe' if os.name == 'nt' else ''
STAGE = WINDOWS_DIR / 'out' / 'stage'


def make_server_tree(root: Path, *, with_pg=True) -> Path:
    """A minimal fake ``resources\\server`` tree (empty files stand in for the programs)."""
    (root / 'runtime' / 'python').mkdir(parents=True)
    (root / 'runtime' / 'python' / 'python.exe').write_bytes(b'')
    (root / 'gtrade-ctl.cmd').write_text('@echo off\n')
    (root / 'app').mkdir()
    if with_pg:
        bin_dir = root / 'runtime' / 'pgsql' / 'bin'
        bin_dir.mkdir(parents=True)
        for t in ('pg_ctl', 'postgres', *BACKUP_TOOLS):
            (bin_dir / (t + EXE)).write_bytes(b'')
    return root


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-pgpath-'))
        self.pf = self.tmp / 'Program Files'
        self.data = self.tmp / 'ProgramData' / 'G-TRADE'
        self.data.mkdir(parents=True)
        # No ambient GTRADE_* / PG override may leak into these tests.
        self._env = mock.patch.dict(os.environ, {}, clear=False)
        self._env.start()
        for k in ('GTRADE_INSTALL_ROOT', 'GTRADE_PG_BIN', 'GTRADE_DATA_ROOT'):
            os.environ.pop(k, None)

    def tearDown(self):
        self._env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def resolve(self, **kw):
        kw.setdefault('env', {})
        kw.setdefault('executable', str(self.tmp / 'dev-venv' / 'Scripts' / 'python.exe'))
        kw.setdefault('db_service_image', None)
        kw.setdefault('program_files', [self.pf])
        return resolve_install_root(self.data, **kw)


class InstalledTests(_Base):
    def setUp(self):
        super().setUp()
        self.server = make_server_tree(self.pf / 'G OPTICALS' / 'resources' / 'server')
        self.bin = self.server / 'runtime' / 'pgsql' / 'bin'

    def test_service_process_resolves_from_bundled_python(self):
        root, source = self.resolve(executable=str(self.server / 'runtime' / 'python' / 'python.exe'))
        self.assertEqual((root, source), (self.server, 'bundled-python'))
        lay = Layout(root, self.data, source)
        self.assertEqual(lay.pg_bin, self.bin)
        self.assertEqual(require_pg_tools(lay), self.bin)

    def test_expected_installed_path_shape(self):
        root, _ = self.resolve(executable=str(self.server / 'runtime' / 'python' / 'python.exe'))
        rel = Layout(root, self.data).pg_bin.joinpath('pg_dump' + EXE).relative_to(self.pf)
        self.assertEqual(rel.parts, ('G OPTICALS', 'resources', 'server', 'runtime', 'pgsql', 'bin', 'pg_dump' + EXE))

    def test_env_from_service_definition_wins(self):
        other = make_server_tree(self.tmp / 'D' / 'Apps' / 'G OPTICALS' / 'resources' / 'server')
        root, source = self.resolve(env={'GTRADE_INSTALL_ROOT': str(other)},
                                    executable=str(self.server / 'runtime' / 'python' / 'python.exe'))
        self.assertEqual((root, source), (other, 'env'))

    def test_install_json_record(self):
        (self.data / 'config').mkdir()
        (self.data / 'config' / 'install.json').write_text(json.dumps({'install_root': str(self.server)}))
        self.assertEqual(self.resolve(program_files=[self.tmp / 'nowhere']), (self.server, 'install.json'))

    def test_unreadable_install_json_is_skipped(self):
        (self.data / 'config').mkdir()
        (self.data / 'config' / 'install.json').write_text('{not json')
        self.assertEqual(self.resolve(), (self.server, 'known-folder'))

    def test_custom_install_dir_found_from_registered_db_service(self):
        custom = make_server_tree(self.tmp / 'E' / 'Software' / 'Optics' / 'resources' / 'server')
        image = f'"{custom / "runtime" / "pgsql" / "bin" / "pg_ctl.exe"}" runservice -N "GTrade-DB" -D "C:\\x" -w'
        self.assertEqual(self.resolve(db_service_image=image, program_files=[self.tmp / 'nowhere']), (custom, 'service'))
        # db_service_image may also be the lookup function (as in production)
        self.assertEqual(self.resolve(db_service_image=lambda name: image if name == 'GTrade-DB' else None,
                                      program_files=[self.tmp / 'nowhere']), (custom, 'service'))

    def test_other_postgresql_service_is_never_used(self):
        image = r'"C:\Program Files\PostgreSQL\17\bin\pg_ctl.exe" runservice -N "postgresql-x64-17" -D "x"'
        self.assertIsNone(paths._from_service(image))

    def test_legacy_g_trade_folder_found(self):
        shutil.rmtree(self.pf / 'G OPTICALS')
        legacy = make_server_tree(self.pf / 'G-TRADE' / 'resources' / 'server')
        self.assertEqual(self.resolve(), (legacy, 'known-folder'))

    def test_layout_uses_resolver_when_no_root_given(self):
        with mock.patch.object(paths, 'resolve_install_root', return_value=(self.server, 'service')) as r:
            lay = layout(data_root=self.data)
        r.assert_called_once()
        self.assertEqual((lay.install_root, lay.install_root_source), (self.server, 'service'))
        self.assertEqual(lay.pg_bin, self.bin)


class PackagedTests(_Base):
    def test_win_unpacked_tree_resolves_from_its_own_python(self):
        server = make_server_tree(self.tmp / 'out' / 'installer' / 'win-unpacked' / 'resources' / 'server')
        root, source = self.resolve(executable=str(server / 'runtime' / 'python' / 'python.exe'))
        self.assertEqual((root, source), (server, 'bundled-python'))

    def test_build_trees_are_never_picked_unless_running_from_them(self):
        make_server_tree(self.tmp / 'out' / 'stage')
        root, source = self.resolve()
        self.assertEqual(source, 'not-found')
        self.assertNotIn('out', [p.lower() for p in root.parts])

    @unittest.skipUnless((STAGE / 'runtime' / 'pgsql' / 'bin' / ('pg_dump' + EXE)).is_file(), 'out/stage not built')
    def test_real_staged_runtime_has_working_backup_tools(self):
        root, source = resolve_install_root(None, env={}, executable=str(STAGE / 'runtime' / 'python' / 'python.exe'),
                                            db_service_image=None, program_files=[self.tmp])
        self.assertEqual((root.resolve(), source), (STAGE.resolve(), 'bundled-python'))
        bin_dir = require_pg_tools(Layout(root, self.data, source))
        self.assertTrue((bin_dir / 'libpq.dll').is_file() or os.name != 'nt')
        for tool in BACKUP_TOOLS:  # --version only: no server, no database
            out = subprocess.run([str(bin_dir / (tool + EXE)), '--version'], capture_output=True, text=True, timeout=30)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertIn(' 17.', out.stdout)


class DevelopmentTests(_Base):
    def test_explicit_root(self):
        server = make_server_tree(self.tmp / 'dev' / 'server')
        lay = layout(server, self.data)
        self.assertEqual((lay.install_root_source, lay.pg_bin), ('explicit', server / 'runtime' / 'pgsql' / 'bin'))

    def test_env_root(self):
        server = make_server_tree(self.tmp / 'dev' / 'server')
        os.environ['GTRADE_INSTALL_ROOT'] = str(server)
        lay = layout(data_root=self.data)
        self.assertEqual((lay.install_root, lay.install_root_source), (server, 'env'))

    def test_pg_bin_override_for_dev_postgres(self):
        dev_bin = self.tmp / 'PostgreSQL' / '17' / 'bin'
        dev_bin.mkdir(parents=True)
        for t in BACKUP_TOOLS:
            (dev_bin / (t + EXE)).write_bytes(b'')
        os.environ['GTRADE_PG_BIN'] = str(dev_bin)
        lay = layout(self.tmp / 'no-install', self.data)
        self.assertEqual(require_pg_tools(lay), dev_bin)


class MissingRuntimeTests(_Base):
    def test_workstation_install_has_no_pgsql(self):
        server = make_server_tree(self.pf / 'G OPTICALS' / 'resources' / 'server', with_pg=False)
        root, source = self.resolve(executable=str(server / 'runtime' / 'python' / 'python.exe'))
        self.assertEqual((root, source), (server, 'bundled-python'))
        lay = Layout(root, self.data, source)
        with self.assertRaises(PgRuntimeMissing) as cm:
            require_pg_tools(lay)
        msg = str(cm.exception)
        self.assertIn(str(server / 'runtime' / 'pgsql' / 'bin'), msg)
        self.assertIn('pg_dump', msg)
        self.assertIn('Workstation', msg)

    def test_nothing_installed_reports_not_found_never_old_default(self):
        root, source = self.resolve()
        self.assertEqual(source, 'not-found')
        self.assertEqual(root, self.pf / 'G OPTICALS' / 'resources' / 'server')
        self.assertNotIn('G-TRADE ERP', str(root))
        with self.assertRaises(PgRuntimeMissing) as cm:
            require_pg_tools(Layout(root, self.data, source))
        self.assertIn('--install-root', str(cm.exception))

    def test_system_postgresql_is_not_a_fallback(self):
        sys_bin = self.pf / 'PostgreSQL' / '17' / 'bin'
        sys_bin.mkdir(parents=True)
        for t in ('pg_ctl', *BACKUP_TOOLS):
            (sys_bin / (t + EXE)).write_bytes(b'')
        root, source = self.resolve()
        self.assertEqual(source, 'not-found')
        with self.assertRaises(PgRuntimeMissing):
            require_pg_tools(Layout(root, self.data, source))

    def test_backup_refuses_before_touching_anything(self):
        lay = Layout(self.tmp / 'missing-server', self.data, 'not-found')
        cfg = SimpleNamespace(db_port=5544, db_user='gtrade', db_name='gtrade', version='1.0.0', install_id='x')
        with mock.patch.object(backup, '_creds', side_effect=AssertionError('credentials must not be read')):
            with self.assertRaises(backup.BackupError) as cm:
                backup.create_backup(lay, cfg, kind='manual')
        self.assertIn('pg_dump', str(cm.exception))
        self.assertFalse((self.data / 'backups').exists())
        self.assertFalse((self.data / 'run' / 'backup.lock').exists())

    def test_verify_reports_and_restore_refuses_without_runtime(self):
        bk = self.tmp / 'bk'
        bk.mkdir()
        (bk / 'db.dump').write_bytes(b'x')
        (bk / 'manifest.json').write_text(json.dumps({'files': {'db.dump': {'sha256': backup._sha256(bk / 'db.dump'), 'bytes': 1}}}))
        lay = Layout(self.tmp / 'missing-server', self.data, 'not-found')
        cfg = SimpleNamespace(db_port=5544, db_user='gtrade', db_name='gtrade', version='1.0.0', install_id='x')
        result = backup.verify_backup(bk, lay=lay, cfg=cfg)
        self.assertFalse(result['ok'])
        self.assertTrue(any('pg_restore' in e for e in result['errors']))
        with mock.patch.object(backup, '_creds', side_effect=AssertionError('credentials must not be read')):
            stop = mock.Mock(side_effect=AssertionError('the app must not be stopped'))
            with self.assertRaises(backup.BackupError):
                backup.restore_backup(lay, cfg, bk, stop_app=stop, start_app=stop)
        stop.assert_not_called()

    def test_partial_runtime_lists_each_missing_tool(self):
        server = make_server_tree(self.tmp / 'srv')
        (server / 'runtime' / 'pgsql' / 'bin' / ('pg_restore' + EXE)).unlink()
        with self.assertRaises(PgRuntimeMissing) as cm:
            require_pg_tools(Layout(server, self.data))
        self.assertIn('pg_restore', str(cm.exception))
        self.assertNotIn('pg_dump' + EXE + ',', str(cm.exception))


if __name__ == '__main__':
    unittest.main()
