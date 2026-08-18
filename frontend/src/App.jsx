import React, { useState, useEffect, lazy, Suspense } from 'react';
import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline, Box, Typography, LinearProgress } from '@mui/material';
import { getTheme } from './theme/theme';
import { AuthProvider, useAuth } from './context/AuthContext';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';

// Lazy loaded page components for maximum performance & fast route loading
const Products = lazy(() => import('./pages/Products'));
const SalesInvoice = lazy(() => import('./pages/SalesInvoice'));
const WholesaleSales = lazy(() => import('./pages/WholesaleSales'));
const AccountsCOA = lazy(() => import('./pages/AccountsCOA'));
const FinancialManagement = lazy(() => import('./pages/FinancialManagement'));
const OpticalServices = lazy(() => import('./pages/OpticalServices'));
const Appointments = lazy(() => import('./pages/Appointments'));
const PatientHistory = lazy(() => import('./pages/PatientHistory'));
const Purchases = lazy(() => import('./pages/Purchases'));
const Administration = lazy(() => import('./pages/Administration'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));

function MainLayout() {
  const { user, loading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [themeMode, setThemeMode] = useState('light');

  const theme = getTheme(themeMode);
  const toggleTheme = () => setThemeMode(prev => prev === 'dark' ? 'light' : 'dark');

  // 🚀 GLOBAL ENTER KEY SMART HANDLER (Form navigation, modal submission & search execution)
  useEffect(() => {
    const handleGlobalKeyDown = (e) => {
      if (e.key !== 'Enter') return;

      const target = e.target;
      // Exclude textareas so multiline clinical notes can use Enter for line breaks
      if (!target || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      // The Optical Eye Test screen (single-screen + wizard layouts) has its own dedicated,
      // field-order-aware Enter-key handler. Layering this generic handler on top of it caused
      // a real bug: on the last input of a card, this handler's "find a contained/submit-looking
      // button" fallback would grab whichever contained button appeared first in that card (e.g.
      // the "Search Registered Patients" icon button) instead of the intended Save action.
      if (target.closest('#optical-single-form-container') || target.closest('#optical-step-container')) return;

      // 1. Inside a Modal Dialog
      const activeDialog = target.closest('.MuiDialog-root') || document.querySelector('.MuiDialog-root');
      if (activeDialog) {
        if (target.tagName === 'INPUT') {
          const dialogInputs = Array.from(activeDialog.querySelectorAll('input:not([type="hidden"]):not([disabled])'));
          const currIdx = dialogInputs.indexOf(target);
          if (currIdx !== -1 && currIdx < dialogInputs.length - 1) {
            e.preventDefault();
            const nextInp = dialogInputs[currIdx + 1];
            nextInp.focus();
            if (typeof nextInp.select === 'function') nextInp.select();
            return;
          }
        }

        const primaryBtn = activeDialog.querySelector('button[type="submit"]') ||
                           Array.from(activeDialog.querySelectorAll('button')).find(b => {
                             const txt = b.textContent.toLowerCase();
                             return b.classList.contains('MuiButton-contained') || 
                                    txt.includes('save') || txt.includes('submit') || 
                                    txt.includes('search') || txt.includes('add') || 
                                    txt.includes('create') || txt.includes('register');
                           });

        if (primaryBtn) {
          e.preventDefault();
          primaryBtn.click();
          return;
        }
      }

      // 2. Standard Input Fields across Forms, Grids & Search Bars
      if (target.tagName === 'INPUT') {
        const parentContainer = target.closest('form') || target.closest('.MuiCard-root') || target.closest('.MuiPaper-root') || document.body;
        const allInputs = Array.from(parentContainer.querySelectorAll('input:not([type="hidden"]):not([disabled])'));
        const index = allInputs.indexOf(target);

        // Advance to next field on Enter if not the last input
        if (index !== -1 && index < allInputs.length - 1) {
          e.preventDefault();
          const nextInput = allInputs[index + 1];
          nextInput.focus();
          if (typeof nextInput.select === 'function') nextInput.select();
          return;
        }

        // Trigger primary action/submit button on last field or standalone search input
        const submitBtn = parentContainer.querySelector('button[type="submit"]') || 
                          Array.from(parentContainer.querySelectorAll('button')).find(b => {
                            const txt = b.textContent.toLowerCase();
                            return b.classList.contains('MuiButton-contained') || 
                                   txt.includes('save') || txt.includes('search') || 
                                   txt.includes('submit') || txt.includes('pay') || txt.includes('next');
                          });
        if (submitBtn) {
          e.preventDefault();
          submitBtn.click();
        }
      }
    };

    window.addEventListener('keydown', handleGlobalKeyDown, true);
    return () => window.removeEventListener('keydown', handleGlobalKeyDown, true);
  }, []);


  if (loading) {
    return (
      <Box sx={{ display: 'flex', minHeight: '100vh', alignItems: 'center', justifyContent: 'center', backgroundColor: '#f8fafc' }}>
        <span style={{ fontSize: '2rem', color: '#6366f1', animation: 'spin 1s linear infinite' }}>⏳</span>
      </Box>
    );
  }

  if (!user) {
    return (
      <ThemeProvider theme={getTheme('light')}>
        <CssBaseline />
        <Login />
      </ThemeProvider>
    );
  }

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Box sx={{ display: 'flex', minHeight: '100vh', backgroundColor: 'background.default' }}>
        {/* Collapsible Sidebar */}
        <Sidebar open={sidebarOpen} toggleSidebar={() => setSidebarOpen(!sidebarOpen)} />
        
        {/* Main Work Area */}
        <Box sx={{ flexGrow: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
          <Header toggleTheme={toggleTheme} mode={themeMode} />
          
          <Box component="main" sx={{ flexGrow: 1, overflowY: 'auto' }}>
            <Suspense fallback={<LinearProgress color="primary" sx={{ height: 3 }} />}>
              <Routes>
                <Route path="/" element={<Dashboard />} />
                
                {/* Optical Services Sub-Routes */}
                <Route path="/optical/eyetest" element={<OpticalServices />} />
                <Route path="/optical/prescription" element={<OpticalServices />} />
                <Route path="/optical/pd" element={<OpticalServices />} />
                <Route path="/optical/vision" element={<OpticalServices />} />
                <Route path="/optical/contactlens" element={<OpticalServices />} />
                <Route path="/optical/eyetest-report" element={<Reports />} />
                <Route path="/optical/appointment" element={<Appointments />} />
                <Route path="/optical/patient-history" element={<PatientHistory />} />

                {/* Sales Sub-Routes */}
                <Route path="/sales" element={<SalesInvoice />} />
                <Route path="/sales/dashboard" element={<SalesInvoice />} />
                <Route path="/sales/new" element={<SalesInvoice />} />
                <Route path="/sales/pos" element={<SalesInvoice />} />
                <Route path="/sales/orders" element={<SalesInvoice />} />
                <Route path="/sales/customers" element={<SalesInvoice />} />
                <Route path="/sales/payments" element={<SalesInvoice />} />
                <Route path="/sales/reports" element={<SalesInvoice />} />

                {/* Wholesale Sub-Routes */}
                <Route path="/wholesale" element={<WholesaleSales />} />
                <Route path="/wholesale/dashboard" element={<WholesaleSales />} />
                <Route path="/wholesale/new" element={<WholesaleSales />} />
                <Route path="/wholesale/pos" element={<WholesaleSales />} />
                <Route path="/wholesale/dealers" element={<WholesaleSales />} />
                <Route path="/wholesale/customers" element={<WholesaleSales />} />
                <Route path="/wholesale/price-lists" element={<WholesaleSales />} />
                <Route path="/wholesale/quotations" element={<WholesaleSales />} />
                <Route path="/wholesale/orders" element={<WholesaleSales />} />
                <Route path="/wholesale/challans" element={<WholesaleSales />} />
                <Route path="/wholesale/dispatch" element={<WholesaleSales />} />
                <Route path="/wholesale/invoices" element={<WholesaleSales />} />
                <Route path="/wholesale/credit-sales" element={<WholesaleSales />} />
                <Route path="/wholesale/collections" element={<WholesaleSales />} />
                <Route path="/wholesale/returns" element={<WholesaleSales />} />
                <Route path="/wholesale/outstanding" element={<WholesaleSales />} />
                <Route path="/wholesale/reports" element={<WholesaleSales />} />
                <Route path="/wholesale/settings" element={<WholesaleSales />} />

                {/* Inventory Sub-Routes */}
                <Route path="/inventory" element={<Products />} />
                <Route path="/inventory/products" element={<Products />} />
                <Route path="/inventory/categories" element={<Products />} />
                <Route path="/inventory/brands" element={<Products />} />
                <Route path="/inventory/lenses" element={<Products />} />
                <Route path="/inventory/lens" element={<Products />} />

                {/* Purchase Sub-Routes */}
                <Route path="/purchase" element={<Purchases />} />
                <Route path="/purchase/entry" element={<Purchases />} />
                <Route path="/purchase/suppliers" element={<Purchases />} />
                <Route path="/purchase/orders" element={<Purchases />} />
                <Route path="/purchase/receive" element={<Purchases />} />
                <Route path="/purchase/stock-receive" element={<Purchases />} />
                <Route path="/purchase/returns" element={<Purchases />} />

                {/* Accounts Sub-Routes */}
                <Route path="/accounts/receipts" element={<AccountsCOA />} />
                <Route path="/accounts/payments" element={<AccountsCOA />} />
                <Route path="/accounts/expenses" element={<AccountsCOA />} />
                <Route path="/accounts/customer-due" element={<AccountsCOA />} />
                <Route path="/accounts/supplier-due" element={<AccountsCOA />} />

                {/* Financial Sub-Routes */}
                <Route path="/financial" element={<FinancialManagement />} />
                <Route path="/financial/dashboard" element={<FinancialManagement />} />
                <Route path="/financial/chart-of-accounts" element={<FinancialManagement />} />
                <Route path="/financial/vouchers" element={<FinancialManagement />} />
                <Route path="/financial/vouchers/receipt" element={<FinancialManagement />} />
                <Route path="/financial/vouchers/payment" element={<FinancialManagement />} />
                <Route path="/financial/vouchers/contra" element={<FinancialManagement />} />
                <Route path="/financial/vouchers/journal" element={<FinancialManagement />} />
                <Route path="/financial/vouchers/all" element={<FinancialManagement />} />
                <Route path="/financial/journal-entries" element={<FinancialManagement />} />
                <Route path="/financial/ledger" element={<FinancialManagement />} />
                <Route path="/financial/trial-balance" element={<FinancialManagement />} />
                <Route path="/financial/profit-loss" element={<FinancialManagement />} />
                <Route path="/financial/balance-sheet" element={<FinancialManagement />} />
                <Route path="/financial/reports" element={<FinancialManagement />} />



                {/* Administration Sub-Routes */}
                <Route path="/admin" element={<Administration />} />
                <Route path="/admin/users" element={<Administration />} />
                <Route path="/admin/doctors" element={<Administration />} />
                <Route path="/admin/branches" element={<Administration />} />
                <Route path="/admin/excel-import" element={<Administration />} />
                <Route path="/admin/barcode-printing" element={<Administration />} />
                <Route path="/admin/roles" element={<Administration />} />
                <Route path="/admin/permissions" element={<Administration />} />
                <Route path="/admin/audit" element={<Administration />} />

                {/* Reports Sub-Routes (All 22 Enterprise Reports) */}
                <Route path="/reports" element={<Reports />} />
                <Route path="/reports/sales" element={<Reports />} />
                <Route path="/reports/purchase-bills" element={<Reports />} />
                <Route path="/reports/purchase" element={<Reports />} />
                <Route path="/reports/customer" element={<Reports />} />
                <Route path="/reports/stock" element={<Reports />} />
                <Route path="/reports/daily-transaction" element={<Reports />} />
                <Route path="/reports/expense" element={<Reports />} />
                <Route path="/reports/receipt" element={<Reports />} />
                <Route path="/reports/payment" element={<Reports />} />
                <Route path="/reports/payables" element={<Reports />} />
                <Route path="/reports/receivables" element={<Reports />} />
                <Route path="/reports/gst-sales" element={<Reports />} />
                <Route path="/reports/supplier-statement" element={<Reports />} />
                <Route path="/reports/daily-expense" element={<Reports />} />
                <Route path="/reports/bill-wise-profit" element={<Reports />} />
                <Route path="/reports/sale-items-profit" element={<Reports />} />
                <Route path="/reports/eyetest" element={<Reports />} />
                <Route path="/reports/customers-sales" element={<Reports />} />
                <Route path="/reports/day-book" element={<Reports />} />
                <Route path="/reports/damaged-items" element={<Reports />} />
                <Route path="/reports/profit" element={<Reports />} />
                <Route path="/reports/sales-pending" element={<Reports />} />


                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" />} />
              </Routes>
            </Suspense>
          </Box>
        </Box>
      </Box>
    </ThemeProvider>
  );
}

function PlaceholderPage({ title }) {
  return (
    <Box sx={{ p: 4, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '70vh', textAlign: 'center' }}>
      <Typography variant="h4" sx={{ fontWeight: 800, mb: 1 }}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 450 }}>
        This page represents the functional framework for the modular ERP system. Ready for database migrations and API integrations.
      </Typography>
    </Box>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <Router>
        <MainLayout />
      </Router>
    </AuthProvider>
  );
}
