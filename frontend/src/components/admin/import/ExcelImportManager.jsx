import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Box, Card, Typography, Button, Tab, Tabs, Stack, IconButton,
  Table, TableBody, TableCell, TableContainer, TableHead, TableRow, Paper, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, MenuItem,
  RadioGroup, FormControlLabel, Radio, Alert
} from '@mui/material';
import {
  CloudUpload as UploadIcon,
  History as HistoryIcon,
  ReportProblem as ErrorIcon,
  Storage as StorageIcon,
  Download as DownloadIcon,
  Delete as DeleteIcon,
  Visibility as ViewIcon,
  Refresh as RefreshIcon,
  Preview as PreviewIcon
} from '@mui/icons-material';
import axios from 'axios';

import ImportUploadPanel from './ImportUploadPanel';
import ImportProgressCard from './ImportProgressCard';
import VirtualizedProductGrid from './VirtualizedProductGrid';
import FailedRecordsPanel from './FailedRecordsPanel';

const TABS = [
  { value: 'upload', label: 'Upload & Progress', icon: <UploadIcon /> },
  { value: 'preview', label: 'Data Preview', icon: <PreviewIcon /> },
  { value: 'history', label: 'Import History', icon: <HistoryIcon /> },
  { value: 'failed', label: 'Failed Records', icon: <ErrorIcon /> },
  { value: 'catalog', label: 'Database Catalog', icon: <StorageIcon /> },
];

export default function ExcelImportManager() {
  const queryClient = useQueryClient();
  const [activeTab, setActiveTab] = useState('upload');
  const [alertMsg, setAlertMsg] = useState(null);

  const [activeBatchId, setActiveBatchId] = useState(null);
  const [previewBatch, setPreviewBatch] = useState(null); // { id, batch_number }
  const [errorsBatch, setErrorsBatch] = useState(null); // { id, batch_number }

  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [batchToDelete, setBatchToDelete] = useState(null);
  const [deleteMode, setDeleteMode] = useState('option2');

  const { data: batches = [], refetch: refetchHistory } = useQuery({
    queryKey: ['import-history'],
    queryFn: async () => (await axios.get('/api/import/history/')).data || [],
  });

  const handleImportStarted = (batchId) => {
    setActiveBatchId(batchId);
    setAlertMsg(null);
  };

  const handleImportDone = (batch) => {
    refetchHistory();
    queryClient.invalidateQueries({ queryKey: ['product-grid'] });
    setPreviewBatch({ id: batch.id, batch_number: batch.batch_number });
    setAlertMsg({
      severity: batch.status === 'FAILED' ? 'error' : (batch.status === 'PARTIAL' ? 'warning' : 'success'),
      text: `Import ${batch.batch_number} finished: ${batch.imported_rows} imported, ${batch.duplicate_rows} duplicates, ${batch.failed_rows} failed.`
    });
  };

  const handleDownloadSample = () => window.open('/api/import/download-template/', '_blank');

  const handleDeleteBatch = async () => {
    if (!batchToDelete) return;
    try {
      const res = await axios.delete(`/api/import/${batchToDelete.id}/?delete_mode=${deleteMode}`);
      const deletedSkus = res.data?.deleted_product_skus || [];
      const deletedIds = res.data?.deleted_product_ids || [];

      // Keep the legacy localStorage inventory cache (still read by other pages) in sync
      try {
        const local = JSON.parse(localStorage.getItem('optical_inventory_items') || '[]');
        const cleaned = deleteMode === 'option2'
          ? local.filter(p => !deletedSkus.includes(String(p.code)) && !deletedSkus.includes(String(p.sku)) && !deletedIds.includes(String(p.id)))
          : local;
        localStorage.setItem('optical_inventory_items', JSON.stringify(cleaned));
        window.dispatchEvent(new Event('optical_stock_updated'));
      } catch (e) {}

      setAlertMsg({ severity: 'info', text: res.data?.message || 'Import batch deleted.' });
      refetchHistory();
      queryClient.invalidateQueries({ queryKey: ['product-grid'] });
    } catch (e) {
      setAlertMsg({ severity: 'error', text: e.response?.data?.error || 'Failed to delete import batch.' });
    } finally {
      setDeleteModalOpen(false);
      setBatchToDelete(null);
    }
  };

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" fontWeight={850} color="primary">Excel Import Management System</Typography>
          <Typography variant="body2" color="text.secondary">
            Enterprise-grade product importer — streamed, chunked, and backgrounded for unlimited-row files.
          </Typography>
        </Box>
        <Button variant="outlined" startIcon={<DownloadIcon />} onClick={handleDownloadSample} sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}>
          Download Sample Template (.CSV)
        </Button>
      </Box>

      {alertMsg && (
        <Alert severity={alertMsg.severity} onClose={() => setAlertMsg(null)} sx={{ mb: 3, borderRadius: 3, fontWeight: 700 }}>
          {alertMsg.text}
        </Alert>
      )}

      <Card sx={{ mb: 3, borderRadius: 3 }}>
        <Tabs value={activeTab} onChange={(e, val) => setActiveTab(val)} variant="scrollable" scrollButtons="auto" sx={{ px: 2, borderBottom: 1, borderColor: 'divider' }}>
          {TABS.map(t => (
            <Tab key={t.value} value={t.value} label={t.label} icon={t.icon} iconPosition="start" sx={{ fontWeight: 700 }} />
          ))}
        </Tabs>
      </Card>

      {activeTab === 'upload' && (
        <>
          <ImportUploadPanel onImportStarted={handleImportStarted} />
          <ImportProgressCard batchId={activeBatchId} onDone={handleImportDone} />
        </>
      )}

      {activeTab === 'preview' && (
        <Card variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2, flexWrap: 'wrap', gap: 1 }}>
            <Typography variant="h6" fontWeight={800}>Complete Data Preview</Typography>
            <TextField
              select size="small" label="Import Batch" value={previewBatch?.id || ''}
              sx={{ minWidth: 280 }}
              onChange={(e) => setPreviewBatch(batches.find(b => b.id === e.target.value) || null)}
            >
              {batches.map(b => (
                <MenuItem key={b.id} value={b.id}>{b.batch_number} ({b.imported_rows} rows)</MenuItem>
              ))}
            </TextField>
          </Box>
          {previewBatch ? (
            <VirtualizedProductGrid endpoint={`/api/import/${previewBatch.id}/rows/`} emptyHint="This batch has no rows yet." />
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ py: 4, textAlign: 'center' }}>
              Select an import batch above, or start a new import from the "Upload & Progress" tab.
            </Typography>
          )}
        </Card>
      )}

      {activeTab === 'history' && (
        <Card variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
            <Typography variant="h6" fontWeight={850} color="primary">Import History & Batch Audits</Typography>
            <Button startIcon={<RefreshIcon />} onClick={() => refetchHistory()}>Refresh</Button>
          </Box>

          <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid #cbd5e1', borderRadius: 3 }}>
            <Table size="small">
              <TableHead sx={{ bgcolor: '#0f172a' }}>
                <TableRow>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Batch Number</TableCell>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>File Name</TableCell>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Uploaded By</TableCell>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Upload Date</TableCell>
                  <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Status</TableCell>
                  <TableCell align="right" sx={{ color: '#fff', fontWeight: 800 }}>Total Rows</TableCell>
                  <TableCell align="right" sx={{ color: '#fff', fontWeight: 800 }}>Imported</TableCell>
                  <TableCell align="right" sx={{ color: '#fff', fontWeight: 800 }}>Failed</TableCell>
                  <TableCell align="center" sx={{ color: '#fff', fontWeight: 800 }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {batches.length === 0 ? (
                  <TableRow><TableCell colSpan={9} align="center" sx={{ py: 5 }}>
                    <Typography variant="body2" color="text.secondary">No import batches yet.</Typography>
                  </TableCell></TableRow>
                ) : batches.map(b => (
                  <TableRow key={b.id} hover>
                    <TableCell sx={{ fontWeight: 800, fontFamily: 'monospace', color: 'primary.main' }}>{b.batch_number}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{b.file_name}</TableCell>
                    <TableCell>{b.uploaded_by}</TableCell>
                    <TableCell sx={{ fontSize: '0.82rem' }}>{b.uploaded_date}</TableCell>
                    <TableCell>
                      <Chip
                        label={b.status} size="small" sx={{ fontWeight: 800 }}
                        color={{ SUCCESS: 'success', PARTIAL: 'warning', FAILED: 'error', PROCESSING: 'primary' }[b.status] || 'default'}
                      />
                    </TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700 }}>{b.total_rows}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 800, color: 'success.main' }}>{b.imported_rows}</TableCell>
                    <TableCell align="right" sx={{ fontWeight: 700, color: 'error.main' }}>{b.failed_rows}</TableCell>
                    <TableCell align="center">
                      <Stack direction="row" spacing={1} justifyContent="center">
                        <IconButton size="small" color="primary" title="Preview Rows" onClick={() => { setPreviewBatch({ id: b.id, batch_number: b.batch_number }); setActiveTab('preview'); }}>
                          <ViewIcon fontSize="small" />
                        </IconButton>
                        {b.failed_rows > 0 && (
                          <IconButton size="small" color="warning" title="View Failed Records" onClick={() => { setErrorsBatch({ id: b.id, batch_number: b.batch_number }); setActiveTab('failed'); }}>
                            <ErrorIcon fontSize="small" />
                          </IconButton>
                        )}
                        <IconButton size="small" color="error" title="Delete Batch" onClick={() => { setBatchToDelete(b); setDeleteModalOpen(true); }}>
                          <DeleteIcon fontSize="small" />
                        </IconButton>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      )}

      {activeTab === 'failed' && (
        <FailedRecordsPanel batchId={errorsBatch?.id} batchNumber={errorsBatch?.batch_number} />
      )}

      {activeTab === 'catalog' && (
        <Card variant="outlined" sx={{ p: 3, borderRadius: 3 }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>Database Catalog</Typography>
          <VirtualizedProductGrid endpoint="/api/products/products/" emptyHint="No products in the database yet." />
        </Card>
      )}

      <Dialog open={deleteModalOpen} onClose={() => setDeleteModalOpen(false)} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
        <DialogTitle sx={{ fontWeight: 850, bgcolor: '#ef4444', color: '#fff' }}>Confirm Import Batch Deletion</DialogTitle>
        <DialogContent dividers sx={{ p: 3 }}>
          <Typography variant="subtitle1" fontWeight={800} sx={{ mb: 2 }}>
            Choose deletion strategy for batch '{batchToDelete?.batch_number}':
          </Typography>
          <RadioGroup value={deleteMode} onChange={(e) => setDeleteMode(e.target.value)}>
            <Paper variant="outlined" sx={{ p: 2, mb: 2, borderRadius: 3, border: deleteMode === 'option1' ? '2px solid #ef4444' : '1px solid #cbd5e1' }}>
              <FormControlLabel value="option1" control={<Radio color="error" />} label={<Typography fontWeight={800}>Option 1: Remove Batch Record Only</Typography>} />
              <Typography variant="body2" color="text.secondary" sx={{ pl: 4 }}>
                Deletes the import log and batch audit record, but <strong>retains all imported product records</strong> in the database.
              </Typography>
            </Paper>
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, border: deleteMode === 'option2' ? '2px solid #ef4444' : '1px solid #cbd5e1' }}>
              <FormControlLabel value="option2" control={<Radio color="error" />} label={<Typography fontWeight={800}>Option 2: Delete Batch & Remove All Products</Typography>} />
              <Typography variant="body2" color="text.secondary" sx={{ pl: 4 }}>
                Deletes the import batch AND <strong>permanently removes all associated product records</strong> from the database.
              </Typography>
            </Paper>
          </RadioGroup>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setDeleteModalOpen(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={handleDeleteBatch} sx={{ fontWeight: 800 }}>Execute Deletion</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
