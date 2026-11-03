// Users of one client: seat usage, add (seat limit enforced by the server), edit role / contact /
// active / branch access, reset password. The platform owner's own account is read-only here.
//
// Used by the platform console (usersUrl = /api/superadmin/tenants/<id>/users/) and by the
// business's own Administration → Users (usersUrl = /api/auth/users/). The latter's catalog adds
// assignable_roles (roles this admin may hand out), role_access (what each role opens) and marks
// users with can_manage = false when this admin may not edit them.
import React, { useState } from 'react';
import axios from 'axios';
import {
  Box, Stack, Typography, Button, Table, TableHead, TableRow, TableCell, TableBody, TableContainer,
  Chip, LinearProgress, Alert, Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  Grid, FormControlLabel, Switch, Checkbox, FormGroup, InputAdornment, IconButton, Tooltip, CircularProgress,
} from '@mui/material';
import {
  PersonAdd as AddIcon, Edit as EditIcon, LockReset as ResetIcon, AutoAwesome as GenerateIcon,
  Visibility, VisibilityOff, ContentCopy as CopyIcon,
} from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { API, copy, fmtDate, generatePassword, isReauth, roleLabel, splitErrors } from './clientApi';

const FIELDS = ['username', 'password', 'role', 'first_name', 'last_name', 'email', 'phone', 'is_active',
  'branch_ids', 'default_branch_id', 'access_all_branches', 'max_users'];

function PasswordField({ value, onChange, error, disabled, label = 'Password' }) {
  const [show, setShow] = useState(false);
  return (
    <TextField fullWidth size="small" label={label} required type={show ? 'text' : 'password'} value={value}
      onChange={(e) => onChange(e.target.value)} error={Boolean(error)} helperText={error || ' '} disabled={disabled}
      autoComplete="new-password"
      InputProps={{
        endAdornment: (
          <InputAdornment position="end">
            <Tooltip title="Generate a strong password">
              <IconButton size="small" aria-label="Generate a strong password" disabled={disabled}
                onClick={() => { onChange(generatePassword()); setShow(true); }}>
                <GenerateIcon fontSize="small" />
              </IconButton>
            </Tooltip>
            <IconButton size="small" edge="end" aria-label={show ? 'Hide password' : 'Show password'} onClick={() => setShow((v) => !v)}>
              {show ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
            </IconButton>
          </InputAdornment>
        ),
      }} />
  );
}

const LEVEL_META = { full: { label: 'Full', color: 'success' }, view: { label: 'View only', color: 'info' } };

// What the chosen role opens in this business (Administration catalog only).
function RoleAccessSummary({ catalog, role }) {
  const access = catalog.role_access?.[role];
  if (!access) return null;
  const entries = (catalog.modules || []).filter((m) => access[m.key]);
  return (
    <Box sx={{ mb: 1.5 }}>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mb: 0.5 }}>
        This role can open:
      </Typography>
      {entries.length === 0 ? (
        <Typography variant="caption" color="warning.main">No modules — this role can sign in but sees nothing.</Typography>
      ) : (
        <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.75}>
          {entries.map((m) => (
            <Chip key={m.key} size="small" variant="outlined" color={LEVEL_META[access[m.key]]?.color}
              label={`${m.label}: ${LEVEL_META[access[m.key]]?.label || access[m.key]}`} />
          ))}
        </Stack>
      )}
    </Box>
  );
}

function UserDialog({ catalog, tenant, usersUrl, user, onClose, onSaved }) {
  const isNew = !user;
  const access = user?.branch_access || {};
  const roles = catalog.assignable_roles
    ? catalog.roles.filter((r) => catalog.assignable_roles.includes(r.key))
    : catalog.roles;
  const [form, setForm] = useState({
    username: '', password: '',
    role: user?.role || (roles.some((r) => r.key === 'SALES_EXECUTIVE') ? 'SALES_EXECUTIVE' : roles[roles.length - 1]?.key),
    first_name: user?.first_name || '', last_name: user?.last_name || '',
    email: user?.email || '', phone: user?.phone || '', is_active: user ? user.is_active : true,
    access_all_branches: Boolean(access.access_all_branches),
    branch_ids: access.branch_ids || (tenant.branches.length === 1 ? [String(tenant.branches[0].id)] : []),
    default_branch_id: access.default_branch_id || (tenant.branches.find((b) => b.is_default)?.id ?? null),
  });
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setErrors((e) => ({ ...e, [key]: undefined })); };

  const toggleBranch = (id, on) => set('branch_ids', on ? [...form.branch_ids, id] : form.branch_ids.filter((b) => b !== id));

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setGeneral('');
    const body = { ...form, default_branch_id: form.default_branch_id ? String(form.default_branch_id) : null };
    if (!isNew) { delete body.username; delete body.password; }
    try {
      const { data } = isNew
        ? await axios.post(usersUrl, body)
        : await axios.patch(`${usersUrl}${user.id}/`, body);
      onSaved(data, isNew ? { username: form.username, password: form.password } : null);
    } catch (err) {
      if (isReauth(err)) return;
      const { fields, general: msg } = splitErrors(err, FIELDS, 'The user could not be saved.');
      setErrors(fields);
      setGeneral([msg, fields.max_users].filter(Boolean).join(' '));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="client-user-title">
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id="client-user-title">{isNew ? `Add user to ${tenant.name}` : `Edit ${user.username}`}</DialogTitle>
        <DialogContent dividers>
          {general && <Alert severity="error" sx={{ mb: 2 }}>{general}</Alert>}
          <Grid container columnSpacing={2}>
            {isNew && (
              <>
                <Grid item xs={12} sm={6}>
                  <TextField fullWidth size="small" label="User ID (username)" required autoFocus value={form.username}
                    onChange={(e) => set('username', e.target.value)} error={Boolean(errors.username)}
                    helperText={errors.username || ' '} inputProps={{ maxLength: 150, spellCheck: false }} autoComplete="off" />
                </Grid>
                <Grid item xs={12} sm={6}>
                  <PasswordField value={form.password} onChange={(v) => set('password', v)} error={errors.password} disabled={saving} />
                </Grid>
              </>
            )}
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth size="small" label="Role" value={form.role} onChange={(e) => set('role', e.target.value)}
                error={Boolean(errors.role)} helperText={errors.role || ' '}>
                {roles.map((r) => <MenuItem key={r.key} value={r.key}>{r.label}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControlLabel sx={{ mt: 0.5 }} control={<Switch checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />}
                label={form.is_active ? 'Active (uses a seat)' : 'Disabled'} />
              {errors.is_active && <Typography variant="caption" color="error" component="div">{errors.is_active}</Typography>}
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="First name" value={form.first_name} onChange={(e) => set('first_name', e.target.value)} helperText=" " />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="Last name" value={form.last_name} onChange={(e) => set('last_name', e.target.value)} helperText=" " />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="Email" type="email" value={form.email} onChange={(e) => set('email', e.target.value)}
                error={Boolean(errors.email)} helperText={errors.email || ' '} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="Phone" type="tel" value={form.phone} onChange={(e) => set('phone', e.target.value)}
                helperText=" " inputProps={{ maxLength: 20 }} />
            </Grid>
          </Grid>
          <RoleAccessSummary catalog={catalog} role={form.role} />
          <Typography variant="subtitle2" fontWeight={700} sx={{ mt: 1 }}>Branch access</Typography>
          <FormControlLabel control={<Switch checked={form.access_all_branches} onChange={(e) => set('access_all_branches', e.target.checked)} />}
            label="All branches" />
          {!form.access_all_branches && (
            <FormGroup row>
              {tenant.branches.map((b) => (
                <FormControlLabel key={b.id} label={`${b.name} (${b.code})`}
                  control={<Checkbox size="small" checked={form.branch_ids.includes(String(b.id))}
                    onChange={(e) => toggleBranch(String(b.id), e.target.checked)} />} />
              ))}
            </FormGroup>
          )}
          {errors.branch_ids && <Typography variant="caption" color="error">{errors.branch_ids}</Typography>}
          <TextField select fullWidth size="small" label="Default branch" sx={{ mt: 1.5 }}
            value={form.default_branch_id ? String(form.default_branch_id) : ''}
            onChange={(e) => set('default_branch_id', e.target.value || null)}
            error={Boolean(errors.default_branch_id)} helperText={errors.default_branch_id || ' '}>
            <MenuItem value="">— none —</MenuItem>
            {tenant.branches.map((b) => <MenuItem key={b.id} value={String(b.id)}>{b.name}</MenuItem>)}
          </TextField>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}>
            {isNew ? 'Add user' : 'Save'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

function ResetPasswordDialog({ usersUrl, user, onClose }) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      await axios.post(`${usersUrl}${user.id}/reset-password/`, { password });
      setDone(true);
    } catch (err) {
      if (isReauth(err)) return;
      const { fields, general } = splitErrors(err, ['password'], 'The password could not be changed.');
      setError(fields.password || general);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth aria-labelledby="reset-pw-title">
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id="reset-pw-title">Reset password — {user.username}</DialogTitle>
        <DialogContent dividers>
          {done ? (
            <Alert severity="success" action={<Button size="small" startIcon={<CopyIcon />}
              onClick={() => copy(`Username: ${user.username}\nPassword: ${password}`)}>Copy</Button>}>
              Password changed; their open sessions were ended. New password: <b style={{ fontFamily: 'monospace' }}>{password}</b>
            </Alert>
          ) : (
            <PasswordField label="New password" value={password} onChange={(v) => { setPassword(v); setError(''); }} error={error} disabled={saving} />
          )}
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>{done ? 'Close' : 'Cancel'}</Button>
          {!done && <Button type="submit" variant="contained" disabled={saving || !password}>Set password</Button>}
        </DialogActions>
      </Box>
    </Dialog>
  );
}

export default function ClientUsersPanel({ catalog, tenant, onChanged, usersUrl = `${API}${tenant.id}/users/`, seatHint }) {
  const [editing, setEditing] = useState(null); // 'new' | user
  const [resetting, setResetting] = useState(null);
  const [created, setCreated] = useState(null);

  const used = tenant.users.filter((u) => u.is_active).length;
  const full = used >= tenant.max_users;
  const loginRoles = catalog.login_enabled_roles || [];
  const blockedRoles = [...new Set(tenant.users.filter((u) => u.is_active && !u.is_platform_admin && !loginRoles.includes(u.role)).map((u) => u.role))];
  const branchName = (id) => tenant.branches.find((b) => String(b.id) === String(id))?.name;

  const saved = (data, credentials) => {
    onChanged(data);
    setEditing(null);
    if (credentials) setCreated(credentials);
    notify(credentials ? `User ${credentials.username} added.` : 'User saved.', 'success');
  };

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Box sx={{ minWidth: 240 }}>
          <Typography variant="body2" fontWeight={700}>Seats: {used} of {tenant.max_users} in use</Typography>
          <LinearProgress variant="determinate" value={Math.min(100, (used / Math.max(1, tenant.max_users)) * 100)}
            color={full ? 'warning' : 'primary'} sx={{ height: 6, borderRadius: 3, mt: 0.5 }} />
          <Typography variant="caption" color="text.secondary">
            {seatHint ?? 'Disabled users don’t use a seat. Change the limit under Overview.'}
          </Typography>
        </Box>
        <Tooltip title={full ? 'All seats are in use — raise the limit or disable a user' : ''}>
          <span>
            <Button variant="contained" startIcon={<AddIcon />} disabled={full} onClick={() => setEditing('new')}>Add user</Button>
          </span>
        </Tooltip>
      </Stack>

      {created && (
        <Alert severity="success" onClose={() => setCreated(null)} sx={{ mb: 1.5 }}
          action={<Button size="small" startIcon={<CopyIcon />} onClick={() => copy(`Username: ${created.username}\nPassword: ${created.password}`)}>Copy</Button>}>
          Share with the user — shown only now: <b style={{ fontFamily: 'monospace' }}>{created.username}</b> / <b style={{ fontFamily: 'monospace' }}>{created.password}</b>
        </Alert>
      )}
      {blockedRoles.length > 0 && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          Sign-in is currently enabled on this installation only for: {loginRoles.map((r) => roleLabel(catalog, r)).join(', ')}.
          {' '}{blockedRoles.map((r) => roleLabel(catalog, r)).join(', ')} accounts are set up but cannot sign in until the
          server’s <code>LOGIN_ENABLED_ROLES</code> includes them.
        </Alert>
      )}

      <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5 }}>
        <Table size="small" aria-label="Client users">
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
              <TableCell>User</TableCell><TableCell>Role</TableCell><TableCell>Branches</TableCell>
              <TableCell>Last sign-in</TableCell><TableCell>Status</TableCell><TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {tenant.users.map((u) => {
              const a = u.branch_access;
              const branches = !a ? '—' : a.access_all_branches ? 'All branches'
                : (a.branch_ids.map(branchName).filter(Boolean).join(', ') || '—');
              return (
                <TableRow key={u.id} hover sx={{ opacity: u.is_active ? 1 : 0.6 }}>
                  <TableCell>
                    <Typography variant="body2" fontWeight={600} sx={{ fontFamily: 'monospace' }}>{u.username}</Typography>
                    <Typography variant="caption" color="text.secondary">
                      {[u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || ''}
                    </Typography>
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{u.is_platform_admin ? 'Platform administrator' : roleLabel(catalog, u.role)}</TableCell>
                  <TableCell sx={{ maxWidth: 220 }}>
                    <Typography variant="caption">{branches}</Typography>
                    {a?.default_branch_id && <Typography variant="caption" color="text.secondary" component="div">Default: {branchName(a.default_branch_id)}</Typography>}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{u.last_login ? fmtDate(u.last_login) : 'Never'}</TableCell>
                  <TableCell>
                    <Chip size="small" label={u.is_active ? 'Active' : 'Disabled'} color={u.is_active ? 'success' : 'default'}
                      variant={u.is_active ? 'filled' : 'outlined'} />
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    {!u.is_platform_admin && u.can_manage !== false && (
                      <>
                        <Button size="small" startIcon={<EditIcon />} onClick={() => setEditing(u)} aria-label={`Edit ${u.username}`}>Edit</Button>
                        <Button size="small" startIcon={<ResetIcon />} onClick={() => setResetting(u)} aria-label={`Reset password of ${u.username}`}>Password</Button>
                      </>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>

      {editing && (
        <UserDialog catalog={catalog} tenant={tenant} usersUrl={usersUrl} user={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)} onSaved={saved} />
      )}
      {resetting && <ResetPasswordDialog usersUrl={usersUrl} user={resetting} onClose={() => setResetting(null)} />}
    </Box>
  );
}
