import React, { useState, useEffect, useCallback } from 'react';
import axios from 'axios';
import {
  Box, Typography, TextField, Button, Stack, IconButton, Tooltip,
  Dialog, DialogTitle, DialogContent, DialogActions, Alert, CircularProgress,
  List, ListItem, ListItemText, Divider, Collapse
} from '@mui/material';
import {
  QrCode as BarcodeIcon,
  AutoAwesome as GenerateIcon,
  Refresh as RegenerateIcon,
  ContentCopy as CopyIcon,
  Print as PrintIcon,
  Clear as ClearIcon,
  History as HistoryIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  CheckCircle as CheckIcon,
  Settings as SettingsIcon
} from '@mui/icons-material';
import { useDebounce } from '../../hooks/useDebounce';
import { renderBarcodeMarkup } from '../../utils/printBarcodeLabels';
import BarcodePrintDialog from './BarcodePrintDialog';
import BarcodeConfigDialog, { BARCODE_CONFIG_URL, describeSeries } from './BarcodeConfigDialog';
import { focusRelative } from '../../pages/wholesale/keyboardNav';

// The "Barcode" section from the spec: input + Generate/Regenerate/Copy/Print/Clear
// + a live preview that updates on every value change. Two modes:
//   - "create": operates on local unsaved state via value/onChange (no productId yet)
//   - "manage": operates on a persisted product via productId, saving through the API
export default function BarcodeSection({
  mode = 'create',
  value = '',
  onChange,
  productId,
  productName,
  productCode,
  productPrice,
  productStock,
  productColour,
  productSize,
  onSaved,
  // Optional second scan-in code (Product.secondary_barcode). Same create/manage
  // split as the primary: onSecondaryChange in create mode, saved via PATCH in manage.
  secondaryValue = '',
  onSecondaryChange,
  onSecondarySaved,
  // Inside a keyboardNav chain: Enter on an empty input generates a barcode, then
  // Enter / ↓ / ↑ move to the next / previous field like any other stop.
  keyboardNav = false,
  // Endpoint that mints the next barcode in create-mode (the configured series).
  generateUrl = '/api/products/items/next_barcode_candidate/'
}) {
  const [localValue, setLocalValue] = useState(value || '');
  const [checking, setChecking] = useState(false);
  const [duplicateInfo, setDuplicateInfo] = useState(null);
  const [busy, setBusy] = useState(false);
  const [previewSymbol, setPreviewSymbol] = useState({ markup: '', error: null });
  const [copied, setCopied] = useState(false);
  const [regenerateOpen, setRegenerateOpen] = useState(false);
  const [regenerateReason, setRegenerateReason] = useState('');
  const [printOpen, setPrintOpen] = useState(false);
  const [history, setHistory] = useState([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [seriesConfig, setSeriesConfig] = useState(null);
  const [configOpen, setConfigOpen] = useState(false);

  useEffect(() => {
    axios.get(BARCODE_CONFIG_URL).then((res) => setSeriesConfig(res.data)).catch(() => {});
  }, []);

  useEffect(() => {
    setLocalValue(value || '');
  }, [value]);

  const debouncedValue = useDebounce(localValue, 400);

  // Live duplicate validation ("Barcode already exists for another product").
  useEffect(() => {
    let cancelled = false;
    if (!debouncedValue) {
      setDuplicateInfo(null);
      return undefined;
    }
    const check = async () => {
      setChecking(true);
      try {
        const params = new URLSearchParams({ barcode: debouncedValue });
        if (mode === 'manage' && productId) params.set('exclude_id', productId);
        const res = await axios.get(`/api/products/items/check_barcode/?${params.toString()}`);
        if (!cancelled) setDuplicateInfo(res.data.exists ? res.data : null);
      } catch (e) {
        if (!cancelled) setDuplicateInfo(null);
      } finally {
        if (!cancelled) setChecking(false);
      }
    };
    check();
    return () => { cancelled = true; };
  }, [debouncedValue, mode, productId]);

  // Live preview — re-renders on every value change.
  useEffect(() => {
    let cancelled = false;
    if (!localValue) {
      setPreviewSymbol({ markup: '', error: null });
      return undefined;
    }
    renderBarcodeMarkup('CODE128', localValue).then((result) => {
      if (!cancelled) setPreviewSymbol(result);
    });
    return () => { cancelled = true; };
  }, [localValue]);

  const loadHistory = useCallback(async () => {
    if (mode !== 'manage' || !productId) return;
    try {
      const res = await axios.get(`/api/products/items/${productId}/barcode_history/`);
      setHistory(res.data);
    } catch (e) {}
  }, [mode, productId]);

  useEffect(() => { loadHistory(); }, [loadHistory]);

  const isDirty = localValue !== (value || '');
  const canSaveManualEntry = isDirty && !duplicateInfo && !checking;

  const applyNewValue = (newBarcode) => {
    setLocalValue(newBarcode || '');
    if (mode === 'create') {
      onChange && onChange(newBarcode || '');
    } else {
      onSaved && onSaved(newBarcode || '');
      loadHistory();
    }
  };

  const handleGenerate = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (mode === 'create') {
        const res = await axios.post(generateUrl);
        applyNewValue(res.data.barcode);
      } else {
        const res = await axios.post(`/api/products/items/${productId}/generate_barcode/`);
        applyNewValue(res.data.barcode);
      }
    } catch (e) {
      alert(e?.response?.data?.detail || 'Could not generate a barcode. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmRegenerate = async () => {
    setBusy(true);
    try {
      if (mode === 'create') {
        const res = await axios.post(generateUrl);
        applyNewValue(res.data.barcode);
      } else {
        const res = await axios.post(`/api/products/items/${productId}/generate_barcode/`, {
          force: true,
          reason: regenerateReason || 'Manual regeneration'
        });
        applyNewValue(res.data.barcode);
      }
    } catch (e) {
      alert(e?.response?.data?.detail || 'Could not regenerate the barcode.');
    } finally {
      setBusy(false);
      setRegenerateOpen(false);
      setRegenerateReason('');
    }
  };

  const handleClear = async () => {
    if (mode === 'create') {
      applyNewValue('');
      return;
    }
    if (!window.confirm('Clear this barcode? The product will not be scannable until a new one is generated.')) return;
    setBusy(true);
    try {
      await axios.patch(`/api/products/items/${productId}/`, { barcode: null });
      applyNewValue('');
    } catch (e) {
      alert('Could not clear the barcode.');
    } finally {
      setBusy(false);
    }
  };

  const handleSaveManualEntry = async () => {
    if (mode === 'create') {
      onChange && onChange(localValue);
      return;
    }
    setBusy(true);
    try {
      const res = await axios.patch(`/api/products/items/${productId}/`, { barcode: localValue || null });
      applyNewValue(res.data.barcode);
    } catch (e) {
      alert(e?.response?.data?.barcode?.[0] || 'Could not save the barcode.');
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!localValue) return;
    try {
      await navigator.clipboard.writeText(localValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (e) {}
  };

  const previewProduct = {
    id: productId || 'preview',
    name: productName || '',
    code: productCode || '',
    product_code: productCode || '',
    colour: productColour || '',
    size: productSize || '',
    barcode: localValue,
    sellingPrice: productPrice || 0,
    stock: productStock || 0
  };

  return (
    <Box>
      <Stack direction="row" alignItems="center" spacing={0.5} sx={{ mb: 1 }}>
        <Typography variant="subtitle2" fontWeight={700} sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
          <BarcodeIcon fontSize="small" color="action" /> Barcode
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small" variant="text" startIcon={<SettingsIcon fontSize="small" />}
          onClick={() => setConfigOpen(true)} sx={{ textTransform: 'none' }}
          tabIndex={keyboardNav ? -1 : undefined}
        >
          Barcode settings
        </Button>
      </Stack>
      {seriesConfig && describeSeries(seriesConfig) && (
        <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mb: 1 }}>
          “Generate” issues the next code in the series — {describeSeries(seriesConfig)}
          {seriesConfig.preview?.samples?.[0] ? ` (next: ${seriesConfig.preview.samples[0]})` : ''}.
        </Typography>
      )}

      <TextField
        fullWidth
        size="small"
        placeholder="Generate one, or scan / type a barcode"
        value={localValue}
        onChange={(e) => setLocalValue(e.target.value)}
        onBlur={() => { if (canSaveManualEntry) handleSaveManualEntry(); }}
        inputProps={keyboardNav ? { 'data-nav-own': '' } : undefined}
        onKeyDown={keyboardNav ? (e) => {
          if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
          if (e.key === 'Enter') {
            e.preventDefault();
            if (!localValue.trim()) handleGenerate();
            focusRelative(e.target, 1);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            focusRelative(e.target, e.key === 'ArrowDown' ? 1 : -1);
          }
        } : undefined}
        error={Boolean(duplicateInfo)}
        helperText={
          duplicateInfo
            ? `Barcode already exists for another product ('${duplicateInfo.product_name}').`
            : checking ? 'Checking availability…' : ' '
        }
        InputProps={{
          endAdornment: (
            <Stack direction="row" spacing={0.5} alignItems="center">
              {checking && <CircularProgress size={16} />}
              {!checking && !duplicateInfo && localValue && <CheckIcon fontSize="small" color="success" />}
              <Tooltip title={copied ? 'Copied!' : 'Copy barcode'}>
                <span>
                  <IconButton size="small" onClick={handleCopy} disabled={!localValue}>
                    <CopyIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Stack>
          )
        }}
      />

      <SecondaryBarcodeField
        mode={mode}
        productId={productId}
        primary={localValue}
        value={secondaryValue}
        onChange={onSecondaryChange}
        onSaved={(val) => { onSecondarySaved && onSecondarySaved(val); loadHistory(); }}
        keyboardNav={keyboardNav}
      />

      <Stack direction="row" spacing={1} flexWrap="wrap" sx={{ mt: 1.5, rowGap: 1 }}>
        <Button
          size="small" variant="contained" startIcon={<GenerateIcon />}
          onClick={handleGenerate} disabled={busy || Boolean(localValue)}
        >
          Generate Barcode
        </Button>
        <Button
          size="small" variant="outlined" startIcon={<RegenerateIcon />}
          onClick={() => setRegenerateOpen(true)} disabled={busy || !localValue}
        >
          Regenerate
        </Button>
        <Button
          size="small" variant="outlined" startIcon={<PrintIcon />}
          onClick={() => setPrintOpen(true)} disabled={!localValue}
        >
          Print
        </Button>
        <Button
          size="small" variant="text" color="error" startIcon={<ClearIcon />}
          onClick={handleClear} disabled={busy || !localValue}
        >
          Clear
        </Button>
      </Stack>

      <Box
        sx={{
          mt: 2, border: '1px dashed #94a3b8', borderRadius: 2, p: 2.5,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          bgcolor: '#f8fafc', minHeight: 110
        }}
      >
        {!localValue ? (
          <Typography variant="caption" color="text.secondary">No barcode yet — generate or enter one above</Typography>
        ) : previewSymbol.error ? (
          <Typography variant="caption" color="error">⚠ {previewSymbol.error}</Typography>
        ) : (
          <>
            <Box sx={{ '& svg': { maxWidth: '100%', height: 60 } }} dangerouslySetInnerHTML={{ __html: previewSymbol.markup }} />
            <Typography variant="body2" fontWeight={700} sx={{ mt: 0.5, letterSpacing: 1 }}>{localValue}</Typography>
          </>
        )}
      </Box>

      {mode === 'manage' && history.length > 0 && (
        <Box sx={{ mt: 1.5 }}>
          <Button
            size="small" onClick={() => setHistoryOpen(!historyOpen)}
            startIcon={<HistoryIcon />} endIcon={historyOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
            sx={{ textTransform: 'none' }}
          >
            History ({history.length})
          </Button>
          <Collapse in={historyOpen}>
            <List dense sx={{ bgcolor: '#f8fafc', borderRadius: 2, mt: 0.5 }}>
              {history.map((h, idx) => (
                <React.Fragment key={h.id}>
                  {idx > 0 && <Divider component="li" />}
                  <ListItem>
                    <ListItemText
                      primary={`${h.old_barcode || '(none)'} → ${h.new_barcode || '(cleared)'}`}
                      secondary={`${h.reason || ''} · ${h.changed_by || 'Administrator'} · ${new Date(h.created_at).toLocaleString()}`}
                    />
                  </ListItem>
                </React.Fragment>
              ))}
            </List>
          </Collapse>
        </Box>
      )}

      {/* Regenerate confirmation */}
      <Dialog open={regenerateOpen} onClose={() => setRegenerateOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Regenerate Barcode?</DialogTitle>
        <DialogContent>
          <Alert severity="warning" sx={{ mb: 2 }}>
            Regenerating this barcode may affect existing printed labels. Do you want to continue?
          </Alert>
          <TextField
            fullWidth size="small" label="Reason (optional)"
            value={regenerateReason} onChange={(e) => setRegenerateReason(e.target.value)}
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setRegenerateOpen(false)}>Cancel</Button>
          <Button variant="contained" color="warning" onClick={handleConfirmRegenerate} disabled={busy}>
            {busy ? 'Regenerating…' : 'Regenerate'}
          </Button>
        </DialogActions>
      </Dialog>

      <BarcodeConfigDialog open={configOpen} onClose={() => setConfigOpen(false)} onSaved={setSeriesConfig} />

      <BarcodePrintDialog open={printOpen} onClose={() => setPrintOpen(false)} products={[previewProduct]} />
    </Box>
  );
}

// Manually-typed second barcode (e.g. the manufacturer's EAN). Scans to the product
// like the primary; checked for duplicates against every product's codes.
function SecondaryBarcodeField({ mode, productId, primary, value, onChange, onSaved, keyboardNav }) {
  const [local, setLocal] = useState(value || '');
  const [duplicate, setDuplicate] = useState(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');

  useEffect(() => { setLocal(value || ''); }, [value]);

  const debounced = useDebounce(local.trim(), 400);
  useEffect(() => {
    let cancelled = false;
    if (!debounced) { setDuplicate(null); return undefined; }
    setChecking(true);
    const params = new URLSearchParams({ barcode: debounced });
    if (mode === 'manage' && productId) params.set('exclude_id', productId);
    axios.get(`/api/products/items/check_barcode/?${params.toString()}`)
      .then((res) => { if (!cancelled) setDuplicate(res.data.exists ? res.data : null); })
      .catch(() => { if (!cancelled) setDuplicate(null); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [debounced, mode, productId]);

  const trimmed = local.trim();
  const sameAsPrimary = Boolean(trimmed) && trimmed === (primary || '').trim();
  const invalid = Boolean(duplicate) || sameAsPrimary;

  const commit = async () => {
    setSaveError('');
    if (trimmed === (value || '') || invalid || checking) return;
    if (mode === 'create') {
      onChange && onChange(trimmed);
      return;
    }
    setSaving(true);
    try {
      const res = await axios.patch(`/api/products/items/${productId}/`, { secondary_barcode: trimmed || null });
      onSaved && onSaved(res.data.secondary_barcode || '');
    } catch (e) {
      setSaveError(e?.response?.data?.secondary_barcode?.[0] || 'Could not save the second barcode.');
    } finally {
      setSaving(false);
    }
  };

  // In create mode keep the parent in sync as the user types, so Save picks it up
  // even if the field never blurs.
  const handleChange = (e) => {
    setLocal(e.target.value);
    if (mode === 'create' && onChange) onChange(e.target.value.trim());
  };

  return (
    <TextField
      fullWidth
      size="small"
      label="Second barcode (optional)"
      placeholder="Scan / type another code for this item, e.g. manufacturer EAN"
      value={local}
      onChange={handleChange}
      onBlur={commit}
      sx={{ mt: 1 }}
      inputProps={keyboardNav ? { 'data-nav-own': '' } : undefined}
      onKeyDown={keyboardNav ? (e) => {
        if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
        if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault();
          focusRelative(e.target, e.key === 'ArrowUp' ? -1 : 1);
        }
      } : undefined}
      error={invalid || Boolean(saveError)}
      helperText={
        sameAsPrimary ? 'Must differ from the primary barcode.'
          : duplicate ? `Barcode already exists for another product ('${duplicate.product_name}').`
            : saveError || (saving ? 'Saving…' : checking ? 'Checking availability…' : 'Scans to this item just like the primary barcode.')
      }
      InputProps={{
        endAdornment: (checking || saving) ? <CircularProgress size={16} />
          : (!invalid && trimmed ? <CheckIcon fontSize="small" color="success" /> : null)
      }}
    />
  );
}
