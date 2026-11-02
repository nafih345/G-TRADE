from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('financial', '0009_bank_book'),
    ]

    operations = [
        migrations.AddField(
            model_name='cheque',
            name='bank_branch',
            field=models.CharField(blank=True, default='', max_length=120),
        ),
    ]
