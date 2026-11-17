// One client's workspace in the platform console: Overview (profile, seats, status), Modules &
// Permissions, Users, Branches, Data & Audit (read-only records), Backups and History. Every save answers with the full client detail, which
// replaces what is shown here and is passed up (onUpdated) to refresh the list row.
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Box, Dialog, DialogTitle, DialogContent, DialogActions, Button, Tabs, Tab, LinearProgress, Alert, Stack,
  Typography, TextField, Grid, Chip, Divider, CircularProgress, Table, TableHead, TableRow, TableCell, TableBody,
  MenuItem,
} from '@mui/material';
import { Save as SaveIcon, PowerSettingsNew as PowerIcon } from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { apiErrorMessage } from '../../utils/apiError';
import ModuleAccessEditor from './ModuleAccessEditor';
import RolePermissionsEditor from './RolePermissionsEditor';
import ClientUsersPanel from './ClientUsersPanel';
import ClientBranchesPanel from './ClientBranchesPanel';
import ClientDataPanel from './ClientDataPanel';
import ClientBackupsPanel from './ClientBackupsPanel';
import { DeactivateDialog, ReactivateDialog } from './LifecycleDialogs';
import {
  API, STATUS_META, fmtDate, fmtDateTime, isReauth, lifecycleOf, packageLabel, planLabel, splitErrors,
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
  SUBSCRIPTION_CHANGED: 'Subscription changed',
  INVITATION_ISSUED: 'Setup link issued',
  INVITATION_ACCEPTED: 'Setup link used (password set)',
  WORKSPACE_OPENED: 'Workspace opened by platform admin',
  COMPANY_LIMIT_CHANGED: 'Company limit changed',
  DEFAULTS_PROVISIONED: 'Default masters provisioned',
  PROFILE_UPDATED: 'Profile updated',
  USER_ADDED: 'User added',
  USER_UPDATED: 'User updated',
  PASSWORD_RESET: 'Password reset',
  BRANCH_ADDED: 'Branch added',
  BRANCH_UPDATED: 'Branch updated',
  DATA_VIEWED: 'Data viewed',
  DATA_EXPORTED: 'Data exported (CSV)',
  BACKUP_REQUESTED: 'Backup requested',
  BACKUP_COMPLETED: 'Backup completed',
  BACKUP_FAILED: 'Backup failed',
  BACKUP_DOWNLOADED: 'Backup downloaded',
  BACKUP_DELETED: 'Backup deleted',
  BACKUP_RETENTION_DELETED: 'Backup removed by retention',
  BACKUP_SCHEDULE_CHANGED: 'Backup schedule changed',
};

// Tab order; History stays last.
export const WORKSPACE_TABS = { overview: 0, modules: 1, users: 2, branches: 3, data: 4, backups: 5, history: 6 };

const describe = (row, catalog) => {
  const d = row.details || {};
  if (d.backup) return `${d.backup} · ${d.sections}${d.rows != null ? ` · ${d.rows} records` : ''}${d.error ? ` · ${d.error}` : ''}`;
  if (d.dataset) return `${d.label || d.dataset}${d.rows != null ? ` · ${d.rows} rows` : ''}`;
  if (d.username) return `${d.username}${d.role ? ` · ${d.role.replace(/_/g, ' ')}` : ''}`;
  if (d.branch) return `${d.branch} (${d.code})`;
  if (d.package) return `${packageLabel(catalog, d.package)} · ${d.max_users} seats`;
  if (d.changes) {
    return Object.entries(d.changes).map(([k, v]) => {
      if (k === 'modules') return `modules: ${(v.to || []).join(', ')}`;
      if (k === 'role_permissions') return 'role permissions';
      if (k === 'settings_features') return `settings sections: ${v.to ? v.to.join(', ') : 'all'}`;
      if (k === 'sections') return `scope: ${(v || []).length ? v.join(', ') : 'full client'}`;
      if (typeof v !== 'object' || v === null) return `${k.replace(/_/g, ' ')}: ${v}`;
      if (k === 'package') return `package: ${packageLabel(catalog, v.from)} → ${packageLabel(catalog, v.to)}`;
      return `${k.replace(/_/g, ' ')}: ${v.from ?? '—'} → ${v.to ?? '—'}`;
    }).join(' · ');
  }
  if (d.category) return catalog.deactivation_categories.find((c) => c.key === d.category)?.label || d.category;
  return '';
};

// Overview form fields: [key, kind]. Numbers and dates are compared / sent in their API shape.
const OVERVIEW_FIELDS = [
  ['name', 'text'], ['owner_name', 'text'], ['contact_email', 'text'], ['contact_phone', 'text'],
  ['country', 'text'], ['address', 'text'], ['max_users', 'int'], ['max_branches', 'intOrNull'],
  ['subscription_plan', 'text'], ['subscription_starts_on', 'date'], ['subscription_expires_on', 'date'],
];
const toApi = (kind, value) => {
  if (kind === 'int') return Number(value);
  if (kind === 'intOrNull' || kind === 'date') return value === '' || value == null ? null : (kind === 'date' ? value : Number(value));
  return value ?? '';
};

function Overview({ catalog, tenant, onSave, saving, onLifecycle }) {
  const [form, setForm] = useState({});
  const [errors, setErrors] = useState({});
  useEffect(() => {
    setForm(Object.fromEntries(OVERVIEW_FIELDS.map(([k]) => [k, tenant[k] ?? ''])));
    setErrors({});
  }, [tenant]);
  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setErrors((x) => ({ ...x, [key]: undefined })); };
  const changed = OVERVIEW_FIELDS.filter(([k, kind]) => toApi(kind, form[k]) !== toApi(kind, tenant[k] ?? ''));
  const dirty = changed.length > 0;
  const status = STATUS_META[tenant.status] || STATUS_META.ACTIVE;
  const perpetual = form.subscription_plan === 'PERPETUAL';

  const submit = async (e) => {
    e.preventDefault();
    const body = Object.fromEntries(changed.map(([k, kind]) => [k, toApi(kind, form[k])]));
    if (perpetual && 'subscription_plan' in body) delete body.subscription_expires_on;
    const fieldErrors = await onSave(body, OVERVIEW_FIELDS.map(([k]) => k));
    if (fieldErrors) setErrors(fieldErrors);
  };
  const field = (key, label, props = {}) => (
    <TextField fullWidth size="small" label={label} value={form[key] ?? ''} onChange={set(key)}
      error={Boolean(errors[key])} helperText={errors[key] || props.helperText || ' '} {...props} />
  );

  return (
    <Grid container spacing={3}>
      <Grid item xs={12} md={7}>
        <Box component="form" noValidate onSubmit={submit}>
          <Typography variant="subtitle2" fontWeight={700} gutterBottom>Client profile</Typography>
          <Grid container columnSpacing={2}>
            <Grid item xs={12} sm={6}>{field('name', 'Client / Organization Name', { inputProps: { maxLength: 150 } })}</Grid>
            <Grid item xs={12} sm={6}>{field('owner_name', 'Owner Name', { inputProps: { maxLength: 150 } })}</Grid>
            <Grid item xs={12} sm={6}>{field('contact_email', 'Contact email', { type: 'email' })}</Grid>
            <Grid item xs={12} sm={6}>{field('contact_phone', 'Contact phone', { type: 'tel', inputProps: { maxLength: 20 } })}</Grid>
            <Grid item xs={12} sm={6}>
              {field('country', 'Country', {
                select: true,
                children: [<MenuItem key="" value="">—</MenuItem>,
                  ...(catalog.localization?.countries || []).map((c) => <MenuItem key={c.code} value={c.code}>{c.name}</MenuItem>)],
              })}
            </Grid>
            <Grid item xs={12} sm={6}>{field('address', 'Address', { inputProps: { maxLength: 1000 } })}</Grid>
          </Grid>
          {!tenant.is_platform && (
            <>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>Subscription &amp; limits</Typography>
              <Grid container columnSpacing={2}>
                <Grid item xs={12} sm={4}>
                  {field('subscription_plan', 'Plan', {
                    select: true,
                    children: (catalog.subscription_plans || []).map((p) => <MenuItem key={p.key} value={p.key}>{p.label}</MenuItem>),
                  })}
                </Grid>
                <Grid item xs={6} sm={4}>{field('subscription_starts_on', 'Start date', { type: 'date', InputLabelProps: { shrink: true } })}</Grid>
                <Grid item xs={6} sm={4}>
                  {field('subscription_expires_on', form.subscription_plan === 'TRIAL' ? 'Trial ends' : 'Expiry date', {
                    type: 'date', InputLabelProps: { shrink: true }, disabled: perpetual,
                    helperText: perpetual ? 'No expiry' : 'Last day the client can work',
                  })}
                </Grid>
                <Grid item xs={6} sm={4}>
                  {field('max_users', 'Max users (seats)', { type: 'number', inputProps: { min: 1, max: 10000 },
                    helperText: `${tenant.active_user_count} active now` })}
                </Grid>
                <Grid item xs={6} sm={4}>
                  {field('max_branches', 'Max branches', { type: 'number', inputProps: { min: 1, max: 1000 },
                    helperText: `${tenant.active_branch_count ?? tenant.branch_count} active · blank = no limit` })}
                </Grid>
              </Grid>
            </>
          )}
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
          <dt>Company</dt><dd style={{ margin: 0 }}>{tenant.company_name || '—'}</dd>
          <dt>Created</dt><dd style={{ margin: 0 }}>{fmtDate(tenant.created_at)}</dd>
          <dt>Owner login</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{tenant.primary_admin || '—'}</dd>
          <dt>Branches</dt><dd style={{ margin: 0 }}>{tenant.active_branch_count ?? tenant.branch_count} active{tenant.max_branches ? ` of ${tenant.max_branches}` : ''}</dd>
          {!tenant.is_platform && (
            <>
              <dt>Plan</dt><dd style={{ margin: 0 }}>{planLabel(catalog, tenant.subscription_plan)}</dd>
              <dt>Expires</dt>
              <dd style={{ margin: 0 }}>
                {tenant.subscription_expires_on ? `${fmtDate(tenant.subscription_expires_on)} (${tenant.days_to_expiry >= 0 ? `${tenant.days_to_expiry} days left` : 'ended'})` : 'Never'}
              </dd>
            </>
          )}
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
          <Button sx={{ mt: 2 }} variant="outlined" color={lifecycleOf(tenant.status).color} startIcon={<PowerIcon />}
            onClick={onLifecycle}>
            {`${lifecycleOf(tenant.status).label} client…`}
          </Button>
        )}
      </Grid>
    </Grid>
  );
}

const subscriptionOf = (t) => ({ package: t.package, modules: t.modules, settings_features: t.settings_features ?? null });

function ModulesTab({ catalog, tenant, onSave, saving }) {
  const [value, setValue] = useState(() => subscriptionOf(tenant));
  const sectionsKey = (tenant.settings_features ?? []).join();
  useEffect(() => { setValue(subscriptionOf(tenant)); }, [tenant.package, tenant.modules, sectionsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const dirty = value.package !== tenant.package || value.modules.join() !== tenant.modules.join()
    || JSON.stringify(value.settings_features ?? null) !== JSON.stringify(tenant.settings_features ?? null);
  const [error, setError] = useState('');

  const save = async () => {
    setError('');
    // Settings off: the section pick is kept as it was (it only applies while Settings is on).
    const body = { package: value.package, modules: value.modules };
    if (value.modules.includes('settings')) body.settings_features = value.settings_features;
    const fieldErrors = await onSave(body, ['modules', 'settings_features']);
    if (fieldErrors?.modules || fieldErrors?.settings_features) setError(fieldErrors.modules || fieldErrors.settings_features);
  };

  return (
    <Stack spacing={3}>
      <Box>
        {tenant.is_platform && <Alert severity="info" sx={{ mb: 2 }}>The platform account always has every module.</Alert>}
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <ModuleAccessEditor catalog={catalog} value={value} onChange={setValue} disabled={tenant.is_platform || saving} />
        {!tenant.is_platform && (
          <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1.5 }}>
            <Button disabled={!dirty || saving} onClick={() => setValue(subscriptionOf(tenant))}>Discard</Button>
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
    notify(`${row.name}: ${(STATUS_META[row.status] || STATUS_META.ACTIVE).label.toLowerCase()}.`, 'success');
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
          {data && <Chip size="small" label={(STATUS_META[data.status] || STATUS_META.ACTIVE).label} color={(STATUS_META[data.status] || STATUS_META.ACTIVE).color} />}
          {data && <Chip size="small" variant="outlined" label={packageLabel(catalog, data.package)} />}
        </Stack>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" sx={{ mt: 1 }}>
          <Tab label="Overview" />
          <Tab label="Modules & Permissions" />
          <Tab label={data ? `Users (${data.users.length})` : 'Users'} />
          <Tab label={data ? `Branches (${data.branches.length})` : 'Branches'} />
          <Tab label="Data & Audit" />
          <Tab label="Backups" />
          <Tab label="History" />
        </Tabs>
      </DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error">{error}</Alert>}
        {!data && !error && <LinearProgress />}
        {data && tab === 0 && <Overview catalog={catalog} tenant={data} onSave={save} saving={saving} onLifecycle={() => setLifecycle(true)} />}
        {data && tab === 1 && <ModulesTab catalog={catalog} tenant={data} onSave={save} saving={saving} />}
        {data && tab === 2 && <ClientUsersPanel catalog={catalog} tenant={data} onChanged={changed} />}
        {data && tab === 3 && <ClientBranchesPanel tenant={data} onChanged={changed} />}
        {data && tab === 4 && <ClientDataPanel tenant={data} />}
        {data && tab === 5 && <ClientBackupsPanel tenant={data} />}
        {data && tab === 6 && <HistoryTab catalog={catalog} tenantId={tenantId} version={version} />}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>

      {lifecycle && data && (lifecycleOf(data.status).kind === 'deactivate'
        ? <DeactivateDialog catalog={catalog} tenant={data} onClose={() => setLifecycle(false)} onDone={lifecycleDone} />
        : <ReactivateDialog tenant={data} onClose={() => setLifecycle(false)} onDone={lifecycleDone} />)}
    </Dialog>
  );
}
