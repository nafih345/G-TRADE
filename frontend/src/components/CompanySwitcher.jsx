import React, { useState } from 'react';
import axios from 'axios';
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, Menu, MenuItem, ListItemIcon, ListItemText, Divider, Tooltip, CircularProgress, Chip,
} from '@mui/material';
import {
  Business as CompanyIcon, Check as CheckIcon, ExpandMore as ExpandIcon, Settings as ManageIcon,
  Assessment as SummaryIcon,
} from '@mui/icons-material';
import { useAuth, roleLabel } from '../context/AuthContext';
import { normalizeCompanies } from '../utils/companies';
import { notify } from '../utils/notify';

/**
 * Phase 2 — the company this session acts in, and (for users with several companies) a switcher.
 * The list is re-read from the server each time the menu opens, so a membership granted or
 * revoked while signed in shows up without signing out. Switching asks the server; the server
 * checks the membership and issues a new session for that company (AuthContext.switchCompany).
 */
export default function CompanySwitcher({ mode }) {
  const { user, companies, switchCompany } = useAuth();
  const navigate = useNavigate();
  const [anchor, setAnchor] = useState(null);
  const [list, setList] = useState(companies);
  const [busy, setBusy] = useState(null);
  const active = user?.active_company;
  if (!active || user?.workspace) return null;

  const multi = (user?.company_count || companies.length) > 1 || user?.is_org_admin;
  const chip = (
    <Box
      data-testid="header-company"
      onClick={multi ? async (e) => {
        setAnchor(e.currentTarget);
        try {
          const { data } = await axios.get('/api/auth/companies/', { __silentError: true });
          setList(normalizeCompanies(data.companies));
        } catch { /* keep the list from sign-in */ }
      } : undefined}
      sx={{
        display: { xs: 'none', md: 'flex' }, alignItems: 'center', gap: 1, cursor: multi ? 'pointer' : 'default',
        bgcolor: mode === 'dark' ? 'rgba(255,255,255,0.04)' : '#eef2ff', px: 1.5, py: 0.75, borderRadius: 2.5,
      }}
    >
      <CompanyIcon sx={{ color: 'primary.main', fontSize: 18 }} />
      <Typography sx={{ fontSize: '0.875rem', fontWeight: 800, color: 'text.primary', maxWidth: 180 }} noWrap>
        {active.name}
      </Typography>
      {multi && <ExpandIcon sx={{ fontSize: 18, color: 'text.secondary' }} />}
    </Box>
  );

  const choose = async (c) => {
    if (c.tenant_id === active.tenant_id) { setAnchor(null); return; }
    setBusy(c.tenant_id);
    const res = await switchCompany(c.tenant_id);
    if (!res.success) {
      notify(res.message, 'error');
      setBusy(null);
    }
  };

  return (
    <>
      <Tooltip title={multi ? 'Company — click to switch' : 'Your company'}>{chip}</Tooltip>
      <Menu anchorEl={anchor} open={Boolean(anchor)} onClose={() => setAnchor(null)}
            PaperProps={{ sx: { minWidth: 280, borderRadius: 2 } }}>
        <Typography sx={{ px: 2, pt: 1, pb: 0.5, fontSize: '0.75rem', fontWeight: 700, color: 'text.secondary' }}>
          {user?.organization?.name || 'Companies'}
        </Typography>
        {(list.length ? list : companies).map((c) => (
          <MenuItem key={c.tenant_id} onClick={() => choose(c)} disabled={busy !== null}
                    data-testid={`switch-company-${c.tenant_id}`}>
            <ListItemIcon>
              {busy === c.tenant_id ? <CircularProgress size={18} />
                : c.tenant_id === active.tenant_id ? <CheckIcon fontSize="small" color="primary" /> : null}
            </ListItemIcon>
            <ListItemText primary={c.name} secondary={roleLabel(c.role)} />
            {c.is_home && <Chip size="small" label="Home" sx={{ ml: 1 }} />}
          </MenuItem>
        ))}
        {user?.is_org_admin && [
          <Divider key="d" />,
          <MenuItem key="manage" onClick={() => { setAnchor(null); navigate('/organization/companies'); }}>
            <ListItemIcon><ManageIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary="Manage companies" />
          </MenuItem>,
          <MenuItem key="summary" onClick={() => { setAnchor(null); navigate('/organization/summary'); }}>
            <ListItemIcon><SummaryIcon fontSize="small" /></ListItemIcon>
            <ListItemText primary="Group summary" />
          </MenuItem>,
        ]}
      </Menu>
    </>
  );
}
