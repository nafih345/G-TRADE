import React, { useRef } from 'react';
import { 
  Dialog, DialogTitle, DialogContent, DialogActions, 
  Box, Typography, Grid, Table, TableBody, TableCell, 
  TableContainer, TableHead, TableRow, Paper, Button, 
  Divider, Stack, Chip 
} from '@mui/material';
import { Print as PrintIcon, Close as CloseIcon, WhatsApp as WhatsAppIcon, PictureAsPdf as PdfIcon } from '@mui/icons-material';
import { printSalesInvoiceReceipt, downloadPdfInvoice } from '../../utils/printInvoice';
import { sendInvoiceWhatsApp } from '../../utils/whatsappInvoice';

export default function PrintInvoiceModal({ open, onClose, invoice }) {
  if (!invoice) return null;

  const handleTriggerPrint = () => {
    printSalesInvoiceReceipt(invoice);
  };

  const invNo = invoice.invoiceNumber || invoice.id || 'INV-10029';
  const invDate = invoice.date || invoice.invoice_date || new Date().toISOString().split('T')[0];
  const patientName = invoice.customerName || invoice.patientName || invoice.customer_name || 'Walk-in Customer';
  const patientPhone = invoice.phone || invoice.customer_phone || 'N/A';
  const doctorName = invoice.doctor || invoice.optometrist || 'Attending Optometrist';
  const payMethod = invoice.paymentMethod || invoice.method || 'Cash / UPI';
  const items = invoice.items || [
    { name: invoice.item || invoice.frame || 'Spectacle Frame & Prescription Lens', qty: 1, price: invoice.total || invoice.net_amount || 0 }
  ];

  const subtotal = parseFloat(invoice.total || invoice.net_amount || 0);
  const tax = subtotal * 0.18;
  const grandTotal = subtotal;

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
      <DialogTitle className="no-print" sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', bgcolor: '#0f172a', color: '#fff', py: 1.5 }}>
        <Typography variant="h6" fontWeight={800}>Tax Invoice & Sales Receipt</Typography>
        <Stack direction="row" spacing={1}>
          <Button variant="contained" color="error" startIcon={<PdfIcon />} onClick={() => downloadPdfInvoice(invoice)} sx={{ fontWeight: 800 }}>
            Save PDF
          </Button>
          <Button variant="contained" color="success" startIcon={<WhatsAppIcon />} onClick={() => sendInvoiceWhatsApp(invoice)} sx={{ fontWeight: 800 }}>
            WhatsApp Rx
          </Button>
          <Button variant="contained" color="primary" startIcon={<PrintIcon />} onClick={handleTriggerPrint} sx={{ fontWeight: 800 }}>
            Print Invoice
          </Button>
          <Button color="inherit" onClick={onClose}>
            <CloseIcon />
          </Button>
        </Stack>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 4 }}>
        {/* Printable Section Wrapper */}
        <div id="sales-invoice-print-area">
          <div className="print-container">
            {/* Header */}
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

            {/* Metadata Grid */}
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
                <td className="meta-label">Optometrist:</td>
                <td>{doctorName}</td>
                <td className="meta-label">Payment Status:</td>
                <td><strong style={{ color: '#059669' }}>PAID ({payMethod})</strong></td>
              </tr>
            </table>

            {/* Items Table */}
            <table className="items-table">
              <thead>
                <tr>
                  <th style={{ width: '45%' }}>Item Description & Specification</th>
                  <th style={{ width: '15%', textAlign: 'center' }}>Qty</th>
                  <th style={{ width: '20%', textAlign: 'right' }}>Unit Rate (₹)</th>
                  <th style={{ width: '20%', fontStyle: 'bold', textAlign: 'right' }}>Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {items.map((it, i) => (
                  <tr key={i}>
                    <td><strong>{it.name || it.product}</strong></td>
                    <td style={{ textAlign: 'center' }}>{it.qty || 1}</td>
                    <td style={{ textAlign: 'right' }}>₹{parseFloat(it.price || it.unit_price || grandTotal).toFixed(2)}</td>
                    <td style={{ textAlign: 'right' }}><strong>₹{(parseFloat(it.price || it.unit_price || grandTotal) * (it.qty || 1)).toFixed(2)}</strong></td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* Totals Breakdown */}
            <table className="totals-table">
              <tr>
                <td>Subtotal Amount:</td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>₹{(grandTotal / 1.18).toFixed(2)}</td>
              </tr>
              <tr>
                <td>Integrated GST (18%):</td>
                <td style={{ textAlign: 'right', fontWeight: 'bold' }}>₹{(grandTotal - (grandTotal / 1.18)).toFixed(2)}</td>
              </tr>
              <tr>
                <td className="grand-total">Total Net Payable:</td>
                <td className="grand-total" style={{ textAlign: 'right' }}>₹{grandTotal.toFixed(2)}</td>
              </tr>
            </table>

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
          Print Invoice
        </Button>
      </DialogActions>
    </Dialog>
  );
}
