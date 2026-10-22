import React, { useState } from 'react';
import { Alert, Box, Button, CircularProgress, Stack, TextField, Typography } from '@mui/material';
import ShieldOutlinedIcon from '@mui/icons-material/ShieldOutlined';
import ArrowBackRoundedIcon from '@mui/icons-material/ArrowBackRounded';
import OtpQrCode from './OtpQrCode';

/**
 * The second sign-in step. `setup` ({secret, otpauth_uri}) is present when two-factor sign-in is
 * required but this account has no authenticator yet — it is enrolled as part of signing in.
 * onVerify(code) resolves to AuthContext's result object.
 */
export default function TwoFactorLoginStep({ setup, onVerify, onCancel }) {
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    const digits = code.replace(/\D/g, '');
    if (digits.length !== 6) { setError('Enter the 6-digit code.'); return; }
    setBusy(true);
    setError('');
    const result = await onVerify(digits);
    setBusy(false);
    if (!result.success) {
      if (result.reason === 'challenge_expired') { onCancel(); return; }
      setError(result.message || (result.reason === 'network'
        ? 'Cannot reach the server. Check your connection and try again.'
        : 'That code is not valid. Check the time on your phone and try again.'));
      setCode('');
    }
  };

  return (
    <Box component="form" onSubmit={submit} noValidate>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1.5, color: '#08A65A' }}>
        <ShieldOutlinedIcon fontSize="small" />
        <Typography sx={{ fontSize: '0.78rem', fontWeight: 800, letterSpacing: '0.08em' }}>TWO-FACTOR AUTHENTICATION</Typography>
      </Stack>
      {setup ? (
        <>
          <Typography color="text.secondary" sx={{ mb: 2, fontSize: '0.92rem' }}>
            Two-factor sign-in is required for this workspace. Scan the code with an authenticator app
            (Google Authenticator, Microsoft Authenticator, Authy…), then enter the 6-digit code it shows.
          </Typography>
          <Box sx={{ mb: 2.5 }}><OtpQrCode uri={setup.otpauth_uri} secret={setup.secret} size={168} /></Box>
        </>
      ) : (
        <Typography color="text.secondary" sx={{ mb: 2.5, fontSize: '0.92rem' }}>
          Open your authenticator app and enter the 6-digit code for Greensol Optical ERP.
        </Typography>
      )}
      {error && <Alert severity="error" sx={{ mb: 2, borderRadius: 2.5 }}>{error}</Alert>}
      <TextField
        id="login-otp"
        fullWidth
        autoFocus
        label="Authentication code"
        value={code}
        onChange={(e) => { setCode(e.target.value.replace(/[^\d ]/g, '').slice(0, 7)); if (error) setError(''); }}
        inputProps={{ inputMode: 'numeric', autoComplete: 'one-time-code', maxLength: 7,
          style: { letterSpacing: '0.4em', fontSize: '1.3rem', fontWeight: 700, textAlign: 'center' } }}
      />
      <Button type="submit" variant="contained" fullWidth size="large" disabled={busy}
        sx={{ mt: 2.5, py: 1.4, fontWeight: 700, borderRadius: 2.5, textTransform: 'none', bgcolor: '#08A65A', background: '#08A65A',
          '&:hover': { bgcolor: '#078f4e', background: '#078f4e' } }}
      >
        {busy ? <CircularProgress size={20} sx={{ color: '#fff' }} /> : 'Verify and sign in'}
      </Button>
      <Button onClick={onCancel} startIcon={<ArrowBackRoundedIcon />} fullWidth sx={{ mt: 1, textTransform: 'none' }}>
        Use a different account
      </Button>
    </Box>
  );
}
