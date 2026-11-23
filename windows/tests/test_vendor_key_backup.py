"""GTKB1 vendor-key backup (gtrade_ctl/vendor_key.py + `gtrade-ctl vendor-key`): scrypt + AES-256-GCM,
authenticated header, verify without writing, restore that never overwrites, and no passphrase or
private key in any file, output or command line.

Only THROWAWAY keys in temporary folders (deleted afterwards); the production key is never touched.
The CLI tests run the real `gtrade-ctl` process through the same launcher provision_vendor_key.ps1
uses (the installed G-TRADE runtime when present, else this interpreter), with the passphrase piped on
stdin exactly like a hidden prompt would deliver it.
"""

import base64
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

WIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WIN))
from gtrade_ctl import vendor_key as vk, winacl  # noqa: E402

PASS = 'tidal-orbit-candle-meadow-42'
OTHER_PASS = 'wrong-passphrase-entirely-77'
INSTALLED_RUNTIME = Path(r'C:\Program Files\G-TRADE\resources\server\runtime\python\python.exe')
BOOT = ("import os,runpy,sys;sys.path.insert(0,os.environ['GTRADE_REPO_WINDOWS']);"
        "sys.argv=['gtrade-ctl']+sys.argv[1:];runpy.run_module('gtrade_ctl',run_name='__main__')")


def principals():
    sid = winacl.current_user_sid() if sys.platform == 'win32' else None
    return [sid] if sid else ['*S-1-5-18']


def seed_forms(key):
    raw = base64.b64decode(vk._seed(key))
    return [raw, raw.hex().encode(), base64.b64encode(raw), base64.urlsafe_b64encode(raw).rstrip(b'=')]


class BackupFormatTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtkb-test-'))
        self.key_file = self.tmp / 'a' / vk.FILE_NAME
        self.info = vk.generate(self.key_file, 'gtl-test-backup', principals())
        self.key_id, self.key = vk.load(self.key_file)
        self.data = vk.export_encrypted(self.key_file, PASS)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_round_trip_restores_the_same_key(self):
        key_id, key, header = vk.decrypt_backup(self.data, PASS)
        self.assertEqual((key_id, vk.public_b64(key)), (self.key_id, self.info['public_key']))
        self.assertEqual(header['kdf']['name'], 'scrypt')
        self.assertEqual({k: header['kdf'][k] for k in ('n', 'r', 'p')}, {'n': 131072, 'r': 8, 'p': 1})
        self.assertEqual(header['cipher']['name'], 'AES-256-GCM')
        self.assertEqual(len(base64.b64decode(header['kdf']['salt'])), 16)
        self.assertEqual(len(base64.b64decode(header['cipher']['nonce'])), 12)
        v = vk.verify_backup(self.data, PASS, self.key_file)
        self.assertEqual((v['decrypts'], v['matches_backup_header'], v['matches_installed_key']), (True, True, True))
        # Two exports never share salt / nonce.
        again = json.loads(vk.export_encrypted(self.key_file, PASS))
        first = json.loads(self.data)
        self.assertNotEqual(first['kdf']['salt'], again['kdf']['salt'])
        self.assertNotEqual(first['cipher']['nonce'], again['cipher']['nonce'])

    def test_file_holds_no_passphrase_and_no_private_key(self):
        self.assertNotIn(PASS.encode(), self.data)
        for form in seed_forms(self.key):
            self.assertNotIn(form, self.data)
        self.assertNotIn(b'PRIVATE', self.data)
        self.assertEqual(set(json.loads(self.data)), {'format', 'key_id', 'public_key', 'created_at', 'kdf', 'cipher',
                                                     'ciphertext'})
        self.assertNotIn(PASS, json.dumps(vk.verify_backup(self.data, PASS, self.key_file)))

    def test_wrong_passphrase_is_refused(self):
        for bad in (OTHER_PASS, PASS[:-1], PASS.upper(), ''):
            with self.assertRaises(vk.VendorKeyError) as cm:
                vk.decrypt_backup(self.data, bad)
            self.assertIn('Wrong passphrase', str(cm.exception))
            self.assertNotIn(bad or '\x00', str(cm.exception))

    def test_any_tampering_is_detected(self):
        doc = json.loads(self.data)
        other_pub = vk.public_b64(__import__('cryptography.hazmat.primitives.asymmetric.ed25519', fromlist=['x'])
                                  .Ed25519PrivateKey.generate())
        ct = bytearray(base64.b64decode(doc['ciphertext']))
        ct[5] ^= 1
        nonce = bytearray(base64.b64decode(doc['cipher']['nonce']))
        nonce[0] ^= 1
        cases = {
            'key id': {**doc, 'key_id': 'gtl-test-other'},
            'public key': {**doc, 'public_key': other_pub},
            'created_at': {**doc, 'created_at': '2020-01-01T00:00:00+00:00'},
            'ciphertext': {**doc, 'ciphertext': base64.b64encode(bytes(ct)).decode()},
            'nonce': {**doc, 'cipher': {**doc['cipher'], 'nonce': base64.b64encode(bytes(nonce)).decode()}},
            'scrypt downgrade': {**doc, 'kdf': {**doc['kdf'], 'n': 1024}},
            'other cipher': {**doc, 'cipher': {**doc['cipher'], 'name': 'AES-128-GCM'}},
            'extra field': {**doc, 'note': 'x'},
            'format': {**doc, 'format': 'GTKB0'},
        }
        for name, bad in cases.items():
            with self.subTest(name), self.assertRaises(vk.VendorKeyError):
                vk.decrypt_backup(json.dumps(bad).encode(), PASS)
        for junk in (b'', b'not json', b'{}', self.data[:-20]):
            with self.assertRaises(vk.VendorKeyError):
                vk.decrypt_backup(junk, PASS)

    def test_backup_of_a_different_key_does_not_match(self):
        other_file = self.tmp / 'b' / vk.FILE_NAME
        vk.generate(other_file, 'gtl-test-backup', principals())
        v = vk.verify_backup(self.data, PASS, other_file)
        self.assertTrue(v['decrypts'])
        self.assertFalse(v['matches_installed_key'])
        self.assertIsNone(vk.verify_backup(self.data, PASS, self.tmp / 'none' / vk.FILE_NAME)['matches_installed_key'])

    def test_restore_never_overwrites_and_restores_into_an_empty_installation(self):
        with self.assertRaises(vk.VendorKeyError):
            vk.import_encrypted(self.key_file, self.data, PASS, principals())
        with self.assertRaises(vk.VendorKeyError):
            vk.generate(self.key_file, 'gtl-test-backup', principals())
        self.assertEqual(vk.load(self.key_file)[0], self.key_id)  # untouched
        fresh = self.tmp / 'restored' / vk.FILE_NAME
        with self.assertRaises(vk.VendorKeyError):
            vk.import_encrypted(fresh, self.data, OTHER_PASS, principals())
        self.assertFalse(fresh.exists())                           # nothing written on a wrong passphrase
        info = vk.import_encrypted(fresh, self.data, PASS, principals())
        self.assertEqual(info, {'key_id': self.key_id, 'public_key': self.info['public_key']})
        self.assertNotIn(b'PRIVATE', fresh.read_bytes())

    def test_short_passphrase_refused(self):
        with self.assertRaises(vk.VendorKeyError):
            vk.export_encrypted(self.key_file, 'short pass 12')


class BackupCommandTests(unittest.TestCase):
    """The real `gtrade-ctl vendor-key` process on a throwaway data folder."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtkb-cli-'))
        self.python = str(INSTALLED_RUNTIME if INSTALLED_RUNTIME.exists() else Path(sys.executable))
        self.install_root = self.tmp / 'install'
        self.install_root.mkdir()
        self.roots = []

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def data_root(self, name):
        root = self.tmp / name
        (root / 'config').mkdir(parents=True)
        (root / 'config' / 'install.json').write_text('{}')
        (root / 'config' / 'gtrade.env').write_text('GTRADE_INSTALL_ID=11111111-2222-4333-8444-555566667777\n')
        self.roots.append(root)
        return root

    def ctl(self, root, *args, stdin=''):
        env = {k: v for k, v in os.environ.items() if not k.startswith(('GTRADE_', 'PYTHON'))}
        env.update(GTRADE_REPO_WINDOWS=str(WIN), GTRADE_SKIP_ACL='1', PYTHONUTF8='1')
        cmd = [self.python, '-c', BOOT, '--install-root', str(self.install_root), '--data-root', str(root),
               'vendor-key', *args]
        for a in cmd:  # the passphrase is never an argument
            self.assertNotIn(PASS, a)
        proc = subprocess.run(cmd, input=stdin, capture_output=True, text=True, env=env, timeout=300,
                              encoding='utf-8', errors='replace')
        self.outputs = getattr(self, 'outputs', '') + proc.stdout + proc.stderr
        try:
            data = json.loads(proc.stdout)
        except ValueError:
            data = {'raw': proc.stdout, 'stderr': proc.stderr[-1500:]}
        return proc.returncode, data

    def test_generate_export_verify_import_and_nothing_leaks(self):
        a = self.data_root('pc-a')
        code, gen = self.ctl(a, 'generate', '--key-id', 'gtl-test-cli')
        self.assertEqual(code, 0, gen)
        key_file = a / 'config' / 'license' / vk.FILE_NAME
        key_id, key = vk.load(key_file)
        backup = self.tmp / 'drive-upload' / 'gtl-test-cli.gtkb'

        code, r = self.ctl(a, 'export', '--out', str(backup), stdin=f'{PASS}\n{PASS}x\n')
        self.assertNotEqual(code, 0, 'two different passphrases')
        self.assertFalse(backup.exists())
        code, r = self.ctl(a, 'export', '--out', str(backup), stdin='too short\ntoo short\n')
        self.assertNotEqual(code, 0)
        self.assertFalse(backup.exists())
        code, r = self.ctl(a, 'export', '--out', str(backup), stdin=f'{PASS}\n{PASS}\n')
        self.assertEqual(code, 0, r)
        self.assertTrue(r['verified'])
        self.assertEqual((r['key_id'], r['public_key']), (key_id, gen['public_key']))
        before = backup.read_bytes()
        code, r = self.ctl(a, 'export', '--out', str(backup), stdin=f'{PASS}\n{PASS}\n')
        self.assertNotEqual(code, 0, 'an existing backup file is never overwritten')
        self.assertEqual(backup.read_bytes(), before)

        # "Downloaded from Google Drive" copy, verified against the installed key.
        downloaded = self.tmp / 'downloads' / 'gtl-test-cli.gtkb'
        downloaded.parent.mkdir()
        shutil.copyfile(backup, downloaded)
        code, v = self.ctl(a, 'verify-backup', '--file', str(downloaded), stdin=f'{PASS}\n')
        self.assertEqual(code, 0, v)
        self.assertTrue(v['matches_installed_key'])
        self.assertTrue(v['verdict'].startswith('OK'))
        code, v = self.ctl(a, 'verify-backup', '--file', str(downloaded), stdin=f'{OTHER_PASS}\n')
        self.assertNotEqual(code, 0)
        self.assertIn('Wrong passphrase', json.dumps(v))

        # A different installation's key: verify says MISMATCH.
        b = self.data_root('pc-b')
        self.assertEqual(self.ctl(b, 'generate', '--key-id', 'gtl-test-cli')[0], 0)
        code, v = self.ctl(b, 'verify-backup', '--file', str(downloaded), stdin=f'{PASS}\n')
        self.assertNotEqual(code, 0)
        self.assertFalse(v['matches_installed_key'])
        self.assertTrue(v['verdict'].startswith('MISMATCH'))
        # ... and import there is refused before any passphrase is read (never overwrites).
        b_key = (b / 'config' / 'license' / vk.FILE_NAME).read_bytes()
        code, v = self.ctl(b, 'import', '--file', str(downloaded), stdin=f'{PASS}\n')
        self.assertNotEqual(code, 0)
        self.assertIn('never overwritten', v['error'])
        self.assertEqual((b / 'config' / 'license' / vk.FILE_NAME).read_bytes(), b_key)

        # Disaster recovery onto a new PC with no key: restored key == original public key.
        c = self.data_root('pc-new')
        code, v = self.ctl(c, 'import', '--file', str(downloaded), stdin=f'{OTHER_PASS}\n')
        self.assertNotEqual(code, 0)
        self.assertFalse((c / 'config' / 'license' / vk.FILE_NAME).exists())
        code, v = self.ctl(c, 'import', '--file', str(downloaded), stdin=f'{PASS}\n')
        self.assertEqual(code, 0, v)
        self.assertEqual((v['key_id'], v['public_key']), (key_id, gen['public_key']))
        code, st = self.ctl(c, 'status')
        self.assertEqual((code, st['public_key']), (0, gen['public_key']))

        # Nothing anywhere contains the passphrase or the private key: every output and every file.
        secrets = [PASS.encode(), OTHER_PASS.encode(), *seed_forms(key)]
        self.assertNotIn(PASS, self.outputs)
        self.assertNotIn(OTHER_PASS, self.outputs)
        for form in seed_forms(key):
            self.assertNotIn(form.decode('latin-1'), self.outputs)
        self.assertNotIn('PRIVATE KEY', self.outputs)
        for root in [*self.roots, backup.parent, downloaded.parent]:
            for f in root.rglob('*'):
                if f.is_file():
                    raw = f.read_bytes()
                    for s in secrets:
                        self.assertNotIn(s, raw, f'{f} contains secret material')


if __name__ == '__main__':
    unittest.main()
