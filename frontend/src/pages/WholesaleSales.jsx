import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Box, Card, CardContent, Typography, Grid, Button, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TableFooter, Paper, Dialog,
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
  ExpandLess as ExpandLessIcon,
  Inventory2 as InventoryIcon,
  ShoppingCartCheckout as CartIcon,
  TrendingUp as TrendingUpIcon
} from '@mui/icons-material';
import axios from 'axios';
import QuickDatePickerField from '../components/common/QuickDatePickerField';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';
import BillPreview from '../billing/BillPreview';
import { printBill } from '../billing/printBill';

// Mock initial demo data
const INITIAL_DEMO_PRODUCTS = [
  { id: '101', code: 'OPT-RAY-001', name: 'Ray-Ban Aviator Classic (RB3025)', brand: 'Ray-Ban', category: 'Sunglasses', modelNo: 'RB3025', color: 'Gold / Green', size: '58-14-135', power: '—', availableStock: 25, wholesalePrice: 4200, gst: 18, unit: 'Pcs', barcode: '805289602057' },
  { id: '102', code: 'OPT-OAK-002', name: 'Oakley Holbrook Prizm Black', brand: 'Oakley', category: 'Sunglasses', modelNo: 'OO9102', color: 'Matte Black', size: '55-18-137', power: '—', availableStock: 14, wholesalePrice: 5100, gst: 18, unit: 'Pcs', barcode: '888392237841' },
  { id: '103', code: 'OPT-ESS-003', name: 'Essilor Crizal Sapphire 1.56 Lens', brand: 'Essilor', category: 'Optical Lens', modelNo: 'CRZ-1.56', color: 'Clear', size: '—', power: '-2.00 / -0.75', availableStock: 50, wholesalePrice: 1850, gst: 18, unit: 'Pair', barcode: '366282001092' },
  { id: '104', code: 'OPT-GUCCI-004', name: 'Gucci Square Acetate Optical Frame', brand: 'Gucci', category: 'Frames', modelNo: 'GG0516O', color: 'Havana', size: '52-20-145', power: '—', availableStock: 8, wholesalePrice: 12500, gst: 18, unit: 'Pcs', barcode: '889652104921' },
  { id: '105', code: 'OPT-ACU-005', name: 'Acuvue Oasys 1-Day (30 Pack)', brand: 'Johnson & Johnson', category: 'Contact Lens', modelNo: 'OASYS-1D', color: 'Clear', size: '8.5 BC', power: '-3.00', availableStock: 40, wholesalePrice: 2200, gst: 18, unit: 'Box', barcode: '073390558102' }
];

const INITIAL_DEMO_CUSTOMERS = [
  { id: 'c1', code: 'WCUST-101', name: 'Metro Optical Store (Indiranagar)', contactPerson: 'Rajesh Kumar', phone: '+91 98450 11223', email: 'metro.optics@gmail.com', gstin: '29ABCDE1234F1Z5', creditLimit: 200000, outstanding: 45000, creditDays: 30, salesExec: 'Suresh V', lastPurchaseDate: '2026-07-20', totalPurchases: '₹ 12,45,000' },
  { id: 'c2', code: 'WCUST-102', name: 'Vision Care Eye Clinic', contactPerson: 'Dr. Anita Sharma', phone: '+91 99160 44556', email: 'anita@visioncare.in', gstin: '29FGHIJ5678K1Z9', creditLimit: 150000, outstanding: 120000, creditDays: 30, salesExec: 'Priya N', lastPurchaseDate: '2026-07-25', totalPurchases: '₹ 8,90,000' },
  { id: 'c3', code: 'WCUST-103', name: 'Spectrum Spectacles Wholesale Hub', contactPerson: 'Karan Patel', phone: '+91 97310 99887', email: 'karan@spectrumwholesale.com', gstin: '29KLMNO9012P1Z3', creditLimit: 500000, outstanding: 0, creditDays: 45, salesExec: 'Suresh V', lastPurchaseDate: '2026-07-28', totalPurchases: '₹ 34,10,000' }
];

// Treat inventory placeholder dashes as "no value" so empty columns stay blank.
const cellText = (v) => (v == null || v === '' || v === '—' || v === '-' ? '' : v);

// One "label: value" row used across the compact invoice summary / credit panel.
function SummaryLine({ label, value, valueColor, dense }) {
  return (
    <Stack direction="row" justifyContent="space-between" alignItems="center" sx={dense ? { py: 0.15 } : undefined}>
      <Typography variant="body2" color="text.secondary" sx={{ fontSize: dense ? '0.78rem' : undefined }}>{label}</Typography>
      <Typography variant="body2" fontWeight={700} sx={{ color: valueColor || '#0f172a', fontSize: dense ? '0.78rem' : undefined }}>{value}</Typography>
    </Stack>
  );
}

// A single field in the selected-customer info card (only rendered when it has a value).
function CustomerBit({ label, value, valueColor }) {
  return (
    <Grid item xs={6} sm={4}>
      <Typography variant="caption" color="text.secondary" display="block" sx={{ lineHeight: 1.3 }}>{label}</Typography>
      <Typography variant="body2" fontWeight={700} sx={{ color: valueColor || '#0f172a', wordBreak: 'break-word' }}>{value}</Typography>
    </Grid>
  );
}

// Due / Change tiles under the cash amount field.
function MiniStat({ label, value, color }) {
  return (
    <Box sx={{ flex: 1, p: 1, borderRadius: 2, bgcolor: '#f8fafc', border: '1px solid #e2e8f0' }}>
      <Typography variant="caption" color="text.secondary" display="block">{label}</Typography>
      <Typography variant="body2" fontWeight={800} sx={{ color }}>{value}</Typography>
    </Box>
  );
}

export default function WholesaleSales() {
  const location = useLocation();
  const navigate = useNavigate();

  // --- REFS FOR KEYBOARD SHORTCUTS ---
  const customerSearchInputRef = useRef(null);
  const barcodeSearchInputRef = useRef(null);

  // --- CORE STATES ---
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  // Warehouse the backend attributes wholesale stock movements to (first one on file).
  const [invWarehouseId, setInvWarehouseId] = useState('');
  const [selectedCustomer, setSelectedCustomer] = useState(null); // Blank by default
  const [cartItems, setCartItems] = useState([]);
  const [barcodeInput, setBarcodeInput] = useState('');
  // Cosmetic running invoice number shown in the header (the posted invoice keeps its own no.)
  const [headerInvoiceNo] = useState(() => `WS-${new Date().getFullYear()}-${String(Math.floor(1000 + Math.random() * 9000))}`);
  
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

    try {
      const savedHeld = JSON.parse(localStorage.getItem('optical_wholesale_held_invoices') || '[]');
      setHeldInvoices(savedHeld);
    } catch (e) {}
  }, []);

  // --- Live Inventory sync ---
  // The wholesale catalogue and on-hand stock are pulled from the SAME backend Product list
  // as the Inventory > Products screen, so a Purchase Entry, stock adjustment or retail sale
  // is reflected here immediately (this is what "Stock, rate and GST are pulled live from
  // inventory" means). localStorage is only a fallback for offline use / demo data / items
  // created locally that never reached the API.
  useEffect(() => {
    let cancelled = false;

    const mapBackendProduct = (p) => {
      const stock = parseInt(p.stock ?? p.quantity ?? 0) || 0;
      const gstNum = parseFloat(String(p.gst ?? p.tax_rate ?? '').replace('%', '').trim());
      const extra = p.extra_data && typeof p.extra_data === 'object' ? p.extra_data : {};
      return {
        id: String(p.id),
        code: p.product_code || p.sku || p.code || '',
        sku: p.sku || '',
        name: p.name || 'Unnamed',
        brand: p.brand || 'Generic',
        category: p.category || 'General',
        modelNo: p.model_no || extra.model_no || '—',
        color: p.colour || p.color || extra.color || '—',
        size: p.size || extra.size || '—',
        power: p.power || extra.power || '—',
        availableStock: stock,
        stock,
        wholesalePrice: parseFloat(p.wholesale_price || p.price || p.retail_price || 0) || 0,
        price: parseFloat(p.price || p.retail_price || 0) || 0,
        gst: Number.isFinite(gstNum) ? gstNum : 18,
        unit: p.unit || 'Pcs',
        barcode: p.barcode || '',
      };
    };

    const keyOf = (p) => String(p.barcode || p.code || p.sku || p.id || p.name || '').toLowerCase();

    const readLocalProducts = () => {
      try { return JSON.parse(localStorage.getItem('optical_inventory_items') || '[]'); } catch (e) { return []; }
    };

    const syncInventory = async () => {
      let local = readLocalProducts();

      let backend = [];
      try {
        const res = await axios.get('/api/products/products/');
        const raw = res.data?.results || res.data || [];
        if (Array.isArray(raw)) backend = raw.map(mapBackendProduct);
      } catch (e) {}

      if (cancelled) return;

      if (backend.length === 0) {
        // API unreachable — keep whatever is in localStorage, seeding demo data on first run.
        if (local.length === 0) {
          setProducts(INITIAL_DEMO_PRODUCTS);
          try { localStorage.setItem('optical_inventory_items', JSON.stringify(INITIAL_DEMO_PRODUCTS)); } catch (e) {}
        } else {
          setProducts(local);
        }
        return;
      }

      // Backend rows win on stock/price; keep any local-only items the API doesn't know about.
      const backendKeys = new Set(backend.map(keyOf));
      const backendIds = new Set(backend.map(p => String(p.id)));
      const localOnly = local.filter(p => !backendKeys.has(keyOf(p)) && !backendIds.has(String(p.id)));

      // Not persisted back to localStorage: the backend is the source of truth now, and other
      // screens keep their own copy of that key. localStorage stays a read-only offline fallback.
      setProducts([...backend, ...localOnly]);
    };

    const loadWarehouse = async () => {
      try {
        const res = await axios.get('/api/company/warehouses/');
        const list = res.data?.results || res.data || [];
        if (!cancelled && Array.isArray(list) && list.length) setInvWarehouseId(String(list[0].id));
      } catch (e) {}
    };

    // Paint instantly from cached inventory — no need to wait on the network round-trip
    // for data the browser already has.
    const initialLocal = readLocalProducts();
    if (initialLocal.length) setProducts(initialLocal);

    syncInventory();
    loadWarehouse();
    window.addEventListener('optical_stock_updated', syncInventory);
    window.addEventListener('focus', syncInventory);
    return () => {
      cancelled = true;
      window.removeEventListener('optical_stock_updated', syncInventory);
      window.removeEventListener('focus', syncInventory);
    };
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
    const totalGst = cartItems.reduce((acc, item) => {
      const lineBase = (parseFloat(item.rate) || 0) * (parseFloat(item.qty) || 0);
      const lineGross = lineBase - (lineBase * ((parseFloat(item.discount) || 0) / 100));
      return acc + (lineGross * ((parseFloat(item.gst) || 0) / 100));
    }, 0);
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

  // Park the cursor in the barcode field on load so a scanner works without a click.
  useEffect(() => {
    const t = setTimeout(() => barcodeSearchInputRef.current?.focus(), 300);
    return () => clearTimeout(t);
  }, []);

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
          modelNo: prod.modelNo || prod.model_no || prod.model || '',
          color: prod.color || prod.colour || '',
          size: prod.size || '',
          power: prod.power || '',
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
      const code = barcodeInput.trim().toLowerCase();
      const matched = products.find(p =>
        (p.barcode && p.barcode.toLowerCase() === code) ||
        (p.code && p.code.toLowerCase() === code)
      );
      if (matched) {
        // Exact barcode / code hit — add it and keep the Autocomplete from also selecting.
        e.preventDefault();
        e.stopPropagation();
        handleAddProductToCart(matched);
        setBarcodeInput('');
        showToast(`Added: ${matched.name}`, 'success');
        setTimeout(() => barcodeSearchInputRef.current?.focus(), 0);
      } else if (/^\d{6,}$/.test(code)) {
        // Looks like a scanned barcode but nothing matched.
        showToast(`No product found matching barcode "${barcodeInput}"`, 'error');
      }
      // Otherwise it's a name/partial search — let the Autocomplete handle Enter.
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

    // 1. Decrement Inventory Stock (localStorage view first, for instant feedback)
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

    // Push the same decrement to the backend inventory so Inventory > Products, the retail
    // POS and the next live-sync here all agree. Best-effort: the localStorage view above
    // already reflects the sale even if the API is unreachable.
    const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));
    if (invWarehouseId) {
      await Promise.all(cartItems.map(async (item) => {
        const prod = products.find(p => p.id === item.id || p.code === item.code);
        if (!prod || !isUuid(prod.id) || !(item.qty > 0)) return;
        try {
          await axios.post('/api/inventory/adjustments/', {
            product: prod.id,
            warehouse: invWarehouseId,
            quantity: Math.round(item.qty),
            adjustment_type: 'SUB',
            reason: `Wholesale POS sale ${invoiceNo}`,
          });
        } catch (e) {}
      }));
      window.dispatchEvent(new Event('optical_stock_updated'));
    }

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
      {/* HEADER */}
      <Stack
        direction={{ xs: 'column', sm: 'row' }}
        justifyContent="space-between"
        alignItems={{ xs: 'flex-start', sm: 'center' }}
        spacing={1.5}
        sx={{ mb: 2 }}
      >
        <Box>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Typography variant="h6" fontWeight={800} color="#0f172a">
              Wholesale Sale
            </Typography>
            <Chip
              label={`Invoice #${headerInvoiceNo}`}
              size="small"
              sx={{ height: 20, fontSize: '0.7rem', fontWeight: 700, bgcolor: '#eef2ff', color: '#4f46e5' }}
            />
          </Stack>
          <Typography variant="caption" color="text.secondary">
            Create a wholesale invoice
          </Typography>
        </Box>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          {heldInvoices.length > 0 && (
            <Button
              variant="outlined"
              color="warning"
              size="small"
              startIcon={<ResumeIcon />}
              onClick={() => setHeldModalOpen(true)}
              sx={{ fontWeight: 700, textTransform: 'none' }}
            >
              Held ({heldInvoices.length})
            </Button>
          )}
          <Button
            variant="outlined"
            size="small"
            startIcon={<PersonAddIcon />}
            onClick={() => setAddCustomerOpen(true)}
            sx={{ fontWeight: 700, textTransform: 'none' }}
          >
            Add Wholesale Customer
          </Button>
          <Button
            variant="outlined"
            size="small"
            color="error"
            startIcon={<ClearIcon />}
            disabled={cartItems.length === 0}
            onClick={() => setClearCartConfirmOpen(true)}
            sx={{ fontWeight: 700, textTransform: 'none' }}
          >
            Clear Cart
          </Button>
        </Stack>
      </Stack>

      {/* TOAST ALERT */}
      {toast.open && (
        <Alert severity={toast.severity} sx={{ mb: 2, borderRadius: 2, fontWeight: 600 }}>
          {toast.message}
        </Alert>
      )}

      <Grid container spacing={2.5} alignItems="flex-start">
        {/* ================= LEFT: CUSTOMER + PRODUCTS ================= */}
        <Grid item xs={12} lg={8}>
          <Stack spacing={2.5}>
            {/* CUSTOMER */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                <Typography variant="subtitle2" fontWeight={800} color="#0f172a">Customer</Typography>
                <Chip label="F2" size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700, bgcolor: '#f1f5f9', color: '#64748b' }} />
              </Stack>

              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
                <Autocomplete
                  fullWidth
                  options={customers}
                  getOptionLabel={(o) => (o ? `${o.name}${o.code ? ` (${o.code})` : ''}` : '')}
                  isOptionEqualToValue={(o, v) => o.id === v.id}
                  value={selectedCustomer}
                  onChange={(e, newVal) => setSelectedCustomer(newVal)}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      inputRef={customerSearchInputRef}
                      size="small"
                      placeholder="Search customer by name, code or phone..."
                      InputProps={{
                        ...params.InputProps,
                        startAdornment: (
                          <>
                            <SearchIcon sx={{ color: '#94a3b8', mr: 0.5, fontSize: 18 }} />
                            {params.InputProps.startAdornment}
                          </>
                        )
                      }}
                    />
                  )}
                />
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<AddIcon />}
                  onClick={() => setAddCustomerOpen(true)}
                  sx={{ fontWeight: 700, textTransform: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}
                >
                  New Customer
                </Button>
              </Stack>

              {selectedCustomer && (
                <Box sx={{ mt: 1.5, p: 1.5, borderRadius: 2, bgcolor: '#f8fafc', border: '1px solid #e2e8f0' }}>
                  <Typography variant="subtitle2" fontWeight={800} color="#0f172a">{selectedCustomer.name}</Typography>
                  <Grid container spacing={1} sx={{ mt: 0.25 }}>
                    {selectedCustomer.phone ? <CustomerBit label="Phone" value={selectedCustomer.phone} /> : null}
                    {selectedCustomer.gstin ? <CustomerBit label="GSTIN" value={selectedCustomer.gstin} /> : null}
                    <CustomerBit
                      label="Outstanding"
                      value={`₹${(parseFloat(selectedCustomer.outstanding) || 0).toLocaleString('en-IN')}`}
                      valueColor={outstandingColor}
                    />
                    {selectedCustomer.creditLimit ? (
                      <CustomerBit label="Credit Limit" value={`₹${(parseFloat(selectedCustomer.creditLimit) || 0).toLocaleString('en-IN')}`} />
                    ) : null}
                    <CustomerBit label="Payment Terms" value={`${selectedCustomer.creditDays || 30} Days`} />
                    {selectedCustomer.salesExec ? <CustomerBit label="Sales Executive" value={selectedCustomer.salesExec} /> : null}
                  </Grid>
                </Box>
              )}

              {isCreditExceeded && (
                <Alert severity="warning" icon={<WarningIcon />} sx={{ mt: 1.5, borderRadius: 2, fontWeight: 600, py: 0.25 }}>
                  Outstanding (₹{parseFloat(selectedCustomer.outstanding).toLocaleString('en-IN')}) + this bill exceeds the credit limit of ₹{parseFloat(selectedCustomer.creditLimit).toLocaleString('en-IN')}.
                </Alert>
              )}
            </Card>

            {/* PRODUCTS */}
            <Card variant="outlined" sx={{ borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0', overflow: 'hidden' }}>
              <Box sx={{ p: 2 }}>
                <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5 }}>
                  <Typography variant="subtitle2" fontWeight={800} color="#0f172a">Products</Typography>
                  <Chip label="F3" size="small" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700, bgcolor: '#f1f5f9', color: '#64748b' }} />
                </Stack>

                <Autocomplete
                  freeSolo
                  fullWidth
                  options={products}
                  value={null}
                  inputValue={barcodeInput}
                  onInputChange={(e, v, reason) => { if (reason === 'input' || reason === 'clear') setBarcodeInput(v); }}
                  getOptionLabel={(p) => (typeof p === 'string' ? p : p.name || '')}
                  filterOptions={(opts, state) => {
                    const q = state.inputValue.trim().toLowerCase();
                    if (!q) return opts.slice(0, 50);
                    return opts
                      .filter((p) =>
                        (p.name || '').toLowerCase().includes(q) ||
                        (p.code || '').toLowerCase().includes(q) ||
                        (p.barcode || '').toLowerCase().includes(q) ||
                        (p.brand || '').toLowerCase().includes(q) ||
                        (p.modelNo || '').toLowerCase().includes(q)
                      )
                      .slice(0, 50);
                  }}
                  onChange={(e, val) => {
                    if (val && typeof val !== 'string') {
                      handleAddProductToCart(val);
                      setBarcodeInput('');
                      showToast(`Added: ${val.name}`, 'success');
                      setTimeout(() => barcodeSearchInputRef.current?.focus(), 0);
                    }
                  }}
                  renderInput={(params) => (
                    <TextField
                      {...params}
                      inputRef={barcodeSearchInputRef}
                      size="small"
                      placeholder="Scan barcode or search product name / model..."
                      /* capture phase so an exact barcode hit is handled before the
                         Autocomplete's own Enter handler can also select an option */
                      onKeyDownCapture={handleBarcodeScan}
                      InputProps={{
                        ...params.InputProps,
                        startAdornment: (
                          <>
                            <QrCodeScannerIcon sx={{ color: '#4f46e5', mr: 0.5, fontSize: 20 }} />
                            {params.InputProps.startAdornment}
                          </>
                        ),
                        endAdornment: (
                          <>
                            <Chip label="F3" size="small" sx={{ height: 18, fontSize: '0.62rem', fontWeight: 700, bgcolor: '#f1f5f9', color: '#64748b', mr: 0.5 }} />
                            {params.InputProps.endAdornment}
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
                            <Typography variant="caption" sx={{ fontWeight: 700, color: stock > 5 ? '#059669' : stock > 0 ? '#d97706' : '#dc2626' }}>
                              {stock > 0 ? `Stock: ${stock}` : 'Out of stock'}
                            </Typography>
                          </Stack>
                          <Typography variant="caption" color="text.secondary">
                            {[cellText(p.code), cellText(p.brand), `₹${(p.wholesalePrice || p.price || 0).toFixed(2)}`].filter(Boolean).join('  •  ')}
                          </Typography>
                        </Box>
                      </li>
                    );
                  }}
                />
              </Box>

              {cartItems.length === 0 ? (
                <Box sx={{ py: 6, px: 2, textAlign: 'center', borderTop: '1px solid #e2e8f0' }}>
                  <InventoryIcon sx={{ fontSize: 30, color: '#cbd5e1', mb: 0.5 }} />
                  <Typography variant="body2" fontWeight={700} color="#475569">Start adding products</Typography>
                  <Typography variant="caption" color="text.secondary">Scan a barcode or search for a product</Typography>
                </Box>
              ) : (
                <TableContainer sx={{ overflowX: 'auto', borderTop: '1px solid #e2e8f0' }}>
                  <Table size="small" sx={{ minWidth: 760 }}>
                    <TableHead sx={{ '& th': { bgcolor: '#f8fafc', color: '#475569', fontWeight: 700, fontSize: '0.72rem', borderBottom: '1px solid #e2e8f0', whiteSpace: 'nowrap', py: 1 } }}>
                      <TableRow>
                        <TableCell>Barcode</TableCell>
                        <TableCell>Product</TableCell>
                        <TableCell>Model</TableCell>
                        <TableCell>Color</TableCell>
                        <TableCell>Size</TableCell>
                        <TableCell align="center">Qty</TableCell>
                        <TableCell align="right">Rate</TableCell>
                        <TableCell align="right">Disc %</TableCell>
                        <TableCell align="right">GST</TableCell>
                        <TableCell align="right">Total</TableCell>
                        <TableCell align="center" padding="checkbox" />
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {cartItems.map((item, idx) => {
                        const isStockExceeded = item.qty > item.availableStock;
                        const lineBase = (parseFloat(item.rate) || 0) * (parseFloat(item.qty) || 0);
                        const lineDisc = lineBase * ((parseFloat(item.discount) || 0) / 100);
                        const lineGross = lineBase - lineDisc;
                        const lineGst = lineGross * ((parseFloat(item.gst) || 0) / 100);
                        const lineTotal = lineGross + lineGst;

                        return (
                          <TableRow
                            key={item.id || idx}
                            hover
                            sx={{ bgcolor: isStockExceeded ? '#fef2f2' : 'inherit', '& td': { py: 0.75, fontSize: '0.8rem', whiteSpace: 'nowrap', borderBottom: '1px solid #f1f5f9' } }}
                          >
                            <TableCell sx={{ fontFamily: 'monospace', color: '#64748b' }}>{cellText(item.barcode) || cellText(item.code)}</TableCell>
                            <TableCell sx={{ whiteSpace: 'normal', minWidth: 160 }}>
                              <Typography variant="body2" fontWeight={700} sx={{ fontSize: '0.82rem' }}>{item.name}</Typography>
                              <Typography variant="caption" sx={{ color: isStockExceeded ? '#dc2626' : '#94a3b8' }}>
                                Stock: {item.availableStock}{isStockExceeded ? ' — over limit' : ''}
                              </Typography>
                            </TableCell>
                            <TableCell sx={{ color: '#475569' }}>{cellText(item.modelNo)}</TableCell>
                            <TableCell sx={{ color: '#475569' }}>{cellText(item.color)}</TableCell>
                            <TableCell sx={{ color: '#475569' }}>{cellText(item.size)}</TableCell>
                            <TableCell align="center">
                              <Stack direction="row" alignItems="center" justifyContent="center" spacing={0.25}>
                                <IconButton size="small" sx={{ p: 0.25 }} onClick={() => handleUpdateItemQty(idx, -1)}>
                                  <RemoveIcon sx={{ fontSize: 15 }} />
                                </IconButton>
                                <TextField
                                  size="small"
                                  type="number"
                                  error={isStockExceeded}
                                  value={item.qty}
                                  onChange={(e) => handleUpdateItemQty(idx, e.target.value, true)}
                                  sx={{ width: 46, '& .MuiInputBase-input': { py: 0.25, px: 0.25, textAlign: 'center', fontWeight: 700, fontSize: '0.8rem' } }}
                                />
                                <IconButton size="small" sx={{ p: 0.25 }} onClick={() => handleUpdateItemQty(idx, 1)}>
                                  <AddIcon sx={{ fontSize: 15 }} />
                                </IconButton>
                              </Stack>
                            </TableCell>
                            <TableCell align="right">
                              <TextField
                                size="small"
                                type="number"
                                value={item.rate}
                                onChange={(e) => handleUpdateItemField(idx, 'rate', parseFloat(e.target.value) || 0)}
                                sx={{ width: 74, '& .MuiInputBase-input': { py: 0.25, px: 0.5, textAlign: 'right', fontSize: '0.8rem' } }}
                              />
                            </TableCell>
                            <TableCell align="right">
                              <TextField
                                size="small"
                                type="number"
                                value={item.discount}
                                onChange={(e) => handleUpdateItemField(idx, 'discount', parseFloat(e.target.value) || 0)}
                                sx={{ width: 52, '& .MuiInputBase-input': { py: 0.25, px: 0.5, textAlign: 'right', fontSize: '0.8rem' } }}
                              />
                            </TableCell>
                            <TableCell align="right" sx={{ color: '#64748b' }}>{(parseFloat(item.gst) || 0)}%</TableCell>
                            <TableCell align="right" sx={{ fontWeight: 800, color: '#0f172a' }}>₹{lineTotal.toFixed(2)}</TableCell>
                            <TableCell align="center" padding="checkbox">
                              <IconButton size="small" sx={{ p: 0.25 }} onClick={() => handleRemoveItem(idx)}>
                                <DeleteIcon sx={{ fontSize: 16, color: '#94a3b8' }} />
                              </IconButton>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </TableContainer>
              )}

              {cartItems.length > 0 && (
                <Box sx={{ px: 2, py: 1, borderTop: '1px solid #e2e8f0', bgcolor: '#f8fafc' }}>
                  <Typography variant="caption" fontWeight={700} color="#475569">
                    Total Items: {summary.totalItems} product{summary.totalItems === 1 ? '' : 's'} ({summary.totalQty} unit{summary.totalQty === 1 ? '' : 's'})
                  </Typography>
                </Box>
              )}
            </Card>
          </Stack>
        </Grid>

        {/* ================= RIGHT: SUMMARY + PAYMENT + ACTIONS ================= */}
        <Grid item xs={12} lg={4}>
          <Stack spacing={2.5} sx={{ position: { lg: 'sticky' }, top: 16 }}>
            {/* INVOICE SUMMARY */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Typography variant="subtitle2" fontWeight={800} color="#0f172a" sx={{ mb: 1.5 }}>Invoice Summary</Typography>
              <Stack spacing={0.85}>
                <SummaryLine label="Subtotal" value={`₹${summary.subtotal.toFixed(2)}`} />
                <SummaryLine label="Discount" value={`-₹${summary.totalDiscount.toFixed(2)}`} valueColor="#059669" />
                <SummaryLine label="GST" value={`₹${summary.totalGst.toFixed(2)}`} />
                <Stack direction="row" justifyContent="space-between" alignItems="center">
                  <Typography variant="body2" color="text.secondary">Additional Charges</Typography>
                  <TextField
                    size="small"
                    type="number"
                    placeholder="0"
                    value={additionalCharges}
                    onChange={(e) => setAdditionalCharges(e.target.value)}
                    sx={{ width: 96, '& .MuiInputBase-input': { py: 0.3, px: 0.6, textAlign: 'right', fontSize: '0.82rem' } }}
                  />
                </Stack>
                <SummaryLine
                  label="Round Off"
                  value={`${summary.roundOff >= 0 ? '+' : '-'}₹${Math.abs(summary.roundOff).toFixed(2)}`}
                />
              </Stack>
              <Divider sx={{ my: 1.25 }} />
              <Stack direction="row" justifyContent="space-between" alignItems="baseline">
                <Typography variant="subtitle2" fontWeight={800} color="#0f172a">Grand Total</Typography>
                <Typography variant="h6" fontWeight={900} color="#4f46e5">₹{summary.grandTotal.toLocaleString('en-IN')}</Typography>
              </Stack>
            </Card>

            {/* PAYMENT */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Typography variant="subtitle2" fontWeight={800} color="#0f172a" sx={{ mb: 1.5 }}>Payment Method</Typography>

              <ToggleButtonGroup
                value={payMode}
                exclusive
                onChange={(e, v) => { if (v) setPayMode(v); }}
                fullWidth
                size="small"
                sx={{
                  mb: 1.5,
                  flexWrap: 'wrap',
                  gap: 0.5,
                  '& .MuiToggleButton-root': {
                    flex: '1 0 auto',
                    textTransform: 'none',
                    fontWeight: 700,
                    fontSize: '0.75rem',
                    py: 0.5,
                    border: '1px solid #e2e8f0 !important',
                    borderRadius: '8px !important',
                    '&.Mui-selected': { bgcolor: '#4f46e5', color: '#fff', '&:hover': { bgcolor: '#4338ca' } }
                  }
                }}
              >
                {[['Cash', 'Cash'], ['UPI', 'UPI'], ['Card', 'Card'], ['Bank Transfer', 'Bank'], ['Credit Sale', 'Credit']].map(([val, label]) => (
                  <ToggleButton key={val} value={val}>{label}</ToggleButton>
                ))}
              </ToggleButtonGroup>

              {payMode === 'Cash' && (
                <Stack spacing={1}>
                  <TextField
                    fullWidth
                    size="small"
                    type="number"
                    label="Amount Received (₹)"
                    InputLabelProps={{ shrink: true }}
                    placeholder={String(summary.grandTotal)}
                    value={amountReceived}
                    onChange={(e) => setAmountReceived(e.target.value)}
                  />
                  <Stack direction="row" spacing={1}>
                    <MiniStat label="Due Amount" value={`₹${paymentCalc.dueAmount.toLocaleString('en-IN')}`} color={paymentCalc.dueAmount > 0 ? '#dc2626' : '#059669'} />
                    <MiniStat label="Change" value={`₹${paymentCalc.balanceAmount.toLocaleString('en-IN')}`} color="#4f46e5" />
                  </Stack>
                </Stack>
              )}

              {(payMode === 'UPI' || payMode === 'Card') && (
                <Stack spacing={1}>
                  <TextField fullWidth size="small" label="Amount Received (₹)" InputLabelProps={{ shrink: true }} value={summary.grandTotal} InputProps={{ readOnly: true }} sx={{ bgcolor: '#f8fafc' }} />
                  <TextField fullWidth size="small" label="Reference / Txn ID" InputLabelProps={{ shrink: true }} placeholder="UPI Ref / Approval Code" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
                </Stack>
              )}

              {payMode === 'Bank Transfer' && (
                <Stack spacing={1}>
                  <TextField fullWidth size="small" label="Reference / Cheque No" InputLabelProps={{ shrink: true }} placeholder="NEFT / RTGS Ref" value={refNo} onChange={(e) => setRefNo(e.target.value)} />
                  <TextField fullWidth size="small" label="Bank Name / Account" InputLabelProps={{ shrink: true }} placeholder="e.g. HDFC Bank" value={bankName} onChange={(e) => setBankName(e.target.value)} />
                </Stack>
              )}

              {payMode === 'Credit Sale' && (
                <Stack spacing={1}>
                  <TextField
                    select
                    fullWidth
                    size="small"
                    label="Credit Duration"
                    InputLabelProps={{ shrink: true }}
                    value={creditDays}
                    onChange={(e) => setCreditDays(e.target.value)}
                  >
                    <MenuItem value={15}>15 Days</MenuItem>
                    <MenuItem value={30}>30 Days</MenuItem>
                    <MenuItem value={45}>45 Days</MenuItem>
                    <MenuItem value={60}>60 Days</MenuItem>
                  </TextField>

                  {selectedCustomer ? (
                    <Box sx={{ p: 1.25, borderRadius: 2, bgcolor: '#f8fafc', border: '1px solid #e2e8f0' }}>
                      <SummaryLine label="Outstanding" value={`₹${(parseFloat(selectedCustomer.outstanding) || 0).toLocaleString('en-IN')}`} dense />
                      <SummaryLine label="Credit Limit" value={`₹${(parseFloat(selectedCustomer.creditLimit) || 0).toLocaleString('en-IN')}`} dense />
                      <SummaryLine
                        label="Available Credit"
                        value={`₹${Math.max(0, (parseFloat(selectedCustomer.creditLimit) || 0) - (parseFloat(selectedCustomer.outstanding) || 0)).toLocaleString('en-IN')}`}
                        valueColor="#059669"
                        dense
                      />
                    </Box>
                  ) : (
                    <Typography variant="caption" color="text.secondary">Select a customer to see available credit.</Typography>
                  )}

                  {selectedCustomer && summary.grandTotal > Math.max(0, (parseFloat(selectedCustomer.creditLimit) || 0) - (parseFloat(selectedCustomer.outstanding) || 0)) && (
                    <Alert severity="warning" sx={{ borderRadius: 2, py: 0.25, fontSize: '0.75rem', fontWeight: 600 }}>
                      This invoice exceeds available credit by ₹{(summary.grandTotal - Math.max(0, (parseFloat(selectedCustomer.creditLimit) || 0) - (parseFloat(selectedCustomer.outstanding) || 0))).toLocaleString('en-IN')}.
                    </Alert>
                  )}
                </Stack>
              )}
            </Card>

            {/* ACTIONS */}
            <Stack spacing={1}>
              <Button
                variant="contained"
                fullWidth
                size="large"
                disabled={Boolean(!selectedCustomer || cartItems.length === 0)}
                onClick={handleAttemptCompleteSale}
                startIcon={<CheckedIcon />}
                endIcon={<Chip label="F9" size="small" sx={{ height: 18, fontSize: '0.62rem', fontWeight: 700, bgcolor: 'rgba(255,255,255,0.25)', color: '#fff' }} />}
                sx={{ bgcolor: '#4f46e5', fontWeight: 800, py: 1.1, textTransform: 'none', '&:hover': { bgcolor: '#4338ca' } }}
              >
                Complete Sale
              </Button>
              <Stack direction="row" spacing={1}>
                <Button
                  fullWidth
                  size="small"
                  variant="outlined"
                  disabled={cartItems.length === 0}
                  onClick={() => showToast('Draft saved.', 'info')}
                  startIcon={<SaveIcon />}
                  sx={{ fontWeight: 700, textTransform: 'none' }}
                >
                  Save Draft
                </Button>
                <Button
                  fullWidth
                  size="small"
                  variant="outlined"
                  color="warning"
                  disabled={cartItems.length === 0}
                  onClick={handleHoldInvoice}
                  startIcon={<HoldIcon />}
                  sx={{ fontWeight: 700, textTransform: 'none' }}
                >
                  Hold Invoice
                </Button>
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ textAlign: 'center', mt: 0.25 }}>
                F2 Customer &nbsp;&middot;&nbsp; F3 Product &nbsp;&middot;&nbsp; F9 Complete &nbsp;&middot;&nbsp; Esc Clear
              </Typography>
            </Stack>
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

      {/* DIALOG: PRINT GST TAX INVOICE — rendered by the shared Bill Rendering Engine
          (template assigned to WHOLESALE_BILL in Settings → Bill & Invoice Designer). */}
      <Dialog open={printModalOpen} onClose={() => setPrintModalOpen(false)} maxWidth="md" fullWidth>
        <DialogTitle sx={{ fontWeight: 850, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Wholesale Tax Invoice #{printableInvoice?.invoiceNo}</span>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" startIcon={<WhatsAppIcon />} onClick={() => alert("Shared via WhatsApp")}>WhatsApp</Button>
            <Button size="small" variant="outlined" startIcon={<EmailIcon />} onClick={() => alert("Sent via Email")}>Email</Button>
            <Button size="small" variant="contained" startIcon={<PrintIcon />}
              onClick={() => printBill({ doc: printableInvoice, documentType: 'WHOLESALE_BILL' })}>
              Print
            </Button>
          </Stack>
        </DialogTitle>
        <DialogContent dividers sx={{ bgcolor: '#eef2f7', py: 3 }}>
          {printableInvoice && (
            <BillPreview doc={printableInvoice} documentType="WHOLESALE_BILL" maxWidth={720} />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPrintModalOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
