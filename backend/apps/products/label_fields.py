"""Barcode label designer: dynamic field catalog, value resolution and layout validation.

A label template never stores product values — only *which* field goes where and how it
looks. Values are resolved here from the real Product / ProductVariantGroup / Company rows
at preview or print time. The frontend mirrors this catalog in
frontend/src/labels/labelFields.js; this module is the authority the API validates against.
"""
import re
from decimal import Decimal, InvalidOperation

# ---------------------------------------------------------------------------
# Field catalog
# ---------------------------------------------------------------------------
# source: product -> resolved from the Product row; store -> Company / billing branding;
#         job -> typed per print batch (purchase-entry batch/expiry, offer price, date).
# kind:   text | price | date
# restricted: financial values only privileged roles may place on a label or receive.
LABEL_FIELDS = [
    {'id': 'product_name', 'label': 'Product name', 'source': 'product', 'kind': 'text'},
    {'id': 'brand', 'label': 'Brand', 'source': 'product', 'kind': 'text'},
    {'id': 'model_number', 'label': 'Model number', 'source': 'product', 'kind': 'text'},
    {'id': 'sku', 'label': 'SKU / Product code', 'source': 'product', 'kind': 'text'},
    {'id': 'barcode', 'label': 'Barcode number', 'source': 'product', 'kind': 'text'},
    {'id': 'selling_price', 'label': 'Selling price', 'source': 'product', 'kind': 'price'},
    {'id': 'mrp', 'label': 'MRP', 'source': 'product', 'kind': 'price'},
    {'id': 'colour', 'label': 'Colour', 'source': 'product', 'kind': 'text'},
    {'id': 'size', 'label': 'Size', 'source': 'product', 'kind': 'text'},
    {'id': 'variant', 'label': 'Variant (all attributes)', 'source': 'product', 'kind': 'text'},
    {'id': 'frame_type', 'label': 'Frame type', 'source': 'product', 'kind': 'text'},
    {'id': 'category', 'label': 'Category', 'source': 'product', 'kind': 'text'},
    {'id': 'sub_category', 'label': 'Sub-category', 'source': 'product', 'kind': 'text'},
    {'id': 'hsn_code', 'label': 'HSN code', 'source': 'product', 'kind': 'text'},
    {'id': 'rack_location', 'label': 'Rack location', 'source': 'product', 'kind': 'text'},
    {'id': 'supplier_name', 'label': 'Supplier', 'source': 'product', 'kind': 'text'},
    {'id': 'wholesale_price', 'label': 'Wholesale price', 'source': 'product', 'kind': 'price', 'restricted': True},
    {'id': 'cost_price', 'label': 'Purchase cost', 'source': 'product', 'kind': 'price', 'restricted': True},
    {'id': 'store_name', 'label': 'Store name', 'source': 'store', 'kind': 'text'},
    {'id': 'store_phone', 'label': 'Store phone', 'source': 'store', 'kind': 'text'},
    {'id': 'batch_no', 'label': 'Batch no', 'source': 'job', 'kind': 'text'},
    {'id': 'expiry_date', 'label': 'Expiry date', 'source': 'job', 'kind': 'date'},
    {'id': 'offer_price', 'label': 'Offer price', 'source': 'job', 'kind': 'price'},
    {'id': 'print_date', 'label': 'Print date', 'source': 'job', 'kind': 'date'},
]
FIELD_IDS = {f['id'] for f in LABEL_FIELDS}
RESTRICTED_FIELD_IDS = {f['id'] for f in LABEL_FIELDS if f.get('restricted')}

# Roles allowed to design with / receive restricted pricing. Matches User.ROLE_CHOICES.
PRICING_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER', 'ACCOUNTANT'}
# Roles allowed to create / change label templates and print settings.
DESIGNER_ROLES = {'SUPER_ADMIN', 'ADMINISTRATOR', 'MANAGER', 'INVENTORY_MANAGER', 'PURCHASE_EXECUTIVE'}


def user_role(user):
    if not user or not getattr(user, 'is_authenticated', False):
        return ''
    if getattr(user, 'is_superuser', False):
        return 'SUPER_ADMIN'
    return (getattr(user, 'role', '') or '').upper()


def can_see_restricted(user):
    return user_role(user) in PRICING_ROLES


def can_design(user):
    return user_role(user) in DESIGNER_ROLES


def field_catalog(user):
    allowed = can_see_restricted(user)
    return [dict(f, allowed=(allowed or not f.get('restricted'))) for f in LABEL_FIELDS]


# ---------------------------------------------------------------------------
# Value resolution
# ---------------------------------------------------------------------------
def _clean(v):
    if v is None:
        return ''
    s = str(v).strip()
    return '' if s.lower() in ('none', 'null', 'nan') else s


def _extra(product, *keys):
    data = product.extra_data if isinstance(product.extra_data, dict) else {}
    lowered = {str(k).lower(): v for k, v in data.items()}
    for key in keys:
        val = _clean(lowered.get(key.lower()))
        if val:
            return val
    return ''


def _money(v):
    """Positive decimal as a plain string, '' when absent / zero (zero is never a real
    shelf price — printing ₹0.00 would be misleading)."""
    if v in (None, ''):
        return ''
    try:
        d = Decimal(str(v).replace(',', '').replace('₹', '').strip())
    except (InvalidOperation, ValueError):
        return ''
    return f"{d:.2f}" if d > 0 else ''


def resolve_product_fields(product, include_restricted=False):
    """Every product-sourced field id -> display string ('' when genuinely missing)."""
    group = product.variant_group if product.variant_group_id else None
    attrs = product.variant_attributes if isinstance(product.variant_attributes, dict) else {}
    colour = _clean(product.color) or _clean(attrs.get('color')) or _extra(product, 'color', 'colour', 'color_code')
    size = _clean(product.size) or _clean(attrs.get('size')) or _extra(product, 'size', 'frame_size')
    variant = ' / '.join(_clean(v) for v in attrs.values() if _clean(v)) or ' / '.join(x for x in (colour, size) if x)
    values = {
        'product_name': _clean(product.name),
        'brand': _clean(product.brand_name) or (_clean(product.brand.name) if product.brand_id and product.brand else ''),
        'model_number': _extra(product, 'model_no', 'model_number', 'model') or (_clean(group.model_number) if group else ''),
        'sku': _clean(product.sku),
        'barcode': _clean(product.barcode),
        'selling_price': _money(product.retail_price),
        # MRP is captured only by the variant master / import into extra_data. No
        # fallback to another price column: a guessed MRP would be a misleading label.
        'mrp': _money(_extra(product, 'mrp')),
        'colour': colour,
        'size': size,
        'variant': variant,
        'frame_type': _clean(product.frame_type) or _extra(product, 'frame_type', 'frametype'),
        'category': _clean(product.category_name) or (_clean(product.category.name) if product.category_id and product.category else ''),
        'sub_category': _extra(product, 'sub_category') or (_clean(group.sub_category) if group else ''),
        'hsn_code': _clean(product.hsn_code),
        'rack_location': _clean(product.rack_location),
        'supplier_name': _clean(product.supplier_name),
    }
    values['internal_code'] = short_internal_code(product)
    if include_restricted:
        values['wholesale_price'] = _money(product.wholesale_price)
        values['cost_price'] = _money(product.cost_price)
    return values


def short_internal_code(product):
    """A short numeric scan code already mapped to this product — its own barcode when that
    is ≤ 13 digits, else the first code of its persisted label series (ProductBarcode).
    Never invents or changes anything; '' when none exists yet (the print job mints one
    through label_barcode_series)."""
    own = _clean(product.barcode)
    if own.isdigit() and len(own) <= 13:
        return own
    # .all() so a prefetch_related('extra_barcodes') in the caller is used
    for extra in sorted(product.extra_barcodes.all(), key=lambda x: x.created_at):
        if extra.code.isdigit() and len(extra.code) <= 13:
            return extra.code
    return ''


def resolve_store_fields():
    from apps.company.models import Company
    from apps.billing.models import BillingSettings
    company = Company.objects.order_by('created_at').first()
    logo = ''
    try:
        logo = BillingSettings.load().logo_data_url or ''
    except Exception:
        logo = ''
    return {
        'store_name': _clean(company.display_name or company.name) if company else '',
        'store_phone': _clean(company.phone) if company else '',
        'logo': logo,
    }


# ---------------------------------------------------------------------------
# Layout validation
# ---------------------------------------------------------------------------
PRINTER_TYPES = ('thermal', 'a4')
ELEMENT_TYPES = ('field', 'text', 'barcode', 'qr', 'line', 'rect', 'logo')
BARCODE_FORMATS = ('CODE128', 'CODE39', 'EAN13', 'EAN8', 'UPC', 'UPCE')
ALIGN = ('left', 'center', 'right')
VALIGN = ('top', 'middle', 'bottom')
OVERFLOW = ('ellipsis', 'clip', 'wrap', 'shrink')
FALLBACK = ('hide', 'blank', 'text', 'field')
PRICE_FORMATS = ('currency', 'currency0', 'number')
FONT_FAMILIES = ('Arial', 'Helvetica', 'Verdana', 'Tahoma', 'Courier New', 'Times New Roman')
FONT_WEIGHTS = (400, 600, 700, 800)
HEX = re.compile(r'^#[0-9a-fA-F]{6}$')
ELEMENT_ID = re.compile(r'^[A-Za-z0-9_-]{1,40}$')
A4_W, A4_H = 210.0, 297.0
MAX_ELEMENTS = 80


class LayoutError(ValueError):
    pass


def _num(v, lo, hi, name, default=None):
    if v in (None, '') and default is not None:
        return default
    try:
        n = float(v)
    except (TypeError, ValueError):
        raise LayoutError(f"{name} must be a number.")
    if n != n or n < lo or n > hi:  # NaN or out of range
        raise LayoutError(f"{name} must be between {lo:g} and {hi:g}.")
    return round(n, 3)


def _choice(v, options, name, default):
    if v in (None, ''):
        return default
    if v not in options:
        raise LayoutError(f"{name} must be one of: {', '.join(str(o) for o in options)}.")
    return v


def _text(v, name, max_len=200):
    s = '' if v is None else str(v)
    if len(s) > max_len:
        raise LayoutError(f"{name} is longer than {max_len} characters.")
    return s


def validate_template(printer_type, width_mm, height_mm, layout, allow_restricted):
    """Validates and normalises a template. Returns (width, height, clean_layout); raises
    LayoutError with a human message. Unknown keys are dropped so nothing arbitrary (CSS,
    markup, script) is ever persisted — the renderer only consumes whitelisted values."""
    _choice(printer_type, PRINTER_TYPES, 'Printer type', 'thermal')
    w = _num(width_mm, 10, 200, 'Label width (mm)')
    h = _num(height_mm, 5, 300, 'Label height (mm)')
    if not isinstance(layout, dict):
        raise LayoutError('Layout must be an object.')

    clean = {
        'schema': 1,
        'paddingMm': _num(layout.get('paddingMm'), 0, 10, 'Safe margin (mm)', 1),
        'gapMm': _num(layout.get('gapMm'), 0, 30, 'Label gap (mm)', 0),
        'defaultBarcodeFormat': _choice(layout.get('defaultBarcodeFormat'), BARCODE_FORMATS, 'Barcode format', 'CODE128'),
    }

    if printer_type == 'a4':
        s = layout.get('sheet') or {}
        if not isinstance(s, dict):
            raise LayoutError('Sheet layout must be an object.')
        sheet = {
            'cols': int(_num(s.get('cols'), 1, 20, 'Columns', 3)),
            'rows': int(_num(s.get('rows'), 1, 60, 'Rows', 8)),
            'marginTopMm': _num(s.get('marginTopMm'), 0, 60, 'Top margin (mm)', 10),
            'marginLeftMm': _num(s.get('marginLeftMm'), 0, 60, 'Left margin (mm)', 7),
            'colGapMm': _num(s.get('colGapMm'), 0, 40, 'Column gap (mm)', 0),
            'rowGapMm': _num(s.get('rowGapMm'), 0, 40, 'Row gap (mm)', 0),
        }
        used_w = sheet['marginLeftMm'] + sheet['cols'] * w + (sheet['cols'] - 1) * sheet['colGapMm']
        used_h = sheet['marginTopMm'] + sheet['rows'] * h + (sheet['rows'] - 1) * sheet['rowGapMm']
        if used_w > A4_W + 0.5 or used_h > A4_H + 0.5:
            raise LayoutError(
                f"The sheet layout needs {used_w:.1f} × {used_h:.1f} mm but A4 is {A4_W:g} × {A4_H:g} mm. "
                'Reduce the columns / rows, label size, gaps or margins.'
            )
        clean['sheet'] = sheet

    elements = layout.get('elements') or []
    if not isinstance(elements, list):
        raise LayoutError('Elements must be a list.')
    if len(elements) > MAX_ELEMENTS:
        raise LayoutError(f"A label can have at most {MAX_ELEMENTS} elements.")

    seen = set()
    out = []
    for i, el in enumerate(elements):
        if not isinstance(el, dict):
            raise LayoutError(f"Element {i + 1} is not an object.")
        out.append(_validate_element(el, i, w, h, seen, allow_restricted))
    clean['elements'] = out
    return w, h, clean


def _validate_element(el, i, w, h, seen, allow_restricted):
    tag = f"Element {i + 1}"
    eid = str(el.get('id') or '')
    if not ELEMENT_ID.match(eid):
        raise LayoutError(f"{tag}: invalid id.")
    if eid in seen:
        raise LayoutError(f"{tag}: duplicate id “{eid}”.")
    seen.add(eid)
    etype = _choice(el.get('type'), ELEMENT_TYPES, f"{tag} type", None)
    if etype is None:
        raise LayoutError(f"{tag}: type is required.")

    # Positions may sit partly off the label while designing (the editor warns), but are
    # bounded so a corrupt value can't produce a giant print page.
    e = {
        'id': eid,
        'type': etype,
        'name': _text(el.get('name'), f"{tag} name", 60),
        'x': _num(el.get('x'), -w, 2 * w, f"{tag} X (mm)", 0),
        'y': _num(el.get('y'), -h, 2 * h, f"{tag} Y (mm)", 0),
        'w': _num(el.get('w'), 0.2, 2 * w, f"{tag} width (mm)", 10),
        'h': _num(el.get('h'), 0.1, 2 * h, f"{tag} height (mm)", 4),
        'rotation': int(_choice(el.get('rotation') or 0, (0, 90, 180, 270), f"{tag} rotation", 0)),
        'hidden': bool(el.get('hidden')),
        'locked': bool(el.get('locked')),
    }

    if etype in ('field', 'text'):
        e['style'] = _validate_text_style(el.get('style') or {}, tag)
    if etype == 'field':
        field = el.get('field')
        if field not in FIELD_IDS:
            raise LayoutError(f"{tag}: unknown field “{field}”.")
        if field in RESTRICTED_FIELD_IDS and not allow_restricted:
            raise LayoutError(f"{tag}: you are not allowed to place restricted pricing (“{field}”) on labels.")
        fb = el.get('fallback') or {}
        fallback = {'mode': _choice(fb.get('mode'), FALLBACK, f"{tag} fallback", 'hide')}
        if fallback['mode'] == 'text':
            fallback['text'] = _text(fb.get('text'), f"{tag} fallback text", 60)
        if fallback['mode'] == 'field':
            ff = fb.get('field')
            if ff not in FIELD_IDS:
                raise LayoutError(f"{tag}: unknown fallback field “{ff}”.")
            if ff in RESTRICTED_FIELD_IDS and not allow_restricted:
                raise LayoutError(f"{tag}: restricted fallback field “{ff}”.")
            fallback['field'] = ff
        e.update({
            'field': field,
            'prefix': _text(el.get('prefix'), f"{tag} prefix", 40),
            'suffix': _text(el.get('suffix'), f"{tag} suffix", 40),
            'priceFormat': _choice(el.get('priceFormat'), PRICE_FORMATS, f"{tag} price format", 'currency'),
            'required': bool(el.get('required')),
            'fallback': fallback,
        })
    elif etype == 'text':
        e['text'] = _text(el.get('text'), f"{tag} text", 200)
    elif etype == 'barcode':
        b = el.get('barcode') or {}
        source = el.get('field') or 'barcode'
        if source not in ('barcode', 'sku'):
            raise LayoutError(f"{tag}: a barcode can encode the barcode number or the SKU only.")
        e.update({
            'field': source,
            'barcode': {
                'format': _choice(b.get('format'), ('inherit',) + BARCODE_FORMATS, f"{tag} format", 'inherit'),
                'showText': bool(b.get('showText', True)),
                'textSizePt': _num(b.get('textSizePt'), 3, 24, f"{tag} text size", 6),
                'quietZoneMm': _num(b.get('quietZoneMm'), 0, 10, f"{tag} quiet zone", 1.5),
                'moduleMm': _num(b.get('moduleMm'), 0, 1, f"{tag} bar width", 0),
                'align': _choice(b.get('align'), ALIGN, f"{tag} align", 'center'),
                # 'internal' = when the code is too long to scan at this size, print the
                # product's short internal scan code (ProductBarcode) instead.
                'whenTooLong': _choice(b.get('whenTooLong'), ('warn', 'internal'), f"{tag} too-long rule", 'warn'),
            },
        })
    elif etype == 'qr':
        source = el.get('field') or 'barcode'
        if source not in ('barcode', 'sku', 'product_name'):
            raise LayoutError(f"{tag}: QR source must be the barcode, SKU or product name.")
        e['field'] = source
    elif etype in ('line', 'rect'):
        e['strokeMm'] = _num(el.get('strokeMm'), 0.05, 3, f"{tag} line thickness", 0.25)
        e['color'] = el.get('color') if HEX.match(str(el.get('color') or '')) else '#000000'
        if etype == 'rect':
            e['fill'] = bool(el.get('fill'))
            e['radiusMm'] = _num(el.get('radiusMm'), 0, 20, f"{tag} corner radius", 0)
    elif etype == 'logo':
        e['fit'] = _choice(el.get('fit'), ('contain', 'cover'), f"{tag} fit", 'contain')
    return e


def _validate_text_style(s, tag):
    if not isinstance(s, dict):
        raise LayoutError(f"{tag}: style must be an object.")
    color = s.get('color') or '#000000'
    if not HEX.match(str(color)):
        raise LayoutError(f"{tag}: colour must be a hex value like #000000.")
    weight = s.get('fontWeight') or 400
    try:
        weight = int(weight)
    except (TypeError, ValueError):
        raise LayoutError(f"{tag}: invalid font weight.")
    return {
        'fontFamily': _choice(s.get('fontFamily'), FONT_FAMILIES, f"{tag} font", 'Arial'),
        'fontSizePt': _num(s.get('fontSizePt'), 3, 72, f"{tag} font size (pt)", 7),
        'fontWeight': _choice(weight, FONT_WEIGHTS, f"{tag} font weight", 400),
        'italic': bool(s.get('italic')),
        'uppercase': bool(s.get('uppercase')),
        'align': _choice(s.get('align'), ALIGN, f"{tag} alignment", 'left'),
        'vAlign': _choice(s.get('vAlign'), VALIGN, f"{tag} vertical alignment", 'middle'),
        'overflow': _choice(s.get('overflow'), OVERFLOW, f"{tag} overflow", 'ellipsis'),
        'maxLines': int(_num(s.get('maxLines'), 1, 10, f"{tag} max lines", 2)),
        'letterSpacingMm': _num(s.get('letterSpacingMm'), -1, 3, f"{tag} letter spacing", 0),
        'color': color,
        'invert': bool(s.get('invert')),
    }


def layout_uses_restricted(layout):
    for el in (layout or {}).get('elements') or []:
        if el.get('field') in RESTRICTED_FIELD_IDS:
            return True
        if (el.get('fallback') or {}).get('field') in RESTRICTED_FIELD_IDS:
            return True
    return False
