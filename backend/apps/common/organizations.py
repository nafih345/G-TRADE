"""Phase 2 — multi-company: Organization → Companies (= Tenants) → Branches → users and records.

Decision D1 (ARCHITECTURE_DECISION_REGISTER.md): a **company is a tenant**. Every business row is
already isolated per tenant by the ORM (apps/common/tenancy.py), so each company gets its own
books, masters, numbering, settings and files without a single `company_id` column. This module
adds what sits above that boundary:

  * Organization        — the customer. Groups its companies. Holds no business data.
  * UserCompanyMembership — a user's access to a company other than their home company
                          (User.tenant), with the role they hold THERE. Branch access inside that
                          company is its own UserBranchAccess row (fail-closed when missing).
  * OrganizationAdmin   — who may create companies, grant memberships, copy master data and read
                          the consolidated summaries.

Trust rules (never relaxed):
  * The active company is the signed `tenant_id` claim of the caller's token. A company id sent
    by the browser is only ever a *request* to switch; switch_company() verifies membership on
    the server and issues a new token pair (security.policy.issue_tokens).
  * Every authenticated request re-checks that the token's company is the user's home company or
    an ACTIVE membership in the SAME organization (tenant_context.check_user_tenant), so revoking
    a membership locks the user out of that company (at once in this worker; within
    HOT_CACHE_SECONDS in other workers).
  * Work that spans companies (memberships, copy-masters, consolidated summaries) runs per company
    under tenancy.use_tenant(<that company>) — never tenancy.unscoped() — and only over companies
    the caller is entitled to.
"""
import copy
import datetime
import logging
from decimal import Decimal

from django.contrib.auth import get_user_model
from django.db import IntegrityError, transaction
from django.db.models import Count, DecimalField, ExpressionWrapper, F, Q, Sum, Value
from django.db.models.functions import Coalesce
from django.utils.text import slugify

from apps.common import hot_cache, tenancy

logger = logging.getLogger('django')

ADMIN_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR'}
COPY_SECTIONS = ('categories', 'brands', 'units', 'taxes', 'services', 'suppliers', 'products')
COPY_SECTION_LABELS = {
    'categories': 'Product categories', 'brands': 'Brands', 'units': 'Units', 'taxes': 'Tax rates',
    'services': 'Services', 'suppliers': 'Suppliers (no balances or ledgers history)',
    'products': 'Products (catalogue only, no stock)',
}
ZERO = Decimal('0')


class MembershipError(ValueError):
    """A membership that would break the organization boundary."""


class OrganizationError(ValueError):
    """A business-rule refusal from the organization services, tied to an input field."""

    def __init__(self, field, message, status=400):
        super().__init__(message)
        self.field = field
        self.message = message
        self.status = status


# ---------------------------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------------------------

def _models():
    from apps.common.models import Organization, OrganizationAdmin, Tenant, UserCompanyMembership
    return Organization, OrganizationAdmin, Tenant, UserCompanyMembership


def tenant_org_id(tenant_id):
    """Organization id of a company (tenant), or None (unknown tenant / not yet assigned)."""
    if tenant_id is None:
        return None
    _o, _a, Tenant, _m = _models()
    return hot_cache.get_or_load(
        f'org:of:{tenant_id}',
        lambda: Tenant.objects.filter(pk=tenant_id).values_list('organization_id', flat=True).first())


def real_user(user):
    """The account itself, never a company-member copy (company_user): a copy carries the role of
    the company the request runs in, not the user's home role."""
    if user is not None and getattr(user, '_company_tenant_id', None) is not None:
        return get_user_model().objects.get(pk=user.pk)
    return user


def base_role(user):
    """The user's own role (their home company's), Django superusers counting as Super Admin."""
    user = real_user(user)
    if user is None:
        return ''
    return 'SUPER_ADMIN' if getattr(user, 'is_superuser', False) else (getattr(user, 'role', '') or '').upper()


# Direct Edit switches (apps/authentication/edit_permissions.EDIT_MODULES); kept on the membership
# per company, on the User for the home company.
EDIT_FLAGS = ('can_edit_eye_test', 'can_edit_sales', 'can_edit_wholesale', 'can_edit_inventory',
              'can_edit_purchase', 'can_edit_accounts')


def membership_info(user_id, home_tenant_id, tenant_id):
    """{'role', 'flags': {can_edit_*: bool}} for an ACTIVE membership of the user in `tenant_id`,
    within their own (active) organization, else None. Never consulted for the home company."""
    if user_id is None or home_tenant_id is None or tenant_id is None or int(tenant_id) == int(home_tenant_id):
        return None
    _o, _a, Tenant, Membership = _models()

    def load():
        row = (Membership.objects.filter(user_id=user_id, company_id=tenant_id, is_active=True,
                                         company__organization__is_active=True)
               .values('role', 'company__organization_id', *EDIT_FLAGS).first())
        if row is None or row['company__organization_id'] is None:
            return None
        home_org = Tenant.objects.filter(pk=home_tenant_id).values_list('organization_id', flat=True).first()
        if home_org is None or home_org != row['company__organization_id']:
            return None  # never across organizations, whatever the row says
        role = (row['role'] or '').upper()
        if not role:
            return None
        return {'role': role, 'flags': {f: bool(row[f]) for f in EDIT_FLAGS}}
    return hot_cache.get_or_load(f'org:member:{user_id}:{tenant_id}', load)


def membership_role(user_id, home_tenant_id, tenant_id):
    """The role a user holds in `tenant_id` through an active same-organization membership, else None."""
    info = membership_info(user_id, home_tenant_id, tenant_id)
    return info['role'] if info else None


def company_role(user, tenant_id):
    """The role `user` holds in company `tenant_id`: their own role at home, the membership role
    elsewhere, None when they have no access there."""
    if user is None or tenant_id is None:
        return None
    if user.tenant_id is not None and int(tenant_id) == int(user.tenant_id):
        return base_role(user)
    role = membership_role(user.pk, user.tenant_id, tenant_id)
    if role is None:
        return None
    return 'SUPER_ADMIN' if getattr(user, 'is_superuser', False) else role


def can_access_company(user, tenant_id):
    return bool(user is not None and getattr(user, 'is_active', False) and company_role(user, tenant_id))


def _refuse_save(*_args, **_kwargs):
    raise RuntimeError('A company-scoped user is a read-only view of the account. Load the user from the '
                       'database before changing it.')


def company_user(user, tenant_id):
    """`user` as seen inside company `tenant_id`.

    * home company → the user unchanged;
    * a company they are a member of → a shallow copy whose `role` is the membership role and whose
      Direct Edit switches (can_edit_*) are that membership's, so the places that read `user.role`
      (module access, branch admin, approvals, settings …) and the edit-approval gate apply that
      company's rules without being changed. The copy refuses save(), so nothing of it can ever be
      written onto the account;
    * anything else → None.
    """
    if user is None or tenant_id is None:
        return None
    user = real_user(user)
    if user.tenant_id is not None and int(tenant_id) == int(user.tenant_id):
        return user
    info = membership_info(user.pk, user.tenant_id, tenant_id)
    if info is None:
        return None
    clone = copy.copy(user)
    clone.role = info['role']
    # This company's Direct Edit switches, not the home company's (edit_permissions reads
    # user.can_edit_<module>).
    for flag, value in info['flags'].items():
        setattr(clone, flag, value)
    clone._company_tenant_id = int(tenant_id)
    clone.save = _refuse_save
    return clone


def home_organization_id(user):
    return tenant_org_id(getattr(user, 'tenant_id', None))


def is_org_admin(user):
    """True for an active user listed as an admin of their HOME company's organization."""
    if user is None or not getattr(user, 'is_authenticated', False) or not getattr(user, 'is_active', False):
        return False
    org_id = home_organization_id(user)
    if org_id is None:
        return False
    _o, OrgAdmin, _t, _m = _models()
    return bool(hot_cache.get_or_load(
        f'org:admin:{user.pk}:{org_id}',
        lambda: OrgAdmin.objects.filter(organization_id=org_id, user_id=user.pk,
                                        organization__is_active=True).exists()))


def membership_problem(user, company):
    """'' when `user` may hold a membership in `company`, else why not."""
    if user is None or company is None:
        return 'A membership needs a user and a company.'
    if user.tenant_id is None:
        return 'This user has no home company.'
    if company.pk == user.tenant_id:
        return 'This is the user’s home company; they already have access to it.'
    company_org = company.organization_id
    home_org = tenant_org_id(user.tenant_id)
    if company_org is None or home_org is None or company_org != home_org:
        return 'The company belongs to another organization.'
    return ''


# ---------------------------------------------------------------------------------------------
# Organization lifecycle
# ---------------------------------------------------------------------------------------------

def _free_org_code(base):
    Organization, *_ = _models()
    base = (slugify(base) or 'org')[:34]
    code, n = base, 2
    while Organization.objects.filter(code=code).exists():
        code = f'{base}-{n}'
        n += 1
    return code


def grant_default_org_admins(tenant, organization):
    """The company's owners (role SUPER_ADMIN, or Django superusers) administer its organization
    — the same rule migration common 0010 used for existing customers."""
    _o, OrgAdmin, _t, _m = _models()
    User = get_user_model()
    for user_id in User.objects.filter(tenant=tenant).filter(Q(role='SUPER_ADMIN') | Q(is_superuser=True)) \
            .values_list('pk', flat=True):
        OrgAdmin.objects.get_or_create(organization=organization, user_id=user_id, defaults={'granted_by': 'system'})


def ensure_organization(tenant):
    """The tenant's organization, creating a one-company organization for a tenant that has none
    (created before Phase 2, or by code that predates it)."""
    Organization, _a, Tenant, _m = _models()
    if tenant.organization_id:
        return Organization.objects.get(pk=tenant.organization_id)
    with transaction.atomic():
        row = Tenant.objects.select_for_update().get(pk=tenant.pk)
        if row.organization_id is None:
            org = Organization.objects.create(name=row.name, code=_free_org_code(row.code or row.name))
            Tenant.objects.filter(pk=row.pk).update(organization=org)
            row.organization_id = org.pk
            grant_default_org_admins(row, org)
        tenant.organization_id = row.organization_id
    hot_cache.clear()
    return Organization.objects.get(pk=tenant.organization_id)


def organization_companies(org_id):
    _o, _a, Tenant, _m = _models()
    return Tenant.objects.filter(organization_id=org_id).order_by('name', 'id')


def accessible_companies(user):
    """Every company the user may switch to: home first, then active memberships, all in the user's
    organization and active today. [{tenant_id, name, code, role, is_home}]"""
    _o, _a, Tenant, Membership = _models()
    user = real_user(user)
    if user is None or user.tenant_id is None:
        return []
    home = Tenant.objects.filter(pk=user.tenant_id).first()
    if home is None:
        return []
    out = []
    if home.is_effectively_active:
        out.append({'tenant_id': home.pk, 'name': home.name, 'code': home.code, 'role': base_role(user),
                    'is_home': True})
    if home.organization_id is None:
        return out
    rows = (Membership.objects.filter(user_id=user.pk, is_active=True, company__organization_id=home.organization_id,
                                      company__organization__is_active=True)
            .exclude(company_id=home.pk).select_related('company').order_by('company__name'))
    for m in rows:
        if m.company.is_effectively_active:
            out.append({'tenant_id': m.company.pk, 'name': m.company.name, 'code': m.company.code,
                        'role': 'SUPER_ADMIN' if user.is_superuser else (m.role or '').upper(), 'is_home': False})
    return out


def _audit(tenant, action, actor, **details):
    from apps.common.tenant_onboarding import log_event
    try:
        log_event(tenant, action, actor, **details)
    except Exception:  # an audit failure never undoes the change it describes
        logger.exception('Could not write the %s audit row for tenant %s', action, getattr(tenant, 'pk', tenant))


def _security_audit(event, message, request=None, user=None, **details):
    try:
        from apps.security.audit import log_event
        log_event(event, 'AUTH', message, request=request, user=user, details=details)
    except Exception:
        logger.exception('Could not write the %s security audit row', event)


def _require_org_admin(actor):
    if not is_org_admin(actor):
        raise OrganizationError(None, 'Only an organization administrator can do this.', status=403)
    org_id = home_organization_id(actor)
    if org_id is None:
        raise OrganizationError(None, 'Your company is not linked to an organization.', status=403)
    return org_id


def _org_company(org_id, tenant_id):
    """A company of the caller's organization, else a 404-style refusal (never says whether the
    id exists elsewhere)."""
    _o, _a, Tenant, _m = _models()
    try:
        company = Tenant.objects.filter(pk=int(tenant_id), organization_id=org_id).first()
    except (TypeError, ValueError):
        company = None
    if company is None:
        raise OrganizationError('tenant_id', 'Company not found.', status=404)
    return company


# ---------------------------------------------------------------------------------------------
# Company creation and memberships
# ---------------------------------------------------------------------------------------------

def create_company(actor, *, name, branch_name='', copy_from=None, sections=()):
    """Create a company (tenant) in the actor's organization with its own default masters (branch,
    warehouse, chart of accounts, settings, templates — exactly what onboarding gives a new
    client), make the actor its Super Admin member with every branch, and optionally copy master
    data from another company of the organization. Returns (tenant, copy summary or None)."""
    Organization, _a, Tenant, Membership = _models()
    from apps.common.tenant_onboarding import _free_code, ensure_tenant_defaults
    from apps.company.models import Branch, UserBranchAccess

    org_id = _require_org_admin(actor)
    name = (name or '').strip()
    if not name:
        raise OrganizationError('name', 'Give the company a name.')
    if len(name) > 150:
        raise OrganizationError('name', 'Use at most 150 characters.')
    sections = _clean_sections(sections) if copy_from else ()
    source = _org_company(org_id, copy_from) if copy_from else None
    if source is not None and not can_access_company(actor, source.pk):
        raise OrganizationError('copy_from', 'You do not have access to the company to copy from.', status=403)
    home = Tenant.objects.get(pk=actor.tenant_id)

    with transaction.atomic():
        org = Organization.objects.select_for_update().get(pk=org_id)  # serializes the limit check
        if not org.is_active:
            raise OrganizationError(None, 'This organization is disabled.', status=403)
        held = Tenant.objects.filter(organization=org).count()
        from apps.common.edition import licensed_company_limit
        try:
            # Windows edition: the signed licence decides, never the database column.
            limit = licensed_company_limit(org, org.max_companies)
        except Exception as exc:
            if exc.__class__.__name__ == 'LicenseLimitError':
                raise OrganizationError('name', exc.message, status=403)
            raise
        if held >= limit:
            raise OrganizationError('name', f'Your organization may hold {limit} '
                                            f'compan{"y" if limit == 1 else "ies"}. '
                                            'Ask your provider to raise the limit.')
        if Tenant.objects.filter(name__iexact=name).exists():
            raise OrganizationError('name', f'A company named "{name}" already exists. Choose another name.')
        try:
            # The new company starts with the creating company's plan (modules, role levels,
            # settings sections, seats) — it can never receive more than its organization has.
            tenant = Tenant.objects.create(
                name=name, code=_free_code(name), organization=org,
                contact_email=home.contact_email, contact_phone=home.contact_phone,
                package=home.package, modules=list(home.modules or []),
                role_permissions=dict(home.role_permissions or {}), settings_features=home.settings_features,
                module_features=dict(home.module_features or {}), max_users=home.max_users)
        except IntegrityError:
            raise OrganizationError('name', 'That company name was just taken. Try another.')
        ensure_tenant_defaults(tenant, branch_name=branch_name, fresh=True)
        Membership.objects.create(user=actor, company=tenant, role='SUPER_ADMIN', created_by=actor.username)
        with tenancy.use_tenant(tenant.pk):
            default = Branch.objects.filter(is_default=True).first()
            UserBranchAccess.objects.create(username=actor.username, user=actor, access_all_branches=True,
                                            default_branch=default)
        _audit(tenant, 'COMPANY_CREATED', actor, organization=org.pk, created_from=home.pk)
        _audit(home, 'COMPANY_ADDED_TO_ORGANIZATION', actor, company=tenant.pk, company_name=tenant.name)
    hot_cache.clear()

    summary = None
    if source is not None and sections:
        summary = copy_master_data(actor, source.pk, tenant.pk, sections)
    return tenant, summary


def organization_users(org_id):
    """Active and inactive users whose home company belongs to the organization."""
    User = get_user_model()
    return User.objects.filter(tenant__organization_id=org_id).select_related('tenant').order_by('username')


def active_membership_count(tenant):
    _o, _a, _t, Membership = _models()
    return Membership.objects.filter(company=tenant, is_active=True, user__is_active=True).count()


def save_membership(actor, company_id, *, user_id, role, is_active=True, all_branches=False, branch_ids=(),
                    default_branch_id=None):
    """Grant / change / revoke `user`'s membership in a company of the actor's organization, and
    set their branch access there. Returns the membership."""
    _o, _a, Tenant, Membership = _models()
    from apps.common import module_access
    from apps.common.tenant_onboarding import OnboardingError, check_seat_available
    from apps.company.models import Branch, UserBranchAccess

    org_id = _require_org_admin(actor)
    company = _org_company(org_id, company_id)
    User = get_user_model()
    user = User.objects.filter(pk=user_id, tenant__organization_id=org_id).first() if user_id else None
    if user is None:
        raise OrganizationError('user_id', 'Pick a user of your organization.')
    role = (role or '').strip().upper()
    if role not in module_access.CLIENT_ROLE_KEYS:
        raise OrganizationError('role', 'Pick a valid role.')
    problem = membership_problem(user, company)
    if problem:
        raise OrganizationError('user_id', problem)

    with transaction.atomic():
        membership = Membership.objects.select_for_update().filter(user=user, company=company).first()
        was_active = bool(membership and membership.is_active)
        if is_active and not was_active:
            try:
                check_seat_available(company)
            except OnboardingError as e:
                raise OrganizationError('user_id', e.message)
        if membership is None:
            membership = Membership(user=user, company=company, created_by=actor.username)
        membership.role = role
        membership.is_active = bool(is_active)
        membership.save()

        if is_active:
            with tenancy.use_tenant(company.pk):
                wanted = [str(b) for b in (branch_ids or []) if b]
                branches = list(Branch.objects.filter(pk__in=wanted)) if wanted else []
                if len(branches) != len(set(wanted)):
                    raise OrganizationError('branch_ids', 'One of the branches is not a branch of this company.')
                default = None
                if default_branch_id:
                    default = Branch.objects.filter(pk=default_branch_id).first()
                    if default is None or (not all_branches and default.pk not in {b.pk for b in branches}):
                        raise OrganizationError('default_branch_id', 'Pick the default from the selected branches.')
                elif branches:
                    default = branches[0]
                elif all_branches:
                    default = Branch.objects.filter(is_default=True).first()
                access = UserBranchAccess.objects.filter(user=user).first()
                if access is None:
                    access = UserBranchAccess(username=user.username, user=user)
                access.access_all_branches = bool(all_branches)
                access.default_branch = default
                access.save()
                access.branches.set([] if all_branches else branches)

        action = ('MEMBERSHIP_GRANTED' if is_active and not was_active
                  else 'MEMBERSHIP_REVOKED' if was_active and not is_active else 'MEMBERSHIP_CHANGED')
        _audit(company, action, actor, user=user.username, role=role, home_company=user.tenant_id,
               all_branches=bool(all_branches), branches=[str(b) for b in (branch_ids or [])])
    hot_cache.clear()
    return membership


def membership_rows(org_id, company):
    """Members of `company` (other than its home users) with their branch access there."""
    _o, _a, _t, Membership = _models()
    from apps.company.models import UserBranchAccess
    rows = list(Membership.objects.filter(company=company, company__organization_id=org_id)
                .select_related('user', 'user__tenant').order_by('user__username'))
    with tenancy.use_tenant(company.pk):
        access = {a.user_id: a for a in UserBranchAccess.objects.filter(user_id__in=[m.user_id for m in rows])
                  .prefetch_related('branches')}
    out = []
    for m in rows:
        a = access.get(m.user_id)
        out.append({
            'id': m.pk, 'user_id': str(m.user_id), 'username': m.user.username,
            'name': m.user.get_full_name() or m.user.username, 'home_company': m.user.tenant.name if m.user.tenant_id else '',
            'role': m.role, 'is_active': m.is_active, 'user_active': m.user.is_active,
            'all_branches': bool(a and a.access_all_branches),
            'branch_ids': [str(b.pk) for b in a.branches.all()] if a else [],
            'default_branch_id': str(a.default_branch_id) if a and a.default_branch_id else None,
            'created_by': m.created_by, 'created_at': m.created_at.isoformat() if m.created_at else None,
        })
    return out


# ---------------------------------------------------------------------------------------------
# Copy master data (explicit, never automatic — decision D2)
# ---------------------------------------------------------------------------------------------

def _clean_sections(sections):
    sections = [s for s in (sections or []) if s]
    unknown = [s for s in sections if s not in COPY_SECTIONS]
    if unknown:
        raise OrganizationError('sections', f'Unknown section: {", ".join(unknown)}.')
    if 'products' in sections:
        # A product refers to its category / brand / unit / tax; copy those along.
        sections = list(dict.fromkeys(['categories', 'brands', 'units', 'taxes', *sections]))
    return [s for s in COPY_SECTIONS if s in sections]


def _snapshot(source_id, sections):
    """Read what will be copied, inside the SOURCE company's scope."""
    from apps.masters.models import Brand, ProductCategory, Tax, Unit
    from apps.products.models import Product
    from apps.purchasing.models import Supplier
    from apps.sales.models import Service

    snap = {}
    with tenancy.use_tenant(source_id):
        if 'categories' in sections:
            snap['categories'] = list(ProductCategory.objects.values(
                'name', 'code', 'description', 'gst_percentage', 'hsn_code', 'status', 'display_order', 'product_mode'))
        if 'brands' in sections:
            snap['brands'] = list(Brand.objects.values('name', 'code', 'product_mode'))
        if 'units' in sections:
            snap['units'] = list(Unit.objects.values('name', 'code'))
        if 'taxes' in sections:
            snap['taxes'] = list(Tax.objects.values(
                'name', 'rate', 'tax_type', 'treatment', 'category', 'applies_to_sales', 'applies_to_purchases',
                'is_active', 'description'))
        if 'services' in sections:
            snap['services'] = list(Service.objects.values('name', 'description', 'default_price', 'tax_percentage',
                                                           'is_active'))
        if 'suppliers' in sections:
            snap['suppliers'] = list(Supplier.objects.values(
                'name', 'company_name', 'contact_person', 'email', 'phone', 'gstin', 'address', 'city',
                'payment_terms', 'account_number'))
        if 'products' in sections:
            snap['products'] = list(Product.objects.values(
                'name', 'sku', 'barcode', 'secondary_barcode', 'description', 'category__code', 'brand__code',
                'unit__code', 'tax__name', 'tax__rate', 'category_name', 'brand_name', 'supplier_name', 'color',
                'size', 'frame_type', 'hsn_code', 'cost_price', 'retail_price', 'wholesale_price',
                'wholesale_sale_price', 'minimum_stock', 'maximum_stock', 'is_active', 'extra_data'))
    return snap


def _write_copy(snap):
    """Create the snapshot's rows inside the TARGET company's scope (already active). Existing rows
    (same code / name / SKU) are left untouched. Returns {section: {'created', 'skipped'}}."""
    from apps.masters.models import Brand, ProductCategory, Tax, Unit
    from apps.products.barcode_utils import advance_series_past, taken_barcodes
    from apps.products.models import Product
    from apps.purchasing.models import Supplier
    from apps.purchasing.supplier_utils import get_or_create_supplier_ledger_account, reserve_supplier_codes
    from apps.sales.models import Service
    from apps.sales.views import _next_service_code

    result = {}

    def tally(section, created, skipped):
        result[section] = {'created': created, 'skipped': skipped}

    def by_code(model, rows, fields):
        have = {c.lower() for c in model.all_objects.values_list('code', flat=True) if c}
        made = skipped = 0
        for r in rows:
            code = (r.get('code') or '').strip()
            if not code or code.lower() in have:
                skipped += 1
                continue
            model.objects.create(**{f: r[f] for f in fields})
            have.add(code.lower())
            made += 1
        return made, skipped

    if 'categories' in snap:
        tally('categories', *by_code(ProductCategory, snap['categories'], (
            'name', 'code', 'description', 'gst_percentage', 'hsn_code', 'status', 'display_order', 'product_mode')))
    if 'brands' in snap:
        tally('brands', *by_code(Brand, snap['brands'], ('name', 'code', 'product_mode')))
    if 'units' in snap:
        tally('units', *by_code(Unit, snap['units'], ('name', 'code')))
    if 'taxes' in snap:
        have = {(n.lower(), Decimal(r)) for n, r in Tax.objects.values_list('name', 'rate')}
        made = skipped = 0
        for r in snap['taxes']:
            key = ((r['name'] or '').lower(), Decimal(r['rate']))
            if key in have:
                skipped += 1
                continue
            Tax.objects.create(is_default=False, **r)  # never a second default tax
            have.add(key)
            made += 1
        tally('taxes', made, skipped)
    if 'services' in snap:
        have = {(n or '').lower() for n in Service.objects.values_list('name', flat=True)}
        made = skipped = 0
        for r in snap['services']:
            if (r['name'] or '').lower() in have:
                skipped += 1
                continue
            Service.objects.create(service_code=_next_service_code(), **r)
            have.add((r['name'] or '').lower())
            made += 1
        tally('services', made, skipped)
    if 'suppliers' in snap:
        have = {(n or '').strip().lower() for n in Supplier.objects.values_list('name', flat=True)}
        made = skipped = 0
        for r in snap['suppliers']:
            key = (r['name'] or '').strip().lower()
            if not key or key in have:
                skipped += 1
                continue
            # Own code series and own payable sub-ledger in this company; no balance carried over.
            supplier = Supplier.objects.create(supplier_code=reserve_supplier_codes()[0], **r)
            get_or_create_supplier_ledger_account(supplier)
            have.add(key)
            made += 1
        tally('suppliers', made, skipped)
    if 'products' in snap:
        cats = {c.lower(): pk for pk, c in ProductCategory.objects.values_list('pk', 'code') if c}
        brands = {c.lower(): pk for pk, c in Brand.objects.values_list('pk', 'code') if c}
        units = {c.lower(): pk for pk, c in Unit.objects.values_list('pk', 'code') if c}
        taxes = {((n or '').lower(), Decimal(r)): pk for pk, n, r in Tax.objects.values_list('pk', 'name', 'rate')}
        skus = {(s or '').lower() for s in Product.all_objects.values_list('sku', flat=True)}
        codes = [c for r in snap['products'] for c in (r['barcode'], r['secondary_barcode']) if c]
        taken = taken_barcodes(codes) if codes else set()
        made = skipped = 0
        kept_codes = []
        for r in snap['products']:
            sku = (r['sku'] or '').strip()
            if not sku or sku.lower() in skus:
                skipped += 1
                continue
            barcode = r['barcode'] if r['barcode'] and r['barcode'] not in taken else None
            secondary = (r['secondary_barcode'] if r['secondary_barcode'] and r['secondary_barcode'] not in taken
                         and r['secondary_barcode'] != barcode else None)
            tax_key = ((r['tax__name'] or '').lower(), Decimal(r['tax__rate'])) if r['tax__name'] is not None else None
            Product.objects.create(
                name=r['name'], sku=sku, barcode=barcode, secondary_barcode=secondary, description=r['description'],
                category_id=cats.get((r['category__code'] or '').lower()),
                brand_id=brands.get((r['brand__code'] or '').lower()),
                unit_id=units.get((r['unit__code'] or '').lower()),
                tax_id=taxes.get(tax_key) if tax_key else None,
                category_name=r['category_name'], brand_name=r['brand_name'], supplier_name=r['supplier_name'],
                color=r['color'], size=r['size'], frame_type=r['frame_type'], hsn_code=r['hsn_code'],
                cost_price=r['cost_price'], retail_price=r['retail_price'], wholesale_price=r['wholesale_price'],
                wholesale_sale_price=r['wholesale_sale_price'], minimum_stock=r['minimum_stock'],
                maximum_stock=r['maximum_stock'], is_active=r['is_active'], extra_data=r['extra_data'] or {},
                stock=0, opening_stock=0)  # catalogue only: stock is never copied between companies
            skus.add(sku.lower())
            for c in (barcode, secondary):
                if c:
                    taken.add(c)
                    kept_codes.append(c)
            made += 1
        if kept_codes:
            advance_series_past(kept_codes)  # this company's own label series steps over copied codes
        tally('products', made, skipped)
    return result


def copy_master_data(actor, source_id, target_id, sections):
    """Copy the chosen master lists from one company of the actor's organization to another.
    Explicit and one-way: nothing stays linked, existing rows are never overwritten, customers /
    patients, stock, balances and transactions are never copied."""
    _o, _a, Tenant, _m = _models()
    org_id = _require_org_admin(actor)
    source = _org_company(org_id, source_id)
    target = _org_company(org_id, target_id)
    if source.pk == target.pk:
        raise OrganizationError('source_tenant_id', 'Pick a different company to copy from.')
    for company, field in ((source, 'source_tenant_id'), (target, 'tenant_id')):
        if not can_access_company(actor, company.pk):
            raise OrganizationError(field, f'You do not have access to {company.name}.', status=403)
    sections = _clean_sections(sections)
    if not sections:
        raise OrganizationError('sections', 'Pick at least one list to copy.')
    snap = _snapshot(source.pk, sections)
    with tenancy.use_tenant(target.pk), transaction.atomic():
        result = _write_copy(snap)
    _audit(target, 'MASTER_DATA_COPIED_IN', actor, source=source.pk, source_name=source.name, result=result)
    _audit(source, 'MASTER_DATA_COPIED_OUT', actor, target=target.pk, target_name=target.name,
           sections=list(sections))
    return {'source_tenant_id': source.pk, 'tenant_id': target.pk, 'sections': result}


# ---------------------------------------------------------------------------------------------
# Consolidated summaries (read-only; never journals, never accounting books — decision D3)
# ---------------------------------------------------------------------------------------------

def _branch_unrestricted(user, role):
    """Inside the active (use_tenant) company: may this user see company-wide totals? Same rule as
    the branch context: Multi-Branch off, an admin role, or an all-branches access row."""
    from apps.common.branch_context import _branch_settings, _user_access
    if role in ADMIN_ROLES:
        return True
    multi, _default = _branch_settings()
    if not multi:
        return True
    access = _user_access(user.username, user.pk)
    return bool(access and access[0])


def summary_companies(user):
    """[(company dict, included, reason)] — every company the user can access; a company where they
    are branch-restricted is listed but left out of the figures (its totals would show branches
    they may not see)."""
    user = real_user(user)
    out = []
    for c in accessible_companies(user):
        with tenancy.use_tenant(c['tenant_id']):
            if _branch_unrestricted(user, c['role']):
                out.append((c, True, ''))
            else:
                out.append((c, False, 'Your access in this company is limited to some branches.'))
    return out


def _currency():
    from apps.company.store_profile import get_company
    company = get_company()
    return (company.currency if company else '') or ''


def _money(v):
    return str((v or ZERO).quantize(Decimal('0.01')))


def _parse_date(value, default):
    if not value:
        return default
    try:
        return datetime.date.fromisoformat(str(value))
    except ValueError:
        raise OrganizationError('date', 'Use dates as YYYY-MM-DD.')


def _totals(rows, keys):
    currencies = {r['currency'] for r in rows}
    if len(currencies) > 1:
        return None  # never add amounts in different currencies
    return {k: _money(sum((Decimal(r[k]) for r in rows), ZERO)) for k in keys}


SALES_KEYS = ('retail_total', 'retail_paid', 'wholesale_total', 'wholesale_paid', 'returns_total', 'net_sales')
STOCK_KEYS = ('stock_value_retail', 'stock_value_cost')


def sales_summary(user, date_from=None, date_to=None):
    """Per-company sales for the period: retail invoices (INVOICE documents, not cancelled, net
    amount), wholesale invoices (not cancelled) and sales returns; plus totals when every included
    company uses the same currency. Read-only."""
    from apps.sales.models import Invoice, SalesReturn, WholesaleInvoice
    today = datetime.date.today()
    date_to = _parse_date(date_to, today)
    date_from = _parse_date(date_from, date_to.replace(day=1))
    if date_from > date_to:
        raise OrganizationError('date', 'The start date is after the end date.')
    rows, excluded = [], []
    for company, included, reason in summary_companies(user):
        if not included:
            excluded.append({'tenant_id': company['tenant_id'], 'name': company['name'], 'reason': reason})
            continue
        with tenancy.use_tenant(company['tenant_id']):
            retail = (Invoice.objects.filter(document_type='INVOICE', invoice_date__range=(date_from, date_to))
                      .exclude(status='CANCELLED')
                      .aggregate(n=Count('id'), total=Sum('net_amount'), paid=Sum('paid_amount')))
            wholesale = (WholesaleInvoice.objects.filter(invoice_date__range=(date_from, date_to))
                         .exclude(status__iexact='cancelled')
                         .aggregate(n=Count('id'), total=Sum('grand_total'), paid=Sum('paid_amount')))
            returns = (SalesReturn.objects.filter(return_date__range=(date_from, date_to))
                       .exclude(status='CANCELLED').aggregate(n=Count('id'), total=Sum('total_amount')))
            currency = _currency()
        net = (retail['total'] or ZERO) + (wholesale['total'] or ZERO) - (returns['total'] or ZERO)
        rows.append({
            'tenant_id': company['tenant_id'], 'name': company['name'], 'currency': currency,
            'retail_invoices': retail['n'], 'retail_total': _money(retail['total']), 'retail_paid': _money(retail['paid']),
            'wholesale_invoices': wholesale['n'], 'wholesale_total': _money(wholesale['total']),
            'wholesale_paid': _money(wholesale['paid']),
            'returns': returns['n'], 'returns_total': _money(returns['total']), 'net_sales': _money(net),
        })
    return {'date_from': date_from.isoformat(), 'date_to': date_to.isoformat(), 'companies': rows,
            'excluded': excluded, 'totals': _totals(rows, SALES_KEYS) if rows else None,
            'mixed_currency': len({r['currency'] for r in rows}) > 1,
            'note': 'Summary of each company’s own records. Not consolidated accounts.'}


def stock_summary(user):
    """Per-company stock on hand now: active products, units, out-of-stock / low-stock counts and
    stock value at selling price — and at cost only where this user may see cost prices in that
    company (Pricing Rules → Show Cost Price). Read-only."""
    from apps.company.cost_visibility import can_view_cost
    from apps.products.models import Product
    rows, excluded = [], []
    for company, included, reason in summary_companies(user):
        if not included:
            excluded.append({'tenant_id': company['tenant_id'], 'name': company['name'], 'reason': reason})
            continue
        with tenancy.use_tenant(company['tenant_id']):
            viewer = company_user(user, company['tenant_id'])
            try:
                show_cost = bool(viewer is not None and can_view_cost(viewer))
            except Exception:
                show_cost = False
            products = Product.objects.filter(is_active=True)
            money = DecimalField(max_digits=18, decimal_places=2)
            on_hand = products.filter(stock__gt=0)
            agg = on_hand.aggregate(
                units=Coalesce(Sum('stock'), 0),
                retail=Coalesce(Sum(ExpressionWrapper(F('stock') * F('retail_price'), output_field=money)),
                                Value(ZERO), output_field=money),
                cost=Coalesce(Sum(ExpressionWrapper(F('stock') * F('cost_price'), output_field=money)),
                              Value(ZERO), output_field=money))
            counts = products.aggregate(
                n=Count('id'), out=Count('id', filter=Q(stock__lte=0)),
                low=Count('id', filter=Q(stock__gt=0, stock__lte=F('minimum_stock'))))
            currency = _currency()
        rows.append({
            'tenant_id': company['tenant_id'], 'name': company['name'], 'currency': currency,
            'products': counts['n'], 'units_on_hand': int(agg['units'] or 0), 'out_of_stock': counts['out'],
            'low_stock': counts['low'], 'stock_value_retail': _money(agg['retail']),
            'stock_value_cost': _money(agg['cost']) if show_cost else None,
        })
    totals = None
    if rows and len({r['currency'] for r in rows}) == 1:
        totals = {'stock_value_retail': _money(sum((Decimal(r['stock_value_retail']) for r in rows), ZERO)),
                  'stock_value_cost': (_money(sum((Decimal(r['stock_value_cost']) for r in rows), ZERO))
                                       if all(r['stock_value_cost'] is not None for r in rows) else None),
                  'units_on_hand': sum(r['units_on_hand'] for r in rows),
                  'products': sum(r['products'] for r in rows)}
    return {'as_of': datetime.date.today().isoformat(), 'companies': rows, 'excluded': excluded, 'totals': totals,
            'mixed_currency': len({r['currency'] for r in rows}) > 1,
            'note': 'Summary of each company’s own stock. Not consolidated accounts.'}
