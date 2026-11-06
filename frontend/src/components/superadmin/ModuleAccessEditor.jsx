// Package picker + per-module ON/OFF switches for a client's subscription.
//
// The rules come from the server catalog (/api/superadmin/tenants/catalog/): a named package
// fixes the modules; flipping any switch moves to the package the result matches (usually
// Custom). Every module is independent; the only linked switches are the accounting tiers
// (catalog.exclusive — Accounts vs Financial): turning one on turns the other off, announced.
// The rules are utils/moduleAccess.toggleModule, mirroring what the server enforces on save.
//
// With the Settings module on, its sections (catalog.settings_features — the Settings page tabs)
// get their own switches; value.settings_features null means every section. Switching the last
// section off switches Settings itself off.
import React from 'react';
import {
  Box, Stack, Typography, Switch, Chip, Card, CardActionArea, Grid, Tooltip,
} from '@mui/material';
import { CheckCircle as CheckIcon } from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { dependencyNote, packageFor, toggleModule } from '../../utils/moduleAccess';

const SETTINGS = 'settings';

const GROUPS = [
  ['operations', 'Operations'],
  ['accounts', 'Accounts'],
  ['core', 'Core'],
];

export default function ModuleAccessEditor({ catalog, value, onChange, disabled = false, compact = false }) {
  const { package: pkg, modules } = value;
  const sections = catalog.settings_features || [];
  const allSections = sections.map((f) => f.key);
  const chosenSections = value.settings_features ?? allSections;
  // Settings back on with nothing picked: start from every section.
  const sectionsFor = (next) => (next.includes(SETTINGS) && !chosenSections.length ? null : value.settings_features ?? null);

  const pickPackage = (key) => {
    if (disabled) return;
    const p = catalog.packages.find((x) => x.key === key);
    const next = p.modules ? [...p.modules] : modules;
    onChange({ ...value, package: key, modules: next, settings_features: sectionsFor(next) });
  };

  const flip = (key, on) => {
    if (disabled) return;
    const extra = dependencyNote(catalog, modules, key, on);
    const next = toggleModule(catalog, modules, key, on);
    if (extra.length) {
      notify(`Also switched off: ${extra.join(', ')} — a client gets one accounting tier.`, 'info');
    }
    onChange({ ...value, package: packageFor(catalog, next), modules: next, settings_features: sectionsFor(next) });
  };

  const flipSection = (key, on) => {
    if (disabled) return;
    const picked = on ? [...chosenSections, key] : chosenSections.filter((k) => k !== key);
    if (!picked.length) {
      notify('No Settings section left on — the Settings module is switched off.', 'info');
      const next = toggleModule(catalog, modules, SETTINGS, false);
      onChange({ ...value, package: packageFor(catalog, next), modules: next, settings_features: [] });
      return;
    }
    const ordered = allSections.filter((k) => picked.includes(k));
    onChange({ ...value, settings_features: ordered.length === allSections.length ? null : ordered });
  };

  // The accounting tiers: one per client, so each says which one it replaces.
  const exclusiveText = (key) => {
    const group = (catalog.exclusive || []).find((g) => g.includes(key));
    if (!group) return '';
    const label = (k) => catalog.modules.find((m) => m.key === k)?.label || k;
    return `Either this or ${group.filter((k) => k !== key).map(label).join(', ')} — a client gets one accounting tier`;
  };

  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={700} gutterBottom>Package</Typography>
      <Grid container spacing={1.5} sx={{ mb: 2 }} role="radiogroup" aria-label="Subscription package">
        {catalog.packages.map((p) => {
          const selected = p.key === pkg;
          return (
            <Grid item xs={6} md={4} key={p.key}>
              <Card variant="outlined" sx={{
                height: '100%', borderColor: selected ? 'primary.main' : 'divider', borderWidth: selected ? 2 : 1,
                bgcolor: selected ? 'action.selected' : 'background.paper',
              }}>
                <CardActionArea role="radio" aria-checked={selected} disabled={disabled}
                  onClick={() => pickPackage(p.key)} sx={{ p: 1.5, height: '100%', alignItems: 'flex-start', display: 'flex', flexDirection: 'column' }}>
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    {selected && <CheckIcon color="primary" sx={{ fontSize: 18 }} />}
                    <Typography variant="body2" fontWeight={700}>{p.label}</Typography>
                  </Stack>
                  {!compact && <Typography variant="caption" color="text.secondary">{p.description}</Typography>}
                </CardActionArea>
              </Card>
            </Grid>
          );
        })}
      </Grid>

      <Typography variant="subtitle2" fontWeight={700} gutterBottom>
        Modules <Typography component="span" variant="caption" color="text.secondary">({modules.length} of {catalog.modules.length} on)</Typography>
      </Typography>
      <Stack spacing={1.5}>
        {GROUPS.map(([group, title]) => {
          const items = catalog.modules.filter((m) => m.group === group);
          if (!items.length) return null;
          return (
            <Box key={group}>
              <Typography variant="overline" color="text.secondary" sx={{ lineHeight: 2 }}>{title}</Typography>
              <Grid container spacing={1}>
                {items.map((m) => {
                  const on = modules.includes(m.key);
                  const hint = exclusiveText(m.key);
                  return (
                    <Grid item xs={12} sm={6} md={compact ? 6 : 4} key={m.key}>
                      <Stack direction="row" alignItems="center" spacing={1}
                        sx={{ border: 1, borderColor: on ? 'primary.light' : 'divider', borderRadius: 1.5, px: 1.5, py: 0.75, opacity: disabled ? 0.7 : 1 }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={600}>{m.label}</Typography>
                          {!compact && <Typography variant="caption" color="text.secondary" component="div">{m.description}</Typography>}
                          {hint && (
                            <Tooltip title={hint}>
                              <Chip size="small" variant="outlined" label="One accounting tier only"
                                sx={{ mt: 0.5, height: 20, fontSize: 11, maxWidth: '100%' }} />
                            </Tooltip>
                          )}
                        </Box>
                        <Switch checked={on} disabled={disabled} onChange={(e) => flip(m.key, e.target.checked)}
                          inputProps={{ 'aria-label': `${m.label} module` }} />
                      </Stack>
                    </Grid>
                  );
                })}
              </Grid>
              {items.some((m) => m.key === SETTINGS) && modules.includes(SETTINGS) && sections.length > 0 && (
                <Box sx={{ mt: 1, ml: { sm: 2 }, pl: 1.5, borderLeft: 2, borderColor: 'primary.light' }}
                  role="group" aria-label="Settings sections">
                  <Typography variant="caption" fontWeight={700} color="text.secondary" component="div" sx={{ mb: 0.5 }}>
                    Settings sections ({chosenSections.length} of {sections.length} on) — only these are visible to the client
                  </Typography>
                  <Grid container spacing={0.75}>
                    {sections.map((f) => {
                      const on = chosenSections.includes(f.key);
                      return (
                        <Grid item xs={12} sm={6} md={compact ? 6 : 3} key={f.key}>
                          <Stack direction="row" alignItems="center" spacing={0.5}
                            sx={{ border: 1, borderColor: on ? 'primary.light' : 'divider', borderRadius: 1.5, pl: 1.25, py: 0.25, opacity: disabled ? 0.7 : 1 }}>
                            <Tooltip title={f.description} placement="top">
                              <Typography variant="body2" sx={{ flex: 1, minWidth: 0, fontSize: 13 }} noWrap>{f.label}</Typography>
                            </Tooltip>
                            <Switch size="small" checked={on} disabled={disabled} onChange={(e) => flipSection(f.key, e.target.checked)}
                              inputProps={{ 'aria-label': `Settings: ${f.label}` }} />
                          </Stack>
                        </Grid>
                      );
                    })}
                  </Grid>
                </Box>
              )}
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
