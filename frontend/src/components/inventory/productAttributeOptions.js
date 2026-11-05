// Option lists shared by the Product Master dialog and the Add Multiple Items / Product
// Variant Master screen. Category and Brand come from the backend masters (these arrays are
// only the fallback); the rest have no backend master and are kept in localStorage so
// anything the user adds sticks around for the next entry.

export const opticalCategories = [
  'Frames', 'Prescription Lenses', 'Sunglasses', 'Contact Lenses',
  'Reading Glasses', 'Accessories', 'Lens Solutions', 'Cleaning Kits',
  'Cases', 'Eye Drops'
];

export const opticalBrands = [
  'RayBan', 'Oakley', 'Essilor', 'Zeiss', 'Hoya', 'Crizal',
  'Kodak', 'Bausch + Lomb', 'Johnson & Johnson'
];

// Attribute option lists that have no dedicated backend master — kept in localStorage
// so anything the user adds sticks around for the next entry.
export const LS_KEYS = {
  subCategory: 'optical_attr_subcategories',
  group: 'optical_attr_groups',
  modelNumber: 'optical_attr_model_numbers',
  size: 'optical_attr_sizes',
  color: 'optical_attr_colors',
  material: 'optical_attr_materials',
  refractive: 'optical_attr_refractive_indexes',
  lensDesign: 'optical_attr_lens_designs',
  coating: 'optical_attr_coatings',
  // Built-in category/brand names the user deleted or renamed, so the fallback
  // lists above don't bring them back.
  hiddenCategories: 'optical_attr_hidden_categories',
  hiddenBrands: 'optical_attr_hidden_brands'
};
export const DEFAULT_MATERIALS = ['Acetate', 'TR90', 'Metal', 'Titanium', 'Stainless Steel', 'Polycarbonate', 'CR39'];
export const DEFAULT_REFRACTIVE = ['1.50 Standard CR39', '1.56 Mid Index Blue Cut', '1.60 Hi-Index', '1.67 Ultra Thin', '1.74 Super High Index'];
export const DEFAULT_LENS_DESIGNS = ['Single Vision', 'Progressive Digital', 'Bifocal D-Seg', 'Office / Workspace'];
export const DEFAULT_COATINGS = ['Anti-Glare (ARC)', 'Blue Cut UV420', 'Photochromic Auto-Tint', 'Polarized Sun Shield', 'Hard Coated Scratch Resistant'];

export const DEFAULT_GROUPS = ['Optical Frame', 'Sunglass', 'Ophthalmic Lens', 'Contact Lens', 'Accessory', 'Solution & Care'];
export const DEFAULT_SIZES = ['Small', 'Medium', 'Large', '48-18-140', '50-20-145', '52-18-140', '54-16-140', '56-16-145'];
export const DEFAULT_COLORS = ['Black', 'Brown', 'Gunmetal', 'Gold', 'Silver', 'Blue', 'Tortoise', 'Transparent', 'Rose Gold'];
export const DEFAULT_SUBCATEGORIES = ['Full Rim', 'Half Rim / Supra', 'Rimless', 'Titanium', 'Acetate', 'Kids', 'Computer / Blue Cut'];

export const readList = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : fallback;
  } catch {
    return fallback;
  }
};
export const writeList = (key, list) => {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch {}
};

// ── Add New Product: Frame / General vs Lens mode ─────────────────────────────────────────
// The Product Master dialog lists only the current mode's options. Category and Brand rows
// carry product_mode (FRAME / LENS / BOTH) on the backend — resolved_mode fills in untagged
// rows from the name / the products using them (backend/apps/masters/product_modes.py). The
// local lists below are kept per mode, so a lens coating never shows up for a frame.
export const PRODUCT_MODES = { FRAME: 'FRAME', LENS: 'LENS' };
export const DEFAULT_CATEGORY_FOR_MODE = { FRAME: 'Frames', LENS: 'Prescription Lenses' };

// Mirrors _LENS_BRAND in backend/apps/masters/product_modes.py.
const LENS_BRAND_RE = /essilor|zeiss|hoya|crizal|kodak|nikon|rodenstock|varilux|shamir|seiko|younger|vision ?rx|gkb|tokai|indo|\blens/i;
// Mirrors isSpectacleLensCategory in utils/lensUnits.js (kept local to avoid a cycle).
const isLensCategoryName = (name) => {
  const t = String(name || '').toLowerCase();
  if (!t || /contact|solution|clean|case|cloth|drop|kit|accessor|frame|sunglass/.test(t)) return false;
  return /\blens(es)?\b|ophthalmic/.test(t);
};

/** Mode of a category / brand name with no backend tag (built-in fallback names). */
export const inferCategoryMode = (name) => (isLensCategoryName(name) ? 'LENS' : 'FRAME');
export const inferBrandMode = (name) => (LENS_BRAND_RE.test(String(name || '')) ? 'LENS' : 'FRAME');
export const inMode = (tag, mode) => tag === 'BOTH' || tag === mode;

export const DEFAULT_FRAME_SUBCATEGORIES = ['Full Rim', 'Half Rim / Supra', 'Rimless', 'Kids', 'Sports', 'Fashion'];
export const DEFAULT_FRAME_GROUPS = ['Optical Frame', 'Sunglass', 'Reading Glass', 'Contact Lens', 'Accessory', 'Solution & Care'];
export const DEFAULT_FRAME_MATERIALS = ['Acetate', 'TR90', 'Metal', 'Titanium', 'Stainless Steel', 'Aluminium', 'Ultem'];
export const DEFAULT_FRAME_SHAPES = ['Rectangle', 'Round', 'Square', 'Oval', 'Aviator', 'Cat Eye', 'Wayfarer', 'Geometric', 'Butterfly'];

export const DEFAULT_LENS_SUBCATEGORIES = ['Stock Lens', 'RX / Lab Lens', 'Blue Cut', 'Photochromic', 'Polarized', 'Tinted'];
export const DEFAULT_LENS_GROUPS = ['Ophthalmic Lens', 'Stock Lens', 'Lab Lens', 'Premium Lens'];
export const DEFAULT_LENS_MATERIALS = ['CR39', 'Polycarbonate', 'Trivex', 'Hi-Index Plastic', 'Glass'];
export const DEFAULT_POWER_RANGES = [
  'SPH 0 to ±4.00 / CYL to -2.00', 'SPH 0 to ±6.00 / CYL to -2.00',
  'SPH ±6.25 to ±8.00 / CYL to -4.00', 'SPH ±8.25 to ±12.00 / CYL to -6.00', 'ADD +0.75 to +3.50'
];

// Every lens-only built-in value — left out when a frame list is first seeded from the older
// shared list (LS_KEYS.subCategory etc., still used by Add Multiple Items), which may hold
// lens entries saved there.
const LENS_ONLY_VALUES = new Set([
  ...DEFAULT_LENS_SUBCATEGORIES, ...DEFAULT_LENS_GROUPS, ...DEFAULT_LENS_MATERIALS,
  ...DEFAULT_REFRACTIVE, ...DEFAULT_LENS_DESIGNS, ...DEFAULT_COATINGS, ...DEFAULT_POWER_RANGES,
  'Computer / Blue Cut'
].map(v => v.toLowerCase()));

// field → { key, defaults, legacyKey? } for each mode. A field missing from a mode is not shown in it.
export const MODE_LISTS = {
  FRAME: {
    subCategory: { key: 'optical_attr_frame_subcategories', defaults: DEFAULT_FRAME_SUBCATEGORIES, legacyKey: LS_KEYS.subCategory },
    group: { key: 'optical_attr_frame_groups', defaults: DEFAULT_FRAME_GROUPS, legacyKey: LS_KEYS.group },
    material: { key: 'optical_attr_frame_materials', defaults: DEFAULT_FRAME_MATERIALS, legacyKey: LS_KEYS.material },
    size: { key: LS_KEYS.size, defaults: DEFAULT_SIZES },
    color: { key: LS_KEYS.color, defaults: DEFAULT_COLORS },
    frameShape: { key: 'optical_attr_frame_shapes', defaults: DEFAULT_FRAME_SHAPES },
  },
  LENS: {
    subCategory: { key: 'optical_attr_lens_subcategories', defaults: DEFAULT_LENS_SUBCATEGORIES },
    group: { key: 'optical_attr_lens_groups', defaults: DEFAULT_LENS_GROUPS },
    material: { key: 'optical_attr_lens_materials', defaults: DEFAULT_LENS_MATERIALS },
    refractive: { key: LS_KEYS.refractive, defaults: DEFAULT_REFRACTIVE },
    lensDesign: { key: LS_KEYS.lensDesign, defaults: DEFAULT_LENS_DESIGNS },
    coating: { key: LS_KEYS.coating, defaults: DEFAULT_COATINGS },
    powerRange: { key: 'optical_attr_power_ranges', defaults: DEFAULT_POWER_RANGES },
  },
};

/** { field: options[] } for one mode, read from localStorage. */
export const readModeLists = (mode) => Object.fromEntries(
  Object.entries(MODE_LISTS[mode]).map(([field, { key, defaults, legacyKey }]) => {
    const legacy = legacyKey ? readList(legacyKey, null) : null;
    const seed = legacy ? legacy.filter(v => !LENS_ONLY_VALUES.has(String(v).toLowerCase())) : defaults;
    return [field, readList(key, seed)];
  })
);
