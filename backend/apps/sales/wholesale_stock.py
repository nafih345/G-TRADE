"""Stock movement for Wholesale POS invoices (sales.WholesaleInvoice).

The invoice's line items live in `details['items']` (the POS record). Every save runs
sync_wholesale_invoice_stock, which brings stock in line with what the invoice now says:

    completed sale         -> deduct qty + free qty of each stocked line
    edited                 -> deduct / restore only the difference
    cancelled / draft /
    returned / replaced /
    deleted                -> restore everything it took

What has been taken is recorded on the invoice (`stock_applied`), so a re-save never
deducts twice. Each movement is a StockAdjustment (when a warehouse exists) — that is what
books COGS / Inventory in the ledger — and goes through adjust_branch_stock like every other
stock change.

Invoices saved before this existed (stock_applied is null) had their stock moved by the POS
screen itself through /api/inventory/adjustments/ with fixed reasons; those rows are read
back once as the starting point so a later cancel restores exactly what was taken.
"""
import re
import uuid
from collections import defaultdict

from django.db.models import Q

SALE_REASON = 'Wholesale POS sale {no}'
REVERSAL_REASON = 'Wholesale POS sale reversal {no}'

# Reasons the POS screen used before the backend moved wholesale stock (still sent by an
# old cached build of the frontend — see guard_legacy_pos_adjustment).
LEGACY_SUB_REASONS = ('Wholesale POS sale',)
LEGACY_ADD_REASONS = ('Cancelled wholesale invoice', 'Sales return for', 'Replacement for')
_LEGACY_RE = re.compile(
    r'^(%s) (\S+)$' % '|'.join(re.escape(r) for r in LEGACY_SUB_REASONS + LEGACY_ADD_REASONS))

def is_uuid(value):
    try:
        uuid.UUID(str(value))
        return True
    except (TypeError, ValueError):
        return False


INACTIVE_STATUSES = {'draft', 'cancelled', 'canceled', 'void'}


def _is_active(inv):
    details = inv.details or {}
    if inv.is_deleted:
        return False
    if (inv.status or '').strip().lower() in INACTIVE_STATUSES:
        return False
    if str(details.get('orderStatus') or '').strip().lower() in INACTIVE_STATUSES:
        return False
    # Whole-invoice Sales Return / Replacement from the POS "More Actions" menu.
    return not details.get('stockReturned')


def _resolve_product(item, cache):
    from apps.products.models import Product
    pid, code = str(item.get('id') or ''), str(item.get('code') or '').strip()
    key = pid or code
    if key in cache:
        return cache[key]
    product = None
    if is_uuid(pid):
        product = Product.all_objects.filter(pk=pid).first()
    if product is None and code:
        product = Product.objects.filter(Q(sku=code) | Q(barcode=code)).first()
    cache[key] = product
    return product


def desired_quantities(inv):
    """{product_id (str): units} the invoice should currently hold out of stock."""
    if not _is_active(inv):
        return {}
    out = defaultdict(int)
    cache = {}
    for item in (inv.details or {}).get('items') or []:
        if not isinstance(item, dict) or item.get('itemType') == 'SERVICE':
            continue
        try:
            units = float(item.get('qty') or 0) + float(item.get('freeQty') or 0)
        except (TypeError, ValueError):
            continue
        units = int(round(units))
        if units <= 0:
            continue
        product = _resolve_product(item, cache)
        if product is not None:
            out[str(product.pk)] += units
    return dict(out)


def _legacy_applied(inv):
    """What the old POS-side adjustments took for this invoice (net of its restocks)."""
    from apps.inventory.models import StockAdjustment
    no = inv.invoice_number
    sub = [f'{r} {no}' for r in LEGACY_SUB_REASONS]
    add = [f'{r} {no}' for r in LEGACY_ADD_REASONS]
    rows = StockAdjustment.objects.filter(reason__in=sub + add).order_by('created_at')
    items = defaultdict(int)
    branch = warehouse = None
    for adj in rows:
        sign = 1 if adj.reason in sub and adj.adjustment_type == 'SUB' else -1
        items[str(adj.product_id)] += sign * adj.quantity
        branch = branch or (str(adj.branch_id) if adj.branch_id else None)
        warehouse = warehouse or str(adj.warehouse_id)
    return {'branch': branch, 'warehouse': warehouse,
            'items': {pid: q for pid, q in items.items() if q > 0}}


def _location(inv, request):
    """(branch, warehouse) the sale's stock leaves from: the POS's chosen warehouse, else the
    request's / default branch and its first warehouse. Either may be None (no Branch set up)."""
    from apps.common.branch_context import get_active_branch
    from apps.company.models import Branch, Warehouse
    wid = str((inv.details or {}).get('warehouseId') or '')
    warehouse = Warehouse.objects.filter(pk=wid).select_related('branch').first() if is_uuid(wid) else None
    if warehouse is not None:
        return warehouse.branch, warehouse
    branch = (get_active_branch(request) if request is not None else None) or Branch.get_default()
    warehouse = None
    if branch is not None:
        warehouse = Warehouse.objects.filter(branch=branch).order_by('created_at').first()
    warehouse = warehouse or Warehouse.objects.order_by('created_at').first()
    return branch, warehouse


def _move(inv, product, branch, warehouse, delta, enforce_stock):
    """delta > 0 takes stock out (sale), < 0 puts it back."""
    from apps.inventory.models import StockAdjustment
    from apps.inventory.stock_utils import adjust_branch_stock
    qty = abs(int(delta))
    reason = (SALE_REASON if delta > 0 else REVERSAL_REASON).format(no=inv.invoice_number)
    ledger = None
    if warehouse is not None:
        adj = StockAdjustment.objects.create(
            product=product, warehouse=warehouse, branch=branch, quantity=qty,
            adjustment_type='SUB' if delta > 0 else 'ADD', reason=reason,
            reference=inv.invoice_number[:100])
        ledger = {'warehouse': warehouse, 'transaction_type': 'ADJ_SUB' if delta > 0 else 'ADJ_ADD',
                  'reference_id': adj.id, 'notes': reason}
    adjust_branch_stock(product, branch, -int(delta), ledger=ledger, enforce_stock=enforce_stock)


def sync_wholesale_invoice_stock(inv, request=None, enforce_stock=True):
    """Bring stock in line with the invoice. Call inside the transaction that saved it; a
    shortfall (negative stock switched off) raises a 400 and rolls the save back."""
    from apps.company.models import Branch, Warehouse
    from apps.products.models import Product

    details = inv.details or {}
    if not isinstance(details.get('items'), list):
        # A bare legacy row (totals only): its contents are unknown, so never guess a movement.
        return
    applied = inv.stock_applied if inv.stock_applied is not None else _legacy_applied(inv)
    old_items = {k: int(v) for k, v in (applied.get('items') or {}).items() if int(v) > 0}
    new_items = desired_quantities(inv)

    if new_items:
        branch, warehouse = _location(inv, request)
    else:
        branch = Branch.objects.filter(pk=applied.get('branch')).first() if applied.get('branch') else None
        warehouse = Warehouse.objects.filter(pk=applied.get('warehouse')).first() if applied.get('warehouse') else None
    new_loc = {'branch': str(branch.pk) if branch else None, 'warehouse': str(warehouse.pk) if warehouse else None}
    same_place = not old_items or not new_items or applied.get('branch') == new_loc['branch']

    products = {str(pk): p for pk, p in Product.all_objects.in_bulk(list(set(old_items) | set(new_items))).items()}
    if same_place:
        moves = [(pid, new_items.get(pid, 0) - old_items.get(pid, 0), branch, warehouse)
                 for pid in set(old_items) | set(new_items)]
    else:
        # The sale moved to another branch: put everything back where it came from, then
        # take the new quantities from the new branch.
        old_branch = Branch.objects.filter(pk=applied.get('branch')).first() if applied.get('branch') else None
        old_wh = Warehouse.objects.filter(pk=applied.get('warehouse')).first() if applied.get('warehouse') else None
        moves = [(pid, -q, old_branch, old_wh) for pid, q in old_items.items()]
        moves += [(pid, q, branch, warehouse) for pid, q in new_items.items()]

    # Restores first, so an edit that swaps one product for another never trips the
    # negative-stock guard on the way.
    for pid, delta, b, w in sorted(moves, key=lambda m: m[1]):
        if delta and pid in products:
            _move(inv, products[pid], b, w, delta, enforce_stock and delta > 0)

    inv.stock_applied = {**new_loc, 'items': new_items}
    type(inv).all_objects.filter(pk=inv.pk).update(stock_applied=inv.stock_applied)


def guard_legacy_pos_adjustment(reason):
    """An old cached POS build still posts its own adjustment after saving the invoice. Once
    the backend moves that invoice's stock (stock_applied set), that adjustment would count the
    sale twice — return an error message to refuse it, else None."""
    from apps.sales.models import WholesaleInvoice
    m = _LEGACY_RE.match((reason or '').strip())
    if not m:
        return None
    inv = WholesaleInvoice.all_objects.filter(invoice_number=m.group(2)).only('stock_applied').first()
    if inv is not None and inv.stock_applied is not None:
        return (f'Stock for wholesale invoice {m.group(2)} is moved by the invoice itself; '
                'this adjustment was not applied.')
    return None
