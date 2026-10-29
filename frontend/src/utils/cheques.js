// Cheque details on Receipt / Payment Vouchers (mirrors backend apps/financial/cheques.py).
// The cheque amount is always the pay line's amount: the server records what the line posted.

export const CHEQUE_MODE = 'Cheque';

// Register status -> label and badge colours (text, background).
export const CHEQUE_STATUSES = {
  PENDING: { label: 'Pending', fg: '#92400e', bg: '#fef3c7' },
  DEPOSITED: { label: 'Deposited', fg: '#1e40af', bg: '#dbeafe' },
  CLEARED: { label: 'Cleared', fg: '#166534', bg: '#dcfce7' },
  BOUNCED: { label: 'Bounced', fg: '#991b1b', bg: '#fee2e2' },
  CANCELLED: { label: 'Cancelled', fg: '#475569', bg: '#e2e8f0' },
};
export const OPEN_STATUSES = ['PENDING', 'DEPOSITED'];

export const localYmd = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const DAY_MS = 24 * 60 * 60 * 1000;
const utcDay = (ymd) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
};

/** Whole days from `from` to `to` (YYYY-MM-DD), or null if either is missing. */
export const daysBetween = (from, to) => {
  const a = utcDay(from);
  const b = utcDay(to);
  return a === null || b === null ? null : Math.round((b - a) / DAY_MS);
};

export const blankCheque = (defaults = {}) => ({
  chequeNumber: '', chequeDate: localYmd(), bankName: '', depositedDate: '', partyName: '', remarks: '', ...defaults,
});

/** The countdown runs to the (planned) deposit date, else the cheque date. */
export const chequeDueDate = (c) => (c ? c.depositedDate || c.chequeDate || '' : '');

export const chequeDaysLeft = (c, today = localYmd()) => daysBetween(today, chequeDueDate(c));

export const daysLeftLabel = (n) => {
  if (n === null || n === undefined) return '—';
  if (n === 0) return 'Due today';
  if (n < 0) return `Overdue by ${-n} day${n === -1 ? '' : 's'}`;
  return `${n} day${n === 1 ? '' : 's'} left`;
};

/** 'overdue' | 'today' | 'soon' (within a week) | 'later' | '' */
export const daysLeftTone = (n) => {
  if (n === null || n === undefined) return '';
  if (n < 0) return 'overdue';
  if (n === 0) return 'today';
  return n <= 7 ? 'soon' : 'later';
};

/** Problems with a pay line's cheque, worded for the voucher footer. Empty = OK. */
export const validateCheque = (c, amount) => {
  const out = [];
  if (!c) return ['enter the cheque details'];
  if (!String(c.chequeNumber || '').trim()) out.push('enter the cheque number');
  if (!c.chequeDate) out.push('enter the cheque date');
  if (!(parseFloat(amount) > 0)) out.push('enter the cheque amount');
  if (c.depositedDate && c.chequeDate && c.depositedDate < c.chequeDate) out.push('the deposited date is before the cheque date');
  return out;
};

/** Server payload (ChequeInputSerializer). `ref` ties together pieces of one cheque split over parties. */
export const chequePayload = (c, ref) => ({
  cheque_number: String(c.chequeNumber || '').trim(),
  cheque_date: c.chequeDate,
  bank_name: String(c.bankName || '').trim(),
  deposited_date: c.depositedDate || null,
  party_name: String(c.partyName || '').trim(),
  remarks: String(c.remarks || '').trim(),
  ...(ref !== undefined ? { ref: String(ref) } : {}),
});

/** Register row (API shape) -> the dialog's shape, for editing a saved cheque. */
export const chequeFromRow = (r) => ({
  chequeNumber: r.cheque_number || '', chequeDate: r.cheque_date || '', bankName: r.bank_name || '',
  depositedDate: r.deposited_date || '', partyName: r.party_name || '', remarks: r.remarks || '',
});
