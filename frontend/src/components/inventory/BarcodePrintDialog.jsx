// Print Barcode Labels — used by Inventory → Products (row + bulk), the product barcode
// section, the variant master, Purchase → Purchase Entry and Barcode Printing.
//
// Pick a saved label template (the workflow's default is preselected), set quantities per
// product / variant, review what will print, then print. Every value on the label comes
// from the product record (POST /api/products/label-data/) — nothing is typed except the
// optional per-batch values (offer price, batch, expiry) when the template uses them.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Stack, TextField, MenuItem, Typography,
  Alert, Table, TableHead, TableRow, TableCell, TableBody, IconButton, Tooltip, Chip, ToggleButtonGroup,
  ToggleButton, CircularProgress, ListSubheader, LinearProgress,
} from '@mui/material';
import { Tune as TuneIcon, DeleteOutline, AccountTree, CheckCircle, ErrorOutline, WarningAmber } from '@mui/icons-material';
import useLabelBundle, { templateForWorkflow, WORKFLOWS } from '../../labels/useLabelBundle';
import { fetchLabelData, fetchVariantSiblings } from '../../labels/labelApi';
import { renderLabelHtml, labelCss, hasUsableLogo, summarizeWarnings } from '../../labels/renderLabel';
import { printLabelJob, resolveCalibration } from '../../labels/printLabels';
import { templateFieldIds, templateUsesRestricted, jobTotals, a4SheetCount, sheetUsage } from '../../labels/labelModel';
import { todayIso } from '../../labels/labelFields';
import { notify } from '../../utils/notify';

export const BARCODE_SETTINGS_HASH = '#/settings?tab=barcode-labels';
const PX_PER_MM = 96 / 25.4;
const rowKey = (p, i) => String(p?.id ?? `row-${i}`);

function StartPositionGrid({ rows, cols, skip }) {
  if (!rows || !cols || rows * cols > 260) return null;
  return (
    <Box sx={{ display: 'grid', gap: '3px', my: 1, gridTemplateColumns: `repeat(${cols}, 15px)` }}>
      {Array.from({ length: rows * cols }, (_, i) => (
        <Box key={i} sx={{
          width: 15, height: 11, borderRadius: '2px', border: '1px solid',
          borderColor: i === skip ? 'primary.main' : i < skip ? 'transparent' : 'divider',
          bgcolor: i === skip ? 'primary.main' : i < skip ? 'action.disabledBackground' : 'transparent',
        }} />
      ))}
    </Box>
  );
}

function LabelThumb({ template, html, css, maxW = 300, maxH = 200 }) {
  const W = template.width_mm * PX_PER_MM;
  const H = template.height_mm * PX_PER_MM;
  const k = Math.min(maxW / W, maxH / H, 6);
  return (
    <Box sx={{ width: W * k, height: H * k, position: 'relative', boxShadow: '0 1px 6px rgba(15,23,42,0.2)', bgcolor: '#fff', mx: 'auto' }}>
      <style>{css}</style>
      <Box sx={{ position: 'absolute', top: 0, left: 0, transform: `scale(${k})`, transformOrigin: '0 0' }} dangerouslySetInnerHTML={{ __html: html }} />
    </Box>
  );
}

// products: array of product objects. rows (optional, Purchase Entry): [{ product, qty, job }].
// template (optional): a template object to print with instead of the workflow default —
// the designer passes its current (possibly unsaved) design.
export default function BarcodePrintDialog({ open, onClose, products, rows: rowsInit, workflow = 'inventory', template: templateOverride }) {
  const { bundle, loading, error: bundleError, reload } = useLabelBundle(open);
  const [templateId, setTemplateId] = useState('');
  const [rows, setRows] = useState([]);
  const [store, setStore] = useState({});
  const [logo, setLogo] = useState('');
  const [restrictedIncluded, setRestrictedIncluded] = useState(false);
  const [dataLoading, setDataLoading] = useState(false);
  const [qtyMode, setQtyMode] = useState('custom');
  const [customQty, setCustomQty] = useState(1);
  const [job, setJob] = useState({ offer_price: '', batch_no: '', expiry_date: '', print_date: todayIso() });
  const [manualBarcode, setManualBarcode] = useState('');
  const [start, setStart] = useState({ enabled: false, row: 1, col: 1 });
  const [confirming, setConfirming] = useState(false);
  const [printing, setPrinting] = useState(false);

  const settings = bundle?.settings || {};
  const templates = bundle?.templates || [];
  const template = templateOverride && (!templateId || templateId === '__design')
    ? templateOverride
    : templates.find((t) => t.id === templateId) || templateForWorkflow(bundle, workflow);
  const workflowLabel = WORKFLOWS.find((w) => w.id === workflow)?.label;

  // ---- load rows + database values ------------------------------------------------
  useEffect(() => {
    if (!open) return;
    setConfirming(false);
    setManualBarcode('');
    setStart({ enabled: false, row: 1, col: 1 });
    setTemplateId(templateOverride ? '__design' : '');
    const init = rowsInit?.length
      ? rowsInit.map((r, i) => ({ key: `${rowKey(r.product, i)}-${i}`, product: r.product, qty: Math.max(0, Math.round(Number(r.qty) || 0)), purchaseQty: Math.max(0, Math.round(Number(r.qty) || 0)), job: r.job || {} }))
      : (products || []).filter(Boolean).map((p, i) => ({ key: rowKey(p, i), product: p, qty: 1, job: {} }));
    setQtyMode(rowsInit?.length ? 'purchase' : 'custom');
    setRows(init);
    let cancelled = false;
    setDataLoading(true);
    fetchLabelData(init.map((r) => r.product)).then((res) => {
      if (cancelled) return;
      setStore(res.store);
      setLogo(res.logo);
      setRestrictedIncluded(res.restrictedIncluded);
      setRows((cur) => cur.map((r) => {
        const d = res.byProduct.get(r.product) || {};
        return { ...r, data: { fields: d.fields || {} }, variantGroup: d.variantGroup, stock: d.stock ?? r.product?.stock };
      }));
    }).finally(() => { if (!cancelled) setDataLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (!open || rowsInit?.length) return;
    const q = Math.max(1, parseInt(settings.default_copies, 10) || 1);
    setCustomQty(q);
    setRows((cur) => cur.map((r) => ({ ...r, qty: q })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, settings.default_copies]);

  // Design changes saved in another tab (Label Settings) come back when this tab regains focus.
  useEffect(() => {
    if (!open) return undefined;
    const onFocus = () => reload();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [open, reload]);

  const applyQtyMode = (mode, value = customQty) => {
    setQtyMode(mode);
    setRows((cur) => cur.map((r) => ({
      ...r,
      qty: mode === 'stock' ? Math.max(0, parseInt(r.stock, 10) || 0)
        : mode === 'purchase' ? (r.purchaseQty ?? 0)
          : Math.max(0, parseInt(value, 10) || 0),
    })));
  };

  // ---- validation per row against the chosen template ------------------------------
  const cal = resolveCalibration(settings);
  const ctx = useMemo(() => ({ dpi: template?.printer_type === 'a4' ? 0 : cal.dpi, hasLogo: hasUsableLogo(logo) }), [template, cal.dpi, logo]);
  const jobValues = useMemo(() => Object.fromEntries(Object.entries(job).filter(([, v]) => v)), [job]);
  const checked = useMemo(() => {
    if (!template) return rows.map((r) => ({ ...r, warnings: [] }));
    return rows.map((r) => {
      if (!r.data) return { ...r, warnings: [] };
      const single = rows.length === 1 && manualBarcode.trim();
      const out = renderLabelHtml(template, {
        fields: r.data.fields, store, job: { ...jobValues, ...Object.fromEntries(Object.entries(r.job || {}).filter(([, v]) => v)) },
        barcodeOverride: single ? manualBarcode.trim() : undefined,
      }, ctx);
      const warnings = summarizeWarnings(out.warnings);
      const blocking = warnings.find((w) => w.level === 'error' && (w.kind === 'barcode' || w.kind === 'required'));
      return { ...r, html: out.html, warnings, skipReason: blocking?.message || '' };
    });
  }, [rows, template, store, jobValues, ctx, manualBarcode]);

  const totals = jobTotals(checked);
  const fieldIds = template ? templateFieldIds(template) : new Set();
  const isA4 = template?.printer_type === 'a4';
  const per = isA4 ? sheetUsage(template).perSheet : 1;
  const sheetRows = isA4 ? template.layout.sheet.rows : 0;
  const sheetCols = isA4 ? template.layout.sheet.cols : 0;
  const startSkip = isA4 && start.enabled ? (Math.min(start.row, sheetRows) - 1) * sheetCols + (Math.min(start.col, sheetCols) - 1) : 0;
  const previewRow = checked.find((r) => r.html && !r.skipReason) || checked.find((r) => r.html);
  const css = useMemo(() => labelCss({ logo }), [logo]);

  const addVariants = async (row) => {
    try {
      const sibs = await fetchVariantSiblings(row.variantGroup);
      const have = new Set(rows.map((r) => String(r.product?.id)));
      const fresh = sibs.filter((s) => !have.has(String(s.id)));
      if (!fresh.length) { notify('All variants of this product are already listed.', 'info'); return; }
      const res = await fetchLabelData(fresh);
      const q = qtyMode === 'custom' ? Math.max(0, parseInt(customQty, 10) || 0) : row.qty;
      setRows((cur) => {
        const idx = cur.findIndex((r) => r.key === row.key);
        const added = fresh.map((p, i) => {
          const d = res.byProduct.get(p) || {};
          return { key: `${p.id}-v${i}`, product: p, qty: qtyMode === 'stock' ? Math.max(0, d.stock || 0) : q, job: { ...row.job }, data: { fields: d.fields || {} }, variantGroup: d.variantGroup, stock: d.stock };
        });
        return [...cur.slice(0, idx + 1), ...added, ...cur.slice(idx + 1)];
      });
      notify(`Added ${fresh.length} variant${fresh.length === 1 ? '' : 's'}.`, 'success');
    } catch {
      notify('Could not load the variants for this product.', 'error');
    }
  };

  const openLabelSettings = () => {
    window.open(`${window.location.pathname}${window.location.search}${BARCODE_SETTINGS_HASH}`, '_blank');
  };

  const handlePrint = async () => {
    if (!confirming && (totals.labels > 1 || totals.skipped > 0)) { setConfirming(true); return; }
    setPrinting(true);
    try {
      const res = await printLabelJob({
        template,
        rows: checked.map((r) => ({ product: r.product, qty: r.qty, data: r.data, job: r.job, skipReason: r.skipReason })),
        settings, store, logo, job: jobValues,
        manualBarcode: rows.length === 1 ? manualBarcode : '',
        startSkip,
      });
      if (res.error && !res.printed) { notify(res.error, 'error'); return; }
      if (res.failed.length) notify(`${res.failed.length} label(s) not printed: ${res.failed[0].reason}`, 'warning');
      if (res.printed) {
        notify(`Sent ${res.printed} label${res.printed === 1 ? '' : 's'} to the printer.`, 'success');
        onClose();
      }
    } finally {
      setPrinting(false);
    }
  };

  const printerName = isA4 ? settings.a4_printer_name : settings.thermal_printer_name;
  const templateValue = templateOverride && (!templateId || templateId === '__design') ? '__design' : template?.id || '';

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle sx={{ fontWeight: 800, pb: 1 }}>
        Print Barcode Labels
        {workflowLabel && <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{workflowLabel}</Typography>}
      </DialogTitle>
      {(loading || dataLoading) && <LinearProgress />}
      <DialogContent dividers>
        {bundleError && <Alert severity="warning" sx={{ mb: 2 }}>{bundleError}</Alert>}
        {!template && !loading && <Alert severity="error">No label templates found. Create one in Settings → Barcode Labels.</Alert>}
        {template && (
          <Box sx={{ display: 'grid', gap: 3, gridTemplateColumns: { xs: '1fr', md: 'minmax(0,1.5fr) minmax(280px,1fr)' } }}>
            <Stack spacing={2} sx={{ minWidth: 0 }}>
              <TextField select size="small" label="Label template" value={templateValue} onChange={(e) => { setTemplateId(e.target.value); setConfirming(false); }} inputProps={{ 'data-testid': 'print-template-select' }}>
                {templateOverride && <MenuItem value="__design">Current design — {templateOverride.name || 'Untitled'} (as shown in the designer)</MenuItem>}
                {templateOverride && <ListSubheader>Saved templates</ListSubheader>}
                {templates.map((t) => (
                  <MenuItem key={t.id} value={t.id}>{t.is_default ? '★ ' : ''}{t.name} — {t.width_mm} × {t.height_mm} mm{t.printer_type === 'a4' ? ' (A4)' : ''} · v{t.version}</MenuItem>
                ))}
              </TextField>

              {confirming ? (
                <Box data-testid="print-confirm">
                  <Alert severity="info" sx={{ mb: 1.5 }}>
                    Ready to print <b>{totals.labels} label{totals.labels === 1 ? '' : 's'}</b> for <b>{totals.lines} line{totals.lines === 1 ? '' : 's'}</b>
                    {totals.variants ? ` (${totals.variants} variant${totals.variants === 1 ? '' : 's'})` : ''} with “{template.name}”
                    {isA4 ? ` on ${a4SheetCount(totals.labels, template, startSkip)} A4 sheet(s)` : ` on ${template.width_mm} × ${template.height_mm} mm thermal labels`}.
                    {totals.skipped ? ` ${totals.skipped} line(s) will be skipped.` : ''}
                  </Alert>
                  <Box sx={{ maxHeight: 340, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                    <Table size="small" stickyHeader>
                      <TableHead><TableRow><TableCell>Product / variant</TableCell><TableCell>Barcode</TableCell><TableCell align="right">Labels</TableCell></TableRow></TableHead>
                      <TableBody>
                        {checked.filter((r) => r.qty > 0 || r.skipReason).map((r) => (
                          <TableRow key={r.key} sx={r.skipReason ? { opacity: 0.6 } : undefined}>
                            <TableCell>{r.data?.fields?.product_name || r.product?.name}{r.data?.fields?.variant ? <Typography variant="caption" color="text.secondary"> · {r.data.fields.variant}</Typography> : null}</TableCell>
                            <TableCell sx={{ fontFamily: 'monospace' }}>{r.data?.fields?.barcode || '—'}</TableCell>
                            <TableCell align="right">{r.skipReason ? <Chip size="small" color="error" label="skipped" /> : r.qty}</TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </Box>
                </Box>
              ) : (
                <>
                  <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'center' }}>
                    <ToggleButtonGroup exclusive size="small" value={qtyMode} onChange={(e, v) => v && applyQtyMode(v)}>
                      {rowsInit?.length ? <ToggleButton value="purchase">Purchased qty</ToggleButton> : null}
                      <ToggleButton value="custom">Same for all</ToggleButton>
                      <ToggleButton value="stock">Current stock</ToggleButton>
                    </ToggleButtonGroup>
                    {qtyMode === 'custom' && (
                      <TextField size="small" type="number" label="Labels each" value={customQty} sx={{ width: 120 }} inputProps={{ min: 0, 'data-testid': 'qty-all' }}
                        onChange={(e) => { setCustomQty(e.target.value); applyQtyMode('custom', e.target.value); }} />
                    )}
                    <Typography variant="body2" color="text.secondary">Edit any row’s quantity below.</Typography>
                  </Stack>

                  <Box sx={{ maxHeight: 320, overflow: 'auto', border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                    <Table size="small" stickyHeader>
                      <TableHead>
                        <TableRow>
                          <TableCell>Product</TableCell>
                          <TableCell>Barcode / SKU</TableCell>
                          <TableCell width={90}>Qty</TableCell>
                          <TableCell width={44} />
                          <TableCell width={80} />
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {checked.map((r) => {
                          const worst = r.skipReason ? 'error' : r.warnings?.find((w) => w.level === 'warning') ? 'warning' : 'ok';
                          return (
                            <TableRow key={r.key} data-testid="print-row">
                              <TableCell sx={{ maxWidth: 260 }}>
                                <Typography variant="body2" fontWeight={600} noWrap>{r.data?.fields?.product_name || r.product?.name || '—'}</Typography>
                                {r.data?.fields?.variant && <Typography variant="caption" color="text.secondary">{r.data.fields.variant}</Typography>}
                                {r.job?.batch_no && <Typography variant="caption" color="text.secondary"> · Batch {r.job.batch_no}</Typography>}
                              </TableCell>
                              <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>
                                {r.data?.fields?.barcode || <i>none</i>}
                                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{r.data?.fields?.sku}</Typography>
                              </TableCell>
                              <TableCell>
                                <TextField size="small" type="number" value={r.qty} inputProps={{ min: 0, style: { width: 56 } }}
                                  onChange={(e) => setRows((cur) => cur.map((x) => (x.key === r.key ? { ...x, qty: Math.max(0, parseInt(e.target.value, 10) || 0) } : x)))} />
                              </TableCell>
                              <TableCell>
                                <Tooltip title={r.skipReason || r.warnings?.filter((w) => w.level !== 'info').map((w) => w.message).join(' · ') || 'Ready'}>
                                  {worst === 'error' ? <ErrorOutline color="error" fontSize="small" /> : worst === 'warning' ? <WarningAmber color="warning" fontSize="small" /> : <CheckCircle color="success" fontSize="small" />}
                                </Tooltip>
                              </TableCell>
                              <TableCell>
                                <Stack direction="row">
                                  {r.variantGroup && (
                                    <Tooltip title="Add this product’s other variants"><IconButton size="small" onClick={() => addVariants(r)} data-testid="add-variants"><AccountTree fontSize="small" /></IconButton></Tooltip>
                                  )}
                                  {rows.length > 1 && (
                                    <Tooltip title="Remove from this print"><IconButton size="small" onClick={() => setRows((cur) => cur.filter((x) => x.key !== r.key))}><DeleteOutline fontSize="small" /></IconButton></Tooltip>
                                  )}
                                </Stack>
                              </TableCell>
                            </TableRow>
                          );
                        })}
                      </TableBody>
                    </Table>
                  </Box>
                  {totals.skipped > 0 && (
                    <Alert severity="warning" sx={{ py: 0 }}>
                      {totals.skipped} line(s) can’t print with this template and will be skipped — hover the red icon for the reason
                      (e.g. no barcode, or a barcode the chosen format can’t encode).
                    </Alert>
                  )}

                  {(fieldIds.has('offer_price') || fieldIds.has('batch_no') || fieldIds.has('expiry_date')) && (
                    <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5}>
                      {fieldIds.has('offer_price') && <TextField size="small" type="number" label="Offer price (this batch)" value={job.offer_price} onChange={(e) => setJob((j) => ({ ...j, offer_price: e.target.value }))} />}
                      {fieldIds.has('batch_no') && <TextField size="small" label={rowsInit?.length ? 'Batch (rows without one)' : 'Batch no'} value={job.batch_no} onChange={(e) => setJob((j) => ({ ...j, batch_no: e.target.value }))} />}
                      {fieldIds.has('expiry_date') && <TextField size="small" type="date" label="Expiry" InputLabelProps={{ shrink: true }} value={job.expiry_date} onChange={(e) => setJob((j) => ({ ...j, expiry_date: e.target.value }))} />}
                    </Stack>
                  )}

                  {rows.length === 1 && (
                    <TextField size="small" label="Barcode value (manual override)" value={manualBarcode} onChange={(e) => setManualBarcode(e.target.value)}
                      placeholder={rows[0].data?.fields?.barcode || 'Type a barcode'} InputLabelProps={{ shrink: true }}
                      helperText={manualBarcode.trim() ? 'This exact value prints on every label and is registered to the product so it scans at billing.' : "Leave blank to use the product's saved barcode."} />
                  )}

                  {isA4 && (
                    <Box>
                      <Stack direction="row" spacing={1.5} alignItems="center">
                        <Typography variant="subtitle2" fontWeight={700}>Start position</Typography>
                        <ToggleButtonGroup exclusive size="small" value={start.enabled ? 'on' : 'off'} onChange={(e, v) => v && setStart((s) => ({ ...s, enabled: v === 'on' }))}>
                          <ToggleButton value="off">Fresh sheet</ToggleButton>
                          <ToggleButton value="on">Part-used sheet</ToggleButton>
                        </ToggleButtonGroup>
                      </Stack>
                      {start.enabled && (
                        <>
                          <Stack direction="row" spacing={1.5} sx={{ mt: 1 }}>
                            <TextField select size="small" label="Row" value={Math.min(start.row, sheetRows)} onChange={(e) => setStart((s) => ({ ...s, row: Number(e.target.value) }))} sx={{ width: 100 }}>
                              {Array.from({ length: sheetRows }, (_, i) => <MenuItem key={i} value={i + 1}>{i + 1}</MenuItem>)}
                            </TextField>
                            <TextField select size="small" label="Column" value={Math.min(start.col, sheetCols)} onChange={(e) => setStart((s) => ({ ...s, col: Number(e.target.value) }))} sx={{ width: 100 }}>
                              {Array.from({ length: sheetCols }, (_, i) => <MenuItem key={i} value={i + 1}>{i + 1}</MenuItem>)}
                            </TextField>
                          </Stack>
                          <StartPositionGrid rows={sheetRows} cols={sheetCols} skip={startSkip} />
                        </>
                      )}
                    </Box>
                  )}
                </>
              )}
            </Stack>

            <Box>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>Label preview</Typography>
              <Box sx={{ bgcolor: '#e2e8f0', borderRadius: 1, p: 2, minHeight: 160, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {previewRow?.html ? <LabelThumb template={template} html={previewRow.html} css={css} /> : (dataLoading ? <CircularProgress size={22} /> : <Typography variant="body2">Nothing to preview.</Typography>)}
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.75, fontWeight: 700 }}>
                Actual size: {template.width_mm} × {template.height_mm} mm{isA4 ? ` · ${per} per A4 sheet` : ''}{previewRow ? ` · ${previewRow.data?.fields?.product_name || ''}` : ''}
              </Typography>
              {previewRow?.warnings?.filter((w) => w.level !== 'info').slice(0, 4).map((w, i) => (
                <Alert key={i} severity={w.level === 'error' ? 'error' : 'warning'} sx={{ mt: 1, py: 0 }}>{w.message}</Alert>
              ))}
              {templateUsesRestricted(template) && !restrictedIncluded && (
                <Alert severity="info" sx={{ mt: 1, py: 0 }}>Wholesale / purchase prices are hidden for your role and won’t print.</Alert>
              )}
              <Alert severity="info" icon={false} sx={{ mt: 1.5, fontSize: 12 }}>
                In the print dialog choose <b>{printerName || (isA4 ? 'your A4 printer' : 'the label printer')}</b>, set <b>Margins: None</b>, <b>Scale: 100%</b> and turn off headers &amp; footers so labels print at their exact size.
              </Alert>
            </Box>
          </Box>
        )}
      </DialogContent>
      <DialogActions>
        <Button startIcon={<TuneIcon />} onClick={openLabelSettings} sx={{ mr: 'auto' }}>Edit label designs</Button>
        <Typography variant="body2" color="text.secondary" sx={{ mr: 1 }} data-testid="print-total">
          {totals.labels} label{totals.labels === 1 ? '' : 's'}{isA4 && totals.labels ? ` · ${a4SheetCount(totals.labels, template, startSkip)} sheet(s)` : ''}
        </Typography>
        {confirming ? <Button onClick={() => setConfirming(false)}>Back</Button> : <Button onClick={onClose}>Cancel</Button>}
        <Button variant="contained" disabled={!template || totals.labels === 0 || printing || dataLoading} onClick={handlePrint} data-testid="print-labels">
          {printing ? 'Preparing…' : confirming ? `Confirm & Print ${totals.labels}` : `Print ${totals.labels} Label${totals.labels === 1 ? '' : 's'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
