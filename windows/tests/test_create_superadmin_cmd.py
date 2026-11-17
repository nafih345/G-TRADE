"""`gtrade-ctl create-superadmin`: the Local Super Admin bootstrap entry point.

The password reaches local_superadmin on stdin only (never argv / process listings), --status sends
nothing, an idempotent "already exists" is a success, and a refusal is a failed check (exit 1).
The Django side is covered by backend apps/licensing/tests_local_client_management.py.
"""

import io
import json
import subprocess
import sys
import unittest
from types import SimpleNamespace
from unittest import mock

from gtrade_ctl import cli, installer_cmds


def _proc(payload, code=0):
    return subprocess.CompletedProcess([], code, stdout=json.dumps(payload) + '\n', stderr='' if code == 0 else 'CommandError: invalid input')


class CreateSuperAdminCommandTests(unittest.TestCase):
    def setUp(self):
        cli._load_extensions()
        self.calls = []
        self.lay = SimpleNamespace(install_json='unused')
        # The config-access pre-check is exercised against REAL ACLs in test_superadmin_config_access.py.
        self.require_access = mock.patch.object(installer_cmds.install_config, 'require_access').start()
        self.record_history = mock.patch.object(installer_cmds.install_config, 'record_history').start()
        self.write = mock.patch.object(installer_cmds.install_config, 'write').start()
        mock.patch.object(installer_cmds, '_layout', return_value=self.lay).start()
        mock.patch.object(installer_cmds, '_cfg', return_value=SimpleNamespace(history=[])).start()
        self.addCleanup(mock.patch.stopall)

    def _run(self, argv, stdin_text, result, code=0, stdin=None):
        def fake_manage(lay, cmd, cfg=None, input_text=None, **kw):
            self.calls.append((cmd, input_text))
            return _proc(result, code)
        with mock.patch('gtrade_ctl.django_bridge.manage', fake_manage), \
                mock.patch.object(sys, 'stdin', stdin or io.StringIO(stdin_text)), \
                mock.patch('sys.stdout', new_callable=io.StringIO) as out:
            rc = cli.main(argv)
        return rc, json.loads(out.getvalue())

    def test_registered(self):
        self.assertIn('create-superadmin', cli.COMMANDS)

    def test_password_goes_on_stdin_never_argv(self):
        rc, data = self._run(['create-superadmin', '--user', 'localsa', '--full-name', 'Asha Rao'],
                             'Very-Secret-Pass-26\n', {'ok': True, 'created': True, 'username': 'localsa'})
        self.assertEqual(rc, 0)
        cmd, stdin = self.calls[0]
        self.assertEqual(cmd, ['local_superadmin'])
        self.assertNotIn('Very-Secret-Pass-26', ' '.join(cmd))
        self.assertEqual(json.loads(stdin)['password'], 'Very-Secret-Pass-26')
        self.assertTrue(data['created'])

    def test_status_sends_no_input(self):
        rc, _ = self._run(['create-superadmin', '--status'], '', {'ok': True, 'exists': False, 'super_admins': []})
        self.assertEqual(rc, 0)
        self.assertEqual(self.calls[0], (['local_superadmin', '--status'], ''))

    def test_reset_password_flag_and_refusal_exit_code(self):
        rc, data = self._run(['create-superadmin', '--user', 'x', '--reset-password'], 'Pw-Long-Enough-26\n',
                             {'ok': False, 'errors': {'username': 'not the Local Super Admin'}}, code=1)
        self.assertEqual(self.calls[0][0], ['local_superadmin', '--reset-password'])
        self.assertEqual(rc, cli.EXIT['check'])
        self.assertIn('error', data)

    def test_user_required(self):
        rc, data = self._run(['create-superadmin'], '', {})
        self.assertEqual(rc, cli.EXIT['config'])
        self.assertEqual(self.calls, [])

    # ---- interactive prompt (console) -----------------------------------------------------------
    @staticmethod
    def _tty():
        tty = io.StringIO('')
        tty.isatty = lambda: True
        return tty

    def _run_tty(self, argv, answers, result=None):
        prompts = []

        def fake_getpass(prompt=''):
            prompts.append(prompt)
            return answers[len(prompts) - 1]
        with mock.patch('getpass.getpass', fake_getpass):
            rc, data = self._run(argv, '', result or {'ok': True, 'created': True, 'username': 'nafih'},
                                 stdin=self._tty())
        return rc, data, prompts

    def test_mismatched_passwords_change_nothing(self):
        rc, data, prompts = self._run_tty(['create-superadmin', '--user', 'nafih'], ['Pass-One-2026!', 'Pass-Two-2026!'])
        self.assertEqual(rc, cli.EXIT['config'])
        self.assertEqual(len(prompts), 2)
        self.assertIn('different', data['error'])
        self.assertEqual(self.calls, [])            # Django never ran
        self.write.assert_not_called()

    def test_matching_passwords_create_once_and_record_history(self):
        rc, data, prompts = self._run_tty(['create-superadmin', '--user', 'nafih', '--full-name', 'Local Super Admin'],
                                          ['Same-Pass-2026!', 'Same-Pass-2026!'])
        self.assertEqual(rc, 0)
        self.assertEqual(len(prompts), 2)
        self.assertEqual(len(self.calls), 1)
        cmd, stdin = self.calls[0]
        self.assertEqual(cmd, ['local_superadmin'])
        self.assertEqual(json.loads(stdin), {'username': 'nafih', 'password': 'Same-Pass-2026!', 'email': '',
                                             'full_name': 'Local Super Admin'})
        self.record_history.assert_called_once()
        self.assertEqual(self.record_history.call_args.kwargs, {'username': 'nafih'})
        self.write.assert_called_once()

    def test_access_is_checked_before_the_password_prompt(self):
        order = []
        self.require_access.side_effect = lambda *a, **k: order.append(('access', k.get('write')))
        with mock.patch('getpass.getpass', side_effect=lambda p='': order.append('prompt') or 'Same-Pass-2026!'):
            self._run(['create-superadmin', '--user', 'nafih'], '', {'ok': True, 'created': True}, stdin=self._tty())
        self.assertEqual(order[0], ('access', True))  # write: install.json gets the history entry
        self.assertEqual(order[1:], ['prompt', 'prompt'])

    def test_refused_access_means_no_prompt_and_no_django(self):
        from gtrade_ctl.install_config import ConfigAccessError
        self.require_access.side_effect = ConfigAccessError('must be run from an elevated Command Prompt')
        with mock.patch('getpass.getpass', side_effect=AssertionError('password must not be asked')):
            rc, data = self._run(['create-superadmin', '--user', 'nafih'], '', {}, stdin=self._tty())
        self.assertEqual(rc, cli.EXIT['config'])
        self.assertIn('elevated Command Prompt', data['error'])
        self.assertFalse(data['changed'])
        self.assertNotIn('trace', data)
        self.assertEqual(self.calls, [])

    def test_idempotent_rerun_writes_no_history(self):
        rc, data = self._run(['create-superadmin', '--user', 'nafih'], 'Same-Pass-2026!\n',
                             {'ok': True, 'created': False, 'username': 'nafih', 'detail': 'already exists'})
        self.assertEqual(rc, 0)
        self.assertFalse(data['created'])
        self.write.assert_not_called()

    def test_status_checks_read_access_only(self):
        self._run(['create-superadmin', '--status'], '', {'ok': True, 'exists': False})
        self.assertEqual(self.require_access.call_args.kwargs, {'write': False})


if __name__ == '__main__':
    unittest.main()
