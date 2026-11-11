// Keyboard map for Purchase Entry and the Lens Purchase Order dialogs. One list per surface: the
// handlers match against these combos and the Ctrl+/ help dialog renders them, so the two can't
// drift apart. Entries with `global: false` are documented only (handled by the field itself).
//
// Field-to-field movement everywhere is the shared Enter chain (pages/wholesale/keyboardNav.js):
// Enter → next field, ↑/↓ → previous / next field, Enter on a list picks the highlighted option and
// moves on, Space / Enter opens a dropdown.
import { comboFromEvent } from '../../pages/wholesale/posShortcuts';
import { getTaxLabel } from '../../utils/localeFormat.js';

const FIELD_KEYS = [
  { id: 'enter', keys: ['Enter'], group: 'Field keys', global: false, label: 'Next field (in a list: pick the highlighted option and move on)' },
  { id: 'arrows', keys: ['↓', '↑'], group: 'Field keys', global: false, label: 'Next / previous field (in an open list: move through the options)' },
  { id: 'esc', keys: ['Esc'], group: 'Field keys', global: false, label: 'Close the list / dialog' },
];

export const PURCHASE_ENTRY_SHORTCUTS = [
  { id: 'date', keys: ['F2'], group: 'Purchase Entry', label: 'Purchase date' },
  { id: 'supplier', keys: ['F3'], group: 'Purchase Entry', label: 'Supplier' },
  { id: 'addSupplier', keys: ['F4'], group: 'Purchase Entry', label: 'Add a new supplier' },
  { id: 'clearSearch', keys: ['F5'], group: 'Purchase Entry', label: 'Clear and focus the product search' },
  { id: 'search', keys: ['F6'], group: 'Purchase Entry', label: 'Product search / barcode' },
  { id: 'batch', keys: ['F7'], group: 'Purchase Entry', label: 'Last line: Batch' },
  { id: 'disc', keys: ['F8'], group: 'Purchase Entry', label: 'Last line: Discount %' },
  { id: 'gst', keys: ['F9'], group: 'Purchase Entry', get label() { return `Last line: ${getTaxLabel()} %`; } },
  { id: 'paid', keys: ['F10'], group: 'Purchase Entry', label: 'Paid amount' },
  { id: 'save', keys: ['Ctrl+S'], group: 'Purchase Entry', label: 'Save purchase' },
  { id: 'print', keys: ['Ctrl+P'], group: 'Purchase Entry', label: 'Save & print' },
  { id: 'new', keys: ['Ctrl+N', 'Esc'], group: 'Purchase Entry', label: 'Clear the form' },
  { id: 'orderSearch', keys: ['Alt+L'], group: 'Customer Orders', label: "Open the Search Order Number window — add a customer order's waiting lenses (↑↓ + Enter to pick)" },
  { id: 'help', keys: ['Ctrl+/'], group: 'Help', label: 'This list' },
  ...FIELD_KEYS,
];

export const LENS_PO_EDITOR_SHORTCUTS = [
  { id: 'addOrder', keys: ['Alt+A'], group: 'Lenses', label: "Add a customer order's lenses (pre-filled as sold)" },
  { id: 'primary', keys: ['Ctrl+Enter'], group: 'Save', label: 'From Purchase Entry: Lenses Received — Add to Purchase Entry. Elsewhere: Submit Order' },
  { id: 'submit', keys: ['Alt+O'], group: 'Save', label: 'Submit Order — one PO per supplier (lenses arrive later)' },
  { id: 'draft', keys: ['Alt+D'], group: 'Save', label: 'Save Draft' },
  { id: 'vendor', keys: ['Alt+V'], group: 'Header', label: 'Supplier' },
  { id: 'remarks', keys: ['Alt+M'], group: 'Header', label: 'Remarks' },
  { id: 'help', keys: ['Ctrl+/'], group: 'Help', label: 'This list' },
  ...FIELD_KEYS,
];

export const LENS_DASHBOARD_SHORTCUTS = [
  { id: 'newPo', keys: ['Alt+N'], group: 'Lens Purchase Order', label: 'New Lens PO' },
  { id: 'search', keys: ['Alt+F'], group: 'Lens Purchase Order', label: 'Search' },
  { id: 'help', keys: ['Ctrl+/'], group: 'Help', label: 'This list' },
];

/** {combo: shortcut id} for the entries a handler acts on. */
export const comboIndex = (shortcuts) => {
  const map = {};
  shortcuts.filter((s) => s.global !== false).forEach((s) => s.keys.forEach((k) => { map[k] = s.id; }));
  return map;
};

/**
 * onKeyDown for a dialog Paper: runs `handlers[id]` for a mapped combo. Keys pressed inside a
 * nested dialog (a portal — React still bubbles its events here) are left to that dialog.
 * A handler returning false leaves the key alone.
 */
export const dialogHotkeys = (shortcuts, getHandlers) => {
  const index = comboIndex(shortcuts);
  return (e) => {
    if (e.isComposing || !e.currentTarget.contains(e.target)) return false;
    const id = index[comboFromEvent(e)];
    const run = id && getHandlers()[id];
    if (!run) return false;
    if (e.repeat) { e.preventDefault(); return true; }
    if (run(e) === false) return false;
    e.preventDefault();
    e.stopPropagation();
    return true;
  };
};
