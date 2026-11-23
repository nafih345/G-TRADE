// Windows Local Super Admin: this customer's own subscription terms on top of the chosen plan's
// defaults — edition, expiry date, users / companies / branches / branches per company, modules and
// Settings sections (feature permissions). The server validates and signs exactly these terms
// (vendor_licensing/service.apply_overrides); nothing here is trusted on its own.
import React from 'react';
import {
  Box, Checkbox, FormControlLabel, Grid, MenuItem, TextField, Typography,
} from '@mui/material';

export const TERM_LIMITS = [
  ['users', 'Named users', 1],
  ['companies', 'Companies', 1],
  ['branches', 'Branches (total)', 1],
  ['branches_per_company', 'Branches per company', 1],
  ['clients', 'Hosted clients on their PC', 0],
];

// Form state from a plan preview (issue) or a licence (renew).
export const termsFromSource = (src) => ({
  tier: src?.tier || 'STANDARD',
  expires_on: '',
  lifetime: Boolean(src?.lifetime),
  limits: Object.fromEntries(TERM_LIMITS.map(([k]) => [k, src?.limits?.[k] ?? null])),
  modules: [...(src?.modules || [])],
  settings_features: src?.settings_features ?? null,
});

// Request body `terms` (only what the server needs; null limit = unlimited).
export const termsBody = (t) => {
  if (!t) return undefined;
  const body = {
    tier: t.tier || '',
    limits: Object.fromEntries(TERM_LIMITS.map(([k]) => [k, t.limits[k] === null || t.limits[k] === '' ? null : Number(t.limits[k])])),
    modules: [...t.modules],
    settings_features: t.settings_features === null ? null : [...t.settings_features],
  };
  if (t.expires_on && !t.lifetime) body.expires_on = t.expires_on;
  return body;
};

export const termsErrors = (t) => {
  if (!t) return {};
  const out = {};
  TERM_LIMITS.forEach(([k, label, min]) => {
    const v = t.limits[k];
    if (v === null) return;
    if (v === '' || !Number.isInteger(Number(v)) || Number(v) < min) out[`limits.${k}`] = `${label}: ${min} or more, or tick Unlimited.`;
  });
  if (!t.modules.length) out.modules = 'Switch on at least one module.';
  if (t.modules.includes('accounts') && t.modules.includes('financial')) out.modules = 'Accounts (basic) or Financial (enterprise), not both.';
  return out;
};

export default function CustomerTermsFields({ catalog, value, onChange, errors = {}, disabled, showExpiry = true }) {
  if (!value) return null;
  const set = (patch) => onChange({ ...value, ...patch });
  const setLimit = (k, v) => set({ limits: { ...value.limits, [k]: v } });
  const toggle = (list, key) => (list.includes(key) ? list.filter((x) => x !== key) : [...list, key]);
  const features = catalog?.settings_features || [];
  return (
    <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1, p: 1.5, mt: 1.5 }} aria-label="Customer terms">
      <Typography variant="subtitle2" fontWeight={700} gutterBottom>This customer&apos;s terms</Typography>
      <Grid container columnSpacing={2}>
        <Grid item xs={12} sm={6}>
          <TextField select fullWidth size="small" label="Edition" value={value.tier} disabled={disabled}
            onChange={(e) => set({ tier: e.target.value })} helperText=" ">
            {(catalog?.tiers || ['STANDARD', 'PROFESSIONAL', 'ENTERPRISE']).map((t) => (
              <MenuItem key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</MenuItem>
            ))}
          </TextField>
        </Grid>
        {showExpiry && (
          <Grid item xs={12} sm={6}>
            <TextField fullWidth size="small" type="date" label="Expiry date (optional)" InputLabelProps={{ shrink: true }}
              value={value.expires_on} disabled={disabled || value.lifetime} onChange={(e) => set({ expires_on: e.target.value })}
              error={Boolean(errors.expires_on)}
              helperText={errors.expires_on || (value.lifetime ? 'Lifetime: never expires' : 'Blank = the plan period (last usable day)')} />
          </Grid>
        )}
        {TERM_LIMITS.map(([k, label, min]) => {
          const unlimited = value.limits[k] === null;
          return (
            <Grid item xs={12} sm={6} key={k} sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
              <TextField size="small" type="number" label={label} value={unlimited ? '' : value.limits[k]} sx={{ flex: 1 }}
                disabled={disabled || unlimited} inputProps={{ min, 'aria-label': label }}
                onChange={(e) => setLimit(k, e.target.value)}
                error={Boolean(errors[`limits.${k}`])} helperText={errors[`limits.${k}`] || ' '} />
              <FormControlLabel sx={{ mt: 0.5 }} label="Unlimited" control={(
                <Checkbox size="small" checked={unlimited} disabled={disabled}
                  onChange={(e) => setLimit(k, e.target.checked ? null : String(min || 1))} />
              )} />
            </Grid>
          );
        })}
      </Grid>
      <Typography variant="body2" fontWeight={600} sx={{ mt: 1 }}>Enabled modules</Typography>
      <Box>
        {(catalog?.modules || []).map((m) => (
          <FormControlLabel key={m.key} label={m.label} control={(
            <Checkbox size="small" checked={value.modules.includes(m.key)} disabled={disabled}
              onChange={() => set({ modules: toggle(value.modules, m.key) })} />
          )} />
        ))}
      </Box>
      {errors.modules && <Typography variant="caption" color="error">{errors.modules}</Typography>}
      {value.modules.includes('settings') && features.length > 0 && (
        <>
          <Typography variant="body2" fontWeight={600} sx={{ mt: 1 }}>Feature permissions (Settings sections)</Typography>
          <FormControlLabel label="All sections" control={(
            <Checkbox size="small" checked={value.settings_features === null} disabled={disabled}
              onChange={(e) => set({ settings_features: e.target.checked ? null : features.map((f) => f.key) })} />
          )} />
          {value.settings_features !== null && (
            <Box>
              {features.map((f) => (
                <FormControlLabel key={f.key} label={f.label} control={(
                  <Checkbox size="small" checked={value.settings_features.includes(f.key)} disabled={disabled}
                    onChange={() => set({ settings_features: toggle(value.settings_features, f.key) })} />
                )} />
              ))}
            </Box>
          )}
        </>
      )}
    </Box>
  );
}
