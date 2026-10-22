"""Server-side session policy: every JWT names its AuthSession (`sid` claim), and
LenientJWTAuthentication calls check_request() on each authenticated request to

* expire a session idle longer than the inactivity timeout (the browser timer is only a courtesy),
* end sessions on logout / after a restore, and
* demand a fresh password confirmation before sensitive actions when that policy is on.

The session row is read at most every SESSION_CACHE_SECONDS and last-activity is written at most
once a minute per session, so the hosted stack (hundreds of ms per query) pays almost nothing.
"""
import re
import threading
import time
from datetime import timedelta

from django.utils import timezone
from rest_framework import exceptions

from apps.common import hot_cache

from .models import AuthSession, SecuritySettings

REAUTH_WINDOW = timedelta(minutes=5)
TOUCH_SECONDS = 60
SESSION_CACHE_SECONDS = 20

# Writes that count as sensitive besides every DELETE: security policy, restores, accounts and
# permissions, and financial / tax / numbering configuration.
_WRITE = frozenset({'POST', 'PUT', 'PATCH', 'DELETE'})
SENSITIVE_WRITES = [re.compile(p) for p in (
    r'^/api/security/settings/?$',
    r'^/api/backups/restore/?$',
    r'^/api/auth/register/?$',
    r'^/api/company/user-branch-access(/|$)',
    r'^/api/company/business-settings/?$',
    r'^/api/company/localization/?$',
    r'^/api/company/tax-config(/|$)',
    r'^/api/company/document-sequences(/|$)',
    r'^/api/financial/(groups|accounts|vouchers|banks)(/|$)',
    r'^/api/financial/integration/(mappings|periods|policy|opening-balances|backfill|recompute-balances)(/|$)',
)]


def get_settings():
    return hot_cache.get_or_load('security:settings', SecuritySettings.load)


class SessionEnded(exceptions.AuthenticationFailed):
    default_code = 'session_expired'

    def __init__(self, detail='Your session has ended. Please sign in again.', code='session_expired'):
        super().__init__({'detail': detail, 'code': code})


class ReauthRequired(exceptions.PermissionDenied):
    default_code = 'reauth_required'

    def __init__(self):
        super().__init__({'detail': 'Confirm your password to continue with this action.',
                          'code': 'reauth_required'})


# ---- sessions --------------------------------------------------------------------------------

_lock = threading.Lock()
_snapshots = {}   # sid -> (expires_monotonic, dict)
_touched = {}     # sid -> (monotonic of last DB write, wall-clock datetime of last activity)


def _forget(sid):
    with _lock:
        _snapshots.pop(sid, None)
        _touched.pop(sid, None)


def _snapshot(sid, fresh=False):
    now = time.monotonic()
    hit = None if fresh else _snapshots.get(sid)
    if hit and hit[0] > now:
        return hit[1]
    row = (AuthSession.objects.filter(pk=sid)
           .values('user_id', 'last_activity_at', 'ended_at', 'reauthenticated_at').first())
    with _lock:
        if row is None:
            _snapshots.pop(sid, None)
        else:
            _snapshots[sid] = (now + SESSION_CACHE_SECONDS, row)
    return row


def open_session(user, request=None, two_factor=False):
    from .audit import client_ip
    agent = (request.META.get('HTTP_USER_AGENT', '') if request is not None else '')[:255]
    return AuthSession.objects.create(user_id=user.pk, username=user.username[:150],
                                      two_factor_verified=two_factor, ip_address=client_ip(request),
                                      user_agent=agent)


def issue_tokens(user, request=None, two_factor=False):
    from rest_framework_simplejwt.tokens import RefreshToken
    session = open_session(user, request, two_factor)
    refresh = RefreshToken.for_user(user)
    refresh['sid'] = str(session.id)
    return {'refresh': str(refresh), 'access': str(refresh.access_token), 'session_id': str(session.id)}


def end_session(sid, reason):
    AuthSession.objects.filter(pk=sid, ended_at__isnull=True).update(ended_at=timezone.now(), end_reason=reason)
    _forget(str(sid))


def end_all_sessions(reason, except_sid=None):
    qs = AuthSession.objects.filter(ended_at__isnull=True)
    if except_sid:
        qs = qs.exclude(pk=except_sid)
    count = qs.update(ended_at=timezone.now(), end_reason=reason)
    with _lock:
        _snapshots.clear()
        _touched.clear()
    return count


def _last_activity(sid, row):
    local = _touched.get(sid)
    if local and local[1] > row['last_activity_at']:
        return local[1]
    return row['last_activity_at']


def validate_session(sid, user, timeout_minutes):
    """Raise SessionEnded unless `sid` is an open, non-idle session of `user`; record activity."""
    sid = str(sid or '')
    if not sid:
        raise SessionEnded()
    try:
        row = _snapshot(sid)
    except Exception:  # malformed sid
        raise SessionEnded()
    if row is None or str(row['user_id']) != str(user.pk) or row['ended_at'] is not None:
        _forget(sid)
        raise SessionEnded()

    now = timezone.now()
    limit = timedelta(minutes=timeout_minutes)
    if now - _last_activity(sid, row) > limit:
        # Another worker may have seen activity this one has not — ask the database first.
        row = _snapshot(sid, fresh=True)
        if row is None or row['ended_at'] is not None or now - row['last_activity_at'] > limit:
            end_session(sid, 'TIMEOUT')
            raise SessionEnded('You were signed out after a period of inactivity. Please sign in again.',
                               code='session_timeout')

    mono = time.monotonic()
    last_write = _touched.get(sid)
    if last_write is None or mono - last_write[0] >= TOUCH_SECONDS:
        AuthSession.objects.filter(pk=sid, ended_at__isnull=True).update(last_activity_at=now)
        with _lock:
            _touched[sid] = (mono, now)
    else:
        with _lock:
            _touched[sid] = (last_write[0], now)
    return row


def mark_reauthenticated(sid):
    now = timezone.now()
    AuthSession.objects.filter(pk=sid).update(reauthenticated_at=now, last_activity_at=now)
    _forget(str(sid))


def recently_reauthenticated(sid):
    row = _snapshot(str(sid), fresh=True)
    return bool(row and row['reauthenticated_at'] and timezone.now() - row['reauthenticated_at'] <= REAUTH_WINDOW)


def is_sensitive(method, path):
    method = (method or '').upper()
    if method == 'DELETE' and path.startswith('/api/'):
        return True
    return method in _WRITE and any(p.match(path) for p in SENSITIVE_WRITES)


def check_request(request, user, token):
    """Called by the JWT authentication class for every request carrying a valid token."""
    policy = get_settings()
    sid = token.get('sid') if token is not None else None
    validate_session(sid, user, policy.inactivity_timeout_minutes)
    if policy.sensitive_action_reauth and is_sensitive(request.method, request.path):
        if not recently_reauthenticated(sid):
            raise ReauthRequired()
