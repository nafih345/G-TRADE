// Pure helpers for Add Multiple Items / Product Variant Master: variant generation, SKU codes,
// duplicate detection and row validation. The SKU / key / validation rules mirror the server
// (backend/apps/products/variant_service.py), which re-validates everything on save — these
// only give the grid instant feedback.

import {
  LS_KEYS, readList, DEFAULT_COLORS, DEFAULT_SIZES, DEFAULT_MATERIALS,
  DEFAULT_REFRACTIVE, DEFAULT_COATINGS, DEFAULT_LENS_DESIGNS
} from '../productAttributeOptions';

// Every attribute a variant can vary on. `listKey`/`defaults` point at the same option lists
// the Product Master dialog maintains; `numeric` attributes are usually filled from a sequence.
export const ATTRIBUTE_CATALOG = [
  { key: 'color', label: 'Colour', listKey: LS_KEYS.color, defaults: DEFAULT_COLORS },
  { key: 'size', label: 'Size', listKey: LS_KEYS.size, defaults: DEFAULT_SIZES },
  { key: 'model', label: 'Model', defaults: [] },
  { key: 'power', label: 'Power / SPH', numeric: true, signed: true, seq: { start: '-6.00', end: '+6.00', step: '0.25' } },
  { key: 'cyl', label: 'Cylinder', numeric: true, signed: true, seq: { start: '-2.00', end: '0.00', step: '0.25' } },
  { key: 'axis', label: 'Axis', numeric: true, seq: { start: '10', end: '180', step: '10' } },
  { key: 'addition', label: 'Addition', numeric: true, signed: true, seq: { start: '+1.00', end: '+3.00', step: '0.25' } },
  { key: 'material', label: 'Material', listKey: LS_KEYS.material, defaults: DEFAULT_MATERIALS },
  { key: 'refractive_index', label: 'Refractive Index', listKey: LS_KEYS.refractive, defaults: DEFAULT_REFRACTIVE },
  { key: 'lens_design', label: 'Lens Design', listKey: LS_KEYS.lensDesign, defaults: DEFAULT_LENS_DESIGNS },
  { key: 'coating', label: 'Coating', listKey: LS_KEYS.coating, defaults: DEFAULT_COATINGS },
  { key: 'pack', label: 'Pack Size', defaults: [] },
];

export const attributeMeta = (key) =>
  ATTRIBUTE_CATALOG.find(a => a.key === key) || { key, label: titleCase(key), defaults: [] };

export const attributeOptions = (key) => {
  const meta = attributeMeta(key);
  return meta.listKey ? readList(meta.listKey, meta.defaults || []) : (meta.defaults || []);
};

// Which attributes a category starts with. Only a starting point — the user (or a template)
// can add or drop attributes, so no product is forced to carry ones that don't apply.
const CATEGORY_ATTRIBUTES = [
  [/contact/i, ['power', 'cyl', 'axis']],
  [/lens/i, ['refractive_index', 'coating', 'power']],
  [/reading|reader/i, ['color', 'power']],
  [/frame|sunglass|spectacle/i, ['color', 'size']],
  [/solution|drop|clean/i, ['pack']],
];
export const defaultAttributesForCategory = (category) => {
  const hit = CATEGORY_ATTRIBUTES.find(([re]) => re.test(category || ''));
  return hit ? hit[1] : ['color', 'size'];
};

export const titleCase = (s) => String(s || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

// ---------------------------------------------------------------- sequences

const decimalsOf = (s) => (String(s).split('.')[1] || '').length;

// Numeric run, inclusive: ("-1.00", "1.00", "0.25", signed) → ["-1.00", "-0.75", …, "+1.00"].
export const numericSequence = (start, end, step, { signed = false, limit = 2000 } = {}) => {
  const a = parseFloat(start), b = parseFloat(end);
  let st = Math.abs(parseFloat(step));
  if (!Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(st) || st === 0) return [];
  const dp = Math.max(decimalsOf(start), decimalsOf(end), decimalsOf(step));
  const scale = 10 ** dp;
  const ai = Math.round(a * scale), bi = Math.round(b * scale), si = Math.round(st * scale);
  if (si === 0) return [];
  const dir = ai <= bi ? 1 : -1;
  const out = [];
  for (let v = ai; dir > 0 ? v <= bi : v >= bi; v += dir * si) {
    const n = v / scale;
    let text = n.toFixed(dp);
    if (signed && n > 0) text = `+${text}`;
    if (signed && n === 0) text = (0).toFixed(dp);
    out.push(text);
    if (out.length >= limit) break;
  }
  return out;
};

const lettersToNum = (s) => s.toUpperCase().split('').reduce((n, ch) => n * 26 + (ch.charCodeAt(0) - 64), 0);
const numToLetters = (n) => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

// Alphabetic run, inclusive: ("A", "E") → A B C D E; ("Y", "AB") → Y Z AA AB.
export const alphaSequence = (start, end, { limit = 2000 } = {}) => {
  if (!/^[a-z]+$/i.test(start || '') || !/^[a-z]+$/i.test(end || '')) return [];
  const a = lettersToNum(start), b = lettersToNum(end);
  const dir = a <= b ? 1 : -1;
  const out = [];
  for (let v = a; dir > 0 ? v <= b : v >= b; v += dir) {
    out.push(numToLetters(v));
    if (out.length >= limit) break;
  }
  return out;
};

// ---------------------------------------------------------------- generation

// [{key, values}] → every combination, first axis varying slowest (Black S, Black M, … Brown S …).
export const cartesian = (axes) => {
  const active = axes.filter(a => a.key && a.values && a.values.length);
  if (!active.length) return [];
  return active.reduce((acc, axis) => {
    const out = [];
    acc.forEach(combo => uniqueValues(axis.values).forEach(v => out.push({ ...combo, [axis.key]: v })));
    return out;
  }, [{}]);
};

export const uniqueValues = (values) => {
  const seen = new Set();
  return (values || []).map(v => String(v).trim()).filter(v => {
    const k = v.toLowerCase();
    if (!v || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

export const combinationCount = (axes) => {
  const active = axes.filter(a => a.key && a.values && a.values.length);
  return active.length ? active.reduce((n, a) => n * uniqueValues(a.values).length, 1) : 0;
};

export const normaliseAttributes = (attrs) => {
  const out = {};
  Object.entries(attrs || {}).forEach(([k, v]) => {
    let key = String(k).trim().toLowerCase().replace(/ /g, '_');
    if (key === 'colour') key = 'color';
    const val = v == null ? '' : String(v).trim();
    if (key && val) out[key] = val;
  });
  return out;
};

export const variantKey = (attrs) => {
  const n = normaliseAttributes(attrs);
  const keys = Object.keys(n).sort();
  return keys.length ? keys.map(k => `${k}=${n[k].toLowerCase()}`).join('|') : '__base__';
};

export const attrCode = (value) => {
  const text = String(value ?? '').trim().toUpperCase();
  if (!text) return '';
  const num = text.match(/^([+-]?)(\d+(?:\.\d+)?)$/);
  if (num) return ({ '-': 'M', '+': 'P' }[num[1]] || '') + num[2].replace('.', '');
  const alnum = text.replace(/[^A-Z0-9]/g, '');
  if (alnum.length <= 3) return alnum;
  let skeleton = alnum[0] + alnum.slice(1).replace(/[AEIOU]/g, '');
  if (skeleton.length > 3) skeleton = skeleton.slice(0, 2) + skeleton.slice(-1);
  return skeleton.length >= 2 ? skeleton : alnum.slice(0, 3);
};

export const baseSkuFromName = (name) =>
  (String(name || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase().slice(0, 6)) || 'ITEM';

export const buildVariantSku = (base, attrs, order = []) => {
  const n = normaliseAttributes(attrs);
  const keys = [...order.filter(k => k in n), ...Object.keys(n).filter(k => !order.includes(k)).sort()];
  return [String(base || '').toUpperCase().trim(), ...keys.map(k => attrCode(n[k]))].filter(Boolean).join('-').slice(0, 150);
};

export const variantLabel = (attrs, order = []) => {
  const n = normaliseAttributes(attrs);
  const keys = [...order.filter(k => k in n), ...Object.keys(n).filter(k => !order.includes(k))];
  return keys.map(k => n[k]).join(' / ');
};

let ridSeq = 0;
export const newRid = () => `r${Date.now().toString(36)}${(ridSeq++).toString(36)}`;

// Grid row. `id` is set only for rows already saved in the Product Master.
export const makeRow = (defaults = {}, attributes = {}, extra = {}) => ({
  _rid: newRid(),
  id: null,
  name: '',
  long_name: '',
  category: defaults.category || '',
  sub_category: defaults.sub_category || '',
  group: defaults.group || '',
  brand: defaults.brand || '',
  model_number: defaults.model_number || '',
  hsn_code: defaults.hsn_code || '',
  attributes: normaliseAttributes(attributes),
  quantity: defaults.quantity ?? '',
  cost_price: defaults.cost_price ?? '',
  mrp: defaults.mrp ?? '',
  sales_price: defaults.sales_price ?? '',
  tax_percent: defaults.tax_percent ?? '',
  sku: '',
  barcode: '',
  opening_stock: '',
  stock: null,
  minimum_stock: null,
  is_active: true,
  _generated: false,
  _edited: false,
  ...extra,
});

export const rowFromSaved = (v) => makeRow({}, v.attributes || {}, {
  id: v.id,
  name: v.name || '',
  long_name: v.long_name || '',
  category: v.category || '',
  sub_category: v.sub_category || '',
  group: v.group || '',
  brand: v.brand || '',
  model_number: v.model_number || '',
  hsn_code: v.hsn_code || '',
  cost_price: v.cost_price ?? '',
  mrp: v.mrp ?? '',
  sales_price: v.sales_price ?? '',
  tax_percent: v.tax_percent ?? '',
  sku: v.sku || '',
  barcode: v.barcode || '',
  stock: v.stock ?? 0,
  minimum_stock: v.minimum_stock ?? null,
  is_active: v.is_active !== false,
});

// Regenerate against the current grid without losing work: rows whose combination already
// exists are kept untouched (saved rows always stay), new combinations are appended, and
// unsaved rows whose combination is no longer generated are dropped. `editedDropped` counts
// the dropped rows the user had typed into, so the caller can warn first.
export const mergeGenerated = (rows, combos, defaults) => {
  const wanted = new Map(combos.map(c => [variantKey(c), c]));
  const kept = [];
  let editedDropped = 0;
  rows.forEach(r => {
    const k = variantKey(r.attributes);
    if (r.id || !r._generated || wanted.has(k)) kept.push(r);
    else if (r._edited) editedDropped += 1;
  });
  const have = new Set(kept.map(r => variantKey(r.attributes)));
  const added = [];
  combos.forEach(c => {
    const k = variantKey(c);
    if (!have.has(k)) { have.add(k); added.push(makeRow(defaults, c, { _generated: true })); }
  });
  const dropped = rows.length - kept.length;
  return { rows: [...kept, ...added], added: added.length, dropped, editedDropped };
};

// ---------------------------------------------------------------- validation

const num = (v) => (v === '' || v == null ? null : Number(String(v).replace(/[,%]/g, '')));

// Returns { [_rid]: { field: message } }. Same rules the server enforces.
export const validateRows = (rows, { grouped = true, context = 'inventory', parentName = '' } = {}) => {
  const errors = {};
  const add = (r, f, m) => { (errors[r._rid] = errors[r._rid] || {})[f] = m; };
  const seen = { key: new Map(), sku: new Map(), barcode: new Map() };
  rows.forEach((r, i) => {
    // A variant row takes its name from the parent; without either it can't be saved.
    const hasName = String(r.name || '').trim() || (parentName && grouped);
    if (!hasName) add(r, 'name', Object.keys(r.attributes || {}).length ? 'Enter the Product Name (above) or a name for this row.' : 'Product name is required.');
    ['cost_price', 'mrp', 'sales_price', 'tax_percent', 'quantity', 'opening_stock'].forEach(f => {
      const v = num(r[f]);
      if (v === null) return;
      if (!Number.isFinite(v)) add(r, f, 'Must be a number.');
      else if (v < 0) add(r, f, 'Cannot be negative.');
      else if (f === 'tax_percent' && v > 100) add(r, f, 'Cannot be more than 100.');
      else if ((f === 'quantity' || f === 'opening_stock') && !Number.isInteger(v)) add(r, f, 'Whole number only.');
    });
    const mrp = num(r.mrp), sp = num(r.sales_price);
    if (mrp && sp && sp > mrp) add(r, 'sales_price', 'Sales price cannot be more than MRP.');
    if (r.id && context === 'inventory' && num(r.opening_stock)) add(r, 'opening_stock', 'Opening stock is for new items only.');

    const checks = [['sku', String(r.sku || '').trim().toLowerCase()], ['barcode', String(r.barcode || '').trim()]];
    if (grouped) checks.push(['key', variantKey(r.attributes)]);
    checks.forEach(([field, val]) => {
      if (!val) return;
      if (seen[field].has(val)) {
        const other = seen[field].get(val) + 1;
        if (field === 'key') add(r, 'attributes', `Duplicate variant — same as row ${other}.`);
        else add(r, field, `${field === 'sku' ? 'SKU' : 'Barcode'} repeated — same as row ${other}.`);
      } else seen[field].set(val, i);
    });
  });
  return errors;
};

// Server errors arrive keyed by payload index → map them back onto row ids.
export const serverErrorsToRows = (rowErrors, sentRows) => {
  const out = {};
  Object.entries(rowErrors || {}).forEach(([i, errs]) => {
    const r = sentRows[Number(i)];
    if (r) out[r._rid] = errs;
  });
  return out;
};

export const rowToPayload = (r) => ({
  id: r.id || undefined,
  name: String(r.name || '').trim(),
  long_name: r.long_name || '',
  attributes: normaliseAttributes(r.attributes),
  sku: String(r.sku || '').trim(),
  barcode: String(r.barcode || '').trim(),
  category: r.category, sub_category: r.sub_category, group: r.group, brand: r.brand,
  model_number: r.model_number, hsn_code: r.hsn_code,
  cost_price: r.cost_price, mrp: r.mrp, sales_price: r.sales_price, tax_percent: r.tax_percent,
  opening_stock: r.opening_stock,
  is_active: r.is_active !== false,
});

export const rowsToCsv = (header, lines) => {
  const esc = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...lines].map(l => l.map(esc).join(',')).join('\r\n');
};

export const downloadBlob = (content, filename, type = 'text/csv;charset=utf-8') => {
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
