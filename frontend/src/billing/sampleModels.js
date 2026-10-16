// Visual designer sample documents (design mode only — never saved into a template).
// Shaped like a real BillModel for each document family and flagged `isSample` so the canvas
// can label the preview as sample data. The figures are illustrative and internally
// consistent; the renderer never relies on them for any real document.

const SAMPLE_LINES = [
  { name: 'Ray-Ban RB5154 Clubmaster Frame', brand: 'Ray-Ban', sku: 'RB5154-2000', hsn: '9003', size: '51', color: 'Black Gold', rate: 8490, taxPercent: 12, power: '' },
  { name: 'Single Vision 1.56 Blue-Cut Lens (pair)', brand: 'Essilor', sku: 'ESS-SV156-BC', hsn: '9001', size: '', color: '', rate: 2400, taxPercent: 12, power: 'RE: SPH -1.25 CYL -0.50 | LE: SPH -1.00 CYL 0' },
  { name: 'Lens Cleaning Kit', brand: 'Greensol', sku: 'ACC-CLK-01', hsn: '3307', size: '', color: '', rate: 250, taxPercent: 18, power: '' },
  { name: 'Contact Lens Solution 360 ml', brand: 'Bausch + Lomb', sku: 'BL-RENU-360', hsn: '3307', size: '360ml', color: '', rate: 540, taxPercent: 18, power: '' },
  { name: 'Titanium Rimless Frame', brand: 'Lindberg', sku: 'LB-TR-2210', hsn: '9003', size: '52', color: 'Gunmetal', rate: 15800, taxPercent: 12, power: '' },
  { name: 'Progressive 1.67 Lens (pair)', brand: 'Zeiss', sku: 'ZS-PRG-167', hsn: '9001', size: '', color: '', rate: 9800, taxPercent: 12, power: 'RE: SPH +1.50 ADD +2.00 | LE: SPH +1.25 ADD +2.00' },
];
const LONG_NAME = 'Premium handcrafted acetate full-rim optical frame with spring hinges, anti-slip nose pads, matching protective hard case, microfibre cloth and two-year manufacturer warranty';

const round2 = (n) => Math.round(n * 100) / 100;

export const SAMPLE_COUNTS = [3, 12, 40];

const TITLES = {
  SALES_INVOICE: 'TAX INVOICE',
  WHOLESALE_BILL: 'WHOLESALE TAX INVOICE',
  ORDER_BILL: 'ORDER / JOB SLIP',
  PURCHASE_BILL: 'PURCHASE ENTRY / GOODS RECEIPT',
  SALES_RETURN: 'SALES RETURN / CREDIT NOTE',
  PURCHASE_RETURN: 'PURCHASE RETURN / DEBIT NOTE',
  QUOTATION: 'QUOTATION / ESTIMATE',
  PAYMENT_RECEIPT: 'PAYMENT RECEIPT',
};
const NUMBERS = {
  PURCHASE_BILL: 'PE-2026-0418',
  PAYMENT_RECEIPT: 'RCPT-000231',
  SALES_RETURN: 'SR-000045',
  PURCHASE_RETURN: 'RTV-000012',
  QUOTATION: 'QT-000318',
  ORDER_BILL: 'ORD-002741',
};

function sampleItems(itemCount, purchase, longNames) {
  return Array.from({ length: itemCount }, (_, i) => {
    const src = SAMPLE_LINES[i % SAMPLE_LINES.length];
    const qty = (i % 3) + 1;
    const rate = purchase ? round2(src.rate * 0.55) : src.rate;
    const discount = i % 4 === 1 ? round2(rate * qty * 0.05) : 0;
    const taxable = rate * qty - discount;
    const taxAmount = round2((taxable * src.taxPercent) / 100);
    return {
      name: longNames && i % 2 === 0 ? `${src.name} — ${LONG_NAME}` : src.name,
      description: '',
      brand: src.brand,
      sku: src.sku,
      barcode: `890123450${String(1000 + i).slice(-4)}`,
      hsn: src.hsn,
      variant: [src.size, src.color].filter(Boolean).join(' / '),
      size: src.size,
      color: src.color,
      power: purchase ? '' : src.power,
      batch: purchase ? `B${24100 + i}` : '',
      expiry: purchase ? '2028-03-31' : '',
      qty,
      freeQty: purchase ? (i % 5 === 0 ? 1 : 0) : null,
      unit: 'pcs',
      mrp: purchase ? src.rate : null,
      rate,
      discount,
      discountPercent: discount ? 5 : null,
      taxPercent: src.taxPercent,
      taxAmount,
      total: round2(taxable + taxAmount),
      itemType: 'PRODUCT',
    };
  });
}

function sampleParty(type, purchase, receipt, longNames) {
  if (purchase) {
    return {
      role: 'supplier', label: 'Supplier',
      name: longNames ? 'Vision Optics & Ophthalmic Instruments Distributors (South India) Private Limited' : 'Vision Optics Distributors Pvt Ltd',
      code: 'SUP-0042', phone: '+91 98450 22110', email: 'accounts@visionoptics.example',
      address: '14, Industrial Estate, Peenya\nBengaluru, Karnataka 560058', gstin: '29AABCV1234K1Z2', shippingAddress: '',
    };
  }
  let label = 'Bill To';
  if (receipt) label = 'Received From';
  else if (type === 'QUOTATION') label = 'Prepared For';
  const wholesale = type === 'WHOLESALE_BILL';
  return {
    role: 'customer', label,
    name: longNames ? 'Anitha Krishnamoorthy Venkataraman Subramaniam' : 'Anitha Krishnan',
    code: 'P-10234', phone: '+91 90000 11111', email: 'anitha@example.com',
    address: '12 Beach View Apartments, Marine Drive\nKochi, Kerala 682001',
    gstin: wholesale ? '32AAFCA9876B1Z3' : '',
    shippingAddress: wholesale ? 'Godown 3, Kalamassery Industrial Area\nKochi 683104' : '',
  };
}

/** A sample BillModel for `documentType`. `company` should be the real store identity
 *  (resolveCompany) so the designer shows the shop's own header. */
export function sampleBillModel(documentType = 'SALES_INVOICE', { company = {}, itemCount = 3, longNames = false } = {}) {
  const type = documentType === 'RETURN_BILL' ? 'SALES_RETURN' : documentType;
  const purchase = type === 'PURCHASE_BILL' || type === 'PURCHASE_RETURN';
  const receipt = type === 'PAYMENT_RECEIPT';
  const isReturn = type === 'SALES_RETURN' || type === 'PURCHASE_RETURN';
  const quotation = type === 'QUOTATION';
  const items = receipt ? [] : sampleItems(itemCount, purchase, longNames);

  const subtotal = round2(items.reduce((s, it) => s + it.rate * it.qty, 0));
  const discount = round2(items.reduce((s, it) => s + (it.discount || 0), 0));
  const tax = round2(items.reduce((s, it) => s + it.taxAmount, 0));
  const exact = subtotal - discount + tax;
  const grandTotal = receipt ? 12500 : Math.round(exact);
  const roundOff = receipt ? null : round2(grandTotal - exact);
  let paid = Math.round(grandTotal * 0.6);
  if (receipt) paid = 12500;
  if (quotation) paid = null;
  const balance = receipt || paid === null ? null : round2(grandTotal - paid);
  const half = paid ? Math.round(paid / 2) : 0;
  const party = sampleParty(type, purchase, receipt, longNames);

  let paymentStatus = 'PARTIALLY PAID';
  if (receipt) paymentStatus = 'RECEIVED';
  if (quotation) paymentStatus = '';

  return {
    isSample: true,
    company: {
      name: 'Your Store Name', tagline: '', address: 'Store address (Settings → Store Profile)', phone: '', email: '',
      website: '', gstin: '', pan: '', logoDataUrl: '', currency: '₹', bankDetails: '', upiId: '',
      ...company,
    },
    document: {
      type,
      title: TITLES[type] || 'INVOICE',
      number: NUMBERS[type] || 'INV-002741',
      orderNumber: receipt ? '' : 'ORD-002741',
      reference: purchase ? 'VOD/26-27/1182' : '',
      date: '2026-10-16',
      dueDate: quotation ? '2026-10-31' : '2026-10-30',
      deliveryDate: '2026-10-20',
      status: purchase ? 'CONFIRMED' : '',
      paymentStatus,
      fulfillmentStatus: 'In Lab Processing',
      salesperson: 'Dr. Priya R',
      branch: 'Main Branch',
      preparedBy: 'admin',
      printedAt: '2026-10-16T10:30:00',
      notes: 'Sample note — the real document’s notes print here.',
      terms: '',
    },
    party,
    customer: party,
    items,
    totals: {
      subtotal: receipt ? null : subtotal,
      discount: receipt ? null : discount,
      additionalDiscount: null,
      taxableAmount: null,
      tax: receipt ? null : tax,
      cgst: purchase ? round2(tax / 2) : null,
      sgst: purchase ? round2(tax / 2) : null,
      igst: null,
      cess: null,
      shipping: null,
      otherCharges: null,
      roundOff,
      grandTotal,
      paid,
      balance,
      refund: isReturn ? grandTotal : null,
    },
    payment: {
      method: receipt ? 'UPI' : 'Cash + UPI',
      reference: receipt ? 'UPI Ref 6281 9922 1034' : '',
      splits: receipt || !paid ? [] : [{ mode: 'Cash', amount: half }, { mode: 'UPI', amount: paid - half }],
      paid,
      balance,
      status: paymentStatus,
      bankDetails: company.bankDetails || '',
      upiId: company.upiId || '',
    },
    receipt: { amount: receipt ? 12500 : null, invoiceNumber: receipt ? 'INV-002741' : '' },
    return: isReturn
      ? { reason: 'Customer did not like the frame colour', originalInvoice: 'INV-002611', action: 'Credit Note Issued' }
      : { reason: '', originalInvoice: '', action: '' },
    footer: {},
  };
}
