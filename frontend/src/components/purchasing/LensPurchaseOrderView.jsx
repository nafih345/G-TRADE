import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Typography, Button, Grid, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper,
  Chip, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem, Stack, IconButton, Tooltip,
  InputAdornment, Autocomplete, CircularProgress, LinearProgress, Stepper, Step, StepLabel, ToggleButton,
  ToggleButtonGroup, Alert, Divider, Checkbox, FormControlLabel, Menu, ListItemIcon, ListItemText,
} from '@mui/material';
import {
  Add as AddIcon, Search as SearchIcon, Print as PrintIcon, Visibility as ViewIcon, Edit as EditIcon,
  MoreVert as MoreIcon, Inventory2 as ReceiveIcon, ReceiptLong as InvoiceIcon, Cancel as CancelIcon,
  Send as SendIcon, LocalShipping as OrderedIcon, Delete as DeleteIcon, CallSplit as SplitIcon, Lock as LockIcon,
  LockOpen as UnlockIcon,
} from '@mui/icons-material';
import QuickDatePickerField from '../common/QuickDatePickerField';
import { useDebounce } from '../../hooks/useDebounce';
import { fetchAllPages } from '../../utils/fetchAllPages';
import { isPairSellable, formatDioptre } from '../../utils/lensUnits';
import { notify } from '../../utils/notify';
import { printLensPO } from '../../utils/printLensPO';
import {
  navScopeProps, navDialogProps, enterOpensSelectProps, focusNextAfterRender, focusField, getNavFields,
} from '../../pages/wholesale/keyboardNav';
import { makeShortcutHook } from '../../pages/wholesale/posShortcuts';
import { ShortcutHelpDialog } from '../../pages/wholesale/WholesaleDialogs';
import {
  LENS_ITEM_SHORTCUTS, LENS_PO_EDITOR_SHORTCUTS, LENS_DASHBOARD_SHORTCUTS, dialogHotkeys,
} from './lensPoShortcuts';
import {
  SINGLE_PAIR, SPLIT_PAIR, SINGLE_PIECE, ORDER_TYPES, LPO_STATUSES, RECEIVING_STATUSES, FITTING_STATUSES, statusMeta,
  eyeLabel, eyeShort, lpoQtyLabel, poQtyLabel, rxCells, rxSummary, sameRx, pieceFromRequirement, draftItemErrors,
  itemPayload, draftFromItem,
} from '../../utils/lensPurchaseOrders';

const API = '/api/purchase/lens-orders/';
const todayStr = () => new Date().toISOString().slice(0, 10);
const errText = (err, fallback) => {
  const d = err?.response?.data;
  if (!d) return fallback;
  if (typeof d === 'string') return d.slice(0, 300);
  const flat = (v) => (Array.isArray(v) ? v.map(flat).join(' ') : typeof v === 'object' && v ? Object.values(v).map(flat).join(' ') : String(v));
  return flat(d.detail ?? d) || fallback;
};
const LENS_TYPES = ['Single Vision', 'Bifocal', 'Progressive', 'Office / Computer', 'Kryptok'];
const LENS_INDEXES = ['1.50', '1.56', '1.59', '1.60', '1.67', '1.74'];
const LENS_COATINGS = ['HMC', 'Blue Cut', 'UC (Uncoated)', 'Hard Coat', 'Photochromic', 'Anti-Glare'];
const ORDER_TYPE_SEQUENCE = [SINGLE_PAIR, SPLIT_PAIR, SINGLE_PIECE];

// Keyboard model (see lensPoShortcuts.js): every dialog's Paper is one keyboardNav scope — Enter /
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

function PieceRxEditor({ piece, onChange, title, unlockTick = 0 }) {
  const [unlocked, setUnlocked] = useState(false);
  useEffect(() => { if (unlockTick) setUnlocked(true); }, [unlockTick]);
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
              {locked ? 'Edit Rx (Alt+R)' : 'Lock Rx'}
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
// Pending sales-order lens requirement picker
// ---------------------------------------------------------------------------

function RequirementPicker({ label, product, excludePoId, pairMode, takenKeys, value, onChange, disabledOrder }) {
  const [input, setInput] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  const term = useDebounce(input, 300);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    axios.get(`${API}pending-requirements/`, { params: { search: term || undefined, product: product || undefined, exclude_po: excludePoId || undefined } })
      .then((res) => {
        if (!alive) return;
        let rows = Array.isArray(res.data) ? res.data : [];
        rows = rows.filter((r) => r.outstanding - (takenKeys?.[`${r.sales_order}|${r.product}|${r.eye}`] || 0) > 0);
        if (pairMode) {
          // One option per order whose lens line still needs BOTH eyes.
          const byOrder = {};
          rows.forEach((r) => {
            const k = `${r.sales_order}|${r.product}`;
            (byOrder[k] = byOrder[k] || { ...r, eyes: {} }).eyes[r.eye] = r;
          });
          rows = Object.values(byOrder).filter((o) => o.eyes.RE && o.eyes.LE);
        }
        setOptions(rows);
      })
      .catch(() => alive && setOptions([]))
      .finally(() => alive && setLoading(false));
    return () => { alive = false; };
  }, [term, product, excludePoId, pairMode, takenKeys]);

  const optionKey = (o) => `${o.sales_order}|${o.product}|${pairMode ? 'PAIR' : o.eye}`;
  return (
    <Autocomplete
      options={options}
      value={value}
      loading={loading}
      filterOptions={(x) => x}
      autoHighlight
      openOnFocus
      isOptionEqualToValue={(a, b) => optionKey(a) === optionKey(b)}
      getOptionDisabled={(o) => Boolean(disabledOrder) && o.sales_order === disabledOrder}
      getOptionLabel={(o) => (o ? `${o.customer_name || 'Customer'} — ${o.sales_order_number}${pairMode ? '' : ` — ${eyeShort(o.eye)}`}` : '')}
      onInputChange={(e, v, reason) => { if (reason === 'input') setInput(v); }}
      onChange={(e, v) => { onChange(v); nextAfterPick(v); }}
      noOptionsText={product ? 'No pending sales orders need this lens. Check the lens model or the order.' : 'No pending lens orders'}
      renderOption={(props, o) => (
        <li {...props} key={optionKey(o)}>
          <Box sx={{ width: '100%' }}>
            <Stack direction="row" justifyContent="space-between" spacing={1}>
              <Typography variant="body2" fontWeight={800}>{o.customer_name || 'Customer'}{o.patient_code ? ` · ${o.patient_code}` : ''}</Typography>
              <Typography variant="caption" fontWeight={700} color="primary">{o.sales_order_number} · {o.order_date}</Typography>
            </Stack>
            <Typography variant="caption" color="text.secondary" component="div">
              {o.product_name}{o.lens_index ? ` (${o.lens_index})` : ''} · {pairMode ? 'Both eyes' : eyeLabel(o.eye)} · {o.order_status || 'Order Received'}
            </Typography>
            <Typography variant="caption" component="div" sx={{ fontFamily: 'monospace' }}>
              {pairMode
                ? `OD ${rxSummary(o.eyes.RE.rx) || '—'} | OS ${rxSummary(o.eyes.LE.rx) || '—'}`
                : (o.rx_summary || 'No prescription on the order')}
            </Typography>
          </Box>
        </li>
      )}
      renderInput={(params) => (
        <TextField {...params} size="small" label={label} placeholder="Search customer, phone, patient code or sales order"
          InputProps={{ ...params.InputProps, endAdornment: <>{loading ? <CircularProgress size={16} /> : null}{params.InputProps.endAdornment}</> }} />
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// Add lens dialog (Single Customer / Split Pair / Single Lens) — a 4-step flow
// ---------------------------------------------------------------------------

const emptyDraft = (orderType) => ({
  key: `${Date.now()}-${Math.random()}`, product: '', product_name: '', lens_model: '', lens_type: '', lens_index: '',
  lens_coating: '', order_type: orderType, unit_price: '', pricing_unit: ORDER_TYPES[orderType].unit,
  discount_amount: 0, tax_percent: 0, pieces: [],
});

function LensItemDialog({ open, initial, orderType, lensProducts, productsLoading, excludePoId, takenKeys, askVendor, suppliers, vendorId, onClose, onAdd, onSaveDraft }) {
  const [draft, setDraft] = useState(() => initial || emptyDraft(orderType || SPLIT_PAIR));
  const [step, setStep] = useState(0);
  const [vendor, setVendor] = useState(vendorId || '');
  const [reqA, setReqA] = useState(null);
  const [reqB, setReqB] = useState(null);
  const [showAll, setShowAll] = useState(false);
  const [rxUnlockTick, setRxUnlockTick] = useState(0);
  const [help, setHelp] = useState(false);
  const contentRef = useRef(null);
  const addBtnRef = useRef(null);
  const typeGroupRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setDraft(initial || emptyDraft(orderType || SPLIT_PAIR));
    setStep(0); setReqA(null); setReqB(null); setVendor(vendorId || '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Each step starts with the cursor in its first field; the Review step on "Add to PO".
  useEffect(() => {
    setRxUnlockTick(0); // Alt+R unlocks only the step it was pressed on
    const t = setTimeout(() => {
      if (step > 0 && step === stepsCountRef.current - 1) addBtnRef.current?.focus();
      else if (step > 0) focusField(getNavFields(contentRef.current)[0]);
    }, 80);
    return () => clearTimeout(t);
  }, [step]);

  const type = draft.order_type;
  const isSplit = type === SPLIT_PAIR;
  const steps = ['Lens Model', isSplit ? 'Customer A' : 'Customer', ...(isSplit ? ['Customer B'] : []), 'Review'];
  const reviewStep = steps.length - 1;
  const stepsCountRef = useRef(steps.length);
  stepsCountRef.current = steps.length;
  const product = lensProducts.find((p) => String(p.id) === String(draft.product)) || null;
  const piece = (i) => draft.pieces[i];
  const setPiece = (i, p) => setDraft((d) => { const pieces = [...d.pieces]; pieces[i] = p; return { ...d, pieces }; });

  const setType = (t) => {
    if (!t || t === type) return;
    setDraft((d) => ({ ...d, order_type: t, pricing_unit: ORDER_TYPES[t].unit, pieces: [] }));
    setReqA(null); setReqB(null);
  };

  const pickA = (r) => {
    setReqA(r);
    if (!r) { setDraft((d) => ({ ...d, pieces: d.pieces.slice(isSplit ? 1 : 0, isSplit ? 2 : 0) })); return; }
    if (type === SINGLE_PAIR) {
      setDraft((d) => ({ ...d, pieces: [pieceFromRequirement(r.eyes.RE, 'RE'), pieceFromRequirement(r.eyes.LE, 'LE')] }));
    } else {
      setDraft((d) => { const pieces = [...d.pieces]; pieces[0] = pieceFromRequirement(r, r.eye); return { ...d, pieces }; });
    }
  };
  const pickB = (r) => {
    setReqB(r);
    setDraft((d) => { const pieces = [...d.pieces]; pieces[1] = r ? pieceFromRequirement(r, r.eye) : undefined; return { ...d, pieces: pieces.filter(Boolean) }; });
  };

  const stepErrors = () => {
    if (step === 0) {
      const e = [];
      if (!draft.product) e.push('Select the lens model.');
      if (askVendor && !vendor) e.push('Select the vendor / laboratory.');
      return e;
    }
    if (step === 1 && !piece(0)) return [isSplit ? 'Select Customer A.' : 'Select the customer.'];
    if (isSplit && step === 2 && !piece(1)) return ['Select Customer B.'];
    if (step === reviewStep) return draftItemErrors(draft).concat(askVendor && !vendor ? ['Select the vendor / laboratory.'] : []);
    return [];
  };
  const errs = stepErrors();
  const next = () => {
    if (errs.length) { notify(errs[0], 'warning'); return; }
    setStep((s) => Math.min(reviewStep, s + 1));
  };
  const finish = (fn) => {
    const e = draftItemErrors(draft);
    if (askVendor && !vendor) e.push('Select the vendor / laboratory.');
    if (e.length) { notify(e[0], 'warning'); return; }
    fn(draft, vendor);
  };

  const options = showAll ? lensProducts.allProducts || lensProducts : lensProducts;
  const reviewPieces = draft.pieces;

  const focusTypeButton = () => setTimeout(() => typeGroupRef.current?.querySelector('[aria-pressed="true"]')?.focus(), 30);
  const chooseType = (t) => {
    if (step !== 0 || initial) return false;
    setType(t);
    focusTypeButton();
    return true;
  };
  // ←/→ on the order-type buttons change the type; Enter moves on to the next field.
  const onTypeKeys = (e) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const i = ORDER_TYPE_SEQUENCE.indexOf(type);
    const n = ORDER_TYPE_SEQUENCE.length;
    chooseType(ORDER_TYPE_SEQUENCE[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n]);
  };
  const handlersRef = useRef({});
  handlersRef.current = {
    type1: () => chooseType(SINGLE_PAIR),
    type2: () => chooseType(SPLIT_PAIR),
    type3: () => chooseType(SINGLE_PIECE),
    next: () => (step < reviewStep ? next() : finish(onAdd)),
    back: () => { if (step === 0) return false; setStep((st) => st - 1); return true; },
    draft: () => { if (!onSaveDraft) return false; finish(onSaveDraft); return true; },
    editRx: () => {
      if (step === 0 || step === reviewStep) return false;
      setRxUnlockTick((t) => t + 1);
      setTimeout(() => contentRef.current?.querySelector('input[data-rx-sph]:not([disabled])')?.focus(), 60);
      return true;
    },
    help: () => setHelp(true),
  };
  const hotkeys = useMemo(() => dialogHotkeys(LENS_ITEM_SHORTCUTS, () => handlersRef.current), []);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth disableRestoreFocus
      {...navDialogProps} PaperProps={keyboardPaper(hotkeys)}>
      <DialogTitle sx={{ fontWeight: 800 }}>
        {initial ? 'Edit Lens' : isSplit ? 'Add Split Pair Lens' : type === SINGLE_PAIR ? 'Add Single Customer Pair' : 'Add Single Lens'}
        <Typography variant="caption" display="block" color="text.secondary">Nothing is invoiced and no stock moves until the lenses are received and converted to a purchase invoice.</Typography>
      </DialogTitle>
      <DialogContent dividers ref={contentRef}>
        <Stepper activeStep={step} alternativeLabel sx={{ mb: 2 }}>
          {steps.map((s) => <Step key={s}><StepLabel>{s}</StepLabel></Step>)}
        </Stepper>

        {step === 0 && (
          <Stack spacing={2}>
            <ToggleButtonGroup ref={typeGroupRef} exclusive size="small" color="primary" value={type} onChange={(e, v) => setType(v)}
              disabled={Boolean(initial)} onKeyDown={onTypeKeys}>
              {[
                [SINGLE_PAIR, 'Single Customer — 1 Pair (2 Pieces)', 'Alt+1'],
                [SPLIT_PAIR, 'Split Pair — 2 Customers', 'Alt+2'],
                [SINGLE_PIECE, 'Single Lens — 1 Piece', 'Alt+3'],
              ].map(([value, label, keys]) => (
                // Only the selected type is a stop in the Enter chain; ←/→ switch between them.
                <ToggleButton key={value} value={value} sx={{ fontWeight: 700 }} title={`${keys} · ←/→ to change, Enter to continue`}
                  tabIndex={value === type ? 0 : -1} {...(value === type ? { 'data-nav-stop': 'advance' } : {})}>
                  {value === SPLIT_PAIR && <SplitIcon fontSize="small" sx={{ mr: 0.5 }} />}{label}
                </ToggleButton>
              ))}
            </ToggleButtonGroup>
            {askVendor && (
              <TextField select size="small" label="Vendor / Laboratory" value={vendor} onChange={(e) => setVendor(e.target.value)} required
                SelectProps={{ ...enterOpensSelectProps }}>
                {suppliers.map((s) => <MenuItem key={s.id} value={s.id}>{s.name}</MenuItem>)}
              </TextField>
            )}
            <Grid container spacing={1.5}>
              <Grid item xs={12} md={6}>
                <Autocomplete
                  options={options}
                  loading={productsLoading}
                  value={product}
                  autoHighlight
                  openOnFocus
                  getOptionLabel={(p) => p?.name || ''}
                  isOptionEqualToValue={(a, b) => String(a.id) === String(b.id)}
                  onChange={(e, p) => {
                    setDraft((d) => ({
                      ...d, product: p ? p.id : '', product_name: p?.name || '', lens_model: p?.name || '',
                      unit_price: d.unit_price || (p ? (parseFloat(p.cost_price) || '') : ''),
                      lens_index: d.lens_index || (p?.name?.match(/\b1\.(5|6|7)\d\b/) || [''])[0],
                      tax_percent: d.tax_percent || parseFloat(p?.tax_rate) || 0,
                    }));
                    setReqA(null); setReqB(null);
                    setDraft((d) => ({ ...d, pieces: [] }));
                    nextAfterPick(p);
                  }}
                  renderOption={(props, p) => (
                    <li {...props} key={p.id}>
                      <Box><Typography variant="body2" fontWeight={700}>{p.name}</Typography>
                        <Typography variant="caption" color="text.secondary">{p.category_name || 'Lens'} · Stock {p.stock ?? 0} · Cost ₹{p.cost_price || 0}</Typography></Box>
                    </li>
                  )}
                  renderInput={(params) => <TextField {...params} size="small" label="Lens Product / Model" required />}
                />
                <FormControlLabel sx={{ mt: 0.5 }} control={<Checkbox size="small" checked={showAll} onChange={(e) => setShowAll(e.target.checked)} />}
                  label={<Typography variant="caption">Show all products (not only lens categories)</Typography>} />
              </Grid>
              <Grid item xs={6} md={3}>
                <Autocomplete freeSolo autoHighlight options={LENS_TYPES} inputValue={draft.lens_type || ''}
                  onInputChange={(e, v) => setDraft((d) => ({ ...d, lens_type: v }))} onChange={(e, v) => nextAfterPick(v)}
                  renderInput={(params) => <TextField {...params} size="small" label="Lens Type" />} />
              </Grid>
              <Grid item xs={6} md={3}>
                <Autocomplete freeSolo autoHighlight options={LENS_INDEXES} inputValue={draft.lens_index || ''}
                  onInputChange={(e, v) => setDraft((d) => ({ ...d, lens_index: v }))} onChange={(e, v) => nextAfterPick(v)}
                  renderInput={(params) => <TextField {...params} size="small" label="Material / Index" />} />
              </Grid>
              <Grid item xs={6} md={3}>
                <Autocomplete freeSolo autoHighlight options={LENS_COATINGS} inputValue={draft.lens_coating || ''}
                  onInputChange={(e, v) => setDraft((d) => ({ ...d, lens_coating: v }))} onChange={(e, v) => nextAfterPick(v)}
                  renderInput={(params) => <TextField {...params} size="small" label="Coating" />} />
              </Grid>
              <Grid item xs={6} md={3}>
                <TextField size="small" fullWidth label="Purchase price" type="number" value={draft.unit_price}
                  onChange={(e) => setDraft((d) => ({ ...d, unit_price: e.target.value }))}
                  InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }} />
              </Grid>
              <Grid item xs={6} md={3}>
                <TextField size="small" fullWidth select label="Price per" value={draft.pricing_unit} onChange={(e) => setDraft((d) => ({ ...d, pricing_unit: e.target.value }))}
                  SelectProps={{ ...enterOpensSelectProps }}>
                  <MenuItem value="PAIR">Pair (2 lenses)</MenuItem>
                  <MenuItem value="PIECE">Piece (1 lens)</MenuItem>
                </TextField>
              </Grid>
              <Grid item xs={6} md={3}>
                <TextField size="small" fullWidth label="GST %" type="number" value={draft.tax_percent} onChange={(e) => setDraft((d) => ({ ...d, tax_percent: e.target.value }))} />
              </Grid>
            </Grid>
            <Alert severity="info" sx={{ py: 0 }}>
              Order quantity: <b>{lpoQtyLabel(type, 1)}</b>{isSplit ? ' — one lens for each of two customers, priced together as one pair.' : ''}
            </Alert>
          </Stack>
        )}

        {step >= 1 && step < reviewStep && (() => {
          const idx = step - 1;
          const isA = idx === 0;
          return (
            <Stack spacing={2}>
              <RequirementPicker
                label={type === SINGLE_PAIR ? 'Customer / sales order (both eyes)' : `Customer ${isSplit ? (isA ? 'A' : 'B') : ''} / sales order`}
                product={draft.product}
                excludePoId={excludePoId}
                pairMode={type === SINGLE_PAIR}
                takenKeys={takenKeys}
                value={isA ? reqA : reqB}
                disabledOrder={isSplit && !isA ? reqA?.sales_order : (isSplit && isA ? reqB?.sales_order : null)}
                onChange={isA ? pickA : pickB}
              />
              {type === SINGLE_PAIR
                ? draft.pieces.map((p, i) => <PieceRxEditor key={p.eye} piece={p} onChange={(np) => setPiece(i, np)} unlockTick={rxUnlockTick}
                    title={`Piece ${i + 1} — ${eyeLabel(p.eye)} · ${p.customer_name} · ${p.sales_order_number}`} />)
                : piece(idx) && (
                  <>
                    <Stack direction="row" spacing={2} alignItems="center">
                      <Typography variant="body2"><b>{piece(idx).customer_name}</b> · {piece(idx).sales_order_number}</Typography>
                      <TextField select size="small" label="Eye" value={piece(idx).eye} sx={{ minWidth: 160 }} disabled
                        helperText="From the sales order line">
                        <MenuItem value="RE">Right (OD)</MenuItem>
                        <MenuItem value="LE">Left (OS)</MenuItem>
                      </TextField>
                    </Stack>
                    <PieceRxEditor piece={piece(idx)} onChange={(np) => setPiece(idx, np)} unlockTick={rxUnlockTick}
                      title={`Lens ${idx + 1} — Piece ${idx + 1} · ${eyeLabel(piece(idx).eye)}`} />
                  </>
                )}
            </Stack>
          );
        })()}

        {step === reviewStep && (
          <Stack spacing={1.5}>
            <Stack direction="row" spacing={3} flexWrap="wrap">
              <Typography variant="body2"><b>Lens Model:</b> {draft.lens_model || draft.product_name}</Typography>
              <Typography variant="body2"><b>Order Type:</b> {ORDER_TYPES[type].short}</Typography>
              <Typography variant="body2"><b>Total:</b> {lpoQtyLabel(type, 1)}</Typography>
              {draft.unit_price ? <Typography variant="body2"><b>Price:</b> ₹{draft.unit_price} / {draft.pricing_unit === 'PIECE' ? 'piece' : 'pair'}</Typography> : null}
            </Stack>
            <TableContainer component={Paper} variant="outlined">
              <Table size="small">
                <TableHead><TableRow><TableCell sx={{ fontWeight: 800 }}>Detail</TableCell>
                  {reviewPieces.map((p, i) => <TableCell key={i} sx={{ fontWeight: 800 }}>Lens {i + 1}</TableCell>)}</TableRow></TableHead>
                <TableBody>
                  {[
                    ['Customer', (p) => p.customer_name || '—'],
                    ['Sales Order', (p) => p.sales_order_number || '—'],
                    ['Eye', (p) => eyeLabel(p.eye)],
                    ['SPH', (p) => rxCells(p.rx).sph], ['CYL', (p) => rxCells(p.rx).cyl],
                    ['AXIS', (p) => rxCells(p.rx).axis], ['ADD', (p) => rxCells(p.rx).add],
                    ['Rx', (p) => (sameRx(p.rx, p.original_rx) ? 'As per sales order' : `Changed: ${p.rx_change_reason || '(reason missing)'}`)],
                    ['Status', () => 'Pending'],
                  ].map(([label, fn]) => (
                    <TableRow key={label}><TableCell sx={{ fontWeight: 700, color: 'text.secondary' }}>{label}</TableCell>
                      {reviewPieces.map((p, i) => <TableCell key={i}>{fn(p)}</TableCell>)}</TableRow>
                  ))}
                </TableBody>
              </Table>
            </TableContainer>
            {errs.map((e) => <Alert key={e} severity="error" sx={{ py: 0 }}>{e}</Alert>)}
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose}>Cancel</Button>
        <KeyHint>Enter: next field · Ctrl+Enter: {step < reviewStep ? 'next step' : (initial ? 'update' : 'add to PO')} · Alt+B: back · Ctrl+/: all keys</KeyHint>
        {step > 0 && <Button onClick={() => setStep((s) => s - 1)}>Back (Alt+B)</Button>}
        {step < reviewStep && <Button variant="contained" onClick={next} {...navStop()}>Next</Button>}
        {step === reviewStep && onSaveDraft && <Button variant="outlined" onClick={() => finish(onSaveDraft)}>Save Draft (Alt+D)</Button>}
        {step === reviewStep && <Button ref={addBtnRef} variant="contained" onClick={() => finish(onAdd)} sx={{ fontWeight: 800 }} {...navStop()}>
          {initial ? 'Update Lens' : 'Add to PO'} (Enter)</Button>}
      </DialogActions>
      <ShortcutHelpDialog open={help} onClose={() => setHelp(false)} shortcuts={LENS_ITEM_SHORTCUTS} title="Add Lens" />
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Create / edit a Lens PO
// ---------------------------------------------------------------------------

// Lens models come from the product master: spectacle-lens categories first; the lens dialog
// can widen to every product for shops whose lens categories are named differently.
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

/** Create / edit a Lens PO. `entryMode` = opened from Purchase Entry: the vendor follows the
 *  entry's supplier, and "Lenses received now" saves the PO, receives every lens and hands the
 *  PO back (onSaved(po, { receivedNow: true })) so the entry can bill it in the same sitting. */
export function LensPOEditor({ open, po, seed, suppliers, lensProducts, productsLoading, onClose, onSaved, entryMode = false, lockSupplier = false, startWith = null }) {
  const editing = Boolean(po?.id);
  const scope = !editing || ['DRAFT', 'PENDING'].includes(po.status) ? 'full' : po.status === 'ORDERED' ? 'header' : 'remarks';
  const [header, setHeader] = useState({});
  const [items, setItems] = useState([]);
  const [itemDialog, setItemDialog] = useState(null); // {orderType, initial, index}
  const [saving, setSaving] = useState(false);
  const [help, setHelp] = useState(false);
  const vendorInputRef = useRef(null);
  const remarksRef = useRef(null);
  const primaryRef = useRef(null);
  const itemDialogOpenRef = useRef(false);
  itemDialogOpenRef.current = Boolean(itemDialog);

  useEffect(() => {
    if (!open) return;
    setHeader({
      supplier: po?.supplier || seed?.supplier || '', order_date: po?.order_date || todayStr(),
      expected_delivery_date: po?.expected_delivery_date || '', remarks: po?.remarks || '',
      submitAs: po?.status && po.status !== 'DRAFT' ? po.status : 'PENDING',
    });
    setItems((po?.items || []).map(draftFromItem).concat(seed?.items || []));
    if (startWith) setItemDialog({ orderType: startWith });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Requirements already claimed by unsaved lines in this editor (the server excludes this PO's
  // saved lines itself), so the picker never offers the same eye twice.
  const takenKeys = useMemo(() => {
    const out = {};
    items.forEach((it, i) => {
      if (itemDialog && itemDialog.index === i) return;
      it.pieces.forEach((p) => { const k = `${p.sales_order}|${p.product}|${p.eye}`; out[k] = (out[k] || 0) + 1; });
    });
    return out;
  }, [items, itemDialog]);

  const save = async (status, { receivedNow = false } = {}) => {
    if (!header.supplier) { notify('Select the vendor / laboratory.', 'warning'); return; }
    if (status !== 'DRAFT' && !items.length) { notify('Add at least one lens before submitting.', 'warning'); return; }
    if (receivedNow && !window.confirm('Confirm every lens on this order has arrived and matches its model and prescription?\n\n'
      + 'They are marked Received (linked sales orders are updated) and added to this Purchase Entry.')) return;
    setSaving(true);
    try {
      const body = { supplier: header.supplier, order_date: header.order_date, expected_delivery_date: header.expected_delivery_date || null, remarks: header.remarks };
      let res;
      if (editing) {
        if (scope === 'full') body.items = items.map(itemPayload);
        if (scope === 'remarks') { delete body.order_date; delete body.expected_delivery_date; delete body.supplier; }
        res = await axios.patch(`${API}${po.id}/`, body);
        if (status && status !== 'DRAFT' && po.status === 'DRAFT') res = await axios.post(`${API}${po.id}/submit/`);
        if (status === 'ORDERED' && res.data.status === 'PENDING') res = await axios.post(`${API}${po.id}/mark-ordered/`);
      } else {
        res = await axios.post(API, { ...body, status, items: items.map(itemPayload) });
      }
      if (receivedNow) {
        const pieces = res.data.items.flatMap((it) => it.pieces).filter((p) => p.receiving_status !== 'RECEIVED');
        if (pieces.length) res = await axios.post(`${API}${res.data.id}/receive/`, { pieces: pieces.map((p) => ({ id: p.id, status: 'RECEIVED' })) });
      }
      notify(`Lens PO ${res.data.po_number} ${editing ? 'updated' : 'saved'}${res.data.status === 'DRAFT' ? ' as draft' : ''}${receivedNow ? ' and received' : ''}.`, 'success');
      onSaved(res.data, { receivedNow });
    } catch (err) {
      notify(errText(err, 'Could not save the lens purchase order.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  const supplier = suppliers.find((s) => String(s.id) === String(header.supplier)) || null;
  const canDraft = !editing || po.status === 'DRAFT';
  const mainStatus = canDraft ? header.submitAs || 'PENDING' : null;
  const receiveNowOffered = entryMode && !editing;

  // Back from the lens dialog: to the vendor if it is still empty, otherwise to the primary button.
  const afterItemDialog = () => setTimeout(() => {
    if (!header.supplier && !lockSupplier) vendorInputRef.current?.focus();
    else primaryRef.current?.focus();
  }, 60);
  const addLens = (orderType) => { if (scope !== 'full') return false; setItemDialog({ orderType }); return true; };
  const handlersRef = useRef({});
  handlersRef.current = {
    addSplit: () => addLens(SPLIT_PAIR),
    addPair: () => addLens(SINGLE_PAIR),
    addPiece: () => addLens(SINGLE_PIECE),
    primary: () => (saving ? true : receiveNowOffered ? save('ORDERED', { receivedNow: true }) : save(mainStatus)),
    submit: () => (saving ? true : save(mainStatus)),
    draft: () => { if (!canDraft || saving) return false; save('DRAFT'); return true; },
    vendor: () => { if (!vendorInputRef.current || vendorInputRef.current.disabled) return false; vendorInputRef.current.focus(); return true; },
    remarks: () => remarksRef.current?.focus(),
    help: () => setHelp(true),
  };
  const hotkeys = useMemo(() => dialogHotkeys(LENS_PO_EDITOR_SHORTCUTS, () => handlersRef.current), []);
  // The first field gets the cursor once the dialog is in — unless a lens dialog opened on top
  // of it straight away (Purchase Entry → Split Pair), which keeps the cursor.
  const transitionProps = useMemo(() => ({
    onEntered: (node) => { if (!itemDialogOpenRef.current) navDialogProps.TransitionProps.onEntered(node); },
  }), []);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth PaperProps={keyboardPaper(hotkeys)} TransitionProps={transitionProps}>
      <DialogTitle sx={{ fontWeight: 800 }}>
        {editing ? `Lens PO ${po.po_number}` : 'New Lens Purchase Order'}
        {editing && <Chip size="small" sx={{ ml: 1 }} label={statusMeta(po.status).label} color={statusMeta(po.status).color} />}
        <Typography variant="caption" display="block" color="text.secondary">
          A Lens PO is a request to the lab. It does not create a purchase invoice, add stock or post accounting.
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Grid container spacing={1.5} sx={{ mb: 2 }}>
          <Grid item xs={12} sm={6} md={3}>
            <TextField size="small" fullWidth label="PO Number" value={po?.po_number || 'Auto-generated on save'} disabled />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Autocomplete options={suppliers} value={supplier} disabled={scope !== 'full' || lockSupplier} autoHighlight openOnFocus
              getOptionLabel={(s) => s?.name || ''} isOptionEqualToValue={(a, b) => String(a.id) === String(b.id)}
              onChange={(e, s) => { setHeader((h) => ({ ...h, supplier: s?.id || '' })); nextAfterPick(s); }}
              renderInput={(params) => <TextField {...params} inputRef={vendorInputRef} size="small" label="Vendor / Laboratory (Alt+V)" required />} />
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
            {(!editing || po.status === 'DRAFT') ? (
              <TextField select size="small" fullWidth label="Submit as" value={header.submitAs || 'PENDING'} onChange={(e) => setHeader((h) => ({ ...h, submitAs: e.target.value }))}
                SelectProps={{ ...enterOpensSelectProps }}>
                <MenuItem value="PENDING">Pending</MenuItem>
                <MenuItem value="ORDERED">Ordered (sent to lab)</MenuItem>
              </TextField>
            ) : (
              <TextField size="small" fullWidth label="Order Status" value={statusMeta(po.status).label} disabled />
            )}
          </Grid>
          <Grid item xs={12}>
            <TextField size="small" fullWidth label="Remarks (Alt+M)" value={header.remarks || ''} inputRef={remarksRef}
              onChange={(e) => setHeader((h) => ({ ...h, remarks: e.target.value }))} />
          </Grid>
        </Grid>

        <Stack direction="row" spacing={1} sx={{ mb: 1 }} flexWrap="wrap" useFlexGap>
          <Typography variant="subtitle1" fontWeight={800} sx={{ flex: 1 }}>Lenses — {poQtyLabel(items)}</Typography>
          {scope === 'full' && (
            <>
              {/* While no lens is on the PO, Enter from Remarks lands on these (↑/↓ between them). */}
              <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={() => setItemDialog({ orderType: SINGLE_PAIR })} {...navStop(!items.length)}>Single Customer Pair (Alt+P)</Button>
              <Button size="small" variant="contained" startIcon={<SplitIcon />} onClick={() => setItemDialog({ orderType: SPLIT_PAIR })} sx={{ fontWeight: 800 }} {...navStop(!items.length)}>+ Add Split Pair Lens (Alt+S)</Button>
              <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={() => setItemDialog({ orderType: SINGLE_PIECE })} {...navStop(!items.length)}>Single Lens (Alt+L)</Button>
            </>
          )}
        </Stack>
        {scope !== 'full' && <Alert severity="info" sx={{ mb: 1, py: 0 }}>This PO is {statusMeta(po.status).label} — its lenses are locked. {scope === 'header' ? 'Dates and remarks can still be changed.' : 'Only remarks can be changed.'}</Alert>}
        <TableContainer component={Paper} variant="outlined">
          <Table size="small">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: 'action.hover' } }}>
                <TableCell>#</TableCell><TableCell>Lens Model</TableCell><TableCell>Order Type</TableCell><TableCell>Quantity</TableCell>
                <TableCell>Lens assignments (customer · order · eye · Rx)</TableCell><TableCell align="right">Price</TableCell><TableCell />
              </TableRow>
            </TableHead>
            <TableBody>
              {items.length === 0 && (
                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 4, color: 'text.secondary' }}>No lenses yet — add a Single Customer Pair, a Split Pair or a Single Lens.</TableCell></TableRow>
              )}
              {items.map((it, i) => (
                <TableRow key={it.key} hover>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell><Typography variant="body2" fontWeight={700}>{it.lens_model || it.product_name}</Typography>
                    <Typography variant="caption" color="text.secondary">{[it.lens_type, it.lens_index, it.lens_coating].filter(Boolean).join(' · ')}</Typography></TableCell>
                  <TableCell><Chip size="small" variant="outlined" label={ORDER_TYPES[it.order_type]?.short} color={it.order_type === SPLIT_PAIR ? 'secondary' : 'default'} /></TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap', fontWeight: 700 }}>{lpoQtyLabel(it.order_type, 1)}</TableCell>
                  <TableCell>
                    {it.pieces.map((p, k) => (
                      <Typography key={k} variant="caption" component="div">
                        <b>P{k + 1}</b> {p.customer_name} · {p.sales_order_number} · <b>{eyeShort(p.eye)}</b> · <span style={{ fontFamily: 'monospace' }}>{rxSummary(p.rx)}</span>
                        {!sameRx(p.rx, p.original_rx) && <Chip size="small" color="warning" label="Rx changed" sx={{ ml: 0.5, height: 16 }} />}
                      </Typography>
                    ))}
                  </TableCell>
                  <TableCell align="right">{it.unit_price ? `₹${it.unit_price}/${it.pricing_unit === 'PIECE' ? 'pc' : 'pr'}` : '—'}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {scope === 'full' && (
                      <>
                        <IconButton size="small" onClick={() => setItemDialog({ orderType: it.order_type, initial: it, index: i })}><EditIcon fontSize="small" /></IconButton>
                        <IconButton size="small" color="error" onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}><DeleteIcon fontSize="small" /></IconButton>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} disabled={saving}>Close</Button>
        <KeyHint>Enter: next field · Alt+S/P/L: add lens · Ctrl+Enter: {receiveNowOffered ? 'add to Purchase Entry' : 'submit'} · Ctrl+/: all keys</KeyHint>
        {canDraft && <Button variant="outlined" disabled={saving} onClick={() => save('DRAFT')}>Save Draft (Alt+D)</Button>}
        <Button ref={receiveNowOffered ? undefined : primaryRef} variant={entryMode ? 'outlined' : 'contained'} disabled={saving} onClick={() => save(mainStatus)} sx={{ fontWeight: 800 }}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SendIcon />} {...navStop(!receiveNowOffered)}>
          {canDraft ? (entryMode ? 'Submit Order — receive later (Alt+O)' : 'Submit Order (Ctrl+Enter)') : 'Save Changes (Ctrl+Enter)'}
        </Button>
        {receiveNowOffered && (
          <Tooltip title="The lenses are here now: save the order, mark every lens received and add them to this Purchase Entry.">
            <Button ref={primaryRef} variant="contained" color="success" disabled={saving} onClick={() => save('ORDERED', { receivedNow: true })} sx={{ fontWeight: 800 }}
              startIcon={<ReceiveIcon />} {...navStop()}>Lenses Received — Add to Purchase Entry (Ctrl+Enter)</Button>
          </Tooltip>
        )}
      </DialogActions>
      <ShortcutHelpDialog open={help} onClose={() => setHelp(false)} shortcuts={LENS_PO_EDITOR_SHORTCUTS} title="Lens Purchase Order" />

      {itemDialog && (
        <LensItemDialog
          open
          orderType={itemDialog.orderType}
          initial={itemDialog.initial}
          lensProducts={lensProducts}
          productsLoading={productsLoading}
          excludePoId={po?.id}
          takenKeys={takenKeys}
          suppliers={suppliers}
          onClose={() => { setItemDialog(null); afterItemDialog(); }}
          onAdd={(d) => {
            setItems((prev) => (itemDialog.index !== undefined ? prev.map((x, j) => (j === itemDialog.index ? d : x)) : [...prev, d]));
            setItemDialog(null);
            afterItemDialog();
          }}
        />
      )}
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
    setSaving(true);
    try {
      const res = await axios.post(`${API}${po.id}/receive/`, { pieces: chosen });
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

export default function LensPurchaseOrderView({ suppliers: allSuppliers = [], onConvertToInvoice, onOpenInvoice }) {
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
  const [quickSplit, setQuickSplit] = useState(false);
  const [menu, setMenu] = useState(null); // {anchor, po}
  const { lensProducts, productsLoading } = useLensProducts();
  const debounced = useDebounce(search, 250);
  const rootRef = useRef(null);
  const searchRef = useRef(null);
  const [help, setHelp] = useState(false);
  useLensDashboardShortcuts(rootRef, {
    newPo: () => setEditor({}),
    split: () => setQuickSplit(true),
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

  const saveQuickSplit = async (draft, vendor, status) => {
    try {
      const res = await axios.post(API, { supplier: vendor, order_date: todayStr(), status, items: [itemPayload(draft)] });
      replace(res.data);
      notify(`Lens PO ${res.data.po_number} saved${status === 'DRAFT' ? ' as draft' : ''}.`, 'success');
      setQuickSplit(false);
    } catch (err) {
      notify(errText(err, 'Could not save the lens purchase order.'), 'error');
    }
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
          <Button variant="outlined" startIcon={<SplitIcon />} onClick={() => setQuickSplit(true)} sx={{ fontWeight: 800, whiteSpace: 'nowrap' }} title="Alt+S">+ Add Split Pair Lens</Button>
          <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditor({})} sx={{ fontWeight: 800, whiteSpace: 'nowrap', backgroundColor: '#2563EB' }} title="Alt+N">+ New Lens Purchase Order</Button>
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
                  {orders.length ? 'No lens purchase orders match these filters.' : 'No lens purchase orders yet — click "+ New Lens Purchase Order" to order lenses from a lab.'}
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
                    <TableCell>{(sm.order_types || []).map((t) => <Chip key={t} size="small" variant="outlined" label={ORDER_TYPES[t]?.short || t} color={t === SPLIT_PAIR ? 'secondary' : 'default'} sx={{ mr: 0.5 }} />)}</TableCell>
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
          onClose={() => setEditor(null)} onSaved={(po) => { replace(po); setEditor(null); }} />
      )}
      {quickSplit && (
        <LensItemDialog open orderType={SPLIT_PAIR} askVendor suppliers={suppliers} lensProducts={lensProducts} productsLoading={productsLoading}
          takenKeys={null} onClose={() => setQuickSplit(false)}
          onSaveDraft={(d, vendor) => saveQuickSplit(d, vendor, 'DRAFT')}
          onAdd={(d, vendor) => { setQuickSplit(false); setEditor({ seed: { supplier: vendor, items: [d] } }); }} />
      )}
      {detail && <LensPODetail po={detail} onClose={() => setDetail(null)} actions={actions} />}
      <ShortcutHelpDialog open={help} onClose={() => setHelp(false)} shortcuts={LENS_DASHBOARD_SHORTCUTS} title="Lens Purchase Orders" />
      {receiving && <ReceiveDialog po={receiving} onClose={() => setReceiving(null)} onDone={(po) => { replace(po); setReceiving(null); }} />}
    </Stack>
  );
}
