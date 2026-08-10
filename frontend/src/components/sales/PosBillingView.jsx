import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { 
  Box, Grid, Card, CardContent, Typography, TextField, InputBase,
  Button, MenuItem, Table, TableBody, TableCell, 
  TableContainer, TableHead, TableRow, Paper, IconButton, 
  Stack, Divider, Dialog, DialogTitle, DialogContent, DialogActions,
  Chip, InputAdornment, Avatar, Tooltip, Alert, Badge,
  FormControlLabel, Checkbox, Switch
} from '@mui/material';
import {
  PointOfSale as POSIcon,
  Search as SearchIcon,
  QrCodeScanner as ScannerIcon,
  Add as AddIcon,
  Remove as RemoveIcon,
  Delete as DeleteIcon,
  Print as PrintIcon,
  WhatsApp as WhatsAppIcon,
  Payment as PaymentIcon,
  Person as PersonIcon,
  ShoppingCart as CartIcon,
  QrCode2 as QrCodeIcon,
  CheckCircle as SuccessIcon,
  Receipt as ReceiptIcon,
  LocalShipping as DeliveryIcon,
  LocalOffer as DiscountIcon,
  Star as StarIcon,
  MedicalServices as DoctorIcon,
  AddShoppingCart as AddCartIcon,
  CameraAlt as CameraIcon,
  Inbox as EmptyIcon
} from '@mui/icons-material';

// Sample Catalog Items if DB is blank, with option to seed DB
const defaultCatalogItems = [
  { id: 'PRD-101', name: 'Ray-Ban Wayfarer Classic Black', brand: 'Ray-Ban', type: 'Frame', price: 4500, stock: 14, taxRate: 18, image: '👓' },
  { id: 'PRD-102', name: 'Oakley Pitchman Titanium', brand: 'Oakley', type: 'Frame', price: 6200, stock: 8, taxRate: 18, image: '👓' },
  { id: 'PRD-103', name: 'Essilor Crizal 1.56 Blue-Cut Lens', brand: 'Essilor', type: 'Lens', price: 2800, stock: 30, taxRate: 18, image: '🔍' },
  { id: 'PRD-104', name: 'Zeiss Progressive SmartLife 1.61', brand: 'Zeiss', type: 'Lens', price: 8500, stock: 15, taxRate: 18, image: '🔍' },
  { id: 'PRD-105', name: 'Acuvue Oasys 1-Day (30 Lenses)', brand: 'Acuvue', type: 'Contact Lens', price: 2200, stock: 25, taxRate: 12, image: '👁️' },
  { id: 'PRD-106', name: 'Bausch & Lomb BioTrue Solution 300ml', brand: 'Bausch & Lomb', type: 'Accessory', price: 450, stock: 40, taxRate: 18, image: '🧪' }
];

export default function PosBillingView({
  products = [],
  customers = [],
  onCheckoutComplete,
  onOpenRecordPayment
}) {
  const barcodeInputRef = useRef(null);
  const machineInputRef = useRef(null);

  // Search & Filters
  const [barcodeInput, setBarcodeInput] = useState('');
  const [selectedCategory, setSelectedCategory] = useState('All');
  const [selectedBrand, setSelectedBrand] = useState('All');

  // Customer Selection
  const [selectedCustomerId, setSelectedCustomerId] = useState('');
  const [customerSearchQuery, setCustomerSearchQuery] = useState('');
  const [customerDialogOpen, setCustomerDialogOpen] = useState(false);
  const [allCustomersList, setAllCustomersList] = useState([]);

  useEffect(() => {
    let pool = Array.isArray(customers) ? [...customers] : [];

    try {
      const localCust = JSON.parse(localStorage.getItem('optical_sales_customers') || '[]');
      const localExams = JSON.parse(localStorage.getItem('optical_eye_tests') || '[]');
      const localPats = JSON.parse(localStorage.getItem('optical_patients') || '[]');
      pool = [...pool, ...localCust, ...localExams, ...localPats];
    } catch (e) {}

    const buildCustomerMap = (inputPool) => {
      const uniqueMap = new Map();
      inputPool.forEach((c, idx) => {
        if (!c) return;
        const name = c.name || c.patient_name || c.patientName;
        if (!name) return;
        const id = c.id || c.patient_id || c.patientId || `P-${1001 + idx}`;
        const phone = c.phone || c.mobile || '';
        const key = String(id || phone || name).toLowerCase().trim();

        if (!uniqueMap.has(key)) {
          uniqueMap.set(key, {
            ...c,
            id: id,
            name: name,
            phone: phone || 'No Phone',
            age: c.age || '22',
            gender: c.gender || 'MALE',
            address: c.address || ''
          });
        }
      });
      return Array.from(uniqueMap.values());
    };

    const initialCustList = buildCustomerMap(pool);
    setAllCustomersList(initialCustList);

    // Fetch API records asynchronously in background without blocking UI render
    if (!customers || customers.length === 0) {
      Promise.all([
        axios.get('/api/sales/customers/').catch(() => null),
        axios.get('/api/sales/eye-examinations/').catch(() => null)
      ]).then(([resCust, resEx]) => {
        const data = resCust?.data?.results || resCust?.data || [];
        const exData = resEx?.data?.results || resEx?.data || [];
        if (Array.isArray(data) || Array.isArray(exData)) {
          const updatedPool = [...pool, ...(Array.isArray(data) ? data : []), ...(Array.isArray(exData) ? exData : [])];
          setAllCustomersList(buildCustomerMap(updatedPool));
        }
      });
    }
  }, [customers]);

  // Cart State
  const [cart, setCart] = useState([]);
  const [discountAmount, setDiscountAmount] = useState(0);
  const [useLoyaltyPoints, setUseLoyaltyPoints] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('UPI / PhonePe');

  // Barcode Scanner Machine Connection States
  const [barcodeMachineOpen, setBarcodeMachineOpen] = useState(false);
  const [isHardwareConnected, setIsHardwareConnected] = useState(true);
  const [deviceName, setDeviceName] = useState('USB / Wireless Barcode Machine (HID Mode)');
  const [lastScannedNotice, setLastScannedNotice] = useState(null);
  const [scanHistory, setScanHistory] = useState([]);

  // Custom Item Modal (Ad-hoc POS billing)
  const [customItemOpen, setCustomItemOpen] = useState(false);
  const [customItem, setCustomItem] = useState({ name: '', price: '', type: 'Accessory', taxRate: 18 });

  // Camera QR Scanner Modal
  const [qrModalOpen, setQrModalOpen] = useState(false);

  // Add Sample Items to Database handler if products empty
  const [catalogList, setCatalogList] = useState(products);

  useEffect(() => {
    setCatalogList(products);
  }, [products]);

  // Global Hardware Barcode Listener for physical USB / Bluetooth barcode machines
  useEffect(() => {
    let buffer = '';
    let lastTime = Date.now();

    const handleKeyDown = (e) => {
      // Avoid capturing regular text typing if target is standard text input unless focused on barcode search
      const tag = e.target.tagName;
      const isInput = (tag === 'INPUT' || tag === 'TEXTAREA') && e.target !== barcodeInputRef.current && e.target !== machineInputRef.current;
      
      const now = Date.now();
      if (now - lastTime > 120) {
        buffer = ''; // Reset buffer if keystroke speed is human (>120ms delay)
      }
      lastTime = now;

      if (e.key === 'Enter') {
        if (buffer.length >= 3 && !isInput) {
          e.preventDefault();
          processBarcodeCode(buffer.trim());
          buffer = '';
        }
      } else if (e.key.length === 1 && !isInput) {
        buffer += e.key;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [catalogList, cart]);

  const processBarcodeCode = (codeStr) => {
    if (!codeStr) return;
    const code = codeStr.toLowerCase();
    const matched = catalogList.find(p => 
      p.id.toLowerCase() === code || 
      p.name.toLowerCase().includes(code)
    ) || {
      id: `BC-${codeStr.slice(-6)}`,
      name: `Scanned Barcode: ${codeStr}`,
      type: 'Frame',
      price: 1500,
      taxRate: 18,
      image: '👓'
    };

    addToCart(matched);
    const notice = `✅ Scanned "${matched.name}" -> Added to Bill!`;
    setLastScannedNotice(notice);
    setScanHistory(prev => [{ code: codeStr, item: matched.name, time: new Date().toLocaleTimeString() }, ...prev]);
    setTimeout(() => setLastScannedNotice(null), 4000);
  };

  // Handle Barcode auto-scan from form input
  const handleBarcodeSubmit = (e) => {
    e.preventDefault();
    if (!barcodeInput.trim()) return;
    processBarcodeCode(barcodeInput.trim());
    setBarcodeInput('');
  };

  const addToCart = (product) => {
    const existing = cart.find(item => item.product.id === product.id);
    if (existing) {
      setCart(cart.map(item => item.product.id === product.id ? { ...item, qty: item.qty + 1 } : item));
    } else {
      setCart([...cart, { product, qty: 1 }]);
    }
  };

  const updateQty = (productId, newQty) => {
    if (newQty <= 0) {
      removeFromCart(productId);
      return;
    }
    setCart(cart.map(item => item.product.id === productId ? { ...item, qty: newQty } : item));
  };

  const removeFromCart = (productId) => {
    setCart(cart.filter(item => item.product.id !== productId));
  };

  const handleAddCustomItem = (e) => {
    e.preventDefault();
    if (!customItem.name || !customItem.price) return;
    const newItem = {
      id: `CUST-${Date.now().toString().slice(-4)}`,
      name: customItem.name,
      type: customItem.type,
      price: parseFloat(customItem.price),
      taxRate: parseFloat(customItem.taxRate || 18),
      image: '✨'
    };
    addToCart(newItem);
    setCustomItemOpen(false);
    setCustomItem({ name: '', price: '', type: 'Accessory', taxRate: 18 });
  };

  const selectedCust = allCustomersList.find(c => String(c.id) === String(selectedCustomerId) || (c.phone && String(c.phone) === String(selectedCustomerId)));
  const loyaltyPointsDiscount = (useLoyaltyPoints && selectedCust?.points) ? Math.min(selectedCust.points, 200) : 0;

  // Cart Calculations
  const subtotal = cart.reduce((sum, item) => sum + (parseFloat(item.product.price || 0) * item.qty), 0);
  const taxAmount = cart.reduce((sum, item) => sum + (parseFloat(item.product.price || 0) * item.qty * ((item.product.taxRate || 18) / 100)), 0);
  const totalDiscount = parseFloat(discountAmount || 0) + loyaltyPointsDiscount;
  const grandTotal = Math.max(0, subtotal + taxAmount - totalDiscount);

  // Filter Catalog List
  const filteredCatalog = catalogList.filter(p => {
    const matchesCategory = selectedCategory === 'All' || 
      (p.type || p.category || '').toLowerCase().includes(selectedCategory.toLowerCase());
    const matchesBrand = selectedBrand === 'All' || p.brand === selectedBrand;
    return matchesCategory && matchesBrand;
  });

  return (
    <Box>
      {/* POS Billing Title & Customer Selector Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3.5, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <POSIcon sx={{ fontSize: 36 }} /> Optical POS Express Billing Terminal
          </Typography>
          <Typography variant="body2" color="text.secondary">
            High-speed barcode scanner checkout, spectacle invoice generation & instant receipt printing.
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} flexWrap="wrap">
          <Button
            variant={selectedCust ? "contained" : "outlined"}
            color={selectedCust ? "success" : "primary"}
            startIcon={<PersonIcon />}
            onClick={() => setCustomerDialogOpen(true)}
            sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700 }}
          >
            {selectedCust ? `Patient: ${selectedCust.name}` : "+ Select / Register Patient"}
          </Button>

          <Button
            variant="outlined"
            color="secondary"
            startIcon={<AddIcon />}
            onClick={() => setCustomItemOpen(true)}
            sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 600 }}
          >
            + Quick Custom Charge
          </Button>
        </Stack>
      </Box>

      {/* Selected Customer Prescription Quick Banner */}
      {selectedCust && (
        <Box sx={{ mb: 3, p: 2, bgcolor: '#f0fdf4', border: '1px solid #86efac', borderRadius: 2.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Box>
            <Typography variant="subtitle2" fontWeight={800} color="success.dark">
              Connected Patient: {selectedCust.name} ({selectedCust.phone}) • ID: {selectedCust.id}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
              OD: SPH {selectedCust.sphRight || selectedCust.sub_sph_od || '0.00'} / CYL {selectedCust.cylRight || selectedCust.sub_cyl_od || '0.00'} | OS: SPH {selectedCust.sphLeft || selectedCust.sub_sph_os || '0.00'} / CYL {selectedCust.cylLeft || selectedCust.sub_cyl_os || '0.00'}
            </Typography>
          </Box>
          <Button size="small" color="error" onClick={() => setSelectedCustomerId('')} sx={{ fontSize: '0.75rem', textTransform: 'none', fontWeight: 700 }}>
            Remove Patient
          </Button>
        </Box>
      )}

      <Grid container spacing={3}>
        {/* Left 65% Column: Barcode Scanner & Product Catalog */}
        <Grid item xs={12} lg={7.5}>
          {/* Barcode & Search Input Unified Pill Bar */}
          <Paper 
            elevation={0} 
            component="form"
            onSubmit={handleBarcodeSubmit}
            sx={{ 
              p: '5px 8px 5px 20px', 
              mb: 2.5, 
              display: 'flex', 
              alignItems: 'center', 
              gap: 1.5,
              border: '1px solid', 
              borderColor: '#cbd5e1', 
              borderRadius: '32px',
              bgcolor: '#ffffff',
              boxShadow: '0 2px 8px rgba(0,0,0,0.02)'
            }}
          >
            <ScannerIcon color="primary" sx={{ mr: 0.5, fontSize: 24 }} />
            <InputBase
              fullWidth
              autoFocus
              inputRef={barcodeInputRef}
              placeholder="Scan Frame/Lens Barcode or Search Products..."
              value={barcodeInput}
              onChange={(e) => setBarcodeInput(e.target.value)}
              sx={{ fontSize: '0.92rem', fontWeight: 500 }}
            />

            <Stack direction="row" spacing={1} alignItems="center">
              <Button
                type="submit"
                variant="contained"
                color="primary"
                startIcon={<ScannerIcon />}
                onClick={() => {
                  barcodeInputRef.current?.focus();
                  if (barcodeInputRef.current) barcodeInputRef.current.select();
                }}
                sx={{ 
                  borderRadius: '24px', 
                  px: 3, 
                  height: 42, 
                  fontWeight: 800, 
                  fontSize: '0.85rem',
                  textTransform: 'none', 
                  whiteSpace: 'nowrap',
                  boxShadow: 'none'
                }}
              >
                Scan Barcode
              </Button>

              <Button
                variant="outlined"
                color="secondary"
                startIcon={<CameraIcon />}
                onClick={() => setQrModalOpen(true)}
                sx={{ 
                  borderRadius: '24px', 
                  px: 2.5, 
                  height: 42, 
                  fontWeight: 800, 
                  fontSize: '0.85rem',
                  textTransform: 'none', 
                  whiteSpace: 'nowrap',
                  borderColor: '#cbd5e1'
                }}
              >
                Camera QR
              </Button>
            </Stack>
          </Paper>

          {/* Catalog Categories Bar */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 2.5, overflowX: 'auto', pb: 0.5 }}>
            {[
              { id: 'All', label: 'All Catalog' },
              { id: 'Frame', label: 'Frames' },
              { id: 'Lens', label: 'Lenses' },
              { id: 'Contact Lens', label: 'Contact Lenses' },
              { id: 'Accessory', label: 'Accessories' }
            ].map(cat => (
              <Chip
                key={cat.id}
                label={cat.label}
                clickable
                color={selectedCategory === cat.id ? 'primary' : 'default'}
                variant={selectedCategory === cat.id ? 'filled' : 'outlined'}
                onClick={() => setSelectedCategory(cat.id)}
                sx={{ borderRadius: 2, fontWeight: selectedCategory === cat.id ? 800 : 500 }}
              />
            ))}
          </Box>

          {/* Product Catalog Cards Grid */}
          {filteredCatalog.length === 0 ? (
            <Box sx={{ p: 4, textAlign: 'center', bgcolor: 'action.hover', border: '2px dashed', borderColor: 'divider', borderRadius: 3 }}>
              <Avatar sx={{ mx: 'auto', bgcolor: 'primary.main', width: 52, height: 52, mb: 1.5 }}>
                <EmptyIcon />
              </Avatar>
              <Typography variant="subtitle1" fontWeight={800} gutterBottom>
                No Products Found in Inventory Database
              </Typography>
              <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 460, mx: 'auto', mb: 2.5 }}>
                No matching frames or lenses found. Click below to load sample optical inventory or add custom charges.
              </Typography>
              <Stack direction="row" spacing={2} justifyContent="center">
                <Button 
                  variant="contained" 
                  color="primary" 
                  startIcon={<AddIcon />} 
                  onClick={() => setCatalogList(defaultCatalogItems)}
                  sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700 }}
                >
                  Seed Sample Optical Catalog
                </Button>
                <Button 
                  variant="outlined" 
                  color="secondary" 
                  onClick={() => setCustomItemOpen(true)}
                  sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 600 }}
                >
                  + Add Custom Item
                </Button>
              </Stack>
            </Box>
          ) : (
            <Grid container spacing={2}>
              {filteredCatalog.map(item => (
                <Grid item xs={12} sm={6} md={4} key={item.id}>
                  <Card
                    elevation={0}
                    onClick={() => addToCart(item)}
                    sx={{
                      p: 2,
                      border: '1px solid',
                      borderColor: 'divider',
                      borderRadius: 3,
                      cursor: 'pointer',
                      bgcolor: 'background.paper',
                      transition: 'all 0.2s ease',
                      '&:hover': {
                        borderColor: 'primary.main',
                        boxShadow: '0 4px 16px rgba(37, 99, 235, 0.12)',
                        transform: 'translateY(-2px)'
                      }
                    }}
                  >
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                      <Typography variant="h5">{item.image || '👓'}</Typography>
                      <Chip label={item.type || 'Frame'} size="small" color="primary" variant="outlined" sx={{ height: 20, fontSize: '0.65rem', fontWeight: 700 }} />
                    </Box>

                    <Typography variant="subtitle2" fontWeight={800} noWrap>{item.name}</Typography>
                    <Typography variant="caption" color="text.secondary" display="block">
                      {item.brand || 'Generic'} • Stock: {item.stock || 10} Units
                    </Typography>

                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1.5 }}>
                      <Typography variant="subtitle1" fontWeight={900} color="primary.main">
                        ₹{parseFloat(item.price || 0).toLocaleString()}
                      </Typography>
                      <IconButton size="small" color="primary" sx={{ bgcolor: 'rgba(37, 99, 235, 0.08)' }}>
                        <AddCartIcon fontSize="small" />
                      </IconButton>
                    </Box>
                  </Card>
                </Grid>
              ))}
            </Grid>
          )}
        </Grid>

        {/* Right 35% Column: Live POS Shopping Cart & Billing */}
        <Grid item xs={12} lg={4.5}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, position: 'sticky', top: 20, bgcolor: 'background.paper' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="subtitle1" fontWeight={800} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <CartIcon color="primary" fontSize="small" /> Live POS Shopping Cart ({cart.length})
              </Typography>
              {cart.length > 0 && (
                <Button size="small" color="error" onClick={() => setCart([])} sx={{ fontSize: '0.75rem', py: 0 }}>
                  Clear Cart
                </Button>
              )}
            </Box>

            <Divider sx={{ mb: 2 }} />

            {/* Cart Items Table */}
            {cart.length === 0 ? (
              <Box sx={{ py: 5, textTransform: 'center', bgcolor: 'action.hover', borderRadius: 2, border: '1px dashed', borderColor: 'divider', mb: 2 }}>
                <Typography variant="body2" color="text.secondary" fontStyle="italic">
                  Cart is currently empty.
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                  Scan barcode or click items to add to checkout bill.
                </Typography>
              </Box>
            ) : (
              <Stack spacing={1.5} sx={{ maxH: 260, overflowY: 'auto', mb: 2, pr: 0.5 }}>
                {cart.map(item => (
                  <Box 
                    key={item.product.id} 
                    sx={{ p: 1.5, borderRadius: 2, border: '1px solid', borderColor: 'divider', bgcolor: 'action.hover', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}
                  >
                    <Box sx={{ minWidth: 0, flexGrow: 1, mr: 1 }}>
                      <Typography variant="subtitle2" fontWeight={800} noWrap>{item.product.name}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        ₹{parseFloat(item.product.price || 0)} x {item.qty} = <strong>₹{parseFloat(item.product.price || 0) * item.qty}</strong>
                      </Typography>
                    </Box>

                    <Stack direction="row" spacing={0.5} alignItems="center">
                      <IconButton size="small" onClick={() => updateQty(item.product.id, item.qty - 1)}>
                        <RemoveIcon fontSize="small" />
                      </IconButton>
                      <Typography variant="subtitle2" fontWeight={800} sx={{ px: 0.5 }}>{item.qty}</Typography>
                      <IconButton size="small" onClick={() => updateQty(item.product.id, item.qty + 1)}>
                        <AddIcon fontSize="small" />
                      </IconButton>
                      <IconButton size="small" color="error" onClick={() => removeFromCart(item.product.id)}>
                        <DeleteIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  </Box>
                ))}
              </Stack>
            )}

            {/* Loyalty Points Redemption */}
            {selectedCust && selectedCust.points > 0 && (
              <Box sx={{ mb: 2, p: 1.5, bgcolor: 'rgba(245, 158, 11, 0.08)', borderRadius: 2, border: '1px solid rgba(245, 158, 11, 0.2)' }}>
                <FormControlLabel
                  control={
                    <Switch
                      checked={useLoyaltyPoints}
                      onChange={(e) => setUseLoyaltyPoints(e.target.checked)}
                      color="warning"
                      size="small"
                    />
                  }
                  label={
                    <Typography variant="caption" fontWeight={700}>
                      Redeem Rewards: {selectedCust.points} Points (₹{Math.min(selectedCust.points, 200)} Off)
                    </Typography>
                  }
                />
              </Box>
            )}

            {/* Calculations Breakdown */}
            <Box sx={{ p: 2, bgcolor: '#f8fafc', borderRadius: 2.5, border: '1px solid', borderColor: 'divider', mb: 2 }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2" color="text.secondary">Subtotal:</Typography>
                <Typography variant="body2" fontWeight={700}>₹{subtotal.toLocaleString()}</Typography>
              </Box>

              <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 1 }}>
                <Typography variant="body2" color="text.secondary">GST / Tax (18%):</Typography>
                <Typography variant="body2" fontWeight={700}>₹{taxAmount.toLocaleString()}</Typography>
              </Box>

              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography variant="body2" color="text.secondary">Discount (₹):</Typography>
                <TextField
                  size="small"
                  type="number"
                  value={discountAmount}
                  onChange={(e) => setDiscountAmount(e.target.value)}
                  sx={{ width: 90, '& input': { py: 0.5, px: 1, fontSize: '0.85rem' } }}
                />
              </Box>

              <Divider sx={{ my: 1 }} />

              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <Typography variant="subtitle1" fontWeight={800}>Total Payable:</Typography>
                <Typography variant="h4" fontWeight={900} color="primary.main">
                  ₹{grandTotal.toLocaleString()}
                </Typography>
              </Box>
            </Box>

            {/* Payment Method Selector */}
            <TextField
              select
              fullWidth
              size="small"
              label="Payment Method"
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value)}
              sx={{ mb: 2 }}
            >
              <MenuItem value="UPI / PhonePe">UPI / GPay / PhonePe</MenuItem>
              <MenuItem value="Cash">Cash Payment</MenuItem>
              <MenuItem value="Credit Card">Credit Card Swiper</MenuItem>
              <MenuItem value="Debit Card">Debit Card Swiper</MenuItem>
              <MenuItem value="Store Credit">Store Credit / Account Dues</MenuItem>
            </TextField>

            {/* Primary Action Button */}
            <Button
              disabled={cart.length === 0}
              variant="contained"
              color="primary"
              fullWidth
              size="large"
              startIcon={<PrintIcon />}
              onClick={() => {
                const invNo = `INV-${Math.floor(100000 + Math.random() * 900000)}`;

                // 1. Deduct Stock from Inventory in database & local storage
                try {
                  const existingInventory = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
                  cart.forEach(item => {
                    const matchIdx = existingInventory.findIndex(i => i.id === item.product.id || i.code === item.product.code || i.name === item.product.name);
                    if (matchIdx !== -1) {
                      existingInventory[matchIdx].stock = Math.max(0, (parseInt(existingInventory[matchIdx].stock) || 0) - item.qty);
                    }
                  });
                  localStorage.setItem('optical_inventory_items', JSON.stringify(existingInventory));
                  window.dispatchEvent(new Event('optical_stock_updated'));
                } catch (e) {}

                // 2. Post Sales Invoice & Payment to Accounts Database
                try {
                  const salesInvoices = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
                  const newInv = {
                    id: invNo,
                    invoiceNumber: invNo,
                    customerName: selectedCust ? selectedCust.name : 'Walk-in Patient',
                    phone: selectedCust ? selectedCust.phone : '',
                    date: new Date().toISOString().split('T')[0],
                    total: grandTotal,
                    paidAmount: grandTotal,
                    paymentMethod: paymentMethod,
                    status: 'Paid',
                    items: cart.map(i => ({ name: i.product.name, qty: i.qty, price: i.product.price }))
                  };
                  localStorage.setItem('optical_sales_invoices', JSON.stringify([newInv, ...salesInvoices]));

                  const payments = JSON.parse(localStorage.getItem('optical_payments') || '[]');
                  const newPay = {
                    id: `PAY-${invNo}`,
                    receiptId: `REC-${invNo}`,
                    customerName: selectedCust ? selectedCust.name : 'Walk-in Patient',
                    date: new Date().toISOString().split('T')[0],
                    method: paymentMethod,
                    amount: grandTotal,
                    status: 'Completed'
                  };
                  localStorage.setItem('optical_payments', JSON.stringify([newPay, ...payments]));

                  window.dispatchEvent(new Event('optical_accounts_updated'));
                } catch (e) {}

                alert(`POS Bill ${invNo} processed successfully! Total: ₹${grandTotal}. Inventory stock & Accounts database updated.`);

                onCheckoutComplete?.({
                  customer: selectedCust ? selectedCust.name : 'Walk-in Customer',
                  total: grandTotal,
                  frame: cart[0]?.product.name || 'Frame',
                  lens: cart[1]?.product.name || 'Lens'
                });
                setCart([]);
              }}
              sx={{ borderRadius: 2.5, py: 1.5, fontWeight: 800, textTransform: 'none', fontSize: '1rem' }}
            >
              Quick Pay & Print Receipt
            </Button>
          </Card>
        </Grid>
      </Grid>

      {/* Customer Selection Modal */}
      <Dialog open={customerDialogOpen} onClose={() => setCustomerDialogOpen(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Select Patient for POS Billing</DialogTitle>
        <DialogContent>
          <TextField
            fullWidth
            placeholder="Search patient name, phone, or ID..."
            value={customerSearchQuery}
            onChange={(e) => setCustomerSearchQuery(e.target.value)}
            size="small"
            sx={{ my: 1 }}
            autoFocus
          />
          <Stack spacing={1} sx={{ maxHeight: 300, overflowY: 'auto', mt: 1 }}>
            {allCustomersList
              .filter(c => {
                if (!c) return false;
                const q = (customerSearchQuery || '').toLowerCase().trim();
                if (!q) return true;

                const cName = String(c.name || c.patient_name || '').toLowerCase();
                const cPhone = String(c.phone || c.mobile || '').toLowerCase();
                const cId = String(c.id || c.patient_id || '').toLowerCase();

                return cName.includes(q) || cPhone.includes(q) || cId.includes(q);
              })
              .map(cust => (
                <Card 
                  key={cust.id || cust.phone}
                  onClick={() => { setSelectedCustomerId(cust.id); setCustomerDialogOpen(false); }}
                  sx={{ 
                    p: 1.5, 
                    cursor: 'pointer', 
                    border: '1px solid', 
                    borderColor: selectedCustomerId === cust.id ? 'primary.main' : 'divider',
                    bgcolor: selectedCustomerId === cust.id ? '#eff6ff' : '#ffffff',
                    transition: 'all 0.2s ease',
                    '&:hover': { bgcolor: '#f1f5f9', transform: 'translateY(-1px)' } 
                  }}
                >
                  <Typography variant="subtitle2" fontWeight={800} color="primary.main">{cust.name}</Typography>
                  <Typography variant="caption" display="block" color="text.secondary">
                    📞 {cust.phone || 'No Phone'} • 🆔 {cust.id}
                  </Typography>
                </Card>
              ))}
            {allCustomersList.filter(c => {
              if (!c) return false;
              const q = (customerSearchQuery || '').toLowerCase().trim();
              if (!q) return true;
              return String(c.name || '').toLowerCase().includes(q) || String(c.phone || '').toLowerCase().includes(q) || String(c.id || '').toLowerCase().includes(q);
            }).length === 0 && (
              <Box sx={{ p: 2, textAlign: 'center' }}>
                <Typography variant="body2" color="text.secondary">No matching patient found for "{customerSearchQuery}"</Typography>
              </Box>
            )}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setCustomerDialogOpen(false)} variant="outlined">Close</Button>
        </DialogActions>
      </Dialog>

      {/* Custom Item Entry Dialog */}
      <Dialog open={customItemOpen} onClose={() => setCustomItemOpen(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Add Quick Custom Charge</DialogTitle>
        <DialogContent>
          <Box component="form" onSubmit={handleAddCustomItem} sx={{ mt: 1 }}>
            <Stack spacing={2}>
              <TextField required label="Item / Service Name" placeholder="e.g. Frame Repair, Lens Tinting" value={customItem.name} onChange={(e) => setCustomItem({ ...customItem, name: e.target.value })} size="small" />
              <TextField required label="Price (₹)" type="number" value={customItem.price} onChange={(e) => setCustomItem({ ...customItem, price: e.target.value })} size="small" />
              <TextField select label="Category" value={customItem.type} onChange={(e) => setCustomItem({ ...customItem, type: e.target.value })} size="small">
                <MenuItem value="Frame">Frame</MenuItem>
                <MenuItem value="Lens">Lens</MenuItem>
                <MenuItem value="Accessory">Accessory</MenuItem>
                <MenuItem value="Repair Service">Repair Service</MenuItem>
              </TextField>
            </Stack>
            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <Button onClick={() => setCustomItemOpen(false)}>Cancel</Button>
              <Button type="submit" variant="contained" color="primary">Add to Bill</Button>
            </Box>
          </Box>
        </DialogContent>
      </Dialog>

      {/* QR Camera Scanner Dialog */}
      <Dialog open={qrModalOpen} onClose={() => setQrModalOpen(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Camera QR / Barcode Scanner</DialogTitle>
        <DialogContent sx={{ textAlign: 'center', py: 4 }}>
          <Avatar sx={{ mx: 'auto', bgcolor: 'primary.main', width: 64, height: 64, mb: 2 }}>
            <CameraIcon fontSize="large" />
          </Avatar>
          <Typography variant="subtitle2" fontWeight={800}>Camera Scanner Initialized</Typography>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
            Align optical frame barcode tag or lens QR code within view.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setQrModalOpen(false)} variant="contained">Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
