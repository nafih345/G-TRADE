// Edit Stock: the only way Stock Overview changes a quantity. Nothing is written until
// "Confirm Adjustment"; the backend then records a StockAdjustment (previous / new / difference,
// reason, reference, user) and moves stock through the same ledger path as purchases and sales.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Stack, TextField, MenuItem, Typography,
  Box, Alert, ToggleButtonGroup, ToggleButton, CircularProgress,
} from '@mui/material';
import { adjustStock, newClientToken, formatQty } from './stockApi';
import { apiErrorMessage } from '../../../utils/apiError';
import { confirmPosting } from '../../../utils/businessPrefs';

const OTHER = 'Other';

export default function StockAdjustDialog({ open, row, initialQuantity, reasons = [], onClose, onSaved, onStale }) {
  const [mode, setMode] = useState('set'); // set = counted quantity, delta = add / remove
  const [value, setValue] = useState('');
  const [reason, setReason] = useState('');
  const [otherReason, setOtherReason] = useState('');
  const [reference, setReference] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [current, setCurrent] = useState(0);
  const tokenRef = useRef('');
  const qtyRef = useRef(null);

  useEffect(() => {
    if (!open || !row) return;
    setMode('set');
    setValue(initialQuantity !== undefined && initialQuantity !== null ? String(initialQuantity) : String(row.stock));
    setReason(reasons[0] || 'Physical stock count');
    setOtherReason('');
    setReference('');
    setError('');
    setCurrent(row.stock);
    tokenRef.current = newClientToken(); // one token per dialog: a retried Confirm applies once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, row?.id]);

  const parsed = value.trim() === '' ? NaN : Number(value);
  const isWhole = Number.isFinite(parsed) && Number.isInteger(parsed);
  const newQty = isWhole ? (mode === 'set' ? parsed : current + parsed) : NaN;
  const diff = Number.isFinite(newQty) ? newQty - current : NaN;
  const finalReason = reason === OTHER ? otherReason.trim() : reason;

  const problem = useMemo(() => {
    if (value.trim() === '') return 'Enter a quantity.';
    if (!isWhole) return 'Enter a whole number.';
    if (newQty < 0) return 'Stock cannot go below zero.';
    if (diff === 0) return 'The quantity is unchanged.';
    if (!finalReason) return 'Give a reason for the adjustment.';
    return '';
  }, [value, isWhole, newQty, diff, finalReason]);

  const submit = async (e) => {
    e?.preventDefault();
    if (problem || saving) return;
    if (!confirmPosting('this stock adjustment')) return;
    setSaving(true);
    setError('');
    try {
      const res = await adjustStock(row.id, {
        new_quantity: newQty, expected_stock: current, reason: finalReason,
        reference: reference.trim(), client_token: tokenRef.current,
      });
      onSaved?.(res);
    } catch (err) {
      const data = err?.response?.data;
      if (err?.response?.status === 409 && data?.row) {
        // Stock moved meanwhile: show the new figure, keep the dialog open, new token.
        setCurrent(data.row.stock);
        if (mode === 'set') setValue(String(data.row.stock));
        tokenRef.current = newClientToken();
        onStale?.(data.row);
      }
      setError(apiErrorMessage(err, 'The adjustment was not saved.'));
    } finally {
      setSaving(false);
    }
  };

  if (!row) return null;
  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth
      TransitionProps={{ onEntered: () => { qtyRef.current?.focus(); qtyRef.current?.select(); } }}>
      <Box component="form" onSubmit={submit} data-nav-scope="stock-adjust" noValidate>
        <DialogTitle sx={{ fontWeight: 800, pb: 0.5 }}>Adjust Stock</DialogTitle>
        <DialogContent>
          <Typography variant="body2" fontWeight={700}>{row.name}</Typography>
          <Typography variant="caption" color="text.secondary">
            {row.sku}{row.barcode ? ` · ${row.barcode}` : ''}{row.variant ? ` · ${row.variant}` : ''}
          </Typography>

          <ToggleButtonGroup exclusive size="small" value={mode} sx={{ mt: 2, mb: 1.5, display: 'flex' }}
            onChange={(_, m) => { if (!m) return; setMode(m); setValue(m === 'set' ? String(current) : ''); }}>
            <ToggleButton value="set" sx={{ flex: 1, fontWeight: 700 }}>Set counted qty</ToggleButton>
            <ToggleButton value="delta" sx={{ flex: 1, fontWeight: 700 }}>Add / remove</ToggleButton>
          </ToggleButtonGroup>

          <Stack spacing={1.5}>
            <TextField
              inputRef={qtyRef} size="small" required
              label={mode === 'set' ? 'New stock quantity' : 'Quantity to add (negative to remove)'}
              value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d-]/g, ''))}
              inputProps={{ inputMode: 'numeric', 'aria-describedby': 'adjust-summary' }}
              error={Boolean(value) && !isWhole}
            />
            <TextField select size="small" label="Reason" required value={reason} onChange={(e) => setReason(e.target.value)}>
              {[...new Set([...reasons, OTHER])].map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
            </TextField>
            {reason === OTHER && (
              <TextField size="small" label="Describe the reason" required value={otherReason}
                onChange={(e) => setOtherReason(e.target.value)} inputProps={{ maxLength: 500 }} />
            )}
            <TextField size="small" label="Reference (count sheet, memo…)" value={reference}
              onChange={(e) => setReference(e.target.value)} inputProps={{ maxLength: 100 }} />
          </Stack>

          <Box id="adjust-summary" sx={{ mt: 2, p: 1.5, borderRadius: 2, bgcolor: 'action.hover', display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', textAlign: 'center' }}>
            <Box>
              <Typography variant="caption" color="text.secondary">Current</Typography>
              <Typography fontWeight={800}>{formatQty(current)}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">New</Typography>
              <Typography fontWeight={800}>{Number.isFinite(newQty) ? formatQty(newQty) : '—'}</Typography>
            </Box>
            <Box>
              <Typography variant="caption" color="text.secondary">Difference</Typography>
              <Typography fontWeight={800} sx={{ color: diff > 0 ? 'success.main' : diff < 0 ? 'error.main' : 'text.primary' }}>
                {Number.isFinite(diff) ? `${diff > 0 ? '+' : ''}${formatQty(diff)}` : '—'}
              </Typography>
            </Box>
          </Box>

          {error && <Alert severity="error" sx={{ mt: 1.5 }}>{error}</Alert>}
          {!error && problem && value !== '' && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>{problem}</Typography>}
        </DialogContent>
        <DialogActions sx={{ px: 3, pb: 2 }}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button type="submit" variant="contained" disabled={Boolean(problem) || saving}
            startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null} sx={{ fontWeight: 800 }}>
            {saving ? 'Saving…' : 'Confirm Adjustment'}
          </Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
