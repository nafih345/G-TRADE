import datetime
import logging

from django.db import transaction
from django.db.utils import OperationalError, ProgrammingError
from rest_framework import viewsets, permissions, status
from rest_framework.decorators import action, api_view, permission_classes
from rest_framework.response import Response
from rest_framework.views import APIView
from rest_framework import serializers
from rest_framework.serializers import ModelSerializer, PrimaryKeyRelatedField, SerializerMethodField
from .models import (
    Company, Branch, Warehouse, Notification,
    BusinessSettings, UserBranchAccess, BranchStock, StockTransfer, StockTransferItem, StockTransferEvent,
)

logger = logging.getLogger('django')

class CompanySerializer(ModelSerializer):
    class Meta:
        model = Company
        fields = '__all__'


class BranchSerializer(ModelSerializer):
    # The logo is read/written only through store-profile/branch-logo/ (it can be ~1 MB, and every
    # branch list would otherwise carry it); lists just say whether one is set.
    has_logo = SerializerMethodField()

    class Meta:
        model = Branch
        exclude = ('logo_data_url',)
        # company is auto-filled server-side when omitted (single-company install).
        extra_kwargs = {'company': {'required': False}}

    def get_has_logo(self, obj):
        return bool(obj.logo_data_url)


class WarehouseSerializer(ModelSerializer):
    class Meta:
        model = Warehouse
        fields = '__all__'


class NotificationSerializer(ModelSerializer):
    class Meta:
        model = Notification
        fields = '__all__'


class CompanyViewSet(viewsets.ModelViewSet):
    """Legacy raw Company CRUD. The Settings screen uses /api/company/store-profile/ (which
    updates the one store row instead of creating duplicates); writes here need the same role."""
    queryset = Company.objects.all()
    serializer_class = CompanySerializer

    def get_permissions(self):
        from .store_profile import StoreSettingsPermission
        return [StoreSettingsPermission()]

    def perform_authentication(self, request):
        if request.method not in permissions.SAFE_METHODS:
            request.user  # noqa: B018 — forces authentication

    def get_queryset(self):
        try:
            return Company.objects.all()
        except Exception:
            return Company.objects.none()


class _NoBranchRestrictedWrites:
    """P1 Task 8: the branch and warehouse masters shape every branch's data; a branch-restricted
    user may read them but not change branches (create, edit, default, (de)activate, delete)."""

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        from rest_framework.permissions import SAFE_METHODS
        from apps.common.branch_context import is_branch_restricted
        if request.method not in SAFE_METHODS and is_branch_restricted(request) and self.restrict_all_writes:
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied('Only users with access to every branch can change branches.')

    restrict_all_writes = True


class BranchViewSet(_NoBranchRestrictedWrites, viewsets.ModelViewSet):
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

    def _license_branch_check(self, tenant=None):
        """Refuse one more active branch beyond the subscription's branch limit (Client Management,
        Tenant.max_branches) or, on the Windows edition, the licence."""
        from rest_framework.exceptions import PermissionDenied
        from apps.common import tenancy
        from apps.common.edition import is_local, license_check
        from apps.common.models import Tenant
        from apps.common.tenant_onboarding import OnboardingError, check_branch_available
        tenant = tenant or Tenant.objects.filter(pk=tenancy.current_tenant_id() or tenancy.default_tenant_id()).first()
        try:
            check_branch_available(tenant)
        except OnboardingError as exc:
            raise PermissionDenied({'detail': exc.message, 'code': 'branch_limit'})
        if not is_local():
            return
        try:
            license_check('branches', tenant=tenant)
        except Exception as exc:
            if exc.__class__.__name__ == 'LicenseLimitError':
                raise PermissionDenied(exc.message)
            raise

    def perform_create(self, serializer):
        if serializer.validated_data.get('is_active', True):
            self._license_branch_check()
        self._ensure_company(serializer)

    def perform_update(self, serializer):
        # Re-activating a branch through a plain edit counts against the limit like `activate`.
        if serializer.validated_data.get('is_active') is True and not serializer.instance.is_active:
            self._license_branch_check(serializer.instance.tenant)
        serializer.save()

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
        if not branch.is_active:
            self._license_branch_check(branch.tenant)
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
    """P1 Task 8: a branch-restricted user lists only their branches' warehouses and may create,
    change or delete a warehouse only inside them (before and after the change). Warehouses with
    no branch are company-level: unrestricted users only."""
    queryset = Warehouse.objects.all()
    serializer_class = WarehouseSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        from apps.common.branch_context import get_active_branch, scope_to_permitted
        get_active_branch(self.request)  # 403 for an off-limits X-Branch-Id
        try:
            return scope_to_permitted(self.request, Warehouse.objects.all())
        except Exception:
            return Warehouse.objects.none()

    def _require(self, branch_id):
        from apps.common.branch_context import require_branch_permitted
        require_branch_permitted(self.request, branch_id, 'That warehouse belongs to a branch you cannot use.')

    def perform_create(self, serializer):
        branch = serializer.validated_data.get('branch')
        self._require(branch.pk if branch is not None else None)
        serializer.save()

    def perform_update(self, serializer):
        self._require(serializer.instance.branch_id)
        if 'branch' in serializer.validated_data:
            branch = serializer.validated_data['branch']
            self._require(branch.pk if branch is not None else None)
        serializer.save()

    def perform_destroy(self, instance):
        self._require(instance.branch_id)
        instance.delete()


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


def _ensure_default_branch():
    """Return the default Branch, creating a Company + Head Office branch if none exists.
    Enabling Multi-Branch Mode needs a branch for every operation to fall back to."""
    branch = Branch.get_default()
    if branch is not None:
        return branch
    company = Company.objects.first()
    if company is None:
        today = datetime.date.today()
        company = Company.objects.create(
            name='Main Company',
            fiscal_year_start=datetime.date(today.year, 4, 1),
            fiscal_year_end=datetime.date(today.year + 1, 3, 31),
        )
    return Branch.objects.create(
        company=company, name='Head Office', code='HO', is_default=True, is_active=True,
    )


class BusinessSettingsView(APIView):
    """Singleton at /api/company/business-settings/.
    GET returns the row; PATCH / PUT / POST update the multi_branch toggle + default branch.

    Every handler runs through `_run`, which self-heals a schema that is behind the deployed
    code: the first time a query raises ProgrammingError/OperationalError (missing
    company_businesssettings table / multi_branch_enabled column — i.e. the Multi-Branch
    migrations never ran in this environment) it applies the pending migrations and retries
    once, then returns an actionable 503 instead of a bare 500 if that still fails."""
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def _run(self, fn):
        try:
            return fn()
        except (ProgrammingError, OperationalError) as exc:
            logger.warning("business-settings: schema behind code (%s); attempting self-heal.", exc)
            healed = False
            try:
                from apps.common.startup import run_migrations_now
                healed = run_migrations_now("business-settings endpoint hit missing branch schema")
            except Exception:
                logger.exception("business-settings: self-heal migrate raised.")
            if healed:
                try:
                    return fn()
                except (ProgrammingError, OperationalError):
                    logger.exception("business-settings: still failing after migrate.")
            return Response(
                {'detail': 'The Multi-Branch database schema is not deployed in this '
                           'environment yet. Run "python manage.py migrate" against the '
                           'backend database, then retry. See /api/health/ for the pending '
                           'migration list.'},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

    def _apply(self, request):
        obj = BusinessSettings.load()
        ser = BusinessSettingsSerializer(obj, data=request.data, partial=True)
        ser.is_valid(raise_exception=True)
        if ser.validated_data.get('multi_branch_enabled') and obj.default_branch_id is None:
            ser.save(default_branch=_ensure_default_branch())
        else:
            ser.save()
        obj.refresh_from_db()
        return Response(BusinessSettingsSerializer(obj).data)

    def get(self, request):
        return self._run(lambda: Response(BusinessSettingsSerializer(BusinessSettings.load()).data))

    def patch(self, request):
        return self._run(lambda: self._apply(request))

    def put(self, request):
        return self._run(lambda: self._apply(request))

    def post(self, request):
        return self._run(lambda: self._apply(request))


def _uuid_ok(value):
    from apps.common.branch_mixins import _is_uuid
    return _is_uuid(value)


class UserBranchAccessSerializer(ModelSerializer):
    """P1 Task 4: rows are keyed by the stable `user` id. Clients may keep sending `username`;
    the server resolves it to the user of this client (exact name, else the single
    case-insensitive match). `linked` is False for a row no user resolves to (it applies to
    nobody)."""
    branches = PrimaryKeyRelatedField(many=True, queryset=Branch.objects.all(), required=False)
    username = serializers.CharField(max_length=150, required=False, allow_blank=True)
    linked = serializers.SerializerMethodField()

    class Meta:
        model = UserBranchAccess
        fields = ('id', 'username', 'user', 'linked', 'access_all_branches', 'branches', 'default_branch')
        read_only_fields = ('user',)

    def get_linked(self, obj):
        return obj.user_id is not None

    def validate(self, attrs):
        from apps.common import tenancy
        raw_user = (self.initial_data or {}).get('user') if hasattr(self.initial_data, 'get') else None
        username = (attrs.get('username') or '').strip()
        user = None
        if raw_user:
            from django.contrib.auth import get_user_model
            user = get_user_model().objects.filter(pk=raw_user, tenant_id=tenancy.current_tenant_id()).first() \
                if _uuid_ok(raw_user) else None
            if user is None:
                raise serializers.ValidationError({'user': 'Unknown user.'})
        elif username:
            user = UserBranchAccess.match_user(username, tenancy.current_tenant_id())
        elif self.instance is None:
            raise serializers.ValidationError({'username': 'Choose the user.'})
        if user is not None:
            attrs['user'] = user
            attrs['username'] = user.username
        return attrs


class UserBranchAccessViewSet(_NoBranchRestrictedWrites, viewsets.ModelViewSet):
    """P1 Task 8: a branch-restricted user reads only their own row and cannot change any (the
    admin module gate already limits writes by role; this closes it for restricted admins too)."""
    queryset = UserBranchAccess.objects.all().prefetch_related('branches')
    serializer_class = UserBranchAccessSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        qs = UserBranchAccess.objects.all().prefetch_related('branches')
        from apps.common.branch_context import is_branch_restricted
        if is_branch_restricted(self.request):
            user = getattr(self.request, 'user', None)
            qs = qs.filter(user_id=user.pk) if getattr(user, 'is_authenticated', False) else qs.none()
        user = self.request.query_params.get('user')
        username = self.request.query_params.get('username')
        if user:
            qs = qs.filter(user_id=user) if _uuid_ok(user) else qs.none()
        elif username:
            qs = qs.filter(username__iexact=username)
        return qs

    def create(self, request, *args, **kwargs):
        """One row per user: saving access for a user who already has a row updates it
        (instead of a second row the unique constraint would refuse)."""
        serializer = self.get_serializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        existing = UserBranchAccess.for_user(serializer.validated_data.get('user'))
        if existing is not None:
            serializer = self.get_serializer(existing, data=request.data, partial=True)
            serializer.is_valid(raise_exception=True)
            serializer.save()
            return Response(serializer.data)
        self.perform_create(serializer)
        return Response(serializer.data, status=status.HTTP_201_CREATED)


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
        from apps.common.branch_context import get_active_branch, require_branch_permitted, scope_to_permitted
        get_active_branch(self.request)  # 403 for an off-limits X-Branch-Id
        # Per-branch stock figures: a branch-restricted user reads only their branches (P1 / N4).
        qs = scope_to_permitted(self.request, BranchStock.objects.all())
        product = self.request.query_params.get('product')
        branch = self.request.query_params.get('branch')
        if product:
            qs = qs.filter(product_id=product)
        if branch:
            require_branch_permitted(self.request, branch)
            qs = qs.filter(branch_id=branch)
        return qs


class StockTransferItemSerializer(ModelSerializer):
    product_name = serializers.CharField(source='product.name', read_only=True, default='')
    product_sku = serializers.CharField(source='product.sku', read_only=True, default='')
    in_transit_quantity = serializers.IntegerField(read_only=True)

    class Meta:
        model = StockTransferItem
        fields = ('id', 'product', 'product_name', 'product_sku', 'quantity', 'received_quantity',
                  'returned_quantity', 'in_transit_quantity', 'unit_cost')
        read_only_fields = ('received_quantity', 'returned_quantity', 'unit_cost')
        extra_kwargs = {'transfer': {'required': False}}

    def validate_quantity(self, value):
        if int(value or 0) <= 0:
            raise serializers.ValidationError('Quantity must be more than zero.')
        return value


class StockTransferEventSerializer(ModelSerializer):
    branch_name = serializers.CharField(source='branch.name', read_only=True, default='')

    class Meta:
        model = StockTransferEvent
        fields = ('id', 'kind', 'branch', 'branch_name', 'warehouse', 'quantities', 'value', 'performed_by',
                  'performed_at')


class StockTransferSerializer(ModelSerializer):
    """P1 Task 7. The number comes from Settings → Numbering Sequences (TRF-) and the status only
    changes through dispatch / receive / cancel; clients edit the lines of a DRAFT only."""
    items = StockTransferItemSerializer(many=True)
    events = StockTransferEventSerializer(many=True, read_only=True)
    from_branch_name = serializers.CharField(source='from_branch.name', read_only=True, default='')
    to_branch_name = serializers.CharField(source='to_branch.name', read_only=True, default='')
    from_warehouse_name = serializers.CharField(source='from_warehouse.name', read_only=True, default=None)
    to_warehouse_name = serializers.CharField(source='to_warehouse.name', read_only=True, default=None)

    class Meta:
        model = StockTransfer
        fields = '__all__'
        read_only_fields = ('transfer_number', 'status', 'transferred_at', 'dispatched_at', 'dispatched_by',
                            'received_at', 'received_by', 'cancelled_at', 'cancelled_by', 'cancel_reason')

    def validate(self, attrs):
        attrs = super().validate(attrs)
        src = attrs.get('from_branch', getattr(self.instance, 'from_branch', None))
        dst = attrs.get('to_branch', getattr(self.instance, 'to_branch', None))
        if src is not None and dst is not None and src.pk == dst.pk:
            raise serializers.ValidationError({'to_branch': 'The receiving branch must be different from the sending branch.'})
        for side, branch in (('from', src), ('to', dst)):
            wh = attrs.get(f'{side}_warehouse', getattr(self.instance, f'{side}_warehouse', None))
            if wh is not None and branch is not None and wh.branch_id not in (None, branch.pk):
                raise serializers.ValidationError({f'{side}_warehouse': f'That warehouse is not in {branch.name}.'})
        if self.instance is None and not attrs.get('items'):
            raise serializers.ValidationError({'items': 'Add at least one product.'})
        return attrs

    def create(self, validated_data):
        from apps.sales.wholesale_orders import issue_document_number
        items = validated_data.pop('items', [])
        with transaction.atomic():
            validated_data['transfer_number'] = issue_document_number(
                StockTransfer, 'transfer_number', 'STOCK_TRANSFER', 'TRF-')
            validated_data['status'] = 'DRAFT'
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
    """Inventory → Branch Transfers (P1 Task 7; workflow in apps/inventory/branch_transfer.py).

    Branch rule, Multi-Branch ON and a branch-restricted caller: a transfer is visible when either
    end is one of the caller's branches (the receiving branch sees what is coming; ?direction=
    incoming|outgoing narrows it). Creating, editing, deleting, dispatching and cancelling need the
    sending branch; receiving needs the receiving branch. Only DRAFT transfers can be edited or
    deleted — a dispatched transfer's lines and branches are frozen, and history is never removed."""
    queryset = StockTransfer.objects.all().select_related(
        'from_branch', 'to_branch', 'from_warehouse', 'to_warehouse').prefetch_related(
        'items__product', 'events__branch')
    serializer_class = StockTransferSerializer
    authentication_classes = []
    permission_classes = [permissions.AllowAny]

    def get_queryset(self):
        from django.db.models import Q
        from apps.common.branch_context import get_active_branch, get_allowed_branch_ids, is_branch_restricted
        get_active_branch(self.request)  # 403 for an off-limits X-Branch-Id
        qs = super().get_queryset()
        allowed = list(get_allowed_branch_ids(self.request)) if is_branch_restricted(self.request) else None
        if allowed is not None:
            qs = qs.filter(Q(from_branch_id__in=allowed) | Q(to_branch_id__in=allowed))
        p = self.request.query_params
        mine = allowed
        if mine is None and getattr(self.request, 'multi_branch_enabled', False) and p.get('direction'):
            active = getattr(self.request, 'active_branch', None)
            mine = [str(active.pk)] if active is not None else None
        if p.get('direction') == 'incoming' and mine is not None:
            qs = qs.filter(to_branch_id__in=mine)
        elif p.get('direction') == 'outgoing' and mine is not None:
            qs = qs.filter(from_branch_id__in=mine)
        if p.get('status'):
            qs = qs.filter(status__in=[x for x in p['status'].upper().split(',') if x])
        if p.get('search'):
            qs = qs.filter(Q(transfer_number__icontains=p['search']) | Q(notes__icontains=p['search']))
        return qs

    def _require_origin(self, branch_id):
        from apps.common.branch_context import require_branch_permitted
        require_branch_permitted(self.request, branch_id,
                                 'Only the sending branch can create or change this stock transfer.')

    def _require_draft(self, instance):
        from apps.inventory.branch_transfer import TransferConflict
        if instance.status not in StockTransfer.EDITABLE_STATUSES:
            raise TransferConflict({'detail': f'Transfer {instance.transfer_number} is '
                                              f'{instance.get_status_display().lower()}; only a draft can be changed.'})

    def perform_create(self, serializer):
        # The receiving end only has to be a branch of this client (tenant-scoped FK: else 400).
        self._require_origin(serializer.validated_data['from_branch'].pk)
        serializer.save()

    def update(self, request, *args, **kwargs):
        # Authorization before validation (P1): a branch the caller may not use is 403 even when
        # the body would also be invalid, and the stored sending branch is checked first.
        from apps.common.branch_context import resolve_requested_branch
        instance = self.get_object()
        self._require_origin(instance.from_branch_id)
        if hasattr(request.data, 'get') and request.data.get('from_branch'):
            resolve_requested_branch(request, request.data.get('from_branch'))
        return super().update(request, *args, **kwargs)

    def perform_update(self, serializer):
        with transaction.atomic():
            locked = StockTransfer.objects.select_for_update().get(pk=serializer.instance.pk)
            self._require_origin(locked.from_branch_id)
            self._require_draft(locked)
            if 'from_branch' in serializer.validated_data:
                self._require_origin(serializer.validated_data['from_branch'].pk)
            serializer.save()

    def perform_destroy(self, instance):
        with transaction.atomic():
            locked = StockTransfer.objects.select_for_update().get(pk=instance.pk)
            self._require_origin(locked.from_branch_id)
            self._require_draft(locked)
            locked.delete()

    @action(detail=True, methods=['post'], url_path='dispatch')
    def dispatch_transfer(self, request, pk=None):
        from apps.inventory.branch_transfer import dispatch
        t = dispatch(self.get_object(), request)
        return Response(self.get_serializer(self.get_queryset().get(pk=t.pk)).data)

    @action(detail=True, methods=['post'])
    def receive(self, request, pk=None):
        from apps.inventory.branch_transfer import receive
        quantities = request.data.get('quantities') if hasattr(request.data, 'get') else None
        t = receive(self.get_object(), quantities or None, request)
        return Response(self.get_serializer(self.get_queryset().get(pk=t.pk)).data)

    @action(detail=True, methods=['post'])
    def cancel(self, request, pk=None):
        from apps.inventory.branch_transfer import cancel
        reason = (request.data.get('reason') or '') if hasattr(request.data, 'get') else ''
        t = cancel(self.get_object(), request, reason)
        return Response(self.get_serializer(self.get_queryset().get(pk=t.pk)).data)

    @action(detail=False, methods=['get'], url_path='in-transit')
    def in_transit(self, request):
        """{product_id: units in transit} (Stock Overview's "In transit" column)."""
        from apps.common.branch_context import get_allowed_branch_ids, is_branch_restricted
        from apps.inventory.branch_transfer import in_transit_by_product
        scope = sorted(get_allowed_branch_ids(request)) if is_branch_restricted(request) else None
        return Response(in_transit_by_product(branch_ids=scope))


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
    from django.db.utils import OperationalError, ProgrammingError
    from apps.common.branch_context import get_allowed_branch_ids

    try:
        return _branch_context_payload(request, get_allowed_branch_ids)
    except (ProgrammingError, OperationalError):
        # Branch schema not migrated yet — behave as a single-branch install so the
        # frontend loads. /api/health/ reports the pending migration.
        return Response({
            'multi_branch_enabled': False, 'is_admin': False,
            'active_branch': None, 'default_branch': None, 'branches': [],
        })


def _branch_context_payload(request, get_allowed_branch_ids):
    settings_obj = BusinessSettings.load()
    default_branch = settings_obj.default_branch or Branch.get_default()
    # A stored branch the user may not use (another user's pick on this browser) resolves to the
    # user's own assigned branch, so the session binds to it without a manual re-selection.
    active = getattr(request, 'active_branch', None) or getattr(request, 'home_branch', None) or default_branch
    is_admin = bool(getattr(request, 'is_branch_admin', False))

    branches = Branch.objects.filter(is_active=True)
    allowed = get_allowed_branch_ids(request)
    restricted = settings_obj.multi_branch_enabled and allowed is not None and not is_admin
    if restricted:
        branches = branches.filter(id__in=allowed)
        # Never offer a branch the caller cannot use as "active" (an unassigned user, decision 1,
        # would otherwise be shown the client's default branch and get 403 on every request).
        if active is not None and str(active.pk) not in allowed:
            active = None

    return Response({
        'multi_branch_enabled': settings_obj.multi_branch_enabled,
        'is_admin': is_admin,
        # True when Multi-Branch is on and this user has no branch assigned (fail-closed).
        'no_branch_access': bool(restricted and not allowed),
        'active_branch': _branch_payload(active),
        'default_branch': _branch_payload(default_branch),
        'branches': [_branch_payload(b) for b in branches],
    })
