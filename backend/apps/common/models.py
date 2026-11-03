import uuid
from django.db import models
from django.conf import settings

from apps.common import tenancy
from apps.common.tenancy import TenantManager, TenantQuerySet


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

    class Meta:
        ordering = ['id']

    def __str__(self):
        return f"{self.name} (#{self.pk})"


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
