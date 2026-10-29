// Financial → Cheque Register: every cheque entered on a Receipt / Payment Voucher (normal or Bill
// to Bill, including a cheque part of a split payment), from GET /api/financial/cheques/. Status
// changes (deposited / cleared / bounced / cancelled) are tracking only: the voucher already booked
// the bank side, so nothing here posts to the ledger. A bounced cheque is undone by reversing its
// voucher from Vouchers → View All, which cancels the cheque automatically.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, Dialog, DialogActions, DialogContent, DialogTitle, Grid, IconButton, LinearProgress, ListItemText,
  Menu, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField,
  Tooltip, Typography,
} from '@mui/material';
import {
  Print as PrintIcon, FilterAlt as ApplyIcon, RestartAlt as ResetIcon, FileDownload as CsvIcon, MoreVert as MoreIcon,
} from '@mui/icons-material';
import { apiError, finGet, finPatch } from './financialApi';
import ChequeDetailsDialog, { DaysLeftChip } from './ChequeDetailsDialog';
import useBankAccounts from '../../hooks/useBankAccounts';
import { useBranch } from '../../context/BranchContext';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate, formatMoney } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';
import { CHEQUE_STATUSES, chequeFromRow, chequePayload, daysLeftLabel, localYmd } from '../../utils/cheques';

const NAVY = '#0f1e3d';
const IN_COLOR = '#15803d';
const OUT_COLOR = '#b91c1c';
const head = { color: '#3730a3', fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap', bgcolor: '#eef2ff', borderBottom: '1px solid #c7d2fe', py: 1.25 };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const STATUS_FILTERS = [
  ['', 'All statuses'], ['PENDING,DEPOSITED', 'Open (pending + deposited)'],
  ...Object.entries(CHEQUE_STATUSES).map(([k, v]) => [k, v.label]),
];
const DUE_FILTERS = [['', 'Any'], ['overdue', 'Overdue'], ['today', 'Due today'], ['week', 'Due in next 7 days']];
const DATE_FIELDS = [['cheque', 'Cheque date'], ['deposited', 'Deposited date'], ['cleared', 'Cleared date'], ['entered', 'Entered on']];
const SORTS = [['due', 'Soonest due first'], ['cheque_date', 'Cheque date (newest)'], ['entered', 'Recently entered'], ['amount', 'Amount (highest)']];

// Menu actions -> target status. Which ones show comes from the row's allowed_status (server rules).
const ACTIONS = [
  ['DEPOSITED', 'Mark Deposited', 'Enter the date it went into the bank.'],
  ['CLEARED', 'Mark Cleared', 'The bank has credited / debited the amount.'],
  ['BOUNCED', 'Mark Bounced', 'Returned unpaid. Reverse the voucher to undo its posting.'],
  ['PENDING', 'Back to Pending', 'Not yet deposited (or to present again).'],
  ['CANCELLED', 'Cancel Cheque', 'Void / replaced. This cannot be undone.'],
];

const defaultFilters = () => ({
  direction: '', status: '', due: '', dateField: 'cheque', dateFrom: '', dateTo: '', bankAccount: '', branch: 'all', search: '', sort: 'due',
});
const params = (f, extra = {}) => ({
  direction: f.direction, status: f.status, due: f.due, date_field: f.dateField, date_from: f.dateFrom, date_to: f.dateTo,
  bank_account: f.bankAccount, branch: f.branch, search: f.search.trim(), sort: f.sort, ...extra,
});

export const StatusBadge = ({ status, label }) => {
  const st = CHEQUE_STATUSES[status] || CHEQUE_STATUSES.PENDING;
  return (
    <Box component="span" sx={{ display: 'inline-block', px: 1, py: 0.25, borderRadius: 1, fontSize: 11.5, fontWeight: 700, color: st.fg, bgcolor: st.bg, whiteSpace: 'nowrap' }}>
      {label || st.label}
    </Box>
  );
};

function SummaryCard({ label, stat, accent, onClick, active }) {
  return (
    <Paper variant="outlined" onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      sx={{ p: 1.75, borderRadius: 2, borderLeft: `4px solid ${accent}`, height: '100%', cursor: onClick ? 'pointer' : 'default',
        outline: active ? `2px solid ${accent}` : 'none', '&:hover': onClick ? { bgcolor: '#f8fafc' } : {} }}>
      <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>{label}</Typography>
      <Typography variant="h6" fontWeight={850} sx={{ color: accent, mt: 0.25, lineHeight: 1.3 }}>{formatMoney(stat?.amount || 0)}</Typography>
      <Typography variant="caption" color="text.secondary">{stat?.count || 0} cheque{stat?.count === 1 ? '' : 's'}</Typography>
    </Paper>
  );
}

function StatusDialog({ target, onClose, onDone }) {
  const { row, status } = target || {};
  const [date, setDate] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dateKey = status === 'DEPOSITED' ? 'deposited_date' : status === 'CLEARED' ? 'cleared_date' : null;

  useEffect(() => {
    if (!target) return;
    const today = localYmd();
    // A post-dated cheque can't go in before its date; default to its planned deposit date, if any.
    const earliest = row.cheque_date > today ? row.cheque_date : today;
    setDate(status === 'DEPOSITED' ? (row.deposited_date || earliest) : (row.deposited_date && row.deposited_date > today ? row.deposited_date : today));
    setNote('');
    setError('');
  }, [target]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError('');
    try {
      const body = { status, ...(dateKey ? { [dateKey]: date || null } : {}), ...(note.trim() ? { status_note: note.trim() } : {}) };
      const updated = await finPatch(`cheques/${row.id}/`, body);
      onDone(updated, `Cheque ${row.cheque_number} marked ${CHEQUE_STATUSES[status].label.toLowerCase()}.`);
    } catch (err) {
      setError(apiError(err, 'Could not update the cheque.'));
    }
    setSaving(false);
  };

  const action = ACTIONS.find(a => a[0] === status);
  return (
    <Dialog open={!!target} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth>
      {target && (
        <Box component="form" onSubmit={save}>
          <DialogTitle sx={{ fontWeight: 850 }}>{action?.[1]} — Chq {row.cheque_number}</DialogTitle>
          <DialogContent dividers>
            <Typography variant="body2" sx={{ mb: 2 }}>
              {row.direction_label} · {formatMoney(row.amount)} · {row.party_name || '—'} · {row.voucher_number}
            </Typography>
            {dateKey && (
              <TextField type="date" fullWidth size="small" sx={{ mb: 2 }} label={status === 'DEPOSITED' ? 'Deposited Date' : 'Cleared Date'}
                value={date} onChange={(e) => setDate(e.target.value)} InputLabelProps={{ shrink: true }}
                inputProps={{ min: status === 'CLEARED' ? (row.deposited_date || row.cheque_date) : row.cheque_date }} />
            )}
            <TextField fullWidth size="small" label={status === 'BOUNCED' ? 'Reason (e.g. funds insufficient)' : 'Note (optional)'}
              value={note} onChange={(e) => setNote(e.target.value)} inputProps={{ maxLength: 255 }} />
            {status === 'BOUNCED' && (
              <Alert severity="warning" sx={{ mt: 2 }}>
                This only updates the register. To take the amount back off the books, reverse voucher {row.voucher_number} from Vouchers → View All.
              </Alert>
            )}
            {status === 'CANCELLED' && <Alert severity="warning" sx={{ mt: 2 }}>A cancelled cheque can no longer be changed.</Alert>}
            {error && <Alert severity="error" sx={{ mt: 2 }}>{error}</Alert>}
          </DialogContent>
          <DialogActions sx={{ px: 3 }}>
            <Button type="submit" variant="contained" disabled={saving} color={status === 'BOUNCED' || status === 'CANCELLED' ? 'error' : 'primary'} sx={{ fontWeight: 800 }}>
              {saving ? 'Saving…' : action?.[1]}
            </Button>
            <Button onClick={onClose} disabled={saving}>Close</Button>
          </DialogActions>
        </Box>
      )}
    </Dialog>
  );
}

export default function ChequeRegister() {
  const { multiBranchEnabled, branches, isAdmin } = useBranch();
  const { banks } = useBankAccounts();
  const storeProfile = useStoreProfile();
  const company = companyFromProfile(storeProfile);
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [menu, setMenu] = useState(null);         // { anchor, row }
  const [statusTarget, setStatusTarget] = useState(null);
  const [editRow, setEditRow] = useState(null);
  const [editSaving, setEditSaving] = useState(false);
  const [printing, setPrinting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await finGet('cheques/', params(applied, { page: page + 1, page_size: pageSize })));
    } catch (e) {
      setError(apiError(e));
      setData(null);
    }
    setLoading(false);
  }, [applied, page, pageSize]);
  useEffect(() => { load(); }, [load]);

  const applyFilters = (f) => {
    if (f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) { setError('From date must be on or before To date.'); return; }
    setPage(0);
    setDraft(f);
    setApplied(f);
  };
  const set = (k) => (e) => setDraft(f => ({ ...f, [k]: e.target.value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  // Summary cards are shortcuts: click to filter, click again to clear.
  const quick = (patch) => {
    const on = Object.entries(patch).every(([k, v]) => applied[k] === v);
    applyFilters({ ...applied, status: '', due: '', direction: '', ...(on ? {} : patch) });
  };
  const isQuick = (patch) => Object.entries({ status: '', due: '', direction: '', ...patch }).every(([k, v]) => applied[k] === v);

  const done = (updated, message) => {
    setStatusTarget(null);
    setEditRow(null);
    notify(message, 'success');
    if (updated) load();
  };

  const saveEdit = async ({ cheque }) => {
    setEditSaving(true);
    try {
      const p = chequePayload(cheque);
      const updated = await finPatch(`cheques/${editRow.id}/`, {
        cheque_number: p.cheque_number, cheque_date: p.cheque_date, bank_name: p.bank_name,
        deposited_date: p.deposited_date, party_name: p.party_name, remarks: p.remarks,
      });
      done(updated, `Cheque ${updated.cheque_number} updated.`);
    } catch (e) {
      notify(apiError(e, 'Could not update the cheque.'), 'error');
    }
    setEditSaving(false);
  };

  const fetchAll = async () => {
    const all = await finGet('cheques/', params(applied, { export: 1 }));
    if (all.truncated) notify(`Only the first ${all.rows.length.toLocaleString()} cheques are included. Narrow the filters for the rest.`, 'warning');
    return all;
  };

  const filterText = () => {
    const parts = [];
    if (applied.direction) parts.push(applied.direction === 'RECEIVED' ? 'Received' : 'Issued');
    if (applied.status) parts.push(STATUS_FILTERS.find(s => s[0] === applied.status)?.[1]);
    if (applied.due) parts.push(DUE_FILTERS.find(s => s[0] === applied.due)?.[1]);
    if (applied.dateFrom || applied.dateTo) {
      parts.push(`${DATE_FIELDS.find(d => d[0] === applied.dateField)?.[1]} ${applied.dateFrom ? formatDate(applied.dateFrom) : 'start'} – ${applied.dateTo ? formatDate(applied.dateTo) : 'today'}`);
    }
    if (applied.bankAccount) parts.push(banks.find(b => b.id === applied.bankAccount)?.name || 'Bank');
    if (applied.search.trim()) parts.push(`“${applied.search.trim()}”`);
    return parts.join(' · ') || 'All cheques';
  };

  const exportCsv = async () => {
    try {
      const all = await fetchAll();
      const header = ['#', 'Type', 'Voucher No.', 'Cheque No.', 'Cheque Date', 'Bank Name', 'Company / Party', 'Amount',
        'Deposited Date', 'Cleared Date', 'Due Date', 'Days Left', 'Status', 'Status Note', 'Our Bank Ledger', 'Remarks',
        ...(multiBranchEnabled ? ['Branch'] : []), 'Entered By', 'Entered On'];
      const lines = all.rows.map((r, i) => [i + 1, r.direction_label, r.voucher_number, r.cheque_number, r.cheque_date, r.bank_name,
        r.party_name, r.amount, r.deposited_date || '', r.cleared_date || '', r.due_date, r.days_left ?? '', r.status_label, r.status_note,
        r.bank_account_name, r.remarks, ...(multiBranchEnabled ? [r.branch_name] : []), r.created_by, String(r.created_at || '').slice(0, 10)]);
      lines.push([], ['', '', '', '', '', '', 'Total', all.matched_amount]);
      const csv = [header, ...lines].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `cheque_register_${localYmd()}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify(apiError(e, 'Could not export the cheque register.'), 'error');
    }
  };

  const print = async () => {
    const win = window.open('', '_blank', 'width=1100,height=900');   // open before awaiting, or the pop-up is blocked
    if (!win) { notify('Allow pop-ups to print the cheque register.', 'warning'); return; }
    setPrinting(true);
    try {
      const all = await fetchAll();
      win.document.open();
      win.document.write(printHtml(all, { company, logo: storeProfile.logo_data_url, filters: filterText() }));
      win.document.close();
    } catch (e) {
      win.close();
      notify(apiError(e, 'Could not prepare the cheque register for printing.'), 'error');
    }
    setPrinting(false);
  };

  const s = data?.summary;
  const rows = data?.rows || [];
  const cols = multiBranchEnabled ? 14 : 13;

  return (
    <Card variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, py: 2, borderBottom: '1px solid #e2e8f0' }}>
        <Typography variant="h6" fontWeight={850} sx={{ letterSpacing: 0.3, color: NAVY }}>CHEQUE REGISTER</Typography>
        <Typography variant="body2" color="text.secondary">
          Cheques received on Receipt Vouchers and issued on Payment Vouchers — track deposit, clearing and days remaining.
        </Typography>
      </Box>

      <Box sx={{ p: { xs: 2, md: 3 }, bgcolor: '#f8fafc' }}>
        <Grid container spacing={1.5} sx={{ mb: 2 }}>
          <Grid item xs={6} md={2}><SummaryCard label="RECEIVED · OPEN" stat={s?.received_open} accent={IN_COLOR} onClick={() => quick({ direction: 'RECEIVED', status: 'PENDING,DEPOSITED' })} active={isQuick({ direction: 'RECEIVED', status: 'PENDING,DEPOSITED' })} /></Grid>
          <Grid item xs={6} md={2}><SummaryCard label="ISSUED · OPEN" stat={s?.issued_open} accent={OUT_COLOR} onClick={() => quick({ direction: 'ISSUED', status: 'PENDING,DEPOSITED' })} active={isQuick({ direction: 'ISSUED', status: 'PENDING,DEPOSITED' })} /></Grid>
          <Grid item xs={6} md={2}><SummaryCard label="OVERDUE" stat={s?.overdue} accent="#dc2626" onClick={() => quick({ due: 'overdue' })} active={isQuick({ due: 'overdue' })} /></Grid>
          <Grid item xs={6} md={2}><SummaryCard label="DUE IN 7 DAYS" stat={s?.due_week} accent="#d97706" onClick={() => quick({ due: 'week' })} active={isQuick({ due: 'week' })} /></Grid>
          <Grid item xs={6} md={2}><SummaryCard label="CLEARED" stat={s?.by_status?.CLEARED} accent="#166534" onClick={() => quick({ status: 'CLEARED' })} active={isQuick({ status: 'CLEARED' })} /></Grid>
          <Grid item xs={6} md={2}><SummaryCard label="BOUNCED" stat={s?.by_status?.BOUNCED} accent="#991b1b" onClick={() => quick({ status: 'BOUNCED' })} active={isQuick({ status: 'BOUNCED' })} /></Grid>
        </Grid>

        <Box component="form" onSubmit={(e) => { e.preventDefault(); applyFilters(draft); }}
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 1.5, '& .MuiButton-root': { flexShrink: 0 } }}>
          <TextField select size="small" label="Type" value={draft.direction} onChange={set('direction')} sx={{ minWidth: 140, bgcolor: '#fff' }}>
            <MenuItem value="">All</MenuItem>
            <MenuItem value="RECEIVED">Received (RV)</MenuItem>
            <MenuItem value="ISSUED">Issued (PV)</MenuItem>
          </TextField>
          <TextField select size="small" label="Status" value={draft.status} onChange={set('status')} sx={{ minWidth: 190, bgcolor: '#fff' }}>
            {STATUS_FILTERS.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Due" value={draft.due} onChange={set('due')} sx={{ minWidth: 160, bgcolor: '#fff' }}>
            {DUE_FILTERS.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Date by" value={draft.dateField} onChange={set('dateField')} sx={{ minWidth: 150, bgcolor: '#fff' }}>
            {DATE_FIELDS.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
          </TextField>
          <TextField type="date" size="small" label="From" value={draft.dateFrom} onChange={set('dateFrom')} InputLabelProps={{ shrink: true }} sx={{ width: 165, bgcolor: '#fff' }} />
          <TextField type="date" size="small" label="To" value={draft.dateTo} onChange={set('dateTo')} InputLabelProps={{ shrink: true }} sx={{ width: 165, bgcolor: '#fff' }} />
          <TextField select size="small" label="Our Bank" value={draft.bankAccount} onChange={set('bankAccount')} sx={{ minWidth: 180, bgcolor: '#fff' }}>
            <MenuItem value="">All banks</MenuItem>
            {banks.map(b => <MenuItem key={b.id} value={b.id}>{b.code} - {b.name}</MenuItem>)}
          </TextField>
          {multiBranchEnabled && (
            <TextField select size="small" label="Branch" value={draft.branch} onChange={set('branch')} sx={{ minWidth: 160, bgcolor: '#fff' }}>
              <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          )}
          <TextField select size="small" label="Sort" value={draft.sort} onChange={set('sort')} sx={{ minWidth: 170, bgcolor: '#fff' }}>
            {SORTS.map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
          </TextField>
          <TextField size="small" label="Search" placeholder="Cheque no, party, bank, voucher, remarks…" value={draft.search}
            onChange={set('search')} sx={{ flex: '1 1 220px', minWidth: 200, bgcolor: '#fff' }} />
          <Button type="submit" variant="contained" color={dirty ? 'warning' : 'primary'} startIcon={<ApplyIcon />}
            sx={{ fontWeight: 700, ...(dirty ? {} : { bgcolor: NAVY }) }}>Apply</Button>
          <Button variant="outlined" startIcon={<ResetIcon />} onClick={() => applyFilters(defaultFilters())} sx={{ fontWeight: 700 }}>Reset</Button>
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={print} disabled={!data || printing} sx={{ fontWeight: 700 }}>Print</Button>
          <Button variant="text" startIcon={<CsvIcon />} onClick={exportCsv} disabled={!data} sx={{ fontWeight: 700 }}>CSV</Button>
        </Box>
        {data && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            {filterText()} · {data.count} cheque{data.count === 1 ? '' : 's'} · {formatMoney(data.matched_amount)}
            {multiBranchEnabled ? ` · ${data.branch?.label}` : ''} · Days left counted from {formatDate(data.today)}
          </Typography>
        )}

        {loading && <LinearProgress sx={{ mb: 1 }} />}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '62vh' }}>
          <Table size="small" stickyHeader aria-label="Cheque register"
            sx={{ minWidth: 1250, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={head}>Type</TableCell>
                <TableCell sx={head}>Voucher No.</TableCell>
                <TableCell sx={head}>Cheque No.</TableCell>
                <TableCell sx={head}>Cheque Date</TableCell>
                <TableCell sx={head}>Bank Name</TableCell>
                <TableCell sx={head}>Company / Party</TableCell>
                <TableCell sx={head} align="right">Amount</TableCell>
                <TableCell sx={head}>Deposited</TableCell>
                <TableCell sx={head}>Days Left</TableCell>
                <TableCell sx={head}>Status</TableCell>
                <TableCell sx={head}>Remarks</TableCell>
                {multiBranchEnabled && <TableCell sx={head}>Branch</TableCell>}
                <TableCell sx={head}>Our Bank</TableCell>
                <TableCell sx={head} align="center" width={48} />
              </TableRow>
            </TableHead>
            <TableBody>
              {data && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={cols} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    No cheques match these filters. Cheques appear here when a Receipt or Payment Voucher is saved with the Cheque pay mode.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((r, i) => (
                <TableRow key={r.id} hover sx={{ bgcolor: i % 2 ? '#f8fafc' : '#fff', opacity: r.status === 'CANCELLED' ? 0.6 : 1 }}>
                  <TableCell sx={{ whiteSpace: 'nowrap', fontWeight: 700, color: r.direction === 'RECEIVED' ? IN_COLOR : OUT_COLOR }}>
                    {r.direction === 'RECEIVED' ? '↓ Received' : '↑ Issued'}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 170 }}>
                    <Typography variant="body2" fontFamily="monospace" fontWeight={700} color="primary.main" sx={{ wordBreak: 'break-word' }}>{r.voucher_number || '—'}</Typography>
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 800, whiteSpace: 'nowrap' }}>{r.cheque_number}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(r.cheque_date)}</TableCell>
                  <TableCell>{r.bank_name || '—'}</TableCell>
                  <TableCell sx={{ minWidth: 140, fontWeight: 600 }}>{r.party_name || '—'}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{formatMoney(r.amount)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    {r.deposited_date ? formatDate(r.deposited_date) : '—'}
                    {r.cleared_date && <Typography variant="caption" color="success.main" display="block">Cleared {formatDate(r.cleared_date)}</Typography>}
                  </TableCell>
                  <TableCell><DaysLeftChip days={r.days_left} /></TableCell>
                  <TableCell>
                    <StatusBadge status={r.status} label={r.status_label} />
                    {r.status_note && <Typography variant="caption" color="text.secondary" display="block" sx={{ maxWidth: 160 }}>{r.status_note}</Typography>}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 200 }}><Typography variant="body2" noWrap title={r.remarks}>{r.remarks || '—'}</Typography></TableCell>
                  {multiBranchEnabled && <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.branch_name || '—'}</TableCell>}
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.bank_account_name || '—'}</TableCell>
                  <TableCell align="center">
                    <Tooltip title={r.status === 'CANCELLED' ? 'Cancelled' : 'Update status / edit'}>
                      <span>
                        <IconButton size="small" disabled={r.status === 'CANCELLED'} aria-label={`Actions for cheque ${r.cheque_number}`}
                          onClick={(e) => setMenu({ anchor: e.currentTarget, row: r })}>
                          <MoreIcon fontSize="small" />
                        </IconButton>
                      </span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        {data && (
          <TablePagination component="div" count={data.count} page={Math.min(page, Math.max(0, data.num_pages - 1))}
            onPageChange={(e, p) => setPage(p)} rowsPerPage={pageSize}
            onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }}
            rowsPerPageOptions={[50, 100, 200, 500]} />
        )}
        <Stack direction="row" spacing={1} sx={{ mt: 0.5 }}>
          <Typography variant="caption" color="text.secondary">
            Status changes are for tracking only and post nothing. A bounced cheque's amount is taken off the books by reversing its voucher (that also cancels the cheque here).
          </Typography>
        </Stack>
      </Box>

      <Menu anchorEl={menu?.anchor} open={!!menu} onClose={() => setMenu(null)}>
        {menu && ACTIONS.filter(([st]) => menu.row.allowed_status.includes(st)).map(([st, label, hint]) => (
          <MenuItem key={st} onClick={() => { setStatusTarget({ row: menu.row, status: st }); setMenu(null); }}>
            <ListItemText primary={label} secondary={hint} />
          </MenuItem>
        ))}
        {menu && ['PENDING', 'DEPOSITED', 'BOUNCED'].includes(menu.row.status) && (
          <MenuItem onClick={() => { setEditRow(menu.row); setMenu(null); }}>
            <ListItemText primary="Edit Cheque Details" secondary="Correct the number, dates, bank, party or remarks." />
          </MenuItem>
        )}
      </Menu>

      <StatusDialog target={statusTarget} onClose={() => setStatusTarget(null)} onDone={done} />
      <ChequeDetailsDialog
        open={!!editRow}
        direction={editRow?.direction}
        value={editRow ? chequeFromRow(editRow) : null}
        amount={editRow?.amount}
        amountLocked
        saving={editSaving}
        onSave={saveEdit}
        onClose={() => setEditRow(null)}
      />
    </Card>
  );
}

function printHtml(data, { company, logo, filters }) {
  const withBranch = data.rows.some(r => r.branch_name);
  const rows = data.rows.map((r, i) => `
    <tr class="${r.status === 'CANCELLED' ? 'muted' : ''}">
      <td>${i + 1}</td>
      <td class="nw ${r.direction === 'RECEIVED' ? 'in' : 'out'}">${esc(r.direction_label)}</td>
      <td class="nw">${esc(r.voucher_number)}</td>
      <td class="nw"><b>${esc(r.cheque_number)}</b></td>
      <td class="nw">${esc(formatDate(r.cheque_date))}</td>
      <td>${esc(r.bank_name)}</td>
      <td>${esc(r.party_name)}</td>
      <td class="r"><b>${esc(formatMoney(r.amount))}</b></td>
      <td class="nw">${r.deposited_date ? esc(formatDate(r.deposited_date)) : ''}${r.cleared_date ? `<br><small>Cleared ${esc(formatDate(r.cleared_date))}</small>` : ''}</td>
      <td class="nw">${esc(r.days_left === null || r.days_left === undefined ? '' : daysLeftLabel(r.days_left))}</td>
      <td class="nw">${esc(r.status_label)}${r.status_note ? `<br><small>${esc(r.status_note)}</small>` : ''}</td>
      <td>${esc(r.remarks)}</td>${withBranch ? `<td>${esc(r.branch_name)}</td>` : ''}
    </tr>`).join('');
  const s = data.summary;
  const cols = withBranch ? 13 : 12;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cheque Register</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; font-size: 11px; margin: 0; }
  .hdr { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid ${NAVY}; padding-bottom: 8px; margin-bottom: 10px; }
  .hdr img { max-height: 54px; max-width: 140px; object-fit: contain; }
  .hdr h1 { font-size: 18px; margin: 0; } .hdr p { margin: 2px 0 0; color: #475569; }
  h2 { font-size: 14px; margin: 0 0 4px; letter-spacing: .3px; }
  .meta { margin-bottom: 8px; color: #334155; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #eef2ff; color: #3730a3; border-bottom: 1px solid #c7d2fe; text-align: left; padding: 5px 6px; font-size: 10.5px; }
  td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #f8fafc; }
  .r { text-align: right; white-space: nowrap; } .nw { white-space: nowrap; }
  .in { color: ${IN_COLOR}; } .out { color: ${OUT_COLOR}; } .muted td { color: #94a3b8; }
  .sum { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 12px; }
  .sum div { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; }
  .sum small { display: block; color: #64748b; font-weight: 700; } .sum b { font-size: 13px; }
  .foot { margin-top: 10px; color: #64748b; font-size: 10px; display: flex; justify-content: space-between; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style></head><body>
  <div class="hdr">
    ${logo ? `<img src="${esc(logo)}" alt="">` : ''}
    <div><h1>${esc(company.name || 'Cheque Register')}</h1>
      <p>${esc(company.address)}${company.phone ? ` · Ph: ${esc(company.phone)}` : ''}${company.gstin ? ` · GSTIN: ${esc(company.gstin)}` : ''}</p></div>
  </div>
  <h2>CHEQUE REGISTER</h2>
  <div class="meta"><b>Filters:</b> ${esc(filters)} · <b>${data.count}</b> cheques · <b>${esc(formatMoney(data.matched_amount))}</b> · Days left as on ${esc(formatDate(data.today))}</div>
  <table>
    <thead><tr><th>#</th><th>Type</th><th>Voucher No.</th><th>Cheque No.</th><th>Cheque Date</th><th>Bank</th><th>Company / Party</th>
      <th class="r">Amount</th><th>Deposited</th><th>Days Left</th><th>Status</th><th>Remarks</th>${withBranch ? '<th>Branch</th>' : ''}</tr></thead>
    <tbody>${rows || `<tr><td colspan="${cols}" style="text-align:center;padding:18px;color:#64748b">No cheques for these filters.</td></tr>`}</tbody>
  </table>
  <div class="sum">
    <div><small>RECEIVED · OPEN</small><b class="in">${esc(formatMoney(s.received_open.amount))}</b> (${s.received_open.count})</div>
    <div><small>ISSUED · OPEN</small><b class="out">${esc(formatMoney(s.issued_open.amount))}</b> (${s.issued_open.count})</div>
    <div><small>OVERDUE</small><b>${esc(formatMoney(s.overdue.amount))}</b> (${s.overdue.count})</div>
    <div><small>CLEARED</small><b>${esc(formatMoney(s.by_status.CLEARED.amount))}</b> (${s.by_status.CLEARED.count})</div>
    <div><small>BOUNCED</small><b>${esc(formatMoney(s.by_status.BOUNCED.amount))}</b> (${s.by_status.BOUNCED.count})</div>
  </div>
  <div class="foot"><span>${data.truncated ? `Truncated to the first ${data.rows.length} cheques.` : ''}</span><span>Generated ${esc(new Date().toLocaleString())}</span></div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };</script>
</body></html>`;
}
