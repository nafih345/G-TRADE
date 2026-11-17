// Shared bits of the platform console (pages/TenantManagement.jsx + components/superadmin/*).
import axios from 'axios';
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
  TRIAL: { label: 'Trial', color: 'info' },
  SCHEDULED: { label: 'Deactivation scheduled', color: 'warning' },
  EXPIRED: { label: 'Subscription expired', color: 'error' },
  INACTIVE: { label: 'Deactivated', color: 'default' },
};

// Which lifecycle action a client's status offers: deactivate (active, trial or expired — an
// expired client is renewed by editing its subscription, not "reactivated"), cancel a scheduled
// deactivation, or reactivate a deactivated client.
export const lifecycleOf = (status) => {
  if (status === 'SCHEDULED') return { kind: 'cancel', label: 'Cancel deactivation', color: 'warning' };
  if (status === 'INACTIVE') return { kind: 'reactivate', label: 'Reactivate', color: 'success' };
  return { kind: 'deactivate', label: 'Deactivate', color: 'error' };
};

export const planLabel =(catalog, key) => catalog?.subscription_plans?.find((p) => p.key === key)?.label || key || '—';

export const countryName = (catalog, code) => catalog?.localization?.countries?.find((c) => c.code === code)?.name
  || code || '—';

/**
 * A one-time account-setup link for a client user (POST …/users/<id>/invitation/). The server
 * returns only uid + token; the link is built on this browser's own origin. Never stored.
 */
export const fetchInvitationLink = async (usersUrl, userId) => {
  const { data } = await axios.post(`${usersUrl}${userId}/invitation/`, {});
  const base = `${window.location.origin}${window.location.pathname}`;
  const query = new URLSearchParams({ uid: data.uid, token: data.token }).toString();
  return { link: `${base}#/accept-invite?${query}`, username: data.username, hours: data.expires_in_hours };
};

export const roleLabel = (catalog, key) => catalog?.roles.find((r) => r.key === key)?.label
  || String(key || '').replace(/_/g, ' ');

export const packageLabel = (catalog, key) => catalog?.packages.find((p) => p.key === key)?.label || key;
