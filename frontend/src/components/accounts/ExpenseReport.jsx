// Accounts → Reports → Expense Report. Every posted line on an Expense ledger from
// /api/financial/reports/expenses/, bucketed Direct / Indirect (Operating) the same way the Profit &
// Loss statement does, then by account group and account. A reversal shows as a negative line, so
// the total always equals the P&L's expenses for the same dates.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Chip, Collapse, Grid, IconButton, LinearProgress, MenuItem, Paper, Stack, Table,
  TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import { ChevronRight as ClosedIcon, ExpandMore as OpenIcon } from '@mui/icons-material';
import { apiError, finGet } from '../financial/financialApi';
import { useBranch } from '../../context/BranchContext';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';
import {
  FilterActions, MODE_COLORS, NAVY, ReportCard, SummaryCard, downloadCsv, esc, fieldSx, filterBarSx, fyStart, head,
  money, monthStart, printCards, printReport, printShell, todayYmd,
} from './reportKit';

const BUCKET_COLORS = { DIRECT_EXPENSE: '#b45309', INDIRECT_EXPENSE: '#b91c1c' };
const defaultFilters = () => ({ dateFrom: monthStart(), dateTo: todayYmd(), branch: 'all', bucket: '', group: '', account: null, search: '' });
const params = (f, extra = {}) => ({
  date_from: f.dateFrom, date_to: f.dateTo, branch: f.branch, bucket: f.bucket, group: f.group, account: f.account?.id,
  search: f.search.trim(), ...extra,
});
const monthLabel = (ym) => new Date(`${ym}-01T00:00:00`).toLocaleDateString(undefined, { month: 'short', year: 'numeric' });

function CategoryTree({ categories, total, onPickAccount }) {
  const [open, setOpen] = useState({});
  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden', height: '100%' }}>
      <Box sx={{ px: 2, py: 1.25, borderBottom: '1px solid #e2e8f0' }}>
        <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>EXPENSES BY CATEGORY</Typography>
      </Box>
      <Table size="small" sx={{ '& .MuiTableCell-root': { fontSize: 13, py: 0.6 } }}>
        <TableBody>
          {categories.map(c => (
            <React.Fragment key={c.key}>
              <TableRow sx={{ bgcolor: '#f1f5f9' }}>
                <TableCell sx={{ fontWeight: 800, color: BUCKET_COLORS[c.key] }}>{c.label}</TableCell>
                <TableCell align="right" sx={{ color: 'text.secondary', width: 70 }}>{c.share_pct ? `${Number(c.share_pct).toFixed(1)}%` : ''}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800, width: 130 }}>{money(c.amount)}</TableCell>
              </TableRow>
              {c.groups.length === 0 && (
                <TableRow><TableCell colSpan={3} sx={{ pl: 4, color: 'text.secondary' }}>No entries</TableCell></TableRow>
              )}
              {c.groups.map(g => {
                const key = `${c.key}:${g.id}`;
                return (
                  <React.Fragment key={key}>
                    <TableRow hover sx={{ cursor: 'pointer' }} onClick={() => setOpen(o => ({ ...o, [key]: !o[key] }))}>
                      <TableCell sx={{ pl: 2.5, fontWeight: 700 }}>
                        <Stack direction="row" alignItems="center" gap={0.5}>
                          {open[key] ? <OpenIcon sx={{ fontSize: 16 }} /> : <ClosedIcon sx={{ fontSize: 16 }} />}
                          {g.name} <Typography component="span" variant="caption" color="text.secondary">({g.count})</Typography>
                        </Stack>
                      </TableCell>
                      <TableCell align="right" sx={{ color: 'text.secondary' }}>
                        {Number(total) ? `${((Number(g.amount) * 100) / Number(total)).toFixed(1)}%` : ''}
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>{money(g.amount)}</TableCell>
                    </TableRow>
                    {open[key] && g.accounts.map(a => (
                      <TableRow key={a.id} hover>
                        <TableCell sx={{ pl: 6 }}>
                          <Tooltip title="Show only this ledger">
                            <Box component="span" onClick={() => onPickAccount(a)} sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}>
                              {a.code} - {a.name}
                            </Box>
                          </Tooltip>
                          <Typography component="span" variant="caption" color="text.secondary"> ({a.count})</Typography>
                        </TableCell>
                        <TableCell />
                        <TableCell align="right">{money(a.amount)}</TableCell>
                      </TableRow>
                    ))}
                  </React.Fragment>
                );
              })}
            </React.Fragment>
          ))}
          <TableRow>
            <TableCell sx={{ fontWeight: 850, borderTop: `2px solid ${NAVY}` }}>Total Expenses</TableCell>
            <TableCell sx={{ borderTop: `2px solid ${NAVY}` }} />
            <TableCell align="right" sx={{ fontWeight: 850, borderTop: `2px solid ${NAVY}` }}>{money(total)}</TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </Paper>
  );
}

function TrendPanel({ byMonth, byMode }) {
  const max = Math.max(...byMonth.map(m => Math.abs(Number(m.amount))), 1);
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, height: '100%' }}>
      <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>MONTHLY TREND</Typography>
      <Stack gap={0.75} sx={{ mt: 1, mb: 2 }}>
        {byMonth.length === 0 && <Typography variant="body2" color="text.secondary">No expenses in this range.</Typography>}
        {byMonth.map(m => (
          <Stack key={m.month} direction="row" alignItems="center" gap={1}>
            <Typography variant="caption" sx={{ width: 64, flexShrink: 0 }}>{monthLabel(m.month)}</Typography>
            <Box sx={{ flex: 1, bgcolor: '#f1f5f9', borderRadius: 1, height: 14 }}>
              <Box sx={{ width: `${(Math.abs(Number(m.amount)) * 100) / max}%`, bgcolor: '#b91c1c', height: '100%', borderRadius: 1 }} />
            </Box>
            <Typography variant="caption" fontWeight={700} sx={{ width: 100, textAlign: 'right', flexShrink: 0 }}>{money(m.amount)}</Typography>
          </Stack>
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>PAID VIA</Typography>
      <Stack direction="row" flexWrap="wrap" gap={1} sx={{ mt: 0.75 }}>
        {byMode.map(m => (
          <Box key={m.mode} sx={{ px: 1.25, py: 0.5, borderRadius: 1.5, border: `1px solid ${MODE_COLORS[m.mode] || '#cbd5e1'}` }}>
            <Typography variant="body2" fontWeight={800} sx={{ color: MODE_COLORS[m.mode] }}>
              {m.mode === 'Credit' ? 'Unpaid / credit' : m.mode}
            </Typography>
            <Typography variant="caption" fontWeight={700}>{money(m.amount)}</Typography>
          </Box>
        ))}
      </Stack>
    </Paper>
  );
}

export default function ExpenseReport() {
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
  const [printing, setPrinting] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [showLines, setShowLines] = useState(true);

  useEffect(() => {
    finGet('accounts/').then(rows => setAccounts(Array.isArray(rows) ? rows : (rows.results || []))).catch(() => {});
  }, []);
  const expenseAccounts = useMemo(() => accounts.filter(a => a.account_type === 'Expense'), [accounts]);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await finGet('reports/expenses/', params(applied, { page: page + 1, page_size: pageSize })));
    } catch (e) {
      setError(apiError(e));
      setData(null);
    }
    setLoading(false);
  }, [applied, page, pageSize]);
  useEffect(() => { load(); }, [load]);

  const run = (f) => {
    if (f.dateFrom && f.dateTo && f.dateFrom > f.dateTo) { setError('From date must be on or before To date.'); return; }
    setDraft(f);
    setPage(0);
    setApplied({ ...f });
  };
  const set = (k) => (e) => setDraft(f => ({ ...f, [k]: e.target.value }));
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const s = data?.summary;
  const rangeLabel = applied.dateFrom === applied.dateTo ? formatDate(applied.dateFrom) : `${formatDate(applied.dateFrom)} to ${formatDate(applied.dateTo)}`;
  const filterLabel = [
    applied.bucket && data?.bucket_options?.find(b => b.key === applied.bucket)?.label,
    applied.group && data?.group_options?.find(g => g.id === applied.group)?.name,
    applied.account && `Ledger ${applied.account.code} - ${applied.account.name}`,
    applied.search.trim() && `Search “${applied.search.trim()}”`,
  ].filter(Boolean).join(' · ');

  const fetchAll = async () => {
    const all = await finGet('reports/expenses/', params(applied, { export: 1 }));
    if (all.truncated) notify(`Only the first ${all.rows.length.toLocaleString()} lines are included. Narrow the dates for the rest.`, 'warning');
    return all;
  };

  const print = () => {
    setPrinting(true);
    printReport(async () => {
      const all = await fetchAll();
      const sm = all.summary;
      const cats = sm.categories.map(c => `
        <tr class="tot"><td colspan="2">${esc(c.label)}</td><td class="r">${esc(money(c.amount))}</td></tr>
        ${c.groups.map(g => `<tr><td style="padding-left:14px"><b>${esc(g.name)}</b></td><td></td><td class="r">${esc(money(g.amount))}</td></tr>
          ${g.accounts.map(a => `<tr class="sub"><td style="padding-left:28px">${esc(a.code)} - ${esc(a.name)}</td><td class="r">${a.count} entr${a.count === 1 ? 'y' : 'ies'}</td><td class="r">${esc(money(a.amount))}</td></tr>`).join('')}`).join('')}`).join('');
      const lines = all.rows.map(r => `<tr class="${Number(r.amount) < 0 ? 'off' : ''}">
        <td>${r.row_no}</td><td class="nw">${esc(formatDate(r.date))}</td><td class="nw"><b>${esc(r.voucher_no)}</b></td>
        <td>${esc(r.account_code)} - ${esc(r.account_name)}<br><small>${esc(r.group)}</small></td>
        <td>${esc(r.party)}${r.reference ? `<br><small>${esc(r.reference)}</small>` : ''}</td>
        <td><small>${esc([r.narration, r.memo].filter(Boolean).join(' · '))}</small></td>
        <td>${esc(r.paid_via.join(', '))}</td><td class="r">${esc(money(r.amount))}</td></tr>`).join('');
      return printShell({
        title: 'Expense Report', company, logo: storeProfile.logo_data_url,
        meta: [['Period', rangeLabel], ['Branch', all.branch?.label || 'All branches'], filterLabel && ['Filter', filterLabel]],
        body: `${printCards([['TOTAL EXPENSES', money(sm.total)], ['DIRECT', money(sm.direct)], ['INDIRECT (OPERATING)', money(sm.indirect)], ['DAILY AVERAGE', money(sm.daily_average)]])}
          <h3>Category summary</h3><table><tbody>${cats}<tr class="tot"><td colspan="2">Total Expenses</td><td class="r">${esc(money(sm.total))}</td></tr></tbody></table>
          <h3>Expense lines (${sm.lines})</h3>
          <table><thead><tr><th>#</th><th>Date</th><th>Voucher</th><th>Ledger / Group</th><th>Party / Ref</th><th>Narration</th><th>Paid via</th><th class="r">Amount</th></tr></thead>
          <tbody>${lines || '<tr><td colspan="8" style="text-align:center;padding:18px;color:#64748b">No expenses for these filters.</td></tr>'}</tbody></table>`,
        footNote: all.truncated ? `Truncated to the first ${all.rows.length} lines.` : '',
      });
    }, (e) => notify(apiError(e, 'Could not prepare the report for printing.'), 'error')).finally(() => setPrinting(false));
  };

  const exportCsv = async () => {
    try {
      const all = await fetchAll();
      const header = ['#', 'Date', 'Time', 'Voucher No', 'Status', 'Origin', 'Category', 'Account Group', 'Ledger Code', 'Ledger Account',
        'Party', 'Reference', 'Narration', 'Line Memo', 'Paid Via', 'Amount', 'Branch', 'Entered By'];
      const lines = all.rows.map(r => [r.row_no, r.date, r.time, r.voucher_no, r.is_reversal ? 'Reversal' : r.status, r.origin_label,
        r.bucket_label, r.group, r.account_code, r.account_name, r.party, r.reference, r.narration, r.memo, r.paid_via.join(' | '),
        r.amount, r.branch, r.created_by]);
      lines.push([]);
      all.summary.categories.forEach(c => {
        lines.push(['', '', '', '', '', '', c.label, '', '', '', '', '', '', '', '', c.amount]);
        c.groups.forEach(g => g.accounts.forEach(a => lines.push(['', '', '', '', '', '', c.label, g.name, a.code, a.name, '', '', '', '', '', a.amount])));
      });
      lines.push(['', '', '', '', '', '', 'Total Expenses', '', '', '', '', '', '', '', '', all.summary.total]);
      downloadCsv(`expense_report_${applied.dateFrom}_${applied.dateTo}.csv`, header, lines);
    } catch (e) {
      notify(apiError(e, 'Could not export the report.'), 'error');
    }
  };

  const pickAccount = (a) => run({ ...draft, account: { id: a.id, code: a.code, name: a.name } });
  const cols = multiBranchEnabled ? 9 : 8;

  return (
    <ReportCard title="Expense Report"
      subtitle="Every expense posted to the books — expense vouchers, purchases booked to expense, stock write-offs, discounts and round-offs — grouped as Direct and Indirect (operating) expenses, then by account group and ledger.">
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
        <TextField select size="small" label="Category" value={draft.bucket} onChange={set('bucket')} sx={{ minWidth: 200, ...fieldSx }}>
          <MenuItem value="">Direct + Indirect</MenuItem>
          {(data?.bucket_options || []).map(b => <MenuItem key={b.key} value={b.key}>{b.label}</MenuItem>)}
        </TextField>
        <TextField select size="small" label="Account Group" value={draft.group} onChange={set('group')} sx={{ minWidth: 170, ...fieldSx }}>
          <MenuItem value="">All groups</MenuItem>
          {(data?.group_options || []).map(g => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}
        </TextField>
        <Autocomplete size="small" options={expenseAccounts} value={draft.account}
          onChange={(e, v) => setDraft(f => ({ ...f, account: v ? { id: v.id, code: v.code, name: v.name } : null }))}
          isOptionEqualToValue={(o, v) => o.id === v.id} getOptionLabel={(o) => `${o.code} - ${o.name}`}
          renderInput={(p) => <TextField {...p} label="Expense Ledger" sx={fieldSx} />} sx={{ minWidth: 230 }} />
        <TextField size="small" label="Search" placeholder="Voucher, party, narration, ledger…" value={draft.search} onChange={set('search')}
          sx={{ flex: '1 1 200px', minWidth: 180, ...fieldSx }} />
        <FilterActions dirty={dirty} onReset={() => run(defaultFilters())} onPrint={print} onCsv={exportCsv} busy={printing} ready={!!data} />
      </Box>
      {data && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
          {data.branch?.label} · {rangeLabel}{filterLabel ? ` · ${filterLabel}` : ''}
        </Typography>
      )}
      {loading && <LinearProgress sx={{ mb: 1 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}><SummaryCard label="TOTAL EXPENSES" value={s?.total} color="#b91c1c" accent="#b91c1c" hint={s ? `${s.lines} entries` : ''} /></Grid>
        <Grid item xs={6} md={3}><SummaryCard label="DIRECT EXPENSES" value={s?.direct} color={BUCKET_COLORS.DIRECT_EXPENSE} accent={BUCKET_COLORS.DIRECT_EXPENSE}
          onClick={() => run({ ...draft, bucket: draft.bucket === 'DIRECT_EXPENSE' ? '' : 'DIRECT_EXPENSE' })} active={applied.bucket === 'DIRECT_EXPENSE'} /></Grid>
        <Grid item xs={6} md={3}><SummaryCard label="INDIRECT (OPERATING)" value={s?.indirect} color={BUCKET_COLORS.INDIRECT_EXPENSE} accent="#dc2626"
          onClick={() => run({ ...draft, bucket: draft.bucket === 'INDIRECT_EXPENSE' ? '' : 'INDIRECT_EXPENSE' })} active={applied.bucket === 'INDIRECT_EXPENSE'} /></Grid>
        <Grid item xs={6} md={3}><SummaryCard label="DAILY AVERAGE" value={s?.daily_average} accent="#64748b" /></Grid>
      </Grid>

      {s && (
        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid item xs={12} md={7}><CategoryTree categories={s.categories} total={s.total} onPickAccount={pickAccount} /></Grid>
          <Grid item xs={12} md={5}><TrendPanel byMonth={s.by_month} byMode={s.by_mode} /></Grid>
        </Grid>
      )}

      <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={800} sx={{ color: NAVY }}>Expense lines</Typography>
        <IconButton size="small" onClick={() => setShowLines(v => !v)} sx={{ ml: 0.5 }}>{showLines ? <OpenIcon fontSize="small" /> : <ClosedIcon fontSize="small" />}</IconButton>
      </Stack>
      <Collapse in={showLines}>
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '64vh' }}>
          <Table size="small" stickyHeader aria-label="Expense lines" sx={{ minWidth: 1050, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={head} width={40}>#</TableCell>
                <TableCell sx={head}>Date</TableCell>
                <TableCell sx={head}>Voucher No</TableCell>
                {multiBranchEnabled && <TableCell sx={head}>Branch</TableCell>}
                <TableCell sx={head}>Expense Ledger</TableCell>
                <TableCell sx={head}>Party / Reference</TableCell>
                <TableCell sx={head}>Narration</TableCell>
                <TableCell sx={head}>Paid Via</TableCell>
                <TableCell sx={head} align="right">Amount</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!loading && data && data.rows.length === 0 && (
                <TableRow><TableCell colSpan={cols} align="center" sx={{ py: 6, color: 'text.secondary' }}>No expenses match these filters.</TableCell></TableRow>
              )}
              {(data?.rows || []).map(r => (
                <TableRow key={r.id} hover sx={{ opacity: Number(r.amount) < 0 ? 0.75 : 1 }}>
                  <TableCell>{r.row_no}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(r.date)}<Typography variant="caption" color="text.secondary" display="block">{r.time}</Typography></TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Typography variant="body2" fontFamily="monospace" fontWeight={700} color="primary.main">{r.voucher_no}</Typography>
                    <Stack direction="row" gap={0.5}>
                      {r.is_reversal && <Chip size="small" color="warning" label="Reversal" sx={{ height: 18, fontSize: 10.5 }} />}
                      {r.origin === 'auto' && <Chip size="small" variant="outlined" label={r.origin_label} sx={{ height: 18, fontSize: 10.5 }} />}
                    </Stack>
                  </TableCell>
                  {multiBranchEnabled && <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.branch || '—'}</TableCell>}
                  <TableCell sx={{ maxWidth: 240 }}>
                    <Typography variant="body2" fontWeight={600} noWrap title={`${r.account_code} - ${r.account_name}`}>{r.account_code} - {r.account_name}</Typography>
                    <Typography variant="caption" sx={{ color: BUCKET_COLORS[r.bucket] }}>{r.group} · {r.bucket === 'DIRECT_EXPENSE' ? 'Direct' : 'Indirect'}</Typography>
                  </TableCell>
                  <TableCell sx={{ maxWidth: 200 }}>
                    <Typography variant="body2" noWrap title={r.party}>{r.party || '—'}</Typography>
                    {r.reference && <Typography variant="caption" color="text.secondary">{r.reference}</Typography>}
                  </TableCell>
                  <TableCell sx={{ maxWidth: 260 }}>
                    <Typography variant="body2" noWrap color="text.secondary" title={[r.narration, r.memo].filter(Boolean).join(' · ')}>
                      {[r.narration, r.memo].filter(Boolean).join(' · ') || '—'}
                    </Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" gap={0.5} flexWrap="wrap">
                      {r.paid_via.map(m => <Chip key={m} size="small" variant="outlined" label={m === 'Credit' ? 'Unpaid' : m}
                        sx={{ height: 20, fontSize: 11, fontWeight: 700, color: MODE_COLORS[m], borderColor: MODE_COLORS[m] }} />)}
                    </Stack>
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, whiteSpace: 'nowrap', color: Number(r.amount) < 0 ? '#b91c1c' : undefined }}>{money(r.amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination component="div" count={data?.count || 0} page={data ? page : 0} onPageChange={(e, p) => setPage(p)}
          rowsPerPage={pageSize} onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }}
          rowsPerPageOptions={[25, 50, 100, 200]} />
      </Collapse>
    </ReportCard>
  );
}
