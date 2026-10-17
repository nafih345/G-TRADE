"""
Concurrency-safe barcode generation.

Uses a single atomic UPDATE ... RETURNING statement rather than
select_for_update() + read-modify-write: select_for_update() is a silent
no-op on SQLite (which this app also runs under as a packaged desktop
build), so a read-then-write pattern would have a real race window there.
A single UPDATE statement has no such window on either Postgres or SQLite.
"""
import re
from datetime import date

from django.db import transaction, connection
from django.db.models import Q
from rest_framework.exceptions import APIException

from .models import BarcodeSequence, BarcodeSeriesConfig, Product, ProductBarcode
from apps.common.sequences import bump_sequence

DEFAULT_PREFIX = 'OPT'


def reserve_barcodes(prefix=DEFAULT_PREFIX, count=1):
    """Atomically reserves `count` sequential barcode strings for `prefix`."""
    new_last = bump_sequence(BarcodeSequence, {'prefix': prefix}, count, defaults={'last_number': 100000})
    start = new_last - count + 1
    return [f"{prefix}{start + i}" for i in range(count)]


# ---------------------------------------------------------------------------
# Configurable product barcode series (BarcodeSeriesConfig)
#
# code = prefix pattern (literal text + {YY} {YYYY} {MM} {DD} date tokens)
#        + zero-padded running number
#        + optional GS1 mod-10 check digit
# padded to exactly `total_length` characters. The defaults ("20", 13 digits,
# mod-10) are the original EAN-13 in-store series: 2000000000015, 2000000000022 …
# ("20" is the GS1 range 20-29 reserved for restricted in-company circulation).
# ---------------------------------------------------------------------------
EAN13_SEQUENCE_PREFIX = 'EAN13'  # legacy BarcodeSequence row; seeds the config counter
EAN13_INSTORE_PREFIX = '20'

MIN_LENGTH, MAX_LENGTH = 6, 24
MIN_SEQUENCE_DIGITS = 3
PREFIX_TOKENS = ('{YYYY}', '{YY}', '{MM}', '{DD}')
_PREFIX_LITERAL_RE = re.compile(r'^[A-Z0-9-]*$')


class BarcodeConfigError(APIException):
    """Bad series definition or an exhausted series; surfaces as a 400 {'detail': msg}."""
    status_code = 400
    default_code = 'barcode_series'


def gs1_check_digit(body):
    """GS1 mod-10 check digit for any length (EAN-8/12/13/14, UPC): weights 3,1,3,…
    from the rightmost body digit."""
    total = 0
    for i, ch in enumerate(reversed(body)):
        n = int(ch)
        total += n * 3 if i % 2 == 0 else n
    return str((10 - (total % 10)) % 10)


def ean13_check_digit(twelve_digits):
    """Standard EAN-13 modulo-10 check digit for a 12-digit string."""
    return gs1_check_digit(twelve_digits)


def resolve_prefix(pattern, today=None):
    today = today or date.today()
    out = (pattern or '').upper()
    out = out.replace('{YYYY}', f'{today.year:04d}').replace('{YY}', f'{today.year % 100:02d}')
    out = out.replace('{MM}', f'{today.month:02d}').replace('{DD}', f'{today.day:02d}')
    return out


def series_layout(prefix_pattern, total_length, check_digit, today=None):
    """Validate a series definition and return (resolved_prefix, sequence_digits).
    Raises BarcodeConfigError with a user-facing message."""
    pattern = (prefix_pattern or '').strip().upper()
    literal = pattern
    for tok in PREFIX_TOKENS:
        literal = literal.replace(tok, '')
    if '{' in literal or '}' in literal:
        raise BarcodeConfigError('Unknown token in prefix. Use {YY}, {YYYY}, {MM} or {DD}.')
    if not _PREFIX_LITERAL_RE.match(literal):
        raise BarcodeConfigError('Prefix may contain only letters, digits and "-".')
    try:
        total_length = int(total_length)
    except (TypeError, ValueError):
        raise BarcodeConfigError('Total digits must be a number.')
    if not MIN_LENGTH <= total_length <= MAX_LENGTH:
        raise BarcodeConfigError(f'Total digits must be between {MIN_LENGTH} and {MAX_LENGTH}.')
    if check_digit not in ('MOD10', 'NONE'):
        raise BarcodeConfigError('Check digit must be MOD10 or NONE.')
    prefix = resolve_prefix(pattern, today)
    if check_digit == 'MOD10' and not prefix.isdigit() and prefix:
        raise BarcodeConfigError('A mod-10 check digit needs an all-numeric prefix.')
    seq_digits = total_length - len(prefix) - (1 if check_digit == 'MOD10' else 0)
    if seq_digits < MIN_SEQUENCE_DIGITS:
        raise BarcodeConfigError(
            f'Prefix is too long: at least {MIN_SEQUENCE_DIGITS} digits must be left for the running number.')
    return prefix, seq_digits


def format_series_code(prefix, seq_digits, check_digit, number):
    digits = str(int(number))
    if len(digits) > seq_digits:
        raise BarcodeConfigError(
            f'The barcode series is full ({seq_digits}-digit running number exhausted). '
            'Increase the total digits or change the prefix.')
    body = prefix + digits.zfill(seq_digits)
    return body + gs1_check_digit(body) if check_digit == 'MOD10' else body


def preview_series(prefix_pattern, total_length, check_digit, next_number, count=3, today=None):
    prefix, seq_digits = series_layout(prefix_pattern, total_length, check_digit, today)
    codes = []
    for i in range(count):
        try:
            codes.append(format_series_code(prefix, seq_digits, check_digit, next_number + i))
        except BarcodeConfigError:
            break
    capacity = 10 ** seq_digits - 1
    return {
        'resolved_prefix': prefix,
        'sequence_digits': seq_digits,
        'samples': codes,
        'remaining': max(0, capacity - next_number + 1),
        'numeric': prefix.isdigit() or not prefix,
    }


def find_barcode_owner(code, exclude_pk=None):
    """The product that already scans as `code` — via its primary barcode, its
    secondary barcode or a printed label code (ProductBarcode) — or None."""
    code = (code or '').strip()
    if not code:
        return None
    qs = Product.all_objects.filter(Q(barcode=code) | Q(secondary_barcode=code) | Q(extra_barcodes__code=code))
    if exclude_pk:
        qs = qs.exclude(pk=exclude_pk)
    return qs.first()


def _taken(codes):
    taken = set(Product.all_objects.filter(barcode__in=codes).values_list('barcode', flat=True))
    taken |= set(Product.all_objects.filter(secondary_barcode__in=codes).values_list('secondary_barcode', flat=True))
    taken |= set(ProductBarcode.objects.filter(code__in=codes).values_list('code', flat=True))
    return taken


def reserve_product_barcodes(count=1, avoid=None):
    """Atomically reserves `count` new barcodes from the configured series, skipping
    any code already used by a product (Product.barcode / ProductBarcode) or listed
    in `avoid` — so changing the pattern into an already-used range is safe."""
    if count <= 0:
        return []
    config = BarcodeSeriesConfig.load()
    prefix, seq_digits = series_layout(config.prefix_pattern, config.total_length, config.check_digit)
    avoid = set(avoid or ())
    table = BarcodeSeriesConfig._meta.db_table
    out = []
    for _attempt in range(10):
        need = count - len(out)
        with transaction.atomic():
            with connection.cursor() as cursor:
                cursor.execute(
                    f"UPDATE {table} SET last_number = last_number + %s WHERE id = %s RETURNING last_number",
                    [need, config.pk]
                )
                new_last = cursor.fetchone()[0]
        start = new_last - need + 1
        batch = [format_series_code(prefix, seq_digits, config.check_digit, start + i) for i in range(need)]
        taken = _taken(batch) | avoid
        out.extend(c for c in batch if c not in taken and c not in out)
        if len(out) >= count:
            return out[:count]
    raise BarcodeConfigError('Could not find free barcodes in the series — most nearby numbers are already used. '
                             'Move "Next number" forward in the barcode settings.')


def reserve_ean13(count=1):
    """Back-compat name: the EAN-13 series is now the configurable product series."""
    return reserve_product_barcodes(count=count)
