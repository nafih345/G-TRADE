// Financial → Statements: every book and final account from one screen, read from
// GET /api/financial/statements/ (financial/statements.py). The server answers every statement in
// one shape — header, summary cards, notes and tables of {cells, style, level, ref} rows — so this
// screen renders, prints and exports any of them the same way. Excel comes from the server
// (?export=xlsx); PDF is the print view saved as PDF. A voucher number opens ShowBillDialog, and
// an account row in the Chart of Accounts / Trial Balance / P&L drills into its Ledger Statement.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Alert, Autocomplete, Box, Button, Checkbox, Chip, FormControlLabel, Grid, LinearProgress, Link, ListSubheader,
  MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import {
  FilterAlt as ApplyIcon, Print as PrintIcon, PictureAsPdf as PdfIcon, GridOn as ExcelIcon,
  CheckCircle as BalancedIcon, Warning as UnbalancedIcon,
} from '@mui/icons-material';
import { FIN_API, apiError, finGet } from './financialApi';
import ShowBillDialog from './ShowBillDialog';
import { useBranch } from '../../context/BranchContext';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { formatDate, formatMoney } from '../../utils/localeFormat';
import { notify } from '../../utils/notify';
import {
  NAVY, head, ymd, todayYmd, monthStart, fyStart, esc, printReport, printShell, printCards, SummaryCard,
  filterBarSx, fieldSx,
} from '../accounts/reportKit';

const PRESETS = [
  ['today', 'Today'], ['yesterday', 'Yesterday'], ['week', 'This Week'], ['month', 'This Month'],
  ['fy', 'This Financial Year'], ['custom', 'Custom Range'],
];
const presetRange = (key) => {
  const d = new Date();
  if (key === 'today') return [todayYmd(), todayYmd()];
  if (key === 'yesterday') { d.setDate(d.getDate() - 1); return [ymd(d), ymd(d)]; }
  if (key === 'week') { const s = new Date(d); s.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return [ymd(s), todayYmd()]; }
  if (key === 'month') return [monthStart(), todayYmd()];
  if (key === 'fy') return [fyStart(), todayYmd()];
  return null;
};

// Statements whose From date is not used: the trial balance summary is "as on" the To date.
const asOnOnly = (f) => f.type === 'trial_balance' && f.tbMode !== 'detailed';
const STATUS_OPTIONS = ['PENDING', 'DEPOSITED', 'CLEARED', 'BOUNCED', 'CANCELLED'];

const defaultFilters = () => {
  const [from, to] = presetRange('month');
  return {
    type: 'chart_of_accounts', preset: 'month', dateFrom: from, dateTo: to, branch: 'all',
    scope: 'ALL', accountGroup: '', coaAccount: '', hideZero: false,
    voucherType: 'ALL', origin: 'all', showReversed: false,
    cashAccount: '', bankAccount: '', chequeDirection: '', chequeStatus: '',
    ledgerAccount: '', tbMode: 'summary', compare: false, layout: 'vertical', source: '',
  };
};

function toParams(f) {
  const p = { type: f.type, from_date: asOnOnly(f) ? '' : f.dateFrom, to_date: f.dateTo, branch: f.branch };
  switch (f.type) {
    case 'chart_of_accounts':
      return { ...p, scope: f.scope, account_group: f.accountGroup, account_id: f.coaAccount, hide_zero: f.hideZero ? 1 : '' };
    case 'vouchers':
      return { ...p, voucher_type: f.voucherType, origin: f.origin, show_reversed: f.showReversed ? 1 : '' };
    case 'day_book':
      return { ...p, show_reversed: f.showReversed ? 1 : '' };
    case 'cash_book':
      return { ...p, account_id: f.cashAccount, show_reversed: f.showReversed ? 1 : '' };
    case 'bank_book':
      return { ...p, account_id: f.bankAccount, show_reversed: f.showReversed ? 1 : '' };
    case 'cheque_register':
      return { ...p, direction: f.chequeDirection, status: f.chequeStatus, account_id: f.bankAccount === 'all' ? '' : f.bankAccount };
    case 'ledger':
      return { ...p, account_id: f.ledgerAccount };
    case 'trial_balance':
      return { ...p, mode: f.tbMode };
    case 'profit_loss':
      return { ...p, compare: f.compare ? 1 : '' };
    case 'balance_sheet':
      return { ...p, layout: f.layout };
    case 'accounting_integration':
      return { ...p, source: f.source };
    default:
      return p;
  }
}

const n = (v) => parseFloat(v) || 0;
const drcr = (v) => (v === null || v === undefined || v === '' ? '' : n(v) === 0 ? formatMoney(0)
  : `${formatMoney(Math.abs(n(v)))} ${n(v) > 0 ? 'Dr' : 'Cr'}`);

/** Display text of one cell (screen, print and the PDF share it). */
function cellText(value, format) {
  if (value === null || value === undefined || value === '') return '';
  switch (format) {
    case 'money': return formatMoney(value);
    case 'drcr': return drcr(value);
    case 'date': return formatDate(value);
    case 'percent': return `${value}%`;
    default: return String(value);
  }
}
const isNumeric = (format) => ['money', 'drcr', 'count', 'percent'].includes(format);
const LABEL_KEYS = ['name', 'particulars', 'source', 'status', 'bank', 'mode', 'narration'];

// The column a row's level indents: the first text column named like a label.
const labelColumn = (columns) => (columns.find(c => LABEL_KEYS.includes(c.key)) || columns[0])?.key;

const ROW_SX = {
  section: { bgcolor: '#eef2ff', '& td': { fontWeight: 850, color: '#3730a3', textTransform: 'uppercase', letterSpacing: 0.4 } },
  group: { bgcolor: '#f8fafc', '& td': { fontWeight: 750 } },
  parent: { '& td': { fontWeight: 700 } },
  subtotal: { bgcolor: '#f1f5f9', '& td': { fontWeight: 800, borderTop: '1px solid #94a3b8' } },
  result: { bgcolor: '#ecfdf5', '& td': { fontWeight: 850, color: NAVY, borderTop: `2px solid ${NAVY}` } },
  opening: { bgcolor: '#fffbeb', '& td': { fontWeight: 750, fontStyle: 'italic' } },
  closing: { bgcolor: '#fffbeb', '& td': { fontWeight: 800 } },
  info: { '& td': { fontStyle: 'italic', color: 'text.secondary' } },
  muted: { '& td': { color: '#94a3b8' } },
  total: { bgcolor: '#e2e8f0', '& td': { fontWeight: 850, color: NAVY, borderTop: `2px solid ${NAVY}` } },
};
const PAGE = 500;

function StatementTable({ table, onVoucher, onAccount }) {
  const [shown, setShown] = useState(PAGE);
  useEffect(() => setShown(PAGE), [table]);
  const labelKey = labelColumn(table.columns);
  const rows = table.rows.slice(0, shown);

  const renderRow = (r, i, footer) => (
    <TableRow key={`${footer ? 'f' : 'r'}${i}`} hover={!footer && !r.style} sx={ROW_SX[r.style] || {}}>
      {table.columns.map((c) => {
        const v = r.cells[c.key];
        let content = cellText(v, c.format);
        if (c.format === 'voucher' && r.ref?.entry_id && v) {
          content = <Link component="button" type="button" underline="hover" fontWeight={700} onClick={() => onVoucher(r.ref)}>{v}</Link>;
        } else if (c.key === labelKey && r.account_id && onAccount) {
          content = <Link component="button" type="button" underline="hover" color="inherit" sx={{ fontWeight: 'inherit', textAlign: 'left' }}
            onClick={() => onAccount(r.account_id)} title="Open ledger statement">{content}</Link>;
        }
        const negative = ['money'].includes(c.format) && n(v) < 0;
        return (
          <TableCell key={c.key} align={isNumeric(c.format) ? 'right' : 'left'}
            sx={{ whiteSpace: isNumeric(c.format) || c.format === 'date' ? 'nowrap' : 'normal', py: 0.75,
              ...(negative ? { color: '#b91c1c' } : {}),
              ...(c.key === labelKey ? { pl: 2 + (r.level || 0) * 2 } : {}) }}>
            {content}
          </TableCell>
        );
      })}
    </TableRow>
  );

  return (
    <Paper variant="outlined" sx={{ borderRadius: 2, overflow: 'hidden', height: '100%' }}>
      {table.title && (
        <Typography fontWeight={850} sx={{ px: 2, py: 1.25, color: NAVY, borderBottom: '1px solid #e2e8f0' }}>{table.title}</Typography>
      )}
      <TableContainer sx={{ maxHeight: 640 }}>
        <Table size="small" stickyHeader>
          <TableHead>
            <TableRow>
              {table.columns.map(c => <TableCell key={c.key} sx={head} align={isNumeric(c.format) ? 'right' : 'left'}>{c.label}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && (
              <TableRow><TableCell colSpan={table.columns.length} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                No entries for this selection.
              </TableCell></TableRow>
            )}
            {rows.map((r, i) => renderRow(r, i, false))}
            {shown >= table.rows.length && table.footer.map((r, i) => renderRow(r, i, true))}
          </TableBody>
        </Table>
      </TableContainer>
      {shown < table.rows.length && (
        <Stack direction="row" alignItems="center" gap={1} sx={{ px: 2, py: 1, borderTop: '1px solid #e2e8f0' }}>
          <Typography variant="body2" color="text.secondary">Showing {shown} of {table.rows.length} rows (print and exports include all).</Typography>
          <Button size="small" onClick={() => setShown(s => s + 2000)}>Show more</Button>
          <Button size="small" onClick={() => setShown(table.rows.length)}>Show all</Button>
        </Stack>
      )}
    </Paper>
  );
}

const periodLabel = (data) => {
  if (!data) return '';
  if (!data.date_from) return `As on ${formatDate(data.date_to)}`;
  return data.date_from === data.date_to ? formatDate(data.date_from) : `${formatDate(data.date_from)} to ${formatDate(data.date_to)}`;
};

function printTable(t) {
  const labelKey = labelColumn(t.columns);
  const line = (r, cls) => `<tr class="${cls || ''} st-${r.style || ''}">${t.columns.map(c => {
    const text = cellText(r.cells[c.key], c.format);
    const pad = c.key === labelKey && r.level ? ` style="padding-left:${6 + r.level * 12}px"` : '';
    return `<td class="${isNumeric(c.format) ? 'r' : ''}${c.format === 'money' && n(r.cells[c.key]) < 0 ? ' neg' : ''}"${pad}>${esc(text)}</td>`;
  }).join('')}</tr>`;
  return `${t.title ? `<h3>${esc(t.title)}</h3>` : ''}<table>
    <thead><tr>${t.columns.map(c => `<th class="${isNumeric(c.format) ? 'r' : ''}">${esc(c.label)}</th>`).join('')}</tr></thead>
    <tbody>${t.rows.map(r => line(r)).join('') || `<tr><td colspan="${t.columns.length}" style="text-align:center;color:#64748b">No entries.</td></tr>`}
    ${t.footer.map(r => line(r, 'tot')).join('')}</tbody></table>`;
}

const PRINT_CSS = `<style>
  tr.st-section td { background:#eef2ff; color:#3730a3; font-weight:800; text-transform:uppercase; }
  tr.st-group td { background:#f8fafc; font-weight:700; } tr.st-parent td { font-weight:700; }
  tr.st-subtotal td { background:#f1f5f9; font-weight:800; border-top:1px solid #64748b; }
  tr.st-result td { background:#ecfdf5; font-weight:800; border-top:2px solid ${NAVY}; }
  tr.st-opening td, tr.st-closing td { background:#fffbeb; font-weight:700; }
  tr.st-info td { font-style:italic; color:#64748b; } tr.st-muted td { color:#94a3b8; }
  .side { display:grid; grid-template-columns:1fr 1fr; gap:12px; align-items:start; }
  .bal { font-weight:800; margin:6px 0; } .bal.ok { color:#15803d; } .bal.bad { color:#b91c1c; }
</style>`;

export default function FinancialStatements() {
  const { multiBranchEnabled, branches, isAdmin } = useBranch();
  const storeProfile = useStoreProfile();
  const company = useMemo(() => companyFromProfile(storeProfile), [storeProfile]);
  const [options, setOptions] = useState(null);
  const [draft, setDraft] = useState(defaultFilters);
  const [applied, setApplied] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [billRow, setBillRow] = useState(null);

  useEffect(() => {
    finGet('statements/options/').then(setOptions).catch(e => setError(apiError(e, 'Could not load the statement options.')));
  }, []);

  const run = useCallback(async (f) => {
    setDraft(f);
    setApplied(f);
    setLoading(true);
    setError('');
    try {
      setData(await finGet('statements/', toParams(f)));
    } catch (e) {
      setData(null);
      setError(apiError(e, 'Could not generate the statement.'));
    }
    setLoading(false);
  }, []);

  useEffect(() => { run(defaultFilters()); }, [run]);

  const set = (key) => (e) => {
    const value = e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e;
    setDraft(d => {
      const next = { ...d, [key]: value };
      if (key === 'preset' && value !== 'custom') [next.dateFrom, next.dateTo] = presetRange(value);
      if (key === 'dateFrom' || key === 'dateTo') next.preset = 'custom';
      if (key === 'scope') { next.accountGroup = ''; next.coaAccount = ''; }
      return next;
    });
  };

  const dirty = applied && JSON.stringify(applied) !== JSON.stringify(draft);
  const accounts = options?.accounts || [];
  const accountById = useMemo(() => Object.fromEntries(accounts.map(a => [a.id, a])), [accounts]);
  const accountLabel = (a) => (a ? `${a.code} - ${a.name}` : '');

  // Chart of Accounts drill-down: the scope narrows the groups and accounts offered.
  const scopeTypes = { ASSETS: 'Asset', LIABILITIES: 'Liability', EQUITY: 'Equity', INCOME: 'Income', EXPENSES: 'Expense' };
  const scopeInfo = (options?.scopes || []).find(s => s.value === draft.scope);
  const scopeType = scopeTypes[draft.scope] || scopeTypes[scopeInfo?.parent];
  const scopedAccounts = accounts.filter(a => draft.scope === 'ALL' || (scopeType && a.account_type === scopeType
    && (!scopeInfo?.parent || a.scope === draft.scope)));
  const scopedGroups = (options?.groups || []).filter(g => !scopeType || g.account_type === scopeType);

  const openLedger = (accountId) => run({ ...draft, type: 'ledger', ledgerAccount: accountId });

  const fileBase = data ? `${data.type}_${data.date_from || 'as-on'}_${data.date_to}` : 'statement';

  const buildPrint = (asPdf) => {
    const meta = [['Statement', data.entity], ['Period', periodLabel(data)], ['Branch', data.branch?.label || 'All branches']];
    const cards = printCards(data.summary.map(s => [s.label, s.format === 'count' ? String(s.value ?? 0)
      : s.format === 'percent' ? cellText(s.value, 'percent') : cellText(s.value ?? 0, s.format)]));
    const bal = data.balanced === null || data.balanced === undefined ? ''
      : `<div class="bal ${data.balanced ? 'ok' : 'bad'}">${data.balanced ? '✓ Debits equal credits — statement balances.' : `✗ Out of balance by ${esc(formatMoney(data.difference))}`}</div>`;
    const tables = data.layout === 'horizontal' && data.tables.length === 2
      ? `<div class="side">${data.tables.map(t => `<div>${printTable(t)}</div>`).join('')}</div>`
      : data.tables.map(printTable).join('');
    const notes = data.notes.map(x => `<p style="color:#64748b;margin:4px 0">${esc(x)}</p>`).join('');
    const html = printShell({
      title: asPdf ? fileBase : data.title, company, logo: storeProfile.logo_data_url, meta,
      body: `${PRINT_CSS}<h2 style="margin-top:0">${esc(data.title)}</h2>${cards}${bal}${tables}${notes}`,
      landscape: data.tables.some(t => t.columns.length > 6),
      footNote: asPdf ? 'Choose "Save as PDF" as the printer to keep this statement as a PDF file.' : '',
    });
    return html;
  };

  const print = (asPdf) => printReport(() => buildPrint(asPdf), (e) => notify(apiError(e, 'Could not print the statement.'), 'error'));

  const exportExcel = async () => {
    setBusy(true);
    try {
      const res = await axios.get(`${FIN_API}/statements/`, { params: { ...toParams(applied), export: 'xlsx' }, responseType: 'blob' });
      const url = URL.createObjectURL(res.data);
      Object.assign(document.createElement('a'), { href: url, download: `${fileBase}.xlsx` }).click();
      URL.revokeObjectURL(url);
    } catch (e) {
      let msg = 'Could not export the statement.';
      try { msg = JSON.parse(await e?.response?.data?.text())?.error || msg; } catch { /* not JSON */ }
      notify(msg, 'error');
    }
    setBusy(false);
  };

  const statementMenu = useMemo(() => {
    const out = [];
    let last = null;
    (options?.statements || []).forEach((s) => {
      if (s.group !== last) { out.push(<ListSubheader key={`h-${s.group}`} sx={{ fontWeight: 800, color: NAVY, lineHeight: '32px' }}>{s.group}</ListSubheader>); last = s.group; }
      out.push(<MenuItem key={s.value} value={s.value} sx={{ pl: 3 }}>{s.label}</MenuItem>);
    });
    return out;
  }, [options]);

  const accountPicker = (key, label, list, required) => (
    <Autocomplete size="small" options={list} value={accountById[draft[key]] || null}
      getOptionLabel={accountLabel} isOptionEqualToValue={(o, v) => o.id === v.id}
      groupBy={(a) => a.account_type}
      onChange={(e, v) => set(key)(v?.id || '')}
      renderInput={(params) => <TextField {...params} label={label} required={required} placeholder="Search code or name" sx={fieldSx} />}
      sx={{ minWidth: 280, flex: '1 1 260px' }} />
  );

  const contextual = () => {
    switch (draft.type) {
      case 'chart_of_accounts':
        return (<>
          <TextField select size="small" label="Classification" value={draft.scope} onChange={set('scope')} sx={{ minWidth: 260, ...fieldSx }}>
            {(options?.scopes || []).map(s => <MenuItem key={s.value} value={s.value} sx={{ pl: s.parent ? 4 : 2, fontWeight: s.parent ? 400 : 700 }}>{s.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Account Group" value={draft.accountGroup} onChange={set('accountGroup')} sx={{ minWidth: 180, ...fieldSx }}>
            <MenuItem value="">All groups</MenuItem>
            {scopedGroups.map(g => <MenuItem key={g.id} value={g.id}>{g.name}</MenuItem>)}
          </TextField>
          {accountPicker('coaAccount', 'Account (with sub-accounts)', scopedAccounts)}
          <FormControlLabel control={<Checkbox size="small" checked={draft.hideZero} onChange={set('hideZero')} />} label="Hide zero balances" />
        </>);
      case 'vouchers':
        return (<>
          <TextField select size="small" label="Voucher Type" value={draft.voucherType} onChange={set('voucherType')} sx={{ minWidth: 190, ...fieldSx }}>
            {(options?.voucher_types || []).map(v => <MenuItem key={v.value} value={v.value}>{v.label}</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Origin" value={draft.origin} onChange={set('origin')} sx={{ minWidth: 170, ...fieldSx }}>
            <MenuItem value="all">Manual + automated</MenuItem>
            <MenuItem value="manual">Manual vouchers</MenuItem>
            <MenuItem value="auto">Auto-posted</MenuItem>
          </TextField>
          <FormControlLabel control={<Checkbox size="small" checked={draft.showReversed} onChange={set('showReversed')} />} label="Show reversed" />
        </>);
      case 'day_book':
        return <FormControlLabel control={<Checkbox size="small" checked={draft.showReversed} onChange={set('showReversed')} />} label="Show reversed" />;
      case 'cash_book':
        return (<>
          <TextField select size="small" label="Cash Account" value={draft.cashAccount} onChange={set('cashAccount')} sx={{ minWidth: 230, ...fieldSx }}>
            <MenuItem value="">Default cash account</MenuItem>
            <MenuItem value="all">All cash accounts</MenuItem>
            {(options?.cash_accounts || []).map(a => <MenuItem key={a.id} value={a.id}>{accountLabel(a)}</MenuItem>)}
          </TextField>
          <FormControlLabel control={<Checkbox size="small" checked={draft.showReversed} onChange={set('showReversed')} />} label="Show reversed" />
        </>);
      case 'bank_book':
      case 'cheque_register':
        return (<>
          <TextField select size="small" label="Bank Account" value={draft.bankAccount} onChange={set('bankAccount')} sx={{ minWidth: 230, ...fieldSx }}>
            <MenuItem value="">{draft.type === 'bank_book' ? 'Default bank account' : 'All bank accounts'}</MenuItem>
            {draft.type === 'bank_book' && <MenuItem value="all">All bank accounts</MenuItem>}
            {(options?.bank_accounts || []).map(a => <MenuItem key={a.id} value={a.id}>{a.label || accountLabel(a)}</MenuItem>)}
          </TextField>
          {draft.type === 'bank_book' ? (
            <FormControlLabel control={<Checkbox size="small" checked={draft.showReversed} onChange={set('showReversed')} />} label="Show reversed" />
          ) : (<>
            <TextField select size="small" label="Type" value={draft.chequeDirection} onChange={set('chequeDirection')} sx={{ minWidth: 140, ...fieldSx }}>
              <MenuItem value="">Issued + received</MenuItem>
              <MenuItem value="RECEIVED">Received</MenuItem>
              <MenuItem value="ISSUED">Issued</MenuItem>
            </TextField>
            <TextField select size="small" label="Status" value={draft.chequeStatus} onChange={set('chequeStatus')} sx={{ minWidth: 140, ...fieldSx }}>
              <MenuItem value="">All statuses</MenuItem>
              {(options?.cheque_statuses || STATUS_OPTIONS.map(s => ({ value: s, label: s }))).map(s => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
            </TextField>
          </>)}
        </>);
      case 'ledger':
        return accountPicker('ledgerAccount', 'Ledger Account', accounts, true);
      case 'trial_balance':
        return (
          <TextField select size="small" label="Format" value={draft.tbMode} onChange={set('tbMode')} sx={{ minWidth: 220, ...fieldSx }}>
            <MenuItem value="summary">Summary (closing balances)</MenuItem>
            <MenuItem value="detailed">Detailed (opening · period · closing)</MenuItem>
          </TextField>
        );
      case 'profit_loss':
        return <FormControlLabel control={<Checkbox size="small" checked={draft.compare} onChange={set('compare')} />} label="Compare with previous period" />;
      case 'balance_sheet':
        return (
          <TextField select size="small" label="Layout" value={draft.layout} onChange={set('layout')} sx={{ minWidth: 200, ...fieldSx }}>
            <MenuItem value="vertical">Vertical</MenuItem>
            <MenuItem value="horizontal">Horizontal (T-format)</MenuItem>
          </TextField>
        );
      case 'accounting_integration':
        return (
          <TextField select size="small" label="Source" value={draft.source} onChange={set('source')} sx={{ minWidth: 220, ...fieldSx }}>
            <MenuItem value="">All automated sources</MenuItem>
            {(options?.sources || []).filter(s => !s.value.startsWith('financial.')).map(s => <MenuItem key={s.value} value={s.value}>{s.label}</MenuItem>)}
          </TextField>
        );
      default:
        return null;
    }
  };

  const submit = (e) => {
    e.preventDefault();
    if (draft.type === 'ledger' && !draft.ledgerAccount) { notify('Choose a ledger account.', 'warning'); return; }
    run(draft);
  };

  const drillable = data && ['chart_of_accounts', 'trial_balance', 'profit_loss', 'balance_sheet'].includes(data.type);
  const sideBySide = data?.layout === 'horizontal' && data.tables.length === 2;

  return (
    <Box>
      <Paper component="form" onSubmit={submit} variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3 }}>
        <Box sx={filterBarSx}>
          <TextField select size="small" label="Statement" value={draft.type} onChange={set('type')} sx={{ minWidth: 260, ...fieldSx }}
            SelectProps={{ MenuProps: { PaperProps: { sx: { maxHeight: 520 } } } }}>
            {statementMenu.length ? statementMenu : <MenuItem value={draft.type}>Loading…</MenuItem>}
          </TextField>
          <TextField select size="small" label="Period" value={draft.preset} onChange={set('preset')} sx={{ minWidth: 175, ...fieldSx }}>
            {PRESETS.map(([k, l]) => <MenuItem key={k} value={k}>{l}</MenuItem>)}
          </TextField>
          {!asOnOnly(draft) && (
            <TextField type="date" size="small" label="From" value={draft.dateFrom} onChange={set('dateFrom')}
              InputLabelProps={{ shrink: true }} sx={{ width: 160, ...fieldSx }} />
          )}
          <TextField type="date" size="small" label={asOnOnly(draft) ? 'As on' : 'To'} value={draft.dateTo} onChange={set('dateTo')}
            InputLabelProps={{ shrink: true }} sx={{ width: 160, ...fieldSx }} />
          {multiBranchEnabled && (
            <TextField select size="small" label="Branch" value={draft.branch} onChange={set('branch')} sx={{ minWidth: 160, ...fieldSx }}>
              <MenuItem value="all">{isAdmin ? 'All Branches' : 'All my branches'}</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          )}
        </Box>
        <Box sx={{ ...filterBarSx, mb: 0 }}>
          {contextual()}
          <Box sx={{ flex: '1 1 auto' }} />
          <Button type="submit" variant="contained" color={dirty ? 'warning' : 'primary'} startIcon={<ApplyIcon />} disabled={loading}
            sx={{ fontWeight: 700, whiteSpace: 'nowrap', ...(dirty ? {} : { bgcolor: NAVY }) }}>Generate Statement</Button>
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={() => print(false)} disabled={!data || loading} sx={{ fontWeight: 700 }}>Print</Button>
          <Button variant="outlined" startIcon={<PdfIcon />} onClick={() => print(true)} disabled={!data || loading} sx={{ fontWeight: 700 }}>PDF</Button>
          <Button variant="outlined" startIcon={<ExcelIcon />} onClick={exportExcel} disabled={!data || loading || busy} sx={{ fontWeight: 700 }}>Excel</Button>
        </Box>
      </Paper>

      {loading && <LinearProgress sx={{ mb: 2 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {dirty && data && <Alert severity="warning" sx={{ mb: 2 }}>Filters changed — press Generate Statement to refresh.</Alert>}

      {data && (
        <Paper variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
          <Box sx={{ px: { xs: 2, md: 3 }, py: 2, borderBottom: '1px solid #e2e8f0' }}>
            <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" gap={1}>
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={800}>{company.name || 'Company'} · {data.branch?.label || 'All branches'}</Typography>
                <Typography variant="h6" fontWeight={850} sx={{ color: NAVY, letterSpacing: 0.3 }}>{data.title.toUpperCase()}</Typography>
                <Typography variant="body2" color="text.secondary">{data.entity}{data.subtitle ? ` · ${data.subtitle}` : ''}</Typography>
              </Box>
              <Stack alignItems={{ md: 'flex-end' }} gap={0.75}>
                <Chip label={periodLabel(data)} sx={{ fontWeight: 700 }} />
                {data.balanced !== null && data.balanced !== undefined && (
                  <Chip size="small" color={data.balanced ? 'success' : 'error'} icon={data.balanced ? <BalancedIcon /> : <UnbalancedIcon />}
                    label={data.balanced ? 'Balanced — Dr = Cr' : `Out of balance by ${formatMoney(data.difference)}`} />
                )}
              </Stack>
            </Stack>
          </Box>
          <Box sx={{ p: { xs: 2, md: 3 }, bgcolor: '#f8fafc' }}>
            {data.summary.length > 0 && (
              <Grid container spacing={1.5} sx={{ mb: 2 }}>
                {data.summary.map(s => (
                  <Grid item xs={6} sm={4} md={2} key={s.label}>
                    <SummaryCard label={s.label.toUpperCase()} plain={s.format !== 'money'}
                      value={s.format === 'drcr' ? drcr(s.value) : s.format === 'percent' ? cellText(s.value, 'percent') : s.value}
                      color={s.format === 'money' && n(s.value) < 0 ? '#b91c1c' : NAVY} />
                  </Grid>
                ))}
              </Grid>
            )}
            {data.notes.map(note => <Alert key={note} severity="info" sx={{ mb: 1.5 }}>{note}</Alert>)}
            {drillable && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>Click an account to open its ledger statement; click a voucher number to view the voucher.</Typography>}
            <Grid container spacing={2}>
              {data.tables.map(t => (
                <Grid item xs={12} md={sideBySide ? 6 : 12} key={t.key}>
                  <StatementTable table={t} onVoucher={setBillRow} onAccount={drillable ? openLedger : null} />
                </Grid>
              ))}
            </Grid>
          </Box>
        </Paper>
      )}

      <ShowBillDialog row={billRow} onClose={() => setBillRow(null)} />
    </Box>
  );
}
