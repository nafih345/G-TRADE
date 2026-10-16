import React, { useEffect, useState } from 'react';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, MenuItem, Stack, TextField,
  ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import useBankAccounts from '../../hooks/useBankAccounts';
import { notify } from '../../utils/notify';
import { CASH_PAID, CASH_UNPAID, isCashMode, paymentKind } from '../../utils/paymentModes';

const ADD_BANK = '__add_bank__';

/**
 * The extra details a pay mode needs, the same on every screen:
 *   CASH -> Paid / Unpaid toggle (only when the screen passes onCashStatusChange)
 *   BANK -> which bank the money went to / came from
 *   UPI  -> the bank linked to the UPI ID
 * Renders nothing for Card / Credit / anything else.
 *
 * `compact` drops the field labels for tight table rows (New Sale / POS pay-mode tables).
 */
export default function PaymentModeDetails({
  method,
  bankAccount = '',
  onBankAccountChange,
  cashStatus = CASH_PAID,
  onCashStatusChange,
  size = 'small',
  compact = false,
  disabled = false,
  sx,
}) {
  const kind = paymentKind(method);
  const { banks, loading, addBank } = useBankAccounts();
  const [adding, setAdding] = useState(false);
  const wantsBank = (kind === 'bank' || kind === 'upi') && !!onBankAccountChange;

  // Only one bank on the books: pick it, so the common single-bank shop never has to.
  useEffect(() => {
    if (wantsBank && !disabled && !bankAccount && banks.length === 1) onBankAccountChange(banks[0].id);
  }, [wantsBank, disabled, bankAccount, banks, onBankAccountChange]);

  if (isCashMode(method) && onCashStatusChange) {
    return (
      <Box sx={sx}>
        {!compact && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>Cash status</Typography>}
        <ToggleButtonGroup
          exclusive size="small" value={cashStatus || CASH_PAID} disabled={disabled}
          onChange={(_, v) => { if (v) onCashStatusChange(v); }}
          sx={{ '& .MuiToggleButton-root': { py: compact ? 0 : 0.25, px: compact ? 0.75 : 1.5, fontWeight: 800, fontSize: compact ? '0.62rem' : '0.75rem' } }}
        >
          <ToggleButton value={CASH_PAID} color="success" aria-label="Cash paid">Paid</ToggleButton>
          <ToggleButton value={CASH_UNPAID} color="error" aria-label="Cash unpaid">Unpaid</ToggleButton>
        </ToggleButtonGroup>
      </Box>
    );
  }

  if (!wantsBank) return null;

  const label = kind === 'upi' ? 'Linked Bank (UPI)' : 'Bank';
  const known = !bankAccount || banks.some((b) => b.id === bankAccount);
  return (
    <Box sx={sx}>
      <TextField
        select fullWidth size={size} disabled={disabled}
        label={compact ? undefined : label}
        value={known ? (bankAccount || '') : ''}
        onChange={(e) => {
          if (e.target.value === ADD_BANK) setAdding(true);
          else onBankAccountChange(e.target.value || null);
        }}
        SelectProps={{
          displayEmpty: true,
          renderValue: (v) => {
            const b = banks.find((x) => x.id === v);
            if (b) return b.name;
            return <span style={{ opacity: 0.6 }}>{loading ? 'Loading banks…' : (compact ? `Select ${kind === 'upi' ? 'linked bank' : 'bank'}` : 'Default bank account')}</span>;
          },
        }}
        InputLabelProps={{ shrink: true }}
        inputProps={{ 'aria-label': label }}
        sx={compact ? { '& .MuiSelect-select': { py: 0.25, fontSize: '0.68rem', fontWeight: 700 } } : undefined}
      >
        <MenuItem value=""><em>Default bank account</em></MenuItem>
        {banks.map((b) => (
          <MenuItem key={b.id} value={b.id}>
            <Box>
              <Typography variant="body2" fontWeight={700}>{b.name}</Typography>
              {b.description && <Typography variant="caption" color="text.secondary">{b.description}</Typography>}
            </Box>
          </MenuItem>
        ))}
        <Divider />
        <MenuItem value={ADD_BANK} sx={{ color: 'primary.main', fontWeight: 700 }}>+ Add bank account…</MenuItem>
      </TextField>
      <AddBankDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSave={async (details) => {
          try {
            const bank = await addBank(details);
            onBankAccountChange(bank.id);
            setAdding(false);
            notify(`Bank account "${bank.name}" added.`, 'success');
          } catch (err) {
            const d = err?.response?.data || {};
            notify(d.name || d.detail || 'Could not add the bank account.', 'error');
          }
        }}
      />
    </Box>
  );
}

function AddBankDialog({ open, onClose, onSave }) {
  const [form, setForm] = useState({ name: '', account_number: '', ifsc: '' });
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) setForm({ name: '', account_number: '', ifsc: '' }); }, [open]);
  const submit = async () => {
    if (!form.name.trim() || saving) return;
    setSaving(true);
    try { await onSave(form); } finally { setSaving(false); }
  };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth onClick={(e) => e.stopPropagation()}>
      <DialogTitle sx={{ fontWeight: 800 }}>Add Bank Account</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <TextField autoFocus required size="small" label="Bank name" placeholder="e.g. HDFC Bank – Current"
            value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }} />
          <TextField size="small" label="Account number (optional)"
            value={form.account_number} onChange={(e) => setForm({ ...form, account_number: e.target.value })} />
          <TextField size="small" label="IFSC (optional)"
            value={form.ifsc} onChange={(e) => setForm({ ...form, ifsc: e.target.value.toUpperCase() })} />
          <Typography variant="caption" color="text.secondary">
            Added to the Chart of Accounts under Bank Accounts, so its balance shows in the financial reports.
          </Typography>
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={submit} disabled={!form.name.trim() || saving}>Add Bank</Button>
      </DialogActions>
    </Dialog>
  );
}
