# P1 Task 5 (data): evidence-only branch for existing wholesale documents. Rules W1-W4 in
# apps/sales/branch_backfill.py; anything without reliable evidence stays NULL (Unassigned) -
# never the default branch. Only NULL branches are filled, so re-running changes nothing.
# Reverse: a no-op (the schema reverse of 0037 drops the column; pre-existing values are never
# touched forward, so there is nothing to restore).
from django.db import migrations


def forward(apps, schema_editor):
    from apps.sales.branch_backfill import backfill_wholesale_tenant, tenant_ids
    for tid in tenant_ids(apps.get_model):
        report = backfill_wholesale_tenant(apps.get_model, tid, apply=True)
        lines = [f'{m}: ' + ', '.join(f'{k}={v}' for k, v in sorted(c.items())) for m, c in report.items() if c]
        if lines:
            print(f'\n  [P1 wholesale branch] tenant {tid}: ' + '; '.join(lines))


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0037_wholesale_exam_branch'),
        ('inventory', '0006_returns_modules'),
        ('common', '0008_tenant_defaults_version'),
    ]

    operations = [
        migrations.RunPython(forward, migrations.RunPython.noop),
    ]
