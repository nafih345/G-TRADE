import React, { useState } from 'react';
import { 
  Box, Grid, Card, CardContent, Typography, Button, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Chip, TextField, MenuItem, Stack, 
  InputAdornment, LinearProgress, Divider, Avatar, Tooltip,
  IconButton, Dialog, DialogTitle, DialogContent, DialogActions,
  Stepper, Step, StepLabel, Tab, Tabs
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
  PictureAsPdf as PdfIcon
} from '@mui/icons-material';
import { printSalesInvoiceReceipt, downloadPdfInvoice } from '../../utils/printInvoice';
import { sendInvoiceWhatsApp } from '../../utils/whatsappInvoice';

// Lab Workflow Pipeline Stages
const labStages = [
  'Order Received',
  'Lens Cutting & Surfacing',
  'Frame Mounting & Fitting',
  'Quality Inspection (QC)',
  'Ready for Collection',
  'Delivered'
];

export default function OrdersManagerView({
  orders = [],
  onNavigateToNewSale,
  onNavigateToEyeTest,
  onUpdateOrderStatus,
  onOpenRecordPayment,
  onPrintInvoice
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');
  const [activeTab, setActiveTab] = useState('all'); // 'all', 'lab', 'ready', 'delivered'

  // Selected Order Detail Modal State
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [courierTracking, setCourierTracking] = useState('');

  // Default orders dataset if database is empty
  const ordersList = orders;

  // Filter Orders
  const filteredOrders = ordersList.filter(o => {
    const custName = o.customer || o.customerName || 'Walk-in Customer';
    const matchesSearch = custName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          (o.id && o.id.toLowerCase().includes(searchQuery.toLowerCase())) ||
                          (o.frame && o.frame.toLowerCase().includes(searchQuery.toLowerCase())) ||
                          (o.lens && o.lens.toLowerCase().includes(searchQuery.toLowerCase()));
    
    let matchesTab = true;
    if (activeTab === 'lab') matchesTab = o.status !== 'Delivered' && o.status !== 'Ready for Collection';
    if (activeTab === 'ready') matchesTab = o.status === 'Ready for Collection' || o.status === 'Ready';
    if (activeTab === 'delivered') matchesTab = o.status === 'Delivered';

    const matchesStatus = statusFilter === 'All' || o.status === statusFilter || o.payment === statusFilter;
    return matchesSearch && matchesTab && matchesStatus;
  });

  // Calculate Metrics
  const totalOrdersCount = ordersList.length;
  const inLabCount = ordersList.filter(o => o.status !== 'Delivered' && o.status !== 'Ready for Collection').length;
  const readyCount = ordersList.filter(o => o.status === 'Ready for Collection' || o.status === 'Ready').length;
  const totalRevenue = ordersList.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);

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

  return (
    <Box>
      {/* Title & Quick Navigation Action Bar */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3.5, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <DeliveryIcon sx={{ fontSize: 36 }} /> Optical Spectacle & Lab Orders Manager
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Optical laboratory job tracking, lens surfacing pipeline, quality control & customer delivery management.
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
            + Create New Order
          </Button>
        </Stack>
      </Box>

      {/* KPI Summary Cards */}
      <Grid container spacing={2.5} sx={{ mb: 3.5 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: 'background.paper' }}>
            <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">TOTAL ORDERS IN DATABASE</Typography>
            <Typography variant="h4" fontWeight={900} color="primary.main" sx={{ my: 0.5 }}>{totalOrdersCount}</Typography>
            <Typography variant="caption" color="text.secondary">Total sales orders recorded</Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: 'background.paper' }}>
            <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">IN LAB PROCESSING QUEUE</Typography>
            <Typography variant="h4" fontWeight={900} sx={{ color: '#d97706', my: 0.5 }}>{inLabCount}</Typography>
            <Typography variant="caption" color="text.secondary">Lens cutting & fitting in progress</Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: 'background.paper' }}>
            <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">READY FOR PICKUP</Typography>
            <Typography variant="h4" fontWeight={900} color="success.main" sx={{ my: 0.5 }}>{readyCount}</Typography>
            <Typography variant="caption" color="text.secondary">QC passed & ready for delivery</Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: 'background.paper' }}>
            <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">ACCUMULATED ORDER REVENUE</Typography>
            <Typography variant="h4" fontWeight={900} sx={{ color: '#7c3aed', my: 0.5 }}>₹{totalRevenue.toLocaleString()}</Typography>
            <Typography variant="caption" color="text.secondary">Gross order value</Typography>
          </Card>
        </Grid>
      </Grid>

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
            <Tab label={`All Orders (${ordersList.length})`} value="all" />
            <Tab label={`Lab Queue (${inLabCount})`} value="lab" />
            <Tab label={`Ready for Pickup (${readyCount})`} value="ready" />
            <Tab label="Delivered Orders" value="delivered" />
          </Tabs>

          <Stack direction="row" spacing={1.5} flexWrap="wrap">
            <TextField
              size="small"
              placeholder="Search Order ID, Customer, Frame..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{
                startAdornment: <InputAdornment position="start"><SearchIcon color="action" fontSize="small" /></InputAdornment>,
                sx: { borderRadius: 2, width: 260 }
              }}
            />

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
          </Stack>
        </Box>
      </Card>

      {/* Main Orders Data Table / Empty State */}
      <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
        {filteredOrders.length === 0 ? (
          /* Empty Database State */
          <Box sx={{ p: 6, textAlign: 'center', bgcolor: 'action.hover', border: '2px dashed', borderColor: 'divider', borderRadius: 3 }}>
            <Avatar sx={{ mx: 'auto', bgcolor: 'primary.main', width: 56, height: 56, mb: 2 }}>
              <EmptyIcon sx={{ fontSize: 32 }} />
            </Avatar>
            <Typography variant="h6" fontWeight={800} gutterBottom>
              No Orders Found in Database
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480, mx: 'auto', mb: 3 }}>
              No spectacle orders match your search or exist in the database yet. Click below to create your first sale order.
            </Typography>
            <Button
              variant="contained"
              color="primary"
              startIcon={<AddIcon />}
              onClick={onNavigateToNewSale}
              sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700, px: 3 }}
            >
              + Create First Sale Order
            </Button>
          </Box>
        ) : (
          /* Orders Data Table */
          <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2.5 }}>
            <Table>
              <TableHead sx={{ bgcolor: 'action.hover' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 800 }}>Order ID</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Date</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Customer Name</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Prescribed Frame & Lens</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Total Payable</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Payment Status</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Lab Pipeline Status</TableCell>
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
                    <TableRow key={ord.id} hover>
                      <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>
                        {ord.id}
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
                          label={ord.payment || 'Paid'}
                          size="small"
                          color={isPaid ? 'success' : 'warning'}
                          variant={isPaid ? 'filled' : 'outlined'}
                          sx={{ fontWeight: 700, fontSize: '0.72rem' }}
                        />
                      </TableCell>
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
                      <TableCell align="right">
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Tooltip title="View Order Pipeline Details">
                            <IconButton 
                              size="small" 
                              color="primary" 
                              onClick={() => { setSelectedOrder(ord); setDetailModalOpen(true); }}
                            >
                              <ViewIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Print Lab Job Work Slip">
                            <IconButton size="small" color="inherit" onClick={() => {
                              if (onPrintInvoice) onPrintInvoice(ord);
                              printSalesInvoiceReceipt(ord);
                            }}>
                              <PrintIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Download PDF Invoice Receipt">
                            <IconButton size="small" color="error" onClick={() => downloadPdfInvoice(ord)}>
                              <PdfIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Send WhatsApp Invoice Receipt">
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
              <LabIcon color="primary" /> Optical Order Job Slip & Tracking — {selectedOrder.id}
            </Box>
            <Chip label={selectedOrder.status} color="primary" sx={{ fontWeight: 700 }} />
          </DialogTitle>

          <Divider />

          <DialogContent sx={{ py: 3 }}>
            {/* Lab Stepper Pipeline Progress */}
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

            {/* Customer & Prescription Details */}
            <Grid container spacing={2.5} sx={{ mb: 3 }}>
              <Grid item xs={12} sm={6}>
                <Card variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>CUSTOMER DETAILS</Typography>
                  <Typography variant="subtitle1" fontWeight={800}>{selectedOrder.customer}</Typography>
                  <Typography variant="body2" color="text.secondary">Phone: {selectedOrder.phone || '+91 98765-43210'}</Typography>
                  <Typography variant="body2" color="text.secondary">Order Date: {selectedOrder.date}</Typography>
                </Card>
              </Grid>

              <Grid item xs={12} sm={6}>
                <Card variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>PRESCRIBED SPECTACLE ITEMS</Typography>
                  <Typography variant="body2" fontWeight={800} color="primary.main">👓 {selectedOrder.frame || 'Prescribed Frame'}</Typography>
                  <Typography variant="body2" fontWeight={800} color="success.main">🔍 {selectedOrder.lens || 'Prescribed Lens'}</Typography>
                  <Typography variant="subtitle1" fontWeight={900} sx={{ mt: 0.5 }}>
                    Total: ₹{(parseFloat(selectedOrder.total) || 0).toLocaleString()} ({selectedOrder.payment})
                  </Typography>
                </Card>
              </Grid>
            </Grid>

            {/* Advance Status Control */}
            <Box sx={{ p: 2.5, bgcolor: '#f8fafc', borderRadius: 2.5, border: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                <Typography variant="subtitle2" fontWeight={800}>Optical Lab Status Control</Typography>
                <Typography variant="caption" color="text.secondary">Click to advance this order to the next stage in the laboratory queue.</Typography>
              </Box>
              <Button
                variant="contained"
                color="secondary"
                startIcon={<LabIcon />}
                onClick={() => handleAdvanceStatus(selectedOrder.id, selectedOrder.status)}
                sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
              >
                Advance Lab Stage
              </Button>
            </Box>
          </DialogContent>

          <DialogActions sx={{ p: 2.5 }}>
            <Button variant="outlined" onClick={() => printSalesInvoiceReceipt(selectedOrder)} startIcon={<PrintIcon />}>
              Print Job Slip
            </Button>
            <Button variant="contained" onClick={() => setDetailModalOpen(false)}>
              Close Job Slip
            </Button>
          </DialogActions>
        </Dialog>
      )}
    </Box>
  );
}
