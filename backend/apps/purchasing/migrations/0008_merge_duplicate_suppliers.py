from collections import defaultdict

from django.db import migrations, models
from django.db.models.functions import Lower


FILLABLE = ['company_name', 'contact_person', 'email', 'phone', 'gstin', 'address', 'city',
            'payment_terms', 'account_number']


def merge_duplicate_suppliers(apps, schema_editor):
    """Folds suppliers sharing a company name (case/space-insensitive) into the oldest row:
    purchase orders/invoices, outstanding balance and ledger postings move to the keeper, blank
    keeper fields are filled from the duplicates, and the duplicates are soft-deleted."""
    Supplier = apps.get_model('purchasing', 'Supplier')
    PurchaseOrder = apps.get_model('purchasing', 'PurchaseOrder')
    PurchaseInvoice = apps.get_model('purchasing', 'PurchaseInvoice')
    ChartOfAccount = apps.get_model('financial', 'ChartOfAccount')
    LedgerEntry = apps.get_model('financial', 'LedgerEntry')

    groups = defaultdict(list)
    for s in Supplier.objects.filter(is_deleted=False).order_by('created_at', 'id'):
        clean = ' '.join((s.name or '').split())
        if clean != s.name:
            s.name = clean
            s.save(update_fields=['name'])
        groups[clean.lower()].append(s)

    for rows in groups.values():
        if len(rows) < 2:
            continue
        keeper, dupes = rows[0], rows[1:]
        for d in dupes:
            PurchaseOrder.objects.filter(supplier_id=d.id).update(supplier_id=keeper.id)
            PurchaseInvoice.objects.filter(supplier_id=d.id).update(supplier_id=keeper.id)
            keeper.outstanding_balance = (keeper.outstanding_balance or 0) + (d.outstanding_balance or 0)
            for f in FILLABLE:
                if not getattr(keeper, f) and getattr(d, f):
                    setattr(keeper, f, getattr(d, f))

            if d.ledger_account_id:
                if not keeper.ledger_account_id:
                    keeper.ledger_account_id = d.ledger_account_id
                elif d.ledger_account_id != keeper.ledger_account_id:
                    LedgerEntry.objects.filter(account_id=d.ledger_account_id).update(account_id=keeper.ledger_account_id)
                    src = ChartOfAccount.objects.get(pk=d.ledger_account_id)
                    dst = ChartOfAccount.objects.get(pk=keeper.ledger_account_id)
                    dst.opening_balance = (dst.opening_balance or 0) + (src.opening_balance or 0)
                    dst.current_balance = (dst.current_balance or 0) + (src.current_balance or 0)
                    dst.save(update_fields=['opening_balance', 'current_balance'])
                    src.opening_balance = 0
                    src.current_balance = 0
                    src.status = 'Inactive'
                    src.is_deleted = True
                    src.save(update_fields=['opening_balance', 'current_balance', 'status', 'is_deleted'])

            d.is_deleted = True
            d.outstanding_balance = 0
            d.ledger_account_id = None
            d.save(update_fields=['is_deleted', 'outstanding_balance', 'ledger_account'])
        keeper.save()


class Migration(migrations.Migration):

    dependencies = [
        ('purchasing', '0007_purchaseorder_branch'),
        ('financial', '0003_alter_journalentry_reference_id'),
    ]

    operations = [
        migrations.RunPython(merge_duplicate_suppliers, migrations.RunPython.noop),
        migrations.AddConstraint(
            model_name='supplier',
            constraint=models.UniqueConstraint(
                Lower('name'), condition=models.Q(is_deleted=False),
                name='uniq_live_supplier_name_ci',
            ),
        ),
    ]
