// Shared "Print Label" options — every label print screen uses these, so the workflow is the
// same in Inventory → Products, Administration → Barcode Settings, Purchase Entry and
// Purchase → Barcode Printing:
//   LabelTemplateSelect — barcode template / type picker. Lists the visible templates (the
//                         default + any not hidden in Settings → Barcode Labels) with a
//                         "Show all templates" entry for the hidden ones.
//   SheetStartOptions   — "Fresh Sheet" / "Part Used Sheet" for EVERY template: pick the
//                         page, row and side the job starts at, so a part-used sheet / roll
//                         isn't wasted.
// Pure logic lives in labels/labelModel.js (startSkipFor, visibleTemplates, …).
import React, { useState } from 'react';
import {
  Box, Stack, TextField, MenuItem, ListSubheader, Typography, ToggleButtonGroup, ToggleButton, Chip,
} from '@mui/material';
import {
  LABEL_TYPES, labelTypeOf, startGrid, startSkipFor, MAX_START_PAGE, MAX_PAGE_ROWS, MAX_PAGE_COLS, startFromSkip, sheetSideLabels,
  visibleTemplates, hiddenCount, FRESH_START,
  PRINT_LAYOUT_MODES, applyStartPosition, printsAsSheet, sheetGrid, sheetFor, isJewelleryTemplate,
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

// Whole-number field with steppers (type="number", min 1). Never disabled / read-only: the
// typed text is kept as-is while editing (so it can be cleared and retyped), every valid
// number is committed clamped to [min, max], and on blur it shows the committed value.
function IntField({ label, value, min = 1, max, onChange, testId, width = 120, helperText }) {
  const [draft, setDraft] = useState(null);
  const typed = draft == null ? null : parseInt(draft, 10);
  const over = typed != null && !Number.isNaN(typed) && max != null && typed > max;
  return (
    <TextField
      size="small" type="number" label={label} value={draft ?? value} sx={{ width }}
      helperText={over ? `Max ${max}` : helperText} error={over}
      inputProps={{ min, max, step: 1, 'data-testid': testId }}
      onChange={(e) => {
        setDraft(e.target.value);
        const n = parseInt(e.target.value, 10);
        if (!Number.isNaN(n)) onChange(Math.min(max ?? n, Math.max(min, n)));
      }}
      onBlur={() => setDraft(null)}
    />
  );
}

// Print Layout Mode for this job — Multi-Label Sheet (A4 Grid) or Single Sticker /
// Thermal Roll. `template` is the template as printed (mode already applied); onChange(mode).
export function PrintLayoutModeSelect({ template, value, onChange }) {
  if (!template) return null;
  const grid = printsAsSheet(template) ? sheetGrid(template) : null;
  const sheet = grid ? sheetFor(template) : null;
  const short = grid && isJewelleryTemplate(template) && grid.perSheet < 38;
  return (
    <Box data-testid="print-layout-mode">
      <TextField select size="small" fullWidth label="Print Layout Mode" value={value || ''}
        onChange={(e) => onChange(e.target.value)} inputProps={{ 'data-testid': 'print-layout-mode-select' }}
      >
        {PRINT_LAYOUT_MODES.map((m) => <MenuItem key={m.id} value={m.id}>{m.label}</MenuItem>)}
      </TextField>
      <Typography variant="caption" color={short ? 'warning.main' : 'text.secondary'} component="div" sx={{ mt: 0.5 }} data-testid="print-layout-mode-info">
        {grid
          ? `${grid.perSheet} labels per A4 page (${grid.cols} across × ${grid.rows} down), printed together — a new page only when the sheet is full.`
            + (short ? ` 38 labels of ${template.width_mm} × ${template.height_mm} mm don't fit on A4.` : '')
            + (sheet && !template.layout?.sheet ? ' Grid set automatically; adjust it in Settings → Barcode Labels.' : '')
          : `Each ${template.width_mm} × ${template.height_mm} mm sticker prints on its own page (thermal roll printer).`}
      </Typography>
    </Box>
  );
}

// value / onChange: { enabled, page, row, col, pageRows?, pageCols? } (labelModel FRESH_START).
// Shown for every template — standard, optical and jewellery, A4 sheets and thermal rolls,
// built-in defaults and saved designs. Start page, row and column are always editable; a
// thermal template also gets its page layout (rows x columns per page) so row / column mean
// something on a tag sheet or strip.
export function SheetStartOptions({ template, value = FRESH_START, onChange }) {
  const grid = startGrid(template, value);
  if (!grid) return null;
  const { rows, cols, perSheet, thermal } = grid;
  const skip = startSkipFor(template, value);
  const sides = sheetSideLabels(cols);
  const layoutKeep = thermal ? { pageRows: rows, pageCols: cols } : {};
  const set = (patch) => onChange({ ...FRESH_START, ...value, ...patch });
  // Start position typed / clicked: anything past page 1, row 1, column 1 is a Part Used
  // Sheet; back to 1 / 1 / 1 is a Fresh Sheet again. On a thermal roll / strip a row or
  // column beyond the current page layout grows the layout instead of being refused.
  const setPos = (patch) => onChange(applyStartPosition(template, value, patch));
  const page = Math.min(Math.max(1, parseInt(value.page, 10) || 1), MAX_START_PAGE);
  const row = Math.min(Math.max(1, parseInt(value.row, 10) || 1), rows);
  const col = Math.min(Math.max(1, parseInt(value.col, 10) || 1), cols);
  const inPage = skip % perSheet;

  return (
    <Box data-testid="sheet-start-options">
      <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
        <Typography variant="subtitle2" fontWeight={700}>Sheet</Typography>
        <ToggleButtonGroup exclusive size="small" value={value.enabled ? 'on' : 'off'}
          onChange={(e, v) => v && (v === 'on' ? set({ enabled: true, ...layoutKeep }) : onChange({ ...FRESH_START, ...layoutKeep }))}
        >
          <ToggleButton value="off" data-testid="sheet-start-fresh">Fresh Sheet</ToggleButton>
          <ToggleButton value="on" data-testid="sheet-start-used">Part Used Sheet</ToggleButton>
        </ToggleButtonGroup>
      </Stack>
      {thermal && value.enabled && (
        <Stack direction="row" spacing={1.5} sx={{ mt: 1.25 }} flexWrap="wrap" useFlexGap alignItems="center">
          <IntField label="Rows per page" value={rows} max={MAX_PAGE_ROWS} testId="sheet-page-rows" onChange={(n) => set({ pageRows: n, pageCols: cols })} />
          <IntField label="Columns per page" value={cols} max={MAX_PAGE_COLS} testId="sheet-page-cols" width={140} onChange={(n) => set({ pageCols: n, pageRows: rows })} />
          <Typography variant="caption" color="text.secondary">Layout of your label sheet / strip</Typography>
        </Stack>
      )}
      <Stack direction="row" spacing={1.5} sx={{ mt: 1.25 }} flexWrap="wrap" useFlexGap>
        <IntField label="Start page" value={page} max={MAX_START_PAGE} testId="sheet-start-page" onChange={(n) => setPos({ page: n })} />
        <IntField label={thermal ? 'Start row' : `Start row (1–${rows})`} value={row} max={thermal ? MAX_PAGE_ROWS : rows} testId="sheet-start-row" onChange={(n) => setPos({ row: n })} />
        <IntField label={thermal ? 'Start column' : `Start column (1–${cols})`} value={col} max={thermal ? MAX_PAGE_COLS : cols} testId="sheet-start-col" width={150} onChange={(n) => setPos({ col: n })} />
        <TextField
          size="small" type="number" label="Labels already used" value={skip} sx={{ width: 160 }}
          inputProps={{ min: 0, max: MAX_START_PAGE * perSheet - 1, 'data-testid': 'sheet-start-used-count' }}
          onChange={(e) => onChange(startFromSkip(template, e.target.value, { ...value, ...layoutKeep }))}
        />
      </Stack>
      <StartGrid rows={rows} cols={cols} skip={inPage} onPick={(i) => setPos({ page, row: Math.floor(i / cols) + 1, col: (i % cols) + 1 })} />
      <Typography variant="caption" color="text.secondary" component="div" data-testid="sheet-start-summary">
        {!value.enabled
          ? 'Fresh sheet — printing starts at page 1, row 1, column 1. Type a start row / column (or click a cell) for a part used sheet.'
          : <>Printing starts on page {page}, row {row}, column {col}{cols > 1 && cols <= 3 ? ` (${sides[col - 1].toLowerCase()})` : ''} — {skip} used label{skip === 1 ? '' : 's'} skipped.</>}
        {!value.enabled ? '' : thermal
          ? ` On this thermal printer the ${skip} used label${skip === 1 ? ' is' : 's are'} fed through blank.`
          : (page > 1 ? ` ${page - 1} blank sheet${page === 2 ? '' : 's'} come out first.` : '')}
        {value.enabled ? ' Click a cell to change.' : ''}
      </Typography>
    </Box>
  );
}
