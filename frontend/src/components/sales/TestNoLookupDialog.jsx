import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, IconButton,
  Stack, Tab, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Tabs, TextField,
  Tooltip, Typography,
} from '@mui/material';
import { Delete as DeleteIcon, Refresh as RefreshIcon } from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { apiErrorMessage } from '../../utils/apiError';

// New Sale → the 🔍 button beside Test No: a day's eye tests with whether each became a sale
// (blue = sale completed, neutral = no sale yet). Picking one loads it into the form exactly as
// if its Test No had been typed; tests nobody will buy against can be discarded from here —
// the server refuses one a bill depends on or whose fee was collected.

const SOLD_BLUE = '#1d4ed8';

const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return ymd(d); };
// The server runs on UTC, so the local day goes over as an explicit [start, end) instant range.
const dayBounds = (dateStr) => {
  const [y, m, d] = dateStr.split('-').map(Number);
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
};
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
// "32" → "32 yrs"; leaves values that already carry a unit ("6 months") alone.
const ageLabel = (age) => {
  const s = String(age || '').trim();
  return /^\d+(\.\d+)?$/.test(s) ? `${s} yrs` : s;
};

// One labelled demographic value (Age / Gender / Place) — sized for reading at a POS counter.
function Fact({ label, value, color }) {
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'baseline', gap: 0.5, whiteSpace: 'nowrap' }}>
      <Box component="span" sx={{ fontSize: '0.78rem', fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </Box>
      <Box component="span" sx={{ fontSize: '0.98rem', fontWeight: 800, color }}>{value || '—'}</Box>
    </Box>
  );
}

const docLabel = (b) => `${b.document_type === 'ORDER' ? 'Order' : 'Bill'} ${b.invoice_number || ''}`.trim();

// The browser's exam caches New Sale's Test No field also reads — a discarded test must not
// come back from them.
const purgeCachedExam = (row) => {
  const tno = String(row.test_no || '').replace(/\D/g, '');
  ['optical_eye_tests', 'optical_eye_exams'].forEach((key) => {
    try {
      const list = JSON.parse(localStorage.getItem(key) || '[]');
      if (!Array.isArray(list)) return;
      const kept = list.filter((e) => !(e && (
        [e.id, e.backendId].includes(row.id)
        || (tno && String(e.test_no || e.testNo || '').replace(/\D/g, '') === tno))));
      if (kept.length !== list.length) localStorage.setItem(key, JSON.stringify(kept));
    } catch (e) { /* unreadable cache — nothing to purge */ }
  });
};

const QUICK_DAYS = [{ label: 'Today', n: 0 }, { label: 'Yesterday', n: 1 }, { label: 'Day before', n: 2 }];

export default function TestNoLookupDialog({ open, onClose, onSelect }) {
  const [date, setDate] = useState(() => daysAgo(0));
  const [filter, setFilter] = useState('ALL');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [deletingId, setDeletingId] = useState('');
  const requestRef = useRef(0);
  const tableRef = useRef(null);

  // Every opening starts from today, on All.
  useEffect(() => {
    if (!open) return;
    setDate(daysAgo(0));
    setFilter('ALL');
    setSearch('');
  }, [open]);

  const load = async (dateStr = date) => {
    if (!dateStr) return;
    const req = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const res = await axios.get('/api/sales/eye-examinations/lookup/', { params: dayBounds(dateStr) });
      if (req !== requestRef.current) return;
      setRows(res.data?.results || []);
      setTruncated(!!res.data?.truncated);
    } catch (err) {
      if (req !== requestRef.current) return;
      setRows([]);
      setError(apiErrorMessage(err, 'Could not load the eye tests.'));
    } finally {
      if (req === requestRef.current) setLoading(false);
    }
  };

  useEffect(() => { if (open) load(date); }, [open, date]);

  const counts = useMemo(() => ({
    ALL: rows.length,
    SOLD: rows.filter((r) => r.sale_status === 'SOLD').length,
    PENDING: rows.filter((r) => r.sale_status !== 'SOLD').length,
  }), [rows]);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((r) => {
      if (filter === 'SOLD' && r.sale_status !== 'SOLD') return false;
      if (filter === 'PENDING' && r.sale_status === 'SOLD') return false;
      if (!q) return true;
      return [r.test_no, r.patient_name, r.patient_code, r.phone, r.place, r.address].some((v) => String(v || '').toLowerCase().includes(q));
    });
  }, [rows, filter, search]);

  const pick = (row) => { onSelect(row); onClose(); };

  const discard = async (row) => {
    const who = row.patient_name ? ` (${row.patient_name})` : '';
    if (!window.confirm(`Delete eye test ${row.test_no}${who}?\n\nUse this only when the patient won't be buying against this test. Its Test No is not reused.`)) return;
    setDeletingId(row.id);
    try {
      await axios.delete(`/api/sales/eye-examinations/${row.id}/discard/`);
      purgeCachedExam(row);
      setRows((list) => list.filter((r) => r.id !== row.id));
      notify(`Eye test ${row.test_no} deleted.`);
    } catch (err) {
      notify(apiErrorMessage(err, `Could not delete eye test ${row.test_no}.`));
    } finally {
      setDeletingId('');
    }
  };

  // ↑/↓ walk the rows, Enter picks the focused one.
  const onRowKeyDown = (e, row) => {
    if (e.key === 'Enter') { e.preventDefault(); pick(row); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const all = [...(tableRef.current?.querySelectorAll('[data-test-row]') || [])];
    const next = all[all.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)];
    if (next) next.focus();
  };
  const focusFirstRow = (e) => {
    if (e.key !== 'ArrowDown') return;
    const first = tableRef.current?.querySelector('[data-test-row]');
    if (first) { e.preventDefault(); first.focus(); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ fontWeight: 900, pb: 1 }}>Eye Tests — pick a Test No</DialogTitle>
      <DialogContent dividers sx={{ pt: 1.5 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mb: 1.5 }}>
          {QUICK_DAYS.map(({ label, n }) => (
            <Chip
              key={label} label={label} clickable
              color={date === daysAgo(n) ? 'primary' : 'default'}
              variant={date === daysAgo(n) ? 'filled' : 'outlined'}
              onClick={() => setDate(daysAgo(n))}
            />
          ))}
          <TextField
            type="date" size="small" label="Date" value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            inputProps={{ max: daysAgo(0) }} InputLabelProps={{ shrink: true }} sx={{ width: 170 }}
          />
          <TextField
            size="small" label="Find" placeholder="Name, Test No, phone, place" value={search} autoFocus
            onChange={(e) => setSearch(e.target.value)} onKeyDown={focusFirstRow} sx={{ flex: 1, minWidth: 160 }}
          />
          <Tooltip title="Reload">
            <span><IconButton size="small" onClick={() => load(date)} disabled={loading}><RefreshIcon fontSize="small" /></IconButton></span>
          </Tooltip>
        </Stack>

        <Tabs value={filter} onChange={(_, v) => setFilter(v)} sx={{ minHeight: 36, mb: 1, '& .MuiTab-root': { minHeight: 36, fontWeight: 800 } }}>
          <Tab value="ALL" label={`All (${counts.ALL})`} />
          <Tab value="SOLD" label={`Sale Completed (${counts.SOLD})`} sx={{ color: SOLD_BLUE }} />
          <Tab value="PENDING" label={`Pending / No Sale (${counts.PENDING})`} />
        </Tabs>

        {error && <Typography color="error" variant="body2" sx={{ mb: 1 }}>{error}</Typography>}
        {truncated && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            Showing the latest 500 tests of this day.
          </Typography>
        )}

        <TableContainer ref={tableRef} sx={{ maxHeight: '60vh', border: '1px solid #e2e8f0', borderRadius: 2,
                                             '& .MuiTableCell-body': { py: 1.25, verticalAlign: 'top', fontSize: '0.95rem' } }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {[['Test No', 90], ['Time', 80], ['Patient', undefined], ['Phone', 130], ['Status', 200], ['', 56]].map(([h, w]) => (
                  <TableCell key={h} sx={{ fontWeight: 900, bgcolor: '#f8fafc', width: w }}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}><CircularProgress size={24} /></TableCell></TableRow>
              )}
              {!loading && visible.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                    {rows.length ? 'No tests match this filter.' : 'No eye tests on this day.'}
                  </TableCell>
                </TableRow>
              )}
              {!loading && visible.map((row) => {
                const sold = row.sale_status === 'SOLD';
                const ink = sold ? SOLD_BLUE : 'text.primary';
                const pinned = sold || row.fee_only.length > 0 || row.fee_status === 'PAID';
                return (
                  <TableRow
                    key={row.id} hover tabIndex={0} data-test-row
                    onClick={() => pick(row)} onKeyDown={(e) => onRowKeyDown(e, row)}
                    sx={{ cursor: 'pointer', '&:focus': { outline: `2px solid ${SOLD_BLUE}`, outlineOffset: -2 },
                          bgcolor: sold ? '#eff6ff' : undefined }}
                  >
                    <TableCell sx={{ fontWeight: 900, color: ink, whiteSpace: 'nowrap' }}>{row.test_no}</TableCell>
                    <TableCell sx={{ color: ink, whiteSpace: 'nowrap' }}>{timeOf(row.examination_date)}</TableCell>
                    <TableCell sx={{ color: ink, minWidth: 260 }}>
                      <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1, flexWrap: 'wrap' }}>
                        <Box component="span" sx={{ fontWeight: 900, fontSize: '1.05rem' }}>{row.patient_name || '—'}</Box>
                        {row.patient_code && (
                          <Box component="span" sx={{ fontSize: '0.8rem', fontWeight: 700, color: 'text.secondary' }}>{row.patient_code}</Box>
                        )}
                      </Box>
                      <Box sx={{ display: 'flex', flexWrap: 'wrap', columnGap: 2, rowGap: 0.25, mt: 0.5 }}>
                        <Fact label="Age" value={ageLabel(row.age)} color={ink} />
                        <Fact label="Gender" value={row.gender} color={ink} />
                        {row.place && <Fact label="Place" value={row.place} color={ink} />}
                      </Box>
                      {row.address && (
                        <Box sx={{ mt: 0.5, fontSize: '0.92rem', fontWeight: 600, lineHeight: 1.4, wordBreak: 'break-word' }}>
                          <Box component="span" sx={{ fontSize: '0.78rem', fontWeight: 700, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.4, mr: 0.5 }}>
                            Address
                          </Box>
                          {row.address}
                        </Box>
                      )}
                    </TableCell>
                    <TableCell sx={{ color: ink, whiteSpace: 'nowrap', fontWeight: 700 }}>{row.phone || '—'}</TableCell>
                    <TableCell>
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
                        {sold ? (
                          <Tooltip title={row.sales.map(docLabel).join(', ')}>
                            <Chip size="small" label="Sale Completed" sx={{ bgcolor: SOLD_BLUE, color: '#fff', fontWeight: 800 }} />
                          </Tooltip>
                        ) : (
                          <Chip size="small" label="No Sale" variant="outlined" sx={{ fontWeight: 800, color: '#0f172a', borderColor: '#0f172a' }} />
                        )}
                        {sold && row.sales.slice(0, 2).map((b) => (
                          <Chip key={b.id} size="small" variant="outlined" label={docLabel(b)} sx={{ color: SOLD_BLUE, borderColor: SOLD_BLUE }} />
                        ))}
                        {!sold && row.quotations.length > 0 && <Chip size="small" variant="outlined" label="Quoted" />}
                        {row.fee_status === 'PENDING' && <Chip size="small" variant="outlined" color="warning" label="Fee pending" />}
                      </Stack>
                    </TableCell>
                    <TableCell align="right" onClick={(e) => e.stopPropagation()}>
                      <Tooltip title={pinned ? 'Linked to a bill or a collected fee — cannot be deleted here' : 'Delete this test (no sale)'}>
                        <span>
                          <IconButton
                            size="small" color="error" disabled={pinned || deletingId === row.id}
                            onClick={() => discard(row)} onKeyDown={(e) => e.stopPropagation()}
                          >
                            {deletingId === row.id ? <CircularProgress size={16} /> : <DeleteIcon fontSize="small" />}
                          </IconButton>
                        </span>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
      <DialogActions>
        <Typography variant="caption" color="text.secondary" sx={{ flex: 1, pl: 1 }}>
          Click a test (or ↓ then Enter) to load it into this sale.
        </Typography>
        <Button onClick={onClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
