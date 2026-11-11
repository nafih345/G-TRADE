// Global settings context — the tax side of Business & Localization.
//
//   const { isTaxEnabled, taxLabel, taxRegLabel, taxRegistrationNumber, taxSlabs } = useTaxSettings();
//
// taxLabel / taxRegLabel follow the country picked in Settings → Business & Localization
// (India GST/GSTIN, Gulf VAT/TRN, UK/EU VAT/VAT No, USA Sales Tax/Tax ID, else Tax/Tax
// Registration No). isTaxEnabled is the Tax Configuration master switch. taxSlabs are the active
// rates from Tax Configuration. Everything re-renders on save — no reload.
//
// Non-React code (bill rendering, pricing helpers) reads the same values synchronously from
// utils/localeFormat.js: getTaxSettings(), getTaxLabel(), isTaxEnabled(), effectiveTaxPercent().
import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import {
  BUSINESS_PREFS_EVENT, getBusinessPrefsState, getTaxSettings,
} from '../utils/localeFormat.js';
import { loadBusinessPrefs } from '../utils/businessPrefs.js';
import { useAuth } from './AuthContext';
import { setKnownTaxSlabs } from '../utils/taxRates.js';

export const TAX_SLABS_EVENT = 'tax_slabs_updated';
const SLABS_URL = '/api/company/tax-config/';

const SettingsContext = createContext(null);

/** Tell every screen the tax rates changed (Tax Configuration calls this after a save). */
export function notifyTaxSlabsChanged() {
  try { window.dispatchEvent(new CustomEvent(TAX_SLABS_EVENT)); } catch { /* not a browser */ }
}

function usePrefsSnapshot() {
  const [snap, setSnap] = useState(getBusinessPrefsState);
  useEffect(() => {
    const on = (e) => setSnap({ ...(e.detail || getBusinessPrefsState()) });
    window.addEventListener(BUSINESS_PREFS_EVENT, on);
    loadBusinessPrefs().then((s) => setSnap({ ...s })).catch(() => {});
    return () => window.removeEventListener(BUSINESS_PREFS_EVENT, on);
  }, []);
  return snap;
}

export function SettingsProvider({ children }) {
  const snap = usePrefsSnapshot();
  const { token } = useAuth() || {};
  const [slabs, setSlabs] = useState([]);

  const reloadTaxSlabs = useCallback(() => axios.get(SLABS_URL)
    .then((r) => {
      const rows = Array.isArray(r.data) ? r.data : [];
      const next = rows.filter((t) => t.is_active).map((t) => ({
        id: t.id,
        name: t.name,
        rate: Number(t.rate),
        inclusive: t.treatment === 'INCLUSIVE',
        category: t.category,
        isDefault: !!t.is_default,
        appliesToSales: t.applies_to_sales !== false,
        appliesToPurchases: t.applies_to_purchases !== false,
      }));
      setKnownTaxSlabs(next);
      setSlabs(next);
    })
    .catch(() => { /* keep the last list (offline / signed out) */ }), []);

  // Reload on sign-in / workspace switch too: the rates are per client.
  useEffect(() => { reloadTaxSlabs(); loadBusinessPrefs({ force: true }).catch(() => {}); }, [token, reloadTaxSlabs]);
  useEffect(() => {
    window.addEventListener(TAX_SLABS_EVENT, reloadTaxSlabs);
    return () => window.removeEventListener(TAX_SLABS_EVENT, reloadTaxSlabs);
  }, [reloadTaxSlabs]);

  const value = useMemo(() => {
    const tax = getTaxSettings(snap.preferences);
    return {
      prefs: snap.preferences,
      ...tax,
      taxRegistrationNumber: snap.tax_registration_number || '',
      taxSlabs: tax.isTaxEnabled ? slabs : [],
      reloadTaxSlabs,
    };
  }, [snap, slabs, reloadTaxSlabs]);

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

/** {prefs, isTaxEnabled, taxLabel, taxRegLabel, taxRegistrationNumber, taxSlabs, reloadTaxSlabs}. */
export function useSettings() {
  const ctx = useContext(SettingsContext);
  const snap = usePrefsSnapshot(); // keeps callers outside the provider (and print previews) live too
  if (ctx) return ctx;
  return {
    prefs: snap.preferences,
    ...getTaxSettings(snap.preferences),
    taxRegistrationNumber: snap.tax_registration_number || '',
    taxSlabs: [],
    reloadTaxSlabs: () => Promise.resolve(),
  };
}

export const useTaxSettings = useSettings;

export default SettingsContext;
