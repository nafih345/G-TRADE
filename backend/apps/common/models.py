import uuid
from django.db import models
from django.conf import settings

from apps.common import tenancy
from apps.common.tenancy import TenantManager, TenantQuerySet


def _all_modules():
    from apps.common.module_access import MODULE_KEYS
    return list(MODULE_KEYS)


class Tenant(models.Model):
    """A client business. Every TenantOwnedModel row belongs to exactly one, and API requests
    only ever see their own tenant's rows (see apps/common/tenancy.py). Users are tied to a
    tenant by authentication.User.tenant. Create tenants from the platform console
    (/api/superadmin/tenants/) or `manage.py create_tenant`; both go through
    apps.common.tenant_onboarding."""
    name = models.CharField(max_length=150, unique=True)
    code = models.SlugField(max_length=40, unique=True)
    is_active = models.BooleanField(default=True)
    # Platform-side contact for the client (who to call about the account), not shop data.
    contact_email = models.EmailField(blank=True, default='')
    contact_phone = models.CharField(max_length=20, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    # Subscription (apps/common/module_access.py): package + the module keys it grants, and
    # per-role overrides of the default module levels.
    package = models.CharField(max_length=20, default='FULL_SUITE')
    modules = models.JSONField(default=_all_modules, blank=True)
    role_permissions = models.JSONField(default=dict, blank=True)
    # With the Settings module on: which of its sections the client gets (SETTINGS_FEATURES
    # keys). Null = every section.
    settings_features = models.JSONField(null=True, blank=True, default=None)
    # Seat limit: how many *active* user accounts the client may have (its owner included).
    max_users = models.PositiveIntegerField(default=5)

    # Deactivation record. Filled when the platform admin deactivates (or schedules it): the
    # account stops working from `deactivation_effective_date` (see is_effectively_active).
    # Reactivating clears them; the history stays in TenantAuditLog.
    deactivation_category = models.CharField(max_length=40, blank=True, default='')
    deactivation_reason = models.TextField(blank=True, default='')
    deactivation_effective_date = models.DateField(null=True, blank=True)
    # Planned end of a suspension, for the record only — reactivating stays a manual action.
    deactivation_until = models.DateField(null=True, blank=True)
    deactivated_at = models.DateTimeField(null=True, blank=True)
    deactivated_by = models.CharField(max_length=150, blank=True, default='')

    class Meta:
        ordering = ['id']

    def __str__(self):
        return f"{self.name} (#{self.pk})"

    @staticmethod
    def active_q(today=None):
        """Filter for tenants that may be used today: active and no deactivation already due."""
        from django.utils import timezone
        today = today or timezone.localdate()
        return (models.Q(is_active=True)
                & (models.Q(deactivation_effective_date__isnull=True)
                   | models.Q(deactivation_effective_date__gt=today)))

    @property
    def is_effectively_active(self):
        from django.utils import timezone
        due = self.deactivation_effective_date and self.deactivation_effective_date <= timezone.localdate()
        return bool(self.is_active and not due)


class TenantAuditLog(models.Model):
    """Platform-side history of a client account: onboarding, deactivation / reactivation (with
    reason and effective date), module, seat, user and branch changes. Not tenant-owned — only
    the platform console reads it."""
    tenant = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name='audit_log')
    action = models.CharField(max_length=40)
    reason = models.TextField(blank=True, default='')
    effective_date = models.DateField(null=True, blank=True)
    details = models.JSONField(default=dict, blank=True)
    actor = models.CharField(max_length=150, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at', '-id']

    def __str__(self):
        return f"{self.tenant_id} {self.action} @ {self.created_at:%Y-%m-%d}"


class TenantOwnedModel(models.Model):
    """Abstract base for every row that belongs to one tenant. `objects` is tenant-scoped and
    save() stamps / verifies the tenant (tenancy.check_write)."""
    tenant = models.ForeignKey(
        Tenant, on_delete=models.PROTECT, default=tenancy.default_tenant_id,
        editable=False, related_name='+', db_index=True,
    )

    objects = TenantManager()

    class Meta:
        abstract = True

    def save(self, *args, **kwargs):
        tenancy.check_write(self)
        super().save(*args, **kwargs)


class SoftDeleteQuerySet(TenantQuerySet):
    def delete(self):
        return super().update(is_deleted=True)

    def hard_delete(self):
        return super().delete()

    def alive(self):
        return self.filter(is_deleted=False)

    def dead(self):
        return self.filter(is_deleted=True)


class SoftDeleteManager(models.Manager):
    def get_queryset(self):
        return SoftDeleteQuerySet(self.model, using=self._db).filter(is_deleted=False)


class BaseUUIDModel(TenantOwnedModel):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    
    created_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="%(app_label)s_%(class)s_created"
    )
    updated_by = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="%(app_label)s_%(class)s_updated"
    )
    is_deleted = models.BooleanField(default=False)

    # Managers
    objects = SoftDeleteManager()
    all_objects = TenantManager()  # includes soft-deleted rows; still tenant-scoped

    class Meta:
        abstract = True

    def delete(self, using=None, keep_parents=False):
        self.is_deleted = True  # type: ignore
        self.save(using=using)
        label = self._meta.label if hasattr(self, '_meta') else 'object'
        return (1, {label: 1})

    def hard_delete(self, using=None, keep_parents=False):
        super().delete(using=using, keep_parents=keep_parents)


class DataResetMarker(models.Model):
    """When the business data was last wiped (see the wipe_database command).

    Browsers keep their own copies of sales, patients and payments in localStorage, and the
    Sales screens merge those copies back in so offline work is never lost. After a wipe that
    merge would bring the deleted rows straight back, so /api/health/ publishes this stamp and
    each browser drops its cached records the first time it sees a new one. Lives in `common`
    because wipe_database never truncates this app.
    """
    reset_at = models.DateTimeField()

    @classmethod
    def current(cls):
        marker = cls.objects.order_by('-reset_at').first()
        return marker.reset_at if marker else None

    @classmethod
    def stamp(cls):
        from django.utils import timezone
        cls.objects.all().delete()
        return cls.objects.create(reset_at=timezone.now()).reset_at


class IdempotencyRecord(models.Model):
    """One API write sent with an `Idempotency-Key` header (see apps/common/idempotency.py).

    A repeat of the same key by the same user replays the stored response instead of running
    the write again — the browser re-sends a POST after a dropped connection, a proxy timeout or
    a password re-confirmation, and the first attempt may already have been saved. Rows older
    than a day are purged. Not tenant-owned (written by middleware before any view); the tenant
    and user are part of the key instead."""
    STATE_PENDING = 'PENDING'
    STATE_DONE = 'DONE'

    key = models.CharField(max_length=80)
    tenant_id = models.IntegerField(null=True, blank=True)
    user_id = models.CharField(max_length=64)
    method = models.CharField(max_length=10)
    path = models.CharField(max_length=300)
    request_hash = models.CharField(max_length=64)
    state = models.CharField(max_length=10, default=STATE_PENDING)
    status_code = models.PositiveSmallIntegerField(null=True, blank=True)
    content_type = models.CharField(max_length=100, blank=True, default='')
    response_body = models.BinaryField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['tenant_id', 'user_id', 'key'],
                                               name='common_idempotency_key_per_user')]
