// Store & Clinic Profile — the one store identity every module prints.
//
// The backend (/api/company/store-profile/) is the source of truth. A copy of the identity is
// cached in localStorage under the legacy `optical_app_settings` keys (storeName, storePhone,
// gstin, …) so offline screens and older synchronous readers (label printing, purchase GST
// state detection) keep working without their own fetch.
import { useEffect, useState } from 'react';
import axios from 'axios';

const URL = '/api/company/store-profile/';
const LOCAL_KEY = 'optical_app_settings';
export const STORE_PROFILE_EVENT = 'store_profile_updated';

export const STORE_TYPES = [
  { value: 'OPTICAL_STORE', label: 'Optical Store' },
  { value: 'EYE_CLINIC', label: 'Eye Clinic' },
  { value: 'OPTICAL_AND_CLINIC', label: 'Optical Store & Eye Clinic' },
];
export const storeTypeLabel = (v) => STORE_TYPES.find((t) => t.value === v)?.label || '';

export const WEEKDAYS = [
  ['MON', 'Mon'], ['TUE', 'Tue'], ['WED', 'Wed'], ['THU', 'Thu'], ['FRI', 'Fri'], ['SAT', 'Sat'], ['SUN', 'Sun'],
];

// GST state codes (first two digits of a GSTIN) → state / UT.
export const INDIAN_STATES = [
  ['01', 'Jammu and Kashmir'], ['02', 'Himachal Pradesh'], ['03', 'Punjab'], ['04', 'Chandigarh'],
  ['05', 'Uttarakhand'], ['06', 'Haryana'], ['07', 'Delhi'], ['08', 'Rajasthan'], ['09', 'Uttar Pradesh'],
  ['10', 'Bihar'], ['11', 'Sikkim'], ['12', 'Arunachal Pradesh'], ['13', 'Nagaland'], ['14', 'Manipur'],
  ['15', 'Mizoram'], ['16', 'Tripura'], ['17', 'Meghalaya'], ['18', 'Assam'], ['19', 'West Bengal'],
  ['20', 'Jharkhand'], ['21', 'Odisha'], ['22', 'Chhattisgarh'], ['23', 'Madhya Pradesh'], ['24', 'Gujarat'],
  ['26', 'Dadra and Nagar Haveli and Daman and Diu'], ['27', 'Maharashtra'], ['29', 'Karnataka'],
  ['30', 'Goa'], ['31', 'Lakshadweep'], ['32', 'Kerala'], ['33', 'Tamil Nadu'], ['34', 'Puducherry'],
  ['35', 'Andaman and Nicobar Islands'], ['36', 'Telangana'], ['37', 'Andhra Pradesh'], ['38', 'Ladakh'],
];
export const stateForGstin = (gstin) => {
  const code = String(gstin || '').slice(0, 2);
  return INDIAN_STATES.find(([c]) => c === code)?.[1] || '';
};

export const COUNTRIES = [
  'India', 'Bangladesh', 'Bhutan', 'Nepal', 'Sri Lanka', 'Maldives', 'United Arab Emirates', 'Saudi Arabia',
  'Qatar', 'Oman', 'Kuwait', 'Bahrain', 'Singapore', 'Malaysia', 'United Kingdom', 'United States',
  'Canada', 'Australia',
];
export const isIndia = (country) => ['', 'india', 'in', 'bharat'].includes(String(country || '').trim().toLowerCase());

export const ADDRESS_KINDS = [
  ['registered', 'Registered office address'],
  ['billing', 'Billing address (printed on invoices)'],
  ['shipping', 'Shipping / delivery address'],
];

const emptyAddress = () => ({ same_as_store: true, street: '', city: '', state: '', pin_code: '', country: '' });

/** A complete, normalised form value from a server payload (or blanks). */
export function profileToForm(p = {}) {
  const extra = p.extra_addresses || {};
  return {
    name: p.name || '',
    display_name: p.display_name || '',
    store_type: p.store_type || '',
    gstin: p.gstin || '',
    business_reg_no: p.business_reg_no || '',
    phone: p.phone || '',
    whatsapp: p.whatsapp || '',
    email: p.email || '',
    website: p.website || '',
    tagline: p.tagline || '',
    logo_data_url: p.logo_data_url || '',
    address: p.address || '',
    city: p.city || '',
    state: p.state || '',
    pin_code: p.pin_code || '',
    country: p.country ?? 'India',
    extra_addresses: Object.fromEntries(ADDRESS_KINDS.map(([k]) => [k, { ...emptyAddress(), ...(extra[k] || {}) }])),
    branch_code: p.branch_code || '',
    contact_person: p.contact_person || '',
    clinical_reg_no: p.clinical_reg_no || '',
    opening_time: p.opening_time || '',
    closing_time: p.closing_time || '',
    working_days: [...(p.working_days || [])],
    holidays: (p.holidays || []).map((h) => ({ date: h.date || '', name: h.name || '' })),
    provides_eye_exams: !!p.provides_eye_exams,
    clinic_settings: {
      exam_start: '', exam_end: '', slot_minutes: '', appointment_required: false,
      ...(p.clinic_settings || {}),
      slot_minutes: p.clinic_settings?.slot_minutes ?? '',
    },
  };
}

const joinAddress = (a) => [a.street ?? a.address, a.city, a.state, a.pin_code].map((x) => String(x || '').trim()).filter(Boolean).join(', ');

/** The store address printed on documents: the billing address when one is configured. */
export function documentAddress(p = {}) {
  const billing = p.extra_addresses?.billing;
  if (billing && billing.same_as_store === false && joinAddress(billing)) return joinAddress(billing);
  return joinAddress(p);
}

/** Profile (server payload or unsaved form) → the `company` shape the bill renderers use.
 *  Logo / tagline / website are branding values and travel via `brandingFromProfile`. */
export function companyFromProfile(p = {}) {
  return {
    name: (p.display_name || p.name || '').trim(),
    address: p.document_address || documentAddress(p),
    phone: p.phone || '',
    whatsapp: p.whatsapp || '',
    email: p.email || '',
    website: p.website || '',
    gstin: p.gstin || '',
    tagline: p.tagline || '',
    currency: p.currency || '',
  };
}

/** Billing-settings overlay so unsaved logo / tagline / website edits show in previews. */
export function brandingFromProfile(p = {}, branding = {}) {
  return {
    ...branding,
    logo_data_url: p.logo_data_url || '',
    business_info: { ...(branding.business_info || {}), tagline: p.tagline || '', website: p.website || '' },
  };
}

export function cacheProfileLocally(p) {
  if (!p || !p.exists) return;
  try {
    const prev = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
    localStorage.setItem(LOCAL_KEY, JSON.stringify({
      ...prev,
      storeName: p.name || '',
      displayName: p.display_name || '',
      storePhone: p.phone || '',
      storeEmail: p.email || '',
      website: p.website || '',
      tagline: p.tagline || '',
      address: p.address || '',
      city: p.city || '',
      state: p.state || '',
      pincode: p.pin_code || '',
      documentAddress: documentAddress(p),
      gstin: p.gstin || '',
      clinicalRegNo: p.clinical_reg_no || '',
      currency: p.currency || prev.currency || '₹',
    }));
  } catch { /* storage unavailable */ }
}

/** Last profile cached in this browser (profile-shaped; `exists` false when nothing cached). */
export function readCachedProfile() {
  try {
    const s = JSON.parse(localStorage.getItem(LOCAL_KEY) || '{}');
    return {
      exists: !!s.storeName,
      name: s.storeName || '',
      display_name: s.displayName || '',
      phone: s.storePhone || '',
      email: s.storeEmail || '',
      website: s.website || '',
      tagline: s.tagline || '',
      address: s.address || '',
      city: s.city || '',
      state: s.state || '',
      pin_code: s.pincode || '',
      document_address: s.documentAddress || '',
      gstin: s.gstin || '',
      clinical_reg_no: s.clinicalRegNo || '',
      currency: s.currency || '',
    };
  } catch {
    return { exists: false };
  }
}

/** The store profile for display: the cached copy immediately, then the server's. */
export function useStoreProfile() {
  const [profile, setProfile] = useState(readCachedProfile);
  useEffect(() => {
    let alive = true;
    fetchStoreProfile().then((d) => { if (alive && d) setProfile(d); }).catch(() => {});
    const onSaved = (e) => { if (e.detail) setProfile(e.detail); };
    window.addEventListener(STORE_PROFILE_EVENT, onSaved);
    return () => { alive = false; window.removeEventListener(STORE_PROFILE_EVENT, onSaved); };
  }, []);
  return profile;
}

export async function fetchStoreProfile({ completeness = false } = {}) {
  const { data } = await axios.get(URL, { params: completeness ? { include: 'completeness' } : undefined });
  cacheProfileLocally(data);
  return data;
}

function announce(data) {
  cacheProfileLocally(data);
  try { window.dispatchEvent(new CustomEvent(STORE_PROFILE_EVENT, { detail: data })); } catch { /* ignore */ }
  return data;
}

export async function saveStoreProfile(form) {
  const payload = {
    ...form,
    clinic_settings: {
      ...form.clinic_settings,
      slot_minutes: form.clinic_settings.slot_minutes === '' ? null : form.clinic_settings.slot_minutes,
    },
    holidays: form.holidays.filter((h) => h.date || h.name),
  };
  const { data } = await axios.put(URL, payload);
  return announce(data);
}

export async function patchStoreProfile(patch) {
  const { data } = await axios.patch(URL, patch);
  return announce(data);
}

// ---- client-side validation (mirrors apps/company/store_profile.py) -------------------------
const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const WEB_RE = /^(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;

function phoneError(v, required) {
  const raw = String(v || '').trim();
  if (!raw) return required ? 'Phone number is required.' : '';
  if (/[^0-9+()\-.\s]/.test(raw) || (raw.match(/\+/g) || []).length > 1 || (raw.includes('+') && !raw.startsWith('+'))) {
    return 'Use digits only, optionally starting with +country code.';
  }
  const n = raw.replace(/\D/g, '').length;
  return n >= 7 && n <= 15 ? '' : 'Enter a valid phone number (7–15 digits).';
}

/** Indian numbers → "+91 98765 43210" (same rule the server applies). */
export function formatPhone(v, country) {
  const raw = String(v || '').trim();
  if (!raw || !isIndia(country) || phoneError(raw, false)) return raw;
  let d = raw.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) d = d.slice(2);
  else if (d.length === 11 && d.startsWith('0')) d = d.slice(1);
  return d.length === 10 ? `+91 ${d.slice(0, 5)} ${d.slice(5)}` : raw;
}

function pinError(v, country) {
  const p = String(v || '').replace(/\s/g, '');
  if (!p) return '';
  if (isIndia(country)) return /^[1-9][0-9]{5}$/.test(p) ? '' : 'Indian PIN codes are 6 digits and do not start with 0.';
  return /^[A-Za-z0-9-]{3,10}$/.test(p) ? '' : 'Enter a valid postal code.';
}

export function validateProfile(f) {
  const e = {};
  if (!f.name.trim()) e.name = 'Store / Clinic name is required.';
  const gstin = f.gstin.replace(/\s/g, '').toUpperCase();
  if (gstin && !GSTIN_RE.test(gstin)) e.gstin = 'GSTIN must be 15 characters, e.g. 32ABCDE1234F1Z5.';
  const pe = phoneError(f.phone, true);
  if (pe) e.phone = pe;
  const we = phoneError(f.whatsapp, false);
  if (we) e.whatsapp = we;
  if (f.email.trim() && !EMAIL_RE.test(f.email.trim())) e.email = 'Enter a valid email address.';
  if (f.website.trim() && !WEB_RE.test(f.website.trim())) e.website = 'Enter a valid website, e.g. www.yourstore.com.';
  if (f.tagline.length > 120) e.tagline = 'Keep the tagline under 120 characters.';
  const pin = pinError(f.pin_code, f.country);
  if (pin) e.pin_code = pin;
  ADDRESS_KINDS.forEach(([k]) => {
    const a = f.extra_addresses[k];
    const err = !a.same_as_store && pinError(a.pin_code, a.country || f.country);
    if (err) e[`extra_addresses.${k}.pin_code`] = err;
  });
  if (f.branch_code && !/^[A-Za-z0-9_-]{1,20}$/.test(f.branch_code.trim())) e.branch_code = 'Use up to 20 letters, digits, - or _.';
  if (f.opening_time && f.closing_time && f.closing_time <= f.opening_time) e.closing_time = 'Closing time must be after opening time.';
  const cs = f.clinic_settings;
  if (cs.exam_start && cs.exam_end && cs.exam_end <= cs.exam_start) e['clinic_settings.exam_end'] = 'Exam hours must end after they start.';
  if (cs.slot_minutes !== '' && cs.slot_minutes !== null) {
    const n = Number(cs.slot_minutes);
    if (!Number.isInteger(n) || n < 5 || n > 240) e['clinic_settings.slot_minutes'] = 'Slot length must be 5–240 minutes.';
  }
  f.holidays.forEach((h, i) => { if (h.name && !h.date) e[`holidays.${i}.date`] = 'Pick a date.'; });
  return e;
}
