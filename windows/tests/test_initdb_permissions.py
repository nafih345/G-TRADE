"""Installer error 3 (2026-11-13): step "database" ->
``initdb: error: could not open file "C:\\ProgramData\\G-TRADE\\pgsql\\gtrade-pw-844piyy_" for reading:
Permission denied``.

Root cause: initdb / pg_ctl / postgres never keep an administrator token. On start-up each one
re-launches itself with a RESTRICTED token (PostgreSQL src/common/restricted_token.c): the user SID
stays, BUILTIN\\Administrators becomes "deny only", all privileges go. The elevated installer created
the password file in ``pgsql\\``, whose policy is SYSTEM + Administrators + NETWORK SERVICE only, so the
file inherited exactly those three - none of which the restricted initdb has. (Had initdb got past
the file it would have failed next on ``pgsql\\data`` and ``logs\\db`` for the same reason.)

The earlier ACL tests passed because they stand the test user in for Administrators with an
(OI)(CI) Full grant everywhere - which is precisely the access the restricted token lacks.

How these tests model production without elevation: they run as the normal (non-elevated) user,
whose token has Administrators as deny-only - the same token class initdb runs with. ``pgsql\\`` and
``logs\\`` get the production policy; the test user additionally gets a NON-inheritable
"this folder only" create/list/delete grant on them, standing in for what the elevated installer can
do there, while nothing below inherits it (just as nothing below inherits a usable ACE for the
restricted initdb). The test user owns everything it creates, so it may always rewrite the ACLs
(as Administrators do in production). Everything lives in a throw-away %TEMP% folder.
"""

import ctypes
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from tests.helpers import PG_BIN, requires_pg

from gtrade_ctl import winacl
from gtrade_ctl.pg import INITDB_MARKER, PWFILE_PREFIX, PgError, PgRuntime, _shred, find_free_port

WINDOWS = sys.platform == 'win32'
ME = winacl.current_user_sid() if WINDOWS else None
win_only = unittest.skipUnless(WINDOWS and ME, 'needs Windows icacls')
PROD_PGSQL = (winacl.SYSTEM, winacl.ADMINISTRATORS, winacl.NETWORK_SERVICE)
BROAD = ('Everyone', 'BUILTIN\\Users', 'Authenticated Users', 'NT AUTHORITY\\INTERACTIVE')


def icacls(*args):
    return subprocess.run(['icacls', *args], capture_output=True, text=True)


def acl(path: Path) -> str:
    return icacls(str(path)).stdout


ME_NAME = (subprocess.run(['whoami'], capture_output=True, text=True).stdout.strip().lower() if WINDOWS else '')


def my_entries(path: Path) -> list:
    """This user's ACE texts on ``path`` (icacls prints account names, not SIDs)."""
    out = []
    for ln in acl(path).splitlines():
        low = ln.lower()
        if ME_NAME and ME_NAME + ':' in low:
            out.append(low.split(ME_NAME + ':', 1)[1].strip())
    return out


def tree_digest(root: Path) -> dict:
    return {str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
            for p in sorted(root.rglob('*')) if p.is_file()}


# ---- process token inspection (who does the PostgreSQL child really run as?) ---------------------
def process_identity(pid: int) -> dict:
    from ctypes import wintypes
    k32 = ctypes.WinDLL('kernel32', use_last_error=True)
    a32 = ctypes.WinDLL('advapi32', use_last_error=True)
    k32.OpenProcess.restype = wintypes.HANDLE
    a32.ConvertSidToStringSidW.argtypes = [ctypes.c_void_p, ctypes.POINTER(wintypes.LPWSTR)]
    h = k32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not h:
        raise OSError(ctypes.get_last_error(), 'OpenProcess')
    tok = wintypes.HANDLE()
    if not a32.OpenProcessToken(h, 0x8, ctypes.byref(tok)):  # TOKEN_QUERY
        raise OSError(ctypes.get_last_error(), 'OpenProcessToken')

    def info(cls):
        n = wintypes.DWORD()
        a32.GetTokenInformation(tok, cls, None, 0, ctypes.byref(n))
        buf = ctypes.create_string_buffer(n.value)
        if not a32.GetTokenInformation(tok, cls, buf, n, ctypes.byref(n)):
            raise OSError(ctypes.get_last_error(), 'GetTokenInformation')
        return buf

    def sid_str(p):
        s = wintypes.LPWSTR()
        a32.ConvertSidToStringSidW(p, ctypes.byref(s))
        return s.value

    try:
        user = info(1)  # TokenUser: SID_AND_ATTRIBUTES
        user_sid = sid_str(ctypes.cast(user, ctypes.POINTER(ctypes.c_void_p))[0])
        groups = info(2)  # TokenGroups: DWORD count, then SID_AND_ATTRIBUTES[]
        count = ctypes.cast(groups, ctypes.POINTER(wintypes.DWORD))[0]

        class SA(ctypes.Structure):
            _fields_ = [('Sid', ctypes.c_void_p), ('Attributes', wintypes.DWORD)]

        arr = ctypes.cast(ctypes.addressof(groups) + ctypes.sizeof(ctypes.c_void_p),
                          ctypes.POINTER(SA * count)).contents
        attrs = {sid_str(g.Sid): g.Attributes for g in arr}
    finally:
        k32.CloseHandle(tok)
        k32.CloseHandle(h)
    return {'user': user_sid, 'groups': attrs}


@win_only
@requires_pg
class InitdbUnderProductionAcl(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.port = find_free_port(56540)

    def setUp(self):
        self._saved = os.environ.pop('GTRADE_SKIP_ACL', None)
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-initdb-acl-'))
        self.pgsql = self.tmp / 'data' / 'pgsql'
        self.data = self.pgsql / 'data'
        self.logs = self.tmp / 'data' / 'logs'
        self.logdb = self.logs / 'db'
        self.data.mkdir(parents=True)
        self.logdb.mkdir(parents=True)
        # Production policy (winacl.apply_data_root_policy) on pgsql\ and logs\ ...
        grants = sum((['/grant:r', f'{p}:(OI)(CI)F'] for p in PROD_PGSQL), [])
        self._ok(icacls(str(self.pgsql), '/inheritance:r', *grants, '/grant', f'{ME}:(RX,WD,AD,DC)', '/C', '/Q'))
        self._ok(icacls(str(self.logs), '/inheritance:r', '/grant:r', f'{winacl.SYSTEM}:(OI)(CI)F',
                        '/grant:r', f'{winacl.ADMINISTRATORS}:(OI)(CI)F', '/grant:r',
                        f'{winacl.NETWORK_SERVICE}:(OI)(CI)M', '/grant', f'{ME}:(RX,WD,AD,DC)', '/C', '/Q'))
        # ... and the installer's ability to LOOK into data and logs\db (Administrators in production):
        # this folder only, so nothing created inside inherits it.
        for folder in (self.data, self.logdb):
            self._ok(icacls(str(folder), '/grant', f'{ME}:(RX)', '/C', '/Q'))
        self.pw = 'S3cret-' + os.urandom(8).hex()
        self.pg = PgRuntime(PG_BIN, self.data, self.port, self.logdb)

    def _ok(self, proc):
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def tearDown(self):
        try:
            self.pg.stop('immediate')
        except Exception:
            pass
        if self._saved is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._saved
        icacls(str(self.tmp), '/grant', f'{ME}:(OI)(CI)F', '/T', '/C', '/Q')  # our own temp tree only
        icacls(str(self.tmp), '/reset', '/T', '/C', '/Q')
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _old_initdb(self) -> tuple[subprocess.CompletedProcess, Path]:
        """The pre-fix code path, verbatim: mkstemp next to the data folder, then initdb."""
        fd, pwfile = tempfile.mkstemp(prefix=PWFILE_PREFIX, dir=str(self.pgsql))
        with os.fdopen(fd, 'w', encoding='utf-8') as fh:
            fh.write(self.pw + '\n')
        env = {k: v for k, v in os.environ.items() if not k.startswith('PG')}
        proc = subprocess.run([self.pg.exe('initdb'), '-D', str(self.data), '-U', 'postgres', '--pwfile', pwfile,
                               '-E', 'UTF8', '--locale=C', '--auth-local=scram-sha-256',
                               '--auth-host=scram-sha-256', '--data-checksums'],
                              capture_output=True, text=True, env=env)
        return proc, Path(pwfile)

    def test_old_code_reproduces_the_owner_failure_and_leaves_no_cluster(self):
        proc, pwfile = self._old_initdb()
        self.assertEqual(proc.returncode, 1)
        self.assertIn('could not open file', proc.stderr)
        self.assertIn(PWFILE_PREFIX, proc.stderr)
        self.assertIn('Permission denied', proc.stderr)
        self.assertNotIn(self.pw, proc.stderr + proc.stdout)
        # Nothing usable is inherited by the user initdb runs as (only the this-folder-only stand-in).
        self.assertEqual([e for e in my_entries(self.pgsql) if '(oi)' in e or '(ci)' in e], [])
        # initdb failed before creating anything: the data folder is still empty.
        self.assertTrue(_shred(pwfile))
        self.assertEqual(os.listdir(self.data), [])

    def test_fixed_initdb_succeeds_retry_after_denied_and_sweeps_stale_password_file(self):
        # 1) the owner's state: one failed attempt, plus (worst case) its password file left behind.
        proc, stale = self._old_initdb()
        self.assertEqual(proc.returncode, 1)
        self.assertTrue(stale.exists())
        # 2) the fixed code on the same folder.
        self.pg.initdb(self.pw)
        self.assertFalse(stale.exists(), 'stale password file must be shredded before the retry')
        self.assertFalse(list(self.pgsql.glob(PWFILE_PREFIX + '*')))
        self.assertFalse((self.pgsql / INITDB_MARKER).exists())
        self.assertTrue((self.data / 'PG_VERSION').exists())
        self.assertTrue((self.data / 'global' / 'pg_control').exists())
        self.assertEqual(self.pg.cluster_state(), 'cluster')
        # Minimal access: data + log folders gained ONE ACE (this SID, Modify); nothing broad.
        for folder in (self.data, self.logdb):
            self.assertIn('(oi)(ci)(m)', my_entries(folder))
            for broad in BROAD:
                self.assertNotIn(broad, acl(folder))
        self.assertNotIn('(oi)(ci)(m)', my_entries(self.pgsql), 'pgsql itself is not widened')
        # 3) it really starts as that identity, and the password from the file is the one set.
        self.pg.start()
        self.pg.wait_ready()
        self.assertEqual(self.pg.psql('SELECT 1', user='postgres', password=self.pw), '1')
        with self.assertRaises(PgError):
            self.pg.psql('SELECT 1', user='postgres', password='wrong')

    def test_postgres_runs_as_the_granted_sid_without_administrators(self):
        self.pg.initdb(self.pw)
        self.pg.start()
        self.pg.wait_ready()
        pid = int((self.data / 'postmaster.pid').read_text().splitlines()[0])
        ident = process_identity(pid)
        self.assertEqual('*' + ident['user'], ME, 'the postmaster runs as the SID that was granted')
        admins = ident['groups'].get('S-1-5-32-544')
        SE_GROUP_ENABLED, SE_GROUP_USE_FOR_DENY_ONLY = 0x4, 0x10
        if admins is not None:
            self.assertFalse(admins & SE_GROUP_ENABLED, 'Administrators must not be enabled in the PostgreSQL token')
            self.assertTrue(admins & SE_GROUP_USE_FOR_DENY_ONLY)

    def test_password_file_is_private_and_never_on_the_command_line(self):
        seen = {}
        real_run = PgRuntime.run

        def spy(pg, prog, *args, **kw):
            if prog == 'initdb':
                pwfile = Path(args[args.index('--pwfile') + 1])
                seen['acl'] = acl(pwfile)
                seen['argv'] = ' '.join(args)
                seen['name'] = pwfile.name
            return real_run(pg, prog, *args, **kw)

        with mock.patch.object(PgRuntime, 'run', spy):
            self.pg.initdb(self.pw)
        text = seen['acl']
        self.assertIn('BUILTIN\\Administrators:(F)', text)
        self.assertNotIn('(I)', text, 'protected DACL: nothing inherited (no NETWORK SERVICE, no SYSTEM)')
        self.assertNotIn('NETWORK SERVICE', text)
        for broad in BROAD:
            self.assertNotIn(broad, text)
        self.assertEqual(len([ln for ln in text.splitlines() if ':(' in ln]), 2, text)
        self.assertNotIn(self.pw, seen['argv'])
        self.assertTrue(seen['name'].startswith(PWFILE_PREFIX))


@requires_pg
class InitdbFailureAndPreservation(unittest.TestCase):
    """Default (inherited) ACLs; ACL changes skipped. Covers cleanup, secrecy and preservation."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-initdb-'))
        self._saved = os.environ.get('GTRADE_SKIP_ACL')
        os.environ['GTRADE_SKIP_ACL'] = '1'
        self.data = self.tmp / 'pgsql' / 'data'
        self.pg = PgRuntime(PG_BIN, self.data, find_free_port(56640), self.tmp / 'logs' / 'db')
        self.pw = 'S3cret-' + os.urandom(8).hex()

    def tearDown(self):
        try:
            self.pg.stop('immediate')
        except Exception:
            pass
        if self._saved is None:
            os.environ.pop('GTRADE_SKIP_ACL', None)
        else:
            os.environ['GTRADE_SKIP_ACL'] = self._saved
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_failed_initdb_cleans_up_and_never_leaks_the_password(self):
        real_run = PgRuntime.run

        def failing(pg, prog, *args, **kw):
            if prog == 'initdb':
                raise PgError(f'initdb failed (1): simulated failure echoing {self.pw}')
            return real_run(pg, prog, *args, **kw)

        with mock.patch.object(PgRuntime, 'run', failing):
            with self.assertRaises(PgError) as ctx:
                self.pg.initdb(self.pw)
        self.assertNotIn(self.pw, str(ctx.exception))
        self.assertIn('[REDACTED]', str(ctx.exception))
        self.assertFalse(list(self.data.parent.glob(PWFILE_PREFIX + '*')))
        self.assertFalse((self.data.parent / INITDB_MARKER).exists())
        self.assertEqual(self.pg.cluster_state(), 'empty')
        # ... and a clean retry then succeeds.
        self.pg.initdb(self.pw)
        self.assertEqual(self.pg.cluster_state(), 'cluster')

    def test_interrupted_initdb_is_partial_and_left_untouched(self):
        self.data.mkdir(parents=True)
        (self.data / 'PG_VERSION').write_text('17\n')
        (self.data / 'base').mkdir()
        (self.data / 'base' / 'half-written').write_bytes(b'x' * 100)
        (self.data.parent / INITDB_MARKER).write_text('{}')
        before = tree_digest(self.tmp)
        self.assertEqual(self.pg.cluster_state(), 'partial')
        with self.assertRaises(PgError) as ctx:
            self.pg.initdb(self.pw)
        self.assertIn('INCOMPLETE', str(ctx.exception))
        self.assertIn('Nothing was changed or deleted', str(ctx.exception))
        self.assertEqual(tree_digest(self.tmp), before)

    def test_pg_version_without_pg_control_is_partial_even_without_marker(self):
        self.data.mkdir(parents=True)
        (self.data / 'PG_VERSION').write_text('17\n')
        self.assertEqual(self.pg.cluster_state(), 'partial')
        with self.assertRaises(PgError):
            self.pg.initdb(self.pw)
        self.assertEqual((self.data / 'PG_VERSION').read_text(), '17\n')

    def test_stale_marker_with_empty_folder_is_retried(self):
        self.data.mkdir(parents=True)
        (self.data.parent / INITDB_MARKER).write_text('{}')
        self.assertEqual(self.pg.cluster_state(), 'empty')
        self.pg.initdb(self.pw)
        self.assertEqual(self.pg.cluster_state(), 'cluster')
        self.assertFalse((self.data.parent / INITDB_MARKER).exists())

    def test_existing_database_is_preserved_byte_for_byte(self):
        self.pg.initdb(self.pw)
        self.pg.start()
        self.pg.wait_ready()
        self.pg.psql("CREATE TABLE keep (v text); INSERT INTO keep VALUES ('customer data');",
                     user='postgres', password=self.pw)
        self.pg.stop()
        stale = self.data.parent / f'{PWFILE_PREFIX}leftover'
        stale.write_text('old secret\n')
        before = tree_digest(self.data)
        self.assertEqual(self.pg.sweep_stale_pwfiles(), 1)
        with self.assertRaises(PgError):
            self.pg.initdb('another-password')
        self.assertEqual(tree_digest(self.data), before)
        self.assertFalse(stale.exists())
        self.pg.start()
        self.pg.wait_ready()
        self.assertEqual(self.pg.psql('SELECT v FROM keep', user='postgres', password=self.pw), 'customer data')


@win_only
class PrivateFileAndGrant(unittest.TestCase):
    def setUp(self):
        self._saved = os.environ.pop('GTRADE_SKIP_ACL', None)
        self.tmp = Path(tempfile.mkdtemp(prefix='gtrade-pfile-'))

    def tearDown(self):
        if self._saved is not None:
            os.environ['GTRADE_SKIP_ACL'] = self._saved
        icacls(str(self.tmp), '/reset', '/T', '/C', '/Q')
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_private_file_has_exactly_the_given_principals(self):
        f = self.tmp / 'p'
        winacl.create_private_file(f, b'hello\n', [winacl.ADMINISTRATORS, ME])
        self.assertEqual(f.read_bytes(), b'hello\n')
        text = acl(f)
        self.assertNotIn('(I)', text)
        self.assertEqual(len([ln for ln in text.splitlines() if ':(' in ln]), 2, text)
        with self.assertRaises(winacl.AclError):
            winacl.create_private_file(f, b'again', [ME])  # CREATE_NEW: never overwrites
        self.assertEqual(f.read_bytes(), b'hello\n')
        with self.assertRaises(winacl.AclError):
            winacl.create_private_file(self.tmp / 'q', b'x', ['*S-1-5-32-544)(A;;FA;;;WD'])  # SDDL injection

    def test_grant_operator_only_adds_one_entry_and_is_idempotent(self):
        d = self.tmp / 'd'
        d.mkdir()

        def entries():
            return [ln.replace(str(d), '').strip() for ln in acl(d).splitlines() if ':(' in ln]

        before = entries()
        self.assertEqual(winacl.grant_operator(d), ME)
        winacl.grant_operator(d)
        after = entries()
        for entry in before:  # nothing removed
            self.assertIn(entry, after)
        self.assertEqual(my_entries(d).count('(oi)(ci)(m)'), 1, after)
        self.assertLessEqual(len(after), len(before) + 1)


if __name__ == '__main__':
    unittest.main()
