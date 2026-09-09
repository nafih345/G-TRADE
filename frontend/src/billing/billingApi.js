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
  { key: 'ORDER_BILL', label: 'Order Bill / Job Slip' },
  { key: 'PURCHASE_BILL', label: 'Purchase Bill' },
  { key: 'RETURN_BILL', label: 'Return Bill' },
  { key: 'QUOTATION', label: 'Quotation' },
  { key: 'PAYMENT_RECEIPT', label: 'Payment Receipt' },
];
