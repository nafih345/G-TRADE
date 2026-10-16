"""Seed the accounting integration and adopt journals posted by the old signal handlers.

* Default Chart of Accounts: existing accounts are kept as they are (matched by code, then by
  name) — only missing ones are created. Matched/created defaults are flagged is_system.
* One AccountMapping per posting role, pointing at its default account, unless the role is
  already mapped.
* AccountingPolicy: sources that were never booked before this release (purchase entries,
  wholesale, stock adjustments, direct PO receipts) get today's date as their automated
  posting start, so historical documents are NOT posted automatically — they are brought in
  with the controlled backfill tool after reconciliation. Retail invoices and receipts were
  already being booked, so they keep posting with no cut-off.
* Legacy journals get source_module / source_event / is_reversal / total_amount filled in so
  the engine recognises them. If an old handler double-posted a document (the PO signal
  re-posted on every save), all but the newest live entry are re-tagged
  'legacy_duplicate_<event>' so the unique index in 0006 can be created; they stay on the
  books and are listed under Accounting Integration → duplicates for review.

Reverse: no-op (the seeded rows are ordinary data; 0004's reverse drops the new columns).
"""
from decimal import Decimal

from django.db import migrations
from django.db.models import Count, Sum
from django.utils import timezone

NEW_SOURCES = (
    'sales.wholesale_invoice', 'sales.wholesale_collection', 'sales.wholesale_return',
    'purchasing.purchase_invoice', 'purchasing.purchase_payment', 'purchasing.purchase_order',
    'inventory.stock_adjustment',
)


def seed(apps, schema_editor):
    from apps.financial.accounting_catalog import DEFAULT_ACCOUNTS, ROLES, LEGACY_REFERENCE_TYPES

    AccountGroup = apps.get_model('financial', 'AccountGroup')
    ChartOfAccount = apps.get_model('financial', 'ChartOfAccount')
    AccountMapping = apps.get_model('financial', 'AccountMapping')
    AccountingPolicy = apps.get_model('financial', 'AccountingPolicy')
    JournalEntry = apps.get_model('financial', 'JournalEntry')
    LedgerEntry = apps.get_model('financial', 'LedgerEntry')

    by_code = {}
    for code, name, group_name, acc_type, subtype, is_system in DEFAULT_ACCOUNTS:
        acc = ChartOfAccount.objects.filter(code=code).first() or ChartOfAccount.objects.filter(name__iexact=name).first()
        if acc is None:
            group = AccountGroup.objects.filter(name=group_name).first()
            if group is None:
                group = AccountGroup.objects.create(name=group_name, account_type=acc_type)
            elif group.account_type != acc_type:
                group, _ = AccountGroup.objects.get_or_create(name=f"{group_name} ({acc_type})", defaults={'account_type': acc_type})
            acc = ChartOfAccount.objects.create(code=code, name=name, account_group=group, status='Active',
                                                account_subtype=subtype, is_system=is_system)
        else:
            changed = []
            if acc.is_deleted:
                acc.is_deleted = False
                changed.append('is_deleted')
            if not acc.account_subtype:
                acc.account_subtype = subtype
                changed.append('account_subtype')
            if is_system and not acc.is_system:
                acc.is_system = True
                changed.append('is_system')
            if changed:
                acc.save(update_fields=changed)
        by_code[code] = acc

    for role, (_label, default_code, _allowed, _desc) in ROLES.items():
        if not AccountMapping.objects.filter(role=role, is_active=True).exists():
            AccountMapping.objects.create(role=role, account=by_code[default_code], is_active=True,
                                          notes='Seeded default')

    today = timezone.localdate().isoformat()
    policy, _ = AccountingPolicy.objects.get_or_create(pk=1)
    starts = dict(policy.source_start_dates or {})
    for key in NEW_SOURCES:
        starts.setdefault(key, today)
    policy.source_start_dates = starts
    policy.save()

    for entry in JournalEntry.objects.all():
        updates = {}
        if entry.entry_number.startswith('REV-') and not entry.is_reversal:
            updates['is_reversal'] = True
        if not entry.source_module and entry.reference_type in LEGACY_REFERENCE_TYPES:
            updates['source_module'], updates['source_event'] = LEGACY_REFERENCE_TYPES[entry.reference_type]
        total = LedgerEntry.objects.filter(journal_entry=entry).aggregate(s=Sum('debit'))['s'] or Decimal('0')
        if entry.total_amount != total:
            updates['total_amount'] = total
        if entry.status in ('POSTED', 'REVERSED') and not entry.posted_at:
            updates['posted_at'] = entry.created_at
        if updates:
            JournalEntry.objects.filter(pk=entry.pk).update(**updates)

    dupes = (JournalEntry.objects.filter(status='POSTED', is_reversal=False, reference_id__isnull=False)
             .exclude(source_module='').values('source_module', 'source_event', 'reference_id')
             .annotate(n=Count('id')).filter(n__gt=1))
    for d in dupes:
        entries = list(JournalEntry.objects.filter(status='POSTED', is_reversal=False, **{
            'source_module': d['source_module'], 'source_event': d['source_event'], 'reference_id': d['reference_id'],
        }).order_by('-created_at'))
        for extra in entries[1:]:
            JournalEntry.objects.filter(pk=extra.pk).update(
                source_event=f"legacy_duplicate_{extra.source_event}"[:40])


class Migration(migrations.Migration):

    dependencies = [
        ('financial', '0004_accounting_engine'),
    ]

    operations = [
        migrations.RunPython(seed, migrations.RunPython.noop),
    ]
