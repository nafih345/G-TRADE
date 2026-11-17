"""Read-only mode: when the licence verdict is read_only, every /api/ write answers 402 with the
reason, except what is needed to recover (sign in, licence activation, backups, security/session).
Reads are never blocked: the customer's data is never locked away."""

import json

from django.http import HttpResponse

SAFE_METHODS = ('GET', 'HEAD', 'OPTIONS')
WRITE_ALLOWLIST = ('/api/auth/', '/api/licensing/', '/api/backups/', '/api/security/', '/api/health/')


class LicenseEnforcementMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        path = request.path_info or ''
        if (request.method not in SAFE_METHODS and path.startswith('/api/')
                and not path.startswith(WRITE_ALLOWLIST)):
            from . import state
            verdict = state.current()
            if verdict.read_only:
                body = json.dumps({'error': 'license_read_only', 'status': verdict.status, 'detail': verdict.message})
                return HttpResponse(body, status=402, content_type='application/json')
        return self.get_response(request)
