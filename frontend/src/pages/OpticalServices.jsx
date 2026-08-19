import React, { useState, useEffect, useRef } from 'react';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Box, Card, Typography, Grid, TextField, Button, 
  MenuItem, Table, TableBody, TableCell, TableContainer, 
  TableHead, TableRow, Paper, Divider, Stack, Chip, 
  IconButton, Tooltip, Alert, Dialog, DialogTitle, 
  DialogContent, DialogActions 
} from '@mui/material';
import { 
  Visibility as EyeIcon, 
  Print as PrintIcon, 
  AssignmentTurnedIn as SaveIcon,
  NavigateNext as NextIcon,
  NavigateBefore as BackIcon,
  Search as SearchIcon,
  PersonAdd as AddPersonIcon,
  CompareArrows as CompareIcon,
  History as HistoryIcon,
  Keyboard as KeyboardIcon,
  ShoppingCartOutlined as SalesIcon,
  MedicalServices as MedicalIcon
} from '@mui/icons-material';

// Import Optical Sub-components
import ExaminationStepper, { stepsList } from '../components/optical/ExaminationStepper';
import ExaminationSummarySidebar from '../components/optical/ExaminationSummarySidebar';
import PatientSearchModal from '../components/optical/PatientSearchModal';
import RxCompareModal from '../components/optical/RxCompareModal';
import PrintPrescriptionCard from '../components/optical/PrintPrescriptionCard';
import Step1PatientInfo from '../components/optical/Step1PatientInfo';
import Step2MedicalHistory from '../components/optical/Step2MedicalHistory';
import Step3VisualAcuity from '../components/optical/Step3VisualAcuity';
import Step4ObjectiveRefraction from '../components/optical/Step4ObjectiveRefraction';
import Step5SubjectiveRefraction from '../components/optical/Step5SubjectiveRefraction';
import Step6BinocularVision from '../components/optical/Step6BinocularVision';
import Step7EyeHealth from '../components/optical/Step7EyeHealth';
import Step8Diagnosis from '../components/optical/Step8Diagnosis';
import Step9Prescription from '../components/optical/Step9Prescription';
import SingleScreenEyeTestForm from '../components/optical/SingleScreenEyeTestForm';

// A real backend Customer id is a UUID; local/legacy records use human-readable
// "P-1001"-style codes as their id, which never match this shape.
const isBackendId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export default function OpticalServices() {
  const navigate = useNavigate();
  const location = useLocation();
  const appointmentHandledRef = useRef(false);

  const [layoutMode, setLayoutMode] = useState('single'); // 'single' (Image 3 ERP view) or 'wizard'
  const [viewMode, setViewMode] = useState('form'); // 'form' or 'list'
  const [activeStep, setActiveStep] = useState(0);

  // Modals state
  const [searchModalOpen, setSearchModalOpen] = useState(false);
  const [compareModalOpen, setCompareModalOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);

  // Database Integration State
  const [pastExaminations, setPastExaminations] = useState([]);
  const [dbPatients, setDbPatients] = useState([]);
  const [recordsLoaded, setRecordsLoaded] = useState(false);
  const [doctorsList, setDoctorsList] = useState([]);
  // Set when arriving here via Patient History's "Edit" action on a past exam — makes
  // handleSaveDraft PATCH that same backend EyeExamination row instead of always POSTing a
  // new one, which would otherwise leave the original unedited and create a duplicate.
  const [editingExamId, setEditingExamId] = useState(null);

  // Core Examination State
  const [patientData, setPatientData] = useState({
    id: '',
    customerId: null,
    name: '',
    age: '',
    gender: 'Male',
    phone: '',
    email: '',
    address: '',
    occupation: '',
    branch: 'Main Branch',
    appointmentNum: '',
    visitNum: '',
    assignedOptometrist: '',
    lastVisitDate: '',
    previousPrescription: '',
    visitHistory: []
  });

  const [medicalHistory, setMedicalHistory] = useState({
    chiefComplaints: [],
    medicalHistory: '',
    familyHistory: '',
    ocularHistory: '',
    previousSurgery: '',
    previousGlasses: '',
    currentMedication: '',
    allergy: '',
    contactLensHistory: '',
    lifestyle: '',
    hasDiabetes: false,
    hasHypertension: false,
    notes: ''
  });

  const [visualAcuity, setVisualAcuity] = useState({
    distance: { odWo: '', odWith: '', osWo: '', osWith: '', odPinhole: '', osPinhole: '' },
    near: { odWo: '', odWith: '', osWo: '', osWith: '' },
    colorVision: 'Normal',
    contrastSensitivity: 'Normal',
    dominantEye: 'Right (OD)'
  });

  const [objectiveRefraction, setObjectiveRefraction] = useState({
    autoRefraction: {
      od: { sph: '', cyl: '', axis: '', va: '', pd: '' },
      os: { sph: '', cyl: '', axis: '', va: '', pd: '' }
    },
    retinoscopy: {
      od: { sph: '', cyl: '', axis: '', va: '' },
      os: { sph: '', cyl: '', axis: '', va: '' }
    },
    kReading: {
      odK1: '', odK2: '', osK1: '', osK2: '', cornealRadius: '', streakNotes: ''
    }
  });

  const [subjectiveRefraction, setSubjectiveRefraction] = useState({
    od: { sph: '', cyl: '', axis: '', va: '' },
    os: { sph: '', cyl: '', axis: '', va: '' },
    nearAdd: '',
    pd: '',
    prism: '',
    balanceTest: '',
    fogging: '',
    duochrome: '',
    crossCylinder: ''
  });

  const [binocularVision, setBinocularVision] = useState({
    npc: '',
    coverTest: '',
    phoria: '',
    vergence: '',
    accommodation: '',
    worthFourDot: '',
    stereoVision: '',
    eyeDominance: ''
  });

  const [eyeHealth, setEyeHealth] = useState({
    anterior: { lids: '', lashes: '', conjunctiva: '', cornea: '', iris: '', lens: '', anteriorChamber: '' },
    posterior: { disc: '', macula: '', retina: '', vessels: '' },
    iop: { od: '', os: '', method: '' },
    cupDiscRatio: { od: '', os: '' },
    dilatedExam: ''
  });

  const [diagnosis, setDiagnosis] = useState({
    primary: '',
    icdCode: '',
    remarks: '',
    procedure: '',
    medicine: '',
    advice: '',
    nextReview: ''
  });

  const [prescription, setPrescription] = useState({
    selectedLenses: [],
    frameRecommendation: '',
    lensRecommendation: ''
  });

  // Sync Patients, Examinations, and Registered Doctors from Database / LocalStorage / API
  useEffect(() => {
    const fetchDatabaseRecords = async () => {
      let patientsList = [];
      let testsList = [];
      let docsList = [];

      try {
        const localCust = JSON.parse(localStorage.getItem('optical_sales_customers') || '[]');
        const localTests = JSON.parse(localStorage.getItem('optical_eye_tests') || '[]');
        const localDocs = JSON.parse(localStorage.getItem('optical_doctors') || '[]');
        
        // Purge legacy demo records (e.g. Mohammed, P-7375) from localStorage
        const cleanCust = localCust.filter(c => c.name && c.name !== 'Mohammed' && c.id !== 'P-7375');
        const cleanTests = localTests.filter(t => t.name && t.name !== 'Mohammed' && t.patientId !== 'P-7375' && t.id !== 'P-7375');
        
        localStorage.setItem('optical_sales_customers', JSON.stringify(cleanCust));
        localStorage.setItem('optical_eye_tests', JSON.stringify(cleanTests));

        patientsList = cleanCust;
        testsList = cleanTests;
        docsList = [...localDocs];
      } catch (e) {}

      try {
        // /api/sales/* endpoints are paginated (DRF PageNumberPagination) — a successful
        // response is {count, next, previous, results}, not a bare array.
        const resCust = await axios.get('/api/sales/customers/');
        const custData = resCust.data?.results || resCust.data || [];
        if (Array.isArray(custData)) {
          const apiCust = custData.filter(c => c.name && c.name !== 'Mohammed' && c.id !== 'P-7375');
          patientsList = [...patientsList, ...apiCust];
        }
      } catch (e) {}

      try {
        const resTests = await axios.get('/api/sales/eye-examinations/');
        const testsData = resTests.data?.results || resTests.data || [];
        if (Array.isArray(testsData)) {
          const apiTests = testsData.map(item => item.raw_data || {
            id: item.visit_number || item.id,
            date: item.examination_date ? item.examination_date.split('T')[0] : '',
            patientId: item.patient_id,
            name: item.patient_name,
            doctor: item.optometrist,
            diagnosis: item.primary_diagnosis || item.diagnosis,
            rx: item.rx_summary || item.rx,
            subjectiveRefraction: {
              od: { sph: item.sub_sph_od, cyl: item.sub_cyl_od, axis: item.sub_axis_od, va: item.sub_va_od },
              os: { sph: item.sub_sph_os, cyl: item.sub_cyl_os, axis: item.sub_axis_os, va: item.sub_va_os },
              nearAdd: item.sub_add_od || item.sub_add_os,
              odNv: { sph: item.sub_add_od, va: item.sub_add_va_od },
              osNv: { sph: item.sub_add_os, va: item.sub_add_va_os }
            },
            medicalHistory: {
              pgpOdSph: item.pgp_od_sph,
              pgpOdCyl: item.pgp_od_cyl,
              pgpOdAxis: item.pgp_od_axis,
              pgpOdVa: item.pgp_od_va,
              pgpOdAdd: item.pgp_od_add,
              pgpOdAddVa: item.pgp_od_add_va,
              pgpOsSph: item.pgp_os_sph,
              pgpOsCyl: item.pgp_os_cyl,
              pgpOsAxis: item.pgp_os_axis,
              pgpOsVa: item.pgp_os_va,
              pgpOsAdd: item.pgp_os_add,
              pgpOsAddVa: item.pgp_os_add_va,
              previousGlassesDate: item.previous_glasses_date
            }
          }).filter(t => t.name && t.name !== 'Mohammed' && t.patientId !== 'P-7375');
          testsList = [...testsList, ...apiTests];
        }
      } catch (e) {}

      try {
        const resUsers = await axios.get('/api/admin/users/');
        if (resUsers.data && Array.isArray(resUsers.data)) {
          const apiDocNames = resUsers.data
            .filter(u => u.role === 'DOCTOR' || u.role === 'OPTOMETRIST' || (u.designation && u.designation.toLowerCase().includes('doc')))
            .map(u => u.name || `Dr. ${u.first_name} ${u.last_name}`)
            .filter(Boolean);
          docsList = [...docsList, ...apiDocNames];
        }
      } catch (e) {}

      // Sync registered doctors from Doctor Master (optical_doctors_db)
      try {
        const adminDocs = JSON.parse(localStorage.getItem('optical_doctors_db') || '[]');
        const adminDocNames = adminDocs.filter(d => d.status === 'Active').map(d => d.name);
        docsList = [...docsList, ...adminDocNames];
      } catch (e) {}

      // Deduplicate patients: prefer patient_code as the identity key so a locally-cached
      // record (id = "P-1001") and its backend counterpart (id = real UUID, patient_code =
      // "P-1001") collapse into one entry instead of showing the same patient twice.
      const uniquePatients = Array.from(
        new Map(patientsList.map(item => [item.patient_code || item.id || item.phone, item])).values()
      ).map(p => {
        // patientData.id is always displayed/typed as the human-readable code; the real
        // backend link (used to PATCH the same Customer row instead of creating a duplicate)
        // is tracked separately in customerId.
        const backendId = isBackendId(p.id) ? p.id : (p.customerId || null);
        const humanId = p.patient_code || (isBackendId(p.id) ? null : p.id) || p.id;
        return { ...p, id: humanId, customerId: backendId };
      });

      setDbPatients(uniquePatients);
      setDoctorsList(Array.from(new Set(docsList.filter(Boolean))));
      setPastExaminations(testsList);
      setRecordsLoaded(true);
    };

    fetchDatabaseRecords();

    window.addEventListener('optical_doctors_updated', fetchDatabaseRecords);
    return () => window.removeEventListener('optical_doctors_updated', fetchDatabaseRecords);
  }, []);

  // Generates the next Patient ID by scanning every known patient/exam id for the highest
  // "P-NNNN" number in use and incrementing it. A plain count-based scheme (P-1001 + length)
  // isn't safe: pastExaminations can vary in length between sessions/reloads (depending on what
  // happened to load), so two different patients registered in different sessions could both
  // land on the same "next" number — which is exactly how two unrelated patients ended up
  // sharing the same Patient ID.
  const getNextPatientId = () => {
    const allIds = [...(dbPatients || []), ...(pastExaminations || [])]
      .map(p => String(p.id || p.patientId || '').match(/^p-?(\d+)$/i))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10));
    const maxId = allIds.length > 0 ? Math.max(...allIds) : 1000;
    return `P-${maxId + 1}`;
  };

  // Reset all examination fields to 100% blank
  const handleResetAll = () => {
    setPatientData({
      id: getNextPatientId(),
      customerId: null,
      name: '',
      age: '',
      gender: 'Male',
      phone: '',
      email: '',
      address: '',
      occupation: '',
      branch: 'Main Branch',
      appointmentNum: '',
      visitNum: '',
      assignedOptometrist: '',
      lastVisitDate: '',
      previousPrescription: '',
      visitHistory: []
    });

    setMedicalHistory({
      chiefComplaints: [],
      medicalHistory: '',
      familyHistory: '',
      ocularHistory: '',
      previousSurgery: '',
      previousGlasses: '',
      previousGlassesDate: '',
      currentMedication: '',
      allergy: '',
      contactLensHistory: '',
      lifestyle: '',
      hasDiabetes: false,
      hasHypertension: false,
      notes: '',
      pgpOdSph: '', pgpOdCyl: '', pgpOdAxis: '', pgpOdVa: '', pgpOdAdd: '',
      pgpOsSph: '', pgpOsCyl: '', pgpOsAxis: '', pgpOsVa: '', pgpOsAdd: ''
    });

    setVisualAcuity({
      distance: { odWo: '', odWith: '', osWo: '', osWith: '', odPinhole: '', osPinhole: '' },
      near: { odWo: '', odWith: '', osWo: '', osWith: '' },
      colorVision: 'Normal',
      contrastSensitivity: 'Normal',
      dominantEye: ''
    });

    setObjectiveRefraction({
      autoRefraction: {
        od: { sph: '', cyl: '', axis: '', va: '', pd: '' },
        os: { sph: '', cyl: '', axis: '', va: '', pd: '' }
      },
      retinoscopy: {
        od: { sph: '', cyl: '', axis: '', va: '' },
        os: { sph: '', cyl: '', axis: '', va: '' }
      },
      kReading: {
        odK1: '', odK2: '', osK1: '', osK2: '', cornealRadius: '', streakNotes: ''
      }
    });

    setSubjectiveRefraction({
      od: { sph: '', cyl: '', axis: '', va: '' },
      os: { sph: '', cyl: '', axis: '', va: '' },
      nearAdd: '',
      pd: '',
      prism: '',
      balanceTest: '',
      fogging: '',
      duochrome: '',
      crossCylinder: ''
    });

    setBinocularVision({
      npc: '',
      coverTest: '',
      phoria: '',
      vergence: '',
      accommodation: '',
      worthFourDot: '',
      stereoVision: '',
      eyeDominance: '',
      therapyNotes: ''
    });

    setEyeHealth({
      anterior: { lids: '', lashes: '', conjunctiva: '', cornea: '', iris: '', lens: '', anteriorChamber: '' },
      posterior: { disc: '', macula: '', retina: '', vessels: '' },
      iop: { od: '', os: '', method: '' },
      cupDiscRatio: { od: '', os: '' },
      dilatedExam: ''
    });

    setDiagnosis({
      primary: '',
      icdCode: '',
      remarks: '',
      procedure: '',
      medicine: '',
      advice: '',
      nextReview: '',
      ocularAssessment: '',
      ergonomicsAdvice: '',
      dispensingRemarks: '',
      procedureCharge: '0',
      medicineCharge: '0',
      testType: 'FREE EYE TEST',
      testNo: ''
    });

    setPrescription({
      selectedLenses: [],
      frameRecommendation: '',
      lensRecommendation: ''
    });
  };

  // Smart Keyboard Navigation Handler (Enter, ArrowRight, ArrowLeft, ArrowUp, ArrowDown)
  const handleKeyDownEnter = (e) => {
    const keys = ['Enter', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'];
    if (!keys.includes(e.key)) return;

    // Use e.target rather than document.activeElement: by the time this bubble-phase
    // handler runs, activeElement can already be one step stale (browser/MUI internals
    // reassign focus asynchronously relative to this listener), which was causing Enter
    // to skip two fields at once instead of one. e.target is fixed at dispatch time.
    const activeEl = e.target;
    // Do not override if user is inside a multiline textarea
    if (activeEl && activeEl.tagName === 'TEXTAREA') return;

    // Mobile No is the last field of the patient registration row — pressing Enter there
    // saves the clinical record directly to the database instead of just moving focus on
    // into the next section, so no separate "register patient" step is needed.
    if (e.key === 'Enter' && activeEl?.id === 'eyetest-mobile-input') {
      e.preventDefault();
      handleSaveDraft();
      return;
    }

    const container = document.getElementById('optical-single-form-container') || document.getElementById('optical-step-container');
    if (!container) return;

    // Filter STRICTLY to interactive inputs (exclude wrapper divs, hidden inputs, disabled inputs)
    const rawFocusables = Array.from(container.querySelectorAll('input:not([type="hidden"]):not([disabled]), select:not([disabled])'));
    const focusables = rawFocusables.filter(el => {
      if (el.tabIndex === -1 || el.offsetParent === null) return false;
      if (el.type === 'hidden' || el.getAttribute('aria-hidden') === 'true') return false;
      return true;
    });

    if (focusables.length === 0) return;

    const currentIndex = focusables.indexOf(activeEl);

    // Enter & ArrowRight: Move to Next Adjacent Field
    if (e.key === 'Enter' || e.key === 'ArrowRight') {
      if (e.key === 'ArrowRight' && activeEl && activeEl.tagName === 'INPUT' && (activeEl.type === 'text' || !activeEl.type)) {
        if (activeEl.selectionStart !== null && activeEl.selectionStart < activeEl.value.length) {
          return; // Allow cursor movement inside text
        }
      }

      if (currentIndex >= 0 && currentIndex < focusables.length - 1) {
        e.preventDefault();
        const nextEl = focusables[currentIndex + 1];
        nextEl.focus();
        if (nextEl.select) nextEl.select();
      } else if (currentIndex === focusables.length - 1 && e.key === 'Enter') {
        e.preventDefault();
        if (activeStep < stepsList.length - 1) {
          setActiveStep(prev => prev + 1);
        }
      }
    }

    // ArrowLeft: Move to Previous Field
    else if (e.key === 'ArrowLeft') {
      if (activeEl && activeEl.tagName === 'INPUT' && (activeEl.type === 'text' || !activeEl.type)) {
        if (activeEl.selectionStart !== null && activeEl.selectionStart > 0) {
          return; // Allow cursor movement inside text
        }
      }

      if (currentIndex > 0) {
        e.preventDefault();
        const prevEl = focusables[currentIndex - 1];
        prevEl.focus();
        if (prevEl.select) prevEl.select();
      }
    }

    // ArrowDown: Spatial Navigation to element directly below
    else if (e.key === 'ArrowDown') {
      if (currentIndex >= 0 && activeEl) {
        const currRect = activeEl.getBoundingClientRect();
        const belowCandidates = focusables.filter(el => {
          const r = el.getBoundingClientRect();
          return r.top >= currRect.bottom - 4;
        });

        if (belowCandidates.length > 0) {
          e.preventDefault();
          belowCandidates.sort((a, b) => {
            const rA = a.getBoundingClientRect();
            const rB = b.getBoundingClientRect();
            const distA = Math.hypot((rA.left + rA.width / 2) - (currRect.left + currRect.width / 2), (rA.top - currRect.top));
            const distB = Math.hypot((rB.left + rB.width / 2) - (currRect.left + currRect.width / 2), (rB.top - currRect.top));
            return distA - distB;
          });
          const target = belowCandidates[0];
          target.focus();
          if (target.select) target.select();
        } else if (currentIndex < focusables.length - 1) {
          e.preventDefault();
          const nextEl = focusables[currentIndex + 1];
          nextEl.focus();
          if (nextEl.select) nextEl.select();
        }
      }
    }

    // ArrowUp: Spatial Navigation to element directly above
    else if (e.key === 'ArrowUp') {
      if (currentIndex >= 0 && activeEl) {
        const currRect = activeEl.getBoundingClientRect();
        const aboveCandidates = focusables.filter(el => {
          const r = el.getBoundingClientRect();
          return r.bottom <= currRect.top + 4;
        });

        if (aboveCandidates.length > 0) {
          e.preventDefault();
          aboveCandidates.sort((a, b) => {
            const rA = a.getBoundingClientRect();
            const rB = b.getBoundingClientRect();
            const distA = Math.hypot((rA.left + rA.width / 2) - (currRect.left + currRect.width / 2), (currRect.top - rA.top));
            const distB = Math.hypot((rB.left + rB.width / 2) - (currRect.left + currRect.width / 2), (currRect.top - rB.top));
            return distA - distB;
          });
          const target = aboveCandidates[0];
          target.focus();
          if (target.select) target.select();
        } else if (currentIndex > 0) {
          e.preventDefault();
          const prevEl = focusables[currentIndex - 1];
          prevEl.focus();
          if (prevEl.select) prevEl.select();
        }
      }
    }
  };

  // Handle Keyboard Shortcuts (Alt+N: Next, Alt+P: Prev, Alt+S: Save, Alt+F: Search Patient)
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.altKey && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        if (activeStep < stepsList.length - 1) setActiveStep(prev => prev + 1);
      }
      if (e.altKey && e.key.toLowerCase() === 'p') {
        e.preventDefault();
        if (activeStep > 0) setActiveStep(prev => prev - 1);
      }
      if (e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        setSearchModalOpen(true);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activeStep]);

  // Selecting an existing patient restores their own Patient ID and Test No (assigned when
  // they were first registered) along with their contact/demographic details — Patient ID and
  // Test No are that patient's permanent identifiers, not freshly generated each visit. A
  // brand-new patient (typed in directly, never selected) still gets a fresh auto-generated
  // Patient ID / Test No, since they have no prior record to restore.
  const handleSelectPatient = (selected) => {
    setPatientData(prev => ({
      ...prev,
      ...selected,
      visitNum: `VIS-${Math.floor(100 + Math.random() * 900)}`,
      appointmentNum: `APT-${Math.floor(1000 + Math.random() * 9000)}`
    }));

    // Find this patient's most recent past visit so its ACCP (the Rx they were finally
    // accepted/prescribed) can be carried forward as THIS visit's PGP (previous glasses
    // power) — standard clinical workflow: what was prescribed last time is what they're
    // wearing now. Everything else clinical (UCVA, AR, retinoscopy, ACCP, diagnosis, etc.)
    // starts blank below, ready for fresh findings at this new visit.
    const sId = String(selected?.id || '').toLowerCase().trim();
    const sPhone = String(selected?.phone || '').toLowerCase().trim();
    const lastExam = (pastExaminations || [])
      .filter(e => {
        const eId = String(e.patientId || e.patient_id || '').toLowerCase().trim();
        const ePhone = String(e.phone || '').toLowerCase().trim();
        return (sId && eId && sId === eId) || (sPhone && ePhone && sPhone === ePhone);
      })
      .sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0))[0];
    const lastRx = lastExam?.subjectiveRefraction || {};

    setMedicalHistory(prev => ({
      ...prev,
      pgpOdSph: lastRx?.od?.sph || '',
      pgpOdCyl: lastRx?.od?.cyl || '',
      pgpOdAxis: lastRx?.od?.axis || '',
      pgpOdVa: lastRx?.od?.va || '',
      pgpOdAdd: lastRx?.nearAdd || '',
      pgpOdAddVa: lastRx?.odNv?.va || '',
      pgpOsSph: lastRx?.os?.sph || '',
      pgpOsCyl: lastRx?.os?.cyl || '',
      pgpOsAxis: lastRx?.os?.axis || '',
      pgpOsVa: lastRx?.os?.va || '',
      pgpOsAdd: lastRx?.nearAdd || '',
      pgpOsAddVa: lastRx?.osNv?.va || '',
      previousGlassesDate: lastExam?.date || ''
    }));

    setSubjectiveRefraction({
      od: { sph: '', cyl: '', axis: '', va: '' },
      os: { sph: '', cyl: '', axis: '', va: '' },
      nearAdd: '', pd: '', prism: '', balanceTest: '', fogging: '', duochrome: '', crossCylinder: ''
    });
    setVisualAcuity({
      distance: { odWo: '', odWith: '', osWo: '', osWith: '', odPinhole: '', osPinhole: '' },
      near: { odWo: '', odWith: '', osWo: '', osWith: '' },
      colorVision: 'Normal', contrastSensitivity: 'Normal', dominantEye: 'Right (OD)'
    });
    setObjectiveRefraction({
      autoRefraction: { od: { sph: '', cyl: '', axis: '', va: '', pd: '' }, os: { sph: '', cyl: '', axis: '', va: '', pd: '' } },
      retinoscopy: { od: { sph: '', cyl: '', axis: '', va: '' }, os: { sph: '', cyl: '', axis: '', va: '' } },
      kReading: { odK1: '', odK2: '', osK1: '', osK2: '', cornealRadius: '', streakNotes: '' }
    });
    setEyeHealth({
      anterior: { lids: '', lashes: '', conjunctiva: '', cornea: '', iris: '', lens: '', anteriorChamber: '' },
      posterior: { disc: '', macula: '', retina: '', vessels: '' },
      iop: { od: '', os: '', method: '' },
      cupDiscRatio: { od: '', os: '' },
      dilatedExam: ''
    });
    setPrescription({ selectedLenses: [], frameRecommendation: '', lensRecommendation: '' });
    setDiagnosis(prev => ({
      ...prev,
      testNo: selected?.testNo || '',
      primary: '', icdCode: '', remarks: '', procedure: '', medicine: '', advice: '', nextReview: '', nextReviewDate: '',
      procedureCharge: '0', medicineCharge: '0'
    }));
  };

  // "Start Eye Test" hands a patient/appointment across via navigate() state from either the
  // Appointments page ({ appointment }) or Patient History ({ patient }). Waits for dbPatients
  // to finish loading so a handoff linked to an existing Customer resolves through the normal
  // "restore their own ID/history" path instead of being treated as a brand-new patient.
  useEffect(() => {
    const apt = location.state?.appointment;
    const directPatient = location.state?.patient;
    const editExam = location.state?.editExam;
    if ((!apt && !directPatient && !editExam) || appointmentHandledRef.current || !recordsLoaded) return;
    appointmentHandledRef.current = true;

    // Patient History's per-visit "Edit" button — reload a past exam's full clinical record
    // (not just patient identity, unlike the appointment/direct-patient handoffs below) so
    // corrections save back over the same visit instead of starting a blank new one.
    if (editExam) {
      const raw = editExam.raw_data || {};
      setEditingExamId(editExam.backendId || null);
      setPatientData(prev => ({
        ...prev,
        ...(raw.patientData || {}),
        id: editExam.patientId || raw.patientData?.id || prev.id,
        customerId: editExam.customerId || raw.patientData?.customerId || prev.customerId,
        name: editExam.name || raw.patientData?.name || '',
        phone: editExam.phone || raw.patientData?.phone || '',
        visitNum: editExam.id || prev.visitNum
      }));
      if (editExam.subjectiveRefraction) setSubjectiveRefraction(editExam.subjectiveRefraction);
      if (editExam.medicalHistory) setMedicalHistory(prev => ({ ...prev, ...editExam.medicalHistory }));
      if (raw.diagnosis) {
        setDiagnosis(raw.diagnosis);
      } else {
        setDiagnosis(prev => ({ ...prev, primary: editExam.diagnosis || '', testNo: editExam.testNo || prev.testNo }));
      }
      if (raw.prescription) setPrescription(raw.prescription);
      return;
    }

    if (directPatient) {
      const matched = directPatient.customerId
        ? dbPatients.find(p => p.customerId === directPatient.customerId)
        : null;
      handleSelectPatient(matched || directPatient);
      return;
    }

    const matched = apt.customerId
      ? dbPatients.find(p => p.customerId === apt.customerId)
      : null;

    if (matched) {
      handleSelectPatient(matched);
    } else {
      // The Patient ID/Test No were already assigned (and possibly quoted to the patient) at
      // booking time in Appointments.jsx — use those rather than re-guessing fresh ones here,
      // so what shows up matches what the front desk saw.
      setPatientData(prev => ({
        ...prev,
        id: apt.patientId || getNextPatientId(),
        customerId: apt.customerId || null,
        name: apt.name || '',
        phone: apt.phone || '',
        email: apt.email || '',
        age: apt.age || '',
        gender: apt.gender || 'Male',
        assignedOptometrist: apt.optometrist || '',
        appointmentNum: apt.id || '',
        lastVisitDate: apt.date || ''
      }));
      if (apt.testNo) {
        setDiagnosis(prev => ({ ...prev, testNo: apt.testNo }));
      }
    }
  }, [location.state, recordsLoaded, dbPatients]);

  const handleRegisterNewPatient = (newP) => {
    setPatientData(newP);
    setDbPatients(prev => [newP, ...prev]);
  };

  const handleSaveDraft = async () => {
    if (!patientData?.name || patientData.name.trim() === '') {
      alert("Please enter Patient Name before saving clinical record.");
      return;
    }

    // The Patient ID / Test No fields show auto-generated placeholders (P-1001, "1", ...) until
    // the user types over them, but those display values were never written back into state —
    // so saved records ended up with a blank patient ID / test no. Persist the same auto values
    // now (matching the exact formula SingleScreenEyeTestForm uses to display them).
    const effectivePatientId = patientData?.id || getNextPatientId();
    const effectiveTestNo = diagnosis?.testNo || (pastExaminations?.length + 1).toString();
    if (!patientData?.id) {
      setPatientData(prev => ({ ...prev, id: effectivePatientId }));
    }
    if (!diagnosis?.testNo) {
      setDiagnosis(prev => ({ ...prev, testNo: effectiveTestNo }));
    }

    const examRecord = {
      id: patientData?.visitNum || `VIS-${Math.floor(100 + Math.random() * 900)}`,
      date: new Date().toISOString().split('T')[0],
      testNo: effectiveTestNo,
      patientId: effectivePatientId,
      name: patientData?.name || '',
      phone: patientData?.phone || '',
      age: patientData?.age || '',
      gender: patientData?.gender || '',
      address: patientData?.address || '',
      place: patientData?.place || patientData?.city || '',
      assignedOptometrist: patientData?.assignedOptometrist || '',
      doctor: patientData?.assignedOptometrist || '',
      diagnosis: diagnosis?.primary || 'Routine Refraction',
      procedureCharge: diagnosis?.procedureCharge || '0',
      medicineCharge: diagnosis?.medicineCharge || '0',
      rx: `OD: ${subjectiveRefraction?.od?.sph || ''} SPH / ${subjectiveRefraction?.od?.cyl || ''} CYL @ ${subjectiveRefraction?.od?.axis || ''}° | OS: ${subjectiveRefraction?.os?.sph || ''} SPH / ${subjectiveRefraction?.os?.cyl || ''} CYL @ ${subjectiveRefraction?.os?.axis || ''}°`,
      patientData,
      subjectiveRefraction,
      medicalHistory,
      prescription
    };

    const customerRecord = {
      id: effectivePatientId,
      testNo: effectiveTestNo,
      name: patientData?.name || '',
      phone: patientData?.phone || '',
      email: patientData?.email || '',
      age: patientData?.age || '',
      gender: patientData?.gender || '',
      address: patientData?.address || '',
      place: patientData?.place || patientData?.city || '',
      city: patientData?.place || patientData?.city || '',
      assignedOptometrist: patientData?.assignedOptometrist || '',
      sphRight: subjectiveRefraction?.od?.sph || '',
      cylRight: subjectiveRefraction?.od?.cyl || '',
      axisRight: subjectiveRefraction?.od?.axis || '',
      vaOD: subjectiveRefraction?.od?.va || '',
      sphLeft: subjectiveRefraction?.os?.sph || '',
      cylLeft: subjectiveRefraction?.os?.cyl || '',
      axisLeft: subjectiveRefraction?.os?.axis || '',
      vaOS: subjectiveRefraction?.os?.va || '',
      nearAdd: subjectiveRefraction?.nearAdd || '',
      distancePD: subjectiveRefraction?.pd || '',
      diagnosis: diagnosis?.primary || '',
      hasSpecBooking: true,
      specDetails: {
        bookingId: `SPEC-${Math.floor(1000 + Math.random() * 9000)}`,
        status: 'Booked for Spectacles',
        frameRec: prescription.frameRecommendation || 'RayBan Wayfarer Classic',
        lensRec: prescription.lensRecommendation || '1.56 Blue Cut Anti-Glare Lens'
      }
    };

    // Resolve the real backend Customer this examination belongs to: reuse the link already
    // captured on patientData (set when an existing patient was selected, or once this exact
    // patient has been saved before), fall back to matching by phone, otherwise a fresh
    // Customer gets created below.
    let customerId = patientData?.customerId || null;
    if (!customerId && patientData?.phone) {
      const existingMatch = dbPatients.find(c => c.phone && c.phone === patientData.phone);
      if (existingMatch?.customerId) customerId = existingMatch.customerId;
    }

    // Save locally
    try {
      const existingTests = JSON.parse(localStorage.getItem('optical_eye_tests') || '[]');
      const updatedTests = [examRecord, ...existingTests.filter(t => t.id !== examRecord.id)];
      localStorage.setItem('optical_eye_tests', JSON.stringify(updatedTests));

      const existingCust = JSON.parse(localStorage.getItem('optical_sales_customers') || '[]');
      const updatedCust = [customerRecord, ...existingCust.filter(c => c.id !== customerRecord.id)];
      localStorage.setItem('optical_sales_customers', JSON.stringify(updatedCust));
      
      if (patientData.assignedOptometrist) {
        const localDocs = JSON.parse(localStorage.getItem('optical_doctors') || '[]');
        if (!localDocs.includes(patientData.assignedOptometrist)) {
          const updatedDocs = [...localDocs, patientData.assignedOptometrist];
          localStorage.setItem('optical_doctors', JSON.stringify(updatedDocs));
          setDoctorsList(prev => Array.from(new Set([...prev, patientData.assignedOptometrist])));
        }
      }

      setPastExaminations(updatedTests);
      setDbPatients(updatedCust);
    } catch (e) {}

    // Send to API Database
    try {
      // patient_code (not the app-local "id") is the field the backend Customer model
      // actually keys uniqueness off of — sending it explicitly keeps the human-readable
      // code the UI shows in sync with the one stored server-side, instead of the backend
      // silently minting an unrelated one on every save. Known link -> PATCH the same row;
      // otherwise create it once and remember the real id for every future save.
      const customerApiPayload = { ...customerRecord, id: undefined, patient_code: effectivePatientId };
      try {
        if (customerId) {
          await axios.patch(`/api/sales/customers/${customerId}/`, customerApiPayload);
        } else {
          const res = await axios.post('/api/sales/customers/', customerApiPayload);
          if (res.data?.id) {
            customerId = res.data.id;
            setPatientData(prev => ({ ...prev, customerId }));
          }
        }
      } catch (e) {}

      const dbPayload = {
        customer: customerId || null,
        patient_id: effectivePatientId,
        patient_name: patientData?.name || '',
        age: String(patientData?.age || ''),
        gender: patientData?.gender || '',
        phone: patientData?.phone || '',
        email: patientData?.email || '',
        address: patientData?.address || '',
        occupation: patientData?.occupation || '',
        visit_number: patientData?.visitNum || `VIS-${Math.floor(100 + Math.random() * 900)}`,
        appointment_id: patientData?.appointmentNum || '',
        branch: patientData?.branch || 'Main Branch',
        optometrist: patientData?.assignedOptometrist || '',
        
        complaints: Array.isArray(medicalHistory?.complaints) ? medicalHistory.complaints.join(', ') : (medicalHistory?.complaints || ''),
        complaint_duration: medicalHistory?.complaintDuration || '',
        glasses_usage: medicalHistory?.glassesUsage || '',
        medical_history: Array.isArray(medicalHistory?.systemicConditions) ? medicalHistory.systemicConditions.join(', ') : (medicalHistory?.systemicConditions || ''),
        allergies: medicalHistory?.allergies || '',
        family_history: medicalHistory?.familyHistory || '',

        pgp_od_sph: medicalHistory?.pgpOdSph || '',
        pgp_od_cyl: medicalHistory?.pgpOdCyl || '',
        pgp_od_axis: medicalHistory?.pgpOdAxis || '',
        pgp_od_va: medicalHistory?.pgpOdVa || '',
        pgp_od_add: medicalHistory?.pgpOdAdd || '',
        pgp_od_add_va: medicalHistory?.pgpOdAddVa || '',
        pgp_os_sph: medicalHistory?.pgpOsSph || '',
        pgp_os_cyl: medicalHistory?.pgpOsCyl || '',
        pgp_os_axis: medicalHistory?.pgpOsAxis || '',
        pgp_os_va: medicalHistory?.pgpOsVa || '',
        pgp_os_add: medicalHistory?.pgpOsAdd || '',
        pgp_os_add_va: medicalHistory?.pgpOsAddVa || '',
        previous_glasses_date: medicalHistory?.previousGlassesDate || '',

        sub_sph_od: subjectiveRefraction?.od?.sph || '',
        sub_cyl_od: subjectiveRefraction?.od?.cyl || '',
        sub_axis_od: subjectiveRefraction?.od?.axis || '',
        sub_va_od: subjectiveRefraction?.od?.va || '',
        sub_add_od: subjectiveRefraction?.nearAdd || subjectiveRefraction?.odNv?.sph || '',
        sub_add_va_od: subjectiveRefraction?.odNv?.va || '',
        sub_sph_os: subjectiveRefraction?.os?.sph || '',
        sub_cyl_os: subjectiveRefraction?.os?.cyl || '',
        sub_axis_os: subjectiveRefraction?.os?.axis || '',
        sub_va_os: subjectiveRefraction?.os?.va || '',
        sub_add_os: subjectiveRefraction?.nearAdd || subjectiveRefraction?.osNv?.sph || '',
        sub_add_va_os: subjectiveRefraction?.osNv?.va || '',

        ar_sph_od: objectiveRefraction?.odAr?.sph || '',
        ar_cyl_od: objectiveRefraction?.odAr?.cyl || '',
        ar_axis_od: objectiveRefraction?.odAr?.axis || '',
        ar_sph_os: objectiveRefraction?.osAr?.sph || '',
        ar_cyl_os: objectiveRefraction?.osAr?.cyl || '',
        ar_axis_os: objectiveRefraction?.osAr?.axis || '',

        primary_diagnosis: diagnosis?.primary || 'Routine Refraction',
        rx_summary: `OD: ${subjectiveRefraction?.od?.sph || ''} SPH / ${subjectiveRefraction?.od?.cyl || ''} CYL @ ${subjectiveRefraction?.od?.axis || ''}° | OS: ${subjectiveRefraction?.os?.sph || ''} SPH / ${subjectiveRefraction?.os?.cyl || ''} CYL @ ${subjectiveRefraction?.os?.axis || ''}°`,

        raw_data: examRecord
      };

      if (editingExamId) {
        await axios.patch(`/api/sales/eye-examinations/${editingExamId}/`, dbPayload);
        alert(`Clinical Examination & Prescription for ${patientData.name} (${effectivePatientId}) updated!`);
      } else {
        await axios.post('/api/sales/eye-examinations/', dbPayload);
        alert(`Clinical Examination & Prescription for ${patientData.name} (${effectivePatientId}) saved to database!`);
      }
    } catch (e) {
      console.warn("API database save notice:", e);
      alert(`Saved locally, but syncing "${patientData.name}"'s record to the database failed. Please check your connection and try Save again.`);
    }

    // The saved record now permanently holds effectivePatientId/testNo. Clear those two
    // fields back to blank (rather than a full form reset) so the next patient typed into
    // this same screen gets a freshly auto-generated Patient ID / Test No, instead of the
    // just-saved patient's identifiers sticking around.
    setPatientData(prev => ({ ...prev, id: '', customerId: null }));
    setDiagnosis(prev => ({ ...prev, testNo: '' }));
    setEditingExamId(null);
  };

  const handleNavigateToSales = () => {
    handleSaveDraft();
    navigate('/sales/new', {
      state: {
        patient: patientData,
        prescription: subjectiveRefraction,
        lenses: prescription.selectedLenses
      }
    });
  };

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Module Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <EyeIcon sx={{ fontSize: 36 }} /> Greensol Optical Eye Examination System
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Enterprise Ophthalmic Refraction & Clinical Workflow Manager • Powered by Greensol ERP
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5} flexWrap="wrap">
          <Button 
            variant={layoutMode === 'single' ? 'contained' : 'outlined'} 
            color="primary" 
            onClick={() => setLayoutMode(prev => prev === 'single' ? 'wizard' : 'single')}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 800 }}
          >
            {layoutMode === 'single' ? '📋 Switch to 10-Step Wizard' : '🖥️ Switch to Single-Screen Master View'}
          </Button>

          <Button 
            variant="outlined" 
            color="primary" 
            startIcon={<SearchIcon />} 
            onClick={() => setSearchModalOpen(true)}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
          >
            Smart Patient Search
          </Button>

          <Button 
            variant="outlined" 
            color="secondary" 
            startIcon={<KeyboardIcon />} 
            onClick={() => setShortcutsOpen(true)}
            sx={{ borderRadius: 2, textTransform: 'none' }}
          >
            Shortcuts
          </Button>

          <Button 
            variant={viewMode === 'list' ? 'contained' : 'outlined'} 
            color="inherit" 
            onClick={() => setViewMode(prev => prev === 'list' ? 'form' : 'list')}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 600 }}
          >
            {viewMode === 'list' ? 'Back to Active Exam' : 'Past Visit History Queue'}
          </Button>

          <Button 
            variant="contained" 
            color="success" 
            startIcon={<AddPersonIcon />}
            onClick={handleResetAll}
            sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
          >
            + Start New Examination
          </Button>
        </Stack>
      </Box>

      {viewMode === 'list' ? (
        /* Queue & Visit History View */
        <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
          <Typography variant="h6" fontWeight={800} sx={{ mb: 2 }}>
            Recent Optical Eye Examination Records
          </Typography>
          <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
            <Table>
              <TableHead sx={{ bgcolor: 'action.hover' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 800 }}>Visit ID</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Date</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Patient ID & Name</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Optometrist</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Primary Diagnosis</TableCell>
                  <TableCell sx={{ fontWeight: 800 }}>Prescription Summary</TableCell>
                  <TableCell sx={{ fontWeight: 800, textAlign: 'right' }}>Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {pastExaminations.map((exam) => (
                  <TableRow key={exam.id} hover>
                    <TableCell sx={{ fontWeight: 700 }}>{exam.id}</TableCell>
                    <TableCell>{exam.date}</TableCell>
                    <TableCell>
                      <Typography variant="subtitle2" fontWeight={700}>{exam.name}</Typography>
                      <Typography variant="caption" color="text.secondary">{exam.patientId}</Typography>
                    </TableCell>
                    <TableCell>{exam.doctor}</TableCell>
                    <TableCell><Chip label={exam.diagnosis} size="small" color="primary" variant="outlined" /></TableCell>
                    <TableCell sx={{ fontWeight: 600 }}>{exam.rx}</TableCell>
                    <TableCell align="right">
                      <Stack direction="row" spacing={1} justifyContent="flex-end">
                        <Button size="small" variant="outlined" onClick={() => { setViewMode('form'); setActiveStep(9); }}>
                          View Rx
                        </Button>
                        <Button size="small" variant="contained" color="secondary" onClick={handleNavigateToSales}>
                          POS Bill
                        </Button>
                      </Stack>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </TableContainer>
        </Card>
      ) : layoutMode === 'single' ? (
        /* Single Screen Master ERP Eye Test Form (Matching Uploaded Image 3) */
        <Box id="optical-single-form-container" onKeyDown={handleKeyDownEnter}>
          <SingleScreenEyeTestForm
            patientData={patientData}
            setPatientData={setPatientData}
            medicalHistory={medicalHistory}
            setMedicalHistory={setMedicalHistory}
            visualAcuity={visualAcuity}
            setVisualAcuity={setVisualAcuity}
            objectiveRefraction={objectiveRefraction}
            setObjectiveRefraction={setObjectiveRefraction}
            subjectiveRefraction={subjectiveRefraction}
            setSubjectiveRefraction={setSubjectiveRefraction}
            binocularVision={binocularVision}
            setBinocularVision={setBinocularVision}
            eyeHealth={eyeHealth}
            setEyeHealth={setEyeHealth}
            diagnosis={diagnosis}
            setDiagnosis={setDiagnosis}
            prescription={prescription}
            setPrescription={setPrescription}
            doctorsList={doctorsList}
            onOpenSearchModal={() => setSearchModalOpen(true)}
            onSaveDraft={handleSaveDraft}
            onPrint={() => setActiveStep(9)}
            onClearAll={handleResetAll}
            savedExams={pastExaminations}
            nextPatientId={getNextPatientId()}
            onSelectExamFromHistory={(exam) => {
              if (exam.patientData) setPatientData(exam.patientData);
              if (exam.subjectiveRefraction) setSubjectiveRefraction(exam.subjectiveRefraction);
              if (exam.medicalHistory) setMedicalHistory(exam.medicalHistory);
            }}
          />
        </Box>
      ) : (
        /* Stepper & Live Clinical Workspace Layout */
        <Box>
          {/* Horizontal 10-Step Bar */}
          <ExaminationStepper 
            activeStep={activeStep} 
            setActiveStep={setActiveStep} 
            completedSteps={[]} 
          />

          <Grid container spacing={3}>
            {/* Left 75% Column: Current Step Content */}
            <Grid item xs={12} lg={8.5} id="optical-step-container" onKeyDown={handleKeyDownEnter}>
              {activeStep === 0 && (
                <Step1PatientInfo 
                  patientData={patientData} 
                  setPatientData={setPatientData} 
                  onOpenSearchModal={() => setSearchModalOpen(true)}
                  doctorsList={doctorsList}
                />
              )}

              {activeStep === 1 && (
                <Step2MedicalHistory 
                  medicalHistory={medicalHistory} 
                  setMedicalHistory={setMedicalHistory} 
                />
              )}

              {activeStep === 2 && (
                <Step3VisualAcuity 
                  visualAcuity={visualAcuity} 
                  setVisualAcuity={setVisualAcuity} 
                />
              )}

              {activeStep === 3 && (
                <Step4ObjectiveRefraction 
                  objectiveRefraction={objectiveRefraction} 
                  setObjectiveRefraction={setObjectiveRefraction} 
                />
              )}

              {activeStep === 4 && (
                <Step5SubjectiveRefraction 
                  subjectiveRefraction={subjectiveRefraction} 
                  setSubjectiveRefraction={setSubjectiveRefraction} 
                />
              )}

              {activeStep === 5 && (
                <Step6BinocularVision 
                  binocularVision={binocularVision} 
                  setBinocularVision={setBinocularVision} 
                />
              )}

              {activeStep === 6 && (
                <Step7EyeHealth 
                  eyeHealth={eyeHealth} 
                  setEyeHealth={setEyeHealth} 
                />
              )}

              {activeStep === 7 && (
                <Step8Diagnosis 
                  diagnosis={diagnosis} 
                  setDiagnosis={setDiagnosis} 
                />
              )}

              {activeStep === 8 && (
                <Step9Prescription 
                  subjectiveRefraction={subjectiveRefraction} 
                  prescription={prescription} 
                  setPrescription={setPrescription} 
                />
              )}

              {activeStep === 9 && (
                <PrintPrescriptionCard 
                  patientData={patientData}
                  subjectiveRefraction={subjectiveRefraction}
                  diagnosis={diagnosis}
                  prescription={prescription}
                  medicalHistory={medicalHistory}
                  onNavigateToSales={handleNavigateToSales}
                />
              )}

              {/* Bottom Navigation Buttons */}
              <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 3, pt: 2, borderTop: '1px solid', borderColor: 'divider' }}>
                <Button 
                  disabled={activeStep === 0} 
                  onClick={() => setActiveStep(prev => prev - 1)}
                  variant="outlined" 
                  startIcon={<BackIcon />}
                  sx={{ borderRadius: 2, textTransform: 'none', px: 3 }}
                >
                  Previous Step
                </Button>

                <Box sx={{ display: 'flex', gap: 1.5 }}>
                  <Button 
                    variant="outlined" 
                    color="inherit"
                    onClick={handleSaveDraft}
                    startIcon={<SaveIcon />}
                    sx={{ borderRadius: 2, textTransform: 'none' }}
                  >
                    Save Draft
                  </Button>

                  {activeStep < 9 ? (
                    <Button 
                      variant="contained" 
                      onClick={() => setActiveStep(prev => prev + 1)}
                      endIcon={<NextIcon />}
                      sx={{ borderRadius: 2, textTransform: 'none', px: 3, fontWeight: 700 }}
                    >
                      Next Step
                    </Button>
                  ) : (
                    <Button 
                      variant="contained" 
                      color="success"
                      onClick={() => alert(`Eye Examination completed for ${patientData.name}!`)}
                      startIcon={<PrintIcon />}
                      sx={{ borderRadius: 2, textTransform: 'none', px: 3, fontWeight: 700 }}
                    >
                      Complete & Print Rx
                    </Button>
                  )}
                </Box>
              </Box>
            </Grid>

            {/* Right 25% Column: Sticky Examination Live Summary */}
            <Grid item xs={12} lg={3.5}>
              <ExaminationSummarySidebar
                patientData={patientData}
                medicalHistory={medicalHistory}
                subjectiveRefraction={subjectiveRefraction}
                diagnosis={diagnosis}
                prescription={prescription}
                eyeHealth={eyeHealth}
                activeStep={activeStep}
                setActiveStep={setActiveStep}
                onOpenCompareModal={() => setCompareModalOpen(true)}
                onSaveDraft={handleSaveDraft}
                onPrint={() => setActiveStep(9)}
              />
            </Grid>
          </Grid>
        </Box>
      )}

      {/* Smart Patient Search & Registration Modal */}
      <PatientSearchModal 
        open={searchModalOpen}
        onClose={() => setSearchModalOpen(false)}
        onSelectPatient={handleSelectPatient}
        onRegisterNewPatient={handleRegisterNewPatient}
        dbPatients={dbPatients}
      />

      {/* Prescription Delta Comparison Modal */}
      <RxCompareModal 
        open={compareModalOpen}
        onClose={() => setCompareModalOpen(false)}
        previousRx={{ od: { sph: '-1.00', cyl: '-0.50' }, os: { sph: '-1.25', cyl: '-0.50' }, nearAdd: '+1.00' }}
        currentRx={subjectiveRefraction}
        patientName={patientData.name}
      />

      {/* Keyboard Shortcuts Dialog */}
      <Dialog open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Clinical Keyboard Shortcuts</DialogTitle>
        <DialogContent>
          <Stack spacing={1.5} sx={{ mt: 1 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
              <Typography variant="body2">Next Examination Step</Typography>
              <Chip label="Alt + N" size="small" color="primary" />
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
              <Typography variant="body2">Previous Step</Typography>
              <Chip label="Alt + P" size="small" color="primary" />
            </Box>
            <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
              <Typography variant="body2">Smart Patient Search</Typography>
              <Chip label="Alt + F" size="small" color="primary" />
            </Box>
          </Stack>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setShortcutsOpen(false)} variant="contained">Close</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
