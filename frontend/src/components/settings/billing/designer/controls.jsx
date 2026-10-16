// Small, compact form controls shared by the bill designer's property panels.
import React, { useEffect, useState } from 'react';
import {
  Box, TextField, Typography, Stack, MenuItem, ToggleButton, ToggleButtonGroup, FormControlLabel, Switch, Tooltip,
} from '@mui/material';

/** Number input that only commits finite values (keeps the half-typed text locally). */
export function NumField({ label, value, onChange, step = 0.5, min, max, unit = 'mm', width, disabled, testId }) {
  const [text, setText] = useState(value ?? '');
  useEffect(() => { setText(value ?? ''); }, [value]);
  return (
    <TextField
      size="small" label={label} value={text} type="number" disabled={disabled}
      inputProps={{ step, min, max, 'data-testid': testId }}
      InputProps={unit ? { endAdornment: <Typography variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>{unit}</Typography> } : undefined}
      onChange={(e) => {
        setText(e.target.value);
        const n = parseFloat(e.target.value);
        if (Number.isFinite(n)) onChange(Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n)));
      }}
      onBlur={() => setText(value ?? '')}
      sx={{ width: width || '100%' }}
    />
  );
}

/** Colour swatch + hex text. Empty means "inherit / theme". */
export function ColorField({ label, value, onChange, allowEmpty = true, disabled }) {
  const [text, setText] = useState(value || '');
  useEffect(() => { setText(value || ''); }, [value]);
  const valid = (v) => /^#[0-9a-fA-F]{6}$/.test(v) || /^#[0-9a-fA-F]{3}$/.test(v) || v === 'transparent';
  return (
    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ width: '100%' }}>
      <Box
        component="input" type="color" disabled={disabled}
        value={/^#[0-9a-fA-F]{6}$/.test(value || '') ? value : '#000000'}
        onChange={(e) => onChange(e.target.value)}
        sx={{ width: 30, height: 30, p: 0, border: '1px solid #cbd5e1', borderRadius: 1, bgcolor: 'transparent', cursor: 'pointer', flex: '0 0 auto' }}
      />
      <TextField
        size="small" label={label} value={text} disabled={disabled} placeholder={allowEmpty ? 'theme' : ''}
        onChange={(e) => {
          const v = e.target.value.trim();
          setText(e.target.value);
          if (valid(v) || (allowEmpty && v === '')) onChange(v);
        }}
        sx={{ flex: 1 }}
      />
    </Stack>
  );
}

export function SelectField({ label, value, onChange, options, disabled, testId }) {
  return (
    <TextField select size="small" fullWidth label={label} value={value ?? ''} disabled={disabled} onChange={(e) => onChange(e.target.value)} inputProps={{ 'data-testid': testId }}>
      {options.map((o) => (typeof o === 'string'
        ? <MenuItem key={o} value={o}>{o}</MenuItem>
        : <MenuItem key={String(o.value)} value={o.value} disabled={o.disabled}>{o.label}</MenuItem>))}
    </TextField>
  );
}

export function Toggle({ label, checked, onChange, disabled, hint }) {
  const ctl = (
    <FormControlLabel
      sx={{ m: 0, '& .MuiFormControlLabel-label': { fontSize: 13 } }}
      control={<Switch size="small" checked={!!checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />}
      label={label}
    />
  );
  return hint ? <Tooltip title={hint} placement="left"><span>{ctl}</span></Tooltip> : ctl;
}

export function Segmented({ value, onChange, options, disabled, size = 'small' }) {
  return (
    <ToggleButtonGroup exclusive size={size} value={value} disabled={disabled} onChange={(e, v) => v !== null && onChange(v)} sx={{ flexWrap: 'wrap' }}>
      {options.map((o) => (
        <ToggleButton key={o.value} value={o.value} sx={{ px: 1, py: 0.25, textTransform: 'none', fontSize: 12 }}>
          {o.icon ? <Tooltip title={o.label}><Box component="span" sx={{ display: 'flex' }}>{o.icon}</Box></Tooltip> : o.label}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

export function Section({ title, children, action }) {
  return (
    <Box sx={{ mb: 1.75 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.75 }}>
        <Typography variant="overline" sx={{ fontWeight: 800, lineHeight: 1.6, color: 'text.secondary' }}>{title}</Typography>
        {action}
      </Stack>
      <Stack spacing={1}>{children}</Stack>
    </Box>
  );
}

export function Row({ children }) {
  return <Stack direction="row" spacing={1} alignItems="center">{children}</Stack>;
}

/** Read an uploaded image as a (downscaled) PNG/JPEG data URL. */
export function fileToDataUrl(file, maxDim = 600) {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type)) { reject(new Error('Use a PNG, JPEG, WebP or GIF image.')); return; }
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/png'));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}
