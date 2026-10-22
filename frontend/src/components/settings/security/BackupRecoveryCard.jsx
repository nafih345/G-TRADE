import React, { useRef, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Grid, LinearProgress, Stack, Typography,
} from '@mui/material';
import { alpha } from '@mui/material/styles';
import {
  SettingsBackupRestoreOutlined as RecoveryIcon, CloudDownloadOutlined as DownloadIcon, RestoreOutlined as RestoreIcon,
  UploadFileOutlined as FileIcon, CheckCircleOutline as ValidIcon,
} from '@mui/icons-material';
import { PanelCard, GREEN, INDIGO, TONES, greenButtonSx, indigoButtonSx, outlineButtonSx } from './securityUi';
import { backupApi } from '../../../utils/securityApi';
import { checkBackupFile, formatBytes, formatInZone } from '../../../utils/securityFormat';
import { apiErrorMessage } from '../../../utils/apiError';

function Panel({ icon, color, title, children }) {
  return (
    <Box sx={{ p: { xs: 2, sm: 2.5 }, height: '100%', borderRadius: '16px', border: '1px solid', borderColor: 'divider',
      bgcolor: (t) => alpha(color, t.palette.mode === 'dark' ? 0.06 : 0.03), display: 'flex', flexDirection: 'column' }}
    >
      <Stack direction="row" spacing={1.25} alignItems="center" sx={{ mb: 1 }}>
        <Box sx={{ color, display: 'flex' }}>{icon}</Box>
        <Typography component="h3" sx={{ fontWeight: 800, fontSize: '1rem' }}>{title}</Typography>
      </Stack>
      {children}
    </Box>
  );
}

/**
 * Two panels: Download Backup (a fresh, verified snapshot streamed to the browser) and Restore
 * from Backup (choose → upload & validate on the server → confirm). Restoring needs Super Admin.
 */
export default function BackupRecoveryCard({ health, timezone, canRestore, busy, onDownloadNew, onRestore, maxUploadBytes }) {
  const inputRef = useRef(null);
  const [file, setFile] = useState(null);
  const [fileError, setFileError] = useState('');
  const [progress, setProgress] = useState(null);
  const [validated, setValidated] = useState(null); // upload response
  const [downloading, setDownloading] = useState(false);

  const latest = health?.last_successful;

  const choose = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    setValidated(null);
    if (!f) return;
    setFile(f);
    setFileError(checkBackupFile(f, maxUploadBytes));
  };

  const upload = async () => {
    setProgress(0);
    setFileError('');
    try {
      const res = await backupApi.upload(file, setProgress);
      setValidated(res);
    } catch (err) {
      setFileError(err?.response?.data?.errors?.file || apiErrorMessage(err, 'The file could not be validated.'));
    } finally {
      setProgress(null);
    }
  };

  const downloadLatest = async () => {
    setDownloading(true);
    try { await backupApi.download(latest.id); } catch { /* the notice below covers it */ }
    setDownloading(false);
  };

  const reset = () => { setFile(null); setValidated(null); setFileError(''); };

  return (
    <PanelCard id="backup-recovery" icon={<RecoveryIcon />} title="Backup & Recovery"
      subtitle="Keep an offline copy of your data, or bring the system back to an earlier point"
    >
      <Grid container spacing={2}>
        <Grid item xs={12} md={6}>
          <Panel icon={<DownloadIcon />} color={GREEN} title="Download Backup">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Creates a fresh, verified snapshot of the whole database — sales, stock, patients, prescriptions, accounts,
              users and settings — as a <b>.zip</b> file you can keep off the server. It is checksummed and can be restored
              here or on another Greensol installation. Uploaded images are not included.
            </Typography>
            <Box sx={{ mt: 'auto' }}>
              <Button variant="contained" startIcon={busy ? <CircularProgress size={16} sx={{ color: 'inherit' }} /> : <DownloadIcon />}
                onClick={onDownloadNew} disabled={busy} sx={{ ...greenButtonSx, mb: 1 }}
              >
                {busy ? 'Backup in progress…' : 'Download Backup'}
              </Button>
              {latest && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  Or{' '}
                  <Box component="button" type="button" onClick={downloadLatest} disabled={downloading}
                    sx={{ p: 0, border: 0, background: 'none', color: GREEN, fontWeight: 700, cursor: 'pointer', font: 'inherit', textDecoration: 'underline' }}
                  >
                    download the latest backup
                  </Box>
                  {' '}({formatInZone(latest.completed_at, timezone)}, {formatBytes(latest.file_size)}).
                </Typography>
              )}
            </Box>
          </Panel>
        </Grid>

        <Grid item xs={12} md={6}>
          <Panel icon={<RestoreIcon />} color={INDIGO} title="Restore from Backup">
            <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
              Choose a backup <b>.zip</b> made by this application. It is checked on the server — format, integrity and
              version compatibility — before restoring is offered. You can also restore any backup from the history below.
            </Typography>
            {!canRestore && (
              <Alert severity="info" sx={{ mb: 2, borderRadius: '12px' }}>Only a Super Admin can restore the database.</Alert>
            )}
            <input ref={inputRef} type="file" accept=".zip,application/zip" hidden onChange={choose} aria-label="Backup file" />

            {file && (
              <Stack direction="row" spacing={1.25} alignItems="center" sx={{ p: 1.5, mb: 1.5, borderRadius: '12px', border: '1px dashed', borderColor: 'divider' }}>
                <FileIcon sx={{ color: INDIGO }} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Typography variant="body2" sx={{ fontWeight: 700, wordBreak: 'break-all' }}>{file.name}</Typography>
                  <Typography variant="caption" color="text.secondary">{formatBytes(file.size)}</Typography>
                </Box>
                <Button size="small" onClick={reset} sx={{ textTransform: 'none' }}>Clear</Button>
              </Stack>
            )}
            {progress != null && (
              <Box sx={{ mb: 1.5 }} role="status">
                <LinearProgress variant={progress < 100 ? 'determinate' : 'indeterminate'} value={progress}
                  sx={{ height: 6, borderRadius: 3, '& .MuiLinearProgress-bar': { bgcolor: INDIGO } }} />
                <Typography variant="caption" color="text.secondary">
                  {progress < 100 ? `Uploading… ${progress}%` : 'Validating every table against its checksum…'}
                </Typography>
              </Box>
            )}
            {fileError && <Alert severity="error" sx={{ mb: 1.5, borderRadius: '12px' }}>{fileError}</Alert>}
            {validated && (
              <Alert icon={<ValidIcon />} severity={validated.warnings.length ? 'warning' : 'success'} sx={{ mb: 1.5, borderRadius: '12px' }}>
                <b>Valid backup{validated.duplicate ? ' (already on the server)' : ''}.</b>{' '}
                {validated.source.backup_identifier} · taken {formatInZone(validated.source.created_at, timezone)} ·{' '}
                {validated.source.table_count} tables, {validated.source.total_rows?.toLocaleString()} records ({validated.source.database_engine}).
                {validated.warnings.length > 0 && <Box sx={{ mt: 0.5 }}>{validated.warnings.join(' ')}</Box>}
              </Alert>
            )}

            <Stack direction="row" spacing={1.5} sx={{ mt: 'auto' }} flexWrap="wrap" useFlexGap>
              <Button variant="outlined" startIcon={<FileIcon />} onClick={() => inputRef.current?.click()}
                disabled={!canRestore || progress != null || busy} sx={{ ...outlineButtonSx, color: INDIGO, borderColor: alpha(INDIGO, 0.5) }}
              >
                Choose Backup File
              </Button>
              {file && !validated && (
                <Button variant="contained" onClick={upload} disabled={!!checkBackupFile(file, maxUploadBytes) || progress != null}
                  sx={indigoButtonSx}
                >
                  Upload &amp; Validate
                </Button>
              )}
              {validated && (
                <Button variant="contained" color="error" startIcon={<RestoreIcon />} disabled={busy}
                  onClick={() => onRestore(validated.backup, { source: validated.source, warnings: validated.warnings, onDone: reset })}
                  sx={{ fontWeight: 700, textTransform: 'none', borderRadius: '12px', boxShadow: 'none' }}
                >
                  Restore this backup…
                </Button>
              )}
            </Stack>
            {fileError === '' && file && !validated && progress == null && (
              <Typography variant="caption" sx={{ mt: 1, color: TONES.info.text }}>
                The file is only checked at this step — nothing is changed until you confirm the restore.
              </Typography>
            )}
          </Panel>
        </Grid>
      </Grid>
    </PanelCard>
  );
}
