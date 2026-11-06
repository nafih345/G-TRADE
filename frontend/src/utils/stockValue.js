// Stock Overview row value: on-hand quantity × the price the stock actually sells at.
// Mirrored in backend apps/inventory/stock_overview.py (stock_value) for the export.
//
// - A running offer with a fixed offer_price values its units at that price. A partial offer
//   (apply_to_all === false) covers only `remaining` units; the rest stay at the selling price.
// - An offer with no offer_price ("may sell at any price") has no price to value at → selling price.
// - While a row is being edited inline, the typed quantity is used; a typed selling price that
//   differs from the saved one is taken as a manual override and values every unit at it.

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n) => Math.round(n * 100) / 100;

/** The offer price that applies to this row, or null when none (no offer / "any price"). */
export function activeOfferPrice(offer) {
  if (!offer || offer.offer_price === null || offer.offer_price === undefined || offer.offer_price === '') return null;
  return num(offer.offer_price);
}

/**
 * @param {object} row  stock-overview row: { stock, retail_price, offer }
 * @param {object} [edit]  inline edit { values: {stock, retail_price}, original: {retail_price} }
 * @returns {{ value:number, qty:number, price:number, offerPrice:number|null, offerUnits:number,
 *             basis:'regular'|'offer'|'mixed'|'edited' }}
 */
export function stockValue(row, edit) {
  const qty = Math.max(0, num(edit ? edit.values?.stock : row?.stock));
  const price = num(edit ? edit.values?.retail_price : row?.retail_price);
  const priceEdited = Boolean(edit) && num(edit.values?.retail_price) !== num(edit.original?.retail_price);
  const offerPrice = activeOfferPrice(row?.offer);
  if (priceEdited || offerPrice === null) {
    return { value: round2(qty * price), qty, price, offerPrice, offerUnits: 0, basis: priceEdited ? 'edited' : 'regular' };
  }
  const all = row.offer.apply_to_all !== false;
  const offerUnits = all ? qty : Math.min(qty, Math.max(0, Math.floor(num(row.offer.remaining))));
  const value = round2(offerUnits * offerPrice + (qty - offerUnits) * price);
  const basis = offerUnits === 0 ? 'regular' : offerUnits === qty ? 'offer' : 'mixed';
  return { value, qty, price, offerPrice, offerUnits, basis };
}
