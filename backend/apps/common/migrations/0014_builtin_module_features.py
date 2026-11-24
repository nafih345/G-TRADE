"""Wholesale Order Status and Bill-to-Bill Settlement are built into their modules.

module_access marks both FIXED, so they are on for every business that has the parent module
regardless of what is stored. This records it in the data as well: every existing tenant (cloud
clients, the Windows installation's companies) gets both keys stored as on, so a client that had
switched one off reads consistently everywhere. New tenants need nothing: fixed features are
on by rule. Runs the same on cloud and on the Windows edition; idempotent.
"""
from django.db import migrations

BUILT_IN = ('wholesale_order_status', 'bill_settlement')


def switch_on(apps, schema_editor):
    Tenant = apps.get_model('common', 'Tenant')
    for tenant in Tenant.objects.all().only('pk', 'module_features'):
        features = dict(tenant.module_features or {})
        if all(features.get(k) is True for k in BUILT_IN):
            continue
        features.update({k: True for k in BUILT_IN})
        Tenant.objects.filter(pk=tenant.pk).update(module_features=features)


class Migration(migrations.Migration):

    dependencies = [
        ('common', '0013_tenant_module_features'),
    ]

    operations = [migrations.RunPython(switch_on, migrations.RunPython.noop)]
