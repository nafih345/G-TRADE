"""New Sale's Test No lookup: one day's (or range's) eye tests and whether each became a sale.

A test counts as sold when a live Invoice or Order (not a Quotation, not cancelled) was dispensed
against its Test No, carries a lens whose Rx came from it, or carries its eye test fee alongside
something else — the same links eye_test_report.linked_invoices reads for one visit, batched here
for a whole list. A bill holding only the fee is not a sale, but it still pins the test: the
fee line points at the exam, so such a test can't be discarded.
"""
from django.db.models import Prefetch, Q

from .eye_test_fees import EYE_TEST_FEE_KIND
from .models import Invoice, InvoiceItem
from .sales_report import _RX_SOURCE_TEST_NO, _clean, _money

SALE_DOC_TYPES = ('INVOICE', 'ORDER')
LOOKUP_LIMIT = 500


def _is_fee_line(item):
    return isinstance(item.service_details, dict) and item.service_details.get('kind') == EYE_TEST_FEE_KIND


def _doc_row(inv):
    return {
        'id': str(inv.id),
        'invoice_number': inv.invoice_number or '',
        'document_type': (inv.document_type or 'INVOICE').upper(),
        'invoice_date': inv.invoice_date.isoformat() if inv.invoice_date else '',
        'net_amount': _money(inv.net_amount),
        'status': inv.status or '',
    }


def bill_links(exams):
    """{exam id: {'sales': [...], 'quotations': [...], 'fee_only': [...]}} for the given exams."""
    exams = list(exams)
    out = {str(e.id): {'sales': [], 'quotations': [], 'fee_only': []} for e in exams}
    if not exams:
        return out
    by_tno = {}
    for e in exams:
        tno = _clean(e.test_no)
        if tno:
            by_tno.setdefault(tno, []).append(e)
    by_fee_invoice = {}
    for e in exams:
        if e.fee_invoice_id:
            by_fee_invoice.setdefault(e.fee_invoice_id, []).append(e)

    cond = Q(items__service_details__eye_examination_id__in=list(out))
    if by_fee_invoice:
        cond |= Q(id__in=list(by_fee_invoice))
    if by_tno:
        cond |= Q(test_no__in=list(by_tno))
        for tno in by_tno:
            # Coarse pre-filter ("100" also matches "1001"); the regex below confirms it.
            cond |= Q(items__lens_details__rx_source__icontains=tno)
    ids = Invoice.objects.filter(cond).exclude(status__iexact='CANCELLED').values_list('id', flat=True).distinct()
    invoices = (Invoice.objects.filter(id__in=list(ids))
                .prefetch_related(Prefetch('items', queryset=InvoiceItem.objects.only(
                    'id', 'invoice_id', 'service_details', 'lens_details')))
                .order_by('invoice_date', 'created_at'))

    for inv in invoices:
        items = list(inv.items.all())
        dispensed = set()  # exams this bill was dispensed against (Test No / lens Rx)
        for e in by_tno.get(_clean(inv.test_no), []):
            dispensed.add(str(e.id))
        for it in items:
            details = it.lens_details if isinstance(it.lens_details, dict) else {}
            match = _RX_SOURCE_TEST_NO.search(str(details.get('rx_source') or ''))
            if match:
                dispensed.update(str(e.id) for e in by_tno.get(match.group(1), []))
        fee_of = {str(it.service_details.get('eye_examination_id') or '') for it in items if _is_fee_line(it)}
        fee_of.update(str(e.id) for e in by_fee_invoice.get(inv.id, []))
        fee_of &= set(out)
        has_goods = any(not _is_fee_line(it) for it in items)

        row = _doc_row(inv)
        for exam_id in dispensed | fee_of:
            if row['document_type'] not in SALE_DOC_TYPES:
                out[exam_id]['quotations'].append(row)
            elif exam_id in dispensed or has_goods:
                out[exam_id]['sales'].append(row)
            else:
                out[exam_id]['fee_only'].append(row)
    return out


def lookup_rows(exams):
    exams = list(exams)
    links = bill_links(exams)
    rows = []
    for e in exams:
        link = links[str(e.id)]
        rows.append({
            'id': str(e.id),
            'test_no': e.test_no or '',
            'examination_date': e.examination_date.isoformat() if e.examination_date else '',
            'customer': str(e.customer_id) if e.customer_id else None,
            'patient_id': e.patient_id or '',
            'patient_code': (e.customer.patient_code if e.customer_id and e.customer else '') or e.patient_id or '',
            'patient_name': e.patient_name or '',
            'phone': e.phone or '',
            'age': e.age or '',
            'gender': e.gender or '',
            'fee_status': e.fee_status or '',
            'fee_amount': _money(e.fee_amount),
            'sale_status': 'SOLD' if link['sales'] else 'PENDING',
            'sales': link['sales'],
            'quotations': link['quotations'],
            'fee_only': link['fee_only'],
        })
    return rows


def discard_blockers(exam):
    """Why this test can't be discarded from New Sale's lookup ([] = it can)."""
    link = bill_links([exam])[str(exam.id)]
    reasons = []
    bills = link['sales'] + link['fee_only']
    if bills:
        reasons.append('it is linked to ' + ', '.join(
            f"{b['document_type'].title()} {b['invoice_number'] or '(no number)'}" for b in bills))
    if (exam.fee_status or '').upper() == 'PAID' and (exam.fee_paid_amount or 0) > 0:
        reasons.append(f'its eye test fee of ₹{_money(exam.fee_paid_amount)} was collected and is in the books')
    return reasons
