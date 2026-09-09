// Shared, cached billing context (templates + assignments + settings + company profile).
// printBill.js reads this so any module can print without each one wiring up its own
// fetch; the designer screens refresh it after edits.
import {
  fetchTemplates, fetchAssignments, fetchBillingSettings,
} from './billingApi';
import { PRESET_TEMPLATES, presetForDocType } from './templatePresets';

let cache = { templates: null, assignments: null, settings: null, company: null, ts: 0 };
let inflight = null;
const TTL_MS = 60_000;

export function readCompanyFromLocal() {
  try {
    const s = JSON.parse(localStorage.getItem('optical_app_settings') || '{}');
    return {
      name: s.storeName || '',
      address: [s.address, s.city, s.state, s.pincode].filter(Boolean).join(', '),
      phone: s.storePhone || '',
      email: s.storeEmail || '',
      website: s.website || '',
      gstin: s.gstin || '',
      currency: s.currency || '₹',
      tagline: s.tagline || '',
    };
  } catch {
    return {};
  }
}

export async function loadBillingContext({ force = false } = {}) {
  if (cache.templates && Date.now() - cache.ts < TTL_MS && !force) return cache;
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const [templates, assignments, settings] = await Promise.all([
        fetchTemplates().catch(() => null),
        fetchAssignments().catch(() => null),
        fetchBillingSettings().catch(() => null),
      ]);
      cache = {
        templates: templates && templates.length ? templates : null,
        assignments: assignments && assignments.length ? assignments : null,
        settings: settings || null,
        company: readCompanyFromLocal(),
        ts: Date.now(),
      };
    } finally {
      inflight = null;
    }
    return cache;
  })();
  return inflight;
}

export function invalidateBillingContext() {
  cache.ts = 0;
}

// Resolve the template a given document type should render with.
export function resolveTemplate(documentType, ctx = cache) {
  const { templates, assignments, settings } = ctx || {};

  if (settings?.use_single_template && settings.single_template && templates) {
    const t = templates.find((x) => x.id === settings.single_template && x.is_active);
    if (t) return t;
  }
  if (assignments && templates) {
    const a = assignments.find((x) => x.document_type === documentType);
    if (a && a.template) {
      const t = templates.find((x) => x.id === a.template);
      if (t && t.is_active) return t;
    }
  }
  if (templates) {
    const def = templates.find((x) => x.is_default && x.is_active)
      || templates.find((x) => x.is_active);
    if (def) return def;
  }
  return presetForDocType(documentType);
}

// Legacy paper-size toggle ('A4' | 'A5' | 'Thermal') coming from PrintInvoiceModal etc.
export function applyPaperOverride(template, override) {
  if (!override) return template;
  const isThermal = ['58mm', '80mm'].includes(template.paper_size);
  if (override === 'Thermal') {
    if (isThermal) return template;
    return PRESET_TEMPLATES.find((t) => t.template_type === 'THERMAL_80');
  }
  if (override === 'A5') {
    if (template.paper_size === 'A5') return template;
    if (isThermal) return PRESET_TEMPLATES.find((t) => t.template_type === 'COMPACT');
    return { ...template, paper_size: 'A5', margins: { top: 8, right: 8, bottom: 8, left: 8 } };
  }
  if (override === 'A4') {
    if (template.paper_size === 'A4') return template;
    if (isThermal) return PRESET_TEMPLATES.find((t) => t.template_type === 'STANDARD');
    return { ...template, paper_size: 'A4', margins: { top: 15, right: 15, bottom: 15, left: 15 } };
  }
  return template;
}
