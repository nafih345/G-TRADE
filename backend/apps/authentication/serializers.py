from django.conf import settings
from rest_framework import serializers, exceptions
from django.contrib.auth import get_user_model
from rest_framework_simplejwt.serializers import TokenObtainPairSerializer, TokenRefreshSerializer
from rest_framework_simplejwt.tokens import RefreshToken

User = get_user_model()

class UserSerializer(serializers.ModelSerializer):
    role_display = serializers.CharField(source='get_role_display', read_only=True)
    # The platform owner (manages client tenants) — distinct from a tenant's own Super Admin role.
    is_platform_admin = serializers.SerializerMethodField()
    # {tenant_id, tenant_name} while the platform owner works inside a client's workspace.
    workspace = serializers.SerializerMethodField()

    class Meta:
        model = User
        fields = ('id', 'username', 'email', 'first_name', 'last_name', 'role', 'role_display', 'phone', 'is_active',
                  'tenant', 'is_platform_admin', 'workspace', 'module_access',
                  'settings_features')
        read_only_fields = ('id', 'is_active', 'tenant')

    # {module: 'full'|'view'|'none'} from the tenant's subscription and this role's levels
    # (apps/common/module_access.py) — drives the sidebar and route guard.
    module_access = serializers.SerializerMethodField()

    def get_is_platform_admin(self, obj):
        from apps.common.permissions import is_platform_admin
        return is_platform_admin(obj)

    def get_workspace(self, obj):
        from apps.common import tenancy
        from apps.common.models import Tenant
        current = tenancy.current_tenant_id()
        if current is None or current == obj.tenant_id:
            return None
        tenant = Tenant.objects.filter(pk=current).values('id', 'name', 'code').first()
        return {'tenant_id': current, 'tenant_name': tenant['name'] if tenant else '',
                'tenant_code': tenant['code'] if tenant else ''} if tenant else None

    # Settings page sections this user may open (Tenant.settings_features ∩ Settings access).
    settings_features = serializers.SerializerMethodField()

    def get_module_access(self, obj):
        from apps.common.module_access import effective_access
        return effective_access(obj)

    def get_settings_features(self, obj):
        from apps.common.module_access import settings_features_for
        return settings_features_for(obj)


def ensure_login_role(user):
    """Credentials are valid at this point; now gate on role. A Django superuser always counts as
    Super Admin (bootstrap_admin --reset-password doesn't touch `role`)."""
    role = 'SUPER_ADMIN' if user.is_superuser else (user.role or '').upper()
    if role not in settings.LOGIN_ENABLED_ROLES:
        # A dict detail so "code" reaches the response body; the frontend keys on it.
        raise exceptions.AuthenticationFailed({
            'detail': 'This account is not configured for sign-in yet. Access denied.',
            'code': 'role_not_enabled',
        })
    ensure_login_tenant(user)


def ensure_login_tenant(user):
    """Every token carries the user's tenant, so an account without an active one can't sign in."""
    tenant = user.tenant if user.tenant_id else None
    if tenant is None or not tenant.is_effectively_active:
        raise exceptions.AuthenticationFailed({
            'detail': 'This account is not linked to an active business. Access denied.',
            'code': 'no_tenant' if tenant is None else 'tenant_inactive',
        })


def login_user_payload(user, tenant_id=None):
    """The signed-in user as the frontend caches it, computed in the tenant the new tokens are
    for (the user's own, or `tenant_id` for a platform workspace) — not whatever tenant the
    sign-in request itself happened to carry."""
    from apps.common import tenancy
    with tenancy.use_tenant(tenant_id or user.tenant_id):
        data = UserSerializer(user).data
    if user.is_superuser:
        data['role'] = 'SUPER_ADMIN'
        data['role_display'] = 'Super Admin'
    data['tenant_name'] = user.tenant.name if user.tenant_id else None
    return data


class CustomTokenObtainPairSerializer(TokenObtainPairSerializer):
    def validate(self, attrs):
        data = super().validate(attrs)
        ensure_login_role(self.user)
        data['user'] = login_user_payload(self.user)
        return data


class SessionTokenRefreshSerializer(TokenRefreshSerializer):
    """Refresh only while the sign-in session the token belongs to is still open and not idle."""

    def validate(self, attrs):
        from apps.security import policy
        refresh = RefreshToken(attrs['refresh'])
        user = User.objects.filter(pk=refresh.get('user_id'), is_active=True).first()
        if user is None or user.tenant_id is None or refresh.get('tenant_id') is None:
            raise policy.SessionEnded()
        if refresh.get('tenant_id') != user.tenant_id:
            # Only a platform workspace token may carry another tenant, and only while that
            # client is still active.
            from apps.common.models import Tenant
            from apps.common.tenant_context import workspace_allowed
            if not workspace_allowed(user, refresh) or not Tenant.objects.filter(
                    Tenant.active_q(), pk=refresh.get('tenant_id')).exists():
                raise policy.SessionEnded()
        policy.validate_session(refresh.get('sid'), user, policy.get_settings().inactivity_timeout_minutes)
        return super().validate(attrs)
