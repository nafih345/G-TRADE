import React from 'react';
import { Box, Card, Chip, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';

// Design tokens for the System Security & Backup centre.
export const GREEN = '#08A65A';
export const GREEN_DARK = '#078f4e';
export const INDIGO = '#5B55F5';
export const INDIGO_DARK = '#4a44e0';
export const RADIUS = '20px';

export const TONES = {
  success: { main: '#08A65A', text: '#05703d' },
  warning: { main: '#F59E0B', text: '#a15c00' },
  error: { main: '#E5484D', text: '#b4232a' },
  info: { main: '#5B55F5', text: '#4038c7' },
  neutral: { main: '#64748B', text: '#475569' },
};

export const greenButtonSx = {
  bgcolor: GREEN, background: GREEN, fontWeight: 700, boxShadow: 'none', textTransform: 'none', borderRadius: '12px',
  '&:hover': { bgcolor: GREEN_DARK, background: GREEN_DARK, boxShadow: 'none' },
};
export const indigoButtonSx = {
  bgcolor: INDIGO, background: INDIGO, fontWeight: 700, boxShadow: 'none', textTransform: 'none', borderRadius: '12px',
  '&:hover': { bgcolor: INDIGO_DARK, background: INDIGO_DARK, boxShadow: 'none' },
};
export const outlineButtonSx = { fontWeight: 700, textTransform: 'none', borderRadius: '12px' };

export const fieldSx = {
  '& .MuiOutlinedInput-root': { borderRadius: '12px' },
  '& .Mui-focused .MuiOutlinedInput-notchedOutline': { borderColor: GREEN, borderWidth: 2 },
  '& .MuiInputLabel-root.Mui-focused': { color: GREEN_DARK },
};

/** Rounded card with an icon tile, title, subtitle and optional header action. */
export function PanelCard({ id, icon, iconColor = GREEN, title, subtitle, action, children, sx }) {
  return (
    <Card
      component="section"
      id={id}
      aria-labelledby={id ? `${id}-title` : undefined}
      elevation={0}
      sx={{
        p: { xs: 2, sm: 3 }, borderRadius: RADIUS, border: '1px solid', borderColor: 'divider',
        bgcolor: 'background.paper', boxShadow: '0 1px 2px rgba(15, 23, 42, 0.04), 0 4px 16px rgba(15, 23, 42, 0.04)',
        height: '100%', display: 'flex', flexDirection: 'column', ...fieldSx, ...sx,
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1.5, mb: 2.5, flexWrap: 'wrap' }}>
        <Box sx={{
          width: 44, height: 44, borderRadius: '14px', display: 'grid', placeItems: 'center', flexShrink: 0,
          bgcolor: alpha(iconColor, 0.1), color: iconColor,
        }}
        >
          {icon}
        </Box>
        <Box sx={{ flex: 1, minWidth: 180 }}>
          <Typography id={id ? `${id}-title` : undefined} component="h2" sx={{ fontWeight: 800, fontSize: '1.08rem', lineHeight: 1.3 }}>
            {title}
          </Typography>
          {subtitle && <Typography variant="body2" color="text.secondary">{subtitle}</Typography>}
        </Box>
        {action}
      </Box>
      {children}
    </Card>
  );
}

/** One setting: icon, label, explanation, control on the right (stacks on phones). */
export function SettingRow({ icon, title, subtitle, control, children, error, divider = true, labelId }) {
  return (
    <Box sx={{ py: 2, borderBottom: divider ? '1px solid' : 'none', borderColor: 'divider' }}>
      <Box sx={{ display: 'flex', gap: 1.75, alignItems: { xs: 'flex-start', sm: 'center' }, flexDirection: { xs: 'column', sm: 'row' } }}>
        <Box sx={{ display: 'flex', gap: 1.75, flex: 1, minWidth: 0 }}>
          <Box sx={{
            width: 38, height: 38, borderRadius: '12px', display: 'grid', placeItems: 'center', flexShrink: 0,
            bgcolor: (t) => alpha(t.palette.mode === 'dark' ? '#fff' : INDIGO, t.palette.mode === 'dark' ? 0.06 : 0.07), color: INDIGO,
          }}
          >
            {icon}
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography id={labelId} sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{title}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ fontSize: '0.83rem' }}>{subtitle}</Typography>
          </Box>
        </Box>
        <Box sx={{ flexShrink: 0, pl: { xs: 6.5, sm: 0 } }}>{control}</Box>
      </Box>
      {children && <Box sx={{ pl: { xs: 0, sm: 6.75 }, mt: 1.5 }}>{children}</Box>}
      {error && <Typography role="alert" variant="caption" color="error" sx={{ display: 'block', pl: { xs: 0, sm: 6.75 }, mt: 0.75 }}>{error}</Typography>}
    </Box>
  );
}

/** Coloured pill used for health and statuses. */
export function SecurityStatusBadge({ tone = 'neutral', label, icon, size = 'medium' }) {
  const c = TONES[tone] || TONES.neutral;
  return (
    <Chip
      icon={icon}
      label={label}
      size={size === 'small' ? 'small' : 'medium'}
      sx={{
        fontWeight: 700, borderRadius: '999px', bgcolor: alpha(c.main, 0.12),
        color: (t) => (t.palette.mode === 'dark' ? c.main : c.text),
        '& .MuiChip-icon': { color: c.main },
        border: '1px solid', borderColor: alpha(c.main, 0.25),
      }}
    />
  );
}

/** "Label ………… value" line for the health card. */
export function StatLine({ icon, label, value, sub }) {
  return (
    <Stack direction="row" spacing={1.5} alignItems="flex-start" sx={{ py: 1.25 }}>
      <Box sx={{ color: 'text.secondary', mt: '2px', display: 'flex' }}>{icon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </Typography>
        <Box sx={{ fontWeight: 700, fontSize: '0.95rem', wordBreak: 'break-word' }}>{value}</Box>
        {sub && <Box sx={{ fontSize: '0.75rem', color: 'text.secondary', lineHeight: 1.6 }}>{sub}</Box>}
      </Box>
    </Stack>
  );
}
