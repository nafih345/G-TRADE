// The browser copy of the product list (localStorage `optical_inventory_items`) is only a cache
// for painting screens before the API answers. Whenever the server's list has been fetched it
// is the truth: cached products the server doesn't have (deleted since, left by another account
// on this browser, browser-only imports) are dropped, and cached stock is replaced by the
// server's. Keeping those stale rows in the pickers let a sale carry a product id the server
// didn't know — the bill saved but stock never moved.
export const LOCAL_INVENTORY_KEY = 'optical_inventory_items';

/**
 * apiProducts: the server's products (anything with `id` and `stock`). Returns the pruned
 * cached list and writes it back when it changed. Never throws.
 */
export function reconcileLocalInventory(apiProducts) {
  try {
    if (!Array.isArray(apiProducts)) return null;
    const stockById = new Map(apiProducts.map(p => [String(p.id), parseInt(p.stock ?? p.quantity ?? 0, 10) || 0]));
    const local = JSON.parse(localStorage.getItem(LOCAL_INVENTORY_KEY) || '[]');
    if (!Array.isArray(local)) return null;
    let changed = false;
    const next = [];
    local.forEach((it) => {
      const id = String(it?.id ?? '');
      if (!stockById.has(id)) { changed = true; return; }
      const stock = stockById.get(id);
      if (parseInt(it.stock, 10) !== stock) { changed = true; next.push({ ...it, stock }); return; }
      next.push(it);
    });
    if (changed) localStorage.setItem(LOCAL_INVENTORY_KEY, JSON.stringify(next));
    return next;
  } catch {
    return null;
  }
}
