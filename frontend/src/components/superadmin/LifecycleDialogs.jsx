// Deactivate (mandatory category + reason, effective date, optional planned end) and reactivate
// dialogs for a client. A future effective date schedules the deactivation: the client keeps
// working until that day.
import React, { useState } from 'react';
import axios from 'axios';
import {
  Box, Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem, Alert, Grid,
  CircularProgress, Typography,
} from '@mui/material';
import { API, fmtDate, isReauth, splitErrors, todayIso } from './clientApi';

export function DeactivateDialog({ catalog, tenant, onClose, onDone }) {
  const [form, setForm] = useState({ category: '', reason: '', effective_date: todayIso(), until: '' });
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [saving, setSaving] = useState(false);
  const set = (key) => (e) => { setForm((f) => ({ ...f, [key]: e.target.value })); setErrors((x) => ({ ...x, [key]: undefined })); };
  const scheduled = form.effective_date > todayIso();

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    const missing = {};
    if (!form.category) missing.category = 'Pick a reason category.';
    if (form.reason.trim().length < 5) missing.reason = 'Describe the reason — it is kept on record.';
    if (Object.keys(missing).length) { setErrors(missing); return; }
    setSaving(true);
    setGeneral('');
    try {
      const { data } = await axios.post(`${API}${tenant.id}/deactivate/`, {
        category: form.category, reason: form.reason.trim(), effective_date: form.effective_date || null, until: form.until || null,
      });
      onDone(data);
    } catch (err) {
      if (isReauth(err)) return;
      const { fields, general: msg } = splitErrors(err, ['category', 'reason', 'effective_date', 'until'], 'The client could not be deactivated.');
      setErrors(fields);
      setGeneral(msg);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="deactivate-title">
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id="deactivate-title">Deactivate “{tenant.name}”</DialogTitle>
        <DialogContent dividers>
          {general && <Alert severity="error" sx={{ mb: 2 }}>{general}</Alert>}
          <Alert severity={scheduled ? 'info' : 'warning'} sx={{ mb: 2 }}>
            {scheduled
              ? `Scheduled: the client keeps working until ${fmtDate(form.effective_date)}; from that day nobody can sign in.`
              : 'Immediately: everyone in this client is signed out now and cannot sign in until you reactivate it.'}
            {' '}No data is deleted.
          </Alert>
          <Grid container columnSpacing={2}>
            <Grid item xs={12}>
              <TextField select fullWidth size="small" required label="Reason category" value={form.category} onChange={set('category')}
                error={Boolean(errors.category)} helperText={errors.category || ' '} autoFocus>
                {catalog.deactivation_categories.map((c) => <MenuItem key={c.key} value={c.key}>{c.label}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={12}>
              <TextField fullWidth size="small" required multiline minRows={3} label="Reason for suspension" value={form.reason}
                onChange={set('reason')} error={Boolean(errors.reason)} inputProps={{ maxLength: 2000 }}
                helperText={errors.reason || 'Recorded with the date and your username in the client’s history.'} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" type="date" label="Effective from" value={form.effective_date}
                onChange={set('effective_date')} InputLabelProps={{ shrink: true }}
                error={Boolean(errors.effective_date)} helperText={errors.effective_date || 'Today = immediately'} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" type="date" label="Planned end (optional)" value={form.until}
                onChange={set('until')} InputLabelProps={{ shrink: true }}
                error={Boolean(errors.until)} helperText={errors.until || 'For the record — reactivation stays manual'} />
            </Grid>
          </Grid>
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="contained" color="error" disabled={saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}>
            {scheduled ? 'Schedule deactivation' : 'Deactivate now'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}

export function ReactivateDialog({ tenant, onClose, onDone }) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const scheduled = tenant.status === 'SCHEDULED';

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    setSaving(true);
    try {
      const { data } = await axios.post(`${API}${tenant.id}/reactivate/`, { reason: reason.trim() });
      onDone(data);
    } catch (err) {
      if (isReauth(err)) return;
      setError(splitErrors(err, [], 'The client could not be reactivated.').general);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth aria-labelledby="reactivate-title">
      <Box component="form" noValidate onSubmit={submit}>
        <DialogTitle id="reactivate-title">{scheduled ? 'Cancel scheduled deactivation' : 'Reactivate'} — {tenant.name}</DialogTitle>
        <DialogContent dividers>
          {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
          <Typography variant="body2" sx={{ mb: 1 }}>
            {scheduled ? 'Deactivation was scheduled for ' : 'Deactivated from '}
            <b>{fmtDate(tenant.deactivation_effective_date)}</b> by {tenant.deactivated_by || '—'}:
          </Typography>
          <Alert severity="info" icon={false} sx={{ mb: 2, whiteSpace: 'pre-wrap' }}>{tenant.deactivation_reason || '—'}</Alert>
          <TextField fullWidth size="small" multiline minRows={2} label="Note (optional)" value={reason} autoFocus
            onChange={(e) => setReason(e.target.value)} inputProps={{ maxLength: 2000 }} helperText="Kept in the client’s history." />
        </DialogContent>
        <DialogActions>
          <Button onClick={onClose} disabled={saving}>Close</Button>
          <Button type="submit" variant="contained" color="success" disabled={saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}>
            {scheduled ? 'Cancel deactivation' : 'Reactivate'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
