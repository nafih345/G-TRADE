// Shared, persisted cache for the small master lists every form needs at once — Suppliers,
// Categories, Brands, Units.
//
// On the hosted backend each of these lists costs a round trip of a few hundred milliseconds
// (seconds when Render or Neon has just woken up), and every screen used to fetch them itself on
// open, so pickers sat blank and then filled in suddenly. Here a list is fetched once, kept in
// memory and in localStorage, and handed out instantly on the next open; a background revalidate
// keeps it current (stale-while-revalidate).
//
// - Entries are scoped by the signed-in tenant (JWT `tenant_id`), so two clients sharing a browser
//   never see each other's suppliers.
// - Any successful POST/PUT/PATCH/DELETE under a list's URL marks it stale (axios interceptor
//   below) — screens don't have to remember to invalidate.
// - A copy restored from localStorage always revalidates once per page load; a list fetched in
//   this page load is reused for FRESH_MS before the next background refresh.
import axios from 'axios';
import { useCallback, useEffect, useState } from 'react';
import { fetchAllPages } from './fetchAllPages.js';

export const MASTER_SOURCES = {
  suppliers: '/api/purchase/suppliers/',
  categories: '/api/masters/categories/',
  brands: '/api/masters/brands/',
  units: '/api/masters/units/',
};

export const MASTER_CACHE_PREFIX = 'optical_master_cache:';
const FRESH_MS = 30 * 1000;
const EMPTY = Object.freeze([]);

let fetchList = (url) => fetchAllPages(url);
/** Tests only: replace the network fetcher. */
export const __setMasterFetcher = (fn) => { fetchList = fn; };

const entries = new Map(); // storage key -> { data, fetchedAt, stale, promise, error }
const listeners = new Map(); // list name -> Set<fn>

const storage = () => {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
};

function tenantScope() {
  const token = storage()?.getItem('access_token');
  if (!token || token.startsWith('mock_jwt_token')) return 'local';
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return payload.tenant_id != null ? `t${payload.tenant_id}` : 'local';
  } catch {
    return 'local';
  }
}

const storageKey = (name) => `${MASTER_CACHE_PREFIX}${tenantScope()}:${name}`;

function entryFor(name) {
  const key = storageKey(name);
  let entry = entries.get(key);
  if (!entry) {
    entry = { data: null, fetchedAt: 0, stale: true, promise: null, error: null };
    try {
      const saved = JSON.parse(storage()?.getItem(key) || 'null');
      if (Array.isArray(saved?.rows)) entry.data = saved.rows;
    } catch { /* corrupt copy — refetch */ }
    entries.set(key, entry);
  }
  return entry;
}

function emit(name) {
  (listeners.get(name) || []).forEach((fn) => { try { fn(); } catch { /* listener bug */ } });
}

export function subscribeMaster(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name)?.delete(fn);
}

/** The cached rows (memory, else localStorage), or null when this list was never loaded. */
export function getMasterSnapshot(name) {
  return entryFor(name).data;
}

/**
 * Rows of a master list. Resolves at once from a fresh copy; otherwise fetches (one request
 * shared by every concurrent caller). `force` skips the freshness window.
 */
export function loadMaster(name, { force = false } = {}) {
  const url = MASTER_SOURCES[name];
  if (!url) return Promise.reject(new Error(`Unknown master list: ${name}`));
  const entry = entryFor(name);
  if (entry.promise) return entry.promise;
  if (!force && entry.data && !entry.stale && Date.now() - entry.fetchedAt < FRESH_MS) {
    return Promise.resolve(entry.data);
  }
  const key = storageKey(name);
  entry.promise = Promise.resolve()
    .then(() => fetchList(url))
    .then((rows) => {
      const list = Array.isArray(rows) ? rows : [];
      entry.data = list;
      entry.fetchedAt = Date.now();
      entry.stale = false;
      entry.error = null;
      try { storage()?.setItem(key, JSON.stringify({ savedAt: entry.fetchedAt, rows: list })); } catch { /* quota */ }
      return list;
    })
    .catch((err) => {
      entry.error = err;
      throw err;
    })
    .finally(() => {
      entry.promise = null;
      emit(name);
    });
  emit(name);
  return entry.promise;
}

/** Mark a list out of date; lists that a mounted screen is showing refetch right away. */
export function invalidateMaster(name) {
  const entry = entryFor(name);
  entry.stale = true;
  if (listeners.get(name)?.size) loadMaster(name).catch(() => {});
}

/** Warm every master list in the background (after sign-in / app boot). */
export function prefetchMasters(names = Object.keys(MASTER_SOURCES)) {
  return Promise.allSettled(names.map((n) => loadMaster(n)));
}

/** Forget every cached list (memory and localStorage), e.g. after a server data wipe. */
export function clearMasterCache() {
  entries.clear();
  const store = storage();
  if (!store) return;
  try {
    for (let i = store.length - 1; i >= 0; i -= 1) {
      const key = store.key(i);
      if (key && key.startsWith(MASTER_CACHE_PREFIX)) store.removeItem(key);
    }
  } catch { /* storage blocked */ }
}

/** Which list (if any) a request URL writes to. */
export function masterForUrl(url = '') {
  const path = String(url).replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0];
  return Object.keys(MASTER_SOURCES).find((n) => path.startsWith(MASTER_SOURCES[n])) || null;
}

let interceptorInstalled = false;
export function installMasterCacheInvalidation(client = axios) {
  if (interceptorInstalled || !client?.interceptors) return;
  interceptorInstalled = true;
  client.interceptors.response.use((response) => {
    const method = String(response?.config?.method || 'get').toLowerCase();
    if (method !== 'get') {
      const name = masterForUrl(response.config.url);
      if (name) invalidateMaster(name);
    }
    return response;
  });
}

/**
 * React hook: `{ data, loading, refreshing, error, refresh }`. `data` paints from the cache on the
 * first render; `loading` is true only while there is nothing cached yet (show a skeleton then).
 */
export function useMasterData(name, { enabled = true } = {}) {
  const [, setTick] = useState(0);
  useEffect(() => subscribeMaster(name, () => setTick((n) => n + 1)), [name]);
  useEffect(() => {
    if (enabled) loadMaster(name).catch(() => {});
  }, [name, enabled]);
  const refresh = useCallback(() => loadMaster(name, { force: true }), [name]);
  const entry = entryFor(name);
  return {
    data: entry.data || EMPTY,
    loading: !entry.data && !entry.error,
    refreshing: Boolean(entry.promise),
    error: entry.error,
    refresh,
  };
}
