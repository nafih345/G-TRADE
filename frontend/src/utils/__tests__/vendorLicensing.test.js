import test from 'node:test';
import assert from 'node:assert/strict';
import {
  bindingText, daysLeftText, durationText, emptyPlanForm, limitText, planBody, planErrors, planToForm,
} from '../../components/superadmin/licensing/licenceApi.js';

test('unlimited is explicit: a blank limit is an error, a ticked box is null', () => {
  const form = { ...emptyPlanForm('WINDOWS_LOCAL', ['sales', 'admin']), name: 'Pro', price: '100', max_users: '' };
  assert.ok(planErrors(form).max_users);
  const ticked = { ...form, unlimited: { users: true } };
  assert.equal(planErrors(ticked).max_users, undefined);
  const body = planBody(ticked);
  assert.equal(body.max_users, null);
  assert.equal(body.max_companies, 1);
  assert.equal(body.max_clients, 0, 'zero clients is a real limit for Windows plans');
});

test('cloud plans never send a client limit and lifetime has no duration', () => {
  const form = { ...emptyPlanForm('CLOUD', ['sales', 'admin']), name: 'Cloud', billing_cycle: 'LIFETIME', duration: 7, price: '1' };
  const body = planBody(form);
  assert.equal(body.max_clients, null);
  assert.equal(body.duration, 1);
  assert.deepEqual(planErrors(form), {});
});

test('both accounting tiers and bad currency are refused before sending', () => {
  const form = { ...emptyPlanForm(), name: 'X', price: '1', currency: 'RUPEES', modules: ['accounts', 'financial'] };
  const errs = planErrors(form);
  assert.ok(errs.currency);
  assert.ok(errs.modules);
});

test('planToForm round-trips unlimited flags and feature permissions', () => {
  const plan = { id: 'p', name: 'Y', edition: 'WINDOWS_LOCAL', billing_cycle: 'YEARLY', duration: 1, price: '9.00',
    currency: 'INR', max_clients: 0, max_companies: null, max_branches: 3, max_users: 5, modules: ['sales'],
    settings_features: ['store'], grace_days: 7 };
  const form = planToForm(plan);
  assert.equal(form.unlimited.companies, true);
  assert.equal(form.unlimited.users, false);
  assert.equal(form.all_features, false);
  const body = planBody(form);
  assert.equal(body.max_companies, null);
  assert.deepEqual(body.settings_features, ['store']);
});

test('labels', () => {
  assert.equal(limitText(null), 'Unlimited');
  assert.equal(limitText(0), '0');
  assert.equal(durationText('MONTHLY', 3), '3 months');
  assert.equal(durationText('YEARLY', 1), '1 year');
  assert.equal(durationText('LIFETIME', 1), 'Lifetime (no expiry)');
  assert.equal(daysLeftText({ lifetime: true }), 'Never expires');
  assert.equal(daysLeftText({ lifetime: false, days_left: -1 }), 'Ended 1 day ago');
  assert.equal(bindingText({ edition: 'WINDOWS_LOCAL', install_id: '' }), 'First activation');
  assert.equal(bindingText({ edition: 'WINDOWS_LOCAL', install_id: '5b0c1f7e-aaaa', hardware_bound: true }), '5b0c1f7e… + machine');
  assert.equal(bindingText({ edition: 'CLOUD', client: { tenant_id: 4 } }), 'Workspace #4');
});

test('Client Management labels: Windows activation, renewal status and the five subscriptions', async () => {
  const { activationMeta, RENEWAL_STATUS, LOCAL_SUBSCRIPTIONS } = await import('../../components/superadmin/licensing/licenceApi.js');
  const win = { edition: 'WINDOWS_LOCAL' };
  assert.equal(activationMeta({ ...win, activation_status: 'NOT_ACTIVATED' }, true).label, 'Awaiting Installation ID');
  assert.equal(activationMeta({ ...win, activation_status: 'BOUND' }, true).label, 'Key issued');
  assert.equal(activationMeta({ ...win, activation_status: 'ACTIVATED' }, true).label, 'Activated');
  // The cloud console keeps its online-activation wording.
  assert.equal(activationMeta({ ...win, activation_status: 'NOT_ACTIVATED' }, false).label, 'Awaiting activation');
  assert.deepEqual(Object.keys(RENEWAL_STATUS).sort(), ['CLOSED', 'DUE', 'NONE', 'NOT_REQUIRED', 'OK', 'OVERDUE', 'RENEWED', 'SUSPENDED', 'UPCOMING']);
  assert.deepEqual(LOCAL_SUBSCRIPTIONS.map(([, label]) => label), ['Monthly', 'Quarterly', 'Half-Yearly', 'Yearly', 'Lifetime']);
});
