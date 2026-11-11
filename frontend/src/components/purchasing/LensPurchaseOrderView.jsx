import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Typography, Button, Grid, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper,
  Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Stack, IconButton, Tooltip,
  InputAdornment, Autocomplete, CircularProgress, LinearProgress, ToggleButton,
  ToggleButtonGroup, Alert, Divider, Checkbox, FormControlLabel, Menu, ListItemIcon, ListItemText,
} from '@mui/material';
import {
  Add as AddIcon, Search as SearchIcon, Print as PrintIcon, Visibility as ViewIcon, Edit as EditIcon,
  MoreVert as MoreIcon, Inventory2 as ReceiveIcon, ReceiptLong as InvoiceIcon, Cancel as CancelIcon,
  Send as SendIcon, LocalShipping as OrderedIcon, Delete as DeleteIcon, Lock as LockIcon,
  LockOpen as UnlockIcon,
} from '@mui/icons-material';
import QuickDatePickerField from '../common/QuickDatePickerField';
import { useDebounce } from '../../hooks/useDebounce';
import { fetchAllPages } from '../../utils/fetchAllPages';
import { isPairSellable, formatDioptre } from '../../utils/lensUnits';
import { notify } from '../../utils/notify';
import { printLensPO } from '../../utils/printLensPO';
import {
  navScopeProps, navDialogProps, enterOpensSelectProps, focusNextAfterRender,
} from '../../pages/wholesale/keyboardNav';
import { makeShortcutHook } from '../../pages/wholesale/posShortcuts';
import { ShortcutHelpDialog } from '../../pages/wholesale/WholesaleDialogs';
import {
  LENS_PO_EDITOR_SHORTCUTS, LENS_DASHBOARD_SHORTCUTS, dialogHotkeys,
} from './lensPoShortcuts';
import {
  SINGLE_PAIR, SINGLE_PIECE, ORDER_TYPES, LPO_STATUSES, RECEIVING_STATUSES, FITTING_STATUSES, statusMeta,
  eyeLabel, eyeShort, lpoQtyLabel, poQtyLabel, rxCells, rxSummary, sameRx, draftItemErrors, itemPayload, draftFromItem,
  splitPairItem, joinPairItems, setEyeSupplier, lineSupplier, groupItemsBySupplier, lensItemsFromRequirements,
} from '../../utils/lensPurchaseOrders';
import { currencyPrefix } from '../../utils/localeFormat.js';
import CurrencySymbol from '../common/CurrencySymbol.jsx';

const API = '/api/purchase/lens-orders/';
const todayStr = () => new Date().toISOString().slice(0, 10);
const errText = (err, fallback) => {
  const d = err?.response?.data;
  if (!d) return fallback;
  if (typeof d === 'string') return d.slice(0, 300);
  const flat = (v) => (Array.isArray(v) ? v.map(flat).join(' ') : typeof v === 'object' && v ? Object.values(v).map(flat).join(' ') : String(v));
  return flat(d.detail ?? d) || fallback;
};

// Keyboard model (see lensPoShortcuts.js): the editor's Paper is one keyboardNav scope — Enter /
// ↑ / ↓ walk its fields, Enter in an open list picks and moves on — plus the dialog's hotkeys.
const keyboardPaper = (hotkeys, extra = {}) => ({
  ...navScopeProps,
  ...extra,
  onKeyDown: (e) => { if (!hotkeys(e)) navScopeProps.onKeyDown(e); },
});
// After an option is picked (Enter or click), step on once React has rendered what it revealed.
const nextAfterPick = (value) => { if (value) focusNextAfterRender(document.activeElement, 60); };
const navStop = (on = true) => (on ? { 'data-nav-stop': '' } : {});
const KeyHint = ({ children }) => (
  <Typography variant="caption" color="text.secondary" sx={{ mr: 'auto', display: { xs: 'none', md: 'block' } }}>{children}</Typography>
);

// ---------------------------------------------------------------------------
// Prescription editor for one lens
// ---------------------------------------------------------------------------

function PieceRxEditor({ piece, onChange, title }) {
  const [unlocked, setUnlocked] = useState(false);
  const changed = piece.original_rx && !sameRx(piece.rx, piece.original_rx);
  const set = (field, value) => onChange({ ...piece, rx: { ...piece.rx, [field]: value } });
  const tidy = (field) => {
    if (['sph', 'cyl', 'add'].includes(field) && piece.rx[field]) set(field, formatDioptre(piece.rx[field]));
  };
  const locked = !unlocked && Boolean(piece.sales_order);
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, borderColor: changed ? 'warning.main' : 'divider' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={800}>{title || eyeLabel(piece.eye)}</Typography>
        {piece.sales_order && (
          <Tooltip title={locked ? 'Prescription comes from the sales order. Unlock to correct it (a reason is recorded).' : 'Lock'}>
            <Button size="small" startIcon={locked ? <LockIcon fontSize="small" /> : <UnlockIcon fontSize="small" />} onClick={() => setUnlocked((u) => !u)}>
              {locked ? 'Edit Rx' : 'Lock Rx'}
            </Button>
          </Tooltip>
        )}
      </Stack>
      <Grid container spacing={1}>
        {[['sph', 'SPH'], ['cyl', 'CYL'], ['axis', 'AXIS'], ['add', 'ADD'], ['prism', 'PRISM']].map(([f, label]) => (
          <Grid item xs={4} sm={2.4} key={f}>
            <TextField size="small" fullWidth label={label} value={piece.rx?.[f] ?? ''} disabled={locked}
              onChange={(e) => set(f, e.target.value)} onBlur={() => tidy(f)}
              inputProps={{ style: { textAlign: 'center' }, ...(f === 'sph' ? { 'data-rx-sph': '' } : {}) }} />
          </Grid>
        ))}
        {!!piece.rx?.prism && (
          <Grid item xs={4} sm={2.4}>
            <TextField size="small" fullWidth select label="BASE" value={piece.rx?.base || ''} disabled={locked} onChange={(e) => set('base', e.target.value)}
              SelectProps={{ ...enterOpensSelectProps }}>
              {['IN', 'OUT', 'UP', 'DOWN'].map((b) => <MenuItem key={b} value={b}>{b}</MenuItem>)}
            </TextField>
          </Grid>
        )}
      </Grid>
      {changed && (
        <Box sx={{ mt: 1 }}>
          <Alert severity="warning" sx={{ py: 0, mb: 1 }}>
            Differs from the sales order ({rxSummary(piece.original_rx) || 'blank'}). The sales order itself is not changed.
          </Alert>
          <TextField size="small" fullWidth required label="Reason for prescription change" value={piece.rx_change_reason || ''}
            onChange={(e) => onChange({ ...piece, rx_change_reason: e.target.value })} />
        </Box>
      )}
      <TextField size="small" fullWidth sx={{ mt: 1 }} label="Lens barcode / piece reference (optional)" value={piece.piece_reference || ''}
        onChange={(e) => onChange({ ...piece, piece_reference: e.target.value })} />
    </Paper>
  );
}

// ---------------------------------------------------------------------------
// Customer-order picker: one option per sales order that still has lenses to order. Picking it
// drops every outstanding lens of that order straight onto the PO grid — model, type, index,
// coating, Rx and cost as sold — so nothing is re-entered.
// ---------------------------------------------------------------------------

function OrderPicker({ excludePoId, takenKeys, onPick, inputRef }) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const term = useDebounce(input, 300);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    axios.get(`${API}pending-requirements/`, { params: { search: term || undefined, exclude_po: excludePoId || undefined } })
      .then((res) => {
        if (!alive) return;
        const byOrder = new Map();
        (Array.isArray(res.data) ? res.data : []).forEach((r) => {
          const left = r.outstanding - (takenKeys?.[`${r.sales_order}|${r.product}|${r.eye}`] || 0);
          if (left <= 0) return;
          if (!byOrder.has(r.sales_order)) byOrder.set(r.sales_order, { ...r, rows: [] });
          byOrder.get(r.sales_order).rows.push({ ...r, outstanding: left });
        });
        setOptions([...byOrder.values()]);
      })
      .catch(() => alive && setOptions([]))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [term, excludePoId, takenKeys]);

  const eyesOf = (o) => {
    const eyes = new Set(o.rows.map((r) => r.eye));
    return eyes.has('RE') && eyes.has('LE') ? 'RE + LE' : eyes.has('RE') ? 'RE only' : 'LE only';
  };
  return (
    <Autocomplete
      options={options}
      value={null}
      inputValue={input}
      loading={loading}
      filterOptions={(x) => x}
      autoHighlight
      blurOnSelect={false}
      isOptionEqualToValue={(a, b) => a.sales_order === b.sales_order}
      getOptionLabel={(o) => (o ? `${o.customer_name || 'Customer'} — ${o.sales_order_number}` : '')}
      onInputChange={(e, v, reason) => { if (reason === 'input' || reason === 'clear') setInput(v); }}
      onChange={(e, v) => { if (v) { onPick(v.rows); setInput(''); } }}
      noOptionsText={term ? 'No pending lens orders match.' : 'No customer orders are waiting for lenses.'}
      renderOption={(props, o) => (
        <li {...props} key={o.sales_order}>
          <Box sx={{ width: '100%' }}>
            <Stack direction="row" justifyContent="space-between" spacing={1}>
              <Typography variant="body2" fontWeight={800}>{o.customer_name || 'Customer'}{o.patient_code ? ` · ${o.patient_code}` : ''}</Typography>
              <Typography variant="caption" fontWeight={700} color="primary">{o.sales_order_number} · {o.order_date}</Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary" component="div">
              {[...new Set(o.rows.map((r) => r.product_name))].join(', ')} · {eyesOf(o)} · {o.order_status || 'Order Received'}
            </Typography>
            {o.rows.map((r) => (
              <Typography key={`${r.product}|${r.eye}`} variant="caption" component="div" sx={{ fontFamily: 'monospace' }}>
                {eyeShort(r.eye)} {r.rx_summary || '—'}
              </Typography>
            ))}
          </Box>
        </li>
      )}
      renderInput={(params) => (
        <TextField {...params} inputRef={inputRef} size="small" label="Add lenses from a customer order (Alt+A)"
          placeholder="Search customer, phone, patient code or sales order"
          InputProps={{ ...params.InputProps, endAdornment: <>{loading ? <CircularProgress size={16} /> : null}{params.InputProps.endAdornment}</> }} />
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Create / edit a Lens PO
// ---------------------------------------------------------------------------

// Lens models come from the product master: spectacle-lens categories first; the grid's model
// picker widens to every product for shops whose lens categories are named differently.
export function useLensProducts() {
  const [lensProducts, setLensProducts] = useState([]);
  const [productsLoading, setProductsLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    fetchAllPages('/api/products/products/').then((all) => {
      if (!alive) return;
      const list = (all || []).filter((p) => !p.is_deleted);
      const lenses = list.filter(isPairSellable);
      lenses.allProducts = list;
      setLensProducts(lenses);
    }).catch(() => {}).finally(() => alive && setProductsLoading(false));
    return () => { alive = false; };
  }, []);
  return { lensProducts, productsLoading };
}

/** Create / edit a Lens PO — all on one screen, no lens popups. The customer order's lenses come
 *  pre-filled from the sale (model, type, index, coating, Rx, cost) as one row per eye; the user only
 *  maps suppliers. Full pair from one supplier: pick it at the top and submit. Different supplier for
 *  one eye: change the supplier on that eye's row — the pair is split and each supplier's lenses
 *  are saved as their own Lens PO with the same customer order reference.
 *  onSaved(firstPo, { receivedNow, all }) gets every PO created.
 *  `entryMode` = opened from Purchase Entry: the supplier follows the entry's, and "Lenses received
 *  now" saves the PO, receives every lens and hands it back so the entry can bill it at once.
 *  `onPartial(savedPos)`: some suppliers' POs were saved before one failed — the editor stays
 *  open with the unsaved lines only. */
export function LensPOEditor({ open, po, seed, suppliers, lensProducts, productsLoading, onClose, onSaved, onPartial, entryMode = false, lockSupplier = false }) {
  const editing = Boolean(po?.id);
  const scope = !editing || ['DRAFT', 'PENDING'].includes(po.status) ? 'full' : po.status === 'ORDERED' ? 'header' : 'remarks';
  const [header, setHeader] = useState({});
  const [items, setItems] = useState([]);
  const [rxOpen, setRxOpen] = useState({}); // `${line key}|${eye}` → prescription editor shown
  const [saving, setSaving] = useState(false);
  const [help, setHelp] = useState(false);
  const vendorInputRef = useRef(null);
  const remarksRef = useRef(null);
  const primaryRef = useRef(null);
  const orderInputRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setHeader({
      supplier: po?.supplier || seed?.supplier || '', order_date: po?.order_date || todayStr(),
      expected_delivery_date: po?.expected_delivery_date || '', remarks: po?.remarks || seed?.remarks || '',
      submitAs: po?.status && po.status !== 'DRAFT' ? po.status : 'PENDING',
    });
    setItems((po?.items || []).map(draftFromItem).concat(seed?.items || []));
    setRxOpen({});
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Requirements already on this editor's unsaved lines (the server excludes this PO's saved
  // lines itself), so the order picker never offers the same eye twice.
  const takenKeys = useMemo(() => {
    const out = {};
    items.forEach((it) => it.pieces.forEach((p) => { const k = `${p.sales_order}|${p.product}|${p.eye}`; out[k] = (out[k] || 0) + 1; }));
    return out;
  }, [items]);

  const supplierName = (id) => suppliers.find((s) => String(s.id) === String(id))?.name || 'supplier';
  // New orders: one PO per supplier. An existing PO keeps its one supplier.
  const groups = useMemo(() => (editing ? [{ supplier: String(header.supplier || ''), items }] : groupItemsBySupplier(items, header.supplier)),
    [editing, items, header.supplier]);
  const lineErrors = () => items.flatMap((it, i) => draftItemErrors(it)
    .map((e) => `Line ${i + 1} (${it.lens_model || it.product_name || 'lens'}): ${e}`));

  const save = async (status, { receivedNow = false } = {}) => {
    if (editing || !items.length ? !header.supplier : groups.some((g) => !g.supplier)) {
      notify(header.supplier ? 'Select a supplier for every lens.' : 'Select the supplier.', 'warning');
      return;
    }
    if (status !== 'DRAFT' && !items.length) { notify('Add the lenses of a customer order before submitting.', 'warning'); return; }
    if (scope === 'full') {
      const errs = lineErrors();
      if (errs.length) { notify(errs[0], 'warning'); return; }
    }
    if (receivedNow && (groups.length > 1 || groups[0]?.supplier !== String(header.supplier))) {
      notify(`Only lenses from ${supplierName(header.supplier)} can be added to this Purchase Entry. Submit the order (one PO per supplier) and bill the other supplier's lenses when they arrive.`, 'warning');
      return;
    }
    if (receivedNow && !window.confirm('Confirm every lens on this order has arrived and matches its model and prescription?\n\n'
      + 'They are marked Received (linked sales orders are updated) and added to this Purchase Entry.')) return;
    if (!editing && groups.length > 1 && !window.confirm(`This creates ${groups.length} lens purchase orders — one per supplier:\n\n`
      + `${groups.map((g) => `• ${supplierName(g.supplier)}: ${poQtyLabel(g.items)}`).join('\n')}\n\nEach keeps the customer order reference. Continue?`)) return;
    setSaving(true);
    const saved = [];
    try {
      const body = { supplier: header.supplier, order_date: header.order_date, expected_delivery_date: header.expected_delivery_date || null, remarks: header.remarks };
      let res;
      if (editing) {
        if (scope === 'full') body.items = items.map(itemPayload);
        if (scope === 'remarks') { delete body.order_date; delete body.expected_delivery_date; delete body.supplier; }
        res = await axios.patch(`${API}${po.id}/`, body);
        if (status && status !== 'DRAFT' && po.status === 'DRAFT') res = await axios.post(`${API}${po.id}/submit/`);
        if (status === 'ORDERED' && res.data.status === 'PENDING') res = await axios.post(`${API}${po.id}/mark-ordered/`);
        saved.push(res.data);
      } else {
        const todo = groups.length ? groups : [{ supplier: String(header.supplier), items: [] }];
        for (const g of todo) {
          res = await axios.post(API, { ...body, supplier: g.supplier, status, items: g.items.map(itemPayload) });
          saved.push(res.data);
        }
      }
      if (receivedNow) {
        const pieces = res.data.items.flatMap((it) => it.pieces).filter((p) => p.receiving_status !== 'RECEIVED');
        if (pieces.length) res = await axios.post(`${API}${res.data.id}/receive/`, { pieces: pieces.map((p) => ({ id: p.id, status: 'RECEIVED' })) });
        saved[0] = res.data;
      }
      const numbers = saved.map((x) => x.po_number).join(', ');
      notify(`Lens PO${saved.length > 1 ? 's' : ''} ${numbers} ${editing ? 'updated' : 'saved'}${saved[0].status === 'DRAFT' ? ' as draft' : ''}${receivedNow ? ' and received' : ''}.`, 'success');
      onSaved(saved[0], { receivedNow, all: saved });
    } catch (err) {
      if (saved.length && !editing) {
        // Some suppliers' POs went through: keep only the lines still unsaved, so a retry can't duplicate.
        const done = new Set(groups.slice(0, saved.length).map((g) => g.supplier));
        setItems((prev) => prev.filter((it) => !done.has(String(it.supplier || header.supplier || ''))));
        onPartial?.(saved);
        notify(`Saved ${saved.map((x) => x.po_number).join(', ')}; the rest failed — ${errText(err, 'could not save the lens purchase order.')}`, 'error');
      } else {
        notify(errText(err, 'Could not save the lens purchase order.'), 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const supplier = suppliers.find((s) => String(s.id) === String(header.supplier)) || null;
  const full = scope === 'full';
  const perLineSupplier = !editing && full;
  const setLine = (i, patch) => setItems((prev) => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const setPiece = (i, k, piece) => setItems((prev) => prev.map((x, j) => (j === i ? { ...x, pieces: x.pieces.map((p, m) => (m === k ? piece : p)) } : x)));
  const hasOtherEye = (it, i) => Boolean(it.pair_group) && items.some((x, j) => j !== i && x.pair_group === it.pair_group && x.order_type === SINGLE_PIECE);
  const toPairOrSingle = (i, kind) => {
    const it = items[i];
    if (kind === SINGLE_PIECE && it.order_type === SINGLE_PAIR) setItems((prev) => prev.flatMap((x, j) => (j === i ? splitPairItem(x) : [x])));
    if (kind === SINGLE_PAIR && it.order_type === SINGLE_PIECE) {
      const other = items.find((x, j) => j !== i && x.pair_group === it.pair_group);
      if (other && lineSupplier(other, header.supplier) !== lineSupplier(it, header.supplier)) notify('Both lenses now come from one supplier.', 'info');
      setItems((prev) => joinPairItems(prev, i));
    }
  };
  // Drops one eye: a Pair keeps the other eye as a Single Lens; that eye goes back to pending.
  const removeEye = (i, eye) => setItems((prev) => prev.flatMap((x, j) => {
    if (j !== i) return [x];
    if (x.order_type !== SINGLE_PAIR) return [];
    return splitPairItem(x).filter((p) => p.pieces[0].eye !== eye).map((p) => ({ ...p, pair_group: undefined }));
  }));
  const pickModel = (i, p) => setLine(i, {
    product: p ? p.id : '', product_name: p?.name || '', lens_model: p?.name || '',
    ...(p && !items[i].unit_price ? { unit_price: parseFloat(p.cost_price) || '' } : {}),
    ...(p && !parseFloat(items[i].tax_percent) ? { tax_percent: parseFloat(p.tax_rate) || 0 } : {}),
  });

  // A customer order picked on the main screen: its lenses land in the grid, pre-filled.
  const addOrder = (rows) => {
    const added = lensItemsFromRequirements(rows, lensProducts);
    if (!added.length) { notify('Every lens on that order is already on this PO.', 'info'); return; }
    setItems((prev) => [...prev, ...added]);
    const first = rows[0];
    const ref = `Customer order ${first.sales_order_number} — ${first.customer_name || 'customer'}${first.patient_code ? ` (${first.patient_code})` : ''}`;
    setHeader((h) => ({ ...h, remarks: h.remarks ? (h.remarks.includes(first.sales_order_number) ? h.remarks : `${h.remarks}; ${ref}`) : ref }));
    if (added.some((it) => !it.product)) notify('A lens on that order has no product in the master — pick its lens model in the grid.', 'warning');
    setTimeout(() => (header.supplier || lockSupplier ? primaryRef.current : vendorInputRef.current)?.focus(), 60);
  };

  const canDraft = !editing || po.status === 'DRAFT';
  const mainStatus = canDraft ? header.submitAs || 'PENDING' : null;
  const receiveNowOffered = entryMode && !editing;

  const handlersRef = useRef({});
  handlersRef.current = {
    addOrder: () => { if (!full || !orderInputRef.current) return false; orderInputRef.current.focus(); return true; },
    primary: () => (saving ? true : receiveNowOffered ? save('ORDERED', { receivedNow: true }) : save(mainStatus)),
    submit: () => (saving ? true : save(mainStatus)),
    draft: () => { if (!canDraft || saving) return false; save('DRAFT'); return true; },
    vendor: () => { if (!vendorInputRef.current || vendorInputRef.current.disabled) return false; vendorInputRef.current.focus(); return true; },
    remarks: () => remarksRef.current?.focus(),
    help: () => setHelp(true),
  };
  const hotkeys = useMemo(() => dialogHotkeys(LENS_PO_EDITOR_SHORTCUTS, () => handlersRef.current), []);

  const COLS = 9;
  const modelOptions = lensProducts.allProducts || lensProducts;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xl" fullWidth PaperProps={keyboardPaper(hotkeys)} TransitionProps={navDialogProps.TransitionProps}>
      <DialogTitle sx={{ fontWeight: 800 }}>
        {editing ? `Lens PO ${po.po_number}` : 'Lens Purchase Order'}
        {editing && <Chip size="small" sx={{ ml: 1 }} label={statusMeta(po.status).label} color={statusMeta(po.status).color} />}
        <Typography variant="caption" display="block" color="text.secondary">
          The lenses come from the customer order exactly as sold — just choose the supplier and submit. To order one eye from a different supplier, change the supplier on that eye's row: a separate PO is created for it. No invoice, stock or accounting until the lenses are received and billed.
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Grid container spacing={1.5} sx={{ mb: 2 }}>
          <Grid item xs={12} sm={6} md={2.5}>
            <TextField size="small" fullWidth label="PO Number" value={po?.po_number || (groups.length > 1 ? `${groups.length} POs — auto-numbered on save` : 'Auto-generated on save')} disabled />
          </Grid>
          <Grid item xs={12} sm={6} md={3.5}>
            <Autocomplete options={suppliers} value={supplier} disabled={!full || lockSupplier} autoHighlight openOnFocus
              getOptionLabel={(s) => s?.name || ''} isOptionEqualToValue={(a, b) => String(a.id) === String(b.id)}
              onChange={(e, s) => { setHeader((h) => ({ ...h, supplier: s?.id || '' })); nextAfterPick(s); }}
              renderInput={(params) => <TextField {...params} inputRef={vendorInputRef} size="small" required
                label={perLineSupplier ? 'Supplier — both lenses (Alt+V)' : 'Supplier (Alt+V)'} />} />
          </Grid>
          <Grid item xs={6} md={2}>
            <QuickDatePickerField size="small" fullWidth label="Order Date" value={header.order_date || ''} disabled={scope === 'remarks'}
              onChange={(v) => setHeader((h) => ({ ...h, order_date: v?.target ? v.target.value : v }))} />
          </Grid>
          <Grid item xs={6} md={2}>
            <QuickDatePickerField size="small" fullWidth label="Expected Delivery" value={header.expected_delivery_date || ''} disabled={scope === 'remarks'}
              onChange={(v) => setHeader((h) => ({ ...h, expected_delivery_date: v?.target ? v.target.value : v }))} />
          </Grid>
          <Grid item xs={12} md={2}>
            {canDraft ? (
              <TextField select size="small" fullWidth label="Submit as" value={header.submitAs || 'PENDING'} onChange={(e) => setHeader((h) => ({ ...h, submitAs: e.target.value }))}
                SelectProps={{ ...enterOpensSelectProps }}>
                <MenuItem value="PENDING">Pending</MenuItem>
                <MenuItem value="ORDERED">Ordered (sent to lab)</MenuItem>
              </TextField>
            ) : (
              <TextField size="small" fullWidth label="Order Status" value={statusMeta(po.status).label} disabled />
            )}
          </Grid>
          <Grid item xs={12} md={full ? 6 : 12}>
            <TextField size="small" fullWidth label="Remarks (Alt+M)" value={header.remarks || ''} inputRef={remarksRef}
              onChange={(e) => setHeader((h) => ({ ...h, remarks: e.target.value }))} />
          </Grid>
          {full && (
            <Grid item xs={12} md={6}>
              <OrderPicker excludePoId={po?.id} takenKeys={takenKeys} onPick={addOrder} inputRef={orderInputRef} />
            </Grid>
          )}
        </Grid>

        <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1 }}>Lenses — {poQtyLabel(items)}</Typography>
        {!editing && groups.length > 1 && (
          <Alert severity="info" sx={{ mb: 1, py: 0 }}>
            Submitting creates <b>{groups.length} purchase orders</b> — {groups.map((g) => `${supplierName(g.supplier)} (${poQtyLabel(g.items)})`).join(' · ')} — each with the customer order reference.
          </Alert>
        )}
        {!full && <Alert severity="info" sx={{ mb: 1, py: 0 }}>This PO is {statusMeta(po.status).label} — its lenses are locked. {scope === 'header' ? 'Dates and remarks can still be changed.' : 'Only remarks can be changed.'}</Alert>}
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: 'action.hover', whiteSpace: 'nowrap' } }}>
                <TableCell>Eye</TableCell><TableCell>Customer / Order</TableCell><TableCell>Lens (as sold)</TableCell><TableCell>Power</TableCell>
                <TableCell>Supplier</TableCell><TableCell>Pair / Single</TableCell><TableCell>Quantity</TableCell><TableCell align="right">Price</TableCell><TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {items.length === 0 && (
                <TableRow><TableCell colSpan={COLS} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  No lenses yet — pick a customer order above; its lenses are filled in automatically.
                </TableCell></TableRow>
              )}
              {items.flatMap((it, i) => {
                const span = it.pieces.length || 1;
                const own = lineSupplier(it, header.supplier);
                const separate = perLineSupplier && header.supplier && own !== String(header.supplier);
                const needsModel = !it.product;
                return it.pieces.flatMap((p, k) => {
                  const first = k === 0;
                  const rxKey = `${it.key}|${p.eye}`;
                  const changed = p.original_rx && !sameRx(p.rx, p.original_rx);
                  const rows = [(
                    <TableRow key={rxKey} hover sx={first && i > 0 ? { '& td': { borderTop: '2px solid', borderTopColor: 'divider' } } : undefined}>
                      <TableCell sx={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{eyeShort(p.eye)}<Typography variant="caption" display="block" color="text.secondary">{p.eye === 'RE' ? 'Right' : 'Left'}</Typography></TableCell>
                      <TableCell><Typography variant="body2" fontWeight={700}>{p.customer_name || '—'}</Typography>
                        <Typography variant="caption" color="text.secondary">{p.sales_order_number}{p.patient_code ? ` · ${p.patient_code}` : ''}</Typography></TableCell>
                      {first && (
                        <TableCell rowSpan={span} sx={{ minWidth: 200 }}>
                          {needsModel && full ? (
                            <Autocomplete options={modelOptions} loading={productsLoading} value={null} autoHighlight size="small"
                              getOptionLabel={(o) => o?.name || ''} isOptionEqualToValue={(a, b) => String(a.id) === String(b.id)}
                              onChange={(e, v) => pickModel(i, v)}
                              renderInput={(params) => <TextField {...params} size="small" error label={`Pick lens model (sold as ${it.product_name || 'custom lens'})`} />} />
                          ) : (
                            <Typography variant="body2" fontWeight={700}>{it.lens_model || it.product_name}</Typography>
                          )}
                          <Typography variant="caption" color="text.secondary">{[it.lens_type, it.lens_index && `Index ${it.lens_index}`, it.lens_coating].filter(Boolean).join(' · ') || '—'}</Typography>
                        </TableCell>
                      )}
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                        {rxSummary(p.rx) || '—'}
                        {changed && <Chip size="small" color="warning" label="Rx changed" sx={{ ml: 0.5, height: 16 }} />}
                      </TableCell>
                      <TableCell sx={{ minWidth: 200 }}>
                        {perLineSupplier ? (
                          <>
                            <TextField select size="small" fullWidth value={it.supplier || ''}
                              onChange={(e) => setItems((prev) => setEyeSupplier(prev, i, p.eye, e.target.value, header.supplier))}
                              SelectProps={{ ...enterOpensSelectProps, displayEmpty: true }} inputProps={{ 'aria-label': `Supplier for ${eyeShort(p.eye)} lens of line ${i + 1}` }}>
                              <MenuItem value=""><em>{supplier ? `${supplier.name} (PO supplier)` : 'PO supplier (select above)'}</em></MenuItem>
                              {suppliers.filter((s) => String(s.id) !== String(header.supplier)).map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
                            </TextField>
                            {separate && <Typography variant="caption" color="primary" fontWeight={700}>Separate PO</Typography>}
                          </>
                        ) : (
                          <Typography variant="body2">{supplier?.name || po?.supplier_name || '—'}</Typography>
                        )}
                      </TableCell>
                      {first && (
                        <TableCell rowSpan={span}>
                          {perLineSupplier && (it.order_type === SINGLE_PAIR || (it.order_type === SINGLE_PIECE && hasOtherEye(it, i))) ? (
                            <Tooltip title={it.order_type === SINGLE_PAIR ? 'Single: order RE and LE as separate lenses' : 'Pair: order both eyes together from one supplier'}>
                              <ToggleButtonGroup exclusive size="small" color="primary" value={it.order_type} onChange={(e, v) => v && toPairOrSingle(i, v)}>
                                <ToggleButton value={SINGLE_PAIR} sx={{ py: 0.25, px: 1, fontWeight: 700 }}>Pair</ToggleButton>
                                <ToggleButton value={SINGLE_PIECE} sx={{ py: 0.25, px: 1, fontWeight: 700 }}>Single</ToggleButton>
                              </ToggleButtonGroup>
                            </Tooltip>
                          ) : (
                            <Chip size="small" variant="outlined" label={ORDER_TYPES[it.order_type]?.short || it.order_type} />
                          )}
                        </TableCell>
                      )}
                      {first && <TableCell rowSpan={span} sx={{ whiteSpace: 'nowrap', fontWeight: 700 }}>{lpoQtyLabel(it.order_type, 1)}</TableCell>}
                      {first && (
                        <TableCell rowSpan={span} align="right" sx={{ minWidth: 130 }}>
                          {full ? (
                            <TextField size="small" type="number" value={it.unit_price ?? ''} onChange={(e) => setLine(i, { unit_price: e.target.value })}
                              inputProps={{ 'aria-label': `Price for line ${i + 1}`, style: { textAlign: 'right' } }}
                              InputProps={{ startAdornment: <InputAdornment position="start"><CurrencySymbol /></InputAdornment>,
                                endAdornment: <InputAdornment position="end">/{it.pricing_unit === 'PIECE' ? 'pc' : 'pr'}</InputAdornment> }} />
                          ) : (it.unit_price ? `${currencyPrefix()}${it.unit_price}/${it.pricing_unit === 'PIECE' ? 'pc' : 'pr'}` : '—')}
                        </TableCell>
                      )}
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        {full && (
                          <>
                            <Tooltip title={rxOpen[rxKey] ? 'Hide prescription' : 'Check / correct the prescription'}>
                              <IconButton size="small" color={rxOpen[rxKey] ? 'primary' : 'default'} onClick={() => setRxOpen((o) => ({ ...o, [rxKey]: !o[rxKey] }))}><EditIcon fontSize="small" /></IconButton>
                            </Tooltip>
                            <Tooltip title={`Remove the ${eyeShort(p.eye)} lens (it stays pending on the order)`}>
                              <IconButton size="small" color="error" onClick={() => removeEye(i, p.eye)}><DeleteIcon fontSize="small" /></IconButton>
                            </Tooltip>
                          </>
                        )}
                      </TableCell>
                    </TableRow>
                  )];
                  if (full && rxOpen[rxKey]) {
                    rows.push(
                      <TableRow key={`${rxKey}|rx`}>
                        <TableCell colSpan={COLS} sx={{ bgcolor: 'action.hover' }}>
                          <PieceRxEditor piece={p} onChange={(np) => setPiece(i, k, np)} title={`${eyeLabel(p.eye)} · ${p.customer_name} · ${p.sales_order_number}`} />
                        </TableCell>
                      </TableRow>,
                    );
                  }
                  return rows;
                });
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} disabled={saving}>Close</Button>
        <KeyHint>Enter: next field · Alt+A: add a customer order · Ctrl+Enter: {receiveNowOffered ? 'add to Purchase Entry' : 'submit'} · Ctrl+/: all keys</KeyHint>
        {canDraft && <Button variant="outlined" disabled={saving} onClick={() => save('DRAFT')}>Save Draft (Alt+D)</Button>}
        <Button ref={receiveNowOffered ? undefined : primaryRef} variant={entryMode ? 'outlined' : 'contained'} disabled={saving} onClick={() => save(mainStatus)} sx={{ fontWeight: 800 }}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SendIcon />} {...navStop(!receiveNowOffered)}>
          {canDraft ? `${groups.length > 1 && !editing ? `Submit ${groups.length} Orders` : 'Submit Order'}${entryMode ? ' — receive later (Alt+O)' : ' (Ctrl+Enter)'}` : 'Save Changes (Ctrl+Enter)'}
        </Button>
        {receiveNowOffered && (
          <Tooltip title="The lenses are here now: save the order, mark every lens received and add them to this Purchase Entry.">
            <Button ref={primaryRef} variant="contained" color="success" disabled={saving} onClick={() => save('ORDERED', { receivedNow: true })} sx={{ fontWeight: 800 }}
              startIcon={<ReceiveIcon />} {...navStop()}>Lenses Received — Add to Purchase Entry (Ctrl+Enter)</Button>
          </Tooltip>
        )}
      </DialogActions>
      <ShortcutHelpDialog open={help} onClose={() => setHelp(false)} shortcuts={LENS_PO_EDITOR_SHORTCUTS} title="Lens Purchase Order" />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Receive lenses
// ---------------------------------------------------------------------------

function ReceiveDialog({ po, onClose, onDone }) {
  const pending = useMemo(() => (po?.items || []).flatMap((it) => it.pieces.filter((p) => p.receiving_status !== 'RECEIVED')
    .map((p) => ({ ...p, lens_model: it.lens_model || it.product_name }))), [po]);
  const [rows, setRows] = useState({});
  const [saving, setSaving] = useState(false);
  // The day the lenses actually arrived — often not the PO's expected delivery date.
  const today = new Date().toISOString().slice(0, 10);
  const [receivedDate, setReceivedDate] = useState(today);
  const expected = po?.expected_delivery_date ? String(po.expected_delivery_date).slice(0, 10) : '';
  useEffect(() => {
    const init = {};
    pending.forEach((p) => { init[p.id] = { selected: true, status: 'RECEIVED', piece_reference: p.piece_reference || '', notes: '', modelOk: true, rxOk: true }; });
    setRows(init);
  }, [pending]);
  const set = (id, patch) => setRows((r) => ({ ...r, [id]: { ...r[id], ...patch } }));

  const submit = async () => {
    const chosen = pending.filter((p) => rows[p.id]?.selected).map((p) => {
      const r = rows[p.id];
      const status = r.status === 'RECEIVED' && (!r.modelOk || !r.rxOk) ? 'INCORRECT' : r.status;
      const auto = status === 'INCORRECT' && !r.notes ? [!r.modelOk && 'Wrong lens model', !r.rxOk && 'Prescription does not match'].filter(Boolean).join('; ') : '';
      return { id: p.id, status, piece_reference: r.piece_reference, notes: r.notes || auto };
    });
    if (!chosen.length) { notify('Select at least one lens.', 'warning'); return; }
    if (!receivedDate || receivedDate > today) { notify('Enter the date the lenses were actually received (today or earlier).', 'warning'); return; }
    setSaving(true);
    try {
      const res = await axios.post(`${API}${po.id}/receive/`, { pieces: chosen, received_date: receivedDate });
      const got = chosen.filter((c) => c.status === 'RECEIVED').length;
      notify(`${got} lens(es) received${chosen.length > got ? `, ${chosen.length - got} discrepancy(ies) recorded` : ''}. Linked sales orders updated.`, 'success');
      onDone(res.data);
    } catch (err) {
      notify(errText(err, 'Could not record the receipt.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth
      PaperProps={{ onKeyDown: (e) => { if (e.ctrlKey && e.key === 'Enter' && !saving) { e.preventDefault(); submit(); } } }}>
      <DialogTitle sx={{ fontWeight: 800 }}>Mark as Received — {po.po_number}
        <Typography variant="caption" display="block" color="text.secondary">
          Vendor: {po.supplier_name} · Ordered: {poQtyLabel(po.items)} · Received so far: {po.summary?.received || 0} of {po.summary?.pieces || 0} lenses.
          Verify each lens separately. Stock is added only when the PO is converted to a purchase invoice.
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        {pending.length === 0 ? <Alert severity="success">Every lens on this PO has been received.</Alert> : (
          <TableContainer component={Paper} variant="outlined">
            <Table size="small">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: 'action.hover' } }}>
                  <TableCell padding="checkbox" /><TableCell>Piece</TableCell><TableCell>Customer / Order</TableCell><TableCell>Lens · Eye · Rx</TableCell>
                  <TableCell>Verify</TableCell><TableCell>Result</TableCell><TableCell>Barcode / Ref</TableCell><TableCell>Discrepancy note</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pending.map((p) => {
                  const r = rows[p.id] || {};
                  return (
                    <TableRow key={p.id} hover selected={r.selected}>
                      <TableCell padding="checkbox"><Checkbox checked={!!r.selected} onChange={(e) => set(p.id, { selected: e.target.checked })} /></TableCell>
                      <TableCell>{p.piece_number}{p.receiving_status !== 'PENDING' && <Chip size="small" sx={{ ml: 0.5 }} color={RECEIVING_STATUSES[p.receiving_status]?.color} label={RECEIVING_STATUSES[p.receiving_status]?.label} />}</TableCell>
                      <TableCell><Typography variant="body2" fontWeight={700}>{p.customer_name}</Typography><Typography variant="caption">{p.sales_order_number}</Typography></TableCell>
                      <TableCell><Typography variant="body2">{p.lens_model} · <b>{eyeShort(p.eye)}</b></Typography><Typography variant="caption" sx={{ fontFamily: 'monospace' }}>{rxSummary(p.rx)}</Typography></TableCell>
                      <TableCell>
                        <FormControlLabel control={<Checkbox size="small" checked={!!r.modelOk} onChange={(e) => set(p.id, { modelOk: e.target.checked })} />} label={<Typography variant="caption">Model OK</Typography>} />
                        <FormControlLabel control={<Checkbox size="small" checked={!!r.rxOk} onChange={(e) => set(p.id, { rxOk: e.target.checked })} />} label={<Typography variant="caption">Rx OK</Typography>} />
                      </TableCell>
                      <TableCell>
                        <TextField select size="small" value={r.status || 'RECEIVED'} onChange={(e) => set(p.id, { status: e.target.value })} sx={{ minWidth: 130 }}>
                          {['RECEIVED', 'DAMAGED', 'MISSING', 'INCORRECT'].map((s) => <MenuItem key={s} value={s}>{RECEIVING_STATUSES[s].label}</MenuItem>)}
                        </TextField>
                      </TableCell>
                      <TableCell><TextField size="small" value={r.piece_reference || ''} onChange={(e) => set(p.id, { piece_reference: e.target.value })} sx={{ minWidth: 120 }} /></TableCell>
                      <TableCell><TextField size="small" value={r.notes || ''} placeholder={r.status !== 'RECEIVED' || !r.modelOk || !r.rxOk ? 'Required' : ''}
                        error={(r.status !== 'RECEIVED') && !r.notes} onChange={(e) => set(p.id, { notes: e.target.value })} sx={{ minWidth: 160 }} /></TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        {pending.length > 0 && (
          <TextField type="date" size="small" label="Actual Received Date" value={receivedDate}
            onChange={(e) => setReceivedDate(e.target.value)} InputLabelProps={{ shrink: true }}
            inputProps={{ max: today }} sx={{ mr: 'auto', width: 230 }}
            helperText={expected ? `Expected ${expected.split('-').reverse().join('-')}${receivedDate && receivedDate !== expected ? (receivedDate > expected ? ' — arrived late' : ' — arrived early') : ''}` : ' '} />
        )}
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        {pending.length > 0 && <Button variant="contained" color="success" onClick={submit} disabled={saving} startIcon={<ReceiveIcon />} sx={{ fontWeight: 800 }}>Confirm Receipt (Ctrl+Enter)</Button>}
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// PO details
// ---------------------------------------------------------------------------

function LensPODetail({ po, onClose, actions }) {
  const navigate = useNavigate();
  const pieces = (po.items || []).flatMap((it) => it.pieces.map((p) => ({ ...p, lens_model: it.lens_model || it.product_name, order_type: it.order_type })));
  const orders = [...new Map(pieces.map((p) => [p.sales_order, p])).values()];
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>
        Lens PO {po.po_number} <Chip size="small" sx={{ ml: 1 }} label={statusMeta(po.status).label} color={statusMeta(po.status).color} />
        <Typography variant="caption" display="block" color="text.secondary">
          {po.supplier_name} · Ordered {po.order_date}{po.expected_delivery_date ? ` · Expected ${po.expected_delivery_date}` : ''} · {poQtyLabel(po.items)}
          {po.created_by_name ? ` · Raised by ${po.created_by_name}` : ''}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        {po.purchase_invoice_number && <Alert severity="success" sx={{ mb: 2, py: 0 }}>Billed on Purchase Entry <b>{po.purchase_invoice_number}</b> ({po.purchase_invoice_status}).</Alert>}
        <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: 'action.hover' } }}>
                <TableCell>Piece</TableCell><TableCell>Lens Model</TableCell><TableCell>Type</TableCell><TableCell>Customer</TableCell><TableCell>Sales Order</TableCell>
                <TableCell>Eye</TableCell><TableCell>SPH</TableCell><TableCell>CYL</TableCell><TableCell>AXIS</TableCell><TableCell>ADD</TableCell>
                <TableCell>Ref</TableCell><TableCell>Receiving</TableCell><TableCell>Fitting</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {pieces.map((p) => {
                const c = rxCells(p.rx);
                return (
                  <TableRow key={p.id}>
                    <TableCell>{p.piece_number}</TableCell>
                    <TableCell>{p.lens_model}</TableCell>
                    <TableCell><Typography variant="caption">{ORDER_TYPES[p.order_type]?.short}</Typography></TableCell>
                    <TableCell><Typography variant="body2" fontWeight={700}>{p.customer_name}</Typography><Typography variant="caption" color="text.secondary">{p.patient_code}</Typography></TableCell>
                    <TableCell>{p.sales_order_number}<Typography variant="caption" display="block" color="text.secondary">{p.sales_order_status || ''}</Typography></TableCell>
                    <TableCell sx={{ fontWeight: 800 }}>{eyeShort(p.eye)}</TableCell>
                    <TableCell>{c.sph}</TableCell><TableCell>{c.cyl}</TableCell><TableCell>{c.axis}</TableCell><TableCell>{c.add}</TableCell>
                    <TableCell>{p.piece_reference || '—'}{p.rx_changed && <Tooltip title={`Changed from ${rxSummary(p.original_rx)}: ${p.rx_change_reason}`}><Chip size="small" color="warning" label="Rx changed" sx={{ ml: 0.5, height: 18 }} /></Tooltip>}</TableCell>
                    <TableCell>
                      <Chip size="small" label={RECEIVING_STATUSES[p.receiving_status]?.label} color={RECEIVING_STATUSES[p.receiving_status]?.color} />
                      {p.discrepancy_notes && <Typography variant="caption" display="block" color="error">{p.discrepancy_notes}</Typography>}
                      {p.received_at && <Typography variant="caption" display="block" color="text.secondary">{new Date(p.received_at).toLocaleString()}{p.received_by ? ` · ${p.received_by}` : ''}</Typography>}
                    </TableCell>
                    <TableCell><Typography variant="caption">{FITTING_STATUSES[p.fitting_status] || p.fitting_status}</Typography></TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>

        <Grid container spacing={2}>
          <Grid item xs={12} md={5}>
            <Typography variant="subtitle2" fontWeight={800} gutterBottom>Linked sales orders</Typography>
            {orders.map((p) => (
              <Stack key={p.sales_order} direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
                <Chip size="small" clickable color="primary" variant="outlined" label={p.sales_order_number}
                  onClick={() => navigate('/sales/orders')} />
                <Typography variant="body2">{p.customer_name}</Typography>
                <Typography variant="caption" color="text.secondary">{p.sales_order_status || 'Order Received'}</Typography>
              </Stack>
            ))}
            {po.remarks && <Typography variant="body2" sx={{ mt: 1 }}><b>Remarks:</b> {po.remarks}</Typography>}
          </Grid>
          <Grid item xs={12} md={7}>
            <Typography variant="subtitle2" fontWeight={800} gutterBottom>Audit trail</Typography>
            <Box sx={{ maxHeight: 220, overflow: 'auto', pr: 1 }}>
              {[...(po.history || [])].reverse().map((h, i) => (
                <Box key={i} sx={{ mb: 0.75, pl: 1, borderLeft: 2, borderColor: 'divider' }}>
                  <Typography variant="caption" color="text.secondary">{new Date(h.at).toLocaleString()}{h.by ? ` · ${h.by}` : ''}</Typography>
                  <Typography variant="body2"><b>{String(h.action).replace(/_/g, ' ')}</b>{h.detail ? ` — ${h.detail}` : ''}</Typography>
                </Box>
              ))}
            </Box>
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5, flexWrap: 'wrap', gap: 1 }}>
        <Button onClick={onClose}>Close</Button>
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<PrintIcon />} onClick={() => printLensPO(po, { variant: 'vendor' })}>Print Vendor Copy</Button>
        <Button startIcon={<PrintIcon />} onClick={() => printLensPO(po, { variant: 'internal' })}>Print Internal Copy</Button>
        {actions.canReceive(po) && <Button variant="contained" color="success" startIcon={<ReceiveIcon />} onClick={() => actions.receive(po)}>Mark as Received</Button>}
        {actions.canConvert(po) && <Button variant="contained" startIcon={<InvoiceIcon />} onClick={() => actions.convert(po)}>
          {po.purchase_invoice ? 'Open Purchase Invoice' : 'Convert to Purchase Invoice / Receive Stock'}</Button>}
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

const useLensDashboardShortcuts = makeShortcutHook(LENS_DASHBOARD_SHORTCUTS, ['Alt+N', 'Alt+S', 'Alt+F', 'Ctrl+/']);

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// `focus` comes from Sales > Orders > Lenses. {receivePoId, search, at} ("Receive Lenses"): the
// list is searched for that PO and its receive dialog opens once the POs have loaded.
// {salesOrderId, at} ("Order from Supplier"): the Lens PO screen opens straight away with that
// customer order's outstanding lenses, ready for supplier selection.
export default function LensPurchaseOrderView({ suppliers: allSuppliers = [], onConvertToInvoice, onOpenInvoice, focus = null }) {
  // Only suppliers saved on the server can be a PO's vendor (browser-only rows have no UUID).
  const suppliers = useMemo(() => allSuppliers.filter((s) => UUID_RE.test(String(s.id))), [allSuppliers]);
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [editor, setEditor] = useState(null); // {po?, seed?}
  const [detail, setDetail] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [menu, setMenu] = useState(null); // {anchor, po}
  const { lensProducts, productsLoading } = useLensProducts();
  const debounced = useDebounce(search, 250);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const [help, setHelp] = useState(false);
  useLensDashboardShortcuts(rootRef, {
    newPo: () => setEditor({}),
    search: () => searchRef.current?.focus(),
    help: () => setHelp(true),
  });

  const load = useCallback(() => {
    setLoading(true);
    return axios.get(API).then((res) => setOrders(res.data?.results || res.data || []))
      .catch(() => notify('Could not load lens purchase orders.', 'error'))
      .finally(() => setLoading(false));
  }, []);
  useEffect(() => { load(); }, [load]);

  const focusDoneRef = useRef(null);
  const salesSeedRef = useRef(null);
  useEffect(() => {
    if (!focus?.salesOrderId || productsLoading || salesSeedRef.current === focus.at) return;
    salesSeedRef.current = focus.at;
    axios.get(`${API}pending-requirements/`, { params: { sales_order: focus.salesOrderId } })
      .then((res) => {
        const reqs = Array.isArray(res.data) ? res.data : [];
        if (!reqs.length) { notify('Every lens on this order is already on a lens purchase order.', 'info'); return; }
        const items = lensItemsFromRequirements(reqs, lensProducts);
        const first = reqs[0];
        setEditor({ seed: {
          items,
          remarks: `Customer order ${first.sales_order_number} — ${first.customer_name || 'customer'}${first.patient_code ? ` (${first.patient_code})` : ''}`,
        } });
        if (items.some((it) => !it.product)) notify('A lens on this order has no product in the master — edit it and pick the lens model.', 'warning');
      })
      .catch((err) => notify(errText(err, 'Could not load the lenses of that order.'), 'error'));
  }, [focus, productsLoading, lensProducts]);

  useEffect(() => {
    if (!focus?.at || focus.salesOrderId || focusDoneRef.current === focus.at) return;
    if (focus.search) setSearch(focus.search);
    if (loading) return;
    focusDoneRef.current = focus.at;
    const po = orders.find((o) => String(o.id) === String(focus.receivePoId));
    if (po && ['PENDING', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status)) setReceiving(po);
    else if (focus.receivePoId) notify('That lens purchase order can no longer receive lenses.', 'warning');
  }, [focus, loading, orders]);

  const replace = (po) => {
    setOrders((prev) => (prev.some((o) => o.id === po.id) ? prev.map((o) => (o.id === po.id ? po : o)) : [po, ...prev]));
    if (detail?.id === po.id) setDetail(po);
  };

  const counts = useMemo(() => {
    const c = { total: orders.length };
    Object.keys(LPO_STATUSES).forEach((s) => { c[s] = orders.filter((o) => o.status === s).length; });
    return c;
  }, [orders]);

  const filtered = useMemo(() => {
    const s = debounced.trim().toLowerCase();
    return orders.filter((o) => {
      if (statusFilter === 'OPEN' ? !['PENDING', 'ORDERED'].includes(o.status) : statusFilter !== 'ALL' && o.status !== statusFilter) return false;
      if (dateFrom && o.order_date < dateFrom) return false;
      if (dateTo && o.order_date > dateTo) return false;
      if (!s) return true;
      const sm = o.summary || {};
      return [o.po_number, o.supplier_name, ...(sm.customers || []), ...(sm.sales_orders || []), ...(sm.lens_models || [])]
        .some((v) => String(v || '').toLowerCase().includes(s));
    });
  }, [orders, debounced, statusFilter, dateFrom, dateTo]);

  const post = async (po, path, body, okMsg) => {
    try {
      const res = await axios.post(`${API}${po.id}/${path}/`, body || {});
      replace(res.data);
      notify(okMsg, 'success');
      return res.data;
    } catch (err) {
      notify(errText(err, 'The action failed.'), 'error');
      return null;
    }
  };

  const actions = {
    canReceive: (po) => ['PENDING', 'ORDERED', 'PARTIALLY_RECEIVED'].includes(po.status),
    canConvert: (po) => Boolean(po.purchase_invoice) || ((po.summary?.received || 0) > 0 && po.status !== 'CANCELLED'),
    receive: (po) => setReceiving(po),
    convert: async (po) => {
      try {
        const { data } = await axios.get(`${API}${po.id}/invoice-draft/`);
        if (data.existing) {
          notify(`Opening Purchase Entry ${data.existing.invoice_number} already linked to ${po.po_number}.`, 'info');
          onOpenInvoice?.(data.existing.id);
          return;
        }
        if (data.pieces_received < data.pieces_total && !window.confirm(
          `Only ${data.pieces_received} of ${data.pieces_total} lenses have been received.\n\nThe purchase invoice will cover the received lenses only; lenses received later are added by editing that invoice. Continue?`)) return;
        onConvertToInvoice?.(po.id);
      } catch (err) {
        notify(errText(err, 'Could not prepare the purchase invoice.'), 'error');
      }
    },
  };

  const kpis = [
    { key: 'ALL', label: 'Total Lens POs', value: counts.total, color: '#2563eb' },
    { key: 'OPEN', label: 'Pending Orders', value: (counts.PENDING || 0) + (counts.ORDERED || 0), color: '#f59e0b', hint: `${counts.PENDING || 0} pending · ${counts.ORDERED || 0} at lab · ${counts.DRAFT || 0} drafts` },
    { key: 'PARTIALLY_RECEIVED', label: 'Partially Received', value: counts.PARTIALLY_RECEIVED || 0, color: '#7c3aed' },
    { key: 'RECEIVED', label: 'Received', value: counts.RECEIVED || 0, color: '#16a34a' },
    { key: 'CANCELLED', label: 'Cancelled', value: counts.CANCELLED || 0, color: '#dc2626' },
  ];

  const menuPo = menu?.po;
  return (
    <Stack spacing={3} ref={rootRef}>
      <Grid container spacing={2}>
        {kpis.map((k) => (
          <Grid item xs={6} sm={4} md={2.4} key={k.key}>
            <Paper variant="outlined" onClick={() => setStatusFilter(k.key)}
              sx={{ p: 2, borderRadius: 3, borderLeft: `4px solid ${k.color}`, cursor: 'pointer', bgcolor: statusFilter === k.key ? 'action.selected' : 'background.paper' }}>
              <Typography variant="caption" color="text.secondary" fontWeight={700}>{k.label.toUpperCase()}</Typography>
              <Typography variant="h5" fontWeight={800}>{k.value}</Typography>
              {k.hint && <Typography variant="caption" color="text.secondary">{k.hint}</Typography>}
            </Paper>
          </Grid>
        ))}
      </Grid>

      <Card sx={{ borderRadius: 3, p: 2 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} sx={{ mb: 2 }}>
          <TextField size="small" inputRef={searchRef} placeholder="Search PO number, vendor, customer or sales order (Alt+F)" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ flex: 1, minWidth: 240 }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
          <TextField select size="small" label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} sx={{ minWidth: 170 }}>
            <MenuItem value="ALL">All</MenuItem>
            <MenuItem value="OPEN">Pending + Ordered</MenuItem>
            {Object.entries(LPO_STATUSES).map(([k, v]) => <MenuItem key={k} value={k}>{v.label}</MenuItem>)}
          </TextField>
          <QuickDatePickerField size="small" label="From" value={dateFrom} onChange={(v) => setDateFrom(v?.target ? v.target.value : (v || ''))} sx={{ width: 160 }} />
          <QuickDatePickerField size="small" label="To" value={dateTo} onChange={(v) => setDateTo(v?.target ? v.target.value : (v || ''))} sx={{ width: 160 }} />
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditor({})} sx={{ fontWeight: 800, whiteSpace: 'nowrap', backgroundColor: '#2563EB' }} title="Alt+N">+ New Lens PO</Button>
        </Stack>

        {loading && <LinearProgress sx={{ mb: 1 }} />}
        <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: '65vh' }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 800, whiteSpace: 'nowrap' } }}>
                <TableCell>PO Number</TableCell><TableCell>Order Date</TableCell><TableCell>Vendor / Lab</TableCell><TableCell>Lens Model</TableCell>
                <TableCell>Order Type</TableCell><TableCell align="center">Pairs</TableCell><TableCell align="center">Pieces</TableCell>
                <TableCell>Customers</TableCell><TableCell>Sales Orders</TableCell><TableCell>Expected</TableCell>
                <TableCell sx={{ minWidth: 120 }}>Receiving</TableCell><TableCell>Status</TableCell><TableCell>Purchase Invoice</TableCell><TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!loading && filtered.length === 0 && (
                <TableRow><TableCell colSpan={14} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                  {orders.length ? 'No lens purchase orders match these filters.' : 'No lens purchase orders yet — click "+ New Lens PO", or use "Order from Supplier" on a customer order in Sales → Orders → Lenses.'}
                </TableCell></TableRow>
              )}
              {filtered.map((o) => {
                const sm = o.summary || {};
                const pct = sm.pieces ? (sm.received / sm.pieces) * 100 : 0;
                const meta = statusMeta(o.status);
                return (
                  <TableRow key={o.id} hover sx={{ cursor: 'pointer' }} onClick={() => setDetail(o)}>
                    <TableCell sx={{ fontWeight: 800, color: 'primary.main', whiteSpace: 'nowrap' }}>{o.po_number}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{o.order_date}</TableCell>
                    <TableCell>{o.supplier_name}</TableCell>
                    <TableCell>{(sm.lens_models || []).join(', ') || '—'}</TableCell>
                    <TableCell>{(sm.order_types || []).map((t) => <Chip key={t} size="small" variant="outlined" label={ORDER_TYPES[t]?.short || t} sx={{ mr: 0.5 }} />)}</TableCell>
                    <TableCell align="center">{sm.pairs || 0}</TableCell>
                    <TableCell align="center">{sm.pieces || 0}</TableCell>
                    <TableCell sx={{ maxWidth: 180 }}><Typography variant="body2" noWrap title={(sm.customers || []).join(', ')}>{(sm.customers || []).join(', ') || '—'}</Typography></TableCell>
                    <TableCell sx={{ maxWidth: 160 }}><Typography variant="body2" noWrap title={(sm.sales_orders || []).join(', ')}>{(sm.sales_orders || []).join(', ') || '—'}</Typography></TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{o.expected_delivery_date || '—'}</TableCell>
                    <TableCell>
                      <Typography variant="caption" fontWeight={700}>{sm.received || 0}/{sm.pieces || 0} lenses{sm.discrepancies ? ` · ${sm.discrepancies} issue(s)` : ''}</Typography>
                      <LinearProgress variant="determinate" value={pct} color={pct === 100 ? 'success' : 'primary'} sx={{ height: 6, borderRadius: 3 }} />
                    </TableCell>
                    <TableCell><Chip size="small" label={meta.label} color={meta.color} sx={{ fontWeight: 700 }} /></TableCell>
                    <TableCell>{o.purchase_invoice_number || '—'}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      <Tooltip title="View details"><IconButton size="small" onClick={() => setDetail(o)}><ViewIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="Print PO"><IconButton size="small" onClick={() => printLensPO(o, { variant: 'vendor' })}><PrintIcon fontSize="small" /></IconButton></Tooltip>
                      {actions.canReceive(o) && <Tooltip title="Mark as Received"><IconButton size="small" color="success" onClick={() => setReceiving(o)}><ReceiveIcon fontSize="small" /></IconButton></Tooltip>}
                      <IconButton size="small" onClick={(e) => setMenu({ anchor: e.currentTarget, po: o })}><MoreIcon fontSize="small" /></IconButton>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      <Menu anchorEl={menu?.anchor} open={Boolean(menu)} onClose={() => setMenu(null)}>
        {menuPo && [
          <MenuItem key="view" onClick={() => { setDetail(menuPo); setMenu(null); }}><ListItemIcon><ViewIcon fontSize="small" /></ListItemIcon><ListItemText>View details / linked sales orders</ListItemText></MenuItem>,
          menuPo.status !== 'CANCELLED' && (
            <MenuItem key="edit" onClick={() => { setEditor({ po: menuPo }); setMenu(null); }}><ListItemIcon><EditIcon fontSize="small" /></ListItemIcon>
              <ListItemText>{['DRAFT', 'PENDING'].includes(menuPo.status) ? 'Edit' : 'Edit remarks / dates'}</ListItemText></MenuItem>),
          menuPo.status === 'DRAFT' && (
            <MenuItem key="submit" onClick={() => { post(menuPo, 'submit', null, `${menuPo.po_number} submitted.`); setMenu(null); }}><ListItemIcon><SendIcon fontSize="small" /></ListItemIcon><ListItemText>Submit order</ListItemText></MenuItem>),
          menuPo.status === 'PENDING' && (
            <MenuItem key="ordered" onClick={() => { post(menuPo, 'mark-ordered', null, `${menuPo.po_number} marked as ordered.`); setMenu(null); }}><ListItemIcon><OrderedIcon fontSize="small" /></ListItemIcon><ListItemText>Mark as Ordered (sent to lab)</ListItemText></MenuItem>),
          <MenuItem key="print-v" onClick={() => { printLensPO(menuPo, { variant: 'vendor' }); setMenu(null); }}><ListItemIcon><PrintIcon fontSize="small" /></ListItemIcon><ListItemText>Print / Reprint vendor copy</ListItemText></MenuItem>,
          <MenuItem key="print-vc" onClick={() => { printLensPO(menuPo, { variant: 'vendor', showCustomerOnVendor: true }); setMenu(null); }}><ListItemIcon><PrintIcon fontSize="small" /></ListItemIcon><ListItemText>Print vendor copy with customer names</ListItemText></MenuItem>,
          <MenuItem key="print-i" onClick={() => { printLensPO(menuPo, { variant: 'internal' }); setMenu(null); }}><ListItemIcon><PrintIcon fontSize="small" /></ListItemIcon><ListItemText>Print internal copy</ListItemText></MenuItem>,
          actions.canReceive(menuPo) && (
            <MenuItem key="recv" onClick={() => { setReceiving(menuPo); setMenu(null); }}><ListItemIcon><ReceiveIcon fontSize="small" /></ListItemIcon><ListItemText>Mark as Received</ListItemText></MenuItem>),
          actions.canConvert(menuPo) && (
            <MenuItem key="conv" onClick={() => { actions.convert(menuPo); setMenu(null); }}><ListItemIcon><InvoiceIcon fontSize="small" /></ListItemIcon>
              <ListItemText>{menuPo.purchase_invoice ? `Open ${menuPo.purchase_invoice_number}` : 'Convert to Purchase Invoice'}</ListItemText></MenuItem>),
          <Divider key="d" />,
          !['CANCELLED', 'RECEIVED', 'PARTIALLY_RECEIVED'].includes(menuPo.status) && !menuPo.purchase_invoice && (
            <MenuItem key="cancel" sx={{ color: 'error.main' }} onClick={() => {
              setMenu(null);
              const reason = window.prompt(`Cancel ${menuPo.po_number}? Its lenses become orderable again.\n\nReason (optional):`, '');
              if (reason !== null) post(menuPo, 'cancel', { reason }, `${menuPo.po_number} cancelled.`);
            }}><ListItemIcon><CancelIcon fontSize="small" color="error" /></ListItemIcon><ListItemText>Cancel PO</ListItemText></MenuItem>),
          menuPo.status === 'DRAFT' && (
            <MenuItem key="del" sx={{ color: 'error.main' }} onClick={async () => {
              setMenu(null);
              if (!window.confirm(`Delete draft ${menuPo.po_number}?`)) return;
              try { await axios.delete(`${API}${menuPo.id}/`); setOrders((p) => p.filter((x) => x.id !== menuPo.id)); notify('Draft deleted.', 'success'); }
              catch (err) { notify(errText(err, 'Could not delete the draft.'), 'error'); }
            }}><ListItemIcon><DeleteIcon fontSize="small" color="error" /></ListItemIcon><ListItemText>Delete draft</ListItemText></MenuItem>),
        ].filter(Boolean)}
      </Menu>

      {editor && (
        <LensPOEditor open po={editor.po} seed={editor.seed} suppliers={suppliers} lensProducts={lensProducts} productsLoading={productsLoading}
          onClose={() => setEditor(null)} onPartial={(list) => list.forEach(replace)}
          onSaved={(po, { all } = {}) => { (all || [po]).forEach(replace); setEditor(null); }} />
      )}
      {detail && <LensPODetail po={detail} onClose={() => setDetail(null)} actions={actions} />}
      <ShortcutHelpDialog open={help} onClose={() => setHelp(false)} shortcuts={LENS_DASHBOARD_SHORTCUTS} title="Lens Purchase Orders" />
      {receiving && <ReceiveDialog po={receiving} onClose={() => setReceiving(null)} onDone={(po) => { replace(po); setReceiving(null); }} />}
    </Stack>
  );
}
