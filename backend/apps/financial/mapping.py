"""AccountMapping resolution and validation.

resolve_role() is the only way a posting rule gets an account. A role with no valid
mapping raises MappingError — the engine records the failure and posts nothing, rather than
guessing an account or silently dropping the transaction.
"""
from django.db import transaction
from django.db.models import Q
from django.utils import timezone

from .accounting_catalog import ROLES
from .models import AccountMapping, ChartOfAccount
from .services import MappingError, audit


def mapping_problems(role, account):
    """Reasons `account` can't serve `role` (empty list = fine)."""
    problems = []
    if role not in ROLES:
        return [f"Unknown posting role '{role}'."]
    if account is None:
        return [f"No account selected for {ROLES[role][0]}."]
    if account.is_deleted:
        problems.append(f"{account.code} - {account.name} has been deleted.")
    if account.status != 'Active':
        problems.append(f"{account.code} - {account.name} is inactive.")
    allowed = ROLES[role][2]
    if account.account_type not in allowed:
        problems.append(
            f"{ROLES[role][0]} needs an {' / '.join(allowed)} account; "
            f"{account.code} - {account.name} is {account.account_type or 'unclassified'}."
        )
    return problems


def _candidates(role, branch=None, date=None):
    date = date or timezone.localdate()
    qs = (AccountMapping.objects.filter(role=role, is_active=True)
          .filter(Q(effective_from__isnull=True) | Q(effective_from__lte=date))
          .select_related('account__account_group'))
    branch_id = getattr(branch, 'pk', branch)
    scoped = [m for m in qs if branch_id and m.branch_id == branch_id]
    shared = [m for m in qs if m.branch_id is None]
    key = lambda m: (m.effective_from is not None, m.effective_from or date)  # noqa: E731
    return sorted(scoped, key=key, reverse=True) + sorted(shared, key=key, reverse=True)


def resolve_role(role, branch=None, date=None):
    candidates = _candidates(role, branch, date)
    label = ROLES.get(role, (role,))[0]
    if not candidates:
        raise MappingError(f"No active account mapping for '{label}' ({role}). "
                           f"Map it under Financial → Accounting Integration.")
    mapping = candidates[0]
    problems = mapping_problems(role, mapping.account)
    if problems:
        raise MappingError(f"Mapping for '{label}' ({role}) is invalid: {' '.join(problems)}")
    return mapping.account


def role_status(branch=None):
    """Every role with its currently effective mapping and any problem — the Accounting
    Integration screen's mapping table and its unmapped-role alert both read this."""
    rows = []
    for role, (label, default_code, allowed, description) in ROLES.items():
        candidates = _candidates(role, branch)
        mapping = candidates[0] if candidates else None
        problems = mapping_problems(role, mapping.account) if mapping else ['Not mapped.']
        rows.append({
            'role': role, 'label': label, 'description': description, 'allowed_types': list(allowed),
            'default_code': default_code,
            'mapping_id': str(mapping.pk) if mapping else None,
            'account_id': str(mapping.account_id) if mapping else None,
            'account_code': mapping.account.code if mapping else None,
            'account_name': mapping.account.name if mapping else None,
            'branch_id': str(mapping.branch_id) if mapping and mapping.branch_id else None,
            'effective_from': mapping.effective_from.isoformat() if mapping and mapping.effective_from else None,
            'valid': not problems, 'problems': problems,
        })
    return rows


def _snapshot(m):
    return {'role': m.role, 'account': f"{m.account.code} - {m.account.name}", 'account_id': str(m.account_id),
            'branch': str(m.branch_id) if m.branch_id else None,
            'effective_from': m.effective_from.isoformat() if m.effective_from else None,
            'is_active': m.is_active, 'notes': m.notes}


def save_mapping(*, role, account, branch=None, effective_from=None, notes='', user=None, mapping=None):
    """Create or change a mapping. Refuses an invalid account before anything is saved; a
    change of account from a new date is better done as a new mapping with effective_from,
    which keeps the older one in force for earlier documents."""
    if isinstance(account, str):
        account = ChartOfAccount.objects.select_related('account_group').filter(pk=account).first()
    problems = mapping_problems(role, account)
    if problems:
        raise MappingError(' '.join(problems))
    with transaction.atomic():
        before = _snapshot(mapping) if mapping else None
        if mapping is None:
            mapping = (AccountMapping.objects
                       .filter(role=role, branch=branch, effective_from=effective_from, is_active=True).first())
            if mapping:
                before = _snapshot(mapping)
        if mapping is None:
            mapping = AccountMapping(role=role, branch=branch, effective_from=effective_from)
        mapping.account = account
        mapping.notes = notes or mapping.notes
        mapping.is_active = True
        mapping.save()
        audit('MAPPING_CREATED' if before is None else 'MAPPING_CHANGED', 'mapping', mapping.pk,
              f"{ROLES[role][0]} → {account.code} - {account.name}", before=before, after=_snapshot(mapping), user=user)
    return mapping


def deactivate_mapping(mapping, user=None):
    with transaction.atomic():
        before = _snapshot(mapping)
        mapping.is_active = False
        mapping.save(update_fields=['is_active', 'updated_at'])
        audit('MAPPING_DEACTIVATED', 'mapping', mapping.pk, f"{mapping.role} mapping deactivated",
              before=before, after=_snapshot(mapping), user=user)
    return mapping


def accounts_in_active_mappings():
    return set(AccountMapping.objects.filter(is_active=True).values_list('account_id', flat=True))
