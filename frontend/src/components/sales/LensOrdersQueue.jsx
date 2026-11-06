import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Box, Card, Typography, Button, Chip, Stack, TextField, InputAdornment, Table, TableHead, TableBody,
  TableRow, TableCell, TableContainer, Paper, Tooltip, IconButton, LinearProgress, FormControlLabel, Switch,
} from '@mui/material';
import {
  Search as SearchIcon,
  Refresh as RefreshIcon,
  ShoppingCart as PurchaseIcon,
  MoveToInbox as ReceiveIcon,
  Inventory as StockIcon,
  ReceiptLong as InvoiceIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import { useDebounce } from '../../hooks/useDebounce';
import { rxCells } from '../../utils/lensPurchaseOrders';
import {
  LENS_QUEUE_API, QUEUE_STATUSES, queueStatusMeta, needsPurchase, awaitingReceipt, awaitingStockEntry,
  canBillOrder, firstPo, lensUnitText,
} from '../../utils/lensOrderQueue';

const fmtDate = (d) => (d ? new Date(d).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
const RECEIVABLE_PO = ['PENDING', 'ORDERED', 'PARTIALLY_RECEIVED'];

function RxTable({ lenses }) {
  return (
    <Table size="small" sx={{ '& td, & th': { px: 0.75, py: 0.25, fontSize: '0.75rem', borderBottom: 'none' } }}>
      <TableHead>
        <TableRow>
          {['Eye', 'SPH', 'CYL', 'AXIS', 'ADD'].map(h => <TableCell key={h} sx={{ fontWeight: 800, color: 'text.secondary' }}>{h}</TableCell>)}
        </TableRow>
      </TableHead>
      <TableBody>
        {lenses.map(l => {
          const c = rxCells(l.rx);
          return (
            <TableRow key={`${l.sales_order_item}-${l.eye}`}>
              <TableCell sx={{ fontWeight: 800, color: l.eye === 'RE' ? '#2563eb' : '#059669' }}>{l.eye === 'RE' ? 'OD' : 'OS'}</TableCell>
              <TableCell>{c.sph}</TableCell>
              <TableCell>{c.cyl}</TableCell>
              <TableCell>{c.axis}</TableCell>
              <TableCell>{c.add}</TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/**
 * Sales > Orders > Lenses: out-of-stock lens special orders, from booking to handover.
 * Pending Supplier Purchase → (Purchase Entry / Lens PO) Purchase Placed → (receive) Received →
 * (Purchase Entry brings the stock in) Received / Ready for Delivery → billed in New Sale.
 */
export default function LensOrdersQueue({ onCreateLensPurchase, onReceiveLensPO, onStockLensPO, onBillLensOrder, onEditInNewSale }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('ALL');
  const [includeDelivered, setIncludeDelivered] = useState(false);
  const debounced = useDebounce(search, 250);

  const load = useCallback(() => {
    setLoading(true);
    axios.get(LENS_QUEUE_API, { params: { search: debounced.trim() || undefined, include_delivered: includeDelivered ? 1 : undefined } })
      .then(res => { setRows(Array.isArray(res.data) ? res.data : []); setError(''); })
      .catch(() => setError('Could not load the lens orders — check the server connection and refresh.'))
      .finally(() => setLoading(false));
  }, [debounced, includeDelivered]);
  useEffect(() => { load(); }, [load]);

  const counts = useMemo(() => rows.reduce((acc, r) => ({ ...acc, [r.queue_status]: (acc[r.queue_status] || 0) + 1 }), {}), [rows]);
  const shown = statusFilter === 'ALL' ? rows : rows.filter(r => r.queue_status === statusFilter);

  const actionFor = (row) => {
    if (needsPurchase(row)) {
      return (
        <Button size="small" variant="contained" color="warning" startIcon={<PurchaseIcon />} onClick={() => onCreateLensPurchase?.(row)}
          sx={{ fontWeight: 800, textTransform: 'none', whiteSpace: 'nowrap' }}>
          Purchase Lens
        </Button>
      );
    }
    if (awaitingReceipt(row)) {
      const po = firstPo(row, p => RECEIVABLE_PO.includes(p.status));
      return po && (
        <Button size="small" variant="outlined" color="info" startIcon={<ReceiveIcon />} onClick={() => onReceiveLensPO?.(po)}
          sx={{ fontWeight: 800, textTransform: 'none', whiteSpace: 'nowrap' }}>
          Receive Lenses ({po.po_number})
        </Button>
      );
    }
    if (awaitingStockEntry(row)) {
      const po = firstPo(row, p => !p.purchase_invoice);
      return po && (
        <Tooltip title="The lenses have arrived. Saving their Purchase Entry logs the vendor bill and adds them to stock, held for this customer.">
          <Button size="small" variant="contained" color="secondary" startIcon={<StockIcon />} onClick={() => onStockLensPO?.(po)}
            sx={{ fontWeight: 800, textTransform: 'none', whiteSpace: 'nowrap' }}>
            Add to Stock — Purchase Entry
          </Button>
        </Tooltip>
      );
    }
    if (canBillOrder(row)) {
      return (
        <Button size="small" variant="contained" color="success" startIcon={<InvoiceIcon />} onClick={() => onBillLensOrder?.(row)}
          sx={{ fontWeight: 800, textTransform: 'none', whiteSpace: 'nowrap' }}>
          Bill / Convert to Invoice
        </Button>
      );
    }
    if (row.billed) return <Typography variant="caption" fontWeight={800} color="success.main">Billed — hand over to the patient</Typography>;
    return null;
  };

  return (
    <Box>
      <Card elevation={0} sx={{ p: 2, border: '1px solid', borderColor: 'divider', borderRadius: 3, mb: 2 }}>
        <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center', mb: 1.5 }}>
          <Chip label={`All (${rows.length})`} onClick={() => setStatusFilter('ALL')}
            color={statusFilter === 'ALL' ? 'primary' : 'default'} sx={{ fontWeight: 800 }} />
          {Object.entries(QUEUE_STATUSES).filter(([code]) => includeDelivered || code !== 'DELIVERED').map(([code, meta]) => (
            <Chip key={code} label={`${meta.label} (${counts[code] || 0})`} onClick={() => setStatusFilter(code)}
              color={statusFilter === code ? meta.color : 'default'} variant={statusFilter === code ? 'filled' : 'outlined'} sx={{ fontWeight: 700 }} />
          ))}
        </Box>
        <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
          <TextField size="small" placeholder="Search order no, patient, patient ID or phone" value={search} onChange={(e) => setSearch(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
            sx={{ flex: 1, minWidth: 240 }} />
          <FormControlLabel control={<Switch size="small" checked={includeDelivered} onChange={(e) => setIncludeDelivered(e.target.checked)} />}
            label={<Typography variant="body2" fontWeight={700}>Show delivered</Typography>} />
          <IconButton onClick={load} title="Refresh"><RefreshIcon /></IconButton>
        </Stack>
      </Card>

      <Card elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
        {loading && <LinearProgress />}
        {error && <Typography color="error" sx={{ p: 2, fontWeight: 700 }}>{error}</Typography>}
        {!loading && !error && shown.length === 0 ? (
          <Box sx={{ p: 5, textAlign: 'center' }}>
            <Typography variant="h6" fontWeight={800}>No lens orders</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 520, mx: 'auto' }}>
              {rows.length ? 'No lens orders match this filter.'
                : 'In New Sale, select the patient and click "+ NEW Lens" for a lens that is out of stock — the bill becomes a Customer Order and lands here as Pending Supplier Purchase.'}
            </Typography>
          </Box>
        ) : (
          <TableContainer component={Paper} elevation={0}>
            <Table size="small">
              <TableHead sx={{ bgcolor: 'action.hover' }}>
                <TableRow>
                  {['Order', 'Patient', 'Lens', 'Prescription', 'Supplier PO', 'Status', 'Action'].map(h => (
                    <TableCell key={h} sx={{ fontWeight: 800 }}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {shown.map(row => {
                  const meta = queueStatusMeta(row.queue_status);
                  const t = row.totals || {};
                  const products = [...new Set(row.lenses.map(l => l.product_name))];
                  const index = [...new Set(row.lenses.map(l => l.lens_index).filter(Boolean))].join(', ');
                  return (
                    <TableRow key={row.id} hover sx={{ verticalAlign: 'top' }}>
                      <TableCell>
                        <Typography variant="body2" fontWeight={900}>{row.invoice_number}</Typography>
                        <Typography variant="caption" color="text.secondary" display="block">{fmtDate(row.invoice_date)}</Typography>
                        {row.billed && <Chip size="small" label="Invoiced" color="success" variant="outlined" sx={{ mt: 0.5, height: 20, fontWeight: 800 }} />}
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={800}>{row.customer_name || '—'}</Typography>
                        <Typography variant="caption" color="text.secondary" display="block">
                          {[row.patient_code, row.customer_phone, row.test_no && `Test ${row.test_no}`].filter(Boolean).join(' · ') || '—'}
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Typography variant="body2" fontWeight={800}>{products.join(', ')}</Typography>
                        <Typography variant="caption" color="text.secondary" display="block">
                          {lensUnitText(row.lenses)}{index ? ` · Index ${index}` : ''}
                        </Typography>
                      </TableCell>
                      <TableCell sx={{ minWidth: 220 }}><RxTable lenses={row.lenses} /></TableCell>
                      <TableCell>
                        {row.purchase_orders.length === 0 ? <Typography variant="caption" color="text.secondary">Not ordered</Typography>
                          : row.purchase_orders.map(po => (
                            <Box key={po.id} sx={{ mb: 0.5 }}>
                              <Typography variant="body2" fontWeight={800}>{po.po_number}</Typography>
                              <Typography variant="caption" color="text.secondary" display="block">
                                {po.supplier_name} · {po.status_label}{po.purchase_invoice_number ? ` · PE ${po.purchase_invoice_number}` : ''}
                              </Typography>
                            </Box>
                          ))}
                      </TableCell>
                      <TableCell>
                        <Chip size="small" color={meta.color} label={meta.label} sx={{ fontWeight: 800 }} />
                        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 0.5 }}>
                          {t.ordered || 0}/{t.required || 0} ordered · {t.received || 0} received
                        </Typography>
                      </TableCell>
                      <TableCell>
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          {actionFor(row)}
                          {!row.billed && (
                            <Tooltip title="Open the order in New Sale">
                              <IconButton size="small" onClick={() => onEditInNewSale?.(row)}><EditIcon fontSize="small" /></IconButton>
                            </Tooltip>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </Card>
    </Box>
  );
}
