// Module access in the browser. The rules live on the server (backend/apps/common/module_access.py):
// the profile carries user.module_access = { module: 'full' | 'view' | 'none' } for the signed-in
// user, and the platform console gets the catalog (packages, dependencies, role defaults) from
// /api/superadmin/tenants/catalog/. Nothing here is a second copy of those rules — only the
// route → module mapping and the generic "switch a module on/off" helper the console uses.

// Route prefix → module key. Accounts (basic) and Financial (enterprise) are separate modules: a
// client has one of them, so the other's URLs are locked out (only the platform account has both).
const ROUTE_MODULES = [
  ['/optical', 'optical'],
  ['/sales', 'sales'],
  ['/wholesale', 'wholesale'],
  ['/inventory', 'inventory'],
  ['/purchase', 'purchase'],
  ['/financial', 'financial'],
  ['/accounts', 'accounts'],
  ['/admin', 'admin'],
  ['/reports', 'reports'],
  ['/settings', 'settings'],
];

export const moduleForPath = (pathname = '') => {
  const hit = ROUTE_MODULES.find(([prefix]) => pathname === prefix || pathname.startsWith(`${prefix}/`));
  return hit ? hit[1] : null;
};

// Profiles cached before module_access existed have no map: treat as full access (the server
// still enforces writes) until the background profile refresh fills it in.
export const moduleLevel = (user, module) => {
  if (!module) return 'full';
  const access = user?.module_access;
  if (!access) return 'full';
  return access[module] || 'none';
};

export const canOpenModule = (user, module) => moduleLevel(user, module) !== 'none';

// Console toggles, same rules as module_access.normalize_modules: every module is independent —
// switching one on or off never touches another — except the exclusive groups
// (catalog.exclusive: Accounts vs Financial): switching one of a group on switches the others off,
// since a client gets only one accounting tier.
export const toggleModule = (catalog, modules, key, on) => {
  const order = catalog.modules.map((m) => m.key);
  const chosen = new Set(modules);
  if (on) {
    chosen.add(key);
    (catalog.exclusive || []).forEach((group) => {
      if (group.includes(key)) group.forEach((k) => { if (k !== key) chosen.delete(k); });
    });
  } else {
    chosen.delete(key);
  }
  return order.filter((k) => chosen.has(k));
};

// The named package whose module set is exactly `modules`, else CUSTOM (mirrors the server's
// normalize_modules relabelling, so the selector shows what will be saved).
export const packageFor = (catalog, modules) => {
  const set = new Set(modules);
  const hit = catalog.packages.find((p) => p.modules && p.modules.length === set.size && p.modules.every((m) => set.has(m)));
  return hit ? hit.key : 'CUSTOM';
};

// Modules a toggle would change besides itself (only the other accounting tier), for the notice.
export const dependencyNote = (catalog, modules, key, on) => {
  const next = toggleModule(catalog, modules, key, on);
  const label = (k) => catalog.modules.find((m) => m.key === k)?.label || k;
  // The only side effect left: the other accounting tier switching off.
  return modules.filter((k) => k !== key && !next.includes(k)).map(label);
};

// Settings page sections (its ?tab= ids) the user may open: profile.settings_features, from the
// tenant's section pick (Client Management) and the role's Settings access. Profiles cached before
// the field existed have none: every section until the background refresh fills it in (the server
// still refuses writes to a disabled section).
export const canOpenSettingsSection = (user, section) => {
  const sections = user?.settings_features;
  return !Array.isArray(sections) || sections.includes(section);
};
