// What the canvas shows: clearly-labelled SAMPLE data, or a REAL transaction (read-only).
import React, { useEffect, useState } from 'react';
import {
  Stack, ToggleButtonGroup, ToggleButton, TextField, MenuItem, Autocomplete, Chip, Typography, FormControlLabel, Switch, CircularProgress,
} from '@mui/material';
import { Science, ReceiptLong } from '@mui/icons-material';
import { DOC_TYPE_LABELS } from '../../../../billing/billFields';
import { loadRealDocuments, REAL_DOC_NOTES } from '../../../../billing/realDocuments';
import { SAMPLE_COUNTS } from '../../../../billing/sampleModels';

export default function PreviewSource({ value, onChange, docTypes }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [error, setError] = useState('');
  const type = value.docType;

  useEffect(() => {
    if (value.mode !== 'real') return undefined;
    let alive = true;
    setLoading(true);
    setError('');
    const t = setTimeout(() => {
      loadRealDocuments(type, search)
        .then((r) => { if (alive) setRows(r); })
        .catch(() => { if (alive) { setRows([]); setError('Could not load documents from the server.'); } })
        .finally(() => { if (alive) setLoading(false); });
    }, search ? 300 : 0);
    return () => { alive = false; clearTimeout(t); };
  }, [value.mode, type, search]);

  return (
    <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap>
      <ToggleButtonGroup size="small" exclusive value={value.mode} onChange={(e, v) => v && onChange({ ...value, mode: v, doc: null })}>
        <ToggleButton value="sample" sx={{ textTransform: 'none', px: 1.25 }} data-testid="preview-sample"><Science fontSize="small" sx={{ mr: 0.5 }} />Sample data</ToggleButton>
        <ToggleButton value="real" sx={{ textTransform: 'none', px: 1.25 }} data-testid="preview-real"><ReceiptLong fontSize="small" sx={{ mr: 0.5 }} />Real document</ToggleButton>
      </ToggleButtonGroup>
      <TextField select size="small" label="Document type" value={type} onChange={(e) => onChange({ ...value, docType: e.target.value, doc: null })} sx={{ minWidth: 190 }}>
        {docTypes.map((d) => <MenuItem key={d} value={d}>{DOC_TYPE_LABELS[d]}</MenuItem>)}
      </TextField>
      {value.mode === 'sample' ? (
        <>
          <TextField select size="small" label="Items" value={value.itemCount} onChange={(e) => onChange({ ...value, itemCount: Number(e.target.value) })} sx={{ width: 110 }}>
            {SAMPLE_COUNTS.map((n) => <MenuItem key={n} value={n}>{n} lines</MenuItem>)}
          </TextField>
          <FormControlLabel sx={{ m: 0 }} control={<Switch size="small" checked={!!value.longNames} onChange={(e) => onChange({ ...value, longNames: e.target.checked })} />} label={<Typography variant="body2">Long names</Typography>} />
          <Chip size="small" color="warning" label="SAMPLE — not saved in the template" />
        </>
      ) : (
        <>
          <Autocomplete
            size="small" sx={{ minWidth: 300, flex: '1 1 300px' }}
            options={rows} loading={loading} value={value.doc}
            getOptionLabel={(o) => `${o.number || '—'} · ${o.party || ''}`}
            isOptionEqualToValue={(a, b) => a.id === b.id}
            filterOptions={(x) => x}
            onInputChange={(e, v, reason) => { if (reason === 'input') setSearch(v); }}
            onChange={(e, v) => onChange({ ...value, doc: v })}
            noOptionsText={REAL_DOC_NOTES[type] || error || 'No documents found'}
            renderOption={(props, o) => (
              <li {...props} key={o.id}>
                <Stack sx={{ width: '100%' }}>
                  <Typography variant="body2" fontWeight={700}>{o.number || '—'} <Typography component="span" variant="caption" color="text.secondary">{o.date}</Typography></Typography>
                  <Typography variant="caption" color="text.secondary">{o.party}{o.amount !== null ? ` · ₹${Number(o.amount).toLocaleString('en-IN')}` : ''}</Typography>
                </Stack>
              </li>
            )}
            renderInput={(params) => (
              <TextField {...params} label={`Pick a ${DOC_TYPE_LABELS[type] || 'document'}`} placeholder="Search by number or name"
                InputProps={{ ...params.InputProps, endAdornment: <>{loading ? <CircularProgress size={14} /> : null}{params.InputProps.endAdornment}</> }} />
            )}
          />
          {value.doc
            ? <Chip size="small" color="success" label={`REAL: ${value.doc.number} (read-only)`} />
            : <Typography variant="caption" color="text.secondary">{REAL_DOC_NOTES[type] || 'Pick a saved document to see it in this layout.'}</Typography>}
        </>
      )}
    </Stack>
  );
}
