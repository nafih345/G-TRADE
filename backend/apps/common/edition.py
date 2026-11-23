"""Which edition this process is: the hosted cloud app or the Windows local edition.

Shared code calls these helpers instead of reading settings directly, so the cloud path stays a
no-op: ``is_local()`` is False unless ``config.settings_local`` is in use.
"""

from __future__ import annotations

import json
import threading
from contextlib import contextmanager
from pathlib import Path

from django.conf import settings


def is_local() -> bool:
    return getattr(settings, 'GTRADE_EDITION', 'cloud') == 'local'


# Software (vendor) product names. Customer business names come from the Store & Clinic Profile and
# are never taken from here. Internal identifiers (backup format id, G-TRADE folders/services) are
# deliberately not derived from these, so renaming the product never breaks compatibility.
LOCAL_PRODUCT_NAME = 'G OPTICALS'
CLOUD_PRODUCT_NAME = 'Greensol Optical ERP'


def product_name() -> str:
    return LOCAL_PRODUCT_NAME if is_local() else CLOUD_PRODUCT_NAME


def product_file_prefix() -> str:
    """Filename-safe product prefix for downloads (backups)."""
    return 'G-OPTICALS' if is_local() else 'GreensolERP'


def data_root() -> Path | None:
    root = getattr(settings, 'DATA_ROOT', None)
    return Path(root) if root else None


def maintenance_flag() -> Path | None:
    root = data_root()
    return root / 'run' / 'maintenance.flag' if root else None


def maintenance_reason() -> str | None:
    """Text of the maintenance flag written by gtrade-ctl during updates/restores, or None."""
    flag = maintenance_flag()
    if flag is None or not flag.exists():
        return None
    try:
        return json.loads(flag.read_text(encoding='utf-8')).get('reason') or 'maintenance'
    except Exception:
        return 'maintenance'


def local_health_extras() -> dict:
    """Additional, non-secret health facts for the local edition (filled in by later phases)."""
    out = {'maintenance': maintenance_reason()}
    for hook in _HEALTH_HOOKS:
        try:
            out.update(hook())
        except Exception as exc:  # a broken hook must not break /api/health/
            out[f'{getattr(hook, "__name__", "hook")}_error'] = type(exc).__name__
    return out


_HEALTH_HOOKS = []


def register_health_hook(fn):
    """Local-edition apps (licensing, backups) add their status to /api/health/ through this."""
    if fn not in _HEALTH_HOOKS:
        _HEALTH_HOOKS.append(fn)
    return fn


class LocalEditionGuardError(Exception):
    pass


_client_onboarding = threading.local()


@contextmanager
def client_onboarding():
    """The ONE path allowed to add another organization (client) to a Windows installation: the
    Local Super Admin's Client Management (tenant_onboarding.onboard_tenant). Everything else that
    would create an organization (a stray ensure_organization, a script) is still refused."""
    depth = getattr(_client_onboarding, 'depth', 0)
    _client_onboarding.depth = depth + 1
    try:
        yield
    finally:
        _client_onboarding.depth = depth


def _one_organization(sender, instance, **kwargs):
    """A Windows installation belongs to one owner organization. Additional organizations are
    separate clients, created only by the Local Super Admin through Client Management (inside
    client_onboarding(), licence-checked); any other path would put a second customer's data in
    the database behind the owner's back (Phase 2 gap G8)."""
    if instance.pk is None and sender.objects.exists() and not getattr(_client_onboarding, 'depth', 0):
        raise LocalEditionGuardError('This G-TRADE installation already belongs to an organization; '
                                     'additional clients are created by the Local Super Admin in Client Management.')


INSTALLATION_ADMIN_ROLES = ('SUPER_ADMIN', 'ADMINISTRATOR')


def installation_admin(user) -> bool:
    """May this person manage the INSTALLATION itself (licence, server backups)?

    * the Local Super Admin (platform owner: superuser in tenant #1), or
    * an owner / administrator whose home company belongs to the installation owner's organization
      (the organization of tenant #1).

    A client company's administrator (another organization, created in Client Management) never
    qualifies: the licence and the server backups cover every client on this server. With a single
    organization this is exactly the previous rule (any owner / administrator)."""
    from apps.common.organizations import real_user, tenant_org_id
    from apps.common.permissions import is_platform_owner
    from apps.common.tenancy import DEFAULT_TENANT_ID
    user = real_user(user) if user is not None and getattr(user, 'is_authenticated', False) else None
    if user is None or not user.is_active:
        return False
    if is_platform_owner(user):
        return True
    if getattr(user, 'role', '') not in INSTALLATION_ADMIN_ROLES or not user.tenant_id:
        return False
    if user.tenant_id == DEFAULT_TENANT_ID:
        return True
    home_org = tenant_org_id(DEFAULT_TENANT_ID)
    return home_org is not None and tenant_org_id(user.tenant_id) == home_org


def install_local_guards():
    if not is_local():
        return
    from django.db.models.signals import pre_save
    from .models import Organization
    pre_save.connect(_one_organization, sender=Organization, dispatch_uid='edition:one_organization')


# ---- licence hooks (local edition). Each is a no-op on the cloud. ---------------------------------
def license_check(kind, **kw):
    """Raise apps.licensing.enforcement.LicenseLimitError when the licence forbids the change."""
    if not is_local():
        return
    from apps.licensing import enforcement
    {'users': enforcement.check_users, 'branches': enforcement.check_branches,
     'clients': enforcement.check_clients}[kind](**kw)


def license_summary():
    """Licence facts for the Local Super Admin console ({} on the cloud)."""
    if not is_local():
        return {}
    from apps.licensing import enforcement
    return enforcement.client_summary()


def licensed_company_limit(org, fallback):
    if not is_local():
        return fallback
    from apps.licensing import enforcement
    return enforcement.company_limit(org, fallback)


def licensed_modules(modules):
    if not is_local():
        return modules
    from apps.licensing import enforcement
    return enforcement.filter_modules(modules)


def licensed_settings_features(features):
    """Settings sections the licence allows (None = every section). No-op on the cloud."""
    if not is_local():
        return features
    from apps.licensing import enforcement
    return enforcement.filter_settings_features(features)
