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
// `/api/:path*` rewrite destination in vercel.json and the service name in render.yaml.
export const DEFAULT_DEPLOYED_API_URL = 'https://g-trade-backend.onrender.com';

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
// is up but its database/migrations are not; 'unreachable' when nothing answers at all.
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
  const baseUrl = axios.defaults.baseURL || '(same origin)';
  try {
    const { data } = await axios.get('/api/health/', { timeout: 90000 });
    if (clearLocalDataIfReset(data?.data_reset_epoch)) {
      window.location.reload();
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
      : err?.response
        ? `HTTP ${err.response.status} from /api/health/`
        : (err?.message || 'the request never reached a server');
    setState({ status: 'unreachable', detail, baseUrl, source: 'health' });
  }
  return state;
}

let installed = false;
let lastProbeAt = 0;
const REPROBE_INTERVAL_MS = 30000;

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

  axios.interceptors.response.use(
    (response) => {
      reprobeIfBroken();
      return response;
    },
    (error) => {
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
      } else if (!error?.response && error?.code !== 'ECONNABORTED' && !axios.isCancel?.(error)) {
        if (!keepHealthVerdict) {
          setState({
            status: 'unreachable',
            detail: error?.message || 'the request never reached a server',
            baseUrl: axios.defaults.baseURL || '(same origin)',
            source: 'traffic',
          });
        }
      }
      return Promise.reject(error);
    }
  );

  checkBackendHealth();
}
