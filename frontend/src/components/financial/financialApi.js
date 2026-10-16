// Thin client for /api/financial/. Every Financial screen reads the books from the server —
// nothing here is cached in localStorage, because the posted ledger is the only source of truth.
import axios from 'axios';

export const FIN_API = '/api/financial';

export const apiError = (err, fallback = 'Request failed.') => {
  const data = err?.response?.data;
  if (!data) return err?.message || fallback;
  if (typeof data === 'string') return data.slice(0, 300);
  if (data.error) return data.error;
  if (data.detail) return data.detail;
  const parts = Object.entries(data).map(([k, v]) => `${k === 'non_field_errors' ? '' : `${k}: `}${Array.isArray(v) ? v.join(' ') : typeof v === 'object' ? JSON.stringify(v) : v}`);
  return parts.join(' • ') || fallback;
};

const qs = (params = {}) => {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ''));
  const s = new URLSearchParams(clean).toString();
  return s ? `?${s}` : '';
};

export const finGet = async (path, params) => (await axios.get(`${FIN_API}/${path}${qs(params)}`)).data;
export const finPost = async (path, body = {}) => (await axios.post(`${FIN_API}/${path}`, body)).data;
export const finPatch = async (path, body = {}) => (await axios.patch(`${FIN_API}/${path}`, body)).data;
export const finDelete = async (path) => (await axios.delete(`${FIN_API}/${path}`)).data;

export const newIdempotencyKey = () =>
  (window.crypto?.randomUUID ? window.crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const inr = (value) => {
  const n = parseFloat(value || 0) || 0;
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export const today = () => new Date().toISOString().split('T')[0];

export const SOURCE_LABELS = {
  'sales.invoice': 'Retail invoice',
  'sales.payment': 'Retail receipt',
  'sales.wholesale_invoice': 'Wholesale invoice',
  'sales.wholesale_collection': 'Wholesale collection',
  'sales.wholesale_return': 'Wholesale return',
  'purchasing.purchase_invoice': 'Purchase entry',
  'purchasing.purchase_payment': 'Purchase payment',
  'purchasing.purchase_order': 'Purchase order',
  'inventory.stock_adjustment': 'Stock adjustment',
  'financial.voucher': 'Manual voucher',
  'financial.opening_balance': 'Opening balance',
};

export const sourceLabel = (entry) => {
  const key = entry?.source_key || (entry?.source_module ? `${entry.source_module}.${entry.source_event}` : '');
  if (!key) return 'Manual / legacy';
  if (key.includes('legacy_duplicate')) return 'Legacy duplicate';
  return SOURCE_LABELS[key] || key;
};
