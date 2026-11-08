import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseTaxPercent, productPriceTiers, setLinePrice, setLineTax, setLineTaxMode, pricedLine,
  shownPrice, zeroTaxLabel, lineMargin, priceChoices, taxBreakup, round2,
} from '../wholesalePricing.js';

// Same formula as wholesaleConstants.computeLineTotals (exclusive rate × qty − disc%, + gst).
const totals = (it) => {
  const base = (Number(it.rate) || 0) * (Number(it.qty) || 0);
  const gross = base * (1 - (Number(it.discount) || 0) / 100);
  const gst = gross * ((Number(it.gst) || 0) / 100);
  return { gross, gst, total: gross + gst };
};

test('zero tax stays zero; unknown is null (caller picks the fallback)', () => {
  assert.equal(parseTaxPercent(0), 0);
  assert.equal(parseTaxPercent('0%'), 0);
  assert.equal(parseTaxPercent('0'), 0);
  assert.equal(parseTaxPercent('5%'), 5);
  assert.equal(parseTaxPercent(null, '', undefined), null);
  assert.equal(parseTaxPercent(null, '12'), 12);
  assert.equal(parseTaxPercent('abc'), null);
});

test('price tiers: wholesale tier, MRP from mrp / extra / legacy column, never guessed', () => {
  const t = productPriceTiers({ cost_price: '400', retail_price: '900', mrp: 1000, wholesale_sale_price: '650' });
  assert.deepEqual(t, { costPrice: 400, mrp: 1000, wholesaleRate: 650, retailPrice: 900, wholesaleBase: 650 });
  const legacy = productPriceTiers({ retail_price: '900', wholesale_price: '1000', wholesale_sale_price: null });
  assert.equal(legacy.mrp, 1000);
  assert.equal(legacy.wholesaleRate, null);
  assert.equal(legacy.wholesaleBase, 1000); // old chain: MRP column → sale price
  const bare = productPriceTiers({ retail_price: '300' });
  assert.equal(bare.mrp, null);
  assert.equal(bare.wholesaleBase, 300);
});

test('exclusive line: price is the taxable rate, tax goes on top', () => {
  const l = setLinePrice({ qty: 2, rate: 0, gst: 12 }, 1000);
  assert.equal(l.rate, 1000);
  assert.equal(round2(totals(l).total), 2240);
});

test('inclusive line: typed price includes tax, rate is derived', () => {
  const l = setLinePrice({ qty: 1, gst: 12, taxInclusive: true }, 1120);
  assert.equal(round2(l.rate), 1000);
  assert.equal(shownPrice(l), 1120);
  assert.equal(round2(totals(l).total), 1120);
  // changing the slab keeps the agreed inclusive price
  const g = setLineTax(l, 5);
  assert.equal(round2(totals(g).total), 1120);
  assert.equal(round2(totals(g).gst), 53.33);
  // half-typed text stays in the cell, rate is a number
  const typed = setLinePrice(l, '11.');
  assert.equal(typed.inclRate, '11.');
  assert.equal(typeof typed.rate, 'number');
});

test('zero-tax inclusive and exclusive lines total the same', () => {
  const inc = pricedLine({ qty: 3, gst: 0 }, 500, true);
  const exc = pricedLine({ qty: 3, gst: 0 }, 500, false);
  assert.equal(totals(inc).total, 1500);
  assert.equal(totals(exc).total, 1500);
  assert.equal(totals(inc).gst, 0);
});

test('toggling tax mode keeps the figure in the price cell', () => {
  const exc = { qty: 1, rate: 1000, gst: 12 };
  const inc = setLineTaxMode(exc, true);
  assert.equal(shownPrice(inc), 1000);
  assert.equal(round2(totals(inc).total), 1000);
  const back = setLineTaxMode(inc, false);
  assert.equal(back.rate, 1000);
  assert.equal('inclRate' in back, false);
  assert.equal(round2(totals(back).total), 1120);
  assert.equal(setLineTaxMode(exc, false), exc);
});

test('zero-tax labels follow the tax master category', () => {
  assert.equal(zeroTaxLabel(0, 'EXEMPT'), 'Exempt');
  assert.equal(zeroTaxLabel('0', 'ZERO_RATED'), 'Zero rated');
  assert.equal(zeroTaxLabel(0, null), '0% tax');
  assert.equal(zeroTaxLabel(5, 'EXEMPT'), '');
});

test('margin: below cost and above MRP (MRP compared incl. tax)', () => {
  const m = lineMargin({ rate: 500, discount: 10, gst: 12, costPrice: 400, mrp: 600 });
  assert.equal(m.net, 450);
  assert.equal(round2(m.marginPct), 12.5);
  assert.equal(m.belowCost, false);
  assert.equal(m.aboveMrp, false); // 500 × 1.12 = 560 < 600
});

test('above-MRP flag uses the tax-inclusive unit price', () => {
  assert.equal(lineMargin({ rate: 500, gst: 12, mrp: 600 }).aboveMrp, false); // 560
  assert.equal(lineMargin({ rate: 550, gst: 12, mrp: 600 }).aboveMrp, true); // 616
  assert.equal(lineMargin({ taxInclusive: true, inclRate: 600, rate: 535.71, gst: 12, mrp: 600 }).aboveMrp, false);
  assert.equal(lineMargin({ rate: 300, costPrice: 400 }).belowCost, true);
  assert.equal(lineMargin({ rate: 0, costPrice: 400, isFreeGift: true }).belowCost, false);
  assert.equal(lineMargin({ rate: 300, costPrice: 0 }).marginPct, null);
});

test('price choices list the hierarchy; MRP is an inclusive choice', () => {
  const p = { wholesaleRate: 650, wholesalePrice: 650, retailPrice: 900, mrp: 1000 };
  const c = priceChoices(p, { rate: 617.5, tier: 'DEALER', wholesale: 650 });
  assert.deepEqual(c.map(x => x.key), ['WHOLESALE', 'DEALER', 'RETAIL', 'MRP']);
  assert.equal(c.find(x => x.key === 'MRP').inclusive, true);
  const none = priceChoices({ retailPrice: 900, wholesalePrice: 900 }, { rate: 900, tier: 'WHOLESALE', wholesale: 900 });
  assert.deepEqual(none.map(x => x.key), ['WHOLESALE', 'RETAIL']);
  assert.match(none[0].label, /not set/);
});

test('tax breakup per slab with zero-tax value and scheme factor', () => {
  const lines = [
    { qty: 1, rate: 1000, gst: 12 },
    { qty: 2, rate: 250, gst: 0 },
    { qty: 1, rate: 200, gst: 5 },
  ];
  const b = taxBreakup(lines, 0.9, totals);
  assert.deepEqual(b.slabs.map(s => s.rate), [0, 5, 12]);
  assert.equal(round2(b.zeroTaxValue), 450);
  assert.equal(round2(b.slabs[0].tax), 0);
  assert.equal(round2(b.slabs[2].tax), 108);
});
