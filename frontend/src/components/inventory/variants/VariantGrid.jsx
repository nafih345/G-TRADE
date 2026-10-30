import React, { memo, useCallback, useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Box, Checkbox, IconButton, Paper, Popper, Tooltip, Typography } from '@mui/material';
import {
  ContentCopy as DuplicateIcon,
  DeleteOutline as DeleteIcon,
  ArrowUpward as AscIcon,
  ArrowDownward as DescIcon,
  ErrorOutline as ErrorIcon
} from '@mui/icons-material';

// Spreadsheet-style editor for the variant rows. Rendered through @tanstack/react-virtual so a
// few thousand variants stay smooth; cells are plain <input>s (one MUI TextField per cell would
// be far too heavy at this size). Columns: [{ key, label, width, align, attr, readOnly(row), options(row) }].
// `options(row)` returns [{ label, items: string[] }] sections and turns the cell into a combobox:
// one shared dropdown (not one per cell) opens on focus with the full list, filters as you type,
// ↑/↓ pick, Enter takes the highlighted value and moves on, Esc closes. Free text still works.

const ROW_H = 34;
const FIXED = [
  { key: '_sel', width: 40 },
  { key: '_num', width: 48 },
];
const ACTIONS_W = 72;

const cellValue = (row, col) => (col.attr ? (row.attributes?.[col.attr] ?? '') : (row[col.key] ?? ''));
const cellError = (errs, col) => errs && (col.attr ? errs.attributes : errs[col.key]);

// Dropdown sections for a combobox cell, de-duplicated across sections and filtered by `query`
// (null = the cell was just entered, so show everything).
const comboSections = (col, row, query) => {
  if (!col?.options || !row) return [];
  const q = query == null ? '' : query.trim().toLowerCase();
  const seen = new Set();
  return col.options(row).map(sec => ({
    label: sec.label,
    items: (sec.items || []).filter(v => {
      const k = String(v).toLowerCase();
      if (!k || seen.has(k) || (q && !k.includes(q))) return false;
      seen.add(k);
      return true;
    }),
  })).filter(sec => sec.items.length);
};

const Row = memo(function Row({ row, index, columns, template, errs, selected, top, onToggle, onChange, onDuplicate, onDelete, lowStock }) {
  const errText = errs ? Object.values(errs).join('\n') : '';
  return (
    <div
      className={`vg-row${selected ? ' vg-selected' : ''}${errs ? ' vg-invalid' : ''}${row.id ? ' vg-saved' : ''}`}
      style={{ transform: `translateY(${top}px)`, gridTemplateColumns: template }}
      role="row"
      aria-rowindex={index + 2}
    >
      <div className="vg-cell vg-center">
        <Checkbox size="small" checked={selected} onChange={() => onToggle(row._rid)} inputProps={{ 'aria-label': `Select row ${index + 1}`, tabIndex: -1 }} sx={{ p: 0.25 }} />
      </div>
      <div className="vg-cell vg-center vg-num" title={errText || (row.id ? 'Saved in Product Master' : 'New item')}>
        {errs ? <ErrorIcon color="error" sx={{ fontSize: 16 }} /> : index + 1}
      </div>
      {columns.map((col, c) => {
        const err = cellError(errs, col);
        const ro = col.readOnly ? col.readOnly(row) : false;
        if (col.display) {
          const low = col.key === 'stock' && lowStock(row);
          return (
            <div key={col.key} className={`vg-cell vg-display${low ? ' vg-low' : ''}`} style={{ justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start' }} title={low ? 'Low stock' : undefined}>
              {col.display(row)}
            </div>
          );
        }
        return (
          <div key={col.key} className={`vg-cell${err ? ' vg-err' : ''}`}>
            <input
              className="vg-input"
              data-r={index}
              data-c={c}
              value={cellValue(row, col)}
              placeholder={col.placeholder ? col.placeholder(row) : ''}
              readOnly={ro}
              autoComplete="off"
              role={col.options && !ro ? 'combobox' : undefined}
              inputMode={col.numeric ? 'decimal' : undefined}
              aria-label={`${col.label} row ${index + 1}`}
              aria-invalid={Boolean(err)}
              title={err || (ro ? `${col.label} can't be changed here` : '')}
              style={{ textAlign: col.align || 'left' }}
              onChange={(e) => onChange(row._rid, col.attr ? `attr:${col.attr}` : col.key, e.target.value)}
            />
          </div>
        );
      })}
      <div className="vg-cell vg-center">
        <Tooltip title="Duplicate row (Ctrl+D)"><IconButton size="small" tabIndex={-1} onClick={() => onDuplicate(row._rid)}><DuplicateIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
        <Tooltip title="Remove row"><IconButton size="small" tabIndex={-1} color="error" onClick={() => onDelete(row._rid)}><DeleteIcon sx={{ fontSize: 16 }} /></IconButton></Tooltip>
      </div>
    </div>
  );
});

const VariantGrid = forwardRef(function VariantGrid({
  rows, columns, errors, selected, onToggle, onToggleAll, onChange, onDuplicate, onDelete,
  sort, onSort, onActiveRow, emptyState, height = 360
}, ref) {
  const scrollRef = useRef(null);
  const listRef = useRef(null);
  // Open combobox: { r, c, el, query }; hi = highlighted item index (-1 = none).
  const [combo, setCombo] = useState(null);
  const [hi, setHi] = useState(-1);
  const sections = combo ? comboSections(columns[combo.c], rows[combo.r], combo.query) : [];
  const items = sections.flatMap(sec => sec.items);
  const template = [...FIXED.map(f => `${f.width}px`), ...columns.map(c => `${c.width}px`), `${ACTIONS_W}px`].join(' ');
  const totalWidth = FIXED.reduce((s, f) => s + f.width, 0) + columns.reduce((s, c) => s + c.width, 0) + ACTIONS_W;

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  const focusCell = useCallback((r, c, attempt = 0) => {
    if (r < 0 || r >= rows.length) return;
    virtualizer.scrollToIndex(r, { align: 'auto' });
    requestAnimationFrame(() => {
      const el = scrollRef.current?.querySelector(`input[data-r="${r}"][data-c="${c}"]`);
      if (el) { el.focus(); el.select?.(); }
      else if (attempt < 3) setTimeout(() => focusCell(r, c, attempt + 1), 30);
    });
  }, [rows.length, virtualizer]);

  const inputCols = columns.map((col, i) => (col.display ? null : i)).filter(i => i !== null);

  useImperativeHandle(ref, () => ({
    focusCell,
    focusFirst: () => rows.length && focusCell(0, inputCols[0] ?? 0),
    focusRow: (r) => focusCell(r, inputCols[0] ?? 0),
    scrollToRow: (r) => virtualizer.scrollToIndex(r, { align: 'auto' }),
    container: () => scrollRef.current,
  }), [focusCell, rows.length, inputCols, virtualizer]);

  const onKeyDown = (e) => {
    if (onComboKeyDown(e)) return;
    const t = e.target;
    if (!t?.dataset || t.dataset.r === undefined || e.ctrlKey || e.altKey || e.metaKey) return;
    const r = Number(t.dataset.r), c = Number(t.dataset.c);
    const pos = inputCols.indexOf(c);
    const atStart = t.selectionStart === 0 && t.selectionEnd === 0;
    const atEnd = t.selectionStart === t.value.length && t.selectionEnd === t.value.length;
    const wholeSelected = t.selectionStart === 0 && t.selectionEnd === t.value.length;
    let next = null;
    if (e.key === 'ArrowDown') next = [r + 1, c];
    else if (e.key === 'ArrowUp') next = [r - 1, c];
    else if (e.key === 'ArrowRight' && (atEnd || wholeSelected) && pos < inputCols.length - 1) next = [r, inputCols[pos + 1]];
    else if (e.key === 'ArrowLeft' && (atStart || wholeSelected) && pos > 0) next = [r, inputCols[pos - 1]];
    else if (e.key === 'Enter' && !e.shiftKey) next = pos < inputCols.length - 1 ? [r, inputCols[pos + 1]] : [r + 1, inputCols[0]];
    else if (e.key === 'Enter' && e.shiftKey) next = pos > 0 ? [r, inputCols[pos - 1]] : [r - 1, inputCols[inputCols.length - 1]];
    if (!next) return;
    e.preventDefault();
    if (next[0] >= 0 && next[0] < rows.length) focusCell(next[0], next[1]);
  };

  const openCombo = (el) => {
    const r = Number(el.dataset.r), c = Number(el.dataset.c);
    const col = columns[c], row = rows[r];
    if (!col?.options || !row || (col.readOnly && col.readOnly(row))) { setCombo(null); return; }
    const cur = String(cellValue(row, col)).toLowerCase();
    setCombo({ r, c, el, query: null });
    setHi(cur ? comboSections(col, row, null).flatMap(sec => sec.items).findIndex(v => String(v).toLowerCase() === cur) : -1);
  };

  const choose = (value) => {
    const col = columns[combo.c], row = rows[combo.r];
    if (row) onChange(row._rid, col.attr ? `attr:${col.attr}` : col.key, value);
    setCombo(null);
  };

  useEffect(() => {
    if (hi >= 0) listRef.current?.querySelector(`[data-i="${hi}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [hi]);

  const onComboKeyDown = (e) => {
    const t = e.target;
    if (!combo || t !== combo.el) {
      if (e.altKey && e.key === 'ArrowDown' && t?.dataset?.r !== undefined) { e.preventDefault(); openCombo(t); return true; }
      return false;
    }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setCombo(null); return true; }
    if (!items.length || e.ctrlKey || e.metaKey) return false;
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(h => Math.min(h + 1, items.length - 1)); return true; }
    if (e.key === 'ArrowUp') { e.preventDefault(); setHi(h => Math.max(h - 1, 0)); return true; }
    if (e.key === 'Enter' && !e.shiftKey && hi >= 0 && items[hi] != null) choose(items[hi]); // then move on as usual
    return false;
  };

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r._rid));
  const someSelected = !allSelected && rows.some(r => selected.has(r._rid));
  const virtualItems = virtualizer.getVirtualItems();

  return (
    <Box
      sx={{
        border: 1, borderColor: 'divider', borderRadius: 2, overflow: 'hidden', bgcolor: 'background.paper',
        '& .vg-scroll': { height, overflow: 'auto', position: 'relative' },
        '& .vg-head, & .vg-row': { display: 'grid', alignItems: 'stretch', minWidth: totalWidth },
        '& .vg-head': { position: 'sticky', top: 0, zIndex: 2, bgcolor: 'action.hover', backdropFilter: 'blur(6px)', borderBottom: 1, borderColor: 'divider' },
        '& .vg-head .vg-cell': { fontSize: '0.72rem', fontWeight: 800, textTransform: 'uppercase', letterSpacing: 0.3, color: 'text.secondary', px: 0.75, py: 0.75, userSelect: 'none', bgcolor: 'background.paper' },
        '& .vg-sortable': { cursor: 'pointer', '&:hover': { color: 'primary.main' } },
        '& .vg-row': { position: 'absolute', left: 0, top: 0, height: ROW_H, borderBottom: 1, borderColor: 'divider' },
        '& .vg-row:hover': { bgcolor: 'action.hover' },
        '& .vg-selected': { bgcolor: 'action.selected' },
        '& .vg-invalid .vg-num': { boxShadow: (t) => `inset 3px 0 0 ${t.palette.error.main}` },
        '& .vg-cell': { display: 'flex', alignItems: 'center', minWidth: 0, borderRight: 1, borderColor: 'divider', overflow: 'hidden' },
        '& .vg-center': { justifyContent: 'center' },
        '& .vg-num': { fontSize: '0.75rem', color: 'text.secondary' },
        '& .vg-display': { px: 0.75, fontSize: '0.8rem', fontWeight: 700 },
        '& .vg-low': { color: 'error.main' },
        '& .vg-input': {
          width: '100%', height: '100%', border: 0, outline: 0, px: 0.75, font: 'inherit', fontSize: '0.8rem',
          color: 'text.primary', bgcolor: 'transparent',
          '&:focus': { boxShadow: (t) => `inset 0 0 0 2px ${t.palette.primary.main}`, bgcolor: 'background.paper' },
          '&[readonly]': { color: 'text.secondary', cursor: 'default' },
          '&::placeholder': { color: 'text.disabled', fontStyle: 'italic' },
        },
        '& .vg-err .vg-input': { boxShadow: (t) => `inset 0 0 0 1px ${t.palette.error.main}`, bgcolor: (t) => (t.palette.mode === 'dark' ? 'rgba(244,67,54,0.12)' : '#fef2f2') },
      }}
    >
      <div
        className="vg-scroll"
        ref={scrollRef}
        onKeyDown={onKeyDown}
        onFocus={(e) => { if (e.target?.dataset?.r !== undefined) openCombo(e.target); }}
        onBlur={(e) => setCombo(cb => (cb && cb.el === e.target ? null : cb))}
        onClick={(e) => { if (!combo && e.target?.dataset?.r !== undefined) openCombo(e.target); }}
        onInput={(e) => {
          if (!combo || e.target !== combo.el) return;
          setCombo(cb => ({ ...cb, query: e.target.value }));
          setHi(e.target.value ? 0 : -1);
        }} role="grid" aria-rowcount={rows.length + 1}>
        <div className="vg-head" style={{ gridTemplateColumns: template }} role="row">
          <div className="vg-cell vg-center">
            <Checkbox size="small" checked={allSelected} indeterminate={someSelected} onChange={(e) => onToggleAll(e.target.checked)} inputProps={{ 'aria-label': 'Select all rows' }} sx={{ p: 0.25 }} />
          </div>
          <div className="vg-cell vg-center">#</div>
          {columns.map(col => (
            <div
              key={col.key}
              className="vg-cell vg-sortable"
              role="columnheader"
              aria-sort={sort?.key === col.key ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
              onClick={() => onSort(col.key)}
              title="Sort"
              style={{ justifyContent: col.align === 'right' ? 'flex-end' : 'flex-start' }}
            >
              {col.label}
              {sort?.key === col.key && (sort.dir === 'asc' ? <AscIcon sx={{ fontSize: 13, ml: 0.25 }} /> : <DescIcon sx={{ fontSize: 13, ml: 0.25 }} />)}
            </div>
          ))}
          <div className="vg-cell vg-center">Actions</div>
        </div>

        {rows.length === 0 ? (
          <Box sx={{ py: 6, px: 2, textAlign: 'center', minWidth: totalWidth > 900 ? 900 : totalWidth }}>{emptyState}</Box>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative', minWidth: totalWidth }} onFocus={(e) => { const r = e.target?.dataset?.r; if (r !== undefined) onActiveRow?.(Number(r)); }}>
            {virtualItems.map(vi => {
              const row = rows[vi.index];
              return (
                <Row
                  key={row._rid}
                  row={row}
                  index={vi.index}
                  columns={columns}
                  template={template}
                  errs={errors[row._rid]}
                  selected={selected.has(row._rid)}
                  top={vi.start}
                  onToggle={onToggle}
                  onChange={onChange}
                  onDuplicate={onDuplicate}
                  onDelete={onDelete}
                  lowStock={lowStock}
                />
              );
            })}
          </div>
        )}
      </div>
      <Popper open={Boolean(combo && items.length)} anchorEl={combo?.el} placement="bottom-start" style={{ zIndex: 1400 }}>
        <Paper
          ref={listRef}
          elevation={6}
          role="listbox"
          onMouseDown={(e) => e.preventDefault()}
          sx={{ maxHeight: 260, overflow: 'auto', py: 0.5, minWidth: Math.max(combo?.el?.offsetWidth || 0, 200) }}
        >
          {(() => {
            let i = -1;
            return sections.map(sec => (
              <Box key={sec.label || '_'}>
                {sec.label && (
                  <Typography component="div" sx={{ px: 1.25, pt: 0.75, pb: 0.25, fontSize: '0.68rem', fontWeight: 800, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.3 }}>
                    {sec.label}
                  </Typography>
                )}
                {sec.items.map(v => {
                  i += 1;
                  const idx = i;
                  return (
                    <Box
                      key={v}
                      data-i={idx}
                      role="option"
                      aria-selected={idx === hi}
                      onMouseEnter={() => setHi(idx)}
                      onClick={() => choose(v)}
                      sx={{ px: 1.25, py: 0.5, fontSize: '0.8rem', cursor: 'pointer', bgcolor: idx === hi ? 'action.selected' : 'transparent' }}
                    >
                      {v}
                    </Box>
                  );
                })}
              </Box>
            ));
          })()}
        </Paper>
      </Popper>
      <Typography component="div" variant="caption" color="text.secondary" sx={{ px: 1.5, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
        {rows.length} row{rows.length === 1 ? '' : 's'} shown · ↑ ↓ ← → / Enter move between cells · list cells: ↑ ↓ pick, Enter take, Esc close · click a header to sort
      </Typography>
    </Box>
  );
});

const lowStock = (row) => row.id && row.stock != null && row.minimum_stock != null && row.stock <= row.minimum_stock;

export default VariantGrid;
