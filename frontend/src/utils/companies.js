// Phase 2 — multi-company helpers (Organization → Companies → Branches).
//
// The active company is ALWAYS the one signed into the access token (`tenant_id` claim). This
// module never decides it: it only stores what the server returned from /api/auth/login/ or
// /api/auth/switch-company/, after the server checked the user's membership. Pure functions
// (no axios / React), so they run under `node --test`.

// Set after a sign-in that returned more than one company: the app shows the company picker
// before anything else, until a company is chosen.
export const COMPANY_PICK_KEY = 'company_selection_pending';
export const COMPANIES_KEY = 'user_companies';

/** True when the user can work in more than one company (show the picker / switcher). */
export function hasMultipleCompanies(companies) {
  return Array.isArray(companies) && companies.length > 1;
}

/** The company list from a login / switch response, normalised and sorted (home first). */
export function normalizeCompanies(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((c) => c && c.tenant_id !== undefined && c.tenant_id !== null)
    .map((c) => ({
      tenant_id: Number(c.tenant_id),
      name: String(c.name || ''),
      code: String(c.code || ''),
      role: String(c.role || ''),
      is_home: Boolean(c.is_home),
    }))
    .sort((a, b) => (Number(b.is_home) - Number(a.is_home)) || a.name.localeCompare(b.name));
}

/** tenant_id claim of a JWT, or null. */
export function tokenTenantId(token) {
  try {
    const payload = JSON.parse(atob(String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.tenant_id ?? null;
  } catch {
    return null;
  }
}

/**
 * Persist a server-issued company session (switch-company response) into `storage`
 * (localStorage or a test double). Returns the new tenant id. The previous company's branch
 * choice is dropped: branches belong to one company.
 */
export function storeCompanySession(storage, data, withLabel = (p) => p) {
  if (!data || !data.access) throw new Error('The server did not return a session for this company.');
  storage.removeItem('active_branch_id');
  storage.setItem('access_token', data.access);
  if (data.refresh) storage.setItem('refresh_token', data.refresh);
  if (data.user) storage.setItem('user_profile', JSON.stringify(withLabel(data.user)));
  if (Array.isArray(data.companies)) storage.setItem(COMPANIES_KEY, JSON.stringify(normalizeCompanies(data.companies)));
  storage.removeItem(COMPANY_PICK_KEY);
  return tokenTenantId(data.access);
}

/** What the sign-in should do next with the company list it received. */
export function afterLoginCompanyStep(storage, companies) {
  const list = normalizeCompanies(companies);
  storage.setItem(COMPANIES_KEY, JSON.stringify(list));
  if (hasMultipleCompanies(list)) {
    storage.setItem(COMPANY_PICK_KEY, '1');
    return 'pick';
  }
  storage.removeItem(COMPANY_PICK_KEY);
  return 'continue';
}

export function readStoredCompanies(storage) {
  try {
    return normalizeCompanies(JSON.parse(storage.getItem(COMPANIES_KEY) || '[]'));
  } catch {
    return [];
  }
}

export function companyPickPending(storage) {
  try { return storage.getItem(COMPANY_PICK_KEY) === '1'; } catch { return false; }
}

// ---- forms ---------------------------------------------------------------------------------

/** Client-side checks for "New company"; the server re-validates everything. */
export function validateCompanyForm({ name, copyFrom, sections } = {}) {
  const errors = {};
  const clean = String(name || '').trim();
  if (!clean) errors.name = 'Give the company a name.';
  else if (clean.length > 150) errors.name = 'Use at most 150 characters.';
  if (copyFrom && (!Array.isArray(sections) || sections.length === 0)) {
    errors.sections = 'Pick at least one list to copy, or choose not to copy.';
  }
  return errors;
}

/** Client-side checks for a membership grant. */
export function validateMembershipForm({ userId, role, allBranches, branchIds } = {}) {
  const errors = {};
  if (!userId) errors.userId = 'Pick a user.';
  if (!role) errors.role = 'Pick a role.';
  if (!allBranches && (!Array.isArray(branchIds) || branchIds.length === 0)) {
    errors.branchIds = 'Give access to all branches or pick at least one branch.';
  }
  return errors;
}

/** Body for POST /api/organization/companies/<id>/members/. */
export function membershipPayload({ userId, role, isActive = true, allBranches, branchIds, defaultBranchId }) {
  return {
    user_id: userId,
    role,
    is_active: Boolean(isActive),
    all_branches: Boolean(allBranches),
    branch_ids: allBranches ? [] : (branchIds || []),
    default_branch_id: defaultBranchId || null,
  };
}

// ---- consolidated summaries ------------------------------------------------------------------

/**
 * Rows for the consolidated sales table plus a totals row. Totals are shown only when the server
 * computed them (every company in one currency); amounts in different currencies are never added.
 */
export function salesSummaryTable(data) {
  const rows = (data?.companies || []).map((r) => ({
    key: String(r.tenant_id),
    name: r.name,
    currency: r.currency || '',
    retailInvoices: r.retail_invoices || 0,
    retailTotal: r.retail_total,
    wholesaleInvoices: r.wholesale_invoices || 0,
    wholesaleTotal: r.wholesale_total,
    returnsTotal: r.returns_total,
    netSales: r.net_sales,
  }));
  const totals = data?.totals ? {
    key: 'total', name: 'Total', currency: rows[0]?.currency || '',
    retailInvoices: rows.reduce((s, r) => s + r.retailInvoices, 0),
    retailTotal: data.totals.retail_total,
    wholesaleInvoices: rows.reduce((s, r) => s + r.wholesaleInvoices, 0),
    wholesaleTotal: data.totals.wholesale_total,
    returnsTotal: data.totals.returns_total,
    netSales: data.totals.net_sales,
  } : null;
  return { rows, totals, mixedCurrency: Boolean(data?.mixed_currency), excluded: data?.excluded || [] };
}

export function stockSummaryTable(data) {
  const rows = (data?.companies || []).map((r) => ({
    key: String(r.tenant_id),
    name: r.name,
    currency: r.currency || '',
    products: r.products || 0,
    unitsOnHand: r.units_on_hand || 0,
    outOfStock: r.out_of_stock || 0,
    lowStock: r.low_stock || 0,
    valueRetail: r.stock_value_retail,
    valueCost: r.stock_value_cost, // null = this user may not see cost prices in that company
  }));
  const totals = data?.totals ? {
    key: 'total', name: 'Total', currency: rows[0]?.currency || '',
    products: data.totals.products, unitsOnHand: data.totals.units_on_hand,
    outOfStock: rows.reduce((s, r) => s + r.outOfStock, 0), lowStock: rows.reduce((s, r) => s + r.lowStock, 0),
    valueRetail: data.totals.stock_value_retail, valueCost: data.totals.stock_value_cost,
  } : null;
  return { rows, totals, mixedCurrency: Boolean(data?.mixed_currency), excluded: data?.excluded || [] };
}
