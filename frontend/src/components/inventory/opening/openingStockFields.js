// Inventory → Opening Stock: the item fields both entry methods fill (manual grid and Excel
// column mapping) and how a server check result reads on screen. The server re-checks everything.

export const OPENING_FIELDS = [
  { key: 'name', label: 'Item Name', required: true, max: 255 },
  { key: 'barcode', label: 'Barcode / Code', max: 150, mono: true },
  { key: 'category', label: 'Category', max: 150, list: 'categories' },
  { key: 'brand', label: 'Brand', max: 150, list: 'brands' },
  { key: 'quantity', label: 'Opening Qty', required: true, numeric: true },
  { key: 'cost_price', label: 'Cost Price ₹', required: true, numeric: true, money: true },
  { key: 'mrp', label: 'MRP / Sales ₹', numeric: true, money: true },
];
export const REQUIRED_FIELDS = OPENING_FIELDS.filter((f) => f.required).map((f) => f.key);
export const FIELD_LABEL = Object.fromEntries(OPENING_FIELDS.map((f) => [f.key, f.label]));

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
  const n = Number(String(v ?? '').replace(/[,₹\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};
export const lineValue = (row) => toNumber(row.quantity) * toNumber(row.cost_price);
export const totals = (rows) => rows.reduce((t, r) => ({
  qty: t.qty + toNumber(r.quantity), value: t.value + lineValue(r),
}), { qty: 0, value: 0 });

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const money = (n) => `₹${inr.format(n || 0)}`;
