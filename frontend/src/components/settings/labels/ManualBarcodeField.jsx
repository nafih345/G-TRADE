// Designer → the one place a barcode number is entered here: always typed by hand, never
// generated. Sample data only changes the preview; on a real product Save writes the
// number to the product, after the same duplicate check as Manage Barcode.
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import { Button, CircularProgress, Stack, TextField } from '@mui/material';
import { useDebounce } from '../../../hooks/useDebounce';
import { notify } from '../../../utils/notify';

export default function ManualBarcodeField({ data, onData }) {
  const fields = data.fields || {};
  const current = fields.barcode || '';
  const productId = data.kind === 'product' ? data.product?.id : null;
  const [value, setValue] = useState(current);
  const [savedValue, setSavedValue] = useState(current);
  const [duplicate, setDuplicate] = useState(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => { setValue(current); }, [current]);
  useEffect(() => { setSavedValue(current); setDuplicate(null); }, [productId]); // eslint-disable-line react-hooks/exhaustive-deps

  const trimmed = value.trim();
  const dirty = Boolean(productId) && trimmed !== savedValue;
  const debounced = useDebounce(dirty ? trimmed : '', 400);

  useEffect(() => {
    let cancelled = false;
    if (!productId || !debounced) { setDuplicate(null); return undefined; }
    setChecking(true);
    const params = new URLSearchParams({ barcode: debounced, exclude_id: productId });
    axios.get(`/api/products/items/check_barcode/?${params.toString()}`)
      .then((res) => { if (!cancelled) setDuplicate(res.data.exists ? res.data : null); })
      .catch(() => { if (!cancelled) setDuplicate(null); })
      .finally(() => { if (!cancelled) setChecking(false); });
    return () => { cancelled = true; };
  }, [debounced, productId]);

  const setBarcode = (barcode) => onData({ ...data, fields: { ...fields, barcode } });

  const handleChange = (e) => {
    setValue(e.target.value);
    setBarcode(e.target.value);
  };

  const handleSave = async () => {
    if (savedValue && !window.confirm('Change this product’s barcode? Labels already printed with the old number may stop scanning.')) return;
    setSaving(true);
    try {
      const res = await axios.patch(`/api/products/items/${productId}/`, { barcode: trimmed });
      setSavedValue(res.data.barcode || '');
      setBarcode(res.data.barcode || '');
      notify('Barcode number saved to the product.', 'success');
    } catch (e) {
      notify(e?.response?.data?.barcode?.[0] || 'Could not save the barcode number.', 'error');
    } finally {
      setSaving(false);
    }
  };

  const unchecked = dirty && debounced !== trimmed;

  return (
    <Stack direction="row" spacing={1} alignItems="flex-start" sx={{ mt: 1 }}>
      <TextField
        size="small" label="Barcode number" value={value} onChange={handleChange} sx={{ flex: 1, maxWidth: 360 }}
        error={Boolean(duplicate)}
        helperText={
          duplicate ? `Barcode already exists for another product ('${duplicate.product_name}').`
            : dirty ? 'Preview only until saved.'
              : productId ? 'Type a number and save it to this product.' : 'Type a number to preview it. Sample data is not saved.'
        }
        inputProps={{ 'data-testid': 'designer-barcode-number' }}
        InputProps={{ endAdornment: checking ? <CircularProgress size={16} /> : null }}
      />
      {productId && (
        <Button
          variant="contained" onClick={handleSave} data-testid="designer-barcode-save"
          disabled={!dirty || !trimmed || Boolean(duplicate) || checking || unchecked || saving}
        >
          {saving ? 'Saving…' : 'Save'}
        </Button>
      )}
    </Stack>
  );
}
