import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Grid, InputAdornment, List, ListItem, ListItemText, MenuItem, TextField, Typography,
} from '@mui/material';
import { Calculate as CalcIcon, History as HistoryIcon, Tune as TuneIcon } from '@mui/icons-material';
import { SectionCard, errText } from './businessUi';
import { formatDate, formatTime } from '../../../utils/localeFormat.js';

export const OTHER_KEYS = ['rounding_method', 'quantity_decimals', 'default_payment_terms_days', 'default_sale_status',
  'default_discount_mode', 'max_discount_percent', 'service_charge_percent', 'service_charge_on', 'default_customer_city'];

const ROUNDING = {
  NONE: 'No rounding', NEAREST_0_05: 'Nearest 0.05', NEAREST_0_10: 'Nearest 0.10', NEAREST_0_50: 'Nearest 0.50',
  NEAREST_1: 'Nearest 1', UP_1: 'Up to next 1', DOWN_1: 'Down to previous 1',
};
const SECTION_LABEL = { LOCALIZATION: 'Preferences', TAX: 'Tax', NUMBERING: 'Numbering', CUSTOM_FIELD: 'Custom field' };

function num(errors, key, help) {
  return { error: !!errors[key], helperText: errText(errors[key]) || help };
}

export default function OtherSettingsTab({ form, set, errors, savedAt }) {
  const [history, setHistory] = useState(null);
  const [historyError, setHistoryError] = useState('');

  useEffect(() => {
    let alive = true;
    axios.get('/api/company/settings-audit/')
      .then((r) => { if (alive) { setHistory(r.data); setHistoryError(''); } })
      .catch(() => { if (alive) setHistoryError('Sign in as a Super Admin or Administrator to see the change history.'); });
    return () => { alive = false; };
  }, [savedAt]);

  return (
    <Grid container spacing={3}>
      <Grid item xs={12}>
        <Alert severity="info" sx={{ borderRadius: 2 }}>
          These defaults are saved for the whole business. New Sale and Purchase Entry don't read them yet —
          they will as each screen adopts them.
        </Alert>
      </Grid>
      <Grid item xs={12} lg={7}>
        <SectionCard id="calc-prefs" icon={<CalcIcon />} title="Calculation & Rounding"
          subtitle="Defaults for amounts and quantities." sx={{ mb: 3 }}>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Bill Rounding Method" value={form.rounding_method}
                onChange={(e) => set('rounding_method', e.target.value)} {...num(errors, 'rounding_method', 'How a bill total is rounded off.')}>
                {Object.entries(ROUNDING).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Quantity Decimal Precision" value={form.quantity_decimals}
                onChange={(e) => set('quantity_decimals', Number(e.target.value))} {...num(errors, 'quantity_decimals', 'Decimal places for quantities.')}>
                {[0, 1, 2, 3].map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
              </TextField>
            </Grid>
          </Grid>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1.5 }}>
            Amount precision is set with the currency under Currency & Language.
          </Typography>
        </SectionCard>

        <SectionCard id="doc-defaults" icon={<TuneIcon />} title="Document Defaults"
          subtitle="Starting values for new sales documents and records.">
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth type="number" label="Default Payment Terms" value={form.default_payment_terms_days}
                onChange={(e) => set('default_payment_terms_days', e.target.value === '' ? '' : Number(e.target.value))}
                inputProps={{ min: 0, max: 365 }}
                InputProps={{ endAdornment: <InputAdornment position="end">days</InputAdornment> }}
                {...num(errors, 'default_payment_terms_days', '0 = due on receipt.')} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Default Sales Document Status" value={form.default_sale_status}
                onChange={(e) => set('default_sale_status', e.target.value)}
                {...num(errors, 'default_sale_status', 'Status of a new bill before payment is taken.')}>
                <MenuItem value="UNPAID">Unpaid (posted)</MenuItem>
                <MenuItem value="DRAFT">Draft</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Default Discount Type" value={form.default_discount_mode}
                onChange={(e) => set('default_discount_mode', e.target.value)} {...num(errors, 'default_discount_mode', 'Discounts entered as % or a fixed amount.')}>
                <MenuItem value="PERCENT">Percentage (%)</MenuItem>
                <MenuItem value="AMOUNT">Fixed amount</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth type="number" label="Maximum Discount" value={form.max_discount_percent}
                onChange={(e) => set('max_discount_percent', e.target.value === '' ? '' : Number(e.target.value))}
                inputProps={{ min: 0, max: 100 }}
                InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                {...num(errors, 'max_discount_percent', 'Upper limit for a line or bill discount.')} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth type="number" label="Service Charge" value={form.service_charge_percent}
                onChange={(e) => set('service_charge_percent', e.target.value === '' ? '' : Number(e.target.value))}
                inputProps={{ min: 0, max: 100, step: 0.01 }}
                InputProps={{ endAdornment: <InputAdornment position="end">%</InputAdornment> }}
                {...num(errors, 'service_charge_percent', '0 for none.')} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Service Charge Applies To" value={form.service_charge_on}
                onChange={(e) => set('service_charge_on', e.target.value)} {...num(errors, 'service_charge_on', '')}>
                <MenuItem value="NONE">Not applied</MenuItem>
                <MenuItem value="SUBTOTAL">Subtotal (before tax)</MenuItem>
                <MenuItem value="TOTAL">Total (after tax)</MenuItem>
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth label="Default City for New Customers" value={form.default_customer_city || ''}
                onChange={(e) => set('default_customer_city', e.target.value)}
                inputProps={{ maxLength: 100 }} {...num(errors, 'default_customer_city', 'Pre-filled on new customer records.')} />
            </Grid>
          </Grid>
        </SectionCard>
      </Grid>

      <Grid item xs={12} lg={5}>
        <SectionCard id="settings-history" icon={<HistoryIcon />} title="Recent Settings Changes"
          subtitle="Audit trail of business settings, taxes, numbering and custom fields.">
          {historyError && <Typography variant="body2" color="text.secondary">{historyError}</Typography>}
          {!historyError && history === null && <Typography variant="body2" color="text.secondary">Loading…</Typography>}
          {history && history.length === 0 && <Typography variant="body2" color="text.secondary">No changes recorded yet.</Typography>}
          {history && history.length > 0 && (
            <List dense disablePadding sx={{ maxHeight: 480, overflowY: 'auto' }}>
              {history.map((h) => (
                <ListItem key={h.id} disableGutters divider alignItems="flex-start">
                  <ListItemText
                    primary={h.summary}
                    secondary={(
                      <Box component="span">
                        {SECTION_LABEL[h.section] || h.section} · {h.performed_by || 'unknown user'} · {formatDate(h.created_at)} {formatTime(h.created_at)}
                      </Box>
                    )}
                    primaryTypographyProps={{ variant: 'body2', fontWeight: 600, sx: { wordBreak: 'break-word' } }}
                    secondaryTypographyProps={{ variant: 'caption' }}
                  />
                </ListItem>
              ))}
            </List>
          )}
        </SectionCard>
      </Grid>
    </Grid>
  );
}
