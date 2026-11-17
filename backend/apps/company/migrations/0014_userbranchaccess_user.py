# P1 Task 4 (schema): stable user id on UserBranchAccess. Nullable, additive; reverse = RemoveField.
import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('company', '0013_private_media_paths'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.AddField(
            model_name='userbranchaccess',
            name='user',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.CASCADE,
                                    related_name='branch_access_rows', to=settings.AUTH_USER_MODEL),
        ),
    ]
