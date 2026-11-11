import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Card, Chip, CircularProgress, Stack, Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import { AssignmentReturn as ReturnIcon } from '@mui/icons-material';
import { apiErrorMessage } from '../../utils/apiError';
import ReturnDetailDialog from './ReturnDetailDialog';
import { RETURN_KINDS, fetchReturnReport, fmtDate, fmtMoney } from './returnsApi';

/**
 * "Sales Returns" / "Purchase Returns" block placed at the bottom of a report: the period's
 * returns, their totals by refund mode, and a click-through to the full return (products,
 * original bill, exact reason, refund mode + bank). `onSummary(summary)` lets the host report
 * net its own revenue / purchase totals.
 */
export default function ReturnsReportSection({ kind, dateFrom, dateTo, search = '', onSummary }) {
  const cfg = RETURN_KINDS[kind];
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError('');
    const t = setTimeout(() => {
      fetchReturnReport(kind, { date_from: dateFrom || undefined, date_to: dateTo || undefined, search: search || undefined })
        .then((d) => { if (alive) { setData(d); onSummary?.(d.summary); } })
        .catch((e) => { if (alive) { setError(apiErrorMessage(e, 'Could not load returns.')); onSummary?.(null); } })
        .finally(() => { if (alive) setLoading(false); });
    }, 300);
    return () => { alive = false; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind, dateFrom, dateTo, search]);

  const rows = data?.rows || [];
  const s = data?.summary;
  return (
    <Card variant="outlined" sx={{ mt: 3, borderRadius: 3, borderColor: 'error.light' }} data-returns-section={kind}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} alignItems={{ sm: 'center' }} justifyContent="space-between"
        sx={{ p: 1.5, bgcolor: (t) => (t.palette.mode === 'dark' ? 'rgba(239,68,68,0.10)' : '#fef2f2') }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <ReturnIcon sx={{ color: 'error.main' }} />
          <Typography variant="subtitle1" fontWeight={800} color="error.main">{kind === 'sales' ? 'Sales Returns' : 'Purchase Returns'}</Typography>
          {s && <Chip size="small" color="error" label={`${s.count} · ${fmtMoney(s.total_amount)}`} sx={{ fontWeight: 800 }} />}
        </Stack>
        {s && Object.keys(s.by_mode || {}).length > 0 && (
          <Typography variant="caption" color="text.secondary">
            {Object.entries(s.by_mode).map(([m, v]) => `${m} ${fmtMoney(v)}`).join(' · ')}
          </Typography>
        )}
      </Stack>
      {loading && <Box sx={{ p: 3, textAlign: 'center' }}><CircularProgress size={22} /></Box>}
      {error && <Alert severity="warning" sx={{ m: 1.5 }}>{error}</Alert>}
      {!loading && !error && rows.length === 0 && (
        <Typography variant="body2" color="text.secondary" sx={{ p: 2 }}>No {cfg.title.toLowerCase()}s in this period.</Typography>
      )}
      {!loading && rows.length > 0 && (
        <Box sx={{ overflowX: 'auto' }}>
          <Table size="small" sx={{ minWidth: 820 }}>
            <TableHead>
              <TableRow>
                {['Return No.', 'Date', `Original ${cfg.original}`, cfg.party, 'Products (qty)', 'Reason', 'Refund Mode', 'Amount'].map((h) => (
                  <TableCell key={h} sx={{ fontWeight: 800 }} align={h === 'Amount' ? 'right' : 'left'}>{h}</TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const cancelled = r.status === 'CANCELLED';
                return (
                  <TableRow key={r.id} hover onClick={() => setView(r)} sx={{ cursor: 'pointer', opacity: cancelled ? 0.5 : 1 }}
                    title="Click to see the products, reason and refund details">
                    <TableCell sx={{ fontWeight: 800, color: 'error.main' }}>
                      {r.return_number}{cancelled && <Chip size="small" label="Cancelled" sx={{ ml: 0.5 }} />}
                    </TableCell>
                    <TableCell>{fmtDate(r.return_date)}</TableCell>
                    <TableCell>{r.original?.number || 'Manual'}</TableCell>
                    <TableCell>{r.party?.name || '—'}</TableCell>
                    <TableCell>{(r.items || []).map((i) => `${i.description} ×${i.return_qty}`).join(', ')}</TableCell>
                    <TableCell>{(r.reasons || []).join(', ')}</TableCell>
                    <TableCell>{r.settlement_text}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800, color: 'error.main', textDecoration: cancelled ? 'line-through' : 'none' }}>
                      −{fmtMoney(r.total_amount)}
                    </TableCell>
                  </TableRow>
                );
              })}
              <TableRow>
                <TableCell colSpan={7} sx={{ fontWeight: 900 }}>Total {kind === 'sales' ? 'sales' : 'purchase'} returns ({s?.total_qty || 0} units, excl. cancelled)</TableCell>
                <TableCell align="right" sx={{ fontWeight: 900, color: 'error.main' }}>−{fmtMoney(s?.total_amount)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </Box>
      )}
      <ReturnDetailDialog kind={kind} open={!!view} returnId={view?.id} initial={view} onClose={() => setView(null)} />
    </Card>
  );
}
