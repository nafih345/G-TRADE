"""Sales Report (Reports → Sales & Revenue Hub → Sales Report): one row per retail document with
everything the counter needs on a single screen — customer profile, the eye test the sale was
dispensed against (and which visit of the patient's that was), frame / lens / service lines with
their codes and barcodes, the money breakdown, how it was paid and who served the customer.

Built in a fixed handful of queries whatever the row count (bills + lines + receipts + the
patients' exams), since every query is a cross-region round trip on the hosted setup.
"""
import re
from collections import defaultdict
from datetime import date
from decimal import Decimal

from django.db.models import Prefetch, Q
from django.utils import timezone

from .eye_test_fees import EYE_TEST_FEE_KIND
from .models import EyeExamination, InvoiceItem, Payment

_CENT = Decimal('0.01')
VOID_RECEIPT_STATUSES = ('CANCELLED', 'VOID', 'VOIDED', 'FAILED', 'REVERSED')
_RX_SOURCE_TEST_NO = re.compile(r'test\s*no\.?\s*[:#]?\s*([A-Za-z0-9-]+)', re.I)
_MODEL_KEYS = ('model_no', 'model_number', 'model', 'modelno')
_EXAM_FIELDS = (
    'id', 'customer_id', 'patient_id', 'patient_name', 'test_no', 'visit_number', 'examination_date',
    'optometrist', 'primary_diagnosis', 'distance_pd', 'near_pd',
    'sub_sph_od', 'sub_cyl_od', 'sub_axis_od', 'sub_add_od', 'sub_va_od',
    'sub_sph_os', 'sub_cyl_os', 'sub_axis_os', 'sub_add_os', 'sub_va_os',
)


def _money(value):
    return str(Decimal(str(value or 0)).quantize(_CENT))


def _parse_date(value):
    try:
        return date.fromisoformat(str(value or '').strip()[:10])
    except ValueError:
        return None


def _clean(value):
    return ' '.join(str(value or '').split())


def report_queryset(base_qs, params):
    """The bills in range, with their lines (+ product, category, brand, variant group), receipts
    (+ bank) and patient joined in. `base_qs` is the branch-scoped Invoice queryset."""
    qs =base_qs.select_related('customer', 'created_by').prefetch_related(
        Prefetch('items', queryset=InvoiceItem.objects.select_related(
            'product__category', 'product__brand', 'product__variant_group')),
        Prefetch('payments', queryset=Payment.objects.select_related('bank_account')),
    ).order_by('-invoice_date', '-created_at')
    start, end = _parse_date(params.get('date_from')), _parse_date(params.get('date_to'))
    if start:
        qs = qs.filter(invoice_date__gte=start)
    if end:
        qs = qs.filter(invoice_date__lte=end)
    doc_type = (params.get('document_type') or '').strip().upper()
    if doc_type and doc_type != 'ALL':
        qs = qs.filter(document_type=doc_type)
    return qs


# ---------------------------------------------------------------------------
# Eye test linkage
# ---------------------------------------------------------------------------

def _link_of(inv, items):
    """(test_no, exam_id, how) for the eye test this bill was dispensed against: the Test No saved
    on the bill, else the one a lens line's prescription came from, else a billed eye test fee."""
    if _clean(inv.test_no):
        return _clean(inv.test_no), None, 'bill'
    for it in items:
        details = it.lens_details if isinstance(it.lens_details, dict) else {}
        match = _RX_SOURCE_TEST_NO.search(str(details.get('rx_source') or ''))
        if match:
            return match.group(1), None, 'lens_rx'
    for it in items:
        details = it.service_details if isinstance(it.service_details, dict) else {}
        if details.get('kind') == EYE_TEST_FEE_KIND and details.get('eye_examination_id'):
            return None, str(details['eye_examination_id']), 'eye_test_fee'
    return None, None, ''


def _load_exams(invoices, links):
    customer_ids = {inv.customer_id for inv in invoices if inv.customer_id}
    codes = {inv.customer.patient_code for inv in invoices
             if inv.customer_id and inv.customer and inv.customer.patient_code}
    test_nos = {t for t, _, _ in links.values() if t}
    exam_ids = {e for _, e, _ in links.values() if e}
    if not (customer_ids or codes or test_nos or exam_ids):
        return []
    cond = Q()
    if customer_ids:
        cond |= Q(customer_id__in=customer_ids)
    if codes:
        cond |= Q(patient_id__in=codes)
    if test_nos:
        cond |= Q(test_no__in=test_nos)
    if exam_ids:
        cond |= Q(id__in=exam_ids)
    return list(EyeExamination.objects.filter(cond).only(*_EXAM_FIELDS))


def _exam_history(exams, invoices):
    """{patient key: [exams oldest first]} — an exam belongs to its Customer FK, or for older
    exams saved without one, to the customer whose patient code it carries."""
    code_to_customer = {inv.customer.patient_code: str(inv.customer_id) for inv in invoices
                        if inv.customer_id and inv.customer and inv.customer.patient_code}
    by_patient = defaultdict(list)
    key_of = {}
    for exam in exams:
        key = (str(exam.customer_id) if exam.customer_id else None) \
            or code_to_customer.get(exam.patient_id) or f'code:{exam.patient_id}'
        key_of[str(exam.id)] = key
        by_patient[key].append(exam)
    for rows in by_patient.values():
        rows.sort(key=lambda e: (e.examination_date or timezone.now(), str(e.test_no or '')))
    return by_patient, key_of


def _rx(exam, eye):
    return {k: _clean(getattr(exam, f'sub_{k}_{eye}', '')) for k in ('sph', 'cyl', 'axis', 'add', 'va')}


def _exam_payload(exam, history, how):
    ordinal = next((i for i, e in enumerate(history, 1) if e.id == exam.id), None)
    when = timezone.localtime(exam.examination_date) if exam.examination_date else None
    return {
        'id': str(exam.id),
        'test_no': exam.test_no or '',
        'linked_by': how,
        'date': when.date().isoformat() if when else '',
        'optometrist': exam.optometrist or '',
        'diagnosis': exam.primary_diagnosis or '',
        'visit_ordinal': ordinal,
        'visit_total': len(history),
        'is_first_test': ordinal == 1,
        'pd': _clean(exam.distance_pd),
        're': _rx(exam, 'od'),
        'le': _rx(exam, 'os'),
    }


# ---------------------------------------------------------------------------
# Lines
# ---------------------------------------------------------------------------

def _model_of(product):
    extra = product.extra_data if isinstance(product.extra_data, dict) else {}
    model = next((_clean(extra[k]) for k in _MODEL_KEYS if _clean(extra.get(k))), '')
    if not model and product.variant_group_id and product.variant_group:
        model = _clean(getattr(product.variant_group, 'model_number', ''))
    return model


def _line(it, kind):
    from .views import _item_display_name, _product_colour

    product = it.product if it.product_id else None
    qty = Decimal(str(it.quantity or 0))
    rate = Decimal(str(it.unit_price or 0))
    line = {
        'id': str(it.id),
        'kind': kind,
        'name': _item_display_name(it) or 'Item',
        'qty': str(it.quantity or 0),
        'selling_unit': it.selling_unit or '',
        'rate': _money(rate),
        'gross': _money(qty * rate),
        'tax_rate': str(it.tax_rate or 0),
        'tax': _money(it.tax_amount),
        'total': _money(it.subtotal),
        'power': it.power or '',
        'brand': '', 'model': '', 'code': '', 'barcode': '', 'color': '', 'size': '', 'category': '',
    }
    if product is not None:
        line.update({
            'brand': product.brand_name or (product.brand.name if product.brand_id and product.brand else ''),
            'model': _model_of(product),
            'code': product.sku or '',
            'barcode': product.barcode or product.secondary_barcode or '',
            'color': _product_colour(product),
            'size': product.size or '',
            'frame_type': product.frame_type or '',
            'category': (product.category.name if product.category_id and product.category else '')
            or product.category_name or '',
        })
    if kind == 'LENS':
        details = it.lens_details if isinstance(it.lens_details, dict) else {}
        specs = details.get('specs') if isinstance(details.get('specs'), dict) else {}
        line['lens'] = {
            'eye': it.lens_eye or '',
            'index': _clean(details.get('lens_index') or specs.get('index')),
            'design': _clean(specs.get('design')),
            'coating': _clean(specs.get('coating')),
            'rx': details.get('rx') if isinstance(details.get('rx'), dict) else None,
            'rx_source': _clean(details.get('rx_source')),
        }
    if kind == 'SERVICE' and isinstance(it.service_details, dict):
        d = it.service_details
        line['service'] = {k: _clean(d.get(k)) for k in
                           ('kind', 'technician', 'service_status', 'customer_item', 'problem_description')
                           if _clean(d.get(k))}
    return line


# ---------------------------------------------------------------------------
# Payment
# ---------------------------------------------------------------------------

def _payment(inv):
    from .views import BILLING_SOURCE, _pay_mode_key

    labels = {'cash': 'Cash', 'card': 'Card', 'upi': 'UPI', 'bank': 'Bank'}
    by_mode = defaultdict(Decimal)
    receipts = []
    for p in inv.payments.all():
        if (p.status or '').upper() in VOID_RECEIPT_STATUSES or not p.amount:
            continue
        mode = _pay_mode_key(p.method)
        by_mode[mode] += p.amount
        receipts.append({
            'receipt_no': p.receipt_no or '',
            'date': p.payment_date.isoformat() if p.payment_date else '',
            'method': p.method or labels[mode],
            'bank': p.bank_account.name if p.bank_account_id and p.bank_account else '',
            'amount': _money(p.amount),
            'at_billing': p.source == BILLING_SOURCE,
        })
    modes = [{'mode': labels[k], 'amount': _money(v)} for k, v in by_mode.items() if v > 0]
    if len(modes) > 1:
        label = 'Split'
    elif modes:
        label = modes[0]['mode']
    elif Decimal(str(inv.paid_amount or 0)) > 0:
        label = inv.payment_method or 'Cash'
    else:
        label = 'Unpaid' if inv.document_type == 'INVOICE' else '—'
    return {'mode': label, 'modes': modes, 'receipts': receipts}


# ---------------------------------------------------------------------------
# Rows
# ---------------------------------------------------------------------------

def build_sales_report(invoices):
    from .views import InvoiceSerializer
    from .models import derive_payment_status, is_real_customer_name

    invoices = list(invoices)
    items_of = {inv.pk: list(inv.items.all()) for inv in invoices}
    links = {inv.pk: _link_of(inv, items_of[inv.pk]) for inv in invoices}
    exams = _load_exams(invoices, links)
    by_patient, key_of = _exam_history(exams, invoices)
    exam_by_id = {str(e.id): e for e in exams}
    exam_by_test_no = {}
    for e in exams:
        if e.test_no:
            exam_by_test_no.setdefault(str(e.test_no), e)

    rows = []
    for inv in invoices:
        customer = inv.customer if inv.customer_id else None
        test_no, exam_id, how = links[inv.pk]
        exam = exam_by_id.get(exam_id) if exam_id else exam_by_test_no.get(test_no) if test_no else None
        history = []
        if customer is not None:
            history = by_patient.get(str(customer.pk)) or by_patient.get(f'code:{customer.patient_code}') or []
        exam_info = None
        if exam is not None:
            exam_info = _exam_payload(exam, by_patient.get(key_of.get(str(exam.id)), [exam]), how)
        latest = history[-1] if history else None

        lines = [_line(it, InvoiceSerializer._line_kind(it)) for it in items_of[inv.pk]]
        net = Decimal(str(inv.net_amount or 0))
        paid = Decimal(str(inv.paid_amount or 0))
        created = timezone.localtime(inv.created_at) if inv.created_at else None
        name = inv.customer_name if is_real_customer_name(inv.customer_name) else (customer.name if customer else '')
        rows.append({
            'id': str(inv.pk),
            'invoice_number': inv.invoice_number,
            'document_type': (inv.document_type or 'INVOICE').upper(),
            'invoice_date': inv.invoice_date.isoformat() if inv.invoice_date else '',
            # Full timestamp: the client shows the time in its own clock (the server runs on UTC).
            'created_at': created.isoformat() if created else '',
            'status': inv.status,
            'fulfillment_status': inv.fulfillment_status or '',
            'payment_status': derive_payment_status(net, paid),
            'customer': {
                'id': str(customer.pk) if customer else '',
                'name': name or '',
                'code': (customer.patient_code or '') if customer else '',
                'phone': (customer.phone or '') if customer else '',
                'email': (customer.email or '') if customer else '',
                'address': (customer.address or '') if customer else '',
                'place': (customer.place or '') if customer else '',
                'age': (customer.age or '') if customer else '',
                'gender': (customer.gender or '') if customer else '',
                'outstanding_balance': _money(customer.outstanding_balance) if customer else '0.00',
            },
            'test_no': test_no or (exam.test_no if exam else '') or '',
            'exam': exam_info,
            'exam_history': {
                'count': len(history),
                'latest_test_no': (latest.test_no or '') if latest else '',
                'latest_date': timezone.localtime(latest.examination_date).date().isoformat()
                if latest and latest.examination_date else '',
            },
            'lines': lines,
            'frame_count': sum(1 for l in lines if l['kind'] == 'FRAME'),
            'lens_count': sum(1 for l in lines if l['kind'] == 'LENS'),
            'totals': {
                'gross': _money(inv.total_amount),
                'discount': _money(inv.discount_amount),
                'tax': _money(inv.tax_amount),
                'net': _money(net),
                'paid': _money(paid),
                'balance': _money(max(net - paid, Decimal('0'))),
            },
            'payment': _payment(inv),
            'salesman': inv.salesman or '',
            'created_by': (inv.created_by.get_full_name() or inv.created_by.username)
            if inv.created_by_id and inv.created_by else '',
        })
    return rows
