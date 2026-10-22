import React from 'react';
import { Box, ButtonBase, Switch, Typography } from '@mui/material';
import { ChevronRight as ChevronIcon } from '@mui/icons-material';
import { GREEN, GREEN_SOFT } from '../store/storeUi';

export { SectionCard, GREEN, GREEN_DARK, GREEN_SOFT, greenButtonSx, focusRing } from '../store/storeUi';

/** Soft square icon badge used by the toggle and quick-link rows. */
export function IconBadge({ children, size = 36 }) {
  return (
    <Box sx={{
      width: size, height: size, borderRadius: 2, bgcolor: GREEN_SOFT, color: GREEN,
      display: 'grid', placeItems: 'center', flexShrink: 0, '& svg': { fontSize: 20 },
    }}
    >
      {children}
    </Box>
  );
}

/** Icon · title + description · right-aligned switch. The whole row is the label. */
export function PrefToggleRow({ id, icon, title, description, checked, onChange, disabled, error, dirty }) {
  return (
    <Box
      component="label"
      htmlFor={id}
      sx={{
        display: 'flex', alignItems: 'center', gap: 1.5, py: 1.5, px: 0.5, cursor: disabled ? 'default' : 'pointer',
        borderBottom: '1px solid', borderColor: 'divider', '&:last-of-type': { borderBottom: 0 },
      }}
    >
      <IconBadge>{icon}</IconBadge>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" fontWeight={700} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
          {title}
          {dirty && <Box component="span" title="Unsaved change" sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: 'warning.main' }} />}
        </Typography>
        <Typography id={`${id}-desc`} variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.4 }}>{description}</Typography>
        {error && <Typography variant="caption" color="error" sx={{ display: 'block', mt: 0.25 }}>{error}</Typography>}
      </Box>
      <Switch
        id={id}
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        inputProps={{ 'aria-describedby': `${id}-desc` }}
        sx={{
          '& .MuiSwitch-switchBase.Mui-checked': { color: GREEN },
          '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: GREEN },
        }}
      />
    </Box>
  );
}

/** Clickable navigation row: icon · title + description · chevron. Keyboard-accessible. */
export function QuickLinkRow({ icon, title, description, onClick }) {
  return (
    <ButtonBase
      onClick={onClick}
      focusRipple
      sx={{
        width: '100%', display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5, borderRadius: 2, textAlign: 'left',
        border: '1px solid', borderColor: 'divider', transition: 'background-color .15s, border-color .15s',
        '&:hover, &.Mui-focusVisible': { bgcolor: GREEN_SOFT, borderColor: GREEN },
        '& + &': { mt: 1 },
      }}
    >
      <IconBadge>{icon}</IconBadge>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography variant="subtitle2" fontWeight={700}>{title}</Typography>
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', lineHeight: 1.4 }}>{description}</Typography>
      </Box>
      <ChevronIcon sx={{ color: 'text.secondary' }} />
    </ButtonBase>
  );
}

/** Centered empty state for lists. */
export function EmptyState({ icon, title, description, action }) {
  return (
    <Box sx={{ textAlign: 'center', py: 6, px: 2, border: '1px dashed', borderColor: 'divider', borderRadius: 3 }}>
      <Box sx={{ display: 'inline-flex', mb: 1.5 }}><IconBadge size={48}>{icon}</IconBadge></Box>
      <Typography variant="subtitle1" fontWeight={800}>{title}</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 460, mx: 'auto', mb: action ? 2 : 0 }}>{description}</Typography>
      {action}
    </Box>
  );
}

/** First error message out of a DRF-style {field: msg | [msg] | {sub: msg}} value. */
export const errText = (v) => {
  if (!v) return '';
  if (Array.isArray(v)) return v.join(' ');
  if (typeof v === 'object') return Object.entries(v).map(([k, m]) => `${k}: ${m}`).join(' ');
  return String(v);
};
