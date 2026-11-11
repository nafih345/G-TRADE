// The active currency for display: <CurrencySymbol /> and useCurrency().
//
// The currency lives in the Business & Localization preferences (utils/localeFormat.js holds the
// global copy, cached in localStorage and refreshed from /api/company/localization/). Saving in
// Settings publishes the new copy and fires BUSINESS_PREFS_EVENT, so everything using these
// re-renders with the new symbol straight away — no reload.
import { useEffect, useState } from 'react';
import { Box } from '@mui/material';
import {
  BUSINESS_PREFS_EVENT, getBusinessPrefsState, getCurrencySymbol, getCurrencyCode, currencyPrefix, formatCurrency,
} from '../../utils/localeFormat.js';
import { loadBusinessPrefs } from '../../utils/businessPrefs.js';

/** {symbol, code, prefix, format} — re-renders the caller whenever the currency changes. */
export function useCurrency() {
  const [, setSnap] = useState(getBusinessPrefsState);
  useEffect(() => {
    const on = (e) => setSnap(e.detail || getBusinessPrefsState());
    window.addEventListener(BUSINESS_PREFS_EVENT, on);
    loadBusinessPrefs().then(setSnap).catch(() => {});
    return () => window.removeEventListener(BUSINESS_PREFS_EVENT, on);
  }, []);
  const symbol = getCurrencySymbol();
  return { symbol, code: getCurrencyCode(), prefix: currencyPrefix(symbol), format: formatCurrency };
}

/**
 * The active currency symbol as text — "₹", "$", "QAR". Drop-in for an old rupee icon inside
 * inputs (InputAdornment), table headers, cards and badges. Letter codes such as "QAR" are
 * shrunk slightly so they sit on the same line as the figures without widening the field.
 *   variant="badge" draws it as a small pill (for chips / summary cards).
 */
export default function CurrencySymbol({ variant = 'text', sx, ...rest }) {
  const { symbol } = useCurrency();
  const isCode = /[A-Za-z]{2,}/.test(symbol);
  const base = {
    display: 'inline-flex', alignItems: 'center', lineHeight: 1, whiteSpace: 'nowrap', fontWeight: 'inherit',
    ...(isCode ? { fontSize: '0.8em', letterSpacing: 0.2 } : {}),
  };
  const badge = variant === 'badge'
    ? { px: 0.6, py: 0.25, borderRadius: 1, bgcolor: 'action.hover', fontWeight: 700, fontSize: isCode ? '0.72em' : '0.9em' }
    : {};
  return <Box component="span" aria-label="currency" sx={{ ...base, ...badge, ...sx }} {...rest}>{symbol}</Box>;
}
