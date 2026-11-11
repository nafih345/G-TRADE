"""Sales Return & Purchase Return — one service for both directions.

    /api/sales/returns/                      GET list (search, date_from, date_to, status) · POST create
    /api/sales/returns/<id>/                 GET one return with its lines
    /api/sales/returns/<id>/cancel/          POST {reason} — puts the stock back, reverses the journal
    /api/sales/returns/meta/                 GET reasons + settlement modes
    /api/sales/returns/source-documents/     GET ?search= — invoices a return can be made against
    /api/sales/returns/returnable/           GET ?document=<invoice id> — its lines + qty still returnable
    /api/sales/returns/report/               GET ?date_from&date_to — rows + summary for the Sales Report

and the same under /api/purchase/returns/ for Purchase Returns (original = a Purchase Entry).

On save, inside one transaction:
  * every line is checked (a line taken from the original bill can't return more than was sold /
    bought minus what earlier returns took back; reason mandatory, a note for Other / Exchange),
  * the settlement (Cash / GPay / Bank / Credit, splits allowed) must cover the return exactly and
    every GPay / Bank row needs a bank ledger,
  * stock moves through stock_utils.adjust_branch_stock_many — IN for a sales return, OUT for a
    purchase return (refused when it would go negative while negative stock is off), with
    StockLedger rows stamped source_type SALES_RETURN / PURCHASE_RETURN,
  * a purchase return settled on Credit lowers the supplier's outstanding balance.
The journal itself is posted by the accounting engine after commit (financial.posting_rules
build_sales_return / build_purchase_return); a failure there is queued, never lost, and never
rolls the return back.

"Return Stock" in Stock Overview is derived from these lines (live returns only), so nothing
keeps a separate counter that could drift.
"""
import uuid
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from types import SimpleNamespace

from django.db import transaction
from django.db.models import F, Prefetch, Q, Sum
from django.utils import timezone
from django.utils.dateparse import parse_date
from rest_framework import mixins, permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.common.branch_mixins import BranchScopedViewSetMixin
from apps.common.pagination import PageSizePagination
from apps.common.request_actor import actor_from_request

from .returns_catalog import (
    BANK_MODES, MODE_LABELS, REASON_LABELS, REASONS_NEEDING_NOTE, RETURN_REASONS, SETTLEMENT_MODES,
)
from .stock_utils import adjust_branch_stock_many

ZERO = Decimal('0.00')
CENT = Decimal('0.01')
MAX_LINES = 200
INACTIVE_DOC_STATUSES = ('DRAFT', 'CANCELLED')


class ReturnError(serializers.ValidationError):
    pass


def money(value):
    try:
        return Decimal(str(value if value not in (None, '') else 0)).quantize(CENT, rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError, TypeError):
        raise ReturnError({'detail': f"'{value}' is not a valid amount."})


def _is_uuid(value):
    try:
        uuid.UUID(str(value))
        return True
    except (TypeError, ValueError, AttributeError):
        return False


def inclusive_tax(line_total, rate):
    """Tax inside a tax-inclusive amount."""
    rate = Decimal(str(rate or 0))
    if rate <= 0 or line_total <= 0:
        return ZERO
    return money(line_total * rate / (Decimal('100') + rate))


def _int(value, field, errors, minimum=1):
    try:
        n = int(Decimal(str(value)))
    except (InvalidOperation, ValueError, TypeError):
        errors.append(f"{field}: enter a whole number.")
        return None
    if n < minimum:
        errors.append(f"{field}: must be at least {minimum}.")
        return None
    return n


# ---------------------------------------------------------------------------------------------
# Direction-specific behaviour
# ---------------------------------------------------------------------------------------------
class SalesKind:
    key = 'sales'
    label = 'Sales Return'
    doc_type = 'SALES_RETURN'
    fallback_prefix = 'SR'
    stock_sign = 1                      # goods come back in
    ledger_type = 'IN'
    source_type = 'SALES_RETURN'

    @staticmethod
    def models():
        from apps.sales.models import SalesReturn, SalesReturnItem
        return SalesReturn, SalesReturnItem

    @staticmethod
    def original_models():
        from apps.sales.models import Invoice, InvoiceItem
        return Invoice, InvoiceItem

    original_fk = 'original_invoice'
    item_parent = 'sales_return'
    original_item_parent = 'invoice'

    # -- original documents ---------------------------------------------------------------
    @classmethod
    def live_originals(cls):
        Invoice, _ = cls.original_models()
        return (Invoice.objects.filter(document_type='INVOICE')
                .exclude(status__in=INACTIVE_DOC_STATUSES))

    @classmethod
    def search_originals(cls, term):
        qs = cls.live_originals()
        if term:
            qs = qs.filter(Q(invoice_number__icontains=term) | Q(customer_name__icontains=term)
                           | Q(customer__phone__icontains=term) | Q(customer__patient_code__iexact=term))
        rows = qs.select_related('customer').order_by('-invoice_date', '-created_at')[:30]
        return [{
            'id': str(i.pk), 'number': i.invoice_number, 'date': i.invoice_date.isoformat() if i.invoice_date else None,
            'party_name': i.customer_name or (i.customer.name if i.customer_id and i.customer else ''),
            'party_id': str(i.customer_id) if i.customer_id else None,
            'party_phone': (i.customer.phone if i.customer_id and i.customer else '') or '',
            'total': str(money(i.net_amount or i.total_amount)),
        } for i in rows]

    @staticmethod
    def original_number(doc):
        return doc.invoice_number

    @staticmethod
    def original_date(doc):
        return doc.invoice_date

    @staticmethod
    def returnable_items(doc):
        return [it for it in doc.items.all().select_related('product')
                if it.product_id and (it.item_type or '').upper() != 'SERVICE' and (it.quantity or 0) > 0]

    @staticmethod
    def original_qty(item):
        return int(item.quantity or 0)

    @staticmethod
    def price_factor(doc):
        """A bill-level discount comes off every line pro rata: refunds follow what was charged."""
        lines = sum((money(it.subtotal) for it in doc.items.all()), ZERO)
        net = money(doc.net_amount) or money(doc.total_amount)
        if lines > 0 and 0 < net < lines:
            return net / lines
        return Decimal('1')

    @classmethod
    def unit_terms(cls, item, factor):
        """(unit price incl. tax, tax rate %) the original line was charged at."""
        qty = max(int(item.quantity or 0), 1)
        unit = money(money(item.subtotal) * factor / qty)
        if unit <= 0:
            unit = money(item.unit_price)
        return unit, Decimal(str(item.tax_rate or 0))

    @staticmethod
    def item_description(item):
        return item.description or (item.product.name if item.product_id and item.product else 'Item')

    @staticmethod
    def stock_units(item, qty):
        """Stock units `qty` of this line moves (lens pairs / pieces follow sales.lens_units)."""
        if item is None or not getattr(item, 'selling_unit', ''):
            return qty
        from apps.sales.lens_units import stock_units_by_product
        probe = SimpleNamespace(product_id=item.product_id, quantity=qty, selling_unit=item.selling_unit,
                                physical_quantity=None, lens_details=item.lens_details)
        return int(stock_units_by_product([probe]).get(item.product_id, qty))

    @staticmethod
    def unit_cost(item, product):
        return money(getattr(product, 'cost_price', 0))

    # -- party ----------------------------------------------------------------------------
    @staticmethod
    def party_fields(data, original, errors):
        from apps.sales.models import Customer
        out = {'customer': None, 'customer_name': '', 'customer_phone': ''}
        cust_id = data.get('customer') or data.get('party')
        if original is not None:
            out['customer'] = original.customer if original.customer_id else None
            out['customer_name'] = original.customer_name or (original.customer.name if original.customer_id else '')
        elif cust_id:
            cust = Customer.objects.filter(pk=cust_id).first() if _is_uuid(cust_id) else None
            if cust is None:
                errors.append('Customer not found.')
            else:
                out['customer'] = cust
                out['customer_name'] = cust.name
        typed = str(data.get('customer_name') or data.get('party_name') or '').strip()[:150]
        if typed and not out['customer_name']:
            out['customer_name'] = typed
        phone = str(data.get('customer_phone') or '').strip()[:20]
        out['customer_phone'] = phone or (out['customer'].phone if out['customer'] is not None and out['customer'].phone else '') or ''
        if not out['customer_name']:
            out['customer_name'] = 'Walk-in Customer'
        return out

    @staticmethod
    def party_of(ret):
        return {'id': str(ret.customer_id) if ret.customer_id else None, 'name': ret.customer_name,
                'phone': ret.customer_phone}

    @staticmethod
    def original_ref(ret):
        return {'id': str(ret.original_invoice_id) if ret.original_invoice_id else None,
                'number': ret.original_invoice_number}

    @staticmethod
    def set_original(fields, original):
        fields['original_invoice'] = original
        fields['original_invoice_number'] = original.invoice_number if original else ''

    @staticmethod
    def search_q(term):
        return (Q(return_number__icontains=term) | Q(original_invoice_number__icontains=term)
                | Q(customer_name__icontains=term) | Q(customer_phone__icontains=term)
                | Q(items__description__icontains=term) | Q(items__barcode__iexact=term))

    @staticmethod
    def after_save(ret, sign):
        """Sales returns keep no denormalised party balance (the ledger is the balance)."""

    @staticmethod
    def list_related():
        return ('customer', 'bank_account', 'original_invoice')


class PurchaseKind(SalesKind):
    key = 'purchase'
    label = 'Purchase Return'
    doc_type = 'PURCHASE_RETURN'
    fallback_prefix = 'PR'
    stock_sign = -1                     # goods go back to the supplier
    ledger_type = 'OUT'
    source_type = 'PURCHASE_RETURN'
    original_fk = 'original_bill'
    item_parent = 'purchase_return'
    original_item_parent = 'purchase_invoice'

    @staticmethod
    def models():
        from apps.purchasing.models import PurchaseReturn, PurchaseReturnItem
        return PurchaseReturn, PurchaseReturnItem

    @staticmethod
    def original_models():
        from apps.purchasing.models import PurchaseInvoice, PurchaseInvoiceItem
        return PurchaseInvoice, PurchaseInvoiceItem

    @classmethod
    def live_originals(cls):
        PurchaseInvoice, _ = cls.original_models()
        return PurchaseInvoice.objects.exclude(status__in=INACTIVE_DOC_STATUSES)

    @classmethod
    def search_originals(cls, term):
        qs = cls.live_originals()
        if term:
            qs = qs.filter(Q(invoice_number__icontains=term) | Q(supplier_invoice_number__icontains=term)
                           | Q(supplier__name__icontains=term))
        rows = qs.select_related('supplier').order_by('-purchase_date', '-created_at')[:30]
        return [{
            'id': str(p.pk), 'number': p.invoice_number, 'date': p.purchase_date.isoformat() if p.purchase_date else None,
            'supplier_invoice_number': p.supplier_invoice_number or '',
            'party_name': p.supplier.name if p.supplier_id else '', 'party_id': str(p.supplier_id) if p.supplier_id else None,
            'party_phone': (p.supplier.phone if p.supplier_id else '') or '',
            'total': str(money(p.grand_total)),
        } for p in rows]

    @staticmethod
    def original_number(doc):
        return doc.invoice_number

    @staticmethod
    def original_date(doc):
        return doc.purchase_date

    @staticmethod
    def returnable_items(doc):
        return [it for it in doc.items.all().select_related('product') if it.product_id
                and (it.quantity or 0) + (it.free_quantity or 0) > 0]

    @staticmethod
    def original_qty(item):
        return int((item.quantity or 0) + (item.free_quantity or 0))

    @staticmethod
    def price_factor(doc):
        return Decimal('1')

    @classmethod
    def unit_terms(cls, item, factor):
        paid_qty = Decimal(str(item.quantity or 0))
        total = money(item.line_total)
        if paid_qty > 0 and total > 0:
            unit = money(total / paid_qty)
        else:
            unit = money(item.purchase_rate)
        rate = Decimal(str(item.gst_percent or 0)) or Decimal(str(item.vat_percent or 0))
        return unit, rate

    @staticmethod
    def item_description(item):
        return item.product.name if item.product_id and item.product else 'Item'

    @staticmethod
    def stock_units(item, qty):
        return qty

    @staticmethod
    def unit_cost(item, product):
        if item is not None and money(item.purchase_rate) > 0:
            return money(item.purchase_rate)
        return money(getattr(product, 'cost_price', 0))

    @staticmethod
    def party_fields(data, original, errors):
        from apps.purchasing.models import Supplier
        supplier = original.supplier if original is not None else None
        sup_id = data.get('supplier') or data.get('party')
        if supplier is None and sup_id:
            supplier = Supplier.all_objects.filter(pk=sup_id).first() if _is_uuid(sup_id) else None
        if supplier is None:
            errors.append('Choose the supplier the goods are going back to.')
        return {'supplier': supplier,
                'supplier_invoice_number': (original.supplier_invoice_number or '') if original is not None
                else str(data.get('supplier_invoice_number') or '').strip()[:100]}

    @staticmethod
    def party_of(ret):
        s = ret.supplier
        return {'id': str(ret.supplier_id), 'name': s.name if s else '', 'phone': (s.phone if s else '') or ''}

    @staticmethod
    def original_ref(ret):
        return {'id': str(ret.original_bill_id) if ret.original_bill_id else None,
                'number': ret.original_bill_number, 'supplier_invoice_number': ret.supplier_invoice_number}

    @staticmethod
    def set_original(fields, original):
        fields['original_bill'] = original
        fields['original_bill_number'] = original.invoice_number if original else ''

    @staticmethod
    def search_q(term):
        return (Q(return_number__icontains=term) | Q(original_bill_number__icontains=term)
                | Q(supplier_invoice_number__icontains=term) | Q(supplier__name__icontains=term)
                | Q(items__description__icontains=term) | Q(items__barcode__iexact=term))

    @staticmethod
    def after_save(ret, sign):
        """A Credit settlement is set off against what we owe the supplier (Supplier.outstanding_balance
        is the running figure the Purchase screens show). sign=+1 on save, -1 on cancel."""
        credit = sum((money(s.get('amount')) for s in (ret.settlements or []) if s.get('mode') == 'CREDIT'), ZERO)
        if credit and ret.supplier_id:
            from apps.purchasing.models import Supplier
            Supplier.all_objects.filter(pk=ret.supplier_id).update(
                outstanding_balance=F('outstanding_balance') - credit * sign)

    @staticmethod
    def list_related():
        return ('supplier', 'bank_account', 'original_bill')


KINDS = {'sales': SalesKind, 'purchase': PurchaseKind}


# ---------------------------------------------------------------------------------------------
# Returned quantities
# ---------------------------------------------------------------------------------------------
def returned_qty_by_original_item(kind, item_ids, exclude_return=None):
    """{original item id: units already returned} over live returns."""
    _, Item = kind.models()
    if not item_ids:
        return {}
    qs = Item.objects.filter(original_item_id__in=list(item_ids),
                             **{f'{kind.item_parent}__is_deleted': False}) \
        .exclude(**{f'{kind.item_parent}__status': 'CANCELLED'})
    if exclude_return is not None:
        qs = qs.exclude(**{kind.item_parent: exclude_return})
    return {r['original_item_id']: int(r['q'] or 0)
            for r in qs.values('original_item_id').annotate(q=Sum('return_qty'))}


def returnable_lines(kind, doc):
    items = kind.returnable_items(doc)
    done = returned_qty_by_original_item(kind, [it.pk for it in items])
    factor = kind.price_factor(doc)
    out = []
    for it in items:
        sold = kind.original_qty(it)
        already = done.get(it.pk, 0)
        unit, rate = kind.unit_terms(it, factor)
        p = it.product
        out.append({
            'original_item': str(it.pk),
            'product': str(it.product_id),
            'description': kind.item_description(it),
            'sku': getattr(p, 'sku', '') or '', 'barcode': getattr(p, 'barcode', '') or '',
            'original_qty': sold, 'returned_qty': already, 'returnable_qty': max(sold - already, 0),
            'unit_price': str(unit), 'tax_rate': str(rate),
            'selling_unit': getattr(it, 'selling_unit', '') or '',
        })
    return out


# ---------------------------------------------------------------------------------------------
# Create
# ---------------------------------------------------------------------------------------------
def _clean_settlements(raw, total, errors):
    """Validated settlement rows + (payment_mode, single bank)."""
    from apps.financial.models import ChartOfAccount
    from apps.financial.banks import validate_bank_account

    rows = raw if isinstance(raw, list) else []
    clean = []
    for n, r in enumerate(rows, 1):
        if not isinstance(r, dict):
            continue
        mode = str(r.get('mode') or '').strip().upper()
        if mode == 'UPI':
            mode = 'GPAY'
        amount = money(r.get('amount'))
        if amount == 0:
            continue
        if mode not in MODE_LABELS:
            errors.append(f"Settlement {n}: choose Cash, GPay / UPI, Bank Transfer or Credit.")
            continue
        if amount < 0:
            errors.append(f"Settlement {n}: the amount can't be negative.")
            continue
        bank = None
        if mode in BANK_MODES:
            bank_id = r.get('bank_account')
            bank = ChartOfAccount.objects.filter(pk=bank_id).first() if _is_uuid(bank_id) else None
            if bank is None:
                errors.append(f"{MODE_LABELS[mode]}: select the bank account.")
                continue
            try:
                validate_bank_account(bank)
            except serializers.ValidationError as exc:
                errors.append(f"{MODE_LABELS[mode]}: {exc.detail[0] if isinstance(exc.detail, list) else exc.detail}")
                continue
        clean.append({'mode': mode, 'amount': str(amount),
                      'bank_account': str(bank.pk) if bank else None,
                      'bank_name': bank.name if bank else '',
                      'reference': str(r.get('reference') or '').strip()[:80]})
    paid = sum((Decimal(c['amount']) for c in clean), ZERO)
    if not clean:
        errors.append('Choose how the return is settled (Cash, GPay / UPI, Bank Transfer or Credit).')
    elif abs(paid - total) >= CENT:
        errors.append(f"The settlement ({paid}) must equal the return value ({total}). "
                      "Put any part not paid out on Credit Note / Ledger Adjustment.")
    modes = {c['mode'] for c in clean}
    banks = {c['bank_account'] for c in clean if c['bank_account']}
    payment_mode = modes.pop() if len(modes) == 1 else 'SPLIT'
    single_bank = banks.pop() if len(banks) == 1 else None
    return clean, payment_mode, single_bank


def _issue_number(kind, Model, client_token):
    from apps.company.numbering import DuplicateSubmission, issue_number
    try:
        number = issue_number(kind.doc_type, lambda n: Model.all_objects.filter(return_number=n).exists(),
                              client_token=client_token or None)
    except DuplicateSubmission as dup:
        existing = Model.all_objects.filter(return_number=dup.number).first()
        if existing is not None:
            return None, existing
        raise ReturnError({'detail': f'This return was already saved as {dup.number}.'})
    if not number:
        for _ in range(20):
            candidate = f"{kind.fallback_prefix}-{timezone.localdate():%Y%m%d}-{uuid.uuid4().hex[:5].upper()}"
            if not Model.all_objects.filter(return_number=candidate).exists():
                number = candidate
                break
    return number, None


def create_return(kind, data, *, request, branch_kwargs=None):
    """Validate and save one return; returns (instance, created)."""
    from apps.products.models import Product

    Model, Item = kind.models()
    Original, OriginalItem = kind.original_models()
    errors = []

    token = str(data.get('client_token') or '').strip()[:100]
    if token:
        existing = Model.all_objects.filter(client_token=token).first()
        if existing is not None:
            return existing, False

    return_date = parse_date(str(data.get('return_date') or '')) if data.get('return_date') else timezone.localdate()
    if return_date is None:
        errors.append('Return date: use YYYY-MM-DD.')
    elif return_date > timezone.localdate():
        errors.append("Return date can't be in the future.")

    original = None
    original_id = data.get('original_document') or data.get(kind.original_fk)
    if original_id:
        if not _is_uuid(original_id):
            raise ReturnError({'detail': 'Original document not found.'})
        # Locked: two returns against the same bill at once can't both take its last units.
        original = kind.live_originals().select_for_update().filter(pk=original_id).first()
        if original is None:
            raise ReturnError({'detail': 'The original bill was not found, or it is a draft / cancelled — '
                                         'it can no longer take a return.'})
        if return_date and kind.original_date(original) and return_date < kind.original_date(original):
            errors.append("The return can't be dated before the original bill.")

    raw_lines = data.get('items') if isinstance(data.get('items'), list) else []
    if not raw_lines:
        raise ReturnError({'detail': 'Add at least one product to return.'})
    if len(raw_lines) > MAX_LINES:
        raise ReturnError({'detail': f'A return can hold at most {MAX_LINES} lines.'})

    orig_items = {}
    if original is not None:
        orig_items = {str(it.pk): it for it in kind.returnable_items(original)}
    already = returned_qty_by_original_item(kind, [it.pk for it in orig_items.values()])
    factor = kind.price_factor(original) if original is not None else Decimal('1')
    product_ids = {str(r.get('product')) for r in raw_lines if isinstance(r, dict) and _is_uuid(r.get('product'))}
    products = {str(p.pk): p for p in Product.objects.filter(pk__in=product_ids)} if product_ids else {}

    lines, claimed = [], {}
    for n, r in enumerate(raw_lines, 1):
        if not isinstance(r, dict):
            continue
        tag = f"Line {n}"
        orig_item = None
        if original is not None:
            orig_item = orig_items.get(str(r.get('original_item') or ''))
            if orig_item is None:
                errors.append(f"{tag}: pick the item from {kind.original_number(original)} — it is not a returnable line of that bill.")
                continue
            product = orig_item.product
            tag = f"{tag} ({kind.item_description(orig_item)})"
        else:
            product = products.get(str(r.get('product') or ''))
            if product is None:
                errors.append(f"{tag}: choose a product from the product list.")
                continue
            tag = f"{tag} ({product.name})"
        qty = _int(r.get('return_qty', r.get('quantity')), f"{tag} return quantity", errors)
        if qty is None:
            continue
        if orig_item is not None:
            left = kind.original_qty(orig_item) - already.get(orig_item.pk, 0) - claimed.get(orig_item.pk, 0)
            if qty > left:
                errors.append(f"{tag}: only {max(left, 0)} left to return "
                              f"({kind.original_qty(orig_item)} on the bill, {already.get(orig_item.pk, 0)} already returned).")
                continue
            claimed[orig_item.pk] = claimed.get(orig_item.pk, 0) + qty
            max_unit, rate = kind.unit_terms(orig_item, factor)
            unit = money(r['unit_price']) if r.get('unit_price') not in (None, '') else max_unit
            if unit > max_unit + CENT:
                errors.append(f"{tag}: the return price {unit} is above the {max_unit} charged on the bill.")
                continue
        else:
            unit = money(r.get('unit_price'))
            rate = money(r.get('tax_rate'))
            if rate < 0 or rate > 100:
                errors.append(f"{tag}: tax rate must be between 0 and 100.")
                continue
        if unit < 0:
            errors.append(f"{tag}: the price can't be negative.")
            continue
        reason = str(r.get('return_reason_category') or r.get('reason') or '').strip().upper()
        notes = str(r.get('reason_notes') or '').strip()[:255]
        if reason not in REASON_LABELS:
            errors.append(f"{tag}: choose the return reason.")
            continue
        if reason in REASONS_NEEDING_NOTE and not notes:
            errors.append(f"{tag}: describe the issue for '{REASON_LABELS[reason]}'.")
            continue
        line_total = money(unit * qty)
        lines.append({
            'original_item': orig_item, 'product': product,
            'description': (kind.item_description(orig_item) if orig_item is not None else product.name)[:255],
            'sku': (product.sku or '')[:150], 'barcode': (product.barcode or '')[:150],
            'return_qty': qty, 'stock_qty': kind.stock_units(orig_item, qty),
            'unit_price': unit, 'tax_rate': rate, 'tax_amount': inclusive_tax(line_total, rate),
            'line_total': line_total, 'unit_cost': kind.unit_cost(orig_item, product),
            'return_reason_category': reason, 'reason_notes': notes, 'line_no': n,
        })

    party = kind.party_fields(data, original, errors)
    total = sum((l['line_total'] for l in lines), ZERO)
    tax = sum((l['tax_amount'] for l in lines), ZERO)
    if lines and total <= 0:
        errors.append('The return value is zero — enter the price being refunded.')
    settlements, payment_mode, bank_id = _clean_settlements(data.get('settlements') or _legacy_settlement(data, total),
                                                           total, errors)
    if errors:
        raise ReturnError({'detail': ' '.join(errors[:6]) + (f' (+{len(errors) - 6} more)' if len(errors) > 6 else ''),
                           'errors': errors})

    number, dup = _issue_number(kind, Model, token)
    if dup is not None:
        return dup, False

    fields = {
        'return_number': number, 'return_date': return_date, 'status': 'COMPLETED',
        'payment_mode': payment_mode, 'bank_account_id': bank_id, 'settlements': settlements,
        'subtotal': total - tax, 'tax_amount': tax, 'total_amount': total, 'total_refund_amount': total,
        'general_remarks': str(data.get('general_remarks') or data.get('remarks') or '').strip()[:2000],
        'performed_by': actor_from_request(request)[:150], 'client_token': token,
        **party, **(branch_kwargs or {}),
    }
    if original is not None and original.branch_id and 'branch' not in fields:
        fields['branch_id'] = original.branch_id
    kind.set_original(fields, original)
    ret = Model.objects.create(**fields)
    Item.objects.bulk_create([Item(**{kind.item_parent: ret}, **line) for line in lines])
    _move_stock(kind, ret, lines, sign=1)
    kind.after_save(ret, 1)
    return ret, True


def _legacy_settlement(data, total):
    """A request with only payment_mode / bank_account (the spec's flat shape) = one settlement row."""
    mode = str(data.get('payment_mode') or '').strip().upper()
    if not mode or mode == 'SPLIT':
        return []
    return [{'mode': mode, 'amount': str(total), 'bank_account': data.get('bank_account'),
             'reference': data.get('reference') or ''}]


def _move_stock(kind, ret, lines, *, sign):
    """sign=+1 applies the return, -1 undoes it (cancel)."""
    deltas = {}
    for l in lines:
        product = l['product'] if isinstance(l, dict) else l.product
        qty = l['stock_qty'] if isinstance(l, dict) else l.stock_qty
        if product is None or not qty:
            continue
        deltas[product] = deltas.get(product, 0) + qty * kind.stock_sign * sign
    if not deltas:
        return
    from apps.company.models import Branch
    branch = ret.branch or Branch.get_default()
    cancel = sign < 0
    outflow = any(d < 0 for d in deltas.values())
    adjust_branch_stock_many(deltas, branch, enforce_stock=outflow, ledger={
        'transaction_type': ('OUT' if kind.ledger_type == 'IN' else 'IN') if cancel else kind.ledger_type,
        # A cancel's rows carry no reference id: the ledger keeps one row per (document, product),
        # and the return's own rows already hold this id.
        'reference_id': None if cancel else ret.pk,
        'notes': f"{'Cancelled ' if cancel else ''}{kind.label} {ret.return_number}"
                 + (f" — {ret.cancel_reason}" if cancel and ret.cancel_reason else ''),
        'reference_number': ret.return_number,
        'source_type': kind.source_type,
    })


@transaction.atomic
def cancel_return(kind, pk, *, reason, request):
    Model, _ = kind.models()
    ret = Model.objects.select_for_update().filter(pk=pk).first()
    if ret is None:
        raise ReturnError({'detail': 'Return not found.'})
    if ret.status == 'CANCELLED':
        return ret
    reason = str(reason or '').strip()[:255]
    if not reason:
        raise ReturnError({'detail': 'Give a reason for cancelling the return.'})
    ret.status = 'CANCELLED'
    ret.cancel_reason = reason
    ret.cancelled_at = timezone.now()
    ret.cancelled_by = actor_from_request(request)[:150]
    ret.save(update_fields=['status', 'cancel_reason', 'cancelled_at', 'cancelled_by', 'updated_at'])
    _move_stock(kind, ret, list(ret.items.select_related('product')), sign=-1)
    kind.after_save(ret, -1)
    return ret


# ---------------------------------------------------------------------------------------------
# Read side
# ---------------------------------------------------------------------------------------------
def _settlement_text(settlements):
    parts = []
    for s in settlements or []:
        label = MODE_LABELS.get(s.get('mode'), s.get('mode') or '')
        if s.get('bank_name'):
            label = f"{label} ({s['bank_name']})"
        parts.append(f"{label} {s.get('amount')}")
    return ' + '.join(parts)


def serialize_return(kind, ret, *, with_items=True):
    items = list(ret.items.all()) if with_items else []
    reasons = sorted({REASON_LABELS.get(i.return_reason_category, i.return_reason_category) for i in items})
    body = {
        'id': str(ret.pk), 'kind': kind.key, 'return_number': ret.return_number,
        'return_date': ret.return_date.isoformat() if ret.return_date else None,
        'status': ret.status, 'payment_mode': ret.payment_mode,
        'payment_mode_label': MODE_LABELS.get(ret.payment_mode, 'Split'),
        'bank_account': str(ret.bank_account_id) if ret.bank_account_id else None,
        'bank_account_name': ret.bank_account.name if ret.bank_account_id and ret.bank_account else '',
        'settlements': ret.settlements or [], 'settlement_text': _settlement_text(ret.settlements),
        'subtotal': str(money(ret.subtotal)), 'tax_amount': str(money(ret.tax_amount)),
        'total_amount': str(money(ret.total_amount)), 'total_refund_amount': str(money(ret.total_refund_amount)),
        'general_remarks': ret.general_remarks, 'performed_by': ret.performed_by,
        'cancel_reason': ret.cancel_reason, 'cancelled_by': ret.cancelled_by,
        'cancelled_at': ret.cancelled_at.isoformat() if ret.cancelled_at else None,
        'created_at': ret.created_at.isoformat() if ret.created_at else None,
        'party': kind.party_of(ret), 'original': kind.original_ref(ret),
        'total_qty': sum(i.return_qty for i in items),
        'reasons': reasons,
    }
    if with_items:
        body['items'] = [{
            'id': str(i.pk), 'original_item': str(i.original_item_id) if i.original_item_id else None,
            'product': str(i.product_id) if i.product_id else None, 'description': i.description,
            'sku': i.sku, 'barcode': i.barcode, 'return_qty': i.return_qty, 'stock_qty': i.stock_qty,
            'unit_price': str(money(i.unit_price)), 'tax_rate': str(i.tax_rate), 'tax_amount': str(money(i.tax_amount)),
            'line_total': str(money(i.line_total)),
            'return_reason_category': i.return_reason_category,
            'return_reason_label': REASON_LABELS.get(i.return_reason_category, i.return_reason_category),
            'reason_notes': i.reason_notes,
        } for i in items]
    return body


def report_summary(kind, rows):
    """Totals over serialized live rows (cancelled ones are listed but not counted)."""
    live = [r for r in rows if r['status'] != 'CANCELLED']
    by_mode, by_reason = {}, {}
    for r in live:
        for s in r['settlements'] or [{'mode': r['payment_mode'], 'amount': r['total_amount']}]:
            label = MODE_LABELS.get(s.get('mode'), s.get('mode') or '')
            by_mode[label] = str(money(Decimal(by_mode.get(label, '0')) + money(s.get('amount'))))
        for it in r.get('items', []):
            label = it['return_reason_label']
            entry = by_reason.setdefault(label, {'qty': 0, 'amount': '0.00'})
            entry['qty'] += it['return_qty']
            entry['amount'] = str(money(Decimal(entry['amount']) + money(it['line_total'])))
    return {
        'count': len(live), 'cancelled': len(rows) - len(live),
        'total_qty': sum(r['total_qty'] for r in live),
        'total_amount': str(sum((money(r['total_amount']) for r in live), ZERO)),
        'tax_amount': str(sum((money(r['tax_amount']) for r in live), ZERO)),
        'subtotal': str(sum((money(r['subtotal']) for r in live), ZERO)),
        'by_mode': by_mode, 'by_reason': by_reason,
    }


def return_stock_by_product(product_ids=None):
    """{product_id: {'sales': units, 'purchase': units}} over live returns — Stock Overview's
    Return Stock figures."""
    out = {}
    for kind in (SalesKind, PurchaseKind):
        _, Item = kind.models()
        qs = Item.objects.filter(product__isnull=False, **{f'{kind.item_parent}__is_deleted': False}) \
            .exclude(**{f'{kind.item_parent}__status': 'CANCELLED'})
        if product_ids is not None:
            qs = qs.filter(product_id__in=list(product_ids))
        for r in qs.values('product_id').annotate(q=Sum('stock_qty')):
            out.setdefault(r['product_id'], {'sales': 0, 'purchase': 0})[kind.key] = int(r['q'] or 0)
    return out


# ---------------------------------------------------------------------------------------------
# API
# ---------------------------------------------------------------------------------------------
class ReturnPagination(PageSizePagination):
    page_size = 50
    page_size_query_param = 'page_size'
    max_page_size = 500


class _ReturnViewSet(BranchScopedViewSetMixin, mixins.ListModelMixin, mixins.RetrieveModelMixin,
                     viewsets.GenericViewSet):
    """Create / list / view / cancel. A saved return is never edited: cancel it (stock and books
    are put back) and enter it again — the audit trail keeps both."""
    kind = SalesKind
    permission_classes = [permissions.AllowAny]
    pagination_class = ReturnPagination

    def get_queryset(self):
        Model, Item = self.kind.models()
        return (Model.objects.all().select_related(*self.kind.list_related())
                .prefetch_related(Prefetch('items', queryset=Item.objects.order_by('line_no')))
                .order_by('-return_date', '-created_at'))

    def _filtered(self, request):
        qs = self.get_queryset()
        p = request.query_params
        date_from, date_to = parse_date(p.get('date_from') or ''), parse_date(p.get('date_to') or '')
        if date_from:
            qs = qs.filter(return_date__gte=date_from)
        if date_to:
            qs = qs.filter(return_date__lte=date_to)
        st = (p.get('status') or '').strip().upper()
        if st in ('COMPLETED', 'CANCELLED'):
            qs = qs.filter(status=st)
        mode = (p.get('payment_mode') or '').strip().upper()
        if mode:
            qs = qs.filter(payment_mode=mode)
        party = (p.get('party') or '').strip()
        if party and _is_uuid(party):
            qs = qs.filter(**{'customer_id' if self.kind is SalesKind else 'supplier_id': party})
        term = (p.get('search') or p.get('q') or '').strip()
        if term:
            qs = qs.filter(self.kind.search_q(term)).distinct()
        return qs

    def list(self, request, *args, **kwargs):
        qs = self._filtered(request)
        page = self.paginate_queryset(qs)
        return self.get_paginated_response([serialize_return(self.kind, r) for r in page])

    def retrieve(self, request, *args, **kwargs):
        return Response(serialize_return(self.kind, self.get_object()))

    def create(self, request, *args, **kwargs):
        branch_kwargs = {}
        stamp = self._branch_stamp_kwargs(SimpleNamespace(Meta=SimpleNamespace(model=self.kind.models()[0]),
                                                          validated_data={}))
        if stamp.get('branch') is not None:
            branch_kwargs['branch'] = stamp['branch']
        with transaction.atomic():
            ret, created = create_return(self.kind, request.data, request=request, branch_kwargs=branch_kwargs)
        ret = self.get_queryset().get(pk=ret.pk)
        body = serialize_return(self.kind, ret)
        body['accounting'] = accounting_status(self.kind, ret.pk) if created else None
        return Response(body, status=status.HTTP_201_CREATED if created else status.HTTP_200_OK)

    @action(detail=True, methods=['post'])
    def cancel(self, request, pk=None):
        self.get_object()  # branch / tenant scope
        cancel_return(self.kind, pk, reason=request.data.get('reason'), request=request)
        return Response(serialize_return(self.kind, self.get_queryset().get(pk=pk)))

    @action(detail=False, methods=['get'])
    def meta(self, request):
        return Response({
            'reasons': [{'value': v, 'label': l, 'needs_note': v in REASONS_NEEDING_NOTE} for v, l in RETURN_REASONS],
            'modes': [{'value': v, 'label': l, 'needs_bank': v in BANK_MODES} for v, l in SETTLEMENT_MODES],
        })

    @action(detail=False, methods=['get'], url_path='source-documents')
    def source_documents(self, request):
        return Response(self.kind.search_originals((request.query_params.get('search') or '').strip()))

    @action(detail=False, methods=['get'])
    def returnable(self, request):
        doc_id = request.query_params.get('document') or ''
        doc = self.kind.live_originals().filter(pk=doc_id).first() if _is_uuid(doc_id) else None
        if doc is None:
            return Response({'detail': 'Bill not found, or it is a draft / cancelled.'}, status=404)
        head = self.kind.search_originals(self.kind.original_number(doc))
        head = next((h for h in head if h['id'] == str(doc.pk)), {'id': str(doc.pk), 'number': self.kind.original_number(doc)})
        return Response({'document': head, 'lines': returnable_lines(self.kind, doc)})

    @action(detail=False, methods=['get'])
    def report(self, request):
        rows = [serialize_return(self.kind, r) for r in self._filtered(request)[:5000]]
        return Response({'rows': rows, 'summary': report_summary(self.kind, rows)})


def accounting_status(kind, pk):
    from apps.financial.models import JournalEntry, PostingFailure
    module, event = ('sales', 'sales_return') if kind is SalesKind else ('purchasing', 'purchase_return')
    posted = JournalEntry.objects.filter(source_module=module, source_event=event, reference_id=pk,
                                         status='POSTED', is_reversal=False)
    failed = PostingFailure.objects.filter(source_module=module, source_event=event, reference_id=pk, status='OPEN')
    return {'posted': [e.entry_number for e in posted], 'failed': [f.error for f in failed]}


class SalesReturnViewSet(_ReturnViewSet):
    kind = SalesKind


class PurchaseReturnViewSet(_ReturnViewSet):
    kind = PurchaseKind
