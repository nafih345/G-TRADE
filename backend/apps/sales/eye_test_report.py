"""Eye Test Report (Patient History → Eye Test Report): one visit's billing references, server-side
so the printed report names the real bills, not whatever this browser has cached.

A bill belongs to the visit when it carries the visit's eye test fee (fee_invoice, or an
EYE_TEST_FEE line pointing at the exam), was dispensed against its Test No (New Sale's Test No),
or has a lens line whose prescription came from that Test No — the same links the Sales Report
uses (sales_report._link_of), read the other way round.
"""
from decimal import Decimal

from django.db.models import Prefetch, Q

from .eye_test_fees import EYE_TEST_FEE_KIND
from .models import Invoice, InvoiceItem
from .sales_report import _RX_SOURCE_TEST_NO, _clean, _money

LINK_LABELS = {
    'eye_test_fee': 'Eye test fee',
    'test_no': 'Dispensed against this test',
    'lens_rx': 'Lens Rx from this test',
}


def eye_test_receipt_no(test_no):
    """The receipt (and ledger voucher source) number of a fee paid at the test."""
    return f'EYE-{test_no}' if test_no else ''


def _link_reasons(inv, exam, test_no):
    reasons = []
    exam_id = str(exam.id)
    fee_line = any(
        isinstance(it.service_details, dict)
        and it.service_details.get('kind') == EYE_TEST_FEE_KIND
        and str(it.service_details.get('eye_examination_id') or '') == exam_id
        for it in inv.items.all())
    if fee_line or (exam.fee_invoice_id and inv.id == exam.fee_invoice_id):
        reasons.append('eye_test_fee')
    if test_no and _clean(inv.test_no) == test_no:
        reasons.append('test_no')
    if test_no:
        for it in inv.items.all():
            details = it.lens_details if isinstance(it.lens_details, dict) else {}
            match = _RX_SOURCE_TEST_NO.search(str(details.get('rx_source') or ''))
            if match and match.group(1) == test_no:
                reasons.append('lens_rx')
                break
    return reasons


def linked_invoices(exam):
    test_no = _clean(exam.test_no)
    cond = Q(items__service_details__eye_examination_id=str(exam.id))
    if exam.fee_invoice_id:
        cond |= Q(id=exam.fee_invoice_id)
    if test_no:
        # icontains is only a coarse pre-filter ("100" also matches "1001"); _link_reasons
        # confirms the exact Test No.
        cond |= Q(test_no=test_no) | Q(items__lens_details__rx_source__icontains=test_no)
    ids = Invoice.objects.filter(cond).values_list('id', flat=True).distinct()
    invoices = (Invoice.objects.filter(id__in=list(ids))
                .prefetch_related(Prefetch('items', queryset=InvoiceItem.objects.only(
                    'id', 'invoice_id', 'service_details', 'lens_details')))
                .order_by('invoice_date', 'created_at'))
    rows = []
    for inv in invoices:
        reasons = _link_reasons(inv, exam, test_no)
        if not reasons:
            continue
        net = Decimal(str(inv.net_amount or 0))
        paid = Decimal(str(inv.paid_amount or 0))
        rows.append({
            'id': str(inv.id),
            'invoice_number': inv.invoice_number or '',
            'document_type': inv.document_type or 'INVOICE',
            'invoice_date': inv.invoice_date.isoformat() if inv.invoice_date else '',
            'net_amount': _money(net),
            'paid_amount': _money(paid),
            'balance': _money(max(Decimal('0'), net - paid)),
            'status': inv.status or '',
            'links': reasons,
            'link_label': ' · '.join(LINK_LABELS[r] for r in reasons),
        })
    return rows


def build_billing_reference(exam):
    status = exam.fee_status or ''
    paid = Decimal(str(exam.fee_paid_amount or 0))
    fee_invoice = exam.fee_invoice if exam.fee_invoice_id else None
    return {
        'fee': {
            'status': status,
            'is_free_test': bool(exam.is_free_test),
            'procedure_charge': _money(exam.procedure_charge),
            'medicine_charge': _money(exam.medicine_charge),
            'medical_aid_charge': _money(exam.medical_aid_charge),
            'amount': _money(exam.fee_amount),
            'paid_amount': _money(paid),
            'payment_mode': exam.fee_payment_mode or '',
            # Only a fee actually taken at the test has a receipt (its ledger voucher number).
            'receipt_no': eye_test_receipt_no(exam.test_no) if status == 'PAID' and paid > 0 else '',
            'invoice_id': str(fee_invoice.id) if fee_invoice else None,
            'invoice_number': fee_invoice.invoice_number if fee_invoice else '',
            'invoice_date': fee_invoice.invoice_date.isoformat() if fee_invoice and fee_invoice.invoice_date else '',
        },
        'invoices': linked_invoices(exam),
    }
