import React, { useMemo } from 'react';
import { Alert, Autocomplete, Box, Button, Grid, MenuItem, TextField, Typography } from '@mui/material';
import {
  Public as GlobeIcon, Percent as PercentIcon, FormatListNumbered as NumberedIcon, Map as RegionIcon,
  CurrencyRupee as CurrencyIcon, Inventory2 as StockIcon, Tag as NumberIcon, CurrencyExchange as ExchangeIcon,
  FactCheck as ConfirmIcon,
} from '@mui/icons-material';
import { PrefToggleRow, QuickLinkRow, SectionCard, errText } from './businessUi';
import { MONTHS, formatDate, formatNumber, formatTime } from '../../../utils/localeFormat.js';
import { hasBillTranslation, translateBillLabel } from '../../../billing/billI18n.js';

const NUMBER_FORMAT_LABELS = {
  INDIAN: 'Indian (lakh / crore)', INTERNATIONAL: 'International', EUROPEAN: 'European', SPACE: 'Space grouped', SWISS: 'Swiss',
};
const SAMPLE_DATE = new Date(2026, 9, 22, 14, 30);

export const GENERAL_KEYS = ['country', 'region', 'time_zone', 'date_format', 'time_format', 'fiscal_year_start_month',
  'number_format', 'language', 'bill_language_mode', 'show_currency_symbol', 'allow_negative_stock', 'auto_generate_numbers',
  'multi_currency_enabled', 'confirm_before_posting'];

const helper = (error, text) => errText(error) || text;

export default function GeneralTab({ form, set, setMany, errors, catalog, dirtyKeys, onNavigate }) {
  const country = useMemo(() => catalog.countries.find((c) => c.code === form.country) || null, [catalog, form.country]);
  const regions = catalog.regions[form.country] || null;
  const zone = catalog.time_zones.find((z) => z.name === form.time_zone) || null;
  const language = catalog.languages.find((l) => l.code === form.language) || null;
  const currency = catalog.currencies.find((c) => c.code === (country?.currency || '')) || null;
  const billCanTranslate = hasBillTranslation(form.language);
  const billMode = billCanTranslate ? (form.bill_language_mode || 'EN') : 'EN';
  const langName = language ? (language.native && language.native !== language.name ? `${language.name} (${language.native})` : language.name) : 'Local language';
  const billSample = (mode) => {
    const loc = translateBillLabel('Grand Total', form.language);
    if (mode === 'LOCAL' && loc) return loc;
    if (mode === 'BILINGUAL' && loc) return `Grand Total / ${loc}`;
    return 'Grand Total';
  };

  // Suggested regional defaults for the chosen country — offered, never applied silently.
  const suggestion = country && {
    time_zone: country.time_zone, date_format: country.date_format, number_format: country.number_format,
    fiscal_year_start_month: country.fiscal_year_start_month, language: country.language,
    base_currency: country.currency,
    ...(currency ? { currency_symbol: currency.symbol, currency_decimals: currency.decimals } : {}),
  };
  const suggestionDiffers = suggestion && Object.entries(suggestion).some(([k, v]) => form[k] !== v);

  const onCountry = (c) => {
    if (!c) return;
    const nextRegions = catalog.regions[c.code];
    setMany({ country: c.code, region: nextRegions && !nextRegions.includes(form.region) ? '' : form.region });
  };

  const dirty = (k) => dirtyKeys.has(k);

  return (
    <Grid container spacing={3}>
      {/* LEFT — Regional Defaults */}
      <Grid item xs={12} lg={6}>
        <SectionCard
          id="regional-defaults"
          icon={<RegionIcon />}
          title="Regional Defaults"
          subtitle="Set your regional and localization preferences. These settings will be used across the system."
        >
          {suggestionDiffers && (
            <Alert
              severity="info"
              sx={{ mb: 2, borderRadius: 2 }}
              action={<Button color="inherit" size="small" onClick={() => setMany(suggestion)}>Apply</Button>}
            >
              Use the usual defaults for {country.name}: {country.time_zone}, {country.date_format},{' '}
              {NUMBER_FORMAT_LABELS[country.number_format]} numbers, {country.currency}, fiscal year from {MONTHS[country.fiscal_year_start_month - 1]}?
            </Alert>
          )}
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6}>
              <Autocomplete
                options={catalog.countries}
                value={country}
                onChange={(_, c) => onCountry(c)}
                getOptionLabel={(c) => `${c.name} (${c.code})`}
                isOptionEqualToValue={(a, b) => a.code === b.code}
                disableClearable
                renderInput={(p) => (
                  <TextField {...p} label="Default Country" required error={!!errors.country}
                    helperText={helper(errors.country, 'Used for regional defaults and addresses.')} />
                )}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              {regions ? (
                <TextField select fullWidth label="State / Region" value={form.region || ''}
                  onChange={(e) => set('region', e.target.value)} error={!!errors.region}
                  helperText={helper(errors.region, 'Home state — e.g. decides intra- vs inter-state GST.')}>
                  <MenuItem value=""><em>Not set</em></MenuItem>
                  {regions.map((r) => <MenuItem key={r} value={r}>{r}</MenuItem>)}
                </TextField>
              ) : (
                <TextField fullWidth label="State / Region" value={form.region || ''}
                  onChange={(e) => set('region', e.target.value)} error={!!errors.region}
                  helperText={helper(errors.region, 'Type the state, province or region.')} />
              )}
            </Grid>
            <Grid item xs={12} sm={6}>
              <Autocomplete
                options={catalog.time_zones}
                value={zone}
                onChange={(_, z) => z && set('time_zone', z.name)}
                getOptionLabel={(z) => `${z.name.replace(/_/g, ' ')} (${z.offset})`}
                isOptionEqualToValue={(a, b) => a.name === b.name}
                disableClearable
                renderInput={(p) => (
                  <TextField {...p} label="Time Zone" required error={!!errors.time_zone}
                    helperText={helper(errors.time_zone, 'Current offset shown; daylight saving is applied automatically.')} />
                )}
              />
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Date Format" value={form.date_format}
                onChange={(e) => set('date_format', e.target.value)} error={!!errors.date_format}
                helperText={helper(errors.date_format, 'How dates appear on screens and printed documents.')}>
                {catalog.date_formats.map((f) => (
                  <MenuItem key={f} value={f}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 2 }}>
                      <span>{f}</span>
                      <Typography component="span" variant="body2" color="text.secondary">{formatDate(SAMPLE_DATE, { date_format: f })}</Typography>
                    </Box>
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Time Format" value={form.time_format}
                onChange={(e) => set('time_format', e.target.value)}
                helperText="12-hour or 24-hour clock.">
                {catalog.time_formats.map((f) => (
                  <MenuItem key={f} value={f}>
                    {f === '12H' ? '12-hour' : '24-hour'} — {formatTime(SAMPLE_DATE, { time_format: f })}
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Fiscal Year Starts" value={form.fiscal_year_start_month}
                onChange={(e) => set('fiscal_year_start_month', Number(e.target.value))}
                error={!!errors.fiscal_year_start_month}
                helperText={helper(errors.fiscal_year_start_month, 'First month of the financial year (reports, {FY} numbering).')}>
                {MONTHS.map((m, i) => <MenuItem key={m} value={i + 1}>{m}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <TextField select fullWidth label="Number Format" value={form.number_format}
                onChange={(e) => set('number_format', e.target.value)} error={!!errors.number_format}
                helperText={helper(errors.number_format, 'Digit grouping and decimal mark for amounts.')}>
                {catalog.number_formats.map((f) => (
                  <MenuItem key={f} value={f}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', width: '100%', gap: 2 }}>
                      <span>{NUMBER_FORMAT_LABELS[f] || f}</span>
                      <Typography component="span" variant="body2" color="text.secondary">{formatNumber(123456.78, 2, { number_format: f })}</Typography>
                    </Box>
                  </MenuItem>
                ))}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={6}>
              <Autocomplete
                options={catalog.languages}
                value={language}
                onChange={(_, l) => l && setMany({
                  language: l.code,
                  // A language without bill wording can only print English bills.
                  ...(hasBillTranslation(l.code) ? {} : { bill_language_mode: 'EN' }),
                })}
                getOptionLabel={(l) => (l.native && l.native !== l.name ? `${l.native} — ${l.name}` : l.name)}
                isOptionEqualToValue={(a, b) => a.code === b.code}
                disableClearable
                renderInput={(p) => (
                  <TextField {...p} label="Default Language" error={!!errors.language || !!errors.enabled_languages}
                    helperText={helper(errors.language || errors.enabled_languages,
                      language && language.code !== 'en'
                        ? (billCanTranslate
                          ? 'Bills can print in this language (below). The app screens stay in English.'
                          : 'Saved as the business language. Bills and screens stay in English for this language.')
                        : 'Language for documents and communication.')} />
                )}
              />
            </Grid>
            <Grid item xs={12}>
              <TextField select fullWidth label="Bills & Documents Print In" value={billMode}
                onChange={(e) => set('bill_language_mode', e.target.value)}
                error={!!errors.bill_language_mode}
                helperText={helper(errors.bill_language_mode, billCanTranslate
                  ? `Sample: ${billSample(billMode)} — headings, totals and captions only; names and items print as entered.`
                  : 'Bills can print in Arabic, Hindi, Malayalam or Tamil. Choose one of those as the default language to enable it.')}>
                <MenuItem value="EN">English only</MenuItem>
                <MenuItem value="LOCAL" disabled={!billCanTranslate}>{langName} only</MenuItem>
                <MenuItem value="BILINGUAL" disabled={!billCanTranslate}>English + {langName} (bilingual)</MenuItem>
              </TextField>
            </Grid>
          </Grid>
        </SectionCard>
      </Grid>

      {/* RIGHT — preferences + quick configuration */}
      <Grid item xs={12} lg={6}>
        <SectionCard
          id="transaction-prefs"
          icon={<ConfirmIcon />}
          title="Document & Transaction Preferences"
          subtitle="Configure how documents and transactions behave in the system."
          sx={{ mb: 3 }}
        >
          <PrefToggleRow id="pref-currency-symbol" icon={<CurrencyIcon />} title="Show Currency Symbol"
            description="Print the currency symbol beside amounts on bills and other documents."
            checked={form.show_currency_symbol} onChange={(v) => set('show_currency_symbol', v)} dirty={dirty('show_currency_symbol')} />
          <PrefToggleRow id="pref-negative-stock" icon={<StockIcon />} title="Allow Negative Stock"
            description={form.allow_negative_stock
              ? 'Sales and adjustments may take stock below zero.'
              : 'Sales and adjustments that would take stock below zero are refused; a Super Admin or Administrator can override a sale.'}
            checked={form.allow_negative_stock} onChange={(v) => set('allow_negative_stock', v)} dirty={dirty('allow_negative_stock')} />
          <PrefToggleRow id="pref-auto-number" icon={<NumberIcon />} title="Auto-generate Document Numbers"
            description="Number sales invoices, orders, quotations, purchase bills and purchase orders from the Numbering Sequences."
            checked={form.auto_generate_numbers} onChange={(v) => set('auto_generate_numbers', v)} dirty={dirty('auto_generate_numbers')} />
          <PrefToggleRow id="pref-multi-currency" icon={<ExchangeIcon />} title="Enable Multi-currency Transactions"
            description="Allow the additional currencies and exchange rates set under Currency & Language."
            checked={form.multi_currency_enabled} onChange={(v) => set('multi_currency_enabled', v)}
            error={errText(errors.multi_currency_enabled)} dirty={dirty('multi_currency_enabled')} />
          <PrefToggleRow id="pref-confirm-posting" icon={<ConfirmIcon />} title="Require Confirmation Before Posting"
            description="Ask before a sales invoice, purchase entry or stock adjustment is posted."
            checked={form.confirm_before_posting} onChange={(v) => set('confirm_before_posting', v)} dirty={dirty('confirm_before_posting')} />
        </SectionCard>

        <SectionCard
          id="quick-config"
          icon={<GlobeIcon />}
          title="Quick Configuration"
          subtitle="Quickly access and configure other important settings."
        >
          <QuickLinkRow icon={<GlobeIcon />} title="Currency & Language"
            description="Manage currencies, exchange rates, and language options." onClick={() => onNavigate('currency')} />
          <QuickLinkRow icon={<PercentIcon />} title="Tax Configuration"
            description="Set up tax rates, tax types, and related tax settings." onClick={() => onNavigate('tax')} />
          <QuickLinkRow icon={<NumberedIcon />} title="Numbering Sequences"
            description="Configure document prefixes, starting numbers, and sequence formats." onClick={() => onNavigate('numbering')} />
        </SectionCard>
      </Grid>
    </Grid>
  );
}
