import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { 
  Box, Drawer, List, ListItem, ListItemButton, 
  ListItemIcon, ListItemText, Typography, Divider, 
  IconButton, Collapse 
} from '@mui/material';
import {
  Dashboard as DashboardIcon,
  Inventory2Outlined as InventoryIcon,
  LocalShippingOutlined as PurchaseIcon,
  ShoppingCartOutlined as SalesIcon,
  AccountBalanceWalletOutlined as AccountsIcon,
  AssessmentOutlined as ReportsIcon,
  AdminPanelSettingsOutlined as AdminIcon,
  SettingsOutlined as SettingsIcon,
  ChevronLeft as ChevronLeftIcon,
  Menu as MenuIcon,
  VisibilityOutlined as VisibilityIcon,
  CalendarMonthOutlined as AppointmentsIcon,
  ExpandLess,
  ExpandMore
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';

const DRAWER_WIDTH = 280;

const menuItems = [
  { text: 'Dashboard', icon: <DashboardIcon />, path: '/', roles: ['*'] },
  {
    text: 'Optical Services',
    icon: <VisibilityIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Eye Test', path: '/optical/eyetest' },
      { text: 'Appointment', path: '/optical/appointment' }
    ]
  },
  {
    text: 'Sales',
    icon: <SalesIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Dashboard', path: '/sales/dashboard' },
      { text: 'New Sale', path: '/sales/new' },
      { text: 'POS Billing', path: '/sales/pos' },
      { text: 'Orders', path: '/sales/orders' },
      { text: 'Customers', path: '/sales/customers' },
      { text: 'Payments', path: '/sales/payments' },
      { text: 'Reports', path: '/sales/reports' }
    ]
  },
  {
    text: 'Inventory',
    icon: <InventoryIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Products', path: '/inventory/products' },
      { text: 'Categories', path: '/inventory/categories' },
      { text: 'Brands', path: '/inventory/brands' }
    ]
  },
  {
    text: 'Purchase',
    icon: <PurchaseIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Suppliers', path: '/purchase/suppliers' },
      { text: 'Purchase Orders', path: '/purchase/orders' },
      { text: 'Stock Receive', path: '/purchase/receive' },
      { text: 'Purchase Return', path: '/purchase/returns' }
    ]
  },
  {
    text: 'Accounts',
    icon: <AccountsIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Receipts', path: '/accounts/receipts' },
      { text: 'Payments', path: '/accounts/payments' },
      { text: 'Expenses', path: '/accounts/expenses' },
      { text: 'Customer Due', path: '/accounts/customer-due' },
      { text: 'Supplier Due', path: '/accounts/supplier-due' }
    ]
  },
  {
    text: 'Administration',
    icon: <AdminIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Users', path: '/admin/users' },
      { text: 'Roles', path: '/admin/roles' },
      { text: 'Permissions', path: '/admin/permissions' },
      { text: 'Audit Logs', path: '/admin/audit' }
    ]
  },
  {
    text: 'Reports',
    icon: <ReportsIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Sales Report', path: '/reports/sales' },
      { text: 'Purchase Report', path: '/reports/purchase' },
      { text: 'Stock Report', path: '/reports/stock' },
      { text: 'Customer Report', path: '/reports/customer' },
      { text: 'Profit Report', path: '/reports/profit' },
      { text: 'Eye Test Report', path: '/reports/eyetest' }
    ]
  },
  { text: 'Settings', icon: <SettingsIcon />, path: '/settings', roles: ['*'] }
];

export default function Sidebar({ open, toggleSidebar }) {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [expanded, setExpanded] = useState({});

  const userRole = user?.role || 'SALES_EXECUTIVE';

  const permissions = user?.permissions || {
    optical: true, sales: true, inventory: true, purchase: true, accounts: true, reports: true, admin: true
  };

  const filteredMenu = menuItems.filter(item => {
    if (item.text === 'Optical Services' && permissions.optical === false) return false;
    if (item.text === 'Sales' && permissions.sales === false) return false;
    if (item.text === 'Inventory' && permissions.inventory === false) return false;
    if (item.text === 'Purchase' && permissions.purchase === false) return false;
    if (item.text === 'Accounts' && permissions.accounts === false) return false;
    if (item.text === 'Administration' && permissions.admin === false) return false;
    if (item.text === 'Reports' && permissions.reports === false) return false;
    return item.roles.includes('*') || item.roles.includes(userRole);
  });

  const handleToggleExpand = (text) => {
    setExpanded(prev => ({ ...prev, [text]: !prev[text] }));
  };

  return (
    <Drawer
      variant="permanent"
      sx={{
        width: open ? DRAWER_WIDTH : 70,
        flexShrink: 0,
        [`& .MuiDrawer-paper`]: { 
          width: open ? DRAWER_WIDTH : 70, 
          boxSizing: 'border-box',
          borderRight: '1px solid',
          borderColor: 'divider',
          backgroundColor: 'background.sidebar',
          color: 'text.primary',
          transition: 'width 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
          overflowX: 'hidden'
        },
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', p: 2, minHeight: 64 }}>
        {open && (
          <Typography variant="h5" sx={{ fontWeight: 800, letterSpacing: '0.05em', color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1 }}>
            <span style={{ fontSize: '1.4rem' }}>⚡</span> VisionERP
          </Typography>
        )}
        <IconButton onClick={toggleSidebar} sx={{ color: 'text.secondary', mx: 'auto' }}>
          {open ? <ChevronLeftIcon /> : <MenuIcon />}
        </IconButton>
      </Box>
      
      <Divider sx={{ borderColor: 'divider' }} />

      <List sx={{ px: 1.5, py: 2, overflowY: 'auto', '&::-webkit-scrollbar': { width: '4px' } }}>
        {filteredMenu.map((item) => {
          const hasSubItems = Boolean(item.subItems);
          const isExpanded = Boolean(expanded[item.text]);
          const isActive = location.pathname === item.path || (hasSubItems && item.subItems.some(sub => location.pathname === sub.path));

          return (
            <React.Fragment key={item.text}>
              <ListItem disablePadding sx={{ display: 'block', mb: 0.5 }}>
                <ListItemButton
                  onClick={() => {
                    if (hasSubItems) {
                      handleToggleExpand(item.text);
                    } else {
                      navigate(item.path);
                    }
                  }}
                  sx={{
                    minHeight: 44,
                    justifyContent: open ? 'initial' : 'center',
                    px: 2,
                    borderRadius: 2,
                    backgroundColor: isActive ? 'action.selected' : 'transparent',
                    color: isActive ? 'primary.main' : 'text.secondary',
                    '&:hover': {
                      backgroundColor: 'action.hover',
                      color: 'primary.main',
                      '& .MuiListItemIcon-root': { color: 'primary.main' }
                    },
                  }}
                >
                  <ListItemIcon
                    sx={{
                      minWidth: 0,
                      mr: open ? 2 : 'auto',
                      justifyContent: 'center',
                      color: isActive ? 'primary.main' : 'text.secondary',
                    }}
                  >
                    {item.icon}
                  </ListItemIcon>
                  {open && <ListItemText primary={item.text} primaryTypographyProps={{ fontSize: '0.875rem', fontWeight: isActive ? 600 : 500 }} />}
                  {open && hasSubItems && (isExpanded ? <ExpandLess sx={{ fontSize: 18 }} /> : <ExpandMore sx={{ fontSize: 18 }} />)}
                </ListItemButton>
              </ListItem>

              {hasSubItems && open && (
                <Collapse in={isExpanded} timeout="auto" unmountOnExit>
                  <List component="div" disablePadding sx={{ pl: 3 }}>
                    {item.subItems.map((sub) => {
                      const isSubActive = location.pathname === sub.path;
                      return (
                        <ListItemButton
                          key={sub.text}
                          onClick={() => navigate(sub.path)}
                          sx={{
                            minHeight: 36,
                            borderRadius: 1.5,
                            mb: 0.5,
                            backgroundColor: isSubActive ? 'action.selected' : 'transparent',
                            color: isSubActive ? 'primary.main' : 'text.secondary',
                            '&:hover': {
                              backgroundColor: 'action.hover',
                              color: 'primary.main',
                            },
                          }}
                        >
                          <ListItemText primary={sub.text} primaryTypographyProps={{ fontSize: '0.8rem', fontWeight: isSubActive ? 600 : 500 }} />
                        </ListItemButton>
                      );
                    })}
                  </List>
                </Collapse>
              )}
            </React.Fragment>
          );
        })}
      </List>
    </Drawer>
  );
}
