from django.db import migrations, models


def backfill_customer_names(apps, schema_editor):
    # Existing bills linked to a patient get that patient's name as their snapshot, so the Orders
    # list keeps showing it even if the patient record is later removed.
    Invoice = apps.get_model('sales', 'Invoice')
    for invoice in Invoice.objects.filter(customer__isnull=False, customer_name='').select_related('customer'):
        name = ' '.join((invoice.customer.name or '').split())[:150]
        if name:
            Invoice.objects.filter(pk=invoice.pk).update(customer_name=name)


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0017_payment_source'),
    ]

    operations = [
        migrations.AddField(
            model_name='invoice',
            name='customer_name',
            field=models.CharField(blank=True, default='', max_length=150),
        ),
        migrations.RunPython(backfill_customer_names, migrations.RunPython.noop),
    ]
