export const printSalesInvoiceReceipt = (invoice) => {
  if (!invoice) return;

  const invNo = invoice.invoiceNumber || invoice.id || `INV-${Math.floor(10000 + Math.random() * 90000)}`;
  const invDate = invoice.date || invoice.invoice_date || new Date().toISOString().split('T')[0];
  const patientName = invoice.customerName || invoice.patientName || invoice.customer_name || invoice.customer || 'Valued Customer';
  const patientPhone = invoice.phone || invoice.customer_phone || 'N/A';
  const doctorName = invoice.doctor || invoice.optometrist || 'Attending Optometrist';
  const payMethod = invoice.paymentMethod || invoice.method || invoice.payment || 'Cash / UPI';
  
  const items = invoice.items && invoice.items.length > 0 ? invoice.items : [
    { name: invoice.item || invoice.frame || 'Prescribed Spectacle Frame & Optical Lens', qty: 1, price: invoice.total || invoice.net_amount || 0 }
  ];

  const grandTotal = parseFloat(invoice.total || invoice.net_amount || 0);
  const subtotal = (grandTotal / 1.18);
  const gstAmount = grandTotal - subtotal;

  const printWindow = window.open('', '_blank', 'width=850,height=800');
  
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Invoice - ${invNo}</title>
        <style>
          @page { size: A4 portrait; margin: 12mm; }
          * { box-sizing: border-box; }
          body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; margin: 0; padding: 15px; background: #fff; }
          .receipt-box { width: 100%; max-width: 780px; margin: 0 auto; border: 1.5px solid #cbd5e1; padding: 25px; border-radius: 6px; }
          .header-table { width: 100%; border-bottom: 2px solid #2563eb; padding-bottom: 15px; margin-bottom: 15px; }
          .brand-title { font-size: 24px; font-weight: 800; color: #2563eb; letter-spacing: 0.5px; }
          .sub-brand { font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase; margin-top: 2px; }
          .header-right { text-align: right; font-size: 11px; color: #475569; line-height: 1.4; }
          .invoice-banner { background: #f1f5f9; text-align: center; padding: 8px; font-weight: 800; font-size: 15px; color: #1e293b; letter-spacing: 1px; border-radius: 4px; margin-bottom: 15px; text-transform: uppercase; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
          .info-table td { padding: 6px 10px; border: 1px solid #e2e8f0; }
          .info-label { font-weight: 700; color: #475569; background: #f8fafc; width: 22%; }
          .items-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
          .items-table th { background: #0f172a; color: #fff; padding: 8px 10px; text-align: left; font-weight: 700; }
          .items-table td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
          .totals-table { width: 320px; margin-left: auto; border-collapse: collapse; font-size: 13px; margin-bottom: 25px; }
          .totals-table td { padding: 5px 8px; }
          .grand-total-row td { font-size: 16px; font-weight: 800; color: #2563eb; border-top: 2px solid #2563eb; padding-top: 8px; }
          .footer-section { border-top: 1px solid #cbd5e1; padding-top: 15px; display: flex; justify-content: space-between; align-items: flex-end; font-size: 10px; color: #64748b; }
          .sign-box { text-align: center; border-top: 1px dashed #94a3b8; width: 170px; padding-top: 5px; font-weight: 700; color: #1e293b; }
        </style>
      </head>
      <body>
        <div class="receipt-box">
          <table class="header-table">
            <tr>
              <td>
                <div class="brand-title">GREENSOL OPTICALS</div>
                <div class="sub-brand">Super Speciality Eye Care & Optical ERP</div>
                <div style="font-size:10px; color:#64748b; margin-top:3px;">GSTIN: 32AAAAA0000A1Z5 | Reg: KMC-89421</div>
              </td>
              <td class="header-right">
                <strong>Main Branch Headquarters</strong><br/>
                Greensol Vision Hospital Complex, Medical College Road<br/>
                Phone: +91 98470 12345 | Email: sales@greensoloptical.com
              </td>
            </tr>
          </table>

          <div class="invoice-banner">TAX INVOICE & RETAIL RECEIPT</div>

          <table class="info-table">
            <tr>
              <td class="info-label">Invoice Number:</td>
              <td><strong>${invNo}</strong></td>
              <td class="info-label">Invoice Date:</td>
              <td>${invDate}</td>
            </tr>
            <tr>
              <td class="info-label">Patient Name:</td>
              <td><strong>${patientName}</strong></td>
              <td class="info-label">Registered Phone:</td>
              <td>${patientPhone}</td>
            </tr>
            <tr>
              <td class="info-label">Optometrist:</td>
              <td>${doctorName}</td>
              <td class="info-label">Payment Status:</td>
              <td><strong style="color:#059669;">PAID (${payMethod})</strong></td>
            </tr>
          </table>

          <table class="items-table">
            <thead>
              <tr>
                <th style="width:50%;">Product / Service Description</th>
                <th style="width:15%; text-align:center;">Qty</th>
                <th style="width:18%; text-align:right;">Rate (₹)</th>
                <th style="width:17%; text-align:right;">Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(it => `
                <tr>
                  <td><strong>${it.name || it.product || 'Optical Product'}</strong></td>
                  <td style="text-align:center;">${it.qty || 1}</td>
                  <td style="text-align:right;">₹${parseFloat(it.price || grandTotal).toFixed(2)}</td>
                  <td style="text-align:right;"><strong>₹${(parseFloat(it.price || grandTotal) * (it.qty || 1)).toFixed(2)}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          <table class="totals-table">
            <tr>
              <td>Subtotal:</td>
              <td style="text-align:right; font-weight:bold;">₹${subtotal.toFixed(2)}</td>
            </tr>
            <tr>
              <td>GST Tax (18%):</td>
              <td style="text-align:right; font-weight:bold;">₹${gstAmount.toFixed(2)}</td>
            </tr>
            <tr class="grand-total-row">
              <td>Net Amount:</td>
              <td style="text-align:right;">₹${grandTotal.toFixed(2)}</td>
            </tr>
          </table>

          <div class="footer-section">
            <div>
              <strong>Warranty & Terms:</strong><br/>
              1. 1-Year replacement warranty on spectacle frames against manufacturing defects.<br/>
              2. Please bring this invoice for free alignment & ultrasonic lens cleaning.
            </div>
            <div class="sign-box">
              Authorized Signature<br/>
              <span style="font-size:9px; font-weight:normal; color:#64748b;">Greensol Optical ERP</span>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;

  if (printWindow) {
    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    setTimeout(() => {
      try {
        printWindow.focus();
        printWindow.print();
      } catch (e) {}
    }, 250);
  }
};

export const downloadPdfInvoice = (invoice) => {
  if (!invoice) return;

  const invNo = invoice.invoiceNumber || invoice.id || `INV-${Math.floor(10000 + Math.random() * 90000)}`;
  const invDate = invoice.date || invoice.invoice_date || new Date().toISOString().split('T')[0];
  const patientName = invoice.customerName || invoice.patientName || invoice.customer_name || invoice.customer || 'Valued Customer';
  const patientPhone = invoice.phone || invoice.customer_phone || 'N/A';
  const doctorName = invoice.doctor || invoice.optometrist || 'Attending Optometrist';
  const payMethod = invoice.paymentMethod || invoice.method || invoice.payment || 'Cash / UPI';
  
  const items = invoice.items && invoice.items.length > 0 ? invoice.items : [
    { name: invoice.item || invoice.frame || 'Prescribed Spectacle Frame & Optical Lens', qty: 1, price: invoice.total || invoice.net_amount || 0 }
  ];

  const grandTotal = parseFloat(invoice.total || invoice.net_amount || 0);
  const subtotal = (grandTotal / 1.18);
  const gstAmount = grandTotal - subtotal;

  const pdfWindow = window.open('', '_blank', 'width=850,height=800');
  
  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Invoice_${invNo}.pdf</title>
        <style>
          @page { size: A4 portrait; margin: 10mm; }
          * { box-sizing: border-box; }
          body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; margin: 0; padding: 15px; background: #fff; }
          .receipt-box { width: 100%; max-width: 780px; margin: 0 auto; border: 2px solid #2563eb; padding: 25px; border-radius: 6px; }
          .header-table { width: 100%; border-bottom: 2px solid #2563eb; padding-bottom: 15px; margin-bottom: 15px; }
          .brand-title { font-size: 26px; font-weight: 800; color: #2563eb; letter-spacing: 0.5px; }
          .sub-brand { font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase; margin-top: 2px; }
          .header-right { text-align: right; font-size: 11px; color: #475569; line-height: 1.4; }
          .invoice-banner { background: #2563eb; color: #ffffff; text-align: center; padding: 8px; font-weight: 800; font-size: 15px; letter-spacing: 1px; border-radius: 4px; margin-bottom: 15px; text-transform: uppercase; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
          .info-table td { padding: 6px 10px; border: 1px solid #e2e8f0; }
          .info-label { font-weight: 700; color: #475569; background: #f8fafc; width: 22%; }
          .items-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 12px; }
          .items-table th { background: #0f172a; color: #fff; padding: 8px 10px; text-align: left; font-weight: 700; }
          .items-table td { padding: 8px 10px; border-bottom: 1px solid #e2e8f0; }
          .totals-table { width: 320px; margin-left: auto; border-collapse: collapse; font-size: 13px; margin-bottom: 25px; }
          .totals-table td { padding: 5px 8px; }
          .grand-total-row td { font-size: 16px; font-weight: 800; color: #2563eb; border-top: 2px solid #2563eb; padding-top: 8px; }
          .footer-section { border-top: 1px solid #cbd5e1; padding-top: 15px; display: flex; justify-content: space-between; align-items: flex-end; font-size: 10px; color: #64748b; }
          .sign-box { text-align: center; border-top: 1px dashed #94a3b8; width: 170px; padding-top: 5px; font-weight: 700; color: #1e293b; }
        </style>
      </head>
      <body>
        <div class="receipt-box">
          <table class="header-table">
            <tr>
              <td>
                <div class="brand-title">GREENSOL OPTICALS</div>
                <div class="sub-brand">Super Speciality Eye Care & Optical ERP</div>
                <div style="font-size:10px; color:#64748b; margin-top:3px;">GSTIN: 32AAAAA0000A1Z5 | Reg: KMC-89421</div>
              </td>
              <td class="header-right">
                <strong>Main Branch Headquarters</strong><br/>
                Greensol Vision Hospital Complex, Medical College Road<br/>
                Phone: +91 98470 12345 | Email: sales@greensoloptical.com
              </td>
            </tr>
          </table>

          <div class="invoice-banner">OFFICIAL DIGITAL PDF INVOICE RECEIPT</div>

          <table class="info-table">
            <tr>
              <td class="info-label">Invoice Number:</td>
              <td><strong>${invNo}</strong></td>
              <td class="info-label">Invoice Date:</td>
              <td>${invDate}</td>
            </tr>
            <tr>
              <td class="info-label">Patient Name:</td>
              <td><strong>${patientName}</strong></td>
              <td class="info-label">Registered Phone:</td>
              <td>${patientPhone}</td>
            </tr>
            <tr>
              <td class="info-label">Optometrist:</td>
              <td>${doctorName}</td>
              <td class="info-label">Payment Status:</td>
              <td><strong style="color:#059669;">PAID (${payMethod})</strong></td>
            </tr>
          </table>

          <table class="items-table">
            <thead>
              <tr>
                <th style="width:50%;">Product / Service Description</th>
                <th style="width:15%; text-align:center;">Qty</th>
                <th style="width:18%; text-align:right;">Rate (₹)</th>
                <th style="width:17%; text-align:right;">Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(it => `
                <tr>
                  <td><strong>${it.name || it.product || 'Optical Product'}</strong></td>
                  <td style="text-align:center;">${it.qty || 1}</td>
                  <td style="text-align:right;">₹${parseFloat(it.price || grandTotal).toFixed(2)}</td>
                  <td style="text-align:right;"><strong>₹${(parseFloat(it.price || grandTotal) * (it.qty || 1)).toFixed(2)}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          <table class="totals-table">
            <tr>
              <td>Subtotal:</td>
              <td style="text-align:right; font-weight:bold;">₹${subtotal.toFixed(2)}</td>
            </tr>
            <tr>
              <td>GST Tax (18%):</td>
              <td style="text-align:right; font-weight:bold;">₹${gstAmount.toFixed(2)}</td>
            </tr>
            <tr class="grand-total-row">
              <td>Net Amount Paid:</td>
              <td style="text-align:right;">₹${grandTotal.toFixed(2)}</td>
            </tr>
          </table>

          <div class="footer-section">
            <div>
              <strong>Warranty & Terms:</strong><br/>
              1. 1-Year replacement warranty on spectacle frames against manufacturing defects.<br/>
              2. Please bring this PDF invoice receipt for free frame alignment & lens cleaning.
            </div>
            <div class="sign-box">
              Authorized Digital Signature<br/>
              <span style="font-size:9px; font-weight:normal; color:#64748b;">Greensol Optical ERP</span>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;

  if (pdfWindow) {
    pdfWindow.document.open();
    pdfWindow.document.write(htmlContent);
    pdfWindow.document.close();
    setTimeout(() => {
      try {
        pdfWindow.focus();
        pdfWindow.print();
      } catch (e) {}
    }, 250);
  }
};
