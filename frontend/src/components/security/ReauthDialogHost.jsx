import React, { useEffect, useRef, useState } from 'react';
import {
  Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import LockPersonOutlinedIcon from '@mui/icons-material/LockPersonOutlined';
import { registerReauthHandler } from '../../utils/sessionGuard';
import { securityApi, fieldErrors } from '../../utils/securityApi';
import { apiErrorMessage } from '../../utils/apiError';

/**
 * Answers utils/sessionGuard's re-authentication requests: when the server refuses a sensitive
 * action with "reauth_required", this asks for the password (and the authenticator code when the
 * account has one), confirms it with the server, and lets the original request retry.
 */
export default function ReauthDialogHost() {
  const [open, setOpen] = useState(false);
  const [needsCode, setNeedsCode] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const resolver = useRef(null);

  useEffect(() => registerReauthHandler(() => new Promise((resolve) => {
    resolver.current = resolve;
    setPassword('');
    setCode('');
    setErrors({});
    setMessage('');
    setOpen(true);
    securityApi.policy().then((p) => setNeedsCode(!!p.two_factor_enrolled)).catch(() => {});
  })), []);

  const finish = (ok) => {
    setOpen(false);
    resolver.current?.(ok);
    resolver.current = null;
  };

  const submit = async (e) => {
    e?.preventDefault();
    if (!password) { setErrors({ password: 'Enter your password.' }); return; }
    setBusy(true);
    setErrors({});
    setMessage('');
    try {
      await securityApi.reauth(password, code.replace(/\D/g, '') || undefined);
      finish(true);
    } catch (err) {
      const fe = fieldErrors(err);
      if (fe.code) setNeedsCode(true);
      setErrors(fe);
      if (!Object.keys(fe).length) setMessage(apiErrorMessage(err, 'Could not confirm your password.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !busy && finish(false)} maxWidth="xs" fullWidth
      PaperProps={{ component: 'form', onSubmit: submit, sx: { borderRadius: '20px' } }}
    >
      <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1 }}>
        <LockPersonOutlinedIcon sx={{ color: '#5B55F5' }} /> Confirm it's you
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          This is a sensitive action. Enter your password to continue — you won't be asked again for the next few minutes.
        </Typography>
        {message && <Alert severity="error" sx={{ mb: 2 }}>{message}</Alert>}
        <Stack spacing={2}>
          <TextField label="Password" type="password" autoFocus fullWidth value={password} autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)} error={!!errors.password} helperText={errors.password} />
          {needsCode && (
            <TextField label="Authenticator code" fullWidth value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
              inputProps={{ inputMode: 'numeric', autoComplete: 'one-time-code' }}
              error={!!errors.code} helperText={errors.code || '6-digit code from your authenticator app'} />
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={() => finish(false)} disabled={busy}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={busy}
          sx={{ bgcolor: '#5B55F5', background: '#5B55F5', '&:hover': { bgcolor: '#4a44e0', background: '#4a44e0' }, fontWeight: 700 }}
        >
          {busy ? <CircularProgress size={18} sx={{ color: '#fff' }} /> : 'Confirm'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
