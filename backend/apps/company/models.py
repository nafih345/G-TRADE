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

    # --- Store & Clinic Profile (Settings → Store & Clinic Profile) -------------------------
    # The oldest Company row is the store profile every document prints (see
    # apps.company.store_profile). Logo, tagline and website live on billing.BillingSettings
    # (shared with the Bill Designer's Branding panel) so they are never stored twice.
    STORE_TYPES = (
        ('OPTICAL_STORE', 'Optical Store'),
        ('EYE_CLINIC', 'Eye Clinic'),
        ('OPTICAL_AND_CLINIC', 'Optical Store & Eye Clinic'),
    )
    display_name = models.CharField(max_length=150, blank=True, default='')
    store_type = models.CharField(max_length=30, choices=STORE_TYPES, blank=True, default='')
    business_reg_no = models.CharField(max_length=60, blank=True, default='')
    whatsapp = models.CharField(max_length=20, blank=True, default='')
    city = models.CharField(max_length=100, blank=True, default='')
    state = models.CharField(max_length=100, blank=True, default='')
    pin_code = models.CharField(max_length=10, blank=True, default='')
    country = models.CharField(max_length=100, blank=True, default='')
    # {"registered"|"billing"|"shipping": {"same_as_store": bool, "street", "city", "state",
    #   "pin_code", "country"}}
    extra_addresses = models.JSONField(default=dict, blank=True)
    contact_person = models.CharField(max_length=120, blank=True, default='')
    clinical_reg_no = models.CharField(max_length=60, blank=True, default='')
    opening_time = models.CharField(max_length=5, blank=True, default='')  # "HH:MM"
    closing_time = models.CharField(max_length=5, blank=True, default='')
    working_days = models.JSONField(default=list, blank=True)  # ["MON", "TUE", ...]
    holidays = models.JSONField(default=list, blank=True)  # [{"date": "YYYY-MM-DD", "name": ""}]
    provides_eye_exams = models.BooleanField(default=False)
    # {"exam_start", "exam_end", "slot_minutes", "appointment_required"}
    clinic_settings = models.JSONField(default=dict, blank=True)

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
    # Business & Localization preferences (regional defaults, transaction toggles, currency /
    # language options, other operational defaults). Schema, defaults and validation live in
    # apps/company/localization.py — read them through localization.get_preferences().
    preferences = models.JSONField(default=dict, blank=True)

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



# ==========================================
# BUSINESS & LOCALIZATION SETTINGS
# ==========================================

class DocumentSequence(models.Model):
    """How one document type is numbered (Settings → Business & Localization → Numbering
    Sequences). The running counter lives in DocumentSequenceCounter, one row per reset period,
    so a yearly / monthly reset never rewrites history. See apps/company/numbering.py."""
    RESET_CHOICES = [
        ('NEVER', 'Never'), ('MONTHLY', 'Monthly'), ('YEARLY', 'Yearly'), ('FISCAL_YEAR', 'Fiscal year'),
    ]
    doc_type = models.CharField(max_length=30, unique=True)
    prefix = models.CharField(max_length=30, blank=True, default='')
    suffix = models.CharField(max_length=20, blank=True, default='')
    padding = models.PositiveSmallIntegerField(default=4)
    start_number = models.PositiveIntegerField(default=1)
    reset_frequency = models.CharField(max_length=12, choices=RESET_CHOICES, default='NEVER')
    is_active = models.BooleanField(default=True)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by = models.CharField(max_length=150, blank=True, default='')

    class Meta:
        ordering = ['doc_type']

    def __str__(self):
        return f"{self.doc_type}: {self.prefix}…{self.suffix}"


class DocumentSequenceCounter(models.Model):
    """last_number handed out for (doc_type, period). Bumped with apps.common.sequences."""
    doc_type = models.CharField(max_length=30)
    period_key = models.CharField(max_length=20, default='ALL')
    last_number = models.PositiveIntegerField(default=0)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['doc_type', 'period_key'], name='uniq_doc_seq_period')]

    def __str__(self):
        return f"{self.doc_type}/{self.period_key} = {self.last_number}"


class CustomField(models.Model):
    """A user-defined extra field for a module (Settings → Custom Fields). Definitions only:
    modules render and store them as they adopt the feature."""
    FIELD_TYPES = [
        ('TEXT', 'Text'), ('TEXTAREA', 'Long text'), ('NUMBER', 'Number'), ('DATE', 'Date'),
        ('DROPDOWN', 'Dropdown'), ('CHECKBOX', 'Checkbox'), ('EMAIL', 'Email'), ('PHONE', 'Phone'),
    ]
    MODULES = [
        ('CUSTOMER', 'Customers / Patients'), ('SUPPLIER', 'Suppliers'), ('PRODUCT', 'Products'),
        ('SALES', 'Sales documents'), ('PURCHASE', 'Purchase documents'), ('EYE_TEST', 'Eye Test'),
    ]
    name = models.CharField(max_length=60)
    key = models.SlugField(max_length=60)
    field_type = models.CharField(max_length=12, choices=FIELD_TYPES, default='TEXT')
    module = models.CharField(max_length=12, choices=MODULES)
    options = models.JSONField(default=list, blank=True)  # dropdown choices
    is_required = models.BooleanField(default=False)
    is_active = models.BooleanField(default=True)
    sort_order = models.PositiveIntegerField(default=0)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ['module', 'sort_order', 'name']
        constraints = [models.UniqueConstraint(fields=['module', 'key'], name='uniq_custom_field_key')]

    def __str__(self):
        return f"{self.module}.{self.key}"


class SettingsAuditLog(models.Model):
    """Who changed which business setting, and from what to what."""
    section = models.CharField(max_length=30)  # LOCALIZATION / TAX / NUMBERING / CUSTOM_FIELD
    action = models.CharField(max_length=20)   # UPDATE / CREATE / DELETE
    summary = models.CharField(max_length=255)
    changes = models.JSONField(default=dict, blank=True)  # {field: [old, new]}
    performed_by = models.CharField(max_length=150, blank=True, default='')
    created_at = models.DateTimeField(auto_now_add=True, db_index=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.created_at:%Y-%m-%d %H:%M} {self.section} {self.summary}"


class DocumentNumberClaim(models.Model):
    """The number a screen sent with a new document (its double-submit guard) → the system number
    the document actually got. Written in the document's own transaction, so a repeated POST of
    the same entry is refused exactly as the UNIQUE number column used to refuse it."""
    doc_type = models.CharField(max_length=30)
    client_token = models.CharField(max_length=100)
    number = models.CharField(max_length=50)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['doc_type', 'client_token'], name='uniq_doc_number_claim')]
