"""Licence evaluation: one verdict for the whole installation.

Statuses (``read_only`` decides whether writes are refused):

| status            | meaning                                                         | read_only |
|-------------------|-----------------------------------------------------------------|-----------|
| VALID             | signed, bound to this install + machine, within dates           | no        |
| GRACE             | expired / check-in overdue / machine changed, within grace days | no        |
| EVALUATION        | no licence yet, within 30 days of installation                  | no        |
| EVALUATION_ENDED  | no licence, evaluation over                                     | yes       |
| EXPIRED           | past valid_until + grace_days                                   | yes       |
| REVOKED           | vendor revoked it (after a 7-day notice)                        | yes (after notice) |
| INVALID           | bad signature, unknown key, other installation, replayed        | yes       |

Read-only never hides data: reads, reports, exports, backups and licence activation keep working.
The clock-rollback guard evaluates every date against max(now, highest time ever seen).
"""

from __future__ import annotations

import datetime as dt
import threading
import time
from dataclasses import asdict, dataclass, field

from django.conf import settings
from django.utils import timezone

from . import fingerprint, keys, licfmt

EVALUATION_DAYS = 30
EVALUATION_LIMITS = {'companies': 1, 'branches_per_company': 1, 'branches_total': 1, 'users': 2,
                     'clients': 1}
REVOCATION_NOTICE_DAYS = 7
FP_GRACE_DAYS = 14
CLOCK_TOLERANCE = dt.timedelta(hours=48)
CACHE_SECONDS = 60

_lock = threading.Lock()
_cached: tuple[float, 'Verdict'] | None = None


@dataclass
class Verdict:
    status: str
    read_only: bool
    message: str
    edition: str = ''
    license_type: str = ''
    lic_id: str = ''
    customer: str = ''
    limits: dict = field(default_factory=dict)
    modules: list | None = None          # None = no module restriction from the licence
    valid_until: str | None = None
    updates_until: str | None = None
    days_left: int | None = None
    grace_until: str | None = None
    development: bool = False
    clock_tamper: bool = False
    warnings: list = field(default_factory=list)

    def as_dict(self):
        return asdict(self)


def _parse(ts):
    if not ts:
        return None
    value = dt.datetime.fromisoformat(str(ts).replace('Z', '+00:00'))
    return value if value.tzinfo else value.replace(tzinfo=dt.timezone.utc)


def install_id() -> str:
    return getattr(settings, 'GTRADE_INSTALL_ID', '') or ''


def verify_blob(blob: str) -> dict:
    """Signature + binding checks that do not depend on time. Raises LicenseFormatError."""
    payload = licfmt.verify(blob, licfmt.LICENSE_PREFIX, keys.trusted_keys())
    if payload.get('install_id') != install_id():
        raise licfmt.LicenseFormatError('this licence was issued for another installation')
    for required in ('lic_id', 'edition', 'limits', 'issued_at'):
        if required not in payload:
            raise licfmt.LicenseFormatError(f'licence is missing {required!r}')
    return payload


def evaluate(now: dt.datetime | None = None, *, persist: bool = True) -> Verdict:
    from .models import LicenseState
    real_now = now or timezone.now()
    state = LicenseState.load()
    seen = state.last_seen_utc
    clock_tamper = bool(seen and real_now < seen - CLOCK_TOLERANCE)
    eff_now = max(real_now, seen) if seen else real_now
    if persist and (seen is None or real_now > seen + dt.timedelta(minutes=10)):
        LicenseState.objects.filter(pk=state.pk).update(last_seen_utc=max(real_now, seen or real_now))

    if not state.license_blob:
        ends = state.installed_at + dt.timedelta(days=EVALUATION_DAYS)
        days = (ends - eff_now).days
        if eff_now <= ends:
            return Verdict('EVALUATION', False, f'Evaluation: {max(days, 0)} days left. Activate a licence to continue '
                           'after the evaluation period.', edition='EVALUATION', limits=dict(EVALUATION_LIMITS),
                           days_left=max(days, 0), valid_until=ends.isoformat(), clock_tamper=clock_tamper)
        return Verdict('EVALUATION_ENDED', True, 'The evaluation period has ended. Your data is safe and can be viewed, '
                       'printed and backed up; activate a licence to continue working.', edition='EVALUATION',
                       limits=dict(EVALUATION_LIMITS), days_left=0, clock_tamper=clock_tamper)

    try:
        p = verify_blob(state.license_blob)
    except licfmt.LicenseFormatError as exc:
        return Verdict('INVALID', True, f'The installed licence is not valid: {exc}. Import a valid licence file.',
                       clock_tamper=clock_tamper)

    v = Verdict('VALID', False, 'Licence valid.', edition=p.get('edition', ''), license_type=p.get('type', ''),
                lic_id=p['lic_id'], customer=(p.get('customer') or {}).get('name', ''), limits=dict(p.get('limits') or {}),
                modules=list(p['modules']) if p.get('modules') is not None else None,
                valid_until=p.get('valid_until'), updates_until=p.get('updates_until'),
                development=keys.is_dev_key(p.get('key_id')), clock_tamper=clock_tamper)
    if v.development:
        v.warnings.append('Development licence: not valid for commercial use.')
    if clock_tamper:
        v.warnings.append('The computer clock is earlier than G-TRADE last saw it. Fix the date and time.')

    issued = _parse(p['issued_at'])
    if state.max_issued_at and issued and issued < state.max_issued_at - dt.timedelta(seconds=1):
        v.status, v.read_only, v.message = 'INVALID', True, 'An older licence was installed after a newer one; import the latest licence.'
        return v

    grace_days = int(p.get('grace_days') or 0)
    problems = []  # (deadline, message)

    # Machine binding.
    fp = p.get('fp') or {}
    if fp.get('hashes'):
        ok, matched, required = fingerprint.matches(fp['hashes'], int(fp.get('tolerance', 2)))
        if not ok:
            since = state.fp_mismatch_since or eff_now
            if persist and not state.fp_mismatch_since:
                LicenseState.objects.filter(pk=state.pk).update(fp_mismatch_since=eff_now)
            problems.append((since + dt.timedelta(days=FP_GRACE_DAYS),
                             f'This licence belongs to another computer ({matched}/{required} hardware checks match). '
                             'Re-activate it online or ask your provider for a transfer.'))
        elif state.fp_mismatch_since and persist:
            LicenseState.objects.filter(pk=state.pk).update(fp_mismatch_since=None)

    # Revocation (from the signed CRL fetched at check-in).
    if state.revoked_at:
        problems.append((state.revoked_at + dt.timedelta(days=REVOCATION_NOTICE_DAYS),
                         f'This licence was revoked by the vendor ({state.revocation_reason or "no reason given"}).'))

    # Expiry.
    valid_until = _parse(p.get('valid_until'))
    if valid_until:
        v.days_left = (valid_until - eff_now).days
        if eff_now > valid_until:
            problems.append((valid_until + dt.timedelta(days=grace_days), 'The licence has expired. Renew it to continue.'))

    # Subscription check-in.
    checkin_days = p.get('checkin_days')
    if checkin_days:
        last = state.last_checkin_at or state.activated_at or state.installed_at
        due = last + dt.timedelta(days=int(checkin_days))
        if eff_now > due:
            problems.append((due + dt.timedelta(days=grace_days),
                             'The licence has not been confirmed online for too long. Connect to the internet and '
                             'use "Check now", or import a renewal file.'))

    if problems:
        deadline, message = min(problems, key=lambda x: x[0])
        v.grace_until = deadline.isoformat()
        if eff_now <= deadline:
            v.status, v.read_only = ('REVOKED' if state.revoked_at else 'GRACE'), False
            v.message = f'{message} Full use continues until {deadline.date().isoformat()}.'
        else:
            v.status = 'REVOKED' if state.revoked_at else 'EXPIRED'
            v.read_only = True
            v.message = f'{message} G-TRADE is read-only until then: data can still be viewed, printed and backed up.'
    return v


def current(force=False) -> Verdict:
    """Cached verdict for request-time checks (60 s)."""
    global _cached
    with _lock:
        if not force and _cached and time.monotonic() - _cached[0] < CACHE_SECONDS:
            return _cached[1]
    verdict = evaluate()
    with _lock:
        _cached = (time.monotonic(), verdict)
    return verdict


def invalidate():
    global _cached
    with _lock:
        _cached = None


def health_summary() -> dict:
    v = current()
    return {'license': {'status': v.status, 'read_only': v.read_only, 'edition': v.edition,
                        'days_left': v.days_left, 'development': v.development}}
