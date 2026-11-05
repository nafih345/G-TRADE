// Client Management (/superadmin/tenants) — the platform owner's console for client businesses.
//
// Onboards a client (POST /api/superadmin/tenants/: tenant + its Super Admin + Head Office branch,
// with its package / modules and seat limit, one transaction) whose admin can sign in on the main
// login page straight away; lists clients by status (active / scheduled / deactivated) and opens
// a client's workspace (components/superadmin/ClientWorkspaceDialog: modules & role permissions,
// users, branches, deactivation with reason and history). Only user.is_platform_admin reaches
// this page (route guard in App.jsx, sidebar link); the API refuses everyone else with 403. Writes
// may ask for the password again first — sessionGuard / ReauthDialogHost handle that and retry.
//
// Keyboard: Enter moves to the next form field and submits from the last one (App.jsx's global
// Enter chain) · "/" focuses search, Esc clears it · Esc closes dialogs.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Box, Typography, Card, Stack, TextField, Button, IconButton, InputAdornment, Alert, AlertTitle,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Chip, Tooltip, LinearProgress,
  CircularProgress, Grid, Divider, Tabs, Tab, Collapse,
} from '@mui/material';
import {
  Visibility, VisibilityOff, ContentCopy as CopyIcon, Refresh as RefreshIcon, Search as SearchIcon,
  PersonAddAlt1 as OnboardIcon, Tune as ManageIcon, PowerSettingsNew as PowerIcon,
  AutoAwesome as GenerateIcon, ExpandMore as ExpandIcon, ExpandLess as CollapseIcon, Storage as DataIcon,
  Login as EnterIcon,
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../utils/apiError';
import { notify } from '../utils/notify';
import ModuleAccessEditor from '../components/superadmin/ModuleAccessEditor';
import ClientWorkspaceDialog, { WORKSPACE_TABS } from '../components/superadmin/ClientWorkspaceDialog';
import { DeactivateDialog, ReactivateDialog } from '../components/superadmin/LifecycleDialogs';
import {
  API, STATUS_META, copy, fmtDate, generatePassword, isReauth, packageLabel, splitErrors,
} from '../components/superadmin/clientApi';

const EMPTY_FORM = {
  tenant_name: '', admin_username: '', password: '', admin_email: '', contact_phone: '', branch_name: '',
  max_users: '5',
};
const FORM_FIELDS = [...Object.keys(EMPTY_FORM), 'modules', 'settings_features'];
const REQUIRED = { tenant_name: 'Shop / client name', admin_username: 'Admin username', password: 'Password' };
const fullSuite = (catalog) => ({
  package: 'FULL_SUITE', modules: [...catalog.packages.find((p) => p.key === 'FULL_SUITE').modules],
  settings_features: null,
});

function OnboardForm({ catalog, onCreated }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [subscription, setSubscription] = useState(() => fullSuite(catalog));
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const firstRef = useRef(null);

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const reset = () => {
    setForm(EMPTY_FORM);
    setSubscription(fullSuite(catalog));
    setErrors({});
    setGeneral('');
  };

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    const missing = {};
    Object.entries(REQUIRED).forEach(([key, label]) => {
      if (!String(form[key]).trim()) missing[key] = `${label} cannot be empty.`;
    });
    const seats = Number(form.max_users);
    if (!Number.isInteger(seats) || seats < 1) missing.max_users = 'Allow at least one user (the client’s admin).';
    setGeneral('');
    if (Object.keys(missing).length) {
      setErrors(missing);
      return;
    }
    setSaving(true);
    try {
      const { data } = await axios.post(API, {
        ...form, tenant_name: form.tenant_name.trim(), admin_username: form.admin_username.trim(),
        max_users: seats, package: subscription.package, modules: subscription.modules,
        ...(subscription.modules.includes('settings') ? { settings_features: subscription.settings_features } : {}),
      });
      onCreated({ tenant: data, password: form.password });
      reset();
      setShowPassword(false);
      firstRef.current?.focus();
    } catch (err) {
      if (isReauth(err)) return; // dialog took over
      const { fields, general: msg } = splitErrors(err, FORM_FIELDS, 'The client could not be created.');
      setErrors(fields);
      setGeneral(msg);
    } finally {
      setSaving(false);
    }
  };

  const field = (key, label, props = {}) => (
    <TextField
      fullWidth size="small" label={label} value={form[key]} onChange={set(key)}
      required={key in REQUIRED} error={Boolean(errors[key])} helperText={errors[key] || props.helperText || ' '}
      disabled={saving} {...props}
    />
  );

  return (
    <Card variant="outlined" sx={{ p: { xs: 2, md: 3 } }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.5 }}>
        <OnboardIcon color="primary" />
        <Typography variant="h6" fontWeight={700}>Onboard New Optical Client</Typography>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Creates the client’s separate account, its Super Admin login and a first branch. The admin can sign in
        on the main login page immediately.
      </Typography>
      {general && <Alert severity="error" sx={{ mb: 2 }}>{general}</Alert>}
      <Box component="form" noValidate onSubmit={submit} aria-label="Onboard new optical client">
        <Grid container columnSpacing={2}>
          <Grid item xs={12} md={6}>
            {field('tenant_name', 'Shop / Client Name', { inputRef: firstRef, autoFocus: true, placeholder: 'City Opticals UAE', inputProps: { maxLength: 150 } })}
          </Grid>
          <Grid item xs={12} md={6}>
            {field('branch_name', 'First Branch Name', { placeholder: 'Head Office', helperText: 'Optional — defaults to “Head Office”.', inputProps: { maxLength: 100 } })}
          </Grid>
          <Grid item xs={12} md={6}>
            {field('admin_username', 'Admin Username', { autoComplete: 'off', inputProps: { maxLength: 150, spellCheck: false } })}
          </Grid>
          <Grid item xs={12} md={6}>
            {field('password', 'Password', {
              type: showPassword ? 'text' : 'password',
              autoComplete: 'new-password',
              InputProps: {
                endAdornment: (
                  <InputAdornment position="end">
                    <Tooltip title="Generate a strong password">
                      <IconButton size="small" aria-label="Generate a strong password" disabled={saving}
                        onClick={() => { setForm((f) => ({ ...f, password: generatePassword() })); setShowPassword(true); setErrors((x) => ({ ...x, password: undefined })); }}>
                        <GenerateIcon fontSize="small" />
                      </IconButton>
                    </Tooltip>
                    <IconButton size="small" aria-label={showPassword ? 'Hide password' : 'Show password'}
                      onClick={() => setShowPassword((v) => !v)} edge="end">
                      {showPassword ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                    </IconButton>
                  </InputAdornment>
                ),
              },
            })}
          </Grid>
          <Grid item xs={12} md={4}>
            {field('admin_email', 'Email', { type: 'email', helperText: 'Optional' })}
          </Grid>
          <Grid item xs={12} md={4}>
            {field('contact_phone', 'Phone', { type: 'tel', helperText: 'Optional', inputProps: { maxLength: 20 } })}
          </Grid>
          <Grid item xs={12} md={4}>
            {field('max_users', 'User Limit (seats)', {
              type: 'number', required: true, inputProps: { min: 1, max: 10000 },
              helperText: 'Active accounts allowed, admin included.',
            })}
          </Grid>
        </Grid>
        <Divider sx={{ my: 2 }} />
        <Typography variant="subtitle1" fontWeight={700}>Module Access</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Pick a package or switch modules one by one. Role permissions, more users and more branches are set
          from the client’s workspace (Manage) after creating it.
        </Typography>
        {(errors.modules || errors.settings_features) && <Alert severity="error" sx={{ mb: 1.5 }}>{errors.modules || errors.settings_features}</Alert>}
        <ModuleAccessEditor catalog={catalog} value={subscription} disabled={saving}
          onChange={(v) => { setSubscription(v); setErrors((x) => ({ ...x, modules: undefined })); }} />
        <Stack direction="row" spacing={1.5} justifyContent="flex-end" sx={{ mt: 2 }}>
          <Button type="button" onClick={reset} disabled={saving}>
            Clear
          </Button>
          <Button type="submit" variant="contained" disabled={saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <OnboardIcon />}>
            {saving ? 'Creating…' : 'Create Client'}
          </Button>
        </Stack>
      </Box>
    </Card>
  );
}

function SuccessBanner({ created, onClose }) {
  const { tenant, password } = created;
  const loginUrl = `${window.location.origin}${window.location.pathname}#/`;
  const credentials = `Login: ${loginUrl}\nUsername: ${tenant.admin_username}\nPassword: ${password}`;
  return (
    <Alert severity="success" onClose={onClose} sx={{ '& .MuiAlert-message': { width: '100%' } }}>
      <AlertTitle>“{tenant.name}” is ready — Tenant ID #{tenant.id}</AlertTitle>
      <Typography variant="body2" sx={{ mb: 1 }}>
        Share these credentials with the client. The password is shown only now.
      </Typography>
      <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.5, m: 0, fontSize: 14 }}>
        <dt>Login page</dt><dd style={{ margin: 0, wordBreak: 'break-all' }}>{loginUrl}</dd>
        <dt>Username</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{tenant.admin_username}</dd>
        <dt>Password</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{password}</dd>
      </Box>
      <Button size="small" startIcon={<CopyIcon />} sx={{ mt: 1 }} onClick={() => copy(credentials)}>
        Copy credentials
      </Button>
    </Alert>
  );
}

// [key, tab label, row test]. "Active" includes clients with a deactivation still to come.
const FILTERS = [
  ['ACTIVE', 'Active Clients & Shops', (t) => t.status !== 'INACTIVE'],
  ['SCHEDULED', 'Scheduled', (t) => t.status === 'SCHEDULED'],
  ['INACTIVE', 'Deactivated', (t) => t.status === 'INACTIVE'],
  ['ALL', 'All', () => true],
];

export default function TenantManagement() {
  const { openWorkspace: openClientWorkspace } = useAuth();
  const [enteringId, setEnteringId] = useState(null);
  // Switch this browser into the client's own workspace (separate audited session; see AuthContext).
  const enterWorkspace = async (t) => {
    if (!window.confirm(`Open ${t.name}'s workspace?

Everything you create or change there belongs to ${t.name}. `
      + 'Use "Return to platform" in the yellow bar to come back.')) return;
    setEnteringId(t.id);
    try {
      await openClientWorkspace(t.id);
    } catch (err) {
      if (!isReauth(err)) notify(`Could not open ${t.name}'s workspace: ${apiErrorMessage(err)}`, 'error');
      setEnteringId(null);
    }
  };
  const [catalog, setCatalog] = useState(null);
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [created, setCreated] = useState(null);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('ACTIVE');
  const [workspaceId, setWorkspaceId] = useState(null);
  const [workspaceTab, setWorkspaceTab] = useState(WORKSPACE_TABS.overview);
  const openWorkspace = (id, tab = WORKSPACE_TABS.overview) => { setWorkspaceTab(tab); setWorkspaceId(id); };
  const [lifecycle, setLifecycle] = useState(null); // tenant row being (de)activated
  const [showOnboard, setShowOnboard] = useState(true);
  const searchRef = useRef(null);
  const catalogRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data }, cat] = await Promise.all([
        axios.get(API),
        catalogRef.current ? Promise.resolve(catalogRef.current) : axios.get(`${API}catalog/`).then((r) => r.data),
      ]);
      catalogRef.current = cat;
      setCatalog(cat);
      setTenants(Array.isArray(data) ? data : data.results || []);
      setLoadError('');
    } catch (err) {
      setLoadError(apiErrorMessage(err, 'Could not load the client list.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const tag = (e.target?.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || e.target?.isContentEditable) return;
      e.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const onCreated = (result) => {
    setCreated(result);
    setFilter('ACTIVE');
    load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // A row (or a full client detail, a superset of it) came back from a save: replace it in place.
  const updateRow = (row) => setTenants((rows) => rows.map((r) => (r.id === row.id ? { ...r, ...row } : r)));

  const lifecycleDone = (row) => {
    setLifecycle(null);
    updateRow(row);
    notify(`${row.name}: ${STATUS_META[row.status].label.toLowerCase()}.`, 'success');
  };

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map(([key, , test]) => [key, tenants.filter(test).length])),
    [tenants],
  );

  const shown = useMemo(() => {
    const test = FILTERS.find(([key]) => key === filter)[2];
    const q = search.trim().toLowerCase();
    return tenants.filter(test).filter((t) => !q
      || [t.name, t.code, t.primary_admin, String(t.id), t.contact_email, t.contact_phone]
        .some((v) => String(v || '').toLowerCase().includes(q)));
  }, [tenants, search, filter]);

  const lifecycleView = filter === 'INACTIVE' || filter === 'SCHEDULED';
  const moduleNames = (t) => (t.modules || []).map((m) => catalog?.modules.find((x) => x.key === m)?.label || m).join(', ');

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1360, mx: 'auto' }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" fontWeight={800}>Tenant &amp; Client Management</Typography>
        <Typography variant="body2" color="text.secondary">
          Each client is a separate business with its own data, modules, users and branches.
        </Typography>
      </Box>

      <Stack spacing={3}>
        {created && <SuccessBanner created={created} onClose={() => setCreated(null)} />}

        {!catalog && loading && <LinearProgress />}
        {!catalog && loadError && <Alert severity="error">{loadError}</Alert>}

        {catalog && (
          <Box>
            <Button size="small" onClick={() => setShowOnboard((v) => !v)} endIcon={showOnboard ? <CollapseIcon /> : <ExpandIcon />} sx={{ mb: 1 }}>
              {showOnboard ? 'Hide onboarding form' : 'Onboard a new client'}
            </Button>
            <Collapse in={showOnboard}>
              <OnboardForm catalog={catalog} onCreated={onCreated} />
            </Collapse>
          </Box>
        )}

        <Card variant="outlined">
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}
            justifyContent="space-between" sx={{ px: 2, pt: 2 }}>
            <Box>
              <Typography variant="h6" fontWeight={700}>Clients &amp; Shops</Typography>
              <Typography variant="body2" color="text.secondary">
                {tenants.length} clients · {counts.ACTIVE - counts.SCHEDULED} active · {counts.SCHEDULED} scheduled to deactivate · {counts.INACTIVE} deactivated
              </Typography>
            </Box>
            <Stack direction="row" spacing={1} alignItems="center">
              <TextField
                size="small" placeholder="Search  ( / )" value={search} onChange={(e) => setSearch(e.target.value)}
                inputRef={searchRef} inputProps={{ 'aria-label': 'Search clients' }}
                onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur(); } }}
                InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
              />
              <Tooltip title="Refresh">
                <span>
                  <IconButton onClick={load} disabled={loading} aria-label="Refresh client list"><RefreshIcon /></IconButton>
                </span>
              </Tooltip>
            </Stack>
          </Stack>
          <Tabs value={filter} onChange={(_, v) => setFilter(v)} variant="scrollable"
            sx={{ px: 1, borderBottom: 1, borderColor: 'divider' }} aria-label="Client status filter">
            {FILTERS.map(([key, label]) => <Tab key={key} value={key} label={`${label} (${counts[key] ?? 0})`} />)}
          </Tabs>
          {loading && <LinearProgress />}
          {catalog && loadError && <Alert severity="error" sx={{ m: 2 }}>{loadError}</Alert>}
          <TableContainer>
            <Table size="small" aria-label="Clients">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
                  <TableCell>ID</TableCell>
                  <TableCell>Client / Shop</TableCell>
                  <TableCell>Admin Username</TableCell>
                  <TableCell>Package</TableCell>
                  <TableCell align="right">Seats</TableCell>
                  <TableCell align="right">Branches</TableCell>
                  {lifecycleView ? (
                    <>
                      <TableCell>Effective</TableCell>
                      <TableCell>Reason</TableCell>
                    </>
                  ) : <TableCell>Created</TableCell>}
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {shown.map((t) => {
                  const status = STATUS_META[t.status] || STATUS_META.ACTIVE;
                  const category = catalog?.deactivation_categories.find((c) => c.key === t.deactivation_category)?.label;
                  return (
                    <TableRow key={t.id} hover sx={{ opacity: t.status === 'INACTIVE' ? 0.75 : 1, cursor: 'pointer' }}
                      onClick={() => openWorkspace(t.id)}>
                      <TableCell>#{t.id}</TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600}>{t.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {t.code}{t.is_platform ? ' · platform account' : ''}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{t.primary_admin || '—'}</TableCell>
                      <TableCell>
                        <Tooltip title={moduleNames(t)}>
                          <Chip size="small" variant="outlined" label={`${packageLabel(catalog, t.package)} · ${(t.modules || []).length} modules`} />
                        </Tooltip>
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap', color: t.active_user_count >= t.max_users ? 'warning.main' : 'inherit' }}>
                        {t.active_user_count} / {t.max_users}
                      </TableCell>
                      <TableCell align="right">{t.branch_count}</TableCell>
                      {lifecycleView ? (
                        <>
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>
                            {fmtDate(t.deactivation_effective_date)}
                            {t.deactivation_until && (
                              <Typography variant="caption" color="text.secondary" component="div">until {fmtDate(t.deactivation_until)}</Typography>
                            )}
                          </TableCell>
                          <TableCell sx={{ maxWidth: 280 }}>
                            <Typography variant="caption" fontWeight={700} component="div">{category || '—'}</Typography>
                            <Typography variant="caption" color="text.secondary" component="div" noWrap title={t.deactivation_reason}>
                              {t.deactivation_reason}
                            </Typography>
                            <Typography variant="caption" color="text.secondary" component="div">by {t.deactivated_by || '—'}</Typography>
                          </TableCell>
                        </>
                      ) : <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(t.created_at)}</TableCell>}
                      <TableCell>
                        <Chip size="small" label={status.label} color={status.color}
                          variant={t.status === 'INACTIVE' ? 'outlined' : 'filled'} />
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                        <Button size="small" startIcon={<ManageIcon />} onClick={() => openWorkspace(t.id)}
                          aria-label={`Manage ${t.name}`}>
                          Manage
                        </Button>
                        <Tooltip title="Records, audit and backups">
                          <Button size="small" startIcon={<DataIcon />} onClick={() => openWorkspace(t.id, WORKSPACE_TABS.data)}
                            aria-label={`View data of ${t.name}`}>
                            Data
                          </Button>
                        </Tooltip>
                        {!t.is_platform && (
                          <Tooltip title={t.status === 'INACTIVE'
                            ? 'Reactivate the client to work in its workspace'
                            : 'Create and manage records as this client (audited)'}>
                            <span>
                              <Button size="small" startIcon={<EnterIcon />} disabled={t.status === 'INACTIVE' || enteringId === t.id}
                                onClick={() => enterWorkspace(t)} aria-label={`Open the workspace of ${t.name}`}>
                                {enteringId === t.id ? 'Opening…' : 'Open workspace'}
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip title={t.is_platform ? 'The platform account cannot be deactivated' : ''}>
                          <span>
                            <Button size="small" color={t.status === 'ACTIVE' ? 'error' : 'success'} startIcon={<PowerIcon />}
                              disabled={t.is_platform || !catalog} onClick={() => setLifecycle(t)}
                              aria-label={`${t.status === 'ACTIVE' ? 'Deactivate' : 'Reactivate'} ${t.name}`}>
                              {t.status === 'ACTIVE' ? 'Deactivate' : t.status === 'SCHEDULED' ? 'Cancel deactivation' : 'Reactivate'}
                            </Button>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && !shown.length && (
                  <TableRow>
                    <TableCell colSpan={lifecycleView ? 10 : 9} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      {search ? 'No client matches the search.'
                        : filter === 'INACTIVE' ? 'No deactivated clients.'
                          : filter === 'SCHEDULED' ? 'No deactivations scheduled.' : 'No clients yet.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Stack>

      {workspaceId && catalog && (
        <ClientWorkspaceDialog catalog={catalog} tenantId={workspaceId} initialTab={workspaceTab}
          onClose={() => setWorkspaceId(null)} onUpdated={updateRow} />
      )}
      {lifecycle && catalog && (lifecycle.status === 'ACTIVE'
        ? <DeactivateDialog catalog={catalog} tenant={lifecycle} onClose={() => setLifecycle(null)} onDone={lifecycleDone} />
        : <ReactivateDialog tenant={lifecycle} onClose={() => setLifecycle(null)} onDone={lifecycleDone} />)}
    </Box>
  );
}
