// Backups of one client (…/tenants/<id>/backups/ and /backup-schedule/): an on-demand backup of
// everything or of chosen modules, automatic backups on a schedule with retention, and the
// history with download / delete. Archives hold only this client's rows; they are exports and
// cannot be restored over the shared database (see apps/security/backup/tenant_scope.py).
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Box, Stack, Typography, Button, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Chip, Paper,
  Alert, LinearProgress, Checkbox, FormControlLabel, FormGroup, RadioGroup, Radio, Switch, TextField, MenuItem,
  Grid, IconButton, Tooltip, CircularProgress,
} from '@mui/material';
import {
  Backup as BackupIcon, Download as DownloadIcon, DeleteOutline as DeleteIcon, Save as SaveIcon,
} from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { apiErrorMessage } from '../../utils/apiError';
import { formatBytes, WEEKDAYS } from '../../utils/securityFormat';
import { API, fmtDateTime, isReauth } from './clientApi';

const STATUS_COLOR = { SUCCESS: 'success', FAILED: 'error', RUNNING: 'info', QUEUED: 'info', DELETED: 'default' };

function ScopePicker({ sections, value, onChange, idPrefix }) {
  const full = !value.length;
  const toggle = (key) => onChange(value.includes(key) ? value.filter((k) => k !== key) : [...value, key]);
  return (
    <Box>
      <RadioGroup row value={full ? 'full' : 'sections'} aria-label="Backup scope"
        onChange={(e) => onChange(e.target.value === 'full' ? [] : [sections[0].key])}>
        <FormControlLabel value="full" control={<Radio size="small" />} label="Entire client database" />
        <FormControlLabel value="sections" control={<Radio size="small" />} label="Selected modules" />
      </RadioGroup>
      {!full && (
        <FormGroup sx={{ pl: 1 }}>
          {sections.map((s) => (
            <FormControlLabel key={s.key} sx={{ alignItems: 'flex-start', mb: 0.5 }}
              control={<Checkbox size="small" id={`${idPrefix}-${s.key}`} checked={value.includes(s.key)} onChange={() => toggle(s.key)} sx={{ pt: 0.25 }} />}
              label={(
                <Box>
                  <Typography variant="body2" fontWeight={600}>{s.label}</Typography>
                  <Typography variant="caption" color="text.secondary">{s.description}</Typography>
                </Box>
              )} />
          ))}
        </FormGroup>
      )}
    </Box>
  );
}

function CreateBackup({ tenant, sections, running, onStarted }) {
  const [scope, setScope] = useState([]);
  const [busy, setBusy] = useState(false);
  const start = async () => {
    setBusy(true);
    try {
      const { data } = await axios.post(`${API}${tenant.id}/backups/`, { sections: scope });
      notify(data.status === 'SUCCESS' ? `Backup ${data.backup_identifier} completed.` : `Backup ${data.backup_identifier} started.`, 'success');
      onStarted();
    } catch (err) {
      if (!isReauth(err)) notify(apiErrorMessage(err, 'The backup could not be started.'), 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Typography variant="subtitle1" fontWeight={700} gutterBottom>Back up now</Typography>
      <ScopePicker sections={sections} value={scope} onChange={setScope} idPrefix="now" />
      <Button variant="contained" sx={{ mt: 1.5 }} startIcon={busy || running ? <CircularProgress size={16} color="inherit" /> : <BackupIcon />}
        disabled={busy || running} onClick={start}>
        {running ? 'Backup running…' : 'Create backup'}
      </Button>
    </Paper>
  );
}

function ScheduleCard({ tenant, sections, schedule, presets, onSaved }) {
  const [form, setForm] = useState(schedule);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { setForm(schedule); }, [schedule]);
  const set = (key, value) => { setForm((f) => ({ ...f, [key]: value })); setErrors((e) => ({ ...e, [key]: undefined })); };

  const save = async () => {
    setSaving(true);
    try {
      const body = ['enabled', 'frequency', 'backup_time', 'weekday', 'day_of_month', 'retention_count', 'sections']
        .reduce((acc, k) => ({ ...acc, [k]: form[k] }), {});
      const { data } = await axios.put(`${API}${tenant.id}/backup-schedule/`, body);
      notify(data.enabled ? 'Automatic backups saved.' : 'Automatic backups turned off.', 'success');
      onSaved(data);
    } catch (err) {
      if (isReauth(err)) return;
      setErrors(err?.response?.data?.errors || {});
      notify(apiErrorMessage(err, 'The schedule could not be saved.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography variant="subtitle1" fontWeight={700} sx={{ flexGrow: 1 }}>Automatic backups</Typography>
        <FormControlLabel control={<Switch checked={!!form.enabled} onChange={(e) => set('enabled', e.target.checked)} />}
          label={form.enabled ? 'On' : 'Off'} />
      </Stack>
      <Grid container spacing={1.5} sx={{ mt: 0.5 }}>
        <Grid item xs={6} sm={4}>
          <TextField select fullWidth size="small" label="Frequency" value={form.frequency} onChange={(e) => set('frequency', e.target.value)}>
            <MenuItem value="DAILY">Daily</MenuItem><MenuItem value="WEEKLY">Weekly</MenuItem><MenuItem value="MONTHLY">Monthly</MenuItem>
          </TextField>
        </Grid>
        <Grid item xs={6} sm={4}>
          <TextField fullWidth size="small" type="time" label="Time" value={form.backup_time} InputLabelProps={{ shrink: true }}
            onChange={(e) => set('backup_time', e.target.value)} error={!!errors.backup_time} helperText={errors.backup_time} />
        </Grid>
        {form.frequency === 'WEEKLY' && (
          <Grid item xs={6} sm={4}>
            <TextField select fullWidth size="small" label="Day" value={form.weekday} onChange={(e) => set('weekday', Number(e.target.value))}>
              {WEEKDAYS.map((d, i) => <MenuItem key={d} value={i}>{d}</MenuItem>)}
            </TextField>
          </Grid>
        )}
        {form.frequency === 'MONTHLY' && (
          <Grid item xs={6} sm={4}>
            <TextField select fullWidth size="small" label="Day of month" value={form.day_of_month} onChange={(e) => set('day_of_month', Number(e.target.value))}>
              {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
            </TextField>
          </Grid>
        )}
        <Grid item xs={6} sm={4}>
          <TextField select fullWidth size="small" label="Keep" value={form.retention_count}
            onChange={(e) => set('retention_count', Number(e.target.value))} error={!!errors.retention_count} helperText={errors.retention_count}>
            {[...new Set([...presets, form.retention_count])].sort((a, b) => a - b)
              .map((n) => <MenuItem key={n} value={n}>{`Newest ${n}`}</MenuItem>)}
          </TextField>
        </Grid>
      </Grid>
      <Box sx={{ mt: 1.5 }}>
        <ScopePicker sections={sections} value={form.sections || []} onChange={(v) => set('sections', v)} idPrefix="sched" />
        {errors.sections && <Typography variant="caption" color="error">{errors.sections}</Typography>}
      </Box>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
        Times are in the client’s time zone ({schedule.timezone}).
        {schedule.enabled && schedule.next_run_at ? ` Next run ${fmtDateTime(schedule.next_run_at)}.` : ''}
        {schedule.last_run_at ? ` Last run ${fmtDateTime(schedule.last_run_at)} — ${schedule.last_run_status.toLowerCase() || 'unknown'}.` : ''}
      </Typography>
      <Button variant="outlined" sx={{ mt: 1.5 }} startIcon={saving ? <CircularProgress size={16} /> : <SaveIcon />}
        disabled={saving} onClick={save}>
        Save schedule
      </Button>
    </Paper>
  );
}

export default function ClientBackupsPanel({ tenant }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [working, setWorking] = useState(null);
  const timer = useRef(null);

  const load = useCallback(() => axios.get(`${API}${tenant.id}/backups/`)
    .then(({ data: d }) => { setData(d); setError(''); return d; })
    .catch((err) => { setError(apiErrorMessage(err, 'Could not load the backups.')); return null; }), [tenant.id]);

  // While a backup runs, poll until it finishes.
  useEffect(() => {
    clearTimeout(timer.current);
    if (data?.running) timer.current = setTimeout(load, 2000);
    return () => clearTimeout(timer.current);
  }, [data, load]);
  useEffect(() => { load(); }, [load]);

  const download = async (b) => {
    setWorking(b.id);
    try {
      const { data: link } = await axios.post(`${API}${tenant.id}/backups/${b.id}/download-link/`);
      const base = (axios.defaults.baseURL || '').replace(/\/$/, '');
      const a = document.createElement('a');
      a.href = `${base}${link.url}`;
      a.download = link.filename || '';
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      a.remove();
    } catch (err) {
      if (!isReauth(err)) notify(apiErrorMessage(err, 'The download could not be started.'), 'error');
    } finally {
      setWorking(null);
    }
  };

  const remove = async (b) => {
    // eslint-disable-next-line no-alert
    if (!window.confirm(`Delete backup ${b.backup_identifier}? The file is removed from storage.`)) return;
    setWorking(b.id);
    try {
      await axios.delete(`${API}${tenant.id}/backups/${b.id}/`);
      notify('Backup deleted.', 'success');
      await load();
    } catch (err) {
      if (!isReauth(err)) notify(apiErrorMessage(err, 'The backup could not be deleted.'), 'error');
    } finally {
      setWorking(null);
    }
  };

  if (error && !data) return <Alert severity="error">{error}</Alert>;
  if (!data) return <LinearProgress />;

  const { storage } = data;
  return (
    <Stack spacing={2}>
      <Alert severity="info" variant="outlined">
        A client backup holds only {tenant.name}’s records — the whole client or the modules you pick — and is verified after
        it is written. It is an export for safekeeping or hand-over: it cannot be restored over the shared database.
      </Alert>
      {storage.warning && <Alert severity="warning">{storage.warning}</Alert>}
      <Grid container spacing={2}>
        <Grid item xs={12} md={5}>
          <CreateBackup tenant={tenant} sections={data.sections} running={data.running} onStarted={load} />
          <Typography variant="caption" color="text.secondary" component="div" sx={{ mt: 1 }}>
            This client’s backups: {formatBytes(storage.client_bytes)} · all backups {formatBytes(storage.used_bytes)} of {formatBytes(storage.capacity_bytes)} ({storage.location_label})
          </Typography>
        </Grid>
        <Grid item xs={12} md={7}>
          <ScheduleCard tenant={tenant} sections={data.sections} schedule={data.schedule} presets={data.retention_presets}
            onSaved={(schedule) => setData((d) => ({ ...d, schedule }))} />
        </Grid>
      </Grid>

      <Box>
        <Typography variant="subtitle1" fontWeight={700} gutterBottom>Backup history</Typography>
        {data.backups.length ? (
          <TableContainer component={Paper} variant="outlined">
            <Table size="small" aria-label="Client backup history">
              <TableHead>
                <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
                  <TableCell>Created</TableCell><TableCell>Scope</TableCell><TableCell>Type</TableCell><TableCell>Status</TableCell>
                  <TableCell align="right">Records</TableCell><TableCell align="right">Size</TableCell><TableCell>By</TableCell>
                  <TableCell align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {data.backups.map((b) => (
                  <TableRow key={b.id}>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {fmtDateTime(b.created_at)}
                      <Typography variant="caption" color="text.secondary" component="div" sx={{ fontFamily: 'monospace' }}>{b.backup_identifier}</Typography>
                    </TableCell>
                    <TableCell sx={{ maxWidth: 220 }}>{b.sections_label}</TableCell>
                    <TableCell>{b.backup_type_label}</TableCell>
                    <TableCell>
                      <Chip size="small" label={b.status_label} color={STATUS_COLOR[b.status] || 'default'}
                        icon={b.status === 'RUNNING' || b.status === 'QUEUED' ? <CircularProgress size={12} color="inherit" /> : undefined} />
                      {b.error_summary && <Typography variant="caption" color="error" component="div">{b.error_summary}</Typography>}
                    </TableCell>
                    <TableCell align="right">{b.total_rows == null ? '—' : Number(b.total_rows).toLocaleString()}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{b.file_size ? formatBytes(b.file_size) : '—'}</TableCell>
                    <TableCell sx={{ fontFamily: 'monospace' }}>{b.initiated_by || '—'}</TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                      <Tooltip title="Download">
                        <span>
                          <IconButton size="small" aria-label={`Download ${b.backup_identifier}`} disabled={b.status !== 'SUCCESS' || working === b.id}
                            onClick={() => download(b)}><DownloadIcon fontSize="small" /></IconButton>
                        </span>
                      </Tooltip>
                      <Tooltip title="Delete">
                        <span>
                          <IconButton size="small" aria-label={`Delete ${b.backup_identifier}`} disabled={!b.can_delete || working === b.id}
                            onClick={() => remove(b)}><DeleteIcon fontSize="small" /></IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        ) : <Typography color="text.secondary">No backups of this client yet.</Typography>}
      </Box>
    </Stack>
  );
}
