"""Release guard: developer / cloud secrets never ship in the Windows payload."""

import fnmatch
import os
import shutil
import sys
import tempfile
import unittest
from pathlib import Path

from tests.helpers import REPO

sys.path.insert(0, str(REPO / 'windows' / 'tooling'))
import build_runtime  # noqa: E402
import payload_guard  # noqa: E402

FAKE_PASS = 'Zq9-fake-neon-pass-7781'


class PayloadGuardTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-guard-'))
        self.repo = self.tmp / 'repo'
        (self.repo / 'backend').mkdir(parents=True)
        (self.repo / 'backend' / '.env').write_text(
            'DB_HOST=localhost\nDB_PORT=5432\nDEBUG=True\n'
            f'DATABASE_URL=postgresql://neondb_owner:{FAKE_PASS}@ep-x-pooler.c-6.us-east-2.aws.neon.tech/neondb\n'
            'SECRET_KEY=django-dev-secret-key-abcdefgh\n', encoding='utf-8')
        (self.repo / 'frontend').mkdir()
        (self.repo / 'frontend' / '.env').write_text('VITE_API_URL=http://localhost:8000\n', encoding='utf-8')
        self.payload = self.tmp / 'payload'
        (self.payload / 'app' / 'backend').mkdir(parents=True)
        (self.payload / 'app' / 'backend' / 'settings.py').write_text('DEBUG = False\n', encoding='utf-8')

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_clean_payload_passes(self):
        rep = payload_guard.check(self.payload, self.repo)
        self.assertTrue(rep['ok'], rep)
        self.assertGreaterEqual(rep['values_checked'], 2)

    def test_env_file_is_forbidden_anywhere(self):
        for rel in ('app/backend/.env', 'app/backend/.env.example', 'app/frontend/.env.production', 'x/prod.env'):
            p = self.payload / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text('A=1\n')
            rep = payload_guard.check(self.payload, self.repo)
            self.assertIn(rel, rep['forbidden_files'])
            p.unlink()

    def test_secret_value_found_inside_any_file_without_printing_it(self):
        (self.payload / 'app' / 'bundle.js').write_bytes(b'var u="' + FAKE_PASS.encode() + b'";')
        rep = payload_guard.check(self.payload, self.repo)
        self.assertFalse(rep['ok'])
        self.assertTrue(any('bundle.js' in h and 'DATABASE_URL' in h for h in rep['leaked_values']))
        self.assertNotIn(FAKE_PASS, repr(rep))
        with self.assertRaises(SystemExit) as cm:
            payload_guard.enforce(self.payload, self.repo)
        self.assertNotIn(FAKE_PASS, str(cm.exception))

    def test_localhost_urls_and_flags_are_not_secrets(self):
        labels = [label for label, _ in payload_guard.secret_needles(self.repo)]
        self.assertFalse(any('VITE_API_URL' in label for label in labels))
        self.assertFalse(any('DEBUG' in label or 'DB_PORT' in label for label in labels))

    def test_keys_forbidden_but_runtime_ca_bundles_allowed(self):
        (self.payload / 'app' / 'server.key').write_text('k')
        ca = self.payload / 'runtime' / 'python' / 'Lib' / 'site-packages' / 'certifi' / 'cacert.pem'
        ca.parent.mkdir(parents=True)
        ca.write_text('-----BEGIN CERTIFICATE-----')
        rep = payload_guard.check(self.payload, self.repo)
        self.assertEqual(rep['forbidden_files'], ['app/server.key'])

    def test_build_excludes_env_files_and_cloud_scripts(self):
        excl = build_runtime.BACKEND_EXCLUDE_FILES
        for name in ('.env', '.env.example', '.env.production', 'copy_database.py', 'p1_neon_rehearsal.py'):
            self.assertTrue(any(fnmatch.fnmatch(name, g) for g in excl), name)
        for name in ('settings.py', 'settings_local.py', 'manage.py'):
            self.assertFalse(any(fnmatch.fnmatch(name, g) for g in excl), name)


@unittest.skipUnless((REPO / 'windows' / 'out' / 'stage' / 'app').is_dir(), 'no staged payload')
class StagedPayloadTests(unittest.TestCase):
    def test_staged_payload_has_no_secrets(self):
        rep = payload_guard.check(REPO / 'windows' / 'out' / 'stage')
        self.assertTrue(rep['ok'], {k: rep[k] for k in ('forbidden_files', 'leaked_values')})


if __name__ == '__main__':
    unittest.main()
