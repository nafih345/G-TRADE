"""Per-branch stock helpers.

BranchStock(product, branch) is the source of truth for on-hand quantity once Multi-Branch
is in use. Product.stock is kept as the derived sum across every branch so all the existing
code and screens that read Product.stock keep working unchanged.

Every stock movement (sale, purchase, adjustment, transfer) should go through
adjust_branch_stock so the per-branch quantity, the Product.stock rollup, and the
StockLedger audit row stay consistent.
"""

from django.db import transaction
from django.db.models import Sum


def _default_branch():
    from apps.company.models import Branch
    return Branch.get_default()


@transaction.atomic
def adjust_branch_stock(product, branch, delta, *, ledger=None):
    """Apply `delta` (may be negative) to BranchStock for (product, branch).

    ledger: optional dict of StockLedger kwargs (transaction_type, reference_id, notes,
    warehouse). When given, a StockLedger row is written with the branch attached.
    Returns the updated BranchStock row (or None when the fallback path adjusted
    Product.stock directly because no branch could be resolved).
    """
    from apps.company.models import BranchStock
    from apps.inventory.models import StockLedger

    if product is None:
        return None

    if branch is None:
        branch = _default_branch()

    delta = int(delta)

    if branch is None:
        # Multi-Branch has never been set up (no Branch rows at all) — there is no
        # BranchStock to move, so keep the scalar Product.stock correct directly.
        # Without this the whole call used to no-op and a sale/purchase never changed
        # inventory at all.
        _apply_scalar_stock(product, delta)
        _write_ledger(None, product, delta, ledger)
        return None

    # Use all_objects: the (product, branch) unique constraint still covers soft-deleted rows,
    # so a get_or_create through the default (alive-only) manager would raise IntegrityError if
    # one was ever soft-deleted. Match on any row and revive it instead.
    row, _created = BranchStock.all_objects.select_for_update().get_or_create(
        product=product, branch=branch, defaults={'quantity': 0}
    )
    revived = bool(getattr(row, 'is_deleted', False))
    if revived:
        row.is_deleted = False
    # When this branch holds the product's ONLY stock row (the normal single-branch shop, and
    # every product added by the Excel importer or the Product Master screen — neither touches
    # BranchStock), the scalar Product.stock is the authoritative on-hand figure. Reconcile the
    # row to it before applying `delta` so the movement adds to the real quantity instead of to
    # a freshly-created 0 or a value left stale by a direct Product.stock edit. Without this a
    # purchase of 10 could turn 50 on-hand into 10, and a sale of 1 could turn 50 into -1.
    only_row = not BranchStock.objects.filter(product=product).exclude(pk=row.pk).exists()
    if only_row and (row.quantity or 0) != int(product.stock or 0):
        row.quantity = int(product.stock or 0)

    row.quantity = (row.quantity or 0) + delta
    row.save(update_fields=['quantity', 'updated_at'] + (['is_deleted'] if revived else []))

    _sync_product_total(product)

    _write_ledger(branch, product, delta, ledger)
    return row


@transaction.atomic
def adjust_branch_stock_many(deltas, branch, *, ledger=None):
    """Batched adjust_branch_stock for one document touching many products.

    deltas: {Product instance: delta}. Same rules as adjust_branch_stock — revive soft-deleted
    rows, reconcile a product's only row to Product.stock first, keep Product.stock as the
    sum, one StockLedger row per product — but in a fixed handful of queries instead of ~10
    per product. That difference is what made a many-line Purchase Entry take seconds on the
    hosted database, where every query is a network round trip.
    """
    from django.utils import timezone
    from apps.company.models import BranchStock, Warehouse
    from apps.inventory.models import StockLedger

    deltas = {p: int(d) for p, d in deltas.items() if p is not None}
    if not deltas:
        return
    if branch is None:
        branch = _default_branch()
    if branch is None:
        for product, delta in deltas.items():
            adjust_branch_stock(product, None, delta, ledger=dict(ledger) if ledger else None)
        return

    products = {p.pk: p for p in deltas}
    now = timezone.now()
    # ignore_conflicts: create only the missing rows, and survive a concurrent writer creating
    # the same (product, branch) — the get_or_create race adjust_branch_stock handles.
    BranchStock.all_objects.bulk_create(
        [BranchStock(product_id=pk, branch=branch, quantity=0) for pk in products],
        ignore_conflicts=True,
    )
    rows = list(BranchStock.all_objects.select_for_update()
                .filter(branch=branch, product_id__in=products))
    with_other_rows = set(BranchStock.objects.filter(product_id__in=products)
                          .exclude(pk__in=[r.pk for r in rows])
                          .values_list('product_id', flat=True))
    for row in rows:
        product = products[row.product_id]
        row.is_deleted = False
        if row.product_id not in with_other_rows and (row.quantity or 0) != int(product.stock or 0):
            row.quantity = int(product.stock or 0)
        row.quantity = (row.quantity or 0) + deltas[product]
        row.updated_at = now
    BranchStock.all_objects.bulk_update(rows, ['quantity', 'is_deleted', 'updated_at'])

    totals = dict(BranchStock.objects.filter(product_id__in=products)
                  .values_list('product_id').annotate(t=Sum('quantity')))
    changed = []
    for pk, product in products.items():
        total = totals.get(pk) or 0
        if product.stock != total:
            product.stock = total
            product.updated_at = now
            changed.append(product)
    if changed:
        type(changed[0]).objects.bulk_update(changed, ['stock', 'updated_at'])

    if ledger is None:
        return
    ledger = dict(ledger)
    warehouse = ledger.pop('warehouse', None) or Warehouse.objects.filter(branch=branch).first() \
        or Warehouse.objects.first()
    if warehouse is None:
        return
    ref = ledger.get('reference_id')
    already = set(StockLedger.objects.filter(reference_id=ref, branch=branch, product_id__in=products)
                  .values_list('product_id', flat=True)) if ref else set()
    StockLedger.objects.bulk_create([
        StockLedger(
            product=product, warehouse=warehouse, branch=branch, quantity=delta,
            transaction_type=ledger.get('transaction_type', 'ADJ_ADD' if delta >= 0 else 'ADJ_SUB'),
            reference_id=ref, notes=ledger.get('notes', ''),
        )
        for product, delta in deltas.items() if product.pk not in already
    ])


def _apply_scalar_stock(product, delta):
    product.stock = (product.stock or 0) + delta
    product.save(update_fields=['stock', 'updated_at'])


def _write_ledger(branch, product, delta, ledger):
    if ledger is None:
        return
    from apps.company.models import Warehouse
    from apps.inventory.models import StockLedger

    warehouse = ledger.pop('warehouse', None)
    if warehouse is None:
        if branch is not None:
            warehouse = Warehouse.objects.filter(branch=branch).first()
        warehouse = warehouse or Warehouse.objects.first()
    if warehouse is None:
        # StockLedger.warehouse is non-nullable; without one we can't write the audit row,
        # but the quantity change above still stands.
        return

    ref = ledger.get('reference_id')
    if ref and StockLedger.objects.filter(
        reference_id=ref, product=product, branch=branch
    ).exists():
        return

    StockLedger.objects.create(
        product=product, warehouse=warehouse, branch=branch,
        quantity=delta,
        transaction_type=ledger.get('transaction_type', 'ADJ_ADD' if delta >= 0 else 'ADJ_SUB'),
        reference_id=ref,
        notes=ledger.get('notes', ''),
    )


def _sync_product_total(product):
    from apps.company.models import BranchStock
    total = BranchStock.objects.filter(product=product).aggregate(t=Sum('quantity'))['t'] or 0
    if product.stock != total:
        product.stock = total
        product.save(update_fields=['stock', 'updated_at'])


def get_branch_quantity(product, branch):
    from apps.company.models import BranchStock
    row = BranchStock.objects.filter(product=product, branch=branch).first()
    return row.quantity if row else 0
