// Visual (schema 2) bill layout model — element library, factories, normalisation, themes and
// the legacy-template converter. Pure functions (no DOM), shared by the designer, the renderer
// and the tests. Geometry is millimetres relative to a band's top-left inside the page margins;
// font sizes are points.
import {
  FIELD_BY_ID, COLUMN_BY_KEY, ITEM_COLUMNS, TOTALS_ROW_BY_KEY,
} from './billFields.js';

export const BANDS = ['header', 'summary', 'footer'];
export const BAND_LABELS = { header: 'Header', items: 'Items table', summary: 'Totals & summary', footer: 'Page footer' };

export const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
export const round = (n, step = 0.5) => Math.round((Number(n) || 0) / step) * step;

export const FONT_FAMILIES = [
  { value: "'Segoe UI', Arial, sans-serif", label: 'Segoe UI' },
  { value: 'Arial, Helvetica, sans-serif', label: 'Arial' },
  { value: 'Helvetica, Arial, sans-serif', label: 'Helvetica' },
  { value: "Calibri, 'Segoe UI', sans-serif", label: 'Calibri' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Verdana' },
  { value: 'Tahoma, Geneva, sans-serif', label: 'Tahoma' },
  { value: "'Trebuchet MS', sans-serif", label: 'Trebuchet MS' },
  { value: "Georgia, 'Times New Roman', serif", label: 'Georgia' },
  { value: "'Times New Roman', Times, serif", label: 'Times New Roman' },
  { value: "'Courier New', Courier, monospace", label: 'Courier New (receipt)' },
];

export const PAPER_SIZES = [
  { value: 'A4', label: 'A4 (210 × 297 mm)' },
  { value: 'A5', label: 'A5 (148 × 210 mm)' },
  { value: 'A6', label: 'A6 (105 × 148 mm)' },
  { value: 'LETTER', label: 'US Letter (216 × 279 mm)' },
  { value: '80mm', label: 'Thermal roll 80 mm' },
  { value: '58mm', label: 'Thermal roll 58 mm' },
  { value: 'CUSTOM', label: 'Custom size…' },
];

// Built-in colour themes. "Brand colours" (useBrand) takes primary/accent from Logo & Branding.
export const THEMES = [
  { name: 'Classic Blue', primary: '#1d4ed8', accent: '#0f172a', text: '#0f172a', muted: '#64748b', border: '#cbd5e1', headerBg: '#0f172a', headerText: '#ffffff' },
  { name: 'Teal', primary: '#0f766e', accent: '#134e4a', text: '#0f172a', muted: '#64748b', border: '#99f6e4', headerBg: '#0f766e', headerText: '#ffffff' },
  { name: 'Emerald', primary: '#047857', accent: '#064e3b', text: '#0f172a', muted: '#64748b', border: '#a7f3d0', headerBg: '#047857', headerText: '#ffffff' },
  { name: 'Violet', primary: '#7c3aed', accent: '#4c1d95', text: '#1e1b4b', muted: '#6b7280', border: '#ddd6fe', headerBg: '#6d28d9', headerText: '#ffffff' },
  { name: 'Amber', primary: '#b45309', accent: '#78350f', text: '#1c1917', muted: '#78716c', border: '#fde68a', headerBg: '#b45309', headerText: '#ffffff' },
  { name: 'Rose', primary: '#be123c', accent: '#881337', text: '#1c1917', muted: '#71717a', border: '#fecdd3', headerBg: '#be123c', headerText: '#ffffff' },
  { name: 'Ocean', primary: '#0369a1', accent: '#0c4a6e', text: '#0f172a', muted: '#64748b', border: '#bae6fd', headerBg: '#0369a1', headerText: '#ffffff' },
  { name: 'Charcoal', primary: '#334155', accent: '#0f172a', text: '#0f172a', muted: '#64748b', border: '#cbd5e1', headerBg: '#334155', headerText: '#ffffff' },
  { name: 'Monochrome', primary: '#000000', accent: '#000000', text: '#000000', muted: '#333333', border: '#000000', headerBg: '#000000', headerText: '#ffffff' },
];
export const THEME_KEYS = ['primary', 'accent', 'text', 'muted', 'border', 'headerBg', 'headerText'];

/** Theme with "Brand colours" resolved against BillingSettings branding. */
export function effectiveTheme(theme = {}, branding = {}) {
  const t = { ...THEMES[0], fontFamily: FONT_FAMILIES[0].value, fontSize: 9, lineHeight: 1.3, ...theme };
  if (t.useBrand) {
    if (branding.primary_color) t.primary = branding.primary_color;
    if (branding.accent_color) { t.accent = branding.accent_color; t.headerBg = branding.accent_color; }
  }
  return t;
}

// ---------------------------------------------------------------------------
// Element library
// ---------------------------------------------------------------------------

export const ELEMENT_LIBRARY = [
  { type: 'companyBlock', label: 'Company header', group: 'Header', w: 95, h: 26, hint: 'Store name, address, phone, GSTIN from Store Profile / Branding' },
  { type: 'logo', label: 'Company logo', group: 'Header', w: 26, h: 20, hint: 'Logo from Logo & Branding' },
  { type: 'field', label: 'Document title', group: 'Header', w: 64, h: 9, preset: { field: 'document.title', style: { fontSize: 15, fontWeight: 800, align: 'right', uppercase: true, shrinkToFit: true }, hideIfEmpty: false } },
  { type: 'field', label: 'Document number', group: 'Header', w: 60, h: 6, preset: { field: 'document.number', label: 'Invoice No', labelPosition: 'left', labelWidth: 24 } },
  { type: 'field', label: 'Document date', group: 'Header', w: 60, h: 6, preset: { field: 'document.date', label: 'Date', labelPosition: 'left', labelWidth: 24 } },
  { type: 'field', label: 'Due date', group: 'Header', w: 60, h: 6, preset: { field: 'document.dueDate', label: 'Due Date', labelPosition: 'left', labelWidth: 24 } },
  { type: 'fieldList', label: 'Document details', group: 'Header', w: 64, h: 20, hint: 'Number, date, due date, status' },
  { type: 'partyBlock', label: 'Customer / supplier', group: 'Party', w: 92, h: 26, hint: 'Bill To (sales) or Supplier (purchases)' },
  { type: 'partyBlock', label: 'Shipping address', group: 'Party', w: 92, h: 22, preset: { variant: 'shipping', title: 'Ship To' } },
  { type: 'field', label: 'Customer GSTIN', group: 'Party', w: 70, h: 6, preset: { field: 'party.gstin', label: 'GSTIN', labelPosition: 'left', labelWidth: 16 } },
  { type: 'totals', label: 'Totals', group: 'Amounts', w: 72, h: 46, hint: 'Subtotal, discount, tax, round-off, grand total, paid, balance' },
  { type: 'field', label: 'Grand total', group: 'Amounts', w: 60, h: 8, preset: { field: 'totals.grandTotal', label: 'Grand Total', labelPosition: 'left', labelWidth: 26, style: { fontSize: 12, fontWeight: 800 } } },
  { type: 'field', label: 'Paid amount', group: 'Amounts', w: 60, h: 6, preset: { field: 'totals.paid', label: 'Paid', labelPosition: 'left', labelWidth: 26 } },
  { type: 'field', label: 'Outstanding balance', group: 'Amounts', w: 60, h: 6, preset: { field: 'totals.balance', label: 'Balance', labelPosition: 'left', labelWidth: 26, style: { fontWeight: 700 } } },
  { type: 'field', label: 'Amount in words', group: 'Amounts', w: 110, h: 10, preset: { field: 'totals.amountInWords', label: 'Amount in words', labelPosition: 'top', style: { italic: true } } },
  { type: 'taxSummary', label: 'GST / tax summary', group: 'Amounts', w: 110, h: 22, hint: 'Tax grouped by rate (needs per-line tax)' },
  { type: 'payment', label: 'Payment details', group: 'Amounts', w: 100, h: 18, hint: 'Method, reference, split, bank, UPI' },
  { type: 'field', label: 'Payment reference', group: 'Amounts', w: 70, h: 6, preset: { field: 'payment.reference', label: 'Ref', labelPosition: 'left', labelWidth: 16 } },
  { type: 'qr', label: 'QR code', group: 'Codes', w: 24, h: 24, hint: 'UPI payment, document number or custom text' },
  { type: 'barcode', label: 'Barcode', group: 'Codes', w: 50, h: 12, hint: 'Code 128 of the document number' },
  { type: 'text', label: 'Text', group: 'Text', w: 60, h: 8, hint: 'Static text — may contain {{field}} placeholders' },
  { type: 'text', label: 'Terms & conditions', group: 'Text', w: 110, h: 20, preset: { title: 'Terms & Conditions', text: '1. Goods once sold will not be taken back.\n2. Subject to local jurisdiction.', style: { fontSize: 7.5 } } },
  { type: 'field', label: 'Notes', group: 'Text', w: 110, h: 12, preset: { field: 'document.notes', label: 'Notes', labelPosition: 'top' } },
  { type: 'text', label: 'Footer text', group: 'Text', w: 120, h: 5, preset: { text: 'Thank you for your business!', style: { fontSize: 7.5, align: 'center' } } },
  { type: 'pageNumber', label: 'Page number', group: 'Text', w: 40, h: 5, hint: 'Page X of Y' },
  { type: 'signature', label: 'Authorised signature', group: 'Sign-off', w: 60, h: 18 },
  { type: 'image', label: 'Stamp / image', group: 'Sign-off', w: 26, h: 26, hint: 'Upload a stamp, seal or signature image' },
  { type: 'line', label: 'Divider line', group: 'Shapes', w: 120, h: 1 },
  { type: 'line', label: 'Vertical line', group: 'Shapes', w: 1, h: 30, preset: { orientation: 'v' } },
  { type: 'box', label: 'Box / background', group: 'Shapes', w: 80, h: 30 },
];

let idSeq = 0;
export function newElementId(prefix = 'el') {
  idSeq = (idSeq + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36).slice(-4)}${idSeq.toString(36)}${Math.random().toString(36).slice(2, 5)}`;
}

/** A new element of `type`, merged with the library preset `preset`. */
export function createElement(type, { preset = {}, x = 0, y = 0, w, h, field } = {}) {
  const lib = ELEMENT_LIBRARY.find((e) => e.type === type) || {};
  const el = {
    id: newElementId(type.slice(0, 3)), type, x, y,
    w: w ?? lib.w ?? 40, h: h ?? lib.h ?? 8, style: {},
  };
  switch (type) {
    case 'text': Object.assign(el, { text: 'Text' }); break;
    case 'field': {
      const def = FIELD_BY_ID[field || 'document.number'];
      Object.assign(el, {
        field: def?.id || 'document.number', label: '', labelPosition: 'none', labelWidth: 0,
        prefix: '', suffix: '', hideIfEmpty: true, emptyText: '',
      });
      if (def?.kind === 'multiline') { el.h = Math.max(el.h, 12); }
      break;
    }
    case 'fieldList':
      Object.assign(el, {
        fields: [
          { field: 'document.number', label: 'Invoice No' }, { field: 'document.date', label: 'Date' },
          { field: 'document.dueDate', label: 'Due Date' }, { field: 'document.paymentStatus', label: 'Status' },
        ],
        layout: 'rows', labelWidth: 24, hideEmpty: true, separator: ':',
        labelStyle: { color: '#64748b', fontWeight: 600 },
      });
      break;
    case 'companyBlock':
      Object.assign(el, {
        show: { name: true, tagline: true, address: true, phone: true, email: true, website: false, gstin: true, pan: false },
        nameSize: 16, nameColor: '', style: { fontSize: 8, shrinkToFit: true },
      });
      break;
    case 'partyBlock':
      Object.assign(el, {
        title: '', variant: 'billing',
        show: { title: true, name: true, code: true, phone: true, email: false, address: true, gstin: true },
        style: { fontSize: 8.5 },
      });
      break;
    case 'logo': Object.assign(el, { fit: 'contain' }); break;
    case 'image': Object.assign(el, { src: '', fit: 'contain', opacity: 1 }); break;
    case 'totals':
      Object.assign(el, {
        rows: ['subtotal', 'discount', 'tax', 'roundOff', 'grandTotal', 'paid', 'balance']
          .map((k) => ({ key: k, label: '', ...(['grandTotal', 'paid', 'balance'].includes(k) ? { always: true } : {}) })),
        grandStyle: { fontSize: 11, fontWeight: 800 }, divider: true, style: { fontSize: 8.5 },
      });
      break;
    case 'taxSummary': Object.assign(el, { showHsn: false, style: { fontSize: 7.5 } }); break;
    case 'payment':
      Object.assign(el, {
        title: 'Payment',
        show: { method: true, reference: true, splits: true, paid: false, balance: false, status: false, bank: true, upi: true },
        style: { fontSize: 8 },
      });
      break;
    case 'barcode': Object.assign(el, { field: 'document.number', showText: true }); break;
    case 'qr': Object.assign(el, { source: 'field', field: 'document.number', customText: '' }); break;
    case 'signature': Object.assign(el, { label: 'Authorised Signatory', showLine: true, showCompany: true, src: '', style: { fontSize: 8, align: 'center' } }); break;
    case 'line': Object.assign(el, { orientation: 'h', thickness: 0.5, color: '#0f172a', lineStyle: 'solid' }); break;
    case 'box': Object.assign(el, { style: { bg: '#f8fafc', borderWidth: 0.4, borderColor: '#cbd5e1', borderSides: 'all', radius: 1.5 } }); break;
    case 'pageNumber': Object.assign(el, { format: 'Page {page} of {pages}', style: { fontSize: 7.5, align: 'right' } }); break;
    default: break;
  }
  const merged = { ...el, ...clone(preset), style: { ...el.style, ...(preset.style || {}) } };
  if (merged.orientation === 'v' && type === 'line') { merged.w = w ?? 1; merged.h = h ?? 30; }
  return merged;
}

export const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));

const TYPE_LABEL = Object.fromEntries(ELEMENT_LIBRARY.filter((e) => !e.preset).map((e) => [e.type, e.label]));
TYPE_LABEL.field = 'Field';
TYPE_LABEL.text = 'Text';
TYPE_LABEL.line = 'Line';

export function elementTitle(el) {
  if (!el) return '';
  if (el.name) return el.name;
  if (el.type === 'field') return FIELD_BY_ID[el.field]?.label || 'Field';
  if (el.type === 'text') {
    if (el.title) return el.title;
    const t = String(el.text || '').replace(/\s+/g, ' ').trim();
    return t ? `“${t.length > 24 ? `${t.slice(0, 24)}…` : t}”` : 'Text';
  }
  if (el.type === 'partyBlock' && el.variant === 'shipping') return 'Shipping address';
  return TYPE_LABEL[el.type] || el.type;
}

// ---------------------------------------------------------------------------
// Config helpers
// ---------------------------------------------------------------------------

export const defaultTable = (over = {}) => ({
  columns: ['slno', 'name', 'qty', 'rate', 'taxPercent', 'total'].map((k) => {
    const col = COLUMN_BY_KEY[k];
    return { key: k, label: col.label, width: col.width, align: col.align, visible: true };
  }),
  headerStyle: { bg: '#0f172a', color: '#ffffff', fontSize: 8, fontWeight: 700 },
  bodyStyle: { fontSize: 8.5 },
  rowPadding: 1.6, cellPadX: 1.3, currencyInTable: true, zebra: true, zebraColor: '#f8fafc', borders: 'rows', borderColor: '#cbd5e1',
  repeatHeader: true, fillPage: false, showBrand: true, showPower: true, showVariant: true, showSku: false,
  emptyText: 'No items', totalRow: false,
  ...over,
});

export function blankConfig({ width = 190 } = {}) {
  return {
    schema: 2,
    theme: { ...THEMES[0], fontFamily: FONT_FAMILIES[0].value, fontSize: 9, lineHeight: 1.3, useBrand: false },
    format: { currencySymbol: '₹', decimals: 2, dateFormat: 'DD-MM-YYYY', thousands: 'indian', zeroAsDash: false },
    page: { headerOnEveryPage: false, summaryAt: 'after-items', background: '' },
    bands: {
      header: {
        height: 40,
        elements: [
          { ...createElement('companyBlock'), id: 'company', x: 0, y: 0, w: Math.min(110, width - 66), protected: true },
          { ...createElement('field', { preset: { field: 'document.title', style: { fontSize: 15, fontWeight: 800, align: 'right', uppercase: true, shrinkToFit: true }, hideIfEmpty: false } }), id: 'title', x: width - 64, y: 0, w: 64, h: 9, protected: true },
          { ...createElement('fieldList'), id: 'meta', x: width - 64, y: 10, w: 64, h: 18 },
          { ...createElement('partyBlock'), id: 'party', x: 0, y: 28, w: Math.min(100, width), h: 12, protected: true },
        ],
      },
      items: { visible: true, marginTop: 2, marginBottom: 3, table: defaultTable() },
      summary: {
        height: 40,
        elements: [
          { ...createElement('totals'), id: 'totals', x: Math.max(0, width - 72), y: 0, w: Math.min(72, width), h: 38, protected: true },
        ],
      },
      footer: { height: 0, elements: [] },
    },
  };
}

/** Fill in anything a stored schema-2 config is missing, so older saves keep rendering. */
export function normalizeConfig(cfg) {
  const base = blankConfig();
  const c = cfg && cfg.schema === 2 ? cfg : base;
  const bands = c.bands || {};
  const band = (name) => ({ height: 0, elements: [], ...(bands[name] || {}), elements: [...(bands[name]?.elements || [])] });
  return {
    schema: 2,
    theme: { ...base.theme, ...(c.theme || {}) },
    format: { ...base.format, ...(c.format || {}) },
    page: { ...base.page, ...(c.page || {}) },
    bands: {
      header: band('header'),
      items: {
        visible: true, marginTop: 2, marginBottom: 3, ...(bands.items || {}),
        table: { ...defaultTable({ columns: [] }), ...(bands.items?.table || {}), columns: [...(bands.items?.table?.columns || [])] },
      },
      summary: band('summary'),
      footer: band('footer'),
    },
  };
}

export const isVisualTemplate = (t) => t?.config?.schema === 2;

export function findElement(config, id) {
  for (const b of BANDS) {
    const el = (config?.bands?.[b]?.elements || []).find((e) => e.id === id);
    if (el) return { band: b, el };
  }
  return null;
}

export function allElements(config) {
  return BANDS.flatMap((b) => (config?.bands?.[b]?.elements || []).map((el) => ({ band: b, el })));
}

export function mapElements(config, fn) {
  const bands = { ...config.bands };
  BANDS.forEach((b) => {
    bands[b] = { ...bands[b], elements: (bands[b]?.elements || []).map((el) => fn(el, b)) };
  });
  return { ...config, bands };
}

export function updateBand(config, band, patch) {
  return { ...config, bands: { ...config.bands, [band]: { ...config.bands[band], ...patch } } };
}

// ---------------------------------------------------------------------------
// Snapping / alignment (mm)
// ---------------------------------------------------------------------------

export function snapBox(box, { others = [], W, H, grid = 1, snapGrid = true, threshold = 1.2 }) {
  const guides = [];
  let { x, y } = box;
  const xs = [0, W / 2, W];
  const ys = [0, H / 2, H];
  others.forEach((o) => {
    xs.push(o.x, o.x + o.w / 2, o.x + o.w);
    ys.push(o.y, o.y + o.h / 2, o.y + o.h);
  });
  const best = (pos, size, targets) => {
    let b = null;
    [0, size / 2, size].forEach((off) => {
      targets.forEach((t) => {
        const d = Math.abs(pos + off - t);
        if (d <= threshold && (!b || d < b.d)) b = { d, value: t - off, line: t };
      });
    });
    return b;
  };
  const sx = best(x, box.w, xs);
  const sy = best(y, box.h, ys);
  if (sx) { x = sx.value; guides.push({ axis: 'x', at: sx.line }); } else if (snapGrid) x = round(x, grid);
  if (sy) { y = sy.value; guides.push({ axis: 'y', at: sy.line }); } else if (snapGrid) y = round(y, grid);
  return { x: r2(x), y: r2(y), guides };
}

export function alignElements(elements, ids, mode, W) {
  const sel = elements.filter((e) => ids.includes(e.id) && !e.locked);
  if (!sel.length) return elements;
  const single = sel.length === 1;
  const minX = single ? 0 : Math.min(...sel.map((e) => e.x));
  const maxX = single ? W : Math.max(...sel.map((e) => e.x + e.w));
  const minY = Math.min(...sel.map((e) => e.y));
  const maxY = Math.max(...sel.map((e) => e.y + e.h));
  return elements.map((e) => {
    if (!sel.includes(e)) return e;
    switch (mode) {
      case 'left': return { ...e, x: r2(minX) };
      case 'right': return { ...e, x: r2(maxX - e.w) };
      case 'hcenter': return { ...e, x: r2((minX + maxX) / 2 - e.w / 2) };
      case 'top': return { ...e, y: r2(minY) };
      case 'bottom': return { ...e, y: r2(maxY - e.h) };
      case 'vcenter': return { ...e, y: r2((minY + maxY) / 2 - e.h / 2) };
      case 'fullwidth': return { ...e, x: 0, w: r2(W) };
      default: return e;
    }
  });
}

export function distributeElements(elements, ids, axis) {
  const sel = elements.filter((e) => ids.includes(e.id) && !e.locked)
    .sort((a, b) => (axis === 'x' ? a.x - b.x : a.y - b.y));
  if (sel.length < 3) return elements;
  const key = axis === 'x' ? 'x' : 'y';
  const size = axis === 'x' ? 'w' : 'h';
  const start = sel[0][key];
  const end = sel[sel.length - 1][key] + sel[sel.length - 1][size];
  const total = sel.reduce((s, e) => s + e[size], 0);
  const gap = (end - start - total) / (sel.length - 1);
  let cur = start;
  const pos = new Map();
  sel.forEach((e) => { pos.set(e.id, r2(cur)); cur += e[size] + gap; });
  return elements.map((e) => (pos.has(e.id) ? { ...e, [key]: pos.get(e.id) } : e));
}

// ---------------------------------------------------------------------------
// Legacy (schema 1) -> visual conversion
// ---------------------------------------------------------------------------

const LEGACY_COLUMN_MAP = { slno: 'slno', name: 'name', hsn: 'hsn', sku: 'sku', barcode: 'barcode', size: 'size', color: 'color', qty: 'qty', unit: 'unit', rate: 'rate', discount: 'discount', tax: 'taxPercent', total: 'total' };

/** Build an equivalent visual layout from a legacy section-toggle template, so an existing
 *  design can be opened in the visual editor without starting over. */
export function convertLegacyTemplate(template, contentWidth = 190) {
  const W = contentWidth;
  const thermal = W < 100;
  const old = template?.config || {};
  const sec = (id) => (old.sections || []).find((s) => s.id === id) || { visible: false, config: {} };
  const styles = old.styles || {};
  const cfg = blankConfig({ width: W });
  cfg.theme = {
    ...cfg.theme,
    primary: styles.accentColor || cfg.theme.primary,
    headerBg: styles.headingColor || cfg.theme.headerBg,
    text: styles.textColor || cfg.theme.text,
    border: styles.borderColor || cfg.theme.border,
    fontFamily: FONT_FAMILIES.find((f) => f.value === styles.fontFamily)?.value
      || (String(styles.fontFamily || '').includes('Courier') ? "'Courier New', Courier, monospace" : cfg.theme.fontFamily),
    fontSize: r2(Math.max(6, (styles.fontSizePx || 13) * 0.68)),
  };
  const header = [];
  let y = 0;
  const co = sec('company');
  if (co.visible) {
    const c = co.config || {};
    const logoW = c.showLogo ? (thermal ? 18 : 24) : 0;
    if (c.showLogo) header.push({ ...createElement('logo'), id: 'logo', x: thermal ? W / 2 - 9 : 0, y: 0, w: logoW, h: thermal ? 9 : 18 });
    const coX = thermal ? 0 : logoW + (logoW ? 3 : 0);
    header.push({
      ...createElement('companyBlock'), id: 'company', protected: true,
      x: coX, y: thermal && c.showLogo ? 9.5 : 0, w: thermal ? W : W - coX - 66, h: thermal ? 16 : 26,
      nameSize: r2((c.nameSizePx || 24) * 0.68),
      show: { name: c.showName !== false, tagline: !!c.showTagline, address: !!c.showAddress, phone: !!c.showPhone, email: !!c.showEmail, website: !!c.showWebsite, gstin: !!c.showGstin, pan: !!c.showPan },
      style: { fontSize: thermal ? 7.5 : 8, align: thermal || c.align === 'center' ? 'center' : 'left', shrinkToFit: true },
    });
    y = thermal ? (c.showLogo ? 26 : 17) : 0;
  }
  const dt = sec('docTitle');
  const metaSec = sec('meta');
  const metaFields = { invoiceNumber: ['document.number', 'Invoice No'], orderNumber: ['document.orderNumber', 'Order No'], date: ['document.date', 'Date'], dueDate: ['document.dueDate', 'Due Date'], paymentStatus: ['document.paymentStatus', 'Status'], salesperson: ['document.salesperson', 'Salesperson'], branch: ['document.branch', 'Branch'] };
  const metaRows = (metaSec.visible ? metaSec.config?.fields || [] : []).filter((k) => metaFields[k]).map((k) => ({ field: metaFields[k][0], label: metaFields[k][1] }));
  if (thermal) {
    if (dt.visible) { header.push({ ...createElement('field', { preset: { field: 'document.title', hideIfEmpty: false } }), id: 'title', x: 0, y, w: W, h: 5, style: { fontWeight: 800, align: 'center', uppercase: true }, protected: true }); y += 5.5; }
    if (metaRows.length) { header.push({ ...createElement('fieldList'), id: 'meta', x: 0, y, w: W, h: metaRows.length * 3.8 + 1, fields: metaRows, labelWidth: 14 }); y += metaRows.length * 3.8 + 1.5; }
  } else {
    if (dt.visible) header.push({ ...createElement('field', { preset: { field: 'document.title', hideIfEmpty: false } }), id: 'title', x: W - 64, y: 0, w: 64, h: 9, style: { fontSize: 15, fontWeight: 800, align: 'right', uppercase: true }, protected: true });
    if (metaRows.length) header.push({ ...createElement('fieldList'), id: 'meta', x: W - 64, y: 10, w: 64, h: Math.max(14, metaRows.length * 4.2), fields: metaRows });
    y = Math.max(30, 10 + metaRows.length * 4.2 + 2);
  }
  const cu = sec('customer');
  if (cu.visible) {
    const c = cu.config || {};
    header.push({
      ...createElement('partyBlock'), id: 'party', protected: true, x: 0, y, w: thermal ? W : Math.min(100, W), h: thermal ? 10 : 24,
      title: c.title || '',
      show: { title: true, name: c.showName !== false, code: false, phone: !!c.showPhone, email: !!c.showEmail, address: !!c.showAddress, gstin: !!c.showGstin },
    });
    y += thermal ? 10.5 : 26;
  }
  cfg.bands.header = { height: r2(Math.max(y, 12)), elements: header };

  const it = sec('items');
  cfg.bands.items.visible = !!it.visible;
  cfg.bands.items.table = defaultTable({
    columns: (it.config?.columns || []).filter((c) => LEGACY_COLUMN_MAP[c.key]).map((c) => {
      const key = LEGACY_COLUMN_MAP[c.key];
      return { key, label: c.label || COLUMN_BY_KEY[key].label, width: COLUMN_BY_KEY[key].width, align: c.align || COLUMN_BY_KEY[key].align, visible: !!c.enabled };
    }),
    zebra: !!it.config?.zebra,
    showBrand: it.config?.showBrandUnderName !== false,
    ...(thermal ? { headerStyle: { bg: 'transparent', color: '#000000', fontSize: 7.5, fontWeight: 700 }, borders: 'header', rowPadding: 0.6, cellPadX: 0.5, currencyInTable: false, zebra: false } : {}),
  });
  if (!cfg.bands.items.table.columns.length) cfg.bands.items.table.columns = defaultTable().columns;

  const summary = [];
  let sy = 0;
  const tot = sec('totals');
  if (tot.visible) {
    const rows = (tot.config?.rows || []).filter((k) => TOTALS_ROW_BY_KEY[k]);
    const h = Math.max(12, rows.length * 4.6);
    summary.push({
      ...createElement('totals'), id: 'totals', protected: true, x: thermal ? 0 : W - 72, y: 0, w: thermal ? W : 72, h,
      rows: rows.map((k) => ({ key: k, label: '', ...(['grandTotal', 'paid', 'balance'].includes(k) ? { always: true } : {}) })),
    });
    sy = thermal ? h + 1 : 0;
  }
  const pay = sec('payment');
  if (pay.visible) {
    const c = pay.config || {};
    summary.push({ ...createElement('payment'), id: 'pay', x: 0, y: sy, w: thermal ? W : W - 80, h: 16, show: { method: !!c.showMethod, reference: true, splits: true, paid: !!c.showPaid, balance: !!c.showBalance, status: !!c.showStatus, bank: !!c.showBankDetails, upi: false } });
    sy += 17;
  }
  const qr = sec('qr');
  if (qr.visible) {
    const c = qr.config || {};
    const size = Math.min(26, r2((c.sizePx || 96) * 0.26));
    summary.push({ ...createElement('qr'), id: 'qr', x: thermal ? W / 2 - size / 2 : 0, y: sy, w: size, h: size, source: c.source === 'upi' ? 'upi' : c.source === 'custom' ? 'custom' : 'field', customText: c.customText || '' });
    sy += size + 1;
  }
  const bc = sec('barcode');
  if (bc.visible) { summary.push({ ...createElement('barcode'), id: 'barcode', x: thermal ? 0 : 0, y: sy, w: thermal ? W : 60, h: 12 }); sy += 13; }
  const ft = sec('footer');
  const footerEls = [];
  if (ft.visible) {
    const c = ft.config || {};
    const termsText = [c.terms, c.returnPolicy && `Return policy: ${c.returnPolicy}`, c.warranty && `Warranty: ${c.warranty}`, c.customerCare && `Customer care: ${c.customerCare}`].filter(Boolean).join('\n');
    if (termsText) { summary.push({ ...createElement('text'), id: 'terms', x: 0, y: sy, w: thermal ? W : W - 80, h: 18, title: c.terms ? 'Terms & Conditions' : '', text: termsText, style: { fontSize: 7.5 } }); sy += 19; }
    summary.push({ ...createElement('field', { preset: { field: 'document.notes', labelPosition: 'none' } }), id: 'notes', x: 0, y: sy, w: thermal ? W : W - 80, h: 8, style: { fontSize: 7.5 } });
    sy += 9;
    if (c.showSignature && !thermal) summary.push({ ...createElement('signature'), id: 'sign', x: W - 62, y: Math.max(sy - 18, 50), w: 62, h: 18, label: c.signatureLabel || 'Authorised Signatory' });
    if (c.thankYou) {
      if (thermal) { summary.push({ ...createElement('text'), id: 'thanks', x: 0, y: sy, w: W, h: 5, text: c.thankYou, style: { align: 'center', fontWeight: 700 } }); sy += 6; } else footerEls.push({ ...createElement('text'), id: 'thanks', x: 0, y: 0, w: W - 42, h: 5, text: c.thankYou, style: { fontSize: 7.5, fontWeight: 700 } });
    }
  }
  if (!thermal) footerEls.push({ ...createElement('pageNumber'), id: 'page', x: W - 40, y: 0, w: 40, h: 5 });
  const lowest = summary.reduce((m, e) => Math.max(m, e.y + e.h), 0);
  cfg.bands.summary = { height: r2(Math.max(lowest + 1, 10)), elements: summary };
  cfg.bands.footer = { height: footerEls.length ? 6 : 0, elements: footerEls };
  return cfg;
}

export const ITEM_COLUMN_OPTIONS = ITEM_COLUMNS;
