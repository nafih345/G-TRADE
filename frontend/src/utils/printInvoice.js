// Thin compatibility layer over the Bill Rendering Engine (frontend/src/billing).
//
// These two exports keep their original names and signatures so every existing call site
// (PrintInvoiceModal, OrdersManagerView, SalesDashboardView, SingleScreenEyeTestForm, …)
// keeps working unchanged — but the actual layout now comes from the template assigned to
// the document type in Settings → Bill & Invoice Designer.
import { printBill } from '../billing/printBill';

// paperSize: 'A4' | 'A5' | 'Thermal'  (legacy toggle from PrintInvoiceModal)
export const printSalesInvoiceReceipt = (invoice, paperSize = 'A4', documentType = 'SALES_INVOICE') => {
  if (!invoice) return;
  printBill({ doc: invoice, documentType, paperOverride: paperSize });
};

export const downloadPdfInvoice = (invoice, documentType = 'SALES_INVOICE') => {
  if (!invoice) return;
  // Same flow — the browser's print dialog offers "Save as PDF".
  printBill({ doc: invoice, documentType, paperOverride: 'A4' });
};

export default printSalesInvoiceReceipt;
