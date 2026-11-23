"""Vendor licence authority data (cloud console only; never installed on a customer's Windows PC).

Global, not tenant-owned: only the platform owner (Vendor Super Admin) reads or writes it, through
/api/superadmin/licensing/ (IsPlatformAdmin + password re-check on writes).
"""

import uuid

from django.db import models
from django.utils import timezone

from . import tokens


class LicensePlan(models.Model):
    """A sellable plan. Licences copy its terms when issued (ClientLicense.plan_snapshot + limits),
    so editing a plan never changes a licence already sold; renew / change-plan apply the plan's
    current terms after showing the differences."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    code = models.SlugField(max_length=40, unique=True)
    name = models.CharField(max_length=120)
    description = models.TextField(blank=True, default='')
    edition = models.CharField(max_length=16, choices=tokens.EDITIONS)
    billing_cycle = models.CharField(max_length=10, choices=tokens.CYCLES)
    # Months (MONTHLY) or years (YEARLY) per period; ignored for LIFETIME.
    duration = models.PositiveSmallIntegerField(default=1)
    price = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    currency = models.CharField(max_length=3, default='INR')
    # Null = unlimited. The API only stores null when the request sent it explicitly.
    max_clients = models.PositiveIntegerField(null=True, blank=True)
    max_companies = models.PositiveIntegerField(null=True, blank=True)
    max_branches = models.PositiveIntegerField(null=True, blank=True)
    max_users = models.PositiveIntegerField(null=True, blank=True)
    modules = models.JSONField(default=list, blank=True)
    # Feature permissions: which Settings sections the client gets (module_access.SETTINGS_FEATURES);
    # null = every section.
    settings_features = models.JSONField(null=True, blank=True, default=None)
    grace_days = models.PositiveSmallIntegerField(default=7)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    created_by = models.CharField(max_length=150, blank=True, default='')
    updated_by = models.CharField(max_length=150, blank=True, default='')

    class Meta:
        ordering = ['edition', 'billing_cycle', 'name']

    def __str__(self):
        return f'{self.name} ({self.edition} {self.billing_cycle})'

    def limits(self) -> dict:
        return {'clients': self.max_clients, 'companies': self.max_companies, 'branches': self.max_branches,
                'users': self.max_users}

    def snapshot(self) -> dict:
        return {'id': str(self.pk), 'code': self.code, 'name': self.name, 'edition': self.edition,
                'billing_cycle': self.billing_cycle, 'duration': self.duration, 'price': str(self.price),
                'currency': self.currency}


class LicensedClient(models.Model):
    """The customer a licence is sold to. A Cloud client is linked to its workspace (Tenant); a
    Windows Local client has no cloud workspace at all: its data lives on its own PC."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    client_code = models.CharField(max_length=20, unique=True)
    name = models.CharField(max_length=150)
    owner_name = models.CharField(max_length=150, blank=True, default='')
    email = models.EmailField(blank=True, default='')
    phone = models.CharField(max_length=20, blank=True, default='')
    country = models.CharField(max_length=2, blank=True, default='')
    address = models.TextField(blank=True, default='')
    edition = models.CharField(max_length=16, choices=tokens.EDITIONS)
    tenant = models.OneToOneField('common.Tenant', on_delete=models.PROTECT, null=True, blank=True,
                                  related_name='licensed_client')
    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.CharField(max_length=150, blank=True, default='')

    class Meta:
        ordering = ['name']

    def __str__(self):
        return f'{self.name} ({self.client_code})'


class ClientLicense(models.Model):
    """One licence (one lic_id) for one client. Every change that affects what the customer may do
    re-signs it: `revision` goes up and `key_token` is the current signed licence key."""
    STATUSES = ((tokens.ACTIVE, 'Active'), (tokens.SUSPENDED, 'Suspended'), (tokens.REVOKED, 'Revoked'))

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    lic_id = models.CharField(max_length=32, unique=True)
    client = models.ForeignKey(LicensedClient, on_delete=models.PROTECT, related_name='licences')
    plan = models.ForeignKey(LicensePlan, on_delete=models.PROTECT, related_name='licences')
    plan_snapshot = models.JSONField(default=dict)
    edition = models.CharField(max_length=16, choices=tokens.EDITIONS)
    billing_cycle = models.CharField(max_length=10, choices=tokens.CYCLES)
    duration = models.PositiveSmallIntegerField(default=1)
    starts_on = models.DateField()
    expires_on = models.DateField(null=True, blank=True)  # null = lifetime
    limits = models.JSONField(default=dict)               # {clients, companies, branches, users}; null = unlimited
    modules = models.JSONField(default=list)
    settings_features = models.JSONField(null=True, blank=True, default=None)
    grace_days = models.PositiveSmallIntegerField(default=7)

    status = models.CharField(max_length=10, choices=STATUSES, default=tokens.ACTIVE)
    status_reason = models.TextField(blank=True, default='')
    revoked_at = models.DateTimeField(null=True, blank=True)

    # Current signed key. Not a secret signing key: a signed document whose use is bound to one
    # installation; kept so the Vendor Super Admin can copy it again (every copy is audited).
    revision = models.PositiveIntegerField(default=1)
    key_token = models.TextField()
    key_hash = models.CharField(max_length=64, db_index=True)
    key_id = models.CharField(max_length=60)
    issued_at = models.DateTimeField()

    # Installation binding (Windows). Blank = bound by the first online activation.
    install_id = models.CharField(max_length=64, blank=True, default='')
    install_fp = models.JSONField(default=dict, blank=True)
    activated_at = models.DateTimeField(null=True, blank=True)
    last_checkin_at = models.DateTimeField(null=True, blank=True)
    # Revisions below this were issued for an installation the licence was moved away from; the
    # signed revocation list tells that installation at its next check-in.
    void_below_revision = models.PositiveIntegerField(default=0)

    created_at = models.DateTimeField(auto_now_add=True)
    created_by = models.CharField(max_length=150, blank=True, default='')
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f'{self.lic_id} ({self.client.name})'

    @property
    def is_lifetime(self):
        return self.billing_cycle == tokens.LIFETIME or self.expires_on is None

    def effective_status(self, today=None) -> str:
        """REVOKED > SUSPENDED > PENDING (not started) > EXPIRED > ACTIVE."""
        today = today or timezone.localdate()
        if self.status != tokens.ACTIVE:
            return self.status
        if self.starts_on and self.starts_on > today:
            return 'PENDING'
        if self.expires_on and self.expires_on < today:
            return 'EXPIRED'
        return tokens.ACTIVE

    def activation_status(self) -> str:
        if self.edition == tokens.CLOUD:
            return 'CLOUD'
        if self.activated_at:
            return 'ACTIVATED'
        return 'BOUND' if self.install_id else 'NOT_ACTIVATED'


class LicenseIssuance(models.Model):
    """Every signed revision of a licence (what was issued, when, why). Tokens are kept only as a
    hash; the current one is on ClientLicense."""
    licence = models.ForeignKey(ClientLicense, on_delete=models.CASCADE, related_name='issuances')
    revision = models.PositiveIntegerField()
    reason = models.CharField(max_length=30)
    token_hash = models.CharField(max_length=64, db_index=True)
    key_id = models.CharField(max_length=60)
    status = models.CharField(max_length=10)
    starts_on = models.DateField()
    expires_on = models.DateField(null=True, blank=True)
    install_id = models.CharField(max_length=64, blank=True, default='')
    issued_at = models.DateTimeField()
    issued_by = models.CharField(max_length=150, blank=True, default='')

    class Meta:
        ordering = ['-revision']
        constraints = [models.UniqueConstraint(fields=['licence', 'revision'], name='vendorlic_issuance_rev_uniq')]


class LicenseAuditEvent(models.Model):
    """Audit trail of every plan / client / licence action, including key copies and activations."""
    created_at = models.DateTimeField(auto_now_add=True)
    action = models.CharField(max_length=40)
    actor = models.CharField(max_length=150, blank=True, default='')
    reason = models.TextField(blank=True, default='')
    licence = models.ForeignKey(ClientLicense, on_delete=models.CASCADE, null=True, blank=True, related_name='audit')
    plan = models.ForeignKey(LicensePlan, on_delete=models.CASCADE, null=True, blank=True, related_name='audit')
    client = models.ForeignKey(LicensedClient, on_delete=models.CASCADE, null=True, blank=True, related_name='audit')
    details = models.JSONField(default=dict, blank=True)
    ip = models.CharField(max_length=64, blank=True, default='')

    class Meta:
        ordering = ['-created_at', '-id']
