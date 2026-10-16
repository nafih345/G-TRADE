// Financial statements read straight from the posted ledger (/api/financial/reports/*).
// Drafts never appear; every report uses the same cut-off (journal date, POSTED + REVERSED
// entries — a reversal is its own posted entry, so the pair nets to zero).
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Card, Chip, Grid, LinearProgress, Paper, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { Print as PrintIcon, Refresh as RefreshIcon, CheckCircle as CheckIcon, Warning as WarningIcon } from '@mui/icons-material';
import { apiError, finGet, inr, sourceLabel, today } from './financialApi';

const head = { fontWeight: 700 };
const firstOfMonth = () => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().split('T')[0]; };

function useReport(path, params, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try { setData(await finGet(path, params)); } catch (e) { setError(apiError(e)); setData(null); }
    setLoading(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { load(); }, [load]);
  return { data, error, loading, reload: load };
}

function Header({ title, subtitle, children, onRefresh }) {
  return (
    <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} gap={2} sx={{ mb: 3 }}>
      <Box>
        <Typography variant="h6" fontWeight={850}>{title}</Typography>
        {subtitle && <Typography variant="body2" color="text.secondary">{subtitle}</Typography>}
      </Box>
      <Stack direction="row" spacing={1.5} flexWrap="wrap" gap={1} alignItems="center" className="no-print">
        {children}
        {onRefresh && <Button size="small" variant="outlined" startIcon={<RefreshIcon />} onClick={onRefresh}>Refresh</Button>}
        <Button size="small" variant="outlined" startIcon={<PrintIcon />} onClick={() => window.print()}>Print</Button>
      </Stack>
    </Stack>
  );
}

const DateField = ({ label, value, onChange }) => (
  <TextField type="date" size="small" label={label} value={value || ''} onChange={(e) => onChange(e.target.value)}
    InputLabelProps={{ shrink: true }} sx={{ width: 165 }} />
);

const BalancedChip = ({ balanced, difference }) => (balanced
  ? <Chip icon={<CheckIcon />} color="success" label="Balanced" sx={{ fontWeight: 700 }} />
  : <Chip icon={<WarningIcon />} color="error" label={`Out by ${inr(difference)}`} sx={{ fontWeight: 700 }} />);

const Status = ({ loading, error }) => (<>
  {loading && <LinearProgress sx={{ mb: 2 }} />}
  {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
</>);

// ---------------------------------------------------------------------------
// General Ledger
// ---------------------------------------------------------------------------

export function GeneralLedgerPanel({ accounts, accountId, onAccountChange }) {
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const account = accounts.find(a => String(a.id) === String(accountId)) || null;
  const { data, error, loading, reload } = useReport(
    'reports/general-ledger/', { account: accountId, date_from: dateFrom, date_to: dateTo },
    [accountId, dateFrom, dateTo],
  );

  return (
    <Card variant="outlined" sx={{ p: { xs: 2, md: 4 }, borderRadius: 4 }}>
      <Header title="General Ledger Statement" subtitle="Posted journal lines with running balance and source documents."
        onRefresh={accountId ? reload : null}>
        <Autocomplete
          options={accounts}
          value={account}
          onChange={(e, v) => onAccountChange(v ? v.id : '')}
          getOptionLabel={(a) => `${a.code} - ${a.name}`}
          isOptionEqualToValue={(a, b) => String(a.id) === String(b.id)}
          renderInput={(params) => <TextField {...params} size="small" label="Account" />}
          sx={{ width: { xs: '100%', sm: 320 } }}
        />
        <DateField label="From" value={dateFrom} onChange={setDateFrom} />
        <DateField label="To" value={dateTo} onChange={setDateTo} />
      </Header>
      {!accountId ? (
        <Alert severity="info">Select an account to see its ledger. You can also open a ledger from the Chart of Accounts or the Trial Balance.</Alert>
      ) : (<>
        <Status loading={loading} error={accountId && error} />
        {data && (<>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            {[['Opening balance', data.opening_balance], ['Total debit', data.total_debit], ['Total credit', data.total_credit], ['Closing balance', data.closing_balance]].map(([label, val]) => (
              <Grid item xs={6} md={3} key={label}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>{label.toUpperCase()}</Typography>
                  <Typography variant="h6" fontWeight={850}>{inr(val)}</Typography>
                </Paper>
              </Grid>
            ))}
          </Grid>
          <Typography variant="caption" color="text.secondary">
            Balances are shown on the account's normal side ({data.account.normal_balance === 'DEBIT' ? 'debit' : 'credit'}).
          </Typography>
          <TableContainer sx={{ mt: 1, overflowX: 'auto' }}>
            <Table size="small" sx={{ minWidth: 900 }}>
              <TableHead sx={{ bgcolor: '#f8fafc' }}>
                <TableRow>
                  <TableCell sx={head}>Date</TableCell>
                  <TableCell sx={head}>Voucher</TableCell>
                  <TableCell sx={head}>Source</TableCell>
                  <TableCell sx={head}>Narration</TableCell>
                  <TableCell sx={head} align="right">Debit</TableCell>
                  <TableCell sx={head} align="right">Credit</TableCell>
                  <TableCell sx={head} align="right">Balance</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.lines.length === 0 && (
                  <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>No posted lines in this range.</TableCell></TableRow>
                )}
                {data.lines.map(l => (
                  <TableRow key={l.id} hover>
                    <TableCell>{l.date}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: l.is_reversal ? 'warning.main' : 'primary.main' }}>{l.entry_number}</TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>{sourceLabel(l)}</Typography>
                      {l.source_number && <Typography variant="caption" color="text.secondary">{l.source_number}</Typography>}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 320 }}>
                      <Typography variant="body2">{l.narration}</Typography>
                      {l.memo && <Typography variant="caption" color="text.secondary">{l.memo}</Typography>}
                    </TableCell>
                    <TableCell align="right">{parseFloat(l.debit) ? inr(l.debit) : ''}</TableCell>
                    <TableCell align="right">{parseFloat(l.credit) ? inr(l.credit) : ''}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800 }}>{inr(l.balance)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          {data.truncated && <Alert severity="warning" sx={{ mt: 2 }}>Showing the first 2,000 lines — narrow the date range to see the rest.</Alert>}
        </>)}
      </>)}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Trial Balance
// ---------------------------------------------------------------------------

export function TrialBalancePanel({ onOpenLedger }) {
  const [asOf, setAsOf] = useState(today());
  const { data, error, loading, reload } = useReport('reports/trial-balance/', { as_of: asOf }, [asOf]);
  return (
    <Card variant="outlined" sx={{ p: { xs: 2, md: 4 }, borderRadius: 4 }}>
      <Header title="Trial Balance" subtitle="Closing debit / credit balance of every account with posted activity." onRefresh={reload}>
        <DateField label="As of" value={asOf} onChange={setAsOf} />
        {data && <BalancedChip balanced={data.balanced} difference={data.difference} />}
      </Header>
      <Status loading={loading} error={error} />
      {data && (
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 640 }}>
            <TableHead sx={{ bgcolor: '#f8fafc' }}>
              <TableRow>
                <TableCell sx={head}>Account</TableCell>
                <TableCell sx={head}>Type</TableCell>
                <TableCell sx={head} align="right">Debit (₹)</TableCell>
                <TableCell sx={head} align="right">Credit (₹)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.rows.length === 0 && (
                <TableRow><TableCell colSpan={4} align="center" sx={{ py: 5, color: 'text.secondary' }}>Nothing has been posted yet.</TableCell></TableRow>
              )}
              {data.rows.map(r => (
                <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => onOpenLedger?.(r.id)}>
                  <TableCell sx={{ fontWeight: 600 }}>{r.code} - {r.name}</TableCell>
                  <TableCell><Chip size="small" variant="outlined" label={r.account_type} /></TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{parseFloat(r.debit) ? inr(r.debit) : '-'}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 700 }}>{parseFloat(r.credit) ? inr(r.credit) : '-'}</TableCell>
                </TableRow>
              ))}
              <TableRow sx={{ bgcolor: '#f1f5f9' }}>
                <TableCell colSpan={2} sx={{ fontWeight: 850 }}>TOTAL</TableCell>
                <TableCell align="right" sx={{ fontWeight: 850 }}>{inr(data.total_debit)}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 850 }}>{inr(data.total_credit)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Profit & Loss / Balance Sheet
// ---------------------------------------------------------------------------

function SectionTable({ title, groups, total, color, onOpenLedger, extra }) {
  return (
    <Paper variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden', height: '100%' }}>
      <Box sx={{ px: 2, py: 1.5, bgcolor: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between' }}>
        <Typography variant="subtitle1" fontWeight={850} color={color}>{title}</Typography>
        <Typography variant="subtitle1" fontWeight={850}>{inr(total)}</Typography>
      </Box>
      <Table size="small">
        <TableBody>
          {groups.length === 0 && !extra && (
            <TableRow><TableCell sx={{ color: 'text.secondary' }}>No posted balances.</TableCell></TableRow>
          )}
          {groups.map(g => (
            <React.Fragment key={g.group}>
              <TableRow sx={{ bgcolor: '#fbfdff' }}>
                <TableCell sx={{ fontWeight: 800 }}>{g.group}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>{inr(g.total)}</TableCell>
              </TableRow>
              {g.accounts.map(a => (
                <TableRow key={a.id} hover sx={{ cursor: onOpenLedger ? 'pointer' : 'default' }} onClick={() => onOpenLedger?.(a.id)}>
                  <TableCell sx={{ pl: 4 }}>{a.code} - {a.name}</TableCell>
                  <TableCell align="right">{inr(a.amount)}</TableCell>
                </TableRow>
              ))}
            </React.Fragment>
          ))}
          {extra}
        </TableBody>
      </Table>
    </Paper>
  );
}

export function ProfitLossPanel({ onOpenLedger }) {
  const [dateFrom, setDateFrom] = useState(firstOfMonth());
  const [dateTo, setDateTo] = useState(today());
  const { data, error, loading, reload } = useReport('reports/profit-loss/', { date_from: dateFrom, date_to: dateTo }, [dateFrom, dateTo]);
  const profit = parseFloat(data?.net_profit || 0);
  return (
    <Card variant="outlined" sx={{ p: { xs: 2, md: 4 }, borderRadius: 4 }}>
      <Header title="Profit & Loss Statement" subtitle="Revenue less cost of goods sold and expenses, from posted journals in the period." onRefresh={reload}>
        <DateField label="From" value={dateFrom} onChange={setDateFrom} />
        <DateField label="To" value={dateTo} onChange={setDateTo} />
      </Header>
      <Status loading={loading} error={error} />
      {data && (<>
        <Grid container spacing={3}>
          <Grid item xs={12} md={6}>
            <SectionTable title="Income" groups={data.income} total={data.total_income} color="success.main" onOpenLedger={onOpenLedger} />
          </Grid>
          <Grid item xs={12} md={6}>
            <SectionTable title="Expenses (incl. COGS)" groups={data.expenses} total={data.total_expense} color="error.main" onOpenLedger={onOpenLedger} />
          </Grid>
        </Grid>
        <Paper variant="outlined" sx={{ mt: 3, p: 2.5, borderRadius: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderColor: profit >= 0 ? '#10b981' : '#ef4444' }}>
          <Typography variant="h6" fontWeight={850}>{profit >= 0 ? 'Net Profit' : 'Net Loss'}</Typography>
          <Typography variant="h5" fontWeight={850} sx={{ color: profit >= 0 ? '#10b981' : '#ef4444' }}>{inr(Math.abs(profit))}</Typography>
        </Paper>
      </>)}
    </Card>
  );
}

export function BalanceSheetPanel({ onOpenLedger }) {
  const [asOf, setAsOf] = useState(today());
  const { data, error, loading, reload } = useReport('reports/balance-sheet/', { as_of: asOf }, [asOf]);
  return (
    <Card variant="outlined" sx={{ p: { xs: 2, md: 4 }, borderRadius: 4 }}>
      <Header title="Balance Sheet" subtitle="Assets, liabilities and equity from the posted ledger." onRefresh={reload}>
        <DateField label="As of" value={asOf} onChange={setAsOf} />
        {data && <BalancedChip balanced={data.balanced} difference={data.difference} />}
      </Header>
      <Status loading={loading} error={error} />
      {data && (
        <Grid container spacing={3}>
          <Grid item xs={12} md={6}>
            <SectionTable title="Assets" groups={data.assets} total={data.total_assets} color="primary.main" onOpenLedger={onOpenLedger} />
          </Grid>
          <Grid item xs={12} md={6}>
            <Stack spacing={3}>
              <SectionTable title="Liabilities" groups={data.liabilities} total={data.total_liabilities} color="error.main" onOpenLedger={onOpenLedger} />
              <SectionTable title="Equity" groups={data.equity} total={data.total_equity} color="secondary.main" onOpenLedger={onOpenLedger}
                extra={(
                  <TableRow>
                    <TableCell sx={{ fontWeight: 800 }}>Accumulated profit (unclosed)</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800 }}>{inr(data.retained_earnings)}</TableCell>
                  </TableRow>
                )} />
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, display: 'flex', justifyContent: 'space-between' }}>
                <Typography fontWeight={850}>Liabilities + Equity</Typography>
                <Typography fontWeight={850}>{inr(data.total_liabilities_and_equity)}</Typography>
              </Paper>
            </Stack>
          </Grid>
        </Grid>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Financial Reports: source-module breakdown + reconciliation summary
// ---------------------------------------------------------------------------

export function FinancialReportsPanel() {
  const [dateFrom, setDateFrom] = useState(firstOfMonth());
  const [dateTo, setDateTo] = useState(today());
  const breakdown = useReport('reports/source-breakdown/', { date_from: dateFrom, date_to: dateTo }, [dateFrom, dateTo]);
  const recon = useReport('integration/reconciliation/', { date_from: dateFrom, date_to: dateTo }, [dateFrom, dateTo]);
  return (
    <Card variant="outlined" sx={{ p: { xs: 2, md: 4 }, borderRadius: 4 }}>
      <Header title="Financial Reports" subtitle="What each module posted in the period, and how the ledger reconciles with the operational records."
        onRefresh={() => { breakdown.reload(); recon.reload(); }}>
        <DateField label="From" value={dateFrom} onChange={setDateFrom} />
        <DateField label="To" value={dateTo} onChange={setDateTo} />
      </Header>

      <Typography variant="subtitle1" fontWeight={850} sx={{ mb: 1 }}>Postings by source module</Typography>
      <Status loading={breakdown.loading} error={breakdown.error} />
      {breakdown.data && (
        <TableContainer sx={{ mb: 4, overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 600 }}>
            <TableHead sx={{ bgcolor: '#f8fafc' }}>
              <TableRow>
                <TableCell sx={head}>Source</TableCell>
                <TableCell sx={head} align="right">Entries</TableCell>
                <TableCell sx={head} align="right">Posted</TableCell>
                <TableCell sx={head} align="right">Reversed</TableCell>
                <TableCell sx={head} align="right">Net</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {breakdown.data.length === 0 && <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4, color: 'text.secondary' }}>No postings in this period.</TableCell></TableRow>}
              {breakdown.data.map(r => (
                <TableRow key={r.source_key} hover>
                  <TableCell sx={{ fontWeight: 600 }}>{r.label}</TableCell>
                  <TableCell align="right">{r.entries}</TableCell>
                  <TableCell align="right">{inr(r.posted_amount)}</TableCell>
                  <TableCell align="right">{inr(r.reversed_amount)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800 }}>{inr(r.net_amount)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}

      <Typography variant="subtitle1" fontWeight={850} sx={{ mb: 1 }}>Reconciliation</Typography>
      <Status loading={recon.loading} error={recon.error} />
      {recon.data && (<>
        <TableContainer sx={{ mb: 3, overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 700 }}>
            <TableHead sx={{ bgcolor: '#f8fafc' }}>
              <TableRow>
                <TableCell sx={head}>Source documents</TableCell>
                <TableCell sx={head} align="right">Documents</TableCell>
                <TableCell sx={head} align="right">Posted</TableCell>
                <TableCell sx={head} align="right">Missing</TableCell>
                <TableCell sx={head} align="right">Mismatched</TableCell>
                <TableCell sx={head} align="right">Stale</TableCell>
                <TableCell sx={head} align="right">Historical (unposted)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {recon.data.sources.map(s => {
                const issues = s.missing.length + s.mismatched.length + s.stale.length + s.errors.length;
                return (
                  <TableRow key={s.source_key} hover>
                    <TableCell sx={{ fontWeight: 600 }}>{s.label}</TableCell>
                    <TableCell align="right">{s.documents}</TableCell>
                    <TableCell align="right">{s.posted}</TableCell>
                    <TableCell align="right" sx={{ color: s.missing.length ? 'error.main' : undefined, fontWeight: 700 }}>{s.missing.length}</TableCell>
                    <TableCell align="right" sx={{ color: s.mismatched.length ? 'warning.main' : undefined, fontWeight: 700 }}>{s.mismatched.length}</TableCell>
                    <TableCell align="right" sx={{ color: s.stale.length ? 'warning.main' : undefined, fontWeight: 700 }}>{s.stale.length}</TableCell>
                    <TableCell align="right">{s.historical_unposted}{issues === 0 && s.historical_unposted === 0 ? ' ✓' : ''}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
        <TableContainer sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 700 }}>
            <TableHead sx={{ bgcolor: '#f8fafc' }}>
              <TableRow>
                <TableCell sx={head}>Control account</TableCell>
                <TableCell sx={head} align="right">General Ledger</TableCell>
                <TableCell sx={head} align="right">Sub-ledger</TableCell>
                <TableCell sx={head} align="right">Difference</TableCell>
                <TableCell sx={head}>Sub-ledger basis</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {recon.data.subledgers.map(r => (
                <TableRow key={r.name}>
                  <TableCell sx={{ fontWeight: 600 }}>{r.name} {r.account ? `(${r.account})` : ''}</TableCell>
                  <TableCell align="right">{r.ledger !== null ? inr(r.ledger) : '—'}</TableCell>
                  <TableCell align="right">{r.subledger !== null ? inr(r.subledger) : '—'}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800, color: parseFloat(r.difference || 0) ? 'warning.main' : 'success.main' }}>
                    {r.difference !== null ? inr(r.difference) : '—'}
                  </TableCell>
                  <TableCell><Typography variant="caption" color="text.secondary">{r.subledger_source}</Typography></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
          Sub-ledger figures are all-time balances; differences usually mean history from before automated posting was enabled
          (bring it in with Accounting Integration → Reconciliation &amp; backfill, or an opening balance).
        </Typography>
      </>)}
    </Card>
  );
}
