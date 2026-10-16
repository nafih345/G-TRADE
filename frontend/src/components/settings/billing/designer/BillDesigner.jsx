// Settings → Bill & Invoice Designer → visual editor (full screen).
//
// Three panels: elements / data fields / layers (left), the live page canvas (centre) and the
// properties of the selection (right). The canvas is drawn by the same renderer that prints,
// fed either clearly-labelled sample data or a real transaction picked from the database.
// Templates hold layout + bindings only; saving never touches any transaction.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Dialog, Box, Stack, Typography, Button, IconButton, Tooltip, Divider, Alert, Chip, Menu, MenuItem,
  ListItemIcon, ListItemText, ToggleButton, CircularProgress, Paper, AppBar, Toolbar, ListSubheader,
} from '@mui/material';
import {
  Undo, Redo, ZoomIn, ZoomOut, FitScreen, Fullscreen, GridOn, Straighten, ContentCopy, DeleteOutline,
  FlipToFront, FlipToBack, Save, SaveAs, MoreVert, Add, DriveFileRenameOutline, History, RestartAlt,
  Visibility, Print, Close, Lock, LockOpen, AlignHorizontalLeft, ErrorOutline, WarningAmber, InfoOutlined,
  FormatAlignCenter, AlignHorizontalRight, AlignVerticalTop, AlignVerticalCenter, AlignVerticalBottom,
  ViewColumn, Keyboard,
} from '@mui/icons-material';
import BillCanvas, { ITEMS_ID } from './BillCanvas';
import BillPalette from './BillPalette';
import ElementProperties from './ElementProperties';
import ItemsTableEditor from './ItemsTableEditor';
import PageSettings from './PageSettings';
import PreviewSource from './PreviewSource';
import { NamePrompt, VersionsDialog } from './DesignerDialogs';
import BillPreview from '../../../../billing/BillPreview';
import {
  normalizeConfig, convertLegacyTemplate, createElement, clone, newElementId, alignElements, distributeElements,
  findElement, elementTitle, ELEMENT_LIBRARY, r2,
} from '../../../../billing/billLayout';
import {
  layoutBill, renderBillPages, pageGeometry, renderVisualBillHtml, PX_PER_MM,
} from '../../../../billing/renderBillLayout';
import { compatibleDocTypes, FIELD_BY_ID, canonicalDocType } from '../../../../billing/billFields';
import { sampleBillModel } from '../../../../billing/sampleModels';
import { toBillModel, resolveCompany } from '../../../../billing/documentAdapters';
import { loadBillingContext, invalidateBillingContext } from '../../../../billing/billingContext';
import { openPrintWindow } from '../../../../billing/printBill';
import {
  createTemplate, updateTemplate, renameTemplate, restoreTemplateDefault, restoreTemplateVersion, fetchTemplate, apiError,
} from '../../../../billing/billingApi';
import { notify } from '../../../../utils/notify';

const isTyping = (el) => el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
const LEVEL_ICON = { error: <ErrorOutline color="error" fontSize="small" />, warning: <WarningAmber color="warning" fontSize="small" />, info: <InfoOutlined color="info" fontSize="small" /> };
const BANDS = ['header', 'summary', 'footer'];
const DEFAULT_BAND_FOR_GROUP = { Header: 'header', Party: 'header', Amounts: 'summary', Codes: 'summary', Text: 'summary', 'Sign-off': 'summary', Shapes: 'summary' };

// The template fields a save sends (never ids of documents, never transaction values).
const SAVE_KEYS = ['name', 'description', 'template_type', 'paper_size', 'orientation', 'custom_width_mm', 'custom_height_mm', 'margins', 'config'];
const payloadOf = (t) => {
  const p = Object.fromEntries(SAVE_KEYS.map((k) => [k, t[k]]));
  if (p.paper_size !== 'CUSTOM') { p.custom_width_mm = null; p.custom_height_mm = null; }
  if (p.custom_height_mm === '' || p.custom_height_mm === undefined) p.custom_height_mm = null;
  return p;
};

// Element ids must be unique across the whole template (selection is by id).
function dedupeIds(config) {
  const seen = new Set();
  const bands = { ...config.bands };
  BANDS.forEach((b) => {
    bands[b] = {
      ...bands[b],
      elements: bands[b].elements.map((el) => {
        if (!seen.has(el.id)) { seen.add(el.id); return el; }
        const id = newElementId(el.type.slice(0, 3));
        seen.add(id);
        return { ...el, id };
      }),
    };
  });
  return { ...config, bands };
}

function prepareDraft(t) {
  const c = clone(t);
  let converted = false;
  if (c.config?.schema !== 2) {
    c.config = convertLegacyTemplate(c, pageGeometry(c).contentW);
    converted = true;
  }
  c.config = dedupeIds(normalizeConfig(c.config));
  c.margins = { top: 10, right: 10, bottom: 10, left: 10, ...(c.margins || {}) };
  return { draft: c, converted };
}

// Layout cache key: everything except element positions (dragging doesn't re-measure).
function measureKey(t, modelKey, designRows) {
  const cfg = t.config;
  const strip = (els) => els.map(({ x, y, ...rest }) => rest);
  return JSON.stringify([t.paper_size, t.orientation, t.custom_width_mm, t.custom_height_mm, t.margins, cfg.theme, cfg.format, cfg.page,
    cfg.bands.items, BANDS.map((b) => [cfg.bands[b].height, strip(cfg.bands[b].elements)]), modelKey, designRows]);
}

export default function BillDesigner({ open, template, settings = {}, canDesign = true, onClose, onSaved, onSaveTheme }) {
  const [draft, setDraftState] = useState(null);
  const draftRef = useRef(null);
  const [savedJson, setSavedJson] = useState('');
  const [converted, setConverted] = useState(false);
  const past = useRef([]);
  const future = useRef([]);
  const lastPush = useRef({ key: null, t: 0 });
  const [, forceHistory] = useState(0);
  const [selection, setSelection] = useState([]);
  const [leftTab, setLeftTab] = useState('elements');
  const [zoom, setZoom] = useState(1);
  const [showGrid, setShowGrid] = useState(false);
  const [snap, setSnap] = useState(true);
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState('');
  const [dialog, setDialog] = useState(null); // 'saveas' | 'rename' | 'versions' | 'preview' | 'keys'
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [addAnchor, setAddAnchor] = useState(null);
  const [alignAnchor, setAlignAnchor] = useState(null);
  const [ctx, setCtx] = useState(null);
  const [preview, setPreview] = useState({ mode: 'sample', docType: 'SALES_INVOICE', itemCount: 3, longNames: false, doc: null });
  const [fullInfo, setFullInfo] = useState(null);
  const canvasBoxRef = useRef(null);
  const textInputRef = useRef(null);
  const clipboard = useRef([]);
  const readOnly = !canDesign;

  const setDraft = (next) => { draftRef.current = next; setDraftState(next); };
  const dirty = !!draft && JSON.stringify(draft) !== savedJson;

  // ---- loading -------------------------------------------------------------------
  const loadTemplate = useCallback((t, { keepPreview = false } = {}) => {
    const { draft: d, converted: conv } = prepareDraft(t);
    setDraft(d);
    // A converted classic layout counts as unsaved until it is saved in the new format.
    setSavedJson(conv ? '' : JSON.stringify(d));
    setConverted(conv);
    past.current = [];
    future.current = [];
    setSelection([]);
    setConflict('');
    if (!keepPreview) {
      const compat = compatibleDocTypes(d.config);
      const first = (t.used_by || []).map(canonicalDocType).find((x) => compat.includes(x)) || compat[0] || 'SALES_INVOICE';
      setPreview((p) => ({ ...p, docType: first, doc: null, mode: 'sample' }));
    }
  }, []);

  useEffect(() => {
    if (open && template) loadTemplate(template);
    if (!open) { setDraft(null); setSavedJson(''); }
  }, [open, template, loadTemplate]);

  useEffect(() => {
    if (!open) return;
    loadBillingContext({ force: true }).then(setCtx).catch(() => setCtx({}));
  }, [open]);

  useEffect(() => {
    const h = (e) => { if (dirty && open) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty, open]);

  // ---- history -------------------------------------------------------------------
  const commit = useCallback((updater, coalesceKey) => {
    const prev = draftRef.current;
    if (!prev || readOnly) return;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next === prev) return;
    const now = Date.now();
    const coalesce = coalesceKey && lastPush.current.key === coalesceKey && now - lastPush.current.t < 900;
    if (!coalesce) {
      past.current.push(prev);
      if (past.current.length > 200) past.current.shift();
    }
    lastPush.current = { key: coalesceKey || null, t: now };
    future.current = [];
    setDraft(next);
    forceHistory((n) => n + 1);
  }, [readOnly]);
  const commitConfig = useCallback((fn, key) => commit((t) => ({ ...t, config: fn(t.config) }), key), [commit]);
  const liveChange = useCallback((updater) => { if (!readOnly) setDraft(updater(draftRef.current)); }, [readOnly]);
  const commitDrag = useCallback((before) => {
    past.current.push(before);
    future.current = [];
    lastPush.current = { key: null, t: 0 };
    forceHistory((n) => n + 1);
  }, []);
  const undo = () => {
    if (!past.current.length) return;
    future.current.push(draftRef.current);
    setDraft(past.current.pop());
    forceHistory((n) => n + 1);
  };
  const redo = () => {
    if (!future.current.length) return;
    past.current.push(draftRef.current);
    setDraft(future.current.pop());
    forceHistory((n) => n + 1);
  };

  // ---- data for the canvas -------------------------------------------------------------
  const company = useMemo(() => resolveCompany({ company: ctx?.company, branding: settings }), [ctx, settings]);
  const model = useMemo(() => {
    if (preview.mode === 'real' && preview.doc) {
      return toBillModel(preview.doc.doc, preview.docType, { company: ctx?.company, branding: settings, user: ctx?.user });
    }
    return sampleBillModel(preview.docType, { company, itemCount: preview.itemCount, longNames: preview.longNames });
  }, [preview, company, ctx, settings]);
  const modelKey = preview.mode === 'real' && preview.doc ? `real:${preview.doc.id}` : `sample:${preview.docType}:${preview.itemCount}:${preview.longNames}:${JSON.stringify(company)}`;

  // Design view: page 1 with as many sample rows (≤3) as let every section fit on it.
  const layoutCache = useRef({ key: '', value: null });
  const design = useMemo(() => {
    if (!draft) return null;
    const n = Math.min(3, model.items.length);
    for (let rows = n; rows >= 0; rows -= 1) {
      const key = measureKey(draft, modelKey, rows);
      let lay = layoutCache.current.key === key ? layoutCache.current.value : null;
      if (!lay) {
        lay = layoutBill(draft, model, { designRows: rows, editor: true, branding: settings });
        layoutCache.current = { key, value: lay };
      }
      if (lay.pages.length === 1 || rows === 0) return lay;
    }
    return null;
  }, [draft, model, modelKey, settings]);

  const rendered = useMemo(() => {
    if (!draft || !design) return { html: '', css: '' };
    const out = renderBillPages(draft, model, design, { editor: true });
    return { html: out.pages[0] || '', css: out.css };
  }, [draft, model, design]);

  const bandRects = useMemo(() => {
    if (!design || !draft) return {};
    const p = design.pages[0];
    const b = draft.config.bands;
    const out = { footer: { top: p.footerTop, height: b.footer.height } };
    if (p.showHeader) out.header = { top: 0, height: b.header.height };
    if (p.table && design.itemsOn) {
      const rowsH = design.measured.rows.slice(p.table.start, p.table.end).reduce((s, h) => s + h, 0);
      out.items = { top: p.table.top, height: design.measured.thead + rowsH + (p.table.filler || 0) + (design.truncatedRows > 0 ? 6 : 0) };
    }
    if (p.summaryTop !== null && p.summaryTop !== undefined) out.summary = { top: p.summaryTop, height: b.summary.height };
    return out;
  }, [design, draft]);

  // Full document (all rows) — page count + warnings, debounced.
  useEffect(() => {
    if (!draft || !open) return undefined;
    const t = setTimeout(() => {
      try {
        const lay = layoutBill(draft, model, { branding: settings });
        setFullInfo({ pages: lay.pages.length, warnings: lay.warnings, height: lay.geometry.pageH });
      } catch (e) {
        setFullInfo(null);
      }
    }, 350);
    return () => clearTimeout(t);
  }, [draft, model, settings, open]);

  const warnings = useMemo(() => {
    const list = [...(design?.warnings || [])];
    (fullInfo?.warnings || []).forEach((w) => { if (!list.some((x) => x.message === w.message)) list.push(w); });
    return list;
  }, [design, fullInfo]);
  const problemIds = useMemo(() => new Set(warnings.filter((w) => w.level !== 'info' && w.elementId).map((w) => w.elementId)), [warnings]);

  const geometry = draft ? (design?.geometry || pageGeometry(draft)) : null;
  const compatible = draft ? compatibleDocTypes(draft.config) : [];
  const assignedTo = (template?.used_by || []).map(canonicalDocType);

  // Keep the preview document type something this layout can print.
  useEffect(() => {
    if (compatible.length && !compatible.includes(preview.docType)) setPreview((p) => ({ ...p, docType: compatible[0], doc: null }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compatible.join(',')]);

  // ---- zoom ------------------------------------------------------------------------
  const fitZoom = useCallback((mode = 'width') => {
    const box = canvasBoxRef.current;
    const t = draftRef.current;
    if (!box || !t) return;
    const g = pageGeometry(t);
    const zw = (box.clientWidth - 96) / (g.pageW * PX_PER_MM);
    const zh = (box.clientHeight - 48) / ((g.pageH || g.pageW * 2) * PX_PER_MM);
    const z = mode === 'page' ? Math.min(zw, zh) : zw;
    setZoom(Math.max(0.3, Math.min(3, Math.round(z * 100) / 100)));
  }, []);
  useEffect(() => {
    if (!open) return undefined;
    const t = setTimeout(() => fitZoom(draftRef.current && pageGeometry(draftRef.current).thermal ? 'page' : 'width'), 60);
    return () => clearTimeout(t);
  }, [open, draft?.id, draft?.paper_size, draft?.orientation, fitZoom]);

  // ---- element operations -------------------------------------------------------------
  const setBandElements = (band, fn, key) => commitConfig((c) => ({ ...c, bands: { ...c.bands, [band]: { ...c.bands[band], elements: fn(c.bands[band].elements) } } }), key);
  const mapAll = (fn, key) => commitConfig((c) => {
    const bands = { ...c.bands };
    BANDS.forEach((b) => { bands[b] = { ...bands[b], elements: fn(bands[b].elements, b) }; });
    return { ...c, bands };
  }, key);

  const targetBandFor = (payload) => {
    const sel = selection.length === 1 && selection[0] !== ITEMS_ID ? findElement(draftRef.current.config, selection[0]) : null;
    if (sel) return sel.band;
    if (payload.kind === 'field') return payload.field.startsWith('totals.') || payload.field.startsWith('payment.') || payload.field.startsWith('receipt.') ? 'summary' : 'header';
    const lib = ELEMENT_LIBRARY.find((e) => e.type === payload.type);
    if (payload.type === 'pageNumber' || payload.preset?.text === 'Thank you for your business!') return 'footer';
    return DEFAULT_BAND_FOR_GROUP[lib?.group] || 'summary';
  };

  const buildElement = (payload) => {
    if (payload.kind === 'field') {
      const def = FIELD_BY_ID[payload.field];
      const multiline = def?.kind === 'multiline';
      const isMoney = def?.kind === 'money';
      return createElement('field', {
        w: multiline ? 80 : 60, h: multiline ? 14 : 6,
        preset: {
          field: payload.field, label: payload.label, labelPosition: multiline ? 'top' : 'left', labelWidth: multiline ? 0 : 26,
          labelStyle: { color: '#64748b' }, style: isMoney ? { align: 'right' } : {},
        },
      });
    }
    return createElement(payload.type, { preset: payload.preset || {}, w: payload.w, h: payload.h });
  };

  const addElement = (payload, band, x, y) => {
    if (readOnly) return;
    const t = draftRef.current;
    const g = pageGeometry(t);
    const b = band || targetBandFor(payload);
    const el = buildElement(payload);
    el.w = Math.min(el.w, g.contentW);
    if (x !== undefined) {
      el.x = r2(Math.max(0, Math.min(g.contentW - el.w, x - el.w / 2)));
      el.y = r2(Math.max(0, y - el.h / 2));
    } else {
      // Click-to-add: below the section's existing content.
      const bottom = t.config.bands[b].elements.reduce((m, e) => Math.max(m, e.y + e.h), 0);
      el.x = 0;
      el.y = r2(bottom + (bottom ? 1 : 0));
    }
    commitConfig((c) => {
      const bandObj = c.bands[b];
      const height = Math.max(bandObj.height, r2(el.y + el.h + 1));
      return { ...c, bands: { ...c.bands, [b]: { ...bandObj, height, elements: [...bandObj.elements, el] } } };
    });
    setSelection([el.id]);
  };

  const updateElement = (id, patch, key) => mapAll((els) => els.map((e) => (e.id === id ? { ...e, ...patch } : e)), key ? `${id}:${key}` : null);
  const updateStyle = (id, patch, key) => mapAll((els) => els.map((e) => (e.id === id ? { ...e, style: Object.fromEntries(Object.entries({ ...(e.style || {}), ...patch }).filter(([, v]) => v !== undefined)) } : e)), key ? `${id}:style:${Object.keys(patch).join()}` : `${id}:style:${Object.keys(patch).join()}`);

  const selectedEls = () => BANDS.flatMap((b) => draftRef.current.config.bands[b].elements.filter((e) => selection.includes(e.id)));

  const deleteSelected = () => {
    if (readOnly || !selection.length) return;
    if (selection.includes(ITEMS_ID)) {
      if (!window.confirm('Hide the items table? Line items will not print with this template (they can be shown again from the table properties).')) return;
      commitConfig((c) => ({ ...c, bands: { ...c.bands, items: { ...c.bands.items, visible: false } } }));
      setSelection([]);
      return;
    }
    const prot = selectedEls().filter((e) => e.protected);
    if (prot.length && !window.confirm(`“${elementTitle(prot[0])}” is a core part of the document. Delete it anyway?`)) return;
    mapAll((els) => els.filter((e) => !selection.includes(e.id)));
    setSelection([]);
  };

  const duplicateSelected = () => {
    if (readOnly) return;
    const ids = [];
    mapAll((els) => {
      const copies = els.filter((e) => selection.includes(e.id)).map((e) => {
        const c = { ...clone(e), id: newElementId(e.type.slice(0, 3)), x: r2(e.x + 2), y: r2(e.y + 2), locked: undefined, protected: undefined };
        ids.push(c.id);
        return c;
      });
      return [...els, ...copies];
    });
    if (ids.length) setSelection(ids);
  };

  const copySelected = () => { clipboard.current = selectedEls().map((e) => ({ el: clone(e), band: findElement(draftRef.current.config, e.id)?.band })); };
  const paste = () => {
    if (readOnly || !clipboard.current.length) return;
    const ids = [];
    commitConfig((c) => {
      const bands = { ...c.bands };
      clipboard.current.forEach(({ el, band }) => {
        const copy = { ...clone(el), id: newElementId(el.type.slice(0, 3)), x: r2(el.x + 3), y: r2(el.y + 3), locked: undefined, protected: undefined };
        ids.push(copy.id);
        const b = bands[band] ? band : 'summary';
        bands[b] = { ...bands[b], elements: [...bands[b].elements, copy] };
      });
      return { ...c, bands };
    });
    setSelection(ids);
  };

  const reorder = (ids, dir) => mapAll((els) => {
    if (!els.some((e) => ids.includes(e.id))) return els;
    const sel = els.filter((e) => ids.includes(e.id));
    const rest = els.filter((e) => !ids.includes(e.id));
    if (dir === 'front') return [...rest, ...sel];
    if (dir === 'back') return [...sel, ...rest];
    const arr = [...els];
    const idxs = arr.map((e, i) => (ids.includes(e.id) ? i : -1)).filter((i) => i >= 0);
    if (dir === 'up') {
      for (let i = idxs.length - 1; i >= 0; i -= 1) { const j = idxs[i]; if (j < arr.length - 1 && !ids.includes(arr[j + 1].id)) [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]]; }
    } else {
      idxs.forEach((j) => { if (j > 0 && !ids.includes(arr[j - 1].id)) [arr[j], arr[j - 1]] = [arr[j - 1], arr[j]]; });
    }
    return arr;
  });

  const align = (mode) => {
    setAlignAnchor(null);
    const W = pageGeometry(draftRef.current).contentW;
    if (mode === 'dist-x' || mode === 'dist-y') mapAll((els) => distributeElements(els, selection, mode === 'dist-x' ? 'x' : 'y'));
    else mapAll((els) => alignElements(els, selection, mode, W));
  };

  const toggleLock = () => {
    const els = selectedEls();
    const lock = !els.every((e) => e.locked);
    mapAll((all) => all.map((e) => (selection.includes(e.id) ? { ...e, locked: lock || undefined } : e)));
  };

  // Move element(s) between sections, keeping their position on the page.
  const moveToBand = (ids, from, to) => {
    if (readOnly || from === to) return;
    const top = (b) => bandRects[b]?.top ?? 0;
    commitConfig((c) => {
      const moving = c.bands[from].elements.filter((e) => ids.includes(e.id));
      if (!moving.length) return c;
      const delta = top(from) - top(to);
      const moved = moving.map((e) => ({ ...e, y: r2(Math.max(0, e.y + delta)) }));
      const toBand = c.bands[to];
      const height = Math.max(toBand.height, ...moved.map((e) => r2(e.y + e.h)));
      return {
        ...c,
        bands: {
          ...c.bands,
          [from]: { ...c.bands[from], elements: c.bands[from].elements.filter((e) => !ids.includes(e.id)) },
          [to]: { ...toBand, height, elements: [...toBand.elements, ...moved] },
        },
      };
    });
  };

  const insertToken = (fieldId) => {
    const sel = selection.length === 1 ? findElement(draftRef.current.config, selection[0]) : null;
    if (!sel || sel.el.type !== 'text') return;
    const input = textInputRef.current;
    const text = sel.el.text || '';
    const pos = input && typeof input.selectionStart === 'number' ? input.selectionStart : text.length;
    const token = `{{${fieldId}}}`;
    updateElement(sel.el.id, { text: text.slice(0, pos) + token + text.slice(pos) });
  };

  // ---- keyboard -------------------------------------------------------------------------
  const keyHandler = useRef(null);
  keyHandler.current = (e) => {
    if (!open || !draftRef.current || dialog || isTyping(document.activeElement)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (ctrl && k === 's') { e.preventDefault(); handleSave(); return; }
    if (ctrl && k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (ctrl && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (ctrl && k === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (ctrl && k === 'c') { copySelected(); return; }
    if (ctrl && k === 'v') { e.preventDefault(); paste(); return; }
    if (ctrl && k === 'a') { e.preventDefault(); setSelection(BANDS.flatMap((b) => draftRef.current.config.bands[b].elements.filter((x) => !x.hidden).map((x) => x.id))); return; }
    if (k === '?' ) { setDialog('keys'); return; }
    if (e.key === 'Escape') { setSelection([]); return; }
    if (!selection.length) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    const step = e.shiftKey ? 2 : e.altKey ? 0.1 : 0.5;
    const d = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] }[k];
    if (d && !selection.includes(ITEMS_ID)) {
      e.preventDefault();
      mapAll((els) => els.map((x) => (selection.includes(x.id) && !x.locked ? { ...x, x: r2(x.x + d[0]), y: r2(x.y + d[1]) } : x)), 'nudge');
    }
  };
  useEffect(() => {
    const h = (e) => keyHandler.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ---- persistence -----------------------------------------------------------------------
  const guard = async (fn, success) => {
    setBusy(true);
    try {
      const out = await fn();
      if (success) notify(success, 'success');
      invalidateBillingContext();
      return out;
    } catch (err) {
      if (err?.response?.status === 409) setConflict(apiError(err));
      else notify(apiError(err, 'Could not save the template.'), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  async function handleSave() {
    const t = draftRef.current;
    if (!t || readOnly || busy) return;
    if (!t.id) { setDialog('saveas'); return; }
    if (!dirty) { notify('No changes to save.', 'info'); return; }
    const blocking = warnings.filter((w) => w.level === 'error');
    if (blocking.length && !window.confirm(`${blocking[0].message}\n\nSave anyway?`)) return;
    const saved = await guard(() => updateTemplate(t.id, { ...payloadOf(t), expected_version: t.version }), `“${t.name}” saved (version ${t.version + 1}).`);
    if (saved) { loadTemplate(saved, { keepPreview: true }); onSaved?.(saved); }
  }

  const handleSaveAs = async (name) => {
    setDialog(null);
    const t = draftRef.current;
    const saved = await guard(() => createTemplate({ ...payloadOf(t), name, template_type: 'CUSTOM', is_active: true }), `Saved as new template “${name}”.`);
    if (saved) { loadTemplate(saved, { keepPreview: true }); onSaved?.(saved); }
  };

  const handleRename = async (name) => {
    setDialog(null);
    const t = draftRef.current;
    if (!t.id) { commit((d) => ({ ...d, name })); return; }
    const saved = await guard(() => renameTemplate(t.id, name), 'Template renamed.');
    if (saved) {
      const next = { ...draftRef.current, name: saved.name };
      setDraft(next);
      if (savedJson) setSavedJson(JSON.stringify({ ...JSON.parse(savedJson), name: saved.name }));
      onSaved?.(saved);
    }
  };

  const handleRestoreDefault = async () => {
    setMenuAnchor(null);
    const t = draftRef.current;
    if (!window.confirm(`Reset “${t.name}” to its original starter layout? The current design is kept in Version history.`)) return;
    const saved = await guard(() => restoreTemplateDefault(t.id), 'Starter layout restored.');
    if (saved) { loadTemplate(saved, { keepPreview: true }); onSaved?.(saved); }
  };

  const handleRestoreVersion = async (version) => {
    setDialog(null);
    if (dirty && !window.confirm('Discard your unsaved changes and restore that version?')) return;
    const saved = await guard(() => restoreTemplateVersion(draftRef.current.id, version), `Version ${version} restored.`);
    if (saved) { loadTemplate(saved, { keepPreview: true }); onSaved?.(saved); }
  };

  const reloadFromServer = async () => {
    const fresh = await guard(() => fetchTemplate(draftRef.current.id));
    if (fresh) { loadTemplate(fresh, { keepPreview: true }); onSaved?.(fresh); }
  };

  const requestClose = () => {
    if (dirty && !readOnly && !window.confirm('You have unsaved changes to this template. Close without saving?')) return;
    onClose?.();
  };

  // ---- preview / print -----------------------------------------------------------------
  const printTest = () => {
    const { html } = renderVisualBillHtml(draftRef.current, model, { autoPrint: true, branding: settings });
    if (!openPrintWindow(html, draftRef.current)) notify('Pop-up blocked — allow pop-ups to print.', 'warning');
  };

  // ---- UI --------------------------------------------------------------------------------
  if (!open) return null;
  const sel1 = selection.length === 1 ? (selection[0] === ITEMS_ID ? null : findElement(draft?.config, selection[0])) : null;
  const multi = selection.filter((s) => s !== ITEMS_ID).length > 1;
  const selLocked = draft && selection.length && selectedEls().every((e) => e.locked);

  return (
    <Dialog open={open} onClose={requestClose} fullScreen PaperProps={{ sx: { bgcolor: '#f1f5f9' } }} disableEscapeKeyDown>
      {!draft ? <Box sx={{ p: 6, textAlign: 'center' }}><CircularProgress /></Box> : (
        <Box sx={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
          {/* Top bar */}
          <AppBar position="static" color="inherit" elevation={0} sx={{ borderBottom: '1px solid', borderColor: 'divider' }}>
            <Toolbar variant="dense" sx={{ gap: 1, flexWrap: 'wrap', py: 0.5 }}>
              <IconButton edge="start" onClick={requestClose} aria-label="Close designer" data-testid="designer-close"><Close /></IconButton>
              <Box sx={{ minWidth: 0 }}>
                <Typography variant="subtitle1" fontWeight={800} noWrap data-testid="designer-title">{draft.name || 'Untitled template'}</Typography>
                <Typography variant="caption" color="text.secondary">
                  {geometry.pageW} × {geometry.thermal ? 'roll' : geometry.pageH} mm{draft.version ? ` · v${draft.version}` : ''}{fullInfo ? ` · prints on ${fullInfo.pages} page${fullInfo.pages > 1 ? 's' : ''}${geometry.thermal && fullInfo.height ? ` (${Math.round(fullInfo.height)} mm)` : ''} with this data` : ''}
                </Typography>
              </Box>
              {dirty && !readOnly && <Chip size="small" color="warning" label="Unsaved changes" data-testid="dirty-chip" />}
              {draft.is_default && <Chip size="small" color="primary" label="Default" />}
              <Box sx={{ flex: 1 }} />
              <Button size="small" variant="outlined" startIcon={<Visibility />} onClick={() => setDialog('preview')} data-testid="open-preview">Preview</Button>
              <Button size="small" variant="outlined" startIcon={<Print />} onClick={printTest} data-testid="print-test">Print test</Button>
              <Button size="small" variant="outlined" startIcon={<SaveAs />} onClick={() => setDialog('saveas')} disabled={readOnly || busy}>Save as new</Button>
              <Button size="small" variant="contained" startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <Save />} onClick={handleSave}
                disabled={readOnly || busy || (!!draft.id && !dirty)} data-testid="designer-save">
                Save
              </Button>
              <IconButton size="small" onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label="More template actions"><MoreVert /></IconButton>
            </Toolbar>
          </AppBar>

          {readOnly && <Alert severity="info" sx={{ borderRadius: 0 }}>View only — sign in as a Super Admin, Administrator or Manager to change bill templates. You can still preview and test-print.</Alert>}
          {converted && <Alert severity="info" sx={{ borderRadius: 0 }}>This template used the classic section layout. It has been converted to the visual layout — check it, then Save to keep the visual version (the classic version stays in Version history).</Alert>}
          {conflict && (
            <Alert severity="warning" sx={{ borderRadius: 0 }} action={<Stack direction="row" spacing={1}><Button size="small" onClick={reloadFromServer}>Reload theirs</Button><Button size="small" onClick={() => { setConflict(''); setDialog('saveas'); }}>Save mine as new</Button></Stack>}>
              {conflict}
            </Alert>
          )}

          <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', md: '250px minmax(0,1fr) 340px' } }}>
            {/* Left */}
            <Paper square variant="outlined" sx={{ p: 1.25, overflowY: 'auto', borderTop: 0 }}>
              <BillPalette
                tab={leftTab} onTab={setLeftTab} readOnly={readOnly}
                onAdd={(p) => addElement(p)} onInsertToken={insertToken}
                textSelected={sel1?.el.type === 'text'}
                targetDocTypes={compatible.length ? compatible : undefined}
                config={draft.config} selection={selection} onSelect={setSelection}
                onElementPatch={(id, patch) => updateElement(id, patch)} onReorder={reorder}
              />
            </Paper>

            {/* Centre */}
            <Box sx={{ display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
              <Paper square variant="outlined" sx={{ px: 1, py: 0.5, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.25, borderTop: 0 }}>
                <Tooltip title="Undo (Ctrl+Z)"><span><IconButton size="small" onClick={undo} disabled={!past.current.length} data-testid="undo"><Undo fontSize="small" /></IconButton></span></Tooltip>
                <Tooltip title="Redo (Ctrl+Y)"><span><IconButton size="small" onClick={redo} disabled={!future.current.length} data-testid="redo"><Redo fontSize="small" /></IconButton></span></Tooltip>
                <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                <Tooltip title="Zoom out"><IconButton size="small" onClick={() => setZoom((z) => Math.max(0.3, r2(z / 1.2)))}><ZoomOut fontSize="small" /></IconButton></Tooltip>
                <Typography variant="caption" sx={{ minWidth: 40, textAlign: 'center' }}>{Math.round(zoom * 100)}%</Typography>
                <Tooltip title="Zoom in"><IconButton size="small" onClick={() => setZoom((z) => Math.min(3, r2(z * 1.2)))}><ZoomIn fontSize="small" /></IconButton></Tooltip>
                <Tooltip title="Fit width"><IconButton size="small" onClick={() => fitZoom('width')}><FitScreen fontSize="small" /></IconButton></Tooltip>
                <Tooltip title="Fit whole page"><IconButton size="small" onClick={() => fitZoom('page')}><Fullscreen fontSize="small" /></IconButton></Tooltip>
                <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                <Tooltip title="Grid (10 mm, 1 mm when zoomed in)"><ToggleButton size="small" value="grid" selected={showGrid} onChange={() => setShowGrid((v) => !v)} sx={{ p: 0.5 }}><GridOn fontSize="small" /></ToggleButton></Tooltip>
                <Tooltip title="Snap to grid & alignment guides (hold Alt for fine moves)"><ToggleButton size="small" value="snap" selected={snap} onChange={() => setSnap((v) => !v)} sx={{ p: 0.5, ml: 0.5 }}><Straighten fontSize="small" /></ToggleButton></Tooltip>
                <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
                <Button size="small" startIcon={<Add />} onClick={(e) => setAddAnchor(e.currentTarget)} disabled={readOnly} data-testid="add-element">Add element</Button>
                <Tooltip title="Duplicate (Ctrl+D)"><span><IconButton size="small" onClick={duplicateSelected} disabled={readOnly || !selection.filter((s) => s !== ITEMS_ID).length}><ContentCopy fontSize="small" /></IconButton></span></Tooltip>
                <Tooltip title="Bring to front"><span><IconButton size="small" onClick={() => reorder(selection, 'front')} disabled={readOnly || !selection.length}><FlipToFront fontSize="small" /></IconButton></span></Tooltip>
                <Tooltip title="Send to back"><span><IconButton size="small" onClick={() => reorder(selection, 'back')} disabled={readOnly || !selection.length}><FlipToBack fontSize="small" /></IconButton></span></Tooltip>
                <Tooltip title="Align / distribute"><span><IconButton size="small" onClick={(e) => setAlignAnchor(e.currentTarget)} disabled={readOnly || !selection.filter((s) => s !== ITEMS_ID).length}><AlignHorizontalLeft fontSize="small" /></IconButton></span></Tooltip>
                <Tooltip title={selLocked ? 'Unlock' : 'Lock position'}><span><IconButton size="small" onClick={toggleLock} disabled={readOnly || !selection.filter((s) => s !== ITEMS_ID).length}>{selLocked ? <LockOpen fontSize="small" /> : <Lock fontSize="small" />}</IconButton></span></Tooltip>
                <Tooltip title="Delete (Del)"><span><IconButton size="small" onClick={deleteSelected} disabled={readOnly || !selection.length} data-testid="delete-selected"><DeleteOutline fontSize="small" /></IconButton></span></Tooltip>
                <Tooltip title="Items table"><IconButton size="small" onClick={() => setSelection([ITEMS_ID])}><ViewColumn fontSize="small" /></IconButton></Tooltip>
                <Box sx={{ flex: 1 }} />
                <Tooltip title="Keyboard shortcuts (?)"><IconButton size="small" onClick={() => setDialog('keys')}><Keyboard fontSize="small" /></IconButton></Tooltip>
              </Paper>
              <Paper square variant="outlined" sx={{ px: 1, py: 0.75, borderTop: 0 }}>
                <PreviewSource value={preview} onChange={setPreview} docTypes={compatible.length ? compatible : ['SALES_INVOICE']} />
              </Paper>

              <Box ref={canvasBoxRef} sx={{ flex: 1, minHeight: 0, overflow: 'auto', p: 3, pl: 9, bgcolor: '#e2e8f0' }}>
                {design && geometry && (
                  <Box sx={{ display: 'flex', justifyContent: 'center', minWidth: 'fit-content' }}>
                    <BillCanvas
                      template={draft} pageHtml={rendered.html} css={rendered.css} geometry={geometry} bandRects={bandRects}
                      zoom={zoom} showGrid={showGrid} snap={snap} selection={selection}
                      onSelect={(ids) => setSelection(ids)} onLiveChange={liveChange} onCommitChange={commitDrag}
                      onDropNew={(payload, band, x, y) => addElement(payload, band, x, y)}
                      problemIds={problemIds} onMoveToBand={moveToBand}
                    />
                  </Box>
                )}
              </Box>

              <Paper square variant="outlined" sx={{ maxHeight: 130, overflowY: 'auto', px: 1, py: 0.5 }} data-testid="designer-warnings">
                {!warnings.length ? (
                  <Typography variant="caption" color="success.main">✓ No layout problems with this data.{design?.truncatedRows > 0 ? ` The canvas shows the first rows; Preview shows all ${model.items.length}.` : ''}</Typography>
                ) : warnings.map((w, i) => (
                  <Stack key={i} direction="row" spacing={1} alignItems="center" onClick={() => w.elementId && setSelection([w.elementId])}
                    sx={{ py: 0.2, cursor: w.elementId ? 'pointer' : 'default', '&:hover': { bgcolor: 'action.hover' } }}>
                    {LEVEL_ICON[w.level]}
                    <Typography variant="caption">{w.message}</Typography>
                  </Stack>
                ))}
              </Paper>
            </Box>

            {/* Right */}
            <Paper square variant="outlined" sx={{ p: 1.5, overflowY: 'auto', borderTop: 0 }} data-testid="properties-panel">
              {selection.includes(ITEMS_ID) ? (
                <ItemsTableEditor
                  items={draft.config.bands.items} readOnly={readOnly} docTypes={compatible}
                  onItems={(patch, key) => commitConfig((c) => ({ ...c, bands: { ...c.bands, items: { ...c.bands.items, ...patch } } }), key ? `items:${key}` : undefined)}
                  onTable={(patch, key) => commitConfig((c) => ({ ...c, bands: { ...c.bands, items: { ...c.bands.items, table: { ...c.bands.items.table, ...patch } } } }), key ? `table:${key}` : undefined)}
                />
              ) : sel1 ? (
                <ElementProperties
                  key={sel1.el.id} el={sel1.el} band={sel1.band} readOnly={readOnly} docTypes={compatible}
                  onPatch={(patch, key) => updateElement(sel1.el.id, patch, key)}
                  onStyle={(patch) => updateStyle(sel1.el.id, patch)}
                  onDelete={deleteSelected} textInputRef={textInputRef}
                  onMoveToBand={(to) => moveToBand([sel1.el.id], sel1.band, to)}
                />
              ) : multi ? (
                <Box>
                  <Typography variant="subtitle2" fontWeight={800}>{selection.length} elements selected</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ my: 1 }}>Drag to move them together, use the arrow keys to nudge, or align them from the toolbar.</Typography>
                  <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
                    {[['left', 'Left'], ['hcenter', 'Centre'], ['right', 'Right'], ['top', 'Top'], ['vcenter', 'Middle'], ['bottom', 'Bottom'], ['dist-x', 'Distribute ↔'], ['dist-y', 'Distribute ↕']].map(([m, l]) => (
                      <Button key={m} size="small" variant="outlined" disabled={readOnly} onClick={() => align(m)}>{l}</Button>
                    ))}
                  </Stack>
                </Box>
              ) : (
                <PageSettings
                  draft={draft} geometry={geometry} readOnly={readOnly} branding={settings}
                  compatible={compatible} assignedTo={assignedTo}
                  savedThemes={settings.themes || []}
                  onSaveTheme={(theme) => onSaveTheme?.(theme)}
                  onTemplate={(fn, key) => commit(fn, key)}
                  onConfig={(fn, key) => commitConfig(fn, key)}
                />
              )}
            </Paper>
          </Box>

          {/* Menus */}
          <Menu anchorEl={addAnchor} open={!!addAnchor} onClose={() => setAddAnchor(null)} PaperProps={{ sx: { maxHeight: 480 } }}>
            {Object.entries(ELEMENT_LIBRARY.reduce((a, it) => { (a[it.group] = a[it.group] || []).push(it); return a; }, {})).flatMap(([group, list]) => [
              <ListSubheader key={`h-${group}`} sx={{ lineHeight: 2.2 }}>{group}</ListSubheader>,
              ...list.map((it) => (
                <MenuItem key={`${group}-${it.label}`} dense onClick={() => { setAddAnchor(null); addElement({ kind: 'library', type: it.type, preset: it.preset || {}, w: it.w, h: it.h }); }}>
                  {it.label}
                </MenuItem>
              )),
            ])}
          </Menu>
          <Menu anchorEl={alignAnchor} open={!!alignAnchor} onClose={() => setAlignAnchor(null)}>
            {[['left', 'Align left', <AlignHorizontalLeft fontSize="small" />], ['hcenter', 'Centre horizontally', <FormatAlignCenter fontSize="small" />], ['right', 'Align right', <AlignHorizontalRight fontSize="small" />],
              ['top', 'Align top', <AlignVerticalTop fontSize="small" />], ['vcenter', 'Centre vertically', <AlignVerticalCenter fontSize="small" />], ['bottom', 'Align bottom', <AlignVerticalBottom fontSize="small" />],
              ['fullwidth', 'Full printable width', <ViewColumn fontSize="small" />], ['dist-x', 'Distribute horizontally', null], ['dist-y', 'Distribute vertically', null]].map(([m, l, icon]) => (
                <MenuItem key={m} dense onClick={() => align(m)}><ListItemIcon>{icon}</ListItemIcon><ListItemText>{l}</ListItemText></MenuItem>
            ))}
          </Menu>
          <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
            <MenuItem onClick={() => { setMenuAnchor(null); setDialog('rename'); }} disabled={readOnly}><ListItemIcon><DriveFileRenameOutline fontSize="small" /></ListItemIcon><ListItemText>Rename</ListItemText></MenuItem>
            <MenuItem onClick={() => { setMenuAnchor(null); setDialog('versions'); }} disabled={!draft.id}><ListItemIcon><History fontSize="small" /></ListItemIcon><ListItemText>Version history</ListItemText></MenuItem>
            <MenuItem onClick={handleRestoreDefault} disabled={readOnly || !draft.preset_key}><ListItemIcon><RestartAlt fontSize="small" /></ListItemIcon><ListItemText>Restore starter layout</ListItemText></MenuItem>
            <MenuItem onClick={() => { setMenuAnchor(null); if (savedJson && window.confirm('Discard all unsaved changes?')) { commit(JSON.parse(savedJson)); setSelection([]); } }} disabled={!dirty || !savedJson}><ListItemIcon><Undo fontSize="small" /></ListItemIcon><ListItemText>Discard unsaved changes</ListItemText></MenuItem>
          </Menu>

          <NamePrompt open={dialog === 'saveas'} title="Save as a new template" initial={draft.name ? `${draft.name}${draft.id ? ' (Copy)' : ''}` : ''} confirmLabel="Save" onClose={() => setDialog(null)} onConfirm={handleSaveAs} />
          <NamePrompt open={dialog === 'rename'} title="Rename template" initial={draft.name} confirmLabel="Rename" onClose={() => setDialog(null)} onConfirm={handleRename} />
          <VersionsDialog open={dialog === 'versions'} template={draft} onClose={() => setDialog(null)} onRestore={handleRestoreVersion} />
          <Dialog open={dialog === 'preview'} onClose={() => setDialog(null)} maxWidth="lg" fullWidth>
            <Stack direction="row" alignItems="center" sx={{ px: 2, py: 1, borderBottom: '1px solid', borderColor: 'divider' }} spacing={1}>
              <Typography fontWeight={800} sx={{ flex: 1 }}>Print preview — {draft.name}</Typography>
              <Chip size="small" color={model.isSample ? 'warning' : 'success'} label={model.isSample ? 'SAMPLE DATA' : `REAL: ${model.document.number}`} />
              <Button size="small" startIcon={<Print />} onClick={printTest}>Print</Button>
              <IconButton onClick={() => setDialog(null)}><Close /></IconButton>
            </Stack>
            <Box sx={{ bgcolor: '#e2e8f0', p: 3, maxHeight: '80vh', overflow: 'auto' }} data-testid="preview-dialog">
              {dialog === 'preview' && <BillPreview template={draft} model={model} maxWidth={900} />}
            </Box>
          </Dialog>
          <Dialog open={dialog === 'keys'} onClose={() => setDialog(null)} maxWidth="xs" fullWidth>
            <Box sx={{ p: 2 }}>
              <Typography fontWeight={800} sx={{ mb: 1 }}>Keyboard shortcuts</Typography>
              {[['Ctrl+S', 'Save'], ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+D', 'Duplicate'], ['Ctrl+C / Ctrl+V', 'Copy / paste'], ['Ctrl+A', 'Select all'], ['Del', 'Delete (asks for core sections)'], ['Arrows', 'Nudge 0.5 mm (Shift 2 mm, Alt 0.1 mm)'], ['Shift+click', 'Add to selection'], ['Esc', 'Deselect / page settings'], ['Alt while dragging', 'Fine positioning']].map(([k, v]) => (
                <Stack key={k} direction="row" justifyContent="space-between" sx={{ py: 0.3 }}><Typography variant="body2" sx={{ fontFamily: 'monospace' }}>{k}</Typography><Typography variant="body2" color="text.secondary">{v}</Typography></Stack>
              ))}
            </Box>
          </Dialog>
        </Box>
      )}
    </Dialog>
  );
}
