import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert, Autocomplete, Box, Button, Card, Checkbox, Chip, CircularProgress, Divider, IconButton, InputAdornment,
  MenuItem, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField, ToggleButton,
  ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, AssignmentReturn as ReturnIcon, Delete as DeleteIcon, Search as SearchIcon,
  Visibility as ViewIcon,
} from '@mui/icons-material';
import PaymentModeDetails from '../common/PaymentModeDetails';
import { apiErrorMessage } from '../../utils/apiError';
import { notify } from '../../utils/notify';
import ReturnDetailDialog from './ReturnDetailDialog';
import {
  RETURN_KINDS, RETURN_REASONS, SETTLEMENT_MODES, createReturn, fetchReturnList, fetchReturnable, fmtDate,
  fmtMoney, modeMeta, reasonNeedsNote, round2, searchSourceDocuments, toNum, todayIso,
} from './returnsApi';
import { effectiveTaxPercent, getTaxLabel, isTaxEnabled } from '../../utils/localeFormat.js';

const newToken = () => `ret-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const blankSettlement = (amount = '') => ({ mode: 'CASH', amount, bank_account: '', reference: '' });

/**
 * Sales → Sales Return and Purchase → Purchase Return (kind = 'sales' | 'purchase').
 *
 * New Return: look up the original bill (or return products without one), tick the lines going
 * back with their quantity and a reason, and say how the value is settled — Cash, GPay / UPI or
 * Bank (pick the bank), Credit (ledger adjustment) or a split of them. The server moves the stock
 * and posts the accounts in the same save. Register: every return, click one for the full detail.
 */
export default function ReturnEntryView({ kind = 'sales' }) {
  const cfg = RETURN_KINDS[kind];
  const [tab, setTab] = useState('new');
  const [registerKey, setRegisterKey] = useState(0);
  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 2 }}>
        <ReturnIcon sx={{ color: 'error.main', fontSize: 32 }} />
        <Box>
          <Typography variant="h5" fontWeight={800}>{cfg.title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {kind === 'sales'
              ? 'Customer returns: the goods come back into stock, the refund is booked to Cash / the chosen bank or left as a credit note.'
              : 'Goods sent back to a supplier: stock goes out, the refund comes into Cash / the chosen bank or is set off against what you owe.'}
          </Typography>
        </Box>
      </Stack>
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2, borderBottom: 1, borderColor: 'divider' }}>
        <Tab value="new" label={`New ${cfg.title}`} sx={{ fontWeight: 700 }} />
        <Tab value="register" label={`${cfg.title} Register`} sx={{ fontWeight: 700 }} />
      </Tabs>
      {tab === 'new'
        ? <ReturnForm kind={kind} onSaved={() => setRegisterKey((k) => k + 1)} />
        : <ReturnRegister key={registerKey} kind={kind} />}
    </Box>
  );
}

// ---------------------------------------------------------------------------------------------
function ReturnForm({ kind, onSaved }) {
  const cfg = RETURN_KINDS[kind];
  const [mode, setMode] = useState('bill');             // 'bill' | 'manual'
  const [docQuery, setDocQuery] = useState('');
  const [docOptions, setDocOptions] = useState([]);
  const [docLoading, setDocLoading] = useState(false);
  const [doc, setDoc] = useState(null);
  const [lines, setLines] = useState([]);
  const [linesLoading, setLinesLoading] = useState(false);
  const [party, setParty] = useState({ id: '', name: '', phone: '' });
  const [suppliers, setSuppliers] = useState([]);
  const [returnDate, setReturnDate] = useState(todayIso());
  const [remarks, setRemarks] = useState('');
  const [bulkReason, setBulkReason] = useState('');
  const [settlements, setSettlements] = useState([blankSettlement()]);
  const [saving, setSaving] = useState(false);
  const [lastSaved, setLastSaved] = useState(null);
  const [errors, setErrors] = useState([]);
  const tokenRef = useRef(newToken());

  useEffect(() => {
    if (kind !== 'purchase') return;
    axios.get('/api/purchase/suppliers/').then((r) => setSuppliers(Array.isArray(r.data) ? r.data : (r.data?.results || [])))
      .catch(() => setSuppliers([]));
  }, [kind]);

  // Bill search (debounced).
  useEffect(() => {
    if (mode !== 'bill') return undefined;
    let alive = true;
    setDocLoading(true);
    const t = setTimeout(() => {
      searchSourceDocuments(kind, docQuery.trim())
        .then((rows) => { if (alive) setDocOptions(rows); })
        .catch(() => { if (alive) setDocOptions([]); })
        .finally(() => { if (alive) setDocLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [docQuery, mode, kind]);

  const pickDocument = async (d) => {
    setDoc(d);
    setLines([]);
    setErrors([]);
    if (!d) return;
    setLinesLoading(true);
    try {
      const data = await fetchReturnable(kind, d.id);
      setLines((data.lines || []).map((l) => ({
        ...l, key: l.original_item, selected: false, qty: l.returnable_qty > 0 ? 1 : 0,
        unit_price: l.unit_price, reason: '', notes: '',
      })));
      setParty({ id: d.party_id || '', name: d.party_name || '', phone: d.party_phone || '' });
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not load the bill\'s items.'), 'error');
    } finally {
      setLinesLoading(false);
    }
  };

  const switchMode = (m) => {
    if (!m || m === mode) return;
    setMode(m);
    setDoc(null);
    setLines([]);
    setErrors([]);
    setParty({ id: '', name: '', phone: '' });
  };

  const updateLine = (key, patch) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const removeLine = (key) => setLines((ls) => ls.filter((l) => l.key !== key));

  const addManualProduct = (p) => {
    if (!p) return;
    setLines((ls) => {
      if (ls.some((l) => l.product === p.id)) {
        notify(`${p.name} is already in the list — change its quantity instead.`, 'info');
        return ls;
      }
      return [...ls, {
        key: `${p.id}-${Date.now()}`, product: p.id, description: p.name, sku: p.sku || '', barcode: p.barcode || '',
        selected: true, qty: 1, returnable_qty: null,
        unit_price: String(kind === 'sales' ? (p.retail_price ?? p.selling_price ?? '') : (p.cost_price ?? '')),
        tax_rate: String(effectiveTaxPercent(p.tax_rate ?? p.tax_percentage ?? 0)), reason: bulkReason, notes: '',
      }];
    });
  };

  const chosen = lines.filter((l) => l.selected && toNum(l.qty) > 0);
  const total = round2(chosen.reduce((s, l) => s + toNum(l.qty) * toNum(l.unit_price), 0));
  const settled = round2(settlements.reduce((s, x) => s + toNum(x.amount), 0));
  const balance = round2(total - settled);

  // One settlement row follows the return value until the user splits it.
  useEffect(() => {
    setSettlements((ss) => (ss.length === 1 ? [{ ...ss[0], amount: total ? total.toFixed(2) : '' }] : ss));
  }, [total]);

  const applyBulkReason = (v) => {
    setBulkReason(v);
    if (v) setLines((ls) => ls.map((l) => (l.selected ? { ...l, reason: v } : l)));
  };

  const setSettlement = (i, patch) => setSettlements((ss) => ss.map((s, n) => (n === i ? { ...s, ...patch } : s)));
  const addSplit = () => setSettlements((ss) => [...ss, blankSettlement(balance > 0 ? balance.toFixed(2) : '')]);
  const removeSplit = (i) => setSettlements((ss) => (ss.length > 1 ? ss.filter((_, n) => n !== i) : ss));

  const reset = () => {
    setDoc(null); setDocQuery(''); setLines([]); setRemarks(''); setBulkReason('');
    setSettlements([blankSettlement()]); setErrors([]); setReturnDate(todayIso());
    setParty({ id: '', name: '', phone: '' });
    tokenRef.current = newToken();
  };

  const validate = () => {
    const errs = [];
    if (mode === 'bill' && !doc) errs.push(`Search and pick the original ${cfg.original.toLowerCase()}.`);
    if (kind === 'purchase' && mode === 'manual' && !party.id) errs.push('Choose the supplier.');
    if (!chosen.length) errs.push('Tick at least one product and enter its return quantity.');
    chosen.forEach((l) => {
      if (l.returnable_qty != null && toNum(l.qty) > l.returnable_qty) errs.push(`${l.description}: only ${l.returnable_qty} can be returned.`);
      if (!Number.isInteger(toNum(l.qty))) errs.push(`${l.description}: the quantity must be a whole number.`);
      if (!l.reason) errs.push(`${l.description}: choose the return reason.`);
      else if (reasonNeedsNote(l.reason) && !l.notes.trim()) errs.push(`${l.description}: describe the issue.`);
    });
    if (total <= 0) errs.push('The return value is zero.');
    settlements.forEach((s) => {
      if (toNum(s.amount) > 0 && modeMeta(s.mode).needsBank && !s.bank_account) errs.push(`${modeMeta(s.mode).label}: select the bank account.`);
    });
    if (Math.abs(balance) >= 0.01) errs.push(`The settlement (${fmtMoney(settled)}) must equal the return value (${fmtMoney(total)}).`);
    return errs;
  };

  const save = async () => {
    const errs = validate();
    setErrors(errs);
    if (errs.length) return;
    setSaving(true);
    try {
      const body = {
        client_token: tokenRef.current,
        return_date: returnDate,
        original_document: mode === 'bill' ? doc.id : null,
        general_remarks: remarks,
        items: chosen.map((l) => ({
          original_item: l.original_item || null, product: l.product, return_qty: toNum(l.qty),
          unit_price: l.unit_price, tax_rate: l.tax_rate, return_reason_category: l.reason, reason_notes: l.notes,
        })),
        settlements: settlements.filter((s) => toNum(s.amount) > 0).map((s) => ({
          mode: s.mode, amount: round2(s.amount).toFixed(2), bank_account: modeMeta(s.mode).needsBank ? s.bank_account : null,
          reference: s.reference,
        })),
      };
      if (kind === 'sales' && mode === 'manual') {
        body.customer_name = party.name;
        body.customer_phone = party.phone;
      }
      if (kind === 'purchase' && mode === 'manual') body.supplier = party.id;
      const saved = await createReturn(kind, body);
      setLastSaved(saved);
      const failed = saved.accounting?.failed?.length;
      notify(`${cfg.title} ${saved.return_number} saved — ${fmtMoney(saved.total_amount)}.${failed ? ' The accounting entry did not post — see Financial → Accounting Integration.' : ''}`,
        failed ? 'warning' : 'success');
      try { window.dispatchEvent(new Event('optical_stock_updated')); } catch { /* ignore */ }
      reset();
      onSaved?.(saved);
    } catch (e) {
      const list = e?.response?.data?.errors;
      setErrors(Array.isArray(list) && list.length ? list : [apiErrorMessage(e, 'The return was not saved.')]);
    } finally {
      setSaving(false);
    }
  };

  const allSelected = lines.length > 0 && lines.every((l) => l.selected || l.returnable_qty === 0);

  return (
    <Stack spacing={2}>
      {lastSaved && (
        <Alert severity="success" onClose={() => setLastSaved(null)}>
          {cfg.title} <b>{lastSaved.return_number}</b> saved: {lastSaved.total_qty} unit(s), {fmtMoney(lastSaved.total_amount)} — {lastSaved.settlement_text}. {cfg.stockText}
        </Alert>
      )}

      <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems={{ md: 'center' }}>
          <ToggleButtonGroup exclusive size="small" value={mode} onChange={(_, v) => switchMode(v)}
            sx={{ '& .MuiToggleButton-root': { textTransform: 'none', fontWeight: 700 } }}>
            <ToggleButton value="bill">Against {cfg.original}</ToggleButton>
            <ToggleButton value="manual">Manual (select products)</ToggleButton>
          </ToggleButtonGroup>
          <TextField size="small" type="date" label="Return date" value={returnDate} InputLabelProps={{ shrink: true }}
            inputProps={{ max: todayIso() }} onChange={(e) => setReturnDate(e.target.value)} sx={{ width: 170 }} />
        </Stack>

        <Box sx={{ mt: 2 }}>
          {mode === 'bill' ? (
            <Autocomplete
              options={docOptions} value={doc} loading={docLoading} filterOptions={(x) => x}
              onChange={(_, v) => pickDocument(v)} inputValue={docQuery} onInputChange={(_, v) => setDocQuery(v)}
              getOptionLabel={(o) => (o ? `${o.number} — ${o.party_name || ''}` : '')}
              isOptionEqualToValue={(a, b) => a.id === b.id}
              renderOption={(props, o) => (
                <li {...props} key={o.id}>
                  <Box sx={{ width: '100%' }}>
                    <Stack direction="row" justifyContent="space-between">
                      <Typography variant="body2" fontWeight={800}>{o.number}</Typography>
                      <Typography variant="body2">{fmtMoney(o.total)}</Typography>
                    </Stack>
                    <Typography variant="caption" color="text.secondary">
                      {fmtDate(o.date)} · {o.party_name || '—'}{o.party_phone ? ` · ${o.party_phone}` : ''}
                      {o.supplier_invoice_number ? ` · Supplier bill ${o.supplier_invoice_number}` : ''}
                    </Typography>
                  </Box>
                </li>
              )}
              renderInput={(params) => (
                <TextField {...params} size="small" autoFocus
                  label={`Search ${cfg.original} — number, ${kind === 'sales' ? 'customer name or phone' : 'supplier or supplier bill no.'}`}
                  InputProps={{ ...params.InputProps, startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment>,
                    endAdornment: <>{docLoading ? <CircularProgress size={16} /> : null}{params.InputProps.endAdornment}</> }} />
              )}
              noOptionsText={docQuery ? 'No matching bills' : 'Type to search'}
            />
          ) : (
            <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
              {kind === 'sales' ? (
                <>
                  <TextField size="small" label="Customer name" value={party.name} onChange={(e) => setParty((p) => ({ ...p, name: e.target.value }))} sx={{ flex: 1 }} />
                  <TextField size="small" label="Phone" value={party.phone} onChange={(e) => setParty((p) => ({ ...p, phone: e.target.value }))} sx={{ width: { md: 200 } }} />
                </>
              ) : (
                <Autocomplete sx={{ flex: 1 }} options={suppliers} getOptionLabel={(s) => s?.name || ''}
                  value={suppliers.find((s) => s.id === party.id) || null}
                  onChange={(_, s) => setParty({ id: s?.id || '', name: s?.name || '', phone: s?.phone || '' })}
                  renderInput={(params) => <TextField {...params} size="small" label="Supplier *" />} />
              )}
              <ProductPicker onPick={addManualProduct} />
            </Stack>
          )}
        </Box>
        {doc && (
          <Typography variant="body2" sx={{ mt: 1.5 }}>
            <b>{doc.number}</b> · {fmtDate(doc.date)} · {cfg.party}: <b>{doc.party_name || '—'}</b>{doc.party_phone ? ` (${doc.party_phone})` : ''} · Bill total {fmtMoney(doc.total)}
          </Typography>
        )}
      </Card>

      <Card variant="outlined" sx={{ borderRadius: 3 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }} justifyContent="space-between" sx={{ p: 1.5 }}>
          <Typography variant="subtitle1" fontWeight={800}>Products being returned</Typography>
          <TextField select size="small" label="Reason for all ticked lines" value={bulkReason} onChange={(e) => applyBulkReason(e.target.value)} sx={{ minWidth: 260 }}>
            <MenuItem value=""><em>— set per line —</em></MenuItem>
            {RETURN_REASONS.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
          </TextField>
        </Stack>
        <Divider />
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 900 }}>
            <TableHead>
              <TableRow>
                <TableCell padding="checkbox">
                  {mode === 'bill' && lines.length > 0 && (
                    <Checkbox size="small" checked={allSelected}
                      onChange={(e) => setLines((ls) => ls.map((l) => ({ ...l, selected: e.target.checked && l.returnable_qty !== 0, reason: e.target.checked && !l.reason ? bulkReason : l.reason })))} />
                  )}
                </TableCell>
                <TableCell sx={{ fontWeight: 800 }}>Product</TableCell>
                {mode === 'bill' && <TableCell sx={{ fontWeight: 800 }} align="right">Billed / Returned</TableCell>}
                <TableCell sx={{ fontWeight: 800, width: 90 }} align="right">Return Qty</TableCell>
                <TableCell sx={{ fontWeight: 800, width: 120 }} align="right">{isTaxEnabled() ? `Rate (incl. ${getTaxLabel()})` : 'Rate'}</TableCell>
                {mode === 'manual' && isTaxEnabled() && <TableCell sx={{ fontWeight: 800, width: 80 }} align="right">{getTaxLabel()} %</TableCell>}
                <TableCell sx={{ fontWeight: 800 }} align="right">Amount</TableCell>
                <TableCell sx={{ fontWeight: 800, minWidth: 200 }}>Return reason *</TableCell>
                <TableCell sx={{ fontWeight: 800, minWidth: 180 }}>Remarks</TableCell>
                {mode === 'manual' && <TableCell />}
              </TableRow>
            </TableHead>
            <TableBody>
              {linesLoading && <TableRow><TableCell colSpan={10} align="center" sx={{ py: 4 }}><CircularProgress size={24} /></TableCell></TableRow>}
              {!linesLoading && lines.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    {mode === 'bill' ? `Pick the ${cfg.original.toLowerCase()} above to list its items.` : 'Search a product above to add it.'}
                  </TableCell>
                </TableRow>
              )}
              {lines.map((l) => {
                const none = l.returnable_qty === 0;
                const amount = round2(toNum(l.qty) * toNum(l.unit_price));
                const over = l.returnable_qty != null && toNum(l.qty) > l.returnable_qty;
                return (
                  <TableRow key={l.key} sx={{ opacity: none ? 0.5 : 1, bgcolor: l.selected ? 'action.hover' : undefined }}>
                    <TableCell padding="checkbox">
                      <Checkbox size="small" disabled={none} checked={!!l.selected}
                        onChange={(e) => updateLine(l.key, { selected: e.target.checked, reason: e.target.checked && !l.reason ? bulkReason : l.reason })} />
                    </TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={700}>{l.description}</Typography>
                      <Typography variant="caption" color="text.secondary">{[l.sku, l.barcode, l.selling_unit && `per ${l.selling_unit.toLowerCase()}`].filter(Boolean).join(' · ')}</Typography>
                    </TableCell>
                    {mode === 'bill' && (
                      <TableCell align="right">
                        {l.original_qty} / {l.returned_qty}
                        {none && <Typography variant="caption" sx={{ display: 'block' }} color="text.secondary">fully returned</Typography>}
                      </TableCell>
                    )}
                    <TableCell align="right">
                      <TextField size="small" type="number" value={l.qty} disabled={none || !l.selected} error={over}
                        inputProps={{ min: 1, max: l.returnable_qty ?? undefined, step: 1, style: { textAlign: 'right' } }}
                        helperText={l.returnable_qty != null && l.selected ? `max ${l.returnable_qty}` : ''}
                        onChange={(e) => updateLine(l.key, { qty: e.target.value })} sx={{ width: 84 }} />
                    </TableCell>
                    <TableCell align="right">
                      <TextField size="small" type="number" value={l.unit_price} disabled={none || !l.selected}
                        inputProps={{ min: 0, step: '0.01', style: { textAlign: 'right' } }}
                        onChange={(e) => updateLine(l.key, { unit_price: e.target.value })} sx={{ width: 110 }} />
                    </TableCell>
                    {mode === 'manual' && isTaxEnabled() && (
                      <TableCell align="right">
                        <TextField size="small" type="number" value={l.tax_rate} inputProps={{ min: 0, max: 100, style: { textAlign: 'right' } }}
                          onChange={(e) => updateLine(l.key, { tax_rate: e.target.value })} sx={{ width: 70 }} />
                      </TableCell>
                    )}
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{l.selected ? fmtMoney(amount) : '—'}</TableCell>
                    <TableCell>
                      <TextField select size="small" fullWidth value={l.reason} disabled={none || !l.selected}
                        error={l.selected && !l.reason && errors.length > 0} onChange={(e) => updateLine(l.key, { reason: e.target.value })}>
                        <MenuItem value=""><em>Choose…</em></MenuItem>
                        {RETURN_REASONS.map((r) => <MenuItem key={r.value} value={r.value}>{r.label}</MenuItem>)}
                      </TextField>
                    </TableCell>
                    <TableCell>
                      <TextField size="small" fullWidth value={l.notes} disabled={none || !l.selected}
                        placeholder={reasonNeedsNote(l.reason) ? 'Describe the issue (required)' : 'Optional note'}
                        error={l.selected && reasonNeedsNote(l.reason) && !l.notes.trim() && errors.length > 0}
                        onChange={(e) => updateLine(l.key, { notes: e.target.value })} />
                    </TableCell>
                    {mode === 'manual' && (
                      <TableCell padding="checkbox">
                        <IconButton size="small" onClick={() => removeLine(l.key)} aria-label="Remove line"><DeleteIcon fontSize="small" /></IconButton>
                      </TableCell>
                    )}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </Box>
      </Card>

      <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: '3fr 2fr' } }}>
        <Card variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
            <Typography variant="subtitle1" fontWeight={800}>Refund / settlement</Typography>
            <Button size="small" startIcon={<AddIcon />} onClick={addSplit} disabled={!total}>Split payment</Button>
          </Stack>
          <Stack spacing={1.5}>
            {settlements.map((s, i) => {
              const meta = modeMeta(s.mode);
              return (
                <Box key={i} sx={{ p: 1.25, border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.25} alignItems={{ sm: 'flex-start' }}>
                    <TextField select size="small" label="Payment mode" value={s.mode} sx={{ minWidth: 190 }}
                      onChange={(e) => setSettlement(i, { mode: e.target.value, bank_account: '' })}>
                      {SETTLEMENT_MODES.map((m) => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
                    </TextField>
                    <TextField size="small" type="number" label={s.mode === 'CASH' ? 'Cash amount' : 'Amount'} value={s.amount}
                      inputProps={{ min: 0, step: '0.01' }} onChange={(e) => setSettlement(i, { amount: e.target.value })} sx={{ width: { sm: 150 } }} />
                    {settlements.length > 1 && (
                      <Tooltip title="Remove this split"><IconButton size="small" onClick={() => removeSplit(i)}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                    )}
                  </Stack>
                  {meta.needsBank && (
                    <PaymentModeDetails method={meta.paymentMethod} label={cfg.bankLabel} required sx={{ mt: 1.25 }}
                      bankAccount={s.bank_account} onBankAccountChange={(v) => setSettlement(i, { bank_account: v })}
                      reference={s.reference} onReferenceChange={(v) => setSettlement(i, { reference: v })} />
                  )}
                  {s.mode === 'CASH' && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>
                      {kind === 'sales' ? 'Paid out of Cash in Hand — shows in the Cash Book.' : 'Received into Cash in Hand — shows in the Cash Book.'}
                    </Typography>
                  )}
                  {s.mode === 'CREDIT' && (
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75 }}>{cfg.creditText}. No cash / bank movement.</Typography>
                  )}
                </Box>
              );
            })}
          </Stack>
          <TextField size="small" fullWidth multiline minRows={2} label="General remarks" value={remarks}
            onChange={(e) => setRemarks(e.target.value)} sx={{ mt: 2 }} />
        </Card>

        <Card variant="outlined" sx={{ p: 2, borderRadius: 3, display: 'flex', flexDirection: 'column' }}>
          <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 1 }}>Summary</Typography>
          <SummaryRow label="Lines / units" value={`${chosen.length} / ${chosen.reduce((s, l) => s + toNum(l.qty), 0)}`} />
          <SummaryRow label="Return value" value={fmtMoney(total)} strong />
          <SummaryRow label="Settled" value={fmtMoney(settled)} />
          <SummaryRow label="Balance" value={fmtMoney(balance)} danger={Math.abs(balance) >= 0.01} />
          <Typography variant="caption" color="text.secondary" sx={{ mt: 1 }}>{cfg.stockText} The accounts are posted automatically.</Typography>
          {errors.length > 0 && (
            <Alert severity="error" sx={{ mt: 1.5 }}>
              {errors.slice(0, 6).map((e, i) => <div key={i}>{e}</div>)}
            </Alert>
          )}
          <Box sx={{ flex: 1 }} />
          <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
            <Button variant="outlined" onClick={reset} disabled={saving}>Clear</Button>
            <Button fullWidth variant="contained" color="error" onClick={save} disabled={saving}
              startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <ReturnIcon />} sx={{ fontWeight: 800 }}>
              Save {cfg.title}
            </Button>
          </Stack>
        </Card>
      </Box>
    </Stack>
  );
}

function SummaryRow({ label, value, strong, danger }) {
  return (
    <Stack direction="row" justifyContent="space-between" sx={{ py: 0.4 }}>
      <Typography variant="body2" color="text.secondary">{label}</Typography>
      <Typography variant={strong ? 'subtitle1' : 'body2'} fontWeight={strong ? 900 : 700} color={danger ? 'error.main' : 'text.primary'}>{value}</Typography>
    </Stack>
  );
}

function ProductPicker({ onPick }) {
  const [q, setQ] = useState('');
  const [options, setOptions] = useState([]);
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setOptions([]); return undefined; }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      axios.get('/api/products/products/', { params: { search: term, page_size: 30 } })
        .then((r) => { if (alive) setOptions(Array.isArray(r.data) ? r.data : (r.data?.results || [])); })
        .catch(() => { if (alive) setOptions([]); })
        .finally(() => { if (alive) setLoading(false); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);
  return (
    <Autocomplete sx={{ flex: 2 }} options={options} loading={loading} filterOptions={(x) => x} value={null}
      inputValue={q} onInputChange={(_, v, reason) => { if (reason !== 'reset') setQ(v); }}
      onChange={(_, p) => { if (p) { onPick(p); setQ(''); } }}
      getOptionLabel={(p) => p?.name || ''} isOptionEqualToValue={(a, b) => a.id === b.id}
      renderOption={(props, p) => (
        <li {...props} key={p.id}>
          <Box>
            <Typography variant="body2" fontWeight={700}>{p.name}</Typography>
            <Typography variant="caption" color="text.secondary">{[p.sku, p.barcode, `Stock ${p.stock ?? 0}`].filter(Boolean).join(' · ')}</Typography>
          </Box>
        </li>
      )}
      noOptionsText={q.trim().length < 2 ? 'Type 2+ letters, or scan a barcode' : 'No products found'}
      renderInput={(params) => (
        <TextField {...params} size="small" label="Add product — name, SKU or barcode"
          InputProps={{ ...params.InputProps, startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
      )} />
  );
}

// ---------------------------------------------------------------------------------------------
function ReturnRegister({ kind }) {
  const cfg = RETURN_KINDS[kind];
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [view, setView] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await fetchReturnList(kind, { search: search.trim() || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined });
      setRows(data.results || data || []);
      setCount(data.count ?? (data.results || data || []).length);
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not load returns.'), 'error');
    } finally {
      setLoading(false);
    }
  }, [kind, search, dateFrom, dateTo]);

  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  const live = useMemo(() => rows.filter((r) => r.status !== 'CANCELLED'), [rows]);
  const sum = live.reduce((s, r) => s + toNum(r.total_amount), 0);

  return (
    <Card variant="outlined" sx={{ borderRadius: 3 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} sx={{ p: 1.5 }} alignItems={{ md: 'center' }}>
        <TextField size="small" placeholder={`Search return no., bill no., ${cfg.party.toLowerCase()}, product…`} value={search}
          onChange={(e) => setSearch(e.target.value)} sx={{ flex: 1 }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
        <TextField size="small" type="date" label="From" value={dateFrom} InputLabelProps={{ shrink: true }} onChange={(e) => setDateFrom(e.target.value)} />
        <TextField size="small" type="date" label="To" value={dateTo} InputLabelProps={{ shrink: true }} onChange={(e) => setDateTo(e.target.value)} />
        <Chip color="error" label={`${live.length} returns · ${fmtMoney(sum)}`} sx={{ fontWeight: 800 }} />
      </Stack>
      <Divider />
      <Box sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 900 }}>
          <TableHead>
            <TableRow>
              {['Return No.', 'Date', `Original ${cfg.original}`, cfg.party, 'Items / Qty', 'Reason', 'Refund Mode', 'Amount', 'Status', ''].map((h) => (
                <TableCell key={h} sx={{ fontWeight: 800 }} align={h === 'Amount' ? 'right' : 'left'}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {loading && <TableRow><TableCell colSpan={10} align="center" sx={{ py: 4 }}><CircularProgress size={24} /></TableCell></TableRow>}
            {!loading && rows.length === 0 && (
              <TableRow><TableCell colSpan={10} align="center" sx={{ py: 4, color: 'text.secondary' }}>No returns found.</TableCell></TableRow>
            )}
            {!loading && rows.map((r) => (
              <TableRow key={r.id} hover onClick={() => setView(r)} sx={{ cursor: 'pointer', opacity: r.status === 'CANCELLED' ? 0.55 : 1 }}>
                <TableCell sx={{ fontWeight: 800, color: 'error.main' }}>{r.return_number}</TableCell>
                <TableCell>{fmtDate(r.return_date)}</TableCell>
                <TableCell>{r.original?.number || <Typography variant="caption" color="text.secondary">Manual</Typography>}</TableCell>
                <TableCell>{r.party?.name || '—'}</TableCell>
                <TableCell>{(r.items || []).length} / {r.total_qty}</TableCell>
                <TableCell>{(r.reasons || []).join(', ')}</TableCell>
                <TableCell>{r.settlement_text || r.payment_mode_label}</TableCell>
                <TableCell align="right" sx={{ fontWeight: 800 }}>{fmtMoney(r.total_amount)}</TableCell>
                <TableCell>
                  <Chip size="small" label={r.status === 'CANCELLED' ? 'Cancelled' : 'Completed'} color={r.status === 'CANCELLED' ? 'default' : 'success'} variant="outlined" />
                </TableCell>
                <TableCell padding="checkbox"><IconButton size="small" aria-label="View return"><ViewIcon fontSize="small" /></IconButton></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Box>
      {count > rows.length && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', p: 1.5 }}>
          Showing the latest {rows.length} of {count} — narrow the dates or search to find older returns.
        </Typography>
      )}
      <ReturnDetailDialog kind={kind} open={!!view} returnId={view?.id} initial={view} canCancel
        onClose={() => setView(null)} onChanged={() => load()} />
    </Card>
  );
}
