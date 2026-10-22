// Purchase → Stock Overview API (backend: apps/inventory/stock_overview.py).
// Every value shown on the screen comes from these calls — nothing is cached locally, so the
// table always reflects the database (and the stock ledger behind it).
import axios from 'axios';

const BASE = '/api/inventory/stock-overview/';

// Filter state → query params the backend understands (blank values are dropped).
export const filterParams = (filters = {}) => {
  const out = {};
  Object.entries(filters).forEach(([k, v]) => {
    if (v !== undefined && v !== null && String(v).trim() !== '') out[k] = String(v).trim();
  });
  return out;
};

export const fetchStockPage = (params, signal) =>
  axios.get(BASE, { params, signal }).then((r) => r.data);

export const fetchStockSummary = (params, signal) =>
  axios.get(`${BASE}summary/`, { params, signal }).then((r) => r.data);

export const fetchStockFacets = () => axios.get(`${BASE}facets/`).then((r) => r.data);

export const lookupCode = (code) =>
  axios.get(`${BASE}lookup/`, { params: { code } }).then((r) => r.data);

// changes: { field: newValue }, original: { field: value as loaded } (optimistic lock).
export const updateStockFields = (id, changes, original) =>
  axios.patch(`${BASE}${id}/`, { changes, original }).then((r) => r.data);

export const adjustStock = (id, body) =>
  axios.post(`${BASE}${id}/adjust/`, body).then((r) => r.data);

export const fetchStockHistory = (id, params, signal) =>
  axios.get(`${BASE}${id}/history/`, { params, signal }).then((r) => r.data);

// Downloads the filtered list through axios so the auth header goes along.
export async function downloadStockExport(params, format) {
  const res = await axios.get(`${BASE}export/`, {
    params: { ...params, export_format: format }, responseType: 'blob',
  });
  const disposition = res.headers?.['content-disposition'] || '';
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] || `stock-overview.${format}`;
  const url = URL.createObjectURL(res.data);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// A blob error body (export) is JSON text; turn it back into an object so apiErrorMessage reads it.
export async function normalizeBlobError(err) {
  const data = err?.response?.data;
  if (data instanceof Blob) {
    try { err.response.data = JSON.parse(await data.text()); } catch { /* leave as is */ }
  }
  return err;
}

export const newClientToken = () =>
  (globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export const STATUS_META = {
  in: { label: 'In Stock', color: '#15803d', bg: '#dcfce7', border: '#86efac' },
  low: { label: 'Low Stock', color: '#b45309', bg: '#fef3c7', border: '#fcd34d' },
  out: { label: 'Out of Stock', color: '#b91c1c', bg: '#fee2e2', border: '#fca5a5' },
};

const inr = new Intl.NumberFormat('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const formatMoney = (v) => (v === null || v === undefined || v === '' ? '—' : `₹${inr.format(Number(v))}`);
export const formatQty = (v) => (v === null || v === undefined ? '—' : Number(v).toLocaleString('en-IN'));
export const formatDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
export const formatDateTime = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—'
    : d.toLocaleString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
