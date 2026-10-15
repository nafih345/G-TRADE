// Barcode label designer — dynamic field catalog + value formatting.
//
// Mirrors backend/apps/products/label_fields.py (the API validates against that one;
// GET /api/products/label-fields/ also tells us which restricted fields this user may
// use). Templates only reference field ids — values are resolved from the database at
// preview / print time (POST /api/products/label-data/), never typed into a template.
// Pure module: no DOM, no network — unit-tested with `node --test`.

export const FIELD_GROUPS = [
  { id: 'product', label: 'Product' },
  { id: 'pricing', label: 'Pricing' },
  { id: 'store', label: 'Store' },
  { id: 'job', label: 'Print batch' },
];

export const LABEL_FIELDS = [
  { id: 'product_name', label: 'Product name', group: 'product', kind: 'text' },
  { id: 'brand', label: 'Brand', group: 'product', kind: 'text' },
  { id: 'model_number', label: 'Model number', group: 'product', kind: 'text' },
  { id: 'sku', label: 'SKU / Product code', group: 'product', kind: 'text' },
  { id: 'barcode', label: 'Barcode number', group: 'product', kind: 'text' },
  { id: 'colour', label: 'Colour', group: 'product', kind: 'text' },
  { id: 'size', label: 'Size', group: 'product', kind: 'text' },
  { id: 'variant', label: 'Variant (all attributes)', group: 'product', kind: 'text' },
  { id: 'frame_type', label: 'Frame type', group: 'product', kind: 'text' },
  { id: 'category', label: 'Category', group: 'product', kind: 'text' },
  { id: 'sub_category', label: 'Sub-category', group: 'product', kind: 'text' },
  { id: 'hsn_code', label: 'HSN code', group: 'product', kind: 'text' },
  { id: 'rack_location', label: 'Rack location', group: 'product', kind: 'text' },
  { id: 'supplier_name', label: 'Supplier', group: 'product', kind: 'text' },
  { id: 'selling_price', label: 'Selling price', group: 'pricing', kind: 'price' },
  { id: 'mrp', label: 'MRP', group: 'pricing', kind: 'price' },
  { id: 'offer_price', label: 'Offer price', group: 'pricing', kind: 'price', job: true },
  { id: 'wholesale_price', label: 'Wholesale price', group: 'pricing', kind: 'price', restricted: true },
  { id: 'cost_price', label: 'Purchase cost', group: 'pricing', kind: 'price', restricted: true },
  { id: 'store_name', label: 'Store name', group: 'store', kind: 'text' },
  { id: 'store_phone', label: 'Store phone', group: 'store', kind: 'text' },
  { id: 'batch_no', label: 'Batch no', group: 'job', kind: 'text', job: true },
  { id: 'expiry_date', label: 'Expiry date', group: 'job', kind: 'date', job: true },
  { id: 'print_date', label: 'Print date', group: 'job', kind: 'date', job: true },
];

export const FIELD_BY_ID = Object.fromEntries(LABEL_FIELDS.map((f) => [f.id, f]));
export const RESTRICTED_FIELD_IDS = new Set(LABEL_FIELDS.filter((f) => f.restricted).map((f) => f.id));
// Fields typed per print batch (not stored on the product).
export const JOB_FIELD_IDS = new Set(LABEL_FIELDS.filter((f) => f.job).map((f) => f.id));

export const fieldLabel = (id) => FIELD_BY_ID[id]?.label || id;

const clean = (v) => {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return ['none', 'null', 'nan', 'undefined'].includes(s.toLowerCase()) ? '' : s;
};

const firstOf = (obj, ...keys) => {
  if (!obj) return '';
  for (const k of keys) {
    const v = clean(obj[k]);
    if (v) return v;
  }
  return '';
};

const extraOf = (product, ...keys) => {
  const data = product?.extra_data && typeof product.extra_data === 'object' ? product.extra_data : {};
  const lowered = Object.fromEntries(Object.entries(data).map(([k, v]) => [String(k).toLowerCase(), v]));
  for (const k of keys) {
    const v = clean(lowered[k.toLowerCase()]);
    if (v) return v;
  }
  return '';
};

// Positive amount as "1234.50"; '' when missing or zero (₹0.00 on a shelf tag would mislead).
export const money = (v) => {
  if (v === undefined || v === null || v === '') return '';
  const n = parseFloat(String(v).replace(/[₹,\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n.toFixed(2) : '';
};

// Field values for a product that only exists in the browser (offline / legacy
// localStorage inventory, or a Purchase Entry row not yet saved). Backend products are
// resolved server-side instead — this is the fallback, using the same field ids.
export function resolveLocalProductFields(product) {
  if (!product) return {};
  const attrs = product.variant_attributes && typeof product.variant_attributes === 'object' ? product.variant_attributes : {};
  const colour = firstOf(product, 'colour', 'color') || clean(attrs.color) || extraOf(product, 'color', 'colour');
  const size = firstOf(product, 'size') || clean(attrs.size) || extraOf(product, 'size', 'frame_size');
  const attrText = Object.values(attrs).map(clean).filter(Boolean).join(' / ');
  return {
    product_name: firstOf(product, 'name', 'productName', 'product_name'),
    brand: firstOf(product, 'brand_name', 'brand') === 'Generic' ? '' : firstOf(product, 'brand_name', 'brand'),
    model_number: firstOf(product, 'model_number', 'modelNumber', 'model_no') || extraOf(product, 'model_no', 'model'),
    sku: firstOf(product, 'sku', 'code', 'product_code'),
    barcode: firstOf(product, 'barcode'),
    selling_price: money(product.sellingPrice ?? product.selling_price ?? product.retail_price ?? product.price),
    mrp: money(product.mrp ?? extraOf(product, 'mrp')),
    colour,
    size,
    variant: attrText || [colour, size].filter(Boolean).join(' / '),
    frame_type: firstOf(product, 'frame_type', 'frameType') || extraOf(product, 'frame_type'),
    category: firstOf(product, 'category_name', 'category'),
    sub_category: firstOf(product, 'sub_category') || extraOf(product, 'sub_category'),
    hsn_code: firstOf(product, 'hsn_code', 'hsnCode'),
    rack_location: firstOf(product, 'rack_location', 'rack'),
    supplier_name: firstOf(product, 'supplier_name', 'supplier'),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

export function formatDate(value) {
  const s = clean(value);
  if (!s) return '';
  const m = s.match(/^(\d{4})-(\d{2})(?:-(\d{2}))?/);
  if (m) return m[3] ? `${m[3]}-${m[2]}-${m[1]}` : `${m[2]}/${m[1]}`;
  return s;
}

export function todayIso(now = new Date()) {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function formatPrice(value, format = 'currency') {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return '';
  if (format === 'currency0') return `₹${Math.round(n).toLocaleString('en-IN')}`;
  const fixed = n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return format === 'number' ? fixed : `₹${fixed}`;
}

// Raw value of one field for one label. `data` = { fields, store, job }.
export function rawFieldValue(fieldId, data) {
  if (!fieldId || !data) return '';
  const def = FIELD_BY_ID[fieldId];
  if (!def) return '';
  if (def.group === 'store') return clean(data.store?.[fieldId]);
  if (def.job) {
    if (fieldId === 'print_date') return clean(data.job?.print_date) || todayIso();
    if (fieldId === 'offer_price') return money(data.job?.offer_price);
    return clean(data.job?.[fieldId]);
  }
  return clean(data.fields?.[fieldId]);
}

export function formatFieldValue(fieldId, raw, priceFormat = 'currency') {
  if (!raw) return '';
  const kind = FIELD_BY_ID[fieldId]?.kind;
  if (kind === 'price') return formatPrice(raw, priceFormat);
  if (kind === 'date') return formatDate(raw);
  return raw;
}

// Resolves what a field element prints, applying its empty-value fallback.
// Returns { text, hidden, missing } — `missing` = no real value (even if a fallback filled it).
export function resolveFieldElement(el, data) {
  const raw = rawFieldValue(el.field, data);
  const withAffixes = (v) => `${el.prefix || ''}${v}${el.suffix || ''}`;
  if (raw) {
    return { text: withAffixes(formatFieldValue(el.field, raw, el.priceFormat)), hidden: false, missing: false };
  }
  const fb = el.fallback || { mode: 'hide' };
  if (fb.mode === 'text') return { text: fb.text ? withAffixes(fb.text) : '', hidden: false, missing: true };
  if (fb.mode === 'field' && fb.field) {
    const alt = rawFieldValue(fb.field, data);
    if (alt) return { text: withAffixes(formatFieldValue(fb.field, alt, el.priceFormat)), hidden: false, missing: true };
  }
  if (fb.mode === 'blank') return { text: '', hidden: false, missing: true };
  return { text: '', hidden: true, missing: true };
}

// Sample data for designing before a real product is picked, plus edge cases the
// preview must handle: a very long name, missing optional fields, a long barcode.
export const SAMPLE_SCENARIOS = [
  {
    id: 'typical', label: 'Typical frame',
    fields: {
      product_name: 'Ray-Ban Aviator Classic', brand: 'Ray-Ban', model_number: 'RB3025', sku: 'RB3025-GLD-58',
      barcode: '8901234567890', colour: 'Gold', size: '58', variant: 'Gold / 58', frame_type: 'Full Rim',
      category: 'Sunglasses', sub_category: 'Aviator', hsn_code: '9004', rack_location: 'A3', supplier_name: 'Luxottica India',
      selling_price: '4590.00', mrp: '4990.00', wholesale_price: '3600.00', cost_price: '2900.00',
    },
  },
  {
    id: 'long', label: 'Long product name',
    fields: {
      product_name: 'Titan Eye+ Lightweight Titanium Rimless Rectangle Progressive-Ready Frame for Men',
      brand: 'Titan Eyeplus', model_number: 'TW1234-MATTE-GUNMETAL', sku: 'TIT-TW1234-GUN-54-XL',
      barcode: 'TITTW1234GUN54XL', colour: 'Matte Gunmetal Grey', size: '54-18-145', variant: 'Matte Gunmetal Grey / 54-18-145',
      frame_type: 'Rimless', category: 'Frames', selling_price: '128990.00', mrp: '139990.00',
    },
  },
  {
    id: 'minimal', label: 'Missing optional fields',
    fields: { product_name: 'Lens Cleaning Cloth', sku: 'ACC-CLOTH', barcode: '200000100017', selling_price: '50.00' },
  },
  {
    id: 'longcode', label: 'Long barcode (Code 128)',
    fields: {
      product_name: 'Bausch + Lomb Soflens Daily', brand: 'Bausch + Lomb', sku: 'BL-SOFLENS-D-30PK-M275',
      barcode: 'BLSOFLENSD30PKM275', size: '-2.75', variant: '-2.75', selling_price: '1250.00', mrp: '1300.00',
    },
  },
];

export const SAMPLE_STORE = { store_name: 'Greensol Opticals', store_phone: '+91 98765 43210' };
export const SAMPLE_JOB = { batch_no: 'B-2410', expiry_date: '2027-12-31', offer_price: '3990' };
