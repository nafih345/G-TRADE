// Run: npm run test:module-access   (Node's built-in test runner)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canOpenModule, dependencyNote, moduleForPath, packageFor, toggleModule } from '../moduleAccess.js';

const OPS = ['optical', 'sales', 'wholesale', 'inventory', 'purchase'];
const CORE = ['admin', 'reports', 'settings'];
// Shape of /api/superadmin/tenants/catalog/ (backend/apps/common/module_access.py).
const catalog = {
  modules: [...OPS, 'accounts', 'financial', ...CORE].map((key) => ({ key, label: key })),
  packages: [
    { key: 'FULL_SUITE', modules: [...OPS, 'financial', ...CORE] },
    { key: 'RETAIL', modules: [...OPS, 'accounts', ...CORE] },
    { key: 'ACCOUNTS_ONLY', modules: ['accounts', ...CORE] },
    { key: 'CUSTOM', modules: null },
  ],
  exclusive: [['accounts', 'financial']],
};

test('switching an operations module off never touches the accounting tier', () => {
  const full = [...OPS, 'financial', ...CORE];
  for (const key of OPS) {
    const next = toggleModule(catalog, full, key, false);
    assert.ok(next.includes('financial'), key);
    assert.deepEqual(next, full.filter((k) => k !== key));
    assert.deepEqual(dependencyNote(catalog, full, key, false), []);
  }
  assert.deepEqual(toggleModule(catalog, ['optical', 'accounts'], 'optical', false), ['accounts']);
});

test('modules switch on alone — no dependencies are pulled in', () => {
  assert.deepEqual(toggleModule(catalog, ['accounts'], 'sales', true), ['sales', 'accounts']);
  assert.deepEqual(toggleModule(catalog, ['financial'], 'wholesale', true), ['wholesale', 'financial']);
  assert.deepEqual(toggleModule(catalog, ['sales'], 'inventory', false), ['sales']);
});

test('accounting tiers are one-or-the-other', () => {
  const retail = [...OPS, 'accounts', ...CORE];
  const next = toggleModule(catalog, retail, 'financial', true);
  assert.ok(next.includes('financial') && !next.includes('accounts'));
  assert.equal(packageFor(catalog, next), 'FULL_SUITE');
  assert.deepEqual(dependencyNote(catalog, retail, 'financial', true), ['accounts']);
  // Turning a tier off leaves no tier at all, never the other one switched on.
  assert.deepEqual(toggleModule(catalog, ['sales', 'financial'], 'financial', false), ['sales']);
});

test('routes map to their own accounting module', () => {
  assert.equal(moduleForPath('/accounts/vouchers/payment'), 'accounts');
  assert.equal(moduleForPath('/financial/trial-balance'), 'financial');
  const accountsUser = { module_access: { accounts: 'full', financial: 'none' } };
  assert.equal(canOpenModule(accountsUser, moduleForPath('/accounts/profit-loss')), true);
  assert.equal(canOpenModule(accountsUser, moduleForPath('/financial/ledger')), false);
});
