"""Row-level tenant isolation.

Every business row carries `tenant_id` (see apps.common.models.TenantOwnedModel, which
BaseUUIDModel extends). The tenant of the current request lives in a context variable set by
TenantContextMiddleware from the signed `tenant_id` claim of the caller's JWT, and the ORM
enforces it:

  * reads   — TenantQuerySet limits every query on a tenant-owned model to the current tenant.
              The filter is applied whenever a queryset is cloned or executed, not when it is
              built, because viewsets declare `queryset = Model.objects.all()` at import time,
              long before any request (and its tenant) exists.
  * writes  — TenantOwnedModel.save() / bulk_create() stamp the current tenant on new rows and
              refuse to save a row that belongs to another tenant, or that points (by FK) at
              another tenant's row. `tenant` is editable=False, so serializers never accept it
              from a request body.

Three modes, decided per context:
  * tenant set         — inside an authenticated API request (or `use_tenant(...)`): scoped.
  * strict, no tenant  — an /api/ request without a valid token: reads return nothing and
                         writes are refused, so an anonymous caller can never see or create
                         tenant data, whatever the view's permission_classes say.
  * neither            — management commands, migrations, the shell, startup: unscoped, and
                         new rows go to the default tenant, so single-tenant tooling keeps
                         working. Wrap per-tenant work in `use_tenant(tenant_id)`.

`unscoped()` lifts the filter explicitly, for platform-level code only.

Context variables don't follow work onto a new thread; start background threads with
`run_in_thread(...)` (or contextvars.copy_context().run) so they keep the request's tenant.
"""
import contextvars
import threading
from contextlib import contextmanager

from django.db import models
from rest_framework.exceptions import PermissionDenied

DEFAULT_TENANT_ID = 1

_tenant = contextvars.ContextVar('tenant_id', default=None)
_strict = contextvars.ContextVar('tenant_strict', default=False)
_bypass = contextvars.ContextVar('tenant_bypass', default=False)

# _scope_target() result meaning "match nothing".
EMPTY = 'EMPTY'


class TenantRequired(PermissionDenied):
    default_detail = 'Sign in to access this data.'
    default_code = 'tenant_required'


class CrossTenantWrite(PermissionDenied):
    default_detail = 'This record belongs to another account.'
    default_code = 'cross_tenant'


# ---- context -------------------------------------------------------------------------------

def current_tenant_id():
    return _tenant.get()


def activate(tenant_id, strict=True):
    """Set the tenant for the current context; returns a token for deactivate()."""
    return (_tenant.set(int(tenant_id) if tenant_id is not None else None), _strict.set(strict))


def deactivate(token):
    _tenant.reset(token[0])
    _strict.reset(token[1])


@contextmanager
def use_tenant(tenant_id):
    """Run a block as `tenant_id` (management commands, background jobs, tests)."""
    token = activate(tenant_id, strict=True)
    try:
        yield
    finally:
        deactivate(token)


@contextmanager
def unscoped():
    """Lift tenant filtering and write checks. Platform-level code only (backups, wipes)."""
    token = _bypass.set(True)
    try:
        yield
    finally:
        _bypass.reset(token)


def run_in_thread(target, *args, name=None, daemon=True, **kwargs):
    """Start `target` on a daemon thread that keeps the caller's tenant context."""
    ctx = contextvars.copy_context()
    thread = threading.Thread(target=ctx.run, args=(target, *args), kwargs=kwargs, name=name, daemon=daemon)
    thread.start()
    return thread


def cache_prefix():
    """Key prefix for per-process caches of tenant data (see hot_cache)."""
    tid = _tenant.get()
    return f't{tid}:' if tid is not None else 't-:'


def default_tenant_id():
    """Field default for TenantOwnedModel.tenant. Referenced by migrations — don't rename."""
    tid = _tenant.get()
    if tid is not None:
        return tid
    if _strict.get() and not _bypass.get():
        return None  # save() refuses with TenantRequired
    return DEFAULT_TENANT_ID


def _scope_target():
    """What queries should be limited to right now: a tenant id, EMPTY, or None (no limit)."""
    if _bypass.get():
        return None
    tid = _tenant.get()
    if tid is not None:
        return tid
    return EMPTY if _strict.get() else None


# ---- write checks --------------------------------------------------------------------------

_fk_cache = {}


def _tenant_fks(model):
    """Forward FK / one-to-one fields of `model` that point at another tenant-owned model."""
    fields = _fk_cache.get(model)
    if fields is None:
        from apps.common.models import TenantOwnedModel
        fields = [f for f in model._meta.concrete_fields
                  if f.many_to_one or f.one_to_one
                  if f.name != 'tenant' and isinstance(f.related_model, type)
                  and issubclass(f.related_model, TenantOwnedModel)]
        _fk_cache[model] = fields
    return fields


def check_write(obj):
    """Stamp / verify obj.tenant_id before it is written."""
    if _bypass.get():
        return
    tid = _tenant.get()
    if obj.tenant_id is None:
        if tid is None:
            if _strict.get():
                raise TenantRequired()
            obj.tenant_id = DEFAULT_TENANT_ID
        else:
            obj.tenant_id = tid
    elif tid is not None and obj.tenant_id != tid:
        raise CrossTenantWrite()
    # Only related objects already loaded on the instance are checked: that is how serializers
    # and services hand them over, and checking bare *_id values would cost a query per FK.
    for field in _tenant_fks(type(obj)):
        if field.is_cached(obj):
            related = field.get_cached_value(obj)
            if related is not None and related.tenant_id != obj.tenant_id:
                raise CrossTenantWrite(f'{field.verbose_name} belongs to another account.')


# ---- queryset / manager --------------------------------------------------------------------

class TenantQuerySet(models.QuerySet):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._tenant_scope = None  # tenant id / EMPTY this queryset is already limited to

    def _needs_scope(self):
        target = _scope_target()
        return target is not None and target != self._tenant_scope and not self.query.combinator

    def _apply_tenant_scope(self):
        """Limit this (fresh, unshared) queryset to the current tenant, in place."""
        if self._needs_scope():
            target = _scope_target()
            if target == EMPTY:
                self.query.set_empty()
            else:
                self.query.add_q(models.Q(tenant_id=target))
            self._tenant_scope = target
        return self

    def _clone(self):
        clone = super()._clone()
        clone._tenant_scope = self._tenant_scope
        return clone._apply_tenant_scope()

    # Terminal operations on a queryset built outside any tenant (e.g. a class attribute)
    # run on a scoped clone, so the shared original is never narrowed in place.
    def _fetch_all(self):
        if self._result_cache is None and self._needs_scope():
            clone = self._clone()
            clone._fetch_all()
            self._result_cache, self._prefetch_done = clone._result_cache, clone._prefetch_done
            return
        super()._fetch_all()

    def count(self):
        return self._clone().count() if self._result_cache is None and self._needs_scope() else super().count()

    def exists(self):
        return self._clone().exists() if self._result_cache is None and self._needs_scope() else super().exists()

    def aggregate(self, *args, **kwargs):
        return self._clone().aggregate(*args, **kwargs) if self._needs_scope() else super().aggregate(*args, **kwargs)

    def iterator(self, *args, **kwargs):
        return self._clone().iterator(*args, **kwargs) if self._needs_scope() else super().iterator(*args, **kwargs)

    def delete(self):
        return self._clone().delete() if self._needs_scope() else super().delete()

    def update(self, **kwargs):
        if self._needs_scope():
            return self._clone().update(**kwargs)
        if ('tenant' in kwargs or 'tenant_id' in kwargs) and not _bypass.get():
            raise CrossTenantWrite('A record cannot be moved to another account.')
        return super().update(**kwargs)

    def bulk_create(self, objs, *args, **kwargs):
        objs = list(objs)
        for obj in objs:
            check_write(obj)
        return super().bulk_create(objs, *args, **kwargs)


class TenantManager(models.Manager.from_queryset(TenantQuerySet)):
    def get_queryset(self):
        return super().get_queryset()._apply_tenant_scope()
