// Keyboard map for Purchase Entry and the Lens Purchase Order dialogs. One list per surface: the
// handlers match against these combos and the Ctrl+/ help dialog renders them, so the two can't
// drift apart. Entries with `global: false` are documented only (handled by the field itself).
//
// Field-to-field movement everywhere is the shared Enter chain (pages/wholesale/keyboardNav.js):
// Enter → next field, ↑/↓ → previous / next field, Enter on a list picks the highlighted option and
// moves on, Space / Enter opens a dropdown.
import { comboFromEvent } from '../../pages/wholesale/posShortcuts';

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
  { id: 'gst', keys: ['F9'], group: 'Purchase Entry', label: 'Last line: GST %' },
  { id: 'paid', keys: ['F10'], group: 'Purchase Entry', label: 'Paid amount' },
  { id: 'save', keys: ['Ctrl+S'], group: 'Purchase Entry', label: 'Save purchase' },
  { id: 'print', keys: ['Ctrl+P'], group: 'Purchase Entry', label: 'Save & print' },
  { id: 'new', keys: ['Ctrl+N', 'Esc'], group: 'Purchase Entry', label: 'Clear the form' },
  { id: 'lensMenu', keys: ['Alt+L'], group: 'Lens Purchase Order', label: 'Open the Lens Purchase Order menu (then N / S / P / L, or ↑↓ + Enter)' },
  { id: 'lensMenuN', keys: ['N'], group: 'Lens Purchase Order', global: false, label: 'Menu: New Lens Purchase Order' },
  { id: 'lensMenuS', keys: ['S'], group: 'Lens Purchase Order', global: false, label: 'Menu: Add Split Pair Lens (2 customers)' },
  { id: 'lensMenuP', keys: ['P'], group: 'Lens Purchase Order', global: false, label: 'Menu: Single Customer Pair' },
  { id: 'lensMenuL', keys: ['L'], group: 'Lens Purchase Order', global: false, label: 'Menu: Single Lens (1 piece)' },
  { id: 'help', keys: ['Ctrl+/'], group: 'Help', label: 'This list' },
  ...FIELD_KEYS,
];

export const LENS_PO_EDITOR_SHORTCUTS = [
  { id: 'addSplit', keys: ['Alt+S'], group: 'Lenses', label: 'Add Split Pair Lens (2 customers)' },
  { id: 'addPair', keys: ['Alt+P'], group: 'Lenses', label: 'Add Single Customer Pair' },
  { id: 'addPiece', keys: ['Alt+L'], group: 'Lenses', label: 'Add Single Lens (1 piece)' },
  { id: 'primary', keys: ['Ctrl+Enter'], group: 'Save', label: 'From Purchase Entry: Lenses Received — Add to Purchase Entry. Elsewhere: Submit Order' },
  { id: 'submit', keys: ['Alt+O'], group: 'Save', label: 'Submit Order (lenses arrive later)' },
  { id: 'draft', keys: ['Alt+D'], group: 'Save', label: 'Save Draft' },
  { id: 'vendor', keys: ['Alt+V'], group: 'Header', label: 'Vendor / Laboratory' },
  { id: 'remarks', keys: ['Alt+M'], group: 'Header', label: 'Remarks' },
  { id: 'help', keys: ['Ctrl+/'], group: 'Help', label: 'This list' },
  ...FIELD_KEYS,
];

export const LENS_ITEM_SHORTCUTS = [
  { id: 'type1', keys: ['Alt+1'], group: 'Order type', label: 'Single Customer — 1 Pair (2 Pieces)' },
  { id: 'type2', keys: ['Alt+2'], group: 'Order type', label: 'Split Pair — 2 Customers' },
  { id: 'type3', keys: ['Alt+3'], group: 'Order type', label: 'Single Lens — 1 Piece' },
  { id: 'typeArrows', keys: ['←', '→'], group: 'Order type', global: false, label: 'On the order-type buttons: change the type (Enter moves on)' },
  { id: 'next', keys: ['Ctrl+Enter'], group: 'Steps', label: 'Next step; on Review: Add to PO' },
  { id: 'back', keys: ['Alt+B'], group: 'Steps', label: 'Previous step' },
  { id: 'draft', keys: ['Alt+D'], group: 'Steps', label: 'Save Draft (where offered)' },
  { id: 'editRx', keys: ['Alt+R'], group: 'Prescription', label: 'Unlock the prescription to correct it (a reason is then required)' },
  { id: 'help', keys: ['Ctrl+/'], group: 'Help', label: 'This list' },
  ...FIELD_KEYS,
];

export const LENS_DASHBOARD_SHORTCUTS = [
  { id: 'newPo', keys: ['Alt+N'], group: 'Lens Purchase Order', label: 'New Lens Purchase Order' },
  { id: 'split', keys: ['Alt+S'], group: 'Lens Purchase Order', label: 'Add Split Pair Lens' },
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
