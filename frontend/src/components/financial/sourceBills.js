// Ledger "Show Bill": which document a posted journal came from, and how to load it for the
// Bill Rendering Engine. Keyed by the journal's source key (source_module.source_event); the
// journal's reference_id is the document's id. Read-only GETs against the existing endpoints.
import axios from 'axios';
import { wholesaleCollectionDoc, wholesaleInvoiceDoc, wholesaleReturnDoc } from '../../billing/realDocuments';

const get = async (url) => (await axios.get(url)).data;

// Only an INVOICE posts to the ledger, but a converted order keeps its id, so print what it is now.
const SALES_DOC_TYPES = { INVOICE: 'SALES_INVOICE', ORDER: 'ORDER_BILL', QUOTATION: 'QUOTATION' };

const SOURCE_BILLS = {
  'sales.invoice': {
    label: 'Sales invoice',
    load: async (id) => {
      const doc = await get(`/api/sales/invoices/${id}/`);
      return { doc, documentType: SALES_DOC_TYPES[String(doc.document_type || 'INVOICE').toUpperCase()] || 'SALES_INVOICE' };
    },
  },
  'sales.payment': {
    label: 'Payment receipt',
    load: async (id) => {
      const p = await get(`/api/sales/payments/${id}/`);
      const inv = p.invoice ? await get(`/api/sales/invoices/${p.invoice}/`).catch(() => null) : null;
      return { doc: { ...p, invoice_number: inv?.invoice_number || '' }, documentType: 'PAYMENT_RECEIPT' };
    },
  },
  'sales.wholesale_invoice': {
    label: 'Wholesale invoice',
    load: async (id) => ({ doc: wholesaleInvoiceDoc(await get(`/api/sales/wholesale/invoices/${id}/`)), documentType: 'WHOLESALE_BILL' }),
  },
  'sales.wholesale_collection': {
    label: 'Collection receipt',
    load: async (id) => ({ doc: wholesaleCollectionDoc(await get(`/api/sales/wholesale/collections/${id}/`)), documentType: 'PAYMENT_RECEIPT' }),
  },
  'sales.wholesale_return': {
    label: 'Credit note',
    load: async (id) => ({ doc: wholesaleReturnDoc(await get(`/api/sales/wholesale/returns/${id}/`)), documentType: 'SALES_RETURN' }),
  },
  'purchasing.purchase_invoice': {
    label: 'Purchase bill',
    load: async (id) => ({ doc: await get(`/api/purchase/invoices/${id}/`), documentType: 'PURCHASE_BILL' }),
  },
  // The payment side of a cash purchase entry: reference_id is the same purchase invoice.
  'purchasing.purchase_payment': {
    label: 'Purchase bill',
    load: async (id) => ({ doc: await get(`/api/purchase/invoices/${id}/`), documentType: 'PURCHASE_BILL' }),
  },
  'purchasing.purchase_order': {
    label: 'Purchase order',
    load: async (id) => {
      const po = await get(`/api/purchase/orders/${id}/`);
      const supplier = po.supplier ? await get(`/api/purchase/suppliers/${po.supplier}/`).catch(() => null) : null;
      return {
        doc: {
          ...po, invoice_number: po.order_number, purchase_date: po.order_date,
          supplier_name: supplier?.name || '', grand_total: po.net_amount, __title: 'PURCHASE ORDER',
        },
        documentType: 'PURCHASE_BILL',
      };
    },
  },
};

export const sourceKeyOf = (row) => (row?.source_module ? `${row.source_module}.${row.source_event}` : '');

/** The bill definition for a ledger row, or null when the entry has no printable document
 *  (manual voucher, opening balance, stock adjustment, legacy entry). */
export function billSourceFor(row) {
  if (!row?.reference_id) return null;
  return SOURCE_BILLS[sourceKeyOf(row)] || null;
}

export async function loadSourceBill(row) {
  const src = billSourceFor(row);
  if (!src) return null;
  return src.load(row.reference_id);
}
