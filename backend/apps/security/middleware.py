"""Maintenance mode while a database restore runs: other writes are refused (503) so nothing is
saved into tables that are about to be replaced (423 Locked). Reads keep working; so do the backup
status endpoints the restoring screen polls."""
import time

from django.http import JsonResponse

SAFE = frozenset({'GET', 'HEAD', 'OPTIONS'})
EXEMPT_PREFIXES = ('/api/backups/', '/api/security/', '/api/auth/', '/api/health/')
_CACHE_SECONDS = 5
_cached = (0.0, False)


def _restoring():
    global _cached
    now = time.monotonic()
    if now < _cached[0]:
        return _cached[1]
    try:
        from .backup.service import restore_in_progress
        value = restore_in_progress()
    except Exception:
        value = False
    _cached = (now + _CACHE_SECONDS, value)
    return value


class RestoreMaintenanceMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        if (request.method not in SAFE and request.path.startswith('/api/')
                and not request.path.startswith(EXEMPT_PREFIXES) and _restoring()):
            return JsonResponse({'detail': 'A database restore is in progress. Changes are paused until it '
                                           'finishes — please try again in a few minutes.',
                                 'code': 'maintenance'}, status=423)  # not 5xx: the app is healthy
        return self.get_response(request)
