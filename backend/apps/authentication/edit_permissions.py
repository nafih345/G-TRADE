"""Per-user Direct Edit switches and the admin-approved Edit Request workflow.

Each user has one Direct Edit switch per module (User.can_edit_<module>):

  * ON  — saved records of that module can be changed at once (the default).
  * OFF — changing a saved record needs an EditRequest for that exact record, approved by an
          admin. The approval is single-use: the first successful save marks it COMPLETED and
          the record is locked again. Unused approvals expire after APPROVAL_TTL.

Not gated (no approval needed even with the switch OFF):
  * the owner role (SUPER_ADMIN) and the platform admin — they are the approvers;
  * a record the same user created within FRESH_GRACE (so "Save" again right after saving a new
    eye test, or fixing a just-made bill, isn't a request);
  * drafts, where a module has them (purchase, wholesale, journals) — not submitted yet;
  * the module's housekeeping fields (EditApprovalMixin.edit_exempt_fields): delivery / payment
    status on a bill, a product image or barcode, a purchase bill's attachment.

The server enforces this (EditApprovalMixin on the module viewsets, require_clearance() in
function views); a refused save answers 403 with code `edit_approval_required` and the record's
module / id / reference, which the frontend turns into the "Edit Permission Required" dialog.

API (under /api/auth/):
    GET   edit-permissions/                 users + their switches (admin staff)
    PATCH edit-permissions/<uid>/           {can_edit_sales: false, ...}
    GET   edit-requests/?status=&mine=1     admins: every request of the business; others: own
    POST  edit-requests/                    {module, record_id, record_ref, reason}
    GET   edit-requests/access/?module=&record_id=   may I edit this now? (+ my latest request)
    GET   edit-requests/pending-count/      admins: {count}
    POST  edit-requests/<id>/approve/       {note}
    POST  edit-requests/<id>/reject/        {note}
    POST  edit-requests/<id>/cancel/        the requester withdraws a pending request
"""
from datetime import timedelta

from django.contrib.auth import get_user_model
from django.db import transaction
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import exceptions, permissions, serializers, status
from rest_framework.response import Response
from rest_framework.views import APIView

from .models import EditRequest

# (key, label) — key is the suffix of the User.can_edit_<key> field.
EDIT_MODULES = (
    ('eye_test', 'Eye Test'),
    ('sales', 'Retail Sales'),
    ('wholesale', 'Wholesale Distribution'),
    ('inventory', 'Inventory'),
    ('purchase', 'Purchase Entry'),
    ('accounts', 'Financial Accounts & Ledgers'),
)
EDIT_MODULE_KEYS = tuple(k for k, _ in EDIT_MODULES)
EDIT_MODULE_LABELS = dict(EDIT_MODULES)
ALWAYS_DIRECT_ROLES = ('SUPER_ADMIN',)

# The record behind each module's edits, with its draft statuses — so the access check can say
# "fresh" / "draft" the same way the save-time gate does. Accounts also covers cheques.
RECORD_MODELS = {
    'eye_test': (('sales', 'EyeExamination', ()),),
    'sales': (('sales', 'Invoice', ()),),
    'wholesale': (('sales', 'WholesaleInvoice', ('DRAFT',)),),
    'inventory': (('products', 'Product', ()),),
    'purchase': (('purchasing', 'PurchaseInvoice', ('DRAFT',)),),
    'accounts': (('financial', 'JournalEntry', ('DRAFT', 'PENDING_APPROVAL')), ('financial', 'Cheque', ())),
}

APPROVAL_TTL = timedelta(hours=24)
FRESH_GRACE = timedelta(minutes=30)


def flag_field(module):
    return f'can_edit_{module}'


def _role(user):
    return 'SUPER_ADMIN' if user.is_superuser else (user.role or '')


def always_direct(user):
    from apps.common.permissions import is_platform_admin
    return _role(user) in ALWAYS_DIRECT_ROLES or is_platform_admin(user)


def can_edit_directly(user, module):
    if always_direct(user):
        return True
    return bool(getattr(user, flag_field(module), True))


def user_edit_permissions(user):
    """{module: bool} as the frontend caches it with the signed-in user."""
    direct = always_direct(user)
    return {m: direct or bool(getattr(user, flag_field(m), True)) for m in EDIT_MODULE_KEYS}


# ---- clearance -------------------------------------------------------------------------------

def _expire_stale(qs):
    qs.filter(status=EditRequest.APPROVED, expires_at__lt=timezone.now()).update(status=EditRequest.EXPIRED)


def approved_request(user, module, record_id):
    qs = EditRequest.objects.filter(requested_by=user, module=module, record_id=str(record_id))
    _expire_stale(qs)
    return qs.filter(status=EditRequest.APPROVED).order_by('-reviewed_at').first()


def latest_request(user, module, record_id):
    qs = EditRequest.objects.filter(requested_by=user, module=module, record_id=str(record_id))
    _expire_stale(qs)
    return qs.order_by('-created_at').first()


def is_fresh(user, created_by_id, created_at):
    return bool(created_by_id and str(created_by_id) == str(user.pk) and created_at
                and created_at >= timezone.now() - FRESH_GRACE)


def record_free_mode(user, module, record_id):
    """'fresh' / 'draft' when that record needs no approval whatever the switch says, else None."""
    from django.apps import apps
    for app_label, model_name, drafts in RECORD_MODELS.get(module, ()):
        model = apps.get_model(app_label, model_name)
        manager = getattr(model, 'all_objects', model.objects)
        fields = ['created_by_id', 'created_at'] + (['status'] if drafts else [])
        try:
            row = manager.filter(pk=record_id).values(*fields).first()
        except Exception:
            row = None  # not a valid pk for this model
        if row is None:
            continue
        if drafts and str(row.get('status') or '').upper() in drafts:
            return 'draft'
        if is_fresh(user, row['created_by_id'], row['created_at']):
            return 'fresh'
        return None
    return None


class EditApprovalRequired(exceptions.PermissionDenied):
    default_code = 'edit_approval_required'

    def __init__(self, module, record_id, record_ref='', pending=None):
        label = EDIT_MODULE_LABELS.get(module, module)
        what = f' {record_ref}' if record_ref else ''
        if pending is not None and pending.status == EditRequest.PENDING:
            msg = f'Your request to edit {label}{what} is waiting for admin approval.'
        else:
            msg = f'Direct editing of {label} records is turned off for your account. Request admin approval to edit{what}.'
        super().__init__({
            'detail': msg, 'code': 'edit_approval_required', 'module': module,
            'module_label': label, 'record_id': str(record_id), 'record_ref': record_ref or '',
            'request_status': pending.status if pending is not None else None,
        })


def require_clearance(request, module, record_id, record_ref='', created_by_id=None, created_at=None):
    """None when the user may edit directly, else the APPROVED EditRequest this save uses.
    Raises EditApprovalRequired otherwise. Call complete() after the save succeeds."""
    user = request.user
    if not (user and user.is_authenticated) or can_edit_directly(user, module):
        return None
    if is_fresh(user, created_by_id, created_at):
        return None
    approval = approved_request(user, module, record_id)
    if approval is None:
        raise EditApprovalRequired(module, record_id, record_ref, latest_request(user, module, record_id))
    return approval


def complete(approval):
    if approval is None:
        return
    EditRequest.objects.filter(pk=approval.pk, status=EditRequest.APPROVED).update(
        status=EditRequest.COMPLETED, completed_at=timezone.now())


class EditApprovalMixin:
    """For a module's ModelViewSet: gate update / partial_update (and `edit_actions`) on the
    caller's Direct Edit switch or an approved EditRequest; consume the approval on success.

    Costs nothing for users whose switch is ON (no extra query)."""
    edit_module = None
    edit_actions = ('update', 'partial_update')
    edit_exempt_fields = ()          # a body touching only these is housekeeping, not an edit
    edit_ref_fields = ()             # first non-empty one is the record's display reference
    edit_draft_statuses = ()         # rows in these statuses (case-insensitive) aren't submitted yet
    edit_status_field = 'status'

    def edit_is_exempt(self, request, row):
        keys = set(getattr(request, 'data', {}) or {})
        return bool(keys) and bool(self.edit_exempt_fields) and keys <= set(self.edit_exempt_fields)

    def initial(self, request, *args, **kwargs):
        self._edit_clearance = None
        super().initial(request, *args, **kwargs)
        if self.action not in self.edit_actions or not self.edit_module:
            return
        user = request.user
        if not (user and user.is_authenticated) or can_edit_directly(user, self.edit_module):
            return
        pk = kwargs.get(self.lookup_url_kwarg or self.lookup_field)
        model = self.queryset.model if getattr(self, 'queryset', None) is not None else self.get_queryset().model
        fields = {'pk', 'created_at', 'created_by_id', *self.edit_ref_fields}
        if self.edit_draft_statuses:
            fields.add(self.edit_status_field)
        if self.edit_exempt_fields:
            fields |= {f for f in self.edit_exempt_fields if _is_concrete(model, f)}
        row = model.all_objects.filter(pk=pk).values(*fields).first() if hasattr(model, 'all_objects') \
            else model.objects.filter(pk=pk).values(*fields).first()
        if row is None:
            return  # the handler answers 404
        if self.edit_draft_statuses and str(row.get(self.edit_status_field) or '').upper() in \
                {s.upper() for s in self.edit_draft_statuses}:
            return
        if self.edit_is_exempt(request, row):
            return
        ref = next((str(row[f]) for f in self.edit_ref_fields if row.get(f)), '')
        self._edit_clearance = require_clearance(request, self.edit_module, row['pk'], ref,
                                                 row.get('created_by_id'), row.get('created_at'))

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        ok = 200 <= getattr(response, 'status_code', 500) < 300
        if ok and getattr(self, '_edit_clearance', None) is not None:
            complete(self._edit_clearance)
            self._edit_clearance = None
        if ok and getattr(self, 'action', None) == 'create' and self.edit_module:
            _stamp_creator(self, request, response)
        return response


def _is_concrete(model, name):
    try:
        f = model._meta.get_field(name)
    except Exception:
        return False
    return getattr(f, 'concrete', False) and not f.many_to_many


def _stamp_creator(view, request, response):
    """Remember who created the row (BaseUUIDModel.created_by is not set by the serializers),
    so the creator's follow-up saves within FRESH_GRACE need no approval."""
    user = request.user
    data = getattr(response, 'data', None)
    pk = data.get('id') if isinstance(data, dict) else None
    if not (pk and user and user.is_authenticated):
        return
    # Freshness only matters to users who need approval: everyone else pays no extra query.
    if can_edit_directly(user, view.edit_module):
        return
    model = view.queryset.model if getattr(view, 'queryset', None) is not None else view.get_queryset().model
    if not _is_concrete(model, 'created_by'):
        return
    try:
        model.all_objects.filter(pk=pk, created_by__isnull=True).update(created_by=user)
    except Exception:
        pass  # best effort: never fail a save over the audit stamp


# ---- API -------------------------------------------------------------------------------------

def _is_reviewer(user):
    from .user_admin import IsUserAdmin
    return IsUserAdmin().has_permission(type('R', (), {'user': user})(), None)


def _tenant_id(request):
    from apps.common.permissions import request_tenant_id
    return request_tenant_id(request.user)


def _display_name(u):
    if u is None:
        return ''
    full = f'{u.first_name or ""} {u.last_name or ""}'.strip()
    return full or u.username


def request_row(r, viewer=None):
    from .user_admin import can_manage_role
    roles = dict(get_user_model().ROLE_CHOICES)
    return {
        'id': str(r.id), 'module': r.module, 'module_label': EDIT_MODULE_LABELS.get(r.module, r.module),
        'record_id': r.record_id, 'record_ref': r.record_ref, 'reason': r.reason, 'status': r.status,
        'requested_by': str(r.requested_by_id), 'requested_by_name': _display_name(r.requested_by),
        'requested_by_username': r.requested_by.username if r.requested_by_id else '',
        'requester_role': r.requester_role, 'requester_role_label': roles.get(r.requester_role, r.requester_role),
        'reviewed_by_name': _display_name(r.reviewed_by), 'review_note': r.review_note,
        'reviewed_at': r.reviewed_at, 'expires_at': r.expires_at, 'completed_at': r.completed_at,
        'created_at': r.created_at,
        'can_review': bool(viewer is not None and r.status == EditRequest.PENDING
                           and r.requested_by_id != viewer.pk and _is_reviewer(viewer)
                           and can_manage_role(viewer, r.requester_role)),
    }


class EditRequestCreateSerializer(serializers.Serializer):
    module = serializers.ChoiceField(choices=EDIT_MODULE_KEYS)
    record_id = serializers.CharField(max_length=64)
    record_ref = serializers.CharField(max_length=120, required=False, allow_blank=True, default='')
    reason = serializers.CharField(max_length=2000)

    def validate_record_id(self, value):
        return value.strip()

    def validate_reason(self, value):
        value = value.strip()
        if len(value) < 3:
            raise serializers.ValidationError('Give a reason for the edit.')
        return value


class EditPermissionsView(APIView):
    """The Administration matrix: every user of the business and their switches."""

    def get_permissions(self):
        from .user_admin import IsUserAdmin
        return [permissions.IsAuthenticated(), IsUserAdmin()]

    def get(self, request):
        from .user_admin import can_manage_role
        User = get_user_model()
        roles = dict(User.ROLE_CHOICES)
        users = User.objects.filter(tenant_id=_tenant_id(request)).order_by('date_joined')
        rows = []
        for u in users:
            direct = always_direct(u)
            rows.append({
                'id': str(u.pk), 'username': u.username, 'name': _display_name(u), 'role': u.role,
                'role_label': roles.get(_role(u), u.role), 'is_active': u.is_active,
                'always_direct': direct,
                'permissions': {m: direct or bool(getattr(u, flag_field(m))) for m in EDIT_MODULE_KEYS},
                'can_manage': (not direct and u.pk != request.user.pk and can_manage_role(request.user, u.role)),
            })
        return Response({'modules': [{'key': k, 'label': l, 'field': flag_field(k)} for k, l in EDIT_MODULES],
                         'users': rows})


class EditPermissionsDetailView(APIView):
    def get_permissions(self):
        from .user_admin import IsUserAdmin
        return [permissions.IsAuthenticated(), IsUserAdmin()]

    def patch(self, request, user_id):
        from apps.common.tenant_onboarding import log_event
        from apps.common.models import Tenant
        from .user_admin import can_manage_role
        tenant = Tenant.objects.get(pk=_tenant_id(request))
        user = get_object_or_404(get_user_model(), pk=user_id, tenant=tenant)
        if always_direct(user):
            return Response({'detail': 'Owners always edit directly.'}, status=status.HTTP_400_BAD_REQUEST)
        if user.pk == request.user.pk:
            return Response({'detail': 'You cannot change your own edit permissions.'}, status=status.HTTP_403_FORBIDDEN)
        if not can_manage_role(request.user, user.role):
            return Response({'detail': 'You cannot change permissions of an account with this role.'},
                            status=status.HTTP_403_FORBIDDEN)
        changes = {}
        for module in EDIT_MODULE_KEYS:
            field = flag_field(module)
            for key in (field, module):
                if key in request.data:
                    value = request.data[key]
                    value = value if isinstance(value, bool) else str(value).lower() in ('1', 'true', 'on', 'yes')
                    if getattr(user, field) != value:
                        changes[field] = {'from': getattr(user, field), 'to': value}
                        setattr(user, field, value)
        if changes:
            user.save(update_fields=list(changes))
            log_event(tenant, 'USER_UPDATED', request.user, username=user.username, changes=changes,
                      via='edit-permissions')
        return Response({'id': str(user.pk),
                         'permissions': {m: bool(getattr(user, flag_field(m))) for m in EDIT_MODULE_KEYS}})


def _scoped_requests():
    return EditRequest.objects.select_related('requested_by', 'reviewed_by')


class EditRequestsView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        qs = _scoped_requests()
        _expire_stale(EditRequest.objects.all())
        if not _is_reviewer(request.user) or request.query_params.get('mine'):
            qs = qs.filter(requested_by=request.user)
        st = (request.query_params.get('status') or '').upper()
        if st:
            qs = qs.filter(status__in=[s for s in st.split(',') if s])
        if request.query_params.get('module'):
            qs = qs.filter(module=request.query_params['module'])
        try:
            limit = max(1, min(int(request.query_params.get('limit') or 200), 500))
        except ValueError:
            limit = 200
        rows = [request_row(r, request.user) for r in qs[:limit]]
        return Response({'results': rows,
                         'pending_count': EditRequest.objects.filter(status=EditRequest.PENDING).count()
                         if _is_reviewer(request.user) else None})

    def post(self, request):
        ser = EditRequestCreateSerializer(data=request.data)
        ser.is_valid(raise_exception=True)
        v = ser.validated_data
        user = request.user
        if can_edit_directly(user, v['module']):
            return Response({'detail': 'You can already edit these records directly.', 'allowed': True},
                            status=status.HTTP_400_BAD_REQUEST)
        with transaction.atomic():
            existing = (EditRequest.objects.select_for_update()
                        .filter(requested_by=user, module=v['module'], record_id=v['record_id'],
                                status__in=(EditRequest.PENDING, EditRequest.APPROVED)).first())
            if existing is not None and existing.status == EditRequest.APPROVED and \
                    existing.expires_at and existing.expires_at < timezone.now():
                existing.status = EditRequest.EXPIRED
                existing.save(update_fields=['status', 'updated_at'])
                existing = None
            if existing is not None:
                if existing.status == EditRequest.PENDING:
                    existing.reason = v['reason']
                    if v['record_ref']:
                        existing.record_ref = v['record_ref']
                    existing.save(update_fields=['reason', 'record_ref', 'updated_at'])
                r = existing
            else:
                r = EditRequest.objects.create(
                    module=v['module'], record_id=v['record_id'], record_ref=v['record_ref'], reason=v['reason'],
                    requested_by=user, requester_role=_role(user))
        r = _scoped_requests().get(pk=r.pk)
        return Response(request_row(r, user), status=status.HTTP_201_CREATED)


class EditAccessView(APIView):
    """Before opening a saved record for editing: may I? `mode` is direct | approved | pending |
    rejected | none; `request` is my latest request for that record, if any."""
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        module = request.query_params.get('module') or ''
        record_id = request.query_params.get('record_id') or ''
        if module not in EDIT_MODULE_KEYS:
            return Response({'detail': 'Unknown module.'}, status=status.HTTP_400_BAD_REQUEST)
        user = request.user
        if can_edit_directly(user, module):
            return Response({'allowed': True, 'mode': 'direct', 'request': None})
        if not record_id:
            return Response({'allowed': False, 'mode': 'none', 'request': None})
        free = record_free_mode(user, module, record_id)
        if free:
            return Response({'allowed': True, 'mode': free, 'request': None})
        latest = latest_request(user, module, record_id)
        row = request_row(_scoped_requests().get(pk=latest.pk), user) if latest else None
        if latest is not None and latest.status == EditRequest.APPROVED:
            return Response({'allowed': True, 'mode': 'approved', 'request': row})
        mode = {EditRequest.PENDING: 'pending', EditRequest.REJECTED: 'rejected'}.get(
            latest.status if latest else None, 'none')
        return Response({'allowed': False, 'mode': mode, 'request': row})


class EditPendingCountView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def get(self, request):
        if not _is_reviewer(request.user):
            return Response({'count': 0, 'reviewer': False})
        return Response({'count': EditRequest.objects.filter(status=EditRequest.PENDING).count(), 'reviewer': True})


class _ReviewBase(APIView):
    permission_classes = [permissions.IsAuthenticated]
    decision = None

    def post(self, request, request_id):
        from .user_admin import can_manage_role
        if not _is_reviewer(request.user):
            return Response({'detail': 'Only admin staff with full Administration access can review edit requests.'},
                            status=status.HTTP_403_FORBIDDEN)
        note = (request.data.get('note') or '').strip()[:2000]
        with transaction.atomic():
            r = get_object_or_404(EditRequest.objects.select_for_update(), pk=request_id)
            if r.requested_by_id == request.user.pk:
                return Response({'detail': 'You cannot review your own request.'}, status=status.HTTP_403_FORBIDDEN)
            if not can_manage_role(request.user, r.requester_role):
                return Response({'detail': 'You cannot review requests from an account with this role.'},
                                status=status.HTTP_403_FORBIDDEN)
            if r.status != EditRequest.PENDING:
                return Response({'detail': f'This request is already {r.status.lower()}.'},
                                status=status.HTTP_409_CONFLICT)
            now = timezone.now()
            r.status = self.decision
            r.reviewed_by = request.user
            r.reviewed_at = now
            r.review_note = note
            if self.decision == EditRequest.APPROVED:
                r.expires_at = now + APPROVAL_TTL
            r.save()
        return Response(request_row(_scoped_requests().get(pk=r.pk), request.user))


class EditRequestApproveView(_ReviewBase):
    decision = EditRequest.APPROVED


class EditRequestRejectView(_ReviewBase):
    decision = EditRequest.REJECTED


class EditRequestCancelView(APIView):
    permission_classes = [permissions.IsAuthenticated]

    def post(self, request, request_id):
        r = get_object_or_404(EditRequest, pk=request_id, requested_by=request.user)
        if r.status not in (EditRequest.PENDING, EditRequest.APPROVED):
            return Response({'detail': f'This request is already {r.status.lower()}.'}, status=status.HTTP_409_CONFLICT)
        r.status = EditRequest.CANCELLED
        r.save(update_fields=['status', 'updated_at'])
        return Response(request_row(_scoped_requests().get(pk=r.pk), request.user))
