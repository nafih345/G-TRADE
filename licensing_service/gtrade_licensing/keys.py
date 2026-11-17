"""Signing key providers.

* DevFileKeyProvider: an Ed25519 key in a local file, key id ``gtl-dev-<n>``. For development and
  tests ONLY: it refuses to run when GTRADE_LICENSING_ENV=production, and customer installations
  accept ``gtl-dev-*`` keys only in dev mode (never in a release build).
* KmsKeyProvider: production. The private key is generated inside the KMS/HSM and never exported;
  ``sign`` calls the KMS. Not wired to any cloud account here: creating the KMS key and account is an
  owner action (D4). Until then it raises with the exact steps.
"""

from __future__ import annotations

import base64
import json
import os
from pathlib import Path


class KeyProviderError(RuntimeError):
    pass


class DevFileKeyProvider:
    def __init__(self, path: Path, key_id: str = 'gtl-dev-1'):
        if os.environ.get('GTRADE_LICENSING_ENV', 'development') == 'production':
            raise KeyProviderError('The development file key is not allowed in production. Configure the KMS provider.')
        if not key_id.startswith('gtl-dev-'):
            raise KeyProviderError('development key ids must start with gtl-dev-')
        from cryptography.hazmat.primitives import serialization
        from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
        self.key_id = key_id
        path = Path(path)
        if path.exists():
            self._key = serialization.load_pem_private_key(path.read_bytes(), password=None)
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            self._key = Ed25519PrivateKey.generate()
            path.write_bytes(self._key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                                     serialization.NoEncryption()))

    def sign(self, data: bytes) -> bytes:
        return self._key.sign(data)

    def public_keys(self) -> dict:
        from cryptography.hazmat.primitives import serialization
        raw = self._key.public_key().public_bytes(serialization.Encoding.Raw, serialization.PublicFormat.Raw)
        return {self.key_id: base64.b64encode(raw).decode('ascii')}

    def export_public(self, path: Path) -> Path:
        Path(path).write_text(json.dumps(self.public_keys(), indent=2), encoding='utf-8')
        return Path(path)


class KmsKeyProvider:
    """Placeholder for the production KMS/HSM signer (owner action required)."""

    def __init__(self, key_id: str, key_ref: str):
        self.key_id = key_id
        self.key_ref = key_ref

    def sign(self, data: bytes) -> bytes:  # pragma: no cover - needs an owner-provisioned KMS
        raise KeyProviderError(
            'KMS signing is not configured. Owner action: create an Ed25519 signing key in the chosen KMS/HSM '
            '(decision D4), grant this service sign-only access, set GTRADE_LICENSING_KMS_KEY, publish the public '
            'key in backend/apps/licensing/keys.py PRODUCTION_KEYS under a new key id, and implement sign() with '
            "the provider's SDK.")

    def public_keys(self) -> dict:  # pragma: no cover
        raise KeyProviderError('KMS provider not configured')


def from_environment(data_dir: Path):
    provider = os.environ.get('GTRADE_LICENSING_KEY_PROVIDER', 'devfile')
    if provider == 'kms':
        return KmsKeyProvider(os.environ['GTRADE_LICENSING_KEY_ID'], os.environ['GTRADE_LICENSING_KMS_KEY'])
    return DevFileKeyProvider(Path(data_dir) / 'dev-signing-key.pem', os.environ.get('GTRADE_LICENSING_KEY_ID', 'gtl-dev-1'))
