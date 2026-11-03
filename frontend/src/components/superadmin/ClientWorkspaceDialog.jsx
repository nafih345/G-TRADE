// One client's workspace in the platform console: Overview (profile, seats, status), Modules &
// Permissions, Users, Branches and History. Every save answers with the full client detail, which
// replaces what is shown here and is passed up (onUpdated) to refresh the list row.
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Box, Dialog, DialogTitle, DialogContent, DialogActions, Button, Tabs, Tab, LinearProgress, Alert, Stack,
  Typography, TextField, Grid, Chip, Divider, CircularProgress, Table, TableHead, TableRow, TableCell, TableBody,
} from '@mui/material';
import { Save as SaveIcon, PowerSettingsNew as PowerIcon } from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { apiErrorMessage } from '../../utils/apiError';
import ModuleAccessEditor from './ModuleAccessEditor';
import RolePermissionsEditor from './RolePermissionsEditor';
import ClientUsersPanel from './ClientUsersPanel';
import ClientBranchesPanel from './ClientBranchesPanel';
import { DeactivateDialog, ReactivateDialog } from './LifecycleDialogs';
import {
  API, STATUS_META, fmtDate, fmtDateTime, isReauth, packageLabel, splitErrors,
} from './clientApi';

const ACTION_LABELS = {
  ONBOARDED: 'Client onboarded',
  DEACTIVATED: 'Deactivated',
  DEACTIVATION_SCHEDULED: 'Deactivation scheduled',
  DEACTIVATION_EFFECTIVE: 'Scheduled deactivation took effect',
  DEACTIVATION_CANCELLED: 'Scheduled deactivation cancelled',
  REACTIVATED: 'Reactivated',
  MODULES_CHANGED: 'Modules changed',
  PERMISSIONS_CHANGED: 'Role permissions changed',
  SEATS_CHANGED: 'Seat limit changed',
  PROFILE_UPDATED: 'Profile updated',
  USER_ADDED: 'User added',
  USER_UPDATED: 'User updated',
  PASSWORD_RESET: 'Password reset',
  BRANCH_ADDED: 'Branch added',
  BRANCH_UPDATED: 'Branch updated',
};

const describe = (row, catalog) => {
  const d = row.details || {};
  if (d.username) return `${d.username}${d.role ? ` · ${d.role.replace(/_/g, ' ')}` : ''}`;
  if (d.branch) return `${d.branch} (${d.code})`;
  if (d.package) return `${packageLabel(catalog, d.package)} · ${d.max_users} seats`;
  if (d.changes) {
    return Object.entries(d.changes).map(([k, v]) => {
      if (k === 'modules') return `modules: ${(v.to || []).join(', ')}`;
      if (k === 'role_permissions') return 'role permissions';
      if (k === 'package') return `package: ${packageLabel(catalog, v.from)} → ${packageLabel(catalog, v.to)}`;
      return `${k.replace(/_/g, ' ')}: ${v.from ?? '—'} → ${v.to ?? '—'}`;
    }).join(' · ');
  }
  if (d.category) return catalog.deactivation_categories.find((c) => c.key === d.category)?.label || d.category;
  return '';
};

function Overview({ tenant, onSave, saving, onLifecycle }) {
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  useEffect(() => {
    setForm({ name: tenant.name, contact_email: tenant.contact_email, contact_phone: tenant.contact_phone, max_users: tenant.max_users });
    setErrors({});
  }, [tenant]);
  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setErrors((x) => ({ ...x, [key]: undefined })); };
  const dirty = ['name', 'contact_email', 'contact_phone'].some((k) => form[k] !== tenant[k]) || Number(form.max_users) !== tenant.max_users;
  const status = STATUS_META[tenant.status];

  const submit = async (e) => {
    e.preventDefault();
    const body = {};
    ['name', 'contact_email', 'contact_phone'].forEach((k) => { if (form[k] !== tenant[k]) body[k] = form[k]; });
    if (Number(form.max_users) !== tenant.max_users) body.max_users = Number(form.max_users);
    const fieldErrors = await onSave(body, ['name', 'contact_email', 'contact_phone', 'max_users']);
    if (fieldErrors) setErrors(fieldErrors);
  };

  return (
    <Grid container spacing={3}>
      <Grid item xs={12} md={7}>
        <Box component="form" noValidate onSubmit={submit}>
          <Typography variant="subtitle2" fontWeight={700} gutterBottom>Client profile</Typography>
          <Grid container columnSpacing={2}>
            <Grid item xs={12}>
              <TextField fullWidth size="small" label="Shop / Client Name" value={form.name ?? ''} onChange={set('name')}
                error={Boolean(errors.name)} helperText={errors.name || ' '} inputProps={{ maxLength: 150 }} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="Contact email" type="email" value={form.contact_email ?? ''} onChange={set('contact_email')}
                error={Boolean(errors.contact_email)} helperText={errors.contact_email || ' '} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="Contact phone" type="tel" value={form.contact_phone ?? ''} onChange={set('contact_phone')}
                error={Boolean(errors.contact_phone)} helperText={errors.contact_phone || ' '} inputProps={{ maxLength: 20 }} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="User limit (seats)" type="number" value={form.max_users ?? ''} onChange={set('max_users')}
                error={Boolean(errors.max_users)} helperText={errors.max_users || `${tenant.active_user_count} active users now`}
                inputProps={{ min: 1, max: 10000 }} />
            </Grid>
          </Grid>
          <Stack direction="row" justifyContent="flex-end">
            <Button type="submit" variant="contained" disabled={!dirty || saving}
              startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}>Save</Button>
          </Stack>
        </Box>
      </Grid>
      <Grid item xs={12} md={5}>
        <Typography variant="subtitle2" fontWeight={700} gutterBottom>Account</Typography>
        <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.75, m: 0, fontSize: 14 }}>
          <dt>Status</dt><dd style={{ margin: 0 }}><Chip size="small" label={status.label} color={status.color} /></dd>
          <dt>Tenant ID</dt><dd style={{ margin: 0 }}>#{tenant.id} · {tenant.code}</dd>
          <dt>Created</dt><dd style={{ margin: 0 }}>{fmtDate(tenant.created_at)}</dd>
          <dt>Owner login</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{tenant.primary_admin || '—'}</dd>
          <dt>Branches</dt><dd style={{ margin: 0 }}>{tenant.branch_count}</dd>
          {tenant.status !== 'ACTIVE' && (
            <>
              <dt>{tenant.status === 'SCHEDULED' ? 'Deactivates on' : 'Deactivated from'}</dt>
              <dd style={{ margin: 0 }}>{fmtDate(tenant.deactivation_effective_date)}{tenant.deactivation_until ? ` (planned until ${fmtDate(tenant.deactivation_until)})` : ''}</dd>
              <dt>Recorded</dt><dd style={{ margin: 0 }}>{fmtDateTime(tenant.deactivated_at)} by {tenant.deactivated_by || '—'}</dd>
              <dt>Reason</dt><dd style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{tenant.deactivation_reason}</dd>
            </>
          )}
        </Box>
        {!tenant.is_platform && (
          <Button sx={{ mt: 2 }} variant="outlined" color={tenant.status === 'ACTIVE' ? 'error' : 'success'} startIcon={<PowerIcon />}
            onClick={onLifecycle}>
            {tenant.status === 'ACTIVE' ? 'Deactivate client…' : tenant.status === 'SCHEDULED' ? 'Cancel scheduled deactivation…' : 'Reactivate client…'}
          </Button>
        )}
      </Grid>
    </Grid>
  );
}

function ModulesTab({ catalog, tenant, onSave, saving }) {
  const [value, setValue] = useState({ package: tenant.package, modules: tenant.modules });
  useEffect(() => { setValue({ package: tenant.package, modules: tenant.modules }); }, [tenant.package, tenant.modules]);
  const dirty = value.package !== tenant.package || value.modules.join() !== tenant.modules.join();
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    const fieldErrors = await onSave({ package: value.package, modules: value.modules }, ['modules']);
    if (fieldErrors?.modules) setError(fieldErrors.modules);
  };

  return (
    <Stack spacing={3}>
      <Box>
        {tenant.is_platform && <Alert severity="info" sx={{ mb: 2 }}>The platform account always has every module.</Alert>}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <ModuleAccessEditor catalog={catalog} value={value} onChange={setValue} disabled={tenant.is_platform || saving} />
        {!tenant.is_platform && (
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1.5 }}>
            <Button disabled={!dirty || saving} onClick={() => setValue({ package: tenant.package, modules: tenant.modules })}>Discard</Button>
            <Button variant="contained" disabled={!dirty || saving} onClick={save}
              startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}>Save modules</Button>
          </Stack>
        )}
      </Box>
      <Divider />
      <Box>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>Role permissions</Typography>
        <RolePermissionsEditor catalog={catalog} tenant={tenant} saving={saving}
          onSave={(levels) => onSave({ role_permissions: levels }, [])} />
      </Box>
    </Stack>
  );
}

function HistoryTab({ catalog, tenantId, version }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    axios.get(`${API}${tenantId}/audit/`)
      .then(({ data }) => { if (live) setRows(data); })
      .catch((err) => { if (live) setError(apiErrorMessage(err, 'Could not load the history.')); });
    return () => { live = false; };
  }, [tenantId, version]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!rows) return <LinearProgress />;
  if (!rows.length) return <Typography color="text.secondary">No recorded changes yet (clients onboarded before this history existed start empty).</Typography>;
  return (
    <Table size="small" aria-label="Client history">
      <TableHead>
        <TableRow sx={{ '& th': { fontWeight: 700 } }}>
          <TableCell>When</TableCell><TableCell>Event</TableCell><TableCell>Details</TableCell><TableCell>By</TableCell>
        </TableRow>
      </TableHead>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.created_at)}</TableCell>
            <TableCell sx={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{ACTION_LABELS[r.action] || r.action}</TableCell>
            <TableCell>
              <Typography variant="body2">{describe(r, catalog)}</Typography>
              {r.effective_date && <Typography variant="caption" color="text.secondary" component="div">Effective {fmtDate(r.effective_date)}</Typography>}
              {r.reason && <Typography variant="caption" color="text.secondary" component="div" sx={{ whiteSpace: 'pre-wrap' }}>“{r.reason}”</Typography>}
            </TableCell>
            <TableCell sx={{ fontFamily: 'monospace' }}>{r.actor || '—'}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function ClientWorkspaceDialog({ catalog, tenantId, initialTab = 0, onClose, onUpdated }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState(initialTab);
  const [saving, setSaving] = useState(false);
  const [lifecycle, setLifecycle] = useState(false);
  const [version, setVersion] = useState(0);

  const load = useCallback(() => {
    setError('');
    return axios.get(`${API}${tenantId}/`)
      .then(({ data: d }) => setData(d))
      .catch((err) => setError(apiErrorMessage(err, 'Could not load the client.')));
  }, [tenantId]);

  useEffect(() => { setData(null); setTab(initialTab); load(); }, [load, initialTab]);

  const changed = (detail) => {
    setData(detail);
    setVersion((v) => v + 1);
    onUpdated(detail);
  };

  // PATCH the client; returns field errors (for the caller's form) or null.
  const save = async (body, knownFields) => {
    if (!Object.keys(body).length) return null;
    setSaving(true);
    try {
      const { data: d } = await axios.patch(`${API}${tenantId}/`, body);
      changed(d);
      notify('Saved.', 'success');
      return null;
    } catch (err) {
      if (isReauth(err)) return null;
      const { fields, general } = splitErrors(err, knownFields, 'The change could not be saved.');
      if (general) notify(general, 'error');
      return fields;
    } finally {
      setSaving(false);
    }
  };

  const lifecycleDone = async (row) => {
    setLifecycle(false);
    notify(`${row.name}: ${STATUS_META[row.status].label.toLowerCase()}.`, 'success');
    onUpdated(row);
    await load();
    setVersion((v) => v + 1);
  };

  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth aria-labelledby="client-workspace-title"
      PaperProps={{ sx: { height: { md: '88vh' } } }}>
      <DialogTitle id="client-workspace-title" sx={{ pb: 0 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <span>{data ? data.name : 'Client'}</span>
          {data && <Chip size="small" label={STATUS_META[data.status].label} color={STATUS_META[data.status].color} />}
          {data && <Chip size="small" variant="outlined" label={packageLabel(catalog, data.package)} />}
        </Stack>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" sx={{ mt: 1 }}>
          <Tab label="Overview" />
          <Tab label="Modules & Permissions" />
          <Tab label={data ? `Users (${data.users.length})` : 'Users'} />
          <Tab label={data ? `Branches (${data.branches.length})` : 'Branches'} />
          <Tab label="History" />
        </Tabs>
      </DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error">{error}</Alert>}
        {!data && !error && <LinearProgress />}
        {data && tab === 0 && <Overview tenant={data} onSave={save} saving={saving} onLifecycle={() => setLifecycle(true)} />}
        {data && tab === 1 && <ModulesTab catalog={catalog} tenant={data} onSave={save} saving={saving} />}
        {data && tab === 2 && <ClientUsersPanel catalog={catalog} tenant={data} onChanged={changed} />}
        {data && tab === 3 && <ClientBranchesPanel tenant={data} onChanged={changed} />}
        {data && tab === 4 && <HistoryTab catalog={catalog} tenantId={tenantId} version={version} />}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>

      {lifecycle && data && (data.status === 'ACTIVE'
        ? <DeactivateDialog catalog={catalog} tenant={data} onClose={() => setLifecycle(false)} onDone={lifecycleDone} />
        : <ReactivateDialog tenant={data} onClose={() => setLifecycle(false)} onDone={lifecycleDone} />)}
    </Dialog>
  );
}
