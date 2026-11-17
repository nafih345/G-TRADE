import uuid
from django.db import models
from django.conf import settings

from apps.common import tenancy
from apps.common.tenancy import TenantManager, TenantQuerySet


def _all_modules():
    # The default package's modules (one accounting tier only — a client never gets both).
    from apps.common.module_access import FULL_SUITE, PACKAGE_MODULES
    return list(PACKAGE_MODULES[FULL_SUITE])


class Organization(models.Model):
    """The paying customer / licence holder (Phase 2, decision D1: Company = Tenant + Organization).

    An organization owns one or more companies. Each company is a `Tenant`: its own books,
    masters, numbering, settings and isolation (apps/common/tenancy.py). The organization holds
    no business data. It groups companies so that one user can be granted several of them
    (UserCompanyMembership) and an organization admin can create companies and read the
    consolidated summaries (apps/common/organizations.py).

    Global (not tenant-owned): it is read before, and across, tenant scopes. Every query on it
    filters explicitly by the caller's own organization."""
    name = models.CharField(max_length=150)
    code = models.SlugField(max_length=40, unique=True)
    is_active = models.BooleanField(default=True)
    # How many companies the organization may hold. Existing customers are migrated with 1, so
    # nothing changes until the platform admin (or, later, the licence) raises it.
    max_companies = models.PositiveSmallIntegerField(default=1)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['id']

    def __str__(self):
        return f"{self.name} (org #{self.pk})"


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
    # Which generation of default masters (branch, warehouse, chart of accounts, templates, …)
    # tenant_onboarding.ensure_tenant_defaults has given this client; behind = filled in at the
    # next sign-in.
    defaults_version = models.PositiveSmallIntegerField(default=0)

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

    # Phase 2: the organization (customer) this company belongs to. Nullable so code that predates
    # Phase 2 can still create tenants; organizations.ensure_organization() gives such a tenant
    # its own one-company organization the first time it is needed.
    organization = models.ForeignKey(Organization, on_delete=models.PROTECT, null=True, blank=True,
                                     related_name='companies')

    # Client profile kept by the platform (who the customer is). The business's own identity —
    # company name, registration and tax numbers, logo, currency — lives on company.Company.
    owner_name = models.CharField(max_length=150, blank=True, default='')
    country = models.CharField(max_length=2, blank=True, default='')  # ISO code (localization.COUNTRIES)
    address = models.TextField(blank=True, default='')

    # Subscription terms (no payment integration: the platform admin records what was agreed).
    # Access ends after `subscription_expires_on` (the last usable day; a trial's end date for
    # TRIAL). Null = no end date, which is how every client created before these fields behaves.
    SUBSCRIPTION_PLANS = (
        ('TRIAL', 'Trial'),
        ('MONTHLY', 'Monthly'),
        ('QUARTERLY', 'Quarterly'),
        ('HALF_YEARLY', 'Half-yearly'),
        ('ANNUAL', 'Annual'),
        ('PERPETUAL', 'Perpetual (no expiry)'),
    )
    subscription_plan = models.CharField(max_length=20, choices=SUBSCRIPTION_PLANS, default='PERPETUAL')
    subscription_starts_on = models.DateField(null=True, blank=True)
    subscription_expires_on = models.DateField(null=True, blank=True)
    # Branch limit: active branches the client may run. Null = no limit (clients created earlier).
    max_branches = models.PositiveIntegerField(null=True, blank=True)

    class Meta:
        ordering = ['id']

    def __str__(self):
        return f"{self.name} (#{self.pk})"

    @staticmethod
    def active_q(today=None):
        """Filter for tenants that may be used today: active, no deactivation already due and the
        subscription not expired (the expiry date itself is still a usable day)."""
        from django.utils import timezone
        today = today or timezone.localdate()
        return (models.Q(is_active=True)
                & (models.Q(deactivation_effective_date__isnull=True)
                   | models.Q(deactivation_effective_date__gt=today))
                & (models.Q(subscription_expires_on__isnull=True)
                   | models.Q(subscription_expires_on__gte=today)))

    @property
    def is_subscription_expired(self):
        from django.utils import timezone
        return bool(self.subscription_expires_on and self.subscription_expires_on < timezone.localdate())

    @property
    def is_effectively_active(self):
        from django.utils import timezone
        due = self.deactivation_effective_date and self.deactivation_effective_date <= timezone.localdate()
        return bool(self.is_active and not due and not self.is_subscription_expired)


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


class OrganizationAdmin(models.Model):
    """A user who administers their organization: creates companies, grants company memberships,
    copies master data between companies and reads the consolidated summaries.

    Only a user whose home company (User.tenant) belongs to `organization` counts
    (organizations.is_org_admin re-checks that on every use). Backfilled from each company's
    existing owners (role SUPER_ADMIN) by migration common 0010."""
    organization = models.ForeignKey(Organization, on_delete=models.CASCADE, related_name='admins')
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='organization_admin_rows')
    granted_by = models.CharField(max_length=150, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['organization', 'user'], name='common_orgadmin_org_user_uniq')]

    def __str__(self):
        return f"{self.user_id} admin of org {self.organization_id}"


class UserCompanyMembership(models.Model):
    """Access for a user to a company (tenant) OTHER than their home company (User.tenant).

    The home company needs no row: the user's own `role` applies there, as before Phase 2.
    Here `role` is the user's role inside `company`, and branch access inside that company is
    the company's own UserBranchAccess row (fail-closed when missing).

    Rules (enforced in save(), the service layer and re-checked on every request):
      * `company` belongs to the same organization as the user's home company;
      * `company` is not the user's home company.
    Global (not tenant-owned) for the same reason as Organization."""
    user = models.ForeignKey(settings.AUTH_USER_MODEL, on_delete=models.CASCADE, related_name='company_memberships')
    company = models.ForeignKey(Tenant, on_delete=models.CASCADE, related_name='memberships')
    role = models.CharField(max_length=30)
    is_active = models.BooleanField(default=True)
    # Direct Edit switches for THIS company (Administration → Edit Permissions of `company`).
    # The User.can_edit_* fields apply in the user's home company only, so one company's admin
    # never decides whether a member may change saved records of another company.
    # db_default keeps inserts from older code valid.
    can_edit_eye_test = models.BooleanField(default=True, db_default=True)
    can_edit_sales = models.BooleanField(default=True, db_default=True)
    can_edit_wholesale = models.BooleanField(default=True, db_default=True)
    can_edit_inventory = models.BooleanField(default=True, db_default=True)
    can_edit_purchase = models.BooleanField(default=True, db_default=True)
    can_edit_accounts = models.BooleanField(default=True, db_default=True)
    created_by = models.CharField(max_length=150, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['company_id', 'user_id']
        constraints = [models.UniqueConstraint(fields=['user', 'company'], name='common_membership_user_company_uniq')]

    def __str__(self):
        return f"{self.user_id} in {self.company_id} as {self.role}"

    def save(self, *args, **kwargs):
        from apps.common.organizations import MembershipError, membership_problem
        problem = membership_problem(self.user, self.company)
        if problem:
            raise MembershipError(problem)
        super().save(*args, **kwargs)


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
