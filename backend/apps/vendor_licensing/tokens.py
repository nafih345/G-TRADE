"""Licence token content (pure functions: no models, no settings, no keys).

A licence key IS a signed licence: ``GTL1.<payload>.<Ed25519 signature>`` (apps/licensing/licfmt.py).
The same string is pasted as a "licence key" or saved as a ``.lic`` file; the Windows edition
verifies both with the same code and the embedded public key, so a key works offline.

Payload v2 (fields read by the customer side, apps/licensing/state.py + service.py):

    v, product, lic_id, rev, key_id, issued_at
    client {id, name}, customer {name}            client identity (customer = legacy display field)
    edition  WINDOWS_LOCAL | CLOUD
    plan {code, name, cycle, duration}            cycle MONTHLY (duration 1/3/6 = monthly / quarterly /
                                                  half-yearly) | YEARLY | LIFETIME
    type     subscription | perpetual             legacy, derived from lifetime
    lifetime, starts_on, expires_on, valid_until  valid_until = end of the expiry day (null = lifetime)
    limits {clients, companies, branches_total, branches_per_company, users}, unlimited [...]
                                                  a key in `unlimited` has no cap
    tier     optional display tier (ENTERPRISE for the platform owner)
    role     PLATFORM_OWNER only on the vendor's own installation licence (modules null = all)
    modules [...], settings_features null|[...]
    status   ACTIVE | SUSPENDED | REVOKED, status_reason
    binding  INSTALLATION | FIRST_ACTIVATION | CLOUD
    install_id, fp {v, hashes, tolerance}         installation (and optionally machine) binding
    tenant_id                                     cloud edition: the client's workspace
    grace_days, checkin_days, updates_until, activation_id   legacy-compatible fields
"""

from __future__ import annotations

import calendar
import datetime as dt

PRODUCT = 'G-OPTICALS'
TOKEN_VERSION = 2

CLOUD, WINDOWS_LOCAL = 'CLOUD', 'WINDOWS_LOCAL'
EDITIONS = ((WINDOWS_LOCAL, 'Windows Local Edition'), (CLOUD, 'Cloud Edition'))
MONTHLY, YEARLY, LIFETIME = 'MONTHLY', 'YEARLY', 'LIFETIME'
CYCLES = ((MONTHLY, 'Monthly subscription'), (YEARLY, 'Yearly subscription'), (LIFETIME, 'Lifetime licence'))
ACTIVE, SUSPENDED, REVOKED = 'ACTIVE', 'SUSPENDED', 'REVOKED'

# Plan limit name -> licence limit key (the keys apps/licensing/enforcement.py already enforces).
LIMIT_KEYS = (('clients', 'clients'), ('companies', 'companies'), ('branches', 'branches_total'),
              ('branches_per_company', 'branches_per_company'), ('users', 'users'))

# The vendor's own installation (Local Super Admin): permanent, unlimited, every module. Issued only
# by service.issue_platform_owner, to the installation that holds the vendor signing key.
PLATFORM_OWNER = 'PLATFORM_OWNER'

# End of the last usable day in the latest time zone (UTC-12): a customer anywhere keeps the whole
# expiry day, so a licence is never cut short by the vendor's or the customer's time zone.
EXPIRY_TIME = 'T23:59:59-12:00'


def add_months(day: dt.date, months: int) -> dt.date:
    month = day.month - 1 + months
    year = day.year + month // 12
    month = month % 12 + 1
    return dt.date(year, month, min(day.day, calendar.monthrange(year, month)[1]))


def _months(cycle: str, duration: int | None) -> int:
    n = max(1, int(duration or 1))
    return n if cycle == MONTHLY else 12 * n


def compute_expiry(cycle: str, duration: int | None, starts_on: dt.date) -> dt.date | None:
    """Expiry date (the customer can use the application until the end of that day). Monthly =
    `duration` calendar months, yearly = `duration` years, lifetime = None. A monthly licence
    starting 19 Nov 2026 expires on 19 Dec 2026; quarterly on 19 Feb 2027; half-yearly on
    19 May 2027; yearly on 19 Nov 2027 (a 31st becomes the month's last day)."""
    if cycle == LIFETIME:
        return None
    return add_months(starts_on, _months(cycle, duration))


def extend_expiry(cycle: str, duration: int | None, current: dt.date | None, today: dt.date, periods: int = 1) -> dt.date:
    """Renewal: `periods` plan periods added to the current expiry date, or to today when the
    licence has already lapsed (the lapsed days are not charged twice)."""
    base = current if current and current >= today else today
    return add_months(base, _months(cycle, duration) * max(1, int(periods)))


def valid_until(expires_on: dt.date | None) -> str | None:
    return f'{expires_on.isoformat()}{EXPIRY_TIME}' if expires_on else None


def licence_limits(limits: dict) -> tuple[dict, list]:
    """Plan limits {clients, companies, branches, users} (None = unlimited) -> (limits, unlimited)
    in the customer-side keys."""
    out, unlimited = {}, []
    for plan_key, lic_key in LIMIT_KEYS:
        value = (limits or {}).get(plan_key)
        if value is None:
            unlimited.append(lic_key)
        else:
            out[lic_key] = int(value)
    return out, unlimited


def build_payload(*, lic_id: str, rev: int, issued_at: dt.datetime, client_id: str, client_name: str,
                  edition: str, plan_code: str, plan_name: str, cycle: str, duration: int | None,
                  starts_on: dt.date, expires_on: dt.date | None, limits: dict, modules: list,
                  settings_features: list | None, status: str = ACTIVE, status_reason: str = '',
                  install_id: str = '', fp_hashes: dict | None = None, grace_days: int = 7,
                  tenant_id: int | None = None, role: str = '', tier: str = '') -> dict:
    lic_limits, unlimited = licence_limits(limits)
    lifetime = cycle == LIFETIME or expires_on is None
    if edition == CLOUD:
        binding = 'CLOUD'
    else:
        binding = 'INSTALLATION' if install_id else 'FIRST_ACTIVATION'
    payload = {
        'v': TOKEN_VERSION, 'product': PRODUCT, 'lic_id': lic_id, 'rev': int(rev),
        'issued_at': issued_at.astimezone(dt.timezone.utc).replace(microsecond=0).isoformat(),
        'client': {'id': client_id, 'name': client_name}, 'customer': {'name': client_name},
        'edition': edition,
        'plan': {'code': plan_code, 'name': plan_name, 'cycle': cycle, 'duration': None if lifetime else duration},
        'type': 'perpetual' if lifetime else 'subscription', 'lifetime': lifetime,
        'starts_on': starts_on.isoformat(), 'expires_on': expires_on.isoformat() if expires_on else None,
        'valid_until': None if lifetime else valid_until(expires_on),
        'limits': lic_limits, 'unlimited': unlimited,
        'modules': list(modules or []),
        'settings_features': list(settings_features) if settings_features is not None else None,
        'status': status, 'status_reason': (status_reason or '')[:200],
        'binding': binding, 'install_id': install_id or '',
        'grace_days': int(grace_days or 0), 'checkin_days': None, 'updates_until': None, 'activation_id': '',
    }
    if fp_hashes:
        payload['fp'] = {'v': 1, 'hashes': dict(fp_hashes), 'tolerance': 2}
    if tenant_id is not None:
        payload['tenant_id'] = tenant_id
    if tier:
        payload['tier'] = tier
    if role:
        payload['role'] = role
        if role == PLATFORM_OWNER:
            payload['modules'] = None            # every module, now and in future releases
            payload['settings_features'] = None
    return payload


REQUEST_PREFIX = 'GTR1'


def parse_installation(text: str) -> dict:
    """The installation to bind a key to: either a bare Installation ID (shown on the customer's
    Licence Details page) or the installation request code `GTR1.<base64url JSON>` the same page
    copies (install id + machine fingerprint hashes). Raises ValueError with a user-facing message."""
    import base64
    import json
    import re
    text = ''.join((text or '').split())
    if not text:
        return {'install_id': '', 'fp': {}}
    if text.startswith(REQUEST_PREFIX + '.'):
        body = text.split('.', 1)[1]
        try:
            data = json.loads(base64.urlsafe_b64decode(body + '=' * (-len(body) % 4)).decode('utf-8'))
        except Exception:
            raise ValueError('The installation request code is damaged. Copy it again from the customer\'s Licence page.')
        install_id = str(data.get('install_id') or '')
        fp = (data.get('fp') or {}).get('hashes') or {}
        if not isinstance(fp, dict) or not all(isinstance(v, str) and v.startswith('sha256:') for v in fp.values()):
            raise ValueError('The installation request code has an invalid machine fingerprint.')
    else:
        install_id, fp = text, {}
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9-]{7,63}', install_id):
        raise ValueError('Enter the Installation ID or installation request code shown on the customer\'s '
                         'Licence page.')
    # A Subscription ID (licence id, GOL-…) or a client code (CL-…) is never an Installation ID.
    if re.match(r'(?i)^(GOL|CL)-', install_id) or install_id.upper().startswith(('GTL1', 'GTA1', 'GTC1')):
        raise ValueError(f'"{install_id[:24]}" is a Subscription ID / licence value, not an Installation ID. Enter the '
                         'Installation ID shown on the customer\'s G-TRADE Licence Details page.')
    return {'install_id': install_id, 'fp': fp}
