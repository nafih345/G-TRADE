import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import axios from 'axios';
import {
  Box, Card, CardContent, Typography, Button, Grid,
  Paper, Chip, TextField, Stack, IconButton, Avatar,
  Divider, InputAdornment, Tabs, Tab, Alert, Table,
  TableBody, TableCell, TableContainer, TableHead, TableRow, Tooltip,
  Dialog, DialogContent
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
  DeleteSweep as ClearIcon
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

export default function PatientHistory() {
  const navigate = useNavigate();
  const location = useLocation();

  // State Definitions
  const [patients, setPatients] = useState([]);
  const [examinations, setExaminations] = useState([]);
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
    ? examinations.filter(e => {
        const pId = String(selectedPatient.id || '').toLowerCase().trim();
        const pPhone = String(selectedPatient.phone || '').toLowerCase().trim();
        const pName = String(selectedPatient.name || '').toLowerCase().trim();

        const ePatientId = String(e.patientId || e.patient_id || '').toLowerCase().trim();
        const ePhone = String(e.phone || '').toLowerCase().trim();
        const eName = String(e.name || e.patient_name || '').toLowerCase().trim();

        const matchId = pId && ePatientId && pId === ePatientId;
        const matchPhone = pPhone && ePhone && pPhone !== 'no mobile' && pPhone === ePhone;
        const matchName = pName && eName && (pName.includes(eName) || eName.includes(pName));

        return matchId || matchPhone || matchName;
      })
    : [];

  const patientExams = rawPatientExams;

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
            Two-panel split workspace: Inspect past eye tests, refraction power progression, spectacle orders, and risk alerts
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
                  const rawCount = examinations.filter(e => {
                    const pId = String(p.id || '').toLowerCase().trim();
                    const pPhone = String(p.phone || '').toLowerCase().trim();
                    const pName = String(p.name || '').toLowerCase().trim();

                    const ePatientId = String(e.patientId || e.patient_id || '').toLowerCase().trim();
                    const ePhone = String(e.phone || '').toLowerCase().trim();
                    const eName = String(e.name || e.patient_name || '').toLowerCase().trim();

                    return (pId && ePatientId && pId === ePatientId) ||
                           (pPhone && ePhone && pPhone !== 'no mobile' && pPhone === ePhone) ||
                           (pName && eName && (pName.includes(eName) || eName.includes(pName)));
                  }).length;
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
