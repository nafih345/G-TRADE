// Active-currency display: switching Settings → Business & Localization to QAR must change every
// formatter at once, including bill templates and barcode labels that saved a '₹'.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishBusinessPrefs, getCurrencySymbol, currencyPrefix, formatCurrency, symbolForCurrency,
} from '../localeFormat.js';
import { fmtWithCurrency, formatMoney as billMoney, amountInWords } from '../../billing/billFields.js';
import { resolveFieldElement } from '../../labels/labelFields.js';

const use = (base, symbol, extra = {}) => publishBusinessPrefs({
  preferences: { base_currency: base, number_format: 'INTERNATIONAL', currency_decimals: 2, ...extra },
  currency_symbol: symbol,
});

test('maps the supported currencies', () => {
  assert.equal(symbolForCurrency('INR'), '₹');
  assert.equal(symbolForCurrency('QAR'), 'QAR');
  assert.equal(symbolForCurrency('usd'), '$');
  assert.equal(symbolForCurrency('EUR'), '€');
  assert.equal(symbolForCurrency('GBP'), '£');
  for (const c of ['AED', 'SAR', 'OMR', 'KWD', 'BHD']) assert.equal(symbolForCurrency(c), c);
});

test('saving QAR switches the global symbol and formatter', () => {
  use('INR', '₹', { number_format: 'INDIAN' });
  assert.equal(formatCurrency(123456.5), '₹1,23,456.50');
  use('QAR', 'QAR');
  assert.equal(getCurrencySymbol(), 'QAR');
  assert.equal(currencyPrefix(), 'QAR ');
  assert.equal(formatCurrency(123456.5), 'QAR 123,456.50');
  assert.equal(formatCurrency(-5), '-QAR 5.00');
  assert.equal(formatCurrency(undefined), 'QAR 0.00');
  assert.equal(formatCurrency(10, { decimals: 0 }), 'QAR 10');
});

test('a rupee left behind after leaving INR is treated as stale', () => {
  use('QAR', '₹');
  assert.equal(getCurrencySymbol(), 'QAR');
  use('USD', '');
  assert.equal(getCurrencySymbol(), '$');
  use('QAR', 'QR'); // a symbol the store typed itself is kept
  assert.equal(getCurrencySymbol(), 'QR');
});

test("bill templates that saved '₹' follow the store currency", () => {
  const model = { company: { currency: 'QAR' } };
  assert.equal(fmtWithCurrency({ currencySymbol: '₹' }, model).currencySymbol, 'QAR');
  assert.equal(fmtWithCurrency({}, model).currencySymbol, 'QAR');
  assert.equal(fmtWithCurrency({ currencySymbol: 'QR' }, model).currencySymbol, 'QR');
  assert.equal(billMoney(1200, { currencySymbol: 'QAR', thousands: 'international' }), 'QAR 1,200.00');
  assert.equal(billMoney(1200, { currencySymbol: '₹' }), '₹1,200.00');
});

test('amount in words per currency', () => {
  assert.equal(amountInWords(150000, '₹'), 'Rupees One Lakh Fifty Thousand Only');
  assert.equal(amountInWords(1500000.5, 'QAR'), 'Qatari Riyals One Million Five Hundred Thousand and Fifty Dirhams Only');
  assert.equal(amountInWords(12.345, 'KWD'), 'Kuwaiti Dinars Twelve and Three Hundred Forty Five Fils Only');
});

test("label prefixes saved with '₹' print the active currency", () => {
  use('QAR', 'QAR');
  const el = { field: 'selling_price', prefix: '₹ ', priceFormat: 'number' };
  assert.equal(resolveFieldElement(el, { fields: { selling_price: '1200' } }).text, 'QAR 1,200.00');
  assert.equal(resolveFieldElement({ ...el, prefix: '', priceFormat: 'currency' }, { fields: { selling_price: '1200' } }).text, 'QAR 1,200.00');
});
