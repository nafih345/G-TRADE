import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Autocomplete, Box, Button, Card, Checkbox, Chip, Divider, Grid, IconButton, InputAdornment, LinearProgress,
  MenuItem, Paper, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField,
  ToggleButton, ToggleButtonGroup, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, CheckCircle as CheckIcon, Delete as DeleteIcon, Print as PrintIcon, Refresh as RefreshIcon,
  Search as SearchIcon, Warning as WarningIcon, PlaylistAdd as LoadIcon,
} from '@mui/icons-material';
import { apiError, finGet, finPost, newIdempotencyKey } from './financialApi';
import VoucherSearchDialog from './VoucherSearchDialog';
import PaymentModeDetails from '../common/PaymentModeDetails';
import useBankAccounts from '../../hooks/useBankAccounts';
import { formatMoney, formatDate } from '../../utils/localeFormat';

const today = () => new Date().toISOString().split('T')[0];
const num = (v) => parseFloat(v) || 0;
const round2 = (v) => Math.round(v * 100) / 100;
const MAX_ACCOUNT_ROWS = 200;
// Pay-mode labels on screen -> the method names the posting engine maps to Cash / Bank / UPI.
const PAY_MODES = [
  { value: 'Cash', label: 'Cash', method: 'Cash' },
  { value: 'Bank', label: 'Bank Transfer', method: 'Bank Transfer' },
  { value: 'Cheque', label: 'Cheque', method: 'Cheque' },
  { value: 'UPI', label: 'UPI / Digital', method: 'UPI' },
];
const methodOf = (payMode) => (PAY_MODES.find(m => m.value === payMode) || PAY_MODES[0]).method;
const PARTY_KIND_LABEL = { customer: 'Customer', dealer: 'Dealer', supplier: 'Supplier' };

// `selected` is the row's tick: only ticked rows are totalled and posted. Typing an amount ticks it.
const blankAccountLine = () => ({ id: Date.now() + Math.random(), account: null, accountCode: '', accountName: '', mainAccount: '', narration: '', refNo: '', amount: '', selected: false });
const blankPaymentLine = () => ({ id: Date.now() + Math.random(), amount: '', payMode: 'Cash', refNo: '', refDate: today(), bankAccount: '' });

const focusSoon = (selector) => setTimeout(() => {
  const el = document.querySelector(selector);
  if (el) { el.focus(); if (typeof el.select === 'function') el.select(); }
}, 30);

/**
 * Receipt / Payment / Contra voucher form.
 *
 * Normal mode: account grid (Dr for Payment, Cr for Receipt) against the Cash / Bank lines below,
 * posted as one manual voucher through /financial/journals/ (onSaveVoucher).
 * Bill to Bill (Receipt / Payment only): tick one or more customers / dealers / suppliers (optionally
 * within a bill-date range), load their open bills from /financial/settlements/due-bills/, allocate
 * against them and post through /financial/settlements/receipt|payment/ (one party) or
 * /settlements/batch/ (several: one number per party, all saved or none). The server re-validates
 * the dues and books the settlement the same way the source documents' own receipts are booked.
 *
 * F1 opens the selector for the focused field: the account popup on a grid row's Account Code /
 * Name, the party popup on the party field (anywhere else it opens the one for the current mode).
 */
export default function StandardVoucherForm({ voucherType, accounts, cashOrBankAccounts, partiesList, showToast, onSaveVoucher, onPosted }) {
  const isReceipt = voucherType === 'RECEIPT';
  const isPayment = voucherType === 'PAYMENT';
  const isContra = voucherType === 'CONTRA';

  const voucherTitle = isReceipt ? 'Receipt Voucher' : isPayment ? 'Payment Voucher' : 'Contra Entry';
  const voucherPrefix = isReceipt ? 'RV' : isPayment ? 'PV' : 'CV';
  const voucherColorHex = isReceipt ? '#10b981' : isPayment ? '#ef4444' : '#2563eb';
  const partyLabel = isPayment ? 'Payee / Supplier / Party' : isContra ? 'Transfer Description / Party' : 'Customer / Received From';
  const billPartyLabel = isReceipt ? 'Customer / Dealer' : 'Supplier';
  const money = (v) => formatMoney(v || 0);

  const { banks } = useBankAccounts();
  const defaultBankId = useMemo(() => (banks.find(b => b.is_default_bank) || banks[0])?.id || '', [banks]);

  const accountsById = useMemo(() => new Map((accounts || []).map(a => [a.id, a])), [accounts]);
  const mainAccountOf = useCallback(
    (a) => (a.parent_account_id && accountsById.get(a.parent_account_id)?.name) || a.account_group || a.account_type || '',
    [accountsById],
  );

  // Contra moves money between cash / bank only. Receipt / Payment grids take the other side of
  // the cash or bank movement, so the cash / bank ledgers themselves go in the payment lines.
  const accountOptions = useMemo(() => {
    const active = (accounts || []).filter(a => a && a.status !== 'Inactive');
    if (isContra) return (cashOrBankAccounts || []).filter(a => a.status !== 'Inactive');
    return active.filter(a => !['CASH', 'BANK'].includes(a.account_subtype));
  }, [isContra, cashOrBankAccounts, accounts]);

  const cashAccount = useMemo(() => {
    const all = accounts || [];
    return all.find(a => a.account_subtype === 'CASH' && a.code === '1001')
      || all.find(a => a.account_subtype === 'CASH' && a.status !== 'Inactive')
      || (cashOrBankAccounts || []).find(a => a.name.toLowerCase().includes('cash'))
      || null;
  }, [accounts, cashOrBankAccounts]);

  const createBlankVoucherState = () => ({
    voucherNo: '',
    idempotencyKey: newIdempotencyKey(),
    date: today(),
    party: null,
    mode: 'Normal',
    narration: '',
    isSaved: false,
  });

  const [voucherState, setVoucherState] = useState(createBlankVoucherState);
  const [accountLines, setAccountLines] = useState(() => [blankAccountLine()]);
  const [paymentLines, setPaymentLines] = useState(() => [blankPaymentLine()]);
  const [billParties, setBillParties] = useState([]);
  const [billDates, setBillDates] = useState({ from: '', to: '' });
  const [billRows, setBillRows] = useState([]);
  const [billsLoading, setBillsLoading] = useState(false);
  const [billsError, setBillsError] = useState('');
  const [search, setSearch] = useState(null);   // { type: 'account', lineId } | { type: 'party' }
  const [saving, setSaving] = useState(false);
  const rootRef = useRef(null);
  const returnFocusRef = useRef(null);

  const isBill = !isContra && voucherState.mode === 'Bill to Bill';
  const locked = voucherState.isSaved;

  // ---------------------------------------------------------------------------------------
  // Totals and validation
  // ---------------------------------------------------------------------------------------
  const tickedLines = useMemo(() => accountLines.filter(l => l.selected), [accountLines]);
  const totalAccountAmount = useMemo(() => round2(tickedLines.reduce((s, l) => s + num(l.amount), 0)), [tickedLines]);
  const selectedBills = useMemo(() => billRows.filter(r => r.selected && num(r.amount) > 0), [billRows]);
  const totalAllocated = useMemo(() => round2(selectedBills.reduce((s, r) => s + num(r.amount), 0)), [selectedBills]);
  const voucherTotal = isBill ? totalAllocated : totalAccountAmount;
  const cashAmount = useMemo(() => round2(paymentLines.filter(p => p.payMode === 'Cash').reduce((s, p) => s + num(p.amount), 0)), [paymentLines]);
  const totalPaidAmount = useMemo(() => round2(paymentLines.reduce((s, p) => s + num(p.amount), 0)), [paymentLines]);
  const bankAmount = round2(totalPaidAmount - cashAmount);
  const difference = round2(voucherTotal - totalPaidAmount);
  const isBalanced = Math.abs(difference) < 0.005 && voucherTotal > 0;
  const bankFor = (line) => line.bankAccount || defaultBankId;

  const problems = useMemo(() => {
    const out = [];
    if (!voucherState.date) out.push('Enter the voucher date.');
    if (isBill) {
      if (!billParties.length) out.push(`Select the ${billPartyLabel.toLowerCase()} (F1).`);
      else if (!selectedBills.length) out.push('Tick at least one bill and enter the amount against it.');
      billRows.forEach(r => {
        if (num(r.amount) < 0) out.push(`${r.number}: amount cannot be negative.`);
        if (num(r.amount) - num(r.due) > 0.005) out.push(`${r.number}: ${money(r.amount)} is more than its due ${money(r.due)}.`);
      });
    } else {
      if (!tickedLines.some(l => l.account && num(l.amount) > 0)) out.push('Tick at least one account line and enter its amount.');
      accountLines.forEach((l, i) => {
        if (!l.selected) return;
        if (!l.account) out.push(`Row ${i + 1}: ${l.accountCode ? `no account with code "${l.accountCode}"` : 'select an account (F1)'}.`);
        else if (num(l.amount) <= 0) out.push(`Row ${i + 1}: enter the amount for ${l.account.name}.`);
      });
      const seen = new Set();
      tickedLines.forEach(l => {
        if (!l.account) return;
        const key = `${l.account.id}|${(l.refNo || '').trim().toLowerCase()}`;
        if (seen.has(key)) out.push(`${l.account.name} is entered twice with the same Ref No — combine the rows.`);
        seen.add(key);
      });
    }
    paymentLines.forEach((p, i) => {
      if (num(p.amount) < 0) out.push(`Payment ${i + 1}: amount cannot be negative.`);
      if (num(p.amount) > 0 && p.payMode !== 'Cash' && !bankFor(p) && !isBill) out.push(`Payment ${i + 1}: choose the bank account.`);
    });
    if (!paymentLines.some(p => num(p.amount) > 0)) out.push('Enter the Cash / Bank amount.');
    if (voucherTotal > 0 && !isBalanced) out.push(`Payment modes total ${money(totalPaidAmount)} but the voucher totals ${money(voucherTotal)}.`);
    if (!isContra && !isBill && !cashAccount && paymentLines.some(p => p.payMode === 'Cash' && num(p.amount) > 0)) {
      out.push('No Cash account found in the Chart of Accounts.');
    }
    return out;
  }, [voucherState.date, isBill, billParties, selectedBills, billRows, accountLines, tickedLines, paymentLines, voucherTotal, isBalanced,
      totalPaidAmount, cashAccount, defaultBankId]); // eslint-disable-line react-hooks/exhaustive-deps

  const isValid = problems.length === 0;

  // ---------------------------------------------------------------------------------------
  // Account grid
  // ---------------------------------------------------------------------------------------
  const setLine = (id, patch) => setAccountLines(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));

  const applyAccount = (id, acc) => {
    setLine(id, acc
      ? { account: acc, accountCode: acc.code, accountName: acc.name, mainAccount: mainAccountOf(acc) }
      : { account: null, accountName: '', mainAccount: '' });
  };

  // Typing a code and leaving the cell picks that exact account (the ERP's code-entry habit).
  const resolveTypedCode = (line) => {
    const code = (line.accountCode || '').trim().toLowerCase();
    if (!code) { if (line.account) applyAccount(line.id, null); return; }
    if (line.account && line.account.code.toLowerCase() === code) return;
    applyAccount(line.id, accountOptions.find(a => (a.code || '').toLowerCase() === code) || null);
  };

  const handleAddAccountLine = () => {
    const line = blankAccountLine();
    setAccountLines(prev => [...prev, line]);
    focusSoon(`[data-vf="code-${line.id}"]`);
  };

  const toggleAllLines = (checked) => setAccountLines(prev => prev.map(l => ({ ...l, selected: checked && !!(l.account || l.accountCode || num(l.amount)) })));

  const handleRemoveAccountLine = (id) => setAccountLines(prev => (prev.length <= 1 ? prev : prev.filter(l => l.id !== id)));

  const fetchAccounts = useCallback((text) => {
    const q = (text || '').trim().toLowerCase();
    const matches = accountOptions.filter(a => !q || [a.code, a.name, mainAccountOf(a), a.account_group, a.account_type, a.description]
      .some(v => String(v || '').toLowerCase().includes(q)));
    return {
      rows: matches.slice(0, MAX_ACCOUNT_ROWS).map(a => ({ ...a, main_account: mainAccountOf(a) })),
      hasMore: matches.length > MAX_ACCOUNT_ROWS,
      note: isContra ? 'Cash & bank accounts only' : 'Cash & bank ledgers go in the payment lines',
    };
  }, [accountOptions, mainAccountOf, isContra]);

  // ---------------------------------------------------------------------------------------
  // Bill to Bill
  // ---------------------------------------------------------------------------------------
  const fetchParties = useCallback(async (text, onlyDue, dates = {}) => {
    const data = await finGet('settlements/parties/', {
      voucher: voucherPrefix, search: text, only_due: onlyDue ? 1 : '', limit: 50,
      date_from: dates.from || '', date_to: dates.to || '',
    }).catch(e => { throw new Error(apiError(e, 'Could not search parties.')); });
    return { rows: data.results || [], hasMore: data.has_more };
  }, [voucherPrefix]);

  const loadDueBills = useCallback(async (parties = billParties, { focusFirst = false, dates = billDates } = {}) => {
    if (!parties.length) { showToast(`Select the ${billPartyLabel.toLowerCase()} first (F1).`, 'warning'); return; }
    if (dates.from && dates.to && dates.from > dates.to) { showToast('The bill From date is after the To date.', 'warning'); return; }
    setBillsLoading(true);
    setBillsError('');
    try {
      const answers = await Promise.all(parties.map(p => finGet('settlements/due-bills/', {
        party_kind: p.kind, party: p.id, date_from: dates.from || '', date_to: dates.to || '',
      })));
      const bills = answers.flatMap((data, i) => (data.bills || []).map(b => ({
        ...b, partyKey: `${parties[i].kind}:${parties[i].id}`, partyName: parties[i].name,
      })));
      // Reloading replaces the list (never appends), keeping what was already ticked / typed for
      // bills that are still open — capped at their fresh due amount.
      setBillRows(prev => {
        const before = new Map(prev.map(r => [r.id, r]));
        return bills.map(b => {
          const old = before.get(b.id);
          const due = num(b.due);
          const amount = old && old.amount !== '' ? String(Math.min(num(old.amount), due)) : '';
          return { ...b, narration: old?.narration || '', selected: !!old?.selected && num(amount) > 0, amount };
        });
      });
      const totals = new Map(answers.map((d, i) => [`${parties[i].kind}:${parties[i].id}`, d.total_due]));
      setBillParties(ps => ps.map(p => (totals.has(`${p.kind}:${p.id}`) ? { ...p, outstanding: totals.get(`${p.kind}:${p.id}`) } : p)));
      const inRange = dates.from || dates.to ? ' in that date range' : '';
      if (!bills.length) showToast(parties.length === 1 ? `${parties[0].name} has no outstanding bills${inRange}.` : `No outstanding bills${inRange} for the selected parties.`, 'info');
      else if (focusFirst) focusSoon(`[data-vf="bill-amount-${bills[0].id}"]`);
    } catch (e) {
      setBillsError(apiError(e, 'Could not load the due bills.'));
    } finally {
      setBillsLoading(false);
    }
  }, [billParties, billDates, billPartyLabel, showToast]);

  const selectParties = (parties, dates) => {
    setBillParties(parties);
    setBillDates(dates);
    setBillRows([]);
    loadDueBills(parties, { focusFirst: true, dates });
  };

  const setBill = (id, patch) => setBillRows(prev => prev.map(r => (r.id === id ? { ...r, ...patch } : r)));
  const toggleBill = (row, checked) => setBill(row.id, checked
    ? { selected: true, amount: num(row.amount) > 0 ? row.amount : String(num(row.due)) }
    : { selected: false, amount: '' });
  const toggleAllBills = (checked) => setBillRows(prev => prev.map(r => (checked
    ? { ...r, selected: true, amount: num(r.amount) > 0 ? r.amount : String(num(r.due)) }
    : { ...r, selected: false, amount: '' })));

  // ---------------------------------------------------------------------------------------
  // Payment lines
  // ---------------------------------------------------------------------------------------
  const setPayment = (id, patch) => setPaymentLines(prev => prev.map(p => (p.id === id ? { ...p, ...patch } : p)));
  const fillBalance = () => {
    // Puts the unpaid remainder on the last payment line.
    setPaymentLines(prev => {
      const last = prev[prev.length - 1];
      const others = prev.slice(0, -1).reduce((s, p) => s + num(p.amount), 0);
      const rest = round2(voucherTotal - others);
      return rest > 0 ? prev.map(p => (p.id === last.id ? { ...p, amount: String(rest) } : p)) : prev;
    });
  };

  // ---------------------------------------------------------------------------------------
  // F1 search
  // ---------------------------------------------------------------------------------------
  const openSearch = (spec, origin) => {
    if (locked) return;
    returnFocusRef.current = origin || document.activeElement;
    setSearch(spec);
  };
  const closeSearch = (focusSelector) => {
    setSearch(null);
    if (focusSelector) focusSoon(focusSelector);
    else {
      const el = returnFocusRef.current;
      setTimeout(() => { if (el && document.contains(el)) el.focus(); }, 30);
    }
  };

  const openSearchRef = useRef(openSearch);
  openSearchRef.current = openSearch;
  const stateRef = useRef({});
  stateRef.current = { isBill, accountLines, searchOpen: !!search };

  // One capture listener so F1 works from any field in the voucher (and the browser's own F1
  // help never opens here). Other screens' F1 shortcuts are not affected: this form is only
  // mounted on the voucher tabs, and it stands aside while any other dialog is open.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'F1') return;
      const { isBill: bill, accountLines: lines, searchOpen } = stateRef.current;
      if (searchOpen) return;   // the popup handles F1 itself
      if (document.querySelector('.MuiDialog-root')) return;
      const root = rootRef.current;
      const t = e.target;
      if (!root || (t !== document.body && !root.contains(t))) return;
      e.preventDefault();
      e.stopPropagation();
      const hint = t.closest?.('[data-vf-f1]')?.getAttribute('data-vf-f1') || '';
      if (hint === 'party' || (!hint.startsWith('account:') && bill)) {
        openSearchRef.current({ type: 'party' }, t);
        return;
      }
      const lineId = hint.startsWith('account:') ? Number(hint.slice(8)) : (lines.find(l => !l.account) || lines[lines.length - 1]).id;
      openSearchRef.current({ type: 'account', lineId }, t);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  // ---------------------------------------------------------------------------------------
  // New / save
  // ---------------------------------------------------------------------------------------
  const handleNew = () => {
    setVoucherState(prev => ({ ...createBlankVoucherState(), mode: prev.mode }));
    setAccountLines([blankAccountLine()]);
    setPaymentLines([blankPaymentLine()]);
    setBillParties([]);
    setBillDates({ from: '', to: '' });
    setBillRows([]);
    setBillsError('');
  };

  const handleReset = () => {
    handleNew();
    showToast('Form reset to fresh draft.', 'info');
  };

  const saveNormal = async () => {
    const partyName = typeof voucherState.party === 'object' && voucherState.party ? voucherState.party.name : (voucherState.party || 'General Party');
    const lines = [];
    // Receipt: Dr cash/bank (payment lines) / Cr accounts. Payment and Contra: Dr accounts /
    // Cr cash/bank — for a contra the account line is the cash/bank account receiving the transfer.
    tickedLines.forEach(l => {
      const amt = num(l.amount);
      if (l.account && amt > 0) {
        lines.push({
          account: l.account.id,
          debit: isReceipt ? 0 : amt,
          credit: isReceipt ? amt : 0,
          memo: [l.narration, l.refNo && `Ref ${l.refNo}`].filter(Boolean).join(' · '),
        });
      }
    });
    paymentLines.forEach(p => {
      const amt = num(p.amount);
      if (amt > 0) {
        lines.push({
          account: p.payMode === 'Cash' ? (cashAccount?.id || '1001') : bankFor(p),
          debit: isReceipt ? amt : 0,
          credit: isReceipt ? 0 : amt,
          memo: `${methodOf(p.payMode)}${p.refNo ? ` ${p.refNo}` : ''}${p.payMode !== 'Cash' && p.refDate ? ` (${p.refDate})` : ''}`,
        });
      }
    });
    const saved = await onSaveVoucher({
      voucher_type_code: voucherPrefix,
      date: voucherState.date,
      narration: voucherState.narration || `${voucherTitle} — ${partyName}`,
      reference_no: partyName,
      idempotency_key: voucherState.idempotencyKey,
      lines,
    });
    if (saved) setVoucherState(prev => ({ ...prev, isSaved: true, voucherNo: saved.entry_number }));
  };

  const toPayment = (p, amount) => ({
    method: methodOf(p.payMode),
    amount: round2(amount).toFixed(2),
    bank_account: p.payMode === 'Cash' ? null : (bankFor(p) || null),
    ref_no: p.refNo || '',
    ref_date: p.payMode === 'Cash' ? null : (p.refDate || null),
  });

  // One settlement per party, in the order the parties were picked. The pay-mode lines are spread
  // over them in order (Cash first, then Bank, ...), so every party's own total still reconciles.
  const buildSettlements = () => {
    const groups = billParties
      .map(party => ({ party, bills: selectedBills.filter(r => r.partyKey === `${party.kind}:${party.id}`) }))
      .filter(g => g.bills.length);
    const pays = paymentLines.filter(p => num(p.amount) > 0).map(p => ({ line: p, left: round2(num(p.amount)) }));
    let i = 0;
    return groups.map(({ party, bills }) => {
      let left = round2(bills.reduce((t, r) => t + num(r.amount), 0));
      const payments = [];
      while (left > 0.004 && i < pays.length) {
        const take = round2(Math.min(left, pays[i].left));
        if (take > 0) payments.push(toPayment(pays[i].line, take));
        left = round2(left - take);
        pays[i].left = round2(pays[i].left - take);
        if (pays[i].left <= 0.004) i += 1;
      }
      return {
        party_kind: party.kind,
        party: party.id,
        date: voucherState.date,
        narration: voucherState.narration,
        idempotency_key: groups.length > 1 ? `${voucherState.idempotencyKey}:${party.id}` : voucherState.idempotencyKey,
        allocations: bills.map(r => ({ bill: r.id, amount: round2(num(r.amount)).toFixed(2), narration: r.narration || '' })),
        payments,
      };
    });
  };

  const saveBills = async () => {
    const items = buildSettlements();
    try {
      let numbers, duplicate, failed = [], journals = [];
      if (items.length === 1) {
        const res = await finPost(isReceipt ? 'settlements/receipt/' : 'settlements/payment/', items[0]);
        numbers = [isReceipt ? res.number : res.entry_number];
        duplicate = res.duplicate;
        failed = res.failed || [];
        journals = res.journals || [];
      } else {
        const res = await finPost(`settlements/batch/${voucherPrefix.toLowerCase()}/`, { settlements: items });
        const results = res.results || [];
        numbers = results.map(r => (isReceipt ? r.number : r.entry_number));
        duplicate = res.duplicate;
        failed = results.flatMap(r => r.failed || []);
        journals = results.flatMap(r => r.journals || []);
      }
      const number = numbers.join(', ');
      setVoucherState(prev => ({ ...prev, isSaved: true, voucherNo: number }));
      if (duplicate) showToast(`${number} was already saved — nothing was posted twice.`, 'info');
      else if (isReceipt && failed.length) {
        showToast(`${number} saved, but ${failed.length} receipt(s) could not be booked yet: ${failed[0].error} (see Accounting Integration).`, 'warning');
      } else {
        const who = items.length > 1 ? ` for ${items.length} parties` : '';
        const detail = isReceipt && journals.length && journals.length <= 4 ? ` (${journals.join(', ')})` : '';
        showToast(`${voucherTitle} ${number} posted against ${selectedBills.length} bill(s)${who}${detail}.`, 'success');
      }
      onPosted?.();
      loadDueBills(billParties);
    } catch (e) {
      showToast(apiError(e, 'The voucher could not be posted.'), 'error');
    }
  };

  const handleSave = async () => {
    if (saving || locked) return;
    if (!isValid) { showToast(problems[0], 'error'); return; }
    setSaving(true);
    try {
      await (isBill ? saveBills() : saveNormal());
    } finally {
      setSaving(false);
    }
  };

  // ---------------------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------------------
  const accountColumns = [
    { key: 'code', label: 'Account Code', mono: true, width: 130 },
    { key: 'name', label: 'Account Name' },
    { key: 'main_account', label: 'Main Account' },
    { key: 'account_type', label: 'Type', width: 100 },
    { key: 'description', label: 'Narration', render: (a) => <Typography variant="body2" noWrap sx={{ maxWidth: 220 }} title={a.description}>{a.description || '—'}</Typography> },
    { key: 'current_balance', label: 'Balance', align: 'right', render: (a) => money(a.current_balance) },
  ];
  const partyColumns = [
    ...(isReceipt ? [{ key: 'kind', label: 'Type', width: 90, render: (p) => PARTY_KIND_LABEL[p.kind] }] : []),
    { key: 'code', label: `${isReceipt ? 'Customer' : 'Supplier'} Code`, mono: true, width: 130 },
    { key: 'name', label: `${isReceipt ? 'Customer' : 'Supplier'} Name` },
    { key: 'mobile', label: 'Mobile' },
    { key: 'area', label: 'Area' },
    { key: 'open_bills', label: 'Bills', align: 'right', width: 60 },
    { key: 'outstanding', label: 'Outstanding Balance', align: 'right', render: (p) => <b>{money(p.outstanding)}</b> },
  ];

  const allBillsTicked = billRows.length > 0 && billRows.every(r => r.selected);
  const allLinesTicked = accountLines.length > 0 && accountLines.every(l => l.selected);
  const multiParty = billParties.length > 1;
  const partyFieldText = !billParties.length ? ''
    : billParties.length === 1 ? `${billParties[0].name}${billParties[0].code ? ` (${billParties[0].code})` : ''}`
      : `${billParties.length} parties: ${billParties.slice(0, 3).map(p => p.name).join(', ')}${billParties.length > 3 ? '…' : ''}`;
  const partiesOutstanding = billParties.reduce((t, p) => t + num(p.outstanding), 0);
  const partyHelperText = !billParties.length ? ' '
    : billParties.length === 1 ? `${PARTY_KIND_LABEL[billParties[0].kind]} · Outstanding ${money(billParties[0].outstanding)}`
      : `Outstanding ${money(partiesOutstanding)}`;
  const datesText = billDates.from || billDates.to
    ? `Bills ${billDates.from ? `from ${formatDate(billDates.from)}` : ''}${billDates.to ? ` to ${formatDate(billDates.to)}` : ''}` : '';
  const cellInput = { '& .MuiInputBase-input': { py: 0.75 } };

  return (
    <Box ref={rootRef}>
      {/* 1. STICKY TOP ACTION TOOLBAR */}
      <Paper elevation={0} variant="outlined" sx={{ position: 'sticky', top: 0, zIndex: 100, p: 1.5, mb: 3, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#e2e8f0', boxShadow: '0 2px 8px rgba(0, 0, 0, 0.04)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5 }}>
        <Stack direction="row" spacing={1.5} alignItems="center">
          <Chip label={`${voucherTitle} (${voucherPrefix})`} sx={{ backgroundColor: voucherColorHex, color: '#ffffff', fontWeight: 850, fontSize: '0.875rem' }} />
          <Typography variant="subtitle2" color="text.secondary" fontWeight={700}>
            {locked ? `✅ Posted ${voucherState.voucherNo}` : '📝 Unsaved Draft'}
          </Typography>
          <Tooltip title={isBill ? `F1: search ${billPartyLabel.toLowerCase()}` : 'F1 on Account Code / Name: search accounts'}>
            <Chip size="small" variant="outlined" label="F1 Search" sx={{ fontWeight: 700 }} />
          </Tooltip>
        </Stack>
        <Stack direction="row" spacing={1} flexWrap="wrap" gap={1}>
          <Button variant="outlined" size="small" startIcon={<AddIcon />} onClick={handleNew}>New</Button>
          <Button variant="contained" size="small" startIcon={<CheckIcon />} disabled={!isValid || saving || locked} onClick={handleSave}
            sx={{ backgroundColor: voucherColorHex, fontWeight: 800, '&:hover': { backgroundColor: voucherColorHex } }}>
            Save
          </Button>
          <Button variant="outlined" size="small" startIcon={<PrintIcon />} disabled={!locked} onClick={() => window.print()}>Print</Button>
          <Button variant="outlined" size="small" startIcon={<RefreshIcon />} onClick={handleReset}>Refresh</Button>
        </Stack>
      </Paper>

      {/* 2. HEADER SECTION */}
      <Card variant="outlined" sx={{ p: 3, mb: 3, borderRadius: 4, bgcolor: '#ffffff' }}>
        <Typography variant="subtitle1" fontWeight={850} sx={{ mb: 2 }}>Voucher Header Information</Typography>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={6} md={3}>
            <TextField fullWidth size="small" label="Voucher No (Auto)" value={voucherState.voucherNo || 'Assigned when posted'} InputProps={{ readOnly: true }} sx={{ bgcolor: '#f8fafc' }} />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            <TextField type="date" fullWidth size="small" label="Date *" value={voucherState.date} disabled={locked}
              onChange={(e) => setVoucherState(prev => ({ ...prev, date: e.target.value }))} InputLabelProps={{ shrink: true }} />
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            {isBill ? (
              <TextField
                fullWidth size="small" label={`${billPartyLabel} *`} placeholder="Press F1 to search"
                value={partyFieldText}
                data-vf-f1="party"
                inputProps={{ readOnly: true, 'data-vf': 'party' }}
                onKeyDown={(e) => { if (e.key === 'Enter' && !billParties.length) { e.preventDefault(); openSearch({ type: 'party' }, e.target); } }}
                onDoubleClick={(e) => openSearch({ type: 'party' }, e.target)}
                helperText={partyHelperText}
                InputProps={{
                  endAdornment: (
                    <InputAdornment position="end">
                      <Tooltip title="Search (F1)">
                        <span><IconButton size="small" edge="end" disabled={locked} onClick={(e) => openSearch({ type: 'party' }, e.currentTarget)} aria-label={`Search ${billPartyLabel}`}><SearchIcon fontSize="small" /></IconButton></span>
                      </Tooltip>
                    </InputAdornment>
                  ),
                }}
              />
            ) : (
              <Autocomplete
                options={partiesList}
                disabled={locked}
                getOptionLabel={(option) => (typeof option === 'string' ? option : `${option.name || ''} ${option.code ? `(${option.code})` : ''}`)}
                value={voucherState.party}
                onChange={(e, newVal) => setVoucherState(prev => ({ ...prev, party: newVal }))}
                renderInput={(params) => <TextField {...params} label={partyLabel} placeholder="Search party..." size="small" />}
              />
            )}
          </Grid>
          <Grid item xs={12} sm={6} md={3}>
            {!isContra && (
              <Box>
                <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ display: 'block', mb: 0.5 }}>{voucherPrefix} Mode</Typography>
                <ToggleButtonGroup size="small" exclusive value={voucherState.mode} disabled={locked}
                  onChange={(e, newMode) => { if (newMode) setVoucherState(prev => ({ ...prev, mode: newMode })); }} sx={{ width: '100%' }}>
                  <ToggleButton value="Normal" sx={{ flex: 1, fontWeight: 700, py: 0.5 }}>Normal</ToggleButton>
                  <ToggleButton value="Bill to Bill" sx={{ flex: 1, fontWeight: 700, py: 0.5 }}>Bill to Bill</ToggleButton>
                </ToggleButtonGroup>
              </Box>
            )}
          </Grid>
          <Grid item xs={12}>
            <TextField fullWidth size="small" label="Narration" value={voucherState.narration} disabled={locked}
              placeholder={`${voucherTitle} narration (optional)`}
              onChange={(e) => setVoucherState(prev => ({ ...prev, narration: e.target.value }))} />
          </Grid>
        </Grid>
      </Card>

      {/* 3A. NORMAL MODE: ACCOUNT GRID */}
      {!isBill && (
        <Card variant="outlined" sx={{ borderRadius: 4, overflow: 'hidden', mb: 3 }}>
          <Box sx={{ p: 2, px: 3, bgcolor: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="subtitle1" fontWeight={850}>
              Account Lines ({isReceipt ? 'Credit Accounts' : isPayment ? 'Debit Accounts' : 'Cash/Bank Accounts'})
            </Typography>
            <Button size="small" variant="contained" startIcon={<AddIcon />} onClick={handleAddAccountLine} disabled={locked} sx={{ backgroundColor: '#2563eb', fontWeight: 700 }}>
              Add Line
            </Button>
          </Box>
          <TableContainer component={Paper} elevation={0} sx={{ overflowX: 'auto' }}>
            <Table sx={{ minWidth: 900 }} size="small">
              <TableHead sx={{ bgcolor: '#f1f5f9' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700, width: 150 }}>Account Code</TableCell>
                  <TableCell sx={{ fontWeight: 700, minWidth: 220 }}>Account Name *</TableCell>
                  <TableCell sx={{ fontWeight: 700, minWidth: 150 }}>Main Account</TableCell>
                  <TableCell sx={{ fontWeight: 700, minWidth: 180 }}>Narration</TableCell>
                  <TableCell padding="checkbox">
                    <Tooltip title="Only ticked lines are posted">
                      <Checkbox size="small" checked={allLinesTicked} indeterminate={!allLinesTicked && accountLines.some(l => l.selected)}
                        disabled={locked} onChange={(e) => toggleAllLines(e.target.checked)} inputProps={{ 'aria-label': 'Select all account lines' }} />
                    </Tooltip>
                  </TableCell>
                  <TableCell sx={{ fontWeight: 700, minWidth: 120 }}>Ref No</TableCell>
                  <TableCell sx={{ fontWeight: 700, width: 150 }} align="right">Amount *</TableCell>
                  <TableCell sx={{ fontWeight: 700, width: 50 }} align="center">Act</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {accountLines.map((line) => {
                  const badCode = !!line.accountCode && !line.account;
                  return (
                    <TableRow key={line.id} selected={line.selected}>
                      <TableCell data-vf-f1={`account:${line.id}`}>
                        <TextField size="small" fullWidth value={line.accountCode} placeholder="Code / F1" disabled={locked} error={badCode}
                          inputProps={{ 'data-vf': `code-${line.id}`, style: { fontFamily: 'monospace', fontWeight: 700 } }}
                          onChange={(e) => setLine(line.id, { accountCode: e.target.value })}
                          onBlur={() => resolveTypedCode(line)}
                          sx={cellInput} />
                      </TableCell>
                      <TableCell data-vf-f1={`account:${line.id}`}>
                        <TextField size="small" fullWidth value={line.accountName} placeholder="Press F1 to search accounts" disabled={locked}
                          inputProps={{ readOnly: true, 'data-vf': `name-${line.id}` }}
                          onDoubleClick={(e) => openSearch({ type: 'account', lineId: line.id }, e.target)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !line.account) { e.preventDefault(); openSearch({ type: 'account', lineId: line.id }, e.target); } }}
                          sx={cellInput}
                          InputProps={{
                            endAdornment: (
                              <InputAdornment position="end">
                                <IconButton size="small" edge="end" tabIndex={-1} disabled={locked} aria-label="Search accounts"
                                  onClick={(e) => openSearch({ type: 'account', lineId: line.id }, e.currentTarget)}>
                                  <SearchIcon fontSize="small" />
                                </IconButton>
                              </InputAdornment>
                            ),
                          }} />
                      </TableCell>
                      <TableCell>
                        {line.mainAccount ? <Chip label={line.mainAccount} size="small" variant="outlined" sx={{ fontWeight: 600 }} /> : <Typography variant="body2" color="text.disabled">—</Typography>}
                      </TableCell>
                      <TableCell>
                        <TextField size="small" fullWidth placeholder="Line narration..." value={line.narration} disabled={locked}
                          inputProps={{ 'data-vf': `narration-${line.id}` }} sx={cellInput}
                          onChange={(e) => setLine(line.id, { narration: e.target.value })} />
                      </TableCell>
                      <TableCell padding="checkbox">
                        <Checkbox size="small" checked={line.selected} disabled={locked} onChange={(e) => setLine(line.id, { selected: e.target.checked })}
                          inputProps={{ 'aria-label': `Select ${line.accountName || 'line'}` }} />
                      </TableCell>
                      <TableCell>
                        <TextField size="small" fullWidth placeholder="Bill/Ref #" value={line.refNo} disabled={locked} sx={cellInput}
                          onChange={(e) => setLine(line.id, { refNo: e.target.value })} />
                      </TableCell>
                      <TableCell align="right">
                        <TextField type="number" size="small" value={line.amount} disabled={locked}
                          inputProps={{ min: 0, step: '0.01', 'data-vf': `amount-${line.id}` }}
                          onChange={(e) => setLine(line.id, { amount: e.target.value, selected: num(e.target.value) > 0 })}
                          sx={{ width: 140, ...cellInput, '& .MuiInputBase-input': { textAlign: 'right', fontWeight: 700, py: 0.75 } }} />
                      </TableCell>
                      <TableCell align="center">
                        <IconButton size="small" color="error" disabled={locked || accountLines.length <= 1} onClick={() => handleRemoveAccountLine(line.id)} aria-label="Remove line">
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}

      {/* 3B. BILL TO BILL MODE: DUE BILLS GRID */}
      {isBill && (
        <Card variant="outlined" sx={{ borderRadius: 4, overflow: 'hidden', mb: 3 }}>
          <Box sx={{ p: 2, px: 3, bgcolor: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="subtitle1" fontWeight={850}>
              {isReceipt ? 'Outstanding Sales Bills' : 'Outstanding Purchase Bills'}
              {billParties.length === 1 ? ` — ${billParties[0].name}` : multiParty ? ` — ${billParties.length} parties` : ''}
            </Typography>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
              <TextField type="date" size="small" label="Bill From" value={billDates.from} disabled={locked} InputLabelProps={{ shrink: true }}
                inputProps={{ 'data-vf': 'bill-from', max: billDates.to || undefined }} sx={{ width: 160, bgcolor: '#fff' }}
                onChange={(e) => setBillDates(d => ({ ...d, from: e.target.value }))} />
              <TextField type="date" size="small" label="Bill To" value={billDates.to} disabled={locked} InputLabelProps={{ shrink: true }}
                inputProps={{ 'data-vf': 'bill-to', min: billDates.from || undefined }} sx={{ width: 160, bgcolor: '#fff' }}
                onChange={(e) => setBillDates(d => ({ ...d, to: e.target.value }))} />
              <Button size="small" variant="contained" startIcon={<LoadIcon />} onClick={() => loadDueBills()} disabled={locked || !billParties.length || billsLoading}
                sx={{ backgroundColor: '#2563eb', fontWeight: 700 }}>
                Load Due Bills
              </Button>
            </Stack>
          </Box>
          <Box sx={{ height: 4 }}>{billsLoading && <LinearProgress />}</Box>
          {billsError && <Alert severity="error" sx={{ m: 2 }}>{billsError}</Alert>}
          <TableContainer component={Paper} elevation={0} sx={{ overflowX: 'auto', maxHeight: 460 }}>
            <Table sx={{ minWidth: 1000 }} size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {multiParty && <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }}>Party</TableCell>}
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }}>Account Code</TableCell>
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }}>Account Name</TableCell>
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }}>Main Account</TableCell>
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9', minWidth: 170 }}>Narration</TableCell>
                  <TableCell padding="checkbox" sx={{ bgcolor: '#f1f5f9' }}>
                    <Checkbox size="small" checked={allBillsTicked} indeterminate={!allBillsTicked && billRows.some(r => r.selected)}
                      disabled={locked || !billRows.length} onChange={(e) => toggleAllBills(e.target.checked)} inputProps={{ 'aria-label': 'Select all bills' }} />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }}>Ref No / Bill No</TableCell>
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }}>Bill Date</TableCell>
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }} align="right">Bill Total</TableCell>
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9' }} align="right">Due Amount</TableCell>
                  <TableCell sx={{ fontWeight: 700, bgcolor: '#f1f5f9', width: 160 }} align="right">{isReceipt ? 'Amount to Receive' : 'Amount to Pay'}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {billRows.map((r) => {
                  const over = num(r.amount) - num(r.due) > 0.005;
                  return (
                    <TableRow key={r.id} selected={r.selected}>
                      {multiParty && <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>{r.partyName}</TableCell>}
                      <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700, color: 'primary.main' }}>{r.account_code}</TableCell>
                      <TableCell>{r.account_name}</TableCell>
                      <TableCell><Chip label={r.main_account || '—'} size="small" variant="outlined" sx={{ fontWeight: 600 }} /></TableCell>
                      <TableCell>
                        <TextField size="small" fullWidth value={r.narration} disabled={locked} placeholder="Narration..." sx={cellInput}
                          onChange={(e) => setBill(r.id, { narration: e.target.value })} />
                      </TableCell>
                      <TableCell padding="checkbox">
                        <Checkbox size="small" checked={r.selected} disabled={locked} onChange={(e) => toggleBill(r, e.target.checked)}
                          inputProps={{ 'aria-label': `Select ${r.number}` }} />
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>
                        {r.number}
                        {r.ref ? <Typography component="span" variant="caption" color="text.secondary"> · {r.ref}</Typography> : null}
                      </TableCell>
                      <TableCell>{formatDate(r.date)}</TableCell>
                      <TableCell align="right">{money(r.total)}</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 800 }}>{money(r.due)}</TableCell>
                      <TableCell align="right">
                        <TextField type="number" size="small" value={r.amount} disabled={locked} error={over}
                          inputProps={{ min: 0, max: num(r.due), step: '0.01', 'data-vf': `bill-amount-${r.id}` }}
                          onChange={(e) => setBill(r.id, { amount: e.target.value, selected: num(e.target.value) > 0 })}
                          sx={{ width: 150, '& .MuiInputBase-input': { textAlign: 'right', fontWeight: 700, py: 0.75 } }} />
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!billRows.length && !billsLoading && (
                  <TableRow>
                    <TableCell colSpan={multiParty ? 11 : 10} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                      {billParties.length ? `No outstanding bills loaded${datesText ? ` (${datesText.toLowerCase()})` : ''}. Press "Load Due Bills".` : `Select the ${billPartyLabel.toLowerCase()} (F1) to load their outstanding bills.`}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
          {billRows.length > 0 && (
            <Stack direction="row" spacing={3} sx={{ px: 3, py: 1.25, borderTop: '1px solid #e2e8f0', bgcolor: '#f8fafc' }} flexWrap="wrap">
              {multiParty && <Typography variant="body2" fontWeight={700}>Parties: {billParties.length}</Typography>}
              <Typography variant="body2" fontWeight={700}>Bills: {billRows.length}</Typography>
              {datesText && <Typography variant="body2" fontWeight={700} color="text.secondary">{datesText}</Typography>}
              <Typography variant="body2" fontWeight={700}>Total Due: {money(billRows.reduce((s, r) => s + num(r.due), 0))}</Typography>
              <Typography variant="body2" fontWeight={800} color="primary.main">Selected: {selectedBills.length} · {money(totalAllocated)}</Typography>
            </Stack>
          )}
        </Card>
      )}

      {/* 4. PAYMENT MODE SECTION */}
      <Card variant="outlined" sx={{ borderRadius: 4, overflow: 'hidden', mb: 4 }}>
        <Box sx={{ p: 2, px: 3, bgcolor: '#f8fafc', borderBottom: '1px solid #e2e8f0', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle1" fontWeight={850}>
            Payment Mode & Split Payments ({isReceipt ? 'Inflow Settlement' : isPayment ? 'Outflow Settlement' : 'Transfer Details'})
          </Typography>
          <Stack direction="row" spacing={1}>
            <Button size="small" variant="outlined" onClick={fillBalance} disabled={locked || voucherTotal <= 0 || isBalanced} sx={{ fontWeight: 700 }}>
              Fill Balance
            </Button>
            <Button size="small" variant="outlined" startIcon={<AddIcon />} disabled={locked} onClick={() => setPaymentLines(prev => [...prev, blankPaymentLine()])} sx={{ fontWeight: 700 }}>
              Add Payment
            </Button>
          </Stack>
        </Box>
        <TableContainer component={Paper} elevation={0} sx={{ overflowX: 'auto' }}>
          <Table sx={{ minWidth: 850 }} size="small">
            <TableHead sx={{ bgcolor: '#f1f5f9' }}>
              <TableRow>
                <TableCell sx={{ fontWeight: 700, minWidth: 140 }} align="right">Amount *</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 150 }}>Pay Mode *</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 160 }}>Ref / Instrument No</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 140 }}>Ref Date</TableCell>
                <TableCell sx={{ fontWeight: 700, minWidth: 220 }}>Bank Account (Non-Cash)</TableCell>
                <TableCell sx={{ fontWeight: 700, width: 50 }} align="center">Act</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {paymentLines.map((line) => (
                <TableRow key={line.id}>
                  <TableCell align="right">
                    <TextField type="number" size="small" value={line.amount} disabled={locked} inputProps={{ min: 0, step: '0.01' }}
                      onChange={(e) => setPayment(line.id, { amount: e.target.value })}
                      sx={{ width: 140, '& .MuiInputBase-input': { textAlign: 'right', fontWeight: 700, py: 0.75 } }} />
                  </TableCell>
                  <TableCell>
                    <TextField select size="small" fullWidth value={line.payMode} disabled={locked}
                      onChange={(e) => setPayment(line.id, { payMode: e.target.value, bankAccount: '' })}>
                      {PAY_MODES.map(m => <MenuItem key={m.value} value={m.value}>{m.label}</MenuItem>)}
                    </TextField>
                  </TableCell>
                  <TableCell>
                    <TextField size="small" fullWidth disabled={locked} value={line.refNo} sx={cellInput}
                      placeholder={line.payMode === 'Cheque' ? 'Cheque No' : line.payMode === 'UPI' ? 'UTR / Ref No' : 'Ref No'}
                      onChange={(e) => setPayment(line.id, { refNo: e.target.value })} />
                  </TableCell>
                  <TableCell>
                    <TextField type="date" size="small" fullWidth value={line.refDate} disabled={locked || line.payMode === 'Cash'} sx={cellInput}
                      onChange={(e) => setPayment(line.id, { refDate: e.target.value })} />
                  </TableCell>
                  <TableCell>
                    {line.payMode === 'Cash' ? (
                      <Typography variant="body2" color="text.secondary">{cashAccount ? `${cashAccount.code} - ${cashAccount.name}` : 'N/A (Cash)'}</Typography>
                    ) : (
                      <PaymentModeDetails compact method={methodOf(line.payMode)} bankAccount={line.bankAccount} disabled={locked}
                        onBankAccountChange={(id) => setPayment(line.id, { bankAccount: id })} />
                    )}
                  </TableCell>
                  <TableCell align="center">
                    <IconButton size="small" color="error" disabled={locked || paymentLines.length <= 1} aria-label="Remove payment"
                      onClick={() => setPaymentLines(prev => prev.filter(p => p.id !== line.id))}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>

      {/* 5. STICKY FOOTER WITH RUNNING TOTALS & INLINE VALIDATION */}
      <Paper elevation={0} variant="outlined" sx={{ position: 'sticky', bottom: 16, zIndex: 100, p: 2, px: 3, borderRadius: 3, bgcolor: '#ffffff', boxShadow: '0 4px 16px rgba(0,0,0,0.1)', border: isBalanced ? '1px solid #10b981' : '1px solid #ef4444', transition: 'all 0.2s ease' }}>
        <Grid container spacing={2} alignItems="center" justifyContent="space-between">
          <Grid item xs={12} md={8}>
            <Stack direction="row" spacing={2.5} alignItems="center" flexWrap="wrap" gap={1}>
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>{isBill ? 'TOTAL ALLOCATED' : 'VOUCHER TOTAL'}</Typography>
                <Typography variant="h6" fontWeight={850} color="primary.main">{money(voucherTotal)}</Typography>
              </Box>
              <Divider orientation="vertical" flexItem />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>CASH</Typography>
                <Typography variant="subtitle1" fontWeight={800}>{money(cashAmount)}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>BANK</Typography>
                <Typography variant="subtitle1" fontWeight={800}>{money(bankAmount)}</Typography>
              </Box>
              <Divider orientation="vertical" flexItem />
              <Box>
                <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL PAID</Typography>
                <Typography variant="h6" fontWeight={850} color={isBalanced ? 'success.main' : 'error.main'}>{money(totalPaidAmount)}</Typography>
              </Box>
              <Box>
                {isBalanced
                  ? <Chip icon={<CheckIcon />} label="Balanced Entry" color="success" sx={{ fontWeight: 700 }} />
                  : <Chip icon={<WarningIcon />} label={`Difference: ${money(Math.abs(difference))}`} color="error" sx={{ fontWeight: 700 }} />}
              </Box>
            </Stack>
            {!locked && problems.length > 0 && (voucherTotal > 0 || totalPaidAmount > 0 || billParties.length > 0 || accountLines.some(l => l.account || l.accountCode)) && (
              <Typography variant="caption" color="error.main" fontWeight={700} sx={{ display: 'block', mt: 0.75 }}>
                {problems[0]}{problems.length > 1 ? ` (+${problems.length - 1} more)` : ''}
              </Typography>
            )}
          </Grid>
          <Grid item xs={12} md={4} sx={{ textAlign: { xs: 'left', md: 'right' } }}>
            <Button variant="contained" size="large" disabled={!isValid || saving || locked} onClick={handleSave}
              sx={{ backgroundColor: voucherColorHex, fontWeight: 850, px: 4, py: 1.2, '&:hover': { backgroundColor: voucherColorHex } }}>
              {saving ? 'Posting…' : `Save ${voucherTitle}`}
            </Button>
          </Grid>
        </Grid>
      </Paper>

      <VoucherSearchDialog
        open={search?.type === 'account'}
        title={isContra ? 'Select Cash / Bank Account' : 'Select Account'}
        placeholder="Search by account code, name, main account or narration…"
        columns={accountColumns}
        fetchRows={fetchAccounts}
        onClose={() => closeSearch()}
        onSelect={(acc) => {
          const lineId = search.lineId;
          applyAccount(lineId, acc);
          closeSearch(`[data-vf="narration-${lineId}"]`);
        }}
      />
      <VoucherSearchDialog
        open={search?.type === 'party'}
        title={isReceipt ? 'Select Customer / Dealer' : 'Select Supplier'}
        multiSelect
        dateRange
        initialDates={billDates}
        placeholder={`Search by ${isReceipt ? 'customer' : 'supplier'} code, name, mobile or area…`}
        columns={partyColumns}
        rowKey={(p) => `${p.kind}:${p.id}`}
        fetchRows={fetchParties}
        toggle={{ label: 'Only with dues', default: false }}
        emptyText={`No matching ${isReceipt ? 'customers or dealers' : 'suppliers'}.`}
        onClose={() => closeSearch()}
        onSelect={(parties, { dates }) => { closeSearch('[data-vf="party"]'); selectParties(parties, dates); }}
      />
    </Box>
  );
}
