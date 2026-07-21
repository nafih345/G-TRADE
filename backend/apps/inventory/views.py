from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer
from .models import StockLedger, StockAdjustment, WarehouseTransfer

class StockLedgerSerializer(ModelSerializer):
    class Meta:
        model = StockLedger
        fields = '__all__'

class StockAdjustmentSerializer(ModelSerializer):
    class Meta:
        model = StockAdjustment
        fields = '__all__'

class WarehouseTransferSerializer(ModelSerializer):
    class Meta:
        model = WarehouseTransfer
        fields = '__all__'

class StockLedgerViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = StockLedger.objects.all()
    serializer_class = StockLedgerSerializer
    permission_classes = [permissions.IsAuthenticated]

class StockAdjustmentViewSet(viewsets.ModelViewSet):
    queryset = StockAdjustment.objects.all()
    serializer_class = StockAdjustmentSerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        adj = serializer.save()
        # Log to ledger
        tx_type = 'ADJ_ADD' if adj.adjustment_type == 'ADD' else 'ADJ_SUB'
        qty = adj.quantity if adj.adjustment_type == 'ADD' else -adj.quantity
        StockLedger.objects.create(
            product=adj.product,
            warehouse=adj.warehouse,
            quantity=qty,
            transaction_type=tx_type,
            reference_id=adj.id,
            notes=adj.reason
        )

class WarehouseTransferViewSet(viewsets.ModelViewSet):
    queryset = WarehouseTransfer.objects.all()
    serializer_class = WarehouseTransferSerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        transfer = serializer.save()
        if transfer.status == 'COMPLETED':
            self._apply_transfer(transfer)

    def perform_update(self, serializer):
        transfer = serializer.save()
        if transfer.status == 'COMPLETED':
            self._apply_transfer(transfer)

    def _apply_transfer(self, transfer):
        # Subtract from origin
        StockLedger.objects.create(
            product=transfer.product,
            warehouse=transfer.from_warehouse,
            quantity=-transfer.quantity,
            transaction_type='TRANSFER',
            reference_id=transfer.id,
            notes=f"Transfer to {transfer.to_warehouse.name}"
        )
        # Add to destination
        StockLedger.objects.create(
            product=transfer.product,
            warehouse=transfer.to_warehouse,
            quantity=transfer.quantity,
            transaction_type='TRANSFER',
            reference_id=transfer.id,
            notes=f"Transfer from {transfer.from_warehouse.name}"
        )
