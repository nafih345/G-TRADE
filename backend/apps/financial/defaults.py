"""Default Chart of Accounts heads and posting-role mappings, restorable at any time.

Migration 0005 seeded them once. `wipe_database` TRUNCATEs the whole financial app (and an old
backup can predate the seed), after which every journal — purchase entries, sales, receipts —
failed with "No active account mapping for 'Inventory'" and nothing reached the ledgers.
ensure_accounting_defaults() puts back only what is missing and is safe to run any number of
times:

* a default account is created only when neither its code nor its name exists yet;
* a role gets its default mapping only when it has no mapping row at all. A mapping staff
  deactivated is a decision: it stays off and postings needing it keep failing visibly.

Called lazily by mapping.resolve_role on a miss (so postings heal themselves), after
wipe_database and after a backup restore, and by `manage.py ensure_accounting_setup`.
"""
from django.db import transaction

from .accounting_catalog import DEFAULT_ACCOUNTS, ROLES
from .models import AccountGroup, AccountingPolicy, AccountMapping, ChartOfAccount


def missing_defaults():
    """(account codes, roles) that ensure_accounting_defaults would add — no writes."""
    have_codes = set(ChartOfAccount.all_objects.values_list('code', flat=True))
    have_names = {n.lower() for n in ChartOfAccount.all_objects.values_list('name', flat=True)}
    accounts = [code for code, name, *_ in DEFAULT_ACCOUNTS if code not in have_codes and name.lower() not in have_names]
    mapped = set(AccountMapping.objects.values_list('role', flat=True))
    return accounts, [role for role in ROLES if role not in mapped]


def _default_account(code, name, group_name, acc_type, subtype, is_system):
    acc = ChartOfAccount.all_objects.filter(code=code).first() \
        or ChartOfAccount.all_objects.filter(name__iexact=name).first()
    if acc is not None:
        if acc.is_deleted:  # a soft-deleted default comes back rather than colliding on code/name
            acc.is_deleted = False
            acc.save(update_fields=['is_deleted', 'updated_at'])
        return acc, False
    group = AccountGroup.objects.filter(name=group_name).first()
    if group is None:
        group = AccountGroup.objects.create(name=group_name, account_type=acc_type)
    elif group.account_type != acc_type:
        group, _ = AccountGroup.objects.get_or_create(name=f"{group_name} ({acc_type})", defaults={'account_type': acc_type})
    return ChartOfAccount.objects.create(code=code, name=name, account_group=group, status='Active',
                                         account_subtype=subtype, is_system=is_system), True


def ensure_accounting_defaults(user=None):
    """Create missing default accounts / role mappings. Returns {'accounts': [...], 'mappings': [...]}
    naming what was added (both empty when nothing was missing)."""
    accounts_needed, roles_needed = missing_defaults()
    if not accounts_needed and not roles_needed:
        return {'accounts': [], 'mappings': []}
    with transaction.atomic():
        # The policy row doubles as the lock, so two postings healing at once can't both map a role.
        AccountingPolicy.objects.get_or_create(pk=1)
        AccountingPolicy.objects.select_for_update().get(pk=1)
        added_accounts, added_mappings = [], []
        by_code = {}
        for row in DEFAULT_ACCOUNTS:
            acc, created = _default_account(*row)
            by_code[row[0]] = acc
            if created:
                added_accounts.append(f'{acc.code} {acc.name}')
        mapped = set(AccountMapping.objects.values_list('role', flat=True))
        for role, (label, default_code, _allowed, _desc) in ROLES.items():
            if role in mapped:
                continue
            acc = by_code[default_code]
            AccountMapping.objects.create(role=role, account=acc, is_active=True,
                                          notes='Default restored automatically (no mapping existed)')
            added_mappings.append(f'{label} → {acc.code} {acc.name}')
        if added_accounts or added_mappings:
            from .services import audit
            audit('DEFAULTS_RESTORED', 'account_mapping', '',
                  f"Restored {len(added_mappings)} default mapping(s) and {len(added_accounts)} account(s)",
                  after={'accounts': added_accounts, 'mappings': added_mappings}, user=user)
    return {'accounts': added_accounts, 'mappings': added_mappings}
