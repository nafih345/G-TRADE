import React, { useEffect, useState } from 'react';
import {
  Alert, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import OtpQrCode from '../../security/OtpQrCode';
import { securityApi, fieldErrors } from '../../../utils/securityApi';
import { apiErrorMessage } from '../../../utils/apiError';
import { greenButtonSx, RADIUS } from './securityUi';

/** mode 'enable': scan + confirm a code. mode 'disable': password + current code. */
export default function TwoFactorSetupDialog({ open, mode, onClose, onDone }) {
  const [setup, setSetup] = useState(null);
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState({});
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    setCode(''); setPassword(''); setErrors({}); setMessage(''); setSetup(null);
    if (mode === 'enable') {
      securityApi.twoFactorSetup().then(setSetup).catch((e) => setMessage(apiErrorMessage(e, 'Could not start the setup.')));
    }
  }, [open, mode]);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErrors({}); setMessage('');
    try {
      if (mode === 'enable') await securityApi.twoFactorConfirm(code.replace(/\D/g, ''));
      else await securityApi.twoFactorDisable(password, code.replace(/\D/g, ''));
      onDone?.();
    } catch (err) {
      const fe = fieldErrors(err);
      setErrors(fe);
      if (!Object.keys(fe).length) setMessage(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={() => !busy && onClose()} maxWidth="xs" fullWidth
      PaperProps={{ component: 'form', onSubmit: submit, sx: { borderRadius: RADIUS } }}
    >
      <DialogTitle sx={{ fontWeight: 800 }}>
        {mode === 'enable' ? 'Set up two-factor authentication' : 'Turn off two-factor authentication'}
      </DialogTitle>
      <DialogContent>
        {message && <Alert severity="error" sx={{ mb: 2 }}>{message}</Alert>}
        {mode === 'enable' ? (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              1. Scan this code with an authenticator app (Google Authenticator, Microsoft Authenticator, Authy…).
            </Typography>
            {setup ? <OtpQrCode uri={setup.otpauth_uri} secret={setup.secret} /> : !message && <CircularProgress sx={{ alignSelf: 'center' }} />}
            <Typography variant="body2" color="text.secondary">2. Enter the 6-digit code the app shows to finish.</Typography>
            <TextField label="Authentication code" value={code} autoFocus fullWidth
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
              inputProps={{ inputMode: 'numeric', autoComplete: 'one-time-code' }}
              error={!!errors.code} helperText={errors.code || ' '} />
          </Stack>
        ) : (
          <Stack spacing={2}>
            <Typography variant="body2" color="text.secondary">
              Your account will be protected by your password only. Confirm with your password and a current code.
            </Typography>
            <TextField label="Password" type="password" value={password} autoFocus fullWidth autoComplete="current-password"
              onChange={(e) => setPassword(e.target.value)} error={!!errors.password} helperText={errors.password} />
            <TextField label="Authentication code" value={code} fullWidth
              onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, '').slice(0, 6))}
              inputProps={{ inputMode: 'numeric', autoComplete: 'one-time-code' }}
              error={!!errors.code} helperText={errors.code} />
          </Stack>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={onClose} disabled={busy} sx={{ textTransform: 'none' }}>Cancel</Button>
        <Button type="submit" variant="contained" disabled={busy || code.length !== 6 || (mode === 'enable' && !setup)}
          sx={mode === 'enable' ? greenButtonSx : { ...greenButtonSx, bgcolor: 'error.main', '&:hover': { bgcolor: 'error.dark' } }}
        >
          {busy ? <CircularProgress size={18} sx={{ color: '#fff' }} /> : mode === 'enable' ? 'Verify and turn on' : 'Turn off'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
