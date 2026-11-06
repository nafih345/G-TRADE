// Accounts → Reports → Payment / Receipt / Contra / Journal Voucher Report.
// One row per PV / RV / CV / JV journal from /api/financial/reports/vouchers/. PV / RV rows show the
// ledger accounts paid or received against and each pay mode; CV / JV rows (`split`) show the debit
// and credit sides instead (Contra: transferred to / from). Party and Reference No on every row. Reversed vouchers stay listed (marked
// REVERSED) but are left out of the totals; the summary covers every matching row, not one page.
import React, { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Card, Chip, Collapse, Grid, IconButton, LinearProgress, MenuItem, Paper, Stack, Table,
  TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  ChevronRight as ClosedIcon, ExpandMore as OpenIcon, FilterAlt as ApplyIcon, RestartAlt as ResetIcon, Print as PrintIcon,
  FileDownload as CsvIcon,
} from '@mui/icons-material';
import { apiError, finGet } from '../financial/financialApi';
import { useBranch } from '../../context/BranchContext';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate, formatMoney } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';

const NAVY = '#0f1e3d';
const MODE_COLORS = { Cash: '#15803d', UPI: '#7c3aed', Card: '#0369a1', Bank: '#1d4ed8', Cheque: '#a16207' };
const STATUS_COLORS = { POSTED: 'success', REVERSED: 'warning', DRAFT: 'default', PENDING_APPROVAL: 'info' };
const STATUS_LABELS = { POSTED: 'Posted', REVERSED: 'Reversed', DRAFT: 'Draft', PENDING_APPROVAL: 'Pending' };
const META = {
  PV: { title: 'Payment Voucher Report', accent: '#b91c1c', verb: 'Paid', accountsLabel: 'Paid To (Ledger)', file: 'payment_vouchers' },
  RV: { title: 'Receipt Voucher Report', accent: '#15803d', verb: 'Received', accountsLabel: 'Received Against (Ledger)', file: 'receipt_vouchers' },
  CV: { title: 'Contra Entry Report', accent: '#2563eb', verb: 'Transferred', split: true, debitLabel: 'Transferred To (Dr)', creditLabel: 'Transferred From (Cr)', file: 'contra_entries',
    noun: 'contra entries', about: 'Every Contra Entry (CV) on the books: cash deposited into or withdrawn from a bank, and transfers between cash and bank accounts.' },
  JV: { title: 'Journal Voucher Report', accent: '#7c3aed', verb: 'Adjusted', split: true, debitLabel: 'Debit Accounts', creditLabel: 'Credit Accounts', file: 'journal_vouchers',
    noun: 'journal vouchers', about: 'Every Journal Voucher (JV) on the books: adjustments entered here and journals posted automatically (such as sales returns).' },
};

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = () => { const d = new Date(); return ymd(new Date(d.getFullYear(), d.getMonth(), 1)); };
const defaultFilters = () => ({ dateFrom: monthStart(), dateTo: ymd(new Date()), branch: 'all', origin: 'all', status: '', mode: '', account: null, search: '' });
const money = (v) => (v === null || v === undefined || v === '' ? '' : formatMoney(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const params = (voucher, f, extra = {}) => ({
  voucher, date_from: f.dateFrom, date_to: f.dateTo, branch: f.branch, origin: f.origin, status: f.status, mode: f.mode,
  account: f.account?.id, search: f.search.trim(), ...extra,
});
const accountsText = (list) => list.map(a => `${a.code} - ${a.name}`).join(', ');
const payText = (p) => `${p.mode}${p.mode !== 'Cash' && p.account_name ? ` (${p.account_name})` : ''} ${money(p.amount)}`;

const head = { color: '#3730a3', fontWeight: 700, fontSize: 12.5, whiteSpace: 'nowrap', bgcolor: '#eef2ff', borderBottom: '1px solid #c7d2fe', py: 1.25 };

function SummaryCard({ label, value, color, accent, plain }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, borderLeft: `4px solid ${accent}`, height: '100%' }}>
      <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>{label}</Typography>
      <Typography variant="h6" fontWeight={850} sx={{ color, mt: 0.5 }}>{plain ? value ?? 0 : formatMoney(value || 0)}</Typography>
    </Paper>
  );
}

const PaymentChips = ({ payments }) => (
  <Stack direction="row" flexWrap="wrap" gap={0.5}>
    {payments.length === 0 && <Typography variant="caption" color="text.secondary">—</Typography>}
    {payments.map((p, i) => (
      <Tooltip key={i} title={[p.account_name, p.memo].filter(Boolean).join(' · ')}>
        <Chip size="small" variant="outlined" label={`${p.mode} ${money(p.amount)}`}
          sx={{ height: 22, fontSize: 11.5, fontWeight: 700, color: MODE_COLORS[p.mode], borderColor: MODE_COLORS[p.mode] }} />
      </Tooltip>
    ))}
  </Stack>
);

// First account of a list, with "+N more" under it.
const AccountCell = ({ list }) => (
  <>
    <Typography variant="body2" noWrap title={accountsText(list)}>{list[0] ? `${list[0].code} - ${list[0].name}` : '—'}</Typography>
    {list.length > 1 && <Typography variant="caption" color="text.secondary">+{list.length - 1} more</Typography>}
  </>
);

function SideTable({ label, list }) {
  return (
    <Table size="small" sx={{ bgcolor: '#fff', border: '1px solid #e2e8f0', '& .MuiTableCell-root': { py: 0.4, fontSize: 12.5 } }}>
      <TableHead>
        <TableRow>
          <TableCell sx={{ fontWeight: 700 }}>{label}</TableCell>
          <TableCell sx={{ fontWeight: 700 }}>Memo</TableCell>
          <TableCell sx={{ fontWeight: 700 }} align="right">Amount</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {list.map(a => (
          <TableRow key={a.account_id}>
            <TableCell>{a.code} - {a.name}</TableCell>
            <TableCell sx={{ color: 'text.secondary' }}>{a.memo}</TableCell>
            <TableCell align="right">{money(a.amount)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function VoucherDetails({ row, meta }) {
  const cell = { py: 0.4, fontSize: 12.5 };
  if (meta.split) {
    return (
      <Box sx={{ px: 2, py: 1.5, bgcolor: '#f8fafc', borderTop: '1px dashed #cbd5e1' }}>
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          {row.origin_label}{row.source_number && row.origin === 'auto' ? ` · ${row.source_number}` : ''}
          {row.branch ? ` · ${row.branch}` : ''}{row.created_by ? ` · Entered by ${row.created_by}` : ''}
          {row.reversed_by ? ` · Reversed by ${row.reversed_by}` : ''}
        </Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} md={6}><SideTable label={meta.debitLabel} list={row.debits} /></Grid>
          <Grid item xs={12} md={6}><SideTable label={meta.creditLabel} list={row.credits} /></Grid>
        </Grid>
      </Box>
    );
  }
  return (
    <Box sx={{ px: 2, py: 1.5, bgcolor: '#f8fafc', borderTop: '1px dashed #cbd5e1' }}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        {row.origin_label}{row.source_number && row.origin === 'auto' ? ` · ${row.source_number}` : ''}
        {row.branch ? ` · ${row.branch}` : ''}{row.created_by ? ` · Entered by ${row.created_by}` : ''}
        {row.reversed_by ? ` · Reversed by ${row.reversed_by}` : ''}
      </Typography>
      <Grid container spacing={2}>
        <Grid item xs={12} md={7}>
          <Table size="small" sx={{ bgcolor: '#fff', border: '1px solid #e2e8f0', '& .MuiTableCell-root': cell }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>{meta.accountsLabel}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Memo</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="right">Amount</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {row.accounts.map(a => (
                <TableRow key={a.account_id}>
                  <TableCell>{a.code} - {a.name}</TableCell>
                  <TableCell sx={{ color: 'text.secondary' }}>{a.memo}</TableCell>
                  <TableCell align="right">{money(a.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Grid>
        <Grid item xs={12} md={5}>
          <Table size="small" sx={{ bgcolor: '#fff', border: '1px solid #e2e8f0', '& .MuiTableCell-root': cell }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Pay Mode</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Cash / Bank · Ref</TableCell>
                <TableCell sx={{ fontWeight: 700 }} align="right">Amount</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {row.payments.map((p, i) => (
                <TableRow key={i}>
                  <TableCell sx={{ fontWeight: 700, color: MODE_COLORS[p.mode] }}>{p.mode}</TableCell>
                  <TableCell>{p.account_name}{p.memo ? <Typography component="span" variant="caption" color="text.secondary"> · {p.memo}</Typography> : null}</TableCell>
                  <TableCell align="right">{money(p.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {row.bills.length > 0 && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              Bills settled: {row.bills.map(b => `${b.number} (${money(b.amount)})`).join(', ')}
            </Typography>
          )}
        </Grid>
      </Grid>
    </Box>
  );
}

export default function VoucherReport({ voucher }) {
  const meta = META[voucher];
  const { multiBranchEnabled, branches, isAdmin } = useBranch();
  const storeProfile = useStoreProfile();
  const company = companyFromProfile(storeProfile);
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(defaultFilters);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState({});
  const [printing, setPrinting] = useState(false);
  const [accounts, setAccounts] = useState([]);

  useEffect(() => {
    finGet('accounts/').then(rows => setAccounts(Array.isArray(rows) ? rows : (rows.results || []))).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await finGet('reports/vouchers/', params(voucher, applied, { page: page + 1, page_size: pageSize })));
    } catch (e) {
      setError(apiError(e));
      setData(null);
    }
    setLoading(false);
  }, [voucher, applied, page, pageSize]);
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
  const set = (k) => (e) => setDraft(f => ({ ...f, [k]: e.target.value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const accountOptions = useMemo(() => accounts.filter(a => a.status !== 'Inactive'), [accounts]);

  const rangeLabel = applied.dateFrom === applied.dateTo ? formatDate(applied.dateFrom) : `${formatDate(applied.dateFrom)} to ${formatDate(applied.dateTo)}`;
  const filterLabel = [
    applied.origin === 'manual' && 'Voucher entries only',
    applied.origin === 'auto' && 'Automated postings only',
    applied.status && STATUS_LABELS[applied.status],
    applied.mode && `Pay mode ${applied.mode}`,
    applied.account && `Ledger ${applied.account.code} - ${applied.account.name}`,
    applied.search.trim() && `Search “${applied.search.trim()}”`,
  ].filter(Boolean).join(' · ');

  // Every row for the applied filters (not just this page), for print / CSV.
  const fetchAll = async () => {
    const all = await finGet('reports/vouchers/', params(voucher, applied, { export: 1 }));
    if (all.truncated) notify(`Only the first ${all.rows.length.toLocaleString()} vouchers are included. Narrow the dates for the rest.`, 'warning');
    return all;
  };

  const print = async () => {
    const win = window.open('', '_blank', 'width=1100,height=900');  // open before awaiting, or the pop-up is blocked
    if (!win) { notify('Allow pop-ups to print the report.', 'warning'); return; }
    setPrinting(true);
    try {
      const all = await fetchAll();
      win.document.open();
      win.document.write(printHtml(all, meta, { company, logo: storeProfile.logo_data_url, rangeLabel, filterLabel }));
      win.document.close();
    } catch (e) {
      win.close();
      notify(apiError(e, 'Could not prepare the report for printing.'), 'error');
    }
    setPrinting(false);
  };

  // One CSV row per ledger account line, each carrying its voucher's details.
  const exportCsv = async () => {
    try {
      const all = await fetchAll();
      const header = meta.split
        ? ['#', 'Date', 'Time', 'Voucher No', 'Status', 'Origin', 'Reference No', 'Party', 'Narration',
          'Ledger Code', 'Ledger Account', 'Line Memo', 'Debit', 'Credit', 'Voucher Amount', 'Branch', 'Entered By', 'Reversed By']
        : ['#', 'Date', 'Time', 'Voucher No', 'Status', 'Origin', 'Reference No', 'Party', 'Narration',
          'Ledger Code', 'Ledger Account', 'Line Memo', 'Line Amount', 'Pay Mode(s)', 'Voucher Amount', 'Branch', 'Entered By', 'Reversed By'];
      const lines = [];
      all.rows.forEach((r) => {
        if (meta.split) {
          const base = [r.row_no, r.date, r.time, r.voucher_no, STATUS_LABELS[r.status] || r.status, r.origin_label, r.reference, r.party, r.narration];
          const tail = [r.amount, r.branch, r.created_by, r.reversed_by];
          r.debits.forEach(a => lines.push([...base, a.code, a.name, a.memo, a.amount, '', ...tail]));
          r.credits.forEach(a => lines.push([...base, a.code, a.name, a.memo, '', a.amount, ...tail]));
          return;
        }
        const pays = r.payments.map(payText).join(' | ');
        (r.accounts.length ? r.accounts : [{}]).forEach((a) => lines.push([
          r.row_no, r.date, r.time, r.voucher_no, STATUS_LABELS[r.status] || r.status, r.origin_label, r.reference, r.party,
          r.narration, a.code || '', a.name || '', a.memo || '', a.amount || '', pays, r.amount, r.branch, r.created_by, r.reversed_by]));
      });
      const s = all.summary;
      lines.push([], ['', '', '', '', '', '', '', '', `Total ${meta.verb.toLowerCase()} (${s.posted} posted vouchers)`, '', '', '', '', '', s.total]);
      if (!meta.split) s.by_mode.forEach(m => lines.push(['', '', '', '', '', '', '', '', `${m.mode} (${m.count})`, '', '', '', '', '', m.amount]));
      const csv = [header, ...lines].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `${meta.file}_${applied.dateFrom}_${applied.dateTo}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify(apiError(e, 'Could not export the report.'), 'error');
    }
  };

  const toggle = (id) => setOpen(o => ({ ...o, [id]: !o[id] }));
  const s = data?.summary;
  const cols = multiBranchEnabled ? 11 : 10;

  return (
    <Card variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, py: 2, borderBottom: '1px solid #e2e8f0' }}>
        <Typography variant="h6" fontWeight={850} sx={{ letterSpacing: 0.3, color: NAVY }}>{meta.title.toUpperCase()}</Typography>
        <Typography variant="body2" color="text.secondary">
          {meta.about ? `${meta.about} Click a row for its ledger lines.` : (
            <>Every {voucher === 'PV' ? 'Payment' : 'Receipt'} Voucher ({voucher}) on the books — vouchers entered here and {voucher === 'PV' ? 'supplier payments' : 'receipts from sales, eye tests and wholesale collections'} posted automatically. Click a row for its ledger lines.</>
          )}
        </Typography>
      </Box>

      <Box sx={{ p: { xs: 2, md: 3 }, bgcolor: '#f8fafc' }}>
        <Box component="form" onSubmit={(e) => { e.preventDefault(); run(draft); }}
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 2, '& .MuiButton-root': { flexShrink: 0 } }}>
          <TextField type="date" size="small" label="From Date" value={draft.dateFrom} onChange={set('dateFrom')}
            InputLabelProps={{ shrink: true }} sx={{ width: 165, bgcolor: '#fff' }} />
          <TextField type="date" size="small" label="To Date" value={draft.dateTo} onChange={set('dateTo')}
            InputLabelProps={{ shrink: true }} sx={{ width: 165, bgcolor: '#fff' }} />
          <Button size="small" variant="text" onClick={() => run({ ...draft, dateFrom: ymd(new Date()), dateTo: ymd(new Date()) })} sx={{ fontWeight: 700 }}>Today</Button>
          <Button size="small" variant="text" onClick={() => run({ ...draft, dateFrom: monthStart(), dateTo: ymd(new Date()) })} sx={{ fontWeight: 700 }}>This Month</Button>
          {multiBranchEnabled && (
            <TextField select size="small" label="Branch" value={draft.branch} onChange={set('branch')} sx={{ minWidth: 160, bgcolor: '#fff' }}>
              <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          )}
          <TextField select size="small" label="Origin" value={draft.origin} onChange={set('origin')} sx={{ minWidth: 170, bgcolor: '#fff' }}>
            <MenuItem value="all">All {voucher} entries</MenuItem>
            <MenuItem value="manual">Voucher entries only</MenuItem>
            <MenuItem value="auto">Automated postings</MenuItem>
          </TextField>
          <TextField select size="small" label="Status" value={draft.status} onChange={set('status')} sx={{ minWidth: 130, bgcolor: '#fff' }}>
            <MenuItem value="">All statuses</MenuItem>
            <MenuItem value="POSTED">Posted</MenuItem>
            <MenuItem value="REVERSED">Reversed</MenuItem>
            <MenuItem value="DRAFT">Draft</MenuItem>
          </TextField>
          {!meta.split && (
            <TextField select size="small" label="Payment Mode" value={draft.mode} onChange={set('mode')} sx={{ minWidth: 140, bgcolor: '#fff' }}>
              <MenuItem value="">All modes</MenuItem>
              {(data?.mode_options || ['Cash', 'UPI', 'Card', 'Bank', 'Cheque']).map(m => <MenuItem key={m} value={m}>{m}</MenuItem>)}
            </TextField>
          )}
          <Autocomplete size="small" options={accountOptions} value={draft.account}
            onChange={(e, v) => setDraft(f => ({ ...f, account: v ? { id: v.id, code: v.code, name: v.name } : null }))}
            isOptionEqualToValue={(o, v) => o.id === v.id}
            getOptionLabel={(o) => `${o.code} - ${o.name}`}
            renderInput={(p) => <TextField {...p} label="Ledger Account" sx={{ bgcolor: '#fff' }} />}
            sx={{ minWidth: 230 }} />
          <TextField size="small" label="Search" placeholder="Voucher no, reference, party, narration…" value={draft.search}
            onChange={set('search')} sx={{ flex: '1 1 200px', minWidth: 180, bgcolor: '#fff' }} />
          <Button type="submit" variant="contained" color={dirty ? 'warning' : 'primary'} startIcon={<ApplyIcon />}
            sx={{ fontWeight: 700, whiteSpace: 'nowrap', ...(dirty ? {} : { bgcolor: NAVY }) }}>Apply</Button>
          <Button variant="outlined" startIcon={<ResetIcon />} onClick={() => run(defaultFilters())} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Reset</Button>
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={print} disabled={!data || printing} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Print</Button>
          <Button variant="text" startIcon={<CsvIcon />} onClick={exportCsv} disabled={!data} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>CSV</Button>
        </Box>
        {data && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            {data.branch?.label} · {rangeLabel}{filterLabel ? ` · ${filterLabel}` : ''}
          </Typography>
        )}

        {loading && <LinearProgress sx={{ mb: 1 }} />}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid item xs={6} md={3}><SummaryCard label="VOUCHERS" value={s?.vouchers} color={NAVY} accent="#64748b" plain /></Grid>
          <Grid item xs={6} md={3}><SummaryCard label={`TOTAL ${meta.verb.toUpperCase()}`} value={s?.total} color={meta.accent} accent={meta.accent} /></Grid>
          <Grid item xs={6} md={3}><SummaryCard label="POSTED" value={s?.posted} color="#166534" accent="#16a34a" plain /></Grid>
          <Grid item xs={6} md={3}><SummaryCard label="REVERSED / DRAFT" value={s ? `${s.reversed} / ${s.drafts}` : '0 / 0'} color="#a16207" accent="#d97706" plain /></Grid>
        </Grid>
        {((!meta.split && s?.by_mode?.length > 0) || s?.by_origin?.length > 1) && (
          <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: 2 }}>
            <Stack direction={{ xs: 'column', md: 'row' }} gap={2}>
              {!meta.split && s.by_mode.length > 0 && (
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>BY PAYMENT MODE</Typography>
                  <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 0.75 }}>
                    {s.by_mode.map(m => (
                      <Box key={m.mode} sx={{ px: 1.5, py: 0.75, borderRadius: 1.5, border: `1px solid ${MODE_COLORS[m.mode]}`, minWidth: 130 }}>
                        <Typography variant="body2" fontWeight={800} sx={{ color: MODE_COLORS[m.mode] }}>{m.mode} <Typography component="span" variant="caption" color="text.secondary">({m.count})</Typography></Typography>
                        <Typography variant="caption" display="block" fontWeight={700}>{money(m.amount)}</Typography>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              )}
              {s.by_origin.length > 1 && (
                <Box sx={{ flex: 1 }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>BY ORIGIN</Typography>
                  <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 0.75 }}>
                    {s.by_origin.map(o => (
                      <Box key={o.label} sx={{ px: 1.5, py: 0.75, borderRadius: 1.5, border: '1px solid #cbd5e1', minWidth: 130 }}>
                        <Typography variant="body2" fontWeight={800}>{o.label} <Typography component="span" variant="caption" color="text.secondary">({o.count})</Typography></Typography>
                        <Typography variant="caption" display="block" fontWeight={700}>{money(o.amount)}</Typography>
                      </Box>
                    ))}
                  </Stack>
                </Box>
              )}
            </Stack>
          </Paper>
        )}

        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '64vh' }}>
          <Table size="small" stickyHeader aria-label={meta.title}
            sx={{ minWidth: 1150, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 }, '& .MuiTypography-body2': { fontSize: 13, lineHeight: 1.35 } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={head} width={36} />
                <TableCell sx={head} width={40}>#</TableCell>
                <TableCell sx={head}>Date</TableCell>
                <TableCell sx={head}>Voucher No</TableCell>
                {multiBranchEnabled && <TableCell sx={head}>Branch</TableCell>}
                <TableCell sx={head}>Reference No</TableCell>
                <TableCell sx={head}>Party</TableCell>
                <TableCell sx={head}>{meta.split ? meta.debitLabel : meta.accountsLabel}</TableCell>
                <TableCell sx={head}>{meta.split ? meta.creditLabel : 'Payment Mode'}</TableCell>
                <TableCell sx={head}>Narration</TableCell>
                <TableCell sx={head} align="right">Amount</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!loading && data && data.rows.length === 0 && (
                <TableRow><TableCell colSpan={cols} align="center" sx={{ py: 6, color: 'text.secondary' }}>No {meta.noun || (voucher === 'PV' ? 'payment vouchers' : 'receipt vouchers')} match these filters.</TableCell></TableRow>
              )}
              {(data?.rows || []).map(r => {
                const isOpen = !!open[r.id];
                const inactive = r.status !== 'POSTED';
                return (
                  <Fragment key={r.id}>
                    <TableRow hover tabIndex={0} onClick={() => toggle(r.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(r.id); } }}
                      sx={{ cursor: 'pointer', '& > td': { borderBottom: isOpen ? 'none' : undefined }, opacity: inactive ? 0.7 : 1 }}>
                      <TableCell>{isOpen ? <OpenIcon fontSize="small" /> : <ClosedIcon fontSize="small" />}</TableCell>
                      <TableCell>{r.row_no}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(r.date)}<Typography variant="caption" color="text.secondary" display="block">{r.time}</Typography></TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <Typography variant="body2" fontFamily="monospace" fontWeight={700} color="primary.main">{r.voucher_no}</Typography>
                        <Stack direction="row" gap={0.5} sx={{ mt: 0.25 }}>
                          {r.status !== 'POSTED' && <Chip size="small" color={STATUS_COLORS[r.status]} label={STATUS_LABELS[r.status] || r.status} sx={{ height: 18, fontSize: 10.5, fontWeight: 700 }} />}
                          {r.origin === 'auto' && <Chip size="small" variant="outlined" label="Auto" title={r.origin_label} sx={{ height: 18, fontSize: 10.5 }} />}
                        </Stack>
                      </TableCell>
                      {multiBranchEnabled && <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.branch || '—'}</TableCell>}
                      <TableCell sx={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{r.reference || '—'}</TableCell>
                      <TableCell sx={{ maxWidth: 180 }}><Typography variant="body2" fontWeight={600} noWrap title={r.party}>{r.party || '—'}</Typography></TableCell>
                      <TableCell sx={{ maxWidth: 240 }}><AccountCell list={meta.split ? r.debits : r.accounts} /></TableCell>
                      {meta.split
                        ? <TableCell sx={{ maxWidth: 240 }}><AccountCell list={r.credits} /></TableCell>
                        : <TableCell><PaymentChips payments={r.payments} /></TableCell>}
                      <TableCell sx={{ maxWidth: 260 }}><Typography variant="body2" noWrap title={r.narration} color="text.secondary">{r.narration || '—'}</Typography></TableCell>
                      <TableCell align="right" sx={{ fontWeight: 800, whiteSpace: 'nowrap', textDecoration: r.status === 'REVERSED' ? 'line-through' : 'none' }}>{money(r.amount)}</TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={cols} sx={{ p: 0, borderBottom: isOpen ? undefined : 'none' }}>
                        <Collapse in={isOpen} unmountOnExit><VoucherDetails row={r} meta={meta} /></Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination component="div" count={data?.count || 0} page={data ? page : 0} onPageChange={(e, p) => setPage(p)}
          rowsPerPage={pageSize} onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }}
          rowsPerPageOptions={[25, 50, 100, 200]} />
      </Box>
    </Card>
  );
}

const sideHtml = (list) => list.map(a => `${esc(a.code)} - ${esc(a.name)}${list.length > 1 ? ` <small>${esc(money(a.amount))}</small>` : ''}`).join('<br>');

function printHtml(data, meta, { company, logo, rangeLabel, filterLabel }) {
  const s = data.summary;
  const withBranch = data.rows.some(r => r.branch);
  const body = data.rows.map(r => `
    <tr class="${r.status !== 'POSTED' ? 'off' : ''}">
      <td>${r.row_no}</td><td class="nw">${esc(formatDate(r.date))}</td>
      <td class="nw"><b>${esc(r.voucher_no)}</b>${r.status !== 'POSTED' ? `<br><small>${esc(STATUS_LABELS[r.status] || r.status)}${r.reversed_by ? ` by ${esc(r.reversed_by)}` : ''}</small>` : ''}</td>
      ${withBranch ? `<td>${esc(r.branch)}</td>` : ''}
      <td>${esc(r.reference)}</td><td>${esc(r.party)}</td>
      ${meta.split
    ? `<td>${sideHtml(r.debits)}</td><td>${sideHtml(r.credits)}</td>`
    : `<td>${sideHtml(r.accounts)}</td>
      <td>${r.payments.map(p => `<span style="color:${MODE_COLORS[p.mode]}">${esc(payText(p))}</span>`).join('<br>')}</td>`}
      <td><small>${esc(r.narration)}</small></td>
      <td class="r">${esc(money(r.amount))}</td>
    </tr>`).join('');
  const cols = withBranch ? 10 : 9;
  const modes = meta.split ? '' : s.by_mode.map(m => `<div><small>${esc(m.mode.toUpperCase())} (${m.count})</small><b>${esc(money(m.amount))}</b></div>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title)} ${esc(rangeLabel)}</title>
<style>
  @page { size: A4 landscape; margin: 10mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; font-size: 10.5px; margin: 0; }
  .hdr { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid ${NAVY}; padding-bottom: 8px; margin-bottom: 10px; }
  .hdr img { max-height: 54px; max-width: 140px; object-fit: contain; }
  .hdr h1 { font-size: 18px; margin: 0; } .hdr p { margin: 2px 0 0; color: #475569; }
  h2 { font-size: 14px; margin: 0 0 4px; letter-spacing: .3px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 22px; margin-bottom: 8px; color: #334155; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #eef2ff; color: #3730a3; border-bottom: 1px solid #c7d2fe; text-align: left; padding: 5px 6px; font-size: 10px; }
  td { padding: 4px 6px; vertical-align: top; border-top: 1px solid #cbd5e1; }
  tr { page-break-inside: avoid; } tr.off td { color: #94a3b8; }
  .r { text-align: right; white-space: nowrap; } .nw { white-space: nowrap; }
  .tot td { border-top: 2px solid ${NAVY}; font-weight: 800; padding-top: 6px; }
  .modes { display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px; margin-top: 12px; }
  .modes div { border: 1px dashed #cbd5e1; border-radius: 6px; padding: 5px 8px; }
  .modes small { display: block; color: #64748b; font-weight: 700; }
  .foot { margin-top: 10px; color: #64748b; font-size: 9.5px; display: flex; justify-content: space-between; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style></head><body>
  <div class="hdr">
    ${logo ? `<img src="${esc(logo)}" alt="">` : ''}
    <div><h1>${esc(company.name || meta.title)}</h1>
      <p>${esc(company.address)}${company.phone ? ` · Ph: ${esc(company.phone)}` : ''}${company.gstin ? ` · GSTIN: ${esc(company.gstin)}` : ''}</p></div>
  </div>
  <h2>${esc(meta.title.toUpperCase())}</h2>
  <div class="meta">
    <span><b>Period:</b> ${esc(rangeLabel)}</span>
    <span><b>Branch:</b> ${esc(data.branch?.label || 'All branches')}</span>
    ${filterLabel ? `<span><b>Filter:</b> ${esc(filterLabel)}</span>` : ''}
  </div>
  <table>
    <thead><tr><th>#</th><th>Date</th><th>Voucher No</th>${withBranch ? '<th>Branch</th>' : ''}<th>Reference</th><th>Party</th>
      <th>${esc(meta.split ? meta.debitLabel : meta.accountsLabel)}</th><th>${esc(meta.split ? meta.creditLabel : 'Pay Mode')}</th><th>Narration</th><th class="r">Amount</th></tr></thead>
    <tbody>
      ${body || `<tr><td colspan="${cols}" style="text-align:center;padding:18px;color:#64748b">No vouchers for these filters.</td></tr>`}
      ${data.rows.length ? `<tr class="tot"><td colspan="${cols - 1}">Total ${esc(meta.verb.toLowerCase())} · ${s.posted} posted voucher${s.posted === 1 ? '' : 's'}${s.reversed ? ` (${s.reversed} reversed not counted)` : ''}</td><td class="r">${esc(money(s.total))}</td></tr>` : ''}
    </tbody>
  </table>
  ${modes ? `<div class="modes">${modes}</div>` : ''}
  <div class="foot"><span>${data.truncated ? `Truncated to the first ${data.rows.length} vouchers.` : ''}</span>
    <span>Generated ${esc(new Date().toLocaleString())}</span></div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };</script>
</body></html>`;
}
