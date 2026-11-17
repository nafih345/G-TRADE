# P1 Task 4 (data): link every user to exactly the access row the old username rule gave them.
# See apps/company/branch_access_backfill.py for the rules. Idempotent; never deletes or
# overwrites. Reverse: unlink (user_id -> NULL) — the schema reverse then drops the column.
# Copies made for case-variant usernames carry the same permissions as the row they were
# copied from, so they are harmless under the old username rule too and are kept.
from django.conf import settings
from django.db import migrations


def forward(apps, schema_editor):
    from apps.company.branch_access_backfill import backfill_all, summary_line
    Access = apps.get_model('company', 'UserBranchAccess')
    User = apps.get_model(*settings.AUTH_USER_MODEL.split('.'))
    Tenant = apps.get_model('common', 'Tenant')
    for report in backfill_all(Access, User, Tenant, apply=True):
        if report['rows'] or report['users']:
            print(f'\n  [P1 branch access] {summary_line(report)}')
            for key in ('cloned', 'orphan', 'superseded'):
                if report[key]:
                    print(f'    {key}: {", ".join(report[key][:50])}')


def backward(apps, schema_editor):
    Access = apps.get_model('company', 'UserBranchAccess')
    Access._base_manager.update(user=None)


class Migration(migrations.Migration):

    dependencies = [
        ('company', '0014_userbranchaccess_user'),
        ('common', '0008_tenant_defaults_version'),
        ('authentication', '0004_edit_permissions'),
    ]

    operations = [
        migrations.RunPython(forward, backward),
    ]
