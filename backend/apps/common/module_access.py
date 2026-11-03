"""Which application modules a client business (tenant) has, and what each of its roles may do there.

The platform console (apps/common/superadmin_views.py) sets, per tenant:

  * `package` + `modules` — the modules the client is subscribed to. A named package fixes the
    set; CUSTOM takes the toggles as given, adds whatever they depend on (REQUIRES) and fails
    nothing: dependencies are switched on, never refused.
  * `role_permissions` — per role, per module: 'full' (use and change), 'view' (read only) or
    'none'. Missing entries fall back to DEFAULT_ROLE_LEVELS.

effective_access(user) folds both into {module: level}; the profile API sends it to the browser
(sidebar + route guard) and check_api_access() enforces it on every API write: a POST / PUT /
PATCH / DELETE under a module's endpoints needs 'full' on one of the modules that write there
(WRITE_RULES — several modules share some endpoints, e.g. Purchase Entry creates products).
Reads stay open so one screen can still show another module's data it depends on (New Sale
reads products, vouchers read bills); the UI hides modules the user cannot open.

The catalog (modules, packages, roles, defaults) is served to the console from here, so the
browser never keeps its own copy of these rules.
"""
from rest_framework import exceptions

FULL, VIEW, NONE = 'full', 'view', 'none'
LEVELS = (FULL, VIEW, NONE)

# (key, label, description, group). Catalog order is display order.
MODULES = (
    ('optical', 'Optical Services', 'Eye tests, appointments and patient history.', 'operations'),
    ('sales', 'Sales', 'New Sale, POS billing, orders, customers and payments.', 'operations'),
    ('wholesale', 'Wholesale Distribution', 'Wholesale POS, dealers, collections and reports.', 'operations'),
    ('inventory', 'Inventory', 'Products, categories, brands, lens matrix and stock.', 'operations'),
    ('purchase', 'Purchase', 'Purchase entry, suppliers, purchase and lens orders, returns.', 'operations'),
    ('financial', 'Financial Accounts', 'Vouchers, ledgers, day/cash/bank books, P&L and balance sheet.', 'accounts'),
    ('admin', 'Administration', 'Users, doctors, service master, branches, import, barcodes.', 'core'),
    ('reports', 'Reports', 'Sales, purchase, finance and clinical report hubs.', 'core'),
    ('settings', 'Settings', 'Store profile, billing, tax, numbering and bank master.', 'core'),
)
MODULE_KEYS = tuple(m[0] for m in MODULES)
MODULE_LABELS = {m[0]: m[1] for m in MODULES}
OPERATIONAL = tuple(m[0] for m in MODULES if m[3] == 'operations')
CORE = tuple(m[0] for m in MODULES if m[3] == 'core')

FULL_SUITE, OPERATIONS, ACCOUNTS_ONLY, CUSTOM = 'FULL_SUITE', 'OPERATIONS', 'ACCOUNTS_ONLY', 'CUSTOM'
PACKAGES = (
    (FULL_SUITE, 'Full Suite', 'Every module, with accounting integrated across operations.', MODULE_KEYS),
    (OPERATIONS, 'Operations', 'Optical, sales, wholesale, inventory and purchase without accounts.',
     OPERATIONAL + CORE),
    (ACCOUNTS_ONLY, 'Accounts Only', 'Standalone financial accounting — no operational modules.',
     ('financial',) + CORE),
    (CUSTOM, 'Custom', 'Pick modules one by one; what they depend on switches on automatically.', None),
)
PACKAGE_MODULES = {p[0]: p[3] for p in PACKAGES}

# A CUSTOM selection that includes the key also gets these.
REQUIRES = {
    'sales': ('inventory',),
    'wholesale': ('inventory',),
    'purchase': ('inventory',),
}
# Financial Accounts runs either standalone (no operational module at all — the ACCOUNTS_ONLY
# shape) or integrated: it posts journals from every operational module, so together with any
# one of them it brings the full operational suite.
INTEGRATED = {'financial': OPERATIONAL}

# Client-side roles, in the order the console offers them; the first five are the ones a new
# optical client usually needs.
CLIENT_ROLES = (
    ('SUPER_ADMIN', 'Client Owner (Super Admin)'),
    ('BRANCH_ADMIN', 'System User / Branch Admin'),
    ('OPTOMETRIST', 'Optometrist'),
    ('SALES_EXECUTIVE', 'Sales Staff'),
    ('DOCTOR', 'Doctor / Specialist'),
    ('ADMINISTRATOR', 'Administrator'),
    ('MANAGER', 'Manager'),
    ('ACCOUNTANT', 'Accountant'),
    ('INVENTORY_MANAGER', 'Inventory Manager'),
    ('PURCHASE_EXECUTIVE', 'Purchase Executive'),
    ('CASHIER', 'Cashier'),
)
CLIENT_ROLE_KEYS = tuple(r[0] for r in CLIENT_ROLES)
# The client's own top role: always full on every module the client has; not editable.
OWNER_ROLES = ('SUPER_ADMIN',)


def _levels(full=(), view=()):
    return {m: FULL if m in full else VIEW if m in view else NONE for m in MODULE_KEYS}


DEFAULT_ROLE_LEVELS = {
    'SUPER_ADMIN': _levels(full=MODULE_KEYS),
    'ADMINISTRATOR': _levels(full=MODULE_KEYS),
    'BRANCH_ADMIN': _levels(full=OPERATIONAL + ('admin', 'reports'), view=('financial', 'settings')),
    'MANAGER': _levels(full=OPERATIONAL + ('reports',), view=('financial', 'admin', 'settings')),
    'OPTOMETRIST': _levels(full=('optical',), view=('sales', 'inventory', 'reports')),
    'DOCTOR': _levels(full=('optical',), view=('reports',)),
    'SALES_EXECUTIVE': _levels(full=('sales',), view=('optical', 'inventory', 'reports')),
    'CASHIER': _levels(full=('sales',), view=('reports',)),
    'ACCOUNTANT': _levels(full=('financial', 'reports'), view=('sales', 'purchase', 'wholesale')),
    'INVENTORY_MANAGER': _levels(full=('inventory', 'purchase'), view=('reports',)),
    'PURCHASE_EXECUTIVE': _levels(full=('purchase',), view=('inventory', 'reports')),
}

ANY = '*'  # every module may write here (shared plumbing such as numbering claims)

# Longest prefix wins. Paths not listed (auth, security, backups, superadmin, health,
# notifications, branch context) are not module-gated; they have their own permissions.
WRITE_RULES = sorted((
    ('/api/sales/eye-examinations/', ('optical', 'sales', 'reports')),
    ('/api/sales/appointments/', ('optical',)),
    ('/api/sales/customers/', ('sales', 'optical', 'wholesale')),
    ('/api/sales/services/', ('sales', 'admin')),
    ('/api/sales/wholesale/', ('wholesale',)),
    ('/api/sales/whatsapp/', ('sales', 'optical', 'wholesale')),
    ('/api/sales/', ('sales',)),
    ('/api/products/barcode-config/', ('admin', 'settings')),
    ('/api/products/', ('inventory', 'purchase', 'admin', 'settings')),
    ('/api/import/', ('admin', 'inventory', 'settings')),
    ('/api/masters/', ('inventory', 'purchase', 'settings')),
    ('/api/inventory/', ('inventory', 'purchase', 'wholesale', 'settings')),
    ('/api/purchase/', ('purchase',)),
    ('/api/financial/banks/', ('financial', 'settings')),
    ('/api/financial/bank-accounts/', ('financial', 'settings', 'sales', 'purchase', 'wholesale')),
    ('/api/financial/', ('financial',)),
    ('/api/accounts/', ('financial',)),
    ('/api/company/branches/', ('admin', 'settings')),
    ('/api/company/user-branch-access/', ('admin',)),
    ('/api/company/warehouses/', ('inventory', 'settings')),
    ('/api/company/branch-stock/', ('inventory', 'sales', 'purchase', 'wholesale')),
    ('/api/company/stock-transfers/', ('inventory',)),
    ('/api/company/document-sequences/', ANY),
    ('/api/company/', ('settings',)),
    ('/api/billing/', ('settings',)),
), key=lambda r: -len(r[0]))

_SAFE = ('GET', 'HEAD', 'OPTIONS')
# POST endpoints that only read (a request body too large for a query string), so any screen —
# barcode printing from Sales, Purchase or Inventory — may call them like a GET.
READ_ONLY_POSTS = ('/api/products/label-data/',)


# ---- package / module normalisation ---------------------------------------------------------

def with_requirements(modules):
    """The selection plus everything it depends on, in catalog order."""
    chosen = set(modules)
    stack = list(chosen)
    while stack:
        for dep in REQUIRES.get(stack.pop(), ()):
            if dep not in chosen:
                chosen.add(dep)
                stack.append(dep)
    for module, suite in INTEGRATED.items():
        if module in chosen and chosen & set(suite):
            chosen |= set(suite)
    return [m for m in MODULE_KEYS if m in chosen]


def normalize_modules(package, modules):
    """(package, modules) as stored. Raises ValueError with a user-facing message."""
    package = (package or CUSTOM).upper()
    if package not in PACKAGE_MODULES:
        raise ValueError(f'Unknown package "{package}".')
    if package != CUSTOM:
        return package, list(PACKAGE_MODULES[package])
    unknown = [m for m in (modules or []) if m not in MODULE_KEYS]
    if unknown:
        raise ValueError(f'Unknown module(s): {", ".join(map(str, unknown))}.')
    result = with_requirements(modules or [])
    if not any(m not in CORE for m in result):
        raise ValueError('Switch on at least one business module (operations or Financial Accounts).')
    # A custom pick that happens to be exactly a named package is that package.
    for key, _label, _desc, mods in PACKAGES:
        if mods is not None and set(mods) == set(result):
            return key, result
    return CUSTOM, result


def normalize_role_permissions(raw):
    """{role: {module: level}} keeping only real roles / modules / levels and only the entries
    that differ from the defaults (so later default changes still reach untouched roles)."""
    if raw in (None, ''):
        return {}
    if not isinstance(raw, dict):
        raise ValueError('Role permissions must be an object of role → module → level.')
    out = {}
    for role, levels in raw.items():
        if role not in DEFAULT_ROLE_LEVELS:
            raise ValueError(f'Unknown role "{role}".')
        if role in OWNER_ROLES:
            continue  # always full
        if not isinstance(levels, dict):
            raise ValueError(f'Permissions for {role} must be an object of module → level.')
        diff = {}
        for module, level in levels.items():
            if module not in MODULE_KEYS:
                raise ValueError(f'Unknown module "{module}".')
            if level not in LEVELS:
                raise ValueError(f'Level for {module} must be one of {", ".join(LEVELS)}.')
            if DEFAULT_ROLE_LEVELS[role][module] != level:
                diff[module] = level
        if diff:
            out[role] = diff
    return out


def role_levels(role, overrides=None):
    """Configured levels for one role (before the tenant's subscription is applied)."""
    base = dict(DEFAULT_ROLE_LEVELS.get(role) or _levels())
    if role not in OWNER_ROLES:
        base.update((overrides or {}).get(role) or {})
    return base


def all_role_levels(overrides=None):
    return {role: role_levels(role, overrides) for role in DEFAULT_ROLE_LEVELS}


# ---- effective access -----------------------------------------------------------------------

def tenant_access_config(tenant_id):
    """{'modules': [...], 'role_permissions': {...}} for a tenant, cached per request burst."""
    from apps.common import hot_cache
    from apps.common.models import Tenant

    def load():
        row = Tenant.objects.filter(pk=tenant_id).values('modules', 'role_permissions').first()
        if row is None:
            return {'modules': [], 'role_permissions': {}}
        return {'modules': list(row['modules'] or []), 'role_permissions': dict(row['role_permissions'] or {})}

    return hot_cache.get_or_load(f'tenant:access:{tenant_id}', load)


def effective_access(user, config=None):
    """{module: 'full'|'view'|'none'} for a signed-in user."""
    from apps.common.permissions import is_platform_admin
    if is_platform_admin(user):
        return {m: FULL for m in MODULE_KEYS}
    if config is None:
        if not getattr(user, 'tenant_id', None):
            return {m: NONE for m in MODULE_KEYS}
        config = tenant_access_config(user.tenant_id)
    enabled = set(config['modules'])
    role = 'SUPER_ADMIN' if user.is_superuser else (user.role or '')
    levels = role_levels(role, config['role_permissions'])
    return {m: (levels.get(m, NONE) if m in enabled else NONE) for m in MODULE_KEYS}


def _rule_for(path):
    for prefix, writers in WRITE_RULES:
        if path.startswith(prefix):
            return prefix, writers
    return None, None


def check_api_access(request):
    """Refuse an API write the tenant's modules / the user's role don't allow (403)."""
    if request.method in _SAFE or request.path in READ_ONLY_POSTS:
        return
    prefix, writers = _rule_for(request.path)
    if writers is None:
        return
    from apps.common import tenancy
    tenant_id = tenancy.current_tenant_id()
    if tenant_id is None:
        return  # no scope: the ORM refuses every write anyway
    config = tenant_access_config(tenant_id)
    user = getattr(request, 'user', None)
    if user is not None and user.is_authenticated:
        access = effective_access(user, config)
    else:
        # Views without authentication (AllowAny branch endpoints): the subscription alone.
        access = {m: (FULL if m in config['modules'] else NONE) for m in MODULE_KEYS}
    candidates = MODULE_KEYS if writers == ANY else writers
    if any(access.get(m) == FULL for m in candidates):
        return
    names = ', '.join(MODULE_LABELS[m] for m in candidates)
    if not any(m in config['modules'] for m in candidates):
        raise exceptions.PermissionDenied({
            'detail': f'{names} is not part of this business’s plan. Ask the platform administrator to enable it.',
            'code': 'module_disabled'})
    raise exceptions.PermissionDenied({
        'detail': f'Your role can view but not change {names}.' if any(access.get(m) == VIEW for m in candidates)
        else f'Your role has no access to {names}.',
        'code': 'module_forbidden'})


def install_api_gate():
    """Run check_api_access after DRF has authenticated and permission-checked a request."""
    from rest_framework.views import APIView

    if getattr(APIView, '_module_gate_installed', False):
        return
    orig_initial = APIView.initial

    def initial(self, request, *args, **kwargs):
        orig_initial(self, request, *args, **kwargs)
        check_api_access(request)

    APIView.initial = initial
    APIView._module_gate_installed = True


def catalog():
    from django.conf import settings
    return {
        'modules': [{'key': k, 'label': l, 'description': d, 'group': g} for k, l, d, g in MODULES],
        'packages': [{'key': k, 'label': l, 'description': d, 'modules': list(m) if m else None}
                     for k, l, d, m in PACKAGES],
        'requires': {k: list(v) for k, v in REQUIRES.items()},
        'integrated': {k: list(v) for k, v in INTEGRATED.items()},
        'levels': list(LEVELS),
        'roles': [{'key': k, 'label': l, 'owner': k in OWNER_ROLES} for k, l in CLIENT_ROLES],
        'default_role_levels': DEFAULT_ROLE_LEVELS,
        # Roles that may sign in at all on this install (settings.LOGIN_ENABLED_ROLES).
        'login_enabled_roles': list(settings.LOGIN_ENABLED_ROLES),
    }
