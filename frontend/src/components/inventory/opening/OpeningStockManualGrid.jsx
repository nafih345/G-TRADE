// Opening Stock → Fast Manual Entry: a plain inline grid, one row per item, no product forms.
//
// Keyboard: Enter = next cell (from the last cell of the last row it adds a new row) ·
// Shift+Enter = previous cell · ↑/↓ = same column in the row above/below · Ctrl+Delete = remove
// the row · Ctrl+S = save. The unsaved grid is kept in this browser as a draft.
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, Checkbox, Chip, CircularProgress, FormControlLabel, IconButton, Stack, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, DeleteOutline as DeleteIcon, FactCheck as CheckIcon, Save as SaveIcon, RestartAlt as ClearIcon,
} from '@mui/icons-material';
import { newClientToken, saveOpeningStock, validateOpeningRows } from '../../purchasing/stock/stockApi';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';
import { OPENING_FIELDS, ROW_STATUS, lineValue, money, resultMessages, totals } from './openingStockFields';

const DRAFT_KEY = 'opening_stock_manual_draft';
let seq = 0;
const blankRow = () => ({ id: `r${Date.now()}-${seq++}`, name: '', barcode: '', category: '', brand: '', quantity: '', cost_price: '', mrp: '' });
const isBlank = (r) => OPENING_FIELDS.every((f) => !String(r[f.key] ?? '').trim());
const readDraft = () => {
  try {
    const d = JSON.parse(localStorage.getItem(DRAFT_KEY));
    if (Array.isArray(d) && d.length) return d.map((r) => ({ ...blankRow(), ...r, id: blankRow().id }));
  } catch { /* private mode / bad JSON */ }
  return [blankRow(), blankRow(), blankRow()];
};

const cellSx = { p: 0.4, borderRight: '1px solid', borderColor: 'divider' };
const inputSx = { '& .MuiInputBase-input': { py: 0.6, px: 0.75, fontSize: 13 } };

export default function OpeningStockManualGrid({ facets, canSave, onSaved }) {
  const [rows, setRows] = useState(readDraft);
  const [results, setResults] = useState({}); // row id → check result
  const [autoBarcode, setAutoBarcode] = useState(false);
  const [busy, setBusy] = useState('');
  const [focus, setFocus] = useState(null); // { row, col } to focus after render
  const gridRef = useRef(null);
  const tokenRef = useRef(null);

  useEffect(() => {
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(rows.filter((r) => !isBlank(r)))); } catch { /* ignore */ }
  }, [rows]);

  useEffect(() => {
    if (!focus) return;
    const el = gridRef.current?.querySelector(`[data-os-row="${focus.row}"][data-os-col="${focus.col}"]`);
    if (el) { el.focus(); el.select?.(); }
    setFocus(null);
  }, [focus, rows.length]);

  const filled = useMemo(() => rows.filter((r) => !isBlank(r)), [rows]);
  const sum = useMemo(() => totals(filled), [filled]);
  const errorCount = filled.filter((r) => results[r.id]?.status === 'error').length;

  const setCell = (id, key, value) => {
    tokenRef.current = null; // a changed grid is a new save
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, [key]: value } : r)));
    setResults((res) => (res[id] ? { ...res, [id]: undefined } : res));
  };
  const addRow = () => { setRows((rs) => [...rs, blankRow()]); setFocus({ row: rows.length, col: 0 }); };
  const removeRow = (idx) => {
    tokenRef.current = null;
    setRows((rs) => (rs.length > 1 ? rs.filter((_, i) => i !== idx) : [blankRow()]));
    setFocus({ row: Math.max(0, idx - 1), col: 0 });
  };
  const clearAll = () => {
    if (filled.length && !window.confirm('Clear every row in the grid?')) return;
    tokenRef.current = null;
    setRows([blankRow(), blankRow(), blankRow()]);
    setResults({});
  };

  const onKeyDown = (e, rowIdx, colIdx) => {
    const last = OPENING_FIELDS.length - 1;
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        if (colIdx > 0) setFocus({ row: rowIdx, col: colIdx - 1 });
        else if (rowIdx > 0) setFocus({ row: rowIdx - 1, col: last });
        return;
      }
      if (colIdx < last) { setFocus({ row: rowIdx, col: colIdx + 1 }); return; }
      if (rowIdx === rows.length - 1) setRows((rs) => [...rs, blankRow()]);
      setFocus({ row: rowIdx + 1, col: 0 });
    } else if (e.key === 'ArrowDown' && !e.altKey) {
      e.preventDefault();
      if (rowIdx === rows.length - 1) setRows((rs) => [...rs, blankRow()]);
      setFocus({ row: rowIdx + 1, col: colIdx });
    } else if (e.key === 'ArrowUp' && !e.altKey && rowIdx > 0) {
      e.preventDefault();
      setFocus({ row: rowIdx - 1, col: colIdx });
    } else if (e.key === 'Delete' && e.ctrlKey) {
      e.preventDefault();
      removeRow(rowIdx);
    } else if ((e.key === 's' || e.key === 'S') && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      save();
    }
  };

  const payload = () => filled.map((r) => ({
    name: r.name, barcode: r.barcode, category: r.category, brand: r.brand,
    quantity: r.quantity, cost_price: r.cost_price, mrp: r.mrp, row_number: rows.indexOf(r) + 1,
  }));
  const applyResults = (list) => {
    const byId = {};
    (list || []).forEach((res) => { const r = filled[res.index]; if (r) byId[r.id] = res; });
    setResults(byId);
    return byId;
  };

  const check = async () => {
    if (!filled.length) { notify('Type at least one item first.'); return; }
    setBusy('check');
    try {
      const data = await validateOpeningRows(payload());
      applyResults(data.results);
      const s = data.summary;
      notify(s.error ? `${s.error} row(s) need fixing before saving.` : `All ${s.total} row(s) are ready to save.`);
    } catch (err) {
      notify(apiErrorMessage(err));
    } finally { setBusy(''); }
  };

  const save = async () => {
    if (busy || !canSave) return;
    if (!filled.length) { notify('Type at least one item first.'); return; }
    setBusy('save');
    if (!tokenRef.current) tokenRef.current = newClientToken();
    try {
      const data = await saveOpeningStock('manual', { rows: payload(), auto_barcode: autoBarcode, client_token: tokenRef.current });
      tokenRef.current = null;
      setRows([blankRow(), blankRow(), blankRow()]);
      setResults({});
      try { localStorage.removeItem(DRAFT_KEY); } catch { /* ignore */ }
      onSaved?.(data.batch);
    } catch (err) {
      if (err?.response?.status === 400 && err.response.data?.results) {
        tokenRef.current = null;
        applyResults(err.response.data.results);
      }
      notify(apiErrorMessage(err));
    } finally { setBusy(''); }
  };

  return (
    <Card variant="outlined" sx={{ borderRadius: 3 }}>
      <Box sx={{ p: 1.5, display: 'flex', gap: 1, alignItems: 'center', flexWrap: 'wrap', borderBottom: '1px solid', borderColor: 'divider' }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ mr: 'auto' }}>Fast Manual Entry</Typography>
        <Typography variant="caption" color="text.secondary">
          Enter = next cell / new row · Shift+Enter = back · ↑↓ = row · Ctrl+Del = remove row · Ctrl+S = save
        </Typography>
      </Box>
      <TableContainer ref={gridRef} sx={{ maxHeight: '60vh' }} data-nav-scope="opening-stock-grid">
        <Table size="small" stickyHeader sx={{ minWidth: 980 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ ...cellSx, width: 36, fontWeight: 800 }}>#</TableCell>
              {OPENING_FIELDS.map((f) => (
                <TableCell key={f.key} sx={{ ...cellSx, fontWeight: 800, whiteSpace: 'nowrap' }} align={f.numeric ? 'right' : 'left'}>
                  {f.label}{f.required && <Box component="span" sx={{ color: 'error.main' }}> *</Box>}
                </TableCell>
              ))}
              <TableCell sx={{ ...cellSx, fontWeight: 800, width: 110 }} align="right">Value ₹</TableCell>
              <TableCell sx={{ ...cellSx, width: 80, fontWeight: 800 }}>Check</TableCell>
              <TableCell sx={{ width: 40 }} />
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((r, ri) => {
              const res = results[r.id];
              const msgs = resultMessages(res);
              return (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ ...cellSx, color: 'text.secondary', fontSize: 12 }}>{ri + 1}</TableCell>
                  {OPENING_FIELDS.map((f, ci) => (
                    <TableCell key={f.key} sx={{ ...cellSx, minWidth: f.key === 'name' ? 200 : f.numeric ? 90 : 120 }}>
                      <TextField
                        size="small" fullWidth value={r[f.key]} sx={inputSx}
                        error={Boolean(res?.errors?.[f.key])}
                        onChange={(e) => setCell(r.id, f.key, e.target.value)}
                        inputProps={{
                          'data-os-row': ri, 'data-os-col': ci, 'data-own-enter': 'true', maxLength: f.max,
                          'aria-label': `${f.label} row ${ri + 1}`, inputMode: f.money ? 'decimal' : f.numeric ? 'numeric' : 'text',
                          list: f.list ? `os-dl-${f.list}` : undefined, spellCheck: f.mono ? false : undefined,
                          style: { textAlign: f.numeric ? 'right' : 'left', fontFamily: f.mono ? 'monospace' : undefined },
                          onKeyDown: (e) => onKeyDown(e, ri, ci),
                        }}
                      />
                    </TableCell>
                  ))}
                  <TableCell sx={{ ...cellSx, fontSize: 12.5, whiteSpace: 'nowrap' }} align="right">
                    {isBlank(r) ? '' : money(lineValue(r))}
                  </TableCell>
                  <TableCell sx={cellSx}>
                    {res && (
                      <Tooltip title={msgs.length ? msgs.join('\n') : 'Ready to save'} arrow>
                        <Chip size="small" label={ROW_STATUS[res.status]?.label} color={ROW_STATUS[res.status]?.color}
                          variant={res.status === 'ok' ? 'outlined' : 'filled'} sx={{ fontWeight: 700, height: 22 }} />
                      </Tooltip>
                    )}
                  </TableCell>
                  <TableCell sx={{ p: 0.25 }}>
                    <IconButton size="small" aria-label={`Remove row ${ri + 1}`} onClick={() => removeRow(ri)} tabIndex={-1}>
                      <DeleteIcon fontSize="small" />
                    </IconButton>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <datalist id="os-dl-categories">{(facets?.categories || []).map((c) => <option key={c} value={c} />)}</datalist>
      <datalist id="os-dl-brands">{(facets?.brands || []).map((b) => <option key={b} value={b} />)}</datalist>

      <Box sx={{ p: 1.5, display: 'flex', gap: 1.5, alignItems: 'center', flexWrap: 'wrap', borderTop: '1px solid', borderColor: 'divider' }}>
        <Button startIcon={<AddIcon />} onClick={addRow}>Add Row</Button>
        <Button startIcon={<ClearIcon />} onClick={clearAll} color="inherit">Clear</Button>
        <FormControlLabel
          control={<Checkbox size="small" checked={autoBarcode} onChange={(e) => setAutoBarcode(e.target.checked)} />}
          label={<Typography variant="body2">Auto-generate barcodes for blank codes</Typography>} />
        <Stack direction="row" spacing={2} sx={{ ml: 'auto' }} alignItems="center">
          <Typography variant="body2"><b>{filled.length}</b> item{filled.length === 1 ? '' : 's'}</Typography>
          <Typography variant="body2">Qty <b>{sum.qty.toLocaleString('en-IN')}</b></Typography>
          <Typography variant="body2">Value <b>{money(sum.value)}</b></Typography>
          <Button variant="outlined" startIcon={busy === 'check' ? <CircularProgress size={16} /> : <CheckIcon />}
            disabled={Boolean(busy) || !filled.length} onClick={check}>Check</Button>
          <Button variant="contained" startIcon={busy === 'save' ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}
            disabled={Boolean(busy) || !filled.length || !canSave} onClick={save} sx={{ fontWeight: 800 }}>
            Save Opening Stock
          </Button>
        </Stack>
      </Box>
      {errorCount > 0 && (
        <Alert severity="error" sx={{ borderRadius: 0 }}>
          {errorCount} row(s) have errors — hover the red “Error” chip to see why. Nothing was saved.
        </Alert>
      )}
    </Card>
  );
}
