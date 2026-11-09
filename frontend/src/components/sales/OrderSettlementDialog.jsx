import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  InputAdornment, Stack, TextField, Typography,
} from '@mui/material';
import { Payments as PaymentsIcon } from '@mui/icons-material';
import PaymentModeDetails from '../common/PaymentModeDetails';
import { needsBank } from '../../utils/paymentModes';

// Pay modes offered at delivery: `apiKey` is the balance_receipts key the server expects
// (InvoiceViewSet._balance_receipts), `label` the receipt's method.
export const SETTLE_MODES = [
  { apiKey: 'cash', label: 'Cash', caption: 'Cash' },
  { apiKey: 'upi', label: 'UPI', caption: 'GPay / UPI' },
  { apiKey: 'card', label: 'Card', caption: 'Card' },
  { apiKey: 'bank', label: 'Bank Transfer', caption: 'Bank Transfer' },
];

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const amt = (v) => Math.max(0, r2(parseFloat(v) || 0));
const money = (n) => `₹${r2(n).toFixed(2)}`;
const cleanAmount = (raw) => {
  const s = String(raw ?? '').replace(/[^\d.]/g, '');
  const dot = s.indexOf('.');
  return dot < 0 ? s : `${s.slice(0, dot + 1)}${s.slice(dot + 1).replace(/\./g, '').slice(0, 2)}`;
};
const EMPTY = { cash: '', upi: '', card: '', bank: '' };

/**
 * Sales > Orders → "Convert to Invoice": the order opens read-only in New Sale and this pop-up
 * collects the balance. Total = the order's net payable, Advance = what was taken at booking
 * (plus any receipts since), Balance = Total − Advance. The balance can be split across Cash /
 * GPay-UPI / Card / Bank Transfer; digital modes must name their bank. Cash may be tendered over
 * the balance (change is handed back and not recorded); other modes may not exceed it.
 *
 * onConfirm({ receipts, collected, change }) — receipts = { cash: {amount}, upi: {amount,
 * bank_account, reference}, … } for the modes actually used. The parent saves and closes.
 */
export default function OrderSettlementDialog({
  open, saving = false, orderNumber = '', customerName = '', total = 0, advance = 0, onConfirm, onClose,
}) {
  const balance = r2(Math.max(0, r2(total) - r2(advance)));
  const [amounts, setAmounts] = useState(EMPTY);
  const [banks, setBanks] = useState({});
  const [refs, setRefs] = useState({});
  const cashRef = useRef(null);

  // Every opening starts with the whole balance under Cash — the most common case is one tap.
  useEffect(() => {
    if (!open) return;
    setAmounts({ ...EMPTY, cash: balance > 0 ? balance.toFixed(2) : '' });
    setBanks({});
    setRefs({});
  }, [open, balance]);

  const figures = useMemo(() => {
    const entered = Object.fromEntries(SETTLE_MODES.map(m => [m.apiKey, amt(amounts[m.apiKey])]));
    const nonCash = r2(entered.upi + entered.card + entered.bank);
    const tendered = r2(nonCash + entered.cash);
    const change = r2(Math.max(0, tendered - balance));
    // Change comes out of cash; what's left is what the shop keeps against the bill.
    const keptCash = r2(Math.max(0, entered.cash - change));
    const collected = r2(nonCash + keptCash);
    return { entered, nonCash, tendered, change, keptCash, collected, remaining: r2(Math.max(0, balance - collected)) };
  }, [amounts, balance]);

  const errors = [];
  if (figures.nonCash > balance + 0.009) {
    errors.push(`GPay / Card / Bank add up to ${money(figures.nonCash)} — more than the balance ${money(balance)}.`);
  }
  const unbanked = SETTLE_MODES.find(m => needsBank(m.label) && figures.entered[m.apiKey] > 0 && !banks[m.apiKey]);
  if (unbanked) errors.push(`Select the bank account for the ${unbanked.caption} payment.`);
  const canConfirm = !saving && errors.length === 0;

  const confirm = () => {
    if (!canConfirm) return;
    const receipts = {};
    SETTLE_MODES.forEach(m => {
      const value = m.apiKey === 'cash' ? figures.keptCash : figures.entered[m.apiKey];
      if (value <= 0) return;
      receipts[m.apiKey] = needsBank(m.label)
        ? { amount: value, bank_account: banks[m.apiKey], reference: String(refs[m.apiKey] || '').trim() }
        : { amount: value };
    });
    onConfirm?.({ receipts, collected: figures.collected, change: figures.change });
  };

  // Enter confirms (except on a button, which acts on its own, or inside the bank picker list).
  const onKeyDown = (e) => {
    if (e.key !== 'Enter' || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return;
    const tag = (e.target?.tagName || '').toLowerCase();
    if (tag === 'button' || tag === 'textarea' || e.target?.closest?.('[role="listbox"],[role="menu"]')) return;
    e.preventDefault();
    confirm();
  };

  const Row = ({ label, value, strong, color }) => (
    <Stack direction="row" justifyContent="space-between" alignItems="baseline">
      <Typography variant={strong ? 'subtitle1' : 'body2'} fontWeight={strong ? 900 : 700} color={color || 'text.secondary'}>{label}</Typography>
      <Typography variant={strong ? 'h6' : 'body1'} fontWeight={900} color={color}>{value}</Typography>
    </Stack>
  );

  return (
    <Dialog
      open={open}
      onClose={saving ? undefined : onClose}
      maxWidth="sm" fullWidth
      onKeyDown={onKeyDown}
      // Keeps App.jsx's global Enter-moves-focus handler out of this dialog (Enter = confirm here).
      PaperProps={{ 'data-nav-scope': '' }}
      TransitionProps={{ onEntered: () => { cashRef.current?.focus(); cashRef.current?.select(); } }}
      aria-labelledby="order-settlement-title"
    >
      <DialogTitle id="order-settlement-title" sx={{ fontWeight: 900, display: 'flex', alignItems: 'center', gap: 1 }}>
        <PaymentsIcon color="success" /> Payment &amp; Delivery
        <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 'auto', fontWeight: 700 }}>
          {orderNumber}{customerName ? ` · ${customerName}` : ''}
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ p: 2, borderRadius: 2, bgcolor: 'action.hover', mb: 2 }}>
          <Stack spacing={0.75}>
            <Row label="Total Bill Amount" value={money(total)} />
            <Row label="Advance Paid" value={`− ${money(advance)}`} color="success.main" />
            <Divider />
            <Row label="Balance to Collect" value={money(balance)} strong color={balance > 0 ? 'error.main' : 'success.main'} />
          </Stack>
        </Box>

        {balance <= 0 ? (
          <Alert severity="success" sx={{ fontWeight: 700 }}>
            This order is fully paid. Confirm to bill it as a tax invoice and mark it delivered.
          </Alert>
        ) : (
          <>
            <Typography variant="subtitle2" fontWeight={900} sx={{ mb: 1 }}>Collect the balance by</Typography>
            <Stack spacing={1.25}>
              {SETTLE_MODES.map((m, i) => {
                const value = amounts[m.apiKey];
                return (
                  <Box key={m.apiKey}>
                    <TextField
                      size="small" fullWidth label={m.caption} value={value}
                      inputRef={i === 0 ? cashRef : undefined}
                      disabled={saving}
                      onChange={(e) => setAmounts(a => ({ ...a, [m.apiKey]: cleanAmount(e.target.value) }))}
                      onFocus={(e) => e.target.select()}
                      InputProps={{
                        startAdornment: <InputAdornment position="start">₹</InputAdornment>,
                        endAdornment: (
                          <InputAdornment position="end">
                            <Button
                              size="small" tabIndex={-1} disabled={saving}
                              // Put whatever is still unpaid into this mode.
                              onClick={() => setAmounts(a => {
                                const others = SETTLE_MODES.filter(o => o.apiKey !== m.apiKey)
                                  .reduce((s, o) => s + amt(a[o.apiKey]), 0);
                                const rest = r2(Math.max(0, balance - others));
                                return { ...a, [m.apiKey]: rest > 0 ? rest.toFixed(2) : '' };
                              })}
                              sx={{ textTransform: 'none', fontWeight: 800, minWidth: 0 }}
                            >
                              Rest
                            </Button>
                          </InputAdornment>
                        ),
                      }}
                      inputProps={{ inputMode: 'decimal', 'aria-label': `${m.caption} amount` }}
                    />
                    {needsBank(m.label) && amt(value) > 0 && (
                      <PaymentModeDetails
                        method={m.label}
                        bankAccount={banks[m.apiKey] || ''}
                        onBankAccountChange={(id) => setBanks(b => ({ ...b, [m.apiKey]: id }))}
                        reference={refs[m.apiKey] || ''}
                        onReferenceChange={(v) => setRefs(r => ({ ...r, [m.apiKey]: v }))}
                        required disabled={saving}
                        sx={{ mt: 1, pl: 1 }}
                      />
                    )}
                  </Box>
                );
              })}
            </Stack>

            <Stack spacing={0.5} sx={{ mt: 2 }}>
              <Row label="Collecting now" value={money(figures.collected)} />
              {figures.change > 0 && <Row label="Change to return (cash)" value={money(figures.change)} color="warning.main" />}
              <Row
                label={figures.remaining > 0 ? 'Still due after this (credit)' : 'Balance after this'}
                value={money(figures.remaining)}
                color={figures.remaining > 0 ? 'error.main' : 'success.main'}
              />
            </Stack>
          </>
        )}

        {errors.map(msg => <Alert key={msg} severity="error" sx={{ mt: 1.5 }}>{msg}</Alert>)}
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} disabled={saving} sx={{ textTransform: 'none', fontWeight: 800 }}>
          Cancel / Close
        </Button>
        <Button
          variant="contained" color="success" onClick={confirm} disabled={!canConfirm}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}
          sx={{ textTransform: 'none', fontWeight: 900 }}
        >
          {saving ? 'Saving…' : 'Confirm & Generate Invoice'} <Typography component="span" variant="caption" sx={{ ml: 1, opacity: 0.8 }}>Enter</Typography>
        </Button>
      </DialogActions>
    </Dialog>
  );
}
