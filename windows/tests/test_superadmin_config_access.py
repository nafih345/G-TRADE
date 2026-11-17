"""2026-11-17: ``gtrade-ctl create-superadmin`` -> ``PermissionError: [WinError 5] Access is denied:
C:\\ProgramData\\G-TRADE\\config\\install.json``.

Root cause (proven on the owner's PC with a read-only elevated probe): the installed ACLs are correct
- ``config\\`` is SYSTEM + Administrators Full, ``NT SERVICE\\GTrade-App`` read only, and every file
inherits that. The command ran in a prompt that was NOT elevated. Under UAC an administrator account's
normal token holds BUILTIN\\Administrators only as a *deny-only* group, so it matches no ACE in
``config\\`` and may read nothing there. The tool made that hard to see: it asked for the password
twice first, and ``install_config.read`` called ``Path.exists()``, which on Windows itself raises
PermissionError when the folder cannot be listed, so the clear "run as Administrator" message
(``access_problem``) never ran and a raw traceback came out.

The fix never widens an ACL: ``install_config.require_access`` checks before any prompt and refuses
with an exact instruction (exit 2, nothing changed); ``read`` turns the folder-level denial into
``ConfigAccessError``; ``main`` prints that without a traceback.

These tests use REAL ACLs on throw-away folders under %TEMP% (never ProgramData), shaped by the real
``winacl.apply_data_root_policy``:

* ``NotElevatedPrompt`` runs only in a NON-elevated process (a VS Code terminal / normal prompt of an
  administrator account = the reported situation) and runs the real command against config\\ locked to
  exactly the installed principals.
* ``ConfigAclByToken`` evaluates the same ACLs for each identity with AuthzAccessCheck (by SID):
  elevated administrator, the same account not elevated (Administrators deny-only), the three service
  accounts, a standard user, SYSTEM. Runs elevated or not.
* ``ElevatedAdministrator`` runs only in an ELEVATED process: the real elevated token passes the check
  and the bootstrap writes install.json without any extra ACE.
"""

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gtrade_ctl import cli, install_config, services, winacl
from gtrade_ctl.install_config import ConfigAccessError, ConfigError, InstallConfig
from gtrade_ctl.paths import layout

WINDOWS = sys.platform == 'win32'
ME = winacl.current_user_sid() if WINDOWS else None
ELEVATED = services.is_elevated() if WINDOWS else False
win_only = unittest.skipUnless(WINDOWS and ME, 'needs Windows ACLs')

APP, WEB, DB = (services.service_sid(s) for s in (services.APP, services.WEB, services.DB))
BA, LOCAL_ADMIN = 'S-1-5-32-544', 'S-1-5-114'
# Groups of an interactive local logon (whoami /groups): Everyone, Users, INTERACTIVE, CONSOLE LOGON,
# Authenticated Users, This Organization, Local account, LOCAL.
INTERACTIVE_GROUPS = ('S-1-1-0', 'S-1-5-32-545', 'S-1-5-4', 'S-1-2-1', 'S-1-5-11', 'S-1-5-15', 'S-1-5-113', 'S-1-2-0')
SOME_USER = 'S-1-5-21-1000-2000-3000-1001'  # a local account by SID only (no lookup needed)
FILE_READ_DATA, FILE_WRITE_DATA = 0x1, 0x2
SECRET_FILES = ('install.json', 'gtrade.env', 'secrets.dpapi')


def _proc(payload, code=0):
    return subprocess.CompletedProcess([], code, stdout=json.dumps(payload) + '\n', stderr='')


def _tty():
    t = io.StringIO('')
    t.isatty = lambda: True
    return t


class ScratchInstall(unittest.TestCase):
    """A scratch install root + data root with the real data-root policy applied."""

    def setUp(self):
        self._skip_acl = os.environ.pop('GTRADE_SKIP_ACL', None)
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-saacl-'))
        self.lay = layout(self.tmp / 'install', self.tmp / 'data')
        self.lay.install_root.mkdir(parents=True)
        self.lay.ensure_data_tree()
        cfg = InstallConfig(mode='standalone', version='1.0.0', data_root=str(self.lay.data_root),
                            install_root=str(self.lay.install_root))
        install_config.record_history(cfg, 'install', version='1.0.0')
        install_config.write(self.lay.install_json, cfg)
        install_config.write_env(self.lay.env_file, install_config.env_values(cfg, self.lay))
        self.lay.secrets_file.write_bytes(b'dpapi-blob-not-a-real-secret')
        self.lay.tls_dir.mkdir(parents=True, exist_ok=True)
        for f in ('tls/ca.key', 'tls/ca.crt', 'tls/server.key', 'tls/server.crt', 'nginx.conf', 'mime.types'):
            (self.lay.config_dir / f).write_text('x')
        self.digest = hashlib.sha256(self.lay.install_json.read_bytes()).hexdigest()

    def tearDown(self):
        if WINDOWS and ME:
            # The test user owns everything it created, so it may always give itself access back.
            for p in (self.lay.config_dir, self.lay.data_root):
                try:
                    winacl.set_acl(p, [(ME, 'F')], replace=True, protect=False, inherit=True)
                except winacl.AclError:
                    pass
            subprocess.run(['icacls', str(self.tmp), '/reset', '/T', '/C', '/Q'], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._skip_acl is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._skip_acl
        self.assertFalse(self.tmp.exists(), f'scratch folder left behind: {self.tmp}')

    def apply_installed_policy(self):
        """The installer's policy. A non-elevated test process stands in for the installer's
        Administrators grant with its own SID while the policy is applied (as the other ACL tests
        do), then drops that SID from config\\ so the folder holds exactly what the owner's PC holds:
        SYSTEM F, Administrators F, GTrade-App RX (+ GTrade-Web List on the folder itself)."""
        winacl.apply_data_root_policy(self.lay, include_current_user=not ELEVATED, keep_network_service=False)
        if not ELEVATED:
            winacl._remove(self.lay.config_dir, ME)
            winacl._remove(self.lay.tls_dir, ME)

    def config_aces(self):
        return sorted((t, m, s) for t, _f, m, s in winacl.read_dacl(self.lay.config_dir)['aces'])

    def cli(self, *argv, stdin=None):
        with mock.patch('sys.stdout', new_callable=io.StringIO) as out, \
                mock.patch.object(sys, 'stdin', stdin or io.StringIO('')):
            rc = cli.main(['--install-root', str(self.lay.install_root), '--data-root', str(self.lay.data_root),
                           *argv])
        return rc, json.loads(out.getvalue())


@win_only
@unittest.skipIf(ELEVATED, 'models the NON-elevated prompt; this process is elevated')
class NotElevatedPrompt(ScratchInstall):
    def setUp(self):
        super().setUp()
        self.apply_installed_policy()
        self.acl_before = self.config_aces()
        # The scenario is only meaningful if this process really is locked out, like the reported prompt.
        with self.assertRaises(PermissionError):
            self.lay.install_json.read_bytes()

    def test_the_installed_acl_has_no_entry_for_this_user(self):
        sids = {s for _t, _m, s in self.acl_before}
        self.assertEqual(sids, {'S-1-5-18', BA, APP, WEB})
        self.assertNotIn(ME[1:], sids)

    def test_exists_itself_raises_which_is_why_read_no_longer_calls_it(self):
        with self.assertRaises(PermissionError):
            self.lay.install_json.exists()

    def test_read_gives_clear_error_not_raw_permission_error(self):
        with self.assertRaises(ConfigAccessError) as ctx:
            install_config.read(self.lay.install_json)
        msg = str(ctx.exception)
        self.assertIn('NON-elevated', msg)
        self.assertIn('Run as administrator', msg)
        self.assertIn('Do not change the folder permissions', msg)

    def test_create_superadmin_is_refused_before_the_password_prompt(self):
        """The exact reported command, in a prompt that is not elevated."""
        with mock.patch('getpass.getpass', side_effect=AssertionError('password asked in a doomed prompt')), \
                mock.patch('gtrade_ctl.django_bridge.manage', side_effect=AssertionError('Django must not run')):
            rc, data = self.cli('create-superadmin', '--user', 'nafih', '--full-name', 'Local Super Admin',
                                stdin=_tty())
        self.assertEqual(rc, cli.EXIT['config'])
        self.assertIn('must be run from an elevated Command Prompt', data['error'])
        self.assertIn('Run as administrator', data['error'])
        self.assertIn('Nothing was changed', data['error'])
        self.assertIn(str(self.lay.install_root), data['error'])
        self.assertEqual((data['elevated'], data['changed']), (False, False))
        self.assertNotIn('trace', data)

    def test_status_and_reset_password_are_refused_the_same_way(self):
        for argv in (('create-superadmin', '--status'), ('create-superadmin', '--user', 'nafih', '--reset-password'),
                     ('reset-password', '--user', 'admin'), ('reset-password', '--list-admins')):
            with mock.patch('getpass.getpass', side_effect=AssertionError('no prompt')), \
                    mock.patch('gtrade_ctl.django_bridge.manage', side_effect=AssertionError('no Django')):
                rc, data = self.cli(*argv, stdin=_tty())
            self.assertEqual(rc, cli.EXIT['config'], argv)
            self.assertIn('elevated Command Prompt', data['error'], argv)
            self.assertNotIn('trace', data, argv)

    def test_other_commands_get_the_clear_message_without_traceback(self):
        rc, data = self.cli('health')
        self.assertEqual(rc, cli.EXIT['config'])
        self.assertIn('ConfigAccessError', data['error'])
        self.assertIn('Run the command from an elevated Command Prompt', data['error'])
        self.assertNotIn('trace', data)

    def test_refusal_changes_no_permission_and_no_byte(self):
        with mock.patch('getpass.getpass', side_effect=AssertionError):
            self.cli('create-superadmin', '--user', 'nafih', stdin=_tty())
        self.assertEqual(self.config_aces(), self.acl_before)       # nothing widened, nothing "repaired"
        winacl.set_acl(self.lay.config_dir, [(ME, 'R')], replace=True, protect=None, inherit=True)  # look only
        self.assertEqual(hashlib.sha256(self.lay.install_json.read_bytes()).hexdigest(), self.digest)
        self.assertEqual(sorted(p.name for p in self.lay.config_dir.iterdir() if p.name.endswith('.tmp')), [])


@win_only
class ConfigAclByToken(ScratchInstall):
    """Who may use the installed config\\ - computed by Windows itself (AuthzAccessCheck) per token."""

    def setUp(self):
        super().setUp()
        self.apply_installed_policy()

    def rights(self, rel, sid, groups=(), deny_only=()):
        return winacl.effective_rights(self.lay.config_dir / rel, sid, groups, deny_only)

    def test_elevated_administrator_reads_and_writes_the_config(self):
        groups = INTERACTIVE_GROUPS + (BA, LOCAL_ADMIN)
        for f in SECRET_FILES + ('.',):
            m = self.rights(f, SOME_USER, groups)
            self.assertEqual(m & (FILE_READ_DATA | FILE_WRITE_DATA), FILE_READ_DATA | FILE_WRITE_DATA, f)

    def test_same_administrator_account_not_elevated_gets_nothing(self):
        for f in SECRET_FILES + ('.', 'tls/ca.key'):
            self.assertEqual(self.rights(f, SOME_USER, INTERACTIVE_GROUPS, deny_only=(BA, LOCAL_ADMIN)), 0, f)

    def test_standard_user_gets_nothing(self):
        for f in SECRET_FILES + ('.', 'tls/ca.key', 'nginx.conf'):
            self.assertEqual(self.rights(f, SOME_USER, INTERACTIVE_GROUPS), 0, f)

    def test_app_service_reads_but_never_writes(self):
        for f in SECRET_FILES:
            m = self.rights(f, APP, winacl.SERVICE_TOKEN_GROUPS)
            self.assertTrue(m & FILE_READ_DATA, f)
            self.assertFalse(m & winacl.WRITE_BITS, f'App must not be able to change {f}: 0x{m:X}')
        self.assertFalse(self.rights('tls/ca.key', APP, winacl.SERVICE_TOKEN_GROUPS) & FILE_READ_DATA)

    def test_web_and_db_services_cannot_read_settings_or_secrets(self):
        for sid in (WEB, DB):
            for f in SECRET_FILES + ('tls/ca.key',):
                self.assertFalse(self.rights(f, sid, winacl.SERVICE_TOKEN_GROUPS) & FILE_READ_DATA, (sid, f))
        self.assertTrue(self.rights('nginx.conf', WEB, winacl.SERVICE_TOKEN_GROUPS) & FILE_READ_DATA)

    def test_system_has_full_control(self):
        for f in SECRET_FILES:
            self.assertEqual(self.rights(f, 'S-1-5-18', (BA,)) & 0x1F01FF, 0x1F01FF, f)

    def test_deny_only_group_matches_deny_entries_but_never_allows(self):
        probe = self.tmp / 'deny-probe'
        probe.mkdir()
        winacl.set_acl(probe, [(ME, 'F'), ('*S-1-1-0', 'F'), ('*' + BA, 'F')], replace=True, protect=True,
                       inherit=False)
        self.assertEqual(winacl.effective_rights(probe, SOME_USER, (), deny_only=(BA,)), 0)  # BA allow: ignored
        subprocess.run(['icacls', str(probe), '/deny', f'*{BA}:(RD)'], check=True, capture_output=True)
        m = winacl.effective_rights(probe, SOME_USER, ('S-1-1-0',), deny_only=(BA,))
        self.assertFalse(m & FILE_READ_DATA)                                               # BA deny: applied
        self.assertTrue(m & FILE_WRITE_DATA)


@win_only
@unittest.skipUnless(ELEVATED, 'needs a real elevated administrator token (Run as administrator)')
class ElevatedAdministrator(ScratchInstall):
    """Run from an elevated prompt: the reported command works with the policy exactly as installed."""

    def setUp(self):
        super().setUp()
        self.apply_installed_policy()
        self.acl_before = self.config_aces()

    def test_installed_acl_shape(self):
        self.assertEqual({s for _t, _m, s in self.acl_before}, {'S-1-5-18', BA, APP, WEB})

    def test_access_check_passes_for_read_and_write(self):
        install_config.require_access(self.lay, 'create-superadmin', write=True)
        self.assertEqual(install_config.read(self.lay.install_json).mode, 'standalone')

    def test_bootstrap_prompts_twice_creates_and_records_history_without_new_ace(self):
        calls, prompts = [], []

        def fake_manage(lay, cmd, cfg=None, input_text=None, **kw):
            calls.append((cmd, input_text))
            return _proc({'ok': True, 'created': True, 'username': 'nafih'})
        with mock.patch('getpass.getpass', side_effect=lambda p='': prompts.append(p) or 'Same-Pass-2026!'), \
                mock.patch('gtrade_ctl.django_bridge.manage', fake_manage):
            rc, data = self.cli('create-superadmin', '--user', 'nafih', '--full-name', 'Local Super Admin', stdin=_tty())
        self.assertEqual(rc, 0, data)
        self.assertEqual(len(prompts), 2)
        self.assertEqual(json.loads(calls[0][1])['password'], 'Same-Pass-2026!')
        self.assertNotIn('Same-Pass-2026!', ' '.join(calls[0][0]))
        hist = install_config.read(self.lay.install_json).history
        self.assertEqual((hist[-1]['event'], hist[-1]['username']), ('create-superadmin', 'nafih'))
        self.assertEqual(self.config_aces(), self.acl_before)
        aces = winacl.read_dacl(self.lay.install_json)['aces']
        self.assertTrue(all(f & 0x10 for _t, f, _m, _s in aces), 'install.json must only inherit from config')
        self.assertEqual({s for *_x, s in aces}, {'S-1-5-18', BA, APP})

    def test_mismatched_passwords_change_nothing(self):
        answers = iter(['Pass-One-2026!', 'Pass-Two-2026!'])
        with mock.patch('getpass.getpass', side_effect=lambda p='': next(answers)), \
                mock.patch('gtrade_ctl.django_bridge.manage', side_effect=AssertionError('no Django')):
            rc, data = self.cli('create-superadmin', '--user', 'nafih', stdin=_tty())
        self.assertEqual(rc, cli.EXIT['config'])
        self.assertIn('different', data['error'])
        self.assertEqual(hashlib.sha256(self.lay.install_json.read_bytes()).hexdigest(), self.digest)


class RequireAccessUnit(unittest.TestCase):
    """No ACLs: the decision logic of require_access / read with simulated denials."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-saunit-'))
        self.lay = layout(self.tmp / 'install', self.tmp / 'data')
        self.lay.config_dir.mkdir(parents=True)
        for f in SECRET_FILES:
            (self.lay.config_dir / f).write_text('{}')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_readable_config_passes(self):
        install_config.require_access(self.lay, 'create-superadmin', write=True)

    def test_readonly_attribute_is_not_a_denial(self):
        """atomic_write_text clears the attribute itself (test_config_permissions), so an elevated
        administrator must not be refused because a copy tool set it."""
        import stat
        os.chmod(self.lay.install_json, stat.S_IREAD)
        try:
            install_config.require_access(self.lay, 'create-superadmin', write=True)
            cfg = InstallConfig(mode='standalone', version='1.0.0')
            install_config.write(self.lay.install_json, cfg)  # ...and the write that follows succeeds
            self.assertEqual(install_config.read(self.lay.install_json).mode, 'standalone')
        finally:
            os.chmod(self.lay.install_json, stat.S_IREAD | stat.S_IWRITE)

    def test_missing_install_json_is_not_installed(self):
        self.lay.install_json.unlink()
        with self.assertRaises(ConfigError) as ctx:
            install_config.require_access(self.lay, 'create-superadmin')
        self.assertNotIsInstance(ctx.exception, ConfigAccessError)
        self.assertIn('not installed', str(ctx.exception))

    def test_denied_and_not_elevated_gives_the_elevation_instruction(self):
        with mock.patch('builtins.open', side_effect=PermissionError(13, 'Access is denied')), \
                mock.patch.object(services, 'is_elevated', return_value=False):
            with self.assertRaises(ConfigAccessError) as ctx:
                install_config.require_access(self.lay, 'create-superadmin')
        self.assertIn('"gtrade-ctl create-superadmin" must be run from an elevated Command Prompt', str(ctx.exception))

    def test_denied_while_elevated_points_at_the_acl_not_at_elevation(self):
        with mock.patch('builtins.open', side_effect=PermissionError(13, 'Access is denied')), \
                mock.patch.object(services, 'is_elevated', return_value=True), \
                mock.patch.object(winacl, 'access_problem', return_value='Access denied to X; repair-permissions'):
            with self.assertRaises(ConfigAccessError) as ctx:
                install_config.require_access(self.lay, 'create-superadmin')
        self.assertIn('repair-permissions', str(ctx.exception))
        self.assertNotIn('must be run from an elevated', str(ctx.exception))

    def test_read_turns_folder_level_denial_into_config_access_error(self):
        with mock.patch.object(Path, 'read_text', side_effect=PermissionError(13, 'Access is denied')), \
                mock.patch.object(winacl, 'access_problem', return_value='clear message'):
            with self.assertRaises(ConfigAccessError):
                install_config.read(self.lay.install_json)

    def test_read_of_missing_file_is_config_error(self):
        with self.assertRaises(ConfigError) as ctx:
            install_config.read(self.tmp / 'nope' / 'install.json')
        self.assertNotIsInstance(ctx.exception, ConfigAccessError)


if __name__ == '__main__':
    unittest.main()
