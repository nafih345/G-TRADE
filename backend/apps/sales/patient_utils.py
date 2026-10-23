"""
Concurrency-safe Customer.patient_code generation.

Uses a single atomic UPDATE ... RETURNING statement rather than
select_for_update() + read-modify-write: select_for_update() is a silent
no-op on SQLite (which this app also runs under as a packaged desktop
build), so a read-then-write pattern would have a real race window there.
A single UPDATE statement has no such window on either Postgres or SQLite.

Mirrors apps.products.barcode_utils.reserve_barcodes.
"""
from django.db import transaction, connection

from .models import PatientCodeSequence, TestNoSequence, EyeExamination, Appointment
from apps.common.sequences import bump_sequence

DEFAULT_PREFIX = 'P'
TEST_NO_PREFIX = ''  # Test No is displayed as a bare number (1001, 1002…), unlike patient_code's "P-" prefix


def reserve_patient_codes(prefix=DEFAULT_PREFIX, count=1):
    """Atomically reserves `count` sequential patient codes (e.g. P-1001) for `prefix`."""
    new_last = bump_sequence(PatientCodeSequence, {'prefix': prefix}, count, defaults={'last_number': 1000})
    start = new_last - count + 1
    return [f"{prefix}-{start + i}" for i in range(count)]


def peek_next_patient_code(prefix=DEFAULT_PREFIX):
    """
    Read-only preview of the code reserve_patient_codes would hand out next — does NOT
    consume the sequence. Lets the New Appointment dialog show the front desk a real,
    always-current "next patient ID" before a patient is actually saved, instead of the old
    client-side approach of scanning whatever patient list happened to be loaded in the
    browser and guessing the max+1 — which visibly got stuck repeating the same ID whenever
    that scan missed a recently-added patient (stale/incomplete local list, a save that
    failed silently, etc).
    """
    seq, _ = PatientCodeSequence.objects.get_or_create(prefix=prefix, defaults={'last_number': 1000})
    return f"{prefix}-{seq.last_number + 1}"


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
    TestNoSequence.objects.get_or_create(prefix=prefix, defaults={'last_number': 1000})
    table = TestNoSequence._meta.db_table
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                f"UPDATE {table} SET last_number = %s WHERE prefix = %s AND last_number < %s",
                [n, prefix, n],
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
