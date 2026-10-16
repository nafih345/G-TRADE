"""Bill & Invoice Designer — data-field catalog, layout validator and compatibility rules.

A visual (schema 2) template is pure presentation: bands of positioned elements, each
element either static text or *bound* to a field id from the catalog below. Transaction
values are never stored in a template — the frontend resolves the field ids against the
real document at preview / print time (frontend/src/billing/billFields.js holds the same
catalog with labels and formatting; keep the two id lists in step — tests/test_billing.py
checks they match).

`validate_config()` is a whitelist: unknown keys are dropped, numbers clamped, colours and
fonts restricted, images limited to small raster data URLs, so nothing but layout data can
be persisted. `compatible_document_types()` derives which document types a template can be
assigned to from the fields it uses.
"""
import re

# ---------------------------------------------------------------------------
# Document types
# ---------------------------------------------------------------------------

SALES_FAMILY = {'SALES_INVOICE', 'WHOLESALE_BILL', 'ORDER_BILL', 'QUOTATION', 'SALES_RETURN'}
PURCHASE_FAMILY = {'PURCHASE_BILL', 'PURCHASE_RETURN'}
RECEIPT_FAMILY = {'PAYMENT_RECEIPT'}
RETURN_TYPES = {'SALES_RETURN', 'PURCHASE_RETURN'}
ALL_TYPES = SALES_FAMILY | PURCHASE_FAMILY | RECEIPT_FAMILY
ITEM_TYPES = ALL_TYPES - RECEIPT_FAMILY

# ---------------------------------------------------------------------------
# Field catalog: id -> document types that carry it (None = every type)
# ---------------------------------------------------------------------------

_UNIVERSAL = [
    'company.name', 'company.tagline', 'company.address', 'company.phone', 'company.email',
    'company.website', 'company.gstin', 'company.pan', 'company.bankDetails', 'company.upiId',
    'company.logo',
    'document.title', 'document.number', 'document.orderNumber', 'document.reference',
    'document.date', 'document.dueDate', 'document.status', 'document.paymentStatus',
    'document.branch', 'document.salesperson', 'document.preparedBy', 'document.printedAt',
    'document.notes', 'document.terms',
    'party.label', 'party.name', 'party.code', 'party.phone', 'party.email', 'party.address',
    'party.gstin', 'party.shippingAddress',
    'totals.subtotal', 'totals.discount', 'totals.additionalDiscount', 'totals.taxableAmount',
    'totals.tax', 'totals.cgst', 'totals.sgst', 'totals.igst', 'totals.cess', 'totals.shipping',
    'totals.otherCharges', 'totals.roundOff', 'totals.grandTotal', 'totals.paid', 'totals.balance',
    'totals.amountInWords', 'totals.itemCount', 'totals.totalQty',
    'payment.method', 'payment.reference', 'payment.splits', 'payment.status',
]
FIELD_SCOPES = {fid: None for fid in _UNIVERSAL}
FIELD_SCOPES.update({
    'document.deliveryDate': SALES_FAMILY,
    'document.fulfillmentStatus': {'ORDER_BILL', 'SALES_INVOICE'},
    'totals.refund': RETURN_TYPES,
    'receipt.amount': RECEIPT_FAMILY,
    'receipt.invoiceNumber': RECEIPT_FAMILY,
    'return.reason': RETURN_TYPES,
    'return.originalInvoice': RETURN_TYPES,
    'return.action': RETURN_TYPES,
})
FIELD_IDS = set(FIELD_SCOPES)

# Items-table columns -> document types that carry them (None = every type with items).
COLUMN_SCOPES = {
    'slno': None, 'name': None, 'description': None, 'sku': None, 'barcode': None, 'hsn': None,
    'variant': None, 'size': None, 'color': None, 'brand': None, 'qty': None, 'unit': None,
    'rate': None, 'discount': None, 'discountPercent': None, 'taxPercent': None, 'taxAmount': None,
    'total': None,
    'power': SALES_FAMILY,
    'batch': PURCHASE_FAMILY, 'expiry': PURCHASE_FAMILY, 'freeQty': PURCHASE_FAMILY,
    'mrp': PURCHASE_FAMILY,
}
COLUMN_KEYS = set(COLUMN_SCOPES)

TOTALS_ROW_KEYS = [
    'subtotal', 'discount', 'additionalDiscount', 'taxableAmount', 'tax', 'cgst', 'sgst', 'igst',
    'cess', 'shipping', 'otherCharges', 'roundOff', 'grandTotal', 'paid', 'balance', 'refund',
]

ELEMENT_TYPES = {
    'text', 'field', 'fieldList', 'companyBlock', 'partyBlock', 'logo', 'image', 'totals',
    'taxSummary', 'payment', 'barcode', 'qr', 'signature', 'line', 'box', 'pageNumber',
}
# Elements that need a document with line items.
ITEM_ELEMENT_TYPES = {'taxSummary'}

BANDS = ('header', 'summary', 'footer')
PAPER_SIZES = {'A4', 'A5', 'A6', 'LETTER', '58mm', '80mm', 'CUSTOM'}
FONT_FAMILIES = [
    "'Segoe UI', Arial, sans-serif", 'Arial, Helvetica, sans-serif', 'Helvetica, Arial, sans-serif',
    'Verdana, Geneva, sans-serif', 'Tahoma, Geneva, sans-serif', "'Trebuchet MS', sans-serif",
    "Georgia, 'Times New Roman', serif", "'Times New Roman', Times, serif",
    "'Courier New', Courier, monospace", "Calibri, 'Segoe UI', sans-serif", 'inherit',
]
DATE_FORMATS = {'DD-MM-YYYY', 'DD/MM/YYYY', 'YYYY-MM-DD', 'DD MMM YYYY', 'MMM DD, YYYY', 'DD.MM.YYYY'}

MAX_ELEMENTS_PER_BAND = 150
MAX_TEXT = 4000
MAX_IMAGE_BYTES = 400_000
COLOR_RE = re.compile(r'^(#[0-9a-fA-F]{3,8}|transparent)$')
IMAGE_RE = re.compile(r'^data:image/(png|jpeg|jpg|webp|gif);base64,[A-Za-z0-9+/=\s]+$')
TOKEN_RE = re.compile(r'\{\{\s*([a-zA-Z]+\.[a-zA-Z]+)\s*\}\}')


class LayoutError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Small coercion helpers
# ---------------------------------------------------------------------------

def _num(v, lo, hi, default):
    try:
        n = float(v)
    except (TypeError, ValueError):
        return default
    if n != n:  # NaN
        return default
    return round(min(hi, max(lo, n)), 2)


def _int(v, lo, hi, default):
    return int(_num(v, lo, hi, default))


def _bool(v, default=False):
    if isinstance(v, bool):
        return v
    if v in (None, ''):
        return default
    return str(v).lower() in ('1', 'true', 'yes', 'on')


def _str(v, max_len=200, default=''):
    if v is None:
        return default
    return str(v)[:max_len]


def _choice(v, allowed, default):
    return v if v in allowed else default


def _color(v, default=''):
    s = _str(v, 20).strip()
    return s if COLOR_RE.match(s) else default


def _font(v, default=''):
    return v if v in FONT_FAMILIES else default


def _image(v):
    s = _str(v, MAX_IMAGE_BYTES * 2)
    if not s:
        return ''
    if not IMAGE_RE.match(s) or len(s) > MAX_IMAGE_BYTES * 4 // 3 + 64:
        raise LayoutError('Images must be PNG, JPEG, WebP or GIF and smaller than 400 KB.')
    return s


def _field(v):
    return v if v in FIELD_IDS else ''


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def _style(raw):
    raw = raw if isinstance(raw, dict) else {}
    out = {}
    if 'fontFamily' in raw:
        out['fontFamily'] = _font(raw['fontFamily'])
    if 'fontSize' in raw:
        out['fontSize'] = _num(raw['fontSize'], 4, 72, 9)
    if 'fontWeight' in raw:
        out['fontWeight'] = _int(raw['fontWeight'], 100, 900, 400)
    for k in ('italic', 'uppercase', 'underline', 'wrap', 'shrinkToFit'):
        if k in raw:
            out[k] = _bool(raw[k])
    for k in ('color', 'bg', 'borderColor'):
        if k in raw:
            out[k] = _color(raw[k])
    if 'align' in raw:
        out['align'] = _choice(raw['align'], {'left', 'center', 'right', 'justify'}, 'left')
    if 'valign' in raw:
        out['valign'] = _choice(raw['valign'], {'top', 'middle', 'bottom'}, 'top')
    if 'lineHeight' in raw:
        out['lineHeight'] = _num(raw['lineHeight'], 0.8, 3, 1.3)
    if 'letterSpacing' in raw:
        out['letterSpacing'] = _num(raw['letterSpacing'], -2, 10, 0)
    if 'padding' in raw:
        out['padding'] = _num(raw['padding'], 0, 20, 0)
    if 'borderWidth' in raw:
        out['borderWidth'] = _num(raw['borderWidth'], 0, 5, 0)
    if 'borderStyle' in raw:
        out['borderStyle'] = _choice(raw['borderStyle'], {'solid', 'dashed', 'dotted', 'double'}, 'solid')
    if 'borderSides' in raw:
        out['borderSides'] = _choice(raw['borderSides'], {'all', 'top', 'bottom', 'tb', 'lr', 'left', 'right', 'none'}, 'all')
    if 'radius' in raw:
        out['radius'] = _num(raw['radius'], 0, 20, 0)
    return out


def _show(raw, keys):
    raw = raw if isinstance(raw, dict) else {}
    return {k: _bool(raw.get(k), True) for k in keys}


def _element(raw, band):
    if not isinstance(raw, dict):
        raise LayoutError('Each element must be an object.')
    etype = raw.get('type')
    if etype not in ELEMENT_TYPES:
        raise LayoutError(f'Unknown element type “{etype}”.')
    el = {
        'id': _str(raw.get('id'), 40) or 'el',
        'type': etype,
        'x': _num(raw.get('x'), -50, 1000, 0),
        'y': _num(raw.get('y'), -50, 1000, 0),
        'w': _num(raw.get('w'), 0.5, 1000, 20),
        'h': _num(raw.get('h'), 0.2, 1000, 6),
        'style': _style(raw.get('style')),
    }
    for k in ('hidden', 'locked', 'protected'):
        if _bool(raw.get(k)):
            el[k] = True
    if raw.get('name'):
        el['name'] = _str(raw.get('name'), 60)
    if raw.get('visibleIf'):
        el['visibleIf'] = _field(raw.get('visibleIf'))

    if etype == 'text':
        el['text'] = _str(raw.get('text'), MAX_TEXT)
        if raw.get('title'):
            el['title'] = _str(raw.get('title'), 120)
    elif etype == 'field':
        f = _field(raw.get('field'))
        if not f:
            raise LayoutError(f'Element “{el["id"]}” is bound to an unknown field.')
        el['field'] = f
        el['label'] = _str(raw.get('label'), 120)
        el['labelPosition'] = _choice(raw.get('labelPosition'), {'none', 'left', 'top'}, 'none')
        el['labelWidth'] = _num(raw.get('labelWidth'), 0, 200, 0)
        el['prefix'] = _str(raw.get('prefix'), 40)
        el['suffix'] = _str(raw.get('suffix'), 40)
        el['hideIfEmpty'] = _bool(raw.get('hideIfEmpty'), True)
        el['emptyText'] = _str(raw.get('emptyText'), 40)
        if raw.get('labelStyle'):
            el['labelStyle'] = _style(raw.get('labelStyle'))
    elif etype == 'fieldList':
        rows = []
        for r in (raw.get('fields') or [])[:30]:
            f = _field((r or {}).get('field'))
            if f:
                rows.append({'field': f, 'label': _str(r.get('label'), 80)})
        el['fields'] = rows
        el['layout'] = _choice(raw.get('layout'), {'rows', 'grid', 'inline'}, 'rows')
        el['labelWidth'] = _num(raw.get('labelWidth'), 0, 200, 25)
        el['hideEmpty'] = _bool(raw.get('hideEmpty'), True)
        el['separator'] = _str(raw.get('separator'), 6) or ':'
        if raw.get('labelStyle'):
            el['labelStyle'] = _style(raw.get('labelStyle'))
    elif etype == 'companyBlock':
        el['show'] = _show(raw.get('show'), ['name', 'tagline', 'address', 'phone', 'email', 'website', 'gstin', 'pan'])
        el['nameSize'] = _num(raw.get('nameSize'), 6, 48, 16)
        el['nameColor'] = _color(raw.get('nameColor'))
    elif etype == 'partyBlock':
        el['title'] = _str(raw.get('title'), 80)
        el['variant'] = _choice(raw.get('variant'), {'billing', 'shipping'}, 'billing')
        el['show'] = _show(raw.get('show'), ['title', 'name', 'code', 'phone', 'email', 'address', 'gstin'])
    elif etype in ('logo',):
        el['fit'] = _choice(raw.get('fit'), {'contain', 'cover'}, 'contain')
    elif etype == 'image':
        el['src'] = _image(raw.get('src'))
        el['fit'] = _choice(raw.get('fit'), {'contain', 'cover'}, 'contain')
        el['opacity'] = _num(raw.get('opacity'), 0.05, 1, 1)
    elif etype == 'totals':
        rows = []
        for r in (raw.get('rows') or [])[:20]:
            key = (r or {}).get('key') if isinstance(r, dict) else r
            if key in TOTALS_ROW_KEYS:
                row = {'key': key, 'label': _str((r or {}).get('label') if isinstance(r, dict) else '', 60)}
                if isinstance(r, dict) and _bool(r.get('always')):
                    row['always'] = True
                rows.append(row)
        el['rows'] = rows
        el['grandStyle'] = _style(raw.get('grandStyle'))
        el['divider'] = _bool(raw.get('divider'), True)
    elif etype == 'taxSummary':
        el['showHsn'] = _bool(raw.get('showHsn'), False)
    elif etype == 'payment':
        el['show'] = _show(raw.get('show'), ['method', 'reference', 'splits', 'paid', 'balance', 'status', 'bank', 'upi'])
        el['title'] = _str(raw.get('title'), 60)
    elif etype == 'barcode':
        el['field'] = _field(raw.get('field')) or 'document.number'
        el['showText'] = _bool(raw.get('showText'), True)
    elif etype == 'qr':
        el['source'] = _choice(raw.get('source'), {'field', 'upi', 'custom'}, 'field')
        el['field'] = _field(raw.get('field')) or 'document.number'
        el['customText'] = _str(raw.get('customText'), 500)
    elif etype == 'signature':
        el['label'] = _str(raw.get('label'), 80)
        el['showLine'] = _bool(raw.get('showLine'), True)
        el['showCompany'] = _bool(raw.get('showCompany'), True)
        el['src'] = _image(raw.get('src')) if raw.get('src') else ''
    elif etype == 'line':
        el['orientation'] = _choice(raw.get('orientation'), {'h', 'v'}, 'h')
        el['thickness'] = _num(raw.get('thickness'), 0.1, 5, 0.5)
        el['color'] = _color(raw.get('color'), '#0f172a')
        el['lineStyle'] = _choice(raw.get('lineStyle'), {'solid', 'dashed', 'dotted', 'double'}, 'solid')
    elif etype == 'pageNumber':
        el['format'] = _str(raw.get('format'), 60) or 'Page {page} of {pages}'

    if etype == 'text':
        bad = [t for t in TOKEN_RE.findall(el['text']) if t not in FIELD_IDS]
        if bad:
            raise LayoutError(f'Unknown data field “{{{{{bad[0]}}}}}” in a text element.')
    return el


def _column(raw):
    key = (raw or {}).get('key')
    if key not in COLUMN_KEYS:
        return None
    return {
        'key': key,
        'label': _str(raw.get('label'), 60),
        'width': _num(raw.get('width'), 1, 100, 10),
        'align': _choice(raw.get('align'), {'left', 'center', 'right'}, 'left'),
        'visible': _bool(raw.get('visible'), True),
        **({'decimals': _int(raw.get('decimals'), 0, 4, 2)} if raw.get('decimals') not in (None, '') else {}),
    }


def _table(raw):
    raw = raw if isinstance(raw, dict) else {}
    cols = [c for c in (_column(c) for c in (raw.get('columns') or [])[:30]) if c]
    seen, uniq = set(), []
    for c in cols:
        if c['key'] not in seen:
            seen.add(c['key'])
            uniq.append(c)
    return {
        'columns': uniq,
        'headerStyle': _style(raw.get('headerStyle')),
        'bodyStyle': _style(raw.get('bodyStyle')),
        'rowPadding': _num(raw.get('rowPadding'), 0, 10, 1.5),
        'cellPadX': _num(raw.get('cellPadX'), 0, 5, 1.3),
        'currencyInTable': _bool(raw.get('currencyInTable'), True),
        'zebra': _bool(raw.get('zebra'), False),
        'zebraColor': _color(raw.get('zebraColor'), '#f8fafc'),
        'borders': _choice(raw.get('borders'), {'grid', 'rows', 'outer', 'none', 'header'}, 'rows'),
        'borderColor': _color(raw.get('borderColor'), '#cbd5e1'),
        'repeatHeader': _bool(raw.get('repeatHeader'), True),
        'fillPage': _bool(raw.get('fillPage'), False),
        'showBrand': _bool(raw.get('showBrand'), False),
        'showPower': _bool(raw.get('showPower'), True),
        'showVariant': _bool(raw.get('showVariant'), False),
        'showSku': _bool(raw.get('showSku'), False),
        'emptyText': _str(raw.get('emptyText'), 80) or 'No items',
        'totalRow': _bool(raw.get('totalRow'), False),
    }


def _band(raw, name):
    raw = raw if isinstance(raw, dict) else {}
    els = raw.get('elements') or []
    if not isinstance(els, list):
        raise LayoutError(f'{name} band elements must be a list.')
    if len(els) > MAX_ELEMENTS_PER_BAND:
        raise LayoutError(f'Too many elements in the {name} band (max {MAX_ELEMENTS_PER_BAND}).')
    out_els = [_element(e, name) for e in els]
    ids = [e['id'] for e in out_els]
    if len(ids) != len(set(ids)):
        # Element ids must be unique inside a band; suffix duplicates instead of failing.
        seen = {}
        for e in out_els:
            n = seen.get(e['id'], 0)
            seen[e['id']] = n + 1
            if n:
                e['id'] = f"{e['id']}-{n}"
    return {
        'height': _num(raw.get('height'), 0, 600, 30),
        'elements': out_els,
        **({'bg': _color(raw.get('bg'))} if raw.get('bg') else {}),
    }


def validate_config(raw):
    """Return a cleaned schema-2 config, or raise LayoutError. Schema-1 (legacy section
    toggles) configs pass through unchanged — the legacy renderer owns their shape."""
    if not isinstance(raw, dict):
        raise LayoutError('Template config must be an object.')
    if raw.get('schema') != 2:
        return raw
    theme_raw = raw.get('theme') if isinstance(raw.get('theme'), dict) else {}
    theme = {
        'name': _str(theme_raw.get('name'), 40),
        'useBrand': _bool(theme_raw.get('useBrand'), False),
        'primary': _color(theme_raw.get('primary'), '#1d4ed8'),
        'accent': _color(theme_raw.get('accent'), '#0f172a'),
        'text': _color(theme_raw.get('text'), '#0f172a'),
        'muted': _color(theme_raw.get('muted'), '#64748b'),
        'border': _color(theme_raw.get('border'), '#cbd5e1'),
        'headerBg': _color(theme_raw.get('headerBg'), '#0f172a'),
        'headerText': _color(theme_raw.get('headerText'), '#ffffff'),
        'fontFamily': _font(theme_raw.get('fontFamily'), FONT_FAMILIES[0]) or FONT_FAMILIES[0],
        'fontSize': _num(theme_raw.get('fontSize'), 5, 20, 9),
        'lineHeight': _num(theme_raw.get('lineHeight'), 0.9, 2.5, 1.3),
    }
    fmt_raw = raw.get('format') if isinstance(raw.get('format'), dict) else {}
    fmt = {
        'currencySymbol': _str(fmt_raw.get('currencySymbol'), 6) if 'currencySymbol' in fmt_raw else '₹',
        'decimals': _int(fmt_raw.get('decimals'), 0, 4, 2),
        'dateFormat': _choice(fmt_raw.get('dateFormat'), DATE_FORMATS, 'DD-MM-YYYY'),
        'thousands': _choice(fmt_raw.get('thousands'), {'indian', 'international', 'none'}, 'indian'),
        'zeroAsDash': _bool(fmt_raw.get('zeroAsDash'), False),
    }
    page_raw = raw.get('page') if isinstance(raw.get('page'), dict) else {}
    page = {
        'headerOnEveryPage': _bool(page_raw.get('headerOnEveryPage'), False),
        'summaryAt': _choice(page_raw.get('summaryAt'), {'after-items', 'page-bottom'}, 'after-items'),
        'background': _color(page_raw.get('background'), ''),
    }
    bands_raw = raw.get('bands') if isinstance(raw.get('bands'), dict) else {}
    items_raw = bands_raw.get('items') if isinstance(bands_raw.get('items'), dict) else {}
    bands = {name: _band(bands_raw.get(name), name) for name in BANDS}
    bands['items'] = {
        'visible': _bool(items_raw.get('visible'), True),
        'marginTop': _num(items_raw.get('marginTop'), 0, 100, 2),
        'marginBottom': _num(items_raw.get('marginBottom'), 0, 100, 3),
        'table': _table(items_raw.get('table')),
    }
    return {'schema': 2, 'theme': theme, 'format': fmt, 'page': page, 'bands': bands}


# ---------------------------------------------------------------------------
# Compatibility
# ---------------------------------------------------------------------------

def _element_fields(el):
    out = set()
    if el.get('field'):
        out.add(el['field'])
    if el.get('visibleIf'):
        out.add(el['visibleIf'])
    for r in el.get('fields') or []:
        out.add(r.get('field'))
    if el.get('type') == 'text':
        out.update(TOKEN_RE.findall(el.get('text') or ''))
    if el.get('type') == 'totals':
        for r in el.get('rows') or []:
            out.add(f"totals.{r.get('key')}")
    return {f for f in out if f}


def used_fields(config):
    """(field ids, column keys, needs_items) a schema-2 config depends on."""
    fields, cols, needs_items = set(), set(), False
    bands = (config or {}).get('bands') or {}
    for name in BANDS:
        for el in (bands.get(name) or {}).get('elements') or []:
            if el.get('hidden'):
                continue
            fields |= _element_fields(el)
            if el.get('type') in ITEM_ELEMENT_TYPES:
                needs_items = True
    items = bands.get('items') or {}
    if items.get('visible', True):
        needs_items = True
        for c in (items.get('table') or {}).get('columns') or []:
            if c.get('visible', True):
                cols.add(c.get('key'))
    return fields, cols, needs_items


def compatible_document_types(config):
    """Document types this template can render without missing required data. Legacy
    (schema-1) templates adapt to every type."""
    if (config or {}).get('schema') != 2:
        return sorted(ALL_TYPES)
    fields, cols, needs_items = used_fields(config)
    allowed = set(ALL_TYPES)
    if needs_items:
        allowed &= ITEM_TYPES
    for f in fields:
        scope = FIELD_SCOPES.get(f)
        if scope is not None:
            allowed &= scope
    for c in cols:
        scope = COLUMN_SCOPES.get(c)
        if scope is not None:
            allowed &= scope
    return sorted(allowed)


def incompatibility_reason(config, document_type):
    """Human-readable reason a template can't render `document_type`, or ''."""
    if (config or {}).get('schema') != 2 or document_type in compatible_document_types(config):
        return ''
    fields, cols, needs_items = used_fields(config)
    if needs_items and document_type not in ITEM_TYPES:
        return 'it has an items table, and this document has no line items'
    for f in sorted(fields):
        scope = FIELD_SCOPES.get(f)
        if scope is not None and document_type not in scope:
            return f'it uses the field “{f}”, which this document does not have'
    for c in sorted(cols):
        scope = COLUMN_SCOPES.get(c)
        if scope is not None and document_type not in scope:
            return f'its items table shows the “{c}” column, which this document does not have'
    return 'its data requirements do not match this document'
