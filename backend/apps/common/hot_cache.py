"""In-process TTL cache for the few rows read on *every* API request.

Branch settings, the default branch, a user's branch access and the authenticated user are
looked up before a view even starts. On the hosted stack each lookup is a network round trip
to the database (hundreds of milliseconds when the app and Postgres are in different regions),
so re-reading these unchanging rows on every call was a fixed ~1 s tax on each request.

Values live for HOT_CACHE_SECONDS. Saving or deleting a watched model clears the cache in the
process that made the change at once; other gunicorn workers catch up when their copy
expires. HOT_CACHE_SECONDS = 0 turns caching off (the test runner does this, because test
transactions roll back without telling anyone, and a cached row could outlive its test).
"""
import threading
import time

from django.conf import settings

_lock = threading.Lock()
_store = {}


def _ttl():
    return getattr(settings, 'HOT_CACHE_SECONDS', 30)


def get_or_load(key, loader):
    seconds = _ttl()
    if seconds <= 0:
        return loader()
    now = time.monotonic()
    hit = _store.get(key)
    if hit is not None and hit[0] > now:
        return hit[1]
    value = loader()
    with _lock:
        _store[key] = (now + seconds, value)
    return value


def clear(*_args, **_kwargs):
    """Drop everything. Signature fits a signal receiver."""
    with _lock:
        _store.clear()


def connect_invalidation(*model_labels):
    """Clear the cache whenever one of these models is saved or deleted (or, for a model with
    many-to-many fields, has them changed)."""
    from django.apps import apps
    from django.db.models.signals import m2m_changed, post_delete, post_save

    for label in model_labels:
        model = apps.get_model(label)
        uid = f'hot_cache:{label}'
        post_save.connect(clear, sender=model, dispatch_uid=f'{uid}:save', weak=False)
        post_delete.connect(clear, sender=model, dispatch_uid=f'{uid}:delete', weak=False)
        for field in model._meta.many_to_many:
            m2m_changed.connect(clear, sender=field.remote_field.through,
                                dispatch_uid=f'{uid}:{field.name}:m2m', weak=False)
