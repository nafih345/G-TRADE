// Lens vs other-products split of a purchase bill. Shared by the Purchase Entry summary and the
// printed purchase bill (billing/documentAdapters.js) so both show the same sub-totals.
// A line's group is PurchaseInvoiceItem.item_group: 'LENS' for prescription lenses, '' otherwise.

export const LENS_GROUP = 'LENS';
export const GROUP_LABELS = { LENS: 'Lens', OTHER: 'Frames & Other Products' };

const n = (v) => {
  const x = parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

/** lines: [{ group, qty, total }] -> { lens, other, sections, mixed }.
 *  `sections` lists only the groups present (both when the bill has none). `mixed` = both kinds. */
export function purchaseGroupTotals(lines = []) {
  const lens = { key: 'LENS', label: GROUP_LABELS.LENS, qty: 0, amount: 0, lines: 0 };
  const other = { key: 'OTHER', label: GROUP_LABELS.OTHER, qty: 0, amount: 0, lines: 0 };
  lines.forEach((l) => {
    const g = String(l.group || '').toUpperCase() === LENS_GROUP ? lens : other;
    g.qty += n(l.qty);
    g.amount += n(l.total);
    g.lines += 1;
  });
  [lens, other].forEach((g) => { g.qty = r3(g.qty); g.amount = r2(g.amount); });
  const present = [lens, other].filter((g) => g.lines > 0);
  return { lens, other, sections: present.length ? present : [lens, other], mixed: present.length === 2 };
}
