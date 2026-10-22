import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, Autocomplete, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, Grid,
  IconButton, MenuItem, Switch, Table, TableBody, TableCell, TableContainer, TableHead, TableRow, TextField, Tooltip,
  Typography,
} from '@mui/material';
import { Add as AddIcon, Delete as DeleteIcon, DashboardCustomize as FieldsIcon, Edit as EditIcon } from '@mui/icons-material';
import ConfirmActionDialog from '../../common/ConfirmActionDialog';
import { EmptyState, SectionCard, errText, greenButtonSx } from './businessUi';
import { notify } from '../../../utils/notify';
import { apiErrorMessage } from '../../../utils/apiError';

const URL = '/api/company/custom-fields/';
export const FIELD_TYPES = {
  TEXT: 'Text', TEXTAREA: 'Long text', NUMBER: 'Number', DATE: 'Date', DROPDOWN: 'Dropdown', CHECKBOX: 'Checkbox',
  EMAIL: 'Email', PHONE: 'Phone',
};
export const MODULES = {
  CUSTOMER: 'Customers / Patients', SUPPLIER: 'Suppliers', PRODUCT: 'Products', SALES: 'Sales documents',
  PURCHASE: 'Purchase documents', EYE_TEST: 'Eye Test',
};
const BLANK = { name: '', field_type: 'TEXT', module: '', options: [], is_required: false, is_active: true };

function FieldDialog({ open, initial, onClose, onSaved }) {
  const [form, setForm] = useState(BLANK);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  useEffect(() => { if (open) { setForm(initial ? { ...BLANK, ...initial } : BLANK); setErrors({}); } }, [open, initial]);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    const e = {};
    if (!form.name.trim()) e.name = 'Enter a field name.';
    if (!form.module) e.module = 'Choose the module this field belongs to.';
    if (form.field_type === 'DROPDOWN' && !form.options.length) e.options = 'Add at least one choice.';
    setErrors(e);
    if (Object.keys(e).length) return;
    setSaving(true);
    try {
      const body = { ...form, options: form.field_type === 'DROPDOWN' ? form.options : [] };
      const res = initial?.id ? await axios.put(`${URL}${initial.id}/`, body) : await axios.post(URL, body);
      notify(`Custom field ${res.data.name} ${initial?.id ? 'updated' : 'added'}.`, 'success');
      onSaved();
    } catch (err) {
      const data = err?.response?.data;
      if (data?.errors) setErrors(data.errors);
      notify(data?.detail || apiErrorMessage(err), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={saving ? undefined : onClose} fullWidth maxWidth="sm">
      <DialogTitle sx={{ fontWeight: 800 }}>{initial?.id ? 'Edit Custom Field' : 'Add Custom Field'}</DialogTitle>
      <DialogContent dividers>
        <Grid container spacing={2}>
          <Grid item xs={12}>
            <TextField fullWidth autoFocus required label="Field Name" value={form.name} onChange={(e) => set('name', e.target.value)}
              inputProps={{ maxLength: 60 }} error={!!errors.name} helperText={errText(errors.name) || 'e.g. Preferred Lens Brand'} />
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField select fullWidth required label="Field Type" value={form.field_type} onChange={(e) => set('field_type', e.target.value)}
              error={!!errors.field_type} helperText={errText(errors.field_type)}>
              {Object.entries(FIELD_TYPES).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField select fullWidth required label="Applicable Module" value={form.module} onChange={(e) => set('module', e.target.value)}
              error={!!errors.module} helperText={errText(errors.module)}>
              {Object.entries(MODULES).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
            </TextField>
          </Grid>
          {form.field_type === 'DROPDOWN' && (
            <Grid item xs={12}>
              <Autocomplete
                multiple freeSolo options={[]} value={form.options}
                onChange={(_, list) => set('options', list.map((o) => String(o).trim()).filter(Boolean))}
                renderTags={(value, getTagProps) => value.map((o, i) => {
                  const { key, ...rest } = getTagProps({ index: i });
                  return <Chip key={key} {...rest} size="small" label={o} />;
                })}
                renderInput={(p) => (
                  <TextField {...p} label="Choices" error={!!errors.options}
                    helperText={errText(errors.options) || 'Type a choice and press Enter.'} />
                )}
              />
            </Grid>
          )}
          <Grid item xs={6}>
            <FormControlLabel control={<Switch checked={form.is_required} onChange={(e) => set('is_required', e.target.checked)} />} label="Required" />
          </Grid>
          <Grid item xs={6}>
            <FormControlLabel control={<Switch checked={form.is_active} onChange={(e) => set('is_active', e.target.checked)} />} label="Active" />
          </Grid>
        </Grid>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 2 }}>
        <Button onClick={onClose} disabled={saving}>Cancel</Button>
        <Button variant="contained" onClick={save} disabled={saving} sx={greenButtonSx}>{saving ? 'Saving…' : 'Save Field'}</Button>
      </DialogActions>
    </Dialog>
  );
}

export default function CustomFieldsTab() {
  const [fields, setFields] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [editing, setEditing] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const load = useCallback(() => {
    axios.get(URL).then((r) => { setFields(r.data); setLoadError(''); })
      .catch((e) => setLoadError(`Could not load custom fields. ${apiErrorMessage(e)}`));
  }, []);
  useEffect(() => { load(); }, [load]);

  const toggle = async (f, key) => {
    try {
      await axios.put(`${URL}${f.id}/`, { [key]: !f[key] });
      load();
    } catch (e) {
      notify(e?.response?.data?.detail || apiErrorMessage(e), 'error');
    }
  };

  const doDelete = async () => {
    const f = deleting;
    setDeleting(null);
    try {
      await axios.delete(`${URL}${f.id}/`);
      notify(`Custom field ${f.name} deleted.`, 'success');
      load();
    } catch (e) {
      notify(e?.response?.data?.detail || apiErrorMessage(e), 'error');
    }
  };

  const addButton = (
    <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({})} sx={{ ...greenButtonSx, whiteSpace: 'nowrap' }}>
      Add Custom Field
    </Button>
  );

  return (
    <SectionCard id="custom-fields" icon={<FieldsIcon />} title="Custom Fields"
      subtitle="Extra fields for customers, products, documents and more. Each change saves immediately."
      action={fields?.length ? addButton : null}>
      <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
        Field definitions are stored here first. Customer, product and document forms will show them as each screen adds support.
      </Alert>
      {loadError && <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{loadError}</Alert>}
      {!loadError && fields === null && <Typography variant="body2" color="text.secondary">Loading custom fields…</Typography>}
      {fields && fields.length === 0 && (
        <EmptyState icon={<FieldsIcon />} title="No custom fields yet"
          description="Capture details your business needs that the standard forms don't have — like a preferred lens brand or a referral source."
          action={addButton} />
      )}
      {fields && fields.length > 0 && (
        <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Table size="small" sx={{ minWidth: 680 }}>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, bgcolor: 'action.hover' } }}>
                <TableCell>Field Name</TableCell>
                <TableCell>Type</TableCell>
                <TableCell>Module</TableCell>
                <TableCell>Required</TableCell>
                <TableCell>Active</TableCell>
                <TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {fields.map((f) => (
                <TableRow key={f.id} hover sx={{ opacity: f.is_active ? 1 : 0.6 }}>
                  <TableCell>
                    <Typography variant="body2" fontWeight={700}>{f.name}</Typography>
                    <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{f.key}</Typography>
                  </TableCell>
                  <TableCell>
                    {FIELD_TYPES[f.field_type] || f.field_type}
                    {f.field_type === 'DROPDOWN' && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{f.options.join(', ')}</Typography>}
                  </TableCell>
                  <TableCell>{MODULES[f.module] || f.module}</TableCell>
                  <TableCell><Switch size="small" checked={f.is_required} onChange={() => toggle(f, 'is_required')} inputProps={{ 'aria-label': `${f.name} required` }} /></TableCell>
                  <TableCell><Switch size="small" checked={f.is_active} onChange={() => toggle(f, 'is_active')} inputProps={{ 'aria-label': `${f.name} active` }} /></TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title="Edit"><IconButton size="small" onClick={() => setEditing(f)} aria-label={`Edit ${f.name}`}><EditIcon fontSize="small" /></IconButton></Tooltip>
                    <Tooltip title="Delete"><IconButton size="small" color="error" onClick={() => setDeleting(f)} aria-label={`Delete ${f.name}`}><DeleteIcon fontSize="small" /></IconButton></Tooltip>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      )}
      <FieldDialog open={editing !== null} initial={editing?.id ? editing : null} onClose={() => setEditing(null)}
        onSaved={() => { setEditing(null); load(); }} />
      <ConfirmActionDialog open={!!deleting} type="danger" title="Delete custom field?"
        message={deleting ? `Delete "${deleting.name}" from ${MODULES[deleting.module] || deleting.module}?` : ''}
        confirmText="Delete" cancelText="Cancel" onConfirm={doDelete} onClose={() => setDeleting(null)} />
    </SectionCard>
  );
}
