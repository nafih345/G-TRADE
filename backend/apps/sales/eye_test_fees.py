"""
Eye test fees: free / paid-at-test / deferred to the patient's frame & lens purchase.

The Eye Test screen sends the charges, the Free Test flag, the payment mode and the
"Pay during frame/lens purchase" toggle (`fee_deferred`); `derive_fee_fields` turns those
into the stored fee columns, so fee_status is never taken from the client.

A deferred fee is PENDING until a New Sale bill carries it as a SERVICE line whose
service_details are `{"kind": "EYE_TEST_FEE", "eye_examination_id": <exam uuid>, ...}`.
`sync_invoice_eye_test_fees` runs after every save of that bill's lines: it claims the fees
the bill carries (BILLED + fee_invoice) and releases ones it no longer carries back to
PENDING. A quotation never claims one (it is only an estimate); a cancelled or deleted bill
releases its fees. The frontend mirror is frontend/src/utils/eyeTestBill.js.
"""
from decimal import Decimal, InvalidOperation

from rest_framework import serializers

EYE_TEST_FEE_KIND = 'EYE_TEST_FEE'

FEE_FREE = 'FREE'
FEE_PAID = 'PAID'
FEE_PENDING = 'PENDING'
FEE_BILLED = 'BILLED'

PAY_CASH = 'CASH'
PAY_UPI = 'UPI'   # GPay
PAY_MODES = (PAY_CASH, PAY_UPI)

CHARGE_FIELDS = ('procedure_charge', 'medical_aid_charge', 'medicine_charge')
# Request keys that mean "this save is (re)stating the fee" — any other PATCH leaves it alone.
FEE_INPUT_KEYS = ('is_free_test', 'fee_deferred', 'fee_paid_amount', 'fee_payment_mode') + CHARGE_FIELDS
# Columns an edit may not touch once a bill carries the fee.
FEE_COLUMNS = CHARGE_FIELDS + ('is_free_test', 'fee_amount', 'fee_paid_amount', 'fee_payment_mode', 'fee_status')

_CENT = Decimal('0.01')


def _money(value):
    try:
        return max(Decimal('0'), Decimal(str(value or 0))).quantize(_CENT)
    except (InvalidOperation, ValueError, TypeError):
        return Decimal('0.00')


def fee_total(procedure, medical_aid, medicine):
    """What the patient owes: procedure + medicine, less what the medical aid covers."""
    return max(Decimal('0'), _money(procedure) + _money(medicine) - _money(medical_aid)).quantize(_CENT)


def derive_fee_fields(data, instance=None):
    """
    Fee columns for a create/update payload (validated_data, plus the write-only
    `fee_deferred`). Returns {} when the payload doesn't touch the fee, so unrelated PATCHes
    keep it. A fee already on a bill (BILLED) is frozen: the edit's fee inputs are dropped.
    """
    if not any(key in data for key in FEE_INPUT_KEYS):
        return {}
    if instance is not None and instance.fee_status == FEE_BILLED:
        return {key: getattr(instance, key) for key in FEE_COLUMNS}

    current = lambda key, default: data.get(key, getattr(instance, key, default) if instance else default)
    charges = {key: _money(current(key, 0)) for key in CHARGE_FIELDS}
    free = bool(current('is_free_test', False))
    deferred = bool(data.get('fee_deferred', instance is not None and instance.fee_status == FEE_PENDING))
    amount = Decimal('0.00') if free else fee_total(
        charges['procedure_charge'], charges['medical_aid_charge'], charges['medicine_charge'])

    if free:
        return {**{key: Decimal('0.00') for key in CHARGE_FIELDS}, 'is_free_test': True, 'fee_amount': amount,
                'fee_paid_amount': Decimal('0.00'), 'fee_payment_mode': '', 'fee_status': FEE_FREE}
    if deferred and amount > 0:
        return {**charges, 'is_free_test': False, 'fee_amount': amount,
                'fee_paid_amount': Decimal('0.00'), 'fee_payment_mode': '', 'fee_status': FEE_PENDING}

    mode = str(current('fee_payment_mode', '') or '').upper() or PAY_CASH
    if mode not in PAY_MODES:
        raise serializers.ValidationError({'fee_payment_mode': 'Payment mode must be Cash or GPay (UPI).'})
    return {**charges, 'is_free_test': False, 'fee_amount': amount,
            'fee_paid_amount': _money(current('fee_paid_amount', 0)),
            'fee_payment_mode': mode, 'fee_status': FEE_PAID}


def fee_exam_ids(items):
    """Exam ids of the eye-test-fee lines among `items` (InvoiceItem rows or raw dicts)."""
    ids = []
    for item in items:
        details = item.get('service_details') if isinstance(item, dict) else item.service_details
        if isinstance(details, dict) and details.get('kind') == EYE_TEST_FEE_KIND and details.get('eye_examination_id'):
            ids.append(str(details['eye_examination_id']))
    return ids


def sync_invoice_eye_test_fees(invoice, released=False):
    """
    Claim the eye test fees `invoice` carries and release the ones it no longer does.
    `released=True` (bill being deleted) releases all of them. Raises ValidationError — which
    rolls back the caller's atomic save — when a line points at a fee that isn't pending
    (already paid, free, or on another bill), so one fee can never be charged twice.
    """
    from .models import EyeExamination

    carries = not released and invoice.document_type != 'QUOTATION' and invoice.status != 'CANCELLED'
    wanted = set(fee_exam_ids(invoice.items.all())) if carries else set()

    EyeExamination.objects.filter(fee_invoice=invoice).exclude(pk__in=wanted) \
        .update(fee_status=FEE_PENDING, fee_invoice=None)
    if not wanted:
        return

    exams = {str(e.pk): e for e in EyeExamination.objects.select_for_update().filter(pk__in=wanted)}
    problems = []
    for exam_id in sorted(wanted):
        exam = exams.get(exam_id)
        if exam is None:
            problems.append('an eye test that no longer exists')
        elif exam.fee_status == FEE_BILLED and exam.fee_invoice_id != invoice.pk:
            bill = exam.fee_invoice.invoice_number if exam.fee_invoice else 'another bill'
            problems.append(f'Test No {exam.test_no} (already billed on {bill})')
        elif exam.fee_status not in (FEE_PENDING, FEE_BILLED):
            problems.append(f'Test No {exam.test_no} (no pending fee — {exam.fee_status.lower() or "not set"})')
    if problems:
        raise serializers.ValidationError({'items': 'Eye test fee cannot be billed: ' + '; '.join(problems) + '.'})

    EyeExamination.objects.filter(pk__in=wanted).update(fee_status=FEE_BILLED, fee_invoice=invoice)
