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

    def __str__(self):
        return f"{self.name} ({self.sku})"


class BarcodeSequence(models.Model):
    """Per-prefix atomic counter used to mint unique product barcodes (see barcode_utils.reserve_barcodes)."""
    prefix = models.CharField(max_length=10, unique=True)
    last_number = models.BigIntegerField(default=100000)

    def __str__(self):
        return f"{self.prefix} -> {self.last_number}"


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
