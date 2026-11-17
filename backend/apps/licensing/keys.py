"""Vendor public keys trusted for licence verification.

PRODUCTION keys come from the vendor's key ceremony (ARCHITECTURE_DECISION_REGISTER.md D4): the
Ed25519 private key is generated inside the licensing service's KMS/HSM and never exported; only the
public key (base64 of the 32 raw bytes) is pasted here, with its key id. The dict is EMPTY until
that ceremony happens. Until then only development licences can be verified, and only in dev mode.

Development keys:
* key ids must start with ``gtl-dev-``;
* they are read from GTRADE_LICENSE_DEV_PUBKEYS (a JSON file {key_id: base64}) written by the
  development licensing service, never from this source file;
* they are refused whenever dev mode is off, and dev mode itself is refused in a release build.
"""

from __future__ import annotations

import json
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

# key_id -> base64(raw 32-byte Ed25519 public key). Filled at the production key ceremony.
PRODUCTION_KEYS: dict[str, str] = {}

DEV_PREFIX = 'gtl-dev-'


def dev_mode() -> bool:
    on = bool(getattr(settings, 'GTRADE_LICENSE_DEV_MODE', False))
    if on and getattr(settings, 'GTRADE_RELEASE_BUILD', False):
        raise ImproperlyConfigured('Development licensing cannot be enabled in a release build.')
    return on


def trusted_keys() -> dict[str, str]:
    keys = {k: v for k, v in PRODUCTION_KEYS.items() if not k.startswith(DEV_PREFIX)}
    if dev_mode():
        path = getattr(settings, 'GTRADE_LICENSE_DEV_PUBKEYS', '') or ''
        if path and Path(path).exists():
            for k, v in json.loads(Path(path).read_text(encoding='utf-8')).items():
                if k.startswith(DEV_PREFIX):
                    keys[k] = v
    return keys


def is_dev_key(key_id: str | None) -> bool:
    return bool(key_id and key_id.startswith(DEV_PREFIX))
