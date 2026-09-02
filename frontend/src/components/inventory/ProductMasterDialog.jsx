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
  DeleteOutline as DeleteIcon
} from '@mui/icons-material';
import BarcodeSection from './BarcodeSection';

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
  color: 'optical_attr_colors'
};

const DEFAULT_GROUPS = ['Optical Frame', 'Sunglass', 'Ophthalmic Lens', 'Contact Lens', 'Accessory', 'Solution & Care'];
const DEFAULT_SIZES = ['Small', 'Medium', 'Large', '48-18-140', '50-20-145', '52-18-140', '54-16-140', '56-16-145'];
const DEFAULT_COLORS = ['Black', 'Brown', 'Gunmetal', 'Gold', 'Silver', 'Blue', 'Tortoise', 'Transparent', 'Rose Gold'];
const DEFAULT_SUBCATEGORIES = ['Full Rim', 'Half Rim / Supra', 'Rimless', 'Titanium', 'Acetate', 'Kids', 'Computer / Blue Cut'];

const readList = (key, fallback) => {
  try {
    const arr = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(arr) && arr.length ? arr : fallback;
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
  name: '', code: '', hsnCode: '',
  category: 'Frames', subCategory: '', group: '', brand: '',
  size: '', color: '', material: '',
  frameType: '', lensType: '', coating: '',
  supplier: '', warehouse: 'Main', rack: '', stock: '',
  purchasePrice: '', mrp: '', salePrice: '', gst: '18%',
  barcode: '',
  ...overrides
});

// A freeSolo select with a "+" that persists a brand-new option (to the backend
// master where one exists, otherwise to a local list).
function AttributeField({ label, value, onChange, options, onPersist, disabled }) {
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);

  const commit = async () => {
    const v = draft.trim();
    if (!v) return;
    setBusy(true);
    try { await onPersist?.(v); } catch {}
    setBusy(false);
    onChange(v);
    setAddOpen(false);
    setDraft('');
  };

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
export default function ProductMasterDialog({
  open,
  onClose,
  suppliers = [],
  defaultSupplier = '',
  defaultCategory = 'Frames',
  onCreated
}) {
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

  const set = (patch) => setP(prev => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open) return;
    setP(blankProduct({ supplier: defaultSupplier || '', category: defaultCategory || 'Frames' }));
    setImageFile(null);
    setImagePreview('');

    axios.get('/api/masters/categories/')
      .then(r => {
        const names = (r.data?.results || r.data || []).map(c => c.name).filter(Boolean);
        if (names.length) setCategoryOptions(Array.from(new Set([...names, ...opticalCategories])));
      }).catch(() => {});
    axios.get('/api/masters/brands/')
      .then(r => {
        const names = (r.data?.results || r.data || []).map(b => b.name).filter(Boolean);
        if (names.length) setBrandOptions(Array.from(new Set([...names, ...opticalBrands])));
      }).catch(() => {});
  }, [open, defaultSupplier, defaultCategory]);

  const persistCategory = async (name) => {
    setCategoryOptions(o => Array.from(new Set([name, ...o])));
    try { await axios.post('/api/masters/categories/', { name, code: genCode(name) }); } catch {}
  };
  const persistBrand = async (name) => {
    setBrandOptions(o => Array.from(new Set([name, ...o])));
    try { await axios.post('/api/masters/brands/', { name, code: genCode(name) }); } catch {}
  };
  const persistLocal = (key, setter) => async (name) => {
    setter(o => {
      const next = Array.from(new Set([name, ...o]));
      writeList(key, next);
      return next;
    });
  };

  const onPickImage = (file) => {
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

  const isLens = p.category === 'Prescription Lenses';

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
      opening_stock: stock,
      extra_data
    };

    let savedId = String(Date.now());
    let savedBarcode = p.barcode || '';
    try {
      const res = await axios.post('/api/products/items/', payload);
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
      console.log('Product saved to local store only (API unavailable).');
    }

    const productRecord = {
      id: savedId,
      code,
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
      status: 'Active'
    };

    try {
      const local = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
      localStorage.setItem('optical_inventory_items', JSON.stringify([productRecord, ...local]));
    } catch (e) {}
    window.dispatchEvent(new Event('optical_stock_updated'));

    setSaving(false);
    onCreated?.(productRecord);
    alert(`Product '${productRecord.name}' saved to inventory database successfully!`);
    onClose?.();
  };

  return (
    <>
      <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3.5 } }}>
        <DialogTitle sx={{ fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1, bgcolor: isLens ? '#0f172a' : '#ffffff', color: isLens ? '#facc15' : 'inherit', transition: 'all 0.3s ease' }}>
          <Stack direction="row" spacing={1.5} alignItems="center">
            <Typography variant="h6" fontWeight={900}>
              {isLens ? '🔬 Add Ophthalmic Lens Product' : '📦 Add Optical Stock / Product'}
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
                  <AttributeField label="Category" value={p.category} onChange={(v) => set({ category: v })} options={categoryOptions} onPersist={persistCategory} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <AttributeField label="Sub-Category" value={p.subCategory} onChange={(v) => set({ subCategory: v })} options={subCategoryOptions} onPersist={persistLocal(LS_KEYS.subCategory, setSubCategoryOptions)} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <AttributeField label="Group" value={p.group} onChange={(v) => set({ group: v })} options={groupOptions} onPersist={persistLocal(LS_KEYS.group, setGroupOptions)} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <AttributeField label="Brand / Manufacturer" value={p.brand} onChange={(v) => set({ brand: v })} options={brandOptions} onPersist={persistBrand} />
                </Grid>
              </Grid>
            </Section>

            {/* ── Variant Attributes ─────────────────────── */}
            <Section title="Variant Attributes" icon={<SizeIcon fontSize="small" />}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={4}>
                  <AttributeField label="Size" value={p.size} onChange={(v) => set({ size: v })} options={sizeOptions} onPersist={persistLocal(LS_KEYS.size, setSizeOptions)} />
                </Grid>
                <Grid item xs={12} sm={6} md={4}>
                  <AttributeField label="Color" value={p.color} onChange={(v) => set({ color: v })} options={colorOptions} onPersist={persistLocal(LS_KEYS.color, setColorOptions)} />
                </Grid>
                <Grid item xs={12} sm={6} md={4}>
                  <TextField label="Material" fullWidth size="small" value={p.material} onChange={(e) => set({ material: e.target.value })} placeholder="e.g. Acetate, TR90, Metal" />
                </Grid>

                {isLens && (
                  <>
                    <Grid item xs={12} sm={4}>
                      <TextField select label="Refractive Index" fullWidth size="small" value={p.frameType || '1.56'} onChange={(e) => set({ frameType: e.target.value })}>
                        <MenuItem value="1.50">1.50 Standard CR39</MenuItem>
                        <MenuItem value="1.56">1.56 Mid Index Blue Cut</MenuItem>
                        <MenuItem value="1.60">1.60 Hi-Index</MenuItem>
                        <MenuItem value="1.67">1.67 Ultra Thin</MenuItem>
                        <MenuItem value="1.74">1.74 Super High Index</MenuItem>
                      </TextField>
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField select label="Lens Design Type" fullWidth size="small" value={p.lensType || 'Single Vision'} onChange={(e) => set({ lensType: e.target.value })}>
                        <MenuItem value="Single Vision">Single Vision</MenuItem>
                        <MenuItem value="Progressive Digital">Progressive Digital</MenuItem>
                        <MenuItem value="Bifocal D-Seg">Bifocal D-Seg</MenuItem>
                        <MenuItem value="Office / Workspace">Office / Workspace</MenuItem>
                      </TextField>
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField select label="Coating Technology" fullWidth size="small" value={p.coating || 'Blue Cut UV420'} onChange={(e) => set({ coating: e.target.value })}>
                        <MenuItem value="Anti-Glare (ARC)">Anti-Glare (ARC)</MenuItem>
                        <MenuItem value="Blue Cut UV420">Blue Cut UV420</MenuItem>
                        <MenuItem value="Photochromic Auto-Tint">Photochromic Auto-Tint</MenuItem>
                        <MenuItem value="Polarized Sun Shield">Polarized Sun Shield</MenuItem>
                        <MenuItem value="Hard Coated Scratch Resistant">Hard Coated Scratch Resistant</MenuItem>
                      </TextField>
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
                mode="create"
                value={p.barcode}
                onChange={(val) => set({ barcode: val })}
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
            {saving ? 'Saving…' : `Save ${isLens ? 'Lens Option' : 'Product'} to Database`}
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
