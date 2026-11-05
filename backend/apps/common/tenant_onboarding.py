"""Onboard a client business: its Tenant, its first Super Admin, and the Company + default
branch its store profile and billing start from.

Shared by the platform console (POST /api/superadmin/tenants/) and `manage.py create_tenant`,
so both create exactly the same rows. Everything else a tenant needs (numbering series,
business settings, chart of accounts, bill templates) is created by the app on first use, as on
a fresh install.

Usernames are global (User is not tenant-owned), so the admin username must not exist in any
tenant. The new account can sign in straight away: login reads User.tenant and signs it into
the token as `tenant_id` (security.policy.issue_tokens) — nothing is cached per process that a
new tenant would have to wait for.
"""
import datetime

from django.contrib.auth import get_user_model
from django.db import transaction
from django.utils.text import slugify

from apps.common import module_access, tenancy
from apps.common.models import Tenant, TenantAuditLog


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
    """Create the tenant and its Super Admin in one transaction; returns (tenant, admin)."""
    from apps.company.models import Branch, Company

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
        with tenancy.use_tenant(tenant.pk):
            today = datetime.date.today()
            start_year = today.year if today.month >= 4 else today.year - 1
            company = Company.objects.create(
                name=name, email=admin_email or None, phone=contact_phone or None,
                fiscal_year_start=datetime.date(start_year, 4, 1),
                fiscal_year_end=datetime.date(start_year + 1, 3, 31),
            )
            Branch.objects.create(company=company, name=(branch_name or '').strip() or 'Head Office',
                                  code='HO', phone=contact_phone or None, is_default=True, is_active=True)
        log_event(tenant, 'ONBOARDED', actor, admin=admin.username, package=package, modules=modules,
                  max_users=max_users)
    return tenant, admin
