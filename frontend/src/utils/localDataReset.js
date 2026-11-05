// Drop this browser's cached business records after the server database has been wiped.
//
// Sales, patients, payments etc. are mirrored into localStorage, and the Sales screens merge
// those copies back into what the API returns (so offline work is never lost). After
// `manage.py wipe_database` that merge resurrects every deleted row. The wipe stamps a
// marker that /api/health/ reports as `data_reset_epoch`; the first time a browser sees a new
// one it removes the keys below and reloads. Settings, branches and the login session are
// left alone.
//
// The same merge also resurrected rows from a *different* database (the backend was repointed
// from `neondb` to `Uae client` on 2026-10-30) or a different tenant signing in on the same
// browser, so clearLocalDataIfScopeChanged() drops them when either of those changes too.
import { clearMasterCache } from './masterDataCache.js';

const EPOCH_KEY = 'optical_data_reset_epoch';
const SCOPE_KEY = 'optical_data_scope';

const TRANSACTIONAL_KEYS = [
  'optical_sales_invoices', 'optical_sales_orders', 'optical_sales_quotations',
  'optical_sales_payments', 'optical_sales_customers', 'optical_payments',
  'optical_customers', 'optical_patients', 'optical_eye_exams', 'optical_eye_tests',
  'optical_appointments', 'optical_journal_entries', 'optical_purchase_orders',
  'optical_supplier_payments_db', 'optical_sms_logs', 'optical_whatsapp_logs',
  'optical_inventory_items', 'optical_wholesale_customers',
  // Master lists the wipe also empties (masters app); stale copies would reappear in pickers.
  'optical_categories_db', 'optical_brands_db', 'optical_suppliers', 'optical_suppliers_db',
  'optical_suppliers_backend_cache',
  // Wholesale POS caches (wholesaleConstants.js STORAGE_KEYS).
  'optical_wholesale_invoices', 'optical_wholesale_held_invoices', 'optical_wholesale_schemes',
  'optical_wholesale_special_prices', 'optical_wholesale_returns', 'optical_wholesale_credit_notes',
];

// A wipe keeps the business (and so its settings and branches); a different database or
// tenant is a different business, so its settings, branch choice and templates go too.
const BUSINESS_SCOPED_KEYS = [
  'optical_app_settings', 'business_prefs_cache', 'active_branch_id', 'optical_branches',
  'optical_label_templates_cache',
  // Inventory → Opening Stock's unsaved manual grid belongs to the business it was typed for.
  'opening_stock_manual_draft',
];

function clearKeys(keys) {
  keys.forEach((key) => localStorage.removeItem(key));
  clearMasterCache();
}

/** Returns true when the cache was cleared (the caller should reload). */
export function clearLocalDataIfReset(serverEpoch) {
  if (!serverEpoch) return false;
  try {
    if (localStorage.getItem(EPOCH_KEY) === serverEpoch) return false;
    clearKeys(TRANSACTIONAL_KEYS);
    localStorage.setItem(EPOCH_KEY, serverEpoch);
    return true;
  } catch {
    return false; // storage blocked — nothing cached to clear
  }
}

/**
 * Record which database (`part` 'database', /api/health/'s db_instance) or tenant (`part`
 * 'tenant', the JWT tenant_id) this browser's cache belongs to, and clear the cache when it
 * changes. The first value ever seen is only recorded: the cache may hold offline work for it.
 * Returns true when the cache was cleared.
 */
export function clearLocalDataIfScopeChanged(part, value) {
  if (value === null || value === undefined || value === '') return false;
  const current = String(value);
  try {
    let scope = {};
    try { scope = JSON.parse(localStorage.getItem(SCOPE_KEY) || '{}') || {}; } catch { /* corrupt — rewrite */ }
    const previous = scope[part];
    if (previous === current) return false;
    if (previous) clearKeys([...TRANSACTIONAL_KEYS, ...BUSINESS_SCOPED_KEYS]);
    localStorage.setItem(SCOPE_KEY, JSON.stringify({ ...scope, [part]: current }));
    return Boolean(previous);
  } catch {
    return false;
  }
}
