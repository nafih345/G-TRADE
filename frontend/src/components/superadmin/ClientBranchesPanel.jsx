// Branch network of one client: add / edit branches, (de)activate, pick the default, and the
// client's Multi-Branch Mode switch (BusinessSettings.multi_branch_enabled in its tenant).
import React, { useState } from 'react';
import axios from 'axios';
import {
  Box, Stack, Typography, Button, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Grid, Alert, FormControlLabel, Switch, CircularProgress,
} from '@mui/material';
import { AddBusiness as AddIcon, Edit as EditIcon, Star as DefaultIcon } from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { apiErrorMessage } from '../../utils/apiError';
import { API, isReauth, splitErrors } from './clientApi';

const FIELDS = ['name', 'code', 'phone', 'email', 'address', 'city', 'state', 'country', 'pin_code', 'is_active', 'is_default'];

function BranchDialog({ tenant, branch, onClose, onSaved }) {
  const isNew = !branch;
  const [form, setForm] = useState(() => Object.fromEntries(FIELDS.filter((f) => !f.startsWith('is_'))
    .map((f) => [f, branch?.[f] || ''])));
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setErrors((x) => ({ ...x, [key]: undefined })); };

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    setGeneral('');
    try {
      const { data } = isNew
        ? await axios.post(`${API}${tenant.id}/branches/`, form)
        : await axios.patch(`${API}${tenant.id}/branches/${branch.id}/`, form);
      onSaved(data);
    } catch (err) {
      if (isReauth(err)) return;
      const { fields, general: msg } = splitErrors(err, FIELDS, 'The branch could not be saved.');
      setErrors(fields);
      setGeneral(msg);
    } finally {
      setSaving(false);
    }
  };

  const field = (key, label, props = {}) => (
    <TextField fullWidth size="small" label={label} value={form[key]} onChange={set(key)} disabled={saving}
      error={Boolean(errors[key])} helperText={errors[key] || ' '} {...props} />
  );

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="client-branch-title">
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id="client-branch-title">{isNew ? `Add branch — ${tenant.name}` : `Edit ${branch.name}`}</DialogTitle>
        <DialogContent dividers>
          {general && <Alert severity="error" sx={{ mb: 2 }}>{general}</Alert>}
          <Grid container columnSpacing={2}>
            <Grid item xs={12} sm={8}>{field('name', 'Branch name', { required: true, autoFocus: true, inputProps: { maxLength: 100 } })}</Grid>
            <Grid item xs={12} sm={4}>{field('code', 'Code', { required: true, inputProps: { maxLength: 20, style: { textTransform: 'uppercase' } } })}</Grid>
            <Grid item xs={12} sm={6}>{field('phone', 'Phone', { type: 'tel', inputProps: { maxLength: 20 } })}</Grid>
            <Grid item xs={12} sm={6}>{field('email', 'Email', { type: 'email' })}</Grid>
            <Grid item xs={12}>{field('address', 'Address', { multiline: true, minRows: 2 })}</Grid>
            <Grid item xs={12} sm={6}>{field('city', 'City')}</Grid>
            <Grid item xs={12} sm={6}>{field('state', 'State / Emirate')}</Grid>
            <Grid item xs={12} sm={6}>{field('country', 'Country')}</Grid>
            <Grid item xs={12} sm={6}>{field('pin_code', 'PIN / Postal code', { inputProps: { maxLength: 20 } })}</Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}>
            {isNew ? 'Add branch' : 'Save'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

export default function ClientBranchesPanel({ tenant, onChanged }) {
  const [editing, setEditing] = useState(null); // 'new' | branch
  const [busy, setBusy] = useState(null);

  const patch = async (key, url, body, done) => {
    setBusy(key);
    try {
      const { data } = await axios.patch(url, body);
      onChanged(data);
      notify(done, 'success');
    } catch (err) {
      if (!isReauth(err)) notify(apiErrorMessage(err, 'The change could not be saved.'), 'error');
    } finally {
      setBusy(null);
    }
  };

  const branchUrl = (b) => `${API}${tenant.id}/branches/${b.id}/`;
  const multiCount = tenant.branches.filter((b) => b.is_active).length;

  return (
    <Box>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} justifyContent="space-between" sx={{ mb: 1.5 }}>
        <Box>
          <FormControlLabel
            control={<Switch checked={tenant.multi_branch_enabled} disabled={busy === 'multi'}
              onChange={(e) => patch('multi', `${API}${tenant.id}/`, { multi_branch_enabled: e.target.checked },
                `Multi-Branch Mode ${e.target.checked ? 'on' : 'off'} for ${tenant.name}.`)} />}
            label={<Typography variant="body2" fontWeight={700}>Multi-Branch Mode</Typography>} />
          <Typography variant="caption" color="text.secondary" component="div">
            {tenant.multi_branch_enabled
              ? 'The client can switch branches; stock and bills are kept per branch.'
              : multiCount > 1 ? 'Off — everything runs on the default branch. Turn on to use the other branches.'
                : 'Off — everything runs on the default branch.'}
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing('new')}>Add branch</Button>
      </Stack>

      <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5 }}>
        <Table size="small" aria-label="Client branches">
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
              <TableCell>Branch</TableCell><TableCell>Code</TableCell><TableCell>Location</TableCell>
              <TableCell>Contact</TableCell><TableCell>Status</TableCell><TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {tenant.branches.map((b) => (
              <TableRow key={b.id} hover sx={{ opacity: b.is_active ? 1 : 0.6 }}>
                <TableCell>
                  <Typography variant="body2" fontWeight={600}>{b.name}</Typography>
                  {b.is_default && <Chip size="small" icon={<DefaultIcon />} label="Default" color="primary" variant="outlined" sx={{ height: 20, mt: 0.25 }} />}
                </TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>{b.code}</TableCell>
                <TableCell><Typography variant="caption">{[b.city, b.state, b.country].filter(Boolean).join(', ') || '—'}</Typography></TableCell>
                <TableCell><Typography variant="caption">{[b.phone, b.email].filter(Boolean).join(' · ') || '—'}</Typography></TableCell>
                <TableCell>
                  <Chip size="small" label={b.is_active ? 'Active' : 'Inactive'} color={b.is_active ? 'success' : 'default'}
                    variant={b.is_active ? 'filled' : 'outlined'} />
                </TableCell>
                <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                  <Button size="small" startIcon={<EditIcon />} onClick={() => setEditing(b)} aria-label={`Edit ${b.name}`}>Edit</Button>
                  {!b.is_default && (
                    <>
                      <Button size="small" disabled={busy === b.id}
                        onClick={() => patch(b.id, branchUrl(b), { is_default: true }, `${b.name} is now the default branch.`)}>
                        Make default
                      </Button>
                      <Button size="small" color={b.is_active ? 'error' : 'success'} disabled={busy === b.id}
                        onClick={() => patch(b.id, branchUrl(b), { is_active: !b.is_active }, `${b.name} ${b.is_active ? 'deactivated' : 'activated'}.`)}>
                        {b.is_active ? 'Deactivate' : 'Activate'}
                      </Button>
                    </>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {!tenant.branches.length && (
              <TableRow><TableCell colSpan={6} align="center" sx={{ py: 3, color: 'text.secondary' }}>No branches yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>

      {editing && (
        <BranchDialog tenant={tenant} branch={editing === 'new' ? null : editing} onClose={() => setEditing(null)}
          onSaved={(data) => { onChanged(data); setEditing(null); notify('Branch saved.', 'success'); }} />
      )}
    </Box>
  );
}
