// Reports → Sales & Revenue Hub → Sales Report: every Quotation / Order / Tax Invoice in a date
// range on one screen — customer profile, the eye test it was dispensed against (1st test or
// follow-up), frame / lens / service lines with codes and barcodes, the money breakdown, how it was
// paid and who served the customer — with the original bill one click away. Rows come from
// GET /api/sales/invoices/report/ (apps/sales/sales_report.py), already joined server-side.
import React, { Fragment, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Card, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, Grid,
  IconButton, InputAdornment, LinearProgress, MenuItem, Paper, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import {
  KeyboardArrowDown as ExpandIcon, KeyboardArrowUp as CollapseIcon, Print as PrintIcon,
  ReceiptLong as BillIcon, Refresh as RefreshIcon, Search as SearchIcon, TableChart as ExcelIcon,
  Visibility as EyeIcon,
} from '@mui/icons-material';
import BillPreview from '../../billing/BillPreview';
import { printBill } from '../../billing/printBill';
import { notify } from '../../utils/notify';

const inr = (n) => `₹${(Number(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const monthStart = () => { const d = new Date(); return isoDay(new Date(d.getFullYear(), d.getMonth(), 1)); };

const DOC_TYPES = {
  QUOTATION: { label: 'Quotation', color: 'default', bill: 'QUOTATION' },
  ORDER: { label: 'Sales Order', color: 'warning', bill: 'ORDER_BILL' },
  INVOICE: { label: 'Tax Invoice', color: 'primary', bill: 'SALES_INVOICE' },
};
const PAY_STATUS_COLOR = { PAID: 'success', PARTIAL: 'warning', UNPAID: 'error' };

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

// "1st test" / "Follow-up · 3rd test" for the visit this sale was dispensed against.
const visitLabel = (exam) => {
  if (!exam?.visit_ordinal) return '';
  return exam.is_first_test ? '1st test' : `Follow-up · ${ordinal(exam.visit_ordinal)} test`;
};

// One eye's prescription as "-1.25 / -0.50 × 90 Add +2.00" (blank parts left out).
const rxText = (eye) => {
  if (!eye) return '';
  const sph = eye.sph || '';
  const cyl = eye.cyl ? ` / ${eye.cyl}` : '';
  const axis = eye.axis ? ` × ${eye.axis}` : '';
  const add = eye.add ? ` Add ${eye.add}` : '';
  return `${sph}${cyl}${axis}${add}`.trim();
};

const lineSpec = (l) => [l.brand, l.model && `Model ${l.model}`, l.code && `Code ${l.code}`].filter(Boolean).join(' · ');
const lensSpec = (l) => [l.lens?.index && `Index ${l.lens.index}`, l.lens?.design, l.lens?.coating].filter(Boolean).join(' · ');
const staffOf = (r) => r.salesman || r.created_by || '';
// Time the bill was saved, in the shop's own clock (the server runs on UTC).
const timeOf = (r) => {
  const d = r.created_at ? new Date(r.created_at) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
};

const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;

export default function SalesComprehensiveReport() {
  const [dateFrom, setDateFrom] = useState(monthStart);
  const [dateTo, setDateTo] = useState(() => isoDay(new Date()));
  const [docType, setDocType] = useState('ALL');
  const [payStatus, setPayStatus] = useState('ALL');
  const [staff, setStaff] = useState('ALL');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState(null);
  const [billRow, setBillRow] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    axios.get('/api/sales/invoices/report/', { params: { date_from: dateFrom, date_to: dateTo, document_type: docType } })
      .then((res) => { if (alive) setRows(Array.isArray(res.data?.results) ? res.data.results : []); })
      .catch((e) => {
        if (!alive) return;
        setRows([]);
        setError(e?.response?.data?.detail || 'Could not load the sales report. Check the connection to the server and retry.');
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [dateFrom, dateTo, docType, reloadKey]);

  const staffNames = useMemo(() => [...new Set(rows.map(staffOf).filter(Boolean))].sort(), [rows]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (payStatus !== 'ALL' && r.payment_status !== payStatus) return false;
      if (staff !== 'ALL' && staffOf(r) !== staff) return false;
      if (!q) return true;
      const hay = [
        r.invoice_number, r.customer.name, r.customer.code, r.customer.phone, r.test_no, staffOf(r),
        ...r.lines.flatMap((l) => [l.name, l.brand, l.model, l.code, l.barcode]),
      ].join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [rows, search, payStatus, staff]);

  // Money figures count Tax Invoices only — a quotation or open order isn't a sale yet.
  const kpis = useMemo(() => {
    const sales = filtered.filter((r) => r.document_type === 'INVOICE');
    const sum = (key) => sales.reduce((s, r) => s + (parseFloat(r.totals[key]) || 0), 0);
    return {
      docs: filtered.length, invoices: sales.length,
      net: sum('net'), discount: sum('discount'), paid: sum('paid'), balance: sum('balance'),
    };
  }, [filtered]);

  const exportCsv = () => {
    const header = ['Document No', 'Type', 'Date', 'Time', 'Customer', 'Patient Code', 'Phone', 'Address',
      'Test No', 'Visit', 'Frames', 'Frame Barcodes', 'Lenses', 'Lens Specs', 'Other Items', 'Gross', 'Discount',
      'Tax', 'Net', 'Paid', 'Balance', 'Payment Mode', 'Payment Status', 'Salesman'];
    const lines = filtered.map((r) => {
      const frames = r.lines.filter((l) => l.kind === 'FRAME');
      const lenses = r.lines.filter((l) => l.kind === 'LENS');
      const others = r.lines.filter((l) => l.kind !== 'FRAME' && l.kind !== 'LENS');
      return [
        r.invoice_number, DOC_TYPES[r.document_type]?.label || r.document_type, r.invoice_date, timeOf(r),
        r.customer.name, r.customer.code, r.customer.phone, [r.customer.address, r.customer.place].filter(Boolean).join(', '),
        r.test_no, visitLabel(r.exam),
        frames.map((l) => [l.name, lineSpec(l)].filter(Boolean).join(' — ')).join(' | '),
        frames.map((l) => l.barcode).filter(Boolean).join(' | '),
        lenses.map((l) => l.name).join(' | '), lenses.map(lensSpec).join(' | '),
        others.map((l) => `${l.name} x${l.qty}`).join(' | '),
        r.totals.gross, r.totals.discount, r.totals.tax, r.totals.net, r.totals.paid, r.totals.balance,
        r.payment.modes.length > 1 ? r.payment.modes.map((m) => `${m.mode} ${m.amount}`).join(' + ') : r.payment.mode,
        r.payment_status, staffOf(r),
      ].map(csvCell).join(',');
    });
    const blob = new Blob([`${header.map(csvCell).join(',')}\n${lines.join('\n')}`], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Sales_Report_${dateFrom}_to_${dateTo}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Stack spacing={2.5}>
      {/* Filters */}
      <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
        <Grid container spacing={1.5} alignItems="center">
          <Grid item xs={6} sm={3} md={2}>
            <TextField fullWidth size="small" type="date" label="From" value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={6} sm={3} md={2}>
            <TextField fullWidth size="small" type="date" label="To" value={dateTo}
              onChange={(e) => setDateTo(e.target.value)} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <ToggleButtonGroup exclusive size="small" fullWidth value={docType}
              onChange={(e, v) => v && setDocType(v)}>
              <ToggleButton value="ALL">All</ToggleButton>
              <ToggleButton value="QUOTATION">Quotation</ToggleButton>
              <ToggleButton value="ORDER">Order</ToggleButton>
              <ToggleButton value="INVOICE">Invoice</ToggleButton>
            </ToggleButtonGroup>
          </Grid>
          <Grid item xs={6} sm={3} md={1.4}>
            <TextField select fullWidth size="small" label="Payment" value={payStatus} onChange={(e) => setPayStatus(e.target.value)}>
              <MenuItem value="ALL">All</MenuItem>
              <MenuItem value="PAID">Paid</MenuItem>
              <MenuItem value="PARTIAL">Partial</MenuItem>
              <MenuItem value="UNPAID">Unpaid</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={6} sm={3} md={1.5}>
            <TextField select fullWidth size="small" label="Salesman" value={staff} onChange={(e) => setStaff(e.target.value)}>
              <MenuItem value="ALL">All staff</MenuItem>
              {staffNames.map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6} md={2.1}>
            <TextField fullWidth size="small" placeholder="Bill no, name, phone, test no, barcode…" value={search}
              onChange={(e) => setSearch(e.target.value)}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
          </Grid>
        </Grid>
      </Card>

      {/* KPIs */}
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: 'repeat(2, minmax(0, 1fr))', md: 'repeat(5, minmax(0, 1fr))' } }}>
        {[
          ['Documents', String(kpis.docs), `${kpis.invoices} tax invoice${kpis.invoices === 1 ? '' : 's'}`, '#475569'],
          ['Net Sales', inr(kpis.net), 'Tax invoices, after discount', '#2563eb'],
          ['Discount Given', inr(kpis.discount), 'On tax invoices', '#7c3aed'],
          ['Collected', inr(kpis.paid), 'Total paid incl. later receipts', '#059669'],
          ['Balance Due', inr(kpis.balance), 'Still to collect', '#dc2626'],
        ].map(([label, value, hint, color]) => (
          <Paper key={label} variant="outlined" sx={{ p: 1.5, borderRadius: 2.5, borderLeft: `4px solid ${color}`, minWidth: 0 }}>
            <Typography variant="caption" fontWeight={800} color="text.secondary">{label.toUpperCase()}</Typography>
            <Typography variant="h6" fontWeight={850} sx={{ color }}>{value}</Typography>
            <Typography variant="caption" color="text.secondary">{hint}</Typography>
          </Paper>
        ))}
      </Box>

      {/* Ledger */}
      <Card variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
        <Box sx={{ px: 2, py: 1.5, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', bgcolor: '#0f172a', color: '#fff' }}>
          <Typography variant="subtitle1" fontWeight={850}>Sales Ledger</Typography>
          <Typography variant="caption" sx={{ color: '#94a3b8' }}>{dateFrom} → {dateTo} · click a row for the full breakdown</Typography>
          <Box sx={{ flexGrow: 1 }} />
          <Tooltip title="Reload">
            <IconButton size="small" sx={{ color: '#fff' }} onClick={() => setReloadKey((k) => k + 1)}><RefreshIcon fontSize="small" /></IconButton>
          </Tooltip>
          <Button size="small" variant="contained" startIcon={<ExcelIcon />} onClick={exportCsv} disabled={!filtered.length}
            sx={{ textTransform: 'none', fontWeight: 800, bgcolor: '#10b981', '&:hover': { bgcolor: '#059669' } }}>
            Export CSV
          </Button>
        </Box>
        {loading && <LinearProgress />}
        {error && <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>}
        {/* Full height and width: the ledger grows with the page (no inner scrollbars), and cells
            wrap instead of pushing columns off to the side. */}
        <TableContainer sx={{ overflow: 'visible' }}>
          {/* Fixed layout with share-of-width columns, so the table always fits the screen. */}
          <Table size="small" sx={{ tableLayout: 'fixed', width: '100%', '& td': { overflowWrap: 'anywhere', px: 1 }, '& th': { px: 1 } }}>
            <colgroup>
              {['40px', '13%', '13%', '11%', '14%', '12%', '9%', '9%', '10%', '9%'].map((w, i) => <col key={i} style={{ width: w }} />)}
            </colgroup>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 850, bgcolor: '#f1f5f9' } }}>
                <TableCell padding="checkbox" />
                <TableCell>Document</TableCell>
                <TableCell>Customer</TableCell>
                <TableCell>Eye Test</TableCell>
                <TableCell>Frame</TableCell>
                <TableCell>Lens</TableCell>
                <TableCell align="right">Bill / Discount</TableCell>
                <TableCell align="right">Paid / Balance</TableCell>
                <TableCell>Payment</TableCell>
                <TableCell>Salesman</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((r) => (
                <ReportRow key={r.id} row={r} open={expanded === r.id}
                  onToggle={() => setExpanded(expanded === r.id ? null : r.id)} onViewBill={() => setBillRow(r)} />
              ))}
              {!loading && !filtered.length && (
                <TableRow>
                  <TableCell colSpan={10} align="center" sx={{ py: 6, color: 'text.secondary' }}>
                    {rows.length ? 'No documents match these filters.' : 'No sales documents in this period.'}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      <ViewBillDialog row={billRow} onClose={() => setBillRow(null)} />
    </Stack>
  );
}

function ReportRow({ row: r, open, onToggle, onViewBill }) {
  const doc = DOC_TYPES[r.document_type] || DOC_TYPES.INVOICE;
  const frames = r.lines.filter((l) => l.kind === 'FRAME');
  const lenses = r.lines.filter((l) => l.kind === 'LENS');
  const otherCount = r.lines.length - frames.length - lenses.length;
  const small = { display: 'block', color: 'text.secondary', lineHeight: 1.35 };

  return (
    <Fragment>
      <TableRow hover onClick={onToggle} sx={{ cursor: 'pointer', '& td': { verticalAlign: 'top', borderBottom: open ? 'none' : undefined } }}>
        <TableCell padding="checkbox">
          <IconButton size="small">{open ? <CollapseIcon fontSize="small" /> : <ExpandIcon fontSize="small" />}</IconButton>
        </TableCell>
        <TableCell>
          <Stack direction="row" alignItems="center" spacing={0.5}>
            <Typography variant="body2" fontWeight={850} color="primary.main">{r.invoice_number}</Typography>
            <Tooltip title="View / reprint the original bill">
              <IconButton size="small" color="primary" onClick={(e) => { e.stopPropagation(); onViewBill(); }}>
                <BillIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          </Stack>
          <Chip size="small" label={doc.label} color={doc.color} variant="outlined" sx={{ height: 20, fontWeight: 700, my: 0.25 }} />
          <Typography variant="caption" sx={small}>{r.invoice_date}{timeOf(r) ? ` · ${timeOf(r)}` : ''}</Typography>
        </TableCell>
        <TableCell>
          <Typography variant="body2" fontWeight={800}>{r.customer.name || '—'}</Typography>
          <Typography variant="caption" sx={small}>{[r.customer.code, r.customer.phone].filter(Boolean).join(' · ')}</Typography>
          {(r.customer.address || r.customer.place) && (
            <Typography variant="caption" sx={{ ...small, maxWidth: 220 }} noWrap title={[r.customer.address, r.customer.place].filter(Boolean).join(', ')}>
              {[r.customer.address, r.customer.place].filter(Boolean).join(', ')}
            </Typography>
          )}
        </TableCell>
        <TableCell>
          {r.test_no ? (
            <>
              <Typography variant="body2" fontWeight={800}>Test No {r.test_no}</Typography>
              {r.exam && <Chip size="small" label={visitLabel(r.exam)} color={r.exam.is_first_test ? 'info' : 'secondary'}
                sx={{ height: 20, fontWeight: 700, my: 0.25 }} />}
              {r.exam?.date && <Typography variant="caption" sx={small}>{r.exam.date}</Typography>}
            </>
          ) : (
            <Typography variant="caption" sx={small}>
              Not linked{r.exam_history.count ? ` · ${r.exam_history.count} test${r.exam_history.count === 1 ? '' : 's'} on file` : ''}
            </Typography>
          )}
        </TableCell>
        <TableCell>
          {frames.length ? frames.map((l) => (
            <Box key={l.id} sx={{ mb: 0.5 }}>
              <Typography variant="body2" fontWeight={700}>{l.name}</Typography>
              <Typography variant="caption" sx={small}>{lineSpec(l)}</Typography>
              {l.barcode && <Typography variant="caption" sx={{ ...small, fontFamily: 'monospace' }}>{l.barcode}</Typography>}
            </Box>
          )) : <Typography variant="caption" sx={small}>—</Typography>}
        </TableCell>
        <TableCell>
          {lenses.length ? lenses.map((l) => (
            <Box key={l.id} sx={{ mb: 0.5 }}>
              <Typography variant="body2" fontWeight={700}>{l.name}</Typography>
              <Typography variant="caption" sx={small}>{lensSpec(l)}</Typography>
            </Box>
          )) : <Typography variant="caption" sx={small}>—</Typography>}
          {otherCount > 0 && <Typography variant="caption" sx={small}>+ {otherCount} other item{otherCount === 1 ? '' : 's'}</Typography>}
        </TableCell>
        <TableCell align="right">
          <Typography variant="body2" fontWeight={850}>{inr(r.totals.net)}</Typography>
          {parseFloat(r.totals.discount) > 0 && <Typography variant="caption" sx={{ ...small, color: '#7c3aed' }}>Disc {inr(r.totals.discount)}</Typography>}
        </TableCell>
        <TableCell align="right">
          <Typography variant="body2" fontWeight={700} color="success.main">{inr(r.totals.paid)}</Typography>
          {parseFloat(r.totals.balance) > 0 && <Typography variant="caption" sx={{ ...small, color: 'error.main', fontWeight: 700 }}>Due {inr(r.totals.balance)}</Typography>}
        </TableCell>
        <TableCell>
          <Typography variant="body2" fontWeight={700}>{r.payment.mode}</Typography>
          {r.payment.modes.length > 1 && (
            <Typography variant="caption" sx={small}>{r.payment.modes.map((m) => `${m.mode} ${inr(m.amount)}`).join(' + ')}</Typography>
          )}
          {r.document_type !== 'QUOTATION' && (
            <Chip size="small" label={r.payment_status} color={PAY_STATUS_COLOR[r.payment_status] || 'default'} sx={{ height: 18, fontSize: '0.65rem', fontWeight: 800, mt: 0.25 }} />
          )}
        </TableCell>
        <TableCell>
          <Typography variant="body2" fontWeight={700}>{staffOf(r) || '—'}</Typography>
        </TableCell>
      </TableRow>
      <TableRow>
        <TableCell colSpan={10} sx={{ py: 0, bgcolor: '#f8fafc' }}>
          <Collapse in={open} timeout="auto" unmountOnExit>
            <RowDetail row={r} />
          </Collapse>
        </TableCell>
      </TableRow>
    </Fragment>
  );
}

function DetailCard({ title, children }) {
  return (
    <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, height: '100%' }}>
      <Typography variant="caption" fontWeight={850} color="text.secondary" sx={{ display: 'block', mb: 0.75 }}>{title}</Typography>
      {children}
    </Paper>
  );
}

const Field = ({ label, value }) => (value ? (
  <Typography variant="body2" sx={{ lineHeight: 1.6 }}><Box component="span" sx={{ color: 'text.secondary' }}>{label}: </Box>{value}</Typography>
) : null);

function RowDetail({ row: r }) {
  const c = r.customer;
  const exam = r.exam;
  const head = { fontWeight: 800, bgcolor: '#f1f5f9' };
  return (
    <Box sx={{ py: 2 }}>
      <Grid container spacing={1.5} sx={{ mb: 1.5 }}>
        <Grid item xs={12} md={4}>
          <DetailCard title="CUSTOMER">
            <Typography variant="body2" fontWeight={800}>{c.name || '—'}</Typography>
            <Field label="Patient code" value={c.code} />
            <Field label="Phone" value={c.phone} />
            <Field label="Email" value={c.email} />
            <Field label="Address" value={[c.address, c.place].filter(Boolean).join(', ')} />
            <Field label="Age / Gender" value={[c.age, c.gender].filter(Boolean).join(' / ')} />
            {parseFloat(c.outstanding_balance) > 0 && <Field label="Account outstanding" value={inr(c.outstanding_balance)} />}
          </DetailCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <DetailCard title="EYE TEST">
            {exam ? (
              <>
                <Typography variant="body2" fontWeight={800}>Test No {exam.test_no} · {visitLabel(exam)}</Typography>
                <Field label="Date" value={exam.date} />
                <Field label="Optometrist" value={exam.optometrist} />
                <Field label="RE" value={rxText(exam.re)} />
                <Field label="LE" value={rxText(exam.le)} />
                <Field label="PD" value={exam.pd} />
                <Field label="Diagnosis" value={exam.diagnosis} />
                <Typography variant="caption" color="text.secondary">
                  Visit {exam.visit_ordinal} of {exam.visit_total} on file · linked via {
                    { bill: 'the bill\'s Test No', lens_rx: 'the lens prescription', eye_test_fee: 'the eye test fee' }[exam.linked_by] || 'the bill'}
                </Typography>
              </>
            ) : r.test_no ? (
              <Typography variant="body2">Test No {r.test_no} — the examination record was not found.</Typography>
            ) : (
              <Typography variant="body2" color="text.secondary">
                No eye test linked to this bill.
                {r.exam_history.count > 0 && ` The patient has ${r.exam_history.count} test${r.exam_history.count === 1 ? '' : 's'} on file (latest: Test No ${r.exam_history.latest_test_no}, ${r.exam_history.latest_date}).`}
              </Typography>
            )}
          </DetailCard>
        </Grid>
        <Grid item xs={12} md={4}>
          <DetailCard title="PAYMENT">
            <Field label="Gross" value={inr(r.totals.gross)} />
            <Field label="Discount" value={inr(r.totals.discount)} />
            <Field label="Tax" value={inr(r.totals.tax)} />
            <Typography variant="body2" fontWeight={850}>Net payable: {inr(r.totals.net)}</Typography>
            <Field label="Paid" value={inr(r.totals.paid)} />
            <Field label="Balance due" value={inr(r.totals.balance)} />
            {r.payment.receipts.map((p, i) => (
              <Typography key={`${p.receipt_no}-${i}`} variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>
                {p.receipt_no || 'Receipt'} · {p.date} · {p.method}{p.bank ? ` (${p.bank})` : ''} · {inr(p.amount)}{p.at_billing ? '' : ' · collected later'}
              </Typography>
            ))}
            <Field label="Served by" value={staffOf(r)} />
          </DetailCard>
        </Grid>
      </Grid>
      <Table size="small" sx={{ bgcolor: '#fff', border: '1px solid #e2e8f0' }}>
        <TableHead>
          <TableRow>
            {['Type', 'Item', 'Brand / Model', 'Code', 'Barcode', 'Details', 'Qty', 'Rate', 'Tax', 'Total'].map((h, i) => (
              <TableCell key={h} sx={head} align={i >= 6 ? 'right' : 'left'}>{h}</TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {r.lines.map((l) => {
            const details = l.kind === 'LENS'
              ? [lensSpec(l), l.lens?.rx?.re && `RE ${rxText(l.lens.rx.re)}`, l.lens?.rx?.le && `LE ${rxText(l.lens.rx.le)}`].filter(Boolean).join(' · ')
              : l.kind === 'SERVICE'
                ? Object.values(l.service || {}).filter((v) => v !== 'EYE_TEST_FEE').join(' · ')
                : [l.color, l.size, l.frame_type].filter(Boolean).join(' · ');
            return (
              <TableRow key={l.id}>
                <TableCell><Chip size="small" label={l.kind} sx={{ height: 20, fontSize: '0.65rem', fontWeight: 800 }} /></TableCell>
                <TableCell sx={{ fontWeight: 700 }}>{l.name}{l.power && <Typography variant="caption" sx={{ display: 'block', color: 'text.secondary' }}>{l.power}</Typography>}</TableCell>
                <TableCell>{[l.brand, l.model].filter(Boolean).join(' / ') || '—'}</TableCell>
                <TableCell>{l.code || '—'}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>{l.barcode || '—'}</TableCell>
                <TableCell sx={{ color: 'text.secondary' }}>{details || '—'}</TableCell>
                <TableCell align="right">{l.qty}{l.selling_unit ? ` ${l.selling_unit.toLowerCase()}` : ''}</TableCell>
                <TableCell align="right">{inr(l.rate)}</TableCell>
                <TableCell align="right">{parseFloat(l.tax) ? `${inr(l.tax)} (${parseFloat(l.tax_rate)}%)` : '—'}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>{inr(l.total)}</TableCell>
              </TableRow>
            );
          })}
          {!r.lines.length && (
            <TableRow><TableCell colSpan={10} align="center" sx={{ color: 'text.secondary' }}>No line items on this document.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
    </Box>
  );
}

// The original bill rendered with the template assigned to its type (Settings → Bill & Invoice
// Designer), loaded fresh from the server so a reprint always matches what's saved.
function ViewBillDialog({ row, onClose }) {
  const [doc, setDoc] = useState(null);
  const [error, setError] = useState('');
  const documentType = (DOC_TYPES[row?.document_type] || DOC_TYPES.INVOICE).bill;

  useEffect(() => {
    if (!row) return undefined;
    let alive = true;
    setDoc(null);
    setError('');
    axios.get(`/api/sales/invoices/${row.id}/`)
      .then((res) => { if (alive) setDoc(res.data); })
      .catch((e) => {
        if (alive) setError(e?.response?.status === 404 ? 'This document no longer exists.' : 'Could not load the bill.');
      });
    return () => { alive = false; };
  }, [row]);

  const print = async () => {
    const opened = await printBill({ doc, documentType });
    if (!opened) notify('Allow pop-ups to print the bill.', 'warning');
  };

  return (
    <Dialog open={!!row} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
        <EyeIcon color="primary" />
        <Typography component="span" variant="h6" fontWeight={850}>{row?.invoice_number}</Typography>
        {row && <Chip size="small" label={(DOC_TYPES[row.document_type] || DOC_TYPES.INVOICE).label} />}
        <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 'auto' }}>{row?.customer?.name}</Typography>
      </DialogTitle>
      <DialogContent sx={{ minHeight: 320 }}>
        {!doc && !error && <LinearProgress sx={{ my: 2 }} />}
        {error && <Alert severity="warning">{error}</Alert>}
        {doc && (
          <Box sx={{ display: 'flex', justifyContent: 'center', bgcolor: '#f1f5f9', borderRadius: 2, p: 2 }}>
            <BillPreview doc={doc} documentType={documentType} maxWidth={720} />
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" startIcon={<PrintIcon />} onClick={print} disabled={!doc}>Reprint bill</Button>
      </DialogActions>
    </Dialog>
  );
}
