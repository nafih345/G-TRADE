"""Regression tests for the 2026-11-12 "G-TRADE setup did not complete (error 2)" install failure.

Root cause: installer.nsh defined the default data folder as "$COMMONPROGRAMDATA\\G-TRADE". NSIS has
no such constant; makensis keeps an unknown "$NAME" as literal text and only warns (electron-builder
hides makensis warnings). gtrade-ctl therefore received the RELATIVE data root
"$COMMONPROGRAMDATA\\G-TRADE", resolved it against the installer's working directory
(C:\\Program Files\\G-TRADE), wrote config + the install log there, and then refused it in
prepare-data ("The data folder cannot be inside Program Files." -> EXIT['config'] == 2). The expected
C:\\ProgramData\\G-TRADE\\logs\\install was never created.

Guards:
  * every $token in installer.nsh is a declared Var, a register or a real NSIS constant (static);
  * the include compiles with makensis /WX (warnings are errors) as installer AND uninstaller;
  * gtrade-ctl refuses a relative / unexpanded data root before writing anything (exit 2, no files).
"""

import contextlib
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from gtrade_ctl import cli
from gtrade_ctl.paths import check_root_path, layout, validate_data_root

WIN = Path(__file__).resolve().parents[1]
NSH = WIN / 'installer' / 'installer.nsh'

# NSIS 3 built-in constants / variables (https://nsis.sourceforge.io/Docs/Chapter4.html#varconstant)
NSIS_BUILTINS = {
    'INSTDIR', 'OUTDIR', 'CMDLINE', 'LANGUAGE', 'PROGRAMFILES', 'PROGRAMFILES32', 'PROGRAMFILES64',
    'COMMONFILES', 'COMMONFILES32', 'COMMONFILES64', 'DESKTOP', 'EXEDIR', 'EXEFILE', 'EXEPATH',
    'WINDIR', 'SYSDIR', 'TEMP', 'STARTMENU', 'SMPROGRAMS', 'SMSTARTUP', 'QUICKLAUNCH', 'DOCUMENTS',
    'SENDTO', 'RECENT', 'FAVORITES', 'MUSIC', 'PICTURES', 'VIDEOS', 'NETHOOD', 'FONTS', 'TEMPLATES',
    'APPDATA', 'LOCALAPPDATA', 'PRINTHOOD', 'INTERNET_CACHE', 'COOKIES', 'HISTORY', 'PROFILE',
    'ADMINTOOLS', 'RESOURCES', 'RESOURCES_LOCALIZED', 'CDBURN_AREA', 'HWNDPARENT', 'PLUGINSDIR',
}
REGISTERS = {str(i) for i in range(10)} | {f'R{i}' for i in range(10)}


def _code_lines(text):
    for raw in text.splitlines():
        line = raw.strip()
        if not line or line.startswith((';', '#')):
            continue
        yield raw


def _makensis():
    base = Path(os.environ.get('LOCALAPPDATA', '')) / 'electron-builder' / 'Cache'
    found = sorted(base.glob('nsis-*/*/Bin/makensis.exe')) or sorted(base.glob('nsis-*/*/makensis.exe'))
    return found[-1] if found else None


class InstallerNshStaticTests(unittest.TestCase):
    def setUp(self):
        self.text = NSH.read_text(encoding='utf-8')

    def test_no_commonprogramdata_constant(self):
        code = '\n'.join(_code_lines(self.text))
        self.assertNotIn('$COMMONPROGRAMDATA', code)

    def test_every_dollar_token_is_declared_or_builtin(self):
        declared = set(re.findall(r'^\s*Var\s+(?:/GLOBAL\s+)?([A-Za-z_][A-Za-z0-9_]*)', self.text, re.M))
        unknown = set()
        for line in _code_lines(self.text):
            # $$ = literal $, $\r $\n $\" = escapes, ${X} = define/LogicLib, $(X) = language string
            for m in re.finditer(r'\$(\$|\\.|\{[^}]*\}|\([^)]*\)|[A-Za-z_][A-Za-z0-9_]*|[0-9])', line):
                tok = m.group(1)
                if tok[0] in '$\\{(':
                    continue
                if tok not in declared and tok not in NSIS_BUILTINS and tok not in REGISTERS:
                    unknown.add(tok)
        self.assertEqual(unknown, set(), f'undeclared NSIS variables/constants (kept as literal text!): {unknown}')

    def test_default_data_root_comes_from_programdata(self):
        self.assertIn('ReadEnvStr $GtDataRoot "ProgramData"', self.text)
        self.assertRegex(self.text, r'!define GT_DATA_DIRNAME "G-TRADE"')  # internal folder name kept

    def test_data_page_rejects_relative_path(self):
        self.assertIn('Enter a full folder path', self.text)


@unittest.skipUnless(_makensis(), 'makensis (electron-builder NSIS cache) not available')
class InstallerNshCompileTests(unittest.TestCase):
    """Compile installer.nsh with warnings as errors, the way electron-builder includes it."""

    def _compile(self, uninstaller: bool):
        tmp = Path(tempfile.mkdtemp(prefix='gtrade-nsh-'))
        try:
            body = [
                'Unicode true', '!define VERSION "1.0.0"', f'OutFile "{tmp / "t.exe"}"',
                'RequestExecutionLevel user', '!include "MUI2.nsh"',
                # 6001 = Var declared but unused in this half (installer vs uninstaller) - expected.
                # Everything else, notably 6000 "unknown variable/constant", fails the build.
                '!pragma warning disable 6001',
            ]
            if uninstaller:
                body += ['!define BUILD_UNINSTALLER', f'!include "{NSH}"',
                         '!insertmacro customUnWelcomePage', '!insertmacro MUI_UNPAGE_INSTFILES',
                         '!insertmacro MUI_LANGUAGE "English"',
                         'Section', 'WriteUninstaller "$TEMP\\u.exe"', 'SectionEnd',
                         'Section "un.x"', '!insertmacro customUnInstall', 'SectionEnd']
            else:
                body += [f'!include "{NSH}"', '!insertmacro MUI_PAGE_DIRECTORY',
                         '!insertmacro customPageAfterChangeDir', '!insertmacro MUI_PAGE_INSTFILES',
                         '!insertmacro MUI_LANGUAGE "English"',
                         'Function .onInit', '!insertmacro customInit', 'FunctionEnd',
                         'Section', '!insertmacro customInstall', 'SectionEnd']
            script = tmp / 'wrap.nsi'
            script.write_text('\n'.join(body) + '\n', encoding='utf-8-sig')
            r = subprocess.run([str(_makensis()), '/V2', '/WX', '/INPUTCHARSET', 'UTF8', str(script)],
                               capture_output=True, text=True, errors='replace', timeout=120)
            return r
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_installer_compiles_without_warnings(self):
        r = self._compile(uninstaller=False)
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-2000:])

    def test_uninstaller_compiles_without_warnings(self):
        r = self._compile(uninstaller=True)
        self.assertEqual(r.returncode, 0, r.stdout[-3000:] + r.stderr[-2000:])


@unittest.skipUnless(_makensis(), 'makensis (electron-builder NSIS cache) not available')
class InstallerInitRuntimeTests(unittest.TestCase):
    """Runs the REAL customInit/gtReadMode in a tiny compiled harness (no pages, no install, no
    elevation) with %ProgramData% pointed at a scratch folder, and records what the wizard decides.

    GtUpgrade == 0 means the mode / server-settings / company+administrator pages are shown
    (gtModePageCreate, gtServerPageCreate, gtAdminPageCreate abort only when GtUpgrade == 1).
    """

    @classmethod
    def setUpClass(cls):
        cls.tmp = Path(tempfile.mkdtemp(prefix='gtrade-nshrt-'))
        out = cls.tmp / 'result.txt'
        body = [
            'Unicode true', '!define VERSION "1.0.0"', f'OutFile "{cls.tmp / "harness.exe"}"',
            'RequestExecutionLevel user', 'SilentInstall silent', f'InstallDir "{cls.tmp / "instdir"}"',
            '!pragma warning disable 6001', '!pragma warning disable 6010',  # unused vars / page functions
            f'!include "{NSH}"',
            'Function .onInit', '!insertmacro customInit',
            f'  FileOpen $9 "{out}" w',
            '  FileWrite $9 "root=$GtDataRoot$\\r$\\nupgrade=$GtUpgrade$\\r$\\nmode=$GtMode$\\r$\\n"',
            '  FileClose $9', '  Quit', 'FunctionEnd',
            'Section', 'SectionEnd',
        ]
        script = cls.tmp / 'harness.nsi'
        script.write_text('\n'.join(body) + '\n', encoding='utf-8-sig')
        r = subprocess.run([str(_makensis()), '/V2', '/WX', '/INPUTCHARSET', 'UTF8', str(script)],
                           capture_output=True, text=True, errors='replace', timeout=120)
        if r.returncode != 0:
            raise AssertionError(r.stdout[-3000:])
        cls.out = out

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def _run(self, files: dict, args=()):
        pd = Path(tempfile.mkdtemp(prefix='pd-', dir=self.tmp))
        for rel, text in files.items():
            p = pd / 'G-TRADE' / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(text, encoding='utf-8')
        self.out.unlink(missing_ok=True)
        env = {**os.environ, 'ProgramData': str(pd)}
        subprocess.run([str(self.tmp / 'harness.exe'), *args], env=env, timeout=60, check=False)
        # NSIS FileWrite writes the ANSI code page even in a Unicode build.
        text = self.out.read_text(encoding='mbcs', errors='replace')
        kv = dict(line.split('=', 1) for line in text.splitlines() if '=' in line)
        return pd, kv

    def test_fresh_install_defaults_to_absolute_programdata_and_shows_setup_pages(self):
        pd, kv = self._run({})
        self.assertEqual(kv['root'], str(pd / 'G-TRADE'))
        self.assertTrue(Path(kv['root']).is_absolute())
        self.assertNotIn('$', kv['root'])
        self.assertEqual(kv['upgrade'], '0')
        self.assertEqual(kv['mode'], 'standalone')

    def test_rerun_after_partial_failure_shows_company_and_admin_pages_again(self):
        _pd, kv = self._run({'config/install.mode': 'standalone', 'config/install.version': '1.0.0'})
        self.assertEqual(kv['upgrade'], '0', 'partial install must go through the full wizard (company + admin)')

    def test_completed_install_is_an_upgrade(self):
        _pd, kv = self._run({'config/install.mode': 'standalone', 'config/install.version': '1.0.0',
                             'config/install.complete': '{}'})
        self.assertEqual(kv['upgrade'], '1')


class RequirementsProbeRuntimeTests(unittest.TestCase):
    """Runs the REAL gtProbeSystem (used by the wizard's up-front requirements check) in a compiled
    harness and compares what it measures with gtrade-ctl's own readings on this PC, so a wrong
    System::Call struct layout or unit conversion cannot silently block or pass an installation."""

    def test_probe_matches_gtrade_ctl_readings(self):
        import platform
        import sys

        from gtrade_ctl.pg import _total_ram
        tmp = Path(tempfile.mkdtemp(prefix='gtrade-nshreq-'))
        try:
            out = tmp / 'probe.txt'
            data_root = tmp / 'data'
            body = [
                'Unicode true', '!define VERSION "1.0.0"', f'OutFile "{tmp / "probe.exe"}"',
                'RequestExecutionLevel user', 'SilentInstall silent', f'InstallDir "{tmp / "instdir"}"',
                '!pragma warning disable 6001', '!pragma warning disable 6010',
                f'!include "{NSH}"',
                'Function .onInit', f'  StrCpy $GtDataRoot "{data_root}"', '  !insertmacro gtProbeSystem',
                f'  FileOpen $9 "{out}" w',
                '  FileWrite $9 "build=$R7$\\r$\\nram_mb=$R8$\\r$\\nfree_mb=$R9$\\r$\\n"',
                '  FileClose $9', '  Quit', 'FunctionEnd', 'Section', 'SectionEnd',
            ]
            script = tmp / 'probe.nsi'
            script.write_text('\n'.join(body) + '\n', encoding='utf-8-sig')
            r = subprocess.run([str(_makensis()), '/V2', '/WX', '/INPUTCHARSET', 'UTF8', str(script)],
                               capture_output=True, text=True, errors='replace', timeout=120)
            self.assertEqual(r.returncode, 0, r.stdout[-3000:])
            subprocess.run([str(tmp / 'probe.exe')], timeout=60, check=False)
            kv = dict(line.split('=', 1) for line in out.read_text(encoding='mbcs').splitlines() if '=' in line)

            self.assertEqual(int(kv['build']), sys.getwindowsversion().build)
            self.assertEqual(int(kv['ram_mb']), _total_ram() // (1024 * 1024))
            free_mb = shutil.disk_usage(Path(str(data_root)[:3])).free // (1024 * 1024)
            self.assertLess(abs(int(kv['free_mb']) - free_mb), 512, kv)  # disk usage moves while tests run
            self.assertTrue(platform.machine().endswith('64'))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)

    def test_thresholds_match_gtrade_ctl(self):
        from gtrade_ctl import installer_cmds as ic
        text = NSH.read_text(encoding='utf-8')
        block = text[text.index('!macro gtCheckRequirements'):]
        block = block[:block.index('!macroend')]
        self.assertIn(f'$R7 < {ic.MIN_BUILD}', block)
        self.assertIn(f'$R8 < {ic.MIN_RAM_BLOCK // 1024 ** 2}', block)
        self.assertIn(f'$R8 < {ic.MIN_RAM_WARN // 1024 ** 2}', block)
        self.assertIn(f'$R9 < {ic.MIN_DISK_SERVER // 1024 ** 2}', block)
        # The check runs when the server-settings page is left, i.e. before any file is copied.
        leave = text[text.index('Function gtServerPageLeave'):]
        self.assertIn('!insertmacro gtCheckRequirements', leave[:leave.index('FunctionEnd')])


class DataRootGuardTests(unittest.TestCase):
    BAD = ['$COMMONPROGRAMDATA\\G-TRADE', '%ProgramData%\\G-TRADE', 'G-TRADE', 'data\\G-TRADE', '${DATA}\\x']

    def test_bad_roots_refused(self):
        for bad in self.BAD:
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                check_root_path(Path(bad))

    def test_good_roots_accepted(self):
        for good in [r'C:\ProgramData\G-TRADE', r'D:\Shop Data\G-TRADE', r'\\server\D$\G-TRADE']:
            with self.subTest(good=good):
                check_root_path(Path(good))

    def test_program_files_still_refused(self):
        pf = os.environ.get('ProgramFiles', r'C:\Program Files')
        with self.assertRaises(ValueError):
            validate_data_root(Path(pf) / 'G-TRADE' / 'data', Path(r'C:\Somewhere\else'))

    def test_install_with_unexpanded_root_exits_2_and_writes_nothing(self):
        """Exactly the failed command line from the 2026-11-12 install, run from a scratch 'Program Files'."""
        cwd = Path(tempfile.mkdtemp(prefix='gtrade-cwd-'))
        old = os.getcwd()
        os.chdir(cwd)
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                code = cli.main(['--install-root', str(cwd / 'resources' / 'server'),
                                 '--data-root', '$COMMONPROGRAMDATA\\G-TRADE',
                                 'install', '--mode', 'standalone', '--version', '1.0.0', '--https-port', '8443',
                                 '--no-services', '--no-firewall', '--no-acl'])
        finally:
            os.chdir(old)
        try:
            self.assertEqual(code, cli.EXIT['config'])
            self.assertIn('unexpanded variable', json.loads(buf.getvalue())['error'])
            self.assertEqual(list(cwd.iterdir()), [], 'nothing may be created for a refused data root')
        finally:
            shutil.rmtree(cwd, ignore_errors=True)

    def test_install_inside_program_files_refused_before_any_write(self):
        pf = Path(tempfile.mkdtemp(prefix='gtrade-pf-'))
        inst = pf / 'resources' / 'server'
        data = inst / 'data'  # inside the program folder
        buf = io.StringIO()
        try:
            with contextlib.redirect_stdout(buf):
                code = cli.main(['--install-root', str(inst), '--data-root', str(data), 'install', '--mode',
                                 'standalone', '--version', '1.0.0', '--no-services', '--no-firewall', '--no-acl'])
            self.assertEqual(code, cli.EXIT['config'])
            self.assertFalse(data.exists(), 'no log/config may be written into a refused data root')
        finally:
            shutil.rmtree(pf, ignore_errors=True)

    def test_default_layout_is_absolute_programdata(self):
        lay = layout('C:\\Program Files\\X', None) if not os.environ.get('GTRADE_DATA_ROOT') else None
        if lay:
            self.assertTrue(lay.data_root.is_absolute())
            self.assertEqual(lay.data_root.name, 'G-TRADE')


if __name__ == '__main__':
    unittest.main()
