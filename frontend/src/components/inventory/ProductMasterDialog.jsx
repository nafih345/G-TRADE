import React, { useState, useEffect, useMemo, useRef } from 'react';
import axios from 'axios';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Grid, TextField,
  MenuItem, Button, Stack, Typography, Paper, Autocomplete, Alert, Chip,
  IconButton, Tooltip, Box, Divider, createFilterOptions
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
import { describeApiError } from '../../utils/apiWriteGuard';
import { getBusinessPrefs } from '../../utils/localeFormat';
import { navDialogProps, enterOpensSelectProps, focusField, focusRelative, focusNextAfterRender } from '../../pages/wholesale/keyboardNav';

export { opticalCategories, opticalBrands } from './productAttributeOptions';
import { loadBackendMaster, backendMaster, localMaster } from './optionMasters';
import {
  opticalCategories, opticalBrands, LS_KEYS,
  MODE_LISTS, readModeLists, DEFAULT_CATEGORY_FOR_MODE, inferCategoryMode, inferBrandMode, inMode
} from './productAttributeOptions';
import { isSpectacleLensCategory } from '../../utils/lensUnits';

const blankProduct = (overrides = {}) => ({
  name: '', code: '', modelNo: '', hsnCode: '',
  category: 'Frames', subCategory: '', group: '', brand: '',
  size: '', color: '', material: '', frameShape: '',
  frameType: '', lensType: '', coating: '', powerRange: '',
  supplier: '', warehouse: 'Main', rack: '', stock: '',
  purchasePrice: '', mrp: '', salePrice: '', wholesaleRate: '', gst: '0%',
  barcode: '',
  secondaryBarcode: '',
  // Spectacle lenses: what the sale price is per, what stock is counted in, and the single-lens
  // price (explicit, or a % of the pair price — blank % = the Business Settings default).
  lensPriceUnit: 'PAIR', lensStockUnit: 'PAIR', lensPiecePrice: '', lensPiecePercent: '', lensPairPrice: '',
  ...overrides
});

// Opens a field's "+" master from the keyboard: Ctrl + "+" (Ctrl+= / Ctrl+Shift+=) or Alt+N.
const isAddShortcut = (e) =>
  (e.ctrlKey && !e.altKey && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd'))
  || (e.altKey && !e.ctrlKey && (e.key === 'n' || e.key === 'N'));

// The "+" master renders in a portal, but React still bubbles its key events through the
// parent dialog's keyboardNav handlers (and App.jsx's global Enter handler sees it as a
// plain dialog) — mark its Paper so both leave its keys to its own fields.
const OWN_KEYS_PAPER = { 'data-nav-own': '', 'data-own-enter': 'true' };
const defaultFilter = createFilterOptions();

// A freeSolo select with a "+" that opens a small master for the option list:
// add a new entry, rename one or delete one (to the backend master where one
// exists, otherwise to a local list).
//
// Keyboard (inside a keyboardNav scope such as ProductMasterDialog): typing highlights the
// first match and Enter picks it and moves to the next field in one press; Enter on a closed
// list just moves on. Ctrl + "+" or Alt+N opens the "+" master; Enter in its "New …" box
// adds the entry, selects it, closes and moves on.
export function AttributeField({ label, value, onChange, options, onPersist, onRename, onRemove, disabled }) {
  const [addOpen, setAddOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('');
  const [editing, setEditing] = useState(null); // { from, to }
  const fieldRef = useRef(null);
  const draftRef = useRef(null);
  const advanceOnCloseRef = useRef(false);

  const canManage = Boolean(onRename || onRemove);

  const openAdd = () => { setDraft(''); advanceOnCloseRef.current = false; setAddOpen(true); };

  const onFieldKeyDown = (e) => {
    if (isAddShortcut(e)) {
      e.preventDefault(); // Ctrl + "+" would otherwise zoom the page
      e.stopPropagation();
      if (!disabled) openAdd();
      return;
    }
    // List open: MUI selects the highlighted option (or commits the typed text) on this
    // Enter — move on once that has rendered. A closed list is left to the keyboardNav chain.
    if (e.key === 'Enter' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey
        && e.target.getAttribute('aria-expanded') === 'true') {
      focusNextAfterRender(e.target);
    }
  };

  // `value` follows every keystroke, so MUI treats the list as "pristine" on the keystroke that
  // opens it and shows every option unfiltered — "F" + Enter would pick the first entry. Filter
  // by the typed text ourselves once the user has typed; opening with ↓ still lists everything.
  const typedRef = useRef(false);

  const fieldInput = (
    <Autocomplete
      freeSolo
      autoHighlight
      fullWidth
      size="small"
      disabled={disabled}
      options={options}
      value={value || ''}
      filterOptions={(opts, state) => defaultFilter(opts, typedRef.current ? { ...state, inputValue: value || '' } : state)}
      onInputChange={(e, v, reason) => { if (reason === 'input') typedRef.current = true; onChange(v || ''); }}
      onClose={() => { typedRef.current = false; }}
      onChange={(e, v) => onChange(v || '')}
      onKeyDown={onFieldKeyDown}
      renderInput={(params) => <TextField {...params} label={label} inputRef={fieldRef} />}
    />
  );

  // Focus the "New …" box once the dialog has finished opening (autoFocus loses to the
  // FocusTrap when the dialog is opened by a keystroke). On close, return to the field —
  // or, after a keyboard add, step past it.
  const addDialogTransition = {
    onEntered: () => focusField(draftRef.current),
    onExited: () => {
      const el = fieldRef.current;
      const advance = advanceOnCloseRef.current;
      advanceOnCloseRef.current = false;
      if (!el) return;
      setTimeout(() => { if (!advance || !focusRelative(el, 1)) focusField(el); }, 0);
    }
  };

  const commit = async ({ close = false } = {}) => {
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
    if (close || !canManage) {
      advanceOnCloseRef.current = close;
      setAddOpen(false);
      setFilter('');
      setEditing(null);
    }
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
          {fieldInput}
          <Tooltip title={`Add / Edit / Delete ${label} (Ctrl + "+" or Alt+N)`}>
            <span>
              <IconButton size="small" color="primary" sx={{ mt: 0.3 }} disabled={disabled} tabIndex={-1} onClick={openAdd}>
                <AddIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        <Dialog open={addOpen} onClose={close} maxWidth="xs" fullWidth TransitionProps={addDialogTransition} PaperProps={OWN_KEYS_PAPER}>
          <DialogTitle sx={{ fontWeight: 800 }}>{label} Master</DialogTitle>
          <DialogContent>
            <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="flex-start">
              <TextField
                autoFocus fullWidth size="small" label={`New ${label}`} value={draft}
                inputRef={draftRef}
                helperText="Enter = add, select & continue"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit({ close: true }); } }}
              />
              <Button variant="contained" onClick={() => commit()} disabled={busy || !draft.trim()} startIcon={<AddIcon />}>Add</Button>
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
        {fieldInput}
        <Tooltip title={`Add new ${label} (Ctrl + "+" or Alt+N)`}>
          <span>
            <IconButton size="small" color="primary" sx={{ mt: 0.3 }} disabled={disabled} tabIndex={-1} onClick={openAdd}>
              <AddIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>

      <Dialog open={addOpen} onClose={() => setAddOpen(false)} maxWidth="xs" fullWidth TransitionProps={addDialogTransition} PaperProps={OWN_KEYS_PAPER}>
        <DialogTitle sx={{ fontWeight: 800 }}>Add {label}</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth size="small" label={`New ${label}`} value={draft}
            inputRef={draftRef}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); commit({ close: true }); } }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setAddOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={() => commit({ close: true })} disabled={busy}>{busy ? 'Adding…' : 'Add'}</Button>
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
// Frame / General vs Lens mode of a saved product: the mode it was saved in, else its category.
const productMode = (ep) => {
  const saved = (ep?.extra_data || {}).product_mode;
  if (saved === 'LENS' || saved === 'FRAME') return saved;
  return isSpectacleLensCategory(ep?.category || ep?.category_name) ? 'LENS' : 'FRAME';
};

// Switching mode clears every classification / attribute value, so nothing picked from the
// other mode's lists rides along (name, code, prices, barcode and stock are kept).
const CLASSIFICATION_RESET = {
  subCategory: '', group: '', brand: '', modelNo: '',
  size: '', color: '', material: '', frameShape: '',
  frameType: '', lensType: '', coating: '', powerRange: '',
  lensPriceUnit: 'PAIR', lensStockUnit: 'PAIR', lensPiecePrice: '', lensPiecePercent: '', lensPairPrice: ''
};

const productToForm = (ep) => {
  const isLensCat = productMode(ep) === 'LENS';
  const ex = ep.extra_data || {};
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
  frameShape: isLensCat ? '' : (ep.frameShape || ex.frame_shape || ''),
  powerRange: isLensCat ? (ep.powerRange || ex.power_range || '') : '',
  frameType: isLensCat ? (ep.frameType || ep.refractive_index || '') : '',
  lensType: isLensCat ? (ep.lensType || ep.lens_design || '') : '',
  coating: isLensCat ? (ep.coating || '') : '',
  supplier: ep.supplier || '',
  warehouse: ep.warehouse || 'Main',
  rack: ep.rack || '',
  stock: (ep.stock ?? '') === '' ? '' : String(ep.stock),
  purchasePrice: (ep.purchasePrice ?? '') === '' ? '' : String(ep.purchasePrice),
  // Callers that pass a mapped row without `mrp` (Products list) used to open with a blank
  // MRP — and saving then wrote MRP 0. Fall back to where the API keeps it.
  mrp: (() => { const v = ep.mrp ?? ex.mrp ?? ep.wholesale_price; return (v ?? '') === '' || !(parseFloat(v) > 0) ? '' : String(v); })(),
  wholesaleRate: (() => { const v = ep.wholesaleRate ?? ep.wholesale_sale_price; return (v ?? '') === '' || v === null ? '' : String(v); })(),
  salePrice: (ep.salePrice ?? ep.sellingPrice ?? '') === '' ? '' : String(ep.salePrice ?? ep.sellingPrice),
  gst: ep.gst || '0%',
  barcode: ep.barcode || '',
  secondaryBarcode: ep.secondaryBarcode || ep.secondary_barcode || '',
  lensPriceUnit: (ep.extra_data || {}).lens_price_unit === 'PIECE' ? 'PIECE' : 'PAIR',
  lensStockUnit: (ep.extra_data || {}).lens_stock_unit === 'PIECE' ? 'PIECE' : 'PAIR',
  lensPiecePrice: (ep.extra_data || {}).lens_piece_price ?? '',
  lensPiecePercent: (ep.extra_data || {}).lens_piece_percent ?? '',
  lensPairPrice: (ep.extra_data || {}).lens_pair_price ?? ''
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

  // Frame / General vs Lens. Every classification list below shows only this mode's entries.
  const [mode, setMode] = useState('FRAME');
  const isLens = mode === 'LENS';

  // Every Category / Brand name (all modes) + name → backend id / product_mode tag.
  const [categoryOptions, setCategoryOptions] = useState(opticalCategories);
  const [brandOptions, setBrandOptions] = useState(opticalBrands);
  const [categoryRecords, setCategoryRecords] = useState({});
  const [brandRecords, setBrandRecords] = useState({});
  const [categoryModes, setCategoryModes] = useState({});
  const [brandModes, setBrandModes] = useState({});
  // { FRAME: { field: options[] }, LENS: { … } } — the local (no backend master) lists.
  const [lists, setLists] = useState(() => ({ FRAME: readModeLists('FRAME'), LENS: readModeLists('LENS') }));

  const set =(patch) => setP(prev => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open) return;
    setP(isEdit
      ? productToForm(editProduct)
      : blankProduct({ supplier: defaultSupplier || '', category: defaultCategory || 'Frames' }));
    setMode(isEdit ? productMode(editProduct) : inferCategoryMode(defaultCategory || 'Frames'));
    setLists({ FRAME: readModeLists('FRAME'), LENS: readModeLists('LENS') });
    setImageFile(null);
    setImagePreview(isEdit ? (editProduct.image || '') : '');

    loadBackendMaster('/api/masters/categories/', opticalCategories, LS_KEYS.hiddenCategories, setCategoryOptions, setCategoryRecords, setCategoryModes);
    loadBackendMaster('/api/masters/brands/', opticalBrands, LS_KEYS.hiddenBrands, setBrandOptions, setBrandRecords, setBrandModes);
  }, [open, defaultSupplier, defaultCategory, isEdit, editProduct]);

  const categoryModeOf = (name) => categoryModes[name] || inferCategoryMode(name);
  const brandModeOf = (name) => brandModes[name] || inferBrandMode(name);
  const categoriesFor = (m) => categoryOptions.filter(n => inMode(categoryModeOf(n), m));
  const shownCategories = useMemo(() => categoriesFor(mode), [categoryOptions, categoryModes, mode]);
  const shownBrands = useMemo(() => brandOptions.filter(n => inMode(brandModeOf(n), mode)), [brandOptions, brandModes, mode]);

  // A Category / Brand master that tags what it creates with the current mode. Adding a name
  // the other mode already has shares that entry (BOTH) rather than making a duplicate row.
  const modeMaster = (url, hiddenKey, allNames, records, setRecords, setOptions, modeOf, setModes) => {
    const sameName = (name) => allNames.find(o => o.toLowerCase() === name.toLowerCase());
    const base = backendMaster(url, hiddenKey, records, setRecords, setOptions,
      (name, from) => ({ product_mode: from ? modeOf(from) : (sameName(name) ? 'BOTH' : mode) }));
    return {
      ...base,
      persist: async (name) => {
        const existing = sameName(name);
        setModes(m => ({ ...m, [existing || name]: existing ? 'BOTH' : mode }));
        if (existing && records[existing]) {
          try { await axios.patch(`${url}${records[existing]}/`, { product_mode: 'BOTH' }); } catch {}
          return;
        }
        await base.persist(existing || name);
      },
      rename: async (from, to) => {
        await base.rename(from, to);
        setModes(m => { const next = { ...m, [to]: modeOf(from) }; delete next[from]; return next; });
      }
    };
  };
  const categoryMaster = modeMaster('/api/masters/categories/', LS_KEYS.hiddenCategories, categoryOptions, categoryRecords, setCategoryRecords, setCategoryOptions, categoryModeOf, setCategoryModes);
  const brandMaster = modeMaster('/api/masters/brands/', LS_KEYS.hiddenBrands, brandOptions, brandRecords, setBrandRecords, setBrandOptions, brandModeOf, setBrandModes);

  // A field backed by this mode's local list (see MODE_LISTS). The refractive index and lens
  // design lists fill the older frameType / lensType form keys.
  const FORM_KEY = { refractive: 'frameType', lensDesign: 'lensType' };
  const listField = (field, label) => {
    const key = FORM_KEY[field] || field;
    const master = localMaster(MODE_LISTS[mode][field].key, (fn) =>
      setLists(prev => ({ ...prev, [mode]: { ...prev[mode], [field]: fn(prev[mode][field]) } })));
    return (
      <AttributeField label={label} value={p[key]} onChange={(v) => set({ [key]: v })} options={lists[mode][field]}
        onPersist={master.persist} onRename={master.rename} onRemove={master.remove} />
    );
  };

  const switchMode = (next) => {
    if (next === mode) return;
    const cats = categoriesFor(next);
    const def = DEFAULT_CATEGORY_FOR_MODE[next];
    setMode(next);
    setP(prev => ({ ...prev, ...CLASSIFICATION_RESET, category: cats.includes(def) ? def : (cats[0] || def) }));
  };

  const onPickImage = (file) => {
    if (!file) return;
    setImageFile(file);
    const reader = new FileReader();
    reader.onload = () => setImagePreview(String(reader.result || ''));
    reader.readAsDataURL(file);
  };

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
    // A typed (free-text) Category / Brand that belongs to the other mode.
    const otherMode = (value, names, modeOf) => {
      const hit = names.find(n => n.toLowerCase() === String(value || '').trim().toLowerCase());
      return hit && !inMode(modeOf(hit), mode) ? hit : null;
    };
    const badCategory = otherMode(p.category, categoryOptions, categoryModeOf);
    const badBrand = otherMode(p.brand, brandOptions, brandModeOf);
    if (badCategory || badBrand) {
      notify(`${badCategory ? `Category "${badCategory}"` : `Brand "${badBrand}"`} is not a ${isLens ? 'Lens' : 'Frame / General'} entry — pick one from the list.`);
      return;
    }
    setSaving(true);

    const code = p.code.trim() || `PRD-${Math.floor(1000 + Math.random() * 9000)}`;
    const purchasePrice = parseFloat(p.purchasePrice) || 0;
    const mrp = parseFloat(p.mrp) || 0;
    const salePrice = parseFloat(p.salePrice) || mrp || 0;
    const stock = parseInt(p.stock) || 0;

    const lensNum = (v) => (parseFloat(v) > 0 ? parseFloat(v) : null);
    const prevExtra = isEdit ? (editProduct.extra_data || {}) : {};
    const extra_data = {
      // Keys this form doesn't edit (importer columns etc.) survive an edit.
      ...prevExtra,
      product_mode: mode,
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
      coating: p.coating || '',
      frame_shape: p.frameShape || '',
      power_range: p.powerRange || '',
      ...(isLens ? {
        // Pair / single-lens rules key off the category name; a lens-mode category the name
        // check doesn't recognise opts in explicitly (utils/lensUnits.js isPairSellable).
        ...(prevExtra.lens_unit_selection === undefined && !isSpectacleLensCategory(p.category)
          ? { lens_unit_selection: true } : {}),
        lens_price_unit: p.lensPriceUnit,
        lens_stock_unit: p.lensStockUnit,
        lens_piece_price: p.lensPriceUnit === 'PAIR' ? lensNum(p.lensPiecePrice) : null,
        lens_piece_percent: p.lensPriceUnit === 'PAIR' ? lensNum(p.lensPiecePercent) : null,
        lens_pair_price: p.lensPriceUnit === 'PIECE' ? lensNum(p.lensPairPrice) : null,
      } : {})
    };

    const payload = {
      name: p.name.trim(),
      sku: code,
      barcode: p.barcode || null,
      secondary_barcode: (p.secondaryBarcode || '').trim() || null,
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
    // Wholesale tier: sent only when this form knows it, so a caller that opened the dialog
    // with a row lacking the field can't wipe a price set elsewhere. Blank = not set.
    const wsKnown = !isEdit || editProduct.wholesaleRate !== undefined || editProduct.wholesale_sale_price !== undefined;
    if (wsKnown || String(p.wholesaleRate).trim() !== '') {
      const ws = parseFloat(p.wholesaleRate);
      payload.wholesale_sale_price = ws > 0 ? ws : null;
    }
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
      // Never report success for a product the server didn't save. The old fallback kept a
      // browser-only copy under a Date.now() id: it looked saved, never reached other devices
      // or the other screens, and any sale / purchase of it then failed on the unknown id.
      setSaving(false);
      notify(`${isEdit ? 'Product was not updated' : 'Product was not saved'}: ${describeApiError(err)}`, 'error');
      return;
    }

    const productRecord = {
      id: savedId,
      code,
      modelNo: p.modelNo || '',
      barcode: savedBarcode,
      secondaryBarcode: (p.secondaryBarcode || '').trim(),
      name: p.name.trim(),
      brand: p.brand || '',
      supplier: p.supplier || '',
      category: p.category || 'Frames',
      subCategory: p.subCategory || '',
      group: p.group || '',
      size: p.size || '',
      color: p.color || '',
      material: p.material || '',
      frameShape: p.frameShape || '',
      powerRange: p.powerRange || '',
      frameType: p.frameType || '',
      lensType: p.lensType || '',
      coating: p.coating || '',
      purchasePrice,
      mrp,
      salePrice,
      sellingPrice: salePrice,
      gst: p.gst || '0%',
      stock,
      rack: p.rack || '',
      warehouse: p.warehouse || 'Main',
      hsnCode: p.hsnCode || '',
      image: imagePreview || '',
      status: isEdit ? (editProduct.status || 'Active') : 'Active',
      extra_data
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
      {/* Whole form is one keyboardNav chain: Enter / ↓ / ↑ = next / previous field
          (Classification → Variant → Pricing → GST → Barcode → Stock & Location → Save). */}
      <Dialog
        open={open} onClose={onClose} maxWidth="md" fullWidth
        {...navDialogProps}
        PaperProps={{ ...navDialogProps.PaperProps, sx: { borderRadius: 3.5 } }}
      >
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
                onClick={() => switchMode('FRAME')}
                sx={{ py: 0.2, px: 1, fontSize: '0.72rem', fontWeight: 800 }}
              >
                Frame / General
              </Button>
              <Button
                size="small"
                variant={isLens ? 'contained' : 'text'}
                onClick={() => switchMode('LENS')}
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
                <Grid item xs={12} sm={isLens ? 6 : 3}>
                  <TextField
                    label="Product Code / SKU" fullWidth size="small"
                    placeholder="Auto if blank"
                    value={p.code}
                    onChange={(e) => set({ code: e.target.value })}
                  />
                </Grid>
                {!isLens && (
                  <Grid item xs={12} sm={3}>
                    <TextField
                      label="Model Number" fullWidth size="small"
                      placeholder="e.g. RB3025-001"
                      value={p.modelNo}
                      onChange={(e) => set({ modelNo: e.target.value })}
                    />
                  </Grid>
                )}
                <Grid item xs={12} sm={6}>
                  <TextField
                    label="HSN / SAC Code" fullWidth size="small"
                    value={p.hsnCode}
                    onChange={(e) => set({ hsnCode: e.target.value })}
                  />
                </Grid>
              </Grid>
            </Section>

            {/* ── Classification (this mode's lists only; remounted on a mode switch) ── */}
            <Section title={isLens ? 'Lens Classification' : 'Frame / General Classification'} icon={<CategoryIcon fontSize="small" />}>
              <Grid container spacing={2} key={mode}>
                <Grid item xs={12} sm={6} md={3}>
                  <AttributeField label={isLens ? 'Lens Category' : 'Category'} value={p.category} onChange={(v) => set({ category: v })} options={shownCategories} onPersist={categoryMaster.persist} onRename={categoryMaster.rename} onRemove={categoryMaster.remove} />
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  {listField('subCategory', isLens ? 'Lens Type' : 'Sub-Category')}
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  {listField('group', isLens ? 'Lens Group' : 'Group')}
                </Grid>
                <Grid item xs={12} sm={6} md={3}>
                  <AttributeField label={isLens ? 'Lens Brand' : 'Brand / Manufacturer'} value={p.brand} onChange={(v) => set({ brand: v })} options={shownBrands} onPersist={brandMaster.persist} onRename={brandMaster.rename} onRemove={brandMaster.remove} />
                </Grid>
              </Grid>
            </Section>

            {/* ── Frame attributes / Lens design & parameters ── */}
            <Section title={isLens ? 'Lens Design & Parameters' : 'Frame Attributes'} icon={<SizeIcon fontSize="small" />}>
              {isLens ? (
                <Grid container spacing={2} key="LENS">
                  <Grid item xs={12} sm={6} md={4}>{listField('lensDesign', 'Lens Design Type')}</Grid>
                  <Grid item xs={12} sm={6} md={4}>{listField('refractive', 'Refractive Index')}</Grid>
                  <Grid item xs={12} sm={6} md={4}>{listField('coating', 'Coating Technology')}</Grid>
                  <Grid item xs={12} sm={6}>{listField('material', 'Lens Material')}</Grid>
                  <Grid item xs={12} sm={6}>{listField('powerRange', 'Power Range')}</Grid>
                </Grid>
              ) : (
                <Grid container spacing={2} key="FRAME">
                  <Grid item xs={12} sm={6} md={3}>{listField('frameShape', 'Frame Shape')}</Grid>
                  <Grid item xs={12} sm={6} md={3}>{listField('material', 'Material')}</Grid>
                  <Grid item xs={12} sm={6} md={3}>{listField('color', 'Color')}</Grid>
                  <Grid item xs={12} sm={6} md={3}>{listField('size', 'Size')}</Grid>
                </Grid>
              )}
            </Section>

            {/* ── Pricing (MRP & Sale price as their own part) ── */}
            <Section title="Pricing — Cost, MRP, Sale & Wholesale Price" icon={<PriceIcon fontSize="small" />}>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={2.4}>
                  <TextField
                    label="Purchase Cost Price (₹)" fullWidth size="small" type="number"
                    value={p.purchasePrice} onChange={(e) => set({ purchasePrice: e.target.value })}
                    inputProps={{ style: { fontWeight: 800 } }}
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={2.4}>
                  <TextField
                    label="MRP Price (₹)" fullWidth size="small" type="number"
                    value={p.mrp}
                    onChange={(e) => set({ mrp: e.target.value, salePrice: p.salePrice || e.target.value })}
                    inputProps={{ style: { fontWeight: 800 } }}
                    helperText="Printed maximum retail price"
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={2.4}>
                  <TextField
                    label="Sale Price (₹)" fullWidth size="small" type="number"
                    value={p.salePrice} onChange={(e) => set({ salePrice: e.target.value })}
                    inputProps={{ style: { fontWeight: 900, color: '#059669' } }}
                    helperText="Actual selling / billing price"
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={2.4}>
                  <TextField
                    label="Wholesale Price (₹)" fullWidth size="small" type="number"
                    value={p.wholesaleRate} onChange={(e) => set({ wholesaleRate: e.target.value })}
                    inputProps={{ style: { fontWeight: 800, color: '#4f46e5' }, 'data-testid': 'pm-wholesale-price' }}
                    helperText="Wholesale POS rate (blank = MRP)"
                  />
                </Grid>
                <Grid item xs={12} sm={6} md={2.4}>
                  <TextField select label="GST Tax Rate" fullWidth size="small" value={p.gst} onChange={(e) => set({ gst: e.target.value })} SelectProps={{ ...enterOpensSelectProps }} helperText="Enter, then ↑/↓ + Enter">
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

            {isLens && (
              <Section title="Lens Selling Unit — Pair / Single Lens" icon={<PriceIcon fontSize="small" />}>
                <Grid container spacing={2}>
                  <Grid item xs={12} sm={6} md={3}>
                    <TextField select label="Sale Price Is Per" fullWidth size="small" value={p.lensPriceUnit}
                      onChange={(e) => set({ lensPriceUnit: e.target.value })} SelectProps={{ ...enterOpensSelectProps }}
                      helperText={p.lensPriceUnit === 'PAIR' ? 'Sale price = 1 pair (2 lenses)' : 'Sale price = 1 lens'}>
                      <MenuItem value="PAIR">Pair (2 Lenses)</MenuItem>
                      <MenuItem value="PIECE">Piece (1 Lens)</MenuItem>
                    </TextField>
                  </Grid>
                  <Grid item xs={12} sm={6} md={3}>
                    <TextField select label="Stock Counted In" fullWidth size="small" value={p.lensStockUnit}
                      onChange={(e) => set({ lensStockUnit: e.target.value })} SelectProps={{ ...enterOpensSelectProps }}
                      helperText={p.lensStockUnit === 'PAIR' ? 'Stock qty = pairs; a single lens sold uses a whole pair' : 'Stock qty = single lenses; a pair uses 2'}>
                      <MenuItem value="PAIR">Pairs</MenuItem>
                      <MenuItem value="PIECE">Pieces (single lenses)</MenuItem>
                    </TextField>
                  </Grid>
                  {p.lensPriceUnit === 'PAIR' ? (
                    <>
                      <Grid item xs={12} sm={6} md={3}>
                        <TextField label="Single Lens Price (₹)" fullWidth size="small" type="number" value={p.lensPiecePrice}
                          onChange={(e) => set({ lensPiecePrice: e.target.value })}
                          helperText="Optional — overrides the % rule" />
                      </Grid>
                      <Grid item xs={12} sm={6} md={3}>
                        <TextField label="Single Lens % of Pair" fullWidth size="small" type="number" value={p.lensPiecePercent}
                          onChange={(e) => set({ lensPiecePercent: e.target.value })}
                          disabled={parseFloat(p.lensPiecePrice) > 0}
                          helperText={parseFloat(p.lensPiecePrice) > 0 ? 'Not used — single lens price is set'
                            : `Blank = Business Settings default (${getBusinessPrefs().lens_single_piece_percent ?? 50}%)`} />
                      </Grid>
                    </>
                  ) : (
                    <Grid item xs={12} sm={6} md={3}>
                      <TextField label="Pair Price (₹)" fullWidth size="small" type="number" value={p.lensPairPrice}
                        onChange={(e) => set({ lensPairPrice: e.target.value })}
                        helperText="Optional — blank = 2 × sale price" />
                    </Grid>
                  )}
                </Grid>
              </Section>
            )}

            {/* ── Barcode (configurable series — see Barcode settings) ── */}
            <Section title="Barcode" icon={<BarcodeIcon fontSize="small" />}>
              <BarcodeSection
                mode={isEdit ? 'manage' : 'create'}
                productId={isEdit ? editProduct.id : undefined}
                value={p.barcode}
                onChange={(val) => set({ barcode: val })}
                onSaved={(val) => set({ barcode: val || '' })}
                secondaryValue={p.secondaryBarcode}
                onSecondaryChange={(val) => set({ secondaryBarcode: val })}
                onSecondarySaved={(val) => set({ secondaryBarcode: val || '' })}
                productName={p.name}
                productCode={p.code}
                productPrice={saleNum || mrpNum || 0}
                productColour={p.color}
                productSize={p.size}
                keyboardNav
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
          <Button onClick={handleSave} variant="contained" disabled={saving} data-nav-stop="" sx={{ backgroundColor: '#2563EB', px: 3.5, py: 1, fontWeight: 900, borderRadius: 2 }}>
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
