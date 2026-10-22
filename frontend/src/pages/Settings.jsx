import React, { useState, useEffect, useRef, useCallback } from 'react';
import { 
  Box, Card, CardContent, Typography, Button, Tab, Tabs, 
  Grid, TextField, MenuItem, Stack, Switch, FormControlLabel, 
  Alert, Paper
} from '@mui/material';
import {
  Storefront as StoreIcon,
  Public as LocalizationIcon,
  Security as SecurityIcon,
  Save as SaveIcon,
  CheckCircle as SuccessIcon,
  AccountTree as BranchTreeIcon,
  DesignServices as DesignerIcon,
  LocalOffer as LabelIcon,
  AccountBalance as BankIcon
} from '@mui/icons-material';
import { useLocation } from 'react-router-dom';
import axios from 'axios';
import { useBranch } from '../context/BranchContext';
import ConfirmActionDialog from '../components/common/ConfirmActionDialog';
import BillDesignerDashboard from '../components/settings/billing/BillDesignerDashboard';
import BarcodeLabelSettings from '../components/settings/BarcodeLabelSettings';
import BankMasterSettings from '../components/settings/BankMasterSettings';
import StoreProfileSettings from '../components/settings/store/StoreProfileSettings';
import BusinessLocalizationSettings from '../components/settings/business/BusinessLocalizationSettings';
import SystemSecuritySettings from '../components/settings/security/SystemSecuritySettings';
import { GREEN, greenButtonSx } from '../components/settings/store/storeUi';
import { STORE_PROFILE_EVENT } from '../utils/storeProfile';

// Deep-link ids for /settings?tab=<id> (e.g. the barcode print dialog's
// "Label Settings" button). Index = tab position. Business & Localization also takes
// &section=<general|currency|tax|numbering|other|fields>.
const TAB_IDS = ['store', 'localization', 'security', 'business', 'bill-designer', 'barcode-labels', 'banks'];
// Retired ids still linked from elsewhere: the old "Billing & Tax Config", "POS & Barcode Scanner" and
// "Clinical & Eye Exam Defaults" tabs.
const TAB_ALIASES = { billing: 'localization', pos: 'barcode-labels', clinical: 'store' };
const LOCALIZATION_TAB = 1;
const SECURITY_TAB = 2;
// Keys of retired tabs (Billing & Tax → Business & Localization; Clinical & Eye Exam Defaults) to drop from the local blob.
// autoLogoutMinutes: the inactivity timeout is now a server-enforced policy (System Security & Backup).
const RETIRED_KEYS = ['currency', 'defaultGst', 'invoicePrefix', 'invoiceFooter', 'defaultDoctor', 'examReminderMonths',
  'autoLogoutMinutes'];

// Keys of the legacy local settings blob that now belong to the store profile (written only by
// utils/storeProfile's cache) — the other tabs' save must never overwrite them.
const STORE_KEYS = ['storeName', 'displayName', 'storePhone', 'storeEmail', 'website', 'tagline', 'address',
  'city', 'state', 'pincode', 'documentAddress', 'gstin'];

// Administration's legacy branch list mirrors the main branch's contact details.
function syncLegacyMainBranch(p) {
  try {
    const saved = JSON.parse(localStorage.getItem('optical_branches') || '[]');
    const address = [p.address, p.city, p.state, p.pin_code].filter(Boolean).join(', ');
    const updated = saved.map((b) => (b.id === 'main' || b.name === 'Main Branch'
      ? { ...b, phone: p.phone || b.phone || '—', email: p.email || b.email || '—', gstin: p.gstin || b.gstin || '—', address: address || b.address || '—' }
      : b));
    localStorage.setItem('optical_branches', JSON.stringify(updated));
    window.dispatchEvent(new Event('optical_branches_updated'));
  } catch { /* storage unavailable */ }
}

export default function Settings() {
  const location = useLocation();
  const tabFromUrl = () => {
    const id = new URLSearchParams(location.search).get('tab');
    return Math.max(0, TAB_IDS.indexOf(TAB_ALIASES[id] || id));
  };
  const sectionFromUrl = new URLSearchParams(location.search).get('section') || 'general';
  const [activeTab, setActiveTab] = useState(tabFromUrl);
  const storeRef = useRef(null);
  const [storeState, setStoreState] = useState({ dirty: false, saving: false, canSave: false });
  const onStoreState = useCallback((st) => setStoreState(st), []);
  const bizRef = useRef(null);
  const [bizState, setBizState] = useState({ dirty: false, saving: false, canSave: false });
  const onBizState = useCallback((st) => setBizState(st), []);
  const securityRef = useRef(null);
  const [securityState, setSecurityState] = useState({ dirty: false, saving: false, canSave: false });
  const onSecurityState = useCallback((st) => setSecurityState(st), []);
  const [pendingTab, setPendingTab] = useState(null);

  // Tabs holding their own unsaved form (Store & Clinic Profile, Business & Localization, Security).
  const formTab = activeTab === 0 ? { ref: storeRef, state: storeState, name: 'Store & Clinic Profile' }
    : activeTab === LOCALIZATION_TAB ? { ref: bizRef, state: bizState, name: 'Business & Localization settings' }
      : activeTab === SECURITY_TAB ? { ref: securityRef, state: securityState, name: 'security settings' }
        : null;

  // Leaving such a tab with unsaved edits asks first (never silently discards).
  const changeTab = (val) => {
    if (val === activeTab) return;
    if (formTab?.state.dirty) { setPendingTab(val); return; }
    setActiveTab(val);
  };
  const openTabById = (id) => changeTab(Math.max(0, TAB_IDS.indexOf(TAB_ALIASES[id] || id)));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (location.search) changeTab(tabFromUrl()); }, [location.search]);
  const { multiBranchEnabled, refresh: refreshBranchContext } = useBranch();
  const [multiBranch, setMultiBranch] = useState(false);
  const [confirmEnableOpen, setConfirmEnableOpen] = useState(false);
  const [branchSavedAlert, setBranchSavedAlert] = useState(false);
  const [branchError, setBranchError] = useState('');

  useEffect(() => { setMultiBranch(multiBranchEnabled); }, [multiBranchEnabled]);

  const persistMultiBranch = async (value) => {
    setMultiBranch(value);
    setBranchError('');
    try {
      const { data } = await axios.patch('/api/company/business-settings/', { multi_branch_enabled: value });
      // The request succeeded but the value did not stick — the backend DB is read-only or
      // ephemeral (e.g. serverless SQLite). Surface it instead of silently snapping back.
      if (data && typeof data.multi_branch_enabled === 'boolean' && data.multi_branch_enabled !== value) {
        setMultiBranch(!value);
        setBranchError('The server accepted the change but did not save it. The production '
          + 'database looks read-only or temporary — configure a persistent database (DATABASE_URL) '
          + 'on the backend.');
        return;
      }
      await refreshBranchContext();
      setBranchSavedAlert(true);
      setTimeout(() => setBranchSavedAlert(false), 4000);
    } catch (e) {
      setMultiBranch(!value); // revert on failure
      const msg = e?.response?.data?.detail
        || (e?.response?.status ? `Server responded ${e.response.status} ${e.response.statusText || ''}`.trim() : '')
        || e?.message
        || 'Could not reach the backend server.';
      setBranchError(`Couldn't ${value ? 'enable' : 'disable'} Multi-Branch mode. ${msg}`);
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
        barcodeStandard: 'EAN-13',
        autoPrintReceipt: true,
        enableScannerBeep: true,
      };
    } catch (e) {
      return {
        barcodeStandard: 'EAN-13', autoPrintReceipt: true, enableScannerBeep: true,
      };
    }
  });

  useEffect(() => {
    const onProfile = (e) => {
      if (e.detail) syncLegacyMainBranch(e.detail);
    };
    window.addEventListener(STORE_PROFILE_EVENT, onProfile);
    return () => window.removeEventListener(STORE_PROFILE_EVENT, onProfile);
  }, []);

  const [savedAlert, setSavedAlert] = useState(false);
  const [saveError, setSaveError] = useState('');

  // Save for the remaining device-local preference tabs (barcode scanner).
  const handleSaveSettings = () => {
    setSaveError('');
    try {
      const current = JSON.parse(localStorage.getItem('optical_app_settings') || '{}');
      RETIRED_KEYS.forEach((k) => { delete current[k]; });
      const rest = Object.fromEntries(Object.entries(settings).filter(([k]) => !STORE_KEYS.includes(k) && !RETIRED_KEYS.includes(k)));
      localStorage.setItem('optical_app_settings', JSON.stringify({ ...current, ...rest }));
    } catch (e) {
      setSaveError('These preferences could not be saved — browser storage is unavailable.');
      return;
    }
    setSavedAlert(true);
    setTimeout(() => setSavedAlert(false), 4000);
  };

  const handleHeaderSave = () => (formTab ? formTab.ref.current?.save() : handleSaveSettings());
  const isLocalization = activeTab === LOCALIZATION_TAB;

  return (
    <Box sx={{ p: { xs: 2, sm: 3, md: 4 }, pb: 8, maxWidth: '100%', overflowX: 'hidden' }}>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" component="h1" fontWeight={800} sx={{ fontSize: { xs: '1.5rem', sm: '2.125rem' } }}>
            {isLocalization ? 'Business & Localization Settings' : 'Application & Store Configuration'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            {activeTab === 0
              ? 'Manage your store identity, contact details and clinic information'
              : isLocalization
                ? 'Configure regional settings, currency, language, tax, numbering sequences, and other preferences.'
                : activeTab === SECURITY_TAB
                  ? 'Manage security, backups, and recovery settings for your optical business.'
                  : 'Configure optical store profile, business & localization, POS barcode rules, and system preferences'}
          </Typography>
        </Box>
        <Button
          variant="contained"
          startIcon={<SaveIcon />}
          onClick={handleHeaderSave}
          disabled={!!formTab && (formTab.state.saving || !formTab.state.canSave || !formTab.state.dirty)}
          sx={{ ...greenButtonSx, px: 3, py: 1 }}
        >
          {formTab?.state.saving ? 'Saving…' : 'Save Changes'}
        </Button>
      </Box>

      {saveError && !formTab && (
        <Alert severity="warning" onClose={() => setSaveError('')} sx={{ mb: 3, borderRadius: 3, fontWeight: 600 }}>{saveError}</Alert>
      )}

      {savedAlert && !formTab && (
        <Alert severity="success" icon={<SuccessIcon />} sx={{ mb: 3, borderRadius: 3, fontWeight: 600 }}>
          Application settings updated and saved to system database!
        </Alert>
      )}

      {/* Tabs */}
      <Card sx={{ mb: 3, borderRadius: 3 }}>
        <Tabs
          value={activeTab}
          onChange={(e, val) => changeTab(val)}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="Configuration sections"
          sx={{
            px: 2, borderBottom: 1, borderColor: 'divider',
            '& .MuiTabs-indicator': { bgcolor: GREEN, height: 3 },
            '& .MuiTab-root.Mui-selected': { color: GREEN },
          }}
        >
          <Tab label="Store & Clinic Profile" icon={<StoreIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="Business & Localization" icon={<LocalizationIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="System Security & Backup" icon={<SecurityIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="Business Settings" icon={<BranchTreeIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="Bill & Invoice Designer" icon={<DesignerIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="Barcode Labels" icon={<LabelIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
          <Tab label="Bank Master" icon={<BankIcon />} iconPosition="start" sx={{ fontWeight: 700 }} />
        </Tabs>
      </Card>

      {/* TAB 4: BILL & INVOICE DESIGNER */}
      {activeTab === 4 && <BillDesignerDashboard />}

      {/* TAB 5: BARCODE LABELS — scanner/POS preferences + label design (used by every barcode Print dialog) */}
      {activeTab === 5 && (
        <>
          <Card sx={{ p: 3, mb: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
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
          <BarcodeLabelSettings />
        </>
      )}

      {/* TAB 6: BANK MASTER (banks offered on Bank / UPI payments) */}
      {activeTab === 6 && <BankMasterSettings />}

      {/* TAB 0: STORE & CLINIC PROFILE */}
      {activeTab === 0 && (
        <StoreProfileSettings ref={storeRef} onStateChange={onStoreState} onOpenTab={openTabById} />
      )}

      {/* TAB 1: BUSINESS & LOCALIZATION (regional defaults, currency, tax, numbering, custom fields) */}
      {activeTab === LOCALIZATION_TAB && (
        <BusinessLocalizationSettings ref={bizRef} initialSection={sectionFromUrl} onStateChange={onBizState} />
      )}

      {/* TAB 2: SYSTEM SECURITY & BACKUP — session policy, backup health / schedule / recovery, audit */}
      {activeTab === SECURITY_TAB && (
        <SystemSecuritySettings ref={securityRef} onStateChange={onSecurityState} />
      )}

      {/* TAB 3: BUSINESS SETTINGS — MULTI-BRANCH MANAGEMENT */}
      {activeTab === 3 && (
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

          {branchError && (
            <Alert severity="error" onClose={() => setBranchError('')} sx={{ mb: 2, borderRadius: 3, fontWeight: 600 }}>
              {branchError}
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

      <ConfirmActionDialog
        open={pendingTab !== null}
        type="warning"
        title="Discard unsaved changes?"
        message={`You have unsaved changes to the ${formTab?.name || 'settings'}. Discard them and switch sections?`}
        confirmText="Discard changes"
        cancelText="Keep editing"
        onConfirm={() => { formTab?.ref.current?.discard(); setActiveTab(pendingTab); setPendingTab(null); }}
        onClose={() => setPendingTab(null)}
      />
    </Box>
  );
}
