// Small dialogs used by the label designer: name prompt (save as / rename / duplicate),
// new-template picker (starter presets or blank), version history and deleted templates.
import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, List, ListItemButton,
  ListItemText, Typography, CircularProgress, Alert, Stack, Chip,
} from '@mui/material';
import { fetchPresets, fetchVersions, fetchDeletedTemplates, apiError } from '../../../labels/labelApi';

export function NamePrompt({ open, title, initial = '', confirmLabel = 'Save', onClose, onConfirm }) {
  const [name, setName] = useState(initial);
  useEffect(() => { if (open) setName(initial); }, [open, initial]);
  const ok = name.trim().length > 0;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>{title}</DialogTitle>
      <DialogContent>
        <TextField autoFocus fullWidth size="small" label="Template name" value={name} sx={{ mt: 1 }}
          inputProps={{ maxLength: 120 }}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && ok) { e.preventDefault(); e.stopPropagation(); onConfirm(name.trim()); } }}
        />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!ok} onClick={() => onConfirm(name.trim())}>{confirmLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}

export function NewTemplateDialog({ open, onClose, onPreset, onBlank }) {
  const [presets, setPresets] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    fetchPresets().then(setPresets).catch((e) => setError(apiError(e)));
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>New label template</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error">{error}</Alert>}
        {!presets && !error && <CircularProgress size={22} />}
        <List dense>
          {(presets || []).map((p) => (
            <ListItemButton key={p.preset_key} onClick={() => onPreset(p)}>
              <ListItemText
                primary={<Stack direction="row" spacing={1} alignItems="center"><span>{p.name}</span><Chip size="small" label={p.printer_type === 'a4' ? 'A4' : 'Thermal'} /></Stack>}
                secondary={p.description}
              />
            </ListItemButton>
          ))}
          <ListItemButton onClick={() => onBlank('thermal')}><ListItemText primary="Blank thermal label" secondary="Start from an empty 38 × 25 mm label." /></ListItemButton>
          <ListItemButton onClick={() => onBlank('a4')}><ListItemText primary="Blank A4 sheet label" secondary="Start from an empty 63.5 × 33.9 mm, 24-per-sheet label." /></ListItemButton>
        </List>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button></DialogActions>
    </Dialog>
  );
}

export function VersionsDialog({ open, template, onClose, onRestore }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open || !template?.id) return;
    setRows(null);
    fetchVersions(template.id).then(setRows).catch((e) => setError(apiError(e)));
  }, [open, template?.id]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>Version history — {template?.name}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Current version: <b>v{template?.version}</b>. Every save keeps the previous design here; restoring saves a new version, so nothing is lost.
        </Typography>
        {error && <Alert severity="error">{error}</Alert>}
        {!rows && !error && <CircularProgress size={22} />}
        {rows && rows.length === 0 && <Typography variant="body2">No earlier versions yet.</Typography>}
        <List dense>
          {(rows || []).map((v) => (
            <ListItemButton key={v.version} onClick={() => onRestore(v.version)}>
              <ListItemText
                primary={`v${v.version} · ${v.name} · ${Number(v.width_mm)} × ${Number(v.height_mm)} mm · ${v.element_count} elements`}
                secondary={`${new Date(v.saved_at).toLocaleString()}${v.saved_by ? ` · replaced by ${v.saved_by}` : ''} — click to restore`}
              />
            </ListItemButton>
          ))}
        </List>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

export function DeletedDialog({ open, onClose, onRestore }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!open) return;
    setRows(null);
    fetchDeletedTemplates().then(setRows).catch((e) => setError(apiError(e)));
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>Deleted templates</DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error">{error}</Alert>}
        {!rows && !error && <CircularProgress size={22} />}
        {rows && rows.length === 0 && <Typography variant="body2">Nothing deleted.</Typography>}
        <List dense>
          {(rows || []).map((t) => (
            <ListItemButton key={t.id} onClick={() => onRestore(t)}>
              <ListItemText primary={`${t.name} (${t.width_mm} × ${t.height_mm} mm)`} secondary={`Deleted ${new Date(t.updated_at).toLocaleString()} — click to restore`} />
            </ListItemButton>
          ))}
        </List>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}
