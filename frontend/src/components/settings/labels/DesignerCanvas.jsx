// Interactive label canvas: the real rendered label (same renderer as printing) with a
// selection / drag / resize overlay on top. All geometry is in mm; the overlay converts
// pointer pixels with the current zoom. Snaps to the grid and to label / element edges and
// centres, drawing alignment guides while dragging.
import React, { useMemo, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { snapPosition, round, r2 } from '../../../labels/labelModel';

export const PX_PER_MM = 96 / 25.4;
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const MIN = 0.5;

export default function DesignerCanvas({
  template, labelHtml, css, zoom, showGrid, snap, gridMm = 0.5,
  selection, onSelect, onLiveChange, onCommitChange, onDropElement, problemIds,
}) {
  const W = template.width_mm;
  const H = template.height_mm;
  const k = PX_PER_MM * zoom;
  const pad = template.layout?.paddingMm || 0;
  const elements = template.layout?.elements || [];
  const [guides, setGuides] = useState([]);
  const drag = useRef(null);
  const overlayRef = useRef(null);

  const gridBg = useMemo(() => {
    if (!showGrid) return 'none';
    const step = Math.max(gridMm, 1) * k;
    const major = 5 * k;
    return `linear-gradient(to right, rgba(37,99,235,0.18) 1px, transparent 1px) 0 0 / ${major}px ${major}px,` +
      `linear-gradient(to bottom, rgba(37,99,235,0.18) 1px, transparent 1px) 0 0 / ${major}px ${major}px,` +
      `linear-gradient(to right, rgba(100,116,139,0.10) 1px, transparent 1px) 0 0 / ${step}px ${step}px,` +
      `linear-gradient(to bottom, rgba(100,116,139,0.10) 1px, transparent 1px) 0 0 / ${step}px ${step}px`;
  }, [showGrid, gridMm, k]);

  const startDrag = (e, el, handle) => {
    e.stopPropagation();
    e.preventDefault();
    const additive = e.shiftKey || e.ctrlKey || e.metaKey;
    let ids = selection;
    if (!selection.includes(el.id)) {
      ids = additive ? [...selection, el.id] : [el.id];
      onSelect(ids);
    } else if (additive && !handle) {
      onSelect(selection.filter((id) => id !== el.id));
      return;
    }
    if (el.locked) return;
    drag.current = {
      handle, id: el.id, ids,
      startX: e.clientX, startY: e.clientY,
      origin: Object.fromEntries(elements.filter((x) => ids.includes(x.id)).map((x) => [x.id, { ...x }])),
      before: template,
      moved: false,
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  const onMove = (e) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.startX) / k;
    const dy = (e.clientY - d.startY) / k;
    if (!d.moved && Math.abs(dx) < 0.15 && Math.abs(dy) < 0.15) return;
    d.moved = true;
    const o = d.origin[d.id];
    const others = elements.filter((x) => !d.ids.includes(x.id) && !x.hidden);
    let patch = {};
    let g = [];
    if (!d.handle) {
      const raw = { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h };
      const s = snap ? snapPosition(raw, { others, W, H, grid: gridMm }) : { x: r2(raw.x), y: r2(raw.y), guides: [] };
      const ddx = s.x - o.x;
      const ddy = s.y - o.y;
      g = s.guides;
      for (const id of d.ids) {
        const src = d.origin[id];
        if (src && !src.locked) patch[id] = { x: r2(src.x + ddx), y: r2(src.y + ddy) };
      }
    } else {
      let { x, y, w, h } = o;
      const q = (v) => (snap ? round(v, gridMm) : r2(v));
      if (d.handle.includes('e')) w = Math.max(MIN, q(o.x + o.w + dx) - o.x);
      if (d.handle.includes('s')) h = Math.max(MIN, q(o.y + o.h + dy) - o.y);
      if (d.handle.includes('w')) { const nx = Math.min(q(o.x + dx), o.x + o.w - MIN); w = o.x + o.w - nx; x = nx; }
      if (d.handle.includes('n')) { const ny = Math.min(q(o.y + dy), o.y + o.h - MIN); h = o.y + o.h - ny; y = ny; }
      patch[d.id] = { x: r2(x), y: r2(y), w: r2(w), h: r2(h) };
    }
    setGuides(g);
    onLiveChange((t) => ({
      ...t,
      layout: { ...t.layout, elements: t.layout.elements.map((x) => (patch[x.id] ? { ...x, ...patch[x.id] } : x)) },
    }));
  };

  const onUp = () => {
    window.removeEventListener('pointermove', onMove);
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    if (d?.moved) onCommitChange(d.before);
  };

  const handleDrop = (e) => {
    const raw = e.dataTransfer.getData('application/x-label-element');
    if (!raw) return;
    e.preventDefault();
    const rect = overlayRef.current.getBoundingClientRect();
    onDropElement(JSON.parse(raw), r2((e.clientX - rect.left) / k), r2((e.clientY - rect.top) / k));
  };

  const box = (el) => ({ left: el.x * k, top: el.y * k, width: el.w * k, height: el.h * k });

  return (
    <Box sx={{ position: 'relative', width: W * k, height: H * k, flex: '0 0 auto', boxShadow: '0 2px 12px rgba(15,23,42,0.22)', bgcolor: '#fff' }}>
      <style>{css}</style>
      <Box
        sx={{ position: 'absolute', top: 0, left: 0, transform: `scale(${zoom})`, transformOrigin: '0 0', pointerEvents: 'none' }}
        dangerouslySetInnerHTML={{ __html: labelHtml }}
      />
      <Box
        ref={overlayRef}
        onPointerDown={(e) => { if (e.target === overlayRef.current) onSelect([]); }}
        onDragOver={(e) => { if (e.dataTransfer.types.includes('application/x-label-element')) e.preventDefault(); }}
        onDrop={handleDrop}
        sx={{ position: 'absolute', inset: 0, background: gridBg, touchAction: 'none' }}
        data-testid="label-canvas"
      >
        {pad > 0 && (
          <Box sx={{ position: 'absolute', left: pad * k, top: pad * k, right: pad * k, bottom: pad * k, border: '1px dashed rgba(220,38,38,0.35)', pointerEvents: 'none' }} />
        )}
        {elements.filter((el) => !el.hidden).map((el) => {
          const selected = selection.includes(el.id);
          const problem = problemIds.has(el.id);
          return (
            <Box
              key={el.id}
              data-el={el.id}
              onPointerDown={(e) => startDrag(e, el, null)}
              sx={{
                position: 'absolute', ...box(el),
                cursor: el.locked ? 'default' : 'move',
                outline: selected ? '1.5px solid #2563eb' : problem ? '1.5px dashed #dc2626' : '1px dashed transparent',
                outlineOffset: 0,
                bgcolor: selected ? 'rgba(37,99,235,0.06)' : 'transparent',
                '&:hover': { outline: selected ? '1.5px solid #2563eb' : '1px dashed #60a5fa' },
              }}
            >
              {selected && selection.length === 1 && !el.locked && HANDLES.map((hd) => (
                <Box
                  key={hd}
                  onPointerDown={(e) => startDrag(e, el, hd)}
                  sx={{
                    position: 'absolute', width: 8, height: 8, bgcolor: '#fff', border: '1.5px solid #2563eb', borderRadius: '2px',
                    left: hd.includes('w') ? -5 : hd.includes('e') ? 'calc(100% - 3px)' : 'calc(50% - 4px)',
                    top: hd.includes('n') ? -5 : hd.includes('s') ? 'calc(100% - 3px)' : 'calc(50% - 4px)',
                    cursor: `${hd}-resize`,
                  }}
                />
              ))}
            </Box>
          );
        })}
        {guides.map((g, i) => (
          <Box
            key={i}
            sx={g.axis === 'x'
              ? { position: 'absolute', top: -8, bottom: -8, left: g.at * k, borderLeft: '1px solid #ec4899', pointerEvents: 'none' }
              : { position: 'absolute', left: -8, right: -8, top: g.at * k, borderTop: '1px solid #ec4899', pointerEvents: 'none' }}
          />
        ))}
      </Box>
    </Box>
  );
}
