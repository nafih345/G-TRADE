import apps.common.models
import django.db.models.deletion
from django.db import migrations, models


def seats_for_existing(apps, schema_editor):
    """Existing clients keep every module (the default) and get enough seats for the accounts
    they already have."""
    Tenant = apps.get_model('common', 'Tenant')
    User = apps.get_model('authentication', 'User')
    for tenant in Tenant.objects.all():
        active = User.objects.filter(tenant_id=tenant.pk, is_active=True).count()
        if active > tenant.max_users:
            tenant.max_users = active
            tenant.save(update_fields=['max_users'])


class Migration(migrations.Migration):

    dependencies = [
        ('common', '0003_tenant_contact'),
        ('authentication', '0002_user_tenant'),
    ]

    operations = [
        migrations.AddField(
            model_name='tenant', name='package',
            field=models.CharField(default='FULL_SUITE', max_length=20),
        ),
        migrations.AddField(
            model_name='tenant', name='modules',
            field=models.JSONField(blank=True, default=apps.common.models._all_modules),
        ),
        migrations.AddField(
            model_name='tenant', name='role_permissions',
            field=models.JSONField(blank=True, default=dict),
        ),
        migrations.AddField(
            model_name='tenant', name='max_users',
            field=models.PositiveIntegerField(default=5),
        ),
        migrations.AddField(
            model_name='tenant', name='deactivation_category',
            field=models.CharField(blank=True, default='', max_length=40),
        ),
        migrations.AddField(
            model_name='tenant', name='deactivation_reason',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AddField(
            model_name='tenant', name='deactivation_effective_date',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='tenant', name='deactivation_until',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='tenant', name='deactivated_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='tenant', name='deactivated_by',
            field=models.CharField(blank=True, default='', max_length=150),
        ),
        migrations.CreateModel(
            name='TenantAuditLog',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False, verbose_name='ID')),
                ('action', models.CharField(max_length=40)),
                ('reason', models.TextField(blank=True, default='')),
                ('effective_date', models.DateField(blank=True, null=True)),
                ('details', models.JSONField(blank=True, default=dict)),
                ('actor', models.CharField(blank=True, default='', max_length=150)),
                ('created_at', models.DateTimeField(auto_now_add=True)),
                ('tenant', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE,
                                             related_name='audit_log', to='common.tenant')),
            ],
            options={'ordering': ['-created_at', '-id']},
        ),
        migrations.RunPython(seats_for_existing, migrations.RunPython.noop),
    ]
