// Wholesale Orders & Quotations — pure helpers shared by the Orders / Quotations screen
// (pages/WholesaleOrders.jsx) and the Wholesale POS (order → sale). No React here.
//
// Server side: apps/sales/wholesale_orders.py. An order line is the same shape as a Wholesale
// POS cart line (id = backend Product UUID, qty, freeQty, rate excl. tax, gst, discount,
// taxInclusive / inclRate …), so a confirmed order loads straight into the POS grid.
//
// Stock: a CONFIRMED order reserves its units (Stock Overview "Ordered"); the POS bill that
// carries `linkedOrder` deducts them and closes the order (BILLED). Quotations reserve nothing.

import { computeLineTotals, resolvePriceForDealer } from './wholesaleConstants.js';
import { pricedLine, parseTaxPercent, round2 } from '../../utils/wholesalePricing.js';

export const ORDER_STATUS = { CONFIRMED: 'CONFIRMED', BILLED: 'BILLED', CANCELLED: 'CANCELLED' };
export const QUOTE_STATUS = {
  OPEN: 'QUOTATION', ORDERED: 'CONVERTED_TO_ORDER', BILLED: 'CONVERTED_TO_SALE', CANCELLED: 'CANCELLED',
};

export const STATUS_META = {
  CONFIRMED: { label: 'Confirmed', color: 'primary' },
  BILLED: { label: 'Billed', color: 'success' },
  CANCELLED: { label: 'Cancelled', color: 'default' },
  QUOTATION: { label: 'Open', color: 'warning' },
  CONVERTED_TO_ORDER: { label: 'Ordered', color: 'primary' },
  CONVERTED_TO_SALE: { label: 'Billed', color: 'success' },
};

// What the two document kinds are called / where they live on the server.
export const DOC_KINDS = {
  order: {
    endpoint: 'orders', numberField: 'order_number', dateField: 'order_date', totalField: 'total_amount',
    noun: 'Order', title: 'Wholesale Orders', printTitle: 'WHOLESALE ORDER',
  },
  quotation: {
    endpoint: 'quotations', numberField: 'quotation_number', dateField: 'date', totalField: 'grand_total',
    noun: 'Quotation', title: 'Wholesale Quotations', printTitle: 'QUOTATION / ESTIMATE',
  },
};

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

// Units a line takes out of stock (free quantity leaves the warehouse too).
export const lineUnits = (line) => (String(line?.itemType || 'PRODUCT').toUpperCase() === 'SERVICE'
  ? 0 : Math.max(0, Math.round(num(line?.qty) + num(line?.freeQty))));

// Reserved units per product from GET /wholesale/orders/availability/ ({wholesale, retail}).
export function reservedUnits(reservations, productId) {
  if (!reservations || !productId) return 0;
  const id = String(productId);
  return num(reservations.wholesale?.[id]) + num(reservations.retail?.[id]);
}

// {productId: units} reserved by open orders, wholesale + retail together.
export function combineReservations(reservations) {
  const out = {};
  [reservations?.wholesale, reservations?.retail].forEach((m) => {
    Object.entries(m || {}).forEach(([id, units]) => { out[id] = (out[id] || 0) + num(units); });
  });
  return out;
}

// Free-to-sell figure: on hand − units already reserved by other open orders (never < 0).
export function availableUnits(product, reservations) {
  const onHand = num(product?.availableStock ?? product?.stock);
  return Math.max(0, onHand - reservedUnits(reservations, product?.id));
}

// A new order / quotation line for `product`, priced for `dealer` exactly as the POS would.
export function buildOrderLine(product, dealer, qty = 1, { specialPrices = {}, priceListRows = [] } = {}) {
  const { rate, tier } = resolvePriceForDealer(product, dealer, specialPrices, qty, priceListRows);
  const dash = (v) => (v && v !== '—' ? v : '');
  const line = {
    itemType: 'PRODUCT',
    id: String(product.id),
    barcode: product.barcode || product.code || '',
    code: product.code || product.sku || '',
    sku: product.sku || product.code || '',
    name: product.name,
    brand: dash(product.brand),
    category: dash(product.category),
    modelNo: dash(product.modelNo),
    color: dash(product.color),
    size: dash(product.size),
    hsn: product.hsn || '',
    unit: product.unit || 'Pcs',
    qty,
    freeQty: 0,
    priceTier: tier,
    discount: 0,
    gst: parseTaxPercent(product.gst) ?? 18,
    taxCategory: product.taxCategory || '',
    mrp: num(product.mrp) || null,
    notes: '',
  };
  return pricedLine(line, rate, Boolean(product.taxInclusive));
}

// Totals in the POS invoice summary shape (rates are tax-exclusive).
export function summarizeLines(lines = []) {
  let totalQty = 0;
  let subtotal = 0;
  let totalDiscount = 0;
  let totalGst = 0;
  let grandTotal = 0;
  lines.forEach((line) => {
    const t = computeLineTotals(line);
    totalQty += num(line.qty);
    subtotal += t.base;
    totalDiscount += t.lineDiscount;
    totalGst += t.gst;
    grandTotal += t.total;
  });
  return {
    totalItems: lines.length,
    totalQty,
    subtotal: round2(subtotal),
    totalDiscount: round2(totalDiscount),
    totalGst: round2(totalGst),
    grandTotal: round2(grandTotal),
  };
}

// Line problems shown in the grid and enforced on save: {index: message}.
export function lineProblems(lines = []) {
  const out = {};
  lines.forEach((line, i) => {
    const q = Number(line.qty);
    if (line.qty === '' || !Number.isFinite(q) || q < 1) out[i] = 'Quantity must be at least 1';
    else if (!(num(line.rate) >= 0)) out[i] = 'Price must be 0 or more';
    else if (num(line.discount) < 0 || num(line.discount) > 100) out[i] = 'Discount must be 0 – 100%';
  });
  return out;
}

// Dealer snapshot kept on the document (the dealer row may change later).
export const dealerSnapshot = (d) => (d ? {
  id: d.id, code: d.code || '', name: d.name || '', phone: d.phone || '', gstin: d.gstin || '',
  contactPerson: d.contactPerson || '', billingAddress: d.billingAddress || '',
  shippingAddress: d.shippingAddress || '', priceList: d.priceList || '',
} : null);

// Lines as saved: numbers, never half-typed text.
export const cleanLines = (lines = []) => lines.map((line) => {
  const out = { ...line };
  ['qty', 'freeQty', 'rate', 'inclRate', 'discount', 'gst'].forEach((k) => {
    if (out[k] === undefined || out[k] === null) return;
    if (typeof out[k] === 'string') out[k] = out[k] === '' ? 0 : (Number(out[k]) || 0);
  });
  return out;
});

export function docToApi(kind, { dealer, lines, notes = '', expiryDate, terms } = {}) {
  const meta = DOC_KINDS[kind];
  const items = cleanLines(lines);
  const summary = summarizeLines(items);
  const body = {
    dealer: dealer?.id,
    details: { items, summary, dealer: dealerSnapshot(dealer), notes },
  };
  body[meta.totalField] = summary.grandTotal.toFixed(2);
  if (kind === 'quotation') {
    body.subtotal = (summary.subtotal - summary.totalDiscount).toFixed(2);
    body.tax_amount = summary.totalGst.toFixed(2);
    if (expiryDate) body.expiry_date = expiryDate;
    if (terms !== undefined) body.terms = terms;
  }
  return body;
}

export function docFromApi(kind, row) {
  const meta = DOC_KINDS[kind];
  const d = row?.details && typeof row.details === 'object' ? row.details : {};
  const items = Array.isArray(d.items) ? d.items : [];
  return {
    kind,
    id: row.id,
    number: row[meta.numberField],
    date: row[meta.dateField],
    status: row.status,
    dealerId: row.dealer,
    dealerName: row.dealer_name || d.dealer?.name || '',
    dealerCode: row.dealer_code || d.dealer?.code || '',
    dealer: d.dealer || null,
    items,
    summary: d.summary || summarizeLines(items),
    total: num(row[meta.totalField]),
    notes: d.notes || '',
    expiryDate: row.expiry_date || '',
    terms: row.terms || '',
    invoiceNumber: row.invoice_number || row.converted_invoice_number || '',
    orderNumber: row.converted_order_number || '',
    quotationRef: row.quotation_ref || d.quotationNumber || '',
    billedAt: row.billed_at || null,
    createdAt: row.created_at,
  };
}

export const isOpenDoc = (doc) => (doc?.kind === 'quotation'
  ? doc.status === QUOTE_STATUS.OPEN : doc?.status === ORDER_STATUS.CONFIRMED);

// The POS cart line for an order line: the order's agreed price / discount / tax over a fresh
// catalogue line (current names, MRP, cost), with `available` = what can be billed now.
export function orderLineToCartLine(orderLine, catalogueLine, available) {
  const keep = ['qty', 'freeQty', 'rate', 'inclRate', 'taxInclusive', 'discount', 'discountMode', 'discountAmount',
    'gst', 'priceTier', 'notes', 'isFreeGift'];
  const base = catalogueLine || { ...orderLine, batch: '', expiry: '', isFreeGift: false };
  const merged = { ...base };
  keep.forEach((k) => { if (orderLine[k] !== undefined) merged[k] = orderLine[k]; });
  if (!merged.taxInclusive) delete merged.inclRate;
  merged.availableStock = available;
  return merged;
}

// Document in the shape printBill's WHOLESALE_BILL adapter reads (no payment on an estimate).
export function docForPrint(doc, dealer) {
  const summary = doc.summary || summarizeLines(doc.items);
  return {
    invoiceNo: doc.number,
    id: doc.number,
    date: doc.date,
    dueDate: doc.expiryDate || '',
    customer: dealer || doc.dealer || { name: doc.dealerName },
    items: (doc.items || []).map((it) => ({ ...it, taxPercent: it.gst, total: computeLineTotals(it).total })),
    summary,
    payMode: '',
    amountReceived: 0,
    dueAmount: summary.grandTotal,
    status: doc.kind === 'quotation' ? 'Quotation' : 'Order',
    orderStatus: doc.status,
    notes: { customer: doc.notes || '', internal: '' },
    referenceNo: doc.quotationRef || '',
  };
}
