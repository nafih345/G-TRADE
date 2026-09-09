import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Box } from '@mui/material';
import { toBillModel } from './documentAdapters';
import { renderBillHtml, prepareBillAssets, paperDimensions } from './renderBillHtml';
import { loadBillingContext, resolveTemplate, applyPaperOverride } from './billingContext';
import { SAMPLE_BILL } from './sampleData';

const MM_TO_PX = 96 / 25.4;

/**
 * Renders a bill template at true paper size inside an <iframe>, scaled to fit the
 * available width. Used by the designer (live preview + thumbnails) and by the print
 * modals for the on-screen preview.
 *
 * Provide EITHER an explicit `model` (designer, uses sample data) OR `doc` +
 * `documentType` (real ERP document — it is run through the adapter here).
 */
export default function BillPreview({
  template,
  model: modelProp,
  doc,
  documentType = 'SALES_INVOICE',
  paperOverride,
  maxWidth = 760,
  minHeight = 200,
}) {
  const [ctx, setCtx] = useState(null);
  const [html, setHtml] = useState('');
  const [frameHeight, setFrameHeight] = useState(minHeight);
  const frameRef = useRef(null);

  useEffect(() => {
    let alive = true;
    loadBillingContext().then((c) => { if (alive) setCtx(c); });
    return () => { alive = false; };
  }, []);

  const effectiveTemplate = useMemo(() => {
    const base = template || (ctx ? resolveTemplate(documentType, ctx) : null);
    return base ? applyPaperOverride(base, paperOverride) : null;
  }, [template, ctx, documentType, paperOverride]);

  const model = useMemo(() => {
    if (modelProp) return modelProp;
    if (!doc) return null;
    return toBillModel(doc, documentType, { company: ctx?.company, branding: ctx?.settings });
  }, [modelProp, doc, documentType, ctx]);

  useEffect(() => {
    let alive = true;
    if (!effectiveTemplate || !model) return undefined;
    (async () => {
      const assets = await prepareBillAssets(effectiveTemplate, model);
      if (!alive) return;
      setHtml(renderBillHtml(effectiveTemplate, model, { assets }));
    })();
    return () => { alive = false; };
  }, [effectiveTemplate, model]);

  const dims = effectiveTemplate ? paperDimensions(effectiveTemplate) : { w: 210, h: 297 };
  const paperPx = dims.w * MM_TO_PX;
  const scale = Math.min(1, maxWidth / paperPx);

  const handleLoad = () => {
    try {
      const b = frameRef.current?.contentDocument?.body;
      if (b) {
        const h = Math.max(b.scrollHeight, b.offsetHeight);
        setFrameHeight(Math.max(minHeight, h + 8));
      }
    } catch { /* ignore */ }
  };

  return (
    <Box sx={{
      width: paperPx * scale,
      height: frameHeight * scale,
      mx: 'auto',
      position: 'relative',
    }}
    >
      <Box sx={{
        width: paperPx,
        height: frameHeight,
        transform: `scale(${scale})`,
        transformOrigin: 'top left',
        position: 'absolute',
        top: 0,
        left: 0,
        boxShadow: '0 2px 14px rgba(15,23,42,0.12)',
        bgcolor: '#fff',
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
