import React, { useState, useEffect } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Box, Typography, Button, Stack, ToggleButtonGroup, ToggleButton, Paper, Chip,
} from '@mui/material';
import { Print as PrintIcon, Close as CloseIcon, WhatsApp as WhatsAppIcon, PictureAsPdf as PdfIcon } from '@mui/icons-material';
import { printSalesInvoiceReceipt, downloadPdfInvoice } from '../../utils/printInvoice';
import { sendInvoiceWhatsApp, buildInvoiceWhatsAppMessage } from '../../utils/whatsappInvoice';
import BillPreview from '../../billing/BillPreview';

// The layout is now driven by the template assigned to SALES_INVOICE in
// Settings → Bill & Invoice Designer. This modal just previews it and triggers print.
// When `showWhatsappPreview` is set, it also renders the exact WhatsApp receipt text that the
// "Send WhatsApp Receipt" button / the Alt+W shortcut will share.
export default function PrintInvoiceModal({ open, onClose, invoice, documentType = 'SALES_INVOICE', showWhatsappPreview = false }) {
  const [paperSize, setPaperSize] = useState('A4');

  // Alt + W shares the currently-previewed invoice on WhatsApp, matching the shortcut wired up
  // on the New Sale screen so it keeps working while this dialog is focused.
  useEffect(() => {
    if (!open || !invoice) return;
    const handleKey = (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if ((e.key || '').toLowerCase() !== 'w') return;
      e.preventDefault();
      sendInvoiceWhatsApp(invoice);
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [open, invoice]);

  if (!invoice) return null;

  const handleTriggerPrint = () => printSalesInvoiceReceipt(invoice, paperSize, documentType);
  const wa = showWhatsappPreview ? buildInvoiceWhatsAppMessage(invoice) : null;

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
        {wa && (
          <Paper variant="outlined" sx={{ mb: 2.5, borderRadius: 2, overflow: 'hidden', borderColor: '#25D366' }}>
            <Box sx={{ bgcolor: '#25D366', color: '#fff', px: 2, py: 1, display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 1 }}>
              <Stack direction="row" spacing={1} alignItems="center">
                <WhatsAppIcon fontSize="small" />
                <Typography variant="subtitle2" fontWeight={800}>WhatsApp Message Preview</Typography>
              </Stack>
              <Chip
                size="small"
                label={wa.cleanPhone ? `To: +${wa.cleanPhone}` : 'No saved number — pick a contact in WhatsApp'}
                sx={{ bgcolor: 'rgba(255,255,255,0.2)', color: '#fff', fontWeight: 700 }}
              />
            </Box>
            <Box sx={{ p: 2, bgcolor: '#f0f7f2' }}>
              <Typography
                component="pre"
                sx={{ m: 0, fontFamily: 'inherit', whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: '0.8rem', lineHeight: 1.55 }}
              >
                {wa.message}
              </Typography>
              <Button
                variant="contained" color="success" size="small" startIcon={<WhatsAppIcon />}
                onClick={() => sendInvoiceWhatsApp(invoice)}
                sx={{ mt: 1.5, fontWeight: 800, textTransform: 'none' }}
              >
                Share on WhatsApp (Alt + W)
              </Button>
            </Box>
          </Paper>
        )}
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
