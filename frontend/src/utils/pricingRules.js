// Settings → Pricing Rules & Offers, client side: which bill lines are priced under their floor.
// Mirrors backend apps/company/pricing_rules.py `price_violations` — the server is the one that
// actually refuses the save; this only lets New Sale flag the line as it is typed.
// Pure (no React / axios) so it runs under `node --test`.
import { PAIR, PIECE, physicalQty } from './lensUnits.js';

export const PRICING_RULES_API = '/api/company/pricing-rules/';
export const PRICING_FLOORS_API = '/api/company/pricing-rules/floors/';
export const PRICING_APPROVE_API = '/api/company/pricing-rules/approve/';

export const OFFER_TAGS = ['Clearance Stock', 'Dead Stock', 'Festival Offer', 'Season Sale', 'Display Piece'];

const TOLERANCE = 0.005;
const num = (v) => Number(v) || 0;
const round2 = (n) => Math.round(n * 100) / 100;

/** Stock units of the product a line sells (a single lens of a pair-counted lens = 1/2). */
export function costUnits(row, stockUnit) {
  const qty = Math.max(0, parseInt(row.qty, 10) || 0);
  const selling = row.lens?.sellingUnit;
  if (selling !== PAIR && selling !== PIECE) return qty;
  const pieces = physicalQty(selling, qty);
  return stockUnit === PIECE ? pieces : pieces / 2;
}

/**
 * rows: billing-grid rows ({productId, qty, gross, disc, lens}); floors: {productId: info} from
 * the floors endpoint; billDiscount: coupon + overall discount (spread over every line by its net).
 * → {rowId: {netUnit, floorUnit, costUnit, offer, marginApplied}} for lines under their floor.
 */
export function findPriceViolations(rows, floors, billDiscount = 0) {
  const out = {};
  if (!rows?.length || !floors) return out;
  const nets = rows.map(r => Math.max(0, num(r.gross) - num(r.disc)));
  const totalNet = nets.reduce((a, b) => a + b, 0);
  const disc = num(billDiscount);
  const factor = totalNet > 0 && disc > 0.01 ? Math.max(0, 1 - disc / totalNet) : 1;
  rows.forEach((row, i) => {
    const info = row.productId ? floors[row.productId] : null;
    const qty = parseInt(row.qty, 10) || 0;
    if (!info || info.floor == null || qty <= 0) return;
    const units = costUnits(row, info.lens_stock_unit);
    const lineFloor = num(info.floor) * units;
    const lineNet = nets[i] * factor;
    if (lineNet + TOLERANCE < lineFloor) {
      out[row.id] = {
        netUnit: round2(lineNet / qty),
        floorUnit: round2(lineFloor / qty),
        costUnit: round2((num(info.cost) * units) / qty),
        offer: info.offer || null,
        marginApplied: info.base_floor != null && num(info.base_floor) > num(info.cost),
      };
    }
  });
  return out;
}

/** "₹80.00 is below the cost price (₹100.00)" — same wording as the server's refusal. */
export function violationText(v, symbol = '₹') {
  const floor = `${symbol}${v.floorUnit.toFixed(2)}`;
  let reason = `the cost price (${floor})`;
  if (v.offer) reason = `the ${v.offer.tag} offer price (${floor})`;
  else if (v.marginApplied) reason = `the minimum selling price (${floor}; cost ${symbol}${v.costUnit.toFixed(2)} + margin)`;
  return `${symbol}${v.netUnit.toFixed(2)} is below ${reason}`;
}

/** Offer price per selling unit for a row (lens singles of pair stock pay half), or null. */
export function offerUnitPrice(row, info) {
  const price = info?.offer?.offer_price;
  if (price == null) return null;
  const qty = parseInt(row.qty, 10) || 0;
  if (qty <= 0) return null;
  return round2((num(price) * costUnits(row, info.lens_stock_unit)) / qty);
}
