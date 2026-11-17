"""A fresh server install that stops part-way must be resumable through the normal wizard.

Defect (2026-11-12): `configure` (the first install step) writes config\\install.mode, and the NSIS
wizard treated any install.mode as an existing installation. After a failure at a later step (weak
password rejected at create-org, health timeout on a slow PC), re-running setup "as advised" skipped
the company/administrator page and ran `update apply` instead, leaving an installation without an
administrator. Now the engine writes config\\install.complete after the last step, and the wizard
locks the mode / skips setup pages only when that marker exists.
"""

import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gtrade_ctl import installer_cmds
from gtrade_ctl.installer_cmds import InstallError, server_install
from gtrade_ctl.log import StepLog
from gtrade_ctl.paths import layout

WIN = Path(__file__).resolve().parents[1]


class InstallCompleteMarkerTests(unittest.TestCase):
    def setUp(self):
        tmp = Path(tempfile.mkdtemp(prefix='gtrade-resume-'))
        self.lay = layout(tmp / 'install', tmp / 'data')
        self.lay.config_dir.mkdir(parents=True)
        self.log = StepLog(tmp / 'log.jsonl')

    def _install(self):
        return server_install(self.lay, version='1.0.0', mode='standalone', https_port=8443, app_port=8001,
                              db_port=5544, answers_path=None, services=False, firewall_rule=False, acl=False,
                              log=self.log)

    def test_failed_install_leaves_no_completion_marker(self):
        with mock.patch.object(installer_cmds, '_run_steps', side_effect=InstallError('health failed')):
            with self.assertRaises(InstallError):
                self._install()
        self.assertFalse(self.lay.install_complete.exists())

    def test_successful_install_writes_completion_marker(self):
        with mock.patch.object(installer_cmds, '_run_steps', return_value=[]):
            self._install()
        self.assertTrue(self.lay.install_complete.exists())
        self.assertIn('"mode": "standalone"', self.lay.install_complete.read_text())


class WizardUpgradeDetectionTests(unittest.TestCase):
    def test_server_upgrade_requires_install_complete(self):
        nsh = (WIN / 'installer' / 'installer.nsh').read_text(encoding='utf-8')
        macro = re.search(r'!macro gtReadMode(.*?)!macroend', nsh, re.S).group(1)
        code = '\n'.join(l for l in macro.splitlines() if not l.strip().startswith(';'))
        self.assertIn(r'${FileExists} "$GtDataRoot\config\install.complete"', code)
        # The only unconditional upgrade is a workstation (install.mode written after pairing succeeded).
        self.assertNotRegex(code, r'\$\{If\} \$GtMode != ""\s*\n\s*StrCpy \$GtUpgrade "1"')
        self.assertRegex(code, r'\$\{If\} \$GtMode == "workstation"\s*\n\s*StrCpy \$GtUpgrade "1"')


if __name__ == '__main__':
    unittest.main()
