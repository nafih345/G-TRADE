"""
Streaming, chunked Excel/CSV product import engine.

Runs on a background thread kicked off by the upload view (see import_views.py).
Never loads a whole workbook into memory: .xlsx/.csv are read row-by-row via
openpyxl's read_only mode / the stdlib csv module, accumulated into fixed-size
chunks, and each chunk is validated + bulk-written in its own transaction.

Every data row in the file ends up in exactly one bucket, so the batch counters
always add up: total_rows = imported + updated + duplicate + failed. A row that
can't be written fails on its own (with its reason in ImportErrorLog); it never
takes the rest of its chunk down with it. Fully blank rows aren't data.

Nothing is written before the user has seen the whole file: an upload first runs
_analyze_file, a dry run that records every row as ImportPreviewRow, and waits in
AWAITING_CONFIRMATION until /confirm/. A row repeating an earlier one in the same
file is always skipped. An existing product's stock is never overwritten: the
sheet's quantity stays on its preview row for review in Stock Overview.
"""
import csv
import datetime
import hashlib
import itertools
import math
import os
import re
import tempfile
import threading
import time
import uuid
import zipfile

from django.db import InterfaceError, OperationalError, transaction, close_old_connections, connections
from django.utils import timezone
from openpyxl import load_workbook

from .models import Product, ImportBatch, ImportBarcodeRow, ImportErrorLog, ImportPreviewRow
from .views import infer_category_name
from .barcode_utils import (
    advance_series_past, detect_file_sequence, next_sequence_codes, settings_sequence, taken_barcodes,
)

CHUNK_SIZE = 500
# A running job saves (and so bumps updated_at) after every chunk, which takes
# seconds. Anything quiet for this long lost its thread (a server restart,
# Render's free-tier spin-down, a redeploy) and gets resumed by the watchdog.
STALE_AFTER_SECONDS = 180
MAX_RESUMES = 5
ACTIVE_STATUSES = ('PENDING', 'PROCESSING')
ROW_TAG_RE = re.compile(rb'<(?:\w+:)?row[\s>]')
# A dropped database connection says nothing about the rows being written, so these
# retry the chunk (and finally leave the job to the watchdog) instead of failing rows.
TRANSIENT_DB_ERRORS = (OperationalError, InterfaceError)
DB_RETRIES = 3
HEADER_SCAN_ROWS = 25
HEARTBEAT_SECONDS = 30
MAX_PRICE = 9_999_999_999.99    # Product price columns are DecimalField(12, 2)
MAX_STOCK = 2_147_483_647

# Column names are matched once per sheet, whatever order the columns are in. Within a
# field, earlier aliases win. Word-based, see resolve_field_headers.
FIELD_ALIASES = {
    'sku': ['code', 'sku', 'sku code', 'item code', 'product code', 'stock code', 'code no', 'item no',
            'item number', 'product id', 'part no'],
    'model_no': ['modelno', 'model_no', 'model number', 'model'],
    'name': ['item_name', 'product name', 'product', 'name', 'particular', 'particulars', 'item',
             'item description', 'product description', 'description'],
    'name_local': ['item_name_l', 'local name', 'name local'],
    'barcode': ['barcode', 'barcode no', 'upc', 'ean', 'tag'],
    'category': ['category name', 'category'],
    'sub_category': ['sub category', 'sub_category', 'subcat'],
    'group': ['group', 'group_name'],
    'brand': ['brand', 'make', 'company', 'manufacturer'],
    'color_code': ['colorcode', 'color_code', 'color', 'colour'],
    'size': ['size'],
    'supplier': ['supplier', 'vendor'],
    'address': ['address', 'location', 'rack'],
    'cost_price': ['cost price', 'cost', 'cp', 'purchase price', 'purchase rate', 'cost rate'],
    'selling_price': ['sales price', 'selling price', 'sale price', 'retail price', 'sale rate', 'sales rate',
                      'selling rate', 'sp', 'mrp', 'price', 'rate'],
    'stock': ['stock qty', 'stock', 'qty', 'quantity', 'closing stock'],
}
# Too generic to mean anything inside a longer header: "Colour Code" isn't the SKU, and
# "Brand Name" isn't the product name. These only ever match a column named exactly that.
EXACT_ONLY_ALIASES = {'code', 'name', 'item', 'product', 'tag', 'sp', 'cp', 'price', 'rate', 'description'}
# The fields that can tell one product from another; a sheet without any isn't a product list.
IDENTITY_FIELDS = {'sku', 'base_sku', 'model_no', 'name', 'name_local', 'product_name', 'barcode'}
# Product column -> the sheet fields that feed it, for telling which columns a row may overwrite.
# Stock is here for new products only: an update never writes it (see _classify).
PRODUCT_FIELD_SOURCES = {
    'name': ('name', 'name_local'),
    'category_name': ('category',),
    'brand_name': ('brand',),
    'supplier_name': ('supplier',),
    'color': ('color_code',),
    'size': ('size',),
    'cost_price': ('cost_price',),
    'retail_price': ('selling_price',),
    'stock': ('stock',),
}

BLANK_TOKENS = ('', 'nan', 'none', 'null', 'undefined', 'n/a', '#n/a', 'na', 'nil', '-', '--')


def safe_float(val, default=0.0):
    if val is None:
        return default
    try:
        s = re.sub(r'(?i)^\s*(rs\.?|inr)|/-\s*$', '', str(val)).strip().replace('$', '').replace('₹', '').replace(',', '')
        if s.lower() == 'free':
            return 0.0
        if not s or s.lower() in ('none', 'null', 'nan', 'undefined', 'n/a', '-'):
            return default
        return float(s)
    except (ValueError, TypeError):
        return default


def safe_int(val, default=0):
    if val is None:
        return default
    try:
        s = str(val).strip().replace(',', '')
        if s.lower() == 'out of stock':
            return 0
        if not s or s.lower() in ('none', 'null', 'nan', 'undefined', 'n/a', '-'):
            return default
        return int(float(s))
    except (ValueError, TypeError, OverflowError):
        return default


def detect_ext(filename):
    lower = (filename or '').lower()
    if lower.endswith('.csv'):
        return 'csv'
    if lower.endswith('.xlsx'):
        return 'xlsx'
    if lower.endswith('.xls'):
        return 'xls'
    return None


def _header_words(text):
    """'SellingPrice' / 'Selling_Price (INR)' -> ['selling', 'price', 'inr']."""
    return re.findall(r'[a-z0-9]+', re.sub(r'([a-z0-9])([A-Z])', r'\1 \2', str(text)).lower())


def resolve_field_headers(headers, aliases_map=None):
    """
    Map each logical field to the one real header it matches, computed once per sheet.
    Two global passes (not one pass per field): every field's *exact* alias match is
    resolved and the header claimed before any field is allowed to fall back to a
    looser match, where all of an alias's words appear in a longer header ("Cost Price
    (INR)"). Whole words only, because matching inside words maps "Display" to the "sp"
    price column. Exact ignores case, spacing and punctuation: "Bar Code" is "barcode".
    """
    aliases_map = aliases_map or FIELD_ALIASES
    words = [(h, _header_words(h)) for h in headers]
    resolved = {}
    claimed = set()

    for field, aliases in aliases_map.items():
        for alias in aliases:
            compact = ''.join(_header_words(alias))
            match = next((h for h, w in words if ''.join(w) == compact and h not in claimed), None)
            if match:
                resolved[field] = match
                claimed.add(match)
                break

    for field, aliases in aliases_map.items():
        if field in resolved:
            continue
        for alias in aliases:
            if alias in EXACT_ONLY_ALIASES:
                continue
            wanted = set(_header_words(alias))
            # "Supplier Code" is a code, not the supplier.
            match = next((h for h, w in words if w and wanted.issubset(w) and h not in claimed
                          and (w[-1] not in ('code', 'id') or w[-1] in wanted)), None)
            if match:
                resolved[field] = match
                claimed.add(match)
                break

    # Last, once Brand Name, Supplier Name and the like have claimed theirs: whatever
    # name is left over ("Frame Name", "Lens Name") names the product.
    for field, aliases in aliases_map.items():
        if field not in resolved and 'name' in aliases:
            match = next((h for h, w in words if w and w[-1] == 'name' and h not in claimed), None)
            if match:
                resolved[field] = match
                claimed.add(match)

    return resolved


def field_getter(resolved_headers, row_dict):
    def get(field):
        h = resolved_headers.get(field)
        if not h:
            return ''
        v = row_dict.get(h, '')
        return '' if str(v).strip().lower() in BLANK_TOKENS else str(v).strip()
    return get


def _cell_text(val):
    if val is None:
        return ''
    if isinstance(val, float) and val.is_integer():
        val = int(val)  # Excel stores every number as a float: Code 1001 reads back as 1001.0
    elif isinstance(val, datetime.datetime) and val.time() == datetime.time():
        val = val.date()
    return str(val).replace('\x00', '').strip()    # Postgres rejects NUL in text


def _numeric_format(number_format):
    """
    Excel's number format -> (min_digits, thousands, decimals, percent), or None for
    General and anything with no plain reading. Scientific (0.00E+00) deliberately
    falls in that second group: a barcode shown that way must keep all its digits.
    """
    section = re.sub(r'\[[^\]]*\]|"[^"]*"|\\.|[_*].', '', (number_format or '').split(';')[0])
    match = re.fullmatch(r'[\s$₹€£(]*([#,0]+)(?:\.(0+))?(%?)[\s)]*', section)
    if not match:
        return None
    digits, decimals, percent = match.groups()
    return digits.count('0'), ',' in digits, len(decimals or ''), bool(percent)


def _number_text(value, spec):
    """A number as the sheet displays it: 123 under format 00000 is the code 00123."""
    min_digits, thousands, decimals, percent = spec
    if percent:
        value *= 100
    text = f"{value:{',' if thousands else ''}.{decimals}f}"
    if min_digits > 1 and not thousands and value >= 0:
        whole, dot, frac = text.partition('.')
        text = whole.zfill(min_digits) + dot + frac
    return text + ('%' if percent else '')


def _sheet_cells(ws):
    """Rows of a read-only sheet as the text the sheet shows, not the raw stored value."""
    formats = {}    # style id -> parsed format; a workbook has a few dozen styles, not one per cell

    for row in ws.iter_rows():
        cells = []
        for cell in row:
            value = cell.value
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                style_id = cell._style_id
                if style_id not in formats:
                    formats[style_id] = _numeric_format(cell.number_format)
                spec = formats[style_id]
                cells.append(_number_text(value, spec) if spec else _cell_text(value))
            else:
                cells.append(_cell_text(value))
        yield cells


def _iter_raw_sheets(file_path, ext):
    """Yields (sheet_name, rows) per sheet, each row being a list of cell text."""
    if ext == 'csv':
        with open(file_path, 'r', encoding='utf-8-sig', errors='replace', newline='') as f:
            yield 'Sheet 1', ([_cell_text(c) for c in r] for r in csv.reader(line.replace('\x00', '') for line in f))
        return

    if ext == 'xlsx':
        wb = load_workbook(file_path, read_only=True, data_only=True)
        try:
            for ws in wb.worksheets:
                if ws.sheet_state != 'visible':
                    continue
                # read_only mode stops at the sheet's <dimension> tag. Exporters leave that
                # stale, and a sheet saying A1:J1801 would silently lose every row after it.
                ws.reset_dimensions()
                yield ws.title, _sheet_cells(ws)
        finally:
            wb.close()
        return

    # Legacy .xls: whole-sheet fallback (the format itself caps out around ~65k rows)
    import pandas as pd
    for name, df in pd.read_excel(file_path, dtype=str, header=None, sheet_name=None).items():
        yield name, ([_cell_text(c) for c in r] for r in df.fillna('').values.tolist())


def _find_header_row(rows, aliases_map):
    """
    Index of the row that best looks like a header, or None. Exports often start with
    a shop name or report title, so it needn't be the first; a row further down has to
    match at least two columns to be believed over the data it might just be.
    """
    best, best_score = None, 0
    for i, cells in enumerate(rows):
        found = resolve_field_headers([c for c in cells if c], aliases_map)
        if not IDENTITY_FIELDS & set(found) or (i and len(found) < 2):
            continue
        if len(found) > best_score:
            best, best_score = i, len(found)
    return best


def _unique_headers(cells):
    """Row dicts are keyed by header, so a repeated or blank one would lose a column."""
    cells = list(cells)
    while cells and not cells[-1]:
        cells.pop()
    headers = []
    for i, cell in enumerate(cells, start=1):
        base = cell or f'Column {i}'
        header, n = base, 2
        while header in headers:
            header, n = f'{base} ({n})', n + 1
        headers.append(header)
    return headers


def iter_sheet_streams(file_path, ext, aliases_map=None):
    """
    Yields (sheet_name, headers, rows) per sheet, rows yielding (row_number, row_dict)
    with row_number as Excel shows it. headers is None for a sheet with no product
    columns (a cover page, a summary).
    """
    aliases_map = aliases_map or FIELD_ALIASES
    for sheet_name, raw in _iter_raw_sheets(file_path, ext):
        head = list(itertools.islice(raw, HEADER_SCAN_ROWS))
        header_idx = _find_header_row(head, aliases_map)
        if header_idx is None:
            yield sheet_name, None, iter(())
            continue
        headers = _unique_headers(head[header_idx])
        header_cells = head[header_idx][:len(headers)]

        def rows():
            for row_no, cells in enumerate(itertools.chain(head[header_idx + 1:], raw), start=header_idx + 2):
                if cells[:len(headers)] == header_cells:
                    continue    # header repeated at a page break in a printed report
                yield row_no, {h: (cells[i] if i < len(cells) else '') for i, h in enumerate(headers)}
        yield sheet_name, headers, rows()


def open_row_stream(file_path, ext, aliases_map=None):
    """Returns (headers: list[str], row_iterator: generator yielding dict per data row) for the first product sheet."""
    sheets = iter_sheet_streams(file_path, ext, aliases_map)
    for _name, headers, rows in sheets:
        if headers:
            def gen():
                try:
                    for _row_no, row_dict in rows:
                        yield row_dict
                finally:
                    sheets.close()
            return headers, gen()
    return [], iter(())


def _count_xml_rows(zf, sheet_path):
    # Counts <row> tags straight from the zipped XML: ~1s for 120k rows, where parsing
    # the sheet through openpyxl just to count it takes ~25s. <dimension> can't be
    # trusted for this, it's optional and often stale.
    count = 0
    tail = b''
    with zf.open(sheet_path) as f:
        while True:
            block = f.read(1 << 20)
            if not block:
                break
            buf = tail + block
            # Matches lying wholly inside the carried-over tail were counted last time.
            count += sum(1 for m in ROW_TAG_RE.finditer(buf) if m.end() > len(tail))
            tail = buf[-16:]
    return count


def quick_count_total_rows(file_path, ext):
    """Live-progress estimate only: includes blank rows and sheets that get skipped.
    The job replaces it with the exact figure when it finishes."""
    if ext == 'csv':
        with open(file_path, 'rb') as f:
            count = sum(1 for _ in f)
        return max(0, count - 1)
    if ext == 'xlsx':
        wb = load_workbook(file_path, read_only=True)
        try:
            paths = [getattr(ws, '_worksheet_path', None) for ws in wb.worksheets if ws.sheet_state == 'visible']
        finally:
            wb.close()
        with zipfile.ZipFile(file_path) as zf:
            return sum(max(0, _count_xml_rows(zf, p) - 1) for p in paths if p)
    import pandas as pd
    return sum(len(df) for df in pd.read_excel(file_path, dtype=str, sheet_name=None).values())


def _is_blank_row(row_dict):
    for v in row_dict.values():
        if str(v).strip().lower() not in BLANK_TOKENS:
            return False
    return True


def _validate(cost_price, selling_price, stock):
    errors = []
    for label, price in (('Cost Price', cost_price), ('Selling Price', selling_price)):
        if not math.isfinite(price) or price > MAX_PRICE:
            errors.append(f"{label} is too large")
        elif price < 0:
            errors.append(f"{label} cannot be negative")
    if stock < 0:
        errors.append("Stock quantity cannot be negative")
    elif stock > MAX_STOCK:
        errors.append("Stock quantity is too large")
    return errors


def _clean_code(value):
    """'1001.0' is Code 1001 from an .xls; an all-zero code is a placeholder, not a code."""
    code = re.sub(r'\.0+$', '', value)
    return code if code.strip('0') else ''


def _short_hash(*parts):
    return hashlib.sha1('|'.join(parts).encode('utf-8')).hexdigest()[:8].upper()


def _same_product(a, b):
    """a, b = (name, color, size, barcode). Barcodes settle it when both rows have one."""
    if a[3] and b[3]:
        return a[3] == b[3]
    return a[:3] == b[:3]


class ImportState:
    """What the database holds, plus what this job has claimed so far."""

    def __init__(self, batch):
        # Soft-deleted rows included: they still hold their sku/barcode in the unique indexes.
        self.products = dict(Product.all_objects.values_list('sku', 'is_deleted'))
        # barcode -> (product_name, sku), so a duplicate can both report which
        # product already owns it AND be recognized as a harmless self-reference
        # when a row is simply re-supplying its own existing product's barcode.
        self.barcodes = {
            code: (pname, psku) for code, pname, psku in
            Product.objects.exclude(barcode__isnull=True).exclude(barcode='').values_list('barcode', 'name', 'sku')
        }
        # A product's second barcode scans to it too, so an import can't hand it to another.
        for code, pname, psku in (Product.objects.exclude(secondary_barcode__isnull=True)
                                  .exclude(secondary_barcode='').values_list('secondary_barcode', 'name', 'sku')):
            self.barcodes.setdefault(code, (pname, psku))
        self.deleted_codes = set()
        for pair in Product.all_objects.filter(is_deleted=True).values_list('barcode', 'secondary_barcode'):
            self.deleted_codes.update(c for c in pair if c)
        # Products that won't need a generated barcode: they have one, or a row gave them one.
        self.barcoded_skus = set(Product.all_objects.exclude(barcode__isnull=True).exclude(barcode='')
                                 .values_list('sku', flat=True))
        # row_index -> the generated barcode confirmed for that row.
        self.assigned = {}
        # sku -> the row (name, color, size, barcode) that first claimed it in this file.
        # Seeded from the batch's own products so a resumed job still recognises its rows.
        self.file_rows = {
            sku: _row_signature(name, color, size, barcode) for sku, name, color, size, barcode in
            Product.objects.filter(import_batch=batch).values_list('sku', 'name', 'color', 'size', 'barcode')
        }

    def forget(self, plan):
        """Undoes a row's claims after its write was rolled back, so later rows aren't misjudged."""
        if plan.get('new_file_row'):
            self.file_rows.pop(plan['sku'], None)
        if plan.get('kind') == 'create':
            self.products.pop(plan['sku'], None)
        if plan.get('new_barcode'):
            self.barcodes.pop(plan['barcode'], None)

    def wants_barcode(self, plan):
        """A row that writes a product still without one. A row for a product that already
        has a barcode keeps it, and a repeat row doesn't earn the product a second code."""
        return plan['kind'] in ('create', 'update') and not plan['barcode'] and plan['sku'] not in self.barcoded_skus


def _row_signature(name, color, size, barcode):
    return tuple((v or '').casefold() for v in (name, color, size, barcode))


def _classify(row_index, row_dict, resolved, strategy, state):
    """
    Decides what happens to one row without touching the database; None for a blank one.
    Returns a plan: kind 'create' / 'update' / 'skip', or 'error' with the failure.

    A product is identified by its Code. The same Code on rows that differ in barcode,
    name, colour or size is several products (shops list each colour of a frame under
    one model code), each kept under its own derived SKU. Only a true repeat is a
    duplicate, and it is skipped whatever the strategy: the first row wins. Derived SKUs
    are hashed from the row, so re-importing finds the same ones.
    """
    if _is_blank_row(row_dict):
        return None

    get = field_getter(resolved, row_dict)
    sku = _clean_code(get('sku') or get('model_no'))[:150]
    barcode = _clean_code(get('barcode'))[:150]
    name = (get('name') or get('name_local'))[:255]
    color = get('color_code')[:100]
    size = get('size')[:100]
    # A blank cell is 0, but text that isn't a number must not quietly become 0.
    cost_price = safe_float(get('cost_price') or 0, None)
    selling_price = safe_float(get('selling_price') or get('cost_price') or 0, None)
    stock = safe_int(get('stock') or 0, None)
    file_stock = stock if get('stock') else None

    if not sku and not name and not barcode:
        return dict(kind='error', sku='', name='', field_name='Validation', error_type='MISSING_IDENTIFIER',
                    message="Row has no Product Name, Code or Barcode")

    errors = [f"{label} '{get(field)}' is not a number" for label, field, value in (
        ('Cost Price', 'cost_price', cost_price), ('Selling Price', 'selling_price', selling_price),
        ('Stock', 'stock', stock)) if value is None]
    errors = errors or _validate(cost_price, selling_price, stock)
    if errors:
        return dict(kind='error', sku=sku, name=name, field_name='Validation', error_type='VALIDATION_FAILED',
                    message=", ".join(errors))

    if not name:
        name = f"{get('brand')} {get('category')}".strip() or sku or barcode
    signature = _row_signature(name, color, size, barcode)

    owner = state.barcodes.get(barcode) if barcode else None
    base_sku = sku or (owner[1] if owner else barcode) or f"SKU-{_short_hash(*signature[:3])}"

    first_row = state.file_rows.get(base_sku)
    if first_row is None:
        target, repeat = base_sku, False
    elif _same_product(first_row, signature):
        target, repeat = base_sku, True
    else:
        target = f"{base_sku[:130]}-{_short_hash(*signature)}"
        repeat = target in state.file_rows

    if owner and owner[1] != target:
        if strategy != 'DUPLICATE':
            return dict(kind='error', sku=target, name=name, field_name='Barcode', error_type='DUPLICATE_BARCODE',
                        message=f"Duplicate Barcode. Barcode: {barcode}. Existing Product: {owner[0]} ({owner[1]})")
        barcode = ''

    category = get('category') or 'Frames'
    supplier = get('supplier')
    plan = dict(
        kind='create', sku=target, barcode=barcode, counter='imported', replace=False, revive=False,
        repeat=repeat, file_stock=file_stock, new_file_row=target not in state.file_rows,
        new_barcode=bool(barcode) and barcode not in state.barcodes,
        payload=dict(
            name=name,
            category_name=(infer_category_name(category, name) or category)[:140],
            brand_name=(get('brand') or 'Generic')[:140],
            supplier_name=supplier[:140] if supplier else '',
            color=color or None,
            size=size or None,
            cost_price=cost_price,
            retail_price=selling_price,
            stock=stock,
            extra_data=row_dict,
            import_row=row_index,
        ),
        # What an update may overwrite. UPDATE changes only what this row fills in;
        # REPLACE also clears cells left blank; a column the sheet doesn't have is
        # neither, so a two-column price list can't wipe cost or brand. Never stock:
        # an existing product's quantity moves only through a ledgered adjustment.
        overwrite={'extra_data', 'import_row'} | {
            field for field, sources in PRODUCT_FIELD_SOURCES.items()
            if field != 'stock' and any((s in resolved) if strategy == 'REPLACE' else get(s) for s in sources)
        },
    )

    is_deleted = state.products.get(target)
    if is_deleted:
        # The old row was deleted, so to the shop this is a new product. Reusing the row
        # is what its unique sku forces, and it keeps any history pointing at it.
        plan.update(kind='update', revive=True)
    elif repeat:
        plan.update(kind='skip', counter='duplicate', new_barcode=False)
    elif is_deleted is not None:
        if strategy == 'SKIP':
            plan.update(kind='skip', counter='duplicate', new_barcode=False)
        elif strategy == 'DUPLICATE':
            plan.update(sku=f"{target[:140]}-DUP{uuid.uuid4().hex[:4].upper()}", barcode='', new_barcode=False,
                        new_file_row=False)
            plan['payload']['name'] = f"{name} (Duplicate)"[:255]
        else:
            plan.update(kind='update', counter='updated', replace=strategy == 'REPLACE')

    if plan['new_file_row']:
        state.file_rows[target] = signature
    if plan['kind'] != 'skip':
        state.products[plan['sku']] = False
    if plan['new_barcode']:
        state.barcodes[barcode] = (name, target)
    return plan


def _apply_plans(batch, plans, state):
    """Writes the given plans, all or nothing."""
    creates = [p for p in plans if p['kind'] == 'create']
    updates = [p for p in plans if p['kind'] == 'update']
    row_codes = {p['barcode'] for p in plans if p['barcode']}

    with transaction.atomic():
        held_by_deleted = row_codes & state.deleted_codes
        if held_by_deleted:
            # A deleted product is hidden everywhere but still blocks its barcode.
            deleted = Product.all_objects.filter(is_deleted=True)
            deleted.filter(barcode__in=held_by_deleted).update(barcode=None)
            deleted.filter(secondary_barcode__in=held_by_deleted).update(secondary_barcode=None)

        new_products = [
            Product(sku=p['sku'], barcode=p['barcode'] or None, opening_stock=p['payload']['stock'],
                    import_batch=batch, is_active=True, stock_source='EXCEL_IMPORT', **p['payload'])
            for p in creates
        ]
        if new_products:
            Product.objects.bulk_create(new_products, batch_size=CHUNK_SIZE)

        if updates:
            existing_objs = {o.sku: o for o in Product.all_objects.filter(sku__in=[p['sku'] for p in updates])}
            to_update = {}
            for p in updates:
                o = existing_objs.get(p['sku'])
                if o is None:
                    raise ValueError(f"Product {p['sku']} no longer exists")
                old_extra = o.extra_data or {}
                for field, value in p['payload'].items():
                    if p['revive'] or field in p['overwrite']:
                        setattr(o, field, value)
                if not p['revive'] and not p['replace']:
                    o.extra_data = {**old_extra, **p['payload']['extra_data']}
                if p['barcode']:
                    o.barcode = p['barcode']
                if p['revive']:
                    o.opening_stock = o.stock
                    o.is_deleted = False
                    o.is_active = True
                o.import_batch = batch
                to_update[o.pk] = o

            Product.all_objects.bulk_update(
                list(to_update.values()),
                fields=['name', 'category_name', 'brand_name', 'supplier_name',
                        'color', 'size', 'cost_price', 'retail_price', 'stock', 'opening_stock',
                        'extra_data', 'import_row', 'barcode', 'import_batch', 'is_deleted', 'is_active'],
                batch_size=CHUNK_SIZE
            )


def _error_log(batch, sheet, row_no, row_dict, sku, name, field_name, error_type, message):
    return ImportErrorLog(
        batch=batch, sheet_name=sheet[:100], row_number=row_no,
        product_code=(sku or '')[:100], product_name=(name or '')[:255], field_name=field_name,
        error_type=error_type, error_message=message, raw_data=row_dict
    )


def _process_chunk(batch, chunk_rows, strategy, state):
    """Validates + writes one chunk. Returns the count of rows that went into each bucket."""
    counts = dict(imported=0, updated=0, duplicate=0, failed=0, blank=0)
    plans = []
    error_logs = []
    try:
        for sheet, row_no, row_index, row_dict, resolved in chunk_rows:
            plan = _classify(row_index, row_dict, resolved, strategy, state)
            if plan is None:
                counts['blank'] += 1
                continue
            plan.update(sheet=sheet, row_no=row_no, row_dict=row_dict)
            plans.append(plan)
            code = state.assigned.get(row_index)
            if code and state.wants_barcode(plan):
                plan.update(barcode=code, new_barcode=True)
                state.barcodes[code] = (plan['payload']['name'], plan['sku'])
            if plan['kind'] in ('create', 'update') and plan['barcode']:
                state.barcoded_skus.add(plan['sku'])

        for plan in plans:
            if plan['kind'] == 'error':
                counts['failed'] += 1
                error_logs.append(_error_log(batch, plan['sheet'], plan['row_no'], plan['row_dict'], plan['sku'],
                                             plan['name'], plan['field_name'], plan['error_type'], plan['message']))
            elif plan['kind'] == 'skip':
                counts['duplicate'] += 1

        writes = [p for p in plans if p['kind'] in ('create', 'update')]
        try:
            _apply_plans(batch, writes, state)
        except TRANSIENT_DB_ERRORS:
            raise
        except Exception:
            # Something the checks above didn't catch. Find the one row responsible,
            # rather than failing the hundreds of good rows sharing its chunk.
            written = []
            for plan in writes:
                try:
                    _apply_plans(batch, [plan], state)
                    written.append(plan)
                except TRANSIENT_DB_ERRORS:
                    raise
                except Exception as row_err:
                    state.forget(plan)
                    counts['failed'] += 1
                    error_logs.append(_error_log(
                        batch, plan['sheet'], plan['row_no'], plan['row_dict'], plan['sku'],
                        plan['payload']['name'], 'Row', 'ROW_FAILED', str(row_err)))
            writes = written

        for plan in writes:
            counts[plan['counter']] += 1
        if error_logs:
            ImportErrorLog.objects.bulk_create(error_logs, batch_size=CHUNK_SIZE)
    except Exception:
        for plan in plans:
            state.forget(plan)
        raise
    return counts


class ImportSuperseded(Exception):
    """This job no longer owns its batch: the batch was deleted, or the watchdog restarted it."""


_running_lock = threading.Lock()
_running_ids = set()


def start_import_thread(batch_id):
    """Starts run_import_job on a daemon thread unless this process already runs it."""
    key = str(batch_id)
    with _running_lock:
        if key in _running_ids:
            return False
        _running_ids.add(key)

    def target():
        # Threads don't inherit the request's tenant, and resumed jobs never had one: run as
        # the tenant that owns the batch.
        from apps.common import tenancy
        try:
            with tenancy.unscoped():
                tenant_id = ImportBatch.objects.filter(pk=batch_id).values_list('tenant_id', flat=True).first()
            if tenant_id is None:
                return
            with tenancy.use_tenant(tenant_id):
                run_import_job(batch_id)
        finally:
            with _running_lock:
                _running_ids.discard(key)

    threading.Thread(target=target, daemon=True, name=f"import-{key[:8]}").start()
    return True


def resume_stalled_imports():
    """
    Restarts imports whose background thread died. Called from the polling
    endpoints, so simply having the Import page open is enough to revive a job
    after a restart. The conditional UPDATE is the claim: with several gunicorn
    workers polling, only one of them wins a given stalled batch.
    """
    cutoff = timezone.now() - datetime.timedelta(seconds=STALE_AFTER_SECONDS)
    stalled = (ImportBatch.objects
               .filter(status__in=(*ACTIVE_STATUSES, 'ANALYZING'), updated_at__lt=cutoff, is_deleted=False)
               .only('id', 'updated_at'))
    for b in stalled:
        with _running_lock:
            if str(b.id) in _running_ids:
                continue
        claimed = ImportBatch.objects.filter(id=b.id, updated_at=b.updated_at).update(updated_at=timezone.now())
        if claimed:
            start_import_thread(b.id)


def _materialize_file(batch, ext):
    """Returns (path, is_temp). Prefers the media file; falls back to the DB copy."""
    try:
        if batch.file and os.path.exists(batch.file.path):
            return batch.file.path, False
    except Exception:
        pass
    if batch.file_data:
        fd, tmp_path = tempfile.mkstemp(suffix=f'.{ext}')
        with os.fdopen(fd, 'wb') as f:
            f.write(bytes(batch.file_data))
        return tmp_path, True
    raise FileNotFoundError("The uploaded file is no longer on the server. Please upload it again.")


def _log(batch, message):
    batch.logs = (batch.logs or []) + [f"{datetime.datetime.now().strftime('%H:%M:%S')} - {message}"]


def _take_turn(batch):
    """
    Makes this the running import, unless another one is. Imports run strictly one at
    a time: each works from its own snapshot of existing SKUs and barcodes, so two at
    once would collide on the unique indexes. A batch that loses stays PENDING, and
    the job that's running starts it on finishing (or the watchdog does).
    """
    cutoff = timezone.now() - datetime.timedelta(seconds=STALE_AFTER_SECONDS)
    with transaction.atomic():
        active = {row['id']: row for row in (
            ImportBatch.objects.select_for_update()
            .filter(status__in=ACTIVE_STATUSES, is_deleted=False)
            .order_by('uploaded_date').values('id', 'status', 'updated_at', 'batch_number')
        )}
        if batch.pk not in active:
            return False
        running = [r for pk, r in active.items() if pk != batch.pk and r['status'] == 'PROCESSING' and r['updated_at'] >= cutoff]
        if running:
            ImportBatch.objects.filter(pk=batch.pk).update(remarks=f"Queued behind {running[0]['batch_number']}.")
            return False
        # Claimed here, inside the lock; batch.status keeps the old value to tell a resume.
        ImportBatch.objects.filter(pk=batch.pk).update(status='PROCESSING', updated_at=timezone.now())
        batch.status = active[batch.pk]['status']
        return True


def _start_next_import():
    next_id = (ImportBatch.objects.filter(status='PENDING', is_deleted=False)
               .order_by('uploaded_date').values_list('id', flat=True).first())
    if next_id:
        start_import_thread(next_id)


def _sheet_barcode(resolved, row_dict):
    return _clean_code(field_getter(resolved, row_dict)('barcode'))[:150]


PREVIEW_KINDS = {'create': 'NEW', 'update': 'UPDATE', 'skip': 'DUPLICATE', 'error': 'ERROR'}


def _preview_message(plan, strategy, first_rows):
    kind = plan['kind']
    if kind == 'error':
        return plan['message']
    if kind == 'skip':
        if plan['repeat']:
            sheet, row_no = first_rows.get(plan['sku'], ('', None))
            return f"Repeats row {row_no} of {sheet}" if row_no else "Repeats an earlier row of this file"
        return "Already in Products (Skip Duplicates)"
    if plan['revive']:
        return "Restores a deleted product"
    if kind == 'update':
        verb = 'Replaces' if strategy == 'REPLACE' else 'Updates'
        return f"{verb} existing product {plan['sku']}. Its stock is not changed"
    if strategy == 'DUPLICATE' and '-DUP' in plan['sku']:
        return "Copy of an existing product"
    return ''


def _analyze_file(batch, file_path, ext):
    """
    Dry run of the import for the preview: classifies every row exactly as the job will
    and records the verdict as an ImportPreviewRow, writing nothing else. With auto_barcode
    it also works out which rows need a generated code and which codes those are. Safe to
    repeat, so a stalled run just starts again.
    """
    state = ImportState(batch)
    strategy = batch.duplicate_strategy
    row_index = total = with_barcode = keeps_existing = sheets_read = 0
    file_codes = set()
    due = {}    # sku -> its row. A repeat row with a barcode cancels it, or a number goes unused.
    first_rows = {}    # sku -> (sheet, row_no) of the row that claimed it
    counts = dict(NEW=0, UPDATE=0, DUPLICATE=0, ERROR=0)
    all_headers = []
    pending = []
    last_beat = time.time()

    ImportPreviewRow.objects.filter(batch=batch).delete()

    def flush():
        # Rows that update a product show its stock as it is now, next to the sheet's.
        skus = [r.product_code for r in pending if r.kind == 'UPDATE']
        stock = dict(Product.all_objects.filter(sku__in=skus).values_list('sku', 'stock')) if skus else {}
        for r in pending:
            if r.kind == 'UPDATE':
                r.existing_stock = stock.get(r.product_code)
        ImportPreviewRow.objects.bulk_create(pending, batch_size=CHUNK_SIZE)
        ImportBatch.objects.filter(pk=batch.pk).update(updated_at=timezone.now(), processed_rows=row_index)
        pending.clear()

    for sheet_name, headers, stream in iter_sheet_streams(file_path, ext):
        if headers is None:
            continue
        sheets_read += 1
        resolved = resolve_field_headers(headers)
        all_headers += [h for h in headers if h not in all_headers]
        for row_no, row_dict in stream:
            row_index += 1
            if time.time() - last_beat >= HEARTBEAT_SECONDS:
                ImportBatch.objects.filter(pk=batch.pk).update(updated_at=timezone.now())
                last_beat = time.time()
            plan = _classify(row_index, row_dict, resolved, strategy, state)
            if plan is None:
                continue
            total += 1
            kind = PREVIEW_KINDS[plan['kind']]
            if kind == 'UPDATE' and plan['revive']:
                kind = 'NEW'    # deleted, so to the shop it is a new product
            counts[kind] += 1
            name = plan['payload']['name'] if 'payload' in plan else plan['name']
            pending.append(ImportPreviewRow(
                batch=batch, row_index=row_index, sheet_name=sheet_name[:100], row_number=row_no, kind=kind,
                product_code=(plan['sku'] or '')[:150], product_name=(name or '')[:255],
                error_type=plan.get('error_type', '')[:40], message=_preview_message(plan, strategy, first_rows),
                file_stock=plan.get('file_stock'), cells=row_dict))
            if plan['kind'] in ('create', 'update'):
                first_rows.setdefault(plan['sku'], (sheet_name, row_no))
            if len(pending) >= CHUNK_SIZE:
                flush()

            code = _sheet_barcode(resolved, row_dict)
            if code:
                file_codes.add(code)
                with_barcode += 1
            if not batch.auto_barcode or plan['kind'] not in ('create', 'update'):
                continue
            if state.wants_barcode(plan):
                due[plan['sku']] = ImportBarcodeRow(
                    batch=batch, row_index=row_index, sheet_name=sheet_name[:100], row_number=row_no,
                    product_code=plan['sku'], product_name=plan['payload']['name'])
            elif plan['barcode']:
                due.pop(plan['sku'], None)
            else:
                keeps_existing += 1
            state.barcoded_skus.add(plan['sku'])
    flush()

    if not sheets_read:
        raise ValueError("No product columns found. The sheet needs a header row with at least a "
                         "Product Name, Code or Barcode column.")

    barcode_summary = {}
    rows = list(due.values())
    if batch.auto_barcode:
        rule = detect_file_sequence(file_codes) or settings_sequence()
        codes, stepped_over = next_sequence_codes(rule, len(rows), avoid=file_codes)
        for position, (row, code) in enumerate(zip(rows, codes)):
            row.position, row.slot_code = position, code
        barcode_summary = dict(total=total, with_barcode=with_barcode, keeps_existing=keeps_existing,
                               missing=len(rows), stepped_over=stepped_over, rule=rule)

    valid = counts['NEW'] + counts['UPDATE']
    with transaction.atomic():
        ImportBarcodeRow.objects.filter(batch=batch).delete()
        ImportBarcodeRow.objects.bulk_create(rows, batch_size=CHUNK_SIZE)
        ImportBatch.objects.filter(pk=batch.pk, status='ANALYZING').update(
            status='AWAITING_CONFIRMATION', updated_at=timezone.now(), column_headers=all_headers,
            total_rows=total, processed_rows=0,
            remarks=(f"{valid} of {total} rows are ready to import; {counts['DUPLICATE']} duplicates and "
                     f"{counts['ERROR']} invalid rows will be skipped. Waiting for your review."),
            preview_summary=dict(total=total, valid=valid, **{k.lower(): v for k, v in counts.items()}),
            barcode_summary=barcode_summary)


def _run_analysis(batch):
    tmp_path = None
    try:
        ext = detect_ext(batch.file_name)
        file_path, is_temp = _materialize_file(batch, ext)
        if is_temp:
            tmp_path = file_path
        _analyze_file(batch, file_path, ext)
    except TRANSIENT_DB_ERRORS as e:
        print("Barcode preview paused, database unavailable:", e)    # still ANALYZING: the watchdog retries
    except Exception as e:
        ImportBatch.objects.filter(pk=batch.pk).update(
            status='FAILED', remarks=f"Could not read the file: {e}", file_data=None,
            completed_at=timezone.now(), updated_at=timezone.now())
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        connections.close_all()


def _file_barcodes(file_path, ext):
    codes = set()
    for _sheet, headers, stream in iter_sheet_streams(file_path, ext):
        if headers:
            resolved = resolve_field_headers(headers)
            codes.update(filter(None, (_sheet_barcode(resolved, row_dict) for _row_no, row_dict in stream)))
    return codes


def _fix_barcodes(batch, file_path, ext):
    """
    Turns the confirmed preview into row_index -> barcode. Runs once, with the import's
    turn held, so nothing else is importing. Numbers something else took since the preview
    are dropped and the rest close up, so the codes stay a single run. A resumed job gets
    back the codes it started with, because by then its own products hold those numbers.
    """
    rows = ImportBarcodeRow.objects.filter(batch=batch)
    fixed = dict(rows.exclude(final_code=None).values_list('row_index', 'final_code'))
    if fixed:
        return fixed

    chosen = list(rows.filter(excluded=False).order_by('position'))
    if not chosen:
        return {}
    pool = list(rows.order_by('position').values_list('slot_code', flat=True))
    taken = taken_barcodes(pool)
    codes = [c for c in pool if c not in taken]
    if len(codes) < len(chosen):
        more, _ = next_sequence_codes(batch.barcode_summary['rule'], len(chosen) - len(codes),
                                      avoid=set(pool) | _file_barcodes(file_path, ext))
        codes += more

    for row, code in zip(chosen, codes):
        row.final_code = code
    with transaction.atomic():
        ImportBarcodeRow.objects.bulk_update(chosen, ['final_code'], batch_size=CHUNK_SIZE)
        advance_series_past([c.final_code for c in chosen] + [batch.barcode_summary['rule'].get('last_code') or ''])
    return {row.row_index: row.final_code for row in chosen}


def run_import_job(batch_id):
    close_old_connections()
    # file_data stays out of memory: on a small server a large upload held here for the
    # whole job is the difference between finishing and being killed.
    try:
        batch = ImportBatch.objects.defer('file_data').get(id=batch_id)
    except ImportBatch.DoesNotExist:
        return
    if batch.status == 'ANALYZING':
        _run_analysis(batch)
        return
    if batch.status not in ACTIVE_STATUSES:
        return
    if not _take_turn(batch):
        return

    start_time = time.time()
    tmp_path = None
    try:
        # Resuming: every row up to processed_rows was committed together with its
        # counters (see flush), so those rows are skipped rather than written twice.
        skip_rows = batch.processed_rows or 0
        # A big import can outlive many restarts. Only dying repeatedly at the same row is hopeless.
        resume_note = f"at row {skip_rows}"
        resumes = sum(1 for line in (batch.logs or []) if 'Resuming' in str(line) and str(line).endswith(resume_note))
        if batch.status == 'PROCESSING':
            if resumes >= MAX_RESUMES:
                raise RuntimeError(f"Import was interrupted {resumes} times {resume_note}; giving up.")
            _log(batch, f"Resuming after interruption at row {skip_rows}")
        else:
            _log(batch, "Import started")
        batch.status = 'PROCESSING'
        batch.remarks = 'Importing in background...'
        batch.save(update_fields=['status', 'remarks', 'logs', 'updated_at'])

        ext = detect_ext(batch.file_name)
        file_path, is_temp = _materialize_file(batch, ext)
        if is_temp:
            tmp_path = file_path

        total_rows = quick_count_total_rows(file_path, ext)
        batch.total_rows = max(total_rows, skip_rows)
        batch.save(update_fields=['total_rows', 'updated_at'])

        last_beat = time.time()

        def heartbeat():
            # The stretches with no chunk commits, which would otherwise look like a dead thread.
            nonlocal last_beat
            if time.time() - last_beat >= HEARTBEAT_SECONDS:
                ImportBatch.objects.filter(pk=batch.pk).update(updated_at=timezone.now())
                last_beat = time.time()

        state = ImportState(batch)
        heartbeat()
        if batch.auto_barcode:
            state.assigned = _fix_barcodes(batch, file_path, ext)
            heartbeat()
        strategy = batch.duplicate_strategy

        processed = skip_rows
        imported = batch.imported_rows or 0
        updated = batch.updated_rows or 0
        failed = batch.failed_rows or 0
        duplicate = batch.duplicate_rows or 0
        chunk = []

        def save_progress(p, i, u, f, d):
            batch.processed_rows = p
            batch.imported_rows = i
            batch.updated_rows = u
            batch.failed_rows = f
            batch.duplicate_rows = d
            fields = ['processed_rows', 'imported_rows', 'updated_rows', 'failed_rows', 'duplicate_rows', 'updated_at']
            if p > batch.total_rows:
                batch.total_rows = p
                fields.append('total_rows')
            batch.save(update_fields=fields)

        def flush(chunk_rows):
            nonlocal processed, imported, updated, failed, duplicate
            if not chunk_rows:
                return
            for attempt in range(DB_RETRIES):
                try:
                    try:
                        # Rows and progress counters commit together, so after a crash
                        # processed_rows is exactly where the resume has to pick up.
                        with transaction.atomic():
                            # Locked, so a second copy of this job (the watchdog restarted
                            # a slow one) can't write the same rows.
                            owned = (ImportBatch.objects.select_for_update().filter(pk=batch.pk)
                                     .values_list('processed_rows', flat=True).first())
                            if owned != processed:
                                raise ImportSuperseded()
                            counts = _process_chunk(batch, chunk_rows, strategy, state)
                            save_progress(processed + len(chunk_rows), imported + counts['imported'],
                                          updated + counts['updated'], failed + counts['failed'],
                                          duplicate + counts['duplicate'])
                    except (ImportSuperseded, *TRANSIENT_DB_ERRORS):
                        raise
                    except Exception as chunk_err:
                        counts = dict(imported=0, updated=0, duplicate=0, failed=len(chunk_rows))
                        with transaction.atomic():
                            ImportErrorLog.objects.bulk_create([
                                _error_log(batch, sheet, r_no, r_data, '', '', 'Chunk', 'CHUNK_FAILED', str(chunk_err))
                                for sheet, r_no, _r_index, r_data, _resolved in chunk_rows
                            ], batch_size=CHUNK_SIZE)
                            save_progress(processed + len(chunk_rows), imported, updated, failed + counts['failed'],
                                          duplicate)
                    break
                except TRANSIENT_DB_ERRORS:
                    if attempt == DB_RETRIES - 1:
                        raise
                    connections.close_all()
                    time.sleep(2 ** attempt)

            processed += len(chunk_rows)
            imported += counts['imported']
            updated += counts['updated']
            failed += counts['failed']
            duplicate += counts['duplicate']

        row_index = 0
        all_headers = []
        sheets_read = 0
        for sheet_name, headers, rows in iter_sheet_streams(file_path, ext):
            if headers is None:
                _log(batch, f"Sheet '{sheet_name}' skipped: no product columns found")
                continue
            sheets_read += 1
            resolved = resolve_field_headers(headers)
            all_headers += [h for h in headers if h not in all_headers]
            batch.column_headers = all_headers
            _log(batch, f"Sheet '{sheet_name}' columns: " + ", ".join(f"{f}={h}" for f, h in resolved.items()))
            batch.save(update_fields=['column_headers', 'logs', 'updated_at'])

            for row_no, row_dict in rows:
                row_index += 1
                if row_index <= skip_rows:
                    if row_index % CHUNK_SIZE == 0:
                        heartbeat()
                    continue
                chunk.append((sheet_name, row_no, row_index, row_dict, resolved))
                if len(chunk) >= CHUNK_SIZE:
                    flush(chunk)
                    chunk = []
        flush(chunk)

        if not sheets_read:
            raise ValueError("No product columns found. The sheet needs a header row with at least a "
                             "Product Name, Code or Barcode column.")

        written = imported + updated
        total = written + duplicate + failed
        in_database = Product.objects.filter(import_batch=batch).count()
        processing_time = round((batch.processing_time or 0) + time.time() - start_time, 2)
        batch.processing_time = processing_time
        # Now the exact figure: blank rows were read but aren't data.
        batch.total_rows = batch.processed_rows = total
        batch.status = 'SUCCESS' if failed == 0 else ('PARTIAL' if written > 0 else 'FAILED')
        batch.remarks = (
            f"Imported {imported} new, updated {updated}, duplicates {duplicate}, failed {failed} "
            f"of {total} rows read in {processing_time}s."
        )
        if in_database != written:
            batch.status = 'PARTIAL'
            batch.remarks += f" Database holds {in_database} of the {written} rows written."
        if state.assigned:
            codes = list(state.assigned.values())
            batch.remarks += f" Generated {len(codes)} barcodes, {codes[0]} to {codes[-1]}."
        _log(batch, f"Import finished: {imported} imported, {updated} updated, {duplicate} duplicates, "
                    f"{failed} failed, {processing_time}s")
        batch.file_data = None  # finished; the bytes were only kept for resuming
        batch.completed_at = timezone.now()
        batch.save(update_fields=['processing_time', 'total_rows', 'processed_rows', 'status', 'remarks', 'logs',
                                  'file_data', 'completed_at', 'updated_at'])
        ImportBarcodeRow.objects.filter(batch=batch).delete()
        # Only the existing products' sheet quantities are still needed, for the stock review.
        previews = ImportPreviewRow.objects.filter(batch=batch)
        previews.exclude(kind='UPDATE').delete()
        previews.update(cells={})
    except ImportSuperseded:
        pass
    except TRANSIENT_DB_ERRORS as e:
        # The database went away: nothing is wrong with the import itself. Leaving it
        # PROCESSING with its file keeps it resumable by the watchdog once the DB is back.
        print("Import paused, database unavailable:", e)
    except Exception as e:
        try:
            batch.status = 'FAILED'
            batch.remarks = f"Import crashed: {e}"
            _log(batch, f"Import crashed: {e}")
            batch.file_data = None
            batch.completed_at = timezone.now()
            batch.save(update_fields=['status', 'remarks', 'logs', 'file_data', 'completed_at', 'updated_at'])
        except Exception:
            pass
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass
        try:
            _start_next_import()
        except Exception as e:
            print("Import queue notice:", e)     # the watchdog will pick it up
        connections.close_all()
