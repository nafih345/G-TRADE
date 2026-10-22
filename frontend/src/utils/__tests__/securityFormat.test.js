import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  changedKeys, checkBackupFile, formatBytes, formatInZone, healthTone, pick, relativeTime, restoreStep,
  scheduleSummary, storageTone, validateSchedule, SECURITY_FIELDS,
} from '../securityFormat.js';

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(62861), '61 KB');
  assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
  assert.equal(formatBytes(null), '0 B');
});

test('health and storage tones', () => {
  assert.deepEqual(healthTone('healthy'), { tone: 'success', label: 'Database protected' });
  assert.equal(healthTone('warning').tone, 'warning');
  assert.equal(healthTone('failed').tone, 'error');
  assert.equal(healthTone('none').label, 'Not protected');
  assert.equal(storageTone(10), 'success');
  assert.equal(storageTone(80), 'warning');
  assert.equal(storageTone(95), 'error');
});

test('dirty tracking compares only edited fields, tolerant of number/string', () => {
  const server = { inactivity_timeout_minutes: 30, sensitive_action_reauth: false, login_protection_enabled: true,
    max_failed_attempts: 5, lockout_minutes: 15, two_factor_required: false, version: 3, options: {} };
  const form = pick(server, SECURITY_FIELDS);
  assert.deepEqual(changedKeys(form, pick(server, SECURITY_FIELDS), SECURITY_FIELDS), []);
  form.inactivity_timeout_minutes = 15;
  form.sensitive_action_reauth = true;
  assert.deepEqual(changedKeys(form, pick(server, SECURITY_FIELDS), SECURITY_FIELDS),
    ['inactivity_timeout_minutes', 'sensitive_action_reauth']);
  assert.deepEqual(changedKeys({ a: '7' }, { a: 7 }, ['a']), []);
  assert.deepEqual(changedKeys(null, {}, ['a']), []);
});

test('schedule validation mirrors the server', () => {
  const ok = { enabled: true, frequency: 'DAILY', backup_time: '02:00', weekday: 6, day_of_month: 1, retention_count: 15 };
  assert.deepEqual(validateSchedule(ok), {});
  assert.deepEqual(Object.keys(validateSchedule({ ...ok, frequency: 'HOURLY', backup_time: '24:00', retention_count: 0 })).sort(),
    ['backup_time', 'frequency', 'retention_count']);
  assert.ok(validateSchedule({ ...ok, frequency: 'MONTHLY', day_of_month: 31 }).day_of_month);
  assert.ok(validateSchedule({ ...ok, frequency: 'WEEKLY', weekday: 9 }).weekday);
  assert.deepEqual(validateSchedule({ ...ok, frequency: 'DAILY', weekday: 9 }), {}); // weekday only matters for weekly
  assert.ok(validateSchedule({ ...ok, retention_count: 2.5 }).retention_count);
});

test('schedule summary', () => {
  assert.equal(scheduleSummary({ frequency: 'DAILY', backup_time: '02:00' }), 'Every day at 02:00');
  assert.equal(scheduleSummary({ frequency: 'WEEKLY', weekday: 6, backup_time: '01:30' }), 'Every Sunday at 01:30');
  assert.equal(scheduleSummary({ frequency: 'MONTHLY', day_of_month: 1, backup_time: '03:00' }), 'On the 1st of every month at 03:00');
  assert.equal(scheduleSummary({ frequency: 'MONTHLY', day_of_month: 22, backup_time: '03:00' }), 'On the 22nd of every month at 03:00');
  assert.equal(scheduleSummary({ frequency: 'MONTHLY', day_of_month: 11, backup_time: '03:00' }), 'On the 11th of every month at 03:00');
});

test('dates in the business time zone', () => {
  const s = formatInZone('2026-10-24T20:30:00Z', 'Asia/Kolkata');
  assert.match(s, /25 Oct 2026/);
  assert.match(s, /02:00/);
  assert.equal(formatInZone(null), '');
  assert.ok(formatInZone('2026-10-24T20:30:00Z', 'Not/AZone')); // falls back instead of throwing
});

test('relative time', () => {
  const now = Date.parse('2026-10-22T12:00:00Z');
  assert.equal(relativeTime('2026-10-22T11:59:50Z', now), 'just now');
  assert.equal(relativeTime('2026-10-22T11:57:00Z', now), '3 minutes ago');
  assert.equal(relativeTime('2026-10-22T14:00:00Z', now), 'in 2 hours');
  assert.equal(relativeTime('2026-10-20T12:00:00Z', now), '2 days ago');
});

test('restore stages and file checks', () => {
  assert.equal(restoreStep('VALIDATING'), 0);
  assert.equal(restoreStep('RESTORING'), 2);
  assert.equal(restoreStep('unknown'), 0);
  assert.equal(checkBackupFile(null), 'Choose a backup file.');
  assert.match(checkBackupFile({ name: 'dump.sql', size: 10 }), /\.zip/);
  assert.match(checkBackupFile({ name: 'b.zip', size: 0 }), /empty/);
  assert.match(checkBackupFile({ name: 'b.zip', size: 2048 }, 1024), /upload limit/);
  assert.equal(checkBackupFile({ name: 'GreensolERP_Backup.ZIP', size: 2048 }), '');
});
