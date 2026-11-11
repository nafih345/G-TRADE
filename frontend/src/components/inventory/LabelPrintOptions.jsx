// Shared "Print Label" options — every label print screen uses these, so the workflow is the
// same in Inventory → Products, Administration → Barcode Settings, Purchase Entry and
// Purchase → Barcode Printing:
//   LabelTemplateSelect — barcode template / type picker. Lists the visible templates (the
//                         default + any not hidden in Settings → Barcode Labels) with a
//                         "Show all templates" entry for the hidden ones.
//   SheetStartOptions   — "Past Used Sheet": for jewellery labels (and any A4 sheet) pick the
//                         row and side the job starts at, so a part-used sheet isn't wasted.
// Pure logic lives in labels/labelModel.js (startSkipFor, visibleTemplates, …).
import React, { useState } from 'react';
import {
  Box, Stack, TextField, MenuItem, ListSubheader, Typography, ToggleButtonGroup, ToggleButton, Alert, Chip,
} from '@mui/material';
import {
  LABEL_TYPES, labelTypeOf, isJewelleryTemplate, sheetGrid, startSkipFor, startFromSkip, sheetSideLabels,
  visibleTemplates, hiddenCount, FRESH_START,
} from '../../labels/labelModel';

const SHOW_ALL = '__show_all_templates';
const typeLabel = (t) => LABEL_TYPES.find((x) => x.id === labelTypeOf(t))?.label || 'Standard';

export function templateCaption(t) {
  return `${t.width_mm} × ${t.height_mm} mm${t.printer_type === 'a4' ? ' (A4)' : ''}`;
}

// designOption: optional { value, label } listed first (the designer's unsaved design).
// keepIds: template ids that must stay listed even when hidden (e.g. a workflow's assigned one).
export function LabelTemplateSelect({
  templates, value, onChange, keepIds = [], designOption, label = 'Barcode template / type', showVersion = false, sx, inputProps, fullWidth,
}) {
  const [showAll, setShowAll] = useState(false);
  const list = visibleTemplates(templates, { showAll, keepIds: [value, ...keepIds] });
  const hidden = hiddenCount(templates);
  const groups = LABEL_TYPES.map((g) => ({ ...g, items: list.filter((t) => labelTypeOf(t) === g.id) })).filter((g) => g.items.length);
  const grouped = groups.length > 1;

  return (
    <TextField
      select size="small" label={label} value={value || ''} sx={sx} inputProps={inputProps} fullWidth={fullWidth}
      onChange={(e) => {
        if (e.target.value === SHOW_ALL) { setShowAll((v) => !v); return; }
        onChange(e.target.value);
      }}
      SelectProps={{ renderValue: (v) => {
        if (designOption && v === designOption.value) return designOption.label;
        const t = (templates || []).find((x) => x.id === v);
        return t ? `${t.is_default ? '★ ' : ''}${t.name} — ${templateCaption(t)}` : '';
      } }}
    >
      {designOption && <MenuItem value={designOption.value}>{designOption.label}</MenuItem>}
      {designOption && <ListSubheader>Saved templates</ListSubheader>}
      {groups.flatMap((g) => [
        grouped ? <ListSubheader key={`h-${g.id}`}>{g.label}</ListSubheader> : null,
        ...g.items.map((t) => (
          <MenuItem key={t.id} value={t.id}>
            {t.is_default ? '★ ' : ''}{t.name}
            <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
              {templateCaption(t)}{showVersion ? ` · v${t.version}` : ''}{!grouped ? ` · ${typeLabel(t)}` : ''}
            </Typography>
            {t.is_hidden && !t.is_default && <Chip size="small" label="hidden" variant="outlined" sx={{ ml: 1, height: 18 }} />}
          </MenuItem>
        )),
      ])}
      {hidden > 0 && (
        <MenuItem value={SHOW_ALL} sx={{ color: 'primary.main', fontWeight: 600, borderTop: '1px solid', borderColor: 'divider' }} data-testid="templates-show-all">
          {showAll ? 'Show only visible templates' : `Show all barcode templates (${hidden} hidden)`}
        </MenuItem>
      )}
    </TextField>
  );
}

function StartGrid({ rows, cols, skip, onPick }) {
  if (!rows || !cols || rows * cols > 260) return null;
  return (
    <Box sx={{ display: 'grid', gap: '3px', my: 1, gridTemplateColumns: `repeat(${cols}, ${cols <= 3 ? 40 : 15}px)` }} data-testid="sheet-start-grid">
      {Array.from({ length: rows * cols }, (_, i) => (
        <Box
          key={i} role="button" title={`Start here (row ${Math.floor(i / cols) + 1}, ${sheetSideLabels(cols)[i % cols]})`}
          onClick={() => onPick(i)}
          sx={{
            height: 11, borderRadius: '2px', border: '1px solid', cursor: 'pointer',
            borderColor: i === skip ? 'primary.main' : i < skip ? 'transparent' : 'divider',
            bgcolor: i === skip ? 'primary.main' : i < skip ? 'action.disabledBackground' : 'transparent',
            '&:hover': { borderColor: 'primary.light' },
          }}
        />
      ))}
    </Box>
  );
}

// value / onChange: { enabled, row, col } (labels/labelModel FRESH_START).
// Shown for jewellery templates (as "Past Used Sheet" with a side picker) and for any A4
// sheet (as "Start position"); a jewellery thermal roll just explains why it doesn't apply.
export function SheetStartOptions({ template, value = FRESH_START, onChange }) {
  const jewellery = isJewelleryTemplate(template);
  const grid = sheetGrid(template);
  if (!template || (!jewellery && !grid)) return null;
  if (!grid) {
    return (
      <Alert severity="info" icon={false} sx={{ py: 0.5, fontSize: 13 }} data-testid="sheet-start-roll">
        <b>Past Used Sheet</b> — “{template.name}” prints on a thermal roll, which always continues from the next tag.
        Pick a jewellery A4 sheet template to start part-way down a used sheet.
      </Alert>
    );
  }
  const { rows, cols, perSheet } = grid;
  const skip = startSkipFor(template, value);
  const sides = sheetSideLabels(cols);
  const set = (patch) => onChange({ ...value, ...patch });
  const row = Math.min(value.row, rows);
  const col = Math.min(value.col, cols);

  return (
    <Box data-testid="sheet-start-options">
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" fontWeight={700}>{jewellery ? 'Past Used Sheet' : 'Start position'}</Typography>
        <ToggleButtonGroup exclusive size="small" value={value.enabled ? 'on' : 'off'} onChange={(e, v) => v && set({ enabled: v === 'on' })}>
          <ToggleButton value="off" data-testid="sheet-start-fresh">Fresh sheet</ToggleButton>
          <ToggleButton value="on" data-testid="sheet-start-used">Past used sheet</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {value.enabled && (
        <>
          <Stack direction="row" spacing={1.5} sx={{ mt: 1.25 }} flexWrap="wrap" useFlexGap>
            <TextField select size="small" label="Start row" value={row} onChange={(e) => set({ row: Number(e.target.value) })} sx={{ width: 110 }} inputProps={{ 'data-testid': 'sheet-start-row' }}>
              {Array.from({ length: rows }, (_, i) => <MenuItem key={i} value={i + 1}>{i + 1}</MenuItem>)}
            </TextField>
            <TextField select size="small" label={cols <= 3 ? 'Side' : 'Column'} value={col} onChange={(e) => set({ col: Number(e.target.value) })} sx={{ width: 150 }} inputProps={{ 'data-testid': 'sheet-start-side' }}>
              {sides.map((s, i) => <MenuItem key={i} value={i + 1}>{s}</MenuItem>)}
            </TextField>
            <TextField
              size="small" type="number" label="Labels already used" value={skip} sx={{ width: 160 }}
              inputProps={{ min: 0, max: perSheet - 1, 'data-testid': 'sheet-start-used-count' }}
              onChange={(e) => onChange({ ...startFromSkip(template, e.target.value), enabled: true })}
            />
          </Stack>
          <StartGrid rows={rows} cols={cols} skip={skip} onPick={(i) => onChange({ ...startFromSkip(template, i), enabled: true })} />
          <Typography variant="caption" color="text.secondary" data-testid="sheet-start-summary">
            Printing starts at row {row}, {sides[col - 1].toLowerCase()} — {skip} used label{skip === 1 ? '' : 's'} skipped. Click a cell to change.
          </Typography>
        </>
      )}
    </Box>
  );
}
