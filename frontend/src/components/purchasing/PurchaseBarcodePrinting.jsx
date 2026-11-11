// Purchase Entry → Barcode Printing (below the entry form).
//
// Lists a saved purchase entry's lines with how many labels each needs (qty + free), how many
// are confirmed printed and what is still pending. Unprinted tab: select lines (or Select All)
// and print — each line continues from its next unit. Printed tab: Re-print any printed units
// (per row or selected rows) — extra copies only, never a change to counts, stock or the entry.
// Every print / re-print is confirmed first ("Do you want to print all N labels?").
//
// The browser can't tell what the printer actually produced, so every PRINT job is recorded on
// the server first and then confirmed here: all printed / stopped after a given label / none.
// Only the confirmed labels count, so a job that ran out of labels or jammed resumes exactly
// where it stopped. An unconfirmed job (e.g. the tab was closed) is asked about again on the
// next visit, and blocks new prints on that entry until it is answered.
// Server side: backend/apps/purchasing/label_printing.py.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Box, Card, Typography, Stack, Tabs, Tab, Table, TableHead, TableRow, TableCell, TableBody, TableContainer,
  Checkbox, TextField, Button, Chip, Alert, Tooltip, IconButton, MenuItem, Autocomplete, LinearProgress,
  Dialog, DialogTitle, DialogContent, DialogActions, RadioGroup, Radio, FormControlLabel,
} from '@mui/material';
import { QrCode2 as LabelIcon, Refresh as RefreshIcon, Print as PrintIcon, Replay as ReprintIcon, WarningAmber } from '@mui/icons-material';
import useLabelBundle, { templateForWorkflow } from '../../labels/useLabelBundle';
import { fetchLabelData } from '../../labels/labelApi';
import { renderLabelHtml, hasUsableLogo, summarizeWarnings } from '../../labels/renderLabel';
import { printLabelJob, resolveCalibration } from '../../labels/printLabels';
import { buildPrintLines, buildReprintLines, countThrough, jobSize, lineSize, positionOf, printRows } from '../../utils/purchaseLabels';
import { notify } from '../../utils/notify';
import { formatCurrency } from '../../utils/localeFormat.js';

const api = (id) => `/api/purchase/invoices/${id}`;
const errText = (err, fallback) => err?.response?.data?.detail || (err?.response ? fallback : 'Cannot reach the server.');
const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
const STATUS_CHIP = {
  SENT: { label: 'Awaiting confirmation', color: 'warning' },
  COMPLETED: { label: 'Printed', color: 'success' },
  PARTIAL: { label: 'Partly printed', color: 'warning' },
  FAILED: { label: 'Nothing printed', color: 'default' },
};

function details(it) {
  return [it.brand, it.color, it.size, it.sku && `SKU ${it.sku}`].filter(Boolean).join(' · ');
}

const labelsWord = (n) => `${n} label${n === 1 ? '' : 's'}`;

// Before anything goes to the printer: "Do you want to print all N labels?" with what's in the job.
function PrePrintDialog({ kind, lines, items, onCancel, onConfirm }) {
  const total = jobSize(lines);
  const reprint = kind === 'REPRINT';
  const nameOf = (l) => items.find((i) => i.id === l.item)?.product_name || 'Item';
  return (
    <Dialog open onClose={onCancel} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>
        {reprint ? `Re-print ${total === 1 ? 'this label' : `these ${total} labels`}?` : `Do you want to print ${total === 1 ? 'this label' : `all ${total} labels`}?`}
      </DialogTitle>
      <DialogContent dividers>
        <Box sx={{ maxHeight: 240, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, mb: 1.5 }}>
          <Table size="small" stickyHeader>
            <TableHead><TableRow><TableCell>#</TableCell><TableCell>Item</TableCell><TableCell align="right">Units</TableCell><TableCell align="right">Labels</TableCell></TableRow></TableHead>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={l.item}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell>{nameOf(l)}</TableCell>
                  <TableCell align="right">{l.from_unit}–{l.to_unit}</TableCell>
                  <TableCell align="right">{lineSize(l)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
        <Typography variant="body2" color="text.secondary">
          {reprint
            ? 'A re-print only makes extra copies of labels already printed. It does not change the printed counts, stock or the purchase entry.'
            : 'Load enough labels in the printer. After printing you will be asked whether every label came out — anything that did not stays in Unprinted.'}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button onClick={onCancel}>Cancel</Button>
        <Button variant="contained" color={reprint ? 'secondary' : 'primary'} startIcon={reprint ? <ReprintIcon /> : <PrintIcon />}
          onClick={onConfirm} data-testid="labels-preprint-confirm">
          {reprint ? `Re-print ${labelsWord(total)}` : `Yes, print ${labelsWord(total)}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// After a PRINT job is sent: how far did it get?
function ConfirmJobDialog({ invoiceId, job, items, onClose, onConfirmed }) {
  const lines = job?.lines || [];
  const total = job?.labels_sent || jobSize(lines);
  const [outcome, setOutcome] = useState('ALL');
  const [pos, setPos] = useState({ index: 0, unit: lines[0]?.from_unit || 1 });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setOutcome('ALL');
    setPos({ index: 0, unit: lines[0]?.from_unit || 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.id]);

  if (!job) return null;
  const line = lines[pos.index] || lines[0];
  const count = outcome === 'ALL' ? total : outcome === 'NONE' ? 0 : countThrough(lines, pos.index, pos.unit);
  const nameOf = (l) => l.product_name || items.find((i) => i.id === l.item)?.product_name || 'Item';
  const setCount = (n) => {
    const p = positionOf(lines, Math.max(1, Math.min(total, parseInt(n, 10) || 1)));
    if (p) setPos(p);
  };

  const save = async () => {
    setSaving(true);
    try {
      const { data } = await axios.post(`${api(invoiceId)}/label-jobs/${job.id}/confirm/`, { outcome, printed_count: count });
      if (data.skipped?.length) notify(`Not counted (line changed since printing): ${data.skipped.join(', ')}`, 'warning');
      onConfirmed(data.status);
    } catch (err) {
      notify(errText(err, 'Could not save the confirmation.'), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onClose={(e, reason) => reason !== 'backdropClick' && onClose()} maxWidth="sm" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>{total === 1 ? 'Was the label printed successfully?' : `Were all ${total} labels printed successfully?`}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
          Check the printed roll / sheets. Only the labels you confirm are marked printed — the rest stay pending and print next time from where this stopped.
        </Typography>
        <Box sx={{ maxHeight: 180, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1, mb: 2 }}>
          <Table size="small" stickyHeader>
            <TableHead><TableRow><TableCell>#</TableCell><TableCell>Item</TableCell><TableCell align="right">Units</TableCell><TableCell align="right">Labels</TableCell></TableRow></TableHead>
            <TableBody>
              {lines.map((l, i) => (
                <TableRow key={l.item} selected={outcome === 'PARTIAL' && i === pos.index}>
                  <TableCell>{i + 1}</TableCell>
                  <TableCell>{nameOf(l)}</TableCell>
                  <TableCell align="right">{l.from_unit}–{l.to_unit}</TableCell>
                  <TableCell align="right">{lineSize(l)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Box>
        <RadioGroup value={outcome} onChange={(e) => setOutcome(e.target.value)}>
          <FormControlLabel value="ALL" control={<Radio />} label={`Yes — all ${total} labels printed correctly`} />
          <FormControlLabel value="PARTIAL" control={<Radio />} label="It stopped part-way (out of labels, jam, printer error)" />
          {outcome === 'PARTIAL' && line && (
            <Box sx={{ pl: 4, pb: 1 }}>
              <Typography variant="body2" sx={{ mb: 1 }}>The last label that printed correctly was:</Typography>
              <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                <TextField select size="small" label="Item" value={pos.index} sx={{ minWidth: 200 }}
                  onChange={(e) => { const index = Number(e.target.value); setPos({ index, unit: lines[index].from_unit }); }}>
                  {lines.map((l, i) => <MenuItem key={l.item} value={i}>{i + 1}. {nameOf(l)}</MenuItem>)}
                </TextField>
                <TextField size="small" type="number" label={`Unit (${line.from_unit}–${line.to_unit})`} value={pos.unit} sx={{ width: 140 }}
                  inputProps={{ min: line.from_unit, max: line.to_unit }}
                  onChange={(e) => setPos((p) => ({ ...p, unit: Math.max(line.from_unit, Math.min(line.to_unit, parseInt(e.target.value, 10) || line.from_unit)) }))} />
                <TextField size="small" type="number" label="or label # in this job" value={count} sx={{ width: 150 }}
                  inputProps={{ min: 1, max: total }} onChange={(e) => setCount(e.target.value)} />
              </Stack>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {count} of {total} labels will be marked printed; next time {pos.unit < line.to_unit ? `${nameOf(line)} resumes from unit ${pos.unit + 1}` : 'printing resumes with the next item'}.
              </Typography>
            </Box>
          )}
          <FormControlLabel value="NONE" control={<Radio />} label="Nothing printed (cancelled, wrong printer, pop-up blocked)" />
        </RadioGroup>
      </DialogContent>
      <DialogActions>
        <Tooltip title="Keep this job open — you'll be asked again before the next print on this entry">
          <Button onClick={onClose} sx={{ mr: 'auto' }}>Decide later</Button>
        </Tooltip>
        <Button variant="contained" onClick={save} disabled={saving} data-testid="label-job-confirm">
          {saving ? 'Saving…' : `Mark ${count} printed`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

// Every pending line, ready to print: a fresh entry prints all its items, an interrupted one
// carries on from each line's next unit.
const allPendingSelection = (st) => Object.fromEntries((st?.items || []).filter((i) => i.pending > 0).map((i) => [i.id, i.pending]));

// hidePicker: the Purchase → Barcode Printing page supplies its own entry queue.
// onStatus(status): called after every load / confirmation (the queue refreshes its counts).
export default function PurchaseBarcodePrinting({ invoiceId, refreshKey = 0, onInvoiceChange, hidePicker = false, onStatus, sx }) {
  const { bundle, loading: bundleLoading, error: bundleError } = useLabelBundle(Boolean(invoiceId));
  const [status, setStatus] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState('pending');
  const [selected, setSelected] = useState({}); // pending: { itemId: count }
  const [reprint, setReprint] = useState({}); // printed: { itemId: { from, to } }
  const [templateId, setTemplateId] = useState('');
  const [labelData, setLabelData] = useState({ byId: {}, store: {}, logo: '' });
  const [busy, setBusy] = useState(false);
  const [confirmJob, setConfirmJob] = useState(null);
  const [prePrint, setPrePrint] = useState(null); // { kind: PRINT|REPRINT, lines } awaiting "Do you want to print…?"
  const [entries, setEntries] = useState([]);

  const templates = bundle?.templates || [];
  const template = templates.find((t) => t.id === templateId) || templateForWorkflow(bundle, 'purchase');
  const items = useMemo(() => status?.items || [], [status]);
  const openJob = status?.open_job || null;

  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  const applyStatus = useCallback((st) => {
    setStatus(st);
    setSelected(allPendingSelection(st));
    setReprint({});
    onStatusRef.current?.(st);
  }, []);

  const load = useCallback(async () => {
    if (!invoiceId) { setStatus(null); return null; }
    setLoading(true);
    setLoadError('');
    try {
      const { data } = await axios.get(`${api(invoiceId)}/label-status/`);
      applyStatus(data);
      return data;
    } catch (err) {
      setLoadError(errText(err, 'Could not load the label status for this entry.'));
      setStatus(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, [invoiceId, applyStatus]);

  useEffect(() => { load(); }, [load, refreshKey]);

  // An unconfirmed job from an earlier visit is asked about straight away.
  useEffect(() => {
    if (openJob && !confirmJob) setConfirmJob(openJob);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openJob?.id]);

  // Label field values (barcode, MRP, …) for every product on the entry, once per entry.
  const productKey = items.map((i) => i.product).join(',');
  useEffect(() => {
    if (!items.length) return undefined;
    let cancelled = false;
    const products = [...new Map(items.map((i) => [i.product, { id: i.product, name: i.product_name, barcode: i.barcode, mrp: i.mrp, sellingPrice: i.selling_price }])).values()];
    fetchLabelData(products).then((res) => {
      if (cancelled) return;
      const byId = {};
      for (const p of products) byId[p.id] = { fields: res.byProduct.get(p)?.fields || {} };
      setLabelData({ byId, store: res.store, logo: res.logo });
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productKey]);

  // Recent entries for the picker (the current / just-saved entry is preselected by the parent).
  useEffect(() => {
    if (hidePicker) return;
    axios.get('/api/purchase/invoices/', { params: { page_size: 50 } })
      .then((res) => setEntries((Array.isArray(res.data) ? res.data : res.data?.results || [])
        .map((e) => ({ id: e.id, invoice_number: e.invoice_number, supplier_name: e.supplier_name, purchase_date: e.purchase_date }))))
      .catch(() => {});
  }, [invoiceId, refreshKey, hidePicker]);

  // Lines the chosen template can't print (no barcode, value the format can't encode, …).
  const settings = bundle?.settings || {};
  const dpi = resolveCalibration(settings).dpi;
  const problems = useMemo(() => {
    const out = {};
    if (!template) return out;
    const ctx = { dpi: template.printer_type === 'a4' ? 0 : dpi, hasLogo: hasUsableLogo(labelData.logo) };
    for (const it of items) {
      const data = labelData.byId[it.product];
      if (!data) continue;
      const res = renderLabelHtml(template, {
        fields: data.fields, store: labelData.store,
        job: { batch_no: it.batch_number || undefined, expiry_date: it.expiry_date || undefined },
      }, ctx);
      const blocking = summarizeWarnings(res.warnings).find((w) => w.level === 'error' && (w.kind === 'barcode' || w.kind === 'required'));
      if (blocking) out[it.id] = blocking.message;
    }
    return out;
  }, [items, template, labelData, dpi]);

  const pendingItems = items.filter((i) => i.pending > 0);
  const printedItems = items.filter((i) => i.printed > 0 || i.over_printed > 0);
  const selectable = pendingItems.filter((i) => !problems[i.id]);
  const reprintable = printedItems.filter((i) => !problems[i.id]);
  const printLines = buildPrintLines(selectable, selected);
  const reprintLines = buildReprintLines(printedItems, reprint);
  const allPending = selectable.length > 0 && selectable.every((i) => selected[i.id] != null);
  const allPrinted = reprintable.length > 0 && reprintable.every((i) => reprint[i.id]);

  const togglePending = (it, on) => setSelected((cur) => {
    const next = { ...cur };
    if (on) next[it.id] = it.pending; else delete next[it.id];
    return next;
  });
  const toggleReprint = (it, on) => setReprint((cur) => {
    const next = { ...cur };
    if (on) next[it.id] = { from: 1, to: it.printed }; else delete next[it.id];
    return next;
  });

  const runPrint = async (lines) => printLabelJob({
    template,
    rows: printRows(lines, items, labelData.byId),
    settings, store: labelData.store, logo: labelData.logo,
  });

  const handlePrint = () => {
    if (!template) { notify('No label template — create one in Settings → Barcode Labels.', 'error'); return; }
    if (openJob) { setConfirmJob(openJob); return; }
    if (printLines.length) setPrePrint({ kind: 'PRINT', lines: printLines });
  };

  const handleReprint = (lines = reprintLines) => {
    if (!template) { notify('No label template — create one in Settings → Barcode Labels.', 'error'); return; }
    if (lines.length) setPrePrint({ kind: 'REPRINT', lines });
  };

  const doPrint = async (printLines) => {
    setBusy(true);
    try {
      // Record the job before anything reaches the printer, so it is asked about even if
      // this tab closes mid-print.
      let job;
      try {
        ({ data: job } = await axios.post(`${api(invoiceId)}/label-jobs/`, { kind: 'PRINT', lines: printLines, template_name: template.name }));
      } catch (err) {
        notify(errText(err, 'Could not start the print job.'), 'error');
        if (err?.response?.status === 409) await load();
        return;
      }
      const res = await runPrint(job.lines);
      if (!res.printed) {
        // Nothing reached the print dialog (pop-up blocked …): close the job as not printed.
        await axios.post(`${api(invoiceId)}/label-jobs/${job.id}/confirm/`, { outcome: 'NONE' }).catch(() => {});
        notify(res.error || 'Nothing was printed.', 'error');
        await load();
        return;
      }
      if (res.failed.length) notify(`${res.failed.length} label(s) could not be rendered: ${res.failed[0].reason}. Count only the labels that came out.`, 'warning');
      setStatus((st) => (st ? { ...st, open_job: job } : st));
      setConfirmJob(job);
    } finally {
      setBusy(false);
    }
  };

  const doReprint = async (reprintLines) => {
    setBusy(true);
    try {
      const res = await runPrint(reprintLines);
      if (!res.printed) { notify(res.error || 'Nothing was printed.', 'error'); return; }
      try {
        await axios.post(`${api(invoiceId)}/label-jobs/`, { kind: 'REPRINT', lines: reprintLines, template_name: template.name });
      } catch (err) {
        notify(`Labels sent, but the reprint wasn't logged: ${errText(err, 'server error')}`, 'warning');
      }
      notify(`Sent ${res.printed} reprint label${res.printed === 1 ? '' : 's'} to the printer.`, 'success');
      await load();
    } finally {
      setBusy(false);
    }
  };

  const entryValue = entries.find((e) => e.id === invoiceId)
    || (status?.invoice ? { id: status.invoice.id, invoice_number: status.invoice.invoice_number, supplier_name: status.invoice.supplier_name } : null);
  const totals = status?.totals;

  return (
    <Card variant="outlined" sx={{ mt: 2, p: 2, ...sx }} data-testid="purchase-barcode-printing">
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1.5} alignItems={{ md: 'center' }} sx={{ mb: 1.5 }}>
        <Stack direction="row" spacing={1} alignItems="center" sx={{ mr: 'auto' }}>
          <LabelIcon color="primary" />
          <Box>
            <Typography variant="subtitle1" fontWeight={800}>Barcode Printing</Typography>
            <Typography variant="caption" color="text.secondary">Labels per line = purchased + free qty. Printing resumes from the last confirmed label.</Typography>
          </Box>
        </Stack>
        {!hidePicker && <Autocomplete size="small" sx={{ minWidth: 280 }} options={entries} value={entryValue}
          isOptionEqualToValue={(o, v) => o.id === v.id}
          getOptionLabel={(o) => `${o.invoice_number}${o.supplier_name ? ` — ${o.supplier_name}` : ''}`}
          onChange={(e, v) => onInvoiceChange?.(v?.id || '')}
          renderInput={(params) => <TextField {...params} label="Purchase entry" placeholder="Pick a saved entry" />} />}
        {invoiceId && (
          <TextField select size="small" label="Label template" sx={{ minWidth: 220 }} value={template?.id || ''} onChange={(e) => setTemplateId(e.target.value)}>
            {templates.map((t) => <MenuItem key={t.id} value={t.id}>{t.name} — {t.width_mm} × {t.height_mm} mm{t.printer_type === 'a4' ? ' (A4)' : ''}</MenuItem>)}
          </TextField>
        )}
        {invoiceId && <Tooltip title="Refresh"><span><IconButton onClick={load} disabled={loading}><RefreshIcon /></IconButton></span></Tooltip>}
      </Stack>
      {(loading || bundleLoading) && <LinearProgress sx={{ mb: 1 }} />}

      {!invoiceId && (
        <Alert severity="info">Save the purchase entry (or pick a saved one above) to print and track its barcode labels.</Alert>
      )}
      {loadError && <Alert severity="error" sx={{ mb: 1 }}>{loadError}</Alert>}
      {bundleError && <Alert severity="warning" sx={{ mb: 1 }}>{bundleError}</Alert>}

      {status && (
        <>
          <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ mb: 1 }}>
            <Chip size="small" label={`${status.invoice.invoice_number}${status.invoice.supplier_name ? ` · ${status.invoice.supplier_name}` : ''}`} />
            <Chip size="small" variant="outlined" label={`${totals.labels} labels`} />
            <Chip size="small" color="success" variant="outlined" label={`${totals.printed} printed`} />
            <Chip size="small" color={totals.pending ? 'warning' : 'default'} variant="outlined" label={`${totals.pending} pending`} />
          </Stack>
          {openJob && (
            <Alert severity="warning" sx={{ mb: 1 }} action={<Button color="inherit" size="small" onClick={() => setConfirmJob(openJob)}>Confirm now</Button>}>
              A print job of {openJob.labels_sent} labels ({fmtDate(openJob.created_at)}) is waiting for confirmation. Confirm how many printed before printing more.
            </Alert>
          )}

          <Tabs value={tab} onChange={(e, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', mb: 1 }}>
            <Tab value="pending" label={`Unprinted (${pendingItems.length})`} data-testid="labels-tab-pending" />
            <Tab value="printed" label={`Printed (${printedItems.length})`} data-testid="labels-tab-printed" />
            <Tab value="history" label="Print history" />
          </Tabs>

          {tab === 'pending' && (
            pendingItems.length === 0 ? (
              <Alert severity="success">{items.length ? 'All labels for this entry are printed. Use the Printed tab to reprint.' : 'This entry has no items.'}</Alert>
            ) : (
              <TableContainer sx={{ maxHeight: 420, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox">
                        <Tooltip title="Select all pending items">
                          <Checkbox size="small" checked={allPending} indeterminate={!allPending && printLines.length > 0} data-testid="labels-select-all"
                            onChange={(e) => setSelected(e.target.checked ? Object.fromEntries(selectable.map((i) => [i.id, i.pending])) : {})} />
                        </Tooltip>
                      </TableCell>
                      <TableCell>#</TableCell>
                      <TableCell>Product</TableCell>
                      <TableCell>Barcode</TableCell>
                      <TableCell>Batch / Expiry</TableCell>
                      <TableCell align="right">MRP</TableCell>
                      <TableCell align="right">Total</TableCell>
                      <TableCell align="right">Printed</TableCell>
                      <TableCell align="right">Pending</TableCell>
                      <TableCell width={110}>Print now</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {pendingItems.map((it) => {
                      const problem = problems[it.id];
                      const on = selected[it.id] != null && !problem;
                      return (
                        <TableRow key={it.id} hover selected={on} data-testid="labels-pending-row">
                          <TableCell padding="checkbox">
                            <Checkbox size="small" checked={on} disabled={Boolean(problem)} onChange={(e) => togglePending(it, e.target.checked)} />
                          </TableCell>
                          <TableCell>{items.indexOf(it) + 1}</TableCell>
                          <TableCell sx={{ maxWidth: 260 }}>
                            <Typography variant="body2" fontWeight={600} noWrap>{it.product_name}</Typography>
                            {details(it) && <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{details(it)}</Typography>}
                          </TableCell>
                          <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                            {it.barcode || <i>none</i>}
                            {problem && <Tooltip title={problem}><WarningAmber color="error" fontSize="small" sx={{ ml: 0.5, verticalAlign: 'middle' }} /></Tooltip>}
                          </TableCell>
                          <TableCell sx={{ fontSize: 12 }}>{it.batch_number || '—'}{it.expiry_date ? ` · ${it.expiry_date}` : ''}</TableCell>
                          <TableCell align="right">{it.mrp ? `${formatCurrency(it.mrp)}` : '—'}</TableCell>
                          <TableCell align="right">{it.total}</TableCell>
                          <TableCell align="right">{it.printed}</TableCell>
                          <TableCell align="right">
                            <Typography variant="body2" fontWeight={700} color="warning.main">{it.pending}</Typography>
                            {it.printed > 0 && <Typography variant="caption" color="text.secondary" noWrap>from unit {it.next_unit}</Typography>}
                          </TableCell>
                          <TableCell>
                            <TextField size="small" type="number" value={on ? selected[it.id] : ''} placeholder={String(it.pending)} disabled={!on}
                              inputProps={{ min: 1, max: it.pending, style: { width: 64 } }}
                              onChange={(e) => setSelected((cur) => ({ ...cur, [it.id]: Math.max(1, Math.min(it.pending, parseInt(e.target.value, 10) || 1)) }))} />
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )
          )}

          {tab === 'printed' && (
            printedItems.length === 0 ? (
              <Alert severity="info">Nothing printed yet for this entry.</Alert>
            ) : (
              <TableContainer sx={{ maxHeight: 420, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell padding="checkbox">
                        <Checkbox size="small" checked={allPrinted} indeterminate={!allPrinted && reprintLines.length > 0}
                          onChange={(e) => setReprint(e.target.checked ? Object.fromEntries(reprintable.map((i) => [i.id, { from: 1, to: i.printed }])) : {})} />
                      </TableCell>
                      <TableCell>#</TableCell>
                      <TableCell>Product</TableCell>
                      <TableCell>Barcode</TableCell>
                      <TableCell>Batch / Expiry</TableCell>
                      <TableCell align="right">Printed</TableCell>
                      <TableCell width={200}>Reprint units</TableCell>
                      <TableCell align="right">Action</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {printedItems.map((it) => {
                      const r = reprint[it.id];
                      const set = (k, v) => setReprint((cur) => ({ ...cur, [it.id]: { ...cur[it.id], [k]: Math.max(1, Math.min(it.printed, parseInt(v, 10) || 1)) } }));
                      return (
                        <TableRow key={it.id} hover selected={Boolean(r)} data-testid="labels-printed-row">
                          <TableCell padding="checkbox">
                            <Checkbox size="small" checked={Boolean(r)} disabled={Boolean(problems[it.id]) || !it.printed} onChange={(e) => toggleReprint(it, e.target.checked)} />
                          </TableCell>
                          <TableCell>{items.indexOf(it) + 1}</TableCell>
                          <TableCell sx={{ maxWidth: 260 }}>
                            <Typography variant="body2" fontWeight={600} noWrap>{it.product_name}</Typography>
                            {details(it) && <Typography variant="caption" color="text.secondary" noWrap sx={{ display: 'block' }}>{details(it)}</Typography>}
                          </TableCell>
                          <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{it.barcode || <i>none</i>}</TableCell>
                          <TableCell sx={{ fontSize: 12 }}>{it.batch_number || '—'}{it.expiry_date ? ` · ${it.expiry_date}` : ''}</TableCell>
                          <TableCell align="right">
                            {it.printed} / {it.total}
                            {it.over_printed > 0 && (
                              <Tooltip title={`${it.over_printed} more label(s) were printed before the quantity was reduced`}>
                                <Chip size="small" color="warning" label={`+${it.over_printed}`} sx={{ ml: 0.5 }} />
                              </Tooltip>
                            )}
                          </TableCell>
                          <TableCell>
                            {r ? (
                              <Stack direction="row" spacing={0.5} alignItems="center">
                                <TextField size="small" type="number" value={r.from} inputProps={{ min: 1, max: it.printed, style: { width: 52 } }} onChange={(e) => set('from', e.target.value)} />
                                <Typography variant="body2">to</Typography>
                                <TextField size="small" type="number" value={r.to} inputProps={{ min: 1, max: it.printed, style: { width: 52 } }} onChange={(e) => set('to', e.target.value)} />
                              </Stack>
                            ) : <Typography variant="caption" color="text.secondary">units 1–{it.printed}</Typography>}
                          </TableCell>
                          <TableCell align="right">
                            <Tooltip title={problems[it.id] || (r ? `Re-print units ${r.from}–${r.to}` : `Re-print all ${it.printed} printed label(s)`)}>
                              <span>
                                <Button size="small" variant="outlined" color="secondary" startIcon={<ReprintIcon />} data-testid="labels-row-reprint"
                                  disabled={busy || !template || Boolean(problems[it.id]) || !it.printed}
                                  onClick={() => handleReprint(buildReprintLines([it], { [it.id]: r || { from: 1, to: it.printed } }))}>
                                  Re-print
                                </Button>
                              </span>
                            </Tooltip>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>
            )
          )}

          {tab === 'history' && (
            status.history.length === 0 ? <Alert severity="info">No labels printed from this entry yet.</Alert> : (
              <TableContainer sx={{ maxHeight: 360, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                <Table size="small" stickyHeader>
                  <TableHead>
                    <TableRow>
                      <TableCell>When</TableCell><TableCell>Type</TableCell><TableCell>Items</TableCell>
                      <TableCell align="right">Sent</TableCell><TableCell align="right">Printed</TableCell><TableCell>Status</TableCell><TableCell>Template / by</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {status.history.map((j) => (
                      <TableRow key={j.id}>
                        <TableCell sx={{ whiteSpace: 'nowrap', fontSize: 12 }}>{fmtDate(j.created_at)}</TableCell>
                        <TableCell>{j.kind === 'REPRINT' ? 'Reprint' : 'Print'}</TableCell>
                        <TableCell sx={{ fontSize: 12, maxWidth: 320 }}>
                          {j.lines.map((l) => `${l.product_name} (${l.from_unit}–${l.to_unit})`).join(', ')}
                        </TableCell>
                        <TableCell align="right">{j.labels_sent}</TableCell>
                        <TableCell align="right">{j.status === 'SENT' ? '—' : j.labels_printed}</TableCell>
                        <TableCell><Chip size="small" {...STATUS_CHIP[j.status]} /></TableCell>
                        <TableCell sx={{ fontSize: 12 }}>{j.template_name}{j.printed_by ? ` · ${j.printed_by}` : ''}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            )
          )}

          {Object.keys(problems).length > 0 && tab !== 'history' && (
            <Alert severity="warning" sx={{ mt: 1, py: 0 }}>
              {Object.keys(problems).length} line(s) can't print with “{template?.name}” — hover the red icon for why (e.g. no barcode).
            </Alert>
          )}

          {tab !== 'history' && (
            <Stack direction="row" spacing={1.5} justifyContent="flex-end" alignItems="center" sx={{ mt: 1.5 }}>
              {tab === 'pending' ? (
                <>
                  <Typography variant="body2" color="text.secondary">{printLines.length} item(s) · {jobSize(printLines)} label(s)</Typography>
                  <Button variant="contained" startIcon={<PrintIcon />} disabled={busy || !template || (!printLines.length && !openJob)} onClick={handlePrint} data-testid="labels-print-selected">
                    {busy ? 'Preparing…' : openJob ? 'Confirm previous job first' : `Print ${jobSize(printLines)} Label${jobSize(printLines) === 1 ? '' : 's'}`}
                  </Button>
                </>
              ) : (
                <>
                  <Typography variant="body2" color="text.secondary">{reprintLines.length} item(s) · {jobSize(reprintLines)} label(s)</Typography>
                  <Button variant="contained" color="secondary" startIcon={<ReprintIcon />} disabled={busy || !template || !reprintLines.length} onClick={() => handleReprint()} data-testid="labels-reprint-selected">
                    {busy ? 'Preparing…' : `Re-print ${jobSize(reprintLines)} Selected Label${jobSize(reprintLines) === 1 ? '' : 's'}`}
                  </Button>
                </>
              )}
            </Stack>
          )}
        </>
      )}

      {prePrint && (
        <PrePrintDialog
          kind={prePrint.kind}
          lines={prePrint.lines}
          items={items}
          onCancel={() => setPrePrint(null)}
          onConfirm={() => { const { kind, lines } = prePrint; setPrePrint(null); (kind === 'PRINT' ? doPrint : doReprint)(lines); }}
        />
      )}

      {confirmJob && (
        <ConfirmJobDialog
          invoiceId={invoiceId}
          job={confirmJob}
          items={items}
          onClose={() => setConfirmJob(null)}
          onConfirmed={(st) => { setConfirmJob(null); applyStatus(st); notify('Label progress saved.', 'success'); }}
        />
      )}
    </Card>
  );
}
