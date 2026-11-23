// Client Management → Customers & Subscriptions (Windows Local Super Admin; also usable by the cloud
// vendor console). One row per customer who runs G OPTICALS on their OWN installation, with the
// current subscription: plan, licence status, activation, issue / expiry date, Installation ID and
// renewal status. "New client" saves the client and its subscription together (and generates the
// signed key when the Installation ID is known); a row opens the client: edit details, bind the
// Installation ID, copy the key, record activation, renew, change plan, new subscription, suspend…
// The server signs and decides every rule; nothing here computes a date or a limit.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Card, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Grid, IconButton,
  InputAdornment, LinearProgress, MenuItem, Stack, Table, TableBody, TableCell, TableContainer, TableHead, TableRow,
  TextField, Tooltip, Typography,
} from '@mui/material';
import {
  Add as AddIcon, ContentCopy as CopyIcon, Refresh as RefreshIcon, Search as SearchIcon,
} from '@mui/icons-material';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';
import { copy, fmtDate, isReauth, splitErrors } from '../clientApi';
import {
  LICENCE_STATUS, LIC_API, RENEWAL_STATUS, activationMeta, daysLeftText, shortInstall,
} from './licenceApi';
import NewLicenceDialog from './NewLicenceDialog';
import LicenceDetailDialog from './LicenceDetailDialog';

const CLIENT_FIELDS = [['name', 'Client / business name'], ['owner_name', 'Owner name'], ['email', 'Email'],
  ['phone', 'Phone'], ['country', 'Country'], ['address', 'Address']];

export const copyLicenceKey = async (lic) => {
  try {
    const { data } = await axios.post(`${LIC_API}licences/${lic.id}/key/`, {});
    copy(data.key);
    return true;
  } catch (err) {
    if (!isReauth(err)) notify(apiErrorMessage(err, 'Could not read the key.'), 'error');
    return false;
  }
};

function StatusChips({ lic, local }) {
  if (!lic) return <Chip size="small" label="No subscription" />;
  const st = LICENCE_STATUS[lic.effective_status] || LICENCE_STATUS.ACTIVE;
  return <Chip size="small" label={st.label} color={st.color} />;
}

function ClientDialog({ clientId, catalog, plans, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [openLicence, setOpenLicence] = useState(null);
  const [newSubscription, setNewSubscription] = useState(false);
  const local = Boolean(catalog?.local);

  const load = useCallback(() => axios.get(`${LIC_API}clients/${clientId}/`).then(({ data: d }) => {
    setData(d);
    setForm(Object.fromEntries(CLIENT_FIELDS.map(([k]) => [k, d[k] || ''])));
    setError('');
  }).catch((err) => setError(apiErrorMessage(err, 'Could not load the client.'))), [clientId]);
  useEffect(() => { load(); }, [load]);

  const changed = data && form && CLIENT_FIELDS.some(([k]) => (data[k] || '') !== (form[k] || ''));
  const save = async () => {
    setSaving(true); setErrors({}); setError('');
    try {
      const body = Object.fromEntries(CLIENT_FIELDS.filter(([k]) => (data[k] || '') !== (form[k] || '')).map(([k]) => [k, form[k]]));
      await axios.patch(`${LIC_API}clients/${clientId}/`, body);
      notify('Client details saved.', 'success');
      await load();
      onChanged?.();
    } catch (err) {
      if (!isReauth(err)) {
        const { fields, general } = splitErrors(err, CLIENT_FIELDS.map(([k]) => k), 'The client could not be saved.');
        setErrors(fields); setError(general);
      }
    } finally {
      setSaving(false);
    }
  };

  const refreshAll = () => { load(); onChanged?.(); };

  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth aria-labelledby="customer-client-title">
      <DialogTitle id="customer-client-title">
        {data ? `${data.name} (${data.client_code})` : 'Client'}
        {data?.licence && <Box component="span" sx={{ ml: 1 }}><StatusChips lic={data.licence} local={local} /></Box>}
      </DialogTitle>
      <DialogContent dividers>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        {!data || !form ? <CircularProgress size={24} /> : (
          <>
            <Typography variant="subtitle2" fontWeight={700} gutterBottom>Client details</Typography>
            <Grid container columnSpacing={2}>
              {CLIENT_FIELDS.map(([k, label]) => (
                <Grid item xs={12} sm={k === 'address' ? 12 : 6} md={k === 'address' ? 12 : 4} key={k}>
                  <TextField fullWidth size="small" label={label} value={form[k] ?? ''} disabled={saving}
                    select={k === 'country'} multiline={k === 'address'} minRows={k === 'address' ? 2 : undefined}
                    required={k === 'name'} error={Boolean(errors[k])} helperText={errors[k] || ' '}
                    onChange={(e) => { setForm((f) => ({ ...f, [k]: e.target.value })); setErrors((x) => ({ ...x, [k]: undefined })); }}>
                    {k === 'country' && [<MenuItem key="" value="">—</MenuItem>,
                      ...(catalog?.countries || []).map((c) => <MenuItem key={c.code} value={c.code}>{c.name}</MenuItem>)]}
                  </TextField>
                </Grid>
              ))}
            </Grid>
            <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }}>
              <Button variant="contained" size="small" disabled={!changed || saving} onClick={save}>
                {saving ? 'Saving…' : 'Save details'}
              </Button>
            </Stack>

            <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 1 }}>
              <Typography variant="subtitle2" fontWeight={700}>Subscriptions &amp; licence keys</Typography>
              <Button size="small" variant="outlined" startIcon={<AddIcon />} onClick={() => setNewSubscription(true)}
                disabled={!catalog?.signing?.configured}>
                New subscription
              </Button>
            </Stack>
            <TableContainer>
              <Table size="small" aria-label="Subscriptions">
                <TableHead>
                  <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
                    <TableCell>Licence</TableCell><TableCell>Plan</TableCell><TableCell>Status</TableCell>
                    <TableCell>Activation</TableCell><TableCell>Issued</TableCell><TableCell>Expiry</TableCell>
                    <TableCell>Installation ID</TableCell><TableCell>Renewal</TableCell><TableCell align="right">Actions</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {(data.licences || []).map((l) => {
                    const st = LICENCE_STATUS[l.effective_status] || LICENCE_STATUS.ACTIVE;
                    const act = activationMeta(l, local);
                    const ren = RENEWAL_STATUS[l.renewal_status] || RENEWAL_STATUS.NONE;
                    return (
                      <TableRow key={l.id} hover sx={{ cursor: 'pointer', opacity: l.status === 'REVOKED' ? 0.6 : 1 }} onClick={() => setOpenLicence(l.id)}>
                        <TableCell sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>{l.lic_id}
                          {l.id === data.current_licence_id && <Chip size="small" color="primary" label="Current" sx={{ ml: 1, fontFamily: 'inherit' }} />}
                          <Typography variant="caption" display="block" color="text.secondary">rev {l.revision}</Typography></TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{l.subscription}</TableCell>
                        <TableCell><Chip size="small" label={st.label} color={st.color} /></TableCell>
                        <TableCell><Chip size="small" variant="outlined" label={act.label} color={act.color} title={act.hint} /></TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(l.issued_at)}</TableCell>
                        <TableCell sx={{ whiteSpace: 'nowrap' }}>{l.lifetime ? 'Never (lifetime)' : fmtDate(l.expires_on)}
                          <Typography variant="caption" display="block" color="text.secondary">{daysLeftText(l)}</Typography>
                        </TableCell>
                        <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, wordBreak: 'break-all', maxWidth: 200 }}>{l.install_id || '—'}</TableCell>
                        <TableCell><Chip size="small" variant="outlined" label={ren.label} color={ren.color} /></TableCell>
                        <TableCell align="right" sx={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                          {l.key_available !== false && l.status !== 'REVOKED' && (
                            <Tooltip title="Copy licence key"><IconButton size="small" aria-label={`Copy licence key ${l.lic_id}`} onClick={() => copyLicenceKey(l)}><CopyIcon fontSize="inherit" /></IconButton></Tooltip>
                          )}
                          <Button size="small" onClick={() => setOpenLicence(l.id)}>
                            {l.key_available === false ? 'Bind installation' : 'Manage'}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!(data.licences || []).length && (
                    <TableRow><TableCell colSpan={9} align="center" sx={{ py: 3, color: 'text.secondary' }}>No subscription yet — use “New subscription”.</TableCell></TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              Renewing keeps the same licence, client and installation (revision + 1); the customer pastes the new key and keeps every record.
              A new subscription for the same client and Installation ID replaces the old licence on their PC.
            </Typography>
          </>
        )}
        {openLicence && (
          <LicenceDetailDialog licenceId={openLicence} plans={plans} catalog={catalog}
            onClose={() => { setOpenLicence(null); refreshAll(); }} onChanged={refreshAll} />
        )}
        {newSubscription && data && (
          <NewLicenceDialog existingClient={data} installation={data.licence?.install_id || ''}
            onClose={() => { setNewSubscription(false); refreshAll(); }} onCreated={refreshAll} />
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}

export default function CustomerClientsPanel({ catalog, plans, createSignal }) {
  const [rows, setRows] = useState([]);
  const [counts, setCounts] = useState({ status: {}, renewal: {} });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [renewal, setRenewal] = useState('');
  const [openId, setOpenId] = useState(null);
  const [creating, setCreating] = useState(false);
  const local = Boolean(catalog?.local);

  useEffect(() => { const t = setTimeout(() => setQuery(search.trim()), 300); return () => clearTimeout(t); }, [search]);
  const firstSignal = useRef(createSignal);
  useEffect(() => { if (createSignal && createSignal !== firstSignal.current) setCreating(true); }, [createSignal]);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await axios.get(`${LIC_API}clients/overview/`, {
        params: { search: query || undefined, status: status || undefined, renewal: renewal || undefined } });
      setRows(data.results); setCounts(data.counts || { status: {}, renewal: {} }); setError('');
    } catch (err) {
      setError(apiErrorMessage(err, 'Could not load the clients.'));
    } finally {
      setLoading(false);
    }
  }, [query, status, renewal]);
  useEffect(() => { load(); }, [load]);

  const total = Object.values(counts.status || {}).reduce((a, b) => a + b, 0);
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Customers who run G OPTICALS on their own computer. Create the client with its Monthly / Quarterly / Half-Yearly / Yearly /
        Lifetime subscription, bind their Installation ID and send them the signed licence key; they paste it in
        {' '}<b>Licence Details → Activate</b> (offline).{catalog?.signing?.configured ? ` Signing key: ${catalog.signing.key_id}.` : ''}
      </Typography>
      {catalog && !catalog.signing?.configured && (
        <Alert severity="warning" sx={{ mb: 2 }}>Licence keys cannot be generated on this installation: {catalog.signing?.message}</Alert>
      )}
      <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} sx={{ mb: 2 }} alignItems={{ md: 'center' }}>
        <TextField size="small" placeholder="Search client, code, phone, licence ID, Installation ID" value={search}
          onChange={(e) => setSearch(e.target.value)} sx={{ flex: 1 }} inputProps={{ 'aria-label': 'Search customers' }}
          InputProps={{ startAdornment: <InputAdornment position="start"><SearchIcon fontSize="small" /></InputAdornment> }} />
        <TextField select size="small" label="Licence status" value={status} onChange={(e) => setStatus(e.target.value)} sx={{ minWidth: 160 }}>
          <MenuItem value="">All ({total})</MenuItem>
          {Object.entries(LICENCE_STATUS).map(([k, v]) => <MenuItem key={k} value={k}>{v.label} ({counts.status?.[k] || 0})</MenuItem>)}
          <MenuItem value="NONE">No subscription ({counts.status?.NONE || 0})</MenuItem>
        </TextField>
        <TextField select size="small" label="Renewal" value={renewal} onChange={(e) => setRenewal(e.target.value)} sx={{ minWidth: 170 }}>
          <MenuItem value="">All</MenuItem>
          {Object.entries(RENEWAL_STATUS).map(([k, v]) => <MenuItem key={k} value={k}>{v.label} ({counts.renewal?.[k] || 0})</MenuItem>)}
        </TextField>
        <Tooltip title="Refresh"><IconButton onClick={load} aria-label="Refresh customers"><RefreshIcon /></IconButton></Tooltip>
        <Button variant="contained" startIcon={<AddIcon />} onClick={() => setCreating(true)}>New client</Button>
      </Stack>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      <Card variant="outlined">
        {loading ? <LinearProgress /> : <Box sx={{ height: 4 }} />}
        <TableContainer sx={{ maxHeight: { md: 'calc(100vh - 360px)' } }}>
          <Table size="small" stickyHeader aria-label="Customers and subscriptions">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
                <TableCell>Client</TableCell><TableCell>Subscription plan</TableCell><TableCell>Licence status</TableCell>
                <TableCell>Activation</TableCell><TableCell>Issue date</TableCell><TableCell>Expiry date</TableCell>
                <TableCell>Installation ID</TableCell><TableCell>Renewal</TableCell><TableCell align="right">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((r) => {
                const l = r.licence;
                const act = l ? activationMeta(l, local) : null;
                const ren = RENEWAL_STATUS[r.renewal_status] || RENEWAL_STATUS.NONE;
                return (
                  <TableRow key={r.id} hover sx={{ cursor: 'pointer' }} onClick={() => setOpenId(r.id)}>
                    <TableCell sx={{ maxWidth: 220 }}>
                      <Typography variant="body2" fontWeight={600} noWrap title={r.name}>{r.name}</Typography>
                      <Typography variant="caption" color="text.secondary" noWrap component="div">
                        {r.client_code}{r.owner_name ? ` · ${r.owner_name}` : ''}{r.phone ? ` · ${r.phone}` : ''}
                      </Typography>
                    </TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {l ? l.subscription : '—'}
                      {l && <Typography variant="caption" display="block" color="text.secondary" sx={{ fontFamily: 'monospace' }}>{l.lic_id}</Typography>}
                    </TableCell>
                    <TableCell><StatusChips lic={l} local={local} /></TableCell>
                    <TableCell>{act ? <Chip size="small" variant="outlined" label={act.label} color={act.color} title={act.hint} /> : '—'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>{l ? fmtDate(l.issued_at) : '—'}</TableCell>
                    <TableCell sx={{ whiteSpace: 'nowrap' }}>
                      {!l ? '—' : (l.lifetime ? 'Never (lifetime)' : fmtDate(l.expires_on))}
                      {l && !l.lifetime && (
                        <Typography variant="caption" display="block" color={l.days_left !== null && l.days_left <= 30 ? 'warning.main' : 'text.secondary'}>{daysLeftText(l)}</Typography>
                      )}
                    </TableCell>
                    <TableCell sx={{ fontFamily: 'monospace', fontSize: 12, whiteSpace: 'nowrap' }} title={l?.install_id || ''}>
                      {l?.install_id ? shortInstall(l.install_id) : (l ? 'Not yet' : '—')}
                    </TableCell>
                    <TableCell><Chip size="small" variant="outlined" label={ren.label} color={ren.color} /></TableCell>
                    <TableCell align="right" sx={{ whiteSpace: 'nowrap' }} onClick={(e) => e.stopPropagation()}>
                      {l && l.key_available !== false && l.status !== 'REVOKED' && (
                        <Tooltip title="Copy licence key"><IconButton size="small" aria-label={`Copy licence key of ${r.name}`} onClick={() => copyLicenceKey(l)}><CopyIcon fontSize="inherit" /></IconButton></Tooltip>
                      )}
                      <Button size="small" onClick={() => setOpenId(r.id)} aria-label={`Manage ${r.name}`}>Manage</Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!loading && !rows.length && (
                <TableRow><TableCell colSpan={9} align="center" sx={{ py: 4, color: 'text.secondary' }}>
                  {query || status || renewal ? 'No client matches these filters.' : 'No clients yet — use “New client”.'}
                </TableCell></TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Card>
      {openId && <ClientDialog clientId={openId} catalog={catalog} plans={plans} onClose={() => { setOpenId(null); load(); }} onChanged={load} />}
      {creating && <NewLicenceDialog onClose={() => { setCreating(false); load(); }} onCreated={() => load()} />}
    </Box>
  );
}
