"""The vendor's own installation is ALWAYS entitled: permanent platform-owner licence, automatically.

Root cause this fixes (2026-11-19): the platform-owner licence existed only after the Local Super
Admin pressed "Activate permanent platform-owner licence" on Licence Details. Until then the owner's
installation held no licence at all, so `state.evaluate` returned the generic 30-day EVALUATION
verdict ("Evaluation: 23 days left. Activate a licence to continue after the evaluation period.")
on every page, exactly like an unlicensed customer.

Now `state.current()` calls `ensure()` whenever the verdict says this installation needs an owner
licence. `ensure()` issues one ONLY where the vendor signing key is present AND trusted by this build
(apps/vendor_licensing/signing.py refuses anything else). That key is the proof of ownership: a
customer installation never has it (it is created by `gtrade-ctl vendor-key generate` on the owner's
PC, DPAPI-bound to that machine), so on a customer installation `ensure()` does nothing and the
customer's own licence status, expiry and read-only rules apply unchanged. No warning is hidden: the
owner simply holds a real, signed, installation-bound PLATFORM_OWNER licence, which `evaluate`
already reports as VALID / lifetime / unlimited.

Cases handled:
* no licence yet (EVALUATION / EVALUATION_ENDED)            -> issue
* the installed platform-owner licence is no longer VALID     -> re-issue (e.g. the PC's hardware
  changed and the fingerprint grace began, or the install id changed after a restore)
* an INVALID licence whose (unverified) payload claims the owner role -> re-issue with the trusted key
A customer licence installed on the owner PC (testing) is never replaced automatically.
"""

from __future__ import annotations

import logging
import threading
import time

log = logging.getLogger(__name__)

RETRY_SECONDS = 600          # a failed attempt (no key / untrusted key) is not retried on every request
_lock = threading.Lock()
_busy = threading.local()
_last_failure: float | None = None


def _vendor_app() -> bool:
    from django.apps import apps
    from django.conf import settings
    return getattr(settings, 'GTRADE_EDITION', '') == 'local' and apps.is_installed('apps.vendor_licensing')


def _claims_owner(blob: str) -> bool:
    from . import licfmt, service
    try:
        return licfmt.decode_unverified(blob).get('role') == service.PLATFORM_OWNER
    except Exception:
        return False


def needs_owner_licence(verdict) -> bool:
    if verdict.status in ('EVALUATION', 'EVALUATION_ENDED'):
        return True
    if verdict.platform_owner and verdict.status != 'VALID':
        return True
    if verdict.status == 'INVALID':
        from .models import LicenseState
        return _claims_owner(LicenseState.load().license_blob or '')
    return False


def reset():
    global _last_failure
    with _lock:
        _last_failure = None


def ensure(verdict):
    """The new verdict when a platform-owner licence was issued now, else None. Never raises."""
    global _last_failure
    if getattr(_busy, 'on', False) or not _vendor_app() or not needs_owner_licence(verdict):
        return None
    with _lock:
        if _last_failure is not None and time.monotonic() - _last_failure < RETRY_SECONDS:
            return None
    _busy.on = True
    try:
        from apps.vendor_licensing import service as vendor, signing
        try:
            signing.key_id()  # raises SigningKeyError: no key (every customer PC) or not trusted by this build
        except signing.SigningKeyError:
            with _lock:
                _last_failure = time.monotonic()
            return None
        result = vendor.issue_platform_owner('system (automatic)', auto=True, previous_status=verdict.status)
        with _lock:
            _last_failure = None
        return result
    except Exception:  # pragma: no cover - entitlement must never break a request
        log.exception('automatic platform-owner licence failed')
        with _lock:
            _last_failure = time.monotonic()
        return None
    finally:
        _busy.on = False
