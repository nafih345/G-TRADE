"""Platform console: onboard and manage client businesses (tenants).

    GET   /api/superadmin/tenants/                      every tenant with admin, user and branch counts
    GET   /api/superadmin/tenants/catalog/              modules, packages, dependencies, roles, defaults
    POST  /api/superadmin/tenants/                      onboard a client (tenant + Super Admin + HO branch)
    GET   /api/superadmin/tenants/<id>/                 one tenant plus users, branches, role permissions
    PATCH /api/superadmin/tenants/<id>/                 profile, package/modules, seats, role permissions,
                                                        multi-branch mode
    POST  /api/superadmin/tenants/<id>/deactivate/      {category, reason, effective_date?, until?}
    POST  /api/superadmin/tenants/<id>/reactivate/      {reason?}  (also cancels a scheduled deactivation)
    GET   /api/superadmin/tenants/<id>/audit/           lifecycle / change history
    POST  /api/superadmin/tenants/<id>/users/           add a user (seat limit applies)
    PATCH /api/superadmin/tenants/<id>/users/<uid>/     role, contact, active, branch access
    POST  /api/superadmin/tenants/<id>/users/<uid>/reset-password/
    POST  /api/superadmin/tenants/<id>/branches/        add a branch
    PATCH /api/superadmin/tenants/<id>/branches/<bid>/  edit / (de)activate / make default
    …/data/…, …/backups/…, …/backup-schedule/           client data inspection and per-client
                                                        backups (superadmin_data_views)

Platform owner only (IsPlatformAdmin); every write also needs a recent password confirmation
when the security policy asks for one (security.policy.SENSITIVE_WRITES). Tenant itself is not
tenant-owned; per-tenant rows (branches, settings, branch access) are read and written under
tenancy.use_tenant(<that tenant>) so the ORM stamps and checks them as that client's.

A deactivation dated in the future is "scheduled": the tenant keeps working until that date
(Tenant.active_q / is_effectively_active), and the first list / detail call on or after it
flips is_active and ends the client's sessions (_apply_due_deactivations).
"""
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Count, Q
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework import mixins, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.common import module_access, tenancy
from apps.common.models import Tenant
from apps.common.permissions import IsPlatformAdmin
from apps.common.superadmin_data_views import TenantDataBackupMixin
from apps.common.superadmin_serializers import (
    DEACTIVATION_CATEGORIES, ClientBranchSerializer, ClientUserCreateSerializer, ClientUserUpdateSerializer,
    DeactivateSerializer, PasswordResetSerializer, ReactivateSerializer, TenantOnboardSerializer,
    TenantSerializer, TenantUpdateSerializer, _password_errors,
)
from apps.common.tenant_onboarding import (
    OnboardingError, active_user_count, check_seat_available, log_event, onboard_tenant,
)

USER_FIELDS = ('id', 'username', 'first_name', 'last_name', 'email', 'phone', 'role', 'is_active',
               'is_superuser', 'date_joined', 'last_login')
BRANCH_FIELDS = ('id', 'name', 'code', 'phone', 'email', 'address', 'city', 'state', 'country', 'pin_code',
                 'is_active', 'is_default')


def _admin_usernames(tenant_ids):
    """Tenant id -> username of its first Super Admin."""
    User = get_user_model()
    admins = {}
    rows = (User.objects.filter(tenant_id__in=tenant_ids)
            .filter(Q(role='SUPER_ADMIN') | Q(is_superuser=True))
            .order_by('date_joined', 'username').values_list('tenant_id', 'username'))
    for tenant_id, username in rows:
        admins.setdefault(tenant_id, username)
    return admins


def _branch_counts(tenant_ids):
    from apps.company.models import Branch
    with tenancy.unscoped():
        return dict(Branch.objects.filter(tenant_id__in=tenant_ids).order_by()
                    .values('tenant_id').annotate(n=Count('id')).values_list('tenant_id', 'n'))


def _bad(field, message):
    return Response({field: [message]} if field else {'detail': message}, status=status.HTTP_400_BAD_REQUEST)


def _end_tenant_sessions(tenant, user=None):
    """Sign everyone in a deactivated tenant (or one user) out now. Their tokens would be refused
    anyway (tenant_context.check_user_tenant), but this also stops refreshes cleanly."""
    from apps.security import policy
    from apps.security.models import AuthSession
    sessions = AuthSession.objects.filter(ended_at__isnull=True)
    sessions = sessions.filter(user=user) if user is not None else sessions.filter(user__tenant=tenant)
    for sid in sessions.values_list('pk', flat=True):
        policy.end_session(sid, 'REVOKED')


def _apply_due_deactivations():
    """Scheduled deactivations whose date has come: make them real (is_active False, sessions
    ended, logged). Access already stopped on the date itself via Tenant.active_q."""
    today = timezone.localdate()
    due = Tenant.objects.filter(is_active=True, deactivation_effective_date__lte=today)
    for tenant in due:
        tenant.is_active = False
        tenant.save(update_fields=['is_active'])
        _end_tenant_sessions(tenant)
        log_event(tenant, 'DEACTIVATION_EFFECTIVE', 'system', reason=tenant.deactivation_reason,
                  effective_date=tenant.deactivation_effective_date, category=tenant.deactivation_category)


def _branch_access_map(tenant):
    from apps.company.models import UserBranchAccess
    with tenancy.use_tenant(tenant.pk):
        rows = UserBranchAccess.objects.prefetch_related('branches')
        return {a.username: {'access_all_branches': a.access_all_branches,
                             'branch_ids': [str(b.pk) for b in a.branches.all()],
                             'default_branch_id': str(a.default_branch_id) if a.default_branch_id else None}
                for a in rows}


def _save_branch_access(tenant, username, data):
    """Apply access_all_branches / branch_ids / default_branch_id when any was sent."""
    keys = ('access_all_branches', 'branch_ids', 'default_branch_id')
    if not any(k in data for k in keys):
        return
    from apps.company.models import Branch, UserBranchAccess
    with tenancy.use_tenant(tenant.pk):
        access = UserBranchAccess.objects.filter(username=username).first() or UserBranchAccess(username=username)
        if 'access_all_branches' in data:
            access.access_all_branches = data['access_all_branches']
        branch_ids = [str(b) for b in data.get('branch_ids', [])]
        branches = list(Branch.objects.filter(pk__in=branch_ids)) if 'branch_ids' in data else None
        if branches is not None and len(branches) != len(set(branch_ids)):
            raise OnboardingError('branch_ids', 'One of the branches does not belong to this client.')
        if 'default_branch_id' in data:
            default_id = data['default_branch_id']
            default = Branch.objects.filter(pk=default_id).first() if default_id else None
            if default_id and default is None:
                raise OnboardingError('default_branch_id', 'That branch does not belong to this client.')
            access.default_branch = default
        access.save()
        if branches is not None:
            access.branches.set(branches)


class TenantAdminViewSet(TenantDataBackupMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated, IsPlatformAdmin]
    serializer_class = TenantSerializer
    pagination_class = None  # a handful of clients; the page shows them all

    def get_queryset(self):
        return Tenant.objects.annotate(
            user_count=Count('users', distinct=True),
            active_user_count=Count('users', filter=Q(users__is_active=True), distinct=True),
        ).order_by('id')

    def _context_for(self, tenants):
        ids = [t.pk for t in tenants]
        return {**self.get_serializer_context(), 'admins': _admin_usernames(ids),
                'branch_counts': _branch_counts(ids)}

    def _row(self, tenant_id):
        tenant = self.get_queryset().get(pk=tenant_id)
        return TenantSerializer(tenant, context=self._context_for([tenant])).data

    def _detail(self, tenant):
        from apps.company.models import Branch, BusinessSettings
        data = self._row(tenant.pk)
        access = _branch_access_map(tenant)
        users = list(get_user_model().objects.filter(tenant=tenant).order_by('date_joined').values(*USER_FIELDS))
        for u in users:
            u['branch_access'] = access.get(u['username'])
            u['is_platform_admin'] = bool(u.pop('is_superuser')) and tenant.pk == tenancy.DEFAULT_TENANT_ID
        data['users'] = users
        with tenancy.use_tenant(tenant.pk):
            data['branches'] = list(Branch.objects.order_by('-is_default', 'name').values(*BRANCH_FIELDS))
            settings_row = BusinessSettings.objects.first()
        data['multi_branch_enabled'] = bool(settings_row and settings_row.multi_branch_enabled)
        data['role_permissions'] = tenant.role_permissions
        data['role_levels'] = module_access.all_role_levels(tenant.role_permissions)
        return data

    # ---- list / detail / catalog --------------------------------------------------------

    def list(self, request, *args, **kwargs):
        _apply_due_deactivations()
        tenants = list(self.get_queryset())
        return Response(TenantSerializer(tenants, many=True, context=self._context_for(tenants)).data)

    def retrieve(self, request, *args, **kwargs):
        _apply_due_deactivations()
        return Response(self._detail(self.get_object()))

    @action(detail=False, methods=['get'])
    def catalog(self, request):
        data = module_access.catalog()
        data['deactivation_categories'] = [{'key': k, 'label': l} for k, l in DEACTIVATION_CATEGORIES]
        return Response(data)

    @action(detail=True, methods=['get'])
    def audit(self, request, pk=None):
        tenant = self.get_object()
        rows = tenant.audit_log.values('id', 'action', 'reason', 'effective_date', 'details', 'actor',
                                       'created_at')[:200]
        return Response(list(rows))

    # ---- onboarding / profile -------------------------------------------------------------

    def create(self, request, *args, **kwargs):
        serializer = TenantOnboardSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        v = serializer.validated_data
        try:
            tenant, admin = onboard_tenant(
                name=v['tenant_name'], admin_username=v['admin_username'], password=v['password'],
                admin_email=v['admin_email'], contact_phone=v['contact_phone'], branch_name=v['branch_name'],
                package=v['package'], modules=v['modules'], settings_features=v['settings_features'],
                max_users=v['max_users'], actor=request.user)
        except OnboardingError as e:
            return _bad(e.field, e.message)
        except IntegrityError:
            # Lost a race with a simultaneous onboarding of the same name / username.
            return _bad(None, 'That client name or username was just taken. Try another.')
        data = self._row(tenant.pk)
        data['admin_username'] = admin.username
        return Response(data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        from apps.company.models import BusinessSettings
        tenant = self.get_object()
        serializer = TenantUpdateSerializer(data=request.data, instance=tenant, partial=True)
        serializer.is_valid(raise_exception=True)
        v = dict(serializer.validated_data)
        multi_branch = v.pop('multi_branch_enabled', None)
        changes = {}
        for field, value in v.items():
            if getattr(tenant, field) != value:
                changes[field] = {'from': getattr(tenant, field), 'to': value}
                setattr(tenant, field, value)
        with transaction.atomic():
            if changes:
                tenant.save(update_fields=list(changes))
            if multi_branch is not None:
                with tenancy.use_tenant(tenant.pk):
                    settings_row = BusinessSettings.load()
                    if settings_row.multi_branch_enabled != multi_branch:
                        changes['multi_branch_enabled'] = {'from': settings_row.multi_branch_enabled,
                                                           'to': multi_branch}
                        settings_row.multi_branch_enabled = multi_branch
                        settings_row.save()
            if changes:
                action_name = ('MODULES_CHANGED' if {'package', 'modules', 'settings_features'} & set(changes)
                               else 'PERMISSIONS_CHANGED' if 'role_permissions' in changes
                               else 'SEATS_CHANGED' if 'max_users' in changes else 'PROFILE_UPDATED')
                log_event(tenant, action_name, request.user, changes=changes)
        return Response(self._detail(tenant))

    # ---- lifecycle ----------------------------------------------------------------------

    @action(detail=True, methods=['post'])
    def deactivate(self, request, pk=None):
        tenant = self.get_object()
        if tenant.pk in (tenancy.DEFAULT_TENANT_ID, request.user.tenant_id):
            return _bad(None, 'The platform account itself cannot be deactivated.')
        if not tenant.is_active:
            return _bad(None, f'{tenant.name} is already deactivated.')
        serializer = DeactivateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        v = serializer.validated_data
        immediate = v['effective_date'] <= timezone.localdate()
        tenant.deactivation_category = v['category']
        tenant.deactivation_reason = v['reason']
        tenant.deactivation_effective_date = v['effective_date']
        tenant.deactivation_until = v.get('until')
        tenant.deactivated_at = timezone.now()
        tenant.deactivated_by = request.user.username
        if immediate:
            tenant.is_active = False
        tenant.save()  # post_save clears hot_cache's tenant:active
        if immediate:
            _end_tenant_sessions(tenant)
        log_event(tenant, 'DEACTIVATED' if immediate else 'DEACTIVATION_SCHEDULED', request.user,
                  reason=v['reason'], effective_date=v['effective_date'], category=v['category'],
                  until=v['until'].isoformat() if v.get('until') else None)
        return Response(self._row(tenant.pk))

    @action(detail=True, methods=['post'])
    def reactivate(self, request, pk=None):
        tenant = self.get_object()
        if tenant.is_active and not tenant.deactivation_effective_date:
            return _bad(None, f'{tenant.name} is already active.')
        serializer = ReactivateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        was_scheduled = tenant.is_active
        tenant.is_active = True
        tenant.deactivation_category = ''
        tenant.deactivation_reason = ''
        tenant.deactivation_effective_date = None
        tenant.deactivation_until = None
        tenant.deactivated_at = None
        tenant.deactivated_by = ''
        tenant.save()
        log_event(tenant, 'DEACTIVATION_CANCELLED' if was_scheduled else 'REACTIVATED', request.user,
                  reason=serializer.validated_data['reason'])
        return Response(self._row(tenant.pk))

    # ---- workspace ----------------------------------------------------------------------

    @action(detail=True, methods=['post'])
    def workspace(self, request, pk=None):
        """Open this client's workspace: a separate sign-in session whose signed token is scoped
        to the client, so the platform owner can create and manage the client's records with
        the client's own rules (modules, numbering, branches). The tenant comes from the URL
        the owner chose — never from a request body — and every opening is audited.

        Inside the workspace the platform console is closed (is_platform_admin is False for a
        request scoped to another tenant); the frontend returns to it with the platform session
        it kept aside."""
        from apps.authentication.serializers import login_user_payload
        from apps.security.policy import issue_tokens

        tenant = self.get_object()
        if tenant.pk == request.user.tenant_id:
            return _bad(None, 'This is the platform account itself — use the normal sign-in.')
        if not tenant.is_effectively_active:
            return _bad(None, f'{tenant.name} is deactivated. Reactivate it before opening its workspace.')
        tokens = issue_tokens(request.user, request, workspace_tenant_id=tenant.pk)
        log_event(tenant, 'WORKSPACE_OPENED', request.user, session_id=tokens['session_id'])
        user = login_user_payload(request.user, tenant_id=tenant.pk)
        user['tenant_name'] = tenant.name
        return Response({**tokens, 'user': user,
                         'workspace': {'tenant_id': tenant.pk, 'tenant_name': tenant.name,
                                       'tenant_code': tenant.code}})

    # ---- users --------------------------------------------------------------------------

    @action(detail=True, methods=['post'], url_path='users')
    def add_user(self, request, pk=None):
        tenant = self.get_object()
        serializer = ClientUserCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        v = serializer.validated_data
        User = get_user_model()
        try:
            with transaction.atomic():
                Tenant.objects.select_for_update().filter(pk=tenant.pk).first()  # serialise seat checks
                check_seat_available(tenant)
                # Client roles are never is_superuser / is_staff (see tenant_onboarding).
                user = User.objects.create_user(
                    username=v['username'], password=v['password'], role=v['role'], tenant=tenant,
                    email=v['email'], first_name=v['first_name'], last_name=v['last_name'],
                    phone=v['phone'] or None)
                _save_branch_access(tenant, user.username, v)
                log_event(tenant, 'USER_ADDED', request.user, username=user.username, role=user.role)
        except OnboardingError as e:
            return _bad(e.field, e.message)
        except IntegrityError:
            return _bad('username', 'That username was just taken. Try another.')
        return Response(self._detail(tenant), status=status.HTTP_201_CREATED)

    def _client_user(self, tenant, user_id):
        user = get_object_or_404(get_user_model(), pk=user_id, tenant=tenant)
        if user.is_superuser:
            # The platform owner's own account is managed with bootstrap_admin, not from here.
            return None
        return user

    def _would_leave_no_owner(self, tenant, user, role, is_active):
        if user.role != 'SUPER_ADMIN' or not user.is_active:
            return False
        if role == 'SUPER_ADMIN' and is_active:
            return False
        others = get_user_model().objects.filter(tenant=tenant, role='SUPER_ADMIN', is_active=True).exclude(pk=user.pk)
        return not others.exists()

    @action(detail=True, methods=['patch'], url_path=r'users/(?P<user_id>[0-9a-fA-F-]{36})')
    def update_user(self, request, pk=None, user_id=None):
        tenant = self.get_object()
        user = self._client_user(tenant, user_id)
        if user is None:
            return _bad(None, 'The platform administrator account cannot be edited here.')
        serializer = ClientUserUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        v = serializer.validated_data
        role = v.get('role', user.role)
        is_active = v.get('is_active', user.is_active)
        if self._would_leave_no_owner(tenant, user, role, is_active):
            return _bad('role' if 'role' in v else 'is_active',
                        'This is the client’s only active Super Admin. Make another user Super Admin first.')
        changes = {}
        try:
            with transaction.atomic():
                if is_active and not user.is_active:
                    Tenant.objects.select_for_update().filter(pk=tenant.pk).first()
                    check_seat_available(tenant)
                for field in ('role', 'first_name', 'last_name', 'email', 'phone', 'is_active'):
                    if field not in v:
                        continue
                    value = (v[field] or None) if field == 'phone' else v[field]  # phone is nullable
                    if getattr(user, field) != value:
                        changes[field] = {'from': getattr(user, field), 'to': value}
                        setattr(user, field, value)
                if changes:
                    user.save()
                _save_branch_access(tenant, user.username, v)
                if changes or any(k in v for k in ('access_all_branches', 'branch_ids', 'default_branch_id')):
                    log_event(tenant, 'USER_UPDATED', request.user, username=user.username, changes=changes)
        except OnboardingError as e:
            return _bad(e.field, e.message)
        if changes.get('is_active', {}).get('to') is False or 'role' in changes:
            _end_tenant_sessions(tenant, user=user)  # new role / disabled: sign in again
        return Response(self._detail(tenant))

    @action(detail=True, methods=['post'], url_path=r'users/(?P<user_id>[0-9a-fA-F-]{36})/reset-password')
    def reset_password(self, request, pk=None, user_id=None):
        tenant = self.get_object()
        user = self._client_user(tenant, user_id)
        if user is None:
            return _bad(None, 'The platform administrator account cannot be edited here.')
        serializer = PasswordResetSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        password = serializer.validated_data['password']
        errors = _password_errors(password, user.username, user.email)
        if errors:
            return Response({'password': errors}, status=status.HTTP_400_BAD_REQUEST)
        user.set_password(password)
        user.save(update_fields=['password'])
        _end_tenant_sessions(tenant, user=user)
        log_event(tenant, 'PASSWORD_RESET', request.user, username=user.username)
        return Response({'detail': f'Password for {user.username} changed. Their open sessions were ended.'})

    # ---- branches -----------------------------------------------------------------------

    def _write_branch(self, request, tenant, branch=None):
        from apps.company.models import Branch, BusinessSettings, Company
        serializer = ClientBranchSerializer(data=request.data, partial=branch is not None)
        serializer.is_valid(raise_exception=True)
        v = dict(serializer.validated_data)
        with tenancy.use_tenant(tenant.pk), transaction.atomic():
            code = v.get('code')
            if code and Branch.objects.filter(code__iexact=code).exclude(pk=getattr(branch, 'pk', None)).exists():
                return _bad('code', f'Branch code "{code}" is already used by this client.')
            make_default = v.pop('is_default', None)
            if branch is not None and branch.is_default and v.get('is_active') is False:
                return _bad('is_active', 'The default branch cannot be deactivated. Make another branch default first.')
            if branch is not None and branch.is_default and make_default is False:
                return _bad('is_default', 'Pick another branch as default instead.')
            created = branch is None
            if created:
                company = Company.objects.first()
                if company is None:
                    return _bad(None, 'This client has no company profile yet.')
                branch = Branch(company=company, is_active=True)
            for field, value in v.items():
                setattr(branch, field, value if value != '' or field in ('name', 'code') else None)
            if make_default:
                branch.is_default = True
                branch.is_active = True
            branch.save()  # model.save() demotes every other default
            if make_default:
                settings_row = BusinessSettings.load()
                settings_row.default_branch = branch
                settings_row.save(update_fields=['default_branch', 'updated_at'])
            log_event(tenant, 'BRANCH_ADDED' if created else 'BRANCH_UPDATED', request.user,
                      branch=branch.name, code=branch.code, fields=sorted(request.data.keys()))
        return Response(self._detail(tenant), status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    @action(detail=True, methods=['post'], url_path='branches')
    def add_branch(self, request, pk=None):
        return self._write_branch(request, self.get_object())

    @action(detail=True, methods=['patch'], url_path=r'branches/(?P<branch_id>[0-9a-fA-F-]{36})')
    def update_branch(self, request, pk=None, branch_id=None):
        from apps.company.models import Branch
        tenant = self.get_object()
        with tenancy.use_tenant(tenant.pk):
            branch = get_object_or_404(Branch, pk=branch_id)
        return self._write_branch(request, tenant, branch)
