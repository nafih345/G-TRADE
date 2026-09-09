import React, { useEffect, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Grid, TextField,
  MenuItem, Box, Typography, Stack, Divider, IconButton, FormControlLabel, Switch,
} from '@mui/material';
import { Close as CloseIcon, Print as PrintIcon } from '@mui/icons-material';
import BillPreview from '../../../billing/BillPreview';
import { sampleForTemplate } from '../../../billing/sampleData';
import { buildBillHtml } from '../../../billing/printBill';
import {
  SECTION_LABELS, COLUMN_LABELS, TOTALS_ROW_LABELS,
} from '../../../billing/templatePresets';

const PAPER_SIZES = [
  { value: 'A4', label: 'A4 (210 × 297 mm)' },
  { value: 'A5', label: 'A5 (148 × 210 mm)' },
  { value: '80mm', label: 'Thermal 80 mm (auto height)' },
  { value: '58mm', label: 'Thermal 58 mm (auto height)' },
  { value: 'CUSTOM', label: 'Custom size' },
];

const TEMPLATE_TYPES = ['STANDARD', 'COMPACT', 'THERMAL_80', 'THERMAL_58', 'JEWELLERY', 'WHOLESALE', 'CUSTOM'];

/**
 * Phase 1 editor: template basics (name / type / paper / orientation / margins),
 * section visibility, item columns and totals rows — with the live preview beside it.
 * The full drag-and-drop 3-pane editor lands in Phase 2.
 */
export default function TemplateEditorDialog({ open, template, onClose, onSave, saving }) {
  const [draft, setDraft] = useState(null);

  useEffect(() => {
    if (template) setDraft(JSON.parse(JSON.stringify(template)));
  }, [template]);

  if (!draft) return null;

  const patch = (fields) => setDraft((d) => ({ ...d, ...fields }));
  const patchStyle = (fields) => setDraft((d) => ({
    ...d, config: { ...d.config, styles: { ...d.config.styles, ...fields } },
  }));
  const setSection = (id, updater) => setDraft((d) => ({
    ...d,
    config: {
      ...d.config,
      sections: d.config.sections.map((s) => (s.id === id ? updater(s) : s)),
    },
  }));

  const itemsSection = draft.config.sections.find((s) => s.id === 'items');
  const totalsSection = draft.config.sections.find((s) => s.id === 'totals');

  const model = sampleForTemplate(draft); // already a BillModel — used directly

  const handlePrintTest = async () => {
    const { html } = await buildBillHtml({ modelOverride: model, templateOverride: draft, autoPrint: true });
    const win = window.open('', '_blank', 'width=940,height=920');
    if (win) { win.document.open(); win.document.write(html); win.document.close(); }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth PaperProps={{ sx: { borderRadius: 3, height: '92vh' } }}>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', bgcolor: '#0f172a', color: '#fff', py: 1.5 }}>
        <Typography variant="h6" fontWeight={800}>Edit Template — {draft.name}</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" color="inherit" startIcon={<PrintIcon />} onClick={handlePrintTest} sx={{ color: '#0f172a', fontWeight: 700 }}>
            Print Test
          </Button>
          <IconButton color="inherit" onClick={onClose}><CloseIcon /></IconButton>
        </Stack>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 0, display: 'flex', overflow: 'hidden' }}>
        {/* Settings column */}
        <Box sx={{ width: 420, flexShrink: 0, overflowY: 'auto', p: 2.5, borderRight: '1px solid', borderColor: 'divider' }}>
          <Typography variant="overline" color="text.secondary" fontWeight={800}>Basic</Typography>
          <Grid container spacing={1.5} sx={{ mb: 2, mt: 0.5 }}>
            <Grid item xs={12}>
              <TextField label="Template name" size="small" fullWidth value={draft.name}
                onChange={(e) => patch({ name: e.target.value })} />
            </Grid>
            <Grid item xs={6}>
              <TextField select label="Type" size="small" fullWidth value={draft.template_type}
                onChange={(e) => patch({ template_type: e.target.value })}>
                {TEMPLATE_TYPES.map((t) => <MenuItem key={t} value={t}>{t}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={6}>
              <TextField select label="Paper size" size="small" fullWidth value={draft.paper_size}
                onChange={(e) => patch({ paper_size: e.target.value })}>
                {PAPER_SIZES.map((p) => <MenuItem key={p.value} value={p.value}>{p.label}</MenuItem>)}
              </TextField>
            </Grid>
            {draft.paper_size === 'CUSTOM' && (
              <>
                <Grid item xs={6}>
                  <TextField label="Width (mm)" size="small" type="number" fullWidth
                    value={draft.custom_width_mm || ''} onChange={(e) => patch({ custom_width_mm: e.target.value })} />
                </Grid>
                <Grid item xs={6}>
                  <TextField label="Height (mm, blank = auto)" size="small" type="number" fullWidth
                    value={draft.custom_height_mm || ''} onChange={(e) => patch({ custom_height_mm: e.target.value })} />
                </Grid>
              </>
            )}
            <Grid item xs={6}>
              <TextField select label="Orientation" size="small" fullWidth value={draft.orientation}
                onChange={(e) => patch({ orientation: e.target.value })}>
                <MenuItem value="portrait">Portrait</MenuItem>
                <MenuItem value="landscape">Landscape</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12}>
              <TextField label="Description" size="small" fullWidth value={draft.description || ''}
                onChange={(e) => patch({ description: e.target.value })} />
            </Grid>
          </Grid>

          <Typography variant="overline" color="text.secondary" fontWeight={800}>Margins (mm)</Typography>
          <Grid container spacing={1.5} sx={{ mb: 2, mt: 0.5 }}>
            {['top', 'right', 'bottom', 'left'].map((side) => (
              <Grid item xs={3} key={side}>
                <TextField label={side} size="small" type="number" fullWidth
                  value={draft.margins?.[side] ?? ''}
                  onChange={(e) => patch({ margins: { ...draft.margins, [side]: parseFloat(e.target.value) || 0 } })} />
              </Grid>
            ))}
          </Grid>

          <Typography variant="overline" color="text.secondary" fontWeight={800}>Typography</Typography>
          <Grid container spacing={1.5} sx={{ mb: 2, mt: 0.5 }}>
            <Grid item xs={7}>
              <TextField select label="Font family" size="small" fullWidth value={draft.config.styles.fontFamily}
                onChange={(e) => patchStyle({ fontFamily: e.target.value })}>
                <MenuItem value="'Segoe UI', Arial, sans-serif">Segoe UI</MenuItem>
                <MenuItem value="'Helvetica Neue', Arial, sans-serif">Helvetica</MenuItem>
                <MenuItem value="Georgia, 'Times New Roman', serif">Georgia (serif)</MenuItem>
                <MenuItem value="'Courier New', monospace">Courier (mono)</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={5}>
              <TextField label="Base font size (px)" size="small" type="number" fullWidth
                value={draft.config.styles.fontSizePx}
                onChange={(e) => patchStyle({ fontSizePx: parseFloat(e.target.value) || 12 })} />
            </Grid>
            <Grid item xs={6}>
              <TextField label="Accent colour" size="small" fullWidth value={draft.config.styles.accentColor}
                onChange={(e) => patchStyle({ accentColor: e.target.value })} />
            </Grid>
            <Grid item xs={6}>
              <TextField label="Line height" size="small" type="number" fullWidth
                value={draft.config.styles.lineHeight}
                onChange={(e) => patchStyle({ lineHeight: parseFloat(e.target.value) || 1.4 })} />
            </Grid>
          </Grid>

          <Typography variant="overline" color="text.secondary" fontWeight={800}>Sections</Typography>
          <Stack sx={{ mb: 2, mt: 0.5 }}>
            {draft.config.sections.map((s) => (
              <FormControlLabel key={s.id}
                control={<Switch size="small" checked={s.visible !== false}
                  onChange={(e) => setSection(s.id, (sec) => ({ ...sec, visible: e.target.checked }))} />}
                label={SECTION_LABELS[s.id] || s.id}
              />
            ))}
          </Stack>

          <Typography variant="overline" color="text.secondary" fontWeight={800}>Item columns</Typography>
          <Stack sx={{ mb: 2, mt: 0.5 }}>
            {(itemsSection?.config.columns || []).map((c, idx) => (
              <FormControlLabel key={c.key}
                control={<Switch size="small" checked={c.enabled}
                  onChange={(e) => setSection('items', (sec) => ({
                    ...sec,
                    config: {
                      ...sec.config,
                      columns: sec.config.columns.map((x, i) => (i === idx ? { ...x, enabled: e.target.checked } : x)),
                    },
                  }))} />}
                label={COLUMN_LABELS[c.key] || c.label}
              />
            ))}
          </Stack>

          <Typography variant="overline" color="text.secondary" fontWeight={800}>Totals rows</Typography>
          <Stack sx={{ mb: 1, mt: 0.5 }}>
            {Object.keys(TOTALS_ROW_LABELS).map((key) => {
              const on = (totalsSection?.config.rows || []).includes(key);
              return (
                <FormControlLabel key={key}
                  control={<Switch size="small" checked={on}
                    onChange={(e) => setSection('totals', (sec) => {
                      const rows = new Set(sec.config.rows || []);
                      if (e.target.checked) rows.add(key); else rows.delete(key);
                      return { ...sec, config: { ...sec.config, rows: Array.from(rows) } };
                    })} />}
                  label={TOTALS_ROW_LABELS[key]}
                />
              );
            })}
          </Stack>

          <Divider sx={{ my: 2 }} />
          <Typography variant="overline" color="text.secondary" fontWeight={800}>Footer text</Typography>
          <Stack spacing={1.5} sx={{ mt: 0.5 }}>
            <TextField label="Thank-you message" size="small" fullWidth
              value={draft.config.sections.find((s) => s.id === 'footer')?.config.thankYou || ''}
              onChange={(e) => setSection('footer', (sec) => ({ ...sec, config: { ...sec.config, thankYou: e.target.value } }))} />
            <TextField label="Terms & Conditions" size="small" fullWidth multiline minRows={2}
              value={draft.config.sections.find((s) => s.id === 'footer')?.config.terms || ''}
              onChange={(e) => setSection('footer', (sec) => ({ ...sec, config: { ...sec.config, terms: e.target.value } }))} />
          </Stack>
        </Box>

        {/* Live preview */}
        <Box sx={{ flex: 1, overflowY: 'auto', p: 3, bgcolor: '#eef2f7' }}>
          <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ display: 'block', mb: 1.5, textAlign: 'center' }}>
            LIVE PREVIEW · sample data · {draft.paper_size}
          </Typography>
          <BillPreview template={draft} model={model} maxWidth={620} />
        </Box>
      </DialogContent>

      <DialogActions sx={{ p: 2, bgcolor: '#f8fafc' }}>
        <Button onClick={onClose} color="inherit">Cancel</Button>
        <Button variant="contained" disabled={saving} onClick={() => onSave(draft)} sx={{ fontWeight: 800, px: 4 }}>
          {saving ? 'Saving…' : 'Save Template'}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
