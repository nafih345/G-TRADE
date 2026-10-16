// Left panel of the bill designer: the element library, the data-field picker (every field
// is a live binding to the transaction — nothing is typed in) and the layers list.
import React, { useMemo, useState } from 'react';
import {
  Box, Tabs, Tab, Typography, TextField, InputAdornment, Stack, IconButton, Tooltip, Chip, ListSubheader,
} from '@mui/material';
import {
  Search, Visibility, VisibilityOff, Lock, LockOpen, KeyboardArrowUp, KeyboardArrowDown, DragIndicator, Shield,
} from '@mui/icons-material';
import { ELEMENT_LIBRARY, elementTitle, BAND_LABELS } from '../../../../billing/billLayout';
import { FIELD_GROUPS, fieldsForDocTypes, DOC_TYPE_LABELS } from '../../../../billing/billFields';

const DRAG_TYPE = 'application/x-bill-element';

function LibraryItem({ item, onAdd, readOnly }) {
  return (
    <Box
      draggable={!readOnly}
      onDragStart={(e) => {
        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: 'library', type: item.type, preset: item.preset || {}, w: item.w, h: item.h }));
        e.dataTransfer.effectAllowed = 'copy';
      }}
      onClick={() => !readOnly && onAdd({ kind: 'library', type: item.type, preset: item.preset || {}, w: item.w, h: item.h })}
      title={item.hint || 'Click to add, or drag onto the page'}
      sx={{
        display: 'flex', alignItems: 'center', gap: 0.75, px: 1, py: 0.6, borderRadius: 1, cursor: readOnly ? 'default' : 'grab',
        border: '1px solid', borderColor: 'divider', bgcolor: 'background.paper', fontSize: 13,
        '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
      }}
      data-testid={`lib-${item.label}`}
    >
      <DragIndicator sx={{ fontSize: 16, color: 'text.disabled' }} />
      <Typography variant="body2" sx={{ fontSize: 13 }}>{item.label}</Typography>
    </Box>
  );
}

export default function BillPalette({
  tab, onTab, onAdd, onInsertToken, targetDocTypes, config, selection, onSelect, onElementPatch, onReorder, readOnly, textSelected,
}) {
  const [q, setQ] = useState('');
  const fields = useMemo(() => fieldsForDocTypes(targetDocTypes), [targetDocTypes]);
  const filtered = fields.filter((f) => !q || `${f.label} ${f.id}`.toLowerCase().includes(q.toLowerCase()));
  const groups = ELEMENT_LIBRARY.reduce((acc, it) => { (acc[it.group] = acc[it.group] || []).push(it); return acc; }, {});

  return (
    <Box>
      <Tabs value={tab} onChange={(e, v) => onTab(v)} variant="fullWidth" sx={{ minHeight: 36, mb: 1, '& .MuiTab-root': { minHeight: 36, minWidth: 0, px: 0.5, py: 0.5, fontSize: 12, fontWeight: 700, textTransform: 'none' } }}>
        <Tab value="elements" label="Elements" />
        <Tab value="fields" label="Fields" />
        <Tab value="layers" label="Layers" />
      </Tabs>

      {tab === 'elements' && (
        <Stack spacing={1.25}>
          {Object.entries(groups).map(([group, list]) => (
            <Box key={group}>
              <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 800, lineHeight: 2 }}>{group}</Typography>
              <Stack spacing={0.5}>
                {list.map((item) => <LibraryItem key={`${item.type}-${item.label}`} item={item} onAdd={onAdd} readOnly={readOnly} />)}
              </Stack>
            </Box>
          ))}
          <Typography variant="caption" color="text.secondary">
            Click to add to the selected section, or drag onto the page. Every value prints from the real document.
          </Typography>
        </Stack>
      )}

      {tab === 'fields' && (
        <Box>
          <TextField
            size="small" fullWidth placeholder="Search fields" value={q} onChange={(e) => setQ(e.target.value)}
            InputProps={{ startAdornment: <InputAdornment position="start"><Search fontSize="small" /></InputAdornment> }}
            sx={{ mb: 1 }}
          />
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
            {textSelected
              ? 'Click a field to insert it as a {{placeholder}} into the selected text.'
              : 'Drag a field onto the page (or click to add) — it becomes a bound element.'}
            {targetDocTypes?.length ? ` Showing fields for: ${targetDocTypes.map((d) => DOC_TYPE_LABELS[d] || d).join(', ')}.` : ''}
          </Typography>
          {FIELD_GROUPS.map((group) => {
            const list = filtered.filter((f) => f.group === group);
            if (!list.length) return null;
            return (
              <Box key={group} sx={{ mb: 1 }}>
                <ListSubheader disableSticky sx={{ px: 0, lineHeight: 2, fontWeight: 800, bgcolor: 'transparent' }}>{group}</ListSubheader>
                <Stack spacing={0.4}>
                  {list.map((f) => (
                    <Box
                      key={f.id}
                      draggable={!readOnly}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_TYPE, JSON.stringify({ kind: 'field', field: f.id, label: f.label }));
                      }}
                      onClick={() => {
                        if (readOnly) return;
                        if (textSelected) onInsertToken(f.id);
                        else onAdd({ kind: 'field', field: f.id, label: f.label });
                      }}
                      data-testid={`field-${f.id}`}
                      sx={{
                        px: 1, py: 0.4, borderRadius: 1, cursor: readOnly ? 'default' : 'grab', border: '1px solid', borderColor: 'divider',
                        '&:hover': { borderColor: 'primary.main', bgcolor: 'action.hover' },
                      }}
                    >
                      <Typography variant="body2" sx={{ fontSize: 12.5, fontWeight: 600 }}>{f.label}</Typography>
                      <Typography variant="caption" color="text.secondary" sx={{ fontFamily: 'monospace', fontSize: 10.5 }}>
                        {f.id}{f.kind === 'money' ? ' · ₹' : f.kind === 'date' ? ' · date' : ''}{f.scope ? ' · limited' : ''}
                      </Typography>
                    </Box>
                  ))}
                </Stack>
              </Box>
            );
          })}
        </Box>
      )}

      {tab === 'layers' && (
        <Box>
          {['header', 'summary', 'footer'].map((band) => {
            const els = config.bands[band]?.elements || [];
            return (
              <Box key={band} sx={{ mb: 1.25 }}>
                <Typography variant="overline" color="text.secondary" sx={{ fontWeight: 800, lineHeight: 2 }}>
                  {BAND_LABELS[band]} <Chip size="small" label={`${config.bands[band]?.height ?? 0} mm`} sx={{ height: 18, fontSize: 10, ml: 0.5 }} />
                </Typography>
                {!els.length && <Typography variant="caption" color="text.disabled" sx={{ display: 'block', pl: 1 }}>Empty</Typography>}
                {/* Top of the list = front-most (rendered last). */}
                {[...els].reverse().map((el) => {
                  const sel = selection.includes(el.id);
                  return (
                    <Stack
                      key={el.id} direction="row" alignItems="center" spacing={0.25}
                      onClick={(e) => onSelect(e.shiftKey ? [...selection, el.id] : [el.id])}
                      data-testid={`layer-${el.id}`}
                      sx={{
                        pl: 1, pr: 0.25, py: 0.1, borderRadius: 1, cursor: 'pointer',
                        bgcolor: sel ? 'primary.50' : 'transparent', outline: sel ? '1px solid' : 'none', outlineColor: 'primary.light',
                        opacity: el.hidden ? 0.5 : 1, '&:hover': { bgcolor: sel ? 'primary.50' : 'action.hover' },
                      }}
                    >
                      <Typography variant="body2" noWrap sx={{ flex: 1, fontSize: 12.5 }}>{elementTitle(el)}</Typography>
                      {el.protected && <Tooltip title="Core section — asks before deleting"><Shield sx={{ fontSize: 14, color: 'text.disabled' }} /></Tooltip>}
                      <Tooltip title={el.hidden ? 'Show' : 'Hide'}>
                        <IconButton size="small" disabled={readOnly} onClick={(e) => { e.stopPropagation(); onElementPatch(el.id, { hidden: !el.hidden }); }}>
                          {el.hidden ? <VisibilityOff sx={{ fontSize: 15 }} /> : <Visibility sx={{ fontSize: 15 }} />}
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={el.locked ? 'Unlock' : 'Lock position'}>
                        <IconButton size="small" disabled={readOnly} onClick={(e) => { e.stopPropagation(); onElementPatch(el.id, { locked: !el.locked }); }}>
                          {el.locked ? <Lock sx={{ fontSize: 15 }} /> : <LockOpen sx={{ fontSize: 15 }} />}
                        </IconButton>
                      </Tooltip>
                      <IconButton size="small" disabled={readOnly} onClick={(e) => { e.stopPropagation(); onReorder([el.id], 'up'); }}><KeyboardArrowUp sx={{ fontSize: 15 }} /></IconButton>
                      <IconButton size="small" disabled={readOnly} onClick={(e) => { e.stopPropagation(); onReorder([el.id], 'down'); }}><KeyboardArrowDown sx={{ fontSize: 15 }} /></IconButton>
                    </Stack>
                  );
                })}
              </Box>
            );
          })}
        </Box>
      )}
    </Box>
  );
}

export { DRAG_TYPE };
