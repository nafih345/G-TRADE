import uuid
from decimal import Decimal
from django.db import models
from apps.common.models import BaseUUIDModel

class ImportBatch(models.Model):
    STATUS_CHOICES = [
        ('PENDING', 'Pending Validation'),
        ('PROCESSING', 'Importing In Background'),
        ('VALIDATED', 'Validated Ready'),
        ('SUCCESS', 'Import Successful'),
        ('PARTIAL', 'Partial Import'),
        ('FAILED', 'Import Failed'),
        ('ARCHIVED', 'Archived Batch'),
        ('DELETED', 'Deleted Batch'),
    ]

    STRATEGY_CHOICES = [
        ('SKIP', 'Skip Duplicates'),
        ('UPDATE', 'Update Existing Record'),
        ('REPLACE', 'Replace Existing Record'),
        ('DUPLICATE', 'Create Duplicate Record'),
    ]

    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    is_deleted = models.BooleanField(default=False)

    batch_number = models.CharField(max_length=50, unique=True)
    file_name = models.CharField(max_length=255)
    original_file_name = models.CharField(max_length=255, blank=True, null=True)
    file = models.FileField(upload_to='import_batches/', blank=True, null=True)
    # Copy of the uploaded bytes, kept only while the import is unfinished. Hosted
    # containers (Render) lose MEDIA_ROOT on every restart/spin-down, so this is what
    # lets a stalled import resume instead of dying with "file not found".
    file_data = models.BinaryField(blank=True, null=True, editable=False)
    uploaded_by = models.CharField(max_length=150, default='Administrator')
    uploaded_date = models.DateTimeField(auto_now_add=True)
    status = models.CharField(max_length=30, choices=STATUS_CHOICES, default='PENDING')
    duplicate_strategy = models.CharField(max_length=30, choices=STRATEGY_CHOICES, default='UPDATE')
    
    total_rows = models.IntegerField(default=0)
    processed_rows = models.IntegerField(default=0) # Rows streamed & classified so far (drives live progress)
    imported_rows = models.IntegerField(default=0)
    failed_rows = models.IntegerField(default=0)
    duplicate_rows = models.IntegerField(default=0)
    processing_time = models.FloatField(default=0.0) # Seconds
    version = models.CharField(max_length=20, default='v1.0')
    column_headers = models.JSONField(default=list, blank=True) # Exact Excel header order/names

    remarks = models.TextField(blank=True, null=True)
    logs = models.JSONField(default=list, blank=True, null=True) # Step-by-step audit logs
    ip_address = models.CharField(max_length=50, blank=True, null=True)

    def __str__(self):
        return f"{self.batch_number} - {self.file_name} ({self.status})"


class ImportErrorLog(models.Model):
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
    is_deleted = models.BooleanField(default=False)

    batch = models.ForeignKey(ImportBatch, on_delete=models.CASCADE, related_name='error_logs')
    sheet_name = models.CharField(max_length=100, default='Sheet 1')
    row_number = models.IntegerField()
    product_code = models.CharField(max_length=100, blank=True, null=True)
    product_name = models.CharField(max_length=255, blank=True, null=True)
    field_name = models.CharField(max_length=100)
    error_type = models.CharField(max_length=100)
    error_message = models.TextField()
    raw_data = models.JSONField(default=dict, blank=True, null=True)

    def __str__(self):
        return f"Batch {self.batch.batch_number} Row {self.row_number}: {self.error_message}"


class ProductVariantGroup(BaseUUIDModel):
    """Parent ("style") record that ties sibling Product rows together as variants.

    Each variant is still an ordinary Product (own SKU, barcode, stock, prices), so every
    sale / purchase / stock / barcode path that references Product keeps working unchanged.
    This row only holds what the variants share plus which attributes they vary on.
    Created and edited by the Add Multiple Items / Product Variant Master screen.
    """
    name = models.CharField(max_length=255, db_index=True)
    base_sku = models.CharField(max_length=120, unique=True, blank=True, null=True)
    description = models.TextField(blank=True, null=True)
    long_description = models.TextField(blank=True, null=True)

    category = models.ForeignKey('masters.ProductCategory', on_delete=models.SET_NULL, null=True, blank=True, related_name='variant_groups')
    brand = models.ForeignKey('masters.Brand', on_delete=models.SET_NULL, null=True, blank=True, related_name='variant_groups')
    unit = models.ForeignKey('masters.Unit', on_delete=models.SET_NULL, null=True, blank=True, related_name='variant_groups')
    category_name = models.CharField(max_length=150, blank=True, null=True, db_index=True)
    brand_name = models.CharField(max_length=150, blank=True, null=True)
    sub_category = models.CharField(max_length=150, blank=True, null=True)
    group_name = models.CharField(max_length=150, blank=True, null=True)
    model_number = models.CharField(max_length=150, blank=True, null=True)
    hsn_code = models.CharField(max_length=15, blank=True, null=True)
    tax_percent = models.DecimalField(max_digits=5, decimal_places=2, blank=True, null=True)

    # Ordered attribute keys the variants differ on, e.g. ["color", "size"].
    attribute_keys = models.JSONField(default=list, blank=True)
    is_active = models.BooleanField(default=True)

    def __str__(self):
        return self.name


class ProductVariantTemplate(BaseUUIDModel):
    """Reusable Add Multiple Items configuration (category, attributes, default option
    values, tax, SKU rule, visible columns). Never holds transaction data."""
    name = models.CharField(max_length=150, unique=True)
    category_name = models.CharField(max_length=150, blank=True, null=True)
    config = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ['name']

    def __str__(self):
        return self.name


class BulkSaveReceipt(models.Model):
    """Idempotency record for the bulk variant save: a retried request carrying the same
    client token gets the stored response instead of creating the products twice."""
    token = models.CharField(max_length=64, unique=True)
    response = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)


class Product(BaseUUIDModel):
    name = models.CharField(max_length=255)
    sku = models.CharField(max_length=150, unique=True)
    barcode = models.CharField(max_length=150, unique=True, blank=True, null=True)
    description = models.TextField(blank=True, null=True)
    
    category = models.ForeignKey('masters.ProductCategory', on_delete=models.SET_NULL, null=True, blank=True, related_name='products')
    brand = models.ForeignKey('masters.Brand', on_delete=models.SET_NULL, null=True, blank=True, related_name='products')
    unit = models.ForeignKey('masters.Unit', on_delete=models.SET_NULL, null=True, blank=True, related_name='products')
    tax = models.ForeignKey('masters.Tax', on_delete=models.SET_NULL, null=True, blank=True, related_name='products')

    # De-normalized text metadata fields for fast high-speed queries & bulk imports
    category_name = models.CharField(max_length=150, blank=True, null=True, db_index=True)
    brand_name = models.CharField(max_length=150, blank=True, null=True, db_index=True)
    supplier_name = models.CharField(max_length=150, blank=True, null=True)
    # Variant attributes surfaced on barcode labels / pickers. Legacy imported rows
    # may still only carry these inside extra_data — the serializer falls back to that.
    color = models.CharField(max_length=100, blank=True, null=True)
    size = models.CharField(max_length=100, blank=True, null=True)
    frame_type = models.CharField(max_length=150, blank=True, null=True)
    rack_location = models.CharField(max_length=150, blank=True, null=True)
    hsn_code = models.CharField(max_length=15, blank=True, null=True)

    cost_price = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    retail_price = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    wholesale_price = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    
    minimum_stock = models.IntegerField(default=5)
    maximum_stock = models.IntegerField(default=100)
    opening_stock = models.IntegerField(default=0)
    stock = models.IntegerField(default=0)

    # Link to Batch & Active state for Archiving/Deletion
    import_batch = models.ForeignKey(ImportBatch, on_delete=models.SET_NULL, null=True, blank=True, related_name='products')
    is_active = models.BooleanField(default=True)
    
    # Complete raw row & custom header attributes from uploaded Excel/CSV files
    extra_data = models.JSONField(default=dict, blank=True, null=True)

    image = models.ImageField(upload_to='product_images/', blank=True, null=True)

    # Variant link (null for stand-alone products). variant_key is the normalised attribute
    # combination ("color=black|size=m") — unique inside a group so the same combination
    # can't be created twice.
    variant_group = models.ForeignKey(ProductVariantGroup, on_delete=models.SET_NULL, null=True, blank=True, related_name='variants')
    variant_attributes = models.JSONField(default=dict, blank=True)
    variant_key = models.CharField(max_length=255, blank=True, null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(
                fields=['variant_group', 'variant_key'],
                condition=models.Q(variant_group__isnull=False, variant_key__isnull=False),
                name='uniq_product_variant_combination',
            ),
        ]

    def __str__(self):
        return f"{self.name} ({self.sku})"


class BarcodeSequence(models.Model):
    """Per-prefix atomic counter used to mint unique product barcodes (see barcode_utils.reserve_barcodes)."""
    prefix = models.CharField(max_length=10, unique=True)
    last_number = models.BigIntegerField(default=100000)

    def __str__(self):
        return f"{self.prefix} -> {self.last_number}"


class ProductBarcode(models.Model):
    """Additional scan-in barcodes that all resolve to the same product.

    When N labels are printed for one product the printer assigns each label its
    own code from a running EAN-13 series (see barcode_utils.reserve_ean13), so
    no two physical tags carry an identical barcode. Every code in that series is
    stored here against the product, so scanning any of them at billing still
    finds the product. Label #1 always reuses ``Product.barcode`` itself.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='extra_barcodes')
    code = models.CharField(max_length=150, unique=True, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']

    def __str__(self):
        return f"{self.code} -> {self.product_id}"


class BarcodeHistory(BaseUUIDModel):
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='barcode_history')
    old_barcode = models.CharField(max_length=150, blank=True, null=True)
    new_barcode = models.CharField(max_length=150, blank=True, null=True)
    changed_by = models.CharField(max_length=150, blank=True, null=True)
    reason = models.CharField(max_length=255, blank=True, null=True)

    class Meta:
        ordering = ['-created_at']

    def __str__(self):
        return f"{self.product_id}: {self.old_barcode} -> {self.new_barcode}"


# ---------------------------------------------------------------------------
# Barcode label designer (Settings → Barcode Labels)
# ---------------------------------------------------------------------------
class LabelTemplate(BaseUUIDModel):
    """A saved barcode label design. Holds only presentation — which field sits where and
    how it looks (apps/products/label_fields.py validates `layout`). Product values are
    never stored; they are resolved from Product rows at preview / print time.

    `version` increments on every update; the previous state is kept as a
    LabelTemplateVersion row, and updates must send the version they edited
    (optimistic lock) so two people can't silently overwrite each other's design.
    Delete is a soft delete (BaseUUIDModel), so a removed template can be restored.
    """
    PRINTER_TYPES = [('thermal', 'Thermal roll'), ('a4', 'A4 sheet')]

    name = models.CharField(max_length=120)
    description = models.CharField(max_length=255, blank=True, default='')
    printer_type = models.CharField(max_length=10, choices=PRINTER_TYPES, default='thermal')
    width_mm = models.DecimalField(max_digits=6, decimal_places=2)
    height_mm = models.DecimalField(max_digits=6, decimal_places=2)
    layout = models.JSONField(default=dict, blank=True)
    version = models.PositiveIntegerField(default=1)
    is_default = models.BooleanField(default=False)
    # Starter preset this template was seeded from — "Restore Default" resets to it.
    preset_key = models.CharField(max_length=60, blank=True, default='')
    updated_by_name = models.CharField(max_length=150, blank=True, default='')

    class Meta:
        ordering = ['-is_default', 'name']

    def __str__(self):
        return f"{self.name} ({self.width_mm}x{self.height_mm}mm {self.printer_type})"

    def save(self, *args, **kwargs):
        from django.db import transaction
        with transaction.atomic():
            if self.is_default and not self.is_deleted:
                LabelTemplate.all_objects.filter(is_default=True).exclude(pk=self.pk).update(is_default=False)
            super().save(*args, **kwargs)


class LabelTemplateVersion(models.Model):
    """Snapshot of a LabelTemplate as it was *before* an update (kept for restore)."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    template = models.ForeignKey(LabelTemplate, on_delete=models.CASCADE, related_name='versions')
    version = models.PositiveIntegerField()
    name = models.CharField(max_length=120)
    printer_type = models.CharField(max_length=10)
    width_mm = models.DecimalField(max_digits=6, decimal_places=2)
    height_mm = models.DecimalField(max_digits=6, decimal_places=2)
    layout = models.JSONField(default=dict)
    saved_at = models.DateTimeField(auto_now_add=True)
    saved_by = models.CharField(max_length=150, blank=True, default='')

    class Meta:
        ordering = ['-version']
        constraints = [
            models.UniqueConstraint(fields=['template', 'version'], name='uniq_label_template_version'),
        ]


class LabelPrintSettings(BaseUUIDModel):
    """Singleton: which template each workflow prints with + printer calibration.
    Use LabelPrintSettings.load()."""
    inventory_template = models.ForeignKey(LabelTemplate, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    purchase_template = models.ForeignKey(LabelTemplate, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')
    barcode_printing_template = models.ForeignKey(LabelTemplate, on_delete=models.SET_NULL, null=True, blank=True, related_name='+')

    thermal_printer_name = models.CharField(max_length=120, blank=True, default='')
    a4_printer_name = models.CharField(max_length=120, blank=True, default='')
    h_offset_mm = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0'))
    v_offset_mm = models.DecimalField(max_digits=5, decimal_places=2, default=Decimal('0'))
    # Compensates a driver that shrinks/grows output; 100 = exact physical size.
    print_scale_percent = models.DecimalField(max_digits=5, decimal_places=1, default=Decimal('100'))
    default_copies = models.PositiveIntegerField(default=1)
    # Thermal head resolution. Barcode bar widths snap to whole printer dots so every bar
    # prints the same width (uneven bars are the #1 cause of unscannable thermal labels).
    # 0 = don't snap.
    printer_dpi = models.PositiveIntegerField(default=203)
    # Give every printed label its own persisted EAN-13 from ProductBarcode (existing
    # behaviour) instead of repeating the product's barcode on each copy.
    unique_label_series = models.BooleanField(default=True)
    # Browser-stored designs from before templates lived in the database were imported.
    legacy_migrated = models.BooleanField(default=False)

    # Fixed primary key: concurrent first requests can't each create their own "singleton".
    SINGLETON_ID = uuid.UUID('6c1a7b3e-0000-4000-8000-000000001abe')

    class Meta:
        verbose_name = 'Label Print Settings'
        verbose_name_plural = 'Label Print Settings'

    @classmethod
    def load(cls):
        from django.db import IntegrityError, transaction
        obj = cls.objects.order_by('created_at').first()
        if obj is None:
            try:
                with transaction.atomic():
                    obj = cls.objects.create(id=cls.SINGLETON_ID)
            except IntegrityError:
                obj = cls.objects.get(id=cls.SINGLETON_ID)
        return obj
