from django.db import migrations, models


class Migration(migrations.Migration):
    """Wholesale Order Status: delivery tracking on WholesaleInvoice.

    Backward compatible: every existing bill gets delivery_status NULL (not tracked) and
    is_posted_to_accounts TRUE, i.e. exactly how it is booked today. db_default keeps a
    code-only rollback able to insert bills."""

    dependencies = [
        ('sales', '0039_backfill_exam_appointment_branch_ref'),
    ]

    operations = [
        migrations.AddField(
            model_name='wholesaleinvoice',
            name='delivery_status',
            field=models.CharField(blank=True, choices=[('PENDING_DELIVERY', 'Invoiced (Pending Delivery)'), ('DELIVERED', 'Delivered / Posted'), ('UNDELIVERED', 'Cancelled / Undelivered')], db_index=True, max_length=20, null=True),
        ),
        migrations.AddField(
            model_name='wholesaleinvoice',
            name='is_posted_to_accounts',
            field=models.BooleanField(db_default=True, default=True),
        ),
        migrations.AddField(
            model_name='wholesaleinvoice',
            name='delivered_on',
            field=models.DateField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='wholesaleinvoice',
            name='delivery_note',
            field=models.TextField(blank=True, default='', db_default=''),
        ),
        migrations.AddField(
            model_name='wholesaleinvoice',
            name='delivery_updated_at',
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='wholesaleinvoice',
            name='delivery_updated_by',
            field=models.CharField(blank=True, default='', db_default='', max_length=150),
        ),
    ]
