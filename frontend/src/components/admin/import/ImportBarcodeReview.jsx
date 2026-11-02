import React, { useState } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import axios from 'axios';
import {
  Alert, Box, Button, Card, Chip, Grid, IconButton, InputAdornment, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography
} from '@mui/material';
import {
  Clear as ClearIcon,
  Replay as RestoreIcon,
  Search as SearchIcon
} from '@mui/icons-material';
import { useDebounce } from '../../../hooks/useDebounce';

const PAGE_SIZE = 50;

function Stat({ label, value, color }) {
  return (
    <Grid item xs={6} sm={4} md={2}>
      <Typography variant="caption" color="text.secondary">{label}</Typography>
      <Typography variant="h6" fontWeight={800} color={color}>{(value || 0).toLocaleString()}</Typography>
    </Grid>
  );
}

function sequenceMessage(summary) {
  const { rule, first_new_code: first, last_new_code: last, stepped_over: steppedOver } = summary;
  const range = first === last ? first : `${first} to ${last}`;
  const source = rule?.source === 'file'
    ? `Continuing the series in your file (${rule.count.toLocaleString()} codes, ${rule.first_code} to ${rule.last_code}).`
    : 'Your file has no running series, so these come from the series in Barcode Settings.';
  const gaps = steppedOver > 0
    ? ` ${steppedOver.toLocaleString()} number${steppedOver === 1 ? ' is' : 's are'} already in use and will be stepped over.`
    : '';
  return `${source} New codes: ${range}.${gaps}`;
}

/**
 * The stop between upload and import when "Auto-generate missing barcodes" is on. The codes
 * shown are provisional, hence grey. Clearing a row closes the gap: every later row moves
 * up one number, so a page is always re-read from the server after a change.
 */
export default function ImportBarcodeReview({ batch, onConfirmed, onCancelled }) {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');
  const debouncedSearch = useDebounce(search, 300);
  const [error, setError] = useState(null);
  const url = `/api/import/${batch.id}`;

  const { data, isFetching } = useQuery({
    queryKey: ['import-barcode-preview', batch.id, page, debouncedSearch],
    queryFn: async () => (await axios.get(`${url}/barcode-preview/`, {
      params: { page: page + 1, page_size: PAGE_SIZE, search: debouncedSearch },
    })).data,
    placeholderData: keepPreviousData,
  });

  const fail = (fallback) => (e) => setError(e.response?.data?.error || fallback);

  const exclude = useMutation({
    mutationFn: (body) => axios.post(`${url}/barcode-preview/exclude/`, body),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['import-barcode-preview', batch.id] }),
    onError: fail('Could not change that row. Please try again.'),
  });

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

  const busy = exclude.isPending || confirm.isPending || cancel.isPending;
  const summary = data?.summary;
  const rows = data?.results || [];
  const missing = summary?.missing || 0;

  return (
    <Card variant="outlined" sx={{ p: 3, borderRadius: 3, mb: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }} flexWrap="wrap" gap={1}>
        <Box>
          <Typography variant="h6" fontWeight={800}>Review Barcodes — {batch.batch_number}</Typography>
          <Typography variant="body2" color="text.secondary">
            {batch.file_name}. Nothing has been imported yet.
          </Typography>
        </Box>
        <Chip label="WAITING FOR YOU" color="warning" sx={{ fontWeight: 800 }} />
      </Stack>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      {summary && (
        <>
          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Stat label="Rows in File" value={summary.total} />
            <Stat label="Barcode in File" value={summary.with_barcode} color="success.main" />
            <Stat label="Keep Existing Barcode" value={summary.keeps_existing} color="info.main" />
            <Stat label="Will Be Generated" value={summary.to_generate} color="primary.main" />
            <Stat label="Left Blank" value={summary.excluded} color="text.secondary" />
          </Grid>

          {summary.to_generate > 0 && <Alert severity="info" sx={{ mb: 2 }}>{sequenceMessage(summary)}</Alert>}
          {missing === 0 && (
            <Alert severity="success" sx={{ mb: 2 }}>Every row already has a barcode, so none will be generated.</Alert>
          )}
        </>
      )}

      {missing > 0 && (
        <>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mb: 1.5 }}>
            <TextField
              size="small" placeholder="Search by name or code..." value={search} sx={{ flex: 1 }}
              onChange={(e) => { setSearch(e.target.value); setPage(0); }}
              InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
            />
            <Button size="small" disabled={busy || summary?.excluded === missing} sx={{ textTransform: 'none', fontWeight: 700 }}
              onClick={() => exclude.mutate({ all: true, excluded: true })}>
              Clear All
            </Button>
            <Button size="small" disabled={busy || !summary?.excluded} sx={{ textTransform: 'none', fontWeight: 700 }}
              onClick={() => exclude.mutate({ all: true, excluded: false })}>
              Restore All
            </Button>
          </Stack>

          <TableContainer sx={{ border: '1px solid #cbd5e1', borderRadius: 2, maxHeight: 460, opacity: isFetching ? 0.7 : 1 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 800 }}>Row</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Code</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Product</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Barcode</TableCell>
                  <TableCell align="center" sx={{ fontWeight: 800, width: 64 }}>Clear</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow><TableCell colSpan={5} align="center" sx={{ py: 4 }}>
                    <Typography variant="body2" color="text.secondary">No rows match.</Typography>
                  </TableCell></TableRow>
                ) : rows.map(r => (
                  <TableRow key={r.id} hover>
                    <TableCell sx={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>{r.row_number}</TableCell>
                    <TableCell sx={{ fontSize: '0.8rem' }}>{r.product_code}</TableCell>
                    <TableCell sx={{ fontSize: '0.8rem' }}>{r.product_name}</TableCell>
                    <TableCell>
                      {r.excluded ? (
                        <Typography variant="caption" color="text.secondary">Left blank</Typography>
                      ) : (
                        <Box component="span" sx={{
                          fontFamily: 'monospace', fontSize: '0.8rem', fontStyle: 'italic', color: 'text.disabled',
                          bgcolor: '#f1f5f9', border: '1px dashed #cbd5e1', borderRadius: 1, px: 0.75, py: 0.25,
                        }}>
                          {r.barcode}
                        </Box>
                      )}
                    </TableCell>
                    <TableCell align="center">
                      <Tooltip title={r.excluded ? 'Generate a barcode for this row' : 'Leave this row without a barcode'}>
                        <span>
                          <IconButton size="small" disabled={busy} aria-label={r.excluded ? 'Restore barcode' : 'Clear barcode'}
                            onClick={() => exclude.mutate({ row_ids: [r.id], excluded: !r.excluded })}>
                            {r.excluded ? <RestoreIcon fontSize="small" /> : <ClearIcon fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination
            component="div" count={data?.count || 0} page={page} rowsPerPage={PAGE_SIZE}
            rowsPerPageOptions={[PAGE_SIZE]} onPageChange={(e, next) => setPage(next)}
          />
        </>
      )}

      <Stack direction="row" spacing={1.5} justifyContent="flex-end" sx={{ mt: 1.5 }}>
        <Button disabled={busy} onClick={() => cancel.mutate()} sx={{ textTransform: 'none', fontWeight: 700 }}>
          Cancel Import
        </Button>
        <Button variant="contained" disabled={busy || !summary} onClick={() => confirm.mutate()} sx={{ fontWeight: 800, px: 3 }}>
          {confirm.isPending ? 'Starting...' : 'Confirm & Start Import'}
        </Button>
      </Stack>
    </Card>
  );
}
