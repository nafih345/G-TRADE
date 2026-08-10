import React, { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Card, Typography, Grid, LinearProgress, Chip, Stack, Box } from '@mui/material';

const TERMINAL_STATUSES = ['SUCCESS', 'PARTIAL', 'FAILED'];
const STATUS_COLORS = { PENDING: 'default', PROCESSING: 'primary', SUCCESS: 'success', PARTIAL: 'warning', FAILED: 'error' };

export default function ImportProgressCard({ batchId, onDone }) {
  const startedAtRef = useRef(Date.now());
  const notifiedRef = useRef(null);

  useEffect(() => {
    startedAtRef.current = Date.now();
    notifiedRef.current = null;
  }, [batchId]);

  const { data: batch } = useQuery({
    queryKey: ['import-status', batchId],
    queryFn: async () => (await axios.get(`/api/import/${batchId}/status/`)).data,
    enabled: !!batchId,
    refetchInterval: (query) => (TERMINAL_STATUSES.includes(query.state.data?.status) ? false : 1000),
  });

  useEffect(() => {
    if (batch && TERMINAL_STATUSES.includes(batch.status) && notifiedRef.current !== batch.id) {
      notifiedRef.current = batch.id;
      onDone?.(batch);
    }
  }, [batch, onDone]);

  if (!batchId || !batch) return null;

  const total = batch.total_rows || 0;
  const processed = batch.processed_rows || 0;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const remaining = Math.max(0, total - processed);
  const elapsedSec = Math.max(0.5, (Date.now() - startedAtRef.current) / 1000);
  const rate = processed / elapsedSec;
  const etaSec = rate > 0 && remaining > 0 ? Math.round(remaining / rate) : 0;

  return (
    <Card variant="outlined" sx={{ p: 3, borderRadius: 3, mb: 3 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="h6" fontWeight={800}>Import Progress — {batch.batch_number}</Typography>
        <Chip label={batch.status} color={STATUS_COLORS[batch.status] || 'default'} sx={{ fontWeight: 800 }} />
      </Stack>

      <LinearProgress variant={total ? 'determinate' : 'indeterminate'} value={pct} sx={{ height: 10, borderRadius: 5, mb: 2.5 }} />

      <Grid container spacing={2}>
        <Grid item xs={6} sm={4} md={2}>
          <Typography variant="caption" color="text.secondary">Rows Read</Typography>
          <Typography variant="h6" fontWeight={800}>{processed.toLocaleString()} / {total.toLocaleString()}</Typography>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Typography variant="caption" color="text.secondary">Imported</Typography>
          <Typography variant="h6" fontWeight={800} color="success.main">{(batch.imported_rows || 0).toLocaleString()}</Typography>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Typography variant="caption" color="text.secondary">Duplicates</Typography>
          <Typography variant="h6" fontWeight={800} color="warning.main">{(batch.duplicate_rows || 0).toLocaleString()}</Typography>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Typography variant="caption" color="text.secondary">Failed</Typography>
          <Typography variant="h6" fontWeight={800} color="error.main">{(batch.failed_rows || 0).toLocaleString()}</Typography>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Typography variant="caption" color="text.secondary">Remaining</Typography>
          <Typography variant="body1" fontWeight={700}>{remaining.toLocaleString()}</Typography>
        </Grid>
        <Grid item xs={6} sm={4} md={2}>
          <Typography variant="caption" color="text.secondary">Estimated Time</Typography>
          <Typography variant="body1" fontWeight={700}>
            {TERMINAL_STATUSES.includes(batch.status) ? `${batch.processing_time}s total` : (etaSec > 0 ? `${etaSec}s` : '—')}
          </Typography>
        </Grid>
      </Grid>

      {batch.remarks && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary">{batch.remarks}</Typography>
        </Box>
      )}
    </Card>
  );
}
