"""Licence limits, called from the existing enforcement points (local edition only).

Every check re-reads the signed licence through state.current(): a limit raised by editing the
database (Tenant.max_users, Organization.max_companies) has no effect here.
"""

from __future__ import annotations

from django.contrib.auth import get_user_model

from . import state


class LicenseLimitError(Exception):
    def __init__(self, field, message):
        super().__init__(message)
        self.field = field
        self.message = message


UNLIMITED_COMPANIES = 1000


def _limit(verdict, name):
    """The licence's cap for `name`, or None for no cap. A v2 (vendor console) licence says
    "unlimited" explicitly and a 0 there is a real 0 (e.g. no extra clients); v1 licences keep their
    original reading (0 / missing = no cap)."""
    if name in (getattr(verdict, 'unlimited', None) or []):
        return None
    value = (verdict.limits or {}).get(name)
    if getattr(verdict, 'v2', False):
        return value
    return None if value in (None, '', 0) and name != 'companies' else value


def _org_tenants(tenant=None, org=None):
    from apps.common.models import Tenant
    org_id = org.pk if org is not None else getattr(tenant, 'organization_id', None)
    if org_id is None:
        return Tenant.objects.filter(pk=tenant.pk) if tenant is not None else Tenant.objects.none()
    return Tenant.objects.filter(organization_id=org_id)


def _refuse_if_read_only(verdict):
    if verdict.read_only:
        raise LicenseLimitError('license', verdict.message)


def check_users(tenant, adding=1):
    """Named active users across every company of the installation's organization (decision D5)."""
    v = state.current()
    _refuse_if_read_only(v)
    limit = _limit(v, 'users')
    if not limit:
        return
    from apps.common import tenancy
    with tenancy.unscoped():
        used = (get_user_model().objects.filter(tenant__in=_org_tenants(tenant=tenant), is_active=True)
                .exclude(_platform_owner_q()).count())
    if used + adding > int(limit):
        raise LicenseLimitError('max_users', f'Your licence allows {limit} active users and {used} are in use. '
                                             'Deactivate a user or upgrade the licence.')


def _platform_owner_q():
    """The Local Super Admin (superuser in tenant #1) runs the installation; it is not one of a
    company's named users and never takes a licence seat."""
    from django.db.models import Q
    from apps.common.tenancy import DEFAULT_TENANT_ID
    return Q(is_superuser=True, tenant_id=DEFAULT_TENANT_ID)


def _client_org_ids():
    """Organizations on this installation other than the owner's (the organization of tenant #1)."""
    from apps.common import tenancy
    from apps.common.models import Organization, Tenant
    with tenancy.unscoped():
        home = Tenant.objects.filter(pk=tenancy.DEFAULT_TENANT_ID).values_list('organization_id', flat=True).first()
        rows = Organization.objects.all()
        if home:
            rows = rows.exclude(pk=home)
        return list(rows.values_list('pk', flat=True))


def check_clients(adding=1):
    """Client organizations the Local Super Admin may create (licence limit `clients`; absent = no
    limit). Refused while the licence is read-only (expired / invalid)."""
    v = state.current()
    _refuse_if_read_only(v)
    limit = _limit(v, 'clients')
    if limit is None:
        return
    used = len(_client_org_ids())
    if used + adding > int(limit):
        plural = 's' if int(limit) != 1 else ''
        if int(limit) == 0:
            raise LicenseLimitError('clients', 'Your licence does not include additional clients on this installation. '
                                               'Ask your vendor to upgrade the plan.')
        raise LicenseLimitError('clients', f'Your licence allows {limit} client{plural} on this installation '
                                           f'and {used} {"is" if used == 1 else "are"} in use. '
                                           'Upgrade the licence to add more.')


def client_summary():
    """Licence status + client usage for the Local Super Admin console."""
    v = state.current()
    limit = _limit(v, 'clients')
    return {'status': v.status, 'read_only': v.read_only, 'message': v.message, 'edition': v.edition,
            'valid_until': v.valid_until, 'days_left': v.days_left,
            'clients_used': len(_client_org_ids()), 'clients_limit': int(limit) if limit is not None else None,
            'limits': dict(v.limits or {}), 'platform_owner': bool(getattr(v, 'platform_owner', False))}


def company_limit(org, fallback):
    v = state.current()
    _refuse_if_read_only(v)
    if 'companies' in (getattr(v, 'unlimited', None) or []):
        return UNLIMITED_COMPANIES
    limit = _limit(v, 'companies')
    return int(limit) if limit else fallback


def check_branches(tenant, adding=1):
    v = state.current()
    _refuse_if_read_only(v)
    from apps.common import tenancy
    from apps.company.models import Branch
    per_company = _limit(v, 'branches_per_company')
    total = _limit(v, 'branches_total')
    with tenancy.unscoped():
        if per_company:
            used = Branch.objects.filter(tenant=tenant, is_active=True).count()
            if used + adding > int(per_company):
                raise LicenseLimitError('branches', f'Your licence allows {per_company} active branches per company '
                                                    f'({used} in use).')
        if total:
            used = Branch.objects.filter(tenant__in=_org_tenants(tenant=tenant), is_active=True).count()
            if used + adding > int(total):
                raise LicenseLimitError('branches', f'Your licence allows {total} active branches in total ({used} in use).')


def filter_settings_features(features):
    """Settings sections: licence ∩ company. None (= every section) from both sides stays None."""
    v = state.current()
    licensed = getattr(v, 'settings_features', None)
    if licensed is None:
        return features
    if features is None:
        return list(licensed)
    return [f for f in features if f in set(licensed)]


def filter_modules(modules):
    """Licence modules ∩ the company's modules. The licence wins; no licence list = no restriction."""
    v = state.current()
    if v.modules is None:
        return list(modules)
    allowed = set(v.modules)
    return [m for m in modules if m in allowed]


def update_allowed(release_date_iso: str) -> tuple[bool, str]:
    """Update entitlement: a release dated after updates_until needs a renewed licence."""
    v = state.current(force=True)
    if v.status in ('EVALUATION',):
        return True, 'evaluation'
    if v.status in ('INVALID', 'EVALUATION_ENDED'):
        return False, v.message
    if not v.updates_until:
        return True, 'no update limit'
    from .state import _parse
    if _parse(release_date_iso) <= _parse(v.updates_until):
        return True, f'entitled until {v.updates_until}'
    return False, (f'This release ({release_date_iso[:10]}) is newer than your update entitlement '
                   f'({v.updates_until[:10]}). Your current version keeps working; renew to update.')
