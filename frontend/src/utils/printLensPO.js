// Prints a Lens Purchase Order sheet with the shop's Store & Clinic Profile branding.
import { buildOrderSheetHtml } from './lensPurchaseOrders.js';
import { fetchStoreProfile, readCachedProfile } from './storeProfile';
import { notify } from './notify';

export async function printLensPO(po, options = {}) {
  if (!po) return;
  // Open first (inside the click) so pop-up blockers allow it, then fill it.
  const win = window.open('', '_blank', 'width=900,height=700');
  if (!win) { notify('Allow pop-ups to print the lens purchase order.', 'warning'); return; }
  let store = readCachedProfile();
  try { store = (await fetchStoreProfile()) || store; } catch { /* the cached copy will do */ }
  win.document.open();
  win.document.write(buildOrderSheetHtml(po, { ...options, store }));
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

export default printLensPO;
