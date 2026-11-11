// Sales Return / Purchase Return API (backend apps/inventory/returns.py). One shape for both
// directions; `kind` is 'sales' or 'purchase'.
import axios from 'axios';
import { formatCurrency } from '../../utils/localeFormat.js';

export const RETURN_KINDS = {
  sales: {
    base: '/api/sales/returns/',
    title: 'Sales Return',
    party: 'Customer',
    original: 'Sale Invoice',
    stockText: 'Returned goods are added back to stock.',
    refundVerb: 'Refund paid from',
    bankLabel: 'Refund paid from (Bank Account)',
    creditText: 'Credit note — stays on the customer\'s account (reduces their receivable)',
  },
  purchase: {
    base: '/api/purchase/returns/',
    title: 'Purchase Return',
    party: 'Supplier',
    original: 'Purchase Bill',
    stockText: 'Returned goods are taken out of stock.',
    refundVerb: 'Refund received into',
    bankLabel: 'Refund received into (Bank Account)',
    creditText: 'Debit note — set off against what you owe the supplier (reduces payable)',
  },
};

// Mirrors returns_catalog.py (the /meta/ endpoint serves the same lists).
export const RETURN_REASONS = [
  { value: 'DAMAGED', label: 'Damaged' },
  { value: 'DEFECTIVE', label: 'Defective' },
  { value: 'POWER_MISMATCH', label: 'Power / Specification Mismatch' },
  { value: 'WRONG_ITEM', label: 'Wrong Item Delivered' },
  { value: 'EXCHANGE', label: 'Customer Exchange', needsNote: true },
  { value: 'OTHER', label: 'Other Issue', needsNote: true },
];
export const reasonNeedsNote = (v) => !!RETURN_REASONS.find((r) => r.value === v)?.needsNote;

export const SETTLEMENT_MODES = [
  { value: 'CASH', label: 'Cash' },
  { value: 'GPAY', label: 'GPay / UPI', needsBank: true, paymentMethod: 'UPI' },
  { value: 'BANK', label: 'Bank Transfer', needsBank: true, paymentMethod: 'Bank Transfer' },
  { value: 'CREDIT', label: 'Credit / Ledger Adjust' },
];
export const modeMeta = (v) => SETTLEMENT_MODES.find((m) => m.value === v) || {};

export const toNum = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
export const round2 = (n) => Math.round((toNum(n) + Number.EPSILON) * 100) / 100;
export const fmtMoney = (v) => `${formatCurrency(toNum(v))}`;
export const fmtDate = (d) => {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-');
  return y && m && day ? `${day}-${m}-${y}` : String(d);
};
// Local calendar date (the server runs on UTC; never use toISOString for "today").
export const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const searchSourceDocuments = async (kind, search) =>
  (await axios.get(`${RETURN_KINDS[kind].base}source-documents/`, { params: { search } })).data || [];

export const fetchReturnable = async (kind, documentId) =>
  (await axios.get(`${RETURN_KINDS[kind].base}returnable/`, { params: { document: documentId } })).data;

export const createReturn = async (kind, body) => (await axios.post(RETURN_KINDS[kind].base, body)).data;

export const cancelReturn = async (kind, id, reason) =>
  (await axios.post(`${RETURN_KINDS[kind].base}${id}/cancel/`, { reason })).data;

export const fetchReturn = async (kind, id) => (await axios.get(`${RETURN_KINDS[kind].base}${id}/`)).data;

export const fetchReturnList = async (kind, params) =>
  (await axios.get(RETURN_KINDS[kind].base, { params: { page_size: 100, ...params } })).data;

export const fetchReturnReport = async (kind, params) =>
  (await axios.get(`${RETURN_KINDS[kind].base}report/`, { params })).data;

// The bill engine's document type for each kind (Settings → Bill & Invoice Designer templates).
export const RETURN_DOC_TYPES = { sales: 'SALES_RETURN', purchase: 'PURCHASE_RETURN' };

/** A serialized return (API shape) → the doc printBill's SALES_RETURN / PURCHASE_RETURN adapters
 *  read (billing/documentAdapters.js adaptSalesLike / adaptPurchase). */
export function returnPrintDoc(kind, r) {
  const reasons = (r.items || []).map((i) => [i.return_reason_label, i.reason_notes].filter(Boolean).join(' — '));
  const reason = [...new Set(reasons.filter(Boolean))].join('; ');
  const modeLabel = (s) => `${modeMeta(s.mode).label || s.mode}${s.bank_name ? ` (${s.bank_name})` : ''}`;
  const common = {
    returnNo: r.return_number, return_number: r.return_number, date: r.return_date, return_date: r.return_date,
    reason, originalInvoice: r.original?.number || '', notes: r.general_remarks || '',
    tax_amount: r.tax_amount,
  };
  if (kind === 'purchase') {
    return {
      ...common,
      supplierName: r.party?.name || '', supplier_phone: r.party?.phone || '',
      supplier_invoice_number: r.original?.supplier_invoice_number || '',
      items: (r.items || []).map((i) => ({
        name: i.description, sku: i.sku, barcode: i.barcode, quantity: i.return_qty, rate: i.unit_price,
        tax_rate: i.tax_rate, tax_amount: i.tax_amount, line_total: i.line_total,
      })),
      gross_amount: r.subtotal, grand_total: r.total_amount, creditAmount: r.total_refund_amount,
      payment_method: r.settlement_text || r.payment_mode_label, status: r.status === 'CANCELLED' ? 'CANCELLED' : '',
    };
  }
  return {
    ...common,
    customerName: r.party?.name || '', customerPhone: r.party?.phone || '',
    items: (r.items || []).map((i) => ({
      name: i.description, sku: i.sku, barcode: i.barcode, qty: i.return_qty, unit_price: i.unit_price,
      tax_rate: i.tax_rate, tax_amount: i.tax_amount, total: i.line_total,
    })),
    grossTotal: r.subtotal, netTotal: r.total_amount, totalTax: r.tax_amount, refundAmount: r.total_refund_amount,
    paymentMethod: r.settlement_text || r.payment_mode_label,
    payment_splits: (r.settlements || []).map((s) => ({ mode: modeLabel(s), amount: s.amount })),
  };
}
