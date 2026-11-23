// One licence: terms, binding, signature check, issuance history and audit, and the Vendor Super
// Admin's actions. Renew and Change plan always show the server's preview (what changes, usage
// above new limits) and need an explicit confirmation; nothing is ever deleted when limits drop.
import React, { useCallback, useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Checkbox, Chip, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle, Divider,
  FormControlLabel, Grid, MenuItem, Stack, Tab, Table, TableBody, TableCell, TableHead, TableRow, Tabs, TextField,
  Typography,
} from '@mui/material';
import { apiErrorMessage } from '../../../utils/apiError';
import { notify } from '../../../utils/notify';
import { copy, fmtDate, fmtDateTime, isReauth } from '../clientApi';
import {
  CYCLE_LABEL, EDITION_LABEL, LICENCE_STATUS, LIC_API, LIMITS, RENEWAL_STATUS, activationMeta, bindingText, changeTone,
  changeValue, daysLeftText, durationText, limitText,
} from './licenceApi';
import KeyReveal from './KeyReveal';
import CustomerTermsFields, { termsBody, termsErrors, termsFromSource } from './CustomerTermsFields';
import NewLicenceDialog from './NewLicenceDialog';

function Preview({ preview }) {
  if (!preview) return null;
  return (
    <Box sx={{ mt: 1 }}>
      {preview.classification && preview.classification !== preview.kind && (
        <Chip size="small" sx={{ mb: 1 }} label={preview.classification}
          color={{ UPGRADE: 'success', DOWNGRADE: 'warning' }[preview.classification] || 'default'} />
      )}
      {preview.changes?.length ? (
        <Table size="small" aria-label="Changes">
          <TableHead><TableRow><TableCell>Change</TableCell><TableCell>Now</TableCell><TableCell>After</TableCell></TableRow></TableHead>
          <TableBody>
            {preview.changes.map((c) => (
              <TableRow key={`${c.field}-${c.label}`}>
                <TableCell>{c.label}</TableCell>
                <TableCell>{changeValue(c.from)}</TableCell>
                <TableCell sx={{ color: changeTone(c.direction), fontWeight: 600 }}>{changeValue(c.to)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : <Typography variant="body2">No term changes.</Typography>}
      {(preview.warnings || []).map((w) => <Alert key={w} severity="warning" sx={{ mt: 1 }}>{w}</Alert>)}
    </Box>
  );
}

function ActionPanel({ lic, action, plans, catalog, onDone, onCancel }) {
  const [form, setForm] = useState({ periods: 1, plan_id: '', restart_period: false, reason: '', confirm_lic_id: '',
    installation: '', clear_binding: false, code: '', starts_on: lic.starts_on || '' });
  // Windows Local Super Admin: renew may also change this customer's users / branches / modules.
  const [terms, setTerms] = useState(null);
  const canChangeTerms = action === 'renew' && catalog?.local && lic.edition === 'WINDOWS_LOCAL';
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (k, v) => { setForm((f) => ({ ...f, [k]: v })); setPreview(null); setError(''); };
  const needsPreview = action === 'renew' || action === 'change-plan';
  const path = `${LIC_API}licences/${lic.id}/${action}/`;

  const body = (confirm) => {
    if (action === 'renew') {
      return { periods: Number(form.periods) || 1, reason: form.reason, confirm, ...(terms ? { terms: termsBody(terms) } : {}) };
    }
    if (action === 'change-plan') return { plan_id: form.plan_id, restart_period: form.restart_period, reason: form.reason, confirm };
    if (action === 'revoke') return { reason: form.reason, confirm_lic_id: form.confirm_lic_id };
    if (action === 'replace-key') return { reason: form.reason, installation: form.installation, clear_binding: form.clear_binding };
    if (action === 'bind') return { installation: form.installation };
    if (action === 'record-activation') return { code: form.code, reason: form.reason };
    if (action === 'change-start') return { starts_on: form.starts_on, reason: form.reason };
    return { reason: form.reason };
  };
  const run = async (confirm) => {
    const termErr = termsErrors(terms);
    if (Object.keys(termErr).length) { setError(Object.values(termErr).join(' ')); return; }
    setBusy(true); setError('');
    try {
      const { data } = await axios.post(path, body(confirm));
      if (needsPreview && !confirm) setPreview(data.preview);
      else onDone(data);
    } catch (err) {
      if (!isReauth(err)) setError(apiErrorMessage(err, 'The action failed.'));
    } finally {
      setBusy(false);
    }
  };

  const titles = { renew: 'Renew licence', 'change-plan': 'Upgrade / change plan', suspend: 'Suspend licence',
    reactivate: 'Reactivate licence', revoke: 'Revoke licence (permanent)', 'replace-key': 'Generate replacement key',
    bind: 'Bind installation & generate key', 'record-activation': 'Record activation',
    'change-start': 'Change start date' };
  const samePlans = plans.filter((p) => p.edition === lic.edition && p.id !== lic.plan.id);
  return (
    <Box sx={{ border: 1, borderColor: action === 'revoke' ? 'error.main' : 'divider', borderRadius: 1, p: 2, mt: 2 }}>
      <Typography variant="subtitle2" fontWeight={700} gutterBottom>{titles[action]}</Typography>
      <Grid container columnSpacing={2}>
        {action === 'renew' && (
          <Grid item xs={12} sm={4}>
            <TextField fullWidth size="small" type="number" label={`Periods (${durationText(lic.billing_cycle, lic.duration)} each)`}
              value={form.periods} inputProps={{ min: 1, max: 36 }} onChange={(e) => set('periods', e.target.value)} />
          </Grid>
        )}
        {canChangeTerms && (
          <Grid item xs={12}>
            <FormControlLabel control={(
              <Checkbox checked={Boolean(terms)} onChange={(e) => { setTerms(e.target.checked ? termsFromSource(lic) : null); setPreview(null); }} />
            )} label={<Typography variant="body2">Also change this customer&apos;s edition, limits or modules</Typography>} />
            {terms && (
              <CustomerTermsFields catalog={catalog} value={terms} showExpiry
                onChange={(t) => { setTerms(t); setPreview(null); }} />
            )}
          </Grid>
        )}
        {action === 'change-plan' && (
          <>
            <Grid item xs={12} sm={7}>
              <TextField select fullWidth size="small" label="New plan" value={form.plan_id} onChange={(e) => set('plan_id', e.target.value)}>
                {samePlans.map((p) => <MenuItem key={p.id} value={p.id}>{p.name} · {CYCLE_LABEL[p.billing_cycle]}</MenuItem>)}
              </TextField>
            </Grid>
            <Grid item xs={12} sm={5}>
              <FormControlLabel control={<Checkbox checked={form.restart_period} onChange={(e) => set('restart_period', e.target.checked)} />}
                label={<Typography variant="body2">Start a new period today</Typography>} />
            </Grid>
          </>
        )}
        {action === 'bind' && (
          <Grid item xs={12}>
            <TextField fullWidth size="small" multiline maxRows={4} autoFocus label="Customer's Installation ID or installation request code"
              value={form.installation} onChange={(e) => set('installation', e.target.value)}
              helperText="The customer copies it from G OPTICALS → Licence Details. The key is signed for that installation only and activates offline there." />
          </Grid>
        )}
        {action === 'change-start' && (
          <Grid item xs={12} sm={6}>
            <TextField fullWidth size="small" type="date" label="New start date" InputLabelProps={{ shrink: true }}
              value={form.starts_on} onChange={(e) => set('starts_on', e.target.value)}
              helperText="The expiry date moves with it by the plan's duration. A new key is signed; the customer pastes it." />
          </Grid>
        )}
        {action === 'record-activation' && (
          <Grid item xs={12}>
            <TextField fullWidth size="small" multiline maxRows={4} autoFocus label="Activation confirmation code (GTA1…)"
              value={form.code} onChange={(e) => set('code', e.target.value)}
              helperText="Shown on the customer's Licence Details page after activation. No code? Leave it blank and give a reason below to confirm by hand." />
          </Grid>
        )}
        {action === 'replace-key' && lic.edition === 'WINDOWS_LOCAL' && (
          <>
            <Grid item xs={12}>
              <TextField fullWidth size="small" multiline maxRows={3} label="Move to installation (ID or request code, optional)"
                value={form.installation} onChange={(e) => set('installation', e.target.value)}
                helperText="Blank keeps the current binding. Moving voids the old installation's licence at its next check-in." />
            </Grid>
            {lic.install_id && (
              <Grid item xs={12}>
                <FormControlLabel control={<Checkbox checked={form.clear_binding} disabled={Boolean(form.installation)}
                  onChange={(e) => set('clear_binding', e.target.checked)} />}
                label={<Typography variant="body2">Unbind (the next online activation binds it)</Typography>} />
              </Grid>
            )}
          </>
        )}
        <Grid item xs={12}>
          {action !== 'bind' && (
            <TextField fullWidth size="small" label={['suspend', 'reactivate', 'revoke', 'replace-key', 'change-start'].includes(action) ? 'Reason (required)'
              : (action === 'record-activation' ? 'Reason (only when confirming by hand)' : 'Note (optional)')}
              value={form.reason} onChange={(e) => set('reason', e.target.value)} sx={{ mt: 1 }} inputProps={{ maxLength: 1000 }} />
          )}
        </Grid>
        {action === 'revoke' && (
          <Grid item xs={12}>
            <TextField fullWidth size="small" label={`Type ${lic.lic_id} to confirm`} value={form.confirm_lic_id} sx={{ mt: 1 }}
              onChange={(e) => set('confirm_lic_id', e.target.value)}
              helperText="Revocation is permanent. The customer's data is never deleted; their installation becomes read-only." />
          </Grid>
        )}
      </Grid>
      {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
      <Preview preview={preview} />
      <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1.5 }}>
        <Button onClick={onCancel} disabled={busy}>Cancel</Button>
        {needsPreview && !preview ? (
          <Button variant="outlined" onClick={() => run(false)} disabled={busy || (action === 'change-plan' && !form.plan_id)}>
            Show changes
          </Button>
        ) : (
          <Button variant="contained" color={action === 'revoke' ? 'error' : 'primary'} onClick={() => run(true)} disabled={busy}
            startIcon={busy ? <CircularProgress size={16} color="inherit" /> : null}>
            {needsPreview ? 'Confirm and sign new licence' : titles[action]}
          </Button>
        )}
      </Stack>
    </Box>
  );
}

export default function LicenceDetailDialog({ licenceId, plans, catalog, onClose, onChanged, initialAction = null }) {
  const [lic, setLic] = useState(null);
  const [error, setError] = useState('');
  const [action, setAction] = useState(initialAction);
  const [tab, setTab] = useState(0);
  const [fresh, setFresh] = useState(null);
  const [newSubscription, setNewSubscription] = useState(false);

  const load = useCallback(() => axios.get(`${LIC_API}licences/${licenceId}/`).then(({ data }) => { setLic(data); setError(''); })
    .catch((err) => setError(apiErrorMessage(err, 'Could not load the licence.'))), [licenceId]);
  useEffect(() => { load(); }, [load]);

  const copyKey = async () => {
    try {
      const { data } = await axios.post(`${LIC_API}licences/${licenceId}/key/`, {});
      copy(data.key);
      load();
    } catch (err) {
      if (!isReauth(err)) notify(apiErrorMessage(err, 'Could not read the key.'), 'error');
    }
  };
  const done = (data) => {
    setAction(null);
    setFresh(data.key ? data : null);
    notify(`${data.lic_id}: saved (revision ${data.revision}).`, 'success');
    load();
    onChanged?.();
  };

  if (!lic) {
    return (
      <Dialog open onClose={onClose} maxWidth="md" fullWidth>
        <DialogContent>{error ? <Alert severity="error">{error}</Alert> : <CircularProgress size={24} />}</DialogContent>
      </Dialog>
    );
  }
  const st = LICENCE_STATUS[lic.effective_status] || LICENCE_STATUS.ACTIVE;
  const local = Boolean(catalog?.local) && lic.edition === 'WINDOWS_LOCAL';
  const act = activationMeta(lic, local);
  const revoked = lic.status === 'REVOKED';
  const ren = RENEWAL_STATUS[lic.renewal_status] || null;
  const actions = [
    ['bind', 'Bind installation', local && !revoked && !lic.install_id],
    ['record-activation', 'Record activation', local && !revoked && Boolean(lic.install_id) && !lic.activated_at],
    ['renew', 'Renew', !revoked && !lic.lifetime],
    ['change-start', 'Change start date', local && !revoked],
    ['change-plan', 'Upgrade plan', !revoked],
    ['suspend', 'Suspend', lic.status === 'ACTIVE'],
    ['reactivate', 'Reactivate', lic.status === 'SUSPENDED'],
    ['replace-key', 'Replacement key', !revoked],
    ['revoke', 'Revoke', !revoked],
  ];
  return (
    <Dialog open onClose={onClose} maxWidth="lg" fullWidth aria-labelledby="licence-detail-title">
      <DialogTitle id="licence-detail-title">
        {local ? 'Subscription' : 'Licence'} {lic.lic_id}{' '}
        <Chip size="small" label={st.label} color={st.color} />{' '}
        <Chip size="small" variant="outlined" label={EDITION_LABEL[lic.edition]} />{' '}
        {lic.development_key && <Chip size="small" color="warning" variant="outlined" label="Development key" />}
      </DialogTitle>
      <DialogContent dividers>
        {lic.status_reason && <Alert severity={revoked ? 'error' : 'warning'} sx={{ mb: 2 }}>{lic.status} — {lic.status_reason}</Alert>}
        {!lic.signature?.valid && <Alert severity="error" sx={{ mb: 2 }}>Signature check failed: {lic.signature?.error}</Alert>}
        {fresh && (
          <Alert severity="success" sx={{ mb: 2, '& .MuiAlert-message': { width: '100%', minWidth: 0 } }} onClose={() => setFresh(null)}>
            <KeyReveal licence={fresh} note={local
              ? 'Signed licence key for this customer\'s installation. Send it to the customer: they paste it in Licence Details → Activate (offline).'
              : 'New signed licence. Send it to the customer (an online installation also receives it at its next check-in).'} />
          </Alert>
        )}
        <Grid container spacing={3}>
          <Grid item xs={12} md={6}>
            <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.6, m: 0, fontSize: 14 }}>
              <dt>Client</dt><dd style={{ margin: 0 }}>{lic.client.name} ({lic.client.client_code})</dd>
              {lic.tier && <><dt>Edition</dt><dd style={{ margin: 0 }}>{lic.tier}</dd></>}
              <dt>Plan</dt><dd style={{ margin: 0 }}>{lic.subscription || lic.plan.name} · {durationText(lic.billing_cycle, lic.duration)}</dd>
              {ren && <><dt>Renewal</dt><dd style={{ margin: 0 }}><Chip size="small" variant="outlined" label={ren.label} color={ren.color} /></dd></>}
              <dt>Start</dt><dd style={{ margin: 0 }}>{fmtDate(lic.starts_on)}</dd>
              <dt>Expiry</dt><dd style={{ margin: 0 }}>{lic.lifetime ? 'Lifetime' : fmtDate(lic.expires_on)} · {daysLeftText(lic)}</dd>
              {[...LIMITS, ...(local ? [['branches_per_company', 'Branches per company']] : [])]
                .filter(([k]) => !(lic.edition === 'CLOUD' && k === 'clients')).map(([k, label]) => (
                <React.Fragment key={k}>
                  <dt>{label}</dt>
                  <dd style={{ margin: 0 }}>{limitText(lic.limits?.[k])}{lic.usage?.[k] !== undefined ? ` · ${lic.usage[k]} in use` : ''}</dd>
                </React.Fragment>
              ))}
              <dt>Modules</dt><dd style={{ margin: 0 }}>{(lic.modules || []).join(', ')}</dd>
            </Box>
          </Grid>
          <Grid item xs={12} md={6}>
            <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 2, rowGap: 0.6, m: 0, fontSize: 14 }}>
              <dt>Activation</dt><dd style={{ margin: 0 }}><Chip size="small" label={act.label} color={act.color} title={act.hint} /></dd>
              <dt>Binding</dt><dd style={{ margin: 0, wordBreak: 'break-all' }} title={lic.install_id}>{lic.install_id || bindingText(lic)}{lic.hardware_bound ? ' (+ machine fingerprint)' : ''}</dd>
              <dt>Activated</dt><dd style={{ margin: 0 }}>{fmtDateTime(lic.activated_at)}</dd>
              <dt>Last check-in</dt><dd style={{ margin: 0 }}>{fmtDateTime(lic.last_checkin_at)}</dd>
              <dt>Revision</dt><dd style={{ margin: 0 }}>{lic.revision} · signed {fmtDateTime(lic.issued_at)} with {lic.key_id}</dd>
              <dt>Signature</dt><dd style={{ margin: 0 }}>{lic.signature?.valid ? 'Verified' : 'Not verified'}</dd>
              <dt>Key</dt><dd style={{ margin: 0, fontFamily: 'monospace' }}>{lic.key_masked}</dd>
            </Box>
            {lic.key_available === false ? (
              <Alert severity="warning" sx={{ mt: 1 }}>
                No key yet: waiting for the customer&apos;s Installation ID. Use <b>Bind installation</b> when they send it.
              </Alert>
            ) : <Button size="small" sx={{ mt: 1 }} onClick={copyKey}>Copy licence key</Button>}
          </Grid>
        </Grid>
        <Divider sx={{ my: 2 }} />
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap>
          {actions.filter(([, , on]) => on).map(([key, label]) => (
            <Button key={key} size="small" variant={action === key ? 'contained' : 'outlined'}
              color={key === 'revoke' ? 'error' : (key === 'suspend' ? 'warning' : 'primary')} onClick={() => setAction(key)}>
              {label}
            </Button>
          ))}
          {local && (
            <Button size="small" variant="outlined" onClick={() => setNewSubscription(true)}>New subscription</Button>
          )}
        </Stack>
        {action && <ActionPanel key={action} lic={lic} action={action} plans={plans} catalog={catalog} onDone={done} onCancel={() => setAction(null)} />}
        {newSubscription && (
          <NewLicenceDialog existingClient={lic.client} installation={lic.install_id}
            onClose={() => { setNewSubscription(false); onChanged?.(); }} onCreated={() => onChanged?.()} />
        )}
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mt: 2 }}>
          <Tab label={`History (${lic.issuances?.length || 0})`} /><Tab label={`Audit (${lic.audit?.length || 0})`} />
        </Tabs>
        {tab === 0 ? (
          <Table size="small">
            <TableHead><TableRow><TableCell>Rev</TableCell><TableCell>Reason</TableCell><TableCell>Status</TableCell><TableCell>Expiry</TableCell><TableCell>Installation</TableCell><TableCell>Signed</TableCell></TableRow></TableHead>
            <TableBody>
              {(lic.issuances || []).map((i) => (
                <TableRow key={i.revision}>
                  <TableCell>{i.revision}</TableCell><TableCell>{i.reason}</TableCell><TableCell>{i.status}</TableCell>
                  <TableCell>{i.expires_on ? fmtDate(i.expires_on) : 'Lifetime'}</TableCell>
                  <TableCell title={i.install_id}>{i.install_id ? `${i.install_id.slice(0, 8)}…` : '—'}</TableCell>
                  <TableCell>{fmtDateTime(i.issued_at)} · {i.issued_by}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <Table size="small">
            <TableHead><TableRow><TableCell>When</TableCell><TableCell>Action</TableCell><TableCell>By</TableCell><TableCell>Reason / details</TableCell></TableRow></TableHead>
            <TableBody>
              {(lic.audit || []).map((a) => (
                <TableRow key={a.id}>
                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{fmtDateTime(a.created_at)}</TableCell><TableCell>{a.action}</TableCell>
                  <TableCell>{a.actor}{a.ip ? ` · ${a.ip}` : ''}</TableCell>
                  <TableCell sx={{ maxWidth: 420, wordBreak: 'break-word' }}>{a.reason}{a.details?.error ? ` ${a.details.error}` : ''}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DialogContent>
      <DialogActions><Button onClick={onClose}>Close</Button></DialogActions>
    </Dialog>
  );
}
