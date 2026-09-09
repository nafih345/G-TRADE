import React, { useState, useEffect, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Grid,
  ToggleButton, ToggleButtonGroup, FormControl, InputLabel, Select, MenuItem,
  RadioGroup, FormControlLabel, Radio, TextField, Checkbox, FormGroup, Typography,
  Alert, Divider, Stack, FormHelperText, ListSubheader
} from '@mui/material';
import {
  THERMAL_SIZES, A4_SHEET_LAYOUTS, BARCODE_TYPES, LABEL_STYLES, BARCODE_SIZES,
  BARCODE_CUSTOM_MIN, BARCODE_CUSTOM_MAX, clampBarcodeCustomPercent,
  CUSTOM_THERMAL_DEFAULTS, CUSTOM_A4_DEFAULTS, resolveLayout, getBarcodeTypeHint,
  getTotalLabelCount, getBarcodeScale, renderBarcodeMarkup, buildLabelInnerHtml,
  buildStyleBlock, buildThermalLabelCss, printBarcodeLabels,
  printThermalTestLabel, feedOneThermalLabel, resolveThermalCalibration,
  loadCustomLayouts, saveCustomLayout, deleteCustomLayout, getStartSkip
} from '../../utils/printBarcodeLabels';

const SETTINGS_STORAGE_KEY = 'optical_barcode_print_settings';

const DEFAULT_SETTINGS = {
  printerType: 'thermal',
  sizeId: 'roll_38x25',
  barcodeType: 'EAN13',
  barcodeSize: 'M',
  barcodeCustomScale: 100,
  customThermal: { ...CUSTOM_THERMAL_DEFAULTS },
  customA4: { ...CUSTOM_A4_DEFAULTS },
  // Thermal printer setup / calibration — independent of the roll size chosen.
  thermalPrinterName: '',
  thermalHOffsetMm: 0,
  thermalVOffsetMm: 0,
  thermalBarcodeHeightMm: 0,
  startPositionEnabled: false,
  startRow: 1,
  startCol: 1,
  skipLabels: 0,
  labelStyle: 'jewel',
  quantityMode: 'custom',
  customQuantity: 1,
  showBusinessName: true,
  showProductName: true,
  showBarcodeText: true,
  showPrice: true,
  showColour: true,
  showSize: true,
  showProductCode: false,
  showDiscountPrice: false,
  showExpiryBatch: false,
};

const EMPTY_EPHEMERAL = { discountPriceValue: '', expiryDate: '', batchNo: '', customBarcode: '' };

// Field editors shown when "Custom" size is picked, per printer type.
const CUSTOM_DIM_FIELDS = {
  thermal: [
    { key: 'widthMm', label: 'Label width (mm)' },
    { key: 'heightMm', label: 'Label height (mm)' },
    { key: 'gapMm', label: 'Label gap (mm)' },
  ],
  a4: [
    { key: 'widthMm', label: 'Label width (mm)' },
    { key: 'heightMm', label: 'Label height (mm)' },
    { key: 'cols', label: 'Columns', step: 1 },
    { key: 'rows', label: 'Rows', step: 1 },
    { key: 'marginTopMm', label: 'Top margin (mm)' },
    { key: 'marginLeftMm', label: 'Left margin (mm)' },
    { key: 'colGapMm', label: 'Column gap (mm)' },
    { key: 'rowGapMm', label: 'Row gap (mm)' },
  ],
};

const BARCODE_STANDARD_MAP = {
  'EAN-13': 'EAN13', EAN13: 'EAN13',
  'EAN-8': 'EAN8', EAN8: 'EAN8',
  CODE128: 'CODE128', 'CODE-128': 'CODE128',
  CODE39: 'CODE39', 'CODE-39': 'CODE39',
  'UPC-A': 'UPC', UPCA: 'UPC', UPC: 'UPC',
  'UPC-E': 'UPCE', UPCE: 'UPCE',
  QR: 'QRCODE', QRCODE: 'QRCODE', 'QR CODE': 'QRCODE', 'QR-CODE': 'QRCODE',
};

function mapBarcodeStandardToType(standard) {
  const key = String(standard || '').toUpperCase().trim();
  return BARCODE_STANDARD_MAP[key] || 'EAN13';
}

function getBusinessName() {
  try {
    const saved = JSON.parse(localStorage.getItem('optical_app_settings') || '{}');
    return saved.storeName || '';
  } catch {
    return '';
  }
}

// Old builds used thermal size ids like 'roll_50x25_1up' / '..._2up'. Those are
// gone (thermal is always 1-up now) — map anything unrecognised back to a preset
// so the dialog never opens stuck on a blank "Custom".
function normalizeThermalSizeId(id) {
  if (!id || String(id).startsWith('tpl:') || id === 'custom') return id;
  if (THERMAL_SIZES.some((s) => s.id === id)) return id;
  const m = String(id).match(/(\d+)x(\d+)/);
  if (m) {
    const hit = THERMAL_SIZES.find((s) => s.widthMm === +m[1] && s.heightMm === +m[2]);
    if (hit) return hit.id;
  }
  return 'roll_38x25';
}

function getInitialPersistedSettings() {
  const savedRaw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (savedRaw) {
    try {
      const merged = { ...DEFAULT_SETTINGS, ...JSON.parse(savedRaw) };
      merged.customThermal = { ...CUSTOM_THERMAL_DEFAULTS, ...(merged.customThermal || {}) };
      if ((merged.printerType || 'thermal') !== 'a4') {
        merged.sizeId = normalizeThermalSizeId(merged.sizeId);
      }
      return merged;
    } catch {}
  }
  // First-ever use: seed the barcode format from the store-wide preference set in Settings.
  try {
    const appSettings = JSON.parse(localStorage.getItem('optical_app_settings') || '{}');
    return { ...DEFAULT_SETTINGS, barcodeType: mapBarcodeStandardToType(appSettings.barcodeStandard) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Tiny map of the sheet showing which slots are skipped (grey), where printing
// resumes (filled) and the still-free slots (outlined). Hidden for very dense
// sheets where the cells would be unreadably small.
function StartPositionGrid({ rows, cols, skip }) {
  if (!rows || !cols || rows * cols > 260) return null;
  const cells = [];
  for (let i = 0; i < rows * cols; i += 1) {
    const isFirst = i === skip;
    const isUsed = i < skip;
    cells.push(
      <Box
        key={i}
        sx={{
          width: 15, height: 11, borderRadius: '2px',
          border: '1px solid',
          borderColor: isFirst ? 'primary.main' : isUsed ? 'transparent' : 'divider',
          bgcolor: isFirst ? 'primary.main' : isUsed ? 'action.disabledBackground' : 'transparent',
        }}
      />
    );
  }
  return (
    <Box
      sx={{
        display: 'grid', gap: '3px', my: 1,
        gridTemplateColumns: `repeat(${cols}, 15px)`,
        justifyContent: 'start',
      }}
    >
      {cells}
    </Box>
  );
}

// products is always an array — [product] for a single row's print action,
// or the selected rows for bulk print. The dialog doesn't need to know which.
export default function BarcodePrintDialog({ open, onClose, products }) {
  const [settings, setSettings] = useState(getInitialPersistedSettings);
  const [ephemeral, setEphemeral] = useState(EMPTY_EPHEMERAL);
  const [previewSymbol, setPreviewSymbol] = useState({ markup: '', error: null });
  const [printing, setPrinting] = useState(false);
  const [customLayouts, setCustomLayouts] = useState(loadCustomLayouts);
  const [templateName, setTemplateName] = useState('');

  const businessName = useMemo(() => getBusinessName(), [open]);
  const validProducts = useMemo(() => (products || []).filter((p) => p && p.barcode), [products]);
  const skippedCount = (products || []).length - validProducts.length;

  useEffect(() => {
    if (open) {
      setSettings(getInitialPersistedSettings());
      setEphemeral(EMPTY_EPHEMERAL);
      setCustomLayouts(loadCustomLayouts());
      setTemplateName('');
    }
  }, [open]);

  const fullSettings = { ...settings, ...ephemeral };
  const layout = resolveLayout(fullSettings);
  const totalCount = getTotalLabelCount(validProducts, fullSettings);

  const isCustomLike =
    fullSettings.sizeId === 'custom' || String(fullSettings.sizeId).startsWith('tpl:');
  const printerTemplates = customLayouts.filter(
    (t) => (t.printerType || 'thermal') === fullSettings.printerType
  );
  const activeTemplate = printerTemplates.find((t) => `tpl:${t.id}` === fullSettings.sizeId) || null;
  const presetOptions = fullSettings.printerType === 'a4' ? A4_SHEET_LAYOUTS : THERMAL_SIZES;
  // A 'tpl:' id whose template was deleted (or belongs to the other printer)
  // falls back to the plain custom editor so the Select never shows a blank.
  const sizeValue =
    presetOptions.some((o) => o.id === fullSettings.sizeId) || activeTemplate
      ? fullSettings.sizeId
      : 'custom';

  const isThermal = fullSettings.printerType !== 'a4';
  const thermalCalibration = resolveThermalCalibration(fullSettings);

  const startSkip = isThermal ? 0 : getStartSkip(layout, fullSettings, 'a4');
  const resumeRow = layout.cols ? Math.floor(startSkip / layout.cols) + 1 : 1;
  const resumeCol = layout.cols ? (startSkip % layout.cols) + 1 : 1;

  const barcodeScale = getBarcodeScale(fullSettings.barcodeSize, fullSettings.barcodeCustomScale);
  const previewCss = useMemo(
    () => (isThermal
      ? buildThermalLabelCss(layout, { barcodeScale, calibration: thermalCalibration, preview: true })
      : buildStyleBlock(layout, 'a4', barcodeScale)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [layout, isThermal, barcodeScale, thermalCalibration.hOffsetMm, thermalCalibration.vOffsetMm, thermalCalibration.barcodeHeightMm]
  );

  // On-screen preview scale.
  // Thermal: render the label at its TRUE aspect ratio, sized to fit the preview
  // box (~230px wide / ~190px tall). A4-tag: keep the old "make it a readable
  // size" heuristic.
  const PX_PER_MM = 3.7795;
  const previewScale = isThermal
    ? Math.min(230 / (layout.widthMm * PX_PER_MM), 190 / (layout.heightMm * PX_PER_MM))
    : Math.min(
        Math.max(1.5, Math.min(4, 170 / (layout.heightMm * 3.78))),
        300 / (layout.widthMm * 3.78)
      );

  // A manually typed value (single-product print only) overrides the product's
  // saved barcode / auto series for this batch — driving both the preview and
  // the actual print job (printBarcodeLabels reads settings.customBarcode).
  const trimmedCustomBarcode = (fullSettings.customBarcode || '').trim();
  const previewBarcodeValue =
    (validProducts.length === 1 && trimmedCustomBarcode) || validProducts[0]?.barcode || '';
  const previewProductForLabel =
    validProducts.length > 0 ? { ...validProducts[0], barcode: previewBarcodeValue } : null;

  useEffect(() => {
    let cancelled = false;
    if (!open || validProducts.length === 0) {
      setPreviewSymbol({ markup: '', error: null });
      return undefined;
    }
    renderBarcodeMarkup(fullSettings.barcodeType, previewBarcodeValue).then((result) => {
      if (!cancelled) setPreviewSymbol(result);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, validProducts, fullSettings.barcodeType, previewBarcodeValue]);

  // Keep the A4 start row/column inside the current layout's grid when the
  // sheet size (and therefore its row/column count) changes.
  useEffect(() => {
    if (fullSettings.printerType !== 'a4') return;
    setSettings((prev) => {
      const rows = Math.max(1, layout.rows || 1);
      const cols = Math.max(1, layout.cols || 1);
      const r = Math.min(Math.max(1, parseInt(prev.startRow, 10) || 1), rows);
      const c = Math.min(Math.max(1, parseInt(prev.startCol, 10) || 1), cols);
      if (r === prev.startRow && c === prev.startCol) return prev;
      return { ...prev, startRow: r, startCol: c };
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout.rows, layout.cols, fullSettings.printerType]);

  const updateSetting = (key, value) => {
    if (key in EMPTY_EPHEMERAL) {
      setEphemeral((prev) => ({ ...prev, [key]: value }));
      return;
    }
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      if (key === 'printerType') {
        next.sizeId = value === 'a4' ? A4_SHEET_LAYOUTS[0].id : THERMAL_SIZES[0].id;
      }
      return next;
    });
  };

  // Updates one dimension inside the custom-size bucket for the active printer type.
  // Editing while a saved template is selected detaches to a plain "Custom" edit
  // until the user explicitly saves it back via "Update".
  const updateCustomDim = (field, value) => {
    const bucket = settings.printerType === 'a4' ? 'customA4' : 'customThermal';
    setSettings((prev) => ({
      ...prev,
      sizeId: String(prev.sizeId).startsWith('tpl:') ? 'custom' : prev.sizeId,
      [bucket]: { ...prev[bucket], [field]: value },
    }));
  };

  // Picking an entry from the Sheet Layout / Roll Size dropdown. Saved templates
  // ('tpl:<id>') load their stored dimensions into the custom bucket.
  const handleSizeChange = (val) => {
    if (String(val).startsWith('tpl:')) {
      const tpl = customLayouts.find((t) => `tpl:${t.id}` === val);
      if (tpl) {
        const bucket = (tpl.printerType || 'thermal') === 'a4' ? 'customA4' : 'customThermal';
        setSettings((prev) => ({
          ...prev,
          printerType: tpl.printerType || prev.printerType,
          sizeId: val,
          [bucket]: { ...prev[bucket], ...tpl.dims },
        }));
      }
      return;
    }
    updateSetting('sizeId', val);
  };

  const handleSaveTemplate = () => {
    const name = templateName.trim();
    if (!name) return;
    const id =
      (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
      `tpl_${Date.now()}`;
    const dims = settings.printerType === 'a4' ? settings.customA4 : settings.customThermal;
    setCustomLayouts(
      saveCustomLayout({ id, name, printerType: settings.printerType, dims: { ...dims } })
    );
    setSettings((prev) => ({ ...prev, sizeId: `tpl:${id}` }));
    setTemplateName('');
  };

  const handleUpdateTemplate = () => {
    if (!activeTemplate) return;
    const dims = settings.printerType === 'a4' ? settings.customA4 : settings.customThermal;
    setCustomLayouts(
      saveCustomLayout({
        ...activeTemplate,
        printerType: settings.printerType,
        dims: { ...dims },
      })
    );
    setSettings((prev) => ({ ...prev, sizeId: `tpl:${activeTemplate.id}` }));
  };

  const handleDeleteTemplate = () => {
    if (!activeTemplate) return;
    setCustomLayouts(deleteCustomLayout(activeTemplate.id));
    setSettings((prev) => ({ ...prev, sizeId: 'custom' }));
  };

  const handlePrintTestLabel = async () => {
    setPrinting(true);
    try {
      await printThermalTestLabel(fullSettings, businessName, validProducts[0] || null);
    } finally {
      setPrinting(false);
    }
  };

  const handleFeedLabel = () => {
    feedOneThermalLabel(fullSettings);
  };

  const handlePrint = async () => {
    setPrinting(true);
    try {
      const { printed } = await printBarcodeLabels(validProducts, fullSettings, businessName);
      if (printed > 0) {
        // Reset the "resume on a partial sheet" offset — that sheet has now been
        // consumed, so the next job should assume a fresh one unless told otherwise.
        const persisted = {
          ...settings,
          startPositionEnabled: false, startRow: 1, startCol: 1, skipLabels: 0,
        };
        setSettings(persisted);
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(persisted));
        onClose();
      }
    } finally {
      setPrinting(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 800 }}>Print Barcode Labels</DialogTitle>
      <DialogContent dividers>
        {skippedCount > 0 && (
          <Alert severity="warning" sx={{ mb: 2 }}>
            {skippedCount} product(s) skipped — no barcode assigned.
          </Alert>
        )}

        {validProducts.length === 0 ? (
          <Alert severity="info">No products with a barcode to print.</Alert>
        ) : (
          <Grid container spacing={3}>
            <Grid item xs={12} md={7}>
              <Stack spacing={2.5}>
                <Box>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>Printer Type</Typography>
                  <ToggleButtonGroup
                    exclusive
                    size="small"
                    value={fullSettings.printerType}
                    onChange={(e, val) => val && updateSetting('printerType', val)}
                  >
                    <ToggleButton value="thermal">Thermal Roll</ToggleButton>
                    <ToggleButton value="a4">A4 Sheet</ToggleButton>
                  </ToggleButtonGroup>
                </Box>

                <FormControl size="small" fullWidth>
                  <InputLabel>{fullSettings.printerType === 'a4' ? 'Sheet Layout' : 'Roll Size'}</InputLabel>
                  <Select
                    label={fullSettings.printerType === 'a4' ? 'Sheet Layout' : 'Roll Size'}
                    value={sizeValue}
                    onChange={(e) => handleSizeChange(e.target.value)}
                  >
                    {presetOptions.filter((o) => o.id !== 'custom').map((opt) => (
                      <MenuItem key={opt.id} value={opt.id}>{opt.label}</MenuItem>
                    ))}
                    {printerTemplates.length > 0 && (
                      <ListSubheader>Saved templates</ListSubheader>
                    )}
                    {printerTemplates.map((t) => (
                      <MenuItem key={t.id} value={`tpl:${t.id}`}>&#9733; {t.name}</MenuItem>
                    ))}
                    <MenuItem value="custom">
                      {fullSettings.printerType === 'a4' ? 'Custom sheet layout…' : 'Custom roll size…'}
                    </MenuItem>
                  </Select>
                </FormControl>

                {isCustomLike && (
                  <Box sx={{ p: 1.5, border: '1px dashed', borderColor: 'divider', borderRadius: 1 }}>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                      Enter the exact dimensions from your label sheet / roll (in millimetres).
                    </Typography>
                    <Grid container spacing={1.5}>
                      {CUSTOM_DIM_FIELDS[fullSettings.printerType].map((f) => {
                        const bucket = fullSettings.printerType === 'a4'
                          ? fullSettings.customA4 : fullSettings.customThermal;
                        return (
                          <Grid item xs={6} key={f.key}>
                            <TextField
                              size="small"
                              type="number"
                              fullWidth
                              label={f.label}
                              value={bucket?.[f.key] ?? ''}
                              onChange={(e) => updateCustomDim(f.key, e.target.value)}
                              inputProps={{ min: 0, step: f.step || 0.1 }}
                            />
                          </Grid>
                        );
                      })}
                    </Grid>
                    <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                      {layout.label}
                      {isThermal && (
                        <> — each label prints as its own {layout.widthMm}&nbsp;×&nbsp;{layout.heightMm}&nbsp;mm page.
                        {(layout.gapMm || 0) > 0
                          ? ` Gap adds ${layout.gapMm} mm below each label (die-cut liner gap).`
                          : ' Set the gap only if a die-cut roll drifts between labels.'}</>
                      )}
                    </Typography>

                    <Divider sx={{ my: 1.5 }} />
                    <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ display: 'block', mb: 1 }}>
                      {activeTemplate
                        ? `Editing saved template “${activeTemplate.name}”`
                        : 'Save this layout to reuse it later'}
                    </Typography>
                    <Stack direction="row" spacing={1} alignItems="flex-start" flexWrap="wrap" useFlexGap>
                      <TextField
                        size="small"
                        label="Template name"
                        value={templateName}
                        onChange={(e) => setTemplateName(e.target.value)}
                        sx={{ flex: '1 1 160px' }}
                      />
                      <Button
                        size="small"
                        variant="outlined"
                        onClick={handleSaveTemplate}
                        disabled={!templateName.trim()}
                        sx={{ mt: 0.25 }}
                      >
                        {activeTemplate ? 'Save as new' : 'Save template'}
                      </Button>
                      {activeTemplate && (
                        <Button size="small" variant="outlined" onClick={handleUpdateTemplate} sx={{ mt: 0.25 }}>
                          Update
                        </Button>
                      )}
                      {activeTemplate && (
                        <Button size="small" color="error" onClick={handleDeleteTemplate} sx={{ mt: 0.25 }}>
                          Delete
                        </Button>
                      )}
                    </Stack>
                  </Box>
                )}

                {/* THERMAL ROLL — printer setup + calibration. No A4 rows /
                    columns / start-position logic here. */}
                {isThermal && (
                  <Box sx={{ p: 1.5, border: '1px solid', borderColor: 'divider', borderRadius: 1 }}>
                    <Typography variant="subtitle2" fontWeight={700} gutterBottom>
                      Thermal Printer &amp; Calibration
                    </Typography>
                    <Stack spacing={1.5}>
                      <TextField
                        size="small"
                        fullWidth
                        label="Printer (for your reference)"
                        placeholder="e.g. TSC TE244 / Xprinter XP-365B"
                        value={fullSettings.thermalPrinterName || ''}
                        onChange={(e) => updateSetting('thermalPrinterName', e.target.value)}
                        helperText="Pick this exact printer in the browser print dialog when it opens."
                      />
                      <Stack direction="row" spacing={1.5}>
                        <TextField
                          size="small" type="number" fullWidth
                          label="Horizontal offset (mm)"
                          value={fullSettings.thermalHOffsetMm ?? 0}
                          onChange={(e) => updateSetting('thermalHOffsetMm', e.target.value)}
                          inputProps={{ step: 0.5 }}
                        />
                        <TextField
                          size="small" type="number" fullWidth
                          label="Vertical offset (mm)"
                          value={fullSettings.thermalVOffsetMm ?? 0}
                          onChange={(e) => updateSetting('thermalVOffsetMm', e.target.value)}
                          inputProps={{ step: 0.5 }}
                        />
                      </Stack>
                      <TextField
                        size="small" type="number" fullWidth
                        label="Barcode height (mm) — 0 = auto"
                        value={fullSettings.thermalBarcodeHeightMm ?? 0}
                        onChange={(e) => updateSetting('thermalBarcodeHeightMm', e.target.value)}
                        inputProps={{ min: 0, step: 0.5 }}
                        helperText="Forces an exact bar height. Leave 0 to size from the label."
                      />
                      <Stack direction="row" spacing={1.5} flexWrap="wrap" useFlexGap>
                        <Button size="small" variant="outlined" onClick={handlePrintTestLabel} disabled={printing}>
                          Print Test Label
                        </Button>
                        <Button size="small" variant="outlined" onClick={handleFeedLabel} disabled={printing}>
                          Feed One Label
                        </Button>
                      </Stack>
                      <Typography variant="caption" color="text.secondary">
                        Offsets nudge where the label prints on the stock without changing the design.
                        In the print dialog set <b>Margins: None</b>, <b>Scale: 100%</b> (not “Fit to page”)
                        and turn <b>off</b> headers &amp; footers.
                      </Typography>
                    </Stack>
                  </Box>
                )}

                {/* A4 SHEET — partial-sheet resume (rows / columns). */}
                {!isThermal && (
                  <Box>
                    <Stack direction="row" spacing={1.5} alignItems="center" sx={{ mb: 1 }}>
                      <Typography variant="subtitle2" fontWeight={700}>
                        Start Position
                      </Typography>
                      <ToggleButtonGroup
                        exclusive
                        size="small"
                        value={fullSettings.startPositionEnabled ? 'on' : 'off'}
                        onChange={(e, val) => val && updateSetting('startPositionEnabled', val === 'on')}
                      >
                        <ToggleButton value="off">Off</ToggleButton>
                        <ToggleButton value="on">On</ToggleButton>
                      </ToggleButtonGroup>
                    </Stack>

                    {!fullSettings.startPositionEnabled ? (
                      <Typography variant="caption" color="text.secondary">
                        Off — every job starts on a fresh sheet. Turn on to resume printing on a
                        partly-used label sheet.
                      </Typography>
                    ) : (
                      <>
                        <Stack direction="row" spacing={1.5}>
                          <TextField
                            select
                            size="small"
                            label="Start row"
                            value={Math.min(fullSettings.startRow || 1, layout.rows || 1)}
                            onChange={(e) => updateSetting('startRow', Number(e.target.value))}
                            sx={{ width: 120 }}
                          >
                            {Array.from({ length: layout.rows || 1 }, (_, i) => (
                              <MenuItem key={i} value={i + 1}>{i + 1}</MenuItem>
                            ))}
                          </TextField>
                          <TextField
                            select
                            size="small"
                            label="Start column"
                            value={Math.min(fullSettings.startCol || 1, layout.cols || 1)}
                            onChange={(e) => updateSetting('startCol', Number(e.target.value))}
                            sx={{ width: 120 }}
                          >
                            {Array.from({ length: layout.cols || 1 }, (_, i) => (
                              <MenuItem key={i} value={i + 1}>{i + 1}</MenuItem>
                            ))}
                          </TextField>
                        </Stack>
                        <StartPositionGrid rows={layout.rows} cols={layout.cols} skip={startSkip} />
                        <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                          {startSkip === 0
                            ? 'First label prints in the top-left cell.'
                            : `${startSkip} used label slot${startSkip === 1 ? '' : 's'} left blank; printing resumes at row ${resumeRow}, column ${resumeCol}.`}
                        </Typography>
                      </>
                    )}
                  </Box>
                )}

                <FormControl size="small" fullWidth error={!!previewSymbol.error}>
                  <InputLabel>Barcode Type</InputLabel>
                  <Select
                    label="Barcode Type"
                    value={fullSettings.barcodeType}
                    onChange={(e) => updateSetting('barcodeType', e.target.value)}
                  >
                    {BARCODE_TYPES.map((opt) => (
                      <MenuItem key={opt.id} value={opt.id}>{opt.label}</MenuItem>
                    ))}
                  </Select>
                  <FormHelperText>{getBarcodeTypeHint(fullSettings.barcodeType)}</FormHelperText>
                </FormControl>

                {previewSymbol.error && (
                  <Alert severity="warning" sx={{ py: 0.5 }}>
                    {previewSymbol.error} This product's barcode is{' '}
                    <b>{String(previewBarcodeValue || '').length} character(s)</b>. Choose{' '}
                    <b>Code 128</b> (accepts any value) or a matching format, or edit the product's barcode.
                  </Alert>
                )}

                <Box>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>Barcode Size</Typography>
                  <Stack direction="row" spacing={1.5} alignItems="center" flexWrap="wrap" useFlexGap>
                    <ToggleButtonGroup
                      exclusive
                      size="small"
                      value={fullSettings.barcodeSize || 'M'}
                      onChange={(e, val) => {
                        if (!val) return;
                        updateSetting('barcodeSize', val);
                        if (val === 'custom' && !fullSettings.barcodeCustomScale) {
                          updateSetting('barcodeCustomScale', 100);
                        }
                      }}
                    >
                      {BARCODE_SIZES.map((s) => (
                        <ToggleButton key={s.id} value={s.id}>{s.label.replace(/\s*\(default\)/, '')}</ToggleButton>
                      ))}
                      <ToggleButton value="custom" aria-label="Custom barcode size">+</ToggleButton>
                    </ToggleButtonGroup>

                    {fullSettings.barcodeSize === 'custom' && (
                      <TextField
                        size="small"
                        type="number"
                        label="Custom size"
                        value={fullSettings.barcodeCustomScale ?? 100}
                        onChange={(e) => updateSetting('barcodeCustomScale', e.target.value)}
                        onBlur={(e) => updateSetting('barcodeCustomScale', clampBarcodeCustomPercent(e.target.value))}
                        InputProps={{ endAdornment: <Typography variant="body2" color="text.secondary">%</Typography> }}
                        inputProps={{ min: BARCODE_CUSTOM_MIN, max: BARCODE_CUSTOM_MAX, step: 5 }}
                        sx={{ width: 130 }}
                      />
                    )}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 0.5 }}>
                    {fullSettings.barcodeSize === 'custom'
                      ? `Bar height as a percentage of normal (${BARCODE_CUSTOM_MIN}–${BARCODE_CUSTOM_MAX}%). 100% = Medium.`
                      : 'Adjusts how tall the barcode bars print on each label. Use + for an exact percentage.'}
                  </Typography>
                </Box>

                {layout.tag !== 'jewellery' && layout.tag !== 'rattail' && (
                  <Box>
                    <Typography variant="subtitle2" fontWeight={700} gutterBottom>Label Style</Typography>
                    <ToggleButtonGroup
                      exclusive
                      size="small"
                      value={fullSettings.labelStyle || 'jewel'}
                      onChange={(e, val) => val && updateSetting('labelStyle', val)}
                    >
                      {LABEL_STYLES.map((s) => (
                        <ToggleButton key={s.id} value={s.id}>{s.label}</ToggleButton>
                      ))}
                    </ToggleButtonGroup>
                  </Box>
                )}

                {validProducts.length === 1 && (
                  <TextField
                    size="small"
                    fullWidth
                    label="Barcode Value (manual override)"
                    placeholder={validProducts[0].barcode || 'Type a barcode'}
                    value={ephemeral.customBarcode}
                    onChange={(e) => updateSetting('customBarcode', e.target.value)}
                    InputLabelProps={{ shrink: true }}
                    helperText={
                      trimmedCustomBarcode
                        ? 'This exact value prints on every label in this batch (auto series is skipped).'
                        : "Leave blank to use the product's saved barcode."
                    }
                  />
                )}

                <Box>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>Quantity</Typography>
                  <RadioGroup
                    value={fullSettings.quantityMode}
                    onChange={(e) => updateSetting('quantityMode', e.target.value)}
                  >
                    <FormControlLabel value="stock" control={<Radio size="small" />} label="Based on Current Stock Quantity" />
                    <Stack direction="row" spacing={1.5} alignItems="center">
                      <FormControlLabel value="custom" control={<Radio size="small" />} label="Custom Quantity" />
                      <TextField
                        type="number"
                        size="small"
                        value={fullSettings.customQuantity}
                        onChange={(e) => updateSetting('customQuantity', e.target.value)}
                        disabled={fullSettings.quantityMode !== 'custom'}
                        inputProps={{ min: 1 }}
                        sx={{ width: 100 }}
                      />
                    </Stack>
                  </RadioGroup>
                </Box>

                <Divider />

                <Box>
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>Label Content</Typography>
                  <FormGroup>
                    <Grid container>
                      <Grid item xs={6}>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={fullSettings.showBusinessName} onChange={(e) => updateSetting('showBusinessName', e.target.checked)} />}
                          label="Shop Name"
                        />
                      </Grid>
                      <Grid item xs={6}>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={fullSettings.showProductName} onChange={(e) => updateSetting('showProductName', e.target.checked)} />}
                          label="Product Name"
                        />
                      </Grid>
                      <Grid item xs={6}>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={fullSettings.showBarcodeText} onChange={(e) => updateSetting('showBarcodeText', e.target.checked)} />}
                          label="Barcode Number"
                        />
                      </Grid>
                      <Grid item xs={6}>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={fullSettings.showPrice} onChange={(e) => updateSetting('showPrice', e.target.checked)} />}
                          label="Price / MRP"
                        />
                      </Grid>
                      <Grid item xs={6}>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={fullSettings.showColour} onChange={(e) => updateSetting('showColour', e.target.checked)} />}
                          label="Colour"
                        />
                      </Grid>
                      <Grid item xs={6}>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={fullSettings.showSize} onChange={(e) => updateSetting('showSize', e.target.checked)} />}
                          label="Size"
                        />
                      </Grid>
                      <Grid item xs={6}>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={fullSettings.showProductCode} onChange={(e) => updateSetting('showProductCode', e.target.checked)} />}
                          label="Product Code"
                        />
                      </Grid>
                      <Grid item xs={6}>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={fullSettings.showDiscountPrice} onChange={(e) => updateSetting('showDiscountPrice', e.target.checked)} />}
                          label="Discount / Offer Price"
                        />
                      </Grid>
                      <Grid item xs={6}>
                        <FormControlLabel
                          control={<Checkbox size="small" checked={fullSettings.showExpiryBatch} onChange={(e) => updateSetting('showExpiryBatch', e.target.checked)} />}
                          label="Expiry / Batch No"
                        />
                      </Grid>
                    </Grid>
                  </FormGroup>
                </Box>

                {fullSettings.showDiscountPrice && (
                  <TextField
                    label="Offer Price (applies to this print batch only)"
                    size="small"
                    type="number"
                    value={ephemeral.discountPriceValue}
                    onChange={(e) => updateSetting('discountPriceValue', e.target.value)}
                    fullWidth
                  />
                )}

                {fullSettings.showExpiryBatch && (
                  <Stack direction="row" spacing={1.5}>
                    <TextField
                      label="Expiry Date"
                      size="small"
                      type="date"
                      InputLabelProps={{ shrink: true }}
                      value={ephemeral.expiryDate}
                      onChange={(e) => updateSetting('expiryDate', e.target.value)}
                      fullWidth
                    />
                    <TextField
                      label="Batch No"
                      size="small"
                      value={ephemeral.batchNo}
                      onChange={(e) => updateSetting('batchNo', e.target.value)}
                      fullWidth
                    />
                  </Stack>
                )}
              </Stack>
            </Grid>

            <Grid item xs={12} md={5}>
              <Typography variant="subtitle2" fontWeight={700} gutterBottom>Label Preview</Typography>
              <Box
                sx={{
                  border: '1px dashed #94a3b8', borderRadius: 1, p: 2,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  bgcolor: '#f8fafc', minHeight: 210, overflow: 'hidden'
                }}
              >
                <style>{previewCss}</style>
                {isThermal ? (
                  // True-to-ratio thermal preview: a box at the real W:H ratio
                  // holding the actual .thermal-label scaled down to fit.
                  <Box
                    sx={{
                      width: layout.widthMm * 3.7795 * previewScale,
                      height: layout.heightMm * 3.7795 * previewScale,
                      position: 'relative',
                      boxShadow: '0 1px 6px rgba(15,23,42,0.18)',
                      bgcolor: '#fff',
                    }}
                  >
                    <Box
                      sx={{
                        transform: `scale(${previewScale})`,
                        transformOrigin: 'top left',
                        position: 'absolute', top: 0, left: 0,
                      }}
                      dangerouslySetInnerHTML={{
                        __html:
                          `<div class="thermal-label"><div class="tl-shift">` +
                          buildLabelInnerHtml(
                            previewProductForLabel, fullSettings, businessName,
                            previewSymbol.markup, previewSymbol.error, layout
                          ) +
                          `</div></div>`,
                      }}
                    />
                  </Box>
                ) : (
                  <Box
                    sx={{ transform: `scale(${previewScale})` }}
                    dangerouslySetInnerHTML={{
                      __html: buildLabelInnerHtml(
                        previewProductForLabel, fullSettings, businessName,
                        previewSymbol.markup, previewSymbol.error, layout
                      )
                    }}
                  />
                )}
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1, fontWeight: 700 }}>
                {isThermal
                  ? `Actual label: ${layout.widthMm} × ${layout.heightMm} mm`
                  : layout.label}
              </Typography>
              {isThermal && (layout.gapMm || 0) > 0 && (
                <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>
                  + {layout.gapMm} mm gap between labels — page height {(+layout.heightMm + +layout.gapMm)} mm.
                </Typography>
              )}
              {fullSettings.sizeId === 'a4_80up' && (
                <Alert severity="info" sx={{ mt: 1, py: 0 }}>
                  80-up dimensions vary by vendor — verify against your label sheet packaging before a large run.
                </Alert>
              )}
              {layout.tag === 'jewellery' && (
                <Alert severity="info" sx={{ mt: 1, py: 0 }}>
                  Dumbbell tags: barcode prints on the left wing, price on the right. Fold along the
                  centre tie-bridge (the non-adhesive strip) around the frame or chain — the gummed
                  wings stick to each other, not to the item.
                </Alert>
              )}
              {layout.tag === 'rattail' && (
                <Alert severity="info" sx={{ mt: 1, py: 0 }}>
                  Rat-tail tag — one borderless strip in three sections: <b>barcode</b>, then
                  {' '}<b>price + colour / size / barcode-number</b>, then a <b>blank tail</b>. The A4
                  layout tiles the full sheet (2 &times; 21 = 42 tags). Fold the two printed panels
                  back-to-back at the crease; thread the blank tail through the ring, chain or hinge.
                </Alert>
              )}
            </Grid>
          </Grid>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button
          variant="contained"
          disabled={totalCount === 0 || printing || !!previewSymbol.error}
          onClick={handlePrint}
        >
          {printing ? 'Preparing...' : `Print ${totalCount} Label${totalCount === 1 ? '' : 's'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
