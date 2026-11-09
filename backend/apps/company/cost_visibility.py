"""Who may see a product's cost (purchase) price — Settings → Pricing Rules → "Show Cost Price".

Stored per tenant beside the other pricing rules (BusinessSettings.preferences['pricing_rules']):
    show_cost_price  bool      master switch; OFF → nobody sees cost anywhere (not even the owner)
    cost_viewers     [user id] staff the Main Admin picked; ON → the Main Admin plus these users

The Main Admin is the tenant's SUPER_ADMIN role (the owner) or a Django superuser (the platform
owner, also inside a client's workspace). Every API that returns a product cost asks
`can_view_cost(request.user)` and leaves the key out of the JSON when it says no, so the value
never reaches the browser. The profile (/api/auth/profile/, and the login payload) carries
`can_view_cost` so screens decide their columns before the first grid request.
"""
from django.contrib.auth import get_user_model

from apps.common import tenancy

MAIN_ADMIN_ROLES = {'SUPER_ADMIN'}
# Response keys that carry a cost; strip_cost() drops them for users who may not see cost.
COST_KEYS = ('cost_price', 'purchase_price', 'avg_purchase_cost', 'purchase_value', 'unit_cost')


def _role(user):
    if not user or not getattr(user, 'is_authenticated', False):
        return ''
    if getattr(user, 'is_superuser', False):
        return 'SUPER_ADMIN'
    return (getattr(user, 'role', '') or '').upper()


def is_main_admin(user):
    return _role(user) in MAIN_ADMIN_ROLES


def _settings():
    from .pricing_rules import get_settings
    return get_settings()


def can_view_cost(user, settings=None):
    if not user or not getattr(user, 'is_authenticated', False):
        return False
    s = settings if settings is not None else _settings()
    if not s.get('show_cost_price', True):
        return False
    if is_main_admin(user):
        return True
    return str(user.pk) in {str(v) for v in (s.get('cost_viewers') or [])}


def request_user(request):
    """The caller, also on the AllowAny views that skip DRF authentication
    (authentication_classes = []): read from the request's signed Bearer token."""
    if request is None:
        return None
    user = getattr(request, 'user', None)
    if user is not None and getattr(user, 'is_authenticated', False):
        return user
    cached = getattr(request, '_cost_viewer', False)
    if cached is not False:
        return cached
    found = None
    from apps.common.tenant_context import access_token
    token = access_token(request)
    if token is not None:
        from rest_framework_simplejwt.settings import api_settings
        user_id = token.get(api_settings.USER_ID_CLAIM)
        if user_id:
            found = get_user_model().objects.filter(pk=user_id, is_active=True).first()
    try:
        request._cost_viewer = found
    except AttributeError:
        pass
    return found


def request_can_view_cost(request, settings=None):
    """can_view_cost for whoever sent this request (cached on the request)."""
    if request is None:
        return False
    cached = getattr(request, '_can_view_cost', None)
    if cached is None:
        cached = can_view_cost(request_user(request), settings)
        try:
            request._can_view_cost = cached
        except AttributeError:
            pass
    return cached


def strip_cost(data, keys=COST_KEYS):
    """Remove cost keys from a dict (in place) and return it."""
    if isinstance(data, dict):
        for k in keys:
            data.pop(k, None)
    return data


def tenant_users():
    """Active sign-in users of the current tenant, for the Authorized Users picker."""
    User = get_user_model()
    qs = User.objects.filter(is_active=True)
    tid = tenancy.current_tenant_id()
    if tid is not None:
        qs = qs.filter(tenant_id=tid)
    rows = []
    for u in qs.order_by('username').only('id', 'username', 'first_name', 'last_name', 'role', 'is_superuser'):
        if u.is_superuser and tid is not None and u.tenant_id != tid:
            continue
        name = f'{u.first_name or ""} {u.last_name or ""}'.strip()
        rows.append({'id': str(u.pk), 'username': u.username, 'name': name or u.username,
                     'role': _role(u), 'main_admin': is_main_admin(u)})
    return rows


def clean_cost_viewers(value, errors):
    """Validate a cost_viewers list: ids of active users in this tenant (Main Admins dropped —
    they always see cost while the switch is on)."""
    if not isinstance(value, list):
        errors['cost_viewers'] = 'Pick users from the list.'
        return None
    allowed = {u['id']: u for u in tenant_users()}
    picked, unknown = [], []
    for raw in value:
        key = str(raw)
        if key not in allowed:
            unknown.append(key)
        elif not allowed[key]['main_admin'] and key not in picked:
            picked.append(key)
    if unknown:
        errors['cost_viewers'] = 'Some selected users are not active users of this store.'
        return None
    return picked


def strip_cost_deep(data, keys=('cost_price',)):
    """Remove cost keys from every dict inside a response body (lists / nested dicts)."""
    if isinstance(data, dict):
        for k in keys:
            data.pop(k, None)
        for k, v in data.items():
            if k not in ('errors', 'row_errors', 'detail'):   # validation messages name fields
                strip_cost_deep(v, keys)
    elif isinstance(data, list):
        for v in data:
            strip_cost_deep(v, keys)
    return data


class CostHidingMixin:
    """For views whose JSON carries product cost_price: drop it for users the Show Cost Price
    setting hides cost from."""

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        data = getattr(response, 'data', None)
        if data is not None and not request_can_view_cost(request):
            strip_cost_deep(data)
            if getattr(response, '_is_rendered', False):
                response._is_rendered = False
                response.render()
        return response

