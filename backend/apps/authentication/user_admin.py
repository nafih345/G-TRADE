"""Administration → Users: a business's own admin staff create and manage its staff accounts.

    GET   /api/auth/users/                       the business's users, branches, seats and the
                                                 roles this admin may assign (+ what each opens)
    POST  /api/auth/users/                       create a user — ID, password, role, branch access
    PATCH /api/auth/users/<uid>/                 role, contact, active, branch access
    POST  /api/auth/users/<uid>/reset-password/

Admin staff only (IsUserAdmin): an admin role (USER_ADMIN_ROLES) that also has 'full' on the
Administration module. An account is created and usable at once — no approval step and no
password re-confirmation (the path is deliberately not in security.policy.SENSITIVE_WRITES).

Everything stays inside the admin's own tenant, and an admin can't hand out more than they hold:
ROLE_RANK caps which roles they may assign and which accounts they may edit (an Administrator
can't create or edit a Super Admin; a Branch Admin can't touch Administrators either). The rules
for seats, passwords and branch access are the platform console's (apps/common/superadmin_*).
"""
from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.shortcuts import get_object_or_404
from rest_framework import permissions, status
from rest_framework.response import Response
from rest_framework.views import APIView

from apps.common import module_access, tenancy
from apps.common.models import Tenant
from apps.common.superadmin_serializers import (
    ClientUserCreateSerializer, ClientUserUpdateSerializer, PasswordResetSerializer, _password_errors,
)
from apps.common.superadmin_views import (
    BRANCH_FIELDS, USER_FIELDS, _bad, _branch_access_map, _end_tenant_sessions, _save_branch_access,
)
from apps.common.tenant_onboarding import OnboardingError, check_seat_available, log_event

# Who counts as admin staff, highest first. Lower rank number = more authority; an admin may
# assign / manage only roles ranked below their own (the owner may also manage other owners).
ROLE_RANK = {'SUPER_ADMIN': 0, 'ADMINISTRATOR': 1, 'BRANCH_ADMIN': 2}
USER_ADMIN_ROLES = tuple(ROLE_RANK)
STAFF_RANK = 3  # every other role


def _role(user):
    return 'SUPER_ADMIN' if user.is_superuser else (user.role or '')


def _rank(role):
    return ROLE_RANK.get(role, STAFF_RANK)


def can_manage_role(actor, role):
    mine = _rank(_role(actor))
    return mine == 0 or _rank(role) > mine


class IsUserAdmin(permissions.BasePermission):
    message = 'Only admin staff with full Administration access can manage users.'

    def has_permission(self, request, view):
        user = request.user
        if not (user and user.is_authenticated and user.tenant_id):
            return False
        if _role(user) not in USER_ADMIN_ROLES:
            return False
        return module_access.effective_access(user).get('admin') == module_access.FULL


def _tenant(request):
    # The request's tenant: the user's own, or the client a platform workspace token acts in.
    from apps.common.permissions import request_tenant_id
    return Tenant.objects.get(pk=request_tenant_id(request.user))


def _payload(request, tenant):
    from apps.company.models import Branch
    actor = request.user
    access = _branch_access_map(tenant)
    users = list(get_user_model().objects.filter(tenant=tenant).order_by('date_joined').values(*USER_FIELDS))
    for u in users:
        superuser = bool(u.pop('is_superuser'))
        u['branch_access'] = access.get(u['username'])
        u['is_platform_admin'] = superuser and tenant.pk == tenancy.DEFAULT_TENANT_ID
        u['can_manage'] = (not superuser and str(u['id']) != str(actor.pk)
                           and can_manage_role(actor, u['role']))
    with tenancy.use_tenant(tenant.pk):
        branches = list(Branch.objects.filter(is_active=True).order_by('-is_default', 'name').values(*BRANCH_FIELDS))
    config = {'modules': module_access.subscribed_modules(tenant),
              'role_permissions': dict(tenant.role_permissions or {})}
    enabled = set(config['modules'])
    role_access = {
        role: {m: lvl for m, lvl in module_access.role_levels(role, config['role_permissions']).items()
               if m in enabled and lvl != module_access.NONE}
        for role in module_access.CLIENT_ROLE_KEYS
    }
    catalog = module_access.catalog()
    return {
        'id': tenant.pk, 'name': tenant.name, 'max_users': tenant.max_users,
        'users': users, 'branches': branches,
        'catalog': {
            'roles': catalog['roles'],
            'modules': catalog['modules'],
            'login_enabled_roles': catalog['login_enabled_roles'],
            'assignable_roles': [r for r in module_access.CLIENT_ROLE_KEYS if can_manage_role(actor, r)],
            'role_access': role_access,
        },
    }


class StaffUsersView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsUserAdmin]

    def get(self, request):
        return Response(_payload(request, _tenant(request)))

    def post(self, request):
        tenant = _tenant(request)
        serializer = ClientUserCreateSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        v = serializer.validated_data
        if not can_manage_role(request.user, v['role']):
            return _bad('role', 'You cannot create an account with this role.')
        User = get_user_model()
        try:
            with transaction.atomic():
                Tenant.objects.select_for_update().filter(pk=tenant.pk).first()  # serialise seat checks
                check_seat_available(tenant)
                user = User.objects.create_user(
                    username=v['username'], password=v['password'], role=v['role'], tenant=tenant,
                    email=v['email'], first_name=v['first_name'], last_name=v['last_name'],
                    phone=v['phone'] or None)
                _save_branch_access(tenant, user.username, v)
                log_event(tenant, 'USER_ADDED', request.user, username=user.username, role=user.role,
                          via='administration')
        except OnboardingError as e:
            return _bad(e.field, e.message)
        except IntegrityError:
            return _bad('username', 'That username was just taken. Try another.')
        return Response(_payload(request, tenant), status=status.HTTP_201_CREATED)


def _target(request, tenant, user_id):
    """(user, None) when the admin may manage that account, else (None, why not)."""
    user = get_object_or_404(get_user_model(), pk=user_id, tenant=tenant)
    if user.is_superuser:
        return None, 'The platform administrator account cannot be edited here.'
    if user.pk == request.user.pk:
        return None, 'You cannot change your own account here. Ask another administrator.'
    if not can_manage_role(request.user, user.role):
        return None, 'You cannot edit an account with this role.'
    return user, None


class StaffUserDetailView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsUserAdmin]

    def patch(self, request, user_id):
        tenant = _tenant(request)
        user, refusal = _target(request, tenant, user_id)
        if user is None:
            return Response({'detail': refusal}, status=status.HTTP_403_FORBIDDEN)
        serializer = ClientUserUpdateSerializer(data=request.data, partial=True)
        serializer.is_valid(raise_exception=True)
        v = serializer.validated_data
        if 'role' in v and not can_manage_role(request.user, v['role']):
            return _bad('role', 'You cannot give an account this role.')
        role = v.get('role', user.role)
        is_active = v.get('is_active', user.is_active)
        if user.role == 'SUPER_ADMIN' and user.is_active and not (role == 'SUPER_ADMIN' and is_active):
            others = get_user_model().objects.filter(tenant=tenant, role='SUPER_ADMIN', is_active=True).exclude(pk=user.pk)
            if not others.exists():
                return _bad('role' if 'role' in v else 'is_active',
                            'This is the only active Super Admin. Make another user Super Admin first.')
        changes = {}
        try:
            with transaction.atomic():
                if is_active and not user.is_active:
                    Tenant.objects.select_for_update().filter(pk=tenant.pk).first()
                    check_seat_available(tenant)
                for field in ('role', 'first_name', 'last_name', 'email', 'phone', 'is_active'):
                    if field not in v:
                        continue
                    value = (v[field] or None) if field == 'phone' else v[field]
                    if getattr(user, field) != value:
                        changes[field] = {'from': getattr(user, field), 'to': value}
                        setattr(user, field, value)
                if changes:
                    user.save()
                _save_branch_access(tenant, user.username, v)
                if changes or any(k in v for k in ('access_all_branches', 'branch_ids', 'default_branch_id')):
                    log_event(tenant, 'USER_UPDATED', request.user, username=user.username, changes=changes,
                              via='administration')
        except OnboardingError as e:
            return _bad(e.field, e.message)
        if changes.get('is_active', {}).get('to') is False or 'role' in changes:
            _end_tenant_sessions(tenant, user=user)  # new role / disabled: sign in again
        return Response(_payload(request, tenant))


class StaffUserPasswordView(APIView):
    permission_classes = [permissions.IsAuthenticated, IsUserAdmin]

    def post(self, request, user_id):
        tenant = _tenant(request)
        user, refusal = _target(request, tenant, user_id)
        if user is None:
            return Response({'detail': refusal}, status=status.HTTP_403_FORBIDDEN)
        serializer = PasswordResetSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        password = serializer.validated_data['password']
        errors = _password_errors(password, user.username, user.email)
        if errors:
            return Response({'password': errors}, status=status.HTTP_400_BAD_REQUEST)
        user.set_password(password)
        user.save(update_fields=['password'])
        _end_tenant_sessions(tenant, user=user)
        log_event(tenant, 'PASSWORD_RESET', request.user, username=user.username, via='administration')
        return Response({'detail': f'Password for {user.username} changed. Their open sessions were ended.'})
