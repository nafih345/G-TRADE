// "View Settlement Breakdown": one bill-to-bill Receipt / Payment Voucher — how it was paid
// (Cash / Cheque # / Bank …) and every bill it closed or part-settled, with each bill's due
// before, settled, due after and its due today. Opened from the voucher form after saving, the
// Settlement Statement, and the Receipt / Payment Voucher reports.
// GET /api/financial/settlements/voucher/?number=BR-…|PV-… or ?journal=<entry number>.
import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, Grid, LinearProgress, Paper, Stack,
  Table, TableBody, TableCell, TableHead, TableRow, Typography,
} from '@mui/material';
import { Print as PrintIcon } from '@mui/icons-material';
import { apiError, finGet } from './financialApi';
import { formatDate, formatMoney } from '../../utils/localeFormat';
import { useStoreProfile, companyFromProfile } from '../../utils/storeProfile';
import { esc, printReport, printShell, printCards } from '../accounts/reportKit';
import { notify } from '../../utils/notify';

const money = (v) => (v === null || v === undefined || v === '' ? '—' : formatMoney(v));
export const PARTY_KIND_LABEL = { customer: 'Customer', dealer: 'Dealer', supplier: 'Supplier' };
export const BILL_STATUS = {
  CLOSED: { label: 'Closed', color: 'success' },
  PARTIAL: { label: 'Partial', color: 'warning' },
};

export const settlementPrintHtml = (d, { company, logo }) => {
  const receipt = d.voucher === 'RV';
  const bills = d.bills.map((b, i) => `<tr><td>${i + 1}</td><td><b>${esc(b.bill_number)}</b>${b.bill_ref ? ` <small>(${esc(b.bill_ref)})</small>` : ''}</td>
    <td class="nw">${esc(b.bill_date ? formatDate(b.bill_date) : '')}</td><td class="r">${esc(money(b.bill_total))}</td>
    <td class="r">${esc(money(b.previous_due))}</td><td class="r"><b>${esc(money(b.settled))}</b></td>
    <td class="r">${esc(money(b.remaining_due))}</td><td>${esc(BILL_STATUS[b.status]?.label || b.status || '')}</td></tr>`).join('');
  const pays = d.payments.map(p => `<tr><td><b>${esc(p.method)}</b></td><td>${esc(p.detail)}</td><td class="r">${esc(money(p.amount))}</td></tr>`).join('');
  return printShell({
    title: `${receipt ? 'Receipt' : 'Payment'} Voucher — Bill-to-Bill Settlement`,
    company, logo, landscape: false,
    meta: [['Voucher No', d.number], ['Date', formatDate(d.date)],
      [PARTY_KIND_LABEL[d.party_kind] || 'Party', `${d.party_name}${d.party_code ? ` (${d.party_code})` : ''}`],
      d.journal && d.journal !== d.number && ['Journal', d.journal], d.status !== 'POSTED' && ['Status', 'Reversed']],
    body: `${printCards([[receipt ? 'TOTAL RECEIVED' : 'TOTAL PAID', money(d.total)], ['AGAINST BILLS', money(d.allocated)],
      ['ON ACCOUNT', money(d.on_account)], ['BILLS', `${d.bills_closed} closed · ${d.bills_partial} partial`]])}
      <h3>Payment source</h3>
      <table><thead><tr><th>Mode</th><th>Details</th><th class="r">Amount</th></tr></thead><tbody>${pays}
        <tr class="tot"><td colspan="2">Total</td><td class="r">${esc(money(d.total))}</td></tr></tbody></table>
      <h3>Bills settled</h3>
      <table><thead><tr><th>#</th><th>Bill No</th><th>Bill Date</th><th class="r">Bill Amount</th><th class="r">Due Before</th>
        <th class="r">Settled</th><th class="r">Balance Due</th><th>Status</th></tr></thead>
        <tbody>${bills || '<tr><td colspan="8" style="text-align:center;color:#64748b">No bills — the whole amount is on account.</td></tr>'}
        ${Number(d.on_account) ? `<tr><td></td><td colspan="4">On account (advance)</td><td class="r"><b>${esc(money(d.on_account))}</b></td><td colspan="2"></td></tr>` : ''}
        <tr class="tot"><td colspan="5">Total settled</td><td class="r">${esc(money(d.total))}</td><td colspan="2"></td></tr></tbody></table>
      ${d.narration ? `<p><b>Narration:</b> ${esc(d.narration)}</p>` : ''}
      <div style="display:flex;justify-content:space-between;margin-top:46px"><span>Prepared by</span><span>${receipt ? 'Received by' : 'Authorised signatory'}</span></div>`,
  });
};

export function SettlementBreakdown({ data }) {
  const cell = { py: 0.6, fontSize: 12.5 };
  return (
    <Box>
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        {[[data.voucher === 'RV' ? 'Total Received' : 'Total Paid', data.total, '#0f1e3d'], ['Against Bills', data.allocated, '#2563eb'],
          ['On Account', data.on_account, '#a16207']].map(([label, value, color]) => (
          <Grid item xs={6} sm={3} key={label}>
            <Paper variant="outlined" sx={{ p: 1.25, borderRadius: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>{label.toUpperCase()}</Typography>
              <Typography variant="subtitle1" fontWeight={850} sx={{ color }}>{money(value)}</Typography>
            </Paper>
          </Grid>
        ))}
        {data.party_outstanding !== undefined && (
          <Grid item xs={6} sm={3}>
            <Paper variant="outlined" sx={{ p: 1.25, borderRadius: 2 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>PARTY DUE TODAY</Typography>
              <Typography variant="subtitle1" fontWeight={850} color="error.main">{money(data.party_outstanding)}</Typography>
            </Paper>
          </Grid>
        )}
      </Grid>

      <Typography variant="subtitle2" fontWeight={850} sx={{ mb: 0.75 }}>1. Payment Source Breakdown</Typography>
      <Table size="small" sx={{ mb: 2.5, border: '1px solid #e2e8f0', '& .MuiTableCell-root': cell }}>
        <TableHead sx={{ bgcolor: '#f1f5f9' }}>
          <TableRow>
            <TableCell sx={{ fontWeight: 700 }}>Mode</TableCell>
            <TableCell sx={{ fontWeight: 700 }}>Details (Cheque / Ref / Bank)</TableCell>
            <TableCell sx={{ fontWeight: 700 }} align="right">Amount</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.payments.map((p, i) => (
            <TableRow key={i}>
              <TableCell sx={{ fontWeight: 800 }}>{p.method}</TableCell>
              <TableCell>{p.detail || '—'}</TableCell>
              <TableCell align="right" sx={{ fontWeight: 700 }}>{money(p.amount)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      <Typography variant="subtitle2" fontWeight={850} sx={{ mb: 0.75 }}>2. Settled Invoices / Bills</Typography>
      <Table size="small" sx={{ border: '1px solid #e2e8f0', '& .MuiTableCell-root': cell }}>
        <TableHead sx={{ bgcolor: '#f1f5f9' }}>
          <TableRow>
            <TableCell sx={{ fontWeight: 700 }}>Bill No</TableCell>
            <TableCell sx={{ fontWeight: 700 }}>Bill Date</TableCell>
            <TableCell sx={{ fontWeight: 700 }} align="right">Bill Amount</TableCell>
            <TableCell sx={{ fontWeight: 700 }} align="right">Due Before</TableCell>
            <TableCell sx={{ fontWeight: 700 }} align="right">Settled</TableCell>
            <TableCell sx={{ fontWeight: 700 }} align="right">Balance After</TableCell>
            {data.bills.some(b => b.current_due !== undefined) && <TableCell sx={{ fontWeight: 700 }} align="right">Due Today</TableCell>}
            <TableCell sx={{ fontWeight: 700 }}>Status</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {data.bills.map(b => (
            <TableRow key={b.bill_id}>
              <TableCell sx={{ fontWeight: 700 }}>
                {b.bill_number}
                {b.bill_ref ? <Typography component="span" variant="caption" color="text.secondary"> · {b.bill_ref}</Typography> : null}
                {b.receipts?.length > 0 && <Typography variant="caption" color="text.secondary" display="block">{b.receipts.join(', ')}</Typography>}
              </TableCell>
              <TableCell sx={{ whiteSpace: 'nowrap' }}>{b.bill_date ? formatDate(b.bill_date) : '—'}</TableCell>
              <TableCell align="right">{money(b.bill_total)}</TableCell>
              <TableCell align="right">{money(b.previous_due)}</TableCell>
              <TableCell align="right" sx={{ fontWeight: 800 }}>{money(b.settled)}</TableCell>
              <TableCell align="right">{money(b.remaining_due)}</TableCell>
              {b.current_due !== undefined && <TableCell align="right">{money(b.current_due)}</TableCell>}
              <TableCell>
                {BILL_STATUS[b.status]
                  ? <Chip size="small" color={BILL_STATUS[b.status].color} label={BILL_STATUS[b.status].label} sx={{ height: 20, fontWeight: 700 }} />
                  : <Typography variant="caption" color="text.secondary">—</Typography>}
              </TableCell>
            </TableRow>
          ))}
          {Number(data.on_account) > 0 && (
            <TableRow>
              <TableCell colSpan={4} sx={{ fontStyle: 'italic' }}>On account (advance — not against a bill)</TableCell>
              <TableCell align="right" sx={{ fontWeight: 800 }}>{money(data.on_account)}</TableCell>
              <TableCell colSpan={3} />
            </TableRow>
          )}
          {!data.bills.length && !Number(data.on_account) && (
            <TableRow><TableCell colSpan={8} align="center" sx={{ color: 'text.secondary' }}>No bills.</TableCell></TableRow>
          )}
        </TableBody>
      </Table>
      {data.origin === 'backfill' && (
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          Saved before settlement records were kept: the due before / after each bill was not recorded.
        </Typography>
      )}
      {data.narration && <Typography variant="body2" sx={{ mt: 1.5 }}><b>Narration:</b> {data.narration}</Typography>}
    </Box>
  );
}

/** `query`: { number } or { journal }. */
export default function SettlementBreakdownDialog({ open, query, onClose }) {
  const storeProfile = useStoreProfile();
  const company = companyFromProfile(storeProfile);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const key = query ? `${query.number || ''}|${query.journal || ''}` : '';

  useEffect(() => {
    if (!open || !key) return undefined;
    let alive = true;
    setLoading(true);
    setError('');
    setData(null);
    finGet('settlements/voucher/', query)
      .then(d => { if (alive) setData(d); })
      .catch(e => { if (alive) setError(apiError(e, 'Could not load the settlement.')); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [open, key]); // eslint-disable-line react-hooks/exhaustive-deps

  const print = () => printReport(async () => settlementPrintHtml(data, { company, logo: storeProfile.logo_data_url }),
    (e) => notify(apiError(e, 'Could not print.'), 'error'));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth PaperProps={{ 'data-own-enter': true }}>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Typography variant="h6" fontWeight={850}>Settlement Breakdown</Typography>
          {data && <Chip label={data.number} size="small" sx={{ fontFamily: 'monospace', fontWeight: 800 }} />}
          {data?.status === 'REVERSED' && <Chip label="Reversed" color="error" size="small" />}
        </Stack>
        {data && (
          <Typography variant="body2" color="text.secondary">
            {data.voucher === 'RV' ? 'Receipt' : 'Payment'} Voucher · {formatDate(data.date)} · {PARTY_KIND_LABEL[data.party_kind]}: <b>{data.party_name}</b>
            {data.party_code ? ` (${data.party_code})` : ''}{data.branch ? ` · ${data.branch}` : ''}
          </Typography>
        )}
      </DialogTitle>
      <DialogContent dividers>
        {loading && <LinearProgress sx={{ mb: 2 }} />}
        {error && <Alert severity="warning">{error}</Alert>}
        {data && <SettlementBreakdown data={data} />}
      </DialogContent>
      <DialogActions>
        <Button startIcon={<PrintIcon />} onClick={print} disabled={!data} sx={{ fontWeight: 700 }}>Print / PDF</Button>
        <Button variant="contained" onClick={onClose} sx={{ fontWeight: 700 }}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
