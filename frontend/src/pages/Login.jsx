import React, { useState } from 'react';
import {
  Box, TextField, Button, Typography, Alert, Stack, CircularProgress,
  InputAdornment, IconButton, Tooltip, Fade
} from '@mui/material';
import PersonOutlineRoundedIcon from '@mui/icons-material/PersonOutlineRounded';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import VisibilityOffOutlinedIcon from '@mui/icons-material/VisibilityOffOutlined';
import RemoveRedEyeRoundedIcon from '@mui/icons-material/RemoveRedEyeRounded';
import ReceiptLongOutlinedIcon from '@mui/icons-material/ReceiptLongOutlined';
import Inventory2OutlinedIcon from '@mui/icons-material/Inventory2Outlined';
import StorefrontOutlinedIcon from '@mui/icons-material/StorefrontOutlined';
import ArrowForwardRoundedIcon from '@mui/icons-material/ArrowForwardRounded';
import KeyboardCapslockRoundedIcon from '@mui/icons-material/KeyboardCapslockRounded';
import AdminPanelSettingsOutlinedIcon from '@mui/icons-material/AdminPanelSettingsOutlined';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

const DEMO_ROLES = ['admin', 'manager', 'accountant', 'cashier'];

const FEATURES = [
  { icon: RemoveRedEyeRoundedIcon, title: 'Eye exams & prescriptions', text: 'Per-visit records with full Rx history' },
  { icon: ReceiptLongOutlinedIcon, title: 'Billing & GST', text: 'Orders, invoices, quotations and receipts' },
  { icon: Inventory2OutlinedIcon, title: 'Inventory & purchases', text: 'Frames, lenses and barcode labels' },
  { icon: StorefrontOutlinedIcon, title: 'Multi-branch ready', text: 'Branch-wise stock, sales and reports' },
];

function BrandMark({ size = 44 }) {
  return (
    <Box sx={{
      width: size, height: size, borderRadius: size * 0.3 + 'px',
      display: 'grid', placeItems: 'center', flexShrink: 0,
      background: 'linear-gradient(135deg, #6366f1 0%, #a855f7 100%)',
      boxShadow: '0 8px 20px rgba(99, 102, 241, 0.35)',
      color: '#fff'
    }}>
      <RemoveRedEyeRoundedIcon sx={{ fontSize: size * 0.55 }} />
    </Box>
  );
}

const STAFF_NOT_CONFIGURED =
  'Account not configured — access denied. Sign-in for Admin, Manager, Accountant and Cashier '
  + 'is disabled until those roles and their permissions are set up.';

const SERVER_ERROR =
  'The server could not process the sign-in (it may not be able to reach its database). '
  + 'Please try again shortly or contact the administrator.';

// Messages per login() failure reason (see AuthContext), for each sign-in page.
const ERRORS = {
  staff: {
    invalid_credentials: 'Invalid username or password.',
    role_not_enabled: STAFF_NOT_CONFIGURED,
    network: 'Cannot reach the server. Check your connection and try again.',
    server: SERVER_ERROR,
  },
  superAdmin: {
    invalid_credentials: 'Invalid username or password.',
    role_not_enabled: 'This account is not a Super Admin. Access denied.',
    not_super_admin: 'This account is not a Super Admin. Access denied.',
    network: 'Cannot reach the server. Check your connection and try again.',
    server: SERVER_ERROR,
  },
};

/**
 * variant 'staff'      — the regular sign-in page (/). Staff roles are not enabled yet.
 * variant 'superAdmin' — the dedicated Super Admin sign-in page (/super-admin/login).
 */
export default function Login({ variant = 'staff' }) {
  const isSuperAdminPage = variant === 'superAdmin';
  const { login } = useAuth();
  const navigate = useNavigate();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [capsLock, setCapsLock] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!username.trim() || !password) {
      setError('Enter your username and password.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const result = await login(username.trim(), password, { portal: isSuperAdminPage ? 'super_admin' : 'staff' });
      if (result.success) {
        navigate('/', { replace: true });
      } else {
        // The demo role names have no working accounts yet — say so rather than "invalid".
        const reason = !isSuperAdminPage && result.reason === 'invalid_credentials'
          && DEMO_ROLES.includes(username.trim().toLowerCase()) ? 'role_not_enabled' : result.reason;
        setError(ERRORS[variant][reason] || 'Sign-in failed. Please try again.');
        setPassword('');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickSelect = (roleName) => {
    setUsername(roleName.toLowerCase());
    setPassword('');
    setError('');
    document.getElementById('login-password')?.focus();
  };

  const trackCapsLock = (e) => {
    if (typeof e.getModifierState === 'function') setCapsLock(e.getModifierState('CapsLock'));
  };

  const inputSx = {
    '& .MuiOutlinedInput-root': {
      borderRadius: 2.5,
      backgroundColor: 'background.paper',
      transition: 'box-shadow 0.2s',
      '&.Mui-focused': { boxShadow: '0 0 0 4px rgba(99, 102, 241, 0.12)' },
    },
  };

  return (
    <Box sx={{
      minHeight: '100vh',
      display: 'grid',
      gridTemplateColumns: { xs: '1fr', md: 'minmax(0, 1.05fr) minmax(0, 1fr)' },
      backgroundColor: 'background.default',
    }}>
      {/* Brand panel */}
      <Box sx={{
        display: { xs: 'none', md: 'flex' },
        flexDirection: 'column',
        justifyContent: 'space-between',
        position: 'relative',
        overflow: 'hidden',
        p: { md: 6, lg: 8 },
        color: '#fff',
        background: 'linear-gradient(150deg, #312e81 0%, #4338ca 45%, #7c3aed 100%)',
      }}>
        {/* Decorative lens rings */}
        <Box aria-hidden sx={{
          position: 'absolute', right: -160, bottom: -160, width: 520, height: 520, borderRadius: '50%',
          border: '1px solid rgba(255,255,255,0.12)',
          boxShadow: 'inset 0 0 0 60px rgba(255,255,255,0.03), inset 0 0 0 120px rgba(255,255,255,0.025)',
        }} />
        <Box aria-hidden sx={{
          position: 'absolute', left: -120, top: -120, width: 340, height: 340, borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(168,85,247,0.45) 0%, transparent 70%)',
        }} />

        <Stack direction="row" spacing={1.5} alignItems="center" sx={{ position: 'relative' }}>
          <Box sx={{
            width: 44, height: 44, borderRadius: '13px', display: 'grid', placeItems: 'center',
            backgroundColor: 'rgba(255,255,255,0.14)', border: '1px solid rgba(255,255,255,0.22)',
          }}>
            <RemoveRedEyeRoundedIcon />
          </Box>
          <Box>
            <Typography sx={{ fontWeight: 800, fontSize: '1.25rem', letterSpacing: '0.04em', lineHeight: 1.1 }}>
              GREENSOL
            </Typography>
            <Typography sx={{ fontSize: '0.75rem', opacity: 0.7 }}>Optical ERP</Typography>
          </Box>
        </Stack>

        <Box sx={{ position: 'relative', maxWidth: 480 }}>
          <Typography sx={{ fontWeight: 800, fontSize: { md: '2.2rem', lg: '2.6rem' }, lineHeight: 1.15, mb: 2 }}>
            Run your entire optical store from one place.
          </Typography>
          <Typography sx={{ opacity: 0.75, fontSize: '1rem', mb: 5 }}>
            Eye tests, sales, stock and accounts — connected, accurate and always up to date.
          </Typography>

          <Stack spacing={2.5}>
            {FEATURES.map(({ icon: Icon, title, text }) => (
              <Stack key={title} direction="row" spacing={2} alignItems="center">
                <Box sx={{
                  width: 40, height: 40, borderRadius: 2, display: 'grid', placeItems: 'center', flexShrink: 0,
                  backgroundColor: 'rgba(255,255,255,0.1)', border: '1px solid rgba(255,255,255,0.15)',
                }}>
                  <Icon sx={{ fontSize: 20 }} />
                </Box>
                <Box>
                  <Typography sx={{ fontWeight: 700, fontSize: '0.95rem' }}>{title}</Typography>
                  <Typography sx={{ fontSize: '0.82rem', opacity: 0.7 }}>{text}</Typography>
                </Box>
              </Stack>
            ))}
          </Stack>
        </Box>

        <Typography sx={{ position: 'relative', fontSize: '0.78rem', opacity: 0.6 }}>
          © {new Date().getFullYear()} Greensol · Enterprise Resource Planning Core System
        </Typography>
      </Box>

      {/* Form panel */}
      <Box sx={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        px: { xs: 2, sm: 4 }, py: { xs: 5, md: 4 },
        background: {
          xs: 'radial-gradient(circle at 15% 10%, rgba(99,102,241,0.10) 0%, transparent 45%), radial-gradient(circle at 85% 90%, rgba(168,85,247,0.10) 0%, transparent 45%)',
          md: 'none',
        },
      }}>
        <Fade in timeout={400}>
          <Box sx={{ width: '100%', maxWidth: 420 }}>
            {/* Compact brand for small screens */}
            <Stack direction="row" spacing={1.5} alignItems="center" sx={{ display: { xs: 'flex', md: 'none' }, mb: 4 }}>
              <BrandMark size={40} />
              <Box>
                <Typography className="gradient-text" sx={{ fontWeight: 900, fontSize: '1.35rem', lineHeight: 1.1 }}>
                  GREENSOL
                </Typography>
                <Typography variant="caption" color="text.secondary">Optical ERP</Typography>
              </Box>
            </Stack>

            {isSuperAdminPage && (
              <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 1.5, color: 'primary.main' }}>
                <AdminPanelSettingsOutlinedIcon sx={{ fontSize: 20 }} />
                <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, letterSpacing: '0.08em' }}>SUPER ADMIN</Typography>
              </Stack>
            )}
            <Typography sx={{ fontWeight: 800, fontSize: { xs: '1.6rem', sm: '1.85rem' }, color: 'text.primary', mb: 0.75 }}>
              Welcome back
            </Typography>
            <Typography color="text.secondary" sx={{ mb: 4, fontSize: '0.95rem' }}>
              {isSuperAdminPage ? 'Sign in with your Super Admin account.' : 'Sign in to continue to your workspace.'}
            </Typography>

            {error && (
              <Alert severity="error" sx={{ mb: 3, borderRadius: 2.5 }} onClose={() => setError('')}>
                {error}
              </Alert>
            )}

            <form onSubmit={handleSubmit} noValidate autoComplete="off">
              <Stack spacing={2.5}>
                <Box>
                  <Typography component="label" htmlFor="login-username"
                    sx={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'text.primary', mb: 0.75 }}>
                    Username or email
                  </Typography>
                  <TextField
                    id="login-username"
                    fullWidth
                    autoFocus
                    autoComplete="off"
                    placeholder="Enter your username or email"
                    value={username}
                    onChange={(e) => { setUsername(e.target.value); if (error) setError(''); }}
                    sx={inputSx}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <PersonOutlineRoundedIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
                        </InputAdornment>
                      ),
                    }}
                  />
                </Box>

                <Box>
                  <Typography component="label" htmlFor="login-password"
                    sx={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, color: 'text.primary', mb: 0.75 }}>
                    Password
                  </Typography>
                  <TextField
                    id="login-password"
                    fullWidth
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    placeholder="Enter your password"
                    value={password}
                    onChange={(e) => { setPassword(e.target.value); if (error) setError(''); }}
                    onKeyDown={trackCapsLock}
                    onKeyUp={trackCapsLock}
                    onBlur={() => setCapsLock(false)}
                    sx={inputSx}
                    InputProps={{
                      startAdornment: (
                        <InputAdornment position="start">
                          <LockOutlinedIcon sx={{ color: 'text.secondary', fontSize: 20 }} />
                        </InputAdornment>
                      ),
                      endAdornment: (
                        <InputAdornment position="end">
                          <Tooltip title={showPassword ? 'Hide password' : 'Show password'}>
                            <IconButton
                              edge="end"
                              aria-label={showPassword ? 'Hide password' : 'Show password'}
                              onClick={() => setShowPassword((v) => !v)}
                              onMouseDown={(e) => e.preventDefault()}
                              size="small"
                            >
                              {showPassword
                                ? <VisibilityOffOutlinedIcon fontSize="small" />
                                : <VisibilityOutlinedIcon fontSize="small" />}
                            </IconButton>
                          </Tooltip>
                        </InputAdornment>
                      ),
                    }}
                  />
                  {capsLock && (
                    <Stack direction="row" spacing={0.5} alignItems="center" sx={{ mt: 0.75, color: 'warning.main' }}>
                      <KeyboardCapslockRoundedIcon sx={{ fontSize: 16 }} />
                      <Typography sx={{ fontSize: '0.78rem', fontWeight: 600 }}>Caps Lock is on</Typography>
                    </Stack>
                  )}
                </Box>

                <Button
                  type="submit"
                  variant="contained"
                  size="large"
                  disabled={loading}
                  endIcon={!loading && <ArrowForwardRoundedIcon />}
                  sx={{
                    py: 1.6, mt: 1, fontSize: '1rem', fontWeight: 700, borderRadius: 2.5, textTransform: 'none',
                    background: 'linear-gradient(135deg, #6366f1 0%, #7c3aed 100%)',
                    boxShadow: '0 10px 24px rgba(99, 102, 241, 0.30)',
                    '&:hover': {
                      background: 'linear-gradient(135deg, #4f46e5 0%, #6d28d9 100%)',
                      boxShadow: '0 12px 28px rgba(99, 102, 241, 0.40)',
                    },
                    '&.Mui-disabled': { color: '#fff', opacity: 0.8 },
                  }}
                >
                  {loading
                    ? <Stack direction="row" spacing={1.5} alignItems="center">
                        <CircularProgress size={18} sx={{ color: '#fff' }} />
                        <span>Signing in…</span>
                      </Stack>
                    : 'Sign in'}
                </Button>
              </Stack>
            </form>

            {!isSuperAdminPage && <Box sx={{ mt: 4.5 }}>
              <Stack direction="row" alignItems="center" spacing={1.5} sx={{ mb: 1.75 }}>
                <Box sx={{ flex: 1, height: '1px', backgroundColor: 'divider' }} />
                <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, letterSpacing: '0.08em', color: 'text.secondary' }}>
                  QUICK DEMO ACCESS
                </Typography>
                <Box sx={{ flex: 1, height: '1px', backgroundColor: 'divider' }} />
              </Stack>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, 1fr)', sm: 'repeat(4, 1fr)' }, gap: 1 }}>
                {DEMO_ROLES.map((role) => {
                  const active = username.toLowerCase() === role;
                  return (
                    <Button
                      key={role}
                      size="small"
                      variant="outlined"
                      onClick={() => handleQuickSelect(role)}
                      aria-pressed={active}
                      sx={{
                        borderRadius: 2,
                        py: 0.9,
                        fontSize: '0.8rem',
                        fontWeight: 600,
                        textTransform: 'capitalize',
                        borderColor: active ? 'primary.main' : 'divider',
                        color: active ? 'primary.main' : 'text.secondary',
                        backgroundColor: active ? 'rgba(99, 102, 241, 0.08)' : 'transparent',
                        '&:hover': { borderColor: 'primary.main', color: 'primary.main', backgroundColor: 'rgba(99, 102, 241, 0.06)' },
                      }}
                    >
                      {role}
                    </Button>
                  );
                })}
              </Box>
            </Box>}

            <Typography sx={{ mt: 4, textAlign: 'center', fontSize: '0.85rem', color: 'text.secondary' }}>
              {isSuperAdminPage ? 'Not a Super Admin? ' : 'Super Admin? '}
              <Box component={RouterLink} to={isSuperAdminPage ? '/' : '/super-admin/login'}
                sx={{ color: 'primary.main', fontWeight: 700, textDecoration: 'none', '&:hover': { textDecoration: 'underline' } }}>
                {isSuperAdminPage ? 'Back to staff sign in' : 'Sign in here'}
              </Box>
            </Typography>

            <Typography sx={{ display: { xs: 'block', md: 'none' }, mt: 5, textAlign: 'center', fontSize: '0.75rem', color: 'text.secondary' }}>
              © {new Date().getFullYear()} Greensol · Enterprise Resource Planning Core System
            </Typography>
          </Box>
        </Fade>
      </Box>
    </Box>
  );
}
