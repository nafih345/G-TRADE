"""Lens Purchase Order (Purchase → Lens Purchase Order): ordering prescription lenses from a lab
with every physical lens mapped to the customer order it was made for.

    /api/purchase/lens-orders/                          list / create (DRAFT, PENDING or ORDERED)
    /api/purchase/lens-orders/<id>/                     detail / edit (rules: _edit_scope)
    /api/purchase/lens-orders/<id>/submit/              DRAFT -> PENDING
    /api/purchase/lens-orders/<id>/mark-ordered/        PENDING -> ORDERED (sent to the lab)
    /api/purchase/lens-orders/<id>/receive/             verify pieces one by one
    /api/purchase/lens-orders/<id>/cancel/              nothing received, no live invoice
    /api/purchase/lens-orders/<id>/invoice-draft/       Purchase Entry lines for the received lenses
    /api/purchase/lens-orders/pending-requirements/     sales-order lenses still to be ordered
    /api/purchase/lens-orders/sales-queue/              Sales > Orders > Lenses: one row per customer order
    /api/purchase/lens-orders/reserved-stock/           stocked lenses held for not-yet-billed orders
    /api/purchase/lens-orders/order-draft/              Purchase Entry lines for one customer order (by Order Number)

A "lens requirement" is one eye of one lens line on a sales Order / Invoice: a PAIR line needs
RE + LE, a PIECE line its own eye, times the line quantity. New Sale edits recreate an order's
lines, so a requirement is identified by (sales order, product, eye), never by the line's id.
Every piece on a live (not cancelled) PO holds its requirement — discrepancy pieces included,
since the lab's replacement is received against the same piece — so it can't be ordered twice.

Nothing here moves stock or posts accounting. Goods come in when the PO is converted into an
ordinary Purchase Entry: PurchaseInvoiceViewSet.perform_create calls link_purchase_invoice, in
the same transaction that applies the entry's stock and payables, and the one-to-one
LensPurchaseOrder.purchase_invoice makes a second conversion impossible.

Purchase Entry can also pull lenses in by customer Order Number (order-draft): the order's lenses
still waiting - not yet ordered, or placed on a Lens PO with this supplier - become entry lines,
and saving the entry (receive_orders_into_invoice) receives them on the actual received date:
pending lenses get a Lens PO created as received, placed ones are received on their PO (moved to
a PO of their own first when that PO also carries other customers' lenses), and every such PO is
linked to the entry. One entry may therefore bill several POs; each PO is still billed only once.
"""
import math
from collections import Counter
from datetime import date, datetime, time
from decimal import Decimal, ROUND_HALF_UP

from django.db import transaction
from django.db.models import Prefetch, Q
from django.utils import timezone
from rest_framework import permissions, serializers, status, viewsets
from rest_framework.decorators import action
from rest_framework.response import Response

from apps.common.branch_context import get_active_branch
from apps.common.branch_mixins import BranchScopedViewSetMixin
from apps.common.request_actor import get_actor
from apps.products.models import Product
from apps.sales.lens_units import LE, PAIR, PIECE, PIECES_PER_UNIT, RE, eye_value_errors
from apps.sales.models import EyeExamination, Invoice

from .models import LensPurchaseOrder, LensPurchaseOrderItem, LensPurchaseOrderPiece, Supplier

EYES = (RE, LE)
EYE_LABEL = {RE: 'Right (OD)', LE: 'Left (OS)'}
RX_FIELDS = ('sph', 'cyl', 'axis', 'add', 'prism', 'base')
PIECES_FOR_TYPE = {
    LensPurchaseOrderItem.SINGLE_PAIR: 2,
    LensPurchaseOrderItem.SPLIT_PAIR: 2,
    LensPurchaseOrderItem.SINGLE_PIECE: 1,
}
DISCREPANCY = ('DAMAGED', 'MISSING', 'INCORRECT')
RECEIVING_STATES = ('RECEIVED',) + DISCREPANCY

# Sales-order lab stages this module may set (Invoice.fulfillment_status; the full list lives in
# the frontend's OrdersManagerView / UpdateDocumentDialog). Only ever moved forward, and only
# while the order is still in one of these early stages — never over a later manual stage.
# New Sale saves a lens order at STAGE_PENDING_PURCHASE; STAGE_READY follows once the received
# lenses are in stock through their Purchase Entry (and so held for this order, see reserved_stock).
STAGE_PENDING_PURCHASE = 'Pending Supplier Purchase'
STAGE_LENS_ORDERED = 'In Lab Processing'
STAGE_WAITING = 'Awaiting Remaining Lens'
STAGE_ARRIVED = 'Lens Arrived'
STAGE_READY = 'Ready for Delivery'
_EARLY_STAGE_RANK = {'': 0, 'order received': 0, 'pending supplier purchase': 0, 'in lab processing': 1,
                     'awaiting remaining lens': 2, 'lens arrived': 3, 'ready for delivery': 4}

# Sales > Orders > Lenses queue status of one customer order (see order_queue_row).
QUEUE_STATUSES = {
    'PENDING_PURCHASE': 'Pending Supplier Purchase',
    'PURCHASE_PLACED': 'Purchase Placed',
    'PARTIALLY_RECEIVED': 'Partially Received',
    'RECEIVED_NOT_STOCKED': 'Received — Purchase Entry Pending',
    'READY': 'Received / Ready for Delivery',
    'IN_STOCK': 'In Stock — Ready',
    'DELIVERED': 'Delivered',
}

TWO = Decimal('0.01')


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _log(po, action_name, detail=''):
    po.history = list(po.history or []) + [{
        'at': timezone.now().isoformat(), 'by': get_actor() or '', 'action': action_name, 'detail': detail,
    }]


def clean_rx(rx):
    rx = rx if isinstance(rx, dict) else {}
    out = {}
    for f in RX_FIELDS:
        v = rx.get(f)
        v = '' if v is None else str(v).strip()
        out[f] = v.upper() if f == 'base' else v
    return out


def _same_rx(a, b):
    def norm(v):
        try:
            return str(Decimal(v).normalize()) if v not in ('',) else ''
        except Exception:  # noqa: BLE001 — non-numeric (PL, base) compares as text
            return str(v).upper()
    a, b = clean_rx(a), clean_rx(b)
    return all(norm(a[f]) == norm(b[f]) for f in RX_FIELDS)


def rx_summary(rx):
    rx = clean_rx(rx)
    parts = [f'{label} {rx[f]}' for f, label in (('sph', 'SPH'), ('cyl', 'CYL'), ('axis', 'AXIS'), ('add', 'ADD')) if rx[f]]
    if rx['prism']:
        parts.append(f"PRISM {rx['prism']}{(' ' + rx['base']) if rx['base'] else ''}")
    return ' '.join(parts)


def is_lens_line(item):
    return item.selling_unit in (PAIR, PIECE) or (item.item_type or '').upper() == 'LENS'


def line_eyes(item):
    unit = item.selling_unit or PAIR  # lens lines from before lens units were sold as pairs
    if unit == PAIR:
        return list(EYES)
    return [item.lens_eye] if item.lens_eye in EYES else []


def _exam_rx(customer_id, eye):
    """The patient's latest subjective refraction for one eye (fallback when the order's lens
    line carries no prescription — e.g. lines billed before per-line Rx existed)."""
    if not customer_id:
        return {}
    exam = EyeExamination.objects.filter(customer_id=customer_id).order_by('-examination_date', '-created_at').first()
    if not exam:
        return {}
    side = 'od' if eye == RE else 'os'
    return clean_rx({f: getattr(exam, f'sub_{f}_{side}', '') or '' for f in ('sph', 'cyl', 'axis', 'add', 'prism')})


def line_rx(item, eye):
    details = item.lens_details if isinstance(item.lens_details, dict) else {}
    rx = (details.get('rx') or {}).get('re' if eye == RE else 'le') or {}
    return clean_rx(rx)


def line_specs(item, details=None):
    """Lens design (type) and coating as sold — the line's snapshot first, then the product master —
    so the Lens PO is pre-filled and never asks for them again."""
    details = details if isinstance(details, dict) else (item.lens_details if isinstance(item.lens_details, dict) else {})
    specs = details.get('specs') if isinstance(details.get('specs'), dict) else {}
    extra = (item.product.extra_data if item.product_id and item.product else None) or {}
    pick = lambda *vals: next((str(v).strip() for v in vals if str(v or '').strip()), '')
    return {'lens_type': pick(specs.get('design'), extra.get('lens_design'), extra.get('lens_type')),
            'lens_coating': pick(specs.get('coating'), extra.get('coating'), extra.get('lens_coating'))}


def order_requirements(order):
    """{(product_id, eye): {'count', 'item', 'rx', 'lens_index'}} for one sales order's lens lines.
    product_id None = a custom lens line with no product, which any lens model may fill."""
    reqs = {}
    for item in order.items.all():
        if not is_lens_line(item):
            continue
        qty = max(1, int(item.quantity or 1))
        details = item.lens_details if isinstance(item.lens_details, dict) else {}
        for eye in line_eyes(item):
            key = (item.product_id, eye)
            if key in reqs:
                reqs[key]['count'] += qty
                continue
            rx = line_rx(item, eye)
            reqs[key] = {'count': qty, 'item': item, 'lens_index': str(details.get('lens_index') or '').strip(),
                         'rx': rx if any(rx.values()) else _exam_rx(order.customer_id, eye),
                         **line_specs(item, details)}
    return reqs


def po_stocked(po):
    """The PO's lenses are in stock: converted into a live, non-draft Purchase Entry."""
    inv = po.purchase_invoice
    return inv is not None and not inv.is_deleted and inv.status not in ('DRAFT', 'CANCELLED')


def stock_units(product, pieces):
    """Stock units one order's lenses of a product take: pieces, or whole pairs rounded up."""
    if str(((product.extra_data if product else None) or {}).get('lens_stock_unit') or '').upper() == PIECE:
        return pieces
    return math.ceil(pieces / 2)


def live_pieces():
    """Pieces that hold their requirement: on a PO that isn't cancelled or deleted."""
    return LensPurchaseOrderPiece.objects.filter(
        is_deleted=False, item__is_deleted=False, item__order__is_deleted=False,
    ).exclude(item__order__status='CANCELLED')


def _claims(order_ids, exclude_po=None):
    qs = live_pieces().filter(sales_order_id__in=order_ids)
    if exclude_po is not None:
        qs = qs.exclude(item__order=exclude_po)
    return Counter((p['sales_order_id'], p['item__product_id'], p['eye'])
                   for p in qs.values('sales_order_id', 'item__product_id', 'eye'))


def _order_blocker(order):
    """Why a sales order can't take a lens order, or ''."""
    if order.is_deleted:
        return 'has been deleted'
    if (order.document_type or 'INVOICE').upper() == 'QUOTATION':
        return 'is a quotation — convert it to an order first'
    if (order.status or '').upper() == 'CANCELLED':
        return 'is cancelled'
    if (order.fulfillment_status or '').strip().lower().startswith('delivered') or order.delivered_at:
        return 'has already been delivered'
    return ''


def _fmt_qty(unit, n):
    return f'{n} Pair ({n * 2} Pieces)' if unit == PAIR else f"{n} Piece{'s' if n != 1 else ''} ({n} Lens{'es' if n != 1 else ''})"


def _money(v):
    return Decimal(v or 0).quantize(TWO, rounding=ROUND_HALF_UP)


# ---------------------------------------------------------------------------
# Serializers
# ---------------------------------------------------------------------------

class LensPOPieceSerializer(serializers.ModelSerializer):
    sales_order = serializers.PrimaryKeyRelatedField(queryset=Invoice.all_objects.all())
    sales_order_number = serializers.CharField(source='sales_order.invoice_number', read_only=True)
    sales_order_date = serializers.DateField(source='sales_order.invoice_date', read_only=True)
    sales_order_status = serializers.CharField(source='sales_order.fulfillment_status', read_only=True, default='')
    patient_code = serializers.CharField(source='customer.patient_code', read_only=True, default='')
    rx_changed = serializers.SerializerMethodField()

    class Meta:
        model = LensPurchaseOrderPiece
        fields = ['id', 'piece_number', 'customer', 'customer_name', 'patient_code', 'sales_order',
                  'sales_order_number', 'sales_order_date', 'sales_order_status', 'sales_order_item', 'eye',
                  'rx', 'original_rx', 'rx_change_reason', 'rx_changed', 'piece_reference', 'receiving_status',
                  'received_at', 'received_by', 'discrepancy_notes', 'fitting_status']
        # Set by the server from the sales order / receiving workflow, never by the client.
        read_only_fields = ['customer', 'customer_name', 'sales_order_item', 'original_rx', 'receiving_status',
                            'received_at', 'received_by', 'discrepancy_notes', 'fitting_status']

    def get_rx_changed(self, obj):
        return bool(obj.original_rx) and not _same_rx(obj.rx, obj.original_rx)


class LensPOItemSerializer(serializers.ModelSerializer):
    pieces = LensPOPieceSerializer(many=True)
    product = serializers.PrimaryKeyRelatedField(queryset=Product.all_objects.all())
    product_name = serializers.CharField(source='product.name', read_only=True)
    quantity_label = serializers.SerializerMethodField()

    class Meta:
        model = LensPurchaseOrderItem
        fields = ['id', 'product', 'product_name', 'lens_model', 'lens_type', 'lens_index', 'lens_coating',
                  'order_type', 'commercial_quantity', 'commercial_unit', 'physical_quantity', 'physical_unit',
                  'quantity_label', 'unit_price', 'pricing_unit', 'discount_amount', 'tax_percent', 'line_total',
                  'status', 'pieces']
        # Quantities and totals are derived from the order type, never trusted from the client.
        read_only_fields = ['commercial_quantity', 'commercial_unit', 'physical_quantity', 'physical_unit',
                            'line_total', 'status']

    def get_quantity_label(self, obj):
        return _fmt_qty(obj.commercial_unit, obj.commercial_quantity)


class LensPurchaseOrderSerializer(serializers.ModelSerializer):
    items = LensPOItemSerializer(many=True, required=False)
    supplier = serializers.PrimaryKeyRelatedField(queryset=Supplier.all_objects.all())
    supplier_name = serializers.CharField(source='supplier.name', read_only=True)
    purchase_invoice_number = serializers.SerializerMethodField()
    purchase_invoice_status = serializers.SerializerMethodField()
    po_number = serializers.CharField(required=False, allow_blank=True)
    status = serializers.ChoiceField(choices=['DRAFT', 'PENDING', 'ORDERED'], required=False)

    class Meta:
        model = LensPurchaseOrder
        fields = ['id', 'po_number', 'supplier', 'supplier_name', 'branch', 'order_date', 'expected_delivery_date',
                  'status', 'remarks', 'created_by_name', 'created_at', 'updated_at', 'purchase_invoice',
                  'purchase_invoice_number', 'purchase_invoice_status', 'history', 'items']
        read_only_fields = ['branch', 'created_by_name', 'purchase_invoice', 'history']

    def _live_invoice(self, obj):
        inv = obj.purchase_invoice
        return inv if inv is not None and not inv.is_deleted and inv.status != 'CANCELLED' else None

    def get_purchase_invoice_number(self, obj):
        inv = self._live_invoice(obj)
        return inv.invoice_number if inv else ''

    def get_purchase_invoice_status(self, obj):
        inv = self._live_invoice(obj)
        return inv.status if inv else ''

    def to_representation(self, obj):
        data = super().to_representation(obj)
        if not self._live_invoice(obj):
            data['purchase_invoice'] = None
        data['status'] = obj.status  # the write field only accepts the creatable states
        pieces = [p for it in data.get('items') or [] for p in it['pieces']]
        data['summary'] = {
            'pairs': sum(it['commercial_quantity'] for it in data.get('items') or [] if it['commercial_unit'] == PAIR),
            'pieces': len(pieces),
            'received': sum(1 for p in pieces if p['receiving_status'] == 'RECEIVED'),
            'discrepancies': sum(1 for p in pieces if p['receiving_status'] in DISCREPANCY),
            'customers': sorted({p['customer_name'] for p in pieces if p['customer_name']}),
            'sales_orders': sorted({p['sales_order_number'] for p in pieces if p.get('sales_order_number')}),
            'lens_models': sorted({it['lens_model'] or it['product_name'] for it in data.get('items') or []}),
            'order_types': sorted({it['order_type'] for it in data.get('items') or []}),
            'total': str(sum((Decimal(it['line_total']) for it in data.get('items') or []), Decimal('0'))),
        }
        return data

    # ---- validation ------------------------------------------------------------------------

    def validate(self, attrs):
        attrs = super().validate(attrs)
        po = self.instance
        if po is not None:
            _check_edit_allowed(po, attrs)
            attrs.pop('status', None)  # an existing PO changes status through the workflow actions only
        items = attrs.get('items')
        if items is not None:
            if po is None and not items and attrs.get('status', 'DRAFT') != 'DRAFT':
                raise serializers.ValidationError({'items': ['Add at least one lens before submitting the order.']})
            attrs['items'] = _validate_items(items, exclude_po=po)
        elif po is None and attrs.get('status', 'DRAFT') != 'DRAFT':
            raise serializers.ValidationError({'items': ['Add at least one lens before submitting the order.']})
        return attrs

    # ---- persistence -----------------------------------------------------------------------

    def create(self, validated_data):
        items = validated_data.pop('items', [])
        po = LensPurchaseOrder.objects.create(**validated_data)
        _log(po, 'CREATED', f"Status {po.status}; {_items_text(items)}")
        if any(p.get('rx_change_reason') for it in items for p in it['pieces']):
            _log(po, 'RX_CHANGED', _rx_change_text(items))
        _save_items(po, items)
        po.save(update_fields=['history'])
        return po

    def update(self, po, validated_data):
        items = validated_data.pop('items', None)
        if 'supplier' in validated_data and validated_data['supplier'].pk != po.supplier_id:
            _log(po, 'VENDOR_CHANGED', f"{po.supplier.name} → {validated_data['supplier'].name}")
        for attr, value in validated_data.items():
            setattr(po, attr, value)
        if items is not None:
            before = _items_text_from_db(po)
            after = _items_text(items)
            if before != after:
                _log(po, 'ASSIGNMENTS_CHANGED', f'{before} → {after}')
            if any(p.get('rx_change_reason') for it in items for p in it['pieces']):
                _log(po, 'RX_CHANGED', _rx_change_text(items))
            for item in po.items.all():
                item.pieces.all().delete()
            po.items.all().delete()
            _save_items(po, items)
        elif validated_data:
            _log(po, 'UPDATED', ', '.join(sorted(validated_data)))
        po.save()
        return po


def _edit_scope(po):
    """'full' (items + vendor), 'header' (dates / remarks) or 'remarks'."""
    if po.status in ('DRAFT', 'PENDING'):
        return 'full'
    if po.status == 'ORDERED':
        return 'header'
    return 'remarks'


def _check_edit_allowed(po, attrs):
    scope = _edit_scope(po)
    if scope == 'full':
        return
    if 'items' in attrs:
        raise serializers.ValidationError({'items': [
            f'This PO is {po.get_status_display()} — its lenses can no longer be changed. '
            'Cancel it and raise a new one if the lab order changed.']})
    if 'supplier' in attrs and attrs['supplier'].pk != po.supplier_id:
        raise serializers.ValidationError({'supplier': [f'The vendor of a {po.get_status_display()} PO cannot be changed.']})
    if scope == 'remarks':
        blocked = [f for f in ('order_date', 'expected_delivery_date') if f in attrs and attrs[f] != getattr(po, f)]
        if blocked:
            raise serializers.ValidationError({blocked[0]: [f'A {po.get_status_display()} PO only accepts remarks.']})


def _validate_items(items, exclude_po):
    errors, cleaned = [], []
    order_ids = {p['sales_order'].pk for it in items for p in it.get('pieces') or []}
    orders = {o.pk: o for o in Invoice.all_objects.filter(pk__in=order_ids)
              .select_related('customer').prefetch_related('items')}
    reqs = {pk: order_requirements(o) for pk, o in orders.items()}
    claimed = _claims(order_ids, exclude_po=exclude_po)
    in_payload = Counter()

    for n, it in enumerate(items, start=1):
        order_type = it.get('order_type')
        product = it['product']
        label = f"Lens {n} ({it.get('lens_model') or product.name})"
        pieces = it.get('pieces') or []
        if product.is_deleted:
            errors.append(f'{label}: this lens product has been deleted from the product master.')
            continue
        if order_type not in PIECES_FOR_TYPE:
            errors.append(f'{label}: choose an order type.')
            continue
        if len(pieces) != PIECES_FOR_TYPE[order_type]:
            errors.append(f'{label}: a {dict(LensPurchaseOrderItem.ORDER_TYPE_CHOICES)[order_type]} '
                          f'order has exactly {PIECES_FOR_TYPE[order_type]} lens assignment(s).')
            continue
        if order_type == LensPurchaseOrderItem.SINGLE_PAIR:
            if pieces[0]['sales_order'].pk != pieces[1]['sales_order'].pk:
                errors.append(f'{label}: both lenses of a single-customer pair belong to the same sales order.')
            if sorted(p.get('eye') for p in pieces) != sorted(EYES):
                errors.append(f'{label}: a single-customer pair is one Right (OD) and one Left (OS) lens.')
        if order_type == LensPurchaseOrderItem.SPLIT_PAIR:
            a, b = pieces[0]['sales_order'], pieces[1]['sales_order']
            if a.pk == b.pk or (a.customer_id and a.customer_id == b.customer_id):
                errors.append(f'{label}: a split pair is for two different customers — '
                              'use Single Customer for both eyes of one order.')

        unit = PIECE if order_type == LensPurchaseOrderItem.SINGLE_PIECE else PAIR
        it['commercial_quantity'], it['commercial_unit'] = 1, unit
        it['physical_quantity'], it['physical_unit'] = PIECES_FOR_TYPE[order_type], PIECE
        pricing_unit = str(it.get('pricing_unit') or unit).upper()
        it['pricing_unit'] = pricing_unit if pricing_unit in PIECES_PER_UNIT else unit
        price = _money(it.get('unit_price'))
        # Price is per pricing unit: a pair-priced split pair costs one pair, a piece-priced
        # pair costs two pieces.
        units_billed = Decimal(PIECES_FOR_TYPE[order_type]) / PIECES_PER_UNIT[it['pricing_unit']]
        taxable = max(Decimal('0'), price * units_billed - _money(it.get('discount_amount')))
        it['line_total'] = _money(taxable * (1 + Decimal(it.get('tax_percent') or 0) / 100))
        it['lens_model'] = (it.get('lens_model') or product.name)[:255]

        for k, piece in enumerate(pieces, start=1):
            piece['piece_number'] = k
            plabel = f'{label}, piece {k}'
            order = orders.get(piece['sales_order'].pk)
            eye = str(piece.get('eye') or '').upper()
            piece['eye'] = eye
            if eye not in EYES:
                errors.append(f'{plabel}: select the eye — Right (OD) or Left (OS).')
                continue
            blocker = _order_blocker(order)
            if blocker:
                errors.append(f'{plabel}: sales order {order.invoice_number} {blocker}.')
                continue
            order_reqs = reqs[order.pk]
            req_key = (product.pk, eye) if (product.pk, eye) in order_reqs else (None, eye)
            req = order_reqs.get(req_key)
            if req is None:
                other = sorted({r['item'].description or 'lens' for (_pid, e), r in order_reqs.items() if e == eye})
                errors.append(
                    f'{plabel}: sales order {order.invoice_number} has no {EYE_LABEL[eye]} requirement for {product.name}'
                    + (f" (it needs {', '.join(other)})." if other else ' — it has no lens for that eye.'))
                continue
            if req['lens_index'] and it.get('lens_index') and str(it['lens_index']).strip() != req['lens_index']:
                errors.append(f"{plabel}: index {it['lens_index']} doesn't match the {req['lens_index']} "
                              f'lens sold on {order.invoice_number}.')
                continue
            key = (order.pk, req_key[0], eye)
            in_payload[key] += 1
            already = claimed.get(key, 0) if req_key[0] is not None else sum(
                c for (o, _pid, e), c in claimed.items() if o == order.pk and e == eye)
            if already + in_payload[key] > req['count']:
                errors.append(f'{plabel}: the {EYE_LABEL[eye]} lens for {order.invoice_number} '
                              f"({order.customer_name or 'customer'}) has already been ordered.")
                continue

            original = clean_rx(req['rx'])
            rx = clean_rx(piece.get('rx') or original)
            rx_errors = eye_value_errors(rx, EYE_LABEL[eye])
            if not rx['sph']:
                rx_errors.append(f'{EYE_LABEL[eye]} SPH is required (0.00 or PL for plano).')
            errors += [f'{plabel}: {e}' for e in rx_errors]
            reason = str(piece.get('rx_change_reason') or '').strip()
            if any(original.values()) and not _same_rx(rx, original):
                if not reason:
                    errors.append(f"{plabel}: the prescription differs from sales order {order.invoice_number} "
                                  f'({rx_summary(original) or "blank"}). Give a reason for the change.')
            else:
                reason = ''
            piece.update({
                'rx': rx, 'original_rx': original, 'rx_change_reason': reason[:255],
                'customer': order.customer, 'sales_order_item': req['item'],
                'customer_name': (order.customer_name or (order.customer.name if order.customer else ''))[:150],
                'piece_reference': str(piece.get('piece_reference') or '').strip()[:100],
            })
        cleaned.append(it)
    if errors:
        raise serializers.ValidationError({'items': errors})
    return cleaned


def _save_items(po, items):
    for it in items:
        pieces = it.pop('pieces', [])
        item = LensPurchaseOrderItem.objects.create(order=po, **it)
        LensPurchaseOrderPiece.objects.bulk_create([LensPurchaseOrderPiece(item=item, **p) for p in pieces])
        it['pieces'] = pieces  # keep the payload intact for callers that log it


def _piece_text(p):
    order = p['sales_order'] if isinstance(p, dict) else p.sales_order
    eye = p['eye'] if isinstance(p, dict) else p.eye
    return f'{order.invoice_number} {eye}'


def _items_text(items):
    return '; '.join(f"{it.get('lens_model') or it['product'].name} [{', '.join(_piece_text(p) for p in it.get('pieces') or [])}]"
                     for it in items) or 'no lenses'


def _items_text_from_db(po):
    return '; '.join(f"{it.lens_model} [{', '.join(_piece_text(p) for p in it.pieces.select_related('sales_order'))}]"
                     for it in po.items.all()) or 'no lenses'


def _rx_change_text(items):
    return '; '.join(f"{p['sales_order'].invoice_number} {p['eye']}: {rx_summary(p['original_rx'])} → "
                     f"{rx_summary(p['rx'])} ({p['rx_change_reason']})"
                     for it in items for p in it['pieces'] if p.get('rx_change_reason'))


def next_po_number(given=None):
    """The next Lens PO number: Settings numbering sequence, else the typed one, else LPO-YYYY-NNNN."""
    from .views import _sequence_number
    number = _sequence_number('LENS_PO', LensPurchaseOrder, 'po_number', given)
    if number:
        return number
    given = (given or '').strip()
    if given and not LensPurchaseOrder.all_objects.filter(po_number=given).exists():
        return given
    year = timezone.localdate().year
    n = LensPurchaseOrder.all_objects.filter(po_number__startswith=f'LPO-{year}-').count() + 1
    while LensPurchaseOrder.all_objects.filter(po_number=f'LPO-{year}-{n:04d}').exists():
        n += 1
    return f'LPO-{year}-{n:04d}'


def received_at_for(value):
    """The moment lenses count as received for an "actual received date" typed by staff: now when
    it is today (or not given), else midday of that date. A date in the future is refused."""
    if value in (None, ''):
        return timezone.now()
    try:
        day = date.fromisoformat(str(value)[:10])
    except ValueError:
        raise serializers.ValidationError({'lens_received_date': ['Enter the received date as YYYY-MM-DD.']})
    today = timezone.localdate()
    if day > today:
        raise serializers.ValidationError({'lens_received_date': ['The lenses cannot be received on a future date.']})
    if day == today:
        return timezone.now()
    return timezone.make_aware(datetime.combine(day, time(12, 0)))


# ---------------------------------------------------------------------------
# Purchase Entry by customer Order Number
# ---------------------------------------------------------------------------

def _po_live_invoice(po):
    inv = po.purchase_invoice
    return inv if inv is not None and not inv.is_deleted and inv.status != 'CANCELLED' else None


def _piece_stock(product):
    return str(((product.extra_data if product else None) or {}).get('lens_stock_unit') or '').upper() == PIECE


def order_plan(order, supplier_id=None):
    """What a Purchase Entry would receive for one customer order's lenses.

    {'placed': {po_id: {'po', 'pieces', 'items'}}, 'pending': [(req, eye, n)], 'skipped': [text],
     'supplier': id|None, 'by_product': {product_id: {...}}}

    Placed = pieces on a live, not yet billed PO of `supplier_id` (when given; else of the one
    supplier those POs share) - DAMAGED / MISSING / INCORRECT pieces too, as the lab's replacement
    arrives against them. Pending = lenses the order needs that no live PO holds yet."""
    reqs = order_requirements(order)
    pieces = list(live_pieces().filter(sales_order=order).select_related(
        'item__product', 'item__order__supplier', 'item__order__purchase_invoice'))
    skipped, placed, supplier = [], {}, str(supplier_id) if supplier_id else None
    # Pieces on a PO already billed are in stock (or on an entry being finished elsewhere).
    open_pieces = [p for p in pieces if _po_live_invoice(p.item.order) is None]
    if supplier is None:
        sups = {str(p.item.order.supplier_id) for p in open_pieces}
        supplier = sups.pop() if len(sups) == 1 else None
    item_ids = {p.item_id for p in open_pieces}
    shared_items = set(LensPurchaseOrderPiece.objects.filter(item_id__in=item_ids, is_deleted=False)
                       .exclude(sales_order=order).values_list('item_id', flat=True))
    for p in open_pieces:
        po = p.item.order
        where = f"{EYE_LABEL.get(p.eye, p.eye)} {p.item.product.name if p.item.product_id else 'lens'} ({po.po_number})"
        if supplier and str(po.supplier_id) != supplier:
            skipped.append(f"{where} is ordered from {po.supplier.name if po.supplier_id else 'another supplier'} - "
                           "bill it on that supplier's purchase entry.")
            continue
        if p.item_id in shared_items:
            skipped.append(f"{where} is one pair shared with another customer order - bill it from "
                           "Purchase -> Lens Purchase Order.")
            continue
        g = placed.setdefault(po.pk, {'po': po, 'pieces': [], 'items': set()})
        g['pieces'].append(p)
        g['items'].add(p.item_id)

    # Requirements nobody has ordered yet (every live piece holds one, billed or not).
    held = Counter((p.item.product_id, p.eye) for p in pieces)
    held_eye = Counter(p.eye for p in pieces)
    pending = []
    for (pid, eye), req in reqs.items():
        taken = held[(pid, eye)] if pid is not None else held_eye[eye]
        left = req['count'] - taken
        if left <= 0:
            continue
        if pid is None:
            skipped.append(f"{EYE_LABEL[eye]} lens '{req['item'].description or 'custom lens'}' has no lens product - "
                           "pick the lens model on the order (or order it from Purchase -> Lens Purchase Order).")
            continue
        pending.append((req, eye, left))

    def bucket(product, tax):
        return by_product.setdefault(product.pk, {'product': product, 'pieces': 0, 'cost': Decimal('0'),
                                                  'discount': Decimal('0'), 'tax': tax, 'eyes': [], 'rx': [],
                                                  'pos': set(), 'pending': 0})

    by_product = {}
    for g in placed.values():
        for p in g['pieces']:
            item = p.item
            row = bucket(item.product, item.tax_percent)
            row['pieces'] += 1
            row['cost'] += _money(item.unit_price) / PIECES_PER_UNIT.get(item.pricing_unit, 2)
            row['discount'] += _money(item.discount_amount) / max(1, item.physical_quantity)
            row['eyes'].append(p.eye)
            row['rx'].append(f"{p.eye} {rx_summary(p.rx)}".strip())
            row['pos'].add(g['po'].po_number)
    for req, eye, n in pending:
        product = req['item'].product
        row = bucket(product, None)
        per_unit = _money(product.cost_price)
        row['pieces'] += n
        row['pending'] += n
        row['cost'] += (per_unit if _piece_stock(product) else per_unit / 2) * n
        row['eyes'] += [eye] * n
        row['rx'].append(f"{eye} {rx_summary(req['rx'])}".strip())
    return {'placed': placed, 'pending': pending, 'skipped': skipped, 'supplier': supplier, 'by_product': by_product}


def order_draft_lines(plan):
    """Purchase Entry lines for an order plan, one per lens product in its stock unit (one order's
    pair-stocked lenses round up to whole pairs - the same rule its sale deducts by)."""
    lines = []
    for row in plan['by_product'].values():
        product = row['product']
        qty = stock_units(product, row['pieces'])
        rate = _money(row['cost'] / qty) if qty else Decimal('0')
        gross = rate * qty
        eyes = Counter(row['eyes'])
        eye_text = ' + '.join(eye if eyes[eye] == 1 else f'{eye} x{eyes[eye]}' for eye in EYES if eyes[eye])
        pos = ', '.join(sorted(row['pos']))
        if row['pending'] == row['pieces']:
            state = 'not ordered yet'
        elif not row['pending']:
            state = f'on {pos}'
        else:
            state = f"{row['pieces'] - row['pending']} on {pos}, {row['pending']} not ordered yet"
        lines.append({
            'product': str(product.pk), 'product_name': product.name, 'quantity': qty,
            'stock_unit': PIECE if _piece_stock(product) else PAIR,
            'pieces': row['pieces'], 'eyes': eye_text, 'rx_summary': ' | '.join(r for r in row['rx'] if r),
            'purchase_rate': str(rate),
            # A lens nobody ordered yet has no PO tax: the entry falls back to the product's own.
            'gst_percent': None if row['tax'] is None else str(row['tax']),
            'discount_percent': str(_money(row['discount'] / gross * 100) if gross else Decimal('0')),
            'source': 'PENDING' if row['pending'] == row['pieces'] else 'PLACED' if not row['pending'] else 'MIXED',
            'note': f"{row['pieces']} lens(es) {eye_text} - {state}",
        })
    return lines


def _detach_items(po, item_ids, order):
    """Move one customer order's items off a PO that also carries other orders' lenses onto a PO
    of their own (same supplier, dates and status), so billing them doesn't bill the others."""
    new_po = LensPurchaseOrder.objects.create(
        po_number=next_po_number(), supplier_id=po.supplier_id, branch_id=po.branch_id, order_date=po.order_date,
        expected_delivery_date=po.expected_delivery_date, status=po.status,
        remarks=f'Split from {po.po_number} for customer order {order.invoice_number}',
        created_by_name=get_actor() or '',
    )
    LensPurchaseOrderItem.objects.filter(pk__in=item_ids).update(order=new_po, updated_at=timezone.now())
    _log(po, 'SPLIT', f'Lenses of {order.invoice_number} moved to {new_po.po_number}')
    po.save(update_fields=['history', 'updated_at'])
    _log(new_po, 'SPLIT', f'Split from {po.po_number} for {order.invoice_number}')
    new_po.save(update_fields=['history'])
    return new_po


def _received_po_for_pending(order, invoice, pending, received_at):
    """A Lens PO for lenses bought without one (they arrived with the bill): created already
    received, so the order's lab trail is the same as for an ordered lens."""
    actor = get_actor() or ''
    po = LensPurchaseOrder.objects.create(
        po_number=next_po_number(), supplier_id=invoice.supplier_id, branch_id=invoice.branch_id,
        order_date=timezone.localtime(received_at).date(), status='ORDERED',
        remarks=f'Received with Purchase Entry {invoice.invoice_number} for customer order {order.invoice_number}',
        created_by_name=actor,
    )
    customer = order.customer
    name = order.customer_name or (customer.name if customer else '')
    for req, eye, n in pending:
        item = req['item']
        product = item.product
        cost = _money(product.cost_price)
        unit_price = cost if _piece_stock(product) else _money(cost / 2)
        for _ in range(n):
            po_item = LensPurchaseOrderItem.objects.create(
                order=po, product=product, lens_model=product.name, lens_type=(req.get('lens_type') or '')[:100],
                lens_index=(req.get('lens_index') or '')[:30], lens_coating=(req.get('lens_coating') or '')[:100],
                order_type=LensPurchaseOrderItem.SINGLE_PIECE, commercial_quantity=1, commercial_unit=PIECE,
                physical_quantity=1, unit_price=unit_price, pricing_unit=PIECE, line_total=unit_price,
            )
            LensPurchaseOrderPiece.objects.create(
                item=po_item, piece_number=1, customer=customer, customer_name=name, sales_order=order,
                sales_order_item=item, eye=eye, rx=req['rx'], original_rx=req['rx'], receiving_status='RECEIVED',
                received_at=received_at, received_by=actor,
            )
    _log(po, 'RECEIVED', f'{sum(n for _r, _e, n in pending)} lens(es) arrived with Purchase Entry {invoice.invoice_number}')
    refresh_statuses(po)
    po.save()
    return po


def receive_orders_into_invoice(invoice, order_ids, received_on=None):
    """Purchase Entry save with customer orders pulled in by Order Number: receive each order's
    waiting lenses (at `received_on`, the actual received date) and link their Lens POs to this
    entry, inside the entry's own transaction. Returns the POs billed."""
    if invoice.status in ('DRAFT', 'CANCELLED'):
        raise serializers.ValidationError({'lens_sales_orders': [
            'Lenses pulled in by Order Number are received when the entry is saved as Confirmed - not as a draft.']})
    received_at = received_at_for(received_on)
    received_day = timezone.localtime(received_at).date()
    actor = get_actor() or ''
    billed = []
    for order_id in dict.fromkeys(str(o) for o in order_ids if o):
        order = Invoice.all_objects.select_for_update().filter(pk=order_id).first()
        if order is None:
            raise serializers.ValidationError({'lens_sales_orders': ['A customer order on this entry no longer exists.']})
        blocker = _order_blocker(order)
        if blocker:
            raise serializers.ValidationError({'lens_sales_orders': [f'Order {order.invoice_number} {blocker}.']})
        order = Invoice.all_objects.select_related('customer').prefetch_related('items__product').get(pk=order.pk)
        plan = order_plan(order, invoice.supplier_id)
        if not plan['placed'] and not plan['pending']:
            raise serializers.ValidationError({'lens_sales_orders': [
                f'Order {order.invoice_number} has no lenses waiting for this supplier - remove it from the entry.']})
        for po_id, g in plan['placed'].items():
            po = LensPurchaseOrder.objects.select_for_update().get(pk=po_id)
            if _po_live_invoice(po) is not None:
                raise serializers.ValidationError({'lens_sales_orders': [
                    f'Lens PO {po.po_number} was billed meanwhile on {po.purchase_invoice.invoice_number}.']})
            if LensPurchaseOrderItem.objects.filter(order=po).exclude(pk__in=g['items']).exists():
                po = _detach_items(po, g['items'], order)
            if po.status in ('DRAFT', 'PENDING'):
                po.status = 'ORDERED'
            touched = []
            for p in LensPurchaseOrderPiece.objects.select_for_update().filter(item__order=po):
                if p.receiving_status == 'RECEIVED':
                    continue
                p.receiving_status, p.received_at, p.received_by, p.discrepancy_notes = 'RECEIVED', received_at, actor, ''
                touched.append(p)
            if touched:
                LensPurchaseOrderPiece.objects.bulk_update(
                    touched, ['receiving_status', 'received_at', 'received_by', 'discrepancy_notes'])
                expected = po.expected_delivery_date
                late = f' (expected {expected:%d-%m-%Y})' if expected and expected != received_day else ''
                _log(po, 'RECEIVED', f'{len(touched)} lens(es) received on {received_day:%d-%m-%Y}{late} '
                                     f'with Purchase Entry {invoice.invoice_number}')
            refresh_statuses(po)
            po.save()
            billed.append(po)
        if plan['pending']:
            billed.append(_received_po_for_pending(order, invoice, plan['pending'], received_at))
    for po in billed:
        link_purchase_invoice(po, invoice)
    return billed

# ---------------------------------------------------------------------------
# Status roll-up and sales-order sync
# ---------------------------------------------------------------------------

def refresh_statuses(po):
    """Item statuses and the PO status from its pieces. DRAFT / CANCELLED are left alone."""
    total = received = 0
    for item in po.items.all():
        states = [p.receiving_status for p in item.pieces.all()]
        got = states.count('RECEIVED')
        item_status = 'RECEIVED' if states and got == len(states) else ('PARTIALLY_RECEIVED' if got else 'PENDING')
        if item.status != item_status:
            item.status = item_status
            item.save(update_fields=['status', 'updated_at'])
        total += len(states)
        received += got
    if po.status in ('DRAFT', 'CANCELLED'):
        return
    if total and received == total:
        po.status = 'RECEIVED'
    elif received:
        po.status = 'PARTIALLY_RECEIVED'
    elif po.status in ('PARTIALLY_RECEIVED', 'RECEIVED'):
        po.status = 'ORDERED'


def sync_sales_order(order, po):
    """Move one linked sales order's lab stage from its lens pieces: every lens it needs is in
    stock through a Purchase Entry -> Ready for Delivery; arrived -> Lens Arrived (ready for
    fitting); some -> Awaiting Remaining Lens; ordered at a lab -> In Lab Processing. Forward
    only, and never over a stage staff set past these."""
    order = Invoice.all_objects.prefetch_related('items').get(pk=order.pk)
    reqs = order_requirements(order)
    if not reqs:
        return
    pieces = list(live_pieces().filter(sales_order=order).select_related('item__order__purchase_invoice'))
    received = Counter((p.item.product_id, p.eye) for p in pieces if p.receiving_status == 'RECEIVED')
    received_by_eye = Counter(p.eye for p in pieces if p.receiving_status == 'RECEIVED')

    def covered(key, need):
        pid, eye = key
        return (received[key] if pid is not None else received_by_eye[eye]) >= need['count']

    all_in = all(covered(k, r) for k, r in reqs.items())
    any_in = any(p.receiving_status == 'RECEIVED' for p in pieces)
    stocked = all_in and all(po_stocked(p.item.order) for p in pieces if p.receiving_status == 'RECEIVED')
    target = (STAGE_READY if stocked else STAGE_ARRIVED if all_in else STAGE_WAITING if any_in
              else STAGE_LENS_ORDERED if pieces else None)

    fitting = 'READY_FOR_FITTING' if all_in else 'WAITING'
    LensPurchaseOrderPiece.objects.filter(pk__in=[p.pk for p in pieces if p.receiving_status == 'RECEIVED']) \
        .exclude(fitting_status=fitting).update(fitting_status=fitting)

    current = (order.fulfillment_status or '').strip()
    if target is None or current.lower() not in _EARLY_STAGE_RANK:
        return
    if _EARLY_STAGE_RANK[target.lower()] <= _EARLY_STAGE_RANK[current.lower()]:
        return
    # .update(): a stage label is not a sale edit — no save signals, no journal re-queue.
    Invoice.all_objects.filter(pk=order.pk).update(fulfillment_status=target, updated_at=timezone.now())
    _log(po, 'SALES_ORDER_STATUS', f"{order.invoice_number}: {current or '—'} → {target}")


def _sync_orders(po, order_ids=None):
    ids = order_ids if order_ids is not None else {
        p.sales_order_id for it in po.items.all() for p in it.pieces.all()}
    for order in Invoice.all_objects.filter(pk__in=ids):
        sync_sales_order(order, po)


# ---------------------------------------------------------------------------
# Purchase Entry link (called from PurchaseInvoiceViewSet.perform_create)
# ---------------------------------------------------------------------------

def lock_for_conversion(lens_po_id):
    """The Lens PO a new Purchase Entry is being converted from, row-locked; raises when it
    can't be converted (cancelled, nothing received, or already billed)."""
    po = LensPurchaseOrder.objects.select_for_update().filter(pk=lens_po_id).first()
    if po is None:
        raise serializers.ValidationError({'lens_purchase_order': ['Lens purchase order not found.']})
    if po.status in ('DRAFT', 'CANCELLED'):
        raise serializers.ValidationError({'lens_purchase_order': [f'Lens PO {po.po_number} is {po.get_status_display()}.']})
    inv = po.purchase_invoice
    if inv is not None and not inv.is_deleted and inv.status != 'CANCELLED':
        raise serializers.ValidationError({'lens_purchase_order': [
            f'Lens PO {po.po_number} is already billed on Purchase Entry {inv.invoice_number} — edit that entry instead.']})
    if not LensPurchaseOrderPiece.objects.filter(item__order=po, receiving_status='RECEIVED').exists():
        raise serializers.ValidationError({'lens_purchase_order': [
            f'Receive at least one lens on {po.po_number} before converting it to a purchase invoice.']})
    return po


def link_purchase_invoice(po, invoice):
    po.purchase_invoice = invoice
    _log(po, 'CONVERTED', f'Purchase Entry {invoice.invoice_number} ({invoice.status})')
    po.save(update_fields=['purchase_invoice', 'history', 'updated_at'])
    # The lenses are in stock now: their customer orders become Ready for Delivery.
    if po_stocked(po):
        _sync_orders(po)
        po.save(update_fields=['history'])


# ---------------------------------------------------------------------------
# Sales > Orders > Lenses queue and reserved stock
# ---------------------------------------------------------------------------

def _order_delivered(order):
    return bool(order.delivered_at) or (order.fulfillment_status or '').strip().lower().startswith('delivered')


def order_queue_row(order, pieces):
    """One customer order for the Lenses queue: each lens requirement with what has been
    ordered / received / stocked for it, and the order's overall queue status."""
    lenses, pos = [], {}
    totals = Counter()
    for (pid, eye), req in order_requirements(order).items():
        mine = [p for p in pieces if p.eye == eye and (pid is None or p.item.product_id == pid)]
        got = [p for p in mine if p.receiving_status == 'RECEIVED']
        in_stock = [p for p in got if po_stocked(p.item.order)]
        item = req['item']
        need = req['count']
        row = {
            'sales_order_item': str(item.pk), 'product': str(pid) if pid else None,
            'product_name': item.product.name if item.product else (item.description or 'Lens'),
            'description': item.description or '', 'selling_unit': item.selling_unit or PAIR,
            'lens_index': req['lens_index'], 'eye': eye, 'eye_label': EYE_LABEL[eye],
            'rx': req['rx'], 'rx_summary': rx_summary(req['rx']), 'required': need,
            'ordered': min(need, len(mine)), 'received': min(need, len(got)), 'stocked': min(need, len(in_stock)),
            'stock_available': float(item.product.stock or 0) if item.product else None,
            'pos': sorted({p.item.order.po_number for p in mine}),
        }
        for key in ('required', 'ordered', 'received', 'stocked'):
            totals[key] += row[key]
        lenses.append(row)
        for p in mine:
            po = p.item.order
            inv = po.purchase_invoice if po_stocked(po) else None
            pos[po.pk] = {'id': str(po.pk), 'po_number': po.po_number, 'status': po.status,
                          'status_label': po.get_status_display(),
                          'supplier_name': po.supplier.name if po.supplier_id else '',
                          'purchase_invoice': str(inv.pk) if inv else None,
                          'purchase_invoice_number': inv.invoice_number if inv else ''}

    if _order_delivered(order):
        code = 'DELIVERED'
    elif totals['ordered'] < totals['required']:
        # Nothing ordered yet and the lenses are already on the shelf: sold from stock.
        code = 'IN_STOCK' if not totals['ordered'] and _covered_by_stock(order, lenses) else 'PENDING_PURCHASE'
    elif not totals['received']:
        code = 'PURCHASE_PLACED'
    elif totals['received'] < totals['required']:
        code = 'PARTIALLY_RECEIVED'
    elif totals['stocked'] < totals['required']:
        code = 'RECEIVED_NOT_STOCKED'
    else:
        code = 'READY'
    customer = order.customer
    return {
        'id': str(order.pk), 'invoice_number': order.invoice_number, 'document_type': order.document_type,
        'invoice_date': order.invoice_date, 'fulfillment_status': order.fulfillment_status or '',
        'payment_status': order.status, 'net_amount': str(order.net_amount or 0),
        'paid_amount': str(order.paid_amount or 0),
        'customer': str(order.customer_id) if order.customer_id else None,
        'customer_name': order.customer_name or (customer.name if customer else ''),
        'customer_phone': customer.phone if customer else '',
        'patient_code': customer.patient_code if customer else '',
        'test_no': getattr(order, 'test_no', '') or '',
        'queue_status': code, 'queue_status_label': QUEUE_STATUSES[code],
        'billed': (order.document_type or '').upper() == 'INVOICE',
        'lenses': lenses, 'purchase_orders': list(pos.values()), 'totals': dict(totals),
    }


def _covered_by_stock(order, lenses):
    if not lenses or any(not r['product'] or r['stock_available'] is None for r in lenses):
        return False
    need = Counter()
    for r in lenses:
        need[r['product']] += r['required']
    stock = {r['product']: r['stock_available'] for r in lenses}
    products = {str(it.product_id): it.product for it in order.items.all() if it.product_id}
    return all(stock[pid] >= stock_units(products.get(pid), n) for pid, n in need.items())


def reserved_stock(exclude_order=None):
    """Lenses in stock (received and brought in by a Purchase Entry) for customer orders not yet
    billed: those units belong to that customer, not the shelf. Billing the order (Order ->
    Invoice) deducts them as usual, which ends the reservation."""
    pieces = live_pieces().filter(
        receiving_status='RECEIVED', sales_order__document_type__iexact='ORDER',
        sales_order__is_deleted=False, sales_order__delivered_at__isnull=True,
    ).exclude(sales_order__status__iexact='CANCELLED').exclude(
        sales_order__fulfillment_status__istartswith='delivered',
    ).select_related('item__product', 'item__order__purchase_invoice', 'sales_order')
    if exclude_order:
        pieces = pieces.exclude(sales_order_id=exclude_order)
    groups = {}
    for p in pieces:
        if not po_stocked(p.item.order):
            continue
        g = groups.setdefault((p.item.product_id, p.sales_order_id),
                              {'product': p.item.product, 'order': p.sales_order, 'pieces': 0})
        g['pieces'] += 1
    return [{
        'product': str(g['product'].pk), 'product_name': g['product'].name, 'pieces': g['pieces'],
        'units': stock_units(g['product'], g['pieces']), 'sales_order': str(g['order'].pk),
        'sales_order_number': g['order'].invoice_number,
        'customer': str(g['order'].customer_id) if g['order'].customer_id else None,
        'customer_name': g['order'].customer_name or '',
    } for g in groups.values()]


def invoice_draft_lines(po):
    """Purchase Entry lines for the lenses received so far, in each product's stock unit
    (Product.extra_data['lens_stock_unit']: PAIR unless PIECE — the same rule a sale deducts by).

    A pair-stocked product is brought in the way its sales will take it out: lens_units rounds a
    bill's single lenses UP to whole pairs, so each customer order's lenses are rounded up here
    too. A split pair therefore comes in as 2 stock units — one per customer — at the PO's total
    cost; bringing it in as 1 pair would leave the second customer's sale short (or blocked by
    the negative-stock guard). Staff can still adjust the quantity on the entry."""
    by_product = {}
    for item in po.items.select_related('product'):
        got = [p for p in item.pieces.all() if p.receiving_status == 'RECEIVED']
        if not got:
            continue
        per_piece = _money(item.unit_price) / PIECES_PER_UNIT.get(item.pricing_unit, 2)
        row = by_product.setdefault(item.product_id, {'product': item.product, 'pieces': 0, 'cost': Decimal('0'),
                                                       'tax': item.tax_percent, 'discount': Decimal('0'),
                                                       'by_order': Counter()})
        row['pieces'] += len(got)
        row['cost'] += per_piece * len(got)
        row['discount'] += _money(item.discount_amount) * len(got) / max(1, item.physical_quantity)
        row['by_order'].update(p.sales_order_id for p in got)
    lines = []
    for row in by_product.values():
        product = row['product']
        stock_unit = PIECE if str((product.extra_data or {}).get('lens_stock_unit') or '').upper() == PIECE else PAIR
        qty = row['pieces'] if stock_unit == PIECE else sum(math.ceil(n / 2) for n in row['by_order'].values())
        rate = _money(row['cost'] / qty)
        gross = rate * qty
        orders = len(row['by_order'])
        if stock_unit == PIECE:
            note = f"{row['pieces']} lens(es) received → {qty} piece(s)"
        else:
            note = (f"{row['pieces']} lens(es) for {orders} customer order(s) → {qty} pair unit(s)"
                    + (' — each order takes a whole pair from stock when sold' if qty * 2 > row['pieces'] else ''))
        lines.append({
            'product': str(product.pk), 'product_name': product.name, 'quantity': qty, 'stock_unit': stock_unit,
            'pieces': row['pieces'], 'purchase_rate': str(rate), 'gst_percent': str(row['tax'] or 0),
            'discount_percent': str(_money(row['discount'] / gross * 100) if gross else Decimal('0')),
            'note': note,
        })
    return lines


# ---------------------------------------------------------------------------
# ViewSet
# ---------------------------------------------------------------------------

class LensPurchaseOrderViewSet(BranchScopedViewSetMixin, viewsets.ModelViewSet):
    serializer_class = LensPurchaseOrderSerializer
    # Same access model as the other purchasing endpoints (see SupplierViewSet).
    authentication_classes = []
    permission_classes = [permissions.AllowAny]
    queryset = LensPurchaseOrder.objects.all()
    # The dashboard counts and filters every PO client-side; the global PAGE_SIZE would cut it off.
    pagination_class = None

    def get_queryset(self):
        pieces = LensPurchaseOrderPiece.objects.select_related('sales_order', 'customer')
        qs = super().get_queryset().select_related('supplier', 'purchase_invoice').prefetch_related(
            Prefetch('items', queryset=LensPurchaseOrderItem.objects.select_related('product')
                     .prefetch_related(Prefetch('pieces', queryset=pieces))))
        p = self.request.query_params
        if p.get('status'):
            qs = qs.filter(status__in=p['status'].split(','))
        if p.get('supplier'):
            qs = qs.filter(supplier_id=p['supplier'])
        if p.get('date_from'):
            qs = qs.filter(order_date__gte=p['date_from'])
        if p.get('date_to'):
            qs = qs.filter(order_date__lte=p['date_to'])
        if p.get('sales_order'):
            qs = qs.filter(items__pieces__sales_order_id=p['sales_order'])
        if p.get('search'):
            s = p['search'].strip()
            qs = qs.filter(Q(po_number__icontains=s) | Q(supplier__name__icontains=s)
                           | Q(items__pieces__customer_name__icontains=s)
                           | Q(items__pieces__sales_order__invoice_number__icontains=s)
                           | Q(items__lens_model__icontains=s))
        return qs.distinct()

    def _po_number(self, serializer):
        return next_po_number(serializer.validated_data.get('po_number'))

    @transaction.atomic
    def perform_create(self, serializer):
        extra = self._branch_stamp_kwargs(serializer)
        po = serializer.save(po_number=self._po_number(serializer), created_by_name=get_actor() or '', **extra)
        if po.status != 'DRAFT':
            _log(po, 'SUBMITTED', f'Status {po.get_status_display()}')
            _sync_orders(po)
            po.save(update_fields=['history'])

    @transaction.atomic
    def perform_update(self, serializer):
        LensPurchaseOrder.objects.select_for_update().filter(pk=serializer.instance.pk).first()
        po = serializer.save()
        if po.status != 'DRAFT':
            _sync_orders(po)
            po.save(update_fields=['history'])

    def destroy(self, request, *args, **kwargs):
        po = self.get_object()
        if po.status != 'DRAFT':
            return Response({'detail': 'Only a draft can be deleted — cancel a submitted PO instead.'},
                            status=status.HTTP_400_BAD_REQUEST)
        return super().destroy(request, *args, **kwargs)

    def _locked(self):
        po = self.get_object()
        return LensPurchaseOrder.objects.select_for_update().get(pk=po.pk)

    def _respond(self, po):
        return Response(self.get_serializer(self.get_queryset().get(pk=po.pk)).data)

    @action(detail=True, methods=['post'])
    @transaction.atomic
    def submit(self, request, pk=None):
        po = self._locked()
        if po.status != 'DRAFT':
            return Response({'detail': f'This PO is already {po.get_status_display()}.'}, status=status.HTTP_400_BAD_REQUEST)
        if not po.items.exists():
            return Response({'detail': 'Add at least one lens before submitting the order.'}, status=status.HTTP_400_BAD_REQUEST)
        # Re-check the requirements: an order may have been cancelled / ordered elsewhere since.
        payload = LensPurchaseOrderSerializer(po).data['items']
        check = LensPurchaseOrderSerializer(po, data={'items': payload}, partial=True)
        check.is_valid(raise_exception=True)
        po.status = 'PENDING'
        _log(po, 'SUBMITTED', 'Status Pending')
        _sync_orders(po)
        po.save()
        return self._respond(po)

    @action(detail=True, methods=['post'], url_path='mark-ordered')
    @transaction.atomic
    def mark_ordered(self, request, pk=None):
        po = self._locked()
        if po.status not in ('DRAFT', 'PENDING'):
            return Response({'detail': f'This PO is already {po.get_status_display()}.'}, status=status.HTTP_400_BAD_REQUEST)
        if po.status == 'DRAFT':
            return Response({'detail': 'Submit the draft first.'}, status=status.HTTP_400_BAD_REQUEST)
        po.status = 'ORDERED'
        _log(po, 'ORDERED', 'Sent to the lab')
        po.save()
        return self._respond(po)

    @action(detail=True, methods=['post'])
    @transaction.atomic
    def cancel(self, request, pk=None):
        po = self._locked()
        if po.status == 'CANCELLED':
            return Response({'detail': 'This PO is already cancelled.'}, status=status.HTTP_400_BAD_REQUEST)
        if LensPurchaseOrderPiece.objects.filter(item__order=po, receiving_status='RECEIVED').exists():
            return Response({'detail': 'Lenses on this PO have been received — it can no longer be cancelled.'},
                            status=status.HTTP_400_BAD_REQUEST)
        inv = po.purchase_invoice
        if inv is not None and not inv.is_deleted and inv.status != 'CANCELLED':
            return Response({'detail': f'This PO is billed on Purchase Entry {inv.invoice_number}.'},
                            status=status.HTTP_400_BAD_REQUEST)
        reason = str(request.data.get('reason') or '').strip()
        previous = po.get_status_display()
        po.status = 'CANCELLED'
        LensPurchaseOrderItem.objects.filter(order=po).update(status='CANCELLED')
        _log(po, 'CANCELLED', f'From {previous}' + (f': {reason}' if reason else ''))
        po.save()
        return self._respond(po)

    @action(detail=True, methods=['post'])
    @transaction.atomic
    def receive(self, request, pk=None):
        """Verify lenses one by one: {pieces: [{id, status: RECEIVED|DAMAGED|MISSING|INCORRECT,
        piece_reference?, notes?}]}. A piece already received can't be received again."""
        po = self._locked()
        if po.status not in ('PENDING', 'ORDERED', 'PARTIALLY_RECEIVED'):
            return Response({'detail': f'A {po.get_status_display()} PO cannot receive lenses.'},
                            status=status.HTTP_400_BAD_REQUEST)
        rows = request.data.get('pieces') if isinstance(request.data.get('pieces'), list) else []
        if not rows:
            return Response({'detail': 'Select at least one lens to receive.'}, status=status.HTTP_400_BAD_REQUEST)
        pieces = {str(p.pk): p for p in LensPurchaseOrderPiece.objects.select_for_update()
                  .filter(item__order=po).select_related('sales_order', 'item')}
        # The actual date the lenses arrived (may differ from the PO's expected delivery date).
        now = received_at_for(request.data.get('received_date'))
        errors, touched, touched_orders, actor = [], [], set(), get_actor() or ''
        for row in rows:
            piece = pieces.get(str(row.get('id')))
            state = str(row.get('status') or '').upper()
            if piece is None:
                errors.append('A lens in the request does not belong to this PO.')
                continue
            label = f'Piece {piece.piece_number} ({piece.sales_order.invoice_number} {EYE_LABEL.get(piece.eye, piece.eye)})'
            if state not in RECEIVING_STATES:
                errors.append(f'{label}: choose Received, Damaged, Missing or Incorrect.')
                continue
            if piece.receiving_status == 'RECEIVED':
                errors.append(f'{label} has already been received on {piece.received_at:%d-%m-%Y} by {piece.received_by or "staff"}.')
                continue
            notes = str(row.get('notes') or '').strip()[:255]
            if state in DISCREPANCY and not notes:
                errors.append(f'{label}: describe the {state.lower()} lens in the discrepancy note.')
                continue
            ref = str(row.get('piece_reference') or '').strip()[:100]
            if ref:
                piece.piece_reference = ref
            piece.receiving_status = state
            piece.discrepancy_notes = notes
            piece.received_by = actor
            piece.received_at = now if state == 'RECEIVED' else None
            touched.append(piece)
            if state == 'RECEIVED':
                touched_orders.add(piece.sales_order_id)
            _log(po, 'RECEIVED' if state == 'RECEIVED' else 'DISCREPANCY',
                 f"{label}: {state}" + (f' — {notes}' if notes else '') + (f' [ref {ref}]' if ref else ''))
        if errors:
            transaction.set_rollback(True)
            return Response({'detail': ' '.join(errors), 'errors': errors}, status=status.HTTP_400_BAD_REQUEST)
        LensPurchaseOrderPiece.objects.bulk_update(
            touched,
            ['receiving_status', 'discrepancy_notes', 'received_by', 'received_at', 'piece_reference'])
        refresh_statuses(po)
        _sync_orders(po, touched_orders)
        po.save()
        return self._respond(po)

    @action(detail=True, methods=['get'], url_path='invoice-draft')
    def invoice_draft(self, request, pk=None):
        po = self.get_object()
        inv = po.purchase_invoice
        if inv is not None and not inv.is_deleted and inv.status != 'CANCELLED':
            return Response({'existing': {'id': str(inv.pk), 'invoice_number': inv.invoice_number, 'status': inv.status}})
        if po.status in ('DRAFT', 'CANCELLED'):
            return Response({'detail': f'A {po.get_status_display()} PO cannot be converted.'}, status=status.HTTP_400_BAD_REQUEST)
        lines = invoice_draft_lines(po)
        if not lines:
            return Response({'detail': 'Receive at least one lens before converting to a purchase invoice.'},
                            status=status.HTTP_400_BAD_REQUEST)
        total = sum(1 for it in po.items.all() for _ in it.pieces.all())
        received = sum(l['pieces'] for l in lines)
        return Response({'existing': None, 'id': str(po.pk), 'po_number': po.po_number, 'supplier': str(po.supplier_id),
                         'branch': str(po.branch_id) if po.branch_id else None, 'lines': lines,
                         'pieces_total': total, 'pieces_received': received})

    @action(detail=False, methods=['get'], url_path='sales-queue')
    def sales_queue(self, request):
        """Sales > Orders > Lenses: customer orders with lens lines, plus invoices whose lenses were
        bought on a lens PO (an order billed in place) until they are handed over.
        ?customer= ?search= ?status=CODE,CODE ?include_delivered=1"""
        p = request.query_params
        lens_q = Q(items__selling_unit__in=(PAIR, PIECE)) | Q(items__item_type__iexact='LENS')
        ordered_ids = live_pieces().values('sales_order_id')
        orders = Invoice.objects.exclude(status__iexact='CANCELLED').filter(lens_q).filter(
            Q(document_type__iexact='ORDER') | Q(document_type__iexact='INVOICE', pk__in=ordered_ids))
        if not p.get('include_delivered'):
            orders = orders.filter(delivered_at__isnull=True).exclude(fulfillment_status__istartswith='delivered')
        if getattr(request, 'multi_branch_enabled', False):
            active = get_active_branch(request)
            if active is not None:
                orders = orders.filter(branch_id=active.id)
        if p.get('customer'):
            orders = orders.filter(customer_id=p['customer'])
        if p.get('search'):
            s = p['search'].strip()
            orders = orders.filter(Q(invoice_number__icontains=s) | Q(customer_name__icontains=s)
                                   | Q(customer__name__icontains=s) | Q(customer__patient_code__icontains=s)
                                   | Q(customer__phone__icontains=s)
                                   | Q(pk__in=live_pieces().filter(item__order__po_number__icontains=s)
                                       .values('sales_order_id')))
        orders = list(orders.distinct().select_related('customer').prefetch_related('items__product')
                      .order_by('-invoice_date', '-created_at')[:300])
        by_order = {}
        for piece in live_pieces().filter(sales_order_id__in=[o.pk for o in orders]).select_related(
                'item__product', 'item__order__purchase_invoice', 'item__order__supplier'):
            by_order.setdefault(piece.sales_order_id, []).append(piece)
        rows = [order_queue_row(o, by_order.get(o.pk, [])) for o in orders]
        wanted = {c.strip().upper() for c in (p.get('status') or '').split(',') if c.strip()}
        if wanted:
            rows = [r for r in rows if r['queue_status'] in wanted]
        return Response(rows)

    @action(detail=False, methods=['get'], url_path='reserved-stock')
    def reserved_stock_view(self, request):
        """?exclude_order= leaves out the order being billed (its own lenses aren't held from it)."""
        return Response(reserved_stock(exclude_order=request.query_params.get('exclude_order') or None))

    @action(detail=False, methods=['get'], url_path='order-draft')
    def order_draft(self, request):
        """Purchase Entry -> Search Order Number: ?sales_order=<id> [&supplier=<id>] -> the order's
        lenses still waiting (not ordered yet, or on an unbilled Lens PO of that supplier) as entry
        lines, plus why any lens was left out and the expected delivery date of the placed POs."""
        p = request.query_params
        order = Invoice.objects.select_related('customer').prefetch_related('items__product') \
            .filter(pk=p.get('sales_order')).first() if p.get('sales_order') else None
        if order is None:
            return Response({'detail': 'Customer order not found.'}, status=status.HTTP_404_NOT_FOUND)
        blocker = _order_blocker(order)
        if blocker:
            return Response({'detail': f'Order {order.invoice_number} {blocker}.'}, status=status.HTTP_400_BAD_REQUEST)
        plan = order_plan(order, p.get('supplier') or None)
        lines = order_draft_lines(plan)
        customer = order.customer
        expected = sorted(g['po'].expected_delivery_date for g in plan['placed'].values() if g['po'].expected_delivery_date)
        supplier = Supplier.all_objects.filter(pk=plan['supplier']).first() if plan['supplier'] else None
        return Response({
            'sales_order': str(order.pk), 'sales_order_number': order.invoice_number,
            'document_type': order.document_type, 'order_date': order.invoice_date,
            'customer_name': order.customer_name or (customer.name if customer else ''),
            'patient_code': customer.patient_code if customer else '',
            'supplier': plan['supplier'], 'supplier_name': supplier.name if supplier else '',
            'lines': lines, 'skipped': plan['skipped'],
            'purchase_orders': [{'id': str(g['po'].pk), 'po_number': g['po'].po_number, 'status': g['po'].status,
                                 'order_date': g['po'].order_date, 'expected_delivery_date': g['po'].expected_delivery_date}
                                for g in plan['placed'].values()],
            'expected_delivery_date': expected[-1] if expected else None,
        })

    @action(detail=False, methods=['get'], url_path='pending-requirements')
    def pending_requirements(self, request):
        """Sales-order lenses still to be ordered: one row per (order, lens line, eye)."""
        p = request.query_params
        orders = Invoice.objects.exclude(document_type__iexact='QUOTATION').exclude(status__iexact='CANCELLED') \
            .filter(Q(items__selling_unit__in=(PAIR, PIECE)) | Q(items__item_type__iexact='LENS'), delivered_at__isnull=True) \
            .exclude(fulfillment_status__istartswith='delivered').select_related('customer').distinct()
        if getattr(request, 'multi_branch_enabled', False):
            active = get_active_branch(request)
            if active is not None:
                orders = orders.filter(branch_id=active.id)
        if p.get('search'):
            s = p['search'].strip()
            orders = orders.filter(Q(invoice_number__icontains=s) | Q(customer_name__icontains=s)
                                   | Q(customer__name__icontains=s) | Q(customer__patient_code__icontains=s)
                                   | Q(customer__phone__icontains=s))
        if p.get('sales_order'):
            orders = orders.filter(pk=p['sales_order'])
        orders = list(orders.order_by('-invoice_date', '-created_at').prefetch_related('items__product')[:150])
        exclude_po = LensPurchaseOrder.objects.filter(pk=p['exclude_po']).first() if p.get('exclude_po') else None
        claimed = _claims([o.pk for o in orders], exclude_po=exclude_po)
        product_filter = p.get('product')
        rows = []
        for order in orders:
            for (pid, eye), req in order_requirements(order).items():
                if product_filter and pid is not None and str(pid) != product_filter:
                    continue
                taken = claimed.get((order.pk, pid, eye), 0) if pid is not None else sum(
                    c for (o, _pid, e), c in claimed.items() if o == order.pk and e == eye)
                outstanding = req['count'] - taken
                if outstanding <= 0 and not p.get('include_ordered'):
                    continue
                item = req['item']
                rows.append({
                    'sales_order': str(order.pk), 'sales_order_number': order.invoice_number,
                    'document_type': order.document_type, 'order_date': order.invoice_date,
                    'order_status': order.fulfillment_status or '', 'payment_status': order.status,
                    'customer': str(order.customer_id) if order.customer_id else None,
                    'customer_name': order.customer_name or (order.customer.name if order.customer else ''),
                    'patient_code': order.customer.patient_code if order.customer else '',
                    'sales_order_item': str(item.pk), 'product': str(pid) if pid else None,
                    'product_name': item.product.name if item.product else (item.description or 'Lens'),
                    'description': item.description or '', 'selling_unit': item.selling_unit or PAIR,
                    'lens_index': req['lens_index'], 'eye': eye, 'eye_label': EYE_LABEL[eye],
                    'lens_type': req.get('lens_type', ''), 'lens_coating': req.get('lens_coating', ''),
                    'rx': req['rx'], 'rx_summary': rx_summary(req['rx']),
                    'required': req['count'], 'outstanding': max(0, outstanding),
                })
        return Response(rows)
