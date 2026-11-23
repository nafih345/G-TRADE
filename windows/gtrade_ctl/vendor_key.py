"""The vendor licence signing key of the OWNER's Windows installation (Local Super Admin PC).

Only the vendor-owner installation ever has this file; a customer installation has none and can
only verify licences with the public keys embedded in its build.

    config\\license\\vendor-signing.dpapi
        Machine-scope DPAPI of JSON {key_id, private_key (base64 Ed25519 seed), created_at}, created
        with a protected DACL: SYSTEM, Administrators and the application service account only.
        Useless on another computer; never printed, logged, backed up into the database or bundled.

The private key never leaves this module except inside a GTKB1 backup (`export`): the owner's
disaster-recovery copy, safe to keep in cloud storage (e.g. Google Drive) because it is useless
without the passphrase, which is never stored with it:

    {"format": "GTKB1", "key_id", "public_key", "created_at",
     "kdf": {"name": "scrypt", "n": 131072, "r": 8, "p": 1, "salt": <16 random bytes>},
     "cipher": {"name": "AES-256-GCM", "nonce": <12 random bytes>},
     "ciphertext": AES-256-GCM(scrypt(passphrase), 32-byte Ed25519 seed, AAD = every other field)}

Every field except the ciphertext is authenticated (AAD), so changing the key id, public key, KDF
settings or anything else makes decryption fail; only exactly these scrypt settings are accepted
(no downgrade). A decrypted key is accepted only if its public key equals the one in the header.
`verify_backup` proves a copy decrypts to the installed key without writing anything;
`import_encrypted` restores onto a PC that has no key yet (never overwrites).

A proof token ``GTP1.<b64url payload>.<b64url signature>`` (domain-separated from licences and
revocation lists, so it can never be used as either) lets the release tool check that a public key
really belongs to this installation's private key before embedding it in the customer build.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import re
from pathlib import Path

FILE_NAME = 'vendor-signing.dpapi'
PROOF_PREFIX = 'GTP1'
KEY_ID_RE = re.compile(r'^gtl-[a-z0-9][a-z0-9-]{1,40}$')


class VendorKeyError(RuntimeError):
    pass


def key_path(layout) -> Path:
    return layout.license_dir / FILE_NAME


def _b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _b64u_dec(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def public_b64(key) -> str:
    from cryptography.hazmat.primitives import serialization
    return base64.b64encode(key.public_key().public_bytes(serialization.Encoding.Raw,
                                                          serialization.PublicFormat.Raw)).decode('ascii')


def _seed(key) -> str:
    from cryptography.hazmat.primitives import serialization
    return base64.b64encode(key.private_bytes(serialization.Encoding.Raw, serialization.PrivateFormat.Raw,
                                              serialization.NoEncryption())).decode('ascii')


def _check_key_id(key_id: str) -> str:
    key_id = (key_id or '').strip()
    if not KEY_ID_RE.match(key_id):
        raise VendorKeyError('--key-id must look like gtl-vendor-2026a (lower case letters, digits, dashes).')
    if key_id.startswith('gtl-dev-'):
        raise VendorKeyError('gtl-dev-* key ids are development keys; choose a production key id.')
    return key_id


def _write(path: Path, key_id: str, key, principals: list[str]) -> None:
    from . import secrets_store, winacl
    if path.exists():
        raise VendorKeyError(f'{path} already exists. The vendor signing key is never replaced silently: '
                             'customer installations trust it. Rotation is a planned release step.')
    path.parent.mkdir(parents=True, exist_ok=True)
    body = json.dumps({'key_id': key_id, 'private_key': _seed(key),
                       'created_at': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()})
    winacl.create_private_file(path, secrets_store.protect_bytes(body.encode('utf-8')), principals)


def load(path: Path):
    """(key_id, Ed25519PrivateKey)."""
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from . import secrets_store
    if not path.exists():
        raise VendorKeyError('This installation has no vendor signing key.')
    try:
        data = json.loads(secrets_store.unprotect_file(path).decode('utf-8'))
        return data['key_id'], Ed25519PrivateKey.from_private_bytes(base64.b64decode(data['private_key']))
    except VendorKeyError:
        raise
    except Exception as exc:
        raise VendorKeyError(f'The vendor signing key file cannot be read on this computer ({type(exc).__name__}).')


def proof(key_id: str, key, install_id: str = '') -> str:
    payload = {'purpose': 'vendor-signing-key-proof', 'key_id': key_id, 'public_key': public_b64(key),
               'install_id': install_id,
               'issued_at': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat()}
    body = _b64u(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8'))
    return f'{PROOF_PREFIX}.{body}.{_b64u(key.sign(f"{PROOF_PREFIX}.{body}".encode("ascii")))}'


def verify_proof(token: str, key_id: str, public_key: str) -> dict:
    """Payload of a proof made by the private half of `public_key`; raises VendorKeyError."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    parts = ''.join((token or '').split()).split('.')
    if len(parts) != 3 or parts[0] != PROOF_PREFIX:
        raise VendorKeyError('not a vendor key proof (it starts with GTP1)')
    try:
        payload = json.loads(_b64u_dec(parts[1]).decode('utf-8'))
        Ed25519PublicKey.from_public_bytes(base64.b64decode(public_key)).verify(
            _b64u_dec(parts[2]), f'{parts[0]}.{parts[1]}'.encode('ascii'))
    except InvalidSignature:
        raise VendorKeyError('the proof was not signed by this public key')
    except Exception as exc:
        raise VendorKeyError(f'damaged proof ({type(exc).__name__})')
    if payload.get('purpose') != 'vendor-signing-key-proof' or payload.get('key_id') != key_id \
            or payload.get('public_key') != public_key:
        raise VendorKeyError('the proof is for another key')
    return payload


def generate(path: Path, key_id: str, principals: list[str]) -> dict:
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    key_id = _check_key_id(key_id)
    key = Ed25519PrivateKey.generate()
    _write(path, key_id, key, principals)
    return {'key_id': key_id, 'public_key': public_b64(key)}


BACKUP_FORMAT = 'GTKB1'
SCRYPT = {'n': 2 ** 17, 'r': 8, 'p': 1}      # 128 MiB per guess: costly for GPU / ASIC guessing
MIN_PASSPHRASE = 16


def _aad(header: dict) -> bytes:
    return json.dumps(header, sort_keys=True, separators=(',', ':')).encode('utf-8')


def _derive(passphrase: str, salt: bytes) -> bytes:
    from cryptography.hazmat.primitives.kdf.scrypt import Scrypt
    return Scrypt(salt=salt, length=32, **SCRYPT).derive(passphrase.encode('utf-8'))


def _check_passphrase(passphrase: str) -> None:
    if len(passphrase or '') < MIN_PASSPHRASE:
        raise VendorKeyError(f'Use a backup passphrase of at least {MIN_PASSPHRASE} characters '
                             '(5 or 6 random words are best).')


def encrypt_backup(key_id: str, key, passphrase: str) -> bytes:
    """GTKB1 backup bytes for an Ed25519 private key (see the module docstring)."""
    import os
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    _check_passphrase(passphrase)
    salt, nonce = os.urandom(16), os.urandom(12)
    header = {'format': BACKUP_FORMAT, 'key_id': key_id, 'public_key': public_b64(key),
              'created_at': dt.datetime.now(dt.timezone.utc).replace(microsecond=0).isoformat(),
              'kdf': {'name': 'scrypt', **SCRYPT, 'salt': base64.b64encode(salt).decode('ascii')},
              'cipher': {'name': 'AES-256-GCM', 'nonce': base64.b64encode(nonce).decode('ascii')}}
    seed = base64.b64decode(_seed(key))
    ct = AESGCM(_derive(passphrase, salt)).encrypt(nonce, seed, _aad(header))
    return (json.dumps({**header, 'ciphertext': base64.b64encode(ct).decode('ascii')}, indent=1) + '\n').encode('ascii')


def decrypt_backup(data: bytes, passphrase: str):
    """(key_id, Ed25519PrivateKey, header). Raises VendorKeyError without revealing anything."""
    from cryptography.exceptions import InvalidTag
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    try:
        doc = json.loads(data.decode('utf-8'))
        ct = base64.b64decode(doc.pop('ciphertext'), validate=True)
        header = doc
        kdf, cipher = header['kdf'], header['cipher']
        salt = base64.b64decode(kdf['salt'], validate=True)
        nonce = base64.b64decode(cipher['nonce'], validate=True)
        ok = (header.get('format') == BACKUP_FORMAT and kdf.get('name') == 'scrypt'
              and {k: kdf.get(k) for k in SCRYPT} == SCRYPT and cipher.get('name') == 'AES-256-GCM'
              and len(salt) == 16 and len(nonce) == 12 and len(ct) == 48)
    except Exception:
        raise VendorKeyError('This is not a G-OPTICALS vendor key backup (GTKB1) file, or it is damaged.')
    if not ok:
        raise VendorKeyError('Unsupported or altered backup settings; refusing to use this file.')
    key_id = _check_key_id(str(header.get('key_id') or ''))
    try:
        seed = AESGCM(_derive(passphrase or '', salt)).decrypt(nonce, ct, _aad(header))
    except InvalidTag:
        raise VendorKeyError('Wrong passphrase, or the backup file was altered.')
    key = Ed25519PrivateKey.from_private_bytes(seed)
    if public_b64(key) != header.get('public_key'):
        raise VendorKeyError('The backup does not match its own public key; refusing to use it.')
    return key_id, key, header


def export_encrypted(path: Path, passphrase: str) -> bytes:
    """GTKB1 backup of the installed key, decrypted again in memory and compared with the installed
    public key before it is returned (a backup that cannot be restored is never handed out)."""
    key_id, key = load(path)
    data = encrypt_backup(key_id, key, passphrase)
    check_id, check_key, _ = decrypt_backup(data, passphrase)
    if (check_id, public_b64(check_key)) != (key_id, public_b64(key)):  # pragma: no cover - defensive
        raise VendorKeyError('The backup failed its own verification; nothing was written.')
    return data


def verify_backup(data: bytes, passphrase: str, installed_path: Path | None = None) -> dict:
    """Decrypt in memory only and compare with the header and (if present) the installed key.
    Returns public information only; writes nothing."""
    key_id, key, header = decrypt_backup(data, passphrase)
    out = {'key_id': key_id, 'public_key': public_b64(key), 'created_at': header.get('created_at'),
           'decrypts': True, 'matches_backup_header': True, 'matches_installed_key': None}
    if installed_path is not None and Path(installed_path).exists():
        inst_id, inst_key = load(installed_path)
        out['installed_key_id'] = inst_id
        out['matches_installed_key'] = (inst_id, public_b64(inst_key)) == (key_id, out['public_key'])
    return out


def import_encrypted(path: Path, data: bytes, passphrase: str, principals: list[str]) -> dict:
    """Restore a GTKB1 backup onto an installation that has NO vendor key (never overwrites)."""
    if path.exists():
        raise VendorKeyError(f'{path} already exists. A vendor signing key is never overwritten.')
    key_id, key, _ = decrypt_backup(data, passphrase)
    _write(path, key_id, key, principals)
    return {'key_id': key_id, 'public_key': public_b64(key)}
