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

export function installSessionGuard() {
  if (installed) return;
  installed = true;
  axios.interceptors.response.use(undefined, async (error) => {
    const res = error?.response;
    const code = res?.data?.code;
    const config = error?.config;
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
