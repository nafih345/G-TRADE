// App-wide bottom-of-screen notifications.
//
// `notify(message, severity)` pushes a notice that <NotificationHost /> renders as a stack at the
// bottom centre of the screen. `installAlertOverride()` routes every existing `window.alert(...)`
// call through the same host, so the ~100 legacy alerts across the app show in-page instead of
// as a blocking browser popup. (`confirm()` is left native — it needs a yes/no answer.)
//
// Notices that are queued just before a full page reload are parked in sessionStorage and
// replayed on the next load, so a "saved — reloading…" message is still seen.

const PENDING_KEY = 'optical_pending_notices';
const listeners = new Set();
let notices = [];
let nextId = 1;

const emit = () => listeners.forEach(fn => fn(notices));

// Pick a colour from the wording when the caller didn't say (legacy alert() calls).
export const guessSeverity = (message) => {
  const text = String(message || '');
  if (/❌|\b(fail(ed|ure)?|error|could ?n[o']t|cannot|can't|unable|invalid|denied|not allowed)\b/i.test(text)) return 'error';
  if (/✔|✅|\b(success(fully)?|saved|created|updated|deleted|removed|imported|exported|posted|sent|added|completed|copied|reversed|converted|restored)\b/i.test(text)) return 'success';
  if (/⚠|\b(please|select|enter|required|missing|no |nothing|already|must|only)\b/i.test(text)) return 'warning';
  return 'info';
};

// Leading status emoji duplicate the Alert's own icon.
const cleanMessage = (message) => String(message ?? '').replace(/^\s*(✔️?|✅|❌|⚠️?)\s*/u, '');

export const notify = (message, severity) => {
  const text = cleanMessage(message);
  const notice = {
    id: nextId++,
    message: text,
    severity: severity || guessSeverity(message),
    // Longer messages stay up longer (4s – 10s); hovering pauses the timer.
    duration: Math.min(10000, 4000 + text.length * 40),
  };
  notices = [...notices, notice].slice(-4);
  emit();
  return notice.id;
};

export const dismissNotice = (id) => {
  notices = notices.filter(n => n.id !== id);
  emit();
};

export const subscribeNotices = (fn) => {
  listeners.add(fn);
  fn(notices);
  return () => listeners.delete(fn);
};

export const installAlertOverride = () => {
  if (typeof window === 'undefined' || window.__opticalAlertInstalled) return;
  window.__opticalAlertInstalled = true;
  window.alert = (message) => { notify(message); };

  // Park anything still on screen if the page is about to reload/navigate away…
  window.addEventListener('beforeunload', () => {
    try {
      if (notices.length) sessionStorage.setItem(PENDING_KEY, JSON.stringify(notices.map(n => ({ message: n.message, severity: n.severity }))));
    } catch (e) {}
  });
  // …and replay it once the new page is up.
  try {
    const pending = JSON.parse(sessionStorage.getItem(PENDING_KEY) || '[]');
    sessionStorage.removeItem(PENDING_KEY);
    pending.forEach(n => notify(n.message, n.severity));
  } catch (e) {}
};
