import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { getMasterSnapshot, loadMaster } from '../../../utils/masterDataCache';
import {
  Alert, Autocomplete, Box, Button, Card, Chip, CircularProgress, Dialog, DialogActions, DialogContent,
  DialogTitle, FormControlLabel, Grid, Checkbox, IconButton, InputAdornment, MenuItem, Paper, Radio, RadioGroup, Stack,
  Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, Delete as DeleteIcon, Edit as EditIcon, Save as SaveIcon, LocalOffer as OfferIcon,
  Lock as LockIcon, Search as SearchIcon, QrCode2 as BarcodeIcon,
} from '@mui/icons-material';
import ConfirmActionDialog from '../../common/ConfirmActionDialog';
import BarcodePrintDialog from '../../inventory/BarcodePrintDialog';
import { GREEN, greenButtonSx } from '../store/storeUi';
import { notify } from '../../../utils/notify';
import { apiErrorMessage } from '../../../utils/apiError';
import { OFFER_TAGS, PRICING_RULES_API } from '../../../utils/pricingRules';

// Settings → Pricing Rules & Offers. The selling-below-cost lock (+ minimum margin) and the
// clearance / special-offer items allowed under it. Rules live server-side
// (apps/company/pricing_rules.py); New Sale checks lines against them and the server refuses the save.
const OFFERS_API = `${PRICING_RULES_API}offers/`;
const money = (n) => (n == null ? '—' : `₹${Number(n).toFixed(2)}`);
const listOf = (data) => (Array.isArray(data) ? data : data?.results || []);

const STATE_CHIP = {
  RUNNING: { label: 'Running', color: 'success' },
  SCHEDULED: { label: 'Scheduled', color: 'info' },
  EXPIRED: { label: 'Expired', color: 'default' },
  PAUSED: { label: 'Paused', color: 'warning' },
};

const EMPTY_OFFER = {
  scope: 'PRODUCT', products: [], categories: [], mode: 'PRICE', offer_price: '', tag: 'Clearance Stock',
  start_date: '', end_date: '', notes: '', apply_to_all: true, offer_quantity: '',
};

// "All stock (12)" / "3 of 10 left · 7 sold" — the offer's quantity in the list.
const offerQtyText = (o) => {
  if (o.scope !== 'PRODUCT') return 'All stock';
  if (o.apply_to_all !== false) return `All stock${o.remaining != null ? ` (${o.remaining})` : ''}`;
  return `${o.remaining ?? 0} of ${o.offer_quantity} left${o.sold ? ` · ${o.sold} sold` : ''}`;
};

// The offer tag label job for BarcodePrintDialog: the offer code, printed with the offer price as
// the selling price; one label per offer unit still left.
const offerLabelRows = (o) => {
  const price = o.offer_price != null ? Number(o.offer_price).toFixed(2) : null;
  const units = o.apply_to_all === false ? (o.remaining ?? o.offer_quantity ?? 1) : (o.stock ?? o.remaining ?? 1);
  return [{
    product: { id: o.product, name: o.product_name, barcode: o.offer_barcode },
    qty: Math.max(1, Number(units) || 1),
    barcode: o.offer_barcode,
    fields: price != null ? { selling_price: price } : {},
    job: price != null ? { offer_price: price } : {},
  }];
};

const ToggleRow = ({ title, caption, checked, onChange, disabled, children }) => (
  <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3 }}>
    <Box sx={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 3, flexWrap: 'wrap' }}>
      <Box sx={{ maxWidth: 620 }}>
        <Typography variant="subtitle1" fontWeight={800}>{title}</Typography>
        <Typography variant="body2" color="text.secondary">{caption}</Typography>
      </Box>
      <FormControlLabel
        control={<Switch checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} color="success" />}
        label={checked ? 'ON' : 'OFF'}
        labelPlacement="bottom"
        sx={{ m: 0, '& .MuiFormControlLabel-label': { fontWeight: 800, mt: 0.5 } }}
      />
    </Box>
    {children}
  </Paper>
);

export default function PricingRulesSettings() {
  const [settings, setSettings] = useState(null);
  const [saved, setSaved] = useState(null);
  const [canEdit, setCanEdit] = useState(false);
  // Show Cost Price: only the Main Admin (tenant owner / Super Admin) changes it or sees the list.
  const [canEditCost, setCanEditCost] = useState(false);
  const [costUsers, setCostUsers] = useState([]);
  const [userQuery, setUserQuery] = useState('');
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [offers, setOffers] = useState([]);
  const [loadingOffers, setLoadingOffers] = useState(true);
  const [filter, setFilter] = useState('');
  const [stateFilter, setStateFilter] = useState('ALL');
  const [dialog, setDialog] = useState(null); // null | {mode:'new'|'edit', form, offer?}
  const [deleting, setDeleting] = useState(null);
  const [printing, setPrinting] = useState(null); // offer whose tags are being printed

  const loadOffers = useCallback(async () => {
    setLoadingOffers(true);
    try {
      setOffers(listOf((await axios.get(OFFERS_API)).data));
    } catch (err) {
      notify(`Could not load offers — ${apiErrorMessage(err)}`, 'error');
    } finally {
      setLoadingOffers(false);
    }
  }, []);

  useEffect(() => {
    axios.get(PRICING_RULES_API)
      .then(res => {
        setSettings(res.data.settings); setSaved(res.data.settings); setCanEdit(!!res.data.can_edit);
        setCanEditCost(!!res.data.can_edit_cost_visibility); setCostUsers(res.data.cost_users || []);
      })
      .catch(err => notify(`Could not load pricing rules — ${apiErrorMessage(err)}`, 'error'));
    loadOffers();
  }, [loadOffers]);

  const dirty = settings && saved && JSON.stringify(settings) !== JSON.stringify(saved);
  const set = (key, value) => { setSettings(s => ({ ...s, [key]: value })); setErrors(e => ({ ...e, [key]: undefined })); };

  const save = async () => {
    setSaving(true);
    try {
      const body = canEditCost ? settings : Object.fromEntries(
        Object.entries(settings).filter(([k]) => k !== 'show_cost_price' && k !== 'cost_viewers'));
      const res = await axios.put(PRICING_RULES_API, body);
      const visibilityChanged = saved?.show_cost_price !== res.data.settings.show_cost_price
        || JSON.stringify(saved?.cost_viewers || []) !== JSON.stringify(res.data.settings.cost_viewers || []);
      setSettings(res.data.settings);
      setSaved(res.data.settings);
      if (res.data.cost_users) setCostUsers(res.data.cost_users);
      setErrors({});
      notify(visibilityChanged
        ? 'Pricing rules saved. Cost price visibility applies to each user from their next page load.'
        : 'Pricing rules saved.', 'success');
    } catch (err) {
      setErrors(err?.response?.data?.errors || {});
      notify(`Pricing rules NOT saved — ${apiErrorMessage(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const example = useMemo(() => {
    if (!settings) return '';
    const cost = 100;
    const floor = Math.max(cost * (1 + (Number(settings.min_margin_percent) || 0) / 100),
      cost + (Number(settings.min_profit_amount) || 0));
    return `Example: cost ₹${cost.toFixed(2)} → lowest selling price ₹${floor.toFixed(2)}`;
  }, [settings]);

  const viewers = useMemo(() => new Set((settings?.cost_viewers || []).map(String)), [settings]);
  const toggleViewer = (id, on) => {
    const next = new Set(viewers);
    if (on) next.add(String(id)); else next.delete(String(id));
    set('cost_viewers', costUsers.filter(u => next.has(String(u.id))).map(u => String(u.id)));
  };
  const shownUsers = useMemo(() => {
    const q = userQuery.trim().toLowerCase();
    return costUsers.filter(u => !q || [u.username, u.name, u.role].some(v => String(v || '').toLowerCase().includes(q)));
  }, [costUsers, userQuery]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return offers.filter(o => (stateFilter === 'ALL' || o.state === stateFilter)
      && (!q || [o.product_name, o.product_sku, o.product_barcode, o.category_name, o.tag, o.notes]
        .some(v => String(v || '').toLowerCase().includes(q))));
  }, [offers, filter, stateFilter]);

  const toggleActive = async (offer) => {
    try {
      const res = await axios.patch(`${OFFERS_API}${offer.id}/`, { is_active: !offer.is_active });
      setOffers(list => list.map(o => (o.id === offer.id ? res.data : o)));
    } catch (err) {
      notify(`Could not update the offer — ${apiErrorMessage(err)}`, 'error');
    }
  };

  // "Generate / Print Offer Barcode": mint the code if the offer has none yet, then open the
  // label print dialog with it (offer price as the selling price).
  const printOfferBarcode = async (offer) => {
    let target = offer;
    if (!offer.offer_barcode) {
      try {
        target = (await axios.post(`${OFFERS_API}${offer.id}/barcode/`)).data;
        setOffers(list => list.map(o => (o.id === target.id ? target : o)));
        notify(`Offer barcode ${target.offer_barcode} generated.`, 'success');
      } catch (err) {
        notify(`Could not generate the offer barcode — ${apiErrorMessage(err)}`, 'error');
        return;
      }
    }
    setPrinting(target);
  };

  const removeOffer = async () => {
    const offer = deleting;
    setDeleting(null);
    try {
      await axios.delete(`${OFFERS_API}${offer.id}/`);
      setOffers(list => list.filter(o => o.id !== offer.id));
      notify('Offer removed — the item is back under the normal price rules.', 'success');
    } catch (err) {
      notify(`Could not remove the offer — ${apiErrorMessage(err)}`, 'error');
    }
  };

  if (!settings) {
    return <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box>;
  }

  return (
    <Stack spacing={3}>
      {!canEdit && (
        <Alert severity="info" icon={<LockIcon />} sx={{ borderRadius: 3 }}>
          Only an Administrator or Manager can change pricing rules and clearance offers. You can view them here.
        </Alert>
      )}

      {/* Master switches */}
      <Card sx={{ p: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap', mb: 2 }}>
          <Box>
            <Typography variant="h6" fontWeight={800}>Pricing Rules</Typography>
            <Typography variant="body2" color="text.secondary">
              Stop products being sold below their cost price, and set a minimum margin.
            </Typography>
          </Box>
          {(canEdit || canEditCost) && (
            <Button variant="contained" startIcon={<SaveIcon />} onClick={save} disabled={!dirty || saving} sx={greenButtonSx}>
              {saving ? 'Saving…' : 'Save Rules'}
            </Button>
          )}
        </Box>

        <Stack spacing={2}>
          <ToggleRow
            title="Show Cost Price"
            caption="OFF: cost price columns and values are hidden everywhere, for every user (the server leaves them out). ON: the Main Admin always sees cost price, plus the users ticked below."
            checked={settings.show_cost_price !== false}
            onChange={(v) => set('show_cost_price', v)}
            disabled={!canEditCost}
          >
            {!canEditCost && (
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                Only the Main Admin can change who sees the cost price.
              </Typography>
            )}
            {canEditCost && settings.show_cost_price !== false && (
              <Box sx={{ mt: 2 }} data-testid="cost-viewers">
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', mb: 1 }}>
                  <Typography variant="subtitle2" fontWeight={800}>
                    Authorized Users to View Cost Price
                    <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      {viewers.size} of {costUsers.filter(u => !u.main_admin).length} staff selected
                    </Typography>
                  </Typography>
                  <TextField
                    size="small" placeholder="Search users" value={userQuery} onChange={(e) => setUserQuery(e.target.value)}
                    InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
                    sx={{ width: { xs: '100%', sm: 240 } }}
                  />
                </Box>
                {errors.cost_viewers && <Alert severity="error" sx={{ mb: 1 }}>{errors.cost_viewers}</Alert>}
                <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: 320 }}>
                  <Table size="small" stickyHeader>
                    <TableHead>
                      <TableRow>
                        <TableCell padding="checkbox" />
                        <TableCell sx={{ fontWeight: 800 }}>User</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>Role</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>Cost Price</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {shownUsers.map(u => {
                        const on = u.main_admin || viewers.has(String(u.id));
                        return (
                          <TableRow key={u.id} hover={!u.main_admin}>
                            <TableCell padding="checkbox">
                              <Checkbox
                                size="small" checked={on} disabled={u.main_admin}
                                onChange={(e) => toggleViewer(u.id, e.target.checked)}
                                inputProps={{ 'aria-label': `Allow ${u.username} to view cost price` }}
                              />
                            </TableCell>
                            <TableCell>
                              <Typography variant="body2" fontWeight={700}>{u.name}</Typography>
                              {u.name !== u.username && <Typography variant="caption" color="text.secondary">{u.username}</Typography>}
                            </TableCell>
                            <TableCell>{String(u.role || '').replace(/_/g, ' ')}</TableCell>
                            <TableCell>
                              {u.main_admin
                                ? <Chip size="small" label="Always · Main Admin" color="success" variant="outlined" />
                                : <Chip size="small" label={on ? 'Can view' : 'Hidden'} color={on ? 'success' : 'default'} />}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                      {!shownUsers.length && (
                        <TableRow><TableCell colSpan={4} sx={{ textAlign: 'center', color: 'text.secondary' }}>No users found.</TableCell></TableRow>
                      )}
                    </TableBody>
                  </Table>
                </TableContainer>
              </Box>
            )}
          </ToggleRow>

          <ToggleRow
            title="Enable Selling Below Cost Lock"
            caption="ON: a product's selling price (after discounts, before tax) cannot be lower than its cost price plus the minimum margin below — billing staff need a manager's approval. OFF: any selling price is accepted."
            checked={!!settings.cost_lock_enabled}
            onChange={(v) => set('cost_lock_enabled', v)}
            disabled={!canEdit}
          >
            <Grid container spacing={2} sx={{ mt: 1 }}>
              <Grid item xs={12} sm={6} md={4}>
                <TextField
                  label="Minimum margin over cost" type="number" fullWidth size="small"
                  value={settings.min_margin_percent}
                  onChange={(e) => set('min_margin_percent', e.target.value)}
                  disabled={!canEdit || !settings.cost_lock_enabled}
                  error={!!errors.min_margin_percent} helperText={errors.min_margin_percent || '0 = never below cost'}
                  InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment>, inputProps: { min: 0, max: 1000, step: 0.5 } }}
                />
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <TextField
                  label="Minimum profit per unit" type="number" fullWidth size="small"
                  value={settings.min_profit_amount}
                  onChange={(e) => set('min_profit_amount', e.target.value)}
                  disabled={!canEdit || !settings.cost_lock_enabled}
                  error={!!errors.min_profit_amount} helperText={errors.min_profit_amount || 'The higher of the two floors applies'}
                  InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment>, inputProps: { min: 0, step: 1 } }}
                />
              </Grid>
              <Grid item xs={12} md={4} sx={{ display: 'flex', alignItems: 'center' }}>
                <Typography variant="body2" color="text.secondary" fontWeight={600}>
                  {settings.cost_lock_enabled ? example : 'Switch the lock on to set a margin.'}
                </Typography>
              </Grid>
            </Grid>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
              Products with no cost price recorded are not checked. Services and custom lines are never checked.
            </Typography>
          </ToggleRow>

          <ToggleRow
            title="Enable Offers & Clearance Module"
            caption="ON: items listed below (dead stock, festival offers…) may be sold down to their offer price — or at any price — while their offer is running, even with the cost lock on. Every other item keeps the lock."
            checked={!!settings.offers_enabled}
            onChange={(v) => set('offers_enabled', v)}
            disabled={!canEdit}
          />
        </Stack>
        {dirty && <Alert severity="warning" sx={{ mt: 2, borderRadius: 3 }}>You have unsaved changes to the pricing rules.</Alert>}
      </Card>

      {/* Offers & clearance items */}
      <Card sx={{ p: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap', mb: 2 }}>
          <Box>
            <Typography variant="h6" fontWeight={800}>Offers & Clearance Items</Typography>
            <Typography variant="body2" color="text.secondary">
              Products or whole categories allowed to sell below cost, with an optional offer price and validity period.
            </Typography>
          </Box>
          {canEdit && (
            <Button variant="contained" startIcon={<AddIcon />} sx={greenButtonSx}
              onClick={() => setDialog({ mode: 'new', form: { ...EMPTY_OFFER } })}>
              Add Clearance / Offer Items
            </Button>
          )}
        </Box>

        {!saved.offers_enabled && (
          <Alert severity="info" sx={{ mb: 2, borderRadius: 3 }}>
            The Offers & Clearance module is OFF — these items are currently sold under the normal price rules.
          </Alert>
        )}

        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} sx={{ mb: 2 }}>
          <TextField
            size="small" placeholder="Search item, code, category or tag" value={filter}
            onChange={(e) => setFilter(e.target.value)} sx={{ flex: 1 }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          />
          <TextField select size="small" value={stateFilter} onChange={(e) => setStateFilter(e.target.value)} sx={{ minWidth: 170 }}>
            <MenuItem value="ALL">All statuses</MenuItem>
            {Object.entries(STATE_CHIP).map(([k, v]) => <MenuItem key={k} value={k}>{v.label}</MenuItem>)}
          </TextField>
        </Stack>

        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3 }}>
          <Table size="small">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: 'action.hover', whiteSpace: 'nowrap' } }}>
                <TableCell>Item / Category</TableCell>
                <TableCell align="right">Cost</TableCell>
                <TableCell align="right">Retail</TableCell>
                <TableCell align="right">Offer Price</TableCell>
                <TableCell>Offer Qty</TableCell>
                <TableCell>Offer Barcode</TableCell>
                <TableCell>Tag</TableCell>
                <TableCell>Validity</TableCell>
                <TableCell>Status</TableCell>
                {canEdit && <TableCell align="right">Actions</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {loadingOffers && (
                <TableRow><TableCell colSpan={10} align="center" sx={{ py: 4 }}><CircularProgress size={24} /></TableCell></TableRow>
              )}
              {!loadingOffers && shown.length === 0 && (
                <TableRow><TableCell colSpan={10} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  {offers.length ? 'No offers match the filter.' : 'No clearance or offer items yet.'}
                </TableCell></TableRow>
              )}
              {shown.map(o => (
                <TableRow key={o.id} hover>
                  <TableCell>
                    {o.scope === 'PRODUCT' ? (
                      <>
                        <Typography variant="body2" fontWeight={700}>{o.product_name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {[o.product_sku, o.product_barcode, o.category_name].filter(Boolean).join(' · ')}
                          {o.stock != null ? ` · Stock ${o.stock}` : ''}
                        </Typography>
                      </>
                    ) : (
                      <Stack direction="row" spacing={1} alignItems="center">
                        <Chip size="small" label="Category" variant="outlined" />
                        <Typography variant="body2" fontWeight={700}>{o.category_name}</Typography>
                      </Stack>
                    )}
                  </TableCell>
                  <TableCell align="right">{o.scope === 'PRODUCT' ? money(o.cost_price) : '—'}</TableCell>
                  <TableCell align="right">{o.scope === 'PRODUCT' ? money(o.retail_price) : '—'}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800 }}>
                    {o.offer_price == null ? <Chip size="small" label="Any price" color="warning" variant="outlined" /> : money(o.offer_price)}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }} data-offer-qty={o.id}>
                    <Typography variant="caption" fontWeight={700}
                      color={o.apply_to_all === false && !o.remaining ? 'error.main' : 'text.primary'}>
                      {offerQtyText(o)}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {o.scope === 'PRODUCT' ? (
                      <Stack direction="row" spacing={0.5} alignItems="center">
                        <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 700 }} data-offer-barcode={o.id}>
                          {o.offer_barcode || '—'}
                        </Typography>
                        {(o.offer_barcode || canEdit) && (
                          <Tooltip title={o.offer_barcode ? 'Print offer barcode labels' : 'Generate & print the offer barcode'}>
                            <IconButton size="small" color="success" onClick={() => printOfferBarcode(o)} data-action="print-offer-barcode">
                              <BarcodeIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        )}
                      </Stack>
                    ) : <Typography variant="caption" color="text.secondary">—</Typography>}
                  </TableCell>
                  <TableCell><Chip size="small" icon={<OfferIcon />} label={o.tag} sx={{ fontWeight: 700 }} /></TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Typography variant="caption">
                      {o.start_date || o.end_date ? `${o.start_date || 'Now'} → ${o.end_date || 'No end'}` : 'Always'}
                    </Typography>
                  </TableCell>
                  <TableCell><Chip size="small" {...STATE_CHIP[o.state]} /></TableCell>
                  {canEdit && (
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <Tooltip title={o.is_active ? 'Pause offer' : 'Resume offer'}>
                        <Switch size="small" checked={o.is_active} onChange={() => toggleActive(o)} color="success" />
                      </Tooltip>
                      <Tooltip title="Edit">
                        <IconButton size="small" onClick={() => setDialog({
                          mode: 'edit', offer: o,
                          form: { ...EMPTY_OFFER, scope: o.scope, mode: o.offer_price == null ? 'ANY' : 'PRICE',
                            offer_price: o.offer_price ?? '', tag: o.tag, notes: o.notes || '',
                            start_date: o.start_date || '', end_date: o.end_date || '',
                            apply_to_all: o.apply_to_all !== false, offer_quantity: o.offer_quantity ?? '' },
                        })}><EditIcon fontSize="small" /></IconButton>
                      </Tooltip>
                      <Tooltip title="Remove">
                        <IconButton size="small" color="error" onClick={() => setDeleting(o)}><DeleteIcon fontSize="small" /></IconButton>
                      </Tooltip>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {dialog && (
        <OfferDialog
          state={dialog}
          onClose={() => setDialog(null)}
          onPrint={printOfferBarcode}
          onSaved={(rows) => {
            setOffers(list => {
              const byId = new Map(list.map(o => [o.id, o]));
              rows.forEach(r => byId.set(r.id, r));
              return [...rows.filter(r => !list.some(o => o.id === r.id)), ...list.map(o => byId.get(o.id))];
            });
            setDialog(null);
          }}
        />
      )}

      {printing && (
        <BarcodePrintDialog
          open
          title={`Print Offer Barcode — ${printing.product_name}`}
          onClose={() => setPrinting(null)}
          workflow="inventory"
          rows={offerLabelRows(printing)}
          qtyLabel={printing.apply_to_all === false ? 'Offer qty left' : 'Stock'}
        />
      )}

      <ConfirmActionDialog
        open={!!deleting}
        type="warning"
        title="Remove this offer?"
        message={deleting ? `${deleting.product_name || deleting.category_name} goes back under the normal price rules.` : ''}
        confirmText="Remove"
        cancelText="Keep"
        onConfirm={removeOffer}
        onClose={() => setDeleting(null)}
      />
    </Stack>
  );
}

function OfferDialog({ state, onClose, onSaved, onPrint }) {
  const editing = state.mode === 'edit';
  const [form, setForm] = useState(state.form);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [productOptions, setProductOptions] = useState([]);
  const [productQuery, setProductQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [categories, setCategories] = useState([]);
  const searchSeq = useRef(0);
  const set = (key, value) => { setForm(f => ({ ...f, [key]: value })); setErrors(e => ({ ...e, [key]: undefined })); };

  useEffect(() => {
    if (editing) return;
    const cached = getMasterSnapshot('categories');
    if (cached) setCategories(cached);
    loadMaster('categories').then(setCategories).catch(() => {});
  }, [editing]);

  useEffect(() => {
    if (editing || form.scope !== 'PRODUCT') return undefined;
    const q = productQuery.trim();
    if (q.length < 2) { setProductOptions([]); return undefined; }
    const seq = ++searchSeq.current;
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await axios.get('/api/products/products/', { params: { search: q, page_size: 30 } });
        if (seq === searchSeq.current) setProductOptions(listOf(res.data));
      } catch { /* keep the last results */ } finally {
        if (seq === searchSeq.current) setSearching(false);
      }
    }, 300);
    return () => clearTimeout(t);
  }, [productQuery, form.scope, editing]);

  const submit = async () => {
    const body = {
      offer_price: form.mode === 'ANY' ? null : form.offer_price,
      tag: form.tag, notes: form.notes, start_date: form.start_date || null, end_date: form.end_date || null,
    };
    if (form.scope === 'PRODUCT') {
      body.apply_to_all = !!form.apply_to_all;
      if (!form.apply_to_all) body.offer_quantity = form.offer_quantity;
    }
    if (form.mode === 'PRICE' && (form.offer_price === '' || form.offer_price == null)) {
      setErrors({ offer_price: 'Enter the offer price, or choose "Allow any price".' });
      return;
    }
    if (form.scope === 'PRODUCT' && !form.apply_to_all && !(parseInt(form.offer_quantity, 10) >= 1)) {
      setErrors({ offer_quantity: 'Enter how many units get the offer price, or tick "Apply to all stock".' });
      return;
    }
    setSaving(true);
    try {
      let rows;
      if (editing) {
        rows = [(await axios.patch(`${OFFERS_API}${state.offer.id}/`, body)).data];
      } else {
        rows = (await axios.post(OFFERS_API, {
          ...body,
          products: form.scope === 'PRODUCT' ? form.products.map(p => p.id) : [],
          categories: form.scope === 'CATEGORY' ? form.categories.map(c => c.id) : [],
        })).data;
      }
      const codes = rows.map(r => r.offer_barcode).filter(Boolean);
      notify(editing ? 'Offer updated.' : `${rows.length} item(s) added to offers.${codes.length
        ? ` Offer barcode${codes.length > 1 ? 's' : ''}: ${codes.slice(0, 3).join(', ')}${codes.length > 3 ? '…' : ''} — print the tags from the list.` : ''}`, 'success');
      onSaved(rows);
    } catch (err) {
      setErrors(err?.response?.data?.errors || {});
      notify(`Offer NOT saved — ${apiErrorMessage(err)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // Units the partial quantity may go up to: the smallest stock among the picked products (an
  // edited offer also gets back what it already sold).
  const stockCap = editing
    ? (state.offer.scope === 'PRODUCT' ? (Number(state.offer.stock) || 0) + (Number(state.offer.sold) || 0) : null)
    : (form.products.length ? Math.min(...form.products.map(p => Number(p.stock) || 0)) : null);

  const below = form.scope === 'PRODUCT' && form.mode === 'PRICE' && form.offer_price !== ''
    ? form.products.filter(p => Number(p.cost_price) > 0 && Number(form.offer_price) < Number(p.cost_price)) : [];

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>
        {editing ? `Edit offer — ${state.offer.product_name || state.offer.category_name}` : 'Add Clearance / Offer Items'}
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2.5}>
          {!editing && (
            <>
              <ToggleButtonGroup exclusive size="small" value={form.scope} onChange={(e, v) => v && set('scope', v)}
                sx={{ '& .Mui-selected': { color: `${GREEN} !important`, fontWeight: 800 } }}>
                <ToggleButton value="PRODUCT">Specific products</ToggleButton>
                <ToggleButton value="CATEGORY">Whole categories</ToggleButton>
              </ToggleButtonGroup>
              {form.scope === 'PRODUCT' ? (
                <Autocomplete
                  multiple filterSelectedOptions
                  options={productOptions}
                  value={form.products}
                  loading={searching}
                  filterOptions={(x) => x}
                  onChange={(e, v) => set('products', v)}
                  onInputChange={(e, v, reason) => { if (reason !== 'reset') setProductQuery(v); }}
                  isOptionEqualToValue={(a, b) => a.id === b.id}
                  getOptionLabel={(p) => `${p.name}${p.sku ? ` (${p.sku})` : ''}`}
                  renderOption={(props, p) => (
                    <li {...props} key={p.id}>
                      <Box>
                        <Typography variant="body2" fontWeight={700}>{p.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {[p.sku, p.barcode, p.category_name].filter(Boolean).join(' · ')} · Cost {money(p.cost_price)} · Stock {p.stock ?? 0}
                        </Typography>
                      </Box>
                    </li>
                  )}
                  renderInput={(params) => (
                    <TextField {...params} label="Search products by name, code or barcode" error={!!errors.products}
                      helperText={errors.products || 'Type at least 2 letters. Pick as many items as you like.'} />
                  )}
                />
              ) : (
                <Autocomplete
                  multiple filterSelectedOptions
                  options={categories}
                  value={form.categories}
                  onChange={(e, v) => set('categories', v)}
                  isOptionEqualToValue={(a, b) => a.id === b.id}
                  getOptionLabel={(c) => c.name || ''}
                  renderInput={(params) => (
                    <TextField {...params} label="Categories" error={!!errors.products}
                      helperText={errors.products || 'Every product in these categories gets the offer. A product-level offer takes priority.'} />
                  )}
                />
              )}
            </>
          )}

          <Box>
            <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 0.5 }}>Lowest allowed price</Typography>
            <RadioGroup row value={form.mode} onChange={(e) => set('mode', e.target.value)}>
              <FormControlLabel value="PRICE" control={<Radio color="success" />} label="Sell down to an offer price" />
              <FormControlLabel value="ANY" control={<Radio color="success" />} label="Allow any price (no floor)" />
            </RadioGroup>
            {form.mode === 'PRICE' && (
              <TextField
                label="Offer price (per unit, before tax)" type="number" size="small" sx={{ mt: 1, maxWidth: 280 }}
                value={form.offer_price} onChange={(e) => set('offer_price', e.target.value)}
                error={!!errors.offer_price}
                helperText={errors.offer_price || 'Billing may not go below this price for the item.'}
                InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment>, inputProps: { min: 0 } }}
              />
            )}
            {below.length > 0 && (
              <Alert severity="info" sx={{ mt: 1.5, borderRadius: 2 }}>
                Below cost for: {below.map(p => `${p.name} (cost ${money(p.cost_price)})`).join(', ')}.
              </Alert>
            )}
          </Box>

          {form.scope === 'PRODUCT' && (
            <Box data-offer-quantity-section>
              <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 0.5 }}>Offer quantity</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'flex-start' }}>
                <FormControlLabel
                  control={<Checkbox color="success" checked={!!form.apply_to_all}
                    inputProps={{ 'data-field': 'apply_to_all' }}
                    onChange={(e) => set('apply_to_all', e.target.checked)} />}
                  label="Apply to all stock"
                />
                {!form.apply_to_all && (
                  <TextField
                    label="Offer Quantity" type="number" size="small" sx={{ maxWidth: 220 }}
                    value={form.offer_quantity} onChange={(e) => set('offer_quantity', e.target.value)}
                    inputProps={{ min: 1, step: 1, 'data-field': 'offer_quantity' }}
                    error={!!errors.offer_quantity}
                    helperText={errors.offer_quantity || (stockCap != null
                      ? `Units sold at the offer price — up to ${stockCap} (in stock${form.products.length > 1 ? ', lowest of the picked items' : ''}).`
                      : 'Units sold at the offer price; the rest sell at the regular price.')}
                  />
                )}
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                {form.apply_to_all
                  ? 'Every unit of the item may be sold at the offer price.'
                  : 'Only this many units get the offer price — scan the offer barcode (or apply the offer on the bill line) to sell one; regular scans keep the regular price.'}
                {' '}Each product offer gets its own offer barcode (e.g. 1001-0001) to tag the offer units.
              </Typography>
            </Box>
          )}

          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <Autocomplete
                freeSolo options={OFFER_TAGS} value={form.tag}
                onChange={(e, v) => set('tag', v || '')}
                onInputChange={(e, v) => set('tag', v)}
                renderInput={(params) => (
                  <TextField {...params} label="Reason / Tag" size="small" error={!!errors.tag} helperText={errors.tag} />
                )}
              />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField label="Start date" type="date" size="small" fullWidth InputLabelProps={{ shrink: true }}
                value={form.start_date} onChange={(e) => set('start_date', e.target.value)}
                error={!!errors.start_date} helperText={errors.start_date || 'Optional'} />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField label="End date" type="date" size="small" fullWidth InputLabelProps={{ shrink: true }}
                value={form.end_date} onChange={(e) => set('end_date', e.target.value)}
                error={!!errors.end_date} helperText={errors.end_date || 'Optional'} />
            </Grid>
            <Grid item xs={12}>
              <TextField label="Notes" size="small" fullWidth value={form.notes} onChange={(e) => set('notes', e.target.value)}
                inputProps={{ maxLength: 255 }} />
            </Grid>
          </Grid>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        {editing && state.offer.scope === 'PRODUCT' && (
          <Button startIcon={<BarcodeIcon />} color="success" onClick={() => onPrint(state.offer)} disabled={saving}
            sx={{ mr: 'auto', fontWeight: 800 }}>
            {state.offer.offer_barcode ? 'Print Offer Barcode' : 'Generate / Print Offer Barcode'}
          </Button>
        )}
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={saving || (!editing && (form.scope === 'PRODUCT' ? !form.products.length : !form.categories.length))}
          startIcon={<SaveIcon />} sx={greenButtonSx}>
          {saving ? 'Saving…' : editing ? 'Save Offer' : 'Add to Offers'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
