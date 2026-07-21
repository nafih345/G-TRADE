from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer
from .models import Supplier, PurchaseOrder, PurchaseOrderItem
from apps.inventory.models import StockLedger

class SupplierSerializer(ModelSerializer):
    class Meta:
        model = Supplier
        fields = '__all__'

class PurchaseOrderItemSerializer(ModelSerializer):
    class Meta:
        model = PurchaseOrderItem
        fields = '__all__'

class PurchaseOrderSerializer(ModelSerializer):
    items = PurchaseOrderItemSerializer(many=True, read_only=True)

    class Meta:
        model = PurchaseOrder
        fields = '__all__'

class SupplierViewSet(viewsets.ModelViewSet):
    queryset = Supplier.objects.all()
    serializer_class = SupplierSerializer
    permission_classes = [permissions.IsAuthenticated]

class PurchaseOrderViewSet(viewsets.ModelViewSet):
    queryset = PurchaseOrder.objects.all()
    serializer_class = PurchaseOrderSerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        po = serializer.save()
        if po.status == 'RECEIVED':
            self._update_inventory(po)

    def perform_update(self, serializer):
        po = serializer.save()
        if po.status == 'RECEIVED':
            self._update_inventory(po)

    def _update_inventory(self, po):
        # When a PO is received, update stock ledger
        # We need a default warehouse; for now we look up the first available warehouse.
        from apps.company.models import Warehouse
        warehouse = Warehouse.objects.first()
        if not warehouse:
            return

        for item in po.items.all():
            # Check if ledger entry already exists to avoid double entry
            if not StockLedger.objects.filter(reference_id=po.id, product=item.product).exists():
                StockLedger.objects.create(
                    product=item.product,
                    warehouse=warehouse,
                    quantity=item.quantity,
                    transaction_type='IN',
                    reference_id=po.id,
                    notes=f"Received via PO {po.order_number}"
                )
