"""Licence / CRL wire format, signing side. Must stay byte-compatible with
backend/apps/licensing/licfmt.py (cross-checked by tests/test_service.py)."""

from __future__ import annotations

import base64
import json

LICENSE_PREFIX = 'GTL1'
CRL_PREFIX = 'GTC1'


def b64u(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def b64u_decode(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + '=' * (-len(text) % 4))


def encode(payload: dict, prefix: str, signer) -> str:
    """signer(bytes) -> 64-byte Ed25519 signature; payload must carry its key_id."""
    if 'key_id' not in payload:
        raise ValueError('payload needs key_id')
    body = b64u(json.dumps(payload, sort_keys=True, separators=(',', ':')).encode('utf-8'))
    signed = f'{prefix}.{body}'.encode('ascii')
    return f'{prefix}.{body}.{b64u(signer(signed))}'


def decode_unverified(blob: str) -> dict:
    return json.loads(b64u_decode(blob.split('.')[1]))
