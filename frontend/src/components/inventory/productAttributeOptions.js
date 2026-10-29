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
