// Windows local edition: Licence Details. The server decides everything; this page only displays
// the verdict (status, plan, edition, expiry, days left, limits with usage, modules) and forwards the
// installation admin's actions: paste a licence key → Activate, import a licence file (same rules),
// check with the vendor, copy the Installation ID / installation request code for the vendor.
// Nothing here lets the customer change the plan, period, limits or modules: those come only from
// the vendor's signature.
import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, Box, Button, Card, CardContent, Chip, Grid, Stack, TextField, Typography,
} from '@mui/material';
import { notify } from '../utils/notify';

const COLORS = { PERMANENT: 'success', VALID: 'success', EVALUATION: 'info', GRACE: 'warning', REVOKED: 'error', EXPIRED: 'error',
  EVALUATION_ENDED: 'error', INVALID: 'error', SUSPENDED: 'error' };
const STATUS_TEXT = { PERMANENT: 'PERMANENT', VALID: 'Active', EVALUATION: 'Evaluation', GRACE: 'Grace period', REVOKED: 'Revoked',
  EXPIRED: 'Expired', EVALUATION_ENDED: 'Evaluation ended', INVALID: 'Invalid', SUSPENDED: 'Suspended' };
const EDITION_TEXT = { WINDOWS_LOCAL: 'Windows Local Edition', EVALUATION: 'Evaluation' };
const CYCLE_TEXT = { MONTHLY: 'Monthly subscription', YEARLY: 'Yearly subscription', LIFETIME: 'Lifetime licence' };
const TIER_TEXT = { STANDARD: 'Standard', PROFESSIONAL: 'Professional', ENTERPRISE: 'ENTERPRISE' };
// Subscription period in words: monthly plans of 3 / 6 months are quarterly / half-yearly.
export function cycleText(plan) {
  if (!plan) return '';
  const n = Number(plan.duration || 1);
  if (plan.cycle === 'MONTHLY') {
    return { 1: 'Monthly subscription', 3: 'Quarterly subscription', 6: 'Half-yearly subscription' }[n] || `${n}-month subscription`;
  }
  if (plan.cycle === 'YEARLY') return n === 1 ? 'Yearly subscription' : `${n}-year subscription`;
  return CYCLE_TEXT[plan.cycle] || '';
}
const LIMIT_ROWS = [
  ['clients', 'Clients (Client Management)'], ['companies', 'Companies'], ['branches_total', 'Branches (total)'],
  ['branches_per_company', 'Branches per company'], ['users', 'Named users'],
];
const MODULE_TEXT = { optical: 'Optical Services', sales: 'Sales', wholesale: 'Wholesale', inventory: 'Inventory',
  purchase: 'Purchase', accounts: 'Accounts (Basic)', financial: 'Financial (Enterprise)', admin: 'Administration',
  reports: 'Reports', settings: 'Settings' };

const errorText = (e) => e?.response?.data?.error || e?.response?.data?.detail || e?.message || 'Failed';
const day = (iso) => (iso ? String(iso).slice(0, 10) : '');

const copyText = (text, what) => navigator.clipboard?.writeText(text)
  .then(() => notify(`${what} copied.`, 'success'), () => notify('Could not copy — select the text instead.', 'warning'));

function limitValue(lic, key) {
  if (lic.platform_owner) return 'UNLIMITED';
  if ((lic.unlimited || []).includes(key)) return 'Unlimited';
  const v = (lic.limits || {})[key];
  if (v === undefined || v === null || v === '') return lic.v2 ? 'Unlimited' : (key === 'companies' ? '—' : 'Unlimited');
  return String(v);
}

export default function LicensePage() {
  const [lic, setLic] = useState(null);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const [request, setRequest] = useState(null);
  const [owner, setOwner] = useState(null);  // Local Super Admin only: platform-owner licence availability

  const load = () => axios.get('/api/licensing/status/').then((r) => setLic(r.data)).catch((e) => setMsg({ type: 'error', text: errorText(e) }));
  useEffect(() => {
    load();
    axios.get('/api/licensing/platform-owner/').then((r) => setOwner(r.data)).catch(() => setOwner(null));
  }, []);

  const run = async (fn, ok) => {
    setBusy(true); setMsg(null);
    try {
      const r = await fn();
      setLic(r.data);
      const text = typeof ok === 'function' ? ok(r.data) : ok;
      setMsg({ type: r.data.read_only ? 'warning' : 'success', text: r.data.read_only ? r.data.message : text });
      if (!r.data.read_only) setKey('');
    } catch (e) {
      setMsg({ type: 'error', text: errorText(e) });
    }
    setBusy(false);
  };
  const activated = (d) => `Licence activated: ${d.plan?.name || d.edition} ${d.lifetime ? '(lifetime)' : `valid until ${day(d.expires_on || d.valid_until)}`}.`;
  const importFile = (ev) => {
    const file = ev.target.files?.[0];
    if (!file) return;
    file.text().then((text) => run(() => axios.post('/api/licensing/import/', { license: text }), activated));
    ev.target.value = '';
  };
  const loadRequest = () => axios.post('/api/licensing/request/', {}).then((r) => setRequest(r.data))
    .catch((e) => setMsg({ type: 'error', text: errorText(e) }));

  if (!lic) return <Box p={3}>{msg ? <Alert severity="error">{msg.text}</Alert> : 'Loading licence…'}</Box>;
  const usage = lic.usage || {};
  const po = !!lic.platform_owner && lic.status === 'VALID';
  const shownStatus = po ? 'PERMANENT' : lic.status;
  const daysLeft = po ? 'UNLIMITED' : (lic.lifetime ? 'Never expires' : (lic.days_left != null ? `${Math.max(lic.days_left, 0)} days` : '—'));
  const expiry = po ? 'NEVER' : (lic.lifetime ? 'Lifetime (no expiry)' : (day(lic.expires_on) || day(lic.valid_until) || 'No expiry'));
  const edition = lic.tier ? `${TIER_TEXT[lic.tier] || lic.tier}${po ? '' : ` · ${EDITION_TEXT[lic.edition] || lic.edition}`}`
    : (EDITION_TEXT[lic.edition] || lic.edition || '—');
  const lapsed = ['EXPIRED', 'GRACE'].includes(lic.status) && lic.v2 && !lic.lifetime;
  const rows = [
    ['Status', <Chip key="s" size="small" label={STATUS_TEXT[shownStatus] || shownStatus} color={COLORS[shownStatus] || 'default'} />],
    ['Plan', po ? 'PLATFORM OWNER / LIFETIME' : (lic.plan ? `${lic.plan.name}${cycleText(lic.plan) ? ` · ${cycleText(lic.plan)}` : ''}` : (lic.status === 'EVALUATION' || lic.status === 'EVALUATION_ENDED' ? 'Evaluation' : (lic.license_type || '—')))],
    ['Edition', edition],
    ['Licensed to', lic.client ? `${lic.client.name} (${lic.client.id})` : (lic.customer || '—')],
    ['Licence ID', lic.lic_id ? `${lic.lic_id}${lic.revision ? ` · revision ${lic.revision}` : ''}` : '—'],
    ['Start date', day(lic.starts_on) || '—'],
    ['Expiry date', expiry],
    ['Days remaining', daysLeft],
    ['Installation ID', lic.install_id || '—'],
  ];

  return (
    <Box p={3} maxWidth={980}>
      <Typography variant="h5" gutterBottom>Licence Details <Button size="small" href="#/server-backups">Server backups</Button></Typography>
      {msg && <Alert severity={msg.type} sx={{ mb: 2 }} onClose={() => setMsg(null)}>{msg.text}</Alert>}
      <Card sx={{ mb: 2 }}><CardContent>
        <Stack direction="row" spacing={1} alignItems="center" mb={1} flexWrap="wrap" useFlexGap>
          {lic.development && <Chip label="Development licence" color="warning" variant="outlined" />}
          {lic.read_only && <Chip label="Read-only" color="error" variant="outlined" />}
        </Stack>
        <Typography sx={{ mb: 1 }}>{lic.message}</Typography>
        {lapsed && (
          <Alert severity={lic.status === 'EXPIRED' ? 'error' : 'warning'} sx={{ mb: 1 }}>
            Your subscription {lic.status === 'EXPIRED' ? 'expired' : 'ends'} on {day(lic.expires_on)}. All your data, transactions and
            records are kept safe{lic.read_only ? ' and can still be viewed, printed and backed up' : ''}. Ask your vendor for a
            renewal licence key and paste it below to continue.
          </Alert>
        )}
        {(lic.warnings || []).map((w) => <Typography key={w} color="warning.main">{w}</Typography>)}
        <Box component="dl" sx={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', columnGap: 3, rowGap: 0.75, m: 0, mt: 1, fontSize: 14 }}>
          {rows.map(([label, value]) => (
            <Box key={label} sx={{ display: 'contents' }}>
              <dt style={{ color: '#666' }}>{label}</dt>
              <dd style={{ margin: 0, wordBreak: 'break-all' }}>{value}</dd>
            </Box>
          ))}
        </Box>
        {lic.install_id && (
          <Button size="small" sx={{ mt: 1 }} onClick={() => copyText(lic.install_id, 'Installation ID')}>Copy Installation ID</Button>
        )}
      </CardContent></Card>

      <Grid container spacing={2} sx={{ mb: 2 }}>
        <Grid item xs={12} md={6}>
          <Card sx={{ height: '100%' }}><CardContent>
            <Typography variant="subtitle1" gutterBottom>Limits</Typography>
            {LIMIT_ROWS.filter(([k]) => po || k !== 'branches_per_company' || (lic.limits || {})[k]).map(([k, label]) => (
              <Typography key={k} variant="body2">
                {label}: {usage[k] != null ? `${usage[k]} used of ` : ''}<b>{limitValue(lic, k)}</b>
              </Typography>
            ))}
          </CardContent></Card>
        </Grid>
        <Grid item xs={12} md={6}>
          <Card sx={{ height: '100%' }}><CardContent>
            <Typography variant="subtitle1" gutterBottom>Enabled modules</Typography>
            {po ? <Typography variant="body2"><b>ALL ENABLED</b> (platform administration included)</Typography> : (lic.modules
              ? lic.modules.map((m) => <Chip key={m} size="small" label={MODULE_TEXT[m] || m} sx={{ mr: 0.5, mb: 0.5 }} />)
              : <Typography variant="body2">All modules</Typography>)}
          </CardContent></Card>
        </Grid>
      </Grid>

      {/* The vendor installation receives its permanent owner licence automatically (server:
          apps/licensing/owner.py). This card is only the fallback if that could not run yet. Customer
          installations never have the vendor key, so they never see it. */}
      {owner?.available && !po && (
        <Card sx={{ mb: 2 }}><CardContent>
          <Typography variant="subtitle1" gutterBottom>Platform owner licence (your own installation)</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            This is the vendor installation: it holds your licence signing key, so it is entitled to the permanent
            platform-owner licence (unlimited, every module, never expires), bound to this installation and computer only.
          </Typography>
          <Button variant="contained" color="success" disabled={busy}
            onClick={() => run(() => axios.post('/api/licensing/platform-owner/'), 'Permanent platform-owner licence activated.')}>
            Activate permanent platform-owner licence
          </Button>
        </CardContent></Card>
      )}

      {lic.activation_confirmation && (
        <Card sx={{ mb: 2 }}><CardContent>
          <Typography variant="subtitle1" gutterBottom>Activation confirmation for your vendor</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            Send this code to your vendor so their records show your subscription as activated. It contains only your
            licence ID, client ID and Installation ID.
          </Typography>
          <Box component="code" sx={{ display: 'block', wordBreak: 'break-all', fontSize: 12, p: 1, bgcolor: 'action.hover', borderRadius: 1 }}>
            {lic.activation_confirmation}
          </Box>
          <Button size="small" sx={{ mt: 1 }} onClick={() => copyText(lic.activation_confirmation, 'Activation confirmation code')}>
            Copy confirmation code
          </Button>
        </CardContent></Card>
      )}

      {lic.can_manage === false ? (
        <Alert severity="info">The licence is managed by the Local Super Admin or the installation owner&apos;s administrator.</Alert>
      ) : (
        <Card><CardContent>
          <Typography variant="subtitle1" gutterBottom>Activate a licence</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
            Paste the licence key you received from your vendor. It is checked on this computer (signature, client, edition,
            installation and dates); a key that is not yet bound to an installation is bound once online.
          </Typography>
          <TextField fullWidth multiline minRows={3} maxRows={8} size="small" label="Licence key" value={key}
            onChange={(e) => setKey(e.target.value)} autoComplete="off" placeholder="GTL1.…"
            inputProps={{ spellCheck: false, 'aria-label': 'Licence key', style: { fontFamily: 'monospace', fontSize: 12 } }} />
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1} sx={{ mt: 1.5 }}>
            <Button variant="contained" disabled={busy || !key.trim()}
              onClick={() => run(() => axios.post('/api/licensing/activate/', { key }), activated)}>
              {busy ? 'Checking…' : 'Activate'}
            </Button>
            <Button variant="outlined" component="label" disabled={busy}>
              Import licence file<input hidden type="file" accept=".lic,.txt" onChange={importFile} />
            </Button>
            <Button variant="outlined" disabled={busy || !lic.lic_id || !lic.service_configured}
              title={lic.service_configured ? '' : 'No licence server is configured: renewals arrive as a new key or file'}
              onClick={() => run(() => axios.post('/api/licensing/checkin/'), 'Licence checked with the vendor.')}>
              Check with vendor
            </Button>
          </Stack>
          {lic.activation?.last_checkin_at && (
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
              Last checked with the vendor: {String(lic.activation.last_checkin_at).replace('T', ' ').slice(0, 16)}
              {lic.activation.last_checkin_error ? ` · last attempt failed: ${lic.activation.last_checkin_error}` : ''}
            </Typography>
          )}
          <Box sx={{ mt: 2, pt: 2, borderTop: 1, borderColor: 'divider' }}>
            <Typography variant="subtitle2" gutterBottom>No internet on this computer?</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              Send this installation request code to your vendor. They return a licence key or file bound to this
              computer that activates offline.
            </Typography>
            {request ? (
              <>
                <Box component="code" sx={{ display: 'block', wordBreak: 'break-all', fontSize: 12, p: 1, bgcolor: 'action.hover', borderRadius: 1 }}>
                  {request.request_code}
                </Box>
                <Button size="small" sx={{ mt: 1 }} onClick={() => copyText(request.request_code, 'Installation request code')}>Copy request code</Button>
              </>
            ) : <Button size="small" variant="outlined" onClick={loadRequest}>Show installation request code</Button>}
          </Box>
        </CardContent></Card>
      )}
    </Box>
  );
}
