from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer
from .models import StockLedger, StockAdjustment, WarehouseTransfer
from .stock_utils import adjust_branch_stock
from apps.common.branch_mixins import BranchScopedViewSetMixin

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

class StockLedgerViewSet(BranchScopedViewSetMixin, viewsets.ReadOnlyModelViewSet):
    queryset = StockLedger.objects.all()
    serializer_class = StockLedgerSerializer
    # AllowAny: see SupplierViewSet in apps.purchasing.views for why — the demo/offline
    # login's mock JWT gets downgraded to AnonymousUser, so IsAuthenticated here silently
    # blocked every stock read/write from the frontend.
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

class StockAdjustmentViewSet(BranchScopedViewSetMixin, viewsets.ModelViewSet):
    queryset = StockAdjustment.objects.all()
    serializer_class = StockAdjustmentSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def perform_create(self, serializer):
        from apps.company.models import Branch
        adj = serializer.save(**self._branch_stamp_kwargs(serializer))
        tx_type = 'ADJ_ADD' if adj.adjustment_type == 'ADD' else 'ADJ_SUB'
        qty = adj.quantity if adj.adjustment_type == 'ADD' else -adj.quantity
        adjust_branch_stock(
            adj.product, adj.branch or Branch.get_default(), qty,
            ledger={
                'warehouse': adj.warehouse,
                'transaction_type': tx_type,
                'reference_id': adj.id,
                'notes': adj.reason,
            },
        )

class WarehouseTransferViewSet(viewsets.ModelViewSet):
    queryset = WarehouseTransfer.objects.all()
    serializer_class = WarehouseTransferSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

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
