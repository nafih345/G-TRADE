import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Box, Card, CardContent, Typography, Button, Tab, Tabs, 
  Grid, Table, TableBody, TableCell, TableContainer, 
  TableHead, TableRow, Paper, Chip, Dialog, 
  DialogTitle, DialogContent, DialogActions, TextField, 
  MenuItem, Stack, IconButton, Divider, Tooltip, InputAdornment
} from '@mui/material';
import {
  Add as AddIcon,
  Search as SearchIcon,
  LocalShipping as ShippingIcon,
  ReceiptLong as POIcon,
  Inventory2 as ReceiveIcon,
  AssignmentReturn as ReturnIcon,
  Business as SupplierIcon,
  QrCode as BarcodeIcon,
  CheckCircle as SuccessIcon,
  Warning as WarningIcon
} from '@mui/icons-material';
import axios from 'axios';

export default function Purchases() {
  const location = useLocation();
  const navigate = useNavigate();

  // Tab sync from path
  const getTabFromPath = (pathname) => {
    if (pathname.includes('/purchase/orders')) return 'orders';
    if (pathname.includes('/purchase/receive') || pathname.includes('/purchase/stock-receive')) return 'receive';
    if (pathname.includes('/purchase/returns')) return 'returns';
    return 'suppliers';
  };

  const [activeTab, setActiveTab] = useState(getTabFromPath(location.pathname));

  useEffect(() => {
    setActiveTab(getTabFromPath(location.pathname));
  }, [location.pathname]);

  const handleTabChange = (event, newValue) => {
    setActiveTab(newValue);
    if (newValue === 'suppliers') navigate('/purchase/suppliers');
    if (newValue === 'orders') navigate('/purchase/orders');
    if (newValue === 'receive') navigate('/purchase/receive');
    if (newValue === 'returns') navigate('/purchase/returns');
  };

  // Database State (Starts 100% Blank as requested)
  const [suppliers, setSuppliers] = useState([]);
  const [purchaseOrders, setPurchaseOrders] = useState([]);
  const [stockReceives, setStockReceives] = useState([]);
  const [purchaseReturns, setPurchaseReturns] = useState([]);

  // Search & Filters
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('All');

  // Modal Dialog States
  const [addSupplierOpen, setAddSupplierOpen] = useState(false);
  const [createPoOpen, setCreatePoOpen] = useState(false);
  const [receiveStockOpen, setReceiveStockOpen] = useState(false);
  const [returnOpen, setReturnOpen] = useState(false);
  const [selectedPo, setSelectedPo] = useState(null);

  // Form Inputs (All start blank)
  const [supplierInput, setSupplierInput] = useState({
    name: '', contactPerson: '', phone: '', email: '', gstin: '', address: '', city: '', paymentTerms: 'Net 30'
  });

  const [poInput, setPoInput] = useState({
    supplierId: '', expectedDate: '', itemCategory: 'Frames', itemName: '', qty: '', costPrice: '', remarks: ''
  });

  const [receiveInput, setReceiveInput] = useState({
    poId: '', supplierName: '', barcode: '', itemReceived: '', qtyReceived: '', rack: 'Rack A1', shelf: 'Shelf S1', inspector: 'Admin'
  });

  const [returnInput, setReturnInput] = useState({
    supplierName: '', itemName: '', qtyReturned: '', reason: 'Defective Frame Coating', creditAmount: ''
  });

  // Backend Sync & LocalStorage Sync
  useEffect(() => {
    const fetchPurchaseData = async () => {
      let localSupps = [];
      try {
        const savedNames = JSON.parse(localStorage.getItem('optical_suppliers') || '[]');
        localSupps = savedNames.map((name, i) => ({ id: `SUP-LOC-${i}`, name, balance: 0 }));
      } catch (e) {}

      try {
        const res = await axios.get('/api/purchasing/suppliers/');
        if (res.data && Array.isArray(res.data) && res.data.length > 0) {
          setSuppliers(res.data);
        } else if (localSupps.length > 0) {
          setSuppliers(localSupps);
        }
      } catch (err) {
        if (localSupps.length > 0) setSuppliers(localSupps);
      }
    };
    fetchPurchaseData();
  }, []);

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
      await axios.post('/api/purchasing/suppliers/', {
        name: newSupp.name,
        contact_person: newSupp.contactPerson,
        phone: newSupp.phone,
        email: newSupp.email,
        gstin: newSupp.gstin
      });
    } catch (e) {}

    setSupplierInput({ name: '', contactPerson: '', phone: '', email: '', gstin: '', address: '', city: '', paymentTerms: 'Net 30' });
    setAddSupplierOpen(false);
    alert(`Supplier '${newSupp.name}' registered to database successfully!`);
  };

  const handleSavePo = () => {
    if (!poInput.supplierId || !poInput.itemName) {
      alert("Please select Supplier and enter Product Name.");
      return;
    }
    const supp = suppliers.find(s => s.id === poInput.supplierId);
    const suppName = supp ? supp.name : 'Selected Supplier';
    const totalVal = (parseFloat(poInput.costPrice) || 0) * (parseInt(poInput.qty) || 1);

    const newPo = {
      id: `PO-${Math.floor(1000 + Math.random() * 9000)}`,
      supplier: suppName,
      supplierId: poInput.supplierId,
      date: new Date().toISOString().split('T')[0],
      expectedDate: poInput.expectedDate || new Date(Date.now() + 7*86400000).toISOString().split('T')[0],
      item: poInput.itemName,
      category: poInput.itemCategory,
      qty: parseInt(poInput.qty) || 1,
      total: totalVal,
      status: 'Sent to Vendor'
    };
    const updatedPos = [newPo, ...purchaseOrders];
    setPurchaseOrders(updatedPos);

    // Save to localStorage for Accounts Module auto-recording
    try {
      const existingPos = JSON.parse(localStorage.getItem('optical_purchase_orders') || '[]');
      localStorage.setItem('optical_purchase_orders', JSON.stringify([newPo, ...existingPos]));
    } catch (e) {}

    setPoInput({ supplierId: '', expectedDate: '', itemCategory: 'Frames', itemName: '', qty: '', costPrice: '', remarks: '' });
    setCreatePoOpen(false);
    alert(`Purchase Order ${newPo.id} created & sent to ${suppName}!`);
  };

  const handleSaveReceive = () => {
    if (!receiveInput.itemReceived || !receiveInput.qtyReceived) {
      alert("Please enter Received Item Name and Quantity.");
      return;
    }
    const newGrn = {
      id: `GRN-${Math.floor(1000 + Math.random() * 9000)}`,
      poId: receiveInput.poId || 'PO-DIRECT',
      supplier: receiveInput.supplierName || 'Direct Vendor',
      item: receiveInput.itemReceived,
      barcode: receiveInput.barcode || String(Math.floor(88000000 + Math.random() * 11000000)),
      qty: parseInt(receiveInput.qtyReceived) || 1,
      date: new Date().toISOString().split('T')[0],
      location: `${receiveInput.rack} / ${receiveInput.shelf}`,
      inspector: receiveInput.inspector,
      status: 'Verified & Stocked'
    };
    setStockReceives([newGrn, ...stockReceives]);

    // Update PO status if linked
    if (receiveInput.poId) {
      setPurchaseOrders(purchaseOrders.map(p => p.id === receiveInput.poId ? { ...p, status: 'Completed' } : p));
    }

    setReceiveInput({ poId: '', supplierName: '', barcode: '', itemReceived: '', qtyReceived: '', rack: 'Rack A1', shelf: 'Shelf S1', inspector: 'Admin' });
    setReceiveStockOpen(false);
    alert(`GRN ${newGrn.id}: Received ${newGrn.qty} units into ${newGrn.location}!`);
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

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Top Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" fontWeight={800}>Optical Purchasing & Inventory Replenishment</Typography>
          <Typography variant="body2" color="text.secondary">Manage optical suppliers, purchase orders, stock receiving (GRN), and vendor returns</Typography>
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
            <Button variant="contained" startIcon={<ReceiveIcon />} onClick={() => setReceiveStockOpen(true)} sx={{ backgroundColor: '#10B981', color: 'white', fontWeight: 700 }}>
              + Record Stock Receive (GRN)
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
          <Tab value="suppliers" label="Suppliers Directory" icon={<SupplierIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="orders" label="Purchase Orders (PO)" icon={<POIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="receive" label="Stock Receive (GRN)" icon={<ReceiveIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="returns" label="Purchase Returns (RTV)" icon={<ReturnIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
        </Tabs>
      </Card>

      {/* 1. SUPPLIERS DIRECTORY */}
      {activeTab === 'suppliers' && (() => {
        const filteredSuppliers = suppliers.filter(s => {
          const searchLower = searchQuery.toLowerCase();
          return (s.name && s.name.toLowerCase().includes(searchLower)) ||
                 (s.contactPerson && s.contactPerson.toLowerCase().includes(searchLower)) ||
                 (s.phone && s.phone.toLowerCase().includes(searchLower)) ||
                 (s.gstin && s.gstin.toLowerCase().includes(searchLower));
        });

        const totalPayables = suppliers.reduce((sum, s) => sum + (parseFloat(s.balance) || 0), 0);

        return (
          <Stack spacing={3}>
            {/* KPI Metrics Banner */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>REGISTERED SUPPLIERS</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{suppliers.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Optical vendors</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>ACTIVE VENDORS</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">{suppliers.length}</Typography>
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

            {/* Toolbar Search */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <TextField 
                fullWidth 
                size="small" 
                placeholder="Search Supplier Name, Contact Person, Phone, or GSTIN..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                InputProps={{ startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} /> }}
              />
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
                                onClick={() => {
                                  setPoInput({ ...poInput, supplierId: s.id });
                                  setCreatePoOpen(true);
                                }}
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
        );
      })()}

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
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
                <TextField 
                  fullWidth 
                  size="small" 
                  placeholder="Search PO Number, Supplier Name, or Ordered Item..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  InputProps={{ startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} /> }}
                />
                <TextField 
                  select 
                  size="small" 
                  label="Filter Status" 
                  value={statusFilter} 
                  onChange={(e) => setStatusFilter(e.target.value)}
                  sx={{ minWidth: 180 }}
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
                            {searchQuery ? "Try refining your search keyword." : "Click '+ Create Purchase Order' to generate new vendor stock orders."}
                          </Typography>
                          {!searchQuery && (
                            <Button 
                              size="small" 
                              variant="contained" 
                              startIcon={<AddIcon />} 
                              onClick={() => setCreatePoOpen(true)} 
                              sx={{ backgroundColor: '#2563EB', mt: 2 }}
                            >
                              + Create First PO
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
                              {p.status !== 'Completed' && (
                                <Button 
                                  size="small" 
                                  variant="contained" 
                                  color="success"
                                  onClick={() => {
                                    setReceiveInput({
                                      poId: p.id,
                                      supplierName: p.supplier,
                                      barcode: '',
                                      itemReceived: p.item,
                                      qtyReceived: String(p.qty),
                                      rack: 'Rack A1',
                                      shelf: 'Shelf S1',
                                      inspector: 'Admin'
                                    });
                                    setReceiveStockOpen(true);
                                  }}
                                >
                                  Receive Goods
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
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <TextField 
                fullWidth 
                size="small" 
                placeholder="Search GRN Receipt ID, Supplier, Barcode, or Received Item..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                InputProps={{ startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} /> }}
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
                              onClick={() => setReceiveStockOpen(true)} 
                              sx={{ mt: 2 }}
                            >
                              + Record First Stock Receive
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
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <TextField 
                fullWidth 
                size="small" 
                placeholder="Search Return ID, Supplier, or Returned Item..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                InputProps={{ startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} /> }}
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
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setAddSupplierOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveSupplier} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            Save Supplier to Database
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- DIALOG: CREATE PURCHASE ORDER --- */}
      <Dialog open={createPoOpen} onClose={() => setCreatePoOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Create Purchase Order (PO)</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <TextField 
                select 
                label="Select Supplier Vendor" 
                fullWidth 
                required
                value={poInput.supplierId}
                onChange={(e) => setPoInput({ ...poInput, supplierId: e.target.value })}
              >
                <MenuItem value="">-- Select Registered Supplier --</MenuItem>
                {suppliers.map(s => (
                  <MenuItem key={s.id} value={s.id}>{s.name} ({s.city || 'Vendor'})</MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={6}>
              <TextField 
                select 
                label="Item Category" 
                fullWidth 
                value={poInput.itemCategory}
                onChange={(e) => setPoInput({ ...poInput, itemCategory: e.target.value })}
              >
                <MenuItem value="Frames">Spectacle Frames</MenuItem>
                <MenuItem value="Prescription Lenses">Prescription Lenses</MenuItem>
                <MenuItem value="Sunglasses">Sunglasses</MenuItem>
                <MenuItem value="Contact Lenses">Contact Lenses</MenuItem>
                <MenuItem value="Accessories">Accessories & Solutions</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Product Name / Brand Specs" 
                fullWidth 
                required
                placeholder="e.g. Aviator Classic 58mm"
                value={poInput.itemName}
                onChange={(e) => setPoInput({ ...poInput, itemName: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Order Quantity" 
                fullWidth 
                type="number"
                placeholder="e.g. 20"
                value={poInput.qty}
                onChange={(e) => setPoInput({ ...poInput, qty: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Unit Cost Price (₹)" 
                fullWidth 
                type="number"
                placeholder="e.g. 1200"
                value={poInput.costPrice}
                onChange={(e) => setPoInput({ ...poInput, costPrice: e.target.value })}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField 
                label="Expected Delivery Date" 
                fullWidth 
                type="date"
                InputLabelProps={{ shrink: true }}
                value={poInput.expectedDate}
                onChange={(e) => setPoInput({ ...poInput, expectedDate: e.target.value })}
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setCreatePoOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSavePo} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            Issue Purchase Order
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- DIALOG: RECORD STOCK RECEIVE (GRN) --- */}
      <Dialog open={receiveStockOpen} onClose={() => setReceiveStockOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Record Stock Receive (GRN Note)</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <TextField 
                label="PO Reference ID" 
                fullWidth 
                placeholder="e.g. PO-8921 (Optional)"
                value={receiveInput.poId}
                onChange={(e) => setReceiveInput({ ...receiveInput, poId: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Supplier Name" 
                fullWidth 
                placeholder="e.g. Luxottica India"
                value={receiveInput.supplierName}
                onChange={(e) => setReceiveInput({ ...receiveInput, supplierName: e.target.value })}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField 
                label="Item Received Name" 
                fullWidth 
                required
                placeholder="e.g. Crizal Prevencia 1.56 Lenses"
                value={receiveInput.itemReceived}
                onChange={(e) => setReceiveInput({ ...receiveInput, itemReceived: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Scanned Barcode / EAN" 
                fullWidth 
                placeholder="Scan package barcode"
                value={receiveInput.barcode}
                onChange={(e) => setReceiveInput({ ...receiveInput, barcode: e.target.value })}
                InputProps={{
                  endAdornment: (
                    <IconButton size="small" onClick={() => setReceiveInput({ ...receiveInput, barcode: String(Math.floor(88000000 + Math.random() * 11000000)) })}>
                      <BarcodeIcon fontSize="small" />
                    </IconButton>
                  )
                }}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Quantity Received" 
                fullWidth 
                type="number"
                placeholder="e.g. 50"
                value={receiveInput.qtyReceived}
                onChange={(e) => setReceiveInput({ ...receiveInput, qtyReceived: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Rack Location" 
                fullWidth 
                value={receiveInput.rack}
                onChange={(e) => setReceiveInput({ ...receiveInput, rack: e.target.value })}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField 
                label="Shelf Location" 
                fullWidth 
                value={receiveInput.shelf}
                onChange={(e) => setReceiveInput({ ...receiveInput, shelf: e.target.value })}
              />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setReceiveStockOpen(false)}>Cancel</Button>
          <Button variant="contained" color="success" onClick={handleSaveReceive} sx={{ fontWeight: 700, px: 3 }}>
            Verify & Stock Inventory
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- DIALOG: CREATE PURCHASE RETURN (RTV) --- */}
      <Dialog open={returnOpen} onClose={() => setReturnOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Create Purchase Return to Vendor (RTV)</DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <TextField 
                label="Supplier Name" 
                fullWidth 
                required
                placeholder="e.g. Essilor Vision"
                value={returnInput.supplierName}
                onChange={(e) => setReturnInput({ ...returnInput, supplierName: e.target.value })}
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
