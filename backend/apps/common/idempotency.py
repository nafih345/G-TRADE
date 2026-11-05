"""Safe re-sends of API writes: the `Idempotency-Key` request header.

The frontend gives every POST a random key, kept for the life of that request config. When the
same request is sent again — the network-fallback interceptor replays it through the /api proxy,
the user re-confirms their password and the request is retried, a timeout is retried — it
carries the same key, and this middleware answers with the response the first attempt produced
instead of running the write a second time. That turns "the save may have gone through, don't
know" into an exact answer, without a duplicate sale, purchase or receipt.

Rules:
  * Only authenticated writes (POST/PUT/PATCH/DELETE under /api/) that send the header.
  * The key is per (tenant, user): one client can never replay — or block — another's.
  * Only 2xx responses are stored. A refusal (400 validation, 401/403 re-auth, 409, 5xx) frees
    the key so the corrected / re-authenticated request runs for real.
  * The same key with a different body is a client bug: 422, nothing runs.
  * While the first attempt is still running a repeat gets 409 `request_in_progress`; a
    pending record older than STALE_SECONDS (the first worker died) is taken over.
"""
import hashlib
import logging
import random
from datetime import timedelta

from django.db import IntegrityError, transaction
from django.http import JsonResponse, HttpResponse
from django.utils import timezone

logger = logging.getLogger(__name__)

HEADER = 'HTTP_IDEMPOTENCY_KEY'
WRITE_METHODS = {'POST', 'PUT', 'PATCH', 'DELETE'}
MAX_BODY = 2 * 1024 * 1024
STALE_SECONDS = 300
KEEP_HOURS = 24


def _identity(request):
    from rest_framework_simplejwt.settings import api_settings
    from apps.common.tenant_context import access_token
    token = access_token(request)
    if token is None:
        return None
    user_id = token.get(api_settings.USER_ID_CLAIM)
    return (getattr(request, 'tenant_id', None), str(user_id)) if user_id else None


def _purge_old():
    from apps.common.models import IdempotencyRecord
    IdempotencyRecord.objects.filter(created_at__lt=timezone.now() - timedelta(hours=KEEP_HOURS)).delete()


class IdempotencyMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        key = (request.META.get(HEADER) or '').strip()
        if not key or request.method not in WRITE_METHODS or not request.path.startswith('/api/'):
            return self.get_response(request)
        identity = _identity(request)
        if identity is None or len(key) > 80:
            return self.get_response(request)
        try:
            return self._handle(request, key, identity)
        except _Passthrough:
            return self.get_response(request)

    def _handle(self, request, key, identity):
        from apps.common.models import IdempotencyRecord
        tenant_id, user_id = identity
        lookup = {'tenant_id': tenant_id, 'user_id': user_id, 'key': key}
        try:
            # request.body raises for an over-size upload; that request just runs unguarded.
            body_hash = hashlib.sha256(request.method.encode() + request.path.encode() + b'\0'
                                       + request.body).hexdigest()
            with transaction.atomic():
                record = IdempotencyRecord.objects.create(method=request.method, path=request.path[:300],
                                                          request_hash=body_hash, **lookup)
        except IntegrityError:
            record = IdempotencyRecord.objects.filter(**lookup).first()
            if record is None:
                raise _Passthrough()
            if record.request_hash != body_hash:
                return JsonResponse({'detail': 'This request reused the key of a different request.',
                                     'code': 'idempotency_key_reused'}, status=422)
            if record.state == IdempotencyRecord.STATE_DONE:
                response = HttpResponse(bytes(record.response_body or b''), status=record.status_code,
                                        content_type=record.content_type or 'application/json')
                response['Idempotent-Replayed'] = 'true'
                return response
            if record.created_at > timezone.now() - timedelta(seconds=STALE_SECONDS):
                return JsonResponse({'detail': 'This save is still being processed. Wait a moment and refresh '
                                               'the list before trying again.',
                                     'code': 'request_in_progress'}, status=409)
            # The first attempt's worker died mid-request: run it now under the same record.
            IdempotencyRecord.objects.filter(pk=record.pk).update(created_at=timezone.now())
        except _Passthrough:
            raise
        except Exception:  # the guard must never take a save down (e.g. table not migrated yet)
            logger.exception('Idempotency guard unavailable; running the request unguarded')
            raise _Passthrough()

        response = None
        try:
            response = self.get_response(request)
        finally:
            self._finish(record.pk, response)
        if random.random() < 0.01:
            try:
                _purge_old()
            except Exception:
                pass
        return response

    @staticmethod
    def _finish(record_id, response):
        from apps.common.models import IdempotencyRecord
        try:
            ok = (response is not None and 200 <= response.status_code < 300
                  and not getattr(response, 'streaming', False))
            body = response.content if ok else None
            if ok and len(body) <= MAX_BODY:
                IdempotencyRecord.objects.filter(pk=record_id).update(
                    state=IdempotencyRecord.STATE_DONE, status_code=response.status_code,
                    content_type=response.get('Content-Type', '')[:100], response_body=body,
                    completed_at=timezone.now())
            else:
                IdempotencyRecord.objects.filter(pk=record_id).delete()
        except Exception:
            logger.exception('Could not record the idempotent response')


class _Passthrough(Exception):
    pass
