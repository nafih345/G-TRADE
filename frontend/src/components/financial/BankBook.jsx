// Financial → Bank Book: every posted movement of the bank accounts, read from the ledger by
// GET /api/financial/reports/bankbook/ (the server nets each journal per bank, computes the opening
// balance from history and the running balance across pages, and derives mode / reference / party).
// Postings are never edited here; a row opens the source bill / voucher read-only in ShowBillDialog,
// and the ✎ button records the bank-side details (UTR, mode, bank date) the posting didn't carry.
// The second tab tracks bank settlements parties have promised but not yet made.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Badge, Box, Button, Card, Checkbox, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  Grid, IconButton, LinearProgress, MenuItem, Paper, Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead,
  TablePagination, TableRow, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  Print as PrintIcon, FilterAlt as ApplyIcon, RestartAlt as ResetIcon, FileDownload as CsvIcon, EditNote as EditIcon,
  AccountBalance as BankIcon, PendingActions as PendingIcon,
} from '@mui/icons-material';
import { apiError, finGet, finPatch } from './financialApi';
import ShowBillDialog from './ShowBillDialog';
import BankPendingSettlements from './BankPendingSettlements';
import { BANK_MODES } from './bankModes';
import { useBranch } from '../../context/BranchContext';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate, formatMoney } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';

const NAVY = '#0f1e3d';
const IN_COLOR = '#15803d';
const OUT_COLOR = '#b91c1c';

// Voucher kind -> badge colours (text, background). Kinds come from financial/bankbook.py.
const KIND_STYLES = {
  OPENING: ['#334155', '#e2e8f0'],
  CUSTOMER_RECEIPT: ['#166534', '#dcfce7'],
  EYE_TEST_FEE: ['#166534', '#dcfce7'],
  DEALER_COLLECTION: ['#0f766e', '#ccfbf1'],
  RECEIPT: ['#0f766e', '#ccfbf1'],
  REFUND: ['#c2410c', '#ffedd5'],
  SUPPLIER_PAYMENT: ['#b91c1c', '#fee2e2'],
  SALES_RETURN: ['#b91c1c', '#fee2e2'],
  PURCHASE_RETURN: ['#b91c1c', '#fee2e2'],
  PAYMENT: ['#b91c1c', '#fee2e2'],
  BANK_CHARGES: ['#c2410c', '#ffedd5'],
  CASH_DEPOSIT: ['#3730a3', '#e0e7ff'],
  CASH_WITHDRAWAL: ['#6b21a8', '#f3e8ff'],
  TRANSFER_IN: ['#0369a1', '#e0f2fe'],
  TRANSFER_OUT: ['#0369a1', '#e0f2fe'],
};
const CHEQUE_COLORS = { PENDING: 'warning', DEPOSITED: 'info', CLEARED: 'success', BOUNCED: 'error', CANCELLED: 'default' };

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const defaultFilters = () => {
  const now = new Date();
  return { account: '', dateFrom: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: ymd(now), branch: 'all', type: '', mode: '', search: '', showReversed: false };
};
const money = (v) => (v === null || v === undefined || v === '' ? '' : formatMoney(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const params = (f, extra = {}) => ({
  account: f.account, date_from: f.dateFrom, date_to: f.dateTo, branch: f.branch, type: f.type, mode: f.mode,
  search: f.search.trim(), show_reversed: f.showReversed ? 1 : '', ...extra,
});

const KindBadge = ({ row }) => {
  const [fg, bg] = KIND_STYLES[row.voucher_kind] || KIND_STYLES.OPENING;
  return (
    <Box component="span" sx={{ display: 'inline-block', px: 1, py: 0.25, borderRadius: 1, fontSize: 11.5, fontWeight: 700, color: fg, bgcolor: bg, whiteSpace: 'nowrap' }}>
      {row.voucher_kind_label}
    </Box>
  );
};

const head = { color: '#3730a3', fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap', bgcolor: '#eef2ff', borderBottom: '1px solid #c7d2fe', py: 1.25 };

function SummaryCard({ label, value, color, accent, note }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, borderLeft: `4px solid ${accent}`, height: '100%' }}>
      <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>{label}</Typography>
      <Typography variant="h6" fontWeight={850} sx={{ color, mt: 0.5 }}>{formatMoney(value || 0)}</Typography>
      {note && <Typography variant="caption" color="text.secondary">{note}</Typography>}
    </Paper>
  );
}

// Bank-side details of one posted movement: UTR / reference, mode, the bank's date, remarks.
function EntryDetailDialog({ row, onClose, onSaved }) {
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
      await finPatch(`bankbook/entries/${row.entry_id}/${row.bank_account_id}/`, {
        reference: draft.reference.trim(), mode: draft.mode, value_date: draft.valueDate || null, remarks: draft.remarks.trim(),
      });
      notify('Bank details saved.', 'success');
      onSaved();
    } catch (e) {
      setError(apiError(e, 'Could not save the bank details.'));
    }
    setSaving(false);
  };
  return (
    <Dialog open={!!row} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth>
      {row && (
        <>
          <DialogTitle sx={{ fontWeight: 850 }}>
            Bank details — {row.entry_number}
            <Typography variant="body2" color="text.secondary">
              {row.bank_account} · {formatDate(row.date)} · {row.txn_type === 'CREDIT' ? `Credit ${money(row.deposit)}` : `Debit ${money(row.withdrawal)}`}
            </Typography>
          </DialogTitle>
          <DialogContent dividers>
            <Stack spacing={2}>
              {error && <Alert severity="error">{error}</Alert>}
              <TextField label="Reference / UTR / Cheque No." value={draft.reference} onChange={set('reference')} autoFocus
                inputProps={{ maxLength: 80 }} placeholder={row.reference_is_set ? '' : row.reference || 'e.g. UTR / transaction id'}
                helperText={!row.reference_is_set && row.reference ? `Blank keeps the recorded reference “${row.reference}”.` : ' '} />
              <TextField select label="Mode" value={draft.mode} onChange={set('mode')}
                helperText={draft.mode ? ' ' : `Blank keeps the mode read from the posting (${row.mode_label || '—'}).`}>
                <MenuItem value=""><em>As recorded ({row.mode_label || '—'})</em></MenuItem>
                {BANK_MODES.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
              </TextField>
              <TextField type="date" label="Bank date (value / cleared date)" value={draft.valueDate} onChange={set('valueDate')}
                InputLabelProps={{ shrink: true }} inputProps={{ min: row.date }} helperText="The date the bank statement shows this entry." />
              <TextField label="Remarks" value={draft.remarks} onChange={set('remarks')} multiline minRows={2} inputProps={{ maxLength: 500 }} />
              <Typography variant="caption" color="text.secondary">
                These details are for tracking and reconciliation only — the amount and the posting are not changed.
              </Typography>
            </Stack>
          </DialogContent>
          <DialogActions sx={{ px: 3 }}>
            <Button onClick={onClose} disabled={saving}>Cancel</Button>
            <Button variant="contained" onClick={save} disabled={saving} sx={{ bgcolor: NAVY, fontWeight: 700 }}>Save</Button>
          </DialogActions>
        </>
      )}
    </Dialog>
  );
}

function BankTransactions({ accounts, onPendingCount }) {
  const { multiBranchEnabled, branches, isAdmin } = useBranch();
  const storeProfile = useStoreProfile();
  const company = companyFromProfile(storeProfile);
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [billRow, setBillRow] = useState(null);
  const [editRow, setEditRow] = useState(null);
  const [printing, setPrinting] = useState(false);

  // Start on the BANK-mapped (default) account once the list arrives.
  useEffect(() => {
    if (applied || !accounts) return;
    const first = (accounts.find(a => a.is_default) || accounts[0])?.id || '';
    setDraft(f => ({ ...f, account: f.account || first }));
    setApplied({ ...defaultFilters(), account: first });
  }, [accounts, applied]);

  const load = useCallback(async () => {
    if (!applied || !applied.account) return;
    setLoading(true);
    setError('');
    try {
      const d = await finGet('reports/bankbook/', params(applied, { page: page + 1, page_size: pageSize }));
      setData(d);
      onPendingCount?.((d.summary?.pending_receive?.count || 0) + (d.summary?.pending_pay?.count || 0));
    } catch (e) {
      setError(apiError(e));
      setData(null);
    }
    setLoading(false);
  }, [applied, page, pageSize, onPendingCount]);
  useEffect(() => { load(); }, [load]);

  const apply = () => {
    if (draft.dateFrom && draft.dateTo && draft.dateFrom > draft.dateTo) {
      setError('From date must be on or before To date.');
      return;
    }
    setPage(0);
    setApplied({ ...draft });
  };
  const reset = () => {
    const first = (accounts.find(a => a.is_default) || accounts[0])?.id || '';
    const f = { ...defaultFilters(), account: first };
    setDraft(f);
    setPage(0);
    setApplied(f);
  };
  const set = (k) => (e) => setDraft(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const dirty = applied && JSON.stringify(draft) !== JSON.stringify(applied);

  const accountLabel = useMemo(() => {
    if (!data) return '';
    if (data.all_accounts) return 'All bank accounts';
    const a = data.accounts?.[0];
    return a ? `${a.code} - ${a.name}${a.status !== 'Active' ? ' (Inactive)' : ''}` : '';
  }, [data]);
  const rangeLabel = applied ? `${applied.dateFrom ? formatDate(applied.dateFrom) : 'Beginning'} to ${applied.dateTo ? formatDate(applied.dateTo) : 'Today'}` : '';
  const narrowed = !!(data && (data.search || data.type || data.modes?.length));

  const fetchAll = async () => {
    const all = await finGet('reports/bankbook/', params(applied, { export: 1 }));
    if (all.truncated) notify(`Only the first ${all.rows.length.toLocaleString()} rows are included. Narrow the date range for the rest.`, 'warning');
    return all;
  };

  const print = async () => {
    if (!applied) return;
    const win = window.open('', '_blank', 'width=1200,height=900');  // open before awaiting, or the pop-up is blocked
    if (!win) { notify('Allow pop-ups to print the bank book.', 'warning'); return; }
    setPrinting(true);
    try {
      const all = await fetchAll();
      win.document.open();
      win.document.write(printHtml(all, { company, logo: storeProfile.logo_data_url, accountLabel, rangeLabel, branchLabel: all.branch?.label }));
      win.document.close();
    } catch (e) {
      win.close();
      notify(apiError(e, 'Could not prepare the bank book for printing.'), 'error');
    }
    setPrinting(false);
  };

  const exportCsv = async () => {
    if (!applied) return;
    try {
      const all = await fetchAll();
      const header = ['#', 'Branch', 'Date', 'Time', 'Bank Account', 'Voucher No.', 'Bill / Ref No.', 'Transaction', 'Party', 'Mode',
        'Reference / UTR / Cheque No.', 'Type', 'Credit (Deposit)', 'Debit (Withdrawal)', 'Balance', 'Bank Date', 'Cheque Status', 'Description', 'Remarks', 'Entered By'];
      const lines = all.rows.map(r => [r.row_no, r.branch_name, r.date, r.time, r.bank_account, r.entry_number, r.bill_number || r.source_number,
        r.voucher_kind_label, r.party, r.mode_label, r.reference, r.txn_type === 'CREDIT' ? 'Credit' : 'Debit', r.deposit || '', r.withdrawal || '',
        r.balance, r.value_date || '', r.cheque_status, r.description, r.remarks, r.entered_by]);
      const s = all.summary;
      const pad = (label, col, value) => { const row = Array(header.length).fill(''); row[8] = label; row[col] = value; return row; };
      lines.push([], pad('Opening Balance', 14, s.opening_balance), pad('Total Credits (Deposits)', 12, s.total_deposits),
        pad('Total Debits (Withdrawals)', 13, s.total_withdrawals), pad('Closing Bank Balance', 14, s.closing_balance));
      const csv = [header, ...lines].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `bankbook_${applied.dateFrom || 'start'}_${applied.dateTo || 'today'}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify(apiError(e, 'Could not export the bank book.'), 'error');
    }
  };

  const onRowKey = (e, r) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBillRow(r); } };
  const s = data?.summary;
  const showBankCol = !!data?.all_accounts;
  const cols = 12 + (multiBranchEnabled ? 1 : 0) + (showBankCol ? 1 : 0);

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, bgcolor: '#f8fafc' }}>
      <Box component="form" onSubmit={(e) => { e.preventDefault(); apply(); }}
        sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 2, '& .MuiButton-root': { flexShrink: 0 } }}>
        <TextField select size="small" label="Bank Account" value={draft.account} onChange={set('account')}
          sx={{ minWidth: 240, flex: { xs: '1 1 100%', sm: '1 1 240px' }, bgcolor: '#fff' }} inputProps={{ 'aria-label': 'Bank account' }}>
          {(accounts || []).map(a => (
            <MenuItem key={a.id} value={a.id}>
              {a.code} - {a.name}{a.account_number ? ` · A/c ${a.account_number}` : ''}{a.status !== 'Active' ? ' (Inactive)' : ''}
            </MenuItem>
          ))}
          {(accounts || []).length > 1 && <MenuItem value="all">All bank accounts</MenuItem>}
        </TextField>
        <TextField type="date" size="small" label="From Date" value={draft.dateFrom} onChange={set('dateFrom')}
          InputLabelProps={{ shrink: true }} sx={{ width: 165, flexShrink: 0, bgcolor: '#fff' }} />
        <TextField type="date" size="small" label="To Date" value={draft.dateTo} onChange={set('dateTo')}
          InputLabelProps={{ shrink: true }} sx={{ width: 165, flexShrink: 0, bgcolor: '#fff' }} />
        {multiBranchEnabled && (
          <TextField select size="small" label="Branch" value={draft.branch} onChange={set('branch')} sx={{ minWidth: 160, bgcolor: '#fff' }}>
            <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
            {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
        )}
        <TextField select size="small" label="Type" value={draft.type} onChange={set('type')} sx={{ width: 150, bgcolor: '#fff' }}>
          <MenuItem value="">Credit & Debit</MenuItem>
          <MenuItem value="CREDIT">Credit (money in)</MenuItem>
          <MenuItem value="DEBIT">Debit (money out)</MenuItem>
        </TextField>
        <TextField select size="small" label="Mode" value={draft.mode} onChange={set('mode')} sx={{ width: 170, bgcolor: '#fff' }}>
          <MenuItem value="">All modes</MenuItem>
          {BANK_MODES.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
        </TextField>
        <TextField size="small" label="Search" placeholder="Voucher, party, UTR, cheque no…" value={draft.search}
          onChange={set('search')} sx={{ flex: '1 1 220px', minWidth: 200, bgcolor: '#fff' }} />
        <Button type="submit" variant="contained" color={dirty ? 'warning' : 'primary'} startIcon={<ApplyIcon />}
          sx={{ fontWeight: 700, whiteSpace: 'nowrap', ...(dirty ? {} : { bgcolor: NAVY }) }}>Apply</Button>
        <Button variant="outlined" startIcon={<ResetIcon />} onClick={reset} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Reset</Button>
        <Button variant="outlined" startIcon={<PrintIcon />} onClick={print} disabled={!data || printing} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Print</Button>
        <Button variant="text" startIcon={<CsvIcon />} onClick={exportCsv} disabled={!data} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>CSV</Button>
      </Box>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} sm={6} md={3}><SummaryCard label="OPENING BALANCE" value={s?.opening_balance} color="#0f172a" accent="#64748b" /></Grid>
        <Grid item xs={12} sm={6} md={3}><SummaryCard label="TOTAL CREDITS (DEPOSITS)" value={s?.total_deposits} color={IN_COLOR} accent={IN_COLOR} /></Grid>
        <Grid item xs={12} sm={6} md={3}><SummaryCard label="TOTAL DEBITS (WITHDRAWALS)" value={s?.total_withdrawals} color={OUT_COLOR} accent={OUT_COLOR} /></Grid>
        <Grid item xs={12} sm={6} md={3}><SummaryCard label="CLOSING BANK BALANCE" value={s?.closing_balance} color={NAVY} accent={NAVY} note={s ? `${s.transactions} transactions` : ''} /></Grid>
      </Grid>
      {s && (
        <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mb: 2 }}>
          <Chip color="success" variant="outlined" label={`Pending to receive: ${formatMoney(s.pending_receive.amount)} (${s.pending_receive.count})`} />
          <Chip color="error" variant="outlined" label={`Pending to pay: ${formatMoney(s.pending_pay.amount)} (${s.pending_pay.count})`} />
          {s.pending_overdue.count > 0 && <Chip color="error" label={`Overdue: ${formatMoney(s.pending_overdue.amount)} (${s.pending_overdue.count})`} />}
          <Chip variant="outlined" label={`Uncleared cheques in: ${formatMoney(s.uncleared_cheques_received.amount)} (${s.uncleared_cheques_received.count})`} />
          <Chip variant="outlined" label={`Uncleared cheques out: ${formatMoney(s.uncleared_cheques_issued.amount)} (${s.uncleared_cheques_issued.count})`} />
          <Tooltip title="Closing balance + pending receipts − pending payments (pending settlements are not posted).">
            <Chip sx={{ bgcolor: '#eef2ff', color: NAVY, fontWeight: 800 }} label={`Projected balance: ${formatMoney(s.projected_balance)}`} />
          </Tooltip>
        </Stack>
      )}

      <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
        <FormControlLabel control={<Checkbox size="small" checked={draft.showReversed} onChange={set('showReversed')} />}
          label={<Typography variant="body2">Show reversed / voided entries</Typography>} />
        {data && (
          <Typography variant="caption" color="text.secondary">
            {accountLabel} · {data.branch?.label} · {rangeLabel}
            {s?.hidden_reversals ? ` · ${s.hidden_reversals} reversed entries hidden (they net to zero)` : ''}
          </Typography>
        )}
      </Stack>

      {loading && <LinearProgress sx={{ mb: 1 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {accounts && accounts.length === 0 && !error && (
        <Alert severity="info" sx={{ mb: 2 }}>No bank accounts found. Add one in Settings → Bank Master.</Alert>
      )}

      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '62vh' }}>
        <Table size="small" stickyHeader aria-label="Bank book transactions"
          sx={{ minWidth: 1250, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 }, '& .MuiTypography-body2': { fontSize: 13, lineHeight: 1.35 } }}>
          <TableHead>
            <TableRow>
              <TableCell sx={head} width={44}>#</TableCell>
              {multiBranchEnabled && <TableCell sx={head}>Branch</TableCell>}
              <TableCell sx={head}>Date / Time</TableCell>
              {showBankCol && <TableCell sx={head}>Bank Account</TableCell>}
              <TableCell sx={head}>Voucher No.</TableCell>
              <TableCell sx={head}>Transaction</TableCell>
              <TableCell sx={head}>Party</TableCell>
              <TableCell sx={head}>Mode</TableCell>
              <TableCell sx={head}>Ref / UTR / Chq No.</TableCell>
              <TableCell sx={head}>Type</TableCell>
              <TableCell sx={head} align="right">Credit (Deposit)</TableCell>
              <TableCell sx={head} align="right">Debit (Withdrawal)</TableCell>
              <TableCell sx={head} align="right">Balance</TableCell>
              <TableCell sx={head} width={44} />
            </TableRow>
          </TableHead>
          <TableBody>
            {data && data.page === 1 && !narrowed && (
              <TableRow sx={{ bgcolor: '#eef2f7' }}>
                <TableCell colSpan={cols - 2} sx={{ fontWeight: 700, color: 'text.secondary' }}>
                  Opening balance {applied?.dateFrom ? `as on ${formatDate(applied.dateFrom)}` : ''}
                </TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>{money(s.opening_balance)}</TableCell>
                <TableCell />
              </TableRow>
            )}
            {data && data.rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={cols} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                  {narrowed ? 'No bank transactions match these filters in this period.' : 'No bank transactions for the selected account, branch and dates.'}
                </TableCell>
              </TableRow>
            )}
            {data && data.rows.map((r, i) => (
              <TableRow key={r.row_id} hover tabIndex={0} onClick={() => setBillRow(r)} onKeyDown={(e) => onRowKey(e, r)}
                aria-label={`${r.voucher_kind_label} ${r.entry_number}, open voucher`}
                sx={{ cursor: 'pointer', bgcolor: i % 2 ? '#f8fafc' : '#fff', '&:focus-visible': { outline: `2px solid ${NAVY}`, outlineOffset: -2 } }}>
                <TableCell sx={{ color: 'text.secondary' }}>{r.row_no}</TableCell>
                {multiBranchEnabled && <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.branch_name || '—'}</TableCell>}
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Typography variant="body2">{formatDate(r.date)}</Typography>
                  <Typography variant="caption" color="text.secondary">{r.time}{r.value_date && r.value_date !== r.date ? ` · Bank ${formatDate(r.value_date)}` : ''}</Typography>
                </TableCell>
                {showBankCol && <TableCell sx={{ minWidth: 140 }}><Typography variant="body2" fontWeight={600}>{r.bank_account}</Typography></TableCell>}
                <TableCell sx={{ whiteSpace: 'nowrap' }}>
                  <Typography variant="body2" fontFamily="monospace" fontWeight={700} color={r.is_reversal ? 'warning.main' : 'primary.main'}>{r.entry_number}</Typography>
                  {(r.bill_number || r.source_number) && <Typography variant="caption" color="text.secondary">{r.bill_number || r.source_number}</Typography>}
                </TableCell>
                <TableCell>
                  <KindBadge row={r} />
                  {(r.is_reversal || r.status === 'REVERSED') && (
                    <Chip size="small" color="warning" variant="outlined" label={r.is_reversal ? 'Reversal' : 'Reversed'} sx={{ ml: 0.5, height: 20, fontSize: 11 }} />
                  )}
                  {r.settlements?.length > 0 && <Typography variant="caption" color="success.main" display="block">Settles {r.settlements.join(', ')}</Typography>}
                </TableCell>
                <TableCell sx={{ minWidth: 140, maxWidth: 220 }}>
                  <Typography variant="body2" fontWeight={600}>{r.party || '—'}</Typography>
                  {r.description && <Typography variant="caption" color="text.secondary">{r.description}</Typography>}
                </TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.mode_label || '—'}</TableCell>
                <TableCell sx={{ minWidth: 120 }}>
                  <Typography variant="body2" fontFamily="monospace">{r.reference || '—'}</Typography>
                  {r.cheque_status && <Chip size="small" color={CHEQUE_COLORS[r.cheque_status]} label={`Chq ${r.cheque_status.toLowerCase()}`} sx={{ height: 18, fontSize: 10.5 }} />}
                </TableCell>
                <TableCell>
                  <Chip size="small" label={r.txn_type === 'CREDIT' ? 'Cr' : 'Dr'} sx={{ height: 20, fontWeight: 800, color: '#fff', bgcolor: r.txn_type === 'CREDIT' ? IN_COLOR : OUT_COLOR }} />
                </TableCell>
                <TableCell align="right" sx={{ color: IN_COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{money(r.deposit)}</TableCell>
                <TableCell align="right" sx={{ color: OUT_COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{money(r.withdrawal)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 850, whiteSpace: 'nowrap', color: parseFloat(r.balance) < 0 ? OUT_COLOR : 'text.primary' }}>{money(r.balance)}</TableCell>
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Tooltip title="UTR / reference, mode, bank date">
                    <IconButton size="small" aria-label={`Bank details for ${r.entry_number}`} onClick={() => setEditRow(r)}><EditIcon fontSize="small" /></IconButton>
                  </Tooltip>
                </TableCell>
              </TableRow>
            ))}
            {narrowed && data.rows.length > 0 && (
              <TableRow sx={{ bgcolor: '#eef2f7' }}>
                <TableCell colSpan={cols - 4} sx={{ fontWeight: 700 }}>Matching rows ({data.matched.count})</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800, color: IN_COLOR }}>{money(data.matched.deposits)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800, color: OUT_COLOR }}>{money(data.matched.withdrawals)}</TableCell>
                <TableCell colSpan={2} />
              </TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {data && (
        <TablePagination component="div" count={data.count} page={Math.min(page, Math.max(0, data.num_pages - 1))}
          onPageChange={(e, p) => setPage(p)} rowsPerPage={pageSize}
          onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }}
          rowsPerPageOptions={[50, 100, 200, 500]} />
      )}
      {narrowed && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          Filters narrow the rows listed; each row keeps its real running balance and the summary covers the whole period.
        </Typography>
      )}

      {showBankCol && s?.by_account?.length > 0 && (
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, mt: 1 }}>
          <Table size="small" aria-label="Balance by bank account">
            <TableHead>
              <TableRow>
                <TableCell sx={head}>Bank Account</TableCell>
                <TableCell sx={head} align="right">Opening</TableCell>
                <TableCell sx={head} align="right">Credits</TableCell>
                <TableCell sx={head} align="right">Debits</TableCell>
                <TableCell sx={head} align="right">Closing</TableCell>
                <TableCell sx={head} align="right">Txns</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {s.by_account.map(a => (
                <TableRow key={a.id}>
                  <TableCell sx={{ fontWeight: 600 }}>{a.label}</TableCell>
                  <TableCell align="right">{money(a.opening)}</TableCell>
                  <TableCell align="right" sx={{ color: IN_COLOR }}>{money(a.deposits)}</TableCell>
                  <TableCell align="right" sx={{ color: OUT_COLOR }}>{money(a.withdrawals)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800 }}>{money(a.closing)}</TableCell>
                  <TableCell align="right">{a.transactions}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <ShowBillDialog row={billRow} onClose={() => setBillRow(null)} />
      <EntryDetailDialog row={editRow} onClose={() => setEditRow(null)} onSaved={() => { setEditRow(null); load(); }} />
    </Box>
  );
}

export default function BankBookPanel() {
  const [tab, setTab] = useState('transactions');
  const [accounts, setAccounts] = useState(null);
  const [pendingCount, setPendingCount] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    finGet('reports/bankbook/accounts/')
      .then((d) => { if (alive) setAccounts(d.accounts || []); })
      .catch((e) => { if (alive) { setError(apiError(e)); setAccounts([]); } });
    return () => { alive = false; };
  }, []);

  return (
    <Card variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, pt: 2, borderBottom: '1px solid #e2e8f0' }}>
        <Typography variant="h6" fontWeight={850} sx={{ letterSpacing: 0.3, color: NAVY }}>BANK BOOK — BANK TRANSACTIONS</Typography>
        <Typography variant="body2" color="text.secondary">
          Every deposit, withdrawal, transfer, UPI, NEFT / RTGS / IMPS, card, POS and cheque movement on your bank accounts, and settlements promised by bank.
        </Typography>
        <Tabs value={tab} onChange={(e, v) => setTab(v)} sx={{ mt: 1, '& .MuiTab-root': { fontWeight: 700, minHeight: 48 } }}>
          <Tab value="transactions" icon={<BankIcon />} iconPosition="start" label="Bank Transactions" />
          <Tab value="pending" iconPosition="start" label="Pending Settlements"
            icon={<Badge color="warning" badgeContent={pendingCount} max={99}><PendingIcon /></Badge>} />
        </Tabs>
      </Box>
      {error && <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>}
      {tab === 'transactions' && <BankTransactions accounts={accounts} onPendingCount={setPendingCount} />}
      {tab === 'pending' && <BankPendingSettlements accounts={accounts || []} onChanged={setPendingCount} />}
    </Card>
  );
}

function printHtml(data, { company, logo, accountLabel, rangeLabel, branchLabel }) {
  const s = data.summary;
  const withBranch = data.rows.some(r => r.branch_name);
  const withBank = data.all_accounts;
  const rows = data.rows.map(r => `
    <tr>
      <td>${r.row_no}</td>${withBranch ? `<td>${esc(r.branch_name)}</td>` : ''}
      <td class="nw">${esc(formatDate(r.date))}<br><small>${esc(r.time)}</small></td>
      ${withBank ? `<td>${esc(r.bank_account)}</td>` : ''}
      <td class="nw"><b>${esc(r.entry_number)}</b>${r.bill_number || r.source_number ? `<br><small>${esc(r.bill_number || r.source_number)}</small>` : ''}</td>
      <td>${esc(r.voucher_kind_label)}${r.is_reversal ? ' (Reversal)' : r.status === 'REVERSED' ? ' (Reversed)' : ''}</td>
      <td>${esc(r.party)}</td>
      <td class="nw">${esc(r.mode_label)}</td>
      <td>${esc(r.reference)}${r.cheque_status ? `<br><small>Chq ${esc(r.cheque_status.toLowerCase())}</small>` : ''}</td>
      <td>${r.txn_type === 'CREDIT' ? 'Cr' : 'Dr'}</td>
      <td class="r in">${esc(money(r.deposit))}</td>
      <td class="r out">${esc(money(r.withdrawal))}</td>
      <td class="r"><b>${esc(money(r.balance))}</b></td>
    </tr>`).join('');
  const cols = 11 + (withBranch ? 1 : 0) + (withBank ? 1 : 0);
  const narrowed = data.search || data.type || data.modes?.length;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Bank Book ${esc(rangeLabel)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; font-size: 10.5px; margin: 0; }
  .hdr { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid ${NAVY}; padding-bottom: 8px; margin-bottom: 10px; }
  .hdr img { max-height: 54px; max-width: 140px; object-fit: contain; }
  .hdr h1 { font-size: 18px; margin: 0; } .hdr p { margin: 2px 0 0; color: #475569; }
  h2 { font-size: 14px; margin: 0 0 4px; letter-spacing: .3px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 22px; margin-bottom: 8px; color: #334155; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #eef2ff; color: #3730a3; border-bottom: 1px solid #c7d2fe; text-align: left; padding: 5px 5px; font-size: 10px; }
  td { padding: 4px 5px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #f8fafc; }
  .r { text-align: right; white-space: nowrap; } .nw { white-space: nowrap; }
  .in { color: ${IN_COLOR}; } .out { color: ${OUT_COLOR}; }
  .ob td { background: #eef2f7 !important; font-weight: 700; }
  .sum { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
  .sum div { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; }
  .sum small { display: block; color: #64748b; font-weight: 700; } .sum b { font-size: 14px; }
  .pend { margin-top: 8px; color: #334155; }
  .foot { margin-top: 10px; color: #64748b; font-size: 10px; display: flex; justify-content: space-between; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style></head><body>
  <div class="hdr">
    ${logo ? `<img src="${esc(logo)}" alt="">` : ''}
    <div><h1>${esc(company.name || 'Bank Book')}</h1>
      <p>${esc(company.address)}${company.phone ? ` · Ph: ${esc(company.phone)}` : ''}${company.gstin ? ` · GSTIN: ${esc(company.gstin)}` : ''}</p></div>
  </div>
  <h2>BANK BOOK — BANK TRANSACTIONS</h2>
  <div class="meta">
    <span><b>Bank account:</b> ${esc(accountLabel)}</span>
    <span><b>Branch:</b> ${esc(branchLabel || 'All branches')}</span>
    <span><b>Period:</b> ${esc(rangeLabel)}</span>
    ${data.search ? `<span><b>Search:</b> ${esc(data.search)}</span>` : ''}
  </div>
  <table>
    <thead><tr><th>#</th>${withBranch ? '<th>Branch</th>' : ''}<th>Date / Time</th>${withBank ? '<th>Bank</th>' : ''}<th>Voucher No.</th><th>Transaction</th><th>Party</th>
      <th>Mode</th><th>Ref / UTR / Chq</th><th>Type</th><th class="r">Credit</th><th class="r">Debit</th><th class="r">Balance</th></tr></thead>
    <tbody>
      ${narrowed ? '' : `<tr class="ob"><td colspan="${cols - 1}">Opening balance</td><td class="r">${esc(money(s.opening_balance))}</td></tr>`}
      ${rows || `<tr><td colspan="${cols}" style="text-align:center;padding:18px;color:#64748b">No bank transactions for these filters.</td></tr>`}
    </tbody>
  </table>
  <div class="sum">
    <div><small>OPENING BALANCE</small><b>${esc(money(s.opening_balance))}</b></div>
    <div><small>TOTAL CREDITS (DEPOSITS)</small><b class="in">${esc(money(s.total_deposits))}</b></div>
    <div><small>TOTAL DEBITS (WITHDRAWALS)</small><b class="out">${esc(money(s.total_withdrawals))}</b></div>
    <div><small>CLOSING BANK BALANCE</small><b>${esc(money(s.closing_balance))}</b></div>
  </div>
  <div class="pend">Pending to receive: <b>${esc(money(s.pending_receive.amount))}</b> (${s.pending_receive.count}) ·
    Pending to pay: <b>${esc(money(s.pending_pay.amount))}</b> (${s.pending_pay.count}) ·
    Uncleared cheques in / out: <b>${esc(money(s.uncleared_cheques_received.amount))}</b> / <b>${esc(money(s.uncleared_cheques_issued.amount))}</b> ·
    Projected balance: <b>${esc(money(s.projected_balance))}</b></div>
  <div class="foot"><span>${data.truncated ? `Truncated to the first ${data.rows.length} rows. ` : ''}${narrowed ? 'Rows filtered; summary covers the whole period.' : ''}</span>
    <span>Generated ${esc(new Date().toLocaleString())}</span></div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };</script>
</body></html>`;
}
