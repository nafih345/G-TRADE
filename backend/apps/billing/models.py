from django.db import models, transaction

from apps.common.models import BaseUUIDModel


# Document types the Bill Rendering Engine can print. Slugs (no strict choices= on the
# model fields that store them) so the frontend stays free to extend the list — same
# rationale as apps.sales.Invoice.fulfillment_status.
DOCUMENT_TYPES = [
    ('SALES_INVOICE', 'Sales Invoice / Bill'),
    ('WHOLESALE_BILL', 'Wholesale Bill'),
    ('ORDER_BILL', 'Order Bill / Job Slip'),
    ('PURCHASE_BILL', 'Purchase Bill'),
    ('RETURN_BILL', 'Return Bill'),
    ('QUOTATION', 'Quotation'),
    ('PAYMENT_RECEIPT', 'Payment Receipt'),
]
DOCUMENT_TYPE_KEYS = [k for k, _ in DOCUMENT_TYPES]


class BillTemplate(BaseUUIDModel):
    """A reusable bill/invoice layout.

    `config` (JSON) holds the entire *presentation* definition — sections, their order,
    visibility and per-section settings, item-table columns, totals toggles,
    header/footer/barcode/QR config and global styles. The frontend Bill Rendering Engine
    (frontend/src/billing/renderBillHtml.js) is the only consumer of this shape. Nothing
    in this app touches invoice calculations, numbering, stock or accounting.
    """

    name = models.CharField(max_length=120)
    # STANDARD | COMPACT | THERMAL_80 | THERMAL_58 | JEWELLERY | WHOLESALE | CUSTOM
    template_type = models.CharField(max_length=40, default='CUSTOM')
    description = models.CharField(max_length=255, blank=True, default='')

    paper_size = models.CharField(max_length=10, default='A4')  # A4 | A5 | 58mm | 80mm | CUSTOM
    orientation = models.CharField(max_length=10, default='portrait')  # portrait | landscape
    custom_width_mm = models.DecimalField(max_digits=6, decimal_places=1, null=True, blank=True)
    custom_height_mm = models.DecimalField(max_digits=6, decimal_places=1, null=True, blank=True)
    # {"top": 12, "right": 12, "bottom": 12, "left": 12} — millimetres.
    margins = models.JSONField(default=dict, blank=True)

    config = models.JSONField(default=dict, blank=True)

    is_active = models.BooleanField(default=True)
    is_default = models.BooleanField(default=False)
    # Seeded starter template — kept so the auto-seed can tell "never customised" apart and
    # so the UI can warn before deleting the last usable layout.
    is_preset = models.BooleanField(default=False)
    thumbnail = models.TextField(blank=True, default='')  # optional cached preview data-URL

    class Meta:
        ordering = ['-is_default', 'name']

    def __str__(self):
        return f"{self.name} ({self.template_type})"

    def save(self, *args, **kwargs):
        # Keep the "at most one global default" invariant (mirrors company.Branch.save).
        with transaction.atomic():
            if self.is_default:
                BillTemplate.all_objects.filter(is_default=True).exclude(pk=self.pk).update(is_default=False)
            super().save(*args, **kwargs)


class DocumentTemplateAssignment(BaseUUIDModel):
    """Which template renders a given document type. One row per document type."""

    document_type = models.CharField(max_length=40, unique=True)
    template = models.ForeignKey(
        BillTemplate, on_delete=models.SET_NULL, null=True, blank=True, related_name='assignments'
    )

    class Meta:
        ordering = ['document_type']

    def __str__(self):
        return f"{self.document_type} -> {self.template_id}"


class BillingSettings(BaseUUIDModel):
    """Singleton row holding designer-wide options + shared branding. Use load()."""

    # When ON, `single_template` is used for every document type, ignoring per-type
    # assignments (spec section 2 — "Use this template for all documents").
    use_single_template = models.BooleanField(default=False)
    single_template = models.ForeignKey(
        BillTemplate, on_delete=models.SET_NULL, null=True, blank=True, related_name='+'
    )

    # Company logo as a base64 data URL rather than a media file: the deployment filesystem
    # is ephemeral (see the multi-branch prod notes) and the print popup / PDF needs the
    # image inline anyway. Automatically available to every template.
    logo_data_url = models.TextField(blank=True, default='')
    primary_color = models.CharField(max_length=20, blank=True, default='#2563eb')
    accent_color = models.CharField(max_length=20, blank=True, default='#0f172a')
    # Extra header lines not on the Company model: tagline, website, PAN, custom text.
    business_info = models.JSONField(default=dict, blank=True)

    class Meta:
        verbose_name = 'Billing Settings'
        verbose_name_plural = 'Billing Settings'

    def __str__(self):
        return f"BillingSettings (single_template={self.use_single_template})"

    @classmethod
    def load(cls):
        obj = cls.objects.first()
        if obj is None:
            obj = cls.objects.create()
        return obj
