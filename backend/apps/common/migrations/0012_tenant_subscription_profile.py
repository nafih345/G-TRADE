"""Client Management: client profile (owner, country, address) and subscription terms (plan,
start / expiry dates, branch limit) on Tenant.

Purely additive. Existing tenants get PERPETUAL with no dates and no branch limit, so nobody's
access changes when this is applied.
"""
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('common', '0011_membership_edit_permissions'),
    ]

    operations = [
        migrations.AddField(
            model_name='tenant', name='owner_name',
            field=models.CharField(blank=True, default='', max_length=150),
        ),
        migrations.AddField(
            model_name='tenant', name='country',
            field=models.CharField(blank=True, default='', max_length=2),
        ),
        migrations.AddField(
            model_name='tenant', name='address',
            field=models.TextField(blank=True, default=''),
        ),
        migrations.AddField(
            model_name='tenant', name='subscription_plan',
            field=models.CharField(choices=[('TRIAL', 'Trial'), ('MONTHLY', 'Monthly'), ('QUARTERLY', 'Quarterly'),
                                            ('HALF_YEARLY', 'Half-yearly'), ('ANNUAL', 'Annual'),
                                            ('PERPETUAL', 'Perpetual (no expiry)')],
                                   default='PERPETUAL', max_length=20),
        ),
        migrations.AddField(
            model_name='tenant', name='subscription_starts_on',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='tenant', name='subscription_expires_on',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='tenant', name='max_branches',
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
    ]
