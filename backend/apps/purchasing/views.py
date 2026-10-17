import uuid
from rest_framework import viewsets, permissions, status, serializers
from rest_framework.decorators import action
from rest_framework.response import Response
from rest_framework.serializers import ModelSerializer
from django.db import transaction, IntegrityError
from django.db.models import Prefetch
from django.utils import timezone
from .models import Supplier, PurchaseOrder, PurchaseOrderItem, PurchaseInvoice, PurchaseInvoiceItem
from .supplier_utils import reserve_supplier_codes, get_or_create_supplier_ledger_account
from apps.inventory.models import StockLedger
from apps.inventory.stock_utils import adjust_branch_stock, adjust_branch_stock_many
from apps.products.models import Product
from apps.common.branch_mixins import BranchScopedViewSetMixin
from apps.financial.banks import validate_bank_account

class SupplierSerializer(ModelSerializer):
    # Free text, not EmailField: email is informational here, and strict validation rejected
    # the whole supplier (400) whenever staff typed a partial/placeholder address.
    email = serializers.CharField(max_length=254, required=False, allow_blank=True, allow_null=True)

    class Meta:
        model = Supplier
        fields = '__all__'

    def validate_name(self, value):
        # Same company typed again (any case/spacing) must not become a second supplier row —
        # duplicates split the payable ledger and clutter the Purchase Entry picker.
        name = ' '.join((value or '').split())
        dupes = Supplier.objects.filter(name__iexact=name, is_deleted=False)
        if self.instance is not None:
            dupes = dupes.exclude(pk=self.instance.pk)
        if dupes.exists():
            raise serializers.ValidationError(f"A supplier named '{name}' already exists.")
        return name

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
        PurchaseOrderItem.objects.bulk_create(
            [PurchaseOrderItem(purchase_order=order, **item_data) for item_data in items_data])
        return order

    def update(self, instance, validated_data):
        items_data = validated_data.pop('items', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if items_data is not None:
            instance.items.all().delete()
            PurchaseOrderItem.objects.bulk_create(
                [PurchaseOrderItem(purchase_order=instance, **item_data) for item_data in items_data])
            instance._prefetched_objects_cache = {}

        return instance

class SupplierViewSet(viewsets.ModelViewSet):
    queryset = Supplier.objects.filter(is_deleted=False).order_by('supplier_code', 'name')
    serializer_class = SupplierSerializer
    # Small master list: return every supplier in one response. The global PAGE_SIZE=20 cut the
    # Suppliers Directory / pickers off at the first 20 rows.
    pagination_class = None
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
        try:
            with transaction.atomic():
                supplier = serializer.save(supplier_code=supplier_code)
        except IntegrityError:
            # Lost a race with a concurrent save of the same name (uniq_live_supplier_name_ci).
            raise serializers.ValidationError({'name': [f"A supplier named '{serializer.validated_data.get('name')}' already exists."]})
        supplier.ledger_account = get_or_create_supplier_ledger_account(supplier)
        supplier.save(update_fields=['ledger_account'])

class PurchaseOrderViewSet(BranchScopedViewSetMixin, viewsets.ModelViewSet):
    queryset = PurchaseOrder.objects.all()
    serializer_class = PurchaseOrderSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        # Lines in one query for the whole page, not one per order.
        qs = super().get_queryset().prefetch_related('items').order_by('-order_date', '-created_at')
        status_param = self.request.query_params.get('status')
        supplier_param = self.request.query_params.get('supplier')
        if status_param:
            qs = qs.filter(status=status_param)
        if supplier_param:
            qs = qs.filter(supplier_id=supplier_param)
        return qs

    def perform_create(self, serializer):
        po = serializer.save(**self._branch_stamp_kwargs(serializer))
        if po.status == 'RECEIVED':
            self._update_inventory(po)

    def perform_update(self, serializer):
        po = serializer.save()
        if po.status == 'RECEIVED':
            self._update_inventory(po)

    def _update_inventory(self, po):
        # When a PO is received, add stock to the PO's branch (default branch for legacy rows).
        from apps.company.models import Branch
        branch = po.branch or Branch.get_default()
        for item in po.items.all():
            if StockLedger.objects.filter(reference_id=po.id, product=item.product).exists():
                continue
            adjust_branch_stock(
                item.product, branch, item.quantity,
                ledger={
                    'transaction_type': 'IN',
                    'reference_id': po.id,
                    'notes': f"Received via PO {po.order_number}",
                },
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

class _PrefetchedProductField(serializers.PrimaryKeyRelatedField):
    """Product PK that resolves from the products PurchaseInvoiceSerializer fetched in one
    query, instead of one lookup per line. Unknown ids fall through to normal validation."""

    def to_internal_value(self, data):
        product = self.context.get('_purchase_products', {}).get(str(data))
        return product if product is not None else super().to_internal_value(data)


class PurchaseInvoiceItemSerializer(ModelSerializer):
    # Read-only convenience for the Purchase Order Reports list and the "Edit" flow:
    # the raw model only stores the product UUID, but both the report table and the
    # re-populated Purchase Entry grid need the product's display name.
    product_name = serializers.CharField(source='product.name', read_only=True)
    product = _PrefetchedProductField(queryset=Product.objects.all())

    class Meta:
        model = PurchaseInvoiceItem
        fields = '__all__'
        extra_kwargs = {'purchase_invoice': {'required': False}}


class PurchaseInvoiceSerializer(ModelSerializer):
    items = PurchaseInvoiceItemSerializer(many=True)
    supplier_name = serializers.CharField(source='supplier.name', read_only=True)
    # Validate against every supplier, not just active ones: the default `Supplier.objects`
    # manager hides soft-deleted rows, so a PurchaseInvoice whose supplier was later deleted
    # would otherwise fail PK validation on every future save ("object does not exist"),
    # permanently locking that invoice out of edits even though it still reads back fine.
    supplier = serializers.PrimaryKeyRelatedField(queryset=Supplier.all_objects.all())
    bank_account_name = serializers.CharField(source='bank_account.name', read_only=True, default=None)

    class Meta:
        model = PurchaseInvoice
        fields = '__all__'

    def validate_bank_account(self, value):
        return validate_bank_account(value)

    def to_internal_value(self, data):
        # Fetch every line's product in one query up front (see _PrefetchedProductField).
        items = data.get('items') if hasattr(data, 'get') else None
        if isinstance(items, list):
            ids = set()
            for item in items:
                try:
                    ids.add(uuid.UUID(str(item.get('product'))))
                except (ValueError, TypeError, AttributeError):
                    pass
            field = self.fields['items'].child.fields['product']
            self.context['_purchase_products'] = (
                {str(p.pk): p for p in field.get_queryset().filter(pk__in=ids)} if ids else {})
        return super().to_internal_value(data)

    def validate(self, attrs):
        attrs = super().validate(attrs)
        method = attrs.get('payment_method', self.instance.payment_method if self.instance else 'CASH')
        # A bank only means something for BANK / UPI, Paid/Unpaid only for CASH — drop stale
        # values left over from switching the pay mode, so the books never use them.
        if method not in ('BANK', 'UPI'):
            attrs['bank_account'] = None
        if method != 'CASH':
            attrs['payment_status'] = ''
        elif attrs.get('payment_status') == 'UNPAID':
            attrs['paid_amount'] = 0
        return attrs

    def create(self, validated_data):
        items_data = validated_data.pop('items', [])
        invoice = PurchaseInvoice.objects.create(**validated_data)
        # One INSERT for all lines. bulk_create skips the items' post_save, which only queues
        # this invoice for accounting — and the header save above has already queued it.
        PurchaseInvoiceItem.objects.bulk_create(
            [PurchaseInvoiceItem(purchase_invoice=invoice, **item_data) for item_data in items_data])
        return invoice

    def update(self, instance, validated_data):
        items_data = validated_data.pop('items', None)
        for attr, value in validated_data.items():
            setattr(instance, attr, value)
        instance.save()

        if items_data is not None:
            instance.items.all().delete()
            PurchaseInvoiceItem.objects.bulk_create(
                [PurchaseInvoiceItem(purchase_invoice=instance, **item_data) for item_data in items_data])

        return instance


def _owes_supplier(invoice):
    """Whether this entry's balance is still owed to the supplier: a credit purchase, or a cash
    one whose cash was marked Unpaid."""
    return invoice.purchase_type == 'CREDIT' or (
        invoice.payment_method == 'CASH' and invoice.payment_status == 'UNPAID')


class PurchaseInvoiceViewSet(BranchScopedViewSetMixin, viewsets.ModelViewSet):
    # Joined/prefetched so serializing a list (or the save response) costs a few queries
    # instead of supplier + bank + every line's product, one round trip each.
    queryset = PurchaseInvoice.objects.all().order_by('-purchase_date', '-created_at') \
        .select_related('supplier', 'bank_account') \
        .prefetch_related(Prefetch('items', queryset=PurchaseInvoiceItem.objects.select_related('product')))
    serializer_class = PurchaseInvoiceSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def _reload_for_response(self, serializer):
        """Point the serializer at a prefetched copy so the save response is cheap too."""
        fresh = self.queryset.model.objects.filter(pk=serializer.instance.pk) \
            .select_related('supplier', 'bank_account') \
            .prefetch_related(Prefetch('items', queryset=PurchaseInvoiceItem.objects.select_related('product'))) \
            .first()
        if fresh is not None:
            serializer.instance = fresh

    @transaction.atomic
    def perform_create(self, serializer):
        invoice = serializer.save(**self._branch_stamp_kwargs(serializer))
        if invoice.status not in ('DRAFT', 'CANCELLED'):
            self._apply_stock_and_payables(invoice)
        self._reload_for_response(serializer)

    @transaction.atomic
    def perform_update(self, serializer):
        # Editing an existing entry (the "Edit" button on Purchase Order Reports).
        # Reverse whatever stock and credit balance the previous version applied
        # *before* the serializer deletes/recreates the item rows below — otherwise
        # a quantity edit never reaches BranchStock: _apply_stock_and_payables skips
        # any product that already has a StockLedger row for this invoice, which
        # every re-saved line always does.
        # Row lock: two simultaneous saves of the same entry must not both reverse and
        # re-apply its stock (that would double-count the received quantity).
        old = PurchaseInvoice.objects.select_for_update().filter(pk=serializer.instance.pk).first()
        if old and old.status not in ('DRAFT', 'CANCELLED'):
            self._reverse_stock_and_payables(old)

        invoice = serializer.save()
        if invoice.status not in ('DRAFT', 'CANCELLED'):
            self._apply_stock_and_payables(invoice)
        self._reload_for_response(serializer)

    def _reverse_stock_and_payables(self, invoice):
        from apps.company.models import Branch
        branch = invoice.branch or Branch.get_default()

        # Undo exactly what the ledger says was received, rather than re-deriving it from the
        # lines: that is the quantity that actually moved BranchStock.
        rows = list(StockLedger.objects.filter(reference_id=invoice.id, branch=branch).select_related('product'))
        deltas = {}
        for row in rows:
            deltas[row.product] = deltas.get(row.product, 0) - int(row.quantity or 0)
        adjust_branch_stock_many(deltas, branch)
        if rows:
            StockLedger.objects.filter(pk__in=[r.pk for r in rows]).delete()  # soft delete

        if _owes_supplier(invoice) and invoice.balance_amount:
            supplier = invoice.supplier
            supplier.outstanding_balance = (supplier.outstanding_balance or 0) - invoice.balance_amount
            supplier.save(update_fields=['outstanding_balance'])

    def _apply_stock_and_payables(self, invoice):
        from apps.company.models import Branch
        branch = invoice.branch or Branch.get_default()
        warehouse = invoice.warehouse

        # Batched: a fixed handful of queries for the whole entry, not ~20 per line. On the
        # hosted stack every query is a round trip to the database, and the per-line version
        # made a many-line save take seconds.
        products, qty_by_product = {}, {}
        for item in invoice.items.select_related('product'):
            product = products.setdefault(item.product_id, item.product)
            if item.purchase_rate:
                product.cost_price = item.purchase_rate
            if item.selling_price:
                product.retail_price = item.selling_price
            # Two lines of the same product both count (one ledger row carries the sum).
            qty_by_product[item.product_id] = qty_by_product.get(item.product_id, 0) \
                + int((item.quantity or 0) + (item.free_quantity or 0))
        if products:
            now = timezone.now()
            for product in products.values():
                product.updated_at = now
            Product.objects.bulk_update(products.values(), ['cost_price', 'retail_price', 'updated_at'])

            received = set(StockLedger.objects.filter(reference_id=invoice.id, product_id__in=products)
                           .values_list('product_id', flat=True))
            adjust_branch_stock_many(
                {products[pk]: qty for pk, qty in qty_by_product.items() if pk not in received},
                branch,
                ledger={
                    'warehouse': warehouse,
                    'transaction_type': 'IN',
                    'reference_id': invoice.id,
                    'notes': f"Received via Purchase Entry {invoice.invoice_number}",
                },
            )

        if _owes_supplier(invoice) and invoice.balance_amount:
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
