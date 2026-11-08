import React, { createContext, useState, useContext, useEffect } from 'react';
import axios from 'axios';
import { SESSION_ENDED_EVENT, TOKEN_REFRESHED_EVENT } from '../utils/sessionGuard';
import { prefetchMasters } from '../utils/masterDataCache';
import { clearLocalDataIfScopeChanged } from '../utils/localDataReset';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

// Display labels for role codes. The backend calls ADMINISTRATOR "Administrator"; the app
// shows it as plain "Admin" — and an Admin must never be labelled "Super Admin".
const ROLE_LABELS = {
  SUPER_ADMIN: 'Super Admin',
  ADMINISTRATOR: 'Admin',
  ADMIN: 'Admin',
  BRANCH_ADMIN: 'Branch Admin',
  OPTOMETRIST: 'Optometrist',
  DOCTOR: 'Doctor',
  MANAGER: 'Manager',
  ACCOUNTANT: 'Accountant',
  CASHIER: 'Cashier',
  INVENTORY_MANAGER: 'Inventory Manager',
  SALES_EXECUTIVE: 'Sales Executive',
  PURCHASE_EXECUTIVE: 'Purchase Executive',
};

export const roleLabel = (role) => ROLE_LABELS[(role || '').toUpperCase()] || role || '';

const withRoleLabel = (profile) => ({ ...profile, role_display: roleLabel(profile.role) });

// Tokens from the old client-side demo login ("mock_jwt_token…") were never issued by the
// backend; an expired real JWT is no better. Either means: sign in again.
function isUsableToken(token) {
  if (!token || token.startsWith('mock_jwt_token')) return false;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return !payload.exp || payload.exp * 1000 > Date.now();
  } catch {
    return false;
  }
}

function tokenTenantId(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).tenant_id ?? null;
  } catch {
    return null;
  }
}

// While the platform owner works inside a client's workspace, their own platform session is
// parked here so "Return to platform" can resume it (see openWorkspace below).
const PLATFORM_SESSION_KEY = 'platform_session_backup';

function clearSession() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('user_profile');
}

function readPlatformSession() {
  try { return JSON.parse(localStorage.getItem(PLATFORM_SESSION_KEY) || 'null'); } catch { return null; }
}

// A full reload after switching tenants: every screen re-reads its data in the new scope and no
// component keeps the previous client's rows in memory.
function reloadAt(hash) {
  window.location.hash = hash;
  window.location.reload();
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(() => {
    const t = localStorage.getItem('access_token');
    if (isUsableToken(t)) return t;
    clearSession();
    return null;
  });

  useEffect(() => {
    if (!token) {
      delete axios.defaults.headers.common['Authorization'];
      setUser(null);
      setLoading(false);
      return;
    }
    axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
    // Fetch the master lists every form needs (suppliers, categories, brands, units) now, so
    // pickers are already filled when a form opens.
    prefetchMasters();
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('user_profile') || 'null'); } catch { /* ignore */ }
    if (saved) {
      setUser(withRoleLabel(saved));
      setLoading(false);
      // Refresh the cached profile in the background: role and module access
      // (user.module_access) can change in the platform console while a session is open.
      axios.get('/api/auth/profile/')
        .then(({ data }) => {
          const profile = withRoleLabel(data);
          localStorage.setItem('user_profile', JSON.stringify(profile));
          setUser(profile);
        })
        .catch(() => { /* keep the cached profile; the sign-in itself is still valid */ });
      return;
    }
    // Token without a cached profile: ask the backend who it belongs to.
    axios.get('/api/auth/profile/')
      .then(({ data }) => {
        const profile = withRoleLabel(data);
        localStorage.setItem('user_profile', JSON.stringify(profile));
        setUser(profile);
      })
      .catch(() => { clearSession(); setToken(null); })
      .finally(() => setLoading(false));
  }, [token]);

  /**
   * Authenticate against the backend (/api/auth/login/). The backend only issues tokens to
   * roles in settings.LOGIN_ENABLED_ROLES (currently Super Admin only) and answers anything
   * else with code "role_not_enabled".
   *
   * portal: 'super_admin' — the dedicated Super Admin sign-in page; only Super Admins.
   *         'staff'       — the regular sign-in page; anyone the backend lets in (today that
   *                         is only Super Admin, typed in directly — e.g. superadmin).
   *
   * Returns { success: true } or { success: false, reason, ... } where reason is one of
   * 'invalid_credentials' | 'role_not_enabled' | 'not_super_admin' | 'account_locked' | 'network' |
   * 'server' | 'two_factor' (a second step is needed: { challenge, setup?: {secret, otpauth_uri} }).
   */
  const failure = (error) => {
    const res = error.response;
    if (!res) return { success: false, reason: 'network' };
    const code = res.data?.code;
    if (code === 'role_not_enabled') return { success: false, reason: 'role_not_enabled' };
    if (res.status === 429) {
      return { success: false, reason: 'account_locked', message: res.data?.detail || 'Too many attempts. Try again later.' };
    }
    if (code === 'invalid_code') return { success: false, reason: 'invalid_code', message: res.data.detail };
    if (code === 'challenge_expired') return { success: false, reason: 'challenge_expired', message: res.data.detail };
    // A 5xx (e.g. the database is unreachable) is not a wrong password — don't say it is.
    if (res.status >= 500) return { success: false, reason: 'server' };
    return { success: false, reason: 'invalid_credentials' };
  };

  const finishLogin = (data, portal) => {
    const profile = withRoleLabel(data.user || {});
    const isSuperAdmin = profile.role === 'SUPER_ADMIN';
    if (portal === 'super_admin' && !isSuperAdmin) return { success: false, reason: 'not_super_admin' };

    // Another client signing in on this browser must not see the last one's cached records.
    clearLocalDataIfScopeChanged('tenant', tokenTenantId(data.access));
    // A fresh sign-in starts at the branch the server binds this user to (their assigned branch;
    // Head Office for the owner) — never the branch the previous user picked on this browser.
    localStorage.removeItem('active_branch_id');
    localStorage.setItem('access_token', data.access);
    if (data.refresh) localStorage.setItem('refresh_token', data.refresh);
    localStorage.setItem('user_profile', JSON.stringify(profile));
    setUser(profile);
    setToken(data.access);
    return { success: true };
  };

  const login = async (username, password, { portal = 'staff' } = {}) => {
    let data;
    try {
      ({ data } = await axios.post('/api/auth/login/', { username, password }));
    } catch (error) {
      return failure(error);
    }
    if (data.two_factor_required || data.two_factor_setup_required) {
      return {
        success: false,
        reason: 'two_factor',
        challenge: data.challenge,
        setup: data.two_factor_setup_required ? { secret: data.secret, otpauth_uri: data.otpauth_uri } : null,
      };
    }
    return finishLogin(data, portal);
  };

  /** Second sign-in step: the 6-digit authenticator code for a challenge from login(). */
  const verifyTwoFactor = async (challenge, code, { portal = 'staff' } = {}) => {
    try {
      const { data } = await axios.post('/api/auth/two-factor/verify/', { challenge, code });
      return finishLogin(data, portal);
    } catch (error) {
      return failure(error);
    }
  };

  /**
   * Platform owner: open a client's workspace (Client Management → "Open workspace"). The server
   * issues a separate session scoped to that client (POST …/tenants/<id>/workspace/, audited);
   * records created there belong to the client. The platform session is kept aside.
   */
  const openWorkspace = async (tenantId) => {
    const { data } = await axios.post(`/api/superadmin/tenants/${tenantId}/workspace/`, {});
    if (!readPlatformSession()) {
      localStorage.setItem(PLATFORM_SESSION_KEY, JSON.stringify({
        access: localStorage.getItem('access_token'),
        refresh: localStorage.getItem('refresh_token'),
        profile: localStorage.getItem('user_profile'),
      }));
    }
    clearLocalDataIfScopeChanged('tenant', tokenTenantId(data.access));
    localStorage.removeItem('active_branch_id');
    localStorage.setItem('access_token', data.access);
    localStorage.setItem('refresh_token', data.refresh);
    localStorage.setItem('user_profile', JSON.stringify(withRoleLabel({ ...data.user, workspace: data.workspace })));
    reloadAt('#/');
  };

  /** Leave a client's workspace and resume the parked platform session. */
  const exitWorkspace = () => {
    const platform = readPlatformSession();
    if (axios.defaults.headers.common.Authorization) {
      axios.post('/api/auth/logout/', {}, { __silentError: true }).catch(() => {});
    }
    localStorage.removeItem(PLATFORM_SESSION_KEY);
    localStorage.removeItem('active_branch_id');
    clearSession();
    if (platform?.access) {
      clearLocalDataIfScopeChanged('tenant', tokenTenantId(platform.access));
      localStorage.setItem('access_token', platform.access);
      if (platform.refresh) localStorage.setItem('refresh_token', platform.refresh);
      if (platform.profile) localStorage.setItem('user_profile', platform.profile);
    }
    reloadAt(platform?.access ? '#/superadmin/tenants' : '#/');
  };

  const logout = () => {
    // End the server-side session too (best effort — the local sign-out never waits on it).
    if (axios.defaults.headers.common.Authorization) {
      axios.post('/api/auth/logout/', {}, { __silentError: true }).catch(() => {});
    }
    // Signing out of a client workspace signs the platform owner out completely.
    const platform = readPlatformSession();
    if (platform?.access) {
      axios.post('/api/auth/logout/', {}, { headers: { Authorization: `Bearer ${platform.access}` }, __silentError: true })
        .catch(() => {});
    }
    localStorage.removeItem(PLATFORM_SESSION_KEY);
    clearSession();
    setToken(null);
    setUser(null);
  };

  // The server ended this session (idle timeout, sign-out elsewhere, a database restore).
  useEffect(() => {
    const onEnded = () => {
      delete axios.defaults.headers.common['Authorization'];
      localStorage.removeItem(PLATFORM_SESSION_KEY);
      clearSession();
      setToken(null);
      setUser(null);
    };
    // sessionGuard swapped an expired access token for a fresh one — keep state in step.
    const onRefreshed = (e) => { if (e.detail?.access) setToken(e.detail.access); };
    window.addEventListener(SESSION_ENDED_EVENT, onEnded);
    window.addEventListener(TOKEN_REFRESHED_EVENT, onRefreshed);
    return () => {
      window.removeEventListener(SESSION_ENDED_EVENT, onEnded);
      window.removeEventListener(TOKEN_REFRESHED_EVENT, onRefreshed);
    };
  }, []);

  return (
    <AuthContext.Provider value={{ user, token, loading, login, verifyTwoFactor, logout, openWorkspace, exitWorkspace }}>
      {children}
    </AuthContext.Provider>
  );
};
