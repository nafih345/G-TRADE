"""Onboard a client business: its Tenant, its first Super Admin, and the Company + default
branch its store profile and billing start from.

Shared by the platform console (POST /api/superadmin/tenants/) and `manage.py create_tenant`,
so both create exactly the same rows. The default masters a client's first save or search
depends on (ensure_tenant_defaults: Head Office branch, Main Warehouse, chart of accounts,
business settings, the owner's branch binding, starter categories / services / templates) are
created here, in the platform owner's request — not lazily inside the client's first requests,
where on the hosted database they cost tens of round trips each.

Clients created before a default existed get it at their next sign-in: Tenant.defaults_version
records which generation of defaults a client has (DEFAULTS_VERSION), and the login gate fills
in a client that is behind (apps.authentication.serializers.ensure_login_tenant).

Usernames are global (User is not tenant-owned), so the admin username must not exist in any
tenant. The new account can sign in straight away: login reads User.tenant and signs it into
the token as `tenant_id` (security.policy.issue_tokens) — nothing is cached per process that a
new tenant would have to wait for.
"""
import datetime
import logging

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils.text import slugify

from apps.common import module_access, tenancy
from apps.common.models import Tenant, TenantAuditLog

logger = logging.getLogger('django')

# Bump when ensure_tenant_defaults learns a new default, so existing clients receive it at their
# next sign-in.
DEFAULTS_VERSION = 1
HEAD_OFFICE = 'Head Office'


class OnboardingError(ValueError):
    """A business-rule refusal, tied to the input field it concerns."""

    def __init__(self, field, message):
        super().__init__(message)
        self.field = field
        self.message = message


def _free_code(name):
    base = (slugify(name) or 'client')[:34]
    code, n = base, 2
    while Tenant.objects.filter(code=code).exists():
        code = f'{base}-{n}'
        n += 1
    return code


def check_available(name, admin_username, code=None):
    User = get_user_model()
    if Tenant.objects.filter(name__iexact=name).exists():
        raise OnboardingError('tenant_name', f'A client named "{name}" already exists.')
    if code and Tenant.objects.filter(code=code).exists():
        raise OnboardingError('code', f'The code "{code}" is already in use.')
    if User.objects.filter(username__iexact=admin_username).exists():
        raise OnboardingError('admin_username', f'The username "{admin_username}" is already taken.')


def log_event(tenant, action, actor='', *, reason='', effective_date=None, **details):
    """One TenantAuditLog row. `actor` is a User or a username."""
    actor = getattr(actor, 'username', actor) or ''
    return TenantAuditLog.objects.create(tenant=tenant, action=action, actor=actor, reason=reason or '',
                                         effective_date=effective_date, details=details)


def active_user_count(tenant):
    return get_user_model().objects.filter(tenant=tenant, is_active=True).count()


def check_seat_available(tenant, adding=1):
    """Refuse a new / reactivated account once the client's seat limit is used up."""
    used = active_user_count(tenant)
    if used + adding > tenant.max_users:
        raise OnboardingError('max_users', f'All {tenant.max_users} user seats of {tenant.name} are in use '
                                           f'({used} active). Raise the seat limit or deactivate a user first.')


def onboard_tenant(*, name, admin_username, password, admin_email='', contact_phone='',
                   branch_name='', code=None, package=module_access.FULL_SUITE, modules=None,
                   settings_features=None, max_users=5, actor=''):
    """Create the tenant, its Super Admin and its default masters in one transaction; returns
    (tenant, admin)."""
    User = get_user_model()
    name = (name or '').strip()
    admin_username = (admin_username or '').strip()
    admin_email = (admin_email or '').strip()
    contact_phone = (contact_phone or '').strip()
    code = slugify(code) if code else None
    if not name:
        raise OnboardingError('tenant_name', 'Give the client a name.')
    if not admin_username:
        raise OnboardingError('admin_username', 'Give the admin a username.')
    if not password:
        raise OnboardingError('password', 'Give the admin a password.')
    try:
        package, modules = module_access.normalize_modules(package, modules)
    except ValueError as e:
        raise OnboardingError('modules', str(e))
    try:
        settings_features = module_access.normalize_settings_features(settings_features)
    except ValueError as e:
        raise OnboardingError('settings_features', str(e))
    if not isinstance(max_users, int) or max_users < 1:
        raise OnboardingError('max_users', 'Allow at least one user (the client’s admin).')
    check_available(name, admin_username, code)

    with transaction.atomic():
        tenant = Tenant.objects.create(name=name, code=code or _free_code(name),
                                       contact_email=admin_email, contact_phone=contact_phone,
                                       package=package, modules=modules, settings_features=settings_features,
                                       max_users=max_users)
        # role SUPER_ADMIN is the tenant's own top role; never is_superuser / is_staff — those
        # open Django admin, which is not tenant-scoped, and is_superuser also marks the
        # platform owner (see apps.common.permissions.IsPlatformAdmin).
        admin = User.objects.create_user(username=admin_username, email=admin_email or None,
                                         password=password, role='SUPER_ADMIN', tenant=tenant,
                                         phone=contact_phone or None)
        ensure_tenant_defaults(tenant, branch_name=branch_name, fresh=True)
        log_event(tenant, 'ONBOARDED', actor, admin=admin.username, package=package, modules=modules,
                  max_users=max_users)
    return tenant, admin


def _fiscal_year(today=None):
    today = today or datetime.date.today()
    start = today.year if today.month >= 4 else today.year - 1
    return datetime.date(start, 4, 1), datetime.date(start + 1, 3, 31)


def _free_value(taken, base, limit=20):
    value, n = base[:limit], 2
    while value in taken:
        suffix = f'-{n}'
        value = f'{base[:limit - len(suffix)]}{suffix}'
        n += 1
    return value


def ensure_tenant_defaults(tenant, *, branch_name='', fresh=False):
    """Give `tenant` every default master its first saves and searches rely on. Idempotent: only
    what is missing is created; nothing existing is changed except binding a default branch where
    none is set. Returns the names of the defaults it had to create.

      * Company (store profile) and exactly one default, active branch — "Head Office" unless
        named. A client has one primary branch, never a separate generic "Default".
      * A Main Warehouse for every active branch without one (stock ledger, racks, adjustments).
      * Chart of accounts + posting-role mappings (the ledger groups every save posts to).
      * BusinessSettings pointing at the default branch.
      * The client's owners (role SUPER_ADMIN) bound to the default branch, with every branch.
      * Starter product categories and services, bill + barcode-label templates, barcode series.

    `fresh` marks a brand-new client: starter lists are seeded even when the database was wiped
    before (a wipe's "deliberately empty" marker concerns the businesses it wiped).
    """
    from apps.company.models import Branch, BusinessSettings, Company, UserBranchAccess, Warehouse

    created = []
    User = get_user_model()
    with tenancy.use_tenant(tenant.pk), transaction.atomic():
        company = Company.objects.order_by('created_at').first()
        if company is None:
            start, end = _fiscal_year()
            company = Company.objects.create(name=tenant.name, email=tenant.contact_email or None,
                                             phone=tenant.contact_phone or None,
                                             fiscal_year_start=start, fiscal_year_end=end)
            created.append('company')

        branches = list(Branch.objects.filter(is_active=True).order_by('created_at'))
        default = next((b for b in branches if b.is_default), None)
        if default is None and branches:
            default = branches[0]
            default.is_default = True
            default.save()  # Branch.save() clears the flag on every other row
            created.append('default branch')
        if default is None:
            taken = set(Branch.all_objects.values_list('code', flat=True))
            default = Branch.objects.create(company=company, name=(branch_name or '').strip() or HEAD_OFFICE,
                                            code=_free_value(taken, 'HO'), phone=tenant.contact_phone or None,
                                            is_default=True, is_active=True)
            branches = [default]
            created.append('branch')

        # Stock ledger rows, stock adjustments, racks and opening stock all need a warehouse;
        # without one a client's stock movements were silently left out of the ledger.
        with_warehouse = set(Warehouse.objects.values_list('branch_id', flat=True))
        taken = set(Warehouse.all_objects.values_list('code', flat=True))
        for branch in branches:
            if branch.pk in with_warehouse:
                continue
            base = 'WH-MAIN' if branch.pk == default.pk else f'WH-{branch.code}'.upper()
            code = _free_value(taken, base)
            taken.add(code)
            Warehouse.objects.create(branch=branch, name='Main Warehouse', code=code)
            created.append(f'warehouse {code}')

        # Chart of accounts + posting-role mappings now, rather than lazily inside the client's
        # first Supplier / Customer / sale save.
        from apps.financial.defaults import ensure_accounting_defaults
        ensure_accounting_defaults()

        business = BusinessSettings.load()
        if business.default_branch_id not in {b.pk for b in branches}:
            business.default_branch = default
            business.save(update_fields=['default_branch'])
            created.append('business settings default branch')

        # Owners sign in to the default branch through an explicit binding, so the header, the
        # branch switcher and new documents never fall back to a guessed or generic branch.
        for username in User.objects.filter(tenant=tenant, role='SUPER_ADMIN').values_list('username', flat=True):
            access = UserBranchAccess.objects.filter(username__iexact=username).first()
            if access is None:
                UserBranchAccess.objects.create(username=username, access_all_branches=True, default_branch=default)
                created.append(f'branch access {username}')
            elif access.default_branch_id is None:
                access.default_branch = default
                access.save(update_fields=['default_branch', 'updated_at'])
                created.append(f'default branch for {username}')

        from apps.common.models import DataResetMarker
        if fresh or DataResetMarker.current() is None:
            from apps.masters.views import seed_default_categories
            from apps.sales.views import seed_default_services
            if seed_default_categories():
                created.append('categories')
            if seed_default_services():
                created.append('services')

        # Bill / label templates and the barcode series are otherwise created inside the first
        # print or product save.
        from apps.billing.views import ensure_seeded as ensure_bill_templates
        from apps.products.label_views import ensure_seeded as ensure_label_templates
        from apps.products.models import BarcodeSeriesConfig
        ensure_bill_templates()
        ensure_label_templates()
        BarcodeSeriesConfig.load()

    if tenant.defaults_version < DEFAULTS_VERSION:
        Tenant.objects.filter(pk=tenant.pk).update(defaults_version=DEFAULTS_VERSION)
        tenant.defaults_version = DEFAULTS_VERSION
    return created


def heal_tenant_defaults(tenant):
    """Sign-in catch-up for a client created before one of the defaults existed (one cheap
    version check otherwise). Never blocks the sign-in."""
    if tenant is None or tenant.defaults_version >= DEFAULTS_VERSION:
        return
    try:
        created = ensure_tenant_defaults(tenant)
        if created:
            log_event(tenant, 'DEFAULTS_PROVISIONED', 'system', created=created, version=DEFAULTS_VERSION)
    except Exception:
        logger.exception('Could not provision the default masters of tenant %s', tenant.pk)
