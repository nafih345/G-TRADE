// Settings → Barcode Labels → Designer. Three panels: elements & fields (left), the live
// label canvas (centre) and properties (right). Templates are saved in the database
// (apps/products LabelTemplate) with versioning; product values are never typed here —
// the canvas shows real Inventory data or sample scenarios through the same renderer the
// print job uses.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Box, Stack, Typography, Button, IconButton, Tooltip, TextField, MenuItem, Divider, Alert, Chip,
  Menu, ListItemIcon, ListItemText, ToggleButton, CircularProgress, Paper, ListSubheader,
} from '@mui/material';
import {
  Undo, Redo, ZoomIn, ZoomOut, FitScreen, GridOn, Straighten, ContentCopy, DeleteOutline,
  FlipToFront, FlipToBack, KeyboardArrowUp, KeyboardArrowDown, Save, SaveAs, MoreVert, Add,
  DriveFileRenameOutline, Star, RestartAlt, History, RestoreFromTrash, Visibility, Print,
  CenterFocusStrong, Replay, ErrorOutline, WarningAmber, InfoOutlined, Science,
} from '@mui/icons-material';
import DesignerCanvas, { PX_PER_MM } from './DesignerCanvas';
import ElementPalette from './ElementPalette';
import PropertiesPanel from './PropertiesPanel';
import PreviewDataPicker from './PreviewDataPicker';
import { NamePrompt, NewTemplateDialog, VersionsDialog, DeletedDialog } from './TemplateDialogs';
import {
  createElement, alignElements, scaleElements, fitElementsToLabel, autoLayout, blankTemplate,
  newElementId, r2,
} from '../../../labels/labelModel';
import { LABEL_FIELDS, SAMPLE_JOB, SAMPLE_SCENARIOS, SAMPLE_STORE } from '../../../labels/labelFields';
import { renderLabelHtml, labelCss, hasUsableLogo, summarizeWarnings } from '../../../labels/renderLabel';
import { openPrintWindow, buildPrintDocument, printCalibration, resolveCalibration } from '../../../labels/printLabels';
import {
  createTemplate, updateTemplate, renameTemplate, duplicateTemplate, deleteTemplate, setDefaultTemplate,
  restoreDefaultTemplate, restoreVersion, undeleteTemplate, createFromPreset, fetchLabelData, fetchTemplate, apiError,
} from '../../../labels/labelApi';
import { WORKFLOWS } from '../../../labels/useLabelBundle';
import { notify } from '../../../utils/notify';

const clone = (x) => JSON.parse(JSON.stringify(x));
const isTyping = (el) => el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable);
const LEVEL_ICON = { error: <ErrorOutline color="error" fontSize="small" />, warning: <WarningAmber color="warning" fontSize="small" />, info: <InfoOutlined color="info" fontSize="small" /> };

export default function LabelDesigner({ bundle, setBundle, reload, onPrintLabels }) {
  const templates = bundle?.templates || [];
  const canDesign = bundle?.fields ? !!bundle.fields.can_design : true;
  const allowedFields = useMemo(() => {
    const list = bundle?.fields?.fields;
    return new Set(list ? list.filter((f) => f.allowed).map((f) => f.id) : LABEL_FIELDS.filter((f) => !f.restricted).map((f) => f.id));
  }, [bundle]);

  const [currentId, setCurrentId] = useState(null);
  const [draft, setDraftState] = useState(null);
  const draftRef = useRef(null);
  const [savedJson, setSavedJson] = useState('');
  const past = useRef([]);
  const future = useRef([]);
  const lastPush = useRef({ key: null, t: 0 });
  const [, forceHistory] = useState(0);

  const [selection, setSelection] = useState([]);
  const [mode, setMode] = useState('advanced');
  const [zoom, setZoom] = useState(4);
  const [showGrid, setShowGrid] = useState(true);
  const [snap, setSnap] = useState(true);
  const [previewData, setPreviewData] = useState({ kind: 'sample', fields: SAMPLE_SCENARIOS[0].fields });
  const [store, setStore] = useState(SAMPLE_STORE);
  const [logo, setLogo] = useState('');
  const [busy, setBusy] = useState(false);
  const [conflict, setConflict] = useState('');
  const [dialog, setDialog] = useState(null); // 'new' | 'saveas' | 'rename' | 'versions' | 'deleted'
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [testAnchor, setTestAnchor] = useState(null);
  const canvasBoxRef = useRef(null);

  const setDraft = (next) => { draftRef.current = next; setDraftState(next); };
  const dirty = !!draft && JSON.stringify(draft) !== savedJson;

  // ---- loading -------------------------------------------------------------
  const loadTemplate = useCallback((t) => {
    const c = clone(t);
    setDraft(c);
    setSavedJson(JSON.stringify(c));
    past.current = [];
    future.current = [];
    setSelection([]);
    setConflict('');
    setCurrentId(t.id);
  }, []);

  useEffect(() => {
    if (!templates.length) return;
    const stillThere = currentId && templates.find((t) => t.id === currentId);
    if (!draft || (!stillThere && draft.id)) loadTemplate(templates.find((t) => t.is_default) || templates[0]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templates]);

  // Store name / phone / logo for sample previews.
  useEffect(() => {
    fetchLabelData([]).then((r) => {
      setStore({ store_name: r.store.store_name || SAMPLE_STORE.store_name, store_phone: r.store.store_phone || SAMPLE_STORE.store_phone });
      setLogo(r.logo || '');
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const h = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);

  // ---- history -------------------------------------------------------------
  const commit = useCallback((updater, coalesceKey) => {
    const prev = draftRef.current;
    if (!prev) return;
    const next = typeof updater === 'function' ? updater(prev) : updater;
    if (next === prev) return;
    const now = Date.now();
    const coalesce = coalesceKey && lastPush.current.key === coalesceKey && now - lastPush.current.t < 900;
    if (!coalesce) {
      past.current.push(prev);
      if (past.current.length > 150) past.current.shift();
    }
    lastPush.current = { key: coalesceKey || null, t: now };
    future.current = [];
    setDraft(next);
    forceHistory((n) => n + 1);
  }, []);

  const liveChange = useCallback((updater) => setDraft(updater(draftRef.current)), []);
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

  // ---- element operations --------------------------------------------------
  const setElements = (fn, key) => commit((t) => ({ ...t, layout: { ...t.layout, elements: fn(t.layout.elements) } }), key);

  const addElement = (payload, x, y) => {
    const t = draftRef.current;
    const el = createElement(payload.type, { field: payload.field, x: 1, y: 1, labelW: t.width_mm, labelH: t.height_mm });
    if (x !== undefined) {
      el.x = r2(Math.max(0, Math.min(t.width_mm - el.w, x - el.w / 2)));
      el.y = r2(Math.max(0, Math.min(t.height_mm - el.h, y - el.h / 2)));
    } else {
      // Click-to-add: stagger below existing content so it isn't hidden under it.
      const n = t.layout.elements.length;
      el.x = r2(Math.min(t.layout.paddingMm + (n % 4), Math.max(0, t.width_mm - el.w)));
      el.y = r2(Math.min(t.layout.paddingMm + (n % 6) * 1.5, Math.max(0, t.height_mm - el.h)));
    }
    setElements((els) => [...els, el]);
    setSelection([el.id]);
    setMode('advanced');
  };

  const updateElement = (id, patch, key) => setElements((els) => els.map((e) => (e.id === id ? { ...e, ...patch } : e)), key ? `${id}:${key}` : null);
  const deleteSelected = () => { if (!selection.length) return; setElements((els) => els.filter((e) => !selection.includes(e.id))); setSelection([]); };
  const duplicateSelected = () => {
    if (!selection.length) return;
    const copies = draftRef.current.layout.elements.filter((e) => selection.includes(e.id)).map((e) => ({ ...clone(e), id: newElementId(e.type.slice(0, 2)), x: r2(e.x + 1), y: r2(e.y + 1), locked: false }));
    setElements((els) => [...els, ...copies]);
    setSelection(copies.map((c) => c.id));
  };
  const reorder = (dir) => {
    if (!selection.length) return;
    setElements((els) => {
      const sel = els.filter((e) => selection.includes(e.id));
      const rest = els.filter((e) => !selection.includes(e.id));
      if (dir === 'front') return [...rest, ...sel];
      if (dir === 'back') return [...sel, ...rest];
      const arr = [...els];
      const idxs = arr.map((e, i) => (selection.includes(e.id) ? i : -1)).filter((i) => i >= 0);
      if (dir === 'up') {
        for (let i = idxs.length - 1; i >= 0; i -= 1) { const j = idxs[i]; if (j < arr.length - 1 && !selection.includes(arr[j + 1].id)) [arr[j], arr[j + 1]] = [arr[j + 1], arr[j]]; }
      } else {
        for (const j of idxs) { if (j > 0 && !selection.includes(arr[j - 1].id)) [arr[j], arr[j - 1]] = [arr[j - 1], arr[j]]; }
      }
      return arr;
    });
  };
  const align = (m) => setElements((els) => alignElements(els, selection, m, draftRef.current.width_mm, draftRef.current.height_mm));
  const fitToLabel = () => setElements((els) => fitElementsToLabel(els, draftRef.current.width_mm, draftRef.current.height_mm, draftRef.current.layout.paddingMm));
  const resizeLabel = (w, h, scale) => commit((t) => ({
    ...t, width_mm: w, height_mm: h,
    layout: { ...t.layout, elements: scale ? scaleElements(t.layout.elements, t.width_mm, t.height_mm, w, h) : t.layout.elements },
  }), 'label-size');
  const runAutoLayout = (fields, style) => {
    const t = draftRef.current;
    setElements(() => autoLayout({ W: t.width_mm, H: t.height_mm, fields, style, pad: t.layout.paddingMm || 1 }));
    setSelection([]);
  };
  // One-click fixes offered on barcode warnings (renderLabel barcodeFitHints).
  const applyFix = (elementId, fixId) => {
    const t = draftRef.current;
    const el = t.layout.elements.find((e) => e.id === elementId);
    if (!el) return;
    if (fixId === 'format128') {
      if (!el.barcode.format || el.barcode.format === 'inherit') commit((d) => ({ ...d, layout: { ...d.layout, defaultBarcodeFormat: 'CODE128' } }));
      else updateElement(el.id, { barcode: { ...el.barcode, format: 'CODE128' } });
    } else if (fixId === 'widen') {
      const pad = t.layout.paddingMm || 0;
      updateElement(el.id, { x: pad, w: r2(t.width_mm - 2 * pad), rotation: 0 });
    } else if (fixId === 'internal') {
      updateElement(el.id, { barcode: { ...el.barcode, whenTooLong: 'internal' } });
    }
    setSelection([el.id]);
  };

  const discardChanges = () => {
    const saved = JSON.parse(savedJson);
    commit(saved);
    setSelection([]);
  };

  // ---- keyboard ------------------------------------------------------------
  const keyHandler = useRef(null);
  keyHandler.current = (e) => {
    if (!draftRef.current || isTyping(document.activeElement) || dialog) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
    if (ctrl && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); return; }
    if (ctrl && e.key.toLowerCase() === 's') { e.preventDefault(); handleSave(); return; }
    if (ctrl && e.key.toLowerCase() === 'd') { e.preventDefault(); duplicateSelected(); return; }
    if (!selection.length) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if (e.key === 'Escape') { setSelection([]); return; }
    const step = e.shiftKey ? 2 : e.altKey ? 0.1 : 0.5;
    const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
    if (d) {
      e.preventDefault();
      setElements((els) => els.map((x) => (selection.includes(x.id) && !x.locked ? { ...x, x: r2(x.x + d[0]), y: r2(x.y + d[1]) } : x)), 'nudge');
    }
  };
  useEffect(() => {
    const h = (e) => keyHandler.current(e);
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  // ---- zoom ----------------------------------------------------------------
  const fitZoom = useCallback(() => {
    const box = canvasBoxRef.current;
    const t = draftRef.current;
    if (!box || !t) return;
    const z = Math.min((box.clientWidth - 56) / (t.width_mm * PX_PER_MM), 440 / (t.height_mm * PX_PER_MM));
    setZoom(Math.max(0.75, Math.min(12, r2(z))));
  }, []);
  useEffect(() => { fitZoom(); }, [draft?.id, draft?.width_mm, draft?.height_mm, fitZoom]);

  // ---- render ----------------------------------------------------------------
  const settings = bundle?.settings || {};
  const dpi = draft?.printer_type === 'a4' ? 0 : resolveCalibration(settings).dpi;
  const data = useMemo(() => ({
    fields: previewData.fields || {},
    store: previewData.store?.store_name ? previewData.store : store,
    job: SAMPLE_JOB,
  }), [previewData, store]);
  const rendered = useMemo(
    () => (draft ? renderLabelHtml(draft, data, { editor: true, dpi, hasLogo: hasUsableLogo(logo) }) : { html: '', warnings: [] }),
    [draft, data, dpi, logo],
  );
  const css = useMemo(() => labelCss({ logo }), [logo]);
  const warnings = summarizeWarnings(rendered.warnings);
  const problemIds = useMemo(() => new Set(rendered.warnings.filter((w) => w.level !== 'info' && w.elementId).map((w) => w.elementId)), [rendered]);

  // ---- persistence -----------------------------------------------------------
  const replaceInBundle = (tpl, { add = false } = {}) => {
    setBundle((b) => {
      const list = add ? [...b.templates, tpl] : b.templates.map((t) => (t.id === tpl.id ? tpl : (tpl.is_default ? { ...t, is_default: false } : t)));
      return { ...b, templates: list.sort((a, c) => (c.is_default - a.is_default) || a.name.localeCompare(c.name)) };
    });
  };

  const guard = async (fn, success) => {
    setBusy(true);
    try {
      const out = await fn();
      if (success) notify(success, 'success');
      return out;
    } catch (err) {
      if (err?.response?.status === 409) setConflict(apiError(err));
      else notify(apiError(err, 'Could not save the template.'), 'error');
      return null;
    } finally {
      setBusy(false);
    }
  };

  const validateBeforeSave = () => {
    if (!draft.name?.trim()) { setDialog('saveas'); return false; }
    const blocking = rendered.warnings.filter((w) => w.level === 'error' && !w.kind);
    if (blocking.length && !window.confirm(`${blocking[0].message}\n\nSave anyway?`)) return false;
    return true;
  };

  async function handleSave() {
    const t = draftRef.current;
    if (!t || !canDesign) return;
    if (!t.id) { setDialog('saveas'); return; }
    if (!dirty) { notify('No changes to save.', 'info'); return; }
    if (!validateBeforeSave()) return;
    const saved = await guard(() => updateTemplate(t), `“${t.name}” saved (v${t.version + 1}).`);
    if (saved) { replaceInBundle(saved); loadTemplate(saved); }
  }

  const handleSaveAs = async (name) => {
    setDialog(null);
    const saved = await guard(() => createTemplate({ ...draftRef.current, name }), `Saved as new template “${name}”.`);
    if (saved) { replaceInBundle(saved, { add: true }); loadTemplate(saved); }
  };

  const handleRename = async (name) => {
    setDialog(null);
    if (!draft.id) { commit((t) => ({ ...t, name })); return; }
    const saved = await guard(() => renameTemplate(draft, name), 'Template renamed.');
    if (saved) {
      replaceInBundle(saved);
      // keep unsaved layout edits, adopt the new name + version
      const next = { ...draftRef.current, name: saved.name, version: saved.version };
      setDraft(next);
      setSavedJson(JSON.stringify({ ...JSON.parse(savedJson), name: saved.name, version: saved.version }));
    }
  };

  const handleDuplicate = async () => {
    setMenuAnchor(null);
    if (!draft.id) return;
    if (dirty && !window.confirm('Duplicate copies the last SAVED version of this template. Continue?')) return;
    const saved = await guard(() => duplicateTemplate(draft.id), 'Template duplicated.');
    if (saved) { replaceInBundle(saved, { add: true }); loadTemplate(saved); }
  };

  const handleDelete = async () => {
    setMenuAnchor(null);
    if (!draft.id) return;
    if (!window.confirm(`Delete “${draft.name}”? You can restore it later from “Deleted templates”.`)) return;
    const ok = await guard(() => deleteTemplate(draft.id), 'Template deleted.');
    if (ok !== null) {
      setBundle((b) => ({ ...b, templates: b.templates.filter((t) => t.id !== draft.id) }));
      const next = templates.find((t) => t.id !== draft.id && t.is_default) || templates.find((t) => t.id !== draft.id);
      if (next) loadTemplate(next);
    }
  };

  const handleSetDefault = async () => {
    setMenuAnchor(null);
    const saved = await guard(() => setDefaultTemplate(draft.id), `“${draft.name}” is now the default label.`);
    if (saved) {
      setBundle((b) => ({ ...b, templates: b.templates.map((t) => ({ ...t, is_default: t.id === saved.id })) }));
      setDraft({ ...draftRef.current, is_default: true });
      setSavedJson(JSON.stringify({ ...JSON.parse(savedJson), is_default: true }));
    }
  };

  const handleRestoreDefault = async () => {
    setMenuAnchor(null);
    if (!window.confirm(`Reset “${draft.name}” to its original starter layout? The current design is kept in Version history.`)) return;
    const saved = await guard(() => restoreDefaultTemplate(draft.id), 'Starter layout restored.');
    if (saved) { replaceInBundle(saved); loadTemplate(saved); }
  };

  const handleRestoreVersion = async (version) => {
    setDialog(null);
    const saved = await guard(() => restoreVersion(draft.id, version), `Version ${version} restored.`);
    if (saved) { replaceInBundle(saved); loadTemplate(saved); }
  };

  const handleUndelete = async (t) => {
    setDialog(null);
    const saved = await guard(() => undeleteTemplate(t.id), `“${t.name}” restored.`);
    if (saved) { replaceInBundle(saved, { add: true }); loadTemplate(saved); }
  };

  const handleNewFromPreset = async (preset) => {
    setDialog(null);
    const saved = await guard(() => createFromPreset(preset.preset_key), `Created “${preset.name}”.`);
    if (saved) { replaceInBundle(saved, { add: true }); loadTemplate(saved); }
  };

  const handleNewBlank = (printerType) => {
    setDialog(null);
    const t = blankTemplate(printerType);
    setDraft(t);
    setSavedJson('');
    past.current = [];
    future.current = [];
    setSelection([]);
    setCurrentId(null);
    setMode('beginner');
  };

  const reloadFromServer = async () => {
    const fresh = await guard(() => fetchTemplate(draft.id));
    if (fresh) { replaceInBundle(fresh); loadTemplate(fresh); setConflict(''); }
  };

  const switchTemplate = (id) => {
    if (dirty && !window.confirm('You have unsaved changes to this template. Discard them?')) return;
    const t = templates.find((x) => x.id === id);
    if (t) loadTemplate(t);
  };

  // ---- preview / test print ----------------------------------------------------
  const openPreviewGallery = () => {
    const sets = [
      ...(previewData.kind === 'product' ? [{ label: `Selected: ${previewData.label}`, fields: previewData.fields }] : []),
      ...SAMPLE_SCENARIOS.map((s) => ({ label: `Sample: ${s.label}`, fields: s.fields })),
    ];
    const blocks = sets.map((s) => {
      const out = renderLabelHtml(draft, { fields: s.fields, store: data.store, job: SAMPLE_JOB }, { dpi, hasLogo: hasUsableLogo(logo) });
      const w = summarizeWarnings(out.warnings).filter((x) => x.level !== 'info');
      return `<section><h3>${s.label.replace(/</g, '&lt;')}</h3><div class="row"><div><div class="cap">Actual size</div>${out.html}</div>` +
        `<div><div class="cap">Enlarged ×3</div><div style="zoom:3">${out.html}</div></div></div>` +
        `${w.length ? `<ul>${w.map((x) => `<li class="${x.level}">${x.message.replace(/</g, '&lt;')}</li>`).join('')}</ul>` : '<p class="ok">✓ No problems</p>'}</section>`;
    }).join('');
    const pageCss = `${labelCss({ logo })} body{font-family:Arial,sans-serif;margin:16px;background:#f1f5f9}
      section{background:#fff;border-radius:8px;padding:12px 16px;margin-bottom:12px;box-shadow:0 1px 3px #0002}
      h3{margin:0 0 8px;font-size:14px} .row{display:flex;gap:28px;align-items:flex-start;flex-wrap:wrap}
      .cap{font-size:11px;color:#64748b;margin-bottom:4px} .gl-label{outline:1px solid #cbd5e1}
      ul{margin:8px 0 0;padding-left:18px;font-size:12px} li.error{color:#b91c1c} li.warning{color:#b45309} .ok{color:#15803d;font-size:12px;margin:8px 0 0}`;
    if (!openPrintWindow(`Preview — ${draft.name || 'label'}`, pageCss, `<h2 style="margin:0 0 12px">${(draft.name || 'Untitled').replace(/</g, '&lt;')} — ${draft.width_mm} × ${draft.height_mm} mm</h2>${blocks}`, { autoPrint: false })) {
      notify('Pop-up blocked — allow pop-ups to open the preview.', 'warning');
    }
  };

  const testPrintLabel = () => {
    setTestAnchor(null);
    const out = renderLabelHtml(draft, data, { dpi, hasLogo: hasUsableLogo(logo) });
    const doc = buildPrintDocument(draft, [out.html], { settings, logo });
    if (!openPrintWindow('Test label', doc.css, doc.body)) notify('Pop-up blocked — allow pop-ups to print.', 'warning');
  };

  // ---- UI ------------------------------------------------------------------------
  if (!draft) {
    return <Box sx={{ p: 4, textAlign: 'center' }}><CircularProgress /></Box>;
  }
  const selectedSingle = selection.length === 1;
  const usedBy = WORKFLOWS.filter((w) => settings[w.key] === draft.id || (!settings[w.key] && draft.is_default));
  const thermalTemplates = templates.filter((t) => t.printer_type !== 'a4');
  const a4Templates = templates.filter((t) => t.printer_type === 'a4');
  const templateOption = (t) => (
    <MenuItem key={t.id} value={t.id}>
      {t.is_default ? '★ ' : ''}{t.name} <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>{t.width_mm} × {t.height_mm} mm · v{t.version}</Typography>
    </MenuItem>
  );

  return (
    <Box>
      {/* Template bar */}
      <Stack direction={{ xs: 'column', lg: 'row' }} spacing={1.5} alignItems={{ lg: 'center' }} sx={{ mb: 1.5 }}>
        <TextField
          select size="small" label="Template" value={draft.id || '__new'} onChange={(e) => switchTemplate(e.target.value)}
          sx={{ minWidth: 300, flex: { lg: '0 1 380px' } }} inputProps={{ 'data-testid': 'template-select' }}
        >
          {!draft.id && <MenuItem value="__new">{draft.name || 'Untitled (not saved)'}</MenuItem>}
          {thermalTemplates.length > 0 && <ListSubheader>Thermal roll</ListSubheader>}
          {thermalTemplates.map(templateOption)}
          {a4Templates.length > 0 && <ListSubheader>A4 sheet</ListSubheader>}
          {a4Templates.map(templateOption)}
        </TextField>
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap alignItems="center">
          {dirty && <Chip size="small" color="warning" label="Unsaved changes" />}
          {usedBy.map((w) => <Chip key={w.id} size="small" variant="outlined" label={w.label.split(' → ').pop()} />)}
          {draft.uses_restricted_fields && <Chip size="small" color="secondary" variant="outlined" label="Restricted pricing" />}
        </Stack>
        <Box sx={{ flex: 1 }} />
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          <Button size="small" startIcon={<Add />} onClick={() => setDialog('new')} disabled={!canDesign}>New</Button>
          <Button size="small" variant="contained" startIcon={busy ? <CircularProgress size={14} color="inherit" /> : <Save />} onClick={handleSave} disabled={!canDesign || busy || (!!draft.id && !dirty)} data-testid="save-template">
            {draft.id ? 'Update Template' : 'Save Template'}
          </Button>
          <Button size="small" variant="outlined" startIcon={<SaveAs />} onClick={() => setDialog('saveas')} disabled={!canDesign || busy}>Save as New</Button>
          <Button size="small" variant="outlined" startIcon={<Visibility />} onClick={openPreviewGallery}>Preview</Button>
          <Button size="small" variant="outlined" startIcon={<Science />} onClick={(e) => setTestAnchor(e.currentTarget)}>Test Print</Button>
          <Button size="small" variant="outlined" startIcon={<Print />} onClick={() => onPrintLabels(draft, previewData.kind === 'product' ? previewData.product : null, dirty)}>Print Labels</Button>
          <IconButton size="small" onClick={(e) => setMenuAnchor(e.currentTarget)} aria-label="More template actions"><MoreVert /></IconButton>
        </Stack>
      </Stack>

      {!canDesign && (
        <Alert severity="info" sx={{ mb: 1.5 }}>
          View only — sign in as an administrator, manager, inventory or purchase user to save label templates. You can still preview and print.
        </Alert>
      )}
      {conflict && (
        <Alert severity="warning" sx={{ mb: 1.5 }} action={<Stack direction="row" spacing={1}><Button size="small" onClick={reloadFromServer}>Reload theirs</Button><Button size="small" onClick={() => { setConflict(''); setDialog('saveas'); }}>Save mine as new</Button></Stack>}>
          {conflict}
        </Alert>
      )}

      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: { xs: '1fr', md: '230px minmax(0,1fr)', xl: '250px minmax(0,1fr) 320px' }, alignItems: 'start' }}>
        {/* Left: elements / quick setup */}
        <Paper variant="outlined" sx={{ p: 1.5, maxHeight: { md: 'calc(100vh - 210px)' }, overflowY: 'auto', position: { md: 'sticky' }, top: { md: 80 } }}>
          <ElementPalette mode={mode} onModeChange={setMode} onAdd={(p) => addElement(p)} allowedFields={allowedFields} onAutoLayout={runAutoLayout} readOnly={!canDesign} />
        </Paper>

        {/* Centre: toolbar + canvas + warnings */}
        <Box sx={{ minWidth: 0 }}>
          <Paper variant="outlined" sx={{ p: 0.75, mb: 1, display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 0.25 }}>
            <Tooltip title="Undo (Ctrl+Z)"><span><IconButton size="small" onClick={undo} disabled={!past.current.length}><Undo fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Redo (Ctrl+Y)"><span><IconButton size="small" onClick={redo} disabled={!future.current.length}><Redo fontSize="small" /></IconButton></span></Tooltip>
            <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
            <Tooltip title="Zoom out"><IconButton size="small" onClick={() => setZoom((z) => Math.max(0.75, r2(z / 1.25)))}><ZoomOut fontSize="small" /></IconButton></Tooltip>
            <Typography variant="caption" sx={{ minWidth: 44, textAlign: 'center' }}>{Math.round(zoom * 100)}%</Typography>
            <Tooltip title="Zoom in"><IconButton size="small" onClick={() => setZoom((z) => Math.min(12, r2(z * 1.25)))}><ZoomIn fontSize="small" /></IconButton></Tooltip>
            <Tooltip title="Fit label to the screen"><IconButton size="small" onClick={fitZoom}><FitScreen fontSize="small" /></IconButton></Tooltip>
            <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
            <Tooltip title="Grid (5 mm major lines)"><ToggleButton size="small" value="grid" selected={showGrid} onChange={() => setShowGrid((v) => !v)} sx={{ p: 0.5 }}><GridOn fontSize="small" /></ToggleButton></Tooltip>
            <Tooltip title="Snap to grid & alignment guides"><ToggleButton size="small" value="snap" selected={snap} onChange={() => setSnap((v) => !v)} sx={{ p: 0.5, ml: 0.5 }}><Straighten fontSize="small" /></ToggleButton></Tooltip>
            <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
            <Tooltip title="Duplicate (Ctrl+D)"><span><IconButton size="small" onClick={duplicateSelected} disabled={!selection.length}><ContentCopy fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Bring forward"><span><IconButton size="small" onClick={() => reorder('up')} disabled={!selection.length}><KeyboardArrowUp fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Send backward"><span><IconButton size="small" onClick={() => reorder('down')} disabled={!selection.length}><KeyboardArrowDown fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Bring to front"><span><IconButton size="small" onClick={() => reorder('front')} disabled={!selection.length}><FlipToFront fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Send to back"><span><IconButton size="small" onClick={() => reorder('back')} disabled={!selection.length}><FlipToBack fontSize="small" /></IconButton></span></Tooltip>
            <Tooltip title="Delete (Del)"><span><IconButton size="small" onClick={deleteSelected} disabled={!selection.length}><DeleteOutline fontSize="small" /></IconButton></span></Tooltip>
            <Divider orientation="vertical" flexItem sx={{ mx: 0.5 }} />
            <Tooltip title="Fit to canvas — pull every element inside the printable area"><IconButton size="small" onClick={fitToLabel}><CenterFocusStrong fontSize="small" /></IconButton></Tooltip>
            <Tooltip title="Reset layout — discard unsaved changes"><span><IconButton size="small" onClick={discardChanges} disabled={!dirty || !savedJson}><Replay fontSize="small" /></IconButton></span></Tooltip>
            <Box sx={{ flex: 1 }} />
            <Typography variant="caption" color="text.secondary" sx={{ pr: 1 }}>
              {draft.width_mm} × {draft.height_mm} mm · {draft.printer_type === 'a4' ? `A4, ${draft.layout.sheet?.cols}×${draft.layout.sheet?.rows}` : 'thermal'}
            </Typography>
          </Paper>

          <Paper variant="outlined" sx={{ p: 1, mb: 1 }}>
            <PreviewDataPicker onData={setPreviewData} />
          </Paper>

          <Box
            ref={canvasBoxRef}
            sx={{ bgcolor: '#e2e8f0', borderRadius: 1, p: 3, overflow: 'auto', minHeight: 300, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <DesignerCanvas
              template={draft}
              labelHtml={rendered.html}
              css={css}
              zoom={zoom}
              showGrid={showGrid}
              snap={snap}
              selection={selection}
              onSelect={setSelection}
              onLiveChange={liveChange}
              onCommitChange={commitDrag}
              onDropElement={(p, x, y) => addElement(p, x, y)}
              problemIds={problemIds}
            />
          </Box>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
            {previewData.kind === 'product' ? `Showing live data for “${previewData.label}”.` : `Sample data: ${previewData.label || 'Typical frame'}.`}
            {' '}Batch / expiry / offer show sample values in the designer. Arrows nudge 0.5 mm (Shift 2 mm, Alt 0.1 mm).
          </Typography>

          <Box sx={{ mt: 1 }} data-testid="label-warnings">
            {warnings.length === 0 ? (
              <Alert severity="success" sx={{ py: 0 }}>No layout problems for this data.</Alert>
            ) : warnings.map((w, i) => (
              <Stack
                key={i} direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap
                onClick={() => w.elementId && setSelection([w.elementId])}
                sx={{ py: 0.4, px: 1, cursor: w.elementId ? 'pointer' : 'default', borderRadius: 1, '&:hover': { bgcolor: 'action.hover' } }}
              >
                {LEVEL_ICON[w.level]}
                <Typography variant="body2" sx={{ flex: '1 1 300px' }}>{w.message}</Typography>
                {(w.fixes || []).map((f) => (
                  <Button key={f.id} size="small" variant="outlined" disabled={!canDesign} data-testid={`fix-${f.id}`}
                    onClick={(e) => { e.stopPropagation(); applyFix(w.elementId, f.id); }}>
                    {f.label}
                  </Button>
                ))}
              </Stack>
            ))}
          </Box>
        </Box>

        {/* Right: properties */}
        <Paper variant="outlined" sx={{ p: 1.5, gridColumn: { md: '1 / -1', xl: 'auto' }, maxHeight: { xl: 'calc(100vh - 210px)' }, overflowY: { xl: 'auto' }, position: { xl: 'sticky' }, top: { xl: 80 } }}>
          <PropertiesPanel
            template={draft}
            selection={selection}
            onTemplate={commit}
            onElement={updateElement}
            onResize={resizeLabel}
            onAlign={align}
            onDelete={deleteSelected}
            allowedFields={allowedFields}
            dpi={dpi}
            previewData={data.fields}
          />
          {selectedSingle && <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>Esc to deselect and edit label settings.</Typography>}
        </Paper>
      </Box>

      {/* More actions */}
      <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={() => setMenuAnchor(null)}>
        <MenuItem onClick={handleDuplicate} disabled={!draft.id || !canDesign}><ListItemIcon><ContentCopy fontSize="small" /></ListItemIcon><ListItemText>Duplicate</ListItemText></MenuItem>
        <MenuItem onClick={() => { setMenuAnchor(null); setDialog('rename'); }} disabled={!canDesign}><ListItemIcon><DriveFileRenameOutline fontSize="small" /></ListItemIcon><ListItemText>Rename</ListItemText></MenuItem>
        <MenuItem onClick={handleSetDefault} disabled={!draft.id || draft.is_default || !canDesign}><ListItemIcon><Star fontSize="small" /></ListItemIcon><ListItemText>Make default label</ListItemText></MenuItem>
        <MenuItem onClick={handleRestoreDefault} disabled={!draft.preset_key || !canDesign}><ListItemIcon><RestartAlt fontSize="small" /></ListItemIcon><ListItemText>Restore Default (starter layout)</ListItemText></MenuItem>
        <MenuItem onClick={() => { setMenuAnchor(null); setDialog('versions'); }} disabled={!draft.id}><ListItemIcon><History fontSize="small" /></ListItemIcon><ListItemText>Version history</ListItemText></MenuItem>
        <MenuItem onClick={() => { setMenuAnchor(null); setDialog('deleted'); }}><ListItemIcon><RestoreFromTrash fontSize="small" /></ListItemIcon><ListItemText>Deleted templates…</ListItemText></MenuItem>
        <Divider />
        <MenuItem onClick={handleDelete} disabled={!draft.id || draft.is_default || !canDesign} sx={{ color: 'error.main' }}><ListItemIcon><DeleteOutline fontSize="small" color="error" /></ListItemIcon><ListItemText>Delete template</ListItemText></MenuItem>
      </Menu>
      <Menu anchorEl={testAnchor} open={!!testAnchor} onClose={() => setTestAnchor(null)}>
        <MenuItem onClick={testPrintLabel}><ListItemText primary="Print one test label" secondary="Current preview data, with printer calibration" /></MenuItem>
        <MenuItem onClick={() => { setTestAnchor(null); printCalibration(draft, settings); }}>
          <ListItemText primary={draft.printer_type === 'a4' ? 'Print sheet alignment grid' : 'Print calibration label'} secondary="Edges, centre mark and 5 mm ticks — measure with a ruler" />
        </MenuItem>
      </Menu>

      <NewTemplateDialog open={dialog === 'new'} onClose={() => setDialog(null)} onPreset={handleNewFromPreset} onBlank={handleNewBlank} />
      <NamePrompt open={dialog === 'saveas'} title="Save as new template" initial={draft.name ? `${draft.name}${draft.id ? ' (Copy)' : ''}` : ''} confirmLabel="Save" onClose={() => setDialog(null)} onConfirm={handleSaveAs} />
      <NamePrompt open={dialog === 'rename'} title="Rename template" initial={draft.name} confirmLabel="Rename" onClose={() => setDialog(null)} onConfirm={handleRename} />
      <VersionsDialog open={dialog === 'versions'} template={draft} onClose={() => setDialog(null)} onRestore={handleRestoreVersion} />
      <DeletedDialog open={dialog === 'deleted'} onClose={() => setDialog(null)} onRestore={handleUndelete} />
      {bundle?.offline && <Alert severity="warning" sx={{ mt: 1 }}>Offline — showing cached templates. Changes can’t be saved until the server is reachable. <Button size="small" onClick={reload}>Retry</Button></Alert>}
    </Box>
  );
}

