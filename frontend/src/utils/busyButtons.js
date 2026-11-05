// Save / Submit / Add buttons show a spinner and stop accepting clicks while the API write they
// started is in flight — on every screen, without each screen managing its own "saving" state.
//
// How: the last button the user clicked (or pressed Enter / Space on) is remembered for a moment.
// When an API write starts within that moment, utils/apiWriteGuard.js calls begin(); the button
// gets data-api-busy (CSS below draws the spinner over its label) and further clicks / key
// presses on it are swallowed until every write it started has answered. Follow-up writes of the
// same action (save, then upload the attachment) keep it busy instead of flickering.
//
// Writes no button started (F2 / Ctrl+S shortcuts, background saves) show a small "Saving…"
// indicator instead, so a slow save never looks like a frozen screen.
//
// Nothing here touches React-managed attributes (`disabled`, children): only data-/aria-
// attributes React doesn't own, so re-renders and the screens' own saving flags keep working.

const TRIGGER_WINDOW_MS = 1500;   // click → first write
const CHAIN_GRACE_MS = 250;       // one write answered → the action's next write
const INDICATOR_DELAY_MS = 400;   // quick saves don't flash the indicator

let lastTrigger = null;           // { el, at }
const busyCount = new WeakMap();  // element -> in-flight writes it started
let untracked = 0;                // in-flight writes with no button
let indicatorTimer = null;
let indicatorEl = null;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const STYLE = `
[data-api-busy="true"] {
  position: relative !important;
  pointer-events: none !important;
  cursor: progress !important;
  color: transparent !important;
}
[data-api-busy="true"] > * { visibility: hidden !important; }
[data-api-busy="true"]::after {
  content: "";
  position: absolute;
  top: 50%; left: 50%;
  width: 1.1em; height: 1.1em;
  margin: -0.55em 0 0 -0.55em;
  border-radius: 50%;
  border: 2px solid rgba(100, 116, 139, 0.35);
  border-top-color: #2563EB;
  animation: api-busy-spin 0.7s linear infinite;
  box-sizing: border-box;
}
.MuiButton-contained[data-api-busy="true"]::after,
[data-api-busy="true"].MuiFab-root::after {
  border-color: rgba(255, 255, 255, 0.4);
  border-top-color: #ffffff;
}
@keyframes api-busy-spin { to { transform: rotate(360deg); } }
.api-saving-indicator {
  position: fixed; right: 18px; bottom: 18px; z-index: 2000;
  display: flex; align-items: center; gap: 8px;
  padding: 8px 14px; border-radius: 999px;
  background: #0f172a; color: #fff; font: 600 13px/1.2 system-ui, sans-serif;
  box-shadow: 0 6px 20px rgba(15, 23, 42, 0.25);
}
.api-saving-indicator::before {
  content: ""; width: 14px; height: 14px; border-radius: 50%;
  border: 2px solid rgba(255, 255, 255, 0.35); border-top-color: #fff;
  animation: api-busy-spin 0.7s linear infinite;
}
`;

const triggerOf = (target) => {
  if (!target || typeof target.closest !== 'function') return null;
  const el = target.closest('button, [role="button"], input[type="submit"], input[type="button"]');
  if (!el || el.disabled || el.getAttribute('aria-disabled') === 'true') return null;
  return el;
};

const swallowIfBusy = (event) => {
  const el = event.target && typeof event.target.closest === 'function'
    ? event.target.closest('[data-api-busy="true"]') : null;
  if (!el) return false;
  event.preventDefault();
  event.stopImmediatePropagation();
  return true;
};

function markBusy(el) {
  busyCount.set(el, (busyCount.get(el) || 0) + 1);
  el.setAttribute('data-api-busy', 'true');
  el.setAttribute('aria-busy', 'true');
}

function unmarkBusy(el) {
  const left = (busyCount.get(el) || 1) - 1;
  if (left > 0) { busyCount.set(el, left); return; }
  busyCount.delete(el);
  el.removeAttribute('data-api-busy');
  el.removeAttribute('aria-busy');
}

function updateIndicator() {
  if (untracked > 0) {
    if (indicatorEl || indicatorTimer) return;
    indicatorTimer = setTimeout(() => {
      indicatorTimer = null;
      if (untracked <= 0 || typeof document === 'undefined') return;
      indicatorEl = document.createElement('div');
      indicatorEl.className = 'api-saving-indicator';
      indicatorEl.setAttribute('role', 'status');
      indicatorEl.textContent = 'Saving…';
      document.body.appendChild(indicatorEl);
    }, INDICATOR_DELAY_MS);
  } else {
    if (indicatorTimer) { clearTimeout(indicatorTimer); indicatorTimer = null; }
    if (indicatorEl) { indicatorEl.remove(); indicatorEl = null; }
  }
}

/** Called when an API write starts. Returns a token for end(). */
export function begin({ background = false } = {}) {
  const t = now();
  const trigger = lastTrigger && t - lastTrigger.at <= TRIGGER_WINDOW_MS && lastTrigger.el.isConnected
    ? lastTrigger : null;
  const token = { el: null, done: false, untracked: false };
  if (trigger) {
    token.el = trigger.el;
    trigger.at = t;
    markBusy(trigger.el);
  } else if (!background) {
    token.untracked = true;
    untracked += 1;
    updateIndicator();
  }
  return token;
}

/** Called once the write has answered (success or failure). Safe to call more than once. */
export function end(token) {
  if (!token || token.done) return;
  token.done = true;
  if (token.el) {
    const el = token.el;
    // The same action's next write (e.g. the attachment upload after a save) may start right
    // after this one answers: keep the button attached to it for a moment.
    if (lastTrigger && lastTrigger.el === el) lastTrigger.at = now();
    setTimeout(() => unmarkBusy(el), CHAIN_GRACE_MS);
  }
  if (token.untracked) {
    untracked = Math.max(0, untracked - 1);
    updateIndicator();
  }
}

let installed = false;

export function installBusyButtons() {
  if (installed || typeof document === 'undefined') return;
  installed = true;
  const style = document.createElement('style');
  style.setAttribute('data-busy-buttons', '');
  style.textContent = STYLE;
  document.head.appendChild(style);

  // Capture phase: runs before React's handlers, so a busy button's second click never reaches them.
  document.addEventListener('click', (event) => {
    if (swallowIfBusy(event)) return;
    const el = triggerOf(event.target);
    lastTrigger = el ? { el, at: now() } : null;
  }, true);
  document.addEventListener('keydown', (event) => {
    if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;
    const activates = event.key === 'Enter' || event.key === ' ';
    if (activates && swallowIfBusy(event)) return;
    const el = activates ? triggerOf(event.target) : null;
    // Anything else (typing, F2 / Ctrl+S shortcuts, Enter in a field) is not that button any more:
    // a write it starts gets the "Saving…" indicator, not a spinner on an unrelated button.
    lastTrigger = el ? { el, at: now() } : null;
  }, true);
  document.addEventListener('submit', (event) => {
    const el = triggerOf(event.submitter);
    if (el) lastTrigger = { el, at: now() };
  }, true);
}
