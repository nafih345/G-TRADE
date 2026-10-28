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

A "lens requirement" is one eye of one lens line on a sales Order / Invoice: a PAIR line needs
RE + LE, a PIECE line its own eye, times the line quantity. New Sale edits recreate an order's
lines, so a requirement is identified by (sales order, product, eye), never by the line's id.
Every piece on a live (not cancelled) PO holds its requirement — discrepancy pieces included,
since the lab's replacement is received against the same piece — so it can't be ordered twice.

Nothing here moves stock or posts accounting. Goods come in when the PO is converted into an
ordinary Purchase Entry: PurchaseInvoiceViewSet.perform_create calls link_purchase_invoice, in
the same transaction that applies the entry's stock and payables, and the one-to-one
LensPurchaseOrder.purchase_invoice makes a second conversion impossible.
"""
import math
from collections import Counter
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
STAGE_LENS_ORDERED = 'In Lab Processing'
STAGE_WAITING = 'Awaiting Remaining Lens'
STAGE_ARRIVED = 'Lens Arrived'
_EARLY_STAGE_RANK = {'': 0, 'order received': 0, 'in lab processing': 1,
                     'awaiting remaining lens': 2, 'lens arrived': 3}

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
                         'rx': rx if any(rx.values()) else _exam_rx(order.customer_id, eye)}
    return reqs


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
    """Move one linked sales order's lab stage from its lens pieces: every lens it needs has
    arrived -> Lens Arrived (ready for fitting); some -> Awaiting Remaining Lens; ordered at a
    lab -> In Lab Processing. Forward only, and never over a stage staff set past these."""
    order = Invoice.all_objects.prefetch_related('items').get(pk=order.pk)
    reqs = order_requirements(order)
    if not reqs:
        return
    pieces = list(live_pieces().filter(sales_order=order).select_related('item'))
    received = Counter((p.item.product_id, p.eye) for p in pieces if p.receiving_status == 'RECEIVED')
    received_by_eye = Counter(p.eye for p in pieces if p.receiving_status == 'RECEIVED')

    def covered(key, need):
        pid, eye = key
        return (received[key] if pid is not None else received_by_eye[eye]) >= need['count']

    all_in = all(covered(k, r) for k, r in reqs.items())
    any_in = any(p.receiving_status == 'RECEIVED' for p in pieces)
    target = STAGE_ARRIVED if all_in else STAGE_WAITING if any_in else STAGE_LENS_ORDERED if pieces else None

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
        from .views import _sequence_number
        number = _sequence_number('LENS_PO', LensPurchaseOrder, 'po_number', serializer.validated_data.get('po_number'))
        if number:
            return number
        given = (serializer.validated_data.get('po_number') or '').strip()
        if given and not LensPurchaseOrder.all_objects.filter(po_number=given).exists():
            return given
        year = timezone.localdate().year
        n = LensPurchaseOrder.all_objects.filter(po_number__startswith=f'LPO-{year}-').count() + 1
        while LensPurchaseOrder.all_objects.filter(po_number=f'LPO-{year}-{n:04d}').exists():
            n += 1
        return f'LPO-{year}-{n:04d}'

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
        errors, touched, touched_orders, now, actor = [], [], set(), timezone.now(), get_actor() or ''
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
                    'rx': req['rx'], 'rx_summary': rx_summary(req['rx']),
                    'required': req['count'], 'outstanding': max(0, outstanding),
                })
        return Response(rows)
