// Create / edit a licence plan (Licences & Plans → Plans). Every limit is a number or an explicit
// "Unlimited" tick; editing a plan never changes licences already sold (they keep their terms until
// the Vendor Super Admin renews or changes their plan, which shows the differences first).
import React, { useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  FormControlLabel, FormGroup, Grid, MenuItem, TextField, Typography,
} from '@mui/material';
import { isReauth, splitErrors } from '../clientApi';
import { LIC_API, LIMITS, emptyPlanForm, planBody, planErrors, planToForm } from './licenceApi';

const FIELDS = ['name', 'code', 'description', 'edition', 'billing_cycle', 'duration', 'price', 'currency',
  'max_clients', 'max_companies', 'max_branches', 'max_users', 'modules', 'settings_features', 'grace_days'];

export default function PlanDialog({ catalog, plan, onClose, onSaved }) {
  const editing = Boolean(plan?.id);
  const defaultModules = (catalog.packages || []).find((p) => p.key === 'FULL_SUITE')?.modules || [];
  const [form, setForm] = useState(() => (editing ? planToForm(plan) : emptyPlanForm('WINDOWS_LOCAL', defaultModules)));
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [saving, setSaving] = useState(false);
  const sold = editing && (plan.licence_count || 0) > 0;

  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setErrors((e) => ({ ...e, [key]: undefined })); };
  const toggle = (listKey, key) => set(listKey, (form[listKey] || []).includes(key)
    ? form[listKey].filter((k) => k !== key) : [...(form[listKey] || []), key]);
  const tick = (key, on) => { setForm((f) => ({ ...f, unlimited: { ...f.unlimited, [key]: on } })); setErrors((e) => ({ ...e, [`max_${key}`]: undefined })); };

  const save = async () => {
    const errs = planErrors(form);
    if (Object.keys(errs).length) { setErrors(errs); return; }
    setSaving(true); setGeneral('');
    try {
      const body = planBody(form);
      const { data } = editing
        ? await axios.patch(`${LIC_API}plans/${plan.id}/`, body)
        : await axios.post(`${LIC_API}plans/`, body);
      onSaved(data);
    } catch (err) {
      if (isReauth(err)) return;
      const { fields, general: msg } = splitErrors(err, FIELDS, 'The plan could not be saved.');
      setErrors(fields); setGeneral(msg);
    } finally {
      setSaving(false);
    }
  };

  const tf = (key, label, props = {}) => (
    <TextField fullWidth size="small" label={label} value={form[key] ?? ''} onChange={(e) => set(key, e.target.value)}
      error={Boolean(errors[key])} helperText={errors[key] || props.helperText || ' '} disabled={saving || props.disabled} {...props} />
  );
  const lifetime = form.billing_cycle === 'LIFETIME';

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="md" fullWidth aria-labelledby="plan-title">
      <DialogTitle id="plan-title">{editing ? `Edit plan — ${plan.name}` : 'New plan'}</DialogTitle>
      <DialogContent dividers>
        {general && <Alert severity="error" sx={{ mb: 2 }}>{general}</Alert>}
        {sold && (
          <Alert severity="info" sx={{ mb: 2 }}>
            {plan.licence_count} licence{plan.licence_count === 1 ? '' : 's'} were sold on this plan. They keep their
            current terms; renewing or changing their plan later shows the differences before applying them.
          </Alert>
        )}
        <Grid container columnSpacing={2}>
          <Grid item xs={12} sm={6}>{tf('name', 'Plan name', { autoFocus: true, required: true, inputProps: { maxLength: 120 } })}</Grid>
          <Grid item xs={12} sm={6}>{tf('code', 'Code', { helperText: 'Blank = made from the name', inputProps: { maxLength: 40 } })}</Grid>
          <Grid item xs={12} sm={4}>
            {tf('edition', 'Edition', {
              select: true, disabled: sold, helperText: sold ? 'Fixed once licences are sold' : ' ',
              children: (catalog.editions || []).map((e) => <MenuItem key={e.key} value={e.key}>{e.label}</MenuItem>),
            })}
          </Grid>
          <Grid item xs={6} sm={4}>
            {tf('billing_cycle', 'Billing', {
              select: true,
              children: (catalog.cycles || []).map((c) => <MenuItem key={c.key} value={c.key}>{c.label}</MenuItem>),
            })}
          </Grid>
          <Grid item xs={6} sm={4}>
            {tf('duration', form.billing_cycle === 'MONTHLY' ? 'Duration (months)' : 'Duration (years)', {
              type: 'number', disabled: lifetime, inputProps: { min: 1, max: 60 },
              helperText: lifetime ? 'No expiry' : 'Per period; renewals add the same',
            })}
          </Grid>
          <Grid item xs={6} sm={4}>{tf('price', 'Price', { type: 'number', inputProps: { min: 0, step: '0.01' } })}</Grid>
          <Grid item xs={6} sm={4}>
            {tf('currency', 'Currency', {
              select: (catalog.currencies || []).length > 0,
              children: (catalog.currencies || []).map((c) => <MenuItem key={c.code} value={c.code}>{c.code} · {c.name}</MenuItem>),
            })}
          </Grid>
          <Grid item xs={6} sm={4}>{tf('grace_days', 'Grace days after expiry', { type: 'number', inputProps: { min: 0, max: 90 } })}</Grid>
        </Grid>

        <Typography variant="subtitle2" fontWeight={700} sx={{ mt: 1, mb: 1 }}>Limits</Typography>
        <Grid container columnSpacing={2}>
          {LIMITS.filter(([key]) => !(form.edition === 'CLOUD' && key === 'clients')).map(([key, label, field]) => (
            <Grid item xs={6} sm={3} key={key}>
              <TextField fullWidth size="small" type="number" label={label} value={form.unlimited?.[key] ? '' : (form[field] ?? '')}
                disabled={saving || Boolean(form.unlimited?.[key])} onChange={(e) => set(field, e.target.value)}
                inputProps={{ min: key === 'clients' ? 0 : 1 }} error={Boolean(errors[field])}
                helperText={errors[field] || (key === 'clients' ? 'Extra clients on the installation' : ' ')} />
              <FormControlLabel sx={{ mt: -1 }} control={<Checkbox size="small" checked={Boolean(form.unlimited?.[key])}
                onChange={(e) => tick(key, e.target.checked)} />} label={<Typography variant="caption">Unlimited</Typography>} />
            </Grid>
          ))}
        </Grid>

        <Typography variant="subtitle2" fontWeight={700} sx={{ mt: 1 }}>Enabled modules</Typography>
        {errors.modules && <Alert severity="error" sx={{ my: 1 }}>{errors.modules}</Alert>}
        <FormGroup row>
          {(catalog.modules || []).map((m) => (
            <FormControlLabel key={m.key} sx={{ width: { xs: '100%', sm: '48%', md: '32%' } }}
              control={<Checkbox size="small" checked={(form.modules || []).includes(m.key)} onChange={() => toggle('modules', m.key)} />}
              label={<Typography variant="body2" title={m.description}>{m.label}</Typography>} />
          ))}
        </FormGroup>

        {(form.modules || []).includes('settings') && (
          <Box sx={{ mt: 1 }}>
            <Typography variant="subtitle2" fontWeight={700}>Feature permissions (Settings sections)</Typography>
            <FormControlLabel control={<Checkbox size="small" checked={form.all_features} onChange={(e) => set('all_features', e.target.checked)} />}
              label={<Typography variant="body2">Every section</Typography>} />
            {!form.all_features && (
              <FormGroup row>
                {(catalog.settings_features || []).map((f) => (
                  <FormControlLabel key={f.key} sx={{ width: { xs: '100%', sm: '48%' } }}
                    control={<Checkbox size="small" checked={(form.settings_features || []).includes(f.key)}
                      onChange={() => toggle('settings_features', f.key)} />}
                    label={<Typography variant="body2" title={f.description}>{f.label}</Typography>} />
                ))}
              </FormGroup>
            )}
            {errors.settings_features && <Alert severity="error">{errors.settings_features}</Alert>}
          </Box>
        )}
        <Box sx={{ mt: 1 }}>{tf('description', 'Description (internal)', { multiline: true, minRows: 2, inputProps: { maxLength: 2000 } })}</Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}>
          {editing ? 'Save plan' : 'Create plan'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
