// The single print entry point every module funnels through.
//
//   printBill({ doc, documentType, paperOverride, templateOverride, title, mode })
//
// Replaces the old per-module string-HTML builders (printInvoice.js / printPurchase.js /
// the inline WholesaleSales dialog). Presentation only — `doc` already carries every
// computed amount; printing never writes to the transaction.
import { toBillModel } from './documentAdapters';
import { renderBillHtml, prepareBillAssets, paperDimensions } from './renderBillHtml';
import { renderVisualBillHtml, pageGeometry } from './renderBillLayout';
import { loadBillingContext, resolveTemplate, applyPaperOverride } from './billingContext';

/** HTML for one template + BillModel, whichever engine the template uses. */
export async function renderTemplateHtml(template, model, { autoPrint = false, branding, editor = false } = {}) {
  if (template?.config?.schema === 2) {
    const { html, layout } = renderVisualBillHtml(template, model, { autoPrint, branding, editor });
    return { html, layout, pageCount: layout.pages.length, geometry: layout.geometry };
  }
  const assets = await prepareBillAssets(template, model);
  const dims = paperDimensions(template);
  return { html: renderBillHtml(template, model, { assets, autoPrint }), layout: null, pageCount: null, geometry: { pageW: dims.w, pageH: dims.h } };
}

export async function buildBillHtml({ doc, modelOverride, documentType = 'SALES_INVOICE', paperOverride, templateOverride, title, autoPrint = false }) {
  const ctx = await loadBillingContext();
  let template = templateOverride || resolveTemplate(documentType, ctx);
  template = applyPaperOverride(template, paperOverride, documentType, ctx);

  // `modelOverride` = an already-built BillModel (the designer's sample data); otherwise
  // run the raw ERP document through the adapter.
  const model = modelOverride || toBillModel(
    title ? { ...doc, __title: title } : doc,
    documentType,
    { company: ctx.company, branding: ctx.settings, user: ctx.user },
  );
  const out = await renderTemplateHtml(template, model, { autoPrint, branding: ctx.settings || {} });
  return { ...out, template, model };
}

/** Open `html` in a print window. Resolves true once the window is open. */
export function openPrintWindow(html, template) {
  const narrow = template?.config?.schema === 2 ? pageGeometry(template).pageW <= 100 : paperDimensions(template).w <= 100;
  const win = window.open('', '_blank', narrow ? 'width=420,height=740' : 'width=940,height=920');
  if (!win) return false;
  win.document.open();
  win.document.write(html);
  win.document.close();
  return true;
}

// Resolves true once the print window is open; false if there was nothing to print, the pop-up was
// blocked (likely when called after an await, e.g. a save) or rendering failed.
export async function printBill(options = {}) {
  const { doc, modelOverride } = options;
  if (!doc && !modelOverride) return false;
  try {
    const { html, template } = await buildBillHtml({ ...options, autoPrint: true });
    return openPrintWindow(html, template);
  } catch (e) {
    console.error('printBill failed', e);
    return false;
  }
}

export default printBill;
