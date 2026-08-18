import React, { useState } from 'react';
import { 
  Box, Card, CardContent, Typography, Grid, TextField, 
  MenuItem, Button, Checkbox, FormControlLabel, Paper, 
  Table, TableBody, TableCell, TableContainer, TableHead,
  TableRow, Stack, Divider, InputAdornment, Tooltip, Chip,
  Dialog, IconButton, Menu, ListItemIcon, ListItemText
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
  Edit as EditIcon
} from '@mui/icons-material';
import OrthopticsModal from './OrthopticsModal';
import PrintPrescriptionCard from './PrintPrescriptionCard';
import QuickDatePickerField from '../common/QuickDatePickerField';
import { printSalesInvoiceReceipt } from '../../utils/printInvoice';

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
  onPrint,
  onClearAll,
  testNo = '',
  testDate = '',
  nextVisitDate = '',
  setNextVisitDate,
  savedExams = [],
  onSelectExamFromHistory,
  nextPatientId = ''
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

  // Prints a billing invoice for a saved visit (procedure + medicine charges recorded at save time)
  const handlePrintInvoice = (row, paperSize = 'A4') => {
    const procCharge = parseFloat(row.procedureCharge || 0) || 0;
    const medCharge = parseFloat(row.medicineCharge || 0) || 0;
    printSalesInvoiceReceipt({
      invoiceNumber: `EYE-${row.testNo || row.id || ''}`,
      date: row.date,
      customerName: row.name,
      phone: row.phone,
      doctor: row.assignedOptometrist || row.optometrist || row.doctor,
      items: [
        { name: 'Eye Examination / Consultation Fee', qty: 1, price: procCharge },
        { name: 'Medicine / Pharmacy Charge', qty: 1, price: medCharge }
      ],
      total: procCharge + medCharge
    }, paperSize);
  };

  // Anchors the A4/A5 choice menu for the invoice print icon to whichever row's button was clicked
  const [invoicePrintMenu, setInvoicePrintMenu] = useState({ anchorEl: null, row: null });

  // Bottom Table Filter States
  const [historySearch, setHistorySearch] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  // Auto-generate Test No, Date, and Patient ID (Null-Safe)
  const safeExams = Array.isArray(savedExams) ? savedExams : [];
  const autoTestNo = testNo || diagnosis?.testNo || (safeExams.length + 1).toString();
  const autoDate = testDate || new Date().toISOString().split('T')[0];
  const autoPatientId = patientData?.id || nextPatientId || `P-${1001 + safeExams.length}`;

  const filteredHistory = safeExams.filter(e => {
    if (!e || e.name === 'Mohammed' || e.patientId === 'P-7375') return false;
    const q = (historySearch || '').toLowerCase();
    if (!q) return true;
    return (e.name || '').toLowerCase().includes(q) ||
      (e.phone || '').includes(q) ||
      (e.patientId || '').toLowerCase().includes(q) ||
      String(e.testNo || '').toLowerCase().includes(q) ||
      (e.gender || '').toLowerCase().includes(q) ||
      (e.assignedOptometrist || e.optometrist || e.doctor || '').toLowerCase().includes(q);
  });

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      {/* 📌 SECTION 1: Patient & Examination Registration Bar */}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1', boxShadow: '0 2px 10px rgba(0,0,0,0.02)' }}>
        <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <PersonIcon fontSize="small" /> 1. Patient Details & Examination Info
        </Typography>

        {/* Both rows share the exact same 7-column grid track definition, so items in Row 2
            that span multiple tracks line up pixel-perfectly under Row 1's columns — a plain
            MUI Grid can't guarantee this since flexbox gap distribution differs when the two
            rows have a different number of items. */}
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
                    onChange={(e) => setDiagnosis(prev => ({ ...prev, testNo: e.target.value }))}
                    inputProps={{ style: { fontWeight: 800 } }}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '2 / 3' } }}>
                  <TextField
                    fullWidth
                    size="small"
                    label="Patient ID"
                    value={autoPatientId}
                    onChange={(e) => setPatientData(prev => ({ ...prev, id: e.target.value }))}
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
                      sx={{ '& input': { fontWeight: 800, color: '#1e3a8a' } }}
                    />
                    <Tooltip title="Search Registered Patients">
                      <Button variant="contained" color="primary" onClick={onOpenSearchModal} sx={{ minWidth: 40, px: 1 }}>
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

              {/* Row 2: Date, Test Type, Optometrist, Mobile No — each spans the same tracks
                  as its Row 1 column group (Test No+Patient ID / Patient Name / Address+Place / Gender+Age) */}
              <Box sx={{ display: 'grid', gridTemplateColumns: colTemplate, gap: 1.5, alignItems: 'center' }}>
                <Box sx={{ gridColumn: { md: '1 / 3' } }}>
                  <QuickDatePickerField
                    label="Date"
                    value={autoDate}
                    onChange={(newDate) => setDiagnosis(prev => ({ ...prev, testDate: newDate }))}
                    quickPresets={[
                      { label: 'Today', type: 'today' },
                      { label: 'Yesterday', type: 'yesterday' },
                      { label: 'Tomorrow', type: 'tomorrow' }
                    ]}
                  />
                </Box>
                <Box sx={{ gridColumn: { md: '3 / 4' } }}>
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
                <Box sx={{ gridColumn: { md: '4 / 6' } }}>
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
                <Box sx={{ gridColumn: { md: '6 / 8' } }}>
                  <Box sx={{ display: 'flex', gap: 0.5 }}>
                    <TextField
                      fullWidth
                      size="small"
                      label="Mobile No"
                      value={patientData.phone || ''}
                      onChange={(e) => setPatientData(prev => ({ ...prev, phone: e.target.value }))}
                      inputProps={{ id: 'eyetest-mobile-input' }}
                      sx={{ '& input': { fontWeight: 700 } }}
                    />
                    <Button
                      variant="contained" color="success" size="small" startIcon={<SaveIcon fontSize="small" />}
                      onClick={onSaveDraft}
                      sx={{ textTransform: 'none', fontWeight: 800, borderRadius: 2, whiteSpace: 'nowrap', px: 2 }}
                    >
                      Save
                    </Button>
                  </Box>
                </Box>
              </Box>
            </>
          );
        })()}
      </Paper>

      {/* 👁️ SECTION 2: Objective & Clinical Measurements Grid */}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <MeasurementIcon fontSize="small" /> 2. Clinical Refraction & Measurement Grid
        </Typography>

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
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.autoRefraction?.od?.sph || ''} onChange={(e) => handleObjectiveAutoRef('od', 'sph', e.target.value)} /></Grid>
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
                <Grid item xs={3}><TextField fullWidth size="small" value={objectiveRefraction?.retinoscopy?.od?.sph || ''} onChange={(e) => handleRetinoscopy('od', 'sph', e.target.value)} /></Grid>
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
      </Paper>

      {/* 👓 SECTION 3: Previous Glasses (PGP) vs Acceptance Refraction (ACCP) */}
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
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={medicalHistory?.pgpOdSph || ''} onChange={(e) => setMedicalHistory(prev => ({ ...prev, pgpOdSph: e.target.value }))} inputProps={{ style: { textAlign: 'center', fontWeight: 700, fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
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
                    <TableCell sx={{ p: 0.2 }}><TextField fullWidth size="small" value={subjectiveRefraction?.od?.sph || ''} onChange={(e) => handleSubjectiveEye('od', 'sph', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800, color: '#2563eb', fontSize: '0.78rem', padding: '3px 2px' } }} /></TableCell>
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
                        value={subjectiveRefraction?.nearAdd || subjectiveRefraction?.odNv?.sph || ''} 
                        onChange={(e) => {
                          handleSubjectiveEye('odNv', 'sph', e.target.value);
                          setSubjectiveRefraction(prev => ({ ...prev, nearAdd: e.target.value }));
                        }} 
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
                        value={subjectiveRefraction?.nearAdd || subjectiveRefraction?.osNv?.sph || ''} 
                        onChange={(e) => {
                          handleSubjectiveEye('osNv', 'sph', e.target.value);
                          setSubjectiveRefraction(prev => ({ ...prev, nearAdd: e.target.value }));
                        }} 
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


      {/* 📋 SECTION 4: Clinical Notes & Management Plan */}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
          <ExamIcon fontSize="small" /> 4. Clinical Observations & Doctor Advice
        </Typography>

        <Grid container spacing={1.5}>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth multiline rows={2} size="small" label="C/O (Chief Complaints)"
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
          <Grid item xs={12} sm={4}>
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
      </Paper>

      {/* 💰 SECTION 5: Charges & Action Buttons Bar */}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Grid container spacing={2} alignItems="center">
          <Grid item xs={6} sm={2.5}>
            <TextField
              fullWidth size="small" label="Procedure Charge"
              value={diagnosis?.procedureCharge || '0'}
              onChange={(e) => setDiagnosis(prev => ({ ...prev, procedureCharge: e.target.value }))}
              InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
            />
          </Grid>
          <Grid item xs={6} sm={2.5}>
            <TextField
              fullWidth size="small" label="Medicine Charge"
              value={diagnosis?.medicineCharge || '0'}
              onChange={(e) => setDiagnosis(prev => ({ ...prev, medicineCharge: e.target.value }))}
              InputProps={{ startAdornment: <InputAdornment position="start">₹</InputAdornment> }}
            />
          </Grid>

          <Grid item xs={12} sm={7} sx={{ display: 'flex', gap: 1, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            <Button variant="outlined" color="primary" startIcon={<MedicalIcon />} onClick={() => setOrthopticsOpen(true)} sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 2 }}>
              Orthoptics Form
            </Button>
            <Button variant="outlined" color="secondary" startIcon={<PrintIcon />} onClick={() => setPrintModalOpen(true)} sx={{ textTransform: 'none', fontWeight: 700, borderRadius: 2 }}>
              Rx Print
            </Button>
            <Button variant="contained" color="success" startIcon={<SaveIcon />} onClick={onSaveDraft} sx={{ textTransform: 'none', fontWeight: 800, borderRadius: 2, px: 3 }}>
              Save Clinical Record
            </Button>
            <Button variant="outlined" color="inherit" startIcon={<ClearIcon />} onClick={onClearAll} sx={{ textTransform: 'none', fontWeight: 600, borderRadius: 2 }}>
              Clear Form
            </Button>
          </Grid>
        </Grid>
      </Paper>

      {/* 📜 SECTION 6: Saved Examination Directory Search Table */}
      <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1.5, flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <SearchIcon /> Recent Examination Directory ({filteredHistory.length})
          </Typography>

          <Stack direction="row" spacing={1} alignItems="center">
            <TextField
              size="small" placeholder="Search Test No, Patient ID, Name, Gender, Optometrist..."
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

        <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid #e2e8f0', borderRadius: 2, maxHeight: 220 }}>
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
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filteredHistory.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={10} align="center" sx={{ py: 3, color: 'text.secondary' }}>
                    No recent examinations saved in database. Click "Save Clinical Record" to log tests.
                  </TableCell>
                </TableRow>
              ) : (
                filteredHistory.map((row, idx) => (
                  <TableRow key={idx} hover sx={{ cursor: 'pointer' }} onClick={() => onSelectExamFromHistory && onSelectExamFromHistory(row)}>
                    <TableCell sx={{ fontWeight: 800 }}>#{row.testNo || idx + 1}</TableCell>
                    <TableCell>{row.date || '—'}</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>{row.patientId || '—'}</TableCell>
                    <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{row.name || '—'}</TableCell>
                    <TableCell>{row.age || '—'} / {row.gender || '—'}</TableCell>
                    <TableCell>{row.phone || 'N/A'}</TableCell>
                    <TableCell>{row.address || row.patientData?.address || '—'}</TableCell>
                    <TableCell>{row.place || row.patientData?.place || row.patientData?.city || '—'}</TableCell>
                    <TableCell>{row.assignedOptometrist || row.optometrist || row.doctor || '—'}</TableCell>
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
    </Box>
  );
}
