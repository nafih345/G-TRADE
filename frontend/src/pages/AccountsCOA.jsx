import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Box, Card, CardContent, Typography, Grid, Button, Tab, Tabs,
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Dialog, DialogTitle, DialogContent, 
  DialogActions, TextField, MenuItem, Stack, Chip 
} from '@mui/material';
import {
  Add as AddIcon,
  AttachMoney as MoneyIcon,
  TrendingDown as PaymentIcon,
  TrendingUp as ReceiptIcon,
  PriorityHigh as DueIcon
} from '@mui/icons-material';
import axios from 'axios';

const initialReceipts = [];
const initialPayments = [];
const initialExpenses = [];
const initialCustomerDue = [];
const initialSupplierDue = [];

export default function AccountsCOA() {
  const location = useLocation();
  const navigate = useNavigate();

  // Tab sync from path
  const getTabFromPath = (pathname) => {
    if (pathname.includes('/accounts/payments')) return 1;
    if (pathname.includes('/accounts/expenses')) return 2;
    if (pathname.includes('/accounts/customer-due')) return 3;
    if (pathname.includes('/accounts/supplier-due')) return 4;
    return 0; // /accounts/receipts
  };

  const [currentTab, setCurrentTab] = useState(getTabFromPath(location.pathname));
  const [receipts, setReceipts] = useState(initialReceipts);
  const [payments, setPayments] = useState(initialPayments);
  const [expenses, setExpenses] = useState(initialExpenses);
  const [customerDue, setCustomerDue] = useState(initialCustomerDue);
  const [supplierDue, setSupplierDue] = useState(initialSupplierDue);

  useEffect(() => {
    setCurrentTab(getTabFromPath(location.pathname));
  }, [location.pathname]);

  const handleTabChange = (event, newValue) => {
    setCurrentTab(newValue);
    if (newValue === 0) navigate('/accounts/receipts');
    if (newValue === 1) navigate('/accounts/payments');
    if (newValue === 2) navigate('/accounts/expenses');
    if (newValue === 3) navigate('/accounts/customer-due');
    if (newValue === 4) navigate('/accounts/supplier-due');
  };

  const [openDialog, setOpenDialog] = useState(false);
  const [dialogType, setDialogType] = useState('receipt'); // receipt, payment, expense

  const [newTransaction, setNewTransaction] = useState({
    party: '', category: 'Ophthalmic Supply', method: 'Cash', amount: '', date: new Date().toISOString().split('T')[0]
  });

  // Backend Sync & Automatic Cross-Module Sync
  useEffect(() => {
    const fetchAccountsData = async () => {
      // 1. AUTOMATIC PATIENT RECEIPTS (from POS Sales, Billing Invoices & Payments)
      let autoReceipts = [];
      try {
        const savedInvoices = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
        const savedPayments = JSON.parse(localStorage.getItem('optical_payments') || '[]');

        savedInvoices.forEach(inv => {
          if (parseFloat(inv.paidAmount || inv.total || 0) > 0) {
            autoReceipts.push({
              id: `REC-${inv.invoiceNumber || inv.id}`,
              patient: inv.customerName || inv.patientName || 'Walk-in Patient',
              date: inv.date || new Date().toISOString().split('T')[0],
              method: inv.paymentMethod || 'UPI/Cash',
              amount: parseFloat(inv.paidAmount || inv.total || 0),
              status: 'Completed'
            });
          }
        });

        savedPayments.forEach(p => {
          autoReceipts.push({
            id: `REC-${p.id || p.receiptId}`,
            patient: p.customerName || p.patientName || 'Patient',
            date: p.date || new Date().toISOString().split('T')[0],
            method: p.method || 'Cash',
            amount: parseFloat(p.amount || 0),
            status: 'Completed'
          });
        });
      } catch (e) {}

      try {
        const invRes = await axios.get('/api/sales/invoices/');
        if (invRes.data && Array.isArray(invRes.data)) {
          invRes.data.forEach(inv => {
            const paid = parseFloat(inv.paid_amount || inv.total || 0);
            if (paid > 0) {
              autoReceipts.push({
                id: `REC-${inv.invoice_number || inv.id}`,
                patient: inv.customer_name || 'Patient',
                date: inv.created_at ? inv.created_at.split('T')[0] : new Date().toISOString().split('T')[0],
                method: inv.payment_method || 'Cash',
                amount: paid,
                status: 'Completed'
              });
            }
          });
        }
      } catch (e) {}

      if (autoReceipts.length > 0) {
        setReceipts(prev => {
          const combined = [...prev, ...autoReceipts];
          const uniqueMap = new Map();
          combined.forEach(r => uniqueMap.set(r.id, r));
          return Array.from(uniqueMap.values());
        });
      }

      // 2. AUTOMATIC SUPPLIER PAYMENTS (from Purchase Orders & Vendor Payments)
      let autoSupplierPayments = [];
      try {
        const savedPos = JSON.parse(localStorage.getItem('optical_purchase_orders') || '[]');
        savedPos.forEach(po => {
          if (po.status === 'Completed' || po.paid) {
            autoSupplierPayments.push({
              id: `PAY-${po.id}`,
              supplier: po.supplier || 'Vendor',
              date: po.date || new Date().toISOString().split('T')[0],
              method: 'Bank Transfer',
              amount: parseFloat(po.total || 0),
              status: 'Completed'
            });
          }
        });
      } catch (e) {}

      if (autoSupplierPayments.length > 0) {
        setPayments(prev => {
          const combined = [...prev, ...autoSupplierPayments];
          const uniqueMap = new Map();
          combined.forEach(p => uniqueMap.set(p.id, p));
          return Array.from(uniqueMap.values());
        });
      }

      // 3. AUTOMATIC CUSTOMER DUES
      let autoCustomerDues = [];
      try {
        const savedCustomers = JSON.parse(localStorage.getItem('optical_customers') || '[]');
        savedCustomers.forEach((c, i) => {
          const bal = parseFloat(c.dueAmount || c.balance || 0);
          if (bal > 0) {
            autoCustomerDues.push({
              id: `DUE-${100 + i}`,
              patient: c.name,
              phone: c.phone || 'N/A',
              lastExam: c.lastVisit || new Date().toISOString().split('T')[0],
              outstanding: bal
            });
          }
        });
      } catch (e) {}

      try {
        const custRes = await axios.get('/api/sales/customers/');
        if (custRes.data && Array.isArray(custRes.data)) {
          custRes.data.forEach((c, i) => {
            const bal = parseFloat(c.balance || 0);
            if (bal > 0) {
              autoCustomerDues.push({
                id: `DUE-API-${100 + i}`,
                patient: c.name,
                phone: c.phone || 'N/A',
                lastExam: c.date || new Date().toISOString().split('T')[0],
                outstanding: bal
              });
            }
          });
        }
      } catch (e) {}

      if (autoCustomerDues.length > 0) {
        const uniqueMap = new Map();
        autoCustomerDues.forEach(d => uniqueMap.set(d.patient, d));
        setCustomerDue(Array.from(uniqueMap.values()));
      }

      // 4. AUTOMATIC SUPPLIER DUES
      let autoSupplierDues = [];
      try {
        const savedSuppliers = JSON.parse(localStorage.getItem('optical_suppliers') || '[]');
        savedSuppliers.forEach((sName, i) => {
          // Check if supplier has pending POs
          autoSupplierDues.push({
            id: `SDUE-${300 + i}`,
            supplier: typeof sName === 'string' ? sName : sName.name,
            phone: typeof sName === 'object' ? sName.phone || 'N/A' : 'N/A',
            email: typeof sName === 'object' ? sName.email || 'N/A' : 'N/A',
            balance: typeof sName === 'object' ? parseFloat(sName.balance || 0) : 0
          });
        });
      } catch (e) {}

      try {
        const suppRes = await axios.get('/api/purchasing/suppliers/');
        if (suppRes.data && Array.isArray(suppRes.data)) {
          suppRes.data.forEach((s, i) => {
            const bal = parseFloat(s.balance || 0);
            if (bal > 0) {
              autoSupplierDues.push({
                id: `SDUE-API-${300 + i}`,
                supplier: s.name,
                phone: s.phone || 'N/A',
                email: s.email || 'N/A',
                balance: bal
              });
            }
          });
        }
      } catch (e) {}

      if (autoSupplierDues.filter(s => s.balance > 0).length > 0) {
        const uniqueMap = new Map();
        autoSupplierDues.filter(s => s.balance > 0).forEach(s => uniqueMap.set(s.supplier, s));
        setSupplierDue(Array.from(uniqueMap.values()));
      }
    };

    fetchAccountsData();
  }, []);

  const handleOpenDialog = (type) => {
    setDialogType(type);
    setOpenDialog(true);
  };

  const handleSaveTransaction = () => {
    const amt = parseFloat(newTransaction.amount) || 0;
    if (!newTransaction.party || amt <= 0) {
      alert("Please enter Description/Party Name and a valid Amount.");
      return;
    }
    if (dialogType === 'receipt') {
      const entry = {
        id: `REC-${Math.floor(500 + Math.random() * 500)}`,
        patient: newTransaction.party,
        date: newTransaction.date,
        method: newTransaction.method,
        amount: amt,
        status: 'Completed'
      };
      setReceipts([entry, ...receipts]);
    } else if (dialogType === 'payment') {
      const entry = {
        id: `PAY-${Math.floor(400 + Math.random() * 500)}`,
        supplier: newTransaction.party,
        date: newTransaction.date,
        method: newTransaction.method,
        amount: amt,
        status: 'Completed'
      };
      setPayments([entry, ...payments]);
    } else {
      const entry = {
        id: `EXP-${Math.floor(100 + Math.random() * 500)}`,
        name: newTransaction.party,
        category: newTransaction.category,
        date: newTransaction.date,
        amount: amt
      };
      setExpenses([entry, ...expenses]);
    }
    setOpenDialog(false);
    setNewTransaction({
      party: '', category: 'Ophthalmic Supply', method: 'Cash', amount: '', date: new Date().toISOString().split('T')[0]
    });
    alert('Ledger entry recorded successfully!');
  };

  // Dynamic KPI Calculations
  const totalReceiptsAmt = receipts.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
  const totalPaymentsAmt = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const totalExpensesAmt = expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0);
  const netCashBalance = Math.max(0, totalReceiptsAmt - (totalPaymentsAmt + totalExpensesAmt));

  const totalPatientDues = customerDue.reduce((sum, c) => sum + (parseFloat(c.outstanding) || 0), 0);
  const totalSupplierDues = supplierDue.reduce((sum, s) => sum + (parseFloat(s.balance) || 0), 0);

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Header section */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>VisionERP Accounts Ledger</Typography>
          <Typography variant="body2" color="text.secondary">Monitor clinical receipts, supplier payments, cash flow, and patient/supplier dues</Typography>
        </Box>
        <Stack direction="row" spacing={1.5}>
          <Button variant="outlined" startIcon={<ReceiptIcon />} onClick={() => handleOpenDialog('receipt')}>
            + New Receipt
          </Button>
          <Button variant="contained" startIcon={<PaymentIcon />} onClick={() => handleOpenDialog('payment')} sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}>
            + Record Payment
          </Button>
          <Button variant="outlined" color="error" startIcon={<AddIcon />} onClick={() => handleOpenDialog('expense')}>
            + Record Expense
          </Button>
        </Stack>
      </Box>

      {/* KPI stats */}
      <Grid container spacing={3} sx={{ mb: 4 }}>
        <Grid item xs={12} sm={4}>
          <Card variant="outlined" sx={{ borderRadius: 3, borderLeft: '4px solid #2563eb' }}>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <MoneyIcon color="primary" sx={{ fontSize: 36 }} />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>CASH & BANK BALANCE</Typography>
                <Typography variant="h5" fontWeight={850} color="primary.main">₹{netCashBalance.toFixed(2)}</Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={4}>
          <Card variant="outlined" sx={{ borderRadius: 3, borderLeft: '4px solid #f59e0b' }}>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <DueIcon color="warning" sx={{ fontSize: 36 }} />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL PATIENT DUES</Typography>
                <Typography variant="h5" fontWeight={850} color="warning.main">₹{totalPatientDues.toFixed(2)}</Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>
        <Grid item xs={12} sm={4}>
          <Card variant="outlined" sx={{ borderRadius: 3, borderLeft: '4px solid #ef4444' }}>
            <CardContent sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
              <DueIcon color="error" sx={{ fontSize: 36 }} />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>OUTSTANDING TO SUPPLIERS</Typography>
                <Typography variant="h5" fontWeight={850} color="error.main">₹{totalSupplierDues.toFixed(2)}</Typography>
              </Box>
            </CardContent>
          </Card>
        </Grid>
      </Grid>

      {/* Tabs */}
      <Card sx={{ mb: 3, borderRadius: 3 }}>
        <Tabs value={currentTab} onChange={handleTabChange} sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab label="Patient Receipts" sx={{ fontWeight: 700 }} />
          <Tab label="Supplier Payments" sx={{ fontWeight: 700 }} />
          <Tab label="Clinic Expenses" sx={{ fontWeight: 700 }} />
          <Tab label="Customer Due" sx={{ fontWeight: 700 }} />
          <Tab label="Supplier Due" sx={{ fontWeight: 700 }} />
        </Tabs>
      </Card>

      {/* Receipts Tab */}
      {currentTab === 0 && (
        <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <CardContent sx={{ p: 0 }}>
            <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
              <Table size="small">
                <TableHead sx={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Receipt ID</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Patient</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Date</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Payment Method</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Amount</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {receipts.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} align="center" sx={{ py: 8 }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={500}>
                          No patient receipt records found in the database.
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                          Click '+ New Receipt' or complete POS Billing to record patient payments.
                        </Typography>
                        <Button 
                          size="small" 
                          variant="contained" 
                          startIcon={<AddIcon />} 
                          onClick={() => handleOpenDialog('receipt')} 
                          sx={{ backgroundColor: '#2563EB', mt: 2 }}
                        >
                          + Record First Receipt
                        </Button>
                      </TableCell>
                    </TableRow>
                  ) : (
                    receipts.map((row) => (
                      <TableRow key={row.id} hover>
                        <TableCell sx={{ fontWeight: 600, color: 'primary.main' }}>{row.id}</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{row.patient}</TableCell>
                        <TableCell>{row.date}</TableCell>
                        <TableCell>{row.method}</TableCell>
                        <TableCell sx={{ fontWeight: 700, color: 'success.main' }}>₹{(row.amount || 0).toFixed(2)}</TableCell>
                        <TableCell>
                          <Chip label={row.status} color="success" size="small" sx={{ borderRadius: 1, fontWeight: 700 }} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      )}

      {/* Payments Tab */}
      {currentTab === 1 && (
        <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <CardContent sx={{ p: 0 }}>
            <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
              <Table size="small">
                <TableHead sx={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Payment ID</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Supplier</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Date</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Payment Method</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Amount</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {payments.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={6} align="center" sx={{ py: 8 }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={500}>
                          No supplier payment logs recorded in the database.
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                          Click '+ Record Payment' to log payments made to optical vendors.
                        </Typography>
                        <Button 
                          size="small" 
                          variant="contained" 
                          startIcon={<PaymentIcon />} 
                          onClick={() => handleOpenDialog('payment')} 
                          sx={{ backgroundColor: '#2563EB', mt: 2 }}
                        >
                          + Record First Payment
                        </Button>
                      </TableCell>
                    </TableRow>
                  ) : (
                    payments.map((row) => (
                      <TableRow key={row.id} hover>
                        <TableCell sx={{ fontWeight: 600, color: 'primary.main' }}>{row.id}</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{row.supplier}</TableCell>
                        <TableCell>{row.date}</TableCell>
                        <TableCell>{row.method}</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>₹{(row.amount || 0).toFixed(2)}</TableCell>
                        <TableCell>
                          <Chip label={row.status} color="success" size="small" sx={{ borderRadius: 1, fontWeight: 700 }} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      )}

      {/* Expenses Tab */}
      {currentTab === 2 && (
        <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <CardContent sx={{ p: 0 }}>
            <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
              <Table size="small">
                <TableHead sx={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Expense ID</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Description</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Category</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Date</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Amount</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {expenses.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ py: 8 }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={500}>
                          No clinic expense records logged in the database.
                        </Typography>
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                          Click '+ Record Expense' to add operational expenses.
                        </Typography>
                        <Button 
                          size="small" 
                          variant="outlined" 
                          color="error"
                          startIcon={<AddIcon />} 
                          onClick={() => handleOpenDialog('expense')} 
                          sx={{ mt: 2 }}
                        >
                          + Record First Expense
                        </Button>
                      </TableCell>
                    </TableRow>
                  ) : (
                    expenses.map((row) => (
                      <TableRow key={row.id} hover>
                        <TableCell sx={{ fontWeight: 600, color: 'primary.main' }}>{row.id}</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{row.name}</TableCell>
                        <TableCell>{row.category}</TableCell>
                        <TableCell>{row.date}</TableCell>
                        <TableCell sx={{ fontWeight: 700, color: 'error.main' }}>₹{(row.amount || 0).toFixed(2)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      )}

      {/* Customer Due Tab */}
      {currentTab === 3 && (
        <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <CardContent sx={{ p: 0 }}>
            <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
              <Table size="small">
                <TableHead sx={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Due ID</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Patient</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Phone</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Last Eye Exam</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Outstanding Balance</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {customerDue.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} align="center" sx={{ py: 8 }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={500}>
                          No outstanding patient dues currently recorded in the database.
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Patient balances created during POS Billing will appear here automatically.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    customerDue.map((row) => (
                      <TableRow key={row.id} hover>
                        <TableCell sx={{ fontWeight: 600, color: 'primary.main' }}>{row.id}</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{row.patient}</TableCell>
                        <TableCell>{row.phone}</TableCell>
                        <TableCell>{row.lastExam}</TableCell>
                        <TableCell sx={{ fontWeight: 700, color: 'warning.main' }}>₹{(row.outstanding || 0).toFixed(2)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      )}

      {/* Supplier Due Tab */}
      {currentTab === 4 && (
        <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <CardContent sx={{ p: 0 }}>
            <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
              <Table size="small">
                <TableHead sx={{ backgroundColor: 'rgba(0,0,0,0.02)' }}>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Supplier Due ID</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Supplier Company</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Contact Info</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Outstanding Balance</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {supplierDue.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} align="center" sx={{ py: 8 }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={500}>
                          No outstanding supplier payables currently recorded in the database.
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          Supplier dues logged during purchasing will appear here automatically.
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    supplierDue.map((row) => (
                      <TableRow key={row.id} hover>
                        <TableCell sx={{ fontWeight: 600, color: 'primary.main' }}>{row.id}</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{row.supplier}</TableCell>
                        <TableCell>
                          <Typography variant="body2">{row.phone}</Typography>
                          <Typography variant="caption" color="text.secondary">{row.email}</Typography>
                        </TableCell>
                        <TableCell sx={{ fontWeight: 700, color: 'error.main' }}>₹{(row.balance || 0).toFixed(2)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          </CardContent>
        </Card>
      )}

      {/* Dialog for adding transaction */}
      <Dialog open={openDialog} onClose={() => setOpenDialog(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>
          {dialogType === 'receipt' ? 'Record Patient Receipt' : dialogType === 'payment' ? 'Record Supplier Payment' : 'Record Clinic Expense'}
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ py: 1 }}>
            <TextField 
              label={dialogType === 'receipt' ? 'Patient Name' : dialogType === 'payment' ? 'Supplier Company' : 'Expense Description'} 
              fullWidth 
              required
              value={newTransaction.party} 
              onChange={(e) => setNewTransaction({...newTransaction, party: e.target.value})} 
            />
            {dialogType === 'expense' && (
              <TextField select label="Category" fullWidth value={newTransaction.category} onChange={(e) => setNewTransaction({...newTransaction, category: e.target.value})}>
                <MenuItem value="Clinic Maintenance">Clinic Maintenance</MenuItem>
                <MenuItem value="Consumables">Consumables (Cleaning Kits, Solution)</MenuItem>
                <MenuItem value="Staff Salary">Staff Salaries</MenuItem>
                <MenuItem value="Marketing">Marketing & Flyers</MenuItem>
              </TextField>
            )}
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField label="Amount (₹)" type="number" fullWidth required value={newTransaction.amount} onChange={(e) => setNewTransaction({...newTransaction, amount: e.target.value})} />
              </Grid>
              <Grid item xs={6}>
                <TextField select label="Payment Method" fullWidth value={newTransaction.method} onChange={(e) => setNewTransaction({...newTransaction, method: e.target.value})}>
                  <MenuItem value="Cash">Cash</MenuItem>
                  <MenuItem value="UPI">UPI/QR Code</MenuItem>
                  <MenuItem value="Card">Credit/Debit Card</MenuItem>
                  <MenuItem value="Bank Transfer">Bank Transfer</MenuItem>
                </TextField>
              </Grid>
            </Grid>
            <TextField label="Date" type="date" InputLabelProps={{ shrink: true }} fullWidth value={newTransaction.date} onChange={(e) => setNewTransaction({...newTransaction, date: e.target.value})} />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setOpenDialog(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveTransaction} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            Save Ledger Entry
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
