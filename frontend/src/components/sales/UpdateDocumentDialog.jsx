import React, { useEffect, useRef, useState } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions, Divider, Grid,
  TextField, MenuItem, Button, Typography, Chip
} from '@mui/material';
import {
  Save as SaveIcon, LocalShipping as DeliveryIcon
} from '@mui/icons-material';

// Lab / delivery workflow stages — kept in sync with OrdersManagerView.labStages.
const PIPELINE_STAGES = [
  'Order Received',
  'In Lab Processing',
  'Frame Mounting',
  'Quality Control',
  'Ready for Collection',
  'Delivered'
];

const PAYMENT_STATES = ['Paid', 'Partial', 'Unpaid'];
const PAYMENT_METHODS = ['Cash', 'Card', 'UPI', 'Bank', 'Credit'];

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

const todayStr = () => new Date().toISOString().split('T')[0];

// Normalise the many payment-status spellings the app uses (backend PAID/PARTIAL/UNPAID,
// wizard 'PARTIALLY PAID', table 'Paid'/'Partial', …) down to the 3 the dialog shows.
const normPay = (v) => {
  const s = String(v || '').toUpperCase();
  if (s.includes('PARTIAL')) return 'Partial';
  if (s.includes('UNPAID') || s.includes('DUE') || s === 'DRAFT') return 'Unpaid';
  if (s.includes('PAID')) return 'Paid';
  return '';
};

/**
 * Quick "Update" dialog for a Sales > Orders row (Order / Invoice / Quotation) — payment
 * state and lab/delivery status only. `doc` is the table row; `fullDoc` (optional) is the
 * backend detail. `onSave(patch)` receives a normalised patch the parent maps to the API.
 */
export default function UpdateDocumentDialog({ open, docView, doc, fullDoc, onClose, onSave }) {
  const [form, setForm] = useState(null);
  // Guards the init effect so a late-arriving `fullDoc` (async fetch) never wipes edits the
  // user already made in the open dialog. We only build the form fresh once per opened row.
  const initedFor = useRef(null);

  useEffect(() => {
    if (!open || !doc) { initedFor.current = null; return; }
    if (initedFor.current === (doc.id || doc.invoiceNumber)) return;
    initedFor.current = doc.id || doc.invoiceNumber;

    const src = fullDoc || {};
    const total = num(
      doc.total ?? doc.netTotal ?? doc.grossTotal ?? src.net_amount ?? src.total_amount ?? 0
    );
    const paidAmount = num(doc.paidAmount ?? doc.totalPaidAmount ?? src.paid_amount ?? 0);
    const paymentStatus =
      normPay(doc.payment) || normPay(doc.paymentStatusLabel) || normPay(src.status) ||
      (total > 0 && paidAmount >= total ? 'Paid' : paidAmount > 0 ? 'Partial' : 'Unpaid');

    setForm({
      total,
      paymentStatus,
      paidAmount,
      paymentMethod: doc.paymentMethod || doc.paymentMode || src.payment_method || 'Cash',
      pipelineStatus:
        doc.status || doc.fulfillmentStatus || src.fulfillment_status || 'Order Received',
      deliveredAt: doc.deliveredAt || src.delivered_at || '',
      fulfillmentNotes: doc.fulfillmentNotes || src.fulfillment_notes || '',
      origPaid: paidAmount,
      origStatus: paymentStatus
    });
  }, [open, doc, fullDoc]);

  if (!open || !form) return null;

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const isQuotation = docView === 'QUOTATION';

  const balance = Math.max(0, num(form.total) - num(form.paidAmount));
  const balanceSettled = num(form.total) > 0 && balance <= 0;

  // "Balance" toggle — Fully Paid sets paid = total + status Paid; Outstanding reverts to the
  // amount/status the document was opened with.
  const setBalanceSettled = (settled) => {
    if (settled) {
      set({ paidAmount: num(form.total), paymentStatus: 'Paid' });
    } else {
      const reverted = form.origPaid >= num(form.total) && num(form.total) > 0 ? 0 : form.origPaid;
      set({ paidAmount: reverted, paymentStatus: form.origStatus === 'Paid' ? 'Partial' : form.origStatus });
    }
  };

  const handleSave = () => {
    const patch = {
      paymentStatus: form.paymentStatus,
      paidAmount: num(form.paidAmount),
      paymentMethod: form.paymentMethod
    };
    if (!isQuotation) {
      patch.status = form.pipelineStatus;
      patch.deliveredAt = form.pipelineStatus === 'Delivered' && !form.deliveredAt
        ? todayStr()
        : (form.deliveredAt || null);
      patch.fulfillmentNotes = (form.fulfillmentNotes || '').trim();
    }
    onSave(patch);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
      <DialogTitle sx={{ fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        Update {isQuotation ? 'Quotation' : docView === 'ORDER' ? 'Order' : 'Invoice'} — {doc.invoiceNumber || doc.id}
        <Chip label={form.pipelineStatus} size="small" color="primary" sx={{ fontWeight: 700 }} />
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ py: 3 }}>
        {/* Payment */}
        <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1.5 }}>Payment</Typography>
        <Grid container spacing={2}>
          <Grid item xs={12} sm={4}>
            <TextField fullWidth size="small" select label="Payment Status" value={form.paymentStatus}
              onChange={(e) => set({ paymentStatus: e.target.value })}>
              {PAYMENT_STATES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
            </TextField>
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField fullWidth size="small" type="number" label="Paid Amount" value={form.paidAmount}
              onChange={(e) => set({ paidAmount: e.target.value })} />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField fullWidth size="small" select label="Method" value={form.paymentMethod}
              onChange={(e) => set({ paymentMethod: e.target.value })}>
              {PAYMENT_METHODS.map((m) => <MenuItem key={m} value={m}>{m}</MenuItem>)}
            </TextField>
          </Grid>
        </Grid>

        {/* Balance — paid or not */}
        <Grid container spacing={2} alignItems="center" sx={{ mt: 0.5, mb: isQuotation ? 0 : 3 }}>
          <Grid item xs={12} sm={5}>
            <TextField fullWidth size="small" select label="Balance"
              value={balanceSettled ? 'PAID' : 'DUE'}
              onChange={(e) => setBalanceSettled(e.target.value === 'PAID')}>
              <MenuItem value="DUE">Balance Outstanding</MenuItem>
              <MenuItem value="PAID">Balance Fully Paid</MenuItem>
            </TextField>
          </Grid>
          <Grid item xs={12} sm={7}>
            <Typography variant="body2" color={balance > 0 ? 'warning.main' : 'success.main'} fontWeight={700}>
              Total ₹{num(form.total).toLocaleString()} · Paid ₹{num(form.paidAmount).toLocaleString()} ·{' '}
              {balance > 0 ? `Balance Due ₹${balance.toLocaleString()}` : 'No balance due'}
            </Typography>
          </Grid>
        </Grid>

        {/* Fulfillment / delivery — not for quotations */}
        {!isQuotation && (
          <>
            <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1.5 }}>Lab / Delivery Status</Typography>
            <Grid container spacing={2}>
              <Grid item xs={12} sm={4}>
                <TextField fullWidth size="small" select label="Pipeline Status" value={form.pipelineStatus}
                  onChange={(e) => set({ pipelineStatus: e.target.value })}>
                  {PIPELINE_STAGES.map((s) => <MenuItem key={s} value={s}>{s}</MenuItem>)}
                </TextField>
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField fullWidth size="small" type="date" label="Delivery Date" InputLabelProps={{ shrink: true }}
                  value={form.deliveredAt || ''} onChange={(e) => set({ deliveredAt: e.target.value })} />
              </Grid>
              <Grid item xs={12} sm={4}>
                <TextField fullWidth size="small" label="Notes (collected by / courier ref)" value={form.fulfillmentNotes}
                  onChange={(e) => set({ fulfillmentNotes: e.target.value })} />
              </Grid>
            </Grid>
            <Button
              size="small" startIcon={<DeliveryIcon />} sx={{ mt: 1.5, textTransform: 'none', fontWeight: 700 }}
              onClick={() => set({ pipelineStatus: 'Delivered', deliveredAt: form.deliveredAt || todayStr() })}
            >
              Mark as Delivered (today)
            </Button>
          </>
        )}
      </DialogContent>
      <DialogActions sx={{ p: 2.5 }}>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="contained" startIcon={<SaveIcon />} onClick={handleSave} sx={{ fontWeight: 700 }}>
          Save Changes
        </Button>
      </DialogActions>
    </Dialog>
  );
}
