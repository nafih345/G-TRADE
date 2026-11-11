// Record Expense (Accounts → Expenses): posts a real Payment Voucher on the books —
//   Dr <expense ledger>  /  Cr Cash  or  Cr the bank it was paid from.
// UPI / Bank Transfer / Card / Cheque must name the "Paid From" bank ledger (Bank Master), so the
// Bank Book, Transaction Report and statements show the deduction against that exact bank.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Divider, Grid, MenuItem, Stack, TextField,
} from '@mui/material';
import AddExpenseCategoryDialog from './AddExpenseCategoryDialog';
import QuickDatePickerField from '../common/QuickDatePickerField';
import PaymentModeDetails from '../common/PaymentModeDetails';
import useBankAccounts from '../../hooks/useBankAccounts';
import { apiError, finGet, finPost, newIdempotencyKey } from '../financial/financialApi';
import { needsBank } from '../../utils/paymentModes';
import { getCurrencySymbol } from '../../utils/localeFormat.js';

export const EXPENSE_PAY_MODES = [
  { value: 'Cash', label: 'Cash', refLabel: '' },
  { value: 'UPI', label: 'UPI / QR Code', refLabel: 'UPI Reference / UTR No.' },
  { value: 'Bank Transfer', label: 'Bank Transfer (NEFT / RTGS / IMPS)', refLabel: 'UTR Number' },
  { value: 'Card', label: 'Credit / Debit Card', refLabel: 'Card Approval / Ref No.' },
  { value: 'Cheque', label: 'Cheque', refLabel: 'Cheque Number' },
];

const ADD_CATEGORY = '__add_category__';
const isDirectGroup = (a) => /direct/i.test(a.account_group_name || '') && !/indirect/i.test(a.account_group_name || '');

const today = () => new Date().toISOString().split('T')[0];
const blank = () => ({
  description: '', account: '', amount: '', method: 'Cash', bankAccount: '', reference: '', date: today(),
  idempotencyKey: newIdempotencyKey(),
});

export default function RecordExpenseDialog({ open, onClose, onSaved }) {
  const [form, setForm] = useState(blank);
  const [accounts, setAccounts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [tried, setTried] = useState(false);
  const [addOpen, setAddOpen] = useState(false);
  const { banks } = useBankAccounts();
  const set = (patch) => setForm(prev => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open) return;
    setForm(blank());
    setError('');
    setTried(false);
    setAddOpen(false);
    finGet('accounts/').then(rows => setAccounts(Array.isArray(rows) ? rows : (rows.results || [])))
      .catch(e => setError(apiError(e, 'Could not load the expense ledgers.')));
  }, [open]);

  const expenseAccounts = useMemo(() => accounts
    .filter(a => a.account_type === 'Expense' && a.status !== 'Inactive' && !a.is_deleted)
    .sort((a, b) => String(a.code).localeCompare(String(b.code))), [accounts]);
  const cashAccount = useMemo(() => accounts.find(a => a.account_subtype === 'CASH' && a.code === '1001')
    || accounts.find(a => a.account_subtype === 'CASH' && a.status !== 'Inactive') || null, [accounts]);

  const mode = EXPENSE_PAY_MODES.find(m => m.value === form.method) || EXPENSE_PAY_MODES[0];
  const bankMode = needsBank(form.method);
  const amount = Math.round((parseFloat(form.amount) || 0) * 100) / 100;
  const bank = banks.find(b => b.id === form.bankAccount);

  const problems = [];
  if (!form.description.trim()) problems.push('Enter the expense description.');
  if (!form.account) problems.push('Choose the expense category (ledger).');
  if (!(amount > 0)) problems.push('Enter an amount greater than zero.');
  if (bankMode && !form.bankAccount) problems.push(`Select the bank account the ${mode.label} payment was paid from.`);
  if (!bankMode && !cashAccount) problems.push('No Cash account is set up in the Chart of Accounts.');

  const onCategoryCreated = (account) => {
    // Keep the rest of the form as typed; just add the new ledger and select it.
    setAccounts(prev => [...prev.filter(a => a.id !== account.id), account]);
    set({ account: account.id });
    setAddOpen(false);
    setError('');
  };

  const selectExisting = (id) => {
    set({ account: id });
    setAddOpen(false);
    setError('');
  };

  const save = async () => {
    setTried(true);
    if (problems.length) { setError(problems[0]); return; }
    setSaving(true);
    setError('');
    const ref = form.reference.trim();
    const description = form.description.trim();
    const account = expenseAccounts.find(a => a.id === form.account);
    try {
      const entry = await finPost('journals/', {
        voucher_type_code: 'PV',
        date: form.date,
        narration: `Expense — ${description}${account ? ` (${account.name})` : ''}`,
        reference_no: description,
        reference: ref,
        idempotency_key: form.idempotencyKey,
        lines: [
          { account: form.account, debit: amount, credit: 0, memo: description },
          {
            account: bankMode ? form.bankAccount : cashAccount.id,
            debit: 0, credit: amount,
            // The pay-mode word leads the memo: Day Book / Bank Book / Expense Report read the mode from it.
            memo: `${form.method}${ref ? ` ${ref}` : ''}`,
            ...(form.method === 'Cheque' && ref ? {
              cheque: {
                cheque_number: ref, cheque_date: form.date, bank_name: bank ? (bank.bank_name || bank.name) : '',
                bank_branch: '', deposited_date: null, party_name: description, remarks: '',
              },
            } : {}),
          },
        ],
      });
      onSaved?.(entry);
      onClose();
    } catch (e) {
      setError(apiError(e, 'Could not post the expense.'));
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
      <DialogTitle sx={{ fontWeight: 800 }}>Record Expense</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ py: 1 }}>
          {error && <Alert severity="error">{error}</Alert>}
          <TextField select label="Category (Expense Ledger)" fullWidth required value={form.account}
            error={tried && !form.account}
            onChange={(e) => (e.target.value === ADD_CATEGORY ? setAddOpen(true) : set({ account: e.target.value }))}
            helperText={expenseAccounts.length ? '' : 'No active Expense ledgers yet. Use "+ Add New Category".'}>
            <MenuItem value={ADD_CATEGORY} sx={{ fontWeight: 700, color: 'primary.main' }}>+ Add New Category</MenuItem>
            <Divider />
            {expenseAccounts.map(a => (
              <MenuItem key={a.id} value={a.id}>
                {a.code} — {a.name}{isDirectGroup(a) ? ' (Direct)' : ''}
              </MenuItem>
            ))}
          </TextField>
          <TextField label="Description" fullWidth required value={form.description}
            error={tried && !form.description.trim()} onChange={(e) => set({ description: e.target.value })} />
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField label={`Amount (${getCurrencySymbol()})`} type="number" fullWidth required value={form.amount}
                error={tried && !(amount > 0)} inputProps={{ min: 0, step: '0.01' }}
                onChange={(e) => set({ amount: e.target.value })} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select label="Payment Method" fullWidth value={form.method}
                onChange={(e) => set({ method: e.target.value, bankAccount: '', reference: '' })}>
                {EXPENSE_PAY_MODES.map(m => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
              </TextField>
            </Grid>
          </Grid>
          {bankMode && (
            <>
              <PaymentModeDetails
                method={form.method} required label="Paid From (Bank Account) *" bankAccount={form.bankAccount}
                onBankAccountChange={(id) => set({ bankAccount: id || '' })}
              />
              <TextField label={`${mode.refLabel} (optional)`} fullWidth value={form.reference}
                inputProps={{ maxLength: 40 }} onChange={(e) => set({ reference: e.target.value })} />
            </>
          )}
          <QuickDatePickerField
            label="Date" fullWidth value={form.date} onChange={(d) => set({ date: d })}
            quickPresets={[
              { label: 'Today', type: 'today' },
              { label: 'Yesterday', type: 'yesterday' },
              { label: '-7 Days', type: 'days', amount: -7 },
            ]}
          />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving} sx={{ fontWeight: 700, px: 3 }}>
          {saving ? 'Posting…' : 'Post Expense'}
        </Button>
      </DialogActions>
      <AddExpenseCategoryDialog
        open={addOpen} onClose={() => setAddOpen(false)}
        onCreated={onCategoryCreated} onExisting={selectExisting}
      />
    </Dialog>
  );
}
