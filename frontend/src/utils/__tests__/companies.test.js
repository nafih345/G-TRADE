// node --test src/utils/__tests__/companies.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPANY_PICK_KEY, COMPANIES_KEY, afterLoginCompanyStep, companyPickPending, hasMultipleCompanies,
  membershipPayload, normalizeCompanies, readStoredCompanies, salesSummaryTable, stockSummaryTable,
  storeCompanySession, tokenTenantId, validateCompanyForm, validateMembershipForm,
} from '../companies.js';

function memoryStorage(seed = {}) {
  const data = { ...seed };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const jwt = (payload) => `h.${b64(payload)}.s`;

test('single-company users never see the picker', () => {
  const s = memoryStorage();
  assert.equal(afterLoginCompanyStep(s, [{ tenant_id: 1, name: 'Only', is_home: true }]), 'continue');
  assert.equal(companyPickPending(s), false);
  assert.equal(hasMultipleCompanies([{ tenant_id: 1 }]), false);
  assert.equal(hasMultipleCompanies(undefined), false);
});

test('multi-company users get the picker, home company first', () => {
  const s = memoryStorage();
  const step = afterLoginCompanyStep(s, [
    { tenant_id: 9, name: 'Zeta Wholesale', role: 'MANAGER' },
    { tenant_id: 3, name: 'Acme Optics', role: 'ACCOUNTANT', is_home: true },
    { tenant_id: 5, name: 'Beta', role: 'CASHIER' },
  ]);
  assert.equal(step, 'pick');
  assert.equal(s.getItem(COMPANY_PICK_KEY), '1');
  assert.deepEqual(readStoredCompanies(s).map((c) => c.tenant_id), [3, 5, 9]);
});

test('normalizeCompanies drops malformed rows', () => {
  assert.deepEqual(normalizeCompanies([null, { name: 'x' }, { tenant_id: '4', name: 'Four' }]).map((c) => c.tenant_id), [4]);
  assert.deepEqual(normalizeCompanies('nope'), []);
});

test('storeCompanySession writes the server session and drops the old branch', () => {
  const s = memoryStorage({ active_branch_id: 'old-branch', [COMPANY_PICK_KEY]: '1' });
  const tenant = storeCompanySession(s, {
    access: jwt({ tenant_id: 7, org_id: 2 }), refresh: 'r', user: { role: 'MANAGER' },
    companies: [{ tenant_id: 7, name: 'B' }, { tenant_id: 3, name: 'A', is_home: true }],
  }, (p) => ({ ...p, labelled: true }));
  assert.equal(tenant, 7);
  assert.equal(s.getItem('active_branch_id'), null);
  assert.equal(s.getItem(COMPANY_PICK_KEY), null);
  assert.equal(s.getItem('refresh_token'), 'r');
  assert.deepEqual(JSON.parse(s.getItem('user_profile')), { role: 'MANAGER', labelled: true });
  assert.equal(JSON.parse(s.getItem(COMPANIES_KEY)).length, 2);
});

test('storeCompanySession refuses a response without tokens', () => {
  assert.throws(() => storeCompanySession(memoryStorage(), { user: {} }));
});

test('tokenTenantId reads the signed claim and tolerates junk', () => {
  assert.equal(tokenTenantId(jwt({ tenant_id: 12 })), 12);
  assert.equal(tokenTenantId('garbage'), null);
  assert.equal(tokenTenantId(undefined), null);
});

test('company form validation', () => {
  assert.deepEqual(validateCompanyForm({ name: 'Acme Two' }), {});
  assert.ok(validateCompanyForm({ name: '   ' }).name);
  assert.ok(validateCompanyForm({ name: 'x'.repeat(151) }).name);
  assert.ok(validateCompanyForm({ name: 'Ok', copyFrom: 3, sections: [] }).sections);
  assert.deepEqual(validateCompanyForm({ name: 'Ok', copyFrom: 3, sections: ['brands'] }), {});
});

test('membership form validation and payload', () => {
  assert.ok(validateMembershipForm({}).userId);
  assert.ok(validateMembershipForm({ userId: 'u', role: 'CASHIER', allBranches: false, branchIds: [] }).branchIds);
  assert.deepEqual(validateMembershipForm({ userId: 'u', role: 'CASHIER', allBranches: true }), {});
  assert.deepEqual(membershipPayload({ userId: 'u', role: 'CASHIER', allBranches: true, branchIds: ['b1'] }),
    { user_id: 'u', role: 'CASHIER', is_active: true, all_branches: true, branch_ids: [], default_branch_id: null });
  assert.deepEqual(membershipPayload({ userId: 'u', role: 'CASHIER', isActive: false, branchIds: ['b1'], defaultBranchId: 'b1' }),
    { user_id: 'u', role: 'CASHIER', is_active: false, all_branches: false, branch_ids: ['b1'], default_branch_id: 'b1' });
});

test('sales summary table keeps totals only when the server gives them', () => {
  const data = {
    companies: [
      { tenant_id: 1, name: 'A', currency: '₹', retail_invoices: 2, retail_total: '100.00', wholesale_invoices: 1,
        wholesale_total: '50.00', returns_total: '10.00', net_sales: '140.00' },
      { tenant_id: 2, name: 'B', currency: '₹', retail_invoices: 1, retail_total: '20.00', wholesale_invoices: 0,
        wholesale_total: '0.00', returns_total: '0.00', net_sales: '20.00' },
    ],
    totals: { retail_total: '120.00', wholesale_total: '50.00', returns_total: '10.00', net_sales: '160.00' },
    excluded: [{ tenant_id: 3, name: 'C', reason: 'restricted' }],
  };
  const t = salesSummaryTable(data);
  assert.equal(t.rows.length, 2);
  assert.equal(t.totals.retailInvoices, 3);
  assert.equal(t.totals.netSales, '160.00');
  assert.equal(t.excluded.length, 1);
  const mixed = salesSummaryTable({ ...data, totals: null, mixed_currency: true });
  assert.equal(mixed.totals, null);
  assert.equal(mixed.mixedCurrency, true);
});

test('stock summary table hides cost where the server withheld it', () => {
  const t = stockSummaryTable({
    companies: [{ tenant_id: 1, name: 'A', products: 3, units_on_hand: 9, out_of_stock: 1, low_stock: 0,
                  stock_value_retail: '900.00', stock_value_cost: null }],
    totals: { products: 3, units_on_hand: 9, stock_value_retail: '900.00', stock_value_cost: null },
  });
  assert.equal(t.rows[0].valueCost, null);
  assert.equal(t.totals.valueCost, null);
  assert.equal(stockSummaryTable(undefined).rows.length, 0);
});
