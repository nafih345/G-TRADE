// Pure, synchronous number / money / date formatting driven by the Business & Localization
// preferences. No React / axios here: the bill renderer imports it and also runs under plain
// `node --test`. utils/businessPrefs.js fetches the preferences and feeds them in.
const LOCAL_KEY = 'business_prefs_cache';
export const BUSINESS_PREFS_EVENT = 'business_prefs_updated';

// Mirrors DEFAULTS in backend apps/company/localization.py.
export const DEFAULT_PREFS = {
  country: 'IN', region: 'Kerala', time_zone: 'Asia/Kolkata', date_format: 'DD-MM-YYYY', time_format: '12H',
  fiscal_year_start_month: 4, number_format: 'INDIAN', language: 'en', bill_language_mode: 'EN',
  show_currency_symbol: true, allow_negative_stock: true, auto_generate_numbers: true,
  multi_currency_enabled: false, confirm_before_posting: false,
  base_currency: 'INR', currency_decimals: 2, enabled_currencies: [], exchange_rates: {}, enabled_languages: ['en'],
  rounding_method: 'NONE', quantity_decimals: 0, default_payment_terms_days: 0, default_sale_status: 'UNPAID',
  default_discount_mode: 'PERCENT', max_discount_percent: 100, service_charge_percent: 0, service_charge_on: 'NONE',
  default_customer_city: '', lens_single_piece_percent: 50, tax_enabled: true,
};

// group separator, decimal separator, Indian lakh grouping — mirrors NUMBER_FORMATS.
export const NUMBER_FORMATS = {
  INDIAN: [',', '.', true],
  INTERNATIONAL: [',', '.', false],
  EUROPEAN: ['.', ',', false],
  SPACE: [' ', ',', false],
  SWISS: ["'", '.', false],
};

export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September',
  'October', 'November', 'December'];
const MON = MONTHS.map((m) => m.slice(0, 3));

const readLocal = () => {
  try {
    const raw = JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
};

// Display symbol per ISO code. Codes whose symbol is ambiguous or unfamiliar print as the code
// itself ("QAR 120.00"). Mirrors CURRENCIES in backend apps/company/localization.py.
export const CURRENCY_SYMBOLS = {
  INR: '₹', QAR: 'QAR', USD: '$', AED: 'AED', SAR: 'SAR', OMR: 'OMR', KWD: 'KWD', BHD: 'BHD', EUR: '€', GBP: '£',
};

/** ISO code → the symbol printed with amounts (unknown codes print as the code). */
export function symbolForCurrency(code) {
  const c = String(code || '').trim().toUpperCase();
  return CURRENCY_SYMBOLS[c] || c || '₹';
}

// The symbol actually shown. The saved symbol wins (a store may type its own, e.g. "QR"),
// except a rupee left behind after the base currency was switched away from INR — that one is
// stale and the base currency's own symbol is shown instead.
function resolveSymbol(stored, prefs) {
  const base = String(prefs?.base_currency || 'INR').toUpperCase();
  const sym = String(stored || '').trim();
  if (!sym) return symbolForCurrency(base);
  if (base !== 'INR' && (sym === '₹' || sym.toUpperCase() === 'INR')) return symbolForCurrency(base);
  return sym;
}

// ---------------------------------------------------------------------------
// Tax terminology — what the tax and its registration number are called in the business's
// country. Mirrors tax_terms() in backend apps/company/localization.py.
// ---------------------------------------------------------------------------
const GULF_VAT = new Set(['AE', 'SA', 'OM', 'BH']);
const EU_VAT = new Set(['GB', 'IE', 'DE', 'FR', 'IT', 'ES', 'NL', 'AT', 'BE', 'PT', 'GR', 'FI', 'SE', 'DK', 'PL', 'CZ', 'LU']);

/** Country code → {label, regLabel}: GST/GSTIN, VAT/TRN, VAT/VAT No, Sales Tax/Tax ID, Tax/Tax Registration No. */
export function taxTermsForCountry(country) {
  const c = String(country || '').toUpperCase();
  if (c === 'IN') return { label: 'GST', regLabel: 'GSTIN' };
  if (GULF_VAT.has(c)) return { label: 'VAT', regLabel: 'TRN' };
  if (EU_VAT.has(c)) return { label: 'VAT', regLabel: 'VAT No' };
  if (c === 'US') return { label: 'Sales Tax', regLabel: 'Tax ID' };
  return { label: 'Tax', regLabel: 'Tax Registration No' };
}

let state = (() => {
  const local = readLocal();
  const preferences = { ...DEFAULT_PREFS, ...(local?.preferences || {}) };
  return {
    preferences,
    currency_symbol: resolveSymbol(local?.currency_symbol, preferences),
    tax_registration_number: local?.tax_registration_number || '',
    loaded: false,
  };
})();
export function publishBusinessPrefs(payload) {
  const preferences = { ...DEFAULT_PREFS, ...(payload?.preferences || {}) };
  state = {
    preferences,
    currency_symbol: resolveSymbol(payload?.currency_symbol, preferences),
    tax_registration_number: payload?.tax_registration_number ?? state.tax_registration_number ?? '',
    loaded: true,
  };
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({
      preferences: state.preferences, currency_symbol: state.currency_symbol,
      tax_registration_number: state.tax_registration_number,
    }));
  } catch { /* storage unavailable */ }
  try { window.dispatchEvent(new CustomEvent(BUSINESS_PREFS_EVENT, { detail: state })); } catch { /* not a browser */ }
  return state;
}

/** Current preferences (synchronous; the cached / default copy until the first fetch lands). */
export const getBusinessPrefs = () => state.preferences;
export const getCurrencySymbol = () => state.currency_symbol;
export const getCurrencyCode = () => String(state.preferences.base_currency || 'INR').toUpperCase();
/** Symbol ready to sit in front of a number: "₹", "$", but "QAR " (codes get a space). */
export const currencyPrefix = (symbol = getCurrencySymbol()) => (symbol && /[A-Za-z.]$/.test(symbol) ? `${symbol} ` : symbol || '');
export const getBusinessPrefsState = () => state;

/** Tax Configuration master switch (Settings → Business & Localization → Tax Configuration). */
export const isTaxEnabled = (prefs = getBusinessPrefs()) => prefs?.tax_enabled !== false;
/** "GST" / "VAT" / "Sales Tax" / "Tax" for the configured country. */
export const getTaxLabel = (prefs = getBusinessPrefs()) => taxTermsForCountry(prefs?.country).label;
/** "GSTIN" / "TRN" / "VAT No" / "Tax ID" / "Tax Registration No". */
export const getTaxRegLabel = (prefs = getBusinessPrefs()) => taxTermsForCountry(prefs?.country).regLabel;
/** India's GST splits into CGST + SGST (intra-state) — only show that split for GST. */
export const isGstSplit = (prefs = getBusinessPrefs()) => getTaxLabel(prefs) === 'GST';
/** {isTaxEnabled, taxLabel, taxRegLabel, taxRegistrationNumber} — synchronous snapshot. */
export function getTaxSettings(prefs = getBusinessPrefs()) {
  const terms = taxTermsForCountry(prefs?.country);
  return {
    isTaxEnabled: isTaxEnabled(prefs),
    taxLabel: terms.label,
    taxRegLabel: terms.regLabel,
    taxRegistrationNumber: state.tax_registration_number || '',
  };
}
/** The rate to charge on a NEW line: the given % while tax is on, 0 while it is switched off.
 *  (Saved documents keep the rate they were billed at — don't run stored rates through this.) */
export function effectiveTaxPercent(rate, prefs = getBusinessPrefs()) {
  if (!isTaxEnabled(prefs)) return 0;
  const n = typeof rate === 'number' ? rate : parseFloat(String(rate ?? '').replace('%', ''));
  return Number.isFinite(n) ? n : 0;
}
/** Replace the word GST in a fixed English label with the active tax label ("GST 18%" → "VAT 18%"). */
export const taxText = (text, prefs = getBusinessPrefs()) => String(text ?? '').replace(/\bGST\b/g, getTaxLabel(prefs));

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function groupDigits(intPart, sep, indian) {
  if (!sep) return intPart;
  if (indian && intPart.length > 3) {
    const last3 = intPart.slice(-3);
    const rest = intPart.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, sep);
    return `${rest}${sep}${last3}`;
  }
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
}

/** 123456.785 → "1,23,456.79" (INDIAN) / "123.456,79" (EUROPEAN) … */
export function formatNumber(value, decimals = 2, prefs = getBusinessPrefs()) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return '';
  const [sep, dec, indian] = NUMBER_FORMATS[prefs.number_format] || NUMBER_FORMATS.INDIAN;
  const fixed = Math.abs(n).toFixed(Math.max(0, decimals));
  const [i, f] = fixed.split('.');
  const out = `${groupDigits(i, sep, indian)}${f ? dec + f : ''}`;
  return n < 0 && Number(fixed) !== 0 ? `-${out}` : out;
}

/** Amount with the configured symbol (unless "Show Currency Symbol" is off) and decimals.
 *  '' for a missing / non-numeric value. */
export function formatMoney(value, { symbol, decimals, prefs = getBusinessPrefs() } = {}) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return '';
  const body = formatNumber(Math.abs(n), decimals ?? prefs.currency_decimals ?? 2, prefs);
  const sym = prefs.show_currency_symbol ? currencyPrefix(symbol ?? getCurrencySymbol()) : '';
  return `${n < 0 ? '-' : ''}${sym}${body}`;
}

/** formatMoney for display figures: a missing / non-numeric amount shows as 0
 *  ("QAR 0.00") instead of disappearing. */
export function formatCurrency(amount, opts = {}) {
  const n = typeof amount === 'number' ? amount : parseFloat(String(amount ?? '').replace(/,/g, ''));
  return formatMoney(Number.isFinite(n) ? n : 0, opts);
}

const pad = (v) => String(v).padStart(2, '0');

function toDate(value) {
  if (value instanceof Date) return value;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [y, m, d] = value.split('-').map(Number);
    return new Date(y, m - 1, d);
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Date in the configured format (DD-MM-YYYY, MM/DD/YYYY, DD MMM YYYY …). */
export function formatDate(value, prefs = getBusinessPrefs()) {
  const d = value ? toDate(value) : null;
  if (!d) return '';
  const parts = { DD: pad(d.getDate()), MM: pad(d.getMonth() + 1), YYYY: String(d.getFullYear()), MMM: MON[d.getMonth()] };
  return (prefs.date_format || 'DD-MM-YYYY').replace(/YYYY|MMM|MM|DD/g, (t) => parts[t]);
}

/** Time in the configured 12 / 24-hour style. */
export function formatTime(value, prefs = getBusinessPrefs()) {
  const d = value ? toDate(value) : null;
  if (!d) return '';
  if (prefs.time_format === '24H') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const h = d.getHours() % 12 || 12;
  return `${pad(h)}:${pad(d.getMinutes())} ${d.getHours() < 12 ? 'AM' : 'PM'}`;
}
