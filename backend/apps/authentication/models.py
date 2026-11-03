import uuid
from django.db import models
from django.contrib.auth.models import AbstractUser, BaseUserManager

from apps.common import tenancy

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
    
    objects = UserManager()

    def __str__(self):
        return f"{self.username} ({self.get_role_display()})"
