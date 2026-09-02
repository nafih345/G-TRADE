import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import {
  Box, Card, CardContent, Typography, Button, Grid,
  Paper, Chip, TextField, Stack, IconButton, Avatar,
  Divider, InputAdornment, Tabs, Tab, Alert, Table,
  TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip,
  Dialog, DialogContent, LinearProgress
} from '@mui/material';
import {
  History as HistoryIcon,
  Search as SearchIcon,
  Person as PersonIcon,
  Visibility as EyeIcon,
  CalendarMonth as CalendarIcon,
  LocalSee as SpecIcon,
  Receipt as InvoiceIcon,
  MedicalServices as MedicalIcon,
  Add as AddIcon,
  Print as PrintIcon,
  Edit as EditIcon,
  Close as CloseIcon,
  TrendingUp as ProgressionIcon,
  CheckCircle as ActiveIcon,
  Warning as AlertIcon,
  ArrowForward as ArrowIcon,
  Phone as PhoneIcon,
  Badge as BadgeIcon,
  FilterList as FilterIcon,
  DeleteSweep as ClearIcon,
  DeleteOutline as DeleteIcon,
  Assignment as RxIcon,
  Notes as NotesIcon,
  ReceiptLong as BillIcon,
  Science as LabIcon,
  Payments as PaymentsIcon
} from '@mui/icons-material';
import PrintPrescriptionCard from '../components/optical/PrintPrescriptionCard';

// Patient IDs are generated client-side and aren't guaranteed globally unique (two different
// patients can end up with the same "P-1003" from separate sessions) — so a plain `p.id` isn't
// safe to use as a selection/React key on its own, or selecting one patient also highlights
// every other patient sharing that id. Combine id+phone+name so each directory row has a truly
// distinct key even when their displayed Patient ID collides.
const getPatientKey = (p) => `${p?.id || ''}|${p?.phone || ''}|${p?.name || ''}`.toLowerCase();

// A real backend Customer/Appointment id is a UUID; human-readable "P-1001" codes never
// look like one — used to tell a real backend link apart from a locally-generated placeholder.
const isBackendId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

// Normalizes the handful of shapes patient identity shows up in across this page (a merged
// customer record, a raw eye-examination record, a plain localStorage fallback record) down to
// one {id, phone, name} triple, so matching "is this the same person" is a single implementation
// instead of the same three-way id/phone/name comparison copy-pasted at every call site.
const personKeyFields = (o) => ({
  id: String(o?.id || o?.patientId || o?.patient_id || o?.patient_code || '').toLowerCase().trim(),
  phone: String(o?.phone || '').toLowerCase().trim(),
  name: String(o?.name || o?.patient_name || '').toLowerCase().trim()
});

const samePerson = (a, b) => {
  const A = personKeyFields(a);
  const B = personKeyFields(b);
  const matchId = A.id && B.id && A.id === B.id;
  const matchPhone = A.phone && B.phone && A.phone !== 'no mobile' && A.phone === B.phone;
  const matchName = A.name && B.name && (A.name.includes(B.name) || B.name.includes(A.name));
  return matchId || matchPhone || matchName;
};

// Invoice / payment / appointment records key their patient link a few different ways depending
// on where they came from: a real backend row carries the Customer UUID in `customer`, while a
// localStorage fallback record only has a denormalized name/phone snapshot. Resolve both here so
// billing history matches the same patient the exam history does.
const billingRecordMatchesPatient = (rec, patient) => {
  if (!rec || !patient) return false;
  const uuid = String(rec.customer || rec.customerId || rec.customer_id || '').toLowerCase().trim();
  if (uuid && patient.customerId && uuid === String(patient.customerId).toLowerCase().trim()) return true;
  const custStr = typeof rec.customer === 'string' && !isBackendId(rec.customer) ? rec.customer : '';
  return samePerson({
    id: rec.patient_code || rec.patientId || rec.patient_id || '',
    phone: rec.phone || rec.customer_phone || rec.customerPhone || '',
    name: rec.customer_name || rec.customerName || rec.patient_name || rec.name || custStr
  }, patient);
};

// `status` is overloaded across the two invoice shapes: a backend Invoice uses it for the PAYMENT
// state (PAID/PARTIAL/UNPAID/...) and keeps the lab/fulfillment stage in `fulfillment_status`,
// while a local order record uses `status` for the lab stage and `payment` for the payment state.
const PAYMENT_STATUS_WORDS = ['paid', 'unpaid', 'partial', 'partially paid', 'draft', 'cancelled'];
const invoiceTotal = (inv) => parseFloat(inv.net_amount || inv.total_amount || inv.total || inv.amount || 0) || 0;
const invoicePaid = (inv) => parseFloat(inv.paid_amount ?? inv.paidAmount ?? 0) || 0;
const invoiceLabStatus = (inv) => {
  if (inv.fulfillment_status) return inv.fulfillment_status;
  const s = String(inv.status || '').trim();
  if (s && !PAYMENT_STATUS_WORDS.includes(s.toLowerCase())) return s;
  return '';
};
const invoicePaymentStatus = (inv) => {
  if (inv.payment) return inv.payment;
  const s = String(inv.status || '').trim();
  if (s && PAYMENT_STATUS_WORDS.includes(s.toLowerCase())) return s;
  const total = invoiceTotal(inv);
  const paid = invoicePaid(inv);
  if (paid <= 0) return 'Unpaid';
  return paid + 0.01 >= total ? 'Paid' : 'Partial';
};
const recordDate = (rec) => rec.invoice_date || rec.payment_date || rec.appointment_date || rec.date ||
  (typeof rec.created_at === 'string' ? rec.created_at.split('T')[0] : '') || '';

export default function PatientHistory() {
  const navigate = useNavigate();
  const location = useLocation();

  // State Definitions
  const [patients, setPatients] = useState([]);
  const [examinations, setExaminations] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [payments, setPayments] = useState([]);
  const [appointments, setAppointments] = useState([]);
  const [selectedPatientId, setSelectedPatientId] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterRisk, setFilterRisk] = useState('ALL');
  const [activeTab, setActiveTab] = useState(0);


  // Fetch Database Records (Patients & Past Eye Exams)
  useEffect(() => {
    const fetchDatabaseRecords = async () => {
      let custPool = [];
      let examPool = [];

      try {
        const localCust = JSON.parse(localStorage.getItem('optical_sales_customers') || '[]');
        const localExams = JSON.parse(localStorage.getItem('optical_eye_tests') || '[]');
        custPool = [...localCust];
        examPool = [...localExams];
      } catch (e) {}

      try {
        const resCust = await axios.get('/api/sales/customers/');
        const custData = resCust.data?.results || resCust.data || [];
        if (Array.isArray(custData)) {
          custPool = [...custPool, ...custData];
        }
      } catch (e) {}

      try {
        const resExams = await axios.get('/api/sales/eye-examinations/');
        const examData = resExams.data?.results || resExams.data || [];
        if (Array.isArray(examData)) {
          examPool = [...examPool, ...examData];
        }
      } catch (e) {}

      // Normalize every examination object to unify flat and nested field access
      const normalizedExams = examPool.map(item => {
        const raw = item.raw_data || {};
        const subRef = item.subjectiveRefraction || raw.subjectiveRefraction || item.subRefraction || {};
        const subOd = subRef.od || item.od || {};
        const subOs = subRef.os || item.os || {};
        const medHist = item.medicalHistory || raw.medicalHistory || {};

        const sphOD = (item.sub_sph_od !== undefined && item.sub_sph_od !== null && item.sub_sph_od !== '') ? item.sub_sph_od : (subOd.sph || item.sphRight || raw.sphRight || '');
        const cylOD = (item.sub_cyl_od !== undefined && item.sub_cyl_od !== null && item.sub_cyl_od !== '') ? item.sub_cyl_od : (subOd.cyl || item.cylRight || raw.cylRight || '');
        const axisOD = (item.sub_axis_od !== undefined && item.sub_axis_od !== null && item.sub_axis_od !== '') ? item.sub_axis_od : (subOd.axis || item.axisRight || raw.axisRight || '');
        const vaOD = (item.sub_va_od !== undefined && item.sub_va_od !== null && item.sub_va_od !== '') ? item.sub_va_od : (subOd.va || item.vaOD || raw.vaOD || '');

        const sphOS = (item.sub_sph_os !== undefined && item.sub_sph_os !== null && item.sub_sph_os !== '') ? item.sub_sph_os : (subOs.sph || item.sphLeft || raw.sphLeft || '');
        const cylOS = (item.sub_cyl_os !== undefined && item.sub_cyl_os !== null && item.sub_cyl_os !== '') ? item.sub_cyl_os : (subOs.cyl || item.cylLeft || raw.cylLeft || '');
        const axisOS = (item.sub_axis_os !== undefined && item.sub_axis_os !== null && item.sub_axis_os !== '') ? item.sub_axis_os : (subOs.axis || item.axisLeft || raw.axisLeft || '');
        const vaOS = (item.sub_va_os !== undefined && item.sub_va_os !== null && item.sub_va_os !== '') ? item.sub_va_os : (subOs.va || item.vaOS || raw.vaOS || '');

        const nearAdd = item.sub_add_od || item.sub_add_os || subRef.nearAdd || subRef.add || item.nearAdd || item.add || raw.nearAdd || '';
        const distancePD = item.distance_pd || subRef.pd || item.distancePD || item.pd || raw.distancePD || raw.pd || '';
        const diagnosis = item.primary_diagnosis || item.diagnosis || raw.diagnosis || '';
        const optometrist = item.optometrist || item.doctor || raw.doctor || '';

        return {
          ...item,
          ...raw,
          // The display `id` below prefers visit_number (human-readable, e.g. "VIS-123") over
          // the real backend EyeExamination UUID — so the true UUID is preserved separately
          // here, otherwise editing and re-saving this exam would have no way to PATCH the
          // original row and would silently create a duplicate instead.
          backendId: isBackendId(item.id) ? item.id : null,
          id: item.visit_number || item.id || raw.id || `VIS-${Math.floor(100 + Math.random() * 900)}`,
          date: item.examination_date ? item.examination_date.split('T')[0] : (item.date || raw.date || new Date().toISOString().split('T')[0]),
          patientId: item.patient_id || item.patientId || raw.patientId || '',
          phone: item.phone || raw.phone || '',
          name: item.patient_name || item.name || raw.name || '',
          optometrist: optometrist,
          doctor: optometrist,
          assignedOptometrist: optometrist,
          diagnosis: diagnosis,
          sphRight: sphOD,
          cylRight: cylOD,
          axisRight: axisOD,
          vaOD: vaOD,
          sphLeft: sphOS,
          cylLeft: cylOS,
          axisLeft: axisOS,
          vaOS: vaOS,
          nearAdd: nearAdd,
          distancePD: distancePD,
          pd: distancePD,
          od: { sph: sphOD, cyl: cylOD, axis: axisOD, va: vaOD },
          os: { sph: sphOS, cyl: cylOS, axis: axisOS, va: vaOS },
          subjectiveRefraction: {
            od: { sph: sphOD, cyl: cylOD, axis: axisOD, va: vaOD },
            os: { sph: sphOS, cyl: cylOS, axis: axisOS, va: vaOS },
            nearAdd: nearAdd,
            pd: distancePD
          },
          medicalHistory: {
            complaints: item.complaints || medHist.complaints || '',
            medical_history: item.medical_history || medHist.medical_history || '',
            allergies: item.allergies || medHist.allergies || '',
            pgpOdSph: item.pgp_od_sph || medHist.pgpOdSph || '',
            pgpOdCyl: item.pgp_od_cyl || medHist.pgpOdCyl || '',
            pgpOdAxis: item.pgp_od_axis || medHist.pgpOdAxis || '',
            pgpOdVa: item.pgp_od_va || medHist.pgpOdVa || '',
            pgpOsSph: item.pgp_os_sph || medHist.pgpOsSph || '',
            pgpOsCyl: item.pgp_os_cyl || medHist.pgpOsCyl || '',
            pgpOsAxis: item.pgp_os_axis || medHist.pgpOsAxis || '',
            pgpOsVa: item.pgp_os_va || medHist.pgpOsVa || '',
          }
        };
      });

      // Extract patient profiles from all eye examination records as well. Note: e.id here is
      // the EXAM/visit id (VIS-xxx), not a patient id — falling back to it (as this used to)
      // made a patient with a missing patientId look like a completely different person from
      // their other visits. Leave id blank instead; the dedup step below assigns/reuses one.
      normalizedExams.forEach(e => {
        if (e.name || e.patient_name || e.phone || e.patientId) {
          custPool.push({
            id: e.patientId || e.patient_id || '',
            name: e.name || e.patient_name || 'Patient',
            phone: e.phone || '',
            email: e.email || '',
            age: e.age || '30',
            gender: e.gender || 'Male',
            occupation: e.occupation || 'Standard',
            hasDiabetes: e.hasDiabetes || false,
            hasSpecBooking: true,
            specDetails: e.specDetails || null
          });
        }
      });

      try {
        const localPatients = JSON.parse(localStorage.getItem('optical_patients') || '[]');
        custPool = [...custPool, ...localPatients];
      } catch (e) {}

      // Deduplicate and aggregate patient records. A real phone number is a far more reliable
      // "same person" signal than id — id can be missing/malformed on older records (see note
      // above) — so group by phone first when one is present. Without a phone, id alone isn't
      // safe either (two different patients with no phone on file can still collide on id), so
      // fall back to id+name together — that keeps genuinely different people apart while still
      // merging true duplicates (same id AND same name).
      const looksLikePatientId = (id) => /^p-?\d/i.test(String(id || '').trim());
      const uniqueCustMap = new Map();
      custPool.forEach(c => {
        if (!c || (!c.name && !c.phone && !c.id)) return;
        // Customers fetched from the backend key their id as a UUID and carry the human-readable
        // "P-1001" code separately in patient_code — resolve whichever field actually looks like
        // a Patient ID rather than falling straight to a freshly generated placeholder.
        const humanId = looksLikePatientId(c.id)
          ? c.id
          : (looksLikePatientId(c.patient_code) ? c.patient_code : null);
        const backendId = isBackendId(c.id) ? c.id : (c.customerId || null);
        const phoneKey = c.phone && c.phone !== 'No Mobile' ? `phone:${String(c.phone).trim().toLowerCase()}` : '';
        const key = phoneKey || `${String(humanId || c.id || '').toLowerCase().trim()}::${String(c.name || '').toLowerCase().trim()}`;
        if (!uniqueCustMap.has(key)) {
          uniqueCustMap.set(key, {
            id: humanId || `P-${1000 + uniqueCustMap.size + 1}`,
            customerId: backendId,
            name: c.name || c.patient_name || 'Patient',
            phone: c.phone || 'No Mobile',
            email: c.email || '',
            age: c.age || '30',
            gender: c.gender || 'Male',
            occupation: c.occupation || 'Standard',
            hasDiabetes: c.hasDiabetes || false,
            hasSpecBooking: c.hasSpecBooking || true,
            specDetails: c.specDetails || null
          });
        } else {
          const existing = uniqueCustMap.get(key);
          if (c.phone && c.phone !== 'No Mobile' && (!existing.phone || existing.phone === 'No Mobile')) existing.phone = c.phone;
          if (c.email && !existing.email) existing.email = c.email;
          if (c.age && !existing.age) existing.age = c.age;
          if (c.gender && !existing.gender) existing.gender = c.gender;
          // Upgrade to a real Patient ID if the one on file so far was just a generated fallback
          if (humanId && !looksLikePatientId(existing.id)) existing.id = humanId;
          if (backendId && !existing.customerId) existing.customerId = backendId;
        }
      });

      const allCust = Array.from(uniqueCustMap.values());

      const uniqueExams = Array.from(new Map(normalizedExams.map(e => [String(e.id || `${e.patientId}-${e.date}`).toLowerCase(), e])).values());

      // This page is specifically an exam-history directory, not a general patient list — a
      // patient who has only booked an appointment (no eye exam completed yet) shouldn't show
      // up here with an empty history. Keep only patients with at least one completed exam,
      // matched by phone (most reliable) or Patient ID.
      const examPhones = new Set(uniqueExams.map(e => String(e.phone || '').trim().toLowerCase()).filter(Boolean));
      const examPatientIds = new Set(uniqueExams.map(e => String(e.patientId || '').trim().toLowerCase()).filter(Boolean));
      const uniqueCust = allCust.filter(p => {
        const phone = String(p.phone || '').trim().toLowerCase();
        const id = String(p.id || '').trim().toLowerCase();
        return (phone && phone !== 'no mobile' && examPhones.has(phone)) || (id && examPatientIds.has(id));
      });

      setPatients(uniqueCust);
      setExaminations(uniqueExams);

      // Pre-select patient if passed in location state or auto-select first
      if (location.state?.patientId) {
        const match = uniqueCust.find(p => String(p.id).toLowerCase() === String(location.state.patientId).toLowerCase());
        if (match) setSelectedPatientId(getPatientKey(match));
        else if (uniqueCust.length > 0) setSelectedPatientId(getPatientKey(uniqueCust[0]));
      } else if (uniqueCust.length > 0) {
        setSelectedPatientId(getPatientKey(uniqueCust[0]));
      }
    };

    fetchDatabaseRecords();
  }, [location.state]);

  // Fetch billing / lab / appointment records so the selected patient's 360° history can also
  // show their previous invoices, payments, lab job status, and visit notes — not just eye exams.
  useEffect(() => {
    const fetchBillingRecords = async () => {
      const unwrap = (res) => (res && res.data && res.data.results) || (res && res.data) || [];
      let invPool = [];
      let payPool = [];
      let apptPool = [];

      try {
        invPool = JSON.parse(localStorage.getItem('optical_sales_invoices') || '[]');
        payPool = [
          ...JSON.parse(localStorage.getItem('optical_payments') || '[]'),
          ...JSON.parse(localStorage.getItem('optical_sales_payments') || '[]')
        ];
        apptPool = JSON.parse(localStorage.getItem('optical_appointments') || '[]');
      } catch (e) {}

      try {
        const [invRes, payRes, apptRes] = await Promise.all([
          axios.get('/api/sales/invoices/').catch(() => null),
          axios.get('/api/sales/payments/').catch(() => null),
          axios.get('/api/sales/appointments/').catch(() => null)
        ]);
        invPool = [...invPool, ...unwrap(invRes)];
        payPool = [...payPool, ...unwrap(payRes)];
        apptPool = [...apptPool, ...unwrap(apptRes)];
      } catch (e) {}

      // Dedup by id (backend rows and their localStorage mirror share the same id where saved)
      const dedup = (arr) => Array.from(
        new Map(arr.filter(Boolean).map(r => [String(r.id || r.receipt_no || r.invoice_number || Math.random()), r])).values()
      );

      setInvoices(dedup(invPool));
      setPayments(dedup(payPool));
      setAppointments(dedup(apptPool));
    };

    fetchBillingRecords();
  }, []);

  // Filtered Patients List
  const filteredPatients = patients.filter(p => {
    const q = searchQuery.toLowerCase();
    const matchesQuery = (p.name || '').toLowerCase().includes(q) ||
                         (p.phone || '').includes(q) ||
                         (p.id || '').toLowerCase().includes(q) ||
                         (p.email || '').toLowerCase().includes(q);
    
    if (filterRisk === 'DIABETES') return matchesQuery && p.hasDiabetes;
    if (filterRisk === 'SPECS') return matchesQuery && p.hasSpecBooking;
    return matchesQuery;
  });

  const selectedPatient = patients.find(p => getPatientKey(p) === String(selectedPatientId || ''));

  // Get all past examinations for selected patient
  const rawPatientExams = selectedPatient
    ? examinations.filter(e => samePerson(e, selectedPatient))
    : [];

  const patientExams = rawPatientExams;

  // Every prescription this patient has ever been given — one row per eye-exam visit, pulling the
  // final subjective refraction plus near-add / PD / diagnosis for each.
  const patientPrescriptions = patientExams.map((exam, index) => ({
    key: exam.id || index,
    exam,
    date: exam.date || '—',
    optometrist: exam.assignedOptometrist || exam.optometrist || '—',
    od: {
      sph: exam.sphRight || exam.od?.sph || '—',
      cyl: exam.cylRight || exam.od?.cyl || '—',
      axis: exam.axisRight || exam.od?.axis || '—',
      va: exam.vaOD || exam.od?.va || '—',
      add: exam.sub_add_od || exam.nearAdd || '—'
    },
    os: {
      sph: exam.sphLeft || exam.os?.sph || '—',
      cyl: exam.cylLeft || exam.os?.cyl || '—',
      axis: exam.axisLeft || exam.os?.axis || '—',
      va: exam.vaOS || exam.os?.va || '—',
      add: exam.sub_add_os || exam.nearAdd || '—'
    },
    nearAdd: exam.nearAdd || '—',
    pd: exam.distancePD || exam.pd || '',
    diagnosis: exam.diagnosis || exam.primary_diagnosis || '',
    rxSummary: exam.rx_summary || exam.raw_data?.rxSummary || ''
  }));

  // Consolidated per-visit clinical notes (complaints, history, diagnosis, recommendations,
  // follow-up) drawn from each eye-exam record, plus any front-desk appointment notes.
  const patientVisitNotes = patientExams.map((exam, index) => {
    const mh = exam.medicalHistory || {};
    return {
      key: exam.id || `exam-${index}`,
      type: 'Eye Examination',
      date: exam.date || '—',
      optometrist: exam.assignedOptometrist || exam.optometrist || '—',
      fields: [
        ['Chief Complaints', exam.complaints || mh.complaints],
        ['Complaint Duration', exam.complaint_duration || exam.raw_data?.complaintDuration],
        ['Glasses Usage', exam.glasses_usage || exam.raw_data?.glassesUsage],
        ['Medical History', exam.medical_history || mh.medical_history],
        ['Allergies', exam.allergies || mh.allergies],
        ['Family History', exam.family_history || exam.raw_data?.familyHistory],
        ['Primary Diagnosis', exam.diagnosis || exam.primary_diagnosis],
        ['Rx / Advice Summary', exam.rx_summary || exam.raw_data?.rxSummary],
        ['Contact Lens Advice', exam.cl_recommend || exam.raw_data?.clRecommend],
        ['Lens Recommendation', [exam.rec_lens_brand, exam.rec_lens_type, exam.rec_lens_coating].filter(Boolean).join(' ')],
        ['Frame Recommendation', [exam.rec_frame_brand, exam.rec_frame_shape, exam.rec_frame_color].filter(Boolean).join(' ')],
        ['Follow-up Date', exam.follow_up_date],
        ['Follow-up Interval', exam.follow_up_interval]
      ].filter(([, v]) => v && String(v).trim() && String(v).trim() !== '—')
    };
  });

  const patientAppointmentNotes = appointments
    .filter(a => billingRecordMatchesPatient(a, selectedPatient))
    .map((a, index) => ({
      key: a.id || `appt-${index}`,
      type: 'Appointment',
      date: a.appointment_date || a.date || '—',
      time: a.appointment_time || '',
      doctor: a.doctor || '—',
      status: a.status || '',
      appointmentType: a.appointment_type || '',
      notes: a.notes || ''
    }))
    .filter(a => a.notes || a.appointmentType || a.status);

  // Previous invoices & the payment receipts booked against them.
  const patientInvoices = invoices
    .filter(inv => billingRecordMatchesPatient(inv, selectedPatient))
    .map((inv, index) => {
      const total = invoiceTotal(inv);
      const paid = invoicePaid(inv);
      return {
        key: inv.id || `inv-${index}`,
        raw: inv,
        number: inv.invoice_number || inv.invoiceNumber || inv.id || `INV-${index + 1}`,
        date: recordDate(inv) || '—',
        total,
        paid,
        balance: Math.max(0, total - paid),
        paymentStatus: invoicePaymentStatus(inv),
        labStatus: invoiceLabStatus(inv),
        method: inv.payment_method || inv.paymentMethod || '',
        frame: inv.frame || inv.frame_name || '',
        lens: inv.lens || inv.lens_name || '',
        items: Array.isArray(inv.items) ? inv.items : []
      };
    })
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const patientPayments = payments
    .filter(p => billingRecordMatchesPatient(p, selectedPatient))
    .map((p, index) => ({
      key: p.id || p.receipt_no || `pay-${index}`,
      receiptNo: p.receipt_no || p.receiptNo || p.id || '—',
      date: recordDate(p) || '—',
      amount: parseFloat(p.amount || 0) || 0,
      method: p.method || p.payment_method || p.paymentMethod || '—',
      status: p.status || 'Completed',
      invoiceRef: p.invoice || p.invoiceNumber || '',
      notes: p.notes || ''
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const totalBilled = patientInvoices.reduce((s, i) => s + i.total, 0);
  const totalPaid = patientInvoices.reduce((s, i) => s + i.paid, 0);
  const totalOutstanding = Math.max(0, totalBilled - totalPaid);

  // Lab / fulfillment jobs — the subset of invoices that have a lab pipeline stage or dispensed
  // frame/lens items to track.
  const LAB_STAGES = ['Order Received', 'In Lab Processing', 'Frame Mounting', 'Quality Control', 'Ready for Collection', 'Delivered'];
  const patientLabOrders = patientInvoices.filter(i => i.labStatus || i.frame || i.lens);

  const handleStartExamForPatient = () => {
    if (!selectedPatient) return;
    navigate('/optical/eyetest', {
      state: {
        patient: selectedPatient
      }
    });
  };

  const [printingExam, setPrintingExam] = useState(null);

  const handleEditExam = (exam) => {
    navigate('/optical/eyetest', {
      state: { editExam: exam }
    });
  };

  const handleBookAptForPatient = () => {
    if (!selectedPatient) return;
    navigate('/optical/appointment', {
      state: {
        patient: selectedPatient
      }
    });
  };

  const [deletingKey, setDeletingKey] = useState(null);

  // Permanently removes one patient: their backend Customer row, every eye examination linked
  // to them (both are soft-deleted server-side via BaseUUIDModel, mirroring how every other
  // delete in this app works), and any locally-cached fallback records — otherwise a stale
  // localStorage copy or an orphaned exam record would just resurrect the same patient into
  // this directory on the next refresh.
  const handleDeletePatient = async (patient, event) => {
    event.stopPropagation();
    if (!window.confirm(`Permanently delete ${patient.name || 'this patient'} (${patient.id}) and all their eye examination history? This cannot be undone.`)) {
      return;
    }

    const pKey = getPatientKey(patient);
    setDeletingKey(pKey);

    const examsToDelete = examinations.filter(ex => samePerson(ex, patient));

    try {
      await Promise.all(
        examsToDelete
          .filter(ex => ex.backendId)
          .map(ex => axios.delete(`/api/sales/eye-examinations/${ex.backendId}/`).catch(() => {}))
      );

      if (isBackendId(patient.customerId)) {
        await axios.delete(`/api/sales/customers/${patient.customerId}/`).catch(() => {});
      }

      const remainingPatients = patients.filter(p => getPatientKey(p) !== pKey);
      const remainingExams = examinations.filter(ex => !samePerson(ex, patient));

      setPatients(remainingPatients);
      setExaminations(remainingExams);
      setSelectedPatientId(prev =>
        prev === pKey
          ? (remainingPatients.length > 0 ? getPatientKey(remainingPatients[0]) : null)
          : prev
      );

      try {
        ['optical_patients', 'optical_sales_customers'].forEach(key => {
          const list = JSON.parse(localStorage.getItem(key) || '[]');
          localStorage.setItem(key, JSON.stringify(list.filter(rec => !samePerson(rec, patient))));
        });
        const localExams = JSON.parse(localStorage.getItem('optical_eye_tests') || '[]');
        localStorage.setItem('optical_eye_tests', JSON.stringify(localExams.filter(ex => !samePerson(ex, patient))));
      } catch (e) {}
    } finally {
      setDeletingKey(null);
    }
  };

  const handleClearAllPatientData = () => {
    if (!window.confirm('This will permanently remove all patient records, appointments, and eye exam history stored in this browser. Continue?')) {
      return;
    }
    ['optical_patients', 'optical_appointments', 'optical_sales_customers', 'optical_eye_tests'].forEach(key => {
      localStorage.removeItem(key);
    });
    window.location.reload();
  };

  return (
    <Box sx={{ p: 3, pb: 8 }}>
      {/* Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <HistoryIcon sx={{ fontSize: 36 }} /> Patient Clinical History & 360° Vision Profile
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Two-panel split workspace: past eye tests, refraction progression, all previous prescriptions, visit notes, invoices &amp; payments, and lab order status
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5}>
          <Button
            variant="outlined"
            color="error"
            startIcon={<ClearIcon />}
            onClick={handleClearAllPatientData}
            sx={{ borderRadius: 2.5, px: 2.5, textTransform: 'none', fontWeight: 700 }}
          >
            Clear All Patient Data
          </Button>
          {selectedPatient && (
            <Button
              variant="contained"
              startIcon={<AddIcon />}
              onClick={handleStartExamForPatient}
              sx={{ backgroundColor: '#2563EB', borderRadius: 2.5, px: 2.5, textTransform: 'none', fontWeight: 700 }}
            >
              Start Eye Test for {selectedPatient.name.split(' ')[0]}
            </Button>
          )}
        </Stack>
      </Box>

      {/* Main 2-Panel Split Workspace */}
      <Grid container spacing={3}>
        {/* Left 35% Panel: Patient Directory & Search */}
        <Grid item xs={12} md={4.2} lg={3.8}>
          <Card variant="outlined" sx={{ borderRadius: 3.5, height: 'calc(100vh - 180px)', display: 'flex', flexDirection: 'column' }}>
            {/* Search Header */}
            <Box sx={{ p: 2.5, borderBottom: '1px solid', borderColor: 'divider', bgcolor: 'action.hover' }}>
              <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
                <PersonIcon color="primary" fontSize="small" /> Clinical Patient Directory ({filteredPatients.length})
              </Typography>

              <TextField
                fullWidth
                size="small"
                placeholder="Search by Name, Mobile, or Patient ID..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                InputProps={{
                  startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 18 }} />,
                  sx: { borderRadius: 2, bgcolor: 'background.paper' }
                }}
              />

              {/* Quick Filter Chips */}
              <Box sx={{ mt: 1.5, display: 'flex', gap: 0.8, flexWrap: 'wrap' }}>
                <Chip 
                  label="All" 
                  size="small" 
                  color={filterRisk === 'ALL' ? 'primary' : 'default'} 
                  onClick={() => setFilterRisk('ALL')}
                  sx={{ fontWeight: 700, fontSize: '0.7rem' }}
                />
                <Chip 
                  label="Diabetic Alert" 
                  size="small" 
                  color={filterRisk === 'DIABETES' ? 'warning' : 'default'} 
                  onClick={() => setFilterRisk(filterRisk === 'DIABETES' ? 'ALL' : 'DIABETES')}
                  sx={{ fontWeight: 700, fontSize: '0.7rem' }}
                />
                <Chip 
                  label="Spectacle Buyers" 
                  size="small" 
                  color={filterRisk === 'SPECS' ? 'secondary' : 'default'} 
                  onClick={() => setFilterRisk(filterRisk === 'SPECS' ? 'ALL' : 'SPECS')}
                  sx={{ fontWeight: 700, fontSize: '0.7rem' }}
                />
              </Box>
            </Box>

            {/* Patients Scrollable Directory List */}
            <Box sx={{ flexGrow: 1, overflowY: 'auto', p: 1.5 }}>
              {filteredPatients.length === 0 ? (
                <Box sx={{ p: 4, textAlign: 'center', color: 'text.secondary' }}>
                  <Typography variant="subtitle2" fontWeight={700}>No Patients Found</Typography>
                  <Typography variant="caption">All database records are blank or no patient matches your search filter.</Typography>
                </Box>
              ) : (
                filteredPatients.map((p) => {
                  const pKey = getPatientKey(p);
                  const isSelected = pKey === String(selectedPatientId || '');
                  const rawCount = examinations.filter(e => samePerson(e, p)).length;
                  const countExams = rawCount > 0 ? rawCount : 1;

                  return (
                    <Paper
                      key={pKey}
                      elevation={0}
                      onClick={() => setSelectedPatientId(pKey)}
                      sx={{
                        p: 1.8,
                        mb: 1.2,
                        borderRadius: 2.5,
                        cursor: 'pointer',
                        border: '1.5px solid',
                        borderColor: isSelected ? 'primary.main' : 'divider',
                        bgcolor: isSelected ? 'rgba(37, 99, 235, 0.05)' : 'background.paper',
                        transition: 'all 0.2s ease',
                        '&:hover': { borderColor: 'primary.main', transform: 'translateY(-1px)' }
                      }}
                    >
                      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                        <Avatar sx={{ bgcolor: isSelected ? 'primary.main' : 'action.selected', color: isSelected ? '#fff' : 'text.primary', width: 40, height: 40, fontWeight: 800 }}>
                          {p.name ? p.name.charAt(0).toUpperCase() : 'P'}
                        </Avatar>

                        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
                          <Typography variant="subtitle2" fontWeight={800} noWrap color={isSelected ? 'primary.main' : 'text.primary'}>
                            {p.name || 'Unregistered Patient'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary" display="block">
                            📞 {p.phone || 'No Mobile'}
                          </Typography>
                          <Typography variant="caption" color="text.secondary">
                            {p.id || 'P-100'} • {p.age || '30'} Yrs • {p.gender || 'Male'}
                          </Typography>
                        </Box>

                        <Stack alignItems="flex-end" spacing={0.5}>
                          <Chip
                            label={`${countExams} ${countExams === 1 ? 'Exam' : 'Exams'}`}
                            size="small"
                            color={countExams > 0 ? 'primary' : 'default'}
                            variant="outlined"
                            sx={{ height: 20, fontSize: '0.65rem', fontWeight: 800 }}
                          />
                          {isSelected && <ActiveIcon color="primary" sx={{ fontSize: 16 }} />}
                        </Stack>

                        <Tooltip title="Delete Patient">
                          <span>
                            <IconButton
                              size="small"
                              color="error"
                              disabled={deletingKey === pKey}
                              onClick={(e) => handleDeletePatient(p, e)}
                              sx={{ ml: -0.5 }}
                            >
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </span>
                        </Tooltip>
                      </Box>
                    </Paper>
                  );
                })
              )}
            </Box>
          </Card>
        </Grid>

        {/* Right 65% Panel: Selected Patient 360° History Workspace */}
        <Grid item xs={12} md={7.8} lg={8.2}>
          {!selectedPatient ? (
            <Card variant="outlined" sx={{ borderRadius: 3.5, p: 8, textAlign: 'center', height: 'calc(100vh - 180px)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center' }}>
              <HistoryIcon sx={{ fontSize: 64, color: 'text.secondary', opacity: 0.4, mb: 2 }} />
              <Typography variant="h6" fontWeight={800} color="text.secondary">Select a Patient to View Past History</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 420, mt: 1 }}>
                Choose any clinical patient record from the left directory panel to analyze their past eye tests, refraction progression, and spectacle orders.
              </Typography>
            </Card>
          ) : (
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
              {/* Patient 360 Profile Banner */}
              <Card variant="outlined" sx={{ borderRadius: 3.5, p: 3, borderLeft: '6px solid', borderLeftColor: 'primary.main', bgcolor: 'background.paper' }}>
                <Grid container spacing={2} alignItems="center">
                  <Grid item xs={12} sm={8}>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                      <Avatar sx={{ width: 56, height: 56, bgcolor: 'primary.main', fontSize: '1.4rem', fontWeight: 800 }}>
                        {selectedPatient.name.charAt(0).toUpperCase()}
                      </Avatar>
                      <Box>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <Typography variant="h5" fontWeight={800}>{selectedPatient.name}</Typography>
                          <Chip label={selectedPatient.id || 'P-1002'} size="small" color="primary" sx={{ fontWeight: 800 }} />
                        </Box>
                        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                          📞 {selectedPatient.phone || 'N/A'} • ✉️ {selectedPatient.email || 'No email registered'}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          🎂 Age: <strong>{selectedPatient.age || 'N/A'} Yrs</strong> • Gender: <strong>{selectedPatient.gender || 'Male'}</strong> • Occupation: <strong>{selectedPatient.occupation || 'Standard'}</strong>
                        </Typography>
                      </Box>
                    </Box>
                  </Grid>

                  <Grid item xs={12} sm={4}>
                    <Stack spacing={1} alignItems={{ xs: 'flex-start', sm: 'flex-end' }}>
                      <Button 
                        variant="contained" 
                        fullWidth 
                        size="small"
                        startIcon={<AddIcon />} 
                        onClick={handleStartExamForPatient} 
                        sx={{ backgroundColor: '#2563EB', fontWeight: 700, borderRadius: 2, textTransform: 'none' }}
                      >
                        Start Eye Exam
                      </Button>
                      <Button 
                        variant="outlined" 
                        fullWidth 
                        size="small"
                        startIcon={<CalendarIcon />} 
                        onClick={handleBookAptForPatient} 
                        sx={{ fontWeight: 700, borderRadius: 2, textTransform: 'none' }}
                      >
                        Book Appointment
                      </Button>
                    </Stack>
                  </Grid>
                </Grid>
              </Card>

              {/* Tabs Bar */}
              <Card variant="outlined" sx={{ borderRadius: 3, p: 0.5 }}>
                <Tabs 
                  value={activeTab} 
                  onChange={(e, val) => setActiveTab(val)}
                  variant="scrollable"
                  scrollButtons="auto"
                  sx={{
                    '& .MuiTab-root': { fontWeight: 700, textTransform: 'none', fontSize: '0.9rem', minHeight: 44 }
                  }}
                >
                  <Tab icon={<EyeIcon fontSize="small" />} iconPosition="start" label={`Past Eye Exams (${patientExams.length})`} />
                  <Tab icon={<ProgressionIcon fontSize="small" />} iconPosition="start" label="Refraction Power Progression" />
                  <Tab icon={<SpecIcon fontSize="small" />} iconPosition="start" label="Spectacles & Sales Orders" />
                  <Tab icon={<MedicalIcon fontSize="small" />} iconPosition="start" label="Medical & Risk History" />
                  <Tab icon={<RxIcon fontSize="small" />} iconPosition="start" label={`Previous Prescriptions (${patientPrescriptions.length})`} />
                  <Tab icon={<NotesIcon fontSize="small" />} iconPosition="start" label={`Previous Visit Notes (${patientVisitNotes.length + patientAppointmentNotes.length})`} />
                  <Tab icon={<BillIcon fontSize="small" />} iconPosition="start" label={`Invoices & Payments (${patientInvoices.length})`} />
                  <Tab icon={<LabIcon fontSize="small" />} iconPosition="start" label={`Lab Orders & Status (${patientLabOrders.length})`} />
                </Tabs>
              </Card>

              {/* TAB 1: Past Eye Exams Timeline */}
              {activeTab === 0 && (
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {patientExams.length === 0 ? (
                    <Card variant="outlined" sx={{ p: 5, textAlign: 'center', borderRadius: 3 }}>
                      <EyeIcon sx={{ fontSize: 48, color: 'text.secondary', opacity: 0.4, mb: 1 }} />
                      <Typography variant="subtitle1" fontWeight={800} color="text.secondary">No Prior Eye Examination Records</Typography>
                      <Typography variant="body2" color="text.secondary">
                        No clinical refraction visits recorded for this patient in the database yet. Click "Start Eye Exam" to record their first test.
                      </Typography>
                    </Card>
                  ) : (
                    patientExams.map((exam, index) => (
                      <Card key={exam.id || index} variant="outlined" sx={{ borderRadius: 3, overflow: 'hidden' }}>
                        <Box sx={{ p: 2, bgcolor: 'action.hover', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                            <Chip label={`Visit #${patientExams.length - index}`} size="small" color="primary" sx={{ fontWeight: 800 }} />
                            <Typography variant="subtitle2" fontWeight={800}>
                              📅 Date: {exam.date || new Date().toISOString().split('T')[0]}
                            </Typography>
                            <Typography variant="caption" color="text.secondary">
                              Exam ID: {exam.id || `EX-${1000 + index}`}
                            </Typography>
                          </Box>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                            <Typography variant="caption" fontWeight={700} color="primary.main">
                              Optometrist: {exam.assignedOptometrist || exam.optometrist || '—'}
                            </Typography>
                            <Tooltip title="Print This Exam / Prescription">
                              <IconButton size="small" onClick={() => setPrintingExam(exam)}>
                                <PrintIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                            <Tooltip title="Edit This Exam">
                              <IconButton size="small" onClick={() => handleEditExam(exam)}>
                                <EditIcon fontSize="small" />
                              </IconButton>
                            </Tooltip>
                          </Box>
                        </Box>

                        <Divider />

                        <CardContent sx={{ p: 2.5 }}>
                          {/* Refraction Table (Matches First Image Model) */}
                          <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', mb: 1 }}>
                            Final Subjective Refraction
                          </Typography>

                          <Grid container spacing={1.5} sx={{ mb: 2 }}>
                            {/* RIGHT (OD) */}
                            <Grid item xs={12} sm={6}>
                              <Paper variant="outlined" sx={{ border: '2px solid #2563eb', borderRadius: 2, overflow: 'hidden' }}>
                                <Box sx={{ bgcolor: '#2563eb', color: '#fff', py: 0.5, textAlign: 'center', fontWeight: 900, fontSize: '0.82rem' }}>
                                  RIGHT (OD)
                                </Box>
                                <Table size="small">
                                  <TableHead sx={{ bgcolor: '#eff6ff' }}>
                                    <TableRow>
                                      <TableCell align="center" sx={{ fontWeight: 800, py: 0.5, fontSize: '0.75rem' }}>SPH</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 800, py: 0.5, fontSize: '0.75rem' }}>CYL</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 800, py: 0.5, fontSize: '0.75rem' }}>AXIS</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 800, py: 0.5, fontSize: '0.75rem' }}>VA</TableCell>
                                    </TableRow>
                                  </TableHead>
                                  <TableBody>
                                    <TableRow>
                                      <TableCell align="center" sx={{ fontWeight: 800, color: '#2563eb' }}>{exam.sphRight || exam.od?.sph || '—'}</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 700 }}>{exam.cylRight || exam.od?.cyl || '—'}</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 700 }}>{(exam.axisRight || exam.od?.axis) ? `${exam.axisRight || exam.od?.axis}°` : '—'}</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 700 }}>{exam.vaOD || exam.od?.va || '—'}</TableCell>
                                    </TableRow>
                                  </TableBody>
                                </Table>
                              </Paper>
                            </Grid>

                            {/* LEFT (OS) */}
                            <Grid item xs={12} sm={6}>
                              <Paper variant="outlined" sx={{ border: '2px solid #059669', borderRadius: 2, overflow: 'hidden' }}>
                                <Box sx={{ bgcolor: '#059669', color: '#fff', py: 0.5, textAlign: 'center', fontWeight: 900, fontSize: '0.82rem' }}>
                                  LEFT (OS)
                                </Box>
                                <Table size="small">
                                  <TableHead sx={{ bgcolor: '#ecfdf5' }}>
                                    <TableRow>
                                      <TableCell align="center" sx={{ fontWeight: 800, py: 0.5, fontSize: '0.75rem' }}>SPH</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 800, py: 0.5, fontSize: '0.75rem' }}>CYL</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 800, py: 0.5, fontSize: '0.75rem' }}>AXIS</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 800, py: 0.5, fontSize: '0.75rem' }}>VA</TableCell>
                                    </TableRow>
                                  </TableHead>
                                  <TableBody>
                                    <TableRow>
                                      <TableCell align="center" sx={{ fontWeight: 800, color: '#059669' }}>{exam.sphLeft || exam.os?.sph || '—'}</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 700 }}>{exam.cylLeft || exam.os?.cyl || '—'}</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 700 }}>{(exam.axisLeft || exam.os?.axis) ? `${exam.axisLeft || exam.os?.axis}°` : '—'}</TableCell>
                                      <TableCell align="center" sx={{ fontWeight: 700 }}>{exam.vaOS || exam.os?.va || '—'}</TableCell>
                                    </TableRow>
                                  </TableBody>
                                </Table>
                              </Paper>
                            </Grid>
                          </Grid>


                          <Grid container spacing={2}>
                            <Grid item xs={6} sm={3}>
                              <Typography variant="caption" color="text.secondary" display="block">NEAR ADD</Typography>
                              <Typography variant="body2" fontWeight={700}>{exam.nearAdd || '—'}</Typography>
                            </Grid>
                            <Grid item xs={6} sm={3}>
                              <Typography variant="caption" color="text.secondary" display="block">PUPIL DISTANCE (PD)</Typography>
                              <Typography variant="body2" fontWeight={700}>{exam.distancePD ? `${exam.distancePD} mm` : '—'}</Typography>
                            </Grid>
                            <Grid item xs={12} sm={6}>
                              <Typography variant="caption" color="text.secondary" display="block">PRIMARY DIAGNOSIS</Typography>
                              <Typography variant="body2" fontWeight={700} color="primary.main">{exam.diagnosis || 'Pending Diagnostic Assessment'}</Typography>
                            </Grid>
                          </Grid>
                        </CardContent>
                      </Card>
                    ))
                  )}
                </Box>
              )}

              {/* TAB 2: Refraction Power Progression */}
              {activeTab === 1 && (
                <Card variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <ProgressionIcon /> Longitudinal Vision & Refraction Progression
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    Comparative record of SPH, CYL, and Visual Acuity evolution across historical patient visits.
                  </Typography>

                  {patientExams.length === 0 ? (
                    <Alert severity="info" sx={{ borderRadius: 2 }}>
                      No historic visits recorded yet. Progression data automatically generates when multiple eye examinations are saved.
                    </Alert>
                  ) : (
                    <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
                      <Table size="medium">
                        <TableHead sx={{ bgcolor: 'action.hover' }}>
                          <TableRow>
                            <TableCell sx={{ fontWeight: 800 }}>Visit Date</TableCell>
                            <TableCell sx={{ fontWeight: 800 }}>OD (Right) SPH / CYL / Axis</TableCell>
                            <TableCell sx={{ fontWeight: 800 }}>OS (Left) SPH / CYL / Axis</TableCell>
                            <TableCell sx={{ fontWeight: 800 }}>Near Add</TableCell>
                            <TableCell sx={{ fontWeight: 800 }}>Optometrist</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {patientExams.map((e, idx) => (
                            <TableRow key={idx} hover>
                              <TableCell sx={{ fontWeight: 700 }}>📅 {e.date || 'Today'}</TableCell>
                              <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>
                                {e.sphRight || '—'} / {e.cylRight || '—'} @ {e.axisRight || '—'}°
                              </TableCell>
                              <TableCell sx={{ fontWeight: 700, color: '#059669' }}>
                                {e.sphLeft || '—'} / {e.cylLeft || '—'} @ {e.axisLeft || '—'}°
                              </TableCell>
                              <TableCell sx={{ fontWeight: 700 }}>{e.nearAdd || '—'}</TableCell>
                              <TableCell sx={{ fontWeight: 600 }}>{e.assignedOptometrist || e.optometrist || '—'}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </Card>
              )}

              {/* TAB 3: Spectacles & Sales Orders */}
              {activeTab === 2 && (
                <Card variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <SpecIcon /> Spectacle Bookings & Frame Orders
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    Prescribed lens packages, frame recommendations, booking IDs, and dispensing notes.
                  </Typography>

                  {selectedPatient.hasSpecBooking || patientExams.some(e => e.hasSpecBooking) ? (
                    <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 2.5, bgcolor: 'rgba(37, 99, 235, 0.03)', borderColor: 'rgba(37, 99, 235, 0.2)' }}>
                      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                          <SpecIcon color="primary" />
                          <Typography variant="subtitle1" fontWeight={800}>
                            Booking ID: {selectedPatient.specDetails?.bookingId || 'SPEC-8402'}
                          </Typography>
                        </Box>
                        <Chip label={selectedPatient.specDetails?.status || 'Booked for Spectacles'} color="success" size="small" sx={{ fontWeight: 800 }} />
                      </Box>
                      <Grid container spacing={2}>
                        <Grid item xs={12} sm={6}>
                          <Typography variant="caption" color="text.secondary" display="block">FRAME RECOMMENDATION</Typography>
                          <Typography variant="body2" fontWeight={700}>{selectedPatient.specDetails?.frameRec || 'RayBan / Premium Titan Frame'}</Typography>
                        </Grid>
                        <Grid item xs={12} sm={6}>
                          <Typography variant="caption" color="text.secondary" display="block">LENS PACKAGE</Typography>
                          <Typography variant="body2" fontWeight={700}>{selectedPatient.specDetails?.lensRec || '1.56 Blue Cut Anti-Glare Lens'}</Typography>
                        </Grid>
                      </Grid>
                    </Paper>
                  ) : (
                    <Alert severity="info" sx={{ borderRadius: 2 }}>
                      No spectacle orders or frame bookings registered for this patient yet.
                    </Alert>
                  )}
                </Card>
              )}

              {/* TAB 4: Medical & Risk History */}
              {activeTab === 3 && (
                <Card variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <MedicalIcon /> Medical Conditions & Ocular Risk Radar
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    Systemic medical conditions, diabetes monitoring, allergies, and contact lens history.
                  </Typography>

                  <Grid container spacing={2.5}>
                    <Grid item xs={12} sm={6}>
                      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                        <Typography variant="caption" color="text.secondary" display="block">DIABETES MELLITUS STATUS</Typography>
                        <Typography variant="body1" fontWeight={700} color={selectedPatient.hasDiabetes ? 'error.main' : 'success.main'}>
                          {selectedPatient.hasDiabetes ? '⚠️ Positive (Diabetic Retinopathy Check Advised)' : 'Negative / Normal'}
                        </Typography>
                      </Paper>
                    </Grid>
                    <Grid item xs={12} sm={6}>
                      <Paper variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                        <Typography variant="caption" color="text.secondary" display="block">HYPERTENSION STATUS</Typography>
                        <Typography variant="body1" fontWeight={700} color={selectedPatient.hasHypertension ? 'warning.main' : 'success.main'}>
                          {selectedPatient.hasHypertension ? '⚠️ Positive (Hypertensive Retinopathy Screening)' : 'Negative / Normal'}
                        </Typography>
                      </Paper>
                    </Grid>
                  </Grid>
                </Card>
              )}

              {/* TAB 5: Previous Prescriptions (All) */}
              {activeTab === 4 && (
                <Card variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <RxIcon /> All Previous Prescriptions
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    Every spectacle prescription issued to this patient across all recorded eye examinations.
                  </Typography>

                  {patientPrescriptions.length === 0 ? (
                    <Alert severity="info" sx={{ borderRadius: 2 }}>
                      No prescriptions on record yet. A prescription is captured each time an eye examination is saved for this patient.
                    </Alert>
                  ) : (
                    <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
                      <Table size="small">
                        <TableHead sx={{ bgcolor: 'action.hover' }}>
                          <TableRow>
                            <TableCell sx={{ fontWeight: 800 }}>Date</TableCell>
                            <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>OD — SPH / CYL / AXIS / ADD</TableCell>
                            <TableCell sx={{ fontWeight: 800, color: '#059669' }}>OS — SPH / CYL / AXIS / ADD</TableCell>
                            <TableCell sx={{ fontWeight: 800 }}>PD</TableCell>
                            <TableCell sx={{ fontWeight: 800 }}>Diagnosis</TableCell>
                            <TableCell sx={{ fontWeight: 800 }}>Optometrist</TableCell>
                            <TableCell sx={{ fontWeight: 800, textAlign: 'right' }}>Print</TableCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {patientPrescriptions.map((rx) => (
                            <TableRow key={rx.key} hover>
                              <TableCell sx={{ fontWeight: 700, whiteSpace: 'nowrap' }}>📅 {rx.date}</TableCell>
                              <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>
                                {rx.od.sph} / {rx.od.cyl} / {rx.od.axis}{rx.od.axis !== '—' ? '°' : ''} / {rx.od.add}
                              </TableCell>
                              <TableCell sx={{ fontWeight: 700, color: '#059669' }}>
                                {rx.os.sph} / {rx.os.cyl} / {rx.os.axis}{rx.os.axis !== '—' ? '°' : ''} / {rx.os.add}
                              </TableCell>
                              <TableCell sx={{ fontWeight: 700 }}>{rx.pd ? `${rx.pd} mm` : '—'}</TableCell>
                              <TableCell sx={{ fontSize: '0.8rem' }}>{rx.diagnosis || '—'}</TableCell>
                              <TableCell sx={{ fontSize: '0.8rem' }}>{rx.optometrist}</TableCell>
                              <TableCell align="right">
                                <Tooltip title="Print This Prescription">
                                  <IconButton size="small" onClick={() => setPrintingExam(rx.exam)}>
                                    <PrintIcon fontSize="small" />
                                  </IconButton>
                                </Tooltip>
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </TableContainer>
                  )}
                </Card>
              )}

              {/* TAB 6: Previous Visit Notes */}
              {activeTab === 5 && (
                <Card variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <NotesIcon /> Previous Visit Notes
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    Clinical notes, complaints, diagnoses, recommendations and follow-up plans recorded at each past visit.
                  </Typography>

                  {(patientVisitNotes.every(v => v.fields.length === 0) && patientAppointmentNotes.length === 0) ? (
                    <Alert severity="info" sx={{ borderRadius: 2 }}>
                      No visit notes recorded for this patient yet.
                    </Alert>
                  ) : (
                    <Stack spacing={2}>
                      {patientVisitNotes.filter(v => v.fields.length > 0).map((v) => (
                        <Paper key={v.key} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1.5, flexWrap: 'wrap' }}>
                            <Chip label={v.type} size="small" color="primary" sx={{ fontWeight: 700 }} />
                            <Typography variant="subtitle2" fontWeight={800}>📅 {v.date}</Typography>
                            <Typography variant="caption" color="text.secondary">Optometrist: {v.optometrist}</Typography>
                          </Box>
                          <Grid container spacing={1.5}>
                            {v.fields.map(([label, value]) => (
                              <Grid item xs={12} sm={6} key={label}>
                                <Typography variant="caption" color="text.secondary" display="block" sx={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}>{label}</Typography>
                                <Typography variant="body2" fontWeight={600}>{value}</Typography>
                              </Grid>
                            ))}
                          </Grid>
                        </Paper>
                      ))}

                      {patientAppointmentNotes.map((a) => (
                        <Paper key={a.key} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 1, flexWrap: 'wrap' }}>
                            <Chip label={a.type} size="small" color="secondary" sx={{ fontWeight: 700 }} />
                            <Typography variant="subtitle2" fontWeight={800}>📅 {a.date}{a.time ? ` • ${a.time}` : ''}</Typography>
                            {a.status && <Chip label={a.status} size="small" variant="outlined" sx={{ fontWeight: 700 }} />}
                          </Box>
                          <Typography variant="caption" color="text.secondary" display="block">
                            Doctor: {a.doctor}{a.appointmentType ? ` • ${a.appointmentType}` : ''}
                          </Typography>
                          {a.notes && <Typography variant="body2" fontWeight={600} sx={{ mt: 0.5 }}>{a.notes}</Typography>}
                        </Paper>
                      ))}
                    </Stack>
                  )}
                </Card>
              )}

              {/* TAB 7: Previous Invoices & Payments */}
              {activeTab === 6 && (
                <Card variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <BillIcon /> Previous Invoices & Payments
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    Full billing history for this patient — every sales invoice raised and every payment receipt collected.
                  </Typography>

                  {patientInvoices.length === 0 && patientPayments.length === 0 ? (
                    <Alert severity="info" sx={{ borderRadius: 2 }}>
                      No invoices or payments recorded for this patient yet.
                    </Alert>
                  ) : (
                    <>
                      <Grid container spacing={2} sx={{ mb: 3 }}>
                        <Grid item xs={12} sm={4}>
                          <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, borderLeft: '4px solid #2563eb' }}>
                            <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL BILLED</Typography>
                            <Typography variant="h6" fontWeight={900}>₹{totalBilled.toLocaleString('en-IN')}</Typography>
                          </Paper>
                        </Grid>
                        <Grid item xs={12} sm={4}>
                          <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, borderLeft: '4px solid #059669' }}>
                            <Typography variant="caption" color="text.secondary" fontWeight={700}>TOTAL PAID</Typography>
                            <Typography variant="h6" fontWeight={900} color="success.main">₹{totalPaid.toLocaleString('en-IN')}</Typography>
                          </Paper>
                        </Grid>
                        <Grid item xs={12} sm={4}>
                          <Paper variant="outlined" sx={{ p: 2, borderRadius: 2, borderLeft: '4px solid #d97706' }}>
                            <Typography variant="caption" color="text.secondary" fontWeight={700}>OUTSTANDING</Typography>
                            <Typography variant="h6" fontWeight={900} color={totalOutstanding > 0 ? 'error.main' : 'text.primary'}>₹{totalOutstanding.toLocaleString('en-IN')}</Typography>
                          </Paper>
                        </Grid>
                      </Grid>

                      <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', mb: 1 }}>
                        Invoices ({patientInvoices.length})
                      </Typography>
                      {patientInvoices.length === 0 ? (
                        <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>No invoices on record.</Typography>
                      ) : (
                        <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, mb: 3 }}>
                          <Table size="small">
                            <TableHead sx={{ bgcolor: 'action.hover' }}>
                              <TableRow>
                                <TableCell sx={{ fontWeight: 800 }}>Invoice #</TableCell>
                                <TableCell sx={{ fontWeight: 800 }}>Date</TableCell>
                                <TableCell sx={{ fontWeight: 800, textAlign: 'right' }}>Total</TableCell>
                                <TableCell sx={{ fontWeight: 800, textAlign: 'right' }}>Paid</TableCell>
                                <TableCell sx={{ fontWeight: 800, textAlign: 'right' }}>Balance</TableCell>
                                <TableCell sx={{ fontWeight: 800 }}>Payment</TableCell>
                                <TableCell sx={{ fontWeight: 800 }}>Method</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {patientInvoices.map((inv) => (
                                <TableRow key={inv.key} hover>
                                  <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{inv.number}</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{inv.date}</TableCell>
                                  <TableCell sx={{ textAlign: 'right', fontWeight: 700 }}>₹{inv.total.toLocaleString('en-IN')}</TableCell>
                                  <TableCell sx={{ textAlign: 'right' }}>₹{inv.paid.toLocaleString('en-IN')}</TableCell>
                                  <TableCell sx={{ textAlign: 'right', fontWeight: 700, color: inv.balance > 0 ? 'error.main' : 'text.secondary' }}>₹{inv.balance.toLocaleString('en-IN')}</TableCell>
                                  <TableCell>
                                    <Chip
                                      label={inv.paymentStatus}
                                      size="small"
                                      color={/paid/i.test(inv.paymentStatus) && !/unpaid/i.test(inv.paymentStatus) ? 'success' : /partial/i.test(inv.paymentStatus) ? 'warning' : 'default'}
                                      variant="outlined"
                                      sx={{ fontWeight: 700, fontSize: '0.7rem' }}
                                    />
                                  </TableCell>
                                  <TableCell sx={{ fontSize: '0.8rem' }}>{inv.method || '—'}</TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      )}

                      <Typography variant="caption" fontWeight={800} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'flex', alignItems: 'center', gap: 0.5, mb: 1 }}>
                        <PaymentsIcon fontSize="small" /> Payment Receipts ({patientPayments.length})
                      </Typography>
                      {patientPayments.length === 0 ? (
                        <Typography variant="body2" color="text.secondary">No payment receipts on record.</Typography>
                      ) : (
                        <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
                          <Table size="small">
                            <TableHead sx={{ bgcolor: 'action.hover' }}>
                              <TableRow>
                                <TableCell sx={{ fontWeight: 800 }}>Receipt #</TableCell>
                                <TableCell sx={{ fontWeight: 800 }}>Date</TableCell>
                                <TableCell sx={{ fontWeight: 800, textAlign: 'right' }}>Amount</TableCell>
                                <TableCell sx={{ fontWeight: 800 }}>Method</TableCell>
                                <TableCell sx={{ fontWeight: 800 }}>Status</TableCell>
                              </TableRow>
                            </TableHead>
                            <TableBody>
                              {patientPayments.map((p) => (
                                <TableRow key={p.key} hover>
                                  <TableCell sx={{ fontWeight: 700 }}>{p.receiptNo}</TableCell>
                                  <TableCell sx={{ whiteSpace: 'nowrap' }}>{p.date}</TableCell>
                                  <TableCell sx={{ textAlign: 'right', fontWeight: 800, color: 'success.main' }}>₹{p.amount.toLocaleString('en-IN')}</TableCell>
                                  <TableCell sx={{ fontSize: '0.8rem' }}>{p.method}</TableCell>
                                  <TableCell>
                                    <Chip label={p.status} size="small" color="success" variant="outlined" sx={{ fontWeight: 700, fontSize: '0.7rem' }} />
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </TableContainer>
                      )}
                    </>
                  )}
                </Card>
              )}

              {/* TAB 8: Previous Lab Orders & Status */}
              {activeTab === 7 && (
                <Card variant="outlined" sx={{ borderRadius: 3, p: 3 }}>
                  <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
                    <LabIcon /> Previous Lab Orders & Status
                  </Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
                    Optical laboratory job tracking for this patient — lens/frame dispensing orders and their current pipeline stage.
                  </Typography>

                  {patientLabOrders.length === 0 ? (
                    <Alert severity="info" sx={{ borderRadius: 2 }}>
                      No lab / dispensing orders recorded for this patient yet.
                    </Alert>
                  ) : (
                    <Stack spacing={2}>
                      {patientLabOrders.map((ord) => {
                        const stageIdx = LAB_STAGES.findIndex(s => s.toLowerCase() === String(ord.labStatus || '').toLowerCase());
                        const pct = stageIdx >= 0 ? Math.round(((stageIdx + 1) / LAB_STAGES.length) * 100) : (ord.labStatus ? 15 : 0);
                        const delivered = /delivered/i.test(ord.labStatus);
                        const ready = /ready/i.test(ord.labStatus);
                        return (
                          <Paper key={ord.key} variant="outlined" sx={{ p: 2, borderRadius: 2 }}>
                            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1, mb: 1 }}>
                              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                                <LabIcon color="primary" fontSize="small" />
                                <Typography variant="subtitle2" fontWeight={800}>Order {ord.number}</Typography>
                                <Typography variant="caption" color="text.secondary">📅 {ord.date}</Typography>
                              </Box>
                              <Chip
                                label={ord.labStatus || 'Pending'}
                                size="small"
                                color={delivered ? 'info' : ready ? 'success' : 'warning'}
                                sx={{ fontWeight: 800, fontSize: '0.7rem' }}
                              />
                            </Box>
                            <LinearProgress
                              variant="determinate"
                              value={pct}
                              sx={{ height: 8, borderRadius: 4, mb: 1 }}
                              color={delivered ? 'info' : ready ? 'success' : 'warning'}
                            />
                            <Grid container spacing={1.5} sx={{ mt: 0 }}>
                              <Grid item xs={12} sm={6}>
                                <Typography variant="caption" color="text.secondary" display="block">FRAME</Typography>
                                <Typography variant="body2" fontWeight={700}>👓 {ord.frame || '—'}</Typography>
                              </Grid>
                              <Grid item xs={12} sm={6}>
                                <Typography variant="caption" color="text.secondary" display="block">LENS</Typography>
                                <Typography variant="body2" fontWeight={700}>🔍 {ord.lens || '—'}</Typography>
                              </Grid>
                              <Grid item xs={6} sm={3}>
                                <Typography variant="caption" color="text.secondary" display="block">ORDER VALUE</Typography>
                                <Typography variant="body2" fontWeight={700}>₹{ord.total.toLocaleString('en-IN')}</Typography>
                              </Grid>
                              <Grid item xs={6} sm={3}>
                                <Typography variant="caption" color="text.secondary" display="block">PAYMENT</Typography>
                                <Typography variant="body2" fontWeight={700}>{ord.paymentStatus}</Typography>
                              </Grid>
                            </Grid>
                          </Paper>
                        );
                      })}
                    </Stack>
                  )}
                </Card>
              )}
            </Box>
          )}
        </Grid>
      </Grid>

      {/* Print This Exam / Prescription — reuses the same card the Eye Test wizard's final
          step prints from, so a past visit prints identically to how it looked when recorded. */}
      <Dialog open={Boolean(printingExam)} onClose={() => setPrintingExam(null)} maxWidth="md" fullWidth>
        <IconButton
          onClick={() => setPrintingExam(null)}
          className="no-print"
          sx={{ position: 'absolute', right: 8, top: 8, zIndex: 1 }}
        >
          <CloseIcon />
        </IconButton>
        <DialogContent sx={{ p: { xs: 1, sm: 2 } }}>
          {printingExam && (
            <PrintPrescriptionCard
              patientData={printingExam.raw_data?.patientData || printingExam.patientData || selectedPatient}
              subjectiveRefraction={printingExam.subjectiveRefraction}
              diagnosis={printingExam.raw_data?.diagnosis || { primary: printingExam.diagnosis }}
              prescription={printingExam.raw_data?.prescription || printingExam.prescription || {}}
              medicalHistory={printingExam.medicalHistory}
              onNavigateToSales={() => navigate('/sales/new', { state: { patient: selectedPatient } })}
            />
          )}
        </DialogContent>
      </Dialog>
    </Box>
  );
}
