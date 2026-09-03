import React, { useState, useEffect } from 'react';
import axios from 'axios';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Grid, TextField,
  MenuItem, Button, Stack, Typography, FormControlLabel, Switch, Chip
} from '@mui/material';
import { Build as ServiceIcon } from '@mui/icons-material';

const TAX_OPTIONS = ['0', '5', '12', '18', '28'];

const blankService = () => ({
  id: null,
  service_code: '',
  name: '',
  description: '',
  default_price: '',
  tax_percentage: '18',
  is_active: true,
});

// Reusable "Service Master" dialog — the same Add / Edit Service form used on
// Administration → Service Master, surfaced inline on the New Sale page so the
// front desk can register a service without leaving the bill. Saves to
// /api/sales/services/ and reports the saved service back via onSaved(), shaped
// exactly like the `services` list NewSaleWizard already consumes.
export default function ServiceMasterDialog({ open, onClose, service = null, onSaved }) {
  const [s, setS] = useState(blankService());
  const [saving, setSaving] = useState(false);
  const isEdit = !!s.id;

  const set = (patch) => setS(prev => ({ ...prev, ...patch }));

  useEffect(() => {
    if (!open) return;
    if (service) {
      setS({
        id: service.id,
        service_code: service.code && service.code !== '—' ? service.code : '',
        name: service.name && service.name !== '—' ? service.name : '',
        description: service.description || '',
        default_price: service.price ?? service.defaultPrice ?? '',
        tax_percentage: String(service.taxRate ?? service.taxPercentage ?? '18'),
        is_active: service.isActive !== false,
      });
    } else {
      setS(blankService());
    }
  }, [open, service]);

  const handleSave = async () => {
    if (!s.name.trim()) {
      alert('Please enter the Service Name.');
      return;
    }
    setSaving(true);

    const payload = {
      name: s.name.trim(),
      description: s.description || '',
      default_price: parseFloat(s.default_price) || 0,
      tax_percentage: parseFloat(s.tax_percentage) || 0,
      is_active: !!s.is_active,
    };
    if (s.service_code.trim()) payload.service_code = s.service_code.trim();

    let saved = null;
    try {
      const res = s.id
        ? await axios.put(`/api/sales/services/${s.id}/`, payload)
        : await axios.post('/api/sales/services/', payload);
      saved = res.data;
    } catch (err) {
      setSaving(false);
      alert(`Could not save service: ${err?.response?.data?.detail || err.message}`);
      return;
    }

    setSaving(false);

    const record = {
      id: String(saved.id),
      code: saved.service_code || '',
      name: saved.name || payload.name,
      description: saved.description || '',
      price: parseFloat(saved.default_price || 0),
      taxRate: parseFloat(saved.tax_percentage || 0),
      isActive: saved.is_active !== false,
    };
    onSaved?.(record);
    onClose?.();
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 4 } }}>
      <DialogTitle sx={{ fontWeight: 850, bgcolor: '#0f172a', color: '#fff', display: 'flex', alignItems: 'center', gap: 1 }}>
        <ServiceIcon sx={{ color: '#a78bfa' }} /> {isEdit ? 'Edit Service' : 'Add New Service'}
        {isEdit && <Chip size="small" label={s.service_code || '—'} sx={{ ml: 'auto', bgcolor: '#7c3aed', color: '#fff', fontWeight: 800 }} />}
      </DialogTitle>
      <DialogContent dividers sx={{ p: 3 }}>
        <Grid container spacing={2.5}>
          <Grid item xs={12} sm={5}>
            <TextField
              fullWidth size="small" label="Service Code"
              value={s.service_code}
              onChange={(e) => set({ service_code: e.target.value })}
              placeholder="Auto (SRV006)"
              helperText="Leave blank to auto-generate"
            />
          </Grid>
          <Grid item xs={12} sm={7}>
            <TextField
              fullWidth size="small" label="Service Name *"
              value={s.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder="e.g. Frame Repair"
              inputProps={{ style: { fontWeight: 700 } }}
            />
          </Grid>
          <Grid item xs={12}>
            <TextField
              fullWidth size="small" label="Description" multiline rows={2}
              value={s.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="Short description of what this service covers"
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth size="small" label="Default Price (₹)" type="number"
              value={s.default_price}
              onChange={(e) => set({ default_price: e.target.value })}
              placeholder="0.00"
              helperText="0 for custom-priced"
              inputProps={{ style: { fontWeight: 800 } }}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              select fullWidth size="small" label="Tax Percentage"
              value={s.tax_percentage}
              onChange={(e) => set({ tax_percentage: e.target.value })}
            >
              {TAX_OPTIONS.map(t => <MenuItem key={t} value={t}>{t}%</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={4}>
            <FormControlLabel
              control={<Switch checked={!!s.is_active} onChange={(e) => set({ is_active: e.target.checked })} color="success" />}
              label={<Typography variant="body2" fontWeight={700}>{s.is_active ? 'ON' : 'OFF'}</Typography>}
            />
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: -0.5 }}>
              {s.is_active ? 'Shown in New Sale → Services' : 'Hidden from New Sale'}
            </Typography>
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions sx={{ p: 2.5, justifyContent: 'space-between' }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button
          variant="contained" onClick={handleSave} disabled={saving}
          sx={{ bgcolor: '#7c3aed', '&:hover': { bgcolor: '#6d28d9' }, fontWeight: 800, px: 4 }}
        >
          {saving ? 'Saving…' : (isEdit ? 'Save Changes' : 'Save Service')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
