"""Abstract bases shared by sales.SalesReturn / purchasing.PurchaseReturn and their lines.

Only the party, the original document and the original line differ between the two, so those
FKs live on the concrete models; everything else (numbers, settlement, totals, reasons) is here.
Imports nothing but apps.common so either app's models can use it without a cycle.
"""
from decimal import Decimal

from django.db import models

from apps.common.models import BaseUUIDModel

from .returns_catalog import PAYMENT_MODE_CHOICES, RETURN_REASONS, RETURN_STATUSES

ZERO = Decimal('0.00')


class ReturnDocumentBase(BaseUUIDModel):
    return_number = models.CharField(max_length=50)
    return_date = models.DateField()
    branch = models.ForeignKey('company.Branch', on_delete=models.SET_NULL, null=True, blank=True,
                               db_index=True, related_name='+')
    status = models.CharField(max_length=12, choices=RETURN_STATUSES, default='COMPLETED', db_index=True)
    # CASH | GPAY | BANK | CREDIT, or SPLIT when the value was settled several ways (settlements).
    payment_mode = models.CharField(max_length=10, choices=PAYMENT_MODE_CHOICES, default='CASH')
    # The bank ledger the money went out of / came into, when exactly one bank was used (GPay /
    # Bank). A split naming two banks keeps each one on its settlement row instead.
    bank_account = models.ForeignKey('financial.ChartOfAccount', on_delete=models.SET_NULL, null=True,
                                     blank=True, related_name='+')
    # [{mode, amount, bank_account, bank_name, reference}] — sums to total_refund_amount. Each
    # money row is one Cash / Bank Book line of the return's journal; CREDIT rows adjust the ledger.
    settlements = models.JSONField(default=list, blank=True)
    subtotal = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)        # value excl. tax
    tax_amount = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    total_amount = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)    # goods value incl. tax
    # What was paid back / adjusted. Always equal to total_amount today (the API refuses a
    # settlement that doesn't cover the return); kept separate because the spec names it.
    total_refund_amount = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    general_remarks = models.TextField(blank=True, default='')
    performed_by = models.CharField(max_length=150, blank=True, default='')
    cancel_reason = models.CharField(max_length=255, blank=True, default='')
    cancelled_at = models.DateTimeField(null=True, blank=True)
    cancelled_by = models.CharField(max_length=150, blank=True, default='')
    # The screen's per-entry token: a retried / double-clicked save returns the first return.
    client_token = models.CharField(max_length=100, blank=True, default='', db_index=True)

    class Meta:
        abstract = True
        ordering = ['-return_date', '-created_at']

    @property
    def is_live(self):
        return not self.is_deleted and self.status != 'CANCELLED'


class ReturnLineBase(BaseUUIDModel):
    product = models.ForeignKey('products.Product', on_delete=models.SET_NULL, null=True, blank=True,
                                related_name='+')
    description = models.CharField(max_length=255, blank=True, default='')
    sku = models.CharField(max_length=150, blank=True, default='')
    barcode = models.CharField(max_length=150, blank=True, default='')
    return_qty = models.PositiveIntegerField(default=1)
    # Units that moved stock: equals return_qty except for lens lines sold by the pair / piece,
    # which move stock in the product's own stock unit (sales.lens_units).
    stock_qty = models.PositiveIntegerField(default=0)
    unit_price = models.DecimalField(max_digits=12, decimal_places=2, default=ZERO)   # per unit, incl. tax
    tax_rate = models.DecimalField(max_digits=5, decimal_places=2, default=ZERO)
    tax_amount = models.DecimalField(max_digits=12, decimal_places=2, default=ZERO)
    line_total = models.DecimalField(max_digits=14, decimal_places=2, default=ZERO)
    # Cost per stock unit when the return was saved — the books value the stock movement at it.
    unit_cost = models.DecimalField(max_digits=12, decimal_places=2, null=True, blank=True)
    return_reason_category = models.CharField(max_length=20, choices=RETURN_REASONS, default='DEFECTIVE')
    reason_notes = models.CharField(max_length=255, blank=True, default='')
    line_no = models.PositiveIntegerField(default=0)

    class Meta:
        abstract = True
        ordering = ['line_no']
