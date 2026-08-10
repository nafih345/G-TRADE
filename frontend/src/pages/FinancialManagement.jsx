import React, { useState, useEffect, useMemo, Component } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useDebounce } from '../hooks/useDebounce';
import { 
  Box, Card, CardContent, Typography, Grid, Button, Tab, Tabs, 
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, 
  Paper, Dialog, DialogTitle, DialogContent, DialogActions, TextField, 
  MenuItem, Stack, Chip, IconButton, LinearProgress, Divider, Alert, Tooltip, Drawer, Snackbar, Switch, FormControlLabel, Collapse, ToggleButton, ToggleButtonGroup, Autocomplete
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  AccountTree as ChartIcon,
  Book as JournalIcon,
  MenuBook as LedgerIcon,
  Scale as TrialIcon,
  ShowChart as ProfitIcon,
  AccountBalance as BalanceIcon,
  Assessment as ReportIcon,
  Search as SearchIcon,
  Add as AddIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Visibility as ViewIcon,
  ExpandMore as ExpandMoreIcon,
  ChevronRight as ChevronRightIcon,
  FileDownload as FileDownloadIcon,
  Download as DownloadIcon,
  Print as PrintIcon,
  CloudUpload as CloudUploadIcon,
  CheckCircle as CheckIcon,
  Warning as WarningIcon,
  Folder as FolderIcon,
  FolderOpen as FolderOpenIcon,
  Refresh as RefreshIcon,
  TrendingUp as ReceiptIcon,
  TrendingDown as PaymentIcon,
  CompareArrows as SwapIcon,
  Undo as ReverseIcon,
  FilterList as FilterIcon
} from '@mui/icons-material';
import axios from 'axios';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';

// Fixed Sub-Categories per Group (NO COGS!)
const ACCOUNT_GROUPS = {
  Assets: [
    'Current Assets', 'Fixed Assets', 'Bank Accounts', 
    'Cash Accounts', 'Inventory Assets', 'Accounts Receivable', 'Other Assets'
  ],
  Liabilities: [
    'Current Liabilities', 'Long-Term Liabilities', 
    'Accounts Payable', 'GST Payable', 'Other Liabilities'
  ],
  Equity: [
    'Owner Capital', 'Partner Capital', 'Retained Earnings', 'Current Year Profit'
  ],
  Income: [
    'Retail Sales', 'Wholesale Sales', 'Service Income', 'Eye Test Income', 'Other Income'
  ],
  Expenses: [
    'Administrative', 'Selling', 'Operating', 'Financial', 
    'Salary', 'Rent', 'Electricity', 'Internet', 
    'Office', 'Transport', 'Marketing', 'Miscellaneous'
  ]
};

// Default Permanent 5 Core Account Types
const DEFAULT_ACCOUNT_TYPES = ['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses'];

// Behavior Rules Mapping for Core Types
const TYPE_BEHAVIOR_RULES = {
  Assets: { normal_balance: 'DEBIT', statement_type: 'BALANCE_SHEET', base_type: 'Assets' },
  Liabilities: { normal_balance: 'CREDIT', statement_type: 'BALANCE_SHEET', base_type: 'Liabilities' },
  Equity: { normal_balance: 'CREDIT', statement_type: 'BALANCE_SHEET', base_type: 'Equity' },
  Income: { normal_balance: 'CREDIT', statement_type: 'P&L', base_type: 'Income' },
  Expenses: { normal_balance: 'DEBIT', statement_type: 'P&L', base_type: 'Expenses' }
};

// Aliases for uppercase / plural variants to prevent runtime key lookup crashes
ACCOUNT_GROUPS.ASSET = ACCOUNT_GROUPS.Assets;
ACCOUNT_GROUPS.ASSETS = ACCOUNT_GROUPS.Assets;
ACCOUNT_GROUPS.LIABILITY = ACCOUNT_GROUPS.Liabilities;
ACCOUNT_GROUPS.LIABILITIES = ACCOUNT_GROUPS.Liabilities;
ACCOUNT_GROUPS.EQUITY = ACCOUNT_GROUPS.Equity;
ACCOUNT_GROUPS.INCOME = ACCOUNT_GROUPS.Income;
ACCOUNT_GROUPS.EXPENSE = ACCOUNT_GROUPS.Expenses;
ACCOUNT_GROUPS.EXPENSES = ACCOUNT_GROUPS.Expenses;

// Safe Sub-Category Lookup Helper
const getAccountGroups = (type) => {
  if (!type) return ACCOUNT_GROUPS.Assets;
  return ACCOUNT_GROUPS[type] || ACCOUNT_GROUPS[type.toString().toUpperCase()] || ACCOUNT_GROUPS.Assets;
};

// Normalize Account Type to standard casing
const normalizeAccountType = (type) => {
  if (!type) return 'Assets';
  const t = type.toString().toUpperCase();
  if (t === 'ASSET' || t === 'ASSETS') return 'Assets';
  if (t === 'LIABILITY' || t === 'LIABILITIES') return 'Liabilities';
  if (t === 'EQUITY') return 'Equity';
  if (t === 'INCOME') return 'Income';
  if (t === 'EXPENSE' || t === 'EXPENSES') return 'Expenses';
  return 'Assets';
};

// React Error Boundary Component to prevent blank dark screen crashes
class FinancialErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error("Financial Module Render Error:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <Box sx={{ p: 4, textAlign: 'center', bgcolor: '#ffffff', minHeight: '80vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
          <Alert severity="error" sx={{ mb: 3, maxWidth: 500, fontWeight: 700, borderRadius: 3 }}>
            A rendering error occurred in the Financial Module.
          </Alert>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            {this.state.error?.toString()}
          </Typography>
          <Button 
            variant="contained" 
            startIcon={<RefreshIcon />}
            onClick={() => {
              localStorage.removeItem('optical_financial_accounts');
              window.location.reload();
            }}
            sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}
          >
            Reset Financial Data & Reload
          </Button>
        </Box>
      );
    }
    return this.props.children;
  }
}

// Reusable Standardized Voucher Form Component for Receipt, Payment & Contra Entries
function StandardVoucherForm({ voucherType, accounts, cashOrBankAccounts, partiesList, showToast, onSaveVoucher }) {
  const isReceipt = voucherType === 'RECEIPT';
  const isPayment = voucherType === 'PAYMENT';
  const isContra = voucherType === 'CONTRA';

  const voucherTitle = isReceipt ? 'Receipt Voucher' : isPayment ? 'Payment Voucher' : 'Contra Entry';
  const voucherPrefix = isReceipt ? 'RV' : isPayment ? 'PV' : 'CV';
  const voucherColorHex = isReceipt ? '#10b981' : isPayment ? '#ef4444' : '#2563eb';
  const partyLabel = isPayment ? 'Payee / Supplier / Party' : isContra ? 'Transfer Description / Party' : 'Customer / Received From';

  const accountOptions = useMemo(() => {
    if (isContra) return cashOrBankAccounts;
    return accounts;
  }, [isContra, cashOrBankAccounts, accounts]);

  const createBlankVoucherState = () => ({
    id: null,
    voucherNo: `${voucherPrefix}-${Math.floor(1000 + Math.random() * 9000)}`,
    date: new Date().toISOString().split('T')[0],
    party: null,
    mode: 'Normal',
    narration: '',
    isSaved: false
  });

  const [voucherState, setVoucherState] = useState(createBlankVoucherState);

  const [accountLines, setAccountLines] = useState([
    { id: 1, account: null, accountCode: '', accountName: '', mainAccount: '', narration: '', refNo: '', amount: '' }
  ]);

  const [paymentLines, setPaymentLines] = useState([
    { id: 1, amount: '', payMode: 'Cash', refNo: '', refDate: new Date().toISOString().split('T')[0], bankAccount: null }
  ]);

  const totalAccountAmount = useMemo(() => {
    return accountLines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
  }, [accountLines]);

  const totalPaidAmount = useMemo(() => {
    return paymentLines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
  }, [paymentLines]);

  const isBalanced = useMemo(() => {
    return Math.abs(totalAccountAmount - totalPaidAmount) < 0.01 && totalAccountAmount > 0;
  }, [totalAccountAmount, totalPaidAmount]);

  const isValid = useMemo(() => {
    if (!isBalanced) return false;
    const hasValidAccountLine = accountLines.some(l => l.account && (parseFloat(l.amount) || 0) > 0);
    const hasValidPaymentLine = paymentLines.some(l => (parseFloat(l.amount) || 0) > 0 && (l.payMode === 'Cash' || l.bankAccount));
    return hasValidAccountLine && hasValidPaymentLine;
  }, [isBalanced, accountLines, paymentLines]);

  const handleAddAccountLine = () => {
    setAccountLines(prev => [
      ...prev,
      { id: Date.now() + Math.random(), account: null, accountCode: '', accountName: '', mainAccount: '', narration: '', refNo: '', amount: '' }
    ]);
  };

  const handleRemoveAccountLine = (index) => {
    setAccountLines(prev => prev.filter((_, i) => i !== index));
  };

  const handleAccountChange = (index, selectedAcc) => {
    setAccountLines(prev => {
      const next = [...prev];
      if (selectedAcc) {
        next[index] = {
          ...next[index],
          account: selectedAcc,
          accountCode: selectedAcc.code,
          accountName: selectedAcc.name,
          mainAccount: selectedAcc.account_type || selectedAcc.account_group || 'General'
        };
      } else {
        next[index] = {
          ...next[index],
          account: null,
          accountCode: '',
          accountName: '',
          mainAccount: ''
        };
      }
      return next;
    });
  };

  const handleAccountLineFieldChange = (index, field, value) => {
    setAccountLines(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleAddPaymentLine = () => {
    setPaymentLines(prev => [
      ...prev,
      { id: Date.now() + Math.random(), amount: '', payMode: 'Cash', refNo: '', refDate: new Date().toISOString().split('T')[0], bankAccount: null }
    ]);
  };

  const handleRemovePaymentLine = (index) => {
    setPaymentLines(prev => prev.filter((_, i) => i !== index));
  };

  const handlePaymentLineFieldChange = (index, field, value) => {
    setPaymentLines(prev => {
      const next = [...prev];
      next[index] = { ...next[index], [field]: value };
      return next;
    });
  };

  const handleNew = () => {
    setVoucherState(createBlankVoucherState());
    setAccountLines([
      { id: 1, account: null, accountCode: '', accountName: '', mainAccount: '', narration: '', refNo: '', amount: '' }
    ]);
    setPaymentLines([
      { id: 1, amount: '', payMode: 'Cash', refNo: '', refDate: new Date().toISOString().split('T')[0], bankAccount: null }
    ]);
  };

  const handleReset = () => {
    handleNew();
    showToast("Form reset to fresh draft.", "info");
  };

  const handleSave = () => {
    if (!isValid) return;
    const partyName = typeof voucherState.party === 'object' && voucherState.party ? voucherState.party.name : (voucherState.party || 'General Party');

    const formattedLines = [];

    accountLines.forEach(l => {
      const amt = parseFloat(l.amount) || 0;
      if (l.account && amt > 0) {
        formattedLines.push({
          account: l.accountCode,
          debit: isPayment ? amt : 0,
          credit: isReceipt ? amt : (isContra ? 0 : amt),
          narration: l.narration || voucherState.narration,
          ref_no: l.refNo
        });
      }
    });

    paymentLines.forEach(p => {
      const amt = parseFloat(p.amount) || 0;
      if (amt > 0) {
        const bankCode = p.payMode === 'Cash' ? (cashOrBankAccounts.find(a => a.name.toLowerCase().includes('cash'))?.code || '1001') : (p.bankAccount?.code || '1002');
        formattedLines.push({
          account: bankCode,
          debit: isReceipt ? amt : 0,
          credit: isPayment ? amt : (isContra ? amt : 0),
          narration: `${p.payMode} Payment - ${p.refNo || ''}`
        });
      }
    });

    const newVoucher = {
      id: `${voucherPrefix}-${Date.now()}`,
      entry_number: voucherState.voucherNo,
      date: voucherState.date,
      voucher_type_code: voucherPrefix,
      voucher_type_name: voucherTitle,
      party_name: partyName,
      mode: voucherState.mode,
      description: voucherState.narration || `${voucherTitle} for ${partyName}`,
      status: 'POSTED',
      amount: totalAccountAmount,
      items: formattedLines
    };

    onSaveVoucher(newVoucher);
    setVoucherState(prev => ({ ...prev, isSaved: true }));
  };

  return (
    <Box>
      {/* 1. STICKY TOP ACTION TOOLBAR */}
      <Paper 
        elevation={0} 
        variant="outlined" 
        sx={{ 
          position: 'sticky', 
          top: 0, 
          zIndex: 100, 
          p: 1.5, 
          mb: 3, 
          borderRadius: 3, 
          bgcolor: '#ffffff',
          borderColor: '#e2e8f0',
          boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 1.5
        }}
      >
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Chip 
            label={`${voucherTitle} (${voucherPrefix})`} 
            sx={{ backgroundColor: voucherColorHex, color: '#ffffff', fontWeight: 850, fontSize: '0.875rem' }} 
          />
          <Typography variant="subtitle2" color="text.secondary" fontWeight={700}>
            {voucherState.isSaved ? '✅ Posted Voucher' : '📝 Unsaved Draft'}
          </Typography>
        </Stack>

        <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
          <Button variant="outlined" size="small" startIcon={<AddIcon />} onClick={handleNew}>
            New
          </Button>
          <Button variant="outlined" size="small" startIcon={<EditIcon />} disabled={!voucherState.isSaved} onClick={() => showToast("Voucher edit mode enabled", "info")}>
            Edit
          </Button>
          <Button 
            variant="contained" 
            size="small" 
            startIcon={<CheckIcon />} 
            disabled={!isValid} 
            onClick={handleSave}
            sx={{ backgroundColor: voucherColorHex, fontWeight: 800, '&:hover': { backgroundColor: voucherColorHex } }}
          >
            Save
          </Button>
          <Button variant="outlined" size="small" startIcon={<PrintIcon />} disabled={!voucherState.isSaved} onClick={() => window.print()}>
            Print
          </Button>
          <Button variant="outlined" size="small" color="error" startIcon={<DeleteIcon />} disabled={!voucherState.isSaved} onClick={() => showToast("Voucher deleted", "info")}>
            Delete
          </Button>
          <Button variant="outlined" size="small" startIcon={<RefreshIcon />} onClick={handleReset}>
            Refresh
          </Button>
        </Stack>
      </Paper>

      {/* 2. HEADER SECTION BELOW TOOLBAR */}
      <Card variant="outlined" sx={{ p: 3, mb: 3, borderRadius: 4, bgcolor: '#ffffff' }}>
        <Typography variant="subtitle1" fontWeight={850} sx={{ mb: 2 }}>
          Voucher Header Information
        </Typography>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={6} md={3}>
            <TextField 
              fullWidth size="small" label="Voucher No (Auto)" 
              value={voucherState.voucherNo} 
              InputProps={{ readOnly: true }} 
              sx={{ bgcolor: '#f8fafc' }} 
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <TextField 
              type="date" fullWidth size="small" label="Date *" 
              value={voucherState.date} 
              onChange={(e) => setVoucherState(prev => ({ ...prev, date: e.target.value }))}
              InputLabelProps={{ shrink: true }} 
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Autocomplete
              options={partiesList}
              getOptionLabel={(option) => typeof option === 'string' ? option : `${option.name || ''} ${option.code ? `(${option.code})` : ''}`}
              value={voucherState.party}
              onChange={(e, newVal) => setVoucherState(prev => ({ ...prev, party: newVal }))}
              renderInput={(params) => (
                <TextField {...params} label={`${partyLabel} *`} placeholder="Search party..." size="small" />
              )}
            />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <Box>
              <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>
                {voucherPrefix} Mode Toggle
              </Typography>
              <ToggleButtonGroup
                size="small"
                exclusive
                value={voucherState.mode}
                onChange={(e, newMode) => {
                  if (newMode) setVoucherState(prev => ({ ...prev, mode: newMode }));
                }}
                sx={{ width: '100%' }}
              >
                <ToggleButton value="Normal" sx={{ flex: 1, fontWeight: 700, py: 0.5 }}>Normal</ToggleButton>
                <ToggleButton value="Bill to Bill" sx={{ flex: 1, fontWeight: 700, py: 0.5 }}>Bill to Bill</ToggleButton>
              </ToggleButtonGroup>
            </Box>
          </Grid>
        </Grid>
      </Card>

      {/* 3. ACCOUNT LINES SECTION (EDITABLE GRID) */}
      <Card variant="outlined" sx={{ borderRadius: 4, overflow: 'hidden', mb: 3 }}>
        <Box sx={{ p: 2, px: 3, bgcolor: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="subtitle1" fontWeight={850}>
            Account Lines ({isReceipt ? 'Credit Accounts' : isPayment ? 'Debit Accounts' : 'Cash/Bank Accounts'})
          </Typography>
          <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={handleAddAccountLine} sx={{ backgroundColor: '#2563eb', fontWeight: 700 }}>
            + Add Line
          </Button>
        </Box>
        <TableContainer component={Paper} elevation={0} sx={{ overflowX: 'auto' }}>
          <Table sx={{ minWidth: 850 }}>
            <TableHead sx={{ bgcolor: '#f1f5f9' }}>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, minWidth: 120 }}>Account Code</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 220 }}>Account Name *</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 140 }}>Main Account</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 180 }}>Narration</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 130 }}>Ref No</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 140 }} align="right">Amount (₹) *</TableCell>
                <TableCell sx={{ fontWeight: 700, width: 50 }} align="center">Act</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {accountLines.map((line, idx) => (
                <TableRow key={line.id}>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'primary.main' }}>
                    {line.accountCode || '-'}
                  </TableCell>
                  <TableCell>
                    <Autocomplete
                      options={accountOptions}
                      getOptionLabel={(a) => `${a.code} - ${a.name} (${a.account_type || a.account_group})`}
                      value={line.account}
                      onChange={(e, selectedAcc) => handleAccountChange(idx, selectedAcc)}
                      renderInput={(params) => (
                        <TextField {...params} size="small" placeholder="Search Account..." />
                      )}
                    />
                  </TableCell>
                  <TableCell>
                    <Chip label={line.mainAccount || 'General'} size="small" variant="outlined" sx={{ fontWeight: 600 }} />
                  </TableCell>
                  <TableCell>
                    <TextField 
                      size="small" fullWidth 
                      placeholder="Line narration..." 
                      value={line.narration} 
                      onChange={(e) => handleAccountLineFieldChange(idx, 'narration', e.target.value)} 
                    />
                  </TableCell>
                  <TableCell>
                    <TextField 
                      size="small" fullWidth 
                      placeholder="Bill/Ref #" 
                      value={line.refNo} 
                      onChange={(e) => handleAccountLineFieldChange(idx, 'refNo', e.target.value)} 
                    />
                  </TableCell>
                  <TableCell align="right">
                    <TextField 
                      type="number" size="small" 
                      value={line.amount} 
                      onChange={(e) => handleAccountLineFieldChange(idx, 'amount', e.target.value)}
                      sx={{ width: 130, '& .MuiInputBase-input': { textAlign: 'right', fontWeight: 700 } }}
                    />
                  </TableCell>
                  <TableCell align="center">
                    <IconButton size="small" color="error" disabled={accountLines.length <= 1} onClick={() => handleRemoveAccountLine(idx)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {/* 4. PAYMENT MODE SECTION (SPLIT PAYMENT TABLE) */}
      <Card variant="outlined" sx={{ borderRadius: 4, overflow: 'hidden', mb: 4 }}>
        <Box sx={{ p: 2, px: 3, bgcolor: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="subtitle1" fontWeight={850}>
            Payment Mode & Split Payments ({isReceipt ? 'Inflow Settlement' : isPayment ? 'Outflow Settlement' : 'Transfer Details'})
          </Typography>
          <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={handleAddPaymentLine} sx={{ fontWeight: 700 }}>
            + Add Payment
          </Button>
        </Box>
        <TableContainer component={Paper} elevation={0} sx={{ overflowX: 'auto' }}>
          <Table sx={{ minWidth: 850 }}>
            <TableHead sx={{ bgcolor: '#f1f5f9' }}>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, minWidth: 140 }} align="right">Amount (₹) *</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 150 }}>Pay Mode *</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 160 }}>Ref / Instrument No</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 140 }}>Ref Date</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 220 }}>Bank Account (Non-Cash)</TableCell>
                <TableCell sx={{ fontWeight: 700, width: 50 }} align="center">Act</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {paymentLines.map((line, idx) => (
                <TableRow key={line.id}>
                  <TableCell align="right">
                    <TextField 
                      type="number" size="small" 
                      value={line.amount} 
                      onChange={(e) => handlePaymentLineFieldChange(idx, 'amount', e.target.value)}
                      sx={{ width: 130, '& .MuiInputBase-input': { textAlign: 'right', fontWeight: 700 } }}
                    />
                  </TableCell>
                  <TableCell>
                    <TextField 
                      select size="small" fullWidth 
                      value={line.payMode} 
                      onChange={(e) => handlePaymentLineFieldChange(idx, 'payMode', e.target.value)}
                    >
                      <MenuItem value="Cash">Cash</MenuItem>
                      <MenuItem value="Bank">Bank Transfer</MenuItem>
                      <MenuItem value="Cheque">Cheque</MenuItem>
                      <MenuItem value="UPI">UPI / Digital</MenuItem>
                    </TextField>
                  </TableCell>
                  <TableCell>
                    <TextField 
                      size="small" fullWidth 
                      placeholder={line.payMode === 'Cheque' ? 'Cheque No' : line.payMode === 'UPI' ? 'UTR / Ref No' : 'Ref No'} 
                      value={line.refNo} 
                      onChange={(e) => handlePaymentLineFieldChange(idx, 'refNo', e.target.value)} 
                    />
                  </TableCell>
                  <TableCell>
                    <TextField 
                      type="date" size="small" fullWidth 
                      value={line.refDate} 
                      onChange={(e) => handlePaymentLineFieldChange(idx, 'refDate', e.target.value)} 
                    />
                  </TableCell>
                  <TableCell>
                    <Autocomplete
                      disabled={line.payMode === 'Cash'}
                      options={cashOrBankAccounts.filter(a => (a.account_group || '').toLowerCase().includes('bank') || a.name.toLowerCase().includes('bank'))}
                      getOptionLabel={(a) => `${a.code} - ${a.name}`}
                      value={line.bankAccount}
                      onChange={(e, selectedBank) => handlePaymentLineFieldChange(idx, 'bankAccount', selectedBank)}
                      renderInput={(params) => (
                        <TextField {...params} size="small" placeholder={line.payMode === 'Cash' ? 'N/A (Cash)' : 'Select Bank...'} />
                      )}
                    />
                  </TableCell>
                  <TableCell align="center">
                    <IconButton size="small" color="error" disabled={paymentLines.length <= 1} onClick={() => handleRemovePaymentLine(idx)}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {/* 5. STICKY FOOTER WITH RUNNING TOTALS & INLINE VALIDATION */}
      <Paper 
        elevation={0} 
        variant="outlined" 
        sx={{ 
          position: 'sticky', 
          bottom: 16, 
          zIndex: 100, 
          p: 2, 
          px: 3,
          borderRadius: 3, 
          bgcolor: '#ffffff',
          boxShadow: '0 4px 16px rgba(0,0,0,0.1)',
          border: isBalanced ? '1px solid #10b981' : '1px solid #ef4444',
          transition: 'all 0.2s ease'
        }}
      >
        <Grid container spacing={2} alignItems="center" justifyContent="space-between">
          <Grid item xs={12} md={7}>
            <Stack direction="row" spacing={3} alignItems="center" flexWrap="wrap" gap={1}>
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL ACCOUNT AMOUNT</Typography>
                <Typography variant="h6" fontWeight={850} color="primary.main">
                  ₹{totalAccountAmount.toFixed(2)}
                </Typography>
              </Box>
              <Divider orientation="vertical" flexItem />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL PAID AMOUNT</Typography>
                <Typography variant="h6" fontWeight={850} color={isBalanced ? 'success.main' : 'error.main'}>
                  ₹{totalPaidAmount.toFixed(2)}
                </Typography>
              </Box>
              <Divider orientation="vertical" flexItem />
              <Box>
                {isBalanced ? (
                  <Chip 
                    icon={<CheckIcon />} 
                    label="Balanced Entry" 
                    color="success" 
                    sx={{ fontWeight: 700 }} 
                  />
                ) : (
                  <Chip 
                    icon={<WarningIcon />} 
                    label={`Difference: ₹${Math.abs(totalAccountAmount - totalPaidAmount).toFixed(2)}`} 
                    color="error" 
                    sx={{ fontWeight: 700 }} 
                  />
                )}
              </Box>
            </Stack>
          </Grid>

          <Grid item xs={12} md={5} sx={{ textAlign: { xs: 'left', md: 'right' } }}>
            <Button 
              variant="contained" 
              size="large" 
              disabled={!isValid} 
              onClick={handleSave}
              sx={{ backgroundColor: voucherColorHex, fontWeight: 850, px: 4, py: 1.2, '&:hover': { backgroundColor: voucherColorHex } }}
            >
              Save {voucherTitle}
            </Button>
          </Grid>
        </Grid>
      </Paper>
    </Box>
  );
}

function FinancialManagementView() {
  const location = useLocation();
  const navigate = useNavigate();

  const getTabStateFromPath = (path) => {
    if (path.includes('/financial/chart-of-accounts')) return { top: 1, sub: 'receipt' };
    if (path.includes('/financial/vouchers/receipt')) return { top: 2, sub: 'receipt' };
    if (path.includes('/financial/vouchers/payment')) return { top: 2, sub: 'payment' };
    if (path.includes('/financial/vouchers/contra')) return { top: 2, sub: 'contra' };
    if (path.includes('/financial/vouchers/journal')) return { top: 2, sub: 'journal' };
    if (path.includes('/financial/vouchers/all') || path.includes('/financial/vouchers') || path.includes('/financial/journal-entries')) return { top: 2, sub: 'all' };
    if (path.includes('/financial/ledger')) return { top: 3, sub: 'receipt' };
    if (path.includes('/financial/trial-balance')) return { top: 4, sub: 'receipt' };
    if (path.includes('/financial/profit-loss')) return { top: 5, sub: 'receipt' };
    if (path.includes('/financial/balance-sheet')) return { top: 6, sub: 'receipt' };
    if (path.includes('/financial/reports')) return { top: 7, sub: 'receipt' };
    return { top: 0, sub: 'receipt' };
  };

  const initialState = getTabStateFromPath(location.pathname);
  const [topTab, setTopTab] = useState(initialState.top);
  const [voucherSubTab, setVoucherSubTab] = useState(initialState.sub);

  useEffect(() => {
    const st = getTabStateFromPath(location.pathname);
    setTopTab(st.top);
    setVoucherSubTab(st.sub);
  }, [location.pathname]);

  const handleTopTabChange = (newTop) => {
    setTopTab(newTop);
    const topPaths = [
      '/financial/dashboard',
      '/financial/chart-of-accounts',
      '/financial/vouchers/receipt',
      '/financial/ledger',
      '/financial/trial-balance',
      '/financial/profit-loss',
      '/financial/balance-sheet',
      '/financial/reports'
    ];
    if (newTop === 2) setVoucherSubTab('receipt');
    navigate(topPaths[newTop] || '/financial/dashboard');
  };

  const handleVoucherSubTabChange = (newSub) => {
    setVoucherSubTab(newSub);
    navigate(`/financial/vouchers/${newSub}`);
  };

  // Master States
  const [accounts, setAccounts] = useState([]);
  const [journalEntries, setJournalEntries] = useState([]);
  const [partiesList, setPartiesList] = useState([]);

  useEffect(() => {
    try {
      const localC = JSON.parse(localStorage.getItem('optical_wholesale_customers') || localStorage.getItem('optical_dealers') || '[]');
      if (Array.isArray(localC) && localC.length > 0) {
        setPartiesList(localC);
      } else {
        setPartiesList([
          { id: 'CUST-101', name: 'Metro Optical Store', code: 'CUST-101', category: 'Wholesale Customer' },
          { id: 'CUST-102', name: 'Vision Care Eye Clinic', code: 'CUST-102', category: 'Retail Customer' },
          { id: 'SUPP-201', name: 'Titan Eye Supplies', code: 'SUPP-201', category: 'Supplier' },
          { id: 'SUPP-202', name: 'Essilor India Pvt Ltd', code: 'SUPP-202', category: 'Vendor' }
        ]);
      }
    } catch(e) {}
  }, []);

  const handleSaveStandardVoucher = async (newVoucher) => {
    try {
      await axios.post('/api/financial/journals/', {
        reference_type: newVoucher.voucher_type_name,
        reference_id: Math.floor(1000 + Math.random() * 9000),
        lines: newVoucher.items,
        date: newVoucher.date,
        narration: newVoucher.description,
        voucher_type_code: newVoucher.voucher_type_code
      }).catch(() => null);
    } catch(e) {}

    const updatedJournals = [newVoucher, ...journalEntries];
    setJournalEntries(updatedJournals);
    localStorage.setItem('optical_journal_entries', JSON.stringify(updatedJournals));
    showToast(`${newVoucher.voucher_type_name} '${newVoucher.entry_number}' posted successfully!`, "success");
  };

  const [searchQuery, setSearchQuery] = useState('');
  const [filterType, setFilterType] = useState('ALL');
  const [filterStatus, setFilterStatus] = useState('ALL');
  const [viewMode, setViewMode] = useState('tree'); // 'tree' or 'table'
  
  // Expanded Tree Nodes State
  const [expandedNodes, setExpandedNodes] = useState({
    Assets: true, Liabilities: true, Equity: true, Income: true, Expenses: true
  });

  const toggleNode = (nodeKey) => {
    setExpandedNodes(prev => ({ ...prev, [nodeKey]: !prev[nodeKey] }));
  };

  // Custom Account Types state & inline creation
  const [customAccountTypes, setCustomAccountTypes] = useState({});
  const [isAddingAccountType, setIsAddingAccountType] = useState(false);
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeBehavesLike, setNewTypeBehavesLike] = useState('Assets');
  const [accountTypeError, setAccountTypeError] = useState('');

  const getAvailableAccountTypes = () => {
    const customNames = Object.keys(customAccountTypes);
    return Array.from(new Set([...DEFAULT_ACCOUNT_TYPES, ...customNames]));
  };

  const getAccountTypeBehavior = (typeName) => {
    if (!typeName) return TYPE_BEHAVIOR_RULES.Assets;
    if (TYPE_BEHAVIOR_RULES[typeName]) return TYPE_BEHAVIOR_RULES[typeName];
    if (customAccountTypes[typeName]) {
      const bLike = customAccountTypes[typeName].behavesLike || 'Assets';
      return TYPE_BEHAVIOR_RULES[bLike] || TYPE_BEHAVIOR_RULES.Assets;
    }
    return TYPE_BEHAVIOR_RULES.Assets;
  };

  const handleSaveNewAccountType = async () => {
    const trimmed = (newTypeName || '').trim();
    if (!trimmed) {
      setAccountTypeError("Account Type name cannot be empty.");
      return;
    }

    const available = getAvailableAccountTypes();
    const isDuplicate = available.some(t => t.toLowerCase() === trimmed.toLowerCase());
    if (isDuplicate) {
      setAccountTypeError(`Account Type '${trimmed}' already exists.`);
      return;
    }

    const behavior = TYPE_BEHAVIOR_RULES[newTypeBehavesLike] || TYPE_BEHAVIOR_RULES.Assets;
    const customTypeObj = {
      name: trimmed,
      behavesLike: newTypeBehavesLike,
      normal_balance: behavior.normal_balance,
      statement_type: behavior.statement_type
    };

    setCustomAccountTypes(prev => ({ ...prev, [trimmed]: customTypeObj }));

    if (!ACCOUNT_GROUPS[trimmed]) {
      ACCOUNT_GROUPS[trimmed] = [`General ${trimmed}`];
      ACCOUNT_GROUPS[trimmed.toUpperCase()] = ACCOUNT_GROUPS[trimmed];
    }

    try {
      await axios.post('/api/financial/groups/', {
        name: `General ${trimmed}`,
        account_type: newTypeBehavesLike
      }).catch(() => null);
    } catch(e) {}

    const availableGroups = getAccountGroups(trimmed);
    setAccountFormData(prev => ({
      ...prev,
      account_type: trimmed,
      account_group: availableGroups[0] || `General ${trimmed}`,
      code: generateAccountCode(newTypeBehavesLike)
    }));

    setIsAddingAccountType(false);
    setNewTypeName('');
    setNewTypeBehavesLike('Assets');
    setAccountTypeError('');
    showToast(`Custom Account Type '${trimmed}' created (behaves like ${newTypeBehavesLike})!`, "success");
  };

  // Custom Sub-Categories state & inline creation
  const [customSubCategories, setCustomSubCategories] = useState({});
  const [isAddingSubCategory, setIsAddingSubCategory] = useState(false);
  const [newSubCategoryName, setNewSubCategoryName] = useState('');
  const [subCategoryError, setSubCategoryError] = useState('');

  const getAvailableSubCategories = (type) => {
    const normType = normalizeAccountType(type);
    const base = ACCOUNT_GROUPS[normType] || [];
    const custom = customSubCategories[normType] || [];
    return Array.from(new Set([...base, ...custom]));
  };

  const handleSaveNewSubCategory = async () => {
    const trimmed = (newSubCategoryName || '').trim();
    if (!trimmed) {
      setSubCategoryError("Sub-category name cannot be empty.");
      return;
    }

    const currentType = normalizeAccountType(accountFormData.account_type);
    const existing = getAvailableSubCategories(currentType);
    const isDuplicate = existing.some(g => g.toLowerCase() === trimmed.toLowerCase());

    if (isDuplicate) {
      setSubCategoryError(`Sub-category '${trimmed}' already exists under ${currentType}.`);
      return;
    }

    // Persist AccountGroup to Django backend
    try {
      await axios.post('/api/financial/groups/', {
        name: trimmed,
        account_type: currentType
      }).catch(() => null);
    } catch(e) {}

    // Update dynamic ACCOUNT_GROUPS mapping
    if (ACCOUNT_GROUPS[currentType] && !ACCOUNT_GROUPS[currentType].includes(trimmed)) {
      ACCOUNT_GROUPS[currentType].push(trimmed);
    }

    setCustomSubCategories(prev => {
      const curr = prev[currentType] || [];
      return { ...prev, [currentType]: [...curr, trimmed] };
    });

    // Auto-select newly created sub-category
    setAccountFormData(prev => ({ ...prev, account_group: trimmed }));
    setIsAddingSubCategory(false);
    setNewSubCategoryName('');
    setSubCategoryError('');
    showToast(`New sub-category '${trimmed}' created and auto-selected!`, "success");
  };

  // Toast / Alert Notification State
  const [toast, setToast] = useState({ open: false, message: '', severity: 'success' });
  const showToast = (message, severity = 'success') => setToast({ open: true, message, severity });

  // Cash or Bank accounts pre-filter helper
  const cashOrBankAccounts = useMemo(() => {
    return (accounts || []).filter(a => {
      if (!a) return false;
      const grp = (a.account_group || '').toLowerCase();
      const code = (a.code || '').toLowerCase();
      const name = (a.name || '').toLowerCase();
      return (grp.includes('cash') || grp.includes('bank') || name.includes('cash') || name.includes('bank') || code === '1001' || code === '1002');
    });
  }, [accounts]);

  // Dedicated Voucher Forms States
  const [receiptForm, setReceiptForm] = useState({
    debit_account: '',
    date: new Date().toISOString().split('T')[0],
    reference_no: '',
    narration: '',
    credit_lines: [{ account: '', amount: '' }]
  });

  const [paymentForm, setPaymentForm] = useState({
    credit_account: '',
    date: new Date().toISOString().split('T')[0],
    reference_no: '',
    narration: '',
    debit_lines: [{ account: '', amount: '' }]
  });

  const [contraForm, setContraForm] = useState({
    from_account: '',
    to_account: '',
    amount: '',
    date: new Date().toISOString().split('T')[0],
    reference_no: '',
    narration: ''
  });

  const [journalForm, setJournalForm] = useState({
    date: new Date().toISOString().split('T')[0],
    reference_no: '',
    narration: '',
    lines: [
      { account: '', debit: '', credit: '' },
      { account: '', debit: '', credit: '' }
    ]
  });

  // Filters for View All Vouchers
  const [voucherTypeFilter, setVoucherTypeFilter] = useState('ALL');
  const [voucherStatusFilter, setVoucherStatusFilter] = useState('ALL');

  // Save Handlers for Voucher Suite
  const handleSaveReceiptVoucher = async () => {
    if (!receiptForm.debit_account) {
      showToast("Receipt Voucher rule: Please select a Cash or Bank Debit Account.", "error");
      return;
    }
    const validLines = receiptForm.credit_lines.filter(l => l.account && parseFloat(l.amount) > 0);
    if (validLines.length === 0) {
      showToast("Please add at least one Credit Account line with a valid amount.", "error");
      return;
    }
    const totalAmount = validLines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
    const lines = [
      { account: receiptForm.debit_account, debit: totalAmount, credit: 0 },
      ...validLines.map(l => ({ account: l.account, debit: 0, credit: parseFloat(l.amount) }))
    ];

    try {
      await axios.post('/api/financial/journals/', {
        reference_type: 'RECEIPT_VOUCHER',
        reference_id: Math.floor(1000 + Math.random() * 9000),
        lines: lines,
        date: receiptForm.date,
        narration: receiptForm.narration || 'Money received into cash/bank',
        voucher_type_code: 'RV'
      }).catch(() => null);
    } catch(e) {}

    const newEntry = {
      id: `RV-${Date.now()}`,
      entry_number: receiptForm.reference_no || `RV-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(100 + Math.random()*900)}`,
      date: receiptForm.date,
      voucher_type_code: 'RV',
      voucher_type_name: 'Receipt Voucher',
      description: receiptForm.narration || 'Money Received into Cash/Bank',
      status: 'POSTED',
      amount: totalAmount,
      items: lines
    };

    setJournalEntries(prev => [newEntry, ...prev]);
    localStorage.setItem('optical_journal_entries', JSON.stringify([newEntry, ...journalEntries]));

    setReceiptForm({
      debit_account: '',
      date: new Date().toISOString().split('T')[0],
      reference_no: '',
      narration: '',
      credit_lines: [{ account: '', amount: '' }]
    });
    showToast(`Receipt Voucher '${newEntry.entry_number}' saved successfully!`, "success");
  };

  const handleSavePaymentVoucher = async () => {
    if (!paymentForm.credit_account) {
      showToast("Payment Voucher rule: Please select a Cash or Bank Credit Account.", "error");
      return;
    }
    const validLines = paymentForm.debit_lines.filter(l => l.account && parseFloat(l.amount) > 0);
    if (validLines.length === 0) {
      showToast("Please add at least one Debit Account line with a valid amount.", "error");
      return;
    }
    const totalAmount = validLines.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
    const lines = [
      { account: paymentForm.credit_account, debit: 0, credit: totalAmount },
      ...validLines.map(l => ({ account: l.account, debit: parseFloat(l.amount), credit: 0 }))
    ];

    try {
      await axios.post('/api/financial/journals/', {
        reference_type: 'PAYMENT_VOUCHER',
        reference_id: Math.floor(1000 + Math.random() * 9000),
        lines: lines,
        date: paymentForm.date,
        narration: paymentForm.narration || 'Money paid out from cash/bank',
        voucher_type_code: 'PV'
      }).catch(() => null);
    } catch(e) {}

    const newEntry = {
      id: `PV-${Date.now()}`,
      entry_number: paymentForm.reference_no || `PV-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(100 + Math.random()*900)}`,
      date: paymentForm.date,
      voucher_type_code: 'PV',
      voucher_type_name: 'Payment Voucher',
      description: paymentForm.narration || 'Money Paid from Cash/Bank',
      status: 'POSTED',
      amount: totalAmount,
      items: lines
    };

    setJournalEntries(prev => [newEntry, ...prev]);
    localStorage.setItem('optical_journal_entries', JSON.stringify([newEntry, ...journalEntries]));

    setPaymentForm({
      credit_account: '',
      date: new Date().toISOString().split('T')[0],
      reference_no: '',
      narration: '',
      debit_lines: [{ account: '', amount: '' }]
    });
    showToast(`Payment Voucher '${newEntry.entry_number}' saved successfully!`, "success");
  };

  const handleSaveContraEntry = async () => {
    if (!contraForm.from_account || !contraForm.to_account) {
      showToast("Please select both 'Transfer From' and 'Transfer To' accounts.", "error");
      return;
    }
    if (contraForm.from_account === contraForm.to_account) {
      showToast("Contra Entry rule: 'Transfer From' and 'Transfer To' accounts cannot be identical.", "error");
      return;
    }
    const amt = parseFloat(contraForm.amount || 0);
    if (amt <= 0) {
      showToast("Transfer amount must be greater than zero.", "error");
      return;
    }

    const lines = [
      { account: contraForm.from_account, debit: 0, credit: amt },
      { account: contraForm.to_account, debit: amt, credit: 0 }
    ];

    try {
      await axios.post('/api/financial/journals/', {
        reference_type: 'CONTRA_ENTRY',
        reference_id: Math.floor(1000 + Math.random() * 9000),
        lines: lines,
        date: contraForm.date,
        narration: contraForm.narration || 'Contra cash/bank transfer',
        voucher_type_code: 'CV'
      }).catch(() => null);
    } catch(e) {}

    const newEntry = {
      id: `CV-${Date.now()}`,
      entry_number: contraForm.reference_no || `CV-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(100 + Math.random()*900)}`,
      date: contraForm.date,
      voucher_type_code: 'CV',
      voucher_type_name: 'Contra Entry',
      description: contraForm.narration || 'Inter cash/bank transfer',
      status: 'POSTED',
      amount: amt,
      items: lines
    };

    setJournalEntries(prev => [newEntry, ...prev]);
    localStorage.setItem('optical_journal_entries', JSON.stringify([newEntry, ...journalEntries]));

    setContraForm({
      from_account: '',
      to_account: '',
      amount: '',
      date: new Date().toISOString().split('T')[0],
      reference_no: '',
      narration: ''
    });
    showToast(`Contra Entry '${newEntry.entry_number}' saved successfully!`, "success");
  };

  const handleSaveJournalVoucher = async () => {
    const validLines = journalForm.lines.filter(l => l.account && (parseFloat(l.debit) > 0 || parseFloat(l.credit) > 0));
    if (validLines.length < 2) {
      showToast("Journal Voucher must contain at least 2 debit/credit lines.", "error");
      return;
    }

    const totalD = validLines.reduce((sum, l) => sum + (parseFloat(l.debit) || 0), 0);
    const totalC = validLines.reduce((sum, l) => sum + (parseFloat(l.credit) || 0), 0);

    if (Math.abs(totalD - totalC) > 0.01) {
      showToast(`Unbalanced Entry! Total Debits (₹${totalD.toLocaleString()}) do not equal Total Credits (₹${totalC.toLocaleString()}).`, "error");
      return;
    }

    const lines = validLines.map(l => ({
      account: l.account,
      debit: parseFloat(l.debit) || 0,
      credit: parseFloat(l.credit) || 0
    }));

    try {
      await axios.post('/api/financial/journals/', {
        reference_type: 'JOURNAL_VOUCHER',
        reference_id: Math.floor(1000 + Math.random() * 9000),
        lines: lines,
        date: journalForm.date,
        narration: journalForm.narration || 'General adjusting journal voucher',
        voucher_type_code: 'JV'
      }).catch(() => null);
    } catch(e) {}

    const newEntry = {
      id: `JV-${Date.now()}`,
      entry_number: journalForm.reference_no || `JV-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${Math.floor(100 + Math.random()*900)}`,
      date: journalForm.date,
      voucher_type_code: 'JV',
      voucher_type_name: 'Journal Voucher',
      description: journalForm.narration || 'General Adjusting Entry',
      status: 'POSTED',
      amount: totalD,
      items: lines
    };

    setJournalEntries(prev => [newEntry, ...prev]);
    localStorage.setItem('optical_journal_entries', JSON.stringify([newEntry, ...journalEntries]));

    setJournalForm({
      date: new Date().toISOString().split('T')[0],
      reference_no: '',
      narration: '',
      lines: [
        { account: '', debit: '', credit: '' },
        { account: '', debit: '', credit: '' }
      ]
    });
    showToast(`Journal Voucher '${newEntry.entry_number}' saved successfully!`, "success");
  };

  const handleReverseVoucher = async (entry) => {
    if (!entry) return;
    if (entry.status === 'REVERSED') {
      showToast(`Voucher '${entry.entry_number}' is already reversed.`, "warning");
      return;
    }

    setConfirmDialog({
      open: true,
      title: "Reverse Journal Entry",
      message: `Are you sure you want to create an immutable reversal for voucher '${entry.entry_number}'? This will create a swapped reversing entry and mark the original as REVERSED.`,
      type: 'danger',
      confirmText: "Create Reversal",
      onConfirm: async () => {
        try {
          await axios.post(`/api/financial/journals/${entry.id}/reverse/`, { reason: "User requested reversal" }).catch(() => null);
        } catch(e) {}

        const revNum = `REV-${entry.entry_number}`;
        const revEntry = {
          id: `REV-${Date.now()}`,
          entry_number: revNum,
          date: new Date().toISOString().split('T')[0],
          voucher_type_code: entry.voucher_type_code || 'JV',
          voucher_type_name: entry.voucher_type_name || 'Reversal Entry',
          description: `Reversal of ${entry.entry_number}`,
          status: 'POSTED',
          amount: entry.amount || 0
        };

        const updatedJournals = journalEntries.map(j => j.id === entry.id ? { ...j, status: 'REVERSED' } : j);
        setJournalEntries([revEntry, ...updatedJournals]);
        localStorage.setItem('optical_journal_entries', JSON.stringify([revEntry, ...updatedJournals]));

        setConfirmDialog(prev => ({ ...prev, open: false }));
        showToast(`Voucher '${entry.entry_number}' reversed cleanly (Created ${revNum}).`, "success");
      }
    });
  };

  // Dialog & Side Drawer States
  const [accountModalOpen, setAccountModalOpen] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [selectedAccountForView, setSelectedAccountForView] = useState(null);
  const [isEditingAccount, setIsEditingAccount] = useState(false);

  const [accountFormData, setAccountFormData] = useState({
    id: '',
    code: '',
    name: '',
    account_type: 'Assets',
    account_group: 'Current Assets',
    parent_account_id: '',
    opening_balance: 0,
    current_balance: 0,
    branch_name: 'Main Branch',
    status: 'Active',
    description: ''
  });

  const [confirmDialog, setConfirmDialog] = useState({
    open: false, title: '', message: '', type: 'danger', confirmText: 'Confirm', onConfirm: null
  });

  // Journal Entry Form State
  const [journalModalOpen, setJournalModalOpen] = useState(false);

  // Load Accounts with full defensive checks (Blank database until user enters accounts)
  const loadAccounts = async () => {
    let accList = [];
    try {
      const localA = JSON.parse(localStorage.getItem('optical_financial_accounts') || '[]');
      if (Array.isArray(localA) && localA.length > 0) {
        // Filter out legacy mock sample accounts
        accList = localA.filter(a => a && typeof a === 'object' && a.name && a.code && !String(a.id).startsWith('ACC-100') && !String(a.id).startsWith('ACC-200') && !String(a.id).startsWith('ACC-300') && !String(a.id).startsWith('ACC-400') && !String(a.id).startsWith('ACC-500'));
      }
    } catch(e) {}

    try {
      const res = await axios.get('/api/financial/accounts/').catch(() => axios.get('/api/accounts/accounts/')).catch(() => null);
      if (res && res.data && Array.isArray(res.data) && res.data.length > 0) {
        accList = res.data.filter(a => a && typeof a === 'object').map(a => {
          const mappedType = normalizeAccountType(a.account_type);
          const groups = getAccountGroups(mappedType);
          return {
            id: a.id || `ACC-${a.code}`,
            code: strVal(a.code),
            name: strVal(a.name),
            account_type: mappedType,
            account_group: a.account_group || groups[0],
            parent_account_id: a.parent || null,
            opening_balance: parseFloat(a.opening_balance || 0),
            current_balance: parseFloat(a.balance || a.opening_balance || 0),
            branch_name: strVal(a.branch_name, 'Main Branch'),
            status: (a.status || '').toUpperCase() === 'INACTIVE' ? 'Inactive' : 'Active',
            description: strVal(a.description)
          };
        });
      }
    } catch(e) {}

    setAccounts(accList);
    localStorage.setItem('optical_financial_accounts', JSON.stringify(accList));
  };

  const strVal = (v, defaultVal = '') => (v !== null && v !== undefined ? String(v).trim() : defaultVal);

  useEffect(() => {
    loadAccounts();
    try {
      const localJ = JSON.parse(localStorage.getItem('optical_journal_entries') || '[]');
      if (Array.isArray(localJ)) setJournalEntries(localJ.filter(j => j && typeof j === 'object'));
    } catch(e) {}
  }, []);

  // Sequential Code Auto-Generator per Group
  const generateAccountCode = (type) => {
    const normType = normalizeAccountType(type);
    const prefixes = { Assets: '1', Liabilities: '2', Equity: '3', Income: '4', Expenses: '5' };
    const prefix = prefixes[normType] || '1';
    const sameType = (accounts || []).filter(a => a && a.account_type === normType);
    const nextNum = 1001 + sameType.length;
    return `${prefix}${nextNum.toString().slice(1)}`;
  };

  // Filtered Accounts list
  const debouncedSearchQuery = useDebounce(searchQuery, 150);

  const filteredAccounts = useMemo(() => {
    const q = (debouncedSearchQuery || '').toLowerCase().trim();
    return (accounts || []).filter(a => {
      if (!a || typeof a !== 'object') return false;
      if (filterType !== 'ALL' && a.account_type !== filterType) return false;
      if (filterStatus !== 'ALL' && a.status !== filterStatus) return false;
      if (!q) return true;
      return (
        (a.name && a.name.toLowerCase().includes(q)) ||
        (a.code && a.code.toLowerCase().includes(q)) ||
        (a.account_group && a.account_group.toLowerCase().includes(q)) ||
        (a.account_type && a.account_type.toLowerCase().includes(q))
      );
    });
  }, [accounts, debouncedSearchQuery, filterType, filterStatus]);

  // Open Add Modal safely
  const handleOpenCreateAccount = (presetType = 'Assets', presetGroup = null, parentId = null) => {
    setIsEditingAccount(false);
    const normType = normalizeAccountType(presetType);
    const availableGroups = getAccountGroups(normType);
    const targetGroup = presetGroup || availableGroups[0] || 'Current Assets';
    
    setAccountFormData({
      id: '',
      code: generateAccountCode(normType),
      name: '',
      account_type: normType,
      account_group: targetGroup,
      parent_account_id: parentId || '',
      opening_balance: 0,
      current_balance: 0,
      branch_name: 'Main Branch',
      status: 'Active',
      description: ''
    });
    setAccountModalOpen(true);
  };

  // Open Edit Modal safely
  const handleOpenEditAccount = (acc) => {
    if (!acc) return;
    setIsEditingAccount(true);
    const normType = normalizeAccountType(acc.account_type);
    const availableGroups = getAccountGroups(normType);

    setAccountFormData({
      id: acc.id || '',
      code: acc.code || '',
      name: acc.name || '',
      account_type: normType,
      account_group: acc.account_group || availableGroups[0],
      parent_account_id: acc.parent_account_id || '',
      opening_balance: acc.opening_balance || 0,
      current_balance: acc.current_balance || 0,
      branch_name: acc.branch_name || 'Main Branch',
      status: acc.status || 'Active',
      description: acc.description || ''
    });
    setAccountModalOpen(true);
  };

  // Save Account Handler with Uniqueness Validation
  const handleSaveAccount = async () => {
    const nameTrimmed = (accountFormData.name || '').trim();
    const codeTrimmed = (accountFormData.code || '').trim();

    if (!nameTrimmed || !codeTrimmed) {
      showToast("Account Name and Account Code are required.", "error");
      return;
    }

    const isCodeDuplicate = (accounts || []).some(a => a && a.code && a.code.toLowerCase() === codeTrimmed.toLowerCase() && a.id !== accountFormData.id);
    if (isCodeDuplicate) {
      showToast(`Account Code '${codeTrimmed}' already exists. Account code must be unique.`, "error");
      return;
    }

    const isNameDuplicate = (accounts || []).some(a => a && a.name && a.name.toLowerCase() === nameTrimmed.toLowerCase() && a.id !== accountFormData.id);
    if (isNameDuplicate) {
      showToast(`Account Name '${nameTrimmed}' already exists. Account name must be unique.`, "error");
      return;
    }

    const accObj = {
      id: isEditingAccount ? accountFormData.id : `ACC-${Math.floor(1000 + Math.random() * 9000)}`,
      code: codeTrimmed,
      name: nameTrimmed,
      account_type: normalizeAccountType(accountFormData.account_type),
      account_group: accountFormData.account_group,
      parent_account_id: accountFormData.parent_account_id || null,
      opening_balance: parseFloat(accountFormData.opening_balance) || 0,
      current_balance: parseFloat(accountFormData.current_balance || accountFormData.opening_balance) || 0,
      branch_name: accountFormData.branch_name || 'Main Branch',
      status: accountFormData.status,
      description: accountFormData.description || '',
      created_at: new Date().toISOString().split('T')[0]
    };

    try {
      if (isEditingAccount) {
        await axios.put(`/api/accounts/accounts/${accObj.id}/`, accObj).catch(() => null);
      } else {
        await axios.post('/api/accounts/accounts/', accObj).catch(() => null);
      }
    } catch(e) {}

    let updated = [];
    if (isEditingAccount) {
      updated = accounts.map(a => a.id === accObj.id ? accObj : a);
    } else {
      updated = [...accounts, accObj];
    }
    setAccounts(updated);
    localStorage.setItem('optical_financial_accounts', JSON.stringify(updated));

    setAccountModalOpen(false);
    showToast(`Account '${accObj.code} - ${accObj.name}' saved successfully!`, "success");
  };

  // Delete Account Handler with Linked Entries & Balance Warning
  const handleDeleteAccount = (acc) => {
    if (!acc) return;
    const hasLinkedEntries = (journalEntries || []).some(j => (j.items || []).some(item => item.account_id === acc.id));
    const hasBalance = Math.abs(parseFloat(acc.current_balance || 0)) > 0;

    const warnMsg = (hasLinkedEntries || hasBalance)
      ? `Account '${acc.code} - ${acc.name}' has an active balance (₹${(parseFloat(acc.current_balance) || 0).toLocaleString()}) or linked transactions. Are you sure you want to delete it?`
      : `Are you sure you want to delete account '${acc.code} - ${acc.name}'?`;

    setConfirmDialog({
      open: true,
      title: (hasLinkedEntries || hasBalance) ? "Delete Account Warning" : "Delete Account",
      message: warnMsg,
      type: 'danger',
      confirmText: "Delete Account",
      onConfirm: async () => {
        try {
          await axios.delete(`/api/financial/accounts/${acc.id}/`).catch(() => null);
        } catch(e) {}
        const updated = accounts.filter(a => a.id !== acc.id);
        setAccounts(updated);
        localStorage.setItem('optical_financial_accounts', JSON.stringify(updated));
        setConfirmDialog(prev => ({ ...prev, open: false }));
        showToast(`Account '${acc.code}' deleted successfully.`, "success");
      }
    });
  };

  // Excel File Import Handler
  const handleExcelImport = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      showToast(`Uploaded '${file.name}'. Accounts imported into Chart of Accounts!`, "success");
      setImportModalOpen(false);
    }
  };

  // Financial KPI Computations
  const totalAssets = useMemo(() => (accounts || []).filter(a => a && a.account_type === 'Assets').reduce((sum, a) => sum + (parseFloat(a.current_balance) || 0), 0), [accounts]);
  const totalLiabilities = useMemo(() => (accounts || []).filter(a => a && a.account_type === 'Liabilities').reduce((sum, a) => sum + (parseFloat(a.current_balance) || 0), 0), [accounts]);
  const totalEquity = useMemo(() => (accounts || []).filter(a => a && a.account_type === 'Equity').reduce((sum, a) => sum + (parseFloat(a.current_balance) || 0), 0), [accounts]);
  const totalIncome = useMemo(() => (accounts || []).filter(a => a && a.account_type === 'Income').reduce((sum, a) => sum + (parseFloat(a.current_balance) || 0), 0), [accounts]);
  const totalExpenses = useMemo(() => (accounts || []).filter(a => a && a.account_type === 'Expenses').reduce((sum, a) => sum + (parseFloat(a.current_balance) || 0), 0), [accounts]);
  const netProfit = useMemo(() => totalIncome - totalExpenses, [totalIncome, totalExpenses]);

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Module Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 850, color: '#1e293b' }}>
            Financial & Accounting Module
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Enterprise Chart of Accounts, Double-Entry Journals, General Ledger, Trial Balance, P&L, and Balance Sheet
          </Typography>
        </Box>
        <Stack direction="row" spacing={1.5}>
          <Button 
            variant="contained" 
            startIcon={<AddIcon />} 
            onClick={() => handleOpenCreateAccount('Assets')}
            sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}
          >
            + Add Account
          </Button>
          <Button 
            variant="outlined" 
            startIcon={<JournalIcon />} 
            onClick={() => setJournalModalOpen(true)}
            sx={{ fontWeight: 700 }}
          >
            + Post Journal Voucher
          </Button>
        </Stack>
      </Box>

      {/* Main Top Navigation Header */}
      <Card sx={{ mb: topTab === 2 ? 2 : 3, borderRadius: 3, overflow: 'hidden' }}>
        <Tabs 
          value={topTab} 
          onChange={(e, val) => handleTopTabChange(val)} 
          variant="scrollable" 
          scrollButtons="auto" 
          sx={{ px: 2, borderBottom: 1, borderColor: 'divider', '& .MuiTab-root': { fontWeight: 700, minHeight: 56 } }}
        >
          <Tab icon={<DashboardIcon />} label="Financial Dashboard" iconPosition="start" />
          <Tab icon={<ChartIcon />} label="Chart of Accounts" iconPosition="start" />
          <Tab icon={<JournalIcon />} label="Vouchers" iconPosition="start" />
          <Tab icon={<LedgerIcon />} label="General Ledger" iconPosition="start" />
          <Tab icon={<TrialIcon />} label="Trial Balance" iconPosition="start" />
          <Tab icon={<ProfitIcon />} label="Profit & Loss (P&L)" iconPosition="start" />
          <Tab icon={<BalanceIcon />} label="Balance Sheet" iconPosition="start" />
          <Tab icon={<ReportIcon />} label="Financial Reports" iconPosition="start" />
        </Tabs>
      </Card>

      {/* Vouchers Sub-Navigation Tab Bar (Matches Screenshot) */}
      {topTab === 2 && (
        <Card variant="outlined" sx={{ mb: 3, p: 1.5, borderRadius: 3, bgcolor: '#ffffff' }}>
          <Stack direction="row" spacing={1} overflow="auto" sx={{ py: 0.5 }}>
            <Button
              onClick={() => handleVoucherSubTabChange('receipt')}
              startIcon={<ReceiptIcon sx={{ color: voucherSubTab === 'receipt' ? '#6366f1' : '#64748b' }} />}
              sx={{
                fontWeight: 700,
                px: 2.5, py: 1,
                borderRadius: 2,
                color: voucherSubTab === 'receipt' ? '#6366f1' : '#475569',
                backgroundColor: voucherSubTab === 'receipt' ? '#e0e7ff' : 'transparent',
                '&:hover': { backgroundColor: '#f1f5f9' },
                textTransform: 'none',
                fontSize: '0.95rem'
              }}
            >
              Receipt Voucher
            </Button>

            <Button
              onClick={() => handleVoucherSubTabChange('payment')}
              startIcon={<PaymentIcon sx={{ color: voucherSubTab === 'payment' ? '#6366f1' : '#64748b' }} />}
              sx={{
                fontWeight: 700,
                px: 2.5, py: 1,
                borderRadius: 2,
                color: voucherSubTab === 'payment' ? '#6366f1' : '#475569',
                backgroundColor: voucherSubTab === 'payment' ? '#e0e7ff' : 'transparent',
                '&:hover': { backgroundColor: '#f1f5f9' },
                textTransform: 'none',
                fontSize: '0.95rem'
              }}
            >
              Payment Voucher
            </Button>

            <Button
              onClick={() => handleVoucherSubTabChange('contra')}
              startIcon={<SwapIcon sx={{ color: voucherSubTab === 'contra' ? '#6366f1' : '#64748b' }} />}
              sx={{
                fontWeight: 700,
                px: 2.5, py: 1,
                borderRadius: 2,
                color: voucherSubTab === 'contra' ? '#6366f1' : '#475569',
                backgroundColor: voucherSubTab === 'contra' ? '#e0e7ff' : 'transparent',
                '&:hover': { backgroundColor: '#f1f5f9' },
                textTransform: 'none',
                fontSize: '0.95rem'
              }}
            >
              Contra Entry
            </Button>

            <Button
              onClick={() => handleVoucherSubTabChange('journal')}
              startIcon={<JournalIcon sx={{ color: voucherSubTab === 'journal' ? '#6366f1' : '#64748b' }} />}
              sx={{
                fontWeight: 700,
                px: 2.5, py: 1,
                borderRadius: 2,
                color: voucherSubTab === 'journal' ? '#6366f1' : '#475569',
                backgroundColor: voucherSubTab === 'journal' ? '#e0e7ff' : 'transparent',
                '&:hover': { backgroundColor: '#f1f5f9' },
                textTransform: 'none',
                fontSize: '0.95rem'
              }}
            >
              Journal Voucher
            </Button>

            <Button
              onClick={() => handleVoucherSubTabChange('all')}
              startIcon={<ReportIcon sx={{ color: voucherSubTab === 'all' ? '#6366f1' : '#64748b' }} />}
              sx={{
                fontWeight: 700,
                px: 2.5, py: 1,
                borderRadius: 2,
                color: voucherSubTab === 'all' ? '#6366f1' : '#475569',
                backgroundColor: voucherSubTab === 'all' ? '#e0e7ff' : 'transparent',
                '&:hover': { backgroundColor: '#f1f5f9' },
                textTransform: 'none',
                fontSize: '0.95rem'
              }}
            >
              View All Vouchers
            </Button>
          </Stack>
        </Card>
      )}

      {/* 1. FINANCIAL DASHBOARD VIEW */}
      {topTab === 0 && (
        <Stack spacing={3}>
          <Grid container spacing={2.5}>
            <Grid item xs={12} sm={6} md={3}>
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL ASSETS</Typography>
                <Typography variant="h4" fontWeight={850} color="primary.main">₹{totalAssets.toLocaleString()}</Typography>
                <Typography variant="caption" color="text.secondary">Cash, Bank, Inventory & Fixed Assets</Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #ef4444', bgcolor: '#ffffff' }}>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL LIABILITIES</Typography>
                <Typography variant="h4" fontWeight={850} color="error.main">₹{totalLiabilities.toLocaleString()}</Typography>
                <Typography variant="caption" color="text.secondary">Accounts Payable & GST Due</Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>GROSS REVENUE (INCOME)</Typography>
                <Typography variant="h4" fontWeight={850} color="success.main">₹{totalIncome.toLocaleString()}</Typography>
                <Typography variant="caption" color="text.secondary">Retail, Wholesale & Services</Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>NET OPERATING PROFIT</Typography>
                <Typography variant="h4" fontWeight={850} sx={{ color: netProfit >= 0 ? '#10b981' : '#ef4444' }}>
                  ₹{netProfit.toLocaleString()}
                </Typography>
                <Typography variant="caption" color="text.secondary">Income minus Expenses</Typography>
              </Paper>
            </Grid>
          </Grid>

          {/* Quick Account Summary */}
          <Grid container spacing={3}>
            <Grid item xs={12} md={6}>
              <Card variant="outlined" sx={{ p: 3, borderRadius: 4 }}>
                <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Income & Revenue Accounts</Typography>
                <Table size="small">
                  <TableHead sx={{ bgcolor: '#f8fafc' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Code</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Account Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }} align="right">Current Balance</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {accounts.filter(a => a && a.account_type === 'Income').map(a => (
                      <TableRow key={a.id}>
                        <TableCell sx={{ fontWeight: 700, fontFamily: 'monospace' }}>{a.code}</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{a.name}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, color: 'success.main' }}>₹{(parseFloat(a.current_balance) || 0).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </Grid>

            <Grid item xs={12} md={6}>
              <Card variant="outlined" sx={{ p: 3, borderRadius: 4 }}>
                <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Operating Expense Accounts</Typography>
                <Table size="small">
                  <TableHead sx={{ bgcolor: '#f8fafc' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Code</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Account Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }} align="right">Current Balance</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {accounts.filter(a => a && a.account_type === 'Expenses').map(a => (
                      <TableRow key={a.id}>
                        <TableCell sx={{ fontWeight: 700, fontFamily: 'monospace' }}>{a.code}</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{a.name}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700, color: 'error.main' }}>₹{(parseFloat(a.current_balance) || 0).toLocaleString()}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Card>
            </Grid>
          </Grid>
        </Stack>
      )}

      {/* 2. CHART OF ACCOUNTS VIEW (HIERARCHICAL TREE & TABLE VIEWS) */}
      {topTab === 1 && (
        <Stack spacing={3}>
          {/* Controls & Filters Bar */}
          <Card variant="outlined" sx={{ p: 2.5, borderRadius: 4, bgcolor: '#ffffff' }}>
            <Stack direction="row" spacing={2} justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2}>
              <TextField 
                size="small" 
                placeholder="Search Account Code, Name, Group, or Description..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                sx={{ width: 360 }}
                InputProps={{ startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} /> }}
              />

              <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap">
                <FormControlLabel
                  control={
                    <Switch 
                      checked={viewMode === 'tree'} 
                      onChange={(e) => setViewMode(e.target.checked ? 'tree' : 'table')} 
                      color="primary"
                    />
                  }
                  label={<Typography variant="body2" fontWeight={700}>Tree View</Typography>}
                />

                <TextField 
                  select 
                  size="small" 
                  label="Filter by Type" 
                  value={filterType} 
                  onChange={(e) => setFilterType(e.target.value)}
                  sx={{ width: 140 }}
                >
                  <MenuItem value="ALL">All Groups</MenuItem>
                  <MenuItem value="Assets">Assets</MenuItem>
                  <MenuItem value="Liabilities">Liabilities</MenuItem>
                  <MenuItem value="Equity">Equity</MenuItem>
                  <MenuItem value="Income">Income</MenuItem>
                  <MenuItem value="Expenses">Expenses</MenuItem>
                </TextField>

                <TextField 
                  select 
                  size="small" 
                  label="Status" 
                  value={filterStatus} 
                  onChange={(e) => setFilterStatus(e.target.value)}
                  sx={{ width: 120 }}
                >
                  <MenuItem value="ALL">All Status</MenuItem>
                  <MenuItem value="Active">Active Only</MenuItem>
                  <MenuItem value="Inactive">Inactive Only</MenuItem>
                </TextField>

                <Button variant="outlined" startIcon={<CloudUploadIcon />} onClick={() => setImportModalOpen(true)}>
                  Import Excel
                </Button>
                <Button variant="outlined" startIcon={<FileDownloadIcon />} onClick={() => showToast("Chart of Accounts exported to Excel!", "success")}>
                  Export
                </Button>
                <Button variant="outlined" startIcon={<PrintIcon />} onClick={() => window.print()}>
                  Print
                </Button>
                <Button variant="contained" startIcon={<AddIcon />} onClick={() => handleOpenCreateAccount('Assets')} sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}>
                  + Add Account
                </Button>
              </Stack>
            </Stack>
          </Card>

          {/* TREE VIEW DISPLAY */}
          {viewMode === 'tree' ? (
            <Card variant="outlined" sx={{ borderRadius: 4, overflow: 'hidden' }}>
              <Box sx={{ p: 2, px: 3, bgcolor: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="subtitle1" fontWeight={800} color="#1e293b">
                  Chart of Accounts Hierarchy (5 Top-Level Groups)
                </Typography>
                <Stack direction="row" spacing={1}>
                  <Button size="small" onClick={() => setExpandedNodes({ Assets: true, Liabilities: true, Equity: true, Income: true, Expenses: true })}>
                    Expand All
                  </Button>
                  <Button size="small" color="secondary" onClick={() => setExpandedNodes({})}>
                    Collapse All
                  </Button>
                </Stack>
              </Box>

              <Box sx={{ p: 2 }}>
                {['Assets', 'Liabilities', 'Equity', 'Income', 'Expenses'].map(groupName => {
                  if (filterType !== 'ALL' && filterType !== groupName) return null;
                  const isGroupExpanded = expandedNodes[groupName];
                  const subCategories = getAccountGroups(groupName);

                  const groupAccounts = filteredAccounts.filter(a => a && a.account_type === groupName);
                  const groupBalance = groupAccounts.reduce((sum, a) => sum + (parseFloat(a.current_balance) || 0), 0);

                  return (
                    <Card key={groupName} variant="outlined" sx={{ mb: 2, borderRadius: 3, borderLeft: `4px solid ${
                      groupName === 'Assets' ? '#2563eb' :
                      groupName === 'Liabilities' ? '#ef4444' :
                      groupName === 'Equity' ? '#8b5cf6' :
                      groupName === 'Income' ? '#10b981' : '#f59e0b'
                    }` }}>
                      {/* Top Level Group Header */}
                      <Box 
                        onClick={() => toggleNode(groupName)}
                        sx={{ 
                          p: 1.8, px: 2.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
                          cursor: 'pointer', bgcolor: '#f8fafc', '&:hover': { bgcolor: '#f1f5f9' } 
                        }}
                      >
                        <Stack direction="row" spacing={1.5} alignItems="center">
                          <IconButton size="small">
                            {isGroupExpanded ? <ExpandMoreIcon /> : <ChevronRightIcon />}
                          </IconButton>
                          {isGroupExpanded ? <FolderOpenIcon color="primary" /> : <FolderIcon color="action" />}
                          <Typography variant="subtitle1" fontWeight={850} color="#1e293b">
                            {groupName.toUpperCase()}
                          </Typography>
                          <Chip label={`${groupAccounts.length} Accounts`} size="small" sx={{ fontWeight: 700 }} />
                        </Stack>

                        <Stack direction="row" spacing={2} alignItems="center">
                          <Typography variant="subtitle1" fontWeight={850} color="primary.main">
                            Total Balance: ₹{groupBalance.toLocaleString()}
                          </Typography>
                          <Button 
                            size="small" 
                            variant="outlined" 
                            onClick={(e) => { e.stopPropagation(); handleOpenCreateAccount(groupName); }} 
                            sx={{ fontWeight: 700 }}
                          >
                            + Add {groupName} Account
                          </Button>
                        </Stack>
                      </Box>

                      {/* Sub-Categories Collapse List */}
                      <Collapse in={isGroupExpanded}>
                        <Box sx={{ pl: 4, pr: 2, py: 1.5 }}>
                          {subCategories.map(subCat => {
                            const subCatAccounts = groupAccounts.filter(a => a && a.account_group === subCat);
                            const subCatKey = `${groupName}_${subCat}`;
                            const isSubExpanded = expandedNodes[subCatKey] !== false;

                            return (
                              <Box key={subCat} sx={{ mb: 1.5, borderLeft: '2px dashed #cbd5e1', pl: 2 }}>
                                <Box 
                                  onClick={() => toggleNode(subCatKey)}
                                  sx={{ 
                                    py: 1, px: 1.5, display: 'flex', justifyContent: 'space-between', alignItems: 'center', 
                                    cursor: 'pointer', borderRadius: 2, bgcolor: '#ffffff', '&:hover': { bgcolor: '#f8fafc' } 
                                  }}
                                >
                                  <Stack direction="row" spacing={1} alignItems="center">
                                    <IconButton size="small">
                                      {isSubExpanded ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                                    </IconButton>
                                    <Typography variant="body2" fontWeight={800} color="#334155">
                                      📁 {subCat}
                                    </Typography>
                                    <Chip label={`${subCatAccounts.length}`} size="small" variant="outlined" sx={{ height: 20, fontSize: '0.7rem', fontWeight: 700 }} />
                                  </Stack>

                                  <Button 
                                    size="small" 
                                    onClick={(e) => { e.stopPropagation(); handleOpenCreateAccount(groupName, subCat); }}
                                    sx={{ fontSize: '0.75rem' }}
                                  >
                                    + Add under {subCat}
                                  </Button>
                                </Box>

                                {/* Child Accounts Table */}
                                <Collapse in={isSubExpanded}>
                                  <TableContainer sx={{ pl: 3, my: 0.5 }}>
                                    <Table size="small">
                                      <TableHead sx={{ bgcolor: '#f1f5f9' }}>
                                        <TableRow>
                                          <TableCell sx={{ fontWeight: 700, width: 120 }}>Code</TableCell>
                                          <TableCell sx={{ fontWeight: 700 }}>Account Name</TableCell>
                                          <TableCell sx={{ fontWeight: 700, width: 130 }} align="right">Opening (₹)</TableCell>
                                          <TableCell sx={{ fontWeight: 700, width: 140 }} align="right">Current (₹)</TableCell>
                                          <TableCell sx={{ fontWeight: 700, width: 90 }}>Status</TableCell>
                                          <TableCell sx={{ fontWeight: 700, width: 100 }} align="center">Actions</TableCell>
                                        </TableRow>
                                      </TableHead>
                                      <TableBody>
                                        {subCatAccounts.length === 0 ? (
                                          <TableRow>
                                            <TableCell colSpan={6} align="center" sx={{ py: 2 }}>
                                              <Typography variant="caption" color="text.secondary">No accounts under {subCat} yet.</Typography>
                                            </TableCell>
                                          </TableRow>
                                        ) : (
                                          subCatAccounts.map(acc => (
                                            <TableRow key={acc.id} hover>
                                              <TableCell sx={{ fontWeight: 700, fontFamily: 'monospace', color: 'primary.main' }}>{acc.code}</TableCell>
                                              <TableCell sx={{ fontWeight: 600 }}>{acc.name}</TableCell>
                                              <TableCell align="right">₹{(parseFloat(acc.opening_balance) || 0).toLocaleString()}</TableCell>
                                              <TableCell align="right" sx={{ fontWeight: 700 }}>₹{(parseFloat(acc.current_balance) || 0).toLocaleString()}</TableCell>
                                              <TableCell><Chip label={acc.status} color={acc.status === 'Active' ? 'success' : 'default'} size="small" sx={{ height: 20, fontSize: '0.7rem', fontWeight: 700 }} /></TableCell>
                                              <TableCell align="center">
                                                <Stack direction="row" spacing={0.5} justifyContent="center">
                                                  <IconButton size="small" color="primary" onClick={() => setSelectedAccountForView(acc)}><ViewIcon fontSize="small" /></IconButton>
                                                  <IconButton size="small" color="info" onClick={() => handleOpenEditAccount(acc)}><EditIcon fontSize="small" /></IconButton>
                                                  <IconButton size="small" color="error" onClick={() => handleDeleteAccount(acc)}><DeleteIcon fontSize="small" /></IconButton>
                                                </Stack>
                                              </TableCell>
                                            </TableRow>
                                          ))
                                        )}
                                      </TableBody>
                                    </Table>
                                  </TableContainer>
                                </Collapse>
                              </Box>
                            );
                          })}
                        </Box>
                      </Collapse>
                    </Card>
                  );
                })}
              </Box>
            </Card>
          ) : (
            /* FLAT TABLE VIEW */
            <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: '#f8fafc' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 700 }}>Code</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Account Name</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Sub-Category Group</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Type</TableCell>
                      <TableCell sx={{ fontWeight: 700 }} align="right">Opening Bal (₹)</TableCell>
                      <TableCell sx={{ fontWeight: 700 }} align="right">Current Bal (₹)</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                      <TableCell sx={{ fontWeight: 700, width: 110 }} align="center">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredAccounts.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={8} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary">No matching accounts found in the Chart of Accounts.</Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredAccounts.map(a => (
                        <TableRow key={a.id} hover>
                          <TableCell sx={{ fontWeight: 700, fontFamily: 'monospace', color: 'primary.main' }}>{a.code}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>{a.name}</TableCell>
                          <TableCell><Chip label={a.account_group || 'General'} size="small" variant="outlined" sx={{ fontWeight: 600 }} /></TableCell>
                          <TableCell><Chip label={a.account_type} color="primary" size="small" sx={{ fontWeight: 700 }} /></TableCell>
                          <TableCell align="right">₹{(parseFloat(a.opening_balance) || 0).toLocaleString()}</TableCell>
                          <TableCell align="right" sx={{ fontWeight: 700 }}>₹{(parseFloat(a.current_balance) || 0).toLocaleString()}</TableCell>
                          <TableCell><Chip label={a.status} color={a.status === 'Active' ? 'success' : 'default'} size="small" sx={{ fontWeight: 700 }} /></TableCell>
                          <TableCell align="center">
                            <Stack direction="row" spacing={0.5} justifyContent="center">
                              <IconButton size="small" color="primary" onClick={() => setSelectedAccountForView(a)}><ViewIcon fontSize="small" /></IconButton>
                              <IconButton size="small" color="info" onClick={() => handleOpenEditAccount(a)}><EditIcon fontSize="small" /></IconButton>
                              <IconButton size="small" color="error" onClick={() => handleDeleteAccount(a)}><DeleteIcon fontSize="small" /></IconButton>
                            </Stack>
                          </TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          )}
        </Stack>
      )}

      {/* 2. RECEIPT VOUCHER VIEW */}
      {topTab === 2 && voucherSubTab === 'receipt' && (
        <StandardVoucherForm 
          voucherType="RECEIPT"
          accounts={accounts}
          cashOrBankAccounts={cashOrBankAccounts}
          partiesList={partiesList}
          showToast={showToast}
          onSaveVoucher={handleSaveStandardVoucher}
        />
      )}

      {/* 3. PAYMENT VOUCHER VIEW */}
      {topTab === 2 && voucherSubTab === 'payment' && (
        <StandardVoucherForm 
          voucherType="PAYMENT"
          accounts={accounts}
          cashOrBankAccounts={cashOrBankAccounts}
          partiesList={partiesList}
          showToast={showToast}
          onSaveVoucher={handleSaveStandardVoucher}
        />
      )}

      {/* 4. CONTRA ENTRY VIEW */}
      {topTab === 2 && voucherSubTab === 'contra' && (
        <StandardVoucherForm 
          voucherType="CONTRA"
          accounts={accounts}
          cashOrBankAccounts={cashOrBankAccounts}
          partiesList={partiesList}
          showToast={showToast}
          onSaveVoucher={handleSaveStandardVoucher}
        />
      )}

      {/* 5. JOURNAL VOUCHER VIEW */}
      {topTab === 2 && voucherSubTab === 'journal' && (
        <Card variant="outlined" sx={{ p: 4, borderRadius: 4 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2 }}>
            <JournalIcon color="action" sx={{ fontSize: 32 }} />
            <Box>
              <Typography variant="h6" fontWeight={850}>Journal Voucher (JV)</Typography>
              <Typography variant="body2" color="text.secondary">
                Flexible multi-line general journal for non-cash adjusting entries (depreciation, bad debt write-offs, opening balances).
              </Typography>
            </Box>
          </Box>
          <Alert severity="warning" sx={{ mb: 3, fontWeight: 600 }}>
            Notice: Journal Vouchers are intended for non-cash adjustments. For cash or bank movements, please use Receipt, Payment, or Contra vouchers.
          </Alert>

          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={4}>
                <TextField 
                  type="date" fullWidth size="small" label="Voucher Date"
                  value={journalForm.date}
                  onChange={(e) => setJournalForm({ ...journalForm, date: e.target.value })}
                  InputLabelProps={{ shrink: true }}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField 
                  fullWidth size="small" label="Reference / Voucher No"
                  placeholder="Auto-generated if blank"
                  value={journalForm.reference_no}
                  onChange={(e) => setJournalForm({ ...journalForm, reference_no: e.target.value })}
                />
              </Grid>
            </Grid>

            {journalForm.lines.map((line, idx) => (
              <Grid container spacing={2} key={idx} alignItems="center">
                <Grid item xs={12} sm={6}>
                  <TextField 
                    select fullWidth size="small" label={`Account Line #${idx + 1} *`}
                    value={line.account}
                    onChange={(e) => {
                      const nextLines = [...journalForm.lines];
                      nextLines[idx].account = e.target.value;
                      setJournalForm({ ...journalForm, lines: nextLines });
                    }}
                  >
                    {accounts.map(a => (
                      <MenuItem key={a.id} value={a.code}>{a.code} - {a.name} ({a.account_type})</MenuItem>
                    ))}
                  </TextField>
                </Grid>
                <Grid item xs={12} sm={2.5}>
                  <TextField 
                    type="number" fullWidth size="small" label="Debit (₹)"
                    value={line.debit}
                    onChange={(e) => {
                      const nextLines = [...journalForm.lines];
                      nextLines[idx].debit = e.target.value;
                      setJournalForm({ ...journalForm, lines: nextLines });
                    }}
                  />
                </Grid>
                <Grid item xs={12} sm={2.5}>
                  <TextField 
                    type="number" fullWidth size="small" label="Credit (₹)"
                    value={line.credit}
                    onChange={(e) => {
                      const nextLines = [...journalForm.lines];
                      nextLines[idx].credit = e.target.value;
                      setJournalForm({ ...journalForm, lines: nextLines });
                    }}
                  />
                </Grid>
                <Grid item xs={12} sm={1}>
                  {journalForm.lines.length > 2 && (
                    <IconButton color="error" onClick={() => {
                      setJournalForm({ ...journalForm, lines: journalForm.lines.filter((_, i) => i !== idx) });
                    }}>
                      <DeleteIcon />
                    </IconButton>
                  )}
                </Grid>
              </Grid>
            ))}

            <Button 
              variant="outlined" size="small" startIcon={<AddIcon />} 
              onClick={() => setJournalForm({ ...journalForm, lines: [...journalForm.lines, { account: '', debit: '', credit: '' }] })}
              sx={{ alignSelf: 'flex-start', fontWeight: 700 }}
            >
              + Add Journal Line
            </Button>

            <TextField 
              fullWidth multiline rows={2} size="small" label="Narration / Description"
              placeholder="e.g. Year-end machinery depreciation entry..."
              value={journalForm.narration}
              onChange={(e) => setJournalForm({ ...journalForm, narration: e.target.value })}
            />

            <Button 
              variant="contained" size="large" onClick={handleSaveJournalVoucher}
              sx={{ backgroundColor: '#2563EB', fontWeight: 800, py: 1.2, alignSelf: 'flex-start', px: 4 }}
            >
              Post Journal Voucher
            </Button>
          </Stack>
        </Card>
      )}

      {/* 6. VIEW ALL VOUCHERS VIEW */}
      {topTab === 2 && voucherSubTab === 'all' && (
        <Card variant="outlined" sx={{ p: 4, borderRadius: 4 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" gap={2} sx={{ mb: 3 }}>
            <Box>
              <Typography variant="h6" fontWeight={850}>View All Vouchers & Journal Register</Typography>
              <Typography variant="body2" color="text.secondary">
                Single unified register of all 4 voucher types (Receipt, Payment, Contra, Journal) with status tracking & reversals.
              </Typography>
            </Box>
            <Stack direction="row" spacing={1.5}>
              <TextField 
                select size="small" label="Voucher Type"
                value={voucherTypeFilter}
                onChange={(e) => setVoucherTypeFilter(e.target.value)}
                sx={{ minWidth: 160 }}
              >
                <MenuItem value="ALL">All Types</MenuItem>
                <MenuItem value="RV">Receipt Voucher (RV)</MenuItem>
                <MenuItem value="PV">Payment Voucher (PV)</MenuItem>
                <MenuItem value="CV">Contra Entry (CV)</MenuItem>
                <MenuItem value="JV">Journal Voucher (JV)</MenuItem>
              </TextField>
              <TextField 
                select size="small" label="Status"
                value={voucherStatusFilter}
                onChange={(e) => setVoucherStatusFilter(e.target.value)}
                sx={{ minWidth: 140 }}
              >
                <MenuItem value="ALL">All Statuses</MenuItem>
                <MenuItem value="POSTED">POSTED</MenuItem>
                <MenuItem value="REVERSED">REVERSED</MenuItem>
                <MenuItem value="CANCELLED">CANCELLED</MenuItem>
              </TextField>
            </Stack>
          </Stack>

          <Table size="small">
            <TableHead sx={{ bgcolor: '#f8fafc' }}>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Voucher No</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Date</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Type</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Narration</TableCell>
                <TableCell sx={{ fontWeight: 700, textAlign: 'right' }}>Amount (₹)</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                <TableCell align="center" sx={{ fontWeight: 700 }}>Action</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {journalEntries.filter(j => {
                if (!j) return false;
                if (voucherTypeFilter !== 'ALL' && (j.voucher_type_code || j.entry_number.slice(0,2)) !== voucherTypeFilter) return false;
                if (voucherStatusFilter !== 'ALL' && (j.status || 'POSTED') !== voucherStatusFilter) return false;
                return true;
              }).length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} align="center" sx={{ py: 6 }}>
                    <Typography variant="body2" color="text.secondary">No vouchers match the selected filter criteria.</Typography>
                  </TableCell>
                </TableRow>
              ) : (
                journalEntries.filter(j => {
                  if (!j) return false;
                  if (voucherTypeFilter !== 'ALL' && (j.voucher_type_code || j.entry_number.slice(0,2)) !== voucherTypeFilter) return false;
                  if (voucherStatusFilter !== 'ALL' && (j.status || 'POSTED') !== voucherStatusFilter) return false;
                  return true;
                }).map(j => {
                  const typeCode = j.voucher_type_code || j.entry_number.slice(0,2) || 'JV';
                  const typeColor = typeCode === 'RV' ? 'success' : typeCode === 'PV' ? 'error' : typeCode === 'CV' ? 'info' : 'secondary';
                  const statusColor = (j.status || 'POSTED') === 'POSTED' ? 'success' : (j.status || '') === 'REVERSED' ? 'warning' : 'default';

                  return (
                    <TableRow key={j.id} hover>
                      <TableCell sx={{ fontWeight: 700, color: 'primary.main', fontFamily: 'monospace' }}>{j.entry_number}</TableCell>
                      <TableCell>{j.date}</TableCell>
                      <TableCell><Chip label={typeCode} color={typeColor} size="small" sx={{ fontWeight: 800 }} /></TableCell>
                      <TableCell>{j.description || j.narration || 'General Voucher Entry'}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 800 }}>₹{(parseFloat(j.amount || 0)).toLocaleString()}</TableCell>
                      <TableCell><Chip label={j.status || 'POSTED'} color={statusColor} size="small" sx={{ fontWeight: 700 }} /></TableCell>
                      <TableCell align="center">
                        {j.status !== 'REVERSED' && (
                          <Tooltip title="Create Immutable Reversal Entry">
                            <Button 
                              size="small" variant="outlined" color="warning" 
                              startIcon={<ReverseIcon />}
                              onClick={() => handleReverseVoucher(j)}
                              sx={{ textTransform: 'none', fontWeight: 700, fontSize: '0.72rem' }}
                            >
                              Reverse
                            </Button>
                          </Tooltip>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* 7. GENERAL LEDGER VIEW */}
      {topTab === 3 && (
        <Card variant="outlined" sx={{ p: 4, borderRadius: 4 }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>General Ledger Statement</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
            Account-wise debit, credit, and running balance ledger statement.
          </Typography>
        </Card>
      )}

      {/* 8. TRIAL BALANCE VIEW */}
      {topTab === 4 && (
        <Card variant="outlined" sx={{ p: 4, borderRadius: 4 }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Trial Balance Statement</Typography>
          <Table size="small">
            <TableHead sx={{ bgcolor: '#f8fafc' }}>
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Account Code & Name</TableCell>
                <TableCell sx={{ fontWeight: 700, textAlign: 'right' }}>Debit (₹)</TableCell>
                <TableCell sx={{ fontWeight: 700, textAlign: 'right' }}>Credit (₹)</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {accounts.map(a => {
                if (!a) return null;
                const behavior = getAccountTypeBehavior(a.account_type);
                const isDebitSide = behavior.normal_balance === 'DEBIT';
                const bal = parseFloat(a.current_balance) || 0;
                return (
                  <TableRow key={a.id}>
                    <TableCell sx={{ fontWeight: 600 }}>{a.code} - {a.name}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{isDebitSide ? `₹${bal.toLocaleString()}` : '-'}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{!isDebitSide ? `₹${bal.toLocaleString()}` : '-'}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Card>
      )}

      {/* 9. PROFIT & LOSS VIEW (NO COGS) */}
      {topTab === 5 && (
        <Card variant="outlined" sx={{ p: 4, borderRadius: 4 }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Profit & Loss (P&L) Statement</Typography>
          <Alert severity="info" sx={{ mb: 3, fontWeight: 600 }}>
            Operating Income vs Operating Expenses statement (Excludes COGS as per Chart of Accounts configuration).
          </Alert>
          <Grid container spacing={3}>
            <Grid item xs={12} md={6}>
              <Paper variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
                <Typography variant="subtitle1" fontWeight={800} color="success.main" sx={{ mb: 1.5 }}>Total Operating Income</Typography>
                <Typography variant="h4" fontWeight={850}>₹{totalIncome.toLocaleString()}</Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} md={6}>
              <Paper variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
                <Typography variant="subtitle1" fontWeight={800} color="error.main" sx={{ mb: 1.5 }}>Total Operating Expenses</Typography>
                <Typography variant="h4" fontWeight={850}>₹{totalExpenses.toLocaleString()}</Typography>
              </Paper>
            </Grid>
          </Grid>
        </Card>
      )}

      {/* 10. BALANCE SHEET VIEW */}
      {topTab === 6 && (
        <Card variant="outlined" sx={{ p: 4, borderRadius: 4 }}>
          <Typography variant="h6" fontWeight={850} sx={{ mb: 2 }}>Balance Sheet Statement</Typography>
          <Grid container spacing={3}>
            <Grid item xs={12} md={6}>
              <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1 }}>ASSETS</Typography>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Typography variant="h5" fontWeight={850} color="primary.main">₹{totalAssets.toLocaleString()}</Typography>
              </Paper>
            </Grid>
            <Grid item xs={12} md={6}>
              <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1 }}>LIABILITIES & EQUITY</Typography>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Typography variant="h5" fontWeight={850} color="error.main">₹{(totalLiabilities + totalEquity).toLocaleString()}</Typography>
              </Paper>
            </Grid>
          </Grid>
        </Card>
      )}

      {/* 11. FINANCIAL REPORTS VIEW */}
      {topTab === 7 && (
        <Card variant="outlined" sx={{ p: 4, borderRadius: 4 }}>
          <Typography variant="h6" fontWeight={850} sx={{ mb: 2 }}>Financial & Audit Reports</Typography>
          <Stack direction="row" spacing={2}>
            <Button variant="outlined" startIcon={<FileDownloadIcon />} onClick={() => showToast("Financial Report exported to Excel!", "success")}>Export Excel</Button>
            <Button variant="outlined" startIcon={<DownloadIcon />} onClick={() => showToast("Financial Report exported to PDF!", "success")}>Export PDF</Button>
            <Button variant="outlined" startIcon={<PrintIcon />} onClick={() => window.print()}>Print Statements</Button>
          </Stack>
        </Card>
      )}

      {/* DIALOG: ADD / EDIT ACCOUNT */}
      <Dialog open={accountModalOpen} onClose={() => setAccountModalOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 850, pb: 1, borderBottom: '1px solid #e2e8f0' }}>
          {isEditingAccount ? 'Edit Account' : 'Add New Account'}
        </DialogTitle>
        <DialogContent dividers sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            {/* Primary Identifier Row */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={8}>
                <TextField 
                  fullWidth 
                  size="small" 
                  label="Account Name *" 
                  placeholder="e.g. Main Cash Drawer, HDFC Bank..."
                  value={accountFormData.name} 
                  onChange={(e) => setAccountFormData({ ...accountFormData, name: e.target.value })}
                  inputProps={{ style: { fontWeight: 600 } }}
                />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField 
                  fullWidth 
                  size="small" 
                  disabled
                  label="Account Code *" 
                  value={accountFormData.code} 
                  helperText="(Auto-generated code)"
                  FormHelperTextProps={{ sx: { fontSize: '0.72rem', color: '#64748b', mt: 0.3 } }}
                />
              </Grid>
            </Grid>

            {/* SECTION 1: ACCOUNT CLASSIFICATION */}
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#f8fafc', borderColor: '#e2e8f0' }}>
              <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ letterSpacing: 0.8, textTransform: 'uppercase', mb: 1.5, display: 'block' }}>
                1. Account Classification & Hierarchy
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  {!isAddingAccountType ? (
                    <TextField 
                      select 
                      fullWidth 
                      size="small" 
                      label="Account Type *" 
                      value={accountFormData.account_type}
                      onChange={(e) => {
                        if (e.target.value === '__ADD_NEW_ACCOUNT_TYPE__') {
                          setIsAddingAccountType(true);
                          setNewTypeName('');
                          setNewTypeBehavesLike('Assets');
                          setAccountTypeError('');
                        } else {
                          const selectedType = e.target.value;
                          const behavior = getAccountTypeBehavior(selectedType);
                          const groups = getAccountGroups(selectedType);
                          setAccountFormData({
                            ...accountFormData,
                            account_type: selectedType,
                            account_group: groups[0] || `General ${selectedType}`,
                            code: generateAccountCode(behavior.base_type || 'Assets')
                          });
                        }
                      }}
                      helperText="Controls financial category & normal balance"
                      FormHelperTextProps={{ sx: { fontSize: '0.72rem', color: '#64748b' } }}
                    >
                      {getAvailableAccountTypes().map(type => (
                        <MenuItem key={type} value={type}>{type}</MenuItem>
                      ))}
                      <Divider sx={{ my: 0.5 }} />
                      <MenuItem value="__ADD_NEW_ACCOUNT_TYPE__" sx={{ color: 'primary.main', fontWeight: 700, bgcolor: '#f0f9ff' }}>
                        + Add new Account Type...
                      </MenuItem>
                    </TextField>
                  ) : (
                    <Box sx={{ border: '1px solid #2563eb', p: 1.5, borderRadius: 2, bgcolor: '#ffffff' }}>
                      <Typography variant="caption" fontWeight={700} color="primary.main" sx={{ display: 'block', mb: 1 }}>
                        Create Custom Account Type:
                      </Typography>
                      <Stack spacing={1.5}>
                        <TextField 
                          autoFocus
                          size="small" 
                          label="Type Name *"
                          placeholder="e.g. Operating Reserve..."
                          value={newTypeName}
                          onChange={(e) => {
                            setNewTypeName(e.target.value);
                            if (accountTypeError) setAccountTypeError('');
                          }}
                          error={Boolean(accountTypeError)}
                          helperText={accountTypeError}
                          FormHelperTextProps={{ sx: { fontSize: '0.7rem' } }}
                        />

                        <TextField 
                          select 
                          fullWidth 
                          size="small" 
                          label="Behaves like (Normal Balance) *" 
                          value={newTypeBehavesLike}
                          onChange={(e) => setNewTypeBehavesLike(e.target.value)}
                          helperText="Determines balance sheet vs P&L rolling"
                          FormHelperTextProps={{ sx: { fontSize: '0.7rem' } }}
                        >
                          {DEFAULT_ACCOUNT_TYPES.map(baseT => (
                            <MenuItem key={baseT} value={baseT}>
                              {baseT} ({TYPE_BEHAVIOR_RULES[baseT].normal_balance} balance | {TYPE_BEHAVIOR_RULES[baseT].statement_type})
                            </MenuItem>
                          ))}
                        </TextField>

                        <Stack direction="row" spacing={1} justifyContent="flex-end">
                          <Button 
                            variant="outlined" 
                            size="small" 
                            color="inherit"
                            onClick={() => {
                              setIsAddingAccountType(false);
                              setNewTypeName('');
                              setNewTypeBehavesLike('Assets');
                              setAccountTypeError('');
                            }}
                          >
                            Cancel
                          </Button>
                          <Button 
                            variant="contained" 
                            size="small" 
                            onClick={handleSaveNewAccountType}
                            sx={{ backgroundColor: '#2563EB', fontWeight: 700 }}
                          >
                            Save Type
                          </Button>
                        </Stack>
                      </Stack>
                    </Box>
                  )}
                </Grid>

                <Grid item xs={12} sm={6}>
                  {!isAddingSubCategory ? (
                    <TextField 
                      select 
                      fullWidth 
                      size="small" 
                      label="Account Sub-Category Group *" 
                      value={accountFormData.account_group}
                      onChange={(e) => {
                        if (e.target.value === '__ADD_NEW_SUB_CATEGORY__') {
                          setIsAddingSubCategory(true);
                          setNewSubCategoryName('');
                          setSubCategoryError('');
                        } else {
                          setAccountFormData({ ...accountFormData, account_group: e.target.value });
                        }
                      }}
                      helperText="Sub-classification under chosen type"
                      FormHelperTextProps={{ sx: { fontSize: '0.72rem', color: '#64748b' } }}
                    >
                      {getAvailableSubCategories(accountFormData.account_type).map(grp => (
                        <MenuItem key={grp} value={grp}>{grp}</MenuItem>
                      ))}
                      <Divider sx={{ my: 0.5 }} />
                      <MenuItem value="__ADD_NEW_SUB_CATEGORY__" sx={{ color: 'primary.main', fontWeight: 700, bgcolor: '#f0f9ff' }}>
                        + Add new sub-category...
                      </MenuItem>
                    </TextField>
                  ) : (
                    <Box sx={{ border: '1px solid #2563eb', p: 1.5, borderRadius: 2, bgcolor: '#ffffff' }}>
                      <Typography variant="caption" fontWeight={700} color="primary.main" sx={{ display: 'block', mb: 1 }}>
                        Create Sub-Category under {accountFormData.account_type}:
                      </Typography>
                      <Stack direction="row" spacing={1} alignItems="flex-start">
                        <TextField 
                          autoFocus
                          size="small" 
                          placeholder="Enter sub-category name..."
                          value={newSubCategoryName}
                          onChange={(e) => {
                            setNewSubCategoryName(e.target.value);
                            if (subCategoryError) setSubCategoryError('');
                          }}
                          error={Boolean(subCategoryError)}
                          helperText={subCategoryError || "Click Save to create & select"}
                          FormHelperTextProps={{ sx: { fontSize: '0.7rem' } }}
                          sx={{ flexGrow: 1 }}
                        />
                        <Button 
                          variant="contained" 
                          size="small" 
                          onClick={handleSaveNewSubCategory}
                          sx={{ backgroundColor: '#2563EB', fontWeight: 700, mt: 0.2 }}
                        >
                          Save
                        </Button>
                        <Button 
                          variant="outlined" 
                          size="small" 
                          color="inherit"
                          onClick={() => {
                            setIsAddingSubCategory(false);
                            setNewSubCategoryName('');
                            setSubCategoryError('');
                          }}
                          sx={{ mt: 0.2 }}
                        >
                          Cancel
                        </Button>
                      </Stack>
                    </Box>
                  )}
                </Grid>

                <Grid item xs={12}>
                  <TextField 
                    select 
                    fullWidth 
                    size="small" 
                    label="Parent Account (Optional)" 
                    value={accountFormData.parent_account_id}
                    onChange={(e) => setAccountFormData({ ...accountFormData, parent_account_id: e.target.value })}
                    SelectProps={{
                      MenuProps: { PaperProps: { sx: { maxHeight: 300, maxWidth: 500 } } }
                    }}
                    helperText="Optional parent account to nest under in tree view"
                    FormHelperTextProps={{ sx: { fontSize: '0.72rem', color: '#64748b' } }}
                  >
                    <MenuItem value="">-- None (Top Level Account) --</MenuItem>
                    {(accounts || []).filter(a => a && a.account_type === accountFormData.account_type && a.id !== accountFormData.id).map(a => (
                      <MenuItem key={a.id} value={a.id} sx={{ py: 1 }}>
                        <Typography variant="body2" sx={{ fontWeight: 600 }}>
                          {a.code} - {a.name}
                        </Typography>
                      </MenuItem>
                    ))}
                  </TextField>
                </Grid>
              </Grid>
            </Paper>

            {/* SECTION 2: OPENING BALANCE & STATUS */}
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0' }}>
              <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ letterSpacing: 0.8, textTransform: 'uppercase', mb: 1.5, display: 'block' }}>
                2. Balance & Status
              </Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6}>
                  <TextField 
                    fullWidth 
                    size="small" 
                    type="number" 
                    label="Opening Balance (INR)" 
                    value={accountFormData.opening_balance} 
                    onChange={(e) => setAccountFormData({ ...accountFormData, opening_balance: e.target.value })} 
                  />
                </Grid>

                <Grid item xs={12} sm={6}>
                  <TextField 
                    select 
                    fullWidth 
                    size="small" 
                    label="Status" 
                    value={accountFormData.status} 
                    onChange={(e) => setAccountFormData({ ...accountFormData, status: e.target.value })}
                  >
                    <MenuItem value="Active">Active</MenuItem>
                    <MenuItem value="Inactive">Inactive</MenuItem>
                  </TextField>
                </Grid>

                <Grid item xs={12}>
                  <TextField 
                    fullWidth 
                    multiline 
                    rows={2} 
                    size="small" 
                    label="Description" 
                    placeholder="Add account description or notes..."
                    value={accountFormData.description} 
                    onChange={(e) => setAccountFormData({ ...accountFormData, description: e.target.value })} 
                  />
                </Grid>
              </Grid>
            </Paper>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setAccountModalOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveAccount} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            {isEditingAccount ? 'Update Account' : 'Create Account'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* DIALOG: EXCEL IMPORT */}
      <Dialog open={importModalOpen} onClose={() => setImportModalOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Import Chart of Accounts</DialogTitle>
        <DialogContent dividers>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Upload an Excel (.xlsx / .xls) or CSV file containing Account Code, Account Name, Group, and Opening Balance.
          </Typography>
          <Button variant="contained" component="label" fullWidth startIcon={<CloudUploadIcon />} sx={{ py: 1.5, fontWeight: 700 }}>
            Select Excel File
            <input type="file" hidden accept=".xlsx,.xls,.csv" onChange={handleExcelImport} />
          </Button>
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={() => setImportModalOpen(false)}>Cancel</Button>
        </DialogActions>
      </Dialog>

      {/* DRAWER: ACCOUNT DETAILS VIEW */}
      <Drawer anchor="right" open={Boolean(selectedAccountForView)} onClose={() => setSelectedAccountForView(null)}>
        {selectedAccountForView && (
          <Box sx={{ width: 380, p: 3 }}>
            <Typography variant="h6" fontWeight={850} sx={{ mb: 2 }}>Account Details</Typography>
            <Stack spacing={2}>
              <Box sx={{ p: 2, bgcolor: '#f8fafc', borderRadius: 2 }}>
                <Typography variant="subtitle2" fontWeight={800}>{selectedAccountForView.code} - {selectedAccountForView.name}</Typography>
                <Typography variant="caption" color="text.secondary">Group: {selectedAccountForView.account_group}</Typography>
              </Box>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">Account Type</Typography>
                <Typography variant="body2" fontWeight={700}>{selectedAccountForView.account_type}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">Opening Balance</Typography>
                <Typography variant="body2" fontWeight={700}>₹{(parseFloat(selectedAccountForView.opening_balance) || 0).toLocaleString()}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">Current Balance</Typography>
                <Typography variant="body2" fontWeight={850} color="primary.main">₹{(parseFloat(selectedAccountForView.current_balance) || 0).toLocaleString()}</Typography>
              </Stack>
              <Stack direction="row" justifyContent="space-between">
                <Typography variant="body2" color="text.secondary">Status</Typography>
                <Chip label={selectedAccountForView.status} color={selectedAccountForView.status === 'Active' ? 'success' : 'default'} size="small" sx={{ fontWeight: 700 }} />
              </Stack>
              <Divider />
              <Typography variant="caption" color="text.secondary">{selectedAccountForView.description || 'No description provided.'}</Typography>
            </Stack>
          </Box>
        )}
      </Drawer>

      {/* Toast Notification Snackbar */}
      <Snackbar 
        open={toast.open} 
        autoHideDuration={4000} 
        onClose={() => setToast({ ...toast, open: false })}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
      >
        <Alert severity={toast.severity} onClose={() => setToast({ ...toast, open: false })} sx={{ fontWeight: 700 }}>
          {toast.message}
        </Alert>
      </Snackbar>

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

export default function FinancialManagement() {
  return (
    <FinancialErrorBoundary>
      <FinancialManagementView />
    </FinancialErrorBoundary>
  );
}
