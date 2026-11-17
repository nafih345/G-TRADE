"""Program files must be read-only for services and users - the 2026-11-13 22:02 self-test failure.

    FAIL app: write program files -> denied   (detail "ok")
    ACL of the self-test install folder: ... NT SERVICE\\GTradeST-App:(OI)(CI)(RX)
                                             BUILTIN\\Users:(I)(OI)(CI)(RX)
                                             BUILTIN\\Users:(I)(CI)(WD,AD,WEA,WA)   <- inherited from C:\\ProgramData

Root cause: the install root only ever received ADDITIVE Read & execute grants and otherwise inherited
its parent's ACL. Every service token (virtual account) contains BUILTIN\\Users and Authenticated Users,
so a parent that lets Users create files (C:\\ProgramData) or lets Authenticated Users modify (a drive
root such as D:\\ - the wizard allows a custom install folder) made the program folder writable for every
service and every local user: binary planting into folders whose programs run as services.

These tests reproduce both parents with REAL ACLs in a scratch folder under %TEMP% and prove the
effect with REAL file operations made by this (non-elevated) process, whose token - like a service's -
has Users and Authenticated Users enabled and Administrators deny-only. No service is created or touched.
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

USERS, AUTH_USERS, EVERYONE, CREATOR_OWNER = 'S-1-5-32-545', 'S-1-5-11', 'S-1-1-0', 'S-1-3-0'


def icacls(*args):
    p = subprocess.run(['icacls', *map(str, args)], capture_output=True, text=True)
    assert p.returncode == 0, p.stdout + p.stderr
    return p.stdout


def can(op, path: Path) -> bool:
    try:
        if op == 'read':
            path.read_bytes()
        elif op == 'create':
            path.write_text('probe')
        elif op == 'modify':
            with open(path, 'r+b') as fh:
                fh.write(b'X')
        elif op == 'mkdir':
            path.mkdir()
        elif op == 'delete':
            path.unlink()
        return True
    except PermissionError:
        return False


def write_ops(root: Path, tag: str) -> dict:
    """Every way to change program files -> allowed?"""
    return {
        'create file in root': can('create', root / f'new-{tag}.txt'),
        'modify existing program file': can('modify', root / 'program.txt'),
        'create folder': can('mkdir', root / f'dir-{tag}'),
        'plant dll in runtime\\pgsql\\bin': can('create', root / 'runtime' / 'pgsql' / 'bin' / f'evil-{tag}.dll'),
        'replace postgres.exe': can('modify', root / 'runtime' / 'pgsql' / 'bin' / 'postgres.exe'),
        'delete program file': can('delete', root / 'runtime' / 'python' / 'python.exe'),
    }


@unittest.skipUnless(sys.platform == 'win32', 'Windows ACLs')
class ProgramFilesAcl(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop('GTRADE_SKIP_ACL', None)  # other test modules set it
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-pf-'))
        self.svc = [services.service_sid(f'GTradeST-{r}-{secrets.token_hex(4)}') for r in ('DB', 'App', 'Web')]

    def tearDown(self):
        # This process owns everything it created, so it can always take its ACLs back (WRITE_DAC).
        subprocess.run(['icacls', str(self.tmp), '/reset', '/T', '/C', '/Q'], capture_output=True)
        shutil.rmtree(self.tmp, ignore_errors=True)
        if self._saved is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._saved

    def parent(self, kind: str) -> Path:
        """A parent folder with exactly the ACL of C:\\ProgramData or of a drive root (D:\\)."""
        p = self.tmp / kind
        p.mkdir()
        if kind == 'programdata':
            icacls(p, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F',
                   f'*{USERS}:(OI)(CI)RX')
            icacls(p, '/grant', f'*{USERS}:(CI)(WD,AD,WEA,WA)')
        else:  # drive root: Authenticated Users Modify
            icacls(p, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F',
                   f'*{USERS}:(OI)(CI)RX', f'*{AUTH_USERS}:(OI)(CI)M')
        return p

    def install_tree(self, parent: Path) -> Path:
        root = parent / 'install'
        (root / 'runtime' / 'pgsql' / 'bin').mkdir(parents=True)
        (root / 'runtime' / 'python').mkdir(parents=True)
        (root / 'services').mkdir()
        (root / 'program.txt').write_text('program')
        (root / 'runtime' / 'pgsql' / 'bin' / 'postgres.exe').write_bytes(b'MZ')
        (root / 'runtime' / 'python' / 'python.exe').write_bytes(b'MZ')
        return root

    def test_defect_reproduction_inherited_parent_acl_makes_program_files_writable(self):
        for kind in ('programdata', 'driveroot'):
            root = self.install_tree(self.parent(kind))
            winacl._grant(root, [f'*{s}' for s in self.svc], 'RX')  # = everything the old policy did here
            ops = write_ops(root, kind)
            self.assertTrue(ops['create file in root'], (kind, ops))      # = "app: write program files -> ok"
            self.assertTrue(ops['plant dll in runtime\\pgsql\\bin'], (kind, ops))
            if kind == 'driveroot':
                self.assertTrue(all(ops.values()), ops)  # Modify: replace and delete binaries too
            self.assertTrue(winacl.write_exposure(root), kind)  # the scanner sees it

    def test_fix_program_files_are_read_only_wherever_they_are_installed(self):
        for kind in ('programdata', 'driveroot'):
            root = self.install_tree(self.parent(kind))
            winacl.protect_install_root(root, self.svc)
            ops = write_ops(root, kind)
            self.assertFalse(any(ops.values()), (kind, ops))
            self.assertTrue(can('read', root / 'program.txt'))
            self.assertTrue(can('read', root / 'runtime' / 'pgsql' / 'bin' / 'postgres.exe'))
            self.assertEqual(winacl.write_exposure(root), [], kind)
            d = winacl.read_dacl(root)
            self.assertTrue(d['protected'], 'nothing inherited from the parent')
            allow = {a[3]: a[2] for a in d['aces'] if a[0] == 0}
            for sid in self.svc + [USERS]:
                self.assertEqual(allow.get(sid), 0x1200A9, sid)  # exactly Read & execute
            self.assertEqual(allow.get('S-1-5-18'), 0x1F01FF)
            self.assertEqual(allow.get('S-1-5-32-544'), 0x1F01FF)
            self.assertFalse({AUTH_USERS, EVERYONE, CREATOR_OWNER} & set(allow), allow)
            # Children inherit the root's entries (no stale write grant from the old parent).
            for p in (root / 'runtime' / 'pgsql' / 'bin' / 'postgres.exe', root / 'services'):
                self.assertFalse(winacl.read_dacl(p)['protected'], p)

    def test_fix_removes_explicit_write_grants_already_inside_the_tree(self):
        root = self.install_tree(self.parent('programdata'))
        exe = root / 'runtime' / 'pgsql' / 'bin' / 'postgres.exe'
        icacls(exe, '/grant', f'*{USERS}:M')                                     # explicit on a file
        icacls(root / 'services', '/inheritance:r', '/grant:r', f'*{AUTH_USERS}:(OI)(CI)F',
               '*S-1-5-32-544:(OI)(CI)F')                                         # protected sub-folder
        icacls(root, '/grant', f'*{EVERYONE}:(OI)(CI)M')                          # explicit on the root
        self.assertTrue(can('modify', exe))
        rep = winacl.protect_install_root(root, self.svc)
        self.assertTrue(rep['repaired'])
        self.assertFalse(can('modify', exe))
        self.assertFalse(can('create', root / 'services' / 'planted.exe'))
        self.assertEqual(winacl.write_exposure(root), [])
        self.assertFalse(winacl.read_dacl(root / 'services')['protected'])

    def test_scanner_ignores_inherit_only_entries_but_sees_their_effect_on_children(self):
        """C:\\Program Files carries CREATOR OWNER:(OI)(CI)(IO)F - harmless while nobody else can create."""
        p = self.tmp / 'pf'
        p.mkdir()
        icacls(p, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F',
               f'*{USERS}:(OI)(CI)RX', f'*{CREATOR_OWNER}:(OI)(CI)(IO)F')
        self.assertEqual(winacl.write_exposure(p), [])
        q = self.tmp / 'pf2'
        q.mkdir()
        (q / 'child.txt').write_text('x')
        icacls(q, '/inheritance:r', '/grant:r', '*S-1-5-18:(OI)(CI)F', '*S-1-5-32-544:(OI)(CI)F',
               f'*{USERS}:(OI)(CI)(IO)M')  # inherit-only write for Users: nothing on q, Modify on the child
        # This non-elevated process cannot even list q now: the scanner must REPORT that, not skip it.
        found = winacl.write_exposure(q)
        self.assertEqual(len(found), 1, found)
        self.assertTrue(found[0][1].startswith('unreadable: cannot list'), found)
        icacls(q, '/grant', f'*{USERS}:RX')  # q itself listable (no inheritance)
        self.assertEqual([(Path(x).name, s) for x, s, _m in winacl.write_exposure(q)], [('child.txt', USERS)])

    def test_policy_entry_point_protects_install_root_and_keeps_data_writes(self):
        """apply_data_root_policy (prepare-data / repair-permissions / update) applies the fix; the data
        root folders the App service writes (media, logs, backups, temp, run) still grant it Modify."""
        parent = self.parent('programdata')
        lay = layout(self.install_tree(parent), parent / 'data')
        lay.ensure_data_tree()
        names = {services.APP: f'NT SERVICE\\GTradeST-App-{secrets.token_hex(4)}',
                 services.WEB: f'NT SERVICE\\GTradeST-Web-{secrets.token_hex(4)}',
                 services.DB: f'NT SERVICE\\GTradeST-DB-{secrets.token_hex(4)}'}
        winacl.apply_data_root_policy(lay, include_current_user=True, accounts=names, keep_network_service=False)
        self.assertFalse(any(write_ops(lay.install_root, 'policy').values()))
        self.assertEqual(winacl.write_exposure(lay.install_root), [])
        app = services.service_sid(names[services.APP].split('\\', 1)[1])
        for d in (lay.media_dir, lay.logs_dir / 'app', lay.backups_dir / 'db', lay.temp_dir, lay.run_dir):
            masks = [a[2] for a in winacl.read_dacl(d)['aces'] if a[0] == 0 and a[3] == app]
            self.assertTrue(any(m & 0x2 for m in masks), (d, masks))  # Modify (write data) kept


if __name__ == '__main__':
    unittest.main()
