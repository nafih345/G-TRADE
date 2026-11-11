import uuid
from decimal import Decimal
from django.db import models
from apps.common.models import BaseUUIDModel, TenantOwnedModel

class ImportBatch(TenantOwnedModel):
    STATUS_CHOICES = [
        ('ANALYZING', 'Preparing Preview'),
        ('AWAITING_CONFIRMATION', 'Waiting For Review'),
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

    batch_number = models.CharField(max_length=50)
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
    # Fill rows missing a barcode, after a preview the user confirms. Off, they stay blank.
    auto_barcode = models.BooleanField(default=False)
    barcode_summary = models.JSONField(default=dict, blank=True) # What the preview found + the series rule it used
    preview_summary = models.JSONField(default=dict, blank=True) # Row counts per ImportPreviewRow kind
    completed_at = models.DateTimeField(blank=True, null=True)

    total_rows = models.IntegerField(default=0)
    processed_rows = models.IntegerField(default=0) # Rows streamed & classified so far (drives live progress)
    imported_rows = models.IntegerField(default=0) # New products created
    updated_rows = models.IntegerField(default=0) # Existing products overwritten
    failed_rows = models.IntegerField(default=0)
    duplicate_rows = models.IntegerField(default=0)
    processing_time = models.FloatField(default=0.0) # Seconds
    version = models.CharField(max_length=20, default='v1.0')
    column_headers = models.JSONField(default=list, blank=True) # Exact Excel header order/names

    remarks = models.TextField(blank=True, null=True)
    logs = models.JSONField(default=list, blank=True, null=True) # Step-by-step audit logs
    ip_address = models.CharField(max_length=50, blank=True, null=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['tenant', 'batch_number'], name='products_importbatch_batch_number_tenant'),
        ]

    def __str__(self):
        return f"{self.batch_number} - {self.file_name} ({self.status})"


class ImportBarcodeRow(TenantOwnedModel):
    """One sheet row due a generated barcode, from the preview until the import ends.

    slot_code belongs to the position, not to the row: the row with `rank` included rows
    before it shows the code in slot `rank`. Clearing a row is then a single UPDATE, and
    every code after it moves up by one, so the numbers never have a hole in them.
    final_code is what the row really gets, fixed once when the import starts."""
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    batch = models.ForeignKey(ImportBatch, on_delete=models.CASCADE, related_name='barcode_rows')
    position = models.IntegerField()
    row_index = models.IntegerField() # Same count as Product.import_row
    sheet_name = models.CharField(max_length=100, default='Sheet 1')
    row_number = models.IntegerField()
    product_code = models.CharField(max_length=150, blank=True, default='')
    product_name = models.CharField(max_length=255, blank=True, default='')
    slot_code = models.CharField(max_length=150)
    final_code = models.CharField(max_length=150, blank=True, null=True)
    excluded = models.BooleanField(default=False)

    class Meta:
        constraints = [models.UniqueConstraint(fields=['batch', 'position'], name='uniq_import_barcode_position')]

    def __str__(self):
        return f"Row {self.row_number}: {self.slot_code}"


class ImportPreviewRow(TenantOwnedModel):
    """One non-blank sheet row as the preview judged it, before anything is written.

    kind says what the import will do with it. Once the import ends only the UPDATE rows
    stay (without their cells): they hold the sheet's quantity for an existing product,
    which the import never writes over; Stock Overview offers it for review instead."""
    KINDS = [
        ('NEW', 'New Product'),
        ('UPDATE', 'Updates Existing Product'),
        ('DUPLICATE', 'Duplicate, Skipped'),
        ('ERROR', 'Invalid, Skipped'),
    ]
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    batch = models.ForeignKey(ImportBatch, on_delete=models.CASCADE, related_name='preview_rows')
    row_index = models.IntegerField() # Same count as Product.import_row
    sheet_name = models.CharField(max_length=100, default='Sheet 1')
    row_number = models.IntegerField()
    kind = models.CharField(max_length=10, choices=KINDS)
    product_code = models.CharField(max_length=150, blank=True, default='')
    product_name = models.CharField(max_length=255, blank=True, default='')
    error_type = models.CharField(max_length=40, blank=True, default='')
    message = models.TextField(blank=True, default='')
    file_stock = models.IntegerField(blank=True, null=True) # The sheet's quantity; None when it gave none
    existing_stock = models.IntegerField(blank=True, null=True) # UPDATE: the product's stock at preview time
    cells = models.JSONField(default=dict, blank=True) # The sheet's own cells, keyed by column_headers
    # Stock Overview's import review of an UPDATE row: APPLIED (the sheet's quantity went in
    # as adjustment_number) or KEPT (the current stock stays). Blank = not decided yet.
    review_status = models.CharField(max_length=10, blank=True, default='')
    adjustment_number = models.CharField(max_length=30, blank=True, default='')
    reviewed_by = models.CharField(max_length=150, blank=True, default='')
    reviewed_at = models.DateTimeField(blank=True, null=True)

    class Meta:
        indexes = [models.Index(fields=['batch', 'kind', 'row_index'], name='import_preview_kind_idx')]
        constraints = [models.UniqueConstraint(fields=['batch', 'row_index'], name='uniq_import_preview_row')]

    def __str__(self):
        return f"Row {self.row_number}: {self.kind}"


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
    base_sku = models.CharField(max_length=120, blank=True, null=True)
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

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['tenant', 'base_sku'], name='products_productvariantgroup_base_sku_tenant'),
        ]

    def __str__(self):
        return self.name


class ProductVariantTemplate(BaseUUIDModel):
    """Reusable Add Multiple Items configuration (category, attributes, default option
    values, tax, SKU rule, visible columns). Never holds transaction data."""
    name = models.CharField(max_length=150)
    category_name = models.CharField(max_length=150, blank=True, null=True)
    config = models.JSONField(default=dict, blank=True)

    class Meta:
        ordering = ['name']
        constraints = [
            models.UniqueConstraint(fields=['tenant', 'name'], name='products_productvarianttemplate_name_tenant'),
        ]

    def __str__(self):
        return self.name


class BulkSaveReceipt(TenantOwnedModel):
    """Idempotency record for the bulk variant save: a retried request carrying the same
    client token gets the stored response instead of creating the products twice."""
    token = models.CharField(max_length=64)
    response = models.JSONField(default=dict)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['tenant', 'token'], name='products_bulksavereceipt_token_tenant'),
        ]


# Where a product's stock came from, for Stock Overview's source filter. Blank = a regular
# product (Product Master / Purchase Entry); the others are stamped by the loader that made it.
STOCK_SOURCES = (
    ('OPENING_STOCK', 'Opening Stock'),
    ('EXCEL_IMPORT', 'Excel Import'),
    ('PURCHASE', 'Purchase Entry'),
    ('MANUAL_ADJUSTMENT', 'Manual Adjustment'),
    ('SALES_RETURN', 'Sales Return'),
    ('PURCHASE_RETURN', 'Purchase Return'),
)


class Product(BaseUUIDModel):
    name = models.CharField(max_length=255)
    sku = models.CharField(max_length=150)
    barcode = models.CharField(max_length=150, blank=True, null=True)
    # Optional second scan-in code (e.g. the manufacturer's own EAN alongside our
    # in-store code). Entered by hand, never printed as a label series; unique
    # across barcode / secondary_barcode / ProductBarcode (barcode_utils.find_barcode_owner).
    secondary_barcode = models.CharField(max_length=150, blank=True, null=True)
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
    # Shelf / bin inside the rack (Stock Overview). Optional; blank for older products.
    bin_location = models.CharField(max_length=150, blank=True, null=True)
    hsn_code = models.CharField(max_length=15, blank=True, null=True)

    cost_price = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    retail_price = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    # NOTE: despite its name this column holds the product's MRP (ProductMasterDialog /
    # variant_service / opening stock all write MRP here; the serializer exposes it as `mrp`).
    wholesale_price = models.DecimalField(max_digits=12, decimal_places=2, default=Decimal('0.0'))
    # The pre-configured wholesale selling tier used by the Wholesale POS. Null = not set
    # (the POS then falls back to MRP, then the retail sale price).
    wholesale_sale_price = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    
    minimum_stock = models.IntegerField(default=5)
    maximum_stock = models.IntegerField(default=100)
    opening_stock = models.IntegerField(default=0)
    stock = models.IntegerField(default=0)
    stock_source = models.CharField(max_length=20, choices=STOCK_SOURCES, blank=True, default='', db_default='', db_index=True)

    # Link to Batch & Active state for Archiving/Deletion
    import_batch = models.ForeignKey(ImportBatch, on_delete=models.SET_NULL, null=True, blank=True, related_name='products')
    is_active = models.BooleanField(default=True)
    # Position in the uploaded file, so a batch can be shown back in the sheet's own order.
    import_row = models.IntegerField(blank=True, null=True)
    
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
            models.UniqueConstraint(fields=['tenant', 'sku'], name='products_product_sku_tenant'),
            models.UniqueConstraint(fields=['tenant', 'barcode'], name='products_product_barcode_tenant'),
            models.UniqueConstraint(fields=['tenant', 'secondary_barcode'], name='products_product_secondary_barcode_tenant'),
            models.UniqueConstraint(
                fields=['variant_group', 'variant_key'],
                condition=models.Q(variant_group__isnull=False, variant_key__isnull=False),
                name='uniq_product_variant_combination',
            ),
        ]
        # Stock Overview filters / sorts on these over the whole catalogue.
        indexes = [
            models.Index(fields=['name'], name='product_name_idx'),
            models.Index(fields=['rack_location'], name='product_rack_idx'),
            models.Index(fields=['is_active', 'stock'], name='product_active_stock_idx'),
            models.Index(fields=['import_batch', 'import_row'], name='product_batch_row_idx'),
        ]

    def __str__(self):
        return f"{self.name} ({self.sku})"


class BarcodeSequence(TenantOwnedModel):
    """Per-prefix atomic counter used to mint unique product barcodes (see barcode_utils.reserve_barcodes)."""
    prefix = models.CharField(max_length=10)
    last_number = models.BigIntegerField(default=100000)

    class Meta:
        constraints = [
            models.UniqueConstraint(fields=['tenant', 'prefix'], name='products_barcodesequence_prefix_tenant'),
        ]

    def __str__(self):
        return f"{self.prefix} -> {self.last_number}"


class BarcodeSeriesConfig(TenantOwnedModel):
    """Singleton: how new product barcodes are generated (barcode_utils.reserve_product_barcodes).

    code = resolved prefix pattern + zero-padded running number (+ optional GS1
    mod-10 check digit), exactly `total_length` characters. `last_number` is the
    shared counter, bumped atomically with UPDATE ... RETURNING. Use .load()."""
    CHECK_DIGIT_CHOICES = [('MOD10', 'GS1 mod-10 (EAN / UPC style)'), ('NONE', 'No check digit')]

    # Literal text plus optional date tokens {YY} {YYYY} {MM} {DD}.
    prefix_pattern = models.CharField(max_length=40, default='20', blank=True)
    total_length = models.PositiveSmallIntegerField(default=13)
    check_digit = models.CharField(max_length=10, choices=CHECK_DIGIT_CHOICES, default='MOD10')
    last_number = models.BigIntegerField(default=0)
    updated_at = models.DateTimeField(auto_now=True)
    updated_by_name = models.CharField(max_length=150, blank=True, default='')

    class Meta:
        verbose_name = 'Barcode Series Configuration'
        # One per tenant; the constraint lets concurrent first loads converge on one row.
        constraints = [models.UniqueConstraint(fields=['tenant'], name='products_barcodeseriesconfig_one_per_tenant')]

    def __str__(self):
        return f"{self.prefix_pattern} / {self.total_length} digits -> {self.last_number}"

    @classmethod
    def load(cls):
        obj = cls.objects.first()
        if obj is None:
            # Continue the legacy EAN-13 counter (also done by migration 0013).
            seq = BarcodeSequence.objects.filter(prefix='EAN13').first()
            obj, _ = cls.objects.get_or_create(defaults={'last_number': seq.last_number if seq else 0})
        return obj


class ProductBarcode(TenantOwnedModel):
    """Additional scan-in barcodes that all resolve to the same product.

    When N labels are printed for one product the printer assigns each label its
    own code from the configured series (see barcode_utils.reserve_product_barcodes), so
    no two physical tags carry an identical barcode. Every code in that series is
    stored here against the product, so scanning any of them at billing still
    finds the product. Label #1 always reuses ``Product.barcode`` itself.
    """
    id = models.UUIDField(primary_key=True, default=uuid.uuid4, editable=False)
    product = models.ForeignKey(Product, on_delete=models.CASCADE, related_name='extra_barcodes')
    code = models.CharField(max_length=150, db_index=True)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        ordering = ['created_at']
        constraints = [
            models.UniqueConstraint(fields=['tenant', 'code'], name='products_productbarcode_code_tenant'),
        ]

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


class LabelTemplateVersion(TenantOwnedModel):
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

    # Fixed primary key per tenant: concurrent first requests can't each create their own
    # "singleton". The default tenant keeps the original id; others derive theirs from it.
    SINGLETON_ID = uuid.UUID('6c1a7b3e-0000-4000-8000-000000001abe')

    class Meta:
        verbose_name = 'Label Print Settings'
        verbose_name_plural = 'Label Print Settings'

    @classmethod
    def singleton_id(cls):
        from apps.common import tenancy
        tid = tenancy.current_tenant_id() or tenancy.DEFAULT_TENANT_ID
        return cls.SINGLETON_ID if tid == tenancy.DEFAULT_TENANT_ID else uuid.uuid5(cls.SINGLETON_ID, str(tid))

    @classmethod
    def load(cls):
        from django.db import IntegrityError, transaction
        obj = cls.objects.order_by('created_at').first()
        if obj is None:
            try:
                with transaction.atomic():
                    obj = cls.objects.create(id=cls.singleton_id())
            except IntegrityError:
                obj = cls.objects.get(id=cls.singleton_id())
        return obj
