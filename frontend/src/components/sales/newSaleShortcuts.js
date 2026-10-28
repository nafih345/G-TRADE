// Keyboard shortcut map for New Sale (single-screen POS).
//
// NEW_SALE_SHORTCUTS drives both the window listener (useNewSaleShortcuts) and the Ctrl+/ help
// dialog, so the two can't drift. Same safety rules as the Wholesale POS (see posShortcuts.js):
// nothing fires while a dialog / dropdown is open, auto-repeat never re-fires, and F-keys /
// Ctrl / Alt chords work even while the cursor is in a field. Entries with `global: false` are
// documented only — the field that has focus (or an existing listener) handles them.
//
// F-keys follow the Wholesale POS where the two screens overlap (F4/F5/F6 item tabs, F7 search,
// Ctrl+U coupon, Ctrl+M payment, Ctrl+P preview, Ctrl+Enter complete).

import { makeShortcutHook } from '../../pages/wholesale/posShortcuts';

export const NEW_SALE_SHORTCUTS = [
  // Customer & document
  { id: 'customerName', keys: ['F1'], group: 'Customer & document', label: 'Go to Customer Name' },
  { id: 'patient', keys: ['F3'], group: 'Customer & document', label: 'Search patient — type a name, Test No or Patient ID, then ↑/↓ and Enter to pick' },
  { id: 'testNo', keys: ['Alt+T'], group: 'Customer & document', label: 'Go to Test No (loads that eye test)' },
  { id: 'docOrder', keys: ['Alt+O'], group: 'Customer & document', label: 'Switch to Order' },
  { id: 'docInvoice', keys: ['Alt+I'], group: 'Customer & document', label: 'Switch to Invoice' },
  { id: 'docQuotation', keys: ['Alt+Q'], group: 'Customer & document', label: 'Switch to Quotation' },
  { id: 'newSale', keys: ['F2', 'Alt+N'], group: 'Customer & document', global: false, label: 'Add New Details — start the next sale once one is completed' },
  // Prescription
  { id: 'rxGrid', keys: ['F8'], group: 'Prescription', label: 'Go to the Prescription grid (Right eye DV SPH)' },
  { id: 'rxTab', keys: ['Alt+R'], group: 'Prescription', label: 'Show the Prescription tab' },
  { id: 'historyTab', keys: ['Alt+H'], group: 'Prescription', label: 'Show the Power History tab' },
  { id: 'rxToggle', keys: ['Alt+G'], group: 'Prescription', label: 'Show / hide the Prescription grid' },
  { id: 'rxArrows', keys: ['↑', '↓', '←', '→'], group: 'Prescription', global: false, label: 'Move around the grid like a spreadsheet (← / → move once the cursor is at the edge of the value); ↑ from the top row / ↓ from IPD-ADD leaves the grid' },
  // Items
  { id: 'tabProduct', keys: ['F4'], group: 'Items', label: 'Select Product' },
  { id: 'tabLens', keys: ['F5'], group: 'Items', label: 'Select Lens' },
  { id: 'tabService', keys: ['F6'], group: 'Items', label: 'Select Services' },
  { id: 'search', keys: ['F7'], group: 'Items', label: 'Go to the Optical DB Selector (search)' },
  { id: 'power', keys: ['Alt+P'], group: 'Items', label: 'Tick / untick Power' },
  { id: 'newLens', keys: ['Alt+L'], group: 'Items', label: 'Open + NEW Lens' },
  { id: 'removeRow', keys: ['Ctrl+Delete'], group: 'Items', label: 'Remove the billing line whose cell has the cursor' },
  { id: 'lensFocus', keys: ['F9'], group: 'Items', label: 'Go to the lens line (the one with the cursor, else the last one) — then ←/P Pair, →/S Single, R/L eye, E Edit Rx, Enter next' },
  { id: 'lensUnit', keys: ['Alt+U'], group: 'Items', label: 'Lens line: switch Both Eyes (1 Pair) / Single Lens (1 Piece) — the line with the cursor, else the last lens line' },
  { id: 'lensEye', keys: ['Alt+E'], group: 'Items', label: 'Single lens line: switch Right (RE) / Left (LE) eye' },
  { id: 'searchKeys', keys: ['↑', '↓', 'Enter'], group: 'Items', global: false, label: 'In the search box: walk the matches and add the highlighted one (Enter with nothing highlighted highlights the first)' },
  // Payment & completion
  { id: 'coupon', keys: ['Ctrl+U'], group: 'Payment', label: 'Go to Coupon Code' },
  { id: 'advance', keys: ['Alt+A'], group: 'Payment', label: 'Go to Advance Paid' },
  { id: 'payment', keys: ['Ctrl+M'], group: 'Payment', label: 'Go to the pay-mode table (Cash)' },
  { id: 'preview', keys: ['Ctrl+P'], group: 'Payment', label: 'Show Bill' },
  { id: 'complete', keys: ['F10', 'Ctrl+Enter'], group: 'Payment', label: 'Complete the Invoice / Order / Quotation' },
  { id: 'whatsapp', keys: ['Alt+W'], group: 'Payment', global: false, label: 'Share the bill on WhatsApp' },
  // General
  { id: 'help', keys: ['Ctrl+/'], group: 'General', label: 'Open this shortcut help' },
  { id: 'enter', keys: ['Enter'], group: 'General', global: false, label: 'Next field — through customer details, prescription, item entry, billing grid and payment. On + Add Item it adds the item' },
  { id: 'upDown', keys: ['↑', '↓'], group: 'General', global: false, label: 'Previous / next field (date fields keep their arrows)' },
  { id: 'space', keys: ['Space'], group: 'General', global: false, label: 'Open a dropdown (Gender, Payment Mode, Salesman, Category, Index); Enter on Select Patient opens it too' },
  { id: 'tab', keys: ['Tab', 'Shift+Tab'], group: 'General', global: false, label: 'Next / previous control, including buttons' },
];

export const useNewSaleShortcuts = makeShortcutHook(NEW_SALE_SHORTCUTS, [
  'Ctrl+U', 'Ctrl+M', 'Ctrl+P', 'Ctrl+/', 'Alt+T', 'Alt+O', 'Alt+I', 'Alt+Q', 'Alt+R', 'Alt+H', 'Alt+G', 'Alt+P', 'Alt+L', 'Alt+A', 'Alt+U', 'Alt+E',
], { pageWide: true }); // New Sale is the whole page: F1 etc. must never reach Chrome from the sidebar / toolbar
