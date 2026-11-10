"""Wholesale Orders & Quotations (Wholesale Distribution → Wholesale Orders / Quotations).

Life of the stock behind them (what Inventory → Stock Overview shows):

    Quotation saved              nothing reserved, nothing moved
    Order CONFIRMED (qty X)      Ordered +X, Available −X      (Product.stock untouched)
    Order edited (±Δ)            Ordered ±Δ, Available ∓Δ
    Order CANCELLED              Ordered −X, Available +X
    Order billed in the POS      Ordered −X, Sold +X, On hand −X (Available stays down)
    Direct POS sale              Sold +X, On hand −X

An order only *reserves*: `WholesaleOrder.reserved_items` ({product_id: units}) is rewritten on
every save — its lines while CONFIRMED, {} once BILLED or CANCELLED — and
inventory.stock_lifecycle adds those units to the Ordered column. The physical deduction is
done by the Wholesale POS invoice that bills it (sales.wholesale_stock), exactly like a direct
sale, so nothing is ever deducted twice.

Billing: the POS saves the invoice with details.linkedOrder = {id, orderNumber}. In the
invoice's own transaction link_invoice_orders() checks the order is still CONFIRMED (or already
billed by this same invoice), marks it BILLED and points it at the invoice. If that invoice is
later cancelled, deleted or turned back into a draft, the order is re-opened (CONFIRMED) and
reserves its stock again — so an order can never be billed twice nor silently lost.
"""
from collections import defaultdict

from django.db import transaction
from django.utils import timezone
from rest_framework.exceptions import ValidationError

ORDER_CONFIRMED = 'CONFIRMED'
ORDER_BILLED = 'BILLED'
ORDER_CANCELLED = 'CANCELLED'
ORDER_STATUSES = (ORDER_CONFIRMED, ORDER_BILLED, ORDER_CANCELLED)

QUOTE_OPEN = 'QUOTATION'
QUOTE_ORDERED = 'CONVERTED_TO_ORDER'
QUOTE_BILLED = 'CONVERTED_TO_SALE'
QUOTE_CANCELLED = 'CANCELLED'
QUOTE_STATUSES = (QUOTE_OPEN, QUOTE_ORDERED, QUOTE_BILLED, QUOTE_CANCELLED)

# Invoice states that do not bill anything (the order stays / goes back to CONFIRMED).
_UNBILLED_INVOICE = {'draft', 'cancelled', 'canceled', 'void'}


# ---------------------------------------------------------------------------
# Numbers
# ---------------------------------------------------------------------------

def issue_document_number(model, field, doc_type, fallback_prefix):
    """Next WO-/WQ- number from Settings → Numbering Sequences; when automatic numbering is
    switched off there, the same counter with the default prefix. Call inside a transaction."""
    from apps.common.sequences import bump_sequence
    from apps.company.models import DocumentSequenceCounter
    from apps.company.numbering import issue_number

    def taken(candidate):
        return model.all_objects.filter(**{field: candidate}).exists()

    number = issue_number(doc_type, taken)
    if number:
        return number
    year = timezone.localdate().year
    lookup = {'doc_type': doc_type, 'period_key': f'FALLBACK{year}'}
    for _ in range(500):
        n = bump_sequence(DocumentSequenceCounter, lookup, defaults={'last_number': 0})
        candidate = f'{fallback_prefix}{year}-{n:04d}'
        if not taken(candidate):
            return candidate
    raise ValidationError({'detail': 'Could not issue a document number — try again.'})


# ---------------------------------------------------------------------------
# Lines / reservations
# ---------------------------------------------------------------------------

def _is_stock_line(item):
    return str(item.get('itemType') or 'PRODUCT').upper() != 'SERVICE'


def line_units(item):
    """Units one order line takes out of stock: qty + free qty."""
    try:
        qty = float(item.get('qty') or 0)
    except (TypeError, ValueError):
        qty = 0
    try:
        free = float(item.get('freeQty') or 0)
    except (TypeError, ValueError):
        free = 0
    return max(int(round(qty + free)), 0)


def items_units(items):
    """{product_id (str): units} for the stocked lines of an order / invoice item list."""
    from .wholesale_stock import is_uuid
    out = defaultdict(int)
    for item in items or []:
        if not isinstance(item, dict) or not _is_stock_line(item):
            continue
        pid = str(item.get('id') or '')
        if not is_uuid(pid):
            continue
        units = line_units(item)
        if units:
            out[pid] += units
    return dict(out)


def validate_items(items, *, require_lines=True):
    """Clean the line list from the screen; refuses unknown products and bad quantities."""
    from apps.products.models import Product
    from .wholesale_stock import is_uuid
    if not isinstance(items, list):
        raise ValidationError({'details': 'Line items must be a list.'})
    clean = []
    ids = set()
    for n, item in enumerate(items, start=1):
        if not isinstance(item, dict):
            raise ValidationError({'details': f'Line {n} is not valid.'})
        try:
            qty = float(item.get('qty'))
        except (TypeError, ValueError):
            qty = 0
        if qty <= 0:
            raise ValidationError({'details': f"Line {n} ({item.get('name') or 'item'}): quantity must be at least 1."})
        if _is_stock_line(item):
            pid = str(item.get('id') or '')
            if not is_uuid(pid):
                raise ValidationError({'details': f"Line {n} ({item.get('name') or 'item'}) is not a product saved on the server."})
            ids.add(pid)
        clean.append(item)
    if require_lines and not clean:
        raise ValidationError({'details': 'Add at least one item.'})
    if ids:
        found = {str(pk) for pk in Product.objects.filter(pk__in=ids).values_list('pk', flat=True)}
        missing = ids - found
        if missing:
            names = [str(i.get('name') or i.get('id')) for i in clean if str(i.get('id')) in missing]
            raise ValidationError({'details': f"No longer in the product master: {', '.join(names[:5])}."})
    return clean


def sync_reservation(order):
    """Rewrite what the order reserves from its status + lines (saves only when it changed)."""
    want = items_units((order.details or {}).get('items')) if (
        order.status == ORDER_CONFIRMED and not order.is_deleted) else {}
    if (order.reserved_items or {}) != want:
        order.reserved_items = want
        type(order).all_objects.filter(pk=order.pk).update(reserved_items=want)
    return want


def reserved_by_product(product_ids=None, exclude_order=None):
    """{product_id (str): units} reserved by CONFIRMED wholesale orders."""
    from .models import WholesaleOrder
    qs = WholesaleOrder.objects.filter(status=ORDER_CONFIRMED)
    if exclude_order:
        qs = qs.exclude(pk=exclude_order)
    keys = [str(p) for p in product_ids] if product_ids is not None else None
    if keys is not None:
        if not keys:
            return {}
        qs = qs.filter(reserved_items__has_any_keys=keys)
    wanted = set(keys) if keys is not None else None
    out = defaultdict(int)
    for reserved in qs.values_list('reserved_items', flat=True):
        for pid, units in (reserved or {}).items():
            if wanted is not None and pid not in wanted:
                continue
            try:
                out[pid] += max(int(units), 0)
            except (TypeError, ValueError):
                continue
    return dict(out)


# ---------------------------------------------------------------------------
# Invoice ↔ order link (called from WholesaleInvoiceViewSet in the invoice's transaction)
# ---------------------------------------------------------------------------

def _invoice_bills(invoice):
    if invoice.is_deleted:
        return False
    if (invoice.status or '').strip().lower() in _UNBILLED_INVOICE:
        return False
    details = invoice.details or {}
    return str(details.get('orderStatus') or '').strip().lower() not in _UNBILLED_INVOICE


def _ref_id(details, key):
    from .wholesale_stock import is_uuid
    ref = details.get(key)
    rid = str(ref.get('id') or '') if isinstance(ref, dict) else ''
    return rid if is_uuid(rid) else None


def link_invoice_orders(invoice):
    """Close (or re-open) the wholesale order / quotation a Wholesale POS invoice bills."""
    from .models import WholesaleOrder, WholesaleQuotation
    details = invoice.details or {}
    bills = _invoice_bills(invoice)
    order_id = _ref_id(details, 'linkedOrder') if bills else None

    # Orders this invoice billed before but no longer does (link removed, invoice cancelled /
    # deleted / back to draft): open again, reserving their stock.
    for stale in (WholesaleOrder.all_objects.select_for_update()
                  .filter(invoice_id=invoice.pk).exclude(pk=order_id)):
        stale.status = ORDER_CONFIRMED
        stale.invoice = None
        stale.billed_at = None
        stale.save(update_fields=['status', 'invoice', 'billed_at', 'updated_at'])
        sync_reservation(stale)

    if order_id:
        order = WholesaleOrder.objects.select_for_update().filter(pk=order_id).first()
        if order is None:
            raise ValidationError({'detail': 'The wholesale order linked to this bill no longer exists.'})
        if order.status == ORDER_CANCELLED:
            raise ValidationError({'detail': f'Order {order.order_number} was cancelled — it can\'t be billed.'})
        if order.status == ORDER_BILLED and order.invoice_id and order.invoice_id != invoice.pk:
            billed_no = WholesaleOrder.all_objects.filter(pk=order.pk).values_list('invoice__invoice_number', flat=True).first()
            raise ValidationError({'detail': f'Order {order.order_number} is already billed on {billed_no or "another invoice"}.'})
        if order.dealer_id != invoice.dealer_id:
            raise ValidationError({'detail': f'Order {order.order_number} belongs to another dealer.'})
        if order.status != ORDER_BILLED or order.invoice_id != invoice.pk:
            order.status = ORDER_BILLED
            order.invoice = invoice
            order.billed_at = timezone.now()
            order.save(update_fields=['status', 'invoice', 'billed_at', 'updated_at'])
        sync_reservation(order)
        if invoice.order_ref != order.order_number:
            type(invoice).all_objects.filter(pk=invoice.pk).update(order_ref=order.order_number)

    quote_id = _ref_id(details, 'linkedQuotation') if bills else None
    if quote_id:
        quote = WholesaleQuotation.objects.select_for_update().filter(pk=quote_id).first()
        if quote and quote.status in (QUOTE_OPEN, QUOTE_BILLED):
            quote.status = QUOTE_BILLED
            quote.converted_invoice_number = invoice.invoice_number
            quote.save(update_fields=['status', 'converted_invoice_number', 'updated_at'])


# ---------------------------------------------------------------------------
# Quotation → order
# ---------------------------------------------------------------------------

@transaction.atomic
def convert_quotation_to_order(quote):
    from .models import WholesaleOrder, WholesaleQuotation
    quote = WholesaleQuotation.objects.select_for_update().get(pk=quote.pk)
    if quote.status == QUOTE_ORDERED and quote.converted_order_number:
        existing = WholesaleOrder.objects.filter(order_number=quote.converted_order_number).first()
        if existing:
            return existing, False
    if quote.status not in (QUOTE_OPEN,):
        raise ValidationError({'detail': f'Quotation {quote.quotation_number} is {quote.status.replace("_", " ").lower()} — only an open quotation can become an order.'})
    details = dict(quote.details or {})
    items = validate_items(details.get('items') or [])
    order = WholesaleOrder.objects.create(
        order_number=issue_document_number(WholesaleOrder, 'order_number', 'WHOLESALE_ORDER', 'WO-'),
        dealer=quote.dealer,
        quotation_ref=quote.quotation_number,
        order_date=timezone.localdate(),
        total_amount=quote.grand_total,
        status=ORDER_CONFIRMED,
        details={**details, 'items': items, 'quotationNumber': quote.quotation_number},
    )
    sync_reservation(order)
    quote.status = QUOTE_ORDERED
    quote.converted_order_number = order.order_number
    quote.save(update_fields=['status', 'converted_order_number', 'updated_at'])
    return order, True
