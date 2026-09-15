// Shared rules for Sales > Orders / Invoices / Quotations rows: who the bill is for, what's on it
// (frame / lens), how much of it is paid and where the spectacles are. The backend applies the same
// rules (apps/sales/models.py derive_payment_status / is_real_customer_name, InvoiceSerializer) —
// keep the two in step.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Names the billing screens write when no patient was picked — never a real customer.
const PLACEHOLDER_CUSTOMER_NAMES = new Set([
  'walk-in customer', 'walk-in patient', 'walk in customer', 'walk in patient', 'walk-in',
  'walkin', 'cash customer', 'customer', 'patient', 'unknown', 'n/a', 'na', 'none', 'null',
  'undefined', '-',
]);

export const isRealCustomerName = (name) => {
  if (typeof name !== 'string') return false;
  const text = name.trim().replace(/\s+/g, ' ');
  return Boolean(text) && !UUID_RE.test(text) &&
    !PLACEHOLDER_CUSTOMER_NAMES.has(text.toLowerCase()) && /\p{L}/u.test(text);
};

// The real customer name on a row, whichever shape it came in (API map, New Sale, POS), or ''.
export const rowCustomerName = (row) =>
  [row?.customer, row?.customerName, row?.customer_name].find(isRealCustomerName)?.trim() || '';

// ---- Money ------------------------------------------------------------------------------------
const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const firstGiven = (...vals) => vals.find(v => v !== undefined && v !== null && v !== '');
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// Net payable. `total` is the net amount on every row the Orders list builds; a raw New Sale
// localStorage copy only carries netTotal.
export const rowNetAmount = (row) => num(firstGiven(row?.total, row?.netTotal, row?.net_amount, row?.amount));
// Total Paid — everything received against the bill (billing split + later receipts).
export const rowPaidAmount = (row) =>
  num(firstGiven(row?.paidAmount, row?.totalPaidAmount, row?.paid_amount, row?.advancePaid));

// `short` is the value older code compares `row.payment` against ('Paid' / 'Partial' / 'Unpaid').
export const PAYMENT_STATUSES = {
  PAID: { key: 'PAID', label: 'Paid', short: 'Paid', color: 'success' },
  PARTIAL: { key: 'PARTIAL', label: 'Partially Paid', short: 'Partial', color: 'warning' },
  UNPAID: { key: 'UNPAID', label: 'Unpaid', short: 'Unpaid', color: 'error' },
};

// Paid when Total Paid covers the net payable, Partially Paid while some of it is in, Unpaid
// when nothing is.
export const paymentStatusOf = (net, paid) => {
  const n = round2(net);
  const p = round2(paid);
  if (p <= 0 && n > 0) return PAYMENT_STATUSES.UNPAID;
  return p >= n ? PAYMENT_STATUSES.PAID : PAYMENT_STATUSES.PARTIAL;
};

// Computed from the row's figures every time, so the badge follows any payment the moment the
// row changes (never a stored label that can drift from the amounts).
export const rowPayment = (row) => {
  const net = rowNetAmount(row);
  const paid = rowPaidAmount(row);
  return { ...paymentStatusOf(net, paid), net, paid, balance: Math.max(0, round2(net - paid)) };
};

// ---- Delivery ---------------------------------------------------------------------------------
export const DELIVERY_STATUSES = {
  PENDING: { key: 'PENDING', label: 'Pending', color: 'default' },
  PROCESSING: { key: 'PROCESSING', label: 'Processing', color: 'warning' },
  READY: { key: 'READY', label: 'Ready for Pickup', color: 'info' },
  DELIVERED: { key: 'DELIVERED', label: 'Delivered', color: 'success' },
};

// Lab pipeline stage (Invoice.fulfillment_status: Order Received → In Lab Processing → … →
// Delivered) → the delivery status the counter tells the customer.
export const deliveryStatusOf = (stage) => {
  const s = String(stage || '').trim().toLowerCase();
  if (!s || s === 'order received' || s === 'pending' || s === 'draft') return DELIVERY_STATUSES.PENDING;
  if (s.startsWith('delivered') || s === 'collected' || s === 'completed') return DELIVERY_STATUSES.DELIVERED;
  if (s.startsWith('ready')) return DELIVERY_STATUSES.READY;
  return DELIVERY_STATUSES.PROCESSING;
};

// ---- Frame / lens -----------------------------------------------------------------------------
// Synthetic filler older rows carry instead of a real name. NOT the bare words "Frame" / "Lens":
// a shop's stock is often named exactly that, and treating them as filler blanked real bills.
const PLACEHOLDER_ITEM_NAMES = new Set(['prescribed frame', 'prescribed lens', 'n/a', '-', '—']);
const realItemName = (value) => {
  const text = String(value ?? '').trim();
  return text && !UUID_RE.test(text) && !PLACEHOLDER_ITEM_NAMES.has(text.toLowerCase()) ? text : '';
};
// New Sale writes '—' for "no colour".
const realAttr = (value) => {
  const text = String(value ?? '').trim();
  return text && text !== '—' && text !== '-' ? text : '';
};
// "Sky Blue" + "Frame" → "Sky Blue Frame" — the same naming as the backend's InvoiceItem display_name.
const withColour = (name, colour) =>
  (name && colour && !name.toLowerCase().includes(colour.toLowerCase()) ? `${colour} ${name}` : name);

const ACCESSORY_WORDS = ['accessor', 'solution', 'cleaner', 'cleaning', 'cloth', 'spray', 'service', 'repair'];
const FRAME_WORDS = ['frame', 'sunglass', 'goggle', 'spectacle'];
const classifyWords = (text) => {
  const t = String(text || '').toLowerCase();
  if (ACCESSORY_WORDS.some(w => t.includes(w))) return 'OTHER';
  if (t.includes('lens')) return 'LENS';
  if (FRAME_WORDS.some(w => t.includes(w))) return 'FRAME';
  return null;
};

// Frame / lens names from a row's own line items (New Sale: {item, color, category}, POS: {name},
// database lines: {item: display_name, color, category}).
export const summarizeLines = (items) => {
  const frames = [];
  const lenses = [];
  const all = [];
  const add = (list, name) => { if (!list.includes(name)) list.push(name); };
  (Array.isArray(items) ? items : []).forEach((it) => {
    if (!it) return;
    const name = withColour(
      realItemName(it.item || it.name || it.description || it.product_name),
      realAttr(it.color || it.colour)
    );
    if (!name) return;
    add(all, name);
    const type = String(it.itemType || it.item_type || '').toUpperCase();
    const kind = type === 'SERVICE' || type === 'LENS'
      ? type
      : (classifyWords(it.category || it.type) || classifyWords(name) || 'FRAME');
    if (kind === 'FRAME') add(frames, name);
    if (kind === 'LENS') add(lenses, name);
  });
  return { frame: frames.join(', '), lens: lenses.join(', '), summary: all.join(', ') };
};

export const rowFrameLens = (row) => {
  const lines = summarizeLines(row?.items);
  return {
    frame: realItemName(row?.frame) || lines.frame,
    lens: realItemName(row?.lens) || lines.lens,
    summary: realItemName(row?.itemsSummary) || lines.summary,
  };
};

// One consistent shape for an Orders-list row, whichever screen produced it.
export const normalizeSalesRow = (row) => {
  const pay = rowPayment(row);
  const lines = rowFrameLens(row);
  const customer = rowCustomerName(row);
  return {
    ...row,
    documentType: String(row.documentType || row.docType || 'INVOICE').toUpperCase(),
    customer: customer || 'Walk-in Customer',
    customerName: customer || row.customerName || '',
    total: pay.net,
    paidAmount: pay.paid,
    balanceDue: pay.balance,
    payment: pay.short,
    frame: lines.frame,
    lens: lines.lens,
    itemsSummary: lines.summary,
  };
};
