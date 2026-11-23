"""Generated secrets, stored DPAPI-encrypted on the server machine.

* Secrets are generated with :mod:`secrets` (CSPRNG) **once**, on first install. Repair and
  update never regenerate them (a new ``SECRET_KEY`` would sign everyone out; a new DB password
  would lock the app out of its own database).
* They are written to ``config\\secrets.dpapi``: JSON encrypted with Windows DPAPI in
  *machine* scope (``CRYPTPROTECT_LOCAL_MACHINE``) plus a fixed application entropy, so the
  service accounts can decrypt them but the file is useless on another computer. The file is
  additionally ACL'd to SYSTEM, Administrators and the service account.
* They never appear on a command line, in ``gtrade.env``, in logs or in reports.

On non-Windows hosts (CI, developers) DPAPI is unavailable; the store refuses to run unless
``GTRADE_INSECURE_SECRETS=1`` is set, in which case it writes a clearly marked plaintext file.
That mode exists for automated tests only.
"""

from __future__ import annotations

import base64
import json
import os
import secrets as _secrets
import string
import sys
from pathlib import Path

ENTROPY = b'G-TRADE ERP local edition secrets v1'
CRYPTPROTECT_UI_FORBIDDEN = 0x1
CRYPTPROTECT_LOCAL_MACHINE = 0x4
PLAINTEXT_MARKER = b'GTRADE-INSECURE-TEST-SECRETS\n'

SECRET_NAMES = ('django_secret_key', 'db_app_password', 'db_superuser_password', 'license_store_key')


class SecretsError(RuntimeError):
    pass


# ---- DPAPI via ctypes (no pywin32 dependency) -------------------------------------------------
def _dpapi_available() -> bool:
    return sys.platform == 'win32'


if sys.platform == 'win32':
    import ctypes
    from ctypes import wintypes

    class _BLOB(ctypes.Structure):
        _fields_ = [('cbData', wintypes.DWORD), ('pbData', ctypes.POINTER(ctypes.c_char))]

    _crypt32 = ctypes.WinDLL('crypt32', use_last_error=True)
    _kernel32 = ctypes.WinDLL('kernel32', use_last_error=True)
    _crypt32.CryptProtectData.argtypes = [ctypes.POINTER(_BLOB), wintypes.LPCWSTR, ctypes.POINTER(_BLOB),
                                          ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_BLOB)]
    _crypt32.CryptUnprotectData.argtypes = [ctypes.POINTER(_BLOB), ctypes.c_void_p, ctypes.POINTER(_BLOB),
                                            ctypes.c_void_p, ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_BLOB)]
    _kernel32.LocalFree.argtypes = [ctypes.c_void_p]

    def _blob(data: bytes):
        buf = ctypes.create_string_buffer(data, len(data))
        return _BLOB(len(data), ctypes.cast(buf, ctypes.POINTER(ctypes.c_char))), buf

    def _dpapi(data: bytes, protect: bool, machine: bool = True) -> bytes:
        inp, _keep1 = _blob(data)
        ent, _keep2 = _blob(ENTROPY)
        out = _BLOB()
        flags = CRYPTPROTECT_UI_FORBIDDEN | (CRYPTPROTECT_LOCAL_MACHINE if machine and protect else 0)
        fn = _crypt32.CryptProtectData if protect else _crypt32.CryptUnprotectData
        desc = 'G-TRADE ERP' if protect else None
        ok = fn(ctypes.byref(inp), desc, ctypes.byref(ent), None, None, flags, ctypes.byref(out))
        if not ok:
            raise SecretsError(f'DPAPI {"protect" if protect else "unprotect"} failed (error {ctypes.get_last_error()})')
        try:
            return ctypes.string_at(out.pbData, out.cbData)
        finally:
            _kernel32.LocalFree(ctypes.cast(out.pbData, ctypes.c_void_p))
else:  # pragma: no cover - exercised only off Windows
    def _dpapi(data: bytes, protect: bool, machine: bool = True) -> bytes:
        raise SecretsError('DPAPI is only available on Windows')


def protect(data: bytes) -> bytes:
    return _dpapi(data, True)


def unprotect(data: bytes) -> bytes:
    return _dpapi(data, False)


# ---- generation --------------------------------------------------------------------------------
def generate_password(length: int = 32) -> str:
    # Alphabet without quote, backslash, '%', ':' '@' '/' so the value is safe in libpq
    # connection strings, pgpass files and env files without escaping.
    alphabet = string.ascii_letters + string.digits + '-_.~+!*()'
    return ''.join(_secrets.choice(alphabet) for _ in range(length))


def generate_django_secret_key() -> str:
    return _secrets.token_urlsafe(64)


def generate_all() -> dict:
    return {
        'django_secret_key': generate_django_secret_key(),
        'db_app_password': generate_password(32),
        'db_superuser_password': generate_password(32),
        'license_store_key': base64.b64encode(_secrets.token_bytes(32)).decode(),
    }


# ---- storage -----------------------------------------------------------------------------------
def _insecure_allowed() -> bool:
    return os.environ.get('GTRADE_INSECURE_SECRETS') == '1'


def save(path: Path, values: dict) -> None:
    missing = [n for n in SECRET_NAMES if not values.get(n)]
    if missing:
        raise SecretsError(f'missing secrets: {", ".join(missing)}')
    raw = json.dumps(values, sort_keys=True).encode('utf-8')
    if _dpapi_available() and not _insecure_allowed():
        blob = protect(raw)
    elif _insecure_allowed():
        blob = PLAINTEXT_MARKER + raw
    else:  # pragma: no cover
        raise SecretsError('No secure secret storage available on this platform')
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + '.tmp')
    tmp.write_bytes(blob)
    os.replace(tmp, path)


def load(path: Path) -> dict:
    if not path.exists():
        raise SecretsError(f'secrets file not found: {path}')
    blob = path.read_bytes()
    if blob.startswith(PLAINTEXT_MARKER):
        if not _insecure_allowed():
            raise SecretsError('Refusing to read an insecure test secrets file outside test mode')
        raw = blob[len(PLAINTEXT_MARKER):]
    else:
        raw = unprotect(blob)
    return json.loads(raw.decode('utf-8'))


def protect_bytes(data: bytes) -> bytes:
    """Machine-scope DPAPI (or the marked plaintext test format), for files other than secrets.dpapi
    (the vendor signing key file of the owner's vendor installation)."""
    if _dpapi_available() and not _insecure_allowed():
        return protect(data)
    if _insecure_allowed():
        return PLAINTEXT_MARKER + data
    raise SecretsError('No secure secret storage available on this platform')  # pragma: no cover


def unprotect_file(path: Path) -> bytes:
    blob = Path(path).read_bytes()
    if blob.startswith(PLAINTEXT_MARKER):
        if not _insecure_allowed():
            raise SecretsError('Refusing to read an insecure test secrets file outside test mode')
        return blob[len(PLAINTEXT_MARKER):]
    return unprotect(blob)


def init(path: Path) -> tuple[dict, bool]:
    """Create the secrets file if it does not exist. Never overwrites. Returns (values, created)."""
    if path.exists():
        return load(path), False
    values = generate_all()
    save(path, values)
    return values, True


def rotate(path: Path, name: str, value: str | None = None) -> dict:
    """Replace one secret explicitly (admin action, e.g. after a suspected leak)."""
    if name not in SECRET_NAMES:
        raise SecretsError(f'unknown secret {name!r}')
    values = load(path)
    values[name] = value or (generate_django_secret_key() if name == 'django_secret_key' else generate_password(32))
    save(path, values)
    return values
