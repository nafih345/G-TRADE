// Inventory → Opening Stock: the item fields both entry methods fill (manual grid and Excel
// column mapping) and how a server check result reads on screen. The server re-checks everything.
import { formatCurrency, getCurrencySymbol } from '../../../utils/localeFormat.js';

export const OPENING_FIELDS = [
  { key: 'name', label: 'Item Name', required: true, max: 255 },
  { key: 'barcode', label: 'Barcode / Code', max: 150, mono: true },
  { key: 'category', label: 'Category', max: 150, list: 'categories' },
  { key: 'brand', label: 'Brand', max: 150, list: 'brands' },
  { key: 'quantity', label: 'Opening Qty', required: true, numeric: true },
  { key: 'cost_price', get label() { return `Cost Price ${getCurrencySymbol()}`; }, required: true, numeric: true, money: true },
  { key: 'mrp', get label() { return `MRP / Sales ${getCurrencySymbol()}`; }, numeric: true, money: true },
];
export const REQUIRED_FIELDS = OPENING_FIELDS.filter((f) => f.required).map((f) => f.key);
// Read live so money labels follow the active currency.
export const FIELD_LABEL = new Proxy({}, { get: (_, key) => OPENING_FIELDS.find((f) => f.key === key)?.label });

// The status check_rows gives each row. Only 'error' rows cannot be saved; 'duplicate' (the same
// item twice without a barcode) can, but the Excel preview leaves it unticked.
export const ROW_STATUS = {
  ok: { label: 'Ready', color: 'success' },
  warning: { label: 'Check', color: 'warning' },
  duplicate: { label: 'Duplicate', color: 'warning' },
  error: { label: 'Error', color: 'error' },
};

export const resultMessages = (res) => {
  if (!res) return [];
  const errs = Object.entries(res.errors || {}).map(([f, m]) => `${FIELD_LABEL[f] || f}: ${m}`);
  return [...errs, ...(res.warnings || [])];
};

const toNumber = (v) => {
  const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
export const lineValue = (row) => toNumber(row.quantity) * toNumber(row.cost_price);
export const totals = (rows) => rows.reduce((t, r) => ({
  qty: t.qty + toNumber(r.quantity), value: t.value + lineValue(r),
}), { qty: 0, value: 0 });

export const money = (n) => formatCurrency(n || 0);
