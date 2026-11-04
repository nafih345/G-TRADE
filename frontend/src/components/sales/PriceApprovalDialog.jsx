import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Stack, TextField, Typography,
} from '@mui/material';
import { GppMaybe as ApprovalIcon } from '@mui/icons-material';
import { PRICING_APPROVE_API } from '../../utils/pricingRules';
import { apiErrorMessage } from '../../utils/apiError';

// Settings → Pricing Rules & Offers: a bill has lines below their cost / minimum price. A manager
// approves on this screen with their own username + password (checked by the server, which
// returns a short-lived token the save carries) — or, when the signed-in user is a manager
// already, approves directly. onResolve(null) = not approved; else the extra save-payload fields.
export default function PriceApprovalDialog({ open, lines, canSelfApprove, onResolve }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const userRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setUsername(''); setPassword(''); setCode(''); setNeedCode(false); setError('');
    setTimeout(() => userRef.current?.focus(), 50);
  }, [open]);

  const approve = async () => {
    if (!username.trim() || !password) { setError("Enter the manager's username and password."); return; }
    setBusy(true);
    setError('');
    try {
      const res = await axios.post(PRICING_APPROVE_API, { username: username.trim(), password, code: code || undefined });
      onResolve({ price_override_token: res.data.token, approvedBy: res.data.approver });
    } catch (err) {
      if (err?.response?.data?.code === 'two_factor_required') setNeedCode(true);
      setError(apiErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : () => onResolve(null)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
      <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1, color: 'error.main' }}>
        <ApprovalIcon /> Manager approval needed
      </DialogTitle>
      <DialogContent dividers>
        <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }}>
          Selling price cannot be less than the cost price. These lines are below their minimum price:
          <Box component="ul" sx={{ m: 0, mt: 0.5, pl: 2.5 }}>
            {lines.map((l, i) => <li key={i}><b>{l.name}</b> — {l.text}</li>)}
          </Box>
        </Alert>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          Change the price, or ask an Administrator / Manager to approve this sale with their login.
        </Typography>
        <Stack spacing={2} component="form" onSubmit={(e) => { e.preventDefault(); approve(); }}>
          <TextField inputRef={userRef} label="Manager username" size="small" value={username} autoComplete="off"
            onChange={(e) => setUsername(e.target.value)} disabled={busy} />
          <TextField label="Password" type="password" size="small" value={password} autoComplete="new-password"
            onChange={(e) => setPassword(e.target.value)} disabled={busy} />
          {needCode && (
            <TextField label="Authenticator code" size="small" value={code} inputProps={{ inputMode: 'numeric', maxLength: 6 }}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} disabled={busy} />
          )}
          {error && <Alert severity="warning" sx={{ borderRadius: 2 }}>{error}</Alert>}
          <button type="submit" hidden aria-hidden="true" />
        </Stack>
        {canSelfApprove && (
          <>
            <Divider sx={{ my: 2 }}>or</Divider>
            <Button fullWidth variant="outlined" color="warning" disabled={busy}
              onClick={() => onResolve({ override_price_floor: true, approvedBy: 'you' })}>
              I am a manager — approve it myself
            </Button>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={() => onResolve(null)} disabled={busy}>Go back and change prices</Button>
        <Button variant="contained" color="error" onClick={approve} disabled={busy}>
          {busy ? 'Checking…' : 'Approve & Continue'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
