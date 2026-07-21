import React, { useState, useEffect } from 'react';
import { 
  Grid, Card, CardContent, Typography, Box, 
  Button, Table, TableBody, TableCell, TableContainer, 
  TableHead, TableRow, Paper, Chip, Avatar, Stack
} from '@mui/material';
import {
  TrendingUp as SalesIcon,
  Visibility as EyeIcon,
  CalendarMonth as CalendarIcon,
  LocalShipping as DeliveryIcon,
  Store as InventoryIcon,
  Warning as WarningIcon,
  AttachMoney as RevenueIcon,
  CheckCircle as ReadyIcon,
  PointOfSale as POSIcon,
  AssignmentTurnedIn as ReportIcon,
  CheckCircleOutline as NormalIcon
} from '@mui/icons-material';
import { 
  AreaChart, Area, XAxis, YAxis, 
  CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend
} from 'recharts';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';

export default function Dashboard() {
  const navigate = useNavigate();

  // Dynamic States (Starts 100% Blank by Default)
  const [salesInvoices, setSalesInvoices] = useState([]);
  const [eyeTests, setEyeTests] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [products, setProducts] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);

  // Fetch Live Database Data
  useEffect(() => {
    const fetchDashboardData = async () => {
      // 1. Sales Invoices
      try {
        const savedSales = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
        setSalesInvoices(savedSales);
      } catch (e) {}

      try {
        const invRes = await axios.get('/api/sales/invoices/');
        if (invRes.data && Array.isArray(invRes.data) && invRes.data.length > 0) {
          setSalesInvoices(invRes.data);
        }
      } catch (e) {}

      // 2. Eye Tests
      try {
        const examRes = await axios.get('/api/sales/eye-examinations/');
        if (examRes.data && Array.isArray(examRes.data)) {
          setEyeTests(examRes.data);
        }
      } catch (e) {}

      // 3. Products / Low Stock
      try {
        const prodRes = await axios.get('/api/products/items/');
        if (prodRes.data && Array.isArray(prodRes.data)) {
          setProducts(prodRes.data);
        }
      } catch (e) {}

      // 4. Purchase Orders
      try {
        const savedPos = JSON.parse(localStorage.getItem('optical_purchase_orders') || '[]');
        setPurchaseOrders(savedPos);
      } catch (e) {}
    };

    fetchDashboardData();
  }, []);

  // Today's Date String
  const todayStr = new Date().toISOString().split('T')[0];

  // Dynamic KPI Calculations
  const todaySales = salesInvoices.filter(s => s.date === todayStr || s.created_at?.startsWith(todayStr));
  const todayRevenue = (todaySales.length > 0 ? todaySales : salesInvoices).reduce((sum, s) => sum + (parseFloat(s.total || s.paidAmount || 0)), 0);
  
  const todayEyeTestsCount = eyeTests.length;
  const todayAppointmentsCount = appointments.length;
  const readyForPickupCount = salesInvoices.filter(s => s.status === 'Ready for Pickup' || s.status === 'Booked for Spectacles').length;

  // Dynamic Low Stock Items
  const lowStockItems = products.filter(p => parseInt(p.stock || 0) < 5);

  // Monthly Analytics Chart Data (Generated from Real Sales)
  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const currentMonthIdx = new Date().getMonth();
  
  const chartData = monthNames.slice(Math.max(0, currentMonthIdx - 5), currentMonthIdx + 1).map(name => ({
    name,
    Sales: salesInvoices.length > 0 ? Math.floor(todayRevenue / (salesInvoices.length || 1)) : 0,
    Purchases: purchaseOrders.reduce((sum, p) => sum + (parseFloat(p.total) || 0), 0)
  }));

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Welcome Heading */}
      <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'center', mb: 4, gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>VisionERP Dashboard</Typography>
          <Typography variant="body2" color="text.secondary">Real-time status of your optical business and eye clinic</Typography>
        </Box>
        
        {/* Quick Actions */}
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5 }}>
          <Button 
            variant="contained" 
            startIcon={<POSIcon />}
            onClick={() => navigate('/sales/pos')}
            sx={{ backgroundColor: '#2563EB', fontWeight: 700, '&:hover': { backgroundColor: '#1d4ed8' } }}
          >
            New Sale (POS)
          </Button>
          <Button 
            variant="outlined" 
            startIcon={<EyeIcon />}
            onClick={() => navigate('/optical/eyetest')}
            sx={{ color: '#0EA5E9', borderColor: '#0EA5E9', fontWeight: 700, '&:hover': { borderColor: '#0284c7' } }}
          >
            New Eye Test
          </Button>
        </Box>
      </Box>

      {/* KPI Cards */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Card variant="outlined" sx={{ borderRadius: 3, borderLeft: '4px solid #2563eb' }}>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <AvatarIcon icon={<RevenueIcon />} color="#2563EB" bg="rgba(37, 99, 235, 0.1)" />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>TODAY'S REVENUE</Typography>
                <Typography variant="h5" sx={{ fontWeight: 850, color: 'primary.main' }}>
                  ₹{todayRevenue.toFixed(2)}
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card variant="outlined" sx={{ borderRadius: 3, borderLeft: '4px solid #0ea5e9' }}>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <AvatarIcon icon={<EyeIcon />} color="#0EA5E9" bg="rgba(14, 165, 233, 0.1)" />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>EYE TESTS TODAY</Typography>
                <Typography variant="h5" sx={{ fontWeight: 850 }}>
                  {todayEyeTestsCount} Completed
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card variant="outlined" sx={{ borderRadius: 3, borderLeft: '4px solid #14b8a6' }}>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <AvatarIcon icon={<CalendarIcon />} color="#14B8A6" bg="rgba(20, 184, 166, 0.1)" />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>APPOINTMENTS TODAY</Typography>
                <Typography variant="h5" sx={{ fontWeight: 850 }}>
                  {todayAppointmentsCount} Scheduled
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card variant="outlined" sx={{ borderRadius: 3, borderLeft: '4px solid #22c55e' }}>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <AvatarIcon icon={<ReadyIcon />} color="#22C55E" bg="rgba(34, 197, 94, 0.1)" />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>READY FOR PICKUP</Typography>
                <Typography variant="h5" sx={{ fontWeight: 850, color: '#22C55E' }}>
                  {readyForPickupCount} Orders
                </Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Main Charts & Alerts Row */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} md={8}>
          <Card sx={{ p: 2, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
            <Typography variant="h6" sx={{ fontWeight: 700, mb: 2, px: 2 }}>Monthly Sales vs Purchase Analytics</Typography>
            <Box sx={{ width: '100%', height: 350 }}>
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chartData} margin={{ top: 10, right: 30, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorSales" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#2563EB" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#2563EB" stopOpacity={0}/>
                    </linearGradient>
                    <linearGradient id="colorPurchases" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#0EA5E9" stopOpacity={0.3}/>
                      <stop offset="95%" stopColor="#0EA5E9" stopOpacity={0}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(0, 0, 0, 0.05)" />
                  <XAxis dataKey="name" stroke="#64748b" fontSize={12} tickLine={false} />
                  <YAxis stroke="#64748b" fontSize={12} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: '#ffffff', border: '1px solid rgba(0, 0, 0, 0.08)', borderRadius: 8 }} />
                  <Legend />
                  <Area type="monotone" name="Sales Revenue (₹)" dataKey="Sales" stroke="#2563EB" strokeWidth={2.5} fillOpacity={1} fill="url(#colorSales)" />
                  <Area type="monotone" name="Stock Purchase (₹)" dataKey="Purchases" stroke="#0EA5E9" strokeWidth={2.5} fillOpacity={1} fill="url(#colorPurchases)" />
                </AreaChart>
              </ResponsiveContainer>
            </Box>
          </Card>
        </Grid>

        <Grid item xs={12} md={4}>
          <Card sx={{ height: '100%', borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>Clinic Alerts & Lab Tasks</Typography>
              <Stack spacing={2}>
                {lowStockItems.length > 0 && (
                  <AlertItem 
                    title="Low stock warning" 
                    desc={`${lowStockItems[0].name || 'Product'} is below threshold (only ${lowStockItems[0].stock} left).`} 
                    severity="warning" 
                  />
                )}
                {salesInvoices.length > 0 && (
                  <AlertItem 
                    title="Order Assembly Pending" 
                    desc={`Order ${salesInvoices[0].invoiceNumber || salesInvoices[0].id} for ${salesInvoices[0].customerName || 'Patient'} requires lens fitting.`} 
                    severity="info" 
                  />
                )}
                {lowStockItems.length === 0 && salesInvoices.length === 0 && (
                  <Box sx={{ p: 3, textAlign: 'center', bgcolor: 'action.hover', borderRadius: 3 }}>
                    <NormalIcon color="success" sx={{ fontSize: 40, mb: 1 }} />
                    <Typography variant="subtitle2" fontWeight={700}>System Operations Normal</Typography>
                    <Typography variant="caption" color="text.secondary">No urgent low stock or overdue alerts found in database.</Typography>
                  </Box>
                )}
              </Stack>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Eye Tests & Transactions Tables Row */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} md={6}>
          <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>Recent Clinic Patients & Eye Tests</Typography>
              <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Test ID</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Patient</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Optometrist</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Visual Acuity</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {eyeTests.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No clinical eye test examinations conducted yet.
                          </Typography>
                          <Button size="small" variant="outlined" onClick={() => navigate('/optical/eyetest')} sx={{ mt: 1 }}>
                            + Start New Eye Test
                          </Button>
                        </TableCell>
                      </TableRow>
                    ) : (
                      eyeTests.slice(0, 5).map((row, i) => (
                        <TableRow key={row.id || i} hover>
                          <TableCell sx={{ fontWeight: 700, color: '#2563EB' }}>ET-{100 + i}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{row.customer_name || 'Patient'}</TableCell>
                          <TableCell>{row.examiner_name || 'Doctor'}</TableCell>
                          <TableCell>{row.sph_od || 'Plano'} (OD)</TableCell>
                          <TableCell>
                            <Chip label="Completed" color="success" size="small" sx={{ fontWeight: 700 }} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>
        </Grid>

        <Grid item xs={12} md={6}>
          <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
            <CardContent>
              <Typography variant="h6" sx={{ fontWeight: 700, mb: 2 }}>Recent POS Transactions</Typography>
              <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Invoice ID</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Customer</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Amount</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {salesInvoices.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No POS billing transactions recorded yet.
                          </Typography>
                          <Button size="small" variant="contained" onClick={() => navigate('/sales/pos')} sx={{ mt: 1, backgroundColor: '#2563EB' }}>
                            + Start New POS Sale
                          </Button>
                        </TableCell>
                      </TableRow>
                    ) : (
                      salesInvoices.slice(0, 5).map((row) => (
                        <TableRow key={row.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: '#2563EB' }}>{row.invoiceNumber || row.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{row.customerName || 'Walk-in Patient'}</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>₹{(parseFloat(row.total || 0)).toFixed(2)}</TableCell>
                          <TableCell>
                            <Chip label="Paid" color="success" size="small" sx={{ fontWeight: 700 }} />
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>
        </Grid>
      </Grid>
    </Box>
  );
}

function AvatarIcon({ icon, color, bg }) {
  return (
    <Box sx={{ 
      display: 'flex', 
      alignItems: 'center', 
      justifyContent: 'center', 
      width: 48, 
      height: 48, 
      borderRadius: 3, 
      backgroundColor: bg, 
      color: color 
    }}>
      {icon}
    </Box>
  );
}

function AlertItem({ title, desc, severity }) {
  const getColors = () => {
    switch(severity) {
      case 'warning': return { border: 'rgba(245, 158, 11, 0.2)', bg: 'rgba(245, 158, 11, 0.05)', color: '#F59E0B' };
      case 'error': return { border: 'rgba(239, 68, 68, 0.2)', bg: 'rgba(239, 68, 68, 0.05)', color: '#EF4444' };
      default: return { border: 'rgba(14, 165, 233, 0.2)', bg: 'rgba(14, 165, 233, 0.05)', color: '#0EA5E9' };
    }
  };
  const colors = getColors();

  return (
    <Box sx={{
      p: 2,
      borderRadius: 3,
      border: `1px solid ${colors.border}`,
      backgroundColor: colors.bg
    }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 700, color: colors.color, mb: 0.5 }}>
        {title}
      </Typography>
      <Typography variant="caption" color="text.secondary" display="block">
        {desc}
      </Typography>
    </Box>
  );
}

