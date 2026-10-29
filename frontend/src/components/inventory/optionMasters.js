// Add / rename / delete handlers for the "+" option masters (AttributeField), shared by the
// Product Master dialog and Add Multiple Items. Category, Brand and Unit are backend masters;
// the rest are local lists (see productAttributeOptions.js).

import axios from 'axios';
import { readList, writeList } from './productAttributeOptions';

export const genCode = (name, len = 3) =>
  (name || 'GEN').replace(/[^a-zA-Z0-9]/g, '').slice(0, len).toUpperCase().padEnd(len, 'X')
  + Math.floor(10 + Math.random() * 89);

const hideDefault = (key, name) => {
  if (key) writeList(key, Array.from(new Set([...readList(key, []), name])));
};

// Loads a backend master into an option list ({name: id} records + names), dropping
// built-in fallback names the user hid.
export const loadBackendMaster = (url, defaults, hiddenKey, setOptions, setRecords) => {
  const hidden = new Set(hiddenKey ? readList(hiddenKey, []) : []);
  return axios.get(url)
    .then(r => {
      const rows = (r.data?.results || r.data || []).filter(x => x?.name);
      const records = {};
      rows.forEach(x => { records[x.name] = x.id; });
      setRecords(records);
      setOptions(Array.from(new Set([...rows.map(x => x.name), ...defaults.filter(d => !hidden.has(d))])));
    }).catch(() => {
      setOptions(defaults.filter(d => !hidden.has(d)));
    });
};

// Backend masters (Category / Brand / Unit). Products reference these by FK, so a
// rename shows up on every product and a delete just clears the link.
export const backendMaster = (url, hiddenKey, records, setRecords, setOptions) => ({
  persist: async (name) => {
    setOptions(o => Array.from(new Set([name, ...o])));
    try {
      const r = await axios.post(url, { name, code: genCode(name) });
      if (r.data?.id) setRecords(m => ({ ...m, [name]: r.data.id }));
    } catch {}
  },
  rename: async (from, to) => {
    const id = records[from];
    if (id) {
      await axios.patch(`${url}${id}/`, { name: to });
    } else {
      // Built-in name with no DB row yet — create the new one, hide the old.
      const r = await axios.post(url, { name: to, code: genCode(to) });
      if (r.data?.id) setRecords(m => ({ ...m, [to]: r.data.id }));
    }
    hideDefault(hiddenKey, from);
    setRecords(m => {
      const next = { ...m };
      if (id) { delete next[from]; next[to] = id; }
      return next;
    });
    setOptions(o => Array.from(new Set(o.map(x => (x === from ? to : x)))));
  },
  remove: async (name) => {
    const id = records[name];
    if (id) await axios.delete(`${url}${id}/`);
    hideDefault(hiddenKey, name);
    setRecords(m => { const next = { ...m }; delete next[name]; return next; });
    setOptions(o => o.filter(x => x !== name));
  }
});

// Local lists (Sub-Category / Group / Model Number / Size / Color / Material …). These are
// stored as plain text on each product, so a rename only affects new entries.
export const localMaster = (key, setter) => {
  const update = (fn) => setter(o => {
    const next = fn(o);
    writeList(key, next);
    return next;
  });
  return {
    persist: async (name) => update(o => Array.from(new Set([name, ...o]))),
    rename: async (from, to) => update(o => Array.from(new Set(o.map(x => (x === from ? to : x))))),
    remove: async (name) => update(o => o.filter(x => x !== name))
  };
};
