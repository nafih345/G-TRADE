import React, { useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Typography, FormControlLabel, Checkbox
} from '@mui/material';
import { UploadFile as UploadIcon, Download as DownloadIcon } from '@mui/icons-material';
import { downloadBlob, rowsToCsv, variantLabel } from './variantUtils';

const API = '/api/products/variant-groups/';
const PREVIEW_ROWS = 200;

// Excel import for Add Multiple Items: upload → server parses + validates (nothing written) →
// preview with row-level errors → either load one product into the grid for review, or
// (Inventory only) import every valid row. Invalid rows are never written.
export default function VariantImportDialog({ open, onClose, context, onLoadIntoGrid, onImported }) {
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState(null);
  const [result, setResult] = useState(null);
  const [autoBarcode, setAutoBarcode] = useState(true);
  const abortRef = useRef(null);

  const reset = () => { setPreview(null); setResult(null); setError(''); if (fileRef.current) fileRef.current.value = ''; };
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

  const commit = async () => {
    setBusy(true);
    setError('');
    try {
      const groups = preview.groups.map(g => ({ group: g.group, variants: g.variants.map(v => ({ row_number: v.row_number, data: v.data })) }));
      const res = await axios.post(`${API}import-commit/`, { context, groups, auto_barcode: autoBarcode });
      setResult(res.data);
      onImported?.(res.data);
    } catch (e) {
      setError(e.response?.data?.detail || 'Import failed. Nothing was saved for the products that errored.');
    } finally {
      setBusy(false);
    }
  };

  const groups = preview?.groups || [];
  const flat = [];
  groups.forEach(g => g.variants.forEach(v => flat.length < PREVIEW_ROWS && flat.push({ g, v })));
  const mapped = preview ? Object.entries(preview.mapping).filter(([, h]) => h) : [];

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
                <Chip label={`${preview.total_rows} rows`} />
                <Chip color="primary" label={`${groups.length} product${groups.length === 1 ? '' : 's'}`} />
                <Chip color="success" label={`${preview.valid_rows} valid`} />
                <Chip color={preview.error_rows ? 'error' : 'default'} label={`${preview.error_rows} with errors`} />
              </Stack>
              <Box>
                <Typography variant="caption" fontWeight={800} color="text.secondary">COLUMN MAPPING</Typography>
                <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                  {mapped.map(([f, h]) => <Chip key={f} size="small" variant="outlined" label={`${h} → ${f.replace(/_/g, ' ')}`} />)}
                  {(preview.unmapped_headers || []).map(h => <Chip key={h} size="small" color="warning" variant="outlined" label={`${h} (ignored)`} />)}
                </Stack>
              </Box>
              <TableContainer sx={{ maxHeight: 340, border: 1, borderColor: 'divider', borderRadius: 2 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      {['Row', 'Product', 'Variant', 'SKU', 'Barcode', 'MRP', 'Sales', 'Status'].map(h => <TableCell key={h} sx={{ fontWeight: 800 }}>{h}</TableCell>)}
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {flat.map(({ g, v }) => {
                      const errs = Object.values(v.errors || {});
                      return (
                        <TableRow key={`${g.group.name}-${v.row_number}`} sx={errs.length ? { bgcolor: 'error.light', '& td': { color: 'error.contrastText' } } : undefined}>
                          <TableCell>{v.row_number}</TableCell>
                          <TableCell>{g.group.name}</TableCell>
                          <TableCell>{v.data.name || variantLabel(v.data.attributes) || '—'}</TableCell>
                          <TableCell>{v.data.sku || <i>{v.generated_sku || 'auto'}</i>}</TableCell>
                          <TableCell>{v.data.barcode || '—'}</TableCell>
                          <TableCell>{v.data.mrp || ''}</TableCell>
                          <TableCell>{v.data.sales_price || ''}</TableCell>
                          <TableCell>{errs.length ? errs.join(' · ') : 'OK'}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
              {preview.total_rows > PREVIEW_ROWS && <Typography variant="caption" color="text.secondary">Showing the first {PREVIEW_ROWS} rows.</Typography>}
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
          {preview && !result && groups.length === 1 && (
            <Button variant="outlined" disabled={busy} onClick={() => { onLoadIntoGrid(groups[0]); close(); }}>Load into grid to review</Button>
          )}
          {preview && !result && context === 'inventory' && (
            <Button variant="contained" disabled={busy || !preview.valid_rows} onClick={commit}>
              Import {preview.valid_rows} valid row{preview.valid_rows === 1 ? '' : 's'}
            </Button>
          )}
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
