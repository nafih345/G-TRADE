// Shared constants + pure helpers for the Wholesale POS module.
// No React here — keeps WholesaleSales.jsx focused on UI/state wiring.
//
// Backend reuse: apps.sales already ships a full (previously unused) wholesale schema —
// Dealer ("WholesaleCustomer"), WholesalePriceList, WholesaleReturn, WholesaleInvoice,
// WholesalePaymentCollection — all plain ModelViewSets under /api/sales/wholesale/*.
// This module talks to those instead of re-inventing dealer/return/payment storage;
// localStorage stays only as an offline cache + the rich line-item invoice record
// (WholesaleInvoice has no items field, so the full invoice — items, delivery, schemes,
// notes — still lives in optical_wholesale_invoices; the backend row is a best-effort
// secondary index other ERP modules could query).

export const WHOLESALE_API = '/api/sales/wholesale';

export const isUuid = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

// Follows DRF's {count,next,previous,results} pagination to fetch every page.
// Falls back to [] (caller decides the offline fallback) on any network error.
export async function fetchAllPages(axios, url) {
  let out = [];
  let next = url;
  let guard = 0;
  while (next && guard < 50) {
    guard += 1;
    const res = await axios.get(next);
    const data = res.data;
    if (Array.isArray(data)) { out = out.concat(data); break; }
    out = out.concat(data?.results || []);
    next = data?.next || null;
  }
  return out;
}

// Dealer <-> backend apps.sales.models.Dealer field mapping.
export function mapDealerFromApi(d) {
  return {
    id: d.id,
    code: d.dealer_code || '',
    name: d.business_name || '',
    contactPerson: d.contact_person || d.owner_name || '',
    phone: d.phone || '',
    email: d.email || '',
    gstin: d.gstin || '',
    billingAddress: d.address || '',
    shippingAddress: d.address || '',
    city: d.city || '', state: d.state || '', pincode: d.pincode || '',
    priceList: categoryToPriceList(d.category),
    category: d.category || 'Wholesale',
    dealerDiscountPercent: 5,
    creditLimit: parseFloat(d.credit_limit) || 0,
    creditDays: parseInt(d.credit_days) || 30,
    openingBalance: parseFloat(d.opening_balance) || 0,
    outstanding: parseFloat(d.outstanding_balance) || 0,
    salesExec: d.sales_executive || '',
    status: d.status || 'Active',
    lastPurchaseDate: '',
    totalPurchases: '',
  };
}

export function mapDealerToApi(local) {
  return {
    dealer_code: local.code || undefined,
    business_name: local.name,
    contact_person: local.contactPerson || local.name,
    phone: local.phone,
    email: local.email || '',
    gstin: local.gstin || '',
    address: local.shippingAddress || local.billingAddress || '',
    credit_limit: parseFloat(local.creditLimit) || 0,
    credit_days: parseInt(local.creditDays) || 30,
    outstanding_balance: parseFloat(local.outstanding) || 0,
    category: priceListToCategory(local.priceList),
    sales_executive: local.salesExec || '',
  };
}

// The real Dealer model has no dedicated "price list tier" field — its free-text
// `category` is reused for that instead of inventing a parallel backend field.
function categoryToPriceList(category) {
  const c = (category || '').toUpperCase();
  if (c.includes('VIP')) return 'VIP_DEALER';
  if (c.includes('DISTRIBUTOR')) return 'DISTRIBUTOR';
  if (c.includes('SPECIAL')) return 'SPECIAL';
  if (c.includes('RETAIL')) return 'RETAIL';
  if (c.includes('DEALER')) return 'DEALER';
  return 'WHOLESALE';
}
function priceListToCategory(priceList) {
  return (PRICE_LIST_OPTIONS.find(p => p.value === priceList)?.label || 'Wholesale');
}

export const LS_KEYS = {
  customers: 'optical_wholesale_customers',
  invoices: 'optical_wholesale_invoices',
  held: 'optical_wholesale_held_invoices',
  journals: 'optical_journal_entries',
  inventory: 'optical_inventory_items',
  schemes: 'optical_wholesale_schemes',
  specialPrices: 'optical_wholesale_special_prices',
  returns: 'optical_wholesale_returns',
  creditNotes: 'optical_wholesale_credit_notes',
  payments: 'optical_wholesale_payments',
  salesReps: 'optical_wholesale_sales_reps',
};

export const PRICE_LIST_OPTIONS = [
  { value: 'RETAIL', label: 'Retail' },
  { value: 'WHOLESALE', label: 'Wholesale' },
  { value: 'DEALER', label: 'Dealer' },
  { value: 'DISTRIBUTOR', label: 'Distributor' },
  { value: 'VIP_DEALER', label: 'VIP Dealer' },
  { value: 'SPECIAL', label: 'Special Customer' },
];

export const PRICE_TIER_LABEL = {
  RETAIL: 'Retail', WHOLESALE: 'Wholesale', DEALER: 'Dealer', DISTRIBUTOR: 'Distributor',
  VIP_DEALER: 'VIP Dealer', SPECIAL: 'Special', CUSTOM: 'Custom',
};

export const DELIVERY_TYPES = ['Pickup', 'Local Delivery', 'Courier', 'Transport'];

export const ORDER_STATUSES = ['Draft', 'Confirmed', 'Picking', 'Packed', 'Dispatched', 'Delivered', 'Cancelled'];

export const ORDER_STATUS_COLORS = {
  Draft: { bg: '#f1f5f9', color: '#475569' },
  Confirmed: { bg: '#eef2ff', color: '#4f46e5' },
  Processing: { bg: '#fef9c3', color: '#a16207' },
  Picking: { bg: '#fef9c3', color: '#a16207' },
  Packed: { bg: '#e0f2fe', color: '#0369a1' },
  Dispatched: { bg: '#dcfce7', color: '#15803d' },
  Delivered: { bg: '#dcfce7', color: '#15803d' },
  Cancelled: { bg: '#fef2f2', color: '#dc2626' },
};

export const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Credit Sale', 'Split Payment'];
export const SPLIT_PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Credit'];

export const SCHEME_TYPES = [
  { value: 'PERCENT', label: 'Percentage Discount' },
  { value: 'FIXED', label: 'Fixed Discount' },
  { value: 'DEALER', label: 'Dealer Discount' },
  { value: 'PRODUCT', label: 'Product Discount' },
  { value: 'BRAND', label: 'Brand Discount' },
  { value: 'CATEGORY', label: 'Category Discount' },
  { value: 'SCHEME', label: 'Scheme Discount' },
  { value: 'PROMO', label: 'Promotional Discount' },
  { value: 'BOGO', label: 'Buy X Get Y' },
];

// Schemes can optionally target a product/brand/category/dealer/price-list and be time-boxed
// (startDate/endDate, inclusive, "YYYY-MM-DD"). A scheme with no target + no dates always applies.
export const DEFAULT_SCHEMES = [
  { id: 'sch-1', name: 'Festival Bulk Offer', type: 'PERCENT', value: 5, targetType: null, targetValue: '', startDate: '', endDate: '' },
  { id: 'sch-2', name: 'Volume Purchase Rebate', type: 'FIXED', value: 500, targetType: null, targetValue: '', startDate: '', endDate: '' },
  { id: 'sch-3', name: 'New Season Promo', type: 'PROMO', value: 3, targetType: null, targetValue: '', startDate: '', endDate: '' },
];

export const ADDITIONAL_CHARGE_TYPES = ['Delivery Charge', 'Transport Charge', 'Packing Charge', 'Other Charge'];

export const DEFAULT_ADDITIONAL_CHARGES = ADDITIONAL_CHARGE_TYPES.map(name => ({ name, amount: '', taxable: false }));

export const NOTE_TEMPLATES = ['Delivery before Friday', 'Check damaged items', 'Dealer requested replacement'];

export const DEMO_SALES_REPS = ['Suresh V', 'Priya N', 'Default Exec', 'Anil Kumar', 'Divya R'];

// Roles allowed to manually override a resolved price (F6/rate cell).
export const PRICE_OVERRIDE_ROLES = ['SUPER_ADMIN', 'ADMIN', 'MANAGER'];

export const canOverridePrice = (user) => {
  const role = (user?.role || '').toUpperCase();
  return PRICE_OVERRIDE_ROLES.includes(role);
};

export const INITIAL_DEMO_PRODUCTS = [
  { id: '101', code: 'OPT-RAY-001', sku: 'OPT-RAY-001', name: 'Ray-Ban Aviator Classic (RB3025)', brand: 'Ray-Ban', category: 'Sunglasses', modelNo: 'RB3025', color: 'Gold / Green', size: '58-14-135', power: '—', availableStock: 25, retailPrice: 5200, wholesalePrice: 4200, gst: 18, unit: 'Pcs', barcode: '805289602057' },
  { id: '102', code: 'OPT-OAK-002', sku: 'OPT-OAK-002', name: 'Oakley Holbrook Prizm Black', brand: 'Oakley', category: 'Sunglasses', modelNo: 'OO9102', color: 'Matte Black', size: '55-18-137', power: '—', availableStock: 14, retailPrice: 6300, wholesalePrice: 5100, gst: 18, unit: 'Pcs', barcode: '888392237841' },
  { id: '103', code: 'OPT-ESS-003', sku: 'OPT-ESS-003', name: 'Essilor Crizal Sapphire 1.56 Lens', brand: 'Essilor', category: 'Optical Lens', modelNo: 'CRZ-1.56', color: 'Clear', size: '—', power: '-2.00 / -0.75', availableStock: 50, retailPrice: 2300, wholesalePrice: 1850, gst: 18, unit: 'Pair', barcode: '366282001092' },
  { id: '104', code: 'OPT-GUCCI-004', sku: 'OPT-GUCCI-004', name: 'Gucci Square Acetate Optical Frame', brand: 'Gucci', category: 'Frames', modelNo: 'GG0516O', color: 'Havana', size: '52-20-145', power: '—', availableStock: 8, retailPrice: 15500, wholesalePrice: 12500, gst: 18, unit: 'Pcs', barcode: '889652104921' },
  { id: '105', code: 'OPT-ACU-005', sku: 'OPT-ACU-005', name: 'Acuvue Oasys 1-Day (30 Pack)', brand: 'Johnson & Johnson', category: 'Contact Lens', modelNo: 'OASYS-1D', color: 'Clear', size: '8.5 BC', power: '-3.00', availableStock: 40, retailPrice: 2700, wholesalePrice: 2200, gst: 18, unit: 'Box', barcode: '073390558102' },
];

export const INITIAL_DEMO_CUSTOMERS = [
  { id: 'c1', code: 'WCUST-101', name: 'Metro Optical Store (Indiranagar)', contactPerson: 'Rajesh Kumar', phone: '+91 98450 11223', email: 'metro.optics@gmail.com', gstin: '29ABCDE1234F1Z5', priceList: 'WHOLESALE', category: 'Wholesale', dealerDiscountPercent: 2, creditLimit: 200000, outstanding: 45000, openingBalance: 0, creditDays: 30, salesExec: 'Suresh V', billingAddress: '14, Indiranagar 100ft Road, Bengaluru', shippingAddress: '14, Indiranagar 100ft Road, Bengaluru', lastPurchaseDate: '2026-07-20', totalPurchases: '₹ 12,45,000' },
  { id: 'c2', code: 'WCUST-102', name: 'Vision Care Eye Clinic', contactPerson: 'Dr. Anita Sharma', phone: '+91 99160 44556', email: 'anita@visioncare.in', gstin: '29FGHIJ5678K1Z9', priceList: 'DEALER', category: 'Dealer', dealerDiscountPercent: 5, creditLimit: 150000, outstanding: 120000, openingBalance: 0, creditDays: 30, salesExec: 'Priya N', billingAddress: 'Vision Care Clinic, Jayanagar 4th Block, Bengaluru', shippingAddress: 'Vision Care Clinic, Jayanagar 4th Block, Bengaluru', lastPurchaseDate: '2026-07-25', totalPurchases: '₹ 8,90,000' },
  { id: 'c3', code: 'WCUST-103', name: 'Spectrum Spectacles Wholesale Hub', contactPerson: 'Karan Patel', phone: '+91 97310 99887', email: 'karan@spectrumwholesale.com', gstin: '29KLMNO9012P1Z3', priceList: 'DISTRIBUTOR', category: 'Distributor', dealerDiscountPercent: 7, creditLimit: 500000, outstanding: 0, openingBalance: 0, creditDays: 45, salesExec: 'Suresh V', billingAddress: 'Spectrum Hub, Commercial Street, Bengaluru', shippingAddress: 'Spectrum Hub, Commercial Street, Bengaluru', lastPurchaseDate: '2026-07-28', totalPurchases: '₹ 34,10,000' },
];

export const uid = (prefix = 'id') => `${prefix}_${Date.now()}_${Math.floor(Math.random() * 9000 + 1000)}`;

export const readLS = (key, fallback) => {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
};

export const writeLS = (key, value) => {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) {}
};

// Find a matching WholesalePriceList row (real backend rows fetched once and passed in) for
// this product + dealer: a dealer-specific row wins, otherwise a row for the dealer's category
// (brand/category/product-name match, qty at least min_quantity). Returns null if none matches.
export function findPriceListOverride(product, dealer, qty, priceListRows = []) {
  if (!dealer || !priceListRows.length) return null;
  const q = parseFloat(qty) || 1;
  const matches = (row) => {
    if (row.dealer && row.dealer !== dealer.id) return false;
    if (!row.dealer && row.dealer_category && row.dealer_category !== dealer.category) return false;
    const name = (product.name || '').toLowerCase();
    const brand = (product.brand || '').toLowerCase();
    const category = (product.category || '').toLowerCase();
    const targetsProduct = row.product_name && name.includes(String(row.product_name).toLowerCase());
    const targetsBrand = row.brand && brand === String(row.brand).toLowerCase();
    const targetsCategory = row.category && category === String(row.category).toLowerCase();
    if (!targetsProduct && !targetsBrand && !targetsCategory) return false;
    return q >= (parseInt(row.min_quantity) || 1);
  };
  const dealerSpecific = priceListRows.find(r => r.dealer === dealer.id && matches(r));
  const categoryWide = priceListRows.find(r => !r.dealer && matches(r));
  const row = dealerSpecific || categoryWide;
  if (!row) return null;
  const base = parseFloat(row.wholesale_price) || 0;
  const discPct = parseFloat(row.discount_percentage) || 0;
  return { rate: Math.round(base * (1 - discPct / 100) * 100) / 100, sourceRow: row };
}

// Resolve the correct list price for a product given a dealer's assigned price list.
// A real WholesalePriceList override (see findPriceListOverride) always wins; otherwise
// DEALER/DISTRIBUTOR/VIP_DEALER apply an increasing discount off wholesale, SPECIAL is a
// per-dealer negotiated rate, CUSTOM leaves the field open for manual entry at add-time.
export function resolvePriceForDealer(product, dealer, specialPriceMap = {}, qty = 1, priceListRows = []) {
  const retail = parseFloat(product.retailPrice ?? product.price ?? 0) || 0;
  const wholesale = parseFloat(product.wholesalePrice ?? product.price ?? retail) || 0;

  const override = findPriceListOverride(product, dealer, qty, priceListRows);
  if (override) return { rate: override.rate, tier: 'SPECIAL', retail, wholesale, dealerPrice: override.rate, special: override.rate };

  const TIER_DISCOUNT = { DEALER: 5, DISTRIBUTOR: 10, VIP_DEALER: 15 };
  const dealerDiscPct = TIER_DISCOUNT[dealer?.priceList] ?? (parseFloat(dealer?.dealerDiscountPercent) || 0);
  const dealerPrice = Math.round((wholesale * (1 - dealerDiscPct / 100)) * 100) / 100;
  const key = `${dealer?.id || 'none'}_${product.id || product.code}`;
  const special = specialPriceMap[key];

  const list = dealer?.priceList || 'WHOLESALE';
  let rate = wholesale;
  let tier = 'WHOLESALE';
  if (list === 'RETAIL') { rate = retail; tier = 'RETAIL'; }
  else if (list === 'DEALER' || list === 'DISTRIBUTOR' || list === 'VIP_DEALER') { rate = dealerPrice; tier = list; }
  else if (list === 'SPECIAL') { rate = special != null ? parseFloat(special) : dealerPrice; tier = special != null ? 'SPECIAL' : 'DEALER'; }
  else if (list === 'CUSTOM') { rate = wholesale; tier = 'CUSTOM'; }
  else { rate = wholesale; tier = 'WHOLESALE'; }

  return { rate, tier, retail, wholesale, dealerPrice, special: special != null ? parseFloat(special) : null };
}

export function computeLineTotals(item) {
  const qty = parseFloat(item.qty) || 0;
  const rate = parseFloat(item.rate) || 0;
  const discPct = parseFloat(item.discount) || 0;
  const discAmt = parseFloat(item.discountAmount) || 0;
  const base = rate * qty; // free quantity never adds to the billed amount
  const lineDiscount = item.discountMode === 'FIXED' ? Math.min(discAmt, base) : base * (discPct / 100);
  const gross = Math.max(0, base - lineDiscount);
  const gst = gross * ((parseFloat(item.gst) || 0) / 100);
  const total = gross + gst;
  const stockUnits = qty + (parseFloat(item.freeQty) || 0); // free qty still leaves the warehouse
  return { base, lineDiscount, gross, gst, total, stockUnits };
}

// Builds a running ledger (Invoice = debit, Payment/Credit-Note/Return = credit) for one
// dealer from the invoices/returns already stored locally — no separate ledger table is
// kept, it's always derived so it can never drift from the real records. Opening Balance
// (from the backend Dealer record, when present) seeds the running total.
export function buildDealerLedger(dealer, invoices, returns = [], payments = []) {
  if (!dealer) return [];
  const isDealer = (d) => d?.id === dealer.id || d?.code === dealer.code;
  const invoiceRows = invoices.filter(inv => isDealer(inv.customer)).map(inv => ({
    date: inv.date, ref: inv.invoiceNo, type: 'Invoice',
    debit: parseFloat(inv.summary?.grandTotal || 0), credit: parseFloat(inv.amountReceived || 0),
    status: inv.status, orderStatus: inv.orderStatus || 'Confirmed',
  }));
  const returnRows = returns.filter(r => isDealer(r.customer)).map(r => ({
    date: r.date, ref: r.returnNo || r.noteNo, type: r.noteNo ? 'Credit Note' : 'Return',
    debit: 0, credit: parseFloat(r.amount || 0), status: '', orderStatus: '',
  }));
  const paymentRows = payments.filter(p => isDealer(p.customer)).map(p => ({
    date: p.date, ref: p.receiptNo, type: 'Payment',
    debit: 0, credit: parseFloat(p.amount || 0), status: '', orderStatus: '',
  }));
  const rows = [...invoiceRows, ...returnRows, ...paymentRows];
  rows.sort((a, b) => new Date(a.date) - new Date(b.date));
  let running = parseFloat(dealer.openingBalance) || 0;
  const opening = running;
  const withBalance = rows.map(r => {
    running += (r.debit - r.credit);
    return { ...r, balance: running };
  });
  return [{ date: '', ref: '', type: 'Opening Balance', debit: 0, credit: 0, balance: opening, isOpening: true }, ...withBalance];
}

export function fmtINR(n) {
  return `₹${(parseFloat(n) || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}
