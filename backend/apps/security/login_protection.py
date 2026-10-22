"""Temporary lockout after repeated failed sign-ins (per account, and per address so one client
cannot spray many accounts). Policy comes from SecuritySettings."""
from datetime import timedelta

from django.utils import timezone
from rest_framework import status
from rest_framework.exceptions import APIException

from .audit import client_ip, log_event
from .models import LoginAttempt
from .policy import get_settings

IP_MULTIPLIER = 3  # an address may fail this many times the per-account limit


class AccountLocked(APIException):
    status_code = status.HTTP_429_TOO_MANY_REQUESTS
    default_code = 'account_locked'

    def __init__(self, seconds):
        minutes = max(1, -(-int(seconds) // 60))
        super().__init__({
            'detail': f'Too many failed sign-in attempts. Try again in {minutes} minute{"s" if minutes != 1 else ""}.',
            'code': 'account_locked', 'retry_after_seconds': int(seconds),
        })


def _norm(username):
    return (username or '').strip().lower()[:150]


def _remaining(times, limit, window, now):
    """Seconds left on a lock given failure times (newest first), or 0."""
    if len(times) < limit:
        return 0
    unlock_at = times[limit - 1] + window
    return max(0, int((unlock_at - now).total_seconds()))


def lock_remaining(username, ip):
    policy = get_settings()
    if not policy.login_protection_enabled:
        return 0
    now = timezone.now()
    window = timedelta(minutes=policy.lockout_minutes)
    limit = policy.max_failed_attempts
    name = _norm(username)

    since = now - window
    last_ok = (LoginAttempt.objects.filter(username=name, successful=True, created_at__gte=since)
               .order_by('-created_at').values_list('created_at', flat=True).first())
    user_fails = LoginAttempt.objects.filter(username=name, successful=False, created_at__gte=last_ok or since)
    seconds = _remaining(list(user_fails.order_by('-created_at').values_list('created_at', flat=True)[:limit]),
                         limit, window, now)
    if ip and not seconds:
        ip_limit = limit * IP_MULTIPLIER
        ip_fails = LoginAttempt.objects.filter(ip_address=ip, successful=False, created_at__gte=since)
        seconds = _remaining(list(ip_fails.order_by('-created_at').values_list('created_at', flat=True)[:ip_limit]),
                             ip_limit, window, now)
    return seconds


def ensure_not_locked(username, request):
    seconds = lock_remaining(username, client_ip(request))
    if seconds:
        raise AccountLocked(seconds)


def record_failure(username, request, reason='password'):
    ip = client_ip(request)
    LoginAttempt.objects.create(username=_norm(username), ip_address=ip, successful=False, reason=reason)
    seconds = lock_remaining(username, ip)
    if seconds:
        policy = get_settings()
        log_event('LOGIN_LOCKED', 'AUTH',
                  f'Sign-in locked for "{_norm(username)}" after {policy.max_failed_attempts} failed attempts',
                  request=request, actor_name=_norm(username), severity='WARNING',
                  details={'username': _norm(username), 'lockout_minutes': policy.lockout_minutes,
                           'reason': reason})
    return seconds


def record_success(username, request):
    LoginAttempt.objects.create(username=_norm(username), ip_address=client_ip(request), successful=True)
