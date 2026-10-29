import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, InputAdornment, TextField, Typography,
} from '@mui/material';
import { blankCheque, chequeDaysLeft, chequeDueDate, daysLeftLabel, daysLeftTone, validateCheque } from '../../utils/cheques';
import { formatDate } from '../../utils/localeFormat';

const TONE_COLOR = { overdue: 'error', today: 'warning', soon: 'info', later: 'success' };

export const DaysLeftChip = ({ days, size = 'small' }) => {
  const tone = daysLeftTone(days);
  if (!tone) return <Typography variant="body2" color="text.disabled">—</Typography>;
  return <Chip size={size} color={TONE_COLOR[tone]} variant={tone === 'later' ? 'outlined' : 'filled'} label={daysLeftLabel(days)} sx={{ fontWeight: 700 }} />;
};

/**
 * Cheque details for one Cheque pay line (Receipt / Payment Voucher) — or, from the Cheque
 * Register, for correcting a saved cheque (`amountLocked`: the amount is what the voucher posted).
 * Cheque Amount here IS the pay line's amount; saving writes it back to the line.
 */
export default function ChequeDetailsDialog({ open, direction = 'RECEIVED', value, amount, defaults = {}, amountLocked = false, saving = false, onSave, onClose }) {
  const [draft, setDraft] = useState(() => blankCheque());
  const [amt, setAmt] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (!open) return;
    setDraft(value ? { ...blankCheque(), ...value } : blankCheque({ partyName: defaults.partyName || '', bankName: defaults.bankName || '' }));
    setAmt(amount === undefined || amount === null ? '' : String(amount));
    setTried(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setDraft(d => ({ ...d, [k]: e.target.value }));
  const problems = validateCheque(draft, amt);
  const days = chequeDaysLeft(draft);
  const received = direction === 'RECEIVED';

  const save = (e) => {
    e?.preventDefault();
    setTried(true);
    if (problems.length) return;
    onSave({ cheque: draft, amount: amt });
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <Box component="form" onSubmit={save} noValidate>
        <DialogTitle sx={{ fontWeight: 850, pb: 1 }}>
          {received ? 'Cheque Received' : 'Cheque Issued'} — Details
          <Typography variant="body2" color="text.secondary">
            {received ? 'The cheque you received from the party.' : 'The cheque you are giving to the party.'}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField autoFocus fullWidth size="small" required label="Cheque Number" value={draft.chequeNumber} onChange={set('chequeNumber')}
                error={tried && !String(draft.chequeNumber).trim()} inputProps={{ maxLength: 40, 'data-chq': 'number', style: { fontFamily: 'monospace', fontWeight: 700 } }} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" required type="date" label="Cheque Date (Issue Date)" value={draft.chequeDate} onChange={set('chequeDate')}
                error={tried && !draft.chequeDate} InputLabelProps={{ shrink: true }} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" label="Bank Name" value={draft.bankName} onChange={set('bankName')}
                placeholder={received ? "Party's bank (drawn on)" : 'Your bank'} inputProps={{ maxLength: 150 }} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" required type="number" label="Cheque Amount" value={amt} onChange={(e) => setAmt(e.target.value)}
                disabled={amountLocked} error={tried && !(parseFloat(amt) > 0)}
                helperText={amountLocked ? 'Posted on the voucher — reverse the voucher to change it.' : 'Same as this payment line’s amount.'}
                inputProps={{ min: 0, step: '0.01', style: { textAlign: 'right', fontWeight: 700 } }}
                InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth size="small" type="date" label="Deposited Date" value={draft.depositedDate} onChange={set('depositedDate')}
                error={!!draft.depositedDate && !!draft.chequeDate && draft.depositedDate < draft.chequeDate}
                helperText={received ? 'Planned or actual deposit date (optional)' : 'Expected presentation date (optional)'}
                InputLabelProps={{ shrink: true }} inputProps={{ min: draft.chequeDate || undefined }} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <Box sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, px: 1.5, py: 0.75, minHeight: 40 }}>
                <Typography variant="caption" color="text.secondary" fontWeight={700} display="block">Days Left</Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
                  <DaysLeftChip days={days} />
                  {chequeDueDate(draft) && (
                    <Typography variant="caption" color="text.secondary">
                      to {formatDate(chequeDueDate(draft))} ({draft.depositedDate ? 'deposit date' : 'cheque date'})
                    </Typography>
                  )}
                </Box>
              </Box>
            </Grid>
            <Grid item xs={12}>
              <TextField fullWidth size="small" label={received ? 'Company / Party Name (issued by)' : 'Company / Party Name (payee)'}
                value={draft.partyName} onChange={set('partyName')} inputProps={{ maxLength: 200 }}
                helperText="Defaults to the voucher’s party when left blank." />
            </Grid>
            <Grid item xs={12}>
              <TextField fullWidth size="small" label="Remarks / Notes" value={draft.remarks} onChange={set('remarks')} multiline minRows={2}
                inputProps={{ maxLength: 500 }} />
            </Grid>
          </Grid>
          {tried && problems.length > 0 && (
            <Alert severity="error" sx={{ mt: 2 }}>Please {problems.join(', ')}.</Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 1.5 }}>
          <Button type="submit" variant="contained" disabled={saving} sx={{ fontWeight: 800 }}>{saving ? 'Saving…' : 'Save Cheque Details'}</Button>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
        </DialogActions>
      </Box>
    </Dialog>
  );
}
