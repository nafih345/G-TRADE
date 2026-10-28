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
  default_customer_city: '', lens_single_piece_percent: 50,
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

let state = (() => {
  const local = readLocal();
  return {
    preferences: { ...DEFAULT_PREFS, ...(local?.preferences || {}) },
    currency_symbol: local?.currency_symbol || '₹',
    loaded: false,
  };
})();
export function publishBusinessPrefs(payload) {
  state = {
    preferences: { ...DEFAULT_PREFS, ...(payload?.preferences || {}) },
    currency_symbol: payload?.currency_symbol || state.currency_symbol || '₹',
    loaded: true,
  };
  try {
    localStorage.setItem(LOCAL_KEY, JSON.stringify({ preferences: state.preferences, currency_symbol: state.currency_symbol }));
  } catch { /* storage unavailable */ }
  try { window.dispatchEvent(new CustomEvent(BUSINESS_PREFS_EVENT, { detail: state })); } catch { /* not a browser */ }
  return state;
}

/** Current preferences (synchronous; the cached / default copy until the first fetch lands). */
export const getBusinessPrefs = () => state.preferences;
export const getCurrencySymbol = () => state.currency_symbol;
export const getBusinessPrefsState = () => state;

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

/** Amount with the configured symbol (unless "Show Currency Symbol" is off) and decimals. */
export function formatMoney(value, { symbol, decimals, prefs = getBusinessPrefs() } = {}) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return '';
  const body = formatNumber(Math.abs(n), decimals ?? prefs.currency_decimals ?? 2, prefs);
  const sym = prefs.show_currency_symbol ? (symbol ?? getCurrencySymbol()) : '';
  const spaced = sym && /[A-Za-z]$/.test(sym) ? `${sym} ` : sym;
  return `${n < 0 ? '-' : ''}${spaced}${body}`;
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
