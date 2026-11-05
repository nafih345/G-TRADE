import React, { useState } from 'react';
import { keepPreviousData, useMutation, useQuery } from '@tanstack/react-query';
import axios from 'axios';
import {
  Alert, Box, Button, Card, Chip, Grid, InputAdornment, Stack, Tab, Table, TableBody, TableCell,
  TableContainer, TableHead, TablePagination, TableRow, Tabs, TextField, Tooltip, Typography
} from '@mui/material';
import { Search as SearchIcon } from '@mui/icons-material';
import { useDebounce } from '../../../hooks/useDebounce';
import ImportBarcodeReview from './ImportBarcodeReview';

const PAGE_SIZE = 50;

// What the import will do with each row (ImportPreviewRow.kind).
export const PREVIEW_KIND_META = {
  NEW: { label: 'New', color: 'success', bg: 'transparent' },
  UPDATE: { label: 'Update', color: 'info', bg: 'transparent' },
  DUPLICATE: { label: 'Duplicate', color: 'warning', bg: 'rgba(245, 158, 11, 0.08)' },
  ERROR: { label: 'Invalid', color: 'error', bg: 'rgba(239, 68, 68, 0.08)' },
};

const FILTERS = [
  { value: '', label: 'All Rows', count: (s) => s.total },
  { value: 'valid', label: 'Will Import', count: (s) => s.valid },
  { value: 'new', label: 'New', count: (s) => s.new },
  { value: 'update', label: 'Updates', count: (s) => s.update },
  { value: 'duplicate', label: 'Duplicates', count: (s) => s.duplicate },
  { value: 'error', label: 'Invalid', count: (s) => s.error },
];

function Stat({ label, value, color, hint }) {
  return (
    <Grid item xs={6} sm={4} md={2}>
      <Tooltip title={hint || ''} placement="top-start">
        <Box>
          <Typography variant="caption" color="text.secondary">{label}</Typography>
          <Typography variant="h6" fontWeight={800} color={color}>{(value || 0).toLocaleString()}</Typography>
        </Box>
      </Tooltip>
    </Grid>
  );
}

/**
 * Stage two of an import: every row of the uploaded file, as the server's dry run judged it,
 * laid out in the file's own columns. Nothing is in the database yet; Start Import is the
 * only thing that writes, and it stays disabled while no row can be imported.
 */
export default function ImportPreviewReview({ batch, onConfirmed, onCancelled }) {
  const [view, setView] = useState('rows');
  const [kind, setKind] = useState('');
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [error, setError] = useState(null);
  const url = `/api/import/${batch.id}`;

  const { data, isFetching, isLoading } = useQuery({
    queryKey: ['import-preview', batch.id, kind, page, debouncedSearch],
    queryFn: async () => (await axios.get(`${url}/preview/`, {
      params: { page: page + 1, page_size: PAGE_SIZE, kind, search: debouncedSearch },
    })).data,
    placeholderData: keepPreviousData,
  });

  const fail = (fallback) => (e) => setError(e.response?.data?.error || fallback);

  const confirm = useMutation({
    mutationFn: () => axios.post(`${url}/confirm/`),
    onSuccess: () => onConfirmed?.(),
    onError: fail('Could not start the import. Please try again.'),
  });

  const cancel = useMutation({
    mutationFn: () => axios.delete(`${url}/?delete_mode=option1`),
    onSuccess: () => onCancelled?.(),
    onError: fail('Could not cancel this import. Please try again.'),
  });

  const busy = confirm.isPending || cancel.isPending;
  const summary = data?.summary || {};
  const headers = data?.column_headers || [];
  const rows = data?.results || [];
  const skipped = (summary.duplicate || 0) + (summary.error || 0);
  const ready = !isLoading && data?.status === 'AWAITING_CONFIRMATION' && (summary.valid || 0) > 0;

  return (
    <Card variant="outlined" sx={{ p: 3, borderRadius: 3, mb: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h6" fontWeight={800}>Data Preview — {batch.batch_number}</Typography>
          <Typography variant="body2" color="text.secondary">
            {batch.file_name}. Nothing has been written to the database yet. Check the rows, then start the import.
          </Typography>
        </Box>
        <Chip label="WAITING FOR YOUR REVIEW" color="warning" sx={{ fontWeight: 800 }} />
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Stat label="Rows in File" value={summary.total} hint="Blank rows are not counted" />
        <Stat label="New Products" value={summary.new} color="success.main" />
        <Stat label="Update Existing" value={summary.update} color="info.main"
          hint="Details are updated; their stock is not changed. The file's quantity goes to Stock Overview for review." />
        <Stat label="Duplicates (Skipped)" value={summary.duplicate} color="warning.main"
          hint="Rows repeating an earlier row of the file, or products that already exist under Skip Duplicates" />
        <Stat label="Invalid (Skipped)" value={summary.error} color="error.main" />
        <Stat label="Will Import" value={summary.valid} color="primary.main" />
      </Grid>

      {summary.valid === 0 && !isLoading && (
        <Alert severity="error" sx={{ mb: 2 }}>No row of this file can be imported. Fix the rows marked Invalid and upload the file again.</Alert>
      )}
      {skipped > 0 && summary.valid > 0 && (
        <Alert severity="warning" sx={{ mb: 2 }}>
          {skipped.toLocaleString()} row{skipped === 1 ? '' : 's'} will be skipped. Duplicate and invalid rows are never imported.
        </Alert>
      )}
      {summary.update > 0 && (
        <Alert severity="info" sx={{ mb: 2 }}>
          {summary.update.toLocaleString()} row{summary.update === 1 ? ' matches a product' : 's match products'} already in the catalogue.
          Their current stock stays as it is; after the import, review the file's quantities under Inventory → Stock Overview → Excel Imports.
        </Alert>
      )}

      {batch.auto_barcode && (
        <Tabs value={view} onChange={(e, v) => setView(v)} sx={{ mb: 1.5, borderBottom: 1, borderColor: 'divider' }}>
          <Tab value="rows" label="Rows" sx={{ fontWeight: 700, textTransform: 'none' }} />
          <Tab value="barcodes" label="Generated Barcodes" sx={{ fontWeight: 700, textTransform: 'none' }} />
        </Tabs>
      )}

      {view === 'barcodes' && batch.auto_barcode ? (
        <ImportBarcodeReview batch={batch} embedded />
      ) : (
        <>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1.5 }}>
            {FILTERS.map((f) => (
              <Chip
                key={f.value || 'all'} clickable
                label={`${f.label} (${(f.count(summary) || 0).toLocaleString()})`}
                color={kind === f.value ? 'primary' : 'default'} variant={kind === f.value ? 'filled' : 'outlined'}
                onClick={() => { setKind(f.value); setPage(0); }} sx={{ fontWeight: 700 }}
              />
            ))}
            <TextField
              size="small" placeholder="Search name, code or note..." value={search} sx={{ flex: 1, minWidth: 220 }}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
            />
          </Stack>

          <TableContainer sx={{ border: '1px solid #cbd5e1', borderRadius: 2, maxHeight: 520, opacity: isFetching ? 0.7 : 1 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 800, whiteSpace: 'nowrap' }}>Row</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Result</TableCell>
                  <TableCell sx={{ fontWeight: 800, minWidth: 200 }}>Note</TableCell>
                  {headers.map((h) => (
                    <TableCell key={h} sx={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow><TableCell colSpan={3 + headers.length} align="center" sx={{ py: 4 }}>
                    <Typography variant="body2" color="text.secondary">{isLoading ? 'Loading preview...' : 'No rows match.'}</Typography>
                  </TableCell></TableRow>
                ) : rows.map((r) => {
                  const meta = PREVIEW_KIND_META[r.kind] || PREVIEW_KIND_META.NEW;
                  return (
                    <TableRow key={r.id} hover sx={{ bgcolor: meta.bg }}>
                      <TableCell sx={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>
                        {r.row_number}
                        {r.sheet_name && <Typography component="span" variant="caption" color="text.secondary"> · {r.sheet_name}</Typography>}
                      </TableCell>
                      <TableCell><Chip size="small" label={meta.label} color={meta.color} sx={{ fontWeight: 800 }} /></TableCell>
                      <TableCell sx={{ fontSize: '0.8rem', color: r.kind === 'ERROR' ? 'error.main' : 'text.secondary' }}>
                        {r.message}
                        {r.kind === 'UPDATE' && r.file_stock != null && r.existing_stock != null && r.file_stock !== r.existing_stock && (
                          <Typography variant="caption" sx={{ display: 'block', color: 'info.main' }}>
                            Stock now {r.existing_stock}, file says {r.file_stock}: reviewed in Stock Overview
                          </Typography>
                        )}
                      </TableCell>
                      {headers.map((h) => (
                        <TableCell key={h} sx={{ fontSize: '0.8rem', whiteSpace: 'nowrap' }}>{r.cells?.[h] ?? ''}</TableCell>
                      ))}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div" count={data?.count || 0} page={page} rowsPerPage={PAGE_SIZE}
            rowsPerPageOptions={[PAGE_SIZE]} onPageChange={(e, next) => setPage(next)}
          />
        </>
      )}

      <Stack direction="row" spacing={1.5} justifyContent="flex-end" alignItems="center" sx={{ mt: 1.5 }}>
        <Button disabled={busy} onClick={() => cancel.mutate()} sx={{ textTransform: 'none', fontWeight: 700 }}>
          Cancel Import
        </Button>
        <Button variant="contained" disabled={busy || !ready} onClick={() => confirm.mutate()} sx={{ fontWeight: 800, px: 3 }}>
          {confirm.isPending ? 'Starting...' : `Start Import (${(summary.valid || 0).toLocaleString()} rows)`}
        </Button>
      </Stack>
    </Card>
  );
}
