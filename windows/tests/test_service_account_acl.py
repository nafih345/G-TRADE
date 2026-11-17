"""Least-privilege service accounts: the data-folder ACLs, applied with the REAL icacls to a scratch
data root and read back as SDDL (by SID, so it does not matter whether the services exist here).

What each service may touch (winacl.apply_data_root_policy):
  App  NT SERVICE\\GTrade-App : read config (secrets) + root; modify media/logs/backups/run/temp; read static
  Web  NT SERVICE\\GTrade-Web : read nginx.conf, mime.types, server.crt/.key, ca.crt, static; modify its log/run/temp
  DB   NT SERVICE\\GTrade-DB  : full pgsql; modify logs\\db
Nobody but SYSTEM/Administrators: the CA private key, updates\\. Nothing for Everyone. Users: client\\ only.

Effective enforcement under the real service tokens is exercised by tests/elevated_service_selftest.py
(needs Administrator); this file proves the policy itself.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from gtrade_ctl import services, winacl
from gtrade_ctl.paths import layout

APP = services.service_sid('GTrade-App')
WEB = services.service_sid('GTrade-Web')
DB = services.service_sid('GTrade-DB')
NS, USERS, EVERYONE = 'NS', 'BU', 'WD'
READ_MASKS = {'FR', '0x1200a9', 'FRFX', '0x120089'}       # R / RX
MODIFY_MASKS = {'0x1301bf'}                               # M
FULL_MASKS = {'FA', '0x1f01ff'}


def sddl_aces(path: Path) -> list[tuple[str, str, str]]:
    """[(flags, mask, sid)] of every ALLOW ACE on ``path`` (explicit and inherited)."""
    out = Path(tempfile.mkdtemp()) / 'acl.txt'
    try:
        subprocess.run(['icacls', str(path), '/save', str(out)], check=True, capture_output=True)
        text = out.read_bytes().decode('utf-16')
    finally:
        shutil.rmtree(out.parent, ignore_errors=True)
    sddl = text.splitlines()[1]
    aces = []
    for part in sddl.split('(')[1:]:
        f = part.rstrip(')').split(')')[0].split(';')
        if f[0] == 'A':
            aces.append((f[1], f[2], f[5]))
    return aces


def masks_for(path: Path, sid: str) -> set:
    return {m for _f, m, s in sddl_aces(path) if s == sid}


@unittest.skipUnless(sys.platform == 'win32', 'Windows ACLs')
class ServiceAccountPolicy(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop('GTRADE_SKIP_ACL', None)
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-acl-'))
        self.lay = layout(self.tmp / 'install', self.tmp / 'data')
        self.lay.ensure_data_tree()
        (self.lay.data_root / 'client').mkdir()
        (self.lay.data_root / 'rollback' / 'app-1.0.0').mkdir(parents=True)
        self.lay.install_root.mkdir(parents=True)
        for f in ('install.json', 'gtrade.env', 'secrets.dpapi', 'nginx.conf', 'mime.types',
                  'tls/ca.key', 'tls/ca.crt', 'tls/server.key', 'tls/server.crt'):
            (self.lay.config_dir / f).write_text('x')
        self.lay.pg_data.mkdir(parents=True)
        (self.lay.pg_data / 'PG_VERSION').write_text('17')
        (self.lay.media_dir / 'logo.png').write_text('x')
        (self.lay.static_dir / 'app.js').write_text('x')
        (self.lay.backups_dir / 'db' / 'b.dump').write_text('x')

    def tearDown(self):
        subprocess.run(['icacls', str(self.tmp), '/reset', '/T', '/C', '/Q'], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._saved

    def legacy_policy(self):
        """What installs before 2026-11-13 left: NETWORK SERVICE read/modify across the data root."""
        admin = [winacl.SYSTEM, winacl.ADMINISTRATORS]
        managed = [self.lay.data_root / s for s in winacl.MANAGED_SUBDIRS]
        winacl.protect(self.lay.data_root, admin, read=[winacl.NETWORK_SERVICE], include_current_user=True, exclude=managed)
        winacl.protect(self.lay.config_dir, admin, read=[winacl.NETWORK_SERVICE], include_current_user=True)
        winacl.protect(self.lay.pg_data.parent, admin + [winacl.NETWORK_SERVICE], include_current_user=True)
        for sub in ('media', 'static', 'logs', 'backups', 'run', 'updates', 'temp'):
            winacl.protect(self.lay.data_root / sub, admin, modify=[winacl.NETWORK_SERVICE], include_current_user=True)

    def apply(self, keep_ns=False):
        winacl.apply_data_root_policy(self.lay, include_current_user=True, keep_network_service=keep_ns)

    def test_secrets_readable_by_app_only(self):
        self.apply()
        for f in ('secrets.dpapi', 'gtrade.env', 'install.json'):
            p = self.lay.config_dir / f
            self.assertTrue(masks_for(p, APP) & READ_MASKS, f)
            self.assertFalse(masks_for(p, APP) & (MODIFY_MASKS | FULL_MASKS), f'App must not write {f}')
            for other in (WEB, DB, NS, USERS, EVERYONE):
                self.assertFalse(masks_for(p, other), f'{other} must not access {f}')

    def test_ca_private_key_has_no_service_access(self):
        self.apply()
        for sid in (APP, WEB, DB, NS, USERS, EVERYONE):
            self.assertFalse(masks_for(self.lay.tls_dir / 'ca.key', sid), sid)

    def test_web_reads_exactly_its_files(self):
        self.apply()
        for f in winacl.web_read_files(self.lay):
            self.assertTrue(masks_for(f, WEB) & READ_MASKS, f.name)
            self.assertFalse(masks_for(f, WEB) & (MODIFY_MASKS | FULL_MASKS), f.name)
        for f in ('secrets.dpapi', 'gtrade.env', 'install.json'):
            self.assertFalse(masks_for(self.lay.config_dir / f, WEB), f)
        self.assertFalse(masks_for(self.lay.tls_dir / 'server.key', APP), 'App does not need the TLS key')
        for d in (self.lay.logs_dir / 'web', self.lay.run_dir / 'nginx', self.lay.temp_dir / 'nginx'):
            self.assertTrue(masks_for(d, WEB) & MODIFY_MASKS, d)
        self.assertFalse(masks_for(self.lay.media_dir / 'logo.png', WEB))
        self.assertFalse(masks_for(self.lay.backups_dir / 'db' / 'b.dump', WEB))

    def test_database_folder_only_for_db(self):
        self.apply()
        self.assertTrue(masks_for(self.lay.pg_data / 'PG_VERSION', DB) & FULL_MASKS)
        self.assertTrue(masks_for(self.lay.logs_dir / 'db', DB) & MODIFY_MASKS)
        for sid in (APP, WEB, NS, USERS, EVERYONE):
            self.assertFalse(masks_for(self.lay.pg_data / 'PG_VERSION', sid), sid)

    def test_app_write_areas(self):
        self.apply()
        for p in (self.lay.media_dir / 'logo.png', self.lay.backups_dir / 'db' / 'b.dump', self.lay.logs_dir / 'app',
                  self.lay.run_dir, self.lay.temp_dir):
            self.assertTrue(masks_for(p, APP) & MODIFY_MASKS, p)
        self.assertTrue(masks_for(self.lay.static_dir / 'app.js', APP) & READ_MASKS)
        self.assertFalse(masks_for(self.lay.static_dir / 'app.js', APP) & MODIFY_MASKS)
        self.assertFalse(masks_for(self.lay.updates_dir, APP))
        # rollback copy of the previous version must be runnable by App and servable by Web
        self.assertTrue(masks_for(self.lay.data_root / 'rollback' / 'app-1.0.0', APP) & READ_MASKS)
        self.assertTrue(masks_for(self.lay.data_root / 'rollback' / 'app-1.0.0', WEB) & READ_MASKS)

    def test_program_files_read_only_for_services(self):
        self.apply()
        for sid in (APP, WEB, DB):
            m = masks_for(self.lay.install_root, sid)
            self.assertTrue(m & READ_MASKS, sid)
            self.assertFalse(m & (MODIFY_MASKS | FULL_MASKS), sid)

    def test_no_everyone_and_users_only_on_client(self):
        self.apply()
        for p in [self.lay.data_root, *[self.lay.data_root / s for s in winacl.MANAGED_SUBDIRS if s != 'client']]:
            self.assertFalse(masks_for(p, EVERYONE), p)
            self.assertFalse(masks_for(p, USERS), p)
        self.assertTrue(masks_for(self.lay.data_root / 'client', USERS) & READ_MASKS)

    def test_upgrade_from_legacy_removes_network_service_except_database_until_verified(self):
        self.legacy_policy()
        self.assertTrue(masks_for(self.lay.media_dir, NS))
        self.apply(keep_ns=True)  # database still runs (or may roll back) as NETWORK SERVICE
        self.assertTrue(masks_for(self.lay.pg_data / 'PG_VERSION', NS) & FULL_MASKS)
        self.assertTrue(masks_for(self.lay.logs_dir / 'db', NS) & MODIFY_MASKS, 'old DB account must still log')
        for p in (self.lay.config_dir / 'secrets.dpapi', self.lay.media_dir, self.lay.backups_dir, self.lay.data_root,
                  self.lay.logs_dir / 'app'):
            self.assertFalse(masks_for(p, NS), p)
        # every service verified on its own account: drop_legacy_grants takes NS off the database too
        with mock.patch.object(services, 'current_account', lambda sid: services.HARDENED_ACCOUNTS[sid]):
            winacl.drop_legacy_grants(self.lay)
        self.assertFalse(masks_for(self.lay.pg_data / 'PG_VERSION', NS))
        self.assertFalse(masks_for(self.lay.logs_dir / 'db', NS))
        self.assertTrue(masks_for(self.lay.pg_data / 'PG_VERSION', DB) & FULL_MASKS)

    def test_drop_legacy_refused_while_any_service_still_uses_network_service(self):
        self.apply(keep_ns=True)
        legacy = dict(services.HARDENED_ACCOUNTS, **{services.DB: services.NETWORK_SERVICE})
        with mock.patch.object(services, 'current_account', lambda sid: legacy[sid]):
            self.assertEqual(winacl.drop_legacy_grants(self.lay), [])
        self.assertTrue(masks_for(self.lay.pg_data / 'PG_VERSION', NS))

    def test_reapplying_is_idempotent_and_never_removes_operator_access(self):
        self.apply()
        first = {p: sorted(sddl_aces(p)) for p in (self.lay.config_dir / 'nginx.conf', self.lay.pg_data, self.lay.logs_dir / 'db')}
        self.apply()
        for p, aces in first.items():
            self.assertEqual(sorted(sddl_aces(p)), aces, p)
        self.assertTrue((self.lay.config_dir / 'install.json').read_text() == 'x')


if __name__ == '__main__':
    unittest.main()
