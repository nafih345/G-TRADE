from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework.serializers import ModelSerializer, PrimaryKeyRelatedField
from .models import (
    Company, Branch, Warehouse, Notification,
    BusinessSettings, UserBranchAccess, BranchStock, StockTransfer, StockTransferItem,
)

class CompanySerializer(ModelSerializer):
    class Meta:
        model = Company
        fields = '__all__'


class BranchSerializer(ModelSerializer):
    class Meta:
        model = Branch
        fields = '__all__'
        # company is auto-filled server-side when omitted (single-company install).
        extra_kwargs = {'company': {'required': False}}


class WarehouseSerializer(ModelSerializer):
    class Meta:
        model = Warehouse
        fields = '__all__'


class NotificationSerializer(ModelSerializer):
    class Meta:
        model = Notification
        fields = '__all__'


class CompanyViewSet(viewsets.ModelViewSet):
    queryset = Company.objects.all()
    serializer_class = CompanySerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        try:
            return Company.objects.all()
        except Exception:
            return Company.objects.none()


class BranchViewSet(viewsets.ModelViewSet):
    queryset = Branch.objects.all()
    serializer_class = BranchSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        try:
            qs = Branch.objects.all()
            if (self.request.query_params.get('active') or '').lower() in ('1', 'true', 'yes'):
                qs = qs.filter(is_active=True)
            return qs
        except Exception:
            return Branch.objects.none()

    def _ensure_company(self, serializer):
        if not serializer.validated_data.get('company'):
            company = Company.objects.first()
            if company is None:
                import datetime
                company = Company.objects.create(
                    name='Main Company',
                    fiscal_year_start=datetime.date(datetime.date.today().year, 4, 1),
                    fiscal_year_end=datetime.date(datetime.date.today().year + 1, 3, 31),
                )
            serializer.save(company=company)
        else:
            serializer.save()

    def perform_create(self, serializer):
        self._ensure_company(serializer)

    @action(detail=True, methods=['post'], url_path='set-default')
    def set_default(self, request, pk=None):
        branch = self.get_object()
        branch.is_default = True
        branch.is_active = True
        branch.save()  # model.save() demotes every other default
        settings_obj = BusinessSettings.load()
        settings_obj.default_branch = branch
        settings_obj.save(update_fields=['default_branch', 'updated_at'])
        return Response(BranchSerializer(branch).data)

    @action(detail=True, methods=['post'])
    def activate(self, request, pk=None):
        branch = self.get_object()
        branch.is_active = True
        branch.save(update_fields=['is_active', 'updated_at'])
        return Response(BranchSerializer(branch).data)

    @action(detail=True, methods=['post'])
    def deactivate(self, request, pk=None):
        branch = self.get_object()
        if branch.is_default:
            return Response({'detail': 'The default branch cannot be deactivated.'},
                            status=status.HTTP_400_BAD_REQUEST)
        branch.is_active = False
        branch.save(update_fields=['is_active', 'updated_at'])
        return Response(BranchSerializer(branch).data)


class WarehouseViewSet(viewsets.ModelViewSet):
    queryset = Warehouse.objects.all()
    serializer_class = WarehouseSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        try:
            return Warehouse.objects.all()
        except Exception:
            return Warehouse.objects.none()


class NotificationViewSet(viewsets.ModelViewSet):
    queryset = Notification.objects.all()
    serializer_class = NotificationSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        try:
            return Notification.objects.all()
        except Exception:
            return Notification.objects.none()

    @action(detail=False, methods=['post'], url_path='mark-all-read')
    def mark_all_read(self, request):
        try:
            Notification.objects.filter(is_read=False).update(is_read=True)
        except Exception:
            pass
        return Response({'message': 'All notifications marked as read.'}, status=status.HTTP_200_OK)


# ==========================================
# MULTI-BRANCH MANAGEMENT
# ==========================================

class BusinessSettingsSerializer(ModelSerializer):
    class Meta:
        model = BusinessSettings
        fields = ('id', 'multi_branch_enabled', 'default_branch')


class BusinessSettingsView(APIView):
    """Singleton at /api/company/business-settings/.
    GET returns the row; PATCH / PUT / POST update the multi_branch toggle + default branch."""
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get(self, request):
        return Response(BusinessSettingsSerializer(BusinessSettings.load()).data)

    def _update(self, request):
        obj = BusinessSettings.load()
        ser = BusinessSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        ser.save()
        return Response(BusinessSettingsSerializer(obj).data)

    def patch(self, request):
        return self._update(request)

    def put(self, request):
        return self._update(request)

    def post(self, request):
        return self._update(request)


class UserBranchAccessSerializer(ModelSerializer):
    branches = PrimaryKeyRelatedField(many=True, queryset=Branch.objects.all(), required=False)

    class Meta:
        model = UserBranchAccess
        fields = ('id', 'username', 'access_all_branches', 'branches', 'default_branch')


class UserBranchAccessViewSet(viewsets.ModelViewSet):
    queryset = UserBranchAccess.objects.all().prefetch_related('branches')
    serializer_class = UserBranchAccessSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        qs = UserBranchAccess.objects.all().prefetch_related('branches')
        username = self.request.query_params.get('username')
        if username:
            qs = qs.filter(username__iexact=username)
        return qs


class BranchStockSerializer(ModelSerializer):
    class Meta:
        model = BranchStock
        fields = ('id', 'product', 'branch', 'quantity')


class BranchStockViewSet(viewsets.ReadOnlyModelViewSet):
    queryset = BranchStock.objects.all()
    serializer_class = BranchStockSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        qs = BranchStock.objects.all()
        product = self.request.query_params.get('product')
        branch = self.request.query_params.get('branch')
        if product:
            qs = qs.filter(product_id=product)
        if branch:
            qs = qs.filter(branch_id=branch)
        return qs


class StockTransferItemSerializer(ModelSerializer):
    class Meta:
        model = StockTransferItem
        fields = ('id', 'product', 'quantity')
        extra_kwargs = {'transfer': {'required': False}}


class StockTransferSerializer(ModelSerializer):
    items = StockTransferItemSerializer(many=True)

    class Meta:
        model = StockTransfer
        fields = '__all__'
        extra_kwargs = {'transfer_number': {'required': False}}

    def create(self, validated_data):
        items = validated_data.pop('items', [])
        if not validated_data.get('transfer_number'):
            import time
            validated_data['transfer_number'] = f"TRF-{int(time.time()) % 1000000}"
        transfer = StockTransfer.objects.create(**validated_data)
        for it in items:
            StockTransferItem.objects.create(transfer=transfer, **it)
        return transfer

    def update(self, instance, validated_data):
        items = validated_data.pop('items', None)
        for k, v in validated_data.items():
            setattr(instance, k, v)
        instance.save()
        if items is not None:
            instance.items.all().delete()
            for it in items:
                StockTransferItem.objects.create(transfer=instance, **it)
        return instance


class StockTransferViewSet(viewsets.ModelViewSet):
    """CRUD scaffold. Stock-moving apply logic is delivered in Phase 2."""
    queryset = StockTransfer.objects.all().prefetch_related('items')
    serializer_class = StockTransferSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]


def _branch_payload(branch):
    if branch is None:
        return None
    return {
        'id': str(branch.id), 'name': branch.name, 'code': branch.code,
        'is_default': branch.is_default, 'is_active': branch.is_active,
    }


@api_view(['GET'])
@permission_classes([permissions.AllowAny])
def branch_context(request):
    """Single call the frontend uses to hydrate BranchContext: the multi-branch flag, the
    active branch for this caller, and the list of branches this caller may switch between."""
    from apps.common.branch_context import get_allowed_branch_ids

    settings_obj = BusinessSettings.load()
    default_branch = settings_obj.default_branch or Branch.get_default()
    active = getattr(request, 'active_branch', None) or default_branch
    is_admin = bool(getattr(request, 'is_branch_admin', False))

    branches = Branch.objects.filter(is_active=True)
    allowed = get_allowed_branch_ids(request)
    if allowed is not None and not is_admin:
        branches = branches.filter(id__in=allowed)

    return Response({
        'multi_branch_enabled': settings_obj.multi_branch_enabled,
        'is_admin': is_admin,
        'active_branch': _branch_payload(active),
        'default_branch': _branch_payload(default_branch),
        'branches': [_branch_payload(b) for b in branches],
    })
