from rest_framework import permissions

from apps.common import tenancy


def is_platform_owner(user):
    """A Django superuser in the default tenant (#1), whatever tenant the request acts in."""
    return bool(user and user.is_authenticated and user.is_active and user.is_superuser
                and user.tenant_id == tenancy.DEFAULT_TENANT_ID)


def is_platform_admin(user):
    """The platform owner acting as the platform. Tenant Super Admins have role SUPER_ADMIN but
    are never is_superuser (see tenant_onboarding), so they fail.

    While the owner works inside a client's workspace (a `workspace` token scoped to that client,
    see superadmin_views.TenantViewSet.workspace) the request's tenant is the client's, and this
    is False: platform-wide powers never mix with one client's data in the same request."""
    if not is_platform_owner(user):
        return False
    current = tenancy.current_tenant_id()
    return current is None or current == user.tenant_id


def request_tenant_id(user):
    """The tenant a signed-in user's request acts in: the user's own, except for the platform
    owner inside a client's workspace (the request is then scoped to that client).

    The ambient tenant is never trusted for anyone else — at sign-in it can be a leftover token's
    or the test runner's anonymous tenant, which once put another tenant's modules in the
    sign-in payload."""
    own = getattr(user, 'tenant_id', None)
    current = tenancy.current_tenant_id()
    if current is not None and current != own and is_platform_owner(user):
        return current
    return own


class IsPlatformAdmin(permissions.BasePermission):
    message = 'Only the platform Super Admin can manage client accounts.'

    def has_permission(self, request, view):
        return is_platform_admin(request.user)
