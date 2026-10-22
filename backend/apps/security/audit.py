"""Write to the security audit trail. Never raises into the caller: an audit hiccup must not turn a
completed backup or a valid sign-in into an error."""
import logging

from .models import SecurityAuditLog

logger = logging.getLogger('django')


def client_ip(request):
    if request is None:
        return None
    # Render / Vercel terminate TLS at a proxy; the client is the first X-Forwarded-For hop.
    forwarded = (request.META.get('HTTP_X_FORWARDED_FOR') or '').split(',')[0].strip()
    ip = forwarded or request.META.get('REMOTE_ADDR') or ''
    try:
        import ipaddress
        return str(ipaddress.ip_address(ip))
    except ValueError:
        return None


def _actor(request, user):
    user = user if user is not None else getattr(request, 'user', None)
    if user is not None and getattr(user, 'is_authenticated', False):
        return user, getattr(user, 'username', '') or ''
    return None, ''


def log_event(event, category, summary, *, request=None, user=None, actor_name='', details=None,
              severity='INFO'):
    try:
        actor, name = _actor(request, user)
        SecurityAuditLog.objects.create(
            event=event, category=category, severity=severity, summary=str(summary)[:255],
            details=details or {}, actor_id=getattr(actor, 'pk', None),
            actor_name=(actor_name or name)[:150], ip_address=client_ip(request),
        )
    except Exception:  # pragma: no cover - defensive
        logger.exception('Could not write security audit event %s', event)
