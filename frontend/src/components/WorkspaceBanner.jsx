// Shown across the top of the app while the platform owner works inside a client's workspace
// (Client Management → "Open workspace"). Everything created in this session belongs to that
// client, so it must be impossible to forget which business you are in.
import React from 'react';
import { Alert, Button } from '@mui/material';
import { useAuth } from '../context/AuthContext';

export default function WorkspaceBanner() {
  const { user, exitWorkspace } = useAuth();
  const ws = user?.workspace;
  if (!ws) return null;
  return (
    <Alert severity="warning" variant="filled" square
      sx={{ borderRadius: 0, py: 0.25, alignItems: 'center', '& .MuiAlert-message': { fontWeight: 600 } }}
      action={<Button color="inherit" size="small" variant="outlined" onClick={exitWorkspace}>Return to platform</Button>}>
      Working inside <b>{ws.tenant_name || `client #${ws.tenant_id}`}</b>'s workspace — every record you create or change here
      belongs to this client.
    </Alert>
  );
}
