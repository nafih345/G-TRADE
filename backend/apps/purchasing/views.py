import uuid
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.serializers import ModelSerializer
from django.db import transaction
from .models import Supplier, PurchaseOrder, PurchaseOrderItem, PurchaseInvoice, PurchaseInvoiceItem
from .supplier_utils import reserve_supplier_codes, get_or_create_supplier_ledger_account
from apps.inventory.models import StockLedger

class SupplierSerializer(ModelSerializer):
    class Meta:
        model = Supplier
        fields = '__all__'

class PurchaseOrderItemSerializer(ModelSerializer):
    class Meta:
        model = PurchaseOrderItem
        fields = '__all__'
        extra_kwargs = {'purchase_order': {'required': False}}

class PurchaseOrderSerializer(ModelSerializer):
    items = PurchaseOrderItemSerializer(many=True, required=False)

    class Meta:
        model = PurchaseOrder
        fields = '__all__'

    def create(self, validated_data):
        items_data = validated_data.pop('items', [])
        order = PurchaseOrder.objects.create(**validated_data)
        for item_data in items_data:
            PurchaseOrderItem.objects.create(purchase_order=order, **item_data)
        return order

    def update(self, instance, validated_data):
        items_data = validated_data.pop('items', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if items_data is not None:
            instance.items.all().delete()
            for item_data in items_data:
                PurchaseOrderItem.objects.create(purchase_order=instance, **item_data)

        return instance

class SupplierViewSet(viewsets.ModelViewSet):
    queryset = Supplier.objects.all()
    serializer_class = SupplierSerializer
    # AllowAny (not IsAuthenticated): this app's demo/offline login issues a mock JWT that
    # LenientJWTAuthentication downgrades to AnonymousUser rather than a hard 401, so an
    # IsAuthenticated endpoint here silently rejected every "Add Supplier" attempt from the
    # frontend — the dialog appeared to work but nothing ever reached the database. Matches
    # the AllowAny pattern already used for Customer/Invoice/Payment for the same reason.
    permission_classes = [permissions.AllowAny]

    def perform_create(self, serializer):
        supplier_code = serializer.validated_data.get('supplier_code')
        if not supplier_code:
            supplier_code = reserve_supplier_codes()[0]
        supplier = serializer.save(supplier_code=supplier_code)
        supplier.ledger_account = get_or_create_supplier_ledger_account(supplier)
        supplier.save(update_fields=['ledger_account'])

class PurchaseOrderViewSet(viewsets.ModelViewSet):
    queryset = PurchaseOrder.objects.all()
    serializer_class = PurchaseOrderSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        qs = PurchaseOrder.objects.all().order_by('-order_date', '-created_at')
        status_param = self.request.query_params.get('status')
        supplier_param = self.request.query_params.get('supplier')
        if status_param:
            qs = qs.filter(status=status_param)
        if supplier_param:
            qs = qs.filter(supplier_id=supplier_param)
        return qs

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

    @action(detail=True, methods=['post'], url_path='mark-converted')
    def mark_converted(self, request, pk=None):
        # Flips status to RECEIVED without running _update_inventory: the linked
        # Purchase Entry (PurchaseInvoice) is what actually updates stock, so
        # running it here too would double-count the received quantity.
        po = self.get_object()
        po.status = 'RECEIVED'
        po.save()
        return Response(PurchaseOrderSerializer(po).data)


# ==========================================
# PURCHASE ENTRY (single-page ERP POS-style screen)
# ==========================================

class PurchaseInvoiceItemSerializer(ModelSerializer):
    class Meta:
        model = PurchaseInvoiceItem
        fields = '__all__'
        extra_kwargs = {'purchase_invoice': {'required': False}}


class PurchaseInvoiceSerializer(ModelSerializer):
    items = PurchaseInvoiceItemSerializer(many=True)

    class Meta:
        model = PurchaseInvoice
        fields = '__all__'

    def create(self, validated_data):
        items_data = validated_data.pop('items', [])
        invoice = PurchaseInvoice.objects.create(**validated_data)
        for item_data in items_data:
            PurchaseInvoiceItem.objects.create(purchase_invoice=invoice, **item_data)
        return invoice

    def update(self, instance, validated_data):
        items_data = validated_data.pop('items', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if items_data is not None:
            instance.items.all().delete()
            for item_data in items_data:
                PurchaseInvoiceItem.objects.create(purchase_invoice=instance, **item_data)

        return instance


class PurchaseInvoiceViewSet(viewsets.ModelViewSet):
    queryset = PurchaseInvoice.objects.all().order_by('-purchase_date', '-created_at')
    serializer_class = PurchaseInvoiceSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    @transaction.atomic
    def perform_create(self, serializer):
        invoice = serializer.save()
        if invoice.status not in ('DRAFT', 'CANCELLED'):
            self._apply_stock_and_payables(invoice)

    @transaction.atomic
    def perform_update(self, serializer):
        invoice = serializer.save()
        if invoice.status not in ('DRAFT', 'CANCELLED'):
            self._apply_stock_and_payables(invoice)

    def _apply_stock_and_payables(self, invoice):
        warehouse = invoice.warehouse
        if not warehouse:
            from apps.company.models import Warehouse
            warehouse = Warehouse.objects.first()

        for item in invoice.items.all():
            product = item.product
            qty_in = (item.quantity or 0) + (item.free_quantity or 0)

            product.stock = (product.stock or 0) + int(qty_in)
            if item.purchase_rate:
                product.cost_price = item.purchase_rate
            if item.selling_price:
                product.retail_price = item.selling_price
            product.save()

            if warehouse and not StockLedger.objects.filter(reference_id=invoice.id, product=product).exists():
                StockLedger.objects.create(
                    product=product,
                    warehouse=warehouse,
                    quantity=int(qty_in),
                    transaction_type='IN',
                    reference_id=invoice.id,
                    notes=f"Received via Purchase Entry {invoice.invoice_number}"
                )

        if invoice.purchase_type == 'CREDIT' and invoice.balance_amount:
            supplier = invoice.supplier
            supplier.outstanding_balance = (supplier.outstanding_balance or 0) + invoice.balance_amount
            supplier.save()

    @action(detail=False, methods=['get'], url_path='last-rate')
    def last_rate(self, request):
        product_id = request.query_params.get('product')
        supplier_id = request.query_params.get('supplier')
        if not product_id:
            return Response({'detail': 'product query param is required.'}, status=status.HTTP_400_BAD_REQUEST)

        # A product that only exists in the frontend's local inventory has a non-UUID
        # id and therefore no purchase history — answer "not found" instead of 500ing.
        try:
            uuid.UUID(str(product_id))
        except (ValueError, TypeError, AttributeError):
            return Response({'found': False})

        qs = PurchaseInvoiceItem.objects.filter(product_id=product_id).order_by('-created_at')
        if supplier_id:
            qs = qs.filter(purchase_invoice__supplier_id=supplier_id)

        last_item = qs.select_related('purchase_invoice').first()
        if not last_item:
            return Response({'found': False})

        return Response({
            'found': True,
            'purchase_rate': last_item.purchase_rate,
            'date': last_item.purchase_invoice.purchase_date,
            'invoice_number': last_item.purchase_invoice.invoice_number,
        })

    @action(detail=False, methods=['get'], url_path='check-duplicate')
    def check_duplicate(self, request):
        supplier_id = request.query_params.get('supplier')
        supplier_invoice_number = request.query_params.get('supplier_invoice_number')
        if not supplier_id or not supplier_invoice_number:
            return Response({'duplicate': False})

        matches = PurchaseInvoice.objects.filter(
            supplier_id=supplier_id,
            supplier_invoice_number__iexact=supplier_invoice_number
        ).exclude(status='CANCELLED')

        exclude_id = request.query_params.get('exclude')
        if exclude_id:
            matches = matches.exclude(id=exclude_id)

        if matches.exists():
            match = matches.first()
            return Response({
                'duplicate': True,
                'invoice_number': match.invoice_number,
                'purchase_date': match.purchase_date,
                'grand_total': match.grand_total,
            })
        return Response({'duplicate': False})
