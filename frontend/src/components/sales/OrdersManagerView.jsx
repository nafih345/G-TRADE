import React, { useState } from 'react';
import {
  Box, Grid, Card, CardContent, Typography, Button,
  Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Paper, Chip, TextField, MenuItem, Stack,
  InputAdornment, LinearProgress, Divider, Avatar, Tooltip,
  IconButton, Dialog, DialogTitle, DialogContent, DialogActions,
  Stepper, Step, StepLabel, Tab, Tabs, Checkbox
} from '@mui/material';
import {
  LocalShipping as DeliveryIcon,
  Search as SearchIcon,
  Add as AddIcon,
  Print as PrintIcon,
  Visibility as ViewIcon,
  WhatsApp as WhatsAppIcon,
  Email as EmailIcon,
  CheckCircle as SuccessIcon,
  PendingActions as PendingIcon,
  FilterList as FilterIcon,
  Download as ExportIcon,
  MedicalServices as DoctorIcon,
  Build as LabIcon,
  AssignmentReturn as ReturnIcon,
  QrCode2 as QrCodeIcon,
  Phone as PhoneIcon,
  Schedule as ClockIcon,
  Inbox as EmptyIcon,
  PictureAsPdf as PdfIcon,
  ReceiptLong as InvoiceIcon,
  RequestQuote as QuotationIcon,
  ArrowForward as ConvertIcon,
  Edit as EditIcon,
  DoneAll as MarkDeliveredIcon
} from '@mui/icons-material';
import { printSalesInvoiceReceipt, downloadPdfInvoice } from '../../utils/printInvoice';
import { sendInvoiceWhatsApp } from '../../utils/whatsappInvoice';
import UpdateDocumentDialog from './UpdateDocumentDialog';

const todayStr = () => new Date().toISOString().split('T')[0];

// Lab Workflow Pipeline Stages
const labStages = [
  'Order Received',
  'Lens Cutting & Surfacing',
  'Frame Mounting & Fitting',
  'Quality Inspection (QC)',
  'Ready for Collection',
  'Delivered'
];

// The three retail documents this section is split into. One backend table (sales.Invoice,
// distinguished by document_type) backs all of them, so a Quotation can be converted to an
// Order and then to an Invoice in place.
const DOC_VIEWS = {
  ORDER: {
    label: 'Orders',
    icon: <DeliveryIcon />,
    title: 'Optical Spectacle & Lab Orders',
    subtitle: 'Confirmed spectacle jobs — laboratory pipeline, quality control & customer delivery tracking.',
    createLabel: '+ Create New Order'
  },
  INVOICE: {
    label: 'Invoices',
    icon: <InvoiceIcon />,
    title: 'Tax Invoices',
    subtitle: 'Billed sales — payment status, receipts and GST invoice reprints.',
    createLabel: '+ New Invoice'
  },
  QUOTATION: {
    label: 'Quotations',
    icon: <QuotationIcon />,
    title: 'Price Quotations & Estimates',
    subtitle: 'Estimates shared with customers. Convert an accepted quote into an Order or a tax Invoice.',
    createLabel: '+ New Quotation'
  }
};

const docTypeOf = (o) => (o.documentType || o.docType || 'INVOICE').toUpperCase();

export default function OrdersManagerView({
  orders = [],
  onNavigateToNewSale,
  onNavigateToEyeTest,
  onUpdateOrderStatus,
  onOpenRecordPayment,
  onPrintInvoice,
  onConvertDocument,
  onUpdateDocument,
  onBulkUpdate,
  onFetchDocument
}) {
  const [docView, setDocView] = useState('ORDER'); // 'ORDER' | 'INVOICE' | 'QUOTATION'
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [activeTab, setActiveTab] = useState('all'); // 'all', 'lab', 'ready', 'delivered'

  // Selected Order Detail Modal State
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [courierTracking, setCourierTracking] = useState('');

  // Update (full-edit) dialog state
  const [editTarget, setEditTarget] = useState(null);
  const [editFullDoc, setEditFullDoc] = useState(null);
  const [editOpen, setEditOpen] = useState(false);

  // Bulk selection
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  const openEditDialog = async (ord) => {
    setEditTarget(ord);
    setEditFullDoc(null);
    setEditOpen(true);
    if (onFetchDocument) {
      try {
        const full = await onFetchDocument(ord.id);
        setEditFullDoc(full || null);
      } catch (e) { /* fall back to row data */ }
    }
  };

  const markDelivered = (ord) => {
    const patch = { status: 'Delivered', deliveredAt: ord.deliveredAt || todayStr() };
    onUpdateDocument?.(ord, patch);
    if (selectedOrder && selectedOrder.id === ord.id) {
      setSelectedOrder({ ...selectedOrder, status: 'Delivered' });
    }
    const balanceDue = (parseFloat(ord.total) || parseFloat(ord.amount) || 0) - (parseFloat(ord.paidAmount) || 0);
    if (balanceDue > 0) onOpenRecordPayment?.(ord);
  };

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const cfg = DOC_VIEWS[docView];
  // Map the active document view to a Bill Designer document type so each prints with
  // its own assigned template.
  const billDocType = { ORDER: 'ORDER_BILL', QUOTATION: 'QUOTATION', INVOICE: 'SALES_INVOICE' }[docView] || 'SALES_INVOICE';

  // Counts across ALL rows, for the top document-type switcher badges
  const totalByType = {
    ORDER: orders.filter(o => docTypeOf(o) === 'ORDER').length,
    INVOICE: orders.filter(o => docTypeOf(o) === 'INVOICE').length,
    QUOTATION: orders.filter(o => docTypeOf(o) === 'QUOTATION').length
  };

  // Rows for the currently selected document type
  const scopedList = orders.filter(o => docTypeOf(o) === docView);

  const switchDocView = (next) => {
    setDocView(next);
    setActiveTab('all');
    setStatusFilter('All');
    setSelectedIds(new Set());
  };

  const runBulk = (patch) => {
    const ids = [...selectedIds];
    if (ids.length === 0) return;
    onBulkUpdate?.(ids, patch);
    setSelectedIds(new Set());
  };

  // Filter rows (search + sub-tab + status)
  const filteredOrders = scopedList.filter(o => {
    const custName = o.customer || o.customerName || 'Walk-in Customer';
    const matchesSearch = custName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          (o.id && String(o.id).toLowerCase().includes(searchQuery.toLowerCase())) ||
                          (o.invoiceNumber && o.invoiceNumber.toLowerCase().includes(searchQuery.toLowerCase())) ||
                          (o.frame && o.frame.toLowerCase().includes(searchQuery.toLowerCase())) ||
                          (o.lens && o.lens.toLowerCase().includes(searchQuery.toLowerCase()));

    let matchesTab = true;
    if (docView === 'ORDER') {
      if (activeTab === 'lab') matchesTab = o.status !== 'Delivered' && o.status !== 'Ready for Collection';
      if (activeTab === 'ready') matchesTab = o.status === 'Ready for Collection' || o.status === 'Ready';
      if (activeTab === 'delivered') matchesTab = o.status === 'Delivered';
    } else if (docView === 'INVOICE') {
      if (activeTab === 'paid') matchesTab = o.payment === 'Paid';
      if (activeTab === 'outstanding') matchesTab = o.payment !== 'Paid';
    }

    const matchesStatus = statusFilter === 'All' || o.status === statusFilter || o.payment === statusFilter;
    return matchesSearch && matchesTab && matchesStatus;
  });

  // Metrics for the currently selected document type
  const scopedCount = scopedList.length;
  const inLabCount = scopedList.filter(o => o.status !== 'Delivered' && o.status !== 'Ready for Collection').length;
  const readyCount = scopedList.filter(o => o.status === 'Ready for Collection' || o.status === 'Ready').length;
  const deliveredCount = scopedList.filter(o => o.status === 'Delivered').length;
  const paidCount = scopedList.filter(o => o.payment === 'Paid').length;
  const outstandingCount = scopedCount - paidCount;
  const scopedValue = scopedList.reduce((sum, o) => sum + (parseFloat(o.total) || parseFloat(o.amount) || 0), 0);
  const collectedValue = scopedList.reduce((sum, o) => sum + (parseFloat(o.paidAmount) || 0), 0);

  const kpiCards = {
    ORDER: [
      { label: 'TOTAL ORDERS', value: scopedCount, color: '#2563eb', hint: 'Confirmed spectacle jobs' },
      { label: 'IN LAB PROCESSING', value: inLabCount, color: '#d97706', hint: 'Lens cutting & fitting in progress' },
      { label: 'READY FOR PICKUP', value: readyCount, color: '#10b981', hint: 'QC passed & ready for delivery' },
      { label: 'ORDER VALUE', value: `₹${scopedValue.toLocaleString()}`, color: '#7c3aed', hint: 'Gross value of open orders' }
    ],
    INVOICE: [
      { label: 'TOTAL INVOICES', value: scopedCount, color: '#2563eb', hint: 'Billed sales recorded' },
      { label: 'PAID IN FULL', value: paidCount, color: '#10b981', hint: 'Settled invoices' },
      { label: 'OUTSTANDING', value: outstandingCount, color: '#d97706', hint: 'Partly paid or unpaid' },
      { label: 'REVENUE COLLECTED', value: `₹${collectedValue.toLocaleString()}`, color: '#7c3aed', hint: 'Payments received against invoices' }
    ],
    QUOTATION: [
      { label: 'TOTAL QUOTATIONS', value: scopedCount, color: '#2563eb', hint: 'Estimates issued to customers' },
      { label: 'OPEN QUOTES', value: scopedCount, color: '#d97706', hint: 'Awaiting customer decision' },
      { label: 'QUOTED VALUE', value: `₹${scopedValue.toLocaleString()}`, color: '#7c3aed', hint: 'Total value of open estimates' }
    ]
  }[docView];

  const subTabs = {
    ORDER: [
      { label: `All Orders (${scopedCount})`, value: 'all' },
      { label: `Lab Queue (${inLabCount})`, value: 'lab' },
      { label: `Ready for Pickup (${readyCount})`, value: 'ready' },
      { label: `Delivered (${deliveredCount})`, value: 'delivered' }
    ],
    INVOICE: [
      { label: `All Invoices (${scopedCount})`, value: 'all' },
      { label: `Paid (${paidCount})`, value: 'paid' },
      { label: `Outstanding (${outstandingCount})`, value: 'outstanding' }
    ],
    QUOTATION: [
      { label: `All Quotations (${scopedCount})`, value: 'all' }
    ]
  }[docView];

  const getStageIndex = (status) => {
    switch (status) {
      case 'Order Received': return 0;
      case 'In Lab Processing': return 1;
      case 'Frame Mounting': return 2;
      case 'Quality Control': return 3;
      case 'Ready for Collection': return 4;
      case 'Delivered': return 5;
      default: return 1;
    }
  };

  const handleAdvanceStatus = (orderId, currentStatus) => {
    const nextStatuses = ['Order Received', 'In Lab Processing', 'Frame Mounting', 'Quality Control', 'Ready for Collection', 'Delivered'];
    const idx = nextStatuses.indexOf(currentStatus);
    const nextStatus = idx < nextStatuses.length - 1 ? nextStatuses[idx + 1] : 'Delivered';
    if (selectedOrder && selectedOrder.id === orderId) {
      setSelectedOrder({ ...selectedOrder, status: nextStatus });
    }
    onUpdateOrderStatus?.(orderId, nextStatus);
  };

  const handleConvert = (ord, targetType) => {
    const targetLabel = DOC_VIEWS[targetType].label.replace(/s$/, '');
    if (!window.confirm(`Convert ${ord.invoiceNumber || ord.id} into a ${targetLabel}?`)) return;
    onConvertDocument?.(ord, targetType);
  };

  return (
    <Box>
      {/* Title & Quick Navigation Action Bar */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1.5 }}>
            {React.cloneElement(cfg.icon, { sx: { fontSize: 36 } })} {cfg.title}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {cfg.subtitle}
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} flexWrap="wrap">
          <Button
            variant="outlined"
            color="success"
            startIcon={<DoctorIcon />}
            onClick={onNavigateToEyeTest}
            sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 600 }}
          >
            Eye Exam Booking
          </Button>

          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={onNavigateToNewSale}
            sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700, px: 3 }}
          >
            {cfg.createLabel}
          </Button>
        </Stack>
      </Box>

      {/* KPI Summary Cards */}
      <Grid container spacing={2.5} sx={{ mb: 3 }}>
        {kpiCards.map((k) => (
          <Grid item xs={12} sm={6} md={kpiCards.length === 3 ? 4 : 3} key={k.label}>
            <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, borderLeft: `4px solid ${k.color}`, bgcolor: 'background.paper' }}>
              <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">{k.label}</Typography>
              <Typography variant="h4" fontWeight={900} sx={{ my: 0.5, color: k.color }}>{k.value}</Typography>
              <Typography variant="caption" color="text.secondary">{k.hint}</Typography>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Document Type Switcher — Orders / Invoices / Quotations */}
      <Card elevation={0} sx={{ p: 1, border: '1px solid', borderColor: 'divider', borderRadius: 3, mb: 3, display: 'flex', gap: 1, flexWrap: 'wrap' }}>
        {Object.entries(DOC_VIEWS).map(([key, v]) => {
          const active = docView === key;
          return (
            <Button
              key={key}
              onClick={() => switchDocView(key)}
              startIcon={v.icon}
              variant={active ? 'contained' : 'text'}
              sx={{
                flex: '1 1 180px',
                py: 1.2,
                borderRadius: 2.5,
                textTransform: 'none',
                fontWeight: 800,
                fontSize: '0.95rem',
                bgcolor: active ? '#0f172a' : 'transparent',
                color: active ? '#facc15' : 'text.primary',
                '&:hover': { bgcolor: active ? '#0f172a' : 'action.hover' }
              }}
            >
              {v.label}
              <Chip
                label={totalByType[key]}
                size="small"
                sx={{
                  ml: 1, height: 20, fontWeight: 800,
                  bgcolor: active ? '#facc15' : 'action.selected',
                  color: active ? '#0f172a' : 'text.primary'
                }}
              />
            </Button>
          );
        })}
      </Card>

      {/* Filter Tabs & Search Controls */}
      <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, mb: 3 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
          <Tabs
            value={activeTab}
            onChange={(e, val) => setActiveTab(val)}
            indicatorColor="primary"
            textColor="primary"
            sx={{ minHeight: 40, '& .MuiTab-root': { textTransform: 'none', fontWeight: 700, fontSize: '0.9rem' } }}
          >
            {subTabs.map((t) => (
              <Tab key={t.value} label={t.label} value={t.value} />
            ))}
          </Tabs>

          <Stack direction="row" spacing={1.5} flexWrap="wrap">
            <TextField
              size="small"
              placeholder={`Search ${cfg.label.replace(/s$/, '')} No, Customer, Frame...`}
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{
                startAdornment: <InputAdornment position="start"><SearchIcon color="action" fontSize="small" /></InputAdornment>,
                sx: { borderRadius: 2, width: 260 }
              }}
            />

            {docView === 'ORDER' && (
              <TextField
                select
                size="small"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                sx={{ minWidth: 160, '& .MuiSelect-select': { borderRadius: 2 } }}
              >
                <MenuItem value="All">All Pipeline Statuses</MenuItem>
                <MenuItem value="Order Received">Order Received</MenuItem>
                <MenuItem value="In Lab Processing">In Lab Processing</MenuItem>
                <MenuItem value="Quality Control">Quality Control (QC)</MenuItem>
                <MenuItem value="Ready for Collection">Ready for Collection</MenuItem>
                <MenuItem value="Delivered">Delivered</MenuItem>
              </TextField>
            )}

            {docView === 'INVOICE' && (
              <TextField
                select
                size="small"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                sx={{ minWidth: 160, '& .MuiSelect-select': { borderRadius: 2 } }}
              >
                <MenuItem value="All">All Payment Statuses</MenuItem>
                <MenuItem value="Paid">Paid</MenuItem>
                <MenuItem value="Partial">Partially Paid</MenuItem>
                <MenuItem value="Unpaid">Unpaid</MenuItem>
              </TextField>
            )}
          </Stack>
        </Box>
      </Card>

      {/* Bulk action bar — shown when one or more rows are ticked */}
      {selectedIds.size > 0 && (
        <Card elevation={0} sx={{ p: 1.5, mb: 2, border: '1px solid', borderColor: 'primary.main', borderRadius: 3, display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', bgcolor: 'action.hover' }}>
          <Typography variant="subtitle2" fontWeight={800} sx={{ px: 1 }}>
            {selectedIds.size} selected
          </Typography>
          {docView !== 'QUOTATION' && (
            <TextField
              select size="small" value=""
              onChange={(e) => e.target.value && runBulk({ status: e.target.value })}
              SelectProps={{ displayEmpty: true }}
              sx={{ minWidth: 210 }}
            >
              <MenuItem value="" disabled>Set pipeline status…</MenuItem>
              {['Order Received', 'In Lab Processing', 'Frame Mounting', 'Quality Control', 'Ready for Collection', 'Delivered'].map(s => (
                <MenuItem key={s} value={s}>{s}</MenuItem>
              ))}
            </TextField>
          )}
          {docView === 'ORDER' && (
            <Button
              size="small" variant="contained" color="success" startIcon={<MarkDeliveredIcon />}
              onClick={() => runBulk({ status: 'Delivered', deliveredAt: todayStr() })}
              sx={{ textTransform: 'none', fontWeight: 700 }}
            >
              Mark Delivered
            </Button>
          )}
          <Button size="small" onClick={() => setSelectedIds(new Set())} sx={{ textTransform: 'none', fontWeight: 700 }}>
            Clear
          </Button>
        </Card>
      )}

      {/* Main Data Table / Empty State */}
      <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
        {filteredOrders.length === 0 ? (
          /* Empty State */
          <Box sx={{ p: 6, textAlign: 'center', bgcolor: 'action.hover', border: '2px dashed', borderColor: 'divider', borderRadius: 3 }}>
            <Avatar sx={{ mx: 'auto', bgcolor: 'primary.main', width: 56, height: 56, mb: 2 }}>
              <EmptyIcon sx={{ fontSize: 32 }} />
            </Avatar>
            <Typography variant="h6" fontWeight={800} gutterBottom>
              No {cfg.label} Found
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480, mx: 'auto', mb: 3 }}>
              No {cfg.label.toLowerCase()} match your search or exist yet. Use New Sale to create one — pick the
              <strong> {DOC_VIEWS[docView].label.replace(/s$/, '')}</strong> document type on the billing screen.
            </Typography>
            <Button
              variant="contained"
              color="primary"
              startIcon={<AddIcon />}
              onClick={onNavigateToNewSale}
              sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700, px: 3 }}
            >
              {cfg.createLabel}
            </Button>
          </Box>
        ) : (
          /* Data Table */
          <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2.5 }}>
            <Table>
              <TableHead sx={{ bgcolor: 'action.hover' }}>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox
                      size="small"
                      checked={filteredOrders.length > 0 && filteredOrders.every(o => selectedIds.has(o.id))}
                      indeterminate={filteredOrders.some(o => selectedIds.has(o.id)) && !filteredOrders.every(o => selectedIds.has(o.id))}
                      onChange={(e) => {
                        setSelectedIds(prev => {
                          const next = new Set(prev);
                          filteredOrders.forEach(o => e.target.checked ? next.add(o.id) : next.delete(o.id));
                          return next;
                        });
                      }}
                    />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>
                    {docView === 'ORDER' ? 'Order ID' : docView === 'QUOTATION' ? 'Quotation No' : 'Invoice No'}
                  </TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Date</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Customer Name</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Prescribed Frame &amp; Lens</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Total {docView === 'QUOTATION' ? 'Quoted' : 'Payable'}</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Payment Status</TableCell>
                  {docView === 'ORDER' && <TableCell sx={{ fontWeight: 800 }}>Lab Pipeline Status</TableCell>}
                  <TableCell sx={{ fontWeight: 800, textAlign: 'right' }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredOrders.map((ord) => {
                  const custName = ord.customer || ord.customerName || 'Walk-in Customer';
                  const rawPhone = ord.phone || ord.customer_phone || '';
                  const displayPhone = (rawPhone && !rawPhone.includes('9847012345') && !rawPhone.includes('98470 12345')) ? rawPhone : '';
                  const isPaid = ord.payment === 'Paid';
                  const isDelivered = ord.status === 'Delivered';
                  const isReady = ord.status === 'Ready for Collection' || ord.status === 'Ready';

                  const handleUpdatePhone = () => {
                    const newPhone = prompt(`Enter Registered Phone Number for ${custName}:`, displayPhone);
                    if (newPhone !== null && newPhone.trim() !== '') {
                      try {
                        ord.phone = newPhone.trim();
                        const invs = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
                        const updatedInvs = invs.map(i => i.id === ord.id ? { ...i, phone: newPhone.trim() } : i);
                        localStorage.setItem('optical_sales_invoices', JSON.stringify(updatedInvs));

                        const custs = JSON.parse(localStorage.getItem('optical_sales_customers') || '[]');
                        const updatedCusts = custs.map(c => (c.name && c.name.toLowerCase() === custName.toLowerCase()) ? { ...c, phone: newPhone.trim() } : c);
                        localStorage.setItem('optical_sales_customers', JSON.stringify(updatedCusts));

                        window.dispatchEvent(new Event('optical_stock_updated'));
                      } catch(e) {}
                    }
                  };

                  return (
                    <TableRow key={ord.id} hover selected={selectedIds.has(ord.id)}>
                      <TableCell padding="checkbox">
                        <Checkbox size="small" checked={selectedIds.has(ord.id)} onChange={() => toggleSelect(ord.id)} />
                      </TableCell>
                      <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>
                        {ord.invoiceNumber || ord.id}
                      </TableCell>
                      <TableCell sx={{ fontSize: '0.85rem' }}>{ord.date}</TableCell>
                      <TableCell>
                        <Typography variant="subtitle2" fontWeight={800}>{custName}</Typography>
                        {displayPhone ? (
                          <Typography
                            variant="caption"
                            color="primary.main"
                            fontWeight={700}
                            onClick={handleUpdatePhone}
                            sx={{ cursor: 'pointer', '&:hover': { textDecoration: 'underline' } }}
                            title="Click to edit patient registered phone number"
                          >
                            📞 {displayPhone}
                          </Typography>
                        ) : (
                          <Button
                            size="small"
                            variant="text"
                            color="secondary"
                            onClick={handleUpdatePhone}
                            sx={{ fontSize: '0.72rem', p: 0, minWidth: 'auto', textTransform: 'none', fontWeight: 700 }}
                          >
                            + Add Registered Phone
                          </Button>
                        )}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={700} noWrap sx={{ maxWidth: 220 }}>
                          👓 {ord.frame || 'Prescribed Frame'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" display="block" noWrap sx={{ maxWidth: 220 }}>
                          🔍 {ord.lens || 'Prescribed Lens'}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ fontWeight: 900, fontSize: '1rem' }}>
                        ₹{(parseFloat(ord.total) || parseFloat(ord.amount) || 0).toLocaleString()}
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={docView === 'QUOTATION' ? (ord.status || 'Draft') : (ord.payment || 'Paid')}
                          size="small"
                          color={docView === 'QUOTATION' ? 'default' : (isPaid ? 'success' : 'warning')}
                          variant={isPaid && docView !== 'QUOTATION' ? 'filled' : 'outlined'}
                          sx={{ fontWeight: 700, fontSize: '0.72rem' }}
                        />
                      </TableCell>
                      {docView === 'ORDER' && (
                        <TableCell>
                          <Chip
                            label={ord.status || 'In Lab Processing'}
                            size="small"
                            color={isDelivered ? 'info' : isReady ? 'success' : 'warning'}
                            variant="outlined"
                            icon={isDelivered ? <SuccessIcon fontSize="small" /> : <LabIcon fontSize="small" />}
                            sx={{ fontWeight: 700, fontSize: '0.72rem' }}
                          />
                        </TableCell>
                      )}
                      <TableCell align="right">
                        <Stack direction="row" spacing={0.5} justifyContent="flex-end" alignItems="center" flexWrap="wrap">
                          {docView === 'QUOTATION' && (
                            <>
                              <Tooltip title="Convert to Order">
                                <Button
                                  size="small" variant="outlined" color="primary"
                                  onClick={() => handleConvert(ord, 'ORDER')}
                                  sx={{ minWidth: 'auto', px: 1, fontWeight: 700, textTransform: 'none', fontSize: '0.72rem' }}
                                >
                                  → Order
                                </Button>
                              </Tooltip>
                              <Tooltip title="Convert to Tax Invoice">
                                <Button
                                  size="small" variant="outlined" color="success"
                                  onClick={() => handleConvert(ord, 'INVOICE')}
                                  sx={{ minWidth: 'auto', px: 1, fontWeight: 700, textTransform: 'none', fontSize: '0.72rem' }}
                                >
                                  → Invoice
                                </Button>
                              </Tooltip>
                            </>
                          )}
                          {docView === 'ORDER' && (
                            <Tooltip title="Convert to Tax Invoice">
                              <Button
                                size="small" variant="outlined" color="success"
                                onClick={() => handleConvert(ord, 'INVOICE')}
                                sx={{ minWidth: 'auto', px: 1, fontWeight: 700, textTransform: 'none', fontSize: '0.72rem' }}
                              >
                                → Invoice
                              </Button>
                            </Tooltip>
                          )}

                          <Tooltip title={`Update this ${cfg.label.replace(/s$/, '')}`}>
                            <IconButton size="small" color="secondary" onClick={() => openEditDialog(ord)}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          {docView === 'ORDER' && !isDelivered && (
                            <Tooltip title="Mark as Delivered">
                              <IconButton size="small" color="success" onClick={() => markDelivered(ord)}>
                                <MarkDeliveredIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          )}

                          <Tooltip title={docView === 'ORDER' ? 'View Order Pipeline Details' : 'View Details'}>
                            <IconButton
                              size="small"
                              color="primary"
                              onClick={() => { setSelectedOrder(ord); setDetailModalOpen(true); }}
                            >
                              <ViewIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title={docView === 'QUOTATION' ? 'Print Quotation' : docView === 'ORDER' ? 'Print Lab Job Work Slip' : 'Print Invoice'}>
                            <IconButton size="small" color="inherit" onClick={() => {
                              if (onPrintInvoice) onPrintInvoice(ord);
                              printSalesInvoiceReceipt(ord, 'A4', billDocType);
                            }}>
                              <PrintIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Download PDF">
                            <IconButton size="small" color="error" onClick={() => downloadPdfInvoice(ord, billDocType)}>
                              <PdfIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Send via WhatsApp">
                            <IconButton size="small" color="success" onClick={() => sendInvoiceWhatsApp(ord)}>
                              <WhatsAppIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>

      {/* Order Pipeline & Job Slip Modal */}
      {selectedOrder && (
        <Dialog open={detailModalOpen} onClose={() => setDetailModalOpen(false)} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
          <DialogTitle sx={{ fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <LabIcon color="primary" /> {docView === 'ORDER' ? 'Optical Order Job Slip & Tracking' : `${cfg.label.replace(/s$/, '')} Details`} — {selectedOrder.invoiceNumber || selectedOrder.id}
            </Box>
            <Chip label={selectedOrder.status || (docView === 'QUOTATION' ? 'Draft' : selectedOrder.payment)} color="primary" sx={{ fontWeight: 700 }} />
          </DialogTitle>

          <Divider />

          <DialogContent sx={{ py: 3 }}>
            {docView === 'ORDER' && (
              <>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 2 }}>
                  Optical Laboratory Workflow Stepper
                </Typography>
                <Stepper activeStep={getStageIndex(selectedOrder.status)} alternativeLabel sx={{ mb: 4 }}>
                  {labStages.map((stage) => (
                    <Step key={stage}>
                      <StepLabel>
                        <Typography variant="caption" fontWeight={700}>{stage}</Typography>
                      </StepLabel>
                    </Step>
                  ))}
                </Stepper>
              </>
            )}

            {/* Customer & Prescription Details */}
            <Grid container spacing={2.5} sx={{ mb: 3 }}>
              <Grid item xs={12} sm={6}>
                <Card variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>CUSTOMER DETAILS</Typography>
                  <Typography variant="subtitle1" fontWeight={800}>{selectedOrder.customer}</Typography>
                  <Typography variant="body2" color="text.secondary">Phone: {selectedOrder.phone || '+91 98765-43210'}</Typography>
                  <Typography variant="body2" color="text.secondary">Date: {selectedOrder.date}</Typography>
                </Card>
              </Grid>

              <Grid item xs={12} sm={6}>
                <Card variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>PRESCRIBED SPECTACLE ITEMS</Typography>
                  <Typography variant="body2" fontWeight={800} color="primary.main">👓 {selectedOrder.frame || 'Prescribed Frame'}</Typography>
                  <Typography variant="body2" fontWeight={800} color="success.main">🔍 {selectedOrder.lens || 'Prescribed Lens'}</Typography>
                  <Typography variant="subtitle1" fontWeight={900} sx={{ mt: 0.5 }}>
                    Total: ₹{(parseFloat(selectedOrder.total) || 0).toLocaleString()} ({selectedOrder.payment || (docView === 'QUOTATION' ? 'Estimate' : '')})
                  </Typography>
                </Card>
              </Grid>
            </Grid>

            {/* Convert / Advance Controls */}
            {docView === 'ORDER' && (
              <Box sx={{ p: 2.5, bgcolor: '#f8fafc', borderRadius: 2.5, border: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <Box>
                  <Typography variant="subtitle2" fontWeight={800}>Optical Lab Status Control</Typography>
                  <Typography variant="caption" color="text.secondary">Advance this order to the next stage, or bill it as a tax invoice.</Typography>
                </Box>
                <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                  <Button
                    variant="outlined"
                    color="secondary"
                    startIcon={<EditIcon />}
                    onClick={() => { setDetailModalOpen(false); openEditDialog(selectedOrder); }}
                    sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
                  >
                    Update Details
                  </Button>
                  <Button
                    variant="outlined"
                    color="success"
                    startIcon={<ConvertIcon />}
                    onClick={() => { setDetailModalOpen(false); handleConvert(selectedOrder, 'INVOICE'); }}
                    sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
                  >
                    Convert to Invoice
                  </Button>
                  {selectedOrder.status !== 'Delivered' && (
                    <Button
                      variant="contained"
                      color="success"
                      startIcon={<MarkDeliveredIcon />}
                      onClick={() => markDelivered(selectedOrder)}
                      sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
                    >
                      Mark Delivered
                    </Button>
                  )}
                  <Button
                    variant="contained"
                    color="secondary"
                    startIcon={<LabIcon />}
                    onClick={() => handleAdvanceStatus(selectedOrder.id, selectedOrder.status)}
                    sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
                  >
                    Advance Lab Stage
                  </Button>
                </Stack>
              </Box>
            )}

            {docView === 'QUOTATION' && (
              <Box sx={{ p: 2.5, bgcolor: '#f8fafc', borderRadius: 2.5, border: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
                <Box>
                  <Typography variant="subtitle2" fontWeight={800}>Quotation Conversion</Typography>
                  <Typography variant="caption" color="text.secondary">Turn this accepted estimate into a lab order or a tax invoice.</Typography>
                </Box>
                <Stack direction="row" spacing={1}>
                  <Button variant="outlined" color="primary" startIcon={<ConvertIcon />}
                    onClick={() => { setDetailModalOpen(false); handleConvert(selectedOrder, 'ORDER'); }}
                    sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}>
                    Convert to Order
                  </Button>
                  <Button variant="contained" color="success" startIcon={<ConvertIcon />}
                    onClick={() => { setDetailModalOpen(false); handleConvert(selectedOrder, 'INVOICE'); }}
                    sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}>
                    Convert to Invoice
                  </Button>
                </Stack>
              </Box>
            )}

            {docView === 'INVOICE' && renderInvoicePaymentBlock(selectedOrder, onOpenRecordPayment)}
          </DialogContent>

          <DialogActions sx={{ p: 2.5 }}>
            <Button variant="outlined" onClick={() => printSalesInvoiceReceipt(selectedOrder, 'A4', billDocType)} startIcon={<PrintIcon />}>
              Print {docView === 'QUOTATION' ? 'Quotation' : docView === 'ORDER' ? 'Job Slip' : 'Invoice'}
            </Button>
            <Button variant="contained" onClick={() => setDetailModalOpen(false)}>
              Close
            </Button>
          </DialogActions>
        </Dialog>
      )}

      {/* Full-edit Update dialog */}
      {editTarget && (
        <UpdateDocumentDialog
          open={editOpen}
          docView={docTypeOf(editTarget)}
          doc={editTarget}
          fullDoc={editFullDoc}
          onClose={() => { setEditOpen(false); setEditTarget(null); setEditFullDoc(null); }}
          onSave={(patch) => {
            onUpdateDocument?.(editTarget, patch);
            setEditOpen(false); setEditTarget(null); setEditFullDoc(null);
          }}
        />
      )}
    </Box>
  );
}

// Small "record payment" prompt shown inside the Invoice detail modal for unsettled invoices.
function renderInvoicePaymentBlock(order, onOpenRecordPayment) {
  if (order.payment === 'Paid') {
    return (
      <Box sx={{ p: 2.5, bgcolor: '#f0fdf4', borderRadius: 2.5, border: '1px solid', borderColor: 'success.light' }}>
        <Typography variant="subtitle2" fontWeight={800} color="success.main">Invoice settled in full</Typography>
      </Box>
    );
  }
  return (
    <Box sx={{ p: 2.5, bgcolor: '#fffbeb', borderRadius: 2.5, border: '1px solid', borderColor: 'warning.light', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Box>
        <Typography variant="subtitle2" fontWeight={800}>Payment outstanding</Typography>
        <Typography variant="caption" color="text.secondary">
          Paid ₹{(parseFloat(order.paidAmount) || 0).toLocaleString()} of ₹{(parseFloat(order.total) || 0).toLocaleString()}.
        </Typography>
      </Box>
      <Button variant="contained" color="warning" onClick={() => onOpenRecordPayment?.()} sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}>
        Record Payment
      </Button>
    </Box>
  );
}
