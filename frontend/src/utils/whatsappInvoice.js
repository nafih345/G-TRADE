export const sendInvoiceWhatsApp = (invoice, customPhone = null) => {
  if (!invoice) return;

  const invNo = invoice.invoiceNumber || invoice.id || 'INV';
  const invDate = invoice.date || invoice.invoice_date || new Date().toISOString().split('T')[0];
  const patientName = invoice.customerName || invoice.patientName || invoice.customer_name || invoice.customer || 'Valued Customer';
  
  // Try looking up real phone from invoice or localStorage customer directory
  let phone = customPhone || invoice.phone || invoice.customer_phone || '';
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

  const frameName = invoice.frame || invoice.items?.[0]?.name || 'Prescribed Optical Frame';
  const lensName = invoice.lens || invoice.items?.[1]?.name || 'Prescribed Optical Lens';
  const totalAmount = parseFloat(invoice.total || invoice.net_amount || 0).toLocaleString();
  const payStatus = invoice.payment || invoice.paymentMethod || 'Paid';

  const message = 
`👓 *GREENSOL OPTICALS - TAX INVOICE RECEIPT*
-----------------------------------------
Dear *${patientName}*,

Thank you for choosing Greensol Super Speciality Eye Care! Here are your optical invoice details:

📄 *Invoice No:* ${invNo}
📅 *Date:* ${invDate}
👓 *Frame:* ${frameName}
🔍 *Lens:* ${lensName}
💳 *Total Amount:* ₹${totalAmount} (${payStatus})

We hope you enjoy your new eyewear! For frame alignment or warranty support, visit our branch or call +91 98470 12345.
-----------------------------------------
*Greensol Opticals & Eye Hospital*`;

  const encodedMessage = encodeURIComponent(message);
  
  // If valid customer phone exists, open direct chat. Otherwise, open WhatsApp with text pre-filled so user can pick contact!
  const waUrl = cleanPhone && cleanPhone.length >= 10
    ? `https://api.whatsapp.com/send?phone=${cleanPhone}&text=${encodedMessage}`
    : `https://api.whatsapp.com/send?text=${encodedMessage}`;

  window.open(waUrl, '_blank');
};
