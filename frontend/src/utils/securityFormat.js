// Pure helpers for Settings → System Security & Backup (no imports, so `node --test` can load them).

export const TIMEOUT_OPTIONS = [5, 15, 30, 60, 120];
export const LOCKOUT_OPTIONS = [5, 15, 30, 60];
export const RETENTION_PRESETS = [7, 15, 30, 60];
export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
export const SECURITY_FIELDS = ['inactivity_timeout_minutes', 'sensitive_action_reauth', 'login_protection_enabled',
  'max_failed_attempts', 'lockout_minutes', 'two_factor_required'];
export const SCHEDULE_FIELDS = ['enabled', 'frequency', 'backup_time', 'weekday', 'day_of_month', 'retention_count'];

/** 1536 → "1.5 KB". Binary units, one decimal under 10. */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  const v = n / 1024 ** i;
  return `${i === 0 ? v : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

/** Health status from /api/backups/health/ → a tone for colour + label. */
export function healthTone(status) {
  switch (status) {
    case 'healthy': return { tone: 'success', label: 'Database protected' };
    case 'warning': return { tone: 'warning', label: 'Needs attention' };
    case 'failed': return { tone: 'error', label: 'Backup failed' };
    default: return { tone: 'neutral', label: 'Not protected' };
  }
}

export function storageTone(percent) {
  if (percent >= 90) return 'error';
  if (percent >= 75) return 'warning';
  return 'success';
}

export const STATUS_TONE = { SUCCESS: 'success', FAILED: 'error', RUNNING: 'info', QUEUED: 'info', DELETED: 'neutral' };

/** Pick only the keys a form edits, so a server payload and a form compare cleanly. */
export function pick(obj, keys) {
  return Object.fromEntries(keys.map((k) => [k, obj?.[k]]));
}

/** Keys whose values differ between two picked objects. */
export function changedKeys(a, b, keys) {
  if (!a || !b) return [];
  return keys.filter((k) => String(a[k]) !== String(b[k]));
}

/** Client-side mirror of the server's schedule validation (the server re-checks everything). */
export function validateSchedule(form) {
  const errors = {};
  if (!['DAILY', 'WEEKLY', 'MONTHLY'].includes(form.frequency)) errors.frequency = 'Choose daily, weekly or monthly.';
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(form.backup_time || '')) errors.backup_time = 'Enter a time as HH:MM.';
  const w = Number(form.weekday);
  if (form.frequency === 'WEEKLY' && !(Number.isInteger(w) && w >= 0 && w <= 6)) errors.weekday = 'Choose a day of the week.';
  const d = Number(form.day_of_month);
  if (form.frequency === 'MONTHLY' && !(Number.isInteger(d) && d >= 1 && d <= 28)) errors.day_of_month = 'Choose a day between 1 and 28.';
  const r = Number(form.retention_count);
  if (!(Number.isInteger(r) && r >= 1 && r <= 365)) errors.retention_count = 'Keep between 1 and 365 backups.';
  return errors;
}

const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
};

/** "Every Sunday at 02:00" etc. */
export function scheduleSummary(s) {
  if (!s) return '';
  const at = `at ${s.backup_time}`;
  if (s.frequency === 'WEEKLY') return `Every ${WEEKDAYS[Number(s.weekday)] || 'week'} ${at}`;
  if (s.frequency === 'MONTHLY') return `On the ${ordinal(Number(s.day_of_month) || 1)} of every month ${at}`;
  return `Every day ${at}`;
}

/** A Date as "Sun, 25 Oct 2026, 02:00" in the given IANA zone (falls back to the browser's). */
export function formatInZone(iso, timeZone) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const opts = { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone }).format(d);
  } catch {
    return new Intl.DateTimeFormat('en-GB', opts).format(d);
  }
}

/** "3 minutes ago" style, for the health card. */
export function relativeTime(iso, now = Date.now()) {
  if (!iso) return '';
  const diff = Math.round((now - new Date(iso).getTime()) / 1000);
  if (!Number.isFinite(diff)) return '';
  const future = diff < 0;
  const s = Math.abs(diff);
  const [v, unit] = s < 60 ? [s, 'second'] : s < 3600 ? [Math.round(s / 60), 'minute']
    : s < 86400 ? [Math.round(s / 3600), 'hour'] : [Math.round(s / 86400), 'day'];
  if (unit === 'second' && s < 45) return future ? 'in a moment' : 'just now';
  const text = `${v} ${unit}${v === 1 ? '' : 's'}`;
  return future ? `in ${text}` : `${text} ago`;
}

/** Restore job stage → step index for the progress stepper. */
export const RESTORE_STAGES = ['VALIDATING', 'SAFETY_BACKUP', 'RESTORING', 'FINALIZING', 'DONE'];
export function restoreStep(stage) {
  const i = RESTORE_STAGES.indexOf(stage);
  return i < 0 ? 0 : i;
}

/** Validate a chosen file before it is uploaded. */
export function checkBackupFile(file, maxBytes = 1024 * 1024 * 1024) {
  if (!file) return 'Choose a backup file.';
  if (!/\.zip$/i.test(file.name || '')) return 'Choose a .zip backup file created by this application.';
  if (!file.size) return 'The file is empty.';
  if (file.size > maxBytes) return `The file is larger than the ${formatBytes(maxBytes)} upload limit.`;
  return '';
}
