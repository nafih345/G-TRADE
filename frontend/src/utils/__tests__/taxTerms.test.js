// Country-based tax terminology (GST / VAT / Sales Tax / Tax) and the Tax Configuration master
// switch: labels follow the country, a switched-off tax charges 0% on new lines, and prints
// hide tax columns / registration numbers unless the document was itself billed with tax.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishBusinessPrefs, taxTermsForCountry, getTaxSettings, effectiveTaxPercent, taxText, isGstSplit,
} from '../localeFormat.js';
import { taxRateList, taxRateChoices, setKnownTaxSlabs } from '../taxRates.js';
import { ITEM_COLUMNS, BILL_FIELDS } from '../../billing/billFields.js';
import { toBillModel } from '../../billing/documentAdapters.js';
import { PRESET_TEMPLATES } from '../../billing/templatePresets.js';
import { convertLegacyTemplate } from '../../billing/billLayout.js';

const use = (country, extra = {}, payload = {}) => publishBusinessPrefs({
  preferences: { country, base_currency: 'INR', ...extra }, currency_symbol: '₹', ...payload,
});

test('country → tax label and registration label', () => {
  assert.deepEqual(taxTermsForCountry('IN'), { label: 'GST', regLabel: 'GSTIN' });
  for (const c of ['AE', 'SA', 'OM', 'BH']) assert.deepEqual(taxTermsForCountry(c), { label: 'VAT', regLabel: 'TRN' });
  for (const c of ['GB', 'DE', 'FR', 'IE']) assert.deepEqual(taxTermsForCountry(c), { label: 'VAT', regLabel: 'VAT No' });
  assert.deepEqual(taxTermsForCountry('US'), { label: 'Sales Tax', regLabel: 'Tax ID' });
  for (const c of ['QA', 'KW', 'JP', '', undefined]) assert.deepEqual(taxTermsForCountry(c), { label: 'Tax', regLabel: 'Tax Registration No' });
});

test('global settings follow the saved country and switch', () => {
  use('AE', { tax_enabled: true }, { tax_registration_number: '100123456700003' });
  assert.deepEqual(getTaxSettings(), {
    isTaxEnabled: true, taxLabel: 'VAT', taxRegLabel: 'TRN', taxRegistrationNumber: '100123456700003',
  });
  assert.equal(taxText('GST %'), 'VAT %');
  assert.equal(taxText('CGST'), 'CGST', 'only the whole word GST is replaced');
  assert.equal(isGstSplit(), false);
  use('IN');
  assert.equal(getTaxSettings().taxLabel, 'GST');
  assert.equal(isGstSplit(), true);
  assert.equal(getTaxSettings().isTaxEnabled, true, 'tax is on by default');
});

test('switched-off tax charges 0% on new lines', () => {
  use('QA', { tax_enabled: true });
  assert.equal(effectiveTaxPercent('5%'), 5);
  assert.equal(effectiveTaxPercent(0), 0);
  use('QA', { tax_enabled: false });
  assert.equal(effectiveTaxPercent(18), 0);
  assert.equal(getTaxSettings().taxLabel, 'Tax');
});

test('rate pickers: configured slabs win, else a country list; current value always offered', () => {
  use('IN');
  setKnownTaxSlabs([]);
  assert.deepEqual(taxRateList(), [0, 5, 12, 18, 28]);
  use('AE');
  setKnownTaxSlabs([{ rate: 5, appliesToSales: true, appliesToPurchases: true }, { rate: 15, appliesToSales: false }]);
  assert.deepEqual(taxRateList(), [0, 5]);
  assert.deepEqual(taxRateList(undefined, { kind: 'purchases' }), [0, 5, 15]);
  assert.deepEqual(taxRateChoices(undefined, '7.5%').map((o) => o.label), ['0% (Exempt)', '5% VAT', '7.5% VAT']);
  setKnownTaxSlabs([]);
});

test('bill catalog labels follow the tax name', () => {
  use('AE');
  const col = (k) => ITEM_COLUMNS.find((c) => c.key === k).label;
  assert.equal(col('taxPercent'), 'VAT %');
  assert.equal(col('taxAmount'), 'VAT Amt');
  assert.equal(BILL_FIELDS.find((f) => f.id === 'party.gstin').label, 'TRN');
  use('IN');
  assert.equal(col('taxPercent'), 'GST %');
  assert.equal(BILL_FIELDS.find((f) => f.id === 'company.gstin').label, 'Store GSTIN');
});

test('prints: VAT label + TRN; tax off hides the tax column unless the bill carries tax', async () => {
  const { renderBillHtml } = await import('../../billing/renderBillHtml.js');
  const { renderVisualBillHtml } = await import('../../billing/renderBillLayout.js');
  const legacy = PRESET_TEMPLATES[0];
  const visual = {
    paper_size: 'A4', orientation: 'portrait', margins: { top: 10, right: 10, bottom: 10, left: 10 },
    config: convertLegacyTemplate(PRESET_TEMPLATES[0], 190),
  };
  const company = { name: 'Vision', gstin: '100123456700003' };
  const doc = (tax) => ({
    invoice_number: 'INV-1', net_amount: tax ? '105' : '100', tax_amount: String(tax), company,
    items: [{ name: 'Frame', qty: 1, price: 100, tax_rate: tax ? 5 : 0, tax_amount: tax, total: 100 + tax }],
  });

  use('AE', { tax_enabled: true });
  let model = toBillModel(doc(5), 'SALES_INVOICE');
  model.company = { ...model.company, ...company };
  let html = renderBillHtml(legacy, model);
  assert.ok(!html.includes('GSTIN'), 'no GSTIN wording in a UAE bill');
  assert.ok(!/>CGST</.test(html) && !/>SGST</.test(html), 'no Indian split rows');
  const vis = renderVisualBillHtml(visual, model, { measure: 'estimate' }).html;
  assert.ok(!vis.includes('GST %'), 'visual column header renamed');

  use('AE', { tax_enabled: false });
  model = toBillModel(doc(0), 'SALES_INVOICE');
  model.company = { ...model.company, ...company };
  html = renderBillHtml(legacy, model);
  assert.ok(!html.includes('100123456700003'), 'registration number hidden while tax is off');
  const visOff = renderVisualBillHtml(visual, model, { measure: 'estimate' }).html;
  assert.ok(!visOff.includes('VAT %') && !visOff.includes('VAT Amt'), 'tax columns hidden while tax is off');

  // A bill that was billed with tax still prints its tax column so its lines add up.
  model = toBillModel(doc(5), 'SALES_INVOICE');
  const visTaxed = renderVisualBillHtml(visual, model, { measure: 'estimate' }).html;
  const ths = (h) => (h.match(/<th[ >]/g) || []).length;
  assert.ok(ths(visTaxed) > ths(visOff), 'taxed document keeps its tax column');
  const legacyOff = renderBillHtml(legacy, toBillModel(doc(0), 'SALES_INVOICE'));
  const legacyTaxed = renderBillHtml(legacy, toBillModel(doc(5), 'SALES_INVOICE'));
  assert.ok(ths(legacyTaxed) > ths(legacyOff), 'legacy: tax column only when the bill carries tax');
  use('IN', { tax_enabled: true });
});
