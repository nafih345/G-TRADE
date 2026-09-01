"""
Concurrency-safe barcode generation.

Uses a single atomic UPDATE ... RETURNING statement rather than
select_for_update() + read-modify-write: select_for_update() is a silent
no-op on SQLite (which this app also runs under as a packaged desktop
build), so a read-then-write pattern would have a real race window there.
A single UPDATE statement has no such window on either Postgres or SQLite.
"""
from django.db import transaction, connection

from .models import BarcodeSequence

DEFAULT_PREFIX = 'OPT'


def reserve_barcodes(prefix=DEFAULT_PREFIX, count=1):
    """Atomically reserves `count` sequential barcode strings for `prefix`."""
    BarcodeSequence.objects.get_or_create(prefix=prefix, defaults={'last_number': 100000})
    table = BarcodeSequence._meta.db_table
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                f"UPDATE {table} SET last_number = last_number + %s WHERE prefix = %s RETURNING last_number",
                [count, prefix]
            )
            new_last = cursor.fetchone()[0]
    start = new_last - count + 1
    return [f"{prefix}{start + i}" for i in range(count)]


# ---------------------------------------------------------------------------
# EAN-13 series barcodes
#
# 13 digits total: a 2-digit in-store prefix ("20", from the GS1 range 20-29
# reserved for "restricted circulation within a company"), a 10-digit running
# sequence, and a final EAN-13 check digit. Codes come out as a clean series:
#   2000000000015, 2000000000022, 2000000000039, ...
# ---------------------------------------------------------------------------
EAN13_SEQUENCE_PREFIX = 'EAN13'
EAN13_INSTORE_PREFIX = '20'


def ean13_check_digit(twelve_digits):
    """Standard EAN-13 modulo-10 check digit for a 12-digit string."""
    total = 0
    for i, ch in enumerate(twelve_digits):
        n = int(ch)
        total += n if i % 2 == 0 else n * 3
    return str((10 - (total % 10)) % 10)


def reserve_ean13(count=1):
    """Atomically reserves `count` sequential 13-digit EAN-13 barcodes."""
    prefix = EAN13_SEQUENCE_PREFIX
    BarcodeSequence.objects.get_or_create(prefix=prefix, defaults={'last_number': 0})
    table = BarcodeSequence._meta.db_table
    with transaction.atomic():
        with connection.cursor() as cursor:
            cursor.execute(
                f"UPDATE {table} SET last_number = last_number + %s WHERE prefix = %s RETURNING last_number",
                [count, prefix]
            )
            new_last = cursor.fetchone()[0]
    start = new_last - count + 1
    codes = []
    for i in range(count):
        body = EAN13_INSTORE_PREFIX + str(start + i).zfill(10)  # 2 + 10 = 12 digits
        codes.append(body + ean13_check_digit(body))
    return codes
