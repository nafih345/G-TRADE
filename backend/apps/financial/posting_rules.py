"""Posting rules: one builder per operational source document.

A builder looks at a document and returns the journal it should have on the books right now —
a plan whose lines name *roles* (resolved to accounts by mapping.resolve_role) — or None when
the document must not be on the books (draft, quotation, order, cancelled, deleted, zero).
Builders never write anything; integration.book_source() compares the plan with what is
posted and reverses / re-posts through the JournalPostingService.

Amounts are Decimal and rounded to the paisa. Every plan balances by construction; the
service re-checks it anyway.
"""
from decimal import Decimal

from django.utils import timezone

from .accounting_catalog import payment_role, is_credit_method
from .services import money
from .banks import bank_line_kwargs

ZERO = Decimal('0.00')


def _date(value):
    if value is None:
        return timezone.localdate()
    if hasattr(value, 'date') and callable(value.date):
        return timezone.localtime(value).date() if timezone.is_aware(value) else value.date()
    return value


def _line(role=None, debit=ZERO, credit=ZERO, memo='', account=None):
    return {'role': role, 'account': account, 'debit': money(debit), 'credit': money(credit), 'memo': memo}


def _allocate(total, weights):
    """Split `total` across {key: weight} proportionally; rounding residue goes to the
    largest bucket so the parts always sum to exactly `total`."""
    total = money(total)
    weights = {k: Decimal(str(w)) for k, w in weights.items() if Decimal(str(w)) > 0}
    if not weights:
        return {}
    wsum = sum(weights.values())
    parts = {k: money(total * w / wsum) for k, w in weights.items()}
    biggest = max(weights, key=lambda k: weights[k])
    parts[biggest] += total - sum(parts.values())
    return parts


# ---------------------------------------------------------------------------
# Retail / optical invoices (sales.Invoice)
# ---------------------------------------------------------------------------

def invoice_is_wholesale(inv):
    return bool(getattr(inv, 'is_wholesale', False)) or ('WHOLESALE' in str(inv.invoice_number or '').upper())


def invoice_is_live(inv):
    return (not inv.is_deleted and (inv.document_type or 'INVOICE') == 'INVOICE'
            and inv.status not in ('DRAFT', 'CANCELLED'))


def build_sales_invoice(inv, previous=None):
    if not invoice_is_live(inv):
        return None
    receivable = money(inv.net_amount) or money(inv.total_amount)
    if receivable <= 0:
        return None
    tax, discount = money(inv.tax_amount), money(inv.discount_amount)
    revenue = receivable + discount - tax
    if revenue < 0:  # nonsensical split (tax/discount larger than the sale) — book it all as revenue
        tax, discount, revenue = ZERO, ZERO, receivable

    wholesale = invoice_is_wholesale(inv)
    items = list(inv.items.all().select_related('product'))
    product_role = 'WHOLESALE_SALES' if wholesale else 'RETAIL_SALES'
    weights = {}
    for it in items:
        role = 'SERVICE_REVENUE' if (it.item_type or '').upper() == 'SERVICE' else product_role
        weights[role] = weights.get(role, Decimal('0')) + max(money(it.subtotal), ZERO)
    split = _allocate(revenue, weights) or {product_role: revenue}

    receivable_role = 'WHOLESALE_RECEIVABLE' if wholesale else 'RETAIL_RECEIVABLE'
    lines = [_line(receivable_role, debit=receivable, memo='Invoice total due')]
    if discount > 0:
        lines.append(_line('DISCOUNT_ALLOWED', debit=discount, memo='Bill discount'))
    for role, amount in split.items():
        lines.append(_line(role, credit=amount, memo='Service revenue' if role == 'SERVICE_REVENUE' else 'Sales revenue'))
    if tax > 0:
        lines.append(_line('GST_OUTPUT', credit=tax, memo='Output GST'))

    # Cost of goods sold for stocked lines, at the cost recorded the first time this invoice
    # was booked (so editing an old bill doesn't re-cost it at today's purchase price).
    # Costed per stock unit actually issued — the same count the stock deduction uses, so a lens
    # pair sold against pair-counted stock costs one pair, not two lenses' worth.
    from apps.sales.lens_units import stock_units_by_product
    prior_costs = ((previous.metadata or {}).get('unit_costs') or {}) if previous else {}
    stocked = [it for it in items
               if it.product_id and (it.item_type or '').upper() != 'SERVICE' and (it.quantity or 0) > 0]
    products = {it.product_id: it.product for it in stocked}
    unit_costs, cogs = {}, ZERO
    for pk, units in stock_units_by_product(stocked).items():
        key = str(pk)
        cost = Decimal(str(prior_costs[key])) if key in prior_costs else money(getattr(products[pk], 'cost_price', 0))
        unit_costs[key] = str(cost)
        cogs += money(cost * units)
    if cogs > 0:
        lines.append(_line('COGS', debit=cogs, memo='Cost of goods sold'))
        lines.append(_line('INVENTORY', credit=cogs, memo='Stock issued on sale'))

    return {
        'date': _date(inv.invoice_date), 'branch': inv.branch, 'voucher_type_code': 'SV',
        'source_number': inv.invoice_number, 'reference_type': 'WHOLESALE' if wholesale else 'SALE',
        'narration': f"Sales Invoice {inv.invoice_number} — {inv.customer_name or 'customer'}",
        'metadata': {'unit_costs': unit_costs, 'valuation': 'LAST_PURCHASE_COST'},
        'lines': lines,
    }


def build_sales_payment(pay, previous=None):
    status = (pay.status or '').upper()
    amount = money(pay.amount)
    if pay.is_deleted or amount == 0 or status in ('CANCELLED', 'VOID', 'VOIDED', 'FAILED', 'REVERSED'):
        return None
    inv = pay.invoice if pay.invoice_id else None
    if inv is not None and inv.is_deleted:
        inv = None
    if inv is not None and invoice_is_live(inv):
        counter_role = 'WHOLESALE_RECEIVABLE' if invoice_is_wholesale(inv) else 'RETAIL_RECEIVABLE'
        counter_memo = f"Settles {inv.invoice_number}"
    else:
        # Money against an order / quotation (or unattached) is an advance until invoiced.
        counter_role = 'CUSTOMER_ADVANCES'
        counter_memo = f"Advance{' on ' + inv.invoice_number if inv else ''}"
    money_side = bank_line_kwargs(payment_role(pay.method), pay.bank_account if pay.bank_account_id else None)
    who = pay.customer_name or (inv.customer_name if inv else '') or 'customer'
    is_receipt = amount > 0
    if is_receipt:
        lines = [_line(debit=amount, memo=pay.method or 'Cash', **money_side),
                 _line(counter_role, credit=amount, memo=counter_memo)]
        narration = f"Receipt {pay.receipt_no or ''} from {who}"
    else:  # refund
        amount = -amount
        lines = [_line(counter_role, debit=amount, memo=f"Refund — {counter_memo}"),
                 _line(credit=amount, memo=pay.method or 'Cash', **money_side)]
        narration = f"Refund {pay.receipt_no or ''} to {who}"
    return {
        'date': _date(pay.payment_date), 'branch': pay.branch, 'voucher_type_code': 'RV' if is_receipt else 'PV',
        'source_number': pay.receipt_no or '', 'reference_type': 'PAYMENT_RECEIPT',
        'narration': ' '.join(narration.split()), 'lines': lines,
    }


def build_eye_test_fee(exam, previous=None):
    """An eye test fee collected at the test (sales.EyeExamination, fee_status PAID): money in
    via Cash or GPay (UPI), booked straight to service revenue. Free tests take nothing, and a
    deferred (PENDING / BILLED) fee reaches the books as a service line on the sale bill instead
    — so only PAID posts here; switching away from PAID (or deleting the exam) reverses it."""
    amount = money(exam.fee_paid_amount)
    if exam.is_deleted or (exam.fee_status or '').upper() != 'PAID' or amount <= 0:
        return None
    upi = (exam.fee_payment_mode or '').upper() == 'UPI'
    who = exam.patient_name or 'patient'
    return {
        # EyeExamination.branch is a free-text label, not a Branch row.
        'date': _date(exam.examination_date), 'branch': None, 'voucher_type_code': 'RV',
        'source_number': f"EYE-{exam.test_no}" if exam.test_no else '', 'reference_type': 'EYE_TEST',
        'narration': f"Eye test fee — Test No {exam.test_no or '—'} — {who}",
        'lines': [
            _line('PAYMENT_UPI' if upi else 'CASH', debit=amount, memo='GPay (UPI)' if upi else 'Cash'),
            # 'Service revenue' memo = the Ledger's "services & eye tests" flag.
            _line('SERVICE_REVENUE', credit=amount, memo='Service revenue'),
        ],
    }


# ---------------------------------------------------------------------------
# Wholesale (sales.WholesaleInvoice / WholesalePaymentCollection / WholesaleReturn)
# ---------------------------------------------------------------------------

def _wholesale_tax(inv):
    summary = (inv.details or {}).get('summary') or {}
    return money(summary.get('totalGst') or summary.get('total_gst') or summary.get('taxAmount') or 0)


def build_wholesale_invoice(inv, previous=None):
    status = (inv.status or '').strip().lower()
    total = money(inv.grand_total)
    if inv.is_deleted or status in ('cancelled', 'canceled', 'draft', 'void') or total <= 0:
        return None
    tax = min(_wholesale_tax(inv), total)
    dealer = getattr(inv.dealer, 'business_name', '') if inv.dealer_id else ''
    return {
        'date': _date(inv.invoice_date), 'branch': None, 'voucher_type_code': 'SV',
        'source_number': inv.invoice_number, 'reference_type': 'WHOLESALE',
        'narration': f"Wholesale Invoice {inv.invoice_number} — {dealer}".strip(' —'),
        'lines': [
            _line('WHOLESALE_RECEIVABLE', debit=total, memo='Dealer invoice total'),
            _line('WHOLESALE_SALES', credit=total - tax, memo='Wholesale revenue'),
            _line('GST_OUTPUT', credit=tax, memo='Output GST'),
        ],
    }


def build_wholesale_collection(col, previous=None):
    amount = money(col.amount_paid)
    if col.is_deleted or amount <= 0 or is_credit_method(col.payment_method):
        return None
    dealer = getattr(col.dealer, 'business_name', '') if col.dealer_id else ''
    return {
        'date': _date(col.payment_date), 'branch': None, 'voucher_type_code': 'RV',
        'source_number': col.receipt_number, 'reference_type': 'WHOLESALE_COLLECTION',
        'narration': f"Wholesale collection {col.receipt_number} — {dealer}".strip(' —'),
        'lines': [
            _line(debit=amount, memo=col.payment_method or '',
                  **bank_line_kwargs(payment_role(col.payment_method), col.bank_account if col.bank_account_id else None)),
            _line('WHOLESALE_RECEIVABLE', credit=amount,
                  memo=f"Settles {col.invoice_number}" if col.invoice_number else 'On account'),
        ],
    }


def build_wholesale_return(ret, previous=None):
    from apps.sales.models import WholesaleInvoice
    amount = money(ret.return_amount)
    action = (ret.action_taken or '').lower()
    if ret.is_deleted or amount <= 0 or 'replace' in action:
        return None  # a like-for-like replacement moves no money
    tax_share = ZERO
    original = WholesaleInvoice.objects.filter(invoice_number=ret.invoice_number).first()
    if original and money(original.grand_total) > 0:
        tax_share = min(money(_wholesale_tax(original) * min(amount, money(original.grand_total)) / money(original.grand_total)), amount)
    return {
        'date': _date(ret.return_date), 'branch': None, 'voucher_type_code': 'JV',
        'source_number': ret.return_number, 'reference_type': 'WHOLESALE_RETURN',
        'narration': f"Wholesale {ret.action_taken or 'return'} {ret.return_number} against {ret.invoice_number}",
        'lines': [
            _line('SALES_RETURNS', debit=amount - tax_share, memo=ret.reason or 'Sales return'),
            _line('GST_OUTPUT', debit=tax_share, memo='Output GST reversed'),
            _line('WHOLESALE_RECEIVABLE', credit=amount, memo='Credit note to dealer'),
        ],
    }


# ---------------------------------------------------------------------------
# Purchasing (purchasing.PurchaseInvoice / PurchaseOrder)
# ---------------------------------------------------------------------------

def _payable(supplier):
    acc = getattr(supplier, 'ledger_account', None) if supplier else None
    if acc is not None and not acc.is_deleted and acc.status == 'Active':
        return {'account': acc}
    return {'role': 'SUPPLIER_PAYABLE'}


def _purchase_tax(pi):
    if pi.gst_type == 'NO_GST':
        return money(pi.vat_amount)
    parts = sum((money(getattr(pi, f)) for f in ('cgst_amount', 'sgst_amount', 'igst_amount', 'cess_amount', 'vat_amount')), ZERO)
    return parts if parts > 0 else money(pi.tax_amount)


def purchase_invoice_is_live(pi):
    return not pi.is_deleted and pi.status not in ('DRAFT', 'CANCELLED')


def build_purchase_invoice(pi, previous=None):
    total = money(pi.grand_total)
    if not purchase_invoice_is_live(pi) or total <= 0:
        return None
    tax = min(_purchase_tax(pi), total)
    round_off = money(pi.round_off)
    inventory = total - tax - round_off
    if inventory <= 0:
        inventory, tax, round_off = total, ZERO, ZERO
    payable = _payable(pi.supplier)
    lines = [_line('INVENTORY', debit=inventory, memo='Stock received at cost (incl. charges, net of discount)')]
    if tax > 0:
        lines.append(_line('GST_INPUT', debit=tax, memo='Input tax credit'))
    if round_off > 0:
        lines.append(_line('ROUND_OFF', debit=round_off, memo='Round off'))
    elif round_off < 0:
        lines.append(_line('ROUND_OFF', credit=-round_off, memo='Round off'))
    lines.append(_line(credit=total, memo='Supplier bill', **payable))
    return {
        'date': _date(pi.purchase_date), 'branch': pi.branch, 'voucher_type_code': 'PU',
        'source_number': pi.invoice_number, 'reference_type': 'PURCHASE_ENTRY',
        'narration': f"Purchase Entry {pi.invoice_number}"
                     f"{' (supplier bill ' + pi.supplier_invoice_number + ')' if pi.supplier_invoice_number else ''}"
                     f" — {getattr(pi.supplier, 'name', '')}",
        'lines': lines,
    }


def build_purchase_payment(pi, previous=None):
    total = money(pi.grand_total)
    if not purchase_invoice_is_live(pi) or total <= 0 or pi.payment_method == 'CREDIT':
        return None
    if pi.payment_method == 'CASH' and getattr(pi, 'payment_status', '') == 'UNPAID':
        return None  # cash still owed to the supplier — the payable stays open
    paid = money(pi.paid_amount)
    if pi.purchase_type == 'CASH' and paid <= 0:
        paid = total  # a cash purchase is settled at the counter by definition
    paid = min(paid, total)
    if paid <= 0:
        return None
    return {
        'date': _date(pi.purchase_date), 'branch': pi.branch, 'voucher_type_code': 'PV',
        'source_number': pi.invoice_number, 'reference_type': 'PURCHASE_PAYMENT',
        'narration': f"Payment for Purchase Entry {pi.invoice_number} — {getattr(pi.supplier, 'name', '')}",
        'lines': [
            _line(debit=paid, memo='Supplier paid', **_payable(pi.supplier)),
            _line(credit=paid, memo=pi.payment_method or '',
                  **bank_line_kwargs(payment_role(pi.payment_method), pi.bank_account if pi.bank_account_id else None)),
        ],
    }


def build_purchase_order(po, previous=None):
    """A PO is a commitment, not a transaction. It is booked only when it was received
    *directly* (its own receive moved stock — StockLedger rows reference it). A PO flipped to
    RECEIVED by "mark converted" has its stock and liability booked by the Purchase Entry."""
    from apps.inventory.models import StockLedger
    total = money(po.net_amount) or money(po.total_amount)
    if po.is_deleted or po.status != 'RECEIVED' or total <= 0:
        return None
    if not StockLedger.all_objects.filter(reference_id=po.id, is_deleted=False).exists():
        return None
    tax = min(money(po.tax_amount), total)
    lines = [_line('INVENTORY', debit=total - tax, memo='Goods received on PO')]
    if tax > 0:
        lines.append(_line('GST_INPUT', debit=tax, memo='Input tax credit'))
    lines.append(_line(credit=total, memo='Supplier liability', **_payable(po.supplier)))
    return {
        'date': _date(po.order_date), 'branch': po.branch, 'voucher_type_code': 'PU',
        'source_number': po.order_number, 'reference_type': 'PURCHASE',
        'narration': f"Goods received on Purchase Order {po.order_number}", 'lines': lines,
    }


# ---------------------------------------------------------------------------
# Inventory (inventory.StockAdjustment)
# ---------------------------------------------------------------------------

WHOLESALE_SALE_PREFIX = 'wholesale pos sale'


def build_stock_adjustment(adj, previous=None):
    if adj.is_deleted or (adj.quantity or 0) <= 0:
        return None
    prior = (previous.metadata or {}).get('unit_cost') if previous else None
    unit_cost = Decimal(str(prior)) if prior is not None else money(getattr(adj.product, 'cost_price', 0))
    value = money(unit_cost * adj.quantity)
    if value <= 0:
        return None
    reason = (adj.reason or '').strip()
    meta = {'unit_cost': str(unit_cost), 'valuation': 'LAST_PURCHASE_COST'}
    name = getattr(adj.product, 'name', 'product')
    # The Wholesale POS takes sold stock out through a SUB adjustment — that is cost of goods
    # sold, not a loss — and a cancel / return / edit puts it back with an ADD "… reversal".
    is_sale = reason.lower().startswith(WHOLESALE_SALE_PREFIX)
    if adj.adjustment_type == 'ADD':
        lines = [_line('INVENTORY', debit=value, memo=f"{adj.quantity} × {name} added"),
                 _line('COGS' if is_sale else 'STOCK_GAIN', credit=value, memo=reason or 'Stock adjustment')]
    else:
        lines = [_line('COGS' if is_sale else 'STOCK_LOSS', debit=value, memo=reason or 'Stock adjustment'),
                 _line('INVENTORY', credit=value, memo=f"{adj.quantity} × {name} removed")]
    return {
        'date': _date(adj.created_at), 'branch': adj.branch, 'voucher_type_code': 'IA',
        'source_number': reason[:80], 'reference_type': 'STOCK_ADJUSTMENT',
        'narration': f"Stock adjustment ({adj.adjustment_type}) {adj.quantity} × {name}: {reason}"[:500],
        'metadata': meta, 'lines': lines,
    }
