import React, { useState, useEffect } from 'react';
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
  StorefrontOutlined as WholesaleIcon,
  AccountBalanceWalletOutlined as AccountsIcon,
  AccountBalanceOutlined as FinancialIcon,
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
import { useBranch } from '../context/BranchContext';
import GreensolLogo from './GreensolLogo';

const DRAWER_WIDTH = 280;

const menuItems = [
  { text: 'Dashboard', icon: <DashboardIcon />, path: '/', roles: ['*'] },
  {
    text: 'Optical Services',
    icon: <VisibilityIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Eye Test', path: '/optical/eyetest' },
      { text: 'Appointment', path: '/optical/appointment' },
      { text: 'Patient History', path: '/optical/patient-history' }
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
    text: 'Wholesale Distribution',
    icon: <WholesaleIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Wholesale POS', path: '/wholesale/pos' }
    ]
  },
  {
    text: 'Inventory',
    icon: <InventoryIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Products', path: '/inventory/products' },
      { text: 'Categories', path: '/inventory/categories' },
      { text: 'Brands', path: '/inventory/brands' },
      { text: 'Lens Catalog Matrix', path: '/inventory/lenses' },
      { text: 'Stock Transfer', path: '/inventory/stock-transfer', multiBranchOnly: true }
    ]
  },
  {
    text: 'Purchase',
    icon: <PurchaseIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Purchase Entry', path: '/purchase/entry' },
      { text: 'Suppliers', path: '/purchase/suppliers' },
      { text: 'Purchase Orders', path: '/purchase/orders' },
      { text: 'Stock Receive', path: '/purchase/receive' },
      { text: 'Purchase Return', path: '/purchase/returns' }
    ]
  },
  {
    text: 'Financial',
    icon: <FinancialIcon />,
    roles: ['*'],
    subItems: [
      { text: 'Dashboard', path: '/financial/dashboard' },
      { text: 'Chart of Accounts', path: '/financial/chart-of-accounts' },
      { 
        text: 'Vouchers', 
        path: '/financial/vouchers/receipt',
        children: [
          { text: 'Receipt Voucher', path: '/financial/vouchers/receipt' },
          { text: 'Payment Voucher', path: '/financial/vouchers/payment' },
          { text: 'Contra Entry', path: '/financial/vouchers/contra' },
          { text: 'Journal Voucher', path: '/financial/vouchers/journal' },
          { text: 'View All Vouchers', path: '/financial/vouchers/all' }
        ]
      },
      { text: 'General Ledger', path: '/financial/ledger' },
      { text: 'Trial Balance', path: '/financial/trial-balance' },
      { text: 'Profit & Loss', path: '/financial/profit-loss' },
      { text: 'Balance Sheet', path: '/financial/balance-sheet' },
      { text: 'Financial Reports', path: '/financial/reports' }
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
      { text: 'Doctors Master', path: '/admin/doctors' },
      { text: 'Service Master', path: '/admin/service-master' },
      { text: 'Branch Management', path: '/admin/branches', multiBranchOnly: true },
      { text: 'Excel Import Management', path: '/admin/excel-import' },
      { text: 'Barcode Printing', path: '/admin/barcode-printing' },
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
      { text: 'Enterprise Reports Hub', path: '/reports' },
      { text: 'Sales & Revenue Hub', path: '/reports/sales' },
      { text: 'Purchases & Inventory Hub', path: '/reports/purchase' },
      { text: 'Finance & Expenses Hub', path: '/reports/expense' },
      { text: 'Clinical & Operations Hub', path: '/reports/eyetest' }
    ]
  },

  { text: 'Settings', icon: <SettingsIcon />, path: '/settings', roles: ['*'] }
];


export default function Sidebar({ open, toggleSidebar, isMobile = false }) {
  const { user } = useAuth();
  const { multiBranchEnabled } = useBranch();
  const navigate = useNavigate();
  const location = useLocation();
  const [expanded, setExpanded] = useState({});
  const [nestedExpanded, setNestedExpanded] = useState({ Vouchers: true });

  // On mobile the drawer is a full-screen overlay, so a nav click should dismiss it as well as
  // navigate — otherwise the menu would still be covering the page after selecting a route.
  const goTo = (path) => {
    navigate(path);
    if (isMobile) toggleSidebar();
  };

  useEffect(() => {
    menuItems.forEach(item => {
      if (item.subItems && item.subItems.some(sub => {
        if (sub.children) {
          return sub.children.some(child => location.pathname.startsWith(child.path));
        }
        return location.pathname.startsWith(sub.path);
      })) {
        setExpanded(prev => ({ ...prev, [item.text]: true }));
      }
    });

    if (location.pathname.includes('/financial/vouchers')) {
      setNestedExpanded(prev => ({ ...prev, Vouchers: true }));
    }
  }, [location.pathname]);

  const handleToggleNestedExpand = (text) => {
    setNestedExpanded(prev => ({ ...prev, [text]: !prev[text] }));
  };

  const userRole = user?.role || 'SALES_EXECUTIVE';

  const permissions = user?.permissions || {
    optical: true, sales: true, wholesale: true, inventory: true, purchase: true, financial: true, accounts: true, reports: true, admin: true
  };

  const filteredMenu = menuItems
    .map(item => {
      // Drop sub-items flagged multiBranchOnly when Multi-Branch Mode is OFF (spec section 1).
      if (item.subItems && !multiBranchEnabled) {
        return { ...item, subItems: item.subItems.filter(s => !s.multiBranchOnly) };
      }
      return item;
    })
    .filter(item => {
    if (item.text === 'Optical Services' && permissions.optical === false) return false;
    if (item.text === 'Sales' && permissions.sales === false) return false;
    if ((item.text === 'Wholesale' || item.text === 'Wholesale Distribution') && permissions.wholesale === false) return false;
    if (item.text === 'Inventory' && permissions.inventory === false) return false;
    if (item.text === 'Purchase' && permissions.purchase === false) return false;
    if (item.text === 'Financial' && permissions.financial === false) return false;
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
      variant={isMobile ? 'temporary' : 'permanent'}
      open={isMobile ? open : true}
      onClose={toggleSidebar}
      ModalProps={isMobile ? { keepMounted: true } : undefined}
      sx={{
        width: isMobile ? 0 : (open ? DRAWER_WIDTH : 70),
        flexShrink: 0,
        [`& .MuiDrawer-paper`]: {
          width: isMobile ? DRAWER_WIDTH : (open ? DRAWER_WIDTH : 70),
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
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: open ? 'space-between' : 'center', px: 2, py: 1.5, minHeight: 64 }}>
        {open ? (
          <GreensolLogo iconOnly={false} />
        ) : (
          <GreensolLogo iconOnly={true} size="small" />
        )}
        <IconButton onClick={toggleSidebar} sx={{ color: 'text.secondary', ml: open ? 1 : 0 }}>
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
                      goTo(item.path);
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
                  <List component="div" disablePadding sx={{ pl: 2.5 }}>
                    {item.subItems.map((sub) => {
                      const hasChildren = Boolean(sub.children);
                      const isNestedExpanded = Boolean(nestedExpanded[sub.text]);
                      const isSubActive = location.pathname === sub.path || (hasChildren && sub.children.some(c => location.pathname === c.path));

                      return (
                        <React.Fragment key={sub.text}>
                          <ListItemButton
                            onClick={() => {
                              if (hasChildren) {
                                handleToggleNestedExpand(sub.text);
                              } else {
                                goTo(sub.path);
                              }
                            }}
                            sx={{
                              minHeight: 36,
                              borderRadius: 1.5,
                              mb: 0.5,
                              backgroundColor: isSubActive && !hasChildren ? 'action.selected' : 'transparent',
                              color: isSubActive ? 'primary.main' : 'text.secondary',
                              '&:hover': {
                                backgroundColor: 'action.hover',
                                color: 'primary.main',
                              },
                            }}
                          >
                            <ListItemText primary={sub.text} primaryTypographyProps={{ fontSize: '0.82rem', fontWeight: isSubActive ? 700 : 500 }} />
                            {hasChildren && (isNestedExpanded ? <ExpandLess sx={{ fontSize: 16 }} /> : <ExpandMore sx={{ fontSize: 16 }} />)}
                          </ListItemButton>

                          {hasChildren && (
                            <Collapse in={isNestedExpanded} timeout="auto" unmountOnExit>
                              <List component="div" disablePadding sx={{ pl: 2 }}>
                                {sub.children.map((child) => {
                                  const isChildActive = location.pathname === child.path;
                                  return (
                                    <ListItemButton
                                      key={child.text}
                                      onClick={() => goTo(child.path)}
                                      sx={{
                                        minHeight: 34,
                                        borderRadius: 1.5,
                                        mb: 0.5,
                                        backgroundColor: isChildActive ? 'action.selected' : 'transparent',
                                        color: isChildActive ? 'primary.main' : 'text.secondary',
                                        '&:hover': {
                                          backgroundColor: 'action.hover',
                                          color: 'primary.main',
                                        },
                                      }}
                                    >
                                      <ListItemText primary={child.text} primaryTypographyProps={{ fontSize: '0.78rem', fontWeight: isChildActive ? 700 : 500 }} />
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
                </Collapse>
              )}
            </React.Fragment>
          );
        })}
      </List>
    </Drawer>
  );
}
