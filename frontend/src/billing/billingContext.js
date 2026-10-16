// Shared, cached billing context (templates + assignments + settings + company profile).
// printBill.js reads this so any module can print without each one wiring up its own
// fetch; the designer screens refresh it after edits.
import {
  fetchTemplates, fetchAssignments, fetchBillingSettings,
} from './billingApi';
import { PRESET_TEMPLATES, presetForDocType } from './templatePresets';
import { canonicalDocType, compatibleDocTypes } from './billFields.js';
import { isThermalTemplate } from './renderBillHtml';

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

export function readCurrentUser() {
  try {
    const p = JSON.parse(localStorage.getItem('user_profile') || '{}');
    return p.full_name || p.name || p.username || '';
  } catch {
    return '';
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
        user: readCurrentUser(),
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

const canPrint = (t, documentType) => !!t && t.is_active !== false
  && (t.compatible_types || compatibleDocTypes(t.config)).includes(documentType);

// Resolve the template a given document type should render with:
//   "one template for everything" (where that template can print this document)
//   -> the document type's assignment -> the default template -> any compatible template
//   -> the built-in offline preset.
// A template that can't print the document (e.g. an items layout for a payment receipt) is
// never used for it.
export function resolveTemplate(documentType, ctx = cache) {
  const type = canonicalDocType(documentType);
  const { templates, assignments, settings } = ctx || {};
  const byId = (id) => (templates || []).find((x) => x.id === id);

  if (settings?.use_single_template && settings.single_template) {
    const t = byId(settings.single_template);
    if (canPrint(t, type)) return t;
  }
  if (assignments && templates) {
    const a = assignments.find((x) => canonicalDocType(x.document_type) === type);
    const t = a?.template ? byId(a.template) : null;
    if (canPrint(t, type)) return t;
  }
  if (templates) {
    const def = templates.find((x) => x.is_default && canPrint(x, type))
      || templates.find((x) => canPrint(x, type));
    if (def) return def;
  }
  return presetForDocType(type);
}

const paperClass = (t) => {
  if (isThermalTemplate(t)) return 'Thermal';
  return t?.paper_size === 'A5' ? 'A5' : t?.paper_size === 'A4' ? 'A4' : 'OTHER';
};

// Legacy paper-size toggle ('A4' | 'A5' | 'Thermal') from PrintInvoiceModal etc. Falsy or
// 'AUTO' keeps the assigned template. For a visual template the layout is drawn in mm for its
// own paper, so instead of stretching it we pick another active template made for that paper
// that can print this document; only legacy layouts are re-flowed onto the new size.
export function applyPaperOverride(template, override, documentType = 'SALES_INVOICE', ctx = cache) {
  if (!override || override === 'AUTO' || !template) return template;
  if (paperClass(template) === override) return template;
  const type = canonicalDocType(documentType);
  const width = (t) => ({ '80mm': 80, '58mm': 58 })[t.paper_size] || parseFloat(t.custom_width_mm) || 0;
  const others = (ctx?.templates || []).filter((t) => canPrint(t, type) && paperClass(t) === override)
    .sort((a, b) => width(b) - width(a));
  const pick = others.find((t) => (ctx?.assignments || []).some((a) => a.template === t.id))
    || others.find((t) => t.is_default) || others.find((t) => t.config?.schema === 2) || others[0];
  if (pick) return pick;
  if (template.config?.schema === 2) {
    // No visual template for that paper yet: fall back to the built-in legacy layout.
    return PRESET_TEMPLATES.find((t) => t.template_type === ({ Thermal: 'THERMAL_80', A5: 'COMPACT', A4: 'STANDARD' })[override]) || template;
  }
  const isThermal = isThermalTemplate(template);
  if (override === 'Thermal') return PRESET_TEMPLATES.find((t) => t.template_type === 'THERMAL_80');
  if (override === 'A5') {
    if (isThermal) return PRESET_TEMPLATES.find((t) => t.template_type === 'COMPACT');
    return { ...template, paper_size: 'A5', margins: { top: 8, right: 8, bottom: 8, left: 8 } };
  }
  if (override === 'A4') {
    if (isThermal) return PRESET_TEMPLATES.find((t) => t.template_type === 'STANDARD');
    return { ...template, paper_size: 'A4', margins: { top: 15, right: 15, bottom: 15, left: 15 } };
  }
  return template;
}
