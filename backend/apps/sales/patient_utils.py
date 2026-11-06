"""
Concurrency-safe Customer.patient_code generation.

Uses a single atomic UPDATE ... RETURNING statement rather than
select_for_update() + read-modify-write: select_for_update() is a silent
no-op on SQLite (which this app also runs under as a packaged desktop
build), so a read-then-write pattern would have a real race window there.
A single UPDATE statement has no such window on either Postgres or SQLite.

Mirrors apps.products.barcode_utils.reserve_barcodes.
"""
import re

from django.db import transaction, connection

from .models import PatientCodeSequence, TestNoSequence, EyeExamination, Appointment, Customer
from apps.common.sequences import bump_sequence

DEFAULT_PREFIX = 'P'
TEST_NO_PREFIX = ''  # Test No is displayed as a bare number (1001, 1002…), unlike patient_code's "P-" prefix


PATIENT_CODE_BASE = 1000  # first code handed out is P-1001


def is_auto_patient_code(code, prefix=DEFAULT_PREFIX):
    """True for a code in the auto-generated series shape ("P-1004", "p1004")."""
    return bool(re.fullmatch(rf'{re.escape(prefix)}-?\d+', str(code or '').strip(), re.IGNORECASE))


def _code_number(code, prefix=DEFAULT_PREFIX):
    m = re.fullmatch(rf'{re.escape(prefix)}-?(\d+)', str(code or '').strip(), re.IGNORECASE)
    return int(m.group(1)) if m else None


def max_used_patient_number(prefix=DEFAULT_PREFIX):
    """Highest numeric suffix of any "P-NNNN" code already in use in the current tenant — on
    a Customer (soft-deleted ones too: they still hold the UNIQUE slot) or on an EyeExamination
    (exams saved before their Customer existed carry the code only in patient_id). Both managers
    are tenant-scoped. This is what keeps the series correct even when the counter row lags
    (codes accepted from a client, imported, renumbered, or a freshly created counter)."""
    codes = list(
        Customer.all_objects.filter(patient_code__istartswith=prefix)
        .values_list('patient_code', flat=True)
    ) + list(
        EyeExamination.all_objects.filter(patient_id__istartswith=prefix)
        .values_list('patient_id', flat=True).distinct()
    )
    nums = [n for n in (_code_number(c, prefix) for c in codes) if n is not None]
    return max(nums, default=PATIENT_CODE_BASE)


def _patient_code_in_use(code):
    return (
        Customer.all_objects.filter(patient_code__iexact=code).exists()
        or EyeExamination.all_objects.filter(patient_id__iexact=code).exists()
    )


def sync_patient_code_sequence(number, prefix=DEFAULT_PREFIX):
    """Advance the tenant's patient-code counter so it is at least `number` (never moves back)."""
    # bump by 0 = "make sure the tenant's row exists" without consuming a number.
    bump_sequence(PatientCodeSequence, {'prefix': prefix}, 0, defaults={'last_number': PATIENT_CODE_BASE})
    # One conditional UPDATE (tenant-scoped manager) — concurrent syncs can only raise it.
    PatientCodeSequence.objects.filter(prefix=prefix, last_number__lt=number).update(last_number=number)


def reserve_patient_codes(prefix=DEFAULT_PREFIX, count=1, heal=False):
    """Atomically reserves `count` sequential patient codes (e.g. P-1004) for `prefix`.

    Steady state is ONE atomic UPDATE ... RETURNING (race-safe on Postgres and SQLite; one
    round trip on the hosted DB). The counter stays ahead of every code in use because auto
    codes only ever come from here (the client's preview is never stored — see
    CustomerViewSet.perform_create) and migration 0031 lifted every tenant's counter past its
    existing codes. `heal=True` (the IntegrityError retry path) additionally re-syncs the
    counter to the highest code in use and skips any number still taken."""
    if heal:
        sync_patient_code_sequence(max_used_patient_number(prefix), prefix)
    out = []
    guard = 0
    while len(out) < count and guard < 10000:
        guard += 1
        new_last = bump_sequence(PatientCodeSequence, {'prefix': prefix}, 1,
                                 defaults={'last_number': PATIENT_CODE_BASE})
        code = f"{prefix}-{new_last}"
        if heal and _patient_code_in_use(code):
            continue
        out.append(code)
    return out


def peek_next_patient_code(prefix=DEFAULT_PREFIX):
    """
    Preview of the code reserve_patient_codes will hand out next — does NOT consume a
    number. The Eye Test and New Appointment screens show this as the "next patient ID"; it is
    only a preview — the real code is assigned at save time (CustomerViewSet.perform_create),
    so two devices showing the same preview still get different codes.

    Inspects the highest code actually in use in this tenant, so with P-1001..P-1003 on file it
    answers P-1004 even if the counter row lags; a lagging counter is lifted here as well.
    """
    seq = PatientCodeSequence.objects.filter(prefix=prefix).values_list('last_number', flat=True).first()
    used = max_used_patient_number(prefix)
    if seq is None or used > seq:
        sync_patient_code_sequence(used, prefix)
    return f"{prefix}-{max(seq or PATIENT_CODE_BASE, used) + 1}"


def reserve_test_numbers(count=1):
    """Atomically reserves `count` sequential Test Numbers (e.g. 1001). One global sequence
    shared by Appointment.test_no and EyeExamination.test_no — same mechanics as
    reserve_patient_codes, see its docstring for why an atomic UPDATE is used."""
    prefix = TEST_NO_PREFIX
    new_last = bump_sequence(TestNoSequence, {'prefix': prefix}, count, defaults={'last_number': 1000})
    start = new_last - count + 1
    return [str(start + i) for i in range(count)]


def peek_next_test_no():
    """Read-only preview of the Test No reserve_test_numbers would hand out next — does not
    consume the sequence. Mirrors peek_next_patient_code."""
    seq, _ = TestNoSequence.objects.get_or_create(prefix=TEST_NO_PREFIX, defaults={'last_number': 1000})
    return str(seq.last_number + 1)


def sync_test_no_sequence(test_no):
    """Advance the shared Test No sequence so it is at least `test_no`.

    Test numbers can enter the system without going through reserve_test_numbers():
    a number carried over from an Appointment, or the client-side preview accepted as-is by
    EyeExaminationViewSet.perform_create when it doesn't collide. When that happens the
    sequence counter lags behind the numbers actually in use, so the *next* reservation hands
    out a number that's already taken — which is how two different patients ended up sharing
    one Test No. Calling this whenever a number is accepted directly keeps the counter ahead.
    """
    try:
        n = int(str(test_no).strip())
    except (TypeError, ValueError):
        return
    prefix = TEST_NO_PREFIX
    seq, _ = TestNoSequence.objects.get_or_create(prefix=prefix, defaults={'last_number': 1000})
    table = TestNoSequence._meta.db_table
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                f"UPDATE {table} SET last_number = %s WHERE id = %s AND last_number < %s",
                [n, seq.pk, n],
            )


def reserve_unused_test_numbers(count=1):
    """Like reserve_test_numbers, but guarantees each number returned is not already used by
    an EyeExamination or Appointment. The plain sequence can lag behind numbers that were
    assigned directly (see sync_test_no_sequence), so a bare reservation could still collide;
    this skips past any such value until it finds a genuinely free one."""
    out = []
    guard = 0
    while len(out) < count and guard < 10000:
        guard += 1
        candidate = reserve_test_numbers(1)[0]
        if (
            EyeExamination.all_objects.filter(test_no=candidate).exists()
            or Appointment.all_objects.filter(test_no=candidate).exists()
        ):
            continue
        out.append(candidate)
    return out


def _phone_key(phone):
    """Last 10 digits of a phone number, so '+91 99618 76122' and '9961876122' compare equal."""
    digits = ''.join(ch for ch in str(phone or '') if ch.isdigit())
    return digits[-10:]


def find_duplicate_customer(name, phone):
    """
    The active Customer that is the same person as (name, phone): same name (case/space
    insensitive) AND same mobile number. Both are required — a shared family phone or two
    patients with the same name are different people. Returns None when there is no match.
    """
    from .models import Customer

    name = ' '.join(str(name or '').split())
    phone = _phone_key(phone)
    if not name or not phone:
        return None
    for cust in Customer.objects.filter(name__iexact=name).order_by('created_at'):
        if _phone_key(cust.phone) == phone:
            return cust
    return None


# Fields that make two submissions "the same exam": identical findings, not just the same patient.
_EXAM_IDENTITY_FIELDS = (
    'rx_summary', 'primary_diagnosis',
    'sub_sph_od', 'sub_cyl_od', 'sub_axis_od', 'sub_add_od',
    'sub_sph_os', 'sub_cyl_os', 'sub_axis_os', 'sub_add_os',
)


def find_duplicate_exam(data):
    """
    An existing EyeExamination that `data` (validated create payload) would merely duplicate:
    same patient (patient_id + name), examined today, with identical findings. That is a
    re-submit of one test session (retry after a failed sync, double submit) — a real second
    visit has its own findings and is NOT matched. Returns None when there is no match.
    """
    from django.utils import timezone

    patient_id = str(data.get('patient_id') or '').strip()
    name = ' '.join(str(data.get('patient_name') or '').split())
    if not patient_id or not name:
        return None

    norm = lambda v: ' '.join(str(v or '').split()).lower()
    wanted = {f: norm(data.get(f)) for f in _EXAM_IDENTITY_FIELDS}
    candidates = EyeExamination.objects.filter(
        patient_id=patient_id,
        patient_name__iexact=name,
        examination_date__date=timezone.localdate(),
    ).order_by('examination_date')
    for exam in candidates:
        if all(norm(getattr(exam, f)) == v for f, v in wanted.items()):
            return exam
    return None
