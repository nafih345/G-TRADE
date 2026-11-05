// Out-of-stock lens special orders (Sales > Orders > Lenses). The server works out each customer
// order's queue status (backend/apps/purchasing/lens_orders.py order_queue_row); these are only its
// labels, colours and the "what can be done next" rules the screens share.

export const LENS_QUEUE_API = '/api/purchase/lens-orders/sales-queue/';
export const RESERVED_LENS_API = '/api/purchase/lens-orders/reserved-stock/';

export const QUEUE_STATUSES = {
  PENDING_PURCHASE: { label: 'Pending Supplier Purchase', color: 'warning' },
  PURCHASE_PLACED: { label: 'Purchase Placed', color: 'info' },
  PARTIALLY_RECEIVED: { label: 'Partially Received', color: 'secondary' },
  RECEIVED_NOT_STOCKED: { label: 'Received — Purchase Entry Pending', color: 'secondary' },
  READY: { label: 'Received / Ready for Delivery', color: 'success' },
  IN_STOCK: { label: 'In Stock — Ready', color: 'success' },
  DELIVERED: { label: 'Delivered', color: 'default' },
};

export const queueStatusMeta = (code) => QUEUE_STATUSES[code] || { label: code || '—', color: 'default' };

/** Lenses still to be bought from a supplier. */
export const needsPurchase = (row) => row?.queue_status === 'PENDING_PURCHASE';

/** Lenses at the lab, waiting to be received on their Lens PO. */
export const awaitingReceipt = (row) => ['PURCHASE_PLACED', 'PARTIALLY_RECEIVED'].includes(row?.queue_status);

/** Received but not in stock yet: the Lens PO still has to become a Purchase Entry. */
export const awaitingStockEntry = (row) => row?.queue_status === 'RECEIVED_NOT_STOCKED';

/** An Order whose lenses are on the shelf for it — ready to become the tax invoice. */
export const canBillOrder = (row) => !row?.billed && ['READY', 'IN_STOCK'].includes(row?.queue_status);

/** The first Lens PO of a row matching `test`, e.g. the one still to be received. */
export const firstPo = (row, test = () => true) => (row?.purchase_orders || []).find(test) || null;

/** "Both eyes · 1 Pair" / "Left (OS) · 1 Piece". */
export function lensUnitText(lenses = []) {
  const eyes = lenses.map((l) => l.eye);
  const pair = eyes.includes('RE') && eyes.includes('LE');
  if (pair) return 'Both eyes · Pair';
  return `${lenses[0]?.eye_label || 'Single eye'} · Single Lens`;
}

/** One line per customer order, e.g. "HMC 1.56 — Both eyes · Pair — 2/2 received". */
export function lensQueueSummary(row) {
  const lenses = row?.lenses || [];
  const names = [...new Set(lenses.map((l) => l.product_name).filter(Boolean))].join(', ') || 'Lens';
  const t = row?.totals || {};
  return `${names} — ${lensUnitText(lenses)} — ${t.received || 0}/${t.required || 0} received`;
}
