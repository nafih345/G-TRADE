// View Stock History: the product's StockLedger movements (purchases, PO receipts, sales and
// their edits, manual adjustments, opening stock, transfers), newest first. Read-only — the
// ledger is never edited or deleted from here.
import React, { useEffect, useState } from 'react';
import {
  Drawer, Box, Typography, IconButton, Stack, TextField, MenuItem, Button, Table, TableHead, TableRow,
  TableCell, TableBody, TablePagination, LinearProgress, Alert, Chip, Tooltip,
} from '@mui/material';
import { Close as CloseIcon } from '@mui/icons-material';
import { fetchStockHistory, formatDateTime, formatMoney, formatQty, STATUS_META } from './stockApi';
import { apiErrorMessage } from '../../../utils/apiError';

const TYPES = [
  { value: '', label: 'All movements' },
  { value: 'PURCHASE', label: 'Purchases' },
  { value: 'SALE', label: 'Sales' },
  { value: 'ADJUSTMENT', label: 'Adjustments' },
  { value: 'TRANSFER', label: 'Transfers' },
  { value: 'IN', label: 'All stock in' },
  { value: 'OUT', label: 'All stock out' },
];
const BLANK = { date_from: '', date_to: '', type: '', reference: '' };
const cell = { py: 0.6, px: 1, fontSize: 12.5, whiteSpace: 'nowrap' };

export default function StockHistoryDrawer({ open, row, refreshKey, onClose }) {
  const [draft, setDraft] = useState(BLANK);
  const [filters, setFilters] = useState(BLANK);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) { setDraft(BLANK); setFilters(BLANK); setPage(0); setData(null); }
  }, [open, row?.id]);

  useEffect(() => {
    if (!open || !row) return undefined;
    const ctl = new AbortController();
    setLoading(true);
    setError('');
    const params = { page: page + 1, page_size: pageSize };
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    fetchStockHistory(row.id, params, ctl.signal)
      .then(setData)
      .catch((err) => { if (!ctl.signal.aborted) setError(apiErrorMessage(err, 'Could not load the stock history.')); })
      .finally(() => { if (!ctl.signal.aborted) setLoading(false); });
    return () => ctl.abort();
  }, [open, row, filters, page, pageSize, refreshKey]);

  const product = data?.product || row;
  const status = product ? STATUS_META[product.status] : null;
  const apply = (e) => { e?.preventDefault(); setPage(0); setFilters(draft); };

  return (
    <Drawer anchor="right" open={open} onClose={onClose}
      PaperProps={{ sx: { width: { xs: '100%', md: 'min(1180px, 92vw)' }, display: 'flex', flexDirection: 'column' } }}>
      <Box sx={{ p: 2, borderBottom: 1, borderColor: 'divider', display: 'flex', alignItems: 'flex-start', gap: 2 }}>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="overline" color="text.secondary">Stock History</Typography>
          <Typography variant="h6" fontWeight={800} noWrap>{product?.name}</Typography>
          <Typography variant="body2" color="text.secondary">
            SKU {product?.sku}{product?.barcode ? ` · Barcode ${product.barcode}` : ''}
            {product?.secondary_barcode ? ` · ${product.secondary_barcode}` : ''}{product?.variant ? ` · ${product.variant}` : ''}
          </Typography>
        </Box>
        {product && (
          <Stack alignItems="flex-end" spacing={0.5}>
            <Typography variant="h5" fontWeight={800}>{formatQty(product.stock)} <Typography component="span" variant="body2" color="text.secondary">{product.uom || 'on hand'}</Typography></Typography>
            {status && <Chip size="small" label={status.label} sx={{ fontWeight: 700, color: status.color, bgcolor: status.bg }} />}
          </Stack>
        )}
        <IconButton onClick={onClose} aria-label="Close history"><CloseIcon /></IconButton>
      </Box>

      <Box component="form" onSubmit={apply} data-nav-scope="stock-history"
        sx={{ p: 2, display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center' }}>
        <TextField size="small" type="date" label="From" InputLabelProps={{ shrink: true }} value={draft.date_from}
          onChange={(e) => setDraft({ ...draft, date_from: e.target.value })} />
        <TextField size="small" type="date" label="To" InputLabelProps={{ shrink: true }} value={draft.date_to}
          onChange={(e) => setDraft({ ...draft, date_to: e.target.value })} />
        <TextField size="small" select label="Type" value={draft.type} sx={{ minWidth: 170 }}
          onChange={(e) => { const next = { ...draft, type: e.target.value }; setDraft(next); setPage(0); setFilters(next); }}>
          {TYPES.map((t) => <MenuItem key={t.value} value={t.value}>{t.label}</MenuItem>)}
        </TextField>
        <TextField size="small" label="Reference no." value={draft.reference}
          onChange={(e) => setDraft({ ...draft, reference: e.target.value })} />
        <Button type="submit" variant="contained" sx={{ fontWeight: 700 }}>Apply</Button>
        <Button onClick={() => { setDraft(BLANK); setPage(0); setFilters(BLANK); }}>Reset</Button>
      </Box>

      {loading && <LinearProgress />}
      {error && <Alert severity="error" sx={{ mx: 2 }}>{error}</Alert>}

      <Box sx={{ flex: 1, overflow: 'auto' }}>
        <Table size="small" stickyHeader aria-label="Stock movements">
          <TableHead>
            <TableRow>
              {['Date & time', 'Type', 'Reference', 'Supplier / Customer', 'In', 'Out', 'Previous', 'New', 'Unit cost', 'User', 'Remarks'].map((h) => (
                <TableCell key={h} sx={{ ...cell, fontWeight: 800, bgcolor: 'background.paper' }}
                  align={['In', 'Out', 'Previous', 'New', 'Unit cost'].includes(h) ? 'right' : 'left'}>{h}</TableCell>
              ))}
            </TableRow>
          </TableHead>
          <TableBody>
            {(data?.results || []).map((m) => (
              <TableRow key={m.id} hover>
                <TableCell sx={cell}>{formatDateTime(m.date)}</TableCell>
                <TableCell sx={cell}>{m.type_label}</TableCell>
                <TableCell sx={{ ...cell, fontFamily: 'monospace' }}>{m.reference_number || '—'}</TableCell>
                <TableCell sx={cell}>{m.party || '—'}</TableCell>
                <TableCell sx={{ ...cell, color: 'success.main', fontWeight: 700 }} align="right">{m.quantity_in ? `+${formatQty(m.quantity_in)}` : ''}</TableCell>
                <TableCell sx={{ ...cell, color: 'error.main', fontWeight: 700 }} align="right">{m.quantity_out ? `−${formatQty(m.quantity_out)}` : ''}</TableCell>
                <TableCell sx={cell} align="right">{formatQty(m.previous_stock)}</TableCell>
                <TableCell sx={{ ...cell, fontWeight: 700 }} align="right">{formatQty(m.new_stock)}</TableCell>
                <TableCell sx={cell} align="right">{m.unit_cost ? formatMoney(m.unit_cost) : '—'}</TableCell>
                <TableCell sx={cell}>{m.performed_by || '—'}</TableCell>
                <TableCell sx={{ ...cell, whiteSpace: 'normal', minWidth: 220 }}>
                  <Tooltip title={m.branch ? `Branch: ${m.branch}` : ''}><span>{m.remarks || '—'}</span></Tooltip>
                </TableCell>
              </TableRow>
            ))}
            {!loading && data && data.results.length === 0 && (
              <TableRow><TableCell colSpan={11} sx={{ py: 6, textAlign: 'center', color: 'text.secondary' }}>
                No stock movements {Object.values(filters).some(Boolean) ? 'match these filters' : 'recorded for this product yet'}.
              </TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </Box>
      <TablePagination component="div" count={data?.count || 0} page={page} rowsPerPage={pageSize}
        rowsPerPageOptions={[25, 50, 100, 200]} onPageChange={(_, p) => setPage(p)}
        onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }} />
      <Typography variant="caption" color="text.secondary" sx={{ px: 2, pb: 1.5 }}>
        Previous / New show the product's total on hand around each movement. Movements recorded before this screen existed have no running balance (—).
      </Typography>
    </Drawer>
  );
}
