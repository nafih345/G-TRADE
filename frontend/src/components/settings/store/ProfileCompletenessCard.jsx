import React from 'react';
import {
  Box, Card, CircularProgress, List, ListItemButton, ListItemIcon, ListItemText, Skeleton, Typography,
} from '@mui/material';
import { CheckCircle as DoneIcon, RadioButtonUnchecked as TodoIcon, ChevronRight as GoIcon } from '@mui/icons-material';
import { GREEN } from './storeUi';

/** Completion from SAVED data (the server computes it); clicking an incomplete row jumps to it. */
export default function ProfileCompletenessCard({ completeness, dirty, onOpen }) {
  const sections = completeness?.sections || [];
  const percent = completeness?.percent ?? 0;
  const doneCount = sections.filter((s) => s.complete).length;

  return (
    <Card elevation={0} sx={{ p: { xs: 2, sm: 3 }, borderRadius: 3, border: '1px solid', borderColor: 'divider', boxShadow: '0 1px 3px rgba(15,23,42,0.05)' }}>
      <Typography variant="h6" component="h2" fontWeight={800} sx={{ fontSize: '1.05rem', mb: 2 }}>Profile Completeness</Typography>

      {!completeness ? (
        <Skeleton variant="rounded" height={160} />
      ) : (
        <>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mb: 1.5 }}>
            <Box sx={{ position: 'relative', width: 84, height: 84, flexShrink: 0 }} role="img" aria-label={`Profile ${percent}% complete`}>
              <CircularProgress variant="determinate" value={100} size={84} thickness={4.5} sx={{ color: 'action.hover', position: 'absolute' }} />
              <CircularProgress
                variant="determinate"
                value={percent}
                size={84}
                thickness={4.5}
                sx={{ color: GREEN, position: 'absolute', '& .MuiCircularProgress-circle': { strokeLinecap: 'round' } }}
              />
              <Box sx={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
                <Typography variant="h6" fontWeight={800}>{percent}%</Typography>
              </Box>
            </Box>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="subtitle2" fontWeight={800}>
                {percent === 100 ? 'Your profile is complete' : `${doneCount} of ${sections.length} sections complete`}
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {percent === 100
                  ? 'Invoices, receipts and reports carry your full store details.'
                  : 'Complete the remaining items so every document shows full store details.'}
              </Typography>
              {dirty && (
                <Typography variant="caption" color="warning.main" sx={{ display: 'block', mt: 0.5, fontWeight: 600 }}>
                  Based on saved data — save to update.
                </Typography>
              )}
            </Box>
          </Box>

          <List dense disablePadding aria-label="Profile checklist">
            {sections.map((s) => (
              <ListItemButton
                key={s.key}
                onClick={() => onOpen(s)}
                disabled={s.complete}
                sx={{ borderRadius: 2, px: 1, '&.Mui-disabled': { opacity: 1 } }}
                aria-label={s.complete ? `${s.label}: complete` : `${s.label}: incomplete, missing ${s.missing.join(', ')}. Go to section`}
              >
                <ListItemIcon sx={{ minWidth: 34 }}>
                  {s.complete ? <DoneIcon sx={{ color: GREEN }} /> : <TodoIcon sx={{ color: 'text.disabled' }} />}
                </ListItemIcon>
                <ListItemText
                  primary={s.label}
                  primaryTypographyProps={{ fontWeight: 700, fontSize: '0.875rem', color: s.complete ? 'text.primary' : 'text.secondary' }}
                  secondary={s.complete ? null : `Missing: ${s.missing.join(', ')}`}
                  secondaryTypographyProps={{ fontSize: '0.75rem' }}
                />
                {!s.complete && <GoIcon fontSize="small" sx={{ color: 'text.disabled' }} />}
              </ListItemButton>
            ))}
          </List>
        </>
      )}
    </Card>
  );
}
