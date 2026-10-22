import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Grid,
  MenuItem, TextField, useMediaQuery, useTheme,
} from '@mui/material';
import { DesignServices as DesignerIcon } from '@mui/icons-material';
import BillPreview from '../../../billing/BillPreview';
import { loadBillingContext, resolveTemplate } from '../../../billing/billingContext';
import { DOCUMENT_TYPES } from '../../../billing/billingApi';
import { compatibleDocTypes } from '../../../billing/billFields.js';
import { resolveCompany } from '../../../billing/documentAdapters';
import { sampleBillModel } from '../../../billing/sampleModels';
import { brandingFromProfile, companyFromProfile } from '../../../utils/storeProfile';
import { GREEN, greenButtonSx } from './storeUi';

const canPrint = (t, type) => !!t && t.is_active !== false
  && (t.compatible_types || compatibleDocTypes(t.config)).includes(type);

/** Sample document rendered with the live (unsaved) profile through the real template engine.
 *  Nothing is saved — the profile is overlaid on the cached billing context for this render only. */
export default function InvoicePreviewDialog({ open, onClose, form, currency, onOpenDesigner }) {
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [ctx, setCtx] = useState(null);
  const [docType, setDocType] = useState('SALES_INVOICE');
  const [templateId, setTemplateId] = useState('');

  useEffect(() => {
    if (!open) return undefined;
    let alive = true;
    loadBillingContext({ force: true }).then((c) => { if (alive) setCtx(c); }).catch(() => alive && setCtx({}));
    return () => { alive = false; };
  }, [open]);

  const options = useMemo(() => (ctx?.templates || []).filter((t) => canPrint(t, docType)), [ctx, docType]);
  const assigned = useMemo(() => (ctx ? resolveTemplate(docType, ctx) : null), [ctx, docType]);
  useEffect(() => { setTemplateId(''); }, [docType]);
  const template = options.find((t) => t.id === templateId) || assigned;

  const model = useMemo(() => {
    if (!ctx) return null;
    const company = resolveCompany({
      company: { ...companyFromProfile(form), currency: currency || '₹' },
      branding: brandingFromProfile(form, ctx.settings || {}),
    });
    return sampleBillModel(docType, { company });
  }, [ctx, form, docType, currency]);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth fullScreen={fullScreen} aria-labelledby="invoice-preview-title">
      <DialogTitle id="invoice-preview-title" sx={{ fontWeight: 800 }}>Invoice Preview</DialogTitle>
      <DialogContent dividers>
        <Alert severity="info" sx={{ mb: 2, borderRadius: 2 }}>
          Sample document using your current (unsaved) store profile. Nothing is saved from this preview.
        </Alert>
        <Grid container spacing={2} sx={{ mb: 2 }}>
          <Grid item xs={12} sm={6}>
            <TextField select size="small" fullWidth label="Document type" value={docType} onChange={(e) => setDocType(e.target.value)}>
              {DOCUMENT_TYPES.map((d) => <MenuItem key={d.key} value={d.key}>{d.label}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={6}>
            <TextField
              select size="small" fullWidth label="Template" value={templateId}
              onChange={(e) => setTemplateId(e.target.value)}
              disabled={!options.length}
              helperText={options.length ? '' : 'Built-in layout (no saved templates for this document)'}
              SelectProps={{ displayEmpty: true }}
              InputLabelProps={{ shrink: true }}
            >
              <MenuItem value="">{`Assigned template${assigned?.name ? ` — ${assigned.name}` : ''}`}</MenuItem>
              {options.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
            </TextField>
          </Grid>
        </Grid>
        <Box sx={{ bgcolor: 'action.hover', borderRadius: 2, p: { xs: 1, sm: 2 }, overflow: 'hidden' }}>
          {model && template ? (
            <BillPreview template={template} model={model} documentType={docType} maxWidth={fullScreen ? 320 : 720} />
          ) : (
            <Box sx={{ display: 'grid', placeItems: 'center', minHeight: 240 }}><CircularProgress sx={{ color: GREEN }} /></Box>
          )}
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5, flexWrap: 'wrap', gap: 1 }}>
        <Button startIcon={<DesignerIcon />} onClick={onOpenDesigner} sx={{ fontWeight: 700, color: GREEN }}>
          Open Bill &amp; Invoice Designer
        </Button>
        <Box sx={{ flex: 1 }} />
        <Button variant="contained" onClick={onClose} sx={greenButtonSx}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
