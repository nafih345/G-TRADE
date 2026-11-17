"""Phase 2 data migration: every existing company (tenant) becomes its own one-company organization.

Safe by construction:
  * touches only the new Organization / OrganizationAdmin tables and the new nullable
    Tenant.organization column; no business row is read, moved, split or changed;
  * existing records stay with exactly the company (tenant) they already belong to — nothing is
    divided between companies, nothing is merged;
  * every organization gets max_companies = 1, so no customer can create a second company until
    the platform admin (or, in P6, the licence) raises the limit: cloud behaviour is unchanged;
  * each company's owners (role SUPER_ADMIN, or Django superusers) administer its organization;
  * idempotent: tenants that already have an organization are skipped;
  * reversible: the reverse clears Tenant.organization and removes the organizations and admin
    rows it can identify. Memberships (none exist before Phase 2 is used) then fail closed.
"""
from django.conf import settings
from django.db import migrations
from django.db.models import Q
from django.utils.text import slugify


def _free_code(taken, base):
    base = (slugify(base) or 'org')[:34]
    code, n = base, 2
    while code in taken:
        code = f'{base}-{n}'
        n += 1
    taken.add(code)
    return code


def forwards(apps, schema_editor):
    Tenant = apps.get_model('common', 'Tenant')
    Organization = apps.get_model('common', 'Organization')
    OrganizationAdmin = apps.get_model('common', 'OrganizationAdmin')
    User = apps.get_model(settings.AUTH_USER_MODEL)
    taken = set(Organization.objects.values_list('code', flat=True))
    for tenant in Tenant.objects.filter(organization__isnull=True).order_by('pk'):
        org = Organization.objects.create(name=tenant.name, code=_free_code(taken, tenant.code or tenant.name),
                                          max_companies=1, is_active=True)
        Tenant.objects.filter(pk=tenant.pk).update(organization=org)
        owners = User.objects.filter(tenant_id=tenant.pk).filter(Q(role='SUPER_ADMIN') | Q(is_superuser=True))
        for user_id in owners.values_list('pk', flat=True):
            OrganizationAdmin.objects.get_or_create(organization=org, user_id=user_id,
                                                    defaults={'granted_by': 'migration'})


def backwards(apps, schema_editor):
    Tenant = apps.get_model('common', 'Tenant')
    Organization = apps.get_model('common', 'Organization')
    OrganizationAdmin = apps.get_model('common', 'OrganizationAdmin')
    OrganizationAdmin.objects.all().delete()
    Tenant.objects.update(organization=None)
    Organization.objects.all().delete()


class Migration(migrations.Migration):

    dependencies = [
        ('common', '0009_organizations'),
        ('authentication', '0004_edit_permissions'),
    ]

    operations = [
        migrations.RunPython(forwards, backwards),
    ]
