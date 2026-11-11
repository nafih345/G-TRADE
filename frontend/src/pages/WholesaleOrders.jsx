// Wholesale Distribution → Wholesale Orders  (/wholesale/orders)
//                        → Quotations        (/wholesale/quotations)
//
// One screen for both document kinds (prop `kind`): a list with search / status / date filters
// and an editor (dealer + product picker with live available stock + line grid).
//
//   Order      Confirm Order → WO-YYYY-NNNN, CONFIRMED, reserves stock (Stock Overview "Ordered").
//              Edit while CONFIRMED. "Order to Sale" opens the Wholesale POS with it loaded
//              (/wholesale/pos?order=<id>); the bill closes it (BILLED). Cancel frees the stock.
//   Quotation  Save → WQ-YYYY-NNNN, never touches stock. Convert to Order (server, once) or
//              Convert to Sale (/wholesale/pos?quotation=<id>).
//
// Server: apps/sales/wholesale_orders.py. Helpers: pages/wholesale/wholesaleOrders.js.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Paper, Typography, Stack, Button, TextField, InputAdornment, Table, TableHead, TableBody,
  TableRow, TableCell, TableContainer, IconButton, Tooltip, Chip, Grid, CircularProgress, Alert,
  Autocomplete, ToggleButton, ToggleButtonGroup, Divider,
} from '@mui/material';
import {
  Search as SearchIcon, Add as AddIcon, Edit as EditIcon, Refresh as RefreshIcon,
  PointOfSale as SaleIcon, DeleteOutline as DeleteIcon, Print as PrintIcon, Block as CancelIcon,
  ArrowBack as BackIcon, CheckCircle as ConfirmIcon, PersonAdd as PersonAddIcon,
  ShoppingCartCheckout as ToOrderIcon, Inventory2 as StockIcon,
} from '@mui/icons-material';
import axios from 'axios';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';
import { NewDealerDialog } from './wholesale/WholesaleDialogs';
import {
  WHOLESALE_API, LS_KEYS, NEW_DEALER_DEFAULTS, readLS, writeLS, fetchAllPages, mapDealerFromApi,
  mapDealerToApi, mapWholesaleProduct, computeLineTotals, canOverridePrice, PRICE_TIER_LABEL,
} from './wholesale/wholesaleConstants';
import {
  DOC_KINDS, STATUS_META, ORDER_STATUS, QUOTE_STATUS, availableUnits, buildOrderLine, summarizeLines,
  lineProblems, docToApi, docFromApi, isOpenDoc, lineUnits, docForPrint,
} from './wholesale/wholesaleOrders';
import { navScopeProps, selectOnFocusProps, zeroAsBlank } from './wholesale/keyboardNav';
import { setLinePrice, shownPrice } from '../utils/wholesalePricing';
import { describeApiError } from '../utils/apiWriteGuard';
import { notify } from '../utils/notify';
import { printBill } from '../billing/printBill';
import { useAuth } from '../context/AuthContext';
import { formatCurrency, getTaxLabel, getTaxRegLabel } from '../utils/localeFormat.js';

const inr = (n) => `${formatCurrency(parseFloat(n) || 0)}`;
const HEAD_SX = { bgcolor: '#0f172a', color: '#fff', fontWeight: 800, fontSize: '0.72rem', whiteSpace: 'nowrap', py: 0.8 };
const CELL_SX = { fontSize: '0.8rem', py: 0.5 };
const dash = (v) => (v && v !== '—' ? v : '—');
const today = () => new Date().toISOString().split('T')[0];
const plusDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x.toISOString().split('T')[0]; };
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const errText = (e, fallback) => (typeof e?.response?.data?.detail === 'string' && e.response.data.detail)
  || (typeof e?.response?.data?.details === 'string' && e.response.data.details)
  || (Array.isArray(e?.response?.data?.details) && e.response.data.details.join(' '))
  || describeApiError(e, fallback);

const STATUS_FILTERS = {
  order: [['OPEN', 'Pending', ORDER_STATUS.CONFIRMED], ['BILLED', 'Billed', ORDER_STATUS.BILLED],
    ['CANCELLED', 'Cancelled', ORDER_STATUS.CANCELLED], ['ALL', 'All', '']],
  quotation: [['OPEN', 'Open', QUOTE_STATUS.OPEN], ['DONE', 'Converted', `${QUOTE_STATUS.ORDERED},${QUOTE_STATUS.BILLED}`],
    ['CANCELLED', 'Cancelled', QUOTE_STATUS.CANCELLED], ['ALL', 'All', '']],
};

function Field({ label, value }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ display: 'block', lineHeight: 1.2 }}>{label}</Typography>
      <Typography variant="body2" fontWeight={800} sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={value || ''}>{value || '—'}</Typography>
    </Box>
  );
}

export default function WholesaleOrders({ kind = 'order' }) {
  const meta = DOC_KINDS[kind];
  const isOrder = kind === 'order';
  const navigate = useNavigate();
  const { user } = useAuth();
  const canOverride = canOverridePrice(user);

  // ---- master data ----
  const [dealers, setDealers] = useState([]);
  const [products, setProducts] = useState([]);
  const [priceListRows, setPriceListRows] = useState([]);
  const [mastersLoading, setMastersLoading] = useState(true);

  // ---- list ----
  const [docs, setDocs] = useState([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState('');
  const [search, setSearch] = useState('');
  const [statusKey, setStatusKey] = useState('OPEN');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [busyId, setBusyId] = useState('');
  const [confirm, setConfirm] = useState(null); // { title, message, type, run }

  // ---- editor ----
  const [editor, setEditor] = useState(null); // null = list view; { id?, number?, status? }
  const [dealer, setDealer] = useState(null);
  const [lines, setLines] = useState([]);
  const [notes, setNotes] = useState('');
  const [expiryDate, setExpiryDate] = useState('');
  const [productQuery, setProductQuery] = useState('');
  const [pickQty, setPickQty] = useState({}); // productId -> typed qty in the picker
  const [reservations, setReservations] = useState({ wholesale: {}, retail: {} });
  const [saving, setSaving] = useState(false);
  const [newDealerOpen, setNewDealerOpen] = useState(false);
  const [newDealer, setNewDealer] = useState(NEW_DEALER_DEFAULTS);
  const [savingDealer, setSavingDealer] = useState(false);
  const searchRef = useRef(null);

  // ---- loading ----
  const loadMasters = useCallback(async () => {
    setMastersLoading(true);
    const cached = readLS(LS_KEYS.customers, []);
    if (cached.length) setDealers(cached.filter(d => d.id));
    const [d, p, pl] = await Promise.allSettled([
      fetchAllPages(axios, `${WHOLESALE_API}/dealers/`),
      fetchAllPages(axios, '/api/products/products/'),
      fetchAllPages(axios, `${WHOLESALE_API}/price-lists/`),
    ]);
    if (d.status === 'fulfilled') {
      const mapped = d.value.map(mapDealerFromApi);
      setDealers(mapped);
      writeLS(LS_KEYS.customers, mapped);
    }
    if (p.status === 'fulfilled') setProducts(p.value.filter(r => r.is_active !== false).map(mapWholesaleProduct));
    if (pl.status === 'fulfilled') setPriceListRows(pl.value);
    if (p.status === 'rejected') notify('Could not load products from the server — check the connection and refresh.', 'error');
    setMastersLoading(false);
  }, []);

  const loadDocs = useCallback(async () => {
    setListLoading(true);
    setListError('');
    const status = (STATUS_FILTERS[kind].find(([k]) => k === statusKey) || [])[2] || '';
    const params = new URLSearchParams();
    if (status) params.set('status', status);
    if (dateFrom) params.set('date_from', dateFrom);
    if (dateTo) params.set('date_to', dateTo);
    try {
      const rows = await fetchAllPages(axios, `${WHOLESALE_API}/${meta.endpoint}/${params.toString() ? `?${params}` : ''}`);
      setDocs(rows.map(r => docFromApi(kind, r)));
    } catch (e) {
      setListError(errText(e, `Could not load ${meta.noun.toLowerCase()}s.`));
    } finally {
      setListLoading(false);
    }
  }, [kind, meta, statusKey, dateFrom, dateTo]);

  const loadReservations = useCallback(async (excludeId) => {
    try {
      const { data } = await axios.get(`${WHOLESALE_API}/orders/availability/`, { params: excludeId ? { exclude: excludeId } : {}, __silentError: true });
      setReservations({ wholesale: data?.wholesale || {}, retail: data?.retail || {} });
    } catch (e) { /* availability shows on-hand only */ }
  }, []);

  useEffect(() => { loadMasters(); }, [loadMasters]);
  useEffect(() => { loadDocs(); }, [loadDocs]);
  // Leaving the editor when the menu item is clicked again / kind switches.
  useEffect(() => { setEditor(null); }, [kind]);

  const productsById = useMemo(() => Object.fromEntries(products.map(p => [p.id, p])), [products]);
  const dealersById = useMemo(() => Object.fromEntries(dealers.map(d => [String(d.id), d])), [dealers]);

  // ---- list filtering (search is local, over the loaded page set) ----
  const shownDocs = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(d => [d.number, d.dealerName, d.dealerCode, d.date, fmtDate(d.date), d.invoiceNumber, d.quotationRef, d.orderNumber]
      .some(v => String(v || '').toLowerCase().includes(q)));
  }, [docs, search]);

  const listTotals = useMemo(() => ({
    count: shownDocs.length,
    value: shownDocs.reduce((a, d) => a + d.total, 0),
    units: shownDocs.reduce((a, d) => a + d.items.reduce((s, l) => s + lineUnits(l), 0), 0),
  }), [shownDocs]);

  // ---- editor open / close ----
  const openEditor = (doc = null) => {
    setEditor(doc ? { id: doc.id, number: doc.number, status: doc.status } : {});
    const d = doc ? (dealersById[String(doc.dealerId)] || (doc.dealer ? { ...doc.dealer, id: doc.dealerId } : null)) : null;
    setDealer(d);
    setLines(doc ? doc.items.map(l => ({ ...l })) : []);
    setNotes(doc?.notes || '');
    setExpiryDate(doc?.expiryDate || plusDays(today(), 15));
    setProductQuery('');
    setPickQty({});
    loadReservations(isOrder && doc ? doc.id : null);
    setTimeout(() => document.getElementById(doc ? 'wo-product-search' : 'wo-dealer')?.focus(), 80);
  };

  const closeEditor = () => {
    setEditor(null);
    setLines([]);
    setDealer(null);
  };

  // ---- product picker ----
  const avail = useCallback((p) => availableUnits(p, reservations), [reservations]);
  const inOrder = useMemo(() => {
    const m = {};
    lines.forEach(l => { m[l.id] = (m[l.id] || 0) + lineUnits(l); });
    return m;
  }, [lines]);

  const pickerRows = useMemo(() => {
    const q = productQuery.trim().toLowerCase();
    const list = q
      ? products.filter(p => [p.name, p.code, p.sku, p.barcode, p.brand, p.modelNo, p.color, p.size, p.category]
        .some(v => v && v !== '—' && String(v).toLowerCase().includes(q)))
      : products;
    return list.slice(0, 80);
  }, [products, productQuery]);

  const addProduct = (p, qty) => {
    const n = Math.max(1, Math.round(parseFloat(qty) || 1));
    if (!dealer) {
      notify('Select the dealer first — prices follow the dealer\'s price list.', 'warning');
      document.getElementById('wo-dealer')?.focus();
      return;
    }
    setLines(prev => {
      const i = prev.findIndex(l => l.id === p.id && !l.isFreeGift);
      if (i !== -1) return prev.map((l, j) => (j === i ? { ...l, qty: (parseFloat(l.qty) || 0) + n } : l));
      return [...prev, buildOrderLine(p, dealer, n, { priceListRows })];
    });
    setPickQty(prev => ({ ...prev, [p.id]: '' }));
    const left = avail(p) - (inOrder[p.id] || 0) - n;
    if (isOrder && left < 0) notify(`${p.name}: only ${Math.max(avail(p) - (inOrder[p.id] || 0), 0)} available — the order is short by ${-left}.`, 'warning');
  };

  const handleSearchKey = (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      document.querySelector('[data-pick-row="0"]')?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const q = productQuery.trim().toLowerCase();
      const exact = q && products.find(p => [p.barcode, p.code, p.sku].some(v => v && String(v).toLowerCase() === q));
      if (exact) { addProduct(exact, 1); setProductQuery(''); return; }
      if (pickerRows.length === 1) { addProduct(pickerRows[0], 1); setProductQuery(''); return; }
      document.querySelector('[data-pick-row="0"]')?.focus();
    }
  };

  const handlePickKey = (e, p, idx) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      addProduct(p, pickQty[p.id]);
      searchRef.current?.focus();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = idx + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) searchRef.current?.focus();
      else document.querySelector(`[data-pick-row="${next}"]`)?.focus();
    } else if (e.key === 'Escape') {
      searchRef.current?.focus();
    }
  };

  // ---- lines ----
  const setLine = (i, patch) => setLines(prev => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const setLineRate = (i, v) => setLines(prev => prev.map((l, j) => (j === i ? { ...setLinePrice(l, v), priceTier: 'CUSTOM' } : l)));
  const removeLine = (i) => setLines(prev => prev.filter((_, j) => j !== i));
  const summary = useMemo(() => summarizeLines(lines), [lines]);
  const problems = useMemo(() => lineProblems(lines), [lines]);

  // When the dealer changes on a fresh document, re-price untouched lines for the new list.
  const pickDealer = (d) => {
    setDealer(d);
    if (!d) return;
    setLines(prev => prev.map((l) => {
      if (l.priceTier === 'CUSTOM') return l;
      const p = productsById[l.id];
      if (!p) return l;
      const fresh = buildOrderLine(p, d, parseFloat(l.qty) || 1, { priceListRows });
      return { ...l, rate: fresh.rate, inclRate: fresh.inclRate, taxInclusive: fresh.taxInclusive, priceTier: fresh.priceTier };
    }));
  };

  // ---- new dealer ----
  const saveNewDealer = async () => {
    if (!newDealer.name || !newDealer.phone) { notify('Please provide Business Name and Phone number.', 'error'); return; }
    setSavingDealer(true);
    try {
      const code = newDealer.code || `DL-${Math.floor(1000 + Math.random() * 9000)}`;
      const res = await axios.post(`${WHOLESALE_API}/dealers/`, mapDealerToApi({ ...newDealer, code, outstanding: 0 }));
      const created = { ...mapDealerFromApi(res.data), billingAddress: newDealer.billingAddress || res.data.address || '' };
      setDealers(prev => { const next = [created, ...prev]; writeLS(LS_KEYS.customers, next); return next; });
      pickDealer(created);
      setNewDealerOpen(false);
      setNewDealer(NEW_DEALER_DEFAULTS);
      notify(`Dealer registered: ${created.name}`, 'success');
    } catch (e) {
      notify(errText(e, 'Could not register the dealer.'), 'error');
    } finally {
      setSavingDealer(false);
    }
  };

  // ---- save ----
  const shortLines = isOrder ? lines.filter(l => {
    const p = productsById[l.id];
    return p && lineUnits(l) > avail(p);
  }) : [];

  const save = async () => {
    if (saving) return;
    if (!dealer?.id) { notify('Select a dealer / shop first.', 'error'); document.getElementById('wo-dealer')?.focus(); return; }
    if (!lines.length) { notify('Add at least one product.', 'error'); searchRef.current?.focus(); return; }
    const bad = Object.keys(problems)[0];
    if (bad !== undefined) { notify(`Line ${Number(bad) + 1} (${lines[bad].name}): ${problems[bad]}.`, 'error'); return; }
    setSaving(true);
    try {
      const body = docToApi(kind, { dealer, lines, notes, expiryDate });
      const res = editor?.id
        ? await axios.patch(`${WHOLESALE_API}/${meta.endpoint}/${editor.id}/`, body)
        : await axios.post(`${WHOLESALE_API}/${meta.endpoint}/`, body);
      const saved = docFromApi(kind, res.data);
      notify(editor?.id ? `${meta.noun} ${saved.number} updated.`
        : isOrder ? `Order ${saved.number} confirmed — ${summary.totalQty} unit(s) reserved.` : `Quotation ${saved.number} saved.`, 'success');
      closeEditor();
      loadDocs();
    } catch (e) {
      notify(errText(e, `The ${meta.noun.toLowerCase()} was not saved.`), 'error');
    } finally {
      setSaving(false);
    }
  };

  // ---- list actions ----
  const runAction = async (doc, fn, okMsg) => {
    setBusyId(doc.id);
    try {
      const out = await fn();
      if (okMsg) notify(typeof okMsg === 'function' ? okMsg(out) : okMsg, 'success');
      loadDocs();
    } catch (e) {
      notify(errText(e, 'The action failed.'), 'error');
    } finally {
      setBusyId('');
    }
  };

  const cancelDoc = (doc) => setConfirm({
    title: `Cancel ${meta.noun} ${doc.number}?`,
    message: isOrder
      ? `The ${doc.items.reduce((a, l) => a + lineUnits(l), 0)} reserved unit(s) go back to available stock. A cancelled order can't be billed.`
      : 'The quotation stays on record as cancelled and can no longer be converted.',
    type: 'danger',
    run: () => runAction(doc, () => axios.post(`${WHOLESALE_API}/${meta.endpoint}/${doc.id}/cancel/`), `${meta.noun} ${doc.number} cancelled.`),
  });

  const convertToOrder = (doc) => setConfirm({
    title: `Convert ${doc.number} into a Wholesale Order?`,
    message: 'A confirmed order is created with the same dealer, items and prices, and its quantities are reserved in stock.',
    type: 'info',
    run: () => runAction(doc, () => axios.post(`${WHOLESALE_API}/quotations/${doc.id}/convert-to-order/`),
      (res) => `Order ${res?.data?.order?.order_number || ''} created from ${doc.number}.`),
  });

  const toSale = (doc) => navigate(`/wholesale/pos?${isOrder ? 'order' : 'quotation'}=${doc.id}`);

  const printDoc = async (doc) => {
    const opened = await printBill({ doc: docForPrint(doc, dealersById[String(doc.dealerId)]), documentType: 'WHOLESALE_BILL', title: meta.printTitle });
    if (!opened) notify('Print pop-up was blocked — allow pop-ups for this site and try again.', 'warning');
  };

  // ======================================================================================
  // EDITOR
  // ======================================================================================
  if (editor) {
    const locked = Boolean(editor.id) && editor.status && !isOpenDoc({ kind, status: editor.status });
    return (
      <Box sx={{ p: { xs: 1, md: 2 }, maxWidth: 1600, mx: 'auto' }} {...navScopeProps}>
        <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
          <IconButton onClick={closeEditor} aria-label="Back to list"><BackIcon /></IconButton>
          <Box sx={{ flex: 1, minWidth: 200 }}>
            <Typography variant="h6" fontWeight={900} color="primary.main" sx={{ lineHeight: 1.2 }}>
              {editor.id ? `Edit ${meta.noun} ${editor.number}` : `New Wholesale ${meta.noun}`}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              {isOrder ? 'Confirmed orders reserve stock until they are billed in the Wholesale POS or cancelled.'
                : 'An estimate for the dealer — no stock is reserved or deducted.'}
            </Typography>
          </Box>
          <Button variant="outlined" color="inherit" onClick={closeEditor} sx={{ fontWeight: 800, textTransform: 'none' }}>Discard</Button>
          <Button
            variant="contained" startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <ConfirmIcon />}
            disabled={saving || locked} onClick={save} id="wo-save"
            sx={{ fontWeight: 900, textTransform: 'none', px: 2.5 }}
          >
            {editor.id ? `Update ${meta.noun}` : isOrder ? 'Confirm Order' : 'Save Quotation'}
          </Button>
        </Stack>

        {/* Dealer */}
        <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderRadius: 1.5 }}>
          <Grid container spacing={1.5} alignItems="flex-start">
            <Grid item xs={12} md={4}>
              <Stack direction="row" spacing={1} alignItems="center">
                <Autocomplete
                  id="wo-dealer" fullWidth size="small" options={dealers.filter(d => d.id && String(d.status || 'Active') === 'Active')}
                  value={dealer} onChange={(_, v) => pickDealer(v)} loading={mastersLoading}
                  isOptionEqualToValue={(a, b) => String(a.id) === String(b.id)}
                  getOptionLabel={(d) => (d ? `${d.name}${d.code ? ` (${d.code})` : ''}` : '')}
                  filterOptions={(opts, { inputValue }) => {
                    const q = inputValue.trim().toLowerCase();
                    return (q ? opts.filter(d => [d.name, d.code, d.phone, d.gstin, d.contactPerson].some(v => String(v || '').toLowerCase().includes(q))) : opts).slice(0, 60);
                  }}
                  renderOption={(props, d) => (
                    <li {...props} key={d.id}>
                      <Box>
                        <Typography variant="body2" fontWeight={800}>{d.name} <Typography component="span" variant="caption" color="text.secondary">{d.code}</Typography></Typography>
                        <Typography variant="caption" color="text.secondary">{[d.phone, d.city || d.billingAddress].filter(Boolean).join(' · ')}</Typography>
                      </Box>
                    </li>
                  )}
                  renderInput={(params) => <TextField {...params} label="Dealer / Shop *" placeholder={`Search name, code, phone, ${getTaxRegLabel()}`} />}
                />
                <Tooltip title="Add a new dealer">
                  <IconButton color="primary" onClick={() => setNewDealerOpen(true)} sx={{ border: '1px solid', borderColor: 'divider' }}><PersonAddIcon /></IconButton>
                </Tooltip>
              </Stack>
              {!isOrder && (
                <TextField
                  size="small" type="date" label="Valid Until" value={expiryDate} onChange={(e) => setExpiryDate(e.target.value)}
                  InputLabelProps={{ shrink: true }} sx={{ mt: 1.5, width: 200 }}
                />
              )}
            </Grid>
            <Grid item xs={12} md={8}>
              {dealer ? (
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0,1fr))', md: 'repeat(5, minmax(0,1fr))' }, gap: 1.2, p: 1, bgcolor: '#f8fafc', borderRadius: 1, border: '1px solid #e2e8f0' }}>
                  <Field label="Shop Name" value={dealer.name} />
                  <Field label="Contact" value={dealer.contactPerson} />
                  <Field label="Phone" value={dealer.phone} />
                  <Field label={getTaxRegLabel()} value={dealer.gstin} />
                  <Field label="Price List" value={PRICE_TIER_LABEL?.[dealer.priceList] || dealer.priceList} />
                  <Box sx={{ gridColumn: '1 / -1' }}><Field label="Address" value={dealer.billingAddress || [dealer.city, dealer.state].filter(Boolean).join(', ')} /></Box>
                </Box>
              ) : (
                <Box sx={{ p: 2, border: '1px dashed #cbd5e1', borderRadius: 1, color: 'text.secondary', textAlign: 'center' }}>
                  <Typography variant="body2" fontWeight={600}>Select a dealer / shop — or add a new one with the <PersonAddIcon sx={{ fontSize: 16, verticalAlign: 'middle' }} /> button.</Typography>
                </Box>
              )}
            </Grid>
          </Grid>
        </Paper>

        {locked && <Alert severity="info" sx={{ mb: 1.5 }}>This {meta.noun.toLowerCase()} is {STATUS_META[editor.status]?.label.toLowerCase() || editor.status} and can no longer be changed.</Alert>}

        <Grid container spacing={1.5}>
          {/* Product picker */}
          <Grid item xs={12} lg={6}>
            <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }} data-nav-own>
              <Box sx={{ p: 1.2, display: 'flex', gap: 1, alignItems: 'center', borderBottom: '1px solid #e2e8f0' }}>
                <StockIcon color="primary" />
                <Typography fontWeight={900} sx={{ flexShrink: 0 }}>Products</Typography>
                <TextField
                  fullWidth size="small" id="wo-product-search" inputRef={searchRef} autoComplete="off"
                  placeholder="Scan / search tag code, name, brand, model, colour…"
                  value={productQuery} onChange={(e) => setProductQuery(e.target.value)} onKeyDown={handleSearchKey}
                  InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
                />
              </Box>
              <TableContainer sx={{ maxHeight: 460 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {['Tag Code', 'Description', 'Brand', 'Model', 'Color', 'Size', 'Available', 'Qty', ''].map(h => (
                        <TableCell key={h} sx={HEAD_SX} align={['Available', 'Qty'].includes(h) ? 'right' : 'left'}>{h}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {mastersLoading && !products.length && (
                      <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4 }}><CircularProgress size={22} /></TableCell></TableRow>
                    )}
                    {!mastersLoading && !pickerRows.length && (
                      <TableRow><TableCell colSpan={9} align="center" sx={{ py: 3, color: 'text.secondary' }}>No product matches “{productQuery}”.</TableCell></TableRow>
                    )}
                    {pickerRows.map((p, idx) => {
                      const free = avail(p) - (inOrder[p.id] || 0);
                      return (
                        <TableRow key={p.id} hover>
                          <TableCell sx={{ ...CELL_SX, fontFamily: 'monospace' }}>{p.barcode || p.code || '—'}</TableCell>
                          <TableCell sx={{ ...CELL_SX, fontWeight: 700, maxWidth: 200 }}>{p.name}</TableCell>
                          <TableCell sx={CELL_SX}>{dash(p.brand)}</TableCell>
                          <TableCell sx={CELL_SX}>{dash(p.modelNo)}</TableCell>
                          <TableCell sx={CELL_SX}>{dash(p.color)}</TableCell>
                          <TableCell sx={CELL_SX}>{dash(p.size)}</TableCell>
                          <TableCell sx={{ ...CELL_SX, fontWeight: 900, color: free > 5 ? '#15803d' : free > 0 ? '#b45309' : '#dc2626' }} align="right"
                            title={`On hand ${p.availableStock} · reserved by other orders ${p.availableStock - avail(p)}${inOrder[p.id] ? ` · ${inOrder[p.id]} on this ${meta.noun.toLowerCase()}` : ''}`}>
                            {free}
                          </TableCell>
                          <TableCell sx={{ ...CELL_SX, width: 76 }} align="right">
                            <TextField
                              size="small" type="number" placeholder="1" value={pickQty[p.id] ?? ''}
                              onChange={(e) => setPickQty(prev => ({ ...prev, [p.id]: e.target.value }))}
                              onKeyDown={(e) => handlePickKey(e, p, idx)}
                              inputProps={{ min: 1, 'data-pick-row': idx, 'aria-label': `Quantity of ${p.name}`, style: { textAlign: 'right', padding: '4px 6px', width: 48 } }}
                            />
                          </TableCell>
                          <TableCell sx={{ ...CELL_SX, width: 40 }}>
                            <IconButton size="small" color="primary" onClick={() => addProduct(p, pickQty[p.id])} aria-label={`Add ${p.name}`} disabled={locked}><AddIcon fontSize="small" /></IconButton>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.2, py: 0.6, borderTop: '1px solid #e2e8f0' }}>
                Type a qty and press <b>Enter</b> (or +) to add · ↑/↓ move between products · Available = on hand − units reserved by open orders{pickerRows.length === 80 ? ' · showing the first 80 matches' : ''}
              </Typography>
            </Paper>
          </Grid>

          {/* Lines */}
          <Grid item xs={12} lg={6}>
            <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }} data-nav-own>
              <Box sx={{ p: 1.2, display: 'flex', alignItems: 'center', gap: 1, borderBottom: '1px solid #e2e8f0' }}>
                <Typography fontWeight={900} sx={{ flex: 1 }}>{meta.noun} Items</Typography>
                <Chip size="small" label={`${lines.length} line(s) · ${summary.totalQty} unit(s)`} sx={{ fontWeight: 800 }} />
              </Box>
              <TableContainer sx={{ maxHeight: 400 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {['#', 'Item', 'Avail.', 'Qty', 'Rate', 'Disc %', `${getTaxLabel()} %`, 'Total', ''].map(h => (
                        <TableCell key={h} sx={HEAD_SX} align={['Item', '#', ''].includes(h) ? 'left' : 'right'}>{h}</TableCell>
                      ))}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {!lines.length && (
                      <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5, color: 'text.secondary' }}>No items yet — pick products from the list.</TableCell></TableRow>
                    )}
                    {lines.map((l, i) => {
                      const p = productsById[l.id];
                      const free = p ? avail(p) : null;
                      const short = isOrder && free != null && lineUnits(l) > free;
                      return (
                        <TableRow key={`${l.id}-${i}`} sx={{ bgcolor: problems[i] ? '#fef2f2' : short ? '#fffbeb' : undefined }}>
                          <TableCell sx={CELL_SX}>{i + 1}</TableCell>
                          <TableCell sx={{ ...CELL_SX, maxWidth: 220 }}>
                            <Typography variant="body2" fontWeight={800} sx={{ lineHeight: 1.2 }}>{l.name}</Typography>
                            <Typography variant="caption" color="text.secondary">
                              {[l.barcode || l.code, l.brand, l.modelNo, l.color, l.size].filter(v => v && v !== '—').join(' · ')}
                            </Typography>
                          </TableCell>
                          <TableCell sx={{ ...CELL_SX, fontWeight: 800, color: short ? '#b45309' : 'text.secondary' }} align="right" title={short ? 'More than is free to sell right now' : ''}>{free ?? '—'}</TableCell>
                          <TableCell sx={{ ...CELL_SX, width: 70 }} align="right">
                            <TextField size="small" type="number" value={l.qty} disabled={locked} error={Boolean(problems[i])}
                              onChange={(e) => setLine(i, { qty: e.target.value === '' ? '' : Number(e.target.value) })}
                              onBlur={() => { if (!(parseFloat(l.qty) >= 1)) setLine(i, { qty: 1 }); }}
                              {...selectOnFocusProps}
                              inputProps={{ min: 1, 'aria-label': `Qty line ${i + 1}`, style: { textAlign: 'right', padding: '4px 6px', width: 46 } }} />
                          </TableCell>
                          <TableCell sx={{ ...CELL_SX, width: 92 }} align="right">
                            <TextField size="small" type="number" value={zeroAsBlank(shownPrice(l))} disabled={locked || !canOverride}
                              onChange={(e) => setLineRate(i, e.target.value)} {...selectOnFocusProps}
                              title={canOverride ? (l.taxInclusive ? 'Price incl. tax' : 'Price excl. tax') : 'Only Managers / Admins can change prices'}
                              inputProps={{ 'aria-label': `Rate line ${i + 1}`, style: { textAlign: 'right', padding: '4px 6px', width: 70 } }} />
                          </TableCell>
                          <TableCell sx={{ ...CELL_SX, width: 64 }} align="right">
                            <TextField size="small" type="number" value={zeroAsBlank(l.discount)} disabled={locked}
                              onChange={(e) => setLine(i, { discount: e.target.value })} {...selectOnFocusProps}
                              inputProps={{ min: 0, max: 100, 'aria-label': `Discount line ${i + 1}`, style: { textAlign: 'right', padding: '4px 6px', width: 40 } }} />
                          </TableCell>
                          <TableCell sx={CELL_SX} align="right">{l.gst}%</TableCell>
                          <TableCell sx={{ ...CELL_SX, fontWeight: 800 }} align="right">{inr(computeLineTotals(l).total)}</TableCell>
                          <TableCell sx={{ ...CELL_SX, width: 36 }}>
                            <IconButton size="small" color="error" onClick={() => removeLine(i)} disabled={locked} aria-label={`Remove ${l.name}`}><DeleteIcon fontSize="small" /></IconButton>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
              <Box sx={{ p: 1.5, borderTop: '1px solid #e2e8f0' }}>
                {shortLines.length > 0 && (
                  <Alert severity="warning" sx={{ mb: 1, py: 0 }}>
                    {shortLines.map(l => l.name).join(', ')} — more than is free to sell now. The order can still be confirmed; the shortfall shows in Stock Overview.
                  </Alert>
                )}
                <Grid container spacing={1.5}>
                  <Grid item xs={12} sm={7}>
                    <TextField fullWidth size="small" multiline minRows={2} label={`${meta.noun} notes`} value={notes} onChange={(e) => setNotes(e.target.value)} disabled={locked} />
                  </Grid>
                  <Grid item xs={12} sm={5}>
                    {[['Sub Total', summary.subtotal], ['Discount', -summary.totalDiscount], [getTaxLabel(), summary.totalGst]].map(([k, v]) => (
                      <Stack key={k} direction="row" justifyContent="space-between"><Typography variant="body2" color="text.secondary" fontWeight={700}>{k}</Typography><Typography variant="body2" fontWeight={800}>{inr(v)}</Typography></Stack>
                    ))}
                    <Divider sx={{ my: 0.5 }} />
                    <Stack direction="row" justifyContent="space-between"><Typography fontWeight={900}>{isOrder ? 'Order Total' : 'Estimate Total'}</Typography><Typography fontWeight={900} color="primary.main">{inr(summary.grandTotal)}</Typography></Stack>
                  </Grid>
                </Grid>
              </Box>
            </Paper>
          </Grid>
        </Grid>

        <NewDealerDialog open={newDealerOpen} value={newDealer} onChange={setNewDealer} onClose={() => setNewDealerOpen(false)} onSave={saveNewDealer} saving={savingDealer} />
      </Box>
    );
  }

  // ======================================================================================
  // LIST
  // ======================================================================================
  return (
    <Box sx={{ p: { xs: 1, md: 2 }, maxWidth: 1600, mx: 'auto' }} {...navScopeProps}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
        <Box sx={{ flex: 1, minWidth: 220 }}>
          <Typography variant="h6" fontWeight={900} color="primary.main" sx={{ lineHeight: 1.2 }}>{meta.title}</Typography>
          <Typography variant="caption" color="text.secondary" fontWeight={600}>
            {isOrder ? 'Confirmed dealer orders reserve stock until billed in the Wholesale POS.' : 'Price estimates for dealers — convert to an order or straight to a sale.'}
          </Typography>
        </Box>
        <Tooltip title="Refresh"><IconButton onClick={() => { loadDocs(); loadMasters(); }}><RefreshIcon /></IconButton></Tooltip>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => openEditor()} sx={{ fontWeight: 900, textTransform: 'none' }}>
          New {meta.noun}
        </Button>
      </Stack>

      <Paper variant="outlined" sx={{ p: 1.2, mb: 1.5, borderRadius: 1.5 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.2} alignItems={{ md: 'center' }}>
          <TextField
            size="small" sx={{ flex: 1, minWidth: 220 }} placeholder={`Search ${meta.noun.toLowerCase()} no., dealer / shop, date…`}
            value={search} onChange={(e) => setSearch(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          />
          <ToggleButtonGroup size="small" exclusive value={statusKey} onChange={(_, v) => v && setStatusKey(v)}>
            {STATUS_FILTERS[kind].map(([k, label]) => <ToggleButton key={k} value={k} sx={{ fontWeight: 800, textTransform: 'none', px: 1.5 }}>{label}</ToggleButton>)}
          </ToggleButtonGroup>
          <Stack direction="row" spacing={1}>
            <TextField size="small" type="date" label="From" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ width: 150 }} />
            <TextField size="small" type="date" label="To" value={dateTo} onChange={(e) => setDateTo(e.target.value)} InputLabelProps={{ shrink: true }} sx={{ width: 150 }} />
          </Stack>
        </Stack>
        <Stack direction="row" spacing={1} sx={{ mt: 1 }} flexWrap="wrap" useFlexGap>
          <Chip size="small" label={`${listTotals.count} ${meta.noun.toLowerCase()}(s)`} sx={{ fontWeight: 800 }} />
          <Chip size="small" label={`Value ${inr(listTotals.value)}`} sx={{ fontWeight: 800 }} />
          <Chip size="small" label={`${listTotals.units} unit(s)`} sx={{ fontWeight: 800 }} />
        </Stack>
      </Paper>

      {listError && <Alert severity="error" sx={{ mb: 1.5 }}>{listError}</Alert>}

      <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }}>
        <TableContainer sx={{ maxHeight: 'calc(100vh - 290px)' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {[`${meta.noun} No.`, 'Date', 'Dealer / Shop', 'Items', 'Units', 'Total', 'Status', isOrder ? 'Billed / From' : 'Converted To', 'Actions'].map(h => (
                  <TableCell key={h} sx={HEAD_SX} align={['Items', 'Units', 'Total'].includes(h) ? 'right' : h === 'Actions' ? 'center' : 'left'}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {listLoading && (
                <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5 }}><CircularProgress size={24} /></TableCell></TableRow>
              )}
              {!listLoading && !shownDocs.length && (
                <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5, color: 'text.secondary' }}>
                  No {meta.noun.toLowerCase()}s here. <Button size="small" onClick={() => openEditor()} sx={{ textTransform: 'none', fontWeight: 800 }}>Create one</Button>
                </TableCell></TableRow>
              )}
              {!listLoading && shownDocs.map((d) => {
                const open = isOpenDoc(d);
                const st = STATUS_META[d.status] || { label: d.status, color: 'default' };
                const busy = busyId === d.id;
                return (
                  <TableRow key={d.id} hover>
                    <TableCell sx={{ ...CELL_SX, fontFamily: 'monospace', fontWeight: 800 }}>{d.number}</TableCell>
                    <TableCell sx={CELL_SX}>{fmtDate(d.date)}{!isOrder && d.expiryDate ? <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>valid till {fmtDate(d.expiryDate)}</Typography> : null}</TableCell>
                    <TableCell sx={{ ...CELL_SX, fontWeight: 700 }}>{d.dealerName}<Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{d.dealerCode}</Typography></TableCell>
                    <TableCell sx={CELL_SX} align="right">{d.items.length}</TableCell>
                    <TableCell sx={CELL_SX} align="right">{d.items.reduce((a, l) => a + lineUnits(l), 0)}</TableCell>
                    <TableCell sx={{ ...CELL_SX, fontWeight: 800 }} align="right">{inr(d.total)}</TableCell>
                    <TableCell sx={CELL_SX}><Chip size="small" color={st.color} label={st.label} sx={{ fontWeight: 800 }} /></TableCell>
                    <TableCell sx={{ ...CELL_SX, fontFamily: 'monospace' }}>
                      {isOrder ? (d.invoiceNumber || (d.quotationRef ? `from ${d.quotationRef}` : '—')) : (d.orderNumber || d.invoiceNumber || '—')}
                    </TableCell>
                    <TableCell sx={{ ...CELL_SX, whiteSpace: 'nowrap' }} align="center">
                      {busy ? <CircularProgress size={18} /> : (
                        <Stack direction="row" spacing={0.25} justifyContent="center">
                          {open && (
                            <Button size="small" variant="contained" color="success" startIcon={<SaleIcon />} onClick={() => toSale(d)}
                              sx={{ fontWeight: 800, textTransform: 'none', py: 0.1, mr: 0.5 }}>
                              {isOrder ? 'Order to Sale' : 'To Sale'}
                            </Button>
                          )}
                          {open && !isOrder && (
                            <Tooltip title="Convert to Wholesale Order"><IconButton size="small" color="primary" onClick={() => convertToOrder(d)}><ToOrderIcon fontSize="small" /></IconButton></Tooltip>
                          )}
                          {open && <Tooltip title="Edit"><IconButton size="small" onClick={() => openEditor(d)}><EditIcon fontSize="small" /></IconButton></Tooltip>}
                          <Tooltip title="Print"><IconButton size="small" onClick={() => printDoc(d)}><PrintIcon fontSize="small" /></IconButton></Tooltip>
                          {open && <Tooltip title="Cancel"><IconButton size="small" color="error" onClick={() => cancelDoc(d)}><CancelIcon fontSize="small" /></IconButton></Tooltip>}
                        </Stack>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      <ConfirmActionDialog
        open={Boolean(confirm)} title={confirm?.title} message={confirm?.message} type={confirm?.type}
        confirmText="Yes, continue" onClose={() => setConfirm(null)}
        onConfirm={() => { const run = confirm?.run; setConfirm(null); run?.(); }}
      />
    </Box>
  );
}
