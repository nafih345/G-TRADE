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

from .models import PatientCodeSequence

DEFAULT_PREFIX = 'P'


def reserve_patient_codes(prefix=DEFAULT_PREFIX, count=1):
    """Atomically reserves `count` sequential patient codes (e.g. P-1001) for `prefix`."""
    PatientCodeSequence.objects.get_or_create(prefix=prefix, defaults={'last_number': 1000})
    table = PatientCodeSequence._meta.db_table
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                f"UPDATE {table} SET last_number = last_number + %s WHERE prefix = %s RETURNING last_number",
                [count, prefix]
            )
            new_last = cursor.fetchone()[0]
    start = new_last - count + 1
    return [f"{prefix}-{start + i}" for i in range(count)]
