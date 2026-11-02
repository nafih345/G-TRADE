// Accounts → Profit & Loss. Reads GET /api/financial/reports/profit-loss-statement/ (backend
// financial/pl_statement.py), which buckets every Income / Expense account into Direct Income,
// Direct Expenses, Indirect Income and Indirect Expenses from posted journals only:
//   Gross Profit = Direct Income − Direct Expenses
//   Net Profit   = Gross Profit + Indirect Income − Indirect Expenses
// An account's bucket follows its account group in the Chart of Accounts, so re-grouping the
// account is how it moves between direct and indirect.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Card, Checkbox, Dialog, DialogContent, DialogTitle, FormControlLabel, Grid, IconButton,
  LinearProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField,
  ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import {
  ChevronLeft as PrevIcon, ChevronRight as NextIcon, Close as CloseIcon, FileDownload as CsvIcon,
  Print as PrintIcon, Refresh as RefreshIcon,
} from '@mui/icons-material';
import { apiError, finGet } from '../financial/financialApi';
import { useBranch } from '../../context/BranchContext';
import { formatDate, formatMoney, getBusinessPrefs } from '../../utils/localeFormat';

const NAVY = '#0f1e3d';
const PROFIT = '#15803d';
const LOSS = '#b91c1c';
const head = { fontWeight: 700, bgcolor: '#f8fafc' };

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const num = (v) => parseFloat(v || 0) || 0;
const money = (v) => formatMoney(num(v));
const signedMoney = (v) => (num(v) < 0 ? `(${formatMoney(Math.abs(num(v)))})` : formatMoney(num(v)));

const PERIODS = [
  { key: 'day', label: 'Daily' },
  { key: 'month', label: 'Monthly' },
  { key: 'quarter', label: 'Quarterly' },
  { key: 'year', label: 'Financial Year' },
  { key: 'custom', label: 'Custom' },
];
const BREAKDOWNS = [
  { key: '', label: 'None' },
  { key: 'day', label: 'Day-wise' },
  { key: 'month', label: 'Month-wise' },
  { key: 'quarter', label: 'Quarter-wise' },
];
// Sensible trend table for each period type (the user can still change it).
const DEFAULT_BREAKDOWN = { day: '', month: 'day', quarter: 'month', year: 'month', custom: '' };
const STEP_MONTHS = { month: 1, quarter: 3, year: 12 };

const fyMonth = () => Number(getBusinessPrefs()?.fiscal_year_start_month) || 4;

// [from, to] for a period type around an anchor date; quarters / years follow the fiscal year.
function rangeFor(period, anchor) {
  const a = parseYmd(anchor);
  if (period === 'day') return [anchor, anchor];
  if (period === 'month') return [ymd(new Date(a.getFullYear(), a.getMonth(), 1)), ymd(new Date(a.getFullYear(), a.getMonth() + 1, 0))];
  const months = period === 'quarter' ? 3 : 12;
  const fy = fyMonth() - 1;
  const offset = ((a.getMonth() - fy) % 12 + 12) % 12;
  const startMonth = a.getMonth() - (offset % months);
  return [ymd(new Date(a.getFullYear(), startMonth, 1)), ymd(new Date(a.getFullYear(), startMonth + months, 0))];
}

function periodTitle(period, from, to) {
  const f = parseYmd(from);
  if (period === 'day') return formatDate(from);
  if (period === 'month') return f.toLocaleDateString('en-IN', { month: 'long', year: 'numeric' });
  if (period === 'quarter' || period === 'year') {
    const fy = fyMonth() - 1;
    const fyStartYear = f.getMonth() >= fy ? f.getFullYear() : f.getFullYear() - 1;
    const fyLabel = fy === 0 ? `${fyStartYear}` : `FY ${fyStartYear}-${String(fyStartYear + 1).slice(-2)}`;
    if (period === 'year') return fyLabel;
    const q = Math.floor((((f.getMonth() - fy) % 12) + 12) % 12 / 3) + 1;
    return `Q${q} ${fyLabel} (${formatDate(from)} – ${formatDate(to)})`;
  }
  return `${formatDate(from)} – ${formatDate(to)}`;
}

function shiftAnchor(period, anchor, dir) {
  const a = parseYmd(anchor);
  if (period === 'day') return ymd(new Date(a.getFullYear(), a.getMonth(), a.getDate() + dir));
  return ymd(new Date(a.getFullYear(), a.getMonth() + dir * STEP_MONTHS[period], 1));
}

function changePct(cur, prev) {
  const c = num(cur); const p = num(prev);
  if (!p) return null;
  return ((c - p) / Math.abs(p)) * 100;
}

// ---------------------------------------------------------------------------

function SummaryTile({ label, value, sub, color }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, height: '100%' }}>
      <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ textTransform: 'uppercase', letterSpacing: 0.4 }}>{label}</Typography>
      <Typography variant="h6" fontWeight={850} sx={{ color: color || NAVY, mt: 0.5 }}>{value}</Typography>
      {sub && <Typography variant="caption" color="text.secondary">{sub}</Typography>}
    </Paper>
  );
}

function ChangeCell({ cur, prev, expense }) {
  const pct = changePct(cur, prev);
  if (pct === null) return <TableCell align="right" sx={{ color: 'text.disabled' }}>—</TableCell>;
  const good = expense ? pct <= 0 : pct >= 0;
  return (
    <TableCell align="right" sx={{ color: good ? PROFIT : LOSS, fontWeight: 600, whiteSpace: 'nowrap' }}>
      {pct > 0 ? '▲' : pct < 0 ? '▼' : ''} {Math.abs(pct).toFixed(1)}%
    </TableCell>
  );
}

function SectionRows({ section, prefix, compare, expense, onOpenAccount }) {
  const cols = compare ? 4 : 2;
  return (<>
    <TableRow>
      <TableCell colSpan={cols} sx={{ bgcolor: '#eef2f7', fontWeight: 800, color: NAVY }}>
        {prefix && <Box component="span" sx={{ color: 'text.secondary', fontWeight: 600, mr: 0.75 }}>{prefix}</Box>}
        {section.label}
      </TableCell>
    </TableRow>
    {section.groups.length === 0 && (
      <TableRow><TableCell colSpan={cols} sx={{ pl: 4, color: 'text.secondary', fontStyle: 'italic' }}>No postings in this period.</TableCell></TableRow>
    )}
    {section.groups.map(g => (
      <React.Fragment key={g.group}>
        <TableRow>
          <TableCell sx={{ pl: 3, fontWeight: 700 }}>{g.group}</TableCell>
          <TableCell align="right" sx={{ fontWeight: 700 }}>{signedMoney(g.total)}</TableCell>
          {compare && <TableCell align="right" sx={{ fontWeight: 700, color: 'text.secondary' }}>{signedMoney(g.previous_total)}</TableCell>}
          {compare && <ChangeCell cur={g.total} prev={g.previous_total} expense={expense} />}
        </TableRow>
        {g.accounts.map(a => (
          <TableRow key={a.id} hover sx={{ cursor: 'pointer' }} onClick={() => onOpenAccount(a)}
            tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onOpenAccount(a); }}>
            <TableCell sx={{ pl: 6, color: '#334155' }}>
              <Box component="span" sx={{ color: 'text.secondary', mr: 1, fontFamily: 'monospace', fontSize: 12 }}>{a.code}</Box>{a.name}
            </TableCell>
            <TableCell align="right">{signedMoney(a.amount)}</TableCell>
            {compare && <TableCell align="right" sx={{ color: 'text.secondary' }}>{signedMoney(a.previous_amount)}</TableCell>}
            {compare && <ChangeCell cur={a.amount} prev={a.previous_amount} expense={expense} />}
          </TableRow>
        ))}
      </React.Fragment>
    ))}
    <TableRow>
      <TableCell sx={{ fontWeight: 800 }}>Total {section.label}</TableCell>
      <TableCell align="right" sx={{ fontWeight: 800, borderTop: '1px solid #94a3b8' }}>{signedMoney(section.total)}</TableCell>
      {compare && <TableCell align="right" sx={{ fontWeight: 800, color: 'text.secondary', borderTop: '1px solid #94a3b8' }}>{signedMoney(section.previous_total)}</TableCell>}
      {compare && <ChangeCell cur={section.total} prev={section.previous_total} expense={expense} />}
    </TableRow>
  </>);
}

function ResultRow({ label, value, previous, compare, strong }) {
  const v = num(value);
  const color = v < 0 ? LOSS : PROFIT;
  return (
    <TableRow sx={{ bgcolor: v < 0 ? '#fef2f2' : '#f0fdf4' }}>
      <TableCell sx={{ fontWeight: 850, fontSize: strong ? 16 : 14, color }}>{v < 0 ? label.replace('Profit', 'Loss') : label}</TableCell>
      <TableCell align="right" sx={{ fontWeight: 850, fontSize: strong ? 16 : 14, color, borderTop: '2px solid', borderBottom: strong ? '3px double' : undefined }}>
        {formatMoney(Math.abs(v))}
      </TableCell>
      {compare && <TableCell align="right" sx={{ fontWeight: 800, color: num(previous) < 0 ? LOSS : 'text.secondary' }}>{signedMoney(previous)}</TableCell>}
      {compare && <ChangeCell cur={value} prev={previous} />}
    </TableRow>
  );
}

function AccountLedgerDialog({ account, dateFrom, dateTo, branch, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!account) return;
    let live = true;
    setData(null); setError('');
    finGet('reports/general-ledger/', { account: account.id, date_from: dateFrom, date_to: dateTo, ...(branch && branch !== 'all' ? { branch } : {}) })
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) setError(apiError(e)); });
    return () => { live = false; };
  }, [account, dateFrom, dateTo, branch]);

  return (
    <Dialog open={!!account} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 800, pr: 6 }}>
        {account?.code} · {account?.name}
        <Typography variant="body2" color="text.secondary">{formatDate(dateFrom)} – {formatDate(dateTo)}</Typography>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 12, top: 12 }} aria-label="Close"><CloseIcon /></IconButton>
      </DialogTitle>
      <DialogContent dividers>
        {!data && !error && <LinearProgress />}
        {error && <Alert severity="error">{error}</Alert>}
        {data && (
          <TableContainer sx={{ maxHeight: 480 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={head}>Date</TableCell>
                  <TableCell sx={head}>Voucher</TableCell>
                  <TableCell sx={head}>Ref / Narration</TableCell>
                  <TableCell sx={head} align="right">Debit</TableCell>
                  <TableCell sx={head} align="right">Credit</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.lines.length === 0 && <TableRow><TableCell colSpan={5} align="center" sx={{ py: 3, color: 'text.secondary' }}>No postings.</TableCell></TableRow>}
                {data.lines.map(l => (
                  <TableRow key={l.id} sx={l.is_reversal || l.status === 'REVERSED' ? { '& td': { color: 'text.disabled' } } : undefined}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(l.date)}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{l.entry_number}</TableCell>
                    <TableCell>{[l.source_number, l.memo || l.narration].filter(Boolean).join(' · ')}</TableCell>
                    <TableCell align="right">{num(l.debit) ? money(l.debit) : ''}</TableCell>
                    <TableCell align="right">{num(l.credit) ? money(l.credit) : ''}</TableCell>
                  </TableRow>
                ))}
                <TableRow>
                  <TableCell colSpan={3} sx={{ fontWeight: 800 }}>Total{data.truncated ? ' (first 2,000 lines shown)' : ''}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800 }}>{money(data.total_debit)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800 }}>{money(data.total_credit)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------

export default function ProfitLossStatement() {
  const { multiBranchEnabled, branches, isAdmin } = useBranch();
  const [period, setPeriod] = useState('month');
  const [anchor, setAnchor] = useState(ymd(new Date()));
  const [custom, setCustom] = useState(() => rangeFor('month', ymd(new Date())));
  const [breakdown, setBreakdown] = useState(DEFAULT_BREAKDOWN.month);
  const [compare, setCompare] = useState(false);
  const [branch, setBranch] = useState('all');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [openAccount, setOpenAccount] = useState(null);

  const [dateFrom, dateTo] = period === 'custom' ? custom : rangeFor(period, anchor);
  const rangeValid = dateFrom && dateTo && dateFrom <= dateTo;

  useEffect(() => {
    if (!rangeValid) { setData(null); return undefined; }
    let live = true;
    setLoading(true); setError('');
    finGet('reports/profit-loss-statement/', {
      date_from: dateFrom, date_to: dateTo, compare: compare ? 1 : undefined,
      breakdown: breakdown || undefined, branch: multiBranchEnabled ? branch : undefined,
    })
      .then(d => { if (live) setData(d); })
      .catch(e => { if (live) { setError(apiError(e, 'Could not load the Profit & Loss statement.')); setData(null); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [dateFrom, dateTo, compare, breakdown, branch, multiBranchEnabled, rangeValid, reloadKey]);

  const changePeriod = (_, p) => {
    if (!p) return;
    if (p === 'custom') setCustom([dateFrom, dateTo]);
    setPeriod(p);
    setBreakdown(DEFAULT_BREAKDOWN[p]);
  };

  const sections = useMemo(() => Object.fromEntries((data?.sections || []).map(s => [s.key, s])), [data]);
  const s = data?.summary;
  const prev = data?.previous;
  const showCompare = compare && !!prev;
  const net = num(s?.net_profit);
  const title = periodTitle(period, dateFrom, dateTo);

  const exportCsv = () => {
    if (!data) return;
    const rows = [['Profit & Loss Statement'], [title], [`Branch: ${data.branch?.label || 'All branches'}`], []];
    const hdr = ['Particulars', 'Code', 'Amount'];
    if (showCompare) hdr.push(`Previous (${prev.date_from} to ${prev.date_to})`);
    rows.push(hdr);
    const pushSection = (key) => {
      const sec = sections[key];
      if (!sec) return;
      rows.push([sec.label]);
      sec.groups.forEach(g => {
        rows.push([`  ${g.group}`, '', g.total, ...(showCompare ? [g.previous_total] : [])]);
        g.accounts.forEach(a => rows.push([`    ${a.name}`, a.code, a.amount, ...(showCompare ? [a.previous_amount] : [])]));
      });
      rows.push([`Total ${sec.label}`, '', sec.total, ...(showCompare ? [sec.previous_total] : [])]);
    };
    pushSection('DIRECT_INCOME');
    pushSection('DIRECT_EXPENSE');
    rows.push(['Gross Profit / (Loss)', '', s.gross_profit, ...(showCompare ? [prev.gross_profit] : [])], []);
    pushSection('INDIRECT_INCOME');
    pushSection('INDIRECT_EXPENSE');
    rows.push(['Net Profit / (Loss)', '', s.net_profit, ...(showCompare ? [prev.net_profit] : [])]);
    if (data.periods) {
      rows.push([], ['Period', 'From', 'To', 'Direct Income', 'Direct Expenses', 'Gross Profit', 'Indirect Income', 'Indirect Expenses', 'Net Profit']);
      data.periods.forEach(p => rows.push([p.label, p.date_from, p.date_to, p.direct_income, p.direct_expenses, p.gross_profit, p.indirect_income, p.indirect_expenses, p.net_profit]));
    }
    const csv = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
    const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: `profit_loss_${dateFrom}_${dateTo}.csv` });
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card variant="outlined" sx={{ p: { xs: 2, md: 3 }, borderRadius: 4 }}>
      {/* Filters */}
      <Stack spacing={2} className="no-print" sx={{ mb: 3 }}>
        <Stack direction={{ xs: 'column', lg: 'row' }} gap={2} alignItems={{ lg: 'center' }} justifyContent="space-between">
          <ToggleButtonGroup size="small" exclusive value={period} onChange={changePeriod} color="primary">
            {PERIODS.map(p => <ToggleButton key={p.key} value={p.key} sx={{ textTransform: 'none', fontWeight: 700, px: 2 }}>{p.label}</ToggleButton>)}
          </ToggleButtonGroup>
          <Stack direction="row" gap={1} flexWrap="wrap">
            <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={() => setReloadKey(k => k + 1)}>Refresh</Button>
            <Button size="small" variant="outlined" startIcon={<CsvIcon />} onClick={exportCsv} disabled={!data}>Export CSV</Button>
            <Button size="small" variant="outlined" startIcon={<PrintIcon />} onClick={() => window.print()} disabled={!data}>Print</Button>
          </Stack>
        </Stack>
        <Stack direction="row" gap={2} flexWrap="wrap" alignItems="center">
          {period === 'custom' ? (<>
            <TextField type="date" size="small" label="From" value={custom[0]} InputLabelProps={{ shrink: true }}
              onChange={(e) => setCustom([e.target.value, custom[1]])} sx={{ width: 170 }} />
            <TextField type="date" size="small" label="To" value={custom[1]} InputLabelProps={{ shrink: true }}
              onChange={(e) => setCustom([custom[0], e.target.value])} sx={{ width: 170 }}
              error={!rangeValid} helperText={!rangeValid ? 'To must be on/after From' : undefined} />
          </>) : (
            <Stack direction="row" alignItems="center" gap={0.5}>
              <Tooltip title="Previous"><IconButton size="small" onClick={() => setAnchor(shiftAnchor(period, anchor, -1))}><PrevIcon /></IconButton></Tooltip>
              {period === 'day' && (
                <TextField type="date" size="small" label="Date" value={anchor} InputLabelProps={{ shrink: true }}
                  onChange={(e) => e.target.value && setAnchor(e.target.value)} sx={{ width: 170 }} />
              )}
              {period === 'month' && (
                <TextField type="month" size="small" label="Month" value={anchor.slice(0, 7)} InputLabelProps={{ shrink: true }}
                  onChange={(e) => e.target.value && setAnchor(`${e.target.value}-01`)} sx={{ width: 170 }} />
              )}
              {(period === 'quarter' || period === 'year') && (
                <Typography fontWeight={700} sx={{ px: 1, minWidth: 160, textAlign: 'center' }}>{title}</Typography>
              )}
              <Tooltip title="Next"><IconButton size="small" onClick={() => setAnchor(shiftAnchor(period, anchor, 1))}><NextIcon /></IconButton></Tooltip>
              <Button size="small" onClick={() => setAnchor(ymd(new Date()))} sx={{ textTransform: 'none' }}>
                {period === 'day' ? 'Today' : period === 'month' ? 'This month' : period === 'quarter' ? 'This quarter' : 'This year'}
              </Button>
            </Stack>
          )}
          <TextField select size="small" label="Breakdown" value={breakdown} onChange={(e) => setBreakdown(e.target.value)} sx={{ minWidth: 150 }}>
            {BREAKDOWNS.map(b => <MenuItem key={b.key} value={b.key}>{b.label}</MenuItem>)}
          </TextField>
          {multiBranchEnabled && (
            <TextField select size="small" label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} sx={{ minWidth: 170 }}>
              <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          )}
          <FormControlLabel control={<Checkbox size="small" checked={compare} onChange={(e) => setCompare(e.target.checked)} />}
            label={<Typography variant="body2" fontWeight={600}>Compare with previous period</Typography>} />
        </Stack>
      </Stack>

      {loading && <LinearProgress sx={{ mb: 2 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      {data && s && (<>
        <Box sx={{ mb: 2 }}>
          <Typography variant="h6" fontWeight={850} sx={{ color: NAVY }}>Profit &amp; Loss Statement</Typography>
          <Typography variant="body2" color="text.secondary">
            {title}{data.branch?.label ? ` · ${data.branch.label}` : ''}
            {showCompare && ` · compared with ${formatDate(prev.date_from)} – ${formatDate(prev.date_to)}`}
          </Typography>
        </Box>

        {/* Summary */}
        <Grid container spacing={2} sx={{ mb: 3 }}>
          <Grid item xs={6} md={2.4}><SummaryTile label="Revenue (Direct Income)" value={money(s.direct_income)} /></Grid>
          <Grid item xs={6} md={2.4}><SummaryTile label="Direct Expenses" value={money(s.direct_expenses)} /></Grid>
          <Grid item xs={6} md={2.4}>
            <SummaryTile label={num(s.gross_profit) < 0 ? 'Gross Loss' : 'Gross Profit'} value={formatMoney(Math.abs(num(s.gross_profit)))}
              color={num(s.gross_profit) < 0 ? LOSS : PROFIT} sub={s.gross_margin_pct != null ? `${s.gross_margin_pct}% margin` : undefined} />
          </Grid>
          <Grid item xs={6} md={2.4}>
            <SummaryTile label="Indirect Inc. / Exp." value={`${money(s.indirect_income)} / ${money(s.indirect_expenses)}`} />
          </Grid>
          <Grid item xs={12} md={2.4}>
            <SummaryTile label={net < 0 ? 'Net Loss' : 'Net Profit'} value={formatMoney(Math.abs(net))} color={net < 0 ? LOSS : PROFIT}
              sub={[s.net_margin_pct != null ? `${s.net_margin_pct}% margin` : null,
                showCompare && changePct(s.net_profit, prev.net_profit) !== null
                  ? `${changePct(s.net_profit, prev.net_profit) >= 0 ? '▲' : '▼'} ${Math.abs(changePct(s.net_profit, prev.net_profit)).toFixed(1)}% vs previous` : null]
                .filter(Boolean).join(' · ') || undefined} />
          </Grid>
        </Grid>

        {/* Statement */}
        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, mb: 3 }}>
          <Table size="small" sx={{ minWidth: showCompare ? 720 : 480 }}>
            <TableHead>
              <TableRow>
                <TableCell sx={head}>Particulars</TableCell>
                <TableCell sx={head} align="right">Amount</TableCell>
                {showCompare && <TableCell sx={head} align="right">Previous Period</TableCell>}
                {showCompare && <TableCell sx={head} align="right">Change</TableCell>}
              </TableRow>
            </TableHead>
            <TableBody>
              {sections.DIRECT_INCOME && <SectionRows section={sections.DIRECT_INCOME} compare={showCompare} onOpenAccount={setOpenAccount} />}
              {sections.DIRECT_EXPENSE && <SectionRows section={sections.DIRECT_EXPENSE} prefix="Less:" expense compare={showCompare} onOpenAccount={setOpenAccount} />}
              <ResultRow label="Gross Profit" value={s.gross_profit} previous={prev?.gross_profit} compare={showCompare} />
              {sections.INDIRECT_INCOME && <SectionRows section={sections.INDIRECT_INCOME} prefix="Add:" compare={showCompare} onOpenAccount={setOpenAccount} />}
              {sections.INDIRECT_EXPENSE && <SectionRows section={sections.INDIRECT_EXPENSE} prefix="Less:" expense compare={showCompare} onOpenAccount={setOpenAccount} />}
              <ResultRow label="Net Profit" value={s.net_profit} previous={prev?.net_profit} compare={showCompare} strong />
            </TableBody>
          </Table>
        </TableContainer>

        {/* Period breakdown */}
        {data.periods && (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle1" fontWeight={850} sx={{ mb: 1, color: NAVY }}>
              {BREAKDOWNS.find(b => b.key === data.breakdown)?.label} performance
            </Typography>
            <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3, maxHeight: 520 }}>
              <Table size="small" stickyHeader sx={{ minWidth: 820 }}>
                <TableHead>
                  <TableRow>
                    {['Period', 'Direct Income', 'Direct Expenses', 'Gross Profit', 'GP %', 'Indirect Income', 'Indirect Expenses', 'Net Profit', 'NP %'].map((h, i) => (
                      <TableCell key={h} sx={head} align={i ? 'right' : 'left'}>{h}</TableCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {data.periods.map(p => {
                    const quiet = !num(p.total_income) && !num(p.total_expenses);
                    return (
                      <TableRow key={p.key} hover sx={quiet ? { '& td': { color: 'text.disabled' } } : undefined}>
                        <TableCell sx={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{p.label}</TableCell>
                        <TableCell align="right">{signedMoney(p.direct_income)}</TableCell>
                        <TableCell align="right">{signedMoney(p.direct_expenses)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, color: quiet ? undefined : num(p.gross_profit) < 0 ? LOSS : PROFIT }}>{signedMoney(p.gross_profit)}</TableCell>
                        <TableCell align="right">{p.gross_margin_pct != null ? `${p.gross_margin_pct}%` : '—'}</TableCell>
                        <TableCell align="right">{signedMoney(p.indirect_income)}</TableCell>
                        <TableCell align="right">{signedMoney(p.indirect_expenses)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 800, color: quiet ? undefined : num(p.net_profit) < 0 ? LOSS : PROFIT }}>{signedMoney(p.net_profit)}</TableCell>
                        <TableCell align="right">{p.net_margin_pct != null ? `${p.net_margin_pct}%` : '—'}</TableCell>
                      </TableRow>
                    );
                  })}
                  <TableRow>
                    <TableCell sx={{ fontWeight: 850 }}>Total</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 850 }}>{signedMoney(s.direct_income)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 850 }}>{signedMoney(s.direct_expenses)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 850 }}>{signedMoney(s.gross_profit)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 850 }}>{s.gross_margin_pct != null ? `${s.gross_margin_pct}%` : '—'}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 850 }}>{signedMoney(s.indirect_income)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 850 }}>{signedMoney(s.indirect_expenses)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 850, color: net < 0 ? LOSS : PROFIT }}>{signedMoney(s.net_profit)}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 850 }}>{s.net_margin_pct != null ? `${s.net_margin_pct}%` : '—'}</TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          </Box>
        )}

        <Typography variant="caption" color="text.secondary" className="no-print">
          From posted journals only (drafts excluded; reversed entries net to zero). Click an account for its postings.
          Accounts are placed in Direct / Indirect by their account group — move an account to a group such as
          “Direct Expenses” or “Indirect Expenses” in the Chart of Accounts to re-classify it.
        </Typography>
      </>)}

      <AccountLedgerDialog account={openAccount} dateFrom={dateFrom} dateTo={dateTo}
        branch={multiBranchEnabled ? branch : 'all'} onClose={() => setOpenAccount(null)} />
    </Card>
  );
}
