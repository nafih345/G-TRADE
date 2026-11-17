"""Install, activate, check in, deactivate: the licence lifecycle on the customer side.

Online calls go to the vendor licensing service (settings.GTRADE_LICENSE_SERVICE_URL) over HTTPS
with normal certificate verification (optionally pinned to GTRADE_LICENSE_SERVICE_CA). Plain HTTP
is accepted only for a development service on this machine's loopback while dev mode is on.
Everything the service returns is re-verified here with the embedded public keys; the service is
never trusted blindly.
"""

from __future__ import annotations

import json
import ssl
import urllib.error
import urllib.request
from urllib.parse import urlparse

from django.conf import settings
from django.db import transaction
from django.utils import timezone

from . import fingerprint, keys, licfmt, state
from .models import LicenseEvent, LicenseState


class LicenseServiceError(RuntimeError):
    pass


def _log(event, actor='', **detail):
    LicenseEvent.objects.create(event=event, actor=actor or '', detail=detail)


def install_blob(blob: str, *, actor='', source='import') -> state.Verdict:
    payload = state.verify_blob(blob)
    issued = state._parse(payload['issued_at'])
    with transaction.atomic():
        st = LicenseState.objects.select_for_update().get_or_create(pk=1)[0]
        if st.max_issued_at and issued < st.max_issued_at - timezone.timedelta(seconds=1):
            raise licfmt.LicenseFormatError('this licence is older than the one already installed')
        st.license_blob = blob.strip()
        st.lic_id = payload['lic_id']
        st.activation_id = payload.get('activation_id', '')
        st.activated_at = st.activated_at or timezone.now()
        st.max_issued_at = max(filter(None, [st.max_issued_at, issued]))
        st.fp_mismatch_since = None
        if source in ('activate', 'checkin'):
            st.last_checkin_at = timezone.now()
        st.save()
    _log('install', actor, source=source, lic_id=payload['lic_id'], edition=payload.get('edition'),
         development=keys.is_dev_key(payload.get('key_id')))
    state.invalidate()
    return state.current(force=True)


def _service_url(path: str) -> str:
    base = (getattr(settings, 'GTRADE_LICENSE_SERVICE_URL', '') or '').rstrip('/')
    if not base:
        raise LicenseServiceError('No licensing service is configured for online activation. Use the offline '
                                  'activation file instead.')
    u = urlparse(base)
    if u.scheme != 'https':
        if not (keys.dev_mode() and u.scheme == 'http' and u.hostname in ('127.0.0.1', 'localhost')):
            raise LicenseServiceError('The licensing service must be reached over HTTPS.')
    return base + path


def _post(path: str, body: dict, timeout=20) -> dict:
    url = _service_url(path)
    ctx = None
    if url.startswith('https://'):
        ctx = ssl.create_default_context()
        ca = getattr(settings, 'GTRADE_LICENSE_SERVICE_CA', '')
        if ca:
            ctx = ssl.create_default_context(cafile=ca)
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST',
                                 headers={'Content-Type': 'application/json', 'User-Agent': 'G-TRADE-ERP'})
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            return json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as exc:
        try:
            detail = json.loads(exc.read().decode('utf-8')).get('error')
        except Exception:
            detail = None
        raise LicenseServiceError(detail or f'licensing service answered HTTP {exc.code}')
    except (urllib.error.URLError, OSError) as exc:
        raise LicenseServiceError(f'cannot reach the licensing service ({getattr(exc, "reason", exc)})')


def machine_payload() -> dict:
    return {'install_id': state.install_id(), 'fp': {'v': 1, 'hashes': fingerprint.component_hashes()},
            'app_version': getattr(settings, 'GTRADE_VERSION', '')}


def activate(key: str, *, actor='') -> state.Verdict:
    resp = _post('/v1/activate', {'key': key.strip(), **machine_payload()})
    verdict = install_blob(resp['license'], actor=actor, source='activate')
    if resp.get('crl'):
        apply_crl(resp['crl'])
    return verdict


def offline_request(key: str) -> dict:
    return {'type': 'gtrade-activation-request', 'version': 1, 'key': key.strip(), **machine_payload(),
            'created_at': timezone.now().isoformat()}


def apply_crl(crl_blob: str) -> bool:
    payload = licfmt.verify(crl_blob, licfmt.CRL_PREFIX, keys.trusted_keys())
    issued = state._parse(payload.get('issued_at'))
    with transaction.atomic():
        st = LicenseState.objects.select_for_update().get_or_create(pk=1)[0]
        if st.crl_issued_at and issued and issued < st.crl_issued_at:
            return False  # an older CRL never un-revokes
        revoked = {r.get('lic_id'): r for r in payload.get('revoked', []) if isinstance(r, dict)}
        hit = revoked.get(st.lic_id) if st.lic_id else None
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
        raise
    if resp.get('crl'):
        apply_crl(resp['crl'])
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
