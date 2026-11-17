"""WinSW compatibility + service registration plans, against the REAL bundled wrapper.

2026-11-13 18:42: the update died with ``GTrade-App.exe refresh failed ... Unknown command: refresh``.
``refresh`` exists only in WinSW 3; the bundled wrapper is WinSW 2.12.0. No test ever ran the
planned commands against the binary we ship, so the mismatch reached the customer path.

These tests:
* run the pinned binary (``help``, ``version``, ``status``) - non-elevated, nothing is registered:
  ``status`` makes WinSW parse OUR generated XML and report an id that does not exist;
* assert every verb gtrade-ctl can send is in that binary's own command list (and ``refresh`` is not);
* drive ensure_service_files / install_all with SCM mocked and check the exact sc.exe commands
  (account, start type, dependencies, recovery) - nothing touches the real GTrade-* services;
* check the service-SID formula against ``sc showsid`` (read-only).
"""

import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path
from unittest import mock

from gtrade_ctl import services
from gtrade_ctl.install_config import InstallConfig
from gtrade_ctl.paths import layout

WIN = Path(__file__).resolve().parents[1]
PIN = json.loads((WIN / 'tooling' / 'runtime_pins.json').read_text(encoding='utf-8'))['winsw']
CANDIDATES = [WIN / 'out' / 'stage' / 'runtime' / 'winsw' / 'WinSW-x64.exe', WIN / 'out' / 'cache' / f'WinSW-x64-{PIN["version"]}.exe']


def bundled_winsw() -> Path | None:
    for p in CANDIDATES:
        if p.exists() and hashlib.sha256(p.read_bytes()).hexdigest() == PIN['sha256']:
            return p
    return None


def _cfg(mode='standalone'):
    return InstallConfig(mode=mode, version='1.0.0', https_port=8443, app_port=8765, db_port=5544,
                         hostnames=['localhost'], ip_addresses=['127.0.0.1'], data_root=r'C:\ProgramData\G-TRADE',
                         install_root=r'C:\Program Files\G-TRADE\resources\server')


@unittest.skipUnless(sys.platform == 'win32' and bundled_winsw(), 'pinned WinSW binary not available')
class RealWinSWBinary(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-winsw-'))
        cls.lay = layout(cls.tmp / 'install', cls.tmp / 'data')
        (cls.lay.runtime_dir / 'winsw').mkdir(parents=True)
        shutil.copy2(bundled_winsw(), cls.lay.winsw_exe)
        cls.files = services.write_service_files(cls.lay, _cfg(), '1.0.0')

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _probe(self, xml_text: str, *args) -> subprocess.CompletedProcess:
        """Run a copy of the wrapper with ``xml_text`` under a unique id that is never registered."""
        sid = f'GTradeCompatTest-{uuid.uuid4().hex[:8]}'
        d = Path(tempfile.mkdtemp(dir=self.tmp))
        xml_text = re.sub(r'<id>[^<]+</id>', f'<id>{sid}</id>', xml_text, count=1)
        (d / f'{sid}.xml').write_text(xml_text, encoding='utf-8')
        shutil.copy2(self.lay.winsw_exe, d / f'{sid}.exe')
        return subprocess.run([str(d / f'{sid}.exe'), *args], capture_output=True, text=True, timeout=60)

    def supported_commands(self) -> set:
        proc = self._probe(services.app_service_xml(self.lay, _cfg(), '1.0.0'), 'help')
        block = proc.stdout.split('Available commands:', 1)[1].split('Extra options:', 1)[0]
        return {line.split()[0] for line in block.splitlines() if line.strip()}

    def test_binary_is_the_pinned_version(self):
        proc = self._probe(services.app_service_xml(self.lay, _cfg(), '1.0.0'), 'version')
        self.assertIn(f'WinSW {PIN["version"]}', proc.stdout)

    def test_every_planned_verb_is_supported_and_refresh_is_not(self):
        cmds = self.supported_commands()
        self.assertIn('install', cmds)
        self.assertNotIn('refresh', cmds, 'if WinSW is upgraded to 3.x, revisit services.py (and this test)')
        missing = set(services.WINSW_VERBS) - cmds
        self.assertFalse(missing, f'gtrade-ctl would send unsupported WinSW commands: {missing}')

    def test_unsupported_verb_is_refused_before_running_anything(self):
        with self.assertRaises(ValueError):
            services.plan_winsw(self.lay, services.APP, 'refresh')

    def test_wrapper_parses_generated_app_and_web_xml(self):
        for xml in (services.app_service_xml(self.lay, _cfg('server'), '1.0.0'), services.web_service_xml(self.lay)):
            proc = self._probe(xml, 'status')
            self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
            self.assertIn('NonExistent', proc.stdout)  # parsed fine; the probe id is not a service

    def test_wrapper_copies_written_next_to_xml(self):
        for sid in (services.APP, services.WEB):
            self.assertTrue((self.lay.services_dir / f'{sid}.exe').exists())
            self.assertTrue((self.lay.services_dir / f'{sid}.xml').exists())


class SourceUsesOnlySupportedVerbs(unittest.TestCase):
    def test_no_literal_unsupported_winsw_verb_anywhere(self):
        src = '\n'.join(p.read_text(encoding='utf-8') for p in (WIN / 'gtrade_ctl').glob('*.py'))
        verbs = set(re.findall(r"plan_winsw\([^)]*?'([a-z!]+)'", src))
        self.assertTrue(verbs, 'expected plan_winsw call sites')
        self.assertLessEqual(verbs, set(services.WINSW_VERBS))
        self.assertNotRegex(src, r"['\"]refresh['\"]")


class GeneratedXml(unittest.TestCase):
    def setUp(self):
        self.lay = layout(r'C:\Program Files\G-TRADE\resources\server', r'C:\ProgramData\G-TRADE')

    def test_no_delayed_start_and_no_account_element(self):
        # WinSW 2.x: ANY <delayedAutoStart> = delayed (seen on the 11:54 install as AUTO_START (DELAYED)).
        for xml in (services.app_service_xml(self.lay, _cfg(), '1.0.0'), services.web_service_xml(self.lay)):
            self.assertNotIn('delayedAutoStart', xml)
            self.assertNotIn('serviceaccount', xml.lower())
            self.assertIn('<startmode>Automatic</startmode>', xml)

    def test_app_has_private_temp(self):
        xml = services.app_service_xml(self.lay, _cfg(), '1.0.0')
        self.assertIn(r'name="TEMP" value="C:\ProgramData\G-TRADE\temp\app"', xml)


@unittest.skipUnless(sys.platform == 'win32', 'Windows only')
class ServiceSid(unittest.TestCase):
    def test_matches_sc_showsid(self):
        for name in services.ALL:
            out = subprocess.run(['sc.exe', 'showsid', name], capture_output=True, text=True).stdout
            self.assertIn(services.service_sid(name), out, out)

    def test_account_sids(self):
        self.assertEqual(services.account_sid(r'NT SERVICE\GTrade-App'), '*' + services.service_sid('GTrade-App'))
        self.assertEqual(services.account_sid(r'NT AUTHORITY\NetworkService'), '*S-1-5-20')
        self.assertIsNone(services.account_sid('LocalSystem'))


QC_LEGACY_APP = r"""[SC] QueryServiceConfig SUCCESS

SERVICE_NAME: GTrade-App
        TYPE               : 10  WIN32_OWN_PROCESS
        START_TYPE         : 2   AUTO_START  (DELAYED)
        ERROR_CONTROL      : 1   NORMAL
        BINARY_PATH_NAME   : "C:\Program Files\G-TRADE\resources\server\services\GTrade-App.exe"
        LOAD_ORDER_GROUP   :
        TAG                : 0
        DISPLAY_NAME       : G-TRADE ERP Application
        DEPENDENCIES       : GTrade-DB
                           : RPCSS
        SERVICE_START_NAME : LocalSystem
"""
QF_DB_NONE = """[SC] QueryServiceConfig2 SUCCESS

SERVICE_NAME: GTrade-DB
        RESET_PERIOD (in seconds)    : 0
        REBOOT_MESSAGE               :
        COMMAND_LINE                 :
"""
QF_OK = """        RESET_PERIOD (in seconds)    : 3600
        FAILURE_ACTIONS              : RESTART -- Delay = 5000 milliseconds.
                                       RESTART -- Delay = 10000 milliseconds.
                                       RESTART -- Delay = 30000 milliseconds.
"""


class ParsingAndVerification(unittest.TestCase):
    """Uses the exact sc.exe output captured on the owner's PC on 2026-11-13 (the defective state)."""

    def setUp(self):
        self.lay = layout(Path(tempfile.mkdtemp()) / 'install', Path(tempfile.mkdtemp()) / 'data')
        self.lay.services_dir.mkdir(parents=True)
        for sid in (services.APP, services.WEB):
            (self.lay.services_dir / f'{sid}.exe').write_bytes(b'')
            (self.lay.services_dir / f'{sid}.xml').write_text('<service/>')

    def test_parse_qc(self):
        qc = services.parse_qc(QC_LEGACY_APP)
        self.assertEqual(qc['start_type'], 'AUTO_START')
        self.assertTrue(qc['delayed'])
        self.assertEqual(qc['dependencies'], ['GTrade-DB', 'RPCSS'])
        self.assertEqual(qc['account'], 'LocalSystem')
        self.assertTrue(qc['binary_path'].endswith('GTrade-App.exe"'))

    def test_parse_failure(self):
        self.assertEqual(services.parse_qfailure(QF_DB_NONE), {'reset': 0, 'actions': []})
        self.assertEqual(services.parse_qfailure(QF_OK), {'reset': 3600, 'actions': [5000, 10000, 30000]})
        self.assertIs(services.parse_failure_flag('FAILURE_ACTIONS_ON_NONCRASH_FAILURES:  FALSE'), False)
        self.assertIs(services.parse_failure_flag('FAILURE_ACTIONS_ON_NONCRASH_FAILURES:  TRUE'), True)

    def test_legacy_registration_reports_every_defect(self):
        info = services.parse_qc(QC_LEGACY_APP.replace(r'C:\Program Files\G-TRADE\resources\server', str(self.lay.install_root)))
        info.update(services.parse_qfailure(QF_DB_NONE), failure_flag=False)
        problems = ' | '.join(services.verify_registration(self.lay, _cfg(), services.APP, r'NT SERVICE\GTrade-App', info))
        for expect in ('DELAYED', "runs as 'LocalSystem'", "depends on ['GTrade-DB', 'RPCSS']", 'recovery actions',
                       'non-crash'):
            self.assertIn(expect, problems)

    def test_correct_registration_has_no_problems(self):
        qc = QC_LEGACY_APP.replace(r'C:\Program Files\G-TRADE\resources\server', str(self.lay.install_root))
        qc = qc.replace('  (DELAYED)', '').replace('                           : RPCSS\n', '')
        qc = qc.replace('SERVICE_START_NAME : LocalSystem', r'SERVICE_START_NAME : NT SERVICE\GTrade-App')
        info = services.parse_qc(qc)
        info.update(services.parse_qfailure(QF_OK), failure_flag=True)
        self.assertEqual(services.verify_registration(self.lay, _cfg(), services.APP, r'NT SERVICE\GTrade-App', info), [])


class FakeScm:
    """In-memory SCM: records every command, answers sc qc/qfailure like Windows would."""

    def __init__(self, lay, registered: dict, running=()):
        self.lay = lay
        self.reg = {k: dict(v) for k, v in registered.items()}
        self.running = set(running)
        self.cmds = []

    def query(self, sid):
        if sid not in self.reg:
            return 'NOT_INSTALLED'
        return 'RUNNING' if sid in self.running else 'STOPPED'

    def query_config(self, sid):
        r = self.reg.get(sid)
        if r is None:
            return None
        return {'binary_path': f'"{services.expected_binary(self.lay, sid)}"', 'start_type': 'AUTO_START',
                'delayed': r.get('delayed', False), 'account': r['account'], 'dependencies': r.get('deps', []),
                'reset': r.get('reset'), 'actions': r.get('actions', []), 'failure_flag': r.get('flag')}

    def run(self, cmd, check=True, timeout=120):
        self.cmds.append(list(cmd))
        exe = Path(cmd[0]).name.lower()
        if exe == 'sc.exe':
            verb, sid = cmd[1], cmd[2]
            r = self.reg[sid] if verb not in ('start', 'stop') else None
            if verb == 'config':
                args = dict(zip(cmd[3::2], cmd[4::2]))
                r['account'] = args['obj=']
                if 'depend=' in args:
                    r['deps'] = [] if args['depend='] == '/' else args['depend='].split('/')
            elif verb == 'failure':
                args = dict(zip(cmd[3::2], cmd[4::2]))
                r['reset'] = int(args['reset='])
                r['actions'] = [int(x) for x in args['actions='].split('/')[1::2]]
            elif verb == 'failureflag':
                r['flag'] = cmd[3] == '1'
            elif verb == 'stop':
                self.running.discard(sid)
            elif verb == 'start':
                self.running.add(sid)
        elif exe.startswith('gtrade-'):
            verb = cmd[1]
            assert verb in services.WINSW_VERBS, verb
            if verb == 'install':
                self.reg[Path(cmd[0]).stem] = {'account': 'LocalSystem', 'deps': [], 'delayed': False}
        elif exe == 'pg_ctl.exe':
            self.reg[services.DB] = {'account': services.NETWORK_SERVICE, 'deps': ['RPCSS']}
        return subprocess.CompletedProcess(cmd, 0, '', '')

    def clear_delayed(self, sid):
        self.cmds.append(['ChangeServiceConfig2', sid, 'delayed=0'])
        self.reg[sid]['delayed'] = False

    def patches(self):
        return [mock.patch.object(services, 'query', self.query), mock.patch.object(services, 'query_config', self.query_config),
                mock.patch.object(services, 'run', self.run), mock.patch.object(services, 'clear_delayed_autostart', self.clear_delayed),
                mock.patch.object(services, 'wait_state', lambda sid, want, timeout=120, poll=1.0: self.query(sid)),
                mock.patch.object(services, 'is_elevated', lambda: True)]


class RegistrationPlans(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.lay = layout(self.tmp / 'install', self.tmp / 'data')
        (self.lay.runtime_dir / 'winsw').mkdir(parents=True)
        self.lay.winsw_exe.write_bytes(b'MZ')
        self.lay.pg_bin.mkdir(parents=True)
        (self.lay.pg_bin / 'pg_ctl.exe').write_bytes(b'MZ')
        self.env = mock.patch.dict('os.environ', {'GTRADE_SKIP_ACL': '1'})
        self.env.start()

    def tearDown(self):
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _run(self, scm, fn):
        ps = scm.patches()
        for p in ps:
            p.start()
        try:
            return fn()
        finally:
            for p in ps:
                p.stop()

    def legacy_scm(self, running=()):
        """The owner's PC as found on 2026-11-13: LocalSystem App/Web (delayed), NETWORK SERVICE DB, no DB recovery."""
        rec = {'reset': 3600, 'actions': [5000, 10000, 30000], 'flag': False}
        return FakeScm(self.lay, {
            services.DB: {'account': services.NETWORK_SERVICE, 'deps': ['RPCSS'], 'reset': 0, 'actions': []},
            services.APP: {'account': 'LocalSystem', 'deps': ['GTrade-DB'], 'delayed': True, **rec},
            services.WEB: {'account': 'LocalSystem', 'deps': ['GTrade-App'], 'delayed': True, **rec},
        }, running)

    def test_update_path_reconfigures_without_refresh_or_reinstall(self):
        scm = self.legacy_scm()
        rep = self._run(scm, lambda: services.ensure_service_files(self.lay, _cfg(), '1.0.0'))
        flat = [' '.join(c) for c in scm.cmds]
        self.assertFalse([c for c in flat if 'refresh' in c or ' install' in c or ' uninstall' in c or 'delete' in c], flat)
        self.assertIn(r'sc.exe config GTrade-App start= auto obj= NT SERVICE\GTrade-App depend= GTrade-DB', flat)
        self.assertIn(r'sc.exe config GTrade-Web start= auto obj= NT SERVICE\GTrade-Web depend= GTrade-App', flat)
        self.assertIn(r'sc.exe config GTrade-DB start= auto obj= NT SERVICE\GTrade-DB', flat)  # RPCSS dep kept
        self.assertIn('sc.exe failure GTrade-DB reset= 3600 actions= restart/5000/restart/10000/restart/30000', flat)
        for sid in services.ALL:
            self.assertIn(f'sc.exe failureflag {sid} 1', flat)
            self.assertEqual(services.verify_registration(self.lay, _cfg(), sid, services.HARDENED_ACCOUNTS[sid],
                                                          scm.query_config(sid)), [])
            self.assertTrue(rep['configured'][sid]['account_changed'])
        self.assertTrue((self.lay.services_dir / 'GTrade-App.exe').exists())

    def test_running_database_is_stopped_gracefully_before_account_change(self):
        scm = self.legacy_scm(running={services.DB})
        self._run(scm, lambda: services.ensure_service_files(self.lay, _cfg(), '1.0.0'))
        flat = [' '.join(c) for c in scm.cmds]
        stop = flat.index('sc.exe stop GTrade-DB')
        cfg = flat.index(r'sc.exe config GTrade-DB start= auto obj= NT SERVICE\GTrade-DB')
        self.assertLess(stop, cfg)
        self.assertFalse(any('taskkill' in c or 'Stop-Process' in c for c in flat))

    def test_database_that_will_not_stop_is_never_reconfigured(self):
        scm = self.legacy_scm(running={services.DB})
        orig_run = scm.run

        def stuck(cmd, check=True, timeout=120):
            if cmd[:2] == ['sc.exe', 'stop']:
                scm.cmds.append(list(cmd))
                return subprocess.CompletedProcess(cmd, 0, '', '')  # SCM accepted, PostgreSQL keeps running
            return orig_run(cmd, check, timeout)
        scm.run = stuck
        with self.assertRaises(services.ServiceError) as cm:
            self._run(scm, lambda: services.ensure_service_files(self.lay, _cfg(), '1.0.0'))
        self.assertIn('did not stop', str(cm.exception))
        self.assertEqual(scm.reg[services.DB]['account'], services.NETWORK_SERVICE)

    def test_rollback_restores_previous_accounts(self):
        scm = self.legacy_scm()
        self._run(scm, lambda: services.ensure_service_files(self.lay, _cfg(), '1.0.0'))
        self._run(scm, lambda: services.ensure_service_files(self.lay, _cfg(), '1.0.0', accounts=dict(services.LEGACY_ACCOUNTS)))
        for sid, acc in services.LEGACY_ACCOUNTS.items():
            self.assertTrue(services.same_account(scm.reg[sid]['account'], acc))
            self.assertFalse(scm.reg[sid].get('delayed'))  # start type/recovery fixes are kept

    def test_mismatch_after_configuration_is_an_error_not_ignored(self):
        scm = self.legacy_scm()
        orig = scm.run

        def ignore_account(cmd, check=True, timeout=120):
            if cmd[:2] == ['sc.exe', 'config']:
                scm.cmds.append(list(cmd))
                return subprocess.CompletedProcess(cmd, 0, '', '')  # "succeeds" but changes nothing
            return orig(cmd, check, timeout)
        scm.run = ignore_account
        with self.assertRaises(services.ServiceError) as cm:
            self._run(scm, lambda: services.ensure_service_files(self.lay, _cfg(), '1.0.0'))
        self.assertIn("expected 'NT SERVICE", str(cm.exception))

    def test_fresh_install_registers_then_hardens(self):
        scm = FakeScm(self.lay, {})
        self._run(scm, lambda: services.install_all(self.lay, _cfg('server'), '1.0.0'))
        flat = [' '.join(c) for c in scm.cmds]
        self.assertTrue(flat[0].endswith('pg_ctl.exe register -N GTrade-DB -U NT AUTHORITY\\NetworkService -D '
                                         f'{self.lay.pg_data} -S auto -w'), flat[0])
        self.assertTrue(any(c.endswith('GTrade-App.exe install') for c in flat))
        for sid in services.ALL:
            self.assertEqual(scm.reg[sid]['account'], services.HARDENED_ACCOUNTS[sid])
        self.assertFalse([c for c in flat if 'refresh' in c])

    def test_missing_wrapper_source_is_a_clear_error(self):
        self.lay.winsw_exe.unlink()
        with self.assertRaises(services.ServiceError) as cm:
            services.write_service_files(self.lay, _cfg(), '1.0.0')
        self.assertIn('Run the installer again', str(cm.exception))

    def test_workstation_registers_nothing(self):
        scm = FakeScm(self.lay, {})
        self.assertEqual(self._run(scm, lambda: services.install_all(self.lay, _cfg('workstation'), '1.0.0')), [])
        self.assertEqual(scm.cmds, [])


if __name__ == '__main__':
    unittest.main()
