import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography,
} from '@mui/material';
import { Lock as LockIcon } from '@mui/icons-material';
import {
  EDIT_MODULE_LABELS, closeEditDialog, sendEditRequest, subscribeEditDialog,
} from '../utils/editPermissions';
import { notify } from '../utils/notify';

const fmt = (iso) => (iso ? new Date(iso).toLocaleString() : '');

// "Edit Permission Required": shown when a user whose Direct Edit is OFF for a module tries to
// edit a saved record of it (utils/editPermissions.js). Sends an edit request to the admins; the
// record stays read-only until one approves it.
export default function EditPermissionHost() {
  const [info, setInfo] = useState(null);
  const [reason, setReason] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => subscribeEditDialog((next) => {
    setInfo(next);
    setReason('');
    setError('');
    setSending(false);
  }), []);

  if (!info) return null;
  const req = info.request;
  const pending = info.mode === 'pending' || req?.status === 'PENDING';
  const rejected = info.mode === 'rejected' || req?.status === 'REJECTED';
  const moduleLabel = EDIT_MODULE_LABELS[info.module] || info.module;

  const submit = async () => {
    if (reason.trim().length < 3) { setError('Enter the reason for this edit.'); return; }
    setSending(true);
    setError('');
    try {
      await sendEditRequest({ module: info.module, recordId: info.recordId, recordRef: info.recordRef, reason: reason.trim() });
      notify(`Edit request sent for ${info.recordRef || moduleLabel}. The record stays read-only until an admin approves it.`, 'success');
      closeEditDialog();
    } catch (e) {
      const d = e?.response?.data;
      setError(d?.detail || d?.reason?.[0] || 'The request could not be sent. Try again.');
      setSending(false);
    }
  };

  return (
    <Dialog open onClose={closeEditDialog} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1 }}>
        <LockIcon color="warning" /> Edit Permission Required
      </DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 2 }}>
          Direct editing of <b>{moduleLabel}</b> records is turned off for your account. Send a request and an
          admin can unlock this record for one save.
        </Typography>
        <Stack direction="row" spacing={1} sx={{ mb: 2 }} flexWrap="wrap" useFlexGap>
          <Chip label={`Module: ${moduleLabel}`} color="primary" variant="outlined" sx={{ fontWeight: 700 }} />
          <Chip label={`Record: ${info.recordRef || info.recordId}`} variant="outlined" sx={{ fontWeight: 700 }} />
        </Stack>
        {pending && (
          <Alert severity="info" sx={{ mb: 2 }}>
            You already asked on {fmt(req?.created_at) || 'an earlier visit'}{req?.reason ? ` — “${req.reason}”` : ''}.
            It is waiting for admin approval. Sending again updates the reason.
          </Alert>
        )}
        {rejected && (
          <Alert severity="error" sx={{ mb: 2 }}>
            Your last request was rejected{req?.reviewed_by_name ? ` by ${req.reviewed_by_name}` : ''}
            {req?.review_note ? `: “${req.review_note}”` : '.'} You can send a new one.
          </Alert>
        )}
        {!pending && !rejected && info.message && (
          <Alert severity="warning" sx={{ mb: 2 }}>{info.message}</Alert>
        )}
        <TextField
          autoFocus fullWidth multiline minRows={3} required
          label="Reason for Edit *"
          placeholder="e.g. Optometrist not assigned, Incorrect tax rate selected"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          error={Boolean(error)}
          helperText={error || ' '}
          inputProps={{ maxLength: 2000 }}
        />
        <Box sx={{ fontSize: 12, color: 'text.secondary' }}>
          The record opens read-only until the request is approved.
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeEditDialog}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={sending} sx={{ fontWeight: 800 }}>
          {sending ? 'Sending…' : 'Send Request'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
