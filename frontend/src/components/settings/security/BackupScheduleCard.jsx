import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Grid, MenuItem, Skeleton, Stack, Switch, TextField, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  EventRepeatOutlined as ScheduleIcon, CheckCircle as CheckIcon, Save as SaveIcon, Schedule as ClockIcon,
} from '@mui/icons-material';
import { PanelCard, SecurityStatusBadge, GREEN, INDIGO, TONES, indigoButtonSx } from './securityUi';
import { backupApi, fieldErrors } from '../../../utils/securityApi';
import {
  RETENTION_PRESETS, SCHEDULE_FIELDS, WEEKDAYS, changedKeys, formatInZone, pick, scheduleSummary, validateSchedule,
} from '../../../utils/securityFormat';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';

const switchSx = {
  '& .MuiSwitch-switchBase.Mui-checked': { color: GREEN },
  '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: GREEN, background: GREEN, opacity: 0.6 },
};

/** Full-width card: automatic backup schedule. Saved on its own with "Save Schedule". */
export default function BackupScheduleCard({ onSaved, onDirtyChange }) {
  const [server, setServer] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [result, setResult] = useState(null); // {tone, text}
  const [loadError, setLoadError] = useState('');
  const [conflict, setConflict] = useState(null);
  const [customRetention, setCustomRetention] = useState(false);

  const adopt = useCallback((data) => {
    setServer(data);
    setForm(pick(data, SCHEDULE_FIELDS));
    setCustomRetention(!RETENTION_PRESETS.includes(Number(data.retention_count)));
    setErrors({});
  }, []);

  const load = useCallback(() => {
    setLoadError('');
    backupApi.schedule().then(adopt).catch((e) => setLoadError(`Could not load the backup schedule. ${apiErrorMessage(e)}`));
  }, [adopt]);
  useEffect(() => { load(); }, [load]);

  const dirty = useMemo(() => changedKeys(form, server && pick(server, SCHEDULE_FIELDS), SCHEDULE_FIELDS), [form, server]);
  useEffect(() => { onDirtyChange?.(dirty.length > 0); }, [dirty.length, onDirtyChange]);

  const set = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => { const n = { ...e }; Object.keys(patch).forEach((k) => delete n[k]); return n; });
    setResult(null);
  };

  const save = async () => {
    const clientErrors = validateSchedule(form);
    if (Object.keys(clientErrors).length) { setErrors(clientErrors); setResult({ tone: 'error', text: 'Please fix the highlighted fields.' }); return; }
    setSaving(true);
    setResult(null);
    setConflict(null);
    try {
      const body = { ...form, weekday: Number(form.weekday), day_of_month: Number(form.day_of_month),
        retention_count: Number(form.retention_count), version: server.version };
      const data = await backupApi.saveSchedule(body);
      adopt(data);
      setResult({ tone: 'success', text: 'Schedule saved.' });
      notify(data.enabled ? `Automatic backups scheduled — next run ${formatInZone(data.next_run_at, data.timezone)}.` : 'Automatic backups turned off.', 'success');
      onSaved?.(data);
    } catch (err) {
      if (err?.response?.status === 409) {
        setConflict(err.response.data.current);
        setResult({ tone: 'error', text: err.response.data.detail });
      } else {
        setErrors(fieldErrors(err));
        setResult({ tone: 'error', text: `Schedule not saved. ${apiErrorMessage(err)}` });
      }
    } finally {
      setSaving(false);
    }
  };

  if (loadError) {
    return (
      <PanelCard icon={<ScheduleIcon />} iconColor={INDIGO} title="Backup Schedule">
        <Alert severity="error" action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{loadError}</Alert>
      </PanelCard>
    );
  }
  if (!form) {
    return (
      <PanelCard icon={<ScheduleIcon />} iconColor={INDIGO} title="Backup Schedule">
        <Skeleton height={56} /><Skeleton height={56} />
      </PanelCard>
    );
  }

  const retentionSelect = customRetention ? 'custom' : Number(form.retention_count);

  return (
    <PanelCard
      id="backup-schedule"
      icon={<ScheduleIcon />}
      iconColor={INDIGO}
      title="Backup Schedule"
      subtitle={`Automatic backups run on the server in the business time zone (${server.timezone}). Saved separately from the page settings.`}
      action={<SecurityStatusBadge tone={server.enabled ? 'success' : 'neutral'} label={server.enabled ? 'Schedule active' : 'Schedule off'} size="small" />}
    >
      <Box sx={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, p: 2, mb: 2.5, borderRadius: '16px',
        border: '1px solid', borderColor: form.enabled ? alpha(GREEN, 0.35) : 'divider', bgcolor: form.enabled ? alpha(GREEN, 0.06) : 'transparent',
        flexWrap: 'wrap',
      }}
      >
        <Box>
          <Typography id="sched-enabled-label" sx={{ fontWeight: 700 }}>Enable Automatic Backups</Typography>
          <Typography variant="body2" color="text.secondary">
            {form.enabled ? scheduleSummary(form) : 'No backups are taken automatically. You can still back up manually at any time.'}
          </Typography>
        </Box>
        <Switch checked={!!form.enabled} onChange={(e) => set({ enabled: e.target.checked })} sx={switchSx}
          inputProps={{ 'aria-labelledby': 'sched-enabled-label' }} />
      </Box>

      <Grid container spacing={2}>
        <Grid item xs={12} sm={6} md={3}>
          <TextField select fullWidth label="Backup Frequency" value={form.frequency} disabled={!form.enabled}
            onChange={(e) => set({ frequency: e.target.value })} error={!!errors.frequency} helperText={errors.frequency || ' '}
          >
            <MenuItem value="DAILY">Daily</MenuItem>
            <MenuItem value="WEEKLY">Weekly</MenuItem>
            <MenuItem value="MONTHLY">Monthly</MenuItem>
          </TextField>
        </Grid>
        {form.frequency === 'WEEKLY' && (
          <Grid item xs={12} sm={6} md={3}>
            <TextField select fullWidth label="Day of Week" value={Number(form.weekday)} disabled={!form.enabled}
              onChange={(e) => set({ weekday: Number(e.target.value) })} error={!!errors.weekday} helperText={errors.weekday || ' '}
            >
              {WEEKDAYS.map((d, i) => <MenuItem key={d} value={i}>{d}</MenuItem>)}
            </TextField>
          </Grid>
        )}
        {form.frequency === 'MONTHLY' && (
          <Grid item xs={12} sm={6} md={3}>
            <TextField select fullWidth label="Day of Month" value={Number(form.day_of_month)} disabled={!form.enabled}
              onChange={(e) => set({ day_of_month: Number(e.target.value) })} error={!!errors.day_of_month}
              helperText={errors.day_of_month || 'Days 1–28 exist in every month'}
            >
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
            </TextField>
          </Grid>
        )}
        <Grid item xs={12} sm={6} md={3}>
          <TextField fullWidth type="time" label="Backup Time" value={form.backup_time} disabled={!form.enabled}
            onChange={(e) => set({ backup_time: e.target.value })} InputLabelProps={{ shrink: true }}
            inputProps={{ step: 60 }} error={!!errors.backup_time} helperText={errors.backup_time || 'A quiet time, e.g. after closing'} />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField select fullWidth label="Retention Policy" value={retentionSelect}
            onChange={(e) => {
              if (e.target.value === 'custom') { setCustomRetention(true); return; }
              setCustomRetention(false);
              set({ retention_count: Number(e.target.value) });
            }}
            error={!!errors.retention_count && !customRetention}
            helperText={(!customRetention && errors.retention_count) || 'Older automatic backups are removed'}
          >
            {RETENTION_PRESETS.map((n) => <MenuItem key={n} value={n}>Keep the last {n} backups</MenuItem>)}
            <MenuItem value="custom">Custom…</MenuItem>
          </TextField>
        </Grid>
        {customRetention && (
          <Grid item xs={12} sm={6} md={3}>
            <TextField fullWidth type="number" label="Backups to keep" value={form.retention_count}
              onChange={(e) => set({ retention_count: e.target.value })} inputProps={{ min: 1, max: 365 }}
              error={!!errors.retention_count} helperText={errors.retention_count || '1 – 365'} />
          </Grid>
        )}
      </Grid>

      {conflict && (
        <Alert severity="warning" sx={{ mt: 1, borderRadius: '12px' }}
          action={<Button color="inherit" size="small" onClick={() => { adopt(conflict); setConflict(null); setResult(null); }}>Load latest</Button>}
        >
          Someone else changed the schedule. Load their version, then re-apply your changes.
        </Alert>
      )}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems={{ xs: 'stretch', sm: 'center' }} justifyContent="space-between" sx={{ mt: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ color: 'text.secondary', minWidth: 0 }}>
          <ClockIcon fontSize="small" />
          <Typography variant="body2" sx={{ fontWeight: 600 }}>
            {dirty.length ? 'Save the schedule to calculate the next run.'
              : server.enabled ? `Next backup: ${formatInZone(server.next_run_at, server.timezone)}`
                : 'Automatic backups are off.'}
            {server.last_run_at && !dirty.length && (
              <Box component="span" sx={{ fontWeight: 400 }}> · Last run {formatInZone(server.last_run_at, server.timezone)}
                {server.last_run_status ? ` (${server.last_run_status.toLowerCase()})` : ''}
              </Box>
            )}
          </Typography>
        </Stack>
        <Stack direction="row" spacing={1.5} alignItems="center" justifyContent="flex-end">
          {result && (
            <Typography role="status" variant="body2" sx={{ color: TONES[result.tone].main, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 0.5 }}>
              {result.tone === 'success' && <CheckIcon fontSize="small" />}{result.text}
            </Typography>
          )}
          {dirty.length > 0 && <Button onClick={() => adopt(server)} disabled={saving} sx={{ textTransform: 'none' }}>Discard</Button>}
          <Button variant="contained" onClick={save} disabled={saving || !dirty.length}
            startIcon={saving ? <CircularProgress size={16} sx={{ color: 'inherit' }} /> : <SaveIcon />} sx={{ ...indigoButtonSx, px: 3 }}
          >
            {saving ? 'Saving…' : 'Save Schedule'}
          </Button>
        </Stack>
      </Stack>
    </PanelCard>
  );
}
