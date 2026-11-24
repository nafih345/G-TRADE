// Bill-to-Bill Settlement Statement (Accounts → Reports → Settlement Statement and
// Financial → Settlement Statement). Two views over /api/financial/settlements/:
//   * Vouchers      — statement/: every bill-to-bill Receipt / Payment Voucher in the period, each
//                     expandable to its payment sources and the bills it closed / part-settled.
//   * Party Ledger  — party-ledger/: one customer / dealer / supplier's bills and receipts /
//                     payments with a running balance and which voucher settled which bill.
// Money follows the active currency (formatMoney); Print / PDF via the print shell, Excel from the
// server (?export=xlsx) and CSV on the client. Everything is bundled — no CDN — so it works offline.
import React, { Fragment, useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Chip, Collapse, Grid, IconButton, InputAdornment, LinearProgress, MenuItem, Paper, Stack, Tab,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  KeyboardArrowDown as OpenIcon, KeyboardArrowRight as ClosedIcon, Search as SearchIcon, FileDownload as CsvIcon,
  GridOn as ExcelIcon, Print as PrintIcon, Visibility as ViewIcon,
} from '@mui/icons-material';
import { FIN_API, apiError, finGet } from './financialApi';
import VoucherSearchDialog from './VoucherSearchDialog';
import SettlementBreakdownDialog, { BILL_STATUS, PARTY_KIND_LABEL, SettlementBreakdown } from './SettlementBreakdownDialog';
import {
  NAVY, MODE_COLORS, ReportCard, SummaryCard, downloadCsv, esc, fieldSx, filterBarSx, fyStart, head, monthStart, printCards,
  printReport, printShell, todayYmd,
} from '../accounts/reportKit';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate, formatMoney } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';

const money = (v) => (v === null || v === undefined || v === '' ? '' : formatMoney(v));
const VOUCHER_LABEL = { RV: 'Receipt', PV: 'Payment' };

async function downloadXlsx(path, params, filename) {
  try {
    const res = await axios.get(`${FIN_API}/${path}`, { params: { ...params, export: 'xlsx' }, responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    Object.assign(document.createElement('a'), { href: url, download: filename }).click();
    URL.revokeObjectURL(url);
  } catch (e) {
    let msg = 'Could not export to Excel.';
    try { msg = JSON.parse(await e?.response?.data?.text())?.error || msg; } catch { /* not JSON */ }
    notify(msg, 'error');
  }
}

// ---------------------------------------------------------------------------------------------
// Vouchers view
// ---------------------------------------------------------------------------------------------
const defaultVoucherFilters = () => ({ voucher: '', partyKind: '', status: '', dateFrom: monthStart(), dateTo: todayYmd(), search: '' });

function VouchersView({ company, logo }) {
  const [draft, setDraft] = useState(defaultVoucherFilters);
  const [applied, setApplied] = useState(defaultVoucherFilters);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState({});
  const params = (f) => ({ voucher: f.voucher, party_kind: f.partyKind, status: f.status, date_from: f.dateFrom, date_to: f.dateTo, search: f.search.trim() });

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      setData(await finGet('settlements/statement/', params(applied)));
    } catch (e) {
      setError(apiError(e, 'Could not load the settlement statement.'));
    }
    setLoading(false);
  }, [applied]);
  useEffect(() => { load(); }, [load]);

  const run = (f) => { setDraft(f); setApplied(f); setOpen({}); };
  const dirty = JSON.stringify(draft) !== JSON.stringify(applied);
  const rows = data?.results || [];
  const s = data?.summary;
  const rangeLabel = `${applied.dateFrom ? formatDate(applied.dateFrom) : '…'} to ${applied.dateTo ? formatDate(applied.dateTo) : '…'}`;

  const exportCsv = () => {
    const lines = [];
    rows.forEach(r => {
      const pay = r.payments.map(p => `${p.method} ${p.amount}${p.detail ? ` (${p.detail})` : ''}`).join('; ');
      const base = [r.number, VOUCHER_LABEL[r.voucher], r.date, r.party_name, r.party_code, pay, r.total, r.on_account];
      if (!r.bills.length) lines.push([...base, '', '', '', '', '', '', '', r.status]);
      r.bills.forEach((b, i) => lines.push([...(i === 0 ? base : [r.number, '', '', '', '', '', '', '']),
        b.bill_number, b.bill_date, b.bill_total, b.previous_due, b.settled, b.remaining_due, BILL_STATUS[b.status]?.label || '', r.status]));
    });
    downloadCsv(`settlement_statement_${applied.dateFrom}_${applied.dateTo}.csv`,
      ['Voucher No', 'Type', 'Date', 'Party', 'Code', 'Payment Source', 'Total', 'On Account', 'Bill No', 'Bill Date', 'Bill Amount',
        'Due Before', 'Settled', 'Balance After', 'Bill Status', 'Voucher Status'], lines);
  };

  const print = () => printReport(async () => {
    const body = rows.map(r => `
      <tr class="${r.status !== 'POSTED' ? 'off' : ''}"><td class="nw"><b>${esc(r.number)}</b><br><small>${esc(VOUCHER_LABEL[r.voucher])}${r.status !== 'POSTED' ? ' · Reversed' : ''}</small></td>
        <td class="nw">${esc(formatDate(r.date))}</td><td>${esc(r.party_name)}<br><small>${esc(PARTY_KIND_LABEL[r.party_kind])} ${esc(r.party_code)}</small></td>
        <td>${r.payments.map(p => `<span style="color:${MODE_COLORS[p.method === 'Bank Transfer' ? 'Bank' : p.method] || '#0f172a'}"><b>${esc(p.method)}</b> ${esc(money(p.amount))}</span>${p.detail ? `<br><small>${esc(p.detail)}</small>` : ''}`).join('<br>')}</td>
        <td class="r"><b>${esc(money(r.total))}</b>${Number(r.on_account) ? `<br><small>On acct ${esc(money(r.on_account))}</small>` : ''}</td></tr>
      ${r.bills.map(b => `<tr class="sub"><td></td><td class="nw">${esc(b.bill_date ? formatDate(b.bill_date) : '')}</td>
        <td colspan="2">${esc(b.bill_number)}${b.bill_ref ? ` (${esc(b.bill_ref)})` : ''} · bill ${esc(money(b.bill_total))} · due before ${esc(money(b.previous_due) || '—')} → after ${esc(money(b.remaining_due) || '—')} · ${esc(BILL_STATUS[b.status]?.label || '')}</td>
        <td class="r">${esc(money(b.settled))}</td></tr>`).join('')}`).join('');
    return printShell({
      title: 'Bill-to-Bill Settlement Statement', company, logo,
      meta: [['Period', rangeLabel], applied.voucher && ['Voucher', VOUCHER_LABEL[applied.voucher]], applied.search && ['Search', applied.search]],
      body: `${printCards([['VOUCHERS', String(s?.vouchers ?? 0)], ['TOTAL', money(s?.total)], ['AGAINST BILLS', money(s?.allocated)],
        ['ON ACCOUNT', money(s?.on_account)], ['BILLS CLOSED / PARTIAL', `${s?.bills_closed ?? 0} / ${s?.bills_partial ?? 0}`]])}
        <table><thead><tr><th>Voucher</th><th>Date</th><th>Party / Bill</th><th>Payment Source / Settlement</th><th class="r">Amount</th></tr></thead>
        <tbody>${body || '<tr><td colspan="5" style="text-align:center;padding:18px;color:#64748b">No settlements in this period.</td></tr>'}
        <tr class="tot"><td colspan="4">Total (posted)</td><td class="r">${esc(money(s?.total))}</td></tr></tbody></table>`,
    });
  }, (e) => notify(apiError(e, 'Could not print.'), 'error'));

  return (
    <Box>
      <Box component="form" onSubmit={(e) => { e.preventDefault(); run(draft); }} sx={filterBarSx}>
        <TextField select size="small" label="Voucher" value={draft.voucher} onChange={(e) => setDraft(d => ({ ...d, voucher: e.target.value }))} sx={{ ...fieldSx, width: 150 }}>
          <MenuItem value="">Receipt & Payment</MenuItem><MenuItem value="RV">Receipt (RV)</MenuItem><MenuItem value="PV">Payment (PV)</MenuItem>
        </TextField>
        <TextField select size="small" label="Party Type" value={draft.partyKind} onChange={(e) => setDraft(d => ({ ...d, partyKind: e.target.value }))} sx={{ ...fieldSx, width: 140 }}>
          <MenuItem value="">All</MenuItem><MenuItem value="customer">Customer</MenuItem><MenuItem value="dealer">Dealer</MenuItem><MenuItem value="supplier">Supplier</MenuItem>
        </TextField>
        <TextField type="date" size="small" label="From" value={draft.dateFrom} InputLabelProps={{ shrink: true }} onChange={(e) => setDraft(d => ({ ...d, dateFrom: e.target.value }))} sx={{ ...fieldSx, width: 160 }} />
        <TextField type="date" size="small" label="To" value={draft.dateTo} InputLabelProps={{ shrink: true }} onChange={(e) => setDraft(d => ({ ...d, dateTo: e.target.value }))} sx={{ ...fieldSx, width: 160 }} />
        <TextField select size="small" label="Status" value={draft.status} onChange={(e) => setDraft(d => ({ ...d, status: e.target.value }))} sx={{ ...fieldSx, width: 130 }}>
          <MenuItem value="">All</MenuItem><MenuItem value="POSTED">Posted</MenuItem><MenuItem value="REVERSED">Reversed</MenuItem>
        </TextField>
        <TextField size="small" placeholder="Voucher / party / bill no" value={draft.search} onChange={(e) => setDraft(d => ({ ...d, search: e.target.value }))}
          sx={{ ...fieldSx, minWidth: 200, flex: 1 }} InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
        <Button type="submit" variant="contained" color={dirty ? 'warning' : 'primary'} sx={{ fontWeight: 700, ...(dirty ? {} : { bgcolor: NAVY }) }}>Apply</Button>
        <Button variant="outlined" onClick={() => run({ ...draft, dateFrom: fyStart(), dateTo: todayYmd() })} sx={{ fontWeight: 700 }}>This FY</Button>
        <Button variant="outlined" startIcon={<PrintIcon />} onClick={print} disabled={!data} sx={{ fontWeight: 700 }}>Print</Button>
        <Button variant="outlined" startIcon={<ExcelIcon />} disabled={!data}
          onClick={() => downloadXlsx('settlements/statement/', params(applied), `settlement_statement_${applied.dateFrom}_${applied.dateTo}.xlsx`)} sx={{ fontWeight: 700 }}>Excel</Button>
        <Button variant="text" startIcon={<CsvIcon />} onClick={exportCsv} disabled={!data} sx={{ fontWeight: 700 }}>CSV</Button>
      </Box>

      {s && (
        <Grid container spacing={1.5} sx={{ mb: 2 }}>
          <Grid item xs={6} md={2}><SummaryCard label="VOUCHERS" value={s.vouchers} plain accent={NAVY} hint={s.reversed ? `${s.reversed} reversed` : undefined} /></Grid>
          <Grid item xs={6} md={2.5}><SummaryCard label="TOTAL SETTLED" value={s.total} accent="#2563eb" /></Grid>
          <Grid item xs={6} md={2.5}><SummaryCard label="AGAINST BILLS" value={s.allocated} accent="#16a34a" /></Grid>
          <Grid item xs={6} md={2.5}><SummaryCard label="ON ACCOUNT" value={s.on_account} accent="#a16207" /></Grid>
          <Grid item xs={12} md={2.5}><SummaryCard label="BILLS CLOSED / PARTIAL" value={`${s.bills_closed} / ${s.bills_partial}`} plain accent="#7c3aed" /></Grid>
        </Grid>
      )}
      {s && Object.keys(s.by_mode).length > 0 && (
        <Stack direction="row" gap={1} flexWrap="wrap" sx={{ mb: 1.5 }}>
          {Object.entries(s.by_mode).map(([mode, amt]) => (
            <Chip key={mode} variant="outlined" label={`${mode}: ${money(amt)}`} sx={{ fontWeight: 700 }} />
          ))}
        </Stack>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {data?.truncated && <Alert severity="info" sx={{ mb: 2 }}>Showing the latest 2,000 vouchers — narrow the dates to see the rest.</Alert>}

      <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
        <Box sx={{ height: 4 }}>{loading && <LinearProgress />}</Box>
        <TableContainer>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell sx={head} width={36} />
                <TableCell sx={head}>Voucher No</TableCell>
                <TableCell sx={head}>Date</TableCell>
                <TableCell sx={head}>Party</TableCell>
                <TableCell sx={head}>Payment Source</TableCell>
                <TableCell sx={head} align="center">Bills</TableCell>
                <TableCell sx={head} align="right">Amount</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!loading && data && !rows.length && (
                <TableRow><TableCell colSpan={7} align="center" sx={{ py: 6, color: 'text.secondary' }}>No bill-to-bill settlements match these filters.</TableCell></TableRow>
              )}
              {rows.map(r => {
                const isOpen = !!open[r.id];
                const toggle = () => setOpen(o => ({ ...o, [r.id]: !o[r.id] }));
                return (
                  <Fragment key={r.id}>
                    <TableRow hover tabIndex={0} onClick={toggle} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
                      sx={{ cursor: 'pointer', opacity: r.status !== 'POSTED' ? 0.65 : 1, '& > td': { borderBottom: isOpen ? 'none' : undefined } }}>
                      <TableCell>{isOpen ? <OpenIcon fontSize="small" /> : <ClosedIcon fontSize="small" />}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        <Typography variant="body2" fontFamily="monospace" fontWeight={800} color="primary.main">{r.number}</Typography>
                        <Stack direction="row" gap={0.5}>
                          <Chip size="small" label={VOUCHER_LABEL[r.voucher]} color={r.voucher === 'RV' ? 'success' : 'error'} variant="outlined" sx={{ height: 18, fontSize: 10.5, fontWeight: 700 }} />
                          {r.status !== 'POSTED' && <Chip size="small" label="Reversed" color="error" sx={{ height: 18, fontSize: 10.5, fontWeight: 700 }} />}
                        </Stack>
                      </TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{formatDate(r.date)}</TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={700}>{r.party_name}</Typography>
                        <Typography variant="caption" color="text.secondary">{PARTY_KIND_LABEL[r.party_kind]}{r.party_code ? ` · ${r.party_code}` : ''}</Typography>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" gap={0.5} flexWrap="wrap">
                          {r.payments.map((p, i) => (
                            <Tooltip key={i} title={p.detail || ''}>
                              <Chip size="small" variant="outlined" label={`${p.method} ${money(p.amount)}`} sx={{ height: 22, fontWeight: 700 }} />
                            </Tooltip>
                          ))}
                        </Stack>
                      </TableCell>
                      <TableCell align="center" sx={{ whiteSpace: 'nowrap' }}>
                        <Typography variant="body2" fontWeight={700}>{r.bills.length}</Typography>
                        <Typography variant="caption" color="text.secondary">{r.bills_closed} closed · {r.bills_partial} partial</Typography>
                      </TableCell>
                      <TableCell align="right" sx={{ fontWeight: 850, whiteSpace: 'nowrap', textDecoration: r.status !== 'POSTED' ? 'line-through' : 'none' }}>
                        {money(r.total)}
                        {Number(r.on_account) > 0 && <Typography variant="caption" color="warning.dark" display="block">On acct {money(r.on_account)}</Typography>}
                      </TableCell>
                    </TableRow>
                    <TableRow>
                      <TableCell colSpan={7} sx={{ p: 0, borderBottom: isOpen ? undefined : 'none' }}>
                        <Collapse in={isOpen} unmountOnExit>
                          <Box sx={{ p: 2, bgcolor: '#f8fafc', borderTop: '1px dashed #cbd5e1' }}><SettlementBreakdown data={r} /></Box>
                        </Collapse>
                      </TableCell>
                    </TableRow>
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------
// Party ledger view
// ---------------------------------------------------------------------------------------------
const TYPE_LABEL = { BILL: 'Bill', RECEIPT: 'Receipt', PAYMENT: 'Payment', RETURN: 'Return', REFUND: 'Refund' };

function PartyLedgerView({ company, logo, onBreakdown }) {
  const [party, setParty] = useState(null);
  const [picking, setPicking] = useState(null);   // 'RV' | 'PV'
  const [dates, setDates] = useState({ from: fyStart(), to: todayYmd() });
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState({});
  const params = useCallback(() => (party ? { party_kind: party.kind, party: party.id, date_from: dates.from, date_to: dates.to } : null), [party, dates]);

  const load = useCallback(async () => {
    const p = params();
    if (!p) return;
    setLoading(true);
    setError('');
    try {
      setData(await finGet('settlements/party-ledger/', p));
    } catch (e) {
      setError(apiError(e, 'Could not load the party ledger.'));
    }
    setLoading(false);
  }, [params]);
  useEffect(() => { load(); }, [party]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchParties = useCallback(async (text, onlyDue) => {
    const res = await finGet('settlements/parties/', { voucher: picking, search: text, only_due: onlyDue ? 1 : '', limit: 50 });
    return { rows: res.results || [], hasMore: res.has_more };
  }, [picking]);

  const partyColumns = [
    { key: 'kind', label: 'Type', width: 90, render: (p) => PARTY_KIND_LABEL[p.kind] },
    { key: 'code', label: 'Code', mono: true, width: 120 },
    { key: 'name', label: 'Name' },
    { key: 'mobile', label: 'Mobile' },
    { key: 'outstanding', label: 'Outstanding', align: 'right', render: (p) => <b>{money(p.outstanding)}</b> },
  ];
  const linkText = (r) => (r.type === 'BILL' ? r.settled_by.map(x => `${x.number} ${money(x.amount)}`) : r.settles.map(x => `${x.bill_number} ${money(x.amount)}`)).join('; ');

  const exportCsv = () => downloadCsv(`party_ledger_${data.party.code || data.party.name}.csv`,
    ['Date', 'Type', 'Document No', 'Ref', 'Description', 'Bill Amount', 'Paid / Received', 'Balance Due', 'Settled By / Settles'],
    [['', 'Opening', '', '', 'Opening balance', '', '', data.opening_balance, ''],
      ...data.rows.map(r => [r.date, TYPE_LABEL[r.type] || r.type, r.number, r.ref, r.description, r.bill_amount, r.paid_amount, r.balance, linkText(r)]),
      ['', 'Closing', '', '', 'Closing balance', data.total_billed, data.total_paid, data.closing_balance, '']]);

  const print = () => printReport(async () => printShell({
    title: 'Party Settlement Ledger', company, logo,
    meta: [[PARTY_KIND_LABEL[data.party.kind], `${data.party.name}${data.party.code ? ` (${data.party.code})` : ''}`],
      ['Period', `${data.date_from ? formatDate(data.date_from) : '…'} to ${data.date_to ? formatDate(data.date_to) : '…'}`]],
    body: `${printCards([['OPENING', money(data.opening_balance)], ['BILLED', money(data.total_billed)], ['PAID / RECEIVED', money(data.total_paid)],
      ['CLOSING BALANCE', money(data.closing_balance)], ['OPEN BILLS DUE', money(data.outstanding_bills)]])}
      <table><thead><tr><th>Date</th><th>Type</th><th>Document</th><th>Description</th><th class="r">Bill Amount</th><th class="r">Paid</th><th class="r">Balance</th><th>Settled by / Settles</th></tr></thead>
      <tbody><tr><td></td><td colspan="5"><b>Opening balance</b></td><td class="r"><b>${esc(money(data.opening_balance))}</b></td><td></td></tr>
      ${data.rows.map(r => `<tr><td class="nw">${esc(r.date ? formatDate(r.date) : '')}</td><td>${esc(TYPE_LABEL[r.type] || r.type)}</td>
        <td class="nw"><b>${esc(r.number)}</b>${r.ref ? `<br><small>${esc(r.ref)}</small>` : ''}</td><td>${esc(r.description)}</td>
        <td class="r">${esc(money(r.bill_amount))}</td><td class="r">${esc(money(r.paid_amount))}</td><td class="r">${esc(money(r.balance))}</td>
        <td><small>${esc(linkText(r))}</small></td></tr>`).join('')}
      <tr class="tot"><td colspan="4">Closing balance</td><td class="r">${esc(money(data.total_billed))}</td><td class="r">${esc(money(data.total_paid))}</td><td class="r">${esc(money(data.closing_balance))}</td><td></td></tr>
      </tbody></table>`,
  }), (e) => notify(apiError(e, 'Could not print.'), 'error'));

  return (
    <Box>
      <Box component="form" onSubmit={(e) => { e.preventDefault(); load(); }} sx={filterBarSx}>
        <TextField size="small" label="Party *" value={party ? `${party.name}${party.code ? ` (${party.code})` : ''}` : ''} placeholder="Choose a customer, dealer or supplier"
          InputProps={{ readOnly: true }} InputLabelProps={{ shrink: true }} sx={{ ...fieldSx, minWidth: 260, flex: 1 }}
          onKeyDown={(e) => { if (e.key === 'F1' || e.key === 'Enter') { e.preventDefault(); setPicking('RV'); } }} />
        <Button variant="outlined" onClick={() => setPicking('RV')} sx={{ fontWeight: 700 }}>Customer / Dealer</Button>
        <Button variant="outlined" onClick={() => setPicking('PV')} sx={{ fontWeight: 700 }}>Supplier</Button>
        <TextField type="date" size="small" label="From" value={dates.from} InputLabelProps={{ shrink: true }} onChange={(e) => setDates(d => ({ ...d, from: e.target.value }))} sx={{ ...fieldSx, width: 160 }} />
        <TextField type="date" size="small" label="To" value={dates.to} InputLabelProps={{ shrink: true }} onChange={(e) => setDates(d => ({ ...d, to: e.target.value }))} sx={{ ...fieldSx, width: 160 }} />
        <Button type="submit" variant="contained" disabled={!party} sx={{ fontWeight: 700, bgcolor: NAVY }}>Apply</Button>
        <Button variant="outlined" startIcon={<PrintIcon />} onClick={print} disabled={!data} sx={{ fontWeight: 700 }}>Print</Button>
        <Button variant="outlined" startIcon={<ExcelIcon />} disabled={!data}
          onClick={() => downloadXlsx('settlements/party-ledger/', params(), `party_ledger_${data.party.code || 'party'}.xlsx`)} sx={{ fontWeight: 700 }}>Excel</Button>
        <Button variant="text" startIcon={<CsvIcon />} onClick={exportCsv} disabled={!data} sx={{ fontWeight: 700 }}>CSV</Button>
      </Box>

      {!party && <Alert severity="info">Choose a party (F1 on the Party field) to see their bills, receipts / payments and which voucher settled which bill.</Alert>}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {data && (
        <Grid container spacing={1.5} sx={{ mb: 2 }}>
          <Grid item xs={6} md={2.4}><SummaryCard label="OPENING" value={data.opening_balance} accent="#64748b" /></Grid>
          <Grid item xs={6} md={2.4}><SummaryCard label="BILLED" value={data.total_billed} accent="#2563eb" /></Grid>
          <Grid item xs={6} md={2.4}><SummaryCard label={data.side === 'payable' ? 'PAID' : 'RECEIVED'} value={data.total_paid} accent="#16a34a" /></Grid>
          <Grid item xs={6} md={2.4}><SummaryCard label="CLOSING BALANCE" value={data.closing_balance} accent={NAVY} /></Grid>
          <Grid item xs={12} md={2.4}><SummaryCard label="OPEN BILLS DUE" value={data.outstanding_bills} accent="#dc2626"
            hint={Number(data.outstanding_bills) !== Number(data.closing_balance) ? 'Differs from the balance by advances on account' : undefined} /></Grid>
        </Grid>
      )}
      {data && (
        <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden' }}>
          <Box sx={{ height: 4 }}>{loading && <LinearProgress />}</Box>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell sx={head} width={36} />
                  <TableCell sx={head}>Date</TableCell>
                  <TableCell sx={head}>Type</TableCell>
                  <TableCell sx={head}>Document No</TableCell>
                  <TableCell sx={head}>Description</TableCell>
                  <TableCell sx={head} align="right">Bill Amount</TableCell>
                  <TableCell sx={head} align="right">{data.side === 'payable' ? 'Paid' : 'Received'}</TableCell>
                  <TableCell sx={head} align="right">Balance Due</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                <TableRow sx={{ bgcolor: '#f8fafc' }}>
                  <TableCell /><TableCell colSpan={6} sx={{ fontWeight: 800 }}>Opening balance</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800 }}>{money(data.opening_balance)}</TableCell>
                </TableRow>
                {data.rows.map((r, i) => {
                  const links = r.type === 'BILL' ? r.settled_by : r.settles;
                  const k = `${r.type}-${r.number}-${i}`;
                  const isOpen = !!open[k];
                  return (
                    <Fragment key={k}>
                      <TableRow hover onClick={() => links.length && setOpen(o => ({ ...o, [k]: !o[k] }))} sx={{ cursor: links.length ? 'pointer' : 'default', '& > td': { borderBottom: isOpen ? 'none' : undefined } }}>
                        <TableCell>{links.length ? (isOpen ? <OpenIcon fontSize="small" /> : <ClosedIcon fontSize="small" />) : null}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.date ? formatDate(r.date) : '—'}</TableCell>
                        <TableCell><Chip size="small" label={TYPE_LABEL[r.type] || r.type} color={r.type === 'BILL' ? 'primary' : 'success'} variant="outlined" sx={{ height: 20, fontWeight: 700 }} /></TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>
                          <Typography variant="body2" fontFamily="monospace" fontWeight={700}>{r.number}</Typography>
                          {r.ref && <Typography variant="caption" color="text.secondary">{r.ref}</Typography>}
                        </TableCell>
                        <TableCell>
                          {r.description}
                          {r.settlement && (
                            <Tooltip title="View settlement breakdown">
                              <IconButton size="small" onClick={(e) => { e.stopPropagation(); onBreakdown({ number: r.settlement }); }} aria-label="View settlement breakdown">
                                <ViewIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          )}
                        </TableCell>
                        <TableCell align="right">{money(r.bill_amount)}</TableCell>
                        <TableCell align="right">{money(r.paid_amount)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 800 }}>{money(r.balance)}</TableCell>
                      </TableRow>
                      <TableRow>
                        <TableCell colSpan={8} sx={{ p: 0, borderBottom: isOpen ? undefined : 'none' }}>
                          <Collapse in={isOpen} unmountOnExit>
                            <Box sx={{ px: 6, py: 1, bgcolor: '#f8fafc' }}>
                              <Typography variant="caption" fontWeight={800} color="text.secondary">{r.type === 'BILL' ? 'SETTLED BY' : 'SETTLES'}</Typography>
                              {links.map((x, j) => (
                                <Typography key={j} variant="body2">
                                  {r.type === 'BILL'
                                    ? <>{x.kind === 'at_entry' ? 'Paid at entry' : x.kind === 'return' ? `Return ${x.number}` : x.number}{x.receipt && x.receipt !== x.number ? ` (${x.receipt})` : ''} · {x.date ? formatDate(x.date) : ''} · <b>{money(x.amount)}</b></>
                                    : <>{x.bill_number} · <b>{money(x.amount)}</b></>}
                                </Typography>
                              ))}
                            </Box>
                          </Collapse>
                        </TableCell>
                      </TableRow>
                    </Fragment>
                  );
                })}
                <TableRow sx={{ bgcolor: '#eef2ff' }}>
                  <TableCell /><TableCell colSpan={4} sx={{ fontWeight: 850 }}>Closing balance</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 850 }}>{money(data.total_billed)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 850 }}>{money(data.total_paid)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 850 }}>{money(data.closing_balance)}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      <VoucherSearchDialog
        open={!!picking}
        title={picking === 'PV' ? 'Select Supplier' : 'Select Customer / Dealer'}
        placeholder="Search by code, name, mobile or area…"
        columns={partyColumns}
        rowKey={(p) => `${p.kind}:${p.id}`}
        fetchRows={fetchParties}
        toggle={{ label: 'Only with dues', default: false }}
        onClose={() => setPicking(null)}
        onSelect={(p) => { setPicking(null); setOpen({}); setParty(p); }}
      />
    </Box>
  );
}

export default function SettlementStatement() {
  const storeProfile = useStoreProfile();
  const company = companyFromProfile(storeProfile);
  const [view, setView] = useState('vouchers');
  const [breakdown, setBreakdown] = useState(null);
  return (
    <ReportCard title="Bill-to-Bill Settlement Statement"
      subtitle="Which Receipt / Payment Voucher settled which bill: payment sources, bills closed or part-paid, and each party's running balance.">
      <Tabs value={view} onChange={(e, v) => setView(v)} sx={{ mb: 2, '& .MuiTab-root': { fontWeight: 700, textTransform: 'none' } }}>
        <Tab value="vouchers" label="Voucher-wise Settlements" />
        <Tab value="party" label="Party Ledger Statement" />
      </Tabs>
      {view === 'vouchers'
        ? <VouchersView company={company} logo={storeProfile.logo_data_url} />
        : <PartyLedgerView company={company} logo={storeProfile.logo_data_url} onBreakdown={setBreakdown} />}
      <SettlementBreakdownDialog open={!!breakdown} query={breakdown} onClose={() => setBreakdown(null)} />
    </ReportCard>
  );
}
