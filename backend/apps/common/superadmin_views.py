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

from apps.common import edition, module_access, tenancy
from apps.common.models import Tenant
from apps.common.permissions import IsPlatformAdmin
from apps.common.superadmin_data_views import TenantDataBackupMixin
from apps.common.superadmin_serializers import (
    DEACTIVATION_CATEGORIES, ClientBranchSerializer, ClientUserCreateSerializer, ClientUserUpdateSerializer,
    DeactivateSerializer, PasswordResetSerializer, ReactivateSerializer, TenantOnboardSerializer,
    TenantSerializer, TenantUpdateSerializer, _password_errors,
)
from apps.common.invitations import INVITATION_TIMEOUT_HOURS
from apps.common.tenant_onboarding import (
    OnboardingError, active_user_count, check_branch_available, check_seat_available, log_event, onboard_tenant,
)

USER_FIELDS = ('id', 'username', 'first_name', 'last_name', 'email', 'phone', 'role', 'is_active',
               'is_superuser', 'date_joined', 'last_login', 'can_use_wholesale_order_status')
BRANCH_FIELDS = ('id', 'name', 'code', 'phone', 'email', 'address', 'city', 'state', 'country', 'pin_code',
                 'is_active', 'is_default')


# A licensed cloud client's terms (apps.vendor_licensing.service.apply_to_tenant).
LICENCE_MANAGED_FIELDS = ('subscription_plan', 'subscription_starts_on', 'subscription_expires_on', 'max_users',
                          'max_branches', 'max_companies', 'package', 'modules', 'settings_features')


def _vendor_licensing():
    from django.apps import apps
    return apps.is_installed('apps.vendor_licensing')


def _tenant_licence(tenant):
    if not _vendor_licensing():
        return None
    from apps.vendor_licensing.service import tenant_licence
    return tenant_licence(tenant)


def _licence_managed_fields():
    """Cloud: the licence drives every term. Windows Local Hosted Workspaces: the subscription drives
    plan / start / expiry; modules, seats and branches stay editable on the workspace."""
    if edition.is_local():
        return ('subscription_plan', 'subscription_starts_on', 'subscription_expires_on')
    return LICENCE_MANAGED_FIELDS


def _subscriptions(tenant_ids):
    if not _vendor_licensing():
        return {}
    from apps.vendor_licensing.service import tenant_subscriptions
    return tenant_subscriptions(tenant_ids)


def _differs(tenant, field, value):
    if field == 'max_companies':
        org = getattr(tenant, 'organization', None)
        return org is None or org.max_companies != value
    return getattr(tenant, field, None) != value


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


def _branch_counts(tenant_ids, active=False):
    from apps.company.models import Branch
    with tenancy.unscoped():
        rows = Branch.objects.filter(tenant_id__in=tenant_ids)
        if active:
            rows = rows.filter(is_active=True)
        return dict(rows.order_by().values('tenant_id').annotate(n=Count('id')).values_list('tenant_id', 'n'))


def _company_names(tenant_ids):
    """Tenant id -> its store profile's company name (the first Company row)."""
    from apps.company.models import Company
    names = {}
    with tenancy.unscoped():
        for tenant_id, name in (Company.objects.filter(tenant_id__in=tenant_ids)
                                .order_by('tenant_id', 'created_at').values_list('tenant_id', 'name')):
            names.setdefault(tenant_id, name)
    return names


# Client list filters (?status=): the status values tenant_status() produces, plus groupings.
STATUS_FILTERS = {
    'ACTIVE': {'ACTIVE', 'TRIAL', 'SCHEDULED'},  # can be used today
    'TRIAL': {'TRIAL'},
    'SCHEDULED': {'SCHEDULED'},
    'EXPIRED': {'EXPIRED'},
    'INACTIVE': {'INACTIVE'},
    'SUSPENDED': {'INACTIVE', 'EXPIRED'},  # cannot be used today
}
EXPIRING_DAYS = 30


def _jsonable(changes):
    """Audit details are JSON: dates as ISO strings."""
    def conv(value):
        return value.isoformat() if hasattr(value, 'isoformat') else value
    return {k: ({'from': conv(v['from']), 'to': conv(v['to'])} if isinstance(v, dict) and 'from' in v else conv(v))
            for k, v in changes.items()}


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
        # Rows linked to a user, keyed by that user's current name (P1 Task 4). Unlinked rows
        # (deleted users' leftovers) apply to nobody, so they are not shown against anyone.
        rows = UserBranchAccess.objects.filter(user__isnull=False).select_related('user').prefetch_related('branches')
        return {a.user.username: {'access_all_branches': a.access_all_branches,
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
        user = UserBranchAccess.match_user(username, tenant.pk)
        access = UserBranchAccess.for_user(user) or UserBranchAccess(username=username, user=user)
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
        # Every user signs in bound to a branch: with none picked (or one no longer assigned),
        # use their first assigned branch, or the client's default when they may use all.
        assigned = branches if branches is not None else (list(access.branches.all()) if access.pk else [])
        if not access.access_all_branches and assigned and access.default_branch not in assigned:
            access.default_branch = sorted(assigned, key=lambda b: (not b.is_default, b.created_at))[0]
        elif access.default_branch is None:
            access.default_branch = Branch.get_default()
        access.save()
        if branches is not None:
            access.branches.set(branches)


class TenantAdminViewSet(TenantDataBackupMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated, IsPlatformAdmin]
    serializer_class = TenantSerializer
    pagination_class = None  # a handful of clients; the page shows them all

    def get_queryset(self):
        return Tenant.objects.select_related('organization').annotate(
            user_count=Count('users', distinct=True),
            active_user_count=Count('users', filter=Q(users__is_active=True), distinct=True),
        ).order_by('id')

    def _context_for(self, tenants):
        ids = [t.pk for t in tenants]
        return {**self.get_serializer_context(), 'admins': _admin_usernames(ids),
                'branch_counts': _branch_counts(ids), 'active_branch_counts': _branch_counts(ids, active=True),
                'company_names': _company_names(ids), 'subscriptions': _subscriptions(ids)}

    def _row(self, tenant_id):
        tenant = self.get_queryset().get(pk=tenant_id)
        return TenantSerializer(tenant, context=self._context_for([tenant])).data

    def _detail(self, tenant):
        from apps.company.models import Branch, BusinessSettings
        data = self._row(tenant.pk)
        access = _branch_access_map(tenant)
        users = list(get_user_model().objects.filter(tenant=tenant).order_by('date_joined')
                     .values(*USER_FIELDS, 'password'))
        for u in users:
            # An unusable password (Django prefixes it with '!') = invited, setup link not used yet.
            u['setup_pending'] = str(u.pop('password') or '!').startswith('!')
            u['branch_access'] = access.get(u['username'])
            u['is_platform_admin'] = bool(u.pop('is_superuser')) and tenant.pk == tenancy.DEFAULT_TENANT_ID
        data['users'] = users
        with tenancy.use_tenant(tenant.pk):
            data['branches'] = list(Branch.objects.order_by('-is_default', 'name').values(*BRANCH_FIELDS))
            settings_row = BusinessSettings.objects.first()
        data['multi_branch_enabled'] = bool(settings_row and settings_row.multi_branch_enabled)
        data['role_permissions'] = tenant.role_permissions
        data['role_levels'] = module_access.all_role_levels(tenant.role_permissions)
        lic = _tenant_licence(tenant)
        data['licence'] = None if lic is None else {
            'id': str(lic.pk), 'lic_id': lic.lic_id, 'plan': (lic.plan_snapshot or {}).get('name', ''),
            'status': lic.effective_status(), 'expires_on': lic.expires_on, 'lifetime': lic.is_lifetime,
            'managed_fields': list(_licence_managed_fields())}
        return data

    # ---- list / detail / catalog --------------------------------------------------------

    def _filtered(self, request):
        """Tenants matching ?search= (name, code, id, contact, owner, admin username), ?status=
        (STATUS_FILTERS), ?plan=, ?package=, ?country= and ?expiring=1 (ends within 30 days)."""
        from apps.common.superadmin_serializers import tenant_status
        qs = self.get_queryset()
        params = request.query_params
        q = (params.get('search') or '').strip()
        if q:
            User = get_user_model()
            admin_tenants = (User.objects.filter(username__icontains=q).filter(Q(role='SUPER_ADMIN') | Q(is_superuser=True))
                             .values('tenant_id'))
            match = (Q(name__icontains=q) | Q(code__icontains=q) | Q(contact_email__icontains=q)
                     | Q(contact_phone__icontains=q) | Q(owner_name__icontains=q) | Q(pk__in=admin_tenants))
            if q.lstrip('#').isdigit():
                match |= Q(pk=int(q.lstrip('#')))
            qs = qs.filter(match)
        for param, field in (('plan', 'subscription_plan'), ('package', 'package'), ('country', 'country')):
            value = (params.get(param) or '').strip().upper()
            if value:
                qs = qs.filter(**{field: value})
        tenants = list(qs)
        status_filter = (params.get('status') or '').strip().upper()
        if status_filter in STATUS_FILTERS:
            allowed = STATUS_FILTERS[status_filter]
            tenants = [t for t in tenants if tenant_status(t) in allowed]
        if params.get('expiring') in ('1', 'true'):
            today = timezone.localdate()
            tenants = [t for t in tenants if t.subscription_expires_on
                       and 0 <= (t.subscription_expires_on - today).days <= EXPIRING_DAYS]
        return tenants

    def list(self, request, *args, **kwargs):
        """Every client (a plain list, as before), or one page of them when ?page= is given:
        {count, page, page_size, results}."""
        _apply_due_deactivations()
        tenants = self._filtered(request)
        if 'page' not in request.query_params:
            return Response(TenantSerializer(tenants, many=True, context=self._context_for(tenants)).data)
        try:
            page = max(1, int(request.query_params.get('page') or 1))
            size = min(100, max(1, int(request.query_params.get('page_size') or 25)))
        except ValueError:
            return _bad(None, 'page and page_size must be whole numbers.')
        chunk = tenants[(page - 1) * size: page * size]
        return Response({'count': len(tenants), 'page': page, 'page_size': size,
                         'results': TenantSerializer(chunk, many=True, context=self._context_for(chunk)).data})

    @action(detail=False, methods=['get'])
    def summary(self, request):
        """Platform dashboard figures over every client."""
        from apps.common.superadmin_serializers import tenant_status
        _apply_due_deactivations()
        tenants = list(self.get_queryset())
        today = timezone.localdate()
        # Client figures leave out the platform's own account (tenant #1).
        clients = [t for t in tenants if t.pk != tenancy.DEFAULT_TENANT_ID]
        by_status = {}
        for t in clients:
            s = tenant_status(t)
            by_status[s] = by_status.get(s, 0) + 1
        expiring = sorted((t for t in clients if t.subscription_expires_on and t.is_active
                           and 0 <= (t.subscription_expires_on - today).days <= EXPIRING_DAYS),
                          key=lambda t: t.subscription_expires_on)
        with tenancy.unscoped():
            from apps.company.models import Branch
            branches = Branch.objects.filter(is_active=True, tenant_id__in=[t.pk for t in clients]).count()
        return Response({
            'edition': 'local' if edition.is_local() else 'cloud',
            'license': edition.license_summary(),
            'clients': len(clients),
            'by_status': by_status,
            'active_users': sum(t.active_user_count for t in clients),
            'active_branches': branches,
            'expiring_soon': [{'id': t.id, 'name': t.name, 'subscription_plan': t.subscription_plan,
                               'subscription_expires_on': t.subscription_expires_on,
                               'days_to_expiry': (t.subscription_expires_on - today).days} for t in expiring[:10]],
            'expiring_days': EXPIRING_DAYS,
        })

    def retrieve(self, request, *args, **kwargs):
        _apply_due_deactivations()
        return Response(self._detail(self.get_object()))

    @action(detail=False, methods=['get'])
    def catalog(self, request):
        from apps.company import localization
        data = module_access.catalog()
        data['deactivation_categories'] = [{'key': k, 'label': l} for k, l in DEACTIVATION_CATEGORIES]
        data['subscription_plans'] = [{'key': k, 'label': l} for k, l in Tenant.SUBSCRIPTION_PLANS]
        data['invitation_hours'] = INVITATION_TIMEOUT_HOURS
        # Windows edition: the console shows the installation's licence (clients used / allowed).
        data['edition'] = 'local' if edition.is_local() else 'cloud'
        data['license'] = edition.license_summary()
        # The onboarding form's pick lists (country → suggested currency / time zone / language).
        loc = localization.catalog()
        data['localization'] = {key: loc[key] for key in ('countries', 'currencies', 'languages', 'time_zones')}
        return Response(data)

    @action(detail=True, methods=['get'])
    def audit(self, request, pk=None):
        tenant = self.get_object()
        rows = tenant.audit_log.values('id', 'action', 'reason', 'effective_date', 'details', 'actor',
                                       'created_at')[:200]
        return Response(list(rows))

    # ---- onboarding / profile -------------------------------------------------------------

    def create(self, request, *args, **kwargs):
        data, licence_plan, licence_start, install = request.data, None, None, None
        if request.data.get('licence_plan_id') and edition.is_local():
            # Windows Local Super Admin: Hosted Workspaces → New client → step 5 Subscription. The
            # workspace and its subscription (Subscription ID = signed licence record) are created in
            # the same transaction; the client details are the wizard's own, never asked again.
            if not _vendor_licensing():
                return _bad('licence_plan_id', 'Subscriptions are not available on this installation.')
            from apps.vendor_licensing import onboarding
            from apps.vendor_licensing.service import LicenceError
            try:
                data, licence_plan, licence_start, install = onboarding.prepare_local(request.data)
            except LicenceError as e:
                return Response({e.field or 'detail': [e.message], 'code': e.code}, status=e.status)
        elif request.data.get('licence_plan_id'):
            # Cloud Edition client sold on a plan: the workspace gets the plan's terms and its
            # licence is issued in the same transaction (apps.vendor_licensing.onboarding).
            if not _vendor_licensing():
                return _bad('licence_plan_id', 'Licence plans are managed in the vendor console, not on this installation.')
            from apps.vendor_licensing import onboarding
            from apps.vendor_licensing.service import LicenceError
            try:
                data, licence_plan, licence_start = onboarding.prepare(request.data)
            except LicenceError as e:
                return Response({e.field or 'detail': [e.message], 'code': e.code}, status=e.status)
        serializer = TenantOnboardSerializer(data=data)
        serializer.is_valid(raise_exception=True)
        v = serializer.validated_data
        licence = None
        try:
            with transaction.atomic():
                tenant, admin = onboard_tenant(
                    name=v['tenant_name'], admin_username=v['admin_username'], password=v['password'],
                    admin_email=v['admin_email'], contact_phone=v['contact_phone'], branch_name=v['branch_name'],
                    package=v['package'], modules=v['modules'], settings_features=v['settings_features'],
                    max_users=v['max_users'], actor=request.user, profile=v['tenant_profile'],
                    subscription=v['subscription'], company_profile=v['company_profile'],
                    preferences=v['preferences'], branch_details=v['branch_details'], admin_name=v['admin_name'],
                    module_features=v['module_features'])
                if v['logo']:
                    from apps.billing.models import BillingSettings
                    with tenancy.use_tenant(tenant.pk):
                        branding = BillingSettings.objects.first() or BillingSettings()
                        branding.logo_data_url = v['logo']
                        branding.save()
                if licence_plan is not None:
                    from apps.vendor_licensing import onboarding
                    if install is not None:
                        licence = onboarding.issue_for_hosted_tenant(tenant, licence_plan, licence_start, install,
                                                                     request.user)
                    else:
                        licence = onboarding.issue_for_new_tenant(tenant, licence_plan, licence_start, request.user)
        except OnboardingError as e:
            return _bad(e.field, e.message)
        except Exception as e:  # a licence that cannot be issued rolls the whole client back
            if e.__class__.__name__ != 'LicenceError':
                raise
            return Response({e.field or 'detail': [e.message], 'code': e.code}, status=e.status)
        except IntegrityError:
            # Lost a race with a simultaneous onboarding of the same name / username.
            return _bad(None, 'That client name or username was just taken. Try another.')
        data = self._row(tenant.pk)
        data['admin_username'] = admin.username
        data['admin_user_id'] = str(admin.pk)
        # The setup link itself is never in this response (it would be kept for idempotent
        # replays); the console asks users/<id>/invitation/ for it next.
        data['invitation_pending'] = v['password'] is None
        if licence is not None:
            from apps.vendor_licensing.serializers import LicenceSerializer, key_available
            data = self._row(tenant.pk) | {k: data[k] for k in ('admin_username', 'admin_user_id', 'invitation_pending')}
            data['licence'] = LicenceSerializer(licence).data
            if key_available(licence):
                data['licence']['key'] = licence.key_token
        return Response(data, status=status.HTTP_201_CREATED)

    def partial_update(self, request, *args, **kwargs):
        from apps.company.models import BusinessSettings
        tenant = self.get_object()
        serializer = TenantUpdateSerializer(data=request.data, instance=tenant, partial=True)
        serializer.is_valid(raise_exception=True)
        v = dict(serializer.validated_data)
        lic = _tenant_licence(tenant)
        if lic is not None:
            # One source of truth: a licensed client's terms change only through its licence
            # (renew / change plan), never by editing the workspace's copy of them.
            managed = sorted(f for f in _licence_managed_fields() if f in v and _differs(tenant, f, v[f]))
            if managed:
                where = 'Manage → Subscription Plans' if edition.is_local() else 'Licences'
                return Response({'detail': f'Managed by subscription {lic.lic_id}: change the plan or renew it '
                                           f'in {where} instead ({", ".join(managed)}).',
                                 'code': 'licence_managed', 'fields': managed}, status=400)
        multi_branch = v.pop('multi_branch_enabled', None)
        max_companies = v.pop('max_companies', None)
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
            if max_companies is not None:
                from apps.common.models import Organization
                from apps.common.organizations import ensure_organization
                org = ensure_organization(tenant)
                held = Tenant.objects.filter(organization=org).count()
                if max_companies < held:
                    transaction.set_rollback(True)
                    return _bad('max_companies', f'This organization already holds {held} companies.')
                if org.max_companies != max_companies:
                    changes['max_companies'] = {'from': org.max_companies, 'to': max_companies}
                    Organization.objects.filter(pk=org.pk).update(max_companies=max_companies)
            if changes:
                # One audit row per kind of change, so the history can be filtered by event type.
                groups = (
                    ('MODULES_CHANGED', {'package', 'modules', 'settings_features', 'module_features'}),
                    ('PERMISSIONS_CHANGED', {'role_permissions'}),
                    ('SUBSCRIPTION_CHANGED', {'subscription_plan', 'subscription_starts_on',
                                              'subscription_expires_on', 'max_branches'}),
                    ('SEATS_CHANGED', {'max_users'}),
                    ('COMPANY_LIMIT_CHANGED', {'max_companies'}),
                )
                remaining = dict(changes)
                for action_name, keys in groups:
                    part = {k: remaining.pop(k) for k in list(remaining) if k in keys}
                    if part:
                        log_event(tenant, action_name, request.user, changes=_jsonable(part))
                if remaining:
                    log_event(tenant, 'PROFILE_UPDATED', request.user, changes=_jsonable(remaining))
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
        if not tenant.is_active and tenant.deactivation_category in ('LICENCE_SUSPENDED', 'LICENCE_REVOKED'):
            return _bad(None, f'{tenant.name} was blocked by its licence ({tenant.deactivation_reason}). '
                              'Reactivate the licence in Licences instead.')
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
            return _bad(None, f'{tenant.name} cannot be used right now (deactivated or subscription expired). '
                              'Reactivate or renew it before opening its workspace.')
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
                    phone=v['phone'] or None,
                    can_use_wholesale_order_status=v.get('can_use_wholesale_order_status', True))
                _save_branch_access(tenant, user.username, v)
                log_event(tenant, 'USER_ADDED', request.user, username=user.username, role=user.role,
                          setup='invitation' if v['password'] is None else 'password')
        except OnboardingError as e:
            return _bad(e.field, e.message)
        except IntegrityError:
            return _bad('username', 'That username was just taken. Try another.')
        data = self._detail(tenant)
        data['created_user_id'] = str(user.pk)
        data['invitation_pending'] = v['password'] is None
        return Response(data, status=status.HTTP_201_CREATED)

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
                for field in ('role', 'first_name', 'last_name', 'email', 'phone', 'is_active',
                              'can_use_wholesale_order_status'):
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

    @action(detail=True, methods=['post'], url_path=r'users/(?P<user_id>[0-9a-fA-F-]{36})/invitation')
    def invitation(self, request, pk=None, user_id=None):
        """A one-time account-setup link for one of the client's users (apps.common.invitations):
        {uid, token, expires_in_hours}. The browser turns it into a link on its own origin. Issuing
        a new one does not cancel older ones; any of them stops working once a password is set."""
        from apps.common import invitations
        tenant = self.get_object()
        user = self._client_user(tenant, user_id)
        if user is None:
            return _bad(None, 'The platform administrator account cannot be edited here.')
        if not user.is_active:
            return _bad(None, f'{user.username} is deactivated. Reactivate the account first.')
        if not tenant.is_effectively_active:
            return _bad(None, f'{tenant.name} cannot be used right now (deactivated or expired).')
        log_event(tenant, 'INVITATION_ISSUED', request.user, username=user.username)
        response = Response({**invitations.issue(user), 'username': user.username})
        response.idempotency_no_store = True  # the link is a secret: never kept for replays
        response['Cache-Control'] = 'no-store'
        return response

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
            activating = (created and v.get('is_active', True) is not False) or (
                not created and not branch.is_active and (v.get('is_active') is True or make_default))
            if activating:
                try:
                    check_branch_available(tenant)
                    edition.license_check('branches', tenant=tenant)  # Windows edition licence; no-op on cloud
                except OnboardingError as e:
                    return _bad(e.field, e.message)
                except Exception as e:
                    if e.__class__.__name__ != 'LicenseLimitError':
                        raise
                    return _bad('max_branches', e.message)
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
