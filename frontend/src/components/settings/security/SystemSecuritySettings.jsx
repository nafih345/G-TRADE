import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState,
} from 'react';
import { Alert, Button, Grid, Stack } from '@mui/material';
import SessionSecurityCard from './SessionSecurityCard';
import BackupHealthCard from './BackupHealthCard';
import BackupScheduleCard from './BackupScheduleCard';
import BackupRecoveryCard from './BackupRecoveryCard';
import BackupHistoryTable from './BackupHistoryTable';
import SecurityAuditPanel from './SecurityAuditPanel';
import RestoreConfirmationDialog from './RestoreConfirmationDialog';
import BackupProgressDialog from './BackupProgressDialog';
import { backupApi, fieldErrors, securityApi } from '../../../utils/securityApi';
import { SECURITY_FIELDS, changedKeys, pick } from '../../../utils/securityFormat';
import { SECURITY_POLICY_EVENT } from '../../../utils/sessionGuard';
import { setNavigationGuard } from '../../../utils/navigationGuard';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';
import { useAuth } from '../../../context/AuthContext';

const LEAVE_MESSAGE = 'You have unsaved security or backup schedule changes. Leave without saving them?';

/**
 * Settings → System Security & Backup. Session-security fields are page-level settings saved by the
 * header "Save Changes" (via the ref: save / discard / isDirty, like the other form tabs); the
 * backup schedule saves on its own; backups and restores are actions that run immediately.
 */
const SystemSecuritySettings = forwardRef(function SystemSecuritySettings({ onStateChange }, ref) {
  const { user } = useAuth();
  const isOwner = user?.role === 'SUPER_ADMIN';
  const [server, setServer] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [conflict, setConflict] = useState(null);
  const [scheduleDirty, setScheduleDirty] = useState(false);

  const [health, setHealth] = useState(null);
  const [healthError, setHealthError] = useState('');
  const [starting, setStarting] = useState(false);
  const [job, setJob] = useState(null);          // progress dialog
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [refreshKey, setRefreshKey] = useState(0);

  // ---- security policy (page-level form) -------------------------------------------------------
  const adopt = useCallback((data) => {
    setServer(data);
    setForm(pick(data, SECURITY_FIELDS));
    setErrors({});
  }, []);
  const loadSettings = useCallback(() => {
    setLoadError('');
    securityApi.getSettings().then(adopt).catch((e) => setLoadError(`Could not load the security settings. ${apiErrorMessage(e)}`));
  }, [adopt]);
  useEffect(() => { loadSettings(); }, [loadSettings]);

  const dirtyKeys = useMemo(() => changedKeys(form, server && pick(server, SECURITY_FIELDS), SECURITY_FIELDS), [form, server]);
  const dirty = dirtyKeys.length > 0;

  const change = (patch) => {
    setForm((f) => ({ ...f, ...patch }));
    setErrors((e) => { const n = { ...e }; Object.keys(patch).forEach((k) => delete n[k]); return n; });
  };

  const save = useCallback(async () => {
    if (!dirty || saving) return false;
    setSaving(true);
    setConflict(null);
    try {
      const body = { ...Object.fromEntries(dirtyKeys.map((k) => [k, form[k]])), version: server.version };
      const data = await securityApi.saveSettings(body);
      adopt(data);
      window.dispatchEvent(new Event(SECURITY_POLICY_EVENT));
      notify('Security settings saved.', 'success');
      setRefreshKey((k) => k + 1);
      return true;
    } catch (err) {
      if (err?.response?.status === 409) {
        setConflict(err.response.data.current);
      } else if (err?.response?.status === 403 && err.response.data?.code === 'reauth_required') {
        notify('Security settings were not saved — password confirmation was cancelled.', 'warning');
      } else {
        const fe = fieldErrors(err);
        setErrors(fe);
        notify(`Security settings not saved. ${Object.keys(fe).length ? 'Please fix the highlighted fields.' : apiErrorMessage(err)}`, 'error');
      }
      return false;
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, dirtyKeys, form, server, adopt]);

  const discard = useCallback(() => { if (server) adopt(server); setConflict(null); }, [server, adopt]);

  useImperativeHandle(ref, () => ({ save, discard, isDirty: () => dirty }), [save, discard, dirty]);
  useEffect(() => {
    onStateChange?.({ dirty, saving, canSave: !!server?.can_edit });
  }, [dirty, saving, server, onStateChange]);

  // Unsaved changes (policy or schedule): warn on reload / close and on in-app navigation.
  const anyDirty = dirty || scheduleDirty;
  useEffect(() => {
    if (!anyDirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = LEAVE_MESSAGE; return LEAVE_MESSAGE; };
    window.addEventListener('beforeunload', onBeforeUnload);
    const release = setNavigationGuard(LEAVE_MESSAGE);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); release(); };
  }, [anyDirty]);

  // ---- backup health ---------------------------------------------------------------------------
  const loadHealth = useCallback(() => {
    backupApi.health().then((h) => { setHealth(h); setHealthError(''); })
      .catch((e) => setHealthError(`Could not load backup status. ${apiErrorMessage(e)}`));
  }, []);
  useEffect(() => { loadHealth(); }, [loadHealth, refreshKey]);
  const running = !!(health?.running_backup || health?.running_restore);
  useEffect(() => {
    const id = setInterval(loadHealth, running ? 5000 : 60000);
    return () => clearInterval(id);
  }, [loadHealth, running]);

  const startBackup = async (autoDownload) => {
    if (starting) return;
    setStarting(true);
    try {
      const rec = await backupApi.create();
      setJob({ kind: 'backup', id: rec.id, initial: rec, autoDownload });
      loadHealth();
    } catch (err) {
      notify(err?.response?.status === 409 ? err.response.data.detail : `The backup could not be started. ${apiErrorMessage(err)}`, 'error');
    } finally {
      setStarting(false);
    }
  };

  const onJobFinished = useCallback(() => { setRefreshKey((k) => k + 1); }, []);
  const timezone = health?.timezone;
  const busy = starting || running;

  if (loadError) {
    return (
      <Alert severity="error" sx={{ borderRadius: '16px' }} action={<Button color="inherit" size="small" onClick={loadSettings}>Retry</Button>}>
        {loadError}
      </Alert>
    );
  }

  return (
    <Stack spacing={3}>
      {conflict && (
        <Alert severity="warning" sx={{ borderRadius: '16px' }}
          action={<Button color="inherit" size="small" onClick={() => { adopt(conflict); setConflict(null); }}>Load latest</Button>}
        >
          Another administrator changed the security settings while you were editing ({conflict.updated_by || 'unknown'}).
          Your changes were not saved — load the latest values and apply them again.
        </Alert>
      )}

      <Grid container spacing={3} alignItems="stretch">
        <Grid item xs={12} lg={7}>
          <SessionSecurityCard
            form={form} saved={server && pick(server, SECURITY_FIELDS)} server={server} errors={errors}
            dirtyKeys={dirtyKeys} saving={saving} canEdit={!!server?.can_edit}
            onChange={change} onTwoFactorChanged={() => { loadSettings(); setRefreshKey((k) => k + 1); }}
          />
        </Grid>
        <Grid item xs={12} lg={5}>
          <BackupHealthCard health={health} error={healthError} timezone={timezone} creating={starting}
            onCreate={() => startBackup(false)} onRetry={loadHealth} />
        </Grid>
      </Grid>

      <BackupScheduleCard onSaved={() => setRefreshKey((k) => k + 1)} onDirtyChange={setScheduleDirty} />

      <BackupRecoveryCard
        health={health} timezone={timezone} canRestore={isOwner} busy={busy}
        maxUploadBytes={health?.max_upload_bytes}
        onDownloadNew={() => startBackup(true)}
        onRestore={(backup, extra) => setRestoreTarget({ backup, ...extra })}
      />

      <BackupHistoryTable refreshKey={refreshKey} timezone={timezone} canRestore={isOwner} busy={busy}
        onRestore={(row) => setRestoreTarget({ backup: row })} onChanged={() => setRefreshKey((k) => k + 1)} />

      <SecurityAuditPanel refreshKey={refreshKey} timezone={timezone} />

      <RestoreConfirmationDialog
        backup={restoreTarget?.backup}
        source={restoreTarget?.source}
        warnings={restoreTarget?.warnings}
        timezone={timezone}
        onClose={() => setRestoreTarget(null)}
        onStarted={(restoreJob) => {
          restoreTarget?.onDone?.();
          setRestoreTarget(null);
          setJob({ kind: 'restore', id: restoreJob.id, initial: restoreJob });
          loadHealth();
        }}
      />
      <BackupProgressDialog job={job} onClose={() => { setJob(null); loadHealth(); }} onFinished={onJobFinished} />
    </Stack>
  );
});

export default SystemSecuritySettings;
