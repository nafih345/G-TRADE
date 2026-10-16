import { useCallback, useEffect, useState } from 'react';
import axios from 'axios';

// Bank accounts = Chart of Accounts rows with subtype BANK (backend financial/banks.py).
// One shared fetch for every payment widget on screen; a bank added from any of them shows up
// in all the others straight away.
let cache = null;
let inflight = null;
const listeners = new Set();

const publish = (rows) => {
  cache = rows;
  listeners.forEach((fn) => fn(rows));
};

const load = (force = false) => {
  if (cache && !force) return Promise.resolve(cache);
  if (!inflight) {
    inflight = axios.get('/api/financial/bank-accounts/')
      .then((res) => { publish(Array.isArray(res.data) ? res.data : []); return cache; })
      .catch(() => { publish(cache || []); return cache; })
      .finally(() => { inflight = null; });
  }
  return inflight;
};

export default function useBankAccounts() {
  const [banks, setBanks] = useState(cache || []);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    listeners.add(setBanks);
    load().then(() => setLoading(false));
    return () => { listeners.delete(setBanks); };
  }, []);

  const addBank = useCallback(async (details) => {
    const res = await axios.post('/api/financial/bank-accounts/', details);
    publish([...(cache || []), res.data]);
    return res.data;
  }, []);

  const reload = useCallback(() => load(true), []);

  return { banks, loading, addBank, reload };
}

export const bankName = (banks, id) => (banks.find((b) => b.id === id) || {}).name || '';
