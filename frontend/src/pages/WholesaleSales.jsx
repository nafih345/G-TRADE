import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Box, Card, CardContent, Typography, Grid, Button, Table, TableBody, 
  TableCell, TableContainer, TableHead, TableRow, Paper, Dialog, 
  DialogTitle, DialogContent, DialogActions, TextField, MenuItem, 
  Stack, Chip, IconButton, InputAdornment, LinearProgress, Divider, 
  Alert, Autocomplete, Tooltip, Avatar, Badge, ToggleButton, ToggleButtonGroup, Collapse
} from '@mui/material';
import {
  Storefront as WholesaleIcon,
  Search as SearchIcon,
  Delete as DeleteIcon,
  Print as PrintIcon,
  QrCodeScanner as QrCodeScannerIcon,
  Add as AddIcon,
  Remove as RemoveIcon,
  CheckCircle as CheckedIcon,
  Warning as WarningIcon,
  PauseCircle as HoldIcon,
  PlayCircle as ResumeIcon,
  WhatsApp as WhatsAppIcon,
  Email as EmailIcon,
  PictureAsPdf as PdfIcon,
  Save as SaveIcon,
  PersonAdd as PersonAddIcon,
  History as HistoryIcon,
  LocalOffer as DiscountIcon,
  Receipt as InvoiceIcon,
  CreditCard as CardIcon,
  AccountBalance as BankIcon,
  Payment as PaymentIcon,
  Refresh as RefreshIcon,
  AttachMoney as MoneyIcon,
  CleaningServices as ClearIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon
} from '@mui/icons-material';
import axios from 'axios';
import QuickDatePickerField from '../components/common/QuickDatePickerField';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';

// Mock initial demo data
const INITIAL_DEMO_PRODUCTS = [
  { id: '101', code: 'OPT-RAY-001', name: 'Ray-Ban Aviator Classic (RB3025)', brand: 'Ray-Ban', category: 'Sunglasses', availableStock: 25, wholesalePrice: 4200, gst: 18, unit: 'Pcs', barcode: '805289602057' },
  { id: '102', code: 'OPT-OAK-002', name: 'Oakley Holbrook Prizm Black', brand: 'Oakley', category: 'Sunglasses', availableStock: 14, wholesalePrice: 5100, gst: 18, unit: 'Pcs', barcode: '888392237841' },
  { id: '103', code: 'OPT-ESS-003', name: 'Essilor Crizal Sapphire 1.56 Lens', brand: 'Essilor', category: 'Optical Lens', availableStock: 50, wholesalePrice: 1850, gst: 18, unit: 'Pair', barcode: '366282001092' },
  { id: '104', code: 'OPT-GUCCI-004', name: 'Gucci Square Acetate Optical Frame', brand: 'Gucci', category: 'Frames', availableStock: 8, wholesalePrice: 12500, gst: 18, unit: 'Pcs', barcode: '889652104921' },
  { id: '105', code: 'OPT-ACU-005', name: 'Acuvue Oasys 1-Day (30 Pack)', brand: 'Johnson & Johnson', category: 'Contact Lens', availableStock: 40, wholesalePrice: 2200, gst: 18, unit: 'Box', barcode: '073390558102' }
];

const INITIAL_DEMO_CUSTOMERS = [
  { id: 'c1', code: 'WCUST-101', name: 'Metro Optical Store (Indiranagar)', contactPerson: 'Rajesh Kumar', phone: '+91 98450 11223', email: 'metro.optics@gmail.com', gstin: '29ABCDE1234F1Z5', creditLimit: 200000, outstanding: 45000, creditDays: 30, salesExec: 'Suresh V', lastPurchaseDate: '2026-07-20', totalPurchases: '₹ 12,45,000' },
  { id: 'c2', code: 'WCUST-102', name: 'Vision Care Eye Clinic', contactPerson: 'Dr. Anita Sharma', phone: '+91 99160 44556', email: 'anita@visioncare.in', gstin: '29FGHIJ5678K1Z9', creditLimit: 150000, outstanding: 120000, creditDays: 30, salesExec: 'Priya N', lastPurchaseDate: '2026-07-25', totalPurchases: '₹ 8,90,000' },
  { id: 'c3', code: 'WCUST-103', name: 'Spectrum Spectacles Wholesale Hub', contactPerson: 'Karan Patel', phone: '+91 97310 99887', email: 'karan@spectrumwholesale.com', gstin: '29KLMNO9012P1Z3', creditLimit: 500000, outstanding: 0, creditDays: 45, salesExec: 'Suresh V', lastPurchaseDate: '2026-07-28', totalPurchases: '₹ 34,10,000' }
];

export default function WholesaleSales() {
  const location = useLocation();
  const navigate = useNavigate();

  // --- REFS FOR KEYBOARD SHORTCUTS ---
  const customerSearchInputRef = useRef(null);
  const barcodeSearchInputRef = useRef(null);

  // --- CORE STATES ---
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [selectedCustomer, setSelectedCustomer] = useState(null); // Blank by default
  const [customerDetailsExpanded, setCustomerDetailsExpanded] = useState(false); // Collapsible Section 1
  const [cartItems, setCartItems] = useState([]);
  const [barcodeInput, setBarcodeInput] = useState('');
  
  // Payment Panel States
  const [payMode, setPayMode] = useState('Cash'); // Cash, UPI, Card, Bank Transfer, Credit Sale
  const [amountReceived, setAmountReceived] = useState('');
  const [additionalCharges, setAdditionalCharges] = useState('');
  const [creditDays, setCreditDays] = useState(30);
  const [refNo, setRefNo] = useState('');
  const [bankName, setBankName] = useState('');

  // Modals & Confirmation Dialogs
  const [addCustomerOpen, setAddCustomerOpen] = useState(false);
  const [newCustomer, setNewCustomer] = useState({
    code: '', name: '', contactPerson: '', phone: '', email: '', gstin: '', creditLimit: 100000, creditDays: 30, salesExec: 'Default Exec'
  });
  const [heldInvoices, setHeldInvoices] = useState([]);
  const [heldModalOpen, setHeldModalOpen] = useState(false);
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [printableInvoice, setPrintableInvoice] = useState(null);

  const [clearCartConfirmOpen, setClearCartConfirmOpen] = useState(false);
  const [creditLimitConfirmOpen, setCreditLimitConfirmOpen] = useState(false);

  // Toast Alert Notification
  const [toast, setToast] = useState({ open: false, message: '', severity: 'info' });
  const showToast = (msg, severity = 'info') => {
    setToast({ open: true, message: msg, severity });
    setTimeout(() => setToast({ open: false, message: '', severity: 'info' }), 4000);
  };

  // --- Load Master Data ---
  useEffect(() => {
    let localCusts = [];
    try {
      localCusts = JSON.parse(localStorage.getItem('optical_wholesale_customers') || '[]');
    } catch (e) {}
    if (localCusts.length === 0) {
      localCusts = INITIAL_DEMO_CUSTOMERS;
      localStorage.setItem('optical_wholesale_customers', JSON.stringify(INITIAL_DEMO_CUSTOMERS));
    }
    setCustomers(localCusts);

    let localProds = [];
    try {
      localProds = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
    } catch (e) {}
    if (localProds.length === 0) {
      localProds = INITIAL_DEMO_PRODUCTS;
      localStorage.setItem('optical_inventory_items', JSON.stringify(INITIAL_DEMO_PRODUCTS));
    }
    setProducts(localProds);

    try {
      const savedHeld = JSON.parse(localStorage.getItem('optical_wholesale_held_invoices') || '[]');
      setHeldInvoices(savedHeld);
    } catch (e) {}
  }, []);

  // --- Real-Time Invoice Calculations ---
  const summary = useMemo(() => {
    const totalItems = cartItems.length;
    const totalQty = cartItems.reduce((acc, item) => acc + (parseFloat(item.qty) || 0), 0);
    const subtotal = cartItems.reduce((acc, item) => acc + ((parseFloat(item.rate) || 0) * (parseFloat(item.qty) || 0)), 0);
    const totalDiscount = cartItems.reduce((acc, item) => {
      const lineBase = (parseFloat(item.rate) || 0) * (parseFloat(item.qty) || 0);
      return acc + (lineBase * ((parseFloat(item.discount) || 0) / 100));
    }, 0);
    const netBase = subtotal - totalDiscount;
    const totalGst = netBase * 0.18;
    const charges = parseFloat(additionalCharges) || 0;
    const rawTotal = netBase + totalGst + charges;
    const grandTotal = Math.round(rawTotal);
    const roundOff = (grandTotal - rawTotal);

    return {
      totalItems,
      totalQty,
      subtotal,
      totalDiscount,
      totalGst,
      additionalCharges: charges,
      roundOff,
      grandTotal
    };
  }, [cartItems, additionalCharges]);

  // --- DYNAMIC PAYMENT METHOD BEHAVIOR ---
  useEffect(() => {
    if (payMode === 'UPI' || payMode === 'Card') {
      setAmountReceived(summary.grandTotal ? String(summary.grandTotal) : '');
    } else if (payMode === 'Credit Sale' || payMode === 'Bank Transfer') {
      setAmountReceived('');
    }
  }, [payMode, summary.grandTotal]);

  // Payment Calculation
  const paymentCalc = useMemo(() => {
    const received = parseFloat(amountReceived) || (payMode === 'UPI' || payMode === 'Card' ? summary.grandTotal : 0);
    if (payMode === 'Credit Sale' || payMode === 'Bank Transfer') {
      return { dueAmount: summary.grandTotal, balanceAmount: 0 };
    }
    const dueAmount = Math.max(0, summary.grandTotal - received);
    const balanceAmount = Math.max(0, received - summary.grandTotal);
    return { dueAmount, balanceAmount };
  }, [payMode, amountReceived, summary.grandTotal]);

  // Outstanding Balance warning color logic
  const outstandingColor = useMemo(() => {
    if (!selectedCustomer || !selectedCustomer.creditLimit) return '#475569';
    const out = parseFloat(selectedCustomer.outstanding || 0);
    const limit = parseFloat(selectedCustomer.creditLimit || 1);
    const ratio = out / limit;
    if (ratio >= 0.9) return '#dc2626'; // High/Critical - Red
    if (ratio >= 0.6) return '#d97706'; // Moderate - Amber
    return '#059669'; // Low - Green
  }, [selectedCustomer]);

  // Credit Limit Warning Check
  const isCreditExceeded = useMemo(() => {
    if (!selectedCustomer || !selectedCustomer.creditLimit) return false;
    const currOutstanding = parseFloat(selectedCustomer.outstanding || 0);
    const limit = parseFloat(selectedCustomer.creditLimit || 0);
    const newTotalOut = payMode === 'Credit Sale' ? (currOutstanding + summary.grandTotal) : currOutstanding;
    return limit > 0 && newTotalOut > limit;
  }, [selectedCustomer, summary.grandTotal, payMode]);

  // --- KEYBOARD SHORTCUTS SCOPED TO THIS SCREEN (F2, F3, F9, ESC) ---
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Don't trigger if open dialogs exist
      if (addCustomerOpen || heldModalOpen || printModalOpen || creditLimitConfirmOpen || clearCartConfirmOpen) return;

      if (e.key === 'F2') {
        e.preventDefault();
        customerSearchInputRef.current?.focus();
      } else if (e.key === 'F3') {
        e.preventDefault();
        barcodeSearchInputRef.current?.focus();
      } else if (e.key === 'F9') {
        e.preventDefault();
        if (selectedCustomer && cartItems.length > 0) {
          handleAttemptCompleteSale();
        } else {
          showToast('Cannot submit: Select a customer and add products to cart.', 'warning');
        }
      } else if (e.key === 'Escape') {
        if (cartItems.length > 0) {
          e.preventDefault();
          setClearCartConfirmOpen(true);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [addCustomerOpen, heldModalOpen, printModalOpen, creditLimitConfirmOpen, clearCartConfirmOpen, selectedCustomer, cartItems]);

  // --- Handlers ---
  const handleAddProductToCart = (prod) => {
    if (!prod) return;
    const avail = parseFloat(prod.availableStock ?? prod.stock ?? 0);
    if (avail <= 0) {
      showToast(`Out of Stock: ${prod.name} has 0 available inventory.`, 'error');
      return;
    }

    setCartItems(prev => {
      const existingIdx = prev.findIndex(item => item.id === prod.id || item.code === prod.code);
      if (existingIdx !== -1) {
        const next = [...prev];
        next[existingIdx].qty += 1;
        return next;
      }
      return [
        ...prev,
        {
          id: prod.id || prod.code,
          barcode: prod.barcode || prod.code,
          code: prod.code || prod.sku,
          name: prod.name,
          brand: prod.brand || 'Generic',
          category: prod.category || 'Optical',
          unit: prod.unit || 'Pcs',
          availableStock: avail,
          qty: 1,
          rate: parseFloat(prod.wholesalePrice || prod.price || 0),
          discount: 0,
          gst: parseFloat(prod.gst || 18)
        }
      ];
    });
  };

  const handleBarcodeScan = (e) => {
    if (e.key === 'Enter' && barcodeInput.trim()) {
      e.preventDefault();
      const code = barcodeInput.trim().toLowerCase();
      const matched = products.find(p => 
        (p.barcode && p.barcode.toLowerCase() === code) ||
        (p.code && p.code.toLowerCase() === code)
      );
      if (matched) {
        handleAddProductToCart(matched);
        setBarcodeInput('');
        showToast(`Added: ${matched.name}`, 'success');
      } else {
        showToast(`No product found matching barcode "${barcodeInput}"`, 'error');
      }
    }
  };

  const handleUpdateItemQty = (index, deltaOrVal, isDirectValue = false) => {
    setCartItems(prev => {
      const next = [...prev];
      const target = next[index];
      let newQty = isDirectValue ? parseInt(deltaOrVal) || 1 : target.qty + deltaOrVal;
      if (newQty < 1) newQty = 1;
      next[index].qty = newQty;
      return next;
    });
  };

  const handleUpdateItemField = (index, field, value) => {
    setCartItems(prev => {
      const next = [...prev];
      next[index][field] = value;
      return next;
    });
  };

  const handleRemoveItem = (index) => {
    setCartItems(prev => prev.filter((_, i) => i !== index));
  };

  const handleClearCart = () => {
    setCartItems([]);
    setAmountReceived('');
    setAdditionalCharges('');
    setRefNo('');
    setBankName('');
    showToast('POS Cart cleared.', 'info');
  };

  const handleHoldInvoice = () => {
    if (cartItems.length === 0) {
      showToast('Cannot hold an empty invoice cart.', 'warning');
      return;
    }
    const heldItem = {
      id: `HOLD-${Date.now()}`,
      customer: selectedCustomer,
      cartItems,
      additionalCharges,
      heldAt: new Date().toLocaleTimeString(),
      totalAmount: summary.grandTotal
    };
    const updatedHeld = [...heldInvoices, heldItem];
    setHeldInvoices(updatedHeld);
    localStorage.setItem('optical_wholesale_held_invoices', JSON.stringify(updatedHeld));
    setCartItems([]);
    setAmountReceived('');
    showToast(`Invoice held successfully (${heldItem.id})`, 'success');
  };

  const handleResumeHeldInvoice = (heldItem) => {
    setSelectedCustomer(heldItem.customer);
    setCartItems(heldItem.cartItems);
    setAdditionalCharges(heldItem.additionalCharges || '');

    const updatedHeld = heldInvoices.filter(h => h.id !== heldItem.id);
    setHeldInvoices(updatedHeld);
    localStorage.setItem('optical_wholesale_held_invoices', JSON.stringify(updatedHeld));
    setHeldModalOpen(false);
    showToast(`Resumed held invoice ${heldItem.id}`, 'info');
  };

  const handleSaveNewCustomer = () => {
    if (!newCustomer.name || !newCustomer.phone) {
      showToast('Please provide Business Name and Phone number.', 'error');
      return;
    }
    const createdCust = {
      id: `c_${Date.now()}`,
      code: newCustomer.code || `WCUST-${Math.floor(100 + Math.random() * 900)}`,
      name: newCustomer.name,
      contactPerson: newCustomer.contactPerson || newCustomer.name,
      phone: newCustomer.phone,
      email: newCustomer.email || '',
      gstin: newCustomer.gstin || '',
      creditLimit: parseFloat(newCustomer.creditLimit) || 100000,
      outstanding: 0,
      creditDays: parseInt(newCustomer.creditDays) || 30,
      salesExec: newCustomer.salesExec || 'Default Exec',
      lastPurchaseDate: new Date().toISOString().split('T')[0],
      totalPurchases: '₹ 0'
    };

    const updated = [createdCust, ...customers];
    setCustomers(updated);
    localStorage.setItem('optical_wholesale_customers', JSON.stringify(updated));
    setSelectedCustomer(createdCust);
    setAddCustomerOpen(false);
    setNewCustomer({ code: '', name: '', contactPerson: '', phone: '', email: '', gstin: '', creditLimit: 100000, creditDays: 30, salesExec: 'Default Exec' });
    showToast(`Wholesale Customer registered: ${createdCust.name}`, 'success');
  };

  // Trigger Completion or Open Confirmation Dialog if Credit Exceeded
  function handleAttemptCompleteSale() {
    if (!selectedCustomer) {
      showToast('Please select a wholesale customer first.', 'error');
      return;
    }
    if (cartItems.length === 0) {
      showToast('POS cart is empty. Add products to complete sale.', 'error');
      return;
    }

    if (isCreditExceeded) {
      setCreditLimitConfirmOpen(true);
    } else {
      executeCompleteSale();
    }
  }

  // Complete Sale Execution
  async function executeCompleteSale() {
    setCreditLimitConfirmOpen(false);

    const invoiceNo = `WINV-${Math.floor(100000 + Math.random() * 900000)}`;
    const invoiceDate = new Date().toISOString().split('T')[0];

    const completedInvoice = {
      id: invoiceNo,
      invoiceNo,
      date: invoiceDate,
      customer: selectedCustomer,
      items: cartItems,
      summary,
      payMode,
      refNo,
      bankName,
      amountReceived: parseFloat(amountReceived) || (payMode === 'Credit Sale' ? 0 : summary.grandTotal),
      dueAmount: paymentCalc.dueAmount,
      creditDays,
      status: 'Paid'
    };

    // 1. Decrement Inventory Stock
    const updatedProducts = products.map(p => {
      const matchInCart = cartItems.find(item => item.id === p.id || item.code === p.code);
      if (matchInCart) {
        const newStock = Math.max(0, (parseFloat(p.availableStock ?? p.stock ?? 0) - matchInCart.qty));
        return { ...p, availableStock: newStock, stock: newStock };
      }
      return p;
    });
    setProducts(updatedProducts);
    localStorage.setItem('optical_inventory_items', JSON.stringify(updatedProducts));

    // 2. Update Customer Ledger
    const updatedCustomers = customers.map(c => {
      if (c.id === selectedCustomer.id || c.code === selectedCustomer.code) {
        return {
          ...c,
          outstanding: (parseFloat(c.outstanding || 0) + paymentCalc.dueAmount),
          lastPurchaseDate: invoiceDate
        };
      }
      return c;
    });
    setCustomers(updatedCustomers);
    localStorage.setItem('optical_wholesale_customers', JSON.stringify(updatedCustomers));
    const currentUpdatedCust = updatedCustomers.find(c => c.id === selectedCustomer.id || c.code === selectedCustomer.code);
    if (currentUpdatedCust) setSelectedCustomer(currentUpdatedCust);

    // 3. Post Financial Journal Entry
    try {
      const existingJournals = JSON.parse(localStorage.getItem('optical_journal_entries') || '[]');
      const journalNo = `JV-W-${Math.floor(1000 + Math.random() * 9000)}`;
      const newJournal = {
        id: journalNo,
        voucherNo: journalNo,
        date: invoiceDate,
        voucherType: 'JOURNAL',
        narration: `Wholesale POS Invoice #${invoiceNo} - ${selectedCustomer.name} (${payMode})`,
        entries: [
          {
            accountCode: payMode === 'Credit Sale' ? '1100' : '1001',
            accountName: payMode === 'Credit Sale' ? `Accounts Receivable (${selectedCustomer.name})` : `Cash/Bank Account (${payMode})`,
            debit: summary.grandTotal,
            credit: 0
          },
          {
            accountCode: '4001',
            accountName: 'Wholesale Sales Income',
            debit: 0,
            credit: summary.subtotal - summary.totalDiscount
          },
          {
            accountCode: '2100',
            accountName: 'Output GST Payable (18%)',
            debit: 0,
            credit: summary.totalGst
          }
        ]
      };
      localStorage.setItem('optical_journal_entries', JSON.stringify([newJournal, ...existingJournals]));
    } catch (e) {}

    // 4. Save Invoice & Open Print
    try {
      const savedInvoices = JSON.parse(localStorage.getItem('optical_wholesale_invoices') || '[]');
      localStorage.setItem('optical_wholesale_invoices', JSON.stringify([completedInvoice, ...savedInvoices]));
    } catch (e) {}

    setPrintableInvoice(completedInvoice);
    setPrintModalOpen(true);
    setCartItems([]);
    setAmountReceived('');
    setAdditionalCharges('');
    setRefNo('');
    setBankName('');
    showToast(`Wholesale Sale Completed! Invoice #${invoiceNo} posted.`, 'success');
  };

  return (
    <Box sx={{ p: 2.5, bgcolor: '#f8fafc', minHeight: '100vh' }}>
      {/* HEADER TOOLBAR */}
      <Paper
        elevation={0}
        variant="outlined"
        sx={{
          p: 2,
          px: 3,
          mb: 2.5,
          borderRadius: 4,
          bgcolor: '#ffffff',
          borderColor: '#cbd5e1',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
          display: 'flex',
          justify: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 2
        }}
      >
        <Stack direction="row" spacing={2} alignItems="center">
          <Avatar sx={{ bgcolor: '#4f46e5', width: 44, height: 44 }}>
            <WholesaleIcon sx={{ color: '#ffffff' }} />
          </Avatar>
          <Box>
            <Typography variant="h6" fontWeight={850} color="#0f172a">
              Wholesale POS Billing
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              High-Speed B2B Customer Sales & Live Inventory Billing Terminal
            </Typography>
          </Box>
        </Stack>

        <Stack direction="row" spacing={1.5} alignItems="center">
          {heldInvoices.length > 0 && (
            <Button
              variant="outlined"
              color="warning"
              size="small"
              startIcon={<ResumeIcon />}
              onClick={() => setHeldModalOpen(true)}
              sx={{ fontWeight: 800, borderRadius: 3 }}
            >
              Held Invoices ({heldInvoices.length})
            </Button>
          )}

          <Button
            variant="outlined"
            size="small"
            color="primary"
            startIcon={<PersonAddIcon />}
            onClick={() => setAddCustomerOpen(true)}
            sx={{ fontWeight: 800, borderRadius: 3 }}
          >
            + Add Wholesale Customer
          </Button>

          <Button
            variant="outlined"
            size="small"
            color="error"
            startIcon={<ClearIcon />}
            disabled={cartItems.length === 0}
            onClick={() => setClearCartConfirmOpen(true)}
            endIcon={<Chip label="Esc" size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 800, bgcolor: '#fee2e2', color: '#dc2626' }} />}
            sx={{ fontWeight: 800, borderRadius: 3 }}
          >
            Clear Cart
          </Button>
        </Stack>
      </Paper>

      {/* TOAST ALERT */}
      {toast.open && (
        <Alert severity={toast.severity} sx={{ mb: 2, borderRadius: 3, fontWeight: 700 }}>
          {toast.message}
        </Alert>
      )}

      {/* MAIN SINGLE-PAGE POS LAYOUT */}
      <Grid container spacing={2.5}>
        {/* LEFT COLUMN: SECTION 1 (CUSTOMER), SECTION 2 (PRODUCTS & CART), & SECTION 4 (PAYMENT PANEL) (8 COLUMNS) */}
        <Grid item xs={12} lg={8}>
          <Stack spacing={2.5}>
            {/* SECTION 1 — WHOLESALE CUSTOMER INFORMATION (WITH COLLAPSIBLE SUMMARY LINE) */}
            <Card variant="outlined" sx={{ p: 2.5, borderRadius: 4, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: selectedCustomer && !customerDetailsExpanded ? 0 : 2 }}>
                <Stack direction="row" spacing={1.5} alignItems="center">
                  <Typography variant="subtitle1" fontWeight={850} color="#0f172a">
                    Section 1: Customer Information
                  </Typography>
                  <Chip label="F2" size="small" sx={{ height: 20, fontSize: '0.68rem', fontWeight: 800, bgcolor: '#e2e8f0', color: '#475569' }} />
                </Stack>

                <Stack direction="row" spacing={1} alignItems="center">
                  {selectedCustomer && (
                    <Chip
                      label={`Code: ${selectedCustomer.code}`}
                      size="small"
                      color="primary"
                      variant="outlined"
                      sx={{ fontWeight: 700 }}
                    />
                  )}
                  {selectedCustomer && (
                    <Button
                      size="small"
                      variant="text"
                      color="primary"
                      onClick={() => setCustomerDetailsExpanded(prev => !prev)}
                      endIcon={customerDetailsExpanded ? <ExpandLessIcon /> : <ExpandMoreIcon />}
                      sx={{ fontWeight: 800, textTransform: 'none' }}
                    >
                      {customerDetailsExpanded ? 'Collapse' : '▾ Details'}
                    </Button>
                  )}
                </Stack>
              </Stack>

              {/* COMPACT SINGLE SUMMARY LINE WHEN COLLAPSED */}
              {selectedCustomer && !customerDetailsExpanded ? (
                <Paper variant="outlined" sx={{ p: 1.5, px: 2, borderRadius: 3, bgcolor: '#f8fafc', borderColor: '#cbd5e1' }}>
                  <Grid container spacing={1.5} alignItems="center">
                    <Grid item xs={12} sm={4}>
                      <Typography variant="subtitle2" fontWeight={850} color="primary.main">
                        {selectedCustomer.name}
                      </Typography>
                    </Grid>
                    <Grid item xs={6} sm={2.5}>
                      <Typography variant="caption" color="text.secondary" display="block">GSTIN:</Typography>
                      <Typography variant="body2" fontWeight={700}>{selectedCustomer.gstin || 'N/A'}</Typography>
                    </Grid>
                    <Grid item xs={6} sm={2.5}>
                      <Typography variant="caption" color="text.secondary" display="block">Credit Limit:</Typography>
                      <Typography variant="body2" fontWeight={700}>₹ {parseFloat(selectedCustomer.creditLimit || 0).toLocaleString('en-IN')}</Typography>
                    </Grid>
                    <Grid item xs={6} sm={2.5}>
                      <Typography variant="caption" color="text.secondary" display="block">Terms:</Typography>
                      <Typography variant="body2" fontWeight={700}>{selectedCustomer.creditDays || 30} Days Credit</Typography>
                    </Grid>
                  </Grid>
                </Paper>
              ) : (
                /* FULL EXPANDED FIELD VIEW */
                <Grid container spacing={2}>
                  <Grid item xs={12} md={6}>
                    <Autocomplete
                      options={customers}
                      getOptionLabel={(option) => `${option.name} (${option.code}) • ${option.contactPerson || ''}`}
                      value={selectedCustomer}
                      onChange={(e, newVal) => setSelectedCustomer(newVal)}
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          inputRef={customerSearchInputRef}
                          size="small"
                          label="Search Wholesale Customer * (Press F2)"
                          placeholder="Search & select customer by name or code..."
                          InputLabelProps={{ shrink: true }}
                          InputProps={{
                            ...params.InputProps,
                            startAdornment: (
                              <>
                                <SearchIcon color="action" sx={{ mr: 1, fontSize: 18 }} />
                                {params.InputProps.startAdornment}
                              </>
                            )
                          }}
                        />
                      )}
                    />
                  </Grid>

                  <Grid item xs={6} md={3}>
                    <TextField 
                      fullWidth 
                      size="small" 
                      label="Contact Number" 
                      placeholder="-" 
                      value={selectedCustomer?.phone || ''} 
                      InputLabelProps={{ shrink: true }}
                      InputProps={{ readOnly: true }} 
                      sx={{ bgcolor: '#f8fafc' }} 
                    />
                  </Grid>
                  <Grid item xs={6} md={3}>
                    <TextField 
                      fullWidth 
                      size="small" 
                      label="GSTIN Number" 
                      placeholder="-" 
                      value={selectedCustomer?.gstin || ''} 
                      InputLabelProps={{ shrink: true }}
                      InputProps={{ readOnly: true }} 
                      sx={{ bgcolor: '#f8fafc' }} 
                    />
                  </Grid>
                  <Grid item xs={6} md={3}>
                    <TextField 
                      fullWidth 
                      size="small" 
                      label="Credit Limit" 
                      placeholder="-" 
                      value={selectedCustomer ? `₹ ${parseFloat(selectedCustomer.creditLimit || 0).toLocaleString('en-IN')}` : ''} 
                      InputLabelProps={{ shrink: true }}
                      InputProps={{ readOnly: true }} 
                      sx={{ bgcolor: '#f8fafc' }} 
                    />
                  </Grid>

                  {/* OUTSTANDING BALANCE FIELD WITH DYNAMIC GREEN/AMBER/RED WARNING COLORING */}
                  <Grid item xs={6} md={3}>
                    <TextField 
                      fullWidth 
                      size="small" 
                      label="Outstanding Balance" 
                      placeholder="-" 
                      value={selectedCustomer ? `₹ ${parseFloat(selectedCustomer.outstanding || 0).toLocaleString('en-IN')}` : ''} 
                      InputLabelProps={{ shrink: true }}
                      InputProps={{ readOnly: true }} 
                      sx={{ 
                        bgcolor: '#f8fafc', 
                        '& .MuiInputBase-input': { 
                          color: outstandingColor, 
                          fontWeight: selectedCustomer ? 850 : 400 
                        } 
                      }} 
                    />
                  </Grid>
                  <Grid item xs={6} md={3}>
                    <TextField 
                      fullWidth 
                      size="small" 
                      label="Payment Terms" 
                      placeholder="-" 
                      value={selectedCustomer ? `${selectedCustomer.creditDays || 30} Days Credit` : ''} 
                      InputLabelProps={{ shrink: true }}
                      InputProps={{ readOnly: true }} 
                      sx={{ bgcolor: '#f8fafc' }} 
                    />
                  </Grid>
                  <Grid item xs={6} md={3}>
                    <TextField 
                      fullWidth 
                      size="small" 
                      label="Sales Executive" 
                      placeholder="-" 
                      value={selectedCustomer?.salesExec || ''} 
                      InputLabelProps={{ shrink: true }}
                      InputProps={{ readOnly: true }} 
                      sx={{ bgcolor: '#f8fafc' }} 
                    />
                  </Grid>
                </Grid>
              )}

              {/* CREDIT LIMIT EXCEEDED WARNING ALERT */}
              {isCreditExceeded && (
                <Alert severity="error" icon={<WarningIcon />} sx={{ mt: 2, borderRadius: 3, fontWeight: 700 }}>
                  Credit Limit Warning: Outstanding (₹{parseFloat(selectedCustomer.outstanding).toLocaleString('en-IN')}) + New Bill (₹{summary.grandTotal.toLocaleString('en-IN')}) exceeds Credit Limit of ₹{parseFloat(selectedCustomer.creditLimit).toLocaleString('en-IN')}!
                </Alert>
              )}
            </Card>

            {/* SECTION 2 — PRODUCT SELECTION & POS CART */}
            <Card variant="outlined" sx={{ borderRadius: 4, bgcolor: '#ffffff', borderColor: '#e2e8f0', overflow: 'hidden' }}>
              <Box sx={{ p: 2.5, borderBottom: '1px solid #e2e8f0', bgcolor: '#f8fafc' }}>
                <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 2 }}>
                  <Typography variant="subtitle1" fontWeight={850} color="#0f172a">
                    Section 2: Live Inventory Product Selection
                  </Typography>
                  <Chip label="F3" size="small" sx={{ height: 20, fontSize: '0.68rem', fontWeight: 800, bgcolor: '#e2e8f0', color: '#475569' }} />
                </Stack>

                <Grid container spacing={2}>
                  {/* BARCODE SCANNER INPUT */}
                  <Grid item xs={12} md={4}>
                    <TextField
                      fullWidth
                      size="small"
                      inputRef={barcodeSearchInputRef}
                      placeholder="Scan Barcode + Enter (F3)"
                      value={barcodeInput}
                      onChange={(e) => setBarcodeInput(e.target.value)}
                      onKeyDown={handleBarcodeScan}
                      InputProps={{
                        startAdornment: <QrCodeScannerIcon color="primary" sx={{ mr: 1, fontSize: 20 }} />
                      }}
                    />
                  </Grid>

                  {/* AUTOCOMPLETE PRODUCT SEARCH */}
                  <Grid item xs={12} md={8}>
                    <Autocomplete
                      options={products}
                      getOptionLabel={(p) => `${p.name} (${p.code || p.barcode}) • Stock: ${p.availableStock ?? p.stock ?? 0} ${p.unit || 'Pcs'} • ₹${p.wholesalePrice || p.price}`}
                      onChange={(e, selectedProd) => {
                        if (selectedProd) handleAddProductToCart(selectedProd);
                      }}
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          size="small"
                          label="Search Live Inventory (Barcode, Name, Code, Brand)..."
                          InputLabelProps={{ shrink: true }}
                          InputProps={{
                            ...params.InputProps,
                            startAdornment: (
                              <>
                                <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} />
                                {params.InputProps.startAdornment}
                              </>
                            )
                          }}
                        />
                      )}
                      renderOption={(props, p) => {
                        const stock = parseFloat(p.availableStock ?? p.stock ?? 0);
                        return (
                          <li {...props} key={p.id || p.code}>
                            <Box sx={{ width: '100%' }}>
                              <Stack direction="row" justifyContent="space-between" alignItems="center">
                                <Typography variant="body2" fontWeight={700}>{p.name}</Typography>
                                <Chip
                                  label={stock > 5 ? `Stock: ${stock} ${p.unit || 'Pcs'}` : stock > 0 ? `Low: ${stock}` : `Out of Stock`}
                                  color={stock > 5 ? 'success' : stock > 0 ? 'warning' : 'error'}
                                  size="small"
                                  sx={{ fontWeight: 700, height: 20, fontSize: '0.7rem' }}
                                />
                              </Stack>
                              <Typography variant="caption" color="text.secondary">
                                Code: {p.code} • Brand: {p.brand} • Category: {p.category} • ₹{(p.wholesalePrice || p.price || 0).toFixed(2)}
                              </Typography>
                            </Box>
                          </li>
                        );
                      }}
                    />
                  </Grid>
                </Grid>
              </Box>

              {/* POS CART PRODUCTS DATA TABLE WITH STOCK OVER-LIMIT RED HIGHLIGHT */}
              <TableContainer component={Paper} elevation={0} sx={{ overflowX: 'auto', maxHeight: 420 }}>
                <Table stickyHeader sx={{ minWidth: 900 }}>
                  <TableHead sx={{ '& th': { bgcolor: '#f1f5f9', fontWeight: 800, py: 1.5, whiteSpace: 'nowrap' } }}>
                    <TableRow>
                      <TableCell sx={{ minWidth: 130 }}>Barcode / Code</TableCell>
                      <TableCell sx={{ minWidth: 220 }}>Product Description</TableCell>
                      <TableCell sx={{ minWidth: 100 }}>Live Stock</TableCell>
                      <TableCell sx={{ minWidth: 135, textAlign: 'center' }}>Quantity</TableCell>
                      <TableCell sx={{ minWidth: 100, textAlign: 'right' }}>Rate (₹)</TableCell>
                      <TableCell sx={{ minWidth: 80, textAlign: 'center' }}>Disc %</TableCell>
                      <TableCell sx={{ minWidth: 75, textAlign: 'center' }}>GST %</TableCell>
                      <TableCell sx={{ minWidth: 120, textAlign: 'right' }}>Total (₹)</TableCell>
                      <TableCell sx={{ minWidth: 60 }} align="center">Action</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {cartItems.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={9} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={600}>
                            No products added to POS cart yet. Scan a barcode (F3) or search live inventory above.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      cartItems.map((item, idx) => {
                        const isStockExceeded = item.qty > item.availableStock;
                        const lineBase = (parseFloat(item.rate) || 0) * (parseFloat(item.qty) || 0);
                        const lineDisc = lineBase * ((parseFloat(item.discount) || 0) / 100);
                        const lineGst = (lineBase - lineDisc) * 0.18;
                        const lineTotal = lineBase - lineDisc + lineGst;

                        return (
                          <TableRow key={item.id || idx} hover sx={{ bgcolor: isStockExceeded ? '#fef2f2' : 'inherit', '& td': { py: 1.2, verticalAlign: 'middle', whiteSpace: 'nowrap' } }}>
                            <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{item.code}</TableCell>
                            <TableCell sx={{ whiteSpace: 'normal' }}>
                              <Typography variant="body2" fontWeight={700}>{item.name}</Typography>
                              <Typography variant="caption" color="text.secondary">{item.brand} • {item.category}</Typography>
                            </TableCell>
                            <TableCell>
                              <Chip
                                label={`🟢 ${item.availableStock} Free`}
                                color={isStockExceeded ? 'error' : 'success'}
                                size="small"
                                sx={{ fontWeight: 700, height: 22, fontSize: '0.72rem' }}
                              />
                            </TableCell>
                            <TableCell align="center">
                              <Box>
                                <Stack direction="row" alignItems="center" justifyContent="center" spacing={0.5}>
                                  <IconButton size="small" onClick={() => handleUpdateItemQty(idx, -1)}>
                                    <RemoveIcon fontSize="small" />
                                  </IconButton>
                                  <TextField
                                    size="small"
                                    type="number"
                                    error={isStockExceeded}
                                    value={item.qty}
                                    onChange={(e) => handleUpdateItemQty(idx, e.target.value, true)}
                                    sx={{ 
                                      width: 60, 
                                      '& .MuiInputBase-input': { 
                                        py: 0.5, px: 0.5, textAlign: 'center', fontWeight: 800,
                                        color: isStockExceeded ? '#dc2626' : 'inherit'
                                      } 
                                    }}
                                  />
                                  <IconButton size="small" onClick={() => handleUpdateItemQty(idx, 1)}>
                                    <AddIcon fontSize="small" />
                                  </IconButton>
                                </Stack>
                                {/* INLINE STOCK WARNING BELOW FIELD */}
                                {isStockExceeded && (
                                  <Typography variant="caption" color="error" fontWeight={700} sx={{ display: 'block', fontSize: '0.65rem', mt: 0.3 }}>
                                    Only {item.availableStock} in stock
                                  </Typography>
                                )}
                              </Box>
                            </TableCell>
                            <TableCell align="right">
                              <TextField
                                size="small"
                                type="number"
                                value={item.rate}
                                onChange={(e) => handleUpdateItemField(idx, 'rate', parseFloat(e.target.value) || 0)}
                                sx={{ width: 85, '& .MuiInputBase-input': { py: 0.5, px: 0.5, textAlign: 'right', fontWeight: 600 } }}
                              />
                            </TableCell>
                            <TableCell align="center">
                              <TextField
                                size="small"
                                type="number"
                                value={item.discount}
                                onChange={(e) => handleUpdateItemField(idx, 'discount', parseFloat(e.target.value) || 0)}
                                sx={{ width: 60, '& .MuiInputBase-input': { py: 0.5, px: 0.5, textAlign: 'center' } }}
                              />
                            </TableCell>
                            <TableCell align="center">
                              <Typography variant="body2" fontWeight={600}>{item.gst}%</Typography>
                            </TableCell>
                            <TableCell align="right" sx={{ fontWeight: 850, color: 'primary.main' }}>
                              ₹{lineTotal.toFixed(2)}
                            </TableCell>
                            <TableCell align="center">
                              <IconButton size="small" color="error" onClick={() => handleRemoveItem(idx)}>
                                <DeleteIcon fontSize="small" />
                              </IconButton>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>

            {/* SECTION 4 — DYNAMIC PAYMENT & COMPLETION PANEL */}
            <Card variant="outlined" sx={{ p: 2.5, borderRadius: 4, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Typography variant="subtitle1" fontWeight={850} color="#0f172a" sx={{ mb: 2 }}>
                Section 4: Payment & Completion Panel
              </Typography>

              {/* PAYMENT MODE HORIZONTAL SELECTOR ROW */}
              <Box sx={{ mb: 2.5 }}>
                <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                  Select Payment Method *
                </Typography>
                <Grid container spacing={1.5}>
                  {['Cash', 'UPI', 'Card', 'Bank Transfer', 'Credit Sale'].map((mode) => (
                    <Grid item xs={6} sm={2.4} key={mode}>
                      <Button
                        fullWidth
                        size="medium"
                        variant={payMode === mode ? 'contained' : 'outlined'}
                        onClick={() => setPayMode(mode)}
                        sx={{
                          py: 1,
                          fontWeight: 800,
                          fontSize: '0.825rem',
                          borderRadius: 3,
                          backgroundColor: payMode === mode ? '#4f46e5' : 'transparent'
                        }}
                      >
                        {mode}
                      </Button>
                    </Grid>
                  ))}
                </Grid>
              </Box>

              {/* DYNAMIC PAYMENT METHOD FIELDS */}
              <Grid container spacing={2.5} sx={{ mb: 2.5 }}>
                {/* 1. CASH MODE */}
                {payMode === 'Cash' && (
                  <>
                    <Grid item xs={12} md={6}>
                      <TextField
                        fullWidth
                        size="small"
                        type="number"
                        label="Amount Received (₹)"
                        placeholder={`Total: ₹${summary.grandTotal}`}
                        value={amountReceived}
                        onChange={(e) => setAmountReceived(e.target.value)}
                      />
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <Box sx={{ p: 1.5, px: 2, bgcolor: '#f8fafc', borderRadius: 3, border: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <Box>
                          <Typography variant="caption" color="text.secondary" fontWeight={600} display="block">Due Amount</Typography>
                          <Typography variant="subtitle1" fontWeight={850} color={paymentCalc.dueAmount > 0 ? 'error.main' : 'success.main'}>
                            ₹ {paymentCalc.dueAmount.toLocaleString('en-IN')}
                          </Typography>
                        </Box>
                        <Box textAlign="right">
                          <Typography variant="caption" color="text.secondary" fontWeight={600} display="block">Change Return</Typography>
                          <Typography variant="subtitle1" fontWeight={850} color="primary.main">
                            ₹ {paymentCalc.balanceAmount.toLocaleString('en-IN')}
                          </Typography>
                        </Box>
                      </Box>
                    </Grid>
                  </>
                )}

                {/* 2. UPI / CARD MODE */}
                {(payMode === 'UPI' || payMode === 'Card') && (
                  <>
                    <Grid item xs={12} md={6}>
                      <TextField
                        fullWidth
                        size="small"
                        label="Amount Received (Auto-Filled ₹)"
                        value={summary.grandTotal}
                        InputProps={{ readOnly: true }}
                        sx={{ bgcolor: '#f8fafc' }}
                      />
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <TextField
                        fullWidth
                        size="small"
                        label="Reference / Transaction ID"
                        placeholder="e.g. UPI Ref / Approval Code"
                        value={refNo}
                        onChange={(e) => setRefNo(e.target.value)}
                      />
                    </Grid>
                  </>
                )}

                {/* 3. BANK TRANSFER MODE */}
                {payMode === 'Bank Transfer' && (
                  <>
                    <Grid item xs={12} md={6}>
                      <TextField
                        fullWidth
                        size="small"
                        label="Reference No / Cheque No"
                        placeholder="e.g. NEFT/RTGS Ref No"
                        value={refNo}
                        onChange={(e) => setRefNo(e.target.value)}
                      />
                    </Grid>
                    <Grid item xs={12} md={6}>
                      <TextField
                        fullWidth
                        size="small"
                        label="Bank Name / Account"
                        placeholder="e.g. HDFC Bank Main Account"
                        value={bankName}
                        onChange={(e) => setBankName(e.target.value)}
                      />
                    </Grid>
                  </>
                )}

                {/* 4. CREDIT SALE MODE */}
                {payMode === 'Credit Sale' && (
                  <>
                    <Grid item xs={12} md={6}>
                      <TextField
                        select
                        fullWidth
                        size="small"
                        label="Credit Duration Days"
                        value={creditDays}
                        onChange={(e) => setCreditDays(e.target.value)}
                      >
                        <MenuItem value={15}>15 Days Credit</MenuItem>
                        <MenuItem value={30}>30 Days Credit (Standard)</MenuItem>
                        <MenuItem value={45}>45 Days Credit</MenuItem>
                        <MenuItem value={60}>60 Days Credit</MenuItem>
                      </TextField>
                    </Grid>

                    <Grid item xs={12} md={6}>
                      <Box sx={{ p: 1.5, px: 2, bgcolor: '#eff6ff', borderRadius: 3, border: '1px solid #bfdbfe' }}>
                        <Typography variant="caption" color="primary.main" fontWeight={700} display="block">
                          Credit Sale Due Amount: ₹ {summary.grandTotal.toLocaleString('en-IN')}
                        </Typography>
                        {selectedCustomer && (
                          <Typography variant="caption" color="text.secondary" fontWeight={600} display="block" sx={{ mt: 0.5 }}>
                            Updated Outstanding: ₹ {(parseFloat(selectedCustomer.outstanding || 0) + summary.grandTotal).toLocaleString('en-IN')}
                          </Typography>
                        )}
                      </Box>
                    </Grid>
                  </>
                )}
              </Grid>

              {/* ACTION BUTTONS ROW WITH SHORTCUT HINTS */}
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <Button
                    variant="contained"
                    size="large"
                    fullWidth
                    disabled={Boolean(!selectedCustomer || cartItems.length === 0)}
                    onClick={handleAttemptCompleteSale}
                    startIcon={<CheckedIcon />}
                    endIcon={<Chip label="F9" size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 800, bgcolor: 'rgba(255,255,255,0.25)', color: '#ffffff' }} />}
                    sx={{ backgroundColor: '#10b981', fontWeight: 850, py: 1.4, fontSize: '0.925rem', borderRadius: 3 }}
                  >
                    Complete Sale & Print Invoice
                  </Button>
                </Grid>
                <Grid item xs={6} sm={3}>
                  <Button
                    fullWidth
                    size="large"
                    variant="outlined"
                    color="warning"
                    disabled={cartItems.length === 0}
                    onClick={handleHoldInvoice}
                    startIcon={<HoldIcon />}
                    sx={{ fontWeight: 700, py: 1.4, borderRadius: 3 }}
                  >
                    Hold Invoice
                  </Button>
                </Grid>
                <Grid item xs={6} sm={3}>
                  <Button
                    fullWidth
                    size="large"
                    variant="outlined"
                    disabled={cartItems.length === 0}
                    onClick={() => showToast("Draft saved.", "info")}
                    startIcon={<SaveIcon />}
                    sx={{ fontWeight: 700, py: 1.4, borderRadius: 3 }}
                  >
                    Save Draft
                  </Button>
                </Grid>
              </Grid>

              {/* INLINE CREDIT LIMIT WARNING MESSAGE */}
              {isCreditExceeded && (
                <Alert severity="warning" variant="outlined" sx={{ mt: 2, borderRadius: 3, fontWeight: 700, py: 0.5, fontSize: '0.825rem' }}>
                  ⚠️ Warning: Completing this Credit Sale will push customer's total outstanding above Credit Limit (₹{selectedCustomer.creditLimit}). Confirmation required on submit.
                </Alert>
              )}
            </Card>
          </Stack>
        </Grid>

        {/* RIGHT COLUMN: SECTION 3 (LIVE INVOICE SUMMARY STICKY PANEL) (4 COLUMNS) */}
        <Grid item xs={12} lg={4}>
          <Stack spacing={2.5} sx={{ position: 'sticky', top: 90, zIndex: 10 }}>
            {/* SECTION 3 — LIVE INVOICE SUMMARY PANEL */}
            <Card variant="outlined" sx={{ p: 2.5, borderRadius: 4, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Typography variant="subtitle1" fontWeight={850} color="#0f172a" sx={{ mb: 2 }}>
                Section 3: Live Invoice Summary
              </Typography>

              <Stack spacing={1.8}>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" color="text.secondary">Total Line Items</Typography>
                  <Typography variant="body2" fontWeight={700}>{summary.totalItems}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" color="text.secondary">Total Quantity Units</Typography>
                  <Typography variant="body2" fontWeight={700}>{summary.totalQty} Units</Typography>
                </Stack>
                <Divider />
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" color="text.secondary">Subtotal (Base Price)</Typography>
                  <Typography variant="body2" fontWeight={700}>₹ {summary.subtotal.toFixed(2)}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" color="text.secondary">Total Discount</Typography>
                  <Typography variant="body2" fontWeight={700} color="success.main">- ₹ {summary.totalDiscount.toFixed(2)}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" color="text.secondary">GST Tax (18%)</Typography>
                  <Typography variant="body2" fontWeight={700}>+ ₹ {summary.totalGst.toFixed(2)}</Typography>
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" color="text.secondary">Freight / Additional Charges</Typography>
                  <TextField
                    size="small"
                    type="number"
                    placeholder="0"
                    value={additionalCharges}
                    onChange={(e) => setAdditionalCharges(e.target.value)}
                    sx={{ width: 90, '& .MuiInputBase-input': { py: 0.4, px: 0.8, textAlign: 'right', fontWeight: 700 } }}
                  />
                </Stack>
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" color="text.secondary">Round Off</Typography>
                  <Typography variant="body2" fontWeight={600}>{summary.roundOff >= 0 ? `+ ₹${summary.roundOff.toFixed(2)}` : `- ₹${Math.abs(summary.roundOff).toFixed(2)}`}</Typography>
                </Stack>
                <Divider />
                <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ pt: 0.5 }}>
                  <Typography variant="subtitle1" fontWeight={850}>Grand Total</Typography>
                  <Typography variant="h4" fontWeight={900} color="primary.main">
                    ₹ {summary.grandTotal.toLocaleString('en-IN')}
                  </Typography>
                </Stack>
              </Stack>
            </Card>
          </Stack>
        </Grid>
      </Grid>

      {/* DIALOG: + ADD WHOLESALE CUSTOMER */}
      <Dialog open={addCustomerOpen} onClose={() => setAddCustomerOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 850 }}>Register New Wholesale B2B Customer</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField fullWidth size="small" label="Customer Code" placeholder="Auto-generated e.g. WCUST-104" value={newCustomer.code} onChange={(e) => setNewCustomer({ ...newCustomer, code: e.target.value })} />
            <TextField fullWidth size="small" label="Business / Company Name *" value={newCustomer.name} onChange={(e) => setNewCustomer({ ...newCustomer, name: e.target.value })} />
            <TextField fullWidth size="small" label="Contact Person Name" value={newCustomer.contactPerson} onChange={(e) => setNewCustomer({ ...newCustomer, contactPerson: e.target.value })} />
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField fullWidth size="small" label="Mobile Number *" value={newCustomer.phone} onChange={(e) => setNewCustomer({ ...newCustomer, phone: e.target.value })} />
              </Grid>
              <Grid item xs={6}>
                <TextField fullWidth size="small" label="Email Address" value={newCustomer.email} onChange={(e) => setNewCustomer({ ...newCustomer, email: e.target.value })} />
              </Grid>
            </Grid>
            <TextField fullWidth size="small" label="GSTIN Number" value={newCustomer.gstin} onChange={(e) => setNewCustomer({ ...newCustomer, gstin: e.target.value })} />
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField fullWidth size="small" type="number" label="Credit Limit (INR)" value={newCustomer.creditLimit} onChange={(e) => setNewCustomer({ ...newCustomer, creditLimit: e.target.value })} />
              </Grid>
              <Grid item xs={6}>
                <TextField fullWidth size="small" type="number" label="Credit Days" value={newCustomer.creditDays} onChange={(e) => setNewCustomer({ ...newCustomer, creditDays: e.target.value })} />
              </Grid>
            </Grid>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setAddCustomerOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveNewCustomer} sx={{ backgroundColor: '#4f46e5', fontWeight: 800 }}>
            Register Customer
          </Button>
        </DialogActions>
      </Dialog>

      {/* DIALOG: HELD INVOICES RESUME */}
      <Dialog open={heldModalOpen} onClose={() => setHeldModalOpen(false)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 850 }}>Resume Held Wholesale Invoices</DialogTitle>
        <DialogContent dividers>
          {heldInvoices.length === 0 ? (
            <Typography variant="body2" color="text.secondary" align="center" sx={{ py: 3 }}>
              No held invoices available.
            </Typography>
          ) : (
            <Stack spacing={1.5}>
              {heldInvoices.map((held) => (
                <Paper key={held.id} variant="outlined" sx={{ p: 2, borderRadius: 3, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Box>
                    <Typography variant="subtitle2" fontWeight={800}>{held.customer?.name || 'Customer'}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      Held at {held.heldAt} • {held.cartItems.length} Items • Total: ₹{held.totalAmount}
                    </Typography>
                  </Box>
                  <Button variant="contained" size="small" onClick={() => handleResumeHeldInvoice(held)} sx={{ fontWeight: 700 }}>
                    Resume
                  </Button>
                </Paper>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setHeldModalOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* CONFIRM ACTION DIALOG: CLEAR CART (ESC KEY) */}
      <ConfirmActionDialog
        open={clearCartConfirmOpen}
        title="Clear Wholesale POS Cart?"
        message="Are you sure you want to clear all products from the current POS cart? (Triggered by Esc key)"
        type="warning"
        confirmText="Yes, Clear Cart"
        onClose={() => setClearCartConfirmOpen(false)}
        onConfirm={() => {
          setClearCartConfirmOpen(false);
          handleClearCart();
        }}
      />

      {/* CONFIRM ACTION DIALOG: OVERRIDE CREDIT LIMIT */}
      <ConfirmActionDialog
        open={creditLimitConfirmOpen}
        title="Credit Limit Override Confirmation"
        message={`Completing this Credit Sale for ${selectedCustomer?.name} will push their total outstanding balance (₹${(parseFloat(selectedCustomer?.outstanding || 0) + summary.grandTotal).toLocaleString('en-IN')}) over their assigned Credit Limit (₹${parseFloat(selectedCustomer?.creditLimit || 0).toLocaleString('en-IN')}). Do you wish to override and complete this sale?`}
        type="warning"
        confirmText="Override & Complete Sale"
        onClose={() => setCreditLimitConfirmOpen(false)}
        onConfirm={executeCompleteSale}
      />

      {/* DIALOG: PRINT GST TAX INVOICE */}
      <Dialog open={printModalOpen} onClose={() => setPrintModalOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 850, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Wholesale Tax Invoice #{printableInvoice?.invoiceNo}</span>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" startIcon={<WhatsAppIcon />} onClick={() => alert("Shared via WhatsApp")}>WhatsApp</Button>
            <Button size="small" variant="outlined" startIcon={<EmailIcon />} onClick={() => alert("Sent via Email")}>Email</Button>
            <Button size="small" variant="contained" startIcon={<PrintIcon />} onClick={() => window.print()}>Print</Button>
          </Stack>
        </DialogTitle>
        <DialogContent dividers>
          {printableInvoice && (
            <Box id="printable-invoice-area" sx={{ p: 2 }}>
              {/* INVOICE SHOP HEADER */}
              <Stack direction="row" justifyContent="space-between" sx={{ borderBottom: '2px solid #0f172a', pb: 2, mb: 2 }}>
                <Box>
                  <Typography variant="h5" fontWeight={900} color="primary.main">G OPTICALS WHOLESALE</Typography>
                  <Typography variant="caption" display="block">123 Vision Hub, Commercial Street, Bengaluru - 560001</Typography>
                  <Typography variant="caption" display="block">GSTIN: 29AAAAA0000A1Z5 • Contact: +91 80 2233 4455</Typography>
                </Box>
                <Box textAlign="right">
                  <Typography variant="h6" fontWeight={850}>TAX INVOICE</Typography>
                  <Typography variant="caption" display="block">Invoice No: {printableInvoice.invoiceNo}</Typography>
                  <Typography variant="caption" display="block">Date: {printableInvoice.date}</Typography>
                </Box>
              </Stack>

              {/* CUSTOMER DETAILS */}
              <Paper variant="outlined" sx={{ p: 2, mb: 2, bgcolor: '#f8fafc' }}>
                <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">Billed To (Wholesale Buyer):</Typography>
                <Typography variant="subtitle1" fontWeight={850}>{printableInvoice.customer?.name}</Typography>
                <Typography variant="caption" display="block">Contact: {printableInvoice.customer?.contactPerson} ({printableInvoice.customer?.phone})</Typography>
                <Typography variant="caption" display="block">GSTIN: {printableInvoice.customer?.gstin || 'N/A'}</Typography>
                <Typography variant="caption" display="block">Payment Mode: {printableInvoice.payMode} {printableInvoice.refNo ? `(Ref: ${printableInvoice.refNo})` : ''}</Typography>
              </Paper>

              {/* ITEMS TABLE */}
              <TableContainer component={Paper} variant="outlined" sx={{ mb: 2 }}>
                <Table size="small">
                  <TableHead sx={{ bgcolor: '#f1f5f9' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 800 }}>#</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Item & Brand</TableCell>
                      <TableCell sx={{ fontWeight: 800 }} align="center">Qty</TableCell>
                      <TableCell sx={{ fontWeight: 800 }} align="right">Rate (₹)</TableCell>
                      <TableCell sx={{ fontWeight: 800 }} align="center">Disc %</TableCell>
                      <TableCell sx={{ fontWeight: 800 }} align="right">Total (₹)</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {printableInvoice.items.map((item, i) => {
                      const lineBase = (parseFloat(item.rate) || 0) * (parseFloat(item.qty) || 0);
                      const lineDisc = lineBase * ((parseFloat(item.discount) || 0) / 100);
                      const lineTotal = (lineBase - lineDisc) * 1.18;
                      return (
                        <TableRow key={i}>
                          <TableCell>{i + 1}</TableCell>
                          <TableCell>
                            <Typography variant="body2" fontWeight={700}>{item.name}</Typography>
                            <Typography variant="caption" color="text.secondary">{item.code} • {item.brand}</Typography>
                          </TableCell>
                          <TableCell align="center">{item.qty}</TableCell>
                          <TableCell align="right">₹{item.rate.toFixed(2)}</TableCell>
                          <TableCell align="center">{item.discount}%</TableCell>
                          <TableCell align="right" sx={{ fontWeight: 700 }}>₹{lineTotal.toFixed(2)}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>

              {/* TOTALS SUMMARY */}
              <Grid container spacing={2}>
                <Grid item xs={6}>
                  <Typography variant="caption" fontWeight={700} display="block">Terms & Conditions:</Typography>
                  <Typography variant="caption" color="text.secondary" display="block">
                    1. Goods once sold will not be taken back.<br />
                    2. Payment due within {printableInvoice.creditDays} days.<br />
                    3. Subject to Bengaluru Jurisdiction.
                  </Typography>
                </Grid>
                <Grid item xs={6}>
                  <Stack spacing={0.8} align="right">
                    <Typography variant="caption">Subtotal: ₹{printableInvoice.summary.subtotal.toFixed(2)}</Typography>
                    <Typography variant="caption">Discount: -₹{printableInvoice.summary.totalDiscount.toFixed(2)}</Typography>
                    <Typography variant="caption">GST (18%): +₹{printableInvoice.summary.totalGst.toFixed(2)}</Typography>
                    <Divider />
                    <Typography variant="subtitle1" fontWeight={900} color="primary.main">Grand Total: ₹{printableInvoice.summary.grandTotal.toLocaleString('en-IN')}</Typography>
                  </Stack>
                </Grid>
              </Grid>
            </Box>
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPrintModalOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
