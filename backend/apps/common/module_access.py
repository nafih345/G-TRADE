"""Which application modules a client business (tenant) has, and what each of its roles may do there.

The platform console (apps/common/superadmin_views.py) sets, per tenant:

  * `package` + `modules` — the modules the client is subscribed to. A named package fixes the
    set; CUSTOM takes the toggles exactly as given. Modules are independent: no module switches
    another on or off. The one rule is the accounting tier (ACCOUNTING_TIERS): a client gets
    Accounts (basic) or Financial (enterprise), never both — only the platform account has both.
  * `role_permissions` — per role, per module: 'full' (use and change), 'view' (read only) or
    'none'. Missing entries fall back to DEFAULT_ROLE_LEVELS.

  * `settings_features` — with Settings on, which of its sections (SETTINGS_FEATURES) the client
    gets; the others are hidden and their endpoints refuse writes from Settings.
  * `module_features` — opt-in switches inside a module (MODULE_FEATURES), e.g. Wholesale
    Distribution → Wholesale Order Status. {key: bool}; a missing key is OFF. The feature's
    endpoints (FEATURE_PREFIXES) refuse reads and writes while it is off.

effective_access(user) folds both into {module: level}; the profile API sends it to the browser
(sidebar + route guard) and check_api_access() enforces it on every API write: a POST / PUT /
PATCH / DELETE under a module's endpoints needs 'full' on one of the modules that write there
(WRITE_RULES — several modules share some endpoints, e.g. Purchase Entry creates products).
Reads are checked against the tenant's subscription only (READ_RULES): a module the client does
not have refuses reads of the endpoints it owns (appointments and eye tests, wholesale, purchase,
each accounting tier's screens), unless another module the client has reads there too (New Sale
reads eye tests, vouchers read purchase bills). A role whose level is 'none' on every module that
reads an endpoint is refused too ('view' reads), so a cashier cannot pull the ledger or purchase
costs through the API; the UI hides modules the user cannot open.

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
    ('accounts', 'Accounts (Basic)', 'Simple bookkeeping for smaller shops: vouchers, receipts, payments, '
     'dues, P&L, transaction report and statements.', 'accounts'),
    ('financial', 'Financial (Enterprise)', 'Full accounting: chart of accounts, ledgers, day/cash/bank books, '
     'cheques, trial balance, balance sheet and accounting integration.', 'accounts'),
    ('admin', 'Administration', 'Users, doctors, service master, branches, import, barcodes.', 'core'),
    ('reports', 'Reports', 'Sales, purchase, finance and clinical report hubs.', 'core'),
    ('settings', 'Settings', 'Store profile, billing, tax, numbering and bank master.', 'core'),
)
MODULE_KEYS = tuple(m[0] for m in MODULES)

# The Settings module's sections (the tabs of the Settings page). With Settings on, the platform
# admin picks which of them the client gets (Tenant.settings_features; None = every section, the
# shape of tenants created before the choice existed). Keys are the page's ?tab= ids.
# (key, label, description, write prefixes the section owns)
SETTINGS_FEATURES = (
    ('store', 'Store & Clinic Profile', 'Store identity, contact details, logo and clinic information.',
     ('/api/company/store-profile/', '/api/company/profile/')),
    ('localization', 'Business & Localization', 'Currency, tax, numbering sequences and custom fields.',
     ('/api/company/localization/', '/api/company/tax-config/', '/api/company/custom-fields/')),
    ('security', 'System Security & Backup', 'Session policy, backups, schedule and recovery.',
     ('/api/security/settings/', '/api/backups/')),
    ('business', 'Business Settings', 'Multi-branch management.', ('/api/company/business-settings/',)),
    ('bill-designer', 'Bill & Invoice Designer', 'Bill / invoice print templates and branding.', ('/api/billing/',)),
    ('barcode-labels', 'Barcode Labels', 'Scanner preferences and barcode label design.',
     ('/api/products/label-templates/', '/api/products/label-settings/')),
    ('banks', 'Bank Master', 'Bank accounts used by bank / UPI payments.', ('/api/financial/banks/',)),
    ('pricing', 'Pricing Rules & Offers', 'Below-cost lock, minimum margin and clearance offers.',
     ('/api/company/pricing-rules/',)),
)
SETTINGS_FEATURE_KEYS = tuple(f[0] for f in SETTINGS_FEATURES)
# Longest prefix first: path → the section that owns it.
_FEATURE_PREFIXES = sorted(((prefix, f[0]) for f in SETTINGS_FEATURES for prefix in f[3]), key=lambda r: -len(r[0]))
# Opt-in features inside a module, switched per client in Client Management (cloud: the platform
# admin; Windows edition: the Local Super Admin for client companies), and for the platform
# account / the Windows installation's own company in Settings → Business Settings. Stored in
# Tenant.module_features as {key: bool}; a missing key takes the feature's default — OFF for
# opt-in workflows (so every existing client keeps the behaviour it had), ON for features that
# shipped switched on (fresh installs, upgrades and new clients get them with no seeding). A
# feature also needs one of its parent modules.
# (key, parent module(s), label, description, endpoint prefixes it owns, default)
MODULE_FEATURES = (
    ('wholesale_order_status', 'wholesale', 'Wholesale Order Status',
     'Dealer-wise order tracking: billing an order deducts stock at once but posts it to Accounts '
     'only when it is marked Delivered; an undelivered bill is voided and its stock restored.',
     ('/api/sales/wholesale/order-status/',), False),
    ('bill_settlement', ('accounts', 'financial'), 'Bill-to-Bill Settlement',
     'Receipt / Payment Voucher "Bill to Bill" mode (F1 party lookup, FIFO or manual allocation, '
     'on-account advances) and the Bill-to-Bill Settlement Statement.',
     ('/api/financial/settlements/receipt/', '/api/financial/settlements/payment/',
      '/api/financial/settlements/batch/', '/api/financial/settlements/statement/',
      '/api/financial/settlements/voucher/', '/api/financial/settlements/party-ledger/'), True),
)
MODULE_FEATURE_KEYS = tuple(f[0] for f in MODULE_FEATURES)


def feature_parents(feature):
    """The parent module keys of a MODULE_FEATURES row (one key or a tuple of them)."""
    parent = feature[1]
    return tuple(parent) if isinstance(parent, (tuple, list)) else (parent,)


def feature_default(feature):
    return bool(feature[5]) if len(feature) > 5 else False


def module_feature_catalog():
    """MODULE_FEATURES as dicts for the consoles / settings: 'module' is the first parent
    (kept for older screens), 'modules' every parent, 'default' its state when never switched."""
    return [{'key': f[0], 'module': feature_parents(f)[0], 'modules': list(feature_parents(f)), 'label': f[2],
             'description': f[3], 'default': feature_default(f)} for f in MODULE_FEATURES]
_MODULE_FEATURE_PREFIXES = sorted(((prefix, f[0]) for f in MODULE_FEATURES for prefix in f[4]),
                                  key=lambda r: -len(r[0]))
MODULE_LABELS = {m[0]: m[1] for m in MODULES}
OPERATIONAL = tuple(m[0] for m in MODULES if m[3] == 'operations')
CORE = tuple(m[0] for m in MODULES if m[3] == 'core')
# The two accounting tiers. A client has at most one of them; the platform account has both.
ACCOUNTING_TIERS = ('accounts', 'financial')
BOOKS = ACCOUNTING_TIERS  # endpoints of the shared ledger engine that both tiers use

FULL_SUITE, RETAIL, OPERATIONS, ACCOUNTS_ONLY, FINANCIAL_ONLY, CUSTOM = (
    'FULL_SUITE', 'RETAIL', 'OPERATIONS', 'ACCOUNTS_ONLY', 'FINANCIAL_ONLY', 'CUSTOM')
PACKAGES = (
    (FULL_SUITE, 'Full Suite (Enterprise)', 'Every operations module with Financial (enterprise) accounting.',
     OPERATIONAL + ('financial',) + CORE),
    (RETAIL, 'Retail (Basic Accounts)', 'Every operations module with the simple Accounts module.',
     OPERATIONAL + ('accounts',) + CORE),
    (OPERATIONS, 'Operations', 'Optical, sales, wholesale, inventory and purchase without accounting.',
     OPERATIONAL + CORE),
    (ACCOUNTS_ONLY, 'Accounts Only', 'The simple Accounts module on its own — no operations modules.',
     ('accounts',) + CORE),
    (FINANCIAL_ONLY, 'Financial Only', 'Financial (enterprise) accounting on its own — no operations modules.',
     ('financial',) + CORE),
    (CUSTOM, 'Custom', 'Switch modules on and off one by one; each is independent.', None),
)
PACKAGE_MODULES = {p[0]: p[3] for p in PACKAGES}

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
    # Role defaults name 'financial'; the Accounts tier gets the same level (a client has one).
    full, view = set(full), set(view)
    for tiers in (full, view):
        if 'financial' in tiers:
            tiers.add('accounts')
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

# The ledger engine under /api/financial/ serves both accounting tiers. Its shared core (chart of
# accounts, vouchers, journals, cheques, settlements, statements, general ledger) is BOOKS; the
# endpoints below belong to one tier's screens only and refuse the other tier, reads included.
FINANCIAL_ONLY_PREFIXES = tuple(f'/api/financial/{p}' for p in (
    'groups/', 'ledger/', 'integration/', 'bankbook/',
    'reports/trial-balance/', 'reports/profit-loss/', 'reports/balance-sheet/', 'reports/ledger-register/',
    'reports/daybook/', 'reports/cashbook/', 'reports/bankbook/', 'reports/account-balances/',
    'reports/source-breakdown/',
))
ACCOUNTS_ONLY_PREFIXES = tuple(f'/api/financial/{p}' for p in (
    'reports/vouchers/', 'reports/expenses/', 'reports/customer-outstanding/', 'reports/supplier-outstanding/',
    'reports/accounts-activity/', 'reports/transactions/', 'transactions/', 'reports/profit-loss-statement/',
))

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
    ('/api/financial/banks/', BOOKS + ('settings',)),
    ('/api/financial/bank-accounts/', BOOKS + ('settings', 'sales', 'purchase', 'wholesale')),
    *((prefix, ('financial',)) for prefix in FINANCIAL_ONLY_PREFIXES),
    *((prefix, ('accounts',)) for prefix in ACCOUNTS_ONLY_PREFIXES),
    ('/api/financial/', BOOKS),
    ('/api/accounts/', BOOKS),
    ('/api/company/branches/', ('admin', 'settings')),
    ('/api/company/user-branch-access/', ('admin',)),
    ('/api/company/warehouses/', ('inventory', 'settings')),
    ('/api/company/branch-stock/', ('inventory', 'sales', 'purchase', 'wholesale')),
    ('/api/company/stock-transfers/', ('inventory',)),
    ('/api/company/document-sequences/', ANY),
    # Pricing Rules & Offers: the views allow only Administrators / Managers to change them (a
    # Manager's Settings access is view-only), and any till may ask a manager to approve a price.
    ('/api/company/pricing-rules/approve/', ANY),
    ('/api/company/pricing-rules/', ('settings', 'sales', 'inventory')),
    ('/api/company/', ('settings',)),
    ('/api/billing/', ('settings',)),
    # Store-wide security policy and backups (per-user 2FA / re-auth / heartbeat stay ungated).
    ('/api/security/settings/', ('settings',)),
    ('/api/backups/', ('settings',)),
), key=lambda r: -len(r[0]))

# Reads the tenant's subscription AND the user's role must cover (a role at 'none' on every
# reader module is refused; 'view' reads): a module
# switched off in Client Management can't be read through a typed URL or a direct API call
# either. Each entry lists every module whose screens legitimately read there — a client with
# none of them gets 403 `module_disabled`. The books (Accounts / Financial) read other modules'
# bills and parties for vouchers, settlement and "show bill". Shared masters (products,
# categories, brands, stock, customers, sales invoices) are not listed: every package's core
# modules (Reports, Settings → barcode labels / bill designer, Administration → import) read them.
# Bank accounts / Bank Master stay readable by every screen that takes bank payments (None = open).
READ_RULES = sorted((
    # Shared sales records: every module whose screens show them (New Sale / Orders, patient
    # history, reports, bill-designer previews, vouchers / outstanding / show-bill).
    ('/api/sales/customers/', ('sales', 'optical', 'wholesale', 'reports') + BOOKS),
    ('/api/sales/invoices/', ('sales', 'optical', 'reports', 'settings') + BOOKS),
    ('/api/sales/payments/', ('sales', 'optical', 'reports', 'settings') + BOOKS),
    ('/api/sales/returns/', ('sales', 'reports', 'settings') + BOOKS),
    ('/api/sales/services/', ('sales', 'wholesale', 'admin')),
    ('/api/sales/appointments/', ('optical',)),
    ('/api/sales/eye-examinations/', ('optical', 'sales', 'reports')),
    ('/api/sales/wholesale/', ('wholesale',) + BOOKS),
    ('/api/purchase/suppliers/', ('purchase', 'inventory', 'sales') + BOOKS),
    ('/api/purchase/lens-orders/', ('purchase', 'sales')),
    ('/api/purchase/', ('purchase',) + BOOKS),
    ('/api/financial/banks/', None),
    ('/api/financial/bank-accounts/', None),
    *((prefix, ('financial',)) for prefix in FINANCIAL_ONLY_PREFIXES),
    *((prefix, ('accounts',)) for prefix in ACCOUNTS_ONLY_PREFIXES),
    ('/api/financial/', BOOKS),
    ('/api/accounts/', BOOKS),
), key=lambda r: -len(r[0]))

_SAFE = ('GET', 'HEAD', 'OPTIONS')
# POST endpoints that only read (a request body too large for a query string), so any screen —
# barcode printing from Sales, Purchase or Inventory — may call them like a GET.
READ_ONLY_POSTS = ('/api/products/label-data/', '/api/company/pricing-rules/floors/')


# ---- package / module normalisation ---------------------------------------------------------

def in_catalog_order(modules):
    """The selection exactly as given (modules are independent), in catalog order."""
    chosen = set(modules)
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
    result = in_catalog_order(modules or [])
    if not any(m not in CORE for m in result):
        raise ValueError('Switch on at least one business module (operations, Accounts or Financial).')
    if all(t in result for t in ACCOUNTING_TIERS):
        raise ValueError('A client gets either Accounts (basic) or Financial (enterprise), not both. '
                         'Switch one of them off.')
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


def normalize_settings_features(raw):
    """Stored settings_features: None (every section) or a list of known keys in catalog order."""
    if raw is None:
        return None
    if not isinstance(raw, (list, tuple)):
        raise ValueError('Settings sections must be a list.')
    unknown = [f for f in raw if f not in SETTINGS_FEATURE_KEYS]
    if unknown:
        raise ValueError(f'Unknown Settings section(s): {", ".join(map(str, unknown))}.')
    chosen = [f for f in SETTINGS_FEATURE_KEYS if f in raw]
    if not chosen:
        raise ValueError('Switch on at least one Settings section, or turn the Settings module off.')
    return chosen


def enabled_settings_features(config):
    """Sections the tenant has (empty when the Settings module itself is off)."""
    if 'settings' not in config['modules']:
        return []
    chosen = config.get('settings_features')
    return list(SETTINGS_FEATURE_KEYS) if chosen is None else [f for f in SETTINGS_FEATURE_KEYS if f in chosen]


def settings_features_for(user, config=None):
    """Settings sections a signed-in user may open: the tenant's sections, if the role can open
    Settings at all."""
    from apps.common.permissions import is_platform_admin
    if is_platform_admin(user):
        return list(SETTINGS_FEATURE_KEYS)
    if config is None:
        from apps.common.permissions import request_tenant_id
        tenant_id = request_tenant_id(user)
        if not tenant_id:
            return []
        config = tenant_access_config(tenant_id)
    if effective_access(user, config).get('settings', NONE) == NONE:
        return []
    return enabled_settings_features(config)


def normalize_module_features(raw):
    """Stored module_features: {key: bool} for known keys only (unknown keys refused)."""
    if raw is None:
        return {}
    if not isinstance(raw, dict):
        raise ValueError('Module features must be an object of {feature: true/false}.')
    unknown = [k for k in raw if k not in MODULE_FEATURE_KEYS]
    if unknown:
        raise ValueError(f'Unknown module feature(s): {", ".join(map(str, unknown))}.')
    return {k: bool(raw[k]) for k in MODULE_FEATURE_KEYS if k in raw}


def enabled_module_features(config):
    """Feature keys the tenant has on (each also needs its parent module)."""
    chosen = config.get('module_features')
    modules = config.get('modules') or []
    out = []
    for f in MODULE_FEATURES:
        key = f[0]
        if not any(p in modules for p in feature_parents(f)):
            continue
        if chosen is None or (isinstance(chosen, dict) and chosen.get(key, feature_default(f))):
            out.append(key)
    return out


def module_features_for(user, config=None):
    """Module features a signed-in user may use: the tenant's features whose parent module the
    user's role can open."""
    if config is None:
        from apps.common.permissions import request_tenant_id
        tenant_id = request_tenant_id(user)
        if not tenant_id:
            return []
        config = tenant_access_config(tenant_id)
    access = effective_access(user, config)
    parents = {f[0]: feature_parents(f) for f in MODULE_FEATURES}
    return [k for k in enabled_module_features(config)
            if any(access.get(p, NONE) != NONE for p in parents[k])]


def tenant_has_feature(key, tenant_id=None):
    """Is a module feature on for this (default: the current) tenant? Used by business logic
    that changes behaviour with the feature (not only by the API gate)."""
    from apps.common import tenancy
    tenant_id = tenant_id or tenancy.current_tenant_id()
    if not tenant_id:
        return False
    return key in enabled_module_features(tenant_access_config(tenant_id))


def _module_feature_for(path):
    for prefix, feature in _MODULE_FEATURE_PREFIXES:
        if path.startswith(prefix):
            return feature
    return None


def _check_module_feature(request):
    """A module feature switched off refuses its endpoints, reads and writes alike (403)."""
    feature = _module_feature_for(request.path)
    if not feature:
        return
    from apps.common import tenancy
    tenant_id = tenancy.current_tenant_id()
    if tenant_id is None:
        return
    if feature in enabled_module_features(tenant_access_config(tenant_id)):
        return
    label = next(f[2] for f in MODULE_FEATURES if f[0] == feature)
    raise exceptions.PermissionDenied({
        'detail': f'{label} is not enabled for this business. Ask the administrator to switch it on '
                  'in Client Management → Modules.',
        'code': 'feature_disabled'})


def _feature_for(path):
    for prefix, feature in _FEATURE_PREFIXES:
        if path.startswith(prefix):
            return feature
    return None


def role_levels(role, overrides=None):
    """Configured levels for one role (before the tenant's subscription is applied)."""
    base = dict(DEFAULT_ROLE_LEVELS.get(role) or _levels())
    if role not in OWNER_ROLES:
        base.update((overrides or {}).get(role) or {})
    return base


def all_role_levels(overrides=None):
    return {role: role_levels(role, overrides) for role in DEFAULT_ROLE_LEVELS}


# ---- effective access -----------------------------------------------------------------------

def subscribed_modules(tenant):
    """A tenant row's modules. The platform account has every module — both accounting tiers —
    whatever is stored, so the Super Admin can cross-check Accounts and Financial side by side."""
    from apps.common import tenancy
    from apps.common.edition import licensed_modules
    if tenant.pk == tenancy.DEFAULT_TENANT_ID:
        return licensed_modules(list(MODULE_KEYS))
    return licensed_modules(list(tenant.modules or []))


def tenant_access_config(tenant_id):
    """{'modules': [...], 'role_permissions': {...}} for a tenant, cached per request burst."""
    from apps.common import hot_cache, tenancy
    from apps.common.models import Tenant

    def load():
        row = Tenant.objects.filter(pk=tenant_id).values(
            'modules', 'role_permissions', 'settings_features', 'module_features').first()
        if row is None:
            return {'modules': [], 'role_permissions': {}, 'settings_features': [], 'module_features': {}}
        platform = tenant_id == tenancy.DEFAULT_TENANT_ID
        from apps.common.edition import is_local, licensed_modules, licensed_settings_features
        modules = list(MODULE_KEYS) if platform else list(row['modules'] or [])
        features = None if platform else row['settings_features']
        if is_local():
            # Windows edition: tenant #1 is the customer's own company, not a platform account, and
            # the licence's module list and Settings sections win (licence AND company).
            modules = licensed_modules(modules)
            features = licensed_settings_features(features)
        # Module features are opt-in everywhere — the platform account too, since switching one
        # on changes how that business's documents post. The stored switches decide.
        module_features = dict(row['module_features'] or {})
        return {'modules': modules,
                'role_permissions': dict(row['role_permissions'] or {}),
                'settings_features': features,
                'module_features': module_features}

    return hot_cache.get_or_load(f'tenant:access:{tenant_id}', load)


def effective_access(user, config=None):
    """{module: 'full'|'view'|'none'} for a signed-in user."""
    from apps.common.permissions import is_platform_admin
    if is_platform_admin(user):
        # Windows edition: even the Local Super Admin only gets the modules the licence covers.
        from apps.common.edition import licensed_modules
        allowed = set(licensed_modules(list(MODULE_KEYS)))
        return {m: (FULL if m in allowed else NONE) for m in MODULE_KEYS}
    if config is None:
        from apps.common.permissions import request_tenant_id
        tenant_id = request_tenant_id(user)
        if not tenant_id:
            return {m: NONE for m in MODULE_KEYS}
        config = tenant_access_config(tenant_id)
    enabled = set(config['modules'])
    role = 'SUPER_ADMIN' if user.is_superuser else (user.role or '')
    levels = role_levels(role, config['role_permissions'])
    return {m: (levels.get(m, NONE) if m in enabled else NONE) for m in MODULE_KEYS}


def _rule_for(path):
    for prefix, writers in WRITE_RULES:
        if path.startswith(prefix):
            return prefix, writers
    return None, None


def _read_rule_for(path):
    for prefix, readers in READ_RULES:
        if path.startswith(prefix):
            return readers
    return None


def _check_read(request):
    """Refuse a read of a module-owned endpoint (READ_RULES) when the tenant has none of the
    modules that read there (403 module_disabled), or when the signed-in user's role has level
    'none' on every one of them (403 module_forbidden). 'view' is enough to read."""
    readers = _read_rule_for(request.path)
    if not readers:
        return
    from apps.common import tenancy
    from apps.common.permissions import is_platform_admin
    tenant_id = tenancy.current_tenant_id()
    user = getattr(request, 'user', None)
    if tenant_id is None or is_platform_admin(user):
        return
    config = tenant_access_config(tenant_id)
    names = ' / '.join(MODULE_LABELS[m] for m in readers)
    if not any(m in config['modules'] for m in readers):
        raise exceptions.PermissionDenied({
            'detail': f'{names} is not part of this business’s plan. Ask the platform administrator to enable it.',
            'code': 'module_disabled'})
    if user is None or not user.is_authenticated:
        return  # no identity: the subscription alone (token-less requests see no rows anyway)
    access = effective_access(user, config)
    if any(access.get(m, NONE) != NONE for m in readers):
        return
    raise exceptions.PermissionDenied({
        'detail': f'Your role has no access to {names}.', 'code': 'module_forbidden'})


def check_api_access(request):
    """Refuse an API request the tenant's modules / the user's role don't allow (403): every
    module-gated write, plus reads of the accounting tiers' endpoints (READ_RULES)."""
    _check_module_feature(request)
    if request.method in _SAFE or request.path in READ_ONLY_POSTS:
        _check_read(request)
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
    # A Settings section switched off for the tenant no longer lets Settings write there (another
    # module sharing the endpoint — Financial on Bank Master — still may).
    feature = _feature_for(request.path)
    if feature and 'settings' in candidates and feature not in enabled_settings_features(config):
        candidates = tuple(m for m in candidates if m != 'settings')
        if not candidates:
            label = next(f[1] for f in SETTINGS_FEATURES if f[0] == feature)
            raise exceptions.PermissionDenied({
                'detail': f'Settings → {label} is not part of this business’s plan. '
                          'Ask the platform administrator to enable it.',
                'code': 'module_disabled'})
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
        'settings_features': [{'key': k, 'label': l, 'description': d} for k, l, d, _p in SETTINGS_FEATURES],
        'module_features': module_feature_catalog(),
        # Modules are independent; the one rule is a single accounting tier per client.
        'exclusive': [list(ACCOUNTING_TIERS)],
        'levels': list(LEVELS),
        'roles': [{'key': k, 'label': l, 'owner': k in OWNER_ROLES} for k, l in CLIENT_ROLES],
        'default_role_levels': DEFAULT_ROLE_LEVELS,
        # Roles that may sign in at all on this install (settings.LOGIN_ENABLED_ROLES).
        'login_enabled_roles': list(settings.LOGIN_ENABLED_ROLES),
    }
