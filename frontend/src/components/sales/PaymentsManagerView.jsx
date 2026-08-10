import React, { useState } from 'react';
import { 
  Box, Grid, Card, CardContent, Typography, Button, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Chip, TextField, MenuItem, Stack, 
  InputAdornment, Divider, Avatar, Tooltip, IconButton, 
  Dialog, DialogTitle, DialogContent, DialogActions,
  Tabs, Tab
} from '@mui/material';
import { 
  Payment as PaymentIcon,
  Search as SearchIcon,
  Add as AddIcon,
  Print as PrintIcon,
  WhatsApp as WhatsAppIcon,
  QrCode2 as QrCodeIcon,
  AccountBalanceWallet as WalletIcon,
  CreditCard as CardIcon,
  Receipt as ReceiptIcon,
  TrendingUp as CashIcon,
  CheckCircle as SuccessIcon,
  ErrorOutline as DueIcon,
  Inbox as EmptyIcon,
  Send as SendIcon
} from '@mui/icons-material';

export default function PaymentsManagerView({
  payments = [],
  customers = [],
  orders = [],
  onRecordPaymentSubmit
}) {
  const [searchQuery, setSearchQuery] = useState('');
  const [methodFilter, setMethodFilter] = useState('All');
  const [recordDialogOpen, setRecordDialogOpen] = useState(false);
  const [qrModalOpen, setQrModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState('all');

  // Form State for Recording Payment
  const [paymentForm, setPaymentForm] = useState({
    customerId: '',
    amount: '',
    method: 'UPI / PhonePe',
    txnRef: '',
    notes: ''
  });

  // Calculate Metrics
  const totalCollected = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const totalOutstandingDues = customers.reduce((sum, c) => sum + (parseFloat(c.balance) || 0), 0);
  const upiCollected = payments.filter(p => (p.method || '').toLowerCase().includes('upi') || (p.method || '').toLowerCase().includes('gpay')).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
  const cashCollected = payments.filter(p => (p.method || '').toLowerCase().includes('cash')).reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);

  // Filter Payments
  const filteredPayments = payments.filter(p => {
    const matchesSearch = (p.customerName || p.customer || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                          (p.id || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
                          (p.txnRef || '').toLowerCase().includes(searchQuery.toLowerCase());
    const matchesMethod = methodFilter === 'All' || p.method === methodFilter;
    return matchesSearch && matchesMethod;
  });

  // Customers with outstanding dues
  const customersWithDues = customers.filter(c => (parseFloat(c.balance) || 0) > 0);

  const handleOpenRecordForCustomer = (cust) => {
    setPaymentForm({
      customerId: cust.id,
      amount: cust.balance || '',
      method: 'UPI / PhonePe',
      txnRef: `TXN-${Math.floor(100000 + Math.random() * 900000)}`,
      notes: 'Balance Settlement'
    });
    setRecordDialogOpen(true);
  };

  const handleFormSubmit = (e) => {
    e.preventDefault();
    if (!paymentForm.amount || parseFloat(paymentForm.amount) <= 0) return;
    const selectedCust = customers.find(c => c.id === paymentForm.customerId);
    const newPayment = {
      id: `RCP-${Math.floor(1000 + Math.random() * 9000)}`,
      date: new Date().toISOString().split('T')[0],
      customerName: selectedCust ? selectedCust.name : 'Walk-in Customer',
      customerId: paymentForm.customerId,
      amount: parseFloat(paymentForm.amount),
      method: paymentForm.method,
      txnRef: paymentForm.txnRef || `TXN-${Math.floor(100000 + Math.random() * 900000)}`,
      notes: paymentForm.notes || 'Payment Receipt',
      status: 'Settled'
    };

    onRecordPaymentSubmit?.(newPayment, paymentForm.customerId, parseFloat(paymentForm.amount));
    setRecordDialogOpen(false);
    setPaymentForm({ customerId: '', amount: '', method: 'UPI / PhonePe', txnRef: '', notes: '' });
  };

  return (
    <Box>
      {/* Title & Quick Actions Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3.5, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <WalletIcon sx={{ fontSize: 36 }} /> Payment Collections & Treasury Ledger
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Audit payment receipts, cash logs, digital UPI settlements & customer balance collection ledger.
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} flexWrap="wrap">
          <Button
            variant="outlined"
            color="secondary"
            startIcon={<QrCodeIcon />}
            onClick={() => setQrModalOpen(true)}
            sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 600 }}
          >
            Dynamic UPI QR Pay
          </Button>

          <Button
            variant="contained"
            color="primary"
            startIcon={<AddIcon />}
            onClick={() => {
              setPaymentForm({ customerId: '', amount: '', method: 'UPI / PhonePe', txnRef: '', notes: '' });
              setRecordDialogOpen(true);
            }}
            sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700, px: 3 }}
          >
            + Record Payment Collection
          </Button>
        </Stack>
      </Box>

      {/* Treasury Metric Cards */}
      <Grid container spacing={2.5} sx={{ mb: 3.5 }}>
        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: 'background.paper' }}>
            <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">TOTAL PAYMENTS COLLECTED</Typography>
            <Typography variant="h4" fontWeight={900} color="success.main" sx={{ my: 0.5 }}>₹{totalCollected.toLocaleString()}</Typography>
            <Typography variant="caption" color="text.secondary">{payments.length} verified transactions</Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, borderLeft: '4px solid #ef4444', bgcolor: 'background.paper' }}>
            <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">OUTSTANDING CUSTOMER DUES</Typography>
            <Typography variant="h4" fontWeight={900} color="error.main" sx={{ my: 0.5 }}>₹{totalOutstandingDues.toLocaleString()}</Typography>
            <Typography variant="caption" color="text.secondary">{customersWithDues.length} patient accounts pending</Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: 'background.paper' }}>
            <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">DIGITAL UPI / GPAY SETTLEMENTS</Typography>
            <Typography variant="h4" fontWeight={900} color="primary.main" sx={{ my: 0.5 }}>₹{upiCollected.toLocaleString()}</Typography>
            <Typography variant="caption" color="text.secondary">Instant bank settlements</Typography>
          </Card>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Card elevation={0} sx={{ p: 2.5, border: '1px solid', borderColor: 'divider', borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: 'background.paper' }}>
            <Typography variant="caption" fontWeight={700} color="text.secondary" display="block">CASH IN DRAWER LOG</Typography>
            <Typography variant="h4" fontWeight={900} sx={{ color: '#d97706', my: 0.5 }}>₹{cashCollected.toLocaleString()}</Typography>
            <Typography variant="caption" color="text.secondary">Physical cash register</Typography>
          </Card>
        </Grid>
      </Grid>

      {/* Main Workspace Layout (70% Payments Log + 30% Outstanding Customer Dues Ledger) */}
      <Grid container spacing={3}>
        {/* Left Column: Payments Log Table */}
        <Grid item xs={12} lg={7.5}>
          <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
              <Box>
                <Typography variant="h6" fontWeight={800} color="primary.main">
                  Payment Collection Log & Ledger Receipts
                </Typography>
                <Typography variant="body2" color="text.secondary">
                  Real-time audit log of all advance deposits and customer payment settlements.
                </Typography>
              </Box>

              <Stack direction="row" spacing={1.5}>
                <TextField
                  size="small"
                  placeholder="Search receipt ID, patient..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  InputProps={{
                    startAdornment: <InputAdornment position="start"><SearchIcon color="action" fontSize="small" /></InputAdornment>,
                    sx: { borderRadius: 2, width: 220 }
                  }}
                />

                <TextField
                  select
                  size="small"
                  value={methodFilter}
                  onChange={(e) => setMethodFilter(e.target.value)}
                  sx={{ minWidth: 150, '& .MuiSelect-select': { borderRadius: 2 } }}
                >
                  <MenuItem value="All">All Methods</MenuItem>
                  <MenuItem value="UPI / PhonePe">UPI / GPay</MenuItem>
                  <MenuItem value="Cash">Cash</MenuItem>
                  <MenuItem value="Credit Card">Credit Card</MenuItem>
                  <MenuItem value="Store Credit">Store Credit</MenuItem>
                </TextField>
              </Stack>
            </Box>

            {filteredPayments.length === 0 ? (
              /* Empty Database State */
              <Box sx={{ p: 5, textAlign: 'center', bgcolor: 'action.hover', border: '2px dashed', borderColor: 'divider', borderRadius: 3 }}>
                <Avatar sx={{ mx: 'auto', bgcolor: 'primary.main', width: 48, height: 48, mb: 1.5 }}>
                  <EmptyIcon />
                </Avatar>
                <Typography variant="subtitle1" fontWeight={800} gutterBottom>
                  No Payment Records Found in Database
                </Typography>
                <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420, mx: 'auto', mb: 2.5 }}>
                  All payment transaction logs are currently blank. Click below to record a payment collection or settle customer balance.
                </Typography>
                <Button
                  variant="contained"
                  color="primary"
                  startIcon={<AddIcon />}
                  onClick={() => setRecordDialogOpen(true)}
                  sx={{ borderRadius: 2.5, textTransform: 'none', fontWeight: 700 }}
                >
                  + Record First Payment
                </Button>
              </Box>
            ) : (
              <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2.5 }}>
                <Table>
                  <TableHead sx={{ bgcolor: 'action.hover' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 800 }}>Receipt ID</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Date</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Patient Name</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Method</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Amount</TableCell>
                      <TableCell sx={{ fontWeight: 800, textAlign: 'right' }}>Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredPayments.map(p => (
                      <TableRow key={p.id} hover>
                        <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{p.id}</TableCell>
                        <TableCell sx={{ fontSize: '0.85rem' }}>{p.date}</TableCell>
                        <TableCell>
                          <Typography variant="subtitle2" fontWeight={800}>{p.customerName || p.customer}</Typography>
                          <Typography variant="caption" color="text.secondary">Txn Ref: {p.txnRef || 'N/A'}</Typography>
                        </TableCell>
                        <TableCell>
                          <Chip label={p.method || 'Cash'} size="small" color="primary" variant="outlined" sx={{ fontWeight: 700 }} />
                        </TableCell>
                        <TableCell sx={{ fontWeight: 900, color: 'success.main', fontSize: '1rem' }}>
                          +₹{parseFloat(p.amount || 0).toLocaleString()}
                        </TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <Tooltip title="Print Payment Receipt">
                              <IconButton size="small" color="primary" onClick={() => window.print()}>
                                <PrintIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="WhatsApp Receipt">
                              <IconButton size="small" color="success" onClick={() => alert(`Sending payment receipt to ${p.customerName}...`)}>
                                <WhatsAppIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )}
          </Card>
        </Grid>

        {/* Right Column: Outstanding Balances Ledger */}
        <Grid item xs={12} lg={4.5}>
          <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
              <Typography variant="subtitle1" fontWeight={800} color="error.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <DueIcon fontSize="small" /> Outstanding Dues Ledger
              </Typography>
              <Chip label={`${customersWithDues.length} Pending`} color="error" size="small" sx={{ fontWeight: 800 }} />
            </Box>

            <Divider sx={{ mb: 2 }} />

            {customersWithDues.length === 0 ? (
              <Box sx={{ p: 4, textAlign: 'center', bgcolor: 'action.hover', borderRadius: 2.5, border: '1px dashed', borderColor: 'divider' }}>
                <SuccessIcon color="success" sx={{ fontSize: 40, mb: 1 }} />
                <Typography variant="subtitle2" fontWeight={800}>
                  No Outstanding Dues Found
                </Typography>
                <Typography variant="caption" color="text.secondary" display="block">
                  All customer patient accounts are currently fully settled.
                </Typography>
              </Box>
            ) : (
              <Stack spacing={2} sx={{ maxH: 420, overflowY: 'auto', pr: 0.5 }}>
                {customersWithDues.map(cust => (
                  <Card key={cust.id} variant="outlined" sx={{ p: 2, borderRadius: 2.5, borderColor: 'error.light', bgcolor: 'rgba(239, 68, 68, 0.02)' }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 1 }}>
                      <Box>
                        <Typography variant="subtitle2" fontWeight={800}>{cust.name}</Typography>
                        <Typography variant="caption" color="text.secondary">📞 {cust.phone || 'No Phone'}</Typography>
                      </Box>
                      <Typography variant="subtitle1" fontWeight={900} color="error.main">
                        ₹{parseFloat(cust.balance).toLocaleString()}
                      </Typography>
                    </Box>

                    <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
                      <Button
                        size="small"
                        variant="contained"
                        color="error"
                        fullWidth
                        onClick={() => handleOpenRecordForCustomer(cust)}
                        sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700, fontSize: '0.78rem' }}
                      >
                        Settle Balance
                      </Button>
                      <IconButton 
                        size="small" 
                        color="success" 
                        onClick={() => alert(`Sending WhatsApp payment reminder of ₹${cust.balance} to ${cust.name}...`)}
                        sx={{ border: '1px solid', borderColor: 'success.main' }}
                      >
                        <WhatsAppIcon fontSize="small" />
                      </IconButton>
                    </Stack>
                  </Card>
                ))}
              </Stack>
            )}
          </Card>
        </Grid>
      </Grid>

      {/* Record Payment Collection Dialog */}
      <Dialog open={recordDialogOpen} onClose={() => setRecordDialogOpen(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Record Payment Collection</DialogTitle>
        <DialogContent>
          <Box component="form" onSubmit={handleFormSubmit} sx={{ mt: 1 }}>
            <Stack spacing={2}>
              <TextField
                select
                required
                label="Select Patient Customer"
                value={paymentForm.customerId}
                onChange={(e) => setPaymentForm({ ...paymentForm, customerId: e.target.value })}
                size="small"
              >
                <MenuItem value="">-- Select Patient --</MenuItem>
                {customers.map(c => (
                  <MenuItem key={c.id} value={c.id}>
                    {c.name} ({c.phone}) {c.balance > 0 ? `• Due: ₹${c.balance}` : ''}
                  </MenuItem>
                ))}
              </TextField>

              <TextField
                required
                label="Amount Collected (₹)"
                type="number"
                value={paymentForm.amount}
                onChange={(e) => setPaymentForm({ ...paymentForm, amount: e.target.value })}
                size="small"
              />

              <TextField
                select
                label="Payment Method"
                value={paymentForm.method}
                onChange={(e) => setPaymentForm({ ...paymentForm, method: e.target.value })}
                size="small"
              >
                <MenuItem value="UPI / PhonePe">UPI / PhonePe / GPay</MenuItem>
                <MenuItem value="Cash">Cash Payment</MenuItem>
                <MenuItem value="Credit Card">Credit Card</MenuItem>
                <MenuItem value="Debit Card">Debit Card</MenuItem>
                <MenuItem value="Store Credit">Store Credit / Reward</MenuItem>
              </TextField>

              <TextField
                label="Bank / UPI Txn Reference ID"
                placeholder="e.g. UPI-98402948"
                value={paymentForm.txnRef}
                onChange={(e) => setPaymentForm({ ...paymentForm, txnRef: e.target.value })}
                size="small"
              />

              <TextField
                multiline
                rows={2}
                label="Remarks & Notes"
                placeholder="Balance payment for spectacle order..."
                value={paymentForm.notes}
                onChange={(e) => setPaymentForm({ ...paymentForm, notes: e.target.value })}
                size="small"
              />
            </Stack>

            <Box sx={{ mt: 3, display: 'flex', justifyContent: 'flex-end', gap: 1 }}>
              <Button onClick={() => setRecordDialogOpen(false)}>Cancel</Button>
              <Button type="submit" variant="contained" color="success">
                Save & Print Receipt
              </Button>
            </Box>
          </Box>
        </DialogContent>
      </Dialog>

      {/* Dynamic UPI QR Code Pay Dialog */}
      <Dialog open={qrModalOpen} onClose={() => setQrModalOpen(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 800, textAlign: 'center' }}>Dynamic UPI QR Code</DialogTitle>
        <DialogContent sx={{ textAlign: 'center', py: 3 }}>
          <Avatar sx={{ mx: 'auto', bgcolor: 'primary.main', width: 72, height: 72, mb: 2 }}>
            <QrCodeIcon sx={{ fontSize: 44 }} />
          </Avatar>
          <Typography variant="h6" fontWeight={800}>Scan with GPay / PhonePe / Paytm</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, mb: 2 }}>
            Main Branch Greensol Optical Merchant VPA
          </Typography>
          <Chip label="UPI ID: greensol@bank" color="primary" variant="outlined" sx={{ fontWeight: 800 }} />
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button fullWidth onClick={() => setQrModalOpen(false)} variant="contained">
            Close QR Screen
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
