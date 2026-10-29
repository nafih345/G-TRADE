import React, { useState, useMemo, useEffect, useRef } from 'react';
import { 
  Box, Card, CardContent, Typography, Grid, TextField, 
  MenuItem, Button, Checkbox, FormControlLabel, Paper, 
  Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Stack, Divider, InputAdornment, Tooltip, Chip,
  Dialog, DialogTitle, DialogContent, DialogActions,
  IconButton, Menu, ListItemIcon, ListItemText, Autocomplete,
  ToggleButton, ToggleButtonGroup, Switch, Alert
} from '@mui/material';
import { 
  Search as SearchIcon, 
  Print as PrintIcon, 
  Save as SaveIcon, 
  Visibility as EyeIcon,
  MedicalServices as MedicalIcon,
  Refresh as ClearIcon,
  Person as PersonIcon,
  Assignment as ExamIcon,
  Biotech as MeasurementIcon,
  CheckCircle as ActiveIcon,
  Close as CloseIcon,
  Edit as EditIcon,
  PersonAdd as PersonAddIcon
} from '@mui/icons-material';
import OrthopticsModal from './OrthopticsModal';
import PrintPrescriptionCard from './PrintPrescriptionCard';
import QuickDatePickerField from '../common/QuickDatePickerField';
import {
  EYE_TEST_PAY_MODES, FEE_STATUS_LABELS, PAYMENT_CHOICES, PAY_NOW, NO_PAYMENT, PAY_AFTER_SALE,
  applyPaymentChoice, billRecordFromExam, eyeTestFeeTotal, paymentChoiceOf, payModeLabel,
} from '../../utils/eyeTestBill';
import { printEyeTestBill, printEyeTestReceipt } from '../../utils/printEyeTestBill';

// Common medical aid / insurance schemes offered as quick picks on the charges bar. The field
// is free-solo, so staff can still type any scheme not listed here.
const MEDICAL_AID_OPTIONS = [
  'Self-Pay / Cash',
  'BOMAID',
  'PULA Medical Aid Fund',
  'Botsogo Health Plan',
  'BPOMAS',
  'Pres Care Medical Aid',
  'Medscheme',
  'Discovery Health',
  'Star Health',
  'Other / Private',
];

export default function SingleScreenEyeTestForm({
  patientData = {}, setPatientData,
  medicalHistory = {}, setMedicalHistory,
  visualAcuity = { distance: {}, near: {} }, setVisualAcuity,
  objectiveRefraction = { autoRefraction: { od: {}, os: {} }, retinoscopy: { od: {}, os: {} } }, setObjectiveRefraction,
  subjectiveRefraction = { od: {}, os: {} }, setSubjectiveRefraction,
  binocularVision = {}, setBinocularVision,
  eyeHealth = { iop: {}, anterior: {}, posterior: {}, cupDiscRatio: {} }, setEyeHealth,
  diagnosis = {}, setDiagnosis,
  prescription = { selectedLenses: [] }, setPrescription,
  doctorsList = [],
  onOpenSearchModal,
  onSaveDraft,
  onSavePatient,
  onPrint,
  onClearAll,
  testNo = '',
  testDate = '',
  nextVisitDate = '',
  setNextVisitDate,
  savedExams = [],
  onSelectExamFromHistory,
  nextPatientId = '',
  // Once a clinical record has been saved, its patient/test-detail fields go read-only —
  // re-editing on top of an already-saved record without an explicit action was how a single
  // visit ended up silently mutated after the fact. Reactivated by "New Patient" (fresh visit,
  // see onClearAll) or by clicking the history table's Edit icon (see onSelectExamFromHistory),
  // both of which clear this from the parent.
  isLocked = false,
  // Runs the parent's save checks (patient name, some test detail) before the payment screen
  // opens, so nobody fills in a payment for a record that then can't be saved.
  onValidateSave,
  // "Pay After Sale": opens New Sale for this visit (Test No), where the pending fee is added.
  onGoToSales
}) {

  // Handlers for state updates
  const handleSubjectiveEye = (eye, field, val) => {
    setSubjectiveRefraction(prev => ({
      ...prev,
      [eye]: { ...(prev[eye] || {}), [field]: val }
    }));
  };

  const handleObjectiveAutoRef = (eye, field, val) => {
    setObjectiveRefraction(prev => ({
      ...prev,
      autoRefraction: {
        ...(prev.autoRefraction || {}),
        [eye]: { ...(prev.autoRefraction?.[eye] || {}), [field]: val }
      }
    }));
  };

  const handleRetinoscopy = (eye, field, val) => {
    setObjectiveRefraction(prev => ({
      ...prev,
      retinoscopy: {
        ...(prev.retinoscopy || {}),
        [eye]: { ...(prev.retinoscopy?.[eye] || {}), [field]: val }
      }
    }));
  };

  const handleVisualAcuity = (type, field, val) => {
    setVisualAcuity(prev => ({
      ...prev,
      [type]: {
        ...(prev[type] || {}),
        [field]: val
      }
    }));
  };

  const handleLensOptionToggle = (lens) => {
    setPrescription(prev => {
      const current = prev.selectedLenses || [];
      const updated = current.includes(lens) 
        ? current.filter(l => l !== lens) 
        : [...current, lens];
      return { ...prev, selectedLenses: updated };
    });
  };

  // Modal states for Orthoptics and Print Rx
  const [orthopticsOpen, setOrthopticsOpen] = useState(false);
  const [printModalOpen, setPrintModalOpen] = useState(false);

  // Prints the Clinical Record & Invoice for a saved visit: patient details, the prescription,
  // the optometrist, the itemised charges (Medical Aid Charge = the medical aid's cover, shown as
  // a deduction) and how it was settled — paid (Cash / GPay), free, or pending with the
  // frame/lens purchase.
  const handlePrintInvoice = (row, paperSize = 'A4') => {
    printEyeTestBill(billRecordFromExam(row), { paperSize });
  };

  // Anchors the A4/A5 choice menu for the invoice print icon to whichever row's button was clicked
  const [invoicePrintMenu, setInvoicePrintMenu] = useState({ anchorEl: null, row: null });

  // Bottom Table Filter States
  const [historySearch, setHistorySearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Payment Details screen: charges on top, then Pay Now (Cash / GPay) | No Payment |
  // Pay After Sale (the fee waits for this patient's New Sale bill). It opens right after the
  // Patient Details "Save" (paymentOpen = 'patient': confirming carries on to the refraction
  // grid), and again from "Save Clinical Record" if it was never confirmed ('record':
  // confirming saves). Once confirmed, Save Clinical Record saves straight away and brings up
  // the print options; Done there brings the directory below into view with the new visit on top.
  const paymentChoice = paymentChoiceOf(diagnosis);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentPrintMenu, setPaymentPrintMenu] = useState(null);
  const [printOptionsOpen, setPrintOptionsOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const directoryRef = useRef(null);
  const directoryTableRef = useRef(null);
  const focusRefractionGrid = () => setTimeout(() => {
    const el = document.querySelector('[data-et-field="ucva"]');
    if (el) { el.focus(); if (el.select) el.select(); }
  }, 50);
  const saveRecord = async () => {
    if (saving) return;
    setSaving(true);
    let saved = false;
    try { saved = await onSaveDraft?.(); } finally { setSaving(false); }
    if (!saved) return;
    setPaymentOpen(false);
    setPrintOptionsOpen(true);
  };
  const openPayment = (mode) => {
    // Show the choice the screen implies as the selected one, so confirming keeps it.
    setDiagnosis(prev => ({ ...prev, ...applyPaymentChoice(paymentChoiceOf(prev)) }));
    setPaymentOpen(mode);
  };
  const handlePatientSaveClick = async () => {
    const saved = await onSavePatient?.();
    if (saved) openPayment('patient');
  };
  const handlePaymentConfirm = () => {
    setDiagnosis(prev => ({ ...prev, paymentConfirmed: true }));
    if (paymentOpen === 'record') { saveRecord(); return; }
    setPaymentOpen(false);
    focusRefractionGrid();
  };
  const handleSaveClick = () => {
    if (onValidateSave && !onValidateSave()) return;
    if (diagnosis?.paymentConfirmed) saveRecord();
    else openPayment('record');
  };
  const handlePrintOptionsDone = () => {
    setPrintOptionsOpen(false);
    // A leftover search could hide the row just saved — clear it so the new visit shows.
    setHistorySearch('');
    setTimeout(() => {
      directoryRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (directoryTableRef.current) directoryTableRef.current.scrollTop = 0;
    }, 50);
  };
  // The visit on screen, in the directory-row shape billRecordFromExam reads. After a save the
  // parent has already stamped the real Test No / Patient ID onto these props.
  const currentVisit = () => ({
    testNo: autoTestNo, date: autoDate, patientId: autoPatientId,
    patientData, diagnosisData: diagnosis, subjectiveRefraction,
    medicalAidName: patientData?.medicalAidName,
  });

  // Auto-generate Date and Patient ID (Null-Safe). Test No is intentionally left blank until
  // a real one exists — either an existing exam was selected from history, or one was just
  // assigned by the backend on save — instead of showing a guessed placeholder up front.
  const safeExams = Array.isArray(savedExams) ? savedExams : [];
  const autoTestNo = testNo || diagnosis?.testNo || '';
  const autoDate = testDate || new Date().toISOString().split('T')[0];
  const autoPatientId = patientData?.id || nextPatientId || `P-${1001 + safeExams.length}`;

  // Applied to every input-bearing section once isLocked is true: visually dims the fields and
  // blocks interaction (pointerEvents) without having to thread a `disabled` prop through every
  // TextField in these sections individually.
  const lockSx = isLocked ? { pointerEvents: 'none', opacity: 0.55, filter: 'grayscale(15%)' } : {};

  // Customer Paid Amount defaults to the balance the patient owes after the
  // medical aid deduction: Procedure + Medicine − Medical Aid Charge (e.g. 250 + 0 − 100
  // = 150). It stays in sync as those two charges change until the user types
  // their own value in the field, which sets customerPaidTouched and stops the
  // auto-fill. A cleared form (all charge fields blank) drops the override again
  // so the next visit auto-calculates from scratch.
  const [customerPaidTouched, setCustomerPaidTouched] = useState(false);
  const lastAutoPaidRef = useRef(null);

  // (Now that Medicine Charge sits on the payment screen with the others, it is part of what
  // the patient pays here too — the same total the printed invoice shows.)
  const autoCustomerBalance = useMemo(
    () => eyeTestFeeTotal(diagnosis),
    [diagnosis?.procedureCharge, diagnosis?.medicalAidCharge, diagnosis?.medicineCharge]
  );

  useEffect(() => {
    if (isLocked || customerPaidTouched) return;
    const current = String(diagnosis?.customerPaidAmount ?? '');
    // Leave an existing value alone unless it's blank, "0", or a figure this
    // effect itself last wrote — so a saved partial payment loaded via Edit
    // isn't clobbered by the auto-calc.
    const autoOwned = current === '' || current === '0' || current === lastAutoPaidRef.current;
    if (!autoOwned) return;
    const next = String(autoCustomerBalance);
    lastAutoPaidRef.current = next;
    if (current !== next) setDiagnosis(prev => ({ ...prev, customerPaidAmount: next }));
  }, [autoCustomerBalance, isLocked, customerPaidTouched, diagnosis?.customerPaidAmount, setDiagnosis]);

  useEffect(() => {
    const empty = !diagnosis?.procedureCharge && !diagnosis?.medicineCharge &&
      !diagnosis?.medicalAidCharge && !diagnosis?.customerPaidAmount;
    if (empty) {
      lastAutoPaidRef.current = null;
      if (customerPaidTouched) setCustomerPaidTouched(false);
    }
  }, [diagnosis?.procedureCharge, diagnosis?.medicineCharge, diagnosis?.medicalAidCharge,
      diagnosis?.customerPaidAmount, customerPaidTouched]);

  // Collapse repeats of the same visit before rendering. The directory is fed a merge of the
  // localStorage cache and the backend rows, so one exam can arrive two or three times (a
  // cached copy saved before it synced + the authoritative backend row). Identity: the backend
  // row UUID if present, else Patient ID + Test No (fixed for the life of a visit).
  const dedupeVisits = (rows) => {
    const seen = new Map();
    for (const r of rows) {
      const key = r.backendId
        ? `b:${r.backendId}`
        : `v:${(r.patientId || r.patientData?.id || '').toString().trim()}|${(r.testNo || r.test_no || r.diagnosisData?.testNo || '').toString().trim()}`;
      const dupKeyable = key !== 'v:|';
      const prev = seen.get(key);
      // Keep the richer copy: a backend-backed row over a local-only one, otherwise the first seen.
      if (!dupKeyable) { seen.set(`${key}:${seen.size}`, r); continue; }
      if (!prev) seen.set(key, r);
      else if (!prev.backendId && r.backendId) seen.set(key, r);
    }
    return Array.from(seen.values());
  };

  const filteredHistory = dedupeVisits(safeExams.filter(e => {
    if (!e || e.name === 'Mohammed' || e.patientId === 'P-7375') return false;
    const q = (historySearch || '').toLowerCase();
    if (!q) return true;
    return (e.name || '').toLowerCase().includes(q) ||
      (e.phone || '').includes(q) ||
      (e.patientId || '').toLowerCase().includes(q) ||
      String(e.testNo || '').toLowerCase().includes(q) ||
      (e.gender || '').toLowerCase().includes(q) ||
      (e.assignedOptometrist || e.optometrist || e.doctor || '').toLowerCase().includes(q);
  }));

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      {/* 📌 SECTION 1: Patient & Examination Registration Bar */}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1', boxShadow: '0 2px 10px rgba(0,0,0,0.02)' }}>
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PersonIcon fontSize="small" /> 1. Patient Details & Examination Info
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            {isLocked && (
              <Chip
                size="small"
                color="success"
                label="Saved — locked. Use Edit (in the table below) or New Patient to change."
                sx={{ fontWeight: 700 }}
              />
            )}
            <Tooltip title="Clear this form and start registering a new patient">
              <Button
                variant="outlined" color="primary" size="small" startIcon={<PersonAddIcon fontSize="small" />}
                onClick={onClearAll}
                sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 2 }}
              >
                New Patient
              </Button>
            </Tooltip>
          </Box>
        </Box>

        {/* All rows share the exact same 7-column grid track definition, so items in later rows
            that span multiple tracks line up pixel-perfectly under Row 1's columns — a plain
            MUI Grid can't guarantee this since flexbox gap distribution differs when the two
            rows have a different number of items. Locked once isLocked (see lockSx) — only the
            header above (New Patient) and the history table's Edit icon stay clickable. */}
        <Box id="eyetest-patient-details" sx={lockSx}>
        {(() => {
          const colTemplate = { xs: '1fr 1fr', sm: 'repeat(4, 1fr)', md: '1.5fr 1.3fr 2.5fr 2fr 1.8fr 1.2fr 1fr' };
          return (
            <>
              {/* Row 1: Test No, Patient ID, Patient Name, Address, Place, Gender, Age */}
              <Box sx={{ display: 'grid', gridTemplateColumns: colTemplate, gap: 1.5, alignItems: 'center', mb: 1.5 }}>
                <Box sx={{ gridColumn: { md: '1 / 2' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Test No"
                    value={autoTestNo}
                    InputProps={{ readOnly: true }}
                    inputProps={{ style: { fontWeight: 800 } }}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '2 / 3' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Patient ID"
                    value={autoPatientId}
                    InputProps={{ readOnly: true }}
                    inputProps={{ style: { fontWeight: 800 } }}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '3 / 4' } }}>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <TextField
                      fullWidth
                      size="small"
                      label="Patient Name"
                      value={patientData.name || ''}
                      onChange={(e) => setPatientData(prev => ({ ...prev, name: e.target.value }))}
                      placeholder="Enter Patient Name"
                      inputProps={{ 'data-et-field': 'patientName' }}
                      sx={{ '& input': { fontWeight: 800, color: '#1e3a8a' } }}
                    />
                    {/* Out of the Tab order so Tab goes Patient Name → Address; Alt+F opens the same search. */}
                    <Tooltip title="Search Registered Patients (Alt+F)">
                      <Button variant="contained" color="primary" onClick={onOpenSearchModal} tabIndex={-1} sx={{ minWidth: 40, px: 1 }}>
                        <SearchIcon fontSize="small" />
                      </Button>
                    </Tooltip>
                  </Box>
                </Box>
                <Box sx={{ gridColumn: { md: '4 / 5' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Address"
                    placeholder="House / Street"
                    value={patientData.address || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, address: e.target.value }))}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '5 / 6' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Place"
                    placeholder="City / Place"
                    value={patientData.place || patientData.city || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, place: e.target.value, city: e.target.value }))}
                    sx={{ '& input': { fontWeight: 700 } }}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '6 / 7' } }}>
                  <TextField
                    fullWidth
                    select
                    size="small"
                    label="Gender"
                    value={patientData.gender || 'Male'}
                    onChange={(e) => setPatientData(prev => ({ ...prev, gender: e.target.value }))}
                  >
                    <MenuItem value="Male">MALE</MenuItem>
                    <MenuItem value="Female">FEMALE</MenuItem>
                    <MenuItem value="Other">OTHER</MenuItem>
                  </TextField>
                </Box>
                <Box sx={{ gridColumn: { md: '7 / 8' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Age"
                    value={patientData.age || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, age: e.target.value }))}
                  />
                </Box>
              </Box>

              {/* Row 2: Mobile No, Email, ID Type, ID Number, Medical Aid Name, Medical Aid Scheme,
                  Medical Aid Member Number — one field per Row 1 track, continuing the sequence
                  straight on from Age. */}
              <Box sx={{ display: 'grid', gridTemplateColumns: colTemplate, gap: 1.5, alignItems: 'center' }}>
                <Box sx={{ gridColumn: { md: '1 / 2' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Mobile No"
                    value={patientData.phone || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, phone: e.target.value }))}
                    inputProps={{ id: 'eyetest-mobile-input', 'data-et-field': 'mobile' }}
                    sx={{ '& input': { fontWeight: 700 } }}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '2 / 3' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Email"
                    placeholder="patient@example.com"
                    value={patientData.email || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, email: e.target.value }))}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '3 / 4' } }}>
                  <TextField
                    fullWidth
                    select
                    size="small"
                    label="ID Type"
                    value={patientData.idType || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, idType: e.target.value }))}
                  >
                    <MenuItem value="">-- Select ID Type --</MenuItem>
                    <MenuItem value="Passport">Passport</MenuItem>
                    <MenuItem value="Aadhaar">Aadhaar</MenuItem>
                    <MenuItem value="Omang">Omang</MenuItem>
                    <MenuItem value="National ID">National ID</MenuItem>
                    <MenuItem value="Driving License">Driving License</MenuItem>
                    <MenuItem value="Other">Other</MenuItem>
                  </TextField>
                </Box>
                <Box sx={{ gridColumn: { md: '4 / 5' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="ID Number"
                    value={patientData.idNumber || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, idNumber: e.target.value }))}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '5 / 6' } }} data-et-field="medicalAid">
                  {/* Medical Aid — pick a common scheme or type a custom one. Moved up from the
                      diagnosis section so the scheme is captured alongside the other patient
                      details; still bound to patientData.medicalAidName. */}
                  <Autocomplete
                    freeSolo
                    size="small"
                    options={MEDICAL_AID_OPTIONS}
                    value={patientData.medicalAidName || ''}
                    onChange={(e, val) => setPatientData(prev => ({ ...prev, medicalAidName: val || '' }))}
                    onInputChange={(e, val) => setPatientData(prev => ({ ...prev, medicalAidName: val || '' }))}
                    renderInput={(params) => (
                      <TextField
                        {...params}
                        fullWidth
                        label="Medical Aid Name"
                        placeholder="Scheme / insurer"
                      />
                    )}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '6 / 7' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Medical Aid Scheme"
                    value={patientData.medicalAidScheme || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, medicalAidScheme: e.target.value }))}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '7 / 8' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Medical Aid Member Number"
                    value={patientData.medicalAidMemberNumber || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, medicalAidMemberNumber: e.target.value }))}
                    inputProps={{ id: 'eyetest-medicalaid-membernumber-input' }}
                  />
                </Box>
              </Box>

              {/* Row 3: Date, Test Type, Optometrist — the examination details close the sequence —
                  then Save, directly under Medical Aid Member Number's column. Save is the last
                  Tab/Enter stop of this section (see handleKeyDownEnter in OpticalServices). */}
              <Box sx={{ display: 'grid', gridTemplateColumns: colTemplate, gap: 1.5, alignItems: 'center', mt: 1.5 }}>
                <Box sx={{ gridColumn: { md: '1 / 3' } }} data-et-field="testDate">
                  <QuickDatePickerField
                    label="Date"
                    value={autoDate}
                    onChange={(newDate) => setDiagnosis(prev => ({ ...prev, testDate: newDate }))}
                    quickPresets={[
                      { label: 'Today', type: 'today' },
                      { label: 'Yesterday', type: 'yesterday' },
                      { label: 'Tomorrow', type: 'tomorrow' }
                    ]}
                    skipAdornmentsInTabOrder
                  />
                </Box>
                {/* FREE EYE TEST skips the payment screen on save; every other type is billable. */}
                <Box sx={{ gridColumn: { md: '3 / 4' } }} data-et-field="charges">
                  <TextField
                    fullWidth
                    select
                    size="small"
                    label="Test Type"
                    value={diagnosis.testType || 'FREE EYE TEST'}
                    onChange={(e) => setDiagnosis(prev => ({ ...prev, testType: e.target.value }))}
                    sx={{ '& .MuiSelect-select': { fontWeight: 800 } }}
                  >
                    <MenuItem value="FREE EYE TEST">FREE EYE TEST</MenuItem>
                    <MenuItem value="COMPREHENSIVE EYE TEST">COMPREHENSIVE EYE TEST</MenuItem>
                    <MenuItem value="CONTACT LENS EVALUATION">CONTACT LENS EVALUATION</MenuItem>
                    <MenuItem value="ROUTINE REFRACTION">ROUTINE REFRACTION</MenuItem>
                  </TextField>
                </Box>
                <Box sx={{ gridColumn: { md: '4 / 6' } }} data-et-field="optometrist">
                  <TextField
                    fullWidth
                    select
                    size="small"
                    label="Optometrist"
                    value={patientData.assignedOptometrist || ''}
                    onChange={(e) => setPatientData(prev => ({ ...prev, assignedOptometrist: e.target.value }))}
                  >
                    <MenuItem value="">-- Select Optometrist --</MenuItem>
                    {doctorsList.map((doc, i) => (
                      <MenuItem key={i} value={doc}>{doc}</MenuItem>
                    ))}
                  </TextField>
                </Box>
                <Box sx={{ gridColumn: { md: '7 / 8' } }}>
                  <Button
                    id="eyetest-save-patient-btn"
                    data-et-action="savePatient"
                    fullWidth
                    variant="contained" color="success" size="small" startIcon={<SaveIcon fontSize="small" />}
                    onClick={handlePatientSaveClick}
                    sx={{ textTransform: 'none', fontWeight: 800, borderRadius: 2, whiteSpace: 'nowrap', px: 2 }}
                  >
                    Save
                  </Button>
                </Box>
              </Box>
            </>
          );
        })()}
        </Box>

        {/* Payment summary for this visit, right under the examination info — set on the
            Payment Details screen that the Save button above opens. */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', mt: 1.5, pt: 1.5, borderTop: '1px dashed #cbd5e1' }}>
          <Typography variant="caption" fontWeight={800} color="text.secondary">PAYMENT</Typography>
          {!diagnosis?.paymentConfirmed ? (
            <Chip size="small" variant="outlined" label="Not set — opens when you click Save" sx={{ fontWeight: 700 }} />
          ) : paymentChoice === NO_PAYMENT ? (
            <Chip color="info" size="small" label="No Payment" sx={{ fontWeight: 800 }} />
          ) : paymentChoice === PAY_AFTER_SALE ? (
            <Chip color="warning" size="small" label={`Pay After Sale — ₹${autoCustomerBalance} pending eye test fee`} sx={{ fontWeight: 800 }} />
          ) : (
            <Chip color="success" size="small"
              label={`Pay Now — ₹${diagnosis?.customerPaidAmount ?? 0} of ₹${autoCustomerBalance} · ${payModeLabel(diagnosis?.paymentMode) || 'Cash'}`}
              sx={{ fontWeight: 800 }} />
          )}
          {!isLocked && (
            <Button size="small" startIcon={<EditIcon fontSize="small" />} onClick={() => openPayment('patient')} sx={{ textTransform: 'none', fontWeight: 700 }}>
              {diagnosis?.paymentConfirmed ? 'Change payment' : 'Payment details'}
            </Button>
          )}
        </Box>
      </Paper>

      {/* 👁️ SECTION 2: Objective & Clinical Measurements Grid */}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <MeasurementIcon fontSize="small" /> 2. Clinical Refraction & Measurement Grid
        </Typography>
        <Box sx={lockSx}>

        <Grid container spacing={1.5}>
          {/* Column 1: UCVA */}
          <Grid item xs={12} sm={6} md={2}>
            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 2, bgcolor: '#f8fafc', borderColor: '#e2e8f0' }}>
              <Typography variant="caption" fontWeight={900} color="primary" sx={{ display: 'block', mb: 1, textAlign: 'center', bgcolor: '#eff6ff', py: 0.5, borderRadius: 1 }}>
                UCVA (Distance/Near)
              </Typography>
              <Grid container spacing={1}>
                <Grid item xs={4} sx={{ display: 'flex', alignItems: 'center' }}>
                  <Typography variant="caption" fontWeight={800} color="primary.main">OD</Typography>
                </Grid>
                <Grid item xs={8}>
                  <TextField
                    fullWidth size="small" placeholder="VA"
                    inputProps={{ 'data-et-field': 'ucva' }}
                    value={visualAcuity?.distance?.odWo || ''}
                    onChange={(e) => handleVisualAcuity('distance', 'odWo', e.target.value)}
                  />
                </Grid>
                <Grid item xs={4} sx={{ display: 'flex', alignItems: 'center' }}>
                  <Typography variant="caption" fontWeight={800} color="#059669">OS</Typography>
                </Grid>
                <Grid item xs={8}>
                  <TextField
                    fullWidth size="small" placeholder="VA"
                    value={visualAcuity?.distance?.osWo || ''}
                    onChange={(e) => handleVisualAcuity('distance', 'osWo', e.target.value)}
                  />
                </Grid>
              </Grid>
            </Paper>
          </Grid>

          {/* Column 2: PHVA (Pinhole VA) */}
          <Grid item xs={12} sm={6} md={2}>
            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 2, bgcolor: '#f8fafc', borderColor: '#e2e8f0' }}>
              <Typography variant="caption" fontWeight={900} color="primary" sx={{ display: 'block', mb: 1, textAlign: 'center', bgcolor: '#eff6ff', py: 0.5, borderRadius: 1 }}>
                PHVA (Pinhole)
              </Typography>
              <Grid container spacing={1}>
                <Grid item xs={4} sx={{ display: 'flex', alignItems: 'center' }}>
                  <Typography variant="caption" fontWeight={800} color="primary.main">OD</Typography>
                </Grid>
                <Grid item xs={8}>
                  <TextField
                    fullWidth size="small" placeholder="Pinhole"
                    inputProps={{ 'data-et-field': 'phva' }}
                    value={visualAcuity?.distance?.odPinhole || ''}
                    onChange={(e) => handleVisualAcuity('distance', 'odPinhole', e.target.value)}
                  />
                </Grid>
                <Grid item xs={4} sx={{ display: 'flex', alignItems: 'center' }}>
                  <Typography variant="caption" fontWeight={800} color="#059669">OS</Typography>
                </Grid>
                <Grid item xs={8}>
                  <TextField
                    fullWidth size="small" placeholder="Pinhole"
                    value={visualAcuity?.distance?.osPinhole || ''}
                    onChange={(e) => handleVisualAcuity('distance', 'osPinhole', e.target.value)}
                  />
                </Grid>
              </Grid>
            </Paper>
          </Grid>

          {/* Column 3: AR (Auto Refraction) */}
          <Grid item xs={12} sm={6} md={2.5}>
            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 2, bgcolor: '#f8fafc', borderColor: '#e2e8f0' }}>
              <Typography variant="caption" fontWeight={900} color="primary" sx={{ display: 'block', mb: 1, textAlign: 'center', bgcolor: '#f1f5f9', py: 0.5, borderRadius: 1 }}>
                AR (Auto Refractor)
              </Typography>
              <Grid container spacing={0.8}>
                <Grid item xs={3}><Typography variant="caption" fontWeight={800}>EYE</Typography></Grid>
                <Grid item xs={3}><Typography variant="caption" fontWeight={800}>SPH</Typography></Grid>
                <Grid item xs={3}><Typography variant="caption" fontWeight={800}>CYL</Typography></Grid>
                <Grid item xs={3}><Typography variant="caption" fontWeight={800}>AXIS</Typography></Grid>

                {/* OD */}
                <Grid item xs={3} sx={{ display: 'flex', alignItems: 'center' }}><Typography variant="caption" fontWeight={800} color="primary.main">OD</Typography></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" inputProps={{ 'data-et-field': 'ar' }} value={objectiveRefraction?.autoRefraction?.od?.sph || ''} onChange={(e) => handleObjectiveAutoRef('od', 'sph', e.target.value)} /></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.autoRefraction?.od?.cyl || ''} onChange={(e) => handleObjectiveAutoRef('od', 'cyl', e.target.value)} /></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.autoRefraction?.od?.axis || ''} onChange={(e) => handleObjectiveAutoRef('od', 'axis', e.target.value)} /></Grid>

                {/* OS */}
                <Grid item xs={3} sx={{ display: 'flex', alignItems: 'center' }}><Typography variant="caption" fontWeight={800} color="#059669">OS</Typography></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.autoRefraction?.os?.sph || ''} onChange={(e) => handleObjectiveAutoRef('os', 'sph', e.target.value)} /></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.autoRefraction?.os?.cyl || ''} onChange={(e) => handleObjectiveAutoRef('os', 'cyl', e.target.value)} /></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.autoRefraction?.os?.axis || ''} onChange={(e) => handleObjectiveAutoRef('os', 'axis', e.target.value)} /></Grid>
              </Grid>
            </Paper>
          </Grid>

          {/* Column 4: STREAK / RETINOSCOPY */}
          <Grid item xs={12} sm={6} md={2.5}>
            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 2, bgcolor: '#f8fafc', borderColor: '#e2e8f0' }}>
              <Typography variant="caption" fontWeight={900} color="primary" sx={{ display: 'block', mb: 1, textAlign: 'center', bgcolor: '#f1f5f9', py: 0.5, borderRadius: 1 }}>
                STREAK / Retinoscopy
              </Typography>
              <Grid container spacing={0.8}>
                <Grid item xs={3}><Typography variant="caption" fontWeight={800}>EYE</Typography></Grid>
                <Grid item xs={3}><Typography variant="caption" fontWeight={800}>SPH</Typography></Grid>
                <Grid item xs={3}><Typography variant="caption" fontWeight={800}>CYL</Typography></Grid>
                <Grid item xs={3}><Typography variant="caption" fontWeight={800}>AXIS</Typography></Grid>

                {/* OD */}
                <Grid item xs={3} sx={{ display: 'flex', alignItems: 'center' }}><Typography variant="caption" fontWeight={800} color="primary.main">OD</Typography></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" inputProps={{ 'data-et-field': 'streak' }} value={objectiveRefraction?.retinoscopy?.od?.sph || ''} onChange={(e) => handleRetinoscopy('od', 'sph', e.target.value)} /></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.retinoscopy?.od?.cyl || ''} onChange={(e) => handleRetinoscopy('od', 'cyl', e.target.value)} /></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.retinoscopy?.od?.axis || ''} onChange={(e) => handleRetinoscopy('od', 'axis', e.target.value)} /></Grid>

                {/* OS */}
                <Grid item xs={3} sx={{ display: 'flex', alignItems: 'center' }}><Typography variant="caption" fontWeight={800} color="#059669">OS</Typography></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.retinoscopy?.os?.sph || ''} onChange={(e) => handleRetinoscopy('os', 'sph', e.target.value)} /></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.retinoscopy?.os?.cyl || ''} onChange={(e) => handleRetinoscopy('os', 'cyl', e.target.value)} /></Grid>
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.retinoscopy?.os?.axis || ''} onChange={(e) => handleRetinoscopy('os', 'axis', e.target.value)} /></Grid>
              </Grid>
            </Paper>
          </Grid>

          {/* Column 5: IOP & LENS OPTIONS */}
          <Grid item xs={12} sm={12} md={3}>
            <Paper variant="outlined" sx={{ p: 1.2, borderRadius: 2, bgcolor: '#fffbebfb', borderColor: '#fef08a' }}>
              <Typography variant="caption" fontWeight={900} color="primary" sx={{ display: 'block', mb: 1, textAlign: 'center', bgcolor: '#fef3c7', py: 0.5, borderRadius: 1, color: '#92400e' }}>
                IOP (Tonometry) & Lens Options
              </Typography>
              <Grid container spacing={1} sx={{ mb: 1 }}>
                <Grid item xs={6}>
                  <TextField 
                    fullWidth size="small" label="IOP OD" placeholder="mmHg" 
                    inputProps={{ 'data-et-field': 'iop' }}
                    value={eyeHealth?.iop?.od || ''} 
                    onChange={(e) => setEyeHealth(prev => ({ ...prev, iop: { ...(prev.iop || {}), od: e.target.value } }))} 
                  />
                </Grid>
                <Grid item xs={6}>
                  <TextField 
                    fullWidth size="small" label="IOP OS" placeholder="mmHg" 
                    value={eyeHealth?.iop?.os || ''} 
                    onChange={(e) => setEyeHealth(prev => ({ ...prev, iop: { ...(prev.iop || {}), os: e.target.value } }))} 
                  />
                </Grid>
              </Grid>

              {/* Checkboxes matching Image 3 (SV, BF, PAL, HMC, BC, PG) */}
              <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 0.2 }}>
                {['SV', 'BF', 'PAL', 'HMC', 'BC', 'PG'].map((lens) => (
                  <FormControlLabel
                    key={lens}
                    control={
                      <Checkbox
                        size="small"
                        checked={(prescription?.selectedLenses || []).includes(lens)}
                        onChange={() => handleLensOptionToggle(lens)}
                        inputProps={lens === 'PG' ? { id: 'eyetest-lens-last' } : undefined}
                        sx={{ py: 0.2 }}
                      />
                    }
                    label={<Typography variant="caption" fontWeight={700}>{lens}</Typography>}
                  />
                ))}
              </Box>
            </Paper>
          </Grid>
        </Grid>
        </Box>
      </Paper>

      {/* 👓 SECTION 3: Previous Glasses (PGP) vs Acceptance Refraction (ACCP) */}
      <Box sx={lockSx}>
      <Grid container spacing={2}>
        {/* Left: Previous Glasses Power (PGP) Card */}
        <Grid item xs={12} md={6}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1', height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
              <Typography variant="subtitle2" fontWeight={800} color="text.primary">
                PGP (Previous Glasses Power)
              </Typography>
              <TextField
                type="date"
                size="small"
                value={medicalHistory?.previousGlassesDate || ''}
                onChange={(e) => setMedicalHistory(prev => ({ ...prev, previousGlassesDate: e.target.value }))}
                InputLabelProps={{ shrink: true }}
                sx={{ width: 140, '& input': { py: 0.3, fontSize: '0.75rem', fontWeight: 600 } }}
              />
            </Box>

            <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid #cbd5e1', borderRadius: 2 }}>
              <Table size="small" sx={{ tableLayout: 'fixed' }}>
                <TableHead sx={{ bgcolor: '#f8fafc' }}>
                  {/* Header Row 1 */}
                  <TableRow>
                    <TableCell colSpan={2} align="center" sx={{ fontWeight: 900, py: 0.4, fontSize: '0.72rem', borderRight: '1px solid #e2e8f0' }}>PGP</TableCell>
                    <TableCell colSpan={4} align="center" sx={{ fontWeight: 900, py: 0.4, fontSize: '0.75rem', color: '#2563eb', bgcolor: '#eff6ff', borderRight: '1px solid #cbd5e1' }}>OD</TableCell>
                    <TableCell colSpan={4} align="center" sx={{ fontWeight: 900, py: 0.4, fontSize: '0.75rem', color: '#059669', bgcolor: '#ecfdf5' }}>OS</TableCell>
                  </TableRow>
                  {/* Header Row 2 */}
                  <TableRow>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', width: '12%' }}>TYPE</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', borderRight: '1px solid #e2e8f0', width: '10%' }}>VAL</TableCell>
                    {/* OD */}
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%' }}>SPH</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%' }}>CYL</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%' }}>AXIS</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, borderRight: '1px solid #cbd5e1', width: '9.75%' }}>VA</TableCell>
                    {/* OS */}
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%' }}>SPH</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%' }}>CYL</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%' }}>AXIS</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%' }}>VA</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {/* DV Row */}
                  <TableRow>
                    <TableCell rowSpan={2} align="center" sx={{ fontWeight: 900, fontSize: '0.75rem', bgcolor: '#f8fafc', borderRight: '1px solid #e2e8f0', p: 0.3 }}>
                      PGP
                    </TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.72rem', bgcolor: '#f1f5f9', borderRight: '1px solid #e2e8f0', p: 0.3 }}>
                      DV
                    </TableCell>
                    {/* OD DV */}
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={medicalHistory?.pgpOdSph || ''} onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOdSph: e.target.value }))} inputProps={{ 'data-et-field': 'pgp', style: { textAlign: 'center', fontWeight: 700, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={medicalHistory?.pgpOdCyl || ''} onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOdCyl: e.target.value }))} inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={medicalHistory?.pgpOdAxis || ''} onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOdAxis: e.target.value }))} inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2, borderRight: '1px solid #cbd5e1' }}><TextField fullWidth size="small" value={medicalHistory?.pgpOdVa || ''} onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOdVa: e.target.value }))} inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    {/* OS DV */}
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={medicalHistory?.pgpOsSph || ''} onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOsSph: e.target.value }))} inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={medicalHistory?.pgpOsCyl || ''} onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOsCyl: e.target.value }))} inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={medicalHistory?.pgpOsAxis || ''} onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOsAxis: e.target.value }))} inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={medicalHistory?.pgpOsVa || ''} onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOsVa: e.target.value }))} inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                  </TableRow>

                  {/* ADD Row (ADD Power colSpan=3 + Near VA colSpan=1) */}
                  <TableRow>
                    <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.72rem', bgcolor: '#f1f5f9', borderRight: '1px solid #e2e8f0', p: 0.3 }}>
                      ADD
                    </TableCell>
                    {/* OD ADD Power (Spans SPH, CYL, AXIS) */}
                    <TableCell colSpan={3} sx={{ p: 0.3 }}>
                      <TextField 
                        fullWidth
                        size="small" 
                        value={medicalHistory?.pgpOdAdd || ''} 
                        onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOdAdd: e.target.value, pgpOdAddSph: e.target.value }))} 
                        placeholder="0.00" 
                        inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.8rem', padding: '4px' } }} 
                      />
                    </TableCell>
                    {/* OD Near VA (Under VA Column) */}
                    <TableCell colSpan={1} sx={{ p: 0.3, borderRight: '1px solid #cbd5e1' }}>
                      <TextField 
                        fullWidth
                        size="small" 
                        value={medicalHistory?.pgpOdAddVa || ''} 
                        onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOdAddVa: e.target.value }))} 
                        placeholder="N6" 
                        inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.8rem', padding: '4px' } }} 
                      />
                    </TableCell>
                    {/* OS ADD Power (Spans SPH, CYL, AXIS) */}
                    <TableCell colSpan={3} sx={{ p: 0.3 }}>
                      <TextField 
                        fullWidth
                        size="small" 
                        value={medicalHistory?.pgpOsAdd || ''} 
                        onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOsAdd: e.target.value, pgpOsAddSph: e.target.value }))} 
                        placeholder="0.00" 
                        inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.8rem', padding: '4px' } }} 
                      />
                    </TableCell>
                    {/* OS Near VA (Under VA Column) */}
                    <TableCell colSpan={1} sx={{ p: 0.3 }}>
                      <TextField 
                        fullWidth
                        size="small" 
                        value={medicalHistory?.pgpOsAddVa || ''} 
                        onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOsAddVa: e.target.value }))} 
                        placeholder="N6" 
                        inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.8rem', padding: '4px' } }} 
                      />
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </Grid>

        {/* Right: ACCP (Final Acceptance Refraction & Subjective Rx) Card */}
        <Grid item xs={12} md={6}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#eff6ff', borderColor: '#bfdbfe', height: '100%' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5 }}>
              <Typography variant="subtitle2" fontWeight={800} color="#2563eb">
                ACCP (Final Acceptance Refraction & Subjective Rx)
              </Typography>
              <Chip label="Final Rx" size="small" color="primary" sx={{ fontWeight: 800, height: 24, fontSize: '0.72rem', borderRadius: 1.5 }} />
            </Box>

            <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid #bfdbfe', borderRadius: 2, bgcolor: '#ffffff' }}>
              <Table size="small" sx={{ tableLayout: 'fixed' }}>
                <TableHead sx={{ bgcolor: '#dbeafe' }}>
                  {/* Header Row 1 */}
                  <TableRow>
                    <TableCell colSpan={2} align="center" sx={{ fontWeight: 900, py: 0.4, fontSize: '0.72rem', color: '#1e40af', borderRight: '1px solid #bfdbfe' }}>ACCP</TableCell>
                    <TableCell colSpan={4} align="center" sx={{ fontWeight: 900, py: 0.4, fontSize: '0.75rem', color: '#2563eb', bgcolor: '#eff6ff', borderRight: '1px solid #bfdbfe' }}>OD</TableCell>
                    <TableCell colSpan={4} align="center" sx={{ fontWeight: 900, py: 0.4, fontSize: '0.75rem', color: '#059669', bgcolor: '#ecfdf5' }}>OS</TableCell>
                  </TableRow>
                  {/* Header Row 2 */}
                  <TableRow>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', width: '12%', color: '#1e40af' }}>TYPE</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', color: '#1e40af', borderRight: '1px solid #bfdbfe', width: '10%' }}>VAL</TableCell>
                    {/* OD */}
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%', color: '#1e40af' }}>SPH</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%', color: '#1e40af' }}>CYL</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%', color: '#1e40af' }}>AXIS</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%', color: '#1e40af', borderRight: '1px solid #bfdbfe' }}>VA</TableCell>
                    {/* OS */}
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%', color: '#1e40af' }}>SPH</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%', color: '#1e40af' }}>CYL</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%', color: '#1e40af' }}>AXIS</TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, py: 0.3, fontSize: '0.7rem', px: 0.2, width: '9.75%', color: '#1e40af' }}>VA</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {/* DV Row */}
                  <TableRow>
                    <TableCell rowSpan={2} align="center" sx={{ fontWeight: 900, fontSize: '0.75rem', color: '#1e40af', bgcolor: '#f8fafc', borderRight: '1px solid #bfdbfe', p: 0.3 }}>
                      ACCP
                    </TableCell>
                    <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.72rem', color: '#2563eb', bgcolor: '#eff6ff', borderRight: '1px solid #bfdbfe', p: 0.3 }}>
                      DV
                    </TableCell>
                    {/* OD DV */}
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={subjectiveRefraction?.od?.sph || ''} onChange={(e) => handleSubjectiveEye('od', 'sph', e.target.value)} placeholder="0.00" inputProps={{ 'data-et-field': 'accp', style: { textAlign: 'center', fontWeight: 800, color: '#2563eb', fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={subjectiveRefraction?.od?.cyl || ''} onChange={(e) => handleSubjectiveEye('od', 'cyl', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={subjectiveRefraction?.od?.axis || ''} onChange={(e) => handleSubjectiveEye('od', 'axis', e.target.value)} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 800, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2, borderRight: '1px solid #bfdbfe' }}><TextField fullWidth size="small" value={subjectiveRefraction?.od?.va || ''} onChange={(e) => handleSubjectiveEye('od', 'va', e.target.value)} placeholder="6/6" inputProps={{ style: { textAlign: 'center', fontWeight: 800, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    {/* OS DV */}
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={subjectiveRefraction?.os?.sph || ''} onChange={(e) => handleSubjectiveEye('os', 'sph', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800, color: '#059669', fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={subjectiveRefraction?.os?.cyl || ''} onChange={(e) => handleSubjectiveEye('os', 'cyl', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={subjectiveRefraction?.os?.axis || ''} onChange={(e) => handleSubjectiveEye('os', 'axis', e.target.value)} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 800, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={subjectiveRefraction?.os?.va || ''} onChange={(e) => handleSubjectiveEye('os', 'va', e.target.value)} placeholder="6/6" inputProps={{ style: { textAlign: 'center', fontWeight: 800, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
                  </TableRow>

                  {/* ADD Row (ADD Power colSpan=3 + Near VA colSpan=1) */}
                  <TableRow>
                    <TableCell align="center" sx={{ fontWeight: 800, fontSize: '0.72rem', color: '#059669', bgcolor: '#ecfdf5', borderRight: '1px solid #bfdbfe', p: 0.3 }}>
                      ADD
                    </TableCell>
                    {/* OD ADD Power (Spans SPH, CYL, AXIS) */}
                    <TableCell colSpan={3} sx={{ p: 0.3 }}>
                      <TextField
                        fullWidth
                        size="small"
                        value={subjectiveRefraction?.odNv?.sph || ''}
                        onChange={(e) => handleSubjectiveEye('odNv', 'sph', e.target.value)}
                        placeholder="0.00"
                        inputProps={{ style: { textAlign: 'center', fontWeight: 800, color: '#2563eb', fontSize: '0.8rem', padding: '4px' } }}
                      />
                    </TableCell>
                    {/* OD Near VA (Under VA Column) */}
                    <TableCell colSpan={1} sx={{ p: 0.3, borderRight: '1px solid #bfdbfe' }}>
                      <TextField 
                        fullWidth
                        size="small" 
                        value={subjectiveRefraction?.odNv?.va || ''} 
                        onChange={(e) => handleSubjectiveEye('odNv', 'va', e.target.value)} 
                        placeholder="N6" 
                        inputProps={{ style: { textAlign: 'center', fontWeight: 800, fontSize: '0.8rem', padding: '4px' } }} 
                      />
                    </TableCell>
                    {/* OS ADD Power (Spans SPH, CYL, AXIS) */}
                    <TableCell colSpan={3} sx={{ p: 0.3 }}>
                      <TextField
                        fullWidth
                        size="small"
                        value={subjectiveRefraction?.osNv?.sph || ''}
                        onChange={(e) => handleSubjectiveEye('osNv', 'sph', e.target.value)}
                        placeholder="0.00"
                        inputProps={{ style: { textAlign: 'center', fontWeight: 800, color: '#059669', fontSize: '0.8rem', padding: '4px' } }}
                      />
                    </TableCell>
                    {/* OS Near VA (Under VA Column) */}
                    <TableCell colSpan={1} sx={{ p: 0.3 }}>
                      <TextField 
                        fullWidth
                        size="small" 
                        value={subjectiveRefraction?.osNv?.va || ''} 
                        onChange={(e) => handleSubjectiveEye('osNv', 'va', e.target.value)} 
                        placeholder="N6" 
                        inputProps={{ style: { textAlign: 'center', fontWeight: 800, fontSize: '0.8rem', padding: '4px' } }} 
                      />
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </TableContainer>
          </Paper>
        </Grid>
      </Grid>
      </Box>


      {/* 📋 SECTION 4: Clinical Notes & Management Plan */}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <ExamIcon fontSize="small" /> 4. Clinical Observations & Doctor Advice
        </Typography>

        <Box sx={lockSx}>
        <Grid container spacing={1.5}>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth multiline rows={2} size="small" label="C/O (Chief Complaints)"
              inputProps={{ 'data-et-field': 'observations' }}
              value={medicalHistory?.medicalHistory || ''}
              onChange={(e) => setMedicalHistory(prev => ({ ...prev, medicalHistory: e.target.value }))}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth multiline rows={2} size="small" label="Systemic / Medical History"
              value={medicalHistory?.familyHistory || ''}
              onChange={(e) => setMedicalHistory(prev => ({ ...prev, familyHistory: e.target.value }))}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth multiline rows={2} size="small" label="Doctor / Primary Diagnosis"
              inputProps={{ 'data-et-field': 'diagnosis' }}
              value={diagnosis?.primary || ''}
              onChange={(e) => setDiagnosis(prev => ({ ...prev, primary: e.target.value }))}
            />
          </Grid>

          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth multiline rows={2} size="small" label="Ocular Assessment (Slit Lamp)"
              value={eyeHealth?.anterior?.cornea || ''}
              onChange={(e) => setEyeHealth(prev => ({ ...prev, anterior: { ...(prev.anterior || {}), cornea: e.target.value } }))}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth multiline rows={2} size="small" label="Advise & Ergonomics"
              value={diagnosis?.advice || ''}
              onChange={(e) => setDiagnosis(prev => ({ ...prev, advice: e.target.value }))}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth multiline rows={2} size="small" label="Others / Dispensing Remarks"
              value={diagnosis?.remarks || ''}
              onChange={(e) => setDiagnosis(prev => ({ ...prev, remarks: e.target.value }))}
            />
          </Grid>
          <Grid item xs={12} sm={4} data-et-field="nextVisit">
            <QuickDatePickerField
              label="Next Visit"
              value={diagnosis.nextReviewDate || nextVisitDate || ''}
              baseDate={autoDate}
              showChips={true}
              onChange={(newDate) => {
                setDiagnosis(prev => ({ ...prev, nextReviewDate: newDate }));
                if (setNextVisitDate) setNextVisitDate(newDate);
              }}
              quickPresets={[
                { label: 'Today', type: 'today' },
                { label: '+1 Week', type: 'weeks', amount: 1 },
                { label: '+1 Month', type: 'months', amount: 1 },
                { label: '+3 Months', type: 'months', amount: 3 },
                { label: '+6 Months (Recommended)', type: 'months', amount: 6 },
                { label: '+1 Year', type: 'years', amount: 1 },
              ]}
              chipPresets={[
                { label: '+1M', type: 'months', amount: 1 },
                { label: '+3M', type: 'months', amount: 3 },
                { label: '+6M', type: 'months', amount: 6 },
                { label: '+1Y', type: 'years', amount: 1 },
              ]}
            />
          </Grid>
        </Grid>
        </Box>
      </Paper>

      {/* 💰 SECTION 5: Action Buttons Bar — payment is set on the Payment Details screen
          (see the summary under Patient Details). The buttons stay reachable: Save is simply
          disabled once already locked (nothing new to save), Rx Print/Clear Form/New Patient
          must keep working regardless. */}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Box sx={{ display: 'flex', gap: 1, justifyContent: { xs: 'stretch', sm: 'flex-end' }, flexWrap: 'wrap' }}>
          <Button variant="outlined" color="primary" disabled={isLocked} startIcon={<MedicalIcon />} data-et-action="orthoptics" onClick={() => setOrthopticsOpen(true)} sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 2 }}>
            Orthoptics Form
          </Button>
          <Button variant="outlined" color="secondary" startIcon={<PrintIcon />} data-et-action="rxPrint" onClick={() => setPrintModalOpen(true)} sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 2 }}>
            Rx Print
          </Button>
          {isLocked && (
            <Button variant="outlined" color="secondary" startIcon={<PrintIcon />} onClick={() => setPrintOptionsOpen(true)} sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 2 }}>
              Print Record &amp; Invoice
            </Button>
          )}
          <Button variant="contained" color="success" disabled={isLocked || saving} startIcon={<SaveIcon />} data-et-action="saveRecord" onClick={handleSaveClick} sx={{ textTransform: 'none', fontWeight: 800, borderRadius: 2, px: 3 }}>
            Save Clinical Record
          </Button>
          <Button variant="outlined" color="inherit" startIcon={<ClearIcon />} onClick={onClearAll} sx={{ textTransform: 'none', fontWeight: 600, borderRadius: 2 }}>
            Clear Form
          </Button>
        </Box>
      </Paper>

      {/* 📜 SECTION 6: Saved Examination Directory Search Table */}
      <Paper ref={directoryRef} variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <SearchIcon /> Recent Examination Directory ({filteredHistory.length})
          </Typography>

          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              size="small" placeholder="Search Test No, Patient ID, Name, Gender, Optometrist..."
              inputProps={{ 'data-et-field': 'directory' }}
              value={historySearch}
              onChange={(e) => setHistorySearch(e.target.value)}
              sx={{ width: 300 }}
            />
            <QuickDatePickerField
              label="From"
              value={fromDate}
              onChange={(newDate) => setFromDate(newDate)}
              sx={{ width: 160 }}
              quickPresets={[
                { label: 'Today', type: 'today' },
                { label: '-7 Days', type: 'days', amount: -7 },
                { label: '-30 Days', type: 'days', amount: -30 },
              ]}
            />
            <QuickDatePickerField
              label="To"
              value={toDate}
              onChange={(newDate) => setToDate(newDate)}
              sx={{ width: 160 }}
              quickPresets={[
                { label: 'Today', type: 'today' },
                { label: '+7 Days', type: 'days', amount: 7 },
                { label: '+30 Days', type: 'days', amount: 30 },
              ]}
            />
          </Stack>
        </Box>

        <TableContainer ref={directoryTableRef} component={Paper} elevation={0} sx={{ border: '1px solid #e2e8f0', borderRadius: 2, maxHeight: 220 }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: '#0f172a', color: '#fff' } }}>
                <TableCell>Test No</TableCell>
                <TableCell>Date</TableCell>
                <TableCell>Patient ID</TableCell>
                <TableCell>Patient</TableCell>
                <TableCell>Age/Gender</TableCell>
                <TableCell>Mobile No</TableCell>
                <TableCell>Address</TableCell>
                <TableCell>Place</TableCell>
                <TableCell>Optometrist</TableCell>
                <TableCell>Fee</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredHistory.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={11} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                    No recent examinations saved in database. Click "Save Clinical Record" to log tests.
                  </TableCell>
                </TableRow>
              ) : (
                filteredHistory.map((row, idx) => (
                  <TableRow key={row.backendId || row.id || `${row.patientId || ''}_${row.testNo || ''}_${idx}`} hover sx={{ cursor: 'pointer' }} onClick={() => onSelectExamFromHistory && onSelectExamFromHistory(row)}>
                    <TableCell sx={{ fontWeight: 800 }}>#{row.testNo || idx + 1}</TableCell>
                    <TableCell>{row.date || '—'}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{row.patientId || '—'}</TableCell>
                    <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{row.name || '—'}</TableCell>
                    <TableCell>{row.age || '—'} / {row.gender || '—'}</TableCell>
                    <TableCell>{row.phone || 'N/A'}</TableCell>
                    <TableCell>{row.address || row.patientData?.address || '—'}</TableCell>
                    <TableCell>{row.place || row.patientData?.place || row.patientData?.city || '—'}</TableCell>
                    <TableCell>{row.assignedOptometrist || row.optometrist || row.doctor || '—'}</TableCell>
                    <TableCell>
                      {(() => {
                        const bill = billRecordFromExam(row);
                        const color = { FREE: 'info', PAID: 'success', PENDING: 'warning', BILLED: 'default' }[bill.feeStatus] || 'default';
                        const amount = bill.isFreeTest ? '' : ` ₹${eyeTestFeeTotal(bill)}`;
                        const label = bill.feeStatus === 'BILLED' && bill.feeInvoiceNumber
                          ? `Billed · ${bill.feeInvoiceNumber}`
                          : `${bill.feeStatus === 'PENDING' ? 'Pending' : (FEE_STATUS_LABELS[bill.feeStatus] || '—')}${amount}`;
                        return <Chip size="small" color={color} variant={bill.feeStatus === 'PENDING' ? 'filled' : 'outlined'} label={label} sx={{ fontWeight: 700 }} />;
                      })()}
                    </TableCell>
                    <TableCell align="center">
                      <Stack direction="row" spacing={0.75} justifyContent="center">
                        <Button size="small" variant="outlined" onClick={(e) => { e.stopPropagation(); onSelectExamFromHistory(row); }}>
                          Load Exam
                        </Button>
                        <Tooltip title="Edit">
                          <IconButton size="small" color="primary" onClick={(e) => { e.stopPropagation(); onSelectExamFromHistory(row); }}>
                            <EditIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                        <Tooltip title="Print Invoice">
                          <IconButton
                            size="small"
                            color="secondary"
                            onClick={(e) => { e.stopPropagation(); setInvoicePrintMenu({ anchorEl: e.currentTarget, row }); }}
                          >
                            <PrintIcon fontSize="small" />
                          </IconButton>
                        </Tooltip>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Paper>

      {/* Paper size choice for the invoice print icon above */}
      <Menu
        anchorEl={invoicePrintMenu.anchorEl}
        open={Boolean(invoicePrintMenu.anchorEl)}
        onClose={() => setInvoicePrintMenu({ anchorEl: null, row: null })}
      >
        <MenuItem onClick={() => { handlePrintInvoice(invoicePrintMenu.row, 'A4'); setInvoicePrintMenu({ anchorEl: null, row: null }); }}>
          <ListItemIcon><PrintIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Print A4</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { handlePrintInvoice(invoicePrintMenu.row, 'A5'); setInvoicePrintMenu({ anchorEl: null, row: null }); }}>
          <ListItemIcon><PrintIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Print A5</ListItemText>
        </MenuItem>
        <MenuItem onClick={() => { printEyeTestReceipt(billRecordFromExam(invoicePrintMenu.row)); setInvoicePrintMenu({ anchorEl: null, row: null }); }}>
          <ListItemIcon><PrintIcon fontSize="small" /></ListItemIcon>
          <ListItemText>Payment Receipt (80 mm)</ListItemText>
        </MenuItem>
      </Menu>

      {/* 🏥 Orthoptics Examination Modal */}
      <OrthopticsModal
        open={orthopticsOpen}
        onClose={() => setOrthopticsOpen(false)}
        binocularVision={binocularVision}
        setBinocularVision={setBinocularVision}
      />

      {/* 🖨️ Hospital Letterhead Print Prescription Modal */}
      <Dialog 
        open={printModalOpen} 
        onClose={() => setPrintModalOpen(false)} 
        maxWidth="lg" 
        fullWidth
        PaperProps={{ style: { borderRadius: 12 } }}
      >
        <Box sx={{ p: 2, bgcolor: '#0f172a', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h6" fontWeight={800} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PrintIcon color="secondary" /> Official Hospital Letterhead Prescription Preview
          </Typography>
          <Button size="small" onClick={() => setPrintModalOpen(false)} sx={{ color: '#fff', minWidth: 'auto' }}>
            <CloseIcon />
          </Button>
        </Box>
        <Box sx={{ p: 2, bgcolor: '#f8fafc' }}>
          <PrintPrescriptionCard
            patientData={{
              ...patientData,
              id: autoPatientId,
              date: autoDate
            }}
            subjectiveRefraction={subjectiveRefraction}
            diagnosis={diagnosis}
            prescription={prescription}
            medicalHistory={medicalHistory}
          />
        </Box>
      </Dialog>

      {/* 💳 Payment Details — opened by the Patient Details "Save" (and by Save Clinical Record
          if never confirmed). Charges on top for immediate entry, then how the visit is settled:
          Pay Now (Cash / GPay), No Payment, or Pay After Sale — the fee stays pending and is
          added to this patient's New Sale bill. */}
      <Dialog open={Boolean(paymentOpen)} onClose={() => !saving && setPaymentOpen(false)} maxWidth="sm" fullWidth PaperProps={{ style: { borderRadius: 12 } }}>
        <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
          <SaveIcon color="success" /> Payment Details — {patientData.name || 'Patient'}
          <Typography component="span" variant="body2" color="text.secondary" sx={{ ml: 'auto' }}>
            Test No {testNo || 'assigned on save'} · {diagnosis.testType || 'FREE EYE TEST'}
          </Typography>
        </DialogTitle>
        <DialogContent dividers>
          <Grid container spacing={2} sx={paymentChoice === NO_PAYMENT ? { opacity: 0.45, pointerEvents: 'none' } : undefined}>
            <Grid item xs={6}>
              <TextField
                fullWidth size="small" label="Procedure Charge" autoFocus={paymentChoice !== NO_PAYMENT}
                value={diagnosis?.procedureCharge || '0'}
                onChange={(e) => setDiagnosis(prev => ({ ...prev, procedureCharge: e.target.value }))}
                onFocus={(e) => e.target.select()}
                InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
              />
            </Grid>
            {/* Amount claimed from / covered by the medical aid — a deduction on the invoice. */}
            <Grid item xs={6}>
              <TextField
                fullWidth size="small" label="Medical Aid Charge"
                value={diagnosis?.medicalAidCharge || '0'}
                onChange={(e) => setDiagnosis(prev => ({ ...prev, medicalAidCharge: e.target.value }))}
                onFocus={(e) => e.target.select()}
                InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
                helperText={patientData?.medicalAidName || ' '}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField
                fullWidth size="small" label="Customer Paid Amount"
                disabled={paymentChoice !== PAY_NOW}
                value={paymentChoice === PAY_NOW ? (diagnosis?.customerPaidAmount ?? '0') : '0'}
                onChange={(e) => {
                  setCustomerPaidTouched(true);
                  setDiagnosis(prev => ({ ...prev, customerPaidAmount: e.target.value }));
                }}
                onFocus={(e) => e.target.select()}
                InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
                helperText={paymentChoice === PAY_AFTER_SALE
                  ? 'Collected with the frame/lens purchase'
                  : customerPaidTouched
                    ? 'Manual override — clear the form to resume auto-calc'
                    : 'Auto: Procedure + Medicine − Medical Aid'}
              />
            </Grid>
            <Grid item xs={6}>
              <TextField
                fullWidth size="small" label="Medicine Charge"
                value={diagnosis?.medicineCharge || '0'}
                onChange={(e) => setDiagnosis(prev => ({ ...prev, medicineCharge: e.target.value }))}
                onFocus={(e) => e.target.select()}
                InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
                inputProps={{ id: 'eyetest-medicine-charge-input' }}
              />
            </Grid>
          </Grid>

          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mt: 1, p: 1.25, borderRadius: 2, bgcolor: '#f1f5f9' }}>
            <Typography variant="body2" fontWeight={700}>Total payable</Typography>
            <Typography variant="h6" fontWeight={800}>{paymentChoice === NO_PAYMENT ? 'No payment' : `₹${autoCustomerBalance.toFixed(2)}`}</Typography>
          </Box>

          <Typography variant="caption" color="text.secondary" fontWeight={700} sx={{ display: 'block', mt: 1.5 }}>PAYMENT</Typography>
          <ToggleButtonGroup
            exclusive fullWidth size="small" color="primary" sx={{ mt: 0.5 }}
            value={paymentChoice}
            onChange={(e, choice) => { if (choice) setDiagnosis(prev => ({ ...prev, ...applyPaymentChoice(choice) })); }}
          >
            {PAYMENT_CHOICES.map(c => (
              <ToggleButton key={c.value} value={c.value} sx={{ fontWeight: 800, textTransform: 'none' }}>{c.label}</ToggleButton>
            ))}
          </ToggleButtonGroup>

          {paymentChoice === PAY_NOW && (
            <Box sx={{ mt: 1.5 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={700}>PAYMENT MODE</Typography>
              <ToggleButtonGroup
                exclusive fullWidth size="small" color="success" sx={{ mt: 0.5 }}
                value={diagnosis?.paymentMode || 'CASH'}
                onChange={(e, mode) => { if (mode) setDiagnosis(prev => ({ ...prev, paymentMode: mode })); }}
              >
                {EYE_TEST_PAY_MODES.map(m => (
                  <ToggleButton key={m.value} value={m.value} sx={{ fontWeight: 800, textTransform: 'none' }}>{m.label}</ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>
          )}
          {paymentChoice === NO_PAYMENT && (
            <Alert severity="info" sx={{ mt: 1.5 }}>No payment is taken for this visit — it prints as a free test.</Alert>
          )}
          {paymentChoice === PAY_AFTER_SALE && (
            <Alert severity="warning" sx={{ mt: 1.5 }}>
              ₹{autoCustomerBalance.toFixed(2)} is kept as a <b>Pending Eye Test Fee</b>. After you save the clinical record
              you go straight to <b>Sales → New Sale</b>, where it is added to this patient's bill.
            </Alert>
          )}

          <Divider sx={{ my: 1.5 }} />
          <Stack spacing={0.5}>
            {[
              ['Patient', `${patientData.name || '—'} (${autoPatientId || '—'})`],
              ['Contact', patientData.phone || '—'],
              ['Optometrist', patientData.assignedOptometrist || '—'],
            ].map(([label, value]) => (
              <Box key={label} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                <Typography variant="body2" color="text.secondary">{label}</Typography>
                <Typography variant="body2" fontWeight={700}>{value}</Typography>
              </Box>
            ))}
          </Stack>
        </DialogContent>
        <DialogActions sx={{ px: 2, py: 1.5 }}>
          {/* Prints the payment receipt, or the Clinical Record & Invoice, as it stands on screen —
              charges, the chosen payment and whatever examination details are entered so far. */}
          <Button variant="outlined" color="secondary" startIcon={<PrintIcon />} disabled={saving}
            onClick={(e) => setPaymentPrintMenu(e.currentTarget)}
            sx={{ textTransform: 'none', fontWeight: 700, mr: 'auto' }}>
            Print
          </Button>
          <Menu anchorEl={paymentPrintMenu} open={Boolean(paymentPrintMenu)} onClose={() => setPaymentPrintMenu(null)}>
            <MenuItem onClick={() => { setPaymentPrintMenu(null); printEyeTestReceipt(billRecordFromExam(currentVisit())); }}>
              <ListItemIcon><PrintIcon fontSize="small" /></ListItemIcon>
              <ListItemText primary="Payment Receipt" secondary="80 mm" />
            </MenuItem>
            {['A4', 'A5'].map(size => (
              <MenuItem key={size} onClick={() => { setPaymentPrintMenu(null); printEyeTestBill(billRecordFromExam(currentVisit()), { paperSize: size }); }}>
                <ListItemIcon><PrintIcon fontSize="small" /></ListItemIcon>
                <ListItemText primary={`Report ${size}`} secondary="Clinical record & invoice" />
              </MenuItem>
            ))}
          </Menu>
          <Button variant="outlined" startIcon={<EditIcon />} disabled={saving} onClick={() => setPaymentOpen(false)} sx={{ textTransform: 'none', fontWeight: 700 }}>
            Back
          </Button>
          <Button variant="contained" color="success" startIcon={<SaveIcon />} disabled={saving} autoFocus={paymentChoice === NO_PAYMENT} onClick={handlePaymentConfirm} sx={{ textTransform: 'none', fontWeight: 800 }}>
            {saving ? 'Saving…' : paymentOpen === 'record' ? 'Save Clinical Record' : 'Confirm & Continue to Test'}
          </Button>
        </DialogActions>
      </Dialog>

      {/* 🖨️ Print options — shown once the record is saved (straight away for a free test). */}
      <Dialog open={printOptionsOpen} onClose={handlePrintOptionsDone} maxWidth="xs" fullWidth PaperProps={{ style: { borderRadius: 12 } }}>
        <DialogTitle sx={{ fontWeight: 800, display: 'flex', alignItems: 'center', gap: 1 }}>
          <ActiveIcon color="success" /> Clinical Record Saved
        </DialogTitle>
        <DialogContent dividers>
          {(() => {
            const bill = billRecordFromExam(currentVisit());
            const total = eyeTestFeeTotal(bill);
            return (
              <Stack spacing={0.75}>
                {[
                  ['Patient', `${bill.name || '—'} (${bill.patientId || '—'})`],
                  ['Test No', bill.testNo || '—'],
                  ['Optometrist', bill.optometrist || '—'],
                  ['Fee', bill.isFreeTest ? 'Free test'
                    : bill.feeStatus === 'PENDING' ? `₹${total.toFixed(2)} pending — with frame/lens purchase`
                      : `₹${bill.paidAmount.toFixed(2)} paid of ₹${total.toFixed(2)} (${payModeLabel(bill.paymentMode) || 'Cash'})`],
                ].map(([label, value]) => (
                  <Box key={label} sx={{ display: 'flex', justifyContent: 'space-between', gap: 2 }}>
                    <Typography variant="body2" color="text.secondary">{label}</Typography>
                    <Typography variant="body2" fontWeight={700} textAlign="right">{value}</Typography>
                  </Box>
                ))}
              </Stack>
            );
          })()}
          {paymentChoice === PAY_AFTER_SALE && onGoToSales && (
            <Button fullWidth variant="contained" color="warning" autoFocus sx={{ mt: 2, textTransform: 'none', fontWeight: 800 }}
              onClick={() => { setPrintOptionsOpen(false); onGoToSales(autoTestNo); }}>
              Go to Sales — collect ₹{autoCustomerBalance.toFixed(2)} with the frame / lens
            </Button>
          )}
          <Stack direction="row" spacing={1} sx={{ mt: 2 }}>
            <Button fullWidth variant={paymentChoice === PAY_AFTER_SALE ? 'outlined' : 'contained'} startIcon={<PrintIcon />} autoFocus={paymentChoice !== PAY_AFTER_SALE} onClick={() => printEyeTestBill(billRecordFromExam(currentVisit()), { paperSize: 'A4' })} sx={{ textTransform: 'none', fontWeight: 800 }}>
              Record &amp; Invoice A4
            </Button>
            <Button fullWidth variant="outlined" startIcon={<PrintIcon />} onClick={() => printEyeTestBill(billRecordFromExam(currentVisit()), { paperSize: 'A5' })} sx={{ textTransform: 'none', fontWeight: 800 }}>
              A5
            </Button>
          </Stack>
          <Button fullWidth variant="outlined" startIcon={<PrintIcon />} sx={{ mt: 1, textTransform: 'none', fontWeight: 800 }}
            onClick={() => printEyeTestReceipt(billRecordFromExam(currentVisit()))}>
            Payment Receipt (80 mm)
          </Button>
          <Button fullWidth variant="outlined" color="secondary" startIcon={<EyeIcon />} sx={{ mt: 1, textTransform: 'none', fontWeight: 700 }}
            onClick={() => { setPrintOptionsOpen(false); setPrintModalOpen(true); }}>
            Rx Print (letterhead prescription)
          </Button>
        </DialogContent>
        <DialogActions sx={{ px: 2, py: 1.5 }}>
          <Button onClick={handlePrintOptionsDone} sx={{ textTransform: 'none', fontWeight: 700 }}>Done</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
