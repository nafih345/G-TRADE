export const printPurchaseReceipt = (invoice) => {
  if (!invoice) return;

  const invNo = invoice.invoice_number || invoice.invoiceNumber || `PINV-${Math.floor(10000 + Math.random() * 90000)}`;
  const invDate = invoice.purchase_date || invoice.date || new Date().toISOString().split('T')[0];
  const supplierName = invoice.supplierName || invoice.supplier_name || 'Supplier';
  const supplierInvNo = invoice.supplier_invoice_number || 'N/A';
  const payMethod = invoice.payment_method || invoice.paymentMethod || 'Cash';
  const status = invoice.status || 'CONFIRMED';

  const items = invoice.items && invoice.items.length > 0 ? invoice.items : [];

  const gross = parseFloat(invoice.gross_amount || 0);
  const discount = parseFloat(invoice.discount_amount || 0);
  const tax = parseFloat(invoice.tax_amount || 0);
  const otherCharges = parseFloat(invoice.other_charges || 0);
  const roundOff = parseFloat(invoice.round_off || 0);
  const grandTotal = parseFloat(invoice.grand_total || 0);
  const paidAmount = parseFloat(invoice.paid_amount || 0);
  const balanceAmount = parseFloat(invoice.balance_amount || 0);

  const printWindow = window.open('', '_blank', 'width=900,height=800');

  const htmlContent = `
    <!DOCTYPE html>
    <html>
      <head>
        <title>Purchase Entry - ${invNo}</title>
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
          .items-table { width: 100%; border-collapse: collapse; margin-bottom: 20px; font-size: 11px; }
          .items-table th { background: #0f172a; color: #fff; padding: 6px 8px; text-align: left; font-weight: 700; }
          .items-table td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
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
                Phone: +91 98470 12345 | Email: purchase@greensoloptical.com
              </td>
            </tr>
          </table>

          <div class="invoice-banner">Purchase Entry / Goods Receipt Note</div>

          <table class="info-table">
            <tr>
              <td class="info-label">Purchase Invoice No:</td>
              <td><strong>${invNo}</strong></td>
              <td class="info-label">Purchase Date:</td>
              <td>${invDate}</td>
            </tr>
            <tr>
              <td class="info-label">Supplier:</td>
              <td><strong>${supplierName}</strong></td>
              <td class="info-label">Supplier Invoice No:</td>
              <td>${supplierInvNo}</td>
            </tr>
            <tr>
              <td class="info-label">Payment Mode:</td>
              <td>${payMethod}</td>
              <td class="info-label">Status:</td>
              <td><strong style="color:#059669;">${status}</strong></td>
            </tr>
          </table>

          <table class="items-table">
            <thead>
              <tr>
                <th style="width:26%;">Product</th>
                <th>Batch</th>
                <th>Expiry</th>
                <th style="text-align:center;">Qty</th>
                <th style="text-align:center;">Free</th>
                <th style="text-align:right;">Rate</th>
                <th style="text-align:right;">Disc</th>
                <th style="text-align:right;">GST</th>
                <th style="text-align:right;">Total</th>
              </tr>
            </thead>
            <tbody>
              ${items.map(it => `
                <tr>
                  <td><strong>${it.productName || it.product_name || 'Item'}</strong></td>
                  <td>${it.batch_number || '-'}</td>
                  <td>${it.expiry_date || '-'}</td>
                  <td style="text-align:center;">${it.quantity || 0}</td>
                  <td style="text-align:center;">${it.free_quantity || 0}</td>
                  <td style="text-align:right;">₹${parseFloat(it.purchase_rate || 0).toFixed(2)}</td>
                  <td style="text-align:right;">${it.discount_percent || 0}%</td>
                  <td style="text-align:right;">${it.gst_percent || 0}%</td>
                  <td style="text-align:right;"><strong>₹${parseFloat(it.line_total || 0).toFixed(2)}</strong></td>
                </tr>
              `).join('')}
            </tbody>
          </table>

          <table class="totals-table">
            <tr>
              <td>Gross Amount:</td>
              <td style="text-align:right; font-weight:bold;">₹${gross.toFixed(2)}</td>
            </tr>
            <tr>
              <td>Discount:</td>
              <td style="text-align:right; font-weight:bold;">₹${discount.toFixed(2)}</td>
            </tr>
            <tr>
              <td>GST / Tax:</td>
              <td style="text-align:right; font-weight:bold;">₹${tax.toFixed(2)}</td>
            </tr>
            <tr>
              <td>Other Charges:</td>
              <td style="text-align:right; font-weight:bold;">₹${otherCharges.toFixed(2)}</td>
            </tr>
            <tr>
              <td>Round Off:</td>
              <td style="text-align:right; font-weight:bold;">₹${roundOff.toFixed(2)}</td>
            </tr>
            <tr class="grand-total-row">
              <td>Grand Total:</td>
              <td style="text-align:right;">₹${grandTotal.toFixed(2)}</td>
            </tr>
            <tr>
              <td>Paid Amount:</td>
              <td style="text-align:right; font-weight:bold; color:#059669;">₹${paidAmount.toFixed(2)}</td>
            </tr>
            <tr>
              <td>Balance Due:</td>
              <td style="text-align:right; font-weight:bold; color:#dc2626;">₹${balanceAmount.toFixed(2)}</td>
            </tr>
          </table>

          <div class="footer-section">
            <div>
              <strong>Notes:</strong><br/>
              ${invoice.notes || 'Goods received in good condition & verified against invoice.'}
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

export default printPurchaseReceipt;
