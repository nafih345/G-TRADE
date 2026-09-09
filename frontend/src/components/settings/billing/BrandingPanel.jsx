import React, { useEffect, useState } from 'react';
import {
  Box, Card, Typography, Button, Stack, TextField, Grid, Alert, Avatar,
} from '@mui/material';
import { CloudUpload as UploadIcon, Delete as DeleteIcon, Save as SaveIcon } from '@mui/icons-material';

// Downscale an uploaded image to a data URL small enough to store on the settings row
// and embed in every printed bill.
function fileToDataUrl(file, maxDim = 320) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

export default function BrandingPanel({ settings, onSave, saving }) {
  const [logo, setLogo] = useState('');
  const [primary, setPrimary] = useState('#2563eb');
  const [accent, setAccent] = useState('#0f172a');
  const [info, setInfo] = useState({ tagline: '', website: '', pan: '' });
  const [savedMsg, setSavedMsg] = useState(false);

  useEffect(() => {
    setLogo(settings.logo_data_url || '');
    setPrimary(settings.primary_color || '#2563eb');
    setAccent(settings.accent_color || '#0f172a');
    setInfo({ tagline: '', website: '', pan: '', ...(settings.business_info || {}) });
  }, [settings]);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setLogo(await fileToDataUrl(file));
    } catch {
      /* ignore */
    }
    e.target.value = '';
  };

  const handleSave = async () => {
    await onSave({
      logo_data_url: logo,
      primary_color: primary,
      accent_color: accent,
      business_info: info,
    });
    setSavedMsg(true);
    setTimeout(() => setSavedMsg(false), 3500);
  };

  return (
    <Card sx={{ p: 3, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Box>
          <Typography variant="h6" fontWeight={800}>Logo & Branding</Typography>
          <Typography variant="body2" color="text.secondary">
            The uploaded logo and these details are automatically available to every bill template.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<SaveIcon />} disabled={saving} onClick={handleSave} sx={{ fontWeight: 800 }}>
          {saving ? 'Saving…' : 'Save Branding'}
        </Button>
      </Stack>

      {savedMsg && <Alert severity="success" sx={{ mb: 2, borderRadius: 2 }}>Branding saved.</Alert>}

      <Grid container spacing={3} sx={{ mt: 0.5 }}>
        <Grid item xs={12} sm={4}>
          <Stack spacing={1.5} alignItems="flex-start">
            <Avatar src={logo || undefined} variant="rounded" sx={{ width: 120, height: 120, bgcolor: '#f1f5f9', color: '#94a3b8' }}>
              LOGO
            </Avatar>
            <Button component="label" size="small" variant="outlined" startIcon={<UploadIcon />}>
              {logo ? 'Replace logo' : 'Upload logo'}
              <input hidden type="file" accept="image/*" onChange={handleFile} />
            </Button>
            {logo && (
              <Button size="small" color="error" startIcon={<DeleteIcon />} onClick={() => setLogo('')}>
                Remove logo
              </Button>
            )}
          </Stack>
        </Grid>
        <Grid item xs={12} sm={8}>
          <Grid container spacing={2}>
            <Grid item xs={6}>
              <TextField label="Primary colour" fullWidth size="small" value={primary} onChange={(e) => setPrimary(e.target.value)} />
            </Grid>
            <Grid item xs={6}>
              <TextField label="Accent colour" fullWidth size="small" value={accent} onChange={(e) => setAccent(e.target.value)} />
            </Grid>
            <Grid item xs={12}>
              <TextField label="Tagline" fullWidth size="small" value={info.tagline}
                onChange={(e) => setInfo((i) => ({ ...i, tagline: e.target.value }))} />
            </Grid>
            <Grid item xs={6}>
              <TextField label="Website" fullWidth size="small" value={info.website}
                onChange={(e) => setInfo((i) => ({ ...i, website: e.target.value }))} />
            </Grid>
            <Grid item xs={6}>
              <TextField label="PAN" fullWidth size="small" value={info.pan}
                onChange={(e) => setInfo((i) => ({ ...i, pan: e.target.value }))} />
            </Grid>
          </Grid>
        </Grid>
      </Grid>
    </Card>
  );
}
