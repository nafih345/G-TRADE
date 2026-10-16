import React, { useEffect, useState } from 'react';
import {
  Box, Card, Typography, Table, TableBody, TableCell, TableHead, TableRow, TextField, MenuItem, Button, Stack,
  FormControlLabel, Switch, Alert, Chip, ListSubheader,
} from '@mui/material';
import { Save as SaveIcon, AutoFixHigh } from '@mui/icons-material';
import { DOCUMENT_TYPES, apiError } from '../../../billing/billingApi';
import { incompatibilityReason, canonicalDocType } from '../../../billing/billFields';

// Document type -> template. Only templates that can print a document type are offered for
// it (incompatible ones are listed disabled with the reason), and the backend re-checks.
export default function DocumentAssignmentPanel({
  templates, assignments, settings, onSaveAssignments, onSaveSettings, onUseRecommended, saving, canDesign = true,
}) {
  const active = templates.filter((t) => t.is_active);
  const [map, setMap] = useState({});
  const [useSingle, setUseSingle] = useState(false);
  const [singleTpl, setSingleTpl] = useState('');
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState(null);

  useEffect(() => {
    const m = {};
    DOCUMENT_TYPES.forEach(({ key }) => {
      const a = assignments.find((x) => canonicalDocType(x.document_type) === key);
      m[key] = a?.template || '';
    });
    setMap(m);
    setUseSingle(!!settings.use_single_template);
    setSingleTpl(settings.single_template || '');
    setDirty(false);
  }, [assignments, settings]);

  const defaultTpl = templates.find((t) => t.is_default);
  const singleObj = templates.find((t) => t.id === singleTpl);

  const handleSave = async () => {
    setMsg(null);
    try {
      await onSaveSettings({ use_single_template: useSingle, single_template: singleTpl || null });
      await onSaveAssignments(DOCUMENT_TYPES.map(({ key }) => ({ document_type: key, template: map[key] || null })));
      setDirty(false);
      setMsg({ severity: 'success', text: 'Assignments saved.' });
    } catch (e) {
      setMsg({ severity: 'error', text: apiError(e, 'Could not save assignments.') });
    }
  };

  const options = (docType) => {
    const ok = active.filter((t) => !incompatibilityReason(t.config, docType));
    const bad = active.filter((t) => incompatibilityReason(t.config, docType));
    return [
      <MenuItem key="" value=""><em>Default template{defaultTpl && !incompatibilityReason(defaultTpl.config, docType) ? ` (${defaultTpl.name})` : ' (first compatible)'}</em></MenuItem>,
      ...ok.map((t) => <MenuItem key={t.id} value={t.id}>{t.name} <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>{t.paper_size}{t.config?.schema === 2 ? '' : ' · classic'}</Typography></MenuItem>),
      bad.length ? <ListSubheader key="bad">Can’t print this document</ListSubheader> : null,
      ...bad.map((t) => <MenuItem key={t.id} value={t.id} disabled title={incompatibilityReason(t.config, docType)}>{t.name} — {incompatibilityReason(t.config, docType)}</MenuItem>),
    ].filter(Boolean);
  };

  return (
    <Card sx={{ p: 3, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
      <Stack direction={{ xs: 'column', md: 'row' }} justifyContent="space-between" alignItems={{ md: 'center' }} spacing={1} sx={{ mb: 1 }}>
        <Box>
          <Typography variant="h6" fontWeight={800}>Document Type Assignment</Typography>
          <Typography variant="body2" color="text.secondary">
            Choose which template prints each document. One template can serve several document types when its fields fit them.
          </Typography>
        </Box>
        <Stack direction="row" spacing={1}>
          <Button startIcon={<AutoFixHigh />} disabled={!canDesign || saving} onClick={() => window.confirm('Point every document type at its recommended starter template?') && onUseRecommended()}>Use recommended</Button>
          <Button variant="contained" startIcon={<SaveIcon />} disabled={!canDesign || saving || !dirty} onClick={handleSave} sx={{ fontWeight: 800 }} data-testid="save-assignments">
            {saving ? 'Saving…' : 'Save Assignments'}
          </Button>
        </Stack>
      </Stack>
      {msg && <Alert severity={msg.severity} sx={{ mb: 2, borderRadius: 2 }} onClose={() => setMsg(null)}>{msg.text}</Alert>}

      <FormControlLabel
        sx={{ mb: 1 }}
        control={<Switch checked={useSingle} disabled={!canDesign} onChange={(e) => { setUseSingle(e.target.checked); setDirty(true); }} />}
        label={<Typography fontWeight={700}>Use one template for every document it can print</Typography>}
      />
      {useSingle && (
        <Box sx={{ mb: 2 }}>
          <TextField select label="Template" fullWidth sx={{ maxWidth: 420, mt: 1 }} value={singleTpl} disabled={!canDesign}
            onChange={(e) => { setSingleTpl(e.target.value); setDirty(true); }}>
            {active.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
          </TextField>
          {singleObj && (
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
              Documents it can’t print ({DOCUMENT_TYPES.filter((d) => incompatibilityReason(singleObj.config, d.key)).map((d) => d.label).join(', ') || 'none'}) keep their own assignment below.
            </Typography>
          )}
        </Box>
      )}

      <Table size="small" sx={{ mt: 1 }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ fontWeight: 800 }}>Document Type</TableCell>
            <TableCell sx={{ fontWeight: 800 }}>Template</TableCell>
            <TableCell sx={{ fontWeight: 800 }}>Prints with</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {DOCUMENT_TYPES.map(({ key, label }) => {
            const chosen = templates.find((t) => t.id === map[key]);
            let effective = chosen;
            let via = 'assigned';
            if (useSingle && singleObj && !incompatibilityReason(singleObj.config, key)) { effective = singleObj; via = 'single'; }
            if (!effective) { effective = (defaultTpl && !incompatibilityReason(defaultTpl.config, key) ? defaultTpl : active.find((t) => !incompatibilityReason(t.config, key))); via = 'default'; }
            return (
              <TableRow key={key} data-testid={`assign-row-${key}`}>
                <TableCell sx={{ fontWeight: 600 }}>{label}</TableCell>
                <TableCell>
                  <TextField select size="small" fullWidth sx={{ maxWidth: 360 }} value={map[key] || ''} disabled={!canDesign}
                    onChange={(e) => { setMap((m) => ({ ...m, [key]: e.target.value })); setDirty(true); }}
                    inputProps={{ 'data-testid': `assign-select-${key}` }}>
                    {options(key)}
                  </TextField>
                </TableCell>
                <TableCell>
                  {effective
                    ? <Chip size="small" color={via === 'assigned' ? 'success' : 'default'} variant={via === 'assigned' ? 'filled' : 'outlined'} label={`${effective.name}${via === 'single' ? ' (one template)' : via === 'default' ? ' (default)' : ''}`} />
                    : <Chip size="small" color="warning" label="Built-in layout" />}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      {dirty && <Typography variant="caption" color="warning.main" sx={{ mt: 1, display: 'block' }}>Unsaved changes</Typography>}
    </Card>
  );
}
