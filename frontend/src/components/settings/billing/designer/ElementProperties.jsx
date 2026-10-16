// Right panel when one element is selected: position, data binding, element options,
// typography / appearance and visibility.
import React from 'react';
import {
  Box, Stack, TextField, Typography, Autocomplete, Button, IconButton, Tooltip, Divider, Chip, Alert, Checkbox,
} from '@mui/material';
import {
  FormatAlignLeft, FormatAlignCenter, FormatAlignRight, FormatAlignJustify, VerticalAlignTop, VerticalAlignCenter,
  VerticalAlignBottom, KeyboardArrowUp, KeyboardArrowDown, Delete, Add, CloudUpload,
} from '@mui/icons-material';
import {
  NumField, ColorField, SelectField, Toggle, Segmented, Section, Row, fileToDataUrl,
} from './controls';
import {
  FIELD_BY_ID, TOTALS_ROWS, TOTALS_ROW_BY_KEY, fieldsForDocTypes,
} from '../../../../billing/billFields';
import { FONT_FAMILIES, elementTitle, BAND_LABELS } from '../../../../billing/billLayout';
import { notify } from '../../../../utils/notify';

function FieldPicker({ value, onChange, docTypes, label = 'Data field', disabled }) {
  const options = fieldsForDocTypes(docTypes);
  const current = FIELD_BY_ID[value] || null;
  return (
    <Autocomplete
      size="small" disabled={disabled} options={options} value={current} groupBy={(o) => o.group}
      getOptionLabel={(o) => o.label} isOptionEqualToValue={(a, b) => a.id === b.id}
      onChange={(e, v) => v && onChange(v.id)}
      renderOption={(props, o) => (
        <li {...props} key={o.id}>
          <Box><Typography variant="body2">{o.label}</Typography><Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{o.id}</Typography></Box>
        </li>
      )}
      renderInput={(params) => <TextField {...params} label={label} />}
    />
  );
}

function TypographyEditor({ style = {}, onStyle, disabled, compact }) {
  const set = (k) => (v) => onStyle({ [k]: v === '' ? undefined : v });
  return (
    <>
      <SelectField label="Font" value={style.fontFamily || ''} onChange={set('fontFamily')} disabled={disabled}
        options={[{ value: '', label: 'Template font' }, ...FONT_FAMILIES]} />
      <Row>
        <NumField label="Size" unit="pt" step={0.5} min={4} max={72} value={style.fontSize ?? ''} onChange={set('fontSize')} disabled={disabled} />
        <SelectField label="Weight" value={style.fontWeight || ''} onChange={(v) => onStyle({ fontWeight: v || undefined })} disabled={disabled}
          options={[{ value: '', label: 'Normal' }, { value: 300, label: 'Light' }, { value: 500, label: 'Medium' }, { value: 600, label: 'Semi-bold' }, { value: 700, label: 'Bold' }, { value: 800, label: 'Extra-bold' }]} />
      </Row>
      <ColorField label="Text colour" value={style.color} onChange={set('color')} disabled={disabled} />
      {!compact && (
        <>
          <Row>
            <Segmented value={style.align || 'left'} onChange={set('align')} disabled={disabled} options={[
              { value: 'left', label: 'Left', icon: <FormatAlignLeft fontSize="small" /> },
              { value: 'center', label: 'Centre', icon: <FormatAlignCenter fontSize="small" /> },
              { value: 'right', label: 'Right', icon: <FormatAlignRight fontSize="small" /> },
              { value: 'justify', label: 'Justify', icon: <FormatAlignJustify fontSize="small" /> },
            ]} />
            <Segmented value={style.valign || 'top'} onChange={set('valign')} disabled={disabled} options={[
              { value: 'top', label: 'Top', icon: <VerticalAlignTop fontSize="small" /> },
              { value: 'middle', label: 'Middle', icon: <VerticalAlignCenter fontSize="small" /> },
              { value: 'bottom', label: 'Bottom', icon: <VerticalAlignBottom fontSize="small" /> },
            ]} />
          </Row>
          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
            <Toggle label="Italic" checked={style.italic} onChange={(v) => onStyle({ italic: v || undefined })} disabled={disabled} />
            <Toggle label="UPPERCASE" checked={style.uppercase} onChange={(v) => onStyle({ uppercase: v || undefined })} disabled={disabled} />
            <Toggle label="Underline" checked={style.underline} onChange={(v) => onStyle({ underline: v || undefined })} disabled={disabled} />
          </Stack>
          <Row>
            <NumField label="Line height" unit="×" step={0.05} min={0.8} max={3} value={style.lineHeight ?? ''} onChange={set('lineHeight')} disabled={disabled} />
            <NumField label="Letter spacing" unit="pt" step={0.1} min={-2} max={10} value={style.letterSpacing ?? ''} onChange={set('letterSpacing')} disabled={disabled} />
          </Row>
        </>
      )}
    </>
  );
}

function AppearanceEditor({ style = {}, onStyle, disabled }) {
  const set = (k) => (v) => onStyle({ [k]: v === '' ? undefined : v });
  return (
    <>
      <ColorField label="Background" value={style.bg} onChange={set('bg')} disabled={disabled} />
      <Row>
        <NumField label="Border" unit="pt" step={0.1} min={0} max={5} value={style.borderWidth ?? 0} onChange={set('borderWidth')} disabled={disabled} />
        <SelectField label="Sides" value={style.borderSides || 'all'} onChange={set('borderSides')} disabled={disabled}
          options={[{ value: 'all', label: 'All' }, { value: 'top', label: 'Top' }, { value: 'bottom', label: 'Bottom' }, { value: 'tb', label: 'Top + bottom' }, { value: 'lr', label: 'Left + right' }, { value: 'left', label: 'Left' }, { value: 'right', label: 'Right' }]} />
      </Row>
      {num(style.borderWidth) > 0 && (
        <Row>
          <Box sx={{ flex: 1 }}><ColorField label="Border colour" value={style.borderColor} onChange={set('borderColor')} disabled={disabled} /></Box>
          <Box sx={{ width: 110 }}><SelectField label="Style" value={style.borderStyle || 'solid'} onChange={set('borderStyle')} disabled={disabled} options={['solid', 'dashed', 'dotted', 'double']} /></Box>
        </Row>
      )}
      <Row>
        <NumField label="Padding" step={0.5} min={0} max={20} value={style.padding ?? 0} onChange={set('padding')} disabled={disabled} />
        <NumField label="Corner radius" step={0.5} min={0} max={20} value={style.radius ?? 0} onChange={set('radius')} disabled={disabled} />
      </Row>
    </>
  );
}

const num = (v) => Number(v) || 0;

function ShowToggles({ show = {}, keys, onChange, disabled }) {
  return (
    <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0}>
      {keys.map(([k, label]) => (
        <Box key={k} sx={{ width: '50%' }}>
          <Toggle label={label} checked={show[k] !== false} disabled={disabled} onChange={(v) => onChange({ ...show, [k]: v })} />
        </Box>
      ))}
    </Stack>
  );
}

function TotalsRowsEditor({ el, set, disabled }) {
  const rows = el.rows || [];
  const has = new Set(rows.map((r) => r.key));
  const move = (i, d) => {
    const next = [...rows];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    set({ rows: next });
  };
  return (
    <Box>
      {rows.map((r, i) => (
        <Stack key={r.key} direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.5 }}>
          <TextField size="small" value={r.label} placeholder={TOTALS_ROW_BY_KEY[r.key]?.label} disabled={disabled}
            onChange={(e) => set({ rows: rows.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} sx={{ flex: 1 }} />
          <Tooltip title="Always show (prints — when the document has no value)">
            <Checkbox size="small" checked={!!r.always} disabled={disabled} onChange={(e) => set({ rows: rows.map((x, k) => (k === i ? { ...x, always: e.target.checked || undefined } : x)) })} />
          </Tooltip>
          <IconButton size="small" disabled={disabled} onClick={() => move(i, -1)}><KeyboardArrowUp fontSize="small" /></IconButton>
          <IconButton size="small" disabled={disabled} onClick={() => move(i, 1)}><KeyboardArrowDown fontSize="small" /></IconButton>
          <IconButton size="small" disabled={disabled} onClick={() => set({ rows: rows.filter((_, k) => k !== i) })}><Delete fontSize="small" /></IconButton>
        </Stack>
      ))}
      <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mt: 0.5 }}>
        {TOTALS_ROWS.filter((t) => !has.has(t.key)).map((t) => (
          <Chip key={t.key} size="small" icon={<Add />} label={t.label} disabled={disabled} onClick={() => set({ rows: [...rows, { key: t.key, label: '' }] })} />
        ))}
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
        Rows print the document’s own figures. Zero rows are skipped unless ticked “always”; a missing figure never prints as 0.
      </Typography>
    </Box>
  );
}

function FieldListEditor({ el, set, docTypes, disabled }) {
  const rows = el.fields || [];
  return (
    <Box>
      {rows.map((r, i) => (
        <Stack key={`${r.field}-${i}`} direction="row" spacing={0.5} alignItems="center" sx={{ mb: 0.75 }}>
          <TextField size="small" label="Label" value={r.label} disabled={disabled} sx={{ width: 110 }}
            onChange={(e) => set({ fields: rows.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)) })} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <FieldPicker value={r.field} docTypes={docTypes} disabled={disabled} label="Field" onChange={(f) => set({ fields: rows.map((x, k) => (k === i ? { ...x, field: f } : x)) })} />
          </Box>
          <IconButton size="small" disabled={disabled || i === 0} onClick={() => { const n = [...rows]; [n[i - 1], n[i]] = [n[i], n[i - 1]]; set({ fields: n }); }}><KeyboardArrowUp fontSize="small" /></IconButton>
          <IconButton size="small" disabled={disabled} onClick={() => set({ fields: rows.filter((_, k) => k !== i) })}><Delete fontSize="small" /></IconButton>
        </Stack>
      ))}
      <Button size="small" startIcon={<Add />} disabled={disabled} onClick={() => set({ fields: [...rows, { field: 'document.date', label: 'Date' }] })}>Add row</Button>
    </Box>
  );
}

function ImageUpload({ value, onChange, disabled, label = 'Image' }) {
  const handle = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    try {
      const url = await fileToDataUrl(file);
      if (url.length > 530000) { notify('That image is too large — use one under 400 KB.', 'warning'); return; }
      onChange(url);
    } catch (err) {
      notify(err.message || 'Could not read that image.', 'error');
    }
  };
  return (
    <Row>
      {value && <Box component="img" src={value} alt="" sx={{ width: 44, height: 44, objectFit: 'contain', border: '1px solid #e2e8f0', borderRadius: 1 }} />}
      <Button component="label" size="small" variant="outlined" startIcon={<CloudUpload />} disabled={disabled}>
        {value ? `Replace ${label.toLowerCase()}` : `Upload ${label.toLowerCase()}`}
        <input hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={handle} />
      </Button>
      {value && <Button size="small" color="error" disabled={disabled} onClick={() => onChange('')}>Remove</Button>}
    </Row>
  );
}

export default function ElementProperties({
  el, band, onPatch, onStyle, docTypes, readOnly, onDelete, onMoveToBand, textInputRef,
}) {
  const set = (patch, key) => onPatch(patch, key);
  const d = readOnly;
  const typeLabel = elementTitle(el);

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={800} noWrap sx={{ flex: 1 }}>{typeLabel}</Typography>
        <Chip size="small" label={BAND_LABELS[band]} variant="outlined" />
      </Stack>
      {el.protected && <Alert severity="info" sx={{ py: 0, mb: 1, fontSize: 12 }}>Core section — deleting it asks for confirmation.</Alert>}

      <Section title="Position & size">
        <Row>
          <NumField label="X" value={el.x} onChange={(v) => set({ x: v }, 'x')} disabled={d || el.locked} testId="prop-x" />
          <NumField label="Y" value={el.y} onChange={(v) => set({ y: v }, 'y')} disabled={d || el.locked} testId="prop-y" />
        </Row>
        <Row>
          <NumField label="Width" value={el.w} min={0.5} onChange={(v) => set({ w: v }, 'w')} disabled={d || el.locked} testId="prop-w" />
          <NumField label="Height" value={el.h} min={0.2} onChange={(v) => set({ h: v }, 'h')} disabled={d || el.locked} testId="prop-h" />
        </Row>
        <Row>
          <SelectField label="Section" value={band} disabled={d} onChange={(v) => onMoveToBand(v)}
            options={['header', 'summary', 'footer'].map((b) => ({ value: b, label: BAND_LABELS[b] }))} />
          <TextField size="small" label="Layer name" value={el.name || ''} disabled={d} onChange={(e) => set({ name: e.target.value || undefined }, 'name')} fullWidth />
        </Row>
      </Section>

      {/* ---- type specific ---- */}
      {el.type === 'field' && (
        <Section title="Data binding">
          <FieldPicker value={el.field} docTypes={docTypes} disabled={d} onChange={(f) => set({ field: f })} />
          <Row>
            <TextField size="small" label="Label" value={el.label || ''} disabled={d} onChange={(e) => set({ label: e.target.value }, 'label')} fullWidth />
            <Box sx={{ width: 130 }}>
              <SelectField label="Label position" value={el.labelPosition || 'none'} disabled={d} onChange={(v) => set({ labelPosition: v })}
                options={[{ value: 'none', label: 'Hidden' }, { value: 'left', label: 'Left' }, { value: 'top', label: 'Above' }]} />
            </Box>
          </Row>
          {el.labelPosition === 'left' && <NumField label="Label width (0 = auto)" value={el.labelWidth ?? 0} min={0} onChange={(v) => set({ labelWidth: v }, 'lw')} disabled={d} />}
          <Row>
            <TextField size="small" label="Prefix" value={el.prefix || ''} disabled={d} onChange={(e) => set({ prefix: e.target.value }, 'prefix')} />
            <TextField size="small" label="Suffix" value={el.suffix || ''} disabled={d} onChange={(e) => set({ suffix: e.target.value }, 'suffix')} />
          </Row>
          <Toggle label="Hide when the document has no value" checked={el.hideIfEmpty !== false} disabled={d} onChange={(v) => set({ hideIfEmpty: v })} />
          {el.hideIfEmpty === false && <TextField size="small" label="Text when empty" value={el.emptyText || ''} disabled={d} onChange={(e) => set({ emptyText: e.target.value }, 'empty')} />}
          {el.labelPosition !== 'none' && el.label && (
            <Box sx={{ pl: 1, borderLeft: '2px solid #e2e8f0' }}>
              <Typography variant="caption" color="text.secondary">Label style</Typography>
              <Stack spacing={1} sx={{ mt: 0.5 }}>
                <TypographyEditor compact style={el.labelStyle || {}} disabled={d} onStyle={(p) => set({ labelStyle: { ...(el.labelStyle || {}), ...p } }, 'labelStyle')} />
              </Stack>
            </Box>
          )}
        </Section>
      )}

      {el.type === 'text' && (
        <Section title="Text">
          <TextField size="small" label="Heading (optional)" value={el.title || ''} disabled={d} onChange={(e) => set({ title: e.target.value || undefined }, 'title')} />
          <TextField
            size="small" label="Text" value={el.text || ''} disabled={d} multiline minRows={3} maxRows={12}
            inputRef={textInputRef} onChange={(e) => set({ text: e.target.value }, 'text')}
            helperText="Insert live values with {{field.id}} — or pick one in Data fields while this text is selected."
            inputProps={{ 'data-testid': 'prop-text' }}
          />
        </Section>
      )}

      {el.type === 'fieldList' && (
        <Section title="Rows">
          <FieldListEditor el={el} set={set} docTypes={docTypes} disabled={d} />
          <Row>
            <SelectField label="Layout" value={el.layout || 'rows'} disabled={d} onChange={(v) => set({ layout: v })}
              options={[{ value: 'rows', label: 'One per line' }, { value: 'grid', label: 'Two columns' }, { value: 'inline', label: 'Inline' }]} />
            <NumField label="Label width" value={el.labelWidth ?? 24} min={0} onChange={(v) => set({ labelWidth: v }, 'lw')} disabled={d} />
          </Row>
          <Toggle label="Skip rows the document doesn't have" checked={el.hideEmpty !== false} disabled={d} onChange={(v) => set({ hideEmpty: v })} />
        </Section>
      )}

      {el.type === 'companyBlock' && (
        <Section title="Company details">
          <Typography variant="caption" color="text.secondary">From Settings → Store Profile and Logo & Branding.</Typography>
          <ShowToggles show={el.show} disabled={d} onChange={(show) => set({ show })} keys={[['name', 'Name'], ['tagline', 'Tagline'], ['address', 'Address'], ['phone', 'Phone'], ['email', 'Email'], ['website', 'Website'], ['gstin', 'GSTIN'], ['pan', 'PAN']]} />
          <Row>
            <NumField label="Name size" unit="pt" min={6} max={48} value={el.nameSize ?? 16} onChange={(v) => set({ nameSize: v }, 'nameSize')} disabled={d} />
            <Box sx={{ flex: 1 }}><ColorField label="Name colour" value={el.nameColor} onChange={(v) => set({ nameColor: v })} disabled={d} /></Box>
          </Row>
        </Section>
      )}

      {el.type === 'partyBlock' && (
        <Section title="Customer / supplier">
          <Row>
            <TextField size="small" label="Heading" placeholder="Auto (Bill To / Supplier)" value={el.title || ''} disabled={d} onChange={(e) => set({ title: e.target.value }, 'title')} fullWidth />
            <Box sx={{ width: 130 }}>
              <SelectField label="Address" value={el.variant || 'billing'} disabled={d} onChange={(v) => set({ variant: v })} options={[{ value: 'billing', label: 'Billing' }, { value: 'shipping', label: 'Shipping' }]} />
            </Box>
          </Row>
          <ShowToggles show={el.show} disabled={d} onChange={(show) => set({ show })} keys={[['title', 'Heading'], ['name', 'Name'], ['code', 'Customer ID'], ['phone', 'Phone'], ['email', 'Email'], ['address', 'Address'], ['gstin', 'GSTIN']]} />
        </Section>
      )}

      {el.type === 'totals' && (
        <Section title="Totals rows">
          <TotalsRowsEditor el={el} set={set} disabled={d} />
          <Toggle label="Rule above grand total" checked={el.divider !== false} disabled={d} onChange={(v) => set({ divider: v })} />
          <Box sx={{ pl: 1, borderLeft: '2px solid #e2e8f0' }}>
            <Typography variant="caption" color="text.secondary">Grand total style</Typography>
            <Stack spacing={1} sx={{ mt: 0.5 }}>
              <TypographyEditor compact style={el.grandStyle || {}} disabled={d} onStyle={(p) => set({ grandStyle: { ...(el.grandStyle || {}), ...p } }, 'grand')} />
            </Stack>
          </Box>
        </Section>
      )}

      {el.type === 'payment' && (
        <Section title="Payment details">
          <TextField size="small" label="Heading" value={el.title || ''} disabled={d} onChange={(e) => set({ title: e.target.value }, 'title')} />
          <ShowToggles show={el.show} disabled={d} onChange={(show) => set({ show })} keys={[['method', 'Method'], ['reference', 'Reference'], ['splits', 'Split by mode'], ['paid', 'Paid'], ['balance', 'Balance'], ['status', 'Status'], ['bank', 'Bank details'], ['upi', 'UPI ID']]} />
          <Typography variant="caption" color="text.secondary">Bank details and UPI ID come from Logo & Branding.</Typography>
        </Section>
      )}

      {el.type === 'taxSummary' && (
        <Section title="Tax summary">
          <Toggle label="Group by HSN" checked={!!el.showHsn} disabled={d} onChange={(v) => set({ showHsn: v })} />
          <Typography variant="caption" color="text.secondary">Lists the tax recorded on each line, grouped by rate. Shown only when every line carries its tax amount.</Typography>
        </Section>
      )}

      {el.type === 'barcode' && (
        <Section title="Barcode (Code 128)">
          <FieldPicker value={el.field} docTypes={docTypes} disabled={d} label="Encodes" onChange={(f) => set({ field: f })} />
          <Toggle label="Show the text under the bars" checked={el.showText !== false} disabled={d} onChange={(v) => set({ showText: v })} />
        </Section>
      )}

      {el.type === 'qr' && (
        <Section title="QR code">
          <SelectField label="Content" value={el.source || 'field'} disabled={d} onChange={(v) => set({ source: v })}
            options={[{ value: 'field', label: 'A document field' }, { value: 'upi', label: 'UPI payment (amount due)' }, { value: 'custom', label: 'Custom text' }]} />
          {el.source === 'field' && <FieldPicker value={el.field} docTypes={docTypes} disabled={d} onChange={(f) => set({ field: f })} />}
          {el.source === 'custom' && <TextField size="small" label="Text / URL ({{field}} allowed)" value={el.customText || ''} disabled={d} multiline onChange={(e) => set({ customText: e.target.value }, 'qrtext')} />}
          {el.source === 'upi' && <Typography variant="caption" color="text.secondary">Uses the UPI ID from Logo & Branding and the document’s balance (or grand total).</Typography>}
        </Section>
      )}

      {el.type === 'signature' && (
        <Section title="Signature">
          <TextField size="small" label="Caption" value={el.label || ''} disabled={d} onChange={(e) => set({ label: e.target.value }, 'label')} />
          <Toggle label="Signature line" checked={el.showLine !== false} disabled={d} onChange={(v) => set({ showLine: v })} />
          <Toggle label="“For <store name>” above" checked={el.showCompany !== false} disabled={d} onChange={(v) => set({ showCompany: v })} />
          <ImageUpload label="Signature" value={el.src} disabled={d} onChange={(v) => set({ src: v })} />
        </Section>
      )}

      {el.type === 'image' && (
        <Section title="Image / stamp">
          <ImageUpload value={el.src} disabled={d} onChange={(v) => set({ src: v })} />
          <Row>
            <SelectField label="Fit" value={el.fit || 'contain'} disabled={d} onChange={(v) => set({ fit: v })} options={[{ value: 'contain', label: 'Fit inside' }, { value: 'cover', label: 'Fill (crop)' }]} />
            <NumField label="Opacity" unit="" step={0.05} min={0.05} max={1} value={el.opacity ?? 1} onChange={(v) => set({ opacity: v }, 'opacity')} disabled={d} />
          </Row>
        </Section>
      )}

      {el.type === 'logo' && (
        <Section title="Logo">
          <SelectField label="Fit" value={el.fit || 'contain'} disabled={d} onChange={(v) => set({ fit: v })} options={[{ value: 'contain', label: 'Fit inside' }, { value: 'cover', label: 'Fill (crop)' }]} />
          <Segmented value={el.style?.align || 'left'} disabled={d} onChange={(v) => onStyle({ align: v })} options={[
            { value: 'left', label: 'Left', icon: <FormatAlignLeft fontSize="small" /> },
            { value: 'center', label: 'Centre', icon: <FormatAlignCenter fontSize="small" /> },
            { value: 'right', label: 'Right', icon: <FormatAlignRight fontSize="small" /> },
          ]} />
          <Typography variant="caption" color="text.secondary">Upload or change the logo in Logo & Branding — every template uses it.</Typography>
        </Section>
      )}

      {el.type === 'line' && (
        <Section title="Line">
          <Row>
            <SelectField label="Direction" value={el.orientation || 'h'} disabled={d} onChange={(v) => set({ orientation: v, ...(v === 'v' ? { w: 1, h: Math.max(el.w, 10) } : { h: 1, w: Math.max(el.h, 10) }) })} options={[{ value: 'h', label: 'Horizontal' }, { value: 'v', label: 'Vertical' }]} />
            <SelectField label="Style" value={el.lineStyle || 'solid'} disabled={d} onChange={(v) => set({ lineStyle: v })} options={['solid', 'dashed', 'dotted', 'double']} />
          </Row>
          <Row>
            <NumField label="Thickness" unit="pt" step={0.1} min={0.1} max={5} value={el.thickness ?? 0.5} onChange={(v) => set({ thickness: v }, 'thick')} disabled={d} />
            <Box sx={{ flex: 1 }}><ColorField label="Colour" allowEmpty={false} value={el.color} onChange={(v) => set({ color: v })} disabled={d} /></Box>
          </Row>
        </Section>
      )}

      {el.type === 'pageNumber' && (
        <Section title="Page number">
          <TextField size="small" label="Format" value={el.format || ''} disabled={d} onChange={(e) => set({ format: e.target.value }, 'fmt')} helperText="{page} and {pages} are replaced on every page." />
        </Section>
      )}

      {!['line', 'box', 'logo', 'image', 'qr', 'barcode'].includes(el.type) && (
        <Section title="Typography">
          <TypographyEditor style={el.style || {}} onStyle={onStyle} disabled={d} />
          <Toggle label="Shrink text to fit the box" checked={!!el.style?.shrinkToFit} disabled={d} onChange={(v) => onStyle({ shrinkToFit: v || undefined })}
            hint="Long names / addresses get a smaller font instead of being cut off." />
          <Toggle label="Single line (cut with …)" checked={el.style?.wrap === false} disabled={d} onChange={(v) => onStyle({ wrap: v ? false : undefined })} />
        </Section>
      )}

      {!['line'].includes(el.type) && (
        <Section title="Box appearance">
          <AppearanceEditor style={el.style || {}} onStyle={onStyle} disabled={d} />
        </Section>
      )}

      <Section title="Visibility">
        <Toggle label="Hidden (kept in the template, not printed)" checked={!!el.hidden} disabled={d} onChange={(v) => set({ hidden: v || undefined })} />
        <FieldPickerOptional value={el.visibleIf} docTypes={docTypes} disabled={d} onChange={(f) => set({ visibleIf: f || undefined })} />
        <Toggle label="Lock position" checked={!!el.locked} disabled={d} onChange={(v) => set({ locked: v || undefined })} />
      </Section>

      <Divider sx={{ my: 1 }} />
      <Button color="error" size="small" startIcon={<Delete />} disabled={d} onClick={onDelete}>Delete element</Button>
    </Box>
  );
}

function FieldPickerOptional({ value, onChange, docTypes, disabled }) {
  const options = [{ id: '', label: 'Always print', group: '' }, ...fieldsForDocTypes(docTypes)];
  const current = options.find((o) => o.id === (value || '')) || options[0];
  return (
    <Autocomplete
      size="small" disabled={disabled} options={options} value={current} groupBy={(o) => o.group}
      getOptionLabel={(o) => (o.id ? `Only when “${o.label}” has a value` : o.label)} isOptionEqualToValue={(a, b) => a.id === b.id}
      onChange={(e, v) => onChange(v?.id || '')}
      renderInput={(params) => <TextField {...params} label="Print condition" />}
    />
  );
}

export { TypographyEditor, AppearanceEditor, FieldPicker };
