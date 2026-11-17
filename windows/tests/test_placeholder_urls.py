"""Regression: no documentation placeholder domains in anything the Windows edition ships or runs.

Background (2026-11-12): the desktop smoke test navigated to https://example.com/ to prove that
in-app navigation is blocked. The navigation guard correctly blocked it but handed the https URL to
the OS browser, so every automated run opened "This domain is for use in documentation examples"
in the owner's real browser. Placeholder domains must never appear in shipped code, and browser
launches from automation must be suppressed (see desktop/test/desktop.test.js).
"""

import re
import unittest
from pathlib import Path

WIN = Path(__file__).resolve().parents[1]
PLACEHOLDER = re.compile(rb'\bexample\.(com|org|net)\b', re.I)
# Everything that ships in, or is executed by, the installer and services.
SHIPPED = [
    WIN / 'desktop' / 'main.js', WIN / 'desktop' / 'preload.js', WIN / 'desktop' / 'lib', WIN / 'desktop' / 'pages',
    WIN / 'installer', WIN / 'gtrade_ctl', WIN / 'gtrade_server', WIN / 'templates',
]


def _files():
    for p in SHIPPED:
        if p.is_file():
            yield p
        elif p.is_dir():
            yield from (f for f in p.rglob('*') if f.is_file() and '__pycache__' not in f.parts)


class PlaceholderUrlTests(unittest.TestCase):
    def test_no_placeholder_domains_in_shipped_windows_code(self):
        hits = [str(f.relative_to(WIN)) for f in _files() if PLACEHOLDER.search(f.read_bytes())]
        self.assertEqual(hits, [], f'placeholder domain found in shipped files: {hits}')

    def test_installer_never_launches_a_browser_url(self):
        nsh = (WIN / 'installer' / 'installer.nsh').read_text(encoding='utf-8')
        for line in nsh.splitlines():
            if 'ExecShell' in line and not line.strip().startswith(';'):
                # The only allowed ExecShell opens the local connection sheet (LAN Server mode).
                self.assertIn('connection-sheet.txt', line)
                self.assertNotRegex(line, r'https?://')

    def test_installer_does_not_auto_run_the_app(self):
        import json
        pkg = json.loads((WIN / 'desktop' / 'package.json').read_text(encoding='utf-8'))
        self.assertFalse(pkg['build']['nsis'].get('runAfterFinish', True))


if __name__ == '__main__':
    unittest.main()
