"""Starter templates for the visual (schema 2) Bill & Invoice Designer.

Every value printed comes from a bound data field (bill_fields.FIELD_IDS) — these layouts
hold positions and styling only. Units: millimetres for geometry (relative to the page's
content box, i.e. inside the margins), points for font sizes.

Each preset has a stable `preset_key`; "Restore Default" resets a template to the preset it
was created from, and views.ensure_seeded() adds any preset that is missing.
"""
import copy

from .bill_fields import validate_config

PRESET_GENERATION = 2  # bump when presets are added so existing installs receive them


def E(eid, etype, x, y, w, h, style=None, **kw):
    el = {'id': eid, 'type': etype, 'x': x, 'y': y, 'w': w, 'h': h, 'style': style or {}}
    el.update(kw)
    return el


def col(key, label, width, align='left', visible=True, **kw):
    return {'key': key, 'label': label, 'width': width, 'align': align, 'visible': visible, **kw}


def theme(**over):
    t = {
        'name': 'Classic Blue', 'useBrand': False,
        'primary': '#1d4ed8', 'accent': '#0f172a', 'text': '#0f172a', 'muted': '#64748b',
        'border': '#cbd5e1', 'headerBg': '#0f172a', 'headerText': '#ffffff',
        'fontFamily': "'Segoe UI', Arial, sans-serif", 'fontSize': 9, 'lineHeight': 1.3,
    }
    t.update(over)
    return t


def fmt(**over):
    f = {'currencySymbol': '₹', 'decimals': 2, 'dateFormat': 'DD-MM-YYYY', 'thousands': 'indian', 'zeroAsDash': False}
    f.update(over)
    return f


def table(columns, **over):
    t = {
        'columns': columns,
        'headerStyle': {'bg': '#0f172a', 'color': '#ffffff', 'fontSize': 8, 'fontWeight': 700},
        'bodyStyle': {'fontSize': 8.5},
        'rowPadding': 1.6, 'cellPadX': 1.3, 'currencyInTable': True, 'zebra': True, 'zebraColor': '#f8fafc', 'borders': 'rows',
        'borderColor': '#cbd5e1', 'repeatHeader': True, 'fillPage': False,
        'showBrand': True, 'showPower': True, 'showVariant': True, 'showSku': False,
        'emptyText': 'No items', 'totalRow': False,
    }
    t.update(over)
    return t


def config(header, summary, footer, items=None, *, header_h, summary_h, footer_h,
           theme_over=None, fmt_over=None, page=None):
    return {
        'schema': 2,
        'theme': theme(**(theme_over or {})),
        'format': fmt(**(fmt_over or {})),
        'page': {'headerOnEveryPage': False, 'summaryAt': 'after-items', 'background': '', **(page or {})},
        'bands': {
            'header': {'height': header_h, 'elements': header},
            'items': items or {'visible': False, 'marginTop': 0, 'marginBottom': 0, 'table': table([])},
            'summary': {'height': summary_h, 'elements': summary},
            'footer': {'height': footer_h, 'elements': footer},
        },
    }


def items_band(columns, mt=2, mb=3, **table_over):
    return {'visible': True, 'marginTop': mt, 'marginBottom': mb, 'table': table(columns, **table_over)}


# ---------------------------------------------------------------------------
# Re-usable blocks
# ---------------------------------------------------------------------------

LABEL = {'color': '#64748b', 'fontWeight': 600}
BOXED = {'borderWidth': 0.3, 'borderColor': '#cbd5e1', 'borderSides': 'all', 'radius': 1.5, 'padding': 2, 'bg': '#f8fafc'}


def meta_list(eid, x, y, w, h, rows, label_w=24, align='left'):
    return E(eid, 'fieldList', x, y, w, h, {'fontSize': 8.5, 'align': align},
             fields=[{'field': f, 'label': lbl} for f, lbl in rows], layout='rows', labelWidth=label_w,
             hideEmpty=True, separator=':', labelStyle=LABEL, protected=False)


def a4_header(width, *, title_rows, party_title='', extra_rows=None, height=62, primary='#1d4ed8'):
    right_x = width - 64
    els = [
        E('logo', 'logo', 0, 0, 26, 20, {}, fit='contain'),
        E('company', 'companyBlock', 29, 0, right_x - 31, 27, {'fontSize': 8, 'lineHeight': 1.3, 'shrinkToFit': True},
          show={'name': True, 'tagline': True, 'address': True, 'phone': True, 'email': True,
                'website': False, 'gstin': True, 'pan': False}, nameSize=17, nameColor=primary, protected=True),
        E('title', 'field', right_x, 0, 64, 9, {'fontSize': 15, 'fontWeight': 800, 'align': 'right', 'uppercase': True, 'shrinkToFit': True,
                                               'color': primary, 'letterSpacing': 0.5},
          field='document.title', label='', labelPosition='none', hideIfEmpty=False, protected=True),
        meta_list('meta', right_x, 10, 64, 19, title_rows, label_w=25),
        E('rule', 'line', 0, 29.5, width, 1, {}, orientation='h', thickness=0.8, color=primary, lineStyle='solid'),
        E('party', 'partyBlock', 0, 32, width / 2 - 3, height - 34, {**BOXED, 'fontSize': 8.5},
          title=party_title, variant='billing',
          show={'title': True, 'name': True, 'code': True, 'phone': True, 'email': False, 'address': True, 'gstin': True},
          protected=True),
    ]
    if extra_rows:
        els.append(meta_list('meta2', width / 2 + 3, 32, width / 2 - 3, height - 34, extra_rows, label_w=28))
    return els


def a4_footer(width, text='Thank you for your business!'):
    return [
        E('frule', 'line', 0, 0, width, 1, {}, orientation='h', thickness=0.3, color='#cbd5e1', lineStyle='solid'),
        E('fthanks', 'text', 0, 1.5, width - 45, 5, {'fontSize': 7.5, 'color': '#64748b'}, text=text),
        E('fpage', 'pageNumber', width - 45, 1.5, 45, 5, {'fontSize': 7.5, 'color': '#64748b', 'align': 'right'},
          format='Page {page} of {pages}'),
    ]


def totals_el(eid, x, y, w, h, keys, always=('grandTotal',), primary='#1d4ed8', font=8.5):
    labels = {'tax': 'Total Tax', 'balance': 'Balance Due', 'paid': 'Amount Paid', 'refund': 'Refund Amount'}
    return E(eid, 'totals', x, y, w, h, {'fontSize': font},
             rows=[{'key': k, 'label': labels.get(k, ''), **({'always': True} if k in always else {})} for k in keys],
             grandStyle={'fontSize': font + 2.5, 'fontWeight': 800, 'color': primary}, divider=True, protected=True)


def words_el(eid, x, y, w, h):
    return E(eid, 'field', x, y, w, h, {'fontSize': 8, 'italic': True},
             field='totals.amountInWords', label='Amount in words', labelPosition='top',
             labelStyle=LABEL, hideIfEmpty=True)


def signature_el(eid, x, y, w, h, label='Authorised Signatory'):
    return E(eid, 'signature', x, y, w, h, {'fontSize': 8, 'align': 'center'},
             label=label, showLine=True, showCompany=True)


def terms_el(eid, x, y, w, h, text, title='Terms & Conditions'):
    return E(eid, 'text', x, y, w, h, {'fontSize': 7.5, 'color': '#475569', 'lineHeight': 1.35}, title=title, text=text)


STD_TOTALS = ['subtotal', 'discount', 'additionalDiscount', 'taxableAmount', 'cgst', 'sgst', 'igst', 'cess',
              'tax', 'shipping', 'otherCharges', 'roundOff', 'grandTotal', 'paid', 'balance']

SALES_COLUMNS = [
    col('slno', '#', 5, 'center'), col('name', 'Item / Description', 37), col('hsn', 'HSN', 9, 'center', False),
    col('qty', 'Qty', 7, 'center'), col('rate', 'Rate', 12, 'right'), col('discount', 'Disc', 10, 'right'),
    col('taxPercent', 'GST %', 8, 'right'), col('taxAmount', 'GST', 10, 'right'), col('total', 'Amount', 13, 'right'),
]

DEFAULT_TERMS = ('1. Goods once sold will not be taken back or exchanged.\n'
                 '2. Spectacles are made to prescription; please collect within 30 days.\n'
                 '3. Subject to local jurisdiction.')


# ---------------------------------------------------------------------------
# Presets
# ---------------------------------------------------------------------------

def classic_a4():
    W = 190
    header = a4_header(W, title_rows=[('document.number', 'Invoice No'), ('document.date', 'Date'),
                                      ('document.dueDate', 'Due Date'), ('document.paymentStatus', 'Status')],
                       extra_rows=[('document.orderNumber', 'Order Ref'), ('document.reference', 'Reference'),
                                   ('document.salesperson', 'Salesperson'), ('document.branch', 'Branch')])
    summary = [
        words_el('words', 0, 0, 112, 10),
        E('taxsum', 'taxSummary', 0, 11, 112, 22, {'fontSize': 7.5}, showHsn=False),
        E('pay', 'payment', 0, 34, 112, 18, {'fontSize': 8}, title='Payment',
          show={'method': True, 'reference': True, 'splits': True, 'paid': False, 'balance': False,
                'status': False, 'bank': True, 'upi': True}),
        totals_el('totals', 118, 0, 72, 52, STD_TOTALS, always=('grandTotal', 'paid', 'balance')),
        terms_el('terms', 0, 55, 112, 19, DEFAULT_TERMS),
        signature_el('sign', 128, 56, 62, 18),
    ]
    return config(header, summary, a4_footer(W), items_band(SALES_COLUMNS),
                  header_h=62, summary_h=76, footer_h=8)


def modern_a4():
    W = 190
    primary = '#0f766e'
    header = [
        E('banner', 'box', 0, 0, W, 30, {'bg': primary, 'radius': 2}),
        E('logo', 'logo', 3, 3, 24, 24, {}, fit='contain'),
        E('company', 'companyBlock', 30, 3, 95, 25, {'fontSize': 8, 'color': '#ffffff', 'shrinkToFit': True},
          show={'name': True, 'tagline': True, 'address': True, 'phone': True, 'email': True,
                'website': True, 'gstin': True, 'pan': False}, nameSize=18, nameColor='#ffffff', protected=True),
        E('title', 'field', 125, 4, 62, 10, {'fontSize': 18, 'fontWeight': 800, 'align': 'right', 'color': '#ffffff',
                                            'uppercase': True, 'shrinkToFit': True}, field='document.title', labelPosition='none',
          hideIfEmpty=False, protected=True),
        E('number', 'field', 125, 15, 62, 6, {'fontSize': 10, 'align': 'right', 'color': '#ccfbf1', 'fontWeight': 600},
          field='document.number', prefix='# ', labelPosition='none'),
        E('date', 'field', 125, 21, 62, 6, {'fontSize': 9, 'align': 'right', 'color': '#ccfbf1'},
          field='document.date', labelPosition='none'),
        E('party', 'partyBlock', 0, 34, 92, 28, {'fontSize': 8.5, 'padding': 1},
          title='', variant='billing',
          show={'title': True, 'name': True, 'code': True, 'phone': True, 'email': True, 'address': True, 'gstin': True},
          protected=True),
        meta_list('meta2', 98, 34, 92, 28, [('document.dueDate', 'Due Date'), ('document.paymentStatus', 'Payment'),
                                            ('document.orderNumber', 'Order Ref'), ('document.salesperson', 'Served by'),
                                            ('document.branch', 'Branch')], label_w=26),
    ]
    summary = [
        words_el('words', 0, 0, 110, 10),
        E('pay', 'payment', 0, 12, 110, 20, {'fontSize': 8}, title='Payment Details',
          show={'method': True, 'reference': True, 'splits': True, 'paid': False, 'balance': False,
                'status': False, 'bank': True, 'upi': True}),
        E('qr', 'qr', 0, 34, 24, 24, {}, source='upi', field='document.number', customText=''),
        totals_el('totals', 118, 0, 72, 50, STD_TOTALS, always=('grandTotal', 'paid', 'balance'), primary=primary),
        terms_el('terms', 28, 34, 84, 24, DEFAULT_TERMS),
        signature_el('sign', 128, 42, 62, 18),
    ]
    items = items_band(SALES_COLUMNS, headerStyle={'bg': primary, 'color': '#ffffff', 'fontSize': 8, 'fontWeight': 700},
                       zebraColor='#f0fdfa', borders='rows', borderColor='#99f6e4')
    return config(header, summary, a4_footer(W, 'Thank you for choosing us!'), items,
                  header_h=64, summary_h=62, footer_h=8,
                  theme_over={'name': 'Teal', 'primary': primary, 'headerBg': primary, 'border': '#99f6e4'})


def compact_a5():
    W = 132
    header = [
        E('logo', 'logo', 0, 0, 18, 14, {}, fit='contain'),
        E('company', 'companyBlock', 20, 0, 66, 22, {'fontSize': 7, 'shrinkToFit': True},
          show={'name': True, 'tagline': False, 'address': True, 'phone': True, 'email': False,
                'website': False, 'gstin': True, 'pan': False}, nameSize=13, nameColor='#1d4ed8', protected=True),
        E('title', 'field', 86, 0, 46, 7, {'fontSize': 11, 'fontWeight': 800, 'align': 'right', 'uppercase': True, 'shrinkToFit': True,
                                          'color': '#1d4ed8'}, field='document.title', labelPosition='none',
          hideIfEmpty=False, protected=True),
        meta_list('meta', 86, 8, 46, 14, [('document.number', 'No'), ('document.date', 'Date'),
                                          ('document.paymentStatus', 'Status')], label_w=13),
        E('rule', 'line', 0, 23, W, 1, {}, orientation='h', thickness=0.6, color='#1d4ed8'),
        E('party', 'partyBlock', 0, 25, W, 13, {'fontSize': 8},
          title='', variant='billing',
          show={'title': True, 'name': True, 'code': False, 'phone': True, 'email': False, 'address': True, 'gstin': False},
          protected=True),
    ]
    columns = [col('slno', '#', 6, 'center'), col('name', 'Item', 48), col('qty', 'Qty', 9, 'center'),
               col('rate', 'Rate', 17, 'right'), col('total', 'Amount', 20, 'right')]
    summary = [
        totals_el('totals', 62, 0, 70, 34, ['subtotal', 'discount', 'tax', 'roundOff', 'grandTotal', 'paid', 'balance'],
                  always=('grandTotal', 'paid', 'balance'), font=8),
        E('paymethod', 'field', 0, 0, 58, 6, {'fontSize': 8}, field='payment.method', label='Paid by',
          labelPosition='left', labelWidth=16, labelStyle=LABEL),
        words_el('words', 0, 7, 58, 10),
        signature_el('sign', 0, 22, 50, 12, 'Signature'),
    ]
    footer = [E('fthanks', 'text', 0, 0, W - 30, 5, {'fontSize': 7, 'color': '#64748b'}, text='Thank you! Visit again.'),
              E('fpage', 'pageNumber', W - 30, 0, 30, 5, {'fontSize': 7, 'color': '#64748b', 'align': 'right'},
                format='Page {page}/{pages}')]
    return config(header, summary, footer,
                  items_band(columns, headerStyle={'bg': '#e2e8f0', 'color': '#0f172a', 'fontSize': 7.5, 'fontWeight': 700},
                             bodyStyle={'fontSize': 7.5}, rowPadding=1.1, zebra=False, showBrand=False),
                  header_h=39, summary_h=35, footer_h=6, theme_over={'fontSize': 8})


def thermal(width_mm):
    W = width_mm - (6 if width_mm >= 80 else 4)
    small = width_mm < 80
    fs = 7 if small else 8
    mono = "'Courier New', Courier, monospace"
    header = [
        E('logo', 'logo', W / 2 - 9, 0, 18, 9, {'align': 'center'}, fit='contain'),
        E('company', 'companyBlock', 0, 9.5, W, 17, {'fontSize': fs - 0.5, 'align': 'center', 'shrinkToFit': True},
          show={'name': True, 'tagline': False, 'address': True, 'phone': True, 'email': False,
                'website': False, 'gstin': True, 'pan': False}, nameSize=fs + 4, nameColor='#000000', protected=True),
        E('rule1', 'line', 0, 27, W, 1, {}, orientation='h', thickness=0.3, color='#000000', lineStyle='dashed'),
        E('title', 'field', 0, 28, W, 4.5, {'fontSize': fs + 1, 'fontWeight': 800, 'align': 'center', 'uppercase': True, 'shrinkToFit': True},
          field='document.title', labelPosition='none', hideIfEmpty=False, protected=True),
        meta_list('meta', 0, 33, W, 19, [('document.number', 'Bill'), ('document.date', 'Date'),
                                         ('party.name', 'Name'), ('party.phone', 'Ph')], label_w=11 if small else 13),
        E('rule2', 'line', 0, 52.5, W, 1, {}, orientation='h', thickness=0.3, color='#000000', lineStyle='dashed'),
    ]
    columns = [col('name', 'Item', 42), col('qty', 'Qty', 10, 'center'), col('rate', 'Rate', 22, 'right'),
               col('total', 'Amt', 26, 'right')]
    summary = [
        E('rule3', 'line', 0, 0, W, 1, {}, orientation='h', thickness=0.3, color='#000000', lineStyle='dashed'),
        totals_el('totals', 0, 1, W, 26, ['subtotal', 'discount', 'tax', 'roundOff', 'grandTotal', 'paid', 'balance'],
                  always=('grandTotal',), primary='#000000', font=fs),
        E('paymethod', 'field', 0, 27.5, W, 4, {'fontSize': fs}, field='payment.method', label='Paid by',
          labelPosition='left', labelWidth=14),
        E('thanks', 'text', 0, 32, W, 5, {'fontSize': fs, 'align': 'center', 'fontWeight': 700}, text='Thank you! Visit again.'),
    ]
    return config(header, summary, [],
                  items_band(columns, mt=0.5, mb=0.5,
                             headerStyle={'bg': 'transparent', 'color': '#000000', 'fontSize': fs, 'fontWeight': 700},
                             bodyStyle={'fontSize': fs}, rowPadding=0.6, cellPadX=0.5, currencyInTable=False,
                             zebra=False, borders='header',
                             borderColor='#000000', showBrand=False, showVariant=False),
                  header_h=54, summary_h=38, footer_h=0,
                  theme_over={'name': 'Thermal', 'primary': '#000000', 'accent': '#000000', 'text': '#000000',
                              'muted': '#000000', 'border': '#000000', 'fontFamily': mono, 'fontSize': fs})


def wholesale_a4():
    W = 190
    header = a4_header(W, title_rows=[('document.number', 'Invoice No'), ('document.date', 'Date'),
                                      ('document.dueDate', 'Due Date'), ('document.paymentStatus', 'Status')],
                       party_title='Billed To')
    header.append(E('ship', 'partyBlock', 98, 32, 92, 28, {**BOXED, 'fontSize': 8.5}, title='Ship To', variant='shipping',
                    show={'title': True, 'name': True, 'code': False, 'phone': True, 'email': False, 'address': True, 'gstin': False}))
    columns = [col('slno', '#', 5, 'center'), col('name', 'Product', 30), col('sku', 'SKU', 12), col('hsn', 'HSN', 8, 'center'),
               col('qty', 'Qty', 7, 'center'), col('unit', 'Unit', 6, 'center'), col('rate', 'Rate', 11, 'right'),
               col('discountPercent', 'Disc %', 7, 'right'), col('taxPercent', 'GST %', 7, 'right'),
               col('total', 'Total', 13, 'right')]
    summary = [
        words_el('words', 0, 0, 112, 10),
        E('taxsum', 'taxSummary', 0, 11, 112, 22, {'fontSize': 7.5}, showHsn=True),
        E('pay', 'payment', 0, 34, 112, 16, {'fontSize': 8}, title='Payment',
          show={'method': True, 'reference': True, 'splits': False, 'paid': False, 'balance': False,
                'status': False, 'bank': True, 'upi': False}),
        totals_el('totals', 118, 0, 72, 50, ['subtotal', 'discount', 'tax', 'shipping', 'otherCharges', 'roundOff',
                                             'grandTotal', 'paid', 'balance'], always=('grandTotal', 'paid', 'balance')),
        terms_el('terms', 0, 52, 112, 20, '1. Goods once sold will not be taken back.\n'
                                          '2. Payment due as per agreed credit terms.\n3. Subject to local jurisdiction.'),
        signature_el('sign', 128, 54, 62, 18),
    ]
    return config(header, summary, a4_footer(W), items_band(columns, showPower=False),
                  header_h=62, summary_h=74, footer_h=8, page={'headerOnEveryPage': True})


def job_slip_a5():
    W = 132
    header = [
        E('company', 'companyBlock', 0, 0, 80, 17, {'fontSize': 7, 'shrinkToFit': True},
          show={'name': True, 'tagline': False, 'address': True, 'phone': True, 'email': False,
                'website': False, 'gstin': False, 'pan': False}, nameSize=13, nameColor='#7c3aed', protected=True),
        E('title', 'field', 80, 0, 52, 7, {'fontSize': 11, 'fontWeight': 800, 'align': 'right', 'color': '#7c3aed',
                                          'uppercase': True, 'shrinkToFit': True}, field='document.title', labelPosition='none',
          hideIfEmpty=False, protected=True),
        E('barcode', 'barcode', 86, 8, 46, 11, {}, field='document.number', showText=True),
        E('rule', 'line', 0, 20, W, 1, {}, orientation='h', thickness=0.6, color='#7c3aed'),
        meta_list('meta', 0, 22, 64, 22, [('document.number', 'Order No'), ('document.date', 'Order Date'),
                                          ('document.deliveryDate', 'Delivery'), ('document.fulfillmentStatus', 'Stage'),
                                          ('document.salesperson', 'Optometrist')], label_w=21),
        E('party', 'partyBlock', 68, 22, 64, 22, {**BOXED, 'fontSize': 8}, title='Customer', variant='billing',
          show={'title': True, 'name': True, 'code': True, 'phone': True, 'email': False, 'address': False, 'gstin': False},
          protected=True),
    ]
    columns = [col('slno', '#', 6, 'center'), col('name', 'Frame / Lens / Service', 60), col('qty', 'Qty', 10, 'center'),
               col('total', 'Amount', 24, 'right')]
    summary = [
        totals_el('totals', 66, 0, 66, 28, ['subtotal', 'discount', 'grandTotal', 'paid', 'balance'],
                  always=('grandTotal', 'paid', 'balance'), primary='#7c3aed', font=8),
        E('notes', 'field', 0, 0, 62, 14, {'fontSize': 7.5}, field='document.notes', label='Notes', labelPosition='top',
          labelStyle=LABEL),
        signature_el('sign', 0, 18, 50, 11, 'Customer Signature'),
    ]
    footer = [E('fnote', 'text', 0, 0, W, 5, {'fontSize': 7, 'color': '#64748b', 'align': 'center'},
                text='Please bring this slip when collecting your spectacles.')]
    return config(header, summary, footer,
                  items_band(columns, headerStyle={'bg': '#ede9fe', 'color': '#4c1d95', 'fontSize': 7.5, 'fontWeight': 700},
                             bodyStyle={'fontSize': 8}, rowPadding=1.2, zebra=False, borders='grid',
                             borderColor='#ddd6fe', showPower=True),
                  header_h=46, summary_h=30, footer_h=6, theme_over={'name': 'Violet', 'primary': '#7c3aed', 'fontSize': 8})


def quotation_a4():
    W = 190
    header = a4_header(W, title_rows=[('document.number', 'Quotation No'), ('document.date', 'Date'),
                                      ('document.dueDate', 'Valid Until')], party_title='Prepared For',
                       extra_rows=[('document.salesperson', 'Prepared By'), ('document.branch', 'Branch')],
                       primary='#b45309')
    summary = [
        words_el('words', 0, 0, 112, 10),
        totals_el('totals', 118, 0, 72, 40, ['subtotal', 'discount', 'tax', 'shipping', 'otherCharges', 'roundOff',
                                             'grandTotal'], always=('grandTotal',), primary='#b45309'),
        terms_el('terms', 0, 12, 112, 28, '1. This quotation is valid for 15 days from the date above.\n'
                                          '2. Prices include applicable taxes unless stated otherwise.\n'
                                          '3. Delivery 3–5 working days after order confirmation.'),
        signature_el('sign', 128, 44, 62, 18),
    ]
    return config(header, summary, a4_footer(W, 'We look forward to serving you.'),
                  items_band(SALES_COLUMNS, headerStyle={'bg': '#b45309', 'color': '#ffffff', 'fontSize': 8, 'fontWeight': 700},
                             zebraColor='#fffbeb'),
                  header_h=62, summary_h=64, footer_h=8, theme_over={'name': 'Amber', 'primary': '#b45309', 'headerBg': '#b45309'})


PURCHASE_COLUMNS = [
    col('slno', '#', 5, 'center'), col('name', 'Product', 28), col('batch', 'Batch', 10), col('expiry', 'Expiry', 10, 'center'),
    col('hsn', 'HSN', 8, 'center', False), col('qty', 'Qty', 7, 'center'), col('freeQty', 'Free', 6, 'center'),
    col('rate', 'Rate', 11, 'right'), col('discountPercent', 'Disc %', 7, 'right'), col('taxPercent', 'GST %', 7, 'right'),
    col('total', 'Amount', 13, 'right'),
]


def purchase_a4():
    W = 190
    header = a4_header(W, title_rows=[('document.number', 'Entry No'), ('document.date', 'Date'),
                                      ('document.reference', 'Supplier Inv'), ('document.dueDate', 'Due Date')],
                       party_title='Supplier',
                       extra_rows=[('document.branch', 'Branch / Store'), ('document.status', 'Status'),
                                   ('payment.method', 'Payment')], primary='#0369a1')
    summary = [
        E('notes', 'field', 0, 0, 112, 14, {'fontSize': 8}, field='document.notes', label='Notes', labelPosition='top', labelStyle=LABEL),
        E('taxsum', 'taxSummary', 0, 16, 112, 22, {'fontSize': 7.5}, showHsn=False),
        totals_el('totals', 118, 0, 72, 52, ['subtotal', 'discount', 'cgst', 'sgst', 'igst', 'cess', 'tax',
                                             'otherCharges', 'roundOff', 'grandTotal', 'paid', 'balance'],
                  always=('grandTotal', 'paid', 'balance'), primary='#0369a1'),
        signature_el('sign', 0, 42, 60, 14, 'Received By'),
        signature_el('sign2', 128, 56, 62, 14, 'Authorised Signatory'),
    ]
    return config(header, summary, a4_footer(W, 'Goods received in good condition.'),
                  items_band(PURCHASE_COLUMNS, headerStyle={'bg': '#0369a1', 'color': '#ffffff', 'fontSize': 7.5, 'fontWeight': 700},
                             zebraColor='#f0f9ff', showPower=False),
                  header_h=62, summary_h=72, footer_h=8, page={'headerOnEveryPage': True},
                  theme_over={'name': 'Ocean', 'primary': '#0369a1', 'headerBg': '#0369a1'})


def receipt_a5():
    # A5 landscape: 210 x 148 with 8 mm margins -> 194 x 132 content.
    W = 194
    header = [
        E('logo', 'logo', 0, 0, 22, 16, {}, fit='contain'),
        E('company', 'companyBlock', 25, 0, 110, 22, {'fontSize': 7.5, 'shrinkToFit': True},
          show={'name': True, 'tagline': True, 'address': True, 'phone': True, 'email': False,
                'website': False, 'gstin': True, 'pan': False}, nameSize=15, nameColor='#047857', protected=True),
        E('title', 'field', 135, 0, 59, 9, {'fontSize': 14, 'fontWeight': 800, 'align': 'right', 'color': '#047857',
                                           'uppercase': True, 'shrinkToFit': True}, field='document.title', labelPosition='none',
          hideIfEmpty=False, protected=True),
        meta_list('meta', 135, 10, 59, 12, [('document.number', 'Receipt No'), ('document.date', 'Date')], label_w=22),
        E('rule', 'line', 0, 24, W, 1, {}, orientation='h', thickness=0.8, color='#047857'),
    ]
    summary = [
        E('from', 'field', 0, 0, 130, 8, {'fontSize': 10}, field='party.name', label='Received with thanks from',
          labelPosition='top', labelStyle=LABEL, protected=True),
        E('phone', 'field', 0, 10, 130, 5, {'fontSize': 8.5}, field='party.phone', label='Phone', labelPosition='left',
          labelWidth=22, labelStyle=LABEL),
        E('words', 'field', 0, 17, 130, 12, {'fontSize': 9, 'italic': True}, field='totals.amountInWords',
          label='The sum of', labelPosition='top', labelStyle=LABEL),
        meta_list('paymeta', 0, 31, 130, 16, [('receipt.invoiceNumber', 'Against Bill'), ('payment.method', 'Mode'),
                                              ('payment.reference', 'Reference')], label_w=28),
        E('amountbox', 'box', 140, 0, 54, 22, {'bg': '#ecfdf5', 'borderWidth': 0.4, 'borderColor': '#047857',
                                              'borderSides': 'all', 'radius': 2}),
        E('amountlbl', 'text', 142, 2, 50, 5, {'fontSize': 8, 'color': '#047857', 'fontWeight': 700, 'align': 'center'},
          text='AMOUNT RECEIVED'),
        E('amount', 'field', 142, 8, 50, 11, {'fontSize': 17, 'fontWeight': 800, 'align': 'center', 'color': '#047857',
                                             'shrinkToFit': True}, field='receipt.amount', labelPosition='none',
          hideIfEmpty=False, protected=True),
        E('notes', 'field', 0, 49, 130, 10, {'fontSize': 8}, field='document.notes', label='Notes', labelPosition='left',
          labelWidth=22, labelStyle=LABEL),
        signature_el('sign', 140, 44, 54, 16, 'Authorised Signatory'),
    ]
    footer = [E('fnote', 'text', 0, 0, W, 5, {'fontSize': 7, 'color': '#64748b', 'align': 'center'},
                text='This is a computer generated receipt.')]
    return config(header, summary, footer, None, header_h=27, summary_h=62, footer_h=6,
                  theme_over={'name': 'Emerald', 'primary': '#047857'})


def sales_return_a4():
    W = 190
    header = a4_header(W, title_rows=[('document.number', 'Return No'), ('document.date', 'Date'),
                                      ('return.originalInvoice', 'Against Bill')], party_title='Customer',
                       extra_rows=[('return.reason', 'Reason'), ('return.action', 'Action'), ('document.branch', 'Branch')],
                       primary='#be123c')
    columns = [col('slno', '#', 5, 'center'), col('name', 'Returned Item', 45), col('qty', 'Qty', 8, 'center'),
               col('rate', 'Rate', 14, 'right'), col('taxAmount', 'GST', 12, 'right'), col('total', 'Amount', 16, 'right')]
    summary = [
        words_el('words', 0, 0, 112, 10),
        totals_el('totals', 118, 0, 72, 34, ['subtotal', 'tax', 'roundOff', 'grandTotal', 'refund', 'balance'],
                  always=('grandTotal',), primary='#be123c'),
        E('notes', 'field', 0, 12, 112, 14, {'fontSize': 8}, field='document.notes', label='Remarks', labelPosition='top', labelStyle=LABEL),
        signature_el('sign', 0, 34, 60, 14, 'Customer Signature'),
        signature_el('sign2', 128, 38, 62, 14, 'Authorised Signatory'),
    ]
    return config(header, summary, a4_footer(W, 'Credit note issued against the original bill.'),
                  items_band(columns, headerStyle={'bg': '#be123c', 'color': '#ffffff', 'fontSize': 8, 'fontWeight': 700},
                             zebraColor='#fff1f2', showPower=False),
                  header_h=62, summary_h=54, footer_h=8, theme_over={'name': 'Rose', 'primary': '#be123c', 'headerBg': '#be123c'})


def purchase_return_a4():
    W = 190
    header = a4_header(W, title_rows=[('document.number', 'Debit Note'), ('document.date', 'Date'),
                                      ('return.originalInvoice', 'Against Bill')], party_title='Supplier',
                       extra_rows=[('return.reason', 'Reason'), ('return.action', 'Status')], primary='#9a3412')
    columns = [col('slno', '#', 5, 'center'), col('name', 'Product', 40), col('batch', 'Batch', 12), col('qty', 'Qty', 8, 'center'),
               col('rate', 'Rate', 15, 'right'), col('total', 'Amount', 18, 'right')]
    summary = [
        words_el('words', 0, 0, 112, 10),
        totals_el('totals', 118, 0, 72, 26, ['subtotal', 'tax', 'grandTotal', 'refund'], always=('grandTotal',), primary='#9a3412'),
        signature_el('sign', 128, 30, 62, 14, 'Authorised Signatory'),
    ]
    return config(header, summary, a4_footer(W, 'Goods returned to vendor (RTV).'),
                  items_band(columns, headerStyle={'bg': '#9a3412', 'color': '#ffffff', 'fontSize': 8, 'fontWeight': 700},
                             zebraColor='#fff7ed', showPower=False, showBrand=False),
                  header_h=62, summary_h=46, footer_h=8, theme_over={'name': 'Rust', 'primary': '#9a3412', 'headerBg': '#9a3412'})


def _m(v):
    return {'top': v, 'right': v, 'bottom': v, 'left': v}


VISUAL_PRESETS = [
    {'preset_key': 'classic-a4', 'name': 'Classic Tax Invoice (A4)', 'template_type': 'STANDARD',
     'description': 'Full GST tax invoice with tax summary, payment details, terms and signature.',
     'paper_size': 'A4', 'orientation': 'portrait', 'margins': _m(10), 'build': classic_a4},
    {'preset_key': 'modern-a4', 'name': 'Modern Invoice (A4)', 'template_type': 'STANDARD',
     'description': 'Colour banner header, UPI QR and a clean items table.',
     'paper_size': 'A4', 'orientation': 'portrait', 'margins': _m(10), 'build': modern_a4},
    {'preset_key': 'compact-a5', 'name': 'Compact Bill (A5)', 'template_type': 'COMPACT',
     'description': 'Space-saving half-page bill.',
     'paper_size': 'A5', 'orientation': 'portrait', 'margins': _m(8), 'build': compact_a5},
    {'preset_key': 'thermal-80', 'name': 'Thermal Receipt (80 mm)', 'template_type': 'THERMAL_80',
     'description': '80 mm roll receipt — the page is exactly as long as the bill.',
     'paper_size': '80mm', 'orientation': 'portrait', 'margins': _m(3), 'build': lambda: thermal(80)},
    {'preset_key': 'thermal-58', 'name': 'Thermal Receipt (58 mm)', 'template_type': 'THERMAL_58',
     'description': '58 mm roll receipt for small printers.',
     'paper_size': '58mm', 'orientation': 'portrait', 'margins': _m(2), 'build': lambda: thermal(58)},
    {'preset_key': 'wholesale-a4', 'name': 'Wholesale Tax Invoice (A4)', 'template_type': 'WHOLESALE',
     'description': 'Dealer invoice with SKU, unit, discount %, ship-to and HSN tax summary.',
     'paper_size': 'A4', 'orientation': 'portrait', 'margins': _m(10), 'build': wholesale_a4},
    {'preset_key': 'job-slip-a5', 'name': 'Order / Job Slip (A5)', 'template_type': 'CUSTOM',
     'description': 'Lab job slip with delivery date, stage, power and balance due.',
     'paper_size': 'A5', 'orientation': 'portrait', 'margins': _m(8), 'build': job_slip_a5},
    {'preset_key': 'quotation-a4', 'name': 'Quotation / Estimate (A4)', 'template_type': 'CUSTOM',
     'description': 'Estimate with validity terms and no payment section.',
     'paper_size': 'A4', 'orientation': 'portrait', 'margins': _m(10), 'build': quotation_a4},
    {'preset_key': 'purchase-a4', 'name': 'Purchase Bill (A4)', 'template_type': 'CUSTOM',
     'description': 'Goods receipt with batch, expiry, free quantity and GST split.',
     'paper_size': 'A4', 'orientation': 'portrait', 'margins': _m(10), 'build': purchase_a4},
    {'preset_key': 'receipt-a5', 'name': 'Payment Receipt (A5 landscape)', 'template_type': 'CUSTOM',
     'description': 'Money receipt with amount in words and the bill it was paid against.',
     'paper_size': 'A5', 'orientation': 'landscape', 'margins': _m(8), 'build': receipt_a5},
    {'preset_key': 'sales-return-a4', 'name': 'Sales Return / Credit Note (A4)', 'template_type': 'CUSTOM',
     'description': 'Credit note listing returned items against the original bill.',
     'paper_size': 'A4', 'orientation': 'portrait', 'margins': _m(10), 'build': sales_return_a4},
    {'preset_key': 'purchase-return-a4', 'name': 'Purchase Return / Debit Note (A4)', 'template_type': 'CUSTOM',
     'description': 'Return-to-vendor debit note with batch numbers.',
     'paper_size': 'A4', 'orientation': 'portrait', 'margins': _m(10), 'build': purchase_return_a4},
]

# Recommended starter template per document type.
VISUAL_DEFAULT_ASSIGNMENTS = {
    'SALES_INVOICE': 'classic-a4',
    'WHOLESALE_BILL': 'wholesale-a4',
    'ORDER_BILL': 'job-slip-a5',
    'QUOTATION': 'quotation-a4',
    'PURCHASE_BILL': 'purchase-a4',
    'PAYMENT_RECEIPT': 'receipt-a5',
    'SALES_RETURN': 'sales-return-a4',
    'PURCHASE_RETURN': 'purchase-return-a4',
}
DEFAULT_PRESET_KEY = 'classic-a4'


def visual_preset(key):
    """Validated spec dict (without the builder) for `key`, or None."""
    for p in VISUAL_PRESETS:
        if p['preset_key'] == key:
            spec = {k: copy.deepcopy(v) for k, v in p.items() if k != 'build'}
            spec['config'] = validate_config(p['build']())
            return spec
    return None


def all_visual_presets():
    return [visual_preset(p['preset_key']) for p in VISUAL_PRESETS]
