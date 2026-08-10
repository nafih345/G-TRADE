import React, { useState } from 'react';
import { 
  Box, Grid, Card, CardContent, Typography, Button, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Chip, TextField, MenuItem, Stack, 
  InputAdornment, LinearProgress, Divider, Avatar, Tooltip,
  IconButton
} from '@mui/material';
import { 
  ShoppingCart as SalesIcon,
  TrendingUp as TrendingUpIcon,
  Receipt as InvoiceIcon,
  AccountBalanceWallet as WalletIcon,
  Search as SearchIcon,
  Add as AddIcon,
  PointOfSale as POSIcon,
  Print as PrintIcon,
  Visibility as ViewIcon,
  WhatsApp as WhatsAppIcon,
  LocalShipping as DeliveryIcon,
  CheckCircle as SuccessIcon,
  PendingActions as PendingIcon,
  FilterList as FilterIcon,
  Download as ExportIcon,
  Inbox as EmptyIcon,
  PictureAsPdf as PdfIcon
} from '@mui/icons-material';
import { printSalesInvoiceReceipt, downloadPdfInvoice } from '../../utils/printInvoice';
import { sendInvoiceWhatsApp } from '../../utils/whatsappInvoice';

export default function SalesDashboardView({
  orders = [],
  payments = [],
  customers = [],
  onNavigateToNewSale,
  onNavigateToPos,
  onOpenRecordPayment,
  onViewOrderDetails,
  onPrintInvoice
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');

  // Real Database calculations (strictly from passed orders array)
  const totalRevenue = orders.reduce((sum, o) => sum + (parseFloat(o.total) || parseFloat(o.amount) || 0), 0);
  const totalInvoices = orders.length;
  const avgOrderValue = totalInvoices > 0 ? Math.round(totalRevenue / totalInvoices) : 0;
  const pendingCollections = orders.filter(o => (o.payment && (o.payment.includes('Partial') || o.payment === 'Unpaid'))).length;

  // Filtered orders list from database
  const filteredOrders = orders.filter(o => {
    const custName = o.customer || o.customerName || 'Walk-in Customer';
    const matchesSearch = custName.toLowerCase().includes(searchQuery.toLowerCase()) ||
                          (o.id && o.id.toLowerCase().includes(searchQuery.toLowerCase())) ||
                          (o.frame && o.frame.toLowerCase().includes(searchQuery.toLowerCase())) ||
                          (o.lens && o.lens.toLowerCase().includes(searchQuery.toLowerCase()));
    
    const matchesStatus = statusFilter === 'All' || o.status === statusFilter || o.payment === statusFilter;
    return matchesSearch && matchesStatus;
  });

  return (
    <Box>
      {/* Sales Dashboard Title & Quick Action Bar */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3.5, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <SalesIcon sx={{ fontSize: 36 }} /> Optical Sales Dashboard
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Connected to Database • Real-time invoice records, sales analytics, and revenue monitoring.
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} flexWrap="wrap">
          <Button
            variant="outlined"
            color="primary"
            startIcon={<WalletIcon />}
            onClick={onOpenRecordPayment}
            sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 600 }}
          >
            Record Customer Due
          </Button>

          <Button
            variant="contained"
            color="secondary"
            startIcon={<POSIcon />}
            onClick={onNavigateToPos}
            sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700 }}
          >
            POS Express Billing
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

      {/* KPI Cards Row */}
      <Grid container spacing={2.5} sx={{ mb: 4 }}>
        {/* Total Revenue */}
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
              <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Total Revenue
              </Typography>
              <Avatar sx={{ bgcolor: 'rgba(37, 99, 235, 0.1)', color: 'primary.main', width: 38, height: 38 }}>
                <TrendingUpIcon fontSize="small" />
              </Avatar>
            </Box>
            <Typography variant="h4" fontWeight={900} sx={{ letterSpacing: '-0.02em' }}>
              ₹{totalRevenue.toLocaleString()}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
              <Chip 
                label={totalInvoices > 0 ? `${totalInvoices} Orders in DB` : 'Database Empty'} 
                size="small" 
                color={totalInvoices > 0 ? 'success' : 'default'} 
                sx={{ height: 20, fontSize: '0.65rem', fontWeight: 700 }} 
              />
              <Typography variant="caption" color="text.secondary">Gross Sales</Typography>
            </Box>
          </Card>
        </Grid>

        {/* Total Invoices */}
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
              <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Invoices / Orders
              </Typography>
              <Avatar sx={{ bgcolor: 'rgba(16, 185, 129, 0.1)', color: '#059669', width: 38, height: 38 }}>
                <InvoiceIcon fontSize="small" />
              </Avatar>
            </Box>
            <Typography variant="h4" fontWeight={900} sx={{ letterSpacing: '-0.02em' }}>
              {totalInvoices}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
              <Chip label={totalInvoices > 0 ? "Live Database" : "0 Records"} size="small" color="info" sx={{ height: 20, fontSize: '0.65rem', fontWeight: 700 }} />
              <Typography variant="caption" color="text.secondary">Sales Count</Typography>
            </Box>
          </Card>
        </Grid>

        {/* Average Order Value */}
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
              <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Avg Order Value (AOV)
              </Typography>
              <Avatar sx={{ bgcolor: 'rgba(168, 85, 247, 0.1)', color: 'secondary.main', width: 38, height: 38 }}>
                <POSIcon fontSize="small" />
              </Avatar>
            </Box>
            <Typography variant="h4" fontWeight={900} sx={{ letterSpacing: '-0.02em' }}>
              ₹{avgOrderValue.toLocaleString()}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
              <Typography variant="caption" color="text.secondary">Per Customer Invoice</Typography>
            </Box>
          </Card>
        </Grid>

        {/* Collections / Dues */}
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, bgcolor: 'background.paper' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
              <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
                Pending Collections
              </Typography>
              <Avatar sx={{ bgcolor: 'rgba(245, 158, 11, 0.1)', color: 'warning.main', width: 38, height: 38 }}>
                <PendingIcon fontSize="small" />
              </Avatar>
            </Box>
            <Typography variant="h4" fontWeight={900} sx={{ letterSpacing: '-0.02em', color: pendingCollections > 0 ? 'warning.main' : 'text.primary' }}>
              {pendingCollections} {pendingCollections === 1 ? 'Order' : 'Orders'}
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 1 }}>
              <Typography variant="caption" color="text.secondary">Unpaid / Partial due invoices</Typography>
            </Box>
          </Card>
        </Grid>
      </Grid>

      {/* Database Sales List Table / Empty State */}
      <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Typography variant="h6" fontWeight={800}>
              Sales Database Records ({filteredOrders.length})
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Review saved invoices, customer details, optical frame & lens specs, and payment status.
            </Typography>
          </Box>

          <Stack direction="row" spacing={1.5} flexWrap="wrap">
            <TextField
              size="small"
              placeholder="Search by Invoice, Customer, Frame..."
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
              <MenuItem value="All">All Statuses</MenuItem>
              <MenuItem value="Paid">Paid Only</MenuItem>
              <MenuItem value="Partial">Partial Payment</MenuItem>
              <MenuItem value="Unpaid">Unpaid</MenuItem>
            </TextField>
          </Stack>
        </Box>

        {filteredOrders.length === 0 ? (
          /* Empty Database State */
          <Box sx={{ p: 6, textAlign: 'center', bgcolor: 'action.hover', border: '2px dashed', borderColor: 'divider', borderRadius: 3 }}>
            <Avatar sx={{ mx: 'auto', bgcolor: 'primary.main', width: 56, height: 56, mb: 2 }}>
              <EmptyIcon sx={{ fontSize: 32 }} />
            </Avatar>
            <Typography variant="h6" fontWeight={800} gutterBottom>
              Sales Database is Currently Empty
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 480, mx: 'auto', mb: 3 }}>
              No sales invoices or optical orders have been entered in the database yet. Click below to enter values via <strong>POS Express Billing</strong> or <strong>+ Create New Order</strong>.
            </Typography>
            <Stack direction="row" spacing={2} justifyContent="center" flexWrap="wrap">
              <Button
                variant="contained"
                color="primary"
                startIcon={<AddIcon />}
                onClick={onNavigateToNewSale}
                sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700, px: 3 }}
              >
                + Create First Sale
              </Button>
              <Button
                variant="contained"
                color="secondary"
                startIcon={<POSIcon />}
                onClick={onNavigateToPos}
                sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700 }}
              >
                POS Express Billing
              </Button>
            </Stack>
          </Box>
        ) : (
          /* Real Database Orders Table */
          <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2.5 }}>
            <Table>
              <TableHead sx={{ bgcolor: 'action.hover' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 800 }}>Invoice #</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Date</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Customer Name</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Frame & Lens Details</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Total Amount</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Payment Status</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Order Status</TableCell>
                  <TableCell sx={{ fontWeight: 800, textAlign: 'right' }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredOrders.map((ord) => {
                  const custName = ord.customer || ord.customerName || 'Walk-in Customer';
                  const matchedCust = customers.find(c => (c.name && c.name.toLowerCase() === custName.toLowerCase()) || (c.id && c.id === ord.customerId));
                  const rawPhone = ord.phone || ord.customer_phone || matchedCust?.phone || '';
                  const displayPhone = (rawPhone && !rawPhone.includes('9847012345') && !rawPhone.includes('98470 12345')) ? rawPhone : '';
                  const isPaid = ord.payment === 'Paid';
                  const isDelivered = ord.status === 'Delivered';

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
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.3 }}>
                          {ord.paymentMethod || 'Cash'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Chip
                          label={ord.status || 'Completed'}
                          size="small"
                          color={isDelivered ? 'info' : 'primary'}
                          variant="outlined"
                          icon={isDelivered ? <SuccessIcon fontSize="small" /> : <DeliveryIcon fontSize="small" />}
                          sx={{ fontWeight: 700, fontSize: '0.72rem' }}
                        />
                      </TableCell>
                      <TableCell align="right">
                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Tooltip title="View Detailed Invoice">
                            <IconButton size="small" color="primary" onClick={() => onViewOrderDetails?.(ord)}>
                              <ViewIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                          <Tooltip title="Print Invoice Receipt">
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
    </Box>
  );
}
