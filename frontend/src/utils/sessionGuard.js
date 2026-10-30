// Global response handling for the server-side session policy (apps/security/policy.py):
//
//  * 401 session_expired / session_timeout → the session is over: AuthContext signs out and the
//    sign-in page explains why.
//  * 403 reauth_required → a sensitive action needs the password again: <ReauthDialogHost /> asks,
//    and the original request is retried once on success (callers never see the 403).
//  * 423 maintenance → a restore is running; say so instead of a generic failure.
import axios from 'axios';
import { notify } from './notify';

export const SESSION_ENDED_EVENT = 'auth:session-ended';
export const SECURITY_POLICY_EVENT = 'security:policy-changed';
export const AUTH_NOTICE_KEY = 'auth_notice';

let reauthHandler = null;
let pendingReauth = null;
let installed = false;

/** <ReauthDialogHost /> registers a function returning Promise<boolean>. */
export function registerReauthHandler(fn) {
  reauthHandler = fn;
  return () => { if (reauthHandler === fn) reauthHandler = null; };
}

/** Ask for the password now (one prompt shared by concurrent requests). */
export function requestReauth() {
  if (!reauthHandler) return Promise.resolve(false);
  if (!pendingReauth) {
    pendingReauth = Promise.resolve(reauthHandler()).finally(() => { pendingReauth = null; });
  }
  return pendingReauth;
}

/** End the local session and leave a message for the sign-in page. */
export function announceSessionEnded(message) {
  try { sessionStorage.setItem(AUTH_NOTICE_KEY, message); } catch { /* storage unavailable */ }
  window.dispatchEvent(new CustomEvent(SESSION_ENDED_EVENT, { detail: { message } }));
}

export const TOKEN_REFRESHED_EVENT = 'auth:token-refreshed';

let pendingRefresh = null;

/**
 * The access token lives 24h (SIMPLE_JWT.ACCESS_TOKEN_LIFETIME). A tab left open past that used
 * to get 401 `token_not_valid` on every request — empty screens, nothing saved — until the user
 * reloaded. Trade the refresh token for a new access token instead; concurrent 401s share one
 * refresh. Resolves to the new access token, or null when the session really is over.
 */
function refreshAccessToken() {
  if (!pendingRefresh) {
    pendingRefresh = (async () => {
      const refresh = localStorage.getItem('refresh_token');
      if (!refresh) return null;
      try {
        const { data } = await axios.post('/api/auth/token/refresh/', { refresh }, { __skipAuthRefresh: true });
        if (!data?.access) return null;
        localStorage.setItem('access_token', data.access);
        if (data.refresh) localStorage.setItem('refresh_token', data.refresh);
        axios.defaults.headers.common.Authorization = `Bearer ${data.access}`;
        window.dispatchEvent(new CustomEvent(TOKEN_REFRESHED_EVENT, { detail: { access: data.access } }));
        return data.access;
      } catch {
        return null;
      }
    })().finally(() => { pendingRefresh = null; });
  }
  return pendingRefresh;
}

export function installSessionGuard() {
  if (installed) return;
  installed = true;
  axios.interceptors.response.use(undefined, async (error) => {
    const res = error?.response;
    const code = res?.data?.code;
    const config = error?.config;
    // Expired access token: refresh once and replay the request; if that fails, sign out cleanly.
    if (res?.status === 401 && code === 'token_not_valid' && config && !config.__skipAuthRefresh
        && !config.__authRetried && axios.defaults.headers.common.Authorization) {
      const access = await refreshAccessToken();
      if (access) {
        return axios.request({
          ...config,
          headers: { ...config.headers, Authorization: `Bearer ${access}` },
          __authRetried: true,
        });
      }
      if (axios.defaults.headers.common.Authorization) {
        announceSessionEnded('Your sign-in has expired. Please sign in again.');
      }
      return Promise.reject(error);
    }
    // user_not_found: the account behind the token no longer exists (e.g. after a database restore).
    if (res?.status === 401 && ['session_expired', 'session_timeout', 'user_not_found', 'user_inactive'].includes(code)
        && axios.defaults.headers.common.Authorization) {
      announceSessionEnded(res.data.detail || 'Your session has ended. Please sign in again.');
    } else if (res?.status === 403 && code === 'reauth_required' && config && !config.__reauthRetried) {
      if (await requestReauth()) return axios.request({ ...config, __reauthRetried: true });
    } else if (res?.status === 423 && code === 'maintenance') {
      notify(res.data.detail, 'warning');
    }
    return Promise.reject(error);
  });
}
