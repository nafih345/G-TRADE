import React, { createContext, useState, useContext, useEffect } from 'react';
import axios from 'axios';

const AuthContext = createContext(null);

export const useAuth = () => useContext(AuthContext);

// Display labels for role codes. The backend calls ADMINISTRATOR "Administrator"; the app
// shows it as plain "Admin" — and an Admin must never be labelled "Super Admin".
const ROLE_LABELS = {
  SUPER_ADMIN: 'Super Admin',
  ADMINISTRATOR: 'Admin',
  ADMIN: 'Admin',
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

function clearSession() {
  localStorage.removeItem('access_token');
  localStorage.removeItem('refresh_token');
  localStorage.removeItem('user_profile');
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
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('user_profile') || 'null'); } catch { /* ignore */ }
    if (saved) {
      setUser(withRoleLabel(saved));
      setLoading(false);
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
   * Returns { success: true } or { success: false, reason } where reason is one of
   * 'invalid_credentials' | 'role_not_enabled' | 'not_super_admin' | 'network'.
   */
  const login = async (username, password, { portal = 'staff' } = {}) => {
    let data;
    try {
      ({ data } = await axios.post('/api/auth/login/', { username, password }));
    } catch (error) {
      const res = error.response;
      if (!res) return { success: false, reason: 'network' };
      const code = res.data?.code;
      if (code === 'role_not_enabled') return { success: false, reason: 'role_not_enabled' };
      return { success: false, reason: 'invalid_credentials' };
    }

    const profile = withRoleLabel(data.user || {});
    const isSuperAdmin = profile.role === 'SUPER_ADMIN';
    if (portal === 'super_admin' && !isSuperAdmin) return { success: false, reason: 'not_super_admin' };

    localStorage.setItem('access_token', data.access);
    if (data.refresh) localStorage.setItem('refresh_token', data.refresh);
    localStorage.setItem('user_profile', JSON.stringify(profile));
    setUser(profile);
    setToken(data.access);
    return { success: true };
  };

  const logout = () => {
    clearSession();
    setToken(null);
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
};
