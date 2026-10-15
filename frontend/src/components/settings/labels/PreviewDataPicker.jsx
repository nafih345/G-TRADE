// "Preview with" bar: sample scenarios for designing (typical / long name / missing fields /
// long barcode) or a real product from Inventory, with a variant switcher when the product
// belongs to a variant group. Real products are resolved through /api/products/label-data/.
import React, { useEffect, useRef, useState } from 'react';
import {
  Stack, TextField, MenuItem, Autocomplete, CircularProgress, ToggleButtonGroup, ToggleButton, Typography, Box,
} from '@mui/material';
import { SAMPLE_SCENARIOS } from '../../../labels/labelFields';
import { searchProducts, fetchLabelData, fetchVariantSiblings } from '../../../labels/labelApi';

export default function PreviewDataPicker({ onData, initialProduct }) {
  const [mode, setMode] = useState(initialProduct ? 'product' : 'sample');
  const [scenario, setScenario] = useState('typical');
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState([]);
  const [searching, setSearching] = useState(false);
  const [product, setProduct] = useState(initialProduct || null);
  const [variants, setVariants] = useState([]);
  const [variantId, setVariantId] = useState('');
  const [loadingData, setLoadingData] = useState(false);
  const timer = useRef(null);

  // Sample mode
  useEffect(() => {
    if (mode !== 'sample') return;
    const s = SAMPLE_SCENARIOS.find((x) => x.id === scenario) || SAMPLE_SCENARIOS[0];
    onData({ kind: 'sample', label: s.label, fields: s.fields });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, scenario]);

  // Product search (debounced)
  useEffect(() => {
    if (mode !== 'product') return undefined;
    clearTimeout(timer.current);
    timer.current = setTimeout(async () => {
      setSearching(true);
      try { setOptions(await searchProducts(query)); } catch { setOptions([]); } finally { setSearching(false); }
    }, 250);
    return () => clearTimeout(timer.current);
  }, [query, mode]);

  const loadProduct = async (p, { keepVariants = false } = {}) => {
    if (!p) return;
    setLoadingData(true);
    try {
      const res = await fetchLabelData([p]);
      const d = res.byProduct.get(p);
      onData({ kind: 'product', label: d.fields.product_name || p.name, fields: d.fields, store: res.store, logo: res.logo, product: p, restrictedIncluded: res.restrictedIncluded });
      if (!keepVariants) {
        const group = d.variantGroup || p.variant_group;
        if (group) {
          try {
            const sibs = await fetchVariantSiblings(group);
            setVariants(sibs);
            setVariantId(String(p.id));
          } catch { setVariants([]); }
        } else {
          setVariants([]);
          setVariantId('');
        }
      }
    } finally {
      setLoadingData(false);
    }
  };

  useEffect(() => {
    if (initialProduct) loadProduct(initialProduct);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }} sx={{ width: '100%' }}>
      <Typography variant="body2" fontWeight={700} sx={{ whiteSpace: 'nowrap' }}>Preview with</Typography>
      <ToggleButtonGroup exclusive size="small" value={mode} onChange={(e, v) => v && setMode(v)}>
        <ToggleButton value="sample">Sample data</ToggleButton>
        <ToggleButton value="product" data-testid="preview-real-product">Real product</ToggleButton>
      </ToggleButtonGroup>
      {mode === 'sample' ? (
        <TextField select size="small" value={scenario} onChange={(e) => setScenario(e.target.value)} sx={{ minWidth: 220 }}>
          {SAMPLE_SCENARIOS.map((s) => <MenuItem key={s.id} value={s.id}>{s.label}</MenuItem>)}
        </TextField>
      ) : (
        <>
          <Autocomplete
            size="small"
            sx={{ minWidth: 260, flex: 1 }}
            options={options}
            value={product}
            filterOptions={(x) => x}
            loading={searching}
            getOptionLabel={(o) => o?.name || ''}
            isOptionEqualToValue={(a, b) => String(a.id) === String(b.id)}
            onInputChange={(e, v, reason) => { if (reason === 'input') setQuery(v); }}
            onChange={(e, v) => { setProduct(v); if (v) loadProduct(v); }}
            renderOption={(props, o) => (
              <li {...props} key={o.id}>
                <Box>
                  <Typography variant="body2" fontWeight={600}>{o.name}</Typography>
                  <Typography variant="caption" color="text.secondary">SKU {o.sku || '—'} · {o.barcode || 'no barcode'}</Typography>
                </Box>
              </li>
            )}
            renderInput={(params) => (
              <TextField
                {...params}
                placeholder="Search Inventory by name / SKU / barcode"
                inputProps={{ ...params.inputProps, 'data-testid': 'preview-product-search' }}
                InputProps={{ ...params.InputProps, endAdornment: <>{(searching || loadingData) && <CircularProgress size={16} />}{params.InputProps.endAdornment}</> }}
              />
            )}
          />
          {variants.length > 1 && (
            <TextField
              select size="small" label={`Variant (${variants.length})`} value={variantId} sx={{ minWidth: 200 }}
              onChange={(e) => {
                setVariantId(e.target.value);
                const v = variants.find((x) => String(x.id) === e.target.value);
                if (v) loadProduct(v, { keepVariants: true });
              }}
              SelectProps={{ MenuProps: { PaperProps: { sx: { maxHeight: 360 } } } }}
              inputProps={{ 'data-testid': 'preview-variant-select' }}
            >
              {variants.map((v) => (
                <MenuItem key={v.id} value={String(v.id)}>
                  {[v.color, v.size].filter(Boolean).join(' / ') || v.name} — {v.sku}
                </MenuItem>
              ))}
            </TextField>
          )}
        </>
      )}
    </Stack>
  );
}
