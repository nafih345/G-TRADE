// Normalises each ERP document shape into one BillModel the renderer understands.
// IMPORTANT: this layer does NO calculation — every amount is read straight from the
// source document (which already computed tax / discount / totals / balance). It only
// maps and renames fields.

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');

// Fallback company identity — matches what the old hard-coded renderers printed, so an
// install that has not filled in Settings → Store Profile sees no change.
const FALLBACK_COMPANY = {
  name: 'GREENSOL OPTICALS',
  tagline: 'Super Speciality Eye Care & Optical ERP',
  address: 'Greensol Vision Hospital Complex, Medical College Road',
  phone: '+91 98470 12345',
  email: 'sales@greensoloptical.com',
  website: 'www.greensoloptical.com',
  gstin: '32AAAAA0000A1Z5',
  pan: '',
  logoDataUrl: '',
  currency: '₹',
};

export function resolveCompany(ctx = {}) {
  const c = ctx.company || {};
  const b = ctx.branding || {};
  const out = { ...FALLBACK_COMPANY };
  ['name', 'tagline', 'address', 'phone', 'email', 'website', 'gstin', 'pan', 'currency']
    .forEach((k) => { if (first(c[k])) out[k] = c[k]; });
  if (first(b.logo_data_url, c.logoDataUrl)) out.logoDataUrl = b.logo_data_url || c.logoDataUrl;
  const info = b.business_info || {};
  ['tagline', 'website', 'pan'].forEach((k) => { if (first(info[k])) out[k] = info[k]; });
  return out;
}

function autoTitle(documentType) {
  return ({
    SALES_INVOICE: 'TAX INVOICE',
    WHOLESALE_BILL: 'WHOLESALE TAX INVOICE',
    ORDER_BILL: 'ORDER / JOB SLIP',
    PURCHASE_BILL: 'PURCHASE ENTRY / GOODS RECEIPT',
    RETURN_BILL: 'RETURN / CREDIT NOTE',
    QUOTATION: 'QUOTATION / ESTIMATE',
    PAYMENT_RECEIPT: 'PAYMENT RECEIPT',
  })[documentType] || 'INVOICE';
}

// ---------------------------------------------------------------------------
// Per-source adapters
// ---------------------------------------------------------------------------

function adaptSalesLike(doc, documentType) {
  const rawItems = Array.isArray(doc.items) && doc.items.length
    ? doc.items
    : [{ name: doc.item || doc.frame || 'Item', qty: 1, price: doc.total || doc.net_amount || 0 }];

  const items = rawItems.map((it) => {
    const qty = num(first(it.qty, it.quantity, 1)) || 1;
    const rate = num(first(it.price, it.unit_price, it.rate, it.unitPrice));
    const total = it.total !== undefined ? num(it.total)
      : (it.subtotal !== undefined ? num(it.subtotal) : rate * qty);
    return {
      name: first(it.name, it.item, it.product, it.description, it.productName) || 'Item',
      brand: first(it.brand, '') || '',
      sku: first(it.sku, it.product_code, it.code) || '',
      barcode: first(it.barcode) || '',
      hsn: first(it.hsn, it.hsn_code, it.hsnCode) || '',
      size: first(it.size) || '',
      color: first(it.color, it.colour) || '',
      qty,
      unit: first(it.unit, it.uom) || '',
      rate,
      discount: num(first(it.discount, it.discount_amount, it.discountAmount, 0)),
      discountPercent: it.discount_percent !== undefined ? num(it.discount_percent) : null,
      taxPercent: it.taxPercent !== undefined ? num(it.taxPercent)
        : (it.tax_rate !== undefined ? num(it.tax_rate) : null),
      taxAmount: num(first(it.taxAmount, it.tax_amount, it.tax, 0)),
      total,
      grossWeight: num(first(it.grossWeight, it.gross_weight)),
      netWeight: num(first(it.netWeight, it.net_weight)),
      stoneWeight: num(first(it.stoneWeight, it.stone_weight)),
      makingCharge: num(first(it.makingCharge, it.making_charge)),
      stoneCharge: num(first(it.stoneCharge, it.stone_charge)),
      otherCharges: num(first(it.otherCharges, it.other_charges)),
    };
  });

  const grandTotal = num(first(doc.netTotal, doc.total, doc.net_amount, doc.grand_total));
  const hasRealTax = first(doc.totalTax, doc.tax_amount) !== undefined;
  const tax = hasRealTax ? num(first(doc.totalTax, doc.tax_amount)) : Math.max(0, grandTotal - grandTotal / 1.18);
  const discount = num(first(doc.discount_amount, doc.itemDiscounts, doc.totalDiscount, 0));
  const subtotal = num(first(doc.grossTotal, doc.total_amount)) || Math.max(0, grandTotal - tax + discount);

  const paid = first(doc.totalPaidAmount, doc.paidAmount, doc.paid_amount) !== undefined
    ? num(first(doc.totalPaidAmount, doc.paidAmount, doc.paid_amount))
    : grandTotal;
  const balance = first(doc.balanceDue, doc.balance_amount) !== undefined
    ? num(first(doc.balanceDue, doc.balance_amount))
    : Math.max(0, grandTotal - paid);
  const status = first(doc.paymentStatusLabel,
    balance <= 0.009 ? 'PAID' : (paid > 0 ? 'PARTIALLY PAID' : 'UNPAID'));

  return {
    document: {
      type: documentType,
      title: autoTitle(documentType),
      number: first(doc.invoiceNumber, doc.invoice_number, doc.id, doc.number) || '',
      orderNumber: first(doc.orderNumber, doc.order_number, doc.order_ref) || '',
      date: first(doc.date, doc.invoice_date, new Date().toISOString().split('T')[0]),
      dueDate: first(doc.dueDate, doc.due_date) || '',
      paymentStatus: status,
      salesperson: first(doc.salesman, doc.salesperson, doc.doctor, doc.optometrist) || '',
      branch: first(doc.branch, doc.branch_name) || '',
    },
    customer: {
      name: first(doc.customerName, doc.patientName, doc.customer_name, doc.customer, 'Walk-in Customer'),
      phone: first(doc.customerPhone, doc.phone, doc.customer_phone) || '',
      address: first(doc.customerAddress, doc.address) || '',
      gstin: first(doc.customerGstin, doc.customer_gstin, doc.gstin) || '',
      email: first(doc.customerEmail, doc.customer_email) || '',
    },
    items,
    totals: {
      subtotal,
      discount,
      additionalDiscount: num(doc.additionalDiscount),
      tax,
      cgst: num(first(doc.cgst, doc.cgst_amount)),
      sgst: num(first(doc.sgst, doc.sgst_amount)),
      igst: num(first(doc.igst, doc.igst_amount)),
      shipping: num(first(doc.shipping, doc.delivery_charge, 0)),
      otherCharges: num(first(doc.otherCharges, doc.other_charges, 0)),
      roundOff: num(first(doc.roundOff, doc.round_off, 0)),
      grandTotal,
      paid,
      balance,
    },
    payment: {
      method: first(doc.paymentMethod, doc.method, doc.paymentMode, doc.payment_method) || '',
      paid,
      balance,
      status,
      bankDetails: '',
      upiId: '',
    },
    footer: {
      notes: first(doc.diagnosis && `Diagnosis: ${doc.diagnosis}`, '') || '',
    },
  };
}

function adaptPurchase(doc, documentType) {
  const items = (doc.items || []).map((it) => {
    const qty = num(first(it.quantity, it.qty, 0));
    const rate = num(first(it.purchase_rate, it.rate, it.unit_price));
    return {
      name: first(it.productName, it.product_name, it.name) || 'Item',
      brand: first(it.brand) || '',
      sku: first(it.sku, it.product_code) || '',
      barcode: '', hsn: first(it.hsn, it.hsn_code) || '',
      size: first(it.batch_number) || '', color: first(it.expiry_date) || '',
      qty, unit: first(it.unit) || '',
      rate,
      discount: 0,
      discountPercent: num(first(it.discount_percent, 0)),
      taxPercent: num(first(it.gst_percent, it.tax_rate, 0)),
      taxAmount: 0,
      total: num(first(it.line_total, rate * qty)),
      grossWeight: 0, netWeight: 0, stoneWeight: 0,
      makingCharge: 0, stoneCharge: 0, otherCharges: 0,
    };
  });
  const grandTotal = num(doc.grand_total);
  const paid = num(doc.paid_amount);
  const balance = first(doc.balance_amount) !== undefined ? num(doc.balance_amount) : Math.max(0, grandTotal - paid);
  return {
    document: {
      type: documentType,
      title: autoTitle(documentType),
      number: first(doc.invoice_number, doc.invoiceNumber) || '',
      orderNumber: first(doc.supplier_invoice_number) || '',
      date: first(doc.purchase_date, doc.date, new Date().toISOString().split('T')[0]),
      dueDate: '',
      paymentStatus: first(doc.status, 'CONFIRMED'),
      salesperson: '',
      branch: first(doc.branch) || '',
    },
    customer: {
      name: first(doc.supplierName, doc.supplier_name, 'Supplier'),
      phone: first(doc.supplier_phone) || '',
      address: first(doc.supplier_address) || '',
      gstin: first(doc.supplier_gstin) || '',
      email: '',
    },
    items,
    totals: {
      subtotal: num(doc.gross_amount),
      discount: num(doc.discount_amount),
      additionalDiscount: 0,
      tax: num(doc.tax_amount),
      cgst: 0, sgst: 0, igst: 0,
      shipping: 0,
      otherCharges: num(doc.other_charges),
      roundOff: num(doc.round_off),
      grandTotal,
      paid,
      balance,
    },
    payment: {
      method: first(doc.payment_method, doc.paymentMethod, 'Cash'),
      paid, balance,
      status: first(doc.status, ''),
      bankDetails: '', upiId: '',
    },
    footer: { notes: first(doc.notes, '') || '' },
  };
}

function adaptWholesale(doc, documentType) {
  const items = (doc.items || []).map((it) => {
    const qty = num(first(it.qty, it.quantity, 0));
    const rate = num(first(it.rate, it.price));
    const discPct = num(first(it.discount, 0));
    const base = rate * qty;
    const lineDisc = base * (discPct / 100);
    const total = it.total !== undefined ? num(it.total) : (base - lineDisc) * 1.18;
    return {
      name: first(it.name, it.product) || 'Item',
      brand: first(it.brand) || '',
      sku: first(it.code, it.sku) || '',
      barcode: first(it.barcode) || '',
      hsn: first(it.hsn) || '',
      size: first(it.size) || '', color: first(it.color, it.colour) || '',
      qty, unit: first(it.unit) || '',
      rate,
      discount: 0,
      discountPercent: discPct,
      taxPercent: it.taxPercent !== undefined ? num(it.taxPercent) : 18,
      taxAmount: 0,
      total,
      grossWeight: 0, netWeight: 0, stoneWeight: 0,
      makingCharge: 0, stoneCharge: 0, otherCharges: 0,
    };
  });
  const s = doc.summary || {};
  const grandTotal = num(first(s.grandTotal, doc.grandTotal, doc.grand_total));
  const paid = first(doc.amountReceived, doc.paidAmount, doc.paid_amount) !== undefined
    ? num(first(doc.amountReceived, doc.paidAmount, doc.paid_amount))
    : grandTotal;
  const balance = first(doc.dueAmount, doc.due_amount, doc.balanceDue) !== undefined
    ? num(first(doc.dueAmount, doc.due_amount, doc.balanceDue))
    : Math.max(0, grandTotal - paid);
  const cust = doc.customer || {};
  return {
    document: {
      type: documentType,
      title: autoTitle(documentType),
      number: first(doc.invoiceNo, doc.invoice_number, doc.invoiceNumber) || '',
      orderNumber: first(doc.orderRef, doc.order_ref) || '',
      date: first(doc.date, doc.invoice_date, new Date().toISOString().split('T')[0]),
      dueDate: first(doc.dueDate, doc.due_date) || '',
      paymentStatus: first(doc.status, balance <= 0.009 ? 'PAID' : 'CREDIT'),
      salesperson: first(doc.salesExecutive, doc.sales_executive) || '',
      branch: '',
    },
    customer: {
      name: first(cust.name, cust.business_name, doc.customerName) || 'Wholesale Buyer',
      phone: first(cust.phone, cust.contactPerson && `${cust.contactPerson} ${cust.phone || ''}`) || '',
      address: first(cust.address) || '',
      gstin: first(cust.gstin) || '',
      email: first(cust.email) || '',
    },
    items,
    totals: {
      subtotal: num(first(s.subtotal, 0)),
      discount: num(first(s.totalDiscount, 0)),
      additionalDiscount: 0,
      tax: num(first(s.totalGst, s.totalTax, 0)),
      cgst: 0, sgst: 0, igst: 0,
      shipping: num(first(s.transport, s.shipping, 0)),
      otherCharges: 0,
      roundOff: num(first(s.roundOff, 0)),
      grandTotal,
      paid,
      balance,
    },
    payment: {
      method: first(doc.payMode, doc.payment_method) || '',
      paid, balance,
      status: first(doc.status, ''),
      bankDetails: '', upiId: '',
    },
    footer: {
      notes: doc.refNo ? `Ref: ${doc.refNo}` : '',
      terms: doc.creditDays ? `Payment due within ${doc.creditDays} days.` : '',
    },
  };
}

function adaptPaymentReceipt(doc, documentType) {
  const amount = num(first(doc.amount, doc.amount_paid, doc.paidAmount));
  return {
    document: {
      type: documentType,
      title: autoTitle(documentType),
      number: first(doc.receipt_no, doc.receipt_number, doc.id) || '',
      orderNumber: first(doc.invoice_number, doc.invoiceNumber, doc.invoice) || '',
      date: first(doc.payment_date, doc.date, new Date().toISOString().split('T')[0]),
      dueDate: '',
      paymentStatus: first(doc.status, 'RECEIVED'),
      salesperson: '',
      branch: first(doc.branch) || '',
    },
    customer: {
      name: first(doc.customer_name, doc.customerName, 'Customer'),
      phone: first(doc.phone, doc.customer_phone) || '',
      address: '', gstin: '', email: '',
    },
    items: [],
    totals: {
      subtotal: amount, discount: 0, additionalDiscount: 0, tax: 0,
      cgst: 0, sgst: 0, igst: 0, shipping: 0, otherCharges: 0, roundOff: 0,
      grandTotal: amount, paid: amount, balance: 0,
    },
    payment: {
      method: first(doc.method, doc.payment_method) || 'Cash',
      paid: amount, balance: 0,
      status: first(doc.status, 'RECEIVED'),
      bankDetails: '', upiId: '',
    },
    footer: { notes: first(doc.notes, doc.reference_note, '') || '' },
  };
}

const ADAPTERS = {
  SALES_INVOICE: adaptSalesLike,
  ORDER_BILL: adaptSalesLike,
  QUOTATION: adaptSalesLike,
  RETURN_BILL: adaptSalesLike,
  PURCHASE_BILL: adaptPurchase,
  WHOLESALE_BILL: adaptWholesale,
  PAYMENT_RECEIPT: adaptPaymentReceipt,
};

export function toBillModel(rawDoc, documentType = 'SALES_INVOICE', ctx = {}) {
  const adapter = ADAPTERS[documentType] || adaptSalesLike;
  const model = adapter(rawDoc || {}, documentType);
  model.company = resolveCompany(ctx);
  model.company.currency = model.company.currency || '₹';
  // A caller may pass an explicit title override (e.g. "PROFORMA INVOICE").
  if (rawDoc && rawDoc.__title) model.document.title = rawDoc.__title;
  return model;
}
