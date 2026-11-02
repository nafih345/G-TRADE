// Financial → Day Book: every posted transaction of the chosen day(s), read from the ledger by
// GET /api/financial/reports/daybook/. The server groups a bill with the receipts taken against it
// that day (a split payment = one receipt per pay mode, each listed under the bill; the unpaid
// rest shows as Credit) and works out the payment modes from the money lines. This screen never
// edits a posting; a voucher opens the source bill read-only in ShowBillDialog.
import React, { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, Checkbox, Chip, Collapse, FormControlLabel, Grid, IconButton, LinearProgress, MenuItem,
  Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField,
  Tooltip, Typography,
} from '@mui/material';
import {
  Print as PrintIcon, FilterAlt as ApplyIcon, RestartAlt as ResetIcon, FileDownload as CsvIcon,
  ChevronLeft as PrevIcon, ChevronRight as NextIcon, KeyboardArrowDown as OpenIcon, KeyboardArrowUp as CloseIcon,
  ReceiptLong as BillIcon, UnfoldMore as ExpandAllIcon, UnfoldLess as CollapseAllIcon,
} from '@mui/icons-material';
import { apiError, finGet } from './financialApi';
import ShowBillDialog from './ShowBillDialog';
import { useBranch } from '../../context/BranchContext';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate, formatMoney } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';

const NAVY = '#0f1e3d';
const IN_COLOR = '#15803d';
const OUT_COLOR = '#b91c1c';

// Transaction kind -> badge colours (text, background). Kinds come from financial/daybook.py.
const KIND_STYLES = {
  SALE: ['#166534', '#dcfce7'],
  WHOLESALE_SALE: ['#166534', '#d1fae5'],
  RECEIPT: ['#0f766e', '#ccfbf1'],
  ADVANCE: ['#0e7490', '#cffafe'],
  REFUND: ['#b91c1c', '#fee2e2'],
  EYE_TEST_FEE: ['#7c3aed', '#ede9fe'],
  WHOLESALE_COLLECTION: ['#0f766e', '#ccfbf1'],
  SALES_RETURN: ['#be123c', '#ffe4e6'],
  PURCHASE: ['#9a3412', '#ffedd5'],
  PURCHASE_PAYMENT: ['#c2410c', '#ffedd5'],
  STOCK: ['#475569', '#f1f5f9'],
  RECEIPT_VOUCHER: ['#0369a1', '#e0f2fe'],
  PAYMENT_VOUCHER: ['#b45309', '#fef3c7'],
  CONTRA: ['#3730a3', '#e0e7ff'],
  JOURNAL: ['#334155', '#e2e8f0'],
  OPENING: ['#334155', '#e2e8f0'],
};
const MODE_COLORS = { Cash: '#15803d', UPI: '#7c3aed', Card: '#0369a1', Bank: '#1d4ed8', Cheque: '#a16207', Credit: '#b91c1c' };

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const shiftDay = (s, days) => { const d = new Date(`${s}T00:00:00`); d.setDate(d.getDate() + days); return ymd(d); };
const defaultFilters = () => {
  const t = ymd(new Date());
  return { dateFrom: t, dateTo: t, branch: 'all', kind: '', mode: '', search: '', showReversed: false };
};
const money = (v) => (v === null || v === undefined || v === '' ? '' : formatMoney(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const params = (f, extra = {}) => ({
  date_from: f.dateFrom, date_to: f.dateTo, branch: f.branch, kind: f.kind, mode: f.mode,
  search: f.search.trim(), show_reversed: f.showReversed ? 1 : '', ...extra,
});

// "Cash ₹600 · UPI ₹300" — the in / out side of each payment line.
const payText = (p) => `${p.mode}${p.mode === 'Bank' && p.account_name ? ` (${p.account_name})` : ''} ${money(p.amount_in || p.amount_out)}${p.amount_out && p.mode !== 'Credit' ? ' out' : ''}`;

const KindBadge = ({ row }) => {
  const [fg, bg] = KIND_STYLES[row.kind] || KIND_STYLES.JOURNAL;
  return (
    <Box component="span" sx={{ display: 'inline-block', px: 1, py: 0.25, borderRadius: 1, fontSize: 11.5, fontWeight: 700, color: fg, bgcolor: bg, whiteSpace: 'nowrap' }}>
      {row.kind_label}
    </Box>
  );
};

const PaymentChips = ({ payments }) => (
  <Stack direction="row" flexWrap="wrap" gap={0.5}>
    {payments.length === 0 && <Typography variant="caption" color="text.secondary">No money moved</Typography>}
    {payments.map((p, i) => (
      <Tooltip key={i} title={[p.account_name, p.references?.length ? `Receipt ${p.references.join(', ')}` : ''].filter(Boolean).join(' · ')}>
        <Chip size="small" variant="outlined" label={payText(p)}
          sx={{ height: 22, fontSize: 11.5, fontWeight: 700, color: MODE_COLORS[p.mode], borderColor: MODE_COLORS[p.mode] }} />
      </Tooltip>
    ))}
  </Stack>
);

const head = { color: '#3730a3', fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap', bgcolor: '#eef2ff', borderBottom: '1px solid #c7d2fe', py: 1.25 };

function SummaryCard({ label, value, color, accent, plain }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, borderLeft: `4px solid ${accent}`, height: '100%' }}>
      <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>{label}</Typography>
      <Typography variant="h6" fontWeight={850} sx={{ color, mt: 0.5 }}>{plain ? value ?? 0 : formatMoney(value || 0)}</Typography>
    </Paper>
  );
}

// The journals behind one transaction, with every ledger line.
function EntryDetails({ row, onShowBill }) {
  return (
    <Box sx={{ px: 2, py: 1.5, bgcolor: '#f8fafc', borderTop: '1px dashed #cbd5e1' }}>
      {row.paid_earlier && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          {money(row.paid_earlier)} was received against this bill before this date (advance), so it is not counted as credit.
        </Typography>
      )}
      {row.entries.map((e) => (
        <Box key={e.entry_id} sx={{ mb: 1.5, '&:last-child': { mb: 0 } }}>
          <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap" sx={{ mb: 0.5 }}>
            <Typography variant="body2" fontFamily="monospace" fontWeight={700} color={e.is_reversal ? 'warning.main' : 'primary.main'}>{e.entry_number}</Typography>
            <Typography variant="caption" color="text.secondary">{e.time} · {e.source_label}{e.source_number ? ` · ${e.source_number}` : ''}</Typography>
            {(e.is_reversal || e.status === 'REVERSED') && <Chip size="small" color="warning" variant="outlined" label={e.is_reversal ? 'Reversal' : 'Reversed'} sx={{ height: 20, fontSize: 11 }} />}
            <Button size="small" startIcon={<BillIcon fontSize="small" />} onClick={() => onShowBill(e)} sx={{ ml: 'auto', py: 0, fontWeight: 700 }}>Show</Button>
          </Stack>
          {e.narration && <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 0.5 }}>{e.narration}</Typography>}
          <Table size="small" sx={{ bgcolor: '#fff', border: '1px solid #e2e8f0', '& .MuiTableCell-root': { py: 0.4, fontSize: 12.5 } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Account</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Memo</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Pay Mode</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="right">Debit</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="right">Credit</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {e.lines.map((l, i) => (
                <TableRow key={i}>
                  <TableCell>{l.account_code} - {l.account_name}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{l.memo}</TableCell>
                  <TableCell sx={{ fontWeight: 700, color: MODE_COLORS[l.mode] }}>{l.mode || ''}</TableCell>
                  <TableCell align="right">{money(l.debit)}</TableCell>
                  <TableCell align="right">{money(l.credit)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
      ))}
    </Box>
  );
}

export default function DayBookPanel() {
  const { multiBranchEnabled, branches, isAdmin } = useBranch();
  const storeProfile = useStoreProfile();
  const company = companyFromProfile(storeProfile);
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState({});
  const [billRow, setBillRow] = useState(null);
  const [printing, setPrinting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await finGet('reports/daybook/', params(applied, { page: page + 1, page_size: pageSize })));
    } catch (e) {
      setError(apiError(e));
      setData(null);
    }
    setLoading(false);
  }, [applied, page, pageSize]);
  useEffect(() => { load(); }, [load]);

  const run = (f) => {
    if (f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) {
      setError('From date must be on or before To date.');
      return;
    }
    setDraft(f);
    setPage(0);
    setOpen({});
    setApplied({ ...f });
  };
  const apply = () => run(draft);
  const reset = () => run(defaultFilters());
  // Previous / next day: step a single-day view, or start one from the To date.
  const step = (days) => { const d = shiftDay(draft.dateTo || ymd(new Date()), days); run({ ...draft, dateFrom: d, dateTo: d }); };
  const set = (k) => (e) => setDraft(f => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);

  const rangeLabel = applied.dateFrom === applied.dateTo ? formatDate(applied.dateFrom) : `${formatDate(applied.dateFrom)} to ${formatDate(applied.dateTo)}`;
  const kindOptions = data?.kind_options || [];
  const modeOptions = data?.mode_options || ['Cash', 'UPI', 'Card', 'Bank', 'Cheque', 'Credit'];
  const filterLabel = [
    applied.kind && (kindOptions.find(k => k.value === applied.kind)?.label || applied.kind),
    applied.mode && `Paid by ${applied.mode}`,
    applied.search.trim() && `Search “${applied.search.trim()}”`,
  ].filter(Boolean).join(' · ');

  // Every row for the applied filters (not just this page), for print / CSV.
  const fetchAll = async () => {
    const all = await finGet('reports/daybook/', params(applied, { export: 1 }));
    if (all.truncated) notify(`Only the first ${all.rows.length.toLocaleString()} transactions are included. Narrow the dates for the rest.`, 'warning');
    return all;
  };

  const print = async () => {
    const win = window.open('', '_blank', 'width=1100,height=900');  // open before awaiting, or the pop-up is blocked
    if (!win) { notify('Allow pop-ups to print the day book.', 'warning'); return; }
    setPrinting(true);
    try {
      const all = await fetchAll();
      win.document.open();
      win.document.write(printHtml(all, { company, logo: storeProfile.logo_data_url, rangeLabel, filterLabel, branchLabel: all.branch?.label }));
      win.document.close();
    } catch (e) {
      win.close();
      notify(apiError(e, 'Could not prepare the day book for printing.'), 'error');
    }
    setPrinting(false);
  };

  // One CSV row per ledger line, each carrying its transaction's details, so the file is the
  // full breakdown and still sums to debit = credit.
  const exportCsv = async () => {
    try {
      const all = await fetchAll();
      const header = ['#', 'Date', 'Time', 'Branch', 'Type', 'Bill / Ref No.', 'Party', 'Description', 'Bill Amount',
        'Payment Breakdown', 'Money In', 'Money Out', 'Voucher No.', 'Voucher Time', 'Account Code', 'Account', 'Memo',
        'Pay Mode', 'Debit', 'Credit'];
      const lines = [];
      all.rows.forEach((r) => {
        const pays = r.payments.map(payText).join(' | ');
        r.entries.forEach((e) => e.lines.forEach((l) => lines.push([
          r.row_no, r.date, r.time, r.branch_name, r.kind_label, r.reference, r.party, r.description, r.amount, pays,
          r.money_in, r.money_out, e.entry_number, e.time, l.account_code, l.account_name, l.memo, l.mode || '',
          l.debit || '', l.credit || ''])));
      });
      const s = all.summary;
      lines.push([], ['', '', '', '', '', '', '', 'Total', '', '', s.money_in, s.money_out, '', '', '', '', '', '', s.total_debit, s.total_credit]);
      s.by_mode.forEach(m => lines.push(['', '', '', '', '', '', '', `${m.mode} (${m.count})`, '', '', m.amount_in, m.amount_out]));
      const csv = [header, ...lines].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `daybook_${applied.dateFrom}_${applied.dateTo}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify(apiError(e, 'Could not export the day book.'), 'error');
    }
  };

  const toggle = (id) => setOpen(o => ({ ...o, [id]: !o[id] }));
  const allOpen = data?.rows.length > 0 && data.rows.every(r => open[r.id]);
  const toggleAll = () => setOpen(allOpen ? {} : Object.fromEntries((data?.rows || []).map(r => [r.id, true])));
  const onRowKey = (e, r) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(r.id); } };
  const s = data?.summary;
  const multiDay = applied.dateFrom !== applied.dateTo;
  const dayTotals = Object.fromEntries((data?.days || []).map(d => [d.date, d]));
  const cols = multiBranchEnabled ? 10 : 9;

  return (
    <Card variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, py: 2, borderBottom: '1px solid #e2e8f0' }}>
        <Typography variant="h6" fontWeight={850} sx={{ letterSpacing: 0.3, color: NAVY }}>DAY BOOK — ALL TRANSACTIONS</Typography>
        <Typography variant="body2" color="text.secondary">
          Every sale, receipt, payment, purchase and voucher posted for the day, with how it was paid. Split payments are listed under their bill.
        </Typography>
      </Box>

      <Box sx={{ p: { xs: 2, md: 3 }, bgcolor: '#f8fafc' }}>
        <Box component="form" onSubmit={(e) => { e.preventDefault(); apply(); }}
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 2, '& .MuiButton-root': { flexShrink: 0 } }}>
          <Stack direction="row" alignItems="center" gap={0.5}>
            <Tooltip title="Previous day"><IconButton size="small" onClick={() => step(-1)} aria-label="Previous day"><PrevIcon /></IconButton></Tooltip>
            <TextField type="date" size="small" label="From Date" value={draft.dateFrom} onChange={set('dateFrom')}
              InputLabelProps={{ shrink: true }} sx={{ width: 165, bgcolor: '#fff' }} />
            <TextField type="date" size="small" label="To Date" value={draft.dateTo} onChange={set('dateTo')}
              InputLabelProps={{ shrink: true }} sx={{ width: 165, bgcolor: '#fff' }} />
            <Tooltip title="Next day"><IconButton size="small" onClick={() => step(1)} aria-label="Next day"><NextIcon /></IconButton></Tooltip>
          </Stack>
          <Button size="small" variant="text" onClick={() => run({ ...draft, dateFrom: ymd(new Date()), dateTo: ymd(new Date()) })} sx={{ fontWeight: 700 }}>Today</Button>
          {multiBranchEnabled && (
            <TextField select size="small" label="Branch" value={draft.branch} onChange={set('branch')} sx={{ minWidth: 160, bgcolor: '#fff' }}>
              <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          )}
          <TextField select size="small" label="Type" value={draft.kind} onChange={set('kind')} sx={{ minWidth: 170, bgcolor: '#fff' }}>
            <MenuItem value="">All types</MenuItem>
            {kindOptions.map(k => <MenuItem key={k.value} value={k.value}>{k.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Payment Mode" value={draft.mode} onChange={set('mode')} sx={{ minWidth: 150, bgcolor: '#fff' }}>
            <MenuItem value="">All modes</MenuItem>
            {modeOptions.map(m => <MenuItem key={m} value={m}>{m}</MenuItem>)}
          </TextField>
          <TextField size="small" label="Search" placeholder="Bill no, party, account, description…" value={draft.search}
            onChange={set('search')} sx={{ flex: '1 1 200px', minWidth: 180, bgcolor: '#fff' }} />
          <Button type="submit" variant="contained" color={dirty ? 'warning' : 'primary'} startIcon={<ApplyIcon />}
            sx={{ fontWeight: 700, whiteSpace: 'nowrap', ...(dirty ? {} : { bgcolor: NAVY }) }}>Apply</Button>
          <Button variant="outlined" startIcon={<ResetIcon />} onClick={reset} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Reset</Button>
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={print} disabled={!data || printing} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Print</Button>
          <Button variant="text" startIcon={<CsvIcon />} onClick={exportCsv} disabled={!data} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>CSV</Button>
        </Box>
        <Stack direction="row" alignItems="center" justifyContent="space-between" flexWrap="wrap" gap={1} sx={{ mb: 1 }}>
          <Stack direction="row" alignItems="center" gap={1}>
            <FormControlLabel control={<Checkbox size="small" checked={draft.showReversed} onChange={set('showReversed')} />}
              label={<Typography variant="body2">Show reversed / voided entries</Typography>} />
            <Button size="small" startIcon={allOpen ? <CollapseAllIcon /> : <ExpandAllIcon />} onClick={toggleAll} disabled={!data?.rows.length} sx={{ fontWeight: 700 }}>
              {allOpen ? 'Collapse all' : 'Expand all'}
            </Button>
          </Stack>
          {data && (
            <Typography variant="caption" color="text.secondary">
              {data.branch?.label} · {rangeLabel}{filterLabel ? ` · ${filterLabel}` : ''}
              {s?.hidden_reversals ? ` · ${s.hidden_reversals} reversed entries hidden (they net to zero)` : ''}
            </Typography>
          )}
        </Stack>

        {loading && <LinearProgress sx={{ mb: 1 }} />}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {data?.posting_failures > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {data.posting_failures} document{data.posting_failures === 1 ? '' : 's'} could not be posted to the books and {data.posting_failures === 1 ? 'is' : 'are'} missing from the Day Book. Fix them under Accounting Integration → Failures.
          </Alert>
        )}

        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid item xs={6} md={2.4}><SummaryCard label="TRANSACTIONS" value={s?.transactions} color={NAVY} accent="#64748b" plain /></Grid>
          <Grid item xs={6} md={2.4}><SummaryCard label="TOTAL SALES" value={s?.sales_total} color="#166534" accent="#16a34a" /></Grid>
          <Grid item xs={6} md={2.4}><SummaryCard label="MONEY IN" value={s?.money_in} color={IN_COLOR} accent={IN_COLOR} /></Grid>
          <Grid item xs={6} md={2.4}><SummaryCard label="MONEY OUT" value={s?.money_out} color={OUT_COLOR} accent={OUT_COLOR} /></Grid>
          <Grid item xs={12} md={2.4}><SummaryCard label="NET (IN − OUT)" value={s?.net_money} color={NAVY} accent={NAVY} /></Grid>
        </Grid>
        {s?.by_mode?.length > 0 && (
          <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: 2 }}>
            <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>BY PAYMENT MODE</Typography>
            <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 0.75 }}>
              {s.by_mode.map(m => (
                <Box key={m.mode} sx={{ px: 1.5, py: 0.75, borderRadius: 1.5, border: `1px solid ${MODE_COLORS[m.mode]}`, minWidth: 150 }}>
                  <Typography variant="body2" fontWeight={800} sx={{ color: MODE_COLORS[m.mode] }}>{m.mode} <Typography component="span" variant="caption" color="text.secondary">({m.count})</Typography></Typography>
                  <Typography variant="caption" display="block">
                    {m.mode === 'Credit' ? 'Unpaid' : 'In'} <b style={{ color: IN_COLOR }}>{money(m.amount_in)}</b>
                    {parseFloat(m.amount_out) ? <> · {m.mode === 'Credit' ? 'Owed' : 'Out'} <b style={{ color: OUT_COLOR }}>{money(m.amount_out)}</b></> : null}
                  </Typography>
                </Box>
              ))}
            </Stack>
          </Paper>
        )}

        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '64vh' }}>
          <Table size="small" stickyHeader aria-label="Day book transactions"
            sx={{ minWidth: 1100, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 }, '& .MuiTypography-body2': { fontSize: 13, lineHeight: 1.35 } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={head} width={36} />
                <TableCell sx={head} width={40}>#</TableCell>
                <TableCell sx={head}>{multiDay ? 'Date / Time' : 'Time'}</TableCell>
                {multiBranchEnabled && <TableCell sx={head}>Branch</TableCell>}
                <TableCell sx={head}>Type</TableCell>
                <TableCell sx={head}>Bill / Ref No.</TableCell>
                <TableCell sx={head}>Party / Description</TableCell>
                <TableCell sx={head}>Payment Mode</TableCell>
                <TableCell sx={head} align="right">Money In</TableCell>
                <TableCell sx={head} align="right">Money Out</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data && data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={cols} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    {filterLabel ? 'No transactions match these filters.' : 'No transactions were posted for the selected dates.'}
                  </TableCell>
                </TableRow>
              )}
              {data && data.rows.map((r, i) => {
                const newDay = multiDay && (i === 0 || data.rows[i - 1].date !== r.date);
                const day = dayTotals[r.date];
                return (
                  <Fragment key={r.id}>
                    {newDay && (
                      <TableRow sx={{ bgcolor: '#e2e8f0' }}>
                        <TableCell colSpan={cols - 2} sx={{ fontWeight: 800, color: NAVY }}>
                          {formatDate(r.date)} <Typography component="span" variant="caption" color="text.secondary">· {day?.transactions} transactions</Typography>
                        </TableCell>
                        <TableCell align="right" sx={{ fontWeight: 800, color: IN_COLOR }}>{money(day?.money_in)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 800, color: OUT_COLOR }}>{money(day?.money_out)}</TableCell>
                      </TableRow>
                    )}
                    <TableRow hover tabIndex={0} onClick={() => toggle(r.id)} onKeyDown={(e) => onRowKey(e, r)}
                      aria-expanded={!!open[r.id]} aria-label={`${r.kind_label} ${r.reference}, show details`}
                      sx={{ cursor: 'pointer', bgcolor: i % 2 ? '#f8fafc' : '#fff', '& > td': { borderBottom: open[r.id] ? 'none' : undefined }, '&:focus-visible': { outline: `2px solid ${NAVY}`, outlineOffset: -2 } }}>
                      <TableCell><IconButton size="small" tabIndex={-1} aria-hidden>{open[r.id] ? <CloseIcon fontSize="small" /> : <OpenIcon fontSize="small" />}</IconButton></TableCell>
                      <TableCell sx={{ color: 'text.secondary' }}>{r.row_no}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{multiDay && <Typography variant="caption" color="text.secondary" display="block">{formatDate(r.date)}</Typography>}{r.time}</TableCell>
                      {multiBranchEnabled && <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.branch_name || '—'}</TableCell>}
                      <TableCell>
                        <KindBadge row={r} />
                        {r.status !== 'POSTED' && <Chip size="small" color="warning" variant="outlined" label={r.status === 'REVERSAL' ? 'Reversal' : 'Reversed'} sx={{ ml: 0.5, height: 20, fontSize: 11 }} />}
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <Typography variant="body2" fontFamily="monospace" fontWeight={700} color="primary.main">{r.reference}</Typography>
                        <Typography variant="caption" color="text.secondary">{r.entries.length > 1 ? `${r.entries.length} vouchers` : r.entry_number}</Typography>
                      </TableCell>
                      <TableCell sx={{ minWidth: 220, maxWidth: 340 }}>
                        {r.party && <Typography variant="body2" fontWeight={700}>{r.party}</Typography>}
                        <Typography variant="body2" color={r.party ? 'text.secondary' : 'text.primary'}>{r.description}</Typography>
                        {r.amount && ['SALE', 'WHOLESALE_SALE', 'PURCHASE'].includes(r.kind) && (
                          <Typography variant="caption" color="text.secondary">Bill amount {money(r.amount)}</Typography>
                        )}
                      </TableCell>
                      <TableCell sx={{ minWidth: 180 }}><PaymentChips payments={r.payments} /></TableCell>
                      <TableCell align="right" sx={{ color: IN_COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{parseFloat(r.money_in) ? money(r.money_in) : ''}</TableCell>
                      <TableCell align="right" sx={{ color: OUT_COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{parseFloat(r.money_out) ? money(r.money_out) : ''}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={cols} sx={{ p: '0 !important', borderBottom: open[r.id] ? undefined : 'none' }}>
                        <Collapse in={!!open[r.id]} unmountOnExit><EntryDetails row={r} onShowBill={setBillRow} /></Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
              {data && data.rows.length > 0 && (
                <TableRow sx={{ bgcolor: '#eef2f7' }}>
                  <TableCell colSpan={cols - 2} sx={{ fontWeight: 800 }}>
                    {data.matched.filtered ? `Matching rows (${data.matched.count})` : `Total (${data.count} transactions)`}
                    <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                      Debit {money(data.matched.total_debit)} = Credit {money(data.matched.total_credit)}
                    </Typography>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, color: IN_COLOR }}>{money(data.matched.money_in)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, color: OUT_COLOR }}>{money(data.matched.money_out)}</TableCell>
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
        {data?.matched.filtered && (
          <Typography variant="caption" color="text.secondary" display="block">
            Filters narrow the rows listed; the cards above cover every transaction in the period.
          </Typography>
        )}
      </Box>

      <ShowBillDialog row={billRow} onClose={() => setBillRow(null)} />
    </Card>
  );
}

function printHtml(data, { company, logo, rangeLabel, filterLabel, branchLabel }) {
  const s = data.summary;
  const withBranch = data.rows.some(r => r.branch_name);
  const cols = withBranch ? 8 : 7;
  const dayTotals = Object.fromEntries((data.days || []).map(d => [d.date, d]));
  let lastDate = null;
  const body = data.rows.map((r) => {
    let dayHead = '';
    if (r.date !== lastDate) {
      lastDate = r.date;
      const d = dayTotals[r.date];
      dayHead = `<tr class="day"><td colspan="${cols - 2}">${esc(formatDate(r.date))}${d ? ` · ${d.transactions} transactions` : ''}</td>
        <td class="r in">${esc(money(d?.money_in))}</td><td class="r out">${esc(money(d?.money_out))}</td></tr>`;
    }
    const pays = r.payments.map(p => `<span class="pm" style="color:${MODE_COLORS[p.mode]}">${esc(payText(p))}</span>`).join(' ') || '<i>No money moved</i>';
    const lines = r.entries.map(e => `
      <tr class="vh"><td></td><td colspan="${cols - 1}"><b>${esc(e.entry_number)}</b> · ${esc(e.time)} · ${esc(e.source_label)}${e.source_number ? ` · ${esc(e.source_number)}` : ''}${e.is_reversal ? ' · Reversal' : e.status === 'REVERSED' ? ' · Reversed' : ''}${e.narration ? ` — ${esc(e.narration)}` : ''}</td></tr>
      ${e.lines.map(l => `<tr class="ln"><td></td><td colspan="${cols - 3}">${esc(l.account_code)} - ${esc(l.account_name)}${l.memo ? ` <small>(${esc(l.memo)})</small>` : ''}${l.mode ? ` <b style="color:${MODE_COLORS[l.mode]}">[${esc(l.mode)}]</b>` : ''}</td>
        <td class="r">${l.debit ? `Dr ${esc(money(l.debit))}` : ''}</td><td class="r">${l.credit ? `Cr ${esc(money(l.credit))}` : ''}</td></tr>`).join('')}`).join('');
    return `${dayHead}
      <tr class="tx">
        <td>${r.row_no}</td><td class="nw">${esc(r.time)}</td>${withBranch ? `<td>${esc(r.branch_name)}</td>` : ''}
        <td class="nw">${esc(r.kind_label)}${r.status !== 'POSTED' ? ` (${r.status === 'REVERSAL' ? 'Reversal' : 'Reversed'})` : ''}</td>
        <td class="nw"><b>${esc(r.reference)}</b></td>
        <td>${r.party ? `<b>${esc(r.party)}</b><br>` : ''}${esc(r.description)}${['SALE', 'WHOLESALE_SALE', 'PURCHASE'].includes(r.kind) ? `<br><small>Bill amount ${esc(money(r.amount))}</small>` : ''}<div>${pays}</div></td>
        <td class="r in">${parseFloat(r.money_in) ? esc(money(r.money_in)) : ''}</td>
        <td class="r out">${parseFloat(r.money_out) ? esc(money(r.money_out)) : ''}</td>
      </tr>${lines}`;
  }).join('');
  const modes = s.by_mode.map(m => `<div><small>${esc(m.mode.toUpperCase())} (${m.count})</small><b class="in">${esc(money(m.amount_in))}</b>${parseFloat(m.amount_out) ? ` <b class="out">/ ${esc(money(m.amount_out))}</b>` : ''}</div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Day Book ${esc(rangeLabel)}</title>
<style>
  @page { size: A4 portrait; margin: 10mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; font-size: 10.5px; margin: 0; }
  .hdr { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid ${NAVY}; padding-bottom: 8px; margin-bottom: 10px; }
  .hdr img { max-height: 54px; max-width: 140px; object-fit: contain; }
  .hdr h1 { font-size: 18px; margin: 0; } .hdr p { margin: 2px 0 0; color: #475569; }
  h2 { font-size: 14px; margin: 0 0 4px; letter-spacing: .3px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 22px; margin-bottom: 8px; color: #334155; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #eef2ff; color: #3730a3; border-bottom: 1px solid #c7d2fe; text-align: left; padding: 5px 6px; font-size: 10px; }
  td { padding: 3px 6px; vertical-align: top; }
  tr.tx td { border-top: 1px solid #94a3b8; padding-top: 5px; }
  tr.vh td { color: #475569; font-size: 9.5px; padding-top: 3px; }
  tr.ln td { font-size: 9.5px; color: #334155; padding-top: 1px; padding-bottom: 1px; }
  tr.ln td:nth-child(2) { padding-left: 18px; }
  tr.day td { background: #e2e8f0; font-weight: 800; color: ${NAVY}; border-top: 2px solid ${NAVY}; }
  tr { page-break-inside: avoid; }
  .pm { display: inline-block; margin: 2px 8px 0 0; font-weight: 700; }
  .r { text-align: right; white-space: nowrap; } .nw { white-space: nowrap; }
  .in { color: ${IN_COLOR}; } .out { color: ${OUT_COLOR}; }
  .tot td { border-top: 2px solid ${NAVY}; font-weight: 800; padding-top: 6px; }
  .sum { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin: 12px 0 6px; }
  .sum div { border: 1px solid #cbd5e1; border-radius: 6px; padding: 6px 8px; }
  .sum small { display: block; color: #64748b; font-weight: 700; } .sum b { font-size: 13px; }
  .modes { display: grid; grid-template-columns: repeat(6, 1fr); gap: 8px; }
  .modes div { border: 1px dashed #cbd5e1; border-radius: 6px; padding: 5px 8px; }
  .modes small { display: block; color: #64748b; font-weight: 700; }
  .foot { margin-top: 10px; color: #64748b; font-size: 9.5px; display: flex; justify-content: space-between; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style></head><body>
  <div class="hdr">
    ${logo ? `<img src="${esc(logo)}" alt="">` : ''}
    <div><h1>${esc(company.name || 'Day Book')}</h1>
      <p>${esc(company.address)}${company.phone ? ` · Ph: ${esc(company.phone)}` : ''}${company.gstin ? ` · GSTIN: ${esc(company.gstin)}` : ''}</p></div>
  </div>
  <h2>DAY BOOK</h2>
  <div class="meta">
    <span><b>Date:</b> ${esc(rangeLabel)}</span>
    <span><b>Branch:</b> ${esc(branchLabel || 'All branches')}</span>
    ${filterLabel ? `<span><b>Filter:</b> ${esc(filterLabel)}</span>` : ''}
  </div>
  <table>
    <thead><tr><th>#</th><th>Time</th>${withBranch ? '<th>Branch</th>' : ''}<th>Type</th><th>Bill / Ref No.</th><th>Party / Description · Payment</th>
      <th class="r">Money In</th><th class="r">Money Out</th></tr></thead>
    <tbody>
      ${body || `<tr><td colspan="${cols}" style="text-align:center;padding:18px;color:#64748b">No transactions for these dates.</td></tr>`}
      ${data.rows.length ? `<tr class="tot"><td colspan="${cols - 2}">${data.matched.filtered ? `Matching rows (${data.matched.count})` : `Total (${data.count} transactions)`} · Debit ${esc(money(data.matched.total_debit))} = Credit ${esc(money(data.matched.total_credit))}</td>
        <td class="r in">${esc(money(data.matched.money_in))}</td><td class="r out">${esc(money(data.matched.money_out))}</td></tr>` : ''}
    </tbody>
  </table>
  <div class="sum">
    <div><small>TRANSACTIONS</small><b>${s.transactions}</b></div>
    <div><small>TOTAL SALES</small><b>${esc(money(s.sales_total))}</b></div>
    <div><small>MONEY IN</small><b class="in">${esc(money(s.money_in))}</b></div>
    <div><small>MONEY OUT</small><b class="out">${esc(money(s.money_out))}</b></div>
    <div><small>NET (IN − OUT)</small><b>${esc(money(s.net_money))}</b></div>
  </div>
  ${modes ? `<div class="modes">${modes}</div>` : ''}
  <div class="foot"><span>${data.truncated ? `Truncated to the first ${data.rows.length} transactions. ` : ''}${data.matched.filtered ? 'Rows filtered; summary covers every transaction in the period.' : ''}</span>
    <span>Generated ${esc(new Date().toLocaleString())}</span></div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };</script>
</body></html>`;
}
