// View All Vouchers: the journal register from /api/financial/journals/ — manual vouchers and
// automated postings alike, with their source document, posting status and reversal links.
import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Card, Chip, Collapse, Dialog, DialogActions, DialogContent, DialogTitle, IconButton,
  LinearProgress, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TablePagination,
  TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  ExpandMore as ExpandMoreIcon, ChevronRight as ChevronRightIcon, Undo as ReverseIcon, Refresh as RefreshIcon,
  CheckCircle as CheckIcon, Delete as DeleteIcon,
} from '@mui/icons-material';
import { apiError, finDelete, finGet, finPost, inr, sourceLabel } from './financialApi';

const head = { fontWeight: 700 };
const TYPE_COLORS = { RV: 'success', PV: 'error', CV: 'info', JV: 'secondary' };
const STATUS_COLORS = { POSTED: 'success', REVERSED: 'warning', DRAFT: 'default', PENDING_APPROVAL: 'info', CANCELLED: 'default' };

export default function VoucherRegister({ showToast, onChanged, refreshKey }) {
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [filters, setFilters] = useState({ voucher_type: 'ALL', status: 'ALL', origin: 'ALL', search: '', date_from: '', date_to: '' });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [open, setOpen] = useState({});
  const [reverseTarget, setReverseTarget] = useState(null);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const params = { page: page + 1, page_size: pageSize, search: filters.search, date_from: filters.date_from, date_to: filters.date_to };
      if (filters.voucher_type !== 'ALL') params.voucher_type = filters.voucher_type;
      if (filters.status !== 'ALL') params.status = filters.status;
      if (filters.origin === 'MANUAL') params.manual = 1;
      else if (filters.origin !== 'ALL') params.source_module = filters.origin;
      const data = await finGet('journals/', params);
      setRows(data.results || []);
      setCount(data.count || 0);
    } catch (e) {
      setError(apiError(e));
    }
    setLoading(false);
  }, [page, pageSize, filters]);

  useEffect(() => { load(); }, [load, refreshKey]);

  const setFilter = (k, v) => { setPage(0); setFilters(prev => ({ ...prev, [k]: v })); };

  const act = async (fn, ok) => {
    try {
      await fn();
      showToast(ok, 'success');
      load();
      onChanged?.();
    } catch (e) {
      showToast(apiError(e), 'error');
    }
  };

  const confirmReverse = async () => {
    const entry = reverseTarget;
    if (!reason.trim()) { showToast('Give a reason for the reversal.', 'warning'); return; }
    const automated = entry.source_module && entry.source_module !== 'financial';
    await act(() => finPost(`journals/${entry.id}/reverse/`, { reason, confirm_automated: automated }),
      `Journal ${entry.entry_number} reversed.`);
    setReverseTarget(null);
    setReason('');
  };

  return (
    <Card variant="outlined" sx={{ p: { xs: 2, md: 4 }, borderRadius: 4 }}>
      <Stack direction={{ xs: 'column', lg: 'row' }} justifyContent="space-between" gap={2} sx={{ mb: 3 }}>
        <Box>
          <Typography variant="h6" fontWeight={850}>View All Vouchers &amp; Journal Register</Typography>
          <Typography variant="body2" color="text.secondary">
            Every journal on the books — manual vouchers and automated postings from sales, purchases and inventory.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1.5} flexWrap="wrap" gap={1}>
          <TextField size="small" label="Search" placeholder="Voucher no, narration, doc no" value={filters.search}
            onChange={(e) => setFilter('search', e.target.value)} sx={{ minWidth: 200 }} />
          <TextField select size="small" label="Type" value={filters.voucher_type} onChange={(e) => setFilter('voucher_type', e.target.value)} sx={{ minWidth: 130 }}>
            <MenuItem value="ALL">All types</MenuItem>
            <MenuItem value="RV">Receipt (RV)</MenuItem>
            <MenuItem value="PV">Payment (PV)</MenuItem>
            <MenuItem value="CV">Contra (CV)</MenuItem>
            <MenuItem value="JV">Journal (JV)</MenuItem>
            <MenuItem value="SV">Sales (SV)</MenuItem>
            <MenuItem value="PU">Purchase (PU)</MenuItem>
            <MenuItem value="IA">Inventory (IA)</MenuItem>
            <MenuItem value="OB">Opening (OB)</MenuItem>
          </TextField>
          <TextField select size="small" label="Origin" value={filters.origin} onChange={(e) => setFilter('origin', e.target.value)} sx={{ minWidth: 140 }}>
            <MenuItem value="ALL">All origins</MenuItem>
            <MenuItem value="MANUAL">Manual vouchers</MenuItem>
            <MenuItem value="sales">Sales</MenuItem>
            <MenuItem value="purchasing">Purchasing</MenuItem>
            <MenuItem value="inventory">Inventory</MenuItem>
          </TextField>
          <TextField select size="small" label="Status" value={filters.status} onChange={(e) => setFilter('status', e.target.value)} sx={{ minWidth: 130 }}>
            <MenuItem value="ALL">All statuses</MenuItem>
            <MenuItem value="POSTED">Posted</MenuItem>
            <MenuItem value="REVERSED">Reversed</MenuItem>
            <MenuItem value="DRAFT">Draft</MenuItem>
          </TextField>
          <TextField type="date" size="small" label="From" InputLabelProps={{ shrink: true }} value={filters.date_from} onChange={(e) => setFilter('date_from', e.target.value)} />
          <TextField type="date" size="small" label="To" InputLabelProps={{ shrink: true }} value={filters.date_to} onChange={(e) => setFilter('date_to', e.target.value)} />
          <IconButton onClick={load} title="Refresh"><RefreshIcon /></IconButton>
        </Stack>
      </Stack>

      {loading && <LinearProgress sx={{ mb: 1 }} />}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}

      <TableContainer sx={{ overflowX: 'auto' }}>
        <Table size="small" sx={{ minWidth: 1000 }}>
          <TableHead sx={{ bgcolor: '#f8fafc' }}>
            <TableRow>
              <TableCell sx={{ width: 36 }} />
              <TableCell sx={head}>Voucher No</TableCell>
              <TableCell sx={head}>Date</TableCell>
              <TableCell sx={head}>Type</TableCell>
              <TableCell sx={head}>Source</TableCell>
              <TableCell sx={head}>Narration</TableCell>
              <TableCell sx={head} align="right">Amount</TableCell>
              <TableCell sx={head}>Status</TableCell>
              <TableCell sx={head} align="center">Action</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {!loading && rows.length === 0 && (
              <TableRow><TableCell colSpan={9} align="center" sx={{ py: 6, color: 'text.secondary' }}>No journals match these filters.</TableCell></TableRow>
            )}
            {rows.map(j => {
              const code = j.voucher_type_code || 'JV';
              const isOpen = !!open[j.id];
              const editable = j.status === 'DRAFT' || j.status === 'PENDING_APPROVAL';
              return (
                <React.Fragment key={j.id}>
                  <TableRow hover>
                    <TableCell>
                      <IconButton size="small" onClick={() => setOpen(p => ({ ...p, [j.id]: !p[j.id] }))}>
                        {isOpen ? <ExpandMoreIcon fontSize="small" /> : <ChevronRightIcon fontSize="small" />}
                      </IconButton>
                    </TableCell>
                    <TableCell sx={{ fontWeight: 700, color: j.is_reversal ? 'warning.main' : 'primary.main', fontFamily: 'monospace' }}>{j.entry_number}</TableCell>
                    <TableCell>{j.date}</TableCell>
                    <TableCell><Chip label={code} color={TYPE_COLORS[code] || 'default'} size="small" sx={{ fontWeight: 800 }} /></TableCell>
                    <TableCell>
                      <Typography variant="body2" fontWeight={600}>{sourceLabel(j)}</Typography>
                      {j.source_number && <Typography variant="caption" color="text.secondary">{j.source_number}</Typography>}
                    </TableCell>
                    <TableCell sx={{ maxWidth: 340 }}>
                      <Typography variant="body2" noWrap title={j.narration}>{j.narration || '—'}</Typography>
                      {j.reversed_entry_number && (
                        <Typography variant="caption" color="warning.main">{j.is_reversal ? 'Reverses' : 'Reversed by'} {j.reversed_entry_number}</Typography>
                      )}
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800 }}>{inr(j.total_amount)}</TableCell>
                    <TableCell><Chip label={j.status} color={STATUS_COLORS[j.status] || 'default'} size="small" sx={{ fontWeight: 700 }} /></TableCell>
                    <TableCell align="center">
                      <Stack direction="row" spacing={0.5} justifyContent="center">
                        {editable && (<>
                          <Tooltip title="Post this draft to the ledger">
                            <Button size="small" variant="outlined" color="success" startIcon={<CheckIcon />}
                              onClick={() => act(() => finPost(`journals/${j.id}/post/`), `${j.entry_number} posted.`)}
                              sx={{ textTransform: 'none', fontWeight: 700, fontSize: '0.72rem' }}>Post</Button>
                          </Tooltip>
                          <IconButton size="small" color="error" title="Delete draft"
                            onClick={() => window.confirm(`Delete draft ${j.entry_number}?`) && act(() => finDelete(`journals/${j.id}/`), 'Draft deleted.')}>
                            <DeleteIcon fontSize="small" />
                          </IconButton>
                        </>)}
                        {j.status === 'POSTED' && !j.is_reversal && (
                          <Tooltip title={j.source_module && j.source_module !== 'financial'
                            ? 'Posted automatically — correct or cancel the source document instead where possible'
                            : 'Create an immutable reversal entry'}>
                            <Button size="small" variant="outlined" color="warning" startIcon={<ReverseIcon />}
                              onClick={() => { setReverseTarget(j); setReason(''); }}
                              sx={{ textTransform: 'none', fontWeight: 700, fontSize: '0.72rem' }}>Reverse</Button>
                          </Tooltip>
                        )}
                      </Stack>
                    </TableCell>
                  </TableRow>
                  <TableRow>
                    <TableCell colSpan={9} sx={{ py: 0, borderBottom: isOpen ? undefined : 'none' }}>
                      <Collapse in={isOpen} unmountOnExit>
                        <Box sx={{ py: 1.5, pl: 6 }}>
                          <Table size="small">
                            <TableHead>
                              <TableRow>
                                <TableCell sx={head}>Account</TableCell>
                                <TableCell sx={head}>Memo</TableCell>
                                <TableCell sx={head} align="right">Debit</TableCell>
                                <TableCell sx={head} align="right">Credit</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {(j.lines || []).map(l => (
                                <TableRow key={l.id}>
                                  <TableCell>{l.account_code} - {l.account_name}</TableCell>
                                  <TableCell>{l.memo}</TableCell>
                                  <TableCell align="right">{parseFloat(l.debit) ? inr(l.debit) : ''}</TableCell>
                                  <TableCell align="right">{parseFloat(l.credit) ? inr(l.credit) : ''}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                          <Typography variant="caption" color="text.secondary">
                            {j.created_by_name ? `Created by ${j.created_by_name}. ` : ''}
                            {j.posted_at ? `Posted ${new Date(j.posted_at).toLocaleString()}${j.posted_by_name ? ` by ${j.posted_by_name}` : ''}.` : ''}
                          </Typography>
                        </Box>
                      </Collapse>
                    </TableCell>
                  </TableRow>
                </React.Fragment>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination component="div" count={count} page={page} onPageChange={(e, p) => setPage(p)}
        rowsPerPage={pageSize} onRowsPerPageChange={(e) => { setPageSize(parseInt(e.target.value, 10)); setPage(0); }}
        rowsPerPageOptions={[25, 50, 100]} />

      <Dialog open={!!reverseTarget} onClose={() => setReverseTarget(null)} maxWidth="sm" fullWidth>
        <DialogTitle sx={{ fontWeight: 850 }}>Reverse {reverseTarget?.entry_number}</DialogTitle>
        <DialogContent>
          {reverseTarget?.source_module && reverseTarget.source_module !== 'financial' && (
            <Alert severity="warning" sx={{ mb: 2 }}>
              This entry was posted automatically from {sourceLabel(reverseTarget)} {reverseTarget.source_number}. Reversing it here
              leaves that document off the books until it is saved again — prefer cancelling or editing the document itself.
            </Alert>
          )}
          <Typography variant="body2" sx={{ mb: 2 }}>
            A new entry with the debits and credits swapped will be posted and this one marked REVERSED. Nothing is deleted.
          </Typography>
          <TextField autoFocus fullWidth size="small" label="Reason *" value={reason} onChange={(e) => setReason(e.target.value)} />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setReverseTarget(null)}>Cancel</Button>
          <Button variant="contained" color="warning" onClick={confirmReverse}>Create reversal</Button>
        </DialogActions>
      </Dialog>
    </Card>
  );
}
