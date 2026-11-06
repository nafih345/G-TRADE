"""Accounts (basic) and Financial (enterprise) became two separate modules.

Before this, one 'financial' module key opened both menus. Clients keep their stored 'financial'
key — they stay on Financial (enterprise), so nobody loses their books — and the old
ACCOUNTS_ONLY package (financial + core) is relabelled FINANCIAL_ONLY, which is the same module
set; ACCOUNTS_ONLY now means the new basic Accounts module. The platform account (#1) stores
every module, both tiers included (module_access.subscribed_modules).
"""
from django.db import migrations

PLATFORM_TENANT_ID = 1
# module_access.MODULE_KEYS as of this migration (kept literal: migrations must not follow code).
ALL_MODULES = ['optical', 'sales', 'wholesale', 'inventory', 'purchase', 'accounts', 'financial',
               'admin', 'reports', 'settings']


def forwards(apps, schema_editor):
    Tenant = apps.get_model('common', 'Tenant')
    Tenant.objects.filter(package='ACCOUNTS_ONLY').update(package='FINANCIAL_ONLY')
    Tenant.objects.filter(pk=PLATFORM_TENANT_ID).update(modules=ALL_MODULES)
    # No client may hold both tiers; none could before this migration, but be explicit.
    for tenant in Tenant.objects.exclude(pk=PLATFORM_TENANT_ID):
        mods = list(tenant.modules or [])
        if 'accounts' in mods and 'financial' in mods:
            tenant.modules = [m for m in mods if m != 'accounts']
            tenant.save(update_fields=['modules'])


def backwards(apps, schema_editor):
    Tenant = apps.get_model('common', 'Tenant')
    Tenant.objects.filter(package='ACCOUNTS_ONLY').update(package='CUSTOM')
    Tenant.objects.filter(package='FINANCIAL_ONLY').update(package='ACCOUNTS_ONLY')
    Tenant.objects.filter(package='RETAIL').update(package='CUSTOM')
    for tenant in Tenant.objects.all():
        mods = list(tenant.modules or [])
        if 'accounts' in mods:
            mods = [m for m in mods if m != 'accounts']
            if 'financial' not in mods:
                mods.append('financial')
            tenant.modules = mods
            tenant.save(update_fields=['modules'])


class Migration(migrations.Migration):
    dependencies = [('common', '0006_idempotency_record')]
    operations = [migrations.RunPython(forwards, backwards)]
