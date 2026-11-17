import { useEffect, useState } from 'react';
import axios from 'axios';
import { Box, Button, Card, CardContent, Chip, Stack, TextField, Typography, Alert } from '@mui/material';

// Windows local edition: licence status and activation. The server decides everything; this page
// only displays the verdict and forwards admin actions (activate / import / check now).
const COLORS = { VALID: 'success', EVALUATION: 'info', GRACE: 'warning', REVOKED: 'error', EXPIRED: 'error',
  EVALUATION_ENDED: 'error', INVALID: 'error' };

const errorText = (e) => e?.response?.data?.error || e?.response?.data?.detail || e?.message || 'Failed';

export default function LicensePage() {
  const [lic, setLic] = useState(null);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = () => axios.get('/api/licensing/status/').then((r) => setLic(r.data)).catch((e) => setMsg({ type: 'error', text: errorText(e) }));
  useEffect(() => { load(); }, []);

  const run = async (fn, ok) => {
    setBusy(true); setMsg(null);
    try { const r = await fn(); setLic(r.data); setMsg({ type: 'success', text: ok }); } catch (e) { setMsg({ type: 'error', text: errorText(e) }); }
    setBusy(false);
  };
  const importFile = (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    file.text().then((text) => run(() => axios.post('/api/licensing/import/', { license: text }), 'Licence installed.'));
    ev.target.value = '';
  };

  if (!lic) return <Box p={3}>{msg ? <Alert severity="error">{msg.text}</Alert> : 'Loading licence…'}</Box>;
  const limits = lic.limits || {};
  const usage = lic.usage || {};
  return (
    <Box p={3} maxWidth={900}>
      <Typography variant="h5" gutterBottom>Licence <Button size="small" href="#/server-backups">Server backups</Button></Typography>
      {msg && <Alert severity={msg.type} sx={{ mb: 2 }}>{msg.text}</Alert>}
      <Card sx={{ mb: 2 }}><CardContent>
        <Stack direction="row" spacing={1} alignItems="center" mb={1}>
          <Chip label={lic.status} color={COLORS[lic.status] || 'default'} />
          {lic.edition && <Chip label={lic.edition} variant="outlined" />}
          {lic.development && <Chip label="Development licence" color="warning" variant="outlined" />}
          {lic.read_only && <Chip label="Read-only" color="error" variant="outlined" />}
        </Stack>
        <Typography>{lic.message}</Typography>
        {(lic.warnings || []).map((w) => <Typography key={w} color="warning.main">{w}</Typography>)}
        <Typography variant="body2" color="text.secondary" mt={1}>
          {lic.customer && <>Licensed to <b>{lic.customer}</b> · </>}{lic.lic_id && <>Licence {lic.lic_id} · </>}
          {lic.valid_until ? <>Valid until {String(lic.valid_until).slice(0, 10)}</> : 'No expiry'}
          {lic.updates_until && <> · Updates until {String(lic.updates_until).slice(0, 10)}</>}
          {' · '}Installation {lic.install_id}
        </Typography>
      </CardContent></Card>
      <Card sx={{ mb: 2 }}><CardContent>
        <Typography variant="subtitle1" gutterBottom>Limits</Typography>
        {[['users', 'Named users', usage.users], ['companies', 'Companies', usage.companies],
          ['clients', 'Clients (Client Management)', usage.clients],
          ['branches_total', 'Branches (total)', usage.branches_total], ['branches_per_company', 'Branches per company', null]].map(([k, label, used]) => (
          <Typography key={k}>{label}: {used != null ? `${used} used of ` : ''}{limits[k] ?? 'unlimited'}</Typography>
        ))}
        <Typography>Modules: {lic.modules ? lic.modules.join(', ') : 'all'}</Typography>
      </CardContent></Card>
      {lic.can_manage === false ? (
        <Alert severity="info">The licence is managed by the Local Super Admin or the installation owner&apos;s administrator.</Alert>
      ) : (
      <Card><CardContent>
        <Typography variant="subtitle1" gutterBottom>Activate or renew (Local Super Admin / installation administrator)</Typography>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} mb={2}>
          <TextField size="small" label="Licence key" value={key} onChange={(e) => setKey(e.target.value)} sx={{ flex: 1 }} autoComplete="off" />
          <Button variant="contained" disabled={busy || !key.trim()} onClick={() => run(() => axios.post('/api/licensing/activate/', { key }), 'Licence activated.')}>Activate online</Button>
        </Stack>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1}>
          <Button variant="outlined" component="label" disabled={busy}>Import licence file<input hidden type="file" accept=".lic,.txt" onChange={importFile} /></Button>
          <Button variant="outlined" disabled={busy || !lic.lic_id} onClick={() => run(() => axios.post('/api/licensing/checkin/'), 'Licence checked with the vendor.')}>Check now</Button>
        </Stack>
      </CardContent></Card>
      )}
    </Box>
  );
}
