from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0031_sync_patient_code_sequence'),
    ]

    operations = [
        migrations.AddField(
            model_name='dealer',
            name='shipping_address',
            field=models.TextField(blank=True, default=''),
        ),
    ]
