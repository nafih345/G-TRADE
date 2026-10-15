// Settings → Barcode Labels → Printing & Defaults: which template each workflow prints
// with, printer names, calibration (offset / scale / dpi), default copies, the unique
// per-label barcode series, plus test / calibration prints and browser setup help.
import React, { useEffect, useState } from 'react';
import {
  Box, Stack, Typography, TextField, MenuItem, Button, Alert, Checkbox, FormControlLabel, Divider, Grid, Paper,
} from '@mui/material';
import { Save, Science, KeyboardDoubleArrowDown } from '@mui/icons-material';
import { NumField } from './PropertiesPanel';
import { WORKFLOWS } from '../../../labels/useLabelBundle';
import { savePrintSettings, apiError } from '../../../labels/labelApi';
import { printCalibration, feedOneLabel } from '../../../labels/printLabels';
import { notify } from '../../../utils/notify';

const EDITABLE = ['inventory_template', 'purchase_template', 'barcode_printing_template', 'thermal_printer_name', 'a4_printer_name',
  'h_offset_mm', 'v_offset_mm', 'print_scale_percent', 'default_copies', 'printer_dpi', 'unique_label_series'];

export default function LabelPrintingPanel({ bundle, setBundle }) {
  const templates = bundle?.templates || [];
  const canDesign = bundle?.fields ? !!bundle.fields.can_design : true;
  const [form, setForm] = useState({});
  const [busy, setBusy] = useState(false);
  const [testId, setTestId] = useState('');

  useEffect(() => {
    const s = bundle?.settings || {};
    setForm(Object.fromEntries(EDITABLE.map((k) => [k, s[k] ?? (k.endsWith('_template') ? null : '')])));
  }, [bundle?.settings]);

  const defaultTpl = templates.find((t) => t.is_default) || templates[0];
  const testTemplate = templates.find((t) => t.id === testId) || templates.find((t) => t.id === form.inventory_template) || defaultTpl;
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const dirty = EDITABLE.some((k) => String(form[k] ?? '') !== String(bundle?.settings?.[k] ?? ''));

  const save = async () => {
    setBusy(true);
    try {
      const saved = await savePrintSettings(form);
      setBundle((b) => ({ ...b, settings: saved }));
      notify('Label printing settings saved.', 'success');
    } catch (err) {
      notify(apiError(err, 'Could not save printing settings.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const liveSettings = { ...(bundle?.settings || {}), ...form };

  return (
    <Grid container spacing={3}>
      <Grid item xs={12} md={7}>
        <Stack spacing={2.5}>
          <Box>
            <Typography variant="subtitle1" fontWeight={800}>Template per workflow</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              Each Print button opens with this template (it can still be switched per print). “Default label” = the ★ template.
            </Typography>
            <Stack spacing={1.5}>
              {WORKFLOWS.map((w) => (
                <TextField key={w.id} select size="small" label={w.label} value={form[w.key] || ''} onChange={(e) => set(w.key, e.target.value || null)} disabled={!canDesign}>
                  <MenuItem value="">Default label ({defaultTpl?.name || '—'})</MenuItem>
                  {templates.map((t) => <MenuItem key={t.id} value={t.id}>{t.name} — {t.width_mm} × {t.height_mm} mm</MenuItem>)}
                </TextField>
              ))}
            </Stack>
          </Box>
          <Divider />
          <Box>
            <Typography variant="subtitle1" fontWeight={800}>Printers</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              Browsers don’t let a web page pick the printer — these names are shown in the print dialog so staff choose the right one.
            </Typography>
            <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
              <TextField size="small" fullWidth label="Thermal label printer" placeholder="e.g. TSC TE244 / Xprinter XP-365B" value={form.thermal_printer_name || ''} onChange={(e) => set('thermal_printer_name', e.target.value)} disabled={!canDesign} />
              <TextField size="small" fullWidth label="A4 sheet printer" placeholder="e.g. HP LaserJet M1136" value={form.a4_printer_name || ''} onChange={(e) => set('a4_printer_name', e.target.value)} disabled={!canDesign} />
            </Stack>
          </Box>
          <Divider />
          <Box>
            <Typography variant="subtitle1" fontWeight={800}>Calibration</Typography>
            <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
              Moves or scales the print on the stock without changing any design. Print a calibration label, measure it, then adjust.
            </Typography>
            <Stack spacing={1.5}>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <NumField label="Horizontal offset" unit="mm" value={form.h_offset_mm} min={-20} max={20} step={0.25} onChange={(v) => set('h_offset_mm', v)} disabled={!canDesign} helperText="+ moves right" />
                <NumField label="Vertical offset" unit="mm" value={form.v_offset_mm} min={-20} max={20} step={0.25} onChange={(v) => set('v_offset_mm', v)} disabled={!canDesign} helperText="+ moves down" />
                <NumField label="Print scale" unit="%" value={form.print_scale_percent} min={50} max={150} step={0.5} onChange={(v) => set('print_scale_percent', v)} disabled={!canDesign} helperText={Number(form.print_scale_percent) !== 100 ? 'Not 100 %: bar widths stop matching whole printer dots — fix driver scaling instead if you can' : '100 = exact size'} />
              </Stack>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField select size="small" fullWidth label="Thermal printer resolution" value={form.printer_dpi ?? 203} onChange={(e) => set('printer_dpi', Number(e.target.value))} disabled={!canDesign}
                  helperText="Barcode bars snap to whole printer dots so they print evenly."
                >
                  <MenuItem value={203}>203 dpi (most label printers)</MenuItem>
                  <MenuItem value={300}>300 dpi</MenuItem>
                  <MenuItem value={600}>600 dpi</MenuItem>
                  <MenuItem value={0}>Don’t snap</MenuItem>
                </TextField>
                <NumField label="Default quantity per product" value={form.default_copies} min={1} max={500} step={1} onChange={(v) => set('default_copies', Math.round(v))} disabled={!canDesign} />
              </Stack>
              <FormControlLabel
                control={<Checkbox checked={form.unique_label_series !== false} onChange={(e) => set('unique_label_series', e.target.checked)} disabled={!canDesign} />}
                label={<Typography variant="body2">Give every printed label its own scannable code (saved against the product, so each one still scans back to it)</Typography>}
              />
            </Stack>
          </Box>
          <Stack direction="row" spacing={1}>
            <Button variant="contained" startIcon={<Save />} onClick={save} disabled={!dirty || busy || !canDesign} data-testid="save-print-settings">Save printing settings</Button>
          </Stack>
        </Stack>
      </Grid>

      <Grid item xs={12} md={5}>
        <Paper variant="outlined" sx={{ p: 2 }}>
          <Typography variant="subtitle1" fontWeight={800} gutterBottom>Test & calibrate</Typography>
          <TextField select size="small" fullWidth label="Template to test" value={testTemplate?.id || ''} onChange={(e) => setTestId(e.target.value)} sx={{ mb: 1.5 }}>
            {templates.map((t) => <MenuItem key={t.id} value={t.id}>{t.name}</MenuItem>)}
          </TextField>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
            <Button variant="outlined" startIcon={<Science />} disabled={!testTemplate} onClick={() => printCalibration(testTemplate, liveSettings)}>
              {testTemplate?.printer_type === 'a4' ? 'Print alignment grid' : 'Print calibration label'}
            </Button>
            {testTemplate?.printer_type !== 'a4' && (
              <Button variant="outlined" startIcon={<KeyboardDoubleArrowDown />} disabled={!testTemplate} onClick={() => feedOneLabel(testTemplate, liveSettings)}>Feed one label</Button>
            )}
          </Stack>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
            Uses the values on the left (even before saving) so you can tune and re-print.
          </Typography>
          <Alert severity="info" sx={{ mt: 2 }}>
            <b>Keep the physical size exact.</b> In the browser print dialog:
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>Destination: your label printer{form.thermal_printer_name ? ` (${form.thermal_printer_name})` : ''}.</li>
              <li><b>Margins: None</b> and <b>Scale: 100 / Default</b> — never “Fit to page”.</li>
              <li>Turn <b>off</b> “Headers and footers”.</li>
              <li>Thermal: in the printer driver set the paper to the label size (e.g. 38 × 25 mm) and media to <i>gap/die-cut</i>.</li>
            </ul>
            A 38 mm calibration label that measures 37 mm means scaling is on — fix it in the dialog first; use Print scale only for what remains.
          </Alert>
        </Paper>
      </Grid>
    </Grid>
  );
}
