// Ledger "Show Bill": opens the document a posted journal came from, rendered with the template
// assigned to its type (Settings → Bill & Invoice Designer), next to the Chart of Accounts lines
// it posted. Entries with no document (manual vouchers, stock adjustments, opening balances)
// show the posting only.
import React, { useEffect, useState } from 'react';
import {
  Alert, Box, Button, Chip, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, Tab, Table,
  TableBody, TableCell, TableHead, TableRow, Tabs, Typography,
} from '@mui/material';
import { Print as PrintIcon } from '@mui/icons-material';
import BillPreview from '../../billing/BillPreview';
import { printBill } from '../../billing/printBill';
import { notify } from '../../utils/notify';
import { apiError, finGet, inr, sourceLabel } from './financialApi';
import { billSourceFor, loadSourceBill } from './sourceBills';

const head = { fontWeight: 700 };

export default function ShowBillDialog({ row, onClose }) {
  const hasBill = !!billSourceFor(row);
  const [tab, setTab] = useState('bill');
  const [bill, setBill] = useState(null);
  const [billError, setBillError] = useState('');
  const [entry, setEntry] = useState(null);
  const [entryError, setEntryError] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!row) return undefined;
    let alive = true;
    setTab(billSourceFor(row) ? 'bill' : 'posting');
    setBill(null); setBillError(''); setEntry(null); setEntryError('');
    setLoading(true);
    Promise.all([
      loadSourceBill(row).then((b) => { if (alive) setBill(b); }).catch((e) => {
        if (!alive) return;
        setBillError(e?.response?.status === 404
          ? 'The original document is no longer available — it was deleted, or belongs to another branch than the one selected.'
          : apiError(e, 'Could not load the bill.'));
      }),
      row.entry_id ? finGet(`journals/${row.entry_id}/`).then((j) => { if (alive) setEntry(j); })
        .catch((e) => { if (alive) setEntryError(apiError(e)); }) : null,
    ]).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [row]);

  const print = async () => {
    const opened = await printBill({ doc: bill.doc, documentType: bill.documentType });
    if (!opened) notify('Allow pop-ups to print the bill.', 'warning');
  };

  return (
    <Dialog open={!!row} onClose={onClose} maxWidth="md" fullWidth>
      <DialogTitle sx={{ pb: 1 }}>
        <Stack direction="row" alignItems="center" gap={1} flexWrap="wrap">
          <Typography variant="h6" fontWeight={850}>{row?.source_number || row?.entry_number}</Typography>
          <Chip size="small" label={sourceLabel(row)} />
          {row?.is_reversal && <Chip size="small" color="warning" label="Reversal" />}
          <Typography variant="body2" color="text.secondary" sx={{ ml: 'auto' }}>
            Voucher {row?.entry_number} · {row?.date}
          </Typography>
        </Stack>
      </DialogTitle>
      <Tabs value={tab} onChange={(e, v) => setTab(v)} sx={{ px: 3, borderBottom: 1, borderColor: 'divider' }}>
        {hasBill && <Tab value="bill" label="Bill" />}
        <Tab value="posting" label="Posted to accounts" />
      </Tabs>
      <DialogContent sx={{ minHeight: 320 }}>
        {loading && <LinearProgress sx={{ my: 2 }} />}
        {tab === 'bill' && (<>
          {billError && <Alert severity="warning" sx={{ mt: 2 }}>{billError}</Alert>}
          {bill && (
            <Box sx={{ mt: 2, display: 'flex', justifyContent: 'center', bgcolor: '#f1f5f9', borderRadius: 2, p: 2 }}>
              <BillPreview doc={bill.doc} documentType={bill.documentType} maxWidth={720} />
            </Box>
          )}
        </>)}
        {tab === 'posting' && (<>
          {!hasBill && (
            <Alert severity="info" sx={{ mt: 2 }}>
              This entry has no bill — it is a {sourceLabel(row).toLowerCase()}. Its posting is shown below.
            </Alert>
          )}
          {entryError && <Alert severity="error" sx={{ mt: 2 }}>{entryError}</Alert>}
          {entry && (<>
            <Typography variant="body2" sx={{ mt: 2, mb: 1 }}>{entry.narration}</Typography>
            <Table size="small">
              <TableHead sx={{ bgcolor: '#f8fafc' }}>
                <TableRow>
                  <TableCell sx={head}>Account</TableCell>
                  <TableCell sx={head}>Memo</TableCell>
                  <TableCell sx={head} align="right">Debit</TableCell>
                  <TableCell sx={head} align="right">Credit</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {entry.lines.map((l) => (
                  <TableRow key={l.id}>
                    <TableCell sx={{ fontWeight: 600 }}>{l.account_code} - {l.account_name}</TableCell>
                    <TableCell sx={{ color: 'text.secondary' }}>{l.memo}</TableCell>
                    <TableCell align="right">{parseFloat(l.debit) ? inr(l.debit) : ''}</TableCell>
                    <TableCell align="right">{parseFloat(l.credit) ? inr(l.credit) : ''}</TableCell>
                  </TableRow>
                ))}
                <TableRow sx={{ bgcolor: '#f1f5f9' }}>
                  <TableCell colSpan={2} sx={{ fontWeight: 850 }}>TOTAL</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 850 }}>{inr(entry.lines.reduce((s, l) => s + (parseFloat(l.debit) || 0), 0))}</TableCell>
                  <TableCell align="right" sx={{ fontWeight: 850 }}>{inr(entry.lines.reduce((s, l) => s + (parseFloat(l.credit) || 0), 0))}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </>)}
        </>)}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2 }}>
        <Button onClick={onClose}>Close</Button>
        {tab === 'bill' && bill && <Button variant="contained" startIcon={<PrintIcon />} onClick={print}>Print bill</Button>}
      </DialogActions>
    </Dialog>
  );
}
