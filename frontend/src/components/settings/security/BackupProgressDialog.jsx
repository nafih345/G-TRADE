import React, { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Step, StepLabel, Stepper,
  Typography,
} from '@mui/material';
import { CheckCircleRounded as DoneIcon, ErrorRounded as FailIcon } from '@mui/icons-material';
import { backupApi, poll } from '../../../utils/securityApi';
import { formatBytes, restoreStep } from '../../../utils/securityFormat';
import { apiErrorMessage } from '../../../utils/apiError';
import { useAuth } from '../../../context/AuthContext';
import { announceSessionEnded } from '../../../utils/sessionGuard';
import { GREEN, RADIUS, greenButtonSx, outlineButtonSx } from './securityUi';

const BACKUP_STEPS = ['Queued', 'Creating & verifying archive', 'Complete'];
const RESTORE_STEPS = ['Validating backup', 'Safety backup of current data', 'Restoring data', 'Finalizing', 'Complete'];

function backupStep(status) {
  if (status === 'SUCCESS' || status === 'FAILED') return 2;
  return status === 'RUNNING' ? 1 : 0;
}

/**
 * Follows a running backup (`job.kind === 'backup'`, polls the BackupRecord) or restore
 * (`'restore'`, polls the RestoreJob) until it finishes. Closing it does not stop the job.
 */
export default function BackupProgressDialog({ job, onClose, onFinished }) {
  const { logout } = useAuth();
  const [state, setState] = useState(null);
  const [pollError, setPollError] = useState('');
  const downloaded = useRef(false);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (!job) return undefined;
    setState(job.initial || null);
    setPollError('');
    downloaded.current = false;
    finishedRef.current = false;
    const fetcher = job.kind === 'restore' ? () => backupApi.restoreStatus(job.id) : () => backupApi.get(job.id);
    return poll(fetcher, (r) => ['SUCCESS', 'FAILED'].includes(r.status), {
      ms: 1500,
      onUpdate: (r) => {
        setState(r);
        setPollError('');
        if (['SUCCESS', 'FAILED'].includes(r.status) && !finishedRef.current) {
          finishedRef.current = true;
          onFinished?.(r);
          if (job.kind === 'backup' && job.autoDownload && r.status === 'SUCCESS' && !downloaded.current) {
            downloaded.current = true;
            backupApi.download(r.id).catch((e) => setPollError(`The backup was created but the download failed: ${apiErrorMessage(e)}`));
          }
        }
      },
      onError: (e) => setPollError(`Lost contact with the server — still checking… (${apiErrorMessage(e)})`),
    });
  }, [job, onFinished]);

  if (!job) return null;
  const isRestore = job.kind === 'restore';
  const status = state?.status || 'QUEUED';
  const finished = status === 'SUCCESS' || status === 'FAILED';
  const steps = isRestore ? RESTORE_STEPS : BACKUP_STEPS;
  const active = isRestore ? (status === 'SUCCESS' ? 4 : restoreStep(state?.stage)) : backupStep(status);

  const signInAgain = () => {
    logout();
    announceSessionEnded('The database was restored. Please sign in again.');
  };

  return (
    <Dialog open onClose={(_, reason) => { if (!(isRestore && !finished && reason)) onClose(); }} maxWidth="sm" fullWidth
      PaperProps={{ sx: { borderRadius: RADIUS } }} aria-labelledby="backup-progress-title"
    >
      <DialogTitle id="backup-progress-title" sx={{ fontWeight: 800 }}>
        {isRestore ? 'Restoring database' : job.autoDownload ? 'Preparing your download' : 'Creating backup'}
      </DialogTitle>
      <DialogContent>
        <Stepper activeStep={finished && status === 'SUCCESS' ? steps.length : active} alternativeLabel sx={{ mb: 3, mt: 1,
          '& .MuiStepIcon-root.Mui-active, & .MuiStepIcon-root.Mui-completed': { color: GREEN } }}
        >
          {steps.map((label, i) => (
            <Step key={label}>
              <StepLabel error={status === 'FAILED' && i === active}>
                <Typography variant="caption" sx={{ fontWeight: 600 }}>{label}</Typography>
              </StepLabel>
            </Step>
          ))}
        </Stepper>

        {!finished && (
          <Box role="status" aria-live="polite">
            <LinearProgress sx={{ height: 8, borderRadius: 4, mb: 1.5, '& .MuiLinearProgress-bar': { bgcolor: GREEN } }} />
            <Typography variant="body2" color="text.secondary">
              {isRestore
                ? `${state?.stage_label || 'Starting'}… Changes from other users are paused until this finishes. Please keep this window open.`
                : 'Reading every table in one consistent snapshot, then checking the stored copy against its checksums. You can close this window — the backup keeps running.'}
            </Typography>
          </Box>
        )}

        {finished && status === 'SUCCESS' && (
          <Alert icon={<DoneIcon />} severity="success" sx={{ borderRadius: '12px' }}>
            {isRestore ? (
              <>
                <b>Database restored</b> — {state.result?.rows?.toLocaleString?.() ?? state.result?.rows} records in {state.result?.tables} tables.
                A safety backup of the previous data was kept. Everyone else has been signed out; sign in again to continue.
                {state.result?.warnings?.length > 0 && <Box component="ul" sx={{ m: 0, mt: 1, pl: 2 }}>{state.result.warnings.map((w) => <li key={w}>{w}</li>)}</Box>}
              </>
            ) : (
              <>
                <b>Backup {state.backup_identifier}</b> created and verified ({formatBytes(state.file_size)}).
                {job.autoDownload && ' Your download should start automatically.'}
              </>
            )}
          </Alert>
        )}
        {finished && status === 'FAILED' && (
          <Alert icon={<FailIcon />} severity="error" sx={{ borderRadius: '12px' }}>
            <b>{isRestore ? 'Restore failed — no data was changed.' : 'Backup failed.'}</b> {state.error_summary}
          </Alert>
        )}
        {pollError && <Alert severity="warning" sx={{ mt: 2, borderRadius: '12px' }}>{pollError}</Alert>}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        {!isRestore && finished && status === 'SUCCESS' && (
          <Button sx={outlineButtonSx} onClick={() => backupApi.download(state.id).catch((e) => setPollError(apiErrorMessage(e)))}>
            {job.autoDownload ? 'Download again' : 'Download'}
          </Button>
        )}
        {isRestore && finished && status === 'SUCCESS'
          ? <Button variant="contained" sx={greenButtonSx} onClick={signInAgain}>Sign in again</Button>
          : (
            <Button variant={finished ? 'contained' : 'text'} sx={finished ? greenButtonSx : outlineButtonSx}
              onClick={onClose} disabled={isRestore && !finished}
            >
              {finished ? 'Done' : isRestore ? 'Restoring…' : 'Run in background'}
            </Button>
          )}
      </DialogActions>
    </Dialog>
  );
}
