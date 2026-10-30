// Where the API lives, and whether it is actually answering.
//
// Both halves exist because of the same outage: the hosted backend spent weeks serving a
// deleted Postgres, every request came back 500, and the app rendered a calm, empty shell —
// "₹0.00 revenue", "System Operations Normal" — with nothing anywhere saying the database
// was gone. resolveApiBaseUrl() makes the target repointable without a rebuild;
// installBackendHealthWatch() makes a dead target visible.
import axios from 'axios';
import { clearLocalDataIfReset } from './localDataReset';

export const API_BASE_OVERRIDE_KEY = 'api_base_url';

// Default target for any deployed (non-localhost) build. Keep this in step with the
// `/api/(.*)` rewrite destination in vercel.json and the service name in render.yaml.
export const DEFAULT_DEPLOYED_API_URL = 'https://g-trade-backend.onrender.com';

// The backend API version this build needs (backend/config/urls.py API_VERSION). Vercel and
// Render deploy independently; when only the frontend has the new release, every new screen
// fails with a bare 404. Comparing versions turns that into one clear "redeploy the backend".
export const REQUIRED_API_VERSION = 2;

const isLocalhost = () =>
  /^(localhost|127\.0\.0\.1|\[::1\])$/.test(window.location.hostname);

/**
 * Priority: localStorage override → VITE_API_URL (inlined at build time) → the deployed
 * default → '' so the Vite dev proxy handles it locally.
 *
 * The localStorage override is the escape hatch. Everything else here is frozen into the
 * bundle when it is built, so when the hosted frontend got stuck on a stale deployment
 * pointing at a dead backend, there was no way to repoint it short of a successful
 * redeploy. With this, one line in the browser console does it:
 *
 *     localStorage.setItem('api_base_url', 'https://some-other-backend.onrender.com')
 *
 * Deliberately absolute rather than relying on vercel.json's /api/* rewrite: a Render free
 * instance spins down when idle and takes ~50s to wake, which outlives Vercel's proxy
 * timeout, whereas the browser will happily wait out a direct request.
 */
export function resolveApiBaseUrl() {
  let override = null;
  try {
    override = localStorage.getItem(API_BASE_OVERRIDE_KEY);
  } catch {
    /* private mode / blocked storage — fall through to the build-time value */
  }
  if (override) return override.replace(/\/+$/, '');
  if (import.meta.env.VITE_API_URL) return import.meta.env.VITE_API_URL;
  return isLocalhost() ? '' : DEFAULT_DEPLOYED_API_URL;
}

// 'checking' until the first probe answers; 'ok' once it does; 'degraded' when the backend
// is up but its database/migrations are not; 'outdated' when it is healthy but an older release
// than this frontend; 'unreachable' when nothing answers at all; 'offline' when the browser
// itself has no network (navigator.onLine), which no server-side fix would help.
//
// `source` records who decided. /api/health/ says *why* it is broken — "could not translate
// host name dpg-…" names the deleted database outright — whereas ordinary traffic can only
// report "HTTP 500 from /api/purchase/orders/". So a verdict from the health endpoint is
// never overwritten by one inferred from traffic.
let state = { status: 'checking', detail: '', baseUrl: '', source: null };
const listeners = new Set();

const setState = (next) => {
  if (next.status === state.status && next.detail === state.detail) return;
  state = { ...state, ...next };
  listeners.forEach((fn) => fn(state));
};

export const getBackendStatus = () => state;

export const subscribeBackendStatus = (fn) => {
  listeners.add(fn);
  fn(state);
  return () => listeners.delete(fn);
};

/**
 * Ask the backend how it is. /api/health/ answers 200 even when the database is gone —
 * that is the point of it — so the body, not the status code, decides.
 *
 * A free-tier instance that has spun down takes ~50s to answer the first request, so the
 * timeout is generous and a timeout is reported as its own thing rather than as "down".
 */
export async function checkBackendHealth() {
  lastProbeAt = Date.now();
  if (isOffline()) {
    setState({ status: 'offline', detail: 'this computer has no internet connection', baseUrl: primaryBaseUrl || '(same origin)', source: 'health' });
    return state;
  }
  // Every probe goes to the primary (direct) address first, so a session that fell back to the
  // Vercel proxy during a blip returns to the direct road as soon as it works again.
  if (primaryBaseUrl !== null && axios.defaults.baseURL !== primaryBaseUrl) {
    try {
      await axios.get('/api/health/', { baseURL: primaryBaseUrl, timeout: 90000, __noFallback: true });
      console.info(`[api] ${primaryBaseUrl} reachable again; leaving the same-origin /api proxy`);
      axios.defaults.baseURL = primaryBaseUrl;
    } catch {
      /* still unreachable directly — probe through whatever road is current */
    }
  }
  const baseUrl = axios.defaults.baseURL || '(same origin)';
  try {
    const { data } = await axios.get('/api/health/', { timeout: 90000, __noFallback: true });
    if (clearLocalDataIfReset(data?.data_reset_epoch)) {
      window.location.reload();
      return state;
    }
    const apiVersion = Number(data?.api_version) || 1;
    if (data?.status === 'ok' && apiVersion < REQUIRED_API_VERSION) {
      setState({
        status: 'outdated',
        detail: `backend API v${apiVersion}${data?.commit ? ` (build ${data.commit})` : ''}, this app needs v${REQUIRED_API_VERSION}`,
        baseUrl,
        source: 'health',
      });
      return state;
    }
    if (data?.status === 'ok') {
      setState({ status: 'ok', detail: '', baseUrl, source: 'health' });
      return state;
    }
    // Reported degraded: surface the specific reason — a missing database host reads
    // "could not translate host name …", pending migrations list the migration names.
    const reason =
      (typeof data?.database === 'string' && data.database.startsWith('error') && data.database) ||
      (data?.pending_migrations?.length && `pending migrations: ${data.pending_migrations.join(', ')}`) ||
      (typeof data?.migrations === 'string' && data.migrations !== 'up_to_date' && data.migrations) ||
      'the backend reported itself degraded';
    setState({ status: 'degraded', detail: String(reason).trim(), baseUrl, source: 'health' });
  } catch (err) {
    const detail = err?.code === 'ECONNABORTED'
      ? 'no answer within 90s — the server may be asleep or gone'
      : isHibernating(err)
        ? 'the server is asleep and waking up (HTTP 429 from the proxy) — retrying'
        : err?.response
          ? `HTTP ${err.response.status} from /api/health/`
          : (err?.message || 'the request never reached a server');
    setState({ status: 'unreachable', detail, baseUrl, source: 'health' });
  }
  return state;
}

let installed = false;
let lastProbeAt = 0;
// The address resolveApiBaseUrl() chose at boot; null until installBackendHealthWatch runs.
let primaryBaseUrl = null;

const isOffline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

// A sleeping Render free instance will not be woken by traffic arriving through Vercel's
// rewrite: Render answers it 429 with `x-render-routing: hibernate-rate-limited`, and keeps
// doing so until something else wakes the service. Only a direct request does that.
// (The app's own throttles — sign-in lockout — also answer 429, but with a JSON body.)
const isHibernating = (error) => {
  const res = error?.response;
  if (res?.status !== 429) return false;
  return /hibernate/i.test(res.headers?.['x-render-routing'] || '') || typeof res.data === 'string';
};
const REPROBE_INTERVAL_MS = 30000;
const UNREACHABLE_RETRY_MS = 15000;

// The browser talks to Render directly (see resolveApiBaseUrl), which means *the user's own
// DNS* has to resolve onrender.com. Home-router resolvers drop lookups intermittently and the
// browser reports net::ERR_NAME_NOT_RESOLVED — the backend is fine, the PC just couldn't find
// it. A Vercel-hosted page has a second road to the same backend: vercel.json rewrites
// same-origin /api/* to Render, and Vercel's servers do the DNS lookup. So when a direct
// request fails before any server answered, retry it once through that road and stay on it
// for the rest of the session.
const canFallBackToSameOrigin = () => {
  const base = axios.defaults.baseURL;
  if (!base || !/^https?:$/.test(window.location.protocol) || isLocalhost()) return false;
  try {
    return new URL(base).origin !== window.location.origin;
  } catch {
    return false;
  }
};

const isNetworkFailure = (error) =>
  !error?.response && error?.code !== 'ECONNABORTED' && !axios.isCancel?.(error);

// A single successful response is not proof the outage is over — with a half-broken
// database plenty of endpoints still answer 200. So rather than clearing the banner on
// one success, re-ask the endpoint that actually knows, at most every 30s.
const reprobeIfBroken = () => {
  if (state.status === 'ok' || state.status === 'checking') return;
  if (Date.now() - lastProbeAt < REPROBE_INTERVAL_MS) return;
  checkBackendHealth();
};

/**
 * Probe once at boot, then let ordinary traffic keep the verdict current: a 5xx or a
 * request that never reached a server raises the banner, and later traffic of any kind
 * triggers a fresh probe to decide whether it can come down. Without this the app's own
 * screens are the only evidence, and an empty screen looks exactly like a business with no
 * data yet.
 */
export function installBackendHealthWatch() {
  if (installed) return;
  installed = true;
  primaryBaseUrl = axios.defaults.baseURL || '';

  axios.interceptors.response.use(
    (response) => {
      reprobeIfBroken();
      return response;
    },
    (error) => {
      const config = error?.config;
      // Offline (net::ERR_INTERNET_DISCONNECTED): the proxy is no more reachable than the
      // backend, so switching roads would only strand the session on the proxy afterwards.
      if (config && !config.__sameOriginRetry && !config.__noFallback && isNetworkFailure(error)
          && !isOffline() && canFallBackToSameOrigin()) {
        console.warn(
          `[api] ${axios.defaults.baseURL} unreachable (${error.message}); switching to the same-origin /api proxy`
        );
        axios.defaults.baseURL = '';
        return axios.request({ ...config, baseURL: '', __sameOriginRetry: true });
      }
      // On the proxy and the backend has gone to sleep: the proxy cannot wake it, a direct
      // request can. Go back to the direct road and retry there.
      if (config && !config.__directRetry && !config.__noFallback && primaryBaseUrl
          && config.baseURL === '' && isHibernating(error)) {
        console.warn('[api] backend asleep behind the proxy; retrying directly to wake it');
        axios.defaults.baseURL = primaryBaseUrl;
        return axios.request({ ...config, baseURL: primaryBaseUrl, __directRetry: true, timeout: Math.max(config.timeout || 0, 90000) });
      }

      // A 4xx is the API working and saying no; only a 5xx or a dead socket is an outage.
      const status = error?.response?.status;
      const keepHealthVerdict = state.source === 'health' && state.status !== 'ok';
      if (status >= 500) {
        if (!keepHealthVerdict) {
          setState({
            status: 'degraded',
            detail: `HTTP ${status} from ${error.config?.url || 'the API'}`,
            baseUrl: axios.defaults.baseURL || '(same origin)',
            source: 'traffic',
          });
        }
        // Traffic noticed trouble the boot probe may have missed — go ask properly.
        reprobeIfBroken();
      } else if (isNetworkFailure(error)) {
        if (!keepHealthVerdict) {
          setState({
            status: isOffline() ? 'offline' : 'unreachable',
            detail: isOffline() ? 'this computer has no internet connection' : (error?.message || 'the request never reached a server'),
            baseUrl: axios.defaults.baseURL || '(same origin)',
            source: 'traffic',
          });
        }
      }
      return Promise.reject(error);
    }
  );

  checkBackendHealth();
  installKeepAwake();

  // "Unreachable" is usually a blip (DNS hiccup, Wi-Fi drop). Keep asking while it lasts so
  // the banner clears by itself instead of waiting for the user to press Re-check.
  setInterval(() => {
    if ((state.status === 'unreachable' || state.status === 'offline') && !isOffline()
        && Date.now() - lastProbeAt >= UNREACHABLE_RETRY_MS) {
      checkBackendHealth();
    }
  }, 5000);
  window.addEventListener('online', () => checkBackendHealth());
  window.addEventListener('offline', () => checkBackendHealth());
}

// Render's free plan puts the backend to sleep after 15 minutes without a request. Filling in
// a long Purchase Entry makes no API calls, so the Save that follows used to land on a
// sleeping server and wait ~50s for it to boot. While the app is open and visible, a cheap
// health probe every 10 minutes keeps it awake; a tab coming back after a long absence
// probes at once so the server is warming up while the user reads the screen.
const KEEP_AWAKE_INTERVAL_MS = 10 * 60 * 1000;

function installKeepAwake() {
  let host = '';
  try {
    host = new URL(axios.defaults.baseURL || window.location.origin, window.location.href).hostname;
  } catch {
    return;
  }
  if (!/\.onrender\.com$/i.test(host)) return;
  const pingIfDue = () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - lastProbeAt < KEEP_AWAKE_INTERVAL_MS) return;
    checkBackendHealth();
  };
  setInterval(pingIfDue, 60 * 1000);
  document.addEventListener('visibilitychange', pingIfDue);
}
