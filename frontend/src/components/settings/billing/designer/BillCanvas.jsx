// Interactive bill canvas: the real rendered page (same renderer as printing, page 1 of the
// design layout) with an editing overlay on top. Geometry is in mm; the overlay converts
// pointer pixels with the current zoom.
//
//  * click / shift-click selects, drag moves, 8 handles resize (snaps to grid, page and
//    sibling edges / centres, with pink guides);
//  * dragging an element into another section moves it there;
//  * the section boundaries (header bottom, summary bottom, footer top) drag to resize;
//  * the items table is a fixed block — click it to edit columns and styling.
import React, { useMemo, useRef, useState } from 'react';
import { Box, Typography } from '@mui/material';
import { snapBox, r2, round, BAND_LABELS } from '../../../../billing/billLayout';
import { PX_PER_MM } from '../../../../billing/renderBillLayout';

const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN = 1;
export const ITEMS_ID = '__items';

export default function BillCanvas({
  template, pageHtml, css, geometry, bandRects, zoom, showGrid, snap,
  selection, onSelect, onLiveChange, onCommitChange, onDropNew, problemIds, onMoveToBand,
}) {
  const g = geometry;
  const k = PX_PER_MM * zoom;
  const cfg = template.config;
  const [guides, setGuides] = useState([]);
  const drag = useRef(null);
  const overlayRef = useRef(null);
  const ox = g.margins.left;
  const oy = g.margins.top;

  const gridBg = useMemo(() => {
    if (!showGrid) return 'none';
    const minor = 1 * k;
    const major = 10 * k;
    return `linear-gradient(to right, rgba(37,99,235,0.16) 1px, transparent 1px) ${ox * k}px ${oy * k}px / ${major}px ${major}px,`
      + `linear-gradient(to bottom, rgba(37,99,235,0.16) 1px, transparent 1px) ${ox * k}px ${oy * k}px / ${major}px ${major}px,`
      + (zoom >= 1.2
        ? `linear-gradient(to right, rgba(100,116,139,0.08) 1px, transparent 1px) ${ox * k}px ${oy * k}px / ${minor}px ${minor}px,`
          + `linear-gradient(to bottom, rgba(100,116,139,0.08) 1px, transparent 1px) ${ox * k}px ${oy * k}px / ${minor}px ${minor}px`
        : 'none');
  }, [showGrid, k, ox, oy, zoom]);

  const elementsOf = (band) => cfg.bands[band]?.elements || [];

  const stopListening = () => {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
  };

  // ---- element drag / resize ---------------------------------------------------
  const startDrag = (e, el, band, handle) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    let ids = selection;
    if (!selection.includes(el.id)) {
      ids = additive ? [...selection.filter((s) => s !== ITEMS_ID), el.id] : [el.id];
      onSelect(ids);
    } else if (additive && !handle) {
      onSelect(selection.filter((id) => id !== el.id));
      return;
    }
    if (el.locked) return;
    const movable = ids.filter((id) => id !== ITEMS_ID);
    const origin = {};
    ['header', 'summary', 'footer'].forEach((b) => elementsOf(b).forEach((x) => {
      if (movable.includes(x.id)) origin[x.id] = { ...x, band: b };
    }));
    drag.current = { kind: 'el', handle, id: el.id, band, ids: movable, startX: e.clientX, startY: e.clientY, origin, before: template, moved: false };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  // ---- band boundary drag ---------------------------------------------------------
  const startBandDrag = (e, band) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    drag.current = { kind: 'band', band, startY: e.clientY, startH: cfg.bands[band].height, before: template, moved: false };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };

  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - (d.startX ?? e.clientX)) / k;
    const dy = (e.clientY - d.startY) / k;
    if (!d.moved && Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) return;
    d.moved = true;

    if (d.kind === 'band') {
      // Footer grows upwards (its top edge is the handle); header / summary grow downwards.
      const delta = d.band === 'footer' ? -dy : dy;
      const h = Math.max(0, snap ? round(d.startH + delta, 0.5) : r2(d.startH + delta));
      onLiveChange((t) => ({ ...t, config: { ...t.config, bands: { ...t.config.bands, [d.band]: { ...t.config.bands[d.band], height: h } } } }));
      return;
    }

    const o = d.origin[d.id];
    const bandH = cfg.bands[d.band]?.height || 0;
    const others = elementsOf(d.band).filter((x) => !d.ids.includes(x.id) && !x.hidden);
    const patch = {};
    let gl = [];
    if (!d.handle) {
      const raw = { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h };
      const s = snap ? snapBox(raw, { others, W: g.contentW, H: bandH, grid: e.altKey ? 0.1 : 0.5 }) : { x: r2(raw.x), y: r2(raw.y), guides: [] };
      gl = s.guides.map((x) => ({ ...x, band: d.band }));
      Object.values(d.origin).forEach((src) => {
        if (!src.locked) patch[src.id] = { x: r2(src.x + (s.x - o.x)), y: r2(src.y + (s.y - o.y)) };
      });
    } else {
      let { x, y, w, h } = o;
      const q = (v) => (snap && !e.altKey ? round(v, 0.5) : r2(v));
      if (d.handle.includes('e')) w = Math.max(MIN, q(o.x + o.w + dx) - o.x);
      if (d.handle.includes('s')) h = Math.max(o.type === 'line' ? 0.3 : MIN, q(o.y + o.h + dy) - o.y);
      if (d.handle.includes('w')) { const nx = Math.min(q(o.x + dx), o.x + o.w - MIN); w = o.x + o.w - nx; x = nx; }
      if (d.handle.includes('n')) { const ny = Math.min(q(o.y + dy), o.y + o.h - MIN); h = o.y + o.h - ny; y = ny; }
      patch[d.id] = { x: r2(x), y: r2(y), w: r2(w), h: r2(h) };
    }
    setGuides(gl);
    onLiveChange((t) => {
      const bands = { ...t.config.bands };
      ['header', 'summary', 'footer'].forEach((b) => {
        bands[b] = { ...bands[b], elements: bands[b].elements.map((x) => (patch[x.id] ? { ...x, ...patch[x.id] } : x)) };
      });
      return { ...t, config: { ...t.config, bands } };
    });
  };

  const onUp = (e) => {
    stopListening();
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    if (!d?.moved) return;
    onCommitChange(d.before);
    if (d.kind === 'el' && !d.handle && overlayRef.current) {
      // Dropped over a different section? Move the dragged element(s) there.
      const rect = overlayRef.current.getBoundingClientRect();
      const yMm = (e.clientY - rect.top) / k - oy;
      const target = ['header', 'summary', 'footer'].find((b) => {
        const r = bandRects[b];
        return r && yMm >= r.top && yMm <= r.top + Math.max(r.height, 2);
      });
      if (target && target !== d.band) onMoveToBand(d.ids, d.band, target);
    }
  };

  // ---- palette drop ---------------------------------------------------------------
  const handleDrop = (e) => {
    const raw = e.dataTransfer.getData('application/x-bill-element');
    if (!raw) return;
    e.preventDefault();
    const rect = overlayRef.current.getBoundingClientRect();
    const xMm = (e.clientX - rect.left) / k - ox;
    const yMm = (e.clientY - rect.top) / k - oy;
    let band = ['header', 'summary', 'footer'].find((b) => {
      const r = bandRects[b];
      return r && yMm >= r.top && yMm <= r.top + Math.max(r.height, 3);
    });
    if (!band) band = yMm < (bandRects.items?.top ?? 0) ? 'header' : 'summary';
    const r = bandRects[band] || { top: 0 };
    onDropNew(JSON.parse(raw), band, r2(xMm), r2(yMm - r.top));
  };

  const px = (mmV) => mmV * k;

  // ---- render ---------------------------------------------------------------------
  const bandBox = (band) => {
    const r = bandRects[band];
    if (!r) return null;
    const isFooter = band === 'footer';
    const edgeTop = isFooter ? r.top : r.top + r.height;
    return (
      <React.Fragment key={band}>
        <Box
          sx={{
            position: 'absolute', left: px(ox), width: px(g.contentW), top: px(oy + r.top), height: Math.max(1, px(r.height)),
            outline: '1px dashed rgba(100,116,139,0.45)', pointerEvents: 'none',
          }}
        >
          <Typography
            variant="caption"
            sx={{ position: 'absolute', right: '100%', mr: 0.5, top: 0, fontSize: 10, color: '#64748b', whiteSpace: 'nowrap', bgcolor: 'rgba(255,255,255,0.8)', px: 0.5, borderRadius: 0.5, lineHeight: 1.4 }}
          >
            {BAND_LABELS[band]}
          </Typography>
        </Box>
        <Box
          data-testid={`band-handle-${band}`}
          title={`Drag to resize the ${BAND_LABELS[band].toLowerCase()} (${r2(cfg.bands[band].height)} mm)`}
          onPointerDown={(e) => startBandDrag(e, band)}
          sx={{
            position: 'absolute', left: px(ox), width: px(g.contentW), top: px(oy + edgeTop) - 4, height: 8, cursor: 'ns-resize', zIndex: 3,
            '&:hover::after, &:active::after': { content: '""', position: 'absolute', left: 0, right: 0, top: 3, borderTop: '2px solid #f59e0b' },
          }}
        />
      </React.Fragment>
    );
  };

  const elementBoxes = (band) => {
    const r = bandRects[band];
    if (!r) return null;
    return elementsOf(band).filter((el) => !el.hidden).map((el) => {
      const selected = selection.includes(el.id);
      const problem = problemIds.has(el.id);
      const single = selected && selection.length === 1;
      return (
        <Box
          key={el.id}
          data-el={el.id}
          data-testid={`el-${el.id}`}
          onPointerDown={(e) => startDrag(e, el, band, null)}
          onDoubleClick={(e) => { e.stopPropagation(); onSelect([el.id], { focusProps: true }); }}
          sx={{
            position: 'absolute',
            left: px(ox + el.x), top: px(oy + r.top + el.y), width: Math.max(4, px(el.w)), height: Math.max(4, px(el.h)),
            cursor: el.locked ? 'default' : 'move', zIndex: 2,
            outline: selected ? '1.5px solid #2563eb' : problem ? '1.5px dashed #dc2626' : '1px dashed transparent',
            bgcolor: selected ? 'rgba(37,99,235,0.07)' : 'transparent',
            '&:hover': { outline: selected ? '1.5px solid #2563eb' : '1px dashed #60a5fa' },
          }}
        >
          {single && !el.locked && HANDLES.map((hd) => (
            <Box
              key={hd}
              onPointerDown={(e) => startDrag(e, el, band, hd)}
              sx={{
                position: 'absolute', width: 8, height: 8, bgcolor: '#fff', border: '1.5px solid #2563eb', borderRadius: '2px',
                left: hd.includes('w') ? -5 : hd.includes('e') ? 'calc(100% - 3px)' : 'calc(50% - 4px)',
                top: hd.includes('n') ? -5 : hd.includes('s') ? 'calc(100% - 3px)' : 'calc(50% - 4px)',
                cursor: `${hd}-resize`,
              }}
            />
          ))}
          {el.locked && selected && <Box sx={{ position: 'absolute', right: 1, top: 1, fontSize: 10, lineHeight: 1 }}>🔒</Box>}
        </Box>
      );
    });
  };

  const items = bandRects.items;
  const itemsSelected = selection.includes(ITEMS_ID);

  return (
    <Box sx={{ position: 'relative', width: px(g.pageW), height: px(g.pageH), flex: '0 0 auto', boxShadow: '0 2px 14px rgba(15,23,42,0.22)', bgcolor: '#fff' }}>
      <style>{css}</style>
      <Box
        className="bd-root"
        sx={{ position: 'absolute', top: 0, left: 0, transform: `scale(${zoom})`, transformOrigin: '0 0', pointerEvents: 'none' }}
        dangerouslySetInnerHTML={{ __html: pageHtml }}
      />
      <Box
        ref={overlayRef}
        data-testid="bill-canvas"
        onPointerDown={(e) => { if (e.target === overlayRef.current) onSelect([]); }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-bill-element')) e.preventDefault(); }}
        onDrop={handleDrop}
        sx={{ position: 'absolute', inset: 0, background: gridBg, touchAction: 'none' }}
      >
        {/* margins */}
        <Box sx={{ position: 'absolute', left: px(ox), top: px(oy), width: px(g.contentW), height: px(g.contentH), outline: '1px dashed rgba(220,38,38,0.35)', pointerEvents: 'none' }} />
        {['header', 'summary', 'footer'].map(bandBox)}
        {items && (
          <Box
            data-testid="items-table"
            onPointerDown={(e) => { e.stopPropagation(); onSelect([ITEMS_ID]); }}
            title="Items table — click to edit columns and styling"
            sx={{
              position: 'absolute', left: px(ox), width: px(g.contentW), top: px(oy + items.top), height: Math.max(6, px(items.height)),
              cursor: 'pointer', zIndex: 1,
              outline: itemsSelected ? '2px solid #7c3aed' : '1px dashed rgba(124,58,237,0.45)',
              bgcolor: itemsSelected ? 'rgba(124,58,237,0.05)' : 'transparent',
              '&:hover': { outline: itemsSelected ? '2px solid #7c3aed' : '1.5px dashed #7c3aed' },
            }}
          >
            <Typography variant="caption" sx={{ position: 'absolute', right: '100%', mr: 0.5, top: 0, fontSize: 10, color: '#7c3aed', whiteSpace: 'nowrap', bgcolor: 'rgba(255,255,255,0.8)', px: 0.5, borderRadius: 0.5, lineHeight: 1.4 }}>
              Items table
            </Typography>
          </Box>
        )}
        {['header', 'summary', 'footer'].map(elementBoxes)}
        {guides.map((gd, i) => {
          const r = bandRects[gd.band] || { top: 0, height: 0 };
          return (
            <Box
              key={i}
              sx={gd.axis === 'x'
                ? { position: 'absolute', top: px(oy + r.top) - 6, height: px(r.height) + 12, left: px(ox + gd.at), borderLeft: '1px solid #ec4899', pointerEvents: 'none', zIndex: 4 }
                : { position: 'absolute', left: px(ox) - 6, width: px(g.contentW) + 12, top: px(oy + r.top + gd.at), borderTop: '1px solid #ec4899', pointerEvents: 'none', zIndex: 4 }}
            />
          );
        })}
      </Box>
    </Box>
  );
}
