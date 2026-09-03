"""Seed the default branch / business settings and backfill every pre-existing row.

After this migration:
  * exactly one Branch has is_default=True (created if none existed),
  * a Company and a Warehouse for that branch exist (sales/purchase code needs them),
  * BusinessSettings.multi_branch_enabled stays False (single-branch behaviour unchanged),
  * every branch-null Invoice / Payment / PurchaseInvoice / PurchaseOrder / StockLedger /
    StockAdjustment / ChartOfAccount row points at the default branch,
  * one BranchStock row per Product carries that product's current Product.stock.
"""
import datetime
from django.db import migrations


def forwards(apps, schema_editor):
    Company = apps.get_model('company', 'Company')
    Branch = apps.get_model('company', 'Branch')
    Warehouse = apps.get_model('company', 'Warehouse')
    BusinessSettings = apps.get_model('company', 'BusinessSettings')
    Product = apps.get_model('products', 'Product')
    BranchStock = apps.get_model('company', 'BranchStock')

    company = Company.objects.first()
    if company is None:
        today = datetime.date.today()
        company = Company.objects.create(
            name='Main Company', currency='INR',
            fiscal_year_start=datetime.date(today.year, 4, 1),
            fiscal_year_end=datetime.date(today.year + 1, 3, 31),
        )

    branch = Branch.objects.filter(is_default=True).first() or Branch.objects.first()
    if branch is None:
        branch = Branch.objects.create(
            company=company, name='Head Office', code='HO', is_default=True, is_active=True,
        )
    else:
        if not branch.is_default:
            Branch.objects.filter(is_default=True).update(is_default=False)
            branch.is_default = True
        branch.is_active = True
        branch.save()

    if not Warehouse.objects.filter(branch=branch).exists():
        if not Warehouse.objects.exists():
            Warehouse.objects.create(branch=branch, name='Main Warehouse', code='WH-MAIN')

    settings_obj = BusinessSettings.objects.first()
    if settings_obj is None:
        BusinessSettings.objects.create(multi_branch_enabled=False, default_branch=branch)
    elif settings_obj.default_branch_id is None:
        settings_obj.default_branch = branch
        settings_obj.save()

    # Backfill branch on every model that just gained the field.
    pairs = [
        ('sales', 'Invoice'), ('sales', 'Payment'),
        ('purchasing', 'PurchaseInvoice'), ('purchasing', 'PurchaseOrder'),
        ('inventory', 'StockLedger'), ('inventory', 'StockAdjustment'),
        ('financial', 'ChartOfAccount'),
    ]
    for app_label, model_name in pairs:
        try:
            Model = apps.get_model(app_label, model_name)
        except LookupError:
            continue
        Model.objects.filter(branch__isnull=True).update(branch=branch)

    # One BranchStock row per product, seeded from the current scalar Product.stock.
    existing = set(BranchStock.objects.filter(branch=branch).values_list('product_id', flat=True))
    to_create = [
        BranchStock(product_id=p.id, branch=branch, quantity=p.stock or 0)
        for p in Product.objects.all().iterator()
        if p.id not in existing
    ]
    if to_create:
        BranchStock.objects.bulk_create(to_create, batch_size=500)


class Migration(migrations.Migration):

    dependencies = [
        ('company', '0002_alter_branch_options_branch_city_branch_country_and_more'),
        ('sales', '0011_invoice_branch_payment_branch'),
        ('inventory', '0002_stockadjustment_branch_stockledger_branch'),
        ('purchasing', '0007_purchaseorder_branch'),
        ('products', '0008_product_color_size'),
        ('financial', '0003_alter_journalentry_reference_id'),
    ]

    operations = [
        migrations.RunPython(forwards, migrations.RunPython.noop),
    ]
