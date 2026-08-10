import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import QuickDatePickerField from '../components/common/QuickDatePickerField';
import PurchaseEntryView from '../components/purchasing/PurchaseEntryView';
import { useDebounce } from '../hooks/useDebounce';
import { 
  Box, Card, CardContent, Typography, Button, Tab, Tabs, 
  Grid, Table, TableBody, TableCell, TableContainer, 
  TableHead, TableRow, Paper, Chip, Dialog, 
  DialogTitle, DialogContent, DialogActions, TextField, 
  MenuItem, Stack, IconButton, Divider, Tooltip, InputAdornment, Autocomplete
} from '@mui/material';


import {
  Add as AddIcon,
  Search as SearchIcon,
  LocalShipping as ShippingIcon,
  ReceiptLong as POIcon,
  Inventory2 as ReceiveIcon,
  AssignmentReturn as ReturnIcon,
  Business as SupplierIcon,
  Delete as DeleteIcon,
  CheckCircle as SuccessIcon,
  Warning as WarningIcon,
  CloudUpload as CloudUploadIcon
} from '@mui/icons-material';

import axios from 'axios';

export default function Purchases() {
  const location = useLocation();
  const navigate = useNavigate();

  // Tab sync from path
  const getTabFromPath = (pathname) => {
    if (pathname.includes('/purchase/suppliers')) return 'suppliers';
    if (pathname.includes('/purchase/orders')) return 'orders';
    if (pathname.includes('/purchase/receive') || pathname.includes('/purchase/stock-receive')) return 'receive';
    if (pathname.includes('/purchase/returns')) return 'returns';
    return 'entry';
  };

  const [activeTab, setActiveTab] = useState(getTabFromPath(location.pathname));
  const [entryPrefillSupplierId, setEntryPrefillSupplierId] = useState('');
  const [entryPrefillPoId, setEntryPrefillPoId] = useState('');

  useEffect(() => {
    setActiveTab(getTabFromPath(location.pathname));
  }, [location.pathname]);

  const handleTabChange = (event, newValue) => {
    setActiveTab(newValue);
    if (newValue === 'entry') navigate('/purchase/entry');
    if (newValue === 'suppliers') navigate('/purchase/suppliers');
    if (newValue === 'orders') navigate('/purchase/orders');
    if (newValue === 'receive') navigate('/purchase/receive');
    if (newValue === 'returns') navigate('/purchase/returns');
  };

  const goToNewPurchaseEntry = (supplierId, poId) => {
    setEntryPrefillSupplierId(supplierId || '');
    setEntryPrefillPoId(poId || '');
    setActiveTab('entry');
    navigate('/purchase/entry');
  };

  // Database State (Starts 100% Blank as requested)
  const [suppliers, setSuppliers] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [stockReceives, setStockReceives] = useState([]);
  const [purchaseReturns, setPurchaseReturns] = useState([]);
  const [products, setProducts] = useState([]);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');

  // Modal Dialog States
  const [addSupplierOpen, setAddSupplierOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [createPoOpen, setCreatePoOpen] = useState(false);
  const [selectedPo, setSelectedPo] = useState(null);

  // Form Inputs (All start blank)
  const [supplierInput, setSupplierInput] = useState({
    name: '', contactPerson: '', phone: '', email: '', gstin: '', address: '', city: '', paymentTerms: 'Net 30'
  });

  const [returnInput, setReturnInput] = useState({
    supplierName: '', itemName: '', qtyReturned: '', reason: 'Defective Frame Coating', creditAmount: ''
  });

  // New Purchase Order form: an order sent to a supplier, ahead of goods being received
  const [poHeader, setPoHeader] = useState({ supplierId: '', expectedDate: '' });
  const [poItems, setPoItems] = useState([]);
  const [poProductPick, setPoProductPick] = useState(null);

  const isCorruptSupplierName = (name) => {
    if (!name || typeof name !== 'string') return true;
    const s = name.trim();
    if (!s || s.length > 150) return true;
    if (s.startsWith('PK') || s.includes('[Content_Types]') || s.includes('_rels') || s.includes('xl/worksheets') || s.includes('.xml')) return true;
    if (/[\u0000-\u0008\u000E-\u001F]/.test(s)) return true;
    if (s.includes('===') || s.includes('???') || s.includes('')) return true;
    return false;
  };

  const DUMMY_SAMPLE_NAMES = [
    'Essilor Vision Care India Pvt Ltd',
    'Luxottica India Eyewear Pvt Ltd',
    'Carl Zeiss India Optical Pvt Ltd',
    'Safilo India Pvt Ltd',
    'Hoya Lens India Pvt Ltd',
    'Marchon Eyewear India Pvt Ltd',
    'Johnson & Johnson Vision Care',
    'Bausch & Lomb India Pvt Ltd',
    'Essilor Vision Care',
    'Luxottica India',
    'Carl Zeiss India',
    'Safilo India',
    'Hoya Lens',
    'Marchon Eyewear',
    'Johnson & Johnson',
    'Bausch & Lomb'
  ];

  const isSampleOrCorrupt = (supp) => {
    if (!supp) return true;
    const name = typeof supp === 'string' ? supp : (supp.name || supp.company_name || supp.company || '');
    const id = typeof supp === 'object' ? String(supp.id || '') : '';
    if (isCorruptSupplierName(name)) return true;
    if (id.startsWith('SUP-10')) return true;
    if (DUMMY_SAMPLE_NAMES.some(d => name.trim().toLowerCase().includes(d.toLowerCase()))) return true;
    return false;
  };

  // Helper: Gather all unique supplier names from registered DB, POs & Inventory
  const getDatabaseSupplierNames = () => {
    let invSuppliers = [];
    try {
      const items = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
      invSuppliers = items.map(i => i.supplier).filter(Boolean);
    } catch(e) {}
    
    const poSupps = purchaseOrders.map(p => p.supplier).filter(Boolean);
    const grnSupps = stockReceives.map(r => r.supplier).filter(Boolean);
    const regSupps = suppliers.map(s => s.name || s.company_name || s.company).filter(Boolean);
    
    return Array.from(new Set([
      ...regSupps,
      ...poSupps,
      ...grnSupps,
      ...invSuppliers
    ])).filter(name => !isSampleOrCorrupt(name));
  };

  // Backend Sync & LocalStorage Sync
  useEffect(() => {
    // Auto-wipe any leftover legacy sample data from browser localStorage
    try {
      const rawDB = localStorage.getItem('optical_suppliers_db') || '';
      const rawNames = localStorage.getItem('optical_suppliers') || '';
      if (rawDB.includes('SUP-10') || rawDB.includes('Essilor') || rawNames.includes('Essilor') || rawNames.includes('SUP-10')) {
        localStorage.removeItem('optical_suppliers_db');
        localStorage.removeItem('optical_suppliers');
      }
    } catch(e) {}

    const fetchPurchaseData = async () => {
      let localSupps = [];
      try {
        const savedDB = JSON.parse(localStorage.getItem('optical_suppliers_db') || '[]');
        if (Array.isArray(savedDB) && savedDB.length > 0) {
          localSupps = savedDB.filter(s => !isSampleOrCorrupt(s));
        } else {
          const savedNames = JSON.parse(localStorage.getItem('optical_suppliers') || '[]');
          if (Array.isArray(savedNames) && savedNames.length > 0) {
            localSupps = savedNames
              .filter(name => !isSampleOrCorrupt(name))
              .map((name, i) => ({ id: `SUP-LOC-${i}`, name, balance: 0 }));
          } else {
            localSupps = [];
          }
        }
      } catch (e) {
        localSupps = [];
      }

      localSupps = localSupps.filter(s => !isSampleOrCorrupt(s));

      // Force clean localStorage from any sample or corrupt data
      try {
        const cleanNames = localSupps.map(s => s.name || s.company);
        localStorage.setItem('optical_suppliers', JSON.stringify(cleanNames));
        localStorage.setItem('optical_suppliers_db', JSON.stringify(localSupps));
      } catch (e) {}

      try {
        let res;
        try {
          res = await axios.get('/api/purchase/suppliers/');
        } catch (e1) {
          res = await axios.get('/api/purchasing/suppliers/');
        }
        const rawBackend = res.data?.results || res.data || [];
        if (Array.isArray(rawBackend) && rawBackend.length > 0) {
          const cleanBackend = rawBackend.filter(s => !isSampleOrCorrupt(s));
          setSuppliers(cleanBackend);
        } else {
          setSuppliers(localSupps);
        }
      } catch (err) {
        setSuppliers(localSupps);
      }
    };
    fetchPurchaseData();
    window.addEventListener('optical_suppliers_updated', fetchPurchaseData);
    return () => window.removeEventListener('optical_suppliers_updated', fetchPurchaseData);
  }, []);

  // Products for the Purchase Entry search bar & grid
  useEffect(() => {
    const fetchProducts = async () => {
      let localProds = [];
      try {
        localProds = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
      } catch (e) {}

      const normalize = (p) => ({
        id: String(p.id || p.code || p.barcode),
        name: p.name,
        sku: p.code || p.sku || '',
        barcode: p.barcode || '',
        costPrice: parseFloat(p.purchasePrice || p.cost_price || p.costPrice || 0) || 0,
        retailPrice: parseFloat(p.sellingPrice || p.retail_price || p.retailPrice || p.price || 0) || 0,
        stock: parseInt(p.stock) || 0,
        taxRate: parseFloat(p.taxRate || p.tax_rate) || 18
      });

      if (localProds.length > 0) {
        setProducts(localProds.map(normalize));
      }

      try {
        const res = await axios.get('/api/products/products/');
        const raw = res.data?.results || res.data || [];
        if (Array.isArray(raw) && raw.length > 0) {
          setProducts(prev => {
            const map = new Map();
            [...prev, ...raw.map(normalize)].forEach(item => map.set(item.id || item.name, item));
            return Array.from(map.values());
          });
        }
      } catch (e) {}
    };
    fetchProducts();
    window.addEventListener('optical_stock_updated', fetchProducts);
    return () => window.removeEventListener('optical_stock_updated', fetchProducts);
  }, []);

  // Purchase Orders sent to suppliers (source list for the "Convert to Purchase" flow)
  const fetchPurchaseOrders = async () => {
    try {
      const res = await axios.get('/api/purchase/orders/');
      const raw = res.data?.results || res.data || [];
      if (Array.isArray(raw)) {
        setPurchaseOrders(raw.map(po => ({
          id: po.order_number,
          poId: po.id,
          supplier: suppliers.find(s => String(s.id) === String(po.supplier))?.name || 'Supplier',
          supplierId: po.supplier,
          item: `${po.items?.length || 0} item(s)`,
          category: 'Purchase Order',
          date: po.order_date,
          expectedDate: po.order_date,
          qty: (po.items || []).reduce((s, it) => s + (parseInt(it.quantity) || 0), 0),
          total: parseFloat(po.total_amount || 0),
          status: po.status === 'RECEIVED' ? 'Completed' : po.status === 'CANCELLED' ? 'Cancelled' : 'Sent to Vendor'
        })));
      }
    } catch (e) {}
  };

  useEffect(() => {
    if (suppliers.length > 0) fetchPurchaseOrders();
  }, [suppliers]);

  // Handlers
  const handleSaveSupplier = async () => {
    if (!supplierInput.name) {
      alert("Please enter Supplier Company Name.");
      return;
    }
    const newSupp = {
      id: `SUP-${Math.floor(100 + Math.random() * 900)}`,
      ...supplierInput,
      balance: 0
    };
    setSuppliers([newSupp, ...suppliers]);

    // Save to localStorage for instant sync with Products page
    try {
      const existingSaved = JSON.parse(localStorage.getItem('optical_suppliers') || '[]');
      const newSaved = Array.from(new Set([newSupp.name, ...existingSaved]));
      localStorage.setItem('optical_suppliers', JSON.stringify(newSaved));
    } catch (e) {}

    // POST to backend API
    try {
      try {
        await axios.post('/api/purchase/suppliers/', {
          name: newSupp.name,
          contact_person: newSupp.contactPerson,
          phone: newSupp.phone,
          email: newSupp.email,
          gstin: newSupp.gstin
        });
      } catch (e1) {
        await axios.post('/api/purchasing/suppliers/', {
          name: newSupp.name,
          contact_person: newSupp.contactPerson,
          phone: newSupp.phone,
          email: newSupp.email,
          gstin: newSupp.gstin
        });
      }
    } catch (e) {}

    setSupplierInput({ name: '', contactPerson: '', phone: '', email: '', gstin: '', address: '', city: '', paymentTerms: 'Net 30' });
    setAddSupplierOpen(false);
    alert(`Supplier '${newSupp.name}' registered to database successfully!`);
  };

  // Load SheetJS XLSX Parser Library dynamically
  const loadSheetJS = () => {
    return new Promise((resolve, reject) => {
      if (window.XLSX) {
        resolve(window.XLSX);
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js';
      script.onload = () => resolve(window.XLSX);
      script.onerror = () => reject(new Error('Failed to load SheetJS XLSX library'));
      document.body.appendChild(script);
    });
  };

  // Excel / CSV File Upload Handler for Batch Suppliers Import
  const handleExcelSupplierUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const XLSX = await loadSheetJS();
      const arrayBuffer = await file.arrayBuffer();
      const workbook = XLSX.read(arrayBuffer, { type: 'array' });
      const firstSheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[firstSheetName];
      const rawRows = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });

      if (!rawRows || rawRows.length === 0) {
        alert("The uploaded Excel sheet is empty.");
        event.target.value = '';
        return;
      }

      // Determine header row and column mapping
      let startIdx = 0;
      let nameIdx = 0, contactIdx = 1, phoneIdx = 2, emailIdx = 3, gstinIdx = 4, cityIdx = 5, termsIdx = 6;

      const firstRowStr = (rawRows[0] || []).join(' ').toLowerCase();
      if (firstRowStr.includes('supplier') || firstRowStr.includes('name') || firstRowStr.includes('company') || firstRowStr.includes('contact') || firstRowStr.includes('gstin')) {
        startIdx = 1;
        const headers = rawRows[0].map(h => String(h || '').trim().toLowerCase());
        headers.forEach((h, idx) => {
          if (h.includes('company') || h.includes('name') || h.includes('supplier')) nameIdx = idx;
          else if (h.includes('contact') || h.includes('person')) contactIdx = idx;
          else if (h.includes('phone') || h.includes('mobile') || h.includes('tel')) phoneIdx = idx;
          else if (h.includes('email') || h.includes('mail')) emailIdx = idx;
          else if (h.includes('gst') || h.includes('tax')) gstinIdx = idx;
          else if (h.includes('city') || h.includes('hub') || h.includes('address') || h.includes('location')) cityIdx = idx;
          else if (h.includes('term') || h.includes('payment')) termsIdx = idx;
        });
      }

      const imported = [];
      for (let i = startIdx; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row || !Array.isArray(row) || row.every(cell => !String(cell).trim())) continue;

        const name = String(row[nameIdx] || row[0] || '').trim();
        if (!name || isCorruptSupplierName(name)) continue;

        const contactPerson = String(row[contactIdx] || '').trim() || 'N/A';
        const phone = String(row[phoneIdx] || '').trim() || 'N/A';
        const email = String(row[emailIdx] || '').trim() || 'N/A';
        const gstin = String(row[gstinIdx] || '').trim() || 'N/A';
        const city = String(row[cityIdx] || '').trim() || 'Main Hub';
        const paymentTerms = String(row[termsIdx] || '').trim() || 'Net 30';

        const suppObj = {
          id: `SUP-EXCEL-${Math.floor(1000 + Math.random() * 9000)}`,
          name,
          contactPerson,
          phone,
          email,
          gstin,
          city,
          paymentTerms,
          balance: 0
        };

        imported.push(suppObj);

        // Save supplier to Backend Database API
        try {
          await axios.post('/api/purchasing/suppliers/', {
            name: suppObj.name,
            contact_person: suppObj.contactPerson,
            phone: suppObj.phone,
            email: suppObj.email,
            gstin: suppObj.gstin,
            city: suppObj.city
          });
        } catch (err) {}
      }

      if (imported.length === 0) {
        alert("No valid supplier rows found in the uploaded file.");
        event.target.value = '';
        return;
      }

      // Update Suppliers state & Local Storage sync
      const updatedSuppliers = [...imported, ...suppliers];
      setSuppliers(updatedSuppliers);

      try {
        const namesOnly = updatedSuppliers.map(s => s.name);
        localStorage.setItem('optical_suppliers', JSON.stringify(namesOnly));
        localStorage.setItem('optical_suppliers_db', JSON.stringify(updatedSuppliers));
        window.dispatchEvent(new Event('optical_suppliers_updated'));
      } catch (err) {}

      setAddSupplierOpen(false);
      alert(`Successfully imported ${imported.length} supplier(s) from Excel file into Database!`);
    } catch (err) {
      console.error("Excel upload error:", err);
      alert("Error reading Excel spreadsheet (.xlsx / .xls). Please ensure it is a valid Excel or CSV file.");
    }
    event.target.value = '';
  };

  // Sample Excel Supplier CSV Template Generator
  const handleDownloadSupplierTemplate = () => {
    const csvContent = "Supplier Company Name,Contact Person Name,Phone Number,Email Address,GSTIN Number,City / Hub,Payment Terms\n" +
      "Luxottica Eyewear Ltd,Robert Smith,+91 9876543210,orders@luxottica.com,07AAAAA0000A1Z5,New Delhi,Net 30\n" +
      "Essilor Lenses India,Anil Kumar,+91 9845012345,supply@essilor.in,29BBBBB1111B2Z6,Bengaluru,Net 15\n" +
      "Safilo Optics Pvt Ltd,Priya Sharma,+91 9900112233,contact@safilo.com,27CCCCC2222C3Z7,Mumbai,Net 60";

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "Optical_Suppliers_Import_Template.csv";
    a.click();
  };

  const addPoProductLine = (product) => {
    if (!product) return;
    if (poItems.some(i => i.productId === product.id)) return;
    setPoItems(prev => [...prev, {
      productId: product.id,
      productName: product.name,
      qty: 1,
      rate: parseFloat(product.costPrice || 0) || 0,
      taxRate: parseFloat(product.taxRate) || 18
    }]);
    setPoProductPick(null);
  };

  const updatePoItem = (idx, field, value) => {
    setPoItems(prev => prev.map((it, i) => i === idx ? { ...it, [field]: value } : it));
  };

  const removePoItem = (idx) => setPoItems(prev => prev.filter((_, i) => i !== idx));

  const handleSavePo = async () => {
    if (!poHeader.supplierId || poItems.length === 0) {
      alert("Please select a Supplier and add at least one product line.");
      return;
    }

    const items = poItems.map(it => {
      const qty = parseInt(it.qty) || 0;
      const rate = parseFloat(it.rate) || 0;
      const taxAmount = +((qty * rate * (parseFloat(it.taxRate) || 0)) / 100).toFixed(2);
      return {
        product: it.productId,
        quantity: qty,
        unit_price: rate,
        tax_rate: it.taxRate,
        tax_amount: taxAmount,
        subtotal: +(qty * rate + taxAmount).toFixed(2)
      };
    });
    const totalAmount = items.reduce((s, it) => s + it.subtotal, 0);
    const taxAmount = items.reduce((s, it) => s + it.tax_amount, 0);

    const payload = {
      order_number: `PO-${Date.now().toString().slice(-8)}`,
      supplier: poHeader.supplierId,
      order_date: new Date().toISOString().split('T')[0],
      status: 'SENT',
      total_amount: totalAmount,
      tax_amount: taxAmount,
      net_amount: totalAmount,
      items
    };

    try {
      await axios.post('/api/purchase/orders/', payload);
      await fetchPurchaseOrders();
      setCreatePoOpen(false);
      setPoHeader({ supplierId: '', expectedDate: '' });
      setPoItems([]);
      alert(`Purchase Order ${payload.order_number} sent to supplier!`);
    } catch (err) {
      alert('Failed to create Purchase Order. Please make sure you are logged in and try again.');
    }
  };

  const handleSaveReturn = () => {
    if (!returnInput.supplierName || !returnInput.itemName) {
      alert("Please select Supplier and enter Item Name.");
      return;
    }
    const newReturn = {
      id: `RTV-${Math.floor(1000 + Math.random() * 9000)}`,
      supplier: returnInput.supplierName,
      item: returnInput.itemName,
      qty: parseInt(returnInput.qtyReturned) || 1,
      reason: returnInput.reason,
      creditAmount: parseFloat(returnInput.creditAmount) || 0,
      date: new Date().toISOString().split('T')[0],
      status: 'Pending Credit Note'
    };
    setPurchaseReturns([newReturn, ...purchaseReturns]);
    setReturnInput({ supplierName: '', itemName: '', qtyReturned: '', reason: 'Defective Frame Coating', creditAmount: '' });
    setReturnOpen(false);
    alert(`Purchase Return ${newReturn.id} logged for ${newReturn.supplier}!`);
  };

  const debouncedSearchQuery = useDebounce(searchQuery, 150);

  const cleanSuppList = useMemo(() => {
    return suppliers.filter(s => !isSampleOrCorrupt(s));
  }, [suppliers]);

  const filteredSuppliers = useMemo(() => {
    const s = (debouncedSearchQuery || '').toLowerCase().trim();
    if (!s) return cleanSuppList;
    return cleanSuppList.filter(supp => 
      (supp.name && supp.name.toLowerCase().includes(s)) ||
      (supp.contactPerson && supp.contactPerson.toLowerCase().includes(s)) ||
      (supp.phone && supp.phone.toLowerCase().includes(s)) ||
      (supp.gstin && supp.gstin.toLowerCase().includes(s))
    );
  }, [cleanSuppList, debouncedSearchQuery]);

  const totalPayables = useMemo(() => {
    return cleanSuppList.reduce((sum, s) => sum + (parseFloat(s.balance) || 0), 0);
  }, [cleanSuppList]);

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Top Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" fontWeight={800}>Optical Purchasing & Inventory Replenishment</Typography>
          <Typography variant="body2" color="text.secondary">Single-screen Purchase Entry plus supplier, order history & returns management</Typography>
        </Box>
        <Stack direction="row" spacing={1.5}>
          {activeTab === 'suppliers' && (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setAddSupplierOpen(true)} sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}>
              + Add New Supplier
            </Button>
          )}
          {activeTab === 'orders' && (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreatePoOpen(true)} sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}>
              + Create Purchase Order
            </Button>
          )}
          {activeTab === 'receive' && (
            <Button variant="contained" startIcon={<AddIcon />} onClick={() => goToNewPurchaseEntry()} sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}>
              + New Purchase Entry
            </Button>
          )}
          {activeTab === 'returns' && (
            <Button variant="contained" startIcon={<ReturnIcon />} onClick={() => setReturnOpen(true)} sx={{ backgroundColor: '#EF4444', color: 'white', fontWeight: 700 }}>
              + Create Purchase Return (RTV)
            </Button>
          )}
        </Stack>
      </Box>

      {/* Main Navigation Tabs */}
      <Card sx={{ mb: 3, borderRadius: 3 }}>
        <Tabs value={activeTab} onChange={handleTabChange} sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="entry" label="Purchase Entry" icon={<AddIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="suppliers" label="Suppliers Directory" icon={<SupplierIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="orders" label="Purchase Orders" icon={<POIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="receive" label="Stock Receive (GRN)" icon={<ReceiveIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="returns" label="Purchase Returns (RTV)" icon={<ReturnIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
        </Tabs>
      </Card>

      {/* 0. PURCHASE ENTRY (single-page POS-style screen) */}
      {activeTab === 'entry' && (
        <PurchaseEntryView
          suppliers={cleanSuppList}
          products={products}
          initialSupplierId={entryPrefillSupplierId}
          initialPurchaseOrderId={entryPrefillPoId}
          onSaveComplete={(invoice) => {
            setEntryPrefillSupplierId('');
            setEntryPrefillPoId('');
            fetchPurchaseOrders();
            const supplierName = invoice.supplierName || 'Supplier';
            setPurchaseOrders(prev => [{
              id: invoice.invoice_number,
              supplier: supplierName,
              item: `${invoice.items?.length || 0} item(s)`,
              category: 'Purchase Entry',
              date: invoice.purchase_date,
              expectedDate: invoice.purchase_date,
              qty: (invoice.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0),
              total: parseFloat(invoice.grand_total || 0),
              status: invoice.status === 'DRAFT' ? 'Draft' : 'Completed'
            }, ...prev]);
            setStockReceives(prev => [{
              id: `GRN-${invoice.invoice_number}`,
              poId: invoice.invoice_number,
              supplier: supplierName,
              item: `${invoice.items?.length || 0} item(s)`,
              barcode: invoice.items?.[0]?.barcode || '',
              qty: (invoice.items || []).reduce((s, it) => s + (parseFloat(it.quantity) || 0), 0),
              date: invoice.purchase_date,
              location: 'Default Warehouse',
              inspector: 'Purchase Entry',
              status: invoice.status === 'DRAFT' ? 'Pending' : 'Verified & Stocked'
            }, ...prev]);
          }}
        />
      )}

      {/* 1. SUPPLIERS DIRECTORY */}
      {activeTab === 'suppliers' && (
          <Stack spacing={3}>
            {/* KPI Metrics Banner */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>REGISTERED SUPPLIERS</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{cleanSuppList.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Optical vendors</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>ACTIVE VENDORS</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">{cleanSuppList.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Verified trade partners</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #ef4444', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>OUTSTANDING PAYABLES</Typography>
                  <Typography variant="h4" fontWeight={850} color="error.main">₹{totalPayables.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Due to suppliers</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>AVG LEAD TIME</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>3 Days</Typography>
                  <Typography variant="caption" color="text.secondary">Optical delivery turnaround</Typography>
                </Paper>
              </Grid>
            </Grid>

            {/* Toolbar Search & Batch Excel Import */}
            <Card 
              variant="outlined" 
              sx={{ 
                p: 2, 
                px: 3, 
                borderRadius: 4, 
                backgroundColor: '#ffffff',
                borderColor: 'divider',
                boxShadow: '0 1px 3px rgba(0,0,0,0.02)'
              }}
            >
              <Grid container spacing={2} alignItems="center">
                <Grid item xs={12} md={6} lg={7}>
                  <TextField 
                    fullWidth 
                    size="small" 
                    placeholder="Search Supplier Name, Contact Person, Phone, or GSTIN..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    InputProps={{ 
                      startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} />,
                      sx: { borderRadius: 3, height: 40, backgroundColor: '#f8fafc' }
                    }}
                  />
                </Grid>
                <Grid item xs={12} md={6} lg={5}>
                  <Stack direction="row" spacing={1.5} justifyContent={{ xs: 'flex-start', md: 'flex-end' }} alignItems="center">
                    <Button
                      variant="outlined"
                      color="error"
                      onClick={async () => {
                        setSuppliers([]);
                        try {
                          localStorage.setItem('optical_suppliers', JSON.stringify([]));
                          localStorage.setItem('optical_suppliers_db', JSON.stringify([]));
                          window.dispatchEvent(new Event('optical_suppliers_updated'));
                        } catch (e) {}
                        alert("Suppliers database cleared! The table is now 100% blank.");
                      }}
                      sx={{ 
                        height: 40, 
                        px: 2, 
                        fontWeight: 700, 
                        borderRadius: 3, 
                        whiteSpace: 'nowrap', 
                        textTransform: 'none',
                        fontSize: '0.825rem'
                      }}
                    >
                      Clear Corrupt / Sample Data
                    </Button>
                    <Button
                      variant="outlined"
                      color="primary"
                      component="label"
                      startIcon={<CloudUploadIcon />}
                      sx={{ 
                        height: 40, 
                        px: 2.5, 
                        fontWeight: 700, 
                        borderRadius: 3, 
                        whiteSpace: 'nowrap', 
                        textTransform: 'none',
                        fontSize: '0.825rem',
                        borderColor: '#2563eb'
                      }}
                    >
                      Upload Excel Sheet
                      <input type="file" hidden accept=".csv, .xlsx, .xls" onChange={handleExcelSupplierUpload} />
                    </Button>
                  </Stack>
                </Grid>
              </Grid>
            </Card>


            {/* Table */}
            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Supplier ID</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Company & Contact Person</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Phone & Email</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>GSTIN</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Payment Terms</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Outstanding Balance</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>Quick Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredSuppliers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            {searchQuery ? "No matching suppliers found." : "No registered optical suppliers found in the database."}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {searchQuery ? "Try refining your search keyword." : "Click '+ Add New Supplier' to register vendors into the database."}
                          </Typography>
                          {!searchQuery && (
                            <Button 
                              size="small" 
                              variant="contained" 
                              startIcon={<AddIcon />} 
                              onClick={() => setAddSupplierOpen(true)} 
                              sx={{ backgroundColor: '#2563EB', mt: 2 }}
                            >
                              + Add First Supplier
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredSuppliers.map(s => (
                        <TableRow key={s.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{s.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>
                            {s.name}
                            {s.contactPerson && (
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                Contact: {s.contactPerson}
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell>
                            {s.phone}
                            {s.email && (
                              <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                                {s.email}
                              </Typography>
                            )}
                          </TableCell>
                          <TableCell>{s.gstin || 'N/A'}</TableCell>
                          <TableCell><Chip label={s.paymentTerms || 'Net 30'} size="small" variant="outlined" /></TableCell>
                          <TableCell sx={{ fontWeight: 700, color: s.balance > 0 ? 'error.main' : 'text.primary' }}>
                            ₹{(s.balance || 0).toFixed(2)}
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button 
                                size="small" 
                                variant="contained" 
                                sx={{ backgroundColor: '#2563EB' }}
                                onClick={() => { setPoHeader({ ...poHeader, supplierId: s.id }); setCreatePoOpen(true); }}
                              >
                                Create PO
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
        )}

      {/* 2. PURCHASE ORDERS (PO) */}
      {activeTab === 'orders' && (() => {
        const filteredOrders = purchaseOrders.filter(p => {
          const searchLower = searchQuery.toLowerCase();
          const matchesSearch = (p.id && p.id.toLowerCase().includes(searchLower)) ||
                                (p.supplier && p.supplier.toLowerCase().includes(searchLower)) ||
                                (p.item && p.item.toLowerCase().includes(searchLower));
          const matchesStatus = statusFilter === 'All' || p.status === statusFilter;
          return matchesSearch && matchesStatus;
        });

        const totalPoVal = purchaseOrders.reduce((sum, p) => sum + (parseFloat(p.total) || 0), 0);

        return (
          <Stack spacing={3}>
            {/* KPI Metrics */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>PURCHASE ORDERS</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{purchaseOrders.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Total POs issued</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>IN VENDOR TRANSIT</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>
                    {purchaseOrders.filter(p => p.status === 'Sent to Vendor').length}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Pending GRN receive</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>COMPLETED POS</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">
                    {purchaseOrders.filter(p => p.status === 'Completed').length}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Fully received & stocked</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL PO VALUE</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>₹{totalPoVal.toFixed(2)}</Typography>
                  <Typography variant="caption" color="text.secondary">Cumulative purchase order commitment</Typography>
                </Paper>
              </Grid>
            </Grid>

            {/* Toolbar */}
            <Card variant="outlined" sx={{ p: 2, px: 3, borderRadius: 4, backgroundColor: '#ffffff', borderColor: 'divider' }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                <TextField 
                  fullWidth 
                  size="small" 
                  placeholder="Search PO Number, Supplier Name, or Ordered Item..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  InputProps={{ 
                    startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} />,
                    sx: { borderRadius: 3, height: 40, backgroundColor: '#f8fafc' }
                  }}
                />
                <TextField 
                  select 
                  size="small" 
                  label="Filter Status" 
                  value={statusFilter} 
                  onChange={(e) => setStatusFilter(e.target.value)}
                  sx={{ minWidth: 180 }}
                  InputProps={{ sx: { borderRadius: 3, height: 40 } }}
                >
                  <MenuItem value="All">All Statuses</MenuItem>
                  <MenuItem value="Sent to Vendor">Sent to Vendor</MenuItem>
                  <MenuItem value="Completed">Completed / Received</MenuItem>
                </TextField>
              </Stack>
            </Card>

            {/* Table */}
            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>PO Number</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Supplier</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Item Ordered</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Order Date</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Expected Delivery</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Total Value</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>Quick Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredOrders.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            {searchQuery ? "No matching purchase orders found." : "No purchase orders created in the database."}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {searchQuery ? "Try refining your search keyword." : "Click '+ Create Purchase Order' to send an order to a supplier."}
                          </Typography>
                          {!searchQuery && (
                            <Button
                              size="small"
                              variant="contained"
                              startIcon={<AddIcon />}
                              onClick={() => setCreatePoOpen(true)}
                              sx={{ backgroundColor: '#2563EB', mt: 2 }}
                            >
                              + Create Purchase Order
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredOrders.map(p => (
                        <TableRow key={p.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{p.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{p.supplier}</TableCell>
                          <TableCell>
                            <Typography variant="body2" fontWeight={600}>{p.item}</Typography>
                            <Typography variant="caption" color="text.secondary">Qty: {p.qty} | Category: {p.category}</Typography>
                          </TableCell>
                          <TableCell>{p.date}</TableCell>
                          <TableCell>{p.expectedDate}</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>₹{(p.total || 0).toFixed(2)}</TableCell>
                          <TableCell>
                            <Chip 
                              label={p.status} 
                              color={p.status === 'Completed' ? 'success' : 'warning'} 
                              size="small" 
                              sx={{ fontWeight: 700 }}
                            />
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              {p.status === 'Sent to Vendor' && (
                                <Button size="small" variant="contained" color="success" onClick={() => goToNewPurchaseEntry(p.supplierId, p.poId)}>
                                  Convert to Purchase
                                </Button>
                              )}
                              <Button size="small" variant="outlined" onClick={() => setSelectedPo(p)}>
                                Job Card
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

      {/* 3. STOCK RECEIVE (GRN) */}
      {activeTab === 'receive' && (() => {
        const filteredGrn = stockReceives.filter(g => {
          const searchLower = searchQuery.toLowerCase();
          return (g.id && g.id.toLowerCase().includes(searchLower)) ||
                 (g.supplier && g.supplier.toLowerCase().includes(searchLower)) ||
                 (g.item && g.item.toLowerCase().includes(searchLower)) ||
                 (g.barcode && g.barcode.toLowerCase().includes(searchLower));
        });

        return (
          <Stack spacing={3}>
            <Card variant="outlined" sx={{ p: 2, px: 3, borderRadius: 4, backgroundColor: '#ffffff', borderColor: 'divider' }}>
              <TextField 
                fullWidth 
                size="small" 
                placeholder="Search GRN Receipt ID, Supplier, Barcode, or Received Item..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                InputProps={{ 
                  startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} />,
                  sx: { borderRadius: 3, height: 40, backgroundColor: '#f8fafc' }
                }}
              />
            </Card>

            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>GRN Receipt ID</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>PO Ref</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Supplier</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Item & Scanned Barcode</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Qty Received</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Stock Location</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Date Received</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredGrn.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            {searchQuery ? "No matching stock receiving logs found." : "No stock receiving (GRN) logs recorded in the database."}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {searchQuery ? "Try refining your search keyword." : "Click '+ Record Stock Receive (GRN)' to log incoming inventory shipments."}
                          </Typography>
                          {!searchQuery && (
                            <Button
                              size="small"
                              variant="contained"
                              color="success"
                              startIcon={<ReceiveIcon />}
                              onClick={() => goToNewPurchaseEntry()}
                              sx={{ mt: 2 }}
                            >
                              + New Purchase Entry
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredGrn.map(g => (
                        <TableRow key={g.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'success.main' }}>{g.id}</TableCell>
                          <TableCell>{g.poId}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{g.supplier}</TableCell>
                          <TableCell>
                            <Typography variant="body2" fontWeight={600}>{g.item}</Typography>
                            <Typography variant="caption" color="text.secondary">Barcode: {g.barcode}</Typography>
                          </TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>{g.qty} Units</TableCell>
                          <TableCell>{g.location}</TableCell>
                          <TableCell>{g.date}</TableCell>
                          <TableCell><Chip label={g.status} color="success" size="small" sx={{ fontWeight: 700 }} /></TableCell>
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

      {/* 4. PURCHASE RETURNS (RTV) */}
      {activeTab === 'returns' && (() => {
        const filteredReturns = purchaseReturns.filter(r => {
          const searchLower = searchQuery.toLowerCase();
          return (r.id && r.id.toLowerCase().includes(searchLower)) ||
                 (r.supplier && r.supplier.toLowerCase().includes(searchLower)) ||
                 (r.item && r.item.toLowerCase().includes(searchLower));
        });

        return (
          <Stack spacing={3}>
            <Card variant="outlined" sx={{ p: 2, px: 3, borderRadius: 4, backgroundColor: '#ffffff', borderColor: 'divider' }}>
              <TextField 
                fullWidth 
                size="small" 
                placeholder="Search Return ID, Supplier, or Returned Item..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                InputProps={{ 
                  startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} />,
                  sx: { borderRadius: 3, height: 40, backgroundColor: '#f8fafc' }
                }}
              />
            </Card>

            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Return ID (RTV)</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Supplier</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Item Returned</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Return Reason</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Date Logged</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Requested Credit Note</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredReturns.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            {searchQuery ? "No matching purchase returns found." : "No purchase returns logged in the database."}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                            {searchQuery ? "Try refining your search keyword." : "Click '+ Create Purchase Return' to log defective vendor returns."}
                          </Typography>
                          {!searchQuery && (
                            <Button 
                              size="small" 
                              variant="contained" 
                              color="error"
                              startIcon={<ReturnIcon />} 
                              onClick={() => setReturnOpen(true)} 
                              sx={{ mt: 2 }}
                            >
                              + Create First Purchase Return
                            </Button>
                          )}
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredReturns.map(r => (
                        <TableRow key={r.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'error.main' }}>{r.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{r.supplier}</TableCell>
                          <TableCell>
                            <Typography variant="body2" fontWeight={600}>{r.item}</Typography>
                            <Typography variant="caption" color="text.secondary">Qty: {r.qty}</Typography>
                          </TableCell>
                          <TableCell><Chip label={r.reason} size="small" color="error" variant="outlined" /></TableCell>
                          <TableCell>{r.date}</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>₹{(r.creditAmount || 0).toFixed(2)}</TableCell>
                          <TableCell><Chip label={r.status} color="warning" size="small" sx={{ fontWeight: 700 }} /></TableCell>
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

      {/* --- DIALOG: ADD NEW SUPPLIER --- */}
      <Dialog open={addSupplierOpen} onClose={() => setAddSupplierOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Register New Optical Supplier / Vendor</DialogTitle>
        <DialogContent dividers>
          {/* Manual Registration Grid */}
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField 
                label="Supplier Company Name" 
                fullWidth 
                required
                placeholder="e.g. Luxottica Eyewear Ltd"
                value={supplierInput.name}
                onChange={(e) => setSupplierInput({ ...supplierInput, name: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Contact Person Name" 
                fullWidth 
                placeholder="e.g. Robert Smith"
                value={supplierInput.contactPerson}
                onChange={(e) => setSupplierInput({ ...supplierInput, contactPerson: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Phone Number" 
                fullWidth 
                placeholder="e.g. +91 9876543210"
                value={supplierInput.phone}
                onChange={(e) => setSupplierInput({ ...supplierInput, phone: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Email Address" 
                fullWidth 
                placeholder="e.g. orders@supplier.com"
                value={supplierInput.email}
                onChange={(e) => setSupplierInput({ ...supplierInput, email: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="GSTIN Number" 
                fullWidth 
                placeholder="e.g. 07AAAAA0000A1Z5"
                value={supplierInput.gstin}
                onChange={(e) => setSupplierInput({ ...supplierInput, gstin: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="City / Hub" 
                fullWidth 
                placeholder="e.g. New Delhi"
                value={supplierInput.city}
                onChange={(e) => setSupplierInput({ ...supplierInput, city: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                select 
                label="Payment Terms" 
                fullWidth 
                value={supplierInput.paymentTerms}
                onChange={(e) => setSupplierInput({ ...supplierInput, paymentTerms: e.target.value })}
              >
                <MenuItem value="Immediate">Immediate Cash/UPI</MenuItem>
                <MenuItem value="Net 15">Net 15 Days</MenuItem>
                <MenuItem value="Net 30">Net 30 Days</MenuItem>
                <MenuItem value="Net 60">Net 60 Days</MenuItem>
              </TextField>
            </Grid>
          </Grid>

          <Divider sx={{ my: 2.5 }}>
            <Chip label="OR BATCH IMPORT SUPPLIERS VIA EXCEL SHEET" size="small" sx={{ fontWeight: 800, fontSize: '0.65rem', color: 'primary.main' }} />
          </Divider>

          {/* --- EXCEL / CSV BATCH UPLOADER SECTION (MOVED TO BOTTOM) --- */}
          <Paper 
            variant="outlined" 
            sx={{ 
              p: 2, 
              borderRadius: 3, 
              borderColor: '#3b82f6', 
              bgcolor: '#eff6ff', 
              borderStyle: 'dashed',
              borderWidth: 2
            }}
          >
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center" justifyContent="space-between">
              <Box>
                <Typography variant="subtitle2" fontWeight={850} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <CloudUploadIcon /> Batch Import via Excel / CSV Sheet
                </Typography>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  Upload Excel (.xlsx / .csv) supplier list to import multiple vendors at once into Database.
                </Typography>
              </Box>

              <Stack direction="row" spacing={1} alignItems="center">
                <Button 
                  variant="contained" 
                  color="primary" 
                  component="label"
                  size="small"
                  startIcon={<CloudUploadIcon />} 
                  sx={{ fontWeight: 800, textTransform: 'none', borderRadius: 2, whiteSpace: 'nowrap' }}
                >
                  Upload Excel Sheet
                  <input 
                    type="file" 
                    hidden 
                    accept=".csv, .xlsx, .xls" 
                    onChange={handleExcelSupplierUpload} 
                  />
                </Button>
                <Button 
                  variant="text" 
                  color="secondary" 
                  size="small" 
                  onClick={handleDownloadSupplierTemplate} 
                  sx={{ fontSize: '0.72rem', textTransform: 'none', textDecoration: 'underline', whiteSpace: 'nowrap' }}
                >
                  Download Template
                </Button>
              </Stack>
            </Stack>
          </Paper>
        </DialogContent>

        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setAddSupplierOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveSupplier} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            Save Supplier to Database
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- DIALOG: CREATE PURCHASE ORDER (sent to supplier, ahead of goods being received) --- */}
      <Dialog open={createPoOpen} onClose={() => setCreatePoOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Create Purchase Order (PO)</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={0.5}>
                <Typography variant="caption" fontWeight={700} color="text.secondary">Supplier Vendor *</Typography>
                <Button size="small" sx={{ fontSize: '0.75rem', textTransform: 'none', py: 0 }} onClick={() => setAddSupplierOpen(true)}>
                  + Register New Supplier
                </Button>
              </Box>
              <Autocomplete
                options={cleanSuppList}
                getOptionLabel={(o) => o.name || o.company_name || ''}
                value={cleanSuppList.find(s => String(s.id) === String(poHeader.supplierId)) || null}
                onChange={(e, val) => setPoHeader({ ...poHeader, supplierId: val ? val.id : '' })}
                renderInput={(params) => <TextField {...params} label="Select Supplier" required fullWidth placeholder="Choose the supplier this order is sent to..." />}
              />
            </Grid>
            <Grid item xs={12}>
              <QuickDatePickerField
                label="Expected Delivery Date"
                fullWidth
                value={poHeader.expectedDate}
                onChange={(newDate) => setPoHeader({ ...poHeader, expectedDate: newDate })}
                quickPresets={[
                  { label: 'In 3 Days', type: 'days', amount: 3 },
                  { label: 'In 1 Week', type: 'weeks', amount: 1 },
                  { label: 'In 2 Weeks', type: 'weeks', amount: 2 },
                  { label: 'In 1 Month', type: 'months', amount: 1 }
                ]}
              />
            </Grid>
            <Grid item xs={12}>
              <Autocomplete
                options={products.filter(p => !poItems.some(i => i.productId === p.id))}
                getOptionLabel={(o) => o.name || ''}
                value={poProductPick}
                onChange={(e, val) => addPoProductLine(val)}
                renderInput={(params) => <TextField {...params} label="Add Product to Order" placeholder="Search product to order..." />}
              />
            </Grid>
            <Grid item xs={12}>
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell>Product</TableCell>
                      <TableCell align="right">Qty</TableCell>
                      <TableCell align="right">Unit Cost (₹)</TableCell>
                      <TableCell />
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {poItems.length === 0 ? (
                      <TableRow><TableCell colSpan={4} align="center" sx={{ py: 3 }}><Typography variant="caption" color="text.secondary">No products added yet.</Typography></TableCell></TableRow>
                    ) : poItems.map((it, idx) => (
                      <TableRow key={it.productId}>
                        <TableCell>{it.productName}</TableCell>
                        <TableCell align="right">
                          <TextField size="small" type="number" value={it.qty} onChange={(e) => updatePoItem(idx, 'qty', e.target.value)} sx={{ width: 70 }} />
                        </TableCell>
                        <TableCell align="right">
                          <TextField size="small" type="number" value={it.rate} onChange={(e) => updatePoItem(idx, 'rate', e.target.value)} sx={{ width: 90 }} />
                        </TableCell>
                        <TableCell>
                          <IconButton size="small" color="error" onClick={() => removePoItem(idx)}><DeleteIcon fontSize="small" /></IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setCreatePoOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSavePo} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            Send Purchase Order to Supplier
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- DIALOG: CREATE PURCHASE RETURN (RTV) --- */}
      <Dialog open={returnOpen} onClose={() => setReturnOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Create Purchase Return to Vendor (RTV)</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <Box display="flex" justifyContent="space-between" alignItems="center" mb={0.5}>
                <Typography variant="caption" fontWeight={700} color="text.secondary">Supplier Name *</Typography>
                <Button size="small" sx={{ fontSize: '0.75rem', textTransform: 'none', py: 0 }} onClick={() => setAddSupplierOpen(true)}>
                  + New Supplier
                </Button>
              </Box>
              <Autocomplete
                freeSolo
                options={getDatabaseSupplierNames()}
                value={returnInput.supplierName || ''}
                onInputChange={(event, newInputValue) => {
                  setReturnInput({ ...returnInput, supplierName: newInputValue || '' });
                }}
                onChange={(event, newValue) => {
                  setReturnInput({ ...returnInput, supplierName: newValue || '' });
                }}
                renderInput={(params) => (
                  <TextField 
                    {...params} 
                    label="Select Database Supplier" 
                    required
                    fullWidth 
                    placeholder="Type or select supplier from database..."
                  />
                )}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Defective Item Name" 
                fullWidth 
                required
                placeholder="e.g. Duravision Lens Pair"
                value={returnInput.itemName}
                onChange={(e) => setReturnInput({ ...returnInput, itemName: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Quantity Returned" 
                fullWidth 
                type="number"
                value={returnInput.qtyReturned}
                onChange={(e) => setReturnInput({ ...returnInput, qtyReturned: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                select 
                label="Return Reason" 
                fullWidth 
                value={returnInput.reason}
                onChange={(e) => setReturnInput({ ...returnInput, reason: e.target.value })}
              >
                <MenuItem value="Defective Frame Coating">Defective Frame Coating</MenuItem>
                <MenuItem value="Lens Scratched / Damaged">Lens Scratched / Damaged</MenuItem>
                <MenuItem value="Wrong Prescription Power">Wrong Prescription Power</MenuItem>
                <MenuItem value="Packaging Damaged">Packaging Damaged</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12}>
              <TextField 
                label="Requested Credit Note Amount (₹)" 
                fullWidth 
                type="number"
                placeholder="e.g. 2400"
                value={returnInput.creditAmount}
                onChange={(e) => setReturnInput({ ...returnInput, creditAmount: e.target.value })}
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setReturnOpen(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleSaveReturn} sx={{ fontWeight: 700, px: 3 }}>
            Log Return & Request Credit
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
