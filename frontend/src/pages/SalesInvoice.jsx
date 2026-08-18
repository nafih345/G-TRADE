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

import SalesDashboardView from '../components/sales/SalesDashboardView';
import NewSaleWizard from '../components/sales/NewSaleWizard';
import PosBillingView from '../components/sales/PosBillingView';
import OrdersManagerView from '../components/sales/OrdersManagerView';
import PaymentsManagerView from '../components/sales/PaymentsManagerView';
import PrintInvoiceModal from '../components/sales/PrintInvoiceModal';

// --- MASTER DATABASE ARRAYS (Starts blank until entered/fetched from DB) ---
const initialProducts = [];
const initialCustomers = [];
const initialOrders = [];
const initialPayments = [];

export default function SalesInvoice() {
  const location = useLocation();
  const navigate = useNavigate();

  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printableInvoice, setPrintableInvoice] = useState(null);
  const getTabFromPath = (path = '') => {
    if (path.includes('dashboard')) return 'dashboard';
    if (path.includes('new')) return 'new-sale';
    if (path.includes('pos')) return 'pos-billing';
    if (path.includes('orders')) return 'orders';
    if (path.includes('customers')) return 'customers';
    if (path.includes('payments')) return 'payments';
    if (path.includes('reports')) return 'reports';
    return 'dashboard';
  };

  const [activeTab, setActiveTab] = useState(() => getTabFromPath(location.pathname || window.location.hash || ''));
  
  // Tab-state routing logic
  useEffect(() => {
    setActiveTab(getTabFromPath(location.pathname));
  }, [location.pathname]);

  // Master states
  const [products, setProducts] = useState(initialProducts);
  const [customers, setCustomers] = useState(initialCustomers);
  const [orders, setOrders] = useState(initialOrders);
  const [payments, setPayments] = useState(initialPayments);

  // Fetch optical services, inventory products & sales database from API / localStorage
  useEffect(() => {
    const fetchOpticalDbData = async () => {
      let localInvoices = [];
      let localPayments = [];
      let localProds = [];
      try {
        localInvoices = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
        localPayments = JSON.parse(localStorage.getItem('optical_payments') || '[]');
        localProds = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
      } catch (e) {}

      if (localProds.length > 0) {
        setProducts(localProds.map(p => ({
          id: String(p.id || p.code || p.barcode),
          name: p.name,
          brand: p.brand || 'Generic',
          type: p.category || 'Frame',
          price: parseFloat(p.sellingPrice || p.price || 0),
          taxRate: parseFloat(p.tax || 18),
          stock: p.stock || 0,
          barcode: p.barcode || '',
          image: (p.category || '').toLowerCase().includes('lens') ? '🔍' : '👓'
        })));
      }

      // DRF pagination wraps list responses as {count, next, previous, results: [...]} rather
      // than returning a bare array, so unwrapping is required before any .length/.map call.
      const unwrap = (res) => (res && res.data && res.data.results) || (res && res.data) || [];

      let apiInvoices = [];
      let apiPayments = [];
      try {
        const [custRes, eyeExamRes, prodRes, invRes, payRes] = await Promise.all([
          axios.get('/api/sales/customers/').catch(() => null),
          axios.get('/api/sales/eye-examinations/').catch(() => null),
          axios.get('/api/products/products/').catch(() => null),
          axios.get('/api/sales/invoices/').catch(() => null),
          axios.get('/api/sales/payments/').catch(() => null)
        ]);
        const custList = unwrap(custRes);
        const eyeExams = unwrap(eyeExamRes);
        const prodList = unwrap(prodRes);
        const invList = unwrap(invRes);
        const payList = unwrap(payRes);

        if (prodList.length > 0) {
          const apiFormatted = prodList.map(p => ({
            id: String(p.id || p.product_id),
            name: p.name || p.product_name,
            brand: p.brand || 'Generic',
            type: p.category_name || (p.type || 'Frame'),
            price: parseFloat(p.unit_price || p.price || 0),
            taxRate: parseFloat(p.tax_rate || 18),
            stock: p.stock || 0,
            barcode: p.barcode || '',
            image: (p.category_name || p.type || '').toLowerCase().includes('lens') ? '🔍' : '👓'
          }));
          setProducts(prev => {
            const map = new Map();
            [...prev, ...apiFormatted].forEach(item => map.set(item.id || item.name, item));
            return Array.from(map.values());
          });
        }

        if (invList.length > 0) {
          apiInvoices = invList.map(inv => ({
            // `id` is the real backend UUID (the true identity, needed so status-update PATCHes
            // and dedup-by-id against locally-created orders both work); invoiceNumber is what
            // the Orders table actually displays.
            id: inv.id,
            invoiceNumber: inv.invoice_number || `INV-${inv.id}`,
            date: inv.created_at ? inv.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
            customer: inv.customer_name || 'Walk-in Customer',
            total: parseFloat(inv.total_amount || 0),
            paidAmount: parseFloat(inv.paid_amount || inv.total_amount || 0),
            payment: parseFloat(inv.paid_amount || 0) >= parseFloat(inv.total_amount || 0) ? 'Paid' : 'Partial',
            status: inv.fulfillment_status || 'Order Received',
            paymentMethod: inv.payment_method || 'Cash',
            frame: inv.frame_name || 'Prescribed Frame',
            lens: inv.lens_name || 'Prescribed Lens'
          }));
        }

        if (custList.length > 0) {
          const mergedCusts = custList.map(c => {
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
        }

        if (payList.length > 0) {
          apiPayments = payList.map(p => ({
            id: p.id,
            customer: p.customer_name || 'Walk-in Patient',
            date: p.payment_date || (p.created_at ? p.created_at.split('T')[0] : new Date().toISOString().split('T')[0]),
            amount: parseFloat(p.amount || 0),
            method: p.method || 'Cash',
            status: p.status || 'Success',
            receiptNo: p.receipt_no
          }));
        }
      } catch (err) {
        console.warn('Sales DB fetch error:', err);
      }

      // Combine API & local storage orders/payments into database state
      const allOrders = [...apiInvoices, ...localInvoices];
      const uniqueOrders = Array.from(new Map(allOrders.map(o => [o.id, o])).values());
      setOrders(uniqueOrders);

      const allPayments = [...apiPayments, ...localPayments];
      const uniquePayments = Array.from(new Map(allPayments.map(p => [p.id, p])).values());
      setPayments(uniquePayments);
    };
    fetchOpticalDbData();

    window.addEventListener('optical_stock_updated', fetchOpticalDbData);
    return () => window.removeEventListener('optical_stock_updated', fetchOpticalDbData);
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

  const handleAddPatientSubmit = async () => {
    if (!patientInput.name || !patientInput.phone) {
      alert("Please enter at least Patient Name and Phone Number.");
      return;
    }
    // Previously generated a fake local id and only did setCustomers([...]) — a patient
    // registered from the Sales module's Customers tab never actually reached the database, so
    // it was invisible to Appointments/OpticalServices/PatientHistory and vanished on refresh.
    // Reuse a real Customer if one already matches this phone; otherwise create one.
    let newId = `c-${Date.now()}`;
    const existingMatch = customers.find(c => c.phone && c.phone === patientInput.phone);
    if (existingMatch) {
      newId = existingMatch.id;
    } else {
      try {
        const res = await axios.post('/api/sales/customers/', {
          name: patientInput.name,
          phone: patientInput.phone,
          email: patientInput.email || '',
          age: patientInput.age || '',
          gender: patientInput.gender || 'Male'
        });
        newId = res.data.id;
      } catch (e) {
        alert('Could not save the new patient to the database. Please try again.');
        return;
      }
    }
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

  const handleRecordPaymentSubmit = async () => {
    if (!payRecordInput.amount || parseFloat(payRecordInput.amount) <= 0) {
      alert("Please enter a valid payment amount.");
      return;
    }
    const cust = customers.find(c => c.id === payRecordInput.customerId);
    const custName = cust ? cust.name : 'Walk-in Patient';
    const payAmt = parseFloat(payRecordInput.amount);
    const today = new Date().toISOString().split('T')[0];

    const newPay = {
      id: `PAY-${Math.floor(1000 + Math.random() * 9000)}`,
      customer: custName,
      date: today,
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

    try {
      const res = await axios.post('/api/sales/payments/', {
        customer: cust ? cust.id : null,
        customer_name: custName,
        amount: payAmt,
        method: payRecordInput.method || 'Cash',
        payment_date: today,
        status: 'Completed'
      });
      // Swap the optimistic local-id row for the real backend one so it keys correctly on
      // the next fetchOpticalDbData dedup pass.
      setPayments(prev => prev.map(p => p.id === newPay.id ? { ...p, id: res.data.id, receiptNo: res.data.receipt_no } : p));
    } catch (err) {
      console.warn('Failed to save payment to backend:', err);
    }
  };

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* 1. SALES DASHBOARD */}
      {activeTab === 'dashboard' && (
        <SalesDashboardView
          orders={orders}
          payments={payments}
          customers={customers}
          onNavigateToNewSale={() => { setActiveTab('new-sale'); navigate('/sales/new'); }}
          onNavigateToPos={() => { setActiveTab('pos-billing'); navigate('/sales/pos'); }}
          onOpenRecordPayment={() => setRecordPaymentDialogOpen(true)}
          onViewOrderDetails={(ord) => { setSelectedOrder(ord); setOrderDetailTab(0); }}
          onPrintInvoice={(inv) => { setPrintableInvoice(inv); setPrintModalOpen(true); }}
        />
      )}

      {/* 2. NEW SALE WIZARD */}
      {activeTab === 'new-sale' && (
        <NewSaleWizard
          customers={customers}
          products={products}
          onNavigateToEyeTest={() => navigate('/optical/eyetest')}
          onCheckoutComplete={(completedOrder) => {
            const newOrd = {
              id: completedOrder.id || `INV-${Math.floor(1000 + Math.random() * 9000)}`,
              invoiceNumber: completedOrder.invoiceNumber || completedOrder.id,
              customer: completedOrder.customerName || completedOrder.customer || 'CASH CUSTOMER',
              phone: completedOrder.customerPhone || '+91 98470 12345',
              date: completedOrder.date || new Date().toISOString().split('T')[0],
              total: parseFloat(completedOrder.netTotal || completedOrder.total || 0),
              paidAmount: parseFloat(completedOrder.netTotal || completedOrder.total || 0) - (parseFloat(completedOrder.balanceDue) || 0),
              payment: (parseFloat(completedOrder.balanceDue) || 0) === 0 ? 'Paid' : 'Partial',
              status: 'Ready for Collection',
              frame: completedOrder.items?.find(i => i.category === 'FRAME')?.item || 'Prescribed Frame',
              lens: completedOrder.items?.find(i => i.category === 'LENS')?.item || 'Prescribed Lens',
              paymentMethod: completedOrder.paymentMode || 'Cash'
            };
            setOrders(prev => [newOrd, ...prev]);
            // The print modal needs the FULL order (real per-item brand/tax/disc, diagnosis,
            // patient age/gender/address, payment method breakdown, ...) — newOrd above is only
            // the trimmed summary the Orders table displays, so merge rather than replace.
            setPrintableInvoice({ ...completedOrder, ...newOrd });
            setPrintModalOpen(true);
          }}
        />
      )}


      {/* 3. POS BILLING */}
      {activeTab === 'pos-billing' && (
        <PosBillingView
          products={products}
          customers={customers}
          onOpenRecordPayment={() => setRecordPaymentDialogOpen(true)}
          onCheckoutComplete={(completedOrder) => {
            const newOrd = {
              id: completedOrder.id || `INV-${Math.floor(1000 + Math.random() * 9000)}`,
              invoiceNumber: completedOrder.invoiceNumber || completedOrder.id,
              customer: completedOrder.customer,
              phone: completedOrder.phone || '+91 98470 12345',
              date: completedOrder.date || new Date().toISOString().split('T')[0],
              total: completedOrder.total,
              paidAmount: completedOrder.total,
              payment: 'Paid',
              status: 'Ready for Collection',
              frame: completedOrder.frame,
              lens: completedOrder.lens,
              paymentMethod: completedOrder.paymentMode || 'Cash'
            };
            setOrders(prev => [newOrd, ...prev]);
            try {
              const existing = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
              localStorage.setItem('optical_sales_invoices', JSON.stringify([newOrd, ...existing]));
            } catch(e) {}
            // Previously just navigated away with no print step at all — "Quick Pay & Print
            // Receipt" didn't actually print anything. Now opens the same print modal (with its
            // A4/A5/Thermal choice) the New Sale wizard uses, with the full item/tax/payment
            // breakdown PosBillingView now sends through.
            setPrintableInvoice({ ...completedOrder, ...newOrd });
            setPrintModalOpen(true);
          }}
        />
      )}

      {/* 4. ORDERS */}
      {activeTab === 'orders' && (
        <OrdersManagerView
          orders={orders}
          onNavigateToNewSale={() => { setActiveTab('new-sale'); navigate('/sales/new'); }}
          onNavigateToEyeTest={() => navigate('/optical/eyetest')}
          onOpenRecordPayment={() => setRecordPaymentDialogOpen(true)}
          onPrintInvoice={(inv) => { setPrintableInvoice(inv); setPrintModalOpen(true); }}
          onUpdateOrderStatus={async (orderId, newStatus) => {
            const updated = orders.map(o => o.id === orderId ? { ...o, status: newStatus } : o);
            setOrders(updated);
            try {
              localStorage.setItem('optical_sales_invoices', JSON.stringify(updated));
            } catch(e) {}
            // fulfillment_status (not `status`, which is choice-restricted to payment states on
            // the backend) tracks this lab-workflow stage; only real backend Invoices can be
            // PATCHed — orders still on a locally-generated id (e.g. backend write failed at
            // checkout) just keep the local-only update above.
            if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orderId)) {
              try {
                await axios.patch(`/api/sales/invoices/${orderId}/`, { fulfillment_status: newStatus });
              } catch (err) {
                console.warn('Failed to sync order status to backend:', err);
              }
            }
          }}
        />
      )}

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
      {activeTab === 'payments' && (
        <PaymentsManagerView
          payments={payments}
          customers={customers}
          orders={orders}
          onRecordPaymentSubmit={async (newPayment, custId, payAmt) => {
            setPayments(prev => [newPayment, ...prev]);
            if (custId) {
              setCustomers(customers.map(c => c.id === custId ? { ...c, balance: Math.max(0, (c.balance || 0) - payAmt) } : c));
            }
            const isBackendId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
            try {
              const res = await axios.post('/api/sales/payments/', {
                customer: isBackendId(custId) ? custId : null,
                customer_name: newPayment.customerName,
                amount: payAmt,
                method: newPayment.method,
                payment_date: newPayment.date || new Date().toISOString().split('T')[0],
                status: 'Completed',
                notes: newPayment.notes
              });
              // Swap the optimistic local-id row for the real backend one so it keys correctly
              // on the next fetchOpticalDbData dedup pass.
              setPayments(prev => prev.map(p => p.id === newPayment.id ? { ...p, id: res.data.id, receiptNo: res.data.receipt_no } : p));
            } catch (err) {
              console.warn('Failed to save payment to backend:', err);
            }
          }}
        />
      )}

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

      {/* 🖨️ PRINT INVOICE MODAL */}
      <PrintInvoiceModal 
        open={printModalOpen} 
        onClose={() => setPrintModalOpen(false)} 
        invoice={printableInvoice} 
      />
    </Box>
  );
}
