"""Folder and file permissions via icacls.

Data root policy (least privilege per service since 2026-11-13; table in ``apply_data_root_policy``):
* Every service has its own virtual account (``NT SERVICE\\GTrade-DB|App|Web``, services.py) and
  gets only the folders/files it uses. SYSTEM + Administrators have Full control everywhere.
* ``config\\`` (secrets, licence): App read only. ``config\\tls`` (incl. the CA private key): no
  service access, except nginx's three files (server.crt/.key, ca.crt) which Web may read.
* ``pgsql\\``: GTrade-DB full. ``pgsql\\data`` and ``logs\\db`` also get ONE inheritable Modify
  entry for the account that runs setup/maintenance, because the PostgreSQL programs it starts
  drop Administrators from their token (see ``grant_operator``). NETWORK SERVICE (the old
  database account) stays on them only until every service is verified on its new account.
* ``Users`` get nothing except ``client\\`` (server URL + the PUBLIC CA certificate, no secrets),
  so the desktop app running as a normal user can find its server. Nothing grants Everyone.

How it is applied (defect fixed 2026-11-13, see G_OPTICALS_INSTALLER_PERMISSION_FIX_REPORT.md):
each protected folder gets its own explicit, inheritable ACL with inheritance from above cut;
everything *below* it is then switched back to inheriting from it. The old single call
``icacls <dir> /inheritance:r /grant:r SID:(OI)(CI)F ... /T`` stripped inheritance from every
FILE underneath while the (OI)(CI) grants never apply to a file, leaving files with an EMPTY
DACL - unreadable even for SYSTEM and an elevated Administrator - while icacls still exited 0.
The first install then failed reading its own config\\install.json.

Re-enabling inheritance below a protected folder only ever ADDS the folder's ACEs (explicit ACEs
already on a file or folder are kept), so it is safe on existing customer data and is also what
repairs files damaged by the old code. Nothing here takes ownership, resets ACLs, or touches
anything outside the G-TRADE data root.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

SYSTEM = '*S-1-5-18'
ADMINISTRATORS = '*S-1-5-32-544'
NETWORK_SERVICE = '*S-1-5-20'
USERS = '*S-1-5-32-545'
EVERYONE = '*S-1-1-0'
AUTHENTICATED_USERS = '*S-1-5-11'
INTERACTIVE = '*S-1-5-4'
CREATOR_OWNER = '*S-1-3-0'
ALL_APP_PACKAGES = '*S-1-15-2-1'             # read-only on Program Files by default (Chromium/Electron
ALL_RESTRICTED_APP_PACKAGES = '*S-1-15-2-2'  # sandboxed processes load binaries through these)
TRUSTED_INSTALLER = '*S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
# The only accounts that may change program files (= what C:\Program Files allows).
PROGRAM_WRITERS = frozenset(s[1:] for s in (SYSTEM, ADMINISTRATORS, TRUSTED_INSTALLER))
# Broad groups that must never hold a grant of their own on program files (Users gets read only).
BROAD_PRINCIPALS = (EVERYONE, AUTHENTICATED_USERS, INTERACTIVE, CREATOR_OWNER)
# Any of these bits in an ALLOW entry = that principal can change the file/folder (or its ACL).
# FILE_WRITE_DATA/ADD_FILE, APPEND_DATA/ADD_SUBDIRECTORY, WRITE_EA, DELETE_CHILD, WRITE_ATTRIBUTES,
# DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE.
WRITE_BITS = 0x2 | 0x4 | 0x10 | 0x40 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000

# Sub-folders of the data root that get their own policy (so the root pass leaves them alone).
MANAGED_SUBDIRS = ('config', 'pgsql', 'media', 'static', 'logs', 'backups', 'run', 'updates', 'temp', 'client')


class AclError(RuntimeError):
    pass


def _icacls(*args: str) -> str:
    if sys.platform != 'win32':  # pragma: no cover
        return ''
    proc = subprocess.run(['icacls', *args], capture_output=True, text=True, encoding='utf-8', errors='replace')
    if proc.returncode != 0:
        raise AclError(f'icacls {args[0]} failed: {proc.stdout.strip()} {proc.stderr.strip()}')
    return proc.stdout


def _skip() -> bool:
    return os.environ.get('GTRADE_SKIP_ACL') == '1' or sys.platform != 'win32'


def current_user_sid() -> str | None:
    if sys.platform != 'win32':  # pragma: no cover
        return None
    # Output: "DOMAIN\user","S-1-5-21-..."
    out = subprocess.run(['whoami', '/user', '/fo', 'csv', '/nh'], capture_output=True, text=True).stdout.strip()
    sid = out.rsplit(',', 1)[-1].strip().strip('"') if out else ''
    return f'*{sid}' if sid.startswith('S-1-') else None


def _same(a: Path, b: Path) -> bool:
    return os.path.normcase(os.path.abspath(a)) == os.path.normcase(os.path.abspath(b))


def inherit_below(path: Path, exclude=()) -> list[str]:
    """Make everything under ``path`` inherit from it (``icacls <child> /inheritance:e /T``).

    Adds the parent's inheritable ACEs; never removes an ACE. ``exclude`` lists direct children
    that are protected separately. Returns the children processed."""
    if _skip() or not path.is_dir():
        return []
    done = []
    for child in sorted(path.iterdir()):
        if any(_same(child, e) for e in exclude):
            continue
        _icacls(str(child), '/inheritance:e', '/T', '/C', '/Q')
        done.append(child.name)
    return done


def protect(path: Path, full: list[str], modify: list[str] = (), read: list[str] = (), include_current_user=False,
            exclude=()) -> None:
    """Give ``path`` exactly these inheritable grants (no inheritance from above) and make its
    contents inherit them. A missing ``path`` is skipped."""
    if _skip() or not path.exists():
        return
    grants = []
    principals = list(full)
    if include_current_user:
        sid = current_user_sid()
        if sid:
            principals.append(sid)
    for p in principals:
        grants.append((p, 'F'))
    for p in modify:
        grants.append((p, 'M'))
    for p in read:
        grants.append((p, 'RX'))
    # 1) The folder itself - (OI)(CI) grants, inheritance from above cut (= icacls /inheritance:r
    #    /grant:r, but through the Win32 ACL API: see set_acl for why not icacls).
    set_acl(path, grants, replace=True, protect=True, inherit=True)
    # 2) Its contents inherit from it (also repairs files left with an empty DACL by the old code).
    inherit_below(path, exclude=exclude)


def describe(path: Path) -> str:
    return _icacls(str(path))


# ---- Win32 ACL writer (defect fixed 2026-11-13, G_OPTICALS_SERVICE_SID_ACL_FIX_REPORT.md) -----------
# icacls cannot grant a SID that the LSA cannot translate to an account name: "*S-1-5-80-...: No mapping
# between account names and security IDs was done" (ERROR_NONE_MAPPED, 1332), exit 1332, nothing
# changed. A virtual service account's SID (S-1-5-80-<SHA-1 of the upper-cased service name>) is only
# translatable while a service of that name is REGISTERED, but the data-root policy must be applied
# BEFORE the services exist (fresh install: prepare-data runs before the services step; the elevated
# self-test: before its disposable services are registered). The ACL itself stores binary SIDs and
# never needs a name, so the grants are written with the documented Win32 API instead:
# ConvertStringSidToSidW -> SetEntriesInAclW -> SetNamedSecurityInfoW (which also propagates the
# inheritable entries to the folder's contents, as icacls did). Nothing is resolved by name, so an
# unregistered service SID is granted exactly like a registered one. Inputs are validated (IsValidSid).
_RIGHTS = {'F': 0x001F01FF, 'M': 0x001301BF, 'RX': 0x001200A9, 'R': 0x00120089}  # = icacls F/M/RX/R
_GRANT_ACCESS, _SET_ACCESS = 1, 2
_NO_INHERITANCE, _OI_CI = 0x0, 0x3  # SUB_CONTAINERS_AND_OBJECTS_INHERIT = (OI)(CI)
_SE_FILE_OBJECT = 1
_DACL_SI = 0x4
_PROTECTED_DACL_SI = 0x80000000
_UNPROTECTED_DACL_SI = 0x20000000
_SE_DACL_PROTECTED = 0x1000
_INHERITED_ACE = 0x10


def _advapi():
    import ctypes
    from ctypes import wintypes

    class TRUSTEE(ctypes.Structure):
        _fields_ = [('pMultipleTrustee', ctypes.c_void_p), ('MultipleTrusteeOperation', ctypes.c_int),
                    ('TrusteeForm', ctypes.c_int), ('TrusteeType', ctypes.c_int), ('ptstrName', ctypes.c_void_p)]

    class EXPLICIT_ACCESS(ctypes.Structure):
        _fields_ = [('grfAccessPermissions', wintypes.DWORD), ('grfAccessMode', ctypes.c_int),
                    ('grfInheritance', wintypes.DWORD), ('Trustee', TRUSTEE)]

    class ACL_SIZE_INFORMATION(ctypes.Structure):
        _fields_ = [('AceCount', wintypes.DWORD), ('AclBytesInUse', wintypes.DWORD), ('AclBytesFree', wintypes.DWORD)]

    class ACE_HEADER(ctypes.Structure):
        _fields_ = [('AceType', ctypes.c_ubyte), ('AceFlags', ctypes.c_ubyte), ('AceSize', ctypes.c_ushort)]

    a = ctypes.WinDLL('advapi32', use_last_error=True)
    k = ctypes.WinDLL('kernel32', use_last_error=True)
    P, PP, D = ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p), wintypes.DWORD
    a.ConvertStringSidToSidW.argtypes = [wintypes.LPCWSTR, PP]
    a.ConvertStringSidToSidW.restype = wintypes.BOOL
    a.IsValidSid.argtypes = [P]
    a.IsValidSid.restype = wintypes.BOOL
    a.GetLengthSid.argtypes = [P]
    a.GetLengthSid.restype = D
    a.GetNamedSecurityInfoW.argtypes = [wintypes.LPCWSTR, ctypes.c_int, D, PP, PP, PP, PP, PP]
    a.GetNamedSecurityInfoW.restype = D
    a.SetNamedSecurityInfoW.argtypes = [wintypes.LPWSTR, ctypes.c_int, D, P, P, P, P]
    a.SetNamedSecurityInfoW.restype = D
    a.SetEntriesInAclW.argtypes = [wintypes.ULONG, ctypes.POINTER(EXPLICIT_ACCESS), P, PP]
    a.SetEntriesInAclW.restype = D
    a.GetSecurityDescriptorControl.argtypes = [P, ctypes.POINTER(wintypes.WORD), ctypes.POINTER(D)]
    a.GetSecurityDescriptorControl.restype = wintypes.BOOL
    a.GetAclInformation.argtypes = [P, P, D, ctypes.c_int]
    a.GetAclInformation.restype = wintypes.BOOL
    a.GetAce.argtypes = [P, D, PP]
    a.GetAce.restype = wintypes.BOOL
    a.InitializeAcl.argtypes = [P, D, D]
    a.InitializeAcl.restype = wintypes.BOOL
    a.AddAce.argtypes = [P, D, D, P, D]
    a.AddAce.restype = wintypes.BOOL
    a.ConvertSidToStringSidW.argtypes = [P, ctypes.POINTER(wintypes.LPWSTR)]
    a.ConvertSidToStringSidW.restype = wintypes.BOOL
    k.LocalFree.argtypes = [P]
    k.LocalFree.restype = P
    return ctypes, a, k, TRUSTEE, EXPLICIT_ACCESS, ACL_SIZE_INFORMATION, ACE_HEADER


def _sid_text(principal: str) -> str:
    """'*S-1-5-80-...' / 'S-1-...' -> 'S-1-...'. Account NAMES are refused: every principal this module
    grants is a SID, so nothing ever depends on (or is changed by) a name lookup."""
    s = principal.strip()
    s = s[1:] if s.startswith('*') else s
    if not s.upper().startswith('S-1-'):
        raise AclError(f'not a SID: {principal!r} (winacl grants SIDs only)')
    return s


def _win_err(what: str, code: int, path: Path) -> AclError:
    import ctypes
    return AclError(f'{what} failed for {path}: {ctypes.FormatError(code).strip()} (Windows error {code})')


def set_acl(path: Path, grants: list[tuple[str, str]], *, replace: bool, protect: bool | None, inherit: bool) -> None:
    """Write ``grants`` [(SID, 'F'|'M'|'RX'|'R')] into ``path``'s DACL without any name lookup.

    replace=False  = ``icacls /grant``   : merge the rights into the DACL, nothing removed.
    replace=True   = ``icacls /grant:r`` : the listed SIDs' explicit entries are replaced.
    protect=True   = ``/inheritance:r``  : inherited entries dropped, inheritance from above cut;
                     every other EXPLICIT entry on ``path`` is kept (as icacls does).
    protect=None   : the current protection state is kept.
    inherit        : (OI)(CI) entries (folders) or entries on the object only (files)."""
    if _skip() or not grants:
        return
    ctypes, a, k, TRUSTEE, EXPLICIT_ACCESS, ACL_SIZE_INFORMATION, ACE_HEADER = _advapi()
    seen, entries = set(), []
    for principal, perm in grants:  # first wins: callers list the strongest right first (F, M, RX)
        sid = _sid_text(principal).upper()
        if sid not in seen:
            seen.add(sid)
            entries.append((sid, _RIGHTS[perm]))
    sids = []
    old_sd = ctypes.c_void_p()
    new_acl = ctypes.c_void_p()
    filtered = None
    try:
        for sid, _mask in entries:
            psid = ctypes.c_void_p()
            if not a.ConvertStringSidToSidW(sid, ctypes.byref(psid)):
                raise _win_err(f'ConvertStringSidToSid({sid})', ctypes.get_last_error(), path)
            sids.append(psid)
            if not a.IsValidSid(psid):
                raise AclError(f'invalid SID {sid} for {path}')
        old_dacl = ctypes.c_void_p()
        err = a.GetNamedSecurityInfoW(str(path), _SE_FILE_OBJECT, _DACL_SI, None, None, ctypes.byref(old_dacl),
                                      None, ctypes.byref(old_sd))
        if err:
            raise _win_err('GetNamedSecurityInfo', err, path)
        control, rev = ctypes.c_ushort(), ctypes.c_ulong()
        if not a.GetSecurityDescriptorControl(old_sd, ctypes.byref(control), ctypes.byref(rev)):
            raise _win_err('GetSecurityDescriptorControl', ctypes.get_last_error(), path)
        base = old_dacl
        if protect and old_dacl.value:
            # Keep the explicit entries only (icacls /inheritance:r semantics).
            info = ACL_SIZE_INFORMATION()
            if not a.GetAclInformation(old_dacl, ctypes.byref(info), ctypes.sizeof(info), 2):
                raise _win_err('GetAclInformation', ctypes.get_last_error(), path)
            acl_rev = ctypes.cast(old_dacl, ctypes.POINTER(ctypes.c_ubyte))[0]
            size = max(info.AclBytesInUse, 8)
            filtered = ctypes.create_string_buffer(size)
            if not a.InitializeAcl(filtered, size, acl_rev):
                raise _win_err('InitializeAcl', ctypes.get_last_error(), path)
            for i in range(info.AceCount):
                ace = ctypes.c_void_p()
                if not a.GetAce(old_dacl, i, ctypes.byref(ace)):
                    raise _win_err('GetAce', ctypes.get_last_error(), path)
                hdr = ctypes.cast(ace, ctypes.POINTER(ACE_HEADER)).contents
                if hdr.AceFlags & _INHERITED_ACE:
                    continue
                if not a.AddAce(filtered, acl_rev, 0xFFFFFFFF, ace, hdr.AceSize):
                    raise _win_err('AddAce', ctypes.get_last_error(), path)
            base = ctypes.cast(filtered, ctypes.c_void_p)
        arr = (EXPLICIT_ACCESS * len(entries))()
        for i, ((_sid, mask), psid) in enumerate(zip(entries, sids)):
            arr[i].grfAccessPermissions = mask
            arr[i].grfAccessMode = _SET_ACCESS if replace else _GRANT_ACCESS
            arr[i].grfInheritance = _OI_CI if inherit else _NO_INHERITANCE
            arr[i].Trustee.TrusteeForm = 0  # TRUSTEE_IS_SID: no name resolution anywhere
            arr[i].Trustee.TrusteeType = 0  # TRUSTEE_IS_UNKNOWN
            arr[i].Trustee.ptstrName = psid.value
        err = a.SetEntriesInAclW(len(entries), arr, base, ctypes.byref(new_acl))
        if err:
            raise _win_err('SetEntriesInAcl', err, path)
        protected = bool(control.value & _SE_DACL_PROTECTED) if protect is None else protect
        flags = _DACL_SI | (_PROTECTED_DACL_SI if protected else _UNPROTECTED_DACL_SI)
        err = a.SetNamedSecurityInfoW(str(path), _SE_FILE_OBJECT, flags, None, None, new_acl, None)
        if err:
            raise _win_err('SetNamedSecurityInfo', err, path)
    finally:
        for psid in sids:
            k.LocalFree(psid)
        if new_acl.value:
            k.LocalFree(new_acl)
        if old_sd.value:
            k.LocalFree(old_sd)


def read_dacl(path: Path) -> dict:
    """{'protected': bool, 'aces': [(type, flags, mask, 'S-1-...')]} read with the Win32 API (by SID,
    so unregistered service SIDs read back exactly like registered ones). type 0 = allow, 1 = deny."""
    ctypes, a, k, _T, _E, ACL_SIZE_INFORMATION, ACE_HEADER = _advapi()
    from ctypes import wintypes
    sd, dacl = ctypes.c_void_p(), ctypes.c_void_p()
    err = a.GetNamedSecurityInfoW(str(path), _SE_FILE_OBJECT, _DACL_SI, None, None, ctypes.byref(dacl), None,
                                  ctypes.byref(sd))
    if err:
        raise _win_err('GetNamedSecurityInfo', err, path)
    try:
        control, rev = ctypes.c_ushort(), ctypes.c_ulong()
        a.GetSecurityDescriptorControl(sd, ctypes.byref(control), ctypes.byref(rev))
        aces = []
        if dacl.value:
            info = ACL_SIZE_INFORMATION()
            a.GetAclInformation(dacl, ctypes.byref(info), ctypes.sizeof(info), 2)
            for i in range(info.AceCount):
                ace = ctypes.c_void_p()
                a.GetAce(dacl, i, ctypes.byref(ace))
                hdr = ctypes.cast(ace, ctypes.POINTER(ACE_HEADER)).contents
                if hdr.AceType not in (0, 1):  # only simple allow/deny ACEs carry (mask, SID) at offset 4/8
                    aces.append((hdr.AceType, hdr.AceFlags, None, None))
                    continue
                mask = ctypes.cast(ace.value + 4, ctypes.POINTER(wintypes.DWORD))[0]
                text = wintypes.LPWSTR()
                a.ConvertSidToStringSidW(ctypes.c_void_p(ace.value + 8), ctypes.byref(text))
                aces.append((hdr.AceType, hdr.AceFlags, mask, text.value))
                k.LocalFree(ctypes.cast(text, ctypes.c_void_p))
        return {'protected': bool(control.value & _SE_DACL_PROTECTED), 'aces': aces}
    finally:
        k.LocalFree(sd)


# ---- PostgreSQL process identity (defect fixed 2026-11-13, G_OPTICALS_POSTGRESQL_INITDB_PERMISSION_FIX_REPORT.md)
# initdb, pg_ctl and postgres never run with an administrator token: on start-up each re-launches itself
# with a *restricted* token (PostgreSQL src/common/restricted_token.c) in which BUILTIN\Administrators
# and Power Users are "deny only" and every privilege is removed. When the elevated installer runs them,
# the process that touches files is therefore "the installing user's SID, WITHOUT Administrators". A
# file or folder granted only to SYSTEM + Administrators + NETWORK SERVICE (the pgsql policy) is closed
# to it: "initdb: could not open file ...gtrade-pw-... for reading: Permission denied".
SELF_GRANT_NOT_NEEDED = ('*S-1-5-18', '*S-1-5-19', '*S-1-5-20')  # SYSTEM, LOCAL SERVICE, NETWORK SERVICE


def grant_operator(*folders: Path) -> str | None:
    """Give the SID this process runs as (= the SID of the restricted PostgreSQL child it starts)
    inheritable Modify on exactly ``folders`` (the cluster folder and its log folder) and nothing else.

    It ADDS one ACE (``icacls /grant``, not ``/grant:r`` and no ``/inheritance:r``); it never removes
    an entry, never touches Users/Everyone and never reaches outside ``folders``. Idempotent. Returns
    the SID granted (or None when ACLs are skipped / not needed)."""
    if _skip():
        return None
    sid = current_user_sid()
    if not sid:
        raise AclError('could not determine the account this program runs as')
    if sid in SELF_GRANT_NOT_NEEDED:
        return None
    for folder in folders:
        _icacls(str(folder), '/grant', f'{sid}:(OI)(CI)M', '/C', '/Q')
    return sid


def create_private_file(path: Path, data: bytes, principals: list[str]) -> None:
    """Create a NEW file whose DACL is protected (nothing inherited) and lists exactly ``principals``
    with Full control, then write ``data``. The DACL is applied by CreateFileW itself, so the file
    never exists with inherited access for even a moment. Fails if ``path`` already exists."""
    if sys.platform != 'win32':  # pragma: no cover - POSIX: 0600 owner-only
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'wb') as fh:
            fh.write(data)
        return
    import ctypes
    from ctypes import wintypes
    if not principals:
        raise AclError('a private file needs at least one principal')
    for p in principals:
        if not (p.startswith('*S-1-') and all(ch.isdigit() or ch == '-' for ch in p[3:])):
            raise AclError(f'invalid SID {p!r}')
    sddl = 'D:P' + ''.join(f'(A;;FA;;;{p[1:]})' for p in dict.fromkeys(principals))
    advapi32 = ctypes.WinDLL('advapi32', use_last_error=True)
    kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)

    class SECURITY_ATTRIBUTES(ctypes.Structure):
        _fields_ = [('nLength', wintypes.DWORD), ('lpSecurityDescriptor', ctypes.c_void_p),
                    ('bInheritHandle', wintypes.BOOL)]

    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.argtypes = [
        wintypes.LPCWSTR, wintypes.DWORD, ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p]
    advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW.restype = wintypes.BOOL
    kernel32.CreateFileW.argtypes = [wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD,
                                     ctypes.POINTER(SECURITY_ATTRIBUTES), wintypes.DWORD, wintypes.DWORD,
                                     wintypes.HANDLE]
    kernel32.CreateFileW.restype = wintypes.HANDLE
    kernel32.WriteFile.argtypes = [wintypes.HANDLE, ctypes.c_char_p, wintypes.DWORD,
                                   ctypes.POINTER(wintypes.DWORD), ctypes.c_void_p]
    kernel32.WriteFile.restype = wintypes.BOOL
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel32.FlushFileBuffers.argtypes = [wintypes.HANDLE]
    kernel32.LocalFree.argtypes = [ctypes.c_void_p]

    sd = ctypes.c_void_p()
    if not advapi32.ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, ctypes.byref(sd), None):
        raise AclError(f'could not build the security descriptor (error {ctypes.get_last_error()})')
    try:
        sa = SECURITY_ATTRIBUTES(ctypes.sizeof(SECURITY_ATTRIBUTES), sd, False)
        GENERIC_WRITE, CREATE_NEW, FILE_ATTRIBUTE_NORMAL = 0x40000000, 1, 0x80
        handle = kernel32.CreateFileW(str(path), GENERIC_WRITE, 0, ctypes.byref(sa), CREATE_NEW,
                                      FILE_ATTRIBUTE_NORMAL, None)
        if handle in (None, wintypes.HANDLE(-1).value):
            err = ctypes.get_last_error()
            raise AclError(f'could not create {path.name} (Windows error {err})')
        try:
            written = wintypes.DWORD(0)
            if not kernel32.WriteFile(handle, data, len(data), ctypes.byref(written), None) or written.value != len(data):
                raise AclError(f'could not write {path.name} (Windows error {ctypes.get_last_error()})')
            kernel32.FlushFileBuffers(handle)
        finally:
            kernel32.CloseHandle(handle)
    finally:
        kernel32.LocalFree(sd)


def service_principals(accounts: dict | None = None, keep_network_service: bool | None = None) -> dict:
    """icacls principals per role: {'db': [...], 'app': [...], 'web': [...]}.

    Each service's own SID (virtual account ``NT SERVICE\\<id>``). LocalSystem needs no grant (SYSTEM
    has Full control everywhere). NETWORK SERVICE is kept on the database folders while the database
    still runs - or may be rolled back to run - as NETWORK SERVICE (installs before 2026-11-13)."""
    from . import services as svc
    want = svc.target_accounts(accounts)
    out = {}
    for role, sid in (('db', svc.DB), ('app', svc.APP), ('web', svc.WEB)):
        p = svc.account_sid(want[sid])
        out[role] = [p] if p else []
    if keep_network_service is None:
        keep_network_service = _db_uses_network_service()
    if keep_network_service and NETWORK_SERVICE not in out['db']:
        out['db'].append(NETWORK_SERVICE)
    return out


def _db_uses_network_service() -> bool:
    if _skip():
        return False
    from . import services as svc
    try:
        return svc.same_account(svc.current_account(svc.DB), svc.NETWORK_SERVICE)
    except Exception:
        return True  # unknown: never take access away from a database that may need it


def _grant(path: Path, principals: list[str], perm: str, inherit=True) -> None:
    """ADD one ACE per principal (never removes anything). Missing paths are skipped."""
    if _skip() or not path.exists() or not principals:
        return
    set_acl(path, [(p, perm) for p in principals], replace=False, protect=None, inherit=inherit and path.is_dir())


def _remove(path: Path, principal: str) -> None:
    """Remove ``principal``'s explicit grant ACEs from ``path`` itself (children inherit the change)."""
    if _skip() or not path.exists():
        return
    _icacls(str(path), '/remove:g', principal, '/C', '/Q')


def web_read_files(layout) -> list[Path]:
    """The only files under config\\ that nginx reads. NOT ca.key (the installation CA's private key)."""
    return [layout.nginx_conf, layout.config_dir / 'mime.types',
            layout.tls_dir / 'server.crt', layout.tls_dir / 'server.key', layout.tls_dir / 'ca.crt']


# ---- program files (defect fixed 2026-11-13, G_OPTICALS_SELFTEST_SHUTDOWN_AND_PROGRAM_FILES_FIX_REPORT.md)
# The install root used to receive only ADDITIVE Read & execute grants for the service accounts and
# otherwise inherited whatever its parent folder allows. That is read-only for Users only by luck of
# location: under C:\ProgramData (the elevated self-test) the inherited "BUILTIN\Users:(CI)(WD,AD,WEA,WA)"
# let every service account - all service tokens contain BUILTIN\Users - create files in the program
# folder ("app: write program files -> ok"); a customer-chosen folder such as D:\G OPTICALS (the wizard
# allows changing it) inherits the drive root's "Authenticated Users: Modify", so any local user AND
# every service could replace python.exe / postgres.exe / the WinSW wrappers that run as services.
# Now the install root gets its OWN protected ACL that does not depend on where it sits:
#   SYSTEM, Administrators: Full     (the elevated installer/updater/uninstaller)
#   Users, ALL [RESTRICTED] APPLICATION PACKAGES: Read & execute  (desktop app, gtrade-ctl, restricted
#       PostgreSQL tokens; = the Program Files defaults)
#   each service account: Read & execute
# and nothing else: no Everyone / Authenticated Users / CREATOR OWNER / per-user entries; then every
# remaining write grant to anyone else below it is a hard error (write_exposure).
def write_exposure(root: Path, allowed: frozenset = PROGRAM_WRITERS, limit: int = 50) -> list[tuple[str, str, int]]:
    """[(path, SID, mask)] for every ALLOW entry under ``root`` (itself included, inherited entries too)
    that lets a principal other than ``allowed`` change a file or folder. Read via the Win32 API by SID."""
    if _skip() or not root.exists():
        return []
    found = []

    def walk(top: Path):  # unlike rglob, a folder that cannot be listed is REPORTED, never skipped
        yield top
        if top.is_dir() and not top.is_symlink():
            try:
                children = sorted(os.scandir(top), key=lambda e: e.name)
            except OSError as exc:
                found.append((str(top), f'unreadable: cannot list ({exc.strerror})', 0))
                return
            for e in children:
                yield from walk(Path(e.path))

    for path in walk(root):
        try:
            aces = read_dacl(path)['aces']
        except AclError as exc:
            found.append((str(path), f'unreadable: {exc}', 0))
            continue
        for typ, flags, mask, sid in aces:
            # INHERIT_ONLY (0x08) entries (e.g. Program Files' CREATOR OWNER) grant nothing on this object;
            # where they do apply - a child - that child's own entry is scanned.
            if typ == 0 and not flags & 0x08 and mask is not None and mask & WRITE_BITS and sid not in allowed:
                found.append((str(path), sid, mask))
        if len(found) >= limit:
            break
    return found


def _drop_explicit(path: Path, principals) -> None:
    present = {a[3] for a in read_dacl(path)['aces'] if a[0] == 0 and not a[1] & _INHERITED_ACE}
    for p in principals:
        if p[1:] in present:
            _icacls(str(path), '/remove:g', p, '/C', '/Q')


def protect_install_root(install_root: Path, service_readers: list[str] = ()) -> dict:
    """Make the program folder read-only for everyone but SYSTEM/Administrators (see above). Safe to
    repeat; touches nothing outside ``install_root``. Raises AclError if any write grant survives."""
    if _skip() or not install_root.exists():
        return {'skipped': True}
    readers = [USERS, ALL_APP_PACKAGES, ALL_RESTRICTED_APP_PACKAGES, *service_readers]
    grants = [(SYSTEM, 'F'), (ADMINISTRATORS, 'F')] + [(p, 'RX') for p in readers]
    # 1) The folder: exactly these (OI)(CI) entries, nothing inherited from the parent. replace=True
    #    turns an existing explicit Users/service grant into Read & execute; Windows propagates the
    #    result to every child that inherits.
    set_acl(install_root, grants, replace=True, protect=True, inherit=True)
    _drop_explicit(install_root, BROAD_PRINCIPALS)
    # 2) Explicit write grants left on anything below (a per-user or broad entry added by hand or by an
    #    old tool): remove that principal's explicit grants there and let it inherit from the root.
    repaired = []
    found = write_exposure(install_root, limit=1_000_000)  # one full pass (~1 ms per file)
    left = [f for f in found if f[1].startswith('unreadable') or _same(Path(f[0]), install_root)]
    for path, sid, _mask in found:
        p = Path(path)
        if sid.startswith('unreadable') or _same(p, install_root):
            continue
        _icacls(path, '/remove:g', f'*{sid}', '/C', '/Q')
        if p.is_dir():
            _icacls(path, '/inheritance:e', '/C', '/Q')
        else:
            set_acl(p, [(SYSTEM, 'F')], replace=False, protect=False, inherit=False)  # = inherit again
        repaired.append(path)
    # Re-check what was repaired (and everything below a repaired folder); the rest was already clean
    # and inherits only the root's entries, which were just verified.
    for path in dict.fromkeys(repaired):
        left += write_exposure(Path(path))
    if left:
        shown = '; '.join(f'{p} {s} 0x{m:X}' for p, s, m in left[:5])
        raise AclError(f'program files under {install_root} are still writable by non-administrators: {shown}')
    return {'repaired': repaired}


# ---- error 70 (defect fixed 2026-11-17, G_OPTICALS_ERROR70_NGINX_PARENT_LIST_FIX_REPORT.md) ----------
# The 2026-11-17 update stopped at "switch": GTrade-Web, now NT SERVICE\GTrade-Web instead of
# LocalSystem, exited at once with
#   nginx: [emerg] CreateDirectory() "C:/ProgramData/G-TRADE/temp/nginx/client_body" failed (5: Access is denied)
# although the account HAD Modify on temp\nginx. nginx for Windows checks every path it opens or creates
# (ngx_win32_check_filename -> GetLongPathNameW), and GetLongPathNameW looks each 8.3-shaped component
# ("temp", "nginx", "logs", "web", "run") up by LISTING its parent folder. temp, logs and run were
# protected for SYSTEM/Administrators/App only, so the lookup failed before the folder's own grant
# mattered. Fix: every folder between the data root and a path a service is granted gets "List folder"
# for THAT folder only (no inheritance: the names become visible, never the contents of the App's
# files). Reproduced and guarded by tests/test_nginx_service_access.py with the real nginx.exe.
def _ancestors_below(path: Path, top: Path) -> list[Path]:
    """Folders strictly between ``top`` and ``path`` (``top`` excluded, ``path`` excluded)."""
    out, cur = [], Path(path).parent
    while not _same(cur, top) and _is_below(cur, top):
        out.append(cur)
        cur = cur.parent
    return list(reversed(out))


def _is_below(path: Path, top: Path) -> bool:
    try:
        Path(os.path.abspath(path)).relative_to(os.path.abspath(top))
        return True
    except ValueError:
        return False


def service_access_plan(layout, p: dict) -> list[tuple[Path, list[str], str, bool]]:
    """[(path, principals, right, inheritable)] - every grant the services need below the data root.

    * Web: read nginx.conf, mime.types, server.crt/.key, ca.crt; modify logs\\web, logs\\services,
      run\\nginx, temp\\nginx.
    * DB: modify logs\\db (the cluster folder itself is in apply_data_root_policy).
    * both: List (RX, this folder only) on every folder between the data root and those paths."""
    web, db = list(p.get('web') or []), list(p.get('db') or [])
    plan: list[tuple[Path, list[str], str, bool]] = []
    web_dirs = [layout.logs_dir / 'web', layout.logs_dir / 'services', layout.run_dir / 'nginx', layout.temp_dir / 'nginx']
    for d in web_dirs:
        plan.append((d, web, 'M', True))
    plan.append((layout.logs_dir / 'db', db, 'M', True))
    web_files = web_read_files(layout)
    for f in web_files:
        plan.append((f, web, 'R', False))
    listing: dict[str, tuple[Path, list[str]]] = {}
    for targets, who in ((web_dirs + web_files, web), ([layout.logs_dir / 'db'], db)):
        for t in targets:
            for a in _ancestors_below(t, layout.data_root):
                key = os.path.normcase(os.path.abspath(a))
                cur = listing.setdefault(key, (a, []))
                cur[1].extend(x for x in who if x not in cur[1])
    for a, who in listing.values():
        plan.append((a, who, 'RX', False))
    return [e for e in plan if e[1]]


# Groups in every service token (virtual account or NETWORK SERVICE); never Administrators.
SERVICE_TOKEN_GROUPS = ('S-1-1-0', 'S-1-5-32-545', 'S-1-5-6', 'S-1-5-11', 'S-1-5-15', 'S-1-2-0', 'S-1-5-80-0')
# Rights a plan entry must yield. M on a folder: list, traverse, create files and folders.
NEEDED = {'M': 0x1 | 0x2 | 0x4 | 0x20, 'R': 0x1 | 0x80, 'RX': 0x1 | 0x20}


def effective_rights(path: Path, sid: str, groups=SERVICE_TOKEN_GROUPS, deny_only=()) -> int:
    """The access mask Windows would grant a token of ``sid`` + ``groups`` on ``path`` (AuthzAccessCheck
    with MAXIMUM_ALLOWED against the object's real security descriptor: allow AND deny entries,
    inherited or explicit). By SID only, so it works for services that are not registered yet.
    ``deny_only`` groups match DENY entries only - how UAC filters Administrators out of an
    administrator's normal (not elevated) token."""
    ctypes, a, k, *_ = _advapi()
    from ctypes import wintypes
    authz = ctypes.WinDLL('authz', use_last_error=True)

    class LUID(ctypes.Structure):
        _fields_ = [('LowPart', wintypes.DWORD), ('HighPart', wintypes.LONG)]

    class SID_AND_ATTRIBUTES(ctypes.Structure):
        _fields_ = [('Sid', ctypes.c_void_p), ('Attributes', wintypes.DWORD)]

    class REQUEST(ctypes.Structure):
        _fields_ = [('DesiredAccess', wintypes.DWORD), ('PrincipalSelfSid', ctypes.c_void_p),
                    ('ObjectTypeList', ctypes.c_void_p), ('ObjectTypeListLength', wintypes.DWORD),
                    ('OptionalArguments', ctypes.c_void_p)]

    class REPLY(ctypes.Structure):
        _fields_ = [('ResultListLength', wintypes.DWORD), ('GrantedAccessMask', ctypes.POINTER(wintypes.DWORD)),
                    ('SaclEvaluationResults', ctypes.POINTER(wintypes.DWORD)), ('Error', ctypes.POINTER(wintypes.DWORD))]

    P, PP = ctypes.c_void_p, ctypes.POINTER(ctypes.c_void_p)
    authz.AuthzInitializeResourceManager.argtypes = [wintypes.DWORD, P, P, P, wintypes.LPCWSTR, PP]
    authz.AuthzInitializeContextFromSid.argtypes = [wintypes.DWORD, P, P, P, LUID, P, PP]
    authz.AuthzAddSidsToContext.argtypes = [P, ctypes.POINTER(SID_AND_ATTRIBUTES), wintypes.DWORD, P, wintypes.DWORD, PP]
    authz.AuthzAccessCheck.argtypes = [wintypes.DWORD, P, ctypes.POINTER(REQUEST), P, P, P, wintypes.DWORD,
                                       ctypes.POINTER(REPLY), P]
    authz.AuthzFreeContext.argtypes = [P]
    authz.AuthzFreeResourceManager.argtypes = [P]
    for fn in ('AuthzInitializeResourceManager', 'AuthzInitializeContextFromSid', 'AuthzAddSidsToContext',
               'AuthzAccessCheck', 'AuthzFreeContext', 'AuthzFreeResourceManager'):
        getattr(authz, fn).restype = wintypes.BOOL
    owned_sids, rm, ctx, ctx2, sd = [], P(), P(), P(), P()

    def to_sid(text):
        psid = P()
        if not a.ConvertStringSidToSidW(_sid_text(text), ctypes.byref(psid)):
            raise _win_err(f'ConvertStringSidToSid({text})', ctypes.get_last_error(), path)
        owned_sids.append(psid)
        return psid
    try:
        user = to_sid(sid)
        if not authz.AuthzInitializeResourceManager(1, None, None, None, None, ctypes.byref(rm)):  # NO_AUDIT
            raise _win_err('AuthzInitializeResourceManager', ctypes.get_last_error(), path)
        # AUTHZ_SKIP_TOKEN_GROUPS: no directory lookup for the SID; the groups are added explicitly.
        if not authz.AuthzInitializeContextFromSid(2, user, rm, None, LUID(0, 0), None, ctypes.byref(ctx)):
            raise _win_err('AuthzInitializeContextFromSid', ctypes.get_last_error(), path)
        entries = [SID_AND_ATTRIBUTES(to_sid(g), 0x4) for g in groups]                 # SE_GROUP_ENABLED
        entries += [SID_AND_ATTRIBUTES(to_sid(g), 0x10) for g in deny_only]           # SE_GROUP_USE_FOR_DENY_ONLY
        arr = (SID_AND_ATTRIBUTES * len(entries))(*entries)
        if not authz.AuthzAddSidsToContext(ctx, arr, len(entries), None, 0, ctypes.byref(ctx2)):
            raise _win_err('AuthzAddSidsToContext', ctypes.get_last_error(), path)
        dacl = P()
        err = a.GetNamedSecurityInfoW(str(path), _SE_FILE_OBJECT, 0x1 | 0x2 | _DACL_SI, None, None,
                                      ctypes.byref(dacl), None, ctypes.byref(sd))
        if err:
            raise _win_err('GetNamedSecurityInfo', err, path)
        granted, sacl, error = wintypes.DWORD(0), wintypes.DWORD(0), wintypes.DWORD(0)
        req = REQUEST(0x02000000, None, None, 0, None)  # MAXIMUM_ALLOWED
        rep = REPLY(1, ctypes.pointer(granted), ctypes.pointer(sacl), ctypes.pointer(error))
        if not authz.AuthzAccessCheck(0, ctx2, ctypes.byref(req), None, sd, None, 0, ctypes.byref(rep), None):
            raise _win_err('AuthzAccessCheck', ctypes.get_last_error(), path)
        return int(granted.value)
    finally:
        for h in (ctx2, ctx):
            if h.value:
                authz.AuthzFreeContext(h)
        if rm.value:
            authz.AuthzFreeResourceManager(rm)
        if sd.value:
            k.LocalFree(sd)
        for psid in owned_sids:
            k.LocalFree(psid)


def service_access_problems(layout, p: dict, groups=SERVICE_TOKEN_GROUPS) -> list[str]:
    """Every service_access_plan entry the on-disk ACLs do NOT actually honour ([] = all good).
    Run before any service starts under a new account, so a permission defect stops the install or
    update while nothing has changed - not after the database was migrated (the 2026-11-17 error 70)."""
    if _skip():
        return []
    out = []
    checks = []
    for path, who, right, inh in service_access_plan(layout, p):
        try:
            if not path.exists():
                continue
        except PermissionError:
            pass  # cannot even look: let the security-descriptor check below report it
        checks.append((path, who, right))
        if right == 'M' and inh:
            # Existing sub-folders (temp\nginx\client_body, run\nginx\logs ... made by an earlier
            # version) must have inherited the grant; one an old setup protected would fail later.
            try:
                checks += [(Path(e.path), who, 'M') for e in os.scandir(path) if e.is_dir(follow_symlinks=False)]
            except OSError:
                pass
    for path, who, right in checks:
        need = NEEDED[right]
        for principal in who:
            try:
                got = effective_rights(path, principal, groups)
            except AclError as exc:
                out.append(f'{path}: cannot evaluate access for {principal} ({exc})')
                continue
            if got & need != need:
                out.append(f'{path}: {principal} has 0x{got:X}, needs 0x{need:X} ({right})')
    return out


def require_service_access(layout, accounts: dict | None = None, keep_network_service: bool | None = None) -> None:
    problems = service_access_problems(layout, service_principals(accounts, keep_network_service))
    if problems:
        raise AclError('the service accounts cannot use their folders (nothing was started): '
                       + '; '.join(problems[:6]))


def apply_service_access(layout, accounts: dict | None = None, keep_network_service: bool | None = None,
                         install_root: bool = True) -> dict:
    """Additive, file-precise grants for the service accounts (run before services start: nginx.conf
    and the TLS files are re-written by later steps and must stay readable by the web service).

    * install root (program files): its own protected ACL, Read & execute for the three accounts,
      never write (protect_install_root).
    * below the data root: service_access_plan (incl. the parent-folder List grants nginx needs)."""
    if _skip():
        return {'skipped': True}
    p = service_principals(accounts, keep_network_service)
    if install_root:
        protect_install_root(layout.install_root, p['db'] + p['app'] + p['web'])
    for d in (layout.logs_dir / 'web', layout.logs_dir / 'services', layout.run_dir / 'nginx',
              layout.temp_dir / 'nginx', layout.logs_dir / 'db'):
        d.mkdir(parents=True, exist_ok=True)
    for path, who, right, inheritable in service_access_plan(layout, p):
        _grant(path, who, right, inherit=inheritable)
    return {'principals': p}


def apply_data_root_policy(layout, service_account: str | None = None, include_current_user=False,
                           accounts: dict | None = None, keep_network_service: bool | None = None) -> None:
    """Folder policy for the data root (see the module docstring), least privilege per service:

    | folder        | App (NT SERVICE\\GTrade-App) | Web (GTrade-Web)       | DB (GTrade-DB) |
    |---------------|-----------------------------|------------------------|----------------|
    | root, rollback| read                        | read                   | -              |
    | config        | read (gtrade.env, secrets)  | 5 files, read only     | -              |
    | config\\tls    | -                           | server.*, ca.crt read  | -              |
    | pgsql         | -                           | -                      | full           |
    | media         | modify                      | -                      | -              |
    | static        | read                        | read                   | -              |
    | logs          | modify                      | logs\\web, \\services   | logs\\db        |
    | backups       | modify                      | -                      | -              |
    | run, temp     | modify                      | run\\nginx, temp\\nginx | -              |
    | (parents of the Web/DB paths: logs, run, temp, config, config\\tls: List, this folder only)    |
    | updates       | -                           | -                      | -              |
    | client        | (Users: read)               |                        |                |

    ``service_account`` (old single-account API) is accepted for compatibility and added as the App."""
    root = layout.data_root
    admin = [SYSTEM, ADMINISTRATORS]
    p = service_principals(accounts, keep_network_service)
    app, web, db = list(p['app']), p['web'], p['db']
    if service_account and service_account not in app:
        app.append(service_account)
    managed = [root / s for s in MANAGED_SUBDIRS]
    # Service-specific additive grants FIRST, so nothing loses access while the folders are re-protected.
    apply_service_access(layout, accounts, keep_network_service)
    cu = include_current_user
    protect(root, admin, read=app + web, include_current_user=cu, exclude=managed)
    protect(layout.config_dir, admin, read=app, include_current_user=cu, exclude=[layout.tls_dir])
    protect(layout.tls_dir, admin, include_current_user=cu)
    protect(layout.pg_data.parent, admin + db, include_current_user=cu)
    for sub in ('media', 'logs', 'backups', 'run', 'temp'):
        protect(root / sub, admin, modify=app, include_current_user=cu)
    protect(root / 'static', admin, read=app + web, include_current_user=cu)
    protect(root / 'updates', admin, include_current_user=cu)
    protect(root / 'client', admin, read=[USERS], include_current_user=cu)
    # Grants of the pre-2026-11-13 single account (NETWORK SERVICE everywhere) that no longer apply.
    if NETWORK_SERVICE not in app:
        for d in [root, *managed]:
            if not (NETWORK_SERVICE in db and _same(d, layout.pg_data.parent)):
                _remove(d, NETWORK_SERVICE)
    apply_service_access(layout, accounts, keep_network_service, install_root=False)  # files re-created above keep access


def drop_legacy_grants(layout) -> list[str]:
    """After every service is verified running under its own account: remove NETWORK SERVICE from
    the database folders (it kept them only so a rollback could run the old account)."""
    if _skip():
        return []
    from . import services as svc
    if any(svc.same_account(svc.current_account(s), svc.NETWORK_SERVICE) for s in svc.ALL):
        return []
    done = []
    for d in (layout.pg_data.parent, layout.logs_dir / 'db', layout.logs_dir, layout.install_root):
        if d.exists():
            _remove(d, NETWORK_SERVICE)
            done.append(str(d))
    return done


# ---- diagnostics -----------------------------------------------------------------------------------
def access_problem(path: Path, write: bool = False) -> str | None:
    """None when this process can read (and, with ``write``, write) ``path``; otherwise a clear,
    actionable message naming the file, the process identity and the file's ACL."""
    try:
        with open(path, 'r+b' if write else 'rb'):
            pass
        return None
    except FileNotFoundError:
        return None
    except PermissionError as exc:
        from .services import is_elevated
        elevated = is_elevated()
        try:
            acl = describe(path).strip() or '(could not read the ACL)'
        except AclError as acl_exc:
            # A prompt that is not elevated may not even read the ACL of the protected config files.
            acl = f'(could not read the ACL: {acl_exc})' if elevated else '(not readable without elevation)'
        empty = acl.splitlines()[0].strip() == str(path) if acl and not acl.startswith('(') else False
        who = 'an elevated Administrator' if elevated else 'a NON-elevated user'
        if empty:
            hint = ('The file has NO permission entries (empty ACL) - a known defect of earlier G-TRADE setups. '
                    'Run the new setup (or "gtrade-ctl repair-permissions" as Administrator) to repair it.')
        elif not elevated:
            hint = ('Run the command from an elevated Command Prompt ("Run as administrator"): the G-TRADE '
                    'configuration and encrypted secrets are readable only by Administrators, SYSTEM and the '
                    'GTrade-App service, by design. Do not change the folder permissions.')
        else:
            hint = ('Check that no other program holds the file open and that Administrators have Full control '
                    '("gtrade-ctl repair-permissions" re-applies the permissions).')
        return f'Access denied to {path} (running as {who}; {exc.strerror}). {hint} Current ACL: {acl}'
