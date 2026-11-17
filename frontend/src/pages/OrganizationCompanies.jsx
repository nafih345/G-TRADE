import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Box, Paper, Typography, Button, Table, TableHead, TableRow, TableCell, TableBody, Chip, Dialog, DialogTitle,
  DialogContent, DialogActions, TextField, MenuItem, FormControlLabel, Switch, Checkbox, FormGroup, Alert,
  IconButton, Tooltip, Stack, LinearProgress,
} from '@mui/material';
import {
  Add as AddIcon, Group as MembersIcon, ContentCopy as CopyIcon, Edit as EditIcon,
} from '@mui/icons-material';
import { useAuth, roleLabel } from '../context/AuthContext';
import { apiErrorMessage } from '../utils/apiError';
import { notify } from '../utils/notify';
import { membershipPayload, validateCompanyForm, validateMembershipForm } from '../utils/companies';

/**
 * Phase 2 — Organization → Companies (organization administrators only; the server enforces it).
 * Create companies with their own default masters, grant users of the organization access to a
 * company (role + branches there), rename companies, and copy master lists between companies.
 * Deactivating a company stays with the platform provider.
 */
export default function OrganizationCompanies() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [membersOf, setMembersOf] = useState(null);
  const [copyInto, setCopyInto] = useState(null);
  const [renaming, setRenaming] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await axios.get('/api/organization/');
      setData(res.data);
      setError('');
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not load your organization.'));
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (!user?.is_org_admin) {
    return <Box sx={{ p: 4 }}><Alert severity="info">Only an organization administrator can manage companies.</Alert></Box>;
  }

  return (
    <Box sx={{ p: { xs: 2, md: 3 } }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 2 }}>
        <Box>
          <Typography variant="h5" fontWeight={800}>Companies</Typography>
          <Typography variant="body2" color="text.secondary">
            {data ? `${data.organization.name}: ${data.companies.length} of ${data.organization.max_companies} companies.` : ' '}
            {' '}Each company keeps its own books, stock, customers and settings.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} disabled={!data?.can_create} onClick={() => setCreateOpen(true)}>
          New company
        </Button>
      </Stack>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {!data && !error && <LinearProgress />}
      {data && !data.can_create && (
        <Alert severity="info" sx={{ mb: 2 }}>Your organization has reached its company limit. Ask your provider to raise it.</Alert>
      )}
      {data && (
        <Paper variant="outlined" sx={{ borderRadius: 2, overflowX: 'auto' }}>
          <Table size="small">
            <TableHead>
              <TableRow>
                <TableCell>Company</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="right">Own users</TableCell>
                <TableCell align="right">Members</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {data.companies.map((c) => (
                <TableRow key={c.tenant_id} data-testid={`org-company-${c.tenant_id}`}>
                  <TableCell>
                    <Typography fontWeight={700}>{c.name}</Typography>
                    <Typography variant="caption" color="text.secondary">{c.code}</Typography>
                  </TableCell>
                  <TableCell>
                    <Stack direction="row" spacing={0.5}>
                      {c.tenant_id === data.active_tenant_id && <Chip size="small" color="primary" label="Current" />}
                      {c.is_home && <Chip size="small" label="Your home" />}
                      {!c.is_active && <Chip size="small" color="error" label="Disabled" />}
                      {!c.can_access && <Chip size="small" variant="outlined" label="No access" />}
                    </Stack>
                  </TableCell>
                  <TableCell align="right">{c.home_users}</TableCell>
                  <TableCell align="right">{c.members}</TableCell>
                  <TableCell align="right">
                    <Tooltip title="Rename"><IconButton size="small" onClick={() => setRenaming(c)}><EditIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title="Members"><IconButton size="small" onClick={() => setMembersOf(c)}><MembersIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title="Copy master lists into this company">
                      <IconButton size="small" onClick={() => setCopyInto(c)}><CopyIcon fontSize="small" /></IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Paper>
      )}
      {createOpen && <CreateCompanyDialog org={data} onClose={() => setCreateOpen(false)} onDone={load} />}
      {membersOf && <MembersDialog company={membersOf} roles={data.roles} onClose={() => { setMembersOf(null); load(); }} />}
      {copyInto && <CopyMastersDialog target={copyInto} org={data} onClose={() => setCopyInto(null)} />}
      {renaming && <RenameDialog company={renaming} onClose={() => setRenaming(null)} onDone={load} />}
    </Box>
  );
}

function SectionPicker({ sections, value, onChange }) {
  return (
    <FormGroup>
      {sections.map((s) => (
        <FormControlLabel key={s.key} label={s.label} control={
          <Checkbox size="small" checked={value.includes(s.key)}
                    onChange={(e) => onChange(e.target.checked ? [...value, s.key] : value.filter((k) => k !== s.key))} />
        } />
      ))}
    </FormGroup>
  );
}

function CreateCompanyDialog({ org, onClose, onDone }) {
  const [name, setName] = useState('');
  const [branchName, setBranchName] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [sections, setSections] = useState([]);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);
  const sources = org.companies.filter((c) => c.can_access);

  const submit = async () => {
    const errs = validateCompanyForm({ name, copyFrom, sections });
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await axios.post('/api/organization/companies/', {
        name: name.trim(), branch_name: branchName.trim(), copy_from: copyFrom || null, sections: copyFrom ? sections : [],
      });
      notify(`Company "${res.data.name}" created. Switch to it from the company menu at the top.`, 'success');
      onDone();
      onClose();
    } catch (e) {
      setErrors({ form: apiErrorMessage(e, 'Could not create the company.') });
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>New company</DialogTitle>
      <DialogContent>
        {errors.form && <Alert severity="error" sx={{ mb: 2 }}>{errors.form}</Alert>}
        <TextField autoFocus fullWidth margin="dense" label="Company name" value={name} onChange={(e) => setName(e.target.value)}
                   error={Boolean(errors.name)} helperText={errors.name} />
        <TextField fullWidth margin="dense" label="First branch name (optional)" placeholder="Head Office"
                   value={branchName} onChange={(e) => setBranchName(e.target.value)} />
        <Alert severity="info" sx={{ my: 2 }}>
          The new company starts empty with its own chart of accounts, numbering and settings. Nothing is shared
          with other companies unless you copy it below. You become its Super Admin.
        </Alert>
        <TextField select fullWidth margin="dense" label="Copy master lists from" value={copyFrom}
                   onChange={(e) => setCopyFrom(e.target.value)}>
          <MenuItem value="">Do not copy</MenuItem>
          {sources.map((c) => <MenuItem key={c.tenant_id} value={c.tenant_id}>{c.name}</MenuItem>)}
        </TextField>
        {copyFrom && <SectionPicker sections={org.copy_sections} value={sections} onChange={setSections} />}
        {errors.sections && <Typography color="error" variant="caption">{errors.sections}</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create company'}</Button>
      </DialogActions>
    </Dialog>
  );
}

function RenameDialog({ company, onClose, onDone }) {
  const [name, setName] = useState(company.name);
  const [error, setError] = useState('');
  const save = async () => {
    try {
      await axios.patch(`/api/organization/companies/${company.tenant_id}/`, { name: name.trim() });
      onDone();
      onClose();
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not rename the company.'));
    }
  };
  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle>Rename company</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        <TextField autoFocus fullWidth margin="dense" label="Company name" value={name} onChange={(e) => setName(e.target.value)} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={!name.trim()}>Save</Button>
      </DialogActions>
    </Dialog>
  );
}

const EMPTY_FORM = { userId: '', role: 'SALES_EXECUTIVE', allBranches: false, branchIds: [], defaultBranchId: '', isActive: true };

function MembersDialog({ company, roles, onClose }) {
  const [members, setMembers] = useState([]);
  const [users, setUsers] = useState([]);
  const [branches, setBranches] = useState([]);
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const [m, u, b] = await Promise.all([
      axios.get(`/api/organization/companies/${company.tenant_id}/members/`),
      axios.get('/api/organization/users/'),
      axios.get(`/api/organization/companies/${company.tenant_id}/branches/`),
    ]);
    setMembers(m.data.members);
    setUsers(u.data);
    setBranches(b.data);
  }, [company.tenant_id]);
  useEffect(() => { load().catch((e) => setErrors({ form: apiErrorMessage(e, 'Could not load members.') })); }, [load]);

  // Users whose home is this company already have access; they are managed in Administration → Users.
  const candidates = useMemo(() => users.filter((u) => u.home_tenant_id !== company.tenant_id && u.is_active), [users, company]);

  const edit = (m) => setForm({
    userId: m.user_id, role: m.role, allBranches: m.all_branches, branchIds: m.branch_ids,
    defaultBranchId: m.default_branch_id || '', isActive: m.is_active,
  });

  const save = async (override = {}) => {
    const f = { ...form, ...override };
    const errs = f.isActive ? validateMembershipForm(f) : {};
    setErrors(errs);
    if (Object.keys(errs).length) return;
    setBusy(true);
    try {
      const res = await axios.post(`/api/organization/companies/${company.tenant_id}/members/`, membershipPayload(f));
      setMembers(res.data.members);
      setForm(EMPTY_FORM);
      notify(f.isActive ? 'Access saved.' : 'Access removed. The user is signed out of this company.', 'success');
    } catch (e) {
      setErrors({ form: apiErrorMessage(e, 'Could not save the access.') });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>Members of {company.name}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Give users of your other companies access to this company. Their role and branches here are separate
          from their own company.
        </Typography>
        {errors.form && <Alert severity="error" sx={{ mb: 2 }}>{errors.form}</Alert>}
        <Table size="small" sx={{ mb: 2 }}>
          <TableHead>
            <TableRow><TableCell>User</TableCell><TableCell>Home company</TableCell><TableCell>Role here</TableCell>
              <TableCell>Branches</TableCell><TableCell>Status</TableCell><TableCell /></TableRow>
          </TableHead>
          <TableBody>
            {members.length === 0 && <TableRow><TableCell colSpan={6}><Typography variant="body2" color="text.secondary">No members yet.</Typography></TableCell></TableRow>}
            {members.map((m) => (
              <TableRow key={m.id}>
                <TableCell>{m.name}<Typography variant="caption" display="block" color="text.secondary">{m.username}</Typography></TableCell>
                <TableCell>{m.home_company}</TableCell>
                <TableCell>{roleLabel(m.role)}</TableCell>
                <TableCell>{m.all_branches ? 'All branches' : `${m.branch_ids.length} branch(es)`}</TableCell>
                <TableCell>{m.is_active ? <Chip size="small" color="success" label="Active" /> : <Chip size="small" label="Removed" />}</TableCell>
                <TableCell align="right">
                  <Button size="small" onClick={() => edit(m)}>Edit</Button>
                  {m.is_active && (
                    <Button size="small" color="error" disabled={busy}
                            onClick={() => save({ userId: m.user_id, role: m.role, isActive: false, allBranches: m.all_branches, branchIds: m.branch_ids })}>
                      Remove
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>

        <Typography fontWeight={700} sx={{ mb: 1 }}>{form.userId && members.some((m) => m.user_id === form.userId) ? 'Change access' : 'Add a member'}</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <TextField select size="small" label="User" value={form.userId} sx={{ minWidth: 220 }}
                     onChange={(e) => setForm({ ...form, userId: e.target.value })}
                     error={Boolean(errors.userId)} helperText={errors.userId}>
            {candidates.map((u) => <MenuItem key={u.id} value={u.id}>{u.name} ({u.home_company})</MenuItem>)}
          </TextField>
          <TextField select size="small" label="Role in this company" value={form.role} sx={{ minWidth: 200 }}
                     onChange={(e) => setForm({ ...form, role: e.target.value })} error={Boolean(errors.role)}>
            {roles.map((r) => <MenuItem key={r.key} value={r.key}>{r.label}</MenuItem>)}
          </TextField>
        </Stack>
        <FormControlLabel sx={{ mt: 1 }} label="All branches of this company" control={
          <Switch checked={form.allBranches} onChange={(e) => setForm({ ...form, allBranches: e.target.checked })} />
        } />
        {!form.allBranches && (
          <FormGroup row>
            {branches.map((b) => (
              <FormControlLabel key={b.id} label={b.name} control={
                <Checkbox size="small" checked={form.branchIds.includes(b.id)} onChange={(e) => setForm({
                  ...form, branchIds: e.target.checked ? [...form.branchIds, b.id] : form.branchIds.filter((x) => x !== b.id),
                })} />
              } />
            ))}
          </FormGroup>
        )}
        {errors.branchIds && <Typography color="error" variant="caption">{errors.branchIds}</Typography>}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Close</Button>
        <Button variant="contained" disabled={busy} onClick={() => save({ isActive: true })}>Save access</Button>
      </DialogActions>
    </Dialog>
  );
}

function CopyMastersDialog({ target, org, onClose }) {
  const [source, setSource] = useState('');
  const [sections, setSections] = useState([]);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const sources = org.companies.filter((c) => c.can_access && c.tenant_id !== target.tenant_id);

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await axios.post(`/api/organization/companies/${target.tenant_id}/copy-masters/`,
        { source_tenant_id: source, sections });
      setResult(res.data.sections);
    } catch (e) {
      setError(apiErrorMessage(e, 'Could not copy.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onClose={busy ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle>Copy master lists into {target.name}</DialogTitle>
      <DialogContent>
        <Alert severity="info" sx={{ mb: 2 }}>
          A one-time copy. The copies are independent: later changes in either company do not affect the other.
          Existing entries are never overwritten. Stock, balances, customers and transactions are never copied.
        </Alert>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <TextField select fullWidth margin="dense" label="Copy from" value={source} onChange={(e) => setSource(e.target.value)}>
          {sources.map((c) => <MenuItem key={c.tenant_id} value={c.tenant_id}>{c.name}</MenuItem>)}
        </TextField>
        <SectionPicker sections={org.copy_sections} value={sections} onChange={setSections} />
        {result && (
          <Alert severity="success" sx={{ mt: 2 }}>
            {Object.entries(result).map(([k, v]) => `${k}: ${v.created} copied, ${v.skipped} already there`).join(' · ')}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={busy}>Close</Button>
        <Button variant="contained" onClick={run} disabled={busy || !source || sections.length === 0}>
          {busy ? 'Copying…' : 'Copy'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
