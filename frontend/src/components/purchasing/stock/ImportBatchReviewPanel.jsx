// Stock Overview → Excel Imports: each finished import shown as its own section, apart from the
// stock grid. New products list the quantity they came in with. Existing products never had their
// stock overwritten by the import; the file's quantity waits here until someone applies it (a
// ledgered stock adjustment, like any count) or keeps the current figure.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Box, Button, Card, Chip, Collapse, IconButton, LinearProgress, MenuItem, Stack, Tab, Table, TableBody,
  TableCell, TableContainer, TableHead, TablePagination, TableRow, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  ExpandMore as ExpandIcon, ExpandLess as CollapseIcon, Check as ApplyIcon, Block as KeepIcon,
  FilterList as GridFilterIcon, UploadFile as ImportIcon,
} from '@mui/icons-material';
import { decideImportRows, fetchImportBatches, fetchImportReview, formatDateTime, formatQty } from './stockApi';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';

const PAGE_SIZE = 25;
const SECTIONS = [
  { value: 'pending', label: 'Stock to Review', count: (b) => b.pending_stock },
  { value: 'existing', label: 'Existing Products', count: (b) => b.existing_products },
  { value: 'new', label: 'New Products', count: (b) => b.new_products },
];
const REVIEW_META = {
  PENDING: { label: 'Needs review', color: 'warning' },
  APPLIED: { label: 'Applied', color: 'success' },
  KEPT: { label: 'Kept current', color: 'default' },
  NO_CHANGE: { label: 'Same as file', color: 'default' },
};

export default function ImportBatchReviewPanel({ canAdjust, onShowInGrid, onStockChanged, refreshKey }) {
  const [open, setOpen] = useState(false);
  const [batches, setBatches] = useState([]);
  const [batchId, setBatchId] = useState('');
  const [section, setSection] = useState('pending');
  const [page, setPage] = useState(0);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reload, setReload] = useState(0);

  const loadBatches = useCallback(() => {
    fetchImportBatches().then((list) => {
      setBatches(list);
      setBatchId((cur) => (cur && list.some((b) => b.id === cur) ? cur : (list.find((b) => b.pending_stock > 0) || list[0])?.id || ''));
    }).catch(() => setBatches([]));
  }, []);
  useEffect(() => { loadBatches(); }, [loadBatches, refreshKey]);

  const batch = data?.batch || batches.find((b) => b.id === batchId);
  const pendingTotal = batches.reduce((n, b) => n + (b.pending_stock || 0), 0);

  useEffect(() => {
    if (!open || !batchId) return undefined;
    const ctl = new AbortController();
    setLoading(true);
    fetchImportReview({ batch: batchId, section, page: page + 1, page_size: PAGE_SIZE }, ctl.signal)
      .then(setData)
      .catch((e) => { if (e?.name !== 'CanceledError') notify(apiErrorMessage(e, 'Could not load the import.')); })
      .finally(() => setLoading(false));
    return () => ctl.abort();
  }, [open, batchId, section, page, refreshKey, reload]);

  const decide = async (decision, rowIds) => {
    const scope = rowIds ? `${rowIds.length} row${rowIds.length === 1 ? '' : 's'}` : `all ${formatQty(batch?.pending_stock)} pending rows`;
    const question = decision === 'apply'
      ? `Set the stock of ${scope} to the quantity in the file? Each change is recorded as a stock adjustment.`
      : `Keep the current stock for ${scope}? The file quantities will be dismissed.`;
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const res = await decideImportRows({ batch: batchId, decision, ...(rowIds ? { row_ids: rowIds } : { all: true }) });
      setBatches((list) => list.map((b) => (b.id === res.batch.id ? { ...b, ...res.batch } : b)));
      if (res.failed?.length) notify(`${res.failed.length} row(s) not changed: ${res.failed[0].detail}`);
      else notify(decision === 'apply' ? `${res.done.length} stock adjustment(s) recorded.` : `${res.done.length} row(s) kept as they are.`);
      if (decision === 'apply' && res.done.length) onStockChanged?.();
    } catch (e) {
      notify(apiErrorMessage(e, 'Could not save the decision.'));
    } finally {
      setBusy(false);
      setReload((k) => k + 1);
    }
  };

  if (!batches.length) return null;
  const rows = data?.results || [];
  const isNew = section === 'new';

  return (
    <Card variant="outlined" sx={{ borderRadius: 3, mb: 1.5, borderColor: pendingTotal ? 'warning.light' : undefined }}>
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ px: 1.5, py: 1, cursor: 'pointer' }} onClick={() => setOpen((o) => !o)}>
        <ImportIcon fontSize="small" color="primary" />
        <Typography fontWeight={800}>Excel Imports</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ flex: 1, minWidth: 0 }} noWrap>
          Imported batches, kept apart from current stock for checking
        </Typography>
        {pendingTotal > 0 && <Chip size="small" color="warning" label={`${formatQty(pendingTotal)} stock to review`} sx={{ fontWeight: 800 }} />}
        <IconButton size="small" aria-label={open ? 'Collapse' : 'Expand'}>{open ? <CollapseIcon /> : <ExpandIcon />}</IconButton>
      </Stack>

      <Collapse in={open} unmountOnExit>
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          <Stack direction="row" spacing={1.25} flexWrap="wrap" useFlexGap alignItems="center" sx={{ mb: 1 }}>
            <TextField select size="small" label="Import batch" value={batchId} sx={{ minWidth: 320 }}
              onChange={(e) => { setBatchId(e.target.value); setPage(0); setData(null); }}>
              {batches.map((b) => (
                <MenuItem key={b.id} value={b.id}>
                  {b.batch_number} · {b.file_name} · {formatDateTime(b.completed_at)}{b.pending_stock ? ` · ${b.pending_stock} to review` : ''}
                </MenuItem>
              ))}
            </TextField>
            {batch && (
              <Typography variant="body2" color="text.secondary">
                {formatQty(batch.imported_rows)} new · {formatQty(batch.updated_rows)} updated · {formatQty(batch.skipped_rows)} skipped
              </Typography>
            )}
            <Box sx={{ flex: 1 }} />
            <Button size="small" startIcon={<GridFilterIcon />} onClick={() => onShowInGrid?.(batch)} sx={{ fontWeight: 700 }}>
              Show batch in grid
            </Button>
          </Stack>

          <Tabs value={section} onChange={(e, v) => { setSection(v); setPage(0); }} sx={{ minHeight: 36, mb: 1 }}>
            {SECTIONS.map((s) => (
              <Tab key={s.value} value={s.value} sx={{ minHeight: 36, textTransform: 'none', fontWeight: 700 }}
                label={`${s.label} (${formatQty(batch ? s.count(batch) : 0)})`} />
            ))}
          </Tabs>

          {section === 'pending' && canAdjust && batch?.pending_stock > 0 && (
            <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
              <Button size="small" variant="contained" color="warning" startIcon={<ApplyIcon />} disabled={busy}
                onClick={() => decide('apply')} sx={{ fontWeight: 800 }}>Apply all file quantities</Button>
              <Button size="small" variant="outlined" startIcon={<KeepIcon />} disabled={busy}
                onClick={() => decide('keep')} sx={{ fontWeight: 800 }}>Keep all current stock</Button>
            </Stack>
          )}

          {(loading || busy) && <LinearProgress sx={{ height: 2 }} />}
          <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, maxHeight: 380 }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 800 }}>Item Code</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Barcode</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Product</TableCell>
                  {isNew ? (
                    <>
                      <TableCell align="right" sx={{ fontWeight: 800 }}>Imported Qty</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 800 }}>Current Stock</TableCell>
                    </>
                  ) : (
                    <>
                      <TableCell align="right" sx={{ fontWeight: 800 }}>Current Stock</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 800 }}>Qty in File</TableCell>
                      <TableCell align="right" sx={{ fontWeight: 800 }}>Difference</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Review</TableCell>
                      <TableCell align="center" sx={{ fontWeight: 800, width: 96 }}>Action</TableCell>
                    </>
                  )}
                </TableRow>
              </TableHead>
              <TableBody>
                {rows.length === 0 ? (
                  <TableRow><TableCell colSpan={isNew ? 5 : 8} align="center" sx={{ py: 3 }}>
                    <Typography variant="body2" color="text.secondary">
                      {loading ? 'Loading…' : section === 'pending' ? 'Nothing left to review in this import.' : 'No products in this section.'}
                    </Typography>
                  </TableCell></TableRow>
                ) : rows.map((r) => {
                  const meta = REVIEW_META[r.review_status] || REVIEW_META.NO_CHANGE;
                  return (
                    <TableRow key={r.id || r.product_id} hover>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.sku}</TableCell>
                      <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.barcode || '—'}</TableCell>
                      <TableCell sx={{ fontSize: 13 }}>{r.name}</TableCell>
                      {isNew ? (
                        <>
                          <TableCell align="right">{formatQty(r.imported_quantity)}</TableCell>
                          <TableCell align="right">{formatQty(r.current_stock)}</TableCell>
                        </>
                      ) : (
                        <>
                          <TableCell align="right">{formatQty(r.current_stock)}</TableCell>
                          <TableCell align="right" sx={{ fontWeight: 700 }}>{formatQty(r.file_quantity)}</TableCell>
                          <TableCell align="right" sx={{ color: r.difference > 0 ? 'success.main' : r.difference < 0 ? 'error.main' : 'text.secondary' }}>
                            {r.difference == null ? '—' : `${r.difference > 0 ? '+' : ''}${r.difference}`}
                          </TableCell>
                          <TableCell>
                            <Tooltip title={r.reviewed_by ? `${r.reviewed_by}, ${formatDateTime(r.reviewed_at)}` : ''}>
                              <Chip size="small" color={meta.color} label={r.adjustment_number ? `${meta.label} · ${r.adjustment_number}` : meta.label} />
                            </Tooltip>
                          </TableCell>
                          <TableCell align="center">
                            {r.review_status === 'PENDING' && (
                              <>
                                <Tooltip title={canAdjust ? 'Set stock to the file quantity' : 'Your role cannot adjust stock'}>
                                  <span><IconButton size="small" color="warning" disabled={busy || !canAdjust} onClick={() => decide('apply', [r.id])}>
                                    <ApplyIcon fontSize="small" />
                                  </IconButton></span>
                                </Tooltip>
                                <Tooltip title="Keep the current stock">
                                  <span><IconButton size="small" disabled={busy} onClick={() => decide('keep', [r.id])}>
                                    <KeepIcon fontSize="small" />
                                  </IconButton></span>
                                </Tooltip>
                              </>
                            )}
                          </TableCell>
                        </>
                      )}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
          <TablePagination component="div" count={data?.count || 0} page={page} rowsPerPage={PAGE_SIZE}
            rowsPerPageOptions={[PAGE_SIZE]} onPageChange={(e, next) => setPage(next)} />
        </Box>
      </Collapse>
    </Card>
  );
}
