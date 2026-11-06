import uuid
from django.db import models
from django.contrib.auth.models import AbstractUser, BaseUserManager

from apps.common import tenancy
from apps.common.models import TenantOwnedModel

class UserManager(BaseUserManager):
    def create_user(self, username, email=None, password=None, **extra_fields):
        if not username:
            raise ValueError('The Username field must be set')
        email = self.normalize_email(email)
        user = self.model(username=username, email=email, **extra_fields)
        user.set_password(password)
        user.save(using=self._db)
        return user

    def create_superuser(self, username, email=None, password=None, **extra_fields):
        extra_fields.setdefault('is_staff', True)
        extra_fields.setdefault('is_superuser', True)
        extra_fields.setdefault('role', 'SUPER_ADMIN')
        return self.create_user(username, email, password, **extra_fields)


class User(AbstractUser):
    ROLE_CHOICES = [
        ('SUPER_ADMIN', 'Super Admin'),
        ('ADMINISTRATOR', 'Administrator'),
        ('BRANCH_ADMIN', 'Branch Admin'),
        ('OPTOMETRIST', 'Optometrist'),
        ('DOCTOR', 'Doctor / Specialist'),
        ('MANAGER', 'Manager'),
        ('ACCOUNTANT', 'Accountant'),
        ('INVENTORY_MANAGER', 'Inventory Manager'),
        ('SALES_EXECUTIVE', 'Sales Executive'),
        ('PURCHASE_EXECUTIVE', 'Purchase Executive'),
        ('CASHIER', 'Cashier'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    role = models.CharField(max_length=30, choices=ROLE_CHOICES, default='SALES_EXECUTIVE')
    phone = models.CharField(max_length=20, blank=True, null=True)
    is_active = models.BooleanField(default=True)
    # The client business this account works for. Signed into every token as `tenant_id`;
    # all API data is filtered by it (apps/common/tenancy.py). A user without one cannot sign in.
    # New accounts default to the tenant of the request creating them (else the default tenant).
    tenant = models.ForeignKey('common.Tenant', on_delete=models.PROTECT, null=True, blank=True,
                               default=tenancy.default_tenant_id, related_name='users', db_index=True)

    # Direct Edit per module (Administration → Edit Permissions). ON: the user may change saved
    # records of that module at once. OFF: changing one needs an EditRequest approved by an admin
    # (apps/authentication/edit_permissions.py). The owner role / platform admin always edit directly.
    can_edit_eye_test = models.BooleanField(default=True)
    can_edit_sales = models.BooleanField(default=True)
    can_edit_wholesale = models.BooleanField(default=True)
    can_edit_inventory = models.BooleanField(default=True)
    can_edit_purchase = models.BooleanField(default=True)
    can_edit_accounts = models.BooleanField(default=True)

    objects = UserManager()

    def __str__(self):
        return f"{self.username} ({self.get_role_display()})"


class EditRequest(TenantOwnedModel):
    """A user's request to change one saved record of a module where their Direct Edit is OFF.

    PENDING → APPROVED (single-use clearance for that record, by that user, until expires_at) →
    COMPLETED on the first successful save. PENDING → REJECTED (review_note says why) or
    CANCELLED (by the requester). An APPROVED request past expires_at reads as EXPIRED."""
    PENDING, APPROVED, REJECTED, COMPLETED, CANCELLED, EXPIRED = (
        'PENDING', 'APPROVED', 'REJECTED', 'COMPLETED', 'CANCELLED', 'EXPIRED')
    STATUS_CHOICES = [(s, s.title()) for s in (PENDING, APPROVED, REJECTED, COMPLETED, CANCELLED, EXPIRED)]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    module = models.CharField(max_length=20, db_index=True)
    record_id = models.CharField(max_length=64, db_index=True)
    record_ref = models.CharField(max_length=120, blank=True, default='')
    reason = models.TextField()
    status = models.CharField(max_length=12, choices=STATUS_CHOICES, default=PENDING, db_index=True)
    requested_by = models.ForeignKey(User, on_delete=models.CASCADE, related_name='edit_requests')
    requester_role = models.CharField(max_length=30, blank=True, default='')
    reviewed_by = models.ForeignKey(User, on_delete=models.SET_NULL, null=True, blank=True,
                                    related_name='reviewed_edit_requests')
    review_note = models.TextField(blank=True, default='')
    reviewed_at = models.DateTimeField(null=True, blank=True)
    expires_at = models.DateTimeField(null=True, blank=True)
    completed_at = models.DateTimeField(null=True, blank=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['-created_at']
        indexes = [models.Index(fields=['requested_by', 'module', 'record_id', 'status'])]

    def __str__(self):
        return f"{self.module}:{self.record_ref or self.record_id} by {self.requested_by_id} ({self.status})"
