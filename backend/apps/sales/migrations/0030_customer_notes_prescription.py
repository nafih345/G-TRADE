from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0029_eye_test_fee_bank'),
    ]

    operations = [
        migrations.AddField(
            model_name='customer',
            name='notes',
            field=models.TextField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='customer',
            name='prescription',
            field=models.JSONField(blank=True, default=dict),
        ),
    ]
