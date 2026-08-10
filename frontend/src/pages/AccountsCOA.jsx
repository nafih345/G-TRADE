import React, { useState, useEffect, useMemo } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import QuickDatePickerField from '../components/common/QuickDatePickerField';
import { useDebounce } from '../hooks/useDebounce';
import { 
  Box, Card, CardContent, Typography, Grid, Button, Tab, Tabs,
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Dialog, DialogTitle, DialogContent, 
  DialogActions, TextField, MenuItem, Stack, Chip, IconButton 
} from '@mui/material';
import {
  Add as AddIcon,
  AttachMoney as MoneyIcon,
  TrendingDown as PaymentIcon,
  TrendingUp as ReceiptIcon,
  PriorityHigh as DueIcon,
  CloudUpload as CloudUploadIcon,
  Download as DownloadIcon,
  FileDownload as FileDownloadIcon,
  Delete as DeleteIcon
} from '@mui/icons-material';
import axios from 'axios';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';

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
  const [confirmDialog, setConfirmDialog] = useState({
    open: false, title: '', message: '', type: 'danger', confirmText: 'Confirm', onConfirm: null
  });

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

      // 2. AUTOMATIC SUPPLIER PAYMENTS (from Purchase Orders, LocalStorage DB & Vendor Payments)
      let autoSupplierPayments = [];
      try {
        const savedDB = JSON.parse(localStorage.getItem('optical_supplier_payments_db') || '[]');
        if (Array.isArray(savedDB) && savedDB.length > 0) {
          autoSupplierPayments.push(...savedDB);
        }

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
        let suppRes;
        try {
          suppRes = await axios.get('/api/purchase/suppliers/');
        } catch (e1) {
          suppRes = await axios.get('/api/purchasing/suppliers/');
        }
        const suppData = suppRes.data?.results || suppRes.data || [];
        if (Array.isArray(suppData)) {
          suppData.forEach((s, i) => {
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

  // Dynamically Load SheetJS XLSX Parser Library
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

  // Excel / CSV File Upload Handler for Batch Supplier Payments
  const handleExcelPaymentUpload = async (event) => {
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

      let startIdx = 0;
      let idIdx = 0, suppIdx = 1, dateIdx = 2, methodIdx = 3, amountIdx = 4;

      const firstRowStr = (rawRows[0] || []).join(' ').toLowerCase();
      if (firstRowStr.includes('payment') || firstRowStr.includes('supplier') || firstRowStr.includes('amount') || firstRowStr.includes('method') || firstRowStr.includes('date')) {
        startIdx = 1;
        const headers = rawRows[0].map(h => String(h || '').trim().toLowerCase());
        headers.forEach((h, idx) => {
          if (h.includes('id') || h.includes('ref')) idIdx = idx;
          else if (h.includes('supplier') || h.includes('vendor') || h.includes('party')) suppIdx = idx;
          else if (h.includes('date')) dateIdx = idx;
          else if (h.includes('method') || h.includes('mode') || h.includes('type')) methodIdx = idx;
          else if (h.includes('amount') || h.includes('paid') || h.includes('total') || h.includes('val')) amountIdx = idx;
        });
      }

      const imported = [];
      for (let i = startIdx; i < rawRows.length; i++) {
        const row = rawRows[i];
        if (!row || row.length === 0) continue;

        const suppName = String(row[suppIdx] || row[idIdx] || '').trim();
        const amt = parseFloat(row[amountIdx]) || 0;
        if (!suppName && amt === 0) continue;

        const payObj = {
          id: String(row[idIdx] || `PAY-EXCEL-${Math.floor(1000 + Math.random() * 9000)}`),
          supplier: suppName || 'Supplier Vendor',
          date: String(row[dateIdx] || new Date().toISOString().split('T')[0]),
          method: String(row[methodIdx] || 'Bank Transfer'),
          amount: amt,
          status: 'Completed'
        };

        imported.push(payObj);
      }

      if (imported.length === 0) {
        alert("No valid payment rows found in the uploaded Excel file.");
        event.target.value = '';
        return;
      }

      setPayments(prev => {
        const combined = [...imported, ...prev];
        const uniqueMap = new Map();
        combined.forEach(p => uniqueMap.set(p.id, p));
        return Array.from(uniqueMap.values());
      });

      try {
        const existingSaved = JSON.parse(localStorage.getItem('optical_supplier_payments_db') || '[]');
        localStorage.setItem('optical_supplier_payments_db', JSON.stringify([...imported, ...existingSaved]));
      } catch (e) {}

      alert(`Successfully recorded ${imported.length} supplier payment(s) from Excel file!`);
    } catch (err) {
      alert("Error reading Excel file: " + err.message);
    }
    event.target.value = '';
  };

  // Download Sample Excel Template for Payments
  const handleDownloadPaymentTemplate = () => {
    const csvContent = "Payment ID,Supplier Vendor Name,Payment Date,Payment Method,Payment Amount (INR),Status\n" +
      "PAY-GRN-5738,Greensol Optical,2026-07-29,Bank Transfer,50000.00,Completed\n" +
      "PAY-EX-1002,Luxottica India,2026-07-28,UPI,15500.00,Completed\n" +
      "PAY-EX-1003,Essilor Care,2026-07-27,Cheque,22000.00,Completed";

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = "Supplier_Payments_Import_Template.csv";
    a.click();
  };

  // Export Recorded Payments to Excel / CSV
  const handleExportPaymentsExcel = () => {
    if (payments.length === 0) {
      alert("No payments recorded to export.");
      return;
    }
    let csvContent = "Payment ID,Supplier Vendor Name,Payment Date,Payment Method,Payment Amount (INR),Status\n";
    payments.forEach(p => {
      csvContent += `"${p.id}","${p.supplier}","${p.date}","${p.method}","${p.amount}","${p.status}"\n`;
    });

    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Supplier_Payments_Export_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  // Delete Supplier Payment Handler
  const handleDeletePayment = (paymentId) => {
    setConfirmDialog({
      open: true,
      title: "Delete Payment Record",
      message: `Are you sure you want to delete payment record '${paymentId}'?`,
      type: 'danger',
      confirmText: "Delete Record",
      onConfirm: () => {
        setPayments(prev => prev.filter(p => p.id !== paymentId));

        try {
          const savedDB = JSON.parse(localStorage.getItem('optical_supplier_payments_db') || '[]');
          const updatedDB = savedDB.filter(p => p.id !== paymentId);
          localStorage.setItem('optical_supplier_payments_db', JSON.stringify(updatedDB));

          const savedPos = JSON.parse(localStorage.getItem('optical_purchase_orders') || '[]');
          const poId = paymentId.replace('PAY-', '');
          const updatedPos = savedPos.map(po => po.id === poId ? { ...po, paid: false, status: 'Sent to Vendor' } : po);
          localStorage.setItem('optical_purchase_orders', JSON.stringify(updatedPos));

          window.dispatchEvent(new Event('optical_accounts_updated'));
        } catch (e) {}
      }
    });
  };

  // Delete Patient Receipt Handler
  const handleDeleteReceipt = (receiptId) => {
    setConfirmDialog({
      open: true,
      title: "Delete Patient Receipt",
      message: `Are you sure you want to delete receipt record '${receiptId}'?`,
      type: 'danger',
      confirmText: "Delete Receipt",
      onConfirm: () => {
        setReceipts(prev => prev.filter(r => r.id !== receiptId));
      }
    });
  };

  // Delete Clinic Expense Handler
  const handleDeleteExpense = (expenseId) => {
    setConfirmDialog({
      open: true,
      title: "Delete Clinic Expense",
      message: `Are you sure you want to delete expense record '${expenseId}'?`,
      type: 'danger',
      confirmText: "Delete Expense",
      onConfirm: () => {
        setExpenses(prev => prev.filter(e => e.id !== expenseId));
      }
    });
  };

  // Dynamic KPI Calculations (Memoized for high performance)
  const totalReceiptsAmt = useMemo(() => receipts.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0), [receipts]);
  const totalPaymentsAmt = useMemo(() => payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0), [payments]);
  const totalExpensesAmt = useMemo(() => expenses.reduce((sum, e) => sum + (parseFloat(e.amount) || 0), 0), [expenses]);
  const netCashBalance = useMemo(() => Math.max(0, totalReceiptsAmt - (totalPaymentsAmt + totalExpensesAmt)), [totalReceiptsAmt, totalPaymentsAmt, totalExpensesAmt]);

  const totalPatientDues = useMemo(() => customerDue.reduce((sum, c) => sum + (parseFloat(c.outstanding) || 0), 0), [customerDue]);
  const totalSupplierDues = useMemo(() => supplierDue.reduce((sum, s) => sum + (parseFloat(s.balance) || 0), 0), [supplierDue]);

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Header section */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>Optical ERP Accounts Ledger</Typography>
          <Typography variant="body2" color="text.secondary">Monitor clinical receipts, supplier payments, cash flow, and patient/supplier dues</Typography>
        </Box>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" gap={1}>
          <Button variant="outlined" startIcon={<ReceiptIcon />} onClick={() => handleOpenDialog('receipt')}>
            + New Receipt
          </Button>
          {currentTab === 1 && (
            <Button variant="outlined" color="success" component="label" startIcon={<CloudUploadIcon />} sx={{ fontWeight: 700 }}>
              Upload Payments Excel
              <input type="file" hidden accept=".csv, .xlsx, .xls" onChange={handleExcelPaymentUpload} />
            </Button>
          )}
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
        <Stack spacing={2.5}>
          {/* Payments Excel Toolbar */}
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
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between" alignItems="center">
              <Box>
                <Typography variant="subtitle1" fontWeight={800}>Supplier Payments Ledger</Typography>
                <Typography variant="caption" color="text.secondary">Record vendor payments manually or batch import/export via Excel sheet</Typography>
              </Box>
              <Stack direction="row" spacing={1.5} flexWrap="wrap" gap={1}>
                <Button
                  variant="outlined"
                  color="primary"
                  size="small"
                  startIcon={<DownloadIcon />}
                  onClick={handleDownloadPaymentTemplate}
                  sx={{ borderRadius: 2.5, fontWeight: 700, textTransform: 'none' }}
                >
                  Excel Template
                </Button>
                <Button
                  variant="outlined"
                  color="success"
                  size="small"
                  component="label"
                  startIcon={<CloudUploadIcon />}
                  sx={{ borderRadius: 2.5, fontWeight: 700, textTransform: 'none' }}
                >
                  Upload Payments Excel
                  <input type="file" hidden accept=".csv, .xlsx, .xls" onChange={handleExcelPaymentUpload} />
                </Button>
                <Button
                  variant="outlined"
                  color="info"
                  size="small"
                  startIcon={<FileDownloadIcon />}
                  onClick={handleExportPaymentsExcel}
                  sx={{ borderRadius: 2.5, fontWeight: 700, textTransform: 'none' }}
                >
                  Export Excel
                </Button>
                <Button
                  variant="contained"
                  size="small"
                  startIcon={<PaymentIcon />}
                  onClick={() => handleOpenDialog('payment')}
                  sx={{ backgroundColor: '#2563EB', borderRadius: 2.5, fontWeight: 700, textTransform: 'none' }}
                >
                  + Record Payment
                </Button>
              </Stack>
            </Stack>
          </Card>

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
                      <TableCell align="right" sx={{ fontWeight: 700 }}>Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {payments.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No supplier payment logs recorded in the database.
                          </Typography>
                          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5, mb: 2 }}>
                            Upload an Excel sheet or click '+ Record Payment' to log vendor payments.
                          </Typography>
                          <Stack direction="row" spacing={2} justifyContent="center">
                            <Button 
                              size="small" 
                              variant="outlined" 
                              color="success"
                              component="label"
                              startIcon={<CloudUploadIcon />}
                              sx={{ fontWeight: 700 }}
                            >
                              Upload Payments Excel
                              <input type="file" hidden accept=".csv, .xlsx, .xls" onChange={handleExcelPaymentUpload} />
                            </Button>
                            <Button 
                              size="small" 
                              variant="contained" 
                              startIcon={<PaymentIcon />} 
                              onClick={() => handleOpenDialog('payment')} 
                              sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}
                            >
                              + Record Payment
                            </Button>
                          </Stack>
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
                          <TableCell align="right">
                            <IconButton 
                              color="error" 
                              size="small" 
                              onClick={() => handleDeletePayment(row.id)}
                              title="Delete Payment Record"
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </CardContent>
          </Card>
        </Stack>
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
            <QuickDatePickerField 
              label="Date" 
              fullWidth 
              value={newTransaction.date} 
              onChange={(newDate) => setNewTransaction({ ...newTransaction, date: newDate })} 
              quickPresets={[
                { label: 'Today', type: 'today' },
                { label: 'Yesterday', type: 'yesterday' },
                { label: '-7 Days', type: 'days', amount: -7 },
              ]}
            />
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setOpenDialog(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveTransaction} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            Save Ledger Entry
          </Button>
        </DialogActions>
      </Dialog>

      {/* Styled MUI Confirm Dialog */}
      <ConfirmActionDialog 
        open={confirmDialog.open}
        title={confirmDialog.title}
        message={confirmDialog.message}
        type={confirmDialog.type}
        confirmText={confirmDialog.confirmText}
        onClose={() => setConfirmDialog({ ...confirmDialog, open: false })}
        onConfirm={confirmDialog.onConfirm}
      />
    </Box>
  );
}
