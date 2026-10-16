import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { toBillModel } from './documentAdapters';
import { paperDimensions } from './renderBillHtml';
import { loadBillingContext, resolveTemplate, applyPaperOverride } from './billingContext';
import { renderTemplateHtml } from './printBill';
import { SAMPLE_BILL } from './sampleData';

const MM_TO_PX = 96 / 25.4;

/**
 * Renders a bill template at true paper size inside an <iframe>, scaled to fit the
 * available width — every page of a multi-page visual template, stacked. Used by the designer
 * (previews + thumbnails) and by the print modals for the on-screen preview.
 *
 * Provide EITHER an explicit `model` (designer sample / prepared BillModel) OR `doc` +
 * `documentType` (real ERP document — it is run through the adapter here).
 * `firstPageOnly` crops to page 1 (template thumbnails).
 */
export default function BillPreview({
  template,
  model: modelProp,
  doc,
  documentType = 'SALES_INVOICE',
  paperOverride,
  maxWidth = 760,
  minHeight = 200,
  firstPageOnly = false,
  onRendered,
}) {
  const [ctx, setCtx] = useState(null);
  const [html, setHtml] = useState('');
  const [frameHeight, setFrameHeight] = useState(minHeight);
  const [paperW, setPaperW] = useState(210);
  const frameRef = useRef(null);

  useEffect(() => {
    let alive = true;
    loadBillingContext().then((c) => { if (alive) setCtx(c); });
    return () => { alive = false; };
  }, []);

  const effectiveTemplate = useMemo(() => {
    const base = template || (ctx ? resolveTemplate(documentType, ctx) : null);
    return base ? applyPaperOverride(base, paperOverride, documentType, ctx || undefined) : null;
  }, [template, ctx, documentType, paperOverride]);

  const model = useMemo(() => {
    if (modelProp) return modelProp;
    if (!doc) return null;
    return toBillModel(doc, documentType, { company: ctx?.company, branding: ctx?.settings, user: ctx?.user });
  }, [modelProp, doc, documentType, ctx]);

  useEffect(() => {
    let alive = true;
    if (!effectiveTemplate || !model) return undefined;
    (async () => {
      const out = await renderTemplateHtml(effectiveTemplate, model, { branding: ctx?.settings || {} });
      if (!alive) return;
      setPaperW(out.geometry?.pageW || paperDimensions(effectiveTemplate).w);
      setHtml(out.html);
      onRendered?.(out);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveTemplate, model, ctx]);

  const paperPx = paperW * MM_TO_PX;
  const scale = Math.min(1, maxWidth / paperPx);

  const handleLoad = () => {
    try {
      const d = frameRef.current?.contentDocument;
      if (!d) return;
      // The print document pads pages on screen; strip that so the preview is just paper.
      d.body.style.background = 'transparent';
      d.body.style.padding = '0';
      d.querySelectorAll('.bd-page').forEach((p, i) => {
        p.style.margin = i ? '6mm 0 0 0' : '0';
        p.style.boxShadow = 'none';
        p.style.outline = '1px solid #cbd5e1';
        if (firstPageOnly && i) p.style.display = 'none';
      });
      const h = Math.max(d.body.scrollHeight, d.body.offsetHeight);
      setFrameHeight(Math.max(minHeight, h + 2));
    } catch { /* ignore */ }
  };

  return (
    <Box sx={{ width: paperPx * scale, height: frameHeight * scale, mx: 'auto', position: 'relative' }}>
      <Box sx={{
        width: paperPx, height: frameHeight, transform: `scale(${scale})`, transformOrigin: 'top left',
        position: 'absolute', top: 0, left: 0, boxShadow: '0 2px 14px rgba(15,23,42,0.12)', bgcolor: '#fff',
      }}
      >
        <iframe
          ref={frameRef}
          title="bill-preview"
          onLoad={handleLoad}
          srcDoc={html}
          style={{ width: '100%', height: '100%', border: 'none', background: '#fff' }}
        />
      </Box>
    </Box>
  );
}

export { SAMPLE_BILL };
