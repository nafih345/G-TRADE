// Builds the WhatsApp receipt text + share URL for an invoice/order snapshot. Split out from
// sendInvoiceWhatsApp so the "Show Bill" preview can display exactly what will be sent before
// anything opens, and so an Alt+W shortcut can share the same text on demand.
export const buildInvoiceWhatsAppMessage = (invoice, customPhone = null) => {
  if (!invoice) return null;

  const invNo = invoice.invoiceNumber || invoice.id || 'INV';
  const invDate = invoice.date || invoice.invoice_date || new Date().toISOString().split('T')[0];
  const patientName = invoice.customerName || invoice.patientName || invoice.customer_name || invoice.customer || 'Valued Customer';

  // Try looking up real phone from invoice or localStorage customer directory
  let phone = customPhone || invoice.phone || invoice.customerPhone || invoice.customer_phone || '';
  if (!phone || phone === 'N/A' || phone.includes('9847012345') || phone.includes('98470 12345')) {
    try {
      const custs = JSON.parse(localStorage.getItem('optical_sales_customers') || '[]');
      const matched = custs.find(c => (c.name && c.name.toLowerCase() === patientName.toLowerCase()) || c.id === invoice.customerId);
      if (matched && matched.phone && matched.phone !== 'N/A' && !matched.phone.includes('9847012345')) {
        phone = matched.phone;
      } else {
        phone = '';
      }
    } catch (e) {
      phone = '';
    }
  }

  // Clean phone number (digits only, prefix 91 for 10-digit Indian numbers)
  let cleanPhone = (phone || '').replace(/\D/g, '');
  if (cleanPhone.length === 10) {
    cleanPhone = `91${cleanPhone}`;
  }

  const frameName = invoice.frame || invoice.items?.[0]?.name || invoice.items?.[0]?.item || 'Prescribed Optical Frame';
  const lensName = invoice.lens || invoice.items?.[1]?.name || invoice.items?.[1]?.item || 'Prescribed Optical Lens';
  const grandTotal = parseFloat(invoice.netTotal || invoice.total || invoice.net_amount || 0);
  const totalAmount = grandTotal.toLocaleString();

  const amountPaidNum = invoice.totalPaidAmount !== undefined && invoice.totalPaidAmount !== null
    ? parseFloat(invoice.totalPaidAmount) || 0
    : (invoice.paidAmount !== undefined && invoice.paidAmount !== null
      ? parseFloat(invoice.paidAmount) || 0
      : grandTotal);
  const balanceDueNum = invoice.balanceDue !== undefined && invoice.balanceDue !== null
    ? parseFloat(invoice.balanceDue) || 0
    : Math.max(0, grandTotal - amountPaidNum);
  const payStatus = invoice.paymentStatusLabel
    || (balanceDueNum <= 0.009 ? 'PAID' : (amountPaidNum > 0 ? 'PARTIALLY PAID' : 'UNPAID'));

  const message =
`👓 *GREENSOL OPTICALS - TAX INVOICE RECEIPT*
-----------------------------------------
Dear *${patientName}*,

Thank you for choosing Greensol Super Speciality Eye Care! Here are your optical invoice details:

📄 *Invoice No:* ${invNo}
📅 *Date:* ${invDate}
👓 *Frame:* ${frameName}
🔍 *Lens:* ${lensName}
💳 *Total Amount:* ₹${totalAmount}
✅ *Amount Paid:* ₹${amountPaidNum.toLocaleString()}
🧾 *Balance Due:* ₹${balanceDueNum.toLocaleString()} (${payStatus})

We hope you enjoy your new eyewear! For frame alignment or warranty support, visit our branch or call +91 98470 12345.
-----------------------------------------
*Greensol Opticals & Eye Hospital*`;

  const encodedMessage = encodeURIComponent(message);

  // If valid customer phone exists, open direct chat. Otherwise, open WhatsApp with text
  // pre-filled so the user can pick the contact.
  const waUrl = cleanPhone && cleanPhone.length >= 10
    ? `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodedMessage}`
    : `https://api.whatsapp.com/send?text=${encodedMessage}`;

  return { message, waUrl, cleanPhone, phone: phone || '', patientName };
};

// Guards against a single Alt+W press being handled by more than one mounted listener (the New
// Sale screen and an open preview dialog both watch for it) and against key-repeat — collapse
// rapid duplicate shares into one opened tab.
let lastShareAt = 0;

export const sendInvoiceWhatsApp = (invoice, customPhone = null) => {
  const built = buildInvoiceWhatsAppMessage(invoice, customPhone);
  if (!built) return;
  const now = Date.now();
  if (now - lastShareAt < 1500) return;
  lastShareAt = now;
  window.open(built.waUrl, '_blank');
};
