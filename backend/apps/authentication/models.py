import uuid
from django.db import models
from django.contrib.auth.models import AbstractUser, BaseUserManager

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
    
    objects = UserManager()

    def __str__(self):
        return f"{self.username} ({self.get_role_display()})"
