// Keyboard shortcut map for Add Multiple Items / Product Variant Master.
//
// VARIANT_SHORTCUTS drives both the key handler (useVariantShortcuts) and the help panel, so the
// two can't drift. Unlike the POS screens this map lives inside a dialog, so the handler is
// attached to the dialog itself (not window): it can never fire on the page underneath, and the
// page's own shortcuts are stopped from seeing keys handled here. Entries with `global: false`
// are documented only — the focused field / grid cell handles them.

import { useCallback, useRef } from 'react';
import { comboFromEvent } from '../../../pages/wholesale/posShortcuts';

export const VARIANT_SHORTCUTS = [
  { id: 'focusName', keys: ['F2'], group: 'Product', label: 'Go to Product Name (Shift+F2: find an existing product)' },
  { id: 'findExisting', keys: ['Shift+F2'], group: 'Product', label: 'Find an existing product to add variants to' },
  { id: 'generator', keys: ['F4'], group: 'Variants', label: 'Open / go to Generate Multiple Variants' },
  { id: 'primary', keys: ['Ctrl+Enter'], group: 'Variants', label: 'In the generator: generate variants. Elsewhere: add the rows to the purchase (Purchase Entry) or save (Inventory)' },
  { id: 'save', keys: ['Ctrl+S'], group: 'Save', label: 'Save the items to the Product Master' },
  { id: 'addRow', keys: ['Alt+N', 'Insert'], group: 'Grid', label: 'Add a blank row' },
  { id: 'duplicateRow', keys: ['Ctrl+D', 'Alt+D'], group: 'Grid', label: 'Duplicate the ticked rows (or the row with the cursor) with all their details' },
  { id: 'selectAll', keys: ['Ctrl+Shift+A'], group: 'Grid', label: 'Select / unselect all visible rows (Ctrl+A also works when the cursor is not in a text cell)' },
  { id: 'selectAllPlain', keys: ['Ctrl+A'], group: 'Grid', global: true, whileTyping: false, hidden: true, label: '' },
  { id: 'deleteRows', keys: ['Delete'], group: 'Grid', whileTyping: false, label: 'Remove the selected rows (asks to confirm)' },
  { id: 'deleteRowCtrl', keys: ['Ctrl+Delete'], group: 'Grid', label: 'Remove the selected rows, or the row with the cursor (asks to confirm)' },
  { id: 'filter', keys: ['Ctrl+F'], group: 'Grid', label: 'Search / filter the rows' },
  { id: 'help', keys: ['Ctrl+/'], group: 'General', label: 'Show this shortcut help' },
  { id: 'escape', keys: ['Escape'], group: 'General', global: false, label: 'Close a dropdown, then the dialog (asks first when there are unsaved changes)' },
  { id: 'cellKeys', keys: ['↑', '↓', '←', '→'], group: 'Grid', global: false, label: 'Move between grid cells (← / → at the start / end of the text)' },
  { id: 'enter', keys: ['Enter'], group: 'Grid', global: false, label: 'Next cell; from the last cell, the next row' },
  { id: 'tab', keys: ['Tab', 'Shift+Tab'], group: 'General', global: false, label: 'Next / previous control' },
];

const comboIndex = new Map();
VARIANT_SHORTCUTS.filter(s => s.global !== false).forEach(s => s.keys.forEach(k => comboIndex.set(k, s)));

const isTextEditable = (el) => {
  if (!el) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && !['checkbox', 'radio', 'button', 'submit', 'file'].includes((el.type || '').toLowerCase());
};

// Returns an onKeyDown handler for the dialog root.
export function useVariantShortcuts(handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  return useCallback((e) => {
    if (e.isComposing || e.nativeEvent?.isComposing) return;
    let combo = comboFromEvent(e);
    if (combo === 'Ctrl+A' && e.shiftKey) combo = 'Ctrl+Shift+A';
    const def = comboIndex.get(combo);
    if (!def) return;
    // A nested popup (dropdown, menu, confirm) owns its keys.
    if (e.target?.closest?.('[role="listbox"], [role="menu"]')) return;
    // So does a field's "+" option master (AttributeField's own dialog).
    if (e.target?.closest?.('[data-nav-own]')) return;
    if (def.whileTyping === false && isTextEditable(e.target)) return;
    if (e.repeat && def.id !== 'addRow') { e.preventDefault(); return; }
    const run = ref.current?.[def.id];
    if (!run) return;
    if (run(e) !== false) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, []);
}
