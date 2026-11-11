import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  Stack, Table, TableBody, TableCell, TableHead, TableRow, TextField, Typography,
} from '@mui/material';
import { apiErrorMessage } from '../../utils/apiError';
import { notify } from '../../utils/notify';
import { printBill } from '../../billing/printBill';
import {
  RETURN_DOC_TYPES, RETURN_KINDS, cancelReturn, fetchReturn, fmtDate, fmtMoney, modeMeta, returnPrintDoc,
} from './returnsApi';
import { getTaxLabel, isTaxEnabled } from '../../utils/localeFormat.js';

/**
 * One return in full: products and quantities, the original bill, the exact reason per line and
 * how the value was settled (Cash, or GPay / Bank + bank name). Used by the return screens and by
 * the Sales / Purchase Report drill-down. `canCancel` adds Cancel Return (stock and books undone).
 */
export default function ReturnDetailDialog({ kind, returnId, initial, open, onClose, canCancel = false, onChanged }) {
  const cfg = RETURN_KINDS[kind];
  const [doc, setDoc] = useState(initial || null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !returnId) return;
    setDoc(initial?.items ? initial : null);
    setError('');
    setCancelling(false);
    setReason('');
    if (initial?.items) return;
    let alive = true;
    setLoading(true);
    fetchReturn(kind, returnId)
      .then((d) => { if (alive) setDoc(d); })
      .catch((e) => { if (alive) setError(apiErrorMessage(e, 'Could not load the return.')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, returnId, kind, initial]);

  const doCancel = async () => {
    if (!reason.trim()) { notify('Give a reason for cancelling the return.', 'warning'); return; }
    setBusy(true);
    try {
      const d = await cancelReturn(kind, returnId, reason.trim());
      setDoc(d);
      setCancelling(false);
      notify(`${d.return_number} cancelled — stock and accounts reversed.`, 'success');
      onChanged?.(d);
    } catch (e) {
      notify(apiErrorMessage(e, 'The return was not cancelled.'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const cancelled = doc?.status === 'CANCELLED';
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        {cfg.title} {doc?.return_number || ''}
        {doc && <Chip size="small" label={cancelled ? 'Cancelled' : 'Completed'} color={cancelled ? 'default' : 'error'} variant={cancelled ? 'outlined' : 'filled'} />}
      </DialogTitle>
      <DialogContent dividers>
        {loading && <Box sx={{ py: 6, textAlign: 'center' }}><CircularProgress size={28} /></Box>}
        {error && <Alert severity="error">{error}</Alert>}
        {doc && !loading && (
          <Stack spacing={2}>
            {cancelled && (
              <Alert severity="warning">
                Cancelled {doc.cancelled_by ? `by ${doc.cancelled_by} ` : ''}— {doc.cancel_reason}. Stock and accounting entries were reversed.
              </Alert>
            )}
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr 1fr' }, gap: 1.5 }}>
              <Field label="Return date" value={fmtDate(doc.return_date)} />
              <Field label={`Original ${cfg.original}`} value={doc.original?.number || 'Manual return (no bill)'} />
              <Field label={cfg.party} value={[doc.party?.name, doc.party?.phone].filter(Boolean).join(' · ') || '—'} />
              {kind === 'purchase' && doc.original?.supplier_invoice_number && (
                <Field label="Supplier bill no." value={doc.original.supplier_invoice_number} />
              )}
              <Field label="Entered by" value={doc.performed_by || '—'} />
            </Box>

            <Box>
              <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 0.5 }}>Returned products</Typography>
              <Box sx={{ overflowX: 'auto' }}>
                <Table size="small">
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ fontWeight: 800 }}>Product</TableCell>
                      <TableCell sx={{ fontWeight: 800 }} align="right">Qty</TableCell>
                      <TableCell sx={{ fontWeight: 800 }} align="right">Rate</TableCell>
                      <TableCell sx={{ fontWeight: 800 }} align="right">Amount</TableCell>
                      <TableCell sx={{ fontWeight: 800 }}>Return reason</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {(doc.items || []).map((it) => (
                      <TableRow key={it.id}>
                        <TableCell>
                          <Typography variant="body2" fontWeight={700}>{it.description}</Typography>
                          <Typography variant="caption" color="text.secondary">{[it.sku, it.barcode].filter(Boolean).join(' · ')}</Typography>
                        </TableCell>
                        <TableCell align="right">{it.return_qty}</TableCell>
                        <TableCell align="right">{fmtMoney(it.unit_price)}</TableCell>
                        <TableCell align="right">{fmtMoney(it.line_total)}</TableCell>
                        <TableCell>
                          <Chip size="small" color="error" variant="outlined" label={it.return_reason_label} />
                          {it.reason_notes && <Typography variant="caption" sx={{ display: 'block', mt: 0.25 }}>{it.reason_notes}</Typography>}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </Box>
            </Box>

            <Divider />
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '1fr 1fr' }, gap: 2 }}>
              <Box>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 0.5 }}>Refund / settlement</Typography>
                {(doc.settlements || []).map((s, i) => (
                  <Stack key={i} direction="row" justifyContent="space-between" sx={{ py: 0.25 }}>
                    <Typography variant="body2">
                      {modeMeta(s.mode).label || s.mode}
                      {s.bank_name ? ` — ${s.bank_name}` : ''}
                      {s.reference ? ` (Ref ${s.reference})` : ''}
                    </Typography>
                    <Typography variant="body2" fontWeight={700}>{fmtMoney(s.amount)}</Typography>
                  </Stack>
                ))}
              </Box>
              <Box>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 0.5 }}>Totals</Typography>
                <Row label={`Value (excl. ${getTaxLabel()})`} value={fmtMoney(doc.subtotal)} />
                {(isTaxEnabled() || Number(doc.tax_amount) > 0) && <Row label={getTaxLabel()} value={fmtMoney(doc.tax_amount)} />}
                <Row label="Total returned" value={fmtMoney(doc.total_amount)} strong />
              </Box>
            </Box>
            {doc.general_remarks && (
              <Box>
                <Typography variant="subtitle2" fontWeight={800}>Remarks</Typography>
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{doc.general_remarks}</Typography>
              </Box>
            )}
            {cancelling && (
              <TextField autoFocus size="small" label="Reason for cancelling" value={reason}
                onChange={(e) => setReason(e.target.value)} helperText={kind === 'sales'
                  ? 'The returned units are taken back out of stock and the refund entry is reversed.'
                  : 'The units come back into stock and the refund entry is reversed.'} />
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        {canCancel && doc && !cancelled && (cancelling ? (
          <>
            <Button onClick={() => setCancelling(false)} disabled={busy}>Keep return</Button>
            <Button color="error" variant="contained" onClick={doCancel} disabled={busy}>Confirm cancel</Button>
          </>
        ) : (
          <Button color="error" onClick={() => setCancelling(true)} sx={{ mr: 'auto' }}>Cancel return</Button>
        ))}
        {doc && !cancelling && (
          <Button onClick={() => printBill({ documentType: RETURN_DOC_TYPES[kind], doc: returnPrintDoc(kind, doc) })
            .catch((e) => notify(apiErrorMessage(e, 'Could not print the return.'), 'error'))}>
            Print {kind === 'sales' ? 'credit note' : 'debit note'}
          </Button>
        )}
        <Button onClick={onClose} variant="outlined">Close</Button>
      </DialogActions>
    </Dialog>
  );
}

function Field({ label, value }) {
  return (
    <Box>
      <Typography variant="caption" color="text.secondary" sx={{ display: 'block' }}>{label}</Typography>
      <Typography variant="body2" fontWeight={700}>{value}</Typography>
    </Box>
  );
}

function Row({ label, value, strong }) {
  return (
    <Stack direction="row" justifyContent="space-between" sx={{ py: 0.25 }}>
      <Typography variant="body2" color={strong ? 'text.primary' : 'text.secondary'} fontWeight={strong ? 800 : 400}>{label}</Typography>
      <Typography variant="body2" fontWeight={strong ? 800 : 600}>{value}</Typography>
    </Stack>
  );
}
