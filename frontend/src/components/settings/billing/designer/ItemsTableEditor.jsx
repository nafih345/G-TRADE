// Right panel when the items table is selected: column management + table styling.
import React from 'react';
import {
  Box, Stack, TextField, Typography, IconButton, Tooltip, Checkbox, Chip, Alert, Divider,
} from '@mui/material';
import {
  KeyboardArrowUp, KeyboardArrowDown, Delete, Add, FormatAlignLeft, FormatAlignCenter, FormatAlignRight,
} from '@mui/icons-material';
import { NumField, ColorField, SelectField, Toggle, Segmented, Section, Row } from './controls';
import { ITEM_COLUMNS, COLUMN_BY_KEY, DOC_TYPE_LABELS } from '../../../../billing/billFields';

export default function ItemsTableEditor({ items, onItems, onTable, readOnly, docTypes }) {
  const table = items.table;
  const cols = table.columns || [];
  const d = readOnly;
  const setCol = (i, patch, key) => onTable({ columns: cols.map((c, k) => (k === i ? { ...c, ...patch } : c)) }, key ? `col${i}:${key}` : undefined);
  const move = (i, dir) => {
    const j = i + dir;
    if (j < 0 || j >= cols.length) return;
    const next = [...cols];
    [next[i], next[j]] = [next[j], next[i]];
    onTable({ columns: next });
  };
  const present = new Set(cols.map((c) => c.key));
  const totalW = cols.filter((c) => c.visible !== false).reduce((s, c) => s + (Number(c.width) || 0), 0) || 1;
  const limited = (c) => (c.scope && docTypes?.length && !docTypes.every((dt) => c.scope.includes(dt)));

  return (
    <Box>
      <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1 }}>Items table</Typography>
      {!items.visible && <Alert severity="warning" sx={{ mb: 1, py: 0 }}>The table is hidden — this template prints no line items (e.g. a payment receipt).</Alert>}
      <Toggle label="Show the items table" checked={items.visible !== false} disabled={d} onChange={(v) => onItems({ visible: v })} />

      <Section title="Columns">
        <Typography variant="caption" color="text.secondary">Width is a share of the table (shown as %). Tick to show; rows bind to each line of the document.</Typography>
        {cols.map((c, i) => {
          const meta = COLUMN_BY_KEY[c.key];
          const vis = c.visible !== false;
          return (
            <Box key={c.key} sx={{ p: 0.75, border: '1px solid', borderColor: vis ? 'divider' : 'transparent', borderRadius: 1, bgcolor: vis ? 'background.paper' : 'action.hover' }} data-testid={`col-${c.key}`}>
              <Stack direction="row" spacing={0.5} alignItems="center">
                <Checkbox size="small" checked={vis} disabled={d} onChange={(e) => setCol(i, { visible: e.target.checked })} sx={{ p: 0.25 }} />
                <TextField size="small" value={c.label ?? ''} placeholder={meta?.label} disabled={d} onChange={(e) => setCol(i, { label: e.target.value }, 'label')} sx={{ flex: 1 }} />
                <IconButton size="small" disabled={d || i === 0} onClick={() => move(i, -1)}><KeyboardArrowUp fontSize="small" /></IconButton>
                <IconButton size="small" disabled={d || i === cols.length - 1} onClick={() => move(i, 1)}><KeyboardArrowDown fontSize="small" /></IconButton>
                <IconButton size="small" disabled={d || c.key === 'name'} onClick={() => onTable({ columns: cols.filter((_, k) => k !== i) })}><Delete fontSize="small" /></IconButton>
              </Stack>
              {vis && (
                <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.75, pl: 3.5 }}>
                  <NumField label={`Width (${Math.round(((Number(c.width) || 0) / totalW) * 100)}%)`} unit="" step={1} min={1} max={100} value={c.width} onChange={(v) => setCol(i, { width: v }, 'w')} disabled={d} width={110} />
                  <Segmented value={c.align || 'left'} disabled={d} onChange={(v) => setCol(i, { align: v })} options={[
                    { value: 'left', label: 'Left', icon: <FormatAlignLeft fontSize="small" /> },
                    { value: 'center', label: 'Centre', icon: <FormatAlignCenter fontSize="small" /> },
                    { value: 'right', label: 'Right', icon: <FormatAlignRight fontSize="small" /> },
                  ]} />
                  {meta?.kind === 'money' && (
                    <NumField label="Decimals" unit="" step={1} min={0} max={4} value={c.decimals ?? ''} onChange={(v) => setCol(i, { decimals: v }, 'dec')} disabled={d} width={80} />
                  )}
                </Stack>
              )}
              {limited(meta || {}) && vis && (
                <Typography variant="caption" color="warning.main" sx={{ pl: 3.5, display: 'block' }}>
                  Only {meta.scope.map((x) => DOC_TYPE_LABELS[x]).join(' / ')} carry this column.
                </Typography>
              )}
            </Box>
          );
        })}
        <Typography variant="caption" color="text.secondary">Add a column:</Typography>
        <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
          {ITEM_COLUMNS.filter((c) => !present.has(c.key)).map((c) => (
            <Tooltip key={c.key} title={c.scope ? `Available on ${c.scope.map((x) => DOC_TYPE_LABELS[x]).join(', ')}` : ''}>
              <Chip size="small" icon={<Add />} label={c.label} disabled={d} variant={c.scope ? 'outlined' : 'filled'}
                onClick={() => onTable({ columns: [...cols, { key: c.key, label: c.label, width: c.width, align: c.align, visible: true }] })} />
            </Tooltip>
          ))}
        </Stack>
      </Section>

      <Section title="Under the item name">
        <Stack direction="row" flexWrap="wrap" useFlexGap>
          <Box sx={{ width: '50%' }}><Toggle label="Brand" checked={table.showBrand} disabled={d} onChange={(v) => onTable({ showBrand: v })} /></Box>
          <Box sx={{ width: '50%' }}><Toggle label="Variant" checked={table.showVariant} disabled={d} onChange={(v) => onTable({ showVariant: v })} /></Box>
          <Box sx={{ width: '50%' }}><Toggle label="SKU" checked={table.showSku} disabled={d} onChange={(v) => onTable({ showSku: v })} /></Box>
          <Box sx={{ width: '50%' }}><Toggle label="Power (Rx)" checked={table.showPower !== false} disabled={d} onChange={(v) => onTable({ showPower: v })} /></Box>
        </Stack>
      </Section>

      <Section title="Header row">
        <Row>
          <Box sx={{ flex: 1 }}><ColorField label="Background" value={table.headerStyle?.bg} onChange={(v) => onTable({ headerStyle: { ...table.headerStyle, bg: v || undefined } })} disabled={d} /></Box>
        </Row>
        <ColorField label="Text colour" value={table.headerStyle?.color} onChange={(v) => onTable({ headerStyle: { ...table.headerStyle, color: v || undefined } })} disabled={d} />
        <Row>
          <NumField label="Font size" unit="pt" step={0.5} min={5} max={20} value={table.headerStyle?.fontSize ?? ''} onChange={(v) => onTable({ headerStyle: { ...table.headerStyle, fontSize: v } }, 'hfs')} disabled={d} />
          <Toggle label="UPPERCASE" checked={!!table.headerStyle?.uppercase} disabled={d} onChange={(v) => onTable({ headerStyle: { ...table.headerStyle, uppercase: v || undefined } })} />
        </Row>
      </Section>

      <Section title="Rows">
        <Row>
          <NumField label="Font size" unit="pt" step={0.5} min={5} max={20} value={table.bodyStyle?.fontSize ?? ''} onChange={(v) => onTable({ bodyStyle: { ...table.bodyStyle, fontSize: v } }, 'bfs')} disabled={d} />
          <NumField label="Row padding" step={0.1} min={0} max={10} value={table.rowPadding ?? 1.6} onChange={(v) => onTable({ rowPadding: v }, 'pad')} disabled={d} />
        </Row>
        <Row>
          <NumField label="Cell side padding" step={0.1} min={0} max={5} value={table.cellPadX ?? 1.3} onChange={(v) => onTable({ cellPadX: v }, 'padx')} disabled={d} />
          <Toggle label="₹ symbol in rows" checked={table.currencyInTable !== false} disabled={d} onChange={(v) => onTable({ currencyInTable: v })} />
        </Row>
        <Row>
          <Toggle label="Striped rows" checked={!!table.zebra} disabled={d} onChange={(v) => onTable({ zebra: v })} />
          {table.zebra && <Box sx={{ flex: 1 }}><ColorField label="Stripe" allowEmpty={false} value={table.zebraColor} onChange={(v) => onTable({ zebraColor: v })} disabled={d} /></Box>}
        </Row>
        <Row>
          <SelectField label="Borders" value={table.borders || 'rows'} disabled={d} onChange={(v) => onTable({ borders: v })}
            options={[{ value: 'rows', label: 'Row lines' }, { value: 'grid', label: 'Full grid' }, { value: 'outer', label: 'Outline + columns' }, { value: 'header', label: 'Dashed header (receipt)' }, { value: 'none', label: 'None' }]} />
          <Box sx={{ flex: 1 }}><ColorField label="Border colour" allowEmpty={false} value={table.borderColor} onChange={(v) => onTable({ borderColor: v })} disabled={d} /></Box>
        </Row>
        <TextField size="small" label="Text when there are no items" value={table.emptyText || ''} disabled={d} onChange={(e) => onTable({ emptyText: e.target.value }, 'empty')} />
        <Toggle label="Total quantity row" checked={!!table.totalRow} disabled={d} onChange={(v) => onTable({ totalRow: v })} />
      </Section>

      <Section title="Pages">
        <Toggle label="Repeat the header row on every page" checked={table.repeatHeader !== false} disabled={d} onChange={(v) => onTable({ repeatHeader: v })} />
        <Toggle label="Rule the table down to the totals (fill page)" checked={!!table.fillPage} disabled={d} onChange={(v) => onTable({ fillPage: v })} />
        <Row>
          <NumField label="Space above" step={0.5} min={0} max={100} value={items.marginTop ?? 2} onChange={(v) => onItems({ marginTop: v }, 'mt')} disabled={d} />
          <NumField label="Space below" step={0.5} min={0} max={100} value={items.marginBottom ?? 3} onChange={(v) => onItems({ marginBottom: v }, 'mb')} disabled={d} />
        </Row>
      </Section>
      <Divider />
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
        Long item names wrap inside their column; rows that don’t fit move to the next page with the header repeated. Amounts are the document’s own line figures.
      </Typography>
    </Box>
  );
}
