"""Create Client (Cloud Edition) with a plan: the client's workspace is created with the plan's
terms and its licence is issued in the same transaction (superadmin_views.TenantAdminViewSet.create)."""

from django.utils import timezone

from . import service, tokens
from .models import LicensePlan

# Tenant subscription_plan for the onboarding serializer (re-applied exactly by apply_to_tenant).
_SERIALIZER_PLAN = {tokens.MONTHLY: 'MONTHLY', tokens.YEARLY: 'ANNUAL', tokens.LIFETIME: 'PERPETUAL'}


def prepare(data):
    """(request data with the plan's terms filled in, plan, starts_on). Raises LicenceError."""
    from rest_framework.fields import DateField
    plan = LicensePlan.objects.filter(pk=str(data.get('licence_plan_id') or '')).first() if _uuidish(
        data.get('licence_plan_id')) else None
    if plan is None:
        raise service.LicenceError('Choose a licence plan.', field='licence_plan_id')
    service._check_plan_for(plan, tokens.CLOUD)
    service._require_signing()
    raw_start = data.get('licence_starts_on') or data.get('subscription_starts_on')
    try:
        starts_on = DateField().to_internal_value(raw_start) if raw_start else timezone.localdate()
    except Exception:
        raise service.LicenceError('Enter a valid licence start date.', field='licence_starts_on')
    expires_on = tokens.compute_expiry(plan.billing_cycle, plan.duration, starts_on)
    out = data.copy() if hasattr(data, 'copy') else dict(data)
    if hasattr(out, 'dict'):
        out = out.dict()
    users = plan.max_users
    out.update({
        'package': 'CUSTOM', 'modules': list(plan.modules or []),
        'settings_features': plan.settings_features if 'settings' in (plan.modules or []) else None,
        'max_users': min(users, 10000) if users is not None else 10000,
        'max_branches': plan.max_branches,
        'subscription_plan': _SERIALIZER_PLAN[plan.billing_cycle],
        'subscription_starts_on': starts_on.isoformat(),
        'subscription_expires_on': expires_on.isoformat() if expires_on else None,
    })
    if 'settings' not in (plan.modules or []):
        out.pop('settings_features', None)
    return out, plan, starts_on


def issue_for_new_tenant(tenant, plan, starts_on, actor, ip=''):
    client = service.client_for_tenant(tenant, actor)
    return service.issue(client=client, plan=plan, starts_on=starts_on, actor=actor, ip=ip)


def _uuidish(value):
    import uuid
    try:
        uuid.UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False


# ---- Windows Local Super Admin: Hosted Workspaces → New client → Subscription (step 5) ----------------

def prepare_local(data):
    """(request data with the workspace subscription fields filled from the plan, plan, starts_on,
    installation). The client / company / branch / admin details are the wizard's own; only the
    subscription is added. Raises LicenceError."""
    from rest_framework.fields import DateField
    plan = LicensePlan.objects.filter(pk=str(data.get('licence_plan_id') or '')).first() if _uuidish(
        data.get('licence_plan_id')) else None
    if plan is None:
        raise service.LicenceError('Choose the subscription plan.', field='licence_plan_id')
    service._check_plan_for(plan, tokens.WINDOWS_LOCAL)
    service._require_signing()
    raw_start = data.get('licence_starts_on') or data.get('subscription_starts_on')
    try:
        starts_on = DateField().to_internal_value(raw_start) if raw_start else timezone.localdate()
    except Exception:
        raise service.LicenceError('Enter a valid subscription start date.', field='licence_starts_on')
    try:
        install = tokens.parse_installation(str(data.get('installation') or ''))
    except ValueError as exc:
        raise service.LicenceError(str(exc), field='installation')
    expires_on = tokens.compute_expiry(plan.billing_cycle, plan.duration, starts_on)
    out = data.copy() if hasattr(data, 'copy') else dict(data)
    if hasattr(out, 'dict'):
        out = out.dict()
    lifetime = expires_on is None
    out.update({
        'subscription_plan': 'PERPETUAL' if lifetime else service.TENANT_PLAN.get(
            (plan.billing_cycle, plan.duration), 'MONTHLY' if plan.billing_cycle == tokens.MONTHLY else 'ANNUAL'),
        'subscription_starts_on': starts_on.isoformat(),
        'subscription_expires_on': expires_on.isoformat() if expires_on else None,
    })
    return out, plan, starts_on, install


def issue_for_hosted_tenant(tenant, plan, starts_on, install, actor, ip=''):
    """The new workspace's first subscription: its Subscription ID (lic_id) is created now; the key is
    signed for the customer's Installation ID when one was given, otherwise later (Bind installation)."""
    client = service.client_for_tenant(tenant, actor)
    return service.issue(client=client, plan=plan, starts_on=starts_on, actor=actor, ip=ip,
                         install=install if install.get('install_id') else None,
                         overrides=service.hosted_terms(tenant))
