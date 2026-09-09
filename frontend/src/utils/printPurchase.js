// Thin compatibility layer over the Bill Rendering Engine (frontend/src/billing).
// Keeps its original name/signature; the layout now comes from the template assigned to
// PURCHASE_BILL in Settings → Bill & Invoice Designer.
import { printBill } from '../billing/printBill';

export const printPurchaseReceipt = (invoice) => {
  if (!invoice) return;
  printBill({ doc: invoice, documentType: 'PURCHASE_BILL' });
};

export default printPurchaseReceipt;
