// Read-only view into one client's records (GET /api/superadmin/tenants/<id>/data/…): datasets by
// module with row counts, a recent-activity feed, and per dataset a searchable, date-filtered,
// paginated table with CSV export and a record viewer (every stored field + child lines).
// Soft-deleted rows are shown and flagged; the server logs each dataset view and export in the
// client's History.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  Box, Stack, Typography, Button, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, TablePagination,
  Chip, TextField, MenuItem, Alert, LinearProgress, List, ListItemButton, ListItemText, ListSubheader, Dialog,
  DialogTitle, DialogContent, DialogActions, Grid, Paper, InputAdornment, CircularProgress,
} from '@mui/material';
import { Search as SearchIcon, Download as DownloadIcon, History as ActivityIcon } from '@mui/icons-material';
import { notify } from '../../utils/notify';
import { apiErrorMessage } from '../../utils/apiError';
import { API, fmtDate, fmtDateTime } from './clientApi';

const money = (v) => (v === null || v === undefined || v === '' ? '—'
  : Number(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));

export const formatValue = (value, kind) => {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object' && 'id' in value && 'text' in value) return value.text || value.id;
  switch (kind) {
    case 'money': return money(value);
    case 'date': return fmtDate(value);
    case 'datetime': return fmtDateTime(value);
    case 'bool': return value ? 'Yes' : 'No';
    case 'json': return JSON.stringify(value);
    default: return String(value);
  }
};

const isNumeric = (kind) => kind === 'money' || kind === 'number';

function RecordDialog({ tenantId, dataset, recordId, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    axios.get(`${API}${tenantId}/data/${dataset}/${recordId}/`)
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((err) => { if (live) setError(apiErrorMessage(err, 'Could not load the record.')); });
    return () => { live = false; };
  }, [tenantId, dataset, recordId]);

  const filled = data ? data.fields.filter((f) => f.value !== null && f.value !== '' && f.value !== undefined) : [];
  const empty = data ? data.fields.length - filled.length : 0;
  return (
    <Dialog open onClose={onClose} maxWidth="md" fullWidth aria-labelledby="client-record-title">
      <DialogTitle id="client-record-title">
        <Stack direction="row" spacing={1} alignItems="center">
          <span>{data ? `${data.label}: ${data.title}` : 'Record'}</span>
          {data?.deleted && <Chip size="small" color="error" variant="outlined" label="Deleted" />}
        </Stack>
      </DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error">{error}</Alert>}
        {!data && !error && <LinearProgress />}
        {data && (
          <Stack spacing={2.5}>
            <Grid container spacing={1}>
              {filled.map((f) => (
                <Grid item xs={12} sm={6} md={4} key={f.key}>
                  <Typography variant="caption" color="text.secondary" component="div">{f.label}</Typography>
                  <Typography variant="body2" sx={{ wordBreak: 'break-word', fontFamily: f.kind === 'json' ? 'monospace' : undefined }}>
                    {formatValue(f.value, f.kind)}
                  </Typography>
                </Grid>
              ))}
            </Grid>
            {empty > 0 && <Typography variant="caption" color="text.secondary">{empty} empty field{empty === 1 ? '' : 's'} not shown.</Typography>}
            {data.children.map((child) => (
              <Box key={child.label}>
                <Typography variant="subtitle2" gutterBottom>{child.label} ({child.rows.length})</Typography>
                {child.rows.length ? (
                  <TableContainer component={Paper} variant="outlined">
                    <Table size="small" aria-label={child.label}>
                      <TableHead>
                        <TableRow sx={{ '& th': { fontWeight: 700 } }}>
                          {child.columns.map((c) => <TableCell key={c.key} align={isNumeric(c.kind) ? 'right' : 'left'}>{c.label}</TableCell>)}
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        {child.rows.map((r) => (
                          <TableRow key={r.id} sx={{ opacity: r.deleted ? 0.55 : 1 }}>
                            {child.columns.map((c) => (
                              <TableCell key={c.key} align={isNumeric(c.kind) ? 'right' : 'left'}>{formatValue(r.values[c.key], c.kind)}</TableCell>
                            ))}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </TableContainer>
                ) : <Typography variant="body2" color="text.secondary">None.</Typography>}
              </Box>
            ))}
          </Stack>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

function DatasetTable({ tenantId, meta }) {
  const [search, setSearch] = useState('');
  const [term, setTerm] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [deleted, setDeleted] = useState('all');
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [openId, setOpenId] = useState(null);

  useEffect(() => { const t = setTimeout(() => setTerm(search.trim()), 350); return () => clearTimeout(t); }, [search]);
  useEffect(() => { setPage(0); }, [term, dateFrom, dateTo, deleted, meta.key]);

  const params = useMemo(() => {
    const p = { deleted };
    if (term) p.search = term;
    if (dateFrom) p.date_from = dateFrom;
    if (dateTo) p.date_to = dateTo;
    return p;
  }, [term, dateFrom, dateTo, deleted]);

  useEffect(() => {
    let live = true;
    setLoading(true);
    setError('');
    axios.get(`${API}${tenantId}/data/${meta.key}/`, { params: { ...params, page: page + 1, page_size: pageSize } })
      .then(({ data: d }) => { if (live) setData(d); })
      .catch((err) => { if (live) setError(apiErrorMessage(err, 'Could not load the records.')); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [tenantId, meta.key, params, page, pageSize]);

  const exportCsv = async () => {
    setExporting(true);
    try {
      const res = await axios.get(`${API}${tenantId}/data/${meta.key}/`, { params: { ...params, export: 'csv' }, responseType: 'blob' });
      const name = /filename="([^"]+)"/.exec(res.headers['content-disposition'] || '')?.[1] || `${meta.key}.csv`;
      const url = URL.createObjectURL(res.data);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      notify(`Exported ${name}.`, 'success');
    } catch (err) {
      notify(apiErrorMessage(err, 'The export failed.'), 'error');
    } finally {
      setExporting(false);
    }
  };

  const columns = data?.columns || meta.columns;
  return (
    <Stack spacing={1.5} sx={{ minWidth: 0 }}>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={1} alignItems={{ md: 'center' }}>
        <Typography variant="h6" sx={{ flexGrow: 1 }}>{meta.label}</Typography>
        <Button size="small" variant="outlined" startIcon={exporting ? <CircularProgress size={14} /> : <DownloadIcon />}
          onClick={exportCsv} disabled={exporting || !data?.count}>
          Export CSV
        </Button>
      </Stack>
      {meta.hint && <Typography variant="caption" color="text.secondary">{meta.hint}</Typography>}
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
        {meta.searchable && (
          <TextField size="small" placeholder="Search" value={search} onChange={(e) => setSearch(e.target.value)} sx={{ flexGrow: 1 }}
            inputProps={{ 'aria-label': `Search ${meta.label}` }}
            InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
        )}
        <TextField size="small" type="date" label={`${meta.date_label} from`} value={dateFrom}
          onChange={(e) => setDateFrom(e.target.value)} InputLabelProps={{ shrink: true }} />
        <TextField size="small" type="date" label="to" value={dateTo}
          onChange={(e) => setDateTo(e.target.value)} InputLabelProps={{ shrink: true }} />
        {meta.soft_delete && (
          <TextField size="small" select label="Rows" value={deleted} onChange={(e) => setDeleted(e.target.value)} sx={{ minWidth: 150 }}>
            <MenuItem value="all">All (incl. deleted)</MenuItem>
            <MenuItem value="live">Live only</MenuItem>
            <MenuItem value="deleted">Deleted only</MenuItem>
          </TextField>
        )}
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <Box sx={{ position: 'relative' }}>
        {loading && <LinearProgress sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 }} />}
        <TableContainer component={Paper} variant="outlined" sx={{ maxHeight: { md: '52vh' } }}>
          <Table size="small" stickyHeader aria-label={meta.label}>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
                {columns.map((c) => <TableCell key={c.key} align={isNumeric(c.kind) ? 'right' : 'left'}>{c.label}</TableCell>)}
              </TableRow>
            </TableHead>
            <TableBody>
              {data?.results.map((r) => (
                <TableRow key={r.id} hover sx={{ cursor: 'pointer', opacity: r.deleted ? 0.55 : 1 }} onClick={() => setOpenId(r.id)}
                  tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') setOpenId(r.id); }}>
                  {columns.map((c, i) => (
                    <TableCell key={c.key} align={isNumeric(c.kind) ? 'right' : 'left'}
                      sx={{ maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={typeof r.values[c.key] === 'string' ? r.values[c.key] : undefined}>
                      {formatValue(r.values[c.key], c.kind)}
                      {i === 0 && r.deleted && <Chip size="small" color="error" variant="outlined" label="Deleted" sx={{ ml: 1 }} />}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {data && !data.results.length && (
                <TableRow><TableCell colSpan={columns.length}><Typography color="text.secondary" variant="body2">No records match.</Typography></TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
      {data && (
        <TablePagination component="div" count={data.count} page={page} rowsPerPage={pageSize}
          onPageChange={(_, p) => setPage(p)} rowsPerPageOptions={[25, 50, 100, 200]}
          onRowsPerPageChange={(e) => { setPageSize(Number(e.target.value)); setPage(0); }} />
      )}
      {openId && <RecordDialog tenantId={tenantId} dataset={meta.key} recordId={openId} onClose={() => setOpenId(null)} />}
    </Stack>
  );
}

function ActivityFeed({ overview, onOpen }) {
  const labels = Object.fromEntries(overview.datasets.map((d) => [d.key, d.label]));
  if (!overview.activity.length) return <Typography color="text.secondary">This client has not entered any records yet.</Typography>;
  return (
    <Stack spacing={1.5} sx={{ minWidth: 0 }}>
      <Typography variant="h6">Recent activity</Typography>
      <Typography variant="caption" color="text.secondary">The newest entries across patients, eye tests, bills, payments, stock, purchases and journals.</Typography>
      <TableContainer component={Paper} variant="outlined">
        <Table size="small" aria-label="Recent activity">
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700 } }}>
              <TableCell>When</TableCell><TableCell>Record</TableCell><TableCell>Reference</TableCell>
              <TableCell>Party / detail</TableCell><TableCell align="right">Amount</TableCell><TableCell>By</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {overview.activity.map((a) => (
              <TableRow key={`${a.dataset}:${a.id}`} hover sx={{ cursor: 'pointer' }} onClick={() => onOpen(a.dataset, a.id)}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.created_at)}</TableCell>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{labels[a.dataset]}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>{a.reference || '—'}</TableCell>
                <TableCell sx={{ maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{a.party || '—'}</TableCell>
                <TableCell align="right">{a.amount == null ? '—' : formatValue(a.amount, a.amount_kind)}</TableCell>
                <TableCell sx={{ fontFamily: 'monospace' }}>{a.by || '—'}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
    </Stack>
  );
}

export default function ClientDataPanel({ tenant }) {
  const [overview, setOverview] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [activityRecord, setActivityRecord] = useState(null);

  const load = useCallback(() => {
    setError('');
    axios.get(`${API}${tenant.id}/data/`)
      .then(({ data }) => setOverview(data))
      .catch((err) => setError(apiErrorMessage(err, 'Could not load the client’s data.')));
  }, [tenant.id]);
  useEffect(() => { load(); }, [load]);

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!overview) return <LinearProgress />;

  const counts = Object.fromEntries(overview.counts.map((c) => [c.key, c]));
  const meta = overview.datasets.find((d) => d.key === selected);
  return (
    <Stack spacing={1.5}>
      <Alert severity="info" variant="outlined">
        Read-only view of everything recorded under {tenant.name}. Opening a dataset or exporting it is noted in this client’s History.
      </Alert>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="flex-start">
        <Paper variant="outlined" sx={{ width: { xs: '100%', md: 270 }, flexShrink: 0, maxHeight: { md: '62vh' }, overflowY: 'auto' }}>
          <List dense disablePadding aria-label="Datasets">
            <ListItemButton selected={!selected} onClick={() => setSelected(null)}>
              <ActivityIcon fontSize="small" sx={{ mr: 1, color: 'text.secondary' }} />
              <ListItemText primary="Recent activity" />
            </ListItemButton>
            {overview.sections.map((section) => {
              const items = overview.datasets.filter((d) => d.section === section.key);
              if (!items.length) return null;
              return (
                <React.Fragment key={section.key}>
                  <ListSubheader sx={{ lineHeight: '32px', fontWeight: 700 }}>{section.label}</ListSubheader>
                  {items.map((d) => {
                    const c = counts[d.key] || {};
                    return (
                      <ListItemButton key={d.key} selected={selected === d.key} onClick={() => setSelected(d.key)}>
                        <ListItemText primary={d.label}
                          secondary={c.last_entry_at ? `Last ${fmtDate(c.last_entry_at)}` : 'No entries'}
                          secondaryTypographyProps={{ variant: 'caption' }} />
                        <Chip size="small" label={(c.count || 0).toLocaleString()} variant={c.count ? 'filled' : 'outlined'}
                          title={c.deleted ? `${c.deleted} deleted` : undefined} />
                      </ListItemButton>
                    );
                  })}
                </React.Fragment>
              );
            })}
          </List>
        </Paper>
        <Box sx={{ flexGrow: 1, minWidth: 0, width: '100%' }}>
          {meta
            ? <DatasetTable key={meta.key} tenantId={tenant.id} meta={meta} />
            : <ActivityFeed overview={overview} onOpen={(dataset, id) => setActivityRecord({ dataset, id })} />}
        </Box>
      </Stack>
      {activityRecord && (
        <RecordDialog tenantId={tenant.id} dataset={activityRecord.dataset} recordId={activityRecord.id}
          onClose={() => setActivityRecord(null)} />
      )}
    </Stack>
  );
}
