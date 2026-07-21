from rest_framework import viewsets, permissions
from rest_framework.serializers import ModelSerializer
from .models import Customer, Invoice, InvoiceItem, EyeExamination
from apps.inventory.models import StockLedger

class CustomerSerializer(ModelSerializer):
    class Meta:
        model = Customer
        fields = '__all__'

class EyeExaminationSerializer(ModelSerializer):
    class Meta:
        model = EyeExamination
        fields = '__all__'

class InvoiceItemSerializer(ModelSerializer):
    class Meta:
        model = InvoiceItem
        fields = '__all__'

class InvoiceSerializer(ModelSerializer):
    items = InvoiceItemSerializer(many=True, read_only=True)

    class Meta:
        model = Invoice
        fields = '__all__'

class CustomerViewSet(viewsets.ModelViewSet):
    queryset = Customer.objects.all()
    serializer_class = CustomerSerializer
    permission_classes = [permissions.IsAuthenticated]

class EyeExaminationViewSet(viewsets.ModelViewSet):
    queryset = EyeExamination.objects.all()
    serializer_class = EyeExaminationSerializer
    permission_classes = [permissions.IsAuthenticated]

class InvoiceViewSet(viewsets.ModelViewSet):
    queryset = Invoice.objects.all()
    serializer_class = InvoiceSerializer
    permission_classes = [permissions.IsAuthenticated]

    def perform_create(self, serializer):
        invoice = serializer.save()
        if invoice.status != 'DRAFT' and invoice.status != 'CANCELLED':
            self._update_inventory(invoice)

    def perform_update(self, serializer):
        invoice = serializer.save()
        if invoice.status != 'DRAFT' and invoice.status != 'CANCELLED':
            self._update_inventory(invoice)

    def _update_inventory(self, invoice):
        # Subtract stock from default warehouse
        from apps.company.models import Warehouse
        warehouse = Warehouse.objects.first()
        if not warehouse:
            return

        for item in invoice.items.all():
            if not StockLedger.objects.filter(reference_id=invoice.id, product=item.product).exists():
                StockLedger.objects.create(
                    product=item.product,
                    warehouse=warehouse,
                    quantity=-item.quantity,
                    transaction_type='OUT',
                    reference_id=invoice.id,
                    notes=f"Sold via Invoice {invoice.invoice_number}"
                )
