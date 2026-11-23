// Create Client → Windows Local Edition (and Licences → New licence): client details (or an
// existing client) → plan & licence → generate. A Windows Local client has no cloud workspace: its
// data lives on its own PC, which activates the generated key. One POST …/licensing/licences/
// saves the client and the signed licence together; the key is then shown with a Copy button.
import React, { useEffect, useState } from 'react';
import axios from 'axios';
import {
  Alert, AlertTitle, Autocomplete, Box, Button, CircularProgress, Dialog, DialogActions, DialogContent, DialogTitle,
  Grid, MenuItem, Step, StepLabel, Stepper, TextField, ToggleButton, ToggleButtonGroup, Typography,
} from '@mui/material';
import { isReauth, splitErrors, todayIso } from '../clientApi';
import { LIC_API } from './licenceApi';
import PlanLicenceStep from './PlanLicenceStep';
import { termsBody, termsErrors } from './CustomerTermsFields';
import KeyReveal from './KeyReveal';

const CLIENT_FIELDS = ['name', 'owner_name', 'email', 'phone', 'country', 'address'];

export function EditionSwitch({ value, onChange, disabled }) {
  return (
    <ToggleButtonGroup exclusive size="small" value={value} disabled={disabled} onChange={(_, v) => v && onChange(v)}
      aria-label="Edition" sx={{ mt: 1 }}>
      <ToggleButton value="CLOUD">Cloud Edition</ToggleButton>
      <ToggleButton value="WINDOWS_LOCAL">Windows Local Edition</ToggleButton>
    </ToggleButtonGroup>
  );
}

export default function NewLicenceDialog({ onClose, onCreated, onSwitchEdition, initialClient, existingClient, installation }) {
  const [catalog, setCatalog] = useState(null);
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState(existingClient ? 'existing' : 'new');
  const [existing, setExisting] = useState(existingClient || null);
  const [clients, setClients] = useState([]);
  const [client, setClient] = useState({ name: '', owner_name: '', email: '', phone: '', country: '', address: '', ...(initialClient || {}) });
  const [terms, setTerms] = useState({ cycle: '', plan_id: '', starts_on: todayIso(), installation: installation || '' });
  const [errors, setErrors] = useState({});
  const [general, setGeneral] = useState('');
  const [saving, setSaving] = useState(false);
  const [created, setCreated] = useState(null);

  useEffect(() => {
    axios.get(`${LIC_API}catalog/`).then(({ data }) => setCatalog(data)).catch(() => setGeneral('Could not load the plans.'));
    axios.get(`${LIC_API}clients/`, { params: { edition: 'WINDOWS_LOCAL' } }).then(({ data }) => setClients(data)).catch(() => {});
  }, []);

  const next = () => {
    if (step === 0) {
      if (mode === 'new' && !client.name.trim()) { setErrors({ name: 'Enter the client name.' }); return; }
      if (mode === 'existing' && !existing) { setErrors({ client: 'Choose the client.' }); return; }
    }
    setErrors({});
    setStep((s) => s + 1);
  };

  const submit = async () => {
    if (!terms.plan_id) { setErrors({ plan_id: 'Choose a plan.' }); return; }
    const termErr = termsErrors(terms.custom);
    if (Object.keys(termErr).length) { setErrors(termErr); return; }
    setSaving(true); setGeneral('');
    try {
      const body = { plan_id: terms.plan_id, starts_on: terms.starts_on || null, installation: terms.installation || '',
        ...(terms.custom ? { terms: termsBody(terms.custom) } : {}),
        ...(mode === 'existing' ? { client_id: existing.id } : { client: Object.fromEntries(CLIENT_FIELDS.map((k) => [k, client[k] || ''])) }) };
      const { data } = await axios.post(`${LIC_API}licences/`, body);
      setCreated(data);
      onCreated?.(data);
    } catch (err) {
      if (isReauth(err)) return;
      // New-client field errors arrive nested: {client: {name: [...]}}.
      const nested = err?.response?.data?.client;
      const clientErrors = nested && typeof nested === 'object' && !Array.isArray(nested)
        ? Object.fromEntries(Object.entries(nested).map(([k, v]) => [k, [].concat(v).join(' ')])) : {};
      const { fields, general: msg } = splitErrors(err, ['plan_id', 'starts_on', 'installation', 'expires_on', 'modules', ...CLIENT_FIELDS],
        'The licence could not be created.');
      const clientMsg = Array.isArray(nested) ? nested.join(' ') : '';
      setErrors({ ...fields, ...clientErrors });
      setGeneral([msg, clientMsg].filter(Boolean).join(' ').replace(/\{.*\}/, '').trim());
      if (Object.keys(clientErrors).length) setStep(0);
    } finally {
      setSaving(false);
    }
  };

  const tf = (key, label, props = {}) => (
    <TextField fullWidth size="small" label={label} value={client[key] ?? ''} disabled={saving}
      onChange={(e) => { setClient((c) => ({ ...c, [key]: e.target.value })); setErrors((x) => ({ ...x, [key]: undefined })); }}
      error={Boolean(errors[key])} helperText={errors[key] || props.helperText || ' '} {...props} />
  );

  return (
    <Dialog open onClose={saving ? undefined : onClose} maxWidth="md" fullWidth aria-labelledby="new-licence-title">
      <DialogTitle id="new-licence-title" sx={{ pb: 1 }}>
        {created ? 'Client and subscription saved' : (existingClient ? `New subscription — ${existingClient.name}` : 'New Client — Windows Local Edition')}
        {!created && onSwitchEdition && (
          <Box><EditionSwitch value="WINDOWS_LOCAL" onChange={(v) => v === 'CLOUD' && onSwitchEdition('CLOUD', client)} disabled={saving} /></Box>
        )}
        {!created && (
          <Stepper activeStep={existingClient ? 1 : step} sx={{ mt: 1.5 }}>
            {['Client', 'Subscription & Licence'].map((l) => <Step key={l}><StepLabel>{l}</StepLabel></Step>)}
          </Stepper>
        )}
      </DialogTitle>
      <DialogContent dividers>
        {general && <Alert severity="error" sx={{ mb: 2 }}>{general}</Alert>}
        {created ? (
          <Alert severity="success" sx={{ '& .MuiAlert-message': { width: '100%', minWidth: 0 } }}>
            <AlertTitle>
              {created.client.name} ({created.client.client_code}) · Licence {created.lic_id}
            </AlertTitle>
            <Typography variant="body2" sx={{ mb: 1 }}>
              {created.subscription || created.plan.name} · {created.lifetime ? 'lifetime' : `valid until ${created.expires_on}`} ·{' '}
              {created.install_id ? `bound to installation ${created.install_id}`
                : (created.key_available === false ? 'waiting for the customer\'s Installation ID' : 'bound on first online activation')}
            </Typography>
            {created.key_available === false ? (
              <Typography variant="body2">
                The subscription is saved. When the customer sends the Installation ID (or installation request code) from their
                {' '}<b>Licence Details</b> page, open the client in <b>Client Management</b> → <b>Bind installation</b>: the key
                {' '}is generated for that installation and activates offline there.
              </Typography>
            ) : <KeyReveal licence={created} />}
          </Alert>
        ) : step === 0 ? (
          <Box>
            <TextField select size="small" label="Client" value={mode} onChange={(e) => setMode(e.target.value)} sx={{ mb: 2, minWidth: 260 }}>
              <MenuItem value="new">New client</MenuItem>
              <MenuItem value="existing" disabled={!clients.length}>Existing Windows Local client</MenuItem>
            </TextField>
            {mode === 'existing' ? (
              <Autocomplete options={clients} value={existing} onChange={(_, v) => setExisting(v)}
                getOptionLabel={(c) => `${c.name} (${c.client_code})`} isOptionEqualToValue={(a, b) => a.id === b.id}
                renderInput={(params) => <TextField {...params} size="small" label="Client" error={Boolean(errors.client)} helperText={errors.client || ' '} />} />
            ) : (
              <Grid container columnSpacing={2}>
                <Grid item xs={12} sm={6}>{tf('name', 'Client / business name', { required: true, autoFocus: true, inputProps: { maxLength: 150 } })}</Grid>
                <Grid item xs={12} sm={6}>{tf('owner_name', 'Owner name', { inputProps: { maxLength: 150 } })}</Grid>
                <Grid item xs={12} sm={6}>{tf('email', 'Email', { type: 'email' })}</Grid>
                <Grid item xs={12} sm={6}>{tf('phone', 'Phone', { inputProps: { maxLength: 20 } })}</Grid>
                <Grid item xs={12} sm={6}>
                  {tf('country', 'Country', {
                    select: true,
                    children: [<MenuItem key="" value="">—</MenuItem>,
                      ...(catalog?.countries || []).map((c) => <MenuItem key={c.code} value={c.code}>{c.name}</MenuItem>)],
                  })}
                </Grid>
                <Grid item xs={12}>{tf('address', 'Address', { multiline: true, minRows: 2, inputProps: { maxLength: 1000 } })}</Grid>
              </Grid>
            )}
          </Box>
        ) : (
          catalog ? <PlanLicenceStep catalog={catalog} edition="WINDOWS_LOCAL" value={terms} onChange={setTerms} errors={errors} disabled={saving} />
            : <CircularProgress size={24} />
        )}
      </DialogContent>
      <DialogActions sx={{ justifyContent: 'space-between' }}>
        <Button onClick={onClose} disabled={saving}>{created ? 'Close' : 'Cancel'}</Button>
        {!created && (
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button disabled={saving || step === 0} onClick={() => setStep(0)}>Back</Button>
            {step === 0 ? <Button variant="contained" onClick={next}>Next</Button> : (
              <Button variant="contained" onClick={submit} disabled={saving || !catalog?.signing?.configured}
                startIcon={saving ? <CircularProgress size={16} color="inherit" /> : null}>
                {saving ? 'Generating…' : (catalog?.local && !(terms.installation || '').trim()
                  ? 'Save client & subscription' : 'Generate licence key & save')}
              </Button>
            )}
          </Box>
        )}
      </DialogActions>
    </Dialog>
  );
}
