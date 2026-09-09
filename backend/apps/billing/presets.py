"""Canonical starter templates for the Bill & Invoice Designer.

These are seeded into the DB the first time the templates endpoint is hit on an empty
table (see views.ensure_seeded) — the same self-heal approach used for multi-branch.
The `config` shape here is the contract consumed by
frontend/src/billing/renderBillHtml.js; keep the two in sync.
"""

import copy


# ---------------------------------------------------------------------------
# Column + totals catalogs (labels are defaults; the editor can override them)
# ---------------------------------------------------------------------------

def _col(key, label, enabled=True, align='left'):
    return {'key': key, 'label': label, 'enabled': enabled, 'align': align}


STANDARD_COLUMNS = [
    _col('slno', 'Sl', True, 'center'),
    _col('name', 'Description', True, 'left'),
    _col('hsn', 'HSN', False, 'center'),
    _col('sku', 'SKU', False, 'left'),
    _col('barcode', 'Barcode', False, 'left'),
    _col('size', 'Size', False, 'center'),
    _col('color', 'Color', False, 'center'),
    _col('qty', 'Qty', True, 'center'),
    _col('unit', 'Unit', False, 'center'),
    _col('rate', 'Rate', True, 'right'),
    _col('discount', 'Disc', False, 'right'),
    _col('tax', 'Tax', True, 'right'),
    _col('total', 'Amount', True, 'right'),
]

JEWELLERY_COLUMNS = [
    _col('slno', 'Sl', True, 'center'),
    _col('name', 'Item', True, 'left'),
    _col('hsn', 'HSN', True, 'center'),
    _col('grossWeight', 'Gross Wt', True, 'right'),
    _col('netWeight', 'Net Wt', True, 'right'),
    _col('stoneWeight', 'Stone Wt', False, 'right'),
    _col('rate', 'Rate', True, 'right'),
    _col('makingCharge', 'Making', True, 'right'),
    _col('stoneCharge', 'Stone Chg', False, 'right'),
    _col('otherCharges', 'Other', False, 'right'),
    _col('qty', 'Qty', False, 'center'),
    _col('tax', 'Tax', True, 'right'),
    _col('total', 'Amount', True, 'right'),
]

WHOLESALE_COLUMNS = [
    _col('slno', 'Sl', True, 'center'),
    _col('name', 'Product', True, 'left'),
    _col('sku', 'SKU', True, 'left'),
    _col('hsn', 'HSN', False, 'center'),
    _col('qty', 'Qty', True, 'center'),
    _col('unit', 'Unit', False, 'center'),
    _col('rate', 'Rate', True, 'right'),
    _col('discount', 'Disc %', True, 'right'),
    _col('tax', 'Tax', True, 'right'),
    _col('total', 'Total', True, 'right'),
]

THERMAL_COLUMNS = [
    _col('name', 'Item', True, 'left'),
    _col('qty', 'Qty', True, 'center'),
    _col('rate', 'Rate', True, 'right'),
    _col('total', 'Amt', True, 'right'),
]

DEFAULT_TOTALS_ROWS = [
    'subtotal', 'discount', 'additionalDiscount', 'tax',
    'cgst', 'sgst', 'igst', 'shipping', 'otherCharges',
    'roundOff', 'grandTotal', 'paid', 'balance',
]


def _base_config(columns, overrides=None):
    cfg = {
        'styles': {
            'fontFamily': "'Segoe UI', Arial, sans-serif",
            'fontSizePx': 13,
            'textColor': '#0f172a',
            'accentColor': '#2563eb',
            'headingColor': '#0f172a',
            'lineHeight': 1.5,
            'letterSpacing': 0,
            'borderColor': '#e2e8f0',
        },
        'sections': [
            {'id': 'company', 'visible': True, 'config': {
                'showLogo': True, 'logoHeightPx': 54, 'logoAlign': 'left',
                'showName': True, 'nameSizePx': 26,
                'showTagline': True, 'showAddress': True, 'showPhone': True,
                'showEmail': True, 'showWebsite': False, 'showGstin': True,
                'showPan': False, 'layout': 'split', 'align': 'left',
            }},
            {'id': 'docTitle', 'visible': True, 'config': {
                'text': '', 'align': 'center', 'style': 'banner',
            }},
            {'id': 'meta', 'visible': True, 'config': {
                'fields': ['invoiceNumber', 'date', 'paymentStatus', 'salesperson'],
                'layout': 'grid',
            }},
            {'id': 'customer', 'visible': True, 'config': {
                'title': 'Bill To', 'showName': True, 'showPhone': True,
                'showAddress': True, 'showGstin': True, 'showEmail': False,
            }},
            {'id': 'items', 'visible': True, 'config': {
                'columns': columns, 'zebra': True, 'showBrandUnderName': True,
            }},
            {'id': 'totals', 'visible': True, 'config': {
                'rows': list(DEFAULT_TOTALS_ROWS), 'align': 'right', 'width': 'normal',
            }},
            {'id': 'payment', 'visible': True, 'config': {
                'showMethod': True, 'showPaid': True, 'showBalance': True,
                'showStatus': True, 'showBankDetails': False, 'bankDetails': '',
                'showUpiQr': False, 'upiId': '',
            }},
            {'id': 'barcode', 'visible': False, 'config': {
                'source': 'invoiceNumber', 'heightPx': 44, 'align': 'center',
            }},
            {'id': 'qr', 'visible': False, 'config': {
                'source': 'invoiceNumber', 'sizePx': 96, 'align': 'center', 'customText': '',
            }},
            {'id': 'footer', 'visible': True, 'config': {
                'thankYou': 'Thank you for your business!',
                'terms': '', 'notes': '', 'returnPolicy': '', 'warranty': '',
                'customerCare': '', 'showSignature': True,
                'signatureLabel': 'Authorized Signatory',
            }},
        ],
    }
    if overrides:
        _deep_merge(cfg, overrides)
    return cfg


def _deep_merge(target, patch):
    for k, v in patch.items():
        if isinstance(v, dict) and isinstance(target.get(k), dict):
            _deep_merge(target[k], v)
        else:
            target[k] = v


def _set_section(cfg, section_id, *, visible=None, config=None):
    for s in cfg['sections']:
        if s['id'] == section_id:
            if visible is not None:
                s['visible'] = visible
            if config:
                _deep_merge(s['config'], config)
            return


# ---------------------------------------------------------------------------
# The six starter templates
# ---------------------------------------------------------------------------

def _standard():
    return _base_config(copy.deepcopy(STANDARD_COLUMNS))


def _compact():
    cfg = _base_config(copy.deepcopy(STANDARD_COLUMNS))
    cfg['styles']['fontSizePx'] = 11
    _set_section(cfg, 'company', config={'nameSizePx': 20, 'showTagline': False,
                                         'showEmail': False, 'showPan': False})
    _set_section(cfg, 'docTitle', config={'style': 'plain'})
    _set_section(cfg, 'footer', config={'showSignature': False, 'terms': ''})
    return cfg


def _thermal(width_label):
    cfg = _base_config(copy.deepcopy(THERMAL_COLUMNS))
    cfg['styles']['fontFamily'] = "'Courier New', monospace"
    cfg['styles']['fontSizePx'] = 11 if width_label == '80mm' else 10
    _set_section(cfg, 'company', config={
        'layout': 'stacked', 'align': 'center', 'nameSizePx': 15,
        'logoAlign': 'center', 'logoHeightPx': 40, 'showEmail': False, 'showWebsite': False,
    })
    _set_section(cfg, 'docTitle', config={'style': 'plain', 'align': 'center'})
    _set_section(cfg, 'meta', config={'layout': 'rows',
                                      'fields': ['invoiceNumber', 'date', 'paymentStatus']})
    _set_section(cfg, 'customer', config={'showAddress': False, 'showGstin': False})
    _set_section(cfg, 'totals', config={'rows': ['subtotal', 'discount', 'tax',
                                                 'roundOff', 'grandTotal', 'paid', 'balance']})
    _set_section(cfg, 'qr', visible=True)
    _set_section(cfg, 'footer', config={'showSignature': False,
                                        'thankYou': 'Thank you! Visit again.'})
    return cfg


def _jewellery():
    cfg = _base_config(copy.deepcopy(JEWELLERY_COLUMNS))
    cfg['styles']['accentColor'] = '#b45309'
    cfg['styles']['headingColor'] = '#7c2d12'
    _set_section(cfg, 'company', config={'showTagline': True})
    _set_section(cfg, 'totals', config={'rows': ['subtotal', 'discount', 'cgst', 'sgst',
                                                 'roundOff', 'grandTotal', 'paid', 'balance']})
    _set_section(cfg, 'footer', config={
        'thankYou': 'Thank you for shopping with us.',
        'warranty': 'Hallmark / BIS certified. Exchange as per store policy.',
    })
    return cfg


def _wholesale():
    cfg = _base_config(copy.deepcopy(WHOLESALE_COLUMNS))
    _set_section(cfg, 'customer', config={'title': 'Billed To (Wholesale Buyer)',
                                          'showGstin': True, 'showAddress': True})
    _set_section(cfg, 'meta', config={'fields': ['invoiceNumber', 'date', 'dueDate',
                                                 'paymentStatus', 'salesperson']})
    _set_section(cfg, 'totals', config={'rows': ['subtotal', 'discount', 'tax',
                                                 'shipping', 'roundOff', 'grandTotal',
                                                 'paid', 'balance']})
    _set_section(cfg, 'footer', config={
        'terms': ('1. Goods once sold will not be taken back.\n'
                  '2. Payment due as per agreed credit terms.\n'
                  '3. Subject to local jurisdiction.'),
    })
    return cfg


PRESETS = [
    {
        'name': 'Standard Invoice', 'template_type': 'STANDARD',
        'description': 'Professional general-purpose A4 invoice.',
        'paper_size': 'A4', 'orientation': 'portrait',
        'margins': {'top': 15, 'right': 15, 'bottom': 15, 'left': 15},
        'is_default': True, 'config': _standard(),
    },
    {
        'name': 'Compact Invoice', 'template_type': 'COMPACT',
        'description': 'Simple, minimal, space-saving A5 invoice.',
        'paper_size': 'A5', 'orientation': 'portrait',
        'margins': {'top': 8, 'right': 8, 'bottom': 8, 'left': 8},
        'config': _compact(),
    },
    {
        'name': 'Thermal 80mm', 'template_type': 'THERMAL_80',
        'description': 'Optimised for 80mm thermal receipt printers. Auto height.',
        'paper_size': '80mm', 'orientation': 'portrait',
        'margins': {'top': 3, 'right': 3, 'bottom': 3, 'left': 3},
        'config': _thermal('80mm'),
    },
    {
        'name': 'Thermal 58mm', 'template_type': 'THERMAL_58',
        'description': 'Optimised for 58mm thermal receipt printers. Auto height.',
        'paper_size': '58mm', 'orientation': 'portrait',
        'margins': {'top': 2, 'right': 2, 'bottom': 2, 'left': 2},
        'config': _thermal('58mm'),
    },
    {
        'name': 'Jewellery Invoice', 'template_type': 'JEWELLERY',
        'description': 'Weight, making charge, stone charge and hallmark details.',
        'paper_size': 'A4', 'orientation': 'portrait',
        'margins': {'top': 12, 'right': 12, 'bottom': 12, 'left': 12},
        'config': _jewellery(),
    },
    {
        'name': 'Wholesale Invoice', 'template_type': 'WHOLESALE',
        'description': 'SKU, quantity, wholesale rate, discount and totals.',
        'paper_size': 'A4', 'orientation': 'portrait',
        'margins': {'top': 12, 'right': 12, 'bottom': 12, 'left': 12},
        'config': _wholesale(),
    },
]

# Which starter template each document type points at initially.
DEFAULT_ASSIGNMENTS = {
    'SALES_INVOICE': 'Standard Invoice',
    'WHOLESALE_BILL': 'Wholesale Invoice',
    'ORDER_BILL': 'Standard Invoice',
    'PURCHASE_BILL': 'Standard Invoice',
    'RETURN_BILL': 'Compact Invoice',
    'QUOTATION': 'Standard Invoice',
    'PAYMENT_RECEIPT': 'Compact Invoice',
}
