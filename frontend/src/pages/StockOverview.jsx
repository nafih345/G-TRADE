// Purchase → Stock Overview: live inventory over the whole catalogue.
//
// Every figure comes from /api/inventory/stock-overview/ (server-side search, filters, sort and
// pagination — the catalogue is never loaded into the browser). Every column except Status and
// Last Purchase (both derived) is edited in the row and saved only after a confirm step. Codes,
// name, prices, locations… are a field PATCH; a changed Current Stock is never written as a field —
// it is recorded as a ledgered stock adjustment (with a reason) in the same confirm step.
//
// Keyboard: "/" focuses search · Enter in search = exact scan lookup · ↑/↓ move between rows ·
// Space selects · Enter = edit row · A = Adjust stock · H = History · P = Print barcode ·
// in an edited row Enter = save, Esc = cancel. A USB scanner works anywhere on the page.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Box, Typography, Button, Breadcrumbs, Link, Card, Stack, TextField, MenuItem, InputAdornment, IconButton,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, TablePagination, TableSortLabel, Checkbox,
  Chip, Tooltip, Menu, LinearProgress, Alert, Dialog, DialogTitle, DialogContent, DialogActions, CircularProgress,
  ListItemIcon, ListItemText, Divider, FormControlLabel, Skeleton,
} from '@mui/material';
import {
  Search as SearchIcon, Close as CloseIcon, Add as AddIcon, UploadFile as ImportIcon, QrCode2 as BarcodeIcon,
  FileDownload as ExportIcon, Inventory2 as ProductsIcon, Layers as QtyIcon, WarningAmber as LowIcon,
  RemoveShoppingCart as OutIcon, ShoppingCart as PurchaseValueIcon, Sell as SellValueIcon, Tune as AdjustIcon,
  EditNote as QuickIcon, History as HistoryIcon, MoreVert as MoreIcon, Check as SaveIcon, Undo as CancelIcon,
  ViewColumn as ColumnsIcon, RestartAlt as ResetIcon, FilterAltOff as ClearFilterIcon, ContentCopy as CopyIcon,
  OpenInNew as OpenIcon, QrCodeScanner as ScanIcon, Refresh as RefreshIcon,
} from '@mui/icons-material';
import axios from 'axios';
import BarcodePrintDialog from '../components/inventory/BarcodePrintDialog';
import ProductMasterDialog from '../components/inventory/ProductMasterDialog';
import ExcelImportManager from '../components/admin/import/ExcelImportManager';
import StockAdjustDialog from '../components/purchasing/stock/StockAdjustDialog';
import StockHistoryDrawer from '../components/purchasing/stock/StockHistoryDrawer';
import {
  fetchStockPage, fetchStockSummary, fetchStockFacets, lookupCode, updateStockFields, adjustStock, newClientToken,
  downloadStockExport, normalizeBlobError, filterParams, STATUS_META, formatMoney, formatQty, formatDate,
} from '../components/purchasing/stock/stockApi';
import useBarcodeScanner from '../hooks/useBarcodeScanner';
import { useDebounce } from '../hooks/useDebounce';
import { apiErrorMessage } from '../utils/apiError';
import { notify } from '../utils/notify';

const BLANK_FILTERS = { brand: '', category: '', rack: '', supplier: '', variant_group: '', status: '' };
const COLS_KEY = 'stock_overview_hidden_columns';
const PAGE_SIZE_KEY = 'stock_overview_page_size';

const readStored = (key, fallback) => {
  try { const v = JSON.parse(localStorage.getItem(key)); return v ?? fallback; } catch { return fallback; }
};
const writeStored = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ } };

const FIELD_LABELS = {
  sku: 'Item code', barcode: 'Barcode', secondary_barcode: 'Barcode 2', name: 'Product name', brand: 'Brand',
  category: 'Category', model_no: 'Frame model', color: 'Colour', size: 'Size', supplier_name: 'Supplier / Vendor',
  cost_price: 'Purchase cost', retail_price: 'Selling price', mrp: 'MRP', minimum_stock: 'Low stock alert',
  rack_location: 'Rack', bin_location: 'Shelf', unit: 'UOM', stock: 'Current stock',
};
const MONEY_FIELDS = ['cost_price', 'retail_price', 'mrp'];
const INT_FIELDS = ['stock', 'minimum_stock'];
const TEXT_MAX = {
  sku: 150, barcode: 150, secondary_barcode: 150, name: 255, brand: 150, category: 150, model_no: 150,
  color: 100, size: 100, supplier_name: 150, rack_location: 150, bin_location: 150,
};
// Capability (from /facets/ permissions) needed to edit each field.
const FIELD_PERM = {
  sku: 'edit_details', barcode: 'edit_details', secondary_barcode: 'edit_details', name: 'edit_details',
  brand: 'edit_details', category: 'edit_details', model_no: 'edit_details', color: 'edit_details',
  size: 'edit_details', supplier_name: 'edit_details',
  rack_location: 'edit_location', bin_location: 'edit_location', minimum_stock: 'edit_location', unit: 'edit_location',
  cost_price: 'edit_prices', retail_price: 'edit_prices', mrp: 'edit_prices',
  stock: 'adjust_stock',
};
const canEditField = (caps, f) => Boolean(caps[FIELD_PERM[f]]) && (f !== 'cost_price' || Boolean(caps.view_cost));

// Column catalogue. `edit` = inline editor kind; `w` = relative width (the table is laid out to
// the screen width, so all columns share one view); `list` = facets key offered as suggestions.
const COLUMNS = [
  { key: 'sku', label: 'Item Code', sort: 'sku', mono: true, always: true, w: 58, edit: 'text' },
  { key: 'barcode', label: 'Barcode', sort: 'barcode', mono: true, w: 72, edit: 'text' },
  { key: 'secondary_barcode', label: 'Barcode 2', mono: true, w: 58, edit: 'text' },
  { key: 'name', label: 'Product Name', sort: 'name', always: true, w: 96, edit: 'text' },
  { key: 'brand', label: 'Brand', sort: 'brand', w: 52, edit: 'text', list: 'brands' },
  { key: 'category', label: 'Category', sort: 'category', w: 56, edit: 'text', list: 'categories' },
  { key: 'model_no', label: 'Frame Model', w: 50, edit: 'text' },
  { key: 'variant', label: 'Variant', w: 54, edit: 'variant' },
  { key: 'rack_location', label: 'Rack', sort: 'rack', w: 36, edit: 'text', list: 'racks' },
  { key: 'bin_location', label: 'Shelf', sort: 'bin', w: 38, edit: 'text' },
  { key: 'stock', label: 'Current Stock', sort: 'stock', align: 'right', always: true, w: 50, edit: 'int' },
  { key: 'status', label: 'Status', w: 46 },
  { key: 'minimum_stock', label: 'Low Stock Alert', sort: 'minimum_stock', align: 'right', w: 40, edit: 'int' },
  { key: 'uom', label: 'UOM', w: 40, edit: 'unit' },
  { key: 'cost_price', label: 'Purchase Cost ₹', sort: 'cost_price', align: 'right', w: 58, edit: 'money', costOnly: true },
  { key: 'retail_price', label: 'Selling Price ₹', sort: 'retail_price', align: 'right', w: 52, edit: 'money' },
  { key: 'mrp', label: 'MRP ₹', sort: 'mrp', align: 'right', w: 50, edit: 'money' },
  { key: 'supplier_name', label: 'Supplier / Vendor', w: 64, edit: 'text', list: 'suppliers' },
  { key: 'last_purchase_date', label: 'Last Purchase', sort: 'last_purchase_date', w: 58 },
];
// The row fields a column edits.
const colFields = (c) => (c.key === 'variant' ? ['color', 'size'] : c.key === 'uom' ? ['unit'] : [c.key]);
const CHECK_W = 28;
const ACTIONS_W = 54;

// Right + bottom lines only (separate borders), so the boxed grid adds no width past 100%.
const gridLine = {
  borderBottom: '1px solid', borderRight: '1px solid', borderColor: 'divider', '&:last-of-type': { borderRight: 0 },
};
const cellSx = {
  ...gridLine, py: 0.4, px: 0.5, fontSize: 11.5, lineHeight: 1.25, verticalAlign: 'middle',
  whiteSpace: 'normal', overflowWrap: 'anywhere',
};
const headSx = {
  ...cellSx, py: 0.6, px: 0.4, fontWeight: 800, fontSize: 10.5, lineHeight: 1.15, color: 'text.secondary',
  verticalAlign: 'bottom', overflowWrap: 'normal', wordBreak: 'normal',
  bgcolor: (t) => (t.palette.mode === 'dark' ? t.palette.grey[900] : '#f1f5f9'),
  '& .MuiTableSortLabel-root': { display: 'inline' },
  '& .MuiTableSortLabel-icon': { fontSize: 12, ml: 0.1, mr: 0, verticalAlign: 'middle' },
  '& .MuiTableSortLabel-root:not(.Mui-active) .MuiTableSortLabel-icon': { display: 'none' },
};
// Paise only when there are any, so amounts stay on one line in the narrow money columns.
const amount = (v) => {
  if (v === null || v === undefined || v === '') return '—';
  const n = Number(v);
  return n.toLocaleString('en-IN', { minimumFractionDigits: Number.isInteger(n) ? 0 : 2, maximumFractionDigits: 2 });
};
const shortDate = (iso) => {
  if (!iso) return '—';
  const d = new Date(iso.length <= 10 ? `${iso}T00:00:00` : iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: '2-digit' });
};
const previewStatus = (stock, min) => {
  const s = Number(stock) || 0;
  if (s <= 0) return 'out';
  return s <= (Number(min) || 0) ? 'low' : 'in';
};
const OTHER_REASON = 'Other';

function SummaryCard({ icon, label, value, tone = '#6366f1', loading, hint }) {
  return (
    <Card variant="outlined" sx={{ p: 1.75, borderRadius: 3, display: 'flex', gap: 1.5, alignItems: 'center', minWidth: 0 }}>
      <Box sx={{ width: 40, height: 40, borderRadius: 2, display: 'grid', placeItems: 'center', bgcolor: `${tone}1a`, color: tone, flexShrink: 0 }}>
        {icon}
      </Box>
      <Box sx={{ minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary" fontWeight={700} noWrap component="div">{label}</Typography>
        {loading ? <Skeleton width={90} height={30} /> : (
          <Tooltip title={hint || ''}><Typography variant="h6" fontWeight={800} noWrap sx={{ lineHeight: 1.3 }}>{value}</Typography></Tooltip>
        )}
      </Box>
    </Card>
  );
}

function StatusChip({ status, preview }) {
  const meta = STATUS_META[status] || STATUS_META.in;
  return (
    <Box component="span" title={preview ? 'Updates from the stock and low stock alert you enter' : meta.label}
      sx={{
        display: 'inline-block', px: 0.5, py: 0.1, borderRadius: 1, fontSize: 10, fontWeight: 800, lineHeight: 1.2,
        textAlign: 'center', overflowWrap: 'normal', color: meta.color, bgcolor: meta.bg, border: `1px ${preview ? 'dashed' : 'solid'} ${meta.border}`,
      }}>
      {meta.label}
    </Box>
  );
}

const rowToEditValues = (row) => ({
  sku: row.sku || '', barcode: row.barcode || '', secondary_barcode: row.secondary_barcode || '',
  name: row.name || '', brand: row.brand || '', category: row.category || '', model_no: row.model_no || '',
  color: row.color || '', size: row.size || '', supplier_name: row.own_supplier_name || '',
  cost_price: row.cost_price ?? '', retail_price: row.retail_price ?? '', mrp: row.mrp ?? '',
  stock: String(row.stock ?? 0), minimum_stock: String(row.minimum_stock ?? ''),
  rack_location: row.rack_location || '', bin_location: row.bin_location || '', unit: row.unit || '',
});

const sameValue = (field, a, b) => {
  if (MONEY_FIELDS.includes(field)) return (Number(a) || 0) === (Number(b) || 0);
  if (field === 'unit') return (a || '') === (b || '');
  return String(a ?? '').trim() === String(b ?? '').trim();
};

function validateEdit(values, editable) {
  const errors = {};
  editable.forEach((f) => {
    const v = String(values[f] ?? '').trim();
    if (MONEY_FIELDS.includes(f)) {
      if (v !== '' && (!/^\d+(\.\d{0,2})?$/.test(v))) errors[f] = 'Number ≥ 0, up to 2 decimals';
    } else if (INT_FIELDS.includes(f)) {
      if (!/^\d+$/.test(v)) errors[f] = 'Whole number ≥ 0';
    } else if (TEXT_MAX[f] && v.length > TEXT_MAX[f]) {
      errors[f] = `Max ${TEXT_MAX[f]} characters`;
    }
  });
  if (editable.includes('sku') && !String(values.sku || '').trim()) errors.sku = 'Required';
  if (editable.includes('name') && !String(values.name || '').trim()) errors.name = 'Required';
  const bc = String(values.barcode || '').trim();
  if (editable.includes('secondary_barcode') && bc && bc === String(values.secondary_barcode || '').trim()) {
    errors.secondary_barcode = 'Same as Barcode';
  }
  const sp = Number(values.retail_price) || 0;
  const mrp = Number(values.mrp) || 0;
  if (editable.includes('retail_price') && mrp > 0 && sp > mrp) errors.retail_price = 'More than MRP';
  return errors;
}

export default function StockOverview() {
  const navigate = useNavigate();
  const searchRef = useRef(null);
  const tableRef = useRef(null);

  const [facets, setFacets] = useState(null);
  const [facetsError, setFacetsError] = useState('');
  const caps = facets?.permissions || {};

  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [appliedSearch, setAppliedSearch] = useState('');
  const [code, setCode] = useState(''); // exact scan filter
  const [filters, setFilters] = useState(BLANK_FILTERS);
  const [ordering, setOrdering] = useState('name');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(() => readStored(PAGE_SIZE_KEY, 50));
  const [refreshKey, setRefreshKey] = useState(0);

  const [data, setData] = useState({ count: 0, results: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [summary, setSummary] = useState(null);
  const [summaryLoading, setSummaryLoading] = useState(true);

  const [selected, setSelected] = useState(() => new Map());
  const [highlightId, setHighlightId] = useState('');
  const [hidden, setHidden] = useState(() => new Set(readStored(COLS_KEY, [])));
  const [colsAnchor, setColsAnchor] = useState(null);
  const [exportAnchor, setExportAnchor] = useState(null);
  const [exporting, setExporting] = useState(false);
  const [moreMenu, setMoreMenu] = useState({ anchor: null, row: null });

  const [editing, setEditing] = useState(null); // { id, values, original, errors, focus }
  const [confirmEdit, setConfirmEdit] = useState(null); // { row, changes, original, stock: { from, to } | null, token }
  const [adjReason, setAdjReason] = useState({ reason: '', other: '', reference: '' });
  const [savingEdit, setSavingEdit] = useState(false);
  const [adjust, setAdjust] = useState({ open: false, row: null, qty: undefined });
  const [historyRow, setHistoryRow] = useState(null);
  const [historyKey, setHistoryKey] = useState(0);
  const [printRows, setPrintRows] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const [suppliersForAdd, setSuppliersForAdd] = useState([]);

  // Typing applies after a short pause; the Search button / Enter applies at once.
  useEffect(() => { setAppliedSearch(debouncedSearch.trim()); }, [debouncedSearch]);

  const params = useMemo(() => filterParams({ q: appliedSearch, code, ...filters }), [appliedSearch, code, filters]);
  const filtersActive = Object.keys(params).length > 0;

  useEffect(() => { setPage(0); }, [params]);

  // ---- facets (filter options + permissions) ---------------------------------------------
  const loadFacets = useCallback(() => {
    fetchStockFacets()
      .then((f) => { setFacets(f); setFacetsError(''); })
      .catch((err) => setFacetsError(apiErrorMessage(err, 'Could not load filter options.')));
  }, []);
  useEffect(() => { loadFacets(); }, [loadFacets]);

  // ---- list + summary --------------------------------------------------------------------
  useEffect(() => {
    const ctl = new AbortController();
    setLoading(true);
    setError('');
    fetchStockPage({ ...params, ordering, page: page + 1, page_size: pageSize }, ctl.signal)
      .then((d) => setData({ count: d.count || 0, results: d.results || [] }))
      .catch((err) => {
        if (ctl.signal.aborted) return;
        if (err?.response?.status === 404 && page > 0) { setPage(0); return; } // page beyond the end
        setError(apiErrorMessage(err, 'Could not load stock.'));
      })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [params, ordering, page, pageSize, refreshKey]);

  useEffect(() => {
    const ctl = new AbortController();
    setSummaryLoading(true);
    fetchStockSummary(params, ctl.signal)
      .then(setSummary)
      .catch(() => { if (!ctl.signal.aborted) setSummary(null); })
      .finally(() => { if (!ctl.signal.aborted) setSummaryLoading(false); });
    return () => ctl.abort();
  }, [params, refreshKey]);

  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);

  // Other screens (Product Master, Excel import, Purchase Entry) announce stock changes.
  useEffect(() => {
    const onChange = () => { refresh(); loadFacets(); };
    window.addEventListener('optical_stock_updated', onChange);
    return () => window.removeEventListener('optical_stock_updated', onChange);
  }, [refresh, loadFacets]);

  const replaceRow = useCallback((row) => {
    setData((d) => ({ ...d, results: d.results.map((r) => (r.id === row.id ? row : r)) }));
    setSelected((m) => (m.has(row.id) ? new Map(m).set(row.id, row) : m));
  }, []);

  // ---- scanning / exact lookup -----------------------------------------------------------
  const runLookup = useCallback(async (raw) => {
    const value = String(raw || '').trim();
    if (!value) return;
    try {
      const res = await lookupCode(value);
      if (res.found) {
        setSearch('');
        setAppliedSearch('');
        setCode(value);
        setHighlightId(res.results[0].id);
        if (res.results.length === 1) notify(`Found ${res.results[0].name} — ${res.results[0].stock} in stock.`, 'success');
      } else {
        setCode('');
        setSearch(value);
        setAppliedSearch(value);
        notify(`No product scans as "${value}" — showing text matches instead.`, 'warning');
      }
    } catch (err) {
      notify(apiErrorMessage(err, 'Lookup failed.'), 'error');
    }
  }, []);

  useBarcodeScanner((scanned) => {
    if (adjust.open || historyRow || printRows || importOpen || addOpen || confirmEdit) return;
    runLookup(scanned);
  });

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (document.querySelector('.MuiDialog-root, .MuiDrawer-modal')) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- selection -------------------------------------------------------------------------
  const rows = data.results;
  const pageAllSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const pageSomeSelected = rows.some((r) => selected.has(r.id));
  const toggleRow = (row) => setSelected((m) => {
    const next = new Map(m);
    if (next.has(row.id)) next.delete(row.id); else next.set(row.id, row);
    return next;
  });
  const togglePage = () => setSelected((m) => {
    const next = new Map(m);
    if (pageAllSelected) rows.forEach((r) => next.delete(r.id)); else rows.forEach((r) => next.set(r.id, r));
    return next;
  });

  // ---- inline edit -----------------------------------------------------------------------
  const editableFields = useMemo(() => COLUMNS.filter((c) => c.edit).flatMap(colFields)
    .filter((f) => canEditField(caps, f)), [caps]);
  const canQuickEdit = editableFields.length > 0;

  const startEdit = (row, focus) => {
    if (!canQuickEdit) { notify('Your role cannot edit stock details.', 'warning'); return; }
    if (editing && editing.id !== row.id && hasChanges(editing)) {
      notify('Save or cancel the row you are editing first.', 'warning');
      return;
    }
    const values = rowToEditValues(row);
    setEditing({ id: row.id, values, original: { ...values }, errors: {}, focus });
  };
  const hasChanges = (ed) => ed && editableFields.some((f) => !sameValue(f, ed.values[f], ed.original[f]));
  const cancelEdit = () => { setEditing(null); setTimeout(() => tableRef.current?.querySelector(`[data-row-id="${editing?.id}"]`)?.focus(), 0); };

  const requestSave = () => {
    if (!editing) return;
    const row = rows.find((r) => r.id === editing.id);
    if (!row) { setEditing(null); return; }
    const errors = validateEdit(editing.values, editableFields);
    if (Object.keys(errors).length) { setEditing({ ...editing, errors }); return; }
    const changes = {};
    const original = {};
    let stock = null;
    editableFields.forEach((f) => {
      if (sameValue(f, editing.values[f], editing.original[f])) return;
      if (f === 'stock') { stock = { from: Number(editing.original.stock), to: Number(editing.values.stock) }; return; }
      const v = editing.values[f];
      changes[f] = f === 'unit' ? (v || null) : (typeof v === 'string' ? v.trim() : v);
      original[f] = editing.original[f] === '' && f === 'unit' ? null : editing.original[f];
    });
    if (!Object.keys(changes).length && !stock) { setEditing(null); notify('Nothing changed.', 'info'); return; }
    if (stock) setAdjReason({ reason: facets?.adjustment_reasons?.[0] || 'Physical stock count', other: '', reference: '' });
    setConfirmEdit({ row, changes, original, stock, token: newClientToken() });
  };

  const displayValue = (field, value) => {
    if (field === 'unit') return facets?.units?.find((u) => u.id === value)?.code || '—';
    if (MONEY_FIELDS.includes(field)) return value === '' || value === null ? '—' : formatMoney(value);
    return value === '' || value === null ? '—' : String(value);
  };

  const adjustReasonText = adjReason.reason === OTHER_REASON ? adjReason.other.trim() : adjReason.reason;

  // Field changes go first (PATCH); a stock change is then a ledgered adjustment. If the PATCH
  // landed but the adjustment didn't, the row keeps editing with the saved values as its base.
  const commitEdit = async () => {
    if (!confirmEdit) return;
    const { changes, original, stock, token } = confirmEdit;
    if (stock && !adjustReasonText) { notify('Give a reason for the stock change.', 'warning'); return; }
    setSavingEdit(true);
    let row = confirmEdit.row;
    let patched = false;
    try {
      if (Object.keys(changes).length) {
        row = await updateStockFields(row.id, changes, original);
        patched = true;
        replaceRow(row);
      }
      if (stock) {
        const res = await adjustStock(row.id, {
          new_quantity: stock.to, expected_stock: stock.from, reason: adjustReasonText,
          reference: adjReason.reference.trim(), client_token: token,
        });
        row = res.row;
        replaceRow(row);
        setHistoryKey((k) => k + 1);
      }
      setEditing(null);
      setConfirmEdit(null);
      setHighlightId(row.id);
      notify(stock ? `${row.name} updated — stock ${stock.from} → ${stock.to}.` : `${row.name} updated.`, 'success');
      refresh();
      if (changes.brand !== undefined || changes.category !== undefined || changes.rack_location !== undefined) loadFacets();
    } catch (err) {
      const d = err?.response?.data;
      const base = d?.row || (patched ? row : null);
      if (base) {
        replaceRow(base);
        const latest = rowToEditValues(base);
        const reset = Object.keys(d?.conflicts || {});
        setEditing((ed) => (ed ? { ...ed, original: latest, values: { ...ed.values, ...Object.fromEntries(reset.map((f) => [f, latest[f]])) } } : ed));
      }
      if (d?.errors) {
        const errors = { ...d.errors };
        if (errors.new_quantity) { errors.stock = errors.new_quantity; delete errors.new_quantity; }
        setEditing((ed) => (ed ? { ...ed, errors } : ed));
      }
      setConfirmEdit(null);
      const msg = d?.detail && err?.response?.status === 409 ? d.detail : apiErrorMessage(err, 'The changes were not saved.');
      notify(patched ? `Details saved, but the stock was not adjusted: ${msg}` : msg, 'error');
      if (patched) refresh();
    } finally {
      setSavingEdit(false);
    }
  };

  // ---- actions ---------------------------------------------------------------------------
  const openAdjust = (row, qty) => {
    if (!caps.adjust_stock) { notify('Your role cannot adjust stock.', 'warning'); return; }
    setAdjust({ open: true, row, qty });
  };
  const onAdjusted = (res) => {
    replaceRow(res.row);
    setAdjust({ open: false, row: null, qty: undefined });
    setHighlightId(res.row.id);
    const a = res.adjustment;
    notify(`${a.adjustment_number}: ${res.row.name} ${a.previous_quantity} → ${a.new_quantity} (${a.difference > 0 ? '+' : ''}${a.difference}).`, 'success');
    refresh();
    setHistoryKey((k) => k + 1);
  };

  const doExport = async (format) => {
    setExportAnchor(null);
    setExporting(true);
    try {
      await downloadStockExport({ ...params, ordering }, format);
      notify('Stock list exported.', 'success');
    } catch (err) {
      await normalizeBlobError(err);
      notify(apiErrorMessage(err, 'Export failed.'), 'error');
    } finally {
      setExporting(false);
    }
  };

  const openAddProduct = () => {
    setAddOpen(true);
    axios.get('/api/purchase/suppliers/', { params: { page_size: 1000 } })
      .then((r) => setSuppliersForAdd((r.data?.results || r.data || []).map((s) => ({ id: s.id, name: s.name }))))
      .catch(() => setSuppliersForAdd([]));
  };

  const copy = (text, what) => {
    if (!text) { notify(`No ${what} on this product.`, 'warning'); return; }
    navigator.clipboard?.writeText(text).then(() => notify(`${what} copied.`, 'success'), () => notify('Could not copy.', 'error'));
  };

  const resetAll = () => {
    setSearch(''); setAppliedSearch(''); setCode(''); setFilters(BLANK_FILTERS); setOrdering('name'); setPage(0);
  };
  const clearFilters = () => { setFilters(BLANK_FILTERS); setCode(''); };

  const setSort = (key) => setOrdering((o) => (o === key ? `-${key}` : key));

  const visibleColumns = COLUMNS.filter((c) => !hidden.has(c.key) && (!c.costOnly || caps.view_cost !== false));
  const totalW = CHECK_W + ACTIONS_W + visibleColumns.reduce((sum, c) => sum + c.w, 0);
  const toggleColumn = (key) => setHidden((h) => {
    const next = new Set(h);
    if (next.has(key)) next.delete(key); else next.add(key);
    writeStored(COLS_KEY, [...next]);
    return next;
  });

  // ---- row keyboard ----------------------------------------------------------------------
  // A scanner "types" a whole code within a few ms, so a letter shortcut only fires if no other
  // key follows it quickly — otherwise scanning an SKU like "P-102" would open Print.
  const lastKeyAt = useRef(0);
  const prevKeyAt = useRef(0);
  useEffect(() => {
    const mark = (e) => { prevKeyAt.current = lastKeyAt.current; lastKeyAt.current = e.timeStamp; };
    window.addEventListener('keydown', mark, true);
    return () => window.removeEventListener('keydown', mark, true);
  }, []);
  const letterShortcut = (e, fn) => {
    e.preventDefault();
    const at = e.timeStamp;
    setTimeout(() => { if (lastKeyAt.current === at) fn(); }, 90);
  };

  const onRowKeyDown = (e, row, index) => {
    if (e.target !== e.currentTarget) return; // keys inside an editor / button belong to it
    const focusRow = (i) => tableRef.current?.querySelectorAll('tbody tr[data-row-id]')[i]?.focus();
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(Math.min(index + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); if (index === 0) searchRef.current?.focus(); else focusRow(index - 1); }
    else if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      if (e.timeStamp - prevKeyAt.current < 60) return; // tail of a scanner burst — the scan handler takes it
      if (e.key === ' ') toggleRow(row); else startEdit(row);
    }
    else if (e.ctrlKey || e.metaKey || e.altKey) return;
    else if (e.key.toLowerCase() === 'a') letterShortcut(e, () => openAdjust(row));
    else if (e.key.toLowerCase() === 'h') letterShortcut(e, () => setHistoryRow(row));
    else if (e.key.toLowerCase() === 'p') letterShortcut(e, () => setPrintRows([row]));
  };

  // ---- cell rendering --------------------------------------------------------------------
  const renderInput = (col, field, row) => {
    const value = editing.values[field] ?? '';
    const err = editing.errors?.[field];
    const set = (v) => setEditing((ed) => ({ ...ed, values: { ...ed.values, [field]: v }, errors: { ...ed.errors, [field]: undefined } }));
    const onKeyDown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); requestSave(); }
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelEdit(); }
    };
    const numeric = col.edit === 'money' || col.edit === 'int';
    const common = {
      size: 'small', variant: 'outlined', error: Boolean(err), autoFocus: editing.focus === field, fullWidth: true,
      sx: {
        '& .MuiInputBase-root': { fontSize: 11.5, bgcolor: 'background.paper' },
        '& .MuiInputBase-input': { py: 0.35, px: 0.5, textAlign: numeric ? 'right' : 'left' },
        '& .MuiNativeSelect-select': { pr: '16px !important' },
        '& .MuiNativeSelect-icon': { right: 0, fontSize: 16 },
      },
    };
    const inputProps = {
      'aria-label': `${FIELD_LABELS[field]} for ${row.name}`, 'data-own-enter': 'true', onKeyDown,
      title: FIELD_LABELS[field],
    };
    let input;
    if (col.edit === 'unit') {
      input = (
        <TextField select {...common} value={value || ''} onChange={(e) => set(e.target.value)}
          SelectProps={{ native: true }} inputProps={inputProps}>
          <option value="">—</option>
          {(facets?.units || []).map((u) => <option key={u.id} value={u.id}>{u.code}</option>)}
        </TextField>
      );
    } else {
      const placeholder = field === 'supplier_name' ? (row.last_supplier_name || '') : col.edit === 'variant' ? FIELD_LABELS[field] : '';
      input = (
        <TextField {...common} value={value} onChange={(e) => set(e.target.value)} placeholder={placeholder}
          inputProps={{
            ...inputProps, inputMode: col.edit === 'money' ? 'decimal' : col.edit === 'int' ? 'numeric' : 'text',
            maxLength: TEXT_MAX[field] || 14, list: col.list ? `stock-dl-${col.list}` : undefined,
            spellCheck: col.mono ? false : undefined,
          }} />
      );
    }
    // Always wrapped: adding the Tooltip only on error would remount the input and drop focus.
    return (
      <Tooltip key={field} open={Boolean(err)} title={err || ''} placement="top" arrow disableHoverListener disableFocusListener disableTouchListener>
        {input}
      </Tooltip>
    );
  };

  const muted = (text = '—') => <Box component="span" sx={{ color: 'text.disabled' }}>{text}</Box>;

  const renderCell = (col, row) => {
    const isEditing = editing?.id === row.id;
    const fields = colFields(col).filter((f) => col.edit && canEditField(caps, f));
    if (isEditing && fields.length) {
      if (fields.length === 1) return renderInput(col, fields[0], row);
      return <Stack spacing={0.4}>{fields.map((f) => renderInput(col, f, row))}</Stack>;
    }
    switch (col.key) {
      case 'stock': {
        const meta = STATUS_META[row.status];
        return <Box component="span" sx={{ fontWeight: 800, color: meta?.color }}>{formatQty(row.stock)}</Box>;
      }
      case 'status':
        return isEditing
          ? <StatusChip preview status={previewStatus(editing.values.stock, editing.values.minimum_stock)} />
          : <StatusChip status={row.status} />;
      case 'cost_price': case 'retail_price': case 'mrp':
        return <span title={formatMoney(row[col.key])} style={{ whiteSpace: 'nowrap' }}>{amount(row[col.key])}</span>;
      case 'last_purchase_date': return <span title={formatDate(row.last_purchase_date)}>{shortDate(row.last_purchase_date)}</span>;
      case 'name': return (
        <Box title={row.variant_group_name ? `${row.name}\nGroup: ${row.variant_group_name}` : row.name}
          sx={{ fontWeight: 600, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
          {row.name}
        </Box>
      );
      case 'variant': {
        const text = [row.color, row.size].filter(Boolean).join(' / ');
        return text ? <span title={[row.frame_type, row.color, row.size].filter(Boolean).join(' / ')}>{text}</span> : muted();
      }
      case 'supplier_name':
        if (!row.own_supplier_name && row.last_supplier_name) {
          return <Box component="span" title="From the last purchase" sx={{ color: 'text.secondary' }}>{row.last_supplier_name}</Box>;
        }
        return row.supplier_name || muted();
      case 'minimum_stock': return formatQty(row.minimum_stock);
      default: return row[col.key] || muted();
    }
  };

  const onCellDoubleClick = (col, row) => {
    if (editing?.id === row.id) return;
    const field = colFields(col).find((f) => col.edit && canEditField(caps, f));
    if (field) startEdit(row, field);
    else if (col.key === 'stock') openAdjust(row);
  };

  const filterSelect = (key, label, options, width = 150) => (
    <TextField select size="small" label={label} value={filters[key]} sx={{ minWidth: width }}
      onChange={(e) => setFilters((f) => ({ ...f, [key]: e.target.value }))}>
      <MenuItem value="">All</MenuItem>
      {options}
    </TextField>
  );

  const selectedRows = [...selected.values()];
  const s = summary;

  return (
    <Box sx={{ p: { xs: 1.5, md: 2 }, pb: 6 }}>
      {/* Header */}
      <Breadcrumbs sx={{ mb: 0.5, fontSize: 13 }}>
        <Link component={RouterLink} to="/purchase/entry" underline="hover" color="inherit">Purchase</Link>
        <Typography color="text.primary" fontSize={13} fontWeight={700}>Stock Overview</Typography>
      </Breadcrumbs>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap', mb: 2.5 }}>
        <Box>
          <Typography variant="h4" fontWeight={800}>Stock Overview</Typography>
          <Typography variant="body2" color="text.secondary">View, search, and manage inventory stock in real time.</Typography>
        </Box>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Tooltip title="Reload from the database">
            <IconButton onClick={() => { refresh(); loadFacets(); }} aria-label="Refresh"><RefreshIcon /></IconButton>
          </Tooltip>
          {caps.edit_location && (
            <Button variant="contained" startIcon={<AddIcon />} onClick={openAddProduct} sx={{ backgroundColor: '#2563EB', fontWeight: 800 }}>
              Add Product
            </Button>
          )}
          {caps.import && (
            <Button variant="outlined" startIcon={<ImportIcon />} onClick={() => setImportOpen(true)} sx={{ fontWeight: 800 }}>
              Import Excel
            </Button>
          )}
          <Tooltip title={selected.size ? '' : 'Tick products in the table first'}>
            <span>
              <Button variant="outlined" startIcon={<BarcodeIcon />} disabled={!selected.size || !caps.print_barcode}
                onClick={() => setPrintRows(selectedRows)} sx={{ fontWeight: 800 }}>
                Print Barcode{selected.size ? ` (${selected.size})` : ''}
              </Button>
            </span>
          </Tooltip>
          {caps.export && (
            <Button variant="outlined" startIcon={exporting ? <CircularProgress size={16} /> : <ExportIcon />} disabled={exporting}
              onClick={(e) => setExportAnchor(e.currentTarget)} sx={{ fontWeight: 800 }}>
              Export
            </Button>
          )}
        </Stack>
      </Box>
      <Menu anchorEl={exportAnchor} open={Boolean(exportAnchor)} onClose={() => setExportAnchor(null)}>
        <MenuItem onClick={() => doExport('xlsx')}>Excel (.xlsx){filtersActive ? ' — filtered list' : ''}</MenuItem>
        <MenuItem onClick={() => doExport('csv')}>CSV (.csv){filtersActive ? ' — filtered list' : ''}</MenuItem>
      </Menu>

      {facetsError && <Alert severity="warning" sx={{ mb: 2 }}>{facetsError}</Alert>}

      {/* Summary cards */}
      <Box sx={{ display: 'grid', gap: 1.5, mb: 2, gridTemplateColumns: { xs: '1fr 1fr', md: 'repeat(3, 1fr)', lg: 'repeat(6, 1fr)' } }}>
        <SummaryCard icon={<ProductsIcon />} label="Total Products" tone="#6366f1" loading={summaryLoading && !s} value={s ? formatQty(s.total_products) : '—'} />
        <SummaryCard icon={<QtyIcon />} label="Total Stock Quantity" tone="#0ea5e9" loading={summaryLoading && !s} value={s ? formatQty(s.total_quantity) : '—'} />
        <SummaryCard icon={<LowIcon />} label="Low Stock Items" tone="#d97706" loading={summaryLoading && !s} value={s ? formatQty(s.low_stock) : '—'}
          hint="In stock but at or below the product's minimum alert level" />
        <SummaryCard icon={<OutIcon />} label="Out of Stock Items" tone="#dc2626" loading={summaryLoading && !s} value={s ? formatQty(s.out_of_stock) : '—'} />
        <SummaryCard icon={<PurchaseValueIcon />} label="Total Purchase Value" tone="#059669" loading={summaryLoading && !s}
          value={s ? (s.purchase_value === null ? 'Restricted' : formatMoney(s.purchase_value)) : '—'} hint="On-hand quantity × purchase cost" />
        <SummaryCard icon={<SellValueIcon />} label="Total Selling Value" tone="#7c3aed" loading={summaryLoading && !s}
          value={s ? formatMoney(s.selling_value) : '—'} hint="On-hand quantity × selling price" />
      </Box>
      {filtersActive && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: -1, mb: 1.5 }}>
          Totals reflect the current search and filters.
        </Typography>
      )}

      {/* Search + filters */}
      <Card variant="outlined" sx={{ p: 1.5, borderRadius: 3, mb: 1.5 }} data-nav-scope="stock-filters">
        <Stack direction="row" spacing={1.25} flexWrap="wrap" useFlexGap alignItems="center">
          <TextField
            inputRef={searchRef} size="small" value={search} sx={{ flex: '1 1 320px', minWidth: 240 }}
            placeholder="Scan or search barcode, SKU, name, brand, model, rack, bin…  ( / )"
            onChange={(e) => { setSearch(e.target.value); if (code) setCode(''); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); if (search.trim()) runLookup(search); }
              else if (e.key === 'Escape') { setSearch(''); setAppliedSearch(''); }
              else if (e.key === 'ArrowDown') { e.preventDefault(); tableRef.current?.querySelector('tbody tr[data-row-id]')?.focus(); }
            }}
            inputProps={{ 'aria-label': 'Search stock', 'data-own-enter': 'true' }}
            InputProps={{
              startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
              endAdornment: search ? (
                <InputAdornment position="end">
                  <IconButton size="small" aria-label="Clear search" onClick={() => { setSearch(''); setAppliedSearch(''); }}><CloseIcon fontSize="small" /></IconButton>
                </InputAdornment>
              ) : null,
            }}
          />
          <Button variant="contained" startIcon={<SearchIcon />} sx={{ fontWeight: 700 }}
            onClick={() => { setAppliedSearch(search.trim()); refresh(); }}>Search</Button>
          {filterSelect('status', 'Stock Status', [
            <MenuItem key="in" value="in">In Stock</MenuItem>,
            <MenuItem key="low" value="low">Low Stock</MenuItem>,
            <MenuItem key="out" value="out">Out of Stock</MenuItem>,
          ], 140)}
          {filterSelect('brand', 'Brand', (facets?.brands || []).map((b) => <MenuItem key={b} value={b}>{b}</MenuItem>))}
          {filterSelect('category', 'Category', (facets?.categories || []).map((c) => <MenuItem key={c} value={c}>{c}</MenuItem>))}
          {filterSelect('rack', 'Rack', (facets?.racks || []).map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>), 120)}
          {filterSelect('supplier', 'Supplier', (facets?.suppliers || []).map((x) => <MenuItem key={x.id} value={x.id}>{x.name}</MenuItem>), 160)}
          {filterSelect('variant_group', 'Variant', [
            <MenuItem key="any" value="any">Any variant product</MenuItem>,
            <MenuItem key="none" value="none">Stand-alone products</MenuItem>,
            ...(facets?.variant_groups || []).map((g) => <MenuItem key={g.id} value={g.id}>{g.name} ({g.count})</MenuItem>),
          ], 150)}
          <Button startIcon={<ClearFilterIcon />} onClick={clearFilters} disabled={!Object.values(filters).some(Boolean) && !code}>Clear Filter</Button>
          <Button startIcon={<ResetIcon />} onClick={resetAll}>Reset</Button>
        </Stack>
        {code && (
          <Box sx={{ mt: 1 }}>
            <Chip icon={<ScanIcon />} color="primary" variant="outlined" label={`Scanned code: ${code}`} onDelete={() => setCode('')} />
          </Box>
        )}
      </Card>

      {/* Table toolbar */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.75, minHeight: 32, flexWrap: 'wrap' }}>
        <Typography variant="body2" color="text.secondary">
          {loading ? 'Loading…' : `${formatQty(data.count)} product${data.count === 1 ? '' : 's'}`}
          {selected.size ? ` · ${selected.size} selected` : ''}
        </Typography>
        {selected.size > 0 && <Button size="small" onClick={() => setSelected(new Map())}>Clear selection</Button>}
        <Box sx={{ flex: 1 }} />
        <Typography variant="caption" color="text.secondary" sx={{ display: { xs: 'none', lg: 'block' } }}>
          ↑↓ rows · Space select · Enter / double-click edit row · A adjust · H history · P print
        </Typography>
        <Button size="small" startIcon={<ColumnsIcon />} onClick={(e) => setColsAnchor(e.currentTarget)}>Columns</Button>
      </Box>
      <Menu anchorEl={colsAnchor} open={Boolean(colsAnchor)} onClose={() => setColsAnchor(null)}>
        {COLUMNS.filter((c) => !c.always && (!c.costOnly || caps.view_cost)).map((c) => (
          <MenuItem key={c.key} dense onClick={() => toggleColumn(c.key)}>
            <FormControlLabel sx={{ m: 0, pointerEvents: 'none' }} control={<Checkbox size="small" checked={!hidden.has(c.key)} />} label={c.label} />
          </MenuItem>
        ))}
      </Menu>

      {error && <Alert severity="error" sx={{ mb: 1.5 }} action={<Button color="inherit" size="small" onClick={refresh}>Retry</Button>}>{error}</Alert>}

      {/* Suggestions for the free-text editors (typed values not in the list are allowed). */}
      <datalist id="stock-dl-brands">{(facets?.brands || []).map((b) => <option key={b} value={b} />)}</datalist>
      <datalist id="stock-dl-categories">{(facets?.categories || []).map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="stock-dl-racks">{(facets?.racks || []).map((r) => <option key={r} value={r} />)}</datalist>
      <datalist id="stock-dl-suppliers">{(facets?.suppliers || []).map((x) => <option key={x.id} value={x.name} />)}</datalist>

      <Card variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
        {loading && <LinearProgress sx={{ height: 2 }} />}
        <TableContainer ref={tableRef} sx={{ maxHeight: 'calc(100vh - 230px)', minHeight: 240 }} data-own-enter="true">
          {/* Fixed layout + percentage widths: every column shares the screen width instead of
              pushing the table sideways; long values wrap inside their box. */}
          <Table size="small" stickyHeader aria-label="Stock overview"
            sx={{ tableLayout: 'fixed', width: '100%', minWidth: 900, borderCollapse: 'separate', borderSpacing: 0 }}>
            <colgroup>
              <col style={{ width: `${(CHECK_W / totalW) * 100}%` }} />
              {visibleColumns.map((c) => <col key={c.key} style={{ width: `${(c.w / totalW) * 100}%` }} />)}
              <col style={{ width: `${(ACTIONS_W / totalW) * 100}%` }} />
            </colgroup>
            <TableHead>
              <TableRow>
                <TableCell padding="none" sx={{ ...headSx, px: 0, textAlign: 'center', overflow: 'hidden' }}>
                  <Checkbox size="small" sx={{ p: 0.25 }} checked={pageAllSelected} indeterminate={!pageAllSelected && pageSomeSelected}
                    onChange={togglePage} inputProps={{ 'aria-label': 'Select all on this page' }} />
                </TableCell>
                {visibleColumns.map((c) => (
                  <TableCell key={c.key} align={c.align || 'left'} sx={headSx}
                    title={c.edit ? `${c.label} — double-click a cell to edit` : `${c.label} (calculated, not editable)`}
                    sortDirection={ordering.replace('-', '') === c.sort ? (ordering.startsWith('-') ? 'desc' : 'asc') : false}>
                    {c.sort ? (
                      <TableSortLabel active={ordering.replace('-', '') === c.sort}
                        direction={ordering === `-${c.sort}` ? 'desc' : 'asc'} onClick={() => setSort(c.sort)}>
                        {c.label}
                      </TableSortLabel>
                    ) : c.label}
                  </TableCell>
                ))}
                <TableCell align="center" sx={{ ...headSx, px: 0.25, overflow: 'hidden' }}>Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, index) => {
                const isEditing = editing?.id === row.id;
                const isSelected = selected.has(row.id);
                const tint = row.status === 'out' ? 'rgba(220,38,38,0.045)' : row.status === 'low' ? 'rgba(217,119,6,0.06)' : undefined;
                return (
                  <TableRow
                    key={row.id} hover tabIndex={0} data-row-id={row.id} selected={isSelected}
                    onKeyDown={(e) => onRowKeyDown(e, row, index)}
                    sx={{
                      bgcolor: isEditing ? 'action.selected' : tint,
                      outline: highlightId === row.id ? '2px solid' : 'none', outlineColor: 'primary.light', outlineOffset: -2,
                      '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                      boxShadow: `inset 3px 0 0 ${STATUS_META[row.status]?.border || 'transparent'}`,
                    }}>
                    <TableCell padding="none" sx={{ ...cellSx, px: 0, textAlign: 'center', overflow: 'hidden' }}>
                      <Checkbox size="small" sx={{ p: 0.25 }} checked={isSelected} onChange={() => toggleRow(row)}
                        inputProps={{ 'aria-label': `Select ${row.name}` }} tabIndex={-1} />
                    </TableCell>
                    {visibleColumns.map((c) => (
                      <TableCell key={c.key} align={c.align || 'left'} onDoubleClick={() => onCellDoubleClick(c, row)}
                        sx={{
                          ...cellSx, px: isEditing && c.edit ? 0.25 : cellSx.px,
                          fontFamily: c.mono ? 'ui-monospace, Consolas, monospace' : undefined, fontSize: c.mono ? 11 : cellSx.fontSize,
                          cursor: !isEditing && c.edit ? 'cell' : undefined,
                        }}>
                        {renderCell(c, row)}
                      </TableCell>
                    ))}
                    <TableCell align="center" sx={{ ...cellSx, px: 0, py: 0.15, overflow: 'hidden' }}>
                      {isEditing ? (
                        <Stack direction="row" spacing={0} justifyContent="center">
                          <Tooltip title="Save (Enter)">
                            <IconButton size="small" color="primary" onClick={requestSave} aria-label={`Save ${row.name}`} sx={{ p: 0.4 }}><SaveIcon fontSize="small" /></IconButton>
                          </Tooltip>
                          <Tooltip title="Cancel (Esc)">
                            <IconButton size="small" onClick={cancelEdit} aria-label="Cancel editing" sx={{ p: 0.4 }}><CancelIcon fontSize="small" /></IconButton>
                          </Tooltip>
                        </Stack>
                      ) : (
                        <Stack direction="row" spacing={0} justifyContent="center">
                          <Tooltip title="Edit row (Enter)"><span>
                            <IconButton size="small" tabIndex={-1} disabled={!canQuickEdit} onClick={() => startEdit(row)} aria-label={`Edit ${row.name}`} sx={{ p: 0.4 }}><QuickIcon fontSize="small" /></IconButton>
                          </span></Tooltip>
                          <Tooltip title="Adjust stock, history, print barcode…">
                            <IconButton size="small" tabIndex={-1} onClick={(e) => setMoreMenu({ anchor: e.currentTarget, row })} aria-label={`More actions for ${row.name}`} sx={{ p: 0.4 }}><MoreIcon fontSize="small" /></IconButton>
                          </Tooltip>
                        </Stack>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && rows.length === 0 && !error && (
                <TableRow>
                  <TableCell colSpan={visibleColumns.length + 2} sx={{ py: 8, textAlign: 'center', color: 'text.secondary' }}>
                    {filtersActive ? (
                      <>No products match this search or these filters. <Button size="small" onClick={resetAll}>Reset</Button></>
                    ) : 'No active products in the catalogue yet. Add products or import them from Excel.'}
                  </TableCell>
                </TableRow>
              )}
              {loading && rows.length === 0 && Array.from({ length: 8 }, (_, i) => (
                <TableRow key={`sk-${i}`}>
                  <TableCell colSpan={visibleColumns.length + 2} sx={cellSx}><Skeleton height={22} /></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination component="div" count={data.count} page={page} rowsPerPage={pageSize}
          rowsPerPageOptions={[25, 50, 100, 200, 500]} onPageChange={(_, p) => setPage(p)}
          onRowsPerPageChange={(e) => { const n = parseInt(e.target.value, 10); setPageSize(n); writeStored(PAGE_SIZE_KEY, n); setPage(0); }}
          showFirstButton showLastButton />
      </Card>

      {/* More actions */}
      <Menu anchorEl={moreMenu.anchor} open={Boolean(moreMenu.anchor)} onClose={() => setMoreMenu({ anchor: null, row: null })}>
        {(() => {
          const row = moreMenu.row;
          if (!row) return null;
          const close = (fn) => () => { setMoreMenu({ anchor: null, row: null }); fn(); };
          return [
            <MenuItem key="adj" disabled={!caps.adjust_stock} onClick={close(() => openAdjust(row))}><ListItemIcon><AdjustIcon fontSize="small" /></ListItemIcon><ListItemText secondary="A">Adjust stock (with reason)</ListItemText></MenuItem>,
            <MenuItem key="his" onClick={close(() => setHistoryRow(row))}><ListItemIcon><HistoryIcon fontSize="small" /></ListItemIcon><ListItemText secondary="H">View stock history</ListItemText></MenuItem>,
            <MenuItem key="prn" onClick={close(() => setPrintRows([row]))}><ListItemIcon><BarcodeIcon fontSize="small" /></ListItemIcon><ListItemText secondary="P">Print barcode</ListItemText></MenuItem>,
            <Divider key="d0" />,
            <MenuItem key="sel" onClick={close(() => toggleRow(row))}>
              <ListItemIcon><Checkbox size="small" checked={selected.has(row.id)} sx={{ p: 0 }} /></ListItemIcon>
              <ListItemText>{selected.has(row.id) ? 'Remove from selection' : 'Add to selection'}</ListItemText>
            </MenuItem>,
            <Divider key="d1" />,
            <MenuItem key="sku" onClick={close(() => copy(row.sku, 'SKU'))}><ListItemIcon><CopyIcon fontSize="small" /></ListItemIcon><ListItemText>Copy SKU</ListItemText></MenuItem>,
            <MenuItem key="bc" onClick={close(() => copy(row.barcode, 'Barcode'))}><ListItemIcon><CopyIcon fontSize="small" /></ListItemIcon><ListItemText>Copy barcode</ListItemText></MenuItem>,
            <Divider key="d2" />,
            <MenuItem key="pe" onClick={close(() => navigate('/purchase/entry'))}><ListItemIcon><OpenIcon fontSize="small" /></ListItemIcon><ListItemText>New Purchase Entry</ListItemText></MenuItem>,
            <MenuItem key="inv" onClick={close(() => navigate('/inventory/products'))}><ListItemIcon><OpenIcon fontSize="small" /></ListItemIcon><ListItemText>Open in Inventory → Products</ListItemText></MenuItem>,
          ];
        })()}
      </Menu>

      {/* Confirm inline edit */}
      <Dialog open={Boolean(confirmEdit)} onClose={savingEdit ? undefined : () => setConfirmEdit(null)} maxWidth="sm" fullWidth>
        <Box component="form" data-nav-scope="stock-confirm" onSubmit={(e) => { e.preventDefault(); commitEdit(); }}>
          <DialogTitle sx={{ fontWeight: 800 }}>Save changes?</DialogTitle>
          <DialogContent>
            <Typography variant="body2" fontWeight={700} gutterBottom>{confirmEdit?.row.name}</Typography>
            <Table size="small">
              <TableBody>
                {confirmEdit && Object.keys(confirmEdit.changes).map((f) => (
                  <TableRow key={f}>
                    <TableCell sx={{ ...cellSx, fontWeight: 700 }}>{FIELD_LABELS[f]}</TableCell>
                    <TableCell sx={{ ...cellSx, color: 'text.secondary' }}>{displayValue(f, confirmEdit.original[f])}</TableCell>
                    <TableCell sx={cellSx}>→</TableCell>
                    <TableCell sx={{ ...cellSx, fontWeight: 800 }}>{displayValue(f, confirmEdit.changes[f])}</TableCell>
                  </TableRow>
                ))}
                {confirmEdit?.stock && (
                  <TableRow>
                    <TableCell sx={{ ...cellSx, fontWeight: 700 }}>{FIELD_LABELS.stock}</TableCell>
                    <TableCell sx={{ ...cellSx, color: 'text.secondary' }}>{formatQty(confirmEdit.stock.from)}</TableCell>
                    <TableCell sx={cellSx}>→</TableCell>
                    <TableCell sx={{ ...cellSx, fontWeight: 800 }}>
                      {formatQty(confirmEdit.stock.to)}{' '}
                      <Box component="span" sx={{ color: confirmEdit.stock.to > confirmEdit.stock.from ? 'success.main' : 'error.main' }}>
                        ({confirmEdit.stock.to > confirmEdit.stock.from ? '+' : ''}{confirmEdit.stock.to - confirmEdit.stock.from})
                      </Box>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            {confirmEdit?.stock ? (
              <Stack spacing={1.25} sx={{ mt: 2 }}>
                <Typography variant="caption" color="text.secondary">
                  The stock change is recorded as a stock adjustment in the ledger (with this reason), not overwritten.
                </Typography>
                <TextField select size="small" label="Reason for stock change" required value={adjReason.reason}
                  onChange={(e) => setAdjReason((r) => ({ ...r, reason: e.target.value }))}>
                  {[...new Set([...(facets?.adjustment_reasons || []), OTHER_REASON])].map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
                </TextField>
                {adjReason.reason === OTHER_REASON && (
                  <TextField size="small" label="Describe the reason" required value={adjReason.other} inputProps={{ maxLength: 500 }}
                    onChange={(e) => setAdjReason((r) => ({ ...r, other: e.target.value }))} />
                )}
                <TextField size="small" label="Reference (optional)" value={adjReason.reference} inputProps={{ maxLength: 100 }}
                  onChange={(e) => setAdjReason((r) => ({ ...r, reference: e.target.value }))} />
              </Stack>
            ) : (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
                Stock quantity is not affected by these changes.
              </Typography>
            )}
          </DialogContent>
          <DialogActions sx={{ px: 3, pb: 2 }}>
            <Button onClick={() => setConfirmEdit(null)} disabled={savingEdit}>Back</Button>
            <Button type="submit" variant="contained" autoFocus disabled={savingEdit} sx={{ fontWeight: 800 }}
              startIcon={savingEdit ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}>
              {savingEdit ? 'Saving…' : 'Confirm & Save'}
            </Button>
          </DialogActions>
        </Box>
      </Dialog>

      <StockAdjustDialog open={adjust.open} row={adjust.row} initialQuantity={adjust.qty}
        reasons={facets?.adjustment_reasons || []}
        onClose={() => setAdjust({ open: false, row: null, qty: undefined })}
        onSaved={onAdjusted} onStale={replaceRow} />

      <StockHistoryDrawer open={Boolean(historyRow)} row={historyRow} refreshKey={historyKey} onClose={() => setHistoryRow(null)} />

      <BarcodePrintDialog open={Boolean(printRows)} products={printRows || []} workflow="inventory"
        onClose={() => setPrintRows(null)} />

      <Dialog open={importOpen} onClose={() => { setImportOpen(false); refresh(); loadFacets(); }} fullWidth maxWidth="xl"
        PaperProps={{ sx: { height: '92vh' } }}>
        <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center' }}>
          Import Products from Excel
          <Box sx={{ flex: 1 }} />
          <IconButton aria-label="Close import" onClick={() => { setImportOpen(false); refresh(); loadFacets(); }}><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ p: 0 }}>
          {importOpen && <ExcelImportManager />}
        </DialogContent>
      </Dialog>

      <ProductMasterDialog open={addOpen} onClose={() => setAddOpen(false)} suppliers={suppliersForAdd}
        onCreated={() => { setAddOpen(false); refresh(); loadFacets(); }} />
    </Box>
  );
}
