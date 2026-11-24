// Bill-to-bill allocation rules shared by the Receipt / Payment Voucher form (plain JS so
// `npm run test:bill-settlement` can run them under node --test).

const num = (v) => parseFloat(v) || 0;
const round2 = (v) => Math.round(v * 100) / 100;

/**
 * Auto-FIFO: spread `amount` over the bills top to bottom (oldest first, the order the server
 * lists them), each bill taking at most its due. Bills it doesn't reach are cleared (unticked).
 * Returns new row objects; the input is not changed.
 */
export function fifoAllocate(rows, amount) {
  let left = round2(num(amount));
  return rows.map((r) => {
    const take = round2(Math.min(Math.max(left, 0), num(r.due)));
    left = round2(left - take);
    return take > 0 ? { ...r, selected: true, amount: String(take) } : { ...r, selected: false, amount: '' };
  });
}

/** Allocated / unallocated figures for a Total Receiving (Paying) Amount over the rows. */
export function allocationSummary(rows, receiving) {
  const allocated = round2(rows.filter((r) => r.selected).reduce((t, r) => t + num(r.amount), 0));
  const hasTotal = receiving !== '' && receiving !== null && receiving !== undefined && num(receiving) > 0;
  return { allocated, unallocated: hasTotal ? round2(num(receiving) - allocated) : 0, hasTotal };
}

/** A row's balance after this settlement and its status: Closed / Partial / Open. */
export function rowOutcome(row) {
  const after = round2(num(row.due) - num(row.amount));
  if (num(row.amount) <= 0) return { after: round2(num(row.due)), status: 'Open' };
  return { after: Math.max(after, 0), status: after <= 0.004 ? 'Closed' : 'Partial' };
}
