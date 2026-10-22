from django.db import models
from apps.common.models import BaseUUIDModel

class StockLedger(BaseUUIDModel):
    TRANSACTION_TYPES = [
        ('IN', 'Stock In'),
        ('OUT', 'Stock Out'),
        ('ADJ_ADD', 'Adjustment Add'),
        ('ADJ_SUB', 'Adjustment Subtract'),
        ('TRANSFER', 'Transfer'),
    ]

    product = models.ForeignKey('products.Product', on_delete=models.CASCADE, related_name='stock_ledger')
    warehouse = models.ForeignKey('company.Warehouse', on_delete=models.CASCADE, related_name='stock_ledger')
    branch = models.ForeignKey('company.Branch', on_delete=models.SET_NULL, null=True, blank=True, db_index=True, related_name='+')
    quantity = models.IntegerField()
    transaction_type = models.CharField(max_length=20, choices=TRANSACTION_TYPES)
    reference_id = models.UUIDField(blank=True, null=True)  # Links to invoice, GRN, transfer, etc.
    notes = models.TextField(blank=True, null=True)
    # Audit trail shown by Stock Overview → History. Product.stock (all branches) right after
    # this movement — "previous" is balance_after - quantity. Null on rows written before
    # these columns existed; those are shown without a running balance rather than a guess.
    balance_after = models.IntegerField(blank=True, null=True)
    # Who moved the stock: the signed-in user, else the X-User-Name the frontend sends
    # (apps.common.request_actor). Blank on legacy rows.
    performed_by = models.CharField(max_length=150, blank=True, default='')
    # Human document number (PE-…, INV-…, ADJ-…) so history is readable without a join.
    reference_number = models.CharField(max_length=100, blank=True, default='')
    unit_cost = models.DecimalField(max_digits=12, decimal_places=2, blank=True, null=True)

    class Meta:
        indexes = [
            models.Index(fields=['product', 'created_at'], name='stockledger_product_time'),
            models.Index(fields=['reference_id'], name='stockledger_reference'),
        ]

    def __str__(self):
        return f"{self.product.name} - {self.transaction_type} {self.quantity}pcs"


class StockAdjustment(BaseUUIDModel):
    ADJUSTMENT_TYPES = [
        ('ADD', 'Add Stock'),
        ('SUB', 'Subtract Stock'),
    ]

    product = models.ForeignKey('products.Product', on_delete=models.CASCADE)
    warehouse = models.ForeignKey('company.Warehouse', on_delete=models.CASCADE)
    branch = models.ForeignKey('company.Branch', on_delete=models.SET_NULL, null=True, blank=True, db_index=True, related_name='+')
    quantity = models.IntegerField()
    adjustment_type = models.CharField(max_length=10, choices=ADJUSTMENT_TYPES)
    reason = models.TextField()
    # Stock Overview quantity edits: the on-hand figure before and after (Product.stock), the
    # user's reference (count sheet, memo…), who did it, and the client's one-time token so a
    # double-clicked / retried Save is applied once.
    adjustment_number = models.CharField(max_length=30, blank=True, default='', db_index=True)
    previous_quantity = models.IntegerField(blank=True, null=True)
    new_quantity = models.IntegerField(blank=True, null=True)
    reference = models.CharField(max_length=100, blank=True, default='')
    performed_by = models.CharField(max_length=150, blank=True, default='')
    client_token = models.CharField(max_length=64, unique=True, blank=True, null=True)

    def __str__(self):
        return f"Adj: {self.product.name} {self.adjustment_type} {self.quantity}"


class StockAdjustmentSequence(models.Model):
    """Atomic counter behind StockAdjustment.adjustment_number (ADJ-000001…), bumped with
    apps.common.sequences.bump_sequence like the other *Sequence tables."""
    prefix = models.CharField(max_length=10, unique=True)
    last_number = models.BigIntegerField(default=0)

    def __str__(self):
        return f"{self.prefix} -> {self.last_number}"


class WarehouseTransfer(BaseUUIDModel):
    STATUS_CHOICES = [
        ('PENDING', 'Pending'),
        ('COMPLETED', 'Completed'),
    ]

    product = models.ForeignKey('products.Product', on_delete=models.CASCADE)
    from_warehouse = models.ForeignKey('company.Warehouse', on_delete=models.CASCADE, related_name='transfers_out')
    to_warehouse = models.ForeignKey('company.Warehouse', on_delete=models.CASCADE, related_name='transfers_in')
    quantity = models.IntegerField()
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default='PENDING')

    def __str__(self):
        return f"Transfer {self.quantity} {self.product.name} ({self.status})"
