import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  Stack, TextField, Typography,
} from '@mui/material';
import { WarningAmberRounded as WarnIcon } from '@mui/icons-material';
import { backupApi, fieldErrors } from '../../../utils/securityApi';
import { formatBytes, formatInZone } from '../../../utils/securityFormat';
import { apiErrorMessage } from '../../../utils/apiError';
import { RADIUS, TONES } from './securityUi';

/**
 * The last gate before a restore: what will happen, the backup being restored, an explicit
 * acknowledgement, the word RESTORE and the operator's password (checked by the server).
 * onStarted(job) receives the queued RestoreJob.
 */
export default function RestoreConfirmationDialog({ backup, source, warnings, timezone, onClose, onStarted }) {
  const [ack, setAck] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => { setAck(false); setPhrase(''); setPassword(''); setErrors({}); setMessage(''); }, [backup]);
  if (!backup) return null;

  const ready = ack && phrase.trim() === 'RESTORE' && password.length > 0;
  const submit = async (e) => {
    e.preventDefault();
    if (!ready) return;
    setBusy(true); setErrors({}); setMessage('');
    try {
      const job = await backupApi.restore({ backup_id: backup.id, password, confirmation: 'RESTORE' });
      onStarted(job);
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      setMessage(fe.backup_id || (!Object.keys(fe).length ? apiErrorMessage(err, 'The restore could not be started.') : ''));
    } finally {
      setBusy(false);
    }
  };

  const takenAt = source?.created_at || backup.manifest?.created_at || backup.created_at;
  return (
    <Dialog open onClose={() => !busy && onClose()} maxWidth="sm" fullWidth
      PaperProps={{ component: 'form', onSubmit: submit, sx: { borderRadius: RADIUS } }} aria-labelledby="restore-title"
    >
      <DialogTitle id="restore-title" sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1 }}>
        <WarnIcon sx={{ color: TONES.error.main }} /> Restore database from backup?
      </DialogTitle>
      <DialogContent>
        <Box sx={{ p: 2, mb: 2, borderRadius: '14px', bgcolor: 'action.hover' }}>
          <Typography sx={{ fontWeight: 700 }}>{backup.backup_identifier}</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-all' }}>
            {backup.manifest?.original_filename || backup.filename}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Data as of <b>{formatInZone(takenAt, timezone)}</b> · {formatBytes(backup.file_size)}
            {(source?.total_rows ?? backup.manifest?.total_rows) != null && ` · ${(source?.total_rows ?? backup.manifest.total_rows).toLocaleString()} records`}
          </Typography>
        </Box>

        <Alert severity="error" sx={{ mb: 2, borderRadius: '12px' }}>
          <b>Every current record will be replaced</b> by the contents of this backup — sales, stock, patients, accounts,
          users and settings. Anything entered after {formatInZone(takenAt, timezone)} will no longer be in the system.
        </Alert>
        <Box component="ul" sx={{ m: 0, mb: 2, pl: 2.5, color: 'text.secondary', fontSize: '0.88rem', '& li': { mb: 0.5 } }}>
          <li>A verified safety backup of the current data is taken first — if it fails, nothing is restored.</li>
          <li>The restore runs as a single transaction: if anything goes wrong, no data is changed.</li>
          <li>Other users' changes are paused while it runs, and everyone is signed out when it finishes.</li>
          <li>Uploaded images (product photos, logos) are not part of database backups and are left as they are.</li>
        </Box>
        {warnings?.length > 0 && (
          <Alert severity="warning" sx={{ mb: 2, borderRadius: '12px' }}>{warnings.join(' ')}</Alert>
        )}
        {message && <Alert severity="error" sx={{ mb: 2, borderRadius: '12px' }}>{message}</Alert>}

        <Stack spacing={2}>
          <FormControlLabel
            control={<Checkbox checked={ack} onChange={(e) => setAck(e.target.checked)} color="error" />}
            label={<Typography variant="body2" sx={{ fontWeight: 600 }}>I understand that current data will be replaced.</Typography>}
          />
          <TextField label='Type "RESTORE" to confirm' value={phrase} onChange={(e) => setPhrase(e.target.value)}
            error={!!errors.confirmation} helperText={errors.confirmation} autoComplete="off" />
          <TextField label="Your password" type="password" value={password} onChange={(e) => setPassword(e.target.value)}
            error={!!errors.password} helperText={errors.password || 'Required for every restore'} autoComplete="current-password" />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} disabled={busy} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button type="submit" variant="contained" color="error" disabled={!ready || busy}
          sx={{ fontWeight: 700, textTransform: 'none', borderRadius: '12px', boxShadow: 'none' }}
        >
          {busy ? <CircularProgress size={18} sx={{ color: '#fff' }} /> : 'Restore database'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
