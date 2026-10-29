// Prints an Eye Test's Clinical Record & Invoice with the shop's Store & Clinic Profile branding.
import { buildEyeTestBillHtml, buildEyeTestReceiptHtml } from './eyeTestBill.js';
import { fetchStoreProfile, readCachedProfile } from './storeProfile';
import { notify } from './notify';

export async function printEyeTestBill(record, { paperSize = 'A4' } = {}) {
  if (!record) return;
  // Open first (inside the click) so pop-up blockers allow it, then fill it.
  const win = window.open('', '_blank', paperSize === 'A5' ? 'width=640,height=800' : 'width=900,height=950');
  if (!win) { notify('Allow pop-ups to print the clinical record.', 'warning'); return; }
  let store = readCachedProfile();
  try { store = (await fetchStoreProfile()) || store; } catch { /* the cached copy will do */ }
  win.document.open();
  win.document.write(buildEyeTestBillHtml(record, { store, paperSize }));
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

/** The short payment receipt (80 mm). */
export async function printEyeTestReceipt(record) {
  if (!record) return;
  const win = window.open('', '_blank', 'width=420,height=700');
  if (!win) { notify('Allow pop-ups to print the receipt.', 'warning'); return; }
  let store = readCachedProfile();
  try { store = (await fetchStoreProfile()) || store; } catch { /* the cached copy will do */ }
  win.document.open();
  win.document.write(buildEyeTestReceiptHtml(record, { store }));
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 250);
}

export default printEyeTestBill;
