import React, { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import axios from 'axios';
import { Card, Typography, Grid, LinearProgress, Chip, Stack, Box, Alert } from '@mui/material';

const TERMINAL_STATUSES = ['SUCCESS', 'PARTIAL', 'FAILED'];
const STATUS_COLORS = { PENDING: 'default', PROCESSING: 'primary', SUCCESS: 'success', PARTIAL: 'warning', FAILED: 'error' };

function formatDuration(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  return m < 60 ? `${m}m ${sec % 60}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

export default function ImportProgressCard({ batchId, onDone, onMissing }) {
  // First progress sample seen by this card. The rate is measured from here rather
  // than from mount time, so reopening the page mid-import doesn't credit rows
  // imported before it was opened to the last few seconds.
  const firstSampleRef = useRef(null);
  const notifiedRef = useRef(null);

  useEffect(() => {
    firstSampleRef.current = null;
    notifiedRef.current = null;
  }, [batchId]);

  const { data: batch, error } = useQuery({
    queryKey: ['import-status', batchId],
    queryFn: async () => (await axios.get(`/api/import/${batchId}/status/`)).data,
    enabled: !!batchId,
    retry: (count, err) => err?.response?.status !== 404 && count < 2,
    refetchInterval: (query) => (TERMINAL_STATUSES.includes(query.state.data?.status) ? false : 1500),
  });

  useEffect(() => {
    if (error?.response?.status === 404) onMissing?.();
  }, [error, onMissing]);

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
  if (!firstSampleRef.current || processed < firstSampleRef.current.processed) {
    firstSampleRef.current = { processed, at: Date.now() };
  }
  const sampleSec = (Date.now() - firstSampleRef.current.at) / 1000;
  const rate = sampleSec > 2 ? (processed - firstSampleRef.current.processed) / sampleSec : 0;
  const etaSec = rate > 0 && remaining > 0 ? Math.round(remaining / rate) : 0;
  const lastLog = (batch.logs || []).slice(-1)[0];

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
            {TERMINAL_STATUSES.includes(batch.status)
              ? `${formatDuration(Math.round(batch.processing_time || 0))} total`
              : (etaSec > 0 ? formatDuration(etaSec) : '—')}
          </Typography>
        </Grid>
      </Grid>

      {error && error.response?.status !== 404 && (
        <Alert severity="warning" sx={{ mt: 2 }}>
          Lost contact with the server. The import keeps running there; progress will update when the connection returns.
        </Alert>
      )}

      {(batch.remarks || lastLog) && (
        <Box sx={{ mt: 2 }}>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{batch.remarks}</Typography>
          {lastLog && lastLog.includes('Resuming') && (
            <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>{lastLog}</Typography>
          )}
        </Box>
      )}
    </Card>
  );
}
