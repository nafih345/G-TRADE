import React, { useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Box, Typography, Button, Stack, ToggleButtonGroup, ToggleButton,
} from '@mui/material';
import { Print as PrintIcon, Close as CloseIcon, WhatsApp as WhatsAppIcon, PictureAsPdf as PdfIcon } from '@mui/icons-material';
import { printSalesInvoiceReceipt, downloadPdfInvoice } from '../../utils/printInvoice';
import { sendInvoiceWhatsApp } from '../../utils/whatsappInvoice';
import BillPreview from '../../billing/BillPreview';

// The layout is now driven by the template assigned to SALES_INVOICE in
// Settings → Bill & Invoice Designer. This modal just previews it and triggers print.
export default function PrintInvoiceModal({ open, onClose, invoice, documentType = 'SALES_INVOICE' }) {
  const [paperSize, setPaperSize] = useState('A4');

  if (!invoice) return null;

  const handleTriggerPrint = () => printSalesInvoiceReceipt(invoice, paperSize, documentType);

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
      <DialogTitle sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', bgcolor: '#0f172a', color: '#fff', py: 1.5, flexWrap: 'wrap', gap: 1 }}>
        <Typography variant="h6" fontWeight={800}>Tax Invoice & Sales Receipt</Typography>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <ToggleButtonGroup
            size="small" exclusive value={paperSize}
            onChange={(e, val) => val && setPaperSize(val)}
            sx={{ bgcolor: '#fff', borderRadius: 1.5, mr: 0.5 }}
          >
            <ToggleButton value="A4" sx={{ textTransform: 'none', fontWeight: 800, px: 1.5, py: 0.3 }}>A4</ToggleButton>
            <ToggleButton value="A5" sx={{ textTransform: 'none', fontWeight: 800, px: 1.5, py: 0.3 }}>A5</ToggleButton>
            <ToggleButton value="Thermal" sx={{ textTransform: 'none', fontWeight: 800, px: 1.5, py: 0.3 }}>Thermal</ToggleButton>
          </ToggleButtonGroup>
          <Button variant="contained" color="error" startIcon={<PdfIcon />} onClick={() => downloadPdfInvoice(invoice, documentType)} sx={{ fontWeight: 800 }}>
            Save PDF
          </Button>
          <Button variant="contained" color="success" startIcon={<WhatsAppIcon />} onClick={() => sendInvoiceWhatsApp(invoice)} sx={{ fontWeight: 800 }}>
            WhatsApp Rx
          </Button>
          <Button variant="contained" color="primary" startIcon={<PrintIcon />} onClick={handleTriggerPrint} sx={{ fontWeight: 800 }}>
            Print {paperSize}
          </Button>
          <Button color="inherit" onClick={onClose}><CloseIcon /></Button>
        </Stack>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 3, bgcolor: '#eef2f7' }}>
        <BillPreview doc={invoice} documentType={documentType} paperOverride={paperSize} maxWidth={720} />
      </DialogContent>

      <DialogActions sx={{ p: 2, bgcolor: '#f8fafc', gap: 1 }}>
        <Button onClick={onClose} color="inherit">Close</Button>
        <Button variant="contained" color="error" startIcon={<PdfIcon />} onClick={() => downloadPdfInvoice(invoice, documentType)} sx={{ fontWeight: 800 }}>
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
