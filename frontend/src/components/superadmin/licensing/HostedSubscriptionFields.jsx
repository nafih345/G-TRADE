// Hosted Workspaces subscription fields (Windows Local Super Admin): used by New client → step 5
// "Subscription" and by Manage → Subscription Plans → New subscription. Plan (Monthly / Quarterly /
// Half-Yearly / Yearly / Lifetime), start date, the expiry date the SERVER computes for that plan
// (preview/), the resulting status, and the customer's Installation ID (optional: bind it later).
// The Subscription ID is not entered here: the server creates it when the subscription is saved.
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Chip, Grid, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { fmtDate, todayIso } from '../clientApi';
import { LIC_API, LOCAL_SUBSCRIPTIONS } from './licenceApi';

export const SUBSCRIPTION_STATUS = {
  ACTIVE: { label: 'Active', color: 'success' },
  UPCOMING: { label: 'Upcoming', color: 'info' },
  RENEWAL_DUE: { label: 'Renewal due', color: 'warning' },
  EXPIRED: { label: 'Expired', color: 'error' },
  SUSPENDED: { label: 'Suspended', color: 'warning' },
  LIFETIME: { label: 'Lifetime', color: 'success' },
  REVOKED: { label: 'Revoked', color: 'default' },
  NONE: { label: 'No subscription', color: 'default' },
};

export const emptySubscription = () => ({ plan_id: '', starts_on: todayIso(), installation: '' });

// Status the new subscription will have on its start date (the server decides it again on save).
export const plannedStatus = (preview, startsOn) => {
  if (!preview) return null;
  if (startsOn && startsOn > todayIso()) return 'UPCOMING';
  return preview.lifetime ? 'LIFETIME' : 'ACTIVE';
};

export default function HostedSubscriptionFields({ licCatalog, value, onChange, errors = {}, disabled }) {
  const [preview, setPreview] = useState(null);
  const plans = (licCatalog?.plans || []).filter((p) => p.edition === 'WINDOWS_LOCAL');
  const presets = LOCAL_SUBSCRIPTIONS.map(([code, label]) => [plans.find((p) => p.code === code), label]).filter(([p]) => p);
  const set = (patch) => onChange({ ...value, ...patch });

  useEffect(() => {
    if (!value.plan_id) { setPreview(null); return undefined; }
    let live = true;
    axios.post(`${LIC_API}preview/`, { plan_id: value.plan_id, starts_on: value.starts_on || null })
      .then(({ data }) => { if (live) setPreview(data); })
      .catch(() => { if (live) setPreview(null); });
    return () => { live = false; };
  }, [value.plan_id, value.starts_on]);

  const status = plannedStatus(preview, value.starts_on);
  const st = SUBSCRIPTION_STATUS[status];
  return (
    <Box>
      {licCatalog?.signing && !licCatalog.signing.configured && (
        <Alert severity="warning" sx={{ mb: 2 }}>Subscriptions cannot be signed on this installation: {licCatalog.signing.message}</Alert>
      )}
      <Typography variant="body2" fontWeight={600} gutterBottom>Subscription Plan</Typography>
      <ToggleButtonGroup exclusive size="small" value={value.plan_id || ''} disabled={disabled} aria-label="Subscription plan"
        onChange={(_, id) => id && set({ plan_id: id })} sx={{ flexWrap: 'wrap', mb: 0.5 }}>
        {presets.map(([p, label]) => <ToggleButton key={p.id} value={p.id}>{label}</ToggleButton>)}
      </ToggleButtonGroup>
      <Typography variant="caption" display="block" color={errors.licence_plan_id || errors.plan_id ? 'error' : 'text.secondary'} sx={{ mb: 1.5 }}>
        {errors.licence_plan_id || errors.plan_id
          || 'Monthly = 1 calendar month · Quarterly = 3 · Half-Yearly = 6 · Yearly = 12 · Lifetime = never expires'}
      </Typography>
      <Grid container columnSpacing={2}>
        <Grid item xs={12} sm={4}>
          <TextField fullWidth size="small" type="date" label="Subscription Start Date" InputLabelProps={{ shrink: true }}
            value={value.starts_on || ''} disabled={disabled} onChange={(e) => set({ starts_on: e.target.value })}
            error={Boolean(errors.licence_starts_on || errors.starts_on)}
            helperText={errors.licence_starts_on || errors.starts_on || ' '} />
        </Grid>
        <Grid item xs={6} sm={4}>
          <TextField fullWidth size="small" label="Expiry Date" InputLabelProps={{ shrink: true }} disabled
            value={!preview ? '' : (preview.lifetime ? 'Never (Lifetime)' : fmtDate(preview.expires_on))}
            helperText="Set by the plan (last usable day)" />
        </Grid>
        <Grid item xs={6} sm={4}>
          <Stack sx={{ pt: 0.5 }}>
            <Typography variant="caption" color="text.secondary">Subscription Status</Typography>
            <Box>{st ? <Chip size="small" label={st.label} color={st.color} /> : <Typography variant="body2">—</Typography>}</Box>
          </Stack>
        </Grid>
        <Grid item xs={12}>
          <TextField fullWidth size="small" multiline maxRows={3} disabled={disabled}
            label="Customer Installation ID (optional)" value={value.installation || ''}
            onChange={(e) => set({ installation: e.target.value })}
            error={Boolean(errors.installation)} inputProps={{ spellCheck: false, 'aria-label': 'Customer Installation ID' }}
            helperText={errors.installation || 'Paste the Installation ID (or installation request code) from the customer\'s G-TRADE '
              + 'Licence Details page. This is NOT the Subscription ID. Not available yet? Leave it blank: the client and subscription '
              + 'are saved, and you bind the installation later in Manage → Subscription Plans.'} />
        </Grid>
      </Grid>
    </Box>
  );
}
