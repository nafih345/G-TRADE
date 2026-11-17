# P1 Task 6 (data): relational branch for existing eye examinations and appointments, only from an
# unambiguous match of the legacy text (rules E1-E2 in apps/sales/branch_backfill.py). The text
# column is never modified. Unmatched / ambiguous rows stay NULL (Unassigned) and their distinct
# texts are printed for manual mapping (manage.py branch_backfill_report --map ...).
# Reverse: a no-op (the schema reverse of 0037 drops the column).
from django.db import migrations


def forward(apps, schema_editor):
    from apps.sales.branch_backfill import backfill_exam_tenant, tenant_ids
    for tid in tenant_ids(apps.get_model):
        report = backfill_exam_tenant(apps.get_model, tid, apply=True)
        for model, s in report.items():
            if s['matched'] or s['unassigned']:
                texts = ', '.join(f'"{t}"x{n}' for t, n in s['unmatched_texts'].most_common(20))
                print(f'\n  [P1 {model} branch_ref] tenant {tid}: matched={s["matched"]} '
                      f'unassigned={s["unassigned"]} blank_text={s["blank"]}' + (f' unmatched: {texts}' if texts else ''))


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0038_backfill_wholesale_branch'),
    ]

    operations = [
        migrations.RunPython(forward, migrations.RunPython.noop),
    ]
