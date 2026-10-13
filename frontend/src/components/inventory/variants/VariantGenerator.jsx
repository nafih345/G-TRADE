import React, { useMemo, useState } from 'react';
import {
  Autocomplete, Box, Button, Chip, IconButton, MenuItem, Paper, Stack, TextField, Tooltip, Typography,
  ToggleButton, ToggleButtonGroup, Collapse
} from '@mui/material';
import {
  Add as AddIcon,
  Close as CloseIcon,
  AutoAwesome as GenerateIcon,
  FormatListNumbered as SequenceIcon,
  Visibility as PreviewIcon,
  ClearAll as ClearIcon,
  PlaylistAdd as AddRowsIcon
} from '@mui/icons-material';
import {
  ATTRIBUTE_CATALOG, attributeMeta, attributeOptions, alphaSequence, numericSequence,
  cartesian, combinationCount, uniqueValues, variantLabel, titleCase
} from './variantUtils';

const MAX_PREVIEW = 60;

function SequenceBuilder({ meta, onAdd }) {
  const [type, setType] = useState(meta.numeric ? 'numeric' : 'alpha');
  const [start, setStart] = useState(meta.seq?.start ?? (meta.numeric ? '1' : 'A'));
  const [end, setEnd] = useState(meta.seq?.end ?? (meta.numeric ? '10' : 'E'));
  const [step, setStep] = useState(meta.seq?.step ?? '1');
  const values = type === 'numeric' ? numericSequence(start, end, step, { signed: Boolean(meta.signed) }) : alphaSequence(start, end);
  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ mt: 1 }}>
      <ToggleButtonGroup size="small" exclusive value={type} onChange={(e, v) => v && setType(v)}>
        <ToggleButton value="numeric" sx={{ px: 1, py: 0.25, fontSize: '0.72rem' }}>1, 2, 3</ToggleButton>
        <ToggleButton value="alpha" sx={{ px: 1, py: 0.25, fontSize: '0.72rem' }}>A, B, C</ToggleButton>
      </ToggleButtonGroup>
      <TextField size="small" label="Start" value={start} onChange={(e) => setStart(e.target.value)} sx={{ width: 90 }} />
      <TextField size="small" label="End" value={end} onChange={(e) => setEnd(e.target.value)} sx={{ width: 90 }} />
      {type === 'numeric' && <TextField size="small" label="Step" value={step} onChange={(e) => setStep(e.target.value)} sx={{ width: 80 }} />}
      <Button size="small" variant="outlined" disabled={!values.length} onClick={() => onAdd(values)}>
        Add {values.length || ''} value{values.length === 1 ? '' : 's'}
      </Button>
      {!values.length && <Typography variant="caption" color="error">Check start / end{type === 'numeric' ? ' / step' : ''}.</Typography>}
    </Stack>
  );
}

function AxisRow({ axis, index, usedKeys, onChange, onRemove, autoFocus }) {
  const [seqOpen, setSeqOpen] = useState(false);
  const meta = attributeMeta(axis.key);
  const options = useMemo(() => attributeOptions(axis.key), [axis.key]);
  const isCustom = axis.key && !ATTRIBUTE_CATALOG.some(a => a.key === axis.key);
  return (
    <Paper variant="outlined" sx={{ p: 1, borderRadius: 2 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'flex-start' }}>
        <TextField
          select size="small" label={`Attribute ${index + 1}`} value={isCustom ? '__custom' : axis.key}
          onChange={(e) => onChange({ ...axis, key: e.target.value === '__custom' ? 'custom' : e.target.value, values: [] })}
          sx={{ minWidth: 170 }}
          inputProps={{ 'data-gen-first': index === 0 ? 'true' : undefined }}
          autoFocus={autoFocus}
        >
          {ATTRIBUTE_CATALOG.map(a => (
            <MenuItem key={a.key} value={a.key} disabled={a.key !== axis.key && usedKeys.includes(a.key)}>{a.label}</MenuItem>
          ))}
          <MenuItem value="__custom">Other attribute…</MenuItem>
        </TextField>
        {isCustom && (
          <TextField
            size="small" label="Attribute name" value={axis.label || ''}
            onChange={(e) => {
              const label = e.target.value;
              const key = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'custom';
              onChange({ ...axis, key, label });
            }}
            sx={{ minWidth: 150 }}
          />
        )}
        <Autocomplete
          multiple freeSolo fullWidth size="small" filterSelectedOptions
          options={options}
          value={axis.values}
          onChange={(e, v) => onChange({ ...axis, values: uniqueValues(v) })}
          limitTags={12}
          renderTags={(value, getTagProps) => value.map((v, i) => <Chip size="small" label={v} {...getTagProps({ index: i })} key={v} />)}
          renderInput={(params) => (
            <TextField {...params} label={`${meta.label || titleCase(axis.key)} values`} placeholder={axis.values.length ? '' : 'Type a value and press Enter, or pick from the list'} />
          )}
        />
        <Stack direction="row" spacing={0.5}>
          <Tooltip title="Add a numeric or alphabetic sequence"><IconButton size="small" onClick={() => setSeqOpen(o => !o)} color={seqOpen ? 'primary' : 'default'}><SequenceIcon fontSize="small" /></IconButton></Tooltip>
          {axis.values.length > 0 && <Tooltip title="Clear values"><IconButton size="small" onClick={() => onChange({ ...axis, values: [] })}><ClearIcon fontSize="small" /></IconButton></Tooltip>}
          <Tooltip title="Remove attribute"><IconButton size="small" color="error" onClick={onRemove}><CloseIcon fontSize="small" /></IconButton></Tooltip>
        </Stack>
      </Stack>
      <Collapse in={seqOpen} unmountOnExit>
        <SequenceBuilder meta={meta} onAdd={(vals) => onChange({ ...axis, values: uniqueValues([...axis.values, ...vals]) })} />
      </Collapse>
    </Paper>
  );
}

export default function VariantGenerator({
  axes, setAxes, onGenerate, onClearGenerated, onAddRows, hasGenerated, attributeOrder, focusToken
}) {
  const [preview, setPreview] = useState(false);
  const [repeat, setRepeat] = useState('1');
  const count = combinationCount(axes);
  const combos = useMemo(() => (preview ? cartesian(axes).slice(0, MAX_PREVIEW) : []), [preview, axes]);
  const usedKeys = axes.map(a => a.key);

  const addAxis = () => {
    const next = ATTRIBUTE_CATALOG.find(a => !usedKeys.includes(a.key));
    setAxes([...axes, { key: next ? next.key : 'custom', values: [] }]);
  };

  return (
    <Stack spacing={1}>
      {axes.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          No variant attributes yet. Add one (Colour, Size, Power…) to generate every combination automatically, or add rows by hand below.
        </Typography>
      )}
      {axes.map((axis, i) => (
        <AxisRow
          key={i}
          index={i}
          axis={axis}
          usedKeys={usedKeys}
          autoFocus={i === 0 && Boolean(focusToken)}
          onChange={(a) => setAxes(axes.map((x, j) => (j === i ? a : x)))}
          onRemove={() => setAxes(axes.filter((_, j) => j !== i))}
        />
      ))}
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
        <Button size="small" startIcon={<AddIcon />} onClick={addAxis} disabled={axes.length >= ATTRIBUTE_CATALOG.length + 2}>Add attribute</Button>
        <Box sx={{ flex: 1 }} />
        <Typography variant="body2" fontWeight={700} color={count ? 'primary.main' : 'text.secondary'}>
          {count ? `${count} combination${count === 1 ? '' : 's'}` : 'Pick values to see combinations'}
        </Typography>
        <Button size="small" startIcon={<PreviewIcon />} disabled={!count} onClick={() => setPreview(p => !p)}>{preview ? 'Hide preview' : 'Preview variants'}</Button>
        <Button size="small" color="inherit" startIcon={<ClearIcon />} disabled={!hasGenerated} onClick={onClearGenerated}>Clear generated</Button>
        <Button size="small" variant="contained" startIcon={<GenerateIcon />} disabled={!count} onClick={onGenerate} sx={{ fontWeight: 800 }}>
          {hasGenerated ? 'Regenerate variants' : 'Generate variants'} (Ctrl+Enter)
        </Button>
      </Stack>
      <Collapse in={preview && count > 0} unmountOnExit>
        <Paper variant="outlined" sx={{ p: 1, borderRadius: 2, maxHeight: 140, overflow: 'auto' }}>
          <Stack direction="row" flexWrap="wrap" useFlexGap spacing={0.5}>
            {combos.map((c, i) => <Chip key={i} size="small" variant="outlined" label={variantLabel(c, attributeOrder)} />)}
            {count > MAX_PREVIEW && <Chip size="small" label={`+${count - MAX_PREVIEW} more`} />}
          </Stack>
        </Paper>
      </Collapse>
      <Stack direction="row" spacing={1} alignItems="center">
        <Typography variant="body2" color="text.secondary">Add multiple times:</Typography>
        <TextField
          size="small" value={repeat} onChange={(e) => setRepeat(e.target.value.replace(/[^0-9]/g, '').slice(0, 3))}
          inputProps={{ inputMode: 'numeric', 'aria-label': 'Number of blank rows to add', style: { width: 44, textAlign: 'right' } }}
        />
        <Button size="small" startIcon={<AddRowsIcon />} onClick={() => onAddRows(Math.max(1, Math.min(500, parseInt(repeat, 10) || 1)))}>
          Add blank row{repeat === '1' ? '' : 's'}
        </Button>
      </Stack>
    </Stack>
  );
}
