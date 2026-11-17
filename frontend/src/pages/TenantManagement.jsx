// Client Management (/superadmin/tenants) — the platform owner's console for client businesses.
//
// Top: platform summary (clients by status, subscriptions ending within 30 days, users, branches).
// Below: the client list with server-side search, status / plan / country filters and pagination
// (GET /api/superadmin/tenants/?page=…). "New client" opens the Create Client wizard
// (components/superadmin/OnboardClientWizard); a row opens the client's workspace dialog
// (overview & subscription, modules & role permissions, users, branches, data, backups, history).
// Only user.is_platform_admin reaches this page (route guard in App.jsx, sidebar link); the API
// refuses everyone else with 403. Writes may ask for the password again first — sessionGuard /
// ReauthDialogHost handle that and retry.
//
// Keyboard: "/" focuses search, Esc clears it · Alt+N opens New client · Esc closes dialogs.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Box, Typography, Card, Stack, TextField, Button, IconButton, InputAdornment, Alert, AlertTitle, MenuItem,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Chip, Tooltip, LinearProgress,
  TablePagination, Grid,
} from '@mui/material';
import {
  ContentCopy as CopyIcon, Refresh as RefreshIcon, Search as SearchIcon, PersonAddAlt1 as OnboardIcon,
  Tune as ManageIcon, PowerSettingsNew as PowerIcon, Storage as DataIcon, Login as EnterIcon,
} from '@mui/icons-material';
import { useAuth } from '../context/AuthContext';
import { apiErrorMessage } from '../utils/apiError';
import { notify } from '../utils/notify';
import OnboardClientWizard from '../components/superadmin/OnboardClientWizard';
import ClientWorkspaceDialog, { WORKSPACE_TABS } from '../components/superadmin/ClientWorkspaceDialog';
import { DeactivateDialog, ReactivateDialog } from '../components/superadmin/LifecycleDialogs';
import {
  API, STATUS_META, copy, countryName, fmtDate, isReauth, lifecycleOf, packageLabel, planLabel,
} from '../components/superadmin/clientApi';

// Windows edition: the installation licence bounds how many clients the Local Super Admin may add.
function LocalLicenseNotice({ summary }) {
  const lic = summary?.license;
  if (summary?.edition !== 'local' || !lic || !lic.status) return null;
  const limit = lic.clients_limit;
  const full = limit != null && lic.clients_used >= limit;
  const severity = lic.read_only ? 'error' : (full ? 'warning' : 'info');
  return (
    <Alert severity={severity} action={<Button size="small" color="inherit" href="#/license">Licence</Button>}>
      <b>Local licence: {lic.status}</b>
      {' · '}Clients {lic.clients_used}{limit != null ? ` of ${limit}` : ' (no limit)'}
      {lic.valid_until ? ` · valid until ${String(lic.valid_until).slice(0, 10)}` : ''}
      {lic.read_only && ` — ${lic.message || 'read-only: new clients cannot be added'}`}
      {!lic.read_only && full && ' — the licence allows no more clients; upgrade it to add more.'}
    </Alert>
  );
}

const STATUS_FILTERS = [
  ['', 'All statuses'], ['ACTIVE', 'Usable today'], ['TRIAL', 'Trial'], ['SCHEDULED', 'Deactivation scheduled'],
  ['EXPIRED', 'Subscription expired'], ['INACTIVE', 'Deactivated'], ['SUSPENDED', 'Blocked (expired or deactivated)'],
];

function SuccessBanner({ created, onClose }) {
  const { tenant, password, invitation } = created;
  const loginUrl = `${window.location.origin}${window.location.pathname}#/`;
  const credentials = `Login: ${loginUrl}\nUsername: ${tenant.admin_username}\nPassword: ${password}`;
  return (
    <Alert severity="success" onClose={onClose} sx={{ '& .MuiAlert-message': { width: '100%', minWidth: 0 } }}>
      <AlertTitle>“{tenant.name}” is ready — Tenant ID #{tenant.id} ({tenant.code})</AlertTitle>
      {invitation && !invitation.error && (
        <>
          <Typography variant="body2" sx={{ mb: 0.5 }}>
            Send this one-time setup link to <b>{tenant.admin_username}</b>. It works once and expires in
            {' '}{invitation.hours} hours; it is shown only now (a new one can be made from the client’s Users tab).
          </Typography>
          <Box component="code" sx={{ display: 'block', wordBreak: 'break-all', fontSize: 12, mb: 0.5 }}>{invitation.link}</Box>
          <Button size="small" startIcon={<CopyIcon />} onClick={() => copy(invitation.link)}>Copy setup link</Button>
        </>
      )}
      {invitation?.error && (
        <Typography variant="body2">
          The client was created, but the setup link could not be made. Open the client → Users → “Setup link”.
        </Typography>
      )}
      {!invitation && (
        <>
          <Typography variant="body2" sx={{ mb: 0.5 }}>Share these credentials with the client. The password is shown only now.</Typography>
          <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.5, m: 0, fontSize: 14 }}>
            <dt>Login page</dt><dd style={{ margin: 0, wordBreak: 'break-all' }}>{loginUrl}</dd>
            <dt>Username</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{tenant.admin_username}</dd>
            <dt>Password</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{password}</dd>
          </Box>
          <Button size="small" startIcon={<CopyIcon />} sx={{ mt: 1 }} onClick={() => copy(credentials)}>Copy credentials</Button>
        </>
      )}
    </Alert>
  );
}

function Stat({ label, value, tone, onClick, active }) {
  return (
    <Card variant="outlined" onClick={onClick} role={onClick ? 'button' : undefined} tabIndex={onClick ? 0 : undefined}
      onKeyDown={(e) => { if (onClick && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); onClick(); } }}
      sx={{
        px: 2, py: 1.5, height: '100%', cursor: onClick ? 'pointer' : 'default',
        borderColor: active ? 'primary.main' : 'divider', bgcolor: active ? 'action.selected' : 'background.paper',
      }}>
      <Typography variant="caption" color="text.secondary" noWrap component="div">{label}</Typography>
      <Typography variant="h6" fontWeight={800} color={tone || 'text.primary'} sx={{ lineHeight: 1.3 }}>{value ?? '—'}</Typography>
    </Card>
  );
}

export default function TenantManagement() {
  const { openWorkspace: openClientWorkspace } = useAuth();
  const [catalog, setCatalog] = useState(null);
  const [summary, setSummary] = useState(null);
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [created, setCreated] = useState(null);
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [plan, setPlan] = useState('');
  const [country, setCountry] = useState('');
  const [expiring, setExpiring] = useState(false);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [wizard, setWizard] = useState(false);
  const [workspaceId, setWorkspaceId] = useState(null);
  const [workspaceTab, setWorkspaceTab] = useState(WORKSPACE_TABS.overview);
  const [lifecycle, setLifecycle] = useState(null);
  const [enteringId, setEnteringId] = useState(null);
  const searchRef = useRef(null);
  const requestRef = useRef(0);

  const openWorkspace = (id, tab = WORKSPACE_TABS.overview) => { setWorkspaceTab(tab); setWorkspaceId(id); };

  // Debounced search text → query.
  useEffect(() => {
    const t = setTimeout(() => { setQuery(search.trim()); setPage(0); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  const loadSummary = useCallback(() => axios.get(`${API}summary/`)
    .then(({ data }) => setSummary(data)).catch(() => {}), []);

  const loadRows = useCallback(async () => {
    const ticket = ++requestRef.current;
    setLoading(true);
    try {
      const params = { page: page + 1, page_size: pageSize };
      if (query) params.search = query;
      if (status) params.status = status;
      if (plan) params.plan = plan;
      if (country) params.country = country;
      if (expiring) params.expiring = 1;
      const { data } = await axios.get(API, { params });
      if (ticket !== requestRef.current) return;
      setRows(data.results || []);
      setCount(data.count || 0);
      setLoadError('');
    } catch (err) {
      if (ticket === requestRef.current) setLoadError(apiErrorMessage(err, 'Could not load the client list.'));
    } finally {
      if (ticket === requestRef.current) setLoading(false);
    }
  }, [page, pageSize, query, status, plan, country, expiring]);

  useEffect(() => {
    axios.get(`${API}catalog/`).then(({ data }) => setCatalog(data))
      .catch((err) => setLoadError(apiErrorMessage(err, 'Could not load the module catalog.')));
    loadSummary();
  }, [loadSummary]);

  useEffect(() => { loadRows(); }, [loadRows]);

  const refresh = () => { loadRows(); loadSummary(); };

  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target?.isContentEditable;
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !typing) {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.altKey && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        setWizard(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const enterWorkspace = async (t) => {
    if (!window.confirm(`Open ${t.name}'s workspace?\n\nEverything you create or change there belongs to ${t.name}. `
      + 'The opening is recorded in the client’s history. Use "Return to platform" in the yellow bar to come back.')) return;
    setEnteringId(t.id);
    try {
      await openClientWorkspace(t.id);
    } catch (err) {
      if (!isReauth(err)) notify(`Could not open ${t.name}'s workspace: ${apiErrorMessage(err)}`, 'error');
      setEnteringId(null);
    }
  };

  const onCreated = (result) => {
    setWizard(false);
    setCreated(result);
    setStatus(''); setPlan(''); setCountry(''); setExpiring(false); setSearch(''); setPage(0);
    refresh();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const updateRow = (row) => {
    setRows((list) => list.map((r) => (r.id === row.id ? { ...r, ...row } : r)));
    loadSummary();
  };

  const lifecycleDone = (row) => {
    setLifecycle(null);
    updateRow(row);
    notify(`${row.name}: ${(STATUS_META[row.status] || STATUS_META.ACTIVE).label.toLowerCase()}.`, 'success');
  };

  const by = summary?.by_status || {};
  const quickFilter = (next) => { setExpiring(false); setStatus((s) => (s === next ? '' : next)); setPage(0); };
  const moduleNames = (t) => (t.modules || []).map((m) => catalog?.modules.find((x) => x.key === m)?.label || m).join(', ');
  const filtered = Boolean(query || status || plan || country || expiring);

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1440, mx: 'auto' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} sx={{ mb: 3 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="h5" fontWeight={800}>
            Client Management
            {summary?.edition === 'local' && <Chip size="small" label="Local edition" variant="outlined" sx={{ ml: 1, verticalAlign: 'middle' }} />}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Each client is a separate business with its own data, modules, users and branches.
            {summary?.edition === 'local' && ' Stored on this installation’s own database.'}
          </Typography>
        </Box>
        <Stack direction="row" spacing={1} sx={{ flexShrink: 0 }}>
          <Tooltip title="Refresh">
            <span><IconButton onClick={refresh} disabled={loading} aria-label="Refresh"><RefreshIcon /></IconButton></span>
          </Tooltip>
          <Button variant="contained" startIcon={<OnboardIcon />} onClick={() => setWizard(true)} disabled={!catalog}>
            New client
          </Button>
        </Stack>
      </Stack>

      <Stack spacing={3}>
        {created && <SuccessBanner created={created} onClose={() => setCreated(null)} />}
        {!catalog && loadError && <Alert severity="error">{loadError}</Alert>}
        <LocalLicenseNotice summary={summary} />

        <Grid container spacing={2} aria-label="Platform summary">
          <Grid item xs={6} sm={4} md><Stat label="Clients" value={summary?.clients} onClick={() => quickFilter('')} active={!filtered} /></Grid>
          <Grid item xs={6} sm={4} md><Stat label="Active" value={(by.ACTIVE || 0) + (by.SCHEDULED || 0)} tone="success.main" onClick={() => quickFilter('ACTIVE')} active={status === 'ACTIVE'} /></Grid>
          <Grid item xs={6} sm={4} md><Stat label="Trial" value={by.TRIAL || 0} tone="info.main" onClick={() => quickFilter('TRIAL')} active={status === 'TRIAL'} /></Grid>
          <Grid item xs={6} sm={4} md>
            <Stat label={`Expiring ≤ ${summary?.expiring_days ?? 30} days`} value={summary?.expiring_soon?.length ?? 0} tone="warning.main"
              onClick={() => { setStatus(''); setExpiring((v) => !v); setPage(0); }} active={expiring} />
          </Grid>
          <Grid item xs={6} sm={4} md><Stat label="Expired / Deactivated" value={(by.EXPIRED || 0) + (by.INACTIVE || 0)} tone="error.main" onClick={() => quickFilter('SUSPENDED')} active={status === 'SUSPENDED'} /></Grid>
          <Grid item xs={6} sm={4} md><Stat label="Active users" value={summary?.active_users} /></Grid>
          <Grid item xs={6} sm={4} md><Stat label="Active branches" value={summary?.active_branches} /></Grid>
        </Grid>

        <Card variant="outlined">
          <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ px: 2, pt: 2, pb: 1.5 }} alignItems={{ md: 'center' }}>
            <TextField
              size="small" placeholder="Search name, ID, owner, email, admin  ( / )" value={search}
              onChange={(e) => setSearch(e.target.value)} inputRef={searchRef} sx={{ flex: 1, minWidth: 0 }}
              inputProps={{ 'aria-label': 'Search clients' }}
              onKeyDown={(e) => { if (e.key === 'Escape') { setSearch(''); e.currentTarget.blur(); } }}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
            />
            <Stack direction="row" spacing={1} sx={{ flexWrap: { xs: 'wrap', sm: 'nowrap' }, rowGap: 1 }}>
              <TextField select size="small" label="Status" value={status} sx={{ minWidth: 150 }}
                onChange={(e) => { setStatus(e.target.value); setExpiring(false); setPage(0); }}>
                {STATUS_FILTERS.map(([k, l]) => <MenuItem key={k || 'all'} value={k}>{l}</MenuItem>)}
              </TextField>
              <TextField select size="small" label="Plan" value={plan} sx={{ minWidth: 130 }}
                onChange={(e) => { setPlan(e.target.value); setPage(0); }}>
                <MenuItem value="">All plans</MenuItem>
                {(catalog?.subscription_plans || []).map((p) => <MenuItem key={p.key} value={p.key}>{p.label}</MenuItem>)}
              </TextField>
              <TextField select size="small" label="Country" value={country} sx={{ minWidth: 130 }}
                onChange={(e) => { setCountry(e.target.value); setPage(0); }}>
                <MenuItem value="">All countries</MenuItem>
                {(catalog?.localization?.countries || []).map((c) => <MenuItem key={c.code} value={c.code}>{c.name}</MenuItem>)}
              </TextField>
            </Stack>
          </Stack>
          {loading ? <LinearProgress /> : <Box sx={{ height: 4 }} />}
          {catalog && loadError && <Alert severity="error" sx={{ m: 2 }}>{loadError}</Alert>}
          <TableContainer sx={{ maxHeight: { md: 'calc(100vh - 330px)' } }}>
            <Table size="small" stickyHeader aria-label="Clients">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
                  <TableCell>Tenant ID</TableCell>
                  <TableCell>Client</TableCell>
                  <TableCell sx={{ display: { xs: 'none', xl: 'table-cell' } }}>Company</TableCell>
                  <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Country</TableCell>
                  <TableCell>Plan</TableCell>
                  <TableCell sx={{ display: { xs: 'none', xl: 'table-cell' } }}>Modules</TableCell>
                  <TableCell align="right">Users</TableCell>
                  <TableCell align="right">Branches</TableCell>
                  <TableCell>Status</TableCell>
                  <TableCell>Expiry</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.map((t) => {
                  const meta = STATUS_META[t.status] || STATUS_META.ACTIVE;
                  const life = lifecycleOf(t.status);
                  const soon = t.days_to_expiry != null && t.days_to_expiry >= 0 && t.days_to_expiry <= 30;
                  return (
                    <TableRow key={t.id} hover sx={{ opacity: t.status === 'INACTIVE' ? 0.7 : 1, cursor: 'pointer' }}
                      onClick={() => openWorkspace(t.id)}>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        #{t.id}
                        <Typography variant="caption" color="text.secondary" component="div" noWrap sx={{ maxWidth: 120 }}>{t.code}</Typography>
                      </TableCell>
                      <TableCell sx={{ maxWidth: 220 }}>
                        <Typography variant="body2" fontWeight={600} noWrap title={t.name}>{t.name}</Typography>
                        <Typography variant="caption" color="text.secondary" component="div" noWrap>
                          {t.is_platform ? 'Platform account' : (t.owner_name || t.primary_admin || '—')}
                          <Box component="span" sx={{ display: { xs: 'inline', xl: 'none' } }}>
                            {t.company_name && t.company_name !== t.name ? ` · ${t.company_name}` : ''}
                          </Box>
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ display: { xs: 'none', xl: 'table-cell' }, maxWidth: 180 }}>
                        <Typography variant="body2" noWrap title={t.company_name}>{t.company_name}</Typography>
                      </TableCell>
                      <TableCell sx={{ display: { xs: 'none', md: 'table-cell' }, whiteSpace: 'nowrap' }}>{t.country ? countryName(catalog, t.country) : '—'}</TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>
                        {t.is_platform ? '—' : planLabel(catalog, t.subscription_plan)}
                        <Tooltip title={moduleNames(t)}>
                          <Typography variant="caption" color="text.secondary" component="div" noWrap>
                            {packageLabel(catalog, t.package)}
                            <Box component="span" sx={{ display: { xs: 'inline', xl: 'none' } }}> · {(t.modules || []).length} modules</Box>
                          </Typography>
                        </Tooltip>
                      </TableCell>
                      <TableCell sx={{ display: { xs: 'none', xl: 'table-cell' } }}>
                        <Tooltip title={moduleNames(t)}><Chip size="small" variant="outlined" label={`${(t.modules || []).length} modules`} /></Tooltip>
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap', color: t.active_user_count >= t.max_users ? 'warning.main' : 'inherit' }}>
                        {t.active_user_count}/{t.max_users}
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                        {t.active_branch_count ?? t.branch_count}{t.max_branches ? `/${t.max_branches}` : ''}
                      </TableCell>
                      <TableCell><Chip size="small" label={meta.label} color={meta.color} variant={t.status === 'INACTIVE' ? 'outlined' : 'filled'} /></TableCell>
                      <TableCell sx={{ whiteSpace: 'nowrap', color: soon ? 'warning.main' : (t.status === 'EXPIRED' ? 'error.main' : 'inherit') }}>
                        {t.subscription_expires_on ? fmtDate(t.subscription_expires_on) : '—'}
                      </TableCell>
                      <TableCell align="right" sx={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                        <Tooltip title="Profile, subscription, modules, users and branches">
                          <Button size="small" startIcon={<ManageIcon />} onClick={() => openWorkspace(t.id)}
                            aria-label={`Manage ${t.name}`}>
                            Manage
                          </Button>
                        </Tooltip>
                        <Tooltip title="Records, audit and backups">
                          <Button size="small" startIcon={<DataIcon />} onClick={() => openWorkspace(t.id, WORKSPACE_TABS.data)}
                            aria-label={`View data of ${t.name}`}>
                            Data
                          </Button>
                        </Tooltip>
                        {!t.is_platform && (
                          <Tooltip title={['INACTIVE', 'EXPIRED'].includes(t.status)
                            ? 'Reactivate or renew the client to work in its workspace'
                            : 'Create and manage records as this client (audited)'}>
                            <span>
                              <Button size="small" startIcon={<EnterIcon />} disabled={['INACTIVE', 'EXPIRED'].includes(t.status) || enteringId === t.id}
                                onClick={() => enterWorkspace(t)} aria-label={`Open the workspace of ${t.name}`}>
                                {enteringId === t.id ? 'Opening…' : 'Open workspace'}
                              </Button>
                            </span>
                          </Tooltip>
                        )}
                        <Tooltip title={t.is_platform ? 'The platform account cannot be deactivated' : ''}>
                          <span>
                            <Button size="small" color={life.color} startIcon={<PowerIcon />} disabled={t.is_platform || !catalog}
                              onClick={() => setLifecycle(t)} aria-label={`${life.label} ${t.name}`}>
                              {life.label}
                            </Button>
                          </span>
                        </Tooltip>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!loading && !rows.length && (
                  <TableRow>
                    <TableCell colSpan={11} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      {filtered ? 'No client matches these filters.' : 'No clients yet — use “New client”.'}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination component="div" count={count} page={page} rowsPerPage={pageSize}
            rowsPerPageOptions={[10, 25, 50, 100]}
            onPageChange={(_, p) => setPage(p)}
            onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} />
        </Card>
      </Stack>

      {wizard && catalog && <OnboardClientWizard catalog={catalog} onClose={() => setWizard(false)} onCreated={onCreated} />}
      {workspaceId && catalog && (
        <ClientWorkspaceDialog catalog={catalog} tenantId={workspaceId} initialTab={workspaceTab}
          onClose={() => setWorkspaceId(null)} onUpdated={updateRow} />
      )}
      {lifecycle && catalog && (lifecycleOf(lifecycle.status).kind === 'deactivate'
        ? <DeactivateDialog catalog={catalog} tenant={lifecycle} onClose={() => setLifecycle(null)} onDone={lifecycleDone} />
        : <ReactivateDialog tenant={lifecycle} onClose={() => setLifecycle(null)} onDone={lifecycleDone} />)}
    </Box>
  );
}
