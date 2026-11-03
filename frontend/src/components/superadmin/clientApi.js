// Shared bits of the platform console (pages/TenantManagement.jsx + components/superadmin/*).
import { apiErrorMessage } from '../../utils/apiError';
import { notify } from '../../utils/notify';

export const API = '/api/superadmin/tenants/';

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, {
  day: '2-digit', month: 'short', year: 'numeric',
}) : '—');

export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');

// yyyy-mm-dd in the browser's own day, for <input type="date"> defaults.
export const todayIso = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};

export const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(14));
  return `${Array.from(bytes, (n) => chars[n % chars.length]).join('')}!7`;
};

// A sensitive write asked for the password again: ReauthDialogHost has taken over.
export const isReauth = (err) => err?.response?.status === 403 && err.response.data?.code === 'reauth_required';

// DRF 400 body → { field: 'message' } for the fields the form knows, plus everything else.
export const splitErrors = (err, knownFields, fallback) => {
  const data = err?.response?.status === 400 ? err.response.data : null;
  if (!data || typeof data !== 'object') return { fields: {}, general: apiErrorMessage(err, fallback) };
  const fields = {};
  const rest = [];
  Object.entries(data).forEach(([key, value]) => {
    const msg = Array.isArray(value) ? value.join(' ') : (typeof value === 'object' ? JSON.stringify(value) : String(value));
    if (knownFields.includes(key)) fields[key] = msg;
    else if (key !== 'code') rest.push(msg);
  });
  return { fields, general: rest.join(' ') };
};

export const copy = (text) => {
  navigator.clipboard?.writeText(text).then(() => notify('Copied to clipboard.', 'success'),
    () => notify('Could not copy — select the text instead.', 'warning'));
};

export const STATUS_META = {
  ACTIVE: { label: 'Active', color: 'success' },
  SCHEDULED: { label: 'Deactivation scheduled', color: 'warning' },
  INACTIVE: { label: 'Deactivated', color: 'default' },
};

export const roleLabel = (catalog, key) => catalog?.roles.find((r) => r.key === key)?.label
  || String(key || '').replace(/_/g, ' ');

export const packageLabel = (catalog, key) => catalog?.packages.find((p) => p.key === key)?.label || key;
