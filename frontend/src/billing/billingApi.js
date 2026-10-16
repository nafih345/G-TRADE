// Thin wrapper over the /api/billing/* endpoints (see backend/apps/billing).
// Every call degrades gracefully — callers fall back to the built-in presets in
// templatePresets.js when the backend is unreachable so printing always works offline.
import axios from 'axios';

const BASE = '/api/billing';

export async function fetchTemplates() {
  const { data } = await axios.get(`${BASE}/templates/`);
  return Array.isArray(data) ? data : (data?.results || []);
}

export async function fetchAssignments() {
  const { data } = await axios.get(`${BASE}/assignments/`);
  return Array.isArray(data) ? data : (data?.results || []);
}

export async function fetchBillingSettings() {
  const { data } = await axios.get(`${BASE}/settings/`);
  return data || {};
}

export async function fetchDocumentTypes() {
  const { data } = await axios.get(`${BASE}/document-types/`);
  return Array.isArray(data) ? data : [];
}

export function createTemplate(payload) {
  return axios.post(`${BASE}/templates/`, payload).then(r => r.data);
}

// Send `expected_version` in the payload to get a 409 instead of overwriting someone else's save.
export function updateTemplate(id, payload) {
  return axios.patch(`${BASE}/templates/${id}/`, payload).then(r => r.data);
}

export function deleteTemplate(id) {
  return axios.delete(`${BASE}/templates/${id}/`).then(r => r.data);
}

export function duplicateTemplate(id) {
  return axios.post(`${BASE}/templates/${id}/duplicate/`).then(r => r.data);
}

export function setDefaultTemplate(id) {
  return axios.post(`${BASE}/templates/${id}/set-default/`).then(r => r.data);
}

export function activateTemplate(id) {
  return axios.post(`${BASE}/templates/${id}/activate/`).then(r => r.data);
}

export function deactivateTemplate(id) {
  return axios.post(`${BASE}/templates/${id}/deactivate/`).then(r => r.data);
}

export function bulkUpdateAssignments(assignments) {
  return axios.put(`${BASE}/assignments/bulk/`, { assignments }).then(r => r.data);
}

export function updateBillingSettings(payload) {
  return axios.patch(`${BASE}/settings/`, payload).then(r => r.data);
}

export const DOCUMENT_TYPES = [
  { key: 'SALES_INVOICE', label: 'Sales Invoice / Bill' },
  { key: 'WHOLESALE_BILL', label: 'Wholesale Bill' },
  { key: 'PURCHASE_BILL', label: 'Purchase Bill' },
  { key: 'ORDER_BILL', label: 'Order Bill / Job Slip' },
  { key: 'QUOTATION', label: 'Quotation' },
  { key: 'PAYMENT_RECEIPT', label: 'Payment Receipt' },
  { key: 'SALES_RETURN', label: 'Sales Return' },
  { key: 'PURCHASE_RETURN', label: 'Purchase Return' },
];

export function fetchTemplate(id) {
  return axios.get(`${BASE}/templates/${id}/`).then(r => r.data);
}

export function renameTemplate(id, name) {
  return axios.post(`${BASE}/templates/${id}/rename/`, { name }).then(r => r.data);
}

export function assignTemplate(id, documentTypes, replace = true) {
  return axios.post(`${BASE}/templates/${id}/assign/`, { document_types: documentTypes, replace }).then(r => r.data);
}

export function restoreTemplateDefault(id) {
  return axios.post(`${BASE}/templates/${id}/restore-default/`).then(r => r.data);
}

export function fetchTemplateVersions(id) {
  return axios.get(`${BASE}/templates/${id}/versions/`).then(r => r.data);
}

export function restoreTemplateVersion(id, version) {
  return axios.post(`${BASE}/templates/${id}/restore-version/`, { version }).then(r => r.data);
}

export function fetchDeletedTemplates() {
  return axios.get(`${BASE}/templates/deleted/`).then(r => r.data);
}

export function undeleteTemplate(id) {
  return axios.post(`${BASE}/templates/${id}/undelete/`).then(r => r.data);
}

export function fetchPresets() {
  return axios.get(`${BASE}/templates/presets/`).then(r => r.data);
}

export function createFromPreset(presetKey, name) {
  return axios.post(`${BASE}/templates/from-preset/`, { preset_key: presetKey, name }).then(r => r.data);
}

export function restoreDefaultTemplates({ resetModified = false, reassign = false } = {}) {
  return axios.post(`${BASE}/templates/restore-defaults/`, { reset_modified: resetModified, reassign }).then(r => r.data);
}

export function fetchBillingMeta() {
  return axios.get(`${BASE}/meta/`).then(r => r.data);
}

/** Human message for a failed billing API call (DRF field errors, 409 conflicts, 403s). */
export function apiError(err, fallback = 'Request failed.') {
  const d = err?.response?.data;
  if (!err?.response) return 'The server is unreachable — check your connection and try again.';
  if (err.response.status === 403 || err.response.status === 401) {
    return d?.detail || 'Sign in as a Super Admin, Administrator or Manager to change bill templates.';
  }
  if (typeof d === 'string') return d.slice(0, 300);
  if (d?.detail) return d.detail;
  if (d && typeof d === 'object') {
    const [k, v] = Object.entries(d)[0] || [];
    const msg = Array.isArray(v) ? v[0] : (typeof v === 'object' ? JSON.stringify(v) : v);
    if (msg) return k && !['non_field_errors', 'config'].includes(k) ? `${k.replace(/_/g, ' ')}: ${msg}` : String(msg);
  }
  return fallback;
}
