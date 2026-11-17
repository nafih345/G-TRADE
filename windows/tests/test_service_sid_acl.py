"""Service SIDs of services that are NOT registered (yet) - the 2026-11-13 elevated self-test failure.

    icacls ...\\install /grant *S-1-5-80-...:(OI)(CI)RX
    -> "No mapping between account names and security IDs was done" (1332), nothing changed

Root cause: icacls translates every SID it is given to an account name; the LSA can name a virtual
service account (NT SERVICE\\<id>) only while a service <id> is registered. The data-root policy is
applied BEFORE the services exist (fresh install: prepare-data runs before the services step; the
self-test: before its disposable services are registered), so it failed for every unregistered
service SID. The previous ACL tests used the real GTrade-* names - registered on the dev PC - so they
could not see it. These tests use random, never-registered names, the REAL icacls / sc.exe and the
real Win32 security API, in a scratch folder under %TEMP% (no services are created or touched).
"""

import os
import secrets
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from gtrade_ctl import services, winacl
from gtrade_ctl.paths import layout

F, M, RX, R = 0x1F01FF, 0x1301BF, 0x1200A9, 0x120089
OI_CI, INHERITED = 0x3, 0x10
EVERYONE = 'S-1-1-0'
USERS = 'S-1-5-32-545'


def unregistered(role: str) -> str:
    """A service name that is guaranteed not to be registered on this PC."""
    for _ in range(5):
        name = f'GTradeST-{role}-{secrets.token_hex(4)}'
        if services.query_config(name) is None:
            return name
    raise AssertionError('could not find an unregistered service name')


def allow(path: Path) -> dict:
    """{SID: [(flags, mask)]} of the ALLOW ACEs on ``path``."""
    out = {}
    for typ, flags, mask, sid in winacl.read_dacl(path)['aces']:
        if typ == 0:
            out.setdefault(sid, []).append((flags, mask))
    return out


def explicit(path: Path, sid: str) -> set:
    return {mask for flags, mask in allow(path).get(sid, []) if not flags & INHERITED}


def effective_masks(path: Path, sid: str) -> set:
    return {mask for _f, mask in allow(path).get(sid, [])}


@unittest.skipUnless(sys.platform == 'win32', 'Windows ACLs')
class ServiceSidResolution(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop('GTRADE_SKIP_ACL', None)  # other test modules set it
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-sid-'))

    def tearDown(self):
        subprocess.run(['icacls', str(self.tmp), '/reset', '/T', '/C', '/Q'], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._saved

    def test_service_sid_matches_windows_for_registered_and_unregistered_names(self):
        for name in ('TrustedInstaller', unregistered('App'), 'GTrade-DB', 'GTrade-App', 'GTrade-Web'):
            shown = subprocess.run(['sc.exe', 'showsid', name], capture_output=True, text=True).stdout
            self.assertIn(services.service_sid(name), shown, name)
        # Windows' well-known value (independent of this code).
        self.assertEqual(services.service_sid('TrustedInstaller'),
                         'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464')

    def test_defect_reproduction_icacls_cannot_grant_an_unregistered_service_sid(self):
        sid = services.service_sid(unregistered('App'))
        p = subprocess.run(['icacls', str(self.tmp), '/grant', f'*{sid}:(OI)(CI)RX', '/C', '/Q'],
                           capture_output=True, text=True, errors='replace')
        self.assertEqual(p.returncode, 1332, p.stdout + p.stderr)  # ERROR_NONE_MAPPED
        self.assertNotIn(sid, allow(self.tmp))

    def test_grant_writes_unregistered_service_sid_by_sid(self):
        sid = services.service_sid(unregistered('Web'))
        f = self.tmp / 'server.crt'
        f.write_text('x')
        winacl._grant(self.tmp, ['*' + sid], 'M')
        winacl._grant(f, ['*' + sid], 'R', inherit=False)
        self.assertEqual(allow(self.tmp)[sid], [(OI_CI, M)])
        self.assertIn((0, R), allow(f)[sid])               # explicit, file-only
        self.assertIn((INHERITED, M), allow(f)[sid])       # and inherited from the folder (propagated)
        # icacls itself can still read the ACL (shows the bare SID) - nothing is left in a bad state.
        shown = subprocess.run(['icacls', str(self.tmp)], capture_output=True, text=True).stdout
        self.assertIn(sid, shown)

    def test_grant_is_additive_and_idempotent(self):
        sid = services.service_sid(unregistered('App'))
        for d in (self.tmp / 'inheriting', self.tmp / 'protected'):
            d.mkdir()
            subprocess.run(['icacls', str(d), '/inheritance:e' if d.name == 'inheriting' else '/inheritance:d'],
                           check=True, capture_output=True)
            before = winacl.read_dacl(d)
            winacl._grant(d, ['*' + sid], 'RX')
            winacl._grant(d, ['*' + sid], 'RX')
            after = winacl.read_dacl(d)
            self.assertEqual(allow(d)[sid], [(OI_CI, RX)])
            self.assertEqual([a for a in after['aces'] if a[3] != sid], before['aces'], d)  # nothing else changed
            self.assertEqual(after['protected'], before['protected'], d)  # protection state kept
        self.assertFalse(winacl.read_dacl(self.tmp / 'inheriting')['protected'])
        self.assertTrue(winacl.read_dacl(self.tmp / 'protected')['protected'])

    def test_protect_with_unregistered_sids_matches_icacls_semantics(self):
        db = services.service_sid(unregistered('DB'))
        other = services.service_sid(unregistered('Web'))
        d = self.tmp / 'pgsql'
        (d / 'data').mkdir(parents=True)
        (d / 'data' / 'PG_VERSION').write_text('17')
        winacl._grant(d, ['*' + other], 'RX')  # an existing explicit entry of someone else: kept
        winacl.protect(d, [winacl.SYSTEM, winacl.ADMINISTRATORS, '*' + db], include_current_user=True)
        acl = winacl.read_dacl(d)
        self.assertTrue(acl['protected'])
        self.assertFalse([a for a in acl['aces'] if a[1] & INHERITED], 'inherited entries must be gone')
        self.assertEqual(explicit(d, db), {F})
        self.assertEqual(explicit(d, other), {RX})
        me = winacl.current_user_sid()[1:]
        self.assertEqual(explicit(d, me), {F})
        # contents inherit (no empty DACLs) and stay readable for this user
        self.assertIn(F, effective_masks(d / 'data' / 'PG_VERSION', db))
        self.assertEqual((d / 'data' / 'PG_VERSION').read_text(), '17')
        # re-applying replaces (grant:r), never duplicates
        winacl.protect(d, [winacl.SYSTEM, winacl.ADMINISTRATORS, '*' + db], include_current_user=True)
        self.assertEqual(allow(d)[db], [(OI_CI, F)])

    def test_names_and_malformed_sids_are_refused(self):
        for bad in ('NT SERVICE\\GTrade-App', 'Everyone', '*S-1-5-80-x', ''):
            with self.assertRaises(winacl.AclError, msg=bad):
                winacl.set_acl(self.tmp, [(bad, 'R')], replace=False, protect=None, inherit=True)
        self.assertNotIn(EVERYONE, allow(self.tmp))


@unittest.skipUnless(sys.platform == 'win32', 'Windows ACLs')
class PolicyBeforeServicesExist(unittest.TestCase):
    """The full data-root policy with three NEVER-registered virtual accounts - the exact situation of a
    fresh install's prepare-data step and of the elevated self-test."""

    def setUp(self):
        self._saved = os.environ.pop('GTRADE_SKIP_ACL', None)
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-sid-policy-'))
        self.lay = lay = layout(self.tmp / 'install', self.tmp / 'data')
        lay.ensure_data_tree()
        (lay.data_root / 'client').mkdir()
        lay.install_root.mkdir(parents=True)
        (lay.install_root / 'program.txt').write_text('x')
        for f in ('install.json', 'gtrade.env', 'secrets.dpapi', 'nginx.conf', 'mime.types',
                  'tls/ca.key', 'tls/ca.crt', 'tls/server.key', 'tls/server.crt'):
            (lay.config_dir / f).write_text('x')
        lay.pg_data.mkdir(parents=True)
        (lay.pg_data / 'PG_VERSION').write_text('17')
        (lay.static_dir / 'app.js').write_text('x')
        self.names = {r: unregistered(r) for r in ('App', 'Web', 'DB')}
        self.accounts = {services.APP: f'NT SERVICE\\{self.names["App"]}',
                         services.WEB: f'NT SERVICE\\{self.names["Web"]}',
                         services.DB: f'NT SERVICE\\{self.names["DB"]}'}
        self.app, self.web, self.db = (services.service_sid(self.names[r]) for r in ('App', 'Web', 'DB'))

    def tearDown(self):
        subprocess.run(['icacls', str(self.tmp), '/reset', '/T', '/C', '/Q'], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._saved

    def apply(self):
        winacl.apply_data_root_policy(self.lay, include_current_user=True, accounts=self.accounts,
                                      keep_network_service=False)

    def test_policy_applies_and_enforces_least_privilege(self):
        self.apply()
        lay, c = self.lay, self.lay.config_dir
        for name in self.names.values():  # nothing was registered as a side effect
            self.assertIsNone(services.query_config(name))
        # secrets: App only
        for f in ('secrets.dpapi', 'gtrade.env'):
            self.assertEqual(effective_masks(c / f, self.app), {RX})
            self.assertFalse(effective_masks(c / f, self.web) | effective_masks(c / f, self.db))
        # CA private key: no service at all
        for sid in (self.app, self.web, self.db):
            self.assertFalse(effective_masks(c / 'tls' / 'ca.key', sid))
        # Web: exactly nginx's files under config (read only)
        for f in (c / 'nginx.conf', c / 'mime.types', c / 'tls' / 'server.crt', c / 'tls' / 'server.key', c / 'tls' / 'ca.crt'):
            self.assertEqual(explicit(f, self.web), {R}, f)
        # Database: DB full, nobody else
        self.assertEqual(explicit(lay.pg_data.parent, self.db), {F})
        for sid in (self.app, self.web):
            self.assertFalse(effective_masks(lay.pg_data / 'PG_VERSION', sid))
        # program files: read & execute only
        for sid in (self.app, self.web, self.db):
            self.assertEqual(explicit(lay.install_root, sid), {RX})
        # write areas
        self.assertEqual(explicit(lay.media_dir, self.app), {M})
        self.assertEqual(explicit(lay.logs_dir / 'web', self.web), {M})
        self.assertEqual(explicit(lay.logs_dir / 'db', self.db), {M})

    def test_no_everyone_and_users_only_on_client(self):
        self.apply()
        for p in [self.lay.data_root, *self.lay.data_root.rglob('*'), self.lay.install_root]:
            aces = allow(p)
            self.assertNotIn(EVERYONE, aces, p)
            if self.lay.data_root in p.parents or p == self.lay.data_root:
                in_client = p == self.lay.data_root / 'client' or (self.lay.data_root / 'client') in p.parents
                self.assertEqual(USERS in aces, in_client, p)

    def test_reapplying_is_idempotent(self):
        self.apply()
        snap = {p: winacl.read_dacl(p) for p in [self.lay.data_root, *self.lay.data_root.rglob('*'), self.lay.install_root]}
        self.apply()
        for p, acl in snap.items():
            self.assertEqual(winacl.read_dacl(p), acl, p)


if __name__ == '__main__':
    unittest.main()
