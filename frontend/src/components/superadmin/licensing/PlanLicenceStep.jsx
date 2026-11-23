// "Plan & Licence" step shared by Create Client (Cloud and Windows Local) and New licence:
// billing (Monthly / Yearly / Lifetime) → plan → start date → (Windows) installation binding →
// review of the expiry date and limits, computed by the server (preview/), never in the browser.
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Chip, Grid, MenuItem, Stack, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { fmtDate } from '../clientApi';
import { CYCLE_LABEL, LIC_API, LIMITS, LOCAL_SUBSCRIPTIONS, durationText, limitText, priceText } from './licenceApi';
import CustomerTermsFields, { termsFromSource } from './CustomerTermsFields';

export default function PlanLicenceStep({ catalog, edition, value, onChange, errors = {}, disabled, allowCustom }) {
  const plans = useMemo(() => (catalog?.plans || []).filter((p) => p.edition === edition), [catalog, edition]);
  const cycles = useMemo(() => ['MONTHLY', 'YEARLY', 'LIFETIME'].filter((c) => plans.some((p) => p.billing_cycle === c)), [plans]);
  const cycle = value.cycle || cycles[0] || 'YEARLY';
  const shown = plans.filter((p) => p.billing_cycle === cycle);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const moduleLabel = (k) => catalog?.modules?.find((m) => m.key === k)?.label || k;

  useEffect(() => {
    if (!value.plan_id || value.plan_id === 'CUSTOM') { setPreview(null); return undefined; }
    let live = true;
    axios.post(`${LIC_API}preview/`, { plan_id: value.plan_id, starts_on: value.starts_on || null })
      .then(({ data }) => {
        if (!live) return;
        setPreview(data); setPreviewError('');
        // Windows Local Super Admin: the customer's own terms start from the plan's defaults.
        if (catalog?.local && edition === 'WINDOWS_LOCAL' && value.custom_plan !== value.plan_id) {
          onChange({ ...value, custom: termsFromSource(data), custom_plan: value.plan_id });
        }
      })
      .catch(() => { if (live) { setPreview(null); setPreviewError('Could not compute the licence terms.'); } });
    return () => { live = false; };
  }, [value.plan_id, value.starts_on]);

  const set = (patch) => onChange({ ...value, ...patch });
  const signing = catalog?.signing;
  // Windows Local Super Admin: Monthly / Quarterly / Half-Yearly / Yearly / Lifetime as one choice.
  const localPresets = catalog?.local && edition === 'WINDOWS_LOCAL'
    ? LOCAL_SUBSCRIPTIONS.map(([code, label]) => [plans.find((p) => p.code === code), label]).filter(([p]) => p) : [];
  const otherLocal = localPresets.length ? plans.filter((p) => !LOCAL_SUBSCRIPTIONS.some(([c]) => c === p.code)) : [];

  return (
    <Box>
      {signing && !signing.configured && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          Licence signing is not configured on this server, so keys cannot be generated yet. {signing.message}
        </Alert>
      )}
      {signing?.development && (
        <Alert severity="info" sx={{ mb: 2 }}>Development signing key ({signing.key_id}): keys made here are for testing only.</Alert>
      )}
      {!plans.length && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          No active {edition === 'CLOUD' ? 'Cloud' : 'Windows Local'} plan exists yet. Create one in
          {' '}<a href="#/superadmin/licences?tab=plans">Licences &amp; Plans → Plans</a>.
        </Alert>
      )}
      {localPresets.length > 0 && (
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2 }}>
          <Typography variant="body2" fontWeight={600}>Subscription</Typography>
          <ToggleButtonGroup exclusive size="small" value={value.plan_id || ''} disabled={disabled} aria-label="Subscription"
            onChange={(_, id) => {
              if (!id) return;
              const p = plans.find((x) => x.id === id);
              set({ plan_id: id, cycle: p?.billing_cycle || value.cycle });
            }}>
            {localPresets.map(([p, label]) => <ToggleButton key={p.id} value={p.id}>{label}</ToggleButton>)}
          </ToggleButtonGroup>
        </Stack>
      )}
      {(errors.plan_id || errors.licence_plan_id) && localPresets.length > 0 && (
        <Typography variant="caption" color="error" display="block" sx={{ mt: -1, mb: 1 }}>{errors.plan_id || errors.licence_plan_id}</Typography>
      )}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ sm: 'center' }} sx={{ mb: 2, display: localPresets.length && !otherLocal.length ? 'none' : 'flex' }}>
        <Typography variant="body2" fontWeight={600}>{localPresets.length ? 'Other plans' : 'Billing'}</Typography>
        <ToggleButtonGroup exclusive size="small" value={cycle} disabled={disabled}
          onChange={(_, c) => c && set({ cycle: c, plan_id: '' })} aria-label="Billing">
          {['MONTHLY', 'YEARLY', 'LIFETIME'].map((c) => (
            <ToggleButton key={c} value={c} disabled={!cycles.includes(c)}>{CYCLE_LABEL[c]}</ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Stack>
      <Grid container columnSpacing={2}>
        <Grid item xs={12} sm={7} sx={{ display: localPresets.length && !otherLocal.length ? 'none' : 'block' }}>
          <TextField select fullWidth size="small" label="Subscription plan" value={value.plan_id || ''} disabled={disabled}
            onChange={(e) => set({ plan_id: e.target.value })} error={Boolean(errors.plan_id || errors.licence_plan_id)}
            helperText={errors.plan_id || errors.licence_plan_id || ' '}>
            {allowCustom && <MenuItem value="CUSTOM"><em>Custom terms — no licence key (legacy)</em></MenuItem>}
            {shown.map((p) => (
              <MenuItem key={p.id} value={p.id}>{p.name} · {durationText(p.billing_cycle, p.duration)} · {priceText(p.price, p.currency)}</MenuItem>
            ))}
          </TextField>
        </Grid>
        <Grid item xs={12} sm={5}>
          <TextField fullWidth size="small" type="date" label="Licence start date" InputLabelProps={{ shrink: true }}
            value={value.starts_on || ''} disabled={disabled} onChange={(e) => set({ starts_on: e.target.value })}
            error={Boolean(errors.starts_on || errors.licence_starts_on)} helperText={errors.starts_on || errors.licence_starts_on || ' '} />
        </Grid>
        {edition === 'WINDOWS_LOCAL' && (
          <Grid item xs={12}>
            <TextField fullWidth size="small" label="Installation ID or installation request code (optional)"
              value={value.installation || ''} disabled={disabled} onChange={(e) => set({ installation: e.target.value })}
              error={Boolean(errors.installation)} multiline maxRows={3}
              helperText={errors.installation || (catalog?.local
                ? 'From the customer\'s Licence Details page. With it the key activates offline on that PC only. Not available '
                  + 'yet? Leave it blank: the subscription is saved now and the key is generated when you bind the Installation ID.'
                : 'From the customer\'s Licence page. With it the key works offline on that PC only; '
                  + 'blank = the key is bound to the first installation that activates it online.')} />
          </Grid>
        )}
      </Grid>

      {value.plan_id === 'CUSTOM' && (
        <Alert severity="info">No licence key: set the modules, seats and dates by hand on the next fields.</Alert>
      )}
      {previewError && <Alert severity="error">{previewError}</Alert>}
      {preview && (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, mt: 1 }} aria-label="Licence review">
          <Typography variant="subtitle2" fontWeight={700} gutterBottom>Review</Typography>
          <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.5, m: 0, fontSize: 14 }}>
            <dt>Plan</dt><dd style={{ margin: 0 }}>{preview.plan?.name} · {durationText(preview.billing_cycle, preview.duration)}</dd>
            <dt>Price</dt><dd style={{ margin: 0 }}>{priceText(preview.price, preview.currency)}</dd>
            <dt>Starts</dt><dd style={{ margin: 0 }}>{fmtDate(preview.starts_on)}</dd>
            <dt>Expires</dt>
            <dd style={{ margin: 0 }}><b>{preview.lifetime ? 'Never (lifetime licence)'
              : `${fmtDate(value.custom?.expires_on || preview.expires_on)} (last usable day)`}</b></dd>
            {!value.custom && LIMITS.filter(([key]) => !(edition === 'CLOUD' && key === 'clients')).map(([key, label]) => (
              <React.Fragment key={key}><dt>{label}</dt><dd style={{ margin: 0 }}>{limitText(preview.limits?.[key])}</dd></React.Fragment>
            ))}
            {!value.custom && <dt>Modules</dt>}
            {!value.custom && (
              <dd style={{ margin: 0 }}>
                {(preview.modules || []).map((m) => <Chip key={m} size="small" label={moduleLabel(m)} sx={{ mr: 0.5, mb: 0.5 }} />)}
              </dd>
            )}
          </Box>
        </Box>
      )}
      {preview && value.custom && (
        <CustomerTermsFields catalog={catalog} value={value.custom} disabled={disabled} errors={errors}
          onChange={(custom) => onChange({ ...value, custom })} />
      )}
    </Box>
  );
}
