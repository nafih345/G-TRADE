// Barcode label designer — API client. Templates, print settings and field values all
// come from the database (backend/apps/products/label_views.py). The last good template
// list is cached in localStorage purely so printing still works if the server is briefly
// unreachable; the database stays the source of truth.
import axios from 'axios';
import { normalizeTemplate, convertLegacySettings } from './labelModel.js';
import { resolveLocalProductFields } from './labelFields.js';

const BASE = '/api/products';
const CACHE_KEY = 'optical_label_templates_cache';
const LEGACY_SETTINGS_KEY = 'optical_barcode_print_settings';
const LEGACY_LAYOUTS_KEY = 'optical_barcode_custom_layouts';
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// DRF error payload -> one readable sentence.
export function apiError(err, fallback = 'Request failed.') {
  const d = err?.response?.data;
  if (!err?.response) return 'Cannot reach the server — check that the backend is running.';
  if (err.response.status === 401 || err.response.status === 403) {
    return d?.detail || 'You are not allowed to change label templates. Sign in as an administrator or manager.';
  }
  if (typeof d === 'string') return d.slice(0, 300);
  if (d?.detail) return d.detail;
  if (d && typeof d === 'object') {
    const first = Object.entries(d)[0];
    if (first) return `${first[0] === 'layout' || first[0] === 'non_field_errors' ? '' : `${first[0]}: `}${[].concat(first[1]).join(' ')}`;
  }
  return fallback;
}

function readCache() {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    return c && Array.isArray(c.templates) ? c : null;
  } catch {
    return null;
  }
}

export async function fetchLabelBundle() {
  try {
    const [t, s, f] = await Promise.all([
      axios.get(`${BASE}/label-templates/`),
      axios.get(`${BASE}/label-settings/`),
      axios.get(`${BASE}/label-fields/`),
    ]);
    const bundle = {
      templates: (Array.isArray(t.data) ? t.data : t.data?.results || []).map(normalizeTemplate),
      settings: s.data,
      fields: f.data,
      offline: false,
    };
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ templates: bundle.templates, settings: bundle.settings, at: Date.now() })); } catch { /* quota */ }
    return bundle;
  } catch (err) {
    const cache = readCache();
    if (cache) return { templates: cache.templates.map(normalizeTemplate), settings: cache.settings || {}, fields: null, offline: true, error: apiError(err) };
    throw err;
  }
}

const payload = (t) => ({
  name: t.name, description: t.description || '', printer_type: t.printer_type,
  width_mm: t.width_mm, height_mm: t.height_mm, layout: t.layout,
});

export const createTemplate = (t) => axios.post(`${BASE}/label-templates/`, payload(t)).then((r) => normalizeTemplate(r.data));
export const updateTemplate = (t) => axios.put(`${BASE}/label-templates/${t.id}/`, { ...payload(t), expected_version: t.version }).then((r) => normalizeTemplate(r.data));
export const renameTemplate = (t, name) => axios.patch(`${BASE}/label-templates/${t.id}/`, { name, expected_version: t.version }).then((r) => normalizeTemplate(r.data));
export const duplicateTemplate = (id, name) => axios.post(`${BASE}/label-templates/${id}/duplicate/`, name ? { name } : {}).then((r) => normalizeTemplate(r.data));
export const deleteTemplate = (id) => axios.delete(`${BASE}/label-templates/${id}/`);
export const setDefaultTemplate = (id) => axios.post(`${BASE}/label-templates/${id}/set-default/`).then((r) => normalizeTemplate(r.data));
export const restoreDefaultTemplate = (id) => axios.post(`${BASE}/label-templates/${id}/restore-default/`).then((r) => normalizeTemplate(r.data));
export const fetchVersions = (id) => axios.get(`${BASE}/label-templates/${id}/versions/`).then((r) => r.data);
export const restoreVersion = (id, version) => axios.post(`${BASE}/label-templates/${id}/restore-version/`, { version }).then((r) => normalizeTemplate(r.data));
export const fetchDeletedTemplates = () => axios.get(`${BASE}/label-templates/deleted/`).then((r) => r.data.map(normalizeTemplate));
export const undeleteTemplate = (id) => axios.post(`${BASE}/label-templates/${id}/undelete/`).then((r) => normalizeTemplate(r.data));
export const fetchPresets = () => axios.get(`${BASE}/label-templates/presets/`).then((r) => r.data);
export const createFromPreset = (presetKey, name) => axios.post(`${BASE}/label-templates/from-preset/`, { preset_key: presetKey, name }).then((r) => normalizeTemplate(r.data));
export const fetchTemplate = (id) => axios.get(`${BASE}/label-templates/${id}/`).then((r) => normalizeTemplate(r.data));
export const savePrintSettings = (patch) => axios.put(`${BASE}/label-settings/`, patch).then((r) => r.data);

// Resolves label field values for products from the database. Products that only exist in
// this browser (non-UUID ids) fall back to the values on the object itself.
export async function fetchLabelData(products) {
  const ids = [...new Set(products.map((p) => String(p?.id || '')).filter((id) => UUID_RE.test(id)))];
  let res = { products: {}, store: {}, restricted_included: false };
  // Chunk large catalog prints so a single request stays small.
  for (let i = 0; i < ids.length || i === 0; i += 500) {
    const chunk = ids.slice(i, i + 500);
    try {
      // eslint-disable-next-line no-await-in-loop
      const { data } = await axios.post(`${BASE}/label-data/`, { product_ids: chunk });
      res = { ...res, ...data, products: { ...res.products, ...(data.products || {}) } };
    } catch (err) {
      res.error = apiError(err);
    }
    if (!ids.length) break;
  }
  let localStore = '';
  try { localStore = JSON.parse(localStorage.getItem('optical_app_settings') || '{}').storeName || ''; } catch { /* ignore */ }
  const store = {
    store_name: res.store?.store_name || localStore,
    store_phone: res.store?.store_phone || '',
  };
  const byProduct = new Map();
  for (const p of products) {
    const server = res.products?.[String(p?.id)];
    byProduct.set(p, server
      ? { fields: server.fields, variantGroup: server.variant_group, stock: server.stock, fromServer: true }
      : { fields: resolveLocalProductFields(p), variantGroup: p?.variant_group || null, stock: p?.stock, fromServer: false });
  }
  return { byProduct, store, logo: res.store?.logo || '', restrictedIncluded: !!res.restricted_included, error: res.error };
}

export async function fetchVariantSiblings(groupId) {
  const { data } = await axios.get(`${BASE}/variant-groups/${groupId}/`);
  return (data?.variants || []).map((v) => ({ ...v, variant_group: groupId, selling_price: v.sales_price }));
}

export async function searchProducts(query, { pageSize = 20 } = {}) {
  const { data } = await axios.get(`${BASE}/items/`, { params: { search: query || undefined, page: 1, page_size: pageSize } });
  return Array.isArray(data) ? data : data?.results || [];
}

// One-time import of designs that pre-date database templates. Safe to call repeatedly:
// the server flips `legacy_migrated` and ignores later calls.
export async function importLegacyIfNeeded(settings) {
  if (!settings || settings.legacy_migrated) return null;
  let legacy = null;
  let layouts = [];
  try { legacy = JSON.parse(localStorage.getItem(LEGACY_SETTINGS_KEY) || 'null'); } catch { /* ignore */ }
  try { layouts = JSON.parse(localStorage.getItem(LEGACY_LAYOUTS_KEY) || '[]') || []; } catch { /* ignore */ }
  const templates = convertLegacySettings(legacy, Array.isArray(layouts) ? layouts : []);
  try {
    const { data } = await axios.post(`${BASE}/label-settings/import-legacy/`, { templates });
    return data;
  } catch {
    return null; // not signed in as a designer yet — try again next time
  }
}
