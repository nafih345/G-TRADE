// Safety net for every API write (POST / PUT / PATCH / DELETE) made through the shared axios.
//
//  1. Idempotency-Key — each POST gets a random key that stays with that request config, so
//     every automatic re-send of it (the proxy fallback in backendStatus.js, the token refresh
//     and password re-confirmation replays in sessionGuard.js) is recognised by the backend
//     (apps/common/idempotency.py) and answered with the first attempt's result instead of
//     saving the record twice.
//  2. Double submit — a second identical write (same method, URL and body) started while the
//     first is still on the wire shares the first one's answer instead of being sent again.
//  3. Timeout — no request waits forever. A screen used to spin indefinitely when the backend
//     was asleep or a save was stuck; now it gets an error it can show.
//  4. Never silent — a write that fails is reported with the server's own reason, unless the
//     screen reported it itself (any error notice/alert raised right after the failure counts).
//     Screens that handle a failure without telling the user can pass `{ __silentError: true }`.
import axios from 'axios';
import { notify, lastErrorNoticeAt } from './notify';
import { apiErrorMessage } from './apiError';

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
// Render's free plan can take ~50 s to wake, and a large purchase save on the hosted database
// takes a while more; anything past this is not coming back.
export const REQUEST_TIMEOUT_MS = 120000;
const REPORT_DELAY_MS = 400;

const inflight = new Map();

const newKey = () => {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* fall through */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
};

const isFormData = (data) => typeof FormData !== 'undefined' && data instanceof FormData;

const signatureOf = (config) => {
  if (isFormData(config.data)) return null;
  let body = config.data;
  if (body !== undefined && typeof body !== 'string') {
    try { body = JSON.stringify(body); } catch { return null; }
  }
  return `${config.method}|${config.baseURL || ''}|${config.url}|${JSON.stringify(config.params || {})}|${body || ''}`;
};

/** A one-line, human explanation of a failed API call (DRF validation errors included). */
export function describeApiError(error, fallback = 'The request failed.') {
  if (!error) return fallback;
  if (error.code === 'ECONNABORTED' || /timeout/i.test(error.message || '')) {
    return 'The server took too long to answer. The save may still finish — refresh the list before trying again.';
  }
  const res = error.response;
  if (!res) return 'Could not reach the server — check the connection. Nothing was confirmed as saved.';
  if (res.status === 404 && !res.data?.detail) return 'That record no longer exists (or belongs to another account).';
  if (res.status >= 500 && (typeof res.data !== 'object' || !res.data)) {
    return `The server hit an error (HTTP ${res.status}). Nothing was saved.`;
  }
  return apiErrorMessage(error, `${fallback} (HTTP ${res.status})`);
}

const shouldReport = (error) => {
  const config = error?.config;
  if (!config || config.__silentError || axios.isCancel?.(error)) return false;
  if (!WRITE_METHODS.has(String(config.method || '').toLowerCase())) return false;
  const status = error.response?.status;
  const code = error.response?.data?.code;
  // Handled elsewhere: sign-in expiry (sessionGuard signs out), password re-confirmation
  // (sessionGuard prompts), restore maintenance (sessionGuard notifies).
  if (status === 401) return false;
  if (status === 403 && code === 'reauth_required') return false;
  if (status === 423) return false;
  return true;
};

let installed = false;

export function installApiWriteGuard() {
  if (installed) return;
  installed = true;
  if (!axios.defaults.timeout) axios.defaults.timeout = REQUEST_TIMEOUT_MS;

  axios.interceptors.request.use((config) => {
    // File uploads and downloads can legitimately outlast the default on a slow line.
    if (config.timeout === REQUEST_TIMEOUT_MS
        && (isFormData(config.data) || config.responseType === 'blob' || config.responseType === 'arraybuffer')) {
      config.timeout = 0;
    }
    const method = String(config.method || 'get').toLowerCase();
    if (!WRITE_METHODS.has(method)) return config;
    if (method === 'post' && !isFormData(config.data) && config.headers
        && !config.headers['Idempotency-Key']) {
      config.headers['Idempotency-Key'] = newKey();
    }
    // Replays (fallback / refresh / re-auth retries) are the same request on purpose.
    if (config.__sameOriginRetry || config.__directRetry || config.__authRetried || config.__reauthRetried
        || config.__allowDuplicate) {
      return config;
    }
    const sig = signatureOf(config);
    if (!sig) return config;
    const running = inflight.get(sig);
    if (running) {
      config.adapter = () => running.then(res => ({ ...res, config }));
      return config;
    }
    const defaultAdapter = axios.getAdapter(config.adapter || axios.defaults.adapter);
    // Registered now, not when the adapter runs: axios reaches the adapter a few ticks later,
    // and a double click's second request is already through this interceptor by then.
    let settle;
    const shared = new Promise((resolve, reject) => { settle = { resolve, reject }; });
    shared.catch(() => {});
    inflight.set(sig, shared);
    const release = () => { if (inflight.get(sig) === shared) inflight.delete(sig); };
    let started = false;
    // Should the request never reach the network (cancelled before sending), don't strand the
    // duplicates waiting on it.
    setTimeout(() => {
      if (!started) { release(); settle.reject(new axios.Cancel('The original request was not sent.')); }
    }, 5000);
    config.adapter = (cfg) => {
      started = true;
      const p = Promise.resolve().then(() => defaultAdapter(cfg));
      p.then(settle.resolve, settle.reject).finally(release);
      return p;
    };
    return config;
  });

  axios.interceptors.response.use(undefined, (error) => {
    if (shouldReport(error)) {
      const failedAt = Date.now();
      setTimeout(() => {
        // The screen explained the failure itself (notify / alert with an error) — don't repeat it.
        if (lastErrorNoticeAt() >= failedAt) return;
        notify(describeApiError(error, 'The change was not saved.'), 'error');
      }, REPORT_DELAY_MS);
    }
    return Promise.reject(error);
  });
}
