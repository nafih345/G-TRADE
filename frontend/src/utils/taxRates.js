// Tax-rate choices for the rate pickers (Product Master, New Sale, Purchase Entry …).
//
// The rates configured in Settings → Business & Localization → Tax Configuration win; until
// some exist, a country-typical fallback list is offered. Labels use the active tax name
// ("5% VAT", "18% GST"). Pure — no React — so screens and tests can share it.
import { getBusinessPrefs, getTaxLabel } from './localeFormat.js';

const FALLBACK = { IN: [0, 5, 12, 18, 28] };

// The active rates last loaded by the SettingsProvider (context/SettingsContext.jsx), so
// non-React helpers and module-level menus can offer them too.
let knownSlabs = [];
export const setKnownTaxSlabs = (slabs) => { knownSlabs = Array.isArray(slabs) ? slabs : []; };
export const getKnownTaxSlabs = () => knownSlabs;
const DEFAULT_FALLBACK = [0, 5, 10, 15, 20];

/** Numeric rates offered: configured slabs (by kind) → country fallback. Always includes 0. */
export function taxRateList(taxSlabs = getKnownTaxSlabs(), { kind = 'sales', prefs = getBusinessPrefs() } = {}) {
  const useful = (taxSlabs || getKnownTaxSlabs() || []).filter((s) => (kind === 'purchases' ? s.appliesToPurchases !== false : s.appliesToSales !== false));
  const base = useful.length
    ? useful.map((s) => Number(s.rate))
    : (FALLBACK[String(prefs?.country || '').toUpperCase()] || DEFAULT_FALLBACK);
  return [...new Set([0, ...base.filter((r) => Number.isFinite(r))])].sort((a, b) => a - b);
}

/** "0% (Exempt)" / "5% VAT". */
export const taxRateLabel = (rate, prefs = getBusinessPrefs()) => (Number(rate) === 0 ? '0% (Exempt)' : `${Number(rate)}% ${getTaxLabel(prefs)}`);

/** [{value, label}] including `current` (so a Select never blanks on a non-standard stored rate). */
export function taxRateChoices(taxSlabs, current, opts = {}) {
  const list = taxRateList(taxSlabs, opts);
  const cur = parseFloat(String(current ?? '').replace('%', ''));
  if (Number.isFinite(cur) && !list.includes(cur)) list.push(cur);
  return list.sort((a, b) => a - b).map((r) => ({ value: r, label: taxRateLabel(r, opts.prefs) }));
}
