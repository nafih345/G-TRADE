"""Install, activate, check in, deactivate: the licence lifecycle on the customer side.

A vendor licence key IS a signed licence (``GTL1.…``, apps/vendor_licensing/tokens.py). Pasting it
(Activate) and importing it as a file (Import licence file) run the SAME checks
(`check_activation` + `install_blob`):

* the Ed25519 signature verifies with an embedded vendor public key (keys.py);
* it is a G OPTICALS Windows Local licence (not a Cloud Edition one);
* it is ACTIVE (not suspended / revoked by the vendor), already started and not expired;
* it belongs to the same client as the licence this installation already holds;
* it is bound to THIS installation. A key the vendor issued before knowing the installation
  ("first activation") is bound by one online call to the vendor's licence authority, which refuses
  a second installation; offline, the customer gives the vendor the Installation ID instead;
* it is not older than the licence already installed (replay guard).

Online calls go to the vendor licence authority (settings.GTRADE_LICENSE_SERVICE_URL, the cloud
console's /api/licence-authority) over HTTPS with normal certificate verification (optionally
pinned to GTRADE_LICENSE_SERVICE_CA). Plain HTTP is accepted only for a development service on this
machine's loopback while dev mode is on. Everything the authority returns is re-verified here with
the embedded public keys; it is never trusted blindly.
"""

from __future__ import annotations

import base64
import datetime as dt
import json
import re
import ssl
import urllib.error
import urllib.request
from urllib.parse import urlparse

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from . import fingerprint, keys, licfmt, state
from .models import LicenseEvent, LicenseState

ONLINE_TIMEOUT = 75  # the hosted authority (Render free tier) needs ~45 s to wake from sleep
REQUEST_PREFIX = 'GTR1'
LEGACY_KEY_RE = re.compile(r'^GT[A-Z0-9]{2}(-[A-Z0-9]{5}){4}$', re.IGNORECASE)


class LicenseServiceError(RuntimeError):
    def __init__(self, message, body=None):
        super().__init__(message)
        self.body = body or {}


def _log(event, actor='', **detail):
    LicenseEvent.objects.create(event=event, actor=actor or '', detail=detail)


def _client_id(payload) -> str:
    return str((payload.get('client') or {}).get('id') or '')


PLATFORM_OWNER = 'PLATFORM_OWNER'


def is_platform_owner(payload) -> bool:
    """The vendor's own installation licence (apps/vendor_licensing/service.issue_platform_owner).
    Only the vendor signing key can produce one, and verify_blob binds it to one installation."""
    return payload.get('role') == PLATFORM_OWNER and payload.get('binding') == 'INSTALLATION' \
        and bool(payload.get('install_id'))


def check_activation(payload: dict, *, source: str, now=None) -> None:
    """The rules every user-initiated activation (key or file) must pass. A check-in from the
    vendor may also deliver suspended / revoked / renewed licences (they are the vendor's signed
    decisions), so it skips the status and expiry rules. Raises LicenseFormatError."""
    now = now or timezone.now()
    st = LicenseState.load()
    lic_id = payload.get('lic_id')
    # Client identity: an installation that holds a vendor licence for one client does not
    # silently switch to another client's licence.
    client = _client_id(payload)
    if payload.get('role') and not is_platform_owner(payload):
        raise licfmt.LicenseFormatError('this licence has an unknown role')
    if st.client_id and client and client != st.client_id and not is_platform_owner(payload):
        name = (payload.get('client') or {}).get('name') or client
        raise licfmt.LicenseFormatError(
            f'this licence was issued to a different client ({name}, {client}), but this installation is licensed '
            f'to client {st.client_id}. Ask your vendor for a licence for your own client account')
    # Replay: an older revision of the licence that is installed.
    rev = int(payload.get('rev') or 0)
    if st.lic_id and lic_id == st.lic_id and rev and st.lic_rev and rev < st.lic_rev:
        raise licfmt.LicenseFormatError('this is an older version of the licence already installed; use the latest '
                                        'key from your vendor')
    if source == 'checkin' or int(payload.get('v') or 1) < 2:
        return  # v1 (development service) licences keep their original rules: grace after expiry
    status = str(payload.get('status') or 'ACTIVE')
    if status == 'SUSPENDED':
        reason = payload.get('status_reason') or ''
        raise licfmt.LicenseFormatError(f'licence {lic_id} is suspended by your vendor'
                                        + (f' ({reason})' if reason else '') + '; contact your vendor')
    if status == 'REVOKED':
        raise licfmt.LicenseFormatError(f'licence {lic_id} has been revoked by your vendor')
    until = state._parse(payload.get('valid_until'))
    if until and now > until:
        raise licfmt.LicenseFormatError(f'licence {lic_id} expired on {str(payload.get("expires_on") or until.date())}; '
                                        'ask your vendor to renew it')
    starts = payload.get('starts_on')
    if starts:
        try:
            start_day = dt.date.fromisoformat(starts)
        except ValueError:
            raise licfmt.LicenseFormatError('licence has an invalid start date')
        if start_day > (now + dt.timedelta(days=1)).date():
            raise licfmt.LicenseFormatError(f'licence {lic_id} starts on {starts}; activate it on or after that day')


def install_blob(blob: str, *, actor='', source='import') -> state.Verdict:
    blob = licfmt.normalize_key(blob)
    payload = state.verify_blob(blob)
    check_activation(payload, source=source)
    issued = state._parse(payload['issued_at'])
    with transaction.atomic():
        st = LicenseState.objects.select_for_update().get_or_create(pk=1)[0]
        if st.max_issued_at and issued < st.max_issued_at - timezone.timedelta(seconds=1):
            raise licfmt.LicenseFormatError('this licence is older than the one already installed')
        previous = st.lic_id
        st.license_blob = blob
        st.lic_id = payload['lic_id']
        st.lic_rev = int(payload.get('rev') or 0)
        if is_platform_owner(payload):
            st.client_id = _client_id(payload)  # the vendor's own installation
        else:
            st.client_id = st.client_id or _client_id(payload)
        st.activation_id = payload.get('activation_id', '')
        st.activated_at = st.activated_at or timezone.now()
        st.max_issued_at = max(filter(None, [st.max_issued_at, issued]))
        st.fp_mismatch_since = None
        if previous != st.lic_id:
            # A different licence: the previous one's revocation does not carry over.
            st.revoked_at, st.revocation_reason = None, ''
        if source in ('activate', 'checkin'):
            st.last_checkin_at = timezone.now()
        st.save()
    _log('install', actor, source=source, lic_id=payload['lic_id'], rev=payload.get('rev'),
         edition=payload.get('edition'), plan=(payload.get('plan') or {}).get('code'),
         status=payload.get('status', 'ACTIVE'), development=keys.is_dev_key(payload.get('key_id')))
    state.invalidate()
    return state.current(force=True)


def _service_url(path: str) -> str:
    base = (getattr(settings, 'GTRADE_LICENSE_SERVICE_URL', '') or '').rstrip('/')
    if not base:
        raise LicenseServiceError('No licence server is configured for online activation. Use the offline '
                                  'activation file instead.')
    u = urlparse(base)
    if u.scheme != 'https':
        if not (keys.dev_mode() and u.scheme == 'http' and u.hostname in ('127.0.0.1', 'localhost')):
            raise LicenseServiceError('The licensing service must be reached over HTTPS.')
    return base + path


def service_configured() -> bool:
    return bool((getattr(settings, 'GTRADE_LICENSE_SERVICE_URL', '') or '').strip())


def _post(path: str, body: dict, timeout=ONLINE_TIMEOUT) -> dict:
    url = _service_url(path)
    ctx = None
    if url.startswith('https://'):
        ctx = ssl.create_default_context()
        ca = getattr(settings, 'GTRADE_LICENSE_SERVICE_CA', '')
        if ca:
            ctx = ssl.create_default_context(cafile=ca)
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'User-Agent': 'G-OPTICALS'})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        try:
            data = json.loads(exc.read().decode('utf-8'))
        except Exception:
            data = {}
        raise LicenseServiceError(data.get('error') or f'licensing service answered HTTP {exc.code}', body=data)
    except (urllib.error.URLError, OSError) as exc:
        raise LicenseServiceError(f'cannot reach the licensing service ({getattr(exc, "reason", exc)})')


def machine_payload() -> dict:
    return {'install_id': state.install_id(), 'fp': {'v': 1, 'hashes': fingerprint.component_hashes()},
            'app_version': getattr(settings, 'GTRADE_VERSION', '')}


def _apply_crl_from(body):
    if isinstance(body, dict) and body.get('crl'):
        try:
            apply_crl(body['crl'])
        except licfmt.LicenseFormatError:
            pass  # an unverifiable CRL is ignored, never trusted


def activate(key: str, *, actor='') -> state.Verdict:
    """Online activation: the vendor authority binds the key to this installation and returns the
    signed licence for it (also used for legacy short keys)."""
    try:
        resp = _post('/v1/activate', {'key': licfmt.normalize_key(key), **machine_payload()})
    except LicenseServiceError as exc:
        _apply_crl_from(exc.body)
        raise
    verdict = install_blob(resp['license'], actor=actor, source='activate')
    _apply_crl_from(resp)
    return verdict


def activate_key(key: str, *, actor='') -> state.Verdict:
    """The Activate button. A signed key is verified HERE first (signature, edition, client,
    status, dates, binding) so every refusal is explained even offline; only a key that is not yet
    bound to an installation needs the vendor's licence server."""
    key = licfmt.normalize_key(key)
    if not key:
        raise licfmt.LicenseFormatError('enter the licence key')
    if not key.startswith(licfmt.LICENSE_PREFIX + '.'):
        if key.startswith(licfmt.CRL_PREFIX + '.'):
            raise licfmt.LicenseFormatError('this is a revocation list, not a licence key')
        if LEGACY_KEY_RE.match(key):
            return activate(key, actor=actor)  # legacy short key (GTxx-xxxxx-...): online only
        raise licfmt.LicenseFormatError('not a G OPTICALS licence key; copy the whole key from your vendor '
                                        '(it starts with GTL1)')
    payload = state.verify_signature(key)
    check_activation(payload, source='key')
    bound = str(payload.get('install_id') or '')
    if bound and bound != state.install_id():
        raise licfmt.LicenseFormatError(
            f'this licence key is bound to another installation ({bound[:8]}...). This installation is '
            f'{state.install_id()[:8]}...; ask your vendor for a key for this Installation ID')
    if bound:
        verdict = install_blob(key, actor=actor, source='key')
        _log('activated_offline', actor, lic_id=payload['lic_id'], rev=payload.get('rev'))
        return verdict
    try:
        return activate(key, actor=actor)
    except LicenseServiceError as exc:
        raise LicenseServiceError(
            f'This licence key must be activated online once, so that it is bound to this computer ({exc}). '
            f'Connect this server to the internet and try again, or send your Installation ID '
            f'{state.install_id()} to your vendor for an installation-bound key or licence file.', body=exc.body)


def offline_request(key: str) -> dict:
    return {'type': 'gtrade-activation-request', 'version': 1, 'key': key.strip(), **machine_payload(),
            'created_at': timezone.now().isoformat()}


def installation_request() -> str:
    """Code the customer copies to the vendor so a key can be bound to this installation (and its
    machine fingerprint) without any online call. Not secret, not signed: it only names this PC."""
    body = {'product': state.PRODUCT, **machine_payload(), 'created_at': timezone.now().replace(microsecond=0).isoformat()}
    raw = json.dumps(body, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return f'{REQUEST_PREFIX}.' + base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


CONFIRM_PREFIX = 'GTA1'


def activation_confirmation(verdict=None) -> str:
    """After a vendor licence is active here, the code the customer sends back to the vendor so
    Client Management can show the subscription as ACTIVATED (apps/vendor_licensing/service
    .record_activation checks licence, client and installation). Not signed and not secret: it
    only reports what this installation runs; it can never change what a key allows."""
    verdict = verdict or state.current()
    st = LicenseState.load()
    if not (verdict.v2 and verdict.lic_id and not verdict.platform_owner and st.license_blob):
        return ''
    body = {'lic_id': verdict.lic_id, 'rev': verdict.revision, 'client_id': (verdict.client or {}).get('id', ''),
            'install_id': state.install_id(), 'status': verdict.status,
            'activated_at': st.activated_at.replace(microsecond=0).isoformat() if st.activated_at else None}
    raw = json.dumps(body, sort_keys=True, separators=(',', ':')).encode('utf-8')
    return f'{CONFIRM_PREFIX}.' + base64.urlsafe_b64encode(raw).rstrip(b'=').decode('ascii')


def apply_crl(crl_blob: str) -> bool:
    payload = licfmt.verify(licfmt.normalize_key(crl_blob), licfmt.CRL_PREFIX, keys.trusted_keys())
    issued = state._parse(payload.get('issued_at'))
    with transaction.atomic():
        st = LicenseState.objects.select_for_update().get_or_create(pk=1)[0]
        if st.crl_issued_at and issued and issued < st.crl_issued_at:
            return False  # an older CRL never un-revokes
        hit = None
        for r in payload.get('revoked', []):
            if not isinstance(r, dict) or not st.lic_id or r.get('lic_id') != st.lic_id:
                continue
            below = r.get('below_rev')
            # below_rev: only the revisions issued before the licence moved to another installation.
            if below is None or int(st.lic_rev or 0) < int(below):
                hit = r
                break
        if hit and not st.revoked_at:
            st.revoked_at = timezone.now()
            st.revocation_reason = str(hit.get('reason', ''))[:200]
            _log('revoked', '', lic_id=st.lic_id, reason=st.revocation_reason)
        elif not hit and st.revoked_at:
            st.revoked_at, st.revocation_reason = None, ''
            _log('revocation_lifted', '', lic_id=st.lic_id)
        st.crl_issued_at = issued
        st.save()
    state.invalidate()
    return True


def checkin(*, actor='') -> state.Verdict:
    st = LicenseState.load()
    if not st.license_blob:
        raise LicenseServiceError('No licence is installed yet.')
    try:
        resp = _post('/v1/checkin', {'lic_id': st.lic_id, 'activation_id': st.activation_id, **machine_payload()})
    except LicenseServiceError as exc:
        LicenseState.objects.filter(pk=1).update(last_checkin_error=str(exc)[:300])
        _apply_crl_from(exc.body)
        raise
    _apply_crl_from(resp)
    if resp.get('license'):
        install_blob(resp['license'], actor=actor, source='checkin')
    LicenseState.objects.filter(pk=1).update(last_checkin_at=timezone.now(), last_checkin_error='')
    _log('checkin', actor, renewed=bool(resp.get('license')))
    state.invalidate()
    return state.current(force=True)


def deactivate(*, actor='') -> dict:
    st = LicenseState.load()
    if not st.license_blob:
        raise LicenseServiceError('No licence is installed.')
    resp = _post('/v1/deactivate', {'lic_id': st.lic_id, 'activation_id': st.activation_id, **machine_payload()})
    _log('deactivate', actor, lic_id=st.lic_id)
    LicenseState.objects.filter(pk=1).update(license_blob='', lic_id='', activation_id='')
    state.invalidate()
    return resp


def usage() -> dict:
    from django.contrib.auth import get_user_model
    from apps.common import tenancy
    from apps.common.models import Tenant
    from apps.company.models import Branch
    from .enforcement import _client_org_ids, _platform_owner_q
    with tenancy.unscoped():
        return {'companies': Tenant.objects.filter(is_active=True).count(),
                'users': get_user_model().objects.filter(is_active=True).exclude(_platform_owner_q()).count(),
                'branches_total': Branch.objects.filter(is_active=True).count(),
                'clients': len(_client_org_ids())}
