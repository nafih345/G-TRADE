// Client Management → Hosted Workspaces → Manage → Subscription Plans (Windows Local Super Admin).
// The workspace's CURRENT subscription (chosen by the server from validity dates and status), its
// whole history, and every action on the correct client + subscription: new subscription / change
// plan, renew, change start date, bind or change the Installation ID (signed key), copy the key,
// suspend, reactivate, revoke, expiry and renewal status. The actions themselves are the existing
// licence actions (LicenceDetailDialog); this panel only finds the workspace's records.
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Card, CardContent, Chip, CircularProgress, Grid, IconButton, Stack, Table, TableBody, TableCell,
  TableContainer, TableHead, TableRow, Tooltip, Typography,
} from '@mui/material';
import { Add as AddIcon, ContentCopy as CopyIcon } from '@mui/icons-material';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';
import { copy, fmtDate, isReauth, splitErrors } from '../clientApi';
import { LIC_API, RENEWAL_STATUS, activationMeta, daysLeftText } from './licenceApi';
import HostedSubscriptionFields, { SUBSCRIPTION_STATUS, emptySubscription } from './HostedSubscriptionFields';
import LicenceDetailDialog from './LicenceDetailDialog';
import KeyReveal from './KeyReveal';
import { copyLicenceKey } from './CustomerClientsPanel';

const statusOf = (lic) => {
  if (!lic) return 'NONE';
  const s = lic.effective_status;
  if (s === 'PENDING') return 'UPCOMING';
  if (s !== 'ACTIVE') return s;
  if (lic.lifetime) return 'LIFETIME';
  return lic.renewal_status === 'DUE' ? 'RENEWAL_DUE' : 'ACTIVE';
};

function Field({ label, children }) {
  return (
    <>
      <dt style={{ color: '#666' }}>{label}</dt>
      <dd style={{ margin: 0, wordBreak: 'break-all' }}>{children}</dd>
    </>
  );
}

export default function HostedSubscriptionsPanel({ tenant, onChanged }) {
  const [data, setData] = useState(null);
  const [licCatalog, setLicCatalog] = useState(null);
  const [plans, setPlans] = useState([]);
  const [error, setError] = useState('');
  const [openLicence, setOpenLicence] = useState(null);   // {id, action}
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState(emptySubscription);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [fresh, setFresh] = useState(null);

  const load = useCallback(() => axios.get(`${LIC_API}tenants/${tenant.id}/subscriptions/`)
    .then(({ data: d }) => { setData(d); setError(''); })
    .catch((err) => setError(apiErrorMessage(err, 'Could not load the subscriptions.'))), [tenant.id]);
  useEffect(() => {
    load();
    axios.get(`${LIC_API}catalog/`).then(({ data: d }) => setLicCatalog(d)).catch(() => {});
    axios.get(`${LIC_API}plans/`).then(({ data: d }) => setPlans(d)).catch(() => {});
  }, [load]);
  const changed = () => { load(); onChanged?.(); };

  const create = async () => {
    if (!form.plan_id) { setErrors({ plan_id: 'Choose the subscription plan.' }); return; }
    setSaving(true); setErrors({});
    try {
      const { data: lic } = await axios.post(`${LIC_API}licences/`, {
        tenant_id: tenant.id, plan_id: form.plan_id, starts_on: form.starts_on || null, installation: form.installation || '' });
      notify(`Subscription ${lic.lic_id} created for ${tenant.name}.`, 'success');
      setFresh(lic); setCreating(false); setForm(emptySubscription());
      changed();
    } catch (err) {
      if (!isReauth(err)) {
        const { fields, general } = splitErrors(err, ['plan_id', 'starts_on', 'installation'], 'The subscription could not be created.');
        setErrors({ ...fields, ...(general ? { general } : {}) });
      }
    } finally {
      setSaving(false);
    }
  };

  if (error) return <Alert severity="error">{error}</Alert>;
  if (!data) return <CircularProgress size={24} />;
  const current = (data.licences || []).find((l) => l.id === data.current_licence_id) || null;
  const st = SUBSCRIPTION_STATUS[statusOf(current)];
  const ren = current ? (RENEWAL_STATUS[current.renewal_status] || null) : null;
  const act = current ? activationMeta(current, true) : null;
  const signing = licCatalog?.signing;

  return (
    <Box>
      {signing && !signing.configured && (
        <Alert severity="warning" sx={{ mb: 2 }}>Subscriptions cannot be created or signed on this installation: {signing.message}</Alert>
      )}
      {fresh && (
        <Alert severity="success" sx={{ mb: 2, '& .MuiAlert-message': { width: '100%', minWidth: 0 } }} onClose={() => setFresh(null)}>
          Subscription <b>{fresh.lic_id}</b> saved · {fresh.subscription} · {fresh.lifetime ? 'never expires' : `until ${fmtDate(fresh.expires_on)}`}.
          {fresh.key ? <Box sx={{ mt: 1 }}><KeyReveal licence={fresh} /></Box>
            : ' Bind the customer\'s Installation ID to generate the licence key.'}
        </Alert>
      )}

      <Card variant="outlined" sx={{ mb: 2 }}><CardContent>
        <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
          <Typography variant="subtitle1" fontWeight={700}>Current subscription</Typography>
          {st && <Chip label={st.label} color={st.color} />}
        </Stack>
        {!current ? (
          <Typography variant="body2" color="text.secondary">
            {tenant.name} has no subscription yet. Create one below; the client&apos;s details are taken from this workspace.
          </Typography>
        ) : (
          <Grid container spacing={2}>
            <Grid item xs={12} md={7}>
              <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.6, m: 0, fontSize: 14 }}>
                <Field label="Subscription ID">
                  <Box component="span" sx={{ fontFamily: 'monospace', fontWeight: 700 }}>{current.lic_id}</Box>
                  <Tooltip title="Copy Subscription ID"><IconButton size="small" aria-label="Copy Subscription ID" onClick={() => copy(current.lic_id)}><CopyIcon fontSize="inherit" /></IconButton></Tooltip>
                </Field>
                <Field label="Plan">{current.subscription}</Field>
                <Field label="Start date">{fmtDate(current.starts_on)}</Field>
                <Field label="Expiry date">{current.lifetime ? 'Never (Lifetime)' : `${fmtDate(current.expires_on)} · ${daysLeftText(current)}`}</Field>
                <Field label="Renewal">{ren ? <Chip size="small" variant="outlined" label={ren.label} color={ren.color} /> : '—'}</Field>
                <Field label="Enabled modules">{(current.modules || []).join(', ') || '—'}</Field>
              </Box>
            </Grid>
            <Grid item xs={12} md={5}>
              <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.6, m: 0, fontSize: 14 }}>
                <Field label="Installation ID">
                  {current.install_id ? (
                    <>
                      <Box component="span" sx={{ fontFamily: 'monospace' }}>{current.install_id}</Box>
                      <Tooltip title="Copy Installation ID"><IconButton size="small" aria-label="Copy Installation ID" onClick={() => copy(current.install_id)}><CopyIcon fontSize="inherit" /></IconButton></Tooltip>
                    </>
                  ) : <Typography variant="body2" color="warning.main" component="span">Not bound yet</Typography>}
                </Field>
                <Field label="Activation">{act ? <Chip size="small" variant="outlined" label={act.label} color={act.color} title={act.hint} /> : '—'}</Field>
                <Field label="Licence key">{current.key_available === false ? 'Generated when the installation is bound' : current.key_masked}</Field>
                <Field label="Revision">{current.revision}</Field>
              </Box>
            </Grid>
            <Grid item xs={12}>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
                {!current.install_id && current.status !== 'REVOKED' && (
                  <Button size="small" variant="contained" onClick={() => setOpenLicence({ id: current.id, action: 'bind' })}>
                    Bind installation &amp; generate key
                  </Button>
                )}
                {current.install_id && current.status !== 'REVOKED' && (
                  <Button size="small" variant="outlined" onClick={() => setOpenLicence({ id: current.id, action: 'replace-key' })}>
                    Change Installation ID
                  </Button>
                )}
                {current.key_available !== false && current.status !== 'REVOKED' && (
                  <Button size="small" variant="outlined" startIcon={<CopyIcon />} onClick={() => copyLicenceKey(current)}>Copy licence key</Button>
                )}
                {current.status !== 'REVOKED' && !current.lifetime && (
                  <Button size="small" variant="outlined" onClick={() => setOpenLicence({ id: current.id, action: 'renew' })}>Renew</Button>
                )}
                {current.status !== 'REVOKED' && (
                  <Button size="small" variant="outlined" onClick={() => setOpenLicence({ id: current.id, action: 'change-plan' })}>Change plan</Button>
                )}
                {current.status !== 'REVOKED' && (
                  <Button size="small" variant="outlined" onClick={() => setOpenLicence({ id: current.id, action: 'change-start' })}>Change start date</Button>
                )}
                {current.status === 'ACTIVE' && (
                  <Button size="small" variant="outlined" color="warning" onClick={() => setOpenLicence({ id: current.id, action: 'suspend' })}>Suspend</Button>
                )}
                {current.status === 'SUSPENDED' && (
                  <Button size="small" variant="outlined" color="success" onClick={() => setOpenLicence({ id: current.id, action: 'reactivate' })}>Reactivate</Button>
                )}
                {current.status !== 'REVOKED' && (
                  <Button size="small" variant="outlined" color="error" onClick={() => setOpenLicence({ id: current.id, action: 'revoke' })}>Revoke</Button>
                )}
                <Button size="small" onClick={() => setOpenLicence({ id: current.id, action: null })}>All details &amp; audit</Button>
              </Stack>
            </Grid>
          </Grid>
        )}
      </CardContent></Card>

      <Stack direction="row" justifyContent="space-between" alignItems="center" sx={{ mb: 1 }}>
        <Typography variant="subtitle1" fontWeight={700}>Subscription history ({(data.licences || []).length})</Typography>
        <Button size="small" variant="contained" startIcon={<AddIcon />} disabled={!signing?.configured || creating}
          onClick={() => { setCreating(true); setForm({ ...emptySubscription(), installation: current?.install_id || '' }); }}>
          New subscription
        </Button>
      </Stack>
      {creating && (
        <Card variant="outlined" sx={{ mb: 2 }}><CardContent>
          {errors.general && <Alert severity="error" sx={{ mb: 1 }}>{errors.general}</Alert>}
          <HostedSubscriptionFields licCatalog={licCatalog} value={form} onChange={setForm} errors={errors} disabled={saving} />
          <Typography variant="caption" color="text.secondary" display="block">
            The subscription is created for {tenant.name} with this workspace&apos;s enabled modules and limits. A new plan for the
            same client and Installation ID replaces the previous licence on the customer&apos;s PC; their data is kept.
          </Typography>
          <Stack direction="row" justifyContent="flex-end" spacing={1} sx={{ mt: 1 }}>
            <Button onClick={() => setCreating(false)} disabled={saving}>Cancel</Button>
            <Button variant="contained" onClick={create} disabled={saving}>{saving ? 'Saving…' : 'Save subscription'}</Button>
          </Stack>
        </CardContent></Card>
      )}
      <TableContainer>
        <Table size="small" aria-label="Subscription history">
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
              <TableCell>Subscription ID</TableCell><TableCell>Plan</TableCell><TableCell>Status</TableCell>
              <TableCell>Start</TableCell><TableCell>Expiry</TableCell><TableCell>Installation ID</TableCell>
              <TableCell>Issued</TableCell><TableCell align="right" />
            </TableRow>
          </TableHead>
          <TableBody>
            {(data.licences || []).map((l) => {
              const s = SUBSCRIPTION_STATUS[statusOf(l)];
              return (
                <TableRow key={l.id} hover sx={{ opacity: l.status === 'REVOKED' ? 0.6 : 1 }}>
                  <TableCell sx={{ fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                    {l.lic_id}{l.id === data.current_licence_id && <Chip size="small" color="primary" label="Current" sx={{ ml: 1 }} />}
                  </TableCell>
                  <TableCell>{l.subscription}</TableCell>
                  <TableCell><Chip size="small" label={s.label} color={s.color} variant="outlined" /></TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(l.starts_on)}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{l.lifetime ? 'Never' : fmtDate(l.expires_on)}</TableCell>
                  <TableCell sx={{ fontFamily: 'monospace', fontSize: 12 }}>{l.install_id || '—'}</TableCell>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDate(l.issued_at)} · rev {l.revision}</TableCell>
                  <TableCell align="right"><Button size="small" onClick={() => setOpenLicence({ id: l.id, action: null })}>Open</Button></TableCell>
                </TableRow>
              );
            })}
            {!(data.licences || []).length && (
              <TableRow><TableCell colSpan={8} align="center" sx={{ py: 3, color: 'text.secondary' }}>No subscriptions yet.</TableCell></TableRow>
            )}
          </TableBody>
        </Table>
      </TableContainer>
      {openLicence && (
        <LicenceDetailDialog licenceId={openLicence.id} initialAction={openLicence.action} plans={plans} catalog={licCatalog}
          onClose={() => { setOpenLicence(null); changed(); }} onChanged={changed} />
      )}
    </Box>
  );
}
