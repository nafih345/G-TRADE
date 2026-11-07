// "+ Add New Category" from Record Expense. A category is an Expense ledger in the Chart of
// Accounts: the server creates it under Indirect (default) or Direct Expenses, which is what
// puts it under that heading in the Profit & Loss. It gets its own Ledger / Trial Balance row.
import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, MenuItem, Stack, TextField,
} from '@mui/material';
import { apiError, finPost } from '../financial/financialApi';

export const EXPENSE_TYPES = [
  { value: 'INDIRECT', label: 'Indirect Expense (operating — rent, salaries, utilities, marketing)' },
  { value: 'DIRECT', label: 'Direct Expense (cost of sales — freight in, lab / fitting charges)' },
];

const blank = (name = '') => ({ name, expense_type: 'INDIRECT', description: '' });

export default function AddExpenseCategoryDialog({ open, initialName = '', onClose, onCreated, onExisting }) {
  const [form, setForm] = useState(blank);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [existingId, setExistingId] = useState('');
  const set = (patch) => setForm(prev => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open) return;
    setForm(blank(initialName));
    setError('');
    setExistingId('');
  }, [open, initialName]);

  const save = async () => {
    const name = form.name.trim();
    if (!name) { setError('Enter the category name.'); return; }
    setSaving(true);
    setError('');
    setExistingId('');
    try {
      const account = await finPost('accounts/expense-category/', { ...form, name, description: form.description.trim() });
      onCreated?.(account);
    } catch (e) {
      const data = e?.response?.data || {};
      setError(data.name || apiError(e, 'Could not create the category.'));
      setExistingId(data.existing_id || '');
    }
    setSaving(false);
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
      <DialogTitle sx={{ fontWeight: 800 }}>New Expense Category</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2} sx={{ py: 1 }}>
          {error && (
            <Alert severity="error" action={existingId && onExisting ? (
              <Button color="inherit" size="small" onClick={() => onExisting(existingId)}>Use it</Button>
            ) : undefined}>{error}</Alert>
          )}
          <TextField label="Category Name" required fullWidth autoFocus value={form.name}
            placeholder="e.g. Electricity Bill, Digital Marketing" inputProps={{ maxLength: 150 }}
            onChange={(e) => set({ name: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); } }} />
          <TextField select label="Expense Type" fullWidth value={form.expense_type}
            helperText="Decides where it appears in the Profit & Loss."
            onChange={(e) => set({ expense_type: e.target.value })}>
            {EXPENSE_TYPES.map(t => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
          </TextField>
          <TextField label="Description (optional)" fullWidth multiline minRows={2} value={form.description}
            onChange={(e) => set({ description: e.target.value })} />
        </Stack>
      </DialogContent>
      <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving} sx={{ fontWeight: 700, px: 3 }}>
          {saving ? 'Saving…' : 'Save Category'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
