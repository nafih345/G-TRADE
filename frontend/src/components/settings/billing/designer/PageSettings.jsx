// Right panel when nothing is selected: paper & margins, sections, theme and formatting.
import React, { useState } from 'react';
import {
  Box, Stack, TextField, Typography, Chip, Button, Tooltip, Alert,
} from '@mui/material';
import { Palette, Save } from '@mui/icons-material';
import { NumField, ColorField, SelectField, Toggle, Section, Row } from './controls';
import {
  PAPER_SIZES, FONT_FAMILIES, THEMES, THEME_KEYS, BAND_LABELS,
} from '../../../../billing/billLayout';
import { DATE_FORMATS, DOC_TYPE_LABELS, formatMoney, formatDate } from '../../../../billing/billFields';

const THEME_LABELS = { primary: 'Primary', accent: 'Accent', text: 'Text', muted: 'Muted text', border: 'Borders', headerBg: 'Table header', headerText: 'Header text' };

export default function PageSettings({
  draft, onTemplate, onConfig, geometry, readOnly, savedThemes, onSaveTheme, branding, compatible, assignedTo,
}) {
  const cfg = draft.config;
  const d = readOnly;
  const [themeName, setThemeName] = useState('');
  const setTheme = (patch, key) => onConfig((c) => ({ ...c, theme: { ...c.theme, ...patch } }), key);
  const setFormat = (patch, key) => onConfig((c) => ({ ...c, format: { ...c.format, ...patch } }), key);
  const setPage = (patch) => onConfig((c) => ({ ...c, page: { ...c.page, ...patch } }));
  const setBandH = (band, h) => onConfig((c) => ({ ...c, bands: { ...c.bands, [band]: { ...c.bands[band], height: h } } }), `bandh-${band}`);
  const margins = draft.margins || {};
  const setMargin = (side, v) => onTemplate((t) => ({ ...t, margins: { ...t.margins, [side]: v } }), `margin-${side}`);
  const allThemes = [...THEMES, ...(savedThemes || []).map((t) => ({ ...t, saved: true }))];
  const sample = formatMoney(123456.5, { ...cfg.format, currencySymbol: cfg.format.currencySymbol });

  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 0.5 }}>Page & template</Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1.5 }}>
        Select an element on the page to edit it. These settings apply to the whole template.
      </Typography>

      <Section title="Template">
        <TextField size="small" label="Description" value={draft.description || ''} disabled={d}
          onChange={(e) => onTemplate((t) => ({ ...t, description: e.target.value }), 'desc')} />
        <Box>
          <Typography variant="caption" color="text.secondary">Can print:</Typography>
          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5} sx={{ mt: 0.5 }}>
            {compatible.map((dt) => (
              <Chip key={dt} size="small" label={DOC_TYPE_LABELS[dt] || dt} color={assignedTo.includes(dt) ? 'primary' : 'default'} variant={assignedTo.includes(dt) ? 'filled' : 'outlined'} />
            ))}
          </Stack>
          {!compatible.length && <Alert severity="warning" sx={{ mt: 0.5, py: 0 }}>This layout mixes fields from different document families — no document type can use it.</Alert>}
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>Filled chips = currently assigned. Worked out from the fields the layout uses.</Typography>
        </Box>
      </Section>

      <Section title="Paper">
        <SelectField label="Paper size" value={draft.paper_size} disabled={d} testId="paper-size"
          onChange={(v) => onTemplate((t) => ({
            ...t, paper_size: v,
            ...(v === 'CUSTOM' ? { custom_width_mm: t.custom_width_mm || geometry.pageW, custom_height_mm: t.custom_height_mm || (geometry.thermal ? '' : geometry.pageH) } : {}),
            ...(['80mm', '58mm'].includes(v) ? { orientation: 'portrait' } : {}),
          }))}
          options={PAPER_SIZES} />
        {draft.paper_size === 'CUSTOM' && (
          <Row>
            <NumField label="Width" min={20} max={1000} value={draft.custom_width_mm ?? ''} onChange={(v) => onTemplate((t) => ({ ...t, custom_width_mm: v }), 'cw')} disabled={d} />
            <NumField label="Height (blank = roll)" min={20} max={3000} value={draft.custom_height_mm ?? ''} onChange={(v) => onTemplate((t) => ({ ...t, custom_height_mm: v }), 'ch')} disabled={d} />
          </Row>
        )}
        {!['80mm', '58mm', 'CUSTOM'].includes(draft.paper_size) && (
          <SelectField label="Orientation" value={draft.orientation || 'portrait'} disabled={d} onChange={(v) => onTemplate((t) => ({ ...t, orientation: v }))}
            options={[{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]} />
        )}
        <Typography variant="caption" color="text.secondary">
          {geometry.pageW} × {geometry.thermal ? 'auto (roll)' : geometry.pageH} mm · printable width {geometry.contentW} mm
        </Typography>
        <Row>
          <NumField label="Top" min={0} max={50} value={margins.top ?? 10} onChange={(v) => setMargin('top', v)} disabled={d} />
          <NumField label="Bottom" min={0} max={50} value={margins.bottom ?? 10} onChange={(v) => setMargin('bottom', v)} disabled={d} />
        </Row>
        <Row>
          <NumField label="Left" min={0} max={50} value={margins.left ?? 10} onChange={(v) => setMargin('left', v)} disabled={d} />
          <NumField label="Right" min={0} max={50} value={margins.right ?? 10} onChange={(v) => setMargin('right', v)} disabled={d} />
        </Row>
      </Section>

      <Section title="Sections">
        {['header', 'summary', 'footer'].map((b) => (
          <NumField key={b} label={`${BAND_LABELS[b]} height`} min={0} max={600} value={cfg.bands[b].height} onChange={(v) => setBandH(b, v)} disabled={d} testId={`band-h-${b}`} />
        ))}
        <Toggle label="Repeat the header on every page" checked={!!cfg.page.headerOnEveryPage} disabled={d || geometry.thermal} onChange={(v) => setPage({ headerOnEveryPage: v })} />
        <SelectField label="Totals & summary position" value={cfg.page.summaryAt || 'after-items'} disabled={d || geometry.thermal} onChange={(v) => setPage({ summaryAt: v })}
          options={[{ value: 'after-items', label: 'Right after the items' }, { value: 'page-bottom', label: 'Bottom of the last page' }]} />
        <ColorField label="Page background" value={cfg.page.background} onChange={(v) => setPage({ background: v })} disabled={d} />
      </Section>

      <Section title="Colour theme">
        <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
          <Tooltip title={branding?.primary_color ? 'Primary / accent from Logo & Branding' : 'Set colours in Logo & Branding'}>
            <Chip size="small" icon={<Palette />} label="Brand colours" color={cfg.theme.useBrand ? 'primary' : 'default'} disabled={d}
              onClick={() => setTheme({ useBrand: !cfg.theme.useBrand })} />
          </Tooltip>
          {allThemes.map((t) => (
            <Chip
              key={`${t.name}${t.saved ? '-s' : ''}`} size="small" label={t.name} disabled={d}
              variant={cfg.theme.name === t.name && !cfg.theme.useBrand ? 'filled' : 'outlined'}
              avatar={<Box sx={{ width: 14, height: 14, borderRadius: '50%', bgcolor: t.primary, ml: '6px !important' }} />}
              onClick={() => setTheme({ ...Object.fromEntries(THEME_KEYS.filter((k) => t[k]).map((k) => [k, t[k]])), name: t.name, useBrand: false })}
            />
          ))}
        </Stack>
        {THEME_KEYS.map((k) => (
          <ColorField key={k} label={THEME_LABELS[k]} allowEmpty={false} value={cfg.theme[k]} disabled={d || (cfg.theme.useBrand && ['primary', 'accent', 'headerBg'].includes(k))}
            onChange={(v) => setTheme({ [k]: v, name: '' })} />
        ))}
        <Row>
          <TextField size="small" label="Save colours as theme" value={themeName} onChange={(e) => setThemeName(e.target.value)} disabled={d} fullWidth />
          <Button size="small" startIcon={<Save />} disabled={d || !themeName.trim()} onClick={() => { onSaveTheme({ name: themeName.trim(), ...Object.fromEntries(THEME_KEYS.map((k) => [k, cfg.theme[k]])) }); setThemeName(''); }}>Save</Button>
        </Row>
      </Section>

      <Section title="Default text">
        <SelectField label="Font" value={cfg.theme.fontFamily} disabled={d} onChange={(v) => setTheme({ fontFamily: v })} options={FONT_FAMILIES} />
        <Row>
          <NumField label="Size" unit="pt" step={0.5} min={5} max={20} value={cfg.theme.fontSize} onChange={(v) => setTheme({ fontSize: v }, 'fs')} disabled={d} />
          <NumField label="Line height" unit="×" step={0.05} min={0.9} max={2.5} value={cfg.theme.lineHeight} onChange={(v) => setTheme({ lineHeight: v }, 'lh')} disabled={d} />
        </Row>
      </Section>

      <Section title="Numbers & dates">
        <Row>
          <TextField size="small" label="Currency symbol" value={cfg.format.currencySymbol ?? '₹'} disabled={d} onChange={(e) => setFormat({ currencySymbol: e.target.value.slice(0, 6) }, 'cur')} />
          <NumField label="Decimals" unit="" step={1} min={0} max={4} value={cfg.format.decimals} onChange={(v) => setFormat({ decimals: Math.round(v) }, 'dec')} disabled={d} />
        </Row>
        <SelectField label="Digit grouping" value={cfg.format.thousands || 'indian'} disabled={d} onChange={(v) => setFormat({ thousands: v })}
          options={[{ value: 'indian', label: 'Indian (1,23,456)' }, { value: 'international', label: 'International (123,456)' }, { value: 'none', label: 'None (123456)' }]} />
        <SelectField label="Date format" value={cfg.format.dateFormat} disabled={d} onChange={(v) => setFormat({ dateFormat: v })}
          options={DATE_FORMATS.map((f) => ({ value: f, label: `${f}  →  ${formatDate('2026-10-16', f)}` }))} />
        <Toggle label="Print zero amounts as —" checked={!!cfg.format.zeroAsDash} disabled={d} onChange={(v) => setFormat({ zeroAsDash: v })} />
        <Typography variant="caption" color="text.secondary">Example: {sample}</Typography>
      </Section>
    </Box>
  );
}
