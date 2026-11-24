from django.db import migrations, models


class Migration(migrations.Migration):
    """Tenant.module_features — opt-in switches inside a module (Wholesale Order Status first).
    Every existing tenant gets {} (all features off), so nothing changes until one is switched on.
    Nullable so a code-only rollback can still insert tenants (NULL reads as {})."""

    dependencies = [
        ('common', '0012_tenant_subscription_profile'),
    ]

    operations = [
        migrations.AddField(
            model_name='tenant',
            name='module_features',
            field=models.JSONField(blank=True, default=dict, null=True),
        ),
    ]
