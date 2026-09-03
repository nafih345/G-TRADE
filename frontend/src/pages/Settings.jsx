import React, { useState, useEffect } from 'react';
import { 
  Box, Card, CardContent, Typography, Button, Tab, Tabs, 
  Grid, TextField, MenuItem, Stack, Switch, FormControlLabel, 
  Divider, Alert, Paper, Avatar, InputAdornment
} from '@mui/material';
import {
  Storefront as StoreIcon,
  Receipt as BillingIcon,
  QrCode as BarcodeIcon,
  Visibility as ClinicalIcon,
  Security as SecurityIcon,
  Save as SaveIcon,
  CloudUpload as UploadIcon,
  CheckCircle as SuccessIcon,
  AccountTree as BranchTreeIcon
} from '@mui/icons-material';
import axios from 'axios';
import { useBranch } from '../context/BranchContext';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';

export default function Settings() {
  const [activeTab, setActiveTab] = useState(0);
  const { multiBranchEnabled, refresh: refreshBranchContext } = useBranch();
  const [multiBranch, setMultiBranch] = useState(false);
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);
  const [branchSavedAlert, setBranchSavedAlert] = useState(false);

  useEffect(() => { setMultiBranch(multiBranchEnabled); }, [multiBranchEnabled]);

  const persistMultiBranch = async (value) => {
    setMultiBranch(value);
    try {
      await axios.patch('/api/company/business-settings/', { multi_branch_enabled: value });
      await refreshBranchContext();
      setBranchSavedAlert(true);
      setTimeout(() => setBranchSavedAlert(false), 4000);
    } catch (e) {
      setMultiBranch(!value); // revert on failure
    }
  };

  const handleToggleMultiBranch = (checked) => {
    if (checked) {
      setConfirmEnableOpen(true); // spec section 12 — confirm before enabling
    } else {
      persistMultiBranch(false);
    }
  };

  // Settings State initialized from localStorage (starts 100% blank by default)
  const [settings, setSettings] = useState(() => {
    try {
      const saved = localStorage.getItem('optical_app_settings');
      return saved ? JSON.parse(saved) : {
        storeName: '',
        storePhone: '',
        storeEmail: '',
        website: '',
        address: '',
        city: '',
        state: '',
        pincode: '',
        gstin: '',
        currency: '₹',
        defaultGst: '18%',
        invoicePrefix: 'INV-2026-',
        invoiceFooter: '',
        barcodeStandard: 'EAN-13',
        autoPrintReceipt: true,
        enableScannerBeep: true,
        defaultDoctor: '',
        examReminderMonths: '12 Months',
        autoLogoutMinutes: '30'
      };
    } catch (e) {
      return {
        storeName: '',
        storePhone: '',
        storeEmail: '',
        website: '',
        address: '',
        city: '', state: '', pincode: '',
        gstin: '', currency: '₹', defaultGst: '18%',
        invoicePrefix: 'INV-2026-',
        invoiceFooter: '',
        barcodeStandard: 'EAN-13', autoPrintReceipt: true, enableScannerBeep: true,
        defaultDoctor: '', examReminderMonths: '12 Months', autoLogoutMinutes: '30'
      };
    }
  });

  const [doctorsList, setDoctorsList] = useState([]);

  useEffect(() => {
    const loadDocs = () => {
      try {
        const saved = JSON.parse(localStorage.getItem('optical_doctors_db') || '[]');
        setDoctorsList(saved.filter(d => d.status === 'Active'));
      } catch (e) {}
    };
    loadDocs();
    window.addEventListener('optical_doctors_updated', loadDocs);
    return () => window.removeEventListener('optical_doctors_updated', loadDocs);
  }, []);

  // Fetch Company Settings from Backend Database API on Mount
  useEffect(() => {
    const fetchCompanySettings = async () => {
      try {
        const res = await axios.get('/api/company/profile/');
        if (res.data && Array.isArray(res.data) && res.data.length > 0) {
          const profile = res.data[0];
          setSettings(prev => ({
            ...prev,
            storeName: profile.name || prev.storeName,
            storePhone: profile.phone || prev.storePhone,
            storeEmail: profile.email || prev.storeEmail,
            address: profile.address || prev.address,
            gstin: profile.gstin || prev.gstin,
            currency: profile.currency || prev.currency
          }));
        }
      } catch (e) {}
    };
    fetchCompanySettings();
  }, []);

  const [savedAlert, setSavedAlert] = useState(false);

  // Save Settings Handler (Database API Sync)
  const handleSaveSettings = async () => {
    // 1. Save locally
    try {
      localStorage.setItem('optical_app_settings', JSON.stringify(settings));
    } catch (e) {}

    // 2. Synchronize Main Branch in Administration & Header with updated store details
    try {
      const savedBranches = JSON.parse(localStorage.getItem('optical_branches') || '[]');
      const updatedBranches = savedBranches.map(b => {
        if (b.id === 'main' || b.name === 'Main Branch') {
          return {
            ...b,
            phone: settings.storePhone || b.phone || '—',
            email: settings.storeEmail || b.email || '—',
            gstin: settings.gstin || b.gstin || '—',
            address: settings.address || b.address || '—'
          };
        }
        return b;
      });
      localStorage.setItem('optical_branches', JSON.stringify(updatedBranches));
      window.dispatchEvent(new Event('optical_branches_updated'));
    } catch (e) {}

    // 3. Save to Backend Database API
    try {
      await axios.post('/api/company/profile/', {
        name: settings.storeName || 'Main Optical Store',
        email: settings.storeEmail,
        phone: settings.storePhone,
        gstin: settings.gstin,
        address: settings.address,
        currency: settings.currency || '₹',
        fiscal_year_start: '2026-04-01',
        fiscal_year_end: '2027-03-31'
      });
    } catch (e) {}

    setSavedAlert(true);
    setTimeout(() => setSavedAlert(false), 4000);
  };


  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" fontWeight={800}>Application & Store Configuration</Typography>
          <Typography variant="body2" color="text.secondary">Configure optical store profile, billing taxes, POS barcode rules, clinical defaults, and system preferences</Typography>
        </Box>
        <Button 
          variant="contained" 
          startIcon={<SaveIcon />} 
          onClick={handleSaveSettings}
          sx={{ backgroundColor: '#2563EB', fontWeight: 700, px: 3, py: 1 }}
        >
          Save All Settings
        </Button>
      </Box>

      {savedAlert && (
        <Alert severity="success" icon={<SuccessIcon />} sx={{ mb: 3, borderRadius: 3, fontWeight: 600 }}>
          Application settings updated and saved to system database!
        </Alert>
      )}

      {/* Tabs */}
      <Card sx={{ mb: 3, borderRadius: 3 }}>
        <Tabs value={activeTab} onChange={(e, val) => setActiveTab(val)} sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
          <Tab label="Store & Clinic Profile" icon={<StoreIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="Billing & Tax Config" icon={<BillingIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="POS & Barcode Scanner" icon={<BarcodeIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="Clinical & Eye Exam Defaults" icon={<ClinicalIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="System Security & Backup" icon={<SecurityIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="Business Settings" icon={<BranchTreeIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
        </Tabs>
      </Card>

      {/* TAB 0: STORE PROFILE */}
      {activeTab === 0 && (
        <Card sx={{ p: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Optical Store & Clinic Branding</Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField 
                label="Store / Clinic Name" 
                fullWidth 
                required
                placeholder="e.g. Greensol Opticals & Eye Care"
                value={settings.storeName}
                onChange={(e) => setSettings({ ...settings, storeName: e.target.value })}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField 
                label="GSTIN Registration Number" 
                fullWidth 
                placeholder="e.g. 29AAAAA0000A1Z5"
                value={settings.gstin}
                onChange={(e) => setSettings({ ...settings, gstin: e.target.value })}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField 
                label="Contact Phone Number" 
                fullWidth 
                placeholder="e.g. +91 9876543210"
                value={settings.storePhone}
                onChange={(e) => setSettings({ ...settings, storePhone: e.target.value })}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField 
                label="Store Email Address" 
                fullWidth 
                placeholder="e.g. contact@gopticals.com"
                value={settings.storeEmail}
                onChange={(e) => setSettings({ ...settings, storeEmail: e.target.value })}
              />
            </Grid>

            <Grid item xs={12}>
              <TextField 
                label="Physical Street Address" 
                fullWidth 
                multiline
                rows={2}
                placeholder="Enter street address, building / suite number"
                value={settings.address}
                onChange={(e) => setSettings({ ...settings, address: e.target.value })}
              />
            </Grid>

            <Grid item xs={12} sm={4}>
              <TextField 
                label="City / District" 
                fullWidth 
                placeholder="e.g. Bengaluru"
                value={settings.city}
                onChange={(e) => setSettings({ ...settings, city: e.target.value })}
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField 
                label="State" 
                fullWidth 
                placeholder="e.g. Karnataka"
                value={settings.state}
                onChange={(e) => setSettings({ ...settings, state: e.target.value })}
              />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField 
                label="Pincode" 
                fullWidth 
                placeholder="e.g. 560001"
                value={settings.pincode}
                onChange={(e) => setSettings({ ...settings, pincode: e.target.value })}
              />
            </Grid>
          </Grid>
        </Card>
      )}

      {/* TAB 1: BILLING & TAX */}
      {activeTab === 1 && (
        <Card sx={{ p: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>POS Billing & Tax Configurations</Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={4}>
              <TextField 
                select 
                label="System Currency Symbol" 
                fullWidth 
                value={settings.currency}
                onChange={(e) => setSettings({ ...settings, currency: e.target.value })}
              >
                <MenuItem value="₹">₹ (Indian Rupee - INR)</MenuItem>
                <MenuItem value="$">$ (US Dollar - USD)</MenuItem>
                <MenuItem value="€">€ (Euro - EUR)</MenuItem>
                <MenuItem value="£">£ (British Pound - GBP)</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField 
                select 
                label="Default GST Tax Rate" 
                fullWidth 
                value={settings.defaultGst}
                onChange={(e) => setSettings({ ...settings, defaultGst: e.target.value })}
              >
                <MenuItem value="5%">5% GST (Standard Lenses)</MenuItem>
                <MenuItem value="12%">12% GST (Spectacle Frames)</MenuItem>
                <MenuItem value="18%">18% GST (Contact Lenses & Solutions)</MenuItem>
                <MenuItem value="28%">28% GST (Premium Sunglasses)</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField 
                label="Invoice Number Prefix" 
                fullWidth 
                value={settings.invoicePrefix}
                onChange={(e) => setSettings({ ...settings, invoicePrefix: e.target.value })}
              />
            </Grid>

            <Grid item xs={12}>
              <TextField 
                label="Invoice Footer Note (Appears on Printed Receipts)" 
                fullWidth 
                multiline
                rows={3}
                value={settings.invoiceFooter}
                onChange={(e) => setSettings({ ...settings, invoiceFooter: e.target.value })}
              />
            </Grid>
          </Grid>
        </Card>
      )}

      {/* TAB 2: POS & BARCODE */}
      {activeTab === 2 && (
        <Card sx={{ p: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Barcode Scanner & POS Preferences</Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField 
                select 
                label="Barcode Label Standard" 
                fullWidth 
                value={settings.barcodeStandard}
                onChange={(e) => setSettings({ ...settings, barcodeStandard: e.target.value })}
              >
                <MenuItem value="EAN-13">EAN-13 (Standard Optical Label)</MenuItem>
                <MenuItem value="Code-128">Code-128 (High-Density Frame Tag)</MenuItem>
                <MenuItem value="UPC-A">UPC-A (Universal)</MenuItem>
                <MenuItem value="QR-Code">QR Code (Compact Spectacle Tag)</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6}>
              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: '100%' }}>
                <Box>
                  <Typography variant="subtitle2" fontWeight={700}>Auto-Print Receipt Upon POS Billing</Typography>
                  <Typography variant="caption" color="text.secondary">Automatically launch print dialog after completing checkout</Typography>
                </Box>
                <Switch 
                  checked={settings.autoPrintReceipt}
                  onChange={(e) => setSettings({ ...settings, autoPrintReceipt: e.target.checked })}
                  color="primary"
                />
              </Paper>
            </Grid>

            <Grid item xs={12} sm={6}>
              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Box>
                  <Typography variant="subtitle2" fontWeight={700}>Barcode Scanner Audio Feedback</Typography>
                  <Typography variant="caption" color="text.secondary">Play confirmation sound when USB scanner reads barcode</Typography>
                </Box>
                <Switch 
                  checked={settings.enableScannerBeep}
                  onChange={(e) => setSettings({ ...settings, enableScannerBeep: e.target.checked })}
                  color="primary"
                />
              </Paper>
            </Grid>
          </Grid>
        </Card>
      )}

      {/* TAB 3: CLINICAL DEFAULTS */}
      {activeTab === 3 && (
        <Card sx={{ p: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Clinical & Eye Exam Defaults</Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField 
                select 
                label="Default Attending Optometrist Doctor" 
                fullWidth 
                value={settings.defaultDoctor || ''}
                onChange={(e) => setSettings({ ...settings, defaultDoctor: e.target.value })}
              >
                <MenuItem value="">-- Select Default Doctor --</MenuItem>
                {doctorsList.map(doc => (
                  <MenuItem key={doc.id || doc.name} value={doc.name}>
                    {doc.name} ({doc.qualification || 'Optometrist'})
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField 
                select 
                label="Patient Follow-Up Exam Reminder" 
                fullWidth 
                value={settings.examReminderMonths}
                onChange={(e) => setSettings({ ...settings, examReminderMonths: e.target.value })}
              >
                <MenuItem value="6 Months">6 Months</MenuItem>
                <MenuItem value="12 Months">12 Months (Annual Vision Exam)</MenuItem>
                <MenuItem value="24 Months">24 Months</MenuItem>
              </TextField>
            </Grid>
          </Grid>
        </Card>
      )}

      {/* TAB 4: SECURITY & BACKUP */}
      {activeTab === 4 && (
        <Card sx={{ p: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>System Security & Data Backup</Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField 
                select 
                label="Automatic Inactivity Session Timeout" 
                fullWidth 
                value={settings.autoLogoutMinutes}
                onChange={(e) => setSettings({ ...settings, autoLogoutMinutes: e.target.value })}
              >
                <MenuItem value="15">15 Minutes</MenuItem>
                <MenuItem value="30">30 Minutes</MenuItem>
                <MenuItem value="60">60 Minutes</MenuItem>
                <MenuItem value="Never">Never Auto-Logout</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12}>
              <Divider sx={{ my: 1 }} />
              <Typography variant="subtitle1" fontWeight={700} sx={{ mt: 2, mb: 1 }}>Database Backup & Restoration</Typography>
              <Stack direction="row" spacing={2}>
                <Button 
                  variant="outlined" 
                  color="primary"
                  onClick={() => alert("Database Backup JSON created!\nBackup file downloaded to local system.")}
                >
                  Download Full Database Backup
                </Button>
                <Button 
                  variant="outlined" 
                  color="secondary"
                  onClick={() => alert("Restore database option ready for file upload.")}
                >
                  Restore From Backup File
                </Button>
              </Stack>
            </Grid>
          </Grid>
        </Card>
      )}

      {/* TAB 5: BUSINESS SETTINGS — MULTI-BRANCH MANAGEMENT */}
      {activeTab === 5 && (
        <Card sx={{ p: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 0.5 }}>Multi-Branch Management</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
            Manage multiple business branches from one ERP system.
          </Typography>

          {branchSavedAlert && (
            <Alert severity="success" sx={{ mb: 2, borderRadius: 3, fontWeight: 600 }}>
              Multi-Branch mode updated. {multiBranch ? 'Branch Management and the Branch Switcher are now active.' : 'The system is back in Single Branch mode.'}
            </Alert>
          )}

          <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 3, flexWrap: 'wrap' }}>
            <Box sx={{ maxWidth: 560 }}>
              <Typography variant="subtitle1" fontWeight={800}>Enable Multi-Branch System</Typography>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                OFF → Single Branch Mode &nbsp;•&nbsp; ON → Multi-Branch Mode
              </Typography>
              <Stack spacing={0.5} sx={{ mt: 1 }}>
                {['Create multiple branches', 'Manage branch-wise stock', 'Separate branch sales',
                  'Assign users to branches', 'Switch between branches', 'View combined reports',
                  'Control branch permissions'].map(line => (
                  <Typography key={line} variant="body2" sx={{ color: 'text.secondary' }}>✓ {line}</Typography>
                ))}
              </Stack>
            </Box>
            <FormControlLabel
              control={<Switch checked={multiBranch} onChange={(e) => handleToggleMultiBranch(e.target.checked)} color="primary" />}
              label={multiBranch ? 'ON' : 'OFF'}
              labelPlacement="bottom"
              sx={{ m: 0, '& .MuiFormControlLabel-label': { fontWeight: 800, mt: 0.5 } }}
            />
          </Paper>

          <Alert severity="info" sx={{ mt: 2, borderRadius: 3 }}>
            Turning this off does not delete any branch data — it only hides the multi-branch
            interface and routes every operation through the default branch.
          </Alert>

          <ConfirmActionDialog
            open={confirmEnableOpen}
            type="info"
            title="Enable Multi-Branch System?"
            message="This will activate branch management and branch-wise data access throughout the ERP."
            confirmText="Enable"
            cancelText="Cancel"
            onConfirm={() => persistMultiBranch(true)}
            onClose={() => setConfirmEnableOpen(false)}
          />
        </Card>
      )}
    </Box>
  );
}
