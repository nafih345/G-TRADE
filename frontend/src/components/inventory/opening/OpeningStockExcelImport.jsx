// Opening Stock → Excel Import, in three steps:
//   1. Upload  — the server reads the sheet as it is (.xlsx / .xls / .csv); nothing is saved.
//   2. Columns — tick the columns to bring in and say what each one is; everything else is ignored.
//                The server's guess from the header names is pre-filled.
//   3. Preview — every row checked by the server (errors, duplicate barcodes, repeats); tick the rows
//                to load. Error rows can't be ticked; duplicates start unticked.
// "Start Import to Opening Stock" saves the ticked rows as one Opening Stock batch.
import React, { useMemo, useRef, useState } from 'react';
import {
  Alert, Box, Button, Card, Checkbox, Chip, CircularProgress, FormControlLabel, MenuItem, Stack, Step, StepLabel,
  Stepper, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip,
  Typography,
} from '@mui/material';
import {
  CloudUpload as UploadIcon, ArrowBack as BackIcon, FactCheck as CheckIcon, PlaylistAddCheck as ImportIcon,
} from '@mui/icons-material';
import { newClientToken, parseOpeningFile, saveOpeningStock, validateOpeningRows } from '../../purchasing/stock/stockApi';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';
import { FIELD_LABEL, OPENING_FIELDS, REQUIRED_FIELDS, ROW_STATUS, money, resultMessages, totals } from './openingStockFields';

const STEPS = ['Upload sheet', 'Choose columns', 'Preview & import'];
const PAGE_SIZE = 100;
const VIEWS = [
  { value: 'all', label: 'All' },
  { value: 'selected', label: 'Selected' },
  { value: 'ready', label: 'Ready', test: (s) => s === 'ok' || s === 'warning' },
  { value: 'duplicate', label: 'Duplicates', test: (s, r) => s === 'duplicate' || r?.duplicate },
  { value: 'error', label: 'Errors', test: (s) => s === 'error' },
];

// Column index → { include, field } from the server's header guess.
const initialColumns = (sheet) => {
  const byIndex = Object.fromEntries(Object.entries(sheet.suggested_mapping || {}).map(([f, i]) => [i, f]));
  return sheet.headers.map((_, i) => ({ include: Boolean(byIndex[i]), field: byIndex[i] || '' }));
};

export default function OpeningStockExcelImport({ canSave, onSaved }) {
  const [step, setStep] = useState(0);
  const [parsed, setParsed] = useState(null); // { file_name, sheets }
  const [sheetIdx, setSheetIdx] = useState(0);
  const [columns, setColumns] = useState([]);
  const [rows, setRows] = useState([]); // mapped rows for the preview
  const [results, setResults] = useState([]);
  const [selected, setSelected] = useState(() => new Set());
  const [view, setView] = useState('all');
  const [page, setPage] = useState(0);
  const [autoBarcode, setAutoBarcode] = useState(false);
  const [busy, setBusy] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef(null);
  const tokenRef = useRef(null);

  const sheet = parsed?.sheets?.[sheetIdx];
  const mappedFields = useMemo(() => {
    const out = {};
    columns.forEach((c, i) => { if (c.include && c.field) out[c.field] = i; });
    return out;
  }, [columns]);
  const missingRequired = REQUIRED_FIELDS.filter((f) => mappedFields[f] === undefined);
  const unmappedIncluded = columns.filter((c) => c.include && !c.field).length;
  const shownFields = OPENING_FIELDS.filter((f) => mappedFields[f.key] !== undefined);

  // -- step 1 --------------------------------------------------------------------------------
  const readFile = async (file) => {
    if (!file) return;
    setBusy('parse');
    try {
      const data = await parseOpeningFile(file);
      setParsed(data);
      setSheetIdx(0);
      setColumns(initialColumns(data.sheets[0]));
      setStep(1);
    } catch (err) {
      notify(apiErrorMessage(err, 'This file could not be read.'));
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  };
  const chooseSheet = (i) => { setSheetIdx(i); setColumns(initialColumns(parsed.sheets[i])); };

  // -- step 2 --------------------------------------------------------------------------------
  const setColumn = (i, patch) => setColumns((cols) => cols.map((c, j) => {
    if (j === i) {
      const next = { ...c, ...patch };
      if (patch.field) next.include = true;
      return next;
    }
    // One column per field: picking a field elsewhere frees it here.
    return patch.field && c.field === patch.field ? { ...c, field: '', include: false } : c;
  }));
  const allIncluded = columns.length > 0 && columns.every((c) => c.include);

  const buildPreview = async () => {
    const mapped = sheet.rows.map((r) => {
      const out = { row_number: r.row_number };
      OPENING_FIELDS.forEach((f) => { const i = mappedFields[f.key]; out[f.key] = i === undefined ? '' : (r.cells[i] ?? ''); });
      return out;
    });
    setBusy('check');
    try {
      const data = await validateOpeningRows(mapped);
      setRows(mapped);
      setResults(data.results);
      setSelected(new Set(data.results.filter((x) => x.status === 'ok' || x.status === 'warning').map((x) => x.index)));
      setView('all');
      setPage(0);
      tokenRef.current = null;
      setStep(2);
    } catch (err) {
      notify(apiErrorMessage(err));
    } finally { setBusy(''); }
  };

  // -- step 3 --------------------------------------------------------------------------------
  const visible = useMemo(() => {
    const v = VIEWS.find((x) => x.value === view);
    return results.filter((res) => (view === 'selected' ? selected.has(res.index) : !v?.test || v.test(res.status, res)));
  }, [results, view, selected]);
  const pageRows = visible.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  const selectable = (res) => res.status !== 'error';
  const visibleSelectable = visible.filter(selectable);
  const allVisibleOn = visibleSelectable.length > 0 && visibleSelectable.every((res) => selected.has(res.index));
  const someVisibleOn = visibleSelectable.some((res) => selected.has(res.index));
  const toggleAllVisible = () => setSelected((s) => {
    const next = new Set(s);
    visibleSelectable.forEach((res) => (allVisibleOn ? next.delete(res.index) : next.add(res.index)));
    return next;
  });
  const toggle = (i) => { tokenRef.current = null; setSelected((s) => { const n = new Set(s); n.has(i) ? n.delete(i) : n.add(i); return n; }); };
  const counts = useMemo(() => Object.fromEntries(VIEWS.map((v) => [v.value,
    v.value === 'all' ? results.length : v.value === 'selected' ? selected.size : results.filter((r) => v.test(r.status, r)).length])), [results, selected]);
  const chosen = useMemo(() => [...selected].sort((a, b) => a - b).map((i) => rows[i]).filter(Boolean), [selected, rows]);
  const sum = useMemo(() => totals(chosen), [chosen]);

  const commit = async () => {
    if (!chosen.length || busy) return;
    if (!window.confirm(`Add ${chosen.length} item(s) — ${sum.qty.toLocaleString('en-IN')} units, ${money(sum.value)} at cost — as opening stock?`)) return;
    setBusy('save');
    if (!tokenRef.current) tokenRef.current = newClientToken();
    const order = [...selected].sort((a, b) => a - b);
    try {
      const data = await saveOpeningStock('import', {
        rows: chosen, auto_barcode: autoBarcode, client_token: tokenRef.current, file_name: parsed?.file_name || '',
      });
      tokenRef.current = null;
      onSaved?.(data.batch, { redirect: true });
      reset();
    } catch (err) {
      if (err?.response?.status === 400 && err.response.data?.results) {
        // Something changed since the preview (e.g. a barcode was taken meanwhile): show it in place.
        tokenRef.current = null;
        const fresh = new Map(err.response.data.results.map((res) => [order[res.index], { ...res, index: order[res.index] }]));
        setResults((rs) => rs.map((res) => fresh.get(res.index) || res));
        setSelected((s) => new Set([...s].filter((i) => fresh.get(i)?.status !== 'error')));
        setView('error');
        setPage(0);
      }
      notify(apiErrorMessage(err));
    } finally { setBusy(''); }
  };

  const reset = () => {
    setStep(0); setParsed(null); setColumns([]); setRows([]); setResults([]); setSelected(new Set());
  };

  return (
    <Card variant="outlined" sx={{ borderRadius: 3, p: 2 }}>
      <Stepper activeStep={step} sx={{ mb: 2.5 }}>
        {STEPS.map((s) => <Step key={s}><StepLabel>{s}</StepLabel></Step>)}
      </Stepper>

      {step === 0 && (
        <Box
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); readFile(e.dataTransfer.files?.[0]); }}
          onClick={() => !busy && fileRef.current?.click()}
          role="button" tabIndex={0}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileRef.current?.click(); } }}
          sx={{
            border: '2px dashed', borderColor: dragOver ? 'primary.main' : 'divider', borderRadius: 3, p: 6,
            textAlign: 'center', cursor: 'pointer', bgcolor: dragOver ? 'action.hover' : 'transparent',
          }}>
          {busy === 'parse' ? <CircularProgress /> : <UploadIcon sx={{ fontSize: 48, color: 'primary.main' }} />}
          <Typography variant="h6" fontWeight={800} sx={{ mt: 1 }}>
            {busy === 'parse' ? 'Reading the sheet…' : 'Drop the stock sheet here, or click to choose'}
          </Typography>
          <Typography variant="body2" color="text.secondary">
            .xlsx, .xls or .csv · up to 5,000 rows per load · any column layout — you pick the columns next
          </Typography>
          <input ref={fileRef} type="file" hidden accept=".xlsx,.xls,.csv" onChange={(e) => readFile(e.target.files?.[0])} />
        </Box>
      )}

      {step === 1 && sheet && (
        <>
          <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            <Typography variant="body2"><b>{parsed.file_name}</b> · {sheet.rows.length.toLocaleString('en-IN')} data rows · header on row {sheet.header_row}</Typography>
            {parsed.sheets.length > 1 && (
              <TextField select size="small" label="Sheet" value={sheetIdx} onChange={(e) => chooseSheet(Number(e.target.value))} sx={{ minWidth: 180 }}>
                {parsed.sheets.map((s, i) => <MenuItem key={s.name} value={i}>{s.name} ({s.rows.length})</MenuItem>)}
              </TextField>
            )}
          </Stack>
          {sheet.truncated && <Alert severity="warning" sx={{ mb: 1.5 }}>Only the first 5,000 rows were read. Load the rest as a second file.</Alert>}
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Tick the columns to import and choose what each one is. Unticked columns are ignored.
            Item Name, Opening Qty and Cost Price are required.
          </Typography>
          <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, maxHeight: '55vh' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" checked={allIncluded} indeterminate={!allIncluded && columns.some((c) => c.include)}
                      onChange={() => setColumns((cols) => cols.map((c) => ({ ...c, include: !allIncluded })))}
                      inputProps={{ 'aria-label': 'Import every column' }} />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Column in sheet</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Sample values</TableCell>
                  <TableCell sx={{ fontWeight: 800, width: 220 }}>Import as</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {sheet.headers.map((h, i) => {
                  const c = columns[i] || {};
                  const samples = sheet.rows.slice(0, 3).map((r) => r.cells[i]).filter(Boolean);
                  return (
                    <TableRow key={h} hover selected={c.include}>
                      <TableCell padding="checkbox">
                        <Checkbox size="small" checked={Boolean(c.include)} onChange={(e) => setColumn(i, { include: e.target.checked })}
                          inputProps={{ 'aria-label': `Import column ${h}` }} />
                      </TableCell>
                      <TableCell sx={{ fontWeight: 700 }}>{h}</TableCell>
                      <TableCell sx={{ color: 'text.secondary', fontSize: 12.5, maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {samples.join(' · ') || '—'}
                      </TableCell>
                      <TableCell>
                        <TextField select size="small" fullWidth value={c.field || ''} disabled={!c.include}
                          error={Boolean(c.include && !c.field)} onChange={(e) => setColumn(i, { field: e.target.value })}
                          SelectProps={{ displayEmpty: true }}>
                          <MenuItem value=""><em>Choose…</em></MenuItem>
                          {OPENING_FIELDS.map((f) => <MenuItem key={f.key} value={f.key}>{f.label}{f.required ? ' *' : ''}</MenuItem>)}
                        </TextField>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
          {(missingRequired.length > 0 || unmappedIncluded > 0) && (
            <Alert severity="info" sx={{ mt: 1.5 }}>
              {missingRequired.length > 0 && <>Still needed: {missingRequired.map((f) => FIELD_LABEL[f]).join(', ')}. </>}
              {unmappedIncluded > 0 && <>{unmappedIncluded} ticked column(s) have no “Import as” yet.</>}
            </Alert>
          )}
          <Stack direction="row" spacing={1} justifyContent="space-between" sx={{ mt: 2 }}>
            <Button startIcon={<BackIcon />} onClick={reset}>Choose another file</Button>
            <Button variant="contained" startIcon={busy === 'check' ? <CircularProgress size={16} color="inherit" /> : <CheckIcon />}
              disabled={Boolean(busy) || missingRequired.length > 0 || unmappedIncluded > 0 || !sheet.rows.length}
              onClick={buildPreview} sx={{ fontWeight: 800 }}>
              Preview & Validate
            </Button>
          </Stack>
        </>
      )}

      {step === 2 && (
        <>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            {VIEWS.map((v) => (
              <Chip key={v.value} label={`${v.label} (${counts[v.value]})`} onClick={() => { setView(v.value); setPage(0); }}
                color={view === v.value ? 'primary' : v.value === 'error' && counts.error ? 'error' : 'default'}
                variant={view === v.value ? 'filled' : 'outlined'} sx={{ fontWeight: 700 }} />
            ))}
          </Stack>
          {counts.error > 0 && (
            <Alert severity="warning" sx={{ mb: 1.5 }}>
              {counts.error} row(s) have errors and will be skipped. Fix them in the sheet and import them later if needed.
            </Alert>
          )}
          <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, maxHeight: '55vh' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell padding="checkbox">
                    <Checkbox size="small" checked={allVisibleOn} indeterminate={!allVisibleOn && someVisibleOn}
                      disabled={!visibleSelectable.length} onChange={toggleAllVisible} inputProps={{ 'aria-label': 'Select all shown rows' }} />
                  </TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Row</TableCell>
                  {shownFields.map((f) => <TableCell key={f.key} sx={{ fontWeight: 800 }} align={f.numeric ? 'right' : 'left'}>{f.label}</TableCell>)}
                  <TableCell sx={{ fontWeight: 800 }}>Status</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pageRows.map((res) => {
                  const r = rows[res.index];
                  const msgs = resultMessages(res);
                  const meta = ROW_STATUS[res.status];
                  return (
                    <TableRow key={res.index} hover selected={selected.has(res.index)}
                      sx={res.status === 'error' ? { bgcolor: (t) => (t.palette.mode === 'dark' ? 'rgba(239,68,68,0.08)' : '#fef2f2') } : undefined}>
                      <TableCell padding="checkbox">
                        <Checkbox size="small" checked={selected.has(res.index)} disabled={!selectable(res)} onChange={() => toggle(res.index)}
                          inputProps={{ 'aria-label': `Import row ${r.row_number}` }} />
                      </TableCell>
                      <TableCell sx={{ color: 'text.secondary' }}>{r.row_number}</TableCell>
                      {shownFields.map((f) => (
                        <TableCell key={f.key} align={f.numeric ? 'right' : 'left'}
                          sx={{ color: res.errors?.[f.key] ? 'error.main' : undefined, fontWeight: res.errors?.[f.key] ? 700 : undefined, fontFamily: f.mono ? 'monospace' : undefined }}>
                          {r[f.key] || <Box component="span" sx={{ color: 'text.disabled' }}>—</Box>}
                        </TableCell>
                      ))}
                      <TableCell sx={{ minWidth: 200 }}>
                        <Stack direction="row" spacing={1} alignItems="center">
                          <Chip size="small" label={res.duplicate && res.status === 'error' ? 'Duplicate' : meta?.label} color={meta?.color}
                            variant={res.status === 'ok' ? 'outlined' : 'filled'} sx={{ fontWeight: 700, height: 22 }} />
                          {msgs.length > 0 && (
                            <Tooltip title={msgs.join('\n')} arrow>
                              <Typography variant="caption" color="text.secondary" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 260 }}>
                                {msgs[0]}
                              </Typography>
                            </Tooltip>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
                {!pageRows.length && (
                  <TableRow><TableCell colSpan={shownFields.length + 3} align="center" sx={{ py: 4, color: 'text.secondary' }}>No rows in this view.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
          {visible.length > PAGE_SIZE && (
            <TablePagination component="div" count={visible.length} page={page} rowsPerPage={PAGE_SIZE} rowsPerPageOptions={[PAGE_SIZE]}
              onPageChange={(_, p) => setPage(p)} />
          )}
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 2 }}>
            <Button startIcon={<BackIcon />} onClick={() => setStep(1)} disabled={Boolean(busy)}>Back to columns</Button>
            <FormControlLabel
              control={<Checkbox size="small" checked={autoBarcode} onChange={(e) => setAutoBarcode(e.target.checked)} />}
              label={<Typography variant="body2">Auto-generate barcodes for blank codes</Typography>} />
            <Box sx={{ ml: 'auto' }} />
            <Typography variant="body2"><b>{chosen.length.toLocaleString('en-IN')}</b> selected · Qty <b>{sum.qty.toLocaleString('en-IN')}</b> · Value <b>{money(sum.value)}</b></Typography>
            <Button variant="contained" color="success" startIcon={busy === 'save' ? <CircularProgress size={16} color="inherit" /> : <ImportIcon />}
              disabled={Boolean(busy) || !chosen.length || !canSave} onClick={commit} sx={{ fontWeight: 800 }}>
              Start Import to Opening Stock
            </Button>
          </Stack>
        </>
      )}
    </Card>
  );
}
