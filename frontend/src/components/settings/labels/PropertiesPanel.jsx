// Right panel of the label designer: label-level settings when nothing is selected,
// otherwise the selected element's position, data binding and styling.
import React, { useEffect, useState } from 'react';
import {
  Box, Stack, Typography, TextField, MenuItem, ToggleButtonGroup, ToggleButton, Checkbox,
  FormControlLabel, Divider, InputAdornment, Tooltip, IconButton, ListSubheader, Alert, Button,
} from '@mui/material';
import {
  FormatAlignLeft, FormatAlignCenter, FormatAlignRight, VerticalAlignTop, VerticalAlignCenter,
  VerticalAlignBottom, FormatBold, FormatItalic, Lock, LockOpen, Visibility, VisibilityOff,
  AlignHorizontalLeft, AlignHorizontalCenter, AlignHorizontalRight, AlignVerticalTop,
  AlignVerticalCenter, AlignVerticalBottom, DeleteOutline,
} from '@mui/icons-material';
import { FIELD_GROUPS, LABEL_FIELDS, FIELD_BY_ID } from '../../../labels/labelFields';
import { planBarcode, moduleWidthOptions, minSafeModuleMm, RECOMMENDED_MODULE_MM } from '../../../labels/renderLabel';
import {
  BARCODE_FORMATS, FONT_FAMILIES, THERMAL_PRESET_SIZES, A4_SHEET_PRESETS, elementTitle, sheetUsage, r2,
} from '../../../labels/labelModel';

// Numeric input that lets the user type freely ("1.", "-") and commits parsed numbers.
export function NumField({ value, onChange, min, max, step = 0.1, unit, label, width, disabled, helperText }) {
  const [text, setText] = useState(String(value ?? ''));
  const [focused, setFocused] = useState(false);
  useEffect(() => { if (!focused) setText(String(value ?? '')); }, [value, focused]);
  const commit = (raw) => {
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    const c = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
    onChange(Math.round(c * 1000) / 1000);
  };
  return (
    <TextField
      size="small" label={label} value={text} disabled={disabled} helperText={helperText}
      type="number" inputProps={{ step, min, max }}
      onFocus={() => setFocused(true)}
      onBlur={() => { setFocused(false); commit(text); }}
      onChange={(e) => { setText(e.target.value); commit(e.target.value); }}
      InputProps={unit ? { endAdornment: <InputAdornment position="end">{unit}</InputAdornment> } : undefined}
      sx={{ width: width || '100%' }}
    />
  );
}

const Row = ({ children }) => <Stack direction="row" spacing={1}>{children}</Stack>;
const H = ({ children }) => <Typography variant="overline" color="text.secondary" sx={{ display: 'block', lineHeight: 2 }}>{children}</Typography>;

function TypographyControls({ style, onStyle }) {
  const s = style;
  return (
    <Stack spacing={1.25}>
      <H>Typography</H>
      <Row>
        <TextField select size="small" label="Font" value={s.fontFamily} onChange={(e) => onStyle({ fontFamily: e.target.value })} sx={{ flex: 1 }}>
          {FONT_FAMILIES.map((f) => <MenuItem key={f} value={f} sx={{ fontFamily: f }}>{f}</MenuItem>)}
        </TextField>
        <NumField label="Size" unit="pt" value={s.fontSizePt} min={3} max={72} step={0.5} onChange={(v) => onStyle({ fontSizePt: v })} width={96} />
      </Row>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <ToggleButtonGroup size="small" exclusive value={s.align} onChange={(e, v) => v && onStyle({ align: v })}>
          <ToggleButton value="left"><FormatAlignLeft fontSize="small" /></ToggleButton>
          <ToggleButton value="center"><FormatAlignCenter fontSize="small" /></ToggleButton>
          <ToggleButton value="right"><FormatAlignRight fontSize="small" /></ToggleButton>
        </ToggleButtonGroup>
        <ToggleButtonGroup size="small" exclusive value={s.vAlign} onChange={(e, v) => v && onStyle({ vAlign: v })}>
          <ToggleButton value="top"><VerticalAlignTop fontSize="small" /></ToggleButton>
          <ToggleButton value="middle"><VerticalAlignCenter fontSize="small" /></ToggleButton>
          <ToggleButton value="bottom"><VerticalAlignBottom fontSize="small" /></ToggleButton>
        </ToggleButtonGroup>
        <ToggleButton size="small" value="b" selected={s.fontWeight >= 700} onChange={() => onStyle({ fontWeight: s.fontWeight >= 700 ? 400 : 700 })}><FormatBold fontSize="small" /></ToggleButton>
        <ToggleButton size="small" value="i" selected={!!s.italic} onChange={() => onStyle({ italic: !s.italic })}><FormatItalic fontSize="small" /></ToggleButton>
      </Stack>
      <Row>
        <TextField select size="small" label="Weight" value={s.fontWeight} onChange={(e) => onStyle({ fontWeight: Number(e.target.value) })} sx={{ flex: 1 }}>
          {[[400, 'Regular'], [600, 'Semi-bold'], [700, 'Bold'], [800, 'Extra bold']].map(([v, l]) => <MenuItem key={v} value={v}>{l}</MenuItem>)}
        </TextField>
        <NumField label="Spacing" unit="mm" value={s.letterSpacingMm} min={-1} max={3} step={0.05} onChange={(v) => onStyle({ letterSpacingMm: v })} width={110} />
      </Row>
      <Row>
        <TextField
          select size="small" label="When text is too long" value={s.overflow} sx={{ flex: 1 }}
          onChange={(e) => onStyle({ overflow: e.target.value })}
        >
          <MenuItem value="ellipsis">Cut with …</MenuItem>
          <MenuItem value="wrap">Wrap to lines</MenuItem>
          <MenuItem value="shrink">Shrink to fit</MenuItem>
          <MenuItem value="clip">Clip</MenuItem>
        </TextField>
        {s.overflow === 'wrap' && <NumField label="Max lines" value={s.maxLines} min={1} max={10} step={1} onChange={(v) => onStyle({ maxLines: Math.round(v) })} width={96} />}
      </Row>
      <Stack direction="row" spacing={1} alignItems="center">
        <TextField size="small" type="color" label="Colour" value={s.color} onChange={(e) => onStyle({ color: e.target.value })} sx={{ width: 90 }} />
        <FormControlLabel control={<Checkbox size="small" checked={!!s.uppercase} onChange={(e) => onStyle({ uppercase: e.target.checked })} />} label="CAPS" />
        <Tooltip title="White text on a solid background — e.g. a black price band.">
          <FormControlLabel control={<Checkbox size="small" checked={!!s.invert} onChange={(e) => onStyle({ invert: e.target.checked })} />} label="Reverse" />
        </Tooltip>
      </Stack>
    </Stack>
  );
}

function FieldSelect({ label, value, onChange, allowedFields, includeNone }) {
  return (
    <TextField select size="small" fullWidth label={label} value={value || ''} onChange={(e) => onChange(e.target.value)}>
      {includeNone && <MenuItem value="">—</MenuItem>}
      {FIELD_GROUPS.flatMap((g) => [
        <ListSubheader key={`h-${g.id}`}>{g.label}</ListSubheader>,
        ...LABEL_FIELDS.filter((f) => f.group === g.id).map((f) => (
          <MenuItem key={f.id} value={f.id} disabled={!allowedFields.has(f.id)}>
            {f.label}{f.restricted ? ' 🔒' : ''}
          </MenuItem>
        )),
      ])}
    </TextField>
  );
}

function LabelSettings({ template, onTemplate, onResize }) {
  const isA4 = template.printer_type === 'a4';
  const L = template.layout;
  const sheet = L.sheet || {};
  const usage = isA4 ? sheetUsage(template) : null;
  const setLayout = (patch) => onTemplate((t) => ({ ...t, layout: { ...t.layout, ...patch } }));
  const setSheet = (patch) => setLayout({ sheet: { ...sheet, ...patch } });
  const [scaleWithSize, setScaleWithSize] = useState(true);
  const sizeKey = `${template.width_mm}x${template.height_mm}`;

  return (
    <Stack spacing={1.5}>
      <H>Label</H>
      <TextField size="small" label="Template name" value={template.name} onChange={(e) => onTemplate((t) => ({ ...t, name: e.target.value }), 'name')} />
      <TextField size="small" label="Description (optional)" value={template.description || ''} onChange={(e) => onTemplate((t) => ({ ...t, description: e.target.value }), 'desc')} />
      <ToggleButtonGroup
        exclusive size="small" fullWidth value={template.printer_type}
        onChange={(e, v) => {
          if (!v) return;
          onTemplate((t) => ({
            ...t, printer_type: v,
            layout: { ...t.layout, sheet: v === 'a4' ? { ...A4_SHEET_PRESETS[0].sheet, ...(t.layout.sheet || {}) } : undefined },
          }));
        }}
      >
        <ToggleButton value="thermal">Thermal roll</ToggleButton>
        <ToggleButton value="a4">A4 sheet</ToggleButton>
      </ToggleButtonGroup>

      {!isA4 ? (
        <TextField
          select size="small" label="Common sizes" value={THERMAL_PRESET_SIZES.some((p) => `${p.w}x${p.h}` === sizeKey) ? sizeKey : 'custom'}
          onChange={(e) => { const p = THERMAL_PRESET_SIZES.find((x) => `${x.w}x${x.h}` === e.target.value); if (p) onResize(p.w, p.h, scaleWithSize); }}
        >
          {THERMAL_PRESET_SIZES.map((p) => <MenuItem key={`${p.w}x${p.h}`} value={`${p.w}x${p.h}`}>{p.w} × {p.h} mm</MenuItem>)}
          <MenuItem value="custom" disabled>Custom size</MenuItem>
        </TextField>
      ) : (
        <TextField
          select size="small" label="Sheet presets" value={A4_SHEET_PRESETS.find((p) => p.w === template.width_mm && p.h === template.height_mm && p.sheet.cols === sheet.cols && p.sheet.rows === sheet.rows)?.id || 'custom'}
          onChange={(e) => {
            const p = A4_SHEET_PRESETS.find((x) => x.id === e.target.value);
            if (!p) return;
            onResize(p.w, p.h, scaleWithSize);
            onTemplate((t) => ({ ...t, layout: { ...t.layout, sheet: { ...p.sheet } } }));
          }}
        >
          {A4_SHEET_PRESETS.map((p) => <MenuItem key={p.id} value={p.id}>{p.label}</MenuItem>)}
          <MenuItem value="custom" disabled>Custom sheet</MenuItem>
        </TextField>
      )}
      <Row>
        <NumField label="Width" unit="mm" value={template.width_mm} min={10} max={200} onChange={(v) => onResize(v, template.height_mm, scaleWithSize)} />
        <NumField label="Height" unit="mm" value={template.height_mm} min={5} max={300} onChange={(v) => onResize(template.width_mm, v, scaleWithSize)} />
      </Row>
      <FormControlLabel control={<Checkbox size="small" checked={scaleWithSize} onChange={(e) => setScaleWithSize(e.target.checked)} />} label={<Typography variant="body2">Scale elements when the size changes</Typography>} />
      <Row>
        <NumField label="Safe margin" unit="mm" value={L.paddingMm} min={0} max={10} onChange={(v) => setLayout({ paddingMm: v })} helperText="Red dashed guide" />
        {!isA4 && <NumField label="Gap between labels" unit="mm" value={L.gapMm} min={0} max={30} onChange={(v) => setLayout({ gapMm: v })} helperText="Die-cut liner gap" />}
      </Row>
      {isA4 && (
        <>
          <H>A4 sheet layout</H>
          <Row>
            <NumField label="Columns" value={sheet.cols} min={1} max={20} step={1} onChange={(v) => setSheet({ cols: Math.round(v) })} />
            <NumField label="Rows" value={sheet.rows} min={1} max={60} step={1} onChange={(v) => setSheet({ rows: Math.round(v) })} />
          </Row>
          <Row>
            <NumField label="Top margin" unit="mm" value={sheet.marginTopMm} min={0} max={60} onChange={(v) => setSheet({ marginTopMm: v })} />
            <NumField label="Left margin" unit="mm" value={sheet.marginLeftMm} min={0} max={60} onChange={(v) => setSheet({ marginLeftMm: v })} />
          </Row>
          <Row>
            <NumField label="Column gap" unit="mm" value={sheet.colGapMm} min={0} max={40} onChange={(v) => setSheet({ colGapMm: v })} />
            <NumField label="Row gap" unit="mm" value={sheet.rowGapMm} min={0} max={40} onChange={(v) => setSheet({ rowGapMm: v })} />
          </Row>
          <Typography variant="caption" color={usage.usedW > 210.5 || usage.usedH > 297.5 ? 'error' : 'text.secondary'}>
            {usage.perSheet} labels per sheet · uses {r2(usage.usedW)} × {r2(usage.usedH)} mm of 210 × 297 mm
          </Typography>
        </>
      )}
      <H>Barcode</H>
      <TextField select size="small" label="Barcode format" value={L.defaultBarcodeFormat} onChange={(e) => setLayout({ defaultBarcodeFormat: e.target.value })}
        helperText={BARCODE_FORMATS.find((b) => b.id === L.defaultBarcodeFormat)?.hint}
      >
        {BARCODE_FORMATS.map((b) => <MenuItem key={b.id} value={b.id}>{b.label}</MenuItem>)}
      </TextField>
      <Typography variant="caption" color="text.secondary">Click an element on the label to edit it. Shift-click selects several.</Typography>
    </Stack>
  );
}

// Bar width picker + live physical readout for the preview product's actual code.
function BarcodeSizing({ el, template, setBarcode, dpi, previewData }) {
  const b = el.barcode;
  const fmt = b.format === 'inherit' ? template.layout.defaultBarcodeFormat : b.format;
  const value = el.field === 'sku' ? previewData?.sku : previewData?.barcode;
  const rotated = el.rotation === 90 || el.rotation === 270;
  const boxW = rotated ? el.h : el.w;
  const plan = value ? planBarcode({ value, format: fmt, boxW, barcode: b, dpi }) : null;
  const options = moduleWidthOptions(dpi);
  const dot = dpi > 0 ? 25.4 / dpi : 0;
  const custom = b.moduleMm > 0 && !options.some((o) => Math.abs(o - b.moduleMm) < 0.002);
  const [customMode, setCustomMode] = useState(custom);
  const selectValue = customMode || custom ? 'custom' : b.moduleMm > 0 ? String(options.find((o) => Math.abs(o - b.moduleMm) < 0.002)) : 'auto';
  const f2 = (n) => (Math.round(n * 100) / 100).toFixed(2);
  const optLabel = (o) => `${Math.round(o * 1000) / 1000} mm${dot ? ` — ${Math.round(o / dot)} dots` : ''}${o >= RECOMMENDED_MODULE_MM[0] - 0.002 && o <= RECOMMENDED_MODULE_MM[1] + 0.002 ? ' (recommended)' : ''}`;
  return (
    <Stack spacing={1}>
      <Row>
        <TextField
          select size="small" label="Bar width (narrowest bar)" value={selectValue} sx={{ flex: 1 }}
          onChange={(e) => {
            const v = e.target.value;
            if (v === 'custom') { setCustomMode(true); if (!(b.moduleMm > 0)) setBarcode({ moduleMm: RECOMMENDED_MODULE_MM[0] }); return; }
            setCustomMode(false);
            setBarcode({ moduleMm: v === 'auto' ? 0 : Number(v) });
          }}
          inputProps={{ 'data-testid': 'bar-width-select' }}
        >
          <MenuItem value="auto">Auto — widest that fits (min {f2(minSafeModuleMm(dpi))} mm)</MenuItem>
          {options.map((o) => <MenuItem key={o} value={String(o)}>{optLabel(o)}</MenuItem>)}
          <MenuItem value="custom">Custom…</MenuItem>
        </TextField>
        {(customMode || custom) && (
          <NumField label="mm" value={b.moduleMm} min={0.1} max={1} step={0.005} onChange={(v) => setBarcode({ moduleMm: v })} width={96} />
        )}
      </Row>
      <TextField
        select size="small" label="If a code is too long to scan at this size"
        value={b.whenTooLong || 'warn'} onChange={(e) => setBarcode({ whenTooLong: e.target.value })}
        helperText={b.whenTooLong === 'internal'
          ? 'Prints a short numeric code saved against the product (it scans back to it). The product’s SKU / barcode are never changed.'
          : 'The label still prints, with a warning in the preview and print dialog.'}
        disabled={el.field === 'sku'}
      >
        <MenuItem value="warn">Warn me (print the full code)</MenuItem>
        <MenuItem value="internal">Use the product’s short internal code</MenuItem>
      </TextField>
      {plan && !plan.error && (
        <Box data-testid="barcode-readout" sx={{ p: 1, borderRadius: 1, fontSize: 12, bgcolor: plan.safe && plan.fits ? '#ecfdf5' : '#fffbeb', border: '1px solid', borderColor: plan.safe && plan.fits ? 'success.light' : 'warning.light' }}>
          <b>{plan.safe && plan.fits ? '✓ Scannable size' : '⚠ Too small to scan reliably'}</b> — “{value}” in {fmt}: {plan.modules} bar-widths<br />
          Bars <b>{f2(plan.moduleMm)} mm</b>{dot ? ` = ${Math.round(plan.dots * 100) / 100} printer dots @ ${dpi} dpi` : ''} · symbol {f2(plan.barsW)} mm + {f2(plan.quietEach)} mm blank each side · box {f2(boxW)} mm
          {!plan.safe && <><br />Needs {f2(plan.needAtMinMm)} mm at the {f2(plan.minModuleMm)} mm minimum.</>}
        </Box>
      )}
      {plan?.error && <Alert severity="error" sx={{ py: 0 }}>{plan.error}</Alert>}
    </Stack>
  );
}

export default function PropertiesPanel({ template, selection, onTemplate, onElement, onResize, onAlign, onDelete, allowedFields, dpi = 0, previewData }) {
  if (!template) return null;
  const selected = (template.layout.elements || []).filter((e) => selection.includes(e.id));
  if (selected.length === 0) return <LabelSettings template={template} onTemplate={onTemplate} onResize={onResize} />;

  const alignBar = (
    <Stack direction="row" spacing={0.25} flexWrap="wrap">
      {[['left', <AlignHorizontalLeft />, 'Align left'], ['hcenter', <AlignHorizontalCenter />, 'Centre horizontally'], ['right', <AlignHorizontalRight />, 'Align right'],
        ['top', <AlignVerticalTop />, 'Align top'], ['vcenter', <AlignVerticalCenter />, 'Centre vertically'], ['bottom', <AlignVerticalBottom />, 'Align bottom']].map(([m, icon, tip]) => (
          <Tooltip key={m} title={`${tip}${selection.length === 1 ? ' (to label)' : ''}`}>
            <IconButton size="small" onClick={() => onAlign(m)}>{React.cloneElement(icon, { fontSize: 'small' })}</IconButton>
          </Tooltip>
      ))}
    </Stack>
  );

  if (selected.length > 1) {
    return (
      <Stack spacing={1.5}>
        <H>{selected.length} elements selected</H>
        {alignBar}
        <Button color="error" variant="outlined" startIcon={<DeleteOutline />} onClick={onDelete}>Delete selected</Button>
      </Stack>
    );
  }

  const el = selected[0];
  const set = (patch, key) => onElement(el.id, patch, key);
  const setStyle = (patch) => onElement(el.id, { style: { ...el.style, ...patch } }, `style-${Object.keys(patch)[0]}`);
  const setBarcode = (patch) => onElement(el.id, { barcode: { ...el.barcode, ...patch } }, `bc-${Object.keys(patch)[0]}`);
  const def = FIELD_BY_ID[el.field];

  return (
    <Stack spacing={1.5}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="subtitle2" fontWeight={800} noWrap>{elementTitle(el)}</Typography>
        <Stack direction="row">
          <Tooltip title={el.locked ? 'Unlock' : 'Lock position'}><IconButton size="small" onClick={() => set({ locked: !el.locked })}>{el.locked ? <Lock fontSize="small" /> : <LockOpen fontSize="small" />}</IconButton></Tooltip>
          <Tooltip title={el.hidden ? 'Show' : 'Hide (keeps it in the template)'}><IconButton size="small" onClick={() => set({ hidden: !el.hidden })}>{el.hidden ? <VisibilityOff fontSize="small" /> : <Visibility fontSize="small" />}</IconButton></Tooltip>
          <Tooltip title="Delete (Del)"><IconButton size="small" color="error" onClick={onDelete}><DeleteOutline fontSize="small" /></IconButton></Tooltip>
        </Stack>
      </Stack>
      {alignBar}
      <H>Position & size</H>
      <Row>
        <NumField label="X" unit="mm" value={el.x} min={-template.width_mm} max={2 * template.width_mm} onChange={(v) => set({ x: v }, 'x')} />
        <NumField label="Y" unit="mm" value={el.y} min={-template.height_mm} max={2 * template.height_mm} onChange={(v) => set({ y: v }, 'y')} />
      </Row>
      <Row>
        <NumField label="Width" unit="mm" value={el.w} min={0.2} max={2 * template.width_mm} onChange={(v) => set({ w: v }, 'w')} />
        <NumField label="Height" unit="mm" value={el.h} min={0.1} max={2 * template.height_mm} onChange={(v) => set({ h: v }, 'h')} />
      </Row>
      <Row>
        <TextField select size="small" label="Rotation" value={el.rotation || 0} onChange={(e) => set({ rotation: Number(e.target.value) })} sx={{ flex: 1 }}>
          {[0, 90, 180, 270].map((r) => <MenuItem key={r} value={r}>{r}°</MenuItem>)}
        </TextField>
        <TextField size="small" label="Layer name" value={el.name || ''} onChange={(e) => set({ name: e.target.value.slice(0, 60) }, 'name')} sx={{ flex: 1 }} />
      </Row>

      {el.type === 'field' && (
        <>
          <Divider />
          <H>Data</H>
          <FieldSelect label="Product field" value={el.field} allowedFields={allowedFields} onChange={(v) => set({ field: v })} />
          {def?.restricted && <Alert severity="warning" sx={{ py: 0 }}>Restricted pricing — prints only for users allowed to see it; blank for everyone else.</Alert>}
          {def?.job && <Alert severity="info" sx={{ py: 0 }}>Typed per print batch (purchase-entry batch / expiry, or the print dialog).</Alert>}
          <Row>
            <TextField size="small" label="Prefix" placeholder="e.g. MRP " value={el.prefix} onChange={(e) => set({ prefix: e.target.value.slice(0, 40) }, 'prefix')} />
            <TextField size="small" label="Suffix" value={el.suffix} onChange={(e) => set({ suffix: e.target.value.slice(0, 40) }, 'suffix')} />
          </Row>
          {def?.kind === 'price' && (
            <TextField select size="small" label="Price format" value={el.priceFormat || 'currency'} onChange={(e) => set({ priceFormat: e.target.value })}>
              <MenuItem value="currency">₹1,234.00</MenuItem>
              <MenuItem value="currency0">₹1,234</MenuItem>
              <MenuItem value="number">1,234.00</MenuItem>
            </TextField>
          )}
          <TextField
            select size="small" label="If the product has no value" value={el.fallback?.mode || 'hide'}
            onChange={(e) => set({ fallback: { ...el.fallback, mode: e.target.value } })}
          >
            <MenuItem value="hide">Hide this element (incl. prefix)</MenuItem>
            <MenuItem value="blank">Leave blank space</MenuItem>
            <MenuItem value="text">Print fixed text instead</MenuItem>
            <MenuItem value="field">Use another field instead</MenuItem>
          </TextField>
          {el.fallback?.mode === 'text' && (
            <TextField size="small" label="Fallback text" placeholder="e.g. —" value={el.fallback.text || ''} onChange={(e) => set({ fallback: { ...el.fallback, text: e.target.value.slice(0, 60) } }, 'fbtext')} />
          )}
          {el.fallback?.mode === 'field' && (
            <FieldSelect label="Fallback field" value={el.fallback.field} allowedFields={allowedFields} onChange={(v) => set({ fallback: { ...el.fallback, field: v } })} />
          )}
          <Tooltip title="Products missing this value are listed and skipped when printing, instead of printing an incomplete label.">
            <FormControlLabel control={<Checkbox size="small" checked={!!el.required} onChange={(e) => set({ required: e.target.checked })} />} label="Required — don’t print labels without it" />
          </Tooltip>
          <Divider />
          <TypographyControls style={el.style} onStyle={setStyle} />
        </>
      )}

      {el.type === 'text' && (
        <>
          <Divider />
          <TextField size="small" label="Text" multiline maxRows={3} value={el.text} onChange={(e) => set({ text: e.target.value.slice(0, 200) }, 'text')} helperText="Fixed wording only — product values come from fields." />
          <TypographyControls style={el.style} onStyle={setStyle} />
        </>
      )}

      {el.type === 'barcode' && (
        <>
          <Divider />
          <H>Barcode</H>
          <TextField select size="small" label="Encodes" value={el.field} onChange={(e) => set({ field: e.target.value })}>
            <MenuItem value="barcode">Product barcode</MenuItem>
            <MenuItem value="sku">SKU</MenuItem>
          </TextField>
          <TextField select size="small" label="Format" value={el.barcode.format} onChange={(e) => setBarcode({ format: e.target.value })}>
            <MenuItem value="inherit">Label default ({template.layout.defaultBarcodeFormat})</MenuItem>
            {BARCODE_FORMATS.map((b) => <MenuItem key={b.id} value={b.id}>{b.label}</MenuItem>)}
          </TextField>
          <BarcodeSizing el={el} template={template} setBarcode={setBarcode} dpi={dpi} previewData={previewData} />
          <NumField label="Minimum blank space each side" unit="mm" value={el.barcode.quietZoneMm} min={0} max={10} step={0.1} onChange={(v) => setBarcode({ quietZoneMm: v })} helperText="Quiet zone — never less than 1 mm is used" />
          <ToggleButtonGroup size="small" exclusive value={el.barcode.align} onChange={(e, v) => v && setBarcode({ align: v })}>
            <ToggleButton value="left"><FormatAlignLeft fontSize="small" /></ToggleButton>
            <ToggleButton value="center"><FormatAlignCenter fontSize="small" /></ToggleButton>
            <ToggleButton value="right"><FormatAlignRight fontSize="small" /></ToggleButton>
          </ToggleButtonGroup>
          <Row>
            <FormControlLabel control={<Checkbox size="small" checked={!!el.barcode.showText} onChange={(e) => setBarcode({ showText: e.target.checked })} />} label="Number under bars" />
            {el.barcode.showText && <NumField label="Text" unit="pt" value={el.barcode.textSizePt} min={3} max={24} step={0.5} onChange={(v) => setBarcode({ textSizePt: v })} width={100} />}
          </Row>
          <Typography variant="caption" color="text.secondary">Height = the box height minus the digits. Bar widths snap to whole printer dots so preview and print match.</Typography>
        </>
      )}

      {el.type === 'qr' && (
        <TextField select size="small" label="Encodes" value={el.field} onChange={(e) => set({ field: e.target.value })}>
          <MenuItem value="barcode">Product barcode</MenuItem>
          <MenuItem value="sku">SKU</MenuItem>
          <MenuItem value="product_name">Product name</MenuItem>
        </TextField>
      )}

      {(el.type === 'line' || el.type === 'rect') && (
        <>
          <Divider />
          <Row>
            <NumField label="Thickness" unit="mm" value={el.strokeMm} min={0.05} max={3} step={0.05} onChange={(v) => set({ strokeMm: v }, 'stroke')} />
            <TextField size="small" type="color" label="Colour" value={el.color} onChange={(e) => set({ color: e.target.value }, 'color')} sx={{ width: 100 }} />
          </Row>
          {el.type === 'rect' && (
            <Row>
              <NumField label="Corner radius" unit="mm" value={el.radiusMm} min={0} max={20} onChange={(v) => set({ radiusMm: v }, 'radius')} />
              <FormControlLabel control={<Checkbox size="small" checked={!!el.fill} onChange={(e) => set({ fill: e.target.checked })} />} label="Filled" />
            </Row>
          )}
        </>
      )}

      {el.type === 'logo' && (
        <TextField select size="small" label="Fit" value={el.fit || 'contain'} onChange={(e) => set({ fit: e.target.value })} helperText="Upload the logo in Bill & Invoice Designer → Branding.">
          <MenuItem value="contain">Fit inside box</MenuItem>
          <MenuItem value="cover">Fill box (crop)</MenuItem>
        </TextField>
      )}
    </Stack>
  );
}
