export const printSalesInvoiceReceipt = (invoice, paperSize = 'A4') => {
  if (!invoice) return;

  const invNo = invoice.invoiceNumber || invoice.id || `INV-${Math.floor(10000 + Math.random() * 90000)}`;
  const invDate = invoice.date || invoice.invoice_date || new Date().toISOString().split('T')[0];
  const patientName = invoice.customerName || invoice.patientName || invoice.customer_name || invoice.customer || 'Valued Customer';
  const patientPhone = invoice.phone || invoice.customer_phone || 'N/A';
  const patientAge = invoice.customerAge || invoice.age || '';
  const patientGender = invoice.customerGender || invoice.gender || '';
  const patientAddress = invoice.customerAddress || invoice.address || '';
  const diagnosis = invoice.diagnosis || invoice.rxData?.notes || '';
  const icdCode = invoice.icdCode || '';
  const doctorName = invoice.doctor || invoice.optometrist || invoice.salesman || 'Attending Optometrist';
  const payMethod = invoice.paymentMethod || invoice.method || invoice.payment || invoice.paymentMode || 'Cash / UPI';

  const items = invoice.items && invoice.items.length > 0 ? invoice.items : [
    { name: invoice.item || invoice.frame || 'Prescribed Spectacle Frame & Optical Lens', qty: 1, price: invoice.total || invoice.net_amount || 0 }
  ];

  const grandTotal = parseFloat(invoice.netTotal || invoice.total || invoice.net_amount || 0);
  const hasRealTax = invoice.totalTax !== undefined && invoice.totalTax !== null;
  const gstAmount = hasRealTax ? parseFloat(invoice.totalTax) : grandTotal - (grandTotal / 1.18);
  const subtotal = hasRealTax ? grandTotal - gstAmount : grandTotal / 1.18;

  const multiPay = invoice.multiPay;
  const paymentRows = multiPay ? [
    ['Cash', multiPay.cash],
    ['Card', multiPay.cards],
    ['GPay / UPI', multiPay.gpay],
    ['Bank Transfer', multiPay.bank]
  ].filter(([, val]) => parseFloat(val) > 0) : [];

  const isA5 = paperSize === 'A5';
  const isThermal = paperSize === 'Thermal';
  const printWindow = window.open('', '_blank', isThermal ? 'width=400,height=700' : 'width=850,height=800');

  const htmlContent = isThermal
    ? buildThermalReceiptHtml({ invNo, invDate, patientName, patientPhone, patientAge, patientGender, diagnosis, icdCode, doctorName, payMethod, items, grandTotal, gstAmount, subtotal, paymentRows })
    : buildStandardReceiptHtml({ isA5, invNo, invDate, patientName, patientPhone, patientAge, patientGender, patientAddress, diagnosis, icdCode, doctorName, payMethod, items, grandTotal, gstAmount, subtotal, hasRealTax, paymentRows });

  if (printWindow) {
    printWindow.document.open();
    printWindow.document.write(htmlContent);
    printWindow.document.close();
    setTimeout(() => {
      try {
        // An invoice with several line items can genuinely run taller than one physical page —
        // shrink (via zoom, which affects layout/pagination, not just paint) only if the
        // rendered receipt would actually overflow the chosen page, so short invoices are left
        // at full, easily-readable size. Thermal rolls have no fixed page height, so this only
        // applies to A4/A5.
        if (!isThermal) {
          const box = printWindow.document.querySelector('.receipt-box');
          if (box) {
            const pageHeightMm = isA5 ? 210 : 297;
            const marginMm = isA5 ? 8 : 15;
            const maxContentHeightPx = (pageHeightMm - marginMm * 2) * (96 / 25.4);
            const contentHeightPx = box.scrollHeight;
            if (contentHeightPx > maxContentHeightPx) {
              box.style.zoom = Math.max(0.55, maxContentHeightPx / contentHeightPx);
            }
          }
        }
        printWindow.focus();
        printWindow.print();
      } catch (e) {}
    }, 250);
  }
};

// A4 has ~2x the printable area of A5 — every size-sensitive value below is tuned per paper
// size (not just scaled down) so A5 fits its content without overflowing to a second page, and
// A4 doesn't leave the receipt looking small/adrift on a much bigger sheet.
function buildStandardReceiptHtml({ isA5, invNo, invDate, patientName, patientPhone, patientAge, patientGender, patientAddress, diagnosis, icdCode, doctorName, payMethod, items, grandTotal, gstAmount, subtotal, hasRealTax, paymentRows }) {
  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Invoice - ${invNo}</title>
        <style>
          @page { size: ${isA5 ? 'A5' : 'A4'} portrait; margin: ${isA5 ? '8mm' : '15mm'}; }
          * { box-sizing: border-box; }
          body { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; margin: 0; padding: 0; background: #fff; }
          .receipt-box { width: 100%; margin: 0 auto; border: 1px solid #cbd5e1; padding: ${isA5 ? '14px' : '24px'}; border-radius: 8px; }
          .header-table { width: 100%; border-bottom: ${isA5 ? '2px' : '3px'} solid #2563eb; padding-bottom: ${isA5 ? '8px' : '15px'}; margin-bottom: ${isA5 ? '10px' : '18px'}; }
          .brand-title { font-size: ${isA5 ? '20px' : '32px'}; font-weight: 800; color: #2563eb; letter-spacing: 0.5px; }
          .sub-brand { font-size: ${isA5 ? '9px' : '13px'}; color: #64748b; font-weight: 700; text-transform: uppercase; margin-top: 3px; }
          .header-right { text-align: right; font-size: ${isA5 ? '9px' : '13px'}; color: #475569; line-height: 1.5; }
          .invoice-banner { background: #f1f5f9; text-align: center; padding: ${isA5 ? '6px' : '10px'}; font-weight: 800; font-size: ${isA5 ? '13px' : '19px'}; color: #1e293b; letter-spacing: 1px; border-radius: 6px; margin-bottom: ${isA5 ? '10px' : '18px'}; text-transform: uppercase; }
          .info-table { width: 100%; border-collapse: collapse; margin-bottom: ${isA5 ? '12px' : '20px'}; font-size: ${isA5 ? '10px' : '14px'}; }
          .info-table td { padding: ${isA5 ? '5px 8px' : '9px 14px'}; border: 1px solid #e2e8f0; }
          .info-label { font-weight: 700; color: #475569; background: #f8fafc; width: 22%; }
          .items-table { width: 100%; border-collapse: collapse; margin-bottom: ${isA5 ? '14px' : '22px'}; font-size: ${isA5 ? '10px' : '14px'}; }
          .items-table th { background: #0f172a; color: #fff; padding: ${isA5 ? '7px 8px' : '12px 14px'}; text-align: left; font-weight: 700; font-size: ${isA5 ? '9px' : '13px'}; }
          .items-table td { padding: ${isA5 ? '7px 8px' : '12px 14px'}; border-bottom: 1px solid #e2e8f0; }
          .totals-table { width: ${isA5 ? '260px' : '400px'}; margin-left: auto; border-collapse: collapse; font-size: ${isA5 ? '10px' : '15px'}; margin-bottom: ${isA5 ? '12px' : '20px'}; }
          .totals-table td { padding: ${isA5 ? '4px 6px' : '7px 8px'}; }
          .grand-total-row td { font-size: ${isA5 ? '13px' : '20px'}; font-weight: 800; color: #2563eb; border-top: 2px solid #2563eb; padding-top: ${isA5 ? '6px' : '10px'}; }
          .footer-section { border-top: 1px solid #cbd5e1; padding-top: ${isA5 ? '10px' : '16px'}; display: flex; justify-content: space-between; align-items: flex-end; font-size: ${isA5 ? '8px' : '12px'}; color: #64748b; line-height: 1.6; }
          .sign-box { text-align: center; border-top: 1px dashed #94a3b8; width: ${isA5 ? '130px' : '200px'}; padding-top: ${isA5 ? '5px' : '8px'}; font-weight: 700; color: #1e293b; }
        </style>
      </head>
      <body>
        <div class="receipt-box">
          <table class="header-table">
            <tr>
              <td>
                <div class="brand-title">GREENSOL OPTICALS</div>
                <div class="sub-brand">Super Speciality Eye Care & Optical ERP</div>
                <div style="font-size:12px; color:#64748b; margin-top:5px;">GSTIN: 32AAAAA0000A1Z5 | Reg: KMC-89421</div>
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
              <td class="info-label">Age / Gender:</td>
              <td>${patientAge || '—'} ${patientGender ? `/ ${patientGender}` : ''}</td>
              <td class="info-label">Address:</td>
              <td>${patientAddress || '—'}</td>
            </tr>
            <tr>
              <td class="info-label">Optometrist:</td>
              <td>${doctorName}</td>
              <td class="info-label">Payment Status:</td>
              <td><strong style="color:#059669;">PAID (${payMethod})</strong></td>
            </tr>
            ${(diagnosis || icdCode) ? `
            <tr>
              <td class="info-label">Diagnosis:</td>
              <td>${diagnosis || '—'}</td>
              <td class="info-label">ICD Code:</td>
              <td>${icdCode || '—'}</td>
            </tr>` : ''}
          </table>

          <table class="items-table">
            <thead>
              <tr>
                <th style="width:32%;">Product / Service Description</th>
                <th style="width:15%;">Brand</th>
                <th style="width:10%; text-align:center;">Qty</th>
                <th style="width:15%; text-align:right;">Rate (₹)</th>
                <th style="width:10%; text-align:right;">Tax</th>
                <th style="width:18%; text-align:right;">Amount (₹)</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(it => `
                <tr>
                  <td><strong>${it.name || it.item || it.product || 'Optical Product'}</strong></td>
                  <td>${it.brand || '—'}</td>
                  <td style="text-align:center;">${it.qty || 1}</td>
                  <td style="text-align:right;">₹${parseFloat(it.price || grandTotal).toFixed(2)}</td>
                  <td style="text-align:right;">${it.taxPercent !== undefined ? `${it.taxPercent}%` : '—'}</td>
                  <td style="text-align:right;"><strong>₹${parseFloat(it.total !== undefined ? it.total : (parseFloat(it.price || grandTotal) * (it.qty || 1))).toFixed(2)}</strong></td>
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
              <td>${hasRealTax ? 'GST (as per item tax rates):' : 'GST Tax (18%):'}</td>
              <td style="text-align:right; font-weight:bold;">₹${gstAmount.toFixed(2)}</td>
            </tr>
            <tr class="grand-total-row">
              <td>Net Amount:</td>
              <td style="text-align:right;">₹${grandTotal.toFixed(2)}</td>
            </tr>
          </table>

          ${paymentRows.length > 0 ? `
          <table class="totals-table" style="margin-top:-8px;">
            ${paymentRows.map(([label, val]) => `
              <tr><td>Paid via ${label}:</td><td style="text-align:right;">₹${parseFloat(val).toFixed(2)}</td></tr>
            `).join('')}
          </table>` : ''}

          <div class="footer-section">
            <div>
              <strong>Warranty & Terms:</strong><br/>
              1. 1-Year replacement warranty on spectacle frames against manufacturing defects.<br/>
              2. Please bring this invoice for free alignment & ultrasonic lens cleaning.
            </div>
            <div class="sign-box">
              Authorized Signature<br/>
              <span style="font-size:11px; font-weight:normal; color:#64748b;">Greensol Optical ERP</span>
            </div>
          </div>
        </div>
      </body>
    </html>
  `;
}

// Thermal rolls (typically 80mm wide) have no fixed page height — @page uses `auto` height so
// the printer just cuts after the content ends, and the whole layout is a single narrow column
// (the standard receipt's side-by-side info-table simply doesn't fit 80mm).
function buildThermalReceiptHtml({ invNo, invDate, patientName, patientPhone, patientAge, patientGender, diagnosis, icdCode, doctorName, payMethod, items, grandTotal, gstAmount, subtotal, paymentRows }) {
  const line = () => '<div class="dashed"></div>';
  const row = (label, value) => `<div class="row"><span>${label}</span><span>${value}</span></div>`;

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Receipt - ${invNo}</title>
        <style>
          @page { size: 80mm auto; margin: 3mm; }
          * { box-sizing: border-box; }
          body { font-family: 'Courier New', monospace; color: #000; margin: 0; padding: 0; width: 74mm; font-size: 11px; }
          .center { text-align: center; }
          .brand-title { font-size: 15px; font-weight: 800; }
          .sub-brand { font-size: 9px; }
          .dashed { border-top: 1px dashed #000; margin: 5px 0; }
          .row { display: flex; justify-content: space-between; gap: 6px; padding: 1px 0; }
          .row span:first-child { flex-shrink: 0; }
          .row span:last-child { text-align: right; word-break: break-word; }
          .bold { font-weight: 800; }
          table.items { width: 100%; border-collapse: collapse; font-size: 10px; margin: 4px 0; }
          table.items th { text-align: left; border-bottom: 1px dashed #000; padding: 2px 0; font-size: 10px; }
          table.items td { padding: 2px 0; vertical-align: top; }
          .grand-total { font-size: 14px; font-weight: 800; }
          .footer { font-size: 9px; text-align: center; margin-top: 6px; }
        </style>
      </head>
      <body>
        <div class="center">
          <div class="brand-title">GREENSOL OPTICALS</div>
          <div class="sub-brand">Super Speciality Eye Care & Optical ERP</div>
          <div class="sub-brand">Greensol Vision Hospital Complex, Medical College Road</div>
          <div class="sub-brand">Phone: +91 98470 12345</div>
          <div class="sub-brand">GSTIN: 32AAAAA0000A1Z5 | Reg: KMC-89421</div>
        </div>
        ${line()}
        <div class="center bold">TAX INVOICE / RECEIPT</div>
        ${line()}
        ${row('Invoice No:', invNo)}
        ${row('Date:', invDate)}
        ${row('Patient:', patientName)}
        ${row('Phone:', patientPhone)}
        ${patientAge || patientGender ? row('Age/Gender:', `${patientAge || '—'} ${patientGender || ''}`) : ''}
        ${row('Optometrist:', doctorName)}
        ${diagnosis ? row('Diagnosis:', diagnosis) : ''}
        ${icdCode ? row('ICD Code:', icdCode) : ''}
        ${line()}
        <table class="items">
          <thead>
            <tr><th>Item</th><th style="text-align:center;">Qty</th><th style="text-align:right;">Amt</th></tr>
          </thead>
          <tbody>
            ${items.map(it => `
              <tr>
                <td>${it.name || it.item || it.product || 'Optical Product'}${it.brand ? ` (${it.brand})` : ''}</td>
                <td style="text-align:center;">${it.qty || 1}</td>
                <td style="text-align:right;">${parseFloat(it.total !== undefined ? it.total : (parseFloat(it.price || grandTotal) * (it.qty || 1))).toFixed(2)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
        ${line()}
        ${row('Subtotal:', `₹${subtotal.toFixed(2)}`)}
        ${row('GST:', `₹${gstAmount.toFixed(2)}`)}
        <div class="dashed"></div>
        <div class="row grand-total"><span>NET TOTAL:</span><span>₹${grandTotal.toFixed(2)}</span></div>
        ${row('Payment:', payMethod)}
        ${paymentRows.length > 0 ? line() + paymentRows.map(([label, val]) => row(`${label}:`, `₹${parseFloat(val).toFixed(2)}`)).join('') : ''}
        ${line()}
        <div class="footer">
          1-Year warranty on frames against manufacturing defects.<br/>
          Thank you for choosing Greensol Opticals!<br/>
          Greensol Optical ERP
        </div>
      </body>
    </html>
  `;
}

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
