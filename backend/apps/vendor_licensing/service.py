"""Licence authority operations: plans, clients, issuing, renewal, plan changes, suspension,
revocation, replacement keys, online activation / check-in and the signed revocation list.

Rules
* Every change that affects what a customer may do re-signs the licence (`_sign`): revision + 1,
  new key, a LicenseIssuance row. Status changes are signed too, so a Windows installation applies
  a suspension / revocation the next time it checks in, with the vendor's signature on it.
* Every action writes a LicenseAuditEvent (and, for a cloud client, a TenantAuditLog row).
* Lower limits never delete or deactivate anything: enforcement only refuses NEW users, branches,
  companies or clients above the limit. The preview lists what is already above the new limit.
* Cloud licences drive the client's existing subscription fields (expiry, seats, branches,
  modules, companies), so the cloud backend keeps enforcing them exactly as before.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import secrets

from django.db import IntegrityError, transaction
from django.utils import timezone

from apps.common import module_access

from . import signing, tokens
from .models import ClientLicense, LicenseAuditEvent, LicensedClient, LicenseIssuance, LicensePlan

# Cloud seats are a required number on Tenant; an explicitly unlimited plan stores this ceiling.
UNLIMITED_SEATS = 100000
UNLIMITED_COMPANIES = 1000
LIMIT_LABELS = {'clients': 'Clients', 'companies': 'Companies', 'branches': 'Branches',
                'branches_per_company': 'Branches per company', 'users': 'Named users'}
TIERS = ('STANDARD', 'PROFESSIONAL', 'ENTERPRISE')
TENANT_PLAN = {(tokens.MONTHLY, 1): 'MONTHLY', (tokens.MONTHLY, 3): 'QUARTERLY', (tokens.MONTHLY, 6): 'HALF_YEARLY',
               (tokens.YEARLY, 1): 'ANNUAL'}
LICENCE_DEACTIVATION = ('LICENCE_SUSPENDED', 'LICENCE_REVOKED')


class LicenceError(Exception):
    def __init__(self, message, field=None, code='invalid', status=400):
        super().__init__(message)
        self.message, self.field, self.code, self.status = message, field, code, status


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode('ascii')).hexdigest()


def audit(action, actor='', *, licence=None, plan=None, client=None, reason='', ip='', **details):
    LicenseAuditEvent.objects.create(action=action, actor=str(actor or '')[:150], reason=reason or '',
                                     licence=licence, plan=plan, client=client or (licence.client if licence else None),
                                     details=_jsonable(details), ip=(ip or '')[:64])
    tenant = (client or (licence.client if licence else None))
    tenant = getattr(tenant, 'tenant', None)
    if tenant is not None:
        from apps.common.tenant_onboarding import log_event
        log_event(tenant, action[:40], actor, reason=reason or '',
                  **_jsonable({'lic_id': licence.lic_id if licence else None, **details}))


def _jsonable(value):
    if isinstance(value, dict):
        return {k: _jsonable(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_jsonable(v) for v in value]
    if isinstance(value, (dt.date, dt.datetime)):
        return value.isoformat()
    return value


def _actor(user):
    return getattr(user, 'username', None) or str(user or '')


# ---- plans ----------------------------------------------------------------------------------------

def clean_plan_modules(modules, settings_features):
    try:
        _package, mods = module_access.normalize_modules(module_access.CUSTOM, list(modules or []))
        features = module_access.normalize_settings_features(settings_features)
    except ValueError as exc:
        raise LicenceError(str(exc), field='modules')
    if 'settings' not in mods:
        features = None
    return mods, features


# ---- clients --------------------------------------------------------------------------------------

def _new_client_code():
    n = LicensedClient.objects.count() + 1
    while LicensedClient.objects.filter(client_code=f'CL-{n:06d}').exists():
        n += 1
    return f'CL-{n:06d}'


def create_client(*, edition, name, actor, tenant=None, owner_name='', email='', phone='', country='', address=''):
    name = (name or '').strip()
    if not name:
        raise LicenceError('Enter the client name.', field='name')
    for _ in range(5):
        try:
            with transaction.atomic():
                client = LicensedClient.objects.create(
                    client_code=_new_client_code(), name=name[:150], owner_name=(owner_name or '')[:150],
                    email=email or '', phone=(phone or '')[:20], country=(country or '')[:2].upper(),
                    address=address or '', edition=edition, tenant=tenant, created_by=_actor(actor))
            break
        except IntegrityError:
            if tenant is not None and LicensedClient.objects.filter(tenant=tenant).exists():
                return LicensedClient.objects.get(tenant=tenant)
            continue
    else:  # pragma: no cover - five simultaneous creations
        raise LicenceError('Could not allocate a client number; try again.')
    audit('CLIENT_CREATED', _actor(actor), client=client, edition=edition, client_code=client.client_code)
    return client


def client_for_tenant(tenant, actor):
    """The licensing record of a client workspace (created the first time it gets a subscription):
    Cloud Edition on the cloud console; on the Windows Local Super Admin's installation a Hosted
    Workspace client, whose subscription is a Windows Local licence (signed key, bound to the
    customer's Installation ID). One record per workspace (LicensedClient.tenant is one-to-one)."""
    existing = LicensedClient.objects.filter(tenant=tenant).first()
    if existing:
        return existing
    return create_client(edition=tokens.WINDOWS_LOCAL if local_edition() else tokens.CLOUD, name=tenant.name,
                         actor=actor, tenant=tenant,
                         owner_name=tenant.owner_name, email=tenant.contact_email, phone=tenant.contact_phone,
                         country=tenant.country, address=tenant.address)


# ---- signing --------------------------------------------------------------------------------------

def _new_lic_id():
    year = timezone.localdate().year
    for _ in range(20):
        lic_id = f'GOL-{year}-{secrets.token_hex(4).upper()}'
        if not ClientLicense.objects.filter(lic_id=lic_id).exists():
            return lic_id
    raise LicenceError('Could not allocate a licence ID; try again.')  # pragma: no cover


def payload_for(lic: ClientLicense, issued_at) -> dict:
    snap = lic.plan_snapshot or {}
    return tokens.build_payload(
        lic_id=lic.lic_id, rev=lic.revision, issued_at=issued_at, client_id=lic.client.client_code,
        client_name=lic.client.name, edition=lic.edition, plan_code=snap.get('code', ''),
        plan_name=snap.get('name', ''), cycle=lic.billing_cycle, duration=lic.duration, starts_on=lic.starts_on,
        expires_on=lic.expires_on, limits=lic.limits, modules=lic.modules, settings_features=lic.settings_features,
        status=lic.status, status_reason=lic.status_reason if lic.status != tokens.ACTIVE else '',
        install_id=lic.install_id, fp_hashes=lic.install_fp or None, grace_days=lic.grace_days,
        tenant_id=lic.client.tenant_id if lic.edition == tokens.CLOUD else None, tier=snap.get('tier', ''))


def _sign(lic: ClientLicense, reason: str, actor, *, new=False):
    """(Re-)sign the licence: next revision, new key, issuance history. Raises SigningKeyError
    before anything is saved when signing is not configured."""
    if not new:
        lic.revision += 1
    issued_at = timezone.now()
    token = signing.sign_token(payload_for(lic, issued_at))
    lic.key_token, lic.key_hash, lic.key_id, lic.issued_at = token, token_hash(token), signing.key_id(), issued_at
    lic.save()
    LicenseIssuance.objects.create(licence=lic, revision=lic.revision, reason=reason, token_hash=lic.key_hash,
                                   key_id=lic.key_id, status=lic.status, starts_on=lic.starts_on,
                                   expires_on=lic.expires_on, install_id=lic.install_id, issued_at=issued_at,
                                   issued_by=_actor(actor))
    return lic


def _require_signing():
    try:
        signing.key_id()
    except signing.SigningKeyError as exc:
        raise LicenceError(str(exc), code='signing_unavailable', status=503)


# ---- terms / preview ------------------------------------------------------------------------------

def terms_from_plan(plan: LicensePlan, starts_on: dt.date) -> dict:
    expires_on = tokens.compute_expiry(plan.billing_cycle, plan.duration, starts_on)
    return {'plan': {'id': str(plan.pk), 'code': plan.code, 'name': plan.name}, 'edition': plan.edition,
            'billing_cycle': plan.billing_cycle, 'duration': plan.duration, 'starts_on': starts_on,
            'expires_on': expires_on, 'lifetime': expires_on is None, 'limits': plan.limits(),
            'modules': list(plan.modules or []), 'settings_features': plan.settings_features,
            'grace_days': plan.grace_days, 'price': str(plan.price), 'currency': plan.currency}


def terms_of(lic: ClientLicense) -> dict:
    snap = lic.plan_snapshot or {}
    return {'plan': {'id': str(lic.plan_id), 'code': snap.get('code', ''), 'name': snap.get('name', '')},
            'edition': lic.edition, 'billing_cycle': lic.billing_cycle, 'duration': lic.duration,
            'starts_on': lic.starts_on, 'expires_on': lic.expires_on, 'lifetime': lic.is_lifetime,
            'limits': dict(lic.limits or {}), 'modules': list(lic.modules or []),
            'settings_features': lic.settings_features, 'grace_days': lic.grace_days,
            'price': snap.get('price'), 'currency': snap.get('currency'),
            'tier': snap.get('tier', ''), 'custom': bool(snap.get('custom'))}


def _cap(value):
    return float('inf') if value is None else int(value)


def diff_terms(old: dict, new: dict) -> list:
    out = []
    if old['plan']['id'] != new['plan']['id']:
        out.append({'field': 'plan', 'label': 'Plan', 'from': old['plan']['name'], 'to': new['plan']['name'],
                    'direction': 'change'})
    if (old['billing_cycle'], old['duration']) != (new['billing_cycle'], new['duration']):
        out.append({'field': 'billing_cycle', 'label': 'Billing', 'from': _cycle_text(old), 'to': _cycle_text(new),
                    'direction': 'change'})
    if old['expires_on'] != new['expires_on']:
        if new['expires_on'] is None:
            direction = 'increase'
        elif old['expires_on'] is None:
            direction = 'decrease'
        else:
            direction = 'increase' if new['expires_on'] > old['expires_on'] else 'decrease'
        out.append({'field': 'expires_on', 'label': 'Expiry date', 'from': old['expires_on'] or 'Lifetime',
                    'to': new['expires_on'] or 'Lifetime', 'direction': direction})
    for key, label in LIMIT_LABELS.items():
        a, b = (old['limits'] or {}).get(key), (new['limits'] or {}).get(key)
        if a != b:
            out.append({'field': f'limits.{key}', 'label': label, 'from': 'Unlimited' if a is None else a,
                        'to': 'Unlimited' if b is None else b,
                        'direction': 'increase' if _cap(b) > _cap(a) else 'decrease'})
    added = [m for m in new['modules'] if m not in old['modules']]
    removed = [m for m in old['modules'] if m not in new['modules']]
    if added:
        out.append({'field': 'modules', 'label': 'Modules added', 'from': None, 'to': added, 'direction': 'increase'})
    if removed:
        out.append({'field': 'modules', 'label': 'Modules removed', 'from': removed, 'to': None, 'direction': 'decrease'})
    if (old.get('tier') or '') != (new.get('tier') or ''):
        out.append({'field': 'tier', 'label': 'Edition', 'from': old.get('tier') or 'Standard',
                    'to': new.get('tier') or 'Standard', 'direction': 'change'})
    if old['settings_features'] != new['settings_features']:
        out.append({'field': 'settings_features', 'label': 'Settings sections',
                    'from': old['settings_features'] or 'All', 'to': new['settings_features'] or 'All',
                    'direction': 'change'})
    return out


def _cycle_text(t):
    if t['billing_cycle'] == tokens.LIFETIME:
        return 'Lifetime'
    unit = 'month' if t['billing_cycle'] == tokens.MONTHLY else 'year'
    return f"{t['duration']} {unit}{'s' if t['duration'] != 1 else ''}"


def usage_for(lic: ClientLicense) -> dict:
    """What a cloud client uses today (a Windows installation reports nothing to the vendor)."""
    tenant = lic.client.tenant if lic.edition == tokens.CLOUD else None
    if tenant is None:
        return {}
    from apps.common import tenancy
    from apps.common.models import Tenant
    from apps.company.models import Branch
    from django.contrib.auth import get_user_model
    with tenancy.unscoped():
        users = get_user_model().objects.filter(tenant=tenant, is_active=True).count()
        branches = Branch.objects.filter(tenant=tenant, is_active=True).count()
        companies = Tenant.objects.filter(organization_id=tenant.organization_id).count() if tenant.organization_id else 1
    return {'users': users, 'branches': branches, 'companies': companies}


def over_limit_warnings(limits: dict, usage: dict) -> list:
    out = []
    for key, used in usage.items():
        cap = (limits or {}).get(key)
        if cap is not None and used > int(cap):
            out.append(f'{LIMIT_LABELS[key]}: {used} in use, the new limit is {cap}. Nothing is removed or '
                       f'deactivated; new {LIMIT_LABELS[key].lower()} are refused until usage is within the limit.')
    return out


def _classify(changes) -> str:
    dirs = {c['direction'] for c in changes if c['field'] not in ('plan', 'billing_cycle', 'settings_features', 'tier')}
    if 'decrease' in dirs:
        return 'DOWNGRADE'
    if 'increase' in dirs:
        return 'UPGRADE'
    return 'CHANGE'


# ---- issue / renew / change -----------------------------------------------------------------------

def _check_plan_for(plan: LicensePlan, edition: str):
    if not plan.is_active:
        raise LicenceError(f'The plan "{plan.name}" is deactivated. Activate it or choose another plan.', field='plan_id')
    if plan.edition != edition:
        raise LicenceError(f'"{plan.name}" is a {plan.get_edition_display()} plan; this client uses the '
                           f'{dict(tokens.EDITIONS)[edition]}.', field='plan_id')


def apply_overrides(terms: dict, overrides: dict | None) -> dict:
    """This customer's own terms on top of the plan's defaults (Windows Local Super Admin: every
    customer can have different users / companies / branches / modules / expiry). Keys:
    expires_on (date; lifetime plans stay lifetime), limits {name: int | None (unlimited)}, modules,
    settings_features, tier. Raises LicenceError."""
    if not overrides:
        return terms
    out = {**terms, 'limits': dict(terms['limits'] or {})}
    if 'limits' in overrides:
        for key, value in (overrides.get('limits') or {}).items():
            if key not in LIMIT_LABELS:
                raise LicenceError(f'Unknown limit "{key}".', field='limits')
            if value in (None, ''):
                out['limits'][key] = None
                continue
            try:
                value = int(value)
            except (TypeError, ValueError):
                raise LicenceError(f'{LIMIT_LABELS[key]}: enter a whole number, or leave it empty for unlimited.',
                                   field='limits')
            if value < 0 or value > 100000:
                raise LicenceError(f'{LIMIT_LABELS[key]}: enter 0 to 100000.', field='limits')
            out['limits'][key] = value
    if 'modules' in overrides:
        out['modules'], out['settings_features'] = clean_plan_modules(
            overrides.get('modules'), overrides.get('settings_features', terms.get('settings_features')))
    elif 'settings_features' in overrides:
        out['modules'], out['settings_features'] = clean_plan_modules(terms['modules'], overrides['settings_features'])
    if overrides.get('expires_on'):
        if terms['billing_cycle'] == tokens.LIFETIME:
            raise LicenceError('A lifetime plan has no expiry date.', field='expires_on')
        expires = overrides['expires_on']
        if isinstance(expires, str):
            try:
                expires = dt.date.fromisoformat(expires)
            except ValueError:
                raise LicenceError('Enter a valid expiry date.', field='expires_on')
        if expires < terms['starts_on']:
            raise LicenceError('The expiry date is before the start date.', field='expires_on')
        out['expires_on'] = expires
    if 'tier' in overrides:
        tier = str(overrides.get('tier') or '').upper()
        if tier and tier not in TIERS:
            raise LicenceError(f'Edition must be one of {", ".join(TIERS)}.', field='tier')
        out['tier'] = tier
    out['custom'] = True
    return out


def _snapshot(plan: LicensePlan, terms: dict) -> dict:
    snap = plan.snapshot()
    if terms.get('custom'):
        snap['custom'] = True
    if terms.get('tier'):
        snap['tier'] = terms['tier']
    return snap


def issue(*, client: LicensedClient, plan: LicensePlan, starts_on: dt.date, actor, install=None, ip='',
          overrides=None) -> ClientLicense:
    _check_plan_for(plan, client.edition)
    _require_signing()
    install = install or {}
    if client.edition == tokens.CLOUD:
        if client.tenant_id is None:
            raise LicenceError('A Cloud Edition licence belongs to a cloud workspace. Create the client in Client '
                               'Management (New client → Cloud Edition).', field='client')
        if client.licences.exclude(status=tokens.REVOKED).exists():
            raise LicenceError('This cloud client already has a licence. Renew it or change its plan instead.',
                               field='client', code='licence_exists')
        install = {}
    terms = apply_overrides(terms_from_plan(plan, starts_on), overrides if client.edition != tokens.CLOUD else None)
    lic = ClientLicense(lic_id=_new_lic_id(), client=client, plan=plan, plan_snapshot=_snapshot(plan, terms),
                        edition=plan.edition, billing_cycle=plan.billing_cycle, duration=plan.duration,
                        starts_on=starts_on, expires_on=terms['expires_on'], limits=dict(terms['limits']),
                        modules=list(terms['modules'] or []), settings_features=terms['settings_features'],
                        grace_days=plan.grace_days, install_id=install.get('install_id', ''),
                        install_fp=install.get('fp') or {}, created_by=_actor(actor))
    with transaction.atomic():
        _sign(lic, 'CREATED', actor, new=True)
        audit('LICENCE_CREATED', _actor(actor), licence=lic, ip=ip, plan_code=plan.code, edition=plan.edition,
              starts_on=lic.starts_on, expires_on=lic.expires_on, install_id=lic.install_id,
              custom_terms=bool(terms.get('custom')), limits=lic.limits, modules=lic.modules)
        if lic.edition == tokens.CLOUD:
            apply_to_tenant(lic, actor)
        else:
            sync_hosted_tenant(lic.client, actor)
    return lic


def _editable(lic: ClientLicense):
    if lic.status == tokens.REVOKED:
        raise LicenceError('This licence was revoked. Revocation is permanent; issue a new licence instead.',
                           code='revoked')


def renew(lic: ClientLicense, *, periods=1, actor, confirm=False, reason='', ip='', overrides=None):
    _editable(lic)
    if lic.is_lifetime:
        raise LicenceError('A lifetime licence never expires, so it cannot be renewed.', code='lifetime')
    try:
        periods = int(periods or 1)
    except (TypeError, ValueError):
        periods = 0
    if not 1 <= periods <= 36:
        raise LicenceError('Renew for 1 to 36 periods.', field='periods')
    plan = lic.plan
    custom = bool((lic.plan_snapshot or {}).get('custom'))
    # A customer with their own terms keeps them on renewal (unless changed now); a plain plan
    # licence takes the plan's current terms, as before.
    new = dict(terms_of(lic)) if custom else terms_from_plan(plan, lic.starts_on)
    new['plan'] = {'id': str(plan.pk), 'code': plan.code, 'name': plan.name}
    new['tier'] = (lic.plan_snapshot or {}).get('tier', '')
    new['custom'] = custom
    new['billing_cycle'], new['duration'] = plan.billing_cycle, plan.duration
    new['expires_on'] = tokens.extend_expiry(plan.billing_cycle, plan.duration, lic.expires_on,
                                             timezone.localdate(), periods)
    new['lifetime'] = False
    if overrides and lic.edition != tokens.CLOUD:
        new = apply_overrides(new, overrides)
    return _apply_change(lic, new, 'RENEWED', actor=actor, confirm=confirm, reason=reason, ip=ip,
                         extra={'periods': periods})


def change_plan(lic: ClientLicense, plan: LicensePlan, *, actor, restart_period=False, confirm=False, reason='', ip=''):
    _editable(lic)
    _check_plan_for(plan, lic.edition)
    if plan.pk == lic.plan_id:
        raise LicenceError('The licence is already on this plan. Use Renew to extend it.', field='plan_id')
    today = timezone.localdate()
    new = terms_from_plan(plan, lic.starts_on)
    if plan.billing_cycle == tokens.LIFETIME:
        new['expires_on'] = None
    elif restart_period or lic.is_lifetime or not lic.expires_on or lic.expires_on < today:
        # A new period starts today (or the old one has lapsed / had no end).
        new['expires_on'] = tokens.compute_expiry(plan.billing_cycle, plan.duration, today)
    else:
        new['expires_on'] = lic.expires_on  # the paid period is kept
    new['lifetime'] = new['expires_on'] is None
    return _apply_change(lic, new, 'PLAN_CHANGED', actor=actor, confirm=confirm, reason=reason, ip=ip,
                         plan=plan, extra={'restart_period': bool(restart_period)})


def _apply_change(lic, new, kind, *, actor, confirm, reason, ip, plan=None, extra=None):
    old = terms_of(lic)
    changes = diff_terms(old, new)
    usage = usage_for(lic)
    preview = {'kind': kind, 'classification': _classify(changes) if kind == 'PLAN_CHANGED' else kind,
               'current': _jsonable(old), 'proposed': _jsonable(new), 'changes': _jsonable(changes),
               'usage': usage, 'warnings': over_limit_warnings(new['limits'], usage),
               'requires_confirmation': True}
    if lic.status == tokens.SUSPENDED:
        preview['warnings'].append('The licence stays suspended; reactivate it separately.')
    if not confirm:
        return {'preview': preview}
    if not changes and kind == 'PLAN_CHANGED':
        raise LicenceError('Nothing would change.')
    _require_signing()
    with transaction.atomic():
        lic = ClientLicense.objects.select_for_update().get(pk=lic.pk)
        if plan is not None:
            lic.plan = plan
            lic.plan_snapshot = _snapshot(plan, new)
        else:
            lic.plan_snapshot = _snapshot(lic.plan, new)
        lic.billing_cycle, lic.duration = new['billing_cycle'], new['duration']
        lic.expires_on = new['expires_on']
        lic.limits, lic.modules = dict(new['limits']), list(new['modules'])
        lic.settings_features, lic.grace_days = new['settings_features'], new['grace_days']
        _sign(lic, kind, actor)
        action = kind if kind != 'PLAN_CHANGED' else {'UPGRADE': 'PLAN_UPGRADED', 'DOWNGRADE': 'PLAN_DOWNGRADED'}.get(
            preview['classification'], 'PLAN_CHANGED')
        audit(action, _actor(actor), licence=lic, reason=reason, ip=ip, changes=changes, revision=lic.revision,
              warnings=preview['warnings'], **(extra or {}))
        if lic.edition == tokens.CLOUD:
            apply_to_tenant(lic, actor)
        else:
            sync_hosted_tenant(lic.client, actor)
    return {'licence': lic, 'preview': preview}


# ---- status ---------------------------------------------------------------------------------------

def _reason(reason):
    reason = (reason or '').strip()
    if len(reason) < 3:
        raise LicenceError('Give a reason (it is kept in the audit history).', field='reason')
    return reason[:1000]


def suspend(lic, *, reason, actor, ip=''):
    reason = _reason(reason)
    _editable(lic)
    if lic.status == tokens.SUSPENDED:
        raise LicenceError('The licence is already suspended.')
    _require_signing()
    with transaction.atomic():
        lic.status, lic.status_reason = tokens.SUSPENDED, reason
        _sign(lic, 'SUSPENDED', actor)
        audit('LICENCE_SUSPENDED', _actor(actor), licence=lic, reason=reason, ip=ip, revision=lic.revision)
        if lic.edition == tokens.CLOUD:
            _block_tenant(lic, 'LICENCE_SUSPENDED', reason, actor)
        else:
            sync_hosted_tenant(lic.client, actor)
    return lic


def reactivate(lic, *, reason, actor, ip=''):
    reason = _reason(reason)
    _editable(lic)
    if lic.status != tokens.SUSPENDED:
        raise LicenceError('Only a suspended licence can be reactivated.')
    _require_signing()
    with transaction.atomic():
        lic.status, lic.status_reason = tokens.ACTIVE, ''
        _sign(lic, 'REACTIVATED', actor)
        audit('LICENCE_REACTIVATED', _actor(actor), licence=lic, reason=reason, ip=ip, revision=lic.revision)
        if lic.edition == tokens.CLOUD:
            _unblock_tenant(lic, reason, actor)
            apply_to_tenant(lic, actor)
        else:
            sync_hosted_tenant(lic.client, actor)
    return lic


def revoke(lic, *, reason, actor, confirm_lic_id='', ip=''):
    reason = _reason(reason)
    _editable(lic)
    if (confirm_lic_id or '').strip().upper() != lic.lic_id:
        raise LicenceError(f'Type the licence ID {lic.lic_id} to confirm the revocation.', field='confirm_lic_id')
    _require_signing()
    with transaction.atomic():
        lic.status, lic.status_reason, lic.revoked_at = tokens.REVOKED, reason, timezone.now()
        _sign(lic, 'REVOKED', actor)
        audit('LICENCE_REVOKED', _actor(actor), licence=lic, reason=reason, ip=ip, revision=lic.revision)
        if lic.edition == tokens.CLOUD:
            _block_tenant(lic, 'LICENCE_REVOKED', reason, actor)
        else:
            sync_hosted_tenant(lic.client, actor)
    return lic


def replace_key(lic, *, reason, actor, install=None, clear_binding=False, ip=''):
    """A new key for the same licence: lost key, leaked unbound key, or a move to another PC.
    Moving the binding voids every earlier revision for the old installation (signed CRL)."""
    reason = _reason(reason)
    _editable(lic)
    if lic.edition == tokens.CLOUD and (install or clear_binding):
        raise LicenceError('Cloud licences are not bound to an installation.')
    _require_signing()
    with transaction.atomic():
        lic = ClientLicense.objects.select_for_update().get(pk=lic.pk)
        old_install = lic.install_id
        if install and install.get('install_id'):
            lic.install_id, lic.install_fp = install['install_id'], install.get('fp') or {}
        elif clear_binding:
            lic.install_id, lic.install_fp = '', {}
        moved = bool(old_install) and lic.install_id != old_install
        if moved:
            lic.void_below_revision = lic.revision + 1
            lic.activated_at = lic.last_checkin_at = None
        _sign(lic, 'REPLACED', actor)
        audit('KEY_REPLACED', _actor(actor), licence=lic, reason=reason, ip=ip, revision=lic.revision,
              old_install_id=old_install, install_id=lic.install_id, moved=moved)
    return lic


def copy_key(lic, *, actor, ip=''):
    audit('KEY_COPIED', _actor(actor), licence=lic, ip=ip, revision=lic.revision)
    return lic.key_token


# ---- cloud workspace ------------------------------------------------------------------------------

def apply_to_tenant(lic: ClientLicense, actor):
    """Write the licence terms into the cloud client's subscription fields (which the cloud
    middleware, seat and branch checks and module gate already enforce)."""
    from apps.common import hot_cache
    from apps.common.models import Organization, Tenant
    tenant = Tenant.objects.select_for_update().get(pk=lic.client.tenant_id)
    limits = lic.limits or {}
    package, modules = module_access.normalize_modules(module_access.CUSTOM, list(lic.modules or []))
    wanted = {
        'subscription_plan': 'PERPETUAL' if lic.is_lifetime else TENANT_PLAN.get(
            (lic.billing_cycle, lic.duration), 'MONTHLY' if lic.billing_cycle == tokens.MONTHLY else 'ANNUAL'),
        'subscription_starts_on': lic.starts_on, 'subscription_expires_on': lic.expires_on,
        'max_users': UNLIMITED_SEATS if limits.get('users') is None else int(limits['users']),
        'max_branches': None if limits.get('branches') is None else int(limits['branches']),
        'package': package, 'modules': modules,
        'settings_features': lic.settings_features if 'settings' in modules else None,
    }
    changes = {}
    for field, value in wanted.items():
        if getattr(tenant, field) != value:
            changes[field] = {'from': getattr(tenant, field), 'to': value}
            setattr(tenant, field, value)
    if changes:
        tenant.save(update_fields=list(changes))
    if tenant.organization_id:
        cap = UNLIMITED_COMPANIES if limits.get('companies') is None else max(1, int(limits['companies']))
        org = Organization.objects.get(pk=tenant.organization_id)
        if org.max_companies != cap:
            changes['max_companies'] = {'from': org.max_companies, 'to': cap}
            Organization.objects.filter(pk=org.pk).update(max_companies=cap)
    if changes:
        from apps.common.tenant_onboarding import log_event
        log_event(tenant, 'LICENCE_APPLIED', _actor(actor), lic_id=lic.lic_id, revision=lic.revision,
                  changes=_jsonable(changes))
        hot_cache.clear()
    return changes


def _block_tenant(lic, category, reason, actor):
    from apps.common.models import Tenant
    tenant = Tenant.objects.select_for_update().get(pk=lic.client.tenant_id)
    if not tenant.is_active and tenant.deactivation_category not in LICENCE_DEACTIVATION:
        return  # already deactivated by hand: leave that record alone
    tenant.is_active = False
    tenant.deactivation_category = category
    tenant.deactivation_reason = f'Licence {lic.lic_id}: {reason}'
    tenant.deactivation_effective_date = timezone.localdate()
    tenant.deactivation_until = None
    tenant.deactivated_at = timezone.now()
    tenant.deactivated_by = _actor(actor)
    tenant.save()
    from apps.common.superadmin_views import _end_tenant_sessions
    _end_tenant_sessions(tenant)


def _unblock_tenant(lic, reason, actor):
    from apps.common.models import Tenant
    tenant = Tenant.objects.select_for_update().get(pk=lic.client.tenant_id)
    if tenant.is_active or tenant.deactivation_category != 'LICENCE_SUSPENDED':
        return
    tenant.is_active = True
    tenant.deactivation_category = tenant.deactivation_reason = tenant.deactivated_by = ''
    tenant.deactivation_effective_date = tenant.deactivation_until = tenant.deactivated_at = None
    tenant.save()


def tenant_licence(tenant) -> ClientLicense | None:
    """The cloud client's current (not revoked) licence, if it has one."""
    return (ClientLicense.objects.filter(client__tenant=tenant).exclude(status=tokens.REVOKED)
            .order_by('-created_at').first())


# ---- online authority (Windows installations) -----------------------------------------------------

def crl_token() -> str:
    revoked = []
    for row in ClientLicense.objects.filter(status=tokens.REVOKED).values('lic_id', 'status_reason', 'revoked_at'):
        revoked.append({'lic_id': row['lic_id'], 'reason': (row['status_reason'] or '')[:200],
                        'at': row['revoked_at'].isoformat() if row['revoked_at'] else None})
    for row in ClientLicense.objects.filter(void_below_revision__gt=0).exclude(status=tokens.REVOKED).values(
            'lic_id', 'void_below_revision'):
        revoked.append({'lic_id': row['lic_id'], 'below_rev': row['void_below_revision'],
                        'reason': 'The licence was moved to another installation.'})
    return signing.sign_crl({'issued_at': timezone.now().replace(microsecond=0).isoformat(), 'revoked': revoked})


def _fp(body):
    fp = ((body.get('fp') or {}).get('hashes')) or {}
    return fp if isinstance(fp, dict) and all(isinstance(v, str) for v in fp.values()) else {}


def activate_online(body: dict, ip='') -> tuple[int, dict]:
    """First activation of a key (binds an unbound licence to this installation) or re-activation
    on the same installation. The answer is the current signed licence for that installation."""
    from apps.licensing import licfmt
    key = licfmt.normalize_key(str(body.get('key') or ''))
    install_id = str(body.get('install_id') or '')[:64]
    fp = _fp(body)
    if not key or not install_id:
        return 400, {'error': 'A licence key and the installation ID are required.'}
    try:
        payload = signing.verify_token(key)
    except licfmt.LicenseFormatError as exc:
        return 400, {'error': f'This is not a valid G OPTICALS licence key ({exc}).'}
    except signing.SigningKeyError as exc:
        return 503, {'error': str(exc)}
    with transaction.atomic():
        lic = ClientLicense.objects.select_for_update().filter(lic_id=str(payload.get('lic_id') or '')).first()
        if lic is None:
            audit('ACTIVATION_REFUSED', 'installation', ip=ip, error='unknown licence', install_id=install_id)
            return 404, {'error': 'This licence is not known to the vendor.'}
        if lic.edition != tokens.WINDOWS_LOCAL:
            return 400, {'error': 'This is a Cloud Edition licence; it cannot activate a Windows installation.'}
        known = lic.issuances.filter(token_hash=token_hash(key)).exists()
        same_install = bool(lic.install_id) and lic.install_id == install_id

        def refuse(code, message, why):
            audit('ACTIVATION_REFUSED', 'installation', licence=lic, ip=ip, error=why, install_id=install_id)
            return code, {'error': message, 'crl': crl_token()}

        if not known:
            return refuse(400, 'This licence key was not issued by the vendor for this licence.', 'unknown key')
        if lic.status == tokens.REVOKED:
            return refuse(403, f'Licence {lic.lic_id} has been revoked by the vendor.', 'revoked')
        if lic.status == tokens.SUSPENDED:
            return refuse(403, f'Licence {lic.lic_id} is suspended by the vendor. Contact your vendor.', 'suspended')
        today = timezone.localdate()
        if lic.expires_on and lic.expires_on < today:
            return refuse(403, f'Licence {lic.lic_id} expired on {lic.expires_on.isoformat()}. Ask your vendor to renew it.',
                          'expired')
        if lic.starts_on > today + dt.timedelta(days=1):
            return refuse(403, f'Licence {lic.lic_id} starts on {lic.starts_on.isoformat()}.', 'not started')
        if lic.install_id and not same_install:
            return refuse(409, f'Licence {lic.lic_id} is already bound to another installation. Ask your vendor '
                               'for a replacement key to move it to this computer.', 'bound elsewhere')
        if not same_install and token_hash(key) != lic.key_hash:
            return refuse(409, 'This key was replaced by a newer key. Use the latest key from your vendor.', 'superseded')
        reason = 'ACTIVATION_BOUND' if not lic.install_id else 'REACTIVATED_SAME_INSTALL'
        if not lic.install_id or (fp and not lic.install_fp):
            lic.install_id = install_id
            lic.install_fp = fp or lic.install_fp
            _sign(lic, 'ACTIVATION_BOUND', 'installation')
        now = timezone.now()
        lic.activated_at = lic.activated_at or now
        lic.last_checkin_at = now
        lic.save(update_fields=['activated_at', 'last_checkin_at', 'updated_at'])
        audit('ACTIVATED', 'installation', licence=lic, ip=ip, install_id=install_id, revision=lic.revision,
              how=reason, app_version=str(body.get('app_version') or '')[:20])
    return 200, {'license': lic.key_token, 'crl': crl_token()}


def checkin_online(body: dict, ip='') -> tuple[int, dict]:
    """A bound installation asks for its current licence (renewals, plan changes, suspension and
    revocation all arrive this way, signed)."""
    lic_id = str(body.get('lic_id') or '')[:32]
    install_id = str(body.get('install_id') or '')[:64]
    with transaction.atomic():
        lic = ClientLicense.objects.select_for_update().filter(lic_id=lic_id).first()
        if lic is None or not install_id or lic.install_id != install_id:
            audit('CHECKIN_REFUSED', 'installation', licence=lic, ip=ip, install_id=install_id)
            return 404, {'error': 'This installation is not the one the licence is bound to.', 'crl': crl_token()}
        fp = _fp(body)
        if lic.install_fp and fp:
            changed = sum(1 for k, v in lic.install_fp.items() if fp.get(k) != v)
            if changed > 2:
                audit('CLONE_SUSPECTED', 'installation', licence=lic, ip=ip, changed=changed)
        lic.last_checkin_at = timezone.now()
        lic.activated_at = lic.activated_at or lic.last_checkin_at
        lic.save(update_fields=['last_checkin_at', 'activated_at', 'updated_at'])
        audit('CHECKIN', 'installation', licence=lic, ip=ip, revision=lic.revision)
    return 200, {'license': lic.key_token, 'crl': crl_token()}


# ---- Windows Local vendor installation ------------------------------------------------------------

def local_edition() -> bool:
    from django.conf import settings
    return getattr(settings, 'GTRADE_EDITION', '') == 'local'


# The standard subscriptions the Local Super Admin sells. Defaults only: every customer's users /
# companies / branches / modules are set when the licence is issued (apply_overrides). No grace
# days: the day after the expiry date the customer's installation is EXPIRED (read-only, data kept).
LOCAL_PLAN_PRESETS = (
    ('local-monthly', 'Monthly', tokens.MONTHLY, 1),
    ('local-quarterly', 'Quarterly', tokens.MONTHLY, 3),
    ('local-half-yearly', 'Half-Yearly', tokens.MONTHLY, 6),
    ('local-yearly', 'Yearly', tokens.YEARLY, 1),
    ('local-lifetime', 'Lifetime', tokens.LIFETIME, 1),
)


def ensure_local_plans(actor='system') -> list:
    """Create the missing standard Windows Local plans (never changes an existing plan)."""
    created = []
    modules = list(module_access.PACKAGE_MODULES[module_access.FULL_SUITE])
    for code, name, cycle, duration in LOCAL_PLAN_PRESETS:
        if LicensePlan.objects.filter(code=code).exists():
            continue
        plan = LicensePlan.objects.create(
            code=code, name=name, edition=tokens.WINDOWS_LOCAL, billing_cycle=cycle, duration=duration,
            description=f'{name} Windows Local subscription (limits and modules are set per customer).',
            max_clients=0, max_companies=1, max_branches=1, max_users=5, modules=modules,
            settings_features=None, grace_days=0, created_by=str(actor), updated_by=str(actor))
        audit('PLAN_CREATED', str(actor), plan=plan, preset=True)
        created.append(plan)
    return created


PLATFORM_OWNER_CLIENT = 'PLATFORM-OWNER'


def platform_owner_status() -> dict:
    """Can this installation issue its own permanent platform-owner licence?"""
    from django.conf import settings
    st = signing.status()
    return {'available': bool(local_edition() and st['configured'] and getattr(settings, 'GTRADE_INSTALL_ID', '')),
            'signing': {k: v for k, v in st.items() if k != 'public_key'}}


def issue_platform_owner(actor, ip='', *, auto=False, previous_status=''):
    """The vendor's OWN installation: a permanent, unlimited licence with every module, signed by the
    vendor key and bound to this installation (and machine). Only an installation holding the
    trusted vendor signing key can make it, so a customer installation can never become the
    platform owner; and the licence is refused anywhere but this installation. `auto`: issued by
    apps/licensing/owner.py because the installation had no (valid) owner licence."""
    from django.conf import settings
    from apps.licensing import fingerprint, service as local_service
    from apps.licensing.models import LicenseState
    if not local_edition():
        raise LicenceError('The platform-owner licence exists only on the vendor\'s Windows installation.')
    _require_signing()
    install_id = getattr(settings, 'GTRADE_INSTALL_ID', '') or ''
    if not install_id:
        raise LicenceError('This installation has no Installation ID.')
    st = LicenseState.load()
    lic_id = f'GOL-OWNER-{install_id.replace("-", "")[:8].upper()}'
    rev = (int(st.lic_rev or 0) + 1) if st.lic_id == lic_id else 1
    from apps.common import tenancy
    from apps.common.models import Tenant
    with tenancy.unscoped():
        home = Tenant.objects.filter(pk=tenancy.DEFAULT_TENANT_ID).first()
    name = (getattr(home, 'name', '') or 'Platform owner')[:150]
    today = timezone.localdate()
    payload = tokens.build_payload(
        lic_id=lic_id, rev=rev, issued_at=timezone.now(), client_id=PLATFORM_OWNER_CLIENT, client_name=name,
        edition=tokens.WINDOWS_LOCAL, plan_code='platform-owner', plan_name='Platform Owner / Lifetime',
        cycle=tokens.LIFETIME, duration=None, starts_on=today, expires_on=None,
        limits={k: None for k in LIMIT_LABELS}, modules=[], settings_features=None, install_id=install_id,
        fp_hashes=fingerprint.component_hashes(), grace_days=0, role=tokens.PLATFORM_OWNER, tier='ENTERPRISE')
    token = signing.sign_token(payload)
    verdict = local_service.install_blob(token, actor=_actor(actor), source='platform_owner')
    audit('PLATFORM_OWNER_ISSUED', _actor(actor), ip=ip, lic_id=lic_id, revision=rev, install_id=install_id,
          key_id=signing.key_id(), automatic=bool(auto), previous_status=previous_status or None)
    return verdict


# ---- Client Management (Windows Local Super Admin): client-centric subscriptions --------------------

def renewal_window_days(lic: ClientLicense) -> int:
    """How early a subscription counts as "renewal due": Monthly 7 days, Quarterly 15, longer 30
    (a fixed 30 days would mark every monthly subscription due from the day it was sold)."""
    months = lic.duration * (12 if lic.billing_cycle == tokens.YEARLY else 1)
    return 7 if months <= 1 else (15 if months <= 3 else 30)


def renewal_status(lic: ClientLicense | None, today=None) -> str:
    """One licence's renewal state: NOT_REQUIRED (lifetime) | OK | DUE (ends within
    renewal_window_days) | OVERDUE (expired) | UPCOMING (not started yet) | CLOSED (revoked) |
    SUSPENDED | NONE (no subscription)."""
    if lic is None:
        return 'NONE'
    if lic.status == tokens.REVOKED:
        return 'CLOSED'
    if lic.status == tokens.SUSPENDED:
        return 'SUSPENDED'
    today = today or timezone.localdate()
    if lic.starts_on and lic.starts_on > today:
        return 'UPCOMING'
    if lic.is_lifetime:
        return 'NOT_REQUIRED'
    if lic.expires_on < today:
        return 'OVERDUE'
    if (lic.expires_on - today).days <= renewal_window_days(lic):
        return 'DUE'
    return 'OK'


# Which licence is the client's CURRENT subscription: decided by validity dates and status, never
# by creation order (a licence created later may be backdated, already expired or start later).
_CURRENT_RANK = {tokens.ACTIVE: 0, tokens.SUSPENDED: 1, 'PENDING': 2, 'EXPIRED': 3, tokens.REVOKED: 4}


def _current_key(lic: ClientLicense, today):
    status = lic.effective_status(today)
    ends = dt.date.max if lic.is_lifetime else lic.expires_on
    issued = lic.issued_at or lic.created_at
    stamp = issued.timestamp() if issued else 0
    if status == 'PENDING':
        # The upcoming licence that starts first, then the one that runs longest.
        return (_CURRENT_RANK[status], lic.starts_on.toordinal(), -ends.toordinal(), -stamp)
    # Active / suspended / expired / revoked: the one valid the longest (Lifetime first), then the
    # most recently issued.
    return (_CURRENT_RANK.get(status, 5), 0, -ends.toordinal(), -stamp)


def current_licence(client: LicensedClient, today=None) -> ClientLicense | None:
    """The client's current subscription shown in Client Management:
    1. a licence valid today (ACTIVE: started, not expired, not suspended / revoked): the one that
       runs longest, Lifetime first;
    2. else a SUSPENDED one (it blocks the customer now);
    3. else the UPCOMING (future-dated) one that starts first;
    4. else the EXPIRED one that ended last (renewal overdue);
    5. else the most recent REVOKED one.
    Read-only: no licence record is changed."""
    today = today or timezone.localdate()
    rows = list(client.licences.all())
    return min(rows, key=lambda lic: _current_key(lic, today)) if rows else None


def client_renewal_status(client: LicensedClient, current: ClientLicense | None = None, today=None) -> str:
    """The client's renewal state for the Client Management list: the current licence's state,
    except RENEWED when it is due / overdue but another active licence already continues it (a
    future-dated new subscription, or one valid longer)."""
    today = today or timezone.localdate()
    current = current if current is not None else current_licence(client, today)
    state = renewal_status(current, today)
    if current is None or state not in ('DUE', 'OVERDUE'):
        return state
    for other in client.licences.all():
        if other.pk == current.pk or other.status != tokens.ACTIVE:
            continue
        if other.is_lifetime or (other.expires_on and current.expires_on and other.expires_on > current.expires_on):
            return 'RENEWED'
    return state


CLIENT_EDITABLE = ('name', 'owner_name', 'email', 'phone', 'country', 'address')


def update_client(client: LicensedClient, data: dict, *, actor, ip='') -> LicensedClient:
    """Edit a customer's details. The licence identity is the client code (never changes), so keys
    already issued stay valid; the name inside a key is updated at its next renewal / new key."""
    changes = {}
    for field in CLIENT_EDITABLE:
        if field not in data:
            continue
        value = data[field] if data[field] is not None else ''
        if field == 'name':
            value = str(value).strip()
            if not value:
                raise LicenceError('Enter the client name.', field='name')
        if field == 'country':
            value = str(value)[:2].upper()
        if getattr(client, field) != value:
            changes[field] = {'from': getattr(client, field), 'to': value}
            setattr(client, field, value)
    if changes:
        client.save(update_fields=list(changes))
        audit('CLIENT_UPDATED', _actor(actor), client=client, ip=ip, changes=changes)
    return client


def bind_installation(lic: ClientLicense, *, install: dict, actor, ip='') -> ClientLicense:
    """The customer's Installation ID arrived after the subscription was created: bind the licence to
    it (and to its machine when a request code was given) and sign the key that activates OFFLINE on
    that installation only. A licence already bound elsewhere moves only via replace_key (which voids
    the old installation's copy)."""
    _editable(lic)
    if lic.edition != tokens.WINDOWS_LOCAL:
        raise LicenceError('Only Windows Local licences are bound to an installation.')
    if not (install or {}).get('install_id'):
        raise LicenceError('Enter the customer\'s Installation ID or installation request code.', field='installation')
    if lic.install_id:
        if lic.install_id == install['install_id'] and not (install.get('fp') and not lic.install_fp):
            raise LicenceError(f'Licence {lic.lic_id} is already bound to this installation.', field='installation')
        if lic.install_id != install['install_id']:
            raise LicenceError(f'Licence {lic.lic_id} is bound to installation {lic.install_id[:8]}…. To move it to '
                               'another PC use "Replacement key" (the old PC\'s key is then voided).',
                               field='installation', code='bound_elsewhere')
    _require_signing()
    with transaction.atomic():
        lic = ClientLicense.objects.select_for_update().get(pk=lic.pk)
        lic.install_id = install['install_id']
        lic.install_fp = install.get('fp') or lic.install_fp or {}
        _sign(lic, 'BOUND', actor)
        audit('INSTALLATION_BOUND', _actor(actor), licence=lic, ip=ip, install_id=lic.install_id,
              machine=bool(lic.install_fp), revision=lic.revision)
        sync_hosted_tenant(lic.client, actor)
    return lic


CONFIRM_PREFIX = 'GTA1'


def parse_confirmation(text: str) -> dict:
    """The activation confirmation code a customer's Licence Details page shows after activation
    (apps/licensing/service.activation_confirmation): GTA1.<b64url JSON>. Not signed (a customer
    installation has no private key): it only records, for tracking, what the customer reports."""
    import base64
    import json
    text = ''.join((text or '').split())
    if not text.startswith(CONFIRM_PREFIX + '.'):
        raise LicenceError('This is not an activation confirmation code (it starts with GTA1).', field='code')
    body = text.split('.', 1)[1]
    try:
        data = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)).decode('utf-8'))
    except Exception:
        raise LicenceError('The activation confirmation code is damaged; copy it again.', field='code')
    if not isinstance(data, dict):
        raise LicenceError('The activation confirmation code is damaged; copy it again.', field='code')
    return data


def record_activation(lic: ClientLicense, *, code='', reason='', actor, ip='') -> ClientLicense:
    """Activation on a customer PC happens offline, so the vendor learns about it from the customer:
    either the confirmation code from their Licence Details page (checked against this licence,
    client and installation) or a manual confirmation with a reason. Tracking only: it never changes
    what the key allows."""
    _editable(lic)
    if lic.edition != tokens.WINDOWS_LOCAL:
        raise LicenceError('Cloud licences need no activation.')
    details = {}
    if (code or '').strip():
        data = parse_confirmation(code)
        if str(data.get('lic_id') or '') != lic.lic_id:
            raise LicenceError(f'This code is for licence {data.get("lic_id") or "?"}, not {lic.lic_id}.', field='code')
        if str(data.get('client_id') or '') != lic.client.client_code:
            raise LicenceError('This code was made for another client.', field='code')
        if not lic.install_id or str(data.get('install_id') or '') != lic.install_id:
            raise LicenceError('This code comes from another installation than the one the licence is bound to.',
                               field='code')
        details = {'method': 'confirmation_code', 'revision': data.get('rev'), 'status': data.get('status'),
                   'reported_at': data.get('activated_at')}
    else:
        reason = (reason or '').strip()
        if len(reason) < 3:
            raise LicenceError('Paste the customer\'s activation confirmation code, or give a reason to confirm by hand.',
                               field='code')
        if not lic.install_id:
            raise LicenceError('Bind the licence to the customer\'s installation first.', field='installation')
        details = {'method': 'manual'}
    now = timezone.now()
    lic.activated_at = lic.activated_at or now
    lic.last_checkin_at = now
    lic.save(update_fields=['activated_at', 'last_checkin_at', 'updated_at'])
    audit('ACTIVATION_CONFIRMED', _actor(actor), licence=lic, ip=ip, reason=reason, install_id=lic.install_id, **details)
    return lic



# ---- Hosted Workspaces (Windows Local Super Admin): a workspace's subscription ------------------------
#
# A Hosted Workspace client (common.Tenant) gets its subscription as a Windows Local licence:
#   Tenant 1--1 LicensedClient (tenant FK) 1--n ClientLicense
# The SUBSCRIPTION ID is ClientLicense.lic_id (unique, e.g. GOL-2026-1A2B3C4D): the database record,
# and the same ID is signed into the licence key the customer activates. The customer's
# INSTALLATION ID is a different value (ClientLicense.install_id) that binds the key to their PC.
# The workspace's own subscription fields (plan / start / expiry) mirror its CURRENT subscription
# (current_licence: by dates and status, never creation order), so the existing list filters, expiry
# dashboard and workspace expiry check keep working. Modules and seats stay editable on the workspace.

SUBSCRIPTION_MIRRORED_FIELDS = ('subscription_plan', 'subscription_starts_on', 'subscription_expires_on')


def tenant_plan_key(lic: ClientLicense) -> str:
    if lic.is_lifetime:
        return 'PERPETUAL'
    return TENANT_PLAN.get((lic.billing_cycle, lic.duration), 'MONTHLY' if lic.billing_cycle == tokens.MONTHLY else 'ANNUAL')


def hosted_terms(tenant) -> dict:
    """The workspace's enabled modules, seats and branches as the subscription's licence terms (the
    key the customer activates carries what the workspace was given; nothing is asked again)."""
    modules = list(tenant.modules or [])
    terms = {'limits': {'users': tenant.max_users if tenant.max_users and tenant.max_users < UNLIMITED_SEATS else None,
                        'branches': tenant.max_branches, 'companies': 1, 'clients': 0},
             'modules': modules}
    if 'settings' in modules:
        terms['settings_features'] = tenant.settings_features
    return terms


def sync_hosted_tenant(client: LicensedClient, actor) -> dict:
    """Mirror the client's current subscription onto its Hosted Workspace (plan / start / expiry).
    No-op for a client without a workspace, and when every subscription was revoked (the workspace
    keeps its last terms; deactivating it stays a deliberate Client Management action)."""
    if not client.tenant_id or client.edition != tokens.WINDOWS_LOCAL:
        return {}
    from apps.common.models import Tenant
    lic = current_licence(client)
    if lic is None or lic.status == tokens.REVOKED:
        return {}
    tenant = Tenant.objects.select_for_update().get(pk=client.tenant_id)
    wanted = {'subscription_plan': tenant_plan_key(lic), 'subscription_starts_on': lic.starts_on,
              'subscription_expires_on': lic.expires_on}
    changes = {}
    for field, value in wanted.items():
        if getattr(tenant, field) != value:
            changes[field] = {'from': getattr(tenant, field), 'to': value}
            setattr(tenant, field, value)
    if changes:
        tenant.save(update_fields=list(changes))
        from apps.common import hot_cache
        from apps.common.tenant_onboarding import log_event
        log_event(tenant, 'SUBSCRIPTION_APPLIED', _actor(actor), subscription_id=lic.lic_id, revision=lic.revision,
                  changes=_jsonable(changes))
        hot_cache.clear()
    return changes


def subscription_status(lic: ClientLicense | None, today=None) -> str:
    """Hosted Workspaces list: ACTIVE | UPCOMING | RENEWAL_DUE | EXPIRED | SUSPENDED | LIFETIME |
    REVOKED | NONE."""
    if lic is None:
        return 'NONE'
    today = today or timezone.localdate()
    state = lic.effective_status(today)
    if state == 'PENDING':
        return 'UPCOMING'
    if state != tokens.ACTIVE:
        return state  # EXPIRED / SUSPENDED / REVOKED
    if lic.is_lifetime:
        return 'LIFETIME'
    return 'RENEWAL_DUE' if renewal_status(lic, today) == 'DUE' else 'ACTIVE'


def subscription_summary(client: LicensedClient | None, today=None) -> dict | None:
    if client is None:
        return None
    from .serializers import key_available, subscription_label
    today = today or timezone.localdate()
    lic = current_licence(client, today)
    if lic is None:
        return None
    return {'id': str(lic.pk), 'subscription_id': lic.lic_id, 'plan': subscription_label(lic.billing_cycle, lic.duration),
            'plan_code': (lic.plan_snapshot or {}).get('code', ''), 'starts_on': lic.starts_on, 'expires_on': lic.expires_on,
            'lifetime': lic.is_lifetime, 'status': subscription_status(lic, today),
            'renewal_status': client_renewal_status(client, lic, today), 'install_id': lic.install_id,
            'activation_status': lic.activation_status(), 'key_available': key_available(lic),
            'modules': list(lic.modules or []), 'revision': lic.revision, 'client_code': client.client_code,
            'subscription_count': len(client.licences.all())}


def tenant_subscriptions(tenant_ids) -> dict:
    """{tenant_id: current subscription summary} for a page of Hosted Workspaces (2 queries)."""
    clients = LicensedClient.objects.filter(tenant_id__in=list(tenant_ids)).prefetch_related('licences')
    today = timezone.localdate()
    return {c.tenant_id: subscription_summary(c, today) for c in clients}


def change_start(lic: ClientLicense, *, starts_on, reason, actor, ip='') -> ClientLicense:
    """Move a subscription's start date (authorised: Local Super Admin, password re-check, reason in
    the audit). The expiry moves with it by the same plan duration (Lifetime stays Lifetime);
    re-signed (revision + 1), so the customer needs the new key."""
    reason = _reason(reason)
    _editable(lic)
    if isinstance(starts_on, str):
        try:
            starts_on = dt.date.fromisoformat(starts_on)
        except ValueError:
            raise LicenceError('Enter a valid start date.', field='starts_on')
    if not isinstance(starts_on, dt.date):
        raise LicenceError('Enter the new start date.', field='starts_on')
    if starts_on == lic.starts_on:
        raise LicenceError('The subscription already starts on that date.', field='starts_on')
    _require_signing()
    with transaction.atomic():
        lic = ClientLicense.objects.select_for_update().get(pk=lic.pk)
        old = {'starts_on': lic.starts_on, 'expires_on': lic.expires_on}
        lic.starts_on = starts_on
        lic.expires_on = tokens.compute_expiry(lic.billing_cycle, lic.duration, starts_on)
        _sign(lic, 'START_CHANGED', actor)
        audit('START_DATE_CHANGED', _actor(actor), licence=lic, reason=reason, ip=ip, revision=lic.revision,
              changes={'starts_on': {'from': old['starts_on'], 'to': lic.starts_on},
                       'expires_on': {'from': old['expires_on'], 'to': lic.expires_on}})
        sync_hosted_tenant(lic.client, actor)
    return lic
