// Bank Book → Pending Settlements: a party has agreed to pay us (or we have agreed to pay them) by
// bank transfer later. GET/POST /api/financial/bankbook/pending/, PATCH .../<id>/ for edits and
// status. Tracking only — nothing posts. When the money moves it is booked the usual way (Receipt /
// Payment Voucher, Record Payment …) and the row is marked Settled, linked to that bank entry
// (suggested by GET .../<id>/matches/), which then shows "Settles PBS-…" in the Bank Book.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, IconButton,
  LinearProgress, MenuItem, Paper, Radio, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination,
  TableRow, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, CheckCircle as SettleIcon, Cancel as CancelIcon, Edit as EditIcon, Replay as ReopenIcon,
  FilterAlt as ApplyIcon,
} from '@mui/icons-material';
import { apiError, finGet, finPatch, finPost } from './financialApi';
import { DaysLeftChip } from './ChequeDetailsDialog';
import { BANK_MODES } from './bankModes';
import { formatDate, formatMoney } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';

const NAVY = '#0f1e3d';
const IN_COLOR = '#15803d';
const OUT_COLOR = '#b91c1c';
const STATUS_COLORS = { PENDING: 'warning', SETTLED: 'success', CANCELLED: 'default' };
const PENDING_MODES = BANK_MODES.filter(([v]) => v !== 'CASH');
const head = { color: '#3730a3', fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap', bgcolor: '#eef2ff', borderBottom: '1px solid #c7d2fe', py: 1.25 };
const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const KIND_LABEL = { customer: 'Customer', dealer: 'Dealer', supplier: 'Supplier', other: 'Other' };

const blank = (accounts) => ({
  direction: 'RECEIVE', partyKind: 'other', partyId: '', partyName: '', partyPhone: '', billNumbers: '', amount: '',
  agreedDate: today(), expectedDate: today(), bankAccount: (accounts.find(a => a.is_default) || accounts[0])?.id || '',
  mode: 'BANK_TRANSFER', reference: '', notes: '',
});

function PendingFormDialog({ open, row, accounts, onClose, onSaved }) {
  const editing = !!row;
  const [f, setF] = useState(() => blank(accounts));
  const [parties, setParties] = useState([]);
  const [partyQuery, setPartyQuery] = useState('');
  const [bills, setBills] = useState([]);
  const [picked, setPicked] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setError('');
    setBills([]);
    setPicked([]);
    setF(row ? {
      direction: row.direction, partyKind: row.party_kind || 'other', partyId: row.party_id, partyName: row.party_name,
      partyPhone: row.party_phone, billNumbers: row.bill_numbers, amount: row.amount, agreedDate: row.agreed_date,
      expectedDate: row.expected_date, bankAccount: row.bank_account || '', mode: row.mode || 'BANK_TRANSFER',
      reference: row.reference, notes: row.notes,
    } : blank(accounts));
  }, [open, row, accounts]);

  // Party search: customers / dealers for money to receive, suppliers for money to pay.
  useEffect(() => {
    if (!open || editing) return undefined;
    let alive = true;
    const t = setTimeout(() => {
      finGet('settlements/parties/', { voucher: f.direction === 'RECEIVE' ? 'RV' : 'PV', search: partyQuery, limit: 20 })
        .then((d) => { if (alive) setParties(d.results || []); })
        .catch(() => { if (alive) setParties([]); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [open, editing, f.direction, partyQuery]);

  const chooseParty = async (p) => {
    if (!p || typeof p === 'string') {
      setF(x => ({ ...x, partyKind: 'other', partyId: '', partyName: p || '' }));
      setBills([]);
      return;
    }
    setF(x => ({ ...x, partyKind: p.kind, partyId: p.id, partyName: p.name, partyPhone: p.mobile || x.partyPhone }));
    setPicked([]);
    try {
      const d = await finGet('settlements/due-bills/', { party_kind: p.kind, party: p.id });
      setBills(d.bills || []);
    } catch {
      setBills([]);
    }
  };
  const toggleBill = (b) => {
    const next = picked.includes(b.id) ? picked.filter(x => x !== b.id) : [...picked, b.id];
    setPicked(next);
    const chosen = bills.filter(x => next.includes(x.id));
    if (chosen.length) {
      setF(x => ({ ...x, billNumbers: chosen.map(c => c.number).join(', '), amount: chosen.reduce((t, c) => t + parseFloat(c.due || 0), 0).toFixed(2) }));
    }
  };

  const set = (k) => (e) => setF(x => ({ ...x, [k]: e.target.value }));
  const save = async () => {
    if (!f.partyName.trim()) { setError('Enter the party name.'); return; }
    if (!(parseFloat(f.amount) > 0)) { setError('Enter an amount more than zero.'); return; }
    if (f.expectedDate < f.agreedDate) { setError('Expected date cannot be before the agreed date.'); return; }
    setSaving(true);
    setError('');
    const body = {
      party_name: f.partyName.trim(), party_phone: f.partyPhone.trim(), bill_numbers: f.billNumbers.trim(), amount: f.amount,
      expected_date: f.expectedDate, bank_account: f.bankAccount || null, mode: f.mode, reference: f.reference.trim(), notes: f.notes.trim(),
    };
    try {
      if (editing) {
        await finPatch(`bankbook/pending/${row.id}/`, body);
      } else {
        await finPost('bankbook/pending/', { ...body, direction: f.direction, party_kind: f.partyKind, party_id: f.partyId, agreed_date: f.agreedDate });
      }
      notify(editing ? 'Pending settlement updated.' : 'Pending bank settlement recorded.', 'success');
      onSaved();
    } catch (e) {
      setError(apiError(e, 'Could not save the pending settlement.'));
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 850 }}>{editing ? `Edit ${row.number}` : 'New Pending Bank Settlement'}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          {!editing && (
            <ToggleButtonGroup exclusive size="small" value={f.direction}
              onChange={(e, v) => { if (v) { setF(x => ({ ...x, direction: v, partyKind: 'other', partyId: '', partyName: '' })); setBills([]); setPicked([]); } }}>
              <ToggleButton value="RECEIVE" sx={{ fontWeight: 700 }}>To Receive (customer / dealer pays us)</ToggleButton>
              <ToggleButton value="PAY" sx={{ fontWeight: 700 }}>To Pay (we pay a supplier / party)</ToggleButton>
            </ToggleButtonGroup>
          )}
          <Grid container spacing={2}>
            <Grid item xs={12} md={8}>
              {editing ? (
                <TextField fullWidth label="Party" value={f.partyName} onChange={set('partyName')} required />
              ) : (
                <Autocomplete key={f.direction} freeSolo options={parties} filterOptions={(x) => x}
                  getOptionLabel={(o) => (typeof o === 'string' ? o : o.name)}
                  isOptionEqualToValue={(o, v) => o.id === v.id}
                  onInputChange={(e, v, reason) => { setPartyQuery(v); if (reason === 'input') setF(x => ({ ...x, partyName: v, partyKind: 'other', partyId: '' })); }}
                  onChange={(e, v) => chooseParty(v)}
                  renderOption={(props, o) => (
                    <li {...props} key={`${o.kind}-${o.id}`}>
                      <Box sx={{ width: '100%' }}>
                        <Typography variant="body2" fontWeight={700}>{o.name} <Typography component="span" variant="caption" color="text.secondary">· {KIND_LABEL[o.kind]} {o.code}</Typography></Typography>
                        <Typography variant="caption" color="text.secondary">{o.mobile}{parseFloat(o.outstanding) > 0 ? ` · Outstanding ${formatMoney(o.outstanding)} (${o.open_bills} bills)` : ''}</Typography>
                      </Box>
                    </li>
                  )}
                  renderInput={(params) => <TextField {...params} label="Party (search or type a name)" required autoFocus />} />
              )}
            </Grid>
            <Grid item xs={12} md={4}><TextField fullWidth label="Phone" value={f.partyPhone} onChange={set('partyPhone')} /></Grid>
          </Grid>
          {bills.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1, maxHeight: 180, overflow: 'auto' }}>
              <Typography variant="caption" fontWeight={800} color="text.secondary">OUTSTANDING BILLS — tick the ones this settlement covers</Typography>
              {bills.map(b => (
                <Stack key={b.id} direction="row" alignItems="center" spacing={1}>
                  <Checkbox size="small" checked={picked.includes(b.id)} onChange={() => toggleBill(b)} />
                  <Typography variant="body2" sx={{ flex: 1 }}>{b.number} · {formatDate(b.date)}</Typography>
                  <Typography variant="body2" fontWeight={700}>{formatMoney(b.due)}</Typography>
                </Stack>
              ))}
            </Paper>
          )}
          <Grid container spacing={2}>
            <Grid item xs={12} md={8}><TextField fullWidth label="Bill number(s)" value={f.billNumbers} onChange={set('billNumbers')} /></Grid>
            <Grid item xs={12} md={4}><TextField fullWidth required type="number" label="Amount" value={f.amount} onChange={set('amount')} inputProps={{ min: 0, step: '0.01' }} /></Grid>
            <Grid item xs={6} md={4}><TextField fullWidth type="date" label="Agreed on" value={f.agreedDate} onChange={set('agreedDate')} disabled={editing} InputLabelProps={{ shrink: true }} /></Grid>
            <Grid item xs={6} md={4}><TextField fullWidth type="date" label="Expected by" value={f.expectedDate} onChange={set('expectedDate')} InputLabelProps={{ shrink: true }} inputProps={{ min: f.agreedDate }} /></Grid>
            <Grid item xs={12} md={4}>
              <TextField select fullWidth label="Mode" value={f.mode} onChange={set('mode')}>
                {PENDING_MODES.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={12} md={6}>
              <TextField select fullWidth label="Bank account" value={f.bankAccount} onChange={set('bankAccount')}>
                <MenuItem value=""><em>Not decided</em></MenuItem>
                {accounts.map(a => <MenuItem key={a.id} value={a.id}>{a.code} - {a.name}{a.account_number ? ` · A/c ${a.account_number}` : ''}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={12} md={6}><TextField fullWidth label="Reference / UTR (if known)" value={f.reference} onChange={set('reference')} inputProps={{ maxLength: 80 }} /></Grid>
            <Grid item xs={12}><TextField fullWidth multiline minRows={2} label="Notes" value={f.notes} onChange={set('notes')} inputProps={{ maxLength: 500 }} /></Grid>
          </Grid>
          <Typography variant="caption" color="text.secondary">
            Tracking only — nothing is posted and the bank balance does not change until the money is actually received or paid.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3 }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving} sx={{ bgcolor: NAVY, fontWeight: 700 }}>{editing ? 'Save' : 'Record'}</Button>
      </DialogActions>
    </Dialog>
  );
}

function SettleDialog({ row, onClose, onSaved }) {
  const [matches, setMatches] = useState(null);
  const [choice, setChoice] = useState('');
  const [voucher, setVoucher] = useState('');
  const [date, setDate] = useState(today());
  const [amount, setAmount] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!row) return undefined;
    let alive = true;
    setMatches(null); setChoice(''); setVoucher(''); setDate(today()); setAmount(row.amount); setReference(row.reference || ''); setError('');
    finGet(`bankbook/pending/${row.id}/matches/`)
      .then((d) => { if (!alive) return; setMatches(d.results || []); const exact = (d.results || []).find(m => m.exact_amount); if (exact) { setChoice(exact.entry_id); setDate(exact.date); } })
      .catch(() => { if (alive) setMatches([]); });
    return () => { alive = false; };
  }, [row]);

  const pick = (m) => { setChoice(m.entry_id); setVoucher(''); setDate(m.date); setAmount(m.deposit || m.withdrawal); };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await finPatch(`bankbook/pending/${row.id}/`, {
        status: 'SETTLED', settled_date: date, settled_amount: amount, reference: reference.trim(),
        ...(choice ? { journal_entry: choice } : voucher.trim() ? { voucher_number: voucher.trim() } : {}),
      });
      notify(`${row.number} marked settled.`, 'success');
      onSaved();
    } catch (e) {
      setError(apiError(e, 'Could not settle.'));
    }
    setSaving(false);
  };

  return (
    <Dialog open={!!row} onClose={saving ? undefined : onClose} maxWidth="md" fullWidth>
      {row && (
        <>
          <DialogTitle sx={{ fontWeight: 850 }}>
            Settle {row.number}
            <Typography variant="body2" color="text.secondary">{row.direction_label} · {row.party_name} · {formatMoney(row.amount)}</Typography>
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              {error && <Alert severity="error">{error}</Alert>}
              <Typography variant="subtitle2" fontWeight={800}>Link the bank entry that booked this money</Typography>
              {matches === null && <LinearProgress />}
              {matches && matches.length === 0 && (
                <Alert severity="info">No unlinked bank {row.direction === 'RECEIVE' ? 'credits' : 'debits'} since {formatDate(row.agreed_date)}. Record the
                  {row.direction === 'RECEIVE' ? ' receipt' : ' payment'} first (Receipt / Payment Voucher or Record Payment), or enter its voucher number below.</Alert>
              )}
              {matches && matches.length > 0 && (
                <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: 260 }}>
                  <Table size="small" stickyHeader>
                    <TableHead><TableRow>
                      <TableCell sx={head} /><TableCell sx={head}>Date</TableCell><TableCell sx={head}>Voucher</TableCell>
                      <TableCell sx={head}>Party</TableCell><TableCell sx={head}>Mode / Ref</TableCell><TableCell sx={head} align="right">Amount</TableCell>
                    </TableRow></TableHead>
                    <TableBody>
                      {matches.map(m => (
                        <TableRow key={m.row_id} hover selected={choice === m.entry_id} onClick={() => pick(m)} sx={{ cursor: 'pointer' }}>
                          <TableCell padding="checkbox"><Radio size="small" checked={choice === m.entry_id} /></TableCell>
                          <TableCell>{formatDate(m.date)}</TableCell>
                          <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{m.entry_number}<Typography variant="caption" display="block" color="text.secondary">{m.bank_account}</Typography></TableCell>
                          <TableCell>{m.party || '—'}{m.party_match && <Chip size="small" color="success" label="party" sx={{ ml: 0.5, height: 18 }} />}</TableCell>
                          <TableCell>{m.mode_label}{m.reference ? ` · ${m.reference}` : ''}</TableCell>
                          <TableCell align="right" sx={{ fontWeight: 700 }}>
                            {formatMoney(m.deposit || m.withdrawal)}{m.exact_amount && <Chip size="small" color="success" label="exact" sx={{ ml: 0.5, height: 18 }} />}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}
              <Grid container spacing={2}>
                <Grid item xs={12} md={4}>
                  <TextField fullWidth label="…or voucher / bill number" value={voucher}
                    onChange={(e) => { setVoucher(e.target.value); if (e.target.value) setChoice(''); }} />
                </Grid>
                <Grid item xs={6} md={4}><TextField fullWidth type="date" label="Settled on" value={date} onChange={(e) => setDate(e.target.value)} InputLabelProps={{ shrink: true }} inputProps={{ min: row.agreed_date }} /></Grid>
                <Grid item xs={6} md={4}><TextField fullWidth type="number" label="Settled amount" value={amount} onChange={(e) => setAmount(e.target.value)} inputProps={{ min: 0, step: '0.01' }} /></Grid>
                <Grid item xs={12}><TextField fullWidth label="Reference / UTR" value={reference} onChange={(e) => setReference(e.target.value)} inputProps={{ maxLength: 80 }}
                  helperText="Copied onto the linked Bank Book entry if it has no reference yet." /></Grid>
              </Grid>
              {!choice && !voucher.trim() && <Alert severity="warning">Not linked to a bank entry — it will be marked settled without a match in the Bank Book.</Alert>}
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3 }}>
            <Button onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="contained" color="success" onClick={save} disabled={saving} sx={{ fontWeight: 700 }}>Mark Settled</Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

function CancelDialog({ row, onClose, onSaved }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { setReason(''); setError(''); }, [row]);
  const save = async () => {
    if (!reason.trim()) { setError('Give a reason for cancelling.'); return; }
    setSaving(true);
    try {
      await finPatch(`bankbook/pending/${row.id}/`, { status: 'CANCELLED', status_note: reason.trim() });
      notify(`${row.number} cancelled.`, 'success');
      onSaved();
    } catch (e) {
      setError(apiError(e, 'Could not cancel.'));
    }
    setSaving(false);
  };
  return (
    <Dialog open={!!row} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      {row && (
        <>
          <DialogTitle sx={{ fontWeight: 850 }}>Cancel {row.number}</DialogTitle>
          <DialogContent dividers>
            {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
            <TextField fullWidth autoFocus multiline minRows={2} label="Reason" value={reason} onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. paid in cash instead, bill cancelled" />
          </DialogContent>
          <DialogActions sx={{ px: 3 }}>
            <Button onClick={onClose} disabled={saving}>Back</Button>
            <Button variant="contained" color="error" onClick={save} disabled={saving} sx={{ fontWeight: 700 }}>Cancel Settlement</Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

const defaultFilters = { direction: '', status: 'PENDING', due: '', search: '' };

export default function BankPendingSettlements({ accounts, onChanged }) {
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null);       // {row} or {} for new
  const [settleRow, setSettleRow] = useState(null);
  const [cancelRow, setCancelRow] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const d = await finGet('bankbook/pending/', { ...applied, page: page + 1, page_size: pageSize });
      setData(d);
      onChanged?.((d.summary?.to_receive?.count || 0) + (d.summary?.to_pay?.count || 0));
    } catch (e) {
      setError(apiError(e));
      setData(null);
    }
    setLoading(false);
  }, [applied, page, pageSize, onChanged]);
  useEffect(() => { load(); }, [load]);

  const set = (k) => (e) => setDraft(f => ({ ...f, [k]: e.target.value }));
  const apply = (next) => { setPage(0); setApplied(next || { ...draft }); if (next) setDraft(next); };
  const reopen = async (r) => {
    try {
      await finPatch(`bankbook/pending/${r.id}/`, { status: 'PENDING' });
      notify(`${r.number} is pending again.`, 'success');
      load();
    } catch (e) {
      notify(apiError(e, 'Could not reopen.'), 'error');
    }
  };
  const done = () => { setForm(null); setSettleRow(null); setCancelRow(null); load(); };
  const s = data?.summary;
  const cards = useMemo(() => s ? [
    ['TO RECEIVE', s.to_receive, IN_COLOR, { ...defaultFilters, direction: 'RECEIVE' }],
    ['TO PAY', s.to_pay, OUT_COLOR, { ...defaultFilters, direction: 'PAY' }],
    ['OVERDUE', s.overdue, '#b45309', { ...defaultFilters, due: 'overdue' }],
    ['DUE TODAY', s.due_today, '#0369a1', { ...defaultFilters, due: 'today' }],
    ['DUE THIS WEEK', s.due_week, '#3730a3', { ...defaultFilters, due: 'week' }],
  ] : [], [s]);

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, bgcolor: '#f8fafc' }}>
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        {cards.map(([label, v, color, filt]) => (
          <Grid item xs={6} sm={4} md key={label}>
            <Paper variant="outlined" onClick={() => apply(filt)} role="button" tabIndex={0}
              onKeyDown={(e) => { if (e.key === 'Enter') apply(filt); }}
              sx={{ p: 1.5, borderRadius: 2, borderLeft: `4px solid ${color}`, cursor: 'pointer', '&:hover': { bgcolor: '#f1f5f9' } }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>{label}</Typography>
              <Typography variant="h6" fontWeight={850} sx={{ color }}>{formatMoney(v.amount)}</Typography>
              <Typography variant="caption" color="text.secondary">{v.count} pending</Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      <Box component="form" onSubmit={(e) => { e.preventDefault(); apply(); }}
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 2 }}>
        <TextField select size="small" label="Direction" value={draft.direction} onChange={set('direction')} sx={{ width: 150, bgcolor: '#fff' }}>
          <MenuItem value="">All</MenuItem><MenuItem value="RECEIVE">To Receive</MenuItem><MenuItem value="PAY">To Pay</MenuItem>
        </TextField>
        <TextField select size="small" label="Status" value={draft.status} onChange={set('status')} sx={{ width: 150, bgcolor: '#fff' }}>
          <MenuItem value="">All</MenuItem><MenuItem value="PENDING">Pending</MenuItem><MenuItem value="SETTLED">Settled</MenuItem><MenuItem value="CANCELLED">Cancelled</MenuItem>
        </TextField>
        <TextField select size="small" label="Due" value={draft.due} onChange={set('due')} sx={{ width: 150, bgcolor: '#fff' }}>
          <MenuItem value="">Any time</MenuItem><MenuItem value="overdue">Overdue</MenuItem><MenuItem value="today">Due today</MenuItem><MenuItem value="week">Next 7 days</MenuItem>
        </TextField>
        <TextField size="small" label="Search" placeholder="Party, phone, bill, UTR, PBS no…" value={draft.search} onChange={set('search')}
          sx={{ flex: '1 1 220px', minWidth: 200, bgcolor: '#fff' }} />
        <Button type="submit" variant="contained" startIcon={<ApplyIcon />} sx={{ fontWeight: 700, bgcolor: NAVY }}>Apply</Button>
        <Button variant="contained" color="success" startIcon={<AddIcon />} onClick={() => setForm({})} sx={{ fontWeight: 700, ml: { md: 'auto' } }}>
          New Pending Settlement
        </Button>
      </Box>

      {loading && <LinearProgress sx={{ mb: 1 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '60vh' }}>
        <Table size="small" stickyHeader aria-label="Pending bank settlements"
          sx={{ minWidth: 1150, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 } }}>
          <TableHead>
            <TableRow>
              <TableCell sx={head}>No.</TableCell>
              <TableCell sx={head}>Direction</TableCell>
              <TableCell sx={head}>Party</TableCell>
              <TableCell sx={head}>Bill(s)</TableCell>
              <TableCell sx={head} align="right">Amount</TableCell>
              <TableCell sx={head}>Agreed / Expected</TableCell>
              <TableCell sx={head}>Days Left</TableCell>
              <TableCell sx={head}>Bank / Mode</TableCell>
              <TableCell sx={head}>Ref / UTR</TableCell>
              <TableCell sx={head}>Status</TableCell>
              <TableCell sx={head} align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {data && data.rows.length === 0 && (
              <TableRow><TableCell colSpan={11} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                No pending bank settlements for these filters. Use “New Pending Settlement” when a party agrees to pay by bank later.
              </TableCell></TableRow>
            )}
            {data && data.rows.map((r) => (
              <TableRow key={r.id} hover>
                <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, whiteSpace: 'nowrap' }}>{r.number}</TableCell>
                <TableCell>
                  <Chip size="small" label={r.direction_label} sx={{ fontWeight: 700, color: '#fff', bgcolor: r.direction === 'RECEIVE' ? IN_COLOR : OUT_COLOR }} />
                </TableCell>
                <TableCell sx={{ minWidth: 150 }}>
                  <Typography variant="body2" fontWeight={700}>{r.party_name}</Typography>
                  <Typography variant="caption" color="text.secondary">{[KIND_LABEL[r.party_kind], r.party_phone].filter(Boolean).join(' · ')}</Typography>
                </TableCell>
                <TableCell sx={{ maxWidth: 160 }}>{r.bill_numbers || '—'}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800, whiteSpace: 'nowrap' }}>
                  {formatMoney(r.amount)}
                  {r.settled_amount && r.settled_amount !== r.amount && <Typography variant="caption" display="block" color="text.secondary">Settled {formatMoney(r.settled_amount)}</Typography>}
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Typography variant="body2">{formatDate(r.expected_date)}</Typography>
                  <Typography variant="caption" color="text.secondary">agreed {formatDate(r.agreed_date)}</Typography>
                </TableCell>
                <TableCell>{r.status === 'PENDING' ? <DaysLeftChip days={r.days_left} /> : '—'}</TableCell>
                <TableCell sx={{ minWidth: 140 }}>
                  <Typography variant="body2">{r.bank_account_name || 'Not decided'}</Typography>
                  <Typography variant="caption" color="text.secondary">{r.mode_label}</Typography>
                </TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>{r.reference || '—'}</TableCell>
                <TableCell>
                  <Chip size="small" color={STATUS_COLORS[r.status]} label={r.status_label} />
                  {r.status === 'SETTLED' && (
                    <Typography variant="caption" display="block" color="text.secondary">
                      {formatDate(r.settled_date)}{r.voucher_number ? ` · ${r.voucher_number}` : ' · not linked'}
                    </Typography>
                  )}
                  {r.status_note && <Typography variant="caption" display="block" color="text.secondary">{r.status_note}</Typography>}
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  {r.status === 'PENDING' && (
                    <>
                      <Tooltip title="Mark settled"><IconButton size="small" color="success" onClick={() => setSettleRow(r)} aria-label={`Settle ${r.number}`}><SettleIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="Edit"><IconButton size="small" onClick={() => setForm({ row: r })} aria-label={`Edit ${r.number}`}><EditIcon fontSize="small" /></IconButton></Tooltip>
                      <Tooltip title="Cancel"><IconButton size="small" color="error" onClick={() => setCancelRow(r)} aria-label={`Cancel ${r.number}`}><CancelIcon fontSize="small" /></IconButton></Tooltip>
                    </>
                  )}
                  {r.status !== 'PENDING' && (
                    <Tooltip title={r.status === 'SETTLED' ? 'Undo settle (back to pending)' : 'Re-open'}>
                      <IconButton size="small" onClick={() => reopen(r)} aria-label={`Re-open ${r.number}`}><ReopenIcon fontSize="small" /></IconButton>
                    </Tooltip>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {data && (
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap">
          <Typography variant="caption" color="text.secondary">Listed total: {formatMoney(data.matched_amount)}</Typography>
          <TablePagination component="div" count={data.count} page={Math.min(page, Math.max(0, data.num_pages - 1))}
            onPageChange={(e, p) => setPage(p)} rowsPerPage={pageSize}
            onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }}
            rowsPerPageOptions={[50, 100, 200, 500]} />
        </Stack>
      )}

      <PendingFormDialog open={!!form} row={form?.row || null} accounts={accounts} onClose={() => setForm(null)} onSaved={done} />
      <SettleDialog row={settleRow} onClose={() => setSettleRow(null)} onSaved={done} />
      <CancelDialog row={cancelRow} onClose={() => setCancelRow(null)} onSaved={done} />
    </Box>
  );
}
