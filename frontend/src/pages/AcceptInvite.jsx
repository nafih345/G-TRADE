// Account setup from a one-time invitation link (#/accept-invite?uid=…&token=…), issued in Client
// Management for a new client administrator or user. The link is checked first (who it is for),
// then the person picks their own password; they sign in normally afterwards. Nothing here signs
// anyone in or touches an existing session. Server: apps/common/invitations.py.
import React, { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Link as RouterLink, useLocation } from 'react-router-dom';
import {
  Alert, Box, Button, Card, CircularProgress, IconButton, InputAdornment, Stack, TextField, Typography,
} from '@mui/material';
import { Visibility, VisibilityOff } from '@mui/icons-material';
import BRAND from '../utils/brand';

const INVALID = 'This setup link is invalid, already used or expired. Ask your administrator for a new one.';

export default function AcceptInvite() {
  const { search } = useLocation();
  const link = useMemo(() => {
    const params = new URLSearchParams(search);
    return { uid: params.get('uid') || '', token: params.get('token') || '' };
  }, [search]);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [saving, setSaving] = useState(false);
  const [done, setDone] = useState(null);

  useEffect(() => {
    if (!link.uid || !link.token) { setError(INVALID); return; }
    axios.post('/api/auth/invitation/check/', link, { headers: { Authorization: undefined }, __silentError: true })
      .then(({ data }) => setInfo(data))
      .catch((err) => setError(err?.response?.data?.detail || (err?.response ? INVALID
        : 'Cannot reach the server. Check your connection and try again.')));
  }, [link]);

  const submit = async (e) => {
    e.preventDefault();
    if (saving) return;
    if (password !== confirm) { setFieldError('The two passwords do not match.'); return; }
    setFieldError('');
    setSaving(true);
    try {
      const { data } = await axios.post('/api/auth/invitation/accept/', { ...link, password },
        { headers: { Authorization: undefined }, __silentError: true });
      setDone(data);
    } catch (err) {
      const body = err?.response?.data;
      if (body?.password) setFieldError([].concat(body.password).join(' '));
      else setError(body?.detail || 'The password could not be set. Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'grid', placeItems: 'center', bgcolor: 'background.default', p: 2 }}>
      <Card variant="outlined" sx={{ width: '100%', maxWidth: 420, p: { xs: 2.5, sm: 3 } }}>
        <Typography variant="h6" fontWeight={800}>{BRAND.wordmarkCaps}</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>Set up your account</Typography>

        {!info && !error && <CircularProgress size={24} aria-label="Checking the link" />}
        {error && !done && <Alert severity="error">{error}</Alert>}

        {done && (
          <Stack spacing={2}>
            <Alert severity="success">{done.detail}</Alert>
            <Button component={RouterLink} to="/" variant="contained">Go to sign-in</Button>
          </Stack>
        )}

        {info && !done && !error && (
          <Box component="form" noValidate onSubmit={submit}>
            <Typography variant="body2" sx={{ mb: 2 }}>
              {info.name ? <><strong>{info.name}</strong>, choose </> : 'Choose '}
              a password for <strong>{info.username}</strong> at <strong>{info.business}</strong>.
            </Typography>
            <Stack spacing={1.5}>
              <TextField size="small" label="Username" value={info.username} disabled fullWidth
                inputProps={{ autoComplete: 'username' }} />
              <TextField size="small" label="New password" type={show ? 'text' : 'password'} value={password}
                onChange={(e) => { setPassword(e.target.value); setFieldError(''); }} autoFocus fullWidth required
                inputProps={{ autoComplete: 'new-password' }} error={Boolean(fieldError)}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <IconButton size="small" edge="end" onClick={() => setShow((v) => !v)}
                        aria-label={show ? 'Hide password' : 'Show password'}>
                        {show ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}
                      </IconButton>
                    </InputAdornment>
                  ),
                }} />
              <TextField size="small" label="Confirm password" type={show ? 'text' : 'password'} value={confirm}
                onChange={(e) => { setConfirm(e.target.value); setFieldError(''); }} fullWidth required
                inputProps={{ autoComplete: 'new-password' }} error={Boolean(fieldError)}
                helperText={fieldError || 'At least 8 characters; not only numbers; not similar to your username.'} />
              <Button type="submit" variant="contained" disabled={saving || !password || !confirm}
                startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}>
                {saving ? 'Saving…' : 'Set password'}
              </Button>
            </Stack>
          </Box>
        )}
      </Card>
    </Box>
  );
}
