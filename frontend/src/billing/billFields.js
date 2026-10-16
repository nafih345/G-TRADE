// Bill & Invoice Designer — the data-field catalog and value formatting.
//
// A visual template stores only field ids ("totals.grandTotal"); this module resolves them
// against a BillModel (documentAdapters.toBillModel) at preview / print time. Ids, scopes and
// column keys mirror backend/apps/billing/bill_fields.py — keep the two in step (the backend
// test suite checks the id lists match).
//
// Money is never computed here: a missing amount resolves to null and prints as blank (or the
// row is dropped), never as 0 or a guessed value.

export const SALES_FAMILY = ['SALES_INVOICE', 'WHOLESALE_BILL', 'ORDER_BILL', 'QUOTATION', 'SALES_RETURN'];
export const PURCHASE_FAMILY = ['PURCHASE_BILL', 'PURCHASE_RETURN'];
export const RECEIPT_FAMILY = ['PAYMENT_RECEIPT'];
export const RETURN_TYPES = ['SALES_RETURN', 'PURCHASE_RETURN'];
export const ALL_DOC_TYPES = [...SALES_FAMILY, ...PURCHASE_FAMILY, ...RECEIPT_FAMILY];
export const ITEM_DOC_TYPES = ALL_DOC_TYPES.filter((d) => !RECEIPT_FAMILY.includes(d));

export const DOC_TYPE_LABELS = {
  SALES_INVOICE: 'Sales Invoice / Bill',
  WHOLESALE_BILL: 'Wholesale Bill',
  PURCHASE_BILL: 'Purchase Bill',
  ORDER_BILL: 'Order Bill / Job Slip',
  QUOTATION: 'Quotation',
  PAYMENT_RECEIPT: 'Payment Receipt',
  SALES_RETURN: 'Sales Return',
  PURCHASE_RETURN: 'Purchase Return',
};
// Older slugs callers still send.
export const DOC_TYPE_ALIASES = { RETURN_BILL: 'SALES_RETURN' };
export const canonicalDocType = (t) => DOC_TYPE_ALIASES[t] || t;

const f = (id, label, group, kind = 'text', scope = null, extra = {}) => ({ id, label, group, kind, scope, ...extra });

export const FIELD_GROUPS = ['Company', 'Document', 'Customer / Supplier', 'Totals', 'Payment', 'Receipt', 'Return'];

export const BILL_FIELDS = [
  f('company.name', 'Store name', 'Company'),
  f('company.tagline', 'Tagline', 'Company'),
  f('company.address', 'Store address', 'Company', 'multiline'),
  f('company.phone', 'Store phone', 'Company'),
  f('company.email', 'Store email', 'Company'),
  f('company.website', 'Website', 'Company'),
  f('company.gstin', 'Store GSTIN', 'Company'),
  f('company.pan', 'Store PAN', 'Company'),
  f('company.bankDetails', 'Bank details', 'Company', 'multiline'),
  f('company.upiId', 'UPI ID', 'Company'),
  f('company.logo', 'Logo', 'Company', 'image'),

  f('document.title', 'Document title', 'Document'),
  f('document.number', 'Document number', 'Document'),
  f('document.orderNumber', 'Order / linked number', 'Document'),
  f('document.reference', 'Reference / supplier invoice no', 'Document'),
  f('document.date', 'Document date', 'Document', 'date'),
  f('document.dueDate', 'Due / valid-until date', 'Document', 'date'),
  f('document.deliveryDate', 'Delivery date', 'Document', 'date', SALES_FAMILY),
  f('document.status', 'Document status', 'Document'),
  f('document.paymentStatus', 'Payment status', 'Document'),
  f('document.fulfillmentStatus', 'Order stage', 'Document', 'text', ['ORDER_BILL', 'SALES_INVOICE']),
  f('document.branch', 'Branch', 'Document'),
  f('document.salesperson', 'Salesperson / optometrist', 'Document'),
  f('document.preparedBy', 'Prepared by (user)', 'Document'),
  f('document.printedAt', 'Printed on', 'Document', 'datetime'),
  f('document.notes', 'Document notes', 'Document', 'multiline'),
  f('document.terms', 'Document terms', 'Document', 'multiline'),

  f('party.label', 'Party heading (Bill To / Supplier)', 'Customer / Supplier'),
  f('party.name', 'Customer / supplier name', 'Customer / Supplier'),
  f('party.code', 'Customer / supplier code', 'Customer / Supplier'),
  f('party.phone', 'Phone', 'Customer / Supplier'),
  f('party.email', 'Email', 'Customer / Supplier'),
  f('party.address', 'Billing address', 'Customer / Supplier', 'multiline'),
  f('party.gstin', 'GSTIN', 'Customer / Supplier'),
  f('party.shippingAddress', 'Shipping address', 'Customer / Supplier', 'multiline'),

  f('totals.subtotal', 'Subtotal', 'Totals', 'money'),
  f('totals.discount', 'Discount', 'Totals', 'money'),
  f('totals.additionalDiscount', 'Additional discount', 'Totals', 'money'),
  f('totals.taxableAmount', 'Taxable amount', 'Totals', 'money'),
  f('totals.tax', 'Total tax', 'Totals', 'money'),
  f('totals.cgst', 'CGST', 'Totals', 'money'),
  f('totals.sgst', 'SGST', 'Totals', 'money'),
  f('totals.igst', 'IGST', 'Totals', 'money'),
  f('totals.cess', 'Cess', 'Totals', 'money'),
  f('totals.shipping', 'Shipping / delivery', 'Totals', 'money'),
  f('totals.otherCharges', 'Other charges', 'Totals', 'money'),
  f('totals.roundOff', 'Round off', 'Totals', 'money'),
  f('totals.grandTotal', 'Grand total', 'Totals', 'money'),
  f('totals.paid', 'Amount paid', 'Totals', 'money'),
  f('totals.balance', 'Balance / outstanding', 'Totals', 'money'),
  f('totals.refund', 'Refund amount', 'Totals', 'money', RETURN_TYPES),
  f('totals.amountInWords', 'Grand total in words', 'Totals', 'text'),
  f('totals.itemCount', 'Number of items', 'Totals', 'number'),
  f('totals.totalQty', 'Total quantity', 'Totals', 'number'),

  f('payment.method', 'Payment method', 'Payment'),
  f('payment.reference', 'Payment reference', 'Payment'),
  f('payment.splits', 'Payment split (per mode)', 'Payment'),
  f('payment.status', 'Payment state', 'Payment'),

  f('receipt.amount', 'Amount received', 'Receipt', 'money', RECEIPT_FAMILY),
  f('receipt.invoiceNumber', 'Paid against bill', 'Receipt', 'text', RECEIPT_FAMILY),

  f('return.reason', 'Return reason', 'Return', 'text', RETURN_TYPES),
  f('return.originalInvoice', 'Original bill number', 'Return', 'text', RETURN_TYPES),
  f('return.action', 'Return action / status', 'Return', 'text', RETURN_TYPES),
];
export const FIELD_BY_ID = Object.fromEntries(BILL_FIELDS.map((x) => [x.id, x]));

// Items-table columns.
const c = (key, label, kind, align, width, scope = null) => ({ key, label, kind, align, width, scope });
export const ITEM_COLUMNS = [
  c('slno', '#', 'index', 'center', 5),
  c('name', 'Item / Description', 'text', 'left', 34),
  c('description', 'Description', 'text', 'left', 20),
  c('brand', 'Brand', 'text', 'left', 10),
  c('sku', 'SKU / Code', 'text', 'left', 11),
  c('barcode', 'Barcode', 'text', 'left', 12),
  c('hsn', 'HSN', 'text', 'center', 8),
  c('variant', 'Variant', 'text', 'left', 12),
  c('size', 'Size', 'text', 'center', 7),
  c('color', 'Colour', 'text', 'center', 9),
  c('power', 'Power (Rx)', 'text', 'left', 18, SALES_FAMILY),
  c('batch', 'Batch', 'text', 'left', 10, PURCHASE_FAMILY),
  c('expiry', 'Expiry', 'date', 'center', 10, PURCHASE_FAMILY),
  c('qty', 'Qty', 'qty', 'center', 7),
  c('freeQty', 'Free', 'qty', 'center', 6, PURCHASE_FAMILY),
  c('unit', 'Unit', 'text', 'center', 6),
  c('mrp', 'MRP', 'money', 'right', 11, PURCHASE_FAMILY),
  c('rate', 'Rate', 'money', 'right', 11),
  c('discount', 'Discount', 'money', 'right', 10),
  c('discountPercent', 'Disc %', 'percent', 'right', 7),
  c('taxPercent', 'GST %', 'percent', 'right', 7),
  c('taxAmount', 'GST Amt', 'money', 'right', 10),
  c('total', 'Amount', 'money', 'right', 13),
];
export const COLUMN_BY_KEY = Object.fromEntries(ITEM_COLUMNS.map((x) => [x.key, x]));

export const TOTALS_ROWS = [
  { key: 'subtotal', label: 'Subtotal' },
  { key: 'discount', label: 'Discount', negative: true },
  { key: 'additionalDiscount', label: 'Additional Discount', negative: true },
  { key: 'taxableAmount', label: 'Taxable Amount' },
  { key: 'cgst', label: 'CGST' },
  { key: 'sgst', label: 'SGST' },
  { key: 'igst', label: 'IGST' },
  { key: 'cess', label: 'Cess' },
  { key: 'tax', label: 'Total Tax' },
  { key: 'shipping', label: 'Shipping / Delivery' },
  { key: 'otherCharges', label: 'Other Charges' },
  { key: 'roundOff', label: 'Round Off' },
  { key: 'grandTotal', label: 'Grand Total', grand: true },
  { key: 'paid', label: 'Amount Paid' },
  { key: 'balance', label: 'Balance Due' },
  { key: 'refund', label: 'Refund Amount' },
];
export const TOTALS_ROW_BY_KEY = Object.fromEntries(TOTALS_ROWS.map((x) => [x.key, x]));

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

const isBlank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
const finite = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

/** Raw value for a field id (strings, numbers or null) — no formatting. */
export function rawField(model, id) {
  if (!model || !id) return null;
  const [group, key] = id.split('.');
  const m = model;
  switch (group) {
    case 'company':
      if (key === 'logo') return m.company?.logoDataUrl || null;
      return m.company?.[key] ?? null;
    case 'document':
      return m.document?.[key] ?? null;
    case 'party': {
      const p = m.party || m.customer || {};
      return p[key] ?? null;
    }
    case 'totals': {
      if (key === 'amountInWords') {
        const g = finite(m.totals?.grandTotal);
        return g === null ? null : amountInWords(g, m.company?.currency || '₹');
      }
      if (key === 'itemCount') return Array.isArray(m.items) ? m.items.length : null;
      if (key === 'totalQty') {
        if (!Array.isArray(m.items) || !m.items.length) return null;
        const q = m.items.map((it) => finite(it.qty));
        return q.some((x) => x === null) ? null : Math.round(q.reduce((a, b) => a + b, 0) * 1000) / 1000;
      }
      return finite(m.totals?.[key]);
    }
    case 'payment':
      if (key === 'splits') {
        const splits = (m.payment?.splits || []).filter((s) => finite(s.amount));
        return splits.length ? splits : null;
      }
      return m.payment?.[key] ?? null;
    case 'receipt':
      return key === 'amount' ? finite(m.receipt?.amount) : (m.receipt?.[key] ?? null);
    case 'return':
      return m.return?.[key] ?? null;
    default:
      return null;
  }
}

/** Formatted display string ('' when the document has no value). */
export function fieldText(model, id, fmt = {}) {
  const def = FIELD_BY_ID[id];
  const raw = rawField(model, id);
  if (isBlank(raw)) return '';
  const kind = def?.kind || 'text';
  if (id === 'payment.splits') {
    return raw.map((s) => `${s.mode}: ${formatMoney(s.amount, fmtWithCurrency(fmt, model))}`).join(', ');
  }
  if (kind === 'money') return formatMoney(raw, fmtWithCurrency(fmt, model));
  if (kind === 'date') return formatDate(raw, fmt.dateFormat);
  if (kind === 'datetime') return formatDateTime(raw, fmt.dateFormat);
  if (kind === 'number') return String(raw);
  if (kind === 'image') return raw;
  return String(raw);
}

export const fmtWithCurrency = (fmt = {}, model) => ({
  ...fmt,
  currencySymbol: fmt.currencySymbol !== undefined ? fmt.currencySymbol : (model?.company?.currency || '₹'),
});

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function groupDigits(intStr, style) {
  if (style === 'none') return intStr;
  if (style === 'international') return intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  // Indian: last three digits, then pairs (12,34,567).
  if (intStr.length <= 3) return intStr;
  const last3 = intStr.slice(-3);
  const rest = intStr.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${rest},${last3}`;
}

export function formatNumber(v, { decimals = 2, thousands = 'indian' } = {}) {
  const n = finite(v);
  if (n === null) return '';
  const neg = n < 0;
  const fixed = Math.abs(n).toFixed(decimals);
  const [i, d] = fixed.split('.');
  const body = groupDigits(i, thousands) + (d ? `.${d}` : '');
  return (neg && Number(fixed) !== 0 ? '-' : '') + body;
}

export function formatMoney(v, fmt = {}) {
  const n = finite(v);
  if (n === null) return '';
  if (n === 0 && fmt.zeroAsDash) return '—';
  const decimals = fmt.decimals ?? 2;
  const body = formatNumber(Math.abs(n), { decimals, thousands: fmt.thousands || 'indian' });
  const sym = fmt.currencySymbol ?? '₹';
  return `${n < 0 && Number(Math.abs(n).toFixed(decimals)) !== 0 ? '-' : ''}${sym}${body}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  const s = String(v ?? '').trim();
  if (!s) return null;
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] || 0), Number(m[5] || 0));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(v, pattern = 'DD-MM-YYYY') {
  const d = parseDate(v);
  if (!d) return String(v ?? '');
  const DD = String(d.getDate()).padStart(2, '0');
  const MM = String(d.getMonth() + 1).padStart(2, '0');
  const YYYY = String(d.getFullYear());
  const MMM = MONTHS[d.getMonth()];
  switch (pattern) {
    case 'DD/MM/YYYY': return `${DD}/${MM}/${YYYY}`;
    case 'DD.MM.YYYY': return `${DD}.${MM}.${YYYY}`;
    case 'YYYY-MM-DD': return `${YYYY}-${MM}-${DD}`;
    case 'DD MMM YYYY': return `${DD} ${MMM} ${YYYY}`;
    case 'MMM DD, YYYY': return `${MMM} ${DD}, ${YYYY}`;
    default: return `${DD}-${MM}-${YYYY}`;
  }
}

export function formatDateTime(v, pattern) {
  const d = parseDate(v);
  if (!d) return String(v ?? '');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d, pattern)} ${hh}:${mi}`;
}

export const DATE_FORMATS = ['DD-MM-YYYY', 'DD/MM/YYYY', 'DD.MM.YYYY', 'YYYY-MM-DD', 'DD MMM YYYY', 'MMM DD, YYYY'];

// ---------------------------------------------------------------------------
// Amount in words (Indian numbering: thousand, lakh, crore)
// ---------------------------------------------------------------------------

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
  'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

function below100(n) {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${ONES[n % 10]}` : ''}`;
}
function below1000(n) {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? below100(r) : ''].filter(Boolean).join(' ');
}
function indianWords(n) {
  if (n === 0) return 'Zero';
  const parts = [];
  const crore = Math.floor(n / 10000000);
  n %= 10000000;
  const lakh = Math.floor(n / 100000);
  n %= 100000;
  const thousand = Math.floor(n / 1000);
  n %= 1000;
  if (crore) parts.push(`${crore > 99 ? indianWords(crore) : below100(crore)} Crore`);
  if (lakh) parts.push(`${below100(lakh)} Lakh`);
  if (thousand) parts.push(`${below100(thousand)} Thousand`);
  if (n) parts.push(below1000(n));
  return parts.join(' ');
}

export function amountInWords(value, currency = '₹') {
  const n = finite(value);
  if (n === null) return '';
  const abs = Math.abs(n);
  let whole = Math.floor(abs + 1e-9);
  let paise = Math.round((abs - whole) * 100);
  if (paise === 100) { whole += 1; paise = 0; }
  const rupee = currency === '₹' || currency === 'Rs' || currency === 'Rs.' || currency === 'INR';
  const main = rupee ? `Rupees ${indianWords(whole)}` : indianWords(whole);
  const tail = paise ? (rupee ? ` and ${below100(paise)} Paise` : ` and ${paise}/100`) : '';
  return `${n < 0 ? 'Minus ' : ''}${main}${tail} Only`;
}

// ---------------------------------------------------------------------------
// Template introspection / compatibility (mirror of bill_fields.compatible_document_types)
// ---------------------------------------------------------------------------

const TOKEN_RE = /\{\{\s*([a-zA-Z]+\.[a-zA-Z]+)\s*\}\}/g;
export const tokensIn = (text) => [...String(text || '').matchAll(TOKEN_RE)].map((m) => m[1]);
export const ITEM_ELEMENT_TYPES = new Set(['taxSummary']);

function elementFields(el) {
  const out = new Set();
  if (el.field) out.add(el.field);
  if (el.visibleIf) out.add(el.visibleIf);
  (el.fields || []).forEach((r) => r?.field && out.add(r.field));
  if (el.type === 'text') tokensIn(el.text).forEach((t) => out.add(t));
  if (el.type === 'totals') (el.rows || []).forEach((r) => out.add(`totals.${r.key}`));
  return out;
}

export function usedFields(config) {
  const fields = new Set();
  const cols = new Set();
  let needsItems = false;
  const bands = config?.bands || {};
  ['header', 'summary', 'footer'].forEach((b) => {
    (bands[b]?.elements || []).forEach((el) => {
      if (el.hidden) return;
      elementFields(el).forEach((x) => fields.add(x));
      if (ITEM_ELEMENT_TYPES.has(el.type)) needsItems = true;
    });
  });
  const items = bands.items || {};
  if (items.visible !== false) {
    needsItems = true;
    (items.table?.columns || []).forEach((col) => { if (col.visible !== false) cols.add(col.key); });
  }
  return { fields, cols, needsItems };
}

export function compatibleDocTypes(config) {
  if (config?.schema !== 2) return [...ALL_DOC_TYPES];
  const { fields, cols, needsItems } = usedFields(config);
  let allowed = new Set(ALL_DOC_TYPES);
  const narrow = (scope) => { if (scope) allowed = new Set([...allowed].filter((d) => scope.includes(d))); };
  if (needsItems) narrow(ITEM_DOC_TYPES);
  fields.forEach((id) => narrow(FIELD_BY_ID[id]?.scope));
  cols.forEach((k) => narrow(COLUMN_BY_KEY[k]?.scope));
  return ALL_DOC_TYPES.filter((d) => allowed.has(d));
}

export function incompatibilityReason(config, docType) {
  const dt = canonicalDocType(docType);
  if (config?.schema !== 2 || compatibleDocTypes(config).includes(dt)) return '';
  const { fields, cols, needsItems } = usedFields(config);
  if (needsItems && !ITEM_DOC_TYPES.includes(dt)) return 'it has an items table, and this document has no line items';
  for (const id of [...fields].sort()) {
    const scope = FIELD_BY_ID[id]?.scope;
    if (scope && !scope.includes(dt)) return `it uses “${FIELD_BY_ID[id].label}”, which this document does not have`;
  }
  for (const k of [...cols].sort()) {
    const scope = COLUMN_BY_KEY[k]?.scope;
    if (scope && !scope.includes(dt)) return `its items table shows the “${COLUMN_BY_KEY[k].label}” column, which this document does not have`;
  }
  return 'its data requirements do not match this document';
}

/** Fields (by id) the picker should offer for a set of target document types. */
export function fieldsForDocTypes(docTypes) {
  const want = (docTypes && docTypes.length ? docTypes : ALL_DOC_TYPES).map(canonicalDocType);
  return BILL_FIELDS.filter((x) => !x.scope || want.some((d) => x.scope.includes(d)));
}
