// Vendor licence console helpers (cloud build only). The server signs, computes expiry dates and
// decides every rule; these helpers only label and format what it returns. Pure functions are
// covered by src/utils/__tests__/vendorLicensing.test.js.

export const LIC_API = '/api/superadmin/licensing/';

export const EDITION_LABEL = { WINDOWS_LOCAL: 'Windows Local', CLOUD: 'Cloud' };
export const CYCLE_LABEL = { MONTHLY: 'Monthly', YEARLY: 'Yearly', LIFETIME: 'Lifetime' };

export const LICENCE_STATUS = {
  ACTIVE: { label: 'Active', color: 'success' },
  PENDING: { label: 'Upcoming (not started)', color: 'info' },
  EXPIRED: { label: 'Expired', color: 'error' },
  SUSPENDED: { label: 'Suspended', color: 'warning' },
  REVOKED: { label: 'Revoked', color: 'default' },
};

export const ACTIVATION_STATUS = {
  ACTIVATED: { label: 'Activated', color: 'success', hint: 'Confirmed online by the installation' },
  BOUND: { label: 'Bound (offline)', color: 'info', hint: 'Key bound to an installation; activation is offline' },
  NOT_ACTIVATED: { label: 'Awaiting activation', color: 'default', hint: 'Bound by the first online activation' },
  CLOUD: { label: 'Cloud workspace', color: 'info', hint: 'Enforced by the cloud backend' },
};

// Windows Local Super Admin: the customer activates offline, so "activation" is what the vendor
// knows: no Installation ID yet → key issued for an installation → activation confirmed.
export const LOCAL_ACTIVATION_STATUS = {
  ACTIVATED: { label: 'Activated', color: 'success', hint: 'Activation confirmed by the customer' },
  BOUND: { label: 'Key issued', color: 'info', hint: 'Key generated for the customer\'s installation; waiting for their activation confirmation' },
  NOT_ACTIVATED: { label: 'Awaiting Installation ID', color: 'warning', hint: 'Bind the customer\'s Installation ID to generate the key' },
  CLOUD: ACTIVATION_STATUS.CLOUD,
};

export const activationMeta = (lic, local) => (local && lic?.edition === 'WINDOWS_LOCAL'
  ? LOCAL_ACTIVATION_STATUS : ACTIVATION_STATUS)[lic?.activation_status] || {};

export const RENEWAL_STATUS = {
  OK: { label: 'Current', color: 'success' },
  DUE: { label: 'Renewal due', color: 'warning' },
  OVERDUE: { label: 'Renewal overdue', color: 'error' },
  RENEWED: { label: 'Renewed (next licence issued)', color: 'success' },
  UPCOMING: { label: 'Starts later', color: 'info' },
  NOT_REQUIRED: { label: 'Not required (lifetime)', color: 'default' },
  SUSPENDED: { label: 'Suspended', color: 'warning' },
  CLOSED: { label: 'Closed (revoked)', color: 'default' },
  NONE: { label: 'No subscription', color: 'default' },
};

// The five subscriptions the Local Super Admin sells (service.LOCAL_PLAN_PRESETS on the server).
export const LOCAL_SUBSCRIPTIONS = [
  ['local-monthly', 'Monthly'], ['local-quarterly', 'Quarterly'], ['local-half-yearly', 'Half-Yearly'],
  ['local-yearly', 'Yearly'], ['local-lifetime', 'Lifetime'],
];

export const LIMITS = [
  ['clients', 'Clients', 'max_clients'],
  ['companies', 'Companies', 'max_companies'],
  ['branches', 'Branches', 'max_branches'],
  ['users', 'Named users', 'max_users'],
];

// null / undefined = explicitly unlimited (the server never stores a blank as unlimited).
export const limitText = (value) => (value === null || value === undefined ? 'Unlimited' : String(value));

export const durationText = (cycle, duration) => {
  if (cycle === 'LIFETIME') return 'Lifetime (no expiry)';
  const n = Number(duration) || 1;
  const unit = cycle === 'MONTHLY' ? 'month' : 'year';
  return `${n} ${unit}${n === 1 ? '' : 's'}`;
};

export const priceText = (price, currency) => {
  const n = Number(price);
  if (!Number.isFinite(n)) return '—';
  return `${currency || ''} ${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`.trim();
};

// Short form of an installation id for tables; the full id is in the tooltip / detail.
export const shortInstall = (id) => (id ? `${String(id).slice(0, 8)}…` : '');

export const bindingText = (lic) => {
  if (!lic) return '—';
  if (lic.edition === 'CLOUD') return lic.client?.tenant_id ? `Workspace #${lic.client.tenant_id}` : 'Cloud';
  if (!lic.install_id) return 'First activation';
  return `${shortInstall(lic.install_id)}${lic.hardware_bound ? ' + machine' : ''}`;
};

export const daysLeftText = (lic) => {
  if (!lic || lic.lifetime) return 'Never expires';
  if (lic.days_left === null || lic.days_left === undefined) return '';
  if (lic.days_left < 0) return `Ended ${-lic.days_left} day${lic.days_left === -1 ? '' : 's'} ago`;
  return `${lic.days_left} day${lic.days_left === 1 ? '' : 's'} left`;
};

// A plan body for POST/PATCH from the form: every limit is sent, null only when "Unlimited" is ticked.
export const planBody = (form) => {
  const body = {
    name: (form.name || '').trim(), code: (form.code || '').trim(), description: form.description || '',
    edition: form.edition, billing_cycle: form.billing_cycle,
    duration: form.billing_cycle === 'LIFETIME' ? 1 : Number(form.duration) || 1,
    price: String(form.price === '' || form.price === undefined ? '0' : form.price), currency: (form.currency || '').toUpperCase(),
    modules: [...(form.modules || [])], grace_days: Number(form.grace_days ?? 7),
    settings_features: form.all_features ? null : [...(form.settings_features || [])],
  };
  LIMITS.forEach(([key, , field]) => {
    if (form.edition === 'CLOUD' && key === 'clients') { body[field] = null; return; }
    body[field] = form.unlimited?.[key] ? null : (form[field] === '' || form[field] === undefined ? undefined : Number(form[field]));
  });
  return body;
};

// Client-side checks before sending (the server re-checks everything).
export const planErrors = (form) => {
  const out = {};
  if (!(form.name || '').trim()) out.name = 'Give the plan a name.';
  if (!/^[A-Za-z]{3}$/.test(form.currency || '')) out.currency = 'Use a 3-letter code such as INR.';
  if (form.price !== '' && (Number.isNaN(Number(form.price)) || Number(form.price) < 0)) out.price = 'Enter a price of 0 or more.';
  if (form.billing_cycle !== 'LIFETIME') {
    const d = Number(form.duration);
    if (!Number.isInteger(d) || d < 1 || d > 60) out.duration = 'Between 1 and 60.';
  }
  LIMITS.forEach(([key, , field]) => {
    if (form.edition === 'CLOUD' && key === 'clients') return;
    if (form.unlimited?.[key]) return;
    const v = form[field];
    const min = key === 'clients' ? 0 : 1;
    if (v === '' || v === undefined || v === null || !Number.isInteger(Number(v)) || Number(v) < min) {
      out[field] = `Enter a number (${min} or more) or tick Unlimited.`;
    }
  });
  if (!(form.modules || []).length) out.modules = 'Switch on at least one module.';
  if ((form.modules || []).includes('accounts') && (form.modules || []).includes('financial')) {
    out.modules = 'A client gets Accounts (basic) or Financial (enterprise), not both.';
  }
  return out;
};

export const emptyPlanForm = (edition = 'WINDOWS_LOCAL', modules = []) => ({
  name: '', code: '', description: '', edition, billing_cycle: 'YEARLY', duration: 1, price: '', currency: 'INR',
  max_clients: '0', max_companies: '1', max_branches: '1', max_users: '5', unlimited: {},
  modules, all_features: true, settings_features: [], grace_days: 7,
});

export const planToForm = (plan) => ({
  ...emptyPlanForm(plan.edition, plan.modules),
  ...plan,
  price: plan.price ?? '',
  max_clients: plan.max_clients ?? '', max_companies: plan.max_companies ?? '',
  max_branches: plan.max_branches ?? '', max_users: plan.max_users ?? '',
  unlimited: Object.fromEntries(LIMITS.map(([key, , field]) => [key, plan[field] === null])),
  all_features: plan.settings_features === null || plan.settings_features === undefined,
  settings_features: plan.settings_features || [],
});

// Diff rows from a renew / change-plan preview, with the colour the console shows.
export const changeTone = (direction) => ({ increase: 'success.main', decrease: 'error.main' }[direction] || 'text.primary');

export const changeValue = (value) => {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.join(', ');
  return String(value);
};
