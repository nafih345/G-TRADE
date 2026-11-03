// Package picker + per-module ON/OFF switches for a client's subscription.
//
// The rules come from the server catalog (/api/superadmin/tenants/catalog/): a named package
// fixes the modules; flipping any switch moves to the package the result matches (usually
// Custom). Dependencies follow utils/moduleAccess.toggleModule — the same rules the server
// applies when it saves — and every switch it drags along is announced.
import React from 'react';
import {
  Box, Stack, Typography, Switch, Chip, Card, CardActionArea, Grid, Tooltip,
} from '@mui/material';
import { CheckCircle as CheckIcon } from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { dependencyNote, packageFor, toggleModule } from '../../utils/moduleAccess';

const GROUPS = [
  ['operations', 'Operations'],
  ['accounts', 'Accounts'],
  ['core', 'Core'],
];

export default function ModuleAccessEditor({ catalog, value, onChange, disabled = false, compact = false }) {
  const { package: pkg, modules } = value;

  const pickPackage = (key) => {
    if (disabled) return;
    const p = catalog.packages.find((x) => x.key === key);
    onChange({ package: key, modules: p.modules ? [...p.modules] : modules });
  };

  const flip = (key, on) => {
    if (disabled) return;
    const extra = dependencyNote(catalog, modules, key, on);
    const next = toggleModule(catalog, modules, key, on);
    if (extra.length) {
      notify(`${on ? 'Also switched on' : 'Also switched off'}: ${extra.join(', ')}.`, 'info');
    }
    onChange({ package: packageFor(catalog, next), modules: next });
  };

  const requiresText = (key) => {
    const deps = catalog.requires?.[key];
    const suite = catalog.integrated?.[key];
    const label = (k) => catalog.modules.find((m) => m.key === k)?.label || k;
    if (deps?.length) return `Needs ${deps.map(label).join(', ')}`;
    if (suite?.length) return 'Standalone on its own; with any operations module it brings all of them';
    return '';
  };

  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={700} gutterBottom>Package</Typography>
      <Grid container spacing={1.5} sx={{ mb: 2 }} role="radiogroup" aria-label="Subscription package">
        {catalog.packages.map((p) => {
          const selected = p.key === pkg;
          return (
            <Grid item xs={6} md={3} key={p.key}>
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
                  const hint = requiresText(m.key);
                  return (
                    <Grid item xs={12} sm={6} md={compact ? 6 : 4} key={m.key}>
                      <Stack direction="row" alignItems="center" spacing={1}
                        sx={{ border: 1, borderColor: on ? 'primary.light' : 'divider', borderRadius: 1.5, px: 1.5, py: 0.75, opacity: disabled ? 0.7 : 1 }}>
                        <Box sx={{ flex: 1, minWidth: 0 }}>
                          <Typography variant="body2" fontWeight={600}>{m.label}</Typography>
                          {!compact && <Typography variant="caption" color="text.secondary" component="div">{m.description}</Typography>}
                          {hint && (
                            <Tooltip title={hint}>
                              <Chip size="small" variant="outlined" label={catalog.integrated?.[m.key] ? 'Integrated / standalone' : hint}
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
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}
