// The Bill Rendering Engine.
//
//   renderBillHtml(template, billModel, opts) -> a complete, self-contained HTML string
//
// One producer feeds BOTH the on-screen preview (BillPreview.jsx, in an iframe) and the
// real print / PDF output (printBill.js). It controls presentation only — every amount
// comes pre-computed from documentAdapters.js.
import JsBarcode from 'jsbarcode';
import QRCode from 'qrcode';

const PAPER = {
  A4: { w: 210, h: 297 },
  A5: { w: 148, h: 210 },
  '80mm': { w: 80, h: null },
  '58mm': { w: 58, h: null },
};

export function paperDimensions(template) {
  const size = template?.paper_size || 'A4';
  if (size === 'CUSTOM') {
    return {
      w: parseFloat(template.custom_width_mm) || 210,
      h: parseFloat(template.custom_height_mm) || null,
    };
  }
  const base = PAPER[size] || PAPER.A4;
  if ((template?.orientation || 'portrait') === 'landscape' && base.h) {
    return { w: base.h, h: base.w };
  }
  return { ...base };
}

export function isThermalTemplate(template) {
  return ['58mm', '80mm'].includes(template?.paper_size) ||
    (template?.paper_size === 'CUSTOM' && (parseFloat(template?.custom_width_mm) || 999) <= 100);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function money(v, currency = '₹') {
  const n = parseFloat(v);
  if (!Number.isFinite(n)) return `${currency}0.00`;
  const neg = n < 0;
  const s = Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${neg ? '-' : ''}${currency}${s}`;
}

const wt = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n !== 0 ? `${n.toLocaleString('en-IN', { maximumFractionDigits: 3 })} g` : '-';
};

// ---------------------------------------------------------------------------
// Barcode / QR — generated to data URIs so the HTML stays self-contained
// ---------------------------------------------------------------------------

function barcodeSourceValue(model, source) {
  switch (source) {
    case 'invoiceNumber': return model.document.number || '';
    case 'orderNumber': return model.document.orderNumber || model.document.number || '';
    default: return source || model.document.number || '';
  }
}

function qrSourceValue(model, cfg) {
  switch (cfg.source) {
    case 'invoiceUrl':
      return `${window.location.origin}/#/sales/orders?inv=${encodeURIComponent(model.document.number || '')}`;
    case 'invoiceNumber': return model.document.number || '';
    case 'payment':
      return `Invoice ${model.document.number} | Total ${model.totals.grandTotal} | Balance ${model.totals.balance}`;
    case 'upi': {
      const upi = model.payment.upiId || '';
      const amt = model.totals.balance || model.totals.grandTotal || 0;
      return upi ? `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(model.company.name)}&am=${amt}&cu=INR` : '';
    }
    case 'custom': return cfg.customText || '';
    default: return model.document.number || '';
  }
}

export async function prepareBillAssets(template, model) {
  const out = { barcodeDataUrl: '', qrDataUrl: '' };
  const sections = template?.config?.sections || [];
  const barcodeSec = sections.find((s) => s.id === 'barcode');
  const qrSec = sections.find((s) => s.id === 'qr');

  if (barcodeSec?.visible) {
    const value = barcodeSourceValue(model, barcodeSec.config?.source);
    if (value) {
      try {
        const canvas = document.createElement('canvas');
        JsBarcode(canvas, String(value), {
          format: 'CODE128', displayValue: true, fontSize: 12, height: barcodeSec.config?.heightPx || 44, margin: 4,
        });
        out.barcodeDataUrl = canvas.toDataURL('image/png');
      } catch (e) { /* leave blank */ }
    }
  }
  if (qrSec?.visible) {
    const value = qrSourceValue(model, qrSec.config || {});
    if (value) {
      try {
        out.qrDataUrl = await QRCode.toDataURL(String(value), { margin: 1, width: (qrSec.config?.sizePx || 96) * 2 });
      } catch (e) { /* leave blank */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Column + totals helpers
// ---------------------------------------------------------------------------

function columnValue(key, item, idx, currency) {
  switch (key) {
    case 'slno': return String(idx + 1);
    case 'name': return esc(item.name);
    case 'sku': return esc(item.sku || '-');
    case 'barcode': return esc(item.barcode || '-');
    case 'hsn': return esc(item.hsn || '-');
    case 'size': return esc(item.size || '-');
    case 'color': return esc(item.color || '-');
    case 'qty': return String(item.qty ?? '');
    case 'unit': return esc(item.unit || '-');
    case 'rate': return money(item.rate, currency);
    case 'discount':
      return item.discountPercent != null && item.discountPercent !== ''
        ? `${item.discountPercent}%`
        : money(item.discount, currency);
    case 'tax':
      return item.taxPercent != null ? `${item.taxPercent}%` : money(item.taxAmount, currency);
    case 'total': return money(item.total, currency);
    case 'grossWeight': return wt(item.grossWeight);
    case 'netWeight': return wt(item.netWeight);
    case 'stoneWeight': return wt(item.stoneWeight);
    case 'makingCharge': return money(item.makingCharge, currency);
    case 'stoneCharge': return money(item.stoneCharge, currency);
    case 'otherCharges': return money(item.otherCharges, currency);
    default: return '';
  }
}

const ALWAYS_TOTALS = new Set(['subtotal', 'grandTotal', 'paid', 'balance']);
const TOTALS_META = {
  subtotal: { label: 'Subtotal' },
  discount: { label: 'Discount', negative: true },
  additionalDiscount: { label: 'Additional Discount', negative: true },
  tax: { label: 'Tax' },
  cgst: { label: 'CGST' },
  sgst: { label: 'SGST' },
  igst: { label: 'IGST' },
  shipping: { label: 'Shipping / Delivery' },
  otherCharges: { label: 'Other Charges' },
  roundOff: { label: 'Round Off' },
  grandTotal: { label: 'Grand Total', strong: true },
  paid: { label: 'Paid Amount', color: '#059669' },
  balance: { label: 'Balance Amount', color: '#dc2626' },
};

function buildTotalsRows(model, cfg, currency) {
  const wanted = cfg.rows || Object.keys(TOTALS_META);
  const rows = [];
  wanted.forEach((key) => {
    const meta = TOTALS_META[key];
    if (!meta) return;
    const raw = model.totals[key];
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return;
    if (n === 0 && !ALWAYS_TOTALS.has(key)) return;
    const value = meta.negative && n > 0 ? `- ${money(n, currency)}` : money(n, currency);
    rows.push({ ...meta, key, value });
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

function sectionCfg(template, id) {
  return (template?.config?.sections || []).find((s) => s.id === id);
}

function renderCompany(model, cfg, thermal) {
  const c = model.company;
  const lines = [];
  if (cfg.showAddress && c.address) lines.push(esc(c.address));
  const contact = [];
  if (cfg.showPhone && c.phone) contact.push(`Phone: ${esc(c.phone)}`);
  if (cfg.showEmail && c.email) contact.push(`Email: ${esc(c.email)}`);
  if (cfg.showWebsite && c.website) contact.push(esc(c.website));
  if (contact.length) lines.push(contact.join(' &nbsp;|&nbsp; '));
  const reg = [];
  if (cfg.showGstin && c.gstin) reg.push(`GSTIN: ${esc(c.gstin)}`);
  if (cfg.showPan && c.pan) reg.push(`PAN: ${esc(c.pan)}`);
  if (reg.length) lines.push(reg.join(' &nbsp;|&nbsp; '));

  const logo = cfg.showLogo && c.logoDataUrl
    ? `<img src="${c.logoDataUrl}" alt="logo" style="height:${cfg.logoHeightPx || 48}px;max-width:60%;object-fit:contain;display:block;margin:${cfg.logoAlign === 'center' ? '0 auto 6px' : cfg.logoAlign === 'right' ? '0 0 6px auto' : '0 0 6px 0'};" />`
    : '';
  const nameHtml = cfg.showName
    ? `<div class="co-name" style="font-size:${cfg.nameSizePx || 24}px;">${esc(c.name)}</div>` : '';
  const taglineHtml = cfg.showTagline && c.tagline
    ? `<div class="co-tag">${esc(c.tagline)}</div>` : '';

  if (thermal || cfg.layout === 'stacked') {
    return `<div class="sec company center">
      ${logo}${nameHtml}${taglineHtml}
      ${lines.map((l) => `<div class="co-line">${l}</div>`).join('')}
    </div>`;
  }
  // split layout: identity left, address block right
  return `<table class="sec company split"><tr>
    <td style="vertical-align:top;">${logo}${nameHtml}${taglineHtml}
      ${cfg.showGstin && c.gstin ? `<div class="co-line">GSTIN: ${esc(c.gstin)}${cfg.showPan && c.pan ? ` | PAN: ${esc(c.pan)}` : ''}</div>` : ''}
    </td>
    <td style="vertical-align:top;text-align:right;">
      ${cfg.showAddress && c.address ? `<div class="co-line">${esc(c.address)}</div>` : ''}
      ${cfg.showPhone && c.phone ? `<div class="co-line">Phone: ${esc(c.phone)}</div>` : ''}
      ${cfg.showEmail && c.email ? `<div class="co-line">${esc(c.email)}</div>` : ''}
      ${cfg.showWebsite && c.website ? `<div class="co-line">${esc(c.website)}</div>` : ''}
    </td>
  </tr></table>`;
}

function renderDocTitle(model, cfg, thermal) {
  const text = cfg.text || model.document.title || 'INVOICE';
  const align = cfg.align || 'center';
  if (thermal || cfg.style === 'plain') {
    return `<div class="sec doc-title plain" style="text-align:${align};">${esc(text)}</div>`;
  }
  return `<div class="sec doc-title banner" style="text-align:${align};">${esc(text)}</div>`;
}

const META_LABELS = {
  invoiceNumber: 'Invoice No', orderNumber: 'Order No', date: 'Date', dueDate: 'Due Date',
  paymentStatus: 'Payment Status', salesperson: 'Salesperson', branch: 'Branch',
};
function metaValue(model, key) {
  const d = model.document;
  return ({
    invoiceNumber: d.number, orderNumber: d.orderNumber, date: d.date, dueDate: d.dueDate,
    paymentStatus: d.paymentStatus, salesperson: d.salesperson, branch: d.branch,
  })[key] || '';
}

function renderMeta(model, cfg, thermal) {
  const fields = (cfg.fields || []).filter((k) => metaValue(model, k));
  if (!fields.length) return '';
  if (thermal || cfg.layout === 'rows') {
    return `<div class="sec meta rows">${fields.map((k) =>
      `<div class="row"><span>${esc(META_LABELS[k] || k)}:</span><span>${esc(metaValue(model, k))}</span></div>`
    ).join('')}</div>`;
  }
  const cells = [];
  for (let i = 0; i < fields.length; i += 2) {
    const a = fields[i]; const b = fields[i + 1];
    cells.push(`<tr>
      <td class="k">${esc(META_LABELS[a] || a)}</td><td class="v">${esc(metaValue(model, a))}</td>
      ${b ? `<td class="k">${esc(META_LABELS[b] || b)}</td><td class="v">${esc(metaValue(model, b))}</td>` : '<td></td><td></td>'}
    </tr>`);
  }
  return `<table class="sec meta grid">${cells.join('')}</table>`;
}

function renderCustomer(model, cfg, thermal) {
  const c = model.customer;
  const lines = [];
  if (cfg.showName !== false && c.name) lines.push(`<strong>${esc(c.name)}</strong>`);
  if (cfg.showPhone && c.phone) lines.push(esc(c.phone));
  if (cfg.showAddress && c.address) lines.push(esc(c.address));
  if (cfg.showGstin && c.gstin) lines.push(`GSTIN: ${esc(c.gstin)}`);
  if (cfg.showEmail && c.email) lines.push(esc(c.email));
  if (!lines.length) return '';
  return `<div class="sec customer">
    <div class="cust-title">${esc(cfg.title || 'Bill To')}</div>
    ${lines.map((l) => `<div class="cust-line">${l}</div>`).join('')}
  </div>`;
}

function renderItems(model, cfg, thermal, currency) {
  const cols = (cfg.columns || []).filter((c) => c.enabled);
  if (!cols.length || !model.items.length) return '';
  const head = `<tr>${cols.map((c) =>
    `<th style="text-align:${c.align || 'left'};">${esc(c.label)}</th>`).join('')}</tr>`;
  const body = model.items.map((item, idx) => {
    const tds = cols.map((c) => {
      let val = columnValue(c.key, item, idx, currency);
      if (c.key === 'name' && cfg.showBrandUnderName && item.brand) {
        val += `<div class="brand">${esc(item.brand)}</div>`;
      }
      return `<td style="text-align:${c.align || 'left'};">${val}</td>`;
    });
    return `<tr>${tds.join('')}</tr>`;
  }).join('');
  return `<table class="sec items${cfg.zebra ? ' zebra' : ''}">
    <thead>${head}</thead><tbody>${body}</tbody></table>`;
}

function renderTotals(model, cfg, thermal, currency) {
  const rows = buildTotalsRows(model, cfg, currency);
  if (!rows.length) return '';
  const body = rows.map((r) => {
    const style = [
      r.strong ? 'font-weight:800;' : '',
      r.color ? `color:${r.color};` : '',
    ].join('');
    return `<div class="row${r.strong ? ' grand' : ''}" style="${style}">
      <span>${esc(r.label)}</span><span>${r.value}</span></div>`;
  }).join('');
  return `<div class="sec totals ${cfg.align === 'left' ? 'left' : 'right'}">${body}</div>`;
}

function renderPayment(model, cfg, thermal, currency, assets) {
  const p = model.payment;
  const rows = [];
  if (cfg.showMethod && p.method) rows.push(['Payment Method', esc(p.method)]);
  if (cfg.showPaid) rows.push(['Paid', money(p.paid, currency)]);
  if (cfg.showBalance) rows.push(['Balance', money(p.balance, currency)]);
  if (cfg.showStatus && p.status) rows.push(['Status', esc(p.status)]);
  if (cfg.showBankDetails && cfg.bankDetails) rows.push(['Bank', esc(cfg.bankDetails)]);
  if (!rows.length && !(cfg.showUpiQr && assets.qrDataUrl)) return '';
  return `<div class="sec payment">
    <div class="pay-title">Payment</div>
    ${rows.map(([k, v]) => `<div class="row"><span>${k}</span><span>${v}</span></div>`).join('')}
    ${cfg.showUpiQr && assets.qrDataUrl ? `<img src="${assets.qrDataUrl}" style="height:90px;margin-top:6px;" />` : ''}
  </div>`;
}

function renderBarcode(model, cfg, thermal, currency, assets) {
  if (!assets.barcodeDataUrl) return '';
  return `<div class="sec barcode" style="text-align:${cfg.align || 'center'};">
    <img src="${assets.barcodeDataUrl}" style="height:${cfg.heightPx || 44}px;" /></div>`;
}

function renderQr(model, cfg, thermal, currency, assets) {
  if (!assets.qrDataUrl) return '';
  return `<div class="sec qr" style="text-align:${cfg.align || 'center'};">
    <img src="${assets.qrDataUrl}" style="width:${cfg.sizePx || 96}px;height:${cfg.sizePx || 96}px;" /></div>`;
}

function renderFooter(model, cfg, thermal) {
  const blocks = [];
  const add = (label, text) => {
    if (!text) return;
    blocks.push(`<div class="foot-block">${label ? `<strong>${esc(label)}</strong><br/>` : ''}${esc(text).replace(/\n/g, '<br/>')}</div>`);
  };
  add('', model.footer?.notes || cfg.notes);
  add('Terms & Conditions', model.footer?.terms || cfg.terms);
  add('Return Policy', cfg.returnPolicy);
  add('Warranty', cfg.warranty);
  add('Customer Care', cfg.customerCare);
  const thanks = cfg.thankYou
    ? `<div class="thank-you">${esc(cfg.thankYou)}</div>` : '';
  const sign = cfg.showSignature && !thermal
    ? `<div class="sign-box">${esc(cfg.signatureLabel || 'Authorized Signatory')}</div>` : '';
  if (!blocks.length && !thanks && !sign) return '';
  return `<div class="sec footer">
    <div class="foot-main">${blocks.join('')}</div>
    ${sign}
    ${thanks}
  </div>`;
}

const RENDERERS = {
  company: renderCompany, docTitle: renderDocTitle, meta: renderMeta, customer: renderCustomer,
  items: renderItems, totals: renderTotals, payment: renderPayment, barcode: renderBarcode,
  qr: renderQr, footer: renderFooter,
};

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

function buildStyles(template, thermal, styles) {
  const dims = paperDimensions(template);
  const m = template?.margins || {};
  const pageMargin = thermal
    ? `${m.top ?? 3}mm ${m.right ?? 3}mm ${m.bottom ?? 3}mm ${m.left ?? 3}mm`
    : `${m.top ?? 12}mm ${m.right ?? 12}mm ${m.bottom ?? 12}mm ${m.left ?? 12}mm`;
  const pageSize = dims.h
    ? `${dims.w}mm ${dims.h}mm`
    : `${dims.w}mm auto`;
  const accent = styles.accentColor || '#2563eb';
  const border = styles.borderColor || '#e2e8f0';
  const heading = styles.headingColor || styles.textColor || '#0f172a';
  const fs = styles.fontSizePx || (thermal ? 11 : 13);

  const common = `
    * { box-sizing: border-box; }
    html, body { margin: 0; padding: 0; }
    body {
      font-family: ${styles.fontFamily || "'Segoe UI', Arial, sans-serif"};
      color: ${styles.textColor || '#0f172a'};
      font-size: ${fs}px;
      line-height: ${styles.lineHeight || 1.5};
      letter-spacing: ${styles.letterSpacing || 0}px;
      background: #fff;
    }
    .sec { margin-bottom: ${thermal ? 6 : 14}px; }
    .co-name { font-weight: 800; color: ${accent}; letter-spacing: .3px; }
    .co-tag { font-size: .8em; color: #64748b; font-weight: 600; text-transform: uppercase; margin-top: 2px; }
    .co-line { font-size: .82em; color: #475569; }
    .cust-title, .pay-title { font-weight: 700; color: #475569; font-size: .8em; text-transform: uppercase; margin-bottom: 2px; }
    .cust-line { font-size: .92em; }
    .items { width: 100%; border-collapse: collapse; }
    .items th { text-align: left; font-size: .82em; font-weight: 700; }
    .items td { font-size: .9em; vertical-align: top; }
    .items .brand { font-size: .78em; color: #64748b; }
    .totals { margin-left: auto; }
    .totals.left { margin-left: 0; }
    .totals .row { display: flex; justify-content: space-between; gap: 24px; padding: 2px 0; }
    .totals .row.grand { border-top: 2px solid ${accent}; margin-top: 3px; padding-top: 5px; color: ${accent}; font-size: 1.1em; }
    .payment .row, .meta.rows .row { display: flex; justify-content: space-between; gap: 12px; padding: 1px 0; font-size: .9em; }
    .thank-you { text-align: center; font-weight: 700; margin-top: 8px; }
    .foot-block { font-size: .8em; color: #475569; margin-bottom: 4px; }
  `;

  if (thermal) {
    return `<style>
      @page { size: ${pageSize}; margin: ${pageMargin}; }
      ${common}
      body { width: ${dims.w - (m.left ?? 3) - (m.right ?? 3)}mm; }
      .center { text-align: center; }
      .doc-title.plain { font-weight: 800; letter-spacing: 1px; border-top: 1px dashed #000; border-bottom: 1px dashed #000; padding: 3px 0; }
      .items th { border-bottom: 1px dashed #000; padding: 2px 0; }
      .items td { padding: 2px 0; }
      .customer, .meta { border-bottom: 1px dashed #000; padding-bottom: 4px; }
      .totals .row.grand { border-top: 1px dashed #000; color: #000; }
      .sec.totals { border-top: 1px dashed #000; padding-top: 3px; }
      .payment { border-top: 1px dashed #000; padding-top: 3px; }
      .footer { border-top: 1px dashed #000; padding-top: 4px; text-align: center; }
      img { max-width: 100%; }
    </style>`;
  }

  return `<style>
    @page { size: ${pageSize}; margin: ${pageMargin}; }
    ${common}
    .wrap { border: 1px solid ${border}; border-radius: 8px; padding: ${styles.fontSizePx > 12 ? 22 : 16}px; }
    .company.split { width: 100%; border-collapse: collapse; border-bottom: 3px solid ${accent}; padding-bottom: 10px; }
    .doc-title.banner { background: #f1f5f9; text-align: center; padding: 9px; font-weight: 800; letter-spacing: 1px; color: ${heading}; border-radius: 6px; text-transform: uppercase; }
    .doc-title.plain { font-weight: 800; letter-spacing: 1px; text-transform: uppercase; color: ${heading}; padding: 4px 0; }
    .meta.grid { width: 100%; border-collapse: collapse; font-size: .9em; }
    .meta.grid td { padding: 6px 10px; border: 1px solid ${border}; }
    .meta.grid td.k { font-weight: 700; color: #475569; background: #f8fafc; width: 16%; white-space: nowrap; }
    .customer { border: 1px solid ${border}; border-radius: 6px; padding: 8px 10px; background: #f8fafc; }
    .items th { background: ${heading}; color: #fff; padding: 9px 10px; }
    .items td { padding: 8px 10px; border-bottom: 1px solid ${border}; }
    .items.zebra tbody tr:nth-child(even) { background: #f8fafc; }
    .totals { width: 340px; }
    .footer { border-top: 1px solid ${border}; padding-top: 12px; display: flex; justify-content: space-between; align-items: flex-end; gap: 20px; }
    .sign-box { text-align: center; border-top: 1px dashed #94a3b8; min-width: 170px; padding-top: 6px; font-weight: 700; font-size: .85em; flex-shrink: 0; }
    .footer .thank-you { position: relative; }
    img { max-width: 100%; }
  </style>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function renderBillHtml(template, model, opts = {}) {
  const assets = opts.assets || { barcodeDataUrl: '', qrDataUrl: '' };
  const thermal = isThermalTemplate(template);
  const styles = { ...(template?.config?.styles || {}) };
  const currency = model.company.currency || '₹';
  const sections = template?.config?.sections || [];

  const bodyInner = sections
    .filter((s) => s.visible !== false && RENDERERS[s.id])
    .map((s) => RENDERERS[s.id](model, s.config || {}, thermal, currency, assets, styles))
    .filter(Boolean)
    .join('\n');

  const body = thermal ? bodyInner : `<div class="wrap">${bodyInner}</div>`;
  const autoPrint = opts.autoPrint
    ? `<script>window.onload=function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},250);};<\/script>`
    : '';

  return `<!DOCTYPE html><html><head><meta charset="utf-8" />
    <title>${esc(model.document.title || 'Bill')} ${esc(model.document.number || '')}</title>
    ${buildStyles(template, thermal, styles)}
  </head><body>${body}${autoPrint}</body></html>`;
}

export default renderBillHtml;
