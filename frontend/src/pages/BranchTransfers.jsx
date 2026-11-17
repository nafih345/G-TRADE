// Inventory → Branch Transfers (P1 Task 7). Two-step stock movement between branches:
//   Draft → Dispatch (stock leaves the sending branch, Goods in Transit) → Receive (stock enters the
//   receiving branch; part-receipts allowed) — or Cancel (whatever is still in transit goes back).
// The server decides everything that matters: the transfer number, the status, who may act
// (sending branch: create / edit / dispatch / cancel; receiving branch: receive) and the stock and
// accounting movements. Backend: apps/inventory/branch_transfer.py + /api/company/stock-transfers/.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link as RouterLink } from 'react-router-dom';
import axios from 'axios';
import {
  Alert, Autocomplete, Box, Breadcrumbs, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle,
  IconButton, Link, MenuItem, Paper, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs,
  TextField, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, Delete as DeleteIcon, LocalShipping as DispatchIcon, MoveToInbox as ReceiveIcon,
  Cancel as CancelIcon, Print as PrintIcon, Refresh as RefreshIcon, Visibility as ViewIcon,
} from '@mui/icons-material';
import { useBranch } from '../context/BranchContext';
import { apiErrorMessage } from '../utils/apiError';
import { notify } from '../utils/notify';

const API = '/api/company/stock-transfers/';
const STATUS_COLORS = {
  DRAFT: 'default', PENDING: 'default', DISPATCHED: 'warning', PARTIALLY_RECEIVED: 'info', RECEIVED: 'success',
  CANCELLED: 'error', CLOSED: 'secondary', COMPLETED: 'default',
};
const STATUS_LABELS = {
  DRAFT: 'Draft', PENDING: 'Draft', DISPATCHED: 'In transit', PARTIALLY_RECEIVED: 'Partly received',
  RECEIVED: 'Received', CANCELLED: 'Cancelled', CLOSED: 'Closed (rest returned)', COMPLETED: 'Completed (legacy)',
};
const EDITABLE = ['DRAFT', 'PENDING'];
const IN_TRANSIT = ['DISPATCHED', 'PARTIALLY_RECEIVED'];

const rows = (data) => (Array.isArray(data) ? data : data?.results || []);
const fmtDate = (v) => (v ? new Date(v).toLocaleString() : '—');

function StatusChip({ status }) {
  return <Chip size="small" color={STATUS_COLORS[status] || 'default'} label={STATUS_LABELS[status] || status} />;
}

function DraftDialog({ open, onClose, onSaved, branches, warehouses, activeBranch, editing }) {
  const [fromBranch, setFromBranch] = useState('');
  const [toBranch, setToBranch] = useState('');
  const [fromWh, setFromWh] = useState('');
  const [toWh, setToWh] = useState('');
  const [notes, setNotes] = useState('');
  const [lines, setLines] = useState([]);
  const [options, setOptions] = useState([]);
  const [search, setSearch] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setFromBranch(editing?.from_branch || activeBranch?.id || '');
    setToBranch(editing?.to_branch || '');
    setFromWh(editing?.from_warehouse || '');
    setToWh(editing?.to_warehouse || '');
    setNotes(editing?.notes || '');
    setLines((editing?.items || []).map((it) => ({ product: it.product, name: it.product_name, sku: it.product_sku, quantity: it.quantity })));
  }, [open, editing, activeBranch]);

  useEffect(() => {
    if (!open || search.trim().length < 2) { setOptions([]); return undefined; }
    const timer = setTimeout(() => {
      axios.get('/api/products/items/', { params: { search: search.trim(), page_size: 20 } })
        .then((res) => setOptions(rows(res.data)))
        .catch(() => setOptions([]));
    }, 250);
    return () => clearTimeout(timer);
  }, [search, open]);

  const addProduct = (p) => {
    if (!p) return;
    setLines((prev) => (prev.some((l) => l.product === p.id) ? prev
      : [...prev, { product: p.id, name: p.name, sku: p.sku, quantity: 1, stock: p.stock }]));
    setSearch('');
  };

  const save = async () => {
    if (!fromBranch || !toBranch) { notify('Choose the sending and the receiving branch.'); return; }
    if (fromBranch === toBranch) { notify('The receiving branch must be different from the sending branch.'); return; }
    if (!lines.length) { notify('Add at least one product.'); return; }
    const payload = {
      from_branch: fromBranch, to_branch: toBranch, from_warehouse: fromWh || null, to_warehouse: toWh || null,
      notes, items: lines.map((l) => ({ product: l.product, quantity: Number(l.quantity) || 0 })),
    };
    setSaving(true);
    try {
      const res = editing ? await axios.put(`${API}${editing.id}/`, payload) : await axios.post(API, payload);
      onSaved(res.data);
    } catch (err) {
      notify(apiErrorMessage(err, 'Could not save the transfer.'));
    } finally {
      setSaving(false);
    }
  };

  const whFor = (branchId) => warehouses.filter((w) => !branchId || w.branch === branchId);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>{editing ? `Edit draft ${editing.transfer_number}` : 'New branch transfer'}</DialogTitle>
      <DialogContent dividers>
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2, mb: 2 }}>
          <TextField select size="small" label="From branch (sending)" value={fromBranch} onChange={(e) => { setFromBranch(e.target.value); setFromWh(''); }}>
            {branches.map((b) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="To branch (receiving)" value={toBranch} onChange={(e) => { setToBranch(e.target.value); setToWh(''); }}>
            {branches.filter((b) => b.id !== fromBranch).map((b) => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="From warehouse (optional)" value={fromWh} onChange={(e) => setFromWh(e.target.value)}>
            <MenuItem value="">Branch default</MenuItem>
            {whFor(fromBranch).map((w) => <MenuItem key={w.id} value={w.id}>{w.name}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="To warehouse (optional)" value={toWh} onChange={(e) => setToWh(e.target.value)}>
            <MenuItem value="">Branch default</MenuItem>
            {whFor(toBranch).map((w) => <MenuItem key={w.id} value={w.id}>{w.name}</MenuItem>)}
          </TextField>
        </Box>
        <Autocomplete
          size="small" options={options} filterOptions={(x) => x} inputValue={search}
          onInputChange={(_e, v, reason) => { if (reason !== 'reset') setSearch(v); }}
          getOptionLabel={(o) => `${o.name || ''}${o.sku ? ` · ${o.sku}` : ''}`}
          onChange={(_e, v) => addProduct(v)} value={null}
          renderInput={(params) => <TextField {...params} label="Add product (type 2+ letters, name / SKU / barcode)" />}
        />
        <TableContainer sx={{ mt: 2 }}>
          <Table size="small">
            <TableHead><TableRow><TableCell>Product</TableCell><TableCell>SKU</TableCell><TableCell width={140}>Quantity</TableCell><TableCell width={48} /></TableRow></TableHead>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={l.product}>
                  <TableCell>{l.name}</TableCell>
                  <TableCell>{l.sku}</TableCell>
                  <TableCell>
                    <TextField size="small" type="number" inputProps={{ min: 1 }} value={l.quantity}
                      onChange={(e) => setLines((prev) => prev.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
                  </TableCell>
                  <TableCell><IconButton size="small" onClick={() => setLines((prev) => prev.filter((_x, j) => j !== i))}><DeleteIcon fontSize="small" /></IconButton></TableCell>
                </TableRow>
              ))}
              {!lines.length && <TableRow><TableCell colSpan={4} sx={{ color: 'text.secondary' }}>No products yet.</TableCell></TableRow>}
            </TableBody>
          </Table>
        </TableContainer>
        <TextField sx={{ mt: 2 }} fullWidth size="small" label="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} multiline minRows={2} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" onClick={save} disabled={saving}>{editing ? 'Save draft' : 'Create draft'}</Button>
      </DialogActions>
    </Dialog>
  );
}

function ReceiveDialog({ transfer, onClose, onDone }) {
  const [qty, setQty] = useState({});
  const [busy, setBusy] = useState(false);
  const lines = (transfer?.items || []).filter((it) => it.in_transit_quantity > 0);
  useEffect(() => {
    setQty(Object.fromEntries(lines.map((it) => [it.id, it.in_transit_quantity])));
  }, [transfer]); // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async () => {
    const quantities = Object.fromEntries(Object.entries(qty).filter(([, v]) => Number(v) > 0).map(([k, v]) => [k, Number(v)]));
    if (!Object.keys(quantities).length) { notify('Enter a quantity to receive.'); return; }
    setBusy(true);
    try {
      const res = await axios.post(`${API}${transfer.id}/receive/`, { quantities });
      onDone(res.data);
    } catch (err) {
      notify(apiErrorMessage(err, 'Could not receive the transfer.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={Boolean(transfer)} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Receive {transfer?.transfer_number}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Enter what actually arrived. Anything not received now stays in transit and can be received later.
        </Typography>
        <Table size="small">
          <TableHead><TableRow><TableCell>Product</TableCell><TableCell align="right">In transit</TableCell><TableCell width={140}>Receive now</TableCell></TableRow></TableHead>
          <TableBody>
            {lines.map((it) => (
              <TableRow key={it.id}>
                <TableCell>{it.product_name}</TableCell>
                <TableCell align="right">{it.in_transit_quantity}</TableCell>
                <TableCell>
                  <TextField size="small" type="number" inputProps={{ min: 0, max: it.in_transit_quantity }} value={qty[it.id] ?? ''}
                    onChange={(e) => setQty((p) => ({ ...p, [it.id]: e.target.value }))} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" color="success" onClick={submit} disabled={busy} startIcon={<ReceiveIcon />}>Receive</Button>
      </DialogActions>
    </Dialog>
  );
}

function printNote(t) {
  const w = window.open('', '_blank', 'width=800,height=900');
  if (!w) return;
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const body = (t.items || []).map((it) => `<tr><td>${esc(it.product_name)}</td><td>${esc(it.product_sku)}</td><td style="text-align:right">${it.quantity}</td><td style="text-align:right">${it.received_quantity}</td></tr>`).join('');
  w.document.write(`<!doctype html><html><head><meta charset="utf-8"><title>${esc(t.transfer_number)}</title>
    <style>body{font-family:system-ui,sans-serif;padding:24px}table{width:100%;border-collapse:collapse}td,th{border:1px solid #999;padding:6px;font-size:13px}th{background:#eee}</style></head>
    <body><h2>Stock transfer note ${esc(t.transfer_number)}</h2>
    <p><b>From:</b> ${esc(t.from_branch_name)}${t.from_warehouse_name ? ` (${esc(t.from_warehouse_name)})` : ''} &nbsp; <b>To:</b> ${esc(t.to_branch_name)}${t.to_warehouse_name ? ` (${esc(t.to_warehouse_name)})` : ''}</p>
    <p><b>Status:</b> ${esc(STATUS_LABELS[t.status] || t.status)} &nbsp; <b>Dispatched:</b> ${esc(fmtDate(t.dispatched_at))} ${esc(t.dispatched_by)} &nbsp; <b>Received:</b> ${esc(fmtDate(t.received_at))} ${esc(t.received_by)}</p>
    <table><thead><tr><th>Product</th><th>SKU</th><th>Sent</th><th>Received</th></tr></thead><tbody>${body}</tbody></table>
    <p>${esc(t.notes || '')}</p><p style="margin-top:48px">Dispatched by: ____________ &nbsp;&nbsp; Received by: ____________</p>
    <script>window.onload=()=>window.print()</script></body></html>`);
  w.document.close();
}

export default function BranchTransfers() {
  const { multiBranchEnabled, activeBranch, branches: myBranches } = useBranch();
  const [tab, setTab] = useState('all');
  const [list, setList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [allBranches, setAllBranches] = useState([]);
  const [warehouses, setWarehouses] = useState([]);
  const [draftOpen, setDraftOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [receiving, setReceiving] = useState(null);
  const [viewing, setViewing] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = tab === 'all' ? {} : tab === 'in_transit' ? { status: IN_TRANSIT.join(',') } : { direction: tab };
      const res = await axios.get(API, { params });
      setList(rows(res.data));
    } catch (err) {
      notify(apiErrorMessage(err, 'Could not load transfers.'));
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => { load(); }, [load, activeBranch?.id]);
  useEffect(() => {
    axios.get('/api/company/branches/').then((r) => setAllBranches(rows(r.data).filter((b) => b.is_active !== false))).catch(() => setAllBranches([]));
    axios.get('/api/company/warehouses/').then((r) => setWarehouses(rows(r.data))).catch(() => setWarehouses([]));
  }, []);

  const mine = useMemo(() => new Set((myBranches || []).map((b) => b.id)), [myBranches]);
  const canSend = (t) => !mine.size || mine.has(t.from_branch);
  const canReceive = (t) => !mine.size || mine.has(t.to_branch);

  const act = async (t, action, confirmText, body = {}) => {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      const res = await axios.post(`${API}${t.id}/${action}/`, body);
      notify(`${res.data.transfer_number}: ${STATUS_LABELS[res.data.status] || res.data.status}`);
      window.dispatchEvent(new Event('optical_stock_updated'));
      load();
    } catch (err) {
      notify(apiErrorMessage(err, 'The action could not be completed.'));
    }
  };

  const remove = async (t) => {
    if (!window.confirm(`Delete draft ${t.transfer_number}?`)) return;
    try {
      await axios.delete(`${API}${t.id}/`);
      load();
    } catch (err) {
      notify(apiErrorMessage(err, 'Could not delete the draft.'));
    }
  };

  return (
    <Box sx={{ p: { xs: 1.5, md: 2 }, pb: 6 }}>
      <Breadcrumbs sx={{ mb: 0.5, fontSize: 13 }}>
        <Link component={RouterLink} to="/inventory/products" underline="hover" color="inherit">Inventory</Link>
        <Typography color="text.primary" fontSize={13} fontWeight={700}>Branch Transfers</Typography>
      </Breadcrumbs>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mb: 1.5 }}>
        <Typography variant="h5" fontWeight={800} sx={{ mr: 'auto' }}>Branch Transfers</Typography>
        <Button startIcon={<RefreshIcon />} onClick={load} disabled={loading}>Refresh</Button>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => { setEditing(null); setDraftOpen(true); }} disabled={!multiBranchEnabled}>
          New transfer
        </Button>
      </Box>
      {!multiBranchEnabled && (
        <Alert severity="info" sx={{ mb: 2 }}>Branch transfers need Multi-Branch mode (Settings → Business Settings).</Alert>
      )}
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 1 }} variant="scrollable">
        <Tab value="all" label="All" />
        <Tab value="outgoing" label="Outgoing" />
        <Tab value="incoming" label="Incoming" />
        <Tab value="in_transit" label="In transit" />
      </Tabs>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small">
          <TableHead>
            <TableRow>
              <TableCell>Number</TableCell><TableCell>From</TableCell><TableCell>To</TableCell>
              <TableCell align="right">Lines</TableCell><TableCell align="right">Units</TableCell>
              <TableCell>Status</TableCell><TableCell>Dispatched</TableCell><TableCell>Received</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {list.map((t) => {
              const units = (t.items || []).reduce((s, it) => s + (Number(it.quantity) || 0), 0);
              return (
                <TableRow key={t.id} hover>
                  <TableCell sx={{ fontWeight: 700 }}>{t.transfer_number}</TableCell>
                  <TableCell>{t.from_branch_name}</TableCell>
                  <TableCell>{t.to_branch_name}</TableCell>
                  <TableCell align="right">{(t.items || []).length}</TableCell>
                  <TableCell align="right">{units}</TableCell>
                  <TableCell><StatusChip status={t.status} /></TableCell>
                  <TableCell>{t.dispatched_at ? `${fmtDate(t.dispatched_at)} · ${t.dispatched_by || ''}` : '—'}</TableCell>
                  <TableCell>{t.received_at ? `${fmtDate(t.received_at)} · ${t.received_by || ''}` : '—'}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title="View"><IconButton size="small" onClick={() => setViewing(t)}><ViewIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title="Print transfer note"><IconButton size="small" onClick={() => printNote(t)}><PrintIcon fontSize="small" /></IconButton></Tooltip>
                    {EDITABLE.includes(t.status) && canSend(t) && (
                      <>
                        <Button size="small" onClick={() => { setEditing(t); setDraftOpen(true); }}>Edit</Button>
                        <Button size="small" color="warning" startIcon={<DispatchIcon />}
                          onClick={() => act(t, 'dispatch', `Dispatch ${t.transfer_number}? The stock leaves ${t.from_branch_name} now.`)}>Dispatch</Button>
                        <IconButton size="small" onClick={() => remove(t)}><DeleteIcon fontSize="small" /></IconButton>
                      </>
                    )}
                    {IN_TRANSIT.includes(t.status) && canReceive(t) && (
                      <Button size="small" color="success" startIcon={<ReceiveIcon />} onClick={() => setReceiving(t)}>Receive</Button>
                    )}
                    {[...EDITABLE, ...IN_TRANSIT].includes(t.status) && canSend(t) && (
                      <Button size="small" color="error" startIcon={<CancelIcon />}
                        onClick={() => act(t, 'cancel', IN_TRANSIT.includes(t.status)
                          ? `Cancel ${t.transfer_number}? Everything still in transit goes back to ${t.from_branch_name}.`
                          : `Cancel draft ${t.transfer_number}?`)}>Cancel</Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {!list.length && (
              <TableRow><TableCell colSpan={9} sx={{ color: 'text.secondary', py: 3, textAlign: 'center' }}>{loading ? 'Loading…' : 'No transfers.'}</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      <DraftDialog open={draftOpen} onClose={() => setDraftOpen(false)} editing={editing}
        branches={allBranches} warehouses={warehouses} activeBranch={activeBranch}
        onSaved={(t) => { setDraftOpen(false); notify(`Draft ${t.transfer_number} saved.`); load(); }} />
      <ReceiveDialog transfer={receiving} onClose={() => setReceiving(null)}
        onDone={(t) => { setReceiving(null); notify(`${t.transfer_number}: ${STATUS_LABELS[t.status]}`); window.dispatchEvent(new Event('optical_stock_updated')); load(); }} />

      <Dialog open={Boolean(viewing)} onClose={() => setViewing(null)} maxWidth="md" fullWidth>
        <DialogTitle>{viewing?.transfer_number} <StatusChip status={viewing?.status} /></DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" sx={{ mb: 1 }}>
            {viewing?.from_branch_name} → {viewing?.to_branch_name}{viewing?.notes ? ` · ${viewing.notes}` : ''}
          </Typography>
          <Table size="small">
            <TableHead><TableRow><TableCell>Product</TableCell><TableCell align="right">Sent</TableCell><TableCell align="right">Received</TableCell><TableCell align="right">Returned</TableCell><TableCell align="right">In transit</TableCell></TableRow></TableHead>
            <TableBody>
              {(viewing?.items || []).map((it) => (
                <TableRow key={it.id}>
                  <TableCell>{it.product_name}</TableCell><TableCell align="right">{it.quantity}</TableCell>
                  <TableCell align="right">{it.received_quantity}</TableCell><TableCell align="right">{it.returned_quantity}</TableCell>
                  <TableCell align="right">{it.in_transit_quantity}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <Typography variant="subtitle2" sx={{ mt: 2 }}>History</Typography>
          {(viewing?.events || []).map((e) => (
            <Typography key={e.id} variant="body2">{fmtDate(e.performed_at)} · {e.kind} · {e.branch_name} · {e.performed_by}</Typography>
          ))}
          {!(viewing?.events || []).length && <Typography variant="body2" color="text.secondary">Not dispatched yet.</Typography>}
          {viewing?.cancel_reason && <Typography variant="body2" sx={{ mt: 1 }}>Cancel reason: {viewing.cancel_reason}</Typography>}
        </DialogContent>
        <DialogActions><Button onClick={() => setViewing(null)}>Close</Button></DialogActions>
      </Dialog>
    </Box>
  );
}
