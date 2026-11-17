import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Box, Paper, Typography, Tabs, Tab, Table, TableHead, TableRow, TableCell, TableBody, TextField, Button, Alert,
  Stack, LinearProgress,
} from '@mui/material';
import { Download as DownloadIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../utils/apiError';
import { formatNumber } from '../utils/localeFormat';
import { salesSummaryTable, stockSummaryTable } from '../utils/companies';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => `${today().slice(0, 8)}01`;
const money = (v, currency) => (v === null || v === undefined ? '—' : `${currency ? `${currency} ` : ''}${formatNumber(v)}`);

/**
 * Phase 2 — read-only group summaries across the companies the organization administrator can
 * access: sales for a period and stock on hand. They read each company's own records; they are
 * not consolidated accounts and never post or change anything.
 */
export default function ConsolidatedSummary() {
  const { user } = useAuth();
  const [tab, setTab] = useState(0);
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());
  const [sales, setSales] = useState(null);
  const [stock, setStock] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError('');
    try {
      if (tab === 0) {
        const res = await axios.get('/api/organization/reports/sales-summary/', { params: { date_from: from, date_to: to } });
        setSales(salesSummaryTable(res.data));
      } else {
        const res = await axios.get('/api/organization/reports/stock-summary/');
        setStock(stockSummaryTable(res.data));
      }
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load the summary.'));
    } finally {
      setBusy(false);
    }
  }, [tab, from, to]);
  useEffect(() => { load(); }, [tab]); // eslint-disable-line react-hooks/exhaustive-deps

  const download = async () => {
    const url = tab === 0 ? '/api/organization/reports/sales-summary/' : '/api/organization/reports/stock-summary/';
    const params = tab === 0 ? { date_from: from, date_to: to, export: 'csv' } : { export: 'csv' };
    try {
      const res = await axios.get(url, { params, responseType: 'blob' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(res.data);
      link.download = tab === 0 ? `sales-summary-${from}-${to}.csv` : `stock-summary-${today()}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not download the file.'));
    }
  };

  if (!user?.is_org_admin) {
    return <Box sx={{ p: 4 }}><Alert severity="info">Only an organization administrator can open the group summary.</Alert></Box>;
  }
  const table = tab === 0 ? sales : stock;

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Typography variant="h5" fontWeight={800}>Group summary</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        A read-only summary of each company&apos;s own records. Not consolidated accounts.
      </Typography>
      <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Sales" />
        <Tab label="Stock" />
      </Tabs>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mb: 2 }} alignItems={{ sm: 'center' }}>
        {tab === 0 && (
          <>
            <TextField size="small" type="date" label="From" value={from} onChange={(e) => setFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
            <TextField size="small" type="date" label="To" value={to} onChange={(e) => setTo(e.target.value)} InputLabelProps={{ shrink: true }} />
          </>
        )}
        <Button startIcon={<RefreshIcon />} onClick={load} disabled={busy}>Refresh</Button>
        <Button startIcon={<DownloadIcon />} onClick={download} disabled={busy}>Download CSV</Button>
      </Stack>
      {busy && <LinearProgress sx={{ mb: 1 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {table?.mixedCurrency && <Alert severity="warning" sx={{ mb: 2 }}>The companies use different currencies, so no total is shown.</Alert>}
      {table?.excluded?.length > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          Not included: {table.excluded.map((e) => `${e.name} (${e.reason})`).join('; ')}
        </Alert>
      )}
      {table && (
        <Paper variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
          {tab === 0 ? <SalesTable table={table} /> : <StockTable table={table} />}
        </Paper>
      )}
    </Box>
  );
}

function SalesTable({ table }) {
  const line = (r, bold) => (
    <TableRow key={r.key} sx={bold ? { '& td': { fontWeight: 800 } } : undefined}>
      <TableCell>{r.name}</TableCell>
      <TableCell align="right">{r.retailInvoices}</TableCell>
      <TableCell align="right">{money(r.retailTotal, r.currency)}</TableCell>
      <TableCell align="right">{r.wholesaleInvoices}</TableCell>
      <TableCell align="right">{money(r.wholesaleTotal, r.currency)}</TableCell>
      <TableCell align="right">{money(r.returnsTotal, r.currency)}</TableCell>
      <TableCell align="right">{money(r.netSales, r.currency)}</TableCell>
    </TableRow>
  );
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Company</TableCell><TableCell align="right">Retail bills</TableCell><TableCell align="right">Retail sales</TableCell>
          <TableCell align="right">Wholesale bills</TableCell><TableCell align="right">Wholesale sales</TableCell>
          <TableCell align="right">Returns</TableCell><TableCell align="right">Net sales</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {table.rows.map((r) => line(r, false))}
        {table.totals && line(table.totals, true)}
      </TableBody>
    </Table>
  );
}

function StockTable({ table }) {
  const line = (r, bold) => (
    <TableRow key={r.key} sx={bold ? { '& td': { fontWeight: 800 } } : undefined}>
      <TableCell>{r.name}</TableCell>
      <TableCell align="right">{r.products}</TableCell>
      <TableCell align="right">{r.unitsOnHand}</TableCell>
      <TableCell align="right">{r.lowStock}</TableCell>
      <TableCell align="right">{r.outOfStock}</TableCell>
      <TableCell align="right">{money(r.valueRetail, r.currency)}</TableCell>
      <TableCell align="right">{r.valueCost === null ? 'Hidden' : money(r.valueCost, r.currency)}</TableCell>
    </TableRow>
  );
  return (
    <Table size="small">
      <TableHead>
        <TableRow>
          <TableCell>Company</TableCell><TableCell align="right">Products</TableCell><TableCell align="right">Units on hand</TableCell>
          <TableCell align="right">Low stock</TableCell><TableCell align="right">Out of stock</TableCell>
          <TableCell align="right">Value (selling price)</TableCell><TableCell align="right">Value (cost)</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {table.rows.map((r) => line(r, false))}
        {table.totals && line(table.totals, true)}
      </TableBody>
    </Table>
  );
}
