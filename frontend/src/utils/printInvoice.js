// Thin compatibility layer over the Bill Rendering Engine (frontend/src/billing).
//
// These two exports keep their original names and signatures so every existing call site
// (PrintInvoiceModal, OrdersManagerView, SalesDashboardView, SingleScreenEyeTestForm, …)
// keeps working unchanged — but the actual layout now comes from the template assigned to
// the document type in Settings → Bill & Invoice Designer.
import { printBill } from '../billing/printBill';

// paperSize: omitted / 'AUTO' = the template assigned to the document type in the designer;
// 'A4' | 'A5' | 'Thermal' = an explicit paper choice (PrintInvoiceModal's toggle).
export const printSalesInvoiceReceipt = (invoice, paperSize, documentType = 'SALES_INVOICE') => {
  if (!invoice) return;
  printBill({ doc: invoice, documentType, paperOverride: paperSize });
};

export const downloadPdfInvoice = (invoice, documentType = 'SALES_INVOICE') => {
  if (!invoice) return;
  // Same flow with the assigned template — the browser's print dialog offers "Save as PDF"
  // and suggests the document number as the file name (the print window's <title>).
  printBill({ doc: invoice, documentType });
};

export default printSalesInvoiceReceipt;
