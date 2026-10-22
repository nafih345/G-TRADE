// Business & Localization preferences (Settings → Business & Localization).
//
// The backend (/api/company/localization/) is the source of truth. The last copy is cached in
// localStorage (utils/localeFormat.js) so synchronous readers — bill rendering, number
// formatting — work before the first fetch and offline.
import { useEffect, useState } from 'react';
import axios from 'axios';
import {
  BUSINESS_PREFS_EVENT, getBusinessPrefs, getBusinessPrefsState, publishBusinessPrefs,
} from './localeFormat.js';

export * from './localeFormat.js';

const URL = '/api/company/localization/';
let inflight = null;

export async function loadBusinessPrefs({ force = false } = {}) {
  const state = getBusinessPrefsState();
  if (state.loaded && !force) return state;
  if (inflight) return inflight;
  inflight = axios.get(URL)
    .then((res) => publishBusinessPrefs(res.data))
    .catch(() => getBusinessPrefsState())
    .finally(() => { inflight = null; });
  return inflight;
}

/** Save a partial update. Resolves the server's payload; rejects with the axios error. */
export async function saveBusinessPrefs(partial) {
  const res = await axios.put(URL, partial);
  publishBusinessPrefs(res.data);
  return res.data;
}

export const fetchLocalizationCatalog = () => axios.get(`${URL}catalog/`).then((r) => r.data);

/** React hook: {prefs, currencySymbol} kept current across saves. */
export function useBusinessPrefs() {
  const [snap, setSnap] = useState(getBusinessPrefsState);
  useEffect(() => {
    const on = (e) => setSnap(e.detail || getBusinessPrefsState());
    window.addEventListener(BUSINESS_PREFS_EVENT, on);
    loadBusinessPrefs().then(setSnap);
    return () => window.removeEventListener(BUSINESS_PREFS_EVENT, on);
  }, []);
  return { prefs: snap.preferences, currencySymbol: snap.currency_symbol };
}

// ---------------------------------------------------------------------------
// Workflow helpers
// ---------------------------------------------------------------------------

/** "Require Confirmation Before Posting": asks before an invoice / purchase / adjustment posts.
 *  Returns true straight away when the preference is off. */
export function confirmPosting(what) {
  if (!getBusinessPrefs().confirm_before_posting) return true;
  // eslint-disable-next-line no-alert
  return window.confirm(`Post ${what}?\n\nThis updates stock and the accounts. OK to post, Cancel to go back.`);
}

/** The number the next document of `docType` would get, or null when the system doesn't number
 *  it (auto-generation off / sequence inactive / unreachable server). Not a reservation. */
export async function peekDocumentNumber(docType) {
  try {
    const { data } = await axios.get(`/api/company/document-sequences/${docType}/peek/`);
    return data?.system_numbered ? data.preview : null;
  } catch {
    return null;
  }
}
