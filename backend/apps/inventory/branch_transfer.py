"""Two-step branch stock transfer (P1 Task 7).

    dispatch(transfer)            DRAFT -> DISPATCHED
        sending branch: stock out (refused below zero while negative stock is off)
        books: Dr Goods in Transit / Cr Inventory (sending branch), at cost
    receive(transfer, {line: qty}) DISPATCHED / PARTIALLY_RECEIVED -> PARTIALLY_RECEIVED / RECEIVED
        receiving branch: stock in; default = everything still in transit
        books: Dr Inventory / Cr Goods in Transit (receiving branch)
    cancel(transfer)              DRAFT -> CANCELLED (nothing moved)
                                  in transit -> CANCELLED / CLOSED: what is still in transit
                                  goes back into the sending branch
        books: Dr Inventory / Cr Goods in Transit (sending branch)

Exactly-once: every step runs under a row lock on the transfer and checks its status first, so a
double click, a retry or two users at once apply it once; each step is a StockTransferEvent whose
id is the reference of its StockLedger rows and its journal. Stock moves through
adjust_branch_stock_many, so BranchStock, Product.stock (sum of branches) and the ledger stay in
step. While goods are in transit Product.stock is lower by the in-transit quantity, shown as
"In transit" (in_transit_by_product).

Authorization (P1): dispatch and cancel need the SENDING branch; receive needs the RECEIVING
branch. Unrestricted users / admins may do all three. Accounting runs after commit through the
posting engine and never blocks a stock movement (a failure lands in the posting-failure queue).
"""
from decimal import Decimal

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import PermissionDenied, ValidationError

ZERO = Decimal('0.00')


class TransferConflict(ValidationError):
    status_code = 409
    default_code = 'transfer_conflict'


def _require(request, branch_id, message):
    if request is None:
        return
    from apps.common.branch_context import require_branch_permitted
    require_branch_permitted(request, branch_id, message)


def _actor(request):
    from apps.common.request_actor import actor_from_request
    return (actor_from_request(request) if request is not None else 'System')[:150]


def _lock(transfer):
    from apps.company.models import StockTransfer
    return StockTransfer.objects.select_for_update(of=('self',)).select_related(
        'from_branch', 'to_branch', 'from_warehouse', 'to_warehouse').get(pk=transfer.pk)


def _warehouse_for(branch, chosen, side):
    from apps.company.models import Warehouse
    if chosen is not None:
        if chosen.branch_id is not None and chosen.branch_id != branch.pk:
            raise ValidationError({f'{side}_warehouse': f'That warehouse is not in {branch.name}.'})
        return chosen
    return Warehouse.objects.filter(branch=branch).order_by('created_at').first()


def validate_transfer(transfer):
    """Checks shared by dispatch: the two branches, their warehouses and the lines."""
    errors = {}
    if transfer.from_branch_id == transfer.to_branch_id:
        errors['to_branch'] = 'The receiving branch must be different from the sending branch.'
    for side in ('from', 'to'):
        branch = getattr(transfer, f'{side}_branch')
        if branch is None or getattr(branch, 'is_deleted', False) or not getattr(branch, 'is_active', True):
            errors[f'{side}_branch'] = 'Choose an active branch.'
    items = list(transfer.items.select_related('product'))
    if not items:
        errors['items'] = 'Add at least one product.'
    for it in items:
        if int(it.quantity or 0) <= 0:
            errors['items'] = 'Every quantity must be more than zero.'
        if it.product is None or getattr(it.product, 'is_deleted', False):
            errors['items'] = 'A product on this transfer no longer exists.'
    if errors:
        raise ValidationError(errors)
    return items


@transaction.atomic
def dispatch(transfer, request=None):
    from apps.company.models import StockTransfer, StockTransferEvent
    from apps.inventory.stock_utils import adjust_branch_stock_many
    t = _lock(transfer)
    _require(request, t.from_branch_id, 'Only the sending branch can dispatch this transfer.')
    if t.status not in StockTransfer.EDITABLE_STATUSES:
        raise TransferConflict({'detail': f'Transfer {t.transfer_number} is already {t.get_status_display().lower()} '
                                          '- it cannot be dispatched again.'})
    items = validate_transfer(t)
    from_wh = _warehouse_for(t.from_branch, t.from_warehouse, 'from')
    _warehouse_for(t.to_branch, t.to_warehouse, 'to')  # validated now, used on receive

    deltas, quantities, value = {}, {}, ZERO
    for it in items:
        cost = Decimal(str(it.product.cost_price or 0)).quantize(Decimal('0.01'))
        it.unit_cost = cost
        it.save(update_fields=['unit_cost', 'updated_at'])
        deltas[it.product] = deltas.get(it.product, 0) - int(it.quantity)
        quantities[str(it.product_id)] = quantities.get(str(it.product_id), 0) + int(it.quantity)
        value += cost * int(it.quantity)
    actor = _actor(request)
    event = StockTransferEvent.objects.create(
        transfer=t, kind='DISPATCH', branch=t.from_branch, warehouse=from_wh, quantities=quantities,
        value=value.quantize(Decimal('0.01')), reference_number=t.transfer_number, performed_by=actor)
    adjust_branch_stock_many(deltas, t.from_branch, enforce_stock=True, ledger={
        'transaction_type': 'TRANSFER', 'reference_id': event.pk, 'reference_number': t.transfer_number,
        'warehouse': from_wh, 'notes': f'Transfer {t.transfer_number} dispatched to {t.to_branch.name}'})
    now = timezone.now()
    t.status, t.dispatched_at, t.dispatched_by, t.from_warehouse = 'DISPATCHED', now, actor, from_wh
    t.save(update_fields=['status', 'dispatched_at', 'dispatched_by', 'from_warehouse', 'updated_at'])
    return t


def _in_transit_lines(t):
    return [it for it in t.items.select_related('product').select_for_update(of=('self',)) if it.in_transit_quantity > 0]


@transaction.atomic
def receive(transfer, quantities=None, request=None):
    """quantities: {item id or product id: units} to receive now; None = everything in transit."""
    from apps.company.models import StockTransfer, StockTransferEvent
    from apps.inventory.stock_utils import adjust_branch_stock_many
    t = _lock(transfer)
    _require(request, t.to_branch_id, 'Only the receiving branch can receive this transfer.')
    if t.status not in StockTransfer.IN_TRANSIT_STATUSES:
        raise TransferConflict({'detail': f'Transfer {t.transfer_number} is {t.get_status_display().lower()} '
                                          '- there is nothing in transit to receive.'})
    lines = _in_transit_lines(t)
    wanted = {}
    if quantities:
        if not isinstance(quantities, dict):
            raise ValidationError({'quantities': 'Send {line id: units}.'})
        by_key = {}
        for it in lines:
            by_key[str(it.pk)] = it
            by_key.setdefault(str(it.product_id), it)
        for key, qty in quantities.items():
            it = by_key.get(str(key))
            try:
                qty = int(qty)
            except (TypeError, ValueError):
                raise ValidationError({'quantities': 'Quantities must be whole numbers.'})
            if it is None:
                raise ValidationError({'quantities': 'A line is not on this transfer or has nothing left in transit.'})
            if qty < 0 or qty > it.in_transit_quantity:
                raise ValidationError({'quantities': f'{it.product.name}: receive between 0 and '
                                                     f'{it.in_transit_quantity}.'})
            if qty:
                wanted[it.pk] = wanted.get(it.pk, 0) + qty
        if not wanted:
            raise ValidationError({'quantities': 'Enter a quantity to receive.'})
    else:
        wanted = {it.pk: it.in_transit_quantity for it in lines}
    to_wh = _warehouse_for(t.to_branch, t.to_warehouse, 'to')
    deltas, moved, value = {}, {}, ZERO
    for it in lines:
        qty = wanted.get(it.pk, 0)
        if not qty:
            continue
        if qty > it.in_transit_quantity:
            raise ValidationError({'quantities': f'{it.product.name}: only {it.in_transit_quantity} in transit.'})
        it.received_quantity = int(it.received_quantity or 0) + qty
        it.save(update_fields=['received_quantity', 'updated_at'])
        deltas[it.product] = deltas.get(it.product, 0) + qty
        moved[str(it.product_id)] = moved.get(str(it.product_id), 0) + qty
        value += (it.unit_cost or ZERO) * qty
    actor = _actor(request)
    event = StockTransferEvent.objects.create(
        transfer=t, kind='RECEIVE', branch=t.to_branch, warehouse=to_wh, quantities=moved,
        value=value.quantize(Decimal('0.01')), reference_number=t.transfer_number, performed_by=actor)
    adjust_branch_stock_many(deltas, t.to_branch, ledger={
        'transaction_type': 'TRANSFER', 'reference_id': event.pk, 'reference_number': t.transfer_number,
        'warehouse': to_wh, 'notes': f'Transfer {t.transfer_number} received from {t.from_branch.name}'})
    remaining = sum(it.in_transit_quantity for it in t.items.all())
    t.status = 'RECEIVED' if remaining == 0 else 'PARTIALLY_RECEIVED'
    t.received_at, t.received_by, t.to_warehouse = timezone.now(), actor, to_wh
    if t.status == 'RECEIVED':
        t.transferred_at = t.received_at
    t.save(update_fields=['status', 'received_at', 'received_by', 'to_warehouse', 'transferred_at', 'updated_at'])
    return t


@transaction.atomic
def cancel(transfer, request=None, reason=''):
    from apps.company.models import StockTransfer, StockTransferEvent
    from apps.inventory.stock_utils import adjust_branch_stock_many
    t = _lock(transfer)
    _require(request, t.from_branch_id, 'Only the sending branch can cancel this transfer.')
    actor = _actor(request)
    now = timezone.now()
    if t.status in StockTransfer.EDITABLE_STATUSES:
        t.status = 'CANCELLED'
    elif t.status in StockTransfer.IN_TRANSIT_STATUSES:
        lines = _in_transit_lines(t)
        from_wh = t.from_warehouse or _warehouse_for(t.from_branch, None, 'from')
        deltas, moved, value = {}, {}, ZERO
        for it in lines:
            qty = it.in_transit_quantity
            it.returned_quantity = int(it.returned_quantity or 0) + qty
            it.save(update_fields=['returned_quantity', 'updated_at'])
            deltas[it.product] = deltas.get(it.product, 0) + qty
            moved[str(it.product_id)] = moved.get(str(it.product_id), 0) + qty
            value += (it.unit_cost or ZERO) * qty
        if deltas:
            event = StockTransferEvent.objects.create(
                transfer=t, kind='RETURN', branch=t.from_branch, warehouse=from_wh, quantities=moved,
                value=value.quantize(Decimal('0.01')), reference_number=t.transfer_number, performed_by=actor)
            adjust_branch_stock_many(deltas, t.from_branch, ledger={
                'transaction_type': 'TRANSFER', 'reference_id': event.pk, 'reference_number': t.transfer_number,
                'warehouse': from_wh, 'notes': f'Transfer {t.transfer_number} cancelled: returned from transit'})
        received_any = any(int(it.received_quantity or 0) > 0 for it in t.items.all())
        t.status = 'CLOSED' if received_any else 'CANCELLED'
    else:
        raise TransferConflict({'detail': f'Transfer {t.transfer_number} is {t.get_status_display().lower()} '
                                          '- it can no longer be cancelled.'})
    t.cancelled_at, t.cancelled_by, t.cancel_reason = now, actor, (reason or '')[:255]
    t.save(update_fields=['status', 'cancelled_at', 'cancelled_by', 'cancel_reason', 'updated_at'])
    return t


def in_transit_by_product(product_ids=None, branch_ids=None):
    """{product_id: units in transit} over DISPATCHED / PARTIALLY_RECEIVED transfers; branch_ids
    limits to transfers sent from or to those branches (a restricted user's view)."""
    from django.db.models import Q
    from apps.company.models import StockTransfer, StockTransferItem
    qs = StockTransferItem.objects.filter(transfer__status__in=StockTransfer.IN_TRANSIT_STATUSES,
                                          transfer__is_deleted=False)
    if product_ids is not None:
        qs = qs.filter(product_id__in=list(product_ids))
    if branch_ids is not None:
        ids = [str(b) for b in branch_ids]
        qs = qs.filter(Q(transfer__from_branch_id__in=ids) | Q(transfer__to_branch_id__in=ids))
    out = {}
    for pid, qty, rec, ret in qs.values_list('product_id', 'quantity', 'received_quantity', 'returned_quantity'):
        left = max(int(qty or 0) - int(rec or 0) - int(ret or 0), 0)
        if left:
            out[str(pid)] = out.get(str(pid), 0) + left
    return out
