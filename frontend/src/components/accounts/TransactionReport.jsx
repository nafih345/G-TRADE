// Accounts → Transaction Report: every cash and bank movement in the system, read live from the
// ledger by GET /api/financial/reports/transactions/ (financial/transactions.py). A row is one
// posted journal's net effect on one cash or bank account, so sales, receipts, purchases, eye test
// fees, wholesale collections and every voucher appear the moment they post. The screen polls a
// cheap /stamp/ and refreshes itself when the books change.
//
// Administrative control (finance admins; the 'accounts' Direct Edit switch / approval applies):
//  - ✎ Details: reference / UTR, mode, value date, remarks — tracking only, never posts.
//  - Edit: narration / reference in place; a manual voucher's amounts, accounts or date are
//    corrected by reversal + re-post (POST journals/<id>/correct/). Automated entries are
//    corrected from their source document.
//  - Add Transaction: a missing receipt / payment / transfer, posted as an RV / PV / CV voucher.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, Grid, IconButton, InputAdornment, LinearProgress, Link, MenuItem, Paper, Stack, Switch, Table,
  TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import {
  FilterAlt as ApplyIcon, RestartAlt as ResetIcon, Print as PrintIcon, FileDownload as CsvIcon,
  EditNote as DetailsIcon, Edit as EditIcon, Add as AddIcon, Delete as DeleteIcon, Sensors as LiveIcon,
  ExpandMore as ExpandIcon, ExpandLess as CollapseIcon, Search as SearchIcon,
} from '@mui/icons-material';
import { apiError, finGet, finPatch, finPost, newIdempotencyKey } from '../financial/financialApi';
import ShowBillDialog from '../financial/ShowBillDialog';
import { BANK_MODES } from '../financial/bankModes';
import useVoucherMasters from './useVoucherMasters';
import { useBranch } from '../../context/BranchContext';
import { useAuth } from '../../context/AuthContext';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate, formatMoney } from '../../utils/localeFormat';
import { ensureEditAccess } from '../../utils/editPermissions';
import { notify } from '../../utils/notify';
import {
  NAVY, head, ymd, todayYmd, monthStart, fyStart, money, esc, downloadCsv, printReport, printShell, printCards,
  SummaryCard, filterBarSx, fieldSx,
} from './reportKit';
import CurrencySymbol from '../common/CurrencySymbol.jsx';

const IN_COLOR = '#15803d';
const OUT_COLOR = '#b91c1c';
const POLL_MS = 10000;
const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMINISTRATOR', 'ACCOUNTANT'];

const KIND_STYLES = {
  OPENING: ['#334155', '#e2e8f0'], CUSTOMER_RECEIPT: ['#166534', '#dcfce7'], EYE_TEST_FEE: ['#166534', '#dcfce7'],
  DEALER_COLLECTION: ['#0f766e', '#ccfbf1'], RECEIPT: ['#0f766e', '#ccfbf1'], REFUND: ['#c2410c', '#ffedd5'],
  SUPPLIER_PAYMENT: ['#b91c1c', '#fee2e2'], SALES_RETURN: ['#b91c1c', '#fee2e2'], PURCHASE_RETURN: ['#b91c1c', '#fee2e2'],
  PAYMENT: ['#b91c1c', '#fee2e2'], BANK_CHARGES: ['#c2410c', '#ffedd5'],
  CASH_DEPOSIT: ['#3730a3', '#e0e7ff'], CASH_WITHDRAWAL: ['#6b21a8', '#f3e8ff'],
  TRANSFER_IN: ['#0369a1', '#e0f2fe'], TRANSFER_OUT: ['#0369a1', '#e0f2fe'],
};

const PRESETS = [['today', 'Today'], ['week', 'This Week'], ['month', 'This Month'], ['fy', 'This Financial Year'], ['custom', 'Custom Range']];
const presetRange = (key) => {
  const d = new Date();
  if (key === 'today') return [todayYmd(), todayYmd()];
  if (key === 'week') { const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return [ymd(s), todayYmd()]; }
  if (key === 'fy') return [fyStart(), todayYmd()];
  return [monthStart(), todayYmd()];
};
const defaultFilters = () => {
  const [from, to] = presetRange('month');
  return { preset: 'month', dateFrom: from, dateTo: to, branch: 'all', channel: 'all', account: '', direction: '', mode: '', kind: '', origin: 'all', search: '', showReversed: false };
};
const toParams = (f, extra = {}) => ({
  date_from: f.dateFrom, date_to: f.dateTo, branch: f.branch, channel: f.channel, account: f.account,
  direction: f.direction, mode: f.mode, kind: f.kind, origin: f.origin, search: f.search.trim(),
  show_reversed: f.showReversed ? 1 : '', ...extra,
});
const num = (v) => parseFloat(v) || 0;
const accLabel = (a) => (a ? `${a.code} - ${a.name}` : '');

const KindBadge = ({ row }) => {
  const [fg, bg] = KIND_STYLES[row.kind] || KIND_STYLES.OPENING;
  return <Box component="span" sx={{ display: 'inline-block', px: 1, py: 0.25, borderRadius: 1, fontSize: 11.5, fontWeight: 700, color: fg, bgcolor: bg, whiteSpace: 'nowrap' }}>{row.kind_label}</Box>;
};
const ChannelChip = ({ channel }) => (
  <Chip size="small" label={channel === 'CASH' ? 'Cash' : 'Bank'}
    sx={{ height: 20, fontSize: 11, fontWeight: 800, color: channel === 'CASH' ? '#166534' : '#1d4ed8', bgcolor: channel === 'CASH' ? '#dcfce7' : '#dbeafe' }} />
);

// ---------------------------------------------------------------------------
// ✎ Details — tracking-only annotations of one movement
// ---------------------------------------------------------------------------

function DetailsDialog({ row, onClose, onSaved }) {
  const [draft, setDraft] = useState({ reference: '', mode: '', valueDate: '', remarks: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!row) return;
    setDraft({ reference: row.reference_is_set ? row.reference : '', mode: row.mode_is_set ? row.mode : '', valueDate: row.value_date || '', remarks: row.remarks || '' });
    setError('');
  }, [row]);
  const set = (k) => (e) => setDraft(d => ({ ...d, [k]: e.target.value }));
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      await finPatch(`transactions/entries/${row.entry_id}/${row.account_id}/`, {
        reference: draft.reference.trim(), mode: draft.mode, value_date: draft.valueDate || null, remarks: draft.remarks.trim(),
      });
      notify('Transaction details saved.', 'success');
      onSaved();
    } catch (e) {
      setError(apiError(e, 'Could not save the details.'));
    }
    setSaving(false);
  };
  return (
    <Dialog open={!!row} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      {row && (<>
        <DialogTitle sx={{ fontWeight: 850 }}>
          Transaction details — {row.entry_number}
          <Typography variant="body2" color="text.secondary">
            {row.account} · {formatDate(row.date)} · {row.direction === 'IN' ? `In ${money(row.amount_in)}` : `Out ${money(row.amount_out)}`}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2}>
            {error && <Alert severity="error">{error}</Alert>}
            <TextField label="Reference / UTR / Receipt No." value={draft.reference} onChange={set('reference')} autoFocus inputProps={{ maxLength: 80 }}
              helperText={!row.reference_is_set && row.reference ? `Blank keeps the recorded reference “${row.reference}”.` : ' '} />
            <TextField select label="Mode" value={draft.mode} onChange={set('mode')}
              helperText={draft.mode ? ' ' : `Blank keeps the mode read from the posting (${row.mode_label || '—'}).`}>
              <MenuItem value=""><em>As recorded ({row.mode_label || '—'})</em></MenuItem>
              {BANK_MODES.map(([v, l]) => <MenuItem key={v} value={v}>{v === 'CASH' ? 'Cash' : l}</MenuItem>)}
            </TextField>
            <TextField type="date" label={row.channel === 'BANK' ? 'Bank date (value / cleared date)' : 'Value date'} value={draft.valueDate}
              onChange={set('valueDate')} InputLabelProps={{ shrink: true }} inputProps={{ min: row.date }} />
            <TextField label="Remarks" value={draft.remarks} onChange={set('remarks')} multiline minRows={2} inputProps={{ maxLength: 500 }} />
            <Typography variant="caption" color="text.secondary">Tracking and reconciliation only — the amount and the posting are not changed.</Typography>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3 }}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={save} disabled={saving} sx={{ bgcolor: NAVY, fontWeight: 700 }}>Save</Button>
        </DialogActions>
      </>)}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Edit — narration / reference in place, or a manual voucher corrected by reversal + re-post
// ---------------------------------------------------------------------------

function LinesEditor({ lines, setLines, accounts }) {
  const byId = useMemo(() => Object.fromEntries(accounts.map(a => [a.id, a])), [accounts]);
  const update = (i, patch) => setLines(ls => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const dr = lines.reduce((s, l) => s + num(l.debit), 0);
  const cr = lines.reduce((s, l) => s + num(l.credit), 0);
  return (
    <Box>
      <Table size="small">
        <TableHead><TableRow>
          <TableCell sx={head}>Account</TableCell><TableCell sx={head} align="right">Debit</TableCell>
          <TableCell sx={head} align="right">Credit</TableCell><TableCell sx={head}>Memo / Mode</TableCell><TableCell sx={head} />
        </TableRow></TableHead>
        <TableBody>
          {lines.map((l, i) => (
            <TableRow key={l.key}>
              <TableCell sx={{ minWidth: 240 }}>
                <Autocomplete size="small" options={accounts} value={byId[l.account] || null} getOptionLabel={accLabel}
                  isOptionEqualToValue={(o, v) => o.id === v.id} groupBy={(a) => a.account_type}
                  onChange={(e, v) => update(i, { account: v?.id || '' })}
                  renderInput={(p) => <TextField {...p} placeholder="Account" />} />
              </TableCell>
              <TableCell sx={{ width: 120 }}><TextField size="small" type="number" value={l.debit} inputProps={{ min: 0, step: '0.01' }}
                onChange={(e) => update(i, { debit: e.target.value, credit: num(e.target.value) ? '' : l.credit })} /></TableCell>
              <TableCell sx={{ width: 120 }}><TextField size="small" type="number" value={l.credit} inputProps={{ min: 0, step: '0.01' }}
                onChange={(e) => update(i, { credit: e.target.value, debit: num(e.target.value) ? '' : l.debit })} /></TableCell>
              <TableCell sx={{ minWidth: 140 }}><TextField size="small" value={l.memo} onChange={(e) => update(i, { memo: e.target.value })} inputProps={{ maxLength: 255 }} /></TableCell>
              <TableCell sx={{ width: 40 }}>
                <IconButton size="small" disabled={lines.length <= 2} onClick={() => setLines(ls => ls.filter((_, j) => j !== i))}><DeleteIcon fontSize="small" /></IconButton>
              </TableCell>
            </TableRow>
          ))}
          <TableRow>
            <TableCell><Button size="small" startIcon={<AddIcon />} onClick={() => setLines(ls => [...ls, { key: Math.random(), account: '', debit: '', credit: '', memo: '' }])}>Add line</Button></TableCell>
            <TableCell align="right" sx={{ fontWeight: 800 }}>{formatMoney(dr)}</TableCell>
            <TableCell align="right" sx={{ fontWeight: 800 }}>{formatMoney(cr)}</TableCell>
            <TableCell colSpan={2} sx={{ color: Math.abs(dr - cr) < 0.005 && dr > 0 ? IN_COLOR : OUT_COLOR, fontWeight: 700 }}>
              {Math.abs(dr - cr) < 0.005 && dr > 0 ? 'Balanced' : `Difference ${formatMoney(Math.abs(dr - cr))}`}
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Box>
  );
}

function EditEntryDialog({ row, accounts, onClose, onSaved }) {
  const [tpl, setTpl] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [text, setText] = useState({ narration: '', reference: '' });
  const [correcting, setCorrecting] = useState(false);
  const [voucher, setVoucher] = useState({ date: '', referenceNo: '', reason: '' });
  const [lines, setLines] = useState([]);

  useEffect(() => {
    if (!row) return undefined;
    let alive = true;
    setTpl(null); setError(''); setCorrecting(false);
    finGet(`journals/${row.entry_id}/correction/`).then((t) => {
      if (!alive) return;
      setTpl(t);
      setText({ narration: t.narration, reference: t.reference });
      setVoucher({ date: t.date, referenceNo: t.reference_no, reason: '' });
      setLines(t.lines.map((l, i) => ({ key: i, account: l.account, debit: num(l.debit) ? l.debit : '', credit: num(l.credit) ? l.credit : '', memo: l.memo })));
    }).catch(e => alive && setError(apiError(e, 'Could not load the entry.')));
    return () => { alive = false; };
  }, [row]);

  const canCorrect = tpl && tpl.manual && tpl.status === 'POSTED' && !tpl.is_reversal;

  const saveText = async () => {
    if (!(await ensureEditAccess({ module: 'accounts', recordId: row.entry_id, recordRef: row.entry_number }))) return;
    setSaving(true); setError('');
    try {
      const res = await finPost(`journals/${row.entry_id}/correct/`, { mode: 'text', narration: text.narration, ...(tpl.manual ? { reference: text.reference } : {}) });
      notify(res.changed ? `${row.entry_number} updated.` : 'Nothing changed.', res.changed ? 'success' : 'info');
      onSaved();
    } catch (e) { setError(apiError(e, 'Could not save the changes.')); }
    setSaving(false);
  };

  const saveCorrection = async () => {
    const dr = lines.reduce((s, l) => s + num(l.debit), 0);
    const cr = lines.reduce((s, l) => s + num(l.credit), 0);
    if (!voucher.reason.trim()) { setError('Give a reason for the correction.'); return; }
    if (lines.some(l => !l.account) || Math.abs(dr - cr) > 0.005 || dr <= 0) { setError('Every line needs an account, and debits must equal credits.'); return; }
    if (!window.confirm(`${row.entry_number} will be reversed and a corrected ${tpl.voucher_type_code} for ${formatMoney(dr)} posted. Continue?`)) return;
    if (!(await ensureEditAccess({ module: 'accounts', recordId: row.entry_id, recordRef: row.entry_number }))) return;
    setSaving(true); setError('');
    try {
      const res = await finPost(`journals/${row.entry_id}/correct/`, {
        mode: 'voucher', reason: voucher.reason.trim(), voucher_type_code: tpl.voucher_type_code, date: voucher.date,
        narration: text.narration, reference_no: voucher.referenceNo, reference: text.reference, status: 'POSTED', branch: tpl.branch,
        lines: lines.map(l => ({ account: l.account, debit: num(l.debit).toFixed(2), credit: num(l.credit).toFixed(2), memo: l.memo || '' })),
      });
      notify(res.message, 'success');
      onSaved();
    } catch (e) { setError(apiError(e, 'The correction could not be posted.')); }
    setSaving(false);
  };

  return (
    <Dialog open={!!row} onClose={saving ? undefined : onClose} maxWidth="md" fullWidth>
      {row && (<>
        <DialogTitle sx={{ fontWeight: 850 }}>
          Edit transaction — {row.entry_number}
          <Typography variant="body2" color="text.secondary">{row.origin_label} · {formatDate(row.date)} · {row.account}</Typography>
        </DialogTitle>
        <DialogContent dividers>
          {!tpl && !error && <LinearProgress />}
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          {tpl && (
            <Stack spacing={2}>
              <TextField label="Narration" value={text.narration} onChange={(e) => setText(t => ({ ...t, narration: e.target.value }))} multiline minRows={2} />
              {tpl.manual && <TextField label="Voucher Reference No" value={text.reference} onChange={(e) => setText(t => ({ ...t, reference: e.target.value }))} inputProps={{ maxLength: 80 }} />}
              {!canCorrect && (
                <Alert severity="info">
                  {tpl.is_reversal || tpl.status !== 'POSTED'
                    ? `${tpl.entry_number} is ${tpl.is_reversal ? 'a reversal' : tpl.status.toLowerCase()}; only its narration can be changed.`
                    : 'This entry was posted automatically from its source document. Its amount, accounts and date follow that document — open it with the voucher number and change it there.'}
                </Alert>
              )}
              {canCorrect && (<>
                <FormControlLabel control={<Switch checked={correcting} onChange={(e) => setCorrecting(e.target.checked)} />}
                  label={<Typography fontWeight={700}>Correct amount, accounts or date</Typography>} />
                <Collapse in={correcting}>
                  <Stack spacing={2}>
                    <Alert severity="warning">
                      Posted vouchers are never overwritten. Saving reverses {tpl.entry_number} and posts a corrected {tpl.voucher_type_code} in the same step; both stay on the ledger and are linked.
                      {tpl.has_cheques && ' Its cheque will be cancelled — record the cheque again in the Cheque Register if it still stands.'}
                      {tpl.has_bill_allocations && ' Its bill-to-bill allocations are released — settle the bills again from the voucher screen.'}
                    </Alert>
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
                      <TextField type="date" label="Date" value={voucher.date} onChange={(e) => setVoucher(v => ({ ...v, date: e.target.value }))} InputLabelProps={{ shrink: true }} />
                      <TextField label="Party / Paid to / Received from" value={voucher.referenceNo} onChange={(e) => setVoucher(v => ({ ...v, referenceNo: e.target.value }))} sx={{ flex: 1 }} inputProps={{ maxLength: 80 }} />
                    </Stack>
                    <LinesEditor lines={lines} setLines={setLines} accounts={accounts} />
                    <TextField label="Reason for correction" required value={voucher.reason} onChange={(e) => setVoucher(v => ({ ...v, reason: e.target.value }))} inputProps={{ maxLength: 500 }} />
                  </Stack>
                </Collapse>
              </>)}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3 }}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          {tpl && (correcting
            ? <Button variant="contained" color="warning" onClick={saveCorrection} disabled={saving} sx={{ fontWeight: 700 }}>Reverse &amp; Post Correction</Button>
            : <Button variant="contained" onClick={saveText} disabled={saving} sx={{ bgcolor: NAVY, fontWeight: 700 }}>Save</Button>)}
        </DialogActions>
      </>)}
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Add Transaction — a missing receipt / payment / transfer, posted as a voucher
// ---------------------------------------------------------------------------

const ADD_TYPES = {
  IN: { code: 'RV', label: 'Money In (Receipt)', counter: 'Received from (credit account)' },
  OUT: { code: 'PV', label: 'Money Out (Payment)', counter: 'Paid to (debit account)' },
  TRANSFER: { code: 'CV', label: 'Transfer (Contra)', counter: 'Transfer to (cash / bank)' },
};
const PAY_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'NEFT', 'RTGS', 'IMPS', 'Cheque'];

function AddTransactionDialog({ open, onClose, onSaved, accounts, moneyAccounts }) {
  const blank = () => ({ type: 'IN', date: todayYmd(), moneyAccount: '', counter: '', amount: '', mode: 'Cash', party: '', reference: '', narration: '', key: newIdempotencyKey() });
  const [f, setF] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setF(blank()); setError(''); } }, [open]);
  const set = (k) => (e) => setF(d => ({ ...d, [k]: e.target.value }));
  const byId = useMemo(() => Object.fromEntries(accounts.map(a => [a.id, a])), [accounts]);
  const moneyIds = useMemo(() => new Set(moneyAccounts.map(a => a.id)), [moneyAccounts]);
  const moneyList = accounts.filter(a => moneyIds.has(a.id));
  const counters = f.type === 'TRANSFER' ? moneyList.filter(a => a.id !== f.moneyAccount) : accounts.filter(a => !moneyIds.has(a.id));
  const t = ADD_TYPES[f.type];

  const save = async () => {
    const amount = num(f.amount);
    if (!f.moneyAccount || !f.counter || amount <= 0) { setError('Choose both accounts and enter an amount.'); return; }
    const memo = f.mode;
    const m = { account: f.moneyAccount, memo }, c = { account: f.counter, memo: f.type === 'TRANSFER' ? memo : '' };
    const amt = amount.toFixed(2);
    // RV: Dr money / Cr counter. PV: Dr counter / Cr money. CV: Dr "to" / Cr "from" (the money account picked first).
    const lines = f.type === 'IN'
      ? [{ ...m, debit: amt, credit: '0' }, { ...c, debit: '0', credit: amt }]
      : [{ ...c, debit: amt, credit: '0' }, { ...m, debit: '0', credit: amt }];
    setSaving(true); setError('');
    try {
      const entry = await finPost('journals/', {
        voucher_type_code: t.code, date: f.date, narration: f.narration.trim() || `${t.label} added from Transaction Report`,
        reference_no: f.party.trim(), reference: f.reference.trim(), status: 'POSTED', idempotency_key: f.key, lines,
      });
      notify(`${entry.entry_number} posted.`, 'success');
      onSaved();
    } catch (e) { setError(apiError(e, 'The transaction could not be posted.')); }
    setSaving(false);
  };

  const picker = (key, label, list) => (
    <Autocomplete size="small" options={list} value={byId[f[key]] || null} getOptionLabel={accLabel} groupBy={(a) => a.account_type}
      isOptionEqualToValue={(o, v) => o.id === v.id} onChange={(e, v) => setF(d => ({ ...d, [key]: v?.id || '' }))}
      renderInput={(p) => <TextField {...p} label={label} required />} />
  );

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 850 }}>Add missing transaction
        <Typography variant="body2" color="text.secondary">Posted as a {t.code} voucher on the same books as Accounts → Vouchers.</Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          {error && <Alert severity="error">{error}</Alert>}
          <ToggleButtonGroup exclusive size="small" value={f.type} onChange={(e, v) => v && setF(d => ({ ...d, type: v, counter: '' }))}>
            {Object.entries(ADD_TYPES).map(([k, v]) => <ToggleButton key={k} value={k} sx={{ fontWeight: 700, textTransform: 'none' }}>{v.label}</ToggleButton>)}
          </ToggleButtonGroup>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField type="date" size="small" label="Date" value={f.date} onChange={set('date')} InputLabelProps={{ shrink: true }} />
            <TextField size="small" type="number" label="Amount" value={f.amount} onChange={set('amount')} required inputProps={{ min: 0, step: '0.01' }}
              InputProps={{ startAdornment: <InputAdornment position="start"><CurrencySymbol /></InputAdornment> }} sx={{ flex: 1 }} />
            <TextField select size="small" label="Mode" value={f.mode} onChange={set('mode')} sx={{ minWidth: 150 }}>
              {PAY_MODES.map(x => <MenuItem key={x} value={x}>{x}</MenuItem>)}
            </TextField>
          </Stack>
          {picker('moneyAccount', f.type === 'TRANSFER' ? 'Transfer from (cash / bank)' : f.type === 'IN' ? 'Received into (cash / bank)' : 'Paid from (cash / bank)', moneyList)}
          {picker('counter', t.counter, counters)}
          <TextField size="small" label={f.type === 'IN' ? 'Received from (party)' : f.type === 'OUT' ? 'Paid to (party)' : 'Party (optional)'} value={f.party} onChange={set('party')} inputProps={{ maxLength: 80 }} />
          <TextField size="small" label="Reference No / UTR" value={f.reference} onChange={set('reference')} inputProps={{ maxLength: 80 }} />
          <TextField size="small" label="Narration" value={f.narration} onChange={set('narration')} multiline minRows={2} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3 }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving} sx={{ bgcolor: NAVY, fontWeight: 700 }}>Post Transaction</Button>
      </DialogActions>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

export default function TransactionReport() {
  const { multiBranchEnabled, branches, isAdmin } = useBranch();
  const { user } = useAuth() || {};
  const canWrite = !!user && (user.is_superuser || ADMIN_ROLES.includes(String(user.role || '').toUpperCase()));
  const storeProfile = useStoreProfile();
  const company = useMemo(() => companyFromProfile(storeProfile), [storeProfile]);
  const { accounts } = useVoucherMasters();

  const [options, setOptions] = useState({ accounts: [], modes: [], kinds: [] });
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [live, setLive] = useState(true);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [showAccounts, setShowAccounts] = useState(false);
  const [billRow, setBillRow] = useState(null);
  const [detailRow, setDetailRow] = useState(null);
  const [editRow, setEditRow] = useState(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const stampRef = useRef(null);

  useEffect(() => {
    finGet('reports/transactions/options/').then(setOptions).catch(() => {});
  }, []);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const res = await finGet('reports/transactions/', toParams(applied, { page: page + 1, page_size: pageSize }));
      setData(res);
      stampRef.current = res.stamp;
      setUpdatedAt(new Date());
      setError('');
    } catch (e) {
      if (!quiet) { setData(null); setError(apiError(e, 'Could not load the transaction report.')); }
    }
    if (!quiet) setLoading(false);
  }, [applied, page, pageSize]);

  useEffect(() => { load(); }, [load]);

  // Real time: poll the books' fingerprint; reload only when something was posted or changed.
  useEffect(() => {
    if (!live) return undefined;
    const tick = async () => {
      if (document.hidden) return;
      try {
        const { stamp } = await finGet('reports/transactions/stamp/');
        if (stampRef.current && stamp !== stampRef.current) load(true);
      } catch { /* offline: try again next tick */ }
    };
    const id = setInterval(tick, POLL_MS);
    const onFocus = () => tick();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, [live, load]);

  const set = (key) => (e) => {
    const value = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setDraft(d => {
      const next = { ...d, [key]: value };
      if (key === 'preset' && value !== 'custom') [next.dateFrom, next.dateTo] = presetRange(value);
      if (key === 'dateFrom' || key === 'dateTo') next.preset = 'custom';
      if (key === 'channel') next.account = '';
      return next;
    });
  };
  const apply = (e) => { e?.preventDefault(); setPage(0); setApplied(draft); };
  const reset = () => { const f = defaultFilters(); setDraft(f); setApplied(f); setPage(0); };
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const refreshAfterWrite = () => { setDetailRow(null); setEditRow(null); setAdding(false); load(true); };

  const accountOptions = options.accounts.filter(a => draft.channel === 'all' || a.channel === draft.channel.toUpperCase());
  const s = data?.summary;
  const narrowed = data && (applied.direction || applied.mode || applied.kind || applied.origin !== 'all' || applied.search.trim());

  const fetchAll = async () => (await finGet('reports/transactions/', toParams(applied, { export: 1 }))).rows;

  const exportCsv = async () => {
    setBusy(true);
    try {
      const rows = await fetchAll();
      downloadCsv(`transactions_${applied.dateFrom}_${applied.dateTo}.csv`,
        ['Date', 'Time', 'Voucher No', 'Cash/Bank', 'Account', 'Type', 'Mode', 'Party', 'Particulars', 'Reference', 'Bill No', 'Narration', 'Remarks', 'Origin', 'In', 'Out', 'Balance', 'Entered By', 'Status'],
        rows.map(r => [r.date, r.time, r.entry_number, r.channel, r.account, r.kind_label, r.mode_label, r.party, r.particulars, r.reference, r.bill_number, r.narration, r.remarks, r.origin_label, r.amount_in || '', r.amount_out || '', narrowed ? '' : r.balance, r.entered_by, r.is_reversal ? 'Reversal' : r.status]));
    } catch (e) { notify(apiError(e, 'Could not export.'), 'error'); }
    setBusy(false);
  };

  const print = () => printReport(async () => {
    const rows = await fetchAll();
    const body = `${printCards([['Opening', money(s.opening_balance)], ['Total In', money(s.total_in)], ['Total Out', money(s.total_out)], ['Closing', money(s.closing_balance)], ['Cash closing', money(s.cash.closing)], ['Bank closing', money(s.bank.closing)]])}
      <table><thead><tr><th>Date</th><th>Voucher</th><th>Cash/Bank</th><th>Account</th><th>Type</th><th>Mode</th><th>Party / Particulars</th><th>Reference</th><th>Narration</th><th class="r">In</th><th class="r">Out</th>${narrowed ? '' : '<th class="r">Balance</th>'}</tr></thead>
      <tbody>${rows.map(r => `<tr><td>${esc(formatDate(r.date))} ${esc(r.time)}</td><td>${esc(r.entry_number)}</td><td>${esc(r.channel === 'CASH' ? 'Cash' : 'Bank')}</td><td>${esc(r.account)}</td><td>${esc(r.kind_label)}</td><td>${esc(r.mode_label)}</td><td>${esc(r.party || r.particulars)}</td><td>${esc(r.reference || r.bill_number)}</td><td>${esc([r.narration, r.remarks].filter(Boolean).join(' · '))}</td><td class="r">${esc(money(r.amount_in))}</td><td class="r">${esc(money(r.amount_out))}</td>${narrowed ? '' : `<td class="r">${esc(money(r.balance))}</td>`}</tr>`).join('')}
      <tr class="tot"><td colspan="9">Total</td><td class="r">${esc(money(data.matched.in))}</td><td class="r">${esc(money(data.matched.out))}</td>${narrowed ? '' : `<td class="r">${esc(money(s.closing_balance))}</td>`}</tr></tbody></table>`;
    return printShell({
      title: 'Cash & Bank Transaction Report', company, logo: storeProfile.logo_data_url, body,
      meta: [['Period', `${formatDate(applied.dateFrom)} to ${formatDate(applied.dateTo)}`], ['Accounts', applied.account ? (options.accounts.find(a => a.id === applied.account)?.label || '') : { all: 'All cash & bank', cash: 'All cash', bank: 'All bank' }[applied.channel]], ['Branch', data.branch?.label || 'All branches']],
    });
  }, (e) => notify(apiError(e, 'Could not print.'), 'error'));

  return (
    <Box>
      <Paper component="form" onSubmit={apply} variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3 }}>
        <Box sx={filterBarSx}>
          <TextField select size="small" label="Period" value={draft.preset} onChange={set('preset')} sx={{ minWidth: 170, ...fieldSx }}>
            {PRESETS.map(([k, l]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}
          </TextField>
          <TextField type="date" size="small" label="From" value={draft.dateFrom} onChange={set('dateFrom')} InputLabelProps={{ shrink: true }} sx={{ width: 160, ...fieldSx }} />
          <TextField type="date" size="small" label="To" value={draft.dateTo} onChange={set('dateTo')} InputLabelProps={{ shrink: true }} sx={{ width: 160, ...fieldSx }} />
          {multiBranchEnabled && (
            <TextField select size="small" label="Branch" value={draft.branch} onChange={set('branch')} sx={{ minWidth: 160, ...fieldSx }}>
              <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          )}
          <TextField select size="small" label="Cash / Bank" value={draft.channel} onChange={set('channel')} sx={{ minWidth: 150, ...fieldSx }}>
            <MenuItem value="all">Cash + Bank</MenuItem><MenuItem value="cash">Cash only</MenuItem><MenuItem value="bank">Bank only</MenuItem>
          </TextField>
          <TextField select size="small" label="Account" value={draft.account} onChange={set('account')} sx={{ minWidth: 220, ...fieldSx }}>
            <MenuItem value="">All {draft.channel === 'all' ? 'cash & bank' : draft.channel} accounts</MenuItem>
            {accountOptions.map(a => <MenuItem key={a.id} value={a.id}>{a.label}</MenuItem>)}
          </TextField>
        </Box>
        <Box sx={{ ...filterBarSx, mb: 0 }}>
          <TextField select size="small" label="Direction" value={draft.direction} onChange={set('direction')} sx={{ minWidth: 130, ...fieldSx }}>
            <MenuItem value="">In + Out</MenuItem><MenuItem value="IN">Money In</MenuItem><MenuItem value="OUT">Money Out</MenuItem>
          </TextField>
          <TextField select size="small" label="Type" value={draft.kind} onChange={set('kind')} sx={{ minWidth: 170, ...fieldSx }}>
            <MenuItem value="">All types</MenuItem>
            {options.kinds.map(k => <MenuItem key={k.value} value={k.value}>{k.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Mode" value={draft.mode} onChange={set('mode')} sx={{ minWidth: 140, ...fieldSx }}>
            <MenuItem value="">All modes</MenuItem>
            {BANK_MODES.map(([v, l]) => <MenuItem key={v} value={v}>{v === 'CASH' ? 'Cash' : l}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Origin" value={draft.origin} onChange={set('origin')} sx={{ minWidth: 150, ...fieldSx }}>
            <MenuItem value="all">Manual + automated</MenuItem><MenuItem value="manual">Manual vouchers</MenuItem><MenuItem value="auto">Auto-posted</MenuItem>
          </TextField>
          <TextField size="small" label="Search" value={draft.search} onChange={set('search')} placeholder="Voucher, party, UTR, amount…" sx={{ minWidth: 220, flex: '1 1 200px', ...fieldSx }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
          <FormControlLabel control={<Checkbox size="small" checked={draft.showReversed} onChange={set('showReversed')} />} label="Show reversed" />
          <Button type="submit" variant="contained" color={dirty ? 'warning' : 'primary'} startIcon={<ApplyIcon />} sx={{ fontWeight: 700, ...(dirty ? {} : { bgcolor: NAVY }) }}>Apply</Button>
          <Button variant="outlined" startIcon={<ResetIcon />} onClick={reset}>Reset</Button>
        </Box>
      </Paper>

      <Stack direction={{ xs: 'column', md: 'row' }} alignItems={{ md: 'center' }} justifyContent="space-between" gap={1} sx={{ mb: 2 }}>
        <Stack direction="row" alignItems="center" gap={1}>
          <FormControlLabel control={<Switch size="small" checked={live} onChange={(e) => setLive(e.target.checked)} />}
            label={<Stack direction="row" alignItems="center" gap={0.5}><LiveIcon fontSize="small" sx={{ color: live ? IN_COLOR : 'text.disabled' }} /><Typography variant="body2" fontWeight={700}>Live</Typography></Stack>} />
          <Typography variant="caption" color="text.secondary">
            {updatedAt ? `Updated ${updatedAt.toLocaleTimeString()}` : ''}{live ? ' · refreshes automatically when anything is posted' : ''}
          </Typography>
        </Stack>
        <Stack direction="row" gap={1} flexWrap="wrap">
          {canWrite && <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAdding(true)} sx={{ bgcolor: IN_COLOR, fontWeight: 700 }}>Add Transaction</Button>}
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={print} disabled={!data}>Print</Button>
          <Button variant="outlined" startIcon={<CsvIcon />} onClick={exportCsv} disabled={!data || busy}>CSV</Button>
        </Stack>
      </Stack>

      {loading && <LinearProgress sx={{ mb: 2 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {dirty && <Alert severity="warning" sx={{ mb: 2 }}>Filters changed — press Apply.</Alert>}

      {s && (<>
        <Grid container spacing={1.5} sx={{ mb: 1.5 }}>
          {[['OPENING BALANCE', s.opening_balance, NAVY], ['TOTAL IN', s.total_in, IN_COLOR], ['TOTAL OUT', s.total_out, OUT_COLOR],
            ['CLOSING BALANCE', s.closing_balance, NAVY], ['CASH IN HAND', s.cash.closing, '#166534'], ['BANK BALANCE', s.bank.closing, '#1d4ed8']].map(([label, v, color]) => (
            <Grid item xs={6} sm={4} md={2} key={label}><SummaryCard label={label} value={v} color={num(v) < 0 ? OUT_COLOR : color} /></Grid>
          ))}
        </Grid>
        <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 1 }}>
          <Typography variant="body2" color="text.secondary">
            {s.transactions} transaction(s) in the period{narrowed ? ` · ${data.matched.count} match the filters (In ${money(data.matched.in)} · Out ${money(data.matched.out)})` : ''}
            {s.hidden_reversals ? ` · ${s.hidden_reversals} reversed entr(ies) hidden` : ''}
          </Typography>
          <Button size="small" onClick={() => setShowAccounts(v => !v)} endIcon={showAccounts ? <CollapseIcon /> : <ExpandIcon />}>By account</Button>
        </Stack>
        <Collapse in={showAccounts}>
          <Paper variant="outlined" sx={{ mb: 2, borderRadius: 2, overflow: 'hidden' }}>
            <Table size="small">
              <TableHead><TableRow>
                {['Account', 'Cash/Bank', 'Opening', 'In', 'Out', 'Closing', 'Transactions'].map((h, i) => <TableCell key={h} sx={head} align={i > 1 ? 'right' : 'left'}>{h}</TableCell>)}
              </TableRow></TableHead>
              <TableBody>
                {s.by_account.filter(a => a.transactions || num(a.opening) || num(a.closing)).map(a => (
                  <TableRow key={a.id} hover sx={{ cursor: 'pointer' }} onClick={() => { const f = { ...applied, account: a.id, channel: a.channel.toLowerCase() }; setDraft(f); setApplied(f); setPage(0); }}>
                    <TableCell sx={{ fontWeight: 700 }}>{a.label}</TableCell><TableCell><ChannelChip channel={a.channel} /></TableCell>
                    <TableCell align="right">{money(a.opening)}</TableCell><TableCell align="right" sx={{ color: IN_COLOR }}>{money(a.in)}</TableCell>
                    <TableCell align="right" sx={{ color: OUT_COLOR }}>{money(a.out)}</TableCell><TableCell align="right" sx={{ fontWeight: 800 }}>{money(a.closing)}</TableCell>
                    <TableCell align="right">{a.transactions}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Paper>
        </Collapse>
      </>)}

      {data && (
        <Paper variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
          <TableContainer sx={{ maxHeight: 680 }}>
            <Table size="small" stickyHeader>
              <TableHead><TableRow>
                {['#', 'Date', 'Voucher No', 'Cash/Bank', 'Type', 'Mode', 'Party / Particulars', 'Reference', 'Narration', 'Origin'].map(h => <TableCell key={h} sx={head}>{h}</TableCell>)}
                <TableCell sx={head} align="right">In</TableCell><TableCell sx={head} align="right">Out</TableCell>
                {!narrowed && <TableCell sx={head} align="right">Balance</TableCell>}
                <TableCell sx={head} align="center">Actions</TableCell>
              </TableRow></TableHead>
              <TableBody>
                {data.rows.length === 0 && (
                  <TableRow><TableCell colSpan={14} align="center" sx={{ py: 5, color: 'text.secondary' }}>No cash or bank transactions for this selection.</TableCell></TableRow>
                )}
                {data.rows.map(r => (
                  <TableRow key={r.row_id} hover sx={r.is_reversal || r.status === 'REVERSED' ? { '& td': { color: '#94a3b8' } } : {}}>
                    <TableCell sx={{ color: 'text.secondary' }}>{r.row_no}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(r.date)}<Typography variant="caption" display="block" color="text.secondary">{r.time}</Typography></TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      <Link component="button" type="button" underline="hover" fontWeight={700} onClick={() => setBillRow(r)}>{r.entry_number}</Link>
                      {r.is_reversal && <Chip size="small" label="Reversal" sx={{ ml: 0.5, height: 18, fontSize: 10 }} />}
                      {r.status === 'REVERSED' && <Chip size="small" label="Reversed" sx={{ ml: 0.5, height: 18, fontSize: 10 }} />}
                    </TableCell>
                    <TableCell sx={{ minWidth: 150 }}><ChannelChip channel={r.channel} /><Typography variant="caption" display="block" color="text.secondary">{r.account}</Typography></TableCell>
                    <TableCell><KindBadge row={r} /></TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.mode === 'CASH' ? 'Cash' : r.mode_label}</TableCell>
                    <TableCell sx={{ minWidth: 160 }}>{r.party || r.particulars}{r.party && r.particulars && r.party !== r.particulars && <Typography variant="caption" display="block" color="text.secondary">{r.particulars}</Typography>}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.reference}{r.bill_number && <Typography variant="caption" display="block" color="text.secondary">{r.bill_number}</Typography>}</TableCell>
                    <TableCell sx={{ minWidth: 180, maxWidth: 320 }}>{r.narration}{r.remarks && <Typography variant="caption" display="block" sx={{ color: '#a16207' }}>{r.remarks}</Typography>}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}><Typography variant="caption" fontWeight={700} color={r.origin === 'manual' ? '#7c3aed' : 'text.secondary'}>{r.origin_label}</Typography>{r.entered_by && <Typography variant="caption" display="block" color="text.secondary">{r.entered_by}</Typography>}</TableCell>
                    <TableCell align="right" sx={{ color: IN_COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{money(r.amount_in)}</TableCell>
                    <TableCell align="right" sx={{ color: OUT_COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{money(r.amount_out)}</TableCell>
                    {!narrowed && <TableCell align="right" sx={{ fontWeight: 800, whiteSpace: 'nowrap', color: num(r.balance) < 0 ? OUT_COLOR : NAVY }}>{money(r.balance)}</TableCell>}
                    <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>
                      {canWrite && (<>
                        <Tooltip title="Reference / UTR, mode, date, remarks"><IconButton size="small" onClick={() => setDetailRow(r)}><DetailsIcon fontSize="small" /></IconButton></Tooltip>
                        <Tooltip title={r.can_correct ? 'Edit / correct this voucher' : 'Edit narration'}><IconButton size="small" onClick={() => setEditRow(r)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                      </>)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination component="div" count={data.count} page={data.page - 1} rowsPerPage={pageSize} rowsPerPageOptions={[50, 100, 250, 500]}
            onPageChange={(e, p) => setPage(p)} onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }} />
        </Paper>
      )}

      <ShowBillDialog row={billRow} onClose={() => setBillRow(null)} />
      <DetailsDialog row={detailRow} onClose={() => setDetailRow(null)} onSaved={refreshAfterWrite} />
      <EditEntryDialog row={editRow} accounts={accounts} onClose={() => setEditRow(null)} onSaved={refreshAfterWrite} />
      <AddTransactionDialog open={adding} onClose={() => setAdding(false)} onSaved={refreshAfterWrite} accounts={accounts} moneyAccounts={options.accounts} />
    </Box>
  );
}
