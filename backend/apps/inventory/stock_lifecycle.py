"""Stock lifecycle figures for Inventory → Stock Overview.

For a set of products, where their units have gone over their whole life:

  purchased  units received on confirmed Purchase Entries (quantity + free quantity)
  ordered    units held by open customer Orders (sales Invoice rows with document_type ORDER that
             are not drafts, cancelled or already delivered) — reserved, not yet sold
  sold       units on completed sales: retail Invoices (document_type INVOICE, not draft or
             cancelled) + Wholesale invoices (what each one holds out of stock, stock_applied)
  on_hand    Product.stock — the physical count (an Order never moves it; only an Invoice does)
  available  on_hand − ordered, never below 0 — free for an immediate sale
  shortfall  ordered units the shelf cannot cover yet (e.g. a lens ordered from the lab)
  other      on_hand − (purchased − sold): opening stock, Excel loads, manual adjustments and
             any movement not tied to a purchase or sale, so the row always balances:
                 purchased + other = available + ordered + sold   (when nothing is short)

Nothing here moves stock. Converting an Order to an Invoice is the "fulfilment" step: the same
row stops counting as ordered and starts counting as sold, and the Invoice save deducts it from
Product.stock through the usual stock_utils path.

Lens lines count in the product's stock unit (pairs or pieces) via sales.lens_units, the same
rule the sale's own stock movement uses, so these figures match the ledger.
"""
from collections import defaultdict
from decimal import Decimal

from django.db.models import DecimalField, ExpressionWrapper, F, Q, Sum

# Fulfilment stages after which an Order no longer holds stock for the customer.
CLOSED_ORDER_STAGES = ('delivered', 'cancelled', 'canceled')
INACTIVE_DOC_STATUSES = ('DRAFT', 'CANCELLED')


def _blank():
    return {'purchased': 0, 'purchase_value': Decimal('0'), 'ordered': 0, 'sold': 0,
            'sold_retail': 0, 'sold_wholesale': 0}


def _purchases(ids, out):
    from apps.purchasing.models import PurchaseInvoiceItem
    money = DecimalField(max_digits=20, decimal_places=2)
    rows = (PurchaseInvoiceItem.objects
            .filter(product_id__in=ids, purchase_invoice__is_deleted=False)
            .exclude(purchase_invoice__status__in=INACTIVE_DOC_STATUSES)
            .values('product_id')
            .annotate(qty=Sum('quantity'), free=Sum('free_quantity'),
                      value=Sum(ExpressionWrapper(F('quantity') * F('purchase_rate'), output_field=money))))
    for r in rows:
        o = out[r['product_id']]
        o['purchased'] += int((r['qty'] or 0) + (r['free'] or 0))
        o['purchase_value'] += r['value'] or Decimal('0')


def _sales_docs(ids, out):
    """Retail Orders (reserved) and Invoices (sold) in stock units."""
    from apps.sales.lens_units import SELLING_UNITS, stock_units_by_product
    from apps.sales.models import InvoiceItem

    active = (InvoiceItem.objects
              .filter(product_id__in=ids, invoice__is_deleted=False)
              .exclude(invoice__status__in=INACTIVE_DOC_STATUSES))
    open_order = Q(invoice__document_type='ORDER') & ~Q(invoice__fulfillment_status__iregex=(
        r'^\s*(' + '|'.join(CLOSED_ORDER_STAGES) + r')\s*$'))
    kinds = (('sold_retail', active.filter(invoice__document_type='INVOICE')),
             ('ordered', active.filter(open_order)))
    for key, qs in kinds:
        # Plain lines: one line qty = one stock unit — summed in the database.
        for r in (qs.exclude(selling_unit__in=SELLING_UNITS).values('product_id')
                  .annotate(qty=Sum('quantity'))):
            out[r['product_id']][key] += int(r['qty'] or 0)
        # Lens lines: pair rounding is per bill, so group them by document first.
        by_doc = defaultdict(list)
        for item in (qs.filter(selling_unit__in=SELLING_UNITS)
                     .only('invoice_id', 'product_id', 'quantity', 'selling_unit', 'physical_quantity', 'lens_details')):
            by_doc[item.invoice_id].append(item)
        for items in by_doc.values():
            for pid, units in stock_units_by_product(items).items():
                out[pid][key] += int(units or 0)


def _wholesale(ids, out):
    from apps.sales.models import WholesaleInvoice
    keys = [str(pk) for pk in ids]
    wanted = set(keys)
    docs = (WholesaleInvoice.objects
            .filter(stock_applied__isnull=False, stock_applied__items__has_any_keys=keys)
            .values_list('stock_applied', flat=True))
    by_str = {str(pk): pk for pk in ids}
    for applied in docs:
        for pid, units in ((applied or {}).get('items') or {}).items():
            if pid in wanted:
                try:
                    out[by_str[pid]]['sold_wholesale'] += max(int(units), 0)
                except (TypeError, ValueError):
                    continue


def lifecycle_for(products, *, view_cost=True):
    """{product pk: lifecycle dict} for an iterable of Product rows (one page of the grid)."""
    products = list(products)
    if not products:
        return {}
    ids = [p.pk for p in products]
    out = defaultdict(_blank)
    _purchases(ids, out)
    _sales_docs(ids, out)
    _wholesale(ids, out)

    result = {}
    for p in products:
        o = out[p.pk]
        on_hand = int(p.stock or 0)
        sold = o['sold_retail'] + o['sold_wholesale']
        ordered = o['ordered']
        available = max(on_hand - ordered, 0)
        purchased = o['purchased']
        avg = (o['purchase_value'] / purchased).quantize(Decimal('0.01')) if purchased else None
        result[p.pk] = {
            'purchased': purchased,
            'ordered': ordered,
            'sold': sold,
            'sold_retail': o['sold_retail'],
            'sold_wholesale': o['sold_wholesale'],
            'on_hand': on_hand,
            'available': available,
            'shortfall': max(ordered - max(on_hand, 0), 0),
            'other': on_hand - (purchased - sold),
        }
        if view_cost:   # omitted (not null) for users the Show Cost Price setting hides cost from
            result[p.pk]['purchase_value'] = str(o['purchase_value'].quantize(Decimal('0.01')))
            result[p.pk]['avg_purchase_cost'] = str(avg) if avg is not None else None
    return result


def attach_lifecycle(rows, products, *, view_cost=True):
    """Add the lifecycle figures to serialized rows (dicts with 'id') for those products."""
    data = lifecycle_for(products, view_cost=view_cost)
    by_id = {str(pk): v for pk, v in data.items()}
    for row in rows:
        row['lifecycle'] = by_id.get(row['id'])
    return rows
