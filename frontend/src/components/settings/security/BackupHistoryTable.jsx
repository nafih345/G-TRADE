import React, { useCallback, useEffect, useState } from 'react';
import {
  Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Grid, IconButton, MenuItem, Skeleton,
  Table, TableBody, TableCell, TableContainer, TableHead, TablePagination, TableRow, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  ListAltOutlined as HistoryIcon, Download as DownloadIcon, InfoOutlined as InfoIcon, RestoreOutlined as RestoreIcon,
  DeleteOutline as DeleteIcon, Refresh as RefreshIcon,
} from '@mui/icons-material';
import { PanelCard, SecurityStatusBadge, RADIUS, outlineButtonSx } from './securityUi';
import ConfirmActionDialog from '../../common/ConfirmActionDialog';
import { backupApi } from '../../../utils/securityApi';
import { STATUS_TONE, formatBytes, formatInZone } from '../../../utils/securityFormat';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';

const TYPE_LABEL = { MANUAL: 'Manual', SCHEDULED: 'Automatic', PRE_RESTORE: 'Safety (pre-restore)', UPLOADED: 'Uploaded' };
const hideSm = { display: { xs: 'none', md: 'table-cell' } };
const wideOnly = { display: { xs: 'none', xl: 'table-cell' } }; // the full filename is in Details

function DetailsDialog({ id, timezone, onClose }) {
  const [rec, setRec] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!id) return;
    setRec(null); setError('');
    backupApi.get(id).then(setRec).catch((e) => setError(apiErrorMessage(e)));
  }, [id]);
  if (!id) return null;
  const rows = rec ? [
    ['Backup ID', rec.backup_identifier], ['File', rec.filename], ['Type', TYPE_LABEL[rec.backup_type]],
    ['Status', `${rec.status_label}${rec.verified ? ' · verified' : ''}`], ['Size', formatBytes(rec.file_size)],
    ['Created', formatInZone(rec.created_at, timezone)], ['Completed', formatInZone(rec.completed_at, timezone) || '—'],
    ['Initiated by', rec.initiated_by || '—'], ['Storage', rec.storage_location === 'DATABASE' ? 'Database storage' : 'Server disk'],
    ['SHA-256', rec.checksum || '—'],
    ['Contents', rec.manifest?.table_count != null ? `${rec.manifest.table_count} tables, ${rec.manifest.total_rows?.toLocaleString()} records (${rec.manifest.database_engine})` : '—'],
    ['Data as of', formatInZone(rec.manifest?.created_at, timezone) || '—'],
    ...(rec.manifest?.original_filename ? [['Uploaded file', rec.manifest.original_filename]] : []),
    ...(rec.deleted_at ? [['Deleted', `${formatInZone(rec.deleted_at, timezone)} by ${rec.deleted_by}`]] : []),
  ] : [];
  return (
    <Dialog open onClose={onClose} maxWidth="sm" fullWidth PaperProps={{ sx: { borderRadius: RADIUS } }}>
      <DialogTitle sx={{ fontWeight: 800 }}>Backup details</DialogTitle>
      <DialogContent>
        {error && <Alert severity="error">{error}</Alert>}
        {!rec && !error && <Skeleton height={200} />}
        {rec?.error_summary && <Alert severity="error" sx={{ mb: 2, borderRadius: '12px' }}>{rec.error_summary}</Alert>}
        {rec && (
          <Box component="dl" sx={{ m: 0, display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '140px 1fr' }, columnGap: 2, rowGap: 0.75 }}>
            {rows.map(([k, v]) => (
              <React.Fragment key={k}>
                <Typography component="dt" variant="body2" color="text.secondary" sx={{ fontWeight: 600 }}>{k}</Typography>
                <Typography component="dd" variant="body2" sx={{ m: 0, wordBreak: 'break-all', fontFamily: k === 'SHA-256' ? 'monospace' : undefined }}>{v}</Typography>
              </React.Fragment>
            ))}
          </Box>
        )}
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}><Button onClick={onClose} sx={outlineButtonSx}>Close</Button></DialogActions>
    </Dialog>
  );
}

/** Backup history with filters and server-side pagination. `refreshKey` reloads it. */
export default function BackupHistoryTable({ refreshKey, timezone, canRestore, busy, onRestore, onChanged }) {
  const [filters, setFilters] = useState({ type: '', status: '', date_from: '', date_to: '' });
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(10);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [details, setDetails] = useState(null);
  const [toDelete, setToDelete] = useState(null);

  const load = useCallback(() => {
    setError('');
    const params = { page: page + 1, page_size: pageSize };
    Object.entries(filters).forEach(([k, v]) => { if (v) params[k] = v; });
    backupApi.history(params).then(setData).catch((e) => {
      if (e?.response?.status === 404 && page > 0) { setPage(0); return; }
      setError(`Could not load the backup history. ${apiErrorMessage(e)}`);
    });
  }, [filters, page, pageSize]);
  useEffect(() => { load(); }, [load, refreshKey]);

  const setFilter = (k) => (e) => { setFilters((f) => ({ ...f, [k]: e.target.value })); setPage(0); };

  const download = async (row) => {
    try { await backupApi.download(row.id); } catch (e) { notify(`Download failed. ${apiErrorMessage(e)}`, 'error'); }
  };
  const remove = async () => {
    const row = toDelete;
    setToDelete(null);
    try {
      await backupApi.remove(row.id);
      notify(`Backup ${row.backup_identifier} deleted.`, 'success');
      load();
      onChanged?.();
    } catch (e) {
      if (e?.response?.status !== 403 || e.response.data?.code !== 'reauth_required') notify(apiErrorMessage(e, 'The backup could not be deleted.'), 'error');
    }
  };

  return (
    <PanelCard id="backup-history" icon={<HistoryIcon />} title="Backup History"
      subtitle="Every backup, with who started it and its result"
      action={<Tooltip title="Refresh"><IconButton onClick={load} aria-label="Refresh backup history"><RefreshIcon /></IconButton></Tooltip>}
    >
      <Grid container spacing={1.5} sx={{ mb: 2 }}>
        <Grid item xs={6} md={3}>
          <TextField select size="small" fullWidth label="Type" value={filters.type} onChange={setFilter('type')}>
            <MenuItem value="">All types</MenuItem>
            {Object.entries(TYPE_LABEL).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
          </TextField>
        </Grid>
        <Grid item xs={6} md={3}>
          <TextField select size="small" fullWidth label="Status" value={filters.status} onChange={setFilter('status')}>
            <MenuItem value="">All (except deleted)</MenuItem>
            <MenuItem value="SUCCESS">Successful</MenuItem>
            <MenuItem value="FAILED">Failed</MenuItem>
            <MenuItem value="RUNNING">Running</MenuItem>
            <MenuItem value="DELETED">Deleted</MenuItem>
          </TextField>
        </Grid>
        <Grid item xs={6} md={3}>
          <TextField size="small" fullWidth type="date" label="From" InputLabelProps={{ shrink: true }} value={filters.date_from} onChange={setFilter('date_from')} />
        </Grid>
        <Grid item xs={6} md={3}>
          <TextField size="small" fullWidth type="date" label="To" InputLabelProps={{ shrink: true }} value={filters.date_to} onChange={setFilter('date_to')} />
        </Grid>
      </Grid>

      {error && <Alert severity="error" sx={{ mb: 2, borderRadius: '12px' }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{error}</Alert>}

      <TableContainer sx={{ border: '1px solid', borderColor: 'divider', borderRadius: '14px' }}>
        <Table size="small" aria-label="Backup history">
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, color: 'text.secondary', bgcolor: 'action.hover', whiteSpace: 'nowrap' } }}>
              <TableCell>Backup ID</TableCell>
              <TableCell sx={wideOnly}>Filename</TableCell>
              <TableCell>Type</TableCell>
              <TableCell>Created</TableCell>
              <TableCell sx={hideSm} align="right">Size</TableCell>
              <TableCell sx={hideSm}>Initiated by</TableCell>
              <TableCell>Status</TableCell>
              <TableCell align="right">Actions</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {!data && !error && [0, 1, 2].map((i) => (
              <TableRow key={i}><TableCell colSpan={8}><Skeleton /></TableCell></TableRow>
            ))}
            {data?.results?.length === 0 && (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                {Object.values(filters).some(Boolean) ? 'No backups match these filters.' : 'No backups yet — create the first one above.'}
              </TableCell></TableRow>
            )}
            {data?.results?.map((row) => {
              const available = row.status === 'SUCCESS' && row.verified;
              return (
                <TableRow key={row.id} hover sx={{ opacity: row.status === 'DELETED' ? 0.6 : 1 }}>
                  <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap', fontSize: '0.8rem' }}>{row.backup_identifier}</TableCell>
                  <TableCell sx={{ ...wideOnly, fontSize: '0.78rem', color: 'text.secondary', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={row.filename}>
                    {row.filename}
                  </TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{TYPE_LABEL[row.backup_type] || row.backup_type_label}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap', fontSize: '0.82rem' }}>{formatInZone(row.created_at, timezone)}</TableCell>
                  <TableCell sx={hideSm} align="right">{row.status === 'SUCCESS' ? formatBytes(row.file_size) : '—'}</TableCell>
                  <TableCell sx={hideSm}>{row.initiated_by || '—'}</TableCell>
                  <TableCell>
                    <Tooltip title={row.error_summary || ''}>
                      <span><SecurityStatusBadge size="small" tone={STATUS_TONE[row.status] || 'neutral'} label={row.status_label} /></span>
                    </Tooltip>
                  </TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Tooltip title="Download"><span>
                      <IconButton size="small" disabled={!available} onClick={() => download(row)} aria-label={`Download ${row.backup_identifier}`}><DownloadIcon fontSize="small" /></IconButton>
                    </span></Tooltip>
                    <Tooltip title="Details">
                      <IconButton size="small" onClick={() => setDetails(row.id)} aria-label={`Details of ${row.backup_identifier}`}><InfoIcon fontSize="small" /></IconButton>
                    </Tooltip>
                    {canRestore && (
                      <Tooltip title="Restore"><span>
                        <IconButton size="small" disabled={!available || busy} onClick={() => onRestore(row)} aria-label={`Restore ${row.backup_identifier}`}><RestoreIcon fontSize="small" /></IconButton>
                      </span></Tooltip>
                    )}
                    {canRestore && (
                      <Tooltip title={row.can_delete ? 'Delete' : 'Cannot delete (the only verified backup, in use, or already deleted)'}><span>
                        <IconButton size="small" color="error" disabled={!row.can_delete} onClick={() => setToDelete(row)} aria-label={`Delete ${row.backup_identifier}`}><DeleteIcon fontSize="small" /></IconButton>
                      </span></Tooltip>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      <TablePagination
        component="div"
        count={data?.count || 0}
        page={page}
        onPageChange={(_, p) => setPage(p)}
        rowsPerPage={pageSize}
        onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }}
        rowsPerPageOptions={[10, 25, 50]}
      />

      <DetailsDialog id={details} timezone={timezone} onClose={() => setDetails(null)} />
      <ConfirmActionDialog
        open={!!toDelete}
        type="danger"
        title="Delete this backup?"
        message={toDelete ? `${toDelete.backup_identifier} (${formatBytes(toDelete.file_size)}) will be permanently removed from storage. The history entry stays for the audit trail.` : ''}
        confirmText="Delete backup"
        onConfirm={remove}
        onClose={() => setToDelete(null)}
      />
    </PanelCard>
  );
}
