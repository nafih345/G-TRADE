import React, { useState } from 'react';
import {
  Box, Paper, Typography, List, ListItemButton, ListItemText, ListItemIcon, Chip, Button, Alert, CircularProgress,
} from '@mui/material';
import { Business as CompanyIcon, Logout as LogoutIcon } from '@mui/icons-material';
import { useAuth, roleLabel } from '../context/AuthContext';

/**
 * Phase 2 — shown right after sign-in when the user can work in more than one company.
 * The session already belongs to the user's home company; picking another one asks the server
 * to switch (membership is checked there, and a new session is issued for that company).
 */
export default function CompanySelect() {
  const { user, companies, switchCompany, continueInCurrentCompany, logout } = useAuth();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const activeId = user?.active_company?.tenant_id;

  const choose = async (company) => {
    setError('');
    setBusy(company.tenant_id);
    const res = await switchCompany(company.tenant_id);
    if (!res.success) {
      setError(res.message);
      setBusy(null);
    } else if (res.unchanged) {
      continueInCurrentCompany();
    }
  };

  return (
    <Box sx={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'background.default', p: 2 }}>
      <Paper elevation={0} sx={{ width: '100%', maxWidth: 480, p: { xs: 3, sm: 4 }, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
        <Typography variant="h5" fontWeight={800} gutterBottom>Choose a company</Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {user?.organization?.name ? `${user.organization.name}: ` : ''}your account can work in these companies. Each company
          keeps its own records. You can switch later from the top bar.
        </Typography>
        {error && <Alert severity="error" sx={{ mb: 2 }}>{error}</Alert>}
        <List data-testid="company-picker" sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, p: 0.5 }}>
          {companies.map((c) => (
            <ListItemButton key={c.tenant_id} disabled={busy !== null} onClick={() => choose(c)}
                            sx={{ borderRadius: 1.5 }} data-testid={`company-option-${c.tenant_id}`}>
              <ListItemIcon sx={{ minWidth: 40 }}>
                {busy === c.tenant_id ? <CircularProgress size={20} /> : <CompanyIcon color="primary" />}
              </ListItemIcon>
              <ListItemText
                primary={<Typography fontWeight={700}>{c.name}</Typography>}
                secondary={roleLabel(c.role)}
              />
              {c.is_home && <Chip size="small" label="Home" sx={{ mr: 0.5 }} />}
              {c.tenant_id === activeId && <Chip size="small" color="primary" variant="outlined" label="Signed in" />}
            </ListItemButton>
          ))}
        </List>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 2 }}>
          <Button startIcon={<LogoutIcon />} color="inherit" onClick={logout}>Sign out</Button>
          <Button variant="text" onClick={continueInCurrentCompany} disabled={busy !== null}>
            Continue in {user?.active_company?.name || 'this company'}
          </Button>
        </Box>
      </Paper>
    </Box>
  );
}
