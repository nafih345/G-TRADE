from django.db import models
from django.db import transaction
from apps.common.models import BaseUUIDModel

class Company(BaseUUIDModel):
    name = models.CharField(max_length=150)
    logo = models.ImageField(upload_to='company_logos/', blank=True, null=True)
    gstin = models.CharField(max_length=15, blank=True, null=True)
    currency = models.CharField(max_length=10, default='USD')
    fiscal_year_start = models.DateField()
    fiscal_year_end = models.DateField()
    address = models.TextField(blank=True, null=True)
    email = models.EmailField(blank=True, null=True)
    phone = models.CharField(max_length=20, blank=True, null=True)

    def __str__(self):
        return self.name


class Branch(BaseUUIDModel):
    company = models.ForeignKey(Company, on_delete=models.CASCADE, related_name='branches')
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=20, unique=True)
    address = models.TextField(blank=True, null=True)
    phone = models.CharField(max_length=20, blank=True, null=True)
    # Extended location / contact details surfaced in Branch Management (spec section 2).
    email = models.EmailField(blank=True, null=True)
    city = models.CharField(max_length=100, blank=True, null=True)
    state = models.CharField(max_length=100, blank=True, null=True)
    country = models.CharField(max_length=100, blank=True, null=True)
    pin_code = models.CharField(max_length=20, blank=True, null=True)
    # Active/Inactive toggle — an inactive branch stays in the DB (and keeps its history)
    # but is hidden from the switcher and rejected for new transactions.
    is_active = models.BooleanField(default=True)
    # Exactly one Branch row carries is_default=True. It is the branch every operation falls
    # back to when Multi-Branch Mode is OFF, and the seed target for data migrations. Enforced
    # in save() below and by BranchViewSet.set_default.
    is_default = models.BooleanField(default=False)

    class Meta:
        ordering = ['-is_default', 'name']

    def __str__(self):
        return f"{self.name} ({self.code})"

    def save(self, *args, **kwargs):
        # Keep the "exactly one default" invariant: promoting a branch to default demotes
        # every other one. If no default exists yet, the first branch saved becomes it.
        with transaction.atomic():
            if self.is_default:
                Branch.all_objects.filter(is_default=True).exclude(pk=self.pk).update(is_default=False)
            elif not Branch.all_objects.filter(is_default=True).exclude(pk=self.pk).exists():
                self.is_default = True
            super().save(*args, **kwargs)

    @classmethod
    def get_default(cls):
        return cls.objects.filter(is_default=True).first() or cls.objects.first()


class Warehouse(BaseUUIDModel):
    branch = models.ForeignKey(Branch, on_delete=models.CASCADE, related_name='warehouses')
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=20, unique=True)
    address = models.TextField(blank=True, null=True)

    def __str__(self):
        return self.name


class Notification(BaseUUIDModel):
    NOTIFICATION_TYPES = (
        ('ERROR', 'Error / Critical Issue'),
        ('WARNING', 'Warning / Action Required'),
        ('INFO', 'Information / Alert'),
        ('SUCCESS', 'System Event Success'),
    )
    title = models.CharField(max_length=200)
    message = models.TextField()
    notification_type = models.CharField(max_length=20, choices=NOTIFICATION_TYPES, default='WARNING')
    is_read = models.BooleanField(default=False)
    target_link = models.CharField(max_length=200, blank=True, null=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"[{self.notification_type}] {self.title}"


class BusinessSettings(BaseUUIDModel):
    """Singleton row holding company-wide toggles. Use BusinessSettings.load()."""
    multi_branch_enabled = models.BooleanField(default=False)
    default_branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True, related_name='+'
    )

    class Meta:
        verbose_name = 'Business Settings'
        verbose_name_plural = 'Business Settings'

    def __str__(self):
        return f"BusinessSettings (multi_branch={self.multi_branch_enabled})"

    @classmethod
    def load(cls):
        obj = cls.objects.first()
        if obj is None:
            obj = cls.objects.create(default_branch=Branch.get_default())
        elif obj.default_branch_id is None:
            obj.default_branch = Branch.get_default()
            if obj.default_branch_id:
                obj.save(update_fields=['default_branch'])
        return obj


class UserBranchAccess(BaseUUIDModel):
    """Which branches a user may access. Keyed by username (CharField) rather than a User FK
    because the app's users currently live in frontend localStorage, not the auth_user table
    (see apps.common.authentication.LenientJWTAuthentication)."""
    username = models.CharField(max_length=150, db_index=True)
    access_all_branches = models.BooleanField(default=False)
    branches = models.ManyToManyField(Branch, blank=True, related_name='user_access')
    default_branch = models.ForeignKey(
        Branch, on_delete=models.SET_NULL, null=True, blank=True, related_name='+'
    )

    class Meta:
        verbose_name_plural = 'User branch access'

    def __str__(self):
        return f"{self.username} ({'ALL' if self.access_all_branches else self.branches.count()})"


class BranchStock(BaseUUIDModel):
    """Per-branch on-hand quantity — the source of truth once Multi-Branch is used.
    Product.stock is kept in sync as the sum across every branch (see
    apps.inventory.stock_utils.adjust_branch_stock)."""
    product = models.ForeignKey('products.Product', on_delete=models.CASCADE, related_name='branch_stock')
    branch = models.ForeignKey(Branch, on_delete=models.CASCADE, related_name='stock')
    quantity = models.IntegerField(default=0)

    class Meta:
        unique_together = ('product', 'branch')
        indexes = [models.Index(fields=['product', 'branch'])]

    def __str__(self):
        return f"{self.product_id} @ {self.branch_id}: {self.quantity}"


class StockTransfer(BaseUUIDModel):
    """Branch-to-branch stock movement (spec section 10). Apply logic lands in Phase 2."""
    STATUS_CHOICES = [
        ('PENDING', 'Pending'),
        ('COMPLETED', 'Completed'),
        ('CANCELLED', 'Cancelled'),
    ]
    transfer_number = models.CharField(max_length=50, unique=True, blank=True)
    from_branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name='transfers_out')
    to_branch = models.ForeignKey(Branch, on_delete=models.PROTECT, related_name='transfers_in')
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='PENDING')
    notes = models.TextField(blank=True, null=True)
    transferred_at = models.DateTimeField(null=True, blank=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.transfer_number} {self.from_branch_id}->{self.to_branch_id} ({self.status})"


class StockTransferItem(BaseUUIDModel):
    transfer = models.ForeignKey(StockTransfer, on_delete=models.CASCADE, related_name='items')
    product = models.ForeignKey('products.Product', on_delete=models.CASCADE)
    quantity = models.IntegerField(default=0)

    def __str__(self):
        return f"{self.product_id} x{self.quantity}"

