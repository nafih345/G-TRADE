import React, { useState, useEffect, useMemo } from 'react';
import {
  Box, Card, CardContent, Typography, Grid, Button, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TableFooter, Paper, Dialog,
  DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Stack, Chip, Divider, Avatar, InputAdornment
} from '@mui/material';
import {
  Assessment as ReportsIcon,
  Search as SearchIcon,
  PictureAsPdf as PdfIcon,
  TableChart as ExcelIcon,
  Print as PrintIcon,
  CalendarMonth as CalendarIcon,
  Payment as PaymentIcon,
  People as CustomerIcon,
  Inventory2 as ProductIcon,
  RequestQuote as GstIcon,
  ReceiptLong as InvoiceIcon,
  AccountBalanceWallet as OutstandingIcon,
  TrendingUp as TrendingUpIcon
} from '@mui/icons-material';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, ResponsiveContainer
} from 'recharts';

// ---- Report sections available in this hub ----
const REPORT_TABS = [
  { id: 'sales-register', name: 'Sales Register', icon: <InvoiceIcon /> },
  { id: 'customer-summary', name: 'Customer Summary', icon: <CustomerIcon /> },
  { id: 'product-movement', name: 'Product Movement', icon: <ProductIcon /> },
  { id: 'gst-summary', name: 'GST Summary', icon: <GstIcon /> },
  { id: 'outstanding', name: 'Outstanding / Receivables', icon: <OutstandingIcon /> }
];

const DATE_RANGES = ['Today', 'This Week', 'This Month', 'This Quarter', 'This Year', 'All Time'];

const inr = (n) => `₹${(parseFloat(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const inr0 = (n) => `₹${Math.round(parseFloat(n) || 0).toLocaleString('en-IN')}`;

// Resolve the start Date for a named range (end is always "now").
function rangeStart(range) {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  switch (range) {
    case 'Today':
      return d;
    case 'This Week': {
      const day = (d.getDay() + 6) % 7; // Monday = 0
      return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day);
    }
    case 'This Month':
      return new Date(d.getFullYear(), d.getMonth(), 1);
    case 'This Quarter': {
      const q = Math.floor(d.getMonth() / 3) * 3;
      return new Date(d.getFullYear(), q, 1);
    }
    case 'This Year':
      return new Date(d.getFullYear(), 0, 1);
    default:
      return null; // All Time
  }
}

// Normalise a stored wholesale invoice into a flat shape the reports use.
function normaliseInvoice(raw) {
  const s = raw.summary || {};
  const items = Array.isArray(raw.items) ? raw.items : [];
  const subtotal = s.subtotal ?? items.reduce((a, it) => a + (parseFloat(it.rate) || 0) * (parseFloat(it.qty) || 0), 0);
  const discount = s.totalDiscount ?? 0;
  const gst = s.totalGst ?? 0;
  const grandTotal = s.grandTotal ?? (subtotal - discount + gst);
  const paid = raw.amountReceived ?? (raw.payMode === 'Credit Sale' ? 0 : grandTotal);
  const due = raw.dueAmount ?? Math.max(0, grandTotal - paid);
  return {
    invoiceNo: raw.invoiceNo || raw.id || '—',
    date: raw.date || new Date().toISOString().split('T')[0],
    customerName: raw.customer?.name || 'Walk-in Wholesale',
    customerCode: raw.customer?.code || '',
    customerGstin: raw.customer?.gstin || '',
    salesExec: raw.customer?.salesExec || '—',
    payMode: raw.payMode || 'Cash',
    refNo: raw.refNo || '',
    items,
    totalQty: s.totalQty ?? items.reduce((a, it) => a + (parseFloat(it.qty) || 0), 0),
    lineCount: items.length,
    subtotal,
    discount,
    taxable: subtotal - discount,
    gst,
    grandTotal,
    paid,
    due,
    status: due > 0 ? (paid > 0 ? 'Partial' : 'Unpaid') : 'Paid',
    raw
  };
}

export default function WholesaleReports() {
  const [invoicesRaw, setInvoicesRaw] = useState([]);
  const [customers, setCustomers] = useState([]);

  const [activeTab, setActiveTab] = useState('sales-register');
  const [dateRange, setDateRange] = useState('This Month');
  const [payModeFilter, setPayModeFilter] = useState('All');
  const [customerFilter, setCustomerFilter] = useState('All');
  const [search, setSearch] = useState('');
  const [detailInvoice, setDetailInvoice] = useState(null);

  // ---- Load data written by the Wholesale POS terminal ----
  useEffect(() => {
    try {
      setInvoicesRaw(JSON.parse(localStorage.getItem('optical_wholesale_invoices') || '[]'));
    } catch (e) {}
    try {
      setCustomers(JSON.parse(localStorage.getItem('optical_wholesale_customers') || '[]'));
    } catch (e) {}
  }, []);

  const allInvoices = useMemo(() => invoicesRaw.map(normaliseInvoice), [invoicesRaw]);

  const payModes = useMemo(
    () => ['All', ...Array.from(new Set(allInvoices.map(i => i.payMode))).filter(Boolean)],
    [allInvoices]
  );
  const customerNames = useMemo(
    () => ['All', ...Array.from(new Set(allInvoices.map(i => i.customerName))).filter(Boolean)],
    [allInvoices]
  );

  // ---- Apply global filters ----
  const invoices = useMemo(() => {
    const start = rangeStart(dateRange);
    const q = search.trim().toLowerCase();
    return allInvoices.filter(inv => {
      if (start) {
        const d = new Date(inv.date);
        if (isNaN(d) ? false : d < start) return false;
      }
      if (payModeFilter !== 'All' && inv.payMode !== payModeFilter) return false;
      if (customerFilter !== 'All' && inv.customerName !== customerFilter) return false;
      if (q) {
        const hay = `${inv.invoiceNo} ${inv.customerName} ${inv.customerCode} ${inv.customerGstin} ${inv.payMode}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allInvoices, dateRange, payModeFilter, customerFilter, search]);

  // ---- KPI roll-up ----
  const kpi = useMemo(() => {
    const revenue = invoices.reduce((a, i) => a + i.grandTotal, 0);
    const taxable = invoices.reduce((a, i) => a + i.taxable, 0);
    const gst = invoices.reduce((a, i) => a + i.gst, 0);
    const discount = invoices.reduce((a, i) => a + i.discount, 0);
    const units = invoices.reduce((a, i) => a + i.totalQty, 0);
    const due = invoices.reduce((a, i) => a + i.due, 0);
    return {
      revenue, taxable, gst, discount, units, due,
      count: invoices.length,
      avgTicket: invoices.length ? revenue / invoices.length : 0
    };
  }, [invoices]);

  // ---- Revenue trend (by day) ----
  const trend = useMemo(() => {
    const map = new Map();
    invoices.forEach(i => {
      map.set(i.date, (map.get(i.date) || 0) + i.grandTotal);
    });
    return Array.from(map.entries())
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .map(([date, value]) => ({ date: date.slice(5), value: Math.round(value) }));
  }, [invoices]);

  // ---- Customer-wise summary ----
  const customerSummary = useMemo(() => {
    const map = new Map();
    invoices.forEach(i => {
      const cur = map.get(i.customerName) || {
        customerName: i.customerName, customerCode: i.customerCode, salesExec: i.salesExec,
        invoices: 0, qty: 0, taxable: 0, gst: 0, total: 0, due: 0
      };
      cur.invoices += 1;
      cur.qty += i.totalQty;
      cur.taxable += i.taxable;
      cur.gst += i.gst;
      cur.total += i.grandTotal;
      cur.due += i.due;
      map.set(i.customerName, cur);
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [invoices]);

  // ---- Product-wise movement ----
  const productMovement = useMemo(() => {
    const map = new Map();
    invoices.forEach(inv => {
      inv.items.forEach(it => {
        const key = it.code || it.barcode || it.name;
        const cur = map.get(key) || {
          code: it.code || it.barcode || '—', name: it.name || '—', brand: it.brand || '—',
          category: it.category || '—', qty: 0, gross: 0, gst: 0, total: 0
        };
        const base = (parseFloat(it.rate) || 0) * (parseFloat(it.qty) || 0);
        const disc = base * ((parseFloat(it.discount) || 0) / 100);
        const gross = base - disc;
        const gst = gross * ((parseFloat(it.gst) || 0) / 100);
        cur.qty += parseFloat(it.qty) || 0;
        cur.gross += gross;
        cur.gst += gst;
        cur.total += gross + gst;
        map.set(key, cur);
      });
    });
    return Array.from(map.values()).sort((a, b) => b.total - a.total);
  }, [invoices]);

  // ---- GST rate-wise summary ----
  const gstSummary = useMemo(() => {
    const map = new Map();
    invoices.forEach(inv => {
      inv.items.forEach(it => {
        const rate = parseFloat(it.gst) || 0;
        const base = (parseFloat(it.rate) || 0) * (parseFloat(it.qty) || 0);
        const disc = base * ((parseFloat(it.discount) || 0) / 100);
        const taxable = base - disc;
        const tax = taxable * (rate / 100);
        const cur = map.get(rate) || { rate, taxable: 0, cgst: 0, sgst: 0, total: 0 };
        cur.taxable += taxable;
        cur.cgst += tax / 2;
        cur.sgst += tax / 2;
        cur.total += tax;
        map.set(rate, cur);
      });
    });
    return Array.from(map.values()).sort((a, b) => a.rate - b.rate);
  }, [invoices]);

  // ---- Outstanding / receivables ----
  const outstanding = useMemo(() => {
    // Prefer live customer-ledger balances; fall back to invoice dues in range.
    const fromLedger = customers
      .filter(c => parseFloat(c.outstanding || 0) > 0)
      .map(c => ({
        customerName: c.name, customerCode: c.code, salesExec: c.salesExec || '—',
        creditLimit: parseFloat(c.creditLimit || 0), creditDays: c.creditDays || 30,
        outstanding: parseFloat(c.outstanding || 0),
        lastPurchase: c.lastPurchaseDate || '—'
      }))
      .sort((a, b) => b.outstanding - a.outstanding);
    if (fromLedger.length) return fromLedger;
    return customerSummary
      .filter(c => c.due > 0)
      .map(c => ({
        customerName: c.customerName, customerCode: c.customerCode, salesExec: c.salesExec,
        creditLimit: 0, creditDays: 30, outstanding: c.due, lastPurchase: '—'
      }));
  }, [customers, customerSummary]);

  // ---- CSV export for the active report ----
  const exportCsv = () => {
    let headers = [];
    let rows = [];
    if (activeTab === 'sales-register') {
      headers = ['Invoice No', 'Date', 'Customer', 'Code', 'Items', 'Qty', 'Taxable', 'Discount', 'GST', 'Grand Total', 'Paid', 'Due', 'Pay Mode', 'Status'];
      rows = invoices.map(i => [i.invoiceNo, i.date, i.customerName, i.customerCode, i.lineCount, i.totalQty, i.taxable.toFixed(2), i.discount.toFixed(2), i.gst.toFixed(2), i.grandTotal.toFixed(2), i.paid.toFixed(2), i.due.toFixed(2), i.payMode, i.status]);
    } else if (activeTab === 'customer-summary') {
      headers = ['Customer', 'Code', 'Sales Exec', 'Invoices', 'Qty', 'Taxable', 'GST', 'Total', 'Due'];
      rows = customerSummary.map(c => [c.customerName, c.customerCode, c.salesExec, c.invoices, c.qty, c.taxable.toFixed(2), c.gst.toFixed(2), c.total.toFixed(2), c.due.toFixed(2)]);
    } else if (activeTab === 'product-movement') {
      headers = ['Code', 'Product', 'Brand', 'Category', 'Qty Sold', 'Gross', 'GST', 'Total'];
      rows = productMovement.map(p => [p.code, p.name, p.brand, p.category, p.qty, p.gross.toFixed(2), p.gst.toFixed(2), p.total.toFixed(2)]);
    } else if (activeTab === 'gst-summary') {
      headers = ['GST Rate %', 'Taxable Value', 'CGST', 'SGST', 'Total Tax'];
      rows = gstSummary.map(g => [g.rate, g.taxable.toFixed(2), g.cgst.toFixed(2), g.sgst.toFixed(2), g.total.toFixed(2)]);
    } else {
      headers = ['Customer', 'Code', 'Sales Exec', 'Credit Limit', 'Credit Days', 'Outstanding', 'Last Purchase'];
      rows = outstanding.map(o => [o.customerName, o.customerCode, o.salesExec, o.creditLimit.toFixed(2), o.creditDays, o.outstanding.toFixed(2), o.lastPurchase]);
    }
    const csv = [headers, ...rows]
      .map(r => r.map(c => `"${String(c ?? '').replace(/"/g, '""')}"`).join(','))
      .join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Wholesale_${activeTab}_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const activeReport = REPORT_TABS.find(t => t.id === activeTab) || REPORT_TABS[0];

  return (
    <Box sx={{ p: 2.5, bgcolor: '#f8fafc', minHeight: '100vh' }}>
      {/* HEADER */}
      <Paper
        elevation={0}
        variant="outlined"
        sx={{
          p: 2, px: 3, mb: 2.5, borderRadius: 4, bgcolor: '#ffffff', borderColor: '#cbd5e1',
          boxShadow: '0 2px 8px rgba(0,0,0,0.04)', display: 'flex', justifyContent: 'space-between',
          alignItems: 'center', flexWrap: 'wrap', gap: 2
        }}
      >
        <Stack direction="row" spacing={2} alignItems="center">
          <Avatar sx={{ bgcolor: '#4f46e5', width: 44, height: 44 }}>
            <ReportsIcon sx={{ color: '#ffffff' }} />
          </Avatar>
          <Box>
            <Typography variant="h6" fontWeight={850} color="#0f172a">
              Wholesale Reports & Analytics
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              B2B Sales Register, Customer Ledger, Stock Movement, GST & Receivables
            </Typography>
          </Box>
        </Stack>

        <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button variant="outlined" color="error" size="small" startIcon={<PdfIcon />} onClick={() => window.print()} sx={{ fontWeight: 800, borderRadius: 3 }}>
            Export PDF
          </Button>
          <Button variant="contained" color="success" size="small" startIcon={<ExcelIcon />} onClick={exportCsv} sx={{ fontWeight: 800, borderRadius: 3, bgcolor: '#10b981', '&:hover': { bgcolor: '#059669' } }}>
            Export Excel
          </Button>
          <Button variant="outlined" color="primary" size="small" startIcon={<PrintIcon />} onClick={() => window.print()} sx={{ fontWeight: 800, borderRadius: 3 }}>
            Print
          </Button>
        </Stack>
      </Paper>

      {/* FILTER TOOLBAR */}
      <Card variant="outlined" sx={{ p: 2, mb: 2.5, borderRadius: 4, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={6} md={4}>
            <TextField
              fullWidth size="small" placeholder="Search invoice no, customer, GSTIN..."
              value={search} onChange={(e) => setSearch(e.target.value)}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon sx={{ fontSize: 18 }} /></InputAdornment> }}
            />
          </Grid>
          <Grid item xs={6} sm={3} md={2.5}>
            <TextField
              fullWidth select size="small" label="Customer" value={customerFilter}
              onChange={(e) => setCustomerFilter(e.target.value)}
              InputProps={{ startAdornment: <CustomerIcon color="action" sx={{ mr: 1, fontSize: 18 }} /> }}
            >
              {customerNames.map(c => <MenuItem key={c} value={c}>{c === 'All' ? 'All Customers' : c}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={6} sm={3} md={2.5}>
            <TextField
              fullWidth select size="small" label="Payment Mode" value={payModeFilter}
              onChange={(e) => setPayModeFilter(e.target.value)}
              InputProps={{ startAdornment: <PaymentIcon color="action" sx={{ mr: 1, fontSize: 18 }} /> }}
            >
              {payModes.map(p => <MenuItem key={p} value={p}>{p === 'All' ? 'All Modes' : p}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={3} md={3}>
            <TextField
              fullWidth select size="small" label="Reporting Period" value={dateRange}
              onChange={(e) => setDateRange(e.target.value)}
              InputProps={{ startAdornment: <CalendarIcon color="action" sx={{ mr: 1, fontSize: 18 }} /> }}
            >
              {DATE_RANGES.map(r => <MenuItem key={r} value={r}>{r}</MenuItem>)}
            </TextField>
          </Grid>
        </Grid>
      </Card>

      {/* KPI SCORECARDS */}
      <Grid container spacing={2} sx={{ mb: 2.5 }}>
        {[
          { label: 'WHOLESALE REVENUE', value: inr0(kpi.revenue), sub: `${kpi.count} invoices`, color: '#2563eb' },
          { label: 'UNITS DISPATCHED', value: kpi.units.toLocaleString('en-IN'), sub: `Avg ticket ${inr0(kpi.avgTicket)}`, color: '#0891b2' },
          { label: 'GST COLLECTED', value: inr0(kpi.gst), sub: `Taxable ${inr0(kpi.taxable)}`, color: '#d97706' },
          { label: 'DISCOUNT GIVEN', value: inr0(kpi.discount), sub: 'On wholesale rates', color: '#7c3aed' },
          { label: 'OUTSTANDING DUE', value: inr0(kpi.due), sub: 'Unpaid on filtered bills', color: '#dc2626' }
        ].map((c) => (
          <Grid item xs={12} sm={6} md={2.4} key={c.label}>
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: `4px solid ${c.color}`, bgcolor: '#ffffff', height: '100%' }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>{c.label}</Typography>
              <Typography variant="h6" fontWeight={900} sx={{ color: c.color, mt: 0.5 }}>{c.value}</Typography>
              <Typography variant="caption" color="text.secondary">{c.sub}</Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      {/* REVENUE TREND */}
      {trend.length > 1 && (
        <Card variant="outlined" sx={{ p: 2, mb: 2.5, borderRadius: 4, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
            <TrendingUpIcon sx={{ color: 'primary.main', fontSize: 18 }} />
            <Typography variant="subtitle2" fontWeight={850} color="#0f172a">Revenue Trend ({dateRange})</Typography>
          </Stack>
          <Box sx={{ width: '100%', height: 220 }}>
            <ResponsiveContainer>
              <AreaChart data={trend} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="wsRev" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                <YAxis tick={{ fontSize: 11 }} width={70} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}k`} />
                <RechartsTooltip formatter={(v) => inr0(v)} />
                <Area type="monotone" dataKey="value" stroke="#4f46e5" strokeWidth={2} fill="url(#wsRev)" />
              </AreaChart>
            </ResponsiveContainer>
          </Box>
        </Card>
      )}

      {/* REPORT SWITCHER */}
      <Card variant="outlined" sx={{ p: 1.5, mb: 2.5, borderRadius: 4, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
        <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
          {REPORT_TABS.map(t => (
            <Chip
              key={t.id}
              icon={t.icon}
              label={t.name}
              onClick={() => setActiveTab(t.id)}
              color={activeTab === t.id ? 'primary' : 'default'}
              variant={activeTab === t.id ? 'filled' : 'outlined'}
              sx={{ fontWeight: 800, fontSize: '0.8rem', py: 2, px: 0.5, borderRadius: 2.5, cursor: 'pointer' }}
            />
          ))}
        </Stack>
      </Card>

      {/* REPORT CONTENT */}
      <Card variant="outlined" sx={{ borderRadius: 4, bgcolor: '#ffffff', borderColor: '#e2e8f0', overflow: 'hidden' }}>
        <Box sx={{ p: 2.5, bgcolor: '#0f172a', color: '#ffffff', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle1" fontWeight={850} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {activeReport.icon} {activeReport.name}
          </Typography>
          <Typography variant="caption" sx={{ color: '#94a3b8' }}>
            {dateRange} • {invoices.length} invoice(s) matched
          </Typography>
        </Box>

        {invoices.length === 0 ? (
          <Box sx={{ py: 8, textAlign: 'center' }}>
            <ReportsIcon sx={{ fontSize: 52, color: 'text.disabled', mb: 1 }} />
            <Typography variant="h6" fontWeight={800} color="text.secondary">No wholesale invoices for this period</Typography>
            <Typography variant="body2" color="text.secondary">
              Complete a sale in the Wholesale POS terminal — it will appear here automatically.
            </Typography>
          </Box>
        ) : (
          <TableContainer sx={{ overflowX: 'auto' }}>
            {/* ---- SALES REGISTER ---- */}
            {activeTab === 'sales-register' && (
              <Table size="small" sx={{ minWidth: 1050 }}>
                <TableHead sx={{ '& th': { bgcolor: '#f1f5f9', fontWeight: 850, whiteSpace: 'nowrap' } }}>
                  <TableRow>
                    <TableCell>Invoice No</TableCell>
                    <TableCell>Date</TableCell>
                    <TableCell>Customer</TableCell>
                    <TableCell align="center">Items</TableCell>
                    <TableCell align="center">Qty</TableCell>
                    <TableCell align="right">Taxable</TableCell>
                    <TableCell align="right">Discount</TableCell>
                    <TableCell align="right">GST</TableCell>
                    <TableCell align="right">Grand Total</TableCell>
                    <TableCell align="right">Due</TableCell>
                    <TableCell>Pay Mode</TableCell>
                    <TableCell align="center">Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {invoices.map((i) => (
                    <TableRow key={i.invoiceNo} hover sx={{ cursor: 'pointer' }} onClick={() => setDetailInvoice(i)}>
                      <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{i.invoiceNo}</TableCell>
                      <TableCell>{i.date}</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>
                        {i.customerName}
                        {i.customerCode && <Typography variant="caption" color="text.secondary" display="block">{i.customerCode}</Typography>}
                      </TableCell>
                      <TableCell align="center">{i.lineCount}</TableCell>
                      <TableCell align="center">{i.totalQty}</TableCell>
                      <TableCell align="right">{inr(i.taxable)}</TableCell>
                      <TableCell align="right" sx={{ color: '#dc2626' }}>−{inr(i.discount)}</TableCell>
                      <TableCell align="right" sx={{ color: '#b45309' }}>{inr(i.gst)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 850, color: 'primary.main' }}>{inr(i.grandTotal)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700, color: i.due > 0 ? '#dc2626' : '#059669' }}>{inr(i.due)}</TableCell>
                      <TableCell>{i.payMode}</TableCell>
                      <TableCell align="center">
                        <Chip
                          label={i.status}
                          size="small"
                          color={i.status === 'Paid' ? 'success' : i.status === 'Partial' ? 'warning' : 'error'}
                          sx={{ fontWeight: 800 }}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow sx={{ '& td': { fontWeight: 900, color: '#0f172a', borderTop: '2px solid #e2e8f0', fontSize: '0.85rem' } }}>
                    <TableCell colSpan={4}>TOTAL</TableCell>
                    <TableCell align="center">{kpi.units}</TableCell>
                    <TableCell align="right">{inr(kpi.taxable)}</TableCell>
                    <TableCell align="right" sx={{ color: '#dc2626' }}>−{inr(kpi.discount)}</TableCell>
                    <TableCell align="right" sx={{ color: '#b45309' }}>{inr(kpi.gst)}</TableCell>
                    <TableCell align="right" sx={{ color: 'primary.main' }}>{inr(kpi.revenue)}</TableCell>
                    <TableCell align="right" sx={{ color: '#dc2626' }}>{inr(kpi.due)}</TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                </TableFooter>
              </Table>
            )}

            {/* ---- CUSTOMER SUMMARY ---- */}
            {activeTab === 'customer-summary' && (
              <Table size="small" sx={{ minWidth: 900 }}>
                <TableHead sx={{ '& th': { bgcolor: '#f1f5f9', fontWeight: 850, whiteSpace: 'nowrap' } }}>
                  <TableRow>
                    <TableCell>Customer</TableCell>
                    <TableCell>Sales Exec</TableCell>
                    <TableCell align="center">Invoices</TableCell>
                    <TableCell align="center">Qty</TableCell>
                    <TableCell align="right">Taxable</TableCell>
                    <TableCell align="right">GST</TableCell>
                    <TableCell align="right">Total Business</TableCell>
                    <TableCell align="right">Outstanding</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {customerSummary.map((c) => (
                    <TableRow key={c.customerName} hover>
                      <TableCell sx={{ fontWeight: 700 }}>
                        {c.customerName}
                        {c.customerCode && <Typography variant="caption" color="text.secondary" display="block">{c.customerCode}</Typography>}
                      </TableCell>
                      <TableCell>{c.salesExec}</TableCell>
                      <TableCell align="center">{c.invoices}</TableCell>
                      <TableCell align="center">{c.qty}</TableCell>
                      <TableCell align="right">{inr(c.taxable)}</TableCell>
                      <TableCell align="right" sx={{ color: '#b45309' }}>{inr(c.gst)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 850, color: 'primary.main' }}>{inr(c.total)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700, color: c.due > 0 ? '#dc2626' : '#059669' }}>{inr(c.due)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {/* ---- PRODUCT MOVEMENT ---- */}
            {activeTab === 'product-movement' && (
              <Table size="small" sx={{ minWidth: 900 }}>
                <TableHead sx={{ '& th': { bgcolor: '#f1f5f9', fontWeight: 850, whiteSpace: 'nowrap' } }}>
                  <TableRow>
                    <TableCell>Code</TableCell>
                    <TableCell>Product</TableCell>
                    <TableCell>Brand</TableCell>
                    <TableCell>Category</TableCell>
                    <TableCell align="center">Qty Sold</TableCell>
                    <TableCell align="right">Gross</TableCell>
                    <TableCell align="right">GST</TableCell>
                    <TableCell align="right">Total</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {productMovement.map((p) => (
                    <TableRow key={p.code + p.name} hover>
                      <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'primary.main' }}>{p.code}</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>{p.name}</TableCell>
                      <TableCell>{p.brand}</TableCell>
                      <TableCell>{p.category}</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 800 }}>{p.qty}</TableCell>
                      <TableCell align="right">{inr(p.gross)}</TableCell>
                      <TableCell align="right" sx={{ color: '#b45309' }}>{inr(p.gst)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 850, color: 'primary.main' }}>{inr(p.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}

            {/* ---- GST SUMMARY ---- */}
            {activeTab === 'gst-summary' && (
              <Table size="small" sx={{ minWidth: 640 }}>
                <TableHead sx={{ '& th': { bgcolor: '#f1f5f9', fontWeight: 850, whiteSpace: 'nowrap' } }}>
                  <TableRow>
                    <TableCell>GST Slab</TableCell>
                    <TableCell align="right">Taxable Value</TableCell>
                    <TableCell align="right">CGST</TableCell>
                    <TableCell align="right">SGST</TableCell>
                    <TableCell align="right">Total Tax</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {gstSummary.map((g) => (
                    <TableRow key={g.rate} hover>
                      <TableCell sx={{ fontWeight: 800 }}>{g.rate}%</TableCell>
                      <TableCell align="right">{inr(g.taxable)}</TableCell>
                      <TableCell align="right">{inr(g.cgst)}</TableCell>
                      <TableCell align="right">{inr(g.sgst)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 850, color: '#b45309' }}>{inr(g.total)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
                <TableFooter>
                  <TableRow sx={{ '& td': { fontWeight: 900, color: '#0f172a', borderTop: '2px solid #e2e8f0', fontSize: '0.85rem' } }}>
                    <TableCell>TOTAL</TableCell>
                    <TableCell align="right">{inr(gstSummary.reduce((a, g) => a + g.taxable, 0))}</TableCell>
                    <TableCell align="right">{inr(gstSummary.reduce((a, g) => a + g.cgst, 0))}</TableCell>
                    <TableCell align="right">{inr(gstSummary.reduce((a, g) => a + g.sgst, 0))}</TableCell>
                    <TableCell align="right" sx={{ color: '#b45309' }}>{inr(gstSummary.reduce((a, g) => a + g.total, 0))}</TableCell>
                  </TableRow>
                </TableFooter>
              </Table>
            )}

            {/* ---- OUTSTANDING ---- */}
            {activeTab === 'outstanding' && (
              <Table size="small" sx={{ minWidth: 900 }}>
                <TableHead sx={{ '& th': { bgcolor: '#f1f5f9', fontWeight: 850, whiteSpace: 'nowrap' } }}>
                  <TableRow>
                    <TableCell>Customer</TableCell>
                    <TableCell>Sales Exec</TableCell>
                    <TableCell align="right">Credit Limit</TableCell>
                    <TableCell align="center">Terms</TableCell>
                    <TableCell align="right">Outstanding</TableCell>
                    <TableCell align="center">Utilisation</TableCell>
                    <TableCell>Last Purchase</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {outstanding.length === 0 ? (
                    <TableRow><TableCell colSpan={7} align="center" sx={{ py: 5, color: 'text.secondary' }}>No outstanding balances 🎉</TableCell></TableRow>
                  ) : outstanding.map((o) => {
                    const util = o.creditLimit > 0 ? o.outstanding / o.creditLimit : 0;
                    const color = util >= 0.9 ? '#dc2626' : util >= 0.6 ? '#d97706' : '#059669';
                    return (
                      <TableRow key={o.customerName} hover>
                        <TableCell sx={{ fontWeight: 700 }}>
                          {o.customerName}
                          {o.customerCode && <Typography variant="caption" color="text.secondary" display="block">{o.customerCode}</Typography>}
                        </TableCell>
                        <TableCell>{o.salesExec}</TableCell>
                        <TableCell align="right">{o.creditLimit > 0 ? inr0(o.creditLimit) : '—'}</TableCell>
                        <TableCell align="center">{o.creditDays}d</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 850, color: '#dc2626' }}>{inr(o.outstanding)}</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 800, color }}>
                          {o.creditLimit > 0 ? `${(util * 100).toFixed(0)}%` : '—'}
                        </TableCell>
                        <TableCell>{o.lastPurchase}</TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
                <TableFooter>
                  <TableRow sx={{ '& td': { fontWeight: 900, color: '#0f172a', borderTop: '2px solid #e2e8f0', fontSize: '0.85rem' } }}>
                    <TableCell colSpan={4}>TOTAL RECEIVABLE</TableCell>
                    <TableCell align="right" sx={{ color: '#dc2626' }}>{inr(outstanding.reduce((a, o) => a + o.outstanding, 0))}</TableCell>
                    <TableCell colSpan={2} />
                  </TableRow>
                </TableFooter>
              </Table>
            )}
          </TableContainer>
        )}
      </Card>

      {/* INVOICE DRILL-DOWN */}
      <Dialog open={!!detailInvoice} onClose={() => setDetailInvoice(null)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 850, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Wholesale Invoice #{detailInvoice?.invoiceNo}</span>
          <Button size="small" variant="contained" startIcon={<PrintIcon />} onClick={() => window.print()}>Print</Button>
        </DialogTitle>
        <DialogContent dividers>
          {detailInvoice && (
            <Box sx={{ p: 1 }}>
              <Grid container spacing={2} sx={{ mb: 2 }}>
                <Grid item xs={12} sm={6}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700} display="block">Billed To</Typography>
                  <Typography variant="subtitle2" fontWeight={850}>{detailInvoice.customerName}</Typography>
                  <Typography variant="caption" display="block">Code: {detailInvoice.customerCode || 'N/A'}</Typography>
                  <Typography variant="caption" display="block">GSTIN: {detailInvoice.customerGstin || 'N/A'}</Typography>
                </Grid>
                <Grid item xs={12} sm={6} sx={{ textAlign: { sm: 'right' } }}>
                  <Typography variant="caption" display="block">Date: {detailInvoice.date}</Typography>
                  <Typography variant="caption" display="block">Payment: {detailInvoice.payMode} {detailInvoice.refNo ? `(Ref: ${detailInvoice.refNo})` : ''}</Typography>
                  <Chip
                    label={detailInvoice.status}
                    size="small"
                    color={detailInvoice.status === 'Paid' ? 'success' : detailInvoice.status === 'Partial' ? 'warning' : 'error'}
                    sx={{ fontWeight: 800, mt: 0.5 }}
                  />
                </Grid>
              </Grid>

              <TableContainer component={Paper} variant="outlined">
                <Table size="small">
                  <TableHead sx={{ bgcolor: '#f1f5f9' }}>
                    <TableRow sx={{ '& th': { fontWeight: 800 } }}>
                      <TableCell>#</TableCell>
                      <TableCell>Item</TableCell>
                      <TableCell align="center">Qty</TableCell>
                      <TableCell align="right">Rate</TableCell>
                      <TableCell align="center">Disc %</TableCell>
                      <TableCell align="center">GST %</TableCell>
                      <TableCell align="right">Total</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {detailInvoice.items.map((it, idx) => {
                      const base = (parseFloat(it.rate) || 0) * (parseFloat(it.qty) || 0);
                      const gross = base - base * ((parseFloat(it.discount) || 0) / 100);
                      const total = gross * (1 + (parseFloat(it.gst) || 0) / 100);
                      return (
                        <TableRow key={idx}>
                          <TableCell>{idx + 1}</TableCell>
                          <TableCell>
                            <Typography variant="body2" fontWeight={700}>{it.name}</Typography>
                            <Typography variant="caption" color="text.secondary">{it.code} • {it.brand}</Typography>
                          </TableCell>
                          <TableCell align="center">{it.qty}</TableCell>
                          <TableCell align="right">{inr(it.rate)}</TableCell>
                          <TableCell align="center">{it.discount || 0}%</TableCell>
                          <TableCell align="center">{it.gst || 0}%</TableCell>
                          <TableCell align="right" sx={{ fontWeight: 700 }}>{inr(total)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>

              <Stack spacing={0.6} sx={{ mt: 2, alignItems: 'flex-end' }}>
                <Typography variant="caption">Subtotal: {inr(detailInvoice.subtotal)}</Typography>
                <Typography variant="caption" sx={{ color: '#dc2626' }}>Discount: −{inr(detailInvoice.discount)}</Typography>
                <Typography variant="caption" sx={{ color: '#b45309' }}>GST: +{inr(detailInvoice.gst)}</Typography>
                <Divider sx={{ width: 180 }} />
                <Typography variant="subtitle1" fontWeight={900} color="primary.main">Grand Total: {inr(detailInvoice.grandTotal)}</Typography>
                <Typography variant="caption" sx={{ color: detailInvoice.due > 0 ? '#dc2626' : '#059669' }}>
                  Paid: {inr(detailInvoice.paid)} • Due: {inr(detailInvoice.due)}
                </Typography>
              </Stack>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setDetailInvoice(null)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
