// A persistent, unmissable bar across the top of the app whenever the API is not answering
// properly.
//
// It exists because the failure it reports is otherwise invisible: with the hosted backend
// pointed at a deleted Postgres, every request returned 500 and the app still rendered a
// complete, calm UI — a dashboard reading "₹0.00 revenue" and "System Operations Normal"
// next to empty tables. Nothing distinguished a total outage from a business that had not
// traded yet, so it went unnoticed. Errors here are worth interrupting for.
import React, { useEffect, useState } from 'react';
import { Alert, AlertTitle, Box, Button, Collapse, IconButton, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import { checkBackendHealth, subscribeBackendStatus } from '../utils/backendStatus';

const TITLES = {
  unreachable: 'Cannot reach the server',
  degraded: 'The server is running, but its database is not',
};

const EXPLANATIONS = {
  unreachable:
    'Nothing is answering at the API address, so nothing you enter can be saved. Screens will stay empty.',
  degraded:
    'Requests are reaching the server but failing there. Lists will look empty and anything you save may be lost.',
};

export default function BackendStatusBanner() {
  const [state, setState] = useState(() => ({ status: 'checking', detail: '', baseUrl: '' }));
  const [dismissed, setDismissed] = useState(false);
  const [rechecking, setRechecking] = useState(false);

  useEffect(() => subscribeBackendStatus(setState), []);

  // A new kind of failure un-dismisses: the operator dismissed the old message, not this one.
  useEffect(() => { setDismissed(false); }, [state.status]);

  const broken = state.status === 'unreachable' || state.status === 'degraded';

  const handleRecheck = async () => {
    setRechecking(true);
    try {
      await checkBackendHealth();
    } finally {
      setRechecking(false);
    }
  };

  return (
    <Collapse in={broken && !dismissed} unmountOnExit>
      <Alert
        severity="error"
        variant="filled"
        sx={{ borderRadius: 0, alignItems: 'flex-start', '& .MuiAlert-message': { width: '100%' } }}
        // Both controls live in `action`: MUI renders its own close icon only when `action`
        // is absent, so giving it one here is what keeps the dismiss button reachable.
        action={
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <Button
              color="inherit"
              size="small"
              onClick={handleRecheck}
              disabled={rechecking}
              sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}
            >
              {rechecking ? 'Checking…' : 'Re-check'}
            </Button>
            <IconButton color="inherit" size="small" aria-label="Dismiss" onClick={() => setDismissed(true)}>
              <CloseIcon fontSize="inherit" />
            </IconButton>
          </Box>
        }
      >
        <AlertTitle sx={{ fontWeight: 800, mb: 0.25 }}>{TITLES[state.status]}</AlertTitle>
        <Typography variant="body2" sx={{ lineHeight: 1.5 }}>
          {EXPLANATIONS[state.status]}
        </Typography>
        {/* The address and the server's own words — without them, "it's broken" is not
            actionable, and the original outage's cause (a database host that no longer
            resolved) was stated plainly by /api/health/ the whole time. */}
        <Box
          sx={{
            mt: 0.75,
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: '0.75rem',
            opacity: 0.9,
            wordBreak: 'break-word',
          }}
        >
          {state.baseUrl || '(same origin)'}
          {state.detail ? ` — ${state.detail}` : ''}
        </Box>
      </Alert>
    </Collapse>
  );
}
