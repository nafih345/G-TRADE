// Purchase → Barcode Printing: the module-level label queue.
//
// Every saved purchase entry that still has labels to print is listed (oldest purchase first,
// from /api/purchase/invoices/label-queue/), so items saved in Purchase Entry show up here
// without any extra step. The selected entry opens in PurchaseBarcodePrinting with all its
// pending lines ready — an interrupted job carries on from each line's next unit. When an entry
// is fully printed the queue moves on to the next one. Fully printed entries can still be found
// with "Find any entry" for reprints.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Box, Card, Grid, Typography, Stack, List, ListItemButton, ListItemText, Chip, Alert, IconButton, Tooltip,
  Autocomplete, TextField, LinearProgress,
} from '@mui/material';
import { Refresh as RefreshIcon } from '@mui/icons-material';
import PurchaseBarcodePrinting from './PurchaseBarcodePrinting';
import { notify } from '../../utils/notify';

const fmtDate = (iso) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString() : '');

export default function PurchaseLabelQueueView() {
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [selectedId, setSelectedId] = useState('');
  // True while the open entry was taken from the queue (not picked via "Find any entry"):
  // only then does finishing it move on to the next entry.
  const fromQueue = useRef(true);
  const [entries, setEntries] = useState([]);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get('/api/purchase/invoices/label-queue/');
      const rows = Array.isArray(data) ? data : [];
      setQueue(rows);
      setError('');
      return rows;
    } catch (err) {
      setError(err?.response ? 'Could not load the barcode printing queue.' : 'Cannot reach the server.');
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  // Open the first entry in the queue straight away.
  useEffect(() => {
    loadQueue().then((rows) => {
      if (rows?.length) setSelectedId((cur) => cur || rows[0].id);
    });
  }, [loadQueue]);

  // Any saved entry, for reprinting one that has left the queue.
  useEffect(() => {
    axios.get('/api/purchase/invoices/', { params: { page_size: 100 } })
      .then((res) => setEntries((Array.isArray(res.data) ? res.data : res.data?.results || [])
        .map((e) => ({ id: e.id, invoice_number: e.invoice_number, supplier_name: e.supplier_name }))))
      .catch(() => {});
  }, []);

  const pick = (id, viaQueue) => {
    fromQueue.current = viaQueue;
    setSelectedId(id);
  };

  // After each load / confirmation of the open entry: refresh the counts and, once a queued
  // entry has nothing left, carry on with the next one.
  const handleStatus = useCallback(async (st) => {
    const rows = await loadQueue();
    if (!rows || !st || st.totals.pending > 0 || !fromQueue.current) return;
    const next = rows.find((r) => r.id !== st.invoice.id);
    if (next) {
      notify(`${st.invoice.invoice_number}: all labels printed. Next in queue: ${next.invoice_number}.`, 'success');
      setSelectedId(next.id);
    }
  }, [loadQueue]);

  const totalLabels = queue.reduce((s, r) => s + r.pending_labels, 0);

  return (
    <Grid container spacing={2} data-testid="purchase-label-queue">
      <Grid item xs={12} md={4} lg={3}>
        <Card variant="outlined" sx={{ p: 1.5 }}>
          <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
            <Box sx={{ mr: 'auto' }}>
              <Typography variant="subtitle1" fontWeight={800}>Print queue</Typography>
              <Typography variant="caption" color="text.secondary">
                {queue.length ? `${queue.length} entr${queue.length === 1 ? 'y' : 'ies'} · ${totalLabels} labels to print` : 'Saved purchase entries with unprinted labels'}
              </Typography>
            </Box>
            <Tooltip title="Refresh"><span><IconButton size="small" onClick={loadQueue} disabled={loading}><RefreshIcon fontSize="small" /></IconButton></span></Tooltip>
          </Stack>
          {loading && <LinearProgress sx={{ mb: 1 }} />}
          {error && <Alert severity="error" sx={{ mb: 1 }}>{error}</Alert>}
          {!loading && !error && queue.length === 0 && (
            <Alert severity="success" sx={{ mb: 1 }}>All labels are printed. New purchase entries appear here once saved.</Alert>
          )}
          <List dense disablePadding sx={{ maxHeight: 520, overflow: 'auto' }}>
            {queue.map((r) => (
              <ListItemButton key={r.id} selected={r.id === selectedId} onClick={() => pick(r.id, true)}
                sx={{ borderRadius: 1, mb: 0.5, border: '1px solid', borderColor: r.id === selectedId ? 'primary.main' : 'divider' }}
                data-testid="label-queue-entry">
                <ListItemText
                  primary={<Typography variant="body2" fontWeight={700}>{r.invoice_number}{r.supplier_name ? ` · ${r.supplier_name}` : ''}</Typography>}
                  secondary={(
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }} component="span">
                      <Chip size="small" component="span" color="warning" variant="outlined" label={`${r.pending_labels} label${r.pending_labels === 1 ? '' : 's'} · ${r.pending_items} item${r.pending_items === 1 ? '' : 's'}`} />
                      {r.awaiting_confirmation
                        ? <Chip size="small" component="span" color="error" label="Confirm last job" />
                        : r.resume && <Chip size="small" component="span" color="info" label="Resume" />}
                      {r.purchase_date && <Typography variant="caption" component="span" color="text.secondary" sx={{ alignSelf: 'center' }}>{fmtDate(r.purchase_date)}</Typography>}
                    </Stack>
                  )}
                />
              </ListItemButton>
            ))}
          </List>
          <Autocomplete size="small" sx={{ mt: 1.5 }} options={entries} value={null} blurOnSelect
            getOptionLabel={(o) => `${o.invoice_number}${o.supplier_name ? ` — ${o.supplier_name}` : ''}`}
            onChange={(e, v) => v && pick(v.id, false)}
            renderInput={(params) => <TextField {...params} label="Find any entry" placeholder="e.g. to reprint a printed one" />} />
        </Card>
      </Grid>
      <Grid item xs={12} md={8} lg={9}>
        {selectedId ? (
          <PurchaseBarcodePrinting invoiceId={selectedId} hidePicker onStatus={handleStatus} sx={{ mt: 0 }} />
        ) : (
          !loading && <Alert severity="info">Pick a purchase entry from the queue — or save a new one in Purchase Entry.</Alert>
        )}
      </Grid>
    </Grid>
  );
}
