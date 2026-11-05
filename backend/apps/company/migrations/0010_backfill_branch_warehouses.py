"""Give every branch that has no warehouse a "Main Warehouse".

Clients onboarded before tenant_onboarding created a warehouse had none, so their stock
movements were never written to the stock ledger (StockLedger.warehouse is required) and screens
that pick a warehouse (racks, stock adjustments) had nothing to offer.

Additive only: inserts rows, never updates or deletes existing ones. Re-running is a no-op.
"""
from django.db import migrations


def add_missing_warehouses(apps, schema_editor):
    Branch = apps.get_model('company', 'Branch')
    Warehouse = apps.get_model('company', 'Warehouse')
    with_warehouse = set(Warehouse._base_manager.filter(is_deleted=False).values_list('branch_id', flat=True))
    for branch in Branch._base_manager.filter(is_deleted=False).order_by('created_at'):
        if branch.pk in with_warehouse:
            continue
        taken = set(Warehouse._base_manager.filter(tenant_id=branch.tenant_id).values_list('code', flat=True))
        code = 'WH-MAIN'
        if code in taken:
            code = f"WH-{(branch.code or str(branch.pk)[:6]).upper()}"[:20]
            n = 2
            while code in taken:
                code = f"WH-{str(branch.pk)[:6].upper()}-{n}"
                n += 1
        Warehouse._base_manager.create(tenant_id=branch.tenant_id, branch_id=branch.pk,
                                       name='Main Warehouse', code=code)
        with_warehouse.add(branch.pk)


class Migration(migrations.Migration):

    dependencies = [
        ('company', '0009_pricing_offer'),
    ]

    operations = [
        migrations.RunPython(add_missing_warehouses, migrations.RunPython.noop),
    ]
