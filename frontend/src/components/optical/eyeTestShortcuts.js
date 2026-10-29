// Keyboard shortcut map for the Eye Test (Optical Services) screen.
//
// EYE_TEST_SHORTCUTS drives both the window listener (useEyeTestShortcuts) and the Ctrl+/ help
// dialog, so the two can't drift. Same safety rules as the Wholesale POS (see posShortcuts.js):
// nothing fires while a dialog / dropdown is open, auto-repeat never re-fires, and F-keys /
// Ctrl / Alt chords work even while the cursor is in a field.
//
// Section keys jump to the first field of that section; fields are found by `data-et-field`
// (see focusEyeTestField), so no ref per input is needed. Section keys only apply to the
// single-screen form; Alt+N / Alt+P only to the 10-step wizard.

import { makeShortcutHook } from '../../pages/wholesale/posShortcuts';
import { focusField } from '../../pages/wholesale/keyboardNav';

export const EYE_TEST_LENS_OPTIONS = ['SV', 'BF', 'PAL', 'HMC', 'BC', 'PG'];

export const EYE_TEST_SHORTCUTS = [
  // 1. Patient details
  { id: 'patientName', keys: ['F1'], group: '1. Patient Details', label: 'Go to Patient Name' },
  { id: 'newPatient', keys: ['F2'], group: '1. Patient Details', label: 'New Patient — clear the form for a new examination' },
  { id: 'searchPatient', keys: ['F3', 'Alt+F'], group: '1. Patient Details', label: 'Smart Patient Search' },
  { id: 'mobile', keys: ['Alt+M'], group: '1. Patient Details', label: 'Go to Mobile No' },
  { id: 'medicalAid', keys: ['Alt+A'], group: '1. Patient Details', label: 'Go to Medical Aid Name' },
  { id: 'testDate', keys: ['Alt+T'], group: '1. Patient Details', label: 'Go to Date / Test Type' },
  { id: 'optometrist', keys: ['Alt+D'], group: '1. Patient Details', label: 'Go to Optometrist (Space opens the list)' },
  { id: 'savePatient', keys: ['Alt+S'], group: '1. Patient Details', label: 'Save patient details' },
  // 2. Clinical refraction & measurement grid
  { id: 'ucva', keys: ['F4'], group: '2. Clinical Refraction Grid', label: 'Go to UCVA (Distance/Near) — OD' },
  { id: 'phva', keys: ['F5'], group: '2. Clinical Refraction Grid', label: 'Go to PHVA (Pinhole) — OD' },
  { id: 'ar', keys: ['F6'], group: '2. Clinical Refraction Grid', label: 'Go to AR (Auto Refractor) — OD SPH' },
  { id: 'streak', keys: ['F7'], group: '2. Clinical Refraction Grid', label: 'Go to STREAK / Retinoscopy — OD SPH' },
  { id: 'iop', keys: ['F8'], group: '2. Clinical Refraction Grid', label: 'Go to IOP (Tonometry) — IOP OD' },
  { id: 'lens', keys: ['Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6'], group: '2. Clinical Refraction Grid', label: 'Tick / untick lens option SV, BF, PAL, HMC, BC, PG' },
  // 3. PGP / ACCP
  { id: 'pgp', keys: ['F9'], group: '3. PGP & ACCP', label: 'Go to PGP (Previous Glasses Power) — OD DV SPH' },
  { id: 'accp', keys: ['F10'], group: '3. PGP & ACCP', label: 'Go to ACCP (Final Rx) — OD DV SPH' },
  // 4. Clinical observations
  { id: 'observations', keys: ['Alt+O'], group: '4. Observations & Advice', label: 'Go to C/O (Chief Complaints)' },
  { id: 'diagnosis', keys: ['Alt+G'], group: '4. Observations & Advice', label: 'Go to Doctor / Primary Diagnosis' },
  { id: 'nextVisit', keys: ['Alt+V'], group: '4. Observations & Advice', label: 'Go to Next Visit' },
  // 5. Charges & actions
  { id: 'charges', keys: ['Alt+C'], group: '5. Charges & Actions', label: 'Go to Test Type (Free / Paid — charges are entered on the payment screen at Save)' },
  { id: 'orthoptics', keys: ['Alt+B'], group: '5. Charges & Actions', label: 'Open Orthoptics (Binocular Vision) Form' },
  { id: 'rxPrint', keys: ['Ctrl+P'], group: '5. Charges & Actions', label: 'Rx Print preview' },
  { id: 'saveRecord', keys: ['Ctrl+S'], group: '5. Charges & Actions', label: 'Save Clinical Record' },
  // 6. Directory
  { id: 'directory', keys: ['Alt+R'], group: '6. Examination Directory', label: 'Go to Recent Examination Directory search' },
  // Page
  { id: 'historyQueue', keys: ['Alt+Q'], group: 'Page', label: 'Past Visit History Queue / back to the active exam' },
  { id: 'layout', keys: ['Alt+W'], group: 'Page', label: 'Switch between Single-Screen and 10-Step Wizard' },
  { id: 'stepNext', keys: ['Alt+N'], group: 'Page', label: 'Wizard: next examination step' },
  { id: 'stepPrev', keys: ['Alt+P'], group: 'Page', label: 'Wizard: previous examination step' },
  { id: 'help', keys: ['Ctrl+/'], group: 'Page', label: 'Open this shortcut help' },
  { id: 'enter', keys: ['Enter', '↑', '↓', '←', '→'], group: 'Page', global: false, label: 'Next / previous field (Enter), move around the grids with the arrows' },
];

export const useEyeTestShortcuts = makeShortcutHook(EYE_TEST_SHORTCUTS, [
  'Ctrl+P', 'Ctrl+S', 'Ctrl+/', 'Alt+F', 'Alt+M', 'Alt+A', 'Alt+T', 'Alt+D', 'Alt+S', 'Alt+O', 'Alt+G', 'Alt+V',
  'Alt+C', 'Alt+B', 'Alt+R', 'Alt+Q', 'Alt+W', 'Alt+N', 'Alt+P',
  'Alt+1', 'Alt+2', 'Alt+3', 'Alt+4', 'Alt+5', 'Alt+6',
], { pageWide: true }); // the eye test is the whole page: F1 etc. must never reach the browser

// `data-et-field` may sit on the input itself or on a wrapper (MUI Select / date picker /
// Autocomplete render their own inputs), so look inside it for the real focus target.
const FOCUSABLE = 'input:not([type="hidden"]):not([aria-hidden="true"]), textarea:not([aria-hidden="true"]), [role="combobox"], [role="button"], button';

export const focusEyeTestField = (key) => {
  const host = document.querySelector(`[data-et-field="${key}"]`);
  if (!host) return false;
  const el = host.matches(FOCUSABLE) ? host : host.querySelector(FOCUSABLE);
  if (!el || el.disabled) return false;
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  return focusField(el);
};
