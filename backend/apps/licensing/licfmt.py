"""Licence and CRL wire format (verification side). Mirrors licensing_service/gtrade_licensing/format.py.

    licence = "GTL1." + b64url(payload JSON) + "." + b64url(Ed25519 signature over b"GTL1." + payload_b64)
    crl     = "GTC1." + b64url(payload JSON) + "." + b64url(Ed25519 signature over b"GTC1." + payload_b64)

The prefix is part of the signed bytes (domain separation), so a CRL can never be replayed as a licence
or the other way round. Only public keys are ever present on a customer installation.
"""

from __future__ import annotations

import base64
import json

LICENSE_PREFIX = 'GTL1'
CRL_PREFIX = 'GTC1'
MAX_BLOB = 64 * 1024


class LicenseFormatError(ValueError):
    pass


def b64u_decode(text: str) -> bytes:
    pad = '=' * (-len(text) % 4)
    return base64.urlsafe_b64decode(text + pad)


def b64u_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def split(blob: str, prefix: str) -> tuple[bytes, bytes, dict]:
    blob = (blob or '').strip()
    if len(blob) > MAX_BLOB:
        raise LicenseFormatError('licence file too large')
    parts = blob.split('.')
    if len(parts) != 3 or parts[0] != prefix:
        raise LicenseFormatError('not a G-TRADE licence file' if prefix == LICENSE_PREFIX else 'not a G-TRADE CRL')
    try:
        payload_bytes = b64u_decode(parts[1])
        signature = b64u_decode(parts[2])
        payload = json.loads(payload_bytes.decode('utf-8'))
    except Exception as exc:
        raise LicenseFormatError(f'corrupt licence file ({type(exc).__name__})')
    if not isinstance(payload, dict):
        raise LicenseFormatError('corrupt licence payload')
    signed = f'{parts[0]}.{parts[1]}'.encode('ascii')
    return signed, signature, payload


def verify(blob: str, prefix: str, trusted_keys: dict) -> dict:
    """Return the payload if the signature verifies with the key named in it; raise otherwise."""
    from cryptography.exceptions import InvalidSignature
    from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

    signed, signature, payload = split(blob, prefix)
    key_id = payload.get('key_id')
    raw = trusted_keys.get(key_id)
    if not raw:
        raise LicenseFormatError(f'licence signed by an unknown key ({key_id!r})')
    try:
        Ed25519PublicKey.from_public_bytes(base64.b64decode(raw)).verify(signature, signed)
    except InvalidSignature:
        raise LicenseFormatError('licence signature is not valid (file altered or not issued by the vendor)')
    return payload
