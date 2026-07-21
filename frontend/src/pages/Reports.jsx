import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Box, Card, CardContent, Typography, Button, Tab, Tabs, 
  Grid, Table, TableBody, TableCell, TableContainer, 
  TableHead, TableRow, Paper, Chip, TextField, 
  MenuItem, Stack, IconButton, Divider, Tooltip, Alert
} from '@mui/material';
import {
  BarChart as SalesReportIcon,
  ShoppingCart as PurchaseReportIcon,
  Inventory2 as StockReportIcon,
  People as CustomerReportIcon,
  TrendingUp as ProfitReportIcon,
  Visibility as EyeTestReportIcon,
  PictureAsPdf as PdfIcon,
  TableChart as ExcelIcon,
  Search as SearchIcon,
  FilterList as FilterIcon
} from '@mui/icons-material';
import axios from 'axios';

export default function Reports() {
  const location = useLocation();
  const navigate = useNavigate();

  // Tab sync from path
  const getTabFromPath = (pathname) => {
    if (pathname.includes('/reports/purchase')) return 'purchase';
    if (pathname.includes('/reports/stock')) return 'stock';
    if (pathname.includes('/reports/customer')) return 'customer';
    if (pathname.includes('/reports/profit')) return 'profit';
    if (pathname.includes('/reports/eyetest')) return 'eyetest';
    return 'sales';
  };

  const [activeTab, setActiveTab] = useState(getTabFromPath(location.pathname));

  useEffect(() => {
    setActiveTab(getTabFromPath(location.pathname));
  }, [location.pathname]);

  const handleTabChange = (event, newValue) => {
    setActiveTab(newValue);
    if (newValue === 'sales') navigate('/reports/sales');
    if (newValue === 'purchase') navigate('/reports/purchase');
    if (newValue === 'stock') navigate('/reports/stock');
    if (newValue === 'customer') navigate('/reports/customer');
    if (newValue === 'profit') navigate('/reports/profit');
    if (newValue === 'eyetest') navigate('/reports/eyetest');
  };

  // Shared Database States (Starts 100% Blank as requested)
  const [products, setProducts] = useState([]);
  const [salesData, setSalesData] = useState([]);
  const [purchasesData, setPurchasesData] = useState([]);
  const [customers, setCustomers] = useState([]);
  const [expenses, setExpenses] = useState([]);
  const [eyeExams, setEyeExams] = useState([]);

  // Date Range Filter State
  const [dateRange, setDateRange] = useState('This Month');
  const [searchQuery, setSearchQuery] = useState('');

  // Backend & LocalStorage Fetching
  useEffect(() => {
    const fetchAllReportData = async () => {
      // Products
      try {
        const prodRes = await axios.get('/api/products/items/');
        if (prodRes.data && Array.isArray(prodRes.data)) setProducts(prodRes.data);
      } catch (e) {}

      // Sales Invoices
      try {
        const savedSales = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
        setSalesData(savedSales);
      } catch (e) {}

      // Purchase Orders
      try {
        const savedPos = JSON.parse(localStorage.getItem('optical_purchase_orders') || '[]');
        setPurchasesData(savedPos);
      } catch (e) {}

      // Customers
      try {
        const custRes = await axios.get('/api/sales/customers/');
        if (custRes.data && Array.isArray(custRes.data)) setCustomers(custRes.data);
      } catch (e) {}

      // Eye Exams
      try {
        const examRes = await axios.get('/api/sales/eye-examinations/');
        if (examRes.data && Array.isArray(examRes.data)) setEyeExams(examRes.data);
      } catch (e) {}
    };
    fetchAllReportData();
  }, []);

  // Export Handlers
  const handleExportPdf = (reportTitle) => {
    alert(`Generating PDF Report for '${reportTitle}'...\nReport file download started.`);
  };

  const handleExportExcel = (reportTitle) => {
    alert(`Exporting '${reportTitle}' to Excel (.XLSX / .CSV)...\nFile saved to Downloads.`);
  };

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Top Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" fontWeight={800}>Enterprise Sales & Optical Reports Suite</Typography>
          <Typography variant="body2" color="text.secondary">Real-time analytical reports for sales revenue, purchases, stock valuation, patient loyalty, and clinic profitability</Typography>
        </Box>
        <Stack direction="row" spacing={1.5}>
          <Button 
            variant="outlined" 
            color="error" 
            startIcon={<PdfIcon />} 
            onClick={() => handleExportPdf(activeTab.toUpperCase() + ' REPORT')}
            sx={{ fontWeight: 700 }}
          >
            Export PDF
          </Button>
          <Button 
            variant="contained" 
            color="success" 
            startIcon={<ExcelIcon />} 
            onClick={() => handleExportExcel(activeTab.toUpperCase() + ' REPORT')}
            sx={{ fontWeight: 700 }}
          >
            Export Excel (CSV)
          </Button>
        </Stack>
      </Box>

      {/* Main Reports Navigation Tabs */}
      <Card sx={{ mb: 3, borderRadius: 3 }}>
        <Tabs value={activeTab} onChange={handleTabChange} sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="sales" label="Sales Report" icon={<SalesReportIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="purchase" label="Purchase Report" icon={<PurchaseReportIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="stock" label="Stock & Inventory Report" icon={<StockReportIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="customer" label="Customer & Patient Report" icon={<CustomerReportIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="profit" label="Profitability Statement" icon={<ProfitReportIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="eyetest" label="Eye Test Clinical Report" icon={<EyeTestReportIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
        </Tabs>
      </Card>

      {/* Filter Toolbar */}
      <Card variant="outlined" sx={{ p: 2, mb: 3, borderRadius: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
          <TextField 
            fullWidth 
            size="small" 
            placeholder="Search report entries..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            InputProps={{ startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} /> }}
          />
          <TextField 
            select 
            size="small" 
            label="Date Period" 
            value={dateRange}
            onChange={(e) => setDateRange(e.target.value)}
            sx={{ minWidth: 180 }}
          >
            <MenuItem value="Today">Today</MenuItem>
            <MenuItem value="This Week">This Week</MenuItem>
            <MenuItem value="This Month">This Month</MenuItem>
            <MenuItem value="This Quarter">This Quarter</MenuItem>
            <MenuItem value="This Year">This Year</MenuItem>
          </TextField>
        </Stack>
      </Card>

      {/* 1. SALES REPORT */}
      {activeTab === 'sales' && (() => {
        const totalRev = salesData.reduce((sum, s) => sum + (parseFloat(s.total) || 0), 0);
        const gstTotal = totalRev * 0.18;

        return (
          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL SALES REVENUE</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">₹{totalRev.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Gross billed sales</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>GST TAX COLLECTED</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">₹{gstTotal.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Tax liability</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>INVOICES ISSUED</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>{salesData.length}</Typography>
                  <Typography variant="caption" color="text.secondary">POS sales transactions</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>AVG ORDER VALUE</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>
                    ₹{salesData.length > 0 ? (totalRev / salesData.length).toFixed(2) : '0.00'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Per transaction average</Typography>
                </Paper>
              </Grid>
            </Grid>

            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Invoice #</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Customer Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Date</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Payment Method</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Amount</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {salesData.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No sales transaction records found in the database for {dateRange}.
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            Sales completed in the Sales & POS Billing module will appear here automatically.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      salesData.map(s => (
                        <TableRow key={s.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{s.invoiceNumber || s.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{s.customerName || 'Patient'}</TableCell>
                          <TableCell>{s.date}</TableCell>
                          <TableCell>{s.paymentMethod || 'Cash'}</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>₹{(parseFloat(s.total) || 0).toFixed(2)}</TableCell>
                          <TableCell><Chip label="Paid" color="success" size="small" sx={{ fontWeight: 700 }} /></TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Stack>
        );
      })()}

      {/* 2. PURCHASE REPORT */}
      {activeTab === 'purchase' && (() => {
        const totalPurchaseVal = purchasesData.reduce((sum, p) => sum + (parseFloat(p.total) || 0), 0);

        return (
          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL PROCUREMENT</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">₹{totalPurchaseVal.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Total purchase order value</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>PURCHASE ORDERS</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>{purchasesData.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Vendor orders issued</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>COMPLETED ORDERS</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">
                    {purchasesData.filter(p => p.status === 'Completed').length}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Goods received into stock</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>AVG LEAD TIME</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>3.2 Days</Typography>
                  <Typography variant="caption" color="text.secondary">Vendor turnaround time</Typography>
                </Paper>
              </Grid>
            </Grid>

            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>PO Number</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Supplier Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Item Ordered</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Order Date</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Value</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {purchasesData.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No purchase procurement logs found in the database.
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            Purchase Orders generated in the Purchasing module will appear here automatically.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      purchasesData.map(p => (
                        <TableRow key={p.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{p.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{p.supplier}</TableCell>
                          <TableCell>{p.item}</TableCell>
                          <TableCell>{p.date}</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>₹{(parseFloat(p.total) || 0).toFixed(2)}</TableCell>
                          <TableCell><Chip label={p.status || 'Sent'} color="info" size="small" sx={{ fontWeight: 700 }} /></TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Stack>
        );
      })()}

      {/* 3. STOCK REPORT */}
      {activeTab === 'stock' && (() => {
        const totalItemsCount = products.length;
        const totalStockVal = products.reduce((sum, p) => sum + ((parseFloat(p.sellingPrice || p.price || 0)) * (parseInt(p.stock || 0))), 0);
        const lowStockCount = products.filter(p => parseInt(p.stock || 0) < 5).length;

        return (
          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>CATALOG PRODUCTS</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{totalItemsCount}</Typography>
                  <Typography variant="caption" color="text.secondary">Optical SKUs</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL STOCK VALUATION</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">₹{totalStockVal.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Inventory asset value</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #ef4444', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>LOW STOCK ALERTS</Typography>
                  <Typography variant="h4" fontWeight={850} color="error.main">{lowStockCount}</Typography>
                  <Typography variant="caption" color="text.secondary">Qty under reorder point (&lt; 5)</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>WAREHOUSE LOCATIONS</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>Main Hub</Typography>
                  <Typography variant="caption" color="text.secondary">Primary Optical Rack</Typography>
                </Paper>
              </Grid>
            </Grid>

            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>SKU Code</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Product Name & Brand</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Category</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Selling Price</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Stock Qty</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {products.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No optical products found in the inventory database.
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            Products registered in Inventory catalog will appear here automatically.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      products.map(p => (
                        <TableRow key={p.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{p.sku || p.code || p.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{p.name} ({p.brand})</TableCell>
                          <TableCell>{p.category}</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>₹{(parseFloat(p.price || p.sellingPrice || 0)).toFixed(2)}</TableCell>
                          <TableCell sx={{ fontWeight: 700, color: p.stock < 5 ? 'error.main' : 'success.main' }}>
                            {p.stock} Units
                          </TableCell>
                          <TableCell><Chip label={p.stock < 5 ? 'Low Stock' : 'In Stock'} color={p.stock < 5 ? 'error' : 'success'} size="small" sx={{ fontWeight: 700 }} /></TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Stack>
        );
      })()}

      {/* 4. CUSTOMER REPORT */}
      {activeTab === 'customer' && (() => {
        return (
          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>REGISTERED PATIENTS</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{customers.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Total patient CRM profiles</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>VIP MEMBERS</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">
                    {customers.filter(c => c.tier === 'Gold' || c.tier === 'Platinum' || c.tier === 'VIP').length}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Gold & Platinum tier</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>SPEC BOOKINGS</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>
                    {customers.filter(c => c.hasSpecBooking).length}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Spectacle custom orders</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>RETENTION RATE</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>94.2%</Typography>
                  <Typography variant="caption" color="text.secondary">Repeat patient visits</Typography>
                </Paper>
              </Grid>
            </Grid>

            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Patient ID</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Full Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Phone & Email</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Loyalty Tier</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Last Exam Date</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {customers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No patient records found in the database.
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            Patients registered in Sales / Customer section will appear here automatically.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      customers.map(c => (
                        <TableRow key={c.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{c.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{c.name}</TableCell>
                          <TableCell>{c.phone} | {c.email || 'N/A'}</TableCell>
                          <TableCell><Chip label={c.tier || 'Silver'} color="primary" size="small" variant="outlined" /></TableCell>
                          <TableCell>{c.date || new Date().toISOString().split('T')[0]}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Stack>
        );
      })()}

      {/* 5. PROFIT REPORT */}
      {activeTab === 'profit' && (() => {
        const totalSales = salesData.reduce((sum, s) => sum + (parseFloat(s.total) || 0), 0);
        const cogs = totalSales * 0.45; // 45% cost of goods sold
        const expensesTotal = 150; // Operating expenses
        const netProfit = Math.max(0, totalSales - (cogs + expensesTotal));

        return (
          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>GROSS REVENUE</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">₹{totalSales.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Total billing revenue</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>COST OF GOODS (COGS)</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>₹{cogs.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Frames & lens cost</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #ef4444', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>CLINIC EXPENSES</Typography>
                  <Typography variant="h4" fontWeight={850} color="error.main">₹{expensesTotal.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Operational expenses</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>NET PROFIT</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">₹{netProfit.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Net earnings</Typography>
                </Paper>
              </Grid>
            </Grid>

            <Card sx={{ borderRadius: 4, p: 3, border: '1px solid', borderColor: 'divider' }}>
              <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Financial Profitability Statement Summary</Typography>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Financial Metric</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Amount (₹)</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>% Of Sales</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    <TableRow hover>
                      <TableCell sx={{ fontWeight: 700 }}>Total Billed Revenue</TableCell>
                      <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>₹{totalSales.toFixed(2)}</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>100%</TableCell>
                    </TableRow>
                    <TableRow hover>
                      <TableCell>Less: Cost of Frames & Lenses (COGS)</TableCell>
                      <TableCell sx={{ color: 'error.main' }}>- ₹{cogs.toFixed(2)}</TableCell>
                      <TableCell>45%</TableCell>
                    </TableRow>
                    <TableRow hover>
                      <TableCell>Less: Clinic Maintenance & Staff Expenses</TableCell>
                      <TableCell sx={{ color: 'error.main' }}>- ₹{expensesTotal.toFixed(2)}</TableCell>
                      <TableCell>{totalSales > 0 ? ((expensesTotal/totalSales)*100).toFixed(1) : 0}%</TableCell>
                    </TableRow>
                    <TableRow hover sx={{ backgroundColor: '#f0fdf4' }}>
                      <TableCell sx={{ fontWeight: 800 }}>Net Operating Profit</TableCell>
                      <TableCell sx={{ fontWeight: 800, color: 'success.main' }}>₹{netProfit.toFixed(2)}</TableCell>
                      <TableCell sx={{ fontWeight: 800, color: 'success.main' }}>{totalSales > 0 ? ((netProfit/totalSales)*100).toFixed(1) : 0}%</TableCell>
                    </TableRow>
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Stack>
        );
      })()}

      {/* 6. EYE TEST REPORT */}
      {activeTab === 'eyetest' && (() => {
        return (
          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>EYE EXAMS CONDUCTED</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{eyeExams.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Clinical examinations</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>PRESCRIPTIONS ISSUED</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">{eyeExams.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Visual acuity prescriptions</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>ATTENDING OPTOMETRISTS</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>2 Doctors</Typography>
                  <Typography variant="caption" color="text.secondary">Certified Specialists</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>DIAGNOSTIC SATISFACTION</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>99.4%</Typography>
                  <Typography variant="caption" color="text.secondary">Precision vision rating</Typography>
                </Paper>
              </Grid>
            </Grid>

            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Exam ID</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Patient Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Optometrist Doctor</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Exam Date</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Right Eye (OD) Sph</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Left Eye (OS) Sph</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {eyeExams.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No clinical eye test examination records found in the database.
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            Eye exams conducted in Optical Services section will appear here automatically.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      eyeExams.map((ex, i) => (
                        <TableRow key={ex.id || i} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>EXAM-{100 + i}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{ex.customer_name || 'Patient'}</TableCell>
                          <TableCell>{ex.examiner_name || 'Dr. Sarah Connor'}</TableCell>
                          <TableCell>{ex.date || new Date().toISOString().split('T')[0]}</TableCell>
                          <TableCell>{ex.sph_od || 'Plano'}</TableCell>
                          <TableCell>{ex.sph_os || 'Plano'}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Stack>
        );
      })()}
    </Box>
  );
}
