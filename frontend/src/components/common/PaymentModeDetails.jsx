import React, { useEffect, useState } from 'react';
import {
  Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, List, ListItemButton,
  ListItemText, Stack, TextField, ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import { AccountBalance as BankIcon, Check as CheckIcon, Edit as EditIcon } from '@mui/icons-material';
import useBankAccounts from '../../hooks/useBankAccounts';
import { notify } from '../../utils/notify';
import { CASH_PAID, CASH_UNPAID, isCashMode, paymentKind } from '../../utils/paymentModes';

/**
 * The extra details a pay mode needs, the same on every screen:
 *   CASH -> Paid / Unpaid toggle (only when the screen passes onCashStatusChange)
 *   BANK -> which bank the money went to / came from
 *   UPI  -> the bank linked to the UPI ID
 * Renders nothing for Card / Credit / anything else. Bank / UPI show the chosen bank (the
 * Bank Master default unless changed) with an "Add / Change Bank Account" button.
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
  const [picking, setPicking] = useState(false);
  const [adding, setAdding] = useState(false);
  const wantsBank = (kind === 'bank' || kind === 'upi') && !!onBankAccountChange;
  const defaultBank = defaultBankFor(banks, kind);

  // Choosing Bank (or UPI) pre-selects the default bank from Settings > Bank Master; the full
  // list only opens from "Add / Change Bank Account". A blank bank posts to this same ledger.
  useEffect(() => {
    if (wantsBank && !disabled && !bankAccount && defaultBank) onBankAccountChange(defaultBank.id);
  }, [wantsBank, disabled, bankAccount, defaultBank, onBankAccountChange]);

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
  const current = banks.find((b) => b.id === bankAccount) || (!bankAccount ? defaultBank : null);
  const isDefault = !!current && current.id === defaultBank?.id;
  const emptyText = loading ? 'Loading banks…' : (bankAccount ? 'Bank no longer active' : 'No bank in Bank Master');
  const openPicker = () => { if (!disabled) setPicking(true); };

  return (
    <Box sx={sx}>
      {compact ? (
        <Stack direction="row" alignItems="center" spacing={0.25}>
          <Typography noWrap title={current ? `${current.name}${isDefault ? ' (default)' : ''}` : emptyText}
            sx={{ flex: 1, minWidth: 0, fontSize: '0.68rem', fontWeight: 700, opacity: current ? 1 : 0.6 }}>
            {current ? current.name : emptyText}
          </Typography>
          <Tooltip title="Add / Change Bank Account">
            <span>
              <IconButton size="small" onClick={openPicker} disabled={disabled} aria-label={`Change ${label}`} sx={{ p: 0.25 }}>
                <EditIcon sx={{ fontSize: 14 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>
      ) : (
        <Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 0.25 }}>{label}</Typography>
          <Stack direction="row" alignItems="center" spacing={1}
            sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 1, px: 1.25, py: size === 'small' ? 0.5 : 1, opacity: disabled ? 0.6 : 1 }}>
            <BankIcon fontSize="small" color={current ? 'primary' : 'disabled'} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Stack direction="row" alignItems="center" spacing={0.75}>
                <Typography variant="body2" fontWeight={700} noWrap sx={{ opacity: current ? 1 : 0.6 }}>
                  {current ? current.name : emptyText}
                </Typography>
                {isDefault && <Chip size="small" label="Default" color="warning" sx={{ height: 18, fontSize: '0.62rem', fontWeight: 800 }} />}
              </Stack>
              {current?.description && <Typography variant="caption" color="text.secondary" noWrap component="div">{current.description}</Typography>}
            </Box>
            <Button size="small" onClick={openPicker} disabled={disabled} sx={{ textTransform: 'none', fontWeight: 800, whiteSpace: 'nowrap' }}>
              Add / Change Bank Account
            </Button>
          </Stack>
        </Box>
      )}
      <BankPickerDialog
        open={picking}
        title={kind === 'upi' ? 'Select Linked Bank (UPI)' : 'Select Bank Account'}
        banks={banks}
        selectedId={current?.id || ''}
        defaultId={defaultBank?.id || ''}
        onClose={() => setPicking(false)}
        onPick={(id) => { onBankAccountChange(id); setPicking(false); }}
        onAdd={() => setAdding(true)}
      />
      <AddBankDialog
        open={adding}
        onClose={() => setAdding(false)}
        onSave={async (details) => {
          try {
            const bank = await addBank(details);
            onBankAccountChange(bank.id);
            setAdding(false);
            setPicking(false);
            notify(`Bank account "${bank.name}" added.`, 'success');
          } catch (err) {
            const d = err?.response?.data || {};
            notify(d.name || d.account_name || d.detail || 'Could not add the bank account.', 'error');
          }
        }}
      />
    </Box>
  );
}

// UPI prefers the bank mapped for UPI settlements, then the default bank; Bank uses the default.
// With a single bank on the books that one is the default either way.
export function defaultBankFor(banks, kind) {
  return (kind === 'upi' && banks.find((b) => b.is_default_upi))
    || banks.find((b) => b.is_default_bank)
    || (banks.length === 1 ? banks[0] : null);
}

function BankPickerDialog({ open, title, banks, selectedId, defaultId, onClose, onPick, onAdd }) {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth onClick={(e) => e.stopPropagation()}>
      <DialogTitle sx={{ fontWeight: 800 }}>{title}</DialogTitle>
      <DialogContent dividers sx={{ p: 0 }}>
        <List dense disablePadding>
          {banks.map((b, i) => (
            <ListItemButton key={b.id} selected={b.id === selectedId} autoFocus={b.id === selectedId || (!selectedId && i === 0)}
              onClick={() => onPick(b.id)}>
              <ListItemText
                primary={(
                  <Stack direction="row" alignItems="center" spacing={0.75} component="span">
                    <Typography variant="body2" fontWeight={700} component="span">{b.name}</Typography>
                    {b.id === defaultId && <Chip size="small" label="Default" color="warning" sx={{ height: 18, fontSize: '0.62rem', fontWeight: 800 }} />}
                  </Stack>
                )}
                secondary={b.description || null}
              />
              {b.id === selectedId && <CheckIcon fontSize="small" color="primary" />}
            </ListItemButton>
          ))}
          {banks.length === 0 && (
            <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No banks yet — add one below.</Typography>
          )}
        </List>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Button onClick={onAdd} sx={{ fontWeight: 800 }}>+ Add bank account…</Button>
        <Button onClick={onClose}>Cancel</Button>
      </DialogActions>
    </Dialog>
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
