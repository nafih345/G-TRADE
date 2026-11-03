"""Platform console: onboard and manage client businesses (tenants).

    GET   /api/superadmin/tenants/                  every tenant with admin, user and branch counts
    POST  /api/superadmin/tenants/                  onboard a client (tenant + Super Admin + HO branch)
    GET   /api/superadmin/tenants/<id>/             one tenant plus its users and branches
    POST  /api/superadmin/tenants/<id>/set-active/  {"is_active": bool}

Platform owner only (IsPlatformAdmin); every write also needs a recent password confirmation
when the security policy asks for one (security.policy.SENSITIVE_WRITES). Tenant itself is not
tenant-owned; per-tenant rows (branches) are read under tenancy.unscoped().
"""
from django.contrib.auth import get_user_model
from django.db import IntegrityError
from django.db.models import Count, Q
from rest_framework import mixins, permissions, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.common import tenancy
from apps.common.models import Tenant
from apps.common.permissions import IsPlatformAdmin
from apps.common.superadmin_serializers import TenantOnboardSerializer, TenantSerializer
from apps.common.tenant_onboarding import OnboardingError, onboard_tenant


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


class TenantAdminViewSet(mixins.ListModelMixin, mixins.RetrieveModelMixin, viewsets.GenericViewSet):
    permission_classes = [permissions.IsAuthenticated, IsPlatformAdmin]
    serializer_class = TenantSerializer
    pagination_class = None  # a handful of clients; the page shows them all

    def get_queryset(self):
        return Tenant.objects.annotate(user_count=Count('users', distinct=True)).order_by('id')

    def _context_for(self, tenants):
        ids = [t.pk for t in tenants]
        return {**self.get_serializer_context(), 'admins': _admin_usernames(ids),
                'branch_counts': _branch_counts(ids)}

    def list(self, request, *args, **kwargs):
        tenants = list(self.get_queryset())
        return Response(TenantSerializer(tenants, many=True, context=self._context_for(tenants)).data)

    def retrieve(self, request, *args, **kwargs):
        from apps.company.models import Branch
        tenant = self.get_object()
        data = TenantSerializer(tenant, context=self._context_for([tenant])).data
        data['users'] = list(get_user_model().objects.filter(tenant=tenant).order_by('date_joined').values(
            'id', 'username', 'email', 'role', 'is_active', 'date_joined', 'last_login'))
        with tenancy.unscoped():
            data['branches'] = list(Branch.objects.filter(tenant_id=tenant.pk).order_by('-is_default', 'name')
                                    .values('id', 'name', 'code', 'is_active', 'is_default'))
        return Response(data)

    def create(self, request, *args, **kwargs):
        serializer = TenantOnboardSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        v = serializer.validated_data
        try:
            tenant, admin = onboard_tenant(
                name=v['tenant_name'], admin_username=v['admin_username'], password=v['password'],
                admin_email=v['admin_email'], contact_phone=v['contact_phone'], branch_name=v['branch_name'])
        except OnboardingError as e:
            return Response({e.field: [e.message]}, status=status.HTTP_400_BAD_REQUEST)
        except IntegrityError:
            # Lost a race with a simultaneous onboarding of the same name / username.
            return Response({'detail': 'That client name or username was just taken. Try another.'},
                            status=status.HTTP_400_BAD_REQUEST)
        tenant = self.get_queryset().get(pk=tenant.pk)
        data = TenantSerializer(tenant, context=self._context_for([tenant])).data
        data['admin_username'] = admin.username
        return Response(data, status=status.HTTP_201_CREATED)

    @action(detail=True, methods=['post'], url_path='set-active')
    def set_active(self, request, pk=None):
        tenant = self.get_object()
        is_active = request.data.get('is_active')
        if not isinstance(is_active, bool):
            return Response({'is_active': ['Send true or false.']}, status=status.HTTP_400_BAD_REQUEST)
        if not is_active and tenant.pk in (tenancy.DEFAULT_TENANT_ID, request.user.tenant_id):
            return Response({'detail': 'The platform account itself cannot be deactivated.'},
                            status=status.HTTP_400_BAD_REQUEST)
        if tenant.is_active != is_active:
            tenant.is_active = is_active
            tenant.save(update_fields=['is_active'])  # post_save clears hot_cache's tenant:active
            if not is_active:
                _end_tenant_sessions(tenant)
        tenant = self.get_queryset().get(pk=tenant.pk)
        return Response(TenantSerializer(tenant, context=self._context_for([tenant])).data)


def _end_tenant_sessions(tenant):
    """Sign everyone in a deactivated tenant out now. Their tokens would be refused anyway
    (tenant_context.check_user_tenant), but this also stops refreshes cleanly."""
    from apps.security import policy
    from apps.security.models import AuthSession
    for sid in AuthSession.objects.filter(user__tenant=tenant, ended_at__isnull=True).values_list('pk', flat=True):
        policy.end_session(sid, 'REVOKED')
