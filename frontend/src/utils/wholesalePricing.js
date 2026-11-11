// Wholesale POS pricing hierarchy + tax handling (pure helpers, unit-tested in
// __tests__/wholesalePricing.test.js).
//
// Price tiers on a product (all per unit):
//   costPrice     — purchase cost (internal; margin reference only)
//   mrp           — printed maximum retail price (always tax-inclusive by Indian convention)
//   wholesaleRate — the configured wholesale selling tier (null = not set)
//   retailPrice   — the retail sale price
//
// A cart line's `rate` is ALWAYS the tax-exclusive taxable unit value, so every consumer
// (reports, bill print, accounting via summary.totalGst) keeps working unchanged. A line
// whose price was entered tax-inclusive also carries `taxInclusive: true` and `inclRate`
// (the number shown in the Unit Price cell); `rate` is then derived = inclRate / (1 + gst%).
// Zero-tax (0%) lines are first-class: 0 is never replaced by a default slab.

const num = (v) => {
  if (v === undefined || v === null || v === '') return null;
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/[^0-9.\-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

export const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

// A tax % from any of the shapes the API / local caches use ("5%", "5", 5, 0, "0%").
// Returns null when unknown — callers decide the fallback; 0 always stays 0.
export function parseTaxPercent(...vals) {
  for (const v of vals) {
    const n = num(v);
    if (n !== null && n >= 0 && n <= 100) return n;
  }
  return null;
}

const positive = (...vals) => {
  for (const v of vals) {
    const n = num(v);
    if (n !== null && n > 0) return n;
  }
  return null;
};

// Price tiers from a /api/products/products/ row. MRP falls back to extra_data.mrp and the
// legacy wholesale_price column (which the Product Master fills with MRP); the wholesale tier
// is only the dedicated wholesale_sale_price column.
export function productPriceTiers(p = {}) {
  const extra = p.extra_data && typeof p.extra_data === 'object' ? p.extra_data : {};
  const retailPrice = positive(p.retail_price, p.selling_price, p.price) ?? 0;
  const mrp = positive(p.mrp, extra.mrp, p.wholesale_price);
  const wholesaleRate = positive(p.wholesale_sale_price);
  const costPrice = positive(p.cost_price, p.purchase_price) ?? 0;
  return {
    costPrice,
    mrp,
    wholesaleRate,
    retailPrice,
    // What the dealer-tier resolver starts from: wholesale tier → MRP → retail (the old chain).
    wholesaleBase: wholesaleRate ?? mrp ?? retailPrice,
  };
}

export const deriveExclusive = (inclPrice, gst) => {
  const p = num(inclPrice) ?? 0;
  const g = num(gst) ?? 0;
  return g > 0 ? p / (1 + g / 100) : p;
};

// The number the operator sees / types in the Unit Price cell.
export const shownPrice = (line) => (line?.taxInclusive ? line.inclRate : line?.rate);

// Sets the Unit Price cell value. `price` may be half-typed text ("12."); it is kept as typed
// in the visible field while the derived `rate` is always a number.
export function setLinePrice(line, price) {
  if (line.taxInclusive) return { ...line, inclRate: price, rate: deriveExclusive(price, line.gst) };
  const { inclRate, ...rest } = line;
  return { ...rest, rate: price };
}

// Changing the slab on an inclusive line keeps the agreed inclusive price; on an exclusive
// line the rate stays and the tax on top changes.
export function setLineTax(line, gst) {
  const next = { ...line, gst };
  if (line.taxInclusive) next.rate = deriveExclusive(line.inclRate, gst);
  return next;
}

// Flips whether the price in the Unit Price cell includes tax. The figure in the cell stays;
// its meaning changes (1000 excl. 12% → 1120 total; 1000 incl. 12% → 1000 total).
export function setLineTaxMode(line, inclusive) {
  if (Boolean(line.taxInclusive) === Boolean(inclusive)) return line;
  if (inclusive) {
    const shown = line.rate;
    return { ...line, taxInclusive: true, inclRate: shown, rate: deriveExclusive(shown, line.gst) };
  }
  const { inclRate, ...rest } = line;
  return { ...rest, taxInclusive: false, rate: num(inclRate) ?? 0 };
}

// A new line priced at `price` from the master/tier, in the product's own tax treatment.
export const pricedLine = (line, price, inclusive) =>
  (inclusive ? { ...line, taxInclusive: true, inclRate: price, rate: deriveExclusive(price, line.gst) }
    : { ...line, taxInclusive: false, rate: price });

const TAX_CATEGORY_LABEL = {
  ZERO_RATED: 'Zero rated', EXEMPT: 'Exempt', NIL_RATED: 'Nil rated', NON_TAXABLE: 'Non-taxable',
};

// Short tag for a line's tax treatment: "Exempt" / "Zero rated" / "0% tax" for 0% lines.
export function zeroTaxLabel(gst, category) {
  if ((num(gst) ?? 0) !== 0) return '';
  return TAX_CATEGORY_LABEL[String(category || '').toUpperCase()] || '0% tax';
}

// Unit price incl. tax, for the MRP comparison (MRP is a tax-inclusive ceiling).
export const unitPriceInclTax = (line) => {
  if (line.taxInclusive) return num(line.inclRate) ?? 0;
  return (num(line.rate) ?? 0) * (1 + (num(line.gst) ?? 0) / 100);
};

// Margin vs cost + MRP check for one line (per unit, after the line discount %).
export function lineMargin(line) {
  const cost = num(line.costPrice) ?? 0;
  const rate = num(line.rate) ?? 0;
  const disc = line.discountMode === 'FIXED' ? 0 : (num(line.discount) ?? 0);
  const net = rate * (1 - disc / 100);
  const mrp = num(line.mrp);
  return {
    cost,
    net,
    marginPct: cost > 0 && net > 0 ? ((net - cost) / cost) * 100 : null,
    belowCost: cost > 0 && !line.isFreeGift && net < cost - 0.005,
    aboveMrp: mrp > 0 && unitPriceInclTax(line) > mrp + 0.005,
  };
}

// The prices an operator can pick for a line. `resolved` is resolvePriceForDealer's result.
export function priceChoices(product = {}, resolved = {}) {
  const out = [];
  const push = (key, label, price, opts = {}) => {
    const n = num(price);
    if (n === null || n <= 0) return;
    out.push({ key, label, price: round2(n), ...opts });
  };
  const wsTier = num(product.wholesaleRate);
  push('WHOLESALE', wsTier ? 'Wholesale price' : 'Wholesale price (not set — MRP / sale price)', resolved.wholesale ?? product.wholesalePrice, { tier: 'WHOLESALE' });
  if (resolved.tier && !['WHOLESALE', 'RETAIL', 'CUSTOM'].includes(resolved.tier) && num(resolved.rate) !== num(resolved.wholesale)) {
    push('DEALER', resolved.tier === 'SPECIAL' ? 'Dealer special / price list' : 'Dealer tier price', resolved.rate, { tier: resolved.tier });
  }
  push('RETAIL', 'Retail sale price', product.retailPrice, { tier: 'RETAIL' });
  // MRP is printed tax-inclusive, so choosing it makes the line inclusive.
  push('MRP', 'MRP (incl. tax)', product.mrp, { tier: 'MRP', inclusive: true });
  return out;
}

// Tax per slab across the bill. `factor` spreads the bill-level scheme discount pro-rata
// (same rule as the POS summary). Lines with 0% contribute to `zeroTaxValue`.
export function taxBreakup(lines, factor = 1, lineTotals) {
  const bySlab = new Map();
  let zeroTaxValue = 0;
  (lines || []).forEach((it) => {
    const taxable = lineTotals(it).gross * factor;
    const g = num(it.gst) ?? 0;
    if (g === 0) zeroTaxValue += taxable;
    const cur = bySlab.get(g) || { rate: g, taxable: 0, tax: 0 };
    cur.taxable += taxable;
    cur.tax += taxable * (g / 100);
    bySlab.set(g, cur);
  });
  return {
    slabs: Array.from(bySlab.values()).sort((a, b) => a.rate - b.rate),
    zeroTaxValue,
  };
}
