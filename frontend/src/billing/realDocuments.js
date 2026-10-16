// Real transactions for the designer's "preview with a real document" mode and for reprints.
// Read-only: only GET requests to the existing ERP endpoints. Each loader returns rows of
// { id, number, date, party, amount, doc } where `doc` is the raw record the matching
// documentAdapters.toBillModel adapter understands.
import axios from 'axios';

const unwrap = (res) => {
  const d = res?.data;
  return Array.isArray(d) ? d : (d?.results || []);
};
const amt = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

function readLocal(key) {
  try { return JSON.parse(localStorage.getItem(key) || '[]'); } catch { return []; }
}

async function salesDocs(documentType, search) {
  const params = new URLSearchParams({ document_type: documentType });
  if (search) params.set('search', search);
  const rows = unwrap(await axios.get(`/api/sales/invoices/?${params}`));
  return rows.map((inv) => ({
    id: inv.id,
    number: inv.invoice_number,
    date: inv.invoice_date,
    party: inv.customer_name || '',
    amount: amt(inv.net_amount),
    doc: inv,
  }));
}

const LOADERS = {
  SALES_INVOICE: (q) => salesDocs('INVOICE', q),
  ORDER_BILL: (q) => salesDocs('ORDER', q),
  QUOTATION: (q) => salesDocs('QUOTATION', q),
  WHOLESALE_BILL: async () => {
    const rows = unwrap(await axios.get('/api/sales/wholesale/invoices/'));
    return rows.map((w) => {
      const d = w.details && Object.keys(w.details).length ? w.details : {};
      return {
        id: w.id,
        number: w.invoice_number,
        date: w.invoice_date,
        party: d.customer?.name || '',
        amount: amt(w.grand_total),
        // The POS record is the source of truth; the row's own columns fill any gap.
        doc: {
          invoiceNo: w.invoice_number, date: w.invoice_date, dueDate: w.due_date, orderRef: w.order_ref,
          amountReceived: w.paid_amount, dueAmount: w.due_amount, status: w.status,
          ...d,
          summary: { grandTotal: w.grand_total, ...(d.summary || {}) },
        },
      };
    });
  },
  PURCHASE_BILL: async (q) => {
    const rows = unwrap(await axios.get(`/api/purchase/invoices/${q ? `?search=${encodeURIComponent(q)}` : ''}`));
    return rows.map((p) => ({
      id: p.id, number: p.invoice_number, date: p.purchase_date, party: p.supplier_name || '', amount: amt(p.grand_total), doc: p,
    }));
  },
  PAYMENT_RECEIPT: async () => {
    const [retail, wholesale] = await Promise.all([
      axios.get('/api/sales/payments/').then(unwrap).catch(() => []),
      axios.get('/api/sales/wholesale/collections/').then(unwrap).catch(() => []),
    ]);
    return [
      ...retail.map((p) => ({ id: p.id, number: p.receipt_no || '', date: p.payment_date, party: p.customer_name || '', amount: amt(p.amount), doc: p })),
      ...wholesale.map((c) => ({
        id: c.id, number: c.receipt_number, date: c.payment_date, party: 'Wholesale dealer', amount: amt(c.amount_paid),
        doc: { ...c, invoice_number: c.invoice_number },
      })),
    ];
  },
  SALES_RETURN: async () => {
    const rows = unwrap(await axios.get('/api/sales/wholesale/returns/'));
    // The POS keeps the returned lines locally (the database row is header-only).
    const local = readLocal('optical_wholesale_returns');
    return rows.map((r) => {
      const l = local.find((x) => x.returnNo === r.return_number) || {};
      return {
        id: r.id,
        number: r.return_number,
        date: r.return_date,
        party: l.customer?.name || '',
        amount: amt(r.return_amount),
        doc: {
          returnNo: r.return_number, invoiceNo: r.invoice_number, date: r.return_date, reason: r.reason,
          action_taken: r.action_taken, amount: r.return_amount, customer: l.customer, items: l.items || [],
          summary: { grandTotal: r.return_amount },
        },
      };
    });
  },
  // Purchase returns are not stored in the database yet (Purchases → Returns keeps them on the
  // screen only), so there is nothing real to preview.
  PURCHASE_RETURN: async () => [],
};

export const REAL_DOC_NOTES = {
  PURCHASE_RETURN: 'Purchase returns are not saved to the database yet, so there is no real document to preview — use sample data.',
  SALES_RETURN: 'Sales returns come from Wholesale → Sales Return. Returned lines are shown when this browser processed the return.',
};

export async function loadRealDocuments(documentType, search = '') {
  const loader = LOADERS[documentType];
  if (!loader) return [];
  const rows = await loader(search);
  const q = search.trim().toLowerCase();
  return rows
    .filter((r) => !q || [r.number, r.party].some((v) => String(v || '').toLowerCase().includes(q)))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
    .slice(0, 100);
}
