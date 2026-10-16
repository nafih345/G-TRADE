// Visual (schema 2) Bill Rendering Engine.
//
//   layoutBill(template, model, opts)      -> { geometry, pages[], scales, warnings }
//   renderBillPages(template, model, lay)  -> { css, pages: [html] }
//   renderVisualBillHtml(template, model)  -> complete print document (HTML string)
//
// One producer feeds the designer canvas, the preview and the real print / PDF output, so
// what you design is what prints. Pages are laid out explicitly (fixed-size page boxes with
// exact mm geometry, @page margin 0): rows are measured, split across pages with the table
// header repeated, the page footer drawn on every page and the summary kept whole. Thermal
// rolls are one page exactly as long as the bill.
//
// Presentation only — every figure comes from the BillModel (documentAdapters.js) as stored on
// the transaction; a missing figure prints blank, never a computed substitute.
import QRCode from 'qrcode';
import { encodeBarcode } from '../labels/renderLabel.js';
import {
  FIELD_BY_ID, COLUMN_BY_KEY, TOTALS_ROW_BY_KEY, fieldText, rawField, formatMoney, formatNumber,
  formatDate, fmtWithCurrency, tokensIn,
} from './billFields.js';
import { normalizeConfig, effectiveTheme, elementTitle, BANDS } from './billLayout.js';

export const PX_PER_MM = 96 / 25.4;
const PT_TO_MM = 25.4 / 72;

const PAPER = {
  A4: { w: 210, h: 297 }, A5: { w: 148, h: 210 }, A6: { w: 105, h: 148 }, LETTER: { w: 215.9, h: 279.4 },
  '80mm': { w: 80, h: null }, '58mm': { w: 58, h: null },
};

export function pageGeometry(template) {
  const size = template?.paper_size || 'A4';
  let w;
  let h;
  if (size === 'CUSTOM') {
    w = parseFloat(template.custom_width_mm) || 210;
    h = parseFloat(template.custom_height_mm) || null;
  } else {
    const base = PAPER[size] || PAPER.A4;
    w = base.w;
    h = base.h;
    if ((template?.orientation || 'portrait') === 'landscape' && h) [w, h] = [h, w];
  }
  const m = template?.margins || {};
  const thermal = !h;
  const dflt = thermal ? 3 : 10;
  const margins = {
    top: num(m.top, dflt), right: num(m.right, dflt), bottom: num(m.bottom, dflt), left: num(m.left, dflt),
  };
  return {
    pageW: w, pageH: h, thermal, margins,
    contentW: r2(w - margins.left - margins.right),
    contentH: h ? r2(h - margins.top - margins.bottom) : null,
  };
}

function num(v, d = 0) {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : d;
}
const r2 = (n) => Math.round(n * 100) / 100;
const mm = (n) => `${r2(n)}mm`;
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const nl2br = (s) => esc(s).replace(/\r?\n/g, '<br/>');
const blank = (v) => v === undefined || v === null || (typeof v === 'string' && !v.trim());

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

function styleCss(st = {}, ctx, { scale = 1 } = {}) {
  const out = [];
  if (st.fontFamily && st.fontFamily !== 'inherit') out.push(`font-family:${st.fontFamily}`);
  if (st.fontSize) out.push(`font-size:${r2(st.fontSize * scale)}pt`);
  else if (scale !== 1) out.push(`font-size:${r2(ctx.theme.fontSize * scale)}pt`);
  if (st.fontWeight) out.push(`font-weight:${st.fontWeight}`);
  if (st.italic) out.push('font-style:italic');
  if (st.underline) out.push('text-decoration:underline');
  if (st.uppercase) out.push('text-transform:uppercase');
  if (st.color) out.push(`color:${st.color}`);
  if (st.bg) out.push(`background:${st.bg}`);
  if (st.align) out.push(`text-align:${st.align}`);
  if (st.lineHeight) out.push(`line-height:${st.lineHeight}`);
  if (st.letterSpacing) out.push(`letter-spacing:${st.letterSpacing}pt`);
  if (st.padding) out.push(`padding:${mm(st.padding)}`);
  if (st.radius) out.push(`border-radius:${mm(st.radius)}`);
  if (st.borderWidth) {
    const b = `${st.borderWidth}pt ${st.borderStyle || 'solid'} ${st.borderColor || ctx.theme.border}`;
    const sides = st.borderSides || 'all';
    const map = {
      all: ['border'], top: ['border-top'], bottom: ['border-bottom'], left: ['border-left'], right: ['border-right'],
      tb: ['border-top', 'border-bottom'], lr: ['border-left', 'border-right'], none: [],
    };
    (map[sides] || ['border']).forEach((p) => out.push(`${p}:${b}`));
  }
  return out.join(';');
}

const VALIGN = { top: 'flex-start', middle: 'center', bottom: 'flex-end' };

// ---------------------------------------------------------------------------
// Element renderers -> inner HTML
// ---------------------------------------------------------------------------

function placeholder(ctx, text) {
  return ctx.editor ? `<span class="bd-ph">${esc(text)}</span>` : '';
}

function fieldValue(ctx, id) {
  return fieldText(ctx.model, id, ctx.fmt);
}

function textWithTokens(ctx, text) {
  const raw = String(text || '');
  let out = '';
  let last = 0;
  const re = /\{\{\s*([a-zA-Z]+\.[a-zA-Z]+)\s*\}\}/g;
  let m;
  while ((m = re.exec(raw))) {
    out += nl2br(raw.slice(last, m.index));
    const v = FIELD_BY_ID[m[1]] ? fieldValue(ctx, m[1]) : '';
    out += v ? nl2br(v) : placeholder(ctx, `[${FIELD_BY_ID[m[1]]?.label || m[1]}]`);
    last = m.index + m[0].length;
  }
  return out + nl2br(raw.slice(last));
}

function kvRow(label, valueHtml, el, ctx, labelCss) {
  if (el.labelPosition === 'top') {
    return `<div class="bd-k bd-lbl-top" style="${labelCss}">${esc(label)}</div><div class="bd-v">${valueHtml}</div>`;
  }
  if (el.labelPosition === 'left') {
    const w = num(el.labelWidth) > 0 ? `width:${mm(el.labelWidth)};flex:0 0 ${mm(el.labelWidth)};` : 'margin-right:1.5mm;';
    return `<div class="bd-kv"><span class="bd-k" style="${w}${labelCss}">${esc(label)}</span><span class="bd-v">${valueHtml}</span></div>`;
  }
  return valueHtml;
}

const RENDER = {
  text(el, ctx) {
    const title = el.title ? `<div class="bd-title">${esc(el.title)}</div>` : '';
    return `${title}<div>${textWithTokens(ctx, el.text)}</div>`;
  },

  field(el, ctx) {
    const def = FIELD_BY_ID[el.field];
    let value = fieldValue(ctx, el.field);
    if (def?.kind === 'image') {
      return value ? `<img src="${esc(value)}" alt="" style="width:100%;height:100%;object-fit:contain"/>` : placeholder(ctx, def.label);
    }
    let valueHtml;
    if (!value) {
      if (el.hideIfEmpty !== false && !el.emptyText) {
        if (!ctx.editor) return '';
        valueHtml = placeholder(ctx, `[${def?.label || el.field}]`);
      } else {
        valueHtml = esc(el.emptyText || '');
      }
    } else {
      value = `${el.prefix || ''}${value}${el.suffix || ''}`;
      valueHtml = def?.kind === 'multiline' ? nl2br(value) : esc(value);
    }
    if (!el.label || el.labelPosition === 'none') return `<div class="bd-v">${valueHtml}</div>`;
    return kvRow(el.label, valueHtml, el, ctx, styleCss(el.labelStyle, ctx));
  },

  fieldList(el, ctx) {
    const labelCss = styleCss(el.labelStyle, ctx);
    const rows = (el.fields || []).map((r) => {
      const v = fieldValue(ctx, r.field);
      if (!v && el.hideEmpty !== false && !ctx.editor) return null;
      const def = FIELD_BY_ID[r.field];
      const vHtml = v ? (def?.kind === 'multiline' ? nl2br(v) : esc(v)) : placeholder(ctx, `[${def?.label || r.field}]`);
      return { label: r.label || def?.label || r.field, vHtml };
    }).filter(Boolean);
    if (!rows.length) return '';
    const sep = esc(el.separator ?? ':');
    if (el.layout === 'inline') {
      return rows.map((r) => `<span class="bd-k" style="${labelCss}">${esc(r.label)}${sep}</span> <span class="bd-v">${r.vHtml}</span>`).join('<span class="bd-dot"> · </span>');
    }
    const lw = num(el.labelWidth, 24);
    const cell = (r) => `<td class="bd-k" style="${lw > 0 ? `width:${mm(lw)};` : 'white-space:nowrap;padding-right:1mm;'}${labelCss}">${esc(r.label)}</td><td class="bd-sep" style="${labelCss}">${sep}</td><td class="bd-v">${r.vHtml}</td>`;
    if (el.layout === 'grid') {
      const trs = [];
      for (let i = 0; i < rows.length; i += 2) {
        trs.push(`<tr>${cell(rows[i])}${rows[i + 1] ? cell(rows[i + 1]) : '<td></td><td></td><td></td>'}</tr>`);
      }
      return `<table class="bd-fl">${trs.join('')}</table>`;
    }
    return `<table class="bd-fl">${rows.map((r) => `<tr>${cell(r)}</tr>`).join('')}</table>`;
  },

  companyBlock(el, ctx) {
    const c = ctx.model.company || {};
    const s = el.show || {};
    const lines = [];
    if (s.name !== false && c.name) {
      lines.push(`<div class="bd-co-name" style="font-size:${r2((el.nameSize || 16) * ctx.scale)}pt;color:${el.nameColor || ctx.theme.primary}">${esc(c.name)}</div>`);
    }
    if (s.tagline && c.tagline) lines.push(`<div class="bd-muted bd-co-tag">${esc(c.tagline)}</div>`);
    if (s.address && c.address) lines.push(`<div>${nl2br(c.address)}</div>`);
    const contact = [s.phone && c.phone && `Ph: ${esc(c.phone)}`, s.email && c.email && esc(c.email)].filter(Boolean);
    if (contact.length) lines.push(`<div>${contact.join(' &nbsp;·&nbsp; ')}</div>`);
    if (s.website && c.website) lines.push(`<div>${esc(c.website)}</div>`);
    const reg = [s.gstin && c.gstin && `GSTIN: <b>${esc(c.gstin)}</b>`, s.pan && c.pan && `PAN: ${esc(c.pan)}`].filter(Boolean);
    if (reg.length) lines.push(`<div>${reg.join(' &nbsp;|&nbsp; ')}</div>`);
    return lines.join('') || placeholder(ctx, '[Company details — fill in Store Profile]');
  },

  partyBlock(el, ctx) {
    const p = ctx.model.party || ctx.model.customer || {};
    const s = el.show || {};
    const shipping = el.variant === 'shipping';
    const lines = [];
    const title = el.title || p.label || 'Bill To';
    if (s.title !== false) lines.push(`<div class="bd-party-title">${esc(title)}</div>`);
    if (s.name !== false && p.name) lines.push(`<div class="bd-party-name">${esc(p.name)}</div>`);
    if (s.code && p.code) lines.push(`<div class="bd-muted">ID: ${esc(p.code)}</div>`);
    if (s.phone && p.phone) lines.push(`<div>Ph: ${esc(p.phone)}</div>`);
    if (s.email && p.email) lines.push(`<div>${esc(p.email)}</div>`);
    const addr = shipping ? p.shippingAddress : p.address;
    if (s.address !== false) {
      if (addr) lines.push(`<div>${nl2br(addr)}</div>`);
      else if (shipping) lines.push(placeholder(ctx, '[No shipping address on this document]'));
    }
    if (s.gstin && p.gstin) lines.push(`<div>GSTIN: <b>${esc(p.gstin)}</b></div>`);
    return lines.join('');
  },

  logo(el, ctx) {
    const src = ctx.model.company?.logoDataUrl;
    const pos = { left: 'left center', center: 'center', right: 'right center' }[el.style?.align || 'left'];
    if (!src) return ctx.editor ? '<div class="bd-ph-box">LOGO<br/><small>Logo &amp; Branding</small></div>' : '';
    return `<img src="${esc(src)}" alt="" style="width:100%;height:100%;object-fit:${el.fit === 'cover' ? 'cover' : 'contain'};object-position:${pos}"/>`;
  },

  image(el, ctx) {
    if (!el.src) return ctx.editor ? '<div class="bd-ph-box">IMAGE<br/><small>Upload in properties</small></div>' : '';
    return `<img src="${esc(el.src)}" alt="" style="width:100%;height:100%;object-fit:${el.fit === 'cover' ? 'cover' : 'contain'};opacity:${num(el.opacity, 1)}"/>`;
  },

  totals(el, ctx) {
    const fmt = fmtWithCurrency(ctx.fmt, ctx.model);
    const rows = [];
    (el.rows || []).forEach((r) => {
      const meta = TOTALS_ROW_BY_KEY[r.key];
      if (!meta) return;
      const v = rawField(ctx.model, `totals.${r.key}`);
      const label = r.label || meta.label;
      if (v === null) {
        // Known-unknown: an "always" row shows a dash rather than a made-up 0.00.
        if (r.always || meta.grand) rows.push({ label, value: '—', grand: meta.grand });
        return;
      }
      if (v === 0 && !r.always && !meta.grand) return;
      const value = meta.negative && v > 0 ? `− ${formatMoney(v, fmt)}` : formatMoney(v, fmt);
      rows.push({ label, value, grand: meta.grand, key: r.key });
    });
    if (!rows.length) return placeholder(ctx, '[No totals on this document]');
    const gs = styleCss({ fontWeight: 800, ...(el.grandStyle || {}) }, ctx, { scale: ctx.scale });
    return `<table class="bd-totals">${rows.map((r) => (r.grand
      ? `<tr class="bd-grand"${el.divider !== false ? ` style="border-top:0.8pt solid ${ctx.theme.primary}"` : ''}><td style="${gs}">${esc(r.label)}</td><td class="bd-r" style="${gs}">${esc(r.value)}</td></tr>`
      : `<tr data-k="${r.key}"><td>${esc(r.label)}</td><td class="bd-r">${esc(r.value)}</td></tr>`)).join('')}</table>`;
  },

  taxSummary(el, ctx) {
    const items = ctx.model.items || [];
    const fmt = fmtWithCurrency(ctx.fmt, ctx.model);
    const usable = items.length && items.every((it) => it.taxAmount !== null && it.taxAmount !== undefined && it.taxPercent !== null && it.taxPercent !== undefined);
    if (!usable) return placeholder(ctx, '[Tax summary needs per-line tax on the document]');
    const groups = new Map();
    items.forEach((it) => {
      const key = `${el.showHsn ? it.hsn || '-' : ''}|${it.taxPercent}`;
      const g = groups.get(key) || { hsn: it.hsn || '-', rate: it.taxPercent, tax: 0, lines: 0 };
      g.tax += Number(it.taxAmount) || 0;
      g.lines += 1;
      groups.set(key, g);
    });
    const list = [...groups.values()].sort((a, b) => a.rate - b.rate);
    const sum = Math.round(list.reduce((s, g) => s + g.tax, 0) * 100) / 100;
    const docTax = rawField(ctx.model, 'totals.tax');
    if (docTax !== null && Math.abs(docTax - sum) > 0.011) {
      ctx.warn?.({ level: 'info', elementId: el.id, message: `Tax summary lines add up to ${formatMoney(sum, fmt)} but the document's tax is ${formatMoney(docTax, fmt)} (bill-level adjustments) — the totals block shows the document figure.` });
    }
    const head = `<tr>${el.showHsn ? '<th>HSN</th>' : ''}<th>GST %</th><th class="bd-r">Lines</th><th class="bd-r">Tax amount</th></tr>`;
    const body = list.map((g) => `<tr>${el.showHsn ? `<td>${esc(g.hsn)}</td>` : ''}<td>${esc(formatNumber(g.rate, { decimals: g.rate % 1 ? 2 : 0 }))}%</td><td class="bd-r">${g.lines}</td><td class="bd-r">${esc(formatMoney(g.tax, fmt))}</td></tr>`).join('');
    return `<table class="bd-taxsum"><thead>${head}</thead><tbody>${body}</tbody><tfoot><tr><td colspan="${el.showHsn ? 3 : 2}">Total of lines</td><td class="bd-r">${esc(formatMoney(sum, fmt))}</td></tr></tfoot></table>`;
  },

  payment(el, ctx) {
    const s = el.show || {};
    const m = ctx.model;
    const fmt = fmtWithCurrency(ctx.fmt, m);
    const rows = [];
    if (s.method && m.payment?.method) rows.push(['Method', esc(m.payment.method)]);
    if (s.reference && m.payment?.reference) rows.push(['Reference', esc(m.payment.reference)]);
    if (s.splits && (m.payment?.splits || []).length > 1) {
      rows.push(['Split', m.payment.splits.map((x) => `${esc(x.mode)} ${esc(formatMoney(x.amount, fmt))}`).join(', ')]);
    }
    const paid = rawField(m, 'totals.paid');
    const bal = rawField(m, 'totals.balance');
    if (s.paid && paid !== null) rows.push(['Paid', esc(formatMoney(paid, fmt))]);
    if (s.balance && bal !== null) rows.push(['Balance', esc(formatMoney(bal, fmt))]);
    if (s.status && m.payment?.status) rows.push(['Status', esc(m.payment.status)]);
    if (s.bank && m.company?.bankDetails) rows.push(['Bank', nl2br(m.company.bankDetails)]);
    if (s.upi && m.company?.upiId) rows.push(['UPI', esc(m.company.upiId)]);
    if (!rows.length) return placeholder(ctx, '[No payment details on this document]');
    const title = el.title ? `<div class="bd-title">${esc(el.title)}</div>` : '';
    return `${title}<table class="bd-fl">${rows.map(([k, v]) => `<tr><td class="bd-k" style="width:17mm">${k}</td><td class="bd-v">${v}</td></tr>`).join('')}</table>`;
  },

  barcode(el, ctx) {
    const value = String(rawField(ctx.model, el.field || 'document.number') ?? '').trim();
    if (!value) return placeholder(ctx, '[Barcode — no value]');
    const enc = encodeBarcode('CODE128', value);
    if (enc.error) {
      ctx.warn?.({ level: 'warning', elementId: el.id, message: `Barcode: ${enc.error}` });
      return ctx.editor ? `<span class="bd-ph">${esc(enc.error)}</span>` : esc(value);
    }
    const textH = el.showText !== false ? Math.min(3.2, el.h * 0.3) : 0;
    const q = 10;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-q} 0 ${enc.modules + 2 * q} 1" preserveAspectRatio="none" style="display:block;width:100%;height:${mm(Math.max(1, el.h - textH))}" shape-rendering="crispEdges"><path d="${enc.path}" fill="#000000"/></svg>`;
    const moduleMm = el.w / (enc.modules + 2 * q);
    if (moduleMm < 0.19) ctx.warn?.({ level: 'warning', elementId: el.id, message: `Barcode bars are ${r2(moduleMm)} mm wide — widen the barcode to at least ${r2(0.19 * (enc.modules + 2 * q))} mm so scanners can read it.` });
    return `${svg}${textH ? `<div class="bd-bc-text" style="font-size:${r2(Math.max(5, textH / PT_TO_MM * 0.8))}pt">${esc(value)}</div>` : ''}`;
  },

  qr(el, ctx) {
    const m = ctx.model;
    let value = '';
    if (el.source === 'upi') {
      const upi = m.company?.upiId;
      if (!upi) return placeholder(ctx, '[Set a UPI ID in Logo & Branding]');
      const bal = rawField(m, 'totals.balance');
      const payable = bal !== null && bal > 0 ? bal : rawField(m, 'totals.grandTotal');
      value = `upi://pay?pa=${encodeURIComponent(upi)}&pn=${encodeURIComponent(m.company?.name || '')}${payable !== null && payable > 0 ? `&am=${payable.toFixed(2)}` : ''}&cu=INR&tn=${encodeURIComponent(m.document?.number || '')}`;
    } else if (el.source === 'custom') {
      value = String(el.customText || '').replace(/\{\{\s*([a-zA-Z]+\.[a-zA-Z]+)\s*\}\}/g, (_, id) => fieldValue(ctx, id));
    } else {
      value = String(rawField(m, el.field || 'document.number') ?? '');
    }
    value = value.trim();
    if (!value) return placeholder(ctx, '[QR — no value]');
    try {
      const qr = QRCode.create(value, { errorCorrectionLevel: 'M' });
      const n = qr.modules.size;
      const d = qr.modules.data;
      let path = '';
      for (let y = 0; y < n; y += 1) for (let x = 0; x < n; x += 1) if (d[y * n + x]) path += `M${x} ${y}h1v1h-1z`;
      const size = Math.min(el.w, el.h);
      const pos = { left: 'margin-right:auto', right: 'margin-left:auto', center: 'margin:0 auto' }[el.style?.align || 'center'];
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="-2 -2 ${n + 4} ${n + 4}" style="display:block;width:${mm(size)};height:${mm(size)};${pos}" shape-rendering="crispEdges"><path d="${path}" fill="#000000"/></svg>`;
    } catch {
      ctx.warn?.({ level: 'warning', elementId: el.id, message: 'QR code: the value is too long to encode.' });
      return placeholder(ctx, '[QR value too long]');
    }
  },

  signature(el, ctx) {
    const co = el.showCompany !== false && ctx.model.company?.name ? `<div class="bd-sign-co">For ${esc(ctx.model.company.name)}</div>` : '<div></div>';
    const img = el.src ? `<img src="${esc(el.src)}" alt="" style="max-height:55%;max-width:100%;object-fit:contain;align-self:center"/>` : '';
    const line = `<div class="bd-sign-label"${el.showLine !== false ? ` style="border-top:0.6pt solid ${ctx.theme.text}"` : ''}>${esc(el.label || '')}</div>`;
    return `<div class="bd-sign">${co}${img}${line}</div>`;
  },

  line(el) {
    const b = `${num(el.thickness, 0.5)}pt ${el.lineStyle || 'solid'} ${el.color || '#0f172a'}`;
    return el.orientation === 'v'
      ? `<div style="position:absolute;top:0;bottom:0;left:50%;border-left:${b}"></div>`
      : `<div style="position:absolute;left:0;right:0;top:50%;border-top:${b}"></div>`;
  },

  box() { return ''; },

  pageNumber(el, ctx) {
    return esc(String(el.format || 'Page {page} of {pages}').replace('{page}', ctx.pageNo || 1).replace('{pages}', ctx.pageCount || 1));
  },
};

/** Should the element print on this document? (hidden flag + optional visibility condition) */
export function elementVisible(el, model) {
  if (el.hidden) return false;
  if (el.visibleIf) {
    const v = rawField(model, el.visibleIf);
    if (blank(v) || v === 0) return false;
  }
  return true;
}

function elementBox(el, ctx, scale = 1) {
  const st = el.style || {};
  const elCtx = { ...ctx, scale };
  const inner = (RENDER[el.type] || (() => ''))(el, elCtx);
  const nowrap = st.wrap === false ? ' bd-nowrap' : '';
  const css = [
    `left:${mm(el.x)}`, `top:${mm(el.y)}`, `width:${mm(el.w)}`, `height:${mm(el.h)}`,
    `justify-content:${VALIGN[st.valign || 'top']}`,
    styleCss(st, ctx, { scale }),
  ].filter(Boolean).join(';');
  return `<div class="bd-el bd-${el.type}${nowrap}" data-el="${esc(el.id)}" style="${css}"><div class="bd-in">${inner}</div></div>`;
}

// ---------------------------------------------------------------------------
// Items table
// ---------------------------------------------------------------------------

function visibleColumns(table) {
  return (table.columns || []).filter((c) => c.visible !== false && COLUMN_BY_KEY[c.key]);
}

// Amounts / quantities never wrap mid-number ("₹1,000." + "00" on the next line).
const NUMERIC = new Set(['money', 'qty', 'percent', 'index']);

function cellValue(col, item, index, ctx, table, cols) {
  const fmt = { ...fmtWithCurrency(ctx.fmt, ctx.model), ...(table.currencyInTable === false ? { currencySymbol: '' } : {}) };
  const decimals = col.decimals ?? fmt.decimals;
  const has = (k) => cols.some((c) => c.key === k);
  switch (col.key) {
    case 'slno': return String(index + 1);
    case 'name': {
      let html = `<div class="bd-item-name">${esc(item.name)}</div>`;
      const subs = [];
      if (table.showBrand && item.brand && !has('brand')) subs.push(esc(item.brand));
      if (table.showVariant && item.variant && !has('variant') && !has('size') && !has('color')) subs.push(esc(item.variant));
      if (table.showSku && item.sku && !has('sku')) subs.push(`SKU ${esc(item.sku)}`);
      if (subs.length) html += `<div class="bd-sub">${subs.join(' · ')}</div>`;
      if (table.showPower !== false && item.power && !has('power')) html += `<div class="bd-sub bd-power">${esc(item.power)}</div>`;
      return html;
    }
    case 'qty':
    case 'freeQty': {
      const v = item[col.key];
      if (v === null || v === undefined || v === '') return '';
      const n = Number(v);
      return Number.isFinite(n) ? esc(formatNumber(n, { decimals: n % 1 ? 2 : 0, thousands: 'none' })) : esc(v);
    }
    case 'discount': {
      if (item.discount !== null && item.discount !== undefined) return esc(formatMoney(item.discount, { ...fmt, decimals }));
      return item.discountPercent ? `${esc(formatNumber(item.discountPercent, { decimals: item.discountPercent % 1 ? 2 : 0 }))}%` : '';
    }
    default: break;
  }
  const kind = COLUMN_BY_KEY[col.key]?.kind;
  const v = item[col.key];
  if (v === null || v === undefined || v === '') return '';
  if (kind === 'money') return esc(formatMoney(v, { ...fmt, decimals }));
  if (kind === 'percent') return `${esc(formatNumber(v, { decimals: Number(v) % 1 ? 2 : 0 }))}%`;
  if (kind === 'date') return esc(formatDate(v, fmt.dateFormat));
  return esc(v);
}

export function tableHtml(model, rows, startIndex, table, ctx, { header = true, fillerMm = 0, totalRow = false } = {}) {
  const cols = visibleColumns(table);
  if (!cols.length) return '';
  const totalW = cols.reduce((s, c) => s + num(c.width, 10), 0) || 1;
  const colgroup = `<colgroup>${cols.map((c) => `<col style="width:${r2((num(c.width, 10) / totalW) * 100)}%"/>`).join('')}</colgroup>`;
  const hs = table.headerStyle || {};
  const thCss = styleCss({ ...hs, bg: hs.bg || ctx.theme.headerBg, color: hs.color || ctx.theme.headerText }, ctx);
  const thead = header ? `<thead><tr>${cols.map((c) => `<th style="text-align:${c.align || 'left'};${thCss}">${esc(c.label ?? COLUMN_BY_KEY[c.key].label)}</th>`).join('')}</tr></thead>` : '';
  let body;
  if (!rows.length && startIndex === 0) {
    body = `<tr class="bd-row"><td colspan="${cols.length}" class="bd-empty">${esc(table.emptyText || 'No items')}</td></tr>`;
  } else {
    body = rows.map((item, i) => {
      const idx = startIndex + i;
      const zebra = table.zebra && idx % 2 === 1 ? ` style="background:${table.zebraColor || '#f8fafc'}"` : '';
      return `<tr class="bd-row" data-row="${idx}"${zebra}>${cols.map((c) => `<td${NUMERIC.has(COLUMN_BY_KEY[c.key]?.kind) ? ' class="bd-num"' : ''} style="text-align:${c.align || 'left'}">${cellValue(c, item, idx, ctx, table, cols)}</td>`).join('')}</tr>`;
    }).join('');
  }
  if (fillerMm > 0.5) {
    body += `<tr class="bd-filler">${cols.map(() => `<td style="height:${mm(fillerMm)};padding:0"></td>`).join('')}</tr>`;
  }
  if (totalRow) {
    const q = rawField(model, 'totals.totalQty');
    body += `<tr class="bd-total-row">${cols.map((c, i) => {
      if (c.key === 'qty') return `<td style="text-align:${c.align || 'center'}">${q === null ? '' : esc(formatNumber(q, { decimals: q % 1 ? 2 : 0, thousands: 'none' }))}</td>`;
      return i === 0 ? '<td>Total</td>' : '<td></td>';
    }).join('')}</tr>`;
  }
  return `<table class="bd-table bd-b-${table.borders || 'rows'}">${colgroup}${thead}<tbody>${body}</tbody></table>`;
}

function tableCss(table, theme) {
  const bc = table.borderColor || theme.border;
  const pad = `${mm(num(table.rowPadding, 1.6))} ${mm(num(table.cellPadX, 1.3))}`;
  const bs = table.bodyStyle || {};
  const base = [
    `.bd-table{width:100%;border-collapse:collapse;table-layout:fixed}`,
    `.bd-table th,.bd-table td{padding:${pad};vertical-align:top;overflow-wrap:anywhere;word-break:break-word}`,
    `.bd-table td{${[bs.fontSize && `font-size:${bs.fontSize}pt`, bs.color && `color:${bs.color}`, bs.fontFamily && bs.fontFamily !== 'inherit' && `font-family:${bs.fontFamily}`, bs.lineHeight && `line-height:${bs.lineHeight}`].filter(Boolean).join(';')}}`,
    `.bd-table th{font-weight:700}`,
    `.bd-table td.bd-num,.bd-table th.bd-num{white-space:nowrap}`,
    `.bd-table .bd-empty{text-align:center;color:${theme.muted};font-style:italic}`,
    `.bd-table .bd-total-row td{font-weight:700;border-top:0.8pt solid ${bc}}`,
  ];
  const b = `0.5pt solid ${bc}`;
  switch (table.borders) {
    case 'grid': base.push(`.bd-table th,.bd-table td{border:${b}}`); break;
    case 'outer': base.push(`.bd-table{border:${b}}`, `.bd-table th{border-bottom:${b}}`, `.bd-table td+td,.bd-table th+th{border-left:${b}}`); break;
    case 'header': base.push(`.bd-table th{border-bottom:0.8pt dashed ${bc};border-top:0.8pt dashed ${bc}}`); break;
    case 'none': break;
    default: base.push(`.bd-table td{border-bottom:${b}}`, `.bd-table th{border-bottom:${b}}`, `.bd-table .bd-filler td{border-bottom:none}`);
  }
  return base.join('\n');
}

// ---------------------------------------------------------------------------
// Stylesheet
// ---------------------------------------------------------------------------

export function billCss(cfg, theme) {
  const t = theme;
  return `
.bd-root{color:${t.text};font-family:${t.fontFamily};font-size:${t.fontSize}pt;line-height:${t.lineHeight};-webkit-print-color-adjust:exact;print-color-adjust:exact;text-align:left}
.bd-root *,.bd-root *::before,.bd-root *::after{box-sizing:border-box;margin:0;padding:0}
.bd-root .bd-page{position:relative;background:${cfg.page?.background || '#ffffff'};overflow:hidden}
.bd-root .bd-content{position:absolute}
.bd-root .bd-band{position:absolute;left:0;width:100%}
.bd-root .bd-items{position:absolute;left:0;width:100%}
.bd-root .bd-el{position:absolute;overflow:hidden;display:flex;flex-direction:column}
.bd-root .bd-el>.bd-in{width:100%;overflow-wrap:anywhere;word-break:break-word}
.bd-root .bd-nowrap>.bd-in{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.bd-root .bd-line>.bd-in,.bd-root .bd-box>.bd-in{position:absolute;inset:0}
.bd-root .bd-logo>.bd-in,.bd-root .bd-image>.bd-in,.bd-root .bd-signature>.bd-in{height:100%}
.bd-root .bd-muted{color:${t.muted}}
.bd-root .bd-title{font-weight:700;color:${t.primary};margin-bottom:0.6mm;font-size:1.02em}
.bd-root .bd-kv{display:flex;align-items:baseline}
.bd-root .bd-k{color:${t.muted}}
.bd-root .bd-lbl-top{font-size:0.82em;text-transform:uppercase;letter-spacing:0.3pt;font-weight:700;margin-bottom:0.3mm}
.bd-root .bd-ph{color:#94a3b8;font-style:italic}
.bd-root .bd-ph-box{border:1px dashed #94a3b8;color:#94a3b8;font-size:7pt;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;width:100%;height:100%;line-height:1.2}
.bd-root .bd-fl{width:100%;border-collapse:collapse}
.bd-root .bd-fl td{padding:0.25mm 0;vertical-align:top}
.bd-root .bd-fl .bd-sep{width:2.2mm;text-align:center}
.bd-root .bd-co-name{font-weight:800;line-height:1.15;letter-spacing:0.2pt;margin-bottom:0.5mm}
.bd-root .bd-co-tag{font-size:0.86em;text-transform:uppercase;letter-spacing:0.4pt;font-weight:600}
.bd-root .bd-party-title{font-size:0.8em;text-transform:uppercase;letter-spacing:0.4pt;font-weight:700;color:${t.muted};margin-bottom:0.4mm}
.bd-root .bd-party-name{font-weight:700;font-size:1.08em}
.bd-root .bd-totals{width:100%;border-collapse:collapse}
.bd-root .bd-totals td{padding:0.55mm 0}
.bd-root .bd-totals .bd-grand td{padding-top:1.2mm}
.bd-root .bd-r{text-align:right;white-space:nowrap}
.bd-root .bd-taxsum{width:100%;border-collapse:collapse}
.bd-root .bd-taxsum th,.bd-root .bd-taxsum td{border:0.5pt solid ${t.border};padding:0.5mm 1mm;text-align:left}
.bd-root .bd-taxsum th{background:${t.border}33;font-weight:700}
.bd-root .bd-taxsum tfoot td{font-weight:700}
.bd-root .bd-taxsum .bd-r{text-align:right}
.bd-root .bd-sign{display:flex;flex-direction:column;justify-content:space-between;height:100%}
.bd-root .bd-sign-co{font-weight:600}
.bd-root .bd-sign-label{padding-top:0.8mm;font-weight:700}
.bd-root .bd-bc-text{text-align:center;letter-spacing:0.5pt;line-height:1.1;margin-top:0.3mm}
.bd-root .bd-sub{font-size:0.86em;color:${t.muted}}
.bd-root .bd-power{color:${t.primary};font-weight:700}
.bd-root .bd-more{margin-top:1mm;padding:1mm;border:1px dashed #94a3b8;color:#64748b;font-size:7.5pt;text-align:center;font-style:italic}
${tableCss(cfg.bands.items.table, t)}
`;
}

// ---------------------------------------------------------------------------
// Measurement
// ---------------------------------------------------------------------------

/** Measures rendered heights in the live DOM (browser). The host is detached from any
 *  transformed / styled ancestor so the numbers match the print window exactly. */
export function createDomMeasurer(css, widthMm) {
  if (typeof document === 'undefined' || !document.body) return null;
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  host.style.cssText = 'position:absolute;left:-30000px;top:0;visibility:hidden;pointer-events:none;';
  host.innerHTML = `<style>${css}</style><div class="bd-root"><div class="bd-mbox" style="position:relative;width:${widthMm}mm"></div></div>`;
  document.body.appendChild(host);
  const box = host.querySelector('.bd-mbox');
  const toMm = (px) => px / PX_PER_MM;
  return {
    table(html) {
      box.innerHTML = html;
      const head = box.querySelector('thead');
      const rows = [...box.querySelectorAll('tbody > tr')];
      const out = { thead: head ? toMm(head.getBoundingClientRect().height) : 0, rows: rows.map((r) => toMm(r.getBoundingClientRect().height)) };
      box.innerHTML = '';
      return out;
    },
    /** -> {fits, scale}: largest scale (1 → 0.5) at which the element's content fits its box. */
    fit(renderAt, { shrink }) {
      const test = (scale) => {
        box.innerHTML = renderAt(scale);
        const el = box.firstElementChild;
        const inner = el?.firstElementChild;
        if (!el || !inner) return true;
        // Lift the element out of its band offset so measuring is position-independent.
        el.style.left = '0';
        el.style.top = '0';
        const cs = getComputedStyle(el);
        const availH = el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
        const availW = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        return inner.scrollHeight <= availH + 1.5 && inner.scrollWidth <= availW + 1.5;
      };
      let fits = test(1);
      let scale = 1;
      if (!fits && shrink) {
        for (let s = 0.95; s >= 0.5; s -= 0.05) {
          if (test(s)) { scale = r2(s); fits = true; break; }
        }
        if (!fits) scale = 0.5;
      }
      box.innerHTML = '';
      return { fits, scale };
    },
    dispose() { host.remove(); },
  };
}

/** DOM-free estimate (tests / server). Approximates wrapped lines from character counts. */
export function createEstimateMeasurer(theme, table, contentW) {
  const lineMm = (pt, lh) => pt * PT_TO_MM * lh;
  return {
    table(_html, rows = [], cols = []) {
      const hs = table.headerStyle?.fontSize || theme.fontSize;
      const bs = table.bodyStyle?.fontSize || theme.fontSize;
      const pad = num(table.rowPadding, 1.6) * 2;
      const totalW = cols.reduce((s, c) => s + num(c.width, 10), 0) || 1;
      const nameCol = cols.find((c) => c.key === 'name');
      const nameW = nameCol ? (num(nameCol.width, 10) / totalW) * contentW - 2.6 : contentW;
      const charsPerLine = Math.max(4, nameW / (bs * PT_TO_MM * 0.52));
      return {
        thead: lineMm(hs, 1.3) + pad,
        rows: rows.map((it) => {
          let lines = Math.ceil(String(it.name || '').length / charsPerLine) || 1;
          if (table.showPower !== false && it.power) lines += Math.ceil(it.power.length / charsPerLine) * 0.9;
          if ((table.showBrand && it.brand) || (table.showVariant && it.variant)) lines += 0.9;
          return lineMm(bs, theme.lineHeight || 1.3) * lines + pad;
        }),
      };
    },
    fit() { return { fits: true, scale: 1 }; },
    dispose() {},
  };
}

// ---------------------------------------------------------------------------
// Layout / pagination
// ---------------------------------------------------------------------------

/**
 * Pure pagination over measured heights (mm). Returns page descriptors:
 *   { showHeader, table: {start, end, top, header, filler} | null, summaryTop | null, footerTop }
 */
export function paginate({ contentH, thermal, hH, hS, hF, items, mt, mb, thead, rows, headerOnEveryPage, summaryAt, fillPage }) {
  const SAFETY = 0.6;
  const pages = [];
  if (thermal) {
    const tableH = items ? thead + rows.reduce((s, h) => s + h, 0) : 0;
    const tableTop = hH + (items ? mt : 0);
    const summaryTop = tableTop + tableH + (items ? mb : 0);
    pages.push({
      showHeader: true,
      table: items ? { start: 0, end: rows.length, top: tableTop, header: true, filler: 0 } : null,
      summaryTop,
      footerTop: summaryTop + hS,
    });
    return { pages, height: summaryTop + hS + hF };
  }
  const footerTop = contentH - hF;
  const headerOn = (i) => i === 0 || headerOnEveryPage;
  const placeSummary = (page, after) => {
    page.summaryTop = summaryAt === 'page-bottom' ? footerTop - hS : after;
  };
  if (!items) {
    const p = { showHeader: true, table: null, summaryTop: null, footerTop };
    placeSummary(p, hH);
    pages.push(p);
    return { pages };
  }
  let i = 0;
  const n = rows.length;
  // An empty document still draws the table header + an "no items" row.
  const rowsH = n ? rows : [rows[0] ?? 0];
  const total = n || 1;
  while (i < total || !pages.length) {
    const pIdx = pages.length;
    const top = (headerOn(pIdx) ? hH : 0) + mt;
    const room = footerTop - top - thead - SAFETY;
    let used = 0;
    const start = i;
    while (i < total && (used + rowsH[i] <= room || i === start)) {
      used += rowsH[i];
      i += 1;
    }
    const page = { showHeader: headerOn(pIdx), table: { start, end: n ? i : 0, top, header: true, filler: 0 }, summaryTop: null, footerTop };
    pages.push(page);
    const tableBottom = top + thead + used;
    if (i < total) {
      // Continuation page: "fill page" carries the column rules down to the footer.
      if (fillPage) page.table.filler = Math.max(0, footerTop - tableBottom - SAFETY);
      continue;
    }
    if (footerTop - tableBottom - mb - SAFETY >= hS) {
      placeSummary(page, tableBottom + mb);
      if (fillPage) {
        // Classic ruled invoice: the table runs down to the summary, which sits at the bottom.
        page.summaryTop = footerTop - hS;
        page.table.filler = Math.max(0, page.summaryTop - mb - tableBottom - SAFETY);
      }
    } else {
      if (fillPage) page.table.filler = Math.max(0, footerTop - tableBottom - SAFETY);
      const p2 = { showHeader: headerOn(pages.length), table: null, summaryTop: null, footerTop };
      placeSummary(p2, (p2.showHeader ? hH : 0) + mt);
      pages.push(p2);
    }
    break;
  }
  return { pages };
}

/**
 * Lay the document out. `opts.designRows` caps the item rows (designer canvas), `opts.measurer`
 * overrides measurement (tests).
 */
export function layoutBill(template, model, opts = {}) {
  const cfg = normalizeConfig(template.config);
  const g = pageGeometry(template);
  const theme = effectiveTheme(cfg.theme, opts.branding || {});
  const fmt = cfg.format;
  const warnings = [];
  const warn = (w) => { if (!warnings.some((x) => x.message === w.message && x.elementId === w.elementId)) warnings.push(w); };
  const ctx = { model, fmt, theme, editor: !!opts.editor, warn, scale: 1 };
  const css = billCss(cfg, theme);
  const bands = cfg.bands;
  const table = bands.items.table;
  const itemsOn = bands.items.visible !== false && visibleColumns(table).length > 0;
  const allItems = model.items || [];
  const items = opts.designRows != null ? allItems.slice(0, opts.designRows) : allItems;

  const measurer = opts.measurer
    || (opts.measure === 'estimate' ? null : createDomMeasurer(css, g.contentW))
    || createEstimateMeasurer(theme, table, g.contentW);
  let measured = { thead: 0, rows: [] };
  const scales = {};
  try {
    if (itemsOn) {
      const html = tableHtml(model, items, 0, table, ctx, { totalRow: table.totalRow });
      measured = measurer.table(html, items.length ? items : [{ name: table.emptyText || '' }], visibleColumns(table));
      if (table.totalRow && measured.rows.length > items.length) {
        // The total row rides on the last page: fold its height into the last item row.
        const extra = measured.rows.pop();
        if (measured.rows.length) measured.rows[measured.rows.length - 1] += extra;
      }
    }
    BANDS.forEach((b) => {
      (bands[b].elements || []).forEach((el) => {
        if (!elementVisible(el, model) || ['line', 'box', 'logo', 'image', 'qr', 'barcode'].includes(el.type)) return;
        const shrink = !!el.style?.shrinkToFit;
        const res = measurer.fit((s) => elementBox(el, { ...ctx, editor: false, warn: null }, s), { shrink });
        if (res.scale !== 1) scales[el.id] = res.scale;
        if (!res.fits) {
          warn({ level: 'warning', elementId: el.id, message: `“${elementTitle(el)}” doesn't fit its box${shrink ? ' even at half size' : ''} — enlarge it${shrink ? '' : ' or turn on Shrink to fit'}.` });
        }
      });
    });
  } finally {
    if (!opts.measurer) measurer.dispose();
  }

  // Geometry warnings.
  BANDS.forEach((b) => {
    const band = bands[b];
    (band.elements || []).forEach((el) => {
      if (el.hidden) return;
      if (el.y + el.h > band.height + 0.6 || el.y < -0.6) warn({ level: 'warning', elementId: el.id, message: `“${elementTitle(el)}” sticks out of the ${b === 'footer' ? 'page footer' : b} section — it may overlap the items table.` });
      if (el.x < -0.6 || el.x + el.w > g.contentW + 0.6) warn({ level: 'warning', elementId: el.id, message: `“${elementTitle(el)}” is outside the printable width (inside the margins).` });
    });
  });
  const hH = num(bands.header.height);
  const hS = num(bands.summary.height);
  const hF = num(bands.footer.height);
  if (!g.thermal && hH + hS + hF + (itemsOn ? measured.thead + (measured.rows[0] || 5) : 0) > g.contentH) {
    warn({ level: 'error', message: `Header + summary + footer (${r2(hH + hS + hF)} mm) leave no room for items on a ${r2(g.contentH)} mm page — make the sections shorter or use a larger paper size.` });
  }

  const { pages, height } = paginate({
    contentH: g.contentH, thermal: g.thermal, hH, hS, hF, items: itemsOn,
    mt: num(bands.items.marginTop), mb: num(bands.items.marginBottom),
    thead: measured.thead, rows: measured.rows,
    headerOnEveryPage: !!cfg.page.headerOnEveryPage, summaryAt: cfg.page.summaryAt, fillPage: !!table.fillPage,
  });
  const geometry = g.thermal
    ? { ...g, pageH: r2(height + g.margins.top + g.margins.bottom), contentH: r2(height) }
    : g;
  if (!model.isSample && rawField(model, 'totals.grandTotal') === null && model.document?.type !== 'PAYMENT_RECEIPT') {
    warn({ level: 'info', message: 'This document has no grand total recorded — totals print as “—”.' });
  }
  return { cfg, theme, css, geometry, pages, scales, warnings, items, measured, itemsOn, truncatedRows: allItems.length - items.length };
}

/** HTML for every page (each a fixed-size .bd-page box). */
export function renderBillPages(template, model, layout, opts = {}) {
  // Positions come from the live template (the designer re-renders on every drag without
  // re-measuring); sizes, page breaks and font scales from the measured layout.
  const { theme, geometry: g, pages, scales, items, itemsOn } = layout;
  const cfg = normalizeConfig(template.config);
  const ctxBase = { model, fmt: cfg.format, theme, editor: !!opts.editor, warn: opts.warn || null, scale: 1 };
  const bands = cfg.bands;
  const bandHtml = (name, top, pageNo) => {
    const band = bands[name];
    const ctx = { ...ctxBase, pageNo, pageCount: pages.length };
    const els = (band.elements || []).filter((el) => elementVisible(el, model))
      .map((el) => elementBox(el, ctx, scales[el.id] || 1)).join('');
    const bg = band.bg ? `background:${band.bg};` : '';
    return `<div class="bd-band" data-band="${name}" style="top:${mm(top)};height:${mm(band.height)};${bg}">${els}</div>`;
  };
  const out = pages.map((p, idx) => {
    const pageNo = idx + 1;
    const parts = [];
    if (p.showHeader && bands.header.height > 0) parts.push(bandHtml('header', 0, pageNo));
    if (p.table && itemsOn) {
      const slice = items.slice(p.table.start, p.table.end);
      const last = p.table.end >= items.length;
      const html = tableHtml(model, slice, p.table.start, bands.items.table, ctxBase, {
        header: idx === 0 || bands.items.table.repeatHeader !== false || p.table.start === 0,
        fillerMm: p.table.filler, totalRow: last && bands.items.table.totalRow,
      });
      const more = opts.editor && layout.truncatedRows > 0 && last
        ? `<div class="bd-more">+ ${layout.truncatedRows} more item row(s) — see Preview for the full document</div>` : '';
      parts.push(`<div class="bd-items" data-band="items" style="top:${mm(p.table.top)}">${html}${more}</div>`);
    }
    if (p.summaryTop !== null && p.summaryTop !== undefined && bands.summary.height > 0) parts.push(bandHtml('summary', p.summaryTop, pageNo));
    if (bands.footer.height > 0) parts.push(bandHtml('footer', p.footerTop, pageNo));
    return `<div class="bd-page" data-page="${pageNo}" style="width:${mm(g.pageW)};height:${mm(g.pageH)}"><div class="bd-content" style="left:${mm(g.margins.left)};top:${mm(g.margins.top)};width:${mm(g.contentW)};height:${mm(g.contentH)}">${parts.join('')}</div></div>`;
  });
  return { css: layout.css, pages: out };
}

/** Complete, self-contained print document for a visual template. */
export function renderVisualBillHtml(template, model, opts = {}) {
  const layout = layoutBill(template, model, opts);
  const { pages, css } = renderBillPages(template, model, layout, opts);
  const g = layout.geometry;
  const autoPrint = opts.autoPrint
    ? '<script>window.addEventListener("load",function(){setTimeout(function(){try{window.focus();window.print();}catch(e){}},300);});<\/script>'
    : '';
  const title = [model.document?.title, model.document?.number].filter(Boolean).join(' ') || 'Bill';
  const html = `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${esc(title)}</title>
<style>
@page{size:${r2(g.pageW)}mm ${r2(g.pageH)}mm;margin:0}
html,body{margin:0;padding:0;background:#ffffff}
${css}
.bd-root .bd-page{break-after:page;page-break-after:always}
.bd-root .bd-page:last-child{break-after:auto;page-break-after:auto}
@media screen{body{background:#e2e8f0;padding:16px 0}.bd-root .bd-page{margin:0 auto 16px;box-shadow:0 2px 12px rgba(15,23,42,.18)}}
</style></head><body><div class="bd-root">${pages.join('')}</div>${autoPrint}</body></html>`;
  return { html, layout };
}

export { tokensIn };
