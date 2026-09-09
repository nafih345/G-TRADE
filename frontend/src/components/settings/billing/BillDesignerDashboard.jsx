import React, { useState } from 'react';
import {
  Box, Card, CardContent, Typography, Button, Grid, Chip, Stack, IconButton,
  Menu, MenuItem, Tabs, Tab, Dialog, DialogTitle, DialogContent, DialogActions,
  Alert, Tooltip, Divider,
} from '@mui/material';
import {
  Add as AddIcon, MoreVert as MoreIcon, Star as StarIcon, StarBorder as StarBorderIcon,
  ContentCopy as DuplicateIcon, Edit as EditIcon, Visibility as PreviewIcon,
  Delete as DeleteIcon, Close as CloseIcon, ToggleOn as ActiveIcon, ToggleOff as InactiveIcon,
} from '@mui/icons-material';
import { useBillTemplates } from '../../../billing/useBillTemplates';
import { DOCUMENT_TYPES } from '../../../billing/billingApi';
import { emptyTemplateConfig } from '../../../billing/templatePresets';
import BillPreview from '../../../billing/BillPreview';
import { sampleForTemplate } from '../../../billing/sampleData';
import TemplateEditorDialog from './TemplateEditorDialog';
import DocumentAssignmentPanel from './DocumentAssignmentPanel';
import BrandingPanel from './BrandingPanel';

const DOC_LABEL = Object.fromEntries(DOCUMENT_TYPES.map((d) => [d.key, d.label]));

function TemplateCard({ tpl, onAction }) {
  const [anchor, setAnchor] = useState(null);
  const model = sampleForTemplate(tpl); // already in BillModel shape — no adapter needed

  const act = (a) => { setAnchor(null); onAction(a, tpl); };

  return (
    <Card sx={{ borderRadius: 3, border: '1px solid', borderColor: tpl.is_default ? 'primary.main' : 'divider', opacity: tpl.is_active ? 1 : 0.6 }}>
      <Box sx={{ height: 230, overflow: 'hidden', bgcolor: '#eef2f7', p: 1.5, display: 'flex', justifyContent: 'center', cursor: 'pointer' }}
        onClick={() => act('preview')}
      >
        <BillPreview template={tpl} model={model} maxWidth={230} minHeight={200} />
      </Box>
      <CardContent sx={{ pb: '12px !important' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box sx={{ minWidth: 0 }}>
            <Typography fontWeight={800} noWrap>{tpl.name}</Typography>
            <Typography variant="caption" color="text.secondary">{tpl.template_type} · {tpl.paper_size}</Typography>
          </Box>
          <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)}><MoreIcon fontSize="small" /></IconButton>
        </Stack>

        <Stack direction="row" spacing={0.5} sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
          {tpl.is_default && <Chip size="small" color="primary" icon={<StarIcon />} label="Default" />}
          {!tpl.is_active && <Chip size="small" label="Inactive" />}
          {(tpl.used_by || []).map((d) => (
            <Chip key={d} size="small" variant="outlined" label={DOC_LABEL[d] || d} />
          ))}
        </Stack>

        {tpl.updated_at && (
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Updated {new Date(tpl.updated_at).toLocaleDateString()}
          </Typography>
        )}

        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <Button size="small" variant="outlined" startIcon={<EditIcon />} onClick={() => act('edit')} sx={{ flex: 1 }}>Edit</Button>
          <Button size="small" variant="outlined" startIcon={<PreviewIcon />} onClick={() => act('preview')}>Preview</Button>
        </Stack>
      </CardContent>

      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => act('edit')}><EditIcon fontSize="small" sx={{ mr: 1 }} /> Edit</MenuItem>
        <MenuItem onClick={() => act('duplicate')}><DuplicateIcon fontSize="small" sx={{ mr: 1 }} /> Duplicate</MenuItem>
        <MenuItem onClick={() => act('preview')}><PreviewIcon fontSize="small" sx={{ mr: 1 }} /> Preview</MenuItem>
        {!tpl.is_default && <MenuItem onClick={() => act('set-default')}><StarBorderIcon fontSize="small" sx={{ mr: 1 }} /> Set as default</MenuItem>}
        {tpl.is_active
          ? <MenuItem onClick={() => act('deactivate')}><InactiveIcon fontSize="small" sx={{ mr: 1 }} /> Deactivate</MenuItem>
          : <MenuItem onClick={() => act('activate')}><ActiveIcon fontSize="small" sx={{ mr: 1 }} /> Activate</MenuItem>}
        <Divider />
        <MenuItem onClick={() => act('delete')} sx={{ color: 'error.main' }}><DeleteIcon fontSize="small" sx={{ mr: 1 }} /> Delete</MenuItem>
      </Menu>
    </Card>
  );
}

export default function BillDesignerDashboard() {
  const bt = useBillTemplates();
  const [tab, setTab] = useState('templates');
  const [editing, setEditing] = useState(null);
  const [previewing, setPreviewing] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [error, setError] = useState('');

  const saving = bt.createTemplate.isPending || bt.updateTemplate.isPending
    || bt.saveAssignments.isPending || bt.saveSettings.isPending;

  const runAction = async (action, tpl) => {
    setError('');
    try {
      if (action === 'edit') setEditing(tpl);
      else if (action === 'preview') setPreviewing(tpl);
      else if (action === 'duplicate') await bt.duplicateTemplate.mutateAsync(tpl.id);
      else if (action === 'set-default') await bt.setDefaultTemplate.mutateAsync(tpl.id);
      else if (action === 'activate') await bt.activateTemplate.mutateAsync(tpl.id);
      else if (action === 'deactivate') await bt.deactivateTemplate.mutateAsync(tpl.id);
      else if (action === 'delete') setConfirmDelete(tpl);
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || 'Action failed.');
    }
  };

  const handleCreate = async () => {
    setError('');
    try {
      const created = await bt.createTemplate.mutateAsync({
        name: 'New Template', template_type: 'CUSTOM', paper_size: 'A4', orientation: 'portrait',
        margins: { top: 15, right: 15, bottom: 15, left: 15 }, config: emptyTemplateConfig(),
        is_active: true,
      });
      setEditing(created);
    } catch (e) {
      setError(e?.response?.data?.detail || 'Could not create template (backend offline?).');
    }
  };

  const handleSaveEdit = async (draft) => {
    setError('');
    try {
      const { id, name, template_type, description, paper_size, orientation,
        custom_width_mm, custom_height_mm, margins, config, is_active } = draft;
      await bt.updateTemplate.mutateAsync({
        id,
        payload: {
          name, template_type, description, paper_size, orientation,
          custom_width_mm: custom_width_mm || null, custom_height_mm: custom_height_mm || null,
          margins, config, is_active,
        },
      });
      setEditing(null);
    } catch (e) {
      setError(e?.response?.data?.detail || e?.message || 'Save failed.');
    }
  };

  const doDelete = async () => {
    try {
      await bt.deleteTemplate.mutateAsync(confirmDelete.id);
    } catch (e) {
      setError(e?.response?.data?.detail || 'Delete failed.');
    }
    setConfirmDelete(null);
  };

  return (
    <Box>
      {!bt.isBackendLive && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>
          Showing built-in starter templates — the backend billing service is unreachable, so edits cannot be saved yet.
        </Alert>
      )}
      {error && <Alert severity="error" sx={{ mb: 2, borderRadius: 2 }} onClose={() => setError('')}>{error}</Alert>}

      <Card sx={{ mb: 2, borderRadius: 3 }}>
        <Tabs value={tab} onChange={(e, v) => setTab(v)} sx={{ px: 2 }}>
          <Tab value="templates" label="Templates" sx={{ fontWeight: 700 }} />
          <Tab value="assignment" label="Document Assignment" sx={{ fontWeight: 700 }} />
          <Tab value="branding" label="Logo & Branding" sx={{ fontWeight: 700 }} />
        </Tabs>
      </Card>

      {tab === 'templates' && (
        <>
          <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
            <Typography variant="h6" fontWeight={800}>Bill Templates ({bt.templates.length})</Typography>
            <Button variant="contained" startIcon={<AddIcon />} onClick={handleCreate} sx={{ fontWeight: 800 }}>
              Create Template
            </Button>
          </Stack>
          <Grid container spacing={2.5}>
            {bt.templates.map((tpl) => (
              <Grid item xs={12} sm={6} md={4} lg={3} key={tpl.id}>
                <TemplateCard tpl={tpl} onAction={runAction} />
              </Grid>
            ))}
          </Grid>
        </>
      )}

      {tab === 'assignment' && (
        <DocumentAssignmentPanel
          templates={bt.templates}
          assignments={bt.assignments}
          settings={bt.settings}
          saving={saving}
          onSaveAssignments={(a) => bt.saveAssignments.mutateAsync(a)}
          onSaveSettings={(s) => bt.saveSettings.mutateAsync(s)}
        />
      )}

      {tab === 'branding' && (
        <BrandingPanel settings={bt.settings} saving={saving} onSave={(s) => bt.saveSettings.mutateAsync(s)} />
      )}

      <TemplateEditorDialog
        open={!!editing}
        template={editing}
        saving={bt.updateTemplate.isPending}
        onClose={() => setEditing(null)}
        onSave={handleSaveEdit}
      />

      <Dialog open={!!previewing} onClose={() => setPreviewing(null)} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Preview — {previewing?.name}</span>
          <IconButton onClick={() => setPreviewing(null)}><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ bgcolor: '#eef2f7', py: 3 }}>
          {previewing && (
            <BillPreview template={previewing} model={sampleForTemplate(previewing)} maxWidth={680} />
          )}
        </DialogContent>
      </Dialog>

      <Dialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)}>
        <DialogTitle>Delete “{confirmDelete?.name}”?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">This cannot be undone. Document types using it will fall back to the default template.</Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={doDelete}>Delete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
