import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Chip, CircularProgress, Collapse, Dialog, DialogActions,
  DialogContent, DialogTitle, Divider, FormControlLabel, Grid, IconButton, InputAdornment, ListItemIcon,
  ListItemText, Menu, MenuItem, Paper, Stack, Switch, TextField, Tooltip, Typography
} from '@mui/material';
import {
  Close as CloseIcon,
  AutoAwesome as GenerateIcon,
  Search as SearchIcon,
  ClearAll as ClearAllIcon,
  PlaylistAdd as AddRowIcon,
  ContentCopy as DuplicateIcon,
  DeleteSweep as DeleteSelectedIcon,
  ViewColumn as ColumnsIcon,
  Keyboard as KeyboardIcon,
  UploadFile as ImportIcon,
  Download as ExportIcon,
  BookmarkAdd as TemplateSaveIcon,
  Bookmarks as TemplateIcon,
  QrCode as BarcodeIcon,
  Print as PrintIcon,
  ExpandMore as ExpandIcon,
  ExpandLess as CollapseIcon,
  FormatPaint as ApplyIcon,
  Save as SaveIcon,
  AddShoppingCart as AddToPurchaseIcon,
  Edit as EditIcon,
  DeleteOutline as DeleteIcon,
  Restore as RestoreIcon
} from '@mui/icons-material';
import VariantGrid from './VariantGrid';
import VariantGenerator from './VariantGenerator';
import VariantImportDialog from './VariantImportDialog';
import { VARIANT_SHORTCUTS, useVariantShortcuts } from './variantShortcuts';
import {
  attributeMeta, baseSkuFromName, buildVariantSku, cartesian, combinationCount, defaultAttributesForCategory,
  downloadBlob, makeRow, mergeGenerated, newRid, rowFromSaved, rowToPayload, serverErrorsToRows,
  titleCase, validateRows, variantLabel
} from './variantUtils';
import {
  opticalCategories, opticalBrands, LS_KEYS, readList, DEFAULT_SUBCATEGORIES, DEFAULT_GROUPS
} from '../productAttributeOptions';
import { loadBackendMaster, backendMaster, localMaster } from '../optionMasters';
import { AttributeField } from '../ProductMasterDialog';
import BarcodePrintDialog from '../BarcodePrintDialog';
import ConfirmActionDialog from '../../common/ConfirmActionDialog';
import { notify } from '../../../utils/notify';
import { useDebounce } from '../../../hooks/useDebounce';

// Add Multiple Items / Product Variant Master — ONE component used by both Inventory → Products
// (context="inventory": create / edit products and their variants in the Product Master) and
// Purchase → Purchase Entry (context="purchase": pick existing variants or create new ones and
// hand them to the purchase grid). Variants are ordinary Product rows linked to a
// ProductVariantGroup; all saving and validation goes through
// POST /api/products/variant-groups/bulk-save/, which re-checks everything server-side.

const API = '/api/products/variant-groups/';
const TEMPLATE_API = '/api/products/variant-templates/';
const CATEGORY_API = '/api/masters/categories/';
const BRAND_API = '/api/masters/brands/';
const UNIT_API = '/api/masters/units/';
const COLVIS_KEY = 'variantMaster_colVis';
const DRAFT_KEY = (ctx) => `variantMaster_draft_${ctx}`;
const DRY_RUN_MAX_ROWS = 2000;
const TAX_DEFAULTS = [0, 5, 12, 18, 28];

const OPTIONAL_COLUMNS = [
  ['long_name', 'Long Name'], ['category', 'Category'], ['sub_category', 'Subcategory'], ['group', 'Group'],
  ['brand', 'Brand'], ['model_number', 'Model No.'], ['hsn_code', 'HSN'], ['cost_price', 'Cost Price'],
  ['mrp', 'MRP'], ['tax_percent', 'Tax %'], ['barcode', 'Barcode'], ['stock', 'Stock'],
];
const DEFAULT_COLVIS = {
  long_name: false, category: true, sub_category: false, group: false, brand: true, model_number: true,
  hsn_code: false, cost_price: true, mrp: true, tax_percent: true, barcode: true, stock: true,
};

const blankParent = () => ({
  name: '', base_sku: '', description: '', long_description: '', category: '', sub_category: '', group: '',
  brand: '', model_number: '', unit: '', hsn_code: '', tax_percent: '', is_active: true,
});
const blankDefaults = () => ({
  quantity: '', cost_price: '', cost_includes_tax: false, mrp: '', mrp_includes_tax: true, sales_price: '', opening_stock: '',
});

const readJson = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
};
const writeJson = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage full / blocked */ } };
const dropKey = (key) => { try { localStorage.removeItem(key); } catch { /* ignore */ } };
const n2 = (v) => (v === '' || v == null ? null : Number(v));
const round2 = (v) => Math.round(v * 100) / 100;
const newToken = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

function Section({ title, action, children, sx }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, ...sx }}>
      <Stack direction="row" alignItems="center" sx={{ mb: 1, minHeight: 28 }}>
        <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ flex: 1 }}>{title}</Typography>
        {action}
      </Stack>
      {children}
    </Paper>
  );
}

export default function ProductVariantMaster({
  open, onClose, context = 'inventory', initialGroupId = null, initialProductId = null,
  supplierName = '', purchaseGstType = 'EXCLUSIVE', initialImportGroup = null, onSaved, onAddToPurchase
}) {
  const isPurchase = context === 'purchase';
  const nameRef = useRef(null);
  const findRef = useRef(null);
  const filterRef = useRef(null);
  const genRef = useRef(null);
  const gridRef = useRef(null);
  const tokenRef = useRef(null);

  const [parent, setParent] = useState(blankParent);
  const [defaults, setDefaults] = useState(blankDefaults);
  const [groupId, setGroupId] = useState(null);
  const [axes, setAxes] = useState([]);
  const [rows, setRows] = useState([]);
  const [removedIds, setRemovedIds] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState(null);
  const [colVis, setColVis] = useState(() => ({ ...DEFAULT_COLVIS, ...readJson(COLVIS_KEY, {}) }));
  const [serverErrors, setServerErrors] = useState({});
  const [groupErrors, setGroupErrors] = useState({});
  const [skuPreview, setSkuPreview] = useState({});
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const [autoBarcode, setAutoBarcode] = useState(true);
  const [genOpen, setGenOpen] = useState(true);
  const [genFocusToken, setGenFocusToken] = useState(0);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [activeRow, setActiveRow] = useState(-1);
  const [draft, setDraft] = useState(null);

  const [taxOptions, setTaxOptions] = useState(TAX_DEFAULTS);
  // Option lists behind the header's "+" masters (add / rename / delete).
  const [categoryOptions, setCategoryOptions] = useState(opticalCategories);
  const [categoryRecords, setCategoryRecords] = useState({});
  const [brandOptions, setBrandOptions] = useState(opticalBrands);
  const [brandRecords, setBrandRecords] = useState({});
  const [unitOptions, setUnitOptions] = useState([]);
  const [unitRecords, setUnitRecords] = useState({});
  const [subCategoryOptions, setSubCategoryOptions] = useState([]);
  const [groupOptions, setGroupOptions] = useState([]);
  const [modelNumberOptions, setModelNumberOptions] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [loadedTemplate, setLoadedTemplate] = useState(null);
  const [templateMenu, setTemplateMenu] = useState(null);
  const [templateNameDialog, setTemplateNameDialog] = useState(null); // { mode: 'create', name }
  const [colMenu, setColMenu] = useState(null);
  const [moreMenu, setMoreMenu] = useState(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [printTargets, setPrintTargets] = useState(null);
  const [confirm, setConfirm] = useState({ open: false });

  const [findInput, setFindInput] = useState('');
  const debouncedFind = useDebounce(findInput, 300);
  const [findOptions, setFindOptions] = useState([]);
  const [findLoading, setFindLoading] = useState(false);

  // Promise-based confirm so handlers can read top-to-bottom.
  const askConfirm = useCallback((opts) => new Promise(resolve => {
    let answered = false;
    setConfirm({
      open: true, type: 'warning', confirmText: 'Continue', ...opts,
      onConfirm: () => { answered = true; resolve(true); },
      onClose: () => { setConfirm(c => ({ ...c, open: false })); if (!answered) resolve(false); },
    });
  }), []);

  // ------------------------------------------------------------------ open / load

  const resetAll = useCallback(() => {
    setParent(blankParent()); setDefaults(blankDefaults()); setGroupId(null); setAxes([]); setRows([]);
    setRemovedIds([]); setSelected(new Set()); setFilter(''); setSort(null); setServerErrors({}); setGroupErrors({});
    setSkuPreview({}); setDirty(false); setLoadedTemplate(null); setActiveRow(-1); tokenRef.current = null;
  }, []);

  const applyGroup = useCallback((data) => {
    const variants = data.variants || [];
    const first = variants[0] || {};
    setParent({
      ...blankParent(),
      name: data.name || (data.standalone ? first.name : '') || '',
      base_sku: data.base_sku || (data.standalone ? first.sku : '') || '',
      description: data.description || '', long_description: data.long_description || '',
      category: data.category || first.category || '', sub_category: data.sub_category || first.sub_category || '',
      group: data.group || first.group || '', brand: data.brand || first.brand || '',
      model_number: data.model_number || first.model_number || '', unit: data.unit || '',
      hsn_code: data.hsn_code || first.hsn_code || '',
      tax_percent: data.tax_percent ?? first.tax_percent ?? '', is_active: data.is_active !== false,
    });
    setGroupId(data.id || null);
    const loaded = variants.map(rowFromSaved);
    setRows(loaded);
    const keys = [...(data.attribute_keys || [])];
    loaded.forEach(r => Object.keys(r.attributes).forEach(k => { if (!keys.includes(k)) keys.push(k); }));
    setAxes(keys.map(k => ({ key: k, values: Array.from(new Set(loaded.map(r => r.attributes[k]).filter(Boolean))) })));
    setRemovedIds([]); setSelected(new Set()); setServerErrors({}); setGroupErrors({}); setDirty(false);
    tokenRef.current = null;
  }, []);

  const loadGroup = useCallback(async (url) => {
    setLoading(true);
    try {
      const res = await axios.get(url);
      applyGroup(res.data);
    } catch (e) {
      notify(e.response?.data?.detail || 'Could not load the product.', 'error');
    } finally {
      setLoading(false);
    }
  }, [applyGroup]);

  useEffect(() => {
    if (!open) return;
    resetAll();
    setGenOpen(!initialGroupId && !initialProductId);
    setDraft(null);
    if (initialGroupId) loadGroup(`${API}${initialGroupId}/`);
    else if (initialProductId) loadGroup(`${API}for-product/?product=${encodeURIComponent(initialProductId)}`);
    else {
      const d = readJson(DRAFT_KEY(context), null);
      if (d && (d.rows?.length || d.parent?.name)) setDraft(d);
    }

    loadBackendMaster(CATEGORY_API, opticalCategories, LS_KEYS.hiddenCategories, setCategoryOptions, setCategoryRecords);
    loadBackendMaster(BRAND_API, opticalBrands, LS_KEYS.hiddenBrands, setBrandOptions, setBrandRecords);
    loadBackendMaster(UNIT_API, [], null, setUnitOptions, setUnitRecords);
    setSubCategoryOptions(readList(LS_KEYS.subCategory, DEFAULT_SUBCATEGORIES));
    setGroupOptions(readList(LS_KEYS.group, DEFAULT_GROUPS));
    setModelNumberOptions(readList(LS_KEYS.modelNumber, []));
    axios.get('/api/masters/taxes/').then(tx => {
      const rates = (tx?.data?.results || tx?.data || []).map(t => Number(t.rate)).filter(Number.isFinite);
      setTaxOptions(Array.from(new Set([...TAX_DEFAULTS, ...rates])).sort((a, b) => a - b));
    }).catch(() => {});
    axios.get(TEMPLATE_API).then(r => setTemplates(r.data?.results || r.data || [])).catch(() => setTemplates([]));
  }, [open, initialGroupId, initialProductId, context, resetAll, loadGroup]);

  // Existing-product finder (parents + stand-alone products).
  useEffect(() => {
    const q = debouncedFind.trim();
    if (!open || q.length < 2) { setFindOptions([]); return undefined; }
    let alive = true;
    setFindLoading(true);
    Promise.all([
      axios.get(API, { params: { search: q, limit: 15 } }).catch(() => ({ data: [] })),
      axios.get('/api/products/items/', { params: { search: q, page: 1, page_size: 15 } }).catch(() => ({ data: {} })),
    ]).then(([g, p]) => {
      if (!alive) return;
      const groups = (g.data || []).map(x => ({ type: 'group', id: x.id, label: x.name, sub: `${x.variant_count} variant${x.variant_count === 1 ? '' : 's'} · ${x.base_sku || 'no base SKU'} · stock ${x.total_stock}` }));
      const products = (p.data?.results || p.data || []).filter(x => !x.variant_group).map(x => ({ type: 'product', id: x.id, label: x.name, sub: `${x.sku || ''}${x.barcode ? ` · ${x.barcode}` : ''} · stock ${x.stock ?? 0}` }));
      setFindOptions([...groups, ...products]);
    }).finally(() => alive && setFindLoading(false));
    return () => { alive = false; };
  }, [debouncedFind, open]);

  const pickExisting = async (opt) => {
    if (!opt) return;
    if (dirty && !(await askConfirm({ title: 'Load another product?', message: 'Your unsaved rows will be replaced.', confirmText: 'Load' }))) return;
    setFindInput('');
    loadGroup(opt.type === 'group' ? `${API}${opt.id}/` : `${API}for-product/?product=${encodeURIComponent(opt.id)}`);
  };

  // ------------------------------------------------------------------ derived

  const attrKeys = useMemo(() => {
    const keys = axes.map(a => a.key).filter(Boolean);
    rows.forEach(r => Object.keys(r.attributes || {}).forEach(k => { if (!keys.includes(k)) keys.push(k); }));
    return keys;
  }, [axes, rows]);

  const grouped = Boolean(groupId || (parent.name.trim() && (rows.length > 1 || rows.some(r => Object.keys(r.attributes || {}).length))));
  const baseSku = parent.base_sku.trim() || (parent.name.trim() ? baseSkuFromName(parent.name) : '');

  const clientErrors = useMemo(
    () => validateRows(rows, { grouped, context, parentName: parent.name.trim() }),
    [rows, grouped, context, parent.name]
  );
  const errors = useMemo(() => {
    const out = { ...serverErrors };
    Object.entries(clientErrors).forEach(([rid, e]) => { out[rid] = { ...(out[rid] || {}), ...e }; });
    return out;
  }, [clientErrors, serverErrors]);
  const errorCount = Object.keys(errors).filter(rid => rows.some(r => r._rid === rid)).length;

  const viewRows = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = !q ? rows : rows.filter(r =>
      [r.name, r.sku, r.barcode, r.model_number, ...Object.values(r.attributes || {})].some(v => String(v || '').toLowerCase().includes(q)));
    if (sort) {
      const get = (r) => (sort.key.startsWith('attr:') ? r.attributes?.[sort.key.slice(5)] : r[sort.key]) ?? '';
      const numeric = ['quantity', 'opening_stock', 'cost_price', 'mrp', 'sales_price', 'tax_percent', 'stock'].includes(sort.key);
      list = [...list].sort((a, b) => {
        const x = get(a), y = get(b);
        const cmp = numeric ? (Number(x) || 0) - (Number(y) || 0) : String(x).localeCompare(String(y), undefined, { numeric: true });
        return sort.dir === 'asc' ? cmp : -cmp;
      });
    }
    return list;
  }, [rows, filter, sort]);

  const purchaseLocked = useCallback((r) => isPurchase && Boolean(r.id), [isPurchase]);

  const columns = useMemo(() => {
    const parentName = parent.name.trim();
    const cols = [
      { key: 'name', label: 'Product Name', width: 210, readOnly: purchaseLocked, placeholder: (r) => (parentName ? `${parentName} ${variantLabel(r.attributes, attrKeys)}`.trim() : '') },
      colVis.long_name && { key: 'long_name', label: 'Long Name', width: 170, readOnly: purchaseLocked },
      colVis.category && { key: 'category', label: 'Category', width: 120, readOnly: purchaseLocked, placeholder: () => parent.category },
      colVis.sub_category && { key: 'sub_category', label: 'Subcategory', width: 120, readOnly: purchaseLocked, placeholder: () => parent.sub_category },
      colVis.group && { key: 'group', label: 'Group', width: 120, readOnly: purchaseLocked, placeholder: () => parent.group },
      colVis.brand && { key: 'brand', label: 'Brand', width: 110, readOnly: purchaseLocked, placeholder: () => parent.brand },
      colVis.model_number && { key: 'model_number', label: 'Model No.', width: 110, readOnly: purchaseLocked, placeholder: () => parent.model_number },
      ...attrKeys.map(k => ({ key: `attr:${k}`, attr: k, label: attributeMeta(k).label || titleCase(k), width: 100, readOnly: purchaseLocked })),
      isPurchase
        ? { key: 'quantity', label: 'Purchase Qty', width: 90, numeric: true, align: 'right' }
        : { key: 'opening_stock', label: 'Opening Qty', width: 90, numeric: true, align: 'right', readOnly: (r) => Boolean(r.id) },
      colVis.cost_price && { key: 'cost_price', label: isPurchase ? 'Cost Price' : 'Cost Price', width: 90, numeric: true, align: 'right' },
      colVis.mrp && { key: 'mrp', label: 'MRP', width: 90, numeric: true, align: 'right' },
      { key: 'sales_price', label: 'Sales Price', width: 95, numeric: true, align: 'right' },
      colVis.tax_percent && { key: 'tax_percent', label: 'Tax %', width: 70, numeric: true, align: 'right', readOnly: purchaseLocked, placeholder: () => (parent.tax_percent === '' ? '' : String(parent.tax_percent)) },
      colVis.hsn_code && { key: 'hsn_code', label: 'HSN', width: 95, readOnly: purchaseLocked, placeholder: () => parent.hsn_code },
      { key: 'sku', label: 'SKU', width: 160, readOnly: purchaseLocked, placeholder: (r) => skuPreview[r._rid] || (baseSku ? buildVariantSku(baseSku, r.attributes, attrKeys) : 'auto') },
      colVis.barcode && { key: 'barcode', label: 'Barcode', width: 140, readOnly: purchaseLocked, placeholder: () => (autoBarcode ? 'auto (EAN-13)' : '') },
      colVis.stock && { key: 'stock', label: 'Stock', width: 70, align: 'right', display: (r) => (r.id ? (r.stock ?? 0) : '—') },
    ];
    return cols.filter(Boolean);
  }, [parent, attrKeys, colVis, isPurchase, purchaseLocked, skuPreview, baseSku, autoBarcode]);

  // ------------------------------------------------------------------ row editing

  const markDirty = () => setDirty(true);
  const clearServerErr = (rid) => setServerErrors(prev => (prev[rid] ? (({ [rid]: _drop, ...rest }) => rest)(prev) : prev));

  const onCellChange = useCallback((rid, field, value) => {
    setRows(prev => prev.map(r => {
      if (r._rid !== rid) return r;
      if (field.startsWith('attr:')) {
        return { ...r, attributes: { ...r.attributes, [field.slice(5)]: value }, _edited: true };
      }
      return { ...r, [field]: value, _edited: true };
    }));
    clearServerErr(rid);
    setDirty(true);
  }, []);

  const rowDefaults = useCallback(() => ({
    quantity: defaults.quantity, cost_price: defaults.cost_price, mrp: defaults.mrp,
    sales_price: defaults.sales_price || defaults.mrp,
  }), [defaults]);

  const addBlankRows = useCallback((n = 1) => {
    const extra = isPurchase ? {} : { opening_stock: defaults.opening_stock };
    const added = Array.from({ length: n }, () => makeRow(rowDefaults(), {}, { ...extra, _edited: true }));
    setRows(prev => [...prev, ...added]);
    setDirty(true);
    setFilter(''); setSort(null);
    setTimeout(() => gridRef.current?.focusRow(rows.length), 60);
  }, [rowDefaults, isPurchase, defaults.opening_stock, rows.length]);

  // Excel-style duplicate: each row is cloned with everything entered in it and inserted right
  // below its source. Only what must stay unique is cleared — the saved-product link, SKU and
  // barcode (re-generated on save) and the source's current stock.
  const focusRidRef = useRef(null);
  const duplicateRows = useCallback((rids) => {
    if (!rids.length) return;
    const copyRid = new Map(rids.map(rid => [rid, newRid()]));
    setRows(prev => prev.flatMap(src => (copyRid.has(src._rid)
      ? [src, { ...src, attributes: { ...(src.attributes || {}) }, _rid: copyRid.get(src._rid), id: null, sku: '', barcode: '', stock: null, _generated: false, _edited: true }]
      : [src])));
    focusRidRef.current = copyRid.get(rids[0]);
    setDirty(true);
  }, []);
  const duplicateRow = useCallback((rid) => duplicateRows([rid]), [duplicateRows]);

  const removeRows = useCallback(async (rids, { ask = true } = {}) => {
    const targets = rows.filter(r => rids.includes(r._rid));
    if (!targets.length) return;
    const saved = targets.filter(r => r.id);
    if (ask) {
      const ok = await askConfirm({
        title: `Remove ${targets.length} row${targets.length === 1 ? '' : 's'}?`,
        message: saved.length && !isPurchase
          ? `${saved.length} of them ${saved.length === 1 ? 'is' : 'are'} already saved. On Save ${saved.length === 1 ? 'it' : 'they'} will be marked inactive in the Product Master (stock and history are kept).`
          : 'The rows will be removed from this list.',
        type: saved.length && !isPurchase ? 'danger' : 'warning', confirmText: 'Remove',
      });
      if (!ok) return;
    }
    const set = new Set(rids);
    const firstView = viewRows.findIndex(r => set.has(r._rid));
    setRows(prev => prev.filter(r => !set.has(r._rid)));
    // Keep the keyboard in the grid: land on the row that took the removed one's place.
    setTimeout(() => {
      const left = viewRows.length - targets.length;
      if (left > 0) gridRef.current?.focusRow(Math.max(0, Math.min(firstView, left - 1)));
      else nameRef.current?.focus();
    }, 80);
    if (!isPurchase && saved.length) setRemovedIds(prev => [...prev, ...saved.map(r => r.id)]);
    setSelected(prev => { const next = new Set(prev); rids.forEach(id => next.delete(id)); return next; });
    setDirty(true);
  }, [rows, viewRows, askConfirm, isPurchase]);

  const onDeleteOne = useCallback((rid) => removeRows([rid]), [removeRows]);
  // Put the cursor on the first new copy once it has rendered.
  useEffect(() => {
    const rid = focusRidRef.current;
    if (!rid) return;
    focusRidRef.current = null;
    const i = viewRows.findIndex(r => r._rid === rid);
    if (i >= 0) setTimeout(() => gridRef.current?.focusRow(i), 30);
  }, [viewRows]);

  // Duplicate acts on the ticked rows when there are any, else on the row with the cursor.
  const duplicateTargets = selected.size
    ? viewRows.filter(r => selected.has(r._rid)).map(r => r._rid)
    : (viewRows[activeRow] ? [viewRows[activeRow]._rid] : []);

  const onToggle = useCallback((rid) => setSelected(prev => { const n = new Set(prev); n.has(rid) ? n.delete(rid) : n.add(rid); return n; }), []);
  const onToggleAll = useCallback((checked) => setSelected(checked ? new Set(viewRows.map(r => r._rid)) : new Set()), [viewRows]);
  const onSort = useCallback((key) => setSort(s => (!s || s.key !== key ? { key, dir: 'asc' } : s.dir === 'asc' ? { key, dir: 'desc' } : null)), []);

  const applyDefaultsToRows = async () => {
    const target = selected.size ? rows.filter(r => selected.has(r._rid)) : rows;
    if (!target.length) return;
    const fields = { cost_price: defaults.cost_price, mrp: defaults.mrp, sales_price: defaults.sales_price, ...(isPurchase ? { quantity: defaults.quantity } : { opening_stock: defaults.opening_stock }) };
    const set = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== '' && v != null));
    if (!Object.keys(set).length) { notify('Enter a quantity or price above first.', 'warning'); return; }
    if (!(await askConfirm({ title: 'Apply to rows?', message: `Set ${Object.keys(set).map(titleCase).join(', ')} on ${target.length} ${selected.size ? 'selected ' : ''}row${target.length === 1 ? '' : 's'}${!isPurchase ? ' (Opening Qty only on new rows)' : ''}?`, confirmText: 'Apply' }))) return;
    const ids = new Set(target.map(r => r._rid));
    setRows(prev => prev.map(r => {
      if (!ids.has(r._rid)) return r;
      const patch = { ...set };
      if (r.id && 'opening_stock' in patch) delete patch.opening_stock;
      return { ...r, ...patch, _edited: true };
    }));
    setDirty(true);
  };

  // ------------------------------------------------------------------ generation

  const generate = async () => {
    const combos = cartesian(axes);
    if (!combos.length) { notify('Pick at least one value for an attribute first.', 'warning'); return; }
    const extra = isPurchase ? {} : { opening_stock: defaults.opening_stock };
    const merged = mergeGenerated(rows, combos, { ...rowDefaults(), ...extra });
    if (merged.editedDropped > 0) {
      const ok = await askConfirm({
        title: 'Regenerate variants?',
        message: `${merged.editedDropped} edited row${merged.editedDropped === 1 ? '' : 's'} no longer match the selected values and will be removed. Rows that still match keep your edits.`,
        confirmText: 'Regenerate',
      });
      if (!ok) return;
    }
    // Generated rows inherit the defaults (prices, opening qty) from the panel above.
    const fresh = new Set(merged.rows.slice(merged.rows.length - merged.added).map(r => r._rid));
    setRows(merged.rows.map(r => (fresh.has(r._rid) && !isPurchase ? { ...r, ...extra } : r)));
    setDirty(true);
    setFilter(''); setSort(null);
    notify(`${merged.added} variant${merged.added === 1 ? '' : 's'} added${merged.dropped ? `, ${merged.dropped} removed` : ''}.`, 'success');
  };

  const clearGenerated = async () => {
    const gen = rows.filter(r => r._generated && !r.id);
    if (!gen.length) return;
    const edited = gen.filter(r => r._edited).length;
    if (!(await askConfirm({ title: 'Clear generated variants?', message: `Remove ${gen.length} generated row${gen.length === 1 ? '' : 's'}${edited ? ` (${edited} edited)` : ''}? Saved items stay.`, confirmText: 'Clear' }))) return;
    setRows(prev => prev.filter(r => !(r._generated && !r.id)));
    setDirty(true);
  };

  // Category picks the starting attributes when none are chosen yet.
  const setCategory = (category) => {
    setParent(p => ({ ...p, category }));
    setDirty(true);
    if (!axes.length && !rows.length && category) setAxes(defaultAttributesForCategory(category).map(key => ({ key, values: [] })));
  };

  const setParentField = (field) => (value) => { setParent(p => ({ ...p, [field]: value })); setGroupErrors(g => ({ ...g, [field]: undefined })); setDirty(true); };
  const setDefault = (field) => (value) => setDefaults(d => ({ ...d, [field]: value }));

  // ------------------------------------------------------------------ payload / save

  const taxOf = (r) => n2(r.tax_percent) ?? n2(parent.tax_percent) ?? 0;

  const payloadRow = (r) => {
    const p = rowToPayload(r);
    const t = taxOf(r);
    if (!isPurchase && defaults.cost_includes_tax && p.cost_price !== '' && p.cost_price != null) p.cost_price = round2(Number(p.cost_price) / (1 + t / 100));
    if (!defaults.mrp_includes_tax && p.mrp !== '' && p.mrp != null) p.mrp = round2(Number(p.mrp) * (1 + t / 100));
    if (isPurchase) p.opening_stock = '';
    return p;
  };

  const buildPayload = (list, extra = {}) => ({
    context,
    group_id: groupId || undefined,
    group: { ...parent, attribute_keys: attrKeys },
    variants: list.map(payloadRow),
    auto_sku: true,
    auto_barcode: autoBarcode,
    ...extra,
  });

  // Live server check (SKU / barcode clashes with the database, generated SKU preview).
  const checkKey = useDebounce(JSON.stringify([rows.map(r => [r._rid, r.sku, r.barcode, r.name, r.attributes, r.mrp, r.sales_price, r.tax_percent]), parent, groupId]), 800);
  useEffect(() => {
    if (!open) return undefined;
    const list = isPurchase ? rows.filter(r => !r.id) : rows;
    if (!list.length || list.length > DRY_RUN_MAX_ROWS) { setSkuPreview({}); return undefined; }
    const ctrl = new AbortController();
    setChecking(true);
    axios.post(`${API}bulk-save/`, buildPayload(list, { dry_run: true }), { signal: ctrl.signal })
      .then(res => {
        const prev = {};
        (res.data.variants || []).forEach(v => { if (list[v.index]) prev[list[v.index]._rid] = v.sku; });
        setSkuPreview(prev); setServerErrors({}); setGroupErrors({});
      })
      .catch(e => {
        if (axios.isCancel(e) || !e.response) return;
        setServerErrors(serverErrorsToRows(e.response.data?.row_errors, list));
        setGroupErrors(e.response.data?.group_errors || {});
      })
      .finally(() => setChecking(false));
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkKey, open]);

  const focusFirstError = (errs) => {
    const i = viewRows.findIndex(r => errs[r._rid]);
    if (i >= 0) gridRef.current?.focusRow(i);
  };

  const applySavedResult = (sentRows, result) => {
    const byIndex = new Map((result.variants || []).map(v => [v.index, v]));
    const updated = new Map();
    sentRows.forEach((r, i) => {
      const v = byIndex.get(i);
      if (v) updated.set(r._rid, { ...rowFromSaved(v), _rid: r._rid });
    });
    setRows(prev => prev.map(r => updated.get(r._rid) || r));
    if (result.group) {
      setGroupId(result.group.id);
      setParent(p => ({ ...p, base_sku: result.group.base_sku || p.base_sku }));
    }
    return Array.from(updated.values());
  };

  const postSave = async (list) => {
    tokenRef.current = tokenRef.current || newToken();
    try {
      const res = await axios.post(`${API}bulk-save/`, buildPayload(list, { remove_ids: isPurchase ? [] : removedIds, client_token: tokenRef.current }));
      tokenRef.current = null;
      return res.data;
    } catch (e) {
      if (e.response) tokenRef.current = null; // a real answer: next attempt is a new save
      const data = e.response?.data;
      if (data?.row_errors) {
        const mapped = serverErrorsToRows(data.row_errors, list);
        setServerErrors(mapped);
        focusFirstError(mapped);
      }
      if (data?.group_errors) setGroupErrors(data.group_errors);
      notify(data?.detail || (e.response ? 'Could not save the items.' : 'Network problem — nothing was lost. Press Save again to retry.'), 'error');
      return null;
    }
  };

  const validateBeforeSave = (list) => {
    if (!list.length) { notify('Add at least one row.', 'warning'); return false; }
    const bad = Object.keys(clientErrors).filter(rid => list.some(r => r._rid === rid));
    if (bad.length) {
      notify(`${bad.length} row${bad.length === 1 ? '' : 's'} need attention (highlighted in red).`, 'warning');
      focusFirstError(clientErrors);
      return false;
    }
    if (grouped && !parent.name.trim() && !groupId) {
      setGroupErrors({ name: 'Product name is required.' });
      nameRef.current?.focus();
      notify('Enter the Product Name.', 'warning');
      return false;
    }
    return true;
  };

  const save = async () => {
    if (saving) return;
    const list = isPurchase ? rows.filter(r => !r.id) : rows;
    if (isPurchase && !list.length) { notify('No new items to save — existing items are already in the Product Master.', 'info'); return; }
    if (!validateBeforeSave(list)) return;
    setSaving(true);
    const result = await postSave(list);
    setSaving(false);
    if (!result) return;
    applySavedResult(list, result);
    setRemovedIds([]);
    setDirty(false);
    dropKey(DRAFT_KEY(context));
    window.dispatchEvent(new Event('optical_stock_updated'));
    const parts = [result.created && `${result.created} created`, result.updated && `${result.updated} updated`, result.deactivated && `${result.deactivated} deactivated`].filter(Boolean);
    notify(`Saved to Product Master: ${parts.join(', ') || 'no changes'}.`, 'success');
    onSaved?.(result);
  };

  const addToPurchase = async () => {
    if (saving) return;
    const qty = (r) => Number(r.quantity) || 0;
    const target = selected.size ? rows.filter(r => selected.has(r._rid)) : rows.filter(r => qty(r) > 0);
    if (!target.length) {
      notify('Enter a Purchase Qty on the rows to add (or select rows).', 'warning');
      gridRef.current?.focusFirst();
      return;
    }
    const noQty = target.filter(r => !(qty(r) > 0) || !Number.isInteger(qty(r)));
    if (noQty.length) {
      const errs = Object.fromEntries(noQty.map(r => [r._rid, { quantity: 'Enter a whole Purchase Qty above 0.' }]));
      setServerErrors(prev => ({ ...prev, ...errs }));
      focusFirstError(errs);
      notify(`${noQty.length} selected row${noQty.length === 1 ? ' has' : 's have'} no purchase quantity.`, 'warning');
      return;
    }
    const fresh = target.filter(r => !r.id);
    if (fresh.length && !validateBeforeSave(fresh)) return;
    if (target.some(r => clientErrors[r._rid])) { focusFirstError(clientErrors); notify('Fix the highlighted rows first.', 'warning'); return; }

    setSaving(true);
    let savedRows = [];
    if (fresh.length) {
      const result = await postSave(fresh);
      if (!result) { setSaving(false); return; }
      savedRows = applySavedResult(fresh, result);
      window.dispatchEvent(new Event('optical_stock_updated'));
    }
    setSaving(false);
    const savedByRid = new Map(savedRows.map(r => [r._rid, r]));
    const lines = target.map(r => {
      const s = savedByRid.get(r._rid) || r;
      const t = taxOf(r);
      let rate = Number(r.cost_price) || 0;
      if (defaults.cost_includes_tax && purchaseGstType !== 'INCLUSIVE') rate = round2(rate / (1 + t / 100));
      let mrp = Number(r.mrp) || 0;
      if (!defaults.mrp_includes_tax) mrp = round2(mrp * (1 + t / 100));
      return {
        id: String(s.id), name: s.name || r.name, sku: s.sku, barcode: s.barcode || '', stock: s.stock ?? 0,
        quantity: qty(r), costPrice: rate, mrp, sellingPrice: Number(r.sales_price) || mrp || 0,
        taxRate: t, hsnCode: s.hsn_code || r.hsn_code || parent.hsn_code || '',
      };
    });
    dropKey(DRAFT_KEY(context));
    setDirty(false);
    onAddToPurchase?.(lines);
    notify(`${lines.length} item${lines.length === 1 ? '' : 's'} added to the purchase.`, 'success');
    onClose?.();
  };

  const primaryAction = isPurchase ? addToPurchase : save;

  // ------------------------------------------------------------------ drafts

  useEffect(() => {
    if (!open || !dirty || groupId) return undefined;
    const t = setTimeout(() => {
      const unsaved = rows.filter(r => !r.id).slice(0, DRY_RUN_MAX_ROWS);
      writeJson(DRAFT_KEY(context), { savedAt: new Date().toISOString(), parent, defaults, axes, rows: unsaved });
    }, 1000);
    return () => clearTimeout(t);
  }, [open, dirty, groupId, rows, parent, defaults, axes, context]);

  const restoreDraft = () => {
    if (!draft) return;
    setParent({ ...blankParent(), ...draft.parent });
    setDefaults({ ...blankDefaults(), ...draft.defaults });
    setAxes(draft.axes || []);
    setRows((draft.rows || []).map(r => ({ ...makeRow(), ...r, _rid: newRid(), id: null })));
    setDraft(null);
    setDirty(true);
  };
  const discardDraft = () => { dropKey(DRAFT_KEY(context)); setDraft(null); };

  // ------------------------------------------------------------------ close / clear

  const requestClose = async () => {
    if (saving) return;
    if (dirty && !(await askConfirm({ title: 'Close without saving?', message: 'Unsaved rows will be lost (a draft of new rows is kept on this computer).', confirmText: 'Close', type: 'danger' }))) return;
    onClose?.();
  };

  const clearAll = async () => {
    if ((dirty || rows.length) && !(await askConfirm({ title: 'Clear everything?', message: 'Clears the product details, generated variants and all rows. Saved items stay in the Product Master.', confirmText: 'Clear all', type: 'danger' }))) return;
    resetAll();
    dropKey(DRAFT_KEY(context));
    setTimeout(() => nameRef.current?.focus(), 30);
  };

  // ------------------------------------------------------------------ templates

  const templateConfig = () => ({
    category: parent.category, sub_category: parent.sub_category, group: parent.group, brand: parent.brand,
    unit: parent.unit, hsn_code: parent.hsn_code, tax_percent: parent.tax_percent,
    axes: axes.map(a => ({ key: a.key, label: a.label, values: a.values })),
    sku_rule: { base_sku: parent.base_sku },
    columns: colVis,
    defaults: { cost_includes_tax: defaults.cost_includes_tax, mrp_includes_tax: defaults.mrp_includes_tax, auto_barcode: autoBarcode },
  });

  const loadTemplate = (t) => {
    setTemplateMenu(null);
    const c = t.config || {};
    setParent(p => ({
      ...p, category: c.category ?? p.category, sub_category: c.sub_category ?? p.sub_category, group: c.group ?? p.group,
      brand: c.brand ?? p.brand, unit: c.unit ?? p.unit, hsn_code: c.hsn_code ?? p.hsn_code,
      tax_percent: c.tax_percent ?? p.tax_percent, base_sku: p.base_sku || c.sku_rule?.base_sku || '',
    }));
    if (Array.isArray(c.axes)) setAxes(c.axes.map(a => ({ key: a.key, label: a.label, values: a.values || [] })));
    if (c.columns) setColVis(v => ({ ...v, ...c.columns }));
    if (c.defaults) {
      setDefaults(d => ({ ...d, cost_includes_tax: Boolean(c.defaults.cost_includes_tax), mrp_includes_tax: c.defaults.mrp_includes_tax !== false }));
      if (typeof c.defaults.auto_barcode === 'boolean') setAutoBarcode(c.defaults.auto_barcode);
    }
    setLoadedTemplate(t);
    setGenOpen(true);
    setDirty(true);
    notify(`Template "${t.name}" loaded.`, 'success');
  };

  const saveTemplate = async (name) => {
    try {
      const res = await axios.post(TEMPLATE_API, { name, category_name: parent.category, config: templateConfig() });
      setTemplates(ts => [...ts, res.data].sort((a, b) => a.name.localeCompare(b.name)));
      setLoadedTemplate(res.data);
      notify(`Template "${name}" saved.`, 'success');
      return true;
    } catch (e) {
      notify(e.response?.data?.name?.[0] || e.response?.data?.config?.[0] || 'Could not save the template.', 'error');
      return false;
    }
  };

  const updateTemplate = async () => {
    setTemplateMenu(null);
    if (!loadedTemplate) return;
    try {
      const res = await axios.put(`${TEMPLATE_API}${loadedTemplate.id}/`, { name: loadedTemplate.name, category_name: parent.category, config: templateConfig() });
      setTemplates(ts => ts.map(t => (t.id === res.data.id ? res.data : t)));
      setLoadedTemplate(res.data);
      notify(`Template "${res.data.name}" updated.`, 'success');
    } catch { notify('Could not update the template.', 'error'); }
  };

  const duplicateTemplate = async (t) => {
    try {
      const res = await axios.post(`${TEMPLATE_API}${t.id}/duplicate/`, {});
      setTemplates(ts => [...ts, res.data].sort((a, b) => a.name.localeCompare(b.name)));
      notify(`Template copied as "${res.data.name}".`, 'success');
    } catch { notify('Could not copy the template.', 'error'); }
  };

  const deleteTemplate = async (t) => {
    setTemplateMenu(null);
    if (!(await askConfirm({ title: 'Delete template?', message: `Delete "${t.name}"? Products created from it are not affected.`, confirmText: 'Delete', type: 'danger' }))) return;
    try {
      await axios.delete(`${TEMPLATE_API}${t.id}/`);
      setTemplates(ts => ts.filter(x => x.id !== t.id));
      if (loadedTemplate?.id === t.id) setLoadedTemplate(null);
    } catch { notify('Could not delete the template.', 'error'); }
  };

  // ------------------------------------------------------------------ import / export / barcodes

  const loadImportedGroup = (g) => {
    setParent(p => ({ ...p, ...Object.fromEntries(Object.entries(g.group || {}).filter(([, v]) => v !== '' && v != null)) }));
    const imported = g.variants.map(v => makeRow({}, v.data.attributes || {}, {
      ...Object.fromEntries(Object.entries(v.data).filter(([k]) => k !== 'attributes')), _edited: true,
    }));
    setRows(prev => [...prev.filter(r => r.id || r._edited), ...imported]);
    setAxes(prev => {
      const keys = new Set(prev.map(a => a.key));
      const next = [...prev];
      imported.forEach(r => Object.keys(r.attributes).forEach(k => { if (!keys.has(k)) { keys.add(k); next.push({ key: k, values: [] }); } }));
      return next.map(a => ({ ...a, values: Array.from(new Set([...a.values, ...imported.map(r => r.attributes[a.key]).filter(Boolean)])) }));
    });
    setDirty(true);
    notify(`${imported.length} row${imported.length === 1 ? '' : 's'} loaded — review and save.`, 'info');
  };

  const exportXlsx = async () => {
    setMoreMenu(null);
    try {
      const res = await axios.get(`${API}export/`, { params: groupId ? { group: groupId } : {}, responseType: 'blob' });
      downloadBlob(res.data, groupId ? `${baseSku || 'product'}-variants.xlsx` : 'product-variants.xlsx');
    } catch { notify('Export failed.', 'error'); }
  };

  const savedTargets = () => (selected.size ? rows.filter(r => selected.has(r._rid)) : rows).filter(r => r.id);

  const generateBarcodes = async () => {
    setMoreMenu(null);
    const ids = savedTargets().filter(r => !r.barcode).map(r => r.id);
    if (!ids.length) { notify('Every saved item here already has a barcode (unsaved rows get one when you save).', 'info'); return; }
    try {
      const res = await axios.post('/api/products/items/generate_missing_barcodes/', { product_ids: ids });
      const byId = new Map((res.data.products || []).map(p => [String(p.id), p.barcode]));
      setRows(prev => prev.map(r => (r.id && byId.has(String(r.id)) ? { ...r, barcode: byId.get(String(r.id)) } : r)));
      notify(`Generated ${res.data.generated} barcode${res.data.generated === 1 ? '' : 's'}.`, 'success');
    } catch { notify('Could not generate barcodes.', 'error'); }
  };

  const printBarcodes = () => {
    setMoreMenu(null);
    const targets = savedTargets().filter(r => r.barcode);
    if (!targets.length) { notify('Save the items (with barcodes) before printing labels.', 'warning'); return; }
    setPrintTargets(targets.map(r => ({
      id: r.id, name: r.name, code: r.sku, product_code: r.sku, barcode: r.barcode,
      sellingPrice: Number(r.sales_price) || 0, colour: r.attributes.color || '', size: r.attributes.size || '',
    })));
  };

  // ------------------------------------------------------------------ keyboard

  const onRootKeyDown = useVariantShortcuts({
    focusName: () => { setDetailsOpen(true); setTimeout(() => nameRef.current?.focus(), 0); },
    findExisting: () => { setDetailsOpen(true); setTimeout(() => findRef.current?.focus(), 0); },
    generator: () => { setGenOpen(true); setGenFocusToken(t => t + 1); setTimeout(() => genRef.current?.querySelector('[role="combobox"], input:not([aria-hidden="true"])')?.focus(), 60); },
    primary: (e) => {
      if (genRef.current?.contains(e.target)) generate();
      else primaryAction();
    },
    save: () => save(),
    addRow: () => addBlankRows(1),
    duplicateRow: () => { if (!duplicateTargets.length) return false; duplicateRows(duplicateTargets); return true; },
    selectAll: () => onToggleAll(!(viewRows.length && viewRows.every(r => selected.has(r._rid)))),
    selectAllPlain: (e) => {
      if (!gridRef.current?.container()?.contains(e.target)) return false;
      onToggleAll(true);
      return true;
    },
    deleteRows: () => { if (!selected.size) return false; removeRows(Array.from(selected)); return true; },
    deleteRowCtrl: () => {
      if (selected.size) removeRows(Array.from(selected));
      else if (viewRows[activeRow]) removeRows([viewRows[activeRow]._rid]);
      else return false;
      return true;
    },
    filter: () => filterRef.current?.focus(),
    help: () => setHelpOpen(true),
  });

  // Enter moves through the header form fields (the global App.jsx Enter handler is opted out
  // with data-own-enter so it can't click this dialog's buttons from the grid).
  const onFormKeyDown = (e) => {
    if (e.key !== 'Enter' || e.defaultPrevented || e.shiftKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t.tagName !== 'INPUT' || t.closest('[role="grid"]')) return;
    if (t.getAttribute('aria-expanded') === 'true') return;
    const scope = e.currentTarget;
    const inputs = Array.from(scope.querySelectorAll('input:not([type="hidden"]):not([disabled]):not([type="checkbox"]), textarea:not([disabled])'))
      .filter(el => el.offsetParent !== null && !el.closest('[role="grid"]'));
    const i = inputs.indexOf(t);
    if (i >= 0 && i < inputs.length - 1) {
      e.preventDefault();
      inputs[i + 1].focus();
      inputs[i + 1].select?.();
    } else if (i === inputs.length - 1) {
      e.preventDefault();
      gridRef.current?.focusFirst();
    }
  };

  useEffect(() => { writeJson(COLVIS_KEY, colVis); }, [colVis]);

  // Opened from an Excel preview's "Load into grid" (state setters are functional, so this
  // lands on top of the reset done by the open effect above).
  useEffect(() => {
    if (open && initialImportGroup) loadImportedGroup(initialImportGroup);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialImportGroup]);

  // MUI's focus trap focuses the dialog container on open and can win the race against a plain
  // focus() in onEntered (StrictMode re-runs it), so re-assert once it has settled.
  const focusNameOnOpen = () => {
    const tryFocus = () => {
      const a = document.activeElement;
      if (a && a !== document.body && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && a !== nameRef.current) return;
      nameRef.current?.focus();
    };
    tryFocus();
    setTimeout(tryFocus, 60);
    setTimeout(tryFocus, 250);
  };

  // ------------------------------------------------------------------ render

  const categoryMaster = backendMaster(CATEGORY_API, LS_KEYS.hiddenCategories, categoryRecords, setCategoryRecords, setCategoryOptions);
  const brandMaster = backendMaster(BRAND_API, LS_KEYS.hiddenBrands, brandRecords, setBrandRecords, setBrandOptions);
  const unitMaster = backendMaster(UNIT_API, null, unitRecords, setUnitRecords, setUnitOptions);
  const subCategoryMaster = localMaster(LS_KEYS.subCategory, setSubCategoryOptions);
  const groupMaster = localMaster(LS_KEYS.group, setGroupOptions);
  const modelNumberMaster = localMaster(LS_KEYS.modelNumber, setModelNumberOptions);
  const masterProps = (m) => ({ onPersist: m.persist, onRename: m.rename, onRemove: m.remove });
  const hasGenerated = rows.some(r => r._generated && !r.id);
  const savedCount = rows.filter(r => r.id).length;
  const qtyRows = isPurchase ? rows.filter(r => Number(r.quantity) > 0).length : 0;
  const title = groupId ? `Manage Variants — ${parent.name || 'Product'}` : 'Add Multiple Items';

  return (
    <>
      <Dialog
        open={open}
        onClose={(e, reason) => { if (reason === 'backdropClick') return; requestClose(); }}
        fullWidth maxWidth="xl"
        // On the Dialog root (not the Paper): after a focused row is removed MUI's focus trap
        // parks focus on the dialog container, which sits outside the Paper.
        onKeyDown={onRootKeyDown}
        data-own-enter="true"
        PaperProps={{ sx: { height: { md: '94vh' }, borderRadius: 2 }, 'aria-labelledby': 'pvm-title' }}
        TransitionProps={{ onEntered: focusNameOnOpen }}
      >
        <DialogTitle id="pvm-title" sx={{ py: 1.25, px: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Stack direction="row" alignItems="center" spacing={1.5} flexWrap="wrap" useFlexGap>
            <Box sx={{ flex: 1, minWidth: 240 }}>
              <Stack direction="row" alignItems="center" spacing={1}>
                <Typography variant="h6" fontWeight={900}>{title}</Typography>
                <Chip size="small" color="primary" label={`${rows.length} item${rows.length === 1 ? '' : 's'}`} />
                {savedCount > 0 && <Chip size="small" variant="outlined" label={`${savedCount} saved`} />}
                {isPurchase && <Chip size="small" color="secondary" variant="outlined" label={`Purchase${supplierName ? ` · ${supplierName}` : ''}`} />}
                {loadedTemplate && <Chip size="small" variant="outlined" icon={<TemplateIcon />} label={loadedTemplate.name} onDelete={() => setLoadedTemplate(null)} />}
              </Stack>
              <Typography variant="caption" color="text.secondary">
                {isPurchase
                  ? 'Pick an existing product or create one, generate its variants, enter purchase quantities and costs, then add them to this purchase. Stock moves only when the purchase is saved as Confirmed.'
                  : 'Define one product and generate all its variants (colour, size, power…) in one go. Each variant gets its own SKU, barcode and stock.'}
              </Typography>
            </Box>
            <Tooltip title="Templates"><Button size="small" startIcon={<TemplateIcon />} onClick={(e) => setTemplateMenu(e.currentTarget)}>Templates</Button></Tooltip>
            <Tooltip title="Import from Excel"><Button size="small" startIcon={<ImportIcon />} onClick={() => setImportOpen(true)}>Import</Button></Tooltip>
            <Button size="small" onClick={(e) => setMoreMenu(e.currentTarget)} endIcon={<ExpandIcon />}>More</Button>
            <Tooltip title="Keyboard shortcuts (Ctrl+/)"><IconButton size="small" onClick={() => setHelpOpen(true)}><KeyboardIcon fontSize="small" /></IconButton></Tooltip>
            <Button size="small" color="inherit" startIcon={<ClearAllIcon />} onClick={clearAll}>Clear all</Button>
            <Tooltip title="Close (Esc)"><IconButton onClick={requestClose} aria-label="Close"><CloseIcon /></IconButton></Tooltip>
          </Stack>
        </DialogTitle>

        <DialogContent sx={{ p: 1.5, bgcolor: 'background.default' }} onKeyDown={onFormKeyDown}>
          {loading && <Stack alignItems="center" sx={{ py: 6 }}><CircularProgress /></Stack>}
          {!loading && (
            <Stack spacing={1.25} sx={{ pt: 1 }}>
              {draft && (
                <Alert severity="info" icon={<RestoreIcon />} action={<Stack direction="row"><Button size="small" onClick={restoreDraft}>Restore</Button><Button size="small" color="inherit" onClick={discardDraft}>Discard</Button></Stack>}>
                  Unsaved draft from {new Date(draft.savedAt).toLocaleString()} — {draft.rows?.length || 0} row(s){draft.parent?.name ? ` of "${draft.parent.name}"` : ''}.
                </Alert>
              )}

              <Section
                title="Product information"
                action={<IconButton size="small" onClick={() => setDetailsOpen(o => !o)} aria-label="Toggle product information">{detailsOpen ? <CollapseIcon /> : <ExpandIcon />}</IconButton>}
              >
                <Collapse in={detailsOpen}>
                  <Grid container spacing={1.25}>
                    <Grid item xs={12} md={5}>
                      <TextField
                        inputRef={nameRef} fullWidth size="small" label="Product Name * (F2)" value={parent.name}
                        onChange={(e) => setParentField('name')(e.target.value)}
                        error={Boolean(groupErrors.name)} helperText={groupErrors.name}
                        inputProps={{ style: { fontWeight: 800 } }}
                      />
                    </Grid>
                    <Grid item xs={12} md={4}>
                      <Autocomplete
                        size="small" options={findOptions} loading={findLoading} filterOptions={(x) => x}
                        getOptionLabel={(o) => o?.label || ''} isOptionEqualToValue={(a, b) => a.id === b.id}
                        inputValue={findInput} onInputChange={(e, v, reason) => reason !== 'reset' && setFindInput(v)}
                        value={null} onChange={(e, v) => pickExisting(v)}
                        noOptionsText={findInput.trim().length < 2 ? 'Type 2+ letters, a SKU or a barcode' : 'No matching product'}
                        renderOption={(props, o) => (
                          <li {...props} key={`${o.type}-${o.id}`}>
                            <Box>
                              <Typography variant="body2" component="div" fontWeight={700}>{o.label} {o.type === 'group' && <Chip size="small" label="variants" sx={{ ml: 0.5, height: 18 }} />}</Typography>
                              <Typography variant="caption" color="text.secondary">{o.sub}</Typography>
                            </Box>
                          </li>
                        )}
                        renderInput={(params) => (
                          <TextField {...params} inputRef={findRef} label="Find existing product (Shift+F2)"
                            InputProps={{ ...params.InputProps, startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
                        )}
                      />
                    </Grid>
                    <Grid item xs={6} md={3}>
                      <TextField fullWidth size="small" label="Base SKU" value={parent.base_sku} placeholder={baseSku || 'auto'}
                        onChange={(e) => setParentField('base_sku')(e.target.value.toUpperCase())}
                        error={Boolean(groupErrors.base_sku)} helperText={groupErrors.base_sku || 'Variant SKUs = Base-Attribute codes'} />
                    </Grid>
                    <Grid item xs={6} sm={4} md={2}><AttributeField label="Category" value={parent.category} onChange={setCategory} options={categoryOptions} {...masterProps(categoryMaster)} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><AttributeField label="Subcategory" value={parent.sub_category} onChange={setParentField('sub_category')} options={subCategoryOptions} {...masterProps(subCategoryMaster)} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><AttributeField label="Group" value={parent.group} onChange={setParentField('group')} options={groupOptions} {...masterProps(groupMaster)} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><AttributeField label="Brand" value={parent.brand} onChange={setParentField('brand')} options={brandOptions} {...masterProps(brandMaster)} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><AttributeField label="Model Number" value={parent.model_number} onChange={setParentField('model_number')} options={modelNumberOptions} {...masterProps(modelNumberMaster)} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><AttributeField label="Unit" value={parent.unit} onChange={setParentField('unit')} options={unitOptions} {...masterProps(unitMaster)} /></Grid>
                    <Grid item xs={6} sm={4} md={2}><TextField fullWidth size="small" label="HSN / Tax Code" value={parent.hsn_code} onChange={(e) => setParentField('hsn_code')(e.target.value)} /></Grid>
                    <Grid item xs={6} sm={4} md={2}>
                      <TextField select fullWidth size="small" label="Tax %" value={parent.tax_percent === '' || parent.tax_percent == null ? '' : Number(parent.tax_percent)}
                        onChange={(e) => setParentField('tax_percent')(e.target.value)} error={Boolean(groupErrors.tax_percent)}>
                        <MenuItem value=""><em>Not set</em></MenuItem>
                        {taxOptions.map(t => <MenuItem key={t} value={t}>{t}%</MenuItem>)}
                      </TextField>
                    </Grid>
                    <Grid item xs={12} sm={8} md={6}><TextField fullWidth size="small" label="Product Description" value={parent.description} onChange={(e) => setParentField('description')(e.target.value)} /></Grid>
                    <Grid item xs={8} md={3}><TextField fullWidth size="small" label="Long Description" value={parent.long_description} onChange={(e) => setParentField('long_description')(e.target.value)} /></Grid>
                    <Grid item xs={4} md={1}>
                      <FormControlLabel sx={{ m: 0 }} control={<Switch size="small" checked={parent.is_active} onChange={(e) => setParentField('is_active')(e.target.checked)} />} label={parent.is_active ? 'Active' : 'Inactive'} />
                    </Grid>
                  </Grid>

                  <Divider sx={{ my: 1.25 }} />
                  <Typography variant="caption" fontWeight={800} color="text.secondary">
                    {isPurchase ? 'PURCHASE DETAILS — defaults for new rows' : 'PRICING — defaults for new rows (optional)'}
                  </Typography>
                  <Grid container spacing={1.25} sx={{ mt: 0 }} alignItems="center">
                    {isPurchase
                      ? <Grid item xs={6} sm={3} md={1.5}><TextField fullWidth size="small" label="Purchase Qty" value={defaults.quantity} onChange={(e) => setDefault('quantity')(e.target.value.replace(/[^0-9]/g, ''))} inputProps={{ inputMode: 'numeric' }} /></Grid>
                      : <Grid item xs={6} sm={3} md={1.5}><TextField fullWidth size="small" label="Opening Qty" value={defaults.opening_stock} onChange={(e) => setDefault('opening_stock')(e.target.value.replace(/[^0-9]/g, ''))} inputProps={{ inputMode: 'numeric' }} /></Grid>}
                    <Grid item xs={6} sm={3} md={1.5}><TextField fullWidth size="small" label="Cost Price" value={defaults.cost_price} onChange={(e) => setDefault('cost_price')(e.target.value)} inputProps={{ inputMode: 'decimal' }} /></Grid>
                    <Grid item xs={6} sm={3} md={1.5}><TextField fullWidth size="small" label="MRP" value={defaults.mrp} onChange={(e) => setDefault('mrp')(e.target.value)} inputProps={{ inputMode: 'decimal' }} /></Grid>
                    <Grid item xs={6} sm={3} md={1.5}><TextField fullWidth size="small" label="Sales Price" value={defaults.sales_price} placeholder={defaults.mrp} onChange={(e) => setDefault('sales_price')(e.target.value)} inputProps={{ inputMode: 'decimal' }} /></Grid>
                    <Grid item xs="auto"><FormControlLabel control={<Checkbox size="small" checked={defaults.cost_includes_tax} onChange={(e) => setDefault('cost_includes_tax')(e.target.checked)} />} label={<Typography variant="body2">Cost includes tax</Typography>} /></Grid>
                    <Grid item xs="auto"><FormControlLabel control={<Checkbox size="small" checked={defaults.mrp_includes_tax} onChange={(e) => setDefault('mrp_includes_tax')(e.target.checked)} />} label={<Typography variant="body2">MRP includes tax</Typography>} /></Grid>
                    {isPurchase && supplierName && <Grid item xs="auto"><Chip size="small" label={`Supplier: ${supplierName}`} /></Grid>}
                    <Grid item xs="auto"><Button size="small" startIcon={<ApplyIcon />} onClick={applyDefaultsToRows} disabled={!rows.length}>Apply to {selected.size ? 'selected' : 'all'} rows</Button></Grid>
                  </Grid>
                  {isPurchase && (
                    <Typography variant="caption" color="text.secondary">
                      Costs entered here belong to this purchase only; the product master is not given a supplier cost until the purchase is saved.
                    </Typography>
                  )}
                </Collapse>
              </Section>

              <Section
                title="Generate multiple variants (F4)"
                action={<IconButton size="small" onClick={() => setGenOpen(o => !o)} aria-label="Toggle variant generator">{genOpen ? <CollapseIcon /> : <ExpandIcon />}</IconButton>}
              >
                <Collapse in={genOpen}>
                  <Box ref={genRef}>
                    <VariantGenerator
                      axes={axes}
                      setAxes={(a) => { setAxes(a); setDirty(true); }}
                      onGenerate={generate}
                      onClearGenerated={clearGenerated}
                      onAddRows={addBlankRows}
                      hasGenerated={hasGenerated}
                      attributeOrder={attrKeys}
                      focusToken={genFocusToken}
                    />
                  </Box>
                </Collapse>
                {!genOpen && combinationCount(axes) > 0 && (
                  <Typography variant="caption" color="text.secondary">{axes.map(a => `${attributeMeta(a.key).label}: ${a.values.length}`).join(' · ')}</Typography>
                )}
              </Section>

              <Section
                title="Items"
                sx={{ pb: 1 }}
                action={
                  <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                    <TextField
                      inputRef={filterRef} size="small" placeholder="Search rows (Ctrl+F)" value={filter} onChange={(e) => setFilter(e.target.value)}
                      InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
                      sx={{ width: 210, '& input': { py: 0.6 } }}
                    />
                    {selected.size > 0 && <Chip size="small" label={`${selected.size} selected`} onDelete={() => setSelected(new Set())} />}
                    <Tooltip title="Add a blank row (Alt+N)"><Button size="small" startIcon={<AddRowIcon />} onClick={() => addBlankRows(1)}>Add row</Button></Tooltip>
                    <Tooltip title="Duplicate the ticked rows, or the row with the cursor, with all their details (Ctrl+D / Alt+D)">
                      <span><Button size="small" startIcon={<DuplicateIcon />} disabled={!duplicateTargets.length} onClick={() => duplicateRows(duplicateTargets)}>Duplicate{selected.size > 1 ? ` (${selected.size})` : ''}</Button></span>
                    </Tooltip>
                    <Tooltip title="Remove selected rows (Delete)">
                      <span><Button size="small" color="error" startIcon={<DeleteSelectedIcon />} disabled={!selected.size} onClick={() => removeRows(Array.from(selected))}>Remove</Button></span>
                    </Tooltip>
                    <Tooltip title="Show / hide columns"><IconButton size="small" onClick={(e) => setColMenu(e.currentTarget)}><ColumnsIcon fontSize="small" /></IconButton></Tooltip>
                  </Stack>
                }
              >
                {Object.keys(groupErrors).filter(k => groupErrors[k]).length > 0 && (
                  <Alert severity="error" sx={{ mb: 1 }}>{Object.values(groupErrors).filter(Boolean).join(' ')}</Alert>
                )}
                <VariantGrid
                  ref={gridRef}
                  rows={viewRows}
                  columns={columns}
                  errors={errors}
                  selected={selected}
                  onToggle={onToggle}
                  onToggleAll={onToggleAll}
                  onChange={onCellChange}
                  onDuplicate={duplicateRow}
                  onDelete={onDeleteOne}
                  sort={sort}
                  onSort={onSort}
                  onActiveRow={setActiveRow}
                  height={detailsOpen && genOpen ? 300 : detailsOpen || genOpen ? 380 : 520}
                  emptyState={
                    <Stack spacing={1} alignItems="center">
                      <Typography variant="body2" fontWeight={700}>{filter ? 'No rows match the search.' : 'No items yet'}</Typography>
                      {!filter && <Typography variant="caption" color="text.secondary">Choose attribute values above and press Generate variants (Ctrl+Enter), add rows by hand (Alt+N), import from Excel, or find an existing product.</Typography>}
                      {!filter && <Stack direction="row" spacing={1}><Button size="small" variant="outlined" startIcon={<GenerateIcon />} onClick={() => { setGenOpen(true); setGenFocusToken(t => t + 1); }}>Generate variants</Button><Button size="small" startIcon={<AddRowIcon />} onClick={() => addBlankRows(1)}>Add a row</Button></Stack>}
                    </Stack>
                  }
                />
              </Section>
            </Stack>
          )}
        </DialogContent>

        <DialogActions sx={{ px: 2, py: 1, borderTop: 1, borderColor: 'divider', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
            <FormControlLabel control={<Checkbox size="small" checked={autoBarcode} onChange={(e) => setAutoBarcode(e.target.checked)} />} label={<Typography variant="body2">Generate barcodes for new rows without one</Typography>} />
            {errorCount > 0
              ? <Chip size="small" color="error" label={`${errorCount} row${errorCount === 1 ? '' : 's'} with errors`} />
              : rows.length > 0 && <Chip size="small" color="success" variant="outlined" label={checking ? 'Checking…' : 'All rows valid'} />}
            {removedIds.length > 0 && <Chip size="small" color="warning" variant="outlined" label={`${removedIds.length} to deactivate on save`} />}
          </Stack>
          <Stack direction="row" spacing={1}>
            <Button onClick={requestClose} disabled={saving}>Cancel</Button>
            {isPurchase ? (
              <>
                <Button variant="outlined" startIcon={<SaveIcon />} onClick={save} disabled={saving || !rows.some(r => !r.id)}>Save new items only (Ctrl+S)</Button>
                <Button variant="contained" startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <AddToPurchaseIcon />} onClick={addToPurchase} disabled={saving || !rows.length} sx={{ fontWeight: 800 }}>
                  Add {selected.size ? `${selected.size} selected` : `${qtyRows || ''} item${qtyRows === 1 ? '' : 's'}`} to purchase (Ctrl+Enter)
                </Button>
              </>
            ) : (
              <Button variant="contained" startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />} onClick={save} disabled={saving || !rows.length} sx={{ fontWeight: 800 }}>
                {groupId ? 'Save changes' : `Save ${rows.length || ''} item${rows.length === 1 ? '' : 's'}`} (Ctrl+S)
              </Button>
            )}
          </Stack>
        </DialogActions>
      </Dialog>

      <Menu anchorEl={colMenu} open={Boolean(colMenu)} onClose={() => setColMenu(null)}>
        {OPTIONAL_COLUMNS.map(([k, label]) => (
          <MenuItem key={k} dense onClick={() => setColVis(v => ({ ...v, [k]: !v[k] }))}>
            <Checkbox size="small" checked={Boolean(colVis[k])} sx={{ p: 0.25, mr: 1 }} />{label}
          </MenuItem>
        ))}
      </Menu>

      <Menu anchorEl={moreMenu} open={Boolean(moreMenu)} onClose={() => setMoreMenu(null)}>
        <MenuItem onClick={exportXlsx}><ListItemIcon><ExportIcon fontSize="small" /></ListItemIcon><ListItemText primary={groupId ? 'Export this product to Excel' : 'Export all variants to Excel'} /></MenuItem>
        <MenuItem onClick={generateBarcodes} disabled={!savedCount}><ListItemIcon><BarcodeIcon fontSize="small" /></ListItemIcon><ListItemText primary="Generate missing barcodes" secondary={selected.size ? 'Selected saved rows' : 'All saved rows'} /></MenuItem>
        <MenuItem onClick={printBarcodes} disabled={!savedCount}><ListItemIcon><PrintIcon fontSize="small" /></ListItemIcon><ListItemText primary="Print barcode labels" secondary={selected.size ? 'Selected saved rows' : 'All saved rows'} /></MenuItem>
      </Menu>

      <Menu anchorEl={templateMenu} open={Boolean(templateMenu)} onClose={() => setTemplateMenu(null)} PaperProps={{ sx: { minWidth: 300 } }}>
        <MenuItem onClick={() => { setTemplateMenu(null); setTemplateNameDialog({ name: parent.category ? `${parent.category} Template` : '' }); }}>
          <ListItemIcon><TemplateSaveIcon fontSize="small" /></ListItemIcon><ListItemText primary="Save as template…" secondary="Category, attributes, values, tax, columns" />
        </MenuItem>
        {loadedTemplate && <MenuItem onClick={updateTemplate}><ListItemIcon><EditIcon fontSize="small" /></ListItemIcon><ListItemText primary={`Update "${loadedTemplate.name}"`} /></MenuItem>}
        <Divider />
        {templates.length === 0 && <MenuItem disabled>No templates yet</MenuItem>}
        {templates.map(t => (
          <MenuItem key={t.id} onClick={() => loadTemplate(t)} sx={{ pr: 0.5 }}>
            <ListItemText primary={t.name} secondary={t.category_name || undefined} />
            <Tooltip title="Duplicate"><IconButton size="small" onClick={(e) => { e.stopPropagation(); duplicateTemplate(t); }}><DuplicateIcon fontSize="small" /></IconButton></Tooltip>
            <Tooltip title="Delete"><IconButton size="small" color="error" onClick={(e) => { e.stopPropagation(); deleteTemplate(t); }}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
          </MenuItem>
        ))}
      </Menu>

      <Dialog open={Boolean(templateNameDialog)} onClose={() => setTemplateNameDialog(null)} maxWidth="xs" fullWidth PaperProps={{ 'data-own-enter': 'true' }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Save as template</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus fullWidth size="small" label="Template name" sx={{ mt: 1 }}
            value={templateNameDialog?.name || ''} onChange={(e) => setTemplateNameDialog({ name: e.target.value })}
            onKeyDown={async (e) => { if (e.key === 'Enter' && templateNameDialog?.name.trim()) { e.preventDefault(); if (await saveTemplate(templateNameDialog.name.trim())) setTemplateNameDialog(null); } }}
            helperText="Saves category, attributes and their values, tax, SKU base and visible columns — never supplier or invoice details."
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setTemplateNameDialog(null)}>Cancel</Button>
          <Button variant="contained" disabled={!templateNameDialog?.name.trim()} onClick={async () => { if (await saveTemplate(templateNameDialog.name.trim())) setTemplateNameDialog(null); }}>Save template</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={helpOpen} onClose={() => setHelpOpen(false)} maxWidth="sm" fullWidth PaperProps={{ 'data-own-enter': 'true' }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Keyboard shortcuts — Add Multiple Items</DialogTitle>
        <DialogContent dividers>
          {Array.from(new Set(VARIANT_SHORTCUTS.map(s => s.group))).map(group => (
            <Box key={group} sx={{ mb: 1.5 }}>
              <Typography variant="caption" fontWeight={800} color="text.secondary">{group.toUpperCase()}</Typography>
              {VARIANT_SHORTCUTS.filter(s => s.group === group && !s.hidden).map(s => (
                <Stack key={s.id} direction="row" spacing={1.5} alignItems="baseline" sx={{ py: 0.4 }}>
                  <Stack direction="row" spacing={0.5} sx={{ minWidth: 150 }}>
                    {s.keys.map(k => <Box key={k} component="kbd" sx={{ px: 0.75, py: 0.1, border: 1, borderColor: 'divider', borderRadius: 1, fontSize: '0.75rem', fontFamily: 'monospace', bgcolor: 'action.hover' }}>{k}</Box>)}
                  </Stack>
                  <Typography variant="body2">{s.label}</Typography>
                </Stack>
              ))}
            </Box>
          ))}
        </DialogContent>
        <DialogActions><Button onClick={() => setHelpOpen(false)}>Close</Button></DialogActions>
      </Dialog>

      <VariantImportDialog
        open={importOpen}
        onClose={() => setImportOpen(false)}
        context={context}
        onLoadIntoGrid={loadImportedGroup}
        onImported={(r) => { if (r.imported_rows) window.dispatchEvent(new Event('optical_stock_updated')); onSaved?.(r); }}
      />

      <BarcodePrintDialog open={Boolean(printTargets)} onClose={() => setPrintTargets(null)} products={printTargets || []} />

      <ConfirmActionDialog
        open={Boolean(confirm.open)}
        title={confirm.title}
        message={confirm.message}
        type={confirm.type}
        confirmText={confirm.confirmText}
        onConfirm={confirm.onConfirm}
        onClose={confirm.onClose}
      />
    </>
  );
}
