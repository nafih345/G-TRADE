// In-app "unsaved changes" guard. The app uses a plain HashRouter (no data-router useBlocker),
// so screens with a dirty form register a message here and in-app navigation (the sidebar)
// asks before leaving. Browser reload / close is covered by the screen's own beforeunload.
let guard = null;

/** Register `message` while a form is dirty; returns an unregister function. */
export function setNavigationGuard(message) {
  const token = { message };
  guard = token;
  return () => { if (guard === token) guard = null; };
}

/** True when navigation may proceed (no guard, or the user confirmed discarding). */
export function confirmLeave() {
  if (!guard) return true;
  // eslint-disable-next-line no-alert
  const ok = window.confirm(guard.message);
  if (ok) guard = null;
  return ok;
}
