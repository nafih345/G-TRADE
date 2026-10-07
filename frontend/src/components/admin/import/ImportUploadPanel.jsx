import React, { useState } from 'react';
import axios from 'axios';
import { Card, Typography, Button, TextField, MenuItem, Stack, Alert, LinearProgress } from '@mui/material';
import { CloudUpload as UploadIcon } from '@mui/icons-material';

export default function ImportUploadPanel({ onImportStarted }) {
  const [file, setFile] = useState(null);
  const [duplicateStrategy, setDuplicateStrategy] = useState('UPDATE');
  const [uploading, setUploading] = useState(false);
  const [uploadPct, setUploadPct] = useState(0);
  const [error, setError] = useState(null);

  const handleUpload = async () => {
    if (!file) { setError('Please select an Excel or CSV file first.'); return; }
    setUploading(true);
    setUploadPct(0);
    setError(null);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('duplicate_strategy', duplicateStrategy);
    try {
      const res = await axios.post('/api/import/upload/', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
        onUploadProgress: (ev) => { if (ev.total) setUploadPct(Math.round((ev.loaded / ev.total) * 100)); },
      });
      onImportStarted(res.data.batch_id);
      setFile(null);
    } catch (e) {
      const data = e.response?.data;
      setError(
        (data && typeof data === 'object' && data.error) ||
        (e.response ? `Server error (${e.response.status}) while starting the import.` : 'Could not reach the server. Check your connection and try again.')
      );
    } finally {
      setUploading(false);
    }
  };

  return (
    <Card variant="outlined" sx={{ p: 3, borderRadius: 3, mb: 3 }}>
      <Typography variant="h6" fontWeight={800} sx={{ mb: 0.5 }}>Import Products from Excel / CSV</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Supports unlimited rows — the file is streamed and imported in the background in
        chunks, so this page stays responsive no matter how large the file is.
      </Typography>

      {error && <Alert severity="error" sx={{ mb: 2 }} onClose={() => setError(null)}>{error}</Alert>}

      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} alignItems="center">
        <Button component="label" variant="outlined" startIcon={<UploadIcon />} sx={{ textTransform: 'none', fontWeight: 700, whiteSpace: 'nowrap' }}>
          {file ? file.name : 'Choose File (.xlsx, .xls, .csv)'}
          <input type="file" hidden accept=".xlsx,.xls,.csv" onChange={(e) => setFile(e.target.files?.[0] || null)} />
        </Button>

        <TextField
          select size="small" label="On Duplicate" value={duplicateStrategy}
          onChange={(e) => setDuplicateStrategy(e.target.value)}
          sx={{ minWidth: 210 }}
        >
          <MenuItem value="UPDATE">Update Existing Record</MenuItem>
          <MenuItem value="SKIP">Skip Duplicates</MenuItem>
          <MenuItem value="REPLACE">Replace Existing Record</MenuItem>
          <MenuItem value="DUPLICATE">Create Duplicate Record</MenuItem>
        </TextField>

        <Button variant="contained" onClick={handleUpload} disabled={uploading || !file} sx={{ fontWeight: 800, px: 3 }}>
          {uploading ? (uploadPct < 100 ? `Uploading ${uploadPct}%...` : 'Starting Import...') : 'Start Import'}
        </Button>
      </Stack>

      {uploading && (
        <LinearProgress variant="determinate" value={uploadPct} sx={{ mt: 2, height: 6, borderRadius: 3 }} />
      )}
      {file && !uploading && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
          {(file.size / (1024 * 1024)).toFixed(1)} MB selected. Once the upload finishes you can leave this page;
          the import keeps running on the server.
        </Typography>
      )}
    </Card>
  );
}
