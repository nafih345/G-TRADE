"""Installer error 1 (2026-11-13): PermissionError on C:\\ProgramData\\G-TRADE\\config\\install.json.

Root cause: winacl.protect ran ``icacls <dir> /inheritance:r /grant:r SID:(OI)(CI)F ... /T``. On
every FILE below the folder that strips the inherited ACEs while the (OI)(CI) grants do not apply
to a file, so the file is left with an EMPTY DACL - nobody, not even an elevated Administrator,
can read it - and icacls still exits 0. The first install wrote install.json (configure), applied
the ACLs (prepare-data) and then died reading install.json; every retry died in configure.

These tests use the REAL icacls on throw-away folders under %TEMP% (never ProgramData). They run
as the current, non-elevated user: ``include_current_user=True`` stands in for the elevated
installer's Administrators grant, and the test user owns every file, so it may always rewrite
the ACL (just like Administrators own the files the elevated installer created).
"""

import hashlib
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import unittest
from functools import partial
from pathlib import Path
from unittest import mock

from gtrade_ctl import install_config, installer_cmds, winacl
from gtrade_ctl.install_config import ConfigAccessError, InstallConfig
from gtrade_ctl.installer_cmds import InstallError, server_install
from gtrade_ctl.log import StepLog
from gtrade_ctl.paths import layout

WINDOWS = sys.platform == 'win32'
ME = winacl.current_user_sid() if WINDOWS else None
win_only = unittest.skipUnless(WINDOWS and ME, 'needs Windows icacls')


def old_protect(path: Path, *principals: str) -> None:
    """The defective pre-2026-11-13 call, verbatim in shape."""
    grants = []
    for p in principals:
        grants += ['/grant:r', f'{p}:(OI)(CI)F']
    subprocess.run(['icacls', str(path), '/inheritance:r', *grants, '/T', '/C', '/Q'], check=True,
                   capture_output=True)


def readable(path: Path) -> bool:
    try:
        path.read_bytes()
        return True
    except PermissionError:
        return False


def acl(path: Path) -> str:
    return subprocess.run(['icacls', str(path)], capture_output=True, text=True).stdout


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class AclTestBase(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop('GTRADE_SKIP_ACL', None)
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-acl-'))
        self.lay = layout(self.tmp / 'install', self.tmp / 'data')
        self.lay.install_root.mkdir()

    def tearDown(self):
        if self._saved is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._saved
        if WINDOWS:  # only ever our own throw-away temp folder
            subprocess.run(['icacls', str(self.tmp), '/reset', '/T', '/C', '/Q'], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)

    def policy(self):
        """apply_data_root_policy as the elevated installer would get it (current user ~ Administrators)."""
        # keep_network_service pinned: never let the result depend on this PC's real GTrade-DB account.
        return partial(winacl.apply_data_root_policy, include_current_user=True, keep_network_service=False)

    def seed_install(self, mode='standalone'):
        """A first install that got as far as configure + data tree + a database cluster + a backup."""
        cfg = InstallConfig(mode=mode, version='1.0.0', data_root=str(self.lay.data_root),
                            install_root=str(self.lay.install_root))
        install_config.record_history(cfg, 'install', version='1.0.0')
        install_config.write(self.lay.install_json, cfg)
        install_config.write_env(self.lay.env_file, install_config.env_values(cfg, self.lay))
        self.lay.ensure_data_tree()
        self.lay.secrets_file.write_bytes(b'dpapi-blob')
        self.lay.pg_data.mkdir(parents=True)
        (self.lay.pg_data / 'PG_VERSION').write_text('17\n')
        (self.lay.pg_data / 'base').mkdir()
        (self.lay.pg_data / 'base' / '16384').write_bytes(os.urandom(4096))
        (self.lay.backups_dir / 'db' / 'gtrade-20261113.dump').write_bytes(os.urandom(2048))
        (self.lay.logs_dir / 'install' / 'install-old.jsonl').write_text('{"step": "configure"}\n')
        return cfg

    def data_files(self):
        return sorted(p for p in self.lay.data_root.rglob('*') if p.is_file())


@win_only
class DefectReproductionTests(AclTestBase):
    def test_old_protect_leaves_files_with_empty_dacl(self):
        """Documents the root cause: the old call exits 0 and the file becomes unreadable for everyone."""
        cfg_dir = self.lay.config_dir
        cfg_dir.mkdir(parents=True)
        f = cfg_dir / 'install.json'
        f.write_text('{}')
        old_protect(cfg_dir, winacl.SYSTEM, ME)
        self.assertFalse(readable(f))
        self.assertEqual(acl(f).splitlines()[0].strip(), str(f))  # no ACEs at all
        self.assertIn('(OI)(CI)(F)', acl(cfg_dir))                 # ...while the folder looks fine


@win_only
class ProtectTests(AclTestBase):
    def test_new_protect_keeps_existing_files_readable_and_inheriting(self):
        cfg_dir = self.lay.config_dir
        (cfg_dir / 'tls').mkdir(parents=True)
        (cfg_dir / 'install.json').write_text('{"a": 1}')
        (cfg_dir / 'tls' / 'ca.crt').write_text('cert')
        winacl.protect(cfg_dir, [winacl.SYSTEM, winacl.ADMINISTRATORS], read=[winacl.NETWORK_SERVICE],
                       include_current_user=True)
        self.assertTrue(readable(cfg_dir / 'install.json'))
        self.assertTrue(readable(cfg_dir / 'tls' / 'ca.crt'))
        self.assertIn('(I)', acl(cfg_dir / 'install.json'))
        self.assertNotIn('(I)', acl(cfg_dir))  # the folder itself does not inherit from above

    def test_existing_config_file_with_restricted_permissions_is_repaired(self):
        cfg_dir = self.lay.config_dir
        cfg_dir.mkdir(parents=True)
        f = cfg_dir / 'install.json'
        f.write_text('{"keep": true}')
        before = digest(f)
        old_protect(cfg_dir, winacl.SYSTEM, ME)
        self.assertFalse(readable(f))
        winacl.protect(cfg_dir, [winacl.SYSTEM, winacl.ADMINISTRATORS], include_current_user=True)
        self.assertTrue(readable(f))
        self.assertEqual(digest(f), before)

    def test_config_directory_with_incorrect_acl_is_repaired(self):
        cfg_dir = self.lay.config_dir
        cfg_dir.mkdir(parents=True)
        (cfg_dir / 'gtrade.env').write_text('X=1\n')
        # Wrong ACL on the folder: SYSTEM only, inheritance cut (the user keeps ownership).
        subprocess.run(['icacls', str(cfg_dir), '/inheritance:r', '/grant:r', f'{winacl.SYSTEM}:(OI)(CI)F'],
                       check=True, capture_output=True)
        with self.assertRaises(PermissionError):
            (cfg_dir / 'gtrade.env').read_text()
        winacl.protect(cfg_dir, [winacl.SYSTEM, winacl.ADMINISTRATORS], include_current_user=True)
        self.assertEqual((cfg_dir / 'gtrade.env').read_text(), 'X=1\n')
        (cfg_dir / 'new.txt').write_text('created after')  # new files inherit
        self.assertTrue(readable(cfg_dir / 'new.txt'))

    def test_missing_folder_is_skipped(self):
        winacl.protect(self.tmp / 'nope', [winacl.SYSTEM])  # no error, nothing created
        self.assertFalse((self.tmp / 'nope').exists())


@win_only
class DataRootPolicyTests(AclTestBase):
    def test_policy_repairs_damaged_install_and_preserves_every_byte(self):
        self.seed_install()
        before = {p: digest(p) for p in self.data_files()}
        old_protect(self.lay.data_root, winacl.SYSTEM, ME)  # the state the failed first install left
        self.assertFalse(readable(self.lay.install_json))
        self.assertFalse(readable(self.lay.pg_data / 'PG_VERSION'))
        self.policy()(self.lay)
        self.assertEqual({p: digest(p) for p in self.data_files()}, before)  # every file readable, unchanged
        self.assertEqual(install_config.read(self.lay.install_json).mode, 'standalone')

    def test_policy_is_narrow(self):
        self.seed_install()
        (self.lay.data_root / 'client').mkdir()
        parent_before = acl(self.tmp)
        self.policy()(self.lay)
        for d in (self.lay.data_root, self.lay.config_dir, self.lay.pg_data.parent, self.lay.backups_dir):
            text = acl(d)
            self.assertNotIn('Everyone', text, d)
            self.assertNotIn('BUILTIN\\Users', text, d)
        # Users may only READ the public client folder (server URL + public CA certificate).
        client = acl(self.lay.data_root / 'client')
        self.assertIn('BUILTIN\\Users:(OI)(CI)(RX)', client)
        # Each service's own account, by name (registered here) or by SID (clean PC); NETWORK SERVICE gone.
        from gtrade_ctl import services

        def has(text, name, perm):
            return f'NT SERVICE\\{name}:{perm}' in text or f'{services.service_sid(name)}:{perm}' in text
        self.assertTrue(has(acl(self.lay.pg_data.parent), 'GTrade-DB', '(OI)(CI)(F)'))
        self.assertTrue(has(acl(self.lay.config_dir), 'GTrade-App', '(OI)(CI)(RX)'))
        for d in (self.lay.config_dir, self.lay.pg_data.parent, self.lay.data_root):
            self.assertNotIn('NETWORK SERVICE', acl(d), d)
        # Nothing outside the data root was touched.
        self.assertEqual(acl(self.tmp), parent_before)

    def test_policy_on_healthy_install_changes_no_content(self):
        self.seed_install()
        before = {p: digest(p) for p in self.data_files()}
        self.policy()(self.lay)
        self.policy()(self.lay)  # idempotent
        after = {p: digest(p) for p in self.data_files()}
        self.assertEqual(before, after)


@win_only
class AccessReportingTests(AclTestBase):
    def test_unrepairable_config_gives_clear_error_not_traceback(self):
        self.seed_install()
        old_protect(self.lay.config_dir, winacl.SYSTEM, ME)
        with self.assertRaises(ConfigAccessError) as ctx:
            install_config.read(self.lay.install_json)
        msg = str(ctx.exception)
        self.assertIn(str(self.lay.install_json), msg)
        self.assertIn('empty ACL', msg)
        self.assertIn('repair-permissions', msg)

    def test_readonly_config_file_is_still_updated(self):
        cfg = self.seed_install()
        os.chmod(self.lay.install_json, stat.S_IREAD)
        cfg.version = '1.0.1'
        install_config.write(self.lay.install_json, cfg)
        self.assertEqual(install_config.read(self.lay.install_json).version, '1.0.1')


class AtomicWriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-atomic-'))

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_failed_replace_keeps_previous_file_and_leaves_no_temp(self):
        f = self.tmp / 'install.json'
        f.write_text('{"old": true}')
        with mock.patch.object(install_config.os, 'replace', side_effect=PermissionError(13, 'Permission denied')), \
                mock.patch.object(install_config.time, 'sleep'):
            with self.assertRaises(ConfigAccessError):
                install_config.atomic_write_text(f, '{"new": true}')
        self.assertEqual(f.read_text(), '{"old": true}')
        self.assertEqual([p.name for p in self.tmp.iterdir()], ['install.json'])

    def test_transient_lock_is_retried(self):
        f = self.tmp / 'install.json'
        f.write_text('old')
        real = os.replace
        calls = {'n': 0}

        def flaky(a, b):
            calls['n'] += 1
            if calls['n'] == 1:
                raise PermissionError(13, 'locked by antivirus')
            return real(a, b)
        with mock.patch.object(install_config.os, 'replace', side_effect=flaky), \
                mock.patch.object(install_config.time, 'sleep'):
            install_config.atomic_write_text(f, 'new')
        self.assertEqual(f.read_text(), 'new')

    def test_write_produces_complete_json_and_mode_markers(self):
        p = self.tmp / 'config' / 'install.json'
        install_config.write(p, InstallConfig(mode='server', version='2.0.0'))
        self.assertEqual(json.loads(p.read_text())['mode'], 'server')
        self.assertEqual((p.parent / 'install.mode').read_text(), 'server')
        self.assertEqual((p.parent / 'install.version').read_text(), '2.0.0')


class InstallerFlowTests(AclTestBase):
    """Administrator installation / failed install followed by retry, through server_install."""

    def run_first_steps(self, names=('permissions', 'configure', 'prepare-data'), acl=True):
        executed = []

        def fake_run(lay, steps, log):
            done = []
            for name, fn in steps:
                if name not in names:
                    continue
                with log.step(name):
                    res = fn()
                executed.append(name)
                done.append({'step': name, 'result': res})
            return done
        log = StepLog(self.tmp / 'steps.jsonl')
        with mock.patch.object(installer_cmds, '_run_steps', side_effect=fake_run), \
                mock.patch('gtrade_ctl.django_bridge.set_active'):
            rep = server_install(self.lay, version='1.0.1', mode='standalone', https_port=8443, app_port=8001,
                                 db_port=5544, answers_path=None, services=False, firewall_rule=False, acl=acl,
                                 log=log)
        return executed, rep, log

    def test_permissions_run_before_configure(self):
        os.environ['GTRADE_SKIP_ACL'] = '1'
        self.seed_install()
        with mock.patch.object(winacl, 'apply_data_root_policy') as pol:
            executed, rep, _ = self.run_first_steps()
        self.assertEqual(executed, ['permissions', 'configure', 'prepare-data'])
        self.assertEqual(rep['steps'][0]['result'], {'repaired': True})
        self.assertEqual(pol.call_count, 1)  # prepare-data does not repeat it when nothing new was created

    def test_fresh_install_applies_policy_in_prepare_only(self):
        os.environ['GTRADE_SKIP_ACL'] = '1'
        with mock.patch.object(winacl, 'apply_data_root_policy') as pol:
            executed, rep, _ = self.run_first_steps()
        self.assertIn('skipped', rep['steps'][0]['result'])
        self.assertEqual(pol.call_count, 1)
        self.assertTrue(self.lay.install_json.exists())

    def test_retry_preserves_existing_configuration(self):
        os.environ['GTRADE_SKIP_ACL'] = '1'
        cfg = self.seed_install()
        db_before = digest(self.lay.pg_data / 'base' / '16384')
        backup_before = digest(self.lay.backups_dir / 'db' / 'gtrade-20261113.dump')
        self.run_first_steps()
        after = install_config.read(self.lay.install_json)
        self.assertEqual(after.install_id, cfg.install_id)
        self.assertEqual(after.mode, 'standalone')
        self.assertEqual(after.created_at, cfg.created_at)
        self.assertEqual(after.version, '1.0.1')
        self.assertEqual([h['event'] for h in after.history], ['install', 'reinstall'])
        self.assertEqual(digest(self.lay.pg_data / 'base' / '16384'), db_before)
        self.assertEqual(digest(self.lay.backups_dir / 'db' / 'gtrade-20261113.dump'), backup_before)
        self.assertEqual(self.lay.secrets_file.read_bytes(), b'dpapi-blob')

    @win_only
    def test_failed_install_followed_by_retry_with_real_acls(self):
        """The exact owner-PC sequence: damaged ACLs from the first attempt, then setup is re-run."""
        cfg = self.seed_install()
        db_before = digest(self.lay.pg_data / 'base' / '16384')
        old_protect(self.lay.data_root, winacl.SYSTEM, ME)
        self.assertFalse(readable(self.lay.install_json))
        with mock.patch.object(winacl, 'apply_data_root_policy', self.policy()):
            executed, rep, log = self.run_first_steps()
        self.assertEqual(executed, ['permissions', 'configure', 'prepare-data'])
        self.assertEqual(install_config.read(self.lay.install_json).install_id, cfg.install_id)
        self.assertEqual(digest(self.lay.pg_data / 'base' / '16384'), db_before)
        self.assertTrue(readable(self.lay.logs_dir / 'install' / 'install-old.jsonl'))  # evidence kept, readable
        self.assertEqual([e['status'] for e in log.read() if e['step'] == 'configure'], ['start', 'ok'])

    @win_only
    def test_unrepairable_state_stops_with_clear_message(self):
        self.seed_install()
        old_protect(self.lay.config_dir, winacl.SYSTEM, ME)
        before = sorted(p.name for p in self.lay.config_dir.iterdir())
        with mock.patch.object(winacl, 'apply_data_root_policy'):  # repair "fails" (e.g. foreign owner)
            with self.assertRaises(InstallError) as ctx:
                self.run_first_steps()
        self.assertIn('Permissions could not be repaired', str(ctx.exception))
        self.assertIn('empty ACL', str(ctx.exception))
        self.assertEqual(sorted(p.name for p in self.lay.config_dir.iterdir()), before)  # nothing deleted

    def test_repair_permissions_command_requires_admin(self):
        os.environ['GTRADE_SKIP_ACL'] = '1'
        self.seed_install()
        from gtrade_ctl import cli
        with mock.patch('gtrade_ctl.services.is_elevated', return_value=False), \
                mock.patch('sys.stdout'):
            code = cli.main(['--install-root', str(self.lay.install_root), '--data-root', str(self.lay.data_root),
                             'repair-permissions'])
        self.assertEqual(code, 2)


if __name__ == '__main__':
    unittest.main()
