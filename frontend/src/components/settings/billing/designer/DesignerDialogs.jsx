// Dialogs shared by the bill designer and the templates dashboard.
import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, TextField, Typography, Stack, Box, Chip,
  List, ListItemButton, ListItemText, CircularProgress, FormControlLabel, Checkbox, Alert, Card, CardActionArea,
  Grid, MenuItem,
} from '@mui/material';
import {
  fetchTemplateVersions, fetchDeletedTemplates, fetchPresets,
} from '../../../../billing/billingApi';
import {
  DOC_TYPE_LABELS, ALL_DOC_TYPES, incompatibilityReason,
} from '../../../../billing/billFields';
import { PAPER_SIZES } from '../../../../billing/billLayout';

export function NamePrompt({ open, title, initial = '', confirmLabel = 'Save', onClose, onConfirm }) {
  const [name, setName] = useState(initial);
  useEffect(() => { if (open) setName(initial); }, [open, initial]);
  const submit = () => { if (name.trim()) onConfirm(name.trim()); };
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        <TextField autoFocus fullWidth size="small" label="Template name" value={name} sx={{ mt: 1 }}
          onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
          inputProps={{ maxLength: 120, 'data-testid': 'name-input' }} />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={!name.trim()} onClick={submit} data-testid="name-confirm">{confirmLabel}</Button>
      </DialogActions>
    </Dialog>
  );
}

export function VersionsDialog({ open, template, onClose, onRestore }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!open || !template?.id) return;
    setRows(null);
    fetchTemplateVersions(template.id).then(setRows).catch(() => setRows([]));
  }, [open, template?.id]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Version history — {template?.name}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Current: version {template?.version}. Each save keeps the previous design here (last 30). Restoring keeps the current design as a version too.
        </Typography>
        {rows === null ? <CircularProgress size={20} /> : !rows.length ? <Typography variant="body2">No earlier versions yet.</Typography> : (
          <List dense>
            {rows.map((v) => (
              <ListItemButton key={v.version} onClick={() => onRestore(v.version)}>
                <ListItemText
                  primary={`Version ${v.version} — ${v.name}`}
                  secondary={`${new Date(v.saved_at).toLocaleString()} · ${v.paper_size} ${v.orientation}${v.saved_by ? ` · by ${v.saved_by}` : ''}${v.schema === 1 ? ' · classic layout' : ''}`}
                />
                <Chip size="small" label="Restore" />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

export function DeletedDialog({ open, onClose, onRestore }) {
  const [rows, setRows] = useState(null);
  useEffect(() => {
    if (!open) return;
    setRows(null);
    fetchDeletedTemplates().then(setRows).catch(() => setRows([]));
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Deleted templates</DialogTitle>
      <DialogContent dividers>
        {rows === null ? <CircularProgress size={20} /> : !rows.length ? <Typography variant="body2">Nothing has been deleted.</Typography> : (
          <List dense>
            {rows.map((t) => (
              <ListItemButton key={t.id} onClick={() => onRestore(t)}>
                <ListItemText primary={t.name} secondary={`${t.paper_size} · deleted ${new Date(t.updated_at).toLocaleDateString()}`} />
                <Chip size="small" label="Restore" />
              </ListItemButton>
            ))}
          </List>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

/** Create a template: from a starter layout, or blank on a chosen paper size. */
export function NewTemplateDialog({ open, onClose, onPreset, onBlank }) {
  const [presets, setPresets] = useState(null);
  const [paper, setPaper] = useState('A4');
  useEffect(() => {
    if (!open) return;
    setPresets(null);
    fetchPresets().then(setPresets).catch(() => setPresets([]));
  }, [open]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle>Create template</DialogTitle>
      <DialogContent dividers>
        <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1 }}>Start from a starter layout</Typography>
        {presets === null ? <CircularProgress size={20} /> : !presets.length ? (
          <Alert severity="warning">Starter layouts could not be loaded — the server is unreachable.</Alert>
        ) : (
          <Grid container spacing={1.25}>
            {presets.map((p) => (
              <Grid item xs={12} sm={6} md={4} key={p.preset_key}>
                <Card variant="outlined" sx={{ height: '100%' }}>
                  <CardActionArea sx={{ p: 1.25, height: '100%', alignItems: 'flex-start' }} onClick={() => onPreset(p)} data-testid={`preset-${p.preset_key}`}>
                    <Typography variant="body2" fontWeight={800}>{p.name}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{p.description}</Typography>
                    <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mt: 0.75 }}>
                      <Chip size="small" label={`${p.paper_size}${p.orientation === 'landscape' ? ' landscape' : ''}`} />
                      {(p.recommended_for || []).map((d) => <Chip key={d} size="small" color="primary" variant="outlined" label={DOC_TYPE_LABELS[d]} />)}
                    </Stack>
                  </CardActionArea>
                </Card>
              </Grid>
            ))}
          </Grid>
        )}
        <Typography variant="subtitle2" fontWeight={800} sx={{ mt: 2.5, mb: 1 }}>Or start blank</Typography>
        <Stack direction="row" spacing={1} alignItems="center">
          <TextField select size="small" label="Paper" value={paper} onChange={(e) => setPaper(e.target.value)} sx={{ minWidth: 220 }}>
            {PAPER_SIZES.filter((p) => p.value !== 'CUSTOM').map((p) => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
          </TextField>
          <Button variant="outlined" onClick={() => onBlank(paper)} data-testid="new-blank">Blank layout</Button>
        </Stack>
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Cancel</Button></DialogActions>
    </Dialog>
  );
}

export function RestoreDefaultsDialog({ open, onClose, onConfirm }) {
  const [resetModified, setResetModified] = useState(false);
  const [reassign, setReassign] = useState(false);
  useEffect(() => { if (open) { setResetModified(false); setReassign(false); } }, [open]);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Restore default templates</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" sx={{ mb: 1 }}>Starter templates you deleted are recreated. Your own templates are never touched.</Typography>
        <FormControlLabel control={<Checkbox checked={resetModified} onChange={(e) => setResetModified(e.target.checked)} />}
          label="Also reset starter templates I have edited (their current design stays in Version history)" />
        <FormControlLabel control={<Checkbox checked={reassign} onChange={(e) => setReassign(e.target.checked)} />}
          label="Point every document type back at its recommended starter template" />
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => onConfirm({ resetModified, reassign })} data-testid="restore-defaults-confirm">Restore</Button>
      </DialogActions>
    </Dialog>
  );
}

/** Choose the document types a template prints. Incompatible types are disabled with the reason. */
export function AssignDialog({ open, template, onClose, onConfirm }) {
  const [sel, setSel] = useState([]);
  useEffect(() => { if (open && template) setSel(template.used_by || []); }, [open, template]);
  if (!template) return null;
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>Assign “{template.name}” to documents</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          Ticked documents print with this template. Unticking a document returns it to the default template.
        </Typography>
        {ALL_DOC_TYPES.map((dt) => {
          const reason = incompatibilityReason(template.config, dt);
          return (
            <Box key={dt}>
              <FormControlLabel
                disabled={!!reason}
                control={<Checkbox checked={sel.includes(dt)} onChange={(e) => setSel((s) => (e.target.checked ? [...s, dt] : s.filter((x) => x !== dt)))} data-testid={`assign-${dt}`} />}
                label={DOC_TYPE_LABELS[dt]}
              />
              {reason && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', ml: 4, mt: -0.75, mb: 0.5 }}>Can’t print: {reason}.</Typography>}
            </Box>
          );
        })}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" onClick={() => onConfirm(sel)} data-testid="assign-confirm">Save assignment</Button>
      </DialogActions>
    </Dialog>
  );
}
