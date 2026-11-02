// Accounts → Reports → Accounts Activity: every entry on the books in one place.
// - Journal Register: one row per journal (vouchers, automated postings, reversals) from
//   /api/financial/reports/accounts-activity/, expandable to its debit / credit lines, with Show Bill
//   for entries that came from a sale, purchase or receipt.
// - Account Summary (?view=accounts): per ledger opening, period debit / credit and closing.
import React, { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Chip, Collapse, FormControlLabel, Grid, LinearProgress, MenuItem, Paper, Stack, Switch,
  Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, ToggleButton,
  ToggleButtonGroup, Typography,
} from '@mui/material';
import { ChevronRight as ClosedIcon, ExpandMore as OpenIcon, ReceiptLong as BillIcon } from '@mui/icons-material';
import { apiError, finGet } from '../financial/financialApi';
import ShowBillDialog from '../financial/ShowBillDialog';
import { billSourceFor } from '../financial/sourceBills';
import { useBranch } from '../../context/BranchContext';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';
import {
  FilterActions, NAVY, ReportCard, SummaryCard, downloadCsv, esc, fieldSx, filterBarSx, fyStart, head, money, monthStart,
  printCards, printReport, printShell, todayYmd,
} from './reportKit';

const STATUS_COLORS = { POSTED: 'success', REVERSED: 'warning', DRAFT: 'default', PENDING_APPROVAL: 'info' };
const STATUS_LABELS = { POSTED: 'Posted', REVERSED: 'Reversed', DRAFT: 'Draft', PENDING_APPROVAL: 'Pending' };
const TYPES = ['Asset', 'Liability', 'Equity', 'Income', 'Expense'];
const defaultFilters = () => ({
  dateFrom: monthStart(), dateTo: todayYmd(), branch: 'all', voucherType: '', origin: 'all', status: '', account: null,
  accountType: '', includeZero: false, search: '',
});
const params = (view, f, extra = {}) => (view === 'accounts'
  ? { view, date_from: f.dateFrom, date_to: f.dateTo, branch: f.branch, account_type: f.accountType, include_zero: f.includeZero ? 1 : undefined, search: f.search.trim(), ...extra }
  : { date_from: f.dateFrom, date_to: f.dateTo, branch: f.branch, voucher_type: f.voucherType, origin: f.origin, status: f.status, account: f.account?.id, search: f.search.trim(), ...extra });
const ENDPOINT = 'reports/accounts-activity/';
// ShowBillDialog reads ledger-register shaped rows.
const billRowOf = (r) => {
  const [module, event] = (r.source_key || '').split('.');
  return { entry_id: r.id, entry_number: r.voucher_no, source_module: r.origin === 'auto' ? module : '', source_event: event || '',
    reference_id: r.reference_id, source_number: r.reference || r.voucher_no, date: r.date, is_reversal: r.is_reversal };
};

function LinesTable({ row, onShowBill }) {
  const cell = { py: 0.4, fontSize: 12.5 };
  const hasBill = !!billSourceFor(billRowOf(row));
  return (
    <Box sx={{ px: 2, py: 1.5, bgcolor: '#f8fafc', borderTop: '1px dashed #cbd5e1' }}>
      <Stack direction="row" alignItems="center" gap={1} sx={{ mb: 1 }} flexWrap="wrap">
        <Typography variant="caption" color="text.secondary">
          {row.origin_label}{row.branch ? ` · ${row.branch}` : ''}{row.created_by ? ` · Entered by ${row.created_by}` : ''}
          {row.reversed_by ? ` · Reversed by ${row.reversed_by}` : ''}{row.reverses ? ` · Reverses ${row.reverses}` : ''}
        </Typography>
        <Button size="small" variant="outlined" startIcon={<BillIcon />} onClick={() => onShowBill(row)} sx={{ ml: 'auto', fontWeight: 700 }}>
          {hasBill ? 'Show Bill' : 'Show Posting'}
        </Button>
      </Stack>
      <Table size="small" sx={{ bgcolor: '#fff', border: '1px solid #e2e8f0', '& .MuiTableCell-root': cell }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 700 }}>Ledger Account</TableCell>
            <TableCell sx={{ fontWeight: 700 }}>Memo</TableCell>
            <TableCell sx={{ fontWeight: 700 }} align="right">Debit</TableCell>
            <TableCell sx={{ fontWeight: 700 }} align="right">Credit</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {row.lines.map((l, i) => (
            <TableRow key={i}>
              <TableCell>{l.code} - {l.name}</TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{l.memo}</TableCell>
              <TableCell align="right">{Number(l.debit) ? money(l.debit) : ''}</TableCell>
              <TableCell align="right">{Number(l.credit) ? money(l.credit) : ''}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

export default function AccountsActivityReport() {
  const { multiBranchEnabled, branches, isAdmin } = useBranch();
  const storeProfile = useStoreProfile();
  const company = companyFromProfile(storeProfile);
  const [view, setView] = useState('register');
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
  const [billRow, setBillRow] = useState(null);

  useEffect(() => {
    finGet('accounts/').then(rows => setAccounts(Array.isArray(rows) ? rows : (rows.results || []))).catch(() => {});
  }, []);
  const accountOptions = useMemo(() => accounts.filter(a => a.status !== 'Inactive'), [accounts]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await finGet(ENDPOINT, params(view, applied, { page: page + 1, page_size: pageSize }));
      setData({ ...res, view });
    } catch (e) {
      setError(apiError(e));
      setData(null);
    }
    setLoading(false);
  }, [view, applied, page, pageSize]);
  useEffect(() => { load(); }, [load]);

  const run = (f) => {
    if (f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) { setError('From date must be on or before To date.'); return; }
    setDraft(f);
    setPage(0);
    setOpen({});
    setApplied({ ...f });
  };
  const switchView = (v) => { if (!v || v === view) return; setData(null); setPage(0); setOpen({}); setView(v); };
  const set = (k) => (e) => setDraft(f => ({ ...f, [k]: e.target.value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const ready = data && data.view === view;
  const s = ready ? data.summary : null;
  const isRegister = view === 'register';
  const rangeLabel = applied.dateFrom === applied.dateTo ? formatDate(applied.dateFrom) : `${formatDate(applied.dateFrom)} to ${formatDate(applied.dateTo)}`;
  const filterLabel = (isRegister ? [
    applied.voucherType && `Type ${applied.voucherType}`,
    applied.origin !== 'all' && (data?.origin_options || []).find(o => o.key === applied.origin)?.label,
    applied.status && STATUS_LABELS[applied.status],
    applied.account && `Ledger ${applied.account.code} - ${applied.account.name}`,
  ] : [applied.accountType && `${applied.accountType} accounts`, applied.includeZero && 'Including idle accounts'])
    .concat([applied.search.trim() && `Search “${applied.search.trim()}”`]).filter(Boolean).join(' · ');

  const fetchAll = async () => {
    const all = await finGet(ENDPOINT, params(view, applied, { export: 1 }));
    if (all.truncated) notify(`Only the first ${all.rows.length.toLocaleString()} rows are included. Narrow the dates for the rest.`, 'warning');
    return all;
  };

  const print = () => {
    setPrinting(true);
    printReport(async () => {
      const all = await fetchAll();
      const sm = all.summary;
      const meta = [['Period', rangeLabel], ['Branch', all.branch?.label || 'All branches'], filterLabel && ['Filter', filterLabel]];
      if (!isRegister) {
        const body = all.rows.map(r => `<tr><td>${esc(r.code)}</td><td>${esc(r.name)}<br><small>${esc(r.group)}</small></td><td>${esc(r.type)}</td>
          <td class="r">${esc(money(r.opening))}</td><td class="r">${esc(money(r.debit))}</td><td class="r">${esc(money(r.credit))}</td>
          <td class="r"><b>${esc(money(r.closing))}</b> ${esc(r.normal)}</td></tr>`).join('');
        return printShell({
          title: 'Account Activity Summary', company, logo: storeProfile.logo_data_url, meta, landscape: false,
          body: `${printCards([['ACCOUNTS', sm.accounts], ['TOTAL DEBIT', money(sm.total_debit)], ['TOTAL CREDIT', money(sm.total_credit)]])}
            <table><thead><tr><th>Code</th><th>Account</th><th>Type</th><th class="r">Opening</th><th class="r">Debit</th><th class="r">Credit</th><th class="r">Closing</th></tr></thead>
            <tbody>${body}<tr class="tot"><td colspan="4">Total</td><td class="r">${esc(money(sm.total_debit))}</td><td class="r">${esc(money(sm.total_credit))}</td><td></td></tr></tbody></table>`,
        });
      }
      const body = all.rows.map(r => `<tr class="${r.status === 'POSTED' ? '' : 'off'}">
        <td>${r.row_no}</td><td class="nw">${esc(formatDate(r.date))}</td>
        <td class="nw"><b>${esc(r.voucher_no)}</b><br><small>${esc(r.voucher_type_name)}${r.status !== 'POSTED' ? ` · ${esc(STATUS_LABELS[r.status] || r.status)}` : ''}${r.is_reversal ? ' · Reversal' : ''}</small></td>
        <td><small>${esc(r.origin_label)}</small></td><td>${esc(r.party)}${r.reference ? `<br><small>${esc(r.reference)}</small>` : ''}</td>
        <td>${r.lines.filter(l => Number(l.debit)).map(l => `${esc(l.name)} <small>${esc(money(l.debit))}</small>`).join('<br>')}</td>
        <td>${r.lines.filter(l => Number(l.credit)).map(l => `${esc(l.name)} <small>${esc(money(l.credit))}</small>`).join('<br>')}</td>
        <td><small>${esc(r.narration)}</small></td><td class="r">${esc(money(r.amount))}</td></tr>`).join('');
      return printShell({
        title: 'Accounts Activity Register', company, logo: storeProfile.logo_data_url, meta,
        body: `${printCards([['ENTRIES', sm.entries], ['MANUAL / AUTOMATED', `${sm.manual} / ${sm.automated}`], ['TOTAL DEBIT', money(sm.total_debit)], ['TOTAL CREDIT', money(sm.total_credit)],
          ...sm.by_type.slice(0, 4).map(t => [`${t.label.toUpperCase()} (${t.count})`, money(t.amount)])])}
          <table><thead><tr><th>#</th><th>Date</th><th>Voucher</th><th>Origin</th><th>Party / Ref</th><th>Debit</th><th>Credit</th><th>Narration</th><th class="r">Amount</th></tr></thead>
          <tbody>${body || '<tr><td colspan="9" style="text-align:center;padding:18px;color:#64748b">No entries for these filters.</td></tr>'}</tbody></table>`,
        footNote: all.truncated ? `Truncated to the first ${all.rows.length} entries.` : '',
      });
    }, (e) => notify(apiError(e, 'Could not prepare the report for printing.'), 'error')).finally(() => setPrinting(false));
  };

  const exportCsv = async () => {
    try {
      const all = await fetchAll();
      if (!isRegister) {
        downloadCsv(`account_activity_${applied.dateFrom}_${applied.dateTo}.csv`,
          ['Code', 'Account', 'Group', 'Type', 'Normal', 'Opening', 'Debit', 'Credit', 'Closing', 'Lines', 'Last Entry'],
          [...all.rows.map(r => [r.code, r.name, r.group, r.type, r.normal, r.opening, r.debit, r.credit, r.closing, r.lines, r.last_date || '']),
            [], ['', 'Total', '', '', '', '', all.summary.total_debit, all.summary.total_credit]]);
        return;
      }
      // One CSV row per ledger line, each carrying its journal's details.
      const lines = [];
      all.rows.forEach(r => r.lines.forEach(l => lines.push([r.row_no, r.date, r.time, r.voucher_no, r.voucher_type_name,
        STATUS_LABELS[r.status] || r.status, r.is_reversal ? 'Yes' : '', r.reverses || r.reversed_by, r.origin_label, r.reference, r.party,
        r.narration, l.code, l.name, l.memo, l.debit, l.credit, r.branch, r.created_by])));
      lines.push([], ['', '', '', '', '', '', '', '', '', '', '', 'Total (posted + reversed)', '', '', '', all.summary.total_debit, all.summary.total_credit]);
      downloadCsv(`accounts_activity_${applied.dateFrom}_${applied.dateTo}.csv`,
        ['#', 'Date', 'Time', 'Voucher No', 'Voucher Type', 'Status', 'Reversal', 'Linked Voucher', 'Origin', 'Reference', 'Party',
          'Narration', 'Ledger Code', 'Ledger Account', 'Line Memo', 'Debit', 'Credit', 'Branch', 'Entered By'], lines);
    } catch (e) {
      notify(apiError(e, 'Could not export the report.'), 'error');
    }
  };

  const toggle = (id) => setOpen(o => ({ ...o, [id]: !o[id] }));
  const regCols = multiBranchEnabled ? 10 : 9;

  return (
    <ReportCard title="Accounts Activity"
      subtitle="Everything posted in Accounts and by the other modules — vouchers, sales, purchases, receipts, stock and reversals — as a journal register, or summarised per ledger with opening and closing balances.">
      <ToggleButtonGroup exclusive size="small" value={view} onChange={(e, v) => switchView(v)} sx={{ mb: 2, bgcolor: '#fff' }}>
        <ToggleButton value="register" sx={{ fontWeight: 700, textTransform: 'none', px: 2 }}>Journal Register</ToggleButton>
        <ToggleButton value="accounts" sx={{ fontWeight: 700, textTransform: 'none', px: 2 }}>Account Summary</ToggleButton>
      </ToggleButtonGroup>

      <Box component="form" onSubmit={(e) => { e.preventDefault(); run(draft); }} sx={filterBarSx}>
        <TextField type="date" size="small" label="From Date" value={draft.dateFrom} onChange={set('dateFrom')} InputLabelProps={{ shrink: true }} sx={{ width: 165, ...fieldSx }} />
        <TextField type="date" size="small" label="To Date" value={draft.dateTo} onChange={set('dateTo')} InputLabelProps={{ shrink: true }} sx={{ width: 165, ...fieldSx }} />
        <Button size="small" onClick={() => run({ ...draft, dateFrom: todayYmd(), dateTo: todayYmd() })} sx={{ fontWeight: 700 }}>Today</Button>
        <Button size="small" onClick={() => run({ ...draft, dateFrom: monthStart(), dateTo: todayYmd() })} sx={{ fontWeight: 700 }}>This Month</Button>
        <Button size="small" onClick={() => run({ ...draft, dateFrom: fyStart(), dateTo: todayYmd() })} sx={{ fontWeight: 700 }}>This FY</Button>
        {multiBranchEnabled && (
          <TextField select size="small" label="Branch" value={draft.branch} onChange={set('branch')} sx={{ minWidth: 160, ...fieldSx }}>
            <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
            {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
        )}
        {isRegister ? (
          <>
            <TextField select size="small" label="Voucher Type" value={draft.voucherType} onChange={set('voucherType')} sx={{ minWidth: 160, ...fieldSx }}>
              <MenuItem value="">All types</MenuItem>
              {(ready ? data.voucher_type_options : []).map(([code, name]) => <MenuItem key={code} value={code}>{code} · {name}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="Origin" value={draft.origin} onChange={set('origin')} sx={{ minWidth: 180, ...fieldSx }}>
              <MenuItem value="all">All entries</MenuItem>
              {(ready ? data.origin_options : []).map(o => <MenuItem key={o.key} value={o.key}>{o.label}</MenuItem>)}
            </TextField>
            <TextField select size="small" label="Status" value={draft.status} onChange={set('status')} sx={{ minWidth: 130, ...fieldSx }}>
              <MenuItem value="">All statuses</MenuItem>
              {Object.entries(STATUS_LABELS).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
            </TextField>
            <Autocomplete size="small" options={accountOptions} value={draft.account}
              onChange={(e, v) => setDraft(f => ({ ...f, account: v ? { id: v.id, code: v.code, name: v.name } : null }))}
              isOptionEqualToValue={(o, v) => o.id === v.id} getOptionLabel={(o) => `${o.code} - ${o.name}`}
              renderInput={(p) => <TextField {...p} label="Ledger Account" sx={fieldSx} />} sx={{ minWidth: 230 }} />
          </>
        ) : (
          <>
            <TextField select size="small" label="Account Type" value={draft.accountType} onChange={set('accountType')} sx={{ minWidth: 150, ...fieldSx }}>
              <MenuItem value="">All types</MenuItem>
              {TYPES.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
            </TextField>
            <FormControlLabel control={<Switch size="small" checked={draft.includeZero} onChange={(e) => setDraft(f => ({ ...f, includeZero: e.target.checked }))} />}
              label={<Typography variant="body2" fontWeight={600}>Show idle accounts</Typography>} />
          </>
        )}
        <TextField size="small" label="Search" placeholder={isRegister ? 'Voucher, party, narration, ledger…' : 'Code, account, group…'} value={draft.search}
          onChange={set('search')} sx={{ flex: '1 1 200px', minWidth: 180, ...fieldSx }} />
        <FilterActions dirty={dirty} onReset={() => run(defaultFilters())} onPrint={print} onCsv={exportCsv} busy={printing} ready={ready} />
      </Box>
      {ready && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          {data.branch?.label} · {rangeLabel}{filterLabel ? ` · ${filterLabel}` : ''}
        </Typography>
      )}
      {loading && <LinearProgress sx={{ mb: 1 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {isRegister ? (
        <>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid item xs={6} md={3}><SummaryCard label="ENTRIES" value={s?.entries} plain hint={s ? `${s.reversals} reversal${s.reversals === 1 ? '' : 's'}` : ''} /></Grid>
            <Grid item xs={6} md={3}><SummaryCard label="MANUAL / AUTOMATED" value={s ? `${s.manual} / ${s.automated}` : '0 / 0'} plain accent="#7c3aed" color="#5b21b6" /></Grid>
            <Grid item xs={6} md={3}><SummaryCard label="TOTAL DEBIT" value={s?.total_debit} accent="#0369a1" color="#0369a1" /></Grid>
            <Grid item xs={6} md={3}><SummaryCard label="TOTAL CREDIT" value={s?.total_credit} accent={s && !s.balanced ? '#dc2626' : '#16a34a'}
              color={s && !s.balanced ? '#b91c1c' : '#166534'} hint={s ? (s.balanced ? 'Debits = Credits' : 'Debits and credits differ!') : ''} /></Grid>
          </Grid>
          {s?.by_type?.length > 0 && (
            <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>BY VOUCHER TYPE (CLICK TO FILTER)</Typography>
              <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 0.75 }}>
                {s.by_type.map(t => (
                  <Box key={t.code || t.label} onClick={() => t.code && run({ ...draft, voucherType: draft.voucherType === t.code ? '' : t.code })}
                    sx={{ px: 1.5, py: 0.75, borderRadius: 1.5, border: '1px solid #cbd5e1', minWidth: 130, cursor: t.code ? 'pointer' : 'default',
                      bgcolor: applied.voucherType === t.code ? '#eef2ff' : '#fff' }}>
                    <Typography variant="body2" fontWeight={800}>{t.label} <Typography component="span" variant="caption" color="text.secondary">({t.count})</Typography></Typography>
                    <Typography variant="caption" fontWeight={700}>{money(t.amount)}</Typography>
                  </Box>
                ))}
              </Stack>
            </Paper>
          )}
          <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '64vh' }}>
            <Table size="small" stickyHeader aria-label="Journal register" sx={{ minWidth: 1150, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 } }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={head} width={36} />
                  <TableCell sx={head} width={40}>#</TableCell>
                  <TableCell sx={head}>Date</TableCell>
                  <TableCell sx={head}>Voucher No</TableCell>
                  {multiBranchEnabled && <TableCell sx={head}>Branch</TableCell>}
                  <TableCell sx={head}>Party / Reference</TableCell>
                  <TableCell sx={head}>Debit</TableCell>
                  <TableCell sx={head}>Credit</TableCell>
                  <TableCell sx={head}>Narration</TableCell>
                  <TableCell sx={head} align="right">Amount</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {!loading && ready && data.rows.length === 0 && (
                  <TableRow><TableCell colSpan={regCols} align="center" sx={{ py: 6, color: 'text.secondary' }}>No entries match these filters.</TableCell></TableRow>
                )}
                {(ready ? data.rows : []).map(r => {
                  const isOpen = !!open[r.id];
                  return (
                    <Fragment key={r.id}>
                      <TableRow hover tabIndex={0} onClick={() => toggle(r.id)}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(r.id); } }}
                        sx={{ cursor: 'pointer', '& > td': { borderBottom: isOpen ? 'none' : undefined }, opacity: r.status === 'POSTED' ? 1 : 0.7 }}>
                        <TableCell>{isOpen ? <OpenIcon fontSize="small" /> : <ClosedIcon fontSize="small" />}</TableCell>
                        <TableCell>{r.row_no}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(r.date)}<Typography variant="caption" color="text.secondary" display="block">{r.time}</Typography></TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          <Typography variant="body2" fontFamily="monospace" fontWeight={700} color="primary.main">{r.voucher_no}</Typography>
                          <Stack direction="row" gap={0.5} sx={{ mt: 0.25 }}>
                            <Chip size="small" variant="outlined" label={r.voucher_type || 'JV'} title={r.voucher_type_name} sx={{ height: 18, fontSize: 10.5 }} />
                            {r.origin === 'auto' && <Chip size="small" variant="outlined" color="info" label={r.origin_label} sx={{ height: 18, fontSize: 10.5 }} />}
                            {r.status !== 'POSTED' && <Chip size="small" color={STATUS_COLORS[r.status]} label={STATUS_LABELS[r.status] || r.status} sx={{ height: 18, fontSize: 10.5 }} />}
                            {r.is_reversal && <Chip size="small" color="warning" label="Reversal" sx={{ height: 18, fontSize: 10.5 }} />}
                          </Stack>
                        </TableCell>
                        {multiBranchEnabled && <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.branch || '—'}</TableCell>}
                        <TableCell sx={{ maxWidth: 190 }}>
                          <Typography variant="body2" fontWeight={600} noWrap title={r.party}>{r.party || '—'}</Typography>
                          {r.reference && <Typography variant="caption" color="text.secondary">{r.reference}</Typography>}
                        </TableCell>
                        <TableCell sx={{ maxWidth: 200 }}><Typography variant="body2" noWrap title={r.debit_accounts.join(', ')}>{r.debit_accounts.join(', ') || '—'}</Typography></TableCell>
                        <TableCell sx={{ maxWidth: 200 }}><Typography variant="body2" noWrap title={r.credit_accounts.join(', ')}>{r.credit_accounts.join(', ') || '—'}</Typography></TableCell>
                        <TableCell sx={{ maxWidth: 240 }}><Typography variant="body2" noWrap color="text.secondary" title={r.narration}>{r.narration || '—'}</Typography></TableCell>
                        <TableCell align="right" sx={{ fontWeight: 800, whiteSpace: 'nowrap', textDecoration: r.status === 'REVERSED' ? 'line-through' : 'none' }}>{money(r.amount)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell colSpan={regCols} sx={{ p: 0, borderBottom: isOpen ? undefined : 'none' }}>
                          <Collapse in={isOpen} unmountOnExit><LinesTable row={r} onShowBill={(row) => setBillRow(billRowOf(row))} /></Collapse>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      ) : (
        <>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid item xs={6} md={3}><SummaryCard label="ACCOUNTS" value={s?.accounts} plain hint={s ? `${s.active} with entries in the period` : ''} /></Grid>
            <Grid item xs={6} md={3}><SummaryCard label="PERIOD DEBIT" value={s?.total_debit} accent="#0369a1" color="#0369a1" /></Grid>
            <Grid item xs={6} md={3}><SummaryCard label="PERIOD CREDIT" value={s?.total_credit} accent="#16a34a" color="#166534" /></Grid>
            <Grid item xs={6} md={3}>
              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, height: '100%' }}>
                <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>BY TYPE (DR / CR)</Typography>
                {(s?.by_type || []).map(t => (
                  <Typography key={t.type} variant="caption" display="block"><b>{t.type}</b> {money(t.debit)} / {money(t.credit)}</Typography>
                ))}
              </Paper>
            </Grid>
          </Grid>
          <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '64vh' }}>
            <Table size="small" stickyHeader aria-label="Account summary" sx={{ minWidth: 900, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 } }}>
              <TableHead>
                <TableRow>
                  {['Code', 'Account', 'Group', 'Type'].map(h => <TableCell key={h} sx={head}>{h}</TableCell>)}
                  {['Opening', 'Debit', 'Credit', 'Closing'].map(h => <TableCell key={h} sx={head} align="right">{h}</TableCell>)}
                  <TableCell sx={head} align="right">Entries</TableCell>
                  <TableCell sx={head}>Last Entry</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {!loading && ready && data.rows.length === 0 && (
                  <TableRow><TableCell colSpan={10} align="center" sx={{ py: 6, color: 'text.secondary' }}>No ledger activity for these filters.</TableCell></TableRow>
                )}
                {(ready ? data.rows : []).map(r => (
                  <TableRow key={r.account_id} hover>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{r.code}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{r.name}</TableCell>
                    <TableCell sx={{ color: 'text.secondary' }}>{r.group}</TableCell>
                    <TableCell>{r.type}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap', color: Number(r.opening) < 0 ? '#b91c1c' : undefined }}>{money(r.opening)}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{Number(r.debit) ? money(r.debit) : '—'}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{Number(r.credit) ? money(r.credit) : '—'}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap', fontWeight: 800, color: Number(r.closing) < 0 ? '#b91c1c' : NAVY }}>
                      {money(r.closing)} <Typography component="span" variant="caption" color="text.secondary">{r.normal}</Typography>
                    </TableCell>
                    <TableCell align="right">{r.lines || '—'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.last_date ? formatDate(r.last_date) : '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </>
      )}
      <TablePagination component="div" count={ready ? data.count : 0} page={ready ? page : 0} onPageChange={(e, p) => setPage(p)}
        rowsPerPage={pageSize} onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }}
        rowsPerPageOptions={[25, 50, 100, 200]} />
      <ShowBillDialog row={billRow} onClose={() => setBillRow(null)} />
    </ReportCard>
  );
}
