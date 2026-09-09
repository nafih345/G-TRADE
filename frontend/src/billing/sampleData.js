// Realistic sample bill used by the designer's live preview (spec section 14).
export const SAMPLE_BILL = {
  company: {
    name: 'ABC Jewellery',
    tagline: 'Fine Gold & Diamond Jewellery',
    address: '48 Market Road, T. Nagar, Chennai - 600017',
    phone: '+91 98765 43210',
    email: 'care@abcjewellery.com',
    website: 'www.abcjewellery.com',
    gstin: '33ABCDE1234F1Z5',
    pan: 'ABCDE1234F',
    logoDataUrl: '',
    currency: '₹',
  },
  document: {
    type: 'SALES_INVOICE',
    title: 'TAX INVOICE',
    number: 'INV-1001',
    orderNumber: 'ORD-5521',
    date: '2026-09-09',
    dueDate: '2026-09-24',
    paymentStatus: 'PARTIALLY PAID',
    salesperson: 'Priya R',
    branch: 'Main Branch',
  },
  customer: {
    name: 'Muhammed',
    phone: '+91 90000 11111',
    address: '12 Beach View Apartments, Marine Drive, Kochi - 682001',
    gstin: '32MUHAM4321K1Z9',
    email: 'muhammed@example.com',
  },
  items: [
    {
      name: 'Gold Ring 22K', brand: 'ABC', sku: 'GR-22-014', barcode: '8901234500014',
      hsn: '7113', size: '16', color: 'Yellow Gold', qty: 1, unit: 'pc',
      rate: 5850, discount: 200, taxPercent: 3, taxAmount: 168.9, total: 5798.9,
      grossWeight: 4.2, netWeight: 3.9, stoneWeight: 0.3, makingCharge: 620,
      stoneCharge: 0, otherCharges: 0,
    },
    {
      name: 'Gold Chain 22K', brand: 'ABC', sku: 'GC-22-207', barcode: '8901234502070',
      hsn: '7113', size: '18 inch', color: 'Yellow Gold', qty: 1, unit: 'pc',
      rate: 42800, discount: 0, taxPercent: 3, taxAmount: 1284, total: 44084,
      grossWeight: 18.6, netWeight: 18.6, stoneWeight: 0, makingCharge: 3100,
      stoneCharge: 0, otherCharges: 0,
    },
    {
      name: 'Diamond Earrings', brand: 'ABC', sku: 'DE-18-092', barcode: '8901234500922',
      hsn: '7113', size: '-', color: 'White Gold', qty: 1, unit: 'pr',
      rate: 61500, discount: 1500, taxPercent: 3, taxAmount: 1800, total: 61800,
      grossWeight: 6.1, netWeight: 4.4, stoneWeight: 1.7, makingCharge: 5200,
      stoneCharge: 8900, otherCharges: 250,
    },
  ],
  totals: {
    subtotal: 108450,
    discount: 1700,
    additionalDiscount: 0,
    tax: 3252.9,
    cgst: 1626.45,
    sgst: 1626.45,
    igst: 0,
    shipping: 0,
    otherCharges: 250,
    roundOff: -0.35,
    grandTotal: 111682.9,
    paid: 60000,
    balance: 51682.9,
  },
  payment: {
    method: 'Cash + UPI',
    paid: 60000,
    balance: 51682.9,
    status: 'PARTIALLY PAID',
    bankDetails: 'ABC Jewellery • HDFC Bank • A/C 501000123456 • IFSC HDFC0000123',
    upiId: 'abcjewellery@hdfcbank',
  },
  footer: {},
};

export function sampleForTemplate(template) {
  // Thermal presets look best with a shorter cart in the thumbnail/preview.
  const isThermal = ['58mm', '80mm'].includes(template?.paper_size);
  if (!isThermal) return SAMPLE_BILL;
  return { ...SAMPLE_BILL, items: SAMPLE_BILL.items.slice(0, 2) };
}
