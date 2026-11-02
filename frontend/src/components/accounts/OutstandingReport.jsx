// Accounts → Reports → Customer Outstanding / Supplier Outstanding (side = receivable | payable).
// One row per party from /api/financial/reports/<customer|supplier>-outstanding/, built from the
// same open bills Bill-to-Bill vouchers settle, so a receipt / payment voucher clears a bill here
// the moment it is saved. Bills are aged from their due date (or the bill date when they have
// none); the ledger cross-check shows what the control accounts carry beyond the open bills.
import React, { Fragment, useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Chip, Collapse, FormControlLabel, Grid, LinearProgress, MenuItem, Paper, Stack, Switch, Table, TableBody,
  TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography,
} from '@mui/material';
import { ChevronRight as ClosedIcon, ExpandMore as OpenIcon } from '@mui/icons-material';
import { apiError, finGet } from '../financial/financialApi';
import { useBranch } from '../../context/BranchContext';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';
import {
  FilterActions, NAVY, ReportCard, SummaryCard, downloadCsv, esc, fieldSx, filterBarSx, head, money, printCards,
  printReport, printShell,
} from './reportKit';

const META = {
  receivable: {
    title: 'Customer Outstanding', path: 'reports/customer-outstanding/', file: 'customer_outstanding', partyLabel: 'Customer / Dealer',
    accent: '#0369a1', paidWord: 'Received', lastWord: 'Last Receipt',
    subtitle: 'What customers and wholesale dealers still owe, bill by bill: unpaid sales invoices and wholesale bills net of receipts, receipt vouchers and credit notes, aged and with their collection status.',
  },
  payable: {
    title: 'Supplier Outstanding', path: 'reports/supplier-outstanding/', file: 'supplier_outstanding', partyLabel: 'Supplier',
    accent: '#b45309', paidWord: 'Paid', lastWord: 'Last Payment',
    subtitle: 'What is still owed to suppliers: purchase bills net of what was paid at entry and of payment vouchers settled against them, with due dates, aging and pending payouts.',
  },
};
const AGING_COLORS = { current: '#15803d', d31_60: '#ca8a04', d61_90: '#ea580c', d90_plus: '#b91c1c' };
const STATUS_COLORS = { Current: 'success', Overdue: 'warning', Critical: 'error' };
const defaultFilters = () => ({ dateFrom: '', dateTo: '', branch: 'all', kind: '', aging: '', overdue: false, search: '' });
const params = (f, extra = {}) => ({
  date_from: f.dateFrom || undefined, date_to: f.dateTo || undefined, branch: f.branch, kind: f.kind, aging: f.aging,
  overdue: f.overdue ? 1 : undefined, search: f.search.trim(), ...extra,
});

function BillsTable({ row, meta }) {
  const cell = { py: 0.4, fontSize: 12.5 };
  return (
    <Box sx={{ px: 2, py: 1.5, bgcolor: '#f8fafc', borderTop: '1px dashed #cbd5e1' }}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
        {row.kind_label}{row.code ? ` · ${row.code}` : ''}{row.mobile ? ` · ${row.mobile}` : ''}{row.area ? ` · ${row.area}` : ''}
        {row.oldest_bill ? ` · Oldest open bill ${formatDate(row.oldest_bill)}` : ''} · {row.collected_pct}% of these bills {meta.paidWord.toLowerCase()}
      </Typography>
      <Table size="small" sx={{ bgcolor: '#fff', border: '1px solid #e2e8f0', '& .MuiTableCell-root': cell }}>
        <TableHead>
          <TableRow>
            {['Bill No', 'Ref', 'Bill Date', 'Due Date', 'Days', 'Ledger', 'Bill Amount', meta.paidWord, 'Balance Due', 'Status'].map((h, i) => (
              <TableCell key={h} sx={{ fontWeight: 700 }} align={i >= 6 && i <= 8 ? 'right' : 'left'}>{h}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {row.bills.map(b => (
            <TableRow key={b.id}>
              <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{b.number}</TableCell>
              <TableCell>{b.ref || '—'}</TableCell>
              <TableCell>{b.date ? formatDate(b.date) : '—'}</TableCell>
              <TableCell>{b.due_date ? formatDate(b.due_date) : '—'}</TableCell>
              <TableCell sx={{ color: AGING_COLORS[b.aging], fontWeight: 700 }}>{b.days}</TableCell>
              <TableCell sx={{ color: 'text.secondary' }}>{b.account}</TableCell>
              <TableCell align="right">{money(b.total)}</TableCell>
              <TableCell align="right">{money(b.paid)}</TableCell>
              <TableCell align="right" sx={{ fontWeight: 800 }}>{money(b.due)}</TableCell>
              <TableCell>
                <Stack direction="row" gap={0.5}>
                  <Chip size="small" variant="outlined" label={b.status} sx={{ height: 20, fontSize: 11 }} />
                  {b.overdue && <Chip size="small" color="error" variant="outlined" label="Overdue" sx={{ height: 20, fontSize: 11 }} />}
                </Stack>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Box>
  );
}

export default function OutstandingReport({ side }) {
  const meta = META[side];
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

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await finGet(meta.path, params(applied, { page: page + 1, page_size: pageSize })));
    } catch (e) {
      setError(apiError(e));
      setData(null);
    }
    setLoading(false);
  }, [meta.path, applied, page, pageSize]);
  useEffect(() => { load(); }, [load]);

  const run = (f) => {
    if (f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) { setError('From date must be on or before To date.'); return; }
    setDraft(f);
    setPage(0);
    setOpen({});
    setApplied({ ...f });
  };
  const set = (k) => (e) => setDraft(f => ({ ...f, [k]: e.target.value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const s = data?.summary;
  const buckets = data?.aging_buckets || [];
  const showKind = (data?.kind_options || []).length > 1;
  const billRange = applied.dateFrom || applied.dateTo
    ? `Bills dated ${applied.dateFrom ? formatDate(applied.dateFrom) : 'any time'} to ${applied.dateTo ? formatDate(applied.dateTo) : 'today'}`
    : 'All open bills';
  const filterLabel = [
    applied.kind && data?.kind_options?.find(k => k.key === applied.kind)?.label,
    applied.aging && `Aging ${buckets.find(b => b.key === applied.aging)?.label}`,
    applied.overdue && 'Overdue only',
    applied.search.trim() && `Search “${applied.search.trim()}”`,
  ].filter(Boolean).join(' · ');

  const fetchAll = async () => {
    const all = await finGet(meta.path, params(applied, { export: 1 }));
    if (all.truncated) notify(`Only the first ${all.rows.length.toLocaleString()} parties are included.`, 'warning');
    return all;
  };

  const print = () => {
    setPrinting(true);
    printReport(async () => {
      const all = await fetchAll();
      const sm = all.summary;
      const body = all.rows.map(r => `
        <tr><td>${r.row_no}</td><td><b>${esc(r.name)}</b><br><small>${esc([r.kind_label, r.code, r.mobile].filter(Boolean).join(' · '))}</small></td>
          <td class="r">${r.bill_count}</td><td class="r">${esc(money(r.total))}</td><td class="r">${esc(money(r.paid))}</td>
          ${all.aging_buckets.map(b => `<td class="r">${Number(r.aging[b.key]) ? esc(money(r.aging[b.key])) : '—'}</td>`).join('')}
          <td class="r"><b>${esc(money(r.due))}</b></td>
          <td class="nw">${r.last_payment_date ? `${esc(formatDate(r.last_payment_date))}<br><small>${esc(money(r.last_payment_amount))}</small>` : '—'}</td>
          <td>${esc(r.collection_status)}</td></tr>
        ${r.bills.map(b => `<tr class="sub"><td></td><td style="padding-left:14px">${esc(b.number)}${b.ref ? ` (${esc(b.ref)})` : ''} · ${esc(b.date ? formatDate(b.date) : '')}${b.due_date ? ` · due ${esc(formatDate(b.due_date))}` : ''} · ${b.days} days</td>
          <td></td><td class="r">${esc(money(b.total))}</td><td class="r">${esc(money(b.paid))}</td>
          ${all.aging_buckets.map(x => `<td class="r">${b.aging === x.key ? esc(money(b.due)) : ''}</td>`).join('')}
          <td class="r">${esc(money(b.due))}</td><td></td><td>${esc(b.status)}${b.overdue ? ' · Overdue' : ''}</td></tr>`).join('')}`).join('');
      const cols = 8 + all.aging_buckets.length;
      return printShell({
        title: meta.title, company, logo: storeProfile.logo_data_url,
        meta: [['As on', formatDate(all.as_of)], ['Bills', billRange], ['Branch', all.branch?.label || 'All branches'], filterLabel && ['Filter', filterLabel]],
        body: `${printCards([['TOTAL OUTSTANDING', money(sm.due)], ['OVERDUE', money(sm.overdue)], ['NOT YET DUE', money(sm.not_due)],
          ['PARTIES / BILLS', `${sm.parties} / ${sm.bills}`], ...all.aging_buckets.map(b => [b.label.toUpperCase(), money(sm.aging[b.key])])])}
          <table><thead><tr><th>#</th><th>${esc(meta.partyLabel)} / Bills</th><th class="r">Bills</th><th class="r">Billed</th><th class="r">${esc(meta.paidWord)}</th>
            ${all.aging_buckets.map(b => `<th class="r">${esc(b.label)}</th>`).join('')}<th class="r">Balance Due</th><th>${esc(meta.lastWord)}</th><th>Status</th></tr></thead>
          <tbody>${body || `<tr><td colspan="${cols}" style="text-align:center;padding:18px;color:#64748b">Nothing outstanding.</td></tr>`}
            ${all.rows.length ? `<tr class="tot"><td colspan="3">Total · ${sm.parties} parties</td><td class="r">${esc(money(sm.total))}</td><td class="r">${esc(money(sm.paid))}</td>
              ${all.aging_buckets.map(b => `<td class="r">${esc(money(sm.aging[b.key]))}</td>`).join('')}<td class="r">${esc(money(sm.due))}</td><td colspan="2"></td></tr>` : ''}
          </tbody></table>`,
      });
    }, (e) => notify(apiError(e, 'Could not prepare the report for printing.'), 'error')).finally(() => setPrinting(false));
  };

  // One CSV row per open bill, each carrying its party's details.
  const exportCsv = async () => {
    try {
      const all = await fetchAll();
      const header = ['#', 'Party Type', 'Code', meta.partyLabel, 'Mobile', 'Area', 'Bill No', 'Ref', 'Bill Date', 'Due Date', 'Days',
        'Aging', 'Ledger', 'Bill Amount', meta.paidWord, 'Balance Due', 'Bill Status', 'Overdue', 'Party Due', meta.lastWord, 'Collection Status'];
      const label = Object.fromEntries(all.aging_buckets.map(b => [b.key, b.label]));
      const lines = [];
      all.rows.forEach(r => r.bills.forEach(b => lines.push([r.row_no, r.kind_label, r.code, r.name, r.mobile, r.area, b.number, b.ref, b.date,
        b.due_date || '', b.days, label[b.aging], b.account, b.total, b.paid, b.due, b.status, b.overdue ? 'Yes' : '', r.due,
        r.last_payment_date ? `${r.last_payment_date} (${r.last_payment_amount})` : '', r.collection_status])));
      lines.push([], ['', '', '', 'Total outstanding', '', '', '', '', '', '', '', '', '', all.summary.total, all.summary.paid, all.summary.due]);
      all.aging_buckets.forEach(b => lines.push(['', '', '', b.label, '', '', '', '', '', '', '', '', '', '', '', all.summary.aging[b.key]]));
      downloadCsv(`${meta.file}_${all.as_of}.csv`, header, lines);
    } catch (e) {
      notify(apiError(e, 'Could not export the report.'), 'error');
    }
  };

  const toggle = (id) => setOpen(o => ({ ...o, [id]: !o[id] }));
  const cols = 9 + buckets.length;
  const ledger = data?.ledger;
  const diff = Number(ledger?.difference || 0);

  return (
    <ReportCard title={meta.title} subtitle={meta.subtitle}>
      <Box component="form" onSubmit={(e) => { e.preventDefault(); run(draft); }} sx={filterBarSx}>
        <TextField type="date" size="small" label="Bill Date From" value={draft.dateFrom} onChange={set('dateFrom')} InputLabelProps={{ shrink: true }} sx={{ width: 165, ...fieldSx }} />
        <TextField type="date" size="small" label="Bill Date To" value={draft.dateTo} onChange={set('dateTo')} InputLabelProps={{ shrink: true }} sx={{ width: 165, ...fieldSx }} />
        {multiBranchEnabled && (
          <TextField select size="small" label="Branch" value={draft.branch} onChange={set('branch')} sx={{ minWidth: 160, ...fieldSx }}>
            <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
            {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
          </TextField>
        )}
        {showKind && (
          <TextField select size="small" label="Party Type" value={draft.kind} onChange={set('kind')} sx={{ minWidth: 160, ...fieldSx }}>
            <MenuItem value="">Customers + Dealers</MenuItem>
            {data.kind_options.map(k => <MenuItem key={k.key} value={k.key}>{k.label}s</MenuItem>)}
          </TextField>
        )}
        <TextField select size="small" label="Aging" value={draft.aging} onChange={set('aging')} sx={{ minWidth: 150, ...fieldSx }}>
          <MenuItem value="">All ages</MenuItem>
          {buckets.map(b => <MenuItem key={b.key} value={b.key}>{b.label}</MenuItem>)}
        </TextField>
        <FormControlLabel control={<Switch size="small" checked={draft.overdue} onChange={(e) => setDraft(f => ({ ...f, overdue: e.target.checked }))} />}
          label={<Typography variant="body2" fontWeight={600}>Overdue only</Typography>} />
        <TextField size="small" label="Search" placeholder="Name, code, mobile, bill no…" value={draft.search} onChange={set('search')}
          sx={{ flex: '1 1 200px', minWidth: 180, ...fieldSx }} />
        <FilterActions dirty={dirty} onReset={() => run(defaultFilters())} onPrint={print} onCsv={exportCsv} busy={printing} ready={!!data} />
      </Box>
      {data && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          As on {formatDate(data.as_of)} · {data.branch?.label} · {billRange}{filterLabel ? ` · ${filterLabel}` : ''}
        </Typography>
      )}
      {loading && <LinearProgress sx={{ mb: 1 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {data?.dealers_hidden && (
        <Alert severity="info" sx={{ mb: 2 }}>Wholesale bills are not tied to a branch, so dealers are left out while a branch is selected.</Alert>
      )}

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}><SummaryCard label="TOTAL OUTSTANDING" value={s?.due} color={meta.accent} accent={meta.accent} hint={s ? `${s.parties} parties · ${s.bills} bills` : ''} /></Grid>
        <Grid item xs={6} md={3}><SummaryCard label="OVERDUE" value={s?.overdue} color="#b91c1c" accent="#dc2626"
          onClick={() => run({ ...draft, overdue: !draft.overdue })} active={applied.overdue} hint={s ? `${s.status_counts.Overdue + s.status_counts.Critical} parties` : ''} /></Grid>
        <Grid item xs={6} md={3}><SummaryCard label="NOT YET DUE" value={s?.not_due} color="#166534" accent="#16a34a" /></Grid>
        <Grid item xs={6} md={3}><SummaryCard label={`BILLED / ${meta.paidWord.toUpperCase()}`} value={s ? `${money(s.total)} / ${money(s.paid)}` : '—'} plain accent="#64748b" /></Grid>
      </Grid>

      {s && (
        <Paper variant="outlined" sx={{ p: 1.5, mb: 2, borderRadius: 2 }}>
          <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>AGING (CLICK TO FILTER)</Typography>
          <Box sx={{ display: 'flex', height: 10, borderRadius: 1, overflow: 'hidden', my: 1, bgcolor: '#f1f5f9' }}>
            {buckets.map(b => Number(s.due) > 0 && (
              <Box key={b.key} sx={{ width: `${(Number(s.aging[b.key]) * 100) / Number(s.due)}%`, bgcolor: AGING_COLORS[b.key] }} />
            ))}
          </Box>
          <Stack direction="row" flexWrap="wrap" gap={1}>
            {buckets.map(b => (
              <Box key={b.key} onClick={() => run({ ...draft, aging: draft.aging === b.key ? '' : b.key })}
                sx={{ px: 1.5, py: 0.75, borderRadius: 1.5, cursor: 'pointer', minWidth: 140, border: `1px solid ${AGING_COLORS[b.key]}`,
                  bgcolor: applied.aging === b.key ? `${AGING_COLORS[b.key]}14` : '#fff' }}>
                <Typography variant="body2" fontWeight={800} sx={{ color: AGING_COLORS[b.key] }}>{b.label}</Typography>
                <Typography variant="caption" fontWeight={700}>{money(s.aging[b.key])}</Typography>
              </Box>
            ))}
          </Stack>
        </Paper>
      )}

      {ledger && ledger.comparable && !applied.search.trim() && !applied.aging && !applied.overdue && Math.abs(diff) >= 0.01 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          The {side === 'receivable' ? 'receivable' : 'payable'} ledger{ledger.accounts.length > 1 ? 's carry' : ' carries'} {money(ledger.ledger_total)}, {money(Math.abs(diff))} {diff > 0 ? 'more' : 'less'} than
          the open bills ({money(ledger.bills_total)}).{' '}
          {diff > 0
            ? `The extra was posted to the ${side === 'receivable' ? 'receivable' : 'payable'} account without a bill: an on-account voucher, an opening balance or a manual journal.`
            : 'Some bills or their payments are not on the books yet — check Financial → Accounting Integration for posting failures — or an on-account voucher was not matched to a bill.'}
          {ledger.accounts.length > 0 && ` Check ${ledger.accounts.map(a => `${a.code} ${a.name}`).join(', ')} in the Accounts Activity report.`}
        </Alert>
      )}

      <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '64vh' }}>
        <Table size="small" stickyHeader aria-label={meta.title} sx={{ minWidth: 1150, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 } }}>
          <TableHead>
            <TableRow>
              <TableCell sx={head} width={36} />
              <TableCell sx={head} width={40}>#</TableCell>
              <TableCell sx={head}>{meta.partyLabel}</TableCell>
              <TableCell sx={head} align="right">Bills</TableCell>
              <TableCell sx={head} align="right">Balance Due</TableCell>
              {buckets.map(b => <TableCell key={b.key} sx={head} align="right">{b.label}</TableCell>)}
              <TableCell sx={head}>{meta.lastWord}</TableCell>
              <TableCell sx={head} align="right">{meta.paidWord} %</TableCell>
              <TableCell sx={head}>Status</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {!loading && data && data.rows.length === 0 && (
              <TableRow><TableCell colSpan={cols} align="center" sx={{ py: 6, color: 'text.secondary' }}>Nothing outstanding for these filters.</TableCell></TableRow>
            )}
            {(data?.rows || []).map(r => {
              const key = `${r.kind}:${r.id}`;
              const isOpen = !!open[key];
              return (
                <Fragment key={key}>
                  <TableRow hover tabIndex={0} onClick={() => toggle(key)}
                    onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key); } }}
                    sx={{ cursor: 'pointer', '& > td': { borderBottom: isOpen ? 'none' : undefined } }}>
                    <TableCell>{isOpen ? <OpenIcon fontSize="small" /> : <ClosedIcon fontSize="small" />}</TableCell>
                    <TableCell>{r.row_no}</TableCell>
                    <TableCell sx={{ maxWidth: 260 }}>
                      <Typography variant="body2" fontWeight={700} noWrap title={r.name}>{r.name}</Typography>
                      <Typography variant="caption" color="text.secondary">{[showKind && r.kind_label, r.code, r.mobile].filter(Boolean).join(' · ')}</Typography>
                    </TableCell>
                    <TableCell align="right">{r.bill_count}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 850, color: NAVY, whiteSpace: 'nowrap' }}>{money(r.due)}</TableCell>
                    {buckets.map(b => (
                      <TableCell key={b.key} align="right" sx={{ whiteSpace: 'nowrap', color: Number(r.aging[b.key]) ? AGING_COLORS[b.key] : 'text.disabled' }}>
                        {Number(r.aging[b.key]) ? money(r.aging[b.key]) : '—'}
                      </TableCell>
                    ))}
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {r.last_payment_date ? <>{formatDate(r.last_payment_date)}<Typography variant="caption" color="text.secondary" display="block">{money(r.last_payment_amount)}</Typography></> : <Typography variant="caption" color="text.secondary">None</Typography>}
                    </TableCell>
                    <TableCell align="right">{Number(r.collected_pct).toFixed(0)}%</TableCell>
                    <TableCell><Chip size="small" color={STATUS_COLORS[r.collection_status]} label={r.collection_status} sx={{ height: 22, fontWeight: 700 }} /></TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={cols} sx={{ p: 0, borderBottom: isOpen ? undefined : 'none' }}>
                      <Collapse in={isOpen} unmountOnExit><BillsTable row={r} meta={meta} /></Collapse>
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
    </ReportCard>
  );
}
