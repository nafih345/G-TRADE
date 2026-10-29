// Financial → Cashbook: posted movements of the cash accounts only, read from the ledger by
// GET /api/financial/reports/cashbook/ (the server nets each journal per account, computes the
// opening balance from history and the running balance across pages). This screen never edits a
// posting; a row opens the source bill / voucher read-only in ShowBillDialog.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, Card, Checkbox, Chip, FormControlLabel, Grid, LinearProgress, MenuItem, Paper, Stack, Table,
  TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Typography,
} from '@mui/material';
import {
  Print as PrintIcon, FilterAlt as ApplyIcon, RestartAlt as ResetIcon, FileDownload as CsvIcon,
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

// Voucher kind -> badge colours (text, background). Kinds come from financial/cashbook.py.
export const KIND_STYLES = {
  OPENING: ['#334155', '#e2e8f0'],
  CASH_SALE: ['#166534', '#dcfce7'],
  RECEIPT: ['#0f766e', '#ccfbf1'],
  PAYMENT: ['#b91c1c', '#fee2e2'],
  PETTY_CASH: ['#c2410c', '#ffedd5'],
  DEPOSIT: ['#3730a3', '#e0e7ff'],
  WITHDRAWAL: ['#6b21a8', '#f3e8ff'],
  TRANSFER: ['#0369a1', '#e0f2fe'],
};

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const defaultFilters = () => {
  const now = new Date();
  return { account: '', dateFrom: ymd(new Date(now.getFullYear(), now.getMonth(), 1)), dateTo: ymd(now), branch: 'all', search: '', showReversed: false };
};
const money = (v) => (v === null || v === undefined || v === '' ? '' : formatMoney(v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const params = (f, extra = {}) => ({
  account: f.account, date_from: f.dateFrom, date_to: f.dateTo, branch: f.branch,
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

function SummaryCard({ label, value, color, accent }) {
  return (
    <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, borderLeft: `4px solid ${accent}`, height: '100%' }}>
      <Typography variant="caption" color="text.secondary" fontWeight={800} sx={{ letterSpacing: 0.4 }}>{label}</Typography>
      <Typography variant="h6" fontWeight={850} sx={{ color, mt: 0.5 }}>{formatMoney(value || 0)}</Typography>
    </Paper>
  );
}

export default function CashbookPanel() {
  const { multiBranchEnabled, branches, isAdmin } = useBranch();
  const storeProfile = useStoreProfile();
  const company = companyFromProfile(storeProfile);
  const [accounts, setAccounts] = useState([]);
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(null);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(100);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [billRow, setBillRow] = useState(null);
  const [printing, setPrinting] = useState(false);

  // Cash accounts from the Chart of Accounts; start on the CASH-mapped (default) account.
  useEffect(() => {
    let alive = true;
    finGet('reports/cashbook/accounts/').then((d) => {
      if (!alive) return;
      const list = d.accounts || [];
      setAccounts(list);
      const first = (list.find(a => a.is_default) || list[0])?.id || '';
      setDraft(f => ({ ...f, account: f.account || first }));
      setApplied(f => f || { ...defaultFilters(), account: first });
    }).catch((e) => { if (alive) { setError(apiError(e)); setApplied(defaultFilters()); } });
    return () => { alive = false; };
  }, []);

  const load = useCallback(async () => {
    if (!applied || !applied.account) return;
    setLoading(true);
    setError('');
    try {
      setData(await finGet('reports/cashbook/', params(applied, { page: page + 1, page_size: pageSize })));
    } catch (e) {
      setError(apiError(e));
      setData(null);
    }
    setLoading(false);
  }, [applied, page, pageSize]);
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
    if (data.all_accounts) return 'All cash accounts';
    const a = data.accounts?.[0];
    return a ? `${a.code} - ${a.name}${a.status !== 'Active' ? ' (Inactive)' : ''}` : '';
  }, [data]);
  const rangeLabel = applied ? `${applied.dateFrom ? formatDate(applied.dateFrom) : 'Beginning'} to ${applied.dateTo ? formatDate(applied.dateTo) : 'Today'}` : '';

  // Every row for the applied filters (not just this page), for print / CSV.
  const fetchAll = async () => {
    const all = await finGet('reports/cashbook/', params(applied, { export: 1 }));
    if (all.truncated) notify(`Only the first ${all.rows.length.toLocaleString()} rows are included. Narrow the date range for the rest.`, 'warning');
    return all;
  };

  const print = async () => {
    if (!applied) return;
    const win = window.open('', '_blank', 'width=1100,height=900');  // open before awaiting, or the pop-up is blocked
    if (!win) { notify('Allow pop-ups to print the cashbook.', 'warning'); return; }
    setPrinting(true);
    try {
      const all = await fetchAll();
      win.document.open();
      win.document.write(printHtml(all, { company, logo: storeProfile.logo_data_url, accountLabel, rangeLabel, branchLabel: all.branch?.label }));
      win.document.close();
    } catch (e) {
      win.close();
      notify(apiError(e, 'Could not prepare the cashbook for printing.'), 'error');
    }
    setPrinting(false);
  };

  const exportCsv = async () => {
    if (!applied) return;
    try {
      const all = await fetchAll();
      const header = ['#', 'Branch', 'Date', 'Voucher No.', 'Bill / Ref No.', 'Voucher Type', 'Particulars', 'Description', 'Cash In (Debit)', 'Cash Out (Credit)', 'Balance'];
      const lines = all.rows.map(r => [r.row_no, r.branch_name, r.date, r.entry_number, r.source_number, r.voucher_kind_label, r.particulars, r.description, r.cash_in || '', r.cash_out || '', r.balance]);
      const s = all.summary;
      lines.push([], ['', '', '', '', '', '', 'Opening Balance', '', '', '', s.opening_balance], ['', '', '', '', '', '', 'Total Cash In', '', s.total_cash_in], ['', '', '', '', '', '', 'Total Cash Out', '', '', s.total_cash_out], ['', '', '', '', '', '', 'Closing Cash Balance', '', '', '', s.closing_balance]);
      const csv = [header, ...lines].map(row => row.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
      const url = URL.createObjectURL(new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' }));
      const a = Object.assign(document.createElement('a'), { href: url, download: `cashbook_${applied.dateFrom || 'start'}_${applied.dateTo || 'today'}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      notify(apiError(e, 'Could not export the cashbook.'), 'error');
    }
  };

  const onRowKey = (e, r) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBillRow(r); } };
  const s = data?.summary;
  const showBranchCol = multiBranchEnabled;
  const cols = showBranchCol ? 10 : 9;

  return (
    <Card variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
      <Box sx={{ px: { xs: 2, md: 3 }, py: 2, borderBottom: '1px solid #e2e8f0' }}>
        <Typography variant="h6" fontWeight={850} sx={{ letterSpacing: 0.3, color: NAVY }}>CASHBOOK — CASH TRANSACTIONS ONLY</Typography>
        <Typography variant="body2" color="text.secondary">View and manage all cash receipts and payments.</Typography>
      </Box>

      <Box sx={{ p: { xs: 2, md: 3 }, bgcolor: '#f8fafc' }}>
        <Box component="form" onSubmit={(e) => { e.preventDefault(); apply(); }}
          sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center', mb: 2, '& .MuiButton-root': { flexShrink: 0 } }}>
          <TextField select size="small" label="Cash Account" value={draft.account} onChange={set('account')}
            sx={{ minWidth: 220, flex: { xs: '1 1 100%', sm: '1 1 220px' }, bgcolor: '#fff' }}
            inputProps={{ 'aria-label': 'Cash account' }}>
            {accounts.map(a => (
              <MenuItem key={a.id} value={a.id}>{a.code} - {a.name}{a.status !== 'Active' ? ' (Inactive)' : ''}</MenuItem>
            ))}
            {accounts.length > 1 && <MenuItem value="all">All cash accounts (combined)</MenuItem>}
          </TextField>
          <TextField type="date" size="small" label="From Date" value={draft.dateFrom} onChange={set('dateFrom')}
            InputLabelProps={{ shrink: true }} sx={{ width: 175, flexShrink: 0, bgcolor: '#fff' }} />
          <TextField type="date" size="small" label="To Date" value={draft.dateTo} onChange={set('dateTo')}
            InputLabelProps={{ shrink: true }} sx={{ width: 175, flexShrink: 0, bgcolor: '#fff' }} />
          {multiBranchEnabled && (
            <TextField select size="small" label="Branch" value={draft.branch} onChange={set('branch')} sx={{ minWidth: 170, bgcolor: '#fff' }}>
              <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          )}
          <TextField size="small" label="Search" placeholder="Voucher no, particulars, description…" value={draft.search}
            onChange={set('search')} sx={{ flex: '1 1 220px', minWidth: 200, bgcolor: '#fff' }} />
          <Button type="submit" variant="contained" color={dirty ? 'warning' : 'primary'} startIcon={<ApplyIcon />}
            sx={{ fontWeight: 700, whiteSpace: 'nowrap', ...(dirty ? {} : { bgcolor: NAVY }) }}>Apply</Button>
          <Button variant="outlined" startIcon={<ResetIcon />} onClick={reset} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Reset</Button>
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={print} disabled={!data || printing} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>Print</Button>
          <Button variant="text" startIcon={<CsvIcon />} onClick={exportCsv} disabled={!data} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>CSV</Button>
        </Box>
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
        {!loading && accounts.length === 0 && !error && (
          <Alert severity="info" sx={{ mb: 2 }}>No cash accounts found. Add an account with sub-type “Cash” in the Chart of Accounts.</Alert>
        )}

        <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2, maxHeight: '62vh' }}>
          <Table size="small" stickyHeader aria-label="Cashbook transactions"
            sx={{ minWidth: 1000, '& .MuiTableCell-root': { fontSize: 13, py: 0.75, px: 1 }, '& .MuiTypography-body2': { fontSize: 13, lineHeight: 1.35 } }}>
            <TableHead>
              <TableRow>
                <TableCell sx={head} width={44}>#</TableCell>
                {showBranchCol && <TableCell sx={head}>Branch</TableCell>}
                <TableCell sx={head}>Date</TableCell>
                <TableCell sx={head}>Voucher No.</TableCell>
                <TableCell sx={head}>Voucher Type</TableCell>
                <TableCell sx={head}>Particulars</TableCell>
                <TableCell sx={head}>Description</TableCell>
                <TableCell sx={head} align="right">Cash In (Debit)</TableCell>
                <TableCell sx={head} align="right">Cash Out (Credit)</TableCell>
                <TableCell sx={head} align="right">Balance</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data && data.page === 1 && !data.search && (
                <TableRow sx={{ bgcolor: '#eef2f7' }}>
                  <TableCell colSpan={cols - 1} sx={{ fontWeight: 700, color: 'text.secondary' }}>
                    Opening balance {applied?.dateFrom ? `as on ${formatDate(applied.dateFrom)}` : ''}
                  </TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800 }}>{money(s.opening_balance)}</TableCell>
                </TableRow>
              )}
              {data && data.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={cols} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    {data.search ? `No cash transactions match “${data.search}” in this period.` : 'No cash transactions for the selected account, branch and dates.'}
                  </TableCell>
                </TableRow>
              )}
              {data && data.rows.map((r, i) => (
                <TableRow key={r.entry_id} hover tabIndex={0} onClick={() => setBillRow(r)} onKeyDown={(e) => onRowKey(e, r)}
                  aria-label={`${r.voucher_kind_label} ${r.entry_number}, open voucher`}
                  sx={{ cursor: 'pointer', bgcolor: i % 2 ? '#f8fafc' : '#fff', '&:focus-visible': { outline: `2px solid ${NAVY}`, outlineOffset: -2 } }}>
                  <TableCell sx={{ color: 'text.secondary' }}>{r.row_no}</TableCell>
                  {showBranchCol && <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.branch_name || '—'}</TableCell>}
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(r.date)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Typography variant="body2" fontFamily="monospace" fontWeight={700} color={r.is_reversal ? 'warning.main' : 'primary.main'}>{r.entry_number}</Typography>
                    {r.source_number && <Typography variant="caption" color="text.secondary">{r.source_number}</Typography>}
                  </TableCell>
                  <TableCell>
                    <KindBadge row={r} />
                    {(r.is_reversal || r.status === 'REVERSED') && (
                      <Chip size="small" color="warning" variant="outlined" label={r.is_reversal ? 'Reversal' : 'Reversed'} sx={{ ml: 0.5, height: 20, fontSize: 11 }} />
                    )}
                  </TableCell>
                  <TableCell sx={{ minWidth: 150, maxWidth: 220 }}><Typography variant="body2" fontWeight={600}>{r.particulars}</Typography></TableCell>
                  <TableCell sx={{ minWidth: 200, maxWidth: 300 }}>
                    <Typography variant="body2">{r.description}</Typography>
                    {r.memo && r.memo !== r.description && <Typography variant="caption" color="text.secondary">{r.memo}</Typography>}
                  </TableCell>
                  <TableCell align="right" sx={{ color: IN_COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{money(r.cash_in)}</TableCell>
                  <TableCell align="right" sx={{ color: OUT_COLOR, fontWeight: 700, whiteSpace: 'nowrap' }}>{money(r.cash_out)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 850, whiteSpace: 'nowrap', color: parseFloat(r.balance) < 0 ? OUT_COLOR : 'text.primary' }}>{money(r.balance)}</TableCell>
                </TableRow>
              ))}
              {data && data.search && data.rows.length > 0 && (
                <TableRow sx={{ bgcolor: '#eef2f7' }}>
                  <TableCell colSpan={cols - 3} sx={{ fontWeight: 700 }}>Matching “{data.search}” ({data.matched.count})</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, color: IN_COLOR }}>{money(data.matched.cash_in)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, color: OUT_COLOR }}>{money(data.matched.cash_out)}</TableCell>
                  <TableCell />
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
        {data?.search && (
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>
            Search narrows the rows listed; each row keeps its real running balance and the summary below covers the whole period.
          </Typography>
        )}

        <Grid container spacing={2} sx={{ mt: 0.5 }}>
          <Grid item xs={12} sm={6} md={3}><SummaryCard label="OPENING BALANCE" value={s?.opening_balance} color="#0f172a" accent="#64748b" /></Grid>
          <Grid item xs={12} sm={6} md={3}><SummaryCard label="TOTAL CASH IN" value={s?.total_cash_in} color={IN_COLOR} accent={IN_COLOR} /></Grid>
          <Grid item xs={12} sm={6} md={3}><SummaryCard label="TOTAL CASH OUT" value={s?.total_cash_out} color={OUT_COLOR} accent={OUT_COLOR} /></Grid>
          <Grid item xs={12} sm={6} md={3}><SummaryCard label="CLOSING CASH BALANCE" value={s?.closing_balance} color={NAVY} accent={NAVY} /></Grid>
        </Grid>
      </Box>

      <ShowBillDialog row={billRow} onClose={() => setBillRow(null)} />
    </Card>
  );
}

function printHtml(data, { company, logo, accountLabel, rangeLabel, branchLabel }) {
  const s = data.summary;
  const withBranch = data.rows.some(r => r.branch_name);
  const rows = data.rows.map(r => `
    <tr>
      <td>${r.row_no}</td>${withBranch ? `<td>${esc(r.branch_name)}</td>` : ''}
      <td class="nw">${esc(formatDate(r.date))}</td>
      <td class="nw"><b>${esc(r.entry_number)}</b>${r.source_number ? `<br><small>${esc(r.source_number)}</small>` : ''}</td>
      <td class="nw">${esc(r.voucher_kind_label)}${r.is_reversal ? ' (Reversal)' : r.status === 'REVERSED' ? ' (Reversed)' : ''}</td>
      <td>${esc(r.particulars)}</td>
      <td>${esc(r.description)}</td>
      <td class="r in">${esc(money(r.cash_in))}</td>
      <td class="r out">${esc(money(r.cash_out))}</td>
      <td class="r"><b>${esc(money(r.balance))}</b></td>
    </tr>`).join('');
  const cols = withBranch ? 10 : 9;
  return `<!doctype html><html><head><meta charset="utf-8"><title>Cashbook ${esc(rangeLabel)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; font-size: 11px; margin: 0; }
  .hdr { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid ${NAVY}; padding-bottom: 8px; margin-bottom: 10px; }
  .hdr img { max-height: 54px; max-width: 140px; object-fit: contain; }
  .hdr h1 { font-size: 18px; margin: 0; } .hdr p { margin: 2px 0 0; color: #475569; }
  h2 { font-size: 14px; margin: 0 0 4px; letter-spacing: .3px; }
  .meta { display: flex; flex-wrap: wrap; gap: 4px 22px; margin-bottom: 8px; color: #334155; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #eef2ff; color: #3730a3; border-bottom: 1px solid #c7d2fe; text-align: left; padding: 5px 6px; font-size: 10.5px; }
  td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  tbody tr:nth-child(even) td { background: #f8fafc; }
  .r { text-align: right; white-space: nowrap; } .nw { white-space: nowrap; }
  .in { color: ${IN_COLOR}; } .out { color: ${OUT_COLOR}; }
  .ob td { background: #eef2f7 !important; font-weight: 700; }
  .sum { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-top: 12px; }
  .sum div { border: 1px solid #cbd5e1; border-radius: 6px; padding: 8px 10px; }
  .sum small { display: block; color: #64748b; font-weight: 700; } .sum b { font-size: 14px; }
  .foot { margin-top: 10px; color: #64748b; font-size: 10px; display: flex; justify-content: space-between; }
  * { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
</style></head><body>
  <div class="hdr">
    ${logo ? `<img src="${esc(logo)}" alt="">` : ''}
    <div><h1>${esc(company.name || 'Cashbook')}</h1>
      <p>${esc(company.address)}${company.phone ? ` · Ph: ${esc(company.phone)}` : ''}${company.gstin ? ` · GSTIN: ${esc(company.gstin)}` : ''}</p></div>
  </div>
  <h2>CASHBOOK — CASH TRANSACTIONS ONLY</h2>
  <div class="meta">
    <span><b>Cash account:</b> ${esc(accountLabel)}</span>
    <span><b>Branch:</b> ${esc(branchLabel || 'All branches')}</span>
    <span><b>Period:</b> ${esc(rangeLabel)}</span>
    ${data.search ? `<span><b>Search:</b> ${esc(data.search)}</span>` : ''}
  </div>
  <table>
    <thead><tr><th>#</th>${withBranch ? '<th>Branch</th>' : ''}<th>Date</th><th>Voucher No.</th><th>Voucher Type</th><th>Particulars</th><th>Description</th>
      <th class="r">Cash In (Dr)</th><th class="r">Cash Out (Cr)</th><th class="r">Balance</th></tr></thead>
    <tbody>
      ${data.search ? '' : `<tr class="ob"><td colspan="${cols - 1}">Opening balance</td><td class="r">${esc(money(s.opening_balance))}</td></tr>`}
      ${rows || `<tr><td colspan="${cols}" style="text-align:center;padding:18px;color:#64748b">No cash transactions for these filters.</td></tr>`}
    </tbody>
  </table>
  <div class="sum">
    <div><small>OPENING BALANCE</small><b>${esc(money(s.opening_balance))}</b></div>
    <div><small>TOTAL CASH IN</small><b class="in">${esc(money(s.total_cash_in))}</b></div>
    <div><small>TOTAL CASH OUT</small><b class="out">${esc(money(s.total_cash_out))}</b></div>
    <div><small>CLOSING CASH BALANCE</small><b>${esc(money(s.closing_balance))}</b></div>
  </div>
  <div class="foot"><span>${data.truncated ? `Truncated to the first ${data.rows.length} rows. ` : ''}${data.search ? 'Rows filtered by search; summary covers the whole period.' : ''}</span>
    <span>Generated ${esc(new Date().toLocaleString())}</span></div>
  <script>window.onload = function () { setTimeout(function () { window.print(); }, 250); };</script>
</body></html>`;
}
