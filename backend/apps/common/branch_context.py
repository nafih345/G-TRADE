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

from django.utils.functional import SimpleLazyObject
from rest_framework.exceptions import PermissionDenied

from apps.common import hot_cache

ADMIN_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR'}

# Request attributes populated by the middleware.
#   request.multi_branch_enabled : bool
#   request.active_branch        : company.Branch | None
#   request.allowed_branch_ids   : set[str] | None   (None == all branches)
#   request.is_branch_admin      : bool
#   request.branch_denied        : bool              (requested an off-limits branch)


# Every lookup below runs before the view on every API request, so each goes through
# hot_cache: on the hosted database a lookup is a network round trip, and these rows almost
# never change (saving one clears the cache — see apps/common/apps.py).

def _branch_settings():
    """(multi_branch_enabled, default_branch)."""
    from apps.company.models import Branch, BusinessSettings

    def load():
        settings_obj = BusinessSettings.load()
        return bool(settings_obj.multi_branch_enabled), settings_obj.default_branch or Branch.get_default()
    return hot_cache.get_or_load('branch:settings', load)


def _access_tuple(access):
    if access is None:
        return None
    allowed = frozenset(str(b) for b in access.branches.values_list('id', flat=True))
    return bool(access.access_all_branches), allowed, access.default_branch


def _user_access(username, user_id=None):
    """(access_all_branches, allowed branch ids or None, access default branch) for a user's
    UserBranchAccess row, or None when the user has none.

    P1 Task 4: a signed-in user (user_id from the token) is looked up by that stable id only —
    never by name, so a rename, a case variant or a deleted namesake cannot hand over someone
    else's row. The username lookup only serves token-less requests (which tenancy already
    limits to seeing nothing)."""
    from apps.company.models import UserBranchAccess

    if user_id is not None:
        def load_by_id():
            return _access_tuple(UserBranchAccess.objects.select_related('default_branch')
                                 .filter(user_id=user_id).order_by('pk').first())
        return hot_cache.get_or_load(f'branch:access:u{user_id}', load_by_id)

    def load():
        return _access_tuple(UserBranchAccess.objects.select_related('default_branch')
                             .filter(username__iexact=username).order_by('pk').first())
    return hot_cache.get_or_load(f'branch:access:{username.lower()}', load) if username else None


def user_access_for(user):
    """_user_access for a User object (signed links, background checks)."""
    if user is None or getattr(user, 'pk', None) is None:
        return None
    return _user_access(user.username, user.pk)


def user_branch_permitted(user, branch_id):
    """May `user` (outside a request: signed download links) use a record in `branch_id`?
    Same rule as branch_permitted(): Multi-Branch off, an admin role or an all-branches row =
    unrestricted; a user with no access row has no branch (policy decision 1, fail-closed);
    otherwise only their branches (never an unassigned row)."""
    multi, _default = _branch_settings()
    if not multi:
        return True
    role = 'SUPER_ADMIN' if getattr(user, 'is_superuser', False) else (getattr(user, 'role', '') or '').upper()
    access = user_access_for(user)
    if role in ADMIN_ROLES or (access is not None and access[0]):
        return True
    return access is not None and branch_id is not None and str(branch_id) in access[1]


def _branch_by_id(branch_id):
    from apps.company.models import Branch
    return hot_cache.get_or_load(f'branch:id:{branch_id}', lambda: Branch.objects.filter(id=branch_id).first())


def _first_permitted_branch(username, allowed):
    """The working branch of a restricted user with no usable default: their first permitted
    branch (active ones first, then by name), or None when they have none."""
    if not allowed:
        return None
    from apps.company.models import Branch

    def load():
        return Branch.objects.filter(pk__in=list(allowed)).order_by('-is_active', 'name').first()
    return hot_cache.get_or_load(f'branch:home:{username.lower()}:{",".join(sorted(allowed))}', load)


def _resolve(request):
    try:
        multi, default_branch = _branch_settings()
    except Exception:
        return

    request.multi_branch_enabled = multi

    # Identity comes from the signed token. The X-User-* headers are client-controlled and only
    # describe requests without one — which tenancy already limits to seeing nothing.
    from apps.common.tenant_context import token_identity, token_user_id
    identity = token_identity(request)
    user_id = None
    if identity is not None:
        username, role = identity[0] or '', (identity[1] or '').upper()
        user_id = token_user_id(request)
    else:
        username = request.headers.get('X-User-Name') or getattr(getattr(request, 'user', None), 'username', '') or ''
        role = (request.headers.get('X-User-Role') or getattr(getattr(request, 'user', None), 'role', '') or '').upper()

    def is_admin():
        access = _user_access(username, user_id)
        return role in ADMIN_ROLES or bool(access and access[0])

    if not multi:
        # Single-branch mode: everything silently uses the default branch. Only the
        # branch-context endpoint reads is_branch_admin here, so look the access row up lazily.
        request.active_branch = default_branch
        request.allowed_branch_ids = None
        request.is_branch_admin = SimpleLazyObject(is_admin)
        return

    access = _user_access(username, user_id)
    request.is_branch_admin = admin = is_admin()

    if admin:
        # Explicitly unrestricted: an admin role, or an access row with "all branches".
        request.allowed_branch_ids = None
    else:
        # Policy decision 1 (fail-closed): a user with no access row has no branch at all —
        # they see no branch-scoped data and cannot create any until an admin assigns them.
        request.allowed_branch_ids = set(access[1]) if access else set()

    # The branch this user is assigned to (UserBranchAccess.default_branch), else the client's
    # default branch: where a session starts, and where it falls back to. A branch-restricted user
    # whose default is empty (or no longer one of their branches) must not land in the client's
    # default branch — that may be a branch they cannot use; take their first permitted branch,
    # or none at all (they then see nothing and cannot create).
    home = (access[2] if access else None) or default_branch
    allowed = request.allowed_branch_ids
    if allowed is not None and (home is None or str(home.pk) not in allowed):
        home = _first_permitted_branch(username, allowed)
    request.home_branch = home

    requested_id = request.headers.get('X-Branch-Id') or None
    if requested_id:
        if request.allowed_branch_ids is not None and str(requested_id) not in request.allowed_branch_ids:
            request.branch_denied = True
            request.active_branch = None
            return
        request.active_branch = _branch_by_id(requested_id) or home
    else:
        request.active_branch = home


class BranchContextMiddleware:
    def __init__(self, get_response):
        self.get_response = get_response

    def __call__(self, request):
        request.multi_branch_enabled = False
        request.active_branch = None
        request.allowed_branch_ids = None
        request.is_branch_admin = False
        request.branch_denied = False
        request.home_branch = None

        # Only branch-aware API traffic needs resolution; skip admin/static/migrations noise, and
        # the health endpoints — liveness must never touch the database (Render calls it every
        # few seconds), and /api/health/ reads what it reports itself.
        if request.path.startswith('/api/') and not request.path.startswith('/api/health/'):
            try:
                _resolve(request)
            except Exception:
                # Fail closed: a lookup that broke halfway must not leave a Multi-Branch request
                # with "every branch" (allowed_branch_ids None) for a user who is not an admin.
                if request.multi_branch_enabled and request.is_branch_admin is not True:
                    request.allowed_branch_ids = set()
                    request.active_branch = None

        # Audit name for stock-ledger rows written during this request (see request_actor).
        from apps.common.request_actor import set_actor, reset_actor
        actor = ''
        if request.path.startswith('/api/'):
            try:
                from apps.common.tenant_context import token_identity
                identity = token_identity(request)
                actor = (identity[0] if identity else '') or ''
            except Exception:
                actor = ''
        token = set_actor(actor or (request.META.get('HTTP_X_USER_NAME') or '').strip())
        try:
            return self.get_response(request)
        finally:
            reset_actor(token)


def get_active_branch(request):
    """Active branch for this request, raising 403 if an off-limits branch was requested."""
    if getattr(request, 'branch_denied', False):
        raise PermissionDenied('You do not have access to the selected branch.')
    return getattr(request, 'active_branch', None)


def get_allowed_branch_ids(request):
    """set[str] of branch ids the caller may see, or None for unrestricted."""
    return getattr(request, 'allowed_branch_ids', None)


# ---------------------------------------------------------------------------------------------
# Write / reference authorization (P1 / B-4, N4). One rule for every branch-scoped module:
#   * Multi-Branch OFF, or an unrestricted user (admin role / an all-branches access row): no
#     restriction. A user with no UserBranchAccess row has no branch (fail-closed, decision 1).
#   * A branch-restricted user may use only their permitted branches. A record with no branch
#     (legacy / head office) is not theirs either (P1-Q2).
# ---------------------------------------------------------------------------------------------

BRANCH_DENIED = 'You do not have access to the selected branch.'


def is_branch_restricted(request):
    return bool(getattr(request, 'multi_branch_enabled', False)) and get_allowed_branch_ids(request) is not None


def branch_permitted(request, branch_id):
    """May this caller use / see a record in `branch_id` (None = an unassigned record)?"""
    if not is_branch_restricted(request):
        return True
    return branch_id is not None and str(branch_id) in get_allowed_branch_ids(request)


def require_branch_permitted(request, branch_id, message=BRANCH_DENIED):
    if not branch_permitted(request, branch_id):
        raise PermissionDenied(message)


def resolve_requested_branch(request, value):
    """A branch id sent by the client → the Branch, never trusted as-is: None for an empty value,
    400 for an id that is not a branch of this client (unknown, malformed, or another tenant's —
    the Branch manager is tenant-scoped), 403 for a branch the caller may not use."""
    from rest_framework.exceptions import ValidationError
    if value in (None, ''):
        return None
    branch_id = getattr(value, 'pk', value)
    from apps.company.models import Branch
    try:
        branch = Branch.objects.filter(pk=str(branch_id)).first()
    except Exception:  # malformed UUID
        branch = None
    if branch is None:
        raise ValidationError({'branch': ['Unknown branch.']})
    require_branch_permitted(request, branch.pk)
    return branch


def scope_to_permitted(request, qs, field='branch'):
    """Limit a queryset to the caller's permitted branches (no-op when unrestricted). Rows with
    no branch drop out for a restricted user (P1-Q2)."""
    if not is_branch_restricted(request):
        return qs
    return qs.filter(**{f'{field}_id__in': list(get_allowed_branch_ids(request))})
