from rest_framework import permissions

from apps.common import tenancy


def is_platform_admin(user):
    """The platform owner: a Django superuser in the default tenant (#1). Tenant Super Admins
    have role SUPER_ADMIN but are never is_superuser (see tenant_onboarding), so they fail."""
    return bool(user and user.is_authenticated and user.is_active and user.is_superuser
                and user.tenant_id == tenancy.DEFAULT_TENANT_ID)


class IsPlatformAdmin(permissions.BasePermission):
    message = 'Only the platform Super Admin can manage client accounts.'

    def has_permission(self, request, view):
        return is_platform_admin(request.user)
