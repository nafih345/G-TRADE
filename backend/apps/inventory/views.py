from rest_framework import viewsets, permissions
from rest_framework.exceptions import ValidationError
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
        # Optional: the viewset fills in the active branch's warehouse.
        extra_kwargs = {'warehouse': {'required': False}}

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
        from apps.sales.wholesale_stock import guard_legacy_pos_adjustment
        refused = guard_legacy_pos_adjustment(serializer.validated_data.get('reason'))
        if refused:
            raise ValidationError({'detail': refused, 'code': 'wholesale_stock_handled'})
        stamp = self._branch_stamp_kwargs(serializer)
        if serializer.validated_data.get('warehouse') is None:
            from apps.company.models import Warehouse
            branch = serializer.validated_data.get('branch') or stamp.get('branch') or Branch.get_default()
            warehouse = (Warehouse.objects.filter(branch=branch).order_by('created_at').first()
                         or Warehouse.objects.order_by('created_at').first())
            if warehouse is None:
                raise ValidationError({'warehouse': 'This business has no warehouse yet.'})
            stamp['warehouse'] = warehouse
        adj = serializer.save(**stamp)
        tx_type = 'ADJ_ADD' if adj.adjustment_type == 'ADD' else 'ADJ_SUB'
        qty = adj.quantity if adj.adjustment_type == 'ADD' else -adj.quantity
        adjust_branch_stock(
            adj.product, adj.branch or Branch.get_default(), qty,
            enforce_stock=True,
            ledger={
                'warehouse': adj.warehouse,
                'transaction_type': tx_type,
                'reference_id': adj.id,
                'notes': adj.reason,
            },
        )

class WarehouseTransferViewSet(viewsets.ModelViewSet):
    """Branch rule (P1 / N4), same as company stock transfers: visible when either warehouse is in
    one of the caller's branches; creating, changing or deleting needs the sending warehouse's
    branch, before and after the change."""
    queryset = WarehouseTransfer.objects.all()
    serializer_class = WarehouseTransferSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        from django.db.models import Q
        from apps.common.branch_context import get_active_branch, get_allowed_branch_ids, is_branch_restricted
        get_active_branch(self.request)  # 403 for an off-limits X-Branch-Id
        qs = super().get_queryset()
        if is_branch_restricted(self.request):
            allowed = list(get_allowed_branch_ids(self.request))
            qs = qs.filter(Q(from_warehouse__branch_id__in=allowed) | Q(to_warehouse__branch_id__in=allowed))
        return qs

    def _require_origin(self, warehouse):
        from apps.common.branch_context import require_branch_permitted
        require_branch_permitted(self.request, warehouse.branch_id,
                                 'Only the sending branch can create or change this transfer.')

    # P1 Task 7 / N10: a warehouse transfer moves stock exactly once — on the save that takes it
    # into COMPLETED (decided under a row lock against the stored status). A COMPLETED transfer
    # can no longer be changed or deleted, so a later PATCH can never move the stock again.
    # Warehouses of two different branches go through Branch Transfers (dispatch / receive).

    def _check_same_branch(self, data, instance=None):
        src = data.get('from_warehouse', getattr(instance, 'from_warehouse', None))
        dst = data.get('to_warehouse', getattr(instance, 'to_warehouse', None))
        if src is not None and dst is not None and src.branch_id != dst.branch_id:
            from rest_framework.exceptions import ValidationError
            raise ValidationError({'to_warehouse': 'These warehouses are in different branches. Use Inventory → '
                                                   'Branch Transfers (dispatch and receive) to move stock between branches.'})

    def perform_create(self, serializer):
        from django.db import transaction
        self._require_origin(serializer.validated_data['from_warehouse'])
        self._check_same_branch(serializer.validated_data)
        with transaction.atomic():
            transfer = serializer.save()
            if transfer.status == 'COMPLETED':
                self._apply_transfer(transfer)

    def perform_update(self, serializer):
        from django.db import transaction
        from rest_framework.exceptions import ValidationError
        self._require_origin(serializer.instance.from_warehouse)
        if 'from_warehouse' in serializer.validated_data:
            self._require_origin(serializer.validated_data['from_warehouse'])
        self._check_same_branch(serializer.validated_data, serializer.instance)
        with transaction.atomic():
            previous = WarehouseTransfer.objects.select_for_update().get(pk=serializer.instance.pk).status
            if previous == 'COMPLETED':
                raise ValidationError({'detail': 'This transfer is completed; its stock has moved and it can no longer '
                                                 'be changed.'})
            transfer = serializer.save()
            if transfer.status == 'COMPLETED':
                self._apply_transfer(transfer)

    def _apply_transfer(self, transfer):
        # Same branch: BranchStock (per branch) is unchanged; the ledger records the move between
        # the two warehouses. Written once per transfer (guarded by perform_update above).
        if StockLedger.objects.filter(reference_id=transfer.id, transaction_type='TRANSFER').exists():
            return
        branch_id = transfer.from_warehouse.branch_id
        StockLedger.objects.create(
            product=transfer.product, warehouse=transfer.from_warehouse, branch_id=branch_id,
            quantity=-transfer.quantity, transaction_type='TRANSFER', reference_id=transfer.id,
            notes=f"Transfer to {transfer.to_warehouse.name}")
        StockLedger.objects.create(
            product=transfer.product, warehouse=transfer.to_warehouse, branch_id=branch_id,
            quantity=transfer.quantity, transaction_type='TRANSFER', reference_id=transfer.id,
            notes=f"Transfer from {transfer.from_warehouse.name}")

    def perform_destroy(self, instance):
        from rest_framework.exceptions import ValidationError
        self._require_origin(instance.from_warehouse)
        if instance.status == 'COMPLETED':
            raise ValidationError({'detail': 'A completed transfer cannot be deleted.'})
        instance.delete()
