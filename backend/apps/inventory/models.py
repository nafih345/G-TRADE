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

    def __str__(self):
        return f"Adj: {self.product.name} {self.adjustment_type} {self.quantity}"


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
