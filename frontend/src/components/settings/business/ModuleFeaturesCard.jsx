// Settings → Business Settings → "Optional features" (module_access.MODULE_FEATURES, e.g.
// Wholesale Distribution → Wholesale Order Status).
//
// GET/PATCH /api/company/business-settings/module-features/. On the Windows edition the
// installation admin switches them here — fully offline, stored in the local database. Hosted
// clients (and the Windows edition's client companies) see them read-only: their switches live in
// Client Management (platform / Local Super Admin).
import React, { useCallback, useEffect, useState } from 'react';
import { Alert, Box, Card, CircularProgress, Paper, Stack, Switch, Typography } from '@mui/material';
import axios from 'axios';
import { useAuth } from '../../../context/AuthContext';
import { describeApiError } from '../../../utils/apiWriteGuard';
import { notify } from '../../../utils/notify';

const API = '/api/company/business-settings/module-features/';

export default function ModuleFeaturesCard() {
  const { refreshProfile } = useAuth() || {};
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await axios.get(API, { __silentError: true });
      setState(data);
      setError('');
    } catch (e) {
      setError(describeApiError(e, 'Could not load the optional features.'));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const flip = async (key, on) => {
    setSaving(key);
    try {
      const { data } = await axios.patch(API, { [key]: on });
      setState(data);
      notify(`${data.features.find((f) => f.key === key)?.label || 'Feature'} switched ${on ? 'on' : 'off'}.`, 'success');
      // The sidebar / route guard read the profile's module_features.
      if (typeof refreshProfile === 'function') refreshProfile();
    } catch (e) {
      notify(describeApiError(e, 'The feature was not changed.'), 'error');
    } finally {
      setSaving('');
    }
  };

  if (!state && !error) return null;
  return (
    <Card sx={{ p: 3, mt: 3, borderRadius: 4, border: '1px solid', borderColor: 'divider' }}>
      <Typography variant="h6" fontWeight={800} sx={{ mb: 0.5 }}>Optional features</Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        Extra workflows inside a module. Opt-in workflows are off until switched on; built-in ones (such as Bill-to-Bill Settlement) are on until switched off.
      </Typography>
      {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
      {state && !state.can_edit && (
        <Alert severity="info" sx={{ mb: 2, borderRadius: 3 }}>
          These are managed by your platform administrator in {state.managed_in || 'Client Management'}.
        </Alert>
      )}
      <Stack spacing={1.5}>
        {(state?.features || []).map((f) => (
          <Paper key={f.key} variant="outlined" sx={{ p: 2, borderRadius: 3, display: 'flex', alignItems: 'center', gap: 2 }}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography variant="subtitle1" fontWeight={800}>{f.label}</Typography>
              <Typography variant="body2" color="text.secondary">{f.description}</Typography>
              {!f.module_enabled && (
                <Typography variant="caption" color="warning.main" fontWeight={700}>Needs the {(f.modules || [f.module]).join(' or ')} module, which this business doesn’t have.</Typography>
              )}
            </Box>
            {saving === f.key ? <CircularProgress size={22} /> : (
              <Switch checked={Boolean(f.enabled)} disabled={!state.can_edit || !f.module_enabled}
                onChange={(e) => flip(f.key, e.target.checked)} inputProps={{ 'aria-label': f.label }} />
            )}
          </Paper>
        ))}
      </Stack>
    </Card>
  );
}
