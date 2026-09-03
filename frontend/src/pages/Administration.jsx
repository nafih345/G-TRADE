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
  Visibility as VisibilityIcon,
  MedicalServices as DoctorIcon,
  LocalHospital as HospitalIcon,
  CloudUpload as ImportIcon,
  Store as BranchIcon,
  QrCode as BarcodeIcon,
  Star as StarIcon,
  StarBorder as StarBorderIcon,
  GroupAdd as GroupAddIcon,
  ToggleOn as ToggleOnIcon,
  ToggleOff as ToggleOffIcon,
  Build as ServiceIcon
} from '@mui/icons-material';
import axios from 'axios';
import { useBranch } from '../context/BranchContext';
import ExcelImportManager from '../components/admin/import/ExcelImportManager';
import BarcodePrintingManager from '../components/admin/BarcodePrintingManager';
import ServiceMasterDialog from '../components/sales/ServiceMasterDialog';

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
    permissions: { optical: true, sales: true, wholesale: true, inventory: true, purchase: true, financial: true, accounts: true, reports: true, admin: true }
  }
];

export default function Administration() {
  const location = useLocation();
  const navigate = useNavigate();
  const { multiBranchEnabled, refresh: refreshBranchContext } = useBranch();

  // Tab sync from path
  const getTabFromPath = (pathname) => {
    if (pathname.includes('/admin/excel-import') || pathname.includes('/admin/import')) return 'excel-import';
    if (pathname.includes('/admin/barcode-printing')) return 'barcode-printing';
    if (pathname.includes('/admin/doctors')) return 'doctors';
    if (pathname.includes('/admin/service-master')) return 'service-master';
    if (pathname.includes('/admin/branches')) return 'branches';
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
    if (newValue === 'doctors') navigate('/admin/doctors');
    if (newValue === 'service-master') navigate('/admin/service-master');
    if (newValue === 'branches') navigate('/admin/branches');
    if (newValue === 'excel-import') navigate('/admin/excel-import');
    if (newValue === 'barcode-printing') navigate('/admin/barcode-printing');
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

  // Doctor / Optometrist Master Database State
  const [doctors, setDoctors] = useState(() => {
    try {
      const saved = localStorage.getItem('optical_doctors_db');
      return saved ? JSON.parse(saved) : [];
    } catch (e) {
      return [];
    }
  });

  // Helper to sanitize dummy data from local storage
  const sanitizeBranch = (b) => ({
    ...b,
    code: b.code === 'BR-101' ? 'MAIN' : b.code,
    manager: (b.manager === 'Dr. Ananya Roy' || b.manager === 'Branch Manager') ? '—' : b.manager,
    phone: (b.phone === '+91 98450 12345' || b.phone === 'N/A') ? '—' : b.phone,
    email: (b.email === 'mainbranch@gopticals.com' || b.email === 'N/A') ? '—' : b.email,
    gstin: (b.gstin === '29AAAAA0000A1Z5' || b.gstin === 'N/A') ? '—' : b.gstin,
    address: (b.address && b.address.includes('Indiranagar')) ? '—' : b.address
  });

  // Branch Management State (Clean blank default until user enters branch details)
  const [branches, setBranches] = useState(() => {
    try {
      const saved = localStorage.getItem('optical_branches');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map(sanitizeBranch);
        }
      }
    } catch (e) {}

    return [
      {
        id: 'main',
        code: 'MAIN',
        name: 'Main Branch',
        phone: '—',
        email: '—',
        manager: '—',
        address: '—',
        gstin: '—',
        status: 'Active',
        createdDate: new Date().toISOString().split('T')[0]
      }
    ];
  });

  // Branch Management uses the backend as the source of truth (spec sections 2, 3, 8).
  const mapApiBranch = (b) => ({
    id: b.id,
    code: b.code || '—',
    name: b.name || '—',
    phone: b.phone || '—',
    email: b.email || '—',
    manager: b.manager || '—',
    address: b.address || '—',
    gstin: b.gstin || '—',
    city: b.city || '',
    state: b.state || '',
    country: b.country || '',
    pinCode: b.pin_code || '',
    isDefault: !!b.is_default,
    isActive: b.is_active !== false,
    status: b.is_active !== false ? 'Active' : 'Inactive',
    createdDate: (b.created_at || '').split('T')[0] || new Date().toISOString().split('T')[0]
  });

  const refetchBranches = async () => {
    try {
      const res = await axios.get('/api/company/branches/');
      const rows = Array.isArray(res.data) ? res.data : (res.data?.results || []);
      if (rows.length > 0) setBranches(rows.map(mapApiBranch));
    } catch (e) {}
  };

  const [branchAccessList, setBranchAccessList] = useState([]);
  const refetchBranchAccess = async () => {
    try {
      const res = await axios.get('/api/company/user-branch-access/');
      const rows = Array.isArray(res.data) ? res.data : (res.data?.results || []);
      setBranchAccessList(rows);
    } catch (e) {}
  };

  useEffect(() => {
    refetchBranches();
    refetchBranchAccess();
  }, []);

  // ---- Service Master (backend is the source of truth: /api/sales/services/) ----
  // Uses the shared ServiceMasterDialog — the same Add / Edit form the New Sale page uses inline.
  const [servicesList, setServicesList] = useState([]);
  const [serviceDialogOpen, setServiceDialogOpen] = useState(false);
  const [editingService, setEditingService] = useState(null);

  const mapApiService = (s) => ({
    id: s.id,
    code: s.service_code || '—',
    name: s.name || '—',
    description: s.description || '',
    price: parseFloat(s.default_price || 0),
    defaultPrice: parseFloat(s.default_price || 0),
    taxRate: parseFloat(s.tax_percentage || 0),
    taxPercentage: parseFloat(s.tax_percentage || 0),
    isActive: s.is_active !== false
  });

  const refetchServices = async () => {
    try {
      const res = await axios.get('/api/sales/services/');
      const rows = Array.isArray(res.data) ? res.data : (res.data?.results || []);
      setServicesList(rows.map(mapApiService));
    } catch (e) {}
  };

  useEffect(() => { refetchServices(); }, []);

  const openServiceDialog = (existing) => {
    setEditingService(existing || null);
    setServiceDialogOpen(true);
  };

  const handleDeleteService = async (svc) => {
    if (!window.confirm(`Delete service '${svc.name}'? Past invoices keep their service line history.`)) return;
    try {
      await axios.delete(`/api/sales/services/${svc.id}/`);
    } catch (e) {
      alert(`Could not delete: ${e?.response?.data?.detail || e.message}`);
      return;
    }
    await refetchServices();
  };

  const handleToggleServiceActive = async (svc) => {
    const next = !svc.isActive;
    // Optimistic flip so the ON/OFF switch responds instantly; reconciled by refetch below.
    setServicesList(prev => prev.map(x => (x.id === svc.id ? { ...x, isActive: next } : x)));
    try {
      await axios.patch(`/api/sales/services/${svc.id}/`, { is_active: next });
    } catch (e) {
      alert(`Could not update status: ${e?.response?.data?.detail || e.message}`);
    }
    await refetchServices();
  };



  const [searchQuery, setSearchQuery] = useState('');
  const [addUserOpen, setAddUserOpen] = useState(false);
  const [addDoctorOpen, setAddDoctorOpen] = useState(false);
  const [addBranchOpen, setAddBranchOpen] = useState(false);
  const [editPermissionsUser, setEditPermissionsUser] = useState(null);

  // Form Inputs for Adding Doctor
  const [doctorInput, setDoctorInput] = useState({
    id: `DOC-${Math.floor(100 + Math.random() * 900)}`,
    name: '',
    qualification: 'B.Optom, M.Optom',
    licenseNo: '',
    phone: '',
    email: '',
    branch: 'Main Branch',
    consultationFee: '500',
    status: 'Active'
  });

  // Form Inputs for Adding Branch
  const emptyBranchInput = () => ({
    code: `BR-${Math.floor(100 + Math.random() * 900)}`,
    name: '',
    phone: '',
    email: '',
    manager: '',
    address: '',
    gstin: '',
    city: '',
    state: '',
    country: '',
    pinCode: '',
    status: 'Active'
  });
  const [branchInput, setBranchInput] = useState(emptyBranchInput);

  // Assign-Users-to-Branches dialog state
  const [assignAccessOpen, setAssignAccessOpen] = useState(false);
  const [accessInput, setAccessInput] = useState({ username: '', access_all_branches: false, branches: [], default_branch: '' });


  // Save doctors to localStorage & broadcast event
  useEffect(() => {
    try {
      localStorage.setItem('optical_doctors_db', JSON.stringify(doctors));
      window.dispatchEvent(new Event('optical_doctors_updated'));
    } catch (e) {}
  }, [doctors]);

  // Save branches to localStorage & broadcast event so Header Branch selector updates live
  useEffect(() => {
    try {
      localStorage.setItem('optical_branches', JSON.stringify(branches));
      window.dispatchEvent(new Event('optical_branches_updated'));
    } catch (e) {}
  }, [branches]);

  // Handler to Save New Doctor
  const handleSaveDoctor = async () => {
    if (!doctorInput.name) {
      alert("Please enter Doctor / Optometrist Name.");
      return;
    }

    const docNameClean = doctorInput.name.trim();
    const formattedName = docNameClean.startsWith('Dr.') || docNameClean.startsWith('Dr ') ? docNameClean : `Dr. ${docNameClean}`;

    const newDocObj = {
      id: doctorInput.id || `DOC-${Math.floor(100 + Math.random() * 900)}`,
      name: formattedName,
      qualification: doctorInput.qualification || 'Optometrist',
      licenseNo: doctorInput.licenseNo || 'N/A',
      phone: doctorInput.phone || 'N/A',
      email: doctorInput.email || 'N/A',
      branch: doctorInput.branch || 'Main Branch',
      consultationFee: doctorInput.consultationFee || '500',
      status: doctorInput.status || 'Active'
    };

    const updatedDoctors = [newDocObj, ...doctors];
    setDoctors(updatedDoctors);

    // Also register doctor into staff users list if not present
    const isUserExist = users.some(u => u.name === formattedName || u.email === newDocObj.email);
    if (!isUserExist) {
      const newDoctorUser = {
        id: `EMP-${Math.floor(200 + Math.random() * 800)}`,
        name: formattedName,
        username: (newDocObj.email && newDocObj.email !== 'N/A') ? newDocObj.email.split('@')[0] : formattedName.toLowerCase().replace(/[^a-z0-9]/g, ''),
        email: (newDocObj.email && newDocObj.email !== 'N/A') ? newDocObj.email : `${formattedName.toLowerCase().replace(/[^a-z0-9]/g, '')}@gopticals.com`,
        phone: newDocObj.phone,
        role: 'OPTOMETRIST',
        roleDisplay: 'Optometrist Doctor',
        status: 'Active',
        permissions: { optical: true, sales: true, inventory: false, purchase: false, accounts: false, reports: true, admin: false }
      };
      setUsers(prev => [newDoctorUser, ...prev]);
    }

    setAddDoctorOpen(false);
    setDoctorInput({
      id: `DOC-${Math.floor(100 + Math.random() * 900)}`,
      name: '',
      qualification: 'B.Optom, M.Optom',
      licenseNo: '',
      phone: '',
      email: '',
      branch: 'Main Branch',
      consultationFee: '500',
      status: 'Active'
    });

    alert(`Doctor '${formattedName}' successfully registered in system database!`);
  };

  // Handler to Save New Branch — backend is the source of truth
  const handleSaveBranch = async () => {
    if (!branchInput.name || !branchInput.code) {
      alert("Please enter Branch Name and Branch Code.");
      return;
    }
    try {
      await axios.post('/api/company/branches/', {
        code: branchInput.code.toUpperCase(),
        name: branchInput.name.trim(),
        phone: branchInput.phone || null,
        email: branchInput.email || null,
        address: branchInput.address || null,
        gstin: branchInput.gstin || null,
        city: branchInput.city || null,
        state: branchInput.state || null,
        country: branchInput.country || null,
        pin_code: branchInput.pinCode || null,
        is_active: branchInput.status !== 'Inactive'
      });
    } catch (e) {
      alert(`Could not save branch: ${e?.response?.data?.code || e?.response?.data?.detail || e.message}`);
      return;
    }
    await refetchBranches();
    await refreshBranchContext();
    setAddBranchOpen(false);
    setBranchInput(emptyBranchInput());
    alert(`Branch '${branchInput.name.trim()}' added. It is now available in the header branch switcher.`);
  };

  const handleDeleteBranch = async (branch) => {
    if (branch.isDefault) {
      alert("The default branch cannot be deleted. Set another branch as default first.");
      return;
    }
    if (!window.confirm(`Delete branch '${branch.name}'? Existing transactions keep their branch history.`)) return;
    try {
      await axios.delete(`/api/company/branches/${branch.id}/`);
    } catch (e) {
      alert(`Could not delete: ${e?.response?.data?.detail || e.message}`);
      return;
    }
    await refetchBranches();
    await refreshBranchContext();
  };

  const handleSetDefaultBranch = async (branch) => {
    try {
      await axios.post(`/api/company/branches/${branch.id}/set-default/`);
    } catch (e) {
      alert(`Could not set default: ${e?.response?.data?.detail || e.message}`);
      return;
    }
    await refetchBranches();
    await refreshBranchContext();
  };

  const handleToggleBranchActive = async (branch) => {
    try {
      await axios.post(`/api/company/branches/${branch.id}/${branch.isActive ? 'deactivate' : 'activate'}/`);
    } catch (e) {
      alert(`Could not update status: ${e?.response?.data?.detail || e.message}`);
      return;
    }
    await refetchBranches();
    await refreshBranchContext();
  };

  const openAssignAccess = (existing) => {
    if (existing) {
      setAccessInput({
        id: existing.id,
        username: existing.username,
        access_all_branches: existing.access_all_branches,
        branches: existing.branches || [],
        default_branch: existing.default_branch || ''
      });
    } else {
      setAccessInput({ username: '', access_all_branches: false, branches: [], default_branch: '' });
    }
    setAssignAccessOpen(true);
  };

  const handleSaveAccess = async () => {
    if (!accessInput.username) { alert('Select or enter a username.'); return; }
    const payload = {
      username: accessInput.username,
      access_all_branches: accessInput.access_all_branches,
      branches: accessInput.access_all_branches ? [] : accessInput.branches,
      default_branch: accessInput.default_branch || null
    };
    try {
      if (accessInput.id) {
        await axios.put(`/api/company/user-branch-access/${accessInput.id}/`, payload);
      } else {
        await axios.post('/api/company/user-branch-access/', payload);
      }
    } catch (e) {
      alert(`Could not save access: ${e?.response?.data?.detail || e.message}`);
      return;
    }
    await refetchBranchAccess();
    setAssignAccessOpen(false);
  };

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

  // Save users to localStorage
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
        role: newUserObj.role
      });
    } catch (e) {}

    setAddUserOpen(false);
    setUserInput({
      id: `EMP-${Math.floor(100 + Math.random() * 900)}`,
      name: '',
      email: '',
      phone: '',
      password: '',
      roleDisplay: 'Optometrist',
      status: 'Active',
      permissions: { optical: true, sales: true, inventory: false, purchase: false, accounts: false, reports: true, admin: false }
    });

    alert(`User account '${newUserObj.name}' created successfully!`);
  };

  const handleDeleteUser = (userId) => {
    if (window.confirm("Are you sure you want to delete this staff user account?")) {
      setUsers(users.filter(u => u.id !== userId));
    }
  };

  const handleUpdatePermissions = () => {
    if (!editPermissionsUser) return;
    setUsers(users.map(u => u.id === editPermissionsUser.id ? editPermissionsUser : u));
    setEditPermissionsUser(null);
    alert(`Access permissions updated for '${editPermissionsUser.name}'!`);
  };

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
          <Typography variant="h4" fontWeight={800}>Administration & System Control</Typography>
          <Typography variant="body2" color="text.secondary">Manage staff accounts, doctors, branch locations, Excel imports, and security permissions</Typography>
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
          {activeTab === 'doctors' && (
            <Button 
              variant="contained" 
              color="success"
              startIcon={<DoctorIcon />} 
              onClick={() => setAddDoctorOpen(true)} 
              sx={{ fontWeight: 700, px: 3 }}
            >
              + Register New Doctor / Optometrist
            </Button>
          )}
          {activeTab === 'branches' && (
            <Button
              variant="contained"
              color="success"
              startIcon={<BranchIcon />}
              onClick={() => setAddBranchOpen(true)}
              sx={{ fontWeight: 700, px: 3, bgcolor: '#16a34a', '&:hover': { bgcolor: '#15803d' } }}
            >
              + Add New Branch
            </Button>
          )}
          {activeTab === 'service-master' && (
            <Button
              variant="contained"
              startIcon={<ServiceIcon />}
              onClick={() => openServiceDialog(null)}
              sx={{ fontWeight: 700, px: 3, bgcolor: '#7c3aed', '&:hover': { bgcolor: '#6d28d9' } }}
            >
              + Add Service
            </Button>
          )}
        </Stack>
      </Box>

      {/* Navigation Tabs */}
      <Card sx={{ mb: 3, borderRadius: 3 }}>
        <Tabs value={activeTab} onChange={handleTabChange} variant="scrollable" scrollButtons="auto" sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="users" label="User Accounts Directory" icon={<UsersIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="doctors" label="Doctors & Optometrists Master" icon={<DoctorIcon />} iconPosition="start" sx={{ fontWeight: 700, color: '#0284c7' }} />
          <Tab value="service-master" label="Service Master" icon={<ServiceIcon />} iconPosition="start" sx={{ fontWeight: 700, color: '#7c3aed' }} />
          <Tab value="branches" label="Branch Management (Add Branch)" icon={<BranchIcon />} iconPosition="start" sx={{ fontWeight: 700, color: '#16a34a' }} />
          <Tab value="excel-import" label="Excel Import Management" icon={<ImportIcon />} iconPosition="start" sx={{ fontWeight: 700, color: '#2563eb' }} />
          <Tab value="barcode-printing" label="Barcode Printing" icon={<BarcodeIcon />} iconPosition="start" sx={{ fontWeight: 700, color: '#7c3aed' }} />
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
            <TextField 
              placeholder="Search staff users by name, email, or role..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              size="small"
              sx={{ maxWidth: 400, bgcolor: '#fff', borderRadius: 2 }}
              InputProps={{ startAdornment: <SearchIcon sx={{ color: 'text.secondary', mr: 1 }} /> }}
            />

            <Card sx={{ borderRadius: 3 }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: '#0f172a' }}>
                    <TableRow>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>User ID</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Full Name</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Email Address</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Role</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Status</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }} align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredUsers.map(u => (
                      <TableRow key={u.id} hover>
                        <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{u.id}</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>{u.name}</TableCell>
                        <TableCell>{u.email}</TableCell>
                        <TableCell><Chip label={u.roleDisplay || u.role} color="primary" size="small" sx={{ fontWeight: 700 }} /></TableCell>
                        <TableCell><Chip label={u.status} color="success" size="small" sx={{ fontWeight: 700 }} /></TableCell>
                        <TableCell align="right">
                          <IconButton size="small" color="primary" onClick={() => setEditPermissionsUser(u)}>
                            <KeyIcon fontSize="small" />
                          </IconButton>
                          <IconButton size="small" color="error" onClick={() => handleDeleteUser(u.id)}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Stack>
        );
      })()}

      {/* 2. DOCTORS & OPTOMETRISTS MASTER TAB */}
      {activeTab === 'doctors' && (() => {
        const filteredDocs = doctors.filter(d => {
          const query = searchQuery.toLowerCase();
          return (d.name && d.name.toLowerCase().includes(query)) ||
                 (d.qualification && d.qualification.toLowerCase().includes(query)) ||
                 (d.branch && d.branch.toLowerCase().includes(query));
        });

        return (
          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={4}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #0284c7' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>REGISTERED OPTOMETRISTS</Typography>
                  <Typography variant="h4" fontWeight={850} color="#0284c7">{doctors.length}</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>ACTIVE IN CLINIC</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">
                    {doctors.filter(d => d.status === 'Active').length}
                  </Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>PRIMARY BRANCH</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>Main Branch</Typography>
                </Paper>
              </Grid>
            </Grid>

            <TextField 
              placeholder="Search doctor by name, qualification, or branch..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              size="small"
              sx={{ maxWidth: 400, bgcolor: '#fff', borderRadius: 2 }}
              InputProps={{ startAdornment: <SearchIcon sx={{ color: 'text.secondary', mr: 1 }} /> }}
            />

            <Card sx={{ borderRadius: 3 }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: '#0f172a' }}>
                    <TableRow>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Doctor ID</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Doctor Name</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Qualification</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>License No</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Branch</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Fee (₹)</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredDocs.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={600}>
                            No doctors registered in database yet. Click '+ Register New Doctor' above.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : (
                      filteredDocs.map(d => (
                        <TableRow key={d.id} hover>
                          <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{d.id}</TableCell>
                          <TableCell sx={{ fontWeight: 800, color: '#0284c7' }}>{d.name}</TableCell>
                          <TableCell>{d.qualification}</TableCell>
                          <TableCell>{d.licenseNo}</TableCell>
                          <TableCell>{d.branch}</TableCell>
                          <TableCell sx={{ fontWeight: 800 }}>₹{d.consultationFee}</TableCell>
                          <TableCell><Chip label={d.status} color="success" size="small" sx={{ fontWeight: 700 }} /></TableCell>
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

      {/* 🔧 SERVICE MASTER TAB */}
      {activeTab === 'service-master' && (() => {
        const q = searchQuery.toLowerCase();
        const filtered = servicesList.filter(s =>
          (s.name && s.name.toLowerCase().includes(q)) ||
          (s.code && s.code.toLowerCase().includes(q)) ||
          (s.description && s.description.toLowerCase().includes(q))
        );
        return (
          <Stack spacing={3}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={4}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #7c3aed' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>TOTAL SERVICES</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>{servicesList.length}</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #16a34a' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>ACTIVE SERVICES</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">{servicesList.filter(s => s.isActive).length}</Typography>
                </Paper>
              </Grid>
              <Grid item xs={12} sm={4}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>INACTIVE / HIDDEN</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>{servicesList.filter(s => !s.isActive).length}</Typography>
                </Paper>
              </Grid>
            </Grid>

            <TextField
              placeholder="Search service by code, name, or description..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              size="small"
              sx={{ maxWidth: 420, bgcolor: '#fff', borderRadius: 2 }}
              InputProps={{ startAdornment: <SearchIcon sx={{ color: 'text.secondary', mr: 1 }} /> }}
            />

            <Card sx={{ borderRadius: 3.5, border: '1px solid', borderColor: '#cbd5e1' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: '#0f172a' }}>
                    <TableRow>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Service Code</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Service Name</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Description</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }} align="right">Default Price (₹)</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }} align="right">Tax %</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Status</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }} align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filtered.length === 0 ? (
                      <TableRow>
                        <TableCell colSpan={7} align="center" sx={{ py: 6 }}>
                          <Typography variant="body2" color="text.secondary" fontWeight={600}>
                            No services found. Click '+ Add Service' above to create one.
                          </Typography>
                        </TableCell>
                      </TableRow>
                    ) : filtered.map(s => (
                      <TableRow key={s.id} hover>
                        <TableCell sx={{ fontWeight: 850, color: '#7c3aed' }}>{s.code}</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>{s.name}</TableCell>
                        <TableCell sx={{ maxWidth: 280, fontSize: '0.82rem' }}>{s.description || '—'}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 800 }}>₹{s.defaultPrice.toFixed(2)}</TableCell>
                        <TableCell align="right" sx={{ fontWeight: 700 }}>{s.taxPercentage}%</TableCell>
                        <TableCell>
                          {/* ON = service is offered in New Sale → 🔧 Services; OFF hides it there. */}
                          <FormControlLabel
                            sx={{ m: 0 }}
                            control={
                              <Switch
                                size="small"
                                color="success"
                                checked={s.isActive}
                                onChange={() => handleToggleServiceActive(s)}
                              />
                            }
                            label={
                              <Typography variant="caption" fontWeight={900}
                                sx={{ color: s.isActive ? 'success.main' : 'text.disabled' }}>
                                {s.isActive ? 'ON' : 'OFF'}
                              </Typography>
                            }
                          />
                        </TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <IconButton size="small" color="primary" onClick={() => openServiceDialog(s)}>
                              <EditIcon fontSize="small" />
                            </IconButton>
                            <IconButton size="small" color="error" onClick={() => handleDeleteService(s)}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Stack>
        );
      })()}

      {/* 🏢 3. BRANCH MANAGEMENT (ADD BRANCH) TAB */}
      {activeTab === 'branches' && (() => {
        const filteredBranches = branches.filter(b => {
          const query = searchQuery.toLowerCase();
          return (b.name && b.name.toLowerCase().includes(query)) ||
                 (b.code && b.code.toLowerCase().includes(query)) ||
                 (b.manager && b.manager.toLowerCase().includes(query)) ||
                 (b.address && b.address.toLowerCase().includes(query));
        });

        return (
          <Stack spacing={3}>
            {/* KPI Summary Scorecards */}
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #16a34a', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>TOTAL STORE BRANCHES</Typography>
                  <Typography variant="h4" fontWeight={850} color="success.main">{branches.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Registered optical outlets</Typography>
                </Paper>
              </Grid>

              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #2563eb', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>ACTIVE CLINIC BRANCHES</Typography>
                  <Typography variant="h4" fontWeight={850} color="primary.main">
                    {branches.filter(b => b.status === 'Active').length}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Operational stores</Typography>
                </Paper>
              </Grid>

              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #7c3aed', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>DEFAULT / MAIN BRANCH</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed', fontSize: '1.4rem' }}>
                    {(branches.find(b => b.isDefault) || {}).name || '—'}
                  </Typography>
                  <Typography variant="caption" color="text.secondary">Used for every operation</Typography>
                </Paper>
              </Grid>

              <Grid item xs={12} sm={6} md={3}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #f59e0b', bgcolor: '#ffffff' }}>
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>BRANCH MANAGERS</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#d97706' }}>{branches.length}</Typography>
                  <Typography variant="caption" color="text.secondary">Assigned optometrists</Typography>
                </Paper>
              </Grid>
            </Grid>

            {/* Filter Search */}
            <TextField 
              placeholder="Search branch by name, code, manager, or address..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              size="small"
              sx={{ maxWidth: 450, bgcolor: '#fff', borderRadius: 2 }}
              InputProps={{ startAdornment: <SearchIcon sx={{ color: 'text.secondary', mr: 1 }} /> }}
            />

            {/* Branch Directory Table */}
            <Card sx={{ borderRadius: 3.5, border: '1px solid', borderColor: '#cbd5e1' }}>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: '#0f172a' }}>
                    <TableRow>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Code</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Branch Name</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Branch Manager</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Phone / Email</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>GSTIN</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Address</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Status</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }} align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {filteredBranches.map(b => (
                      <TableRow key={b.id} hover>
                        <TableCell sx={{ fontWeight: 850, color: 'success.main' }}>{b.code}</TableCell>
                        <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>
                          {b.name}
                          {b.isDefault && <Chip label="Default" size="small" color="secondary" sx={{ ml: 1, height: 18, fontWeight: 800 }} />}
                        </TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>{b.manager}</TableCell>
                        <TableCell>{b.phone}<br/><Typography variant="caption" color="text.secondary">{b.email}</Typography></TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>{b.gstin}</TableCell>
                        <TableCell sx={{ maxWidth: 200, fontSize: '0.82rem' }} data-branch-loc>
                          {[b.address, b.city, b.state, b.country, b.pinCode].filter(x => x && x !== '—').join(', ') || '—'}
                        </TableCell>
                        <TableCell><Chip label={b.status} color={b.isActive ? 'success' : 'default'} size="small" sx={{ fontWeight: 800 }} /></TableCell>
                        <TableCell align="right">
                          <Stack direction="row" spacing={0.5} justifyContent="flex-end">
                            <IconButton size="small" title={b.isDefault ? 'Default branch' : 'Set as default'}
                              color={b.isDefault ? 'secondary' : 'default'}
                              onClick={() => !b.isDefault && handleSetDefaultBranch(b)} disabled={b.isDefault}>
                              {b.isDefault ? <StarIcon fontSize="small" /> : <StarBorderIcon fontSize="small" />}
                            </IconButton>
                            <IconButton size="small" title={b.isActive ? 'Deactivate' : 'Activate'}
                              color={b.isActive ? 'success' : 'warning'}
                              onClick={() => handleToggleBranchActive(b)} disabled={b.isDefault && b.isActive}>
                              {b.isActive ? <ToggleOnIcon fontSize="small" /> : <ToggleOffIcon fontSize="small" />}
                            </IconButton>
                            <IconButton size="small" color="error" onClick={() => handleDeleteBranch(b)} disabled={b.isDefault}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Stack>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>

            {/* User → Branch Access (spec sections 5, 8) */}
            <Card sx={{ borderRadius: 3.5, border: '1px solid', borderColor: '#cbd5e1' }}>
              <Box sx={{ p: 2, display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
                <Box>
                  <Typography variant="subtitle1" fontWeight={850}>User Branch Access</Typography>
                  <Typography variant="caption" color="text.secondary">Control which branches each staff member can open. Admins always see every branch.</Typography>
                </Box>
                <Button variant="outlined" size="small" startIcon={<GroupAddIcon />} onClick={() => openAssignAccess(null)}>
                  Assign User to Branches
                </Button>
              </Box>
              <TableContainer>
                <Table size="small">
                  <TableHead sx={{ backgroundColor: '#f1f5f9' }}>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 800 }}>Username</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Access</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Default Branch</TableCell>
                      <TableCell sx={{ fontWeight: 800 }} align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {branchAccessList.length === 0 ? (
                      <TableRow><TableCell colSpan={4}><Typography variant="body2" color="text.secondary" sx={{ py: 1 }}>No branch access rules yet — every user can see all branches until you add one.</Typography></TableCell></TableRow>
                    ) : branchAccessList.map(a => (
                      <TableRow key={a.id} hover>
                        <TableCell sx={{ fontWeight: 700 }}>{a.username}</TableCell>
                        <TableCell>
                          {a.access_all_branches
                            ? <Chip label="All branches" size="small" color="primary" sx={{ fontWeight: 700 }} />
                            : (a.branches || []).map(bid => (branches.find(x => x.id === bid) || {}).name || '?').join(', ') || '—'}
                        </TableCell>
                        <TableCell>{(branches.find(x => x.id === a.default_branch) || {}).name || '—'}</TableCell>
                        <TableCell align="right">
                          <IconButton size="small" onClick={() => openAssignAccess(a)}><EditIcon fontSize="small" /></IconButton>
                          <IconButton size="small" color="error" onClick={async () => {
                            if (!window.confirm(`Remove branch access rule for '${a.username}'?`)) return;
                            try { await axios.delete(`/api/company/user-branch-access/${a.id}/`); } catch (e) {}
                            refetchBranchAccess();
                          }}><DeleteIcon fontSize="small" /></IconButton>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            </Card>
          </Stack>
        );
      })()}

      {/* 4. EXCEL IMPORT MANAGEMENT TAB */}
      {activeTab === 'excel-import' && <ExcelImportManager />}

      {activeTab === 'barcode-printing' && <BarcodePrintingManager />}

      {/* 5. ROLES TAB */}
      {activeTab === 'roles' && (
        <Card sx={{ p: 4, borderRadius: 3 }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>System Roles Directory</Typography>
          <Grid container spacing={2}>
            {[
              { role: 'Super Admin', desc: 'Full access to all system modules, financial reports, and settings' },
              { role: 'Optometrist Doctor', desc: 'Access to Eye Tests, Clinical Diagnosis, Patient History & Prescriptions' },
              { role: 'Sales & Billing Executive', desc: 'Access to POS Billing, Invoices, Customer Lookup & Receipts' },
              { role: 'Inventory Manager', desc: 'Access to Stock Reordering, Supplier POs, Frames & Lenses Catalog' }
            ].map(r => (
              <Grid item xs={12} sm={6} key={r.role}>
                <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                  <Typography variant="subtitle1" fontWeight={800} color="primary">{r.role}</Typography>
                  <Typography variant="body2" color="text.secondary">{r.desc}</Typography>
                </Paper>
              </Grid>
            ))}
          </Grid>
        </Card>
      )}

      {/* 6. PERMISSIONS TAB */}
      {activeTab === 'permissions' && (
        <Card sx={{ p: 4, borderRadius: 3 }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Module Permissions Matrix</Typography>
          <Typography variant="body2" color="text.secondary">
            Configure access controls per staff role. Click 'Key' icon in User Accounts Directory to customize individual user access.
          </Typography>
        </Card>
      )}

      {/* 7. AUDIT LOGS TAB */}
      {activeTab === 'audit' && (
        <Card sx={{ borderRadius: 3 }}>
          <TableContainer>
            <Table size="small">
              <TableHead sx={{ backgroundColor: '#0f172a' }}>
                <TableRow>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Log ID</TableCell>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>User</TableCell>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Action</TableCell>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Target</TableCell>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Timestamp</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {auditLogs.map(l => (
                  <TableRow key={l.id} hover>
                    <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{l.id}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{l.user}</TableCell>
                    <TableCell>{l.action}</TableCell>
                    <TableCell>{l.target}</TableCell>
                    <TableCell>{l.time}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}

      {/* ------------------ DIALOG: ADD / EDIT SERVICE (shared component) ------------------ */}
      <ServiceMasterDialog
        open={serviceDialogOpen}
        service={editingService}
        onClose={() => { setServiceDialogOpen(false); setEditingService(null); }}
        onSaved={() => { setServiceDialogOpen(false); setEditingService(null); refetchServices(); }}
      />

      {/* ------------------ DIALOG: ADD NEW BRANCH ------------------ */}
      <Dialog 
        open={addBranchOpen} 
        onClose={() => setAddBranchOpen(false)} 
        maxWidth="md" 
        fullWidth
        PaperProps={{ sx: { borderRadius: 4 } }}
      >
        <DialogTitle sx={{ fontWeight: 850, bgcolor: '#0f172a', color: '#fff', display: 'flex', alignItems: 'center', gap: 1 }}>
          <BranchIcon sx={{ color: '#16a34a' }} /> Add New Company Store / Branch Location
        </DialogTitle>
        <DialogContent dividers sx={{ p: 3 }}>
          <Grid container spacing= {2.5}>
            <Grid item xs={12} sm={6}>
              <TextField 
                fullWidth 
                label="Branch Code *" 
                size="small" 
                value={branchInput.code} 
                onChange={(e) => setBranchInput({ ...branchInput, code: e.target.value })}
                placeholder="e.g. BR-102"
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField 
                fullWidth 
                label="Branch / Store Name *" 
                size="small" 
                value={branchInput.name} 
                onChange={(e) => setBranchInput({ ...branchInput, name: e.target.value })}
                placeholder="e.g. Koramangala Clinic Branch"
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField 
                fullWidth 
                label="Contact Phone Number" 
                size="small" 
                value={branchInput.phone} 
                onChange={(e) => setBranchInput({ ...branchInput, phone: e.target.value })}
                placeholder="+91 98765 43210"
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField 
                fullWidth 
                label="Branch Email Address" 
                size="small" 
                value={branchInput.email} 
                onChange={(e) => setBranchInput({ ...branchInput, email: e.target.value })}
                placeholder="koramangala@gopticals.com"
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField 
                fullWidth 
                label="Branch Manager / Lead Doctor" 
                size="small" 
                value={branchInput.manager} 
                onChange={(e) => setBranchInput({ ...branchInput, manager: e.target.value })}
                placeholder="Enter Manager Name"
              />

            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField 
                fullWidth 
                label="GSTIN Number" 
                size="small" 
                value={branchInput.gstin} 
                onChange={(e) => setBranchInput({ ...branchInput, gstin: e.target.value })}
                placeholder="29AAAAA0000A1Z5"
              />
            </Grid>

            <Grid item xs={12}>
              <TextField
                fullWidth
                multiline
                rows={2}
                label="Full Branch Street Address"
                size="small"
                value={branchInput.address}
                onChange={(e) => setBranchInput({ ...branchInput, address: e.target.value })}
                placeholder="Building No, Street Name, Landmark"
              />
            </Grid>

            <Grid item xs={12} sm={3}>
              <TextField fullWidth label="City" size="small" value={branchInput.city}
                onChange={(e) => setBranchInput({ ...branchInput, city: e.target.value })} />
            </Grid>
            <Grid item xs={12} sm={3}>
              <TextField fullWidth label="State" size="small" value={branchInput.state}
                onChange={(e) => setBranchInput({ ...branchInput, state: e.target.value })} />
            </Grid>
            <Grid item xs={12} sm={3}>
              <TextField fullWidth label="Country" size="small" value={branchInput.country}
                onChange={(e) => setBranchInput({ ...branchInput, country: e.target.value })} />
            </Grid>
            <Grid item xs={12} sm={3}>
              <TextField fullWidth label="PIN Code" size="small" value={branchInput.pinCode}
                onChange={(e) => setBranchInput({ ...branchInput, pinCode: e.target.value })} />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField
                select
                fullWidth
                label="Branch Status"
                size="small" 
                value={branchInput.status} 
                onChange={(e) => setBranchInput({ ...branchInput, status: e.target.value })}
              >
                <MenuItem value="Active">Active Operational</MenuItem>
                <MenuItem value="Inactive">Inactive / Suspended</MenuItem>
              </TextField>
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions sx={{ p: 2.5, justifyContent: 'space-between' }}>
          <Button onClick={() => setAddBranchOpen(false)}>Cancel</Button>
          <Button 
            variant="contained" 
            onClick={handleSaveBranch} 
            sx={{ bgcolor: '#16a34a', '&:hover': { bgcolor: '#15803d' }, fontWeight: 800, px: 4 }}
          >
            Save New Branch
          </Button>
        </DialogActions>
      </Dialog>

      {/* ------------------ DIALOG: ASSIGN USER TO BRANCHES ------------------ */}
      <Dialog open={assignAccessOpen} onClose={() => setAssignAccessOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 850, bgcolor: '#0f172a', color: '#fff', display: 'flex', alignItems: 'center', gap: 1 }}>
          <GroupAddIcon sx={{ color: '#16a34a' }} /> Assign User to Branches
        </DialogTitle>
        <DialogContent dividers sx={{ p: 3 }}>
          <Stack spacing={2.5}>
            <TextField
              fullWidth size="small" label="Username *"
              value={accessInput.username}
              disabled={!!accessInput.id}
              onChange={(e) => setAccessInput({ ...accessInput, username: e.target.value })}
              helperText="The username the user logs in with (see User Accounts). Super Admin / Administrator always get every branch."
            />
            <FormControlLabel
              control={<Checkbox checked={accessInput.access_all_branches}
                onChange={(e) => setAccessInput({ ...accessInput, access_all_branches: e.target.checked })} />}
              label="Access All Branches"
            />
            {!accessInput.access_all_branches && (
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>Allowed branches</Typography>
                <Stack sx={{ mt: 0.5 }}>
                  {branches.map(b => (
                    <FormControlLabel key={b.id}
                      control={<Checkbox size="small" checked={accessInput.branches.includes(b.id)}
                        onChange={(e) => setAccessInput(prev => ({
                          ...prev,
                          branches: e.target.checked
                            ? [...prev.branches, b.id]
                            : prev.branches.filter(x => x !== b.id)
                        }))} />}
                      label={`${b.name}${b.isDefault ? ' (Main)' : ''}`} />
                  ))}
                </Stack>
              </Box>
            )}
            <TextField select fullWidth size="small" label="Default Branch for this user"
              value={accessInput.default_branch}
              onChange={(e) => setAccessInput({ ...accessInput, default_branch: e.target.value })}>
              <MenuItem value="">— None —</MenuItem>
              {branches.map(b => <MenuItem key={b.id} value={b.id}>{b.name}</MenuItem>)}
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2.5, justifyContent: 'space-between' }}>
          <Button onClick={() => setAssignAccessOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveAccess} sx={{ bgcolor: '#16a34a', '&:hover': { bgcolor: '#15803d' }, fontWeight: 800, px: 4 }}>
            Save Access
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- DIALOG: REGISTER NEW DOCTOR --- */}
      <Dialog open={addDoctorOpen} onClose={() => setAddDoctorOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800, bgcolor: '#0f172a', color: '#fff' }}>
          Register New Doctor / Optometrist Master Record
        </DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2} sx={{ pt: 1 }}>
            <TextField fullWidth label="Doctor ID" size="small" value={doctorInput.id} disabled />
            <TextField fullWidth label="Doctor / Optometrist Name *" size="small" value={doctorInput.name} onChange={(e) => setDoctorInput({ ...doctorInput, name: e.target.value })} placeholder="e.g. Dr. Rajesh Kumar" />
            <Grid container spacing={2}>
              <Grid item xs={6}><TextField fullWidth label="Qualification" size="small" value={doctorInput.qualification} onChange={(e) => setDoctorInput({ ...doctorInput, qualification: e.target.value })} /></Grid>
              <Grid item xs={6}><TextField fullWidth label="Medical Registration No" size="small" value={doctorInput.licenseNo} onChange={(e) => setDoctorInput({ ...doctorInput, licenseNo: e.target.value })} /></Grid>
            </Grid>
            <Grid container spacing={2}>
              <Grid item xs={6}><TextField fullWidth label="Phone Number" size="small" value={doctorInput.phone} onChange={(e) => setDoctorInput({ ...doctorInput, phone: e.target.value })} /></Grid>
              <Grid item xs={6}><TextField fullWidth label="Email Address" size="small" value={doctorInput.email} onChange={(e) => setDoctorInput({ ...doctorInput, email: e.target.value })} /></Grid>
            </Grid>
            <Grid container spacing={2}>
              <Grid item xs={6}>
                <TextField select fullWidth label="Primary Clinic Branch" size="small" value={doctorInput.branch} onChange={(e) => setDoctorInput({ ...doctorInput, branch: e.target.value })}>
                  {branches.map(b => (
                    <MenuItem key={b.id} value={b.name}>{b.name}</MenuItem>
                  ))}
                </TextField>
              </Grid>
              <Grid item xs={6}><TextField fullWidth label="Consultation Fee (₹)" size="small" value={doctorInput.consultationFee} onChange={(e) => setDoctorInput({ ...doctorInput, consultationFee: e.target.value })} /></Grid>
            </Grid>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setAddDoctorOpen(false)}>Cancel</Button>
          <Button variant="contained" color="success" onClick={handleSaveDoctor} sx={{ fontWeight: 700, px: 3 }}>
            Register Doctor
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- DIALOG: ADD NEW USER ACCOUNT --- */}
      <Dialog open={addUserOpen} onClose={() => setAddUserOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Create New Staff User Account</DialogTitle>
        <DialogContent dividers>
          <Stack spacing={2.5} sx={{ pt: 1 }}>
            <TextField fullWidth label="User / Employee ID" size="small" value={userInput.id} disabled />
            <TextField fullWidth label="Full Name *" size="small" value={userInput.name} onChange={(e) => setUserInput({ ...userInput, name: e.target.value })} />
            <TextField fullWidth label="Email Address (Username) *" size="small" value={userInput.email} onChange={(e) => setUserInput({ ...userInput, email: e.target.value })} />
            <Grid container spacing={2}>
              <Grid item xs={6}><TextField fullWidth label="Phone Number" size="small" value={userInput.phone} onChange={(e) => setUserInput({ ...userInput, phone: e.target.value })} /></Grid>
              <Grid item xs={6}><TextField fullWidth label="Password *" type="password" size="small" value={userInput.password} onChange={(e) => setUserInput({ ...userInput, password: e.target.value })} /></Grid>
            </Grid>
            <TextField select fullWidth label="System Role" size="small" value={userInput.roleDisplay} onChange={(e) => setUserInput({ ...userInput, roleDisplay: e.target.value })}>
              <MenuItem value="Super Admin">Super Admin</MenuItem>
              <MenuItem value="Optometrist">Optometrist Doctor</MenuItem>
              <MenuItem value="Sales Executive">Sales & Billing Executive</MenuItem>
              <MenuItem value="Inventory Manager">Inventory Manager</MenuItem>
            </TextField>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          <Button onClick={() => setAddUserOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={handleSaveUser} sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3 }}>
            Save User Account
          </Button>
        </DialogActions>
      </Dialog>

      {/* --- DIALOG: EDIT PERMISSIONS --- */}
      <Dialog open={Boolean(editPermissionsUser)} onClose={() => setEditPermissionsUser(null)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Manage Access Permissions: {editPermissionsUser?.name}</DialogTitle>
        <DialogContent dividers>
          {editPermissionsUser && (
            <Stack spacing={2}>
              {[
                { key: 'optical', label: '👁️ Optical Services' },
                { key: 'sales', label: '🛒 Sales & POS Billing' },
                { key: 'wholesale', label: '🏢 Wholesale Distribution' },
                { key: 'inventory', label: '📦 Inventory & Stock' },
                { key: 'purchase', label: '🚚 Purchasing & Suppliers' },
                { key: 'financial', label: '🏛️ Financial & Accounting' },
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
