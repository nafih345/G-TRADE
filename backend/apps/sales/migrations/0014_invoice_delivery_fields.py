# Generated for the Sales > Orders "Update / Mark Delivered" feature.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0013_invoice_document_type'),
    ]

    operations = [
        migrations.AddField(
            model_name='invoice',
            name='delivered_at',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='invoice',
            name='fulfillment_notes',
            field=models.CharField(blank=True, max_length=255, null=True),
        ),
    ]
