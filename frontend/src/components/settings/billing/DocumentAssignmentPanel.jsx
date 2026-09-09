import React, { useEffect, useState } from 'react';
import {
  Box, Card, Typography, Table, TableBody, TableCell, TableHead, TableRow,
  TextField, MenuItem, Button, Stack, FormControlLabel, Switch, Alert,
} from '@mui/material';
import { Save as SaveIcon } from '@mui/icons-material';
import { DOCUMENT_TYPES } from '../../../billing/billingApi';

export default function DocumentAssignmentPanel({ templates, assignments, settings, onSaveAssignments, onSaveSettings, saving }) {
  const activeTemplates = templates.filter((t) => t.is_active);

  const [map, setMap] = useState({});
  const [useSingle, setUseSingle] = useState(false);
  const [singleTpl, setSingleTpl] = useState('');
  const [dirty, setDirty] = useState(false);
  const [savedMsg, setSavedMsg] = useState(false);

  useEffect(() => {
    const m = {};
    DOCUMENT_TYPES.forEach(({ key }) => {
      const a = assignments.find((x) => x.document_type === key);
      m[key] = a?.template || '';
    });
    setMap(m);
    setUseSingle(!!settings.use_single_template);
    setSingleTpl(settings.single_template || '');
    setDirty(false);
  }, [assignments, settings]);

  const handleSave = async () => {
    await onSaveSettings({ use_single_template: useSingle, single_template: singleTpl || null });
    if (!useSingle) {
      await onSaveAssignments(DOCUMENT_TYPES.map(({ key }) => ({ document_type: key, template: map[key] || null })));
    }
    setDirty(false);
    setSavedMsg(true);
    setTimeout(() => setSavedMsg(false), 3500);
  };

  return (
    <Card sx={{ p: 3, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Box>
          <Typography variant="h6" fontWeight={800}>Document Type Assignment</Typography>
          <Typography variant="body2" color="text.secondary">
            Choose which template renders each document. The same template can be reused across types.
          </Typography>
        </Box>
        <Button variant="contained" startIcon={<SaveIcon />} disabled={saving} onClick={handleSave} sx={{ fontWeight: 800 }}>
          {saving ? 'Saving…' : 'Save Assignments'}
        </Button>
      </Stack>

      {savedMsg && <Alert severity="success" sx={{ mb: 2, borderRadius: 2 }}>Assignments saved.</Alert>}

      <FormControlLabel
        sx={{ mb: 1 }}
        control={<Switch checked={useSingle} onChange={(e) => { setUseSingle(e.target.checked); setDirty(true); }} />}
        label={<Typography fontWeight={700}>Use one template for all documents</Typography>}
      />

      {useSingle ? (
        <TextField
          select label="Template for every document" fullWidth sx={{ maxWidth: 420, mt: 1 }}
          value={singleTpl} onChange={(e) => { setSingleTpl(e.target.value); setDirty(true); }}
        >
          {activeTemplates.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
        </TextField>
      ) : (
        <Table size="small" sx={{ mt: 1 }}>
          <TableHead>
            <TableRow>
              <TableCell sx={{ fontWeight: 800 }}>Document Type</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>Template</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {DOCUMENT_TYPES.map(({ key, label }) => (
              <TableRow key={key}>
                <TableCell>{label}</TableCell>
                <TableCell>
                  <TextField
                    select size="small" fullWidth sx={{ maxWidth: 340 }}
                    value={map[key] || ''}
                    onChange={(e) => { setMap((m) => ({ ...m, [key]: e.target.value })); setDirty(true); }}
                  >
                    <MenuItem value=""><em>Use default template</em></MenuItem>
                    {activeTemplates.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
                  </TextField>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
      {dirty && <Typography variant="caption" color="warning.main" sx={{ mt: 1, display: 'block' }}>Unsaved changes</Typography>}
    </Card>
  );
}
