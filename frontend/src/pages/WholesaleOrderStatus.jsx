// Wholesale Distribution → Wholesale Order Status  (/wholesale/order-status)
//
// Module feature `wholesale_order_status` (Client Management → Modules → Wholesale Distribution);
// the sidebar item and this route are hidden / refused while it is off, and so is its API.
//
//   Left:  dealers / shops with open orders — Confirmed (not billed) and Pending Delivery (billed,
//          stock out, not in Accounts yet).
//   Right: the selected dealer's orders, filtered by stage, with the actions each stage allows:
//            Confirmed          Edit (Wholesale Orders editor) · Order to Sale (Wholesale POS)
//            Pending Delivery   Delivered / Post  → posts the bill to Accounts, stock untouched
//                               Not Delivered     → voids the bill, stock back, nothing posted
//
// Keyboard: ↑/↓ move in either list · Enter on a dealer opens its orders · Enter on an order runs
// its main action (Order to Sale / Delivered) · E edit · D delivered · N not delivered ·
// Esc back to dealers · F3 or / dealer search · Alt+R refresh.
//
// Server: apps/sales/wholesale_delivery.py (+ WholesaleOrderStatusViewSet).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Box, Paper, Typography, Stack, Button, TextField, InputAdornment, Table, TableHead, TableBody,
  TableRow, TableCell, TableContainer, IconButton, Tooltip, Chip, Grid, CircularProgress, Alert,
  ToggleButton, ToggleButtonGroup, Dialog, DialogTitle, DialogContent, DialogActions,
} from '@mui/material';
import {
  Search as SearchIcon, Refresh as RefreshIcon, Edit as EditIcon, PointOfSale as SaleIcon,
  LocalShipping as DeliverIcon, DoNotDisturbOn as UndeliveredIcon, Storefront as DealerIcon,
} from '@mui/icons-material';
import axios from 'axios';
import { WHOLESALE_API } from './wholesale/wholesaleConstants';
import { ORDER_STAGES, STAGE_FILTERS, stageActions } from './wholesale/wholesaleOrders';
import { navScopeProps, navDialogProps } from './wholesale/keyboardNav';
import { describeApiError } from '../utils/apiWriteGuard';
import { notify } from '../utils/notify';
import { formatCurrency } from '../utils/localeFormat.js';

const API = `${WHOLESALE_API}/order-status`;
const money = (n) => formatCurrency(parseFloat(n) || 0);
const HEAD_SX = { bgcolor: '#0f172a', color: '#fff', fontWeight: 800, fontSize: '0.72rem', py: 0.8, whiteSpace: 'nowrap' };
const CELL_SX = { fontSize: '0.8rem', py: 0.6, overflow: 'hidden', textOverflow: 'ellipsis' };
const ROW_FOCUS_SX = { cursor: 'pointer', '&:focus': { outline: '2px solid #2563eb', outlineOffset: -2, bgcolor: '#eff6ff' } };
const today = () => new Date().toISOString().split('T')[0];
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const errText = (e, fallback) => (typeof e?.response?.data?.detail === 'string' && e.response.data.detail)
  || (typeof e?.response?.data?.delivery_date === 'string' && e.response.data.delivery_date)
  || (Array.isArray(e?.response?.data?.delivery_date) && e.response.data.delivery_date.join(' '))
  || describeApiError(e, fallback);

const focusRow = (attr, idx) => document.querySelector(`[${attr}="${idx}"]`)?.focus();

function StatTile({ label, value, sub, color }) {
  return (
    <Paper variant="outlined" sx={{ px: 1.5, py: 1, borderRadius: 1.5, minWidth: 0, flex: 1 }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700} noWrap component="div">{label}</Typography>
      <Typography variant="h6" fontWeight={900} sx={{ lineHeight: 1.2, color }}>{value}</Typography>
      {sub && <Typography variant="caption" color="text.secondary" noWrap component="div">{sub}</Typography>}
    </Paper>
  );
}

export default function WholesaleOrderStatus() {
  const navigate = useNavigate();
  const location = useLocation();

  // ---- dealers ----
  const [dealers, setDealers] = useState([]);
  const [dealersLoading, setDealersLoading] = useState(true);
  const [dealerError, setDealerError] = useState('');
  const [dealerSearch, setDealerSearch] = useState('');
  const [scope, setScope] = useState('active');
  const [selected, setSelected] = useState(null); // dealer id

  // ---- orders of the selected dealer ----
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState('');
  const [stageKey, setStageKey] = useState('PENDING');
  const [highlight, setHighlight] = useState(''); // order id to focus once loaded
  const [busyId, setBusyId] = useState('');

  // ---- dialogs ----
  const [deliverFor, setDeliverFor] = useState(null);
  const [deliverDate, setDeliverDate] = useState(today());
  const [deliverNote, setDeliverNote] = useState('');
  const [cancelFor, setCancelFor] = useState(null);
  const [cancelReason, setCancelReason] = useState('');

  const searchRef = useRef(null);
  const reloadToken = useRef(0);

  const loadDealers = useCallback(async () => {
    setDealersLoading(true);
    setDealerError('');
    try {
      const { data } = await axios.get(`${API}/dealers/`, { params: { scope } });
      setDealers(Array.isArray(data) ? data : []);
    } catch (e) {
      setDealerError(errText(e, 'Could not load dealers.'));
    } finally {
      setDealersLoading(false);
    }
  }, [scope]);

  const loadOrders = useCallback(async (dealerId, key) => {
    if (!dealerId) { setOrders([]); return; }
    const token = ++reloadToken.current;
    setOrdersLoading(true);
    setOrdersError('');
    const stage = (STAGE_FILTERS.find(([k]) => k === key) || [])[2] || '';
    try {
      const { data } = await axios.get(`${API}/orders/`, { params: { dealer: dealerId, ...(stage ? { stage } : {}) } });
      if (token === reloadToken.current) setOrders(Array.isArray(data) ? data : []);
    } catch (e) {
      if (token === reloadToken.current) setOrdersError(errText(e, 'Could not load the orders.'));
    } finally {
      if (token === reloadToken.current) setOrdersLoading(false);
    }
  }, []);

  useEffect(() => { loadDealers(); }, [loadDealers]);
  useEffect(() => { loadOrders(selected, stageKey); }, [selected, stageKey, loadOrders]);

  // Deep link ?dealer=<id>&order=<id> (back from the POS / the order editor).
  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const dealer = params.get('dealer');
    if (!dealer) return;
    const order = params.get('order') || '';
    navigate(location.pathname, { replace: true });
    setSelected(dealer);
    setStageKey('PENDING');
    setHighlight(order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search]);

  // Focus the highlighted order (or the first one) after a load.
  useEffect(() => {
    if (ordersLoading || !highlight) return;
    const idx = orders.findIndex(o => o.id === highlight);
    setHighlight('');
    setTimeout(() => focusRow('data-os-order', idx >= 0 ? idx : 0), 60);
  }, [ordersLoading, orders, highlight]);

  const shownDealers = useMemo(() => {
    const q = dealerSearch.trim().toLowerCase();
    if (!q) return dealers;
    return dealers.filter(d => [d.dealer_name, d.dealer_code, d.phone, d.city].some(v => String(v || '').toLowerCase().includes(q)));
  }, [dealers, dealerSearch]);

  const selectedDealer = useMemo(() => dealers.find(d => d.dealer === selected) || null, [dealers, selected]);

  const totals = useMemo(() => dealers.reduce((a, d) => ({
    dealers: a.dealers + (d.pending_orders ? 1 : 0),
    confirmed: a.confirmed + d.confirmed,
    confirmedValue: a.confirmedValue + (parseFloat(d.confirmed_value) || 0),
    pending: a.pending + d.pending_delivery,
    pendingValue: a.pendingValue + (parseFloat(d.pending_delivery_value) || 0),
  }), { dealers: 0, confirmed: 0, confirmedValue: 0, pending: 0, pendingValue: 0 }), [dealers]);

  const refresh = () => { loadDealers(); loadOrders(selected, stageKey); };

  const openDealer = (d, focusOrders = false) => {
    setSelected(d.dealer);
    if (focusOrders) setHighlight('__first__');
  };

  // ---- actions ----
  const editOrder = (o) => navigate(`/wholesale/orders?edit=${encodeURIComponent(o.id)}&from=status`);
  const toSale = (o) => navigate(`/wholesale/pos?order=${encodeURIComponent(o.id)}`);
  const askDeliver = (o) => { setDeliverFor(o); setDeliverDate(today()); setDeliverNote(''); };
  const askCancel = (o) => { setCancelFor(o); setCancelReason(''); };

  const afterAction = (o, data) => {
    notify(data?.message || 'Done.', 'success');
    if (parseFloat(data?.received_kept) > 0) {
      notify(`${money(data.received_kept)} already received on this bill stays on the dealer's account as an advance.`, 'info');
    }
    loadDealers();
    loadOrders(selected, stageKey);
    setHighlight(o.id);
  };

  const runDeliver = async () => {
    const o = deliverFor;
    if (!o || busyId) return;
    setBusyId(o.id);
    try {
      const { data } = await axios.post(`${API}/${o.id}/deliver/`, { delivery_date: deliverDate, note: deliverNote });
      setDeliverFor(null);
      afterAction(o, data);
    } catch (e) {
      notify(errText(e, 'The order was not marked delivered.'), 'error');
    } finally {
      setBusyId('');
    }
  };

  const runCancel = async () => {
    const o = cancelFor;
    if (!o || busyId) return;
    setBusyId(o.id);
    try {
      const { data } = await axios.post(`${API}/${o.id}/cancel-delivery/`, { reason: cancelReason });
      setCancelFor(null);
      afterAction(o, data);
    } catch (e) {
      notify(errText(e, 'The delivery was not cancelled.'), 'error');
    } finally {
      setBusyId('');
    }
  };

  const primaryAction = (o) => {
    const can = stageActions(o.stage);
    if (can.toSale) toSale(o);
    else if (can.deliver) askDeliver(o);
  };

  // ---- keyboard ----
  const onDealerKey = (e, d, idx) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = idx + (e.key === 'ArrowDown' ? 1 : -1);
      if (next < 0) searchRef.current?.focus();
      else focusRow('data-os-dealer', Math.min(next, shownDealers.length - 1));
    } else if (e.key === 'Enter' || e.key === 'ArrowRight') {
      e.preventDefault();
      openDealer(d, true);
      if (selected === d.dealer) setTimeout(() => focusRow('data-os-order', 0), 30);
    }
  };

  const onOrderKey = (e, o, idx) => {
    const can = stageActions(o.stage);
    const k = e.key.toLowerCase();
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      focusRow('data-os-order', Math.max(0, Math.min(idx + (e.key === 'ArrowDown' ? 1 : -1), orders.length - 1)));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      primaryAction(o);
    } else if (e.key === 'Escape' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const di = shownDealers.findIndex(d => d.dealer === selected);
      focusRow('data-os-dealer', di >= 0 ? di : 0);
    } else if (k === 'e' && can.edit) { e.preventDefault(); editOrder(o); }
    else if (k === 's' && can.toSale) { e.preventDefault(); toSale(o); }
    else if (k === 'd' && can.deliver) { e.preventDefault(); askDeliver(o); }
    else if (k === 'n' && can.cancelDelivery) { e.preventDefault(); askCancel(o); }
  };

  const onSearchKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter') {
      e.preventDefault();
      if (e.key === 'Enter' && shownDealers.length === 1) { openDealer(shownDealers[0], true); return; }
      focusRow('data-os-dealer', 0);
    }
  };

  useEffect(() => {
    const onKey = (e) => {
      if (deliverFor || cancelFor) return;
      if (e.key === 'F3' || (e.key === '/' && !['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName))) {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select?.();
      } else if (e.altKey && e.key.toLowerCase() === 'r') {
        e.preventDefault();
        refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => { setTimeout(() => searchRef.current?.focus(), 80); }, []);

  // ======================================================================================
  return (
    <Box sx={{ p: { xs: 1, md: 2 }, maxWidth: 1600, mx: 'auto' }} {...navScopeProps}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1.5 }} flexWrap="wrap" useFlexGap>
        <Box sx={{ flex: 1, minWidth: 220 }}>
          <Typography variant="h6" fontWeight={900} color="primary.main" sx={{ lineHeight: 1.2 }}>Wholesale Order Status</Typography>
          <Typography variant="caption" color="text.secondary" fontWeight={600}>
            Bill confirmed orders, then post each bill to Accounts when it is delivered — or restore its stock if it is not.
          </Typography>
        </Box>
        <Tooltip title="Refresh (Alt+R)"><IconButton onClick={refresh} aria-label="Refresh"><RefreshIcon /></IconButton></Tooltip>
        <Button variant="outlined" onClick={() => navigate('/wholesale/orders')} sx={{ fontWeight: 800, textTransform: 'none' }}>Wholesale Orders</Button>
      </Stack>

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.2} sx={{ mb: 1.5 }}>
        <StatTile label="Dealers with open orders" value={totals.dealers} />
        <StatTile label="Confirmed (not billed)" value={totals.confirmed} sub={money(totals.confirmedValue)} color="#1d4ed8" />
        <StatTile label="Invoiced — pending delivery" value={totals.pending} sub={`${money(totals.pendingValue)} not yet in Accounts`} color="#b45309" />
      </Stack>

      <Grid container spacing={1.5}>
        {/* Dealers (top) */}
        <Grid item xs={12}>
          <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }} data-nav-own>
            <Box sx={{ p: 1.2, borderBottom: '1px solid #e2e8f0' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ flex: 1 }}>
                <DealerIcon color="primary" />
                <Typography fontWeight={900}>Dealers / Shops</Typography>
                </Stack>
                <ToggleButtonGroup size="small" exclusive value={scope} onChange={(_, v) => v && setScope(v)}>
                  <ToggleButton value="active" sx={{ fontWeight: 800, textTransform: 'none', py: 0.2 }}>Open</ToggleButton>
                  <ToggleButton value="all" sx={{ fontWeight: 800, textTransform: 'none', py: 0.2 }}>All</ToggleButton>
                </ToggleButtonGroup>
              <TextField
                size="small" inputRef={searchRef} sx={{ width: { xs: '100%', sm: 360 } }} placeholder="Search dealer, code, phone, city (F3)" autoComplete="off"
                value={dealerSearch} onChange={(e) => setDealerSearch(e.target.value)} onKeyDown={onSearchKey}
                InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
                inputProps={{ 'aria-label': 'Search dealers' }}
              />
              </Stack>
            </Box>
            {dealerError && <Alert severity="error" sx={{ m: 1 }}>{dealerError}</Alert>}
            <TableContainer sx={{ maxHeight: 300 }}>
              <Table size="small" stickyHeader sx={{ tableLayout: 'fixed', width: '100%' }} aria-label="Dealers with orders">
                <TableHead>
                  <TableRow>
                    <TableCell sx={HEAD_SX}>Dealer / Shop</TableCell>
                    <TableCell sx={{ ...HEAD_SX, width: '16%' }} align="right">Confirmed</TableCell>
                    <TableCell sx={{ ...HEAD_SX, width: '18%' }} align="right">Pending Delivery</TableCell>
                    <TableCell sx={{ ...HEAD_SX, width: '14%' }} align="right">Total Pending</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {dealersLoading && !dealers.length && (
                    <TableRow><TableCell colSpan={4} align="center" sx={{ py: 4 }}><CircularProgress size={22} /></TableCell></TableRow>
                  )}
                  {!dealersLoading && !shownDealers.length && (
                    <TableRow><TableCell colSpan={4} align="center" sx={{ py: 4, color: 'text.secondary', fontSize: '0.8rem' }}>
                      {dealerSearch ? `No dealer matches “${dealerSearch}”.` : scope === 'active' ? 'No dealer has open orders.' : 'No wholesale orders yet.'}
                    </TableCell></TableRow>
                  )}
                  {shownDealers.map((d, idx) => {
                    const active = d.dealer === selected;
                    return (
                      <TableRow
                        key={d.dealer} hover selected={active} tabIndex={0} data-os-dealer={idx}
                        onClick={() => openDealer(d)} onKeyDown={(e) => onDealerKey(e, d, idx)} sx={ROW_FOCUS_SX}
                      >
                        <TableCell sx={CELL_SX}>
                          <Typography variant="body2" fontWeight={800} noWrap title={d.dealer_name}>{d.dealer_name}</Typography>
                          <Typography variant="caption" color="text.secondary" noWrap component="div">
                            {[d.dealer_code, d.city, d.last_order_date ? `last ${fmtDate(d.last_order_date)}` : ''].filter(Boolean).join(' · ')}
                          </Typography>
                        </TableCell>
                        <TableCell sx={{ ...CELL_SX, fontWeight: 800, color: d.confirmed ? '#1d4ed8' : 'text.disabled' }} align="right">{d.confirmed}</TableCell>
                        <TableCell sx={{ ...CELL_SX, fontWeight: 800, color: d.pending_delivery ? '#b45309' : 'text.disabled' }} align="right">{d.pending_delivery}</TableCell>
                        <TableCell sx={CELL_SX} align="right">
                          <Chip size="small" label={d.pending_orders} color={d.pending_orders ? 'warning' : 'default'} sx={{ fontWeight: 900, minWidth: 34 }} />
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </Grid>

        {/* Orders of the selected dealer (below) */}
        <Grid item xs={12}>
          <Paper variant="outlined" sx={{ borderRadius: 1.5, overflow: 'hidden' }} data-nav-own>
            <Box sx={{ p: 1.2, borderBottom: '1px solid #e2e8f0' }}>
              <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1} alignItems={{ lg: 'center' }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography fontWeight={900} noWrap>
                    {selectedDealer ? selectedDealer.dealer_name : selected ? 'Orders' : 'Select a dealer / shop'}
                  </Typography>
                  {selectedDealer && (
                    <Typography variant="caption" color="text.secondary" noWrap component="div">
                      {[selectedDealer.dealer_code, selectedDealer.phone, `${selectedDealer.total_orders} order(s) in all`].filter(Boolean).join(' · ')}
                    </Typography>
                  )}
                </Box>
                <ToggleButtonGroup size="small" exclusive value={stageKey} onChange={(_, v) => v && setStageKey(v)} sx={{ flexWrap: 'wrap' }}>
                  {STAGE_FILTERS.map(([k, label]) => (
                    <ToggleButton key={k} value={k} sx={{ fontWeight: 800, textTransform: 'none', py: 0.2, px: 1 }}>{label}</ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </Stack>
            </Box>
            {ordersError && <Alert severity="error" sx={{ m: 1 }}>{ordersError}</Alert>}
            <TableContainer sx={{ maxHeight: 480 }}>
              <Table size="small" stickyHeader sx={{ tableLayout: 'fixed', width: '100%' }} aria-label="Orders of the dealer">
                <TableHead>
                  <TableRow>
                    <TableCell sx={{ ...HEAD_SX, width: '19%' }}>Order</TableCell>
                    <TableCell sx={{ ...HEAD_SX, width: '11%' }} align="right">Items</TableCell>
                    <TableCell sx={{ ...HEAD_SX, width: '15%' }} align="right">Amount</TableCell>
                    <TableCell sx={{ ...HEAD_SX, width: '19%' }}>Status</TableCell>
                    <TableCell sx={{ ...HEAD_SX, width: '16%' }}>Invoice</TableCell>
                    <TableCell sx={{ ...HEAD_SX, width: '20%' }} align="center">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {!selected && (
                    <TableRow><TableCell colSpan={6} align="center" sx={{ py: 6, color: 'text.secondary', fontSize: '0.85rem' }}>
                      Pick a dealer on the left (↑/↓ then Enter) to see their orders.
                    </TableCell></TableRow>
                  )}
                  {selected && ordersLoading && (
                    <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}><CircularProgress size={22} /></TableCell></TableRow>
                  )}
                  {selected && !ordersLoading && !orders.length && (
                    <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary', fontSize: '0.85rem' }}>No orders in this view.</TableCell></TableRow>
                  )}
                  {selected && !ordersLoading && orders.map((o, idx) => {
                    const st = ORDER_STAGES[o.stage] || { label: o.stage, short: o.stage, color: 'default' };
                    const can = stageActions(o.stage);
                    const busy = busyId === o.id;
                    const inv = o.invoice;
                    return (
                      <TableRow key={o.id} hover tabIndex={0} data-os-order={idx} onKeyDown={(e) => onOrderKey(e, o, idx)}
                        onDoubleClick={() => primaryAction(o)} sx={ROW_FOCUS_SX}>
                        <TableCell sx={CELL_SX}>
                          <Typography variant="body2" fontWeight={800} sx={{ fontFamily: 'monospace' }} noWrap>{o.order_number}</Typography>
                          <Typography variant="caption" color="text.secondary" noWrap component="div">{fmtDate(o.order_date)}</Typography>
                        </TableCell>
                        <TableCell sx={CELL_SX} align="right">
                          {o.item_count}<Typography variant="caption" color="text.secondary" component="div">{o.units} unit(s)</Typography>
                        </TableCell>
                        <TableCell sx={{ ...CELL_SX, fontWeight: 800 }} align="right">{money(inv ? inv.grand_total : o.total_amount)}</TableCell>
                        <TableCell sx={CELL_SX}>
                          <Tooltip title={st.hint || ''}>
                            <Chip size="small" color={st.color} label={st.short} sx={{ fontWeight: 800, maxWidth: '100%' }} />
                          </Tooltip>
                          {inv?.delivered_on && o.stage === 'DELIVERED_POSTED' && (
                            <Typography variant="caption" color="text.secondary" noWrap component="div">on {fmtDate(inv.delivered_on)}</Typography>
                          )}
                          {inv?.delivery_note && ['DELIVERED_POSTED', 'UNDELIVERED'].includes(o.stage) && (
                            <Typography variant="caption" color="text.secondary" noWrap component="div" title={inv.delivery_note}>{inv.delivery_note}</Typography>
                          )}
                        </TableCell>
                        <TableCell sx={CELL_SX}>
                          {inv ? (
                            <>
                              <Typography variant="body2" sx={{ fontFamily: 'monospace', fontWeight: 700 }} noWrap>{inv.invoice_number}</Typography>
                              <Typography variant="caption" color={inv.is_posted_to_accounts ? 'success.main' : 'text.secondary'} noWrap component="div">
                                {inv.is_posted_to_accounts ? 'Posted to Accounts' : o.stage === 'UNDELIVERED' ? 'Voided — not posted' : 'Not posted yet'}
                              </Typography>
                            </>
                          ) : '—'}
                        </TableCell>
                        <TableCell sx={{ ...CELL_SX, whiteSpace: 'nowrap' }} align="center">
                          {busy ? <CircularProgress size={18} /> : (
                            <Stack direction="row" spacing={0.25} justifyContent="center" alignItems="center">
                              {can.toSale && (
                                <Tooltip title="Order to Sale — open in the Wholesale POS (Enter / S)">
                                  <Button size="small" variant="contained" color="success" onClick={() => toSale(o)} startIcon={<SaleIcon />}
                                    sx={{ fontWeight: 800, textTransform: 'none', py: 0.1, minWidth: 0 }}>To Sale</Button>
                                </Tooltip>
                              )}
                              {can.edit && <Tooltip title="Edit order (E)"><IconButton size="small" onClick={() => editOrder(o)} aria-label={`Edit ${o.order_number}`}><EditIcon fontSize="small" /></IconButton></Tooltip>}
                              {can.deliver && (
                                <Tooltip title="Delivered / Post — post to Accounts (Enter / D)">
                                  <Button size="small" variant="contained" color="primary" onClick={() => askDeliver(o)} startIcon={<DeliverIcon />}
                                    sx={{ fontWeight: 800, textTransform: 'none', py: 0.1, minWidth: 0 }}>Delivered</Button>
                                </Tooltip>
                              )}
                              {can.cancelDelivery && (
                                <Tooltip title="Not Delivered / Cancel — restore stock, void the bill (N)">
                                  <IconButton size="small" color="error" onClick={() => askCancel(o)} aria-label={`Not delivered ${o.order_number}`}><UndeliveredIcon fontSize="small" /></IconButton>
                                </Tooltip>
                              )}
                            </Stack>
                          )}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </TableContainer>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', px: 1.2, py: 0.6, borderTop: '1px solid #e2e8f0' }}>
              ↑/↓ move · <b>Enter</b> To Sale / Delivered · <b>E</b> edit · <b>S</b> to sale · <b>D</b> delivered · <b>N</b> not delivered · <b>Esc</b> back to dealers · <b>F3</b> search · <b>Alt+R</b> refresh
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {/* Delivered / Post */}
      <Dialog open={Boolean(deliverFor)} onClose={() => !busyId && setDeliverFor(null)} maxWidth="xs" fullWidth {...navDialogProps}>
        <DialogTitle sx={{ fontWeight: 900 }}>Delivered / Post — {deliverFor?.order_number}</DialogTitle>
        <DialogContent>
          <Alert severity="info" sx={{ mb: 2 }}>
            Invoice <b>{deliverFor?.invoice?.invoice_number}</b> ({money(deliverFor?.invoice?.grand_total)}) is posted to Accounts —
            dealer receivable, sales and tax — dated the delivery day. Stock was already deducted at billing and is not touched again.
          </Alert>
          <TextField fullWidth size="small" type="date" label="Delivery date" value={deliverDate}
            onChange={(e) => setDeliverDate(e.target.value)} InputLabelProps={{ shrink: true }}
            inputProps={{ max: today(), min: deliverFor?.invoice?.invoice_date || undefined }} sx={{ mb: 2 }} autoFocus />
          <TextField fullWidth size="small" label="Delivery note (optional)" value={deliverNote} onChange={(e) => setDeliverNote(e.target.value)}
            placeholder="Received by, vehicle, remarks…" inputProps={{ maxLength: 500, 'data-nav-enter': '#os-deliver-confirm' }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDeliverFor(null)} disabled={Boolean(busyId)}>Back</Button>
          <Button id="os-deliver-confirm" data-nav-stop variant="contained" onClick={runDeliver} disabled={Boolean(busyId)}
            startIcon={busyId ? <CircularProgress size={16} color="inherit" /> : <DeliverIcon />} sx={{ fontWeight: 900 }}>
            Delivered &amp; Post
          </Button>
        </DialogActions>
      </Dialog>

      {/* Not Delivered / Cancel Delivery */}
      <Dialog open={Boolean(cancelFor)} onClose={() => !busyId && setCancelFor(null)} maxWidth="xs" fullWidth {...navDialogProps}>
        <DialogTitle sx={{ fontWeight: 900 }}>Not Delivered — {cancelFor?.order_number}</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Invoice <b>{cancelFor?.invoice?.invoice_number}</b> is cancelled as undelivered: its {cancelFor?.units} unit(s) go back to stock
            and it can never be posted to Accounts. Nothing was posted, so no reversal entry is needed. The order closes as Undelivered.
            {parseFloat(cancelFor?.invoice?.paid_amount) > 0 && <> Money already received ({money(cancelFor?.invoice?.paid_amount)}) stays on the dealer’s account.</>}
          </Alert>
          <TextField fullWidth size="small" label="Reason (optional)" value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} autoFocus
            placeholder="Rejected by dealer, shop closed, wrong items…" inputProps={{ maxLength: 500, 'data-nav-enter': '#os-cancel-confirm' }} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setCancelFor(null)} disabled={Boolean(busyId)}>Back</Button>
          <Button id="os-cancel-confirm" data-nav-stop variant="contained" color="error" onClick={runCancel} disabled={Boolean(busyId)}
            startIcon={busyId ? <CircularProgress size={16} color="inherit" /> : <UndeliveredIcon />} sx={{ fontWeight: 900 }}>
            Not Delivered — Restore Stock
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
