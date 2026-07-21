import React, { useState, useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Box, Card, CardContent, Typography, Button, Tab, Tabs, 
  Grid, Table, TableBody, TableCell, TableContainer, 
  TableHead, TableRow, Paper, Chip, Dialog, 
  DialogTitle, DialogContent, DialogActions, TextField, 
  MenuItem, Stack, IconButton, Switch, FormControlLabel, Checkbox, Divider, Alert
} from '@mui/material';
import {
  Add as AddIcon,
  Search as SearchIcon,
  AdminPanelSettings as AdminIcon,
  People as UsersIcon,
  Security as SecurityIcon,
  History as AuditIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  Key as KeyIcon,
  CheckCircle as SuccessIcon,
  Visibility as VisibilityIcon
} from '@mui/icons-material';
import axios from 'axios';

// Default initial users database
const defaultUsersList = [
  {
    id: 'EMP-101',
    name: 'Greensol Admin',
    email: 'admin@greensol.com',
    phone: '+91 9876543210',
    role: 'SUPER_ADMIN',
    roleDisplay: 'Super Admin',
    status: 'Active',
    permissions: {
      optical: true,
      sales: true,
      inventory: true,
      purchase: true,
      accounts: true,
      reports: true,
      admin: true
    }
  }
];

export default function Administration() {
  const location = useLocation();
  const navigate = useNavigate();

  // Tab sync from path
  const getTabFromPath = (pathname) => {
    if (pathname.includes('/admin/roles')) return 'roles';
    if (pathname.includes('/admin/permissions')) return 'permissions';
    if (pathname.includes('/admin/audit')) return 'audit';
    return 'users';
  };

  const [activeTab, setActiveTab] = useState(getTabFromPath(location.pathname));

  useEffect(() => {
    setActiveTab(getTabFromPath(location.pathname));
  }, [location.pathname]);

  const handleTabChange = (event, newValue) => {
    setActiveTab(newValue);
    if (newValue === 'users') navigate('/admin/users');
    if (newValue === 'roles') navigate('/admin/roles');
    if (newValue === 'permissions') navigate('/admin/permissions');
    if (newValue === 'audit') navigate('/admin/audit');
  };

  // State
  const [users, setUsers] = useState(() => {
    try {
      const saved = localStorage.getItem('optical_users_db');
      return saved ? JSON.parse(saved) : defaultUsersList;
    } catch (e) {
      return defaultUsersList;
    }
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [editPermissionsUser, setEditPermissionsUser] = useState(null);

  // Form Inputs for Adding User
  const [userInput, setUserInput] = useState({
    id: `EMP-${Math.floor(100 + Math.random() * 900)}`,
    name: '',
    email: '',
    phone: '',
    password: '',
    roleDisplay: 'Optometrist',
    status: 'Active',
    permissions: {
      optical: true,
      sales: true,
      inventory: false,
      purchase: false,
      accounts: false,
      reports: true,
      admin: false
    }
  });

  // Save users to localStorage whenever updated
  useEffect(() => {
    try {
      localStorage.setItem('optical_users_db', JSON.stringify(users));
    } catch (e) {}
  }, [users]);

  // Handler to Save New User
  const handleSaveUser = async () => {
    if (!userInput.name || !userInput.email || !userInput.password) {
      alert("Please fill in User Name, Email, and Password.");
      return;
    }

    const newUserObj = {
      id: userInput.id || `EMP-${Math.floor(100 + Math.random() * 900)}`,
      name: userInput.name,
      username: userInput.email.split('@')[0],
      email: userInput.email,
      phone: userInput.phone || 'N/A',
      password: userInput.password,
      role: userInput.roleDisplay.toUpperCase().replace(/\s+/g, '_'),
      roleDisplay: userInput.roleDisplay,
      status: 'Active',
      permissions: { ...userInput.permissions }
    };

    setUsers([newUserObj, ...users]);

    // POST to backend API
    try {
      await axios.post('/api/auth/users/', {
        username: newUserObj.username,
        email: newUserObj.email,
        password: newUserObj.password,
        first_name: newUserObj.name,
        role: newUserObj.role,
        permissions: newUserObj.permissions
      });
    } catch (e) {}

    // Reset Form
    setUserInput({
      id: `EMP-${Math.floor(100 + Math.random() * 900)}`,
      name: '', email: '', phone: '', password: '', roleDisplay: 'Optometrist', status: 'Active',
      permissions: { optical: true, sales: true, inventory: false, purchase: false, accounts: false, reports: true, admin: false }
    });

    setAddUserOpen(false);
    alert(`User '${newUserObj.name}' (${newUserObj.email}) created successfully!`);
  };

  // Handler to Delete User
  const handleDeleteUser = (userId) => {
    if (confirm("Are you sure you want to delete this user account?")) {
      setUsers(users.filter(u => u.id !== userId));
    }
  };

  // Handler to Update Permissions
  const handleUpdatePermissions = () => {
    if (!editPermissionsUser) return;
    setUsers(users.map(u => u.id === editPermissionsUser.id ? editPermissionsUser : u));
    setEditPermissionsUser(null);
    alert(`Access permissions updated for '${editPermissionsUser.name}'!`);
  };

  // Audit Logs Data
  const auditLogs = [
    { id: 'LOG-901', user: 'Greensol Admin', action: 'User Created', target: 'Dr. Sarah Miller', time: 'Just now' },
    { id: 'LOG-902', user: 'Greensol Admin', action: 'Permissions Modified', target: 'John Sales Exec', time: '1 hour ago' },
    { id: 'LOG-903', user: 'System', action: 'Successful Login', target: 'admin@greensol.com', time: '2 hours ago' }
  ];

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Top Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" fontWeight={800}>User Access & Administration</Typography>
          <Typography variant="body2" color="text.secondary">Create staff user accounts, configure email credentials, passwords, and module access permissions</Typography>
        </Box>
        <Stack direction="row" spacing={1.5}>
          {activeTab === 'users' && (
            <Button 
              variant="contained" 
              startIcon={<AddIcon />} 
              onClick={() => setAddUserOpen(true)} 
              sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}
            >
              + Add New User
            </Button>
          )}
        </Stack>
      </Box>

      {/* Navigation Tabs */}
      <Card sx={{ mb: 3, borderRadius: 3 }}>
        <Tabs value={activeTab} onChange={handleTabChange} sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="users" label="User Accounts Directory" icon={<UsersIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="roles" label="System Roles & Titles" icon={<AdminIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="permissions" label="Module Access Matrix" icon={<SecurityIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="audit" label="Security Audit Logs" icon={<AuditIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
        </Tabs>
      </Card>

      {/* 1. USERS TAB */}
      {activeTab === 'users' && (() => {
        const filteredUsers = users.filter(u => {
          const query = searchQuery.toLowerCase();
          return (u.name && u.name.toLowerCase().includes(query)) ||
                 (u.email && u.email.toLowerCase().includes(query)) ||
                 (u.id && u.id.toLowerCase().includes(query)) ||
                 (u.roleDisplay && u.roleDisplay.toLowerCase().includes(query));
        });

        return (
          <Stack spacing={3}>
            {/* KPI Cards */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL USERS</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary">{users.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Registered system accounts</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>ACTIVE STAFF</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">
                    {users.filter(u => u.status === 'Active').length}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Enabled system users</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>ADMINISTRATORS</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>
                    {users.filter(u => u.role === 'SUPER_ADMIN' || u.roleDisplay === 'Super Admin').length}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Full system access</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={700}>CLINICAL & SALES STAFF</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>
                    {users.filter(u => u.role !== 'SUPER_ADMIN' && u.roleDisplay !== 'Super Admin').length}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Restricted module users</Typography>
                </Paper>
              </Grid>
            </Grid>

            {/* Toolbar */}
            <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
              <TextField 
                fullWidth 
                size="small" 
                placeholder="Search User Name, User ID, Email Address, or Role Title..."
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
                      <TableCell sx={{ fontWeight: 700 }}>User ID</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Full Name & Role</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Email Address & Phone</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Allowed Module Permissions</TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 700 }}>Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredUsers.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={6} align="center" sx={{ py: 8 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={500}>
                            No matching user accounts found.
                          </Typography>
                          <Button 
                            size="small" 
                            variant="contained" 
                            startIcon={<AddIcon />} 
                            onClick={() => setAddUserOpen(true)} 
                            sx={{ backgroundColor: '#2563EB', mt: 2 }}
                          >
                            + Add New User
                          </Button>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredUsers.map(u => (
                        <TableRow key={u.id} hover>
                          <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{u.id}</TableCell>
                          <TableCell sx={{ fontWeight: 600 }}>
                            {u.name}
                            <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                              Role: <strong>{u.roleDisplay || 'User'}</strong>
                            </Typography>
                          </TableCell>
                          <TableCell>
                            <Typography variant="body2">{u.email}</Typography>
                            <Typography variant="caption" color="text.secondary">{u.phone || 'N/A'}</Typography>
                          </TableCell>
                          <TableCell>
                            <Stack direction="row" spacing={0.5} flexWrap="wrap" gap={0.5}>
                              {u.permissions?.optical && <Chip label="Optical" size="small" color="primary" variant="outlined" />}
                              {u.permissions?.sales && <Chip label="Sales" size="small" color="success" variant="outlined" />}
                              {u.permissions?.inventory && <Chip label="Inventory" size="small" color="warning" variant="outlined" />}
                              {u.permissions?.purchase && <Chip label="Purchase" size="small" color="secondary" variant="outlined" />}
                              {u.permissions?.accounts && <Chip label="Accounts" size="small" color="info" variant="outlined" />}
                              {u.permissions?.reports && <Chip label="Reports" size="small" variant="outlined" />}
                              {u.permissions?.admin && <Chip label="Admin" size="small" color="error" variant="outlined" />}
                            </Stack>
                          </TableCell>
                          <TableCell>
                            <Chip label={u.status} color="success" size="small" sx={{ fontWeight: 700 }} />
                          </TableCell>
                          <TableCell align="right">
                            <Stack direction="row" spacing={1} justifyContent="flex-end">
                              <Button 
                                size="small" 
                                variant="outlined" 
                                startIcon={<SecurityIcon fontSize="small" />}
                                onClick={() => setEditPermissionsUser({ ...u })}
                              >
                                Access
                              </Button>
                              {u.role !== 'SUPER_ADMIN' && (
                                <IconButton size="small" color="error" onClick={() => handleDeleteUser(u.id)}>
                                  <DeleteIcon fontSize="small" />
                                </IconButton>
                              )}
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

      {/* 2. ROLES TAB */}
      {activeTab === 'roles' && (
        <Grid container spacing={3}>
          {[
            { title: 'Super Admin', desc: 'Full access to all system modules, user creation, and financial reports.', color: '#ef4444', count: 1 },
            { title: 'Optometrist', desc: 'Access to Optical Services, Eye Testing, PD Measurements, and Clinical Examinations.', color: '#2563eb', count: 2 },
            { title: 'Sales Associate', desc: 'Access to POS Billing, Spectacle Orders, Customer Profiles, and Sales Receipts.', color: '#10b981', count: 3 },
            { title: 'Inventory Manager', desc: 'Access to Optical Stock Catalog, Barcode Labels, Categories, and Rack Locations.', color: '#f59e0b', count: 1 },
            { title: 'Accountant', desc: 'Access to Accounts Ledger, Customer Dues, Supplier Payables, and Clinic Expenses.', color: '#8b5cf6', count: 1 }
          ].map(r => (
            <Grid item xs={12} sm={6} md={4} key={r.title}>
              <Card variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: `4px solid ${r.color}` }}>
                <Typography variant="h6" fontWeight={800}>{r.title}</Typography>
                <Typography variant="body2" color="text.secondary" sx={{ my: 1, minHeight: 40 }}>{r.desc}</Typography>
                <Chip label={`${r.count} Assigned Users`} size="small" variant="outlined" sx={{ fontWeight: 700 }} />
              </Card>
            </Grid>
          ))}
        </Grid>
      )}

      {/* 3. PERMISSIONS MATRIX TAB */}
      {activeTab === 'permissions' && (
        <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <TableContainer>
            <Table size="small">
              <TableHead sx={{ backgroundColor: 'action.hover' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>User / Role</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>Optical Services</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>Sales & POS</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>Inventory</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>Purchasing</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>Accounts</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>Reports</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 700 }}>Admin</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {users.map(u => (
                  <TableRow key={u.id} hover>
                    <TableCell sx={{ fontWeight: 600 }}>
                      {u.name}
                      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{u.roleDisplay}</Typography>
                    </TableCell>
                    {['optical', 'sales', 'inventory', 'purchase', 'accounts', 'reports', 'admin'].map(mod => (
                      <TableCell key={mod} align="center">
                        <Checkbox checked={!!u.permissions?.[mod]} disabled color="primary" />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}

      {/* 4. AUDIT LOGS TAB */}
      {activeTab === 'audit' && (
        <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <TableContainer>
            <Table size="small">
              <TableHead sx={{ backgroundColor: 'action.hover' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>Log ID</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>User</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Action Performed</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Target Entity</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>Timestamp</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {auditLogs.map(a => (
                  <TableRow key={a.id} hover>
                    <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{a.id}</TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{a.user}</TableCell>
                    <TableCell><Chip label={a.action} size="small" color="info" variant="outlined" /></TableCell>
                    <TableCell>{a.target}</TableCell>
                    <TableCell>{a.time}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}

      {/* --- DIALOG: ADD NEW USER WITH CREDENTIALS & PERMISSIONS --- */}
      <Dialog 
        open={addUserOpen} 
        onClose={() => setAddUserOpen(false)} 
        maxWidth="md" 
        fullWidth 
        PaperProps={{ sx: { borderRadius: 4 } }}
      >
        <DialogTitle sx={{ fontWeight: 800 }}>Create New User Account & Set Access Permissions</DialogTitle>
        <DialogContent dividers>
          <Alert severity="info" sx={{ mb: 3, borderRadius: 2 }}>
            Provide user credentials (<strong>Email & Password</strong>) and toggle <strong>Module Access Permissions</strong> to control which pages this user can view.
          </Alert>

          <Grid container spacing={2}>
            <Grid item xs={12} sm={4}>
              <TextField 
                label="User ID / Employee Code" 
                fullWidth 
                value={userInput.id}
                onChange={(e) => setUserInput({ ...userInput, id: e.target.value })}
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField 
                label="Full Name" 
                fullWidth 
                required
                placeholder="e.g. Dr. Sarah Miller"
                value={userInput.name}
                onChange={(e) => setUserInput({ ...userInput, name: e.target.value })}
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField 
                select 
                label="Role Title" 
                fullWidth 
                value={userInput.roleDisplay}
                onChange={(e) => setUserInput({ ...userInput, roleDisplay: e.target.value })}
              >
                <MenuItem value="Super Admin">Super Admin</MenuItem>
                <MenuItem value="Optometrist">Optometrist</MenuItem>
                <MenuItem value="Sales Executive">Sales Executive</MenuItem>
                <MenuItem value="Inventory Manager">Inventory Manager</MenuItem>
                <MenuItem value="Accountant">Accountant</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField 
                label="User Email Address (Login Username)" 
                fullWidth 
                required
                type="email"
                placeholder="e.g. sarah@gopticals.com"
                value={userInput.email}
                onChange={(e) => setUserInput({ ...userInput, email: e.target.value })}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField 
                label="User Password" 
                fullWidth 
                required
                type="password"
                placeholder="Set secure password"
                value={userInput.password}
                onChange={(e) => setUserInput({ ...userInput, password: e.target.value })}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField 
                label="Phone Number" 
                fullWidth 
                placeholder="e.g. +91 9876543210"
                value={userInput.phone}
                onChange={(e) => setUserInput({ ...userInput, phone: e.target.value })}
              />
            </Grid>
          </Grid>

          <Divider sx={{ my: 3 }} />

          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>
            🔒 Module Access Permissions for {userInput.name || 'User'}
          </Typography>

          <Grid container spacing={2}>
            {[
              { key: 'optical', label: '👁️ Optical Services (Eye Test, Rx, Appointments)', color: '#2563eb' },
              { key: 'sales', label: '🛒 Sales & POS Billing (Invoices, Customers, Orders)', color: '#10b981' },
              { key: 'inventory', label: '📦 Inventory & Stock (Products, Categories, Brands)', color: '#f59e0b' },
              { key: 'purchase', label: '🚚 Purchasing & Suppliers (Orders, GRN, Returns)', color: '#8b5cf6' },
              { key: 'accounts', label: '💰 Accounts & Financial Ledger (Receipts, Dues, Expenses)', color: '#06b6d4' },
              { key: 'reports', label: '📊 Sales & Optical Reports Suite', color: '#ec4899' },
              { key: 'admin', label: '⚙️ Administration & User Access Management', color: '#ef4444' }
            ].map(m => (
              <Grid item xs={12} sm={6} key={m.key}>
                <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography variant="body2" fontWeight={600}>{m.label}</Typography>
                  <Switch 
                    checked={!!userInput.permissions[m.key]}
                    onChange={(e) => setUserInput({
                      ...userInput,
                      permissions: { ...userInput.permissions, [m.key]: e.target.checked }
                    })}
                    color="primary"
                  />
                </Paper>
              </Grid>
            ))}
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setAddUserOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveUser} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            Save User Account & Grant Access
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- DIALOG: EDIT MODULE ACCESS PERMISSIONS --- */}
      <Dialog 
        open={Boolean(editPermissionsUser)} 
        onClose={() => setEditPermissionsUser(null)} 
        maxWidth="sm" 
        fullWidth 
        PaperProps={{ sx: { borderRadius: 4 } }}
      >
        <DialogTitle sx={{ fontWeight: 800 }}>
          Manage Access Permissions: {editPermissionsUser?.name}
        </DialogTitle>
        <DialogContent dividers>
          {editPermissionsUser && (
            <Stack spacing={2}>
              <Typography variant="body2" color="text.secondary">
                Toggle module permissions to control which pages <strong>{editPermissionsUser.email}</strong> can view:
              </Typography>

              {[
                { key: 'optical', label: '👁️ Optical Services' },
                { key: 'sales', label: '🛒 Sales & POS Billing' },
                { key: 'inventory', label: '📦 Inventory & Stock' },
                { key: 'purchase', label: '🚚 Purchasing & Suppliers' },
                { key: 'accounts', label: '💰 Accounts & Financial Ledger' },
                { key: 'reports', label: '📊 Sales & Optical Reports' },
                { key: 'admin', label: '⚙️ Administration' }
              ].map(m => (
                <Paper key={m.key} variant="outlined" sx={{ p: 1.5, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <Typography variant="body2" fontWeight={600}>{m.label}</Typography>
                  <Switch 
                    checked={!!editPermissionsUser.permissions?.[m.key]}
                    onChange={(e) => setEditPermissionsUser({
                      ...editPermissionsUser,
                      permissions: { ...editPermissionsUser.permissions, [m.key]: e.target.checked }
                    })}
                    color="primary"
                  />
                </Paper>
              ))}
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setEditPermissionsUser(null)}>Cancel</Button>
          <Button variant="contained" onClick={handleUpdatePermissions} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            Save Updated Permissions
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
