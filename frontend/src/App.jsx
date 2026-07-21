import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { ThemeProvider, CssBaseline, Box, Typography } from '@mui/material';
import { getTheme } from './theme/theme';
import { AuthProvider, useAuth } from './context/AuthContext';
import Sidebar from './components/Sidebar';
import Header from './components/Header';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Products from './pages/Products';
import SalesInvoice from './pages/SalesInvoice';
import AccountsCOA from './pages/AccountsCOA';
import OpticalServices from './pages/OpticalServices';
import Appointments from './pages/Appointments';
import Purchases from './pages/Purchases';
import Administration from './pages/Administration';
import Reports from './pages/Reports';
import Settings from './pages/Settings';

function MainLayout() {
  const { user, loading } = useAuth();
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [themeMode, setThemeMode] = useState('light');

  const theme = getTheme(themeMode);
  const toggleTheme = () => setThemeMode(prev => prev === 'dark' ? 'light' : 'dark');

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
            <Routes>
              <Route path="/" element={<Dashboard />} />
              
              {/* Optical Services Sub-Routes */}
              <Route path="/optical/eyetest" element={<OpticalServices />} />
              <Route path="/optical/prescription" element={<OpticalServices />} />
              <Route path="/optical/pd" element={<OpticalServices />} />
              <Route path="/optical/vision" element={<OpticalServices />} />
              <Route path="/optical/contactlens" element={<OpticalServices />} />
              <Route path="/optical/appointment" element={<Appointments />} />

              {/* Sales Sub-Routes */}
              <Route path="/sales" element={<SalesInvoice />} />
              <Route path="/sales/dashboard" element={<SalesInvoice />} />
              <Route path="/sales/new" element={<SalesInvoice />} />
              <Route path="/sales/pos" element={<SalesInvoice />} />
              <Route path="/sales/orders" element={<SalesInvoice />} />
              <Route path="/sales/customers" element={<SalesInvoice />} />
              <Route path="/sales/payments" element={<SalesInvoice />} />
              <Route path="/sales/reports" element={<SalesInvoice />} />

              {/* Inventory Sub-Routes */}
              <Route path="/inventory/products" element={<Products />} />
              <Route path="/inventory/categories" element={<Products />} />
              <Route path="/inventory/brands" element={<Products />} />

              {/* Purchase Sub-Routes */}
              <Route path="/purchase" element={<Purchases />} />
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



              {/* Administration Sub-Routes */}
              <Route path="/admin" element={<Administration />} />
              <Route path="/admin/users" element={<Administration />} />
              <Route path="/admin/roles" element={<Administration />} />
              <Route path="/admin/permissions" element={<Administration />} />
              <Route path="/admin/audit" element={<Administration />} />

              {/* Reports Sub-Routes */}
              <Route path="/reports" element={<Reports />} />
              <Route path="/reports/sales" element={<Reports />} />
              <Route path="/reports/purchase" element={<Reports />} />
              <Route path="/reports/stock" element={<Reports />} />
              <Route path="/reports/customer" element={<Reports />} />
              <Route path="/reports/profit" element={<Reports />} />
              <Route path="/reports/eyetest" element={<Reports />} />

              <Route path="/settings" element={<Settings />} />
              <Route path="*" element={<Navigate to="/" />} />
            </Routes>
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
