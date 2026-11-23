'use strict';
// Print preview window. The pages shown are the PDF that Chromium's print engine produced for the
// document (desktop shell, lib/printPreview.js); printing asks the printer for that same paper.
(() => {
  const api = window.gtradePrintPreview;
  const $ = (id) => document.getElementById(id);
  const PDF = '__save_as_pdf__';
  const el = {
    frame: $('pdf'), stageMsg: $('stage-msg'), title: $('doc-title'), meta: $('doc-meta'),
    destination: $('destination'), refresh: $('refresh'), destNote: $('dest-note'), paper: $('paper'), paperNote: $('paper-note'),
    orientation: $('orientation'), orientationNote: $('orientation-note'), margins: $('margins'), copies: $('copies'),
    notice: $('notice'), message: $('message'), print: $('print'), save: $('save'), cancel: $('cancel'), system: $('system'),
  };

  const state = {
    info: null, settings: null, render: null, printers: [], printerInfo: null, busy: false, renders: 0,
    pdfUrl: '', sourceGone: false, renderSeq: 0, lastError: '',
  };

  const setState = (s) => { document.body.dataset.state = s; };
  const text = (node, value) => { node.textContent = value || ''; };
  const option = (value, label, extra = {}) => {
    const o = document.createElement('option');
    o.value = value;
    o.textContent = label;
    if (extra.disabled) o.disabled = true;
    return o;
  };

  function showMessage(kind, msg, actions = []) {
    el.message.hidden = !msg;
    el.message.className = `message ${kind}`;
    el.message.textContent = msg || '';
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'actions';
      for (const a of actions) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'link';
        b.textContent = a.label;
        b.addEventListener('click', a.run);
        row.appendChild(b);
      }
      el.message.appendChild(row);
    }
  }

  function currentPrinter() {
    return state.printers.find((p) => p.name === state.settings.destination) || null;
  }

  function updateButtons() {
    const toPdf = state.settings && state.settings.destination === PDF;
    const ready = Boolean(state.render) && !state.busy;
    el.print.textContent = toPdf ? 'Save PDF' : 'Print';
    el.print.disabled = !ready || (!toPdf && state.sourceGone);
    el.save.hidden = toPdf; // the main button already saves
    el.save.disabled = !ready;
    el.system.disabled = !ready || state.sourceGone;
    for (const c of [el.paper, el.margins]) c.disabled = state.busy || state.sourceGone;
    el.orientation.disabled = state.busy || state.sourceGone || !orientationApplies();
    el.copies.disabled = toPdf || state.busy;
    el.destination.disabled = state.busy || !state.printerInfo;
    el.refresh.disabled = state.busy;
  }

  function orientationApplies() {
    const i = state.info;
    if (!i || !state.settings) return false;
    return !i.orientationFixed && (state.settings.paper !== 'document' || i.kind === 'screen');
  }

  function updateNotes() {
    const i = state.info;
    const r = state.render;
    const p = currentPrinter();
    // Destination
    let note = '';
    const warnings = [];
    if (state.settings.destination === PDF) note = 'Creates a PDF file of exactly these pages.';
    else if (p) {
      const bits = [];
      if (p.isDefault) bits.push('Windows default printer');
      if (p.virtual) bits.push(p.type === 'pdf' || p.type === 'xps' ? 'Virtual printer — creates a file, not paper'
        : p.type === 'onenote' ? 'Virtual printer — sends to OneNote, not paper'
          : p.type === 'remote' ? 'Remote-session printer' : 'Virtual printer — no paper');
      if (p.status && p.status !== 'Ready' && !p.offline) bits.push(p.status);
      note = bits.join(' · ');
      if (p.offline) warnings.push(`${p.displayName} is offline. Check that it is switched on and connected, or choose another printer.`);
      if (r && p.virtual && !isSheet(r.widthMm, r.heightMm)) {
        warnings.push(`${p.displayName} supports standard sheet sizes only, so this ${i.kind === 'label' ? 'label' : 'receipt'} would be placed on a full sheet. Use Save as PDF for an exact-size PDF.`);
      }
    }
    text(el.destNote, [note, ...warnings].filter(Boolean).join(' '));
    el.destNote.classList.toggle('warn', warnings.length > 0);
    // Orientation
    text(el.orientationNote, i.orientationFixed ? 'Set by the document.' : '');
    // Paper
    let paperNote = '';
    if (state.settings.paper === 'document' && i.roll) paperNote = 'One continuous receipt, as long as its content.';
    else if (state.settings.paper !== 'document' && (i.cssSize || i.roll)) paperNote = 'Printed at its designed size, reduced to fit if the sheet is smaller.';
    text(el.paperNote, paperNote);
  }

  const SHEETS = [[210, 297], [148, 210], [215.9, 279.4], [297, 420], [105, 148], [215.9, 355.6]];
  function isSheet(w, h) {
    return SHEETS.some(([a, b]) => (Math.abs(w - a) <= 1.5 && Math.abs(h - b) <= 1.5) || (Math.abs(w - b) <= 1.5 && Math.abs(h - a) <= 1.5));
  }

  function fillPrinters(info) {
    state.printerInfo = info;
    state.printers = info.printers || [];
    // Keep what is selected across a refresh (a printer that still exists, or a PDF the user
    // picked); otherwise start on the shell's choice (last used for this kind of document, ...).
    const cur = state.settings.destination;
    const keep = (cur === PDF ? state.userPicked : state.printers.some((p) => p.name === cur)) ? cur : (info.selected || PDF);
    el.destination.textContent = '';
    const physical = state.printers.filter((p) => !p.virtual);
    const virtual = state.printers.filter((p) => p.virtual);
    const label = (p) => `${p.displayName}${p.isDefault ? ' (default)' : ''}${p.offline ? ' — offline' : ''}`;
    if (physical.length) {
      const g = document.createElement('optgroup');
      g.label = 'Printers';
      physical.forEach((p) => g.appendChild(option(p.name, label(p))));
      el.destination.appendChild(g);
    }
    const g2 = document.createElement('optgroup');
    g2.label = 'Save to a file';
    g2.appendChild(option(PDF, 'Save as PDF'));
    el.destination.appendChild(g2);
    if (virtual.length) {
      const g3 = document.createElement('optgroup');
      g3.label = 'Virtual printers (no paper)';
      virtual.forEach((p) => g3.appendChild(option(p.name, label(p))));
      el.destination.appendChild(g3);
    }
    state.settings.destination = keep;
    el.destination.value = keep;

    // No paper printer: say so plainly, and offer the PDF.
    if (!info.hasPhysical) {
      el.notice.hidden = false;
      el.notice.textContent = '';
      const strong = document.createElement('strong');
      strong.textContent = 'No paper printer is set up on this computer.';
      el.notice.appendChild(strong);
      el.notice.appendChild(document.createTextNode('Save as PDF works now. To print on paper, connect the printer, add it in '
        + 'Windows Settings › Bluetooth & devices › Printers & scanners, then press ↻.'));
      if (virtual.length) {
        const small = document.createElement('span');
        small.className = 'small';
        small.textContent = `${virtual.map((p) => p.displayName).join(', ')} ${virtual.length === 1 ? 'makes a file' : 'make files'} or send${virtual.length === 1 ? 's' : ''} to another app, not paper.`;
        el.notice.appendChild(small);
      }
    } else {
      el.notice.hidden = true;
    }
    updateNotes();
    updateButtons();
  }

  async function loadPrinters(refresh) {
    try {
      fillPrinters(await api.printers(refresh));
    } catch (err) {
      fillPrinters({ printers: [], hasPhysical: false, selected: PDF });
      showMessage('error', `Could not read the printer list: ${cleanError(err)}`);
    }
  }

  function cleanError(err) {
    return String((err && err.message) || err || 'Unknown error').replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }

  function viewerFragment(r) {
    if (state.info.kind === 'receipt' || state.info.kind === 'label') {
      const frameW = Math.max(200, el.frame.clientWidth || 600);
      const pagePx = (r.widthMm * 96) / 25.4;
      const zoom = Math.round(Math.max(50, Math.min(400, ((Math.min(frameW * 0.5, 380)) / pagePx) * 100)));
      return `#toolbar=0&navpanes=0&zoom=${zoom}`;
    }
    return '#toolbar=0&navpanes=0&view=Fit';
  }

  // Resolves when the PDF viewer has loaded the new pages (or after a short safety timeout).
  function showPdf(url) {
    return new Promise((resolve) => {
      let settled = false;
      const done = () => { if (!settled) { settled = true; el.frame.removeEventListener('load', done); resolve(); } };
      el.frame.addEventListener('load', done);
      setTimeout(done, 4000);
      el.frame.src = url;
    });
  }

  async function renderPreview() {
    const seq = (state.renderSeq += 1);
    state.busy = true;
    setState(state.render ? 'rendering' : 'loading');
    text(el.stageMsg, 'Preparing preview…');
    updateButtons();
    try {
      const r = await api.render(state.settings);
      if (seq !== state.renderSeq) return;
      state.render = r;
      state.renders += 1;
      const url = URL.createObjectURL(new Blob([r.pdf], { type: 'application/pdf' }));
      await showPdf(url + viewerFragment(r));
      if (state.pdfUrl) URL.revokeObjectURL(state.pdfUrl);
      state.pdfUrl = url;
      if (seq !== state.renderSeq) return;
      text(el.meta, `${r.pages} ${r.pages === 1 ? 'page' : 'pages'} · ${r.paper}`);
      state.lastError = '';
      setState('ready');
    } catch (err) {
      if (seq !== state.renderSeq) return;
      state.lastError = cleanError(err);
      setState(state.render ? 'ready' : 'error');
      text(el.stageMsg, 'The preview could not be prepared.');
      showMessage('error', state.lastError);
    } finally {
      if (seq === state.renderSeq) {
        state.busy = false;
        updateNotes();
        updateButtons();
      }
    }
  }

  function readCopies() {
    const n = Math.round(Number(el.copies.value));
    const v = Number.isFinite(n) ? Math.min(99, Math.max(1, n)) : 1;
    el.copies.value = String(v);
    return v;
  }

  async function doPrint(system = false) {
    if (state.busy) return;
    state.settings.copies = readCopies();
    if (!system && state.settings.destination === PDF) { doSave(); return; }
    state.busy = true;
    updateButtons();
    showMessage('info', system ? 'Opening the Windows print dialog…' : `Sending to ${currentPrinter() ? currentPrinter().displayName : 'the printer'}…`);
    try {
      const res = system ? await api.systemDialog(state.settings) : await api.print(state.settings);
      if (res.ok) {
        showMessage('ok', res.message);
        setTimeout(() => api.close(), 900);
        return;
      }
      showMessage(res.cancelled ? 'info' : 'error', res.message);
    } catch (err) {
      showMessage('error', cleanError(err));
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  async function doSave() {
    if (state.busy) return;
    state.busy = true;
    updateButtons();
    try {
      const res = await api.savePdf(state.settings);
      if (res.ok) {
        showMessage('ok', `Saved ${res.name} in ${res.folder}.`, [
          { label: 'Open PDF', run: () => api.reveal('open') },
          { label: 'Show in folder', run: () => api.reveal('folder') },
        ]);
        el.cancel.textContent = 'Close';
      } else if (!res.cancelled) {
        showMessage('error', res.message || 'The PDF was not saved.');
      }
    } catch (err) {
      showMessage('error', `The PDF was not saved: ${cleanError(err)}`);
    } finally {
      state.busy = false;
      updateButtons();
    }
  }

  function fillChoices(info) {
    el.paper.textContent = '';
    if (info.kind === 'screen') {
      ['A4', 'A5', 'Letter'].forEach((p) => el.paper.appendChild(option(p, p)));
      state.settings.paper = 'A4';
    } else {
      el.paper.appendChild(option('document', `As designed — ${info.designed}`));
      ['A4', 'A5', 'Letter'].forEach((p) => el.paper.appendChild(option(p, `${p} (fit to sheet)`)));
    }
    el.paper.value = state.settings.paper;
    el.margins.textContent = '';
    el.margins.appendChild(option('document', info.margins ? `As designed (${info.margins})` : 'Default (10 mm)'));
    el.margins.appendChild(option('none', 'None'));
    el.margins.appendChild(option('narrow', 'Narrow (5 mm)'));
    el.margins.appendChild(option('normal', 'Normal (10 mm)'));
    el.margins.value = state.settings.margins;
    el.orientation.value = state.settings.orientation;
  }

  function onSourceGone() {
    state.sourceGone = true;
    showMessage('error', 'The document window was closed, so it can no longer be printed. You can still save this preview as a PDF.');
    updateButtons();
  }

  async function start() {
    if (!api) {
      text(el.stageMsg, 'Print preview is not available.');
      setState('error');
      return;
    }
    api.onSourceGone(onSourceGone);
    let info;
    try {
      info = await api.init();
    } catch (err) {
      text(el.stageMsg, `Print preview is not available: ${cleanError(err)}`);
      setState('error');
      return;
    }
    state.info = info;
    state.settings = { destination: '', ...info.defaults };
    const title = info.title || { label: 'Labels', receipt: 'Receipt' }[info.kind] || 'Document';
    text(el.title, title);
    document.title = `Print preview — ${title}`;
    fillChoices(info);
    if (info.sourceGone) onSourceGone();
    updateButtons();
    await Promise.all([renderPreview(), loadPrinters(false)]);
    el.print.focus({ focusVisible: false });
  }

  // ---- events --------------------------------------------------------------------------------
  el.destination.addEventListener('change', () => {
    state.settings.destination = el.destination.value;
    state.userPicked = true;
    showMessage('info', '');
    el.message.hidden = true;
    updateNotes();
    updateButtons();
  });
  for (const [node, key] of [[el.paper, 'paper'], [el.orientation, 'orientation'], [el.margins, 'margins']]) {
    node.addEventListener('change', () => {
      state.settings[key] = node.value;
      el.message.hidden = true;
      updateButtons();
      renderPreview();
    });
  }
  el.copies.addEventListener('change', readCopies);
  el.refresh.addEventListener('click', () => loadPrinters(true));
  el.print.addEventListener('click', () => doPrint(false));
  el.save.addEventListener('click', doSave);
  el.system.addEventListener('click', () => doPrint(true));
  el.cancel.addEventListener('click', () => api.close());
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); api.close(); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); doPrint(false); return; }
    if (e.ctrlKey && !e.altKey && (e.key === 's' || e.key === 'S')) { e.preventDefault(); doSave(); }
  });

  // Read-only state for the shell's automated self-test.
  window.__printPreviewState = () => ({
    state: document.body.dataset.state, renders: state.renders, busy: state.busy,
    pages: state.render ? state.render.pages : 0, paper: state.render ? state.render.paper : '',
    widthMm: state.render ? state.render.widthMm : 0, heightMm: state.render ? state.render.heightMm : 0,
    frameIsPdfBlob: /^blob:/.test(el.frame.src), destination: state.settings ? state.settings.destination : '',
    destinationOptions: Array.from(el.destination.options).map((o) => o.value), notice: el.notice.hidden ? '' : el.notice.textContent,
    message: el.message.hidden ? '' : el.message.textContent, printLabel: el.print.textContent, printDisabled: el.print.disabled,
    paperOptions: Array.from(el.paper.options).map((o) => o.textContent), orientationDisabled: el.orientation.disabled,
    destNote: el.destNote.textContent, lastError: state.lastError,
  });

  start();
})();
