import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Typography } from '@mui/material';
import { useAuth } from '../../context/AuthContext';
import { securityApi } from '../../utils/securityApi';
import { SECURITY_POLICY_EVENT, announceSessionEnded } from '../../utils/sessionGuard';

const ACTIVITY_KEY = 'last_activity_at';      // shared across tabs
const WARN_SECONDS = 60;
const HEARTBEAT_MS = 2 * 60 * 1000;
const TICK_MS = 5000;
const EVENTS = ['mousedown', 'keydown', 'wheel', 'touchstart', 'pointermove'];

const readShared = () => {
  try { return Number(localStorage.getItem(ACTIVITY_KEY)) || 0; } catch { return 0; }
};

/**
 * Inactivity timeout in the browser. The server enforces the same policy on its own (an idle
 * session's token stops working); this side warns a minute ahead, signs out on time, and tells
 * the server about real activity on screens that make no API calls (a long form being typed),
 * so the server does not expire a session that is genuinely in use.
 */
export default function SessionActivityMonitor() {
  const { logout } = useAuth();
  const [timeoutMin, setTimeoutMin] = useState(null);
  const [remaining, setRemaining] = useState(null); // seconds, while the warning is shown
  const lastActivity = useRef(Date.now());
  const lastBeat = useRef(Date.now());
  const lastShared = useRef(0);

  const loadPolicy = useCallback(() => {
    securityApi.policy().then((p) => setTimeoutMin(p.inactivity_timeout_minutes)).catch(() => {});
  }, []);
  useEffect(() => {
    loadPolicy();
    window.addEventListener(SECURITY_POLICY_EVENT, loadPolicy);
    return () => window.removeEventListener(SECURITY_POLICY_EVENT, loadPolicy);
  }, [loadPolicy]);

  const markActive = useCallback(() => {
    const now = Date.now();
    lastActivity.current = now;
    if (now - lastShared.current > 5000) {
      lastShared.current = now;
      try { localStorage.setItem(ACTIVITY_KEY, String(now)); } catch { /* ignore */ }
    }
  }, []);

  useEffect(() => {
    markActive();
    EVENTS.forEach((e) => window.addEventListener(e, markActive, { passive: true }));
    return () => EVENTS.forEach((e) => window.removeEventListener(e, markActive));
  }, [markActive]);

  useEffect(() => {
    if (!timeoutMin) return undefined;
    const limit = timeoutMin * 60 * 1000;
    const tick = () => {
      const last = Math.max(lastActivity.current, readShared());
      const idle = Date.now() - last;
      if (idle >= limit) {
        logout();
        announceSessionEnded(`You were signed out after ${timeoutMin} minutes of inactivity. Please sign in again.`);
        return;
      }
      const left = Math.ceil((limit - idle) / 1000);
      setRemaining(left <= WARN_SECONDS ? left : null);
      // Activity since the last heartbeat → tell the server (at most every 2 minutes).
      if (last > lastBeat.current && Date.now() - lastBeat.current >= HEARTBEAT_MS) {
        lastBeat.current = Date.now();
        securityApi.heartbeat().catch(() => {});
      }
    };
    const id = setInterval(tick, TICK_MS);
    return () => clearInterval(id);
  }, [timeoutMin, logout]);

  const stay = () => {
    markActive();
    setRemaining(null);
    lastBeat.current = Date.now();
    securityApi.heartbeat().catch(() => {});
  };

  return (
    <Dialog open={remaining != null} onClose={stay} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: '20px' } }}>
      <DialogTitle sx={{ fontWeight: 800 }}>Are you still there?</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          For security you'll be signed out in <b>{remaining}</b> second{remaining === 1 ? '' : 's'} because of inactivity.
        </Typography>
        <LinearProgress variant="determinate" value={((remaining || 0) / WARN_SECONDS) * 100} color="warning"
          sx={{ height: 6, borderRadius: 3 }} />
      </DialogContent>
      <DialogActions sx={{ px: 3, pb: 2.5 }}>
        <Button onClick={logout}>Sign out now</Button>
        <Button variant="contained" onClick={stay} sx={{ bgcolor: '#08A65A', background: '#08A65A', '&:hover': { bgcolor: '#078f4e', background: '#078f4e' }, fontWeight: 700 }}>
          Stay signed in
        </Button>
      </DialogActions>
    </Dialog>
  );
}
