"""Starter barcode label templates, seeded into an empty LabelTemplate table and used by
"Restore Default" / "New from preset". They recreate the label looks the fixed renderers
in frontend/src/utils/printBarcodeLabels.js used to print (jewel card, standard stacked,
rat-tail, dumbbell) as ordinary, fully editable element layouts. All units are mm, font
sizes are pt."""
import copy


def _style(size, weight=400, align='left', overflow='ellipsis', upper=False, max_lines=2, valign='middle'):
    return {
        'fontFamily': 'Arial', 'fontSizePt': size, 'fontWeight': weight, 'italic': False,
        'uppercase': upper, 'align': align, 'vAlign': valign, 'overflow': overflow,
        'maxLines': max_lines, 'letterSpacingMm': 0, 'color': '#000000', 'invert': False,
    }


def field(eid, f, x, y, w, h, size, weight=400, align='left', prefix='', overflow='ellipsis',
          upper=False, max_lines=2, fallback='hide', required=False, price_format='currency'):
    return {
        'id': eid, 'type': 'field', 'name': '', 'field': f, 'x': x, 'y': y, 'w': w, 'h': h,
        'rotation': 0, 'hidden': False, 'locked': False, 'prefix': prefix, 'suffix': '',
        'priceFormat': price_format, 'required': required, 'fallback': {'mode': fallback},
        'style': _style(size, weight, align, overflow, upper, max_lines),
    }


def text(eid, value, x, y, w, h, size, weight=400, align='left'):
    return {
        'id': eid, 'type': 'text', 'name': '', 'text': value, 'x': x, 'y': y, 'w': w, 'h': h,
        'rotation': 0, 'hidden': False, 'locked': False, 'style': _style(size, weight, align),
    }


def barcode(eid, x, y, w, h, show_text=True, text_pt=6, quiet=1.5, align='center'):
    return {
        'id': eid, 'type': 'barcode', 'name': '', 'field': 'barcode', 'x': x, 'y': y, 'w': w, 'h': h,
        'rotation': 0, 'hidden': False, 'locked': False,
        'barcode': {'format': 'inherit', 'showText': show_text, 'textSizePt': text_pt,
                    'quietZoneMm': quiet, 'moduleMm': 0, 'align': align},
    }


def line(eid, x, y, w, h=0.25, stroke=0.25):
    return {'id': eid, 'type': 'line', 'name': '', 'x': x, 'y': y, 'w': w, 'h': h, 'rotation': 0,
            'hidden': False, 'locked': False, 'strokeMm': stroke, 'color': '#000000'}


def rect(eid, x, y, w, h, stroke=0.25, radius=0):
    return {'id': eid, 'type': 'rect', 'name': '', 'x': x, 'y': y, 'w': w, 'h': h, 'rotation': 0,
            'hidden': False, 'locked': False, 'strokeMm': stroke, 'color': '#000000',
            'fill': False, 'radiusMm': radius}


def _layout(elements, padding=1, gap=0, sheet=None, fmt='CODE128'):
    out = {'schema': 1, 'paddingMm': padding, 'gapMm': gap, 'defaultBarcodeFormat': fmt, 'elements': elements}
    if sheet:
        out['sheet'] = sheet
    return out


PRESETS = [
    {
        'preset_key': 'jewel_card_38x25',
        'name': 'Jewel Card 38 × 25 mm',
        'description': 'Shop name, product, price, colour / size over a full-width barcode. The default.',
        'printer_type': 'thermal', 'width_mm': 38, 'height_mm': 25, 'is_default': True,
        'layout': _layout([
            rect('frame', 0.3, 0.3, 37.4, 24.4, 0.2),
            field('shop', 'store_name', 1.4, 0.9, 35.2, 2.4, 5, 800, upper=True),
            line('rule1', 1.4, 3.5, 35.2),
            field('name', 'product_name', 1.4, 3.9, 35.2, 4.8, 6.5, 800, overflow='wrap', max_lines=2),
            field('price', 'selling_price', 1.4, 8.8, 35.2, 3, 7.5, 800, prefix='PRICE '),
            field('colour', 'colour', 1.4, 11.8, 17, 2.4, 5.5, prefix='COLOUR '),
            field('size', 'size', 19, 11.8, 17.6, 2.4, 5.5, prefix='SIZE '),
            line('rule2', 1.4, 14.5, 35.2),
            barcode('code', 1.4, 15, 35.2, 9.2, text_pt=6),
        ]),
    },
    {
        'preset_key': 'standard_50x25',
        'name': 'Standard 50 × 25 mm',
        'description': 'Centred, stacked: shop, product, barcode, price.',
        'printer_type': 'thermal', 'width_mm': 50, 'height_mm': 25,
        'layout': _layout([
            field('shop', 'store_name', 1, 0.8, 48, 2.6, 6, 700, 'center'),
            field('name', 'product_name', 1, 3.4, 48, 3, 7, 700, 'center'),
            barcode('code', 2, 6.6, 46, 12),
            field('price', 'selling_price', 1, 19, 48, 3.4, 9, 800, 'center', prefix='Price '),
            field('colour', 'colour', 1, 22.4, 23.5, 2.2, 5, prefix='Colour '),
            field('size', 'size', 25.5, 22.4, 23.5, 2.2, 5, align='right', prefix='Size '),
        ]),
    },
    {
        'preset_key': 'optical_frame_50x30',
        'name': 'Optical Frame 50 × 30 mm',
        'description': 'Brand, model, colour and size for frames, with MRP and selling price.',
        'printer_type': 'thermal', 'width_mm': 50, 'height_mm': 30,
        'layout': _layout([
            field('brand', 'brand', 1.2, 0.8, 30, 3.4, 9, 800, upper=True),
            field('shop', 'store_name', 31, 0.8, 17.8, 3.4, 5, 700, 'right'),
            field('model', 'model_number', 1.2, 4.2, 30, 2.6, 6.5, 700, prefix='Model '),
            field('variant', 'variant', 1.2, 6.8, 47.6, 2.6, 6, prefix=''),
            field('mrp', 'mrp', 1.2, 9.6, 23, 3, 7, 700, prefix='MRP '),
            field('price', 'selling_price', 24.6, 9.2, 24.2, 3.6, 9, 800, 'right', prefix='₹ ', price_format='number'),
            line('rule', 1.2, 13.2, 47.6),
            barcode('code', 2, 13.8, 46, 15.4, text_pt=7),
        ]),
    },
    {
        'preset_key': 'rattail_90x13',
        'name': 'Jewellery Rat-Tail 90 × 13 mm',
        'description': 'Barcode panel + price/details panel + 40 mm blank tail (threads through the item).',
        'printer_type': 'thermal', 'width_mm': 90, 'height_mm': 13,
        'layout': _layout([
            barcode('code', 0.6, 0.8, 21, 11.4, show_text=False, quiet=0.8),
            field('shop', 'store_name', 23, 0.5, 26, 1.9, 4, 800, upper=True),
            field('name', 'product_name', 23, 2.4, 26, 2.1, 4.5, 700),
            field('price', 'selling_price', 23, 4.5, 26, 2.6, 6, 800, prefix='PRICE '),
            field('colour', 'colour', 23, 7.1, 13, 1.9, 4.2, prefix='COL '),
            field('size', 'size', 36, 7.1, 13, 1.9, 4.2, prefix='SIZE '),
            field('codeTxt', 'barcode', 23, 9.1, 26, 2, 4.5, 700),
        ], padding=0.5),
    },
    {
        'preset_key': 'a4_24up',
        'name': 'A4 Sheet — 24 labels (63.5 × 33.9 mm)',
        'description': '3 × 8 labels per A4 sheet.',
        'printer_type': 'a4', 'width_mm': 63.5, 'height_mm': 33.9,
        'layout': _layout([
            field('shop', 'store_name', 2, 1.4, 59.5, 3, 7, 800, 'center', upper=True),
            field('name', 'product_name', 2, 4.6, 59.5, 5.4, 8, 700, 'center', overflow='wrap'),
            barcode('code', 4, 10.4, 55.5, 14, text_pt=7),
            field('price', 'selling_price', 2, 25, 30, 4.4, 10, 800, prefix='₹ ', price_format='number'),
            field('variant', 'variant', 32, 25.4, 29.5, 3.6, 6.5, align='right'),
            field('sku', 'sku', 2, 29.6, 59.5, 3, 6, align='center', prefix='SKU '),
        ], padding=1.5, sheet={'cols': 3, 'rows': 8, 'marginTopMm': 10.7, 'marginLeftMm': 7.2,
                                'colGapMm': 2.5, 'rowGapMm': 0}),
    },
    {
        'preset_key': 'a4_65up',
        'name': 'A4 Sheet — 65 labels (38.1 × 21.2 mm)',
        'description': '5 × 13 small labels per A4 sheet.',
        'printer_type': 'a4', 'width_mm': 38.1, 'height_mm': 21.2,
        'layout': _layout([
            field('name', 'product_name', 1, 0.8, 36.1, 2.6, 6, 700, 'center'),
            barcode('code', 1.2, 3.6, 35.7, 12.4, text_pt=5.5, quiet=1),
            field('price', 'selling_price', 1, 16.4, 36.1, 3.6, 8, 800, 'center', prefix='₹ ', price_format='number'),
        ], padding=0.8, sheet={'cols': 5, 'rows': 13, 'marginTopMm': 10.7, 'marginLeftMm': 4.8,
                                'colGapMm': 2.5, 'rowGapMm': 0}),
    },
    {
        'preset_key': 'a4_dumbbell_92x14',
        'name': 'A4 Jewellery Dumbbell 92 × 14.5 mm',
        'description': 'Barcode wing + non-adhesive tie bridge + price wing; 2 × 19 per sheet.',
        'printer_type': 'a4', 'width_mm': 92, 'height_mm': 14.5,
        'layout': _layout([
            barcode('code', 1, 0.8, 35.5, 12.9, text_pt=5, quiet=1),
            line('bridgeL', 37.7, 0.5, 0.3, 13.5, 0.25),
            text('bridgeTxt', 'TIE · NON-ADHESIVE', 38.3, 6.4, 15.4, 1.8, 3.5, 400, 'center'),
            line('bridgeR', 54, 0.5, 0.3, 13.5, 0.25),
            field('shop', 'store_name', 55.5, 0.8, 35.5, 2.2, 4.8, 700),
            field('name', 'product_name', 55.5, 3, 35.5, 3.6, 5.5, 700, overflow='wrap'),
            field('price', 'selling_price', 55.5, 6.7, 35.5, 3, 7, 800, prefix='₹ ', price_format='number'),
            field('variant', 'variant', 55.5, 9.8, 35.5, 2, 4.8),
            field('offer', 'offer_price', 55.5, 11.8, 35.5, 2, 4.8, 700, prefix='Offer '),
        ], padding=0.5, sheet={'cols': 2, 'rows': 19, 'marginTopMm': 10, 'marginLeftMm': 12,
                                'colGapMm': 6, 'rowGapMm': 0}),
    },
]

PRESETS_BY_KEY = {p['preset_key']: p for p in PRESETS}


def preset_spec(key):
    p = PRESETS_BY_KEY.get(key)
    return copy.deepcopy(p) if p else None
