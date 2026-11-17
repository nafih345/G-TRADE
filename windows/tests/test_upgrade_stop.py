"""Regression tests for the 2026-11-13 upgrade failure:

  "psql failed (2): connection to server at 127.0.0.1, port 5544 failed: Connection refused"
  GTrade-DB / GTrade-App / GTrade-Web stopped; SCM: "The system cannot find the file specified."

Root causes (see G_OPTICALS_UPGRADE_FAILURE_ROOT_CAUSE_AND_FIX.md):
  1. electron-builder's default CHECK_APP_RUNNING force-kills every process under $INSTDIR,
     including postgres.exe -> crash; SCM restarts then hit the already-deleted pg_ctl.exe.
  2. the WinSW wrappers live under $INSTDIR\\resources\\server\\services and were deleted with the old
     program files; nothing re-created them.
  3. update apply ran psql pre-checks without starting/verifying PostgreSQL first.
  4. failures before the backup gate restarted nothing, yet the installer said "running again".

These tests run the REAL installer macro (compiled with makensis) against a scratch install
folder holding stand-in processes. They never touch the real GTrade-* services: the harness
overrides the service list with a name that does not exist.
"""

import json
import os
import shutil
import subprocess
import tempfile
import time
import unittest
from pathlib import Path

from tests.test_installer_nsh import NSH, _makensis

from gtrade_ctl import services, update

WIN = Path(__file__).resolve().parents[1]


def _compile(script: Path):
    r = subprocess.run([str(_makensis()), '/V2', '/WX', '/INPUTCHARSET', 'UTF8', str(script)],
                       capture_output=True, text=True, errors='replace', timeout=120)
    if r.returncode != 0:
        raise AssertionError(r.stdout[-3000:])


def _alive(pid: int) -> bool:
    out = subprocess.run(['tasklist', '/FI', f'PID eq {pid}', '/FO', 'CSV', '/NH'], capture_output=True, text=True).stdout
    return f'"{pid}"' in out


@unittest.skipUnless(_makensis(), 'makensis (electron-builder NSIS cache) not available')
class StopServerMacroTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-stop-'))
        cls.inst = cls.tmp / 'instdir'
        cls.result = cls.tmp / 'result.txt'
        sleeper = cls.tmp / 'sleeper.nsi'
        sleeper.write_text('\n'.join([
            'Unicode true', f'OutFile "{cls.tmp / "sleeper.exe"}"', 'RequestExecutionLevel user', 'SilentInstall silent',
            'Function .onInit', '  Sleep 90000', '  Quit', 'FunctionEnd', 'Section', 'SectionEnd']) + '\n', encoding='utf-8-sig')
        _compile(sleeper)
        harness = cls.tmp / 'stop.nsi'
        harness.write_text('\n'.join([
            'Unicode true', '!define VERSION "1.0.0"', f'OutFile "{cls.tmp / "stop.exe"}"',
            'RequestExecutionLevel user', 'SilentInstall silent', f'InstallDir "{cls.inst}"',
            '!define GT_SERVICES "\'GTradeTest-DoesNotExist\'"', '!define GT_STOP_WAIT 4', '!define APP_EXECUTABLE_FILENAME "G-TRADE.exe"',
            '!pragma warning disable 6001', '!pragma warning disable 6010',
            f'!include "{NSH}"',
            'Function .onInit', '  !insertmacro gtStopServer',
            f'  FileOpen $9 "{cls.result}" w', '  FileWrite $9 "$0"', '  FileClose $9', '  Quit', 'FunctionEnd',
            'Section', 'SectionEnd']) + '\n', encoding='utf-8-sig')
        _compile(harness)
        cls.procs = []

    @classmethod
    def tearDownClass(cls):
        for p in cls.procs:
            if p.poll() is None:
                p.kill()
        time.sleep(0.5)
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def spawn(self, rel: str) -> subprocess.Popen:
        exe = self.tmp / rel
        exe.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(self.tmp / 'sleeper.exe', exe)
        p = subprocess.Popen([str(exe)])
        self.procs.append(p)
        time.sleep(0.5)
        self.assertIsNone(p.poll())
        return p

    def run_macro(self) -> str:
        self.result.unlink(missing_ok=True)
        subprocess.run([str(self.tmp / 'stop.exe')], timeout=180, check=False)
        return self.result.read_text(encoding='mbcs').strip()

    def test_1_desktop_and_server_helpers_stopped_other_programs_untouched(self):
        desktop = self.spawn('instdir/G-TRADE.exe')
        helper = self.spawn('instdir/resources/server/runtime/python/python.exe')
        foreign_pg = self.spawn('other-postgres/bin/postgres.exe')  # e.g. the customer's own PG 17/18
        self.assertEqual(self.run_macro(), '0')
        time.sleep(0.5)
        self.assertFalse(_alive(desktop.pid), 'desktop window must be closed')
        self.assertFalse(_alive(helper.pid), 'leftover server helper must be stopped after the wait')
        self.assertTrue(_alive(foreign_pg.pid), 'a PostgreSQL outside the install folder must never be touched')

    def test_2_postgres_is_never_killed_setup_stops_instead(self):
        pg = self.spawn('instdir/resources/server/runtime/pgsql/bin/postgres.exe')
        self.assertEqual(self.run_macro(), '3')
        self.assertTrue(_alive(pg.pid), 'postgres.exe must never be force-killed (crash recovery / data risk)')


@unittest.skipUnless(_makensis(), 'makensis (electron-builder NSIS cache) not available')
class CheckAppRunningCompiles(unittest.TestCase):
    """electron-builder inserts customCheckAppRunning in the installer AND the uninstaller."""

    def _compile(self, uninstaller):
        tmp = Path(tempfile.mkdtemp(prefix='gtrade-car-'))
        try:
            body = ['Unicode true', '!define VERSION "1.0.0"', '!define APP_EXECUTABLE_FILENAME "G-TRADE.exe"',
                    f'OutFile "{tmp / "t.exe"}"',
                    'RequestExecutionLevel user', '!include "MUI2.nsh"', '!pragma warning disable 6001',
                    '!pragma warning disable 6010']  # wizard pages are not referenced by this harness
            if uninstaller:
                body += ['!define BUILD_UNINSTALLER', f'!include "{NSH}"', '!insertmacro MUI_UNPAGE_INSTFILES',
                         '!insertmacro MUI_LANGUAGE "English"', 'Section', 'WriteUninstaller "$TEMP\\u.exe"', 'SectionEnd',
                         'Section "un.x"', '!insertmacro customCheckAppRunning', 'SectionEnd']
            else:
                body += [f'!include "{NSH}"', '!insertmacro MUI_PAGE_INSTFILES', '!insertmacro MUI_LANGUAGE "English"',
                         'Section', '!insertmacro customCheckAppRunning', 'SectionEnd']
            (tmp / 'w.nsi').write_text('\n'.join(body) + '\n', encoding='utf-8-sig')
            _compile(tmp / 'w.nsi')
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_installer(self):
        self._compile(False)

    def test_uninstaller(self):
        self._compile(True)


@unittest.skipUnless(_makensis(), 'makensis (electron-builder NSIS cache) not available')
class RollbackSnapshotRules(unittest.TestCase):
    """customInit must never overwrite the rollback copy with code that was not proven healthy."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-snap-'))
        cls.inst = cls.tmp / 'instdir'
        cls.out = cls.tmp / 'r.txt'
        h = cls.tmp / 'h.nsi'
        h.write_text('\n'.join([
            'Unicode true', '!define VERSION "1.0.0"', f'OutFile "{cls.tmp / "h.exe"}"', 'RequestExecutionLevel user',
            'SilentInstall silent', f'InstallDir "{cls.inst}"', '!pragma warning disable 6001', '!pragma warning disable 6010',
            f'!include "{NSH}"', 'Function .onInit', '!insertmacro customInit',
            f'  FileOpen $9 "{cls.out}" w', '  FileWrite $9 "$GtPrevApp"', '  FileClose $9', '  Quit', 'FunctionEnd',
            'Section', 'SectionEnd']) + '\n', encoding='utf-8-sig')
        _compile(h)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _case(self, *, installed_build, verified, snapshot_marker):
        pd = Path(tempfile.mkdtemp(prefix='pd-', dir=self.tmp))
        root = pd / 'G-TRADE'
        for rel, text in {'config/install.mode': 'standalone', 'config/install.version': '1.0.0',
                          'config/install.complete': '{}'}.items():
            (root / rel).parent.mkdir(parents=True, exist_ok=True)
            (root / rel).write_text(text)
        if verified is not None:
            (root / 'config' / 'verified-build').write_text(verified)
        app = self.inst / 'resources' / 'server' / 'app' / '1.0.0'
        shutil.rmtree(self.inst, ignore_errors=True)
        (app / 'backend').mkdir(parents=True)
        (app / 'backend' / 'manage.py').write_text('# new code')
        if installed_build is not None:
            (app / 'BUILD_ID').write_text(installed_build)
        if snapshot_marker:
            snap = root / 'rollback' / 'app-1.0.0' / 'backend'
            snap.mkdir(parents=True)
            (snap / 'manage.py').write_text(snapshot_marker)
        self.out.unlink(missing_ok=True)
        subprocess.run([str(self.tmp / 'h.exe')], env={**os.environ, 'ProgramData': str(pd)}, timeout=60, check=False)
        prev = self.out.read_text(encoding='mbcs').strip()
        return prev, (root / 'rollback' / 'app-1.0.0' / 'backend' / 'manage.py').read_text()

    def test_failed_update_keeps_old_snapshot(self):
        # This PC on 2026-11-13: Program Files holds the new, never-migrated build.
        prev, content = self._case(installed_build='1.0.0-NEW', verified='1.0.0-OLD', snapshot_marker='# old good code')
        self.assertTrue(prev.endswith('app-1.0.0'))
        self.assertEqual(content, '# old good code')

    def test_legacy_build_without_id_keeps_existing_snapshot(self):
        prev, content = self._case(installed_build=None, verified=None, snapshot_marker='# old good code')
        self.assertEqual(content, '# old good code')

    def test_verified_build_refreshes_snapshot(self):
        prev, content = self._case(installed_build='1.0.0-X', verified='1.0.0-X', snapshot_marker='# older')
        self.assertEqual(content, '# new code')

    def test_first_upgrade_without_snapshot_takes_one(self):
        prev, content = self._case(installed_build=None, verified=None, snapshot_marker=None)
        self.assertEqual(content, '# new code')
        self.assertTrue(prev.endswith('app-1.0.0'))


class ServicePlans(unittest.TestCase):
    def test_db_gets_recovery_actions(self):
        cmd = services.plan_db_recovery()
        self.assertEqual(cmd[:3], ['sc.exe', 'failure', 'GTrade-DB'])
        self.assertIn('restart/5000/restart/10000/restart/30000', cmd)

    def test_app_xml_can_point_at_rollback_copy(self):
        from gtrade_ctl import install_config
        from gtrade_ctl.paths import layout
        lay = layout(r'C:\Program Files\G-TRADE\resources\server', r'C:\ProgramData\G-TRADE')
        cfg = install_config.InstallConfig(mode='standalone', version='1.0.0') if hasattr(install_config, 'InstallConfig') else None
        if cfg is None:
            self.skipTest('InstallConfig constructor differs')
        xml = services.app_service_xml(lay, cfg, '1.0.0', Path(r'C:\ProgramData\G-TRADE\rollback\app-1.0.0'))
        self.assertIn(r'C:\ProgramData\G-TRADE\rollback\app-1.0.0\backend', xml)
        self.assertNotIn(r'resources\server\app\1.0.0', xml)


class EnsureDatabaseUnit(unittest.TestCase):
    """ensure_database must start PostgreSQL BEFORE any query and prove SQL, not just 'RUNNING'."""

    def _lay(self, tmp):
        from gtrade_ctl.paths import layout
        lay = layout(tmp / 'install', tmp / 'data')
        (lay.pg_bin).mkdir(parents=True)
        (lay.pg_bin / 'pg_ctl.exe').write_text('')
        lay.pg_data.mkdir(parents=True)
        (lay.pg_data / 'PG_VERSION').write_text('17')
        return lay

    def test_order_start_then_ready_then_query(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            lay = self._lay(tmp)
            calls = []

            class Ctrl(update.Controller):
                def start_db(self, lay, cfg):
                    calls.append('start_db')

            class FakePg:
                def wait_ready(self, timeout):
                    calls.append('wait_ready')

                def psql(self, sql, **kw):
                    calls.append(f'psql:{sql}')
                    return '1'

            cfg = type('C', (), {'db_port': 5544, 'db_user': 'gtrade', 'db_name': 'gtrade'})()
            import gtrade_ctl.backup as b
            orig_pg, orig_creds = b._pg, b._creds
            b._pg, b._creds = (lambda l, c: FakePg()), (lambda l, use_superuser=False: (None, 'x'))
            try:
                rep = update.ensure_database(lay, cfg, Ctrl())
            finally:
                b._pg, b._creds = orig_pg, orig_creds
            self.assertEqual(calls, ['start_db', 'wait_ready', 'psql:SELECT 1'])
            self.assertTrue(rep['sql_ok'])
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_missing_cluster_refused_never_initialised(self):
        tmp = Path(tempfile.mkdtemp())
        try:
            lay = self._lay(tmp)
            (lay.pg_data / 'PG_VERSION').unlink()
            cfg = type('C', (), {'db_port': 5544, 'db_user': 'gtrade', 'db_name': 'gtrade'})()
            with self.assertRaises(update.UpdateError) as cm:
                update.ensure_database(lay, cfg, update.Controller())
            self.assertIn('Nothing was changed', str(cm.exception))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)


class NoElectronBuilderDefineCollisions(unittest.TestCase):
    """installer.nsh is included BEFORE electron-builder's common.nsh: re-defining one of its names
    aborts the real build ("already defined") while a standalone makensis harness still passes."""

    def test_no_define_of_electron_builder_names(self):
        import re
        tpl = WIN / 'desktop' / 'node_modules' / 'app-builder-lib' / 'templates' / 'nsis'
        if not tpl.exists():
            self.skipTest('electron-builder templates not installed')
        theirs = set()
        for f in tpl.rglob('*.nsh'):
            theirs |= set(re.findall(r'^\s*!define\s+(?:/\w+\s+)*([A-Za-z_][A-Za-z0-9_]*)', f.read_text(encoding='utf-8', errors='replace'), re.M))
        ours = set(re.findall(r'^\s*!define\s+(?:/\w+\s+)*([A-Za-z_][A-Za-z0-9_]*)', NSH.read_text(encoding='utf-8'), re.M))
        self.assertEqual(ours & theirs, set())


class UpdateExitCodes(unittest.TestCase):
    def test_unverified_failure_is_71_and_verified_is_70(self):
        from gtrade_ctl.cli import EXIT
        self.assertEqual(EXIT['update'], 70)
        self.assertEqual(EXIT['update_unverified'], 71)
        nsh = NSH.read_text(encoding='utf-8')
        self.assertIn('${If} $0 == 70', nsh)
        self.assertNotIn('previous version is running again', nsh, 'never claim it is running without proof')


if __name__ == '__main__':
    unittest.main()
