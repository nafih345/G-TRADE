// Journal Voucher (JV) entry: a free multi-line double-entry voucher for non-cash adjustments
// (depreciation, provisions, write-offs, reclassifications, opening balances). Used by both
// Accounts → Journal Voucher and Financial → Vouchers → Journal Voucher.
//
// It posts through the same /financial/journals/ service as the Receipt / Payment / Contra
// vouchers (onSaveVoucher), so the server re-checks that debits equal credits, that the accounts
// are active and the period is open. A voucher is never "saved" unless it is on the books.
import React, { useMemo, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Card, Chip, Grid, IconButton, Paper, Stack, Table, TableBody, TableCell,
  TableContainer, TableFooter, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, CheckCircle as CheckIcon, Delete as DeleteIcon, Print as PrintIcon, Refresh as RefreshIcon,
  SwapHoriz as SwapIcon,
} from '@mui/icons-material';
import { newIdempotencyKey } from './financialApi';
import { formatMoney } from '../../utils/localeFormat';

const COLOR = '#7c3aed';
const today = () => new Date().toISOString().split('T')[0];
const num = (v) => parseFloat(v) || 0;
const round2 = (v) => Math.round(v * 100) / 100;
const blankLine = () => ({ id: Date.now() + Math.random(), account: null, debit: '', credit: '', memo: '' });
const blankHeader = () => ({ voucherNo: '', idempotencyKey: newIdempotencyKey(), date: today(), reference: '', narration: '', isSaved: false });
const isCashOrBank = (a) => !!a && (['CASH', 'BANK'].includes(a.account_subtype));

/** Rules the Save button and the server share: at least two lines, every amount on one side
 *  only, and debits equal to credits. Returns the first few problems for the user. */
export function journalProblems(lines) {
  const used = lines.filter(l => l.account || num(l.debit) || num(l.credit));
  const out = [];
  if (used.some(l => !l.account)) out.push('Pick an account on every line that has an amount.');
  if (used.some(l => l.account && !num(l.debit) && !num(l.credit))) out.push('Enter a debit or a credit on every line with an account.');
  if (used.some(l => num(l.debit) && num(l.credit))) out.push('A line takes either a debit or a credit, not both.');
  if (used.some(l => num(l.debit) < 0 || num(l.credit) < 0)) out.push('Amounts cannot be negative.');
  const valid = used.filter(l => l.account && (num(l.debit) > 0) !== (num(l.credit) > 0));
  if (!valid.some(l => num(l.debit) > 0) || !valid.some(l => num(l.credit) > 0)) {
    out.push('A journal needs at least one debit line and one credit line.');
  }
  const dr = round2(valid.reduce((t, l) => t + num(l.debit), 0));
  const cr = round2(valid.reduce((t, l) => t + num(l.credit), 0));
  if (Math.abs(dr - cr) > 0.004) out.push(`Debits (${formatMoney(dr)}) and credits (${formatMoney(cr)}) must be equal.`);
  return out;
}

export default function JournalVoucherForm({ accounts, showToast, onSaveVoucher }) {
  const [header, setHeader] = useState(blankHeader);
  const [lines, setLines] = useState(() => [blankLine(), blankLine()]);
  const [saving, setSaving] = useState(false);
  const locked = header.isSaved;

  const accountOptions = useMemo(
    () => (accounts || []).filter(a => a && a.status !== 'Inactive')
      .sort((a, b) => (a.account_type || '').localeCompare(b.account_type || '') || String(a.code).localeCompare(String(b.code), undefined, { numeric: true })),
    [accounts],
  );

  const totalDr = round2(lines.reduce((t, l) => t + num(l.debit), 0));
  const totalCr = round2(lines.reduce((t, l) => t + num(l.credit), 0));
  const difference = round2(totalDr - totalCr);
  const problems = useMemo(() => journalProblems(lines), [lines]);
  const isValid = problems.length === 0;
  const touchesCash = lines.some(l => isCashOrBank(l.account));

  const setLine = (id, patch) => setLines(ls => ls.map(l => (l.id === id ? { ...l, ...patch } : l)));
  // Typing on one side clears the other: a JV line is a debit or a credit, never both.
  const setAmount = (id, side, value) => setLine(id, side === 'debit' ? { debit: value, ...(value ? { credit: '' } : {}) } : { credit: value, ...(value ? { debit: '' } : {}) });
  const addLine = (prefill = {}) => setLines(ls => [...ls, { ...blankLine(), ...prefill }]);
  const removeLine = (id) => setLines(ls => (ls.length > 2 ? ls.filter(l => l.id !== id) : ls.map(l => (l.id === id ? blankLine() : l))));
  const swapSides = (id) => setLines(ls => ls.map(l => (l.id === id ? { ...l, debit: l.credit, credit: l.debit } : l)));

  // "Balance" fills a new line with whatever the voucher is short by, on the side it is short on.
  const balanceRemaining = () => {
    if (!difference) return;
    const amount = Math.abs(difference).toFixed(2);
    const side = difference > 0 ? { credit: amount } : { debit: amount };
    // Prefer a line that has its account but no amount yet, then a fully blank one.
    const noAmount = (l) => !num(l.debit) && !num(l.credit);
    const empty = lines.find(l => l.account && noAmount(l)) || lines.find(noAmount);
    if (empty) setLine(empty.id, side);
    else addLine(side);
  };

  const handleNew = () => {
    setHeader(blankHeader());
    setLines([blankLine(), blankLine()]);
  };

  const handleSave = async () => {
    if (saving || locked) return;
    if (!isValid) { showToast(problems[0], 'error'); return; }
    setSaving(true);
    try {
      const posted = lines
        .filter(l => l.account && (num(l.debit) > 0 || num(l.credit) > 0))
        .map(l => ({ account: l.account.id, debit: round2(num(l.debit)), credit: round2(num(l.credit)), memo: l.memo.trim() }));
      const saved = await onSaveVoucher({
        voucher_type_code: 'JV',
        date: header.date,
        narration: header.narration.trim() || 'Journal Voucher',
        reference_no: '',
        reference: header.reference.trim(),
        idempotency_key: header.idempotencyKey,
        lines: posted,
      });
      if (saved) setHeader(h => ({ ...h, isSaved: true, voucherNo: saved.entry_number }));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      e.preventDefault();
      handleSave();
    }
  };

  const cellInput = { '& .MuiInputBase-input': { py: 0.75 } };
  const moneyInput = (l, side) => (
    <TextField type="number" size="small" fullWidth value={l[side]} disabled={locked} placeholder="0.00"
      inputProps={{ min: 0, step: '0.01', style: { textAlign: 'right' }, 'aria-label': side === 'debit' ? 'Debit' : 'Credit' }}
      onChange={(e) => setAmount(l.id, side, e.target.value)} sx={cellInput} />
  );

  return (
    <Box onKeyDown={onKeyDown}>
      {/* Toolbar */}
      <Paper elevation={0} variant="outlined" sx={{ position: 'sticky', top: 0, zIndex: 100, p: 1.5, mb: 3, borderRadius: 3, bgcolor: '#fff', borderColor: '#e2e8f0', boxShadow: '0 2px 8px rgba(0,0,0,0.04)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Chip label="Journal Voucher (JV)" sx={{ backgroundColor: COLOR, color: '#fff', fontWeight: 850, fontSize: '0.875rem' }} />
          <Typography variant="subtitle2" color="text.secondary" fontWeight={700}>
            {locked ? `✅ Posted ${header.voucherNo}` : '📝 Unsaved Draft'}
          </Typography>
          <Tooltip title="Ctrl+S saves the voucher">
            <Chip size="small" variant="outlined" label="Ctrl+S Save" sx={{ fontWeight: 700 }} />
          </Tooltip>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
          <Button variant="outlined" size="small" startIcon={<AddIcon />} onClick={handleNew}>New</Button>
          <Button variant="contained" size="small" startIcon={<CheckIcon />} disabled={!isValid || saving || locked} onClick={handleSave}
            sx={{ backgroundColor: COLOR, fontWeight: 800, '&:hover': { backgroundColor: COLOR } }}>
            Save
          </Button>
          <Button variant="outlined" size="small" startIcon={<PrintIcon />} disabled={!locked} onClick={() => window.print()}>Print</Button>
          <Button variant="outlined" size="small" startIcon={<RefreshIcon />} onClick={() => { handleNew(); showToast('Form reset to fresh draft.', 'info'); }}>Refresh</Button>
        </Stack>
      </Paper>

      {/* Header */}
      <Card variant="outlined" sx={{ p: 3, mb: 3, borderRadius: 4 }}>
        <Typography variant="subtitle1" fontWeight={850} sx={{ mb: 2 }}>Voucher Header Information</Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={6} md={3}>
            <TextField fullWidth size="small" label="Voucher No (Auto)" value={header.voucherNo || 'Assigned when posted'} InputProps={{ readOnly: true }} sx={{ bgcolor: '#f8fafc' }} />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <TextField type="date" fullWidth size="small" label="Date *" value={header.date} disabled={locked}
              onChange={(e) => setHeader(h => ({ ...h, date: e.target.value }))} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={12} sm={6} md={6}>
            <TextField fullWidth size="small" label="Reference No" value={header.reference} disabled={locked}
              placeholder="Document / approval / working-paper no" inputProps={{ maxLength: 80 }}
              onChange={(e) => setHeader(h => ({ ...h, reference: e.target.value }))} />
          </Grid>
          <Grid item xs={12}>
            <TextField fullWidth size="small" label="Narration" value={header.narration} disabled={locked}
              placeholder="e.g. Depreciation on furniture for October"
              onChange={(e) => setHeader(h => ({ ...h, narration: e.target.value }))} />
          </Grid>
        </Grid>
      </Card>

      {/* Lines */}
      <Card variant="outlined" sx={{ borderRadius: 4, overflow: 'hidden', mb: 3 }}>
        <Box sx={{ p: 2, px: 3, bgcolor: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle1" fontWeight={850}>Journal Lines (Debit / Credit)</Typography>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" onClick={balanceRemaining} disabled={locked || !difference} sx={{ fontWeight: 700 }}>
              Balance {difference ? formatMoney(Math.abs(difference)) : ''}
            </Button>
            <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={() => addLine()} disabled={locked} sx={{ backgroundColor: '#2563eb', fontWeight: 700 }}>
              Add Line
            </Button>
          </Stack>
        </Box>
        <TableContainer>
          <Table size="small" sx={{ minWidth: 900 }}>
            <TableHead sx={{ bgcolor: '#f1f5f9' }}>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, width: 40 }}>#</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 300 }}>Ledger Account *</TableCell>
                <TableCell sx={{ fontWeight: 700, width: 150 }} align="right">Debit</TableCell>
                <TableCell sx={{ fontWeight: 700, width: 150 }} align="right">Credit</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 200 }}>Line Memo</TableCell>
                <TableCell sx={{ width: 84 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={l.id}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell>
                    <Autocomplete
                      size="small" options={accountOptions} value={l.account} disabled={locked}
                      groupBy={(a) => a.account_type || ''}
                      isOptionEqualToValue={(o, v) => o.id === v.id}
                      getOptionLabel={(a) => `${a.code} - ${a.name}`}
                      filterOptions={(opts, { inputValue }) => {
                        const q = inputValue.trim().toLowerCase();
                        return (q ? opts.filter(a => `${a.code} ${a.name} ${a.account_group}`.toLowerCase().includes(q)) : opts).slice(0, 200);
                      }}
                      onChange={(e, v) => setLine(l.id, { account: v })}
                      renderOption={(props, a) => (
                        <li {...props} key={a.id}>
                          <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 2 }}>
                            <span><b style={{ fontFamily: 'monospace' }}>{a.code}</b> {a.name}
                              {a.account_group ? <Typography component="span" variant="caption" color="text.secondary"> · {a.account_group}</Typography> : null}</span>
                            <Typography component="span" variant="caption" color="text.secondary">{formatMoney(a.current_balance || 0)}</Typography>
                          </Box>
                        </li>
                      )}
                      renderInput={(p) => <TextField {...p} placeholder="Search code or name…" sx={cellInput} />}
                    />
                    {l.account && (
                      <Typography variant="caption" color="text.secondary">
                        {[l.account.account_type, l.account.account_group].filter(Boolean).join(' · ')} · Balance {formatMoney(l.account.current_balance || 0)}
                      </Typography>
                    )}
                  </TableCell>
                  <TableCell>{moneyInput(l, 'debit')}</TableCell>
                  <TableCell>{moneyInput(l, 'credit')}</TableCell>
                  <TableCell>
                    <TextField size="small" fullWidth value={l.memo} disabled={locked} placeholder="Optional"
                      onChange={(e) => setLine(l.id, { memo: e.target.value })} sx={cellInput} />
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title="Swap debit / credit">
                      <span><IconButton size="small" disabled={locked || (!l.debit && !l.credit)} onClick={() => swapSides(l.id)}><SwapIcon fontSize="small" /></IconButton></span>
                    </Tooltip>
                    <Tooltip title={lines.length > 2 ? 'Remove line' : 'Clear line'}>
                      <span><IconButton size="small" color="error" disabled={locked} onClick={() => removeLine(l.id)}><DeleteIcon fontSize="small" /></IconButton></span>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow sx={{ '& td': { fontWeight: 850, fontSize: 14, color: '#0f172a', borderTop: '2px solid #cbd5e1' } }}>
                <TableCell />
                <TableCell align="right">Total</TableCell>
                <TableCell align="right">{formatMoney(totalDr)}</TableCell>
                <TableCell align="right">{formatMoney(totalCr)}</TableCell>
                <TableCell colSpan={2}>
                  {difference
                    ? <Chip size="small" color="error" label={`Difference ${formatMoney(Math.abs(difference))} ${difference > 0 ? '(more debit)' : '(more credit)'}`} sx={{ fontWeight: 700 }} />
                    : totalDr > 0 ? <Chip size="small" color="success" label="Balanced" sx={{ fontWeight: 700 }} /> : null}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </TableContainer>
      </Card>

      {touchesCash && !locked && (
        <Alert severity="info" sx={{ mb: 2 }}>
          This journal uses a Cash or Bank account. Money received, paid or moved between cash and bank is usually entered as a Receipt, Payment or Contra voucher so it appears with its pay mode in the Cashbook and Bank Book.
        </Alert>
      )}
      {!locked && !isValid && (lines.some(l => l.account || l.debit || l.credit)) && (
        <Alert severity="warning">{problems[0]}</Alert>
      )}
    </Box>
  );
}
