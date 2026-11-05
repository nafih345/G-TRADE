import React, { useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography, FormControlLabel, Checkbox
} from '@mui/material';
import { UploadFile as UploadIcon, Download as DownloadIcon } from '@mui/icons-material';
import { downloadBlob, rowsToCsv } from './variantUtils';

const API = '/api/products/variant-groups/';
const PREVIEW_ROWS = 200;

// Excel import for Add Multiple Items: upload → server parses + validates (nothing written) →
// preview of the sheet exactly as the file lays it out (its own headers and cells) with row
// checkboxes → either load the selected rows of one product into the grid for review, or
// (Inventory only) import the selected valid rows. Invalid rows are never written.
export default function VariantImportDialog({ open, onClose, context, onLoadIntoGrid, onImported }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [autoBarcode, setAutoBarcode] = useState(true);
  const [selected, setSelected] = useState(() => new Set());
  const abortRef = useRef(null);

  const reset = () => { setPreview(null); setResult(null); setError(''); setSelected(new Set()); if (fileRef.current) fileRef.current.value = ''; };
  const close = () => { abortRef.current?.abort(); reset(); setBusy(false); onClose(); };

  const upload = async (file) => {
    if (!file) return;
    reset();
    setBusy(true);
    const fd = new FormData();
    fd.append('file', file);
    fd.append('context', context);
    abortRef.current = new AbortController();
    try {
      const res = await axios.post(`${API}import-preview/`, fd, { headers: { 'Content-Type': 'multipart/form-data' }, signal: abortRef.current.signal });
      setPreview(res.data);
      setSelected(new Set((res.data.groups || []).flatMap(g => g.variants.map(v => v.row_number))));
    } catch (e) {
      if (!axios.isCancel(e)) setError(e.response?.data?.detail || 'Could not read the file.');
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = async () => {
    try {
      const res = await axios.get(`${API}import-template/`, { responseType: 'blob' });
      downloadBlob(res.data, 'add-multiple-items-template.xlsx');
    } catch { setError('Could not download the template.'); }
  };

  const errorLines = () => {
    if (result) return result.errors.map(e => [e.row_number ?? '', e.product ?? '', e.field, e.message]);
    const lines = [];
    (preview?.groups || []).forEach(g => g.variants.forEach(v => Object.entries(v.errors || {}).forEach(([f, m]) => lines.push([v.row_number, g.group.name, f, m]))));
    return lines;
  };
  const downloadErrors = () => downloadBlob(rowsToCsv(['Row', 'Product', 'Field', 'Error'], errorLines()), 'import-errors.csv');

  const groups = preview?.groups || [];
  const headers = preview?.headers || [];
  // Sheet order, not product order: the preview should read like the file.
  const flat = useMemo(() => (preview?.groups || [])
    .flatMap(g => g.variants.map(v => ({ g, v })))
    .sort((a, b) => a.v.row_number - b.v.row_number), [preview]);
  const fieldByHeader = useMemo(() => Object.fromEntries(
    Object.entries(preview?.mapping || {}).filter(([, h]) => h).map(([f, h]) => [h, f.replace(/_/g, ' ')])
  ), [preview]);

  const allSelected = flat.length > 0 && selected.size === flat.length;
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(flat.map(r => r.v.row_number)));
  const toggleRow = (n) => setSelected(prev => {
    const next = new Set(prev);
    if (next.has(n)) next.delete(n); else next.add(n);
    return next;
  });
  const selectProduct = (g) => setSelected(new Set(g.variants.map(v => v.row_number)));

  // The review grid holds one product, so loading needs the selection to sit inside one.
  const selectedGroups = groups
    .map(g => ({ ...g, variants: g.variants.filter(v => selected.has(v.row_number)) }))
    .filter(g => g.variants.length);
  const selectedValid = selectedGroups.reduce((n, g) => n + g.variants.filter(v => !Object.keys(v.errors || {}).length).length, 0);

  const commit = async () => {
    setBusy(true);
    setError('');
    try {
      const payload = selectedGroups.map(g => ({ group: g.group, variants: g.variants.map(v => ({ row_number: v.row_number, data: v.data })) }));
      const res = await axios.post(`${API}import-commit/`, { context, groups: payload, auto_barcode: autoBarcode });
      setResult(res.data);
      onImported?.(res.data);
    } catch (e) {
      setError(e.response?.data?.detail || 'Import failed. Nothing was saved for the products that errored.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={busy ? undefined : close} maxWidth="lg" fullWidth PaperProps={{ 'data-own-enter': 'true' }}>
      <DialogTitle sx={{ fontWeight: 800 }}>Import items from Excel</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
            <Button variant="contained" component="label" startIcon={<UploadIcon />} disabled={busy}>
              Choose .xlsx / .xls / .csv
              <input ref={fileRef} hidden type="file" accept=".xlsx,.xls,.csv" onChange={(e) => upload(e.target.files?.[0])} />
            </Button>
            <Button startIcon={<DownloadIcon />} onClick={downloadTemplate}>Download sample template</Button>
            <Typography variant="caption" color="text.secondary">One row per variant; rows with the same Product Name become one product.</Typography>
          </Stack>
          {busy && <LinearProgress />}
          {error && <Alert severity="error">{error}</Alert>}

          {preview && !result && (
            <>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                <Chip label={`${preview.total_rows} rows parsed`} />
                <Chip variant="outlined" label={`${headers.length} column${headers.length === 1 ? '' : 's'} detected`} />
                <Chip color="primary" label={`${selected.size} selected`} />
                <Chip variant="outlined" label={`${groups.length} product${groups.length === 1 ? '' : 's'}`} />
                <Chip color="success" variant="outlined" label={`${preview.valid_rows} valid`} />
                <Chip color={preview.error_rows ? 'error' : 'default'} variant="outlined" label={`${preview.error_rows} with errors`} />
              </Stack>
              {groups.length > 1 && (
                <Stack direction="row" spacing={0.5} alignItems="center" flexWrap="wrap" useFlexGap>
                  <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ mr: 0.5 }}>SELECT ONE PRODUCT</Typography>
                  {groups.map(g => (
                    <Chip key={g.group.name} size="small" variant="outlined" clickable onClick={() => selectProduct(g)}
                      label={`${g.group.name} (${g.variants.length})`} />
                  ))}
                </Stack>
              )}
              <TableContainer sx={{ maxHeight: 380, border: 1, borderColor: 'divider', borderRadius: 2 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox">
                        <Checkbox size="small" checked={allSelected} indeterminate={selected.size > 0 && !allSelected}
                          onChange={toggleAll} inputProps={{ 'aria-label': 'Select all rows' }} />
                      </TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Row</TableCell>
                      {headers.map((h, i) => (
                        <TableCell key={`${h}-${i}`} sx={{ fontWeight: 800, whiteSpace: 'nowrap', color: fieldByHeader[h] ? undefined : 'text.secondary' }}>
                          {h || <i>(blank)</i>}
                          <Typography component="div" variant="caption" sx={{ fontWeight: 600, textTransform: 'capitalize' }}
                            color={fieldByHeader[h] ? 'primary.main' : 'text.disabled'}>
                            {fieldByHeader[h] ? `→ ${fieldByHeader[h]}` : 'not imported'}
                          </Typography>
                        </TableCell>
                      ))}
                      <TableCell sx={{ fontWeight: 800 }}>Status</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {flat.slice(0, PREVIEW_ROWS).map(({ v }) => {
                      const errs = Object.values(v.errors || {});
                      const on = selected.has(v.row_number);
                      return (
                        <TableRow key={v.row_number} hover selected={on} onClick={() => toggleRow(v.row_number)} sx={{ cursor: 'pointer' }}>
                          <TableCell padding="checkbox">
                            <Checkbox size="small" checked={on} onClick={(e) => e.stopPropagation()} onChange={() => toggleRow(v.row_number)}
                              inputProps={{ 'aria-label': `Select row ${v.row_number}` }} />
                          </TableCell>
                          <TableCell sx={{ color: 'text.secondary' }}>{v.row_number}</TableCell>
                          {headers.map((h, i) => <TableCell key={`${h}-${i}`} sx={{ whiteSpace: 'nowrap' }}>{(v.raw || [])[i] ?? ''}</TableCell>)}
                          <TableCell sx={{ color: errs.length ? 'error.main' : 'success.main', fontWeight: 600, minWidth: 160 }}>
                            {errs.length ? errs.join(' · ') : 'OK'}
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
              {flat.length > PREVIEW_ROWS && <Typography variant="caption" color="text.secondary">Showing the first {PREVIEW_ROWS} rows; Select all covers all {flat.length}.</Typography>}
              {selectedGroups.length > 1 && (
                <Typography variant="caption" color="warning.main">
                  The selection covers {selectedGroups.length} products — the review grid holds one product at a time, so pick one above to load it.
                </Typography>
              )}
              {context === 'inventory' && (
                <FormControlLabel control={<Checkbox size="small" checked={autoBarcode} onChange={(e) => setAutoBarcode(e.target.checked)} />} label="Generate barcodes for rows without one" />
              )}
            </>
          )}

          {result && (
            <Alert severity={result.failed_rows ? 'warning' : 'success'}>
              Imported {result.imported_rows} row{result.imported_rows === 1 ? '' : 's'} into {result.groups.length} product{result.groups.length === 1 ? '' : 's'}.
              {result.failed_rows ? ` ${result.failed_rows} row(s) were not imported — download the error report for details.` : ''}
            </Alert>
          )}
        </Stack>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Button onClick={close} disabled={busy}>{result ? 'Close' : 'Cancel'}</Button>
        <Stack direction="row" spacing={1}>
          {errorLines().length > 0 && <Button startIcon={<DownloadIcon />} onClick={downloadErrors}>Error report (CSV)</Button>}
          {preview && !result && (
            <Button variant={context === 'inventory' ? 'outlined' : 'contained'} disabled={busy || selectedGroups.length !== 1}
              onClick={() => { onLoadIntoGrid(selectedGroups[0]); close(); }}>
              Load {selected.size || ''} into grid to review
            </Button>
          )}
          {preview && !result && context === 'inventory' && (
            <Button variant="contained" disabled={busy || !selectedValid} onClick={commit}>
              Import {selectedValid} selected valid row{selectedValid === 1 ? '' : 's'}
            </Button>
          )}
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
