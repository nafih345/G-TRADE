// The single print entry point every module funnels through.
//
//   printBill({ doc, documentType, paperOverride, templateOverride, title, mode })
//
// Replaces the old per-module string-HTML builders (printInvoice.js / printPurchase.js /
// the inline WholesaleSales dialog). Presentation only — `doc` already carries every
// computed amount.
import { toBillModel } from './documentAdapters';
import { renderBillHtml, prepareBillAssets, paperDimensions } from './renderBillHtml';
import { loadBillingContext, resolveTemplate, applyPaperOverride } from './billingContext';

export async function buildBillHtml({ doc, modelOverride, documentType = 'SALES_INVOICE', paperOverride, templateOverride, title, autoPrint = false }) {
  const ctx = await loadBillingContext();
  let template = templateOverride || resolveTemplate(documentType, ctx);
  template = applyPaperOverride(template, paperOverride);

  // `modelOverride` = an already-built BillModel (the designer's sample data); otherwise
  // run the raw ERP document through the adapter.
  const model = modelOverride || toBillModel(
    title ? { ...doc, __title: title } : doc,
    documentType,
    { company: ctx.company, branding: ctx.settings },
  );
  const assets = await prepareBillAssets(template, model);
  const html = renderBillHtml(template, model, { assets, autoPrint });
  return { html, template, model };
}

export async function printBill(options = {}) {
  const { doc } = options;
  if (!doc) return;
  try {
    const { html, template } = await buildBillHtml({ ...options, autoPrint: true });
    const dims = paperDimensions(template);
    const narrow = dims.w <= 100;
    const win = window.open('', '_blank', narrow ? 'width=420,height=740' : 'width=940,height=920');
    if (!win) return;
    win.document.open();
    win.document.write(html);
    win.document.close();
  } catch (e) {
    console.error('printBill failed', e);
  }
}

export default printBill;
