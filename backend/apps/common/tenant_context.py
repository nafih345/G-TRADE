"""Per-request tenant resolution (see apps/common/tenancy.py for what the tenant scopes).

The tenant comes from the `tenant_id` claim of the caller's access token. The token is signed,
so a client cannot pick another tenant without forging it, and nothing in the request body or
headers is consulted. This runs as middleware — before DRF authenticates — because other
middleware (BranchContextMiddleware) already queries tenant data. LenientJWTAuthentication
then confirms the token's tenant is still the user's own (check_user_tenant).

Every /api/ request is "strict": without a valid token it sees no tenant rows and may write
none, whatever the view's permission_classes allow.
"""
from django.conf import settings
from rest_framework import exceptions

from apps.common import hot_cache, tenancy


def _user_tenant_id(user_id):
    from django.contrib.auth import get_user_model
    User = get_user_model()
    return hot_cache.get_or_load(
        f'tenant:user:{user_id}',
        lambda: User.objects.filter(pk=user_id).values_list('tenant_id', flat=True).first())


def access_token(request):
    """The request's valid Bearer access token (decoded once per request), or None."""
    cached = getattr(request, '_tenant_access_token', False)
    if cached is not False:
        return cached
    from rest_framework_simplejwt.exceptions import TokenError
    from rest_framework_simplejwt.settings import api_settings
    from rest_framework_simplejwt.tokens import AccessToken

    token = None
    parts = (request.META.get('HTTP_AUTHORIZATION') or '').split()
    if len(parts) == 2 and parts[0] in api_settings.AUTH_HEADER_TYPES:
        try:
            token = AccessToken(parts[1])
        except (TokenError, Exception):
            token = None
    try:
        request._tenant_access_token = token
    except Exception:
        pass
    return token


def token_identity(request):
    """(username, role) of the user the request's signed token belongs to, or None.

    Middleware that runs before DRF authentication (branch access, the stock-ledger actor) used
    to take identity from the X-User-Name / X-User-Role headers, which any caller can set — a
    cashier sending `X-User-Role: SUPER_ADMIN` got every branch. With a valid token those
    headers are ignored."""
    token = access_token(request)
    if token is None:
        return None
    from django.contrib.auth import get_user_model
    from rest_framework_simplejwt.settings import api_settings
    user_id = token.get(api_settings.USER_ID_CLAIM)
    if not user_id:
        return None
    User = get_user_model()

    def load():
        row = User.objects.filter(pk=user_id, is_active=True).values_list('username', 'role', 'is_superuser').first()
        if row is None:
            return None
        # A superuser counts as Super Admin whatever `role` says (as at sign-in).
        return row[0], 'SUPER_ADMIN' if row[2] else row[1]
    return hot_cache.get_or_load(f'identity:user:{user_id}', load)


def tenant_from_request(request):
    """Tenant id from a valid Bearer access token, or None."""
    from rest_framework_simplejwt.settings import api_settings

    token = access_token(request)
    if token is None:
        return None
    tenant_id = token.get('tenant_id')
    if tenant_id is None:
        # Issued before tenancy existed: fall back to the user's tenant. Refreshing such a
        # token is refused (SessionTokenRefreshSerializer), so these age out within a day.
        user_id = token.get(api_settings.USER_ID_CLAIM)
        tenant_id = _user_tenant_id(user_id) if user_id else None
    try:
        return int(tenant_id) if tenant_id is not None else None
    except (TypeError, ValueError):
        return None


def _tenant_active(tenant_id):
    from apps.common.models import Tenant
    return hot_cache.get_or_load(
        f'tenant:active:{tenant_id}',
        # A scheduled deactivation counts from its effective date (Tenant.active_q).
        lambda: Tenant.objects.filter(Tenant.active_q(), pk=tenant_id).exists())


def workspace_allowed(user, token):
    """A token scoped to a tenant other than the user's own is valid only as a platform workspace:
    minted by the platform owner from Client Management (signed `workspace` claim) and still held
    by an active platform owner."""
    from apps.common.permissions import is_platform_owner
    return bool(token is not None and token.get('workspace') and is_platform_owner(user))


def check_user_tenant(user, token=None):
    """Called once the token's user is known: the token's tenant must be the user's (or a platform
    workspace the owner opened), and active."""
    tenant_id = tenancy.current_tenant_id()
    if user.tenant_id is None or tenant_id is None or (
            tenant_id != user.tenant_id and not workspace_allowed(user, token)):
        raise exceptions.AuthenticationFailed('Your sign-in is no longer valid for this business. Sign in again.',
                                              code='tenant_mismatch')
    if not _tenant_active(tenant_id):
        raise exceptions.PermissionDenied('This business account is disabled.')


def install_drf_hook():
    """Scope a request whose user DRF authenticated without a JWT tenant claim reaching the
    middleware (DRF's force_authenticate in tests, any non-JWT authentication class) to that
    user's tenant, for the rest of the view. Requests with a token are already scoped."""
    from rest_framework.views import APIView

    if getattr(APIView, '_tenant_hook_installed', False):
        return
    orig_dispatch = APIView.dispatch
    orig_perform_authentication = APIView.perform_authentication

    def dispatch(self, request, *args, **kwargs):
        self._tenant_tokens = []
        try:
            return orig_dispatch(self, request, *args, **kwargs)
        finally:
            for token in reversed(self._tenant_tokens):
                tenancy.deactivate(token)

    def perform_authentication(self, request):
        orig_perform_authentication(self, request)
        # ~25 views declare `authentication_classes = []` (+ AllowAny). With a real token they
        # used to run as an anonymous user inside the token's tenant: role-level write limits
        # (module_access), the tenant/user match and the sign-in session checks were all skipped
        # — a view-only role could still edit products or branch access, and a signed-out or
        # timed-out session kept working there. A valid token is now always authenticated.
        # Views that must stay token-blind (sign-in itself, signed download links) opt out.
        if (not request.authenticators and getattr(self, 'token_authentication', True)
                and access_token(request._request) is not None):
            from apps.common.authentication import LenientJWTAuthentication
            # Without an authenticator DRF turns AuthenticationFailed into 403; the frontend signs
            # out on a 401 session_expired, so answer like a token-authenticated view does.
            self._token_authenticator = LenientJWTAuthentication()
            result = self._token_authenticator.authenticate(request)
            if result is not None:
                request.user, request.auth = result
        user = request.user
        tenant_id = getattr(user, 'tenant_id', None) if getattr(user, 'is_authenticated', False) else None
        if tenant_id is not None and tenancy.current_tenant_id() is None:
            self._tenant_tokens.append(tenancy.activate(tenant_id, strict=True))

    orig_get_authenticate_header = APIView.get_authenticate_header

    def get_authenticate_header(self, request):
        authenticator = getattr(self, '_token_authenticator', None)
        if authenticator is not None:
            return authenticator.authenticate_header(request)
        return orig_get_authenticate_header(self, request)

    APIView.dispatch = dispatch
    APIView.perform_authentication = perform_authentication
    APIView.get_authenticate_header = get_authenticate_header
    APIView._tenant_hook_installed = True


class TenantContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        tenant_id = tenant_from_request(request)
        if tenant_id is None:
            # None outside the test runner (see settings.TENANCY_ANONYMOUS_TENANT_ID).
            tenant_id = getattr(settings, 'TENANCY_ANONYMOUS_TENANT_ID', None)
        elif not _tenant_active(tenant_id):
            # A deactivated tenant's still-unexpired token: no scope at all, so even views that
            # skip authentication (AllowAny, authentication_classes = []) see nothing.
            tenant_id = None
        request.tenant_id = tenant_id
        token = tenancy.activate(tenant_id, strict=request.path.startswith('/api/'))
        try:
            return self.get_response(request)
        finally:
            tenancy.deactivate(token)
