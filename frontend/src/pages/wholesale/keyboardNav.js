// Keyboard-only field traversal for the Wholesale Distribution screens.
//
// Spread `navScopeProps` on a container and every editable field inside it becomes part of one
// ordered chain (DOM order):
//   Enter            → next field (Shift+Enter keeps a newline in multiline fields)
//   ArrowDown / Up   → next / previous field, without submitting anything
//
// What each field keeps for itself:
//   • Autocomplete inputs own ArrowUp/Down and Enter while their list is open (dropdown
//     navigation + select). With the list closed, Enter moves on.
//   • Select fields (TextField select) open with Space; Enter/arrows traverse like any field.
//   • Multiline fields only hand ArrowUp/Down off when the caret is already on the first/last line.
//   • Date inputs keep their arrows (they step day/month/year); Enter still moves on.
//   • Buttons are only in the chain when marked `data-nav-stop` (e.g. a dialog's Save button);
//     Enter on a button clicks it natively. `data-nav-stop="advance"` makes Enter move on instead
//     (for option buttons like a toggle group, whose value is changed with Left/Right).
//   • Checkboxes are only in the chain when marked `data-nav-stop`; Enter ticks an unticked box
//     and moves on (to the row's now-enabled qty, say). Space still toggles.
//
// Per-field hooks (put them on the <input> via `inputProps`):
//   data-nav-skip            → never stop here
//   data-nav-enter="<css>"   → Enter jumps to that element instead of the next field
//   data-nav-right           → ArrowRight with the caret at the end of the text also moves on
//
// Select fields that should open on Enter (pick with Up/Down, Enter confirms and moves on): spread
// `enterOpensSelectProps` into the TextField's `SelectProps`.

const FIELD_SELECTOR = [
  'input:not([type=hidden]):not([type=checkbox]):not([type=radio]):not([type=file])',
  'textarea',
  '[role="combobox"]:not(input)', // MUI Select's focusable div
  '[role="button"].MuiSelect-select', // older MUI Select markup
  '[data-nav-stop]', // opt-in buttons / checkboxes
].join(',');

const SCOPE_ATTR = 'data-nav-scope';

const isUsable = (el) => {
  if (!el || el.disabled || el.readOnly) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if (el.getAttribute('aria-disabled') === 'true') return false;
  if (el.tabIndex < 0) return false;
  if (el.closest('[data-nav-skip]')) return false;
  return el.getClientRects().length > 0; // visible (not collapsed / display:none)
};

export const getNavFields = (scope) =>
  scope ? Array.from(scope.querySelectorAll(FIELD_SELECTOR)).filter(isUsable) : [];

export const focusField = (el) => {
  if (!el) return false;
  el.focus();
  // Pre-select text so a typed value overwrites (fast qty / rate entry).
  if (el.tagName === 'INPUT' && ['text', 'number', 'search', 'tel', 'email', ''].includes(el.type)) {
    try { el.select(); } catch { /* number inputs in some browsers */ }
  }
  return true;
};

// Moves focus `delta` fields away from `from` inside its nav scope. Returns true if it moved.
export const focusRelative = (from, delta = 1) => {
  const scope = from?.closest?.(`[${SCOPE_ATTR}]`);
  const fields = getNavFields(scope);
  if (!fields.length) return false;
  const idx = fields.indexOf(from);
  if (idx !== -1) return focusField(fields[idx + delta]);
  // `from` itself isn't navigable (e.g. just disabled) — step from its DOM position instead.
  let after = fields.findIndex(f => from.compareDocumentPosition(f) & Node.DOCUMENT_POSITION_FOLLOWING);
  if (after === -1) after = fields.length;
  return focusField(fields[delta > 0 ? after + delta - 1 : after + delta]);
};

// Focus the field after `el` once React has rendered whatever a selection revealed.
export const focusNextAfterRender = (el, delay = 30) => {
  setTimeout(() => { if (el) focusRelative(el, 1); }, delay);
};

const isAutocompleteInput = (el) => el.tagName === 'INPUT' && el.getAttribute('aria-autocomplete') === 'list';
const isSelect = (el) => el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && el.tagName !== 'BUTTON';

const caretOnFirstLine = (el) => !el.value.slice(0, el.selectionStart).includes('\n');
const caretOnLastLine = (el) => !el.value.slice(el.selectionEnd).includes('\n');

const handleEnter = (e, el) => {
  const jump = el.getAttribute('data-nav-enter');
  if (jump) {
    const target = document.querySelector(jump);
    if (target) { e.preventDefault(); focusField(target); return; }
  }
  if (focusRelative(el, 1)) e.preventDefault();
  else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') e.preventDefault(); // never implicit-submit
};

// Capture phase: runs before MUI's own handlers, so it can stop a Select from opening on
// Enter/arrows and keep number inputs from stepping their value on arrows.
const onKeyDownCapture = (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
  const el = e.target;
  if (e.key === 'ArrowRight' && el.hasAttribute?.('data-nav-right') && !e.shiftKey
      && el.selectionStart === el.value.length && el.selectionEnd === el.value.length) {
    if (focusRelative(el, 1)) { e.preventDefault(); e.stopPropagation(); }
    return;
  }
  if (!['Enter', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
  if (!el.matches?.(FIELD_SELECTOR) || isAutocompleteInput(el)) return; // autocomplete → bubble phase
  if (e.key === 'Enter' && el.hasAttribute('data-nav-open')) return; // MUI Select opens its menu
  if (e.key === 'Enter' && el.tagName === 'BUTTON' && el.getAttribute('data-nav-stop') !== 'advance') {
    return; // native click
  }
  if (e.key === 'Enter' && el.type === 'checkbox') {
    e.preventDefault();
    e.stopPropagation();
    if (!el.checked) el.click();
    focusNextAfterRender(el); // whatever ticking it enabled is now in the chain
    return;
  }

  if (e.key === 'Enter') {
    if (e.shiftKey && el.tagName === 'TEXTAREA') return; // newline
    e.stopPropagation();
    handleEnter(e, el);
    return;
  }

  if (el.type === 'date' || el.type === 'datetime-local' || el.type === 'time') return;
  if (el.tagName === 'TEXTAREA') {
    if (e.key === 'ArrowUp' && !caretOnFirstLine(el)) return;
    if (e.key === 'ArrowDown' && !caretOnLastLine(el)) return;
  }
  if (focusRelative(el, e.key === 'ArrowDown' ? 1 : -1) || isSelect(el) || el.type === 'number') {
    e.preventDefault();
    e.stopPropagation();
  }
};

// Bubble phase: MUI Autocomplete has already handled the key. If its list was open it owns the
// key (it preventDefaults when it selects an option); a closed list lets Enter move on.
const onKeyDown = (e) => {
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.key !== 'Enter') return;
  const el = e.target;
  if (!isAutocompleteInput(el) || el.getAttribute('aria-expanded') === 'true') return;
  handleEnter(e, el);
};

export const navScopeProps = { [SCOPE_ATTR]: '', onKeyDownCapture, onKeyDown };

// For an MUI <Dialog>: `<Dialog {...navDialogProps}>`. Makes the Paper a nav scope and, once the
// open transition ends, puts the cursor in the first field unless focus is already inside — the
// fields' own `autoFocus` can lose to FocusTrap's restore-focus when the dialog is opened from a
// keystroke in another input (always in dev under StrictMode's double effects).
export const navDialogProps = {
  PaperProps: navScopeProps,
  TransitionProps: {
    onEntered: (node) => {
      const scope = node?.querySelector?.(`[${SCOPE_ATTR}]`);
      if (!scope || scope.contains(document.activeElement)) return;
      focusField(getNavFields(scope)[0]);
    },
  },
};

// MUI Select whose Enter opens the menu instead of moving on: `SelectProps={{ ...enterOpensSelectProps }}`.
// Up/Down walk the options; picking one (Enter or click — even the current value) moves focus to
// the next field. Escape / clicking away leaves focus on the select. One menu is open at a time,
// so the state lives here rather than per field.
let openSelectDisplay = null;
let advanceAfterClose = false;
export const enterOpensSelectProps = {
  SelectDisplayProps: { 'data-nav-open': '' },
  onOpen: (e) => { openSelectDisplay = e?.currentTarget || null; advanceAfterClose = false; },
  onClose: (e) => { advanceAfterClose = e?.currentTarget?.getAttribute?.('role') === 'option'; },
  MenuProps: {
    TransitionProps: {
      // After the exit transition the menu's FocusTrap hands focus back to the select; step on
      // from there once that has happened.
      onExited: () => {
        const from = openSelectDisplay;
        const go = advanceAfterClose;
        openSelectDisplay = null;
        advanceAfterClose = false;
        if (go && from) setTimeout(() => focusRelative(from, 1), 0);
      },
    },
  },
};
