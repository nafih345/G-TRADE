import React, {
  forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useState,
} from 'react';
import axios from 'axios';
import { Alert, Box, Button, Card, Skeleton, Tab, Tabs } from '@mui/material';
import {
  Tune as GeneralIcon, Public as CurrencyIcon, Percent as TaxIcon, FormatListNumbered as NumberingIcon,
  SettingsSuggest as OtherIcon, DashboardCustomize as FieldsIcon,
} from '@mui/icons-material';
import GeneralTab, { GENERAL_KEYS } from './GeneralTab';
import CurrencyLanguageTab, { CURRENCY_KEYS } from './CurrencyLanguageTab';
import OtherSettingsTab, { OTHER_KEYS } from './OtherSettingsTab';
import TaxConfigTab from './TaxConfigTab';
import NumberingTab from './NumberingTab';
import CustomFieldsTab from './CustomFieldsTab';
import { GREEN } from './businessUi';
import { fetchLocalizationCatalog, saveBusinessPrefs, DEFAULT_PREFS } from '../../../utils/businessPrefs';
import { STORE_PROFILE_EVENT, fetchStoreProfile } from '../../../utils/storeProfile';
import { setNavigationGuard } from '../../../utils/navigationGuard';
import { notify } from '../../../utils/notify';
import { apiErrorMessage } from '../../../utils/apiError';

export const SECTIONS = [
  { id: 'general', label: 'General', icon: <GeneralIcon />, keys: GENERAL_KEYS },
  { id: 'currency', label: 'Currency & Language', icon: <CurrencyIcon />, keys: CURRENCY_KEYS },
  { id: 'tax', label: 'Tax Configuration', icon: <TaxIcon />, keys: [] },
  { id: 'numbering', label: 'Numbering Sequences', icon: <NumberingIcon />, keys: [] },
  { id: 'other', label: 'Other Settings', icon: <OtherIcon />, keys: OTHER_KEYS },
  { id: 'fields', label: 'Custom Fields', icon: <FieldsIcon />, keys: [] },
];
const FORM_SECTIONS = new Set(['general', 'currency', 'other']);
const LEAVE_MESSAGE = 'You have unsaved Business & Localization changes. Leave without saving?';

const toForm = (payload) => ({ ...DEFAULT_PREFS, ...(payload?.preferences || {}), currency_symbol: payload?.currency_symbol || '₹' });
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sectionOf = (key) => SECTIONS.find((s) => s.keys.includes(key))?.id || 'general';

function clientErrors(f) {
  const e = {};
  if (!f.country) e.country = 'Choose a country.';
  if (!f.time_zone) e.time_zone = 'Choose a time zone.';
  if (!String(f.currency_symbol || '').trim()) e.currency_symbol = 'Enter the symbol printed with amounts.';
  if (f.multi_currency_enabled && !(f.enabled_currencies || []).length) {
    e.multi_currency_enabled = 'Add at least one additional currency (Currency & Language) first.';
  }
  if (f.multi_currency_enabled) {
    const missing = (f.enabled_currencies || []).filter((c) => !(Number(f.exchange_rates?.[c]) > 0));
    if (missing.length) e.exchange_rates = Object.fromEntries(missing.map((c) => [c, 'Enter a rate greater than 0.']));
  }
  [['default_payment_terms_days', 0, 365], ['max_discount_percent', 0, 100], ['service_charge_percent', 0, 100]].forEach(([k, lo, hi]) => {
    const n = Number(f[k]);
    if (f[k] === '' || !Number.isFinite(n) || n < lo || n > hi) e[k] = `Must be between ${lo} and ${hi}.`;
  });
  return e;
}

const BusinessLocalizationSettings = forwardRef(function BusinessLocalizationSettings(
  { initialSection = 'general', onStateChange }, ref,
) {
  const [section, setSection] = useState(SECTIONS.some((s) => s.id === initialSection) ? initialSection : 'general');
  const [catalog, setCatalog] = useState(null);
  const [saved, setSaved] = useState(null);
  const [form, setForm] = useState(null);
  const [errors, setErrors] = useState({});
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState('');
  const [savedAt, setSavedAt] = useState(0);

  useEffect(() => { if (SECTIONS.some((s) => s.id === initialSection)) setSection(initialSection); }, [initialSection]);

  const load = useCallback(async () => {
    setLoadError('');
    try {
      const [prefsRes, cat] = await Promise.all([axios.get('/api/company/localization/'), fetchLocalizationCatalog()]);
      const f = toForm(prefsRes.data);
      setCatalog(cat);
      setSaved(f);
      setForm(f);
    } catch (e) {
      setLoadError(`Could not load Business & Localization settings. ${apiErrorMessage(e)}`);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const dirtyKeys = useMemo(() => {
    if (!form || !saved) return new Set();
    return new Set(Object.keys(form).filter((k) => !same(form[k], saved[k])));
  }, [form, saved]);
  const dirty = dirtyKeys.size > 0;
  const dirtySections = useMemo(() => new Set([...dirtyKeys].map(sectionOf)), [dirtyKeys]);

  // Unsaved changes: warn on reload / close and on in-app navigation.
  useEffect(() => {
    if (!dirty) return undefined;
    const onBeforeUnload = (e) => { e.preventDefault(); e.returnValue = LEAVE_MESSAGE; return LEAVE_MESSAGE; };
    window.addEventListener('beforeunload', onBeforeUnload);
    const release = setNavigationGuard(LEAVE_MESSAGE);
    return () => { window.removeEventListener('beforeunload', onBeforeUnload); release(); };
  }, [dirty]);

  const clearErr = (keys) => setErrors((e) => {
    const next = { ...e };
    keys.forEach((k) => delete next[k]);
    return next;
  });
  const set = useCallback((key, value) => { setForm((f) => ({ ...f, [key]: value })); clearErr([key]); }, []);
  const setMany = useCallback((obj) => { setForm((f) => ({ ...f, ...obj })); clearErr(Object.keys(obj)); }, []);

  const discard = useCallback(() => { setForm(saved); setErrors({}); }, [saved]);

  const save = useCallback(async () => {
    if (!form || !dirty || saving) return false;
    const ce = clientErrors(form);
    if (Object.keys(ce).length) {
      setErrors(ce);
      setSection(sectionOf(Object.keys(ce)[0]));
      notify('Please fix the highlighted fields before saving.', 'error');
      return false;
    }
    const patch = Object.fromEntries([...dirtyKeys].map((k) => [k, form[k]]));
    // Cross-field rules are checked on the merged result, so send the related fields together.
    if ('enabled_currencies' in patch || 'multi_currency_enabled' in patch) {
      patch.enabled_currencies = form.enabled_currencies;
      patch.exchange_rates = form.exchange_rates;
    }
    setSaving(true);
    try {
      const data = await saveBusinessPrefs(patch);
      const f = toForm(data);
      setSaved(f);
      setForm(f);
      setErrors({});
      setSavedAt(Date.now());
      if ('currency_symbol' in patch) {
        // The symbol lives on the store profile — let every screen that caches it know.
        fetchStoreProfile().then((p) => {
          try { window.dispatchEvent(new CustomEvent(STORE_PROFILE_EVENT, { detail: p })); } catch { /* ignore */ }
        }).catch(() => {});
      }
      notify('Business & Localization settings saved.', 'success');
      return true;
    } catch (e) {
      const body = e?.response?.data;
      if (body?.errors) {
        setErrors(body.errors);
        setSection(sectionOf(Object.keys(body.errors)[0]));
      }
      notify(`Settings were not saved. ${body?.detail || apiErrorMessage(e)}`, 'error');
      return false;
    } finally {
      setSaving(false);
    }
  }, [form, dirty, dirtyKeys, saving]);

  useImperativeHandle(ref, () => ({ save, discard, isDirty: () => dirty }), [save, discard, dirty]);
  useEffect(() => {
    onStateChange?.({ dirty, saving, canSave: !!saved });
  }, [dirty, saving, saved, onStateChange]);

  if (loadError) {
    return <Alert severity="error" sx={{ borderRadius: 3 }} action={<Button color="inherit" size="small" onClick={load}>Retry</Button>}>{loadError}</Alert>;
  }

  return (
    <Box>
      <Card elevation={0} sx={{ mb: 3, borderRadius: 3, border: '1px solid', borderColor: 'divider' }}>
        <Tabs
          value={section}
          onChange={(_, v) => setSection(v)}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          aria-label="Business & Localization sections"
          sx={{
            px: 1,
            '& .MuiTabs-indicator': { bgcolor: GREEN, height: 3 },
            '& .MuiTab-root': { minHeight: 52, fontWeight: 700, textTransform: 'none' },
            '& .MuiTab-root.Mui-selected': { color: GREEN },
          }}
        >
          {SECTIONS.map((s) => (
            <Tab
              key={s.id}
              value={s.id}
              icon={s.icon}
              iconPosition="start"
              label={(
                <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  {s.label}
                  {dirtySections.has(s.id) && (
                    <Box component="span" aria-label="unsaved changes" title="Unsaved changes"
                      sx={{ width: 7, height: 7, borderRadius: '50%', bgcolor: 'warning.main' }} />
                  )}
                </Box>
              )}
            />
          ))}
        </Tabs>
      </Card>

      {dirty && FORM_SECTIONS.has(section) && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}
          action={<Button color="inherit" size="small" onClick={discard} disabled={saving}>Discard</Button>}>
          {dirtyKeys.size} unsaved change{dirtyKeys.size === 1 ? '' : 's'} — use Save Changes to apply them.
        </Alert>
      )}
      {dirty && !FORM_SECTIONS.has(section) && (
        <Alert severity="warning" sx={{ mb: 2, borderRadius: 2 }}>
          You have unsaved changes in {[...dirtySections].map((id) => SECTIONS.find((s) => s.id === id)?.label).join(', ')} — Save Changes applies them.
        </Alert>
      )}

      {!form || !catalog ? (
        <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' } }}>
          <Skeleton variant="rounded" height={520} />
          <Skeleton variant="rounded" height={520} />
        </Box>
      ) : (
        <>
          {section === 'general' && (
            <GeneralTab form={form} set={set} setMany={setMany} errors={errors} catalog={catalog}
              dirtyKeys={dirtyKeys} onNavigate={setSection} />
          )}
          {section === 'currency' && (
            <CurrencyLanguageTab form={form} set={set} setMany={setMany} errors={errors} catalog={catalog} dirtyKeys={dirtyKeys} />
          )}
          {section === 'tax' && <TaxConfigTab />}
          {section === 'numbering' && <NumberingTab prefs={saved} onNavigate={setSection} />}
          {section === 'other' && <OtherSettingsTab form={form} set={set} errors={errors} savedAt={savedAt} />}
          {section === 'fields' && <CustomFieldsTab />}
        </>
      )}
    </Box>
  );
});

export default BusinessLocalizationSettings;
