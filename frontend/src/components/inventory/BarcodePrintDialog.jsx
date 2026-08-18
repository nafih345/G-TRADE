import React, { useState, useEffect, useMemo } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Button, Box, Grid,
  ToggleButton, ToggleButtonGroup, FormControl, InputLabel, Select, MenuItem,
  RadioGroup, FormControlLabel, Radio, TextField, Checkbox, FormGroup, Typography,
  Alert, Divider, Stack
} from '@mui/material';
import {
  THERMAL_SIZES, A4_SHEET_LAYOUTS, BARCODE_TYPES,
  getLayout, getTotalLabelCount, renderBarcodeMarkup, buildLabelInnerHtml,
  buildStyleBlock, printBarcodeLabels
} from '../../utils/printBarcodeLabels';

const SETTINGS_STORAGE_KEY = 'optical_barcode_print_settings';

const DEFAULT_SETTINGS = {
  printerType: 'thermal',
  sizeId: 'roll_38x25_1up',
  barcodeType: 'EAN13',
  quantityMode: 'custom',
  customQuantity: 1,
  showBusinessName: true,
  showProductName: true,
  showBarcodeText: true,
  showPrice: true,
  showDiscountPrice: false,
  showExpiryBatch: false,
};

const EMPTY_EPHEMERAL = { discountPriceValue: '', expiryDate: '', batchNo: '' };

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

function getInitialPersistedSettings() {
  const savedRaw = localStorage.getItem(SETTINGS_STORAGE_KEY);
  if (savedRaw) {
    try {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(savedRaw) };
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

// products is always an array — [product] for a single row's print action,
// or the selected rows for bulk print. The dialog doesn't need to know which.
export default function BarcodePrintDialog({ open, onClose, products }) {
  const [settings, setSettings] = useState(getInitialPersistedSettings);
  const [ephemeral, setEphemeral] = useState(EMPTY_EPHEMERAL);
  const [previewSymbol, setPreviewSymbol] = useState({ markup: '', error: null });
  const [printing, setPrinting] = useState(false);

  const businessName = useMemo(() => getBusinessName(), [open]);
  const validProducts = useMemo(() => (products || []).filter((p) => p && p.barcode), [products]);
  const skippedCount = (products || []).length - validProducts.length;

  useEffect(() => {
    if (open) {
      setSettings(getInitialPersistedSettings());
      setEphemeral(EMPTY_EPHEMERAL);
    }
  }, [open]);

  const fullSettings = { ...settings, ...ephemeral };
  const layout = getLayout(fullSettings.printerType, fullSettings.sizeId);
  const sizeOptions = fullSettings.printerType === 'a4' ? A4_SHEET_LAYOUTS : THERMAL_SIZES;
  const totalCount = getTotalLabelCount(validProducts, fullSettings);
  const previewCss = useMemo(() => buildStyleBlock(layout, fullSettings.printerType), [layout, fullSettings.printerType]);
  // Scale each label up to a roughly consistent on-screen size regardless of
  // its true mm dimensions (25mm thermal vs 13.5mm A4-80up render very differently otherwise).
  const previewScale = Math.max(1.5, Math.min(4, 170 / (layout.heightMm * 3.78)));

  useEffect(() => {
    let cancelled = false;
    if (!open || validProducts.length === 0) {
      setPreviewSymbol({ markup: '', error: null });
      return undefined;
    }
    renderBarcodeMarkup(fullSettings.barcodeType, validProducts[0].barcode).then((result) => {
      if (!cancelled) setPreviewSymbol(result);
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, validProducts, fullSettings.barcodeType]);

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

  const handlePrint = async () => {
    setPrinting(true);
    try {
      const { printed } = await printBarcodeLabels(validProducts, fullSettings, businessName);
      if (printed > 0) {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
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
                    value={fullSettings.sizeId}
                    onChange={(e) => updateSetting('sizeId', e.target.value)}
                  >
                    {sizeOptions.map((opt) => (
                      <MenuItem key={opt.id} value={opt.id}>{opt.label}</MenuItem>
                    ))}
                  </Select>
                </FormControl>

                <FormControl size="small" fullWidth>
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
                </FormControl>

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
                  bgcolor: '#f8fafc', height: 210, overflow: 'hidden'
                }}
              >
                <style>{previewCss}</style>
                <Box
                  sx={{ transform: `scale(${previewScale})` }}
                  dangerouslySetInnerHTML={{
                    __html: buildLabelInnerHtml(
                      validProducts[0], fullSettings, businessName,
                      previewSymbol.markup, previewSymbol.error
                    )
                  }}
                />
              </Box>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>
                {layout.label}
              </Typography>
              {fullSettings.sizeId === 'a4_80up' && (
                <Alert severity="info" sx={{ mt: 1, py: 0 }}>
                  80-up dimensions vary by vendor — verify against your label sheet packaging before a large run.
                </Alert>
              )}
            </Grid>
          </Grid>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" disabled={totalCount === 0 || printing} onClick={handlePrint}>
          {printing ? 'Preparing...' : `Print ${totalCount} Label${totalCount === 1 ? '' : 's'}`}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
