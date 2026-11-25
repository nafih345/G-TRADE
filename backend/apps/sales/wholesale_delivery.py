"""Wholesale Order Status — stock now, Accounts on delivery (Wholesale Distribution).

With the client's `wholesale_order_status` module feature on (Client Management → Modules →
Wholesale Distribution; module_access.MODULE_FEATURES), a Wholesale Order billed in the POS goes
through three states held on its WholesaleInvoice:

    Order CONFIRMED                 reserves stock (sales.wholesale_orders), nothing posted
      └ "Order to Sale" → Complete  INVOICED_PENDING_DELIVERY:
                                      stock deducted at once  ("Wholesale Invoice - Pending Delivery X")
                                      invoice.delivery_status = PENDING_DELIVERY
                                      invoice.is_posted_to_accounts = False → no journal at all
         ├ Delivered / Post         DELIVERED_POSTED:
         │                            is_posted_to_accounts = True → the invoice journal (AR / Sales /
         │                            Tax) and the COGS of the stock it took are booked, dated the
         │                            delivery day. Stock is NOT moved again.
         └ Not Delivered / Cancel   CANCELLED / UNDELIVERED:
                                      invoice voided (status Cancelled, never posted), its stock put
                                      back ("Wholesale Delivery Cancelled - Stock Reversed X"), order
                                      closed as UNDELIVERED. Nothing was posted, so nothing to reverse.

How the hold works with the rest of the system:
  * Stock: sales.wholesale_stock moves the units as for any bill, only the StockAdjustment reasons
    differ (stock_reasons). financial.posting_rules.build_stock_adjustment books no COGS for those
    reasons until the invoice is DELIVERED; mark_delivered then re-queues them so COGS is booked
    once, with the revenue.
  * Accounts: posting_rules.build_wholesale_invoice books nothing while is_posted_to_accounts is
    False (the integration's exactly-once machinery is unchanged).
  * Direct POS sales, bills from before the feature, and every client without it: delivery_status
    stays NULL and is_posted_to_accounts True — exactly the old behaviour.

Every state change runs in one transaction (row locks on the order and the invoice), so a power cut
or dropped connection leaves either the old state or the new one — never stock without its status.
"""
from datetime import date as date_cls

from django.db import transaction
from django.db.models import F
from django.utils import timezone
from rest_framework.exceptions import ValidationError

FEATURE = 'wholesale_order_status'

PENDING = 'PENDING_DELIVERY'
DELIVERED = 'DELIVERED'
UNDELIVERED = 'UNDELIVERED'

# StockAdjustment / StockLedger reasons for delivery-tracked bills.
PENDING_SALE_REASON = 'Wholesale Invoice - Pending Delivery {no}'
PENDING_REVERSAL_REASON = 'Wholesale Invoice - Pending Delivery reversal {no}'
DELIVERY_CANCELLED_REASON = 'Wholesale Delivery Cancelled - Stock Reversed {no}'
PENDING_PREFIX = 'wholesale invoice - pending delivery'
CANCELLED_PREFIX = 'wholesale delivery cancelled'

# Order Status stages (what the screen shows; derived from order + invoice).
STAGE_CONFIRMED = 'CONFIRMED'
STAGE_PENDING = 'INVOICED_PENDING_DELIVERY'
STAGE_DELIVERED = 'DELIVERED_POSTED'
STAGE_BILLED = 'BILLED'              # billed without delivery tracking (posted on billing)
STAGE_UNDELIVERED = 'UNDELIVERED'
STAGE_CANCELLED = 'CANCELLED'


def feature_enabled(tenant_id=None):
    from apps.common.module_access import tenant_has_feature
    return tenant_has_feature(FEATURE, tenant_id)


def held_bill_count(tenant_id):
    """Wholesale bills of a tenant still held for delivery (not yet posted to Accounts)."""
    from apps.common import tenancy
    from .models import WholesaleInvoice
    with tenancy.use_tenant(tenant_id):
        return WholesaleInvoice.objects.filter(delivery_status=PENDING).count()


def stock_reasons(inv):
    """(take-out reason, put-back reason) templates for a wholesale bill's stock movements."""
    from .wholesale_stock import REVERSAL_REASON, SALE_REASON
    status = getattr(inv, 'delivery_status', None)
    if status == UNDELIVERED:
        return PENDING_SALE_REASON, DELIVERY_CANCELLED_REASON
    if status == PENDING:
        return PENDING_SALE_REASON, PENDING_REVERSAL_REASON
    return SALE_REASON, REVERSAL_REASON


def order_stage(order, invoice=None):
    from .wholesale_orders import ORDER_BILLED, ORDER_CANCELLED, ORDER_CONFIRMED, ORDER_UNDELIVERED
    if order.status == ORDER_CONFIRMED:
        return STAGE_CONFIRMED
    if order.status == ORDER_CANCELLED:
        return STAGE_CANCELLED
    if order.status == ORDER_UNDELIVERED:
        return STAGE_UNDELIVERED
    if order.status == ORDER_BILLED:
        inv = invoice if invoice is not None else getattr(order, 'invoice', None)
        status = getattr(inv, 'delivery_status', None)
        if status == PENDING:
            return STAGE_PENDING
        if status == DELIVERED:
            return STAGE_DELIVERED
        return STAGE_BILLED
    return order.status


# ---------------------------------------------------------------------------
# Invoice save hooks (WholesaleInvoiceViewSet, inside the save transaction, before stock moves)
# ---------------------------------------------------------------------------

def guard_invoice_change(old):
    """A voided (undelivered) bill is final: refuse any further change to it."""
    if old is not None and old.delivery_status == UNDELIVERED:
        raise ValidationError({'detail': (
            f'Invoice {old.invoice_number} was cancelled as undelivered and its stock restored — it '
            'can no longer be changed or posted. Bill the dealer again from a new order if needed.')})


def prepare_invoice_save(invoice, *, was_billing):
    """Set the delivery state the save implies, before the stock sync picks its reasons.

    * The save that first bills a Wholesale Order (feature on) puts the bill on hold:
      PENDING_DELIVERY, not posted.
    * A held bill cancelled / drafted from the POS is voided as UNDELIVERED (never posted, its
      stock goes back under the delivery-cancelled reason); its order re-opens, as a cancelled
      bill's order always has. Only the Order Status "Not Delivered" action closes the order.
    """
    from .wholesale_orders import _invoice_bills, _ref_id
    fields = {}
    if invoice.delivery_status == PENDING and not _invoice_bills(invoice):
        fields = {'delivery_status': UNDELIVERED, 'is_posted_to_accounts': False,
                  'delivery_updated_at': timezone.now()}
    elif (invoice.delivery_status is None and not was_billing and _invoice_bills(invoice)
          and _ref_id(invoice.details or {}, 'linkedOrder') and feature_enabled()):
        fields = {'delivery_status': PENDING, 'is_posted_to_accounts': False,
                  'delivery_updated_at': timezone.now()}
    if fields:
        for k, v in fields.items():
            setattr(invoice, k, v)
        type(invoice).all_objects.filter(pk=invoice.pk).update(**fields)
    return invoice


# ---------------------------------------------------------------------------
# Order Status actions
# ---------------------------------------------------------------------------

def _locked_pair(order_id):
    from .models import WholesaleInvoice, WholesaleOrder
    from .wholesale_orders import ORDER_BILLED
    order = WholesaleOrder.objects.select_for_update().filter(pk=order_id).first()
    if order is None:
        raise ValidationError({'detail': 'That order no longer exists.'})
    invoice = None
    if order.invoice_id:
        invoice = WholesaleInvoice.all_objects.select_for_update().filter(pk=order.invoice_id).first()
    if order.status != ORDER_BILLED and not (invoice is not None and invoice.delivery_status == UNDELIVERED):
        raise ValidationError({'detail': (
            f'Order {order.order_number} has not been invoiced yet — use Order to Sale first.')})
    if invoice is None or invoice.is_deleted:
        raise ValidationError({'detail': f'The invoice of order {order.order_number} no longer exists.'})
    return order, invoice


def _actor(user):
    if user is None or not getattr(user, 'is_authenticated', False):
        return ''
    return (getattr(user, 'username', '') or '')[:150]


def _parse_day(value, invoice):
    if value in (None, ''):
        return timezone.localdate()
    if isinstance(value, date_cls):
        day = value
    else:
        try:
            day = date_cls.fromisoformat(str(value)[:10])
        except ValueError:
            raise ValidationError({'delivery_date': 'Enter the delivery date as YYYY-MM-DD.'})
    if day > timezone.localdate():
        raise ValidationError({'delivery_date': 'The delivery date cannot be in the future.'})
    if invoice.invoice_date and day < invoice.invoice_date:
        raise ValidationError({'delivery_date': (
            f'The delivery date cannot be before the invoice date ({invoice.invoice_date:%d-%m-%Y}).')})
    return day


def _pending_adjustment_ids(invoice):
    from apps.inventory.models import StockAdjustment
    return list(StockAdjustment.all_objects.filter(
        reference=invoice.invoice_number[:100], reason__istartswith=PENDING_PREFIX).values_list('pk', flat=True))


@transaction.atomic
def mark_delivered(order_id, *, delivery_date=None, note='', user=None):
    """Delivered / Post: release the held bill to Accounts. Never moves stock. Idempotent."""
    from apps.financial import integration
    from .models import Dealer
    from .wholesale_stock import _is_active
    order, invoice = _locked_pair(order_id)
    if invoice.delivery_status == DELIVERED:
        return order, invoice, False
    if invoice.delivery_status != PENDING:
        if invoice.delivery_status == UNDELIVERED:
            raise ValidationError({'detail': f'Invoice {invoice.invoice_number} was cancelled as undelivered — it cannot be posted.'})
        raise ValidationError({'detail': (
            f'Invoice {invoice.invoice_number} is not awaiting delivery (it was posted to Accounts when it was billed).')})
    if not _is_active(invoice):
        raise ValidationError({'detail': f'Invoice {invoice.invoice_number} is cancelled — it cannot be posted.'})
    day = _parse_day(delivery_date, invoice)
    invoice.delivery_status = DELIVERED
    invoice.is_posted_to_accounts = True
    invoice.delivered_on = day
    invoice.delivery_note = (note or '').strip()[:2000]
    invoice.delivery_updated_at = timezone.now()
    invoice.delivery_updated_by = _actor(user)
    invoice.save(update_fields=['delivery_status', 'is_posted_to_accounts', 'delivered_on', 'delivery_note',
                                'delivery_updated_at', 'delivery_updated_by', 'updated_at'])
    # Accounts (after commit, exactly once): the invoice journal, then the COGS of the stock it
    # took while pending (those adjustments booked nothing until now).
    integration.schedule('sales.wholesale_invoice', invoice.pk)
    for pk in _pending_adjustment_ids(invoice):
        integration.schedule('inventory.stock_adjustment', pk)
    # The dealer's running balance (kept by the POS on billing) moves now, not when the bill was held.
    due = invoice.due_amount or 0
    if invoice.dealer_id and due:
        Dealer.objects.filter(pk=invoice.dealer_id).update(outstanding_balance=F('outstanding_balance') + due)
    return order, invoice, True


@transaction.atomic
def cancel_delivery(order_id, *, reason='', user=None, request=None):
    """Not Delivered / Cancel Delivery: void the held bill, put its stock back, close the order.
    Only an unposted bill can be cancelled this way (a delivered one needs a Wholesale Return)."""
    from .models import WholesalePaymentCollection
    from .wholesale_orders import link_invoice_orders
    from .wholesale_stock import sync_wholesale_invoice_stock
    order, invoice = _locked_pair(order_id)
    if invoice.delivery_status == UNDELIVERED:
        return order, invoice, False, 0
    if invoice.delivery_status == DELIVERED or invoice.is_posted_to_accounts:
        raise ValidationError({'detail': (
            f'Invoice {invoice.invoice_number} is already posted to Accounts — record a Wholesale Return instead.')})
    if invoice.delivery_status != PENDING:
        raise ValidationError({'detail': f'Invoice {invoice.invoice_number} is not awaiting delivery.'})
    reason = (reason or '').strip()[:2000]
    details = dict(invoice.details or {})
    details['orderStatus'] = 'Cancelled'
    details['deliveryCancelled'] = {'at': timezone.now().isoformat(), 'by': _actor(user), 'reason': reason}
    invoice.details = details
    invoice.status = 'Cancelled'
    invoice.delivery_status = UNDELIVERED
    invoice.is_posted_to_accounts = False
    invoice.delivery_note = reason
    invoice.delivery_updated_at = timezone.now()
    invoice.delivery_updated_by = _actor(user)
    invoice.save(update_fields=['details', 'status', 'delivery_status', 'is_posted_to_accounts', 'delivery_note',
                                'delivery_updated_at', 'delivery_updated_by', 'updated_at'])
    # Everything the bill held goes back (restores never trip the negative-stock guard).
    sync_wholesale_invoice_stock(invoice, request, enforce_stock=False)
    link_invoice_orders(invoice)  # the order closes as UNDELIVERED
    order.refresh_from_db()
    # Money already collected against the bill stays on the dealer's account as an advance.
    received = sum((c.amount_paid or 0) for c in WholesalePaymentCollection.objects.filter(
        invoice_number=invoice.invoice_number, dealer_id=invoice.dealer_id))
    return order, invoice, True, received
