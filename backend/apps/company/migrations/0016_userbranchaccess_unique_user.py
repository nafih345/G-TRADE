# P1 Task 4 (constraint): one live access row per user and tenant. The backfill (0015) links at
# most one row per user, so this cannot fail on backfilled data. Reverse = RemoveConstraint.
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('company', '0015_backfill_userbranchaccess_user'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddConstraint(
            model_name='userbranchaccess',
            constraint=models.UniqueConstraint(condition=models.Q(('is_deleted', False), ('user__isnull', False)),
                                               fields=('tenant', 'user'),
                                               name='company_userbranchaccess_tenant_user_uniq'),
        ),
    ]
