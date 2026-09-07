# Generated for the Order / Invoice / Quotation split in the Sales > Orders section.

from django.db import migrations, models


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0012_invoiceitem_item_type_invoiceitem_service_details_and_more'),
    ]

    operations = [
        migrations.AddField(
            model_name='invoice',
            name='document_type',
            field=models.CharField(default='INVOICE', max_length=20),
        ),
    ]
