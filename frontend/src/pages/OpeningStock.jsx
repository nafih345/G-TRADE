// Inventory → Opening Stock: record the stock a newly onboarded shop already holds, either typed
// into a quick grid or loaded from the shop's own Excel sheet (any column layout). Every item
// becomes a new product tagged "Opening Stock" — kept apart from purchases and Admin Excel imports
// in Stock Overview — with its quantity ledgered and the batch's cost booked to opening equity.
// Backend: apps/inventory/opening_stock.py.
import React, { useCallback, useEffect, useState } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Alert, Box, Breadcrumbs, Button, Card, Chip, Link, Tab, Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Tabs, Typography,
} from '@mui/material';
import { EditNote as ManualIcon, UploadFile as ExcelIcon, History as HistoryIcon, Inventory as OverviewIcon } from '@mui/icons-material';
import OpeningStockManualGrid from '../components/inventory/opening/OpeningStockManualGrid';
import OpeningStockExcelImport from '../components/inventory/opening/OpeningStockExcelImport';
import { fetchOpeningBatches, fetchStockFacets, formatDateTime, formatMoney, formatQty } from '../components/purchasing/stock/stockApi';
import { apiErrorMessage } from '../utils/apiError';
import { notify } from '../utils/notify';

const TAB_KEY = 'opening_stock_tab';
const OVERVIEW_URL = '/inventory/stock-overview?source=OPENING_STOCK';

export default function OpeningStock() {
  const navigate = useNavigate();
  const [tab, setTab] = useState(() => { try { return localStorage.getItem(TAB_KEY) || 'manual'; } catch { return 'manual'; } });
  const [facets, setFacets] = useState(null);
  const [facetsError, setFacetsError] = useState('');
  const [batches, setBatches] = useState(null);
  const [lastSaved, setLastSaved] = useState(null);
  const caps = facets?.permissions || {};
  const canSave = Boolean(caps.adjust_stock);

  useEffect(() => {
    fetchStockFacets().then(setFacets).catch((err) => setFacetsError(apiErrorMessage(err, 'Could not load stock settings.')));
  }, []);
  const loadBatches = useCallback(() => {
    fetchOpeningBatches().then(setBatches).catch(() => setBatches([]));
  }, []);
  useEffect(() => { loadBatches(); }, [loadBatches]);

  const chooseTab = (value) => {
    setTab(value);
    try { localStorage.setItem(TAB_KEY, value); } catch { /* private mode */ }
  };

  const onSaved = (batch, { redirect } = {}) => {
    window.dispatchEvent(new Event('optical_stock_updated'));
    loadBatches();
    notify(`${batch.batch_number}: ${formatQty(batch.product_count)} item(s), ${formatQty(batch.total_quantity)} units added as opening stock.`);
    if (redirect) navigate(OVERVIEW_URL);
    else setLastSaved(batch);
  };

  return (
    <Box sx={{ p: { xs: 1.5, md: 2 }, pb: 6 }}>
      <Breadcrumbs sx={{ mb: 0.5, fontSize: 13 }}>
        <Link component={RouterLink} to="/inventory/products" underline="hover" color="inherit">Inventory</Link>
        <Typography color="text.primary" fontSize={13} fontWeight={700}>Opening Stock</Typography>
      </Breadcrumbs>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 2, flexWrap: 'wrap', mb: 2 }}>
        <Box>
          <Typography variant="h4" fontWeight={800}>Opening Stock</Typography>
          <Typography variant="body2" color="text.secondary">
            Bring in the stock the shop already holds. Each item is added as a new product tagged Opening Stock.
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<OverviewIcon />} component={RouterLink} to={OVERVIEW_URL} sx={{ fontWeight: 800 }}>
          View Opening Stock in Stock Overview
        </Button>
      </Box>

      {facetsError && <Alert severity="warning" sx={{ mb: 2 }}>{facetsError}</Alert>}
      {facets && !canSave && (
        <Alert severity="info" sx={{ mb: 2 }}>Your role can view opening stock loads but not add them.</Alert>
      )}
      {lastSaved && (
        <Alert severity="success" sx={{ mb: 2 }} onClose={() => setLastSaved(null)}
          action={<Button color="inherit" size="small" component={RouterLink} to={OVERVIEW_URL}>View</Button>}>
          Saved {lastSaved.batch_number}: {formatQty(lastSaved.product_count)} item(s), {formatQty(lastSaved.total_quantity)} units
          {lastSaved.total_value !== null ? ` · ${formatMoney(lastSaved.total_value)} at cost` : ''}.
        </Alert>
      )}

      <Tabs value={tab} onChange={(_, v) => chooseTab(v)} sx={{ mb: 2, borderBottom: '1px solid', borderColor: 'divider' }}>
        <Tab value="manual" icon={<ManualIcon />} iconPosition="start" label="Fast Manual Entry" sx={{ fontWeight: 800 }} />
        <Tab value="excel" icon={<ExcelIcon />} iconPosition="start" label="Excel Import" sx={{ fontWeight: 800 }} />
        <Tab value="history" icon={<HistoryIcon />} iconPosition="start" label={`Recent Loads${batches?.length ? ` (${batches.length})` : ''}`} sx={{ fontWeight: 800 }} />
      </Tabs>

      {tab === 'manual' && <OpeningStockManualGrid facets={facets} canSave={canSave} onSaved={onSaved} />}
      {tab === 'excel' && <OpeningStockExcelImport canSave={canSave} onSaved={onSaved} />}
      {tab === 'history' && (
        <Card variant="outlined" sx={{ borderRadius: 3 }}>
          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  {['Batch', 'Method', 'File', 'Items', 'Units', 'Value at cost', 'By', 'Saved'].map((h) => (
                    <TableCell key={h} sx={{ fontWeight: 800 }} align={['Items', 'Units', 'Value at cost'].includes(h) ? 'right' : 'left'}>{h}</TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody>
                {(batches || []).map((b) => (
                  <TableRow key={b.id} hover>
                    <TableCell sx={{ fontWeight: 700, fontFamily: 'monospace' }}>{b.batch_number}</TableCell>
                    <TableCell><Chip size="small" label={b.method_label} variant="outlined" /></TableCell>
                    <TableCell>{b.file_name || '—'}</TableCell>
                    <TableCell align="right">{formatQty(b.product_count)}</TableCell>
                    <TableCell align="right">{formatQty(b.total_quantity)}</TableCell>
                    <TableCell align="right">{b.total_value === null ? 'Restricted' : formatMoney(b.total_value)}</TableCell>
                    <TableCell>{b.performed_by || '—'}</TableCell>
                    <TableCell>{formatDateTime(b.created_at)}</TableCell>
                  </TableRow>
                ))}
                {batches && !batches.length && (
                  <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>No opening stock loaded yet.</TableCell></TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}
    </Box>
  );
}
