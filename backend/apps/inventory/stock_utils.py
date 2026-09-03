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
    Returns the updated BranchStock row.
    """
    from apps.company.models import BranchStock
    from apps.inventory.models import StockLedger

    if branch is None:
        branch = _default_branch()
    if branch is None or product is None:
        return None

    row, _ = BranchStock.objects.select_for_update().get_or_create(
        product=product, branch=branch, defaults={'quantity': 0}
    )
    row.quantity = (row.quantity or 0) + int(delta)
    row.save(update_fields=['quantity', 'updated_at'])

    _sync_product_total(product)

    if ledger is not None:
        warehouse = ledger.pop('warehouse', None)
        if warehouse is None:
            from apps.company.models import Warehouse
            warehouse = Warehouse.objects.filter(branch=branch).first() or Warehouse.objects.first()
        if warehouse is not None:
            ref = ledger.get('reference_id')
            if not (ref and StockLedger.objects.filter(reference_id=ref, product=product, branch=branch).exists()):
                StockLedger.objects.create(
                    product=product, warehouse=warehouse, branch=branch,
                    quantity=int(delta),
                    transaction_type=ledger.get('transaction_type', 'ADJ_ADD' if delta >= 0 else 'ADJ_SUB'),
                    reference_id=ref,
                    notes=ledger.get('notes', ''),
                )
    return row


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
