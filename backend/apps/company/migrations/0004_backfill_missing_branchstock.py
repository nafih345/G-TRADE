"""Backfill BranchStock for products that never got a row, then resync Product.stock.

Migration 0003 seeded one BranchStock row per product that existed *at that time*. Every
product added afterwards (most importantly the Excel importer, which bulk-creates Product
rows and only sets the scalar Product.stock) has no BranchStock row at all. When the first
stock movement then hits adjust_branch_stock, the freshly created row started at 0 and the
Product.stock rollup collapsed to just that delta — so a sale of 1 could turn stock 50 into
-1, and a purchase appeared to "not change" the on-hand figure.

adjust_branch_stock now seeds a product's first BranchStock row from its current
Product.stock, but existing databases still carry products with no row. This migration
creates those rows and re-derives Product.stock from the per-branch total so both agree.
"""
from django.db import migrations
from django.db.models import Sum


def forwards(apps, schema_editor):
    Branch = apps.get_model('company', 'Branch')
    BranchStock = apps.get_model('company', 'BranchStock')
    Product = apps.get_model('products', 'Product')

    branch = Branch.objects.filter(is_default=True).first() or Branch.objects.first()
    if branch is None:
        return

    with_rows = set(BranchStock.objects.values_list('product_id', flat=True))
    to_create = [
        BranchStock(product_id=p.id, branch=branch, quantity=p.stock or 0)
        for p in Product.objects.all().iterator()
        if p.id not in with_rows
    ]
    if to_create:
        BranchStock.objects.bulk_create(to_create, batch_size=500)

    # Re-derive the scalar rollup so Product.stock == sum(BranchStock) everywhere.
    totals = {
        row['product_id']: row['t'] or 0
        for row in BranchStock.objects.values('product_id').annotate(t=Sum('quantity'))
    }
    for p in Product.objects.all().iterator():
        target = totals.get(p.id, 0)
        if p.stock != target:
            p.stock = target
            p.save(update_fields=['stock'])


class Migration(migrations.Migration):

    dependencies = [
        ('company', '0003_multibranch_seed_and_backfill'),
        ('products', '0008_product_color_size'),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
