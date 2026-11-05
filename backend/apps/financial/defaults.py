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
from django.utils import timezone

from .accounting_catalog import DEFAULT_ACCOUNTS, ROLES
from .models import AccountGroup, AccountingPolicy, AccountMapping, ChartOfAccount


def missing_defaults():
    """(account codes, roles) that ensure_accounting_defaults would add — no writes."""
    have_codes = set(ChartOfAccount.all_objects.values_list('code', flat=True))
    have_names = {n.lower() for n in ChartOfAccount.all_objects.values_list('name', flat=True)}
    accounts = [code for code, name, *_ in DEFAULT_ACCOUNTS if code not in have_codes and name.lower() not in have_names]
    mapped = set(AccountMapping.objects.values_list('role', flat=True))
    return accounts, [role for role in ROLES if role not in mapped]


def ensure_accounting_defaults(user=None):
    """Create missing default accounts / role mappings. Returns {'accounts': [...], 'mappings': [...]}
    naming what was added (both empty when nothing was missing).

    Reads what exists once and writes in bulk. Row-by-row this was ~170 queries for a business
    with no chart of accounts yet — a new client's first Supplier save, which links the
    supplier's ledger head, took ~45 s on the hosted (cross-region) database."""
    accounts_needed, roles_needed = missing_defaults()
    if not accounts_needed and not roles_needed:
        return {'accounts': [], 'mappings': []}
    with transaction.atomic():
        # The policy row doubles as the lock, so two postings healing at once can't both map a role.
        policy = AccountingPolicy.get()
        AccountingPolicy.objects.select_for_update().get(pk=policy.pk)

        existing = list(ChartOfAccount.all_objects.all())
        by_existing_code = {a.code: a for a in existing}
        by_existing_name = {}
        for a in existing:
            by_existing_name.setdefault((a.name or '').lower(), a)
        groups = {g.name: g for g in AccountGroup.objects.all()}
        new_groups = []

        def group_for(group_name, acc_type):
            group = groups.get(group_name)
            if group is not None and group.account_type != acc_type:
                group_name = f"{group_name} ({acc_type})"
                group = groups.get(group_name)
            if group is None:
                group = AccountGroup(name=group_name, account_type=acc_type)
                groups[group_name] = group
                new_groups.append(group)
            return group

        added_accounts, revived, new_accounts, by_code = [], [], [], {}
        for code, name, group_name, acc_type, subtype, is_system in DEFAULT_ACCOUNTS:
            acc = by_existing_code.get(code) or by_existing_name.get(name.lower())
            if acc is not None:
                if acc.is_deleted and acc not in revived:  # a soft-deleted default comes back
                    acc.is_deleted = False
                    revived.append(acc)
            else:
                acc = ChartOfAccount(code=code, name=name, account_group=group_for(group_name, acc_type),
                                     status='Active', account_subtype=subtype, is_system=is_system)
                new_accounts.append(acc)
                by_existing_code[code] = acc
                by_existing_name[name.lower()] = acc
                added_accounts.append(f'{acc.code} {acc.name}')
            by_code[code] = acc

        if new_groups:
            AccountGroup.objects.bulk_create(new_groups)
        if new_accounts:
            ChartOfAccount.objects.bulk_create(new_accounts)
        if revived:
            ChartOfAccount.all_objects.filter(pk__in=[a.pk for a in revived]).update(is_deleted=False, updated_at=timezone.now())

        mapped = set(AccountMapping.objects.values_list('role', flat=True))
        new_mappings, added_mappings = [], []
        for role, (label, default_code, _allowed, _desc) in ROLES.items():
            if role in mapped:
                continue
            acc = by_code[default_code]
            new_mappings.append(AccountMapping(role=role, account=acc, is_active=True,
                                               notes='Default restored automatically (no mapping existed)'))
            added_mappings.append(f'{label} → {acc.code} {acc.name}')
        if new_mappings:
            AccountMapping.objects.bulk_create(new_mappings)
        if added_accounts or added_mappings:
            from .services import audit
            audit('DEFAULTS_RESTORED', 'account_mapping', '',
                  f"Restored {len(added_mappings)} default mapping(s) and {len(added_accounts)} account(s)",
                  after={'accounts': added_accounts, 'mappings': added_mappings}, user=user)
    return {'accounts': added_accounts, 'mappings': added_mappings}
