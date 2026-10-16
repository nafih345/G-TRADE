// Normalises each ERP document shape into one BillModel the renderers understand.
//
// IMPORTANT: this layer does NO financial calculation — every amount is read straight from the
// source document (which already computed tax / discount / totals / balance). An amount the
// document does not carry becomes null and prints as blank / is left off, never a guessed
// value. The one narrow exception is a line with a rate and quantity but no line total and no
// discount or tax of its own (the eye-test charge lines): its amount is rate × qty, which is
// exactly how such a line is defined.
//
// BillModel:
//   company  {name, tagline, address, phone, email, website, gstin, pan, logoDataUrl, currency,
//             bankDetails, upiId}
//   document {type, title, number, orderNumber, reference, date, dueDate, deliveryDate, status,
//             paymentStatus, fulfillmentStatus, salesperson, branch, preparedBy, printedAt,
//             notes, terms}
//   party    {role, label, name, code, phone, email, address, gstin, shippingAddress}
//   customer (= party; kept for the legacy renderer)
//   items    [{name, description, brand, sku, barcode, hsn, variant, size, color, power, batch,
//              expiry, qty, freeQty, unit, mrp, rate, discount, discountPercent, taxPercent,
//              taxAmount, total, itemType}]
//   totals   {subtotal, discount, additionalDiscount, taxableAmount, tax, cgst, sgst, igst, cess,
//             shipping, otherCharges, roundOff, grandTotal, paid, balance, refund}  (number|null)
//   payment  {method, reference, splits:[{mode, amount}], paid, balance, status, bankDetails, upiId}
//   receipt  {amount, invoiceNumber}
//   return   {reason, originalInvoice, action}
//   footer   {notes, terms}  (legacy renderer)
import { canonicalDocType } from './billFields.js';

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};
// Number when the document actually carries one, else null.
const numOrNull = (...vals) => {
  for (const v of vals) {
    if (v === undefined || v === null || v === '') continue;
    const n = typeof v === 'number' ? v : parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
};
const first = (...vals) => vals.find((v) => v !== undefined && v !== null && v !== '');
const str = (...vals) => {
  const v = first(...vals);
  return v === undefined ? '' : String(v);
};

// A line's prescription text, as printed under the item description.
// Older bills stored a placeholder ("—", "Power Active [Idx: 1.56]") on every line and
// zero-filled the eye that had no prescription ("OD:0/0 | OS:-1.25/-0.50"). Both are scrubbed
// here so a reprint of an old document shows power only where power was really entered.
const LEGACY_BOTH_EYES = /^OD:([^/|]*)\/([^|]*)\|\s*OS:([^/]*)\/(.*)$/i;

function cleanPower(value) {
  const s = String(value ?? '').trim();
  if (!s || /^[-–—]+$/.test(s) || /^n\/?a$/i.test(s) || /^power active/i.test(s)) return '';
  const m = s.match(LEGACY_BOTH_EYES);
  if (!m) return s;
  // Trailing "[Idx: 1.56]" rides on the left eye's last field — keep it on the rebuilt string.
  const tail = m[4].match(/\[[^\]]*\]\s*$/);
  const suffix = tail ? ` ${tail[0].trim()}` : '';
  const eye = (sph, cyl) => {
    const s1 = String(sph).trim();
    const c1 = String(cyl).replace(/\[[^\]]*\]\s*$/, '').trim();
    const blank = (v) => !v || num(v) === 0;
    if (blank(s1) && blank(c1)) return '';
    return `SPH ${s1 || '0'} CYL ${c1 || '0'}`;
  };
  const eyes = [];
  const re = eye(m[1], m[2]);
  const le = eye(m[3], m[4]);
  if (re) eyes.push(`RE: ${re}`);
  if (le) eyes.push(`LE: ${le}`);
  return eyes.length ? `${eyes.join(' | ')}${suffix}` : '';
}

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
  bankDetails: '',
  upiId: '',
};

export function resolveCompany(ctx = {}) {
  const c = ctx.company || {};
  const b = ctx.branding || {};
  const out = { ...FALLBACK_COMPANY };
  ['name', 'tagline', 'address', 'phone', 'email', 'website', 'gstin', 'pan', 'currency']
    .forEach((k) => { if (first(c[k])) out[k] = c[k]; });
  if (first(b.logo_data_url, c.logoDataUrl)) out.logoDataUrl = b.logo_data_url || c.logoDataUrl;
  const info = b.business_info || {};
  ['tagline', 'website', 'pan', 'bankDetails', 'upiId'].forEach((k) => { if (first(info[k])) out[k] = info[k]; });
  return out;
}

export function autoTitle(documentType) {
  return ({
    SALES_INVOICE: 'TAX INVOICE',
    WHOLESALE_BILL: 'WHOLESALE TAX INVOICE',
    ORDER_BILL: 'ORDER / JOB SLIP',
    PURCHASE_BILL: 'PURCHASE ENTRY / GOODS RECEIPT',
    SALES_RETURN: 'SALES RETURN / CREDIT NOTE',
    PURCHASE_RETURN: 'PURCHASE RETURN / DEBIT NOTE',
    QUOTATION: 'QUOTATION / ESTIMATE',
    PAYMENT_RECEIPT: 'PAYMENT RECEIPT',
  })[canonicalDocType(documentType)] || 'INVOICE';
}

const PARTY_LABEL = {
  PURCHASE_BILL: 'Supplier', PURCHASE_RETURN: 'Supplier', PAYMENT_RECEIPT: 'Received From',
  QUOTATION: 'Prepared For', SALES_RETURN: 'Customer',
};
const partyLabel = (t) => PARTY_LABEL[canonicalDocType(t)] || 'Bill To';

function variantOf(it) {
  return [str(it.size), str(it.color, it.colour)].filter((v) => v && v !== '-' && v !== '—').join(' / ');
}

// Per-mode amounts taken at billing: [{mode, amount}] from any of the shapes the screens keep.
function paymentSplits(doc) {
  const src = first(doc.payment_splits, doc.paymentSplits, doc.multiPay);
  const out = [];
  const LABEL = { cash: 'Cash', card: 'Card', upi: 'UPI', bank: 'Bank' };
  if (Array.isArray(src)) {
    src.forEach((s) => {
      const amount = numOrNull(s?.amount);
      if (amount) out.push({ mode: str(s.mode, s.method, 'Payment'), amount });
    });
  } else if (src && typeof src === 'object') {
    Object.entries(src).forEach(([k, v]) => {
      const amount = numOrNull(v);
      if (amount && LABEL[k.toLowerCase()]) out.push({ mode: LABEL[k.toLowerCase()], amount });
    });
  }
  return out;
}

function finishParty(party, documentType) {
  return { role: 'customer', label: partyLabel(documentType), shippingAddress: '', code: '', ...party };
}

// ---------------------------------------------------------------------------
// Per-source adapters
// ---------------------------------------------------------------------------

function salesLine(it) {
  const qty = numOrNull(it.qty, it.quantity);
  const rate = numOrNull(it.price, it.unit_price, it.rate, it.unitPrice);
  const discount = numOrNull(it.discount_amount, it.discountAmount, it.disc, it.discount);
  const taxAmount = numOrNull(it.taxAmount, it.tax_amount, it.tax);
  let total = numOrNull(it.total, it.subtotal, it.line_total, it.amount);
  if (total === null && rate !== null && discount === null && taxAmount === null
      && it.taxPercent === undefined && it.tax_rate === undefined) {
    total = Math.round(rate * (qty ?? 1) * 100) / 100;
  }
  return {
    name: str(it.display_name, it.name, it.item, it.product, it.productName, it.product_name, it.description) || 'Item',
    description: str(it.description) !== str(it.display_name, it.name, it.item) ? str(it.description) : '',
    brand: str(it.brand),
    sku: str(it.sku, it.product_code, it.code),
    barcode: str(it.barcode),
    hsn: str(it.hsn, it.hsn_code, it.hsnCode),
    variant: variantOf(it),
    size: str(it.size),
    color: str(it.color, it.colour),
    // Prescribed power for this line — printed only when the sale actually recorded one.
    power: cleanPower(first(it.power, it.powerText, it.rxPower)),
    batch: '',
    expiry: '',
    qty: qty ?? 1,
    freeQty: null,
    unit: str(it.unit, it.uom),
    mrp: null,
    rate,
    discount,
    // Percent is only printed when the line was actually discounted BY a percent — a flat
    // ₹ discount prints as money, so the bill shows the figure that was entered.
    discountPercent: it.discount_percent !== undefined
      ? numOrNull(it.discount_percent)
      : ((it.discMode !== 'AMT' && num(it.discPercent) > 0) ? num(it.discPercent) : null),
    taxPercent: numOrNull(it.taxPercent, it.tax_rate, it.gst),
    taxAmount,
    total,
    itemType: str(it.itemType, it.item_type, 'PRODUCT').toUpperCase(),
    // Legacy jewellery columns (schema-1 templates only).
    grossWeight: num(first(it.grossWeight, it.gross_weight)),
    netWeight: num(first(it.netWeight, it.net_weight)),
    stoneWeight: num(first(it.stoneWeight, it.stone_weight)),
    makingCharge: num(first(it.makingCharge, it.making_charge)),
    stoneCharge: num(first(it.stoneCharge, it.stone_charge)),
    otherCharges: num(first(it.otherCharges, it.other_charges)),
  };
}

function adaptSalesLike(doc, documentType) {
  const rawItems = Array.isArray(doc.items) && doc.items.length
    ? doc.items
    : (first(doc.item, doc.frame) ? [{ name: first(doc.item, doc.frame), qty: 1, total: first(doc.total, doc.net_amount) }] : []);
  const items = rawItems.map(salesLine);

  const grandTotal = numOrNull(doc.netTotal, doc.net_amount, doc.grand_total, doc.total);
  const tax = numOrNull(doc.totalTax, doc.tax_amount);
  const discount = numOrNull(doc.discount_amount, doc.itemDiscounts, doc.totalDiscount);
  const subtotal = numOrNull(doc.grossTotal, doc.total_amount);
  const paid = numOrNull(doc.totalPaidAmount, doc.paidAmount, doc.paid_amount, doc.advancePaid);
  const balance = numOrNull(doc.balanceDue, doc.balance_due, doc.balance_amount);
  const status = str(doc.paymentStatusLabel, doc.payment_status,
    (grandTotal !== null && paid !== null) ? (paid >= grandTotal - 0.009 ? 'PAID' : (paid > 0 ? 'PARTIALLY PAID' : 'UNPAID')) : '');
  const splits = paymentSplits(doc);
  const isReturn = canonicalDocType(documentType) === 'SALES_RETURN';

  const party = finishParty({
    name: str(doc.customerName, doc.patientName, doc.customer_name, typeof doc.customer === 'string' ? doc.customer : '', doc.customer?.name) || 'Walk-in Customer',
    code: str(doc.customerCode, doc.customer_code, doc.patientCode),
    phone: str(doc.customerPhone, doc.phone, doc.customer_phone),
    address: str(doc.customerAddress, doc.address, doc.customer_address),
    gstin: str(doc.customerGstin, doc.customer_gstin, doc.gstin),
    email: str(doc.customerEmail, doc.customer_email),
  }, documentType);

  return {
    document: {
      type: documentType,
      title: autoTitle(documentType),
      number: str(doc.invoiceNumber, doc.invoice_number, doc.returnNo, doc.return_number, doc.number, doc.id),
      orderNumber: str(doc.orderNumber, doc.order_number, doc.order_ref),
      reference: str(doc.reference, doc.refNo),
      date: str(doc.date, doc.invoice_date, doc.return_date) || new Date().toISOString().split('T')[0],
      dueDate: str(doc.dueDate, doc.due_date, doc.validUntil),
      deliveryDate: str(doc.deliveryDate, doc.delivery_date, doc.deliveredAt, doc.delivered_at),
      status: str(doc.document_status, doc.docStatus),
      paymentStatus: status,
      fulfillmentStatus: str(doc.fulfillment_status, typeof doc.status === 'string' && !/^(paid|unpaid|partial|draft|cancelled)$/i.test(doc.status) ? doc.status : ''),
      salesperson: str(doc.salesman, doc.salesperson, doc.doctor, doc.optometrist),
      branch: str(doc.branch_name, typeof doc.branch === 'string' && !/^[0-9a-f-]{36}$/i.test(doc.branch) ? doc.branch : ''),
      preparedBy: str(doc.preparedBy, doc.created_by_name, doc.createdBy),
      printedAt: new Date().toISOString(),
      notes: str(doc.notes, doc.fulfillmentNotes, doc.fulfillment_notes, doc.diagnosis && `Diagnosis: ${doc.diagnosis}`),
      terms: str(doc.terms),
    },
    party,
    customer: party,
    items,
    totals: {
      subtotal,
      discount,
      additionalDiscount: numOrNull(doc.additionalDiscount),
      taxableAmount: numOrNull(doc.taxableAmount, doc.taxable_amount),
      tax,
      cgst: numOrNull(doc.cgst, doc.cgst_amount),
      sgst: numOrNull(doc.sgst, doc.sgst_amount),
      igst: numOrNull(doc.igst, doc.igst_amount),
      cess: numOrNull(doc.cess, doc.cess_amount),
      shipping: numOrNull(doc.shipping, doc.delivery_charge),
      otherCharges: numOrNull(doc.otherCharges, doc.other_charges),
      roundOff: numOrNull(doc.roundOff, doc.round_off),
      grandTotal,
      paid,
      balance,
      refund: isReturn ? numOrNull(doc.refundAmount, doc.refund_amount, doc.return_amount, doc.amount) : null,
    },
    payment: {
      method: str(doc.paymentMethod, doc.method, doc.paymentMode, doc.payment_method),
      reference: str(doc.paymentReference, doc.txnRef, doc.transaction_ref),
      splits,
      paid,
      balance,
      status,
      bankDetails: '',
      upiId: '',
    },
    receipt: { amount: null, invoiceNumber: '' },
    return: {
      reason: str(doc.reason, doc.returnReason),
      originalInvoice: str(doc.originalInvoice, doc.original_invoice, isReturn ? first(doc.invoiceNo, doc.invoice_number) : ''),
      action: str(doc.action_taken, doc.actionTaken),
    },
    footer: {
      notes: str(doc.diagnosis && `Diagnosis: ${doc.diagnosis}`),
    },
  };
}

function adaptPurchase(doc, documentType) {
  const items = (doc.items || []).map((it) => {
    const qty = numOrNull(it.quantity, it.qty);
    const rate = numOrNull(it.purchase_rate, it.rate, it.unit_price);
    return {
      name: str(it.productName, it.product_name, it.name, it.item) || 'Item',
      description: '',
      brand: str(it.brand),
      sku: str(it.sku, it.product_code),
      barcode: str(it.barcode),
      hsn: str(it.hsn, it.hsn_code),
      variant: variantOf(it),
      size: str(it.size),
      color: str(it.color, it.colour),
      power: '',
      batch: str(it.batch_number, it.batch),
      expiry: str(it.expiry_date, it.expiry),
      qty: qty ?? 0,
      freeQty: numOrNull(it.free_quantity, it.freeQty),
      unit: str(it.unit),
      mrp: numOrNull(it.mrp),
      rate,
      discount: numOrNull(it.discount_amount),
      discountPercent: numOrNull(it.discount_percent),
      taxPercent: numOrNull(it.gst_percent, it.tax_rate),
      taxAmount: numOrNull(it.gst_amount, it.tax_amount),
      total: numOrNull(it.line_total, it.total, it.amount, it.creditAmount),
      itemType: 'PRODUCT',
      grossWeight: 0, netWeight: 0, stoneWeight: 0, makingCharge: 0, stoneCharge: 0, otherCharges: 0,
    };
  });
  const isReturn = canonicalDocType(documentType) === 'PURCHASE_RETURN';
  const grandTotal = numOrNull(doc.grand_total, doc.grandTotal, isReturn ? first(doc.creditAmount, doc.credit_amount, doc.amount) : undefined);
  const paid = numOrNull(doc.paid_amount, doc.paidAmount);
  const balance = numOrNull(doc.balance_amount, doc.balanceAmount);
  const party = finishParty({
    role: 'supplier',
    name: str(doc.supplierName, doc.supplier_name, doc.supplier) || 'Supplier',
    code: str(doc.supplier_code, doc.supplierCode),
    phone: str(doc.supplier_phone, doc.supplierPhone),
    address: str(doc.supplier_address, doc.supplierAddress),
    gstin: str(doc.supplier_gstin, doc.supplierGstin),
    email: str(doc.supplier_email),
  }, documentType);
  return {
    document: {
      type: documentType,
      title: autoTitle(documentType),
      number: str(doc.invoice_number, doc.invoiceNumber, doc.returnNo, doc.id),
      orderNumber: str(doc.purchase_order_ref),
      reference: str(doc.supplier_invoice_number, doc.supplierInvoiceNumber),
      date: str(doc.purchase_date, doc.date) || new Date().toISOString().split('T')[0],
      dueDate: str(doc.due_date, doc.dueDate),
      deliveryDate: '',
      status: str(doc.status),
      paymentStatus: (grandTotal !== null && paid !== null) ? (paid >= grandTotal - 0.009 ? 'PAID' : (paid > 0 ? 'PARTIALLY PAID' : 'UNPAID')) : '',
      fulfillmentStatus: '',
      salesperson: '',
      branch: str(doc.branch_name, doc.warehouse_name, typeof doc.branch === 'string' && !/^[0-9a-f-]{36}$/i.test(doc.branch) ? doc.branch : ''),
      preparedBy: str(doc.created_by_name),
      printedAt: new Date().toISOString(),
      notes: str(doc.notes),
      terms: '',
    },
    party,
    customer: party,
    items,
    totals: {
      subtotal: numOrNull(doc.gross_amount),
      discount: numOrNull(doc.discount_amount),
      additionalDiscount: null,
      taxableAmount: null,
      tax: numOrNull(doc.tax_amount),
      cgst: numOrNull(doc.cgst_amount),
      sgst: numOrNull(doc.sgst_amount),
      igst: numOrNull(doc.igst_amount),
      cess: numOrNull(doc.cess_amount),
      shipping: null,
      otherCharges: numOrNull(doc.other_charges),
      roundOff: numOrNull(doc.round_off),
      grandTotal,
      paid,
      balance,
      refund: isReturn ? numOrNull(doc.creditAmount, doc.credit_amount) : null,
    },
    payment: {
      method: str(doc.payment_method, doc.paymentMethod),
      reference: '',
      splits: [],
      paid,
      balance,
      status: str(doc.status),
      bankDetails: '',
      upiId: '',
    },
    receipt: { amount: null, invoiceNumber: '' },
    return: {
      reason: str(doc.reason),
      originalInvoice: str(doc.originalInvoice, doc.purchase_invoice_number, doc.purchase_return_ref),
      action: str(doc.status),
    },
    footer: { notes: str(doc.notes) },
  };
}

function adaptWholesale(doc, documentType) {
  const items = (doc.items || []).map((it) => {
    const qty = numOrNull(it.qty, it.quantity);
    const rate = numOrNull(it.rate, it.price);
    return {
      name: str(it.name, it.product) || 'Item',
      description: '',
      brand: str(it.brand),
      sku: str(it.code, it.sku),
      barcode: str(it.barcode),
      hsn: str(it.hsn),
      variant: variantOf(it),
      size: str(it.size),
      color: str(it.color, it.colour),
      power: '',
      batch: '',
      expiry: '',
      qty: qty ?? 0,
      freeQty: null,
      unit: str(it.unit),
      mrp: null,
      rate,
      discount: null,
      discountPercent: numOrNull(it.discount),
      taxPercent: numOrNull(it.taxPercent, it.gst),
      taxAmount: numOrNull(it.taxAmount, it.gstAmount),
      total: numOrNull(it.total),
      itemType: 'PRODUCT',
      grossWeight: 0, netWeight: 0, stoneWeight: 0, makingCharge: 0, stoneCharge: 0, otherCharges: 0,
    };
  });
  const s = doc.summary || {};
  const isReturn = canonicalDocType(documentType) === 'SALES_RETURN';
  const grandTotal = numOrNull(s.grandTotal, doc.grandTotal, doc.grand_total, isReturn ? doc.amount : undefined);
  const paid = numOrNull(doc.amountReceived, doc.paidAmount, doc.paid_amount);
  const balance = numOrNull(doc.dueAmount, doc.due_amount, doc.balanceDue);
  const cust = doc.customer || {};
  const party = finishParty({
    name: str(cust.name, cust.business_name, doc.customerName) || 'Wholesale Buyer',
    code: str(cust.code, cust.dealer_code),
    phone: str(cust.phone),
    address: str(cust.address),
    gstin: str(cust.gstin),
    email: str(cust.email),
    shippingAddress: str(doc.delivery?.address, doc.deliveryAddress, doc.shippingAddress),
  }, documentType);
  return {
    document: {
      type: documentType,
      title: autoTitle(documentType),
      number: isReturn ? str(doc.returnNo, doc.return_number, doc.noteNo) : str(doc.invoiceNo, doc.invoice_number, doc.invoiceNumber),
      orderNumber: str(doc.orderRef, doc.order_ref),
      reference: str(doc.refNo),
      date: str(doc.date, doc.invoice_date) || new Date().toISOString().split('T')[0],
      dueDate: str(doc.dueDate, doc.due_date),
      deliveryDate: str(doc.delivery?.date),
      status: str(doc.orderStatus),
      paymentStatus: str(doc.status, (balance !== null && balance <= 0.009) ? 'PAID' : (balance !== null ? 'CREDIT' : '')),
      fulfillmentStatus: '',
      salesperson: str(doc.salesExecutive, doc.sales_executive),
      branch: '',
      preparedBy: str(doc.preparedBy),
      printedAt: new Date().toISOString(),
      notes: str(doc.notes, doc.refNo && `Ref: ${doc.refNo}`),
      terms: doc.creditDays ? `Payment due within ${doc.creditDays} days.` : '',
    },
    party,
    customer: party,
    items,
    totals: {
      subtotal: numOrNull(s.subtotal),
      discount: numOrNull(s.totalDiscount),
      additionalDiscount: null,
      taxableAmount: numOrNull(s.taxableAmount),
      tax: numOrNull(s.totalGst, s.totalTax),
      cgst: numOrNull(s.cgst),
      sgst: numOrNull(s.sgst),
      igst: numOrNull(s.igst),
      cess: null,
      shipping: numOrNull(s.transport, s.shipping),
      otherCharges: numOrNull(s.otherCharges),
      roundOff: numOrNull(s.roundOff),
      grandTotal,
      paid,
      balance,
      refund: isReturn ? numOrNull(doc.amount, doc.return_amount) : null,
    },
    payment: {
      method: str(doc.payMode, doc.payment_method),
      reference: str(doc.paymentRef, doc.txnRef),
      splits: [],
      paid,
      balance,
      status: str(doc.status),
      bankDetails: '',
      upiId: '',
    },
    receipt: { amount: null, invoiceNumber: '' },
    return: {
      reason: str(doc.reason),
      originalInvoice: isReturn ? str(doc.invoiceNo, doc.invoice_number) : '',
      action: str(doc.action_taken, doc.actionTaken),
    },
    footer: {
      notes: str(doc.refNo && `Ref: ${doc.refNo}`),
      terms: doc.creditDays ? `Payment due within ${doc.creditDays} days.` : '',
    },
  };
}

function adaptPaymentReceipt(doc, documentType) {
  const amount = numOrNull(doc.amount, doc.amount_paid, doc.paidAmount);
  const party = finishParty({
    name: str(doc.customer_name, doc.customerName, typeof doc.customer === 'string' ? doc.customer : '', doc.dealer_name) || 'Customer',
    phone: str(doc.phone, doc.customer_phone),
    code: str(doc.customer_code),
    address: '', gstin: '', email: '',
  }, documentType);
  const invoiceNumber = str(doc.invoice_number, doc.invoiceNumber, typeof doc.invoice === 'string' && !/^[0-9a-f-]{36}$/i.test(doc.invoice) ? doc.invoice : '');
  return {
    document: {
      type: documentType,
      title: autoTitle(documentType),
      number: str(doc.receipt_no, doc.receiptNo, doc.receipt_number, doc.id),
      orderNumber: invoiceNumber,
      reference: str(doc.reference, doc.txnRef, doc.reference_note),
      date: str(doc.payment_date, doc.date) || new Date().toISOString().split('T')[0],
      dueDate: '',
      deliveryDate: '',
      status: str(doc.status),
      paymentStatus: str(doc.status, 'RECEIVED'),
      fulfillmentStatus: '',
      salesperson: '',
      branch: str(doc.branch_name),
      preparedBy: str(doc.created_by_name),
      printedAt: new Date().toISOString(),
      notes: str(doc.notes),
      terms: '',
    },
    party,
    customer: party,
    items: [],
    totals: {
      subtotal: null, discount: null, additionalDiscount: null, taxableAmount: null, tax: null,
      cgst: null, sgst: null, igst: null, cess: null, shipping: null, otherCharges: null, roundOff: null,
      grandTotal: amount, paid: amount, balance: null, refund: null,
    },
    payment: {
      method: str(doc.method, doc.payment_method),
      reference: str(doc.reference, doc.txnRef, doc.reference_note),
      splits: [],
      paid: amount,
      balance: null,
      status: str(doc.status, 'RECEIVED'),
      bankDetails: '',
      upiId: '',
    },
    receipt: { amount, invoiceNumber },
    return: { reason: '', originalInvoice: '', action: '' },
    footer: { notes: str(doc.notes) },
  };
}

// A wholesale document (POS shape) has `summary` / `invoiceNo`; a retail one does not.
const isWholesaleShape = (doc) => !!(doc && (doc.summary || doc.invoiceNo || doc.payMode));

const ADAPTERS = {
  SALES_INVOICE: adaptSalesLike,
  ORDER_BILL: adaptSalesLike,
  QUOTATION: adaptSalesLike,
  SALES_RETURN: (doc, t) => (isWholesaleShape(doc) ? adaptWholesale(doc, t) : adaptSalesLike(doc, t)),
  PURCHASE_BILL: adaptPurchase,
  PURCHASE_RETURN: adaptPurchase,
  WHOLESALE_BILL: adaptWholesale,
  PAYMENT_RECEIPT: adaptPaymentReceipt,
};

export function toBillModel(rawDoc, documentType = 'SALES_INVOICE', ctx = {}) {
  const type = canonicalDocType(documentType);
  const adapter = ADAPTERS[type] || adaptSalesLike;
  const model = adapter(rawDoc || {}, type);
  model.company = resolveCompany(ctx);
  model.company.currency = model.company.currency || '₹';
  model.payment.bankDetails = model.company.bankDetails || '';
  model.payment.upiId = model.company.upiId || '';
  if (ctx.user && !model.document.preparedBy) model.document.preparedBy = ctx.user;
  // A caller may pass an explicit title override (e.g. "PROFORMA INVOICE").
  if (rawDoc && rawDoc.__title) model.document.title = rawDoc.__title;
  model.isSample = false;
  return model;
}
