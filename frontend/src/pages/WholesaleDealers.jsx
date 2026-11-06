import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Paper, Typography, Stack, Button, TextField, InputAdornment, MenuItem, Table, TableHead,
  TableBody, TableRow, TableCell, TableContainer, TableFooter, IconButton, Tooltip, Chip, Dialog,
  DialogTitle, DialogContent, DialogActions, Grid, CircularProgress, Alert, Checkbox, FormControlLabel,
} from '@mui/material';
import {
  Search as SearchIcon, Add as AddIcon, Edit as EditIcon, Refresh as RefreshIcon,
  PointOfSale as SaleIcon, Storefront as DealersIcon, TableChart as ExcelIcon, DeleteOutline as DeleteIcon,
} from '@mui/icons-material';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';
import axios from 'axios';
import {
  WHOLESALE_API, PRICE_LIST_OPTIONS, LS_KEYS, writeLS, readLS, mapDealerFromApi, mapDealerToApi,
} from './wholesale/wholesaleConstants';
import { describeApiError } from '../utils/apiWriteGuard';
import { notify } from '../utils/notify';

const inr = (n) => `₹${(parseFloat(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const HEAD_SX = { bgcolor: '#0f172a', color: '#fff', fontWeight: 800, fontSize: '0.74rem', whiteSpace: 'nowrap', py: 1 };
const STATUSES = ['Active', 'Inactive', 'Blocked'];

const BLANK = {
  code: '', name: '', contactPerson: '', ownerName: '', phone: '', whatsapp: '', email: '', gstin: '',
  billingAddress: '', shippingAddress: '', sameAsBilling: true, city: '', state: '', pincode: '',
  priceList: 'WHOLESALE', creditLimit: 100000, creditDays: 30, salesExec: '', status: 'Active',
};

// One directory row (dealer + the server's roll-up) → the shape this screen and the POS use.
function rowFromApi(r) {
  const d = mapDealerFromApi(r);
  return {
    ...d,
    shippingOwn: r.shipping_address || '',
    invoiceCount: r.invoice_count || 0,
    totalBusiness: parseFloat(r.total_business) || 0,
    lastInvoiceDate: r.last_invoice_date || '',
    billsDue: parseFloat(r.bills_due) || 0,
    openBills: r.open_bill_count || 0,
  };
}

export default function WholesaleDealers() {
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [dueOnly, setDueOnly] = useState(false);
  const [form, setForm] = useState(null); // null = closed; { ...BLANK, id? }
  const [saving, setSaving] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deletingId, setDeletingId] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const { data } = await axios.get(`${WHOLESALE_API}/dealers/directory/`, { __silentError: true });
      const list = (Array.isArray(data) ? data : []).map(rowFromApi);
      setRows(list);
      // Keep the POS's offline dealer cache in step with what was just read.
      const cached = readLS(LS_KEYS.customers, []);
      const localOnly = cached.filter(c => !list.some(r => r.id === c.id));
      writeLS(LS_KEYS.customers, [...list.map(({ shippingOwn, invoiceCount, totalBusiness, lastInvoiceDate, billsDue, openBills, ...d }) => d), ...localOnly]);
    } catch (e) {
      setError(`Could not load dealers: ${describeApiError(e)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter(r => {
      if (statusFilter !== 'All' && (r.status || 'Active') !== statusFilter) return false;
      if (dueOnly && !(r.billsDue > 0.009)) return false;
      if (!q) return true;
      return [r.name, r.code, r.contactPerson, r.phone, r.gstin, r.email, r.billingAddress, r.shippingAddress, r.city]
        .some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [rows, search, statusFilter, dueOnly]);

  const totals = useMemo(() => ({
    business: filtered.reduce((a, r) => a + r.totalBusiness, 0),
    due: filtered.reduce((a, r) => a + r.billsDue, 0),
  }), [filtered]);

  const openNew = () => setForm({ ...BLANK });
  const openEdit = (r) => setForm({
    ...BLANK, ...r,
    shippingAddress: r.shippingOwn || '',
    sameAsBilling: !r.shippingOwn || r.shippingOwn === r.billingAddress,
  });

  const set = (patch) => setForm(f => ({ ...f, ...patch }));

  const save = async () => {
    if (!form.name.trim() || !form.phone.trim()) { notify('Shop / Firm Name and Phone are required.', 'warning'); return; }
    if (form.gstin && !/^[0-9A-Z]{15}$/i.test(form.gstin.trim())) { notify('GSTIN must be 15 letters / digits.', 'warning'); return; }
    setSaving(true);
    const local = {
      ...form,
      name: form.name.trim(),
      gstin: form.gstin.trim().toUpperCase(),
      shippingAddress: form.sameAsBilling ? '' : form.shippingAddress,
      code: form.code || `DL-${Math.floor(1000 + Math.random() * 9000)}`,
    };
    const payload = mapDealerToApi(local);
    // The balance column is moved by sales and receipts, never by editing the profile.
    delete payload.outstanding_balance;
    payload.shipping_address = form.sameAsBilling ? '' : (form.shippingAddress || '');
    try {
      if (form.id) await axios.patch(`${WHOLESALE_API}/dealers/${form.id}/`, payload, { __silentError: true });
      else await axios.post(`${WHOLESALE_API}/dealers/`, payload, { __silentError: true });
      notify(form.id ? `Dealer ${local.name} updated.` : `Dealer ${local.name} registered.`, 'success');
      setForm(null);
      load();
    } catch (e) {
      notify(`Dealer not saved: ${describeApiError(e)}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  // The server refuses a dealer with invoices / receipts / returns (they all point at it) and
  // says to set it Inactive instead; that message is shown as is.
  const confirmDelete = async () => {
    const r = deleteTarget;
    setDeleteTarget(null);
    if (!r) return;
    setDeletingId(r.id);
    try {
      await axios.delete(`${WHOLESALE_API}/dealers/${r.id}/`, { __silentError: true });
      writeLS(LS_KEYS.customers, readLS(LS_KEYS.customers, []).filter(c => c.id !== r.id));
      setRows(prev => prev.filter(x => x.id !== r.id));
      notify(`Dealer ${r.name} deleted.`, 'success');
    } catch (e) {
      notify(`${describeApiError(e)}`, 'error');
    } finally {
      setDeletingId('');
    }
  };

  const exportCsv = () => {
    const head = ['Code', 'Shop / Firm', 'Contact Person', 'Phone', 'Email', 'GSTIN', 'Billing Address', 'Shipping Address', 'Credit Limit', 'Terms (days)', 'Invoices', 'Total Business', 'Outstanding', 'Status'];
    const body = filtered.map(r => [r.code, r.name, r.contactPerson, r.phone, r.email, r.gstin, r.billingAddress, r.shippingAddress, r.creditLimit, r.creditDays, r.invoiceCount, r.totalBusiness.toFixed(2), r.billsDue.toFixed(2), r.status]);
    const csv = [head, ...body].map(line => line.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8;' }));
    a.download = `Wholesale_Dealers_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
  };

  return (
    <Box sx={{ p: { xs: 1.5, md: 2 }, bgcolor: '#ffffff', minHeight: '100vh' }}>
      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderRadius: 1, borderColor: '#cbd5e1', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <DealersIcon sx={{ color: '#0f172a', fontSize: 30 }} />
          <Box>
            <Typography variant="h6" fontWeight={900} color="#0f172a" sx={{ lineHeight: 1.2 }}>Wholesale Dealers / Customers</Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>Shop &amp; firm profiles, tax IDs, addresses and what each one owes</Typography>
          </Box>
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={load} disabled={loading} sx={{ textTransform: 'none', fontWeight: 800 }}>Refresh</Button>
          <Button size="small" variant="outlined" startIcon={<ExcelIcon />} onClick={exportCsv} disabled={!filtered.length} sx={{ textTransform: 'none', fontWeight: 800 }}>Export</Button>
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={openNew} sx={{ textTransform: 'none', fontWeight: 800, bgcolor: '#0f172a', '&:hover': { bgcolor: '#1e293b' } }}>New Dealer</Button>
        </Stack>
      </Paper>

      <Paper variant="outlined" sx={{ p: 1.5, mb: 1.5, borderRadius: 1, borderColor: '#cbd5e1' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <TextField
            size="small" fullWidth placeholder="Search name, code, contact, phone, GSTIN, address…" value={search} onChange={(e) => setSearch(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} /></InputAdornment> }}
          />
          <TextField select size="small" label="Status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} sx={{ minWidth: 150 }}>
            {['All', ...STATUSES].map(s => <MenuItem key={s} value={s}>{s === 'All' ? 'All statuses' : s}</MenuItem>)}
          </TextField>
          <FormControlLabel control={<Checkbox size="small" checked={dueOnly} onChange={(e) => setDueOnly(e.target.checked)} />} label={<Typography variant="body2" fontWeight={700} noWrap>With outstanding only</Typography>} />
        </Stack>
      </Paper>

      {error && <Alert severity="error" sx={{ mb: 1.5 }}>{error}</Alert>}

      <Paper variant="outlined" sx={{ borderRadius: 1, borderColor: '#cbd5e1', overflow: 'hidden' }}>
        <TableContainer sx={{ maxHeight: 'calc(100vh - 290px)' }}>
          <Table size="small" stickyHeader sx={{ minWidth: 1300 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={HEAD_SX}>Code</TableCell>
                <TableCell sx={HEAD_SX}>Shop / Firm Name</TableCell>
                <TableCell sx={HEAD_SX}>Contact Person</TableCell>
                <TableCell sx={HEAD_SX}>Phone</TableCell>
                <TableCell sx={HEAD_SX}>GSTIN / Tax ID</TableCell>
                <TableCell sx={HEAD_SX}>Billing Address</TableCell>
                <TableCell sx={HEAD_SX}>Shipping Address</TableCell>
                <TableCell sx={HEAD_SX} align="center">Invoices</TableCell>
                <TableCell sx={HEAD_SX} align="right">Total Business</TableCell>
                <TableCell sx={HEAD_SX} align="right">Outstanding</TableCell>
                <TableCell sx={HEAD_SX} align="center">Status</TableCell>
                <TableCell sx={HEAD_SX} align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && !rows.length ? (
                <TableRow><TableCell colSpan={12} align="center" sx={{ py: 5 }}><CircularProgress size={22} /></TableCell></TableRow>
              ) : filtered.length === 0 ? (
                <TableRow><TableCell colSpan={12} align="center" sx={{ py: 5, color: 'text.secondary' }}>{rows.length ? 'No dealer matches these filters.' : 'No dealers yet — add one with "New Dealer".'}</TableCell></TableRow>
              ) : filtered.map(r => {
                const overLimit = r.creditLimit > 0 && r.billsDue > r.creditLimit;
                return (
                  <TableRow key={r.id} hover sx={{ '& td': { fontSize: '0.8rem', verticalAlign: 'top' } }}>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 800 }}>{r.code}</TableCell>
                    <TableCell sx={{ fontWeight: 800, minWidth: 170 }}>
                      {r.name}
                      {r.email && <Typography variant="caption" color="text.secondary" display="block">{r.email}</Typography>}
                    </TableCell>
                    <TableCell>{r.contactPerson || '—'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.phone || '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{r.gstin || '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 220, whiteSpace: 'pre-line' }}>{[r.billingAddress, [r.city, r.state, r.pincode].filter(Boolean).join(', ')].filter(Boolean).join('\n') || '—'}</TableCell>
                    <TableCell sx={{ maxWidth: 220, whiteSpace: 'pre-line' }}>
                      {r.shippingOwn || (r.billingAddress ? <Typography variant="caption" color="text.secondary">Same as billing</Typography> : '—')}
                    </TableCell>
                    <TableCell align="center">{r.invoiceCount}</TableCell>
                    <TableCell align="right">
                      {inr(r.totalBusiness)}
                      {r.lastInvoiceDate && <Typography variant="caption" color="text.secondary" display="block">Last {r.lastInvoiceDate}</Typography>}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 900, color: r.billsDue > 0.009 ? '#dc2626' : '#15803d' }}>
                      <Tooltip title={`${r.openBills} open bill(s) · credit limit ${inr(r.creditLimit)} · ${r.creditDays} day terms${r.openingBalance ? ` · opening balance ${inr(r.openingBalance)}` : ''}`}>
                        <span>{inr(r.billsDue)}</span>
                      </Tooltip>
                      {overLimit && <Typography variant="caption" color="error" display="block" fontWeight={800}>Over limit</Typography>}
                    </TableCell>
                    <TableCell align="center">
                      <Chip size="small" label={r.status || 'Active'} color={(r.status || 'Active') === 'Active' ? 'success' : 'default'} variant="outlined" sx={{ fontWeight: 800, height: 20 }} />
                    </TableCell>
                    <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>
                      <Tooltip title="Edit profile"><IconButton size="small" aria-label={`Edit ${r.name}`} onClick={() => openEdit(r)}><EditIcon sx={{ fontSize: 17 }} /></IconButton></Tooltip>
                      <Tooltip title="New wholesale sale for this dealer"><IconButton size="small" aria-label={`New sale for ${r.name}`} onClick={() => navigate(`/wholesale/pos?dealer=${r.id}`)}><SaleIcon sx={{ fontSize: 17 }} /></IconButton></Tooltip>
                      <Tooltip title={r.invoiceCount ? 'Has invoices — set it Inactive instead of deleting' : 'Delete dealer'}>
                        <span>
                          <IconButton size="small" color="error" aria-label={`Delete ${r.name}`} disabled={deletingId === r.id} onClick={() => setDeleteTarget(r)}>
                            {deletingId === r.id ? <CircularProgress size={14} /> : <DeleteIcon sx={{ fontSize: 18 }} />}
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
            {filtered.length > 0 && (
              <TableFooter>
                <TableRow sx={{ '& td': { fontWeight: 900, color: '#0f172a', fontSize: '0.82rem', borderTop: '2px solid #cbd5e1' } }}>
                  <TableCell colSpan={8}>{filtered.length} dealer{filtered.length === 1 ? '' : 's'}</TableCell>
                  <TableCell align="right">{inr(totals.business)}</TableCell>
                  <TableCell align="right" sx={{ color: '#dc2626 !important' }}>{inr(totals.due)}</TableCell>
                  <TableCell colSpan={2} />
                </TableRow>
              </TableFooter>
            )}
          </Table>
        </TableContainer>
      </Paper>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
        Outstanding = unpaid balance of the dealer's confirmed invoices (paid amounts and credit notes deducted). Drafts and cancelled bills are not counted.
      </Typography>

      <ConfirmActionDialog
        open={Boolean(deleteTarget)} type="danger" title="Delete dealer?" confirmText="Delete"
        message={deleteTarget ? `Delete ${deleteTarget.name} (${deleteTarget.code})? This is only possible for a dealer with no invoices, payments or returns; otherwise set it Inactive.` : ''}
        onClose={() => setDeleteTarget(null)}
        onConfirm={confirmDelete}
      />

      <Dialog open={Boolean(form)} onClose={() => !saving && setForm(null)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 900 }}>{form?.id ? `Edit Dealer — ${form.name}` : 'New Wholesale Dealer'}</DialogTitle>
        {form && (
          <DialogContent dividers>
            <Grid container spacing={1.5}>
              <Grid item xs={12} sm={3}><TextField fullWidth size="small" label="Dealer Code" placeholder="Auto" value={form.code} disabled={Boolean(form.id)} onChange={(e) => set({ code: e.target.value })} /></Grid>
              <Grid item xs={12} sm={6}><TextField fullWidth size="small" autoFocus label="Shop / Firm Name *" value={form.name} onChange={(e) => set({ name: e.target.value })} /></Grid>
              <Grid item xs={12} sm={3}>
                <TextField select fullWidth size="small" label="Status" value={form.status || 'Active'} onChange={(e) => set({ status: e.target.value })}>
                  {STATUSES.map(s => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={4}><TextField fullWidth size="small" label="Contact Person" value={form.contactPerson} onChange={(e) => set({ contactPerson: e.target.value })} /></Grid>
              <Grid item xs={12} sm={4}><TextField fullWidth size="small" label="Phone *" value={form.phone} onChange={(e) => set({ phone: e.target.value })} /></Grid>
              <Grid item xs={12} sm={4}><TextField fullWidth size="small" label="WhatsApp" value={form.whatsapp} onChange={(e) => set({ whatsapp: e.target.value })} /></Grid>
              <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="Email" value={form.email} onChange={(e) => set({ email: e.target.value })} /></Grid>
              <Grid item xs={12} sm={6}><TextField fullWidth size="small" label="GSTIN / Tax ID" value={form.gstin} onChange={(e) => set({ gstin: e.target.value.toUpperCase() })} inputProps={{ maxLength: 15, style: { fontFamily: 'monospace' } }} /></Grid>
              <Grid item xs={12}><TextField fullWidth size="small" multiline minRows={2} label="Billing Address" value={form.billingAddress} onChange={(e) => set({ billingAddress: e.target.value })} /></Grid>
              <Grid item xs={12} sm={4}><TextField fullWidth size="small" label="City" value={form.city} onChange={(e) => set({ city: e.target.value })} /></Grid>
              <Grid item xs={12} sm={4}><TextField fullWidth size="small" label="State" value={form.state} onChange={(e) => set({ state: e.target.value })} /></Grid>
              <Grid item xs={12} sm={4}><TextField fullWidth size="small" label="PIN Code" value={form.pincode} onChange={(e) => set({ pincode: e.target.value })} /></Grid>
              <Grid item xs={12}>
                <FormControlLabel control={<Checkbox size="small" checked={form.sameAsBilling} onChange={(e) => set({ sameAsBilling: e.target.checked })} />} label={<Typography variant="body2" fontWeight={700}>Shipping address same as billing</Typography>} />
                {!form.sameAsBilling && (
                  <TextField fullWidth size="small" multiline minRows={2} label="Shipping Address" value={form.shippingAddress} onChange={(e) => set({ shippingAddress: e.target.value })} sx={{ mt: 1 }} />
                )}
              </Grid>
              <Grid item xs={12} sm={3}>
                <TextField select fullWidth size="small" label="Price List" value={form.priceList} onChange={(e) => set({ priceList: e.target.value })}>
                  {PRICE_LIST_OPTIONS.map(p => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={3}><TextField fullWidth size="small" type="number" label="Credit Limit (₹)" value={form.creditLimit} onChange={(e) => set({ creditLimit: e.target.value })} /></Grid>
              <Grid item xs={12} sm={3}><TextField fullWidth size="small" type="number" label="Payment Terms (days)" value={form.creditDays} onChange={(e) => set({ creditDays: e.target.value })} /></Grid>
              <Grid item xs={12} sm={3}><TextField fullWidth size="small" label="Sales Executive" value={form.salesExec} onChange={(e) => set({ salesExec: e.target.value })} /></Grid>
              {form.id && (
                <Grid item xs={12}>
                  <Alert severity="info" sx={{ py: 0 }}>
                    Outstanding {inr(form.billsDue)} across {form.openBills} open bill(s). Balances change only through sales, receipts and credit notes — not from this profile.
                  </Alert>
                </Grid>
              )}
            </Grid>
          </DialogContent>
        )}
        <DialogActions>
          <Button onClick={() => setForm(null)} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={saving} sx={{ fontWeight: 800 }}>{saving ? 'Saving…' : form?.id ? 'Save Changes' : 'Register Dealer'}</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
