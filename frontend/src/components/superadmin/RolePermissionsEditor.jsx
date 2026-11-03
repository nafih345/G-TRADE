// Role × module matrix for one client: Full / View / None per cell. Only the client's subscribed
// modules are shown (the rest are off for everyone anyway). The client owner (Super Admin) row is
// locked to Full. Saves the whole map; the server stores only differences from the defaults.
import React, { useEffect, useMemo, useState } from 'react';
import {
  Box, Table, TableHead, TableRow, TableCell, TableBody, TableContainer, Select, MenuItem,
  Button, Stack, Typography, Alert, CircularProgress,
} from '@mui/material';
import { RestartAlt as ResetIcon, Save as SaveIcon } from '@mui/icons-material';

const LEVEL_LABEL = { full: 'Full', view: 'View', none: 'None' };
const LEVEL_COLOR = { full: 'success.main', view: 'info.main', none: 'text.disabled' };

export default function RolePermissionsEditor({ catalog, tenant, onSave, saving }) {
  const [levels, setLevels] = useState(tenant.role_levels);
  useEffect(() => { setLevels(tenant.role_levels); }, [tenant.role_levels]);

  const modules = catalog.modules.filter((m) => tenant.modules.includes(m.key));
  const dirty = useMemo(() => JSON.stringify(levels) !== JSON.stringify(tenant.role_levels), [levels, tenant.role_levels]);

  const set = (role, module, level) => setLevels((l) => ({ ...l, [role]: { ...l[role], [module]: level } }));
  const resetToDefaults = () => setLevels(JSON.parse(JSON.stringify(catalog.default_role_levels)));

  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        <b>Full</b> — open and change · <b>View</b> — open, read only · <b>None</b> — hidden.
        Modules outside the client’s plan are off for every role. Changes apply at each user’s next page load.
      </Typography>
      <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, maxHeight: 460 }}>
        <Table size="small" stickyHeader aria-label="Role permissions">
          <TableHead>
            <TableRow sx={{ '& th': { fontWeight: 700, whiteSpace: 'nowrap' } }}>
              <TableCell>Role</TableCell>
              {modules.map((m) => <TableCell key={m.key} align="center">{m.label}</TableCell>)}
            </TableRow>
          </TableHead>
          <TableBody>
            {catalog.roles.map((r) => (
              <TableRow key={r.key} hover>
                <TableCell sx={{ whiteSpace: 'nowrap', fontWeight: 600 }}>{r.label}</TableCell>
                {modules.map((m) => {
                  const level = levels[r.key]?.[m.key] || 'none';
                  return (
                    <TableCell key={m.key} align="center" sx={{ py: 0.25 }}>
                      {r.owner ? (
                        <Typography variant="caption" color={LEVEL_COLOR.full} fontWeight={700}>Full</Typography>
                      ) : (
                        <Select size="small" variant="standard" disableUnderline value={level} disabled={saving}
                          onChange={(e) => set(r.key, m.key, e.target.value)}
                          inputProps={{ 'aria-label': `${r.label} — ${m.label}` }}
                          sx={{ fontSize: 13, fontWeight: 600, color: LEVEL_COLOR[level] }}>
                          {catalog.levels.map((lv) => <MenuItem key={lv} value={lv}>{LEVEL_LABEL[lv]}</MenuItem>)}
                        </Select>
                      )}
                    </TableCell>
                  );
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </TableContainer>
      {!modules.length && <Alert severity="info" sx={{ mt: 1 }}>Switch on modules first.</Alert>}
      <Stack direction="row" spacing={1} justifyContent="flex-end" sx={{ mt: 1.5 }}>
        <Button startIcon={<ResetIcon />} onClick={resetToDefaults} disabled={saving}>Reset to defaults</Button>
        <Button onClick={() => setLevels(tenant.role_levels)} disabled={!dirty || saving}>Discard</Button>
        <Button variant="contained" disabled={!dirty || saving} onClick={() => onSave(levels)}
          startIcon={saving ? <CircularProgress size={16} color="inherit" /> : <SaveIcon />}>
          Save permissions
        </Button>
      </Stack>
    </Box>
  );
}
