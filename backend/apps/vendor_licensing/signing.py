"""The vendor's licence signing key (cloud licence authority only).

The Ed25519 PRIVATE key exists only on the vendor-controlled server, supplied by the host's secret
store, never by the repository, the frontend or a customer installation:

    GTRADE_LICENSE_SIGNING_KEY_ID     key id, e.g. gtl-prod-2026a (gtl-dev-* only in DEBUG / tests)
    GTRADE_LICENSE_SIGNING_KEY        PKCS#8 PEM, or base64 of the raw 32-byte private seed
    GTRADE_LICENSE_SIGNING_KEY_FILE   ... or a path to a PEM file (e.g. a Render secret file)
    GTRADE_LICENSE_VERIFY_KEYS        optional JSON {key_id: base64 public key} of RETIRED keys, so
                                      licences signed before a rotation still verify here

Windows Local vendor installation (the owner's Local Super Admin PC): `gtrade-ctl vendor-key
generate` stores the key DPAPI-encrypted (machine scope, ACL'd to SYSTEM / Administrators / the
service account) in config/license/vendor-signing.dpapi; settings_local points
GTRADE_LICENSE_SIGNING_KEY_FILE at it. On a Windows installation a key signs ONLY if its public half
is one of the keys this build trusts (vendor_public_keys.json), so it never issues keys that customer
installations would reject. A customer installation has no such file: it can verify, never issue.

`manage.py licence_signing_key generate` makes a new key pair (owner action, on the vendor host).
Its public half goes into backend/apps/licensing/vendor_public_keys.json, which the Windows build
embeds. Rotation: publish the new public key in a release first, then switch KEY_ID/KEY here.
Nothing in this module ever returns or logs the private key.
"""

from __future__ import annotations

import base64
import json
import threading
from pathlib import Path

from django.conf import settings

from apps.licensing import keys as trusted, licfmt

_lock = threading.Lock()
_cache: tuple | None = None


class SigningKeyError(RuntimeError):
    """The authority cannot sign: not configured, or configured unsafely."""


def _setting(name: str) -> str:
    return str(getattr(settings, name, '') or '').strip()


def _development_allowed() -> bool:
    return bool(getattr(settings, 'DEBUG', False) or getattr(settings, 'RUNNING_TESTS', False))


def _load():
    global _cache
    key_id = _setting('GTRADE_LICENSE_SIGNING_KEY_ID')
    raw = _setting('GTRADE_LICENSE_SIGNING_KEY')
    path = _setting('GTRADE_LICENSE_SIGNING_KEY_FILE')
    marker = (key_id, raw, path)
    with _lock:
        if _cache and _cache[0] == marker:
            return _cache[1], _cache[2]
    if path and not raw and path.lower().endswith('.dpapi'):
        key_id, raw = _read_protected(Path(path), key_id)
    if not key_id or not (raw or path):
        raise SigningKeyError('Licence signing is not configured on this server. Owner action: run '
                              '`manage.py licence_signing_key generate` on the vendor server and set '
                              'GTRADE_LICENSE_SIGNING_KEY_ID and GTRADE_LICENSE_SIGNING_KEY (or _FILE) in its '
                              'secret settings.')
    if not trusted.KEY_ID_RE.match(key_id):
        raise SigningKeyError('GTRADE_LICENSE_SIGNING_KEY_ID must look like gtl-prod-2026a.')
    if trusted.is_dev_key(key_id) and not _development_allowed():
        raise SigningKeyError('A development signing key (gtl-dev-*) cannot sign licences on a production server.')
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    try:
        if path and not raw:
            raw = Path(path).read_text(encoding='utf-8').strip()
        if raw.startswith('-----BEGIN'):
            key = serialization.load_pem_private_key(raw.encode('ascii'), password=None)
        else:
            key = Ed25519PrivateKey.from_private_bytes(base64.b64decode(raw, validate=True))
    except Exception as exc:  # never echo the value
        raise SigningKeyError(f'The licence signing key could not be loaded ({type(exc).__name__}).')
    if not isinstance(key, Ed25519PrivateKey):
        raise SigningKeyError('The licence signing key must be an Ed25519 key.')
    if _local_edition():
        _require_trusted(key_id, key)
    with _lock:
        _cache = (marker, key_id, key)
    return key_id, key


def _local_edition() -> bool:
    return getattr(settings, 'GTRADE_EDITION', '') == 'local'


def _read_protected(path: Path, key_id: str) -> tuple[str, str]:
    """(key id, base64 seed) from the vendor installation's DPAPI-protected key file."""
    if not path.exists():
        raise SigningKeyError('This installation has no vendor signing key (customer installations never have '
                              'one). Owner action on the vendor PC: gtrade-ctl vendor-key generate.')
    try:
        from gtrade_ctl import secrets_store
        data = json.loads(secrets_store.unprotect_file(path).decode('utf-8'))
        return str(data['key_id']), str(data['private_key'])
    except Exception as exc:  # never echo the value
        raise SigningKeyError(f'The vendor signing key file could not be read on this computer ({type(exc).__name__}).')


def _require_trusted(key_id: str, key) -> None:
    """Windows vendor installation: sign only with a key this build ships as trusted."""
    from cryptography.hazmat.primitives import serialization
    pub = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw,
                                                         serialization.PublicFormat.Raw)).decode('ascii')
    shipped = trusted.trusted_keys()
    if shipped.get(key_id) != pub:
        raise SigningKeyError(f'The vendor signing key {key_id} is not yet trusted by this G-OPTICALS build, so '
                              'licences it signs would be refused by customer installations. Build and install the '
                              'release that embeds its public key (windows/tooling/finalize_release.py).')


def reset_cache():
    global _cache
    with _lock:
        _cache = None


def status() -> dict:
    """For the console: is signing available, with which key (never the key itself)."""
    try:
        key_id, _ = _load()
    except SigningKeyError as exc:
        return {'configured': False, 'key_id': '', 'development': False, 'message': str(exc)}
    return {'configured': True, 'key_id': key_id, 'development': trusted.is_dev_key(key_id),
            'public_key': public_key_b64(), 'message': ''}


def key_id() -> str:
    return _load()[0]


def public_key_b64() -> str:
    from cryptography.hazmat.primitives import serialization
    _, key = _load()
    raw = key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
    return base64.b64encode(raw).decode('ascii')


def verify_keys() -> dict:
    """Public keys this authority accepts when it reads back a licence: the current signing key,
    retired keys (GTRADE_LICENSE_VERIFY_KEYS) and the keys shipped to customers."""
    out = dict(trusted.production_keys())
    extra = _setting('GTRADE_LICENSE_VERIFY_KEYS')
    if extra:
        try:
            for k, v in json.loads(extra).items():
                if trusted.KEY_ID_RE.match(k) and (not trusted.is_dev_key(k) or _development_allowed()):
                    out[k] = v
        except ValueError:
            raise SigningKeyError('GTRADE_LICENSE_VERIFY_KEYS is not valid JSON.')
    try:
        out[key_id()] = public_key_b64()
    except SigningKeyError:
        pass
    return out


def sign_token(payload: dict) -> str:
    kid, key = _load()
    return licfmt.encode({**payload, 'key_id': kid}, licfmt.LICENSE_PREFIX, key.sign)


def sign_crl(payload: dict) -> str:
    kid, key = _load()
    return licfmt.encode({**payload, 'key_id': kid}, licfmt.CRL_PREFIX, key.sign)


def verify_token(token: str) -> dict:
    """Payload of a licence this authority (or a previous key of it) signed; raises
    licfmt.LicenseFormatError otherwise."""
    return licfmt.verify(licfmt.normalize_key(token), licfmt.LICENSE_PREFIX, verify_keys())


def generate_keypair() -> tuple[str, str]:
    """(private PKCS#8 PEM, public base64). Used only by the owner's key ceremony command."""
    from cryptography.hazmat.primitives import serialization
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key = Ed25519PrivateKey.generate()
    pem = key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                            serialization.NoEncryption()).decode('ascii')
    pub = base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw,
                                                         serialization.PublicFormat.Raw)).decode('ascii')
    return pem, pub
