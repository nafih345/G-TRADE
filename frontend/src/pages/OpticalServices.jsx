import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useLocation, useNavigate } from 'react-router-dom';
import { 
  Box, Card, CardContent, Typography, Grid, TextField, 
  Button, MenuItem, Tabs, Tab, Table, TableBody, 
  TableCell, TableContainer, TableHead, TableRow, Paper, 
  Divider, Stack, Checkbox, FormControlLabel, FormGroup, 
  Chip, Autocomplete, Tooltip, Alert, Accordion, AccordionSummary, AccordionDetails,
  InputAdornment
} from '@mui/material';
import { 
  Visibility as EyeIcon, 
  Print as PrintIcon, 
  AssignmentTurnedIn as SaveIcon,
  NavigateNext as NextIcon,
  NavigateBefore as BackIcon,
  History as HistoryIcon,
  Healing as HealthIcon,
  ContactPage as ContactIcon,
  LocalShippingOutlined as RecommendationIcon,
  ExpandMore as ExpandMoreIcon,
  Warning as WarningIcon,
  Search as SearchIcon
} from '@mui/icons-material';

const chiefComplaints = [
  'Blurred Distance Vision', 'Blurred Near Vision', 'Headache', 'Eye Strain', 
  'Redness', 'Watering Eyes', 'Itching', 'Burning Sensation', 
  'Double Vision', 'Light Sensitivity', 'Broken Glasses', 'Contact Lens Problem', 'Routine Check-up'
];

const normalSevereOptions = ['Normal', 'Mild', 'Moderate', 'Severe'];

export default function OpticalServices() {
  const location = useLocation();
  const [viewMode, setViewMode] = useState('list'); // 'list' or 'form'
  const [testPatients, setTestPatients] = useState([]);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterBranch, setFilterBranch] = useState('All');
  const [filterOptometrist, setFilterOptometrist] = useState('All');

  const [activeStep, setActiveStep] = useState(0);
  const [patientData, setPatientData] = useState({
    id: `P-${Math.floor(1000 + Math.random() * 9000)}`, 
    name: '', 
    age: '', 
    gender: 'Male', 
    phone: '', 
    email: '', 
    address: '', 
    occupation: '',
    assignedOptometrist: 'Dr. Sarah Connor', 
    branch: 'Main Branch', 
    appointmentNum: `APT-${Math.floor(1000 + Math.random() * 9000)}`, 
    visitNum: `VIS-${Math.floor(100 + Math.random() * 900)}`,
    lastVisitDate: '', 
    previousPrescription: 'No previous prescription records available.',
    visitHistory: []
  });

  const [companyInfo, setCompanyInfo] = useState({
    name: 'GREENSOL VISION CLINIC',
    logo: null,
    address: '',
    phone: '',
    email: ''
  });

  const [registeredDoctors, setRegisteredDoctors] = useState([]);

  // Fetch Registered Doctors from Administration Module / Users Database
  useEffect(() => {
    const fetchRegisteredDoctors = async () => {
      let docList = [];
      try {
        const savedUsers = JSON.parse(localStorage.getItem('optical_users_db') || '[]');
        savedUsers.forEach(u => {
          if (u.name) docList.push(u.name);
        });
      } catch (e) {}

      try {
        const res = await axios.get('/api/auth/users/');
        if (res.data && Array.isArray(res.data)) {
          res.data.forEach(u => {
            const name = u.first_name ? `${u.first_name} ${u.last_name || ''}`.trim() : u.username;
            if (name) docList.push(name);
          });
        }
      } catch (e) {}

      const uniqueDocs = Array.from(new Set(docList));
      setRegisteredDoctors(uniqueDocs);
      if (uniqueDocs.length > 0 && (!patientData.assignedOptometrist || patientData.assignedOptometrist === 'Dr. Sarah Connor')) {
        setPatientData(prev => ({ ...prev, assignedOptometrist: uniqueDocs[0] }));
      }
    };

    fetchRegisteredDoctors();
  }, [viewMode]);

  useEffect(() => {
    const fetchCompany = async () => {
      try {
        const res = await axios.get('/api/company/profile/');
        if (res.data && res.data.length > 0) {
          setCompanyInfo(res.data[0]);
        }
      } catch (err) {
        console.error('Failed to load company profile:', err);
      }
    };
    fetchCompany();
  }, []);

  useEffect(() => {
    if (location.state) {
      if (location.state.appointment) {
        const apt = location.state.appointment;
        setPatientData({
          id: `P-${Math.floor(1000 + Math.random() * 9000)}`, 
          name: apt.name, 
          age: '', 
          gender: 'Male', 
          phone: apt.phone || '', 
          email: '', 
          address: '', 
          occupation: '',
          assignedOptometrist: apt.optometrist || 'Dr. Sarah Connor', 
          branch: 'Main Branch', 
          appointmentNum: apt.id, 
          visitNum: `VIS-${Math.floor(100 + Math.random() * 900)}`,
          lastVisitDate: apt.date || '', 
          previousPrescription: 'No previous prescription records available.',
          visitHistory: []
        });
        setActiveStep(0);
        setViewMode('form');
      } else if (location.state.newTest || location.state.fromSales) {
        handleAddNewTest();
      }
    }
  }, [location.state]);

  // Tab 2: Complaints & History
  const [selectedComplaints, setSelectedComplaints] = useState([]);
  const [complaintDuration, setComplaintDuration] = useState('');
  const [glassesUsage, setGlassesUsage] = useState('');
  const [clUsage, setClUsage] = useState('');
  const [medicalHistory, setMedicalHistory] = useState('');
  const [familyHistory, setFamilyHistory] = useState('');
  const [allergies, setAllergies] = useState('');
  const [medications, setMedications] = useState('');
  const [surgeryHistory, setSurgeryHistory] = useState('');

  // Tab 3: Visual Acuity
  const [vaODDistanceUnaided, setVaODDistanceUnaided] = useState('');
  const [vaODDistanceCorrected, setVaODDistanceCorrected] = useState('');
  const [vaODPinhole, setVaODPinhole] = useState('');
  const [vaODNear, setVaODNear] = useState('');
  const [vaODColour, setVaODColour] = useState('');
  const [vaODContrast, setVaODContrast] = useState('');

  const [vaOSDistanceUnaided, setVaOSDistanceUnaided] = useState('');
  const [vaOSDistanceCorrected, setVaOSDistanceCorrected] = useState('');
  const [vaOSPinhole, setVaOSPinhole] = useState('');
  const [vaOSNear, setVaOSNear] = useState('');
  const [vaOSColour, setVaOSColour] = useState('');
  const [vaOSContrast, setVaOSContrast] = useState('');

  const [vaOUBinocular, setVaOUBinocular] = useState('');
  const [vaOUStereo, setVaOUStereo] = useState('');
  const [vaOUDominant, setVaOUDominant] = useState('');
  const [vaOUFusion, setVaOUFusion] = useState('');

  // Tab 4: Objective Refraction
  const [arSphOD, setArSphOD] = useState('');
  const [arCylOD, setArCylOD] = useState('');
  const [arAxisOD, setArAxisOD] = useState('');
  const [arVertexOD, setArVertexOD] = useState('');
  const [arPupilOD, setArPupilOD] = useState('');

  const [arSphOS, setArSphOS] = useState('');
  const [arCylOS, setArCylOS] = useState('');
  const [arAxisOS, setArAxisOS] = useState('');
  const [arVertexOS, setArVertexOS] = useState('');
  const [arPupilOS, setArPupilOS] = useState('');

  const [k1OD, setK1OD] = useState('');
  const [k2OD, setK2OD] = useState('');
  const [kAxisOD, setKAxisOD] = useState('');
  const [k1OS, setK1OS] = useState('');
  const [k2OS, setK2OS] = useState('');
  const [kAxisOS, setKAxisOS] = useState('');

  const [distancePD, setDistancePD] = useState('');
  const [nearPD, setNearPD] = useState('');
  const [monoRightPD, setMonoRightPD] = useState('');
  const [monoLeftPD, setMonoLeftPD] = useState('');

  const [iopRight, setIopRight] = useState('');
  const [iopLeft, setIopLeft] = useState('');

  // Tab 5: Subjective Refraction
  const [subSphOD, setSubSphOD] = useState('');
  const [subCylOD, setSubCylOD] = useState('');
  const [subAxisOD, setSubAxisOD] = useState('');
  const [subVaOD, setSubVaOD] = useState('');
  const [subAddOD, setSubAddOD] = useState('');
  const [subPrismOD, setSubPrismOD] = useState('');
  const [subBaseOD, setSubBaseOD] = useState('');

  const [subSphOS, setSubSphOS] = useState('');
  const [subCylOS, setSubCylOS] = useState('');
  const [subAxisOS, setSubAxisOS] = useState('');
  const [subVaOS, setSubVaOS] = useState('');
  const [subAddOS, setSubAddOS] = useState('');
  const [subPrismOS, setSubPrismOS] = useState('');
  const [subBaseOS, setSubBaseOS] = useState('');

  const [binocularBalance, setBinocularBalance] = useState('');
  const [accommodationRange, setAccommodationRange] = useState('');
  const [vergenceRange, setVergenceRange] = useState('');
  const [phoriaTest, setPhoriaTest] = useState('');
  const [npc, setNpc] = useState('');

  // Tab 6: Eye Health
  const [eyelids, setEyelids] = useState('Normal');
  const [conjunctiva, setConjunctiva] = useState('Normal');
  const [cornea, setCornea] = useState('Normal');
  const [anteriorChamber, setAnteriorChamber] = useState('Normal');
  const [iris, setIris] = useState('Normal');
  const [lensState, setLensState] = useState('Normal');
  const [eyeHealthNotes, setEyeHealthNotes] = useState('');

  const [opticDisc, setOpticDisc] = useState('');
  const [retina, setRetina] = useState('');
  const [macula, setMacula] = useState('');
  const [vitreous, setVitreous] = useState('');
  const [bloodVessels, setBloodVessels] = useState('');

  const [pupillaryReflex, setPupillaryReflex] = useState('');
  const [eyeMovement, setEyeMovement] = useState('');
  const [coverTest, setCoverTest] = useState('');
  const [tearFilm, setTearFilm] = useState('');

  // Tab 7: Contact Lens Trial
  const [clBrand, setClBrand] = useState('');
  const [clType, setClType] = useState('');
  const [clPower, setClPower] = useState('');
  const [clBC, setClBC] = useState('');
  const [clDIA, setClDIA] = useState('');
  const [clWearTime, setClWearTime] = useState('');
  const [clComfort, setClComfort] = useState('');
  const [clImprovement, setClImprovement] = useState('');
  const [clRecommend, setClRecommend] = useState('');

  // Tab 9: Recommendations & Details
  const [recLensType, setRecLensType] = useState('');
  const [recLensBrand, setRecLensBrand] = useState('');
  const [recLensCoating, setRecLensCoating] = useState('');
  const [recFrameShape, setRecFrameShape] = useState('');
  const [recFrameBrand, setRecFrameBrand] = useState('');
  const [recFrameSize, setRecFrameSize] = useState('');
  const [recFrameColor, setRecFrameColor] = useState('');
  const [recDiagnosis, setRecDiagnosis] = useState([]);
  const [followUpDate, setFollowUpDate] = useState('');
  const [followUpInterval, setFollowUpInterval] = useState('');



  const handleNext = () => {
    if (activeStep < 8) {
      setActiveStep(prev => prev + 1);
    }
  };

  const handleBack = () => {
    if (activeStep > 0) {
      setActiveStep(prev => prev - 1);
    }
  };

  const handleComplaintToggle = (complaint) => {
    setSelectedComplaints(prev => 
      prev.includes(complaint) ? prev.filter(c => c !== complaint) : [...prev, complaint]
    );
  };

  const getHighIopWarning = () => {
    const r = parseFloat(iopRight) || 0;
    const l = parseFloat(iopLeft) || 0;
    if (r > 21 || l > 21) {
      return `Warning: High Intraocular Pressure detected (Right: ${iopRight} mmHg, Left: ${iopLeft} mmHg).`;
    }
    return '';
  };

  const handleExportToExcel = () => {
    let csvContent = "data:text/csv;charset=utf-8,";
    csvContent += "Patient ID,Patient Name,Age,Gender,Phone,Optometrist,Branch,Date\r\n";
    testPatients.forEach(row => {
      csvContent += `"${row.id}","${row.name}","${row.age}","${row.gender}","${row.phone}","${row.optometrist}","${row.branch}","${row.date}"\r\n`;
    });
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", "eye_testing_patients.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleAddNewTest = () => {
    setPatientData({
      id: `P-${Math.floor(1000 + Math.random() * 9000)}`, 
      name: '', 
      age: '', 
      gender: 'Male', 
      phone: '', 
      email: '', 
      address: '', 
      occupation: '',
      assignedOptometrist: 'Dr. Sarah Connor', 
      branch: 'Main Branch', 
      appointmentNum: `APT-${Math.floor(1000 + Math.random() * 9000)}`, 
      visitNum: `VIS-${Math.floor(100 + Math.random() * 900)}`,
      lastVisitDate: '', 
      previousPrescription: 'No previous prescription records available.',
      visitHistory: []
    });
    setActiveStep(0);
    setViewMode('form');
  };

  const handleSaveExam = () => {
    if (!patientData.name) {
      alert("Please enter at least the Patient Name.");
      return;
    }
    const newTestRecord = {
      id: patientData.id,
      name: patientData.name,
      age: patientData.age,
      gender: patientData.gender,
      phone: patientData.phone || '9876543210',
      optometrist: patientData.assignedOptometrist,
      branch: patientData.branch,
      date: new Date().toISOString().split('T')[0],
      points: 120,
      tier: 'Silver',
      sphRight: subSphOD || '-1.25',
      cylRight: subCylOD || '-0.50',
      axisRight: subAxisOD || '90',
      sphLeft: subSphOS || '-1.00',
      cylLeft: subCylOS || '-0.75',
      axisLeft: subAxisOS || '180',
      doctor: patientData.assignedOptometrist || 'Dr. Sarah Connor',
      balance: 0,
      hasSpecBooking: true,
      specDetails: {
        bookingId: `SPEC-${Math.floor(1000 + Math.random() * 9000)}`,
        date: new Date().toISOString().split('T')[0],
        frameRec: recFrameBrand || 'RayBan Wayfarer Classic (Black)',
        lensRec: recLensBrand ? `${recLensBrand} ${recLensType}` : 'Essilor Crizal Prevencia 1.56 Anti-Glare',
        status: 'Booked for Spectacles (Optical Exam Completed)'
      }
    };
    setTestPatients(prev => [newTestRecord, ...prev]);

    if (location.state && location.state.fromSales) {
      alert("Eye Test examination & spectacle booking saved successfully! Transferring patient details to Sales POS...");
      navigate('/sales/new', { state: { newPatient: newTestRecord } });
    } else {
      alert("Examination record & spectacle booking saved successfully to system database!");
      setViewMode('list');
    }
  };

  if (viewMode === 'list') {
    const filteredPatients = testPatients.filter(p => {
      const matchesSearch = p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            p.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            (p.phone && p.phone.toLowerCase().includes(searchQuery.toLowerCase()));
      const matchesBranch = filterBranch === 'All' || p.branch === filterBranch;
      const matchesOptometrist = filterOptometrist === 'All' || p.optometrist === filterOptometrist;
      return matchesSearch && matchesBranch && matchesOptometrist;
    });

    return (
      <Box sx={{ p: 4 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
          <Box>
            <Typography variant="h4" sx={{ fontWeight: 800 }}>VisionERP Eye Testing Queue</Typography>
            <Typography variant="body2" color="text.secondary">Review list of patients scheduled for clinical eye assessment tests</Typography>
          </Box>
          <Stack direction="row" spacing={2} alignItems="center" flexWrap="wrap">
            <TextField 
              placeholder="Search by Phone or Patient ID..."
              variant="outlined"
              size="small"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              InputProps={{
                startAdornment: (
                  <InputAdornment position="start">
                    <SearchIcon color="action" />
                  </InputAdornment>
                ),
                sx: { borderRadius: 3, backgroundColor: 'background.paper', width: 280 }
              }}
            />
            <Button variant="outlined" startIcon={<PrintIcon />} onClick={handleExportToExcel}>
              Export Queue to Excel
            </Button>
            <Button variant="contained" startIcon={<EyeIcon />} sx={{ backgroundColor: '#2563EB' }} onClick={handleAddNewTest}>
              + Add Eye Test
            </Button>
          </Stack>
        </Box>

        {/* Filters Setup Under the Search Option */}
        <Box sx={{ mb: 4, display: 'flex', gap: 2, alignItems: 'center', flexWrap: 'wrap' }}>
          <Typography variant="body2" sx={{ fontWeight: 700, color: 'text.secondary' }}>Filter By:</Typography>
          <TextField
            select
            size="small"
            label="Branch"
            value={filterBranch}
            onChange={(e) => setFilterBranch(e.target.value)}
            sx={{ minWidth: 150 }}
            InputProps={{ sx: { borderRadius: 2 } }}
          >
            <MenuItem value="All">All Branches</MenuItem>
            <MenuItem value="Main Branch">Main Branch</MenuItem>
            <MenuItem value="Downtown Outlet">Downtown Outlet</MenuItem>
            <MenuItem value="East Wing Clinic">East Wing Clinic</MenuItem>
          </TextField>

          <TextField
            select
            size="small"
            label="Optometrist"
            value={filterOptometrist}
            onChange={(e) => setFilterOptometrist(e.target.value)}
            sx={{ minWidth: 180 }}
            InputProps={{ sx: { borderRadius: 2 } }}
          >
            <MenuItem value="All">All Optometrists</MenuItem>
            {registeredDoctors.map(doc => (
              <MenuItem key={doc} value={doc}>{doc}</MenuItem>
            ))}
          </TextField>

          {(filterBranch !== 'All' || filterOptometrist !== 'All' || searchQuery) && (
            <Button variant="text" size="small" color="secondary" onClick={() => {
              setFilterBranch('All');
              setFilterOptometrist('All');
              setSearchQuery('');
            }}>
              Clear Filters
            </Button>
          )}
        </Box>

        <Card sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 4 }}>
          <CardContent sx={{ p: 0 }}>
            <TableContainer component={Paper} elevation={0} sx={{ backgroundColor: 'transparent' }}>
              <Table size="small">
                <TableHead sx={{ backgroundColor: 'action.hover' }}>
                  <TableRow>
                    <TableCell sx={{ fontWeight: 700 }}>Patient ID</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Patient Name</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Age</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Gender</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Phone Number</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Optometrist</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Branch Location</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Date Scheduled</TableCell>
                    <TableCell sx={{ fontWeight: 700 }}>Action</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {filteredPatients.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} align="center" sx={{ py: 6 }}>
                        <Typography variant="body2" color="text.secondary" fontWeight={500}>
                          {searchQuery ? "No matching patients found." : "No patients currently in the testing queue."}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {searchQuery ? "Try refining your search query." : "Click '+ Add Eye Test' above to register a patient manually."}
                        </Typography>
                      </TableCell>
                    </TableRow>
                  ) : (
                    filteredPatients.map((row) => (
                      <TableRow key={row.id} hover>
                        <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>{row.id}</TableCell>
                        <TableCell sx={{ fontWeight: 600 }}>{row.name}</TableCell>
                        <TableCell>{row.age}</TableCell>
                        <TableCell>{row.gender}</TableCell>
                        <TableCell>{row.phone}</TableCell>
                        <TableCell>{row.optometrist}</TableCell>
                        <TableCell>{row.branch}</TableCell>
                        <TableCell>{row.date}</TableCell>
                        <TableCell>
                          <Stack direction="row" spacing={1}>
                            <Button size="small" variant="text" onClick={() => {
                              setPatientData({
                                id: row.id,
                                name: row.name,
                                age: row.age,
                                gender: row.gender,
                                phone: row.phone,
                                email: '',
                                address: '',
                                occupation: '',
                                assignedOptometrist: row.optometrist,
                                branch: row.branch,
                                appointmentNum: `APT-${Math.floor(1000 + Math.random() * 9000)}`,
                                visitNum: `VIS-${Math.floor(100 + Math.random() * 900)}`,
                                lastVisitDate: '',
                                previousPrescription: '',
                                visitHistory: []
                              });
                              setActiveStep(0);
                              setViewMode('form');
                            }}>
                              Examine
                            </Button>
                            <Button 
                              size="small" 
                              variant="text" 
                              color="error" 
                              onClick={() => {
                                if (window.confirm(`Are you sure you want to delete patient "${row.name}" from the queue?`)) {
                                  setTestPatients(prev => prev.filter(p => p.id !== row.id));
                                }
                              }}
                            >
                              Delete
                            </Button>
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
      </Box>
    );
  }

  return (
    <Box sx={{ p: 4 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3 }}>
        <Box>
          <Typography variant="h4" sx={{ fontWeight: 800 }}>VisionERP Eye Examination System</Typography>
          <Typography variant="body2" color="text.secondary">Professional optometry workflow and diagnostic refraction manager</Typography>
        </Box>
        <Button variant="outlined" onClick={() => setViewMode('list')}>
          Back to Queue
        </Button>
      </Box>

      {/* Main Grid: Forms & Sidebar */}
      <Grid container spacing={3} sx={{ position: 'relative', pb: 10 }}>
        {/* Left Side: Exam content Stepper */}
        <Grid item xs={12} md={8.5}>
          <Tabs 
            value={activeStep} 
            onChange={(e, v) => setActiveStep(v)} 
            variant="scrollable"
            scrollButtons="auto"
            sx={{ borderBottom: 1, borderColor: 'divider', mb: 3 }}
          >
            <Tab label="1. Patient Info" />
            <Tab label="2. History" />
            <Tab label="3. Visual Acuity" />
            <Tab label="4. Objective Refraction" />
            <Tab label="5. Subjective Refraction" />
            <Tab label="6. Eye Health" />
            <Tab label="7. CL Trial" />
            <Tab label="8. Final Rx" />
            <Tab label="9. Recommendation" />
          </Tabs>

          <Card sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 4, mb: 4 }}>
            <CardContent sx={{ p: 3 }}>
              {/* Tab 1: Patient Information */}
              {activeStep === 0 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography variant="h6" fontWeight={700}>Patient Profile & Demographics</Typography>
                    <Typography variant="caption" color="text.secondary">Enter patient profile details manually to save in the system</Typography>
                  </Box>
                  <Grid container spacing={2}>
                    <Grid item xs={12} sm={3}>
                      <TextField 
                        label="Patient ID" 
                        fullWidth 
                        value={patientData.id || ''} 
                        onChange={(e) => setPatientData({ ...patientData, id: e.target.value })} 
                      />
                    </Grid>
                    <Grid item xs={12} sm={5}>
                      <TextField 
                        label="Patient Name" 
                        fullWidth 
                        value={patientData.name || ''} 
                        onChange={(e) => setPatientData({ ...patientData, name: e.target.value })} 
                      />
                    </Grid>

                    <Grid item xs={6} sm={2}>
                      <TextField 
                        label="Age" 
                        fullWidth 
                        value={patientData.age || ''} 
                        onChange={(e) => setPatientData({ ...patientData, age: e.target.value })} 
                      />
                    </Grid>
                    <Grid item xs={6} sm={2}>
                      <TextField 
                        select
                        label="Gender" 
                        fullWidth 
                        value={patientData.gender || 'Male'} 
                        onChange={(e) => setPatientData({ ...patientData, gender: e.target.value })} 
                      >
                        <MenuItem value="Male">Male</MenuItem>
                        <MenuItem value="Female">Female</MenuItem>
                        <MenuItem value="Other">Other</MenuItem>
                      </TextField>
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField 
                        label="Phone Number" 
                        fullWidth 
                        value={patientData.phone || ''} 
                        onChange={(e) => setPatientData({ ...patientData, phone: e.target.value })} 
                      />
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField 
                        label="Email" 
                        fullWidth 
                        value={patientData.email || ''} 
                        onChange={(e) => setPatientData({ ...patientData, email: e.target.value })} 
                      />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField 
                        label="Occupation" 
                        fullWidth 
                        value={patientData.occupation || ''} 
                        onChange={(e) => setPatientData({ ...patientData, occupation: e.target.value })} 
                      />
                    </Grid>
                    <Grid item xs={12}>
                      <TextField 
                        label="Address" 
                        fullWidth 
                        value={patientData.address || ''} 
                        onChange={(e) => setPatientData({ ...patientData, address: e.target.value })} 
                      />
                    </Grid>
                  </Grid>

                  <Divider />

                  <Typography variant="subtitle1" fontWeight={700} color="primary">Clinic Metadata</Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={6} sm={3}>
                      <TextField 
                        label="Appointment ID" 
                        fullWidth 
                        value={patientData.appointmentNum || ''} 
                        onChange={(e) => setPatientData({ ...patientData, appointmentNum: e.target.value })} 
                      />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField 
                        label="Visit Number" 
                        fullWidth 
                        value={patientData.visitNum || ''} 
                        onChange={(e) => setPatientData({ ...patientData, visitNum: e.target.value })} 
                      />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField 
                        select
                        label="Branch" 
                        fullWidth 
                        value={patientData.branch || 'Main Branch'} 
                        onChange={(e) => setPatientData({ ...patientData, branch: e.target.value })} 
                      >
                        <MenuItem value="Main Branch">Main Branch</MenuItem>
                        <MenuItem value="Downtown Outlet">Downtown Outlet</MenuItem>
                        <MenuItem value="East Wing Clinic">East Wing Clinic</MenuItem>
                      </TextField>
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField 
                        select
                        label="Optometrist / Doctor" 
                        fullWidth 
                        value={patientData.assignedOptometrist || (registeredDoctors[0] || '')} 
                        onChange={(e) => setPatientData({ ...patientData, assignedOptometrist: e.target.value })} 
                      >
                        {registeredDoctors.length === 0 ? (
                          <MenuItem value="" disabled>-- No Doctors Added Yet (Add in Admin -&gt; Users) --</MenuItem>
                        ) : (
                          registeredDoctors.map(doc => (
                            <MenuItem key={doc} value={doc}>{doc}</MenuItem>
                          ))
                        )}
                      </TextField>
                    </Grid>
                  </Grid>
                </Stack>
              )}

              {/* Tab 2: Chief Complaint & History */}
              {activeStep === 1 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography variant="h6" fontWeight={700}>Chief Complaint & Patient History</Typography>
                    <Typography variant="caption" color="text.secondary">Record active visual impairments and patient medical logs</Typography>
                  </Box>
                  
                  <Box>
                    <Typography variant="subtitle2" fontWeight={700} gutterBottom>Select Complaints</Typography>
                    <FormGroup row sx={{ gap: 1 }}>
                      {chiefComplaints.map(complaint => (
                        <FormControlLabel 
                          key={complaint}
                          control={
                            <Checkbox 
                              checked={selectedComplaints.includes(complaint)}
                              onChange={() => handleComplaintToggle(complaint)} 
                            />
                          } 
                          label={complaint} 
                        />
                      ))}
                    </FormGroup>
                  </Box>

                  <Grid container spacing={2}>
                    <Grid item xs={6}>
                      <TextField label="Complaint Duration" fullWidth value={complaintDuration} onChange={(e) => setComplaintDuration(e.target.value)} />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField label="Current Glasses Usage" fullWidth value={glassesUsage} onChange={(e) => setGlassesUsage(e.target.value)} />
                    </Grid>
                    <Grid item xs={12}>
                      <TextField label="Ophthalmic Medical History" multiline rows={2} fullWidth value={medicalHistory} onChange={(e) => setMedicalHistory(e.target.value)} />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField label="Allergies" fullWidth value={allergies} onChange={(e) => setAllergies(e.target.value)} />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField label="Family History" fullWidth value={familyHistory} onChange={(e) => setFamilyHistory(e.target.value)} />
                    </Grid>
                  </Grid>
                </Stack>
              )}

              {/* Tab 3: Visual Acuity */}
              {activeStep === 2 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography variant="h6" fontWeight={700}>Visual Acuity Measurements</Typography>
                    <Typography variant="caption" color="text.secondary">Check distance and near vision parameters</Typography>
                  </Box>

                  <Grid container spacing={3}>
                    <Grid item xs={12} sm={6}>
                      <Typography variant="subtitle2" fontWeight={700} color="primary" gutterBottom>Right Eye (OD)</Typography>
                      <Stack spacing={2}>
                        <TextField label="Unaided Distance Vision" fullWidth value={vaODDistanceUnaided} onChange={(e) => setVaODDistanceUnaided(e.target.value)} />
                        <TextField label="Corrected Distance Vision" fullWidth value={vaODDistanceCorrected} onChange={(e) => setVaODDistanceCorrected(e.target.value)} />
                        <TextField label="Pinhole Vision" fullWidth value={vaODPinhole} onChange={(e) => setVaODPinhole(e.target.value)} />
                        <TextField label="Near Vision" fullWidth value={vaODNear} onChange={(e) => setVaODNear(e.target.value)} />
                      </Stack>
                    </Grid>

                    <Grid item xs={12} sm={6}>
                      <Typography variant="subtitle2" fontWeight={700} color="primary" gutterBottom>Left Eye (OS)</Typography>
                      <Stack spacing={2}>
                        <TextField label="Unaided Distance Vision" fullWidth value={vaOSDistanceUnaided} onChange={(e) => setVaOSDistanceUnaided(e.target.value)} />
                        <TextField label="Corrected Distance Vision" fullWidth value={vaOSDistanceCorrected} onChange={(e) => setVaOSDistanceCorrected(e.target.value)} />
                        <TextField label="Pinhole Vision" fullWidth value={vaOSPinhole} onChange={(e) => setVaOSPinhole(e.target.value)} />
                        <TextField label="Near Vision" fullWidth value={vaOSNear} onChange={(e) => setVaOSNear(e.target.value)} />
                      </Stack>
                    </Grid>

                    <Grid item xs={12}>
                      <Divider />
                      <Typography variant="subtitle2" fontWeight={700} color="primary" sx={{ mt: 2, mb: 2 }}>Binocular OU Vision</Typography>
                      <Grid container spacing={2}>
                        <Grid item xs={6} sm={3}>
                          <TextField label="Binocular Vision" fullWidth value={vaOUBinocular} onChange={(e) => setVaOUBinocular(e.target.value)} />
                        </Grid>
                        <Grid item xs={6} sm={3}>
                          <TextField label="Stereo Vision" fullWidth value={vaOUStereo} onChange={(e) => setVaOUStereo(e.target.value)} />
                        </Grid>
                        <Grid item xs={6} sm={3}>
                          <TextField label="Dominant Eye" fullWidth value={vaOUDominant} onChange={(e) => setVaOUDominant(e.target.value)} />
                        </Grid>
                        <Grid item xs={6} sm={3}>
                          <TextField label="Fusion Test" fullWidth value={vaOUFusion} onChange={(e) => setVaOUFusion(e.target.value)} />
                        </Grid>
                      </Grid>
                    </Grid>
                  </Grid>
                </Stack>
              )}

              {/* Tab 4: Objective Refraction */}
              {activeStep === 3 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography variant="h6" fontWeight={700}>Objective Refraction Parameters</Typography>
                    <Typography variant="caption" color="text.secondary">Record Auto-Refractometer and Keratometry measurements</Typography>
                  </Box>

                  {/* Auto Refraction Table */}
                  <Typography variant="subtitle2" fontWeight={700} gutterBottom>Auto Refraction</Typography>
                  <TableContainer component={Paper} variant="outlined">
                    <Table size="small">
                      <TableHead sx={{ backgroundColor: 'action.hover' }}>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700 }}>EYE</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Sphere (SPH)</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Cylinder (CYL)</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Axis</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Vertex Dist.</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Pupil Size</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700 }}>OD (Right)</TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arSphOD} onChange={(e) => setArSphOD(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arCylOD} onChange={(e) => setArCylOD(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arAxisOD} onChange={(e) => setArAxisOD(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arVertexOD} onChange={(e) => setArVertexOD(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arPupilOD} onChange={(e) => setArPupilOD(e.target.value)} /></TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700 }}>OS (Left)</TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arSphOS} onChange={(e) => setArSphOS(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arCylOS} onChange={(e) => setArCylOS(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arAxisOS} onChange={(e) => setArAxisOS(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arVertexOS} onChange={(e) => setArVertexOS(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={arPupilOS} onChange={(e) => setArPupilOS(e.target.value)} /></TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </TableContainer>

                  <Divider />

                  <Typography variant="subtitle2" fontWeight={700}>Keratometry & PD Readings</Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={6} sm={3}>
                      <TextField label="K1 OD (Diopters)" fullWidth value={k1OD} onChange={(e) => setK1OD(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="K2 OD" fullWidth value={k2OD} onChange={(e) => setK2OD(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="K1 OS" fullWidth value={k1OS} onChange={(e) => setK1OS(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="K2 OS" fullWidth value={k2OS} onChange={(e) => setK2OS(e.target.value)} />
                    </Grid>

                    <Grid item xs={6} sm={3}>
                      <TextField label="Distance PD (mm)" fullWidth value={distancePD} onChange={(e) => setDistancePD(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="Near PD (mm)" fullWidth value={nearPD} onChange={(e) => setNearPD(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="IOP OD (mmHg)" fullWidth value={iopRight} onChange={(e) => setIopRight(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="IOP OS (mmHg)" fullWidth value={iopLeft} onChange={(e) => setIopLeft(e.target.value)} />
                    </Grid>
                  </Grid>
                  
                  {getHighIopWarning() && <Alert severity="warning" icon={<WarningIcon />}>{getHighIopWarning()}</Alert>}
                </Stack>
              )}

              {/* Tab 5: Subjective Refraction */}
              {activeStep === 4 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography variant="h6" fontWeight={700}>Subjective Refraction Card</Typography>
                    <Typography variant="caption" color="text.secondary">Enter final subjective trial lens measurements</Typography>
                  </Box>

                  <TableContainer component={Paper} variant="outlined">
                    <Table size="small">
                      <TableHead sx={{ backgroundColor: 'action.hover' }}>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700 }}>EYE</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>SPH</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>CYL</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>AXIS</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>VA</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>ADD</TableCell>
                          <TableCell sx={{ fontWeight: 700 }}>Prism</TableCell>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700 }}>OD (Right)</TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subSphOD} onChange={(e) => setSubSphOD(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subCylOD} onChange={(e) => setSubCylOD(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subAxisOD} onChange={(e) => setSubAxisOD(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subVaOD} onChange={(e) => setSubVaOD(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subAddOD} onChange={(e) => setSubAddOD(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subPrismOD} onChange={(e) => setSubPrismOD(e.target.value)} /></TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell sx={{ fontWeight: 700 }}>OS (Left)</TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subSphOS} onChange={(e) => setSubSphOS(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subCylOS} onChange={(e) => setSubCylOS(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subAxisOS} onChange={(e) => setSubAxisOS(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subVaOS} onChange={(e) => setSubVaOS(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subAddOS} onChange={(e) => setSubAddOS(e.target.value)} /></TableCell>
                          <TableCell><TextField size="small" variant="standard" value={subPrismOS} onChange={(e) => setSubPrismOS(e.target.value)} /></TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </TableContainer>

                  <Divider />

                  <Typography variant="subtitle2" fontWeight={700}>Binocular Accommodative Balances</Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={6} sm={4}>
                      <TextField label="Binocular Balance" fullWidth value={binocularBalance} onChange={(e) => setBinocularBalance(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField label="Phoria Test" fullWidth value={phoriaTest} onChange={(e) => setPhoriaTest(e.target.value)} />
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField label="Near Point Convergence (NPC)" fullWidth value={npc} onChange={(e) => setNpc(e.target.value)} />
                    </Grid>
                  </Grid>
                </Stack>
              )}

              {/* Tab 6: Eye Health Examination */}
              {activeStep === 5 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography variant="h6" fontWeight={700}>Ophthalmic Slit Lamp & Fundus Exam</Typography>
                    <Typography variant="caption" color="text.secondary">Assess anterior segment physiology and optic health</Typography>
                  </Box>

                  <Typography variant="subtitle2" fontWeight={700} color="primary">Anterior Segment (Slit Lamp)</Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={6} sm={4}>
                      <TextField select label="Eyelids" fullWidth value={eyelids} onChange={(e) => setEyelids(e.target.value)}>
                        {normalSevereOptions.map(o => <MenuItem key={o} value={o}>{o}</MenuItem>)}
                      </TextField>
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField select label="Conjunctiva" fullWidth value={conjunctiva} onChange={(e) => setConjunctiva(e.target.value)}>
                        {normalSevereOptions.map(o => <MenuItem key={o} value={o}>{o}</MenuItem>)}
                      </TextField>
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField select label="Cornea" fullWidth value={cornea} onChange={(e) => setCornea(e.target.value)}>
                        {normalSevereOptions.map(o => <MenuItem key={o} value={o}>{o}</MenuItem>)}
                      </TextField>
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField select label="Anterior Chamber" fullWidth value={anteriorChamber} onChange={(e) => setAnteriorChamber(e.target.value)}>
                        {normalSevereOptions.map(o => <MenuItem key={o} value={o}>{o}</MenuItem>)}
                      </TextField>
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField select label="Lens State" fullWidth value={lensState} onChange={(e) => setLensState(e.target.value)}>
                        {normalSevereOptions.map(o => <MenuItem key={o} value={o}>{o}</MenuItem>)}
                      </TextField>
                    </Grid>
                  </Grid>

                  <Divider />

                  <Typography variant="subtitle2" fontWeight={700} color="primary">Posterior Segment (Fundusoscopy)</Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={6}>
                      <TextField label="Optic Disc" fullWidth value={opticDisc} onChange={(e) => setOpticDisc(e.target.value)} />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField label="Retina" fullWidth value={retina} onChange={(e) => setRetina(e.target.value)} />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField label="Pupillary Reflex" fullWidth value={pupillaryReflex} onChange={(e) => setPupillaryReflex(e.target.value)} />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField label="Tear Film Assessment" fullWidth value={tearFilm} onChange={(e) => setTearFilm(e.target.value)} />
                    </Grid>
                  </Grid>
                </Stack>
              )}

              {/* Tab 7: Contact Lens Trial */}
              {activeStep === 6 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography variant="h6" fontWeight={700}>Contact Lens Fitting Log</Typography>
                    <Typography variant="caption" color="text.secondary">Log diagnostics and lens tolerance trial reports</Typography>
                  </Box>

                  <Grid container spacing={2}>
                    <Grid item xs={6} sm={4}>
                      <TextField label="Trial Brand" fullWidth value={clBrand} onChange={(e) => setClBrand(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField label="Lens Type" fullWidth value={clType} onChange={(e) => setClType(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField label="Power (SPH)" fullWidth value={clPower} onChange={(e) => setClPower(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="Base Curve (BC)" fullWidth value={clBC} onChange={(e) => setClBC(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="Diameter (DIA)" fullWidth value={clDIA} onChange={(e) => setClDIA(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="Wearing Time" fullWidth value={clWearTime} onChange={(e) => setClWearTime(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="Comfort Rating" fullWidth value={clComfort} onChange={(e) => setClComfort(e.target.value)} />
                    </Grid>
                    <Grid item xs={12}>
                      <TextField label="Trial Fitting Recommendation" fullWidth multiline rows={2} value={clRecommend} onChange={(e) => setClRecommend(e.target.value)} />
                    </Grid>
                  </Grid>
                </Stack>
              )}

              {/* Tab 8: Final Prescription */}
              {activeStep === 7 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography variant="h6" fontWeight={700}>Prescription card generation</Typography>
                    <Typography variant="caption" color="text.secondary">Automatically generated visual layout ready to print</Typography>
                  </Box>

                  <Paper variant="outlined" sx={{ p: 4, backgroundColor: '#ffffff', color: 'black', borderRadius: 4, fontFamily: 'monospace' }}>
                    <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 3, flexWrap: 'wrap', gap: 2 }}>
                      <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
                        {companyInfo.logo && (
                          <img 
                            src={companyInfo.logo} 
                            alt="Logo" 
                            style={{ maxHeight: '50px', maxWidth: '120px', objectFit: 'contain' }} 
                          />
                        )}
                        <Box>
                          <Typography variant="h5" sx={{ fontWeight: 900, color: '#2563EB', textTransform: 'uppercase' }}>
                            {companyInfo.name}
                          </Typography>
                          <Typography variant="caption" sx={{ color: 'gray', display: 'block' }}>
                            Visit No: {patientData.visitNum} | Optometrist: {patientData.assignedOptometrist}
                          </Typography>
                        </Box>
                      </Box>
                      <Box sx={{ textAlign: 'right' }}>
                        <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>DATE: {new Date().toLocaleDateString()}</Typography>
                        <Typography variant="caption" sx={{ color: 'gray' }}>Patient: {patientData.name}</Typography>
                      </Box>
                    </Box>

                    <Divider sx={{ my: 2, borderColor: 'black' }} />

                    <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1, textDecoration: 'underline' }}>Final Correction Prescription (Rx)</Typography>
                    <Table size="small" sx={{ mb: 3 }}>
                      <TableHead>
                        <TableRow>
                          <th style={{ textAlign: 'left', fontWeight: 'bold' }}>Eye</th>
                          <th style={{ textAlign: 'left', fontWeight: 'bold' }}>SPH</th>
                          <th style={{ textAlign: 'left', fontWeight: 'bold' }}>CYL</th>
                          <th style={{ textAlign: 'left', fontWeight: 'bold' }}>AXIS</th>
                          <th style={{ textAlign: 'left', fontWeight: 'bold' }}>ADD</th>
                          <th style={{ textAlign: 'left', fontWeight: 'bold' }}>PD</th>
                        </TableRow>
                      </TableHead>
                      <TableBody>
                        <TableRow>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}><strong>OD (Right)</strong></TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{subSphOD}</TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{subCylOD}</TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{subAxisOD}</TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{subAddOD}</TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{monoRightPD} mm</TableCell>
                        </TableRow>
                        <TableRow>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}><strong>OS (Left)</strong></TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{subSphOS}</TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{subCylOS}</TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{subAxisOS}</TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{subAddOS}</TableCell>
                          <TableCell sx={{ color: 'black', borderBottom: '1px solid black' }}>{monoLeftPD} mm</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>

                    <Typography variant="body2" sx={{ mb: 4 }}>
                      <strong>Remarks:</strong> {glassesUsage === 'Full Time' ? 'Continuous wear recommended.' : 'For computer and reading distance only.'}
                    </Typography>

                    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
                      <Box>
                        <Typography variant="caption" sx={{ color: 'gray', display: 'block' }}>VisionERP Certified Refraction Card</Typography>
                        <Typography variant="caption" sx={{ color: 'gray' }}>Powered by Greensol Ophthalmic Suite</Typography>
                      </Box>
                      <Box sx={{ textAlign: 'center' }}>
                        <Typography variant="caption" sx={{ fontStyle: 'italic', borderBottom: '1px solid black', display: 'block', px: 2 }}>
                          {patientData.assignedOptometrist}
                        </Typography>
                        <Typography variant="caption" sx={{ fontWeight: 600 }}>Optometrist Signature</Typography>
                      </Box>
                    </Box>
                  </Paper>
                </Stack>
              )}

              {/* Tab 9: Recommendations & Details */}
              {activeStep === 8 && (
                <Stack spacing={3}>
                  <Box>
                    <Typography variant="h6" fontWeight={700}>Ophthalmic Products Recommendation</Typography>
                    <Typography variant="caption" color="text.secondary">Suggest matching frames, lens brands, and coatings</Typography>
                  </Box>

                  <Typography variant="subtitle2" fontWeight={700} color="primary">Ophthalmic Lens Recommendation</Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={6} sm={4}>
                      <TextField select label="Lens Type" fullWidth value={recLensType} onChange={(e) => setRecLensType(e.target.value)}>
                        <MenuItem value="Single Vision">Single Vision</MenuItem>
                        <MenuItem value="Bifocal">Bifocal</MenuItem>
                        <MenuItem value="Progressive">Progressive</MenuItem>
                        <MenuItem value="Workspace">Workspace</MenuItem>
                      </TextField>
                    </Grid>
                    <Grid item xs={6} sm={4}>
                      <TextField select label="Lens Brand" fullWidth value={recLensBrand} onChange={(e) => setRecLensBrand(e.target.value)}>
                        <MenuItem value="Essilor">Essilor</MenuItem>
                        <MenuItem value="Zeiss">Zeiss</MenuItem>
                        <MenuItem value="Hoya">Hoya</MenuItem>
                        <MenuItem value="Kodak">Hoya</MenuItem>
                      </TextField>
                    </Grid>
                    <Grid item xs={12} sm={4}>
                      <TextField label="Coatings Suggested" fullWidth value={recLensCoating} onChange={(e) => setRecLensCoating(e.target.value)} />
                    </Grid>
                  </Grid>

                  <Divider />

                  <Typography variant="subtitle2" fontWeight={700} color="primary">Frame Suggestions</Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={6} sm={3}>
                      <TextField label="Frame Shape" fullWidth value={recFrameShape} onChange={(e) => setRecFrameShape(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="Frame Brand" fullWidth value={recFrameBrand} onChange={(e) => setRecFrameBrand(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="Frame Color" fullWidth value={recFrameColor} onChange={(e) => setRecFrameColor(e.target.value)} />
                    </Grid>
                    <Grid item xs={6} sm={3}>
                      <TextField label="Frame Size" fullWidth value={recFrameSize} onChange={(e) => setRecFrameSize(e.target.value)} />
                    </Grid>
                  </Grid>

                  <Divider />

                  <Typography variant="subtitle2" fontWeight={700} color="primary">Follow-up schedule</Typography>
                  <Grid container spacing={2}>
                    <Grid item xs={6}>
                      <TextField label="Next Review Date" type="date" InputLabelProps={{ shrink: true }} fullWidth value={followUpDate} onChange={(e) => setFollowUpDate(e.target.value)} />
                    </Grid>
                    <Grid item xs={6}>
                      <TextField select label="Follow-up Interval" fullWidth value={followUpInterval} onChange={(e) => setFollowUpInterval(e.target.value)}>
                        <MenuItem value="3 Months">3 Months</MenuItem>
                        <MenuItem value="6 Months">6 Months</MenuItem>
                        <MenuItem value="1 Year">1 Year</MenuItem>
                      </TextField>
                    </Grid>
                  </Grid>
                </Stack>
              )}
            </CardContent>
          </Card>
        </Grid>

        {/* Right Side: Quick Exam Summary Sidebar */}
        <Grid item xs={12} md={3.5}>
          <Box sx={{ position: 'sticky', top: 84 }}>
            {/* Patient Visit History Accordion */}
            <Accordion sx={{ mb: 2, borderRadius: 3, border: '1px solid', borderColor: 'divider', boxShadow: 'none' }}>
              <AccordionSummary expandIcon={<ExpandMoreIcon />}>
                <Typography variant="subtitle2" sx={{ fontWeight: 700, display: 'flex', alignItems: 'center', gap: 1 }}>
                  <HistoryIcon color="primary" fontSize="small" /> Visit History & Previous Rx
                </Typography>
              </AccordionSummary>
              <AccordionDetails sx={{ p: 2 }}>
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1, fontWeight: 700 }}>
                  PREVIOUS PRESCRIPTION:
                </Typography>
                <Typography variant="body2" sx={{ mb: 2, fontStyle: 'italic' }}>
                  {patientData.previousPrescription}
                </Typography>
                <Divider sx={{ my: 1 }} />
                <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1, fontWeight: 700 }}>
                  VISIT LOGS:
                </Typography>
                {patientData.visitHistory?.map((log, idx) => (
                  <Typography key={idx} variant="caption" display="block" sx={{ mb: 0.5 }}>
                    • {log}
                  </Typography>
                ))}
              </AccordionDetails>
            </Accordion>

            {/* Right Summary Card */}
            <Card sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 4, boxShadow: 'none' }}>
              <CardContent sx={{ p: 3 }}>
                <Typography variant="subtitle1" fontWeight={700} color="primary" gutterBottom>
                  Live Examination Summary
                </Typography>
                <Divider sx={{ mb: 2 }} />

                <Stack spacing={2.5}>
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ fontWeight: 700 }}>PATIENT</Typography>
                    <Typography variant="body2" fontWeight={600}>{patientData.name} ({patientData.age} yr, {patientData.gender})</Typography>
                    <Typography variant="caption" color="text.secondary">ID: {patientData.id}</Typography>
                  </Box>

                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ fontWeight: 700 }}>CHIEF COMPLAINTS</Typography>
                    {selectedComplaints.length === 0 ? (
                      <Typography variant="caption" color="text.secondary">No complaints selected</Typography>
                    ) : (
                      <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                        {selectedComplaints.map(c => (
                          <Chip key={c} label={c} size="small" sx={{ fontSize: '0.7rem' }} />
                        ))}
                      </Stack>
                    )}
                  </Box>

                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ fontWeight: 700 }}>SUBJECTIVE RX REFRACTION</Typography>
                    <Typography variant="caption" display="block">OD: {subSphOD} SPH / {subCylOD} CYL x {subAxisOD}</Typography>
                    <Typography variant="caption" display="block">OS: {subSphOS} SPH / {subCylOS} CYL x {subAxisOS}</Typography>
                  </Box>

                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ fontWeight: 700 }}>RECOMMENDATION</Typography>
                    <Typography variant="caption" display="block">Lens: {recLensBrand} {recLensType}</Typography>
                    <Typography variant="caption" display="block">Frame: {recFrameBrand} ({recFrameColor})</Typography>
                  </Box>

                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ fontWeight: 700 }}>DIAGNOSIS CHIPS</Typography>
                    <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap sx={{ mt: 0.5 }}>
                      {recDiagnosis.map(d => (
                        <Chip key={d} label={d} size="small" color="primary" sx={{ fontSize: '0.7rem' }} />
                      ))}
                    </Stack>
                  </Box>
                  
                  <Box>
                    <Typography variant="caption" color="text.secondary" display="block" sx={{ fontWeight: 700 }}>NEXT REVIEW</Typography>
                    <Typography variant="body2" fontWeight={600}>{followUpDate} ({followUpInterval})</Typography>
                  </Box>
                </Stack>
              </CardContent>
            </Card>
          </Box>
        </Grid>
      </Grid>

      {/* Bottom Sticky Action Bar */}
      <Box sx={{ 
        position: 'fixed', 
        bottom: 0, 
        left: { xs: 0, sm: 280 }, 
        right: 0, 
        backgroundColor: 'background.paper', 
        borderTop: '1px solid',
        borderColor: 'divider',
        p: 2, 
        zIndex: 1000,
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        flexWrap: 'wrap',
        gap: 1
      }}>
        <Stack direction="row" spacing={1}>
          <Button variant="outlined" startIcon={<BackIcon />} onClick={handleBack} disabled={activeStep === 0}>
            Back
          </Button>
          <Button variant="outlined" startIcon={<NextIcon />} onClick={handleNext} disabled={activeStep === 8} sx={{ mr: 2 }}>
            Next
          </Button>
          <Button variant="text" size="small" onClick={() => alert('Draft saved successfully')}>Save Draft</Button>
          <Button variant="text" color="error" size="small" onClick={() => { if(confirm("Are you sure you want to cancel and return to the queue? Unsaved details will be lost.")) setViewMode('list'); }}>Cancel & Exit</Button>
        </Stack>
        
        <Stack direction="row" spacing={1.5} flexWrap="wrap">
          <Button variant="outlined" startIcon={<PrintIcon />} onClick={() => window.print()}>
            Print Exam
          </Button>
          <Button variant="contained" startIcon={<SaveIcon />} sx={{ backgroundColor: '#2563EB', '&:hover': { backgroundColor: '#1d4ed8' } }} onClick={handleSaveExam}>
            Save Examination
          </Button>
        </Stack>
      </Box>

      {/* Hidden Print-Only Prescription & Recommendation Card */}
      <Box id="prescription-print-area" sx={{ display: 'none', '@media print': { display: 'block !important' } }}>
        <Paper variant="outlined" sx={{ p: 4, backgroundColor: '#ffffff', color: 'black', fontFamily: 'monospace' }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 3 }}>
            <Box sx={{ display: 'flex', gap: 2, alignItems: 'center' }}>
              {companyInfo.logo && (
                <img 
                  src={companyInfo.logo} 
                  alt="Company Logo" 
                  style={{ maxHeight: '60px', maxWidth: '150px', objectFit: 'contain' }} 
                />
              )}
              <Box>
                <Typography variant="h5" sx={{ fontWeight: 900, color: '#1E3A8A', textTransform: 'uppercase', fontFamily: 'monospace' }}>
                  {companyInfo.name}
                </Typography>
                {companyInfo.phone && <Typography variant="caption" sx={{ color: 'black', display: 'block', fontFamily: 'monospace' }}>Tel: {companyInfo.phone}</Typography>}
                {companyInfo.address && <Typography variant="caption" sx={{ color: 'black', display: 'block', fontFamily: 'monospace' }}>Address: {companyInfo.address}</Typography>}
              </Box>
            </Box>
            <Box sx={{ textAlign: 'right' }}>
              <Typography variant="subtitle2" sx={{ fontWeight: 700, fontFamily: 'monospace' }}>DATE: {new Date().toLocaleDateString()}</Typography>
              <Typography variant="caption" sx={{ color: 'black', display: 'block', fontFamily: 'monospace' }}>Visit No: {patientData.visitNum}</Typography>
              <Typography variant="caption" sx={{ color: 'black', display: 'block', fontFamily: 'monospace' }}>Optometrist: {patientData.assignedOptometrist}</Typography>
            </Box>
          </Box>

          <Divider sx={{ my: 2, borderColor: 'black' }} />

          {/* Patient Info */}
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={6}>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Patient Name:</strong> {patientData.name}</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Age / Gender:</strong> {patientData.age} yrs / {patientData.gender}</Typography>
            </Grid>
            <Grid item xs={6} sx={{ textAlign: 'right' }}>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Phone:</strong> {patientData.phone || 'N/A'}</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Email:</strong> {patientData.email || 'N/A'}</Typography>
            </Grid>
          </Grid>

          <Divider sx={{ my: 2, borderColor: 'black' }} />

          {/* Rx Table */}
          <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1, textDecoration: 'underline', fontFamily: 'monospace' }}>Correction Prescription (Rx)</Typography>
          <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: '20px', fontFamily: 'monospace', fontSize: '12px' }}>
            <thead>
              <tr style={{ borderBottom: '2px solid black' }}>
                <th style={{ textAlign: 'left', padding: '8px' }}>Eye</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>SPH</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>CYL</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>AXIS</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>ADD</th>
                <th style={{ textAlign: 'left', padding: '8px' }}>PD</th>
              </tr>
            </thead>
            <tbody>
              <tr style={{ borderBottom: '1px solid #ddd' }}>
                <td style={{ padding: '8px' }}><strong>OD (Right)</strong></td>
                <td style={{ padding: '8px' }}>{subSphOD || '0.00'}</td>
                <td style={{ padding: '8px' }}>{subCylOD || '0.00'}</td>
                <td style={{ padding: '8px' }}>{subAxisOD || '-'}</td>
                <td style={{ padding: '8px' }}>{subAddOD || '-'}</td>
                <td style={{ padding: '8px' }}>{monoRightPD ? `${monoRightPD} mm` : '-'}</td>
              </tr>
              <tr style={{ borderBottom: '1px solid #ddd' }}>
                <td style={{ padding: '8px' }}><strong>OS (Left)</strong></td>
                <td style={{ padding: '8px' }}>{subSphOS || '0.00'}</td>
                <td style={{ padding: '8px' }}>{subCylOS || '0.00'}</td>
                <td style={{ padding: '8px' }}>{subAxisOS || '-'}</td>
                <td style={{ padding: '8px' }}>{subAddOS || '-'}</td>
                <td style={{ padding: '8px' }}>{monoLeftPD ? `${monoLeftPD} mm` : '-'}</td>
              </tr>
            </tbody>
          </table>

          {/* Recommendations */}
          <Typography variant="subtitle2" sx={{ fontWeight: 800, mb: 1, textDecoration: 'underline', fontFamily: 'monospace' }}>Ophthalmic Recommendations</Typography>
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={6}>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Lens Type:</strong> {recLensType || 'N/A'}</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Lens Brand:</strong> {recLensBrand || 'N/A'}</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Suggested Coating:</strong> {recLensCoating || 'N/A'}</Typography>
            </Grid>
            <Grid item xs={6}>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Frame Shape/Brand:</strong> {recFrameShape || 'N/A'} / {recFrameBrand || 'N/A'}</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Frame Color/Size:</strong> {recFrameColor || 'N/A'} / {recFrameSize || 'N/A'}</Typography>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Remarks/Diagnosis:</strong> {recDiagnosis?.join(', ') || 'N/A'}</Typography>
            </Grid>
          </Grid>

          <Divider sx={{ my: 2, borderColor: 'black' }} />

          {/* Review Details & Signatures */}
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', mt: 4 }}>
            <Box>
              <Typography variant="body2" sx={{ fontFamily: 'monospace' }}><strong>Next Review Date:</strong> {followUpDate || 'As advised'}</Typography>
              <Typography variant="caption" sx={{ color: 'gray', display: 'block', mt: 1, fontFamily: 'monospace' }}>Powered by Greensol Ophthalmic Suite</Typography>
            </Box>
            <Box sx={{ textAlign: 'center' }}>
              <Typography variant="caption" sx={{ fontStyle: 'italic', borderBottom: '1px solid black', display: 'block', px: 4, mb: 0.5, fontFamily: 'monospace' }}>
                {patientData.assignedOptometrist}
              </Typography>
              <Typography variant="caption" sx={{ fontWeight: 600, fontFamily: 'monospace' }}>Authorized Optometrist Signature</Typography>
            </Box>
          </Box>
        </Paper>
      </Box>
    </Box>
  );
}
