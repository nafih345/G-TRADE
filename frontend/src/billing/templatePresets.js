// Built-in starter templates — an offline mirror of backend/apps/billing/presets.py.
// Used as the fallback when /api/billing is unreachable or a document type has no
// assigned template, so every module can always print. Keep the `config` shape here in
// sync with renderBillHtml.js and the backend presets.

function col(key, label, enabled = true, align = 'left') {
  return { key, label, enabled, align };
}

const STANDARD_COLUMNS = [
  col('slno', 'Sl', true, 'center'),
  col('name', 'Description', true, 'left'),
  col('hsn', 'HSN', false, 'center'),
  col('sku', 'SKU', false, 'left'),
  col('barcode', 'Barcode', false, 'left'),
  col('size', 'Size', false, 'center'),
  col('color', 'Color', false, 'center'),
  col('qty', 'Qty', true, 'center'),
  col('unit', 'Unit', false, 'center'),
  col('rate', 'Rate', true, 'right'),
  col('discount', 'Disc', false, 'right'),
  col('tax', 'Tax', true, 'right'),
  col('total', 'Amount', true, 'right'),
];

const JEWELLERY_COLUMNS = [
  col('slno', 'Sl', true, 'center'),
  col('name', 'Item', true, 'left'),
  col('hsn', 'HSN', true, 'center'),
  col('grossWeight', 'Gross Wt', true, 'right'),
  col('netWeight', 'Net Wt', true, 'right'),
  col('stoneWeight', 'Stone Wt', false, 'right'),
  col('rate', 'Rate', true, 'right'),
  col('makingCharge', 'Making', true, 'right'),
  col('stoneCharge', 'Stone Chg', false, 'right'),
  col('otherCharges', 'Other', false, 'right'),
  col('qty', 'Qty', false, 'center'),
  col('tax', 'Tax', true, 'right'),
  col('total', 'Amount', true, 'right'),
];

const WHOLESALE_COLUMNS = [
  col('slno', 'Sl', true, 'center'),
  col('name', 'Product', true, 'left'),
  col('sku', 'SKU', true, 'left'),
  col('hsn', 'HSN', false, 'center'),
  col('qty', 'Qty', true, 'center'),
  col('unit', 'Unit', false, 'center'),
  col('rate', 'Rate', true, 'right'),
  col('discount', 'Disc %', true, 'right'),
  col('tax', 'Tax', true, 'right'),
  col('total', 'Total', true, 'right'),
];

const THERMAL_COLUMNS = [
  col('name', 'Item', true, 'left'),
  col('qty', 'Qty', true, 'center'),
  col('rate', 'Rate', true, 'right'),
  col('total', 'Amt', true, 'right'),
];

export const ALL_COLUMN_KEYS = [
  'slno', 'name', 'sku', 'barcode', 'hsn', 'size', 'color', 'qty', 'unit',
  'rate', 'discount', 'tax', 'total',
  'grossWeight', 'netWeight', 'stoneWeight', 'makingCharge', 'stoneCharge', 'otherCharges',
];

export const COLUMN_LABELS = {
  slno: 'Sl No', name: 'Product Name', sku: 'SKU', barcode: 'Barcode', hsn: 'HSN',
  size: 'Size', color: 'Color', qty: 'Quantity', unit: 'Unit', rate: 'Rate',
  discount: 'Discount', tax: 'Tax', total: 'Total',
  grossWeight: 'Gross Weight', netWeight: 'Net Weight', stoneWeight: 'Stone Weight',
  makingCharge: 'Making Charge', stoneCharge: 'Stone Charge', otherCharges: 'Other Charges',
};

export const TOTALS_ROW_KEYS = [
  'subtotal', 'discount', 'additionalDiscount', 'tax', 'cgst', 'sgst', 'igst',
  'shipping', 'otherCharges', 'roundOff', 'grandTotal', 'paid', 'balance',
];

export const TOTALS_ROW_LABELS = {
  subtotal: 'Subtotal', discount: 'Discount', additionalDiscount: 'Additional Discount',
  tax: 'Tax', cgst: 'CGST', sgst: 'SGST', igst: 'IGST', shipping: 'Shipping / Delivery',
  otherCharges: 'Other Charges', roundOff: 'Round Off', grandTotal: 'Grand Total',
  paid: 'Paid Amount', balance: 'Balance Amount',
};

export const SECTION_LABELS = {
  company: 'Company / Header', docTitle: 'Document Title', meta: 'Document Info',
  customer: 'Customer', items: 'Items Table', totals: 'Totals', payment: 'Payment',
  barcode: 'Barcode', qr: 'QR Code', footer: 'Footer',
};

export const META_FIELD_KEYS = [
  'invoiceNumber', 'orderNumber', 'date', 'dueDate', 'paymentStatus', 'salesperson', 'branch',
];

function deepMerge(target, patch) {
  Object.keys(patch || {}).forEach((k) => {
    if (patch[k] && typeof patch[k] === 'object' && !Array.isArray(patch[k]) &&
        target[k] && typeof target[k] === 'object' && !Array.isArray(target[k])) {
      deepMerge(target[k], patch[k]);
    } else {
      target[k] = patch[k];
    }
  });
  return target;
}

function baseConfig(columns) {
  return {
    styles: {
      fontFamily: "'Segoe UI', Arial, sans-serif",
      fontSizePx: 13,
      textColor: '#0f172a',
      accentColor: '#2563eb',
      headingColor: '#0f172a',
      lineHeight: 1.5,
      letterSpacing: 0,
      borderColor: '#e2e8f0',
    },
    sections: [
      { id: 'company', visible: true, config: {
        showLogo: true, logoHeightPx: 54, logoAlign: 'left',
        showName: true, nameSizePx: 26, showTagline: true, showAddress: true,
        showPhone: true, showEmail: true, showWebsite: false, showGstin: true,
        showPan: false, layout: 'split', align: 'left',
      } },
      { id: 'docTitle', visible: true, config: { text: '', align: 'center', style: 'banner' } },
      { id: 'meta', visible: true, config: {
        fields: ['invoiceNumber', 'date', 'paymentStatus', 'salesperson'], layout: 'grid',
      } },
      { id: 'customer', visible: true, config: {
        title: 'Bill To', showName: true, showPhone: true, showAddress: true,
        showGstin: true, showEmail: false,
      } },
      { id: 'items', visible: true, config: {
        columns, zebra: true, showBrandUnderName: true,
      } },
      { id: 'totals', visible: true, config: {
        rows: [...TOTALS_ROW_KEYS], align: 'right', width: 'normal',
      } },
      { id: 'payment', visible: true, config: {
        showMethod: true, showPaid: true, showBalance: true, showStatus: true,
        showBankDetails: false, bankDetails: '', showUpiQr: false, upiId: '',
      } },
      { id: 'barcode', visible: false, config: { source: 'invoiceNumber', heightPx: 44, align: 'center' } },
      { id: 'qr', visible: false, config: { source: 'invoiceNumber', sizePx: 96, align: 'center', customText: '' } },
      { id: 'footer', visible: true, config: {
        thankYou: 'Thank you for your business!', terms: '', notes: '', returnPolicy: '',
        warranty: '', customerCare: '', showSignature: true, signatureLabel: 'Authorized Signatory',
      } },
    ],
  };
}

function setSection(cfg, id, { visible, config } = {}) {
  const s = cfg.sections.find((x) => x.id === id);
  if (!s) return;
  if (visible !== undefined) s.visible = visible;
  if (config) deepMerge(s.config, config);
}

function standard() { return baseConfig(STANDARD_COLUMNS.map((c) => ({ ...c }))); }

function compact() {
  const cfg = baseConfig(STANDARD_COLUMNS.map((c) => ({ ...c })));
  cfg.styles.fontSizePx = 11;
  setSection(cfg, 'company', { config: { nameSizePx: 20, showTagline: false, showEmail: false } });
  setSection(cfg, 'docTitle', { config: { style: 'plain' } });
  setSection(cfg, 'footer', { config: { showSignature: false } });
  return cfg;
}

function thermal(width) {
  const cfg = baseConfig(THERMAL_COLUMNS.map((c) => ({ ...c })));
  cfg.styles.fontFamily = "'Courier New', monospace";
  cfg.styles.fontSizePx = width === '80mm' ? 11 : 10;
  setSection(cfg, 'company', { config: {
    layout: 'stacked', align: 'center', nameSizePx: 15, logoAlign: 'center',
    logoHeightPx: 40, showEmail: false, showWebsite: false,
  } });
  setSection(cfg, 'docTitle', { config: { style: 'plain', align: 'center' } });
  setSection(cfg, 'meta', { config: { layout: 'rows', fields: ['invoiceNumber', 'date', 'paymentStatus'] } });
  setSection(cfg, 'customer', { config: { showAddress: false, showGstin: false } });
  setSection(cfg, 'totals', { config: { rows: ['subtotal', 'discount', 'tax', 'roundOff', 'grandTotal', 'paid', 'balance'] } });
  setSection(cfg, 'qr', { visible: true });
  setSection(cfg, 'footer', { config: { showSignature: false, thankYou: 'Thank you! Visit again.' } });
  return cfg;
}

function jewellery() {
  const cfg = baseConfig(JEWELLERY_COLUMNS.map((c) => ({ ...c })));
  cfg.styles.accentColor = '#b45309';
  cfg.styles.headingColor = '#7c2d12';
  setSection(cfg, 'totals', { config: { rows: ['subtotal', 'discount', 'cgst', 'sgst', 'roundOff', 'grandTotal', 'paid', 'balance'] } });
  setSection(cfg, 'footer', { config: {
    thankYou: 'Thank you for shopping with us.',
    warranty: 'Hallmark / BIS certified. Exchange as per store policy.',
  } });
  return cfg;
}

function wholesale() {
  const cfg = baseConfig(WHOLESALE_COLUMNS.map((c) => ({ ...c })));
  setSection(cfg, 'customer', { config: { title: 'Billed To (Wholesale Buyer)' } });
  setSection(cfg, 'meta', { config: { fields: ['invoiceNumber', 'date', 'dueDate', 'paymentStatus', 'salesperson'] } });
  setSection(cfg, 'totals', { config: { rows: ['subtotal', 'discount', 'tax', 'shipping', 'roundOff', 'grandTotal', 'paid', 'balance'] } });
  setSection(cfg, 'footer', { config: {
    terms: '1. Goods once sold will not be taken back.\n2. Payment due as per agreed credit terms.\n3. Subject to local jurisdiction.',
  } });
  return cfg;
}

export const PRESET_TEMPLATES = [
  { id: 'preset-standard', name: 'Standard Invoice', template_type: 'STANDARD',
    description: 'Professional general-purpose A4 invoice.',
    paper_size: 'A4', orientation: 'portrait',
    margins: { top: 15, right: 15, bottom: 15, left: 15 },
    is_active: true, is_default: true, is_preset: true, config: standard() },
  { id: 'preset-compact', name: 'Compact Invoice', template_type: 'COMPACT',
    description: 'Simple, minimal, space-saving A5 invoice.',
    paper_size: 'A5', orientation: 'portrait',
    margins: { top: 8, right: 8, bottom: 8, left: 8 },
    is_active: true, is_default: false, is_preset: true, config: compact() },
  { id: 'preset-thermal-80', name: 'Thermal 80mm', template_type: 'THERMAL_80',
    description: 'Optimised for 80mm thermal receipt printers. Auto height.',
    paper_size: '80mm', orientation: 'portrait',
    margins: { top: 3, right: 3, bottom: 3, left: 3 },
    is_active: true, is_default: false, is_preset: true, config: thermal('80mm') },
  { id: 'preset-thermal-58', name: 'Thermal 58mm', template_type: 'THERMAL_58',
    description: 'Optimised for 58mm thermal receipt printers. Auto height.',
    paper_size: '58mm', orientation: 'portrait',
    margins: { top: 2, right: 2, bottom: 2, left: 2 },
    is_active: true, is_default: false, is_preset: true, config: thermal('58mm') },
  { id: 'preset-jewellery', name: 'Jewellery Invoice', template_type: 'JEWELLERY',
    description: 'Weight, making charge, stone charge and hallmark details.',
    paper_size: 'A4', orientation: 'portrait',
    margins: { top: 12, right: 12, bottom: 12, left: 12 },
    is_active: true, is_default: false, is_preset: true, config: jewellery() },
  { id: 'preset-wholesale', name: 'Wholesale Invoice', template_type: 'WHOLESALE',
    description: 'SKU, quantity, wholesale rate, discount and totals.',
    paper_size: 'A4', orientation: 'portrait',
    margins: { top: 12, right: 12, bottom: 12, left: 12 },
    is_active: true, is_default: false, is_preset: true, config: wholesale() },
];

export const DEFAULT_ASSIGNMENTS = {
  SALES_INVOICE: 'Standard Invoice',
  WHOLESALE_BILL: 'Wholesale Invoice',
  ORDER_BILL: 'Standard Invoice',
  PURCHASE_BILL: 'Standard Invoice',
  RETURN_BILL: 'Compact Invoice',
  QUOTATION: 'Standard Invoice',
  PAYMENT_RECEIPT: 'Compact Invoice',
};

export function presetForDocType(documentType) {
  const name = DEFAULT_ASSIGNMENTS[documentType] || 'Standard Invoice';
  return PRESET_TEMPLATES.find((t) => t.name === name) || PRESET_TEMPLATES[0];
}

export function emptyTemplateConfig() {
  return standard();
}
