import React, { useEffect, useRef, useState } from 'react';
import {
  Alert, Box, Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel,
  InputAdornment, LinearProgress, Link, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, Typography,
} from '@mui/material';
import { Search as SearchIcon } from '@mui/icons-material';
import { useDebounce } from '../../hooks/useDebounce';

const NO_DATES = { from: '', to: '' };

/**
 * The F1 selection popup of the Receipt / Payment / Contra vouchers (accounts, customers,
 * dealers, suppliers). Keyboard first: the search box has focus, ↑/↓ move the highlight,
 * Enter selects it, Esc cancels; a click highlights and a double-click selects.
 *
 *   columns:     [{ key, label, align, width, mono, render(row) }]
 *   fetchRows:   (search, toggleOn, dates) => Promise<{ rows, hasMore, note }> — called as the user types
 *   toggle:      optional { label, default } checkbox passed to fetchRows (e.g. "Only with dues")
 *   dateRange:   show From / To date inputs (passed to fetchRows as { from, to }); initialDates seeds them
 *   multiSelect: a tick column — Ctrl+Space or a click on the box ticks the highlighted row, the
 *                header box ticks every row shown. Ticks survive new searches, so a long list can be
 *                picked across several searches. onSelect then gets (rows[], { dates }); without
 *                ticks Enter selects just the highlighted row (still as a one-item array).
 *
 * data-own-enter keeps App.jsx's global Enter handler (which would click the first contained
 * button in a dialog) out of the way, so Enter always means "select".
 */
export default function VoucherSearchDialog({
  open, title, placeholder = 'Type to search…', columns, fetchRows, onSelect, onClose,
  rowKey = (r) => r.id, toggle, emptyText = 'No matching records.',
  multiSelect = false, dateRange = false, initialDates = NO_DATES,
}) {
  const [search, setSearch] = useState('');
  const [toggleOn, setToggleOn] = useState(!!toggle?.default);
  const [dates, setDates] = useState(initialDates);
  const [ticked, setTicked] = useState(() => new Map());
  const [rows, setRows] = useState([]);
  const [hasMore, setHasMore] = useState(false);
  const [note, setNote] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);
  const bodyRef = useRef(null);
  const debounced = useDebounce(search, 200);

  useEffect(() => {
    if (open) {
      setSearch(''); setActive(0); setError(''); setToggleOn(!!toggle?.default);
      setDates(initialDates || NO_DATES); setTicked(new Map());
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    Promise.resolve(fetchRows(debounced, toggleOn, dates))
      .then((res) => {
        if (cancelled) return;
        setRows(res?.rows || []);
        setHasMore(!!res?.hasMore);
        setNote(res?.note || '');
        setActive(0);
      })
      .catch((e) => { if (!cancelled) { setRows([]); setError(e?.message || 'Search failed.'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, debounced, toggleOn, dates.from, dates.to]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the highlighted row in view while arrowing through a long list.
  useEffect(() => {
    const el = bodyRef.current?.querySelector(`[data-row-index="${active}"]`);
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const toggleRow = (row) => {
    if (!row) return;
    setTicked((prev) => {
      const next = new Map(prev);
      const k = rowKey(row);
      if (next.has(k)) next.delete(k); else next.set(k, row);
      return next;
    });
  };
  const allShownTicked = rows.length > 0 && rows.every((r) => ticked.has(rowKey(r)));
  const someShownTicked = rows.some((r) => ticked.has(rowKey(r)));
  const tickAllShown = (on) => setTicked((prev) => {
    const next = new Map(prev);
    rows.forEach((r) => (on ? next.set(rowKey(r), r) : next.delete(rowKey(r))));
    return next;
  });

  const choose = (row) => {
    if (!multiSelect) { if (row) onSelect(row, { dates }); return; }
    const picked = ticked.size ? Array.from(ticked.values()) : (row ? [row] : []);
    if (picked.length) onSelect(picked, { dates });
  };

  const handleKeyDown = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => Math.min(i + 1, rows.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
    else if (e.key === 'PageDown') { e.preventDefault(); setActive((i) => Math.min(i + 10, rows.length - 1)); }
    else if (e.key === 'PageUp') { e.preventDefault(); setActive((i) => Math.max(i - 10, 0)); }
    else if (e.key === ' ' && e.ctrlKey && multiSelect) { e.preventDefault(); toggleRow(rows[active]); }
    else if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); choose(rows[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
    else if (e.key === 'F1') { e.preventDefault(); inputRef.current?.focus(); }
  };

  const dateField = (keyName, label) => (
    <TextField
      type="date" size="small" label={label} value={dates[keyName]} InputLabelProps={{ shrink: true }}
      inputProps={{ 'aria-label': `${label} date`, max: keyName === 'from' && dates.to ? dates.to : undefined, min: keyName === 'to' && dates.from ? dates.from : undefined }}
      onChange={(e) => setDates((d) => ({ ...d, [keyName]: e.target.value }))}
      sx={{ width: { xs: '100%', sm: 160 }, flexShrink: 0 }}
    />
  );

  const colSpan = columns.length + (multiSelect ? 1 : 0);

  return (
    <Dialog
      open={open} onClose={onClose} maxWidth="lg" fullWidth disableRestoreFocus
      TransitionProps={{ onEntered: () => inputRef.current?.focus() }}
      PaperProps={{
        'data-own-enter': 'true', onKeyDown: handleKeyDown,
        // Resizable from the bottom-right corner, like the desktop ERP's pickers.
        sx: { borderRadius: 3, resize: 'both', overflow: 'hidden', minWidth: { xs: 'calc(100% - 32px)', sm: 640 }, minHeight: 360, maxHeight: '90vh', display: 'flex', flexDirection: 'column' },
      }}
    >
      <DialogTitle sx={{ py: 1.5, fontWeight: 850, bgcolor: '#f8fafc', borderBottom: '1px solid #e2e8f0' }}>
        <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}>
          <span>{title}</span>
          <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 700, textAlign: 'right' }}>
            ↑/↓ move{multiSelect ? ' · Ctrl+Space tick' : ''} · Enter select · Esc cancel
          </Typography>
        </Stack>
      </DialogTitle>
      <Box sx={{ px: 2, pt: 1.5, pb: 1 }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }}>
          <TextField
            inputRef={inputRef} fullWidth size="small" autoComplete="off" value={search} placeholder={placeholder}
            onChange={(e) => setSearch(e.target.value)}
            inputProps={{ 'aria-label': 'Search' }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }}
          />
          {dateRange && (
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
              {dateField('from', 'Bill From')}
              {dateField('to', 'Bill To')}
              {(dates.from || dates.to) && (
                <Link component="button" type="button" variant="caption" underline="hover" tabIndex={-1}
                  onClick={() => setDates(NO_DATES)} sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>
                  Clear
                </Link>
              )}
            </Stack>
          )}
          {toggle && (
            <FormControlLabel
              sx={{ whiteSpace: 'nowrap', mr: 0 }}
              control={<Checkbox size="small" checked={toggleOn} onChange={(e) => setToggleOn(e.target.checked)} tabIndex={-1} />}
              label={<Typography variant="body2" fontWeight={700}>{toggle.label}</Typography>}
            />
          )}
        </Stack>
      </Box>
      <Box sx={{ height: 4 }}>{loading && <LinearProgress />}</Box>
      <DialogContent sx={{ p: 0, flex: 1, minHeight: 0 }}>
        {error ? (
          <Alert severity="error" sx={{ m: 2 }}>{error}</Alert>
        ) : (
          <TableContainer sx={{ height: '100%', maxHeight: '100%' }}>
            <Table size="small" stickyHeader>
              <TableHead>
                <TableRow>
                  {multiSelect && (
                    <TableCell padding="checkbox" sx={{ bgcolor: '#f1f5f9' }}>
                      <Checkbox size="small" tabIndex={-1} checked={allShownTicked} indeterminate={!allShownTicked && someShownTicked}
                        disabled={!rows.length} onChange={(e) => tickAllShown(e.target.checked)}
                        inputProps={{ 'aria-label': 'Tick all shown' }} />
                    </TableCell>
                  )}
                  {columns.map((c) => (
                    <TableCell key={c.key} align={c.align} sx={{ fontWeight: 800, bgcolor: '#f1f5f9', width: c.width, whiteSpace: 'nowrap' }}>
                      {c.label}
                    </TableCell>
                  ))}
                </TableRow>
              </TableHead>
              <TableBody ref={bodyRef}>
                {rows.map((row, i) => {
                  const isTicked = multiSelect && ticked.has(rowKey(row));
                  return (
                    <TableRow
                      key={rowKey(row)} data-row-index={i} hover selected={i === active}
                      onClick={() => { setActive(i); inputRef.current?.focus(); }}
                      onDoubleClick={() => (multiSelect && ticked.size ? toggleRow(row) : choose(row))}
                      sx={{
                        cursor: 'pointer',
                        bgcolor: isTicked ? '#eff6ff' : undefined,
                        '&.Mui-selected, &.Mui-selected:hover': { bgcolor: '#dbeafe' },
                      }}
                    >
                      {multiSelect && (
                        <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
                          <Checkbox size="small" tabIndex={-1} checked={isTicked}
                            onChange={() => { toggleRow(row); setActive(i); inputRef.current?.focus(); }}
                            inputProps={{ 'aria-label': `Tick ${row.name || rowKey(row)}` }} />
                        </TableCell>
                      )}
                      {columns.map((c) => (
                        <TableCell key={c.key} align={c.align}
                          sx={{ py: 0.6, fontFamily: c.mono ? 'monospace' : undefined, fontWeight: c.mono ? 700 : 500, whiteSpace: 'nowrap' }}>
                          {c.render ? c.render(row) : (row[c.key] ?? '')}
                        </TableCell>
                      ))}
                    </TableRow>
                  );
                })}
                {!loading && rows.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={colSpan} align="center" sx={{ py: 4, color: 'text.secondary' }}>{emptyText}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 2, py: 1.25, borderTop: '1px solid #e2e8f0', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ fontWeight: 600 }}>
          {rows.length} shown{hasMore ? ' — more match; refine the search' : ''}{note ? ` · ${note}` : ''}
          {multiSelect && ticked.size > 0 && (
            <>
              {' · '}<b style={{ color: '#1d4ed8' }}>{ticked.size} ticked</b>{' '}
              <Link component="button" type="button" variant="caption" underline="hover" tabIndex={-1} onClick={() => setTicked(new Map())} sx={{ fontWeight: 700 }}>
                Clear ticks
              </Link>
            </>
          )}
        </Typography>
        <Stack direction="row" spacing={1}>
          <Button onClick={onClose} variant="outlined">Cancel</Button>
          <Button onClick={() => choose(rows[active])} variant="contained" disabled={!rows[active] && !ticked.size} sx={{ backgroundColor: '#2563eb', fontWeight: 800 }}>
            {multiSelect && ticked.size ? `Select ${ticked.size}` : 'Select'}
          </Button>
        </Stack>
      </DialogActions>
    </Dialog>
  );
}
