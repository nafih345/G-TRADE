import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Card, Checkbox, Chip, FormControlLabel, Grid, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  Add as NewIcon, Edit as EditIcon, Save as SaveIcon, Close as CancelIcon, Block as DeactivateIcon,
  Refresh as RefreshIcon, AccountBalance as BankIcon,
} from '@mui/icons-material';
import useBankAccounts from '../../hooks/useBankAccounts';
import { notify } from '../../utils/notify';
import { apiErrorMessage } from '../../utils/apiError';

// Settings > Bank Master. Every bank here is also a ledger under Chart of Accounts > Bank
// Accounts, and is what the Bank / UPI pickers on payment screens offer.
const API = '/api/financial/banks/';
const EMPTY = {
  id: null, sl_no: '', code: '', account_name: '', bank_name: '', branch_name: '', address: '',
  iban_number: '', vat_reg_number: '', account_number: '', account_holder: '', ifsc_code: '',
  country_code: '95', country: 'INDIA', is_default_card: false, status: 'Active', is_system: false,
};

const Row = ({ label, children }) => (
  <Grid container alignItems="center" spacing={1.5} sx={{ mb: 1.25 }}>
    <Grid item xs={12} sm={4}><Typography variant="body2" fontWeight={700} color="text.secondary">{label}</Typography></Grid>
    <Grid item xs={12} sm={8}>{children}</Grid>
  </Grid>
);

export default function BankMasterSettings() {
  const [banks, setBanks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [mode, setMode] = useState('view'); // view | new | edit
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const { reload: reloadPickers } = useBankAccounts();
  const editing = mode !== 'view';

  const load = useCallback(async (selectId) => {
    setLoading(true);
    try {
      const res = await axios.get(API);
      const rows = Array.isArray(res.data) ? res.data : [];
      setBanks(rows);
      const pick = rows.find(b => b.id === selectId) || rows[0];
      setSelectedId(pick ? pick.id : null);
      setForm(pick ? { ...EMPTY, ...pick } : EMPTY);
    } catch (err) {
      notify(`Could not load banks — ${apiErrorMessage(err)}`, 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const selected = useMemo(() => banks.find(b => b.id === selectedId) || null, [banks, selectedId]);
  const set = (patch) => setForm(f => ({ ...f, ...patch }));

  const pickRow = (bank) => {
    if (editing) return; // finish or cancel the edit first
    setSelectedId(bank.id);
    setForm({ ...EMPTY, ...bank });
    setErrors({});
  };

  const startNew = () => {
    const nextSl = banks.reduce((m, b) => Math.max(m, b.sl_no || 0), 0) + 1;
    setForm({ ...EMPTY, sl_no: nextSl });
    setErrors({});
    setMode('new');
  };

  const startEdit = () => {
    if (!selected) return;
    setForm({ ...EMPTY, ...selected });
    setErrors({});
    setMode('edit');
  };

  const cancel = () => {
    setForm(selected ? { ...EMPTY, ...selected } : EMPTY);
    setErrors({});
    setMode('view');
  };

  const save = async () => {
    if (saving) return;
    if (!form.account_name.trim() && !form.bank_name.trim()) {
      setErrors({ bank_name: 'Enter the bank name.' });
      return;
    }
    setSaving(true);
    try {
      const body = { ...form, sl_no: parseInt(form.sl_no, 10) || 0 };
      const res = mode === 'new' ? await axios.post(API, body) : await axios.put(`${API}${form.id}/`, body);
      notify(`Bank "${res.data.name}" ${mode === 'new' ? 'added' : 'updated'}.`, 'success');
      setMode('view');
      setErrors({});
      await load(res.data.id);
      reloadPickers();
    } catch (err) {
      const data = err?.response?.data;
      if (data && typeof data === 'object' && !data.detail) {
        setErrors(Object.fromEntries(Object.entries(data).map(([k, v]) => [k, Array.isArray(v) ? v.join(' ') : String(v)])));
        notify('Please correct the highlighted fields.', 'error');
      } else {
        notify(`Bank not saved — ${apiErrorMessage(err)}`, 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async () => {
    if (!selected) return;
    const activating = selected.status !== 'Active';
    if (!activating && !window.confirm(`Deactivate "${selected.name}"? It stays in the books but won't be offered on payment screens.`)) return;
    try {
      if (activating) await axios.patch(`${API}${selected.id}/`, { status: 'Active' });
      else await axios.delete(`${API}${selected.id}/`);
      notify(`"${selected.name}" ${activating ? 'reactivated' : 'deactivated'}.`, 'success');
      await load(selected.id);
      reloadPickers();
    } catch (err) {
      notify(apiErrorMessage(err), 'error');
    }
  };

  // Ctrl+S saves, Esc cancels while the form is open.
  useEffect(() => {
    if (!editing) return undefined;
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const field = (name, props = {}) => (
    <TextField
      fullWidth size="small" value={form[name] ?? ''} disabled={!editing}
      onChange={(e) => set({ [name]: e.target.value })}
      error={!!errors[name]} helperText={errors[name]}
      inputProps={{ 'aria-label': name.replace(/_/g, ' ') }}
      {...props}
    />
  );

  const toolBtn = { fontWeight: 800, textTransform: 'none', minWidth: 96 };

  return (
    <Card sx={{ p: 3, borderRadius: 3 }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 0.5 }}>
        <BankIcon color="primary" />
        <Typography variant="h6" fontWeight={800}>Bank Master</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        Banks added here are offered wherever a payment is made by Bank or UPI, and each one is a ledger under Chart of Accounts › Bank Accounts.
      </Typography>

      <Grid container spacing={3}>
        {/* Left: toolbar + form */}
        <Grid item xs={12} md={5}>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 2 }}>
            <Button variant="contained" startIcon={<NewIcon />} onClick={startNew} disabled={editing} sx={toolBtn}>New</Button>
            <Button variant="outlined" startIcon={<EditIcon />} onClick={startEdit} disabled={editing || !selected} sx={toolBtn}>Edit</Button>
            <Button variant="contained" color="success" startIcon={<SaveIcon />} onClick={save} disabled={!editing || saving} sx={toolBtn}>Save</Button>
            <Button variant="outlined" color="inherit" startIcon={<CancelIcon />} onClick={cancel} disabled={!editing} sx={toolBtn}>Cancel</Button>
            <Tooltip title={selected?.is_system ? 'The default bank account cannot be deactivated' : ''}>
              <span>
                <Button variant="outlined" color={selected?.status === 'Active' ? 'error' : 'success'} startIcon={<DeactivateIcon />}
                  onClick={toggleActive} disabled={editing || !selected || selected.is_system} sx={toolBtn}>
                  {selected && selected.status !== 'Active' ? 'Activate' : 'Deactivate'}
                </Button>
              </span>
            </Tooltip>
            <Button variant="outlined" startIcon={<RefreshIcon />} onClick={() => load(selectedId)} disabled={editing} sx={toolBtn}>Refresh</Button>
          </Stack>

          {mode !== 'view' && (
            <Alert severity="info" sx={{ mb: 2, py: 0 }}>
              {mode === 'new' ? 'Adding a new bank' : `Editing ${selected?.name}`} — Ctrl+S to save, Esc to cancel.
            </Alert>
          )}

          <Box component="form" onSubmit={(e) => { e.preventDefault(); save(); }}>
            <Row label="Sl.No">{field('sl_no', { type: 'number', sx: { maxWidth: 120 } })}</Row>
            <Row label="Account Code">
              <TextField fullWidth size="small" disabled value={mode === 'new' ? 'Auto' : form.code} sx={{ maxWidth: 200 }} inputProps={{ 'aria-label': 'account code' }} />
            </Row>
            <Row label="Account Name">{field('account_name', { placeholder: 'Ledger name, e.g. ESAF PRECIUS' })}</Row>
            <Row label="Bank Name">{field('bank_name', { placeholder: 'e.g. State Bank of India' })}</Row>
            <Row label="Branch">{field('branch_name', { placeholder: 'Branch name' })}</Row>
            <Row label="Address">{field('address', { multiline: true, minRows: 3 })}</Row>
            <Row label="IFSC Code">{field('ifsc_code', { placeholder: 'SBIN0001234', onChange: (e) => set({ ifsc_code: e.target.value.toUpperCase() }) })}</Row>
            <Row label="IBAN Number">{field('iban_number')}</Row>
            <Row label="VAT / GST Reg Number">{field('vat_reg_number')}</Row>
            <Row label="Acc Number">{field('account_number')}</Row>
            <Row label="Acc Holder">{field('account_holder')}</Row>
            <Row label="Country">
              <Stack direction="row" spacing={1}>
                {field('country_code', { sx: { width: 80 } })}
                {field('country')}
              </Stack>
            </Row>
            <FormControlLabel
              disabled={!editing}
              control={<Checkbox checked={!!form.is_default_card} onChange={(e) => set({ is_default_card: e.target.checked })} />}
              label={<Typography variant="body2" fontWeight={700}>Default Account for Card Transaction</Typography>}
              sx={{ mt: 0.5, px: 1, py: 0.25, borderRadius: 1.5, bgcolor: form.is_default_card ? 'action.selected' : 'transparent', border: '1px solid', borderColor: 'divider', width: '100%', mx: 0 }}
            />
            {errors.is_default_card && <Typography variant="caption" color="error">{errors.is_default_card}</Typography>}
            <button type="submit" hidden aria-hidden="true" tabIndex={-1} />
          </Box>
        </Grid>

        {/* Right: bank grid */}
        <Grid item xs={12} md={7}>
          <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, maxHeight: 640 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 800, width: 70 }}>Sl.No</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Bank</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Acc Number</TableCell>
                  <TableCell sx={{ fontWeight: 800, width: 120 }} align="right">Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {banks.map((b) => {
                  const isSel = b.id === selectedId;
                  return (
                    <TableRow
                      key={b.id} hover selected={isSel} onClick={() => pickRow(b)}
                      sx={{ cursor: editing ? 'default' : 'pointer', opacity: b.status === 'Active' ? 1 : 0.55,
                        '&.Mui-selected, &.Mui-selected:hover': { bgcolor: '#fef08a' } }}
                    >
                      <TableCell>{b.sl_no || '—'}</TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={700}>{b.name}</Typography>
                        {(b.bank_name && b.bank_name !== b.name) || b.branch_name ? (
                          <Typography variant="caption" color="text.secondary">
                            {[b.bank_name !== b.name && b.bank_name, b.branch_name].filter(Boolean).join(' · ')}
                          </Typography>
                        ) : null}
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{b.account_number || ''}</TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                          {b.is_default_card && <Chip size="small" color="primary" label="Card" sx={{ fontWeight: 700 }} />}
                          {b.status !== 'Active' && <Chip size="small" label="Inactive" />}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && banks.length === 0 && (
                  <TableRow><TableCell colSpan={4} align="center" sx={{ py: 4, color: 'text.secondary' }}>No banks yet — click New to add one.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Grid>
      </Grid>
    </Card>
  );
}
