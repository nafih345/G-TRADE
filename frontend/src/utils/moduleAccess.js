// Module access in the browser. The rules live on the server (backend/apps/common/module_access.py):
// the profile carries user.module_access = { module: 'full' | 'view' | 'none' } for the signed-in
// user, and the platform console gets the catalog (packages, dependencies, role defaults) from
// /api/superadmin/tenants/catalog/. Nothing here is a second copy of those rules — only the
// route → module mapping and the generic "switch a module on/off" helper the console uses.

// Route prefix → module key. Financial and Accounts menus are the one "Financial Accounts" module.
const ROUTE_MODULES = [
  ['/optical', 'optical'],
  ['/sales', 'sales'],
  ['/wholesale', 'wholesale'],
  ['/inventory', 'inventory'],
  ['/purchase', 'purchase'],
  ['/financial', 'financial'],
  ['/accounts', 'financial'],
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

// Console toggles, same rules as module_access.with_requirements:
//  * on  — also switches on what the module requires (catalog.requires);
//  * off — also switches off whatever requires it;
//  * integrated modules (Financial Accounts) are standalone alone, but together with any module
//    of their suite they need the whole suite: switching one suite module on brings the rest,
//    switching one off while others remain switches the integrated module off.
export const toggleModule = (catalog, modules, key, on) => {
  const order = catalog.modules.map((m) => m.key);
  const requires = catalog.requires || {};
  const integrated = catalog.integrated || {};
  const chosen = new Set(modules);
  const addWithDeps = (start) => {
    const stack = [start];
    while (stack.length) {
      const k = stack.pop();
      if (chosen.has(k)) continue;
      chosen.add(k);
      (requires[k] || []).forEach((dep) => stack.push(dep));
    }
  };
  if (on) {
    addWithDeps(key);
  } else {
    const stack = [key];
    while (stack.length) {
      const k = stack.pop();
      if (!chosen.delete(k)) continue;
      Object.entries(requires).forEach(([dependent, deps]) => {
        if (deps.includes(k) && chosen.has(dependent)) stack.push(dependent);
      });
    }
    Object.entries(integrated).forEach(([module, suite]) => {
      if (chosen.has(module) && suite.includes(key) && suite.some((k) => chosen.has(k))) chosen.delete(module);
    });
  }
  Object.entries(integrated).forEach(([module, suite]) => {
    if (chosen.has(module) && suite.some((k) => chosen.has(k))) suite.forEach(addWithDeps);
  });
  return order.filter((k) => chosen.has(k));
};

// The named package whose module set is exactly `modules`, else CUSTOM (mirrors the server's
// normalize_modules relabelling, so the selector shows what will be saved).
export const packageFor = (catalog, modules) => {
  const set = new Set(modules);
  const hit = catalog.packages.find((p) => p.modules && p.modules.length === set.size && p.modules.every((m) => set.has(m)));
  return hit ? hit.key : 'CUSTOM';
};

// Modules a toggle would drag along, for the confirmation hint ("also turns on …").
export const dependencyNote = (catalog, modules, key, on) => {
  const next = toggleModule(catalog, modules, key, on);
  const label = (k) => catalog.modules.find((m) => m.key === k)?.label || k;
  const extra = on
    ? next.filter((k) => k !== key && !modules.includes(k))
    : modules.filter((k) => k !== key && !next.includes(k));
  return extra.map(label);
};

// Settings page sections (its ?tab= ids) the user may open: profile.settings_features, from the
// tenant's section pick (Client Management) and the role's Settings access. Profiles cached before
// the field existed have none: every section until the background refresh fills it in (the server
// still refuses writes to a disabled section).
export const canOpenSettingsSection = (user, section) => {
  const sections = user?.settings_features;
  return !Array.isArray(sections) || sections.includes(section);
};
