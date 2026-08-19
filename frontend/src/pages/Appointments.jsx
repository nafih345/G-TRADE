import React, { useState, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import QuickDatePickerField from '../components/common/QuickDatePickerField';
import { 
  Box, Card, CardContent, Typography, Button, Grid, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Chip, Dialog, DialogTitle, DialogContent, 
  DialogActions, TextField, MenuItem, Stack, IconButton,
  Autocomplete, FormControlLabel, Checkbox, InputAdornment, Tooltip,
  Snackbar, Alert
} from '@mui/material';
import {
  Add as AddIcon,
  CalendarMonth as CalendarIcon,
  NotificationsActive as AlarmIcon,
  Edit as EditIcon,
  Close as CancelIcon,
  Visibility as ViewIcon,
  Search as SearchIcon,
  WhatsApp as WhatsAppIcon,
  AccessTime as TimeIcon,
  Person as PersonIcon,
  MedicalServices as DoctorIcon,
  Business as BranchIcon,
  ConfirmationNumber as TokenIcon,
  CheckCircle as ActiveIcon,
  DeleteSweep as ClearIcon
} from '@mui/icons-material';

const examTypesList = [
  'Comprehensive Eye Exam',
  'Pediatric Refraction',
  'Contact Lens Fitting & Evaluation',
  'Glaucoma & IOP Screening',
  'Diabetic Retinopathy Assessment',
  'Dry Eye & Tear Film Diagnostic',
  'Post-Operative Cataract Check',
  'Low Vision & Vision Therapy'
];

const presetTimeSlots = [
  '09:00 AM', '10:00 AM', '11:30 AM', '01:30 PM', 
  '03:00 PM', '04:30 PM', '06:00 PM', '07:30 PM'
];

const priorityLevels = [
  'Standard Booking',
  'Urgent / Red Eye',
  'VIP Patient',
  'Pediatric High Attention',
  'Wheelchair Accessible'
];

const roomAllocations = [
  'Room 1 - Primary Refraction Suite',
  'Room 2 - Slit Lamp & Diagnostics',
  'Room 3 - Contact Lens Clinic',
  'Room 4 - Pediatric Testing'
];

// Maps a backend Appointment record (apps/sales Appointment model) onto the shape
// this page has always used internally, so existing render/edit code doesn't change.
const mapBackendAppointment = (a) => ({
  id: a.id,
  token: a.token || a.appointment_code || '',
  customerId: a.customer || null,
  patientId: a.patient_code || '',
  testNo: a.test_no || '',
  patient: a.patient_name || '',
  phone: a.phone || '',
  email: a.email || '',
  age: a.age || '',
  gender: a.gender || 'Male',
  doctor: a.doctor || '',
  date: a.appointment_date || '',
  time: a.appointment_time || '',
  type: a.appointment_type || '',
  branch: a.branch || '',
  room: a.room || '',
  priority: a.priority || 'Standard Booking',
  status: a.status || 'Booked',
  sendWhatsapp: !!a.send_whatsapp,
  notes: a.notes || '',
  createdAt: a.created_at
});

// Maps this page's internal appointment shape onto the backend Appointment model's fields.
const mapAppointmentToBackend = (apt, customerId) => ({
  customer: customerId || null,
  patient_name: apt.patient,
  phone: apt.phone,
  email: apt.email,
  age: apt.age,
  gender: apt.gender,
  doctor: apt.doctor,
  appointment_date: apt.date,
  appointment_time: apt.time,
  appointment_type: apt.type,
  branch: apt.branch,
  room: apt.room,
  priority: apt.priority,
  status: apt.status,
  send_whatsapp: !!apt.sendWhatsapp,
  notes: apt.notes,
  token: apt.token,
  test_no: apt.testNo
});

// A real backend Appointment/Customer id is a UUID; ids the old localStorage-only code
// generated (e.g. "APT-8402") never look like one — used to tell "already saved to the
// backend" apart from "local-only record from before this page was connected."
const isBackendId = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);

export default function Appointments() {
  const navigate = useNavigate();
  const location = useLocation();
  const handoffPatientHandledRef = useRef(false);
  const [appointments, setAppointments] = useState([]);
  const [dbPatients, setDbPatients] = useState([]);
  const [registeredDoctors, setRegisteredDoctors] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [filterDoctor, setFilterDoctor] = useState('All');

  // Booking Modal States
  const [open, setOpen] = useState(false);
  const [viewOpen, setViewOpen] = useState(false);
  const [viewingApt, setViewingApt] = useState(null);
  const [isEditing, setIsEditing] = useState(false);
  const [selectedAptId, setSelectedAptId] = useState(null);

  // Preview only — the real, guaranteed-unique code is assigned server-side when the Customer
  // is actually created; this just gives the front desk something sensible to quote the patient
  // immediately. Asks the backend's own sequence counter rather than scanning whatever patient
  // list happened to be loaded client-side: that local scan went stale (kept showing the same
  // "next" ID for every new patient) whenever it missed a recently-added patient — e.g. a
  // customer-create call that failed silently, or dbPatients simply not having refetched yet.
  const getNextPatientIdPreview = async () => {
    try {
      const res = await axios.get('/api/sales/customers/next-patient-code/');
      if (res.data?.patient_code) return res.data.patient_code;
    } catch (e) {}
    // Fallback only if the backend call itself fails (offline, etc.) — best-effort guess.
    const allIds = (dbPatients || [])
      .map(p => String(p.patient_code || p.id || '').match(/^p-?(\d+)$/i))
      .filter(Boolean)
      .map(m => parseInt(m[1], 10));
    const maxId = allIds.length > 0 ? Math.max(...allIds) : 1000;
    return `P-${maxId + 1}`;
  };

  const [newApt, setNewApt] = useState({
    customerId: null,
    patientId: '',
    testNo: '',
    patient: '',
    phone: '',
    email: '',
    age: '',
    gender: 'Male',
    address: '',
    place: '',
    doctor: '',
    date: new Date().toISOString().split('T')[0],
    time: '10:00 AM',
    type: 'Comprehensive Eye Exam',
    branch: 'Main Branch',
    room: 'Room 1 - Primary Refraction Suite',
    priority: 'Standard Booking',
    sendWhatsapp: true,
    status: 'Booked',
    notes: ''
  });

  // Fetch Database Records (Appointments, Patients, Doctors)
  useEffect(() => {
    const fetchDatabaseRecords = async () => {
      let aptList = [];
      let custPool = [];
      let docPool = [];

      // Local storage reads
      try {
        const localApts = JSON.parse(localStorage.getItem('optical_appointments') || '[]');
        const localCust = JSON.parse(localStorage.getItem('optical_sales_customers') || '[]');
        const localDocs = JSON.parse(localStorage.getItem('optical_doctors') || '[]');
        const adminDocs = JSON.parse(localStorage.getItem('optical_doctors_db') || '[]');
        const adminDocNames = adminDocs.filter(d => d.status === 'Active').map(d => d.name);
        aptList = [...localApts];
        custPool = [...localCust];
        docPool = [...localDocs, ...adminDocNames];
      } catch (e) {}

      // API fetches — /api/sales/* endpoints are paginated (DRF PageNumberPagination), so a
      // successful response is {count, next, previous, results}, not a bare array.
      try {
        const resApts = await axios.get('/api/sales/appointments/');
        const aptData = resApts.data?.results || resApts.data || [];
        if (Array.isArray(aptData)) {
          aptList = [...aptList, ...aptData.map(mapBackendAppointment)];
        }
      } catch (e) {}

      try {
        const resCust = await axios.get('/api/sales/customers/');
        const custData = resCust.data?.results || resCust.data || [];
        if (Array.isArray(custData)) {
          custPool = [...custPool, ...custData];
        }
      } catch (e) {}

      try {
        const resUsers = await axios.get('/api/admin/users/');
        if (resUsers.data && Array.isArray(resUsers.data)) {
          const apiDocNames = resUsers.data
            .filter(u => u.role === 'DOCTOR' || u.role === 'OPTOMETRIST' || (u.designation && u.designation.toLowerCase().includes('doc')))
            .map(u => u.name || `Dr. ${u.first_name} ${u.last_name}`)
            .filter(Boolean);
          docPool = [...docPool, ...apiDocNames];
        }
      } catch (e) {}

      // Deduplicate
      const uniqueApts = Array.from(new Map(aptList.map(a => [a.id, a])).values());
      const uniqueCust = Array.from(new Map(custPool.map(c => [c.name || c.phone, c])).values());
      const uniqueDocs = Array.from(new Set(docPool.filter(Boolean)));

      setAppointments(uniqueApts);
      setDbPatients(uniqueCust);
      setRegisteredDoctors(uniqueDocs);
    };

    fetchDatabaseRecords();

    window.addEventListener('optical_doctors_updated', fetchDatabaseRecords);
    return () => window.removeEventListener('optical_doctors_updated', fetchDatabaseRecords);
  }, []);

  const handleClearAllAppointments = () => {
    if (!window.confirm('This will permanently remove all appointments and related patient records stored in this browser. Continue?')) {
      return;
    }
    ['optical_appointments', 'optical_patients', 'optical_sales_customers', 'optical_eye_tests'].forEach(key => {
      localStorage.removeItem(key);
    });
    window.location.reload();
  };

  const handleOpen = async () => {
    setIsEditing(false);
    setSelectedAptId(null);
    setNewApt({
      customerId: null,
      patientId: '…',
      testNo: '',
      patient: '',
      phone: '',
      email: '',
      age: '',
      gender: 'Male',
      address: '',
      place: '',
      doctor: '',
      date: new Date().toISOString().split('T')[0],
      time: '10:00 AM',
      type: 'Comprehensive Eye Exam',
      branch: 'Main Branch',
      room: 'Room 1 - Primary Refraction Suite',
      priority: 'Standard Booking',
      sendWhatsapp: true,
      status: 'Booked',
      notes: ''
    });
    setOpen(true);
    const patientId = await getNextPatientIdPreview();
    // Guard against a race: if the front desk already picked an existing patient while this
    // was in flight, don't clobber their real ID with a fresh "new patient" preview.
    setNewApt(prev => prev.customerId ? prev : { ...prev, patientId });
  };

  const handleClose = () => setOpen(false);

  // Patient History's "Book Appointment" button hands the selected patient across via
  // navigate() state — pre-fill and open the booking dialog with their real details/link
  // instead of leaving the handoff silently ignored.
  useEffect(() => {
    const p = location.state?.patient;
    if (!p || handoffPatientHandledRef.current) return;
    handoffPatientHandledRef.current = true;
    setIsEditing(false);
    setSelectedAptId(null);
    setNewApt(prev => ({
      ...prev,
      customerId: p.customerId || null,
      patientId: p.id || '…',
      testNo: p.testNo || '',
      patient: p.name || '',
      phone: p.phone || '',
      email: p.email || '',
      age: p.age || '',
      gender: p.gender || 'Male'
    }));
    setOpen(true);
    if (!p.id) {
      getNextPatientIdPreview().then(patientId => {
        setNewApt(prev => prev.customerId ? prev : { ...prev, patientId });
      });
    }
  }, [location.state]);

  const handleSelectPatientObj = async (patientObj) => {
    if (!patientObj) return;
    if (typeof patientObj === 'string') {
      // Typed freely rather than picked from the list — treat as a brand-new patient and show
      // a fresh preview ID/token rather than leaving a previously-selected patient's on screen.
      setNewApt(prev => ({
        ...prev,
        patient: patientObj,
        customerId: null,
        patientId: '…',
        testNo: ''
      }));
      const patientId = await getNextPatientIdPreview();
      setNewApt(prev => prev.customerId ? prev : { ...prev, patientId });
    } else {
      setNewApt(prev => ({
        ...prev,
        customerId: patientObj.id || null,
        patientId: patientObj.patient_code || patientObj.id || '',
        testNo: patientObj.testNo || '',
        patient: patientObj.name || '',
        phone: patientObj.phone || '',
        email: patientObj.email || '',
        age: patientObj.age || '',
        gender: patientObj.gender || 'Male',
        address: patientObj.address || '',
        place: patientObj.place || patientObj.city || ''
      }));
    }
  };

  const [toast, setToast] = useState({ open: false, message: '', severity: 'success' });

  const triggerToast = (msg, sev = 'success') => {
    setToast({ open: true, message: msg, severity: sev });
  };

  // `prewarmedWindow`: browsers silently block window.open() the moment it's no longer
  // directly inside the click handler's call stack — i.e. after crossing any await/setTimeout.
  // Direct call sites (the row/detail WhatsApp buttons) call this straight from onClick with no
  // extra arg, so opening the tab as the very first synchronous line here (before the first
  // await below) still works. handleSave is several awaits removed by the time it gets here
  // (customer/appointment saves), so it pre-opens a blank tab synchronously at click time and
  // passes the handle through instead — this function then just navigates it.
  const sendWhatsAppReminder = async (apt, prewarmedWindow) => {
    const waWindow = prewarmedWindow !== undefined ? prewarmedWindow : window.open('', '_blank');

    const rawPhone = (apt.phone || '').replace(/[^0-9]/g, '');
    if (!rawPhone) {
      waWindow?.close();
      triggerToast("No valid mobile phone number found for sending WhatsApp confirmation.", "warning");
      return;
    }
    const formattedPhone = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;
    const storeName = apt.branch ? `Greensol Optical (${apt.branch})` : 'Greensol Optical ERP';
    
    let reachingTimeStr = "10–15 minutes early";
    if (apt.time) {
      reachingTimeStr = `10–15 minutes early (around ${apt.time})`;
    }

    const message = `*Booking Confirmed ✅*

Hello *${apt.patient || 'Valued Patient'}*,

Your appointment has been successfully confirmed.

🎫 *Token Number:* ${apt.token || 'T-101'}
📅 *Date:* ${apt.date || 'Today'}
🕒 *Booking Time:* ${apt.time || '10:00 AM'}
⏱️ *Reaching Time:* ${reachingTimeStr}
👨‍⚕️ *Doctor/Consultant:* ${apt.doctor || 'Attending Optometrist'}
📍 *Location:* ${storeName}

Please arrive *10–15 minutes early* for your appointment.

If you need to reschedule or cancel, kindly let us know in advance by replying to this message or calling us.

Thank you for choosing *${storeName}*. We look forward to seeing you!`;

    let isCloudApiSent = false;
    try {
      const res = await axios.post('/api/sales/whatsapp/send-automated/', {
        phone: formattedPhone,
        patient: apt.patient,
        type: 'confirmation',
        message
      });
      if (res.data && res.data.api_sent) {
        isCloudApiSent = true;
      }
    } catch (e) {}

    // 2. Log dispatch
    try {
      const logs = JSON.parse(localStorage.getItem('optical_whatsapp_logs') || '[]');
      logs.unshift({ date: new Date().toISOString(), phone: formattedPhone, patient: apt.patient, type: 'confirmation', status: 'Sent' });
      localStorage.setItem('optical_whatsapp_logs', JSON.stringify(logs));
    } catch (e) {}

    // 3. Feedback Toast & Real Delivery
    if (isCloudApiSent) {
      waWindow?.close();
      triggerToast(`⚡ Automated WhatsApp Confirmation delivered via Cloud API to +${formattedPhone}`, 'success');
    } else {
      const whatsappUrl = `https://api.whatsapp.com/send?phone=${formattedPhone}&text=${encodeURIComponent(message)}`;
      if (waWindow && !waWindow.closed) {
        waWindow.location.href = whatsappUrl;
        triggerToast(`📱 Dispatching WhatsApp message to +${formattedPhone}...`, 'success');
      } else {
        triggerToast("Your browser blocked the WhatsApp popup. Please allow popups for this site and try again.", 'warning');
      }
    }
  };

  const handleSave = async () => {
    if (!newApt.patient) {
      alert("Please enter or select a Patient Name.");
      return;
    }

    // Pre-open a blank tab synchronously, still inside this click's call stack, before any of
    // the awaits below — see the comment on sendWhatsAppReminder for why this has to happen
    // this early rather than after the appointment is saved.
    const waWindowHandle = (newApt.sendWhatsapp && newApt.phone) ? window.open('', '_blank') : null;

    // Resolve a real backend Customer to link this appointment to: reuse the one the
    // Autocomplete selected, reuse one matching by phone (avoids piling up duplicate
    // Customer rows for the same person typed fresh each time), or create a new one.
    let customerId = newApt.customerId;
    if (!customerId) {
      const existingMatch = newApt.phone
        ? dbPatients.find(c => c.phone && c.phone === newApt.phone)
        : null;
      if (existingMatch) {
        customerId = existingMatch.id;
      } else {
        try {
          // Pass the previewed Patient ID through explicitly so what the front desk saw (and
          // may have already quoted to the patient) in the booking dialog is what actually
          // gets saved — the backend only falls back to minting a different one if this exact
          // code has since been taken (e.g. a concurrent booking).
          const resCust = await axios.post('/api/sales/customers/', {
            name: newApt.patient,
            phone: newApt.phone || '',
            email: newApt.email || '',
            age: newApt.age || '',
            gender: newApt.gender || '',
            address: newApt.address || '',
            place: newApt.place || '',
            patient_code: newApt.patientId || undefined
          });
          customerId = resCust.data.id;
          setDbPatients(prev => [...prev, resCust.data]);
        } catch (e) {
          // Continue without a linked customer rather than blocking the booking.
        }
      }
    }

    const payload = mapAppointmentToBackend(newApt, customerId);
    let savedRecord = null;

    try {
      if (isEditing && isBackendId(selectedAptId)) {
        const res = await axios.patch(`/api/sales/appointments/${selectedAptId}/`, payload);
        savedRecord = mapBackendAppointment(res.data);
      } else {
        const res = await axios.post('/api/sales/appointments/', payload);
        savedRecord = mapBackendAppointment(res.data);
      }
    } catch (e) {
      waWindowHandle?.close();
      alert("Could not save the appointment to the server. Please try again.");
      return;
    }

    const updatedList = isEditing
      ? appointments.map(apt => (apt.id === selectedAptId ? savedRecord : apt))
      : [savedRecord, ...appointments];

    // Automatically register doctor in doctorsList if newly typed
    if (newApt.doctor) {
      const localDocs = JSON.parse(localStorage.getItem('optical_doctors') || '[]');
      if (!localDocs.includes(newApt.doctor)) {
        const updatedDocs = [...localDocs, newApt.doctor];
        localStorage.setItem('optical_doctors', JSON.stringify(updatedDocs));
        setRegisteredDoctors(Array.from(new Set(updatedDocs)));
      }
    }

    setAppointments(updatedList);
    try {
      localStorage.setItem('optical_appointments', JSON.stringify(updatedList));
    } catch (e) {}

    handleClose();

    // Trigger Automated WhatsApp Confirmation if checkbox is enabled
    if (savedRecord && newApt.sendWhatsapp) {
      sendWhatsAppReminder(savedRecord, waWindowHandle);
    } else {
      waWindowHandle?.close();
    }
  };

  const sendWhatsAppCancellation = async (apt) => {
    // See the comment on sendWhatsAppReminder — opened here, synchronously, before the first
    // await below, so browsers don't silently block it as an unrequested popup.
    const waWindow = window.open('', '_blank');

    const rawPhone = (apt.phone || '').replace(/[^0-9]/g, '');
    if (!rawPhone) {
      waWindow?.close();
      triggerToast("No valid mobile phone number found for sending WhatsApp cancellation message.", "warning");
      return;
    }
    const formattedPhone = rawPhone.length === 10 ? `91${rawPhone}` : rawPhone;
    const storeName = apt.branch ? `Greensol Optical (${apt.branch})` : 'Greensol Optical ERP';

    const message = `*Appointment Cancelled ❌*

Hello *${apt.patient || 'Valued Patient'}*,

Your appointment booking has been cancelled as requested.

🎫 *Token Number:* ${apt.token || 'T-101'}
📅 *Scheduled Date:* ${apt.date || 'N/A'}
🕒 *Scheduled Time:* ${apt.time || 'N/A'}
👨‍⚕️ *Doctor/Consultant:* ${apt.doctor || 'Attending Optometrist'}
📍 *Location:* ${storeName}

If this cancellation was done in error or if you would like to reschedule a new appointment for another date, please feel free to reply to this message or contact our clinic.

Thank you for choosing *${storeName}*. We hope to serve you again soon!`;

    let isCloudApiSent = false;
    try {
      const res = await axios.post('/api/sales/whatsapp/send-automated/', {
        phone: formattedPhone,
        patient: apt.patient,
        type: 'cancellation',
        message
      });
      if (res.data && res.data.api_sent) {
        isCloudApiSent = true;
      }
    } catch (e) {}

    // 2. Log dispatch
    try {
      const logs = JSON.parse(localStorage.getItem('optical_whatsapp_logs') || '[]');
      logs.unshift({ date: new Date().toISOString(), phone: formattedPhone, patient: apt.patient, type: 'cancellation', status: 'Sent' });
      localStorage.setItem('optical_whatsapp_logs', JSON.stringify(logs));
    } catch (e) {}

    // 3. Feedback Toast & Real Delivery
    if (isCloudApiSent) {
      waWindow?.close();
      triggerToast(`⚡ Automated WhatsApp Cancellation delivered via Cloud API to +${formattedPhone}`, 'info');
    } else {
      const whatsappUrl = `https://api.whatsapp.com/send?phone=${formattedPhone}&text=${encodeURIComponent(message)}`;
      if (waWindow && !waWindow.closed) {
        waWindow.location.href = whatsappUrl;
        triggerToast(`📱 Dispatching WhatsApp cancellation to +${formattedPhone}...`, 'info');
      } else {
        triggerToast("Your browser blocked the WhatsApp popup. Please allow popups for this site and try again.", 'warning');
      }
    }
  };

  // Smart Enter Key Navigation Handler for Appointment Booking Modal
  const handleModalKeyDownEnter = (e) => {
    if (e.key === 'Enter') {
      const activeEl = document.activeElement;
      if (activeEl && activeEl.tagName === 'TEXTAREA') return;

      const modalContainer = document.getElementById('appointment-modal-container');
      if (!modalContainer) return;

      const focusableSelectors = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), [tabindex="0"]';
      const focusables = Array.from(modalContainer.querySelectorAll(focusableSelectors))
        .filter(el => el.tabIndex !== -1 && el.offsetParent !== null);

      const currentIndex = focusables.indexOf(activeEl);

      if (currentIndex >= 0 && currentIndex < focusables.length - 1) {
        e.preventDefault();
        const nextEl = focusables[currentIndex + 1];
        nextEl.focus();
        if (nextEl.select) {
          nextEl.select();
        }
      } else if (currentIndex === focusables.length - 1) {
        e.preventDefault();
        handleSave();
      }
    }
  };

  const handleEdit = (apt) => {
    setNewApt({ ...apt });
    setSelectedAptId(apt.id);
    setIsEditing(true);
    setOpen(true);
  };

  const handleCancelApt = (aptTarget) => {
    const aptObj = typeof aptTarget === 'object' ? aptTarget : appointments.find(a => a.id === aptTarget);
    if (!aptObj) return;

    if (confirm(`Are you sure you want to cancel the appointment for ${aptObj.patient}?`)) {
      const updated = appointments.map(apt =>
        apt.id === aptObj.id ? { ...apt, status: 'Cancelled' } : apt
      );
      setAppointments(updated);
      try {
        localStorage.setItem('optical_appointments', JSON.stringify(updated));
      } catch (e) {}

      if (isBackendId(aptObj.id)) {
        axios.patch(`/api/sales/appointments/${aptObj.id}/`, { status: 'Cancelled' }).catch(() => {});
      }

      // Send automated cancellation WhatsApp message
      sendWhatsAppCancellation(aptObj);
    }
  };

  const handleView = (apt) => {
    setViewingApt(apt);
    setViewOpen(true);
  };

  // Filtered appointments list
  const filteredAppointments = appointments.filter(apt => {
    const q = searchQuery.toLowerCase();
    const matchesSearch = (apt.patient || '').toLowerCase().includes(q) ||
                          (apt.phone || '').includes(q) ||
                          (apt.id || '').toLowerCase().includes(q) ||
                          (apt.token || '').toLowerCase().includes(q);
    const matchesDoc = filterDoctor === 'All' || apt.doctor === filterDoctor;
    return matchesSearch && matchesDoc;
  });

  return (
    <Box sx={{ p: 4, pb: 8 }}>
      {/* Module Header */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800, color: 'primary.main', display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <CalendarIcon sx={{ fontSize: 36 }} /> Future-Scope Clinic Appointment & Queue Manager
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Multi-branch doctor schedule coordination, automated WhatsApp reminders, and chair allocation
          </Typography>
        </Box>

        <Stack direction="row" spacing={1.5}>
          <Button
            variant="outlined"
            color="error"
            startIcon={<ClearIcon />}
            onClick={handleClearAllAppointments}
            sx={{ borderRadius: 2.5, px: 2.5, textTransform: 'none', fontWeight: 700 }}
          >
            Clear All Appointments
          </Button>
          <Button
            variant="contained"
            startIcon={<AddIcon />}
            onClick={handleOpen}
            sx={{ backgroundColor: '#2563EB', borderRadius: 2.5, px: 3, py: 1, textTransform: 'none', fontWeight: 700, boxShadow: '0 4px 14px rgba(37,99,235,0.3)' }}
          >
            + Book New Appointment
          </Button>
        </Stack>
      </Box>

      {/* Filter and Search Bar */}
      <Card variant="outlined" sx={{ p: 2, mb: 3, borderRadius: 3 }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={12} sm={7} md={8}>
            <TextField
              fullWidth
              size="small"
              placeholder="Search by Patient Name, Mobile Number, Token (T-101), or Appointment ID (APT-8402)..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{
                startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} />,
                sx: { borderRadius: 2 }
              }}
            />
          </Grid>

          <Grid item xs={12} sm={5} md={4}>
            <TextField
              select
              fullWidth
              size="small"
              label="Filter by Attending Doctor"
              value={filterDoctor}
              onChange={(e) => setFilterDoctor(e.target.value)}
              sx={{ borderRadius: 2 }}
            >
              <MenuItem value="All">All Doctors / Optometrists</MenuItem>
              {registeredDoctors.map(doc => (
                <MenuItem key={doc} value={doc}>{doc}</MenuItem>
              ))}
            </TextField>
          </Grid>
        </Grid>
      </Card>

      {/* Appointment Table */}
      <Card sx={{ borderRadius: 4, border: '1px solid', borderColor: 'divider', overflow: 'hidden' }}>
        <CardContent sx={{ p: 0 }}>
          <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
            <Table size="medium">
              <TableHead sx={{ backgroundColor: 'action.hover' }}>
                <TableRow>
                  <TableCell sx={{ fontWeight: 800, py: 1.8 }}>Appointment ID & Token</TableCell>
                  <TableCell sx={{ fontWeight: 800, py: 1.8 }}>Patient Demographics</TableCell>
                  <TableCell sx={{ fontWeight: 800, py: 1.8 }}>Attending Optometrist</TableCell>
                  <TableCell sx={{ fontWeight: 800, py: 1.8 }}>Schedule & Room</TableCell>
                  <TableCell sx={{ fontWeight: 800, py: 1.8 }}>Clinical Exam Type</TableCell>
                  <TableCell sx={{ fontWeight: 800, py: 1.8 }} align="center">Priority / Status</TableCell>
                  <TableCell sx={{ fontWeight: 800, py: 1.8 }} align="right">Actions</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {filteredAppointments.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={7} align="center" sx={{ py: 8 }}>
                      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                        <CalendarIcon sx={{ fontSize: 48, color: 'text.secondary', opacity: 0.5 }} />
                        <Typography variant="h6" color="text.secondary" fontWeight={800}>No Appointments Scheduled</Typography>
                        <Typography variant="body2" color="text.secondary">
                          {searchQuery || filterDoctor !== 'All' ? "No bookings match your search query." : "Click '+ Book New Appointment' to register a patient for clinical examination."}
                        </Typography>
                        <Button variant="contained" color="primary" startIcon={<AddIcon />} onClick={handleOpen} sx={{ mt: 2, borderRadius: 2 }}>
                          + Book Appointment Now
                        </Button>
                      </Box>
                    </TableCell>
                  </TableRow>
                ) : (
                  filteredAppointments.map((row) => (
                    <TableRow key={row.id} hover sx={{ '&:last-child td, &:last-child th': { border: 0 } }}>
                      <TableCell sx={{ py: 2 }}>
                        <Typography variant="subtitle2" fontWeight={800} color="primary.main">{row.id}</Typography>
                        <Chip 
                          label={row.token || 'T-101'} 
                          size="small" 
                          color="secondary" 
                          variant="outlined" 
                          sx={{ fontWeight: 800, borderRadius: 1.5, height: 22, mt: 0.5 }}
                        />
                      </TableCell>
                      
                      <TableCell sx={{ py: 2 }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 800 }}>{row.patient || 'Unregistered Patient'}</Typography>
                        <Typography variant="caption" color="text.secondary" display="block">📞 {row.phone || 'No Phone'}</Typography>
                        {row.email && <Typography variant="caption" color="text.secondary">{row.email}</Typography>}
                      </TableCell>

                      <TableCell sx={{ py: 2, fontWeight: 600 }}>
                        {row.doctor ? (
                          <Chip label={row.doctor} size="small" color="primary" variant="outlined" sx={{ fontWeight: 700 }} />
                        ) : (
                          <Typography variant="caption" color="text.secondary" fontStyle="italic">Unassigned</Typography>
                        )}
                      </TableCell>

                      <TableCell sx={{ py: 2 }}>
                        <Typography variant="body2" sx={{ fontWeight: 700 }}>📅 {row.date || 'Today'}</Typography>
                        <Typography variant="caption" color="primary.main" fontWeight={700} display="block">⏰ {row.time || '10:00 AM'}</Typography>
                        <Typography variant="caption" color="text.secondary">{row.room || 'Room 1'}</Typography>
                      </TableCell>

                      <TableCell sx={{ py: 2, color: 'text.primary', fontWeight: 600, fontSize: '0.85rem' }}>
                        {row.type}
                      </TableCell>

                      <TableCell align="center" sx={{ py: 2 }}>
                        <Stack spacing={0.5} alignItems="center">
                          <Chip 
                            label={row.status} 
                            size="small" 
                            color={row.status === 'Completed' ? 'success' : row.status === 'Cancelled' ? 'error' : row.status === 'Checked In' ? 'info' : 'primary'}
                            sx={{ fontWeight: 800, borderRadius: 1.5, minWidth: 90 }}
                          />
                          {row.priority && row.priority !== 'Standard Booking' && (
                            <Chip label={row.priority} size="small" color="warning" variant="outlined" sx={{ height: 18, fontSize: '0.65rem', fontWeight: 700 }} />
                          )}
                        </Stack>
                      </TableCell>

                      <TableCell align="right" sx={{ py: 2 }}>
                        <Stack direction="row" spacing={1} justifyContent="flex-end" alignItems="center">
                          {row.status !== 'Completed' && row.status !== 'Cancelled' && (
                            <Button 
                              variant="contained" 
                              size="small" 
                              sx={{ textTransform: 'none', borderRadius: 2, fontSize: '0.75rem', px: 1.5, py: 0.5, backgroundColor: '#2563EB', fontWeight: 700 }}
                              onClick={() => {
                                navigate('/optical/eyetest', {
                                  state: {
                                    appointment: {
                                      id: row.id,
                                      customerId: row.customerId || null,
                                      patientId: row.patientId || '',
                                      testNo: row.testNo || '',
                                      name: row.patient,
                                      phone: row.phone,
                                      email: row.email,
                                      age: row.age,
                                      gender: row.gender,
                                      optometrist: row.doctor,
                                      date: row.date,
                                      type: row.type
                                    }
                                  }
                                });
                              }}
                            >
                              Start Eye Test
                            </Button>
                          )}

                          <IconButton size="small" color="info" title="View Details" onClick={() => handleView(row)}>
                            <ViewIcon fontSize="small" />
                          </IconButton>

                          <IconButton size="small" sx={{ color: '#25D366' }} title="Send WhatsApp Confirmation" onClick={() => sendWhatsAppReminder(row)}>
                            <WhatsAppIcon fontSize="small" />
                          </IconButton>

                          <IconButton size="small" color="primary" title="Edit Appointment" onClick={() => handleEdit(row)}>
                            <EditIcon fontSize="small" />
                          </IconButton>

                          {row.status !== 'Completed' && row.status !== 'Cancelled' && (
                            <IconButton size="small" color="error" title="Cancel Appointment" onClick={() => handleCancelApt(row)}>
                              <CancelIcon fontSize="small" />
                            </IconButton>
                          )}
                        </Stack>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </CardContent>
      </Card>

      {/* Future-Scope Book Appointment Dialog */}
      <Dialog 
        open={open} 
        onClose={handleClose} 
        maxWidth="md" 
        fullWidth 
        PaperProps={{ sx: { borderRadius: 3.5, p: 1 } }}
      >
        <DialogTitle sx={{ fontWeight: 800, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <CalendarIcon color="primary" sx={{ fontSize: 28 }} />
            <Typography variant="h6" fontWeight={800}>
              {isEditing ? "Edit Appointment Booking" : "New Appointment Booking"}
            </Typography>
          </Box>
          <IconButton onClick={handleClose} size="small"><CancelIcon /></IconButton>
        </DialogTitle>

        <DialogContent dividers sx={{ py: 3 }} id="appointment-modal-container" onKeyDown={handleModalKeyDownEnter}>
          <Grid container spacing={2.5}>
            {/* Patient Hybrid Selection / Typing */}
            <Grid item xs={12} sm={7}>
              <Autocomplete
                freeSolo
                options={dbPatients}
                getOptionLabel={(opt) => (typeof opt === 'string' ? opt : `${opt.name} (${opt.patient_code || opt.phone || opt.id})`)}
                value={newApt.patient}
                onInputChange={(e, val) => setNewApt(prev => ({ ...prev, patient: val || '', customerId: null }))}
                onChange={(e, val) => handleSelectPatientObj(val)}
                renderInput={(params) => (
                  <TextField 
                    {...params}
                    required
                    fullWidth
                    label="Patient Name"
                    placeholder="Type or Search Patient..."
                    InputProps={{
                      ...params.InputProps,
                      startAdornment: (
                        <>
                          <PersonIcon color="action" sx={{ mr: 1, fontSize: 20 }} />
                          {params.InputProps.startAdornment}
                        </>
                      )
                    }}
                  />
                )}
              />
            </Grid>

            <Grid item xs={12} sm={5}>
              <TextField
                fullWidth
                label="Mobile Phone Number"
                placeholder="+91..."
                value={newApt.phone}
                onChange={(e) => setNewApt({ ...newApt, phone: e.target.value })}
              />
            </Grid>

            {/* Patient ID / Test No — auto-assigned (a fresh preview for a new patient, or the
                selected patient's own real ones), same as they'll appear on the Eye Test form
                when "Start Eye Test" is used from this appointment. Editable in case front desk
                needs to correct/override, matching how these fields behave on Eye Test itself. */}
            <Grid item xs={6} sm={3}>
              <TextField
                fullWidth
                label="Patient ID"
                value={newApt.patientId}
                onChange={(e) => setNewApt(prev => ({ ...prev, patientId: e.target.value }))}
                helperText="Auto-generated"
              />
            </Grid>
            <Grid item xs={6} sm={3}>
              <TextField
                fullWidth
                label="Test No (Optional)"
                placeholder="e.g. 1"
                value={newApt.testNo}
                onChange={(e) => setNewApt(prev => ({ ...prev, testNo: e.target.value }))}
                helperText="Leave blank if not needed"
              />
            </Grid>

            {/* Address / Place — collected here so it's already on file by the time this
                patient reaches the Eye Test form, instead of that form's Address/Place fields
                starting blank for every patient who was only ever booked, never test-registered. */}
            <Grid item xs={12} sm={7}>
              <TextField
                fullWidth
                label="Address (Optional)"
                placeholder="House / Street"
                value={newApt.address}
                onChange={(e) => setNewApt(prev => ({ ...prev, address: e.target.value }))}
              />
            </Grid>
            <Grid item xs={12} sm={5}>
              <TextField
                fullWidth
                label="Place / City (Optional)"
                placeholder="e.g. Kochi"
                value={newApt.place}
                onChange={(e) => setNewApt(prev => ({ ...prev, place: e.target.value }))}
              />
            </Grid>

            {/* Doctor Selector / Typing */}
            <Grid item xs={12} sm={6}>
              <Autocomplete
                freeSolo
                options={registeredDoctors}
                value={newApt.doctor}
                onInputChange={(e, val) => setNewApt(prev => ({ ...prev, doctor: val || '' }))}
                onChange={(e, val) => setNewApt(prev => ({ ...prev, doctor: val || '' }))}
                renderInput={(params) => (
                  <TextField 
                    {...params}
                    fullWidth
                    label="Attending Optometrist / Doctor"
                    placeholder="Select or Type Doctor..."
                    InputProps={{
                      ...params.InputProps,
                      startAdornment: (
                        <>
                          <DoctorIcon color="action" sx={{ mr: 1, fontSize: 20 }} />
                          {params.InputProps.startAdornment}
                        </>
                      )
                    }}
                  />
                )}
              />
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField 
                select 
                fullWidth 
                label="Examination Type" 
                value={newApt.type} 
                onChange={(e) => setNewApt({ ...newApt, type: e.target.value })}
              >
                {examTypesList.map(t => (
                  <MenuItem key={t} value={t}>{t}</MenuItem>
                ))}
              </TextField>
            </Grid>

            {/* Date & Quick Time Slot Chips */}
            <Grid item xs={12} sm={5}>
              <QuickDatePickerField 
                label="Appointment Date" 
                fullWidth 
                value={newApt.date} 
                onChange={(newDate) => setNewApt({ ...newApt, date: newDate })} 
                quickPresets={[
                  { label: 'Today', type: 'today' },
                  { label: 'Tomorrow', type: 'tomorrow' },
                  { label: 'In 3 Days', type: 'days', amount: 3 },
                  { label: 'In 1 Week', type: 'weeks', amount: 1 },
                ]}
              />
            </Grid>

            <Grid item xs={12} sm={7}>
              <TextField 
                fullWidth 
                label="Scheduled Time Slot" 
                placeholder="e.g. 10:00 AM"
                value={newApt.time} 
                onChange={(e) => setNewApt({ ...newApt, time: e.target.value })}
                InputProps={{
                  startAdornment: <TimeIcon color="action" sx={{ mr: 1, fontSize: 20 }} />
                }}
              />
              <Box sx={{ mt: 1, display: 'flex', gap: 0.8, flexWrap: 'wrap' }}>
                {presetTimeSlots.map(slot => (
                  <Chip 
                    key={slot} 
                    label={slot} 
                    size="small" 
                    clickable
                    color={newApt.time === slot ? 'primary' : 'default'}
                    onClick={() => setNewApt(prev => ({ ...prev, time: slot }))}
                    sx={{ fontSize: '0.72rem', fontWeight: 600 }}
                  />
                ))}
              </Box>
            </Grid>

            {/* Room Allocation & Priority Tagging */}
            <Grid item xs={12} sm={6}>
              <TextField 
                select 
                fullWidth 
                label="Assigned Examination Room" 
                value={newApt.room} 
                onChange={(e) => setNewApt({ ...newApt, room: e.target.value })}
              >
                {roomAllocations.map(r => (
                  <MenuItem key={r} value={r}>{r}</MenuItem>
                ))}
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6}>
              <TextField 
                select 
                fullWidth 
                label="Urgency & Priority Level" 
                value={newApt.priority} 
                onChange={(e) => setNewApt({ ...newApt, priority: e.target.value })}
              >
                {priorityLevels.map(p => (
                  <MenuItem key={p} value={p}>{p}</MenuItem>
                ))}
              </TextField>
            </Grid>

            {/* WhatsApp Integration Checkbox */}
            <Grid item xs={12}>
              <Paper variant="outlined" sx={{ p: 1.5, borderRadius: 2, bgcolor: 'rgba(37, 211, 102, 0.04)', borderColor: 'rgba(37, 211, 102, 0.3)' }}>
                <FormControlLabel 
                  control={
                    <Checkbox 
                      checked={newApt.sendWhatsapp} 
                      onChange={(e) => setNewApt({ ...newApt, sendWhatsapp: e.target.checked })} 
                      color="success"
                    />
                  }
                  label={
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                      <WhatsAppIcon sx={{ color: '#25D366' }} />
                      <Typography variant="subtitle2" fontWeight={700}>
                        Send Automated WhatsApp Confirmation & Appointment Reminder to Patient
                      </Typography>
                    </Box>
                  }
                />
              </Paper>
            </Grid>
          </Grid>
        </DialogContent>

        <DialogActions sx={{ p: 2.5 }}>
          <Button onClick={handleClose} sx={{ borderRadius: 2, textTransform: 'none', px: 3 }}>
            Cancel
          </Button>
          <Button 
            variant="contained" 
            onClick={handleSave} 
            sx={{ backgroundColor: '#2563EB', borderRadius: 2.5, px: 4, py: 1, fontWeight: 700, textTransform: 'none' }}
          >
            {isEditing ? "Save Booking Changes" : "Confirm Appointment Booking"}
          </Button>
        </DialogActions>
      </Dialog>

      {/* View Appointment Details Modal */}
      <Dialog open={viewOpen} onClose={() => setViewOpen(false)} maxWidth="xs" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
        <DialogTitle sx={{ fontWeight: 800 }}>Appointment Details</DialogTitle>
        <DialogContent dividers>
          {viewingApt && (
            <Stack spacing={2}>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">TOKEN & ID</Typography>
                <Typography variant="body1" fontWeight={800} color="secondary.main">{viewingApt.token || 'T-101'} • {viewingApt.id}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">PATIENT NAME & PHONE</Typography>
                <Typography variant="body1" fontWeight={700}>{viewingApt.patient}</Typography>
                <Typography variant="caption" color="text.secondary">📞 {viewingApt.phone || 'N/A'}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">OPTOMETRIST / DOCTOR</Typography>
                <Typography variant="body1" fontWeight={600} color="primary.main">{viewingApt.doctor || 'Unassigned'}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">SCHEDULED TIME & ROOM</Typography>
                <Typography variant="body1">📅 {viewingApt.date} @ {viewingApt.time}</Typography>
                <Typography variant="caption" color="text.secondary">{viewingApt.room || 'Room 1'}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">CLINICAL EXAM TYPE</Typography>
                <Typography variant="body1">{viewingApt.type}</Typography>
              </Box>
              <Box>
                <Typography variant="caption" color="text.secondary" display="block">STATUS</Typography>
                <Chip 
                  label={viewingApt.status} 
                  size="small" 
                  color={viewingApt.status === 'Completed' ? 'success' : viewingApt.status === 'Cancelled' ? 'error' : 'primary'}
                  sx={{ fontWeight: 700, mt: 0.5 }}
                />
              </Box>
            </Stack>
          )}
        </DialogContent>
        <DialogActions sx={{ p: 2, justifyContent: 'space-between' }}>
          {viewingApt && (
            <Button 
              variant="contained" 
              sx={{ bgcolor: '#25D366', color: '#fff', fontWeight: 700, '&:hover': { bgcolor: '#1eb954' } }}
              startIcon={<WhatsAppIcon />}
              onClick={() => sendWhatsAppReminder(viewingApt)}
            >
              Send WhatsApp
            </Button>
          )}
          <Button variant="outlined" onClick={() => setViewOpen(false)}>Close</Button>
        </DialogActions>
      </Dialog>

      {/* Automated Background Dispatch Toast Banner */}
      <Snackbar 
        open={toast.open} 
        autoHideDuration={4000} 
        onClose={() => setToast(prev => ({ ...prev, open: false }))}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        <Alert 
          onClose={() => setToast(prev => ({ ...prev, open: false }))} 
          severity={toast.severity} 
          variant="filled"
          sx={{ width: '100%', fontWeight: 700, borderRadius: 2.5, boxShadow: '0 8px 24px rgba(0,0,0,0.2)' }}
        >
          {toast.message}
        </Alert>
      </Snackbar>
    </Box>
  );
}
