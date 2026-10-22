from django.db import models
from apps.common.models import BaseUUIDModel

class ProductCategory(BaseUUIDModel):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=50, unique=True)
    description = models.TextField(blank=True, null=True)
    gst_percentage = models.CharField(max_length=20, default='18%')
    hsn_code = models.CharField(max_length=50, default='90031100')
    status = models.CharField(max_length=20, default='Active')
    display_order = models.IntegerField(default=1)

    def __str__(self):
        return f"{self.name} ({self.code})"


class Brand(BaseUUIDModel):
    name = models.CharField(max_length=100)
    code = models.CharField(max_length=50, unique=True)

    def __str__(self):
        return self.name


class Unit(BaseUUIDModel):
    name = models.CharField(max_length=50)
    code = models.CharField(max_length=20, unique=True)  # PCS, KG, LTR, etc.

    def __str__(self):
        return self.name


class Tax(BaseUUIDModel):
    """Tax master, managed from Settings → Business & Localization → Tax Configuration
    (apps/company/tax_config.py). Completed documents snapshot their rate on the line
    (InvoiceItem.tax_rate etc.), so editing a tax never rewrites history."""
    TAX_TYPES = [('GST', 'GST (CGST + SGST)'), ('IGST', 'IGST'), ('VAT', 'VAT'), ('CESS', 'Cess'),
                 ('SALES_TAX', 'Sales tax'), ('OTHER', 'Other')]
    TREATMENTS = [('EXCLUSIVE', 'Exclusive'), ('INCLUSIVE', 'Inclusive')]
    CATEGORIES = [('STANDARD', 'Standard rated'), ('ZERO_RATED', 'Zero rated'),
                  ('EXEMPT', 'Exempt'), ('NIL_RATED', 'Nil rated'), ('NON_TAXABLE', 'Non-taxable')]

    name = models.CharField(max_length=50)
    rate = models.DecimalField(max_digits=5, decimal_places=2)  # Percentage, e.g. 18.00
    tax_type = models.CharField(max_length=12, choices=TAX_TYPES, default='GST')
    treatment = models.CharField(max_length=10, choices=TREATMENTS, default='EXCLUSIVE')
    category = models.CharField(max_length=12, choices=CATEGORIES, default='STANDARD')
    applies_to_sales = models.BooleanField(default=True)
    applies_to_purchases = models.BooleanField(default=True)
    is_active = models.BooleanField(default=True)
    is_default = models.BooleanField(default=False)
    description = models.CharField(max_length=200, blank=True, default='')

    def __str__(self):
        return f"{self.name} ({self.rate}%)"


class StorageRack(BaseUUIDModel):
    warehouse = models.ForeignKey('company.Warehouse', on_delete=models.CASCADE, related_name='racks')
    name = models.CharField(max_length=100)  # e.g., Rack A, Shelf 1

    def __str__(self):
        return f"{self.name} - {self.warehouse.name}"
