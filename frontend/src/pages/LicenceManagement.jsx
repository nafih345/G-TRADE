// Licences & Plans (/superadmin/licences) — the cloud Vendor Super Admin's licence dashboard. The
// Windows edition's Local Super Admin manages customer licences inside Client Management instead
// (TenantManagement → Customers & Subscriptions / Plans / Licence audit reuse PlansTab and AuditTab). Tabs:
//   Licences — every client licence (Windows Local + Cloud): masked key with Copy, dates, status,
//              activation and installation binding; a row opens its details and actions.
//   Plans    — monthly / yearly / lifetime plans: create, edit, activate, deactivate.
//   Audit    — every licence, plan and client action.
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import { useLocation } from 'react-router-dom';
import {
  Alert, Box, Button, Card, Chip, IconButton, InputAdornment, LinearProgress, MenuItem, Stack, Tab, Table, TableBody,
  TableCell, TableContainer, TableHead, TablePagination, TableRow, Tabs, TextField, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, ContentCopy as CopyIcon, Refresh as RefreshIcon, Search as SearchIcon,
} from '@mui/icons-material';
import { apiErrorMessage } from '../utils/apiError';
import { notify } from '../utils/notify';
import { copy, fmtDate, fmtDateTime, isReauth } from '../components/superadmin/clientApi';
import {
  ACTIVATION_STATUS, CYCLE_LABEL, EDITION_LABEL, LICENCE_STATUS, LIC_API, LIMITS, bindingText, daysLeftText,
  durationText, limitText, priceText,
} from '../components/superadmin/licensing/licenceApi';
import PlanDialog from '../components/superadmin/licensing/PlanDialog';
import NewLicenceDialog from '../components/superadmin/licensing/NewLicenceDialog';
import LicenceDetailDialog from '../components/superadmin/licensing/LicenceDetailDialog';

const TABS = ['licences', 'plans', 'audit'];

function LicencesTab({ catalog, plans }) {
  const [rows, setRows] = useState([]);
  const [count, setCount] = useState(0);
  const [byStatus, setByStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [edition, setEdition] = useState('');
  const [page, setPage] = useState(0);
  const [size, setSize] = useState(25);
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => { const t = setTimeout(() => { setQuery(search.trim()); setPage(0); }, 300); return () => clearTimeout(t); }, [search]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${LIC_API}licences/`, { params: { page: page + 1, page_size: size, search: query || undefined,
        status: status || undefined, edition: edition || undefined } });
      setRows(data.results); setCount(data.count); setByStatus(data.by_status || {}); setError('');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the licences.'));
    } finally {
      setLoading(false);
    }
  }, [page, size, query, status, edition]);
  useEffect(() => { load(); }, [load]);

  const copyKey = async (row) => {
    try {
      const { data } = await axios.post(`${LIC_API}licences/${row.id}/key/`, {});
      copy(data.key);
    } catch (err) {
      if (!isReauth(err)) notify(apiErrorMessage(err, 'Could not read the key.'), 'error');
    }
  };

  return (
    <Box>
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }} alignItems={{ md: 'center' }}>
        <TextField size="small" placeholder="Search client, licence ID, installation, plan" value={search}
          onChange={(e) => setSearch(e.target.value)} sx={{ flex: 1 }} inputProps={{ 'aria-label': 'Search licences' }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
        <TextField select size="small" label="Status" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }} sx={{ minWidth: 150 }}>
          <MenuItem value="">All</MenuItem>
          {Object.entries(LICENCE_STATUS).map(([k, v]) => <MenuItem key={k} value={k}>{v.label}{byStatus[k] ? ` (${byStatus[k]})` : ''}</MenuItem>)}
        </TextField>
        <TextField select size="small" label="Edition" value={edition} onChange={(e) => { setEdition(e.target.value); setPage(0); }} sx={{ minWidth: 150 }}>
          <MenuItem value="">All</MenuItem>
          {Object.entries(EDITION_LABEL).map(([k, v]) => <MenuItem key={k} value={k}>{v}</MenuItem>)}
        </TextField>
        <Tooltip title="Refresh"><IconButton onClick={load} aria-label="Refresh"><RefreshIcon /></IconButton></Tooltip>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreating(true)}>New Windows licence</Button>
      </Stack>
      {catalog && !catalog.signing?.configured && (
        <Alert severity="warning" sx={{ mb: 2 }}>Licence signing is not configured on this server: {catalog.signing?.message}</Alert>
      )}
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      <Card variant="outlined">
        {loading ? <LinearProgress /> : <Box sx={{ height: 4 }} />}
        <TableContainer>
          <Table size="small" stickyHeader aria-label="Licences">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
                <TableCell>Client</TableCell><TableCell>Licence ID</TableCell><TableCell>Plan</TableCell><TableCell>Edition</TableCell>
                <TableCell>Licence key</TableCell><TableCell>Start</TableCell><TableCell>Expiry</TableCell><TableCell>Status</TableCell>
                <TableCell>Activation</TableCell><TableCell>Installation</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const st = LICENCE_STATUS[r.effective_status] || LICENCE_STATUS.ACTIVE;
                const act = ACTIVATION_STATUS[r.activation_status] || {};
                return (
                  <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => setOpenId(r.id)}>
                    <TableCell sx={{ maxWidth: 200 }}>
                      <Typography variant="body2" fontWeight={600} noWrap title={r.client.name}>{r.client.name}</Typography>
                      <Typography variant="caption" color="text.secondary">{r.client.client_code}</Typography>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{r.lic_id}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.plan.name}<Typography variant="caption" display="block" color="text.secondary">{CYCLE_LABEL[r.billing_cycle]}</Typography></TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{EDITION_LABEL[r.edition]}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      <Box component="span" sx={{ fontFamily: 'monospace', fontSize: 12 }}>{r.key_masked}</Box>
                      <Tooltip title="Copy licence key"><IconButton size="small" aria-label={`Copy licence key ${r.lic_id}`} onClick={() => copyKey(r)}><CopyIcon fontSize="inherit" /></IconButton></Tooltip>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(r.starts_on)}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{r.lifetime ? 'Lifetime' : fmtDate(r.expires_on)}
                      <Typography variant="caption" display="block" color={r.days_left !== null && r.days_left < 30 && !r.lifetime ? 'warning.main' : 'text.secondary'}>{daysLeftText(r)}</Typography>
                    </TableCell>
                    <TableCell><Chip size="small" label={st.label} color={st.color} /></TableCell>
                    <TableCell><Chip size="small" variant="outlined" label={act.label} color={act.color} title={act.hint} /></TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }} title={r.install_id}>{bindingText(r)}</TableCell>
                  </TableRow>
                );
              })}
              {!loading && !rows.length && (
                <TableRow><TableCell colSpan={10} align="center" sx={{ py: 4, color: 'text.secondary' }}>No licences yet.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
        <TablePagination component="div" count={count} page={page} rowsPerPage={size} rowsPerPageOptions={[10, 25, 50, 100]}
          onPageChange={(_, p) => setPage(p)} onRowsPerPageChange={(e) => { setSize(Number(e.target.value)); setPage(0); }} />
      </Card>
      {openId && <LicenceDetailDialog licenceId={openId} plans={plans} catalog={catalog} onClose={() => setOpenId(null)} onChanged={load} />}
      {creating && <NewLicenceDialog onClose={() => { setCreating(false); load(); }} onCreated={() => load()} />}
    </Box>
  );
}

export function PlansTab({ catalog, plans, reload }) {
  const [editing, setEditing] = useState(null);
  const toggle = async (p) => {
    try {
      await axios.post(`${LIC_API}plans/${p.id}/${p.is_active ? 'deactivate' : 'activate'}/`, {});
      notify(`${p.name}: ${p.is_active ? 'deactivated' : 'activated'}.`, 'success');
      reload();
    } catch (err) {
      if (!isReauth(err)) notify(apiErrorMessage(err, 'Could not change the plan.'), 'error');
    }
  };
  const moduleLabel = (k) => catalog?.modules?.find((m) => m.key === k)?.label || k;
  return (
    <Box>
      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 2 }}>
        <Typography variant="body2" color="text.secondary">
          Plans are sold as licences. A licence keeps the terms it was issued with; renewing or changing its plan shows the differences first.
        </Typography>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setEditing({})} disabled={!catalog}>New plan</Button>
      </Stack>
      <Card variant="outlined">
        <TableContainer>
          <Table size="small" aria-label="Plans">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
                <TableCell>Plan</TableCell><TableCell>Edition</TableCell><TableCell>Billing</TableCell><TableCell align="right">Price</TableCell>
                {LIMITS.map(([k, label]) => <TableCell key={k} align="right">{label}</TableCell>)}
                <TableCell>Modules</TableCell><TableCell align="right">Licences</TableCell><TableCell>Status</TableCell><TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {plans.map((p) => (
                <TableRow key={p.id} hover sx={{ opacity: p.is_active ? 1 : 0.6 }}>
                  <TableCell><Typography variant="body2" fontWeight={600}>{p.name}</Typography><Typography variant="caption" color="text.secondary">{p.code}</Typography></TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{EDITION_LABEL[p.edition]}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{CYCLE_LABEL[p.billing_cycle]} · {durationText(p.billing_cycle, p.duration)}</TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>{priceText(p.price, p.currency)}</TableCell>
                  {LIMITS.map(([k, , field]) => (
                    <TableCell key={k} align="right">{p.edition === 'CLOUD' && k === 'clients' ? '—' : limitText(p[field])}</TableCell>
                  ))}
                  <TableCell sx={{ maxWidth: 220 }}>
                    <Tooltip title={(p.modules || []).map(moduleLabel).join(', ')}><Chip size="small" variant="outlined" label={`${(p.modules || []).length} modules`} /></Tooltip>
                  </TableCell>
                  <TableCell align="right">{p.licence_count ?? 0}</TableCell>
                  <TableCell><Chip size="small" label={p.is_active ? 'Active' : 'Deactivated'} color={p.is_active ? 'success' : 'default'} /></TableCell>
                  <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                    <Button size="small" onClick={() => setEditing(p)}>Edit</Button>
                    <Button size="small" color={p.is_active ? 'warning' : 'success'} onClick={() => toggle(p)}>{p.is_active ? 'Deactivate' : 'Activate'}</Button>
                  </TableCell>
                </TableRow>
              ))}
              {!plans.length && (
                <TableRow><TableCell colSpan={12} align="center" sx={{ py: 4, color: 'text.secondary' }}>No plans yet — use “New plan”.</TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
      {editing && catalog && (
        <PlanDialog catalog={catalog} plan={editing.id ? editing : null} onClose={() => setEditing(null)}
          onSaved={(p) => { setEditing(null); notify(`Plan “${p.name}” saved.`, 'success'); reload(); }} />
      )}
    </Box>
  );
}

export function AuditTab() {
  const [rows, setRows] = useState(null);
  useEffect(() => { axios.get(`${LIC_API}audit/`).then(({ data }) => setRows(data)).catch(() => setRows([])); }, []);
  if (!rows) return <LinearProgress />;
  return (
    <Card variant="outlined">
      <TableContainer>
        <Table size="small" aria-label="Licence audit">
          <TableHead><TableRow><TableCell>When</TableCell><TableCell>Action</TableCell><TableCell>By</TableCell><TableCell>Licence / plan / client</TableCell><TableCell>Reason</TableCell></TableRow></TableHead>
          <TableBody>
            {rows.map((a) => (
              <TableRow key={a.id}>
                <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.created_at)}</TableCell>
                <TableCell>{a.action}</TableCell>
                <TableCell>{a.actor}{a.ip ? ` · ${a.ip}` : ''}</TableCell>
                <TableCell>{[a.lic_id, a.plan_name, a.client_name].filter(Boolean).join(' · ')}</TableCell>
                <TableCell sx={{ maxWidth: 360, wordBreak: 'break-word' }}>{a.reason || a.details?.error || ''}</TableCell>
              </TableRow>
            ))}
            {!rows.length && <TableRow><TableCell colSpan={5} align="center" sx={{ py: 3 }}>Nothing recorded yet.</TableCell></TableRow>}
          </TableBody>
        </Table>
      </TableContainer>
    </Card>
  );
}

export default function LicenceManagement() {
  const location = useLocation();
  const initial = TABS.indexOf(new URLSearchParams(location.search).get('tab') || 'licences');
  const [tab, setTab] = useState(initial < 0 ? 0 : initial);
  const [catalog, setCatalog] = useState(null);
  const [plans, setPlans] = useState([]);
  const [error, setError] = useState('');

  const loadPlans = useCallback(() => axios.get(`${LIC_API}plans/`).then(({ data }) => setPlans(data))
    .catch((err) => setError(apiErrorMessage(err, 'Could not load the plans.'))), []);
  const loadCatalog = useCallback(() => axios.get(`${LIC_API}catalog/`).then(({ data }) => setCatalog(data))
    .catch((err) => setError(apiErrorMessage(err, 'Could not load the licence catalog.'))), []);
  useEffect(() => { loadCatalog(); loadPlans(); }, [loadCatalog, loadPlans]);
  const reload = () => { loadPlans(); loadCatalog(); };

  return (
    <Box sx={{ p: { xs: 2, md: 3 }, maxWidth: 1440, mx: 'auto' }}>
      <Typography variant="h5" fontWeight={800}>Licences &amp; Plans</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {catalog?.local
          ? 'Create customers and their Monthly / Quarterly / Half-Yearly / Yearly / Lifetime subscriptions, and generate signed '
            + 'licence keys offline on this vendor installation. Customers paste the key in Licence Details → Activate.'
          : 'Signed licence keys for Windows Local and Cloud clients. Customers can activate a key but never create or change one.'}
        {catalog?.signing?.configured && ` Signing key: ${catalog.signing.key_id}.`}
      </Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 2 }}>
        <Tab label="Licences" /><Tab label={`Plans (${plans.length})`} /><Tab label="Audit" />
      </Tabs>
      {tab === 0 && <LicencesTab catalog={catalog} plans={plans} />}
      {tab === 1 && <PlansTab catalog={catalog} plans={plans} reload={reload} />}
      {tab === 2 && <AuditTab />}
    </Box>
  );
}
