import React from 'react';
import { Alert, Box, Button, CircularProgress, LinearProgress, Skeleton, Stack, Typography } from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  HealthAndSafetyOutlined as HealthIcon, VerifiedUser as SafeIcon, ReportProblem as WarnIcon, Dangerous as FailIcon,
  CloudOff as NoneIcon, History as LastIcon, Event as NextIcon, Storage as StorageIcon, Backup as BackupIcon,
} from '@mui/icons-material';
import { PanelCard, SecurityStatusBadge, StatLine, TONES, greenButtonSx } from './securityUi';
import { formatBytes, formatInZone, healthTone, relativeTime, storageTone } from '../../../utils/securityFormat';

const BIG_ICON = { success: SafeIcon, warning: WarnIcon, error: FailIcon, neutral: NoneIcon };

/** Right card of the first row: real backup status from /api/backups/health/. */
export default function BackupHealthCard({ health, error, timezone, creating, onCreate, onRetry }) {
  if (error) {
    return (
      <PanelCard icon={<HealthIcon />} title="Backup Health">
        <Alert severity="error" sx={{ borderRadius: '12px' }} action={<Button color="inherit" size="small" onClick={onRetry}>Retry</Button>}>
          {error}
        </Alert>
      </PanelCard>
    );
  }
  if (!health) {
    return (
      <PanelCard icon={<HealthIcon />} title="Backup Health">
        <Skeleton variant="rounded" height={72} sx={{ mb: 2, borderRadius: '14px' }} />
        {[0, 1, 2].map((i) => <Skeleton key={i} height={52} />)}
      </PanelCard>
    );
  }

  const { tone, label } = healthTone(health.status);
  const c = TONES[tone];
  const Big = BIG_ICON[tone];
  const last = health.last_backup;
  const running = health.running_backup || health.running_restore;
  const sTone = storageTone(health.storage.percent);
  const busy = creating || !!running;

  return (
    <PanelCard
      id="backup-health"
      icon={<HealthIcon />}
      title="Backup Health"
      subtitle="Live status of your database protection"
      action={<SecurityStatusBadge tone={tone} label={label} size="small" />}
    >
      <Box sx={{
        display: 'flex', alignItems: 'center', gap: 2, p: 2, borderRadius: '16px', mb: 1,
        bgcolor: alpha(c.main, 0.08), border: '1px solid', borderColor: alpha(c.main, 0.2),
      }}
      >
        <Box sx={{ width: 52, height: 52, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: alpha(c.main, 0.15), color: c.main, flexShrink: 0 }}>
          <Big />
        </Box>
        <Box sx={{ minWidth: 0 }}>
          <Typography sx={{ fontWeight: 800, fontSize: '1.05rem' }}>{health.message}</Typography>
          <Typography variant="body2" color="text.secondary">
            {health.status === 'none'
              ? 'Create your first backup to protect your sales, stock, patients and accounts.'
              : `${health.total_backups} verified backup${health.total_backups === 1 ? '' : 's'} available`}
          </Typography>
        </Box>
      </Box>

      {health.warnings?.length > 0 && (
        <Box component="ul" sx={{ m: 0, mb: 1, pl: 2.5, color: TONES.warning.text, fontSize: '0.83rem' }}>
          {health.warnings.map((w) => <li key={w}>{w}</li>)}
        </Box>
      )}

      <StatLine
        icon={<LastIcon fontSize="small" />}
        label="Last backup"
        value={last ? (
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <span>{formatInZone(last.completed_at || last.created_at, timezone)}</span>
            <SecurityStatusBadge size="small" tone={last.status === 'SUCCESS' ? 'success' : 'error'}
              label={last.status === 'SUCCESS' ? 'Successful' : 'Failed'} />
          </Stack>
        ) : 'No backup available yet'}
        sub={last ? `${relativeTime(last.completed_at || last.created_at)} · ${last.backup_type_label}${last.status === 'SUCCESS' ? ` · ${formatBytes(last.file_size)}` : ''}` : null}
      />
      {health.last_successful && last && last.status !== 'SUCCESS' && (
        <Typography variant="caption" color="text.secondary" sx={{ pl: 4.5, mt: -1, display: 'block' }}>
          Last successful: {formatInZone(health.last_successful.completed_at, timezone)}
        </Typography>
      )}
      <StatLine
        icon={<NextIcon fontSize="small" />}
        label="Next scheduled backup"
        value={health.next_scheduled_at ? formatInZone(health.next_scheduled_at, timezone) : 'Automatic backups are off'}
        sub={health.next_scheduled_at ? relativeTime(health.next_scheduled_at) : 'Turn them on in Backup Schedule below'}
      />
      <StatLine
        icon={<StorageIcon fontSize="small" />}
        label="Storage used"
        value={`${formatBytes(health.storage.used_bytes)} of ${formatBytes(health.storage.capacity_bytes)}`}
        sub={(
          <Box component="span" sx={{ display: 'block', mt: 0.75 }}>
            <LinearProgress
              variant="determinate"
              value={Math.min(100, health.storage.percent)}
              aria-label={`Backup storage ${health.storage.percent}% used`}
              sx={{ height: 8, borderRadius: 4, bgcolor: 'action.hover', '& .MuiLinearProgress-bar': { bgcolor: TONES[sTone].main, borderRadius: 4 } }}
            />
            <Box component="span" sx={{ display: 'flex', justifyContent: 'space-between', mt: 0.5 }}>
              <span>{health.storage.percent}% used</span>
              <span>{health.storage.location_label}</span>
            </Box>
          </Box>
        )}
      />

      <Box sx={{ mt: 'auto', pt: 2 }}>
        <Button
          fullWidth
          variant="contained"
          size="large"
          startIcon={busy ? <CircularProgress size={18} sx={{ color: 'inherit' }} /> : <BackupIcon />}
          disabled={busy}
          onClick={onCreate}
          sx={{ ...greenButtonSx, py: 1.25 }}
        >
          {health.running_restore ? 'Restore in progress…' : busy ? 'Backup in progress…'
            : health.status === 'none' ? 'Create First Backup' : 'Create Backup Now'}
        </Button>
      </Box>
    </PanelCard>
  );
}
