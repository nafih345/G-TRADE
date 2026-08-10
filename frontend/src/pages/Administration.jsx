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
  Store as BranchIcon
} from '@mui/icons-material';
import axios from 'axios';
import ExcelImportManager from '../components/admin/import/ExcelImportManager';

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

  // Tab sync from path
  const getTabFromPath = (pathname) => {
    if (pathname.includes('/admin/excel-import') || pathname.includes('/admin/import')) return 'excel-import';
    if (pathname.includes('/admin/doctors')) return 'doctors';
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
    if (newValue === 'branches') navigate('/admin/branches');
    if (newValue === 'excel-import') navigate('/admin/excel-import');
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

  // Fetch branches from backend Database API
  useEffect(() => {
    const fetchApiBranches = async () => {
      try {
        const res = await axios.get('/api/company/branches/');
        if (res.data && Array.isArray(res.data) && res.data.length > 0) {
          const apiBranches = res.data.map(b => ({
            id: b.id || b.code || b.name,
            code: b.code || 'MAIN',
            name: b.name || 'Main Branch',
            phone: b.phone || '—',
            email: b.email || '—',
            manager: b.manager || '—',
            address: b.address || '—',
            gstin: b.gstin || '—',
            status: 'Active',
            createdDate: new Date().toISOString().split('T')[0]
          }));
          setBranches(apiBranches);
        }
      } catch (e) {}
    };
    fetchApiBranches();
  }, []);



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
  const [branchInput, setBranchInput] = useState({
    code: `BR-${Math.floor(100 + Math.random() * 900)}`,
    name: '',
    phone: '',
    email: '',
    manager: '',
    address: '',
    gstin: '',
    status: 'Active'
  });


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

  // Handler to Save New Branch
  const handleSaveBranch = async () => {
    if (!branchInput.name || !branchInput.code) {
      alert("Please enter Branch Name and Branch Code.");
      return;
    }

    const newBranchObj = {
      id: branchInput.code.toLowerCase().replace(/\s+/g, '-'),
      code: branchInput.code.toUpperCase(),
      name: branchInput.name.trim(),
      phone: branchInput.phone || '—',
      email: branchInput.email || '—',
      manager: branchInput.manager || '—',
      address: branchInput.address || '—',
      gstin: branchInput.gstin || '—',
      status: branchInput.status || 'Active',
      createdDate: new Date().toISOString().split('T')[0]
    };

    const updatedBranches = [newBranchObj, ...branches];
    setBranches(updatedBranches);

    // Save to Backend API
    try {
      await axios.post('/api/company/branches/', {
        code: newBranchObj.code,
        name: newBranchObj.name,
        phone: newBranchObj.phone,
        address: newBranchObj.address
      });
    } catch (e) {}

    setAddBranchOpen(false);
    setBranchInput({
      code: `BR-${Math.floor(100 + Math.random() * 900)}`,
      name: '',
      phone: '',
      email: '',
      manager: '',
      address: '',
      gstin: '',
      status: 'Active'
    });


    alert(`Branch '${newBranchObj.name}' added successfully! It is now available in the top header branch selector.`);
  };

  const handleDeleteBranch = (branchId) => {
    if (branchId === 'main') {
      alert("Main Branch cannot be deleted as it is the primary store.");
      return;
    }
    if (window.confirm("Are you sure you want to delete this branch?")) {
      setBranches(branches.filter(b => b.id !== branchId));
    }
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
        </Stack>
      </Box>

      {/* Navigation Tabs */}
      <Card sx={{ mb: 3, borderRadius: 3 }}>
        <Tabs value={activeTab} onChange={handleTabChange} variant="scrollable" scrollButtons="auto" sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="users" label="User Accounts Directory" icon={<UsersIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab value="doctors" label="Doctors & Optometrists Master" icon={<DoctorIcon />} iconPosition="start" sx={{ fontWeight: 700, color: '#0284c7' }} />
          <Tab value="branches" label="Branch Management (Add Branch)" icon={<BranchIcon />} iconPosition="start" sx={{ fontWeight: 700, color: '#16a34a' }} />
          <Tab value="excel-import" label="Excel Import Management" icon={<ImportIcon />} iconPosition="start" sx={{ fontWeight: 700, color: '#2563eb' }} />
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
                  <Typography variant="caption" color="text.secondary" fontWeight={800}>PRIMARY STORE</Typography>
                  <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed', fontSize: '1.4rem' }}>Main Branch</Typography>
                  <Typography variant="caption" color="text.secondary">Default billing hub</Typography>
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
                        <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{b.name}</TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>{b.manager}</TableCell>
                        <TableCell>{b.phone}<br/><Typography variant="caption" color="text.secondary">{b.email}</Typography></TableCell>
                        <TableCell sx={{ fontWeight: 700 }}>{b.gstin}</TableCell>
                        <TableCell sx={{ maxWidth: 220, fontSize: '0.82rem' }}>{b.address}</TableCell>
                        <TableCell><Chip label={b.status} color="success" size="small" sx={{ fontWeight: 800 }} /></TableCell>
                        <TableCell align="right">
                          <IconButton size="small" color="error" onClick={() => handleDeleteBranch(b.id)} disabled={b.id === 'main'}>
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

      {/* 4. EXCEL IMPORT MANAGEMENT TAB */}
      {activeTab === 'excel-import' && <ExcelImportManager />}

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
                placeholder="Building No, Street Name, Landmark, City, Pincode"
              />
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
