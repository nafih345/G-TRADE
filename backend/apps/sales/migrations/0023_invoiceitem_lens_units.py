from django.db import migrations, models


class Migration(migrations.Migration):
    """Pair / single-lens selling units on sales lines. Additive only: existing lines keep blank
    / null values and are treated exactly as before (quantity = stock units)."""

    dependencies = [
        ('sales', '0022_wholesale_invoice_stock_applied'),
    ]

    operations = [
        migrations.AddField(
            model_name='invoiceitem',
            name='selling_unit',
            field=models.CharField(blank=True, default='', max_length=10),
        ),
        migrations.AddField(
            model_name='invoiceitem',
            name='lens_eye',
            field=models.CharField(blank=True, default='', max_length=5),
        ),
        migrations.AddField(
            model_name='invoiceitem',
            name='pricing_unit',
            field=models.CharField(blank=True, default='', max_length=10),
        ),
        migrations.AddField(
            model_name='invoiceitem',
            name='physical_quantity',
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='invoiceitem',
            name='lens_details',
            field=models.JSONField(blank=True, null=True),
        ),
    ]
