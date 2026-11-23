"""Vendor public keys trusted for licence verification.

PRODUCTION keys come from the vendor's key ceremony (ARCHITECTURE_DECISION_REGISTER.md D4): the
Ed25519 private key is generated on the vendor-controlled licence authority (the cloud console,
apps/vendor_licensing, `manage.py licence_signing_key generate`) and never leaves it; only the PUBLIC
key (base64 of the 32 raw bytes) is published, with its key id, in ``vendor_public_keys.json`` next
to this file (or PRODUCTION_KEYS below). The file is EMPTY until that ceremony happens. Until then
only development licences can be verified, and only in dev mode.

Key rotation: add the new public key under a new key id and ship it, THEN switch the authority to
sign with it. Licences signed by the old key keep verifying until its entry is removed in a later
release (after every customer has received a re-signed licence).

Development keys:
* key ids must start with ``gtl-dev-``;
* they are read from GTRADE_LICENSE_DEV_PUBKEYS (a JSON file {key_id: base64}) written by the
  development licensing service, never from this source file;
* they are refused whenever dev mode is off, and dev mode itself is refused in a release build.
"""

from __future__ import annotations

import base64
import binascii
import json
import re
from pathlib import Path

from django.conf import settings
from django.core.exceptions import ImproperlyConfigured

# key_id -> base64(raw 32-byte Ed25519 public key). Prefer vendor_public_keys.json (one place for
# the release pipeline / key ceremony); entries here are merged with it.
PRODUCTION_KEYS: dict[str, str] = {}

PUBLIC_KEYS_FILE = Path(__file__).with_name('vendor_public_keys.json')
DEV_PREFIX = 'gtl-dev-'
KEY_ID_RE = re.compile(r'^gtl-[a-z0-9][a-z0-9-]{1,40}$')


def _valid_public_key(value) -> bool:
    try:
        return isinstance(value, str) and len(base64.b64decode(value, validate=True)) == 32
    except (binascii.Error, ValueError):
        return False


def production_keys() -> dict[str, str]:
    """Shipped (public) production keys. A malformed file is a release defect: fail closed."""
    keys = dict(PRODUCTION_KEYS)
    if PUBLIC_KEYS_FILE.exists():
        try:
            data = json.loads(PUBLIC_KEYS_FILE.read_text(encoding='utf-8') or '{}')
        except ValueError as exc:
            raise ImproperlyConfigured(f'{PUBLIC_KEYS_FILE.name} is not valid JSON: {exc}')
        if not isinstance(data, dict):
            raise ImproperlyConfigured(f'{PUBLIC_KEYS_FILE.name} must be an object of key id -> public key')
        keys.update(data)
    out = {}
    for key_id, value in keys.items():
        if key_id.startswith(DEV_PREFIX):
            continue  # a development key is never a production key, wherever it was written
        if not KEY_ID_RE.match(key_id) or not _valid_public_key(value):
            raise ImproperlyConfigured(f'Invalid vendor public key entry {key_id!r}')
        out[key_id] = value
    return out


def dev_mode() -> bool:
    on = bool(getattr(settings, 'GTRADE_LICENSE_DEV_MODE', False))
    if on and getattr(settings, 'GTRADE_RELEASE_BUILD', False):
        raise ImproperlyConfigured('Development licensing cannot be enabled in a release build.')
    return on


def trusted_keys() -> dict[str, str]:
    keys = production_keys()
    if dev_mode():
        path = getattr(settings, 'GTRADE_LICENSE_DEV_PUBKEYS', '') or ''
        if path and Path(path).exists():
            for k, v in json.loads(Path(path).read_text(encoding='utf-8')).items():
                if k.startswith(DEV_PREFIX):
                    keys[k] = v
    return keys


def is_dev_key(key_id: str | None) -> bool:
    return bool(key_id and key_id.startswith(DEV_PREFIX))
