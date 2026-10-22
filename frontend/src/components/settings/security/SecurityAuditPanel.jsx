import React, { useCallback, useEffect, useState } from 'react';
import {
  Accordion, AccordionDetails, AccordionSummary, Alert, Box, Button, MenuItem, Skeleton, Table, TableBody, TableCell,
  TableContainer, TableHead, TablePagination, TableRow, TextField, Typography,
} from '@mui/material';
import { ExpandMore as ExpandIcon, PolicyOutlined as AuditIcon } from '@mui/icons-material';
import { alpha } from '@mui/material/styles';
import { SecurityStatusBadge, INDIGO, RADIUS } from './securityUi';
import { securityApi } from '../../../utils/securityApi';
import { formatInZone } from '../../../utils/securityFormat';
import { apiErrorMessage } from '../../../utils/apiError';

const SEVERITY_TONE = { INFO: 'info', WARNING: 'warning', ERROR: 'error' };
const CATEGORIES = { SECURITY: 'Security settings', AUTH: 'Sign-in', BACKUP: 'Backup', RESTORE: 'Restore' };

/** Read-only audit trail (collapsed by default; loads when opened). */
export default function SecurityAuditPanel({ refreshKey, timezone }) {
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState('');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => {
    setError('');
    securityApi.auditLog({ page: page + 1, page_size: pageSize, ...(category ? { category } : {}) })
      .then(setData).catch((e) => setError(`Could not load the audit log. ${apiErrorMessage(e)}`));
  }, [page, pageSize, category]);
  useEffect(() => { if (open) load(); }, [open, load, refreshKey]);

  return (
    <Accordion
      expanded={open}
      onChange={(_, v) => setOpen(v)}
      disableGutters
      elevation={0}
      sx={{ borderRadius: `${RADIUS} !important`, border: '1px solid', borderColor: 'divider', '&:before': { display: 'none' }, overflow: 'hidden' }}
    >
      <AccordionSummary expandIcon={<ExpandIcon />} sx={{ px: { xs: 2, sm: 3 }, py: 1 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
          <Box sx={{ width: 44, height: 44, borderRadius: '14px', display: 'grid', placeItems: 'center', bgcolor: alpha(INDIGO, 0.1), color: INDIGO }}>
            <AuditIcon />
          </Box>
          <Box>
            <Typography component="h2" sx={{ fontWeight: 800, fontSize: '1.08rem' }}>Security &amp; Backup Audit Log</Typography>
            <Typography variant="body2" color="text.secondary">Policy changes, sign-in lockouts, backups, downloads and restores — read-only</Typography>
          </Box>
        </Box>
      </AccordionSummary>
      <AccordionDetails sx={{ px: { xs: 2, sm: 3 }, pb: 2 }}>
        <TextField select size="small" label="Category" value={category} sx={{ mb: 2, minWidth: 200 }}
          onChange={(e) => { setCategory(e.target.value); setPage(0); }}
        >
          <MenuItem value="">All events</MenuItem>
          {Object.entries(CATEGORIES).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
        </TextField>
        {error && <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{error}</Alert>}
        <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '14px' }}>
          <Table size="small" aria-label="Security audit log">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', bgcolor: 'action.hover', whiteSpace: 'nowrap' } }}>
                <TableCell>When</TableCell>
                <TableCell>Event</TableCell>
                <TableCell>Details</TableCell>
                <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>By</TableCell>
                <TableCell sx={{ display: { xs: 'none', md: 'table-cell' } }}>Address</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {!data && !error && [0, 1, 2].map((i) => <TableRow key={i}><TableCell colSpan={5}><Skeleton /></TableCell></TableRow>)}
              {data?.results?.length === 0 && (
                <TableRow><TableCell colSpan={5} align="center" sx={{ py: 3, color: 'text.secondary' }}>No events recorded yet.</TableCell></TableRow>
              )}
              {data?.results?.map((r) => (
                <TableRow key={r.id} hover>
                  <TableCell sx={{ whiteSpace: 'nowrap', fontSize: '0.8rem' }}>{formatInZone(r.created_at, timezone)}</TableCell>
                  <TableCell><SecurityStatusBadge size="small" tone={SEVERITY_TONE[r.severity] || 'neutral'} label={CATEGORIES[r.category] || r.category} /></TableCell>
                  <TableCell sx={{ fontSize: '0.84rem' }}>{r.summary}</TableCell>
                  <TableCell sx={{ display: { xs: 'none', sm: 'table-cell' } }}>{r.actor || '—'}</TableCell>
                  <TableCell sx={{ display: { xs: 'none', md: 'table-cell' }, fontSize: '0.8rem', color: 'text.secondary' }}>{r.ip_address || '—'}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination component="div" count={data?.count || 0} page={page} onPageChange={(_, p) => setPage(p)}
          rowsPerPage={pageSize} onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} rowsPerPageOptions={[10, 25, 50]} />
      </AccordionDetails>
    </Accordion>
  );
}
