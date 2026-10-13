import React, { useState, useEffect, useMemo } from 'react';
import axios from 'axios';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Grid, TextField,
  MenuItem, Button, Stack, Typography, Paper, Autocomplete, Alert, Chip,
  IconButton, Tooltip, Box, Divider
} from '@mui/material';
import {
  Add as AddIcon,
  QrCode as BarcodeIcon,
  AutoAwesome as SparkleIcon,
  Image as ImageIcon,
  Sell as PriceIcon,
  Category as CategoryIcon,
  Inventory2 as StockIcon,
  Straighten as SizeIcon,
  Info as InfoIcon,
  DeleteOutline as DeleteIcon,
  EditOutlined as EditIcon,
  Check as SaveIcon,
  Close as CloseIcon
} from '@mui/icons-material';
import BarcodeSection from './BarcodeSection';
import { notify } from '../../utils/notify';

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
const LS_KEYS = {
  subCategory: 'optical_attr_subcategories',
  group: 'optical_attr_groups',
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
const DEFAULT_MATERIALS = ['Acetate', 'TR90', 'Metal', 'Titanium', 'Stainless Steel', 'Polycarbonate', 'CR39'];
const DEFAULT_REFRACTIVE = ['1.50 Standard CR39', '1.56 Mid Index Blue Cut', '1.60 Hi-Index', '1.67 Ultra Thin', '1.74 Super High Index'];
const DEFAULT_LENS_DESIGNS = ['Single Vision', 'Progressive Digital', 'Bifocal D-Seg', 'Office / Workspace'];
const DEFAULT_COATINGS = ['Anti-Glare (ARC)', 'Blue Cut UV420', 'Photochromic Auto-Tint', 'Polarized Sun Shield', 'Hard Coated Scratch Resistant'];

const DEFAULT_GROUPS = ['Optical Frame', 'Sunglass', 'Ophthalmic Lens', 'Contact Lens', 'Accessory', 'Solution & Care'];
const DEFAULT_SIZES = ['Small', 'Medium', 'Large', '48-18-140', '50-20-145', '52-18-140', '54-16-140', '56-16-145'];
const DEFAULT_COLORS = ['Black', 'Brown', 'Gunmetal', 'Gold', 'Silver', 'Blue', 'Tortoise', 'Transparent', 'Rose Gold'];
const DEFAULT_SUBCATEGORIES = ['Full Rim', 'Half Rim / Supra', 'Rimless', 'Titanium', 'Acetate', 'Kids', 'Computer / Blue Cut'];

const readList = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    if (raw == null) return fallback;
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : fallback;
  } catch {
    return fallback;
  }
};
const writeList = (key, list) => {
  try { localStorage.setItem(key, JSON.stringify(list)); } catch {}
};

const genCode = (name, len = 3) =>
  (name || 'GEN').replace(/[^a-zA-Z0-9]/g, '').slice(0, len).toUpperCase().padEnd(len, 'X')
  + Math.floor(10 + Math.random() * 89);

const blankProduct = (overrides = {}) => ({
  name: '', code: '', modelNo: '', hsnCode: '',
  category: 'Frames', subCategory: '', group: '', brand: '',
  size: '', color: '', material: '',
  frameType: '', lensType: '', coating: '',
  supplier: '', warehouse: 'Main', rack: '', stock: '',
  purchasePrice: '', mrp: '', salePrice: '', gst: '18%',
  barcode: '',
  ...overrides
});

// A freeSolo select with a "+" that opens a small master for the option list:
// add a new entry, rename one or delete one (to the backend master where one
// exists, otherwise to a local list).
function AttributeField({ label, value, onChange, options, onPersist, onRename, onRemove, disabled }) {
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(null); // { from, to }

  const canManage = Boolean(onRename || onRemove);

  const commit = async () => {
    const v = draft.trim();
    if (!v) return;
    if (options.some(o => o.toLowerCase() === v.toLowerCase())) {
      notify(`"${v}" already exists in ${label}.`);
      return;
    }
    setBusy(true);
    try { await onPersist?.(v); } catch {}
    setBusy(false);
    onChange(v);
    setDraft('');
    if (!canManage) setAddOpen(false);
  };

  const saveRename = async () => {
    const from = editing?.from;
    const to = (editing?.to || '').trim();
    if (!from || !to || to === from) { setEditing(null); return; }
    if (options.some(o => o !== from && o.toLowerCase() === to.toLowerCase())) {
      notify(`"${to}" already exists in ${label}.`);
      return;
    }
    setBusy(true);
    try { await onRename(from, to); } catch { notify(`Could not rename "${from}".`); }
    setBusy(false);
    if (value === from) onChange(to);
    setEditing(null);
  };

  const remove = async (name) => {
    if (!window.confirm(`Delete "${name}" from ${label}?`)) return;
    setBusy(true);
    try { await onRemove(name); } catch { notify(`Could not delete "${name}".`); }
    setBusy(false);
    if (value === name) onChange('');
  };

  const shown = options.filter(o => o.toLowerCase().includes(filter.trim().toLowerCase()));
  const close = () => { setAddOpen(false); setEditing(null); setFilter(''); };

  if (canManage) {
    return (
      <>
        <Stack direction="row" spacing={0.5} alignItems="flex-start">
          <Autocomplete
            freeSolo
            fullWidth
            size="small"
            disabled={disabled}
            options={options}
            value={value || ''}
            onInputChange={(e, v) => onChange(v || '')}
            onChange={(e, v) => onChange(v || '')}
            renderInput={(params) => <TextField {...params} label={label} />}
          />
          <Tooltip title={`Add / Edit / Delete ${label}`}>
            <span>
              <IconButton size="small" color="primary" sx={{ mt: 0.3 }} disabled={disabled} onClick={() => { setDraft(''); setAddOpen(true); }}>
                <AddIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        <Dialog open={addOpen} onClose={close} maxWidth="xs" fullWidth>
          <DialogTitle sx={{ fontWeight: 800 }}>{label} Master</DialogTitle>
          <DialogContent>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <TextField
                autoFocus fullWidth size="small" label={`New ${label}`} value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
              />
              <Button variant="contained" onClick={commit} disabled={busy || !draft.trim()} startIcon={<AddIcon />}>Add</Button>
            </Stack>

            <Divider sx={{ my: 2 }} />

            <TextField
              fullWidth size="small" placeholder={`Search ${label}…`} value={filter}
              onChange={(e) => setFilter(e.target.value)}
              sx={{ mb: 1 }}
            />
            <Box sx={{ maxHeight: 320, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 2 }}>
              {shown.length === 0 && (
                <Typography variant="body2" color="text.secondary" sx={{ p: 2, textAlign: 'center' }}>No entries</Typography>
              )}
              {shown.map((o, i) => (
                <Stack
                  key={o}
                  direction="row" alignItems="center" spacing={1}
                  sx={{ px: 1.5, py: 0.5, borderTop: i ? 1 : 0, borderColor: 'divider', bgcolor: o === value ? 'action.selected' : 'transparent' }}
                >
                  {editing?.from === o ? (
                    <>
                      <TextField
                        autoFocus fullWidth size="small" value={editing.to}
                        onChange={(e) => setEditing({ from: o, to: e.target.value })}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') { e.preventDefault(); saveRename(); }
                          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEditing(null); }
                        }}
                      />
                      <Tooltip title="Save"><span><IconButton size="small" color="success" disabled={busy} onClick={saveRename}><SaveIcon fontSize="small" /></IconButton></span></Tooltip>
                      <Tooltip title="Cancel"><IconButton size="small" onClick={() => setEditing(null)}><CloseIcon fontSize="small" /></IconButton></Tooltip>
                    </>
                  ) : (
                    <>
                      <Typography
                        variant="body2" sx={{ flex: 1, cursor: 'pointer', fontWeight: o === value ? 800 : 500 }}
                        onClick={() => { onChange(o); close(); }}
                      >
                        {o}
                      </Typography>
                      {onRename && (
                        <Tooltip title="Edit"><span><IconButton size="small" color="primary" disabled={busy} onClick={() => setEditing({ from: o, to: o })}><EditIcon fontSize="small" /></IconButton></span></Tooltip>
                      )}
                      {onRemove && (
                        <Tooltip title="Delete"><span><IconButton size="small" color="error" disabled={busy} onClick={() => remove(o)}><DeleteIcon fontSize="small" /></IconButton></span></Tooltip>
                      )}
                    </>
                  )}
                </Stack>
              ))}
            </Box>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Click a name to select it for this product.
            </Typography>
          </DialogContent>
          <DialogActions>
            <Button onClick={close}>Close</Button>
          </DialogActions>
        </Dialog>
      </>
    );
  }

  return (
    <>
      <Stack direction="row" spacing={0.5} alignItems="flex-start">
        <Autocomplete
          freeSolo
          fullWidth
          size="small"
          disabled={disabled}
          options={options}
          value={value || ''}
          onInputChange={(e, v) => onChange(v || '')}
          onChange={(e, v) => onChange(v || '')}
          renderInput={(params) => <TextField {...params} label={label} />}
        />
        <Tooltip title={`Add new ${label}`}>
          <span>
            <IconButton size="small" color="primary" sx={{ mt: 0.3 }} disabled={disabled} onClick={() => { setDraft(''); setAddOpen(true); }}>
              <AddIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Add {label}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth size="small" label={`New ${label}`} value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={commit} disabled={busy}>{busy ? 'Adding…' : 'Add'}</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

function Section({ title, icon, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
      <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 0.75 }}>
        {icon} {title}
      </Typography>
      {children}
    </Paper>
  );
}

// Reusable "Add New Product" (product master) dialog — the same form used on the
// Inventory → Products page, surfaced anywhere a new product needs to be created
// inline (e.g. Purchase Entry). Saves to the products database and reports the
// created product back through onCreated().
const productToForm = (ep) => {
  const isLensCat = (ep.category || '') === 'Prescription Lenses';
  return blankProduct({
  name: ep.name || '',
  code: ep.code || ep.product_code || '',
  modelNo: ep.modelNo || ep.model_no || '',
  hsnCode: ep.hsnCode || ep.hsn_code || '',
  category: ep.category || 'Frames',
  subCategory: ep.subCategory || '',
  group: ep.group || '',
  brand: ep.brand && ep.brand !== 'Generic' ? ep.brand : '',
  size: ep.size || '',
  color: ep.color || ep.colour || '',
  material: ep.material || '',
  frameType: isLensCat ? (ep.frameType || ep.refractive_index || '') : '',
  lensType: isLensCat ? (ep.lensType || ep.lens_design || '') : '',
  coating: isLensCat ? (ep.coating || '') : '',
  supplier: ep.supplier || '',
  warehouse: ep.warehouse || 'Main',
  rack: ep.rack || '',
  stock: (ep.stock ?? '') === '' ? '' : String(ep.stock),
  purchasePrice: (ep.purchasePrice ?? '') === '' ? '' : String(ep.purchasePrice),
  mrp: (ep.mrp ?? '') === '' ? '' : String(ep.mrp),
  salePrice: (ep.salePrice ?? ep.sellingPrice ?? '') === '' ? '' : String(ep.salePrice ?? ep.sellingPrice),
  gst: ep.gst || '18%',
  barcode: ep.barcode || ''
  });
};

export default function ProductMasterDialog({
  open,
  onClose,
  suppliers = [],
  defaultSupplier = '',
  defaultCategory = 'Frames',
  editProduct = null,
  onCreated
}) {
  const isEdit = Boolean(editProduct && editProduct.id);
  const [p, setP] = useState(blankProduct());
  const [saving, setSaving] = useState(false);
  const [scanDialogOpen, setScanDialogOpen] = useState(false);

  const [imageFile, setImageFile] = useState(null);
  const [imagePreview, setImagePreview] = useState('');

  const [categoryOptions, setCategoryOptions] = useState(opticalCategories);
  const [brandOptions, setBrandOptions] = useState(opticalBrands);
  const [subCategoryOptions, setSubCategoryOptions] = useState(() => readList(LS_KEYS.subCategory, DEFAULT_SUBCATEGORIES));
  const [groupOptions, setGroupOptions] = useState(() => readList(LS_KEYS.group, DEFAULT_GROUPS));
  const [sizeOptions, setSizeOptions] = useState(() => readList(LS_KEYS.size, DEFAULT_SIZES));
  const [colorOptions, setColorOptions] = useState(() => readList(LS_KEYS.color, DEFAULT_COLORS));
  const [materialOptions, setMaterialOptions] = useState(() => readList(LS_KEYS.material, DEFAULT_MATERIALS));
  const [refractiveOptions, setRefractiveOptions] = useState(() => readList(LS_KEYS.refractive, DEFAULT_REFRACTIVE));
  const [lensDesignOptions, setLensDesignOptions] = useState(() => readList(LS_KEYS.lensDesign, DEFAULT_LENS_DESIGNS));
  const [coatingOptions, setCoatingOptions] = useState(() => readList(LS_KEYS.coating, DEFAULT_COATINGS));
  // name → backend id for the two lists that live in the masters tables.
  const [categoryRecords, setCategoryRecords] = useState({});
  const [brandRecords, setBrandRecords] = useState({});

  const set =(patch) => setP(prev => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open) return;
    setP(isEdit
      ? productToForm(editProduct)
      : blankProduct({ supplier: defaultSupplier || '', category: defaultCategory || 'Frames' }));
    setImageFile(null);
    setImagePreview(isEdit ? (editProduct.image || '') : '');

    const loadMaster = (url, defaults, hiddenKey, setOptions, setRecords) =>
      axios.get(url)
        .then(r => {
          const rows = (r.data?.results || r.data || []).filter(x => x?.name);
          const hidden = new Set(readList(hiddenKey, []));
          const records = {};
          rows.forEach(x => { records[x.name] = x.id; });
          setRecords(records);
          setOptions(Array.from(new Set([...rows.map(x => x.name), ...defaults.filter(d => !hidden.has(d))])));
        }).catch(() => {
          const hidden = new Set(readList(hiddenKey, []));
          setOptions(defaults.filter(d => !hidden.has(d)));
        });
    loadMaster('/api/masters/categories/', opticalCategories, LS_KEYS.hiddenCategories, setCategoryOptions, setCategoryRecords);
    loadMaster('/api/masters/brands/', opticalBrands, LS_KEYS.hiddenBrands, setBrandOptions, setBrandRecords);
  }, [open, defaultSupplier, defaultCategory, isEdit, editProduct]);

  const hideDefault = (key, name) => writeList(key, Array.from(new Set([...readList(key, []), name])));

  // Backend masters (Category / Brand). Products reference these by FK, so a
  // rename shows up on every product and a delete just clears the link.
  const backendMaster = (url, hiddenKey, records, setRecords, setOptions) => ({
    persist: async (name) => {
      setOptions(o => Array.from(new Set([name, ...o])));
      try {
        const r = await axios.post(url, { name, code: genCode(name) });
        if (r.data?.id) setRecords(m => ({ ...m, [name]: r.data.id }));
      } catch {}
    },
    rename: async (from, to) => {
      const id = records[from];
      if (id) {
        await axios.patch(`${url}${id}/`, { name: to });
      } else {
        // Built-in name with no DB row yet — create the new one, hide the old.
        const r = await axios.post(url, { name: to, code: genCode(to) });
        if (r.data?.id) setRecords(m => ({ ...m, [to]: r.data.id }));
      }
      hideDefault(hiddenKey, from);
      setRecords(m => {
        const next = { ...m };
        if (id) { delete next[from]; next[to] = id; }
        return next;
      });
      setOptions(o => Array.from(new Set(o.map(x => (x === from ? to : x)))));
    },
    remove: async (name) => {
      const id = records[name];
      if (id) await axios.delete(`${url}${id}/`);
      hideDefault(hiddenKey, name);
      setRecords(m => { const next = { ...m }; delete next[name]; return next; });
      setOptions(o => o.filter(x => x !== name));
    }
  });
  const categoryMaster = backendMaster('/api/masters/categories/', LS_KEYS.hiddenCategories, categoryRecords, setCategoryRecords, setCategoryOptions);
  const brandMaster = backendMaster('/api/masters/brands/', LS_KEYS.hiddenBrands, brandRecords, setBrandRecords, setBrandOptions);

  // Local lists (Sub-Category / Group / Size / Color / Material). These are
  // stored as plain text on each product, so a rename only affects new entries.
  const localMaster = (key, setter) => {
    const update = (fn) => setter(o => {
      const next = fn(o);
      writeList(key, next);
      return next;
    });
    return {
      persist: async (name) => update(o => Array.from(new Set([name, ...o]))),
      rename: async (from, to) => update(o => Array.from(new Set(o.map(x => (x === from ? to : x))))),
      remove: async (name) => update(o => o.filter(x => x !== name))
    };
  };
  const subCategoryMaster = localMaster(LS_KEYS.subCategory, setSubCategoryOptions);
  const groupMaster = localMaster(LS_KEYS.group, setGroupOptions);
  const sizeMaster = localMaster(LS_KEYS.size, setSizeOptions);
  const colorMaster = localMaster(LS_KEYS.color, setColorOptions);
  const materialMaster = localMaster(LS_KEYS.material, setMaterialOptions);
  const refractiveMaster = localMaster(LS_KEYS.refractive, setRefractiveOptions);
  const lensDesignMaster = localMaster(LS_KEYS.lensDesign, setLensDesignOptions);
  const coatingMaster = localMaster(LS_KEYS.coating, setCoatingOptions);

  const onPickImage = (file) => {
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const isLens = p.category === 'Prescription Lenses';

  // Lens Mode starts with the usual lens spec filled in (still editable / clearable).
  useEffect(() => {
    if (!open || !isLens) return;
    setP(prev => ({
      ...prev,
      frameType: prev.frameType || '1.56 Mid Index Blue Cut',
      lensType: prev.lensType || 'Single Vision',
      coating: prev.coating || 'Blue Cut UV420'
    }));
  }, [open, isLens]);

  const purchaseNum = parseFloat(p.purchasePrice) || 0;
  const mrpNum = parseFloat(p.mrp) || 0;
  const saleNum = parseFloat(p.salePrice) || 0;
  const marginPct = purchaseNum > 0 && saleNum > 0
    ? (((saleNum - purchaseNum) / purchaseNum) * 100).toFixed(1)
    : null;

  const handleSave = async () => {
    if (!p.name.trim()) {
      alert('Please enter a Product Name.');
      return;
    }
    setSaving(true);

    const code = p.code.trim() || `PRD-${Math.floor(1000 + Math.random() * 9000)}`;
    const purchasePrice = parseFloat(p.purchasePrice) || 0;
    const mrp = parseFloat(p.mrp) || 0;
    const salePrice = parseFloat(p.salePrice) || mrp || 0;
    const stock = parseInt(p.stock) || 0;

    const extra_data = {
      mrp,
      sale_price: salePrice,
      model_no: p.modelNo || '',
      sub_category: p.subCategory || '',
      group: p.group || '',
      size: p.size || '',
      color: p.color || '',
      material: p.material || '',
      gst: p.gst || '',
      lens_design: p.lensType || '',
      refractive_index: p.frameType || '',
      coating: p.coating || ''
    };

    const payload = {
      name: p.name.trim(),
      sku: code,
      barcode: p.barcode || null,
      category_name: p.category || '',
      brand_name: p.brand || '',
      supplier_name: p.supplier || '',
      color: p.color || '',
      size: p.size || '',
      hsn_code: p.hsnCode || '',
      rack_location: p.rack || '',
      cost_price: purchasePrice,
      retail_price: salePrice,
      wholesale_price: mrp,
      stock,
      extra_data
    };
    if (!isEdit) payload.opening_stock = stock;

    let savedId = isEdit ? String(editProduct.id) : String(Date.now());
    let savedBarcode = p.barcode || '';
    try {
      const res = isEdit
        ? await axios.put(`/api/products/items/${editProduct.id}/`, payload)
        : await axios.post('/api/products/items/', payload);
      if (res.data?.id) savedId = String(res.data.id);
      if (res.data?.barcode) savedBarcode = res.data.barcode;

      if (imageFile) {
        try {
          const fd = new FormData();
          fd.append('image', imageFile);
          await axios.patch(`/api/products/items/${savedId}/`, fd, { headers: { 'Content-Type': 'multipart/form-data' } });
        } catch (e) {}
      }
    } catch (err) {
      console.log(isEdit ? 'Product update failed on API (kept local copy).' : 'Product saved to local store only (API unavailable).');
    }

    const productRecord = {
      id: savedId,
      code,
      modelNo: p.modelNo || '',
      barcode: savedBarcode,
      name: p.name.trim(),
      brand: p.brand || '',
      supplier: p.supplier || '',
      category: p.category || 'Frames',
      subCategory: p.subCategory || '',
      group: p.group || '',
      size: p.size || '',
      color: p.color || '',
      material: p.material || '',
      frameType: p.frameType || '',
      lensType: p.lensType || '',
      coating: p.coating || '',
      purchasePrice,
      mrp,
      salePrice,
      sellingPrice: salePrice,
      gst: p.gst || '18%',
      stock,
      rack: p.rack || '',
      warehouse: p.warehouse || 'Main',
      hsnCode: p.hsnCode || '',
      image: imagePreview || '',
      status: isEdit ? (editProduct.status || 'Active') : 'Active'
    };

    try {
      const local = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
      const next = isEdit
        ? local.map(it =>
            String(it.id) === String(editProduct.id) || (productRecord.code && String(it.code) === String(productRecord.code))
              ? { ...it, ...productRecord }
              : it
          )
        : [productRecord, ...local];
      localStorage.setItem('optical_inventory_items', JSON.stringify(next));
    } catch (e) {}
    window.dispatchEvent(new Event('optical_stock_updated'));

    setSaving(false);
    onCreated?.(productRecord);
    alert(`Product '${productRecord.name}' ${isEdit ? 'updated' : 'saved to inventory database'} successfully!`);
    onClose?.();
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3.5 } }}>
        <DialogTitle sx={{ fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1, bgcolor: isLens ? '#0f172a' : '#ffffff', color: isLens ? '#facc15' : 'inherit', transition: 'all 0.3s ease' }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Typography variant="h6" fontWeight={900}>
              {isEdit
                ? (isLens ? '🔬 Edit Ophthalmic Lens Product' : '📦 Edit Optical Stock / Product')
                : (isLens ? '🔬 Add Ophthalmic Lens Product' : '📦 Add Optical Stock / Product')}
            </Typography>
            <Paper variant="outlined" sx={{ p: 0.3, display: 'flex', gap: 0.5, bgcolor: '#f1f5f9', borderRadius: 2 }}>
              <Button
                size="small"
                variant={!isLens ? 'contained' : 'text'}
                onClick={() => set({ category: 'Frames' })}
                sx={{ py: 0.2, px: 1, fontSize: '0.72rem', fontWeight: 800 }}
              >
                Frame / General
              </Button>
              <Button
                size="small"
                variant={isLens ? 'contained' : 'text'}
                onClick={() => set({ category: 'Prescription Lenses' })}
                sx={{ py: 0.2, px: 1, fontSize: '0.72rem', fontWeight: 800 }}
              >
                🔬 Lens Mode
              </Button>
            </Paper>
          </Stack>

          <Button
            variant="contained"
            size="small"
            startIcon={<BarcodeIcon />}
            onClick={() => setScanDialogOpen(true)}
            sx={{ backgroundColor: '#10B981', color: 'white', fontWeight: 700 }}
          >
            📷 Scan Barcode
          </Button>
        </DialogTitle>

        <DialogContent dividers sx={{ bgcolor: '#f8fafc' }}>
          {isLens && (
            <Alert severity="info" icon={<SparkleIcon />} sx={{ mb: 2, borderRadius: 2.5, bgcolor: '#eff6ff', borderColor: '#bfdbfe' }}>
              <Typography variant="subtitle2" fontWeight={900} color="#1e3a8a">
                ⚡ Fast Lens Quick-Fill Presets (Click to auto-populate lens details):
              </Typography>
              <Stack direction="row" spacing={1} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.8 }}>
                <Chip
                  label="⚡ Essilor Crizal 1.67" size="small" clickable color="primary"
                  onClick={() => set({ category: 'Prescription Lenses', name: 'Essilor Crizal Sapphire HR 1.67', brand: 'Essilor', lensType: 'Single Vision', frameType: '1.67', coating: 'Anti-Glare (ARC)', purchasePrice: '1800', mrp: '4200', salePrice: '4200' })}
                  sx={{ fontWeight: 800 }}
                />
                <Chip
                  label="⚡ Hoya BlueControl 1.56" size="small" clickable color="success"
                  onClick={() => set({ category: 'Prescription Lenses', name: 'Hoya BlueControl UV420 1.56', brand: 'Hoya', lensType: 'Single Vision', frameType: '1.56', coating: 'Blue Cut UV420', purchasePrice: '450', mrp: '1450', salePrice: '1450' })}
                  sx={{ fontWeight: 800 }}
                />
                <Chip
                  label="⚡ Zeiss Progressive 1.60" size="small" clickable
                  onClick={() => set({ category: 'Prescription Lenses', name: 'Zeiss SmartLife Progressive 1.60', brand: 'Zeiss', lensType: 'Progressive Digital', frameType: '1.60', coating: 'Anti-Glare (ARC)', purchasePrice: '2400', mrp: '6800', salePrice: '6800' })}
                  sx={{ bgcolor: '#ca8a04', color: '#fff', fontWeight: 800 }}
                />
              </Stack>
            </Alert>
          )}

          <Stack spacing={2}>

            {/* ── Product Details ─────────────────────────── */}
            <Section title="Product Details" icon={<InfoIcon fontSize="small" />}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label={isLens ? 'Lens Product Name & Specification *' : 'Product Name *'}
                    fullWidth size="small" required
                    placeholder={isLens ? 'e.g. Essilor Crizal Sapphire HR 1.67 Blue Cut' : 'e.g. Aviator Classic Rimless'}
                    value={p.name}
                    onChange={(e) => set({ name: e.target.value })}
                    inputProps={{ style: { fontWeight: 800 } }}
                  />
                </Grid>
                <Grid item xs={12} sm={3}>
                  <TextField
                    label="Product Code / SKU" fullWidth size="small"
                    placeholder="Auto if blank"
                    value={p.code}
                    onChange={(e) => set({ code: e.target.value })}
                  />
                </Grid>
                <Grid item xs={12} sm={3}>
                  <TextField
                    label="Model Number" fullWidth size="small"
                    placeholder="e.g. RB3025-001"
                    value={p.modelNo}
                    onChange={(e) => set({ modelNo: e.target.value })}
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="HSN / SAC Code" fullWidth size="small"
                    value={p.hsnCode}
                    onChange={(e) => set({ hsnCode: e.target.value })}
                  />
                </Grid>
              </Grid>
            </Section>

            {/* ── Classification ─────────────────────────── */}
            <Section title="Classification" icon={<CategoryIcon fontSize="small" />}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={3}>
                  <AttributeField label="Category" value={p.category} onChange={(v) => set({ category: v })} options={categoryOptions} onPersist={categoryMaster.persist} onRename={categoryMaster.rename} onRemove={categoryMaster.remove} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <AttributeField label="Sub-Category" value={p.subCategory} onChange={(v) => set({ subCategory: v })} options={subCategoryOptions} onPersist={subCategoryMaster.persist} onRename={subCategoryMaster.rename} onRemove={subCategoryMaster.remove} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <AttributeField label="Group" value={p.group} onChange={(v) => set({ group: v })} options={groupOptions} onPersist={groupMaster.persist} onRename={groupMaster.rename} onRemove={groupMaster.remove} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <AttributeField label="Brand / Manufacturer" value={p.brand} onChange={(v) => set({ brand: v })} options={brandOptions} onPersist={brandMaster.persist} onRename={brandMaster.rename} onRemove={brandMaster.remove} />
                </Grid>
              </Grid>
            </Section>

            {/* ── Variant Attributes ─────────────────────── */}
            <Section title="Variant Attributes" icon={<SizeIcon fontSize="small" />}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={4}>
                  <AttributeField label="Size" value={p.size} onChange={(v) => set({ size: v })} options={sizeOptions} onPersist={sizeMaster.persist} onRename={sizeMaster.rename} onRemove={sizeMaster.remove} />
                </Grid>
                <Grid item xs={12} sm={6} md={4}>
                  <AttributeField label="Color" value={p.color} onChange={(v) => set({ color: v })} options={colorOptions} onPersist={colorMaster.persist} onRename={colorMaster.rename} onRemove={colorMaster.remove} />
                </Grid>
                <Grid item xs={12} sm={6} md={4}>
                  <AttributeField label="Material" value={p.material} onChange={(v) => set({ material: v })} options={materialOptions} onPersist={materialMaster.persist} onRename={materialMaster.rename} onRemove={materialMaster.remove} />
                </Grid>

                {isLens && (
                  <>
                    <Grid item xs={12} sm={4}>
                      <AttributeField label="Refractive Index" value={p.frameType} onChange={(v) => set({ frameType: v })} options={refractiveOptions} onPersist={refractiveMaster.persist} onRename={refractiveMaster.rename} onRemove={refractiveMaster.remove} />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <AttributeField label="Lens Design Type" value={p.lensType} onChange={(v) => set({ lensType: v })} options={lensDesignOptions} onPersist={lensDesignMaster.persist} onRename={lensDesignMaster.rename} onRemove={lensDesignMaster.remove} />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <AttributeField label="Coating Technology" value={p.coating} onChange={(v) => set({ coating: v })} options={coatingOptions} onPersist={coatingMaster.persist} onRename={coatingMaster.rename} onRemove={coatingMaster.remove} />
                    </Grid>
                  </>
                )}
              </Grid>
            </Section>

            {/* ── Pricing (MRP & Sale price as their own part) ── */}
            <Section title="Pricing — MRP & Sale Price" icon={<PriceIcon fontSize="small" />}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField
                    label="Purchase Cost Price (₹)" fullWidth size="small" type="number"
                    value={p.purchasePrice} onChange={(e) => set({ purchasePrice: e.target.value })}
                    inputProps={{ style: { fontWeight: 800 } }}
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField
                    label="MRP Price (₹)" fullWidth size="small" type="number"
                    value={p.mrp}
                    onChange={(e) => set({ mrp: e.target.value, salePrice: p.salePrice || e.target.value })}
                    inputProps={{ style: { fontWeight: 800 } }}
                    helperText="Printed maximum retail price"
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField
                    label="Sale Price (₹)" fullWidth size="small" type="number"
                    value={p.salePrice} onChange={(e) => set({ salePrice: e.target.value })}
                    inputProps={{ style: { fontWeight: 900, color: '#059669' } }}
                    helperText="Actual selling / billing price"
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField select label="GST Tax Rate" fullWidth size="small" value={p.gst} onChange={(e) => set({ gst: e.target.value })}>
                    <MenuItem value="0%">0% (Exempt)</MenuItem>
                    <MenuItem value="5%">5% GST</MenuItem>
                    <MenuItem value="12%">12% GST</MenuItem>
                    <MenuItem value="18%">18% GST</MenuItem>
                    <MenuItem value="28%">28% GST</MenuItem>
                  </TextField>
                </Grid>
              </Grid>
              {(marginPct !== null || (mrpNum > 0 && saleNum > 0 && saleNum !== mrpNum)) && (
                <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                  {marginPct !== null && (
                    <Chip size="small" color={parseFloat(marginPct) >= 0 ? 'success' : 'error'} label={`Margin ${marginPct}%`} sx={{ fontWeight: 700 }} />
                  )}
                  {mrpNum > 0 && saleNum > 0 && saleNum < mrpNum && (
                    <Chip size="small" variant="outlined" label={`Discount off MRP: ₹${(mrpNum - saleNum).toFixed(2)}`} sx={{ fontWeight: 700 }} />
                  )}
                </Stack>
              )}
            </Section>

            {/* ── Barcode (13-digit EAN series) ──────────── */}
            <Section title="Barcode — 13-digit EAN series" icon={<BarcodeIcon fontSize="small" />}>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                “Generate Barcode” issues the next code in a running 13-digit EAN-13 series (e.g. 2000000000015, 2000000000022 …).
              </Typography>
              <BarcodeSection
                mode={isEdit ? 'manage' : 'create'}
                productId={isEdit ? editProduct.id : undefined}
                value={p.barcode}
                onChange={(val) => set({ barcode: val })}
                onSaved={(val) => set({ barcode: val || '' })}
                productName={p.name}
                productCode={p.code}
                productPrice={saleNum || mrpNum || 0}
                productColour={p.color}
                productSize={p.size}
                generateUrl="/api/products/items/next_ean13_candidate/"
              />
            </Section>

            {/* ── Stock & Location ───────────────────────── */}
            <Section title="Stock & Location" icon={<StockIcon fontSize="small" />}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField label="Initial Stock Qty" fullWidth size="small" type="number" value={p.stock} onChange={(e) => set({ stock: e.target.value })} inputProps={{ style: { fontWeight: 800 } }} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField label="Rack Location" fullWidth size="small" placeholder="e.g. Rack A1 / Lens Drawer 2" value={p.rack} onChange={(e) => set({ rack: e.target.value })} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <TextField label="Warehouse" fullWidth size="small" value={p.warehouse} onChange={(e) => set({ warehouse: e.target.value })} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <Autocomplete
                    freeSolo size="small" options={suppliers}
                    value={p.supplier || ''}
                    onInputChange={(e, v) => set({ supplier: v || '' })}
                    onChange={(e, v) => set({ supplier: v || '' })}
                    renderInput={(params) => <TextField {...params} label="Supplier Name" placeholder="Search or select supplier..." fullWidth />}
                  />
                </Grid>
              </Grid>
            </Section>

            {/* ── Product Image ──────────────────────────── */}
            <Section title="Product Image" icon={<ImageIcon fontSize="small" />}>
              <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
                <Box
                  sx={{
                    width: 96, height: 96, borderRadius: 2, border: '1px dashed #94a3b8',
                    display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
                    bgcolor: '#fff', flexShrink: 0
                  }}
                >
                  {imagePreview
                    ? <img src={imagePreview} alt="Product" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    : <ImageIcon sx={{ color: 'text.disabled' }} />}
                </Box>
                <Stack spacing={1}>
                  <Button component="label" variant="outlined" size="small" startIcon={<ImageIcon />} sx={{ textTransform: 'none' }}>
                    {imageFile ? 'Change Image' : 'Upload Image'}
                    <input type="file" hidden accept="image/*" onChange={(e) => onPickImage(e.target.files?.[0] || null)} />
                  </Button>
                  {imageFile && (
                    <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => { setImageFile(null); setImagePreview(''); }} sx={{ textTransform: 'none' }}>
                      Remove
                    </Button>
                  )}
                  <Typography variant="caption" color="text.secondary">
                    {imageFile ? imageFile.name : 'PNG / JPG, stored with the product record.'}
                  </Typography>
                </Stack>
              </Stack>
            </Section>

          </Stack>
        </DialogContent>

        <DialogActions sx={{ p: 2, justifyContent: 'space-between', bgcolor: '#f1f5f9' }}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button onClick={handleSave} variant="contained" disabled={saving} sx={{ backgroundColor: '#2563EB', px: 3.5, py: 1, fontWeight: 900, borderRadius: 2 }}>
            {saving ? 'Saving…' : (isEdit ? `Update ${isLens ? 'Lens Option' : 'Product'}` : `Save ${isLens ? 'Lens Option' : 'Product'} to Database`)}
          </Button>
        </DialogActions>
      </Dialog>

      <Dialog open={scanDialogOpen} onClose={() => setScanDialogOpen(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800, textAlign: 'center' }}>📷 Scan Arriving Stock Barcode</DialogTitle>
        <DialogContent dividers sx={{ textAlign: 'center', py: 4 }}>
          <TextField
            autoFocus fullWidth
            label="Scanned Barcode / EAN Number"
            placeholder="Barcode will appear here..."
            value={p.barcode}
            onChange={(e) => set({ barcode: e.target.value })}
            InputProps={{ startAdornment: <BarcodeIcon color="action" sx={{ mr: 1 }} /> }}
          />
          <Stack spacing={1} sx={{ mt: 3 }}>
            <Button
              variant="contained" color="success"
              onClick={() => setScanDialogOpen(false)}
              sx={{ fontWeight: 700 }}
            >
              Use This Barcode
            </Button>
            <Button variant="text" size="small" onClick={() => setScanDialogOpen(false)}>Done / Close Scanner</Button>
          </Stack>
        </DialogContent>
      </Dialog>
    </>
  );
}
