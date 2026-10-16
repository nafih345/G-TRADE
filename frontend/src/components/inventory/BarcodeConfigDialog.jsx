import React, { useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, MenuItem,
  Stack, Typography, Alert, Box, Chip, CircularProgress, Grid
} from '@mui/material';
import { useDebounce } from '../../hooks/useDebounce';
import { notify } from '../../utils/notify';

export const BARCODE_CONFIG_URL = '/api/products/barcode-config/';

const TOKENS = ['{YY}', '{YYYY}', '{MM}', '{DD}'];

// Short human description of a saved series, e.g. "20 + 10-digit number + check digit".
export function describeSeries(cfg) {
  const pv = cfg?.preview;
  if (!pv || pv.error) return '';
  const parts = [];
  if (cfg.prefix_pattern) parts.push(cfg.prefix_pattern);
  parts.push(`${pv.sequence_digits}-digit number`);
  if (cfg.check_digit === 'MOD10') parts.push('check digit');
  return `${cfg.total_length} characters: ${parts.join(' + ')}`;
}

// Editor for the shared product barcode series (BarcodeSeriesConfig): prefix
// pattern, total digits, check digit and the next running number. Every
// "Generate Barcode" (Product Master, Manage Barcode, bulk generate, variants,
// label printing, Excel import) mints from this one series.
export default function BarcodeConfigDialog({ open, onClose, onSaved }) {
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [checking, setChecking] = useState(false);
  const prefixRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    setError('');
    axios.get(BARCODE_CONFIG_URL)
      .then((res) => {
        setSaved(res.data);
        setPreview(res.data.preview);
        setForm({
          prefix_pattern: res.data.prefix_pattern,
          total_length: String(res.data.total_length),
          check_digit: res.data.check_digit,
          next_number: String(res.data.next_number)
        });
      })
      .catch(() => setError('Could not load the barcode settings.'));
  }, [open]);

  const nextChanged = form && saved && form.next_number !== String(saved.next_number);
  const payload = form && {
    prefix_pattern: form.prefix_pattern,
    total_length: Number(form.total_length),
    check_digit: form.check_digit,
    ...(nextChanged ? { next_number: Number(form.next_number) } : {})
  };
  const debouncedPayload = useDebounce(payload ? JSON.stringify(payload) : '', 300);

  // Live preview via a server dry run — the same code path that mints real barcodes.
  useEffect(() => {
    if (!open || !debouncedPayload) return undefined;
    let cancelled = false;
    setChecking(true);
    axios.put(BARCODE_CONFIG_URL, { ...JSON.parse(debouncedPayload), dry_run: true })
      .then((res) => { if (!cancelled) { setPreview(res.data.preview); setError(''); } })
      .catch((e) => {
        if (cancelled) return;
        const d = e?.response?.data;
        setPreview(null);
        setError((Array.isArray(d?.detail) ? d.detail[0] : d?.detail) || Object.values(d || {})[0]?.[0] || 'Invalid barcode settings.');
      })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [open, debouncedPayload]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));

  const insertToken = (tok) => {
    const el = prefixRef.current;
    const value = form.prefix_pattern || '';
    const start = el ? el.selectionStart ?? value.length : value.length;
    const end = el ? el.selectionEnd ?? value.length : value.length;
    set({ prefix_pattern: value.slice(0, start) + tok + value.slice(end) });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await axios.put(BARCODE_CONFIG_URL, payload);
      notify('Barcode settings saved.', 'success');
      onSaved && onSaved(res.data);
      onClose();
    } catch (e) {
      const d = e?.response?.data;
      setError((Array.isArray(d?.detail) ? d.detail[0] : d?.detail) || 'Could not save the barcode settings.');
    } finally {
      setSaving(false);
    }
  };

  const nextLower = nextChanged && saved && Number(form.next_number) < saved.next_number;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 3.5 } }}>
      <DialogTitle sx={{ fontWeight: 800 }}>
        Barcode Settings
        <Typography variant="body2" color="text.secondary" fontWeight={500}>
          How new product barcodes are numbered. Existing barcodes are not changed.
        </Typography>
      </DialogTitle>
      <DialogContent dividers>
        {!form ? (
          error ? <Alert severity="error">{error}</Alert> : <Box sx={{ py: 4, textAlign: 'center' }}><CircularProgress size={24} /></Box>
        ) : (
          <Stack spacing={2}>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth size="small" label="Prefix / series pattern"
                  value={form.prefix_pattern}
                  onChange={(e) => set({ prefix_pattern: e.target.value.toUpperCase() })}
                  inputRef={prefixRef}
                  helperText="Fixed start of every code. Leave empty for none."
                  inputProps={{ maxLength: 40, style: { fontFamily: 'monospace', fontWeight: 700 } }}
                  autoFocus
                />
                <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', rowGap: 0.5 }}>
                  {TOKENS.map((tok) => (
                    <Chip key={tok} size="small" variant="outlined" label={tok} onClick={() => insertToken(tok)} sx={{ fontFamily: 'monospace' }} />
                  ))}
                </Stack>
                <Typography variant="caption" color="text.secondary">
                  Date tokens insert today's year / month / day when a code is generated.
                </Typography>
              </Grid>
              <Grid item xs={6} sm={3}>
                <TextField
                  fullWidth size="small" type="number" label="Total digits"
                  value={form.total_length}
                  onChange={(e) => set({ total_length: e.target.value })}
                  inputProps={{ min: 6, max: 24 }}
                  helperText="6 – 24, incl. prefix"
                />
              </Grid>
              <Grid item xs={6} sm={3}>
                <TextField
                  select fullWidth size="small" label="Check digit"
                  value={form.check_digit}
                  onChange={(e) => set({ check_digit: e.target.value })}
                  helperText={form.check_digit === 'MOD10' ? 'Numeric prefix only' : ' '}
                >
                  <MenuItem value="MOD10">Mod-10 (EAN/UPC)</MenuItem>
                  <MenuItem value="NONE">None</MenuItem>
                </TextField>
              </Grid>
              <Grid item xs={12} sm={6}>
                <TextField
                  fullWidth size="small" type="number" label="Next running number"
                  value={form.next_number}
                  onChange={(e) => set({ next_number: e.target.value })}
                  inputProps={{ min: 1 }}
                  helperText={nextChanged ? `Was ${saved.next_number}` : 'The series continues from here'}
                />
              </Grid>
            </Grid>

            {nextLower && (
              <Alert severity="warning">
                Moving the number back re-enters a used range. Numbers already held by a product are skipped automatically.
              </Alert>
            )}
            {error && <Alert severity="error">{error}</Alert>}

            {preview && !error && (
              <Box sx={{ border: '1px dashed #94a3b8', borderRadius: 2, p: 2, bgcolor: '#f8fafc' }}>
                <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
                  <Typography variant="subtitle2" fontWeight={800}>Next barcodes</Typography>
                  {checking && <CircularProgress size={14} />}
                </Stack>
                <Stack spacing={0.25}>
                  {preview.samples.map((code) => (
                    <Typography key={code} sx={{ fontFamily: 'monospace', fontWeight: 700, letterSpacing: 1 }}>
                      <Box component="span" sx={{ color: 'primary.main' }}>{code.slice(0, preview.resolved_prefix.length)}</Box>
                      {form.check_digit === 'MOD10'
                        ? <>{code.slice(preview.resolved_prefix.length, -1)}<Box component="span" sx={{ color: 'success.main' }}>{code.slice(-1)}</Box></>
                        : code.slice(preview.resolved_prefix.length)}
                    </Typography>
                  ))}
                </Stack>
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                  <Box component="span" sx={{ color: 'primary.main', fontWeight: 700 }}>Prefix</Box>
                  {` ${preview.resolved_prefix.length || 0} + running number ${preview.sequence_digits}`}
                  {form.check_digit === 'MOD10' && <> + <Box component="span" sx={{ color: 'success.main', fontWeight: 700 }}>check</Box> 1</>}
                  {` · ${Number(preview.remaining).toLocaleString()} codes left in this series`}
                </Typography>
                {!preview.numeric && (
                  <Typography variant="caption" color="warning.main" sx={{ display: 'block' }}>
                    Letters in the prefix: labels must use Code 128 / Code 39 (not EAN / UPC).
                  </Typography>
                )}
                {preview.numeric && Number(form.total_length) !== 13 && (
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                    Not 13 digits: print labels with Code 128 rather than EAN-13.
                  </Typography>
                )}
              </Box>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={handleSave} disabled={!form || saving || Boolean(error) || checking}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
