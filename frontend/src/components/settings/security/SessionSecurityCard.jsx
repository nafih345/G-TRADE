import React, { useState } from 'react';
import {
  Alert, Box, Button, Chip, FormControl, MenuItem, Select, Skeleton, Stack, Switch, Typography,
} from '@mui/material';
import {
  LockClockOutlined as SessionIcon, TimerOutlined as TimerIcon, VerifiedUserOutlined as ReauthIcon,
  GppMaybeOutlined as AttemptsIcon, PhonelinkLockOutlined as TwoFactorIcon, CheckCircle as CheckIcon,
  ErrorOutline as ErrorIcon, EditNote as PendingIcon,
} from '@mui/icons-material';
import { PanelCard, SettingRow, GREEN, TONES, outlineButtonSx } from './securityUi';
import TwoFactorSetupDialog from './TwoFactorSetupDialog';
import { TIMEOUT_OPTIONS, LOCKOUT_OPTIONS } from '../../../utils/securityFormat';
import { formatDate, formatTime } from '../../../utils/localeFormat';

const switchSx = {
  '& .MuiSwitch-switchBase.Mui-checked': { color: GREEN },
  '& .MuiSwitch-switchBase.Mui-checked + .MuiSwitch-track': { bgcolor: GREEN, background: GREEN, opacity: 0.6 },
};

/** Left card of the first row. Edits are page-level: saved by the header "Save Changes". */
export default function SessionSecurityCard({ form, saved, server, errors, dirtyKeys, saving, canEdit, onChange, onTwoFactorChanged }) {
  const [tfDialog, setTfDialog] = useState(null); // 'enable' | 'disable'

  if (!form) {
    return (
      <PanelCard icon={<SessionIcon />} title="Session Security" subtitle="Sign-in and session protection">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} height={64} />)}
      </PanelCard>
    );
  }

  const set = (key) => (value) => onChange({ [key]: value });
  const enrolled = !!server?.two_factor?.enrolled;
  const disabled = !canEdit || saving;
  const pending = dirtyKeys.length > 0;
  const hasErrors = Object.keys(errors).length > 0;

  const status = hasErrors
    ? { tone: 'error', icon: <ErrorIcon fontSize="small" />, text: 'Some settings were not saved — see the highlighted fields.' }
    : pending
      ? { tone: 'warning', icon: <PendingIcon fontSize="small" />, text: `${dirtyKeys.length} unsaved change${dirtyKeys.length === 1 ? '' : 's'} — press Save Changes` }
      : { tone: 'success', icon: <CheckIcon fontSize="small" />, text: server?.updated_by
        ? `Saved · last changed by ${server.updated_by} on ${formatDate(server.updated_at)} ${formatTime(server.updated_at)}`
        : 'Saved · default security policy' };

  const pendingDot = (key) => (dirtyKeys.includes(key) ? (
    <Box component="span" title="Unsaved" sx={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', bgcolor: TONES.warning.main, ml: 0.75, verticalAlign: 'middle' }} />
  ) : null);

  return (
    <PanelCard id="session-security" icon={<SessionIcon />} title="Session Security"
      subtitle="Control how long sessions last and how sign-ins are protected"
    >
      {!canEdit && (
        <Alert severity="info" sx={{ mb: 1, borderRadius: '12px' }}>Only a Super Admin can change the security policy.</Alert>
      )}

      <SettingRow
        icon={<TimerIcon fontSize="small" />}
        labelId="sec-timeout-label"
        title={<>Automatic Inactivity Timeout{pendingDot('inactivity_timeout_minutes')}</>}
        subtitle="Sign out idle sessions automatically. Enforced by the server, with a one-minute warning on screen."
        error={errors.inactivity_timeout_minutes}
        control={(
          <FormControl size="small" sx={{ minWidth: 150 }} error={!!errors.inactivity_timeout_minutes}>
            <Select value={form.inactivity_timeout_minutes} disabled={disabled}
              inputProps={{ 'aria-labelledby': 'sec-timeout-label' }}
              onChange={(e) => set('inactivity_timeout_minutes')(Number(e.target.value))}
            >
              {TIMEOUT_OPTIONS.map((m) => <MenuItem key={m} value={m}>{m} minutes</MenuItem>)}
            </Select>
          </FormControl>
        )}
      />

      <SettingRow
        icon={<ReauthIcon fontSize="small" />}
        labelId="sec-reauth-label"
        title={<>Re-authentication for Sensitive Actions{pendingDot('sensitive_action_reauth')}</>}
        subtitle="Ask for the password again before deleting records, restoring a backup, or changing financial, tax, user-permission and security settings."
        error={errors.sensitive_action_reauth}
        control={<Switch checked={!!form.sensitive_action_reauth} disabled={disabled} sx={switchSx}
          inputProps={{ 'aria-labelledby': 'sec-reauth-label' }}
          onChange={(e) => set('sensitive_action_reauth')(e.target.checked)} />}
      />

      <SettingRow
        icon={<AttemptsIcon fontSize="small" />}
        labelId="sec-attempts-label"
        title={<>Login Attempt Protection{pendingDot('login_protection_enabled')}</>}
        subtitle="Temporarily lock an account (and the device's address) after repeated failed sign-ins."
        error={errors.login_protection_enabled || errors.max_failed_attempts || errors.lockout_minutes}
        control={<Switch checked={!!form.login_protection_enabled} disabled={disabled} sx={switchSx}
          inputProps={{ 'aria-labelledby': 'sec-attempts-label' }}
          onChange={(e) => set('login_protection_enabled')(e.target.checked)} />}
      >
        {form.login_protection_enabled && (
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ fontSize: '0.88rem', color: 'text.secondary' }}>
            <span>Lock after</span>
            <Select size="small" value={form.max_failed_attempts} disabled={disabled} aria-label="Failed attempts before lock"
              onChange={(e) => set('max_failed_attempts')(Number(e.target.value))} sx={{ minWidth: 70 }}
            >
              {[3, 4, 5, 6, 7, 8, 9, 10].map((n) => <MenuItem key={n} value={n}>{n}</MenuItem>)}
            </Select>
            <span>failed attempts for</span>
            <Select size="small" value={form.lockout_minutes} disabled={disabled} aria-label="Lockout duration"
              onChange={(e) => set('lockout_minutes')(Number(e.target.value))} sx={{ minWidth: 120 }}
            >
              {LOCKOUT_OPTIONS.map((m) => <MenuItem key={m} value={m}>{m} minutes</MenuItem>)}
            </Select>
            {(dirtyKeys.includes('max_failed_attempts') || dirtyKeys.includes('lockout_minutes')) && pendingDot('max_failed_attempts')}
          </Stack>
        )}
      </SettingRow>

      <SettingRow
        divider={false}
        icon={<TwoFactorIcon fontSize="small" />}
        labelId="sec-2fa-label"
        title={<>Two-Factor Authentication (2FA){pendingDot('two_factor_required')}</>}
        subtitle="Require a 6-digit code from an authenticator app at every sign-in. Users without one set it up at their next sign-in."
        error={errors.two_factor_required}
        control={(
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
              {form.two_factor_required ? 'Enforced' : 'Optional'}
            </Typography>
            <Switch checked={!!form.two_factor_required} disabled={disabled || (!enrolled && !form.two_factor_required)} sx={switchSx}
              inputProps={{ 'aria-labelledby': 'sec-2fa-label' }}
              onChange={(e) => set('two_factor_required')(e.target.checked)} />
          </Stack>
        )}
      >
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
          <Typography variant="body2" sx={{ fontWeight: 600 }}>Your account:</Typography>
          {enrolled
            ? <Chip size="small" color="success" variant="outlined" label="Authenticator set up" sx={{ fontWeight: 700 }} />
            : <Chip size="small" variant="outlined" label="Not set up" sx={{ fontWeight: 700 }} />}
          {enrolled ? (
            <Button size="small" sx={outlineButtonSx} onClick={() => setTfDialog('disable')}
              disabled={!!saved?.two_factor_required}
            >
              Turn off for my account
            </Button>
          ) : (
            <Button size="small" variant="outlined" sx={{ ...outlineButtonSx, color: GREEN, borderColor: GREEN }}
              onClick={() => setTfDialog('enable')}
            >
              Set up authenticator
            </Button>
          )}
        </Stack>
        {!enrolled && !form.two_factor_required && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
            Set up your own authenticator first — enforcing 2FA is only possible once you can pass it yourself.
          </Typography>
        )}
        {server?.two_factor && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {server.two_factor.enrolled_users} account{server.two_factor.enrolled_users === 1 ? '' : 's'} protected by an authenticator.
          </Typography>
        )}
      </SettingRow>

      <Box sx={{ mt: 'auto', pt: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" role="status" aria-live="polite"
          sx={{ px: 1.5, py: 1, borderRadius: '12px', bgcolor: 'action.hover', color: TONES[status.tone].main }}
        >
          {saving ? <Typography variant="body2">Saving…</Typography> : (
            <>
              {status.icon}
              <Typography variant="body2" sx={{ color: 'text.secondary', fontWeight: 600 }}>{status.text}</Typography>
            </>
          )}
        </Stack>
      </Box>

      <TwoFactorSetupDialog open={!!tfDialog} mode={tfDialog} onClose={() => setTfDialog(null)}
        onDone={() => { setTfDialog(null); onTwoFactorChanged?.(); }} />
    </PanelCard>
  );
}
