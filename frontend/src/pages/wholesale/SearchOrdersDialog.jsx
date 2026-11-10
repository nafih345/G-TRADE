// Wholesale POS → "Search Orders" (F8): pending CONFIRMED wholesale orders (and open quotations)
// searchable by number, dealer / shop or date. Picking one loads it into the POS for billing —
// the bill then closes the order on the server (apps/sales/wholesale_orders.py).
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, InputAdornment, Table, TableHead,
  TableBody, TableRow, TableCell, TableContainer, Typography, Stack, ToggleButtonGroup, ToggleButton,
  CircularProgress, Alert, Chip, FormControlLabel, Checkbox,
} from '@mui/material';
import { Search as SearchIcon } from '@mui/icons-material';
import axios from 'axios';
import { WHOLESALE_API, fetchAllPages } from './wholesaleConstants';
import { DOC_KINDS, ORDER_STATUS, QUOTE_STATUS, docFromApi, lineUnits } from './wholesaleOrders';
import { describeApiError } from '../../utils/apiWriteGuard';

const inr = (n) => `₹${(parseFloat(n) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const HEAD_SX = { bgcolor: '#0f172a', color: '#fff', fontWeight: 800, fontSize: '0.72rem', py: 0.8 };

export default function SearchOrdersDialog({ open, onClose, onPick, dealer }) {
  const [kind, setKind] = useState('order');
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [dealerOnly, setDealerOnly] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setActive(0);
    const status = kind === 'order' ? ORDER_STATUS.CONFIRMED : QUOTE_STATUS.OPEN;
    fetchAllPages(axios, `${WHOLESALE_API}/${DOC_KINDS[kind].endpoint}/?status=${status}`)
      .then((list) => { if (!cancelled) setRows(list.map(r => docFromApi(kind, r))); })
      .catch((e) => { if (!cancelled) { setRows([]); setError(describeApiError(e, 'Could not load pending orders.')); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, kind]);

  useEffect(() => { if (open) { setQuery(''); setDealerOnly(Boolean(dealer?.id)); } }, [open, dealer?.id]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((d) => {
      if (dealerOnly && dealer?.id && String(d.dealerId) !== String(dealer.id)) return false;
      if (!q) return true;
      return [d.number, d.dealerName, d.dealerCode, d.date, fmtDate(d.date)].some(v => String(v || '').toLowerCase().includes(q));
    });
  }, [rows, query, dealerOnly, dealer?.id]);

  useEffect(() => { setActive(0); }, [query, dealerOnly, kind]);

  const pick = (d) => { if (d) onPick(d); };

  const onKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(i + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[active]); }
  };

  useEffect(() => {
    document.querySelector(`[data-order-row="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth
      TransitionProps={{ onEntered: () => inputRef.current?.focus() }}>
      <DialogTitle sx={{ fontWeight: 900, pb: 1 }}>Search Orders</DialogTitle>
      <DialogContent dividers sx={{ pt: 1.5 }}>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} sx={{ mb: 1.2 }}>
          <TextField
            fullWidth size="small" inputRef={inputRef} autoComplete="off" value={query}
            placeholder="Order no., dealer / shop name, or date (e.g. 10 Nov)" onChange={(e) => setQuery(e.target.value)} onKeyDown={onKeyDown}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          />
          <ToggleButtonGroup size="small" exclusive value={kind} onChange={(_, v) => v && setKind(v)}>
            <ToggleButton value="order" sx={{ fontWeight: 800, textTransform: 'none', whiteSpace: 'nowrap' }}>Pending Orders</ToggleButton>
            <ToggleButton value="quotation" sx={{ fontWeight: 800, textTransform: 'none' }}>Quotations</ToggleButton>
          </ToggleButtonGroup>
        </Stack>
        {dealer?.id && (
          <FormControlLabel sx={{ mb: 0.5 }}
            control={<Checkbox size="small" checked={dealerOnly} onChange={(e) => setDealerOnly(e.target.checked)} />}
            label={<Typography variant="body2" fontWeight={700}>Only {dealer.name}</Typography>} />
        )}
        {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
        <TableContainer sx={{ maxHeight: 380, border: '1px solid #e2e8f0', borderRadius: 1 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                {[kind === 'order' ? 'Order No.' : 'Quotation No.', 'Date', 'Dealer / Shop', 'Items', 'Units', 'Total'].map(h => (
                  <TableCell key={h} sx={HEAD_SX} align={['Items', 'Units', 'Total'].includes(h) ? 'right' : 'left'}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {loading && <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4 }}><CircularProgress size={22} /></TableCell></TableRow>}
              {!loading && !shown.length && (
                <TableRow><TableCell colSpan={6} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  {rows.length ? 'Nothing matches the search.' : kind === 'order' ? 'No pending wholesale orders.' : 'No open quotations.'}
                </TableCell></TableRow>
              )}
              {!loading && shown.map((d, i) => (
                <TableRow key={d.id} hover selected={i === active} data-order-row={i} onClick={() => pick(d)} onMouseEnter={() => setActive(i)} sx={{ cursor: 'pointer' }}>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 800 }}>{d.number}</TableCell>
                  <TableCell>{fmtDate(d.date)}</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>{d.dealerName} <Typography component="span" variant="caption" color="text.secondary">{d.dealerCode}</Typography></TableCell>
                  <TableCell align="right">{d.items.length}</TableCell>
                  <TableCell align="right">{d.items.reduce((a, l) => a + lineUnits(l), 0)}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 800 }}>{inr(d.total)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between', px: 2 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Chip size="small" label={`${shown.length} found`} sx={{ fontWeight: 800 }} />
          <Typography variant="caption" color="text.secondary">↑/↓ choose · Enter loads it into the bill</Typography>
        </Stack>
        <Stack direction="row" spacing={1}>
          <Button onClick={onClose} color="inherit" sx={{ fontWeight: 800 }}>Close</Button>
          <Button variant="contained" disabled={!shown[active]} onClick={() => pick(shown[active])} sx={{ fontWeight: 900 }}>Load into Bill</Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
