import React, { memo, useCallback, useImperativeHandle, useRef, forwardRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Box, Checkbox, IconButton, Tooltip, Typography } from '@mui/material';
import {
  ContentCopy as DuplicateIcon,
  DeleteOutline as DeleteIcon,
  ArrowUpward as AscIcon,
  ArrowDownward as DescIcon,
  ErrorOutline as ErrorIcon
} from '@mui/icons-material';

// Spreadsheet-style editor for the variant rows. Rendered through @tanstack/react-virtual so a
// few thousand variants stay smooth; cells are plain <input>s (one MUI TextField per cell would
// be far too heavy at this size). Columns: [{ key, label, width, align, attr, readOnly(row) }].

const ROW_H = 34;
const FIXED = [
  { key: '_sel', width: 40 },
  { key: '_num', width: 48 },
];
const ACTIONS_W = 72;

const cellValue = (row, col) => (col.attr ? (row.attributes?.[col.attr] ?? '') : (row[col.key] ?? ''));
const cellError = (errs, col) => errs && (col.attr ? errs.attributes : errs[col.key]);

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

  const allSelected = rows.length > 0 && rows.every(r => selected.has(r._rid));
  const someSelected = !allSelected && rows.some(r => selected.has(r._rid));
  const items = virtualizer.getVirtualItems();

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
      <div className="vg-scroll" ref={scrollRef} onKeyDown={onKeyDown} role="grid" aria-rowcount={rows.length + 1}>
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
            {items.map(vi => {
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
      <Typography component="div" variant="caption" color="text.secondary" sx={{ px: 1.5, py: 0.5, borderTop: 1, borderColor: 'divider' }}>
        {rows.length} row{rows.length === 1 ? '' : 's'} shown · ↑ ↓ ← → / Enter move between cells · click a header to sort
      </Typography>
    </Box>
  );
});

const lowStock = (row) => row.id && row.stock != null && row.minimum_stock != null && row.stock <= row.minimum_stock;

export default VariantGrid;
