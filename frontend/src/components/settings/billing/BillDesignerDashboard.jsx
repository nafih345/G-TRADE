import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Card, CardContent, Typography, Button, Grid, Chip, Stack, IconButton, Menu, MenuItem, Tabs, Tab, Dialog,
  DialogTitle, DialogContent, DialogActions, Alert, Divider, ListItemIcon, ListItemText, Tooltip,
} from '@mui/material';
import {
  Add as AddIcon, MoreVert as MoreIcon, Star as StarIcon, StarBorder as StarBorderIcon, ContentCopy as DuplicateIcon,
  Edit as EditIcon, Visibility as PreviewIcon, Delete as DeleteIcon, Close as CloseIcon, ToggleOn as ActiveIcon,
  ToggleOff as InactiveIcon, DriveFileRenameOutline as RenameIcon, AssignmentTurnedIn as AssignIcon,
  RestartAlt as RestoreIcon, RestoreFromTrash as TrashIcon, History as HistoryIcon,
} from '@mui/icons-material';
import { useBillTemplates } from '../../../billing/useBillTemplates';
import {
  DOCUMENT_TYPES, duplicateTemplate, renameTemplate, assignTemplate, restoreTemplateDefault, restoreDefaultTemplates,
  undeleteTemplate, createFromPreset, createTemplate, restoreTemplateVersion, fetchBillingMeta, apiError,
} from '../../../billing/billingApi';
import BillPreview from '../../../billing/BillPreview';
import { sampleForTemplate } from '../../../billing/sampleData';
import { sampleBillModel } from '../../../billing/sampleModels';
import { resolveCompany } from '../../../billing/documentAdapters';
import { readCompanyFromLocal, invalidateBillingContext } from '../../../billing/billingContext';
import { blankConfig } from '../../../billing/billLayout';
import { pageGeometry } from '../../../billing/renderBillLayout';
import { compatibleDocTypes, canonicalDocType } from '../../../billing/billFields';
import BillDesigner from './designer/BillDesigner';
import {
  NamePrompt, NewTemplateDialog, RestoreDefaultsDialog, AssignDialog, DeletedDialog, VersionsDialog,
} from './designer/DesignerDialogs';
import DocumentAssignmentPanel from './DocumentAssignmentPanel';
import BrandingPanel from './BrandingPanel';
import { notify } from '../../../utils/notify';

const DOC_LABEL = Object.fromEntries(DOCUMENT_TYPES.map((d) => [d.key, d.label]));
DOC_LABEL.RETURN_BILL = 'Sales Return';

function previewModel(tpl, company) {
  if (tpl?.config?.schema !== 2) return sampleForTemplate(tpl);
  const compat = compatibleDocTypes(tpl.config);
  const used = (tpl.used_by || []).map(canonicalDocType).find((d) => compat.includes(d));
  return sampleBillModel(used || compat[0] || 'SALES_INVOICE', { company, itemCount: 3 });
}

function TemplateCard({ tpl, onAction, company, canDesign }) {
  const [anchor, setAnchor] = useState(null);
  const model = useMemo(() => previewModel(tpl, company), [tpl, company]);
  const act = (a) => { setAnchor(null); onAction(a, tpl); };
  const visual = tpl.config?.schema === 2;

  return (
    <Card sx={{ borderRadius: 3, border: '1px solid', borderColor: tpl.is_default ? 'primary.main' : 'divider', opacity: tpl.is_active ? 1 : 0.6, height: '100%', display: 'flex', flexDirection: 'column' }} data-testid={`tpl-card-${tpl.name}`}>
      <Box sx={{ height: 230, overflow: 'hidden', bgcolor: '#eef2f7', p: 1.5, display: 'flex', justifyContent: 'center', cursor: 'pointer' }} onClick={() => act('preview')}>
        <BillPreview template={tpl} model={model} maxWidth={230} minHeight={200} firstPageOnly />
      </Box>
      <CardContent sx={{ pb: '12px !important', flex: 1, display: 'flex', flexDirection: 'column' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="flex-start">
          <Box sx={{ minWidth: 0 }}>
            <Typography fontWeight={800} noWrap title={tpl.name}>{tpl.name}</Typography>
            <Typography variant="caption" color="text.secondary">
              {tpl.paper_size}{tpl.orientation === 'landscape' ? ' landscape' : ''} · {visual ? 'Visual layout' : 'Classic layout'}{tpl.version ? ` · v${tpl.version}` : ''}
            </Typography>
          </Box>
          <IconButton size="small" onClick={(e) => setAnchor(e.currentTarget)} aria-label="Template actions"><MoreIcon fontSize="small" /></IconButton>
        </Stack>
        <Stack direction="row" sx={{ mt: 1, flexWrap: 'wrap', gap: 0.5 }}>
          {tpl.is_default && <Chip size="small" color="primary" icon={<StarIcon />} label="Default" />}
          {!tpl.is_active && <Chip size="small" label="Inactive" />}
          {(tpl.used_by || []).map((d) => <Chip key={d} size="small" variant="outlined" color="success" label={DOC_LABEL[d] || d} />)}
          {!(tpl.used_by || []).length && !tpl.is_default && <Chip size="small" variant="outlined" label="Not assigned" />}
        </Stack>
        <Box sx={{ flex: 1 }} />
        <Stack direction="row" spacing={1} sx={{ mt: 1.5 }}>
          <Button size="small" variant="contained" startIcon={<EditIcon />} onClick={() => act('edit')} sx={{ flex: 1 }} data-testid={`edit-${tpl.name}`}>{canDesign ? 'Edit' : 'Open'}</Button>
          <Button size="small" variant="outlined" startIcon={<AssignIcon />} onClick={() => act('assign')} disabled={!canDesign}>Assign</Button>
        </Stack>
      </CardContent>
      <Menu anchorEl={anchor} open={!!anchor} onClose={() => setAnchor(null)}>
        <MenuItem onClick={() => act('edit')}><ListItemIcon><EditIcon fontSize="small" /></ListItemIcon><ListItemText>Edit in designer</ListItemText></MenuItem>
        <MenuItem onClick={() => act('preview')}><ListItemIcon><PreviewIcon fontSize="small" /></ListItemIcon><ListItemText>Preview</ListItemText></MenuItem>
        <MenuItem onClick={() => act('duplicate')} disabled={!canDesign}><ListItemIcon><DuplicateIcon fontSize="small" /></ListItemIcon><ListItemText>Duplicate</ListItemText></MenuItem>
        <MenuItem onClick={() => act('rename')} disabled={!canDesign}><ListItemIcon><RenameIcon fontSize="small" /></ListItemIcon><ListItemText>Rename</ListItemText></MenuItem>
        <MenuItem onClick={() => act('assign')} disabled={!canDesign}><ListItemIcon><AssignIcon fontSize="small" /></ListItemIcon><ListItemText>Assign to document type…</ListItemText></MenuItem>
        {!tpl.is_default && <MenuItem onClick={() => act('set-default')} disabled={!canDesign}><ListItemIcon><StarBorderIcon fontSize="small" /></ListItemIcon><ListItemText>Set as default</ListItemText></MenuItem>}
        <MenuItem onClick={() => act('versions')}><ListItemIcon><HistoryIcon fontSize="small" /></ListItemIcon><ListItemText>Version history</ListItemText></MenuItem>
        {tpl.preset_key && <MenuItem onClick={() => act('restore-default')} disabled={!canDesign}><ListItemIcon><RestoreIcon fontSize="small" /></ListItemIcon><ListItemText>Restore starter layout</ListItemText></MenuItem>}
        {tpl.is_active
          ? <MenuItem onClick={() => act('deactivate')} disabled={!canDesign || tpl.is_default}><ListItemIcon><InactiveIcon fontSize="small" /></ListItemIcon><ListItemText>Deactivate</ListItemText></MenuItem>
          : <MenuItem onClick={() => act('activate')} disabled={!canDesign}><ListItemIcon><ActiveIcon fontSize="small" /></ListItemIcon><ListItemText>Activate</ListItemText></MenuItem>}
        <Divider />
        <MenuItem onClick={() => act('delete')} disabled={!canDesign || tpl.is_default} sx={{ color: 'error.main' }}><ListItemIcon><DeleteIcon fontSize="small" color="error" /></ListItemIcon><ListItemText>Delete</ListItemText></MenuItem>
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
  const [dialog, setDialog] = useState(null); // {kind, tpl}
  const [error, setError] = useState('');
  const [meta, setMeta] = useState(null);
  const company = useMemo(() => resolveCompany({ company: readCompanyFromLocal(), branding: bt.settings }), [bt.settings]);

  useEffect(() => { fetchBillingMeta().then(setMeta).catch(() => setMeta({ can_design: true })); }, []);
  const canDesign = meta ? !!meta.can_design : true;

  const refresh = () => { invalidateBillingContext(); bt.refetchAll(); };
  const run = async (fn, success) => {
    setError('');
    try {
      const out = await fn();
      if (success) notify(success, 'success');
      refresh();
      return out;
    } catch (e) {
      setError(apiError(e, 'Action failed.'));
      return null;
    }
  };

  const runAction = async (action, tpl) => {
    if (action === 'edit') setEditing(tpl);
    else if (action === 'preview') setPreviewing(tpl);
    else if (action === 'duplicate') { const c = await run(() => duplicateTemplate(tpl.id), `Duplicated “${tpl.name}”.`); if (c) setEditing(c); }
    else if (action === 'rename') setDialog({ kind: 'rename', tpl });
    else if (action === 'assign') setDialog({ kind: 'assign', tpl });
    else if (action === 'versions') setDialog({ kind: 'versions', tpl });
    else if (action === 'set-default') await run(() => bt.setDefaultTemplate.mutateAsync(tpl.id), `“${tpl.name}” is now the default template.`);
    else if (action === 'activate') await run(() => bt.activateTemplate.mutateAsync(tpl.id));
    else if (action === 'deactivate') await run(() => bt.deactivateTemplate.mutateAsync(tpl.id));
    else if (action === 'restore-default') {
      if (window.confirm(`Reset “${tpl.name}” to its starter layout? The current design is kept in Version history.`)) await run(() => restoreTemplateDefault(tpl.id), 'Starter layout restored.');
    } else if (action === 'delete') setConfirmDelete(tpl);
  };

  const createBlank = async (paper) => {
    setDialog(null);
    const base = { paper_size: paper, orientation: 'portrait', margins: ['80mm', '58mm'].includes(paper) ? { top: 3, right: 3, bottom: 3, left: 3 } : { top: 10, right: 10, bottom: 10, left: 10 } };
    const g = pageGeometry(base);
    const names = new Set(bt.templates.map((t) => t.name.toLowerCase()));
    let name = 'New Template';
    for (let n = 2; names.has(name.toLowerCase()); n += 1) name = `New Template ${n}`;
    const created = await run(() => createTemplate({ ...base, name, template_type: 'CUSTOM', config: blankConfig({ width: g.contentW }), is_active: true }), 'Blank template created.');
    if (created) setEditing(created);
  };

  const doDelete = async () => {
    const t = confirmDelete;
    setConfirmDelete(null);
    await run(() => bt.deleteTemplate.mutateAsync(t.id), `“${t.name}” deleted — restore it from Deleted templates.`);
  };

  const saveTheme = async (theme) => {
    const themes = [...(bt.settings.themes || []).filter((x) => x.name !== theme.name), theme];
    await run(() => bt.saveSettings.mutateAsync({ themes }), `Theme “${theme.name}” saved.`);
  };

  const saving = bt.saveAssignments.isPending || bt.saveSettings.isPending;

  return (
    <Box>
      {!bt.isBackendLive && <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>Showing built-in starter templates — the billing service is unreachable, so edits cannot be saved yet.</Alert>}
      {meta && !canDesign && <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>View only — sign in as a Super Admin, Administrator or Manager to create or change bill templates.</Alert>}
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
          <Stack direction={{ xs: 'column', sm: 'row' }} justifyContent="space-between" alignItems={{ sm: 'center' }} spacing={1} sx={{ mb: 2 }}>
            <Box>
              <Typography variant="h6" fontWeight={800}>Bill Templates ({bt.templates.length})</Typography>
              <Typography variant="body2" color="text.secondary">Design layouts visually; every value prints from the real transaction.</Typography>
            </Box>
            <Stack direction="row" spacing={1}>
              <Tooltip title="Restore deleted templates"><span><Button startIcon={<TrashIcon />} onClick={() => setDialog({ kind: 'deleted' })} disabled={!canDesign}>Deleted</Button></span></Tooltip>
              <Button variant="outlined" startIcon={<RestoreIcon />} onClick={() => setDialog({ kind: 'restore' })} disabled={!canDesign} data-testid="restore-defaults">Restore defaults</Button>
              <Button variant="contained" startIcon={<AddIcon />} onClick={() => setDialog({ kind: 'new' })} disabled={!canDesign} sx={{ fontWeight: 800 }} data-testid="create-template">Create Template</Button>
            </Stack>
          </Stack>
          <Grid container spacing={2.5}>
            {bt.templates.map((tpl) => (
              <Grid item xs={12} sm={6} md={4} lg={3} key={tpl.id}>
                <TemplateCard tpl={tpl} onAction={runAction} company={company} canDesign={canDesign} />
              </Grid>
            ))}
          </Grid>
        </>
      )}

      {tab === 'assignment' && (
        <DocumentAssignmentPanel
          templates={bt.templates} assignments={bt.assignments} settings={bt.settings} saving={saving} canDesign={canDesign}
          onSaveAssignments={(a) => bt.saveAssignments.mutateAsync(a)}
          onSaveSettings={(s) => bt.saveSettings.mutateAsync(s)}
          onUseRecommended={() => run(() => restoreDefaultTemplates({ reassign: true }), 'Every document now uses its recommended starter template.')}
        />
      )}

      {tab === 'branding' && (
        <BrandingPanel settings={bt.settings} saving={saving} canDesign={canDesign} onSave={(s) => bt.saveSettings.mutateAsync(s).then(refresh)} />
      )}

      <BillDesigner
        open={!!editing} template={editing} settings={bt.settings} canDesign={canDesign}
        onClose={() => { setEditing(null); refresh(); }}
        onSaved={(saved) => { if (saved) { refresh(); } }}
        onSaveTheme={saveTheme}
      />

      <Dialog open={!!previewing} onClose={() => setPreviewing(null)} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span>Preview — {previewing?.name} <Chip size="small" color="warning" label="Sample data" sx={{ ml: 1 }} /></span>
          <IconButton onClick={() => setPreviewing(null)}><CloseIcon /></IconButton>
        </DialogTitle>
        <DialogContent dividers sx={{ bgcolor: '#eef2f7', py: 3 }}>
          {previewing && <BillPreview template={previewing} model={previewModel(previewing, company)} maxWidth={680} />}
        </DialogContent>
        <DialogActions>
          <Typography variant="caption" color="text.secondary" sx={{ flex: 1, pl: 1 }}>To preview a real bill, open the template in the designer and choose “Real document”.</Typography>
          <Button onClick={() => { setEditing(previewing); setPreviewing(null); }}>Open in designer</Button>
        </DialogActions>
      </Dialog>

      <Dialog open={!!confirmDelete} onClose={() => setConfirmDelete(null)}>
        <DialogTitle>Delete “{confirmDelete?.name}”?</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {(confirmDelete?.used_by || []).length
              ? `It is assigned to ${(confirmDelete.used_by).map((d) => DOC_LABEL[d] || d).join(', ')} — those documents will use the default template. `
              : ''}
            You can restore it later from “Deleted”.
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button color="error" variant="contained" onClick={doDelete} data-testid="confirm-delete">Delete</Button>
        </DialogActions>
      </Dialog>

      <NewTemplateDialog
        open={dialog?.kind === 'new'} onClose={() => setDialog(null)} onBlank={createBlank}
        onPreset={async (p) => { setDialog(null); const c = await run(() => createFromPreset(p.preset_key), `Created “${p.name}”.`); if (c) setEditing(c); }}
      />
      <NamePrompt
        open={dialog?.kind === 'rename'} title="Rename template" initial={dialog?.tpl?.name || ''} confirmLabel="Rename"
        onClose={() => setDialog(null)} onConfirm={(name) => { const t = dialog.tpl; setDialog(null); run(() => renameTemplate(t.id, name), 'Template renamed.'); }}
      />
      <AssignDialog
        open={dialog?.kind === 'assign'} template={dialog?.tpl} onClose={() => setDialog(null)}
        onConfirm={(types) => { const t = dialog.tpl; setDialog(null); run(() => assignTemplate(t.id, types, true), 'Assignment saved.'); }}
      />
      <RestoreDefaultsDialog
        open={dialog?.kind === 'restore'} onClose={() => setDialog(null)}
        onConfirm={async (opts) => {
          setDialog(null);
          const r = await run(() => restoreDefaultTemplates(opts));
          if (r) notify(`Defaults restored${r.created.length ? ` — recreated ${r.created.length}` : ''}${r.reset.length ? `, reset ${r.reset.length}` : ''}${r.reassigned ? ', assignments reset' : ''}.`, 'success');
        }}
      />
      <DeletedDialog open={dialog?.kind === 'deleted'} onClose={() => setDialog(null)} onRestore={(t) => { setDialog(null); run(() => undeleteTemplate(t.id), `“${t.name}” restored.`); }} />
      <VersionsDialog
        open={dialog?.kind === 'versions'} template={dialog?.tpl} onClose={() => setDialog(null)}
        onRestore={(v) => { const t = dialog.tpl; setDialog(null); run(() => restoreTemplateVersion(t.id, v), `Version ${v} restored.`); }}
      />
    </Box>
  );
}
