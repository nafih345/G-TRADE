"""Expense categories: quick-add from the Record Expense screen.

There is no separate category table. An expense category IS an Expense-type Chart of Accounts
ledger (subtype EXPENSE), so it gets its own ledger / Trial Balance row automatically. The
expense type picks the account group: "Indirect Expenses" (default) or "Direct Expenses". The
Profit & Loss statement buckets by group name (pl_statement.pl_bucket), so the group is what puts
the category under Indirect (operating) or Direct expenses. Re-classify later by moving the account
to the other group in the Chart of Accounts.

Deleting stays with the Chart of Accounts rules: a ledger with postings can't be deleted (only
marked Inactive), and deleted accounts are soft-deleted rows whose names stay reserved.
"""
import re

from django.db import IntegrityError, transaction
from rest_framework import serializers

from .models import AccountGroup, ChartOfAccount

EXPENSE_GROUPS = {'INDIRECT': 'Indirect Expenses', 'DIRECT': 'Direct Expenses'}
# New categories number up from here, after the seeded 51xx indirect ledgers.
FIRST_CODE, LAST_CODE = 5140, 5999


def expense_type_of(account):
    """'DIRECT' / 'INDIRECT', matching how the P&L will bucket this account."""
    from .pl_statement import DIRECT_EXPENSE, pl_bucket
    bucket = pl_bucket('Expense', account.account_subtype, account.account_group.name if account.account_group_id else '')
    return 'DIRECT' if bucket == DIRECT_EXPENSE else 'INDIRECT'


def _group(expense_type):
    name = EXPENSE_GROUPS[expense_type]
    group = AccountGroup.objects.filter(name__iexact=name).first()
    if group is None:
        return AccountGroup.objects.create(name=name, account_type='Expense')
    if group.account_type != 'Expense':
        raise serializers.ValidationError({'expense_type': f"The account group '{group.name}' is not an Expense group."})
    return group


def _next_code():
    # Codes are unique per tenant, soft-deleted rows included.
    taken = set(ChartOfAccount.all_objects.filter(code__regex=r'^5\d{3}$').values_list('code', flat=True))
    highest = max([int(c) for c in taken if FIRST_CODE <= int(c) <= LAST_CODE] or [FIRST_CODE - 10])
    # Leave gaps of 10 like the seeded ledgers; fill any hole once the range runs out.
    for n in list(range(highest + 10, LAST_CODE + 1, 10)) + list(range(FIRST_CODE, LAST_CODE + 1)):
        if str(n) not in taken:
            return str(n)
    n = 1
    while ChartOfAccount.all_objects.filter(code=f'59{n:03d}').exists():
        n += 1
    return f'59{n:03d}'


def clean_category(data):
    name = ' '.join(str(data.get('name') or '').split())
    expense_type = str(data.get('expense_type') or 'INDIRECT').strip().upper()
    description = str(data.get('description') or '').strip()
    errors = {}
    if not name:
        errors['name'] = 'Category name is required.'
    elif len(name) > 150:
        errors['name'] = 'Category name can be at most 150 characters.'
    elif not re.search(r'[A-Za-z0-9]', name):
        errors['name'] = 'Category name needs at least one letter or digit.'
    if expense_type not in EXPENSE_GROUPS:
        errors['expense_type'] = 'Expense type must be DIRECT or INDIRECT.'
    if errors:
        raise serializers.ValidationError(errors)
    clash = ChartOfAccount.all_objects.select_related('account_group').filter(name__iexact=name).first()
    if clash is not None:
        usable = (not clash.is_deleted and clash.status == 'Active' and clash.account_type == 'Expense')
        if usable:
            msg = f"An expense category named '{clash.name}' already exists ({clash.code}). Select it from the list."
        elif clash.is_deleted:
            msg = f"The name '{clash.name}' belongs to a deleted account ({clash.code}). Choose another name."
        elif clash.account_type != 'Expense':
            msg = f"'{clash.name}' is already a {clash.account_type} account ({clash.code}). Choose another name."
        else:
            msg = f"'{clash.name}' already exists ({clash.code}) but is Inactive. Re-activate it in the Chart of Accounts."
        err = {'name': msg}
        if usable:
            err['existing_id'] = str(clash.pk)
        raise serializers.ValidationError(err)
    return {'name': name, 'expense_type': expense_type, 'description': description}


def create_expense_category(data, user=None):
    clean = clean_category(data)
    try:
        with transaction.atomic():
            return ChartOfAccount.objects.create(
                code=_next_code(), name=clean['name'], account_group=_group(clean['expense_type']),
                account_subtype='EXPENSE', status='Active', description=clean['description'] or None,
                created_by=user,
            )
    except IntegrityError:
        # Lost a race with a simultaneous add of the same name (or code): report it as a duplicate.
        clean_category(data)
        raise serializers.ValidationError({'name': 'Could not save the category (name or code clash). Try again.'})
