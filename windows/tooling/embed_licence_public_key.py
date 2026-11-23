"""Embed the vendor's PRODUCTION licence public key in the Windows build, after proving it matches.

    python windows/tooling/embed_licence_public_key.py --key-id gtl-prod-2026a --public-key <base64>
        [--authority https://g-trade-backend.onrender.com/api/licence-authority] [--file <json>]

Only a PUBLIC key is ever handled here. Before writing backend/apps/licensing/vendor_public_keys.json
the tool proves that this public key belongs to the private key the production licence authority
really signs with:
  1. GET <authority>/v1/health must report signing enabled with exactly this key id;
  2. GET <authority>/v1/crl must return a revocation list whose Ed25519 signature verifies with this
     public key (a CRL is signed fresh on every request, so it can only come from that private key).
Development key ids (gtl-dev-*) and malformed keys are refused. Existing entries are kept (rotation).

The OWNER's Windows vendor installation key (`gtrade-ctl vendor-key generate`, offline issuing by the
Local Super Admin) is proven instead with the proof token that command prints:

    python windows/tooling/embed_licence_public_key.py --key-id gtl-vendor-2026a --public-key <base64> --proof GTP1....

The proof is a statement signed by that installation's private key (gtrade_ctl/vendor_key.py), so
only the holder of the private key can produce it; no network is involved.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import re
import ssl
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
KEYS_FILE = ROOT / 'backend' / 'apps' / 'licensing' / 'vendor_public_keys.json'
PRODUCTION_AUTHORITY = 'https://g-trade-backend.onrender.com/api/licence-authority'
KEY_ID_RE = re.compile(r'^gtl-[a-z0-9][a-z0-9-]{1,40}$')


class EmbedError(RuntimeError):
    pass


def _get(url: str, timeout=90) -> dict:
    ctx = ssl.create_default_context() if url.startswith('https://') else None
    req = urllib.request.Request(url, headers={'User-Agent': 'G-OPTICALS-release'})
    with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
        return json.loads(resp.read().decode('utf-8'))


def _b64u(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def check_public_key(key_id: str, public_key: str) -> bytes:
    if not KEY_ID_RE.match(key_id or ''):
        raise EmbedError('key id must look like gtl-prod-2026a')
    if key_id.startswith('gtl-dev-'):
        raise EmbedError('a development key (gtl-dev-*) is never embedded in a release')
    try:
        raw = base64.b64decode(public_key, validate=True)
    except (binascii.Error, ValueError):
        raise EmbedError('the public key is not valid base64')
    if len(raw) != 32:
        raise EmbedError('an Ed25519 public key is 32 bytes')
    if b'PRIVATE' in public_key.encode() or public_key.strip().startswith('-----'):
        raise EmbedError('that looks like a private key; never paste the private key here')
    return raw


def prove_against_authority(key_id: str, raw: bytes, authority: str, *, _insecure_for_tests=False) -> dict:
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
    authority = authority.rstrip('/')
    if not _insecure_for_tests and (not authority.startswith('https://') or 'localhost' in authority
                                    or '127.0.0.1' in authority):
        raise EmbedError('the production licence authority must be an https URL on the real domain')
    health = _get(f'{authority}/v1/health')
    if not health.get('signing'):
        raise EmbedError(f'the authority at {authority} has no signing key configured yet')
    if health.get('key_id') != key_id:
        raise EmbedError(f'the authority signs with {health.get("key_id")!r}, not {key_id!r}')
    crl = (_get(f'{authority}/v1/crl') or {}).get('crl') or ''
    parts = crl.split('.')
    if len(parts) != 3 or parts[0] != 'GTC1':
        raise EmbedError('the authority did not return a signed revocation list')
    payload = json.loads(_b64u(parts[1]))
    if payload.get('key_id') != key_id:
        raise EmbedError('the revocation list names another key id')
    try:
        Ed25519PublicKey.from_public_bytes(raw).verify(_b64u(parts[2]), f'{parts[0]}.{parts[1]}'.encode('ascii'))
    except InvalidSignature:
        raise EmbedError('the production signature does NOT verify with this public key: wrong key, not embedded')
    return {'authority': authority, 'key_id': key_id, 'crl_issued_at': payload.get('issued_at'),
            'revoked_entries': len(payload.get('revoked') or [])}


def prove_with_token(key_id: str, public_key: str, token: str) -> dict:
    sys.path.insert(0, str(ROOT / 'windows'))
    from gtrade_ctl import vendor_key
    try:
        payload = vendor_key.verify_proof(token, key_id, public_key)
    except vendor_key.VendorKeyError as exc:
        raise EmbedError(f'the vendor key proof does not verify: {exc}')
    return {'proved_by': 'vendor installation proof', 'proof_issued_at': payload.get('issued_at'),
            'vendor_install_id': payload.get('install_id')}


def embed(key_id: str, public_key: str, authority: str = PRODUCTION_AUTHORITY, keys_file: Path = KEYS_FILE,
          *, proof_token: str = '', _insecure_for_tests=False) -> dict:
    raw = check_public_key(key_id, public_key)
    if proof_token:
        proof = prove_with_token(key_id, base64.b64encode(raw).decode('ascii'), proof_token)
    else:
        proof = prove_against_authority(key_id, raw, authority, _insecure_for_tests=_insecure_for_tests)
    current = json.loads(keys_file.read_text(encoding='utf-8') or '{}') if keys_file.exists() else {}
    current = {k: v for k, v in current.items() if not k.startswith('gtl-dev-')}
    current[key_id] = base64.b64encode(raw).decode('ascii')
    keys_file.write_text(json.dumps(dict(sorted(current.items())), indent=2) + '\n', encoding='utf-8')
    return {'written': str(keys_file), 'key_ids': sorted(current), **proof}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--key-id', required=True)
    ap.add_argument('--public-key', required=True, help='base64 of the raw 32-byte Ed25519 public key')
    ap.add_argument('--authority', default=PRODUCTION_AUTHORITY)
    ap.add_argument('--file', default=str(KEYS_FILE))
    ap.add_argument('--proof', default='', help='GTP1 proof from `gtrade-ctl vendor-key status` (Windows vendor key)')
    a = ap.parse_args(argv)
    try:
        out = embed(a.key_id.strip(), a.public_key.strip(), a.authority, Path(a.file), proof_token=a.proof.strip())
    except (EmbedError, OSError, ValueError) as exc:
        print(json.dumps({'ok': False, 'error': str(exc)}))
        return 1
    print(json.dumps({'ok': True, **out}, indent=2))
    return 0


if __name__ == '__main__':
    sys.exit(main())
