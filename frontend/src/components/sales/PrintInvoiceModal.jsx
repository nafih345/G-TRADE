import React, { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Box, Typography, Grid, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Paper, Button,
  Divider, Stack, Chip, ToggleButtonGroup, ToggleButton
} from '@mui/material';
import { Print as PrintIcon, Close as CloseIcon, WhatsApp as WhatsAppIcon, PictureAsPdf as PdfIcon } from '@mui/icons-material';
import { printSalesInvoiceReceipt, downloadPdfInvoice } from '../../utils/printInvoice';
import { sendInvoiceWhatsApp } from '../../utils/whatsappInvoice';

export default function PrintInvoiceModal({ open, onClose, invoice }) {
  const [paperSize, setPaperSize] = useState('A4');

  if (!invoice) return null;

  const handleTriggerPrint = () => {
    printSalesInvoiceReceipt(invoice, paperSize);
  };

  const invNo = invoice.invoiceNumber || invoice.id || 'INV-10029';
  const invDate = invoice.date || invoice.invoice_date || new Date().toISOString().split('T')[0];
  const patientName = invoice.customerName || invoice.patientName || invoice.customer_name || invoice.customer || 'Walk-in Customer';
  const patientPhone = invoice.phone || invoice.customer_phone || 'N/A';
  const patientAge = invoice.customerAge || invoice.age || '';
  const patientGender = invoice.customerGender || invoice.gender || '';
  const patientAddress = invoice.customerAddress || invoice.address || '';
  const diagnosis = invoice.diagnosis || invoice.rxData?.notes || '';
  const icdCode = invoice.icdCode || '';
  const doctorName = invoice.doctor || invoice.optometrist || invoice.salesman || 'Attending Optometrist';
  const payMethod = invoice.paymentMethod || invoice.method || invoice.paymentMode || 'Cash / UPI';
  const items = invoice.items && invoice.items.length > 0 ? invoice.items : [
    { name: invoice.item || invoice.frame || 'Spectacle Frame & Prescription Lens', qty: 1, price: invoice.total || invoice.net_amount || 0 }
  ];

  const grandTotal = parseFloat(invoice.netTotal || invoice.total || invoice.net_amount || 0);
  // Real per-item tax total when available (NewSaleWizard invoices carry this); otherwise fall
  // back to treating the total as already-inclusive-of-18%-GST for older/summary invoice shapes.
  const hasRealTax = invoice.totalTax !== undefined && invoice.totalTax !== null;
  const tax = hasRealTax ? parseFloat(invoice.totalTax) : grandTotal - (grandTotal / 1.18);
  const subtotal = hasRealTax ? grandTotal - tax : grandTotal / 1.18;

  const multiPay = invoice.multiPay;
  // Coerced to a real boolean: parseFloat('') is NaN, and `multiPay && NaN` evaluates to NaN
  // (not false) — React renders a falsy *number* left operand as literal text ("NaN") instead
  // of rendering nothing, unlike false/null/undefined.
  const hasPaymentBreakdown = !!(multiPay && (
    parseFloat(multiPay.cash) || parseFloat(multiPay.cards) || parseFloat(multiPay.gpay) || parseFloat(multiPay.bank)
  ));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
      <DialogTitle className="no-print" sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', bgcolor: '#0f172a', color: '#fff', py: 1.5, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h6" fontWeight={800}>Tax Invoice & Sales Receipt</Typography>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <ToggleButtonGroup
            size="small"
            exclusive
            value={paperSize}
            onChange={(e, val) => val && setPaperSize(val)}
            sx={{ bgcolor: '#fff', borderRadius: 1.5, mr: 0.5 }}
          >
            <ToggleButton value="A4" sx={{ textTransform: 'none', fontWeight: 800, px: 1.5, py: 0.3 }}>A4</ToggleButton>
            <ToggleButton value="A5" sx={{ textTransform: 'none', fontWeight: 800, px: 1.5, py: 0.3 }}>A5</ToggleButton>
            <ToggleButton value="Thermal" sx={{ textTransform: 'none', fontWeight: 800, px: 1.5, py: 0.3 }}>Thermal</ToggleButton>
          </ToggleButtonGroup>
          <Button variant="contained" color="error" startIcon={<PdfIcon />} onClick={() => downloadPdfInvoice(invoice)} sx={{ fontWeight: 800 }}>
            Save PDF
          </Button>
          <Button variant="contained" color="success" startIcon={<WhatsAppIcon />} onClick={() => sendInvoiceWhatsApp(invoice)} sx={{ fontWeight: 800 }}>
            WhatsApp Rx
          </Button>
          <Button variant="contained" color="primary" startIcon={<PrintIcon />} onClick={handleTriggerPrint} sx={{ fontWeight: 800 }}>
            Print {paperSize}
          </Button>
          <Button color="inherit" onClick={onClose}>
            <CloseIcon />
          </Button>
        </Stack>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 4 }}>
        {/* This preview's class names (header-table, meta-grid, items-table, ...) had no CSS
            definitions anywhere in the app — the ACTUAL printed output (opened in a new window
            via printSalesInvoiceReceipt) carries its own embedded stylesheet and looked fine,
            but this on-screen preview rendered as bare, unstyled HTML tables. Scoped styles here
            make the preview match what actually prints. */}
        <style>{`
          #sales-invoice-print-area { font-family: 'Segoe UI', Arial, sans-serif; color: #0f172a; }
          #sales-invoice-print-area .header-table { width: 100%; border-collapse: collapse; border-bottom: 3px solid #2563eb; padding-bottom: 15px; margin-bottom: 15px; }
          #sales-invoice-print-area .logo-text { font-size: 28px; font-weight: 800; color: #2563eb; letter-spacing: 0.5px; }
          #sales-invoice-print-area .sub-logo { font-size: 12px; color: #64748b; font-weight: 700; text-transform: uppercase; margin-top: 3px; }
          #sales-invoice-print-area .company-info { text-align: right; font-size: 12px; color: #475569; line-height: 1.6; }
          #sales-invoice-print-area .bill-title { background: #f1f5f9; text-align: center; padding: 10px; font-weight: 800; font-size: 17px; color: #1e293b; letter-spacing: 1px; border-radius: 6px; margin: 15px 0; text-transform: uppercase; }
          #sales-invoice-print-area .meta-grid { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 13px; }
          #sales-invoice-print-area .meta-grid td { padding: 8px 12px; border: 1px solid #e2e8f0; }
          #sales-invoice-print-area .meta-label { font-weight: 700; color: #475569; background: #f8fafc; width: 18%; white-space: nowrap; }
          #sales-invoice-print-area .items-table { width: 100%; border-collapse: collapse; margin-bottom: 18px; font-size: 13px; }
          #sales-invoice-print-area .items-table th { background: #0f172a; color: #fff; padding: 10px 12px; text-align: left; font-weight: 700; font-size: 12px; }
          #sales-invoice-print-area .items-table td { padding: 10px 12px; border-bottom: 1px solid #e2e8f0; }
          #sales-invoice-print-area .totals-table { width: 380px; margin-left: auto; border-collapse: collapse; font-size: 14px; margin-bottom: 15px; }
          #sales-invoice-print-area .totals-table td { padding: 6px 8px; }
          #sales-invoice-print-area .grand-total { font-size: 18px; font-weight: 800; color: #2563eb; border-top: 2px solid #2563eb; padding-top: 8px; }
          #sales-invoice-print-area .footer-notes { border-top: 1px solid #cbd5e1; padding-top: 14px; margin-top: 10px; display: flex; justify-content: space-between; align-items: flex-end; font-size: 11px; color: #64748b; line-height: 1.6; gap: 16px; }
          #sales-invoice-print-area .sign-box { text-align: center; border-top: 1px dashed #94a3b8; width: 180px; padding-top: 6px; font-weight: 700; color: #1e293b; flex-shrink: 0; }
        `}</style>
        {/* Printable Section Wrapper */}
        <div id="sales-invoice-print-area">
          <div className="print-container">
            {/* Header — hospital / clinic details */}
            <table className="header-table">
              <tr>
                <td style={{ verticalAlign: 'top' }}>
                  <div className="logo-text">GREENSOL OPTICALS</div>
                  <div className="sub-logo">Super Speciality Eye Care & Optical ERP</div>
                  <div style={{ fontSize: '11px', color: '#475569', marginTop: '4px' }}>
                    GSTIN: 32AAAAA0000A1Z5 | Reg. No: KMC-89421
                  </div>
                </td>
                <td className="company-info" style={{ verticalAlign: 'top' }}>
                  <strong>Main Branch Headquarters</strong><br />
                  Greensol Vision Hospital Complex, Medical College Road<br />
                  Phone: +91 98470 12345 | Email: sales@greensoloptical.com<br />
                  Web: www.greensoloptical.com
                </td>
              </tr>
            </table>

            <div className="bill-title">TAX INVOICE & RETAIL RECEIPT</div>

            {/* Metadata Grid — invoice + full patient details */}
            <table className="meta-grid">
              <tr>
                <td className="meta-label">Invoice No:</td>
                <td><strong>{invNo}</strong></td>
                <td className="meta-label">Invoice Date:</td>
                <td>{invDate}</td>
              </tr>
              <tr>
                <td className="meta-label">Patient Name:</td>
                <td><strong>{patientName}</strong></td>
                <td className="meta-label">Contact Phone:</td>
                <td>{patientPhone}</td>
              </tr>
              <tr>
                <td className="meta-label">Age / Gender:</td>
                <td>{patientAge || '—'} {patientGender ? `/ ${patientGender}` : ''}</td>
                <td className="meta-label">Address:</td>
                <td>{patientAddress || '—'}</td>
              </tr>
              <tr>
                <td className="meta-label">Optometrist:</td>
                <td>{doctorName}</td>
                <td className="meta-label">Payment Status:</td>
                <td><strong style={{ color: '#059669' }}>PAID ({payMethod})</strong></td>
              </tr>
              {(diagnosis || icdCode) && (
                <tr>
                  <td className="meta-label">Diagnosis:</td>
                  <td colSpan={icdCode ? 1 : 3}>{diagnosis || '—'}</td>
                  {icdCode && (<>
                    <td className="meta-label">ICD Code:</td>
                    <td>{icdCode}</td>
                  </>)}
                </tr>
              )}
            </table>

            {/* Items Table */}
            <table className="items-table">
              <thead>
                <tr>
                  <th style={{ width: '35%' }}>Item Description & Specification</th>
                  <th style={{ width: '15%' }}>Brand</th>
                  <th style={{ width: '10%', textAlign: 'center' }}>Qty</th>
                  <th style={{ width: '15%', textAlign: 'right' }}>Unit Rate (₹)</th>
                  <th style={{ width: '10%', textAlign: 'right' }}>Tax</th>
                  <th style={{ width: '15%', fontStyle: 'bold', textAlign: 'right' }}>Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td><strong>{it.name || it.item || it.product}</strong></td>
                    <td>{it.brand || '—'}</td>
                    <td style={{ textAlign: 'center' }}>{it.qty || 1}</td>
                    <td style={{ textAlign: 'right' }}>₹{parseFloat(it.price || it.unit_price || grandTotal).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}>{it.taxPercent !== undefined ? `${it.taxPercent}%` : '—'}</td>
                    <td style={{ textAlign: 'right' }}>
                      <strong>₹{parseFloat(it.total !== undefined ? it.total : (parseFloat(it.price || it.unit_price || grandTotal) * (it.qty || 1))).toFixed(2)}</strong>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals Breakdown */}
            <table className="totals-table">
              <tr>
                <td>Subtotal Amount:</td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>₹{subtotal.toFixed(2)}</td>
              </tr>
              <tr>
                <td>{hasRealTax ? 'GST (as per item tax rates):' : 'Integrated GST (18%):'}</td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>₹{tax.toFixed(2)}</td>
              </tr>
              <tr>
                <td className="grand-total">Total Net Payable:</td>
                <td className="grand-total" style={{ textAlign: 'right' }}>₹{grandTotal.toFixed(2)}</td>
              </tr>
            </table>

            {/* Payment Method Breakdown (when the sale was split across multiple modes) */}
            {hasPaymentBreakdown && (
              <table className="totals-table" style={{ marginTop: '6px' }}>
                {parseFloat(multiPay.cash) > 0 && (
                  <tr><td>Paid via Cash:</td><td style={{ textAlign: 'right' }}>₹{parseFloat(multiPay.cash).toFixed(2)}</td></tr>
                )}
                {parseFloat(multiPay.cards) > 0 && (
                  <tr><td>Paid via Card:</td><td style={{ textAlign: 'right' }}>₹{parseFloat(multiPay.cards).toFixed(2)}</td></tr>
                )}
                {parseFloat(multiPay.gpay) > 0 && (
                  <tr><td>Paid via GPay/UPI:</td><td style={{ textAlign: 'right' }}>₹{parseFloat(multiPay.gpay).toFixed(2)}</td></tr>
                )}
                {parseFloat(multiPay.bank) > 0 && (
                  <tr><td>Paid via Bank Transfer:</td><td style={{ textAlign: 'right' }}>₹{parseFloat(multiPay.bank).toFixed(2)}</td></tr>
                )}
              </table>
            )}

            {/* Footer & Signature */}
            <div className="footer-notes">
              <div>
                <strong>Terms & Conditions:</strong><br />
                1. 1-Year replacement warranty on spectacle frames against manufacturing defects.<br />
                2. Goods once sold will not be accepted for return after 7 days.<br />
                3. Please present this invoice for lens cleaning and frame adjustments.
              </div>
              <div className="sign-box">
                Authorized Signatory<br />
                <span style={{ fontSize: '10px', color: '#64748b' }}>Greensol Optical ERP</span>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>

      <DialogActions className="no-print" sx={{ p: 2, bgcolor: '#f8fafc', gap: 1 }}>
        <Button onClick={onClose} color="inherit">Close</Button>
        <Button variant="contained" color="error" startIcon={<PdfIcon />} onClick={() => downloadPdfInvoice(invoice)} sx={{ fontWeight: 800 }}>
          Save PDF Invoice
        </Button>
        <Button variant="contained" color="success" startIcon={<WhatsAppIcon />} onClick={() => sendInvoiceWhatsApp(invoice)} sx={{ fontWeight: 800 }}>
          Send WhatsApp Receipt
        </Button>
        <Button variant="contained" color="primary" startIcon={<PrintIcon />} onClick={handleTriggerPrint} sx={{ fontWeight: 800, px: 4 }}>
          Print {paperSize}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
