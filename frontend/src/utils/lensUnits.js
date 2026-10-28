// Spectacle-lens selling units for New Sale: Both Eyes (1 Pair = 2 lenses) or Single Lens
// (1 Piece = 1 lens, one eye).
//
// Pure functions only (no React / axios) so the bill adapter can use them and they run under
// `npm run test:lens`. The prescription rules mirror backend apps/sales/lens_units.py — the server
// re-checks every saved line, so keep the two in step.
//
// A lens line keeps the COMMERCIAL quantity (qty, in pairs or pieces — what is priced) apart from
// the PHYSICAL one (lenses: pairs × 2). Stock is moved by the server from the physical count and
// the product's stock unit; nothing here touches stock.

export const PAIR = 'PAIR';
export const PIECE = 'PIECE';
export const BOTH = 'BOTH';
export const RE = 'RE';
export const LE = 'LE';
export const PIECES_PER_UNIT = { [PAIR]: 2, [PIECE]: 1 };
export const EYE_FIELDS = ['sph', 'cyl', 'axis', 'add', 'prism', 'base'];
export const BASE_OPTIONS = ['IN', 'OUT', 'UP', 'DOWN'];
export const EYE_NAME = { [RE]: 'Right eye (RE)', [LE]: 'Left eye (LE)' };
export const ONE_EYE_MESSAGE = "Only one eye's prescription has been entered. Please complete both eyes or select Single Lens.";
export const DEFAULT_SINGLE_PIECE_PERCENT = 50;

const blank = (v) => v === null || v === undefined || String(v).trim() === '';
const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const PLANO = new Set(['PL', 'PLANO', 'INFINITY', '∞']);

export const emptyEyeRx = () => ({ sph: '', cyl: '', axis: '', add: '', prism: '', base: '' });
export const emptyLensRx = () => ({ re: emptyEyeRx(), le: emptyEyeRx() });

// ---------------------------------------------------------------------------
// Which products are sold by pair / piece
// ---------------------------------------------------------------------------

/** A category / type text naming spectacle lenses (not contact lenses, solutions, cases...). */
export function isSpectacleLensCategory(category) {
  const t = String(category || '').toLowerCase();
  if (!t || /contact|solution|clean|case|cloth|drop|kit|accessor|frame|sunglass/.test(t)) return false;
  return /\blens(es)?\b|ophthalmic/.test(t);
}

/** Pair / Single Lens selection applies to this product. A product can opt in or out with
 *  extra_data.lens_unit_selection (true / false); otherwise its category decides. */
export function isPairSellable(product) {
  if (!product) return false;
  const flag = (product.extra_data || {}).lens_unit_selection;
  if (flag === true || flag === false) return flag;
  return [product.category, product.type, product.category_name].some(isSpectacleLensCategory);
}

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

const positive = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) && n > 0 ? n : null;
};

/**
 * The product's configured price for each selling unit. `basePrice` is the product's selling
 * price, which is per pair unless extra_data.lens_price_unit === 'PIECE'.
 *  - priced per pair: piece = explicit lens_piece_price, else pair × (lens_piece_percent ||
 *    the business default %) / 100;
 *  - priced per piece: pair = explicit lens_pair_price, else piece × 2.
 * Never writes anything back to the product — this only reads its configuration.
 */
export function lensPricing(product, basePrice, defaultPercent = DEFAULT_SINGLE_PIECE_PERCENT) {
  const extra = (product && product.extra_data) || {};
  const priceUnit = String(extra.lens_price_unit || '').toUpperCase() === PIECE ? PIECE : PAIR;
  const stockUnit = String(extra.lens_stock_unit || '').toUpperCase() === PIECE ? PIECE : PAIR;
  const base = round2(parseFloat(basePrice) || 0);
  if (priceUnit === PAIR) {
    const explicit = positive(extra.lens_piece_price);
    const percent = positive(extra.lens_piece_percent) ?? positive(defaultPercent) ?? DEFAULT_SINGLE_PIECE_PERCENT;
    return {
      priceUnit, stockUnit, pairPrice: base,
      piecePrice: explicit !== null ? round2(explicit) : round2((base * percent) / 100),
      pieceSource: explicit !== null ? 'EXPLICIT' : 'PERCENT',
      piecePercent: explicit !== null ? null : percent,
      pairSource: 'BASE',
    };
  }
  const explicitPair = positive(extra.lens_pair_price);
  return {
    priceUnit, stockUnit, piecePrice: base,
    pairPrice: explicitPair !== null ? round2(explicitPair) : round2(base * 2),
    pairSource: explicitPair !== null ? 'EXPLICIT' : 'DOUBLE',
    pieceSource: 'BASE', piecePercent: null,
  };
}

export const unitPrice = (pricing, unit) => (unit === PIECE ? pricing.piecePrice : pricing.pairPrice);

/** How the unit's price was arrived at, for display beside the price. */
export function priceBasis(pricing, unit, fmt = (n) => `₹${round2(n).toFixed(2)}`) {
  if (!pricing) return '';
  if (unit === PIECE) {
    if (pricing.pieceSource === 'EXPLICIT') return 'single-lens price set on the product';
    if (pricing.pieceSource === 'PERCENT') return `${pricing.piecePercent}% of the ${fmt(pricing.pairPrice)} pair price`;
    return 'product price (per piece)';
  }
  if (pricing.pairSource === 'EXPLICIT') return 'pair price set on the product';
  if (pricing.pairSource === 'DOUBLE') return `2 × ${fmt(pricing.piecePrice)} piece price`;
  return 'product price (per pair)';
}

// ---------------------------------------------------------------------------
// Quantities & labels
// ---------------------------------------------------------------------------

export const physicalQty = (unit, qty) => Math.max(0, parseInt(qty, 10) || 0) * (PIECES_PER_UNIT[unit] || 1);

export const unitWord = (unit, qty = 1) => {
  const one = Number(qty) === 1;
  if (unit === PAIR) return one ? 'Pair' : 'Pairs';
  if (unit === PIECE) return one ? 'Piece' : 'Pieces';
  return '';
};

/** "1 Pair (2 Lenses)", "3 Pieces (3 Lenses)", "1 Piece (1 Lens)". */
export function qtyLabel(unit, qty) {
  const q = parseInt(qty, 10) || 0;
  const lenses = physicalQty(unit, q);
  return `${q} ${unitWord(unit, q)} (${lenses} ${lenses === 1 ? 'Lens' : 'Lenses'})`;
}

export const unitLongLabel = (unit) => (unit === PIECE ? 'Piece (1 Lens)' : 'Pair (2 Lenses)');

/** Stock units this line will take, for the hint shown on the line (the server decides). */
export function stockHint(unit, qty, stockUnit) {
  const lenses = physicalQty(unit, qty);
  if (stockUnit === PIECE) return `${lenses} ${lenses === 1 ? 'piece' : 'pieces'} from stock`;
  const pairs = Math.ceil(lenses / 2);
  const broken = lenses % 2 === 1;
  return `${pairs} ${pairs === 1 ? 'pair' : 'pairs'} from stock${broken ? ' (lens stock is counted in pairs — a single lens uses a whole pair)' : ''}`;
}

// ---------------------------------------------------------------------------
// Prescription values
// ---------------------------------------------------------------------------

const parseDioptre = (v) => {
  const s = String(v).trim().replace(/\s+/g, '');
  if (PLANO.has(s.toUpperCase())) return 0;
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(s)) return null;
  return Number(s);
};

/** Tidy a typed power: "-2.5" → "-2.50", "1.25" → "+1.25", "pl" → "PL". Anything not a number is
 *  returned unchanged so validation can name it. */
export function formatDioptre(v) {
  if (blank(v)) return '';
  const s = String(v).trim();
  if (PLANO.has(s.toUpperCase())) return 'PL';
  const n = parseDioptre(s);
  if (n === null) return s;
  if (n === 0) return '0.00';
  return `${n > 0 ? '+' : '-'}${Math.abs(n).toFixed(2)}`;
}

export const eyeEntered = (eye) => ['sph', 'cyl', 'axis', 'add', 'prism'].some((f) => !blank((eye || {})[f]));

const quarter = (n) => Math.abs(n * 4 - Math.round(n * 4)) < 1e-9;

/** Format / range problems in one eye's values (blank fields are not errors here). */
export function eyeValueErrors(eye, label) {
  const e = eye || {};
  const errors = [];
  const dioptre = (field, name, lo, hi) => {
    if (blank(e[field])) return null;
    const n = parseDioptre(e[field]);
    if (n === null) errors.push(`${label} ${name} "${e[field]}" is not a number (e.g. -2.50, +1.25).`);
    else if (n < lo || n > hi) errors.push(`${label} ${name} ${e[field]} is outside ${lo > 0 ? '+' : ''}${lo} to +${hi}.`);
    else if (!quarter(n)) errors.push(`${label} ${name} ${e[field]} must be in 0.25 steps.`);
    return n;
  };
  dioptre('sph', 'SPH', -30, 30);
  const cyl = dioptre('cyl', 'CYL', -10, 10);
  dioptre('add', 'ADD', 0, 4);

  if (!blank(e.axis)) {
    const s = String(e.axis).trim();
    if (!/^\d+$/.test(s)) errors.push(`${label} AXIS "${e.axis}" must be a whole number (0-180).`);
    else if (Number(s) > 180) errors.push(`${label} AXIS ${e.axis} must be between 0 and 180.`);
  } else if (cyl !== null && cyl !== 0) {
    errors.push(`${label} AXIS is required when CYL is entered.`);
  }

  if (!blank(e.prism)) {
    const p = parseDioptre(e.prism);
    if (p === null || p < 0 || p > 20) errors.push(`${label} PRISM "${e.prism}" must be a number from 0 to 20.`);
    else if (p > 0 && !BASE_OPTIONS.includes(String(e.base || '').trim().toUpperCase())) {
      errors.push(`${label} BASE (IN / OUT / UP / DOWN) is required with a prism.`);
    }
  }
  return errors;
}

/**
 * Problems with one lens line: {errors: [...]} — empty when it can be saved.
 * requireComplete = false for a Quotation (an estimate may precede the prescription; whatever was
 * entered must still be valid). Never treats an unentered eye as zero power.
 */
export function validateLensLine(lens, { requireComplete = true } = {}) {
  const errors = [];
  if (!lens) return { errors };
  const unit = lens.sellingUnit;
  const eyeChoice = lens.eye || (unit === PAIR ? BOTH : '');
  const re = lens.rx?.re || {};
  const le = lens.rx?.le || {};
  if (unit !== PAIR && unit !== PIECE) return { errors: ['Choose Both Eyes (1 Pair) or Single Lens (1 Piece).'] };
  if (unit === PIECE && eyeChoice !== RE && eyeChoice !== LE) errors.push('Single Lens: select the eye — Right (RE) or Left (LE).');

  const required = unit === PAIR ? [RE, LE] : (eyeChoice === RE || eyeChoice === LE ? [eyeChoice] : []);
  required.forEach((k) => errors.push(...eyeValueErrors(k === RE ? re : le, EYE_NAME[k])));
  if (!requireComplete) return { errors };

  if (unit === PAIR) {
    const entered = [eyeEntered(re), eyeEntered(le)];
    if (entered.filter(Boolean).length === 1) return { errors: [...errors, ONE_EYE_MESSAGE] };
    if (!entered.some(Boolean)) return { errors: [...errors, 'Enter the prescription for both eyes (RE and LE), or select Single Lens.'] };
  }
  required.forEach((k) => {
    if (blank((k === RE ? re : le).sph)) errors.push(`${EYE_NAME[k]} SPH is required (enter 0.00 or PL for plano).`);
  });
  return { errors };
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

/** "SPH -2.50 CYL -0.75 AXIS 90 ADD +2.00 PRISM 1 BASE IN" — only the fields entered. */
export function formatEyeRx(eye) {
  const e = eye || {};
  const parts = [];
  if (!blank(e.sph)) parts.push(`SPH ${String(e.sph).trim()}`);
  if (!blank(e.cyl)) parts.push(`CYL ${String(e.cyl).trim()}`);
  if (!blank(e.axis)) parts.push(`AXIS ${String(e.axis).trim()}`);
  if (!blank(e.add)) parts.push(`ADD ${String(e.add).trim()}`);
  if (!blank(e.prism)) parts.push(`PRISM ${String(e.prism).trim()}${blank(e.base) ? '' : ` BASE ${String(e.base).trim().toUpperCase()}`}`);
  return parts.join(' ');
}

/** The power text carried on the line and printed on the bill. A pair shows each eye that has a
 *  value; a single lens shows only its own eye, named in full. '' when nothing was entered. */
export function lensPowerText(lens) {
  if (!lens) return '';
  const idx = String(lens.lensIndex ?? '').trim();
  const suffix = idx ? ` [Idx: ${idx}]` : '';
  if (lens.sellingUnit === PIECE) {
    if (lens.eye !== RE && lens.eye !== LE) return '';
    const text = formatEyeRx(lens.eye === RE ? lens.rx?.re : lens.rx?.le);
    return text ? `${lens.eye === RE ? 'Right Eye (RE)' : 'Left Eye (LE)'}: ${text}${suffix}` : '';
  }
  const re = formatEyeRx(lens.rx?.re);
  const le = formatEyeRx(lens.rx?.le);
  const eyes = [];
  if (re) eyes.push(`RE: ${re}`);
  if (le) eyes.push(`LE: ${le}`);
  return eyes.length ? `${eyes.join(' | ')}${suffix}` : '';
}

/** The New Sale prescription grid (rxData: sphOD, cylOD, axisOD, addOD, prismOD, baseOD, ...OS)
 *  → {re, le}. Distance-vision values; ADD from the grid's ADD boxes. */
export function rxFromGrid(rxData = {}) {
  const eye = (k) => ({
    sph: rxData[`sph${k}`] || '', cyl: rxData[`cyl${k}`] || '', axis: rxData[`axis${k}`] || '',
    add: rxData[`add${k}`] || '', prism: rxData[`prism${k}`] || '', base: rxData[`base${k}`] || '',
  });
  return { re: eye('OD'), le: eye('OS') };
}

/** Saved InvoiceItem fields → the line's lens state (null for non-lens lines). */
export function lensFromSavedItem(it) {
  const unit = String(it?.selling_unit || '').toUpperCase();
  if (unit !== PAIR && unit !== PIECE) return null;
  const d = it.lens_details || {};
  const rx = d.rx || {};
  return {
    sellingUnit: unit,
    eye: String(it.lens_eye || (unit === PAIR ? BOTH : '')).toUpperCase(),
    rx: { re: { ...emptyEyeRx(), ...(rx.re || {}) }, le: { ...emptyEyeRx(), ...(rx.le || {}) } },
    lensIndex: d.lens_index || '',
    specs: d.specs || {},
    rxSource: d.rx_source || '',
    pricing: d.pricing ? {
      priceUnit: d.pricing.price_unit || PAIR, stockUnit: d.stock_unit || d.pricing.stock_unit || PAIR,
      pairPrice: Number(d.pricing.pair_price) || 0, piecePrice: Number(d.pricing.piece_price) || 0,
      pieceSource: d.pricing.piece_source || 'PERCENT', piecePercent: d.pricing.piece_percent ?? null,
      pairSource: d.pricing.pair_source || 'BASE',
    } : null,
    rxLinked: false,
  };
}

/** The line's lens state → the InvoiceItem fields the API saves. */
export function lensToPayload(lens, qty) {
  if (!lens) return {};
  const p = lens.pricing || {};
  return {
    selling_unit: lens.sellingUnit,
    lens_eye: lens.sellingUnit === PAIR ? BOTH : (lens.eye || ''),
    pricing_unit: lens.sellingUnit,
    physical_quantity: physicalQty(lens.sellingUnit, qty),
    lens_details: {
      rx: lens.rx,
      lens_index: lens.lensIndex || '',
      specs: lens.specs || {},
      rx_source: lens.rxSource || '',
      pricing: {
        price_unit: p.priceUnit, stock_unit: p.stockUnit, pair_price: p.pairPrice, piece_price: p.piecePrice,
        piece_source: p.pieceSource, piece_percent: p.piecePercent, pair_source: p.pairSource,
      },
    },
  };
}
