// Client Management (/superadmin/tenants) — the platform owner's console for client businesses.
//
// Onboards a client (POST /api/superadmin/tenants/: tenant + its Super Admin + Head Office
// branch, one transaction) whose admin can sign in on the main login page straight away, lists
// every client, and activates / deactivates one. Only user.is_platform_admin reaches this page
// (route guard in App.jsx, sidebar link); the API refuses everyone else with 403. Writes may ask
// for the password again first — sessionGuard / ReauthDialogHost handle that and retry.
//
// Keyboard: Enter moves to the next form field and submits from the last one (App.jsx's global
// Enter chain) · "/" focuses search, Esc clears it · Esc closes the details dialog.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Box, Typography, Card, Stack, TextField, Button, IconButton, InputAdornment, Alert, AlertTitle,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Chip, Tooltip, LinearProgress,
  Dialog, DialogTitle, DialogContent, DialogActions, CircularProgress, Grid, Divider,
} from '@mui/material';
import {
  Visibility, VisibilityOff, ContentCopy as CopyIcon, Refresh as RefreshIcon, Search as SearchIcon,
  PersonAddAlt1 as OnboardIcon, InfoOutlined as DetailsIcon, PowerSettingsNew as PowerIcon,
  AutoAwesome as GenerateIcon,
} from '@mui/icons-material';
import { apiErrorMessage } from '../utils/apiError';
import { notify } from '../utils/notify';

const API = '/api/superadmin/tenants/';

const EMPTY_FORM = {
  tenant_name: '', admin_username: '', password: '', admin_email: '', contact_phone: '', branch_name: '',
};
const REQUIRED = { tenant_name: 'Shop / client name', admin_username: 'Admin username', password: 'Password' };

const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, {
  day: '2-digit', month: 'short', year: 'numeric',
}) : '—');

const generatePassword = () => {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint32Array(14));
  return `${Array.from(bytes, (n) => chars[n % chars.length]).join('')}!7`;
};

// DRF 400 body → { field: 'message' } for the form, plus anything not tied to a field.
const splitErrors = (err) => {
  const data = err?.response?.status === 400 ? err.response.data : null;
  if (!data || typeof data !== 'object') return { fields: {}, general: apiErrorMessage(err, 'The client could not be created.') };
  const fields = {};
  const rest = [];
  Object.entries(data).forEach(([key, value]) => {
    const msg = Array.isArray(value) ? value.join(' ') : String(value);
    if (key in EMPTY_FORM) fields[key] = msg;
    else rest.push(msg);
  });
  return { fields, general: rest.join(' ') };
};

const copy = (text) => {
  navigator.clipboard?.writeText(text).then(() => notify('Copied to clipboard.', 'success'),
    () => notify('Could not copy — select the text instead.', 'warning'));
};

function OnboardForm({ onCreated }) {
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const firstRef = useRef(null);

  const set = (key) => (e) => {
    setForm((f) => ({ ...f, [key]: e.target.value }));
    if (errors[key]) setErrors((x) => ({ ...x, [key]: undefined }));
  };

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    const missing = {};
    Object.entries(REQUIRED).forEach(([key, label]) => {
      if (!String(form[key]).trim()) missing[key] = `${label} cannot be empty.`;
    });
    setGeneral('');
    if (Object.keys(missing).length) {
      setErrors(missing);
      return;
    }
    setSaving(true);
    try {
      const { data } = await axios.post(API, {
        ...form, tenant_name: form.tenant_name.trim(), admin_username: form.admin_username.trim(),
      });
      onCreated({ tenant: data, password: form.password });
      setForm(EMPTY_FORM);
      setErrors({});
      setShowPassword(false);
      firstRef.current?.focus();
    } catch (err) {
      if (err?.response?.status === 403 && err.response.data?.code === 'reauth_required') return; // dialog took over
      const { fields, general: msg } = splitErrors(err);
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
          <Grid item xs={12} md={6}>
            {field('admin_email', 'Email', { type: 'email', helperText: 'Optional' })}
          </Grid>
          <Grid item xs={12} md={6}>
            {field('contact_phone', 'Phone', { type: 'tel', helperText: 'Optional', inputProps: { maxLength: 20 } })}
          </Grid>
        </Grid>
        <Stack direction="row" spacing={1.5} justifyContent="flex-end">
          <Button type="button" onClick={() => { setForm(EMPTY_FORM); setErrors({}); setGeneral(''); }} disabled={saving}>
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

function DetailsDialog({ tenantId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!tenantId) return undefined;
    let live = true;
    setData(null);
    setError('');
    axios.get(`${API}${tenantId}/`)
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((err) => { if (live) setError(apiErrorMessage(err, 'Could not load the client.')); });
    return () => { live = false; };
  }, [tenantId]);

  return (
    <Dialog open={Boolean(tenantId)} onClose={onClose} maxWidth="sm" fullWidth aria-labelledby="tenant-details-title">
      <DialogTitle id="tenant-details-title">{data ? `${data.name} (#${data.id})` : 'Client details'}</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error">{error}</Alert>}
        {!data && !error && <LinearProgress />}
        {data && (
          <Stack spacing={2}>
            <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.5, m: 0, fontSize: 14 }}>
              <dt>Code</dt><dd style={{ margin: 0 }}>{data.code}</dd>
              <dt>Status</dt><dd style={{ margin: 0 }}>{data.is_active ? 'Active' : 'Inactive'}</dd>
              <dt>Created</dt><dd style={{ margin: 0 }}>{fmtDate(data.created_at)}</dd>
              <dt>Email</dt><dd style={{ margin: 0 }}>{data.contact_email || '—'}</dd>
              <dt>Phone</dt><dd style={{ margin: 0 }}>{data.contact_phone || '—'}</dd>
            </Box>
            <Divider />
            <Box>
              <Typography variant="subtitle2" gutterBottom>Users ({data.users.length})</Typography>
              <Table size="small">
                <TableHead><TableRow><TableCell>Username</TableCell><TableCell>Role</TableCell><TableCell>Last sign-in</TableCell></TableRow></TableHead>
                <TableBody>
                  {data.users.map((u) => (
                    <TableRow key={u.id}>
                      <TableCell>{u.username}{!u.is_active && <Chip size="small" label="Disabled" sx={{ ml: 1 }} />}</TableCell>
                      <TableCell>{String(u.role || '').replace(/_/g, ' ')}</TableCell>
                      <TableCell>{u.last_login ? fmtDate(u.last_login) : 'Never'}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Box>
            <Box>
              <Typography variant="subtitle2" gutterBottom>Branches ({data.branches.length})</Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {data.branches.map((b) => (
                  <Chip key={b.id} size="small" variant={b.is_default ? 'filled' : 'outlined'}
                    label={`${b.name} · ${b.code}${b.is_default ? ' (default)' : ''}${b.is_active ? '' : ' — inactive'}`} />
                ))}
                {!data.branches.length && <Typography variant="body2" color="text.secondary">None yet</Typography>}
              </Stack>
            </Box>
          </Stack>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

export default function TenantManagement() {
  const [tenants, setTenants] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [created, setCreated] = useState(null);
  const [search, setSearch] = useState('');
  const [detailsId, setDetailsId] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const searchRef = useRef(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(API);
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
    load();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const toggleActive = async (tenant) => {
    const next = !tenant.is_active;
    if (!next && !window.confirm(
      `Deactivate “${tenant.name}”?\n\nEveryone in this client is signed out now and cannot sign in until you reactivate it. No data is deleted.`,
    )) return;
    setBusyId(tenant.id);
    try {
      const { data } = await axios.post(`${API}${tenant.id}/set-active/`, { is_active: next });
      setTenants((rows) => rows.map((r) => (r.id === data.id ? data : r)));
      notify(`${data.name} is now ${data.is_active ? 'active' : 'inactive'}.`, 'success');
    } catch (err) {
      if (!(err?.response?.status === 403 && err.response.data?.code === 'reauth_required')) {
        notify(apiErrorMessage(err, 'The status could not be changed.'), 'error');
      }
    } finally {
      setBusyId(null);
    }
  };

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return tenants;
    return tenants.filter((t) => [t.name, t.code, t.primary_admin, String(t.id)]
      .some((v) => String(v || '').toLowerCase().includes(q)));
  }, [tenants, search]);

  const activeCount = tenants.filter((t) => t.is_active).length;

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1280, mx: 'auto' }}>
      <Box sx={{ mb: 3 }}>
        <Typography variant="h5" fontWeight={800}>Tenant &amp; Client Management</Typography>
        <Typography variant="body2" color="text.secondary">
          Each client is a separate business with its own data, users and branches.
        </Typography>
      </Box>

      <Stack spacing={3}>
        {created && <SuccessBanner created={created} onClose={() => setCreated(null)} />}

        <OnboardForm onCreated={onCreated} />

        <Card variant="outlined">
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }}
            justifyContent="space-between" sx={{ p: 2 }}>
            <Box>
              <Typography variant="h6" fontWeight={700}>Active Clients &amp; Shops</Typography>
              <Typography variant="body2" color="text.secondary">
                {tenants.length} clients · {activeCount} active
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
          {loading && <LinearProgress />}
          {loadError && <Alert severity="error" sx={{ mx: 2, mb: 2 }}>{loadError}</Alert>}
          <TableContainer>
            <Table size="small" aria-label="Clients">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
                  <TableCell>ID</TableCell>
                  <TableCell>Client / Shop</TableCell>
                  <TableCell>Admin Username</TableCell>
                  <TableCell align="right">Users</TableCell>
                  <TableCell align="right">Branches</TableCell>
                  <TableCell>Created</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {shown.map((t) => {
                  const isPlatform = t.id === 1;
                  return (
                    <TableRow key={t.id} hover sx={{ opacity: t.is_active ? 1 : 0.65 }}>
                      <TableCell>#{t.id}</TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={600}>{t.name}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {t.code}{isPlatform ? ' · platform account' : ''}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ fontFamily: 'monospace' }}>{t.primary_admin || '—'}</TableCell>
                      <TableCell align="right">{t.user_count}</TableCell>
                      <TableCell align="right">{t.branch_count}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(t.created_at)}</TableCell>
                      <TableCell>
                        <Chip size="small" label={t.is_active ? 'Active' : 'Inactive'}
                          color={t.is_active ? 'success' : 'default'} variant={t.is_active ? 'filled' : 'outlined'} />
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        <Button size="small" startIcon={<DetailsIcon />} onClick={() => setDetailsId(t.id)}
                          aria-label={`View details of ${t.name}`}>
                          Details
                        </Button>
                        <Tooltip title={isPlatform ? 'The platform account cannot be deactivated' : ''}>
                          <span>
                            <Button size="small" color={t.is_active ? 'error' : 'success'}
                              startIcon={busyId === t.id ? <CircularProgress size={14} color="inherit" /> : <PowerIcon />}
                              disabled={isPlatform || busyId === t.id} onClick={() => toggleActive(t)}
                              aria-label={`${t.is_active ? 'Deactivate' : 'Activate'} ${t.name}`}>
                              {t.is_active ? 'Deactivate' : 'Activate'}
                            </Button>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && !shown.length && (
                  <TableRow>
                    <TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      {tenants.length ? 'No client matches the search.' : 'No clients yet.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      </Stack>

      <DetailsDialog tenantId={detailsId} onClose={() => setDetailsId(null)} />
    </Box>
  );
}
