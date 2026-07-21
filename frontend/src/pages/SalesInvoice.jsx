import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Box, Grid, Card, CardContent, Typography, TextField, 
  Button, MenuItem, Table, TableBody, TableCell, 
  TableContainer, TableHead, TableRow, Paper, IconButton, 
  Stack, Divider, Dialog, DialogTitle, DialogContent, DialogActions,
  Chip, Step, Stepper, StepLabel, Checkbox, FormControlLabel,
  FormGroup, InputAdornment, LinearProgress, Badge, Tabs, Tab
} from '@mui/material';
import {
  Delete as DeleteIcon,
  Add as AddIcon,
  Remove as RemoveIcon,
  Receipt as ReceiptIcon,
  Print as PrintIcon,
  QrCodeScanner as ScannerIcon,
  Search as SearchIcon,
  ShoppingCart as ShoppingCartIcon,
  LocalShipping as DeliveryIcon,
  People as CustomersIcon,
  Settings as SettingsIcon,
  ArrowForward as ArrowForwardIcon,
  CheckCircle as CheckedIcon,
  Warning as WarningIcon,
  BarChart as AnalyticsIcon,
  CardGiftcard as GiftCardIcon,
  Loyalty as LoyaltyIcon,
  Payment as PaymentIcon,
  Undo as ReturnIcon,
  Security as WarrantyIcon,
  Autorenew as ExchangeIcon,
  Assessment as ReportsIcon,
  Visibility as ViewIcon,
  WhatsApp as WhatsAppIcon,
  Email as EmailIcon,
  BookOnline as AppointmentIcon
} from '@mui/icons-material';

// --- MASTER DATABASE ARRAYS (Starts blank until entered/fetched from DB) ---
const initialProducts = [];
const initialCustomers = [];
const initialOrders = [];
const initialPayments = [];

export default function SalesInvoice() {
  const location = useLocation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // Tab-state routing logic
  useEffect(() => {
    const path = location.pathname;
    if (path.includes('dashboard')) setActiveTab('dashboard');
    else if (path.includes('new')) setActiveTab('new-sale');
    else if (path.includes('pos')) setActiveTab('pos-billing');
    else if (path.includes('orders')) setActiveTab('orders');
    else if (path.includes('customers')) setActiveTab('customers');
    else if (path.includes('payments')) setActiveTab('payments');
    else if (path.includes('reports')) setActiveTab('reports');
    else setActiveTab('dashboard');
  }, [location.pathname]);

  // Master states
  const [products, setProducts] = useState(initialProducts);
  const [customers, setCustomers] = useState(initialCustomers);
  const [orders, setOrders] = useState(initialOrders);
  const [payments, setPayments] = useState(initialPayments);

  // Fetch optical services, inventory products & sales database from API
  useEffect(() => {
    const fetchOpticalDbData = async () => {
      try {
        const [custRes, eyeExamRes, prodRes, invRes] = await Promise.all([
          axios.get('/api/sales/customers/').catch(() => null),
          axios.get('/api/sales/eye-examinations/').catch(() => null),
          axios.get('/api/products/products/').catch(() => null),
          axios.get('/api/sales/invoices/').catch(() => null)
        ]);

        // Products DB integration
        if (prodRes && prodRes.data && prodRes.data.length > 0) {
          setProducts(prodRes.data.map(p => ({
            id: String(p.id || p.product_id),
            name: p.name || p.product_name,
            brand: p.brand || 'Generic',
            type: p.category_name || (p.type || 'Frame'),
            price: parseFloat(p.unit_price || p.price || 0),
            taxRate: parseFloat(p.tax_rate || 18),
            image: (p.category_name || p.type || '').toLowerCase().includes('lens') ? '🔍' : '👓'
          })));
        } else {
          setProducts([]);
        }

        // Invoices / Orders DB integration
        if (invRes && invRes.data && invRes.data.length > 0) {
          setOrders(invRes.data.map(inv => ({
            id: inv.invoice_number || `INV-${inv.id}`,
            date: inv.created_at ? inv.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
            customer: inv.customer_name || 'Walk-in Customer',
            amount: parseFloat(inv.total_amount || 0),
            status: inv.status || 'Completed',
            paymentMethod: inv.payment_method || 'Cash'
          })));
        }

        // Customers & Eye Exams DB integration
        if (custRes && custRes.data && custRes.data.length > 0) {
          const eyeExams = (eyeExamRes && eyeExamRes.data) || [];
          const mergedCusts = custRes.data.map(c => {
            const matchedExam = eyeExams.find(e => e.phone === c.phone || e.patient_name === c.name || e.patient_id === c.id);
            return {
              id: c.id,
              name: c.name,
              phone: c.phone || 'N/A',
              email: c.email || '',
              address: c.address || '',
              points: c.points || 120,
              tier: c.tier || 'Silver',
              sphRight: matchedExam?.sub_sph_od || c.sphRight || 'Plano',
              cylRight: matchedExam?.sub_cyl_od || c.cylRight || 'Plano',
              axisRight: matchedExam?.sub_axis_od || c.axisRight || '0',
              sphLeft: matchedExam?.sub_sph_os || c.sphLeft || 'Plano',
              cylLeft: matchedExam?.sub_cyl_os || c.cylLeft || 'Plano',
              axisLeft: matchedExam?.sub_axis_os || c.axisLeft || '0',
              doctor: matchedExam?.optometrist || c.doctor || 'Attending Optometrist',
              date: matchedExam?.examination_date ? matchedExam.examination_date.split('T')[0] : c.date || '',
              balance: c.outstanding_balance || c.balance || 0,
              hasSpecBooking: true,
              specDetails: matchedExam ? {
                bookingId: matchedExam.visit_number || `SPEC-${matchedExam.id}`,
                date: matchedExam.examination_date ? matchedExam.examination_date.split('T')[0] : '',
                frameRec: `${matchedExam.rec_frame_brand || ''} ${matchedExam.rec_frame_shape || ''}`.trim() || 'Frame Prescribed from Exam',
                lensRec: `${matchedExam.rec_lens_brand || ''} ${matchedExam.rec_lens_type || ''} (${matchedExam.rec_lens_coating || ''})`.trim() || 'Lens Prescribed from Exam',
                status: 'Booked for Spectacles (Optical Services Connected)'
              } : null
            };
          });
          setCustomers(mergedCusts);
        } else {
          setCustomers([]);
        }
      } catch (err) {
        console.warn('Sales & Optical Services DB fetch error:', err);
      }
    };
    fetchOpticalDbData();
  }, []);

  // Handle auto-population when returning from Eye Test section
  useEffect(() => {
    if (location.state && location.state.newPatient) {
      const newP = location.state.newPatient;
      setCustomers(prev => {
        const exists = prev.some(c => c.id === newP.id);
        if (exists) return prev;
        return [newP, ...prev];
      });
      handleCustomerSelect(newP.id);
    }
  }, [location.state]);

  // New Sale Wizard States
  const [activeStep, setActiveStep] = useState(0);
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [cart, setCart] = useState([]);
  const [discount, setDiscount] = useState(0);
  const [paymentMethod, setPaymentMethod] = useState('Cash');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [printOpen, setPrintOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);

  // Add / Enter Patient details modal state
  const [addPatientDialogOpen, setAddPatientDialogOpen] = useState(false);
  const [patientInput, setPatientInput] = useState({
    name: '',
    phone: '',
    email: '',
    age: '',
    gender: 'Male',
    tier: 'Silver',
    doctor: '',
    frameRec: '',
    frameType: 'Full-Rim Acetate',
    lensRec: '',
    lensCoating: 'Anti-Glare Blue-Cut Protection',
    status: '',
    sphRight: '',
    cylRight: '',
    axisRight: '',
    sphLeft: '',
    cylLeft: '',
    axisLeft: '',
    distancePD: '',
    notes: ''
  });

  // Prescription loading states
  const [rxSphOD, setRxSphOD] = useState('');
  const [rxCylOD, setRxCylOD] = useState('');
  const [rxAxisOD, setRxAxisOD] = useState('');
  const [rxSphOS, setRxSphOS] = useState('');
  const [rxCylOS, setRxCylOS] = useState('');
  const [rxAxisOS, setRxAxisOS] = useState('');
  const [presDoctor, setPresDoctor] = useState('Dr. Sarah Connor');

  // Filter States
  const [frameFilter, setFrameFilter] = useState('All');
  const [orderSearchQuery, setOrderSearchQuery] = useState('');
  const [orderStatusFilter, setOrderStatusFilter] = useState('All');
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [customerTierFilter, setCustomerTierFilter] = useState('All');
  const [reportCategory, setReportCategory] = useState('daily');

  // Checklist Add-ons
  const [accessories, setAccessories] = useState({
    cloth: false,
    spray: false,
    hardCase: false,
    solution: false
  });

  // Modal Detail States
  const [selectedOrder, setSelectedOrder] = useState(null);
  const [orderDetailTab, setOrderDetailTab] = useState(0);
  const [selectedCustomer, setSelectedCustomer] = useState(null);
  const [customerDetailTab, setCustomerDetailTab] = useState(0);
  const [recordPaymentDialogOpen, setRecordPaymentDialogOpen] = useState(false);
  const [payRecordInput, setPayRecordInput] = useState({ customerId: '', amount: '', method: 'Cash' });

  // Calculation helpers
  const subtotal = cart.reduce((sum, item) => sum + (item.product.price * item.qty), 0);
  const tax = cart.reduce((sum, item) => sum + (item.product.price * item.qty * (item.product.taxRate / 100)), 0);
  const total = subtotal + tax - parseFloat(discount || 0);

  const handleAccessoryChange = (name, price) => {
    setAccessories(prev => ({ ...prev, [name]: !prev[name] }));
    if (!accessories[name]) {
      addToCart({ id: `acc-${name}`, name: `Accessory: ${name.charAt(0).toUpperCase() + name.slice(1)}`, brand: 'Generic', type: 'Accessory', price: price, taxRate: 18 });
    } else {
      removeFromCart(`acc-${name}`);
    }
  };

  const addToCart = (product) => {
    const existing = cart.find(item => item.product.id === product.id);
    if (existing) {
      updateQty(product.id, existing.qty + 1);
    } else {
      setCart([...cart, { product, qty: 1 }]);
    }
  };

  const updateQty = (productId, newQty) => {
    if (newQty <= 0) {
      removeFromCart(productId);
      return;
    }
    setCart(cart.map(item => 
      item.product.id === productId ? { ...item, qty: newQty } : item
    ));
  };

  const removeFromCart = (productId) => {
    setCart(cart.filter(item => item.product.id !== productId));
  };

  const handleCustomerSelect = (customerId) => {
    setSelectedCustomerId(customerId);
    const selected = customers.find(c => c.id === customerId);
    if (selected) {
      setRxSphOD(selected.sphRight || '');
      setRxCylOD(selected.cylRight || '');
      setRxAxisOD(selected.axisRight || '');
      setRxSphOS(selected.sphLeft || '');
      setRxCylOS(selected.cylLeft || '');
      setRxAxisOS(selected.axisLeft || '');
      setPresDoctor(selected.doctor || 'Dr. Sarah Connor');
    }
  };

  const handleAddPatientSubmit = () => {
    if (!patientInput.name || !patientInput.phone) {
      alert("Please enter at least Patient Name and Phone Number.");
      return;
    }
    const newId = `c-${Date.now()}`;
    const newCustObj = {
      id: newId,
      name: patientInput.name,
      phone: patientInput.phone,
      email: patientInput.email || '',
      age: patientInput.age || '',
      gender: patientInput.gender || 'Male',
      points: 100,
      tier: patientInput.tier || 'Silver',
      sphRight: patientInput.sphRight || 'Plano',
      cylRight: patientInput.cylRight || 'Plano',
      axisRight: patientInput.axisRight || '0',
      sphLeft: patientInput.sphLeft || 'Plano',
      cylLeft: patientInput.cylLeft || 'Plano',
      axisLeft: patientInput.axisLeft || '0',
      distancePD: patientInput.distancePD || '',
      doctor: patientInput.doctor || 'Attending Doctor',
      date: new Date().toISOString().split('T')[0],
      balance: 0,
      hasSpecBooking: true,
      specDetails: {
        bookingId: `SPEC-${Math.floor(1000 + Math.random() * 9000)}`,
        date: new Date().toISOString().split('T')[0],
        frameRec: patientInput.frameRec ? `${patientInput.frameRec} (${patientInput.frameType || 'Full-Rim'})` : 'Prescribed Optical Frame',
        lensRec: patientInput.lensRec ? `${patientInput.lensRec} - ${patientInput.lensCoating || 'Anti-Glare'}` : 'Prescribed Optical Lens',
        status: patientInput.status || 'Booked for Spectacles',
        notes: patientInput.notes || ''
      }
    };
    setCustomers([newCustObj, ...customers]);
    handleCustomerSelect(newId);
    setAddPatientDialogOpen(false);
    setPatientInput({
      name: '', phone: '', email: '', age: '', gender: 'Male', tier: 'Silver', doctor: '',
      frameRec: '', frameType: 'Full-Rim Acetate', lensRec: '', lensCoating: 'Anti-Glare Blue-Cut Protection',
      status: '', sphRight: '', cylRight: '', axisRight: '', sphLeft: '', cylLeft: '', axisLeft: '', distancePD: '', notes: ''
    });
  };

  const getCustomerName = () => {
    return customers.find(c => c.id === selectedCustomerId)?.name || 'Walk-in Patient';
  };

  const handleCheckoutSubmit = () => {
    setPrintOpen(false);
    // Create new order record
    const orderId = `ORD-${Math.floor(1000 + Math.random() * 9000)}`;
    const newOrder = {
      id: orderId,
      customer: getCustomerName(),
      date: new Date().toISOString().split('T')[0],
      total: total,
      payment: total > 0 ? 'Paid' : 'Unpaid',
      status: 'Pending',
      progress: 20,
      frame: cart.find(item => item.product.type === 'Frame')?.product.name || 'Generic Frame',
      lens: cart.find(item => item.product.type === 'Lens')?.product.name || 'Generic Lens',
      deliveryDate: new Date(Date.now() + 4 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]
    };
    setOrders([newOrder, ...orders]);

    // Create payment entry
    const newPayment = {
      id: `PAY-${Math.floor(100 + Math.random() * 900)}`,
      customer: getCustomerName(),
      date: new Date().toISOString().split('T')[0],
      amount: total,
      method: paymentMethod,
      status: 'Success'
    };
    const updatedPayments = [newPayment, ...payments];
    setPayments(updatedPayments);

    // Save to localStorage for Accounts Module auto-recording
    try {
      const existingInvoices = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
      localStorage.setItem('optical_sales_invoices', JSON.stringify([{
        id: orderId,
        invoiceNumber: orderId,
        customerName: getCustomerName(),
        date: new Date().toISOString().split('T')[0],
        total: total,
        paidAmount: total,
        paymentMethod: paymentMethod
      }, ...existingInvoices]));

      const existingPay = JSON.parse(localStorage.getItem('optical_payments') || '[]');
      localStorage.setItem('optical_payments', JSON.stringify([{
        id: newPayment.id,
        customerName: newPayment.customer,
        date: newPayment.date,
        amount: total,
        method: paymentMethod
      }, ...existingPay]));
    } catch (e) {}

    setCart([]);
    setDiscount(0);
    setAccessories({ cloth: false, spray: false, hardCase: false, solution: false });
    setActiveStep(0);
    alert('Invoice Receipt printed & Order registered successfully!');
  };

  const handleRecordPaymentSubmit = () => {
    if (!payRecordInput.amount || parseFloat(payRecordInput.amount) <= 0) {
      alert("Please enter a valid payment amount.");
      return;
    }
    const cust = customers.find(c => c.id === payRecordInput.customerId);
    const custName = cust ? cust.name : 'Walk-in Patient';
    const payAmt = parseFloat(payRecordInput.amount);

    const newPay = {
      id: `PAY-${Math.floor(1000 + Math.random() * 9000)}`,
      customer: custName,
      date: new Date().toISOString().split('T')[0],
      amount: payAmt,
      method: payRecordInput.method || 'Cash',
      status: 'Success'
    };
    setPayments([newPay, ...payments]);

    if (cust) {
      setCustomers(customers.map(c => c.id === cust.id ? { ...c, balance: Math.max(0, (c.balance || 0) - payAmt) } : c));
    }

    setRecordPaymentDialogOpen(false);
    setPayRecordInput({ customerId: '', amount: '', method: 'Cash' });
    alert(`Payment of ₹${payAmt} recorded successfully for ${custName}!`);
  };

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* 1. SALES DASHBOARD */}
      {activeTab === 'dashboard' && null}

      {/* 2. NEW SALE WIZARD */}
      {activeTab === 'new-sale' && (
        <Stack spacing={3}>
          <Stepper activeStep={activeStep} alternativeLabel>
            {['Customer', 'Prescription', 'Select Frame', 'Select Lens', 'Checkout'].map((lbl) => (
              <Step key={lbl}><StepLabel>{lbl}</StepLabel></Step>
            ))}
          </Stepper>

          <Card sx={{ p: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
            {activeStep === 0 && (() => {
              const currentCust = customers.find(c => c.id === selectedCustomerId);
              return (
                <Stack spacing={3}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
                    <Typography variant="h6" fontWeight={700}>Step 1: Registered Patient Details</Typography>
                    <Stack direction="row" spacing={1.5}>
                      <Button 
                        variant="contained" 
                        startIcon={<AddIcon />} 
                        onClick={() => navigate('/optical/eyetest', { state: { newTest: true, fromSales: true } })}
                        sx={{ backgroundColor: '#2563EB' }}
                      >
                        + Enter Patient & Eye Details (Eye Test Module)
                      </Button>
                      <Button 
                        variant="outlined" 
                        onClick={() => setAddPatientDialogOpen(true)}
                      >
                        Quick Manual Entry
                      </Button>
                    </Stack>
                  </Box>

                  <Grid container spacing={3}>
                    <Grid item xs={12}>
                      <TextField 
                        select 
                        label="Select Registered Patient" 
                        fullWidth 
                        value={selectedCustomerId} 
                        onChange={(e) => handleCustomerSelect(e.target.value)}
                      >
                        <MenuItem value="">-- Select Registered Patient --</MenuItem>
                        {customers.map(c => (
                          <MenuItem key={c.id} value={c.id}>
                            {c.name} ({c.phone}) {c.hasSpecBooking ? '• [Booked for Specs]' : ''}
                          </MenuItem>
                        ))}
                      </TextField>
                    </Grid>
                  </Grid>

                  {!currentCust ? (
                    <Card variant="outlined" sx={{ p: 4, borderRadius: 3, textAlign: 'center', bgcolor: '#f8fafc', borderStyle: 'dashed' }}>
                      <Typography variant="subtitle1" fontWeight={700} color="text.secondary" gutterBottom>
                        No Patient Selected / Database Empty
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 540, mx: 'auto', mb: 3 }}>
                        All patient details are currently blank. Click "+ Enter Patient & Eye Details" below to open the Eye Test Section and record eye examination details for booking spectacles.
                      </Typography>
                      <Stack direction="row" spacing={2} justifyContent="center" flexWrap="wrap">
                        <Button 
                          variant="contained" 
                          startIcon={<AddIcon />} 
                          onClick={() => navigate('/optical/eyetest', { state: { newTest: true, fromSales: true } })}
                          sx={{ backgroundColor: '#2563EB' }}
                        >
                          + Enter Patient Details in Eye Test Section
                        </Button>
                        <Button 
                          variant="outlined" 
                          onClick={() => setAddPatientDialogOpen(true)}
                        >
                          Quick Manual Entry
                        </Button>
                      </Stack>
                    </Card>
                  ) : (
                    <Stack spacing={3}>
                      {/* Loyalty & Account Info */}
                      <Box sx={{ p: 2, bgcolor: 'action.hover', borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
                        <Stack direction="row" justifyContent="space-between" alignItems="center" mb={1}>
                          <Typography variant="subtitle2" fontWeight={700}>Loyalty & Account Info — {currentCust.name}</Typography>
                          <Chip label={`${currentCust?.tier || 'Silver'} Tier`} color="primary" size="small" variant="outlined" />
                        </Stack>
                        <Grid container spacing={1}>
                          <Grid item xs={4}>
                            <Typography variant="caption" color="text.secondary">Phone Number:</Typography>
                            <Typography variant="body2" fontWeight={700}>{currentCust?.phone || 'N/A'}</Typography>
                          </Grid>
                          <Grid item xs={4}>
                            <Typography variant="caption" color="text.secondary">Rewards Balance:</Typography>
                            <Typography variant="body2" fontWeight={700}>{currentCust?.points || 0} Points</Typography>
                          </Grid>
                          <Grid item xs={4}>
                            <Typography variant="caption" color="text.secondary">Outstanding Due:</Typography>
                            <Typography variant="body2" fontWeight={700} color={currentCust?.balance > 0 ? 'error.main' : 'success.main'}>
                              ₹{currentCust?.balance || 0}
                            </Typography>
                          </Grid>
                        </Grid>
                      </Box>

                      {/* OPTICAL SERVICES DATABASE - SPECTACLE BOOKING RECORD */}
                      <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#f0fdf4', borderColor: '#86efac' }}>
                        <Stack spacing={2}>
                          <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={1}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <Typography variant="h6" sx={{ fontSize: '1.2rem' }}>👓</Typography>
                              <Typography variant="subtitle1" fontWeight={800} color="success.dark">
                                Optical Services Database — Spectacle Booking Record
                              </Typography>
                            </Box>
                            <Chip 
                              label={currentCust.specDetails?.status || 'Booked for Spectacles'} 
                              color="success" 
                              size="small" 
                              sx={{ fontWeight: 700 }}
                            />
                          </Stack>

                          <Divider sx={{ borderColor: '#bbf7d0' }} />

                          <Grid container spacing={2}>
                            <Grid item xs={12} sm={4}>
                              <Typography variant="caption" color="text.secondary">Booking Reference:</Typography>
                              <Typography variant="body2" fontWeight={700}>{currentCust.specDetails?.bookingId || 'SPEC-8947'}</Typography>
                            </Grid>
                            <Grid item xs={12} sm={4}>
                              <Typography variant="caption" color="text.secondary">Exam Date & Doctor:</Typography>
                              <Typography variant="body2" fontWeight={700}>{currentCust.date || new Date().toISOString().split('T')[0]} ({currentCust.doctor})</Typography>
                            </Grid>
                            <Grid item xs={12} sm={4}>
                              <Typography variant="caption" color="text.secondary">Patient Phone:</Typography>
                              <Typography variant="body2" fontWeight={700}>{currentCust.phone}</Typography>
                            </Grid>

                            <Grid item xs={12} sm={6}>
                              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: '#ffffff', borderColor: '#bbf7d0' }}>
                                <Typography variant="caption" color="text.secondary" fontWeight={700}>PRESCRIBED FRAME RECOMMENDATION</Typography>
                                <Typography variant="body2" fontWeight={800} color="primary.main">
                                  {currentCust.specDetails?.frameRec || 'RayBan Wayfarer Classic (Black)'}
                                </Typography>
                              </Paper>
                            </Grid>
                            <Grid item xs={12} sm={6}>
                              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: '#ffffff', borderColor: '#bbf7d0' }}>
                                <Typography variant="caption" color="text.secondary" fontWeight={700}>PRESCRIBED LENS RECOMMENDATION</Typography>
                                <Typography variant="body2" fontWeight={800} color="primary.main">
                                  {currentCust.specDetails?.lensRec || 'Essilor Crizal Prevencia 1.56 Anti-Glare'}
                                </Typography>
                              </Paper>
                            </Grid>
                          </Grid>

                          {/* Prescribed Power Table */}
                          <Box sx={{ mt: 1 }}>
                            <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ mb: 1, display: 'block' }}>
                              PRESCRIBED OPTICAL POWER (OD / OS)
                            </Typography>
                            <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                              <Table size="small">
                                <TableHead sx={{ bgcolor: '#f8fafc' }}>
                                  <TableRow>
                                    <TableCell sx={{ fontWeight: 700 }}>Eye</TableCell>
                                    <TableCell sx={{ fontWeight: 700 }}>SPH</TableCell>
                                    <TableCell sx={{ fontWeight: 700 }}>CYL</TableCell>
                                    <TableCell sx={{ fontWeight: 700 }}>AXIS</TableCell>
                                  </TableRow>
                                </TableHead>
                                <TableBody>
                                  <TableRow>
                                    <TableCell sx={{ fontWeight: 700 }}>Right Eye (OD)</TableCell>
                                    <TableCell>{currentCust.sphRight || 'Plano'}</TableCell>
                                    <TableCell>{currentCust.cylRight || 'Plano'}</TableCell>
                                    <TableCell>{currentCust.axisRight || '0'}°</TableCell>
                                  </TableRow>
                                  <TableRow>
                                    <TableCell sx={{ fontWeight: 700 }}>Left Eye (OS)</TableCell>
                                    <TableCell>{currentCust.sphLeft || 'Plano'}</TableCell>
                                    <TableCell>{currentCust.cylLeft || 'Plano'}</TableCell>
                                    <TableCell>{currentCust.axisLeft || '0'}°</TableCell>
                                  </TableRow>
                                </TableBody>
                              </Table>
                            </TableContainer>
                          </Box>
                        </Stack>
                      </Card>
                    </Stack>
                  )}

                  <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 2 }}>
                    <Button 
                      variant="contained" 
                      disabled={!currentCust}
                      onClick={() => setActiveStep(1)} 
                      sx={{ backgroundColor: '#2563EB', px: 4 }}
                    >
                      Continue to Prescription & Billing
                    </Button>
                  </Box>
                </Stack>
              );
            })()}

            {activeStep === 1 && (
              <Stack spacing={3}>
                <Typography variant="h6" fontWeight={700}>Step 2: Prescription Loader</Typography>
                <Grid container spacing={2}>
                  <Grid item xs={4}><TextField label="SPH (OD)" fullWidth value={rxSphOD} onChange={(e) => setRxSphOD(e.target.value)} /></Grid>
                  <Grid item xs={4}><TextField label="CYL (OD)" fullWidth value={rxCylOD} onChange={(e) => setRxCylOD(e.target.value)} /></Grid>
                  <Grid item xs={4}><TextField label="AXIS (OD)" fullWidth value={rxAxisOD} onChange={(e) => setRxAxisOD(e.target.value)} /></Grid>
                  <Grid item xs={4}><TextField label="SPH (OS)" fullWidth value={rxSphOS} onChange={(e) => setRxSphOS(e.target.value)} /></Grid>
                  <Grid item xs={4}><TextField label="CYL (OS)" fullWidth value={rxCylOS} onChange={(e) => setRxCylOS(e.target.value)} /></Grid>
                  <Grid item xs={4}><TextField label="AXIS (OS)" fullWidth value={rxAxisOS} onChange={(e) => setRxAxisOS(e.target.value)} /></Grid>
                  <Grid item xs={12}><TextField label="Prescribed by Doctor" fullWidth value={presDoctor} onChange={(e) => setPresDoctor(e.target.value)} /></Grid>
                </Grid>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 3 }}>
                  <Button variant="outlined" onClick={() => setActiveStep(0)}>Back</Button>
                  <Button variant="contained" onClick={() => setActiveStep(2)} sx={{ backgroundColor: '#2563EB' }}>Continue</Button>
                </Box>
              </Stack>
            )}

            {activeStep === 2 && (
              <Stack spacing={3}>
                <Typography variant="h6" fontWeight={700}>Step 3: Frame Selection</Typography>
                <TextField select size="small" label="Frame Brand" value={frameFilter} onChange={(e) => setFrameFilter(e.target.value)} sx={{ width: 160 }}>
                  <MenuItem value="All">All Brands</MenuItem>
                  <MenuItem value="RayBan">RayBan</MenuItem>
                  <MenuItem value="Oakley">Oakley</MenuItem>
                  <MenuItem value="Titan">Titan</MenuItem>
                </TextField>
                <Grid container spacing={2}>
                  {products.filter(p => p.type === 'Frame' && (frameFilter === 'All' || p.brand === frameFilter)).length === 0 ? (
                    <Grid item xs={12}>
                      <Card variant="outlined" sx={{ p: 4, textAlign: 'center', bgcolor: '#f8fafc', borderRadius: 3, borderStyle: 'dashed' }}>
                        <Typography variant="body2" color="text.secondary">
                          No frame products available in the database.
                        </Typography>
                      </Card>
                    </Grid>
                  ) : (
                    products.filter(p => p.type === 'Frame' && (frameFilter === 'All' || p.brand === frameFilter)).map(prod => (
                      <Grid item xs={12} sm={6} md={4} key={prod.id}>
                        <Card variant="outlined" sx={{ p: 2, borderRadius: 3, border: cart.some(item => item.product.id === prod.id) ? '2px solid #2563EB' : '1px solid #ddd' }}>
                          <Typography variant="h4" align="center">{prod.image}</Typography>
                          <Typography variant="subtitle2" fontWeight={700} align="center">{prod.name}</Typography>
                          <Typography variant="body2" fontWeight={800} align="center" sx={{ mt: 1 }}>₹{prod.price}</Typography>
                          <Button variant="contained" fullWidth sx={{ mt: 2, backgroundColor: '#2563EB' }} onClick={() => addToCart(prod)}>
                            {cart.some(item => item.product.id === prod.id) ? 'Selected' : 'Pick Frame'}
                          </Button>
                        </Card>
                      </Grid>
                    ))
                  )}
                </Grid>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 3 }}>
                  <Button variant="outlined" onClick={() => setActiveStep(1)}>Back</Button>
                  <Button variant="contained" onClick={() => setActiveStep(3)} sx={{ backgroundColor: '#2563EB' }}>Continue</Button>
                </Box>
              </Stack>
            )}

            {activeStep === 3 && (
              <Stack spacing={3}>
                <Typography variant="h6" fontWeight={700}>Step 4: Lens Selection</Typography>
                <Grid container spacing={2}>
                  {products.filter(p => p.type === 'Lens').length === 0 ? (
                    <Grid item xs={12}>
                      <Card variant="outlined" sx={{ p: 4, textAlign: 'center', bgcolor: '#f8fafc', borderRadius: 3, borderStyle: 'dashed' }}>
                        <Typography variant="body2" color="text.secondary">
                          No lens products available in the database.
                        </Typography>
                      </Card>
                    </Grid>
                  ) : (
                    products.filter(p => p.type === 'Lens').map(prod => (
                      <Grid item xs={12} sm={6} md={4} key={prod.id}>
                        <Card variant="outlined" sx={{ p: 2, borderRadius: 3, border: cart.some(item => item.product.id === prod.id) ? '2px solid #2563EB' : '1px solid #ddd' }}>
                          <Typography variant="h4" align="center">{prod.image}</Typography>
                          <Typography variant="subtitle2" fontWeight={700} align="center">{prod.name}</Typography>
                          <Typography variant="body2" fontWeight={800} align="center" sx={{ mt: 1 }}>₹{prod.price}</Typography>
                          <Button variant="contained" fullWidth sx={{ mt: 2, backgroundColor: '#2563EB' }} onClick={() => addToCart(prod)}>
                            {cart.some(item => item.product.id === prod.id) ? 'Selected' : 'Pick Lens'}
                          </Button>
                        </Card>
                      </Grid>
                    ))
                  )}
                </Grid>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 3 }}>
                  <Button variant="outlined" onClick={() => setActiveStep(2)}>Back</Button>
                  <Button variant="contained" onClick={() => setActiveStep(4)} sx={{ backgroundColor: '#2563EB' }}>Continue</Button>
                </Box>
              </Stack>
            )}

            {activeStep === 4 && (
              <Stack spacing={3}>
                <Typography variant="h6" fontWeight={700}>Step 5: Checkout Summary</Typography>
                <Grid container spacing={3}>
                  <Grid item xs={12} md={7}>
                    <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 2 }}>Selected Items</Typography>
                    {cart.map((item, i) => (
                      <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', mb: 2 }}>
                        <Typography variant="body2">{item.product.name} (x{item.qty})</Typography>
                        <Typography variant="body2" fontWeight={700}>₹{item.product.price * item.qty}</Typography>
                      </Box>
                    ))}
                    <Divider sx={{ my: 2 }} />
                    <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>Checklist Add-ons (Accessories)</Typography>
                    <FormGroup row>
                      <FormControlLabel control={<Checkbox checked={accessories.cloth} onChange={() => handleAccessoryChange('cloth', 150)} />} label="Cloth (+₹150)" />
                      <FormControlLabel control={<Checkbox checked={accessories.spray} onChange={() => handleAccessoryChange('spray', 250)} />} label="Spray (+₹250)" />
                      <FormControlLabel control={<Checkbox checked={accessories.hardCase} onChange={() => handleAccessoryChange('hardCase', 450)} />} label="Hard Case (+₹450)" />
                    </FormGroup>
                  </Grid>

                  <Grid item xs={12} md={5}>
                    <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                      <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 2 }}>Payment Configuration</Typography>
                      <Stack spacing={1}>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography variant="caption">Subtotal</Typography><Typography variant="body2">₹{subtotal}</Typography></Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography variant="caption">GST / Taxes</Typography><Typography variant="body2">₹{tax}</Typography></Box>
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Typography variant="caption">Discount (₹)</Typography>
                          <TextField size="small" type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} sx={{ width: 80 }} />
                        </Box>
                        <Divider />
                        <Box sx={{ display: 'flex', justifyContent: 'space-between', pt: 1 }}>
                          <Typography variant="body1" fontWeight={700}>Total Payable</Typography>
                          <Typography variant="body1" fontWeight={700} color="primary">₹{total}</Typography>
                        </Box>
                      </Stack>
                      <Button variant="contained" fullWidth onClick={() => setPrintOpen(true)} sx={{ mt: 3, backgroundColor: '#2563EB' }}>
                        Generate & Print Invoice
                      </Button>
                    </Card>
                  </Grid>
                </Grid>
                <Box sx={{ display: 'flex', justifyContent: 'flex-start', mt: 3 }}>
                  <Button variant="outlined" onClick={() => setActiveStep(3)}>Back</Button>
                </Box>
              </Stack>
            )}
          </Card>
        </Stack>
      )}

      {/* 3. POS BILLING */}
      {activeTab === 'pos-billing' && (
        <Grid container spacing={3}>
          <Grid item xs={12} md={7}>
            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider', p: 3 }}>
              <Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>Barcode & QR Scanner Billing Panel</Typography>
              <Stack direction="row" spacing={2} sx={{ mb: 3 }}>
                <TextField 
                  fullWidth 
                  size="small" 
                  placeholder="Scan Frame Barcode or Search Products..." 
                  InputProps={{
                    startAdornment: <ScannerIcon color="action" sx={{ mr: 1 }} />
                  }}
                />
                <Button variant="contained" startIcon={<AddIcon />} sx={{ backgroundColor: '#2563EB' }} onClick={() => setQrOpen(true)}>Scan QR</Button>
              </Stack>
              <Grid container spacing={2}>
                {products.length === 0 ? (
                  <Grid item xs={12}>
                    <Card variant="outlined" sx={{ p: 4, textAlign: 'center', bgcolor: '#f8fafc', borderRadius: 3, borderStyle: 'dashed' }}>
                      <Typography variant="subtitle1" fontWeight={700} color="text.secondary" gutterBottom>
                        No Products Registered in Database
                      </Typography>
                      <Typography variant="body2" color="text.secondary">
                        All product details are currently blank. Data will appear here once frames, lenses, or contact lenses are entered into the database.
                      </Typography>
                    </Card>
                  </Grid>
                ) : (
                  products.map(prod => (
                    <Grid item xs={6} key={prod.id}>
                      <Card variant="outlined" sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderRadius: 3 }}>
                        <Box>
                          <Typography variant="subtitle2" fontWeight={700}>{prod.name}</Typography>
                          <Typography variant="caption" color="text.secondary">₹{prod.price}</Typography>
                        </Box>
                        <Button size="small" variant="contained" sx={{ backgroundColor: '#2563EB' }} onClick={() => addToCart(prod)}>Add</Button>
                      </Card>
                    </Grid>
                  ))
                )}
              </Grid>
            </Card>
          </Grid>

          <Grid item xs={12} md={5}>
            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider', p: 3 }}>
              <Typography variant="h6" fontWeight={700} sx={{ mb: 2 }}>Shopping Cart</Typography>
              <Stack spacing={2} sx={{ maxH: 250, overflowY: 'auto', mb: 2 }}>
                {cart.length === 0 ? (
                  <Typography variant="body2" color="text.secondary" align="center">Cart is empty.</Typography>
                ) : (
                  cart.map((item, idx) => (
                    <Box key={idx} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <Typography variant="body2" sx={{ maxWidth: '60%' }}>{item.product.name}</Typography>
                      <Stack direction="row" spacing={1} alignItems="center">
                        <IconButton size="small" onClick={() => updateQty(item.product.id, item.qty - 1)}><RemoveIcon fontSize="small" /></IconButton>
                        <Typography variant="body2">{item.qty}</Typography>
                        <IconButton size="small" onClick={() => addToCart(item.product)}><AddIcon fontSize="small" /></IconButton>
                        <Typography variant="body2" fontWeight={700}>₹{item.product.price * item.qty}</Typography>
                      </Stack>
                    </Box>
                  ))
                )}
              </Stack>
              <Divider sx={{ my: 2 }} />
              <Stack spacing={1.5}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography variant="body2">Subtotal</Typography><Typography variant="body2" fontWeight={700}>₹{subtotal}</Typography></Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between' }}><Typography variant="body2">GST/Tax</Typography><Typography variant="body2" fontWeight={700}>₹{tax}</Typography></Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Typography variant="body2">Discount (₹)</Typography>
                  <TextField size="small" type="number" value={discount} onChange={(e) => setDiscount(e.target.value)} sx={{ width: 100 }} />
                </Box>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', pt: 1 }}><Typography variant="subtitle1" fontWeight={850}>Total Payable</Typography><Typography variant="subtitle1" fontWeight={850} color="primary">₹{total}</Typography></Box>
              </Stack>

              <TextField select label="Payment Mode" fullWidth value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)} sx={{ mt: 3, mb: 2 }}>
                <MenuItem value="Cash">Cash</MenuItem>
                <MenuItem value="Card">Card</MenuItem>
                <MenuItem value="UPI (GPay/PhonePe)">UPI (GPay/PhonePe)</MenuItem>
                <MenuItem value="Split Payment">Split (Cash + UPI)</MenuItem>
              </TextField>

              <Button variant="contained" fullWidth size="large" sx={{ backgroundColor: '#2563EB', py: 1.5 }} onClick={() => setPrintOpen(true)} disabled={cart.length === 0}>
                Quick Pay & Print Receipt
              </Button>
            </Card>
          </Grid>
        </Grid>
      )}

      {/* 4. ORDERS */}
      {activeTab === 'orders' && (() => {
        const filteredOrders = orders.filter(ord => {
          const searchLower = orderSearchQuery.toLowerCase();
          const matchesSearch = (ord.id && ord.id.toLowerCase().includes(searchLower)) ||
                                (ord.customer && ord.customer.toLowerCase().includes(searchLower)) ||
                                (ord.frame && ord.frame.toLowerCase().includes(searchLower)) ||
                                (ord.lens && ord.lens.toLowerCase().includes(searchLower));
          const matchesStatus = orderStatusFilter === 'All' || ord.status === orderStatusFilter;
          return matchesSearch && matchesStatus;
        });

        const totalOrderValue = orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
        const inLabCount = orders.filter(o => o.status !== 'Delivered').length;
        const readyCount = orders.filter(o => o.status === 'Ready' || o.status === 'Ready for Delivery').length;

        return (
          <Stack spacing={3}>
            {/* Orders Header & KPI Cards */}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
              <Box>
                <Typography variant="h5" fontWeight={800}>Spectacle Sales & Lab Orders</Typography>
                <Typography variant="body2" color="text.secondary">Track optical lab processing, lens fitting, and customer spectacle deliveries</Typography>
              </Box>
              <Stack direction="row" spacing={1.5}>
                <Button 
                  variant="contained" 
                  startIcon={<AddIcon />} 
                  onClick={() => navigate('/sales/new')}
                  sx={{ backgroundColor: '#2563EB' }}
                >
                  + New Sale Order
                </Button>
                <Button 
                  variant="outlined" 
                  startIcon={<AddIcon />} 
                  onClick={() => navigate('/optical/eyetest', { state: { newTest: true, fromSales: true } })}
                >
                  Enter Eye Test & Booking
                </Button>
              </Stack>
            </Box>

            {/* KPI Metrics */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL ORDERS</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{orders.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Active order records</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>IN LAB QUEUE</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>{inLabCount}</Typography>
                  <Typography variant="caption" color="text.secondary">Lens cutting & fitting</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>READY FOR PICKUP</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">{readyCount}</Typography>
                  <Typography variant="caption" color="text.secondary">Quality pass completed</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL ORDERS REVENUE</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>₹{totalOrderValue.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Accumulated order total</Typography>
                </Paper>
              </Grid>
            </Grid>

            {/* Filter & Search Toolbar */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                <TextField 
                  fullWidth 
                  size="small" 
                  placeholder="Search Order ID, Customer Name, or Lens/Frame..."
                  value={orderSearchQuery}
                  onChange={(e) => setOrderSearchQuery(e.target.value)}
                  InputProps={{
                    startAdornment: <ScannerIcon color="action" sx={{ mr: 1, fontSize: 20 }} />
                  }}
                />
                <TextField 
                  select 
                  size="small" 
                  label="Filter Status" 
                  value={orderStatusFilter} 
                  onChange={(e) => setOrderStatusFilter(e.target.value)}
                  sx={{ minWidth: 180 }}
                >
                  <MenuItem value="All">All Statuses</MenuItem>
                  <MenuItem value="Pending Lab">Pending Lab</MenuItem>
                  <MenuItem value="In Fitting">In Fitting</MenuItem>
                  <MenuItem value="Ready">Ready for Delivery</MenuItem>
                  <MenuItem value="Delivered">Delivered</MenuItem>
                </TextField>
                {(orderSearchQuery || orderStatusFilter !== 'All') && (
                  <Button variant="text" size="small" onClick={() => { setOrderSearchQuery(''); setOrderStatusFilter('All'); }}>
                    Reset
                  </Button>
                )}
              </Stack>
            </Card>

            {/* Main Orders Table */}
            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="medium">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Order ID</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Customer Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Prescribed Items</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Delivery Date</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Payable</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Workflow Status</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Progress</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredOrders.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            {orderSearchQuery ? "No matching orders found." : "No sales orders recorded in the database."}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {orderSearchQuery ? "Try refining your search keyword or clearing filters." : "Orders created through POS Billing or New Sale will appear here automatically."}
                          </Typography>
                          {!orderSearchQuery && (
                            <Stack direction="row" spacing={2} justifyContent="center" sx={{ mt: 2 }}>
                              <Button 
                                size="small" 
                                variant="contained" 
                                startIcon={<AddIcon />} 
                                onClick={() => navigate('/sales/new')} 
                                sx={{ backgroundColor: '#2563EB' }}
                              >
                                Create First Order
                              </Button>
                              <Button 
                                size="small" 
                                variant="outlined" 
                                onClick={() => navigate('/optical/eyetest', { state: { newTest: true, fromSales: true } })}
                              >
                                Enter Eye Test & Booking
                              </Button>
                            </Stack>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredOrders.map((ord) => (
                        <TableRow key={ord.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{ord.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{ord.customer}</TableCell>
                          <TableCell>
                            <Typography variant="body2" fontWeight={600}>{ord.frame || 'Optical Frame'}</Typography>
                            <Typography variant="caption" color="text.secondary">{ord.lens || 'Anti-Reflective Lens'}</Typography>
                          </TableCell>
                          <TableCell>{ord.deliveryDate || 'Standard (3 Days)'}</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>₹{ord.total}</TableCell>
                          <TableCell>
                            <Chip 
                              label={ord.status} 
                              size="small" 
                              color={
                                ord.status === 'Delivered' ? 'success' : 
                                ord.status === 'Ready' || ord.status === 'Ready for Delivery' ? 'info' : 
                                ord.status === 'In Fitting' ? 'warning' : 'primary'
                              } 
                              sx={{ fontWeight: 700 }}
                            />
                          </TableCell>
                          <TableCell sx={{ width: 140 }}>
                            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                              <LinearProgress 
                                variant="determinate" 
                                value={ord.progress || (ord.status === 'Delivered' ? 100 : ord.status === 'Ready' ? 80 : ord.status === 'In Fitting' ? 50 : 20)} 
                                sx={{ width: 70, height: 6, borderRadius: 3 }} 
                              />
                              <Typography variant="caption" fontWeight={700}>
                                {ord.progress || (ord.status === 'Delivered' ? 100 : ord.status === 'Ready' ? 80 : ord.status === 'In Fitting' ? 50 : 20)}%
                              </Typography>
                            </Box>
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button 
                                size="small" 
                                variant="outlined" 
                                onClick={() => { setSelectedOrder(ord); setOrderDetailTab(0); }}
                              >
                                Job Card
                              </Button>
                              <Button 
                                size="small" 
                                variant="text" 
                                color="secondary"
                                onClick={() => {
                                  const nextStatus = ord.status === 'Pending Lab' ? 'In Fitting' : 
                                                     ord.status === 'In Fitting' ? 'Ready' : 
                                                     ord.status === 'Ready' ? 'Delivered' : 'Pending Lab';
                                  setOrders(orders.map(o => o.id === ord.id ? { 
                                    ...o, 
                                    status: nextStatus,
                                    progress: nextStatus === 'Delivered' ? 100 : nextStatus === 'Ready' ? 80 : nextStatus === 'In Fitting' ? 50 : 20
                                  } : o));
                                }}
                              >
                                Advance Stage
                              </Button>
                            </Stack>
                          </TableCell>
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

      {/* 5. CUSTOMERS */}
      {activeTab === 'customers' && (() => {
        const filteredCustomers = customers.filter(cust => {
          const searchLower = customerSearchQuery.toLowerCase();
          const matchesSearch = (cust.name && cust.name.toLowerCase().includes(searchLower)) ||
                                (cust.phone && cust.phone.toLowerCase().includes(searchLower)) ||
                                (cust.email && cust.email.toLowerCase().includes(searchLower)) ||
                                (cust.id && cust.id.toLowerCase().includes(searchLower));
          const matchesTier = customerTierFilter === 'All' || cust.tier === customerTierFilter;
          return matchesSearch && matchesTier;
        });

        const totalVipCount = customers.filter(c => c.tier === 'Gold' || c.tier === 'Platinum').length;
        const totalSpecBookedCount = customers.filter(c => c.hasSpecBooking).length;
        const totalRewardPoints = customers.reduce((sum, c) => sum + (parseInt(c.points) || 0), 0);

        return (
          <Stack spacing={3}>
            {/* Customers Header & Action Bar */}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
              <Box>
                <Typography variant="h5" fontWeight={800}>Patient Directory & Customer CRM</Typography>
                <Typography variant="body2" color="text.secondary">Manage registered patient profiles, visual acuity histories, and loyalty rewards</Typography>
              </Box>
              <Stack direction="row" spacing={1.5}>
                <Button 
                  variant="contained" 
                  startIcon={<AddIcon />} 
                  onClick={() => setAddPatientDialogOpen(true)}
                  sx={{ backgroundColor: '#2563EB' }}
                >
                  + Register New Patient
                </Button>
                <Button 
                  variant="outlined" 
                  startIcon={<AddIcon />} 
                  onClick={() => navigate('/optical/eyetest', { state: { newTest: true, fromSales: true } })}
                >
                  Enter Eye Test & Booking
                </Button>
              </Stack>
            </Box>

            {/* KPI Summary Cards */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>REGISTERED PATIENTS</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{customers.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Database profiles</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>VIP & GOLD MEMBERS</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>{totalVipCount}</Typography>
                  <Typography variant="caption" color="text.secondary">Gold & Platinum tier</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>SPEC BOOKINGS</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">{totalSpecBookedCount}</Typography>
                  <Typography variant="caption" color="text.secondary">Optical exams linked</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>REWARD POINTS ISSUED</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>{totalRewardPoints} Pts</Typography>
                  <Typography variant="caption" color="text.secondary">Accumulated loyalty points</Typography>
                </Paper>
              </Grid>
            </Grid>

            {/* Filter & Search Toolbar */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                <TextField 
                  fullWidth 
                  size="small" 
                  placeholder="Search Patient Name, Phone Number, Email, or Patient ID..."
                  value={customerSearchQuery}
                  onChange={(e) => setCustomerSearchQuery(e.target.value)}
                  InputProps={{
                    startAdornment: <ScannerIcon color="action" sx={{ mr: 1, fontSize: 20 }} />
                  }}
                />
                <TextField 
                  select 
                  size="small" 
                  label="Filter Tier" 
                  value={customerTierFilter} 
                  onChange={(e) => setCustomerTierFilter(e.target.value)}
                  sx={{ minWidth: 160 }}
                >
                  <MenuItem value="All">All Tiers</MenuItem>
                  <MenuItem value="Silver">Silver Tier</MenuItem>
                  <MenuItem value="Gold">Gold Tier</MenuItem>
                  <MenuItem value="Platinum">Platinum Tier</MenuItem>
                </TextField>
                {(customerSearchQuery || customerTierFilter !== 'All') && (
                  <Button variant="text" size="small" onClick={() => { setCustomerSearchQuery(''); setCustomerTierFilter('All'); }}>
                    Reset
                  </Button>
                )}
              </Stack>
            </Card>

            {/* Main Patients Table */}
            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table>
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Patient ID</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Patient Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Contact Phone</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Tier Status</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Rewards Balance</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Optical Spec Booking</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>Quick Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredCustomers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            {customerSearchQuery ? "No matching registered patients found." : "No registered customer profiles found in the database."}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {customerSearchQuery ? "Try refining your search keyword or clearing filters." : "Click '+ Register New Patient' or enter patient details in Eye Test section to register patients."}
                          </Typography>
                          {!customerSearchQuery && (
                            <Stack direction="row" spacing={2} justifyContent="center" sx={{ mt: 2 }}>
                              <Button 
                                size="small" 
                                variant="contained" 
                                startIcon={<AddIcon />} 
                                onClick={() => setAddPatientDialogOpen(true)} 
                                sx={{ backgroundColor: '#2563EB' }}
                              >
                                + Register First Patient
                              </Button>
                              <Button 
                                size="small" 
                                variant="outlined" 
                                onClick={() => navigate('/optical/eyetest', { state: { newTest: true, fromSales: true } })}
                              >
                                Enter Eye Test & Booking
                              </Button>
                            </Stack>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredCustomers.map((cust) => (
                        <TableRow key={cust.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{cust.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>
                            {cust.name}
                            {cust.email && (
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                {cust.email}
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell>{cust.phone}</TableCell>
                          <TableCell>
                            <Chip 
                              label={cust.tier || 'Silver'} 
                              color={cust.tier === 'Platinum' ? 'secondary' : cust.tier === 'Gold' ? 'primary' : 'default'} 
                              size="small" 
                              sx={{ fontWeight: 700 }}
                            />
                          </TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>{cust.points || 100} Pts</TableCell>
                          <TableCell>
                            {cust.hasSpecBooking ? (
                              <Chip label="Booked for Specs" color="success" variant="outlined" size="small" sx={{ fontWeight: 700 }} />
                            ) : (
                              <Typography variant="caption" color="text.secondary">No spec booking</Typography>
                            )}
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button 
                                size="small" 
                                variant="outlined" 
                                onClick={() => { setSelectedCustomer(cust); setCustomerDetailTab(0); }}
                              >
                                View Profile / Rx
                              </Button>
                              <Button 
                                size="small" 
                                variant="contained" 
                                sx={{ backgroundColor: '#2563EB' }} 
                                onClick={() => { handleCustomerSelect(cust.id); navigate('/sales/new'); }}
                              >
                                New Sale
                              </Button>
                            </Stack>
                          </TableCell>
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

      {/* 6. PAYMENTS */}
      {activeTab === 'payments' && (() => {
        const outstandingCusts = customers.filter(c => parseFloat(c.balance || 0) > 0);
        const totalCollectedAmt = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
        const totalOutstandingAmt = customers.reduce((sum, c) => sum + (parseFloat(c.balance) || 0), 0);

        return (
          <Stack spacing={3}>
            {/* Header & Record Payment Action Bar */}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 2 }}>
              <Box>
                <Typography variant="h5" fontWeight={800}>Payment Collections & Ledger</Typography>
                <Typography variant="body2" color="text.secondary">Audit payment receipts, cash logs, UPI collections, and outstanding customer dues</Typography>
              </Box>
              <Button 
                variant="contained" 
                startIcon={<AddIcon />} 
                onClick={() => setRecordPaymentDialogOpen(true)}
                sx={{ backgroundColor: '#2563EB', px: 3, py: 1, borderRadius: 2.5, fontWeight: 700 }}
              >
                + Record Payment Collection
              </Button>
            </Box>

            {/* KPI Summary Banner */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={4}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL PAYMENTS COLLECTED</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">₹{totalCollectedAmt.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">{payments.length} receipt transactions</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #ef4444', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>OUTSTANDING CUSTOMER DUES</Typography>
                  <Typography variant="h4" fontWeight={850} color="error.main">₹{totalOutstandingAmt.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">{outstandingCusts.length} accounts pending payment</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={4}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>COLLECTION RECEIPTS</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{payments.length}</Typography>
                  <Typography variant="caption" color="text.secondary">100% verified settlement</Typography>
                </Paper>
              </Grid>
            </Grid>

            {/* Main Dual Card Layout: Left Payment Collections & Right Outstanding Balances */}
            <Grid container spacing={3}>
              {/* Left Card: Payment Collections & Log */}
              <Grid item xs={12} md={8}>
                <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider', p: 3, minHeight: 420 }}>
                  <Typography variant="h6" fontWeight={800} sx={{ mb: 2.5 }}>Payment Collections & Log</Typography>
                  <TableContainer>
                    <Table size="small">
                      <TableHead sx={{ backgroundColor: 'action.hover' }}>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700 }}>Date</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Receipt ID</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Customer</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Amount Collected</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Method</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {payments.length === 0 ? (
                          <TableRow>
                            <TableCell colSpan={6} align="center" sx={{ py: 8 }}>
                              <Typography variant="body2" color="text.secondary" fontWeight={500}>
                                No payment collection logs recorded in the database.
                              </Typography>
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                                Payments recorded during POS Billing or manual entry will appear here.
                              </Typography>
                            </TableCell>
                          </TableRow>
                        ) : (
                          payments.map((p, idx) => (
                            <TableRow key={idx} hover>
                              <TableCell>{p.date}</TableCell>
                              <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{p.id}</TableCell>
                              <TableCell sx={{ fontWeight: 600 }}>{p.customer}</TableCell>
                              <TableCell sx={{ fontWeight: 700, color: 'success.main' }}>₹{p.amount}</TableCell>
                              <TableCell>{p.method}</TableCell>
                              <TableCell><Chip label={p.status} color="success" size="small" sx={{ fontWeight: 700 }} /></TableCell>
                            </TableRow>
                          ))
                        )}
                      </TableBody>
                    </Table>
                  </TableContainer>
                </Card>
              </Grid>

              {/* Right Card: Outstanding Balances */}
              <Grid item xs={12} md={4}>
                <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider', p: 3, minHeight: 420 }}>
                  <Typography variant="h6" fontWeight={800} sx={{ mb: 2.5 }}>Outstanding Balances</Typography>
                  <Stack spacing={2}>
                    {outstandingCusts.length === 0 ? (
                      <Box sx={{ py: 8, textAlign: 'center' }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={500}>
                          No outstanding customer balances found in database.
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                          All patient customer accounts are currently fully settled.
                        </Typography>
                      </Box>
                    ) : (
                      outstandingCusts.map(c => (
                        <Paper key={c.id} variant="outlined" sx={{ p: 2, borderRadius: 2.5, bgcolor: '#fff' }}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <Box>
                              <Typography variant="subtitle2" fontWeight={700}>{c.name}</Typography>
                              <Typography variant="caption" color="text.secondary">{c.phone || 'No phone'}</Typography>
                            </Box>
                            <Box sx={{ textAlign: 'right' }}>
                              <Typography variant="subtitle2" fontWeight={850} color="error.main">₹{c.balance}</Typography>
                              <Stack direction="row" spacing={0.5} sx={{ mt: 0.5 }}>
                                <Button 
                                  size="small" 
                                  variant="text" 
                                  color="secondary"
                                  onClick={() => alert(`Payment reminder notification sent to ${c.name} (${c.phone})!`)}
                                >
                                  Remind
                                </Button>
                                <Button 
                                  size="small" 
                                  variant="contained" 
                                  sx={{ backgroundColor: '#2563EB', fontSize: '0.7rem' }}
                                  onClick={() => {
                                    setPayRecordInput({ customerId: c.id, amount: String(c.balance), method: 'Cash' });
                                    setRecordPaymentDialogOpen(true);
                                  }}
                                >
                                  Collect
                                </Button>
                              </Stack>
                            </Box>
                          </Box>
                        </Paper>
                      ))
                    )}
                  </Stack>
                </Card>
              </Grid>
            </Grid>
          </Stack>
        );
      })()}

      {/* 7. REPORTS */}
      {activeTab === 'reports' && (() => {
        // Dynamic Live Calculations from Sales & Optical Services Database
        const getDailyReportData = () => {
          if (orders.length === 0 && payments.length === 0) return [];
          const dateMap = {};
          [...orders, ...payments].forEach(item => {
            const d = item.date || new Date().toISOString().split('T')[0];
            const amt = parseFloat(item.total || item.amount || 0);
            if (!dateMap[d]) {
              dateMap[d] = { date: d, count: 0, revenue: 0, gst: 0, profit: 0 };
            }
            dateMap[d].count += 1;
            dateMap[d].revenue += amt;
            dateMap[d].gst += amt * 0.18;
            dateMap[d].profit += amt * 0.40;
          });
          return Object.values(dateMap);
        };

        const getWorkflowReportData = () => {
          if (orders.length === 0) return [];
          const stages = ['Pending Lab', 'In Fitting', 'Ready', 'Delivered'];
          const totalCount = orders.length || 1;
          return stages.map(stage => {
            const matchOrders = orders.filter(o => o.status === stage || (stage === 'Ready' && o.status === 'Ready for Delivery'));
            const val = matchOrders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0);
            return {
              stage: stage === 'Ready' ? 'Ready for Delivery' : stage,
              count: matchOrders.length,
              share: Math.round((matchOrders.length / totalCount) * 100),
              value: val
            };
          });
        };

        const getPaymentMethodReportData = () => {
          if (payments.length === 0) return [];
          const methods = ['Cash', 'Card', 'UPI'];
          const totalAmt = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0) || 1;
          return methods.map(method => {
            const matchPays = payments.filter(p => (p.method || '').toLowerCase().includes(method.toLowerCase()));
            const amt = matchPays.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
            return {
              method: method === 'UPI' ? 'UPI (GPay / PhonePe / Paytm)' : method === 'Card' ? 'Card / POS Terminal' : 'Cash Collection',
              count: matchPays.length,
              amount: amt,
              share: Math.round((amt / totalAmt) * 100)
            };
          });
        };

        const getOptometristReportData = () => {
          if (customers.length === 0) return [];
          const doctorMap = {};
          customers.forEach(c => {
            const doc = c.doctor || 'Attending Optometrist';
            if (!doctorMap[doc]) {
              doctorMap[doc] = { doc: doc, exams: 0, specBookings: 0 };
            }
            doctorMap[doc].exams += 1;
            if (c.hasSpecBooking) doctorMap[doc].specBookings += 1;
          });
          return Object.values(doctorMap).map(item => ({
            ...item,
            rate: item.exams > 0 ? ((item.specBookings / item.exams) * 100).toFixed(1) : 0
          }));
        };

        const dailyData = getDailyReportData();
        const workflowData = getWorkflowReportData();
        const paymentMethodData = getPaymentMethodReportData();
        const optometristData = getOptometristReportData();

        return (
          <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider', p: 3 }}>
            <Box sx={{ mb: 3 }}>
              <Typography variant="h5" fontWeight={800} sx={{ mb: 0.5 }}>Generate Enterprise Sales & Optical Reports</Typography>
              <Typography variant="body2" color="text.secondary">Live analytics connected directly to your sales, order, payment, and patient database</Typography>
            </Box>

            <Grid container spacing={2} alignItems="center" sx={{ mb: 3 }}>
              <Grid item xs={12} md={5}>
                <TextField 
                  select 
                  label="Report Category" 
                  fullWidth 
                  size="small" 
                  value={reportCategory}
                  onChange={(e) => setReportCategory(e.target.value)}
                >
                  <MenuItem value="daily">Daily Sales Summary</MenuItem>
                  <MenuItem value="monthly">Monthly Sales Summary & GST</MenuItem>
                  <MenuItem value="customer">Customer Sales Ledger & Balances</MenuItem>
                  <MenuItem value="product">Product Category Revenue (Frames/Lenses)</MenuItem>
                  <MenuItem value="workflow">Spectacle Orders Workflow Status</MenuItem>
                  <MenuItem value="payments">Payment Collections Ledger (Cash/UPI/Card)</MenuItem>
                  <MenuItem value="optometrist">Optometrist & Clinical Performance</MenuItem>
                </TextField>
              </Grid>

              <Grid item xs={12} md={7}>
                <Stack direction="row" spacing={1.5} justifyContent={{ xs: 'flex-start', md: 'flex-end' }}>
                  <Button 
                    variant="contained" 
                    startIcon={<PrintIcon />} 
                    onClick={() => alert(`[${reportCategory.toUpperCase()}] Sales Report exported successfully as PDF!`)}
                    sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}
                  >
                    Export PDF
                  </Button>
                  <Button 
                    variant="outlined" 
                    onClick={() => alert(`[${reportCategory.toUpperCase()}] Sales Report exported successfully as Excel (.xlsx)!`)}
                    sx={{ fontWeight: 700 }}
                  >
                    Export Excel
                  </Button>
                  <Button 
                    variant="outlined" 
                    onClick={() => alert(`[${reportCategory.toUpperCase()}] Sales Report exported successfully as CSV!`)}
                    sx={{ fontWeight: 700 }}
                  >
                    Export CSV
                  </Button>
                </Stack>
              </Grid>
            </Grid>

            <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 3 }}>
              {reportCategory === 'daily' && (
                <Table size="small">
                  <TableHead sx={{ bgcolor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Report Date</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Invoices / Receipts</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Collected GST (18%)</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Gross Revenue</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Est. Net Profit (40%)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {dailyData.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No sales report data currently in database.
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            Create invoices via POS Billing or New Sale to populate daily report analytics.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      dailyData.map((row, idx) => (
                        <TableRow key={idx}>
                          <TableCell sx={{ fontWeight: 700 }}>{row.date}</TableCell>
                          <TableCell>{row.count} Transaction(s)</TableCell>
                          <TableCell>₹{row.gst.toFixed(2)}</TableCell>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>₹{row.revenue.toFixed(2)}</TableCell>
                          <TableCell sx={{ color: 'success.main', fontWeight: 700 }}>₹{row.profit.toFixed(2)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {reportCategory === 'monthly' && (
                <Table size="small">
                  <TableHead sx={{ bgcolor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Billing Month</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Invoices</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>GST Output Tax</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Sales Revenue</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Estimated Net Profit</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {dailyData.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No monthly sales report data currently in database.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      <TableRow>
                        <TableCell sx={{ fontWeight: 700 }}>Current Month ({new Date().toISOString().substring(0, 7)})</TableCell>
                        <TableCell>{orders.length + payments.length} Invoices</TableCell>
                        <TableCell>₹{(orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0) * 0.18).toFixed(2)}</TableCell>
                        <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>₹{orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0).toFixed(2)}</TableCell>
                        <TableCell sx={{ color: 'success.main', fontWeight: 700 }}>₹{(orders.reduce((sum, o) => sum + (parseFloat(o.total) || 0), 0) * 0.40).toFixed(2)}</TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}

              {reportCategory === 'customer' && (
                <Table size="small">
                  <TableHead sx={{ bgcolor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Customer Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Phone Number</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Tier Status</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Outstanding Balance</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Loyalty Reward Points</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {customers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={5} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No registered customer profiles found in database ledger.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      customers.map(c => (
                        <TableRow key={c.id}>
                          <TableCell sx={{ fontWeight: 600 }}>{c.name}</TableCell>
                          <TableCell>{c.phone}</TableCell>
                          <TableCell><Chip label={c.tier || 'Silver'} size="small" sx={{ fontWeight: 700 }} /></TableCell>
                          <TableCell sx={{ color: c.balance > 0 ? 'error.main' : 'text.primary', fontWeight: 700 }}>₹{c.balance || 0}</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>{c.points || 100} Pts</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {reportCategory === 'product' && (
                <Table size="small">
                  <TableHead sx={{ bgcolor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Product Category</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Items Available Qty</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Sales Revenue</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Collected Tax (GST)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {products.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No products registered in database for category breakdown.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      ['Frame', 'Lens', 'Contact Lens', 'Accessory'].map(cat => {
                        const catProds = products.filter(p => (p.type || '').toLowerCase().includes(cat.toLowerCase()));
                        const catRevenue = catProds.reduce((sum, p) => sum + parseFloat(p.price || 0), 0);
                        return (
                          <TableRow key={cat}>
                            <TableCell sx={{ fontWeight: 700 }}>{cat}</TableCell>
                            <TableCell>{catProds.length} Products</TableCell>
                            <TableCell sx={{ fontWeight: 700 }}>₹{catRevenue.toFixed(2)}</TableCell>
                            <TableCell>₹{(catRevenue * 0.18).toFixed(2)}</TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              )}

              {reportCategory === 'workflow' && (
                <Table size="small">
                  <TableHead sx={{ bgcolor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Workflow Stage</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Orders</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Percentage Share (%)</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Order Value</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {orders.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No spectacle sales orders in database to display workflow report.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      workflowData.map(row => (
                        <TableRow key={row.stage}>
                          <TableCell sx={{ fontWeight: 700 }}>{row.stage}</TableCell>
                          <TableCell>{row.count} Orders</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>{row.share}%</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>₹{row.value.toFixed(2)}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {reportCategory === 'payments' && (
                <Table size="small">
                  <TableHead sx={{ bgcolor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Payment Method</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Receipt Transactions</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Amount Collected</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Collection Share (%)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {payments.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No payment receipts recorded in database to display payment ledger.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      paymentMethodData.map(row => (
                        <TableRow key={row.method}>
                          <TableCell sx={{ fontWeight: 700 }}>{row.method}</TableCell>
                          <TableCell>{row.count} Receipts</TableCell>
                          <TableCell sx={{ fontWeight: 700, color: 'success.main' }}>₹{row.amount.toFixed(2)}</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>{row.share}%</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}

              {reportCategory === 'optometrist' && (
                <Table size="small">
                  <TableHead sx={{ bgcolor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Optometrist / Doctor</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Eye Exams Conducted</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Spec Bookings Converted</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Conversion Rate (%)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {optometristData.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={4} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No optometrist examination records found in database.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      optometristData.map(row => (
                        <TableRow key={row.doc}>
                          <TableCell sx={{ fontWeight: 700 }}>{row.doc}</TableCell>
                          <TableCell>{row.exams} Exams</TableCell>
                          <TableCell>{row.specBookings} Bookings</TableCell>
                          <TableCell sx={{ fontWeight: 700, color: 'success.main' }}>{row.rate}%</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              )}
            </TableContainer>
          </Card>
        );
      })()}

      {/* --- ORDER DETAILS DIALOG MODAL (WITH TABS FOR EXTENSIONS) --- */}
      <Dialog open={Boolean(selectedOrder)} onClose={() => setSelectedOrder(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>Order Details: {selectedOrder?.id}</DialogTitle>
        <DialogContent dividers sx={{ p: 0 }}>
          <Tabs value={orderDetailTab} onChange={(e, val) => setOrderDetailTab(val)} variant="scrollable" scrollButtons="auto">
            <Tab label="Details" />
            <Tab label="Prescription" />
            <Tab label="Products" />
            <Tab label="Payments" />
            <Tab label="Delivery" />
            <Tab label="Returns" />
            <Tab label="Warranty" />
          </Tabs>

          <Box sx={{ p: 3 }}>
            {orderDetailTab === 0 && (
              <Stack spacing={2}>
                <Typography variant="body2"><strong>Customer Name:</strong> {selectedOrder?.customer}</Typography>
                <Typography variant="body2"><strong>Order Date:</strong> {selectedOrder?.date}</Typography>
                <Typography variant="body2"><strong>Workflow Status:</strong> <Chip label={selectedOrder?.status} size="small" color="primary" /></Typography>
                <Typography variant="body2"><strong>Total Amount:</strong> ₹{selectedOrder?.total}</Typography>
              </Stack>
            )}
            {orderDetailTab === 1 && (
              <Stack spacing={1}>
                <Typography variant="subtitle2" fontWeight={700}>Prescription (Rx) Details</Typography>
                <Typography variant="body2">Right Eye (OD): SPH -1.25 | CYL -0.50 | AXIS 90</Typography>
                <Typography variant="body2">Left Eye (OS): SPH -1.00 | CYL -0.75 | AXIS 180</Typography>
              </Stack>
            )}
            {orderDetailTab === 2 && (
              <Stack spacing={1}>
                <Typography variant="body2"><strong>Frame Selected:</strong> {selectedOrder?.frame}</Typography>
                <Typography variant="body2"><strong>Lens Selected:</strong> {selectedOrder?.lens}</Typography>
              </Stack>
            )}
            {orderDetailTab === 3 && (
              <Stack spacing={1}>
                <Typography variant="body2"><strong>Payment Status:</strong> {selectedOrder?.payment}</Typography>
                <Typography variant="body2"><strong>Amount Paid:</strong> ₹{selectedOrder?.total}</Typography>
              </Stack>
            )}
            {orderDetailTab === 4 && (
              <Stack spacing={1}>
                <Typography variant="body2"><strong>Expected Delivery:</strong> {selectedOrder?.deliveryDate}</Typography>
                <Typography variant="body2"><strong>Courier Partner:</strong> Delhivery Express</Typography>
                <Typography variant="body2"><strong>Tracking Code:</strong> EXP-9922883</Typography>
              </Stack>
            )}
            {orderDetailTab === 5 && (
              <Stack spacing={2}>
                <Typography variant="body2" color="text.secondary">No returns initiated for this order.</Typography>
                <Button variant="outlined" color="error" size="small" onClick={() => alert('Return process initiated!')}>Initiate Exchange/Return</Button>
              </Stack>
            )}
            {orderDetailTab === 6 && (
              <Stack spacing={1}>
                <Typography variant="body2"><strong>Warranty Status:</strong> 1 Year Manufacturer Warranty Active</Typography>
                <Typography variant="body2"><strong>Expires:</strong> 2027-07-20</Typography>
              </Stack>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedOrder(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* --- CUSTOMER PROFILE DIALOG MODAL (WITH NESTED HISTORY TABS) --- */}
      <Dialog open={Boolean(selectedCustomer)} onClose={() => setSelectedCustomer(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 700 }}>Patient Profile: {selectedCustomer?.name}</DialogTitle>
        <DialogContent dividers sx={{ p: 0 }}>
          <Tabs value={customerDetailTab} onChange={(e, val) => setCustomerDetailTab(val)} variant="scrollable">
            <Tab label="Profile" />
            <Tab label="Prescription History" />
            <Tab label="Purchase History" />
          </Tabs>

          <Box sx={{ p: 3 }}>
            {customerDetailTab === 0 && (
              <Stack spacing={2}>
                <Typography variant="body2"><strong>Contact Phone:</strong> {selectedCustomer?.phone}</Typography>
                <Typography variant="body2"><strong>Loyalty Membership Tier:</strong> {selectedCustomer?.tier}</Typography>
                <Typography variant="body2"><strong>Outstanding Due Balance:</strong> ₹{selectedCustomer?.balance}</Typography>
                <Typography variant="body2"><strong>Loyalty Points Balance:</strong> {selectedCustomer?.points} Pts</Typography>
              </Stack>
            )}
            {customerDetailTab === 1 && (
              <Stack spacing={1}>
                <Typography variant="subtitle2" fontWeight={700}>Visual Testing Logs</Typography>
                <Typography variant="body2">Test Date: {selectedCustomer?.date}</Typography>
                <Typography variant="body2">Doctor: {selectedCustomer?.doctor}</Typography>
                <Typography variant="body2">Right (OD): SPH {selectedCustomer?.sphRight} | CYL {selectedCustomer?.cylRight} | AXIS {selectedCustomer?.axisRight}</Typography>
                <Typography variant="body2">Left (OS): SPH {selectedCustomer?.sphLeft} | CYL {selectedCustomer?.cylLeft} | AXIS {selectedCustomer?.axisLeft}</Typography>
              </Stack>
            )}
            {customerDetailTab === 2 && (
              <Stack spacing={1}>
                <Typography variant="body2">ORD-8947: Progressive Lenses Package - ₹11,200</Typography>
              </Stack>
            )}
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSelectedCustomer(null)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* --- QR MOCK DIALOG --- */}
      <Dialog open={qrOpen} onClose={() => setQrOpen(false)} maxWidth="xs">
        <DialogTitle sx={{ fontWeight: 700 }}>Simulate POS QR Scanner</DialogTitle>
        <DialogContent dividers sx={{ textAlign: 'center' }}>
          <Typography variant="h2" sx={{ my: 4 }}>📱</Typography>
          <Typography variant="body2" color="text.secondary">Use smartphone camera to scan customer prescription barcode</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setQrOpen(false)}>Cancel Scan</Button>
          <Button variant="contained" onClick={() => { setQrOpen(false); handleCustomerSelect('c2'); alert('Customer Prescription loaded via QR code!'); }} sx={{ backgroundColor: '#2563EB' }}>Simulate Success Scan</Button>
        </DialogActions>
      </Dialog>

      {/* --- INVOICE PRINT DIALOG MODAL --- */}
      <Dialog open={printOpen} onClose={() => setPrintOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 700, display: 'flex', gap: 1, alignItems: 'center' }}>
          <PrintIcon /> Print Optical Invoice Receipt
        </DialogTitle>
        <DialogContent dividers>
          <Box sx={{ p: 2, color: 'black', backgroundColor: 'white', borderRadius: 2, fontFamily: 'monospace' }}>
            <Box sx={{ textAlign: 'center', mb: 2 }}>
              <Typography variant="h6" sx={{ fontWeight: 900, color: 'black' }}>G OPTICALS LTD</Typography>
              <Typography variant="caption" sx={{ color: 'gray' }}>Corporate Optical Suite, New Delhi, IN</Typography>
            </Box>
            <Divider sx={{ borderColor: 'black', my: 1 }} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1, fontSize: '0.8rem' }}>
              <span>Invoice: {invoiceNumber}</span>
              <span>Date: {new Date().toLocaleDateString()}</span>
            </Box>
            <Box sx={{ fontSize: '0.8rem', mb: 1 }}>
              <span>Patient: {getCustomerName()}</span>
            </Box>
            
            <Divider sx={{ borderColor: 'black', my: 1 }} />
            <Box sx={{ fontSize: '0.75rem', mb: 1 }}>
              <strong>Rx Details:</strong><br />
              OD: SPH {rxSphOD || '0.00'} | CYL {rxCylOD || '0.00'} | AXIS {rxAxisOD || '0'}<br />
              OS: SPH {rxSphOS || '0.00'} | CYL {rxCylOS || '0.00'} | AXIS {rxAxisOS || '0'}
            </Box>
            
            <Divider sx={{ borderColor: 'black', my: 1 }} />
            <table style={{ width: '100%', fontSize: '0.8rem', textAlign: 'left', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th>Item</th>
                  <th style={{ textAlign: 'right' }}>Qty</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                </tr>
              </thead>
              <tbody>
                {cart.map((item) => (
                  <tr key={item.product.id}>
                    <td>{item.product.name}</td>
                    <td style={{ textAlign: 'right' }}>{item.qty}</td>
                    <td style={{ textAlign: 'right' }}>₹{(item.product.price * item.qty).toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <Divider sx={{ borderColor: 'black', my: 1 }} />
            <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
              <span>Subtotal:</span>
              <span>₹{subtotal.toFixed(2)}</span>
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
              <span>Taxes:</span>
              <span>₹{tax.toFixed(2)}</span>
            </Box>
            {discount > 0 && (
              <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                <span>Discount:</span>
                <span>-₹{discount}</span>
              </Box>
            )}
            <Box sx={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', fontWeight: 'bold', mt: 1 }}>
              <span>Grand Total:</span>
              <span>₹{total.toFixed(2)}</span>
            </Box>
            <Box sx={{ mt: 3, textAlign: 'center', fontSize: '0.75rem' }}>
              <span>Thank you for choosing G OPTICALS for your vision needs!</span>
            </Box>
          </Box>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPrintOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleCheckoutSubmit} sx={{ backgroundColor: '#2563EB' }}>Print Receipt</Button>
        </DialogActions>
      </Dialog>

      {/* DIALOG FOR ENTER PATIENT & SPECTACLE DETAILS */}
      <Dialog 
        open={addPatientDialogOpen} 
        onClose={() => setAddPatientDialogOpen(false)} 
        maxWidth="md" 
        fullWidth
        PaperProps={{ sx: { borderRadius: 4, overflow: 'hidden' } }}
      >
        <DialogTitle sx={{ bgcolor: '#1e293b', color: '#ffffff', py: 2.5, px: 3 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
              <Typography variant="h5">👓</Typography>
              <Box>
                <Typography variant="h6" fontWeight={800} sx={{ color: '#ffffff', lineHeight: 1.2 }}>
                  Patient & Spectacle Booking Registration
                </Typography>
                <Typography variant="caption" sx={{ color: '#94a3b8' }}>
                  Register patient profile, ophthalmic recommendations, and correction prescription (Rx)
                </Typography>
              </Box>
            </Box>
            <Chip label="Optical POS Link" color="primary" size="small" sx={{ fontWeight: 700 }} />
          </Stack>
        </DialogTitle>

        <DialogContent dividers sx={{ p: 3.5, bgcolor: '#f8fafc' }}>
          <Stack spacing={3}>
            
            {/* 1. Patient Demographics & Profile */}
            <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
              <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                👤 PATIENT DEMOGRAPHICS & PROFILE
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    label="Patient Name" 
                    fullWidth 
                    required 
                    size="small"
                    value={patientInput.name} 
                    onChange={(e) => setPatientInput({ ...patientInput, name: e.target.value })} 
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    label="Phone Number" 
                    fullWidth 
                    required 
                    size="small"
                    value={patientInput.phone} 
                    onChange={(e) => setPatientInput({ ...patientInput, phone: e.target.value })} 
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    label="Email Address" 
                    fullWidth 
                    size="small"
                    value={patientInput.email} 
                    onChange={(e) => setPatientInput({ ...patientInput, email: e.target.value })} 
                  />
                </Grid>
                <Grid item xs={6} sm={3}>
                  <TextField 
                    label="Age" 
                    fullWidth 
                    size="small"
                    value={patientInput.age} 
                    onChange={(e) => setPatientInput({ ...patientInput, age: e.target.value })} 
                  />
                </Grid>
                <Grid item xs={6} sm={3}>
                  <TextField 
                    select 
                    label="Gender" 
                    fullWidth 
                    size="small"
                    value={patientInput.gender} 
                    onChange={(e) => setPatientInput({ ...patientInput, gender: e.target.value })} 
                  >
                    <MenuItem value="Male">Male</MenuItem>
                    <MenuItem value="Female">Female</MenuItem>
                    <MenuItem value="Other">Other</MenuItem>
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    select 
                    label="Loyalty Tier" 
                    fullWidth 
                    size="small"
                    value={patientInput.tier} 
                    onChange={(e) => setPatientInput({ ...patientInput, tier: e.target.value })} 
                  >
                    <MenuItem value="Silver">Silver Tier (Basic)</MenuItem>
                    <MenuItem value="Gold">Gold Tier (1.5x Points)</MenuItem>
                    <MenuItem value="Platinum">Platinum Tier (VIP)</MenuItem>
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    label="Attending Optometrist / Doctor" 
                    fullWidth 
                    size="small"
                    value={patientInput.doctor} 
                    onChange={(e) => setPatientInput({ ...patientInput, doctor: e.target.value })} 
                  />
                </Grid>
              </Grid>
            </Card>

            {/* 2. Ophthalmic & Spectacle Recommendations */}
            <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
              <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                🕶️ OPHTHALMIC & SPECTACLE RECOMMENDATIONS
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    label="Frame Recommendation" 
                    fullWidth 
                    size="small"
                    value={patientInput.frameRec} 
                    onChange={(e) => setPatientInput({ ...patientInput, frameRec: e.target.value })} 
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    select 
                    label="Frame Style & Material" 
                    fullWidth 
                    size="small"
                    value={patientInput.frameType} 
                    onChange={(e) => setPatientInput({ ...patientInput, frameType: e.target.value })} 
                  >
                    <MenuItem value="Full-Rim Acetate">Full-Rim Acetate</MenuItem>
                    <MenuItem value="Half-Rim Metal">Half-Rim Metal</MenuItem>
                    <MenuItem value="Rimless Titanium">Rimless Titanium</MenuItem>
                    <MenuItem value="Sunglasses Frame">Sunglasses Frame</MenuItem>
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    label="Lens Recommendation" 
                    fullWidth 
                    size="small"
                    value={patientInput.lensRec} 
                    onChange={(e) => setPatientInput({ ...patientInput, lensRec: e.target.value })} 
                  />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    select 
                    label="Lens Coating & Index" 
                    fullWidth 
                    size="small"
                    value={patientInput.lensCoating} 
                    onChange={(e) => setPatientInput({ ...patientInput, lensCoating: e.target.value })} 
                  >
                    <MenuItem value="Anti-Glare Blue-Cut Protection">Anti-Glare Blue-Cut 1.56</MenuItem>
                    <MenuItem value="Photochromic Transition 1.61">Photochromic Transition 1.61</MenuItem>
                    <MenuItem value="High Index 1.67 Ultra-Thin">High Index 1.67 Ultra-Thin</MenuItem>
                    <MenuItem value="Standard Scratch-Resistant">Standard Scratch-Resistant</MenuItem>
                  </TextField>
                </Grid>
                <Grid item xs={12}>
                  <TextField 
                    label="Booking & Exam Status" 
                    fullWidth 
                    size="small"
                    value={patientInput.status} 
                    onChange={(e) => setPatientInput({ ...patientInput, status: e.target.value })} 
                  />
                </Grid>
              </Grid>
            </Card>

            {/* 3. Prescribed Optical Power (Side-by-side OD vs OS Cards) */}
            <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
              <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 2, display: 'flex', alignItems: 'center', gap: 1 }}>
                👁️ PRESCRIBED CORRECTION POWER (Rx)
              </Typography>
              <Grid container spacing={2}>
                {/* Right Eye OD */}
                <Grid item xs={12} md={6}>
                  <Paper variant="outlined" sx={{ p: 2, borderRadius: 2.5, borderLeft: '4px solid #10b981', bgcolor: '#f0fdf4' }}>
                    <Typography variant="subtitle2" fontWeight={800} color="success.dark" sx={{ mb: 1.5 }}>
                      Right Eye (OD)
                    </Typography>
                    <Grid container spacing={1.5}>
                      <Grid item xs={4}>
                        <TextField 
                          size="small" 
                          label="OD SPH" 
                          fullWidth 
                          value={patientInput.sphRight} 
                          onChange={(e) => setPatientInput({ ...patientInput, sphRight: e.target.value })} 
                        />
                      </Grid>
                      <Grid item xs={4}>
                        <TextField 
                          size="small" 
                          label="OD CYL" 
                          fullWidth 
                          value={patientInput.cylRight} 
                          onChange={(e) => setPatientInput({ ...patientInput, cylRight: e.target.value })} 
                        />
                      </Grid>
                      <Grid item xs={4}>
                        <TextField 
                          size="small" 
                          label="OD AXIS" 
                          fullWidth 
                          value={patientInput.axisRight} 
                          onChange={(e) => setPatientInput({ ...patientInput, axisRight: e.target.value })} 
                        />
                      </Grid>
                    </Grid>
                  </Paper>
                </Grid>

                {/* Left Eye OS */}
                <Grid item xs={12} md={6}>
                  <Paper variant="outlined" sx={{ p: 2, borderRadius: 2.5, borderLeft: '4px solid #2563eb', bgcolor: '#eff6ff' }}>
                    <Typography variant="subtitle2" fontWeight={800} color="primary.dark" sx={{ mb: 1.5 }}>
                      Left Eye (OS)
                    </Typography>
                    <Grid container spacing={1.5}>
                      <Grid item xs={4}>
                        <TextField 
                          size="small" 
                          label="OS SPH" 
                          fullWidth 
                          value={patientInput.sphLeft} 
                          onChange={(e) => setPatientInput({ ...patientInput, sphLeft: e.target.value })} 
                        />
                      </Grid>
                      <Grid item xs={4}>
                        <TextField 
                          size="small" 
                          label="OS CYL" 
                          fullWidth 
                          value={patientInput.cylLeft} 
                          onChange={(e) => setPatientInput({ ...patientInput, cylLeft: e.target.value })} 
                        />
                      </Grid>
                      <Grid item xs={4}>
                        <TextField 
                          size="small" 
                          label="OS AXIS" 
                          fullWidth 
                          value={patientInput.axisLeft} 
                          onChange={(e) => setPatientInput({ ...patientInput, axisLeft: e.target.value })} 
                        />
                      </Grid>
                    </Grid>
                  </Paper>
                </Grid>

                <Grid item xs={12}>
                  <TextField 
                    size="small" 
                    label="Distance PD (Pupillary Distance in mm)" 
                    fullWidth 
                    value={patientInput.distancePD} 
                    onChange={(e) => setPatientInput({ ...patientInput, distancePD: e.target.value })} 
                  />
                </Grid>
              </Grid>
            </Card>

            {/* 4. Doctor Clinical Remarks */}
            <Card variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
              <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 1.5 }}>
                📝 DOCTOR CLINICAL REMARKS & LENS INSTRUCTIONS
              </Typography>
              <TextField 
                multiline 
                rows={2} 
                fullWidth 
                placeholder="Enter doctor clinical remarks, special lens instructions, or delivery notes..." 
                value={patientInput.notes} 
                onChange={(e) => setPatientInput({ ...patientInput, notes: e.target.value })} 
              />
            </Card>

          </Stack>
        </DialogContent>

        <DialogActions sx={{ p: 2.5, bgcolor: '#ffffff', justifyContent: 'space-between' }}>
          <Button 
            variant="outlined" 
            onClick={() => setAddPatientDialogOpen(false)}
            sx={{ borderRadius: 2.5, px: 3 }}
          >
            Cancel
          </Button>
          <Button 
            variant="contained" 
            onClick={handleAddPatientSubmit} 
            sx={{ 
              backgroundColor: '#2563EB', 
              borderRadius: 2.5, 
              px: 4, 
              py: 1,
              fontWeight: 700, 
              boxShadow: '0 4px 12px rgba(37, 99, 235, 0.3)' 
            }}
          >
            Save & Display Patient Details
          </Button>
        </DialogActions>
      </Dialog>

      {/* DIALOG FOR RECORD PAYMENT COLLECTION */}
      <Dialog 
        open={recordPaymentDialogOpen} 
        onClose={() => setRecordPaymentDialogOpen(false)} 
        maxWidth="xs" 
        fullWidth
        PaperProps={{ sx: { borderRadius: 4 } }}
      >
        <DialogTitle sx={{ fontWeight: 800 }}>Record Payment Collection</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5}>
            <TextField 
              select 
              label="Select Patient Account" 
              fullWidth 
              size="small"
              value={payRecordInput.customerId} 
              onChange={(e) => {
                const selectedCust = customers.find(c => c.id === e.target.value);
                setPayRecordInput({
                  ...payRecordInput,
                  customerId: e.target.value,
                  amount: selectedCust && selectedCust.balance ? String(selectedCust.balance) : payRecordInput.amount
                });
              }}
            >
              <MenuItem value="">-- Select Patient / Walk-in Customer --</MenuItem>
              {customers.map(c => (
                <MenuItem key={c.id} value={c.id}>
                  {c.name} ({c.phone}) {c.balance > 0 ? `• Due: ₹${c.balance}` : ''}
                </MenuItem>
              ))}
            </TextField>

            <TextField 
              label="Amount Collected (₹)" 
              type="number" 
              fullWidth 
              required
              size="small"
              value={payRecordInput.amount} 
              onChange={(e) => setPayRecordInput({ ...payRecordInput, amount: e.target.value })} 
            />

            <TextField 
              select 
              label="Payment Method" 
              fullWidth 
              size="small"
              value={payRecordInput.method} 
              onChange={(e) => setPayRecordInput({ ...payRecordInput, method: e.target.value })} 
            >
              <MenuItem value="Cash">Cash</MenuItem>
              <MenuItem value="Card">Card / POS Terminal</MenuItem>
              <MenuItem value="UPI (GPay/PhonePe)">UPI (GPay / PhonePe / Paytm)</MenuItem>
              <MenuItem value="Bank Transfer">Bank Transfer (NEFT/IMPS)</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setRecordPaymentDialogOpen(false)}>Cancel</Button>
          <Button 
            variant="contained" 
            onClick={handleRecordPaymentSubmit} 
            sx={{ backgroundColor: '#2563EB', borderRadius: 2, fontWeight: 700 }}
          >
            Confirm & Save Payment
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
