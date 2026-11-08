// Safety net for every API write (POST / PUT / PATCH / DELETE) made through the shared axios.
//
//  1. Idempotency-Key — each JSON write gets a random key that stays with that request config, so
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
//  5. Busy buttons — the Save / Add button that started a write shows a spinner and ignores
//     further clicks until the answer arrives; writes no button started show "Saving…"
//     (utils/busyButtons.js).
//  6. Shared reads — identical GETs in flight at once (same user, branch, URL, params) go out
//     as one request; each caller gets its own parsed copy.

import axios from 'axios';
import { notify, lastErrorNoticeAt } from './notify';
import { apiErrorMessage } from './apiError';
import { begin as busyBegin, end as busyEnd, installBusyButtons } from './busyButtons';
import { ACTIVE_BRANCH_KEY } from './apiClient';

const WRITE_METHODS = new Set(['post', 'put', 'patch', 'delete']);
// Writes the app makes on its own; they never show the "Saving…" indicator.
const BACKGROUND_WRITES = /\/api\/(security\/session\/heartbeat|auth\/logout|auth\/token\/refresh|company\/notifications|sales\/whatsapp|products\/label-settings\/import-legacy)/;
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

// A read is the same read only for the same signed-in user and branch. The branch header is
// added by apiClient's interceptor, which runs after this one (axios runs request
// interceptors last-installed first), so read it from where that interceptor does.
const readSignatureOf = (config) => {
  let branch = '';
  try { branch = localStorage.getItem(ACTIVE_BRANCH_KEY) || ''; } catch { /* no storage */ }
  const auth = config.headers?.Authorization || config.headers?.authorization || '';
  return `get|${config.baseURL || ''}|${config.url}|${JSON.stringify(config.params || {})}|${auth}|${branch}`;
};

/** Route this request through the identical one already in flight, or register it as the one
 *  later duplicates will share. */
function shareInFlight(config, sig) {
  if (!sig) return;
  const running = inflight.get(sig);
  if (running) {
    // Answer as this caller's own request — success or failure — so retries (token refresh,
    // re-auth) and per-call flags (__silentError) act on this config, not the original's.
    config.adapter = () => running.then(res => ({ ...res, data: ownCopy(res.data), config }), (err) => {
      if (!err || typeof err !== 'object' || !err.isAxiosError) throw err;
      const mine = Object.assign(Object.create(Object.getPrototypeOf(err)), err, { config });
      if (err.response) mine.response = { ...err.response, data: ownCopy(err.response.data), config };
      throw mine;
    });
    return;
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
    // Snapshot, not the object itself: axios parses the body by assigning response.data on the
    // original's response object, and the duplicates would all receive that one parsed object
    // (one screen sorting or editing its list changed the others'). This handler is attached
    // before axios's own, so the snapshot still holds the raw body.
    p.then(res => settle.resolve({ ...res }), settle.reject).finally(release);
    return p;
  };
}

// Raw bodies are strings (each caller parses its own); anything already parsed is cloned.
function ownCopy(data) {
  if (data === null || typeof data !== 'object') return data;
  try { return structuredClone(data); } catch { return data; }
}

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
  installBusyButtons();
  if (!axios.defaults.timeout) axios.defaults.timeout = REQUEST_TIMEOUT_MS;

  axios.interceptors.request.use((config) => {
    // File uploads and downloads can legitimately outlast the default on a slow line.
    if (config.timeout === REQUEST_TIMEOUT_MS
        && (isFormData(config.data) || config.responseType === 'blob' || config.responseType === 'arraybuffer')) {
      config.timeout = 0;
    }
    const method = String(config.method || 'get').toLowerCase();
    if (!WRITE_METHODS.has(method)) {
      // 6. Identical reads in flight at the same moment (several mounted screens asking for the
      // same list) share one network request. Each caller still gets its own parsed copy: the
      // adapter hands back the raw body and axios parses it per caller.
      if (method === 'get' && !config.signal && !config.cancelToken && !config.__allowDuplicate
          && !config.__sameOriginRetry && !config.__directRetry && !config.__authRetried
          && !config.__reauthRetried && !config.responseType) {
        shareInFlight(config, readSignatureOf(config));
      }
      return config;
    }
    // 5. Busy state: spinner on the button that started this write (utils/busyButtons.js).
    // Replays carry the original token, so the button stays busy until the final answer.
    if (!config.__busyToken) {
      config.__busyToken = busyBegin({ background: config.__background || BACKGROUND_WRITES.test(config.url || '') });
    }
    // Every JSON write, not only POST: a PATCH or DELETE whose answer was lost is replayed by the
    // network fallback too, and only the key lets the backend answer that replay from the first
    // attempt's result (apps/common/idempotency.py covers POST/PUT/PATCH/DELETE). FormData is
    // left out: the browser picks a new multipart boundary per send, so the body hash differs.
    if (!isFormData(config.data) && config.headers && !config.__skipIdempotencyKey
        && !config.headers['Idempotency-Key']) {
      config.headers['Idempotency-Key'] = newKey();
    }
    // Replays (fallback / refresh / re-auth retries) are the same request on purpose.
    if (config.__sameOriginRetry || config.__directRetry || config.__authRetried || config.__reauthRetried
        || config.__allowDuplicate) {
      return config;
    }
    shareInFlight(config, signatureOf(config));
    return config;
  });

  axios.interceptors.response.use((response) => {
    busyEnd(response?.config?.__busyToken);
    return response;
  }, (error) => {
    busyEnd(error?.config?.__busyToken);
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
