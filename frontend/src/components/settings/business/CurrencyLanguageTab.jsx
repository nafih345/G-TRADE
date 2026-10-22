import React from 'react';
import {
  Alert, Autocomplete, Box, Chip, Grid, InputAdornment, MenuItem, Table, TableBody, TableCell, TableHead, TableRow,
  TextField, Typography,
} from '@mui/material';
import { Payments as CurrencyIcon, Translate as LanguageIcon, CurrencyExchange as ExchangeIcon } from '@mui/icons-material';
import { PrefToggleRow, SectionCard, errText } from './businessUi';
import { formatMoney } from '../../../utils/localeFormat.js';
import { hasBillTranslation } from '../../../billing/billI18n.js';

export const CURRENCY_KEYS = ['base_currency', 'currency_symbol', 'currency_decimals', 'enabled_currencies',
  'exchange_rates', 'enabled_languages'];

const curLabel = (c) => `${c.code} — ${c.name} (${c.symbol})`;

export default function CurrencyLanguageTab({ form, set, setMany, errors, catalog, dirtyKeys }) {
  const byCode = Object.fromEntries(catalog.currencies.map((c) => [c.code, c]));
  const base = byCode[form.base_currency] || null;
  const extra = (form.enabled_currencies || []).map((c) => byCode[c]).filter(Boolean);
  const langs = catalog.languages.filter((l) => (form.enabled_languages || []).includes(l.code));
  const rateErrors = errors.exchange_rates && typeof errors.exchange_rates === 'object' ? errors.exchange_rates : {};

  const onBase = (c) => {
    if (!c) return;
    setMany({
      base_currency: c.code, currency_symbol: c.symbol, currency_decimals: c.decimals,
      enabled_currencies: (form.enabled_currencies || []).filter((x) => x !== c.code),
    });
  };

  const sample = formatMoney(123456.78, {
    symbol: form.currency_symbol,
    decimals: Number(form.currency_decimals) || 0,
    prefs: { ...form, currency_decimals: Number(form.currency_decimals) || 0 },
  });

  return (
    <Grid container spacing={3}>
      <Grid item xs={12} lg={6}>
        <SectionCard id="base-currency" icon={<CurrencyIcon />} title="Base Currency"
          subtitle="The currency your books, prices and documents are kept in." sx={{ mb: 3 }}>
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Autocomplete
                options={catalog.currencies}
                value={base}
                onChange={(_, c) => onBase(c)}
                getOptionLabel={curLabel}
                isOptionEqualToValue={(a, b) => a.code === b.code}
                disableClearable
                renderInput={(p) => (
                  <TextField {...p} label="Base Currency (ISO 4217)" required error={!!errors.base_currency}
                    helperText={errText(errors.base_currency) || 'Search by code or name, e.g. INR, AED, USD.'} />
                )}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField fullWidth label="Currency Symbol" value={form.currency_symbol || ''}
                onChange={(e) => set('currency_symbol', e.target.value)} error={!!errors.currency_symbol}
                inputProps={{ maxLength: 10 }}
                helperText={errText(errors.currency_symbol) || 'Printed with amounts (stored on the store profile).'} />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Decimal Precision" value={form.currency_decimals}
                onChange={(e) => set('currency_decimals', Number(e.target.value))} error={!!errors.currency_decimals}
                helperText={errText(errors.currency_decimals) || 'Decimal places shown for amounts.'}>
                {[0, 1, 2, 3, 4].map((d) => <MenuItem key={d} value={d}>{d}</MenuItem>)}
              </TextField>
            </Grid>
          </Grid>
          <Box sx={{ mt: 2, p: 1.5, borderRadius: 2, bgcolor: 'action.hover', display: 'flex', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap' }}>
            <Typography variant="body2" color="text.secondary">Preview</Typography>
            <Typography variant="body2" fontWeight={800}>{sample}</Typography>
          </Box>
        </SectionCard>

        <SectionCard id="languages" icon={<LanguageIcon />} title="Languages"
          subtitle="The default language and any others the business uses.">
          <Grid container spacing={2}>
            <Grid item xs={12}>
              <Autocomplete
                options={catalog.languages}
                value={catalog.languages.find((l) => l.code === form.language) || null}
                onChange={(_, l) => l && setMany({
                  language: l.code,
                  ...(hasBillTranslation(l.code) ? {} : { bill_language_mode: 'EN' }),
                  enabled_languages: form.enabled_languages.includes(l.code) ? form.enabled_languages : [l.code, ...form.enabled_languages],
                })}
                getOptionLabel={(l) => (l.native && l.native !== l.name ? `${l.native} — ${l.name}` : l.name)}
                isOptionEqualToValue={(a, b) => a.code === b.code}
                disableClearable
                renderInput={(p) => <TextField {...p} label="Default Language" error={!!errors.language} helperText={errText(errors.language)} />}
              />
            </Grid>
            <Grid item xs={12}>
              <Autocomplete
                multiple
                options={catalog.languages}
                value={langs}
                onChange={(_, list) => {
                  const codes = list.map((l) => l.code);
                  set('enabled_languages', codes.includes(form.language) ? codes : [form.language, ...codes]);
                }}
                getOptionLabel={(l) => (l.native && l.native !== l.name ? `${l.native} — ${l.name}` : l.name)}
                isOptionEqualToValue={(a, b) => a.code === b.code}
                renderTags={(value, getTagProps) => value.map((l, i) => {
                  const { key, ...rest } = getTagProps({ index: i });
                  return <Chip key={key} {...rest} size="small" label={l.native || l.name} onDelete={l.code === form.language ? undefined : rest.onDelete} />;
                })}
                renderInput={(p) => (
                  <TextField {...p} label="Additional Enabled Languages" error={!!errors.enabled_languages}
                    helperText={errText(errors.enabled_languages) || 'The default language is always enabled.'} />
                )}
              />
            </Grid>
          </Grid>
          <Alert severity="info" sx={{ mt: 2, borderRadius: 2 }}>
            The app screens are in English. Bills can print in Arabic, Hindi, Malayalam or Tamil — alone or together with
            English — set under General → "Bills & Documents Print In".
          </Alert>
        </SectionCard>
      </Grid>

      <Grid item xs={12} lg={6}>
        <SectionCard id="multi-currency" icon={<ExchangeIcon />} title="Multi-currency & Exchange Rates"
          subtitle="Additional currencies allowed for transactions, valued against the base currency.">
          <PrefToggleRow id="cur-multi" icon={<ExchangeIcon />} title="Enable Multi-currency Transactions"
            description="Only the currencies below, with an exchange rate, can be used."
            checked={form.multi_currency_enabled} onChange={(v) => set('multi_currency_enabled', v)}
            error={errText(errors.multi_currency_enabled)} dirty={dirtyKeys.has('multi_currency_enabled')} />
          <Autocomplete
            sx={{ mt: 2 }}
            multiple
            options={catalog.currencies.filter((c) => c.code !== form.base_currency)}
            value={extra}
            onChange={(_, list) => set('enabled_currencies', list.map((c) => c.code))}
            getOptionLabel={curLabel}
            isOptionEqualToValue={(a, b) => a.code === b.code}
            renderTags={(value, getTagProps) => value.map((c, i) => {
              const { key, ...rest } = getTagProps({ index: i });
              return <Chip key={key} {...rest} size="small" label={c.code} />;
            })}
            renderInput={(p) => (
              <TextField {...p} label="Additional Currencies" error={!!errors.enabled_currencies}
                helperText={errText(errors.enabled_currencies) || 'Search ISO 4217 codes.'} />
            )}
          />
          {extra.length > 0 ? (
            <Table size="small" sx={{ mt: 2 }}>
              <TableHead>
                <TableRow>
                  <TableCell sx={{ fontWeight: 700 }}>Currency</TableCell>
                  <TableCell sx={{ fontWeight: 700 }}>1 unit = ? {form.base_currency}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {extra.map((c) => (
                  <TableRow key={c.code}>
                    <TableCell>{c.code} <Typography component="span" variant="caption" color="text.secondary">{c.name}</Typography></TableCell>
                    <TableCell sx={{ minWidth: 160 }}>
                      <TextField
                        size="small" type="number" inputProps={{ min: 0, step: 'any', 'aria-label': `${c.code} exchange rate` }}
                        value={form.exchange_rates?.[c.code] ?? ''}
                        onChange={(e) => set('exchange_rates', { ...form.exchange_rates, [c.code]: e.target.value })}
                        error={!!rateErrors[c.code]} helperText={rateErrors[c.code] || ''}
                        InputProps={{ endAdornment: <InputAdornment position="end">{form.base_currency}</InputAdornment> }}
                      />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <Typography variant="body2" color="text.secondary" sx={{ mt: 2 }}>
              No additional currencies. Add one above to enter its exchange rate.
            </Typography>
          )}
          <Alert severity="info" sx={{ mt: 2, borderRadius: 2 }}>
            Rates are entered manually and kept until you change them; no live rate feed is connected.
          </Alert>
        </SectionCard>
      </Grid>
    </Grid>
  );
}
