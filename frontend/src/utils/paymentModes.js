// What kind of payment a pay-mode label is, whatever the screen calls it ("UPI", "GPAY / UPI",
// "Bank Transfer", "BANK", "Cash Collection"...). Mirrors the backend's
// financial/accounting_catalog.PAYMENT_METHOD_ROLES matching order, so the extra details a
// screen asks for always match the ledger the payment will post to.
const KIND_NEEDLES = [
  ['split', 'split'],
  ['credit', 'credit'],
  ['upi', 'upi'], ['gpay', 'upi'], ['phonepe', 'upi'], ['paytm', 'upi'], ['wallet', 'upi'],
  ['card', 'card'],
  ['cash', 'cash'],
  ['bank', 'bank'], ['neft', 'bank'], ['rtgs', 'bank'], ['imps', 'bank'], ['cheque', 'bank'], ['transfer', 'bank'],
];

export const paymentKind = (method) => {
  const m = String(method || '').toLowerCase();
  if (!m) return 'cash';
  const hit = KIND_NEEDLES.find(([needle]) => m.includes(needle));
  return hit ? hit[1] : 'other';
};

// BANK and UPI money lands in a bank the user picks; CASH can be marked Paid / Unpaid.
export const needsBank = (method) => ['bank', 'upi'].includes(paymentKind(method));
export const isCashMode = (method) => paymentKind(method) === 'cash';

export const CASH_PAID = 'PAID';
export const CASH_UNPAID = 'UNPAID';
