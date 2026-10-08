// Drop this browser's cached business records after the server database has been wiped.
//
// Sales, patients, payments etc. are mirrored into localStorage, and the Sales screens merge
// those copies back into what the API returns (so offline work is never lost). After
// `manage.py wipe_database` that merge resurrects every deleted row. The wipe stamps a
// marker that /api/health/ reports as `data_reset_epoch`; the first time a browser sees a new
// one it removes the keys below and reloads. Settings, branches and the login session are
// left alone.
const EPOCH_KEY = 'optical_data_reset_epoch';

const TRANSACTIONAL_KEYS = [
  'optical_sales_invoices', 'optical_sales_orders', 'optical_sales_quotations',
  'optical_sales_payments', 'optical_sales_customers', 'optical_payments',
  'optical_customers', 'optical_patients', 'optical_eye_exams', 'optical_eye_tests',
  'optical_appointments', 'optical_journal_entries', 'optical_purchase_orders',
  'optical_supplier_payments_db', 'optical_sms_logs', 'optical_whatsapp_logs',
  'optical_inventory_items', 'optical_wholesale_customers',
  // Master lists the wipe also empties (masters app); stale copies would reappear in pickers.
  'optical_categories_db', 'optical_brands_db', 'optical_suppliers', 'optical_suppliers_db',
];

/** Returns true when the cache was cleared (the caller should reload). */
export function clearLocalDataIfReset(serverEpoch) {
  if (!serverEpoch) return false;
  try {
    if (localStorage.getItem(EPOCH_KEY) === serverEpoch) return false;
    TRANSACTIONAL_KEYS.forEach((key) => localStorage.removeItem(key));
    localStorage.setItem(EPOCH_KEY, serverEpoch);
    return true;
  } catch {
    return false; // storage blocked — nothing cached to clear
  }
}
