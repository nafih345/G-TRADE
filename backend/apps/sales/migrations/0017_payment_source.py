from django.db import migrations, models


def mark_billing_receipts(apps, schema_editor):
    # Until now the only receipts linked to a bill were the ones POS Billing takes at the counter,
    # so they're the bill's own billing receipts. Marking them keeps a later New Sale edit of that
    # bill from recording the same money a second time.
    Payment = apps.get_model('sales', 'Payment')
    Payment.objects.filter(invoice__isnull=False).update(source='BILLING')


class Migration(migrations.Migration):

    dependencies = [
        ('sales', '0016_eye_exam_test_no_unique'),
    ]

    operations = [
        migrations.AddField(
            model_name='payment',
            name='source',
            field=models.CharField(blank=True, default='', max_length=20),
        ),
        migrations.RunPython(mark_billing_receipts, migrations.RunPython.noop),
    ]
