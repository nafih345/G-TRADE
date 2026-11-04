"""Go-live date for the new `products.opening_stock` source.

Products that already exist carry opening stock that is either on the books through typed
opening balances or not at all; auto-posting it on their next edit would double-count or
book it piecemeal. So, like the sources 0005 introduced, only products created from today
auto-post; older ones are 'historical' (reviewable in Reconciliation & backfill).
"""
from django.db import migrations
from django.utils import timezone

SOURCE = 'products.opening_stock'


def set_start_date(apps, schema_editor):
    Policy = apps.get_model('financial', 'AccountingPolicy')
    Product = apps.get_model('products', 'Product')
    today = timezone.localdate().isoformat()
    have = set()
    for policy in Policy.objects.all():
        have.add(policy.tenant_id)
        starts = dict(policy.source_start_dates or {})
        if SOURCE not in starts:
            starts[SOURCE] = today
            policy.source_start_dates = starts
            policy.save(update_fields=['source_start_dates'])
    # A tenant with products but no policy row yet would otherwise get no cut-off.
    for tenant_id in Product.objects.exclude(tenant_id__in=have).values_list('tenant_id', flat=True).distinct():
        Policy.objects.create(tenant_id=tenant_id, source_start_dates={SOURCE: today})


class Migration(migrations.Migration):

    dependencies = [
        ('financial', '0011_remove_journalsequence_uniq_journal_sequence_and_more'),
        ('products', '0019_barcodehistory_tenant_barcodesequence_tenant_and_more'),
    ]

    operations = [migrations.RunPython(set_start_date, migrations.RunPython.noop)]
