// Centralized keyboard shortcut manager for the Wholesale POS.
//
// WHOLESALE_SHORTCUTS is the single source of truth: the window listener matches against it and
// the help dialog (WholesaleShortcutHelpDialog) renders it, so the two can never drift apart.
// Entries with `global: false` are documented only — they are handled by the field that owns
// them (search box, entry row, billing grid, toggle groups), not by the window listener.
//
// Safety rules applied by useWholesaleShortcuts:
//   • Only keys pressed inside the POS root (or with nothing focused) are handled; a key typed
//     into some unrelated control elsewhere on the page is left alone.
//   • While any MUI dialog / menu / popover is open nothing runs — the dialog owns the keyboard
//     (Escape closes it natively). Browser defaults that would wipe the cart (F5 reload, F1 help…)
//     are still blocked.
//   • Keys that edit text (Delete, Escape, `?`) are skipped while the cursor is in a text field
//     unless the entry says otherwise; F-keys and Ctrl/Alt chords never type, so they always
//     target the POS form.
//   • Auto-repeat (holding a key down) never re-fires an action.
//   • A handler that already handled the key (e.defaultPrevented) wins over the global map.
//   • One listener, registered once; handlers are read through a ref so re-renders don't re-bind.

import { useEffect, useRef } from 'react';

export const WHOLESALE_SHORTCUTS = [
  // Dealer
  { id: 'dealerSearch', keys: ['F1'], group: 'Dealer', label: 'Focus Wholesale Dealer search' },
  { id: 'newDealer', keys: ['F2', 'Alt+N'], group: 'Dealer', label: 'Open New Dealer' },
  { id: 'changeDealer', keys: ['F3'], group: 'Dealer', label: 'Change dealer (focus dealer search and open the list)' },
  // Product entry
  { id: 'tabProduct', keys: ['F4'], group: 'Product entry', label: 'Select Product tab' },
  { id: 'productSearch', keys: ['F7'], group: 'Product entry', label: 'Focus barcode / product search (results list in the billing grid)' },
  { id: 'grid', keys: ['F9'], group: 'Product entry', label: 'Edit bill lines — jump to the Qty cell of the selected (or last) line' },
  { id: 'bulkAdd', keys: ['Ctrl+B'], group: 'Product entry', label: 'Open Bulk Add' },
  { id: 'excelImport', keys: ['Ctrl+I'], group: 'Product entry', label: 'Open Excel Import' },
  { id: 'schemes', keys: ['Ctrl+D'], group: 'Product entry', label: 'Open Discounts / Schemes' },
  { id: 'reorderLast', keys: ['Alt+R'], group: 'Product entry', label: "Reorder the dealer's last invoice" },
  { id: 'cyclePriceList', keys: ['Alt+L'], group: 'Product entry', label: 'Cycle price list (Wholesale → Retail → Special)' },
  // Cart
  { id: 'removeRow', keys: ['Delete'], group: 'Billing grid', label: 'Remove the selected cart line (asks to confirm)', whileTyping: false },
  // Payment & completion
  { id: 'coupon', keys: ['Ctrl+U'], group: 'Payment', label: 'Focus Coupon Code' },
  { id: 'payment', keys: ['Ctrl+M'], group: 'Payment', label: 'Go to Payment Mode' },
  { id: 'preview', keys: ['Ctrl+P'], group: 'Payment', label: 'Show Bill / Print Preview' },
  { id: 'complete', keys: ['Ctrl+Enter'], group: 'Payment', label: 'Validate and complete the wholesale invoice (asks to confirm)' },
  { id: 'saveDraft', keys: ['Alt+S'], group: 'Payment', label: 'Save as Draft' },
  { id: 'hold', keys: ['Alt+H'], group: 'Payment', label: 'Hold invoice' },
  // Delivery
  { id: 'delivery', keys: ['Alt+D'], group: 'Delivery', label: 'Go to Delivery section' },
  { id: 'packing', keys: ['Alt+P'], group: 'Delivery', label: 'Expand and go to Packing & Dispatch' },
  // General
  { id: 'escape', keys: ['Escape'], group: 'General', label: 'Close dialog / hide search results, clear the search, or leave a grid cell (line stays selected for Delete)', whileTyping: true },
  { id: 'help', keys: ['Ctrl+/', 'Shift+?'], group: 'General', label: 'Open this shortcut help' },

  // Field-level keys (handled by the control that has focus — documented here for the help panel)
  { id: 'enter', keys: ['Enter'], group: 'Field keys', global: false, label: 'Add the highlighted search result to the bill / move to the next grid cell' },
  { id: 'shiftEnter', keys: ['Shift+Enter'], group: 'Field keys', global: false, label: 'Previous cell in the billing grid' },
  { id: 'arrows', keys: ['↑', '↓'], group: 'Field keys', global: false, label: 'Move through search results, dealer list, or grid rows (same column); ↓ from an empty search enters the grid' },
  { id: 'pageKeys', keys: ['PgUp', 'PgDn', 'Ctrl+Home', 'Ctrl+End'], group: 'Field keys', global: false, label: 'Jump through the search results list (8 at a time / first / last)' },
  { id: 'leftRight', keys: ['←', '→'], group: 'Field keys', global: false, label: 'Switch Payment Mode / Delivery type when that toggle has focus' },
  { id: 'plusMinus', keys: ['+', '−'], group: 'Field keys', global: false, label: 'Increase / decrease quantity in a grid Qty cell' },
  { id: 'ctrlDelete', keys: ['Ctrl+Delete'], group: 'Field keys', global: false, label: 'Remove the line whose cell has the cursor (asks to confirm)' },
  { id: 'tab', keys: ['Tab', 'Shift+Tab'], group: 'Field keys', global: false, label: 'Next / previous control' },
  { id: 'ctrlK', keys: ['Ctrl+K'], group: 'Field keys', global: false, label: 'Not used here — the app has no global search, so the browser keeps it' },
];

// "Ctrl+Shift+Enter"-style name for a keydown event. Ctrl and Cmd are treated alike. AltGr
// (Ctrl+Alt on Windows) never matches an Alt-only chord, so international layouts can type.
export const comboFromEvent = (e) => {
  let key = e.key || '';
  if (key === ' ') key = 'Space';
  else if (key.length === 1) key = key.toUpperCase();
  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('Ctrl');
  if (e.altKey) parts.push('Alt');
  // Shift is part of the character for printable keys ("?" is Shift+/), so only name it for
  // named keys and for the explicit "Shift+?" help chord.
  if (e.shiftKey && (key.length > 1 || key === '?')) parts.push('Shift');
  parts.push(key);
  return parts.join('+');
};

const buildComboIndex = (shortcuts) => {
  const map = new Map();
  shortcuts.filter(s => s.global !== false).forEach(s => {
    s.keys.forEach(k => {
      const norm = k.split('+').map(p => (p.length === 1 ? p.toUpperCase() : p)).join('+');
      map.set(norm, s);
    });
  });
  return map;
};

const isTextEditable = (el) => {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return true;
  if (tag !== 'INPUT') return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'range', 'color'].includes((el.type || '').toLowerCase());
};

// Any open MUI dialog / menu / popover (all are Modals) owns the keyboard.
const modalOpen = () => Boolean(document.querySelector('.MuiModal-root:not(.MuiModal-hidden)'));

// Builds a shortcut hook for one screen's map. `blockedCombos` are browser chords whose default
// action must never fire on that screen (F5 reload or Ctrl+P print would lose or bypass the
// cart); every mapped F-key is blocked too. Used by Wholesale POS and New Sale.
// `pageWide`: keys count wherever focus is on the page (sidebar link, toolbar button…), not only
// inside rootRef — otherwise F1 pressed right after clicking the sidebar opens Chrome's help. It
// also listens in the capture phase so no component can swallow a shortcut first.
export const makeShortcutHook = (shortcuts, blockedCombos = [], { pageWide = false } = {}) => {
  const comboIndex = buildComboIndex(shortcuts);
  // Explicitly blocked chords are suppressed even when no shortcut is mapped to them.
  const blockedSet = new Set(blockedCombos);
  const blocksBrowserDefault = (combo) => /^F([1-9]|1[0-2])$/.test(combo) || blockedCombos.includes(combo);
  return function useScreenShortcuts(rootRef, handlers) {
    useShortcutListener(rootRef, handlers, comboIndex, blocksBrowserDefault, pageWide, blockedSet);
  };
};

function useShortcutListener(rootRef, handlers, comboIndex, blocksBrowserDefault, pageWide, blockedSet) {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.isComposing) return;
      const combo = comboFromEvent(e);
      const def = comboIndex.get(combo);
      if (!def && !blockedSet.has(combo)) return;

      const root = rootRef.current;
      const target = e.target;
      const nothingFocused = !target || target === document.body || target === document.documentElement;
      const inside = pageWide || nothingFocused || Boolean(root && root.contains(target));
      const dialogOpen = modalOpen();

      if (blocksBrowserDefault(combo) && (inside || dialogOpen)) e.preventDefault();
      if (!def || !inside || dialogOpen) return;
      if (e.defaultPrevented && !blocksBrowserDefault(combo)) return; // a field already handled it
      if (e.repeat) return;
      if (def.whileTyping === false && isTextEditable(target)) return;
      if (combo === 'Shift+?' && isTextEditable(target)) return; // "?" is a typed character there

      const run = handlersRef.current?.[def.id];
      if (!run) return;
      const handled = run(e);
      if (handled !== false) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown, pageWide);
    return () => window.removeEventListener('keydown', onKeyDown, pageWide);
  }, [rootRef, comboIndex, blocksBrowserDefault, pageWide, blockedSet]);
}

export const useWholesaleShortcuts = makeShortcutHook(WHOLESALE_SHORTCUTS, [
  'F5', // unmapped since the Lens tab went, but a reload would still wipe the cart
  'Ctrl+B', 'Ctrl+I', 'Ctrl+D', 'Ctrl+U', 'Ctrl+M', 'Ctrl+P', 'Alt+D', 'Alt+P', 'Alt+N', 'Alt+S', 'Alt+H', 'Alt+R', 'Alt+L', 'Ctrl+/',
]);
