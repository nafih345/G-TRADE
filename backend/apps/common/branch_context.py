"""Centralized active-branch resolution (spec sections 3, 8, 14).

Every request that reaches a branch-aware endpoint needs to know:
  1. Is Multi-Branch Mode enabled at all?
  2. Which branch is "active" for this request?
  3. Is the caller allowed to touch that branch?

Because the app's users currently live in the frontend's localStorage rather than the
auth_user table (see apps.common.authentication.LenientJWTAuthentication), identity here is
taken from request headers the frontend attaches on every axios call:
    X-User-Name  -> username, matched against company.UserBranchAccess
    X-User-Role  -> role string; SUPER_ADMIN / ADMINISTRATOR always get every branch
    X-Branch-Id  -> the branch the user picked in the header switcher

This matches the app's existing (pragmatic, non-cryptographic) security posture while still
closing the "just change the id in the request" hole at the API layer: an unauthorized
X-Branch-Id makes get_active_branch raise PermissionDenied (403) via BranchScopedViewSetMixin.
"""

from rest_framework.exceptions import PermissionDenied

ADMIN_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR'}

# Request attributes populated by the middleware.
#   request.multi_branch_enabled : bool
#   request.active_branch        : company.Branch | None
#   request.allowed_branch_ids   : set[str] | None   (None == all branches)
#   request.is_branch_admin      : bool
#   request.branch_denied        : bool              (requested an off-limits branch)


def _resolve(request):
    from apps.company.models import Branch, BusinessSettings, UserBranchAccess

    try:
        settings_obj = BusinessSettings.load()
    except Exception:
        return

    multi = bool(settings_obj.multi_branch_enabled)
    default_branch = settings_obj.default_branch or Branch.get_default()

    request.multi_branch_enabled = multi

    username = request.headers.get('X-User-Name') or getattr(getattr(request, 'user', None), 'username', '') or ''
    role = (request.headers.get('X-User-Role') or getattr(getattr(request, 'user', None), 'role', '') or '').upper()

    access = UserBranchAccess.objects.filter(username__iexact=username).first() if username else None
    is_admin = role in ADMIN_ROLES or bool(access and access.access_all_branches)
    request.is_branch_admin = is_admin

    if not multi:
        # Single-branch mode: everything silently uses the default branch.
        request.active_branch = default_branch
        request.allowed_branch_ids = None
        return

    if is_admin or access is None:
        # Admins (and, until access is configured, everyone) may use any active branch.
        request.allowed_branch_ids = None
    else:
        request.allowed_branch_ids = {str(b) for b in access.branches.values_list('id', flat=True)}

    requested_id = request.headers.get('X-Branch-Id') or None
    if requested_id:
        if request.allowed_branch_ids is not None and str(requested_id) not in request.allowed_branch_ids:
            request.branch_denied = True
            request.active_branch = None
            return
        branch = Branch.objects.filter(id=requested_id).first()
        request.active_branch = branch or default_branch
    else:
        fallback = (access.default_branch if access and access.default_branch_id else None) or default_branch
        request.active_branch = fallback


class BranchContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.multi_branch_enabled = False
        request.active_branch = None
        request.allowed_branch_ids = None
        request.is_branch_admin = False
        request.branch_denied = False

        # Only branch-aware API traffic needs resolution; skip admin/static/migrations noise.
        if request.path.startswith('/api/'):
            try:
                _resolve(request)
            except Exception:
                pass

        return self.get_response(request)


def get_active_branch(request):
    """Active branch for this request, raising 403 if an off-limits branch was requested."""
    if getattr(request, 'branch_denied', False):
        raise PermissionDenied('You do not have access to the selected branch.')
    return getattr(request, 'active_branch', None)


def get_allowed_branch_ids(request):
    """set[str] of branch ids the caller may see, or None for unrestricted."""
    return getattr(request, 'allowed_branch_ids', None)
