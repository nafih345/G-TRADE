"""Public licence authority endpoints for Windows installations: /api/licence-authority/v1/...

    POST v1/activate     {key, install_id, fp, app_version}   bind / re-activate -> {license, crl}
    POST v1/checkin      {lic_id, install_id, fp}             current signed licence -> {license, crl}
    POST v1/deactivate                                        refused: moves are done by the vendor
    GET  v1/crl                                               signed revocation list
    GET  v1/health

Same protocol as the development service (licensing_service/), so the customer side
(apps/licensing/service.py) talks to either. No authentication (an installation has no account
here); requests are size- and rate-limited per address and every call is audited. Answers carry
only what the caller already proved it holds: a vendor-signed key or its bound installation.
"""

import json

from django.conf import settings
from rest_framework import permissions
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from . import service, signing

MAX_BODY = 32 * 1024


class AuthorityThrottle(SimpleRateThrottle):
    scope = 'licence_authority'

    def get_cache_key(self, request, view):
        return self.cache_format % {'scope': self.scope, 'ident': self.get_ident(request)}


class _Public(APIView):
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    throttle_classes = [AuthorityThrottle]

    def body(self, request):
        if int(request.META.get('CONTENT_LENGTH') or 0) > MAX_BODY:
            return None
        try:
            data = json.loads(request.body or b'{}')
        except ValueError:
            return None
        return data if isinstance(data, dict) else None

    def reply(self, code, obj):
        resp = Response(obj, status=code)
        resp['Cache-Control'] = 'no-store'
        return resp


def _ip(request):
    return (request.META.get('HTTP_X_FORWARDED_FOR', '').split(',')[0].strip() or request.META.get('REMOTE_ADDR', ''))[:64]


class ActivateView(_Public):
    def post(self, request):
        body = self.body(request)
        if body is None:
            return self.reply(400, {'error': 'invalid request'})
        try:
            signing.key_id()
        except signing.SigningKeyError:
            return self.reply(503, {'error': 'The licence server cannot activate licences right now. Try again later '
                                             'or use the licence file from your vendor.'})
        return self.reply(*service.activate_online(body, ip=_ip(request)))


class CheckinView(_Public):
    def post(self, request):
        body = self.body(request)
        if body is None:
            return self.reply(400, {'error': 'invalid request'})
        try:
            signing.key_id()
        except signing.SigningKeyError:
            return self.reply(503, {'error': 'The licence server is not available right now.'})
        return self.reply(*service.checkin_online(body, ip=_ip(request)))


class DeactivateView(_Public):
    def post(self, request):
        return self.reply(403, {'error': 'Licences are moved to another computer by your vendor (replacement key).'})


class CrlView(_Public):
    def get(self, request):
        try:
            return self.reply(200, {'crl': service.crl_token(), 'available': True})
        except signing.SigningKeyError:
            # Nothing signed to publish yet (no signing key on this server): a status, not a fault.
            return self.reply(200, {'crl': None, 'available': False})


class HealthView(_Public):
    def get(self, request):
        st = signing.status()
        return self.reply(200, {'status': 'ok', 'signing': st['configured'], 'key_id': st['key_id'],
                                'product': 'G-OPTICALS', 'version': getattr(settings, 'GTRADE_VERSION', '')})
