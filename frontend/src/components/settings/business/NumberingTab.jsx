import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Grid, IconButton,
  MenuItem, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import { Edit as EditIcon, FormatListNumbered as NumberedIcon } from '@mui/icons-material';
import ConfirmActionDialog from '../../common/ConfirmActionDialog';
import { GREEN, SectionCard, errText, greenButtonSx } from './businessUi';
import { notify } from '../../../utils/notify';
import { apiErrorMessage } from '../../../utils/apiError';

const URL = '/api/company/document-sequences/';
const RESETS = { NEVER: 'Never', MONTHLY: 'Monthly', YEARLY: 'Yearly', FISCAL_YEAR: 'Fiscal year' };
const TOKENS = ['{YYYY}', '{YY}', '{MM}', '{FY}'];

// Mirrors render_affix / format_number in backend apps/company/numbering.py.
function renderAffix(text, when, fyMonth) {
  const fy = when.getMonth() + 1 >= fyMonth ? when.getFullYear() : when.getFullYear() - 1;
  const values = {
    YYYY: String(when.getFullYear()), YY: String(when.getFullYear() % 100).padStart(2, '0'),
    MM: String(when.getMonth() + 1).padStart(2, '0'),
    FY: fyMonth !== 1 ? `${fy}-${String((fy + 1) % 100).padStart(2, '0')}` : String(fy),
  };
  return String(text || '').replace(/\{(YYYY|YY|MM|FY)\}/g, (_, t) => values[t]);
}
export const previewNumber = (cfg, n, fyMonth, when = new Date()) =>
  `${renderAffix(cfg.prefix, when, fyMonth)}${String(n).padStart(Number(cfg.padding) || 1, '0')}${renderAffix(cfg.suffix, when, fyMonth)}`;

function SequenceDialog({ seq, fyMonth, onClose, onSaved }) {
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState(null);
  useEffect(() => {
    if (seq) {
      setForm({ prefix: seq.prefix, suffix: seq.suffix, padding: seq.padding, next_number: seq.next_number,
        start_number: seq.start_number, reset_frequency: seq.reset_frequency, is_active: seq.is_active });
      setErrors({});
    }
  }, [seq]);
  if (!seq || !form) return null;

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const preview = previewNumber(form, Number(form.next_number) || 1, fyMonth);
  const following = previewNumber(form, (Number(form.next_number) || 1) + 1, fyMonth);

  const submit = async (confirmed = false) => {
    const e = {};
    if (!String(form.prefix).trim() && !String(form.suffix).trim()) e.prefix = 'Give the sequence a prefix or suffix.';
    if (!(Number(form.padding) >= 1 && Number(form.padding) <= 10)) e.padding = '1 – 10 digits.';
    if (!(Number(form.next_number) >= 1)) e.next_number = 'Must be 1 or more.';
    if (!(Number(form.start_number) >= 1)) e.start_number = 'Must be 1 or more.';
    if (/\{(?!(?:YYYY|YY|MM|FY)\})/.test(`${form.prefix}${form.suffix}`)) e.prefix = 'Unknown token — use {YYYY}, {YY}, {MM} or {FY}.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const body = { ...form, padding: Number(form.padding), next_number: Number(form.next_number), start_number: Number(form.start_number) };
      if (confirmed) body.confirm = true;
      await axios.put(`${URL}${seq.doc_type}/`, body);
      notify(`${seq.label} numbering updated.`, 'success');
      onSaved();
    } catch (err) {
      const data = err?.response?.data;
      if (err?.response?.status === 409 && data?.requires_confirmation) {
        setConfirm(data.detail);
      } else {
        if (data?.errors) setErrors(data.errors);
        notify(data?.detail || apiErrorMessage(err), 'error');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog open onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
        <DialogTitle sx={{ fontWeight: 800 }}>{seq.label} numbering</DialogTitle>
        <DialogContent dividers>
          <Box sx={{ p: 2, mb: 2, borderRadius: 2, bgcolor: 'action.hover', textAlign: 'center' }}>
            <Typography variant="caption" color="text.secondary">Next number</Typography>
            <Typography variant="h5" fontWeight={800} sx={{ fontFamily: 'monospace', color: GREEN, wordBreak: 'break-all' }}>{preview}</Typography>
            <Typography variant="caption" color="text.secondary">then {following}</Typography>
          </Box>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth label="Prefix" value={form.prefix} onChange={(e) => set('prefix', e.target.value)}
                inputProps={{ maxLength: 30 }} error={!!errors.prefix} helperText={errText(errors.prefix) || 'e.g. INV-{YYYY}-'} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth label="Suffix" value={form.suffix} onChange={(e) => set('suffix', e.target.value)}
                inputProps={{ maxLength: 20 }} error={!!errors.suffix} helperText={errText(errors.suffix) || 'Optional, e.g. /{FY}'} />
            </Grid>
            <Grid item xs={12}>
              <Box sx={{ display: 'flex', gap: 1, flexWrap: 'wrap', alignItems: 'center' }}>
                <Typography variant="caption" color="text.secondary">Insert into prefix:</Typography>
                {TOKENS.map((t) => (
                  <Chip key={t} size="small" label={t} onClick={() => set('prefix', `${form.prefix}${t}`)} variant="outlined" />
                ))}
              </Box>
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField fullWidth type="number" label="Digits" value={form.padding} onChange={(e) => set('padding', e.target.value)}
                inputProps={{ min: 1, max: 10 }} error={!!errors.padding} helperText={errText(errors.padding) || 'Zero-padded width'} />
            </Grid>
            <Grid item xs={6} sm={4}>
              <TextField fullWidth type="number" label="Next Number" value={form.next_number} onChange={(e) => set('next_number', e.target.value)}
                inputProps={{ min: 1 }} error={!!errors.next_number} helperText={errText(errors.next_number) || 'For the current period'} />
            </Grid>
            <Grid item xs={12} sm={4}>
              <TextField fullWidth type="number" label="Start Each Period At" value={form.start_number} onChange={(e) => set('start_number', e.target.value)}
                inputProps={{ min: 1 }} error={!!errors.start_number} helperText={errText(errors.start_number) || 'After a reset'} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Reset Numbering" value={form.reset_frequency} onChange={(e) => set('reset_frequency', e.target.value)}
                error={!!errors.reset_frequency} helperText={errText(errors.reset_frequency) || 'When the counter starts again'}>
                {Object.entries(RESETS).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <FormControlLabel control={<Switch checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />}
                label={form.is_active ? 'Active' : 'Inactive — the module keeps its own numbers'} />
            </Grid>
          </Grid>
          {!seq.wired && (
            <Alert severity="info" sx={{ mt: 2, borderRadius: 2 }}>
              Saved for later: this document type doesn't take its numbers from here yet.
            </Alert>
          )}
        </DialogContent>
        <DialogActions sx={{ px: 3, py: 2 }}>
          <Button onClick={onClose} disabled={saving}>Cancel</Button>
          <Button variant="contained" onClick={() => submit(false)} disabled={saving} sx={greenButtonSx}>{saving ? 'Saving…' : 'Save Sequence'}</Button>
        </DialogActions>
      </Dialog>
      <ConfirmActionDialog open={!!confirm} type="warning" title="Change a sequence in use?"
        message={confirm || ''} confirmText="Apply change" cancelText="Go back"
        onConfirm={() => { setConfirm(null); submit(true); }} onClose={() => setConfirm(null)} />
    </>
  );
}

export default function NumberingTab({ prefs, onNavigate }) {
  const [rows, setRows] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null);

  const load = useCallback(() => {
    axios.get(URL).then((r) => { setRows(r.data); setLoadError(''); })
      .catch((e) => setLoadError(`Could not load numbering sequences. ${apiErrorMessage(e)}`));
  }, []);
  useEffect(() => { load(); }, [load]);

  const sorted = useMemo(() => (rows ? [...rows].sort((a, b) => Number(b.wired) - Number(a.wired)) : null), [rows]);

  return (
    <SectionCard id="numbering" icon={<NumberedIcon />} title="Numbering Sequences"
      subtitle="Prefixes, starting numbers and formats for document numbers. Each change saves immediately.">
      {!prefs.auto_generate_numbers && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}
          action={<Button color="inherit" size="small" onClick={() => onNavigate('general')}>Open General</Button>}>
          Auto-generate Document Numbers is off — screens keep their own numbers until you switch it on.
        </Alert>
      )}
      {loadError && <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{loadError}</Alert>}
      {!loadError && rows === null && <Typography variant="body2" color="text.secondary">Loading sequences…</Typography>}
      {sorted && (
        <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Table size="small" sx={{ minWidth: 760 }}>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, bgcolor: 'action.hover' } }}>
                <TableCell>Document Type</TableCell>
                <TableCell>Next Number</TableCell>
                <TableCell>Format</TableCell>
                <TableCell>Reset</TableCell>
                <TableCell>Used By</TableCell>
                <TableCell align="right">Edit</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {sorted.map((s) => (
                <TableRow key={s.doc_type} hover sx={{ opacity: s.is_active ? 1 : 0.6 }}>
                  <TableCell>
                    <Typography variant="body2" fontWeight={700}>{s.label}</Typography>
                    {!s.is_active && <Chip size="small" label="Inactive" sx={{ mt: 0.5 }} />}
                  </TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{s.preview}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', color: 'text.secondary' }}>
                    {s.prefix}{'#'.repeat(s.padding)}{s.suffix}
                  </TableCell>
                  <TableCell>{RESETS[s.reset_frequency]}</TableCell>
                  <TableCell>
                    {s.wired
                      ? <Typography variant="caption">{s.applied_in}</Typography>
                      : <Chip size="small" variant="outlined" label="Not linked yet" />}
                  </TableCell>
                  <TableCell align="right">
                    <Tooltip title="Edit sequence">
                      <IconButton size="small" onClick={() => setEditing(s)} aria-label={`Edit ${s.label} sequence`}><EditIcon fontSize="small" /></IconButton>
                    </Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
        Tokens: {'{YYYY}'} year, {'{YY}'} short year, {'{MM}'} month, {'{FY}'} fiscal year. Numbers already used are skipped, so two documents never share one.
      </Typography>
      <SequenceDialog seq={editing} fyMonth={prefs.fiscal_year_start_month || 4} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }} />
    </SectionCard>
  );
}
