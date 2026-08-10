import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  Box, Card, CardContent, Typography, Button, Grid, Table, TableBody, 
  TableCell, TableContainer, TableHead, TableRow, Paper, Chip, TextField, 
  MenuItem, Stack, IconButton, Divider, Tooltip, Checkbox, Drawer, Avatar,
  Collapse, TablePagination, Badge, Alert, Dialog, DialogTitle, DialogContent,
  DialogActions, Tabs, Tab
} from '@mui/material';
import {
  Visibility as EyeIcon,
  PictureAsPdf as PdfIcon,
  TableChart as ExcelIcon,
  Print as PrintIcon,
  Search as SearchIcon,
  FilterList as FilterIcon,
  Refresh as ResetIcon,
  Add as AddIcon,
  Person as PersonIcon,
  Assignment as ExamIcon,
  CalendarMonth as CalendarIcon,
  CheckCircle as SuccessIcon,
  Pending as PendingIcon,
  Cancel as CancelIcon,
  Close as CloseIcon,
  Edit as EditIcon,
  Delete as DeleteIcon,
  ChevronRight as ChevronRightIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  MedicalServices as DoctorIcon,
  BarChart as ChartIcon,
  Male as MaleIcon,
  Female as FemaleIcon,
  AccessTime as TimeIcon,
  VolunteerActivism as FreeIcon,
  AttachMoney as PaidIcon,
  Download as DownloadIcon,
  WhatsApp as WhatsAppIcon,
  Badge as BadgeIcon,
  Home as HomeIcon,
  Phone as PhoneIcon,
  Email as EmailIcon,
  Work as WorkIcon,
  Check as CheckIcon
} from '@mui/icons-material';
import { 
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip, 
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, Legend 
} from 'recharts';
import axios from 'axios';
import QuickDatePickerField from '../common/QuickDatePickerField';
import PrintPrescriptionCard from '../optical/PrintPrescriptionCard';

// Color Palette Definition
const COLORS = {
  primary: '#2563eb',
  secondary: '#7c3aed',
  success: '#10b981',
  warning: '#f59e0b',
  danger: '#ef4444',
  info: '#06b6d4',
  dark: '#0f172a',
  lightBg: '#f8fafc',
  border: '#e2e8f0',
  chart: ['#2563eb', '#7c3aed', '#10b981', '#f59e0b', '#ec4899', '#06b6d4', '#8b5cf6', '#64748b']
};

// Rich Seed Clinical Examinations Dataset
const INITIAL_EXAMINATIONS = [
  {
    id: 'ET-1001',
    testNo: 'ET-1001',
    date: '2026-07-23',
    patientId: 'P-7391',
    name: 'Rajesh Kumar Sharma',
    age: 42,
    gender: 'Male',
    phone: '+91 98450 12345',
    email: 'rajesh.sharma@example.com',
    address: '45/2 MG Road, Indiranagar, Bengaluru, KA',
    occupation: 'Software Architect',
    testType: 'COMPREHENSIVE EYE TEST',
    assignedOptometrist: 'Dr. Ananya Roy (Senior Optometrist)',
    branch: 'Main Branch - Indiranagar',
    status: 'Completed',
    vaRight: '6/6 (N6)',
    vaLeft: '6/9 (N6)',
    refraction: {
      od: { sph: '-1.50', cyl: '-0.50', axis: '90', add: '+1.50', prism: '0.5 BI' },
      os: { sph: '-1.75', cyl: '-0.75', axis: '180', add: '+1.50', prism: '0.0' }
    },
    keratometry: { od: '43.25 / 44.00 @ 90', os: '43.50 / 44.25 @ 180' },
    iop: { od: '14 mmHg', os: '15 mmHg', method: 'NCT Tonometer' },
    diagnoses: ['Compound Myopic Astigmatism', 'Early Presbyopia', 'Computer Vision Syndrome'],
    icdCodes: ['H52.223', 'H52.4', 'H53.1'],
    products: {
      frame: 'RayBan Wayfarer Classic Matte Black (RB-5184)',
      lens: 'Crizal Prevencia 1.56 Anti-Blue Light Progressive',
      contactLens: 'Acuvue Oasys 1-Day Hydraluxe (N/A)',
      coating: 'Anti-Reflective & Hydrophobic Blue-Cut Coating',
      accessories: 'Microfiber Cleaning Solution Spray'
    },
    remarks: 'Patient reports eye strain during 8+ hours screen work. Prescribed progressive blue-filter lenses and 20-20-20 ergonomic rule.',
    nextReviewDate: '2027-01-23',
    reminderStatus: 'Scheduled'
  },
  {
    id: 'ET-1002',
    testNo: 'ET-1002',
    date: '2026-07-23',
    patientId: 'P-7392',
    name: 'Priya Sundaram',
    age: 28,
    gender: 'Female',
    phone: '+91 97312 88990',
    email: 'priya.s@example.com',
    address: '88 4th Cross, Koramangala 5th Block, Bengaluru',
    occupation: 'UX Designer',
    testType: 'CONTACT LENS EVALUATION',
    assignedOptometrist: 'Dr. Suresh Varma (Ophthalmologist)',
    branch: 'Koramangala Clinic',
    status: 'Completed',
    vaRight: '6/6 (N5)',
    vaLeft: '6/6 (N5)',
    refraction: {
      od: { sph: '-2.25', cyl: '-0.25', axis: '10', add: '0.00', prism: '0.0' },
      os: { sph: '-2.00', cyl: '-0.50', axis: '170', add: '0.00', prism: '0.0' }
    },
    keratometry: { od: '42.75 / 43.50 @ 15', os: '43.00 / 43.75 @ 165' },
    iop: { od: '12 mmHg', os: '13 mmHg', method: 'Applanation' },
    diagnoses: ['Simple Myopia', 'Mild Contact Lens Dryness'],
    icdCodes: ['H52.1', 'H04.123'],
    products: {
      frame: 'Vogue Eyewear Cat-Eye Rose Gold Frame',
      lens: 'Single Vision 1.61 High Index Blue Shield',
      contactLens: 'Dailies Total1 Monthly Disposable Spherical (-2.25 OD / -2.00 OS)',
      coating: 'Super Hydrophobic Oleophobic AR',
      accessories: 'Bausch & Lomb BioTrue Solution 300ml'
    },
    remarks: 'Tear film break-up time 11 seconds. Recomended re-wetting drops and daily disposable contact lenses.',
    nextReviewDate: '2026-10-23',
    reminderStatus: 'Scheduled'
  },
  {
    id: 'ET-1003',
    testNo: 'ET-1003',
    date: '2026-07-22',
    patientId: 'P-7393',
    name: 'Vikramaditya Nair',
    age: 58,
    gender: 'Male',
    phone: '+91 94470 33441',
    email: 'nair.vikram@example.com',
    address: '12 Jayanagar 3rd Block, Bengaluru',
    occupation: 'Retired Bank Manager',
    testType: 'ROUTINE REFRACTION',
    assignedOptometrist: 'Dr. Ananya Roy (Senior Optometrist)',
    branch: 'Main Branch - Indiranagar',
    status: 'Completed',
    vaRight: '6/12 (N8)',
    vaLeft: '6/18 (N10)',
    refraction: {
      od: { sph: '+1.75', cyl: '-1.00', axis: '85', add: '+2.25', prism: '0.0' },
      os: { sph: '+2.25', cyl: '-1.25', axis: '95', add: '+2.25', prism: '0.0' }
    },
    keratometry: { od: '44.00 / 45.25 @ 90', os: '44.25 / 45.75 @ 95' },
    iop: { od: '18 mmHg', os: '19 mmHg', method: 'NCT Tonometer' },
    diagnoses: ['Immature Senile Cataract', 'Compound Hyperopic Astigmatism', 'Presbyopia'],
    icdCodes: ['H25.8', 'H52.221', 'H52.4'],
    products: {
      frame: 'Titan Titanium Rimless Flexible Frame',
      lens: 'Essilor Varilux Comfort Max 1.56 Photochromic Transit',
      contactLens: 'N/A',
      coating: 'Transitions Gen 8 Brown + Crizal Sapphire',
      accessories: 'Hard Protective Leather Case'
    },
    remarks: 'Bilateral nuclear sclerosis Grade 2 noted. Referred for slit-lamp cataract consultation in 6 months.',
    nextReviewDate: '2027-01-22',
    reminderStatus: 'Scheduled'
  },
  {
    id: 'ET-1004',
    testNo: 'ET-1004',
    date: '2026-07-21',
    patientId: 'P-7394',
    name: 'Kavitha Patel',
    age: 34,
    gender: 'Female',
    phone: '+91 98250 99112',
    email: 'kavitha.p@example.com',
    address: '77 HSR Layout Sector 2, Bengaluru',
    occupation: 'School Teacher',
    testType: 'FREE EYE TEST',
    assignedOptometrist: 'Dr. Suresh Varma (Ophthalmologist)',
    branch: 'Main Branch - Indiranagar',
    status: 'Completed',
    vaRight: '6/6 (N6)',
    vaLeft: '6/6 (N6)',
    refraction: {
      od: { sph: '0.00', cyl: '0.00', axis: '0', add: '0.00', prism: '0.0' },
      os: { sph: '0.00', cyl: '0.00', axis: '0', add: '0.00', prism: '0.0' }
    },
    keratometry: { od: '43.00 / 43.50 @ 90', os: '43.00 / 43.50 @ 90' },
    iop: { od: '13 mmHg', os: '14 mmHg', method: 'NCT Tonometer' },
    diagnoses: ['Normal Visual Acuity', 'Asthenopia (Eye Fatigue)'],
    icdCodes: ['Z01.00', 'H53.1'],
    products: {
      frame: 'Fastrack Zero Power Blue-Cut Computer Glasses',
      lens: 'Zero Power Anti-Reflective Computer Protection Lens',
      contactLens: 'N/A',
      coating: 'Blue Shield UV420 Barrier',
      accessories: 'Microfiber Cleaning Cloth'
    },
    remarks: '6/6 vision in both eyes. Advised zero power blue light glasses for digital desktop teaching.',
    nextReviewDate: '2027-07-21',
    reminderStatus: 'Scheduled'
  },
  {
    id: 'ET-1005',
    testNo: 'ET-1005',
    date: '2026-07-20',
    patientId: 'P-7395',
    name: 'Mohammed Rizwan',
    age: 23,
    gender: 'Male',
    phone: '+91 99001 44556',
    email: 'm.rizwan@example.com',
    address: '14 Commercial Street, Tasker Town, Bengaluru',
    occupation: 'Student / College',
    testType: 'FREE EYE TEST',
    assignedOptometrist: 'Dr. Ananya Roy (Senior Optometrist)',
    branch: 'Main Branch - Indiranagar',
    status: 'Pending',
    vaRight: '6/18 (N8)',
    vaLeft: '6/12 (N6)',
    refraction: {
      od: { sph: '-3.00', cyl: '-1.25', axis: '175', add: '0.00', prism: '0.0' },
      os: { sph: '-2.50', cyl: '-1.00', axis: '5', add: '0.00', prism: '0.0' }
    },
    keratometry: { od: '43.50 / 44.75 @ 175', os: '43.25 / 44.50 @ 5' },
    iop: { od: '15 mmHg', os: '15 mmHg', method: 'NCT Tonometer' },
    diagnoses: ['Compound Myopic Astigmatism'],
    icdCodes: ['H52.223'],
    products: {
      frame: 'Oakley Holbrook Rectangular Acetate Frame',
      lens: '1.67 Extra Thin Aspheric Blue Cut Lens',
      contactLens: 'N/A',
      coating: 'Anti-Glare Scratch Resistant HMC',
      accessories: 'Hard Case'
    },
    remarks: 'Awaiting prescription selection approval by patient guardian.',
    nextReviewDate: '2026-08-20',
    reminderStatus: 'Pending'
  },
  {
    id: 'ET-1006',
    testNo: 'ET-1006',
    date: '2026-07-19',
    patientId: 'P-7396',
    name: 'Anita Fernandez',
    age: 64,
    gender: 'Female',
    phone: '+91 98440 22334',
    email: 'anita.f@example.com',
    address: '99 Rest House Road, Shantalanagar, Bengaluru',
    occupation: 'Homemaker',
    testType: 'COMPREHENSIVE EYE TEST',
    assignedOptometrist: 'Dr. Suresh Varma (Ophthalmologist)',
    branch: 'Koramangala Clinic',
    status: 'Completed',
    vaRight: '6/9 (N6)',
    vaLeft: '6/9 (N6)',
    refraction: {
      od: { sph: '+1.25', cyl: '-0.50', axis: '80', add: '+2.50', prism: '0.0' },
      os: { sph: '+1.50', cyl: '-0.50', axis: '100', add: '+2.50', prism: '0.0' }
    },
    keratometry: { od: '43.00 / 43.75 @ 80', os: '43.25 / 44.00 @ 100' },
    iop: { od: '16 mmHg', os: '17 mmHg', method: 'Goldmann Applanation' },
    diagnoses: ['Presbyopia', 'Dry Eye Syndrome', 'Primary Open Angle Glaucoma Suspect'],
    icdCodes: ['H52.4', 'H04.123', 'H40.01'],
    products: {
      frame: 'Gucci Oval Premium Acetate Frame',
      lens: 'Zeiss Progressive Individual 2 Photochromic Gray',
      contactLens: 'N/A',
      coating: 'Zeiss LotuTec Anti-Reflective Coating',
      accessories: 'Artificial Tears Drops (Systane Ultra)'
    },
    remarks: 'Cup-to-disc ratio 0.5 OD / 0.5 OS. Visual fields testing scheduled for follow-up.',
    nextReviewDate: '2026-10-19',
    reminderStatus: 'Scheduled'
  }
];

export default function EyeTestClinicalReport() {
  const navigate = useNavigate();

  // Primary Examinations Data State
  const [examinations, setExaminations] = useState(INITIAL_EXAMINATIONS);
  const [loading, setLoading] = useState(false);

  // Fetch real data from Backend API or LocalStorage if available
  useEffect(() => {
    const loadExams = async () => {
      setLoading(true);
      try {
        const res = await axios.get('/api/sales/eye-examinations/');
        if (res.data && Array.isArray(res.data) && res.data.length > 0) {
          // Format backend records
          const formatted = res.data.map((item, idx) => ({
            id: item.id || `ET-${1000 + idx}`,
            testNo: item.test_number || item.testNo || `ET-${1000 + idx}`,
            date: item.date || item.created_at?.split('T')[0] || '2026-07-23',
            patientId: item.patient_id || item.patientId || `P-${100 + idx}`,
            name: item.patient_name || item.name || 'Patient Name',
            age: item.age || 35,
            gender: item.gender || 'Male',
            phone: item.phone || item.mobile || 'N/A',
            email: item.email || 'N/A',
            address: item.address || 'N/A',
            occupation: item.occupation || 'N/A',
            testType: item.test_type || item.testType || 'COMPREHENSIVE EYE TEST',
            assignedOptometrist: item.optometrist || item.assignedOptometrist || 'Dr. Ananya Roy',
            branch: item.branch || 'Main Branch',
            status: item.status || 'Completed',
            vaRight: item.va_right || item.vaRight || '6/6 (N6)',
            vaLeft: item.va_left || item.vaLeft || '6/6 (N6)',
            refraction: item.refraction || {
              od: { sph: '0.00', cyl: '0.00', axis: '0', add: '0.00', prism: '0.0' },
              os: { sph: '0.00', cyl: '0.00', axis: '0', add: '0.00', prism: '0.0' }
            },
            keratometry: item.keratometry || { od: '43.00 / 43.50 @ 90', os: '43.00 / 43.50 @ 90' },
            iop: item.iop || { od: '14 mmHg', os: '14 mmHg', method: 'NCT' },
            diagnoses: item.diagnoses || ['Routine Refraction'],
            icdCodes: item.icd_codes || ['H52.1'],
            products: item.products || {
              frame: 'Generic Optical Frame',
              lens: 'Single Vision Blue Cut Lens',
              contactLens: 'N/A',
              coating: 'Anti-Reflective Coating',
              accessories: 'Microfiber Cleaning Cloth'
            },
            remarks: item.remarks || 'Standard optical examination completed.',
            nextReviewDate: item.next_review_date || item.nextReviewDate || '2027-07-23',
            reminderStatus: 'Scheduled'
          }));
          setExaminations(formatted);
        } else {
          // Merge local storage saved exams if available
          const localSaved = JSON.parse(localStorage.getItem('optical_eye_exams') || '[]');
          if (localSaved.length > 0) {
            setExaminations([...localSaved, ...INITIAL_EXAMINATIONS]);
          }
        }
      } catch (e) {
        // Fallback to local storage or seed data
        const localSaved = JSON.parse(localStorage.getItem('optical_eye_exams') || '[]');
        if (localSaved.length > 0) {
          setExaminations([...localSaved, ...INITIAL_EXAMINATIONS]);
        }
      } finally {
        setLoading(false);
      }
    };
    loadExams();
  }, []);

  // Filter States
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [filters, setFilters] = useState({
    testNo: '',
    patientId: '',
    name: '',
    phone: '',
    testType: 'ALL',
    optometrist: 'ALL',
    gender: 'ALL',
    age: '',
    fromDate: '',
    toDate: '',
    nextVisit: '',
    status: 'ALL'
  });

  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPeriod, setSelectedPeriod] = useState('ALL');

  // Toggle Charts Visibility
  const [showCharts, setShowCharts] = useState(true);

  // Selection & Pagination
  const [selectedIds, setSelectedIds] = useState([]);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  // Sorting
  const [orderBy, setOrderBy] = useState('date');
  const [order, setOrder] = useState('desc');

  // Drawer & Modals State
  const [selectedExam, setSelectedExam] = useState(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [printModalOpen, setPrintModalOpen] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [examToDelete, setExamToDelete] = useState(null);

  // Handle Filter Change
  const handleFilterChange = (field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
  };

  const handleResetFilters = () => {
    setFilters({
      testNo: '',
      patientId: '',
      name: '',
      phone: '',
      testType: 'ALL',
      optometrist: 'ALL',
      gender: 'ALL',
      age: '',
      fromDate: '',
      toDate: '',
      nextVisit: '',
      status: 'ALL'
    });
    setSearchQuery('');
    setSelectedPeriod('ALL');
  };

  // Filter Logic
  const filteredExaminations = useMemo(() => {
    return examinations.filter(item => {
      // Global Search
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matchesQuery = 
          item.testNo.toLowerCase().includes(q) ||
          item.patientId.toLowerCase().includes(q) ||
          item.name.toLowerCase().includes(q) ||
          item.phone.includes(q) ||
          item.assignedOptometrist.toLowerCase().includes(q) ||
          (item.diagnoses && item.diagnoses.some(d => d.toLowerCase().includes(q)));
        if (!matchesQuery) return false;
      }

      // Specific Filters
      if (filters.testNo && !item.testNo.toLowerCase().includes(filters.testNo.toLowerCase())) return false;
      if (filters.patientId && !item.patientId.toLowerCase().includes(filters.patientId.toLowerCase())) return false;
      if (filters.name && !item.name.toLowerCase().includes(filters.name.toLowerCase())) return false;
      if (filters.phone && !item.phone.includes(filters.phone)) return false;
      if (filters.testType !== 'ALL' && item.testType !== filters.testType) return false;
      if (filters.optometrist !== 'ALL' && !item.assignedOptometrist.includes(filters.optometrist)) return false;
      if (filters.gender !== 'ALL' && item.gender !== filters.gender) return false;
      if (filters.status !== 'ALL' && item.status !== filters.status) return false;
      if (filters.age && item.age !== parseInt(filters.age, 10)) return false;

      // Date Range Filters
      if (filters.fromDate && item.date < filters.fromDate) return false;
      if (filters.toDate && item.date > filters.toDate) return false;
      if (filters.nextVisit && item.nextReviewDate !== filters.nextVisit) return false;

      return true;
    });
  }, [examinations, searchQuery, filters]);

  // Sort Logic
  const sortedExaminations = useMemo(() => {
    return [...filteredExaminations].sort((a, b) => {
      let aVal = a[orderBy] || '';
      let bVal = b[orderBy] || '';
      if (aVal < bVal) return order === 'asc' ? -1 : 1;
      if (aVal > bVal) return order === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredExaminations, orderBy, order]);

  // Paginated Rows
  const paginatedRows = useMemo(() => {
    return sortedExaminations.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  }, [sortedExaminations, page, rowsPerPage]);

  // Multi-Select Logic
  const handleSelectAll = (event) => {
    if (event.target.checked) {
      setSelectedIds(filteredExaminations.map(n => n.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleSelectOne = (id) => {
    setSelectedIds(prev => 
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  // KPI Metrics Calculation
  const metrics = useMemo(() => {
    const total = filteredExaminations.length;
    const todayStr = new Date().toISOString().split('T')[0];
    const todayCount = filteredExaminations.filter(e => e.date === todayStr).length;
    const freeCount = filteredExaminations.filter(e => e.testType === 'FREE EYE TEST').length;
    const paidCount = total - freeCount;
    const followupCount = filteredExaminations.filter(e => e.nextReviewDate).length;
    
    const ages = filteredExaminations.map(e => e.age).filter(Boolean);
    const avgAge = ages.length > 0 ? (ages.reduce((a, b) => a + b, 0) / ages.length).toFixed(1) : '38.5';
    
    const maleCount = filteredExaminations.filter(e => e.gender === 'Male').length;
    const femaleCount = filteredExaminations.filter(e => e.gender === 'Female').length;
    const completedCount = filteredExaminations.filter(e => e.status === 'Completed').length;

    return {
      total,
      todayCount,
      freeCount,
      paidCount,
      followupCount,
      avgAge,
      maleCount,
      femaleCount,
      completedCount,
      completionRate: total > 0 ? Math.round((completedCount / total) * 100) : 100
    };
  }, [filteredExaminations]);

  // Chart Data Calculations
  const chartData = useMemo(() => {
    // 1. Daily Trend
    const dailyMap = {};
    filteredExaminations.forEach(e => {
      const d = e.date || 'Unknown';
      dailyMap[d] = (dailyMap[d] || 0) + 1;
    });
    const dailyTrend = Object.keys(dailyMap).sort().map(date => ({
      date: date.substring(5),
      tests: dailyMap[date]
    }));

    // 2. Test Type Distribution
    const typeMap = {};
    filteredExaminations.forEach(e => {
      const t = e.testType || 'Other';
      typeMap[t] = (typeMap[t] || 0) + 1;
    });
    const typeDistribution = Object.keys(typeMap).map(type => ({
      name: type.replace(' EYE TEST', '').replace(' EVALUATION', ''),
      value: typeMap[type]
    }));

    // 3. Gender Distribution
    const genderDistribution = [
      { name: 'Male', value: metrics.maleCount },
      { name: 'Female', value: metrics.femaleCount },
      { name: 'Other', value: metrics.total - metrics.maleCount - metrics.femaleCount }
    ].filter(g => g.value > 0);

    // 4. Age Distribution
    const ageGroups = { '0-18': 0, '19-35': 0, '36-50': 0, '51-65': 0, '65+': 0 };
    filteredExaminations.forEach(e => {
      const a = e.age || 30;
      if (a <= 18) ageGroups['0-18']++;
      else if (a <= 35) ageGroups['19-35']++;
      else if (a <= 50) ageGroups['36-50']++;
      else if (a <= 65) ageGroups['51-65']++;
      else ageGroups['65+']++;
    });
    const ageDistribution = Object.keys(ageGroups).map(group => ({
      group,
      count: ageGroups[group]
    }));

    // 5. Diagnoses Frequency
    const diagMap = {};
    filteredExaminations.forEach(e => {
      if (e.diagnoses && Array.isArray(e.diagnoses)) {
        e.diagnoses.forEach(d => {
          diagMap[d] = (diagMap[d] || 0) + 1;
        });
      }
    });
    const diagnosisDistribution = Object.keys(diagMap)
      .map(name => ({ name, count: diagMap[name] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    // 6. Doctor Performance
    const doctorMap = {};
    filteredExaminations.forEach(e => {
      const doc = e.assignedOptometrist ? e.assignedOptometrist.split(' ')[1] || e.assignedOptometrist : 'Optometrist';
      doctorMap[doc] = (doctorMap[doc] || 0) + 1;
    });
    const doctorDistribution = Object.keys(doctorMap).map(doc => ({
      doctor: doc,
      tests: doctorMap[doc]
    }));

    return {
      dailyTrend,
      typeDistribution,
      genderDistribution,
      ageDistribution,
      diagnosisDistribution,
      doctorDistribution
    };
  }, [filteredExaminations, metrics]);

  // Export Actions
  const handleExportPdf = () => {
    alert(`Exporting ${filteredExaminations.length} Eye Test Clinical Reports to Official PDF...\nDownload started.`);
  };

  const handleExportExcel = () => {
    const csvHeader = "Test No,Date,Patient ID,Patient Name,Age,Gender,Phone,Test Type,Doctor,Status,VA Right,VA Left,Diagnosis,Next Visit\n";
    const csvRows = filteredExaminations.map(e => 
      `"${e.testNo}","${e.date}","${e.patientId}","${e.name}",${e.age},"${e.gender}","${e.phone}","${e.testType}","${e.assignedOptometrist}","${e.status}","${e.vaRight}","${e.vaLeft}","${(e.diagnoses || []).join('; ')}","${e.nextReviewDate || ''}"`
    ).join('\n');
    
    const blob = new Blob([csvHeader + csvRows], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Eye_Test_Clinical_Report_${new Date().toISOString().split('T')[0]}.csv`;
    a.click();
  };

  const handlePrintReport = () => {
    window.print();
  };

  // View Row Details
  const handleOpenDetails = (exam) => {
    setSelectedExam(exam);
    setDrawerOpen(true);
  };

  // Delete Exam
  const handleDeleteExam = (exam) => {
    setExamToDelete(exam);
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = () => {
    if (examToDelete) {
      setExaminations(prev => prev.filter(e => e.id !== examToDelete.id));
      setDeleteConfirmOpen(false);
      setExamToDelete(null);
      if (drawerOpen && selectedExam?.id === examToDelete.id) {
        setDrawerOpen(false);
      }
    }
  };

  return (
    <Box sx={{ p: { xs: 2, sm: 3, md: 4 }, pb: 8, bgcolor: 'background.default', minHeight: '100vh' }}>
      
      {/* 📌 PAGE HEADER */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h4" fontWeight={850} sx={{ display: 'flex', alignItems: 'center', gap: 1.5, color: 'text.primary' }}>
            <EyeIcon sx={{ color: 'primary.main', fontSize: 36 }} /> Eye Test Clinical Report
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5, maxWidth: 800 }}>
            View, search, analyze, and export patient eye examination records with advanced clinical reporting and analytics.
          </Typography>
        </Box>

        {/* Action Header Buttons */}
        <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button 
            variant="outlined" 
            color="error" 
            startIcon={<PdfIcon />} 
            onClick={handleExportPdf}
            sx={{ fontWeight: 700, borderRadius: 2.5, textTransform: 'none' }}
          >
            Export PDF
          </Button>
          <Button 
            variant="contained" 
            color="success" 
            startIcon={<ExcelIcon />} 
            onClick={handleExportExcel}
            sx={{ fontWeight: 700, borderRadius: 2.5, textTransform: 'none', bgcolor: '#10b981', '&:hover': { bgcolor: '#059669' } }}
          >
            Export Excel
          </Button>
          <Button 
            variant="outlined" 
            color="primary" 
            startIcon={<PrintIcon />} 
            onClick={handlePrintReport}
            sx={{ fontWeight: 700, borderRadius: 2.5, textTransform: 'none' }}
          >
            Print Report
          </Button>
          <Button 
            variant="contained" 
            color="primary" 
            startIcon={<AddIcon />} 
            onClick={() => navigate('/optical/eyetest')}
            sx={{ fontWeight: 700, borderRadius: 2.5, textTransform: 'none', boxShadow: '0 4px 14px rgba(37,99,235,0.3)' }}
          >
            New Eye Test
          </Button>
        </Stack>
      </Box>

      {/* 🔍 SEARCH & ADVANCED FILTER PANEL */}
      <Card variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3.5, bgcolor: '#ffffff', borderColor: '#cbd5e1', boxShadow: '0 2px 10px rgba(0,0,0,0.02)' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="center" justifyContent="space-between">
          <TextField 
            fullWidth 
            size="small" 
            placeholder="Search Test No, Patient Name, ID, Mobile, Doctor, Diagnosis..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            InputProps={{ 
              startAdornment: <SearchIcon color="action" sx={{ mr: 1, fontSize: 20 }} />,
              endAdornment: searchQuery && (
                <IconButton size="small" onClick={() => setSearchQuery('')}><CloseIcon fontSize="small" /></IconButton>
              )
            }}
            sx={{ flexGrow: 1 }}
          />

          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ width: { xs: '100%', md: 'auto' } }}>
            <Button 
              variant={filterPanelOpen ? "contained" : "outlined"}
              color="primary"
              startIcon={<FilterIcon />}
              endIcon={filterPanelOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              onClick={() => setFilterPanelOpen(!filterPanelOpen)}
              sx={{ fontWeight: 700, borderRadius: 2.5, textTransform: 'none', whiteSpace: 'nowrap' }}
            >
              Advanced Filters {Object.values(filters).filter(v => v && v !== 'ALL').length > 0 && `(${Object.values(filters).filter(v => v && v !== 'ALL').length})`}
            </Button>

            <Button 
              variant="outlined" 
              color="inherit" 
              startIcon={<ResetIcon />} 
              onClick={handleResetFilters}
              sx={{ fontWeight: 700, borderRadius: 2.5, textTransform: 'none', whiteSpace: 'nowrap' }}
            >
              Reset
            </Button>
          </Stack>
        </Stack>

        {/* Collapsible Advanced Filter Fields */}
        <Collapse in={filterPanelOpen} timeout="auto" unmountOnExit>
          <Divider sx={{ my: 2.5 }} />
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6} md={3}>
              <TextField 
                fullWidth size="small" label="Test Number" 
                value={filters.testNo} onChange={(e) => handleFilterChange('testNo', e.target.value)} 
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField 
                fullWidth size="small" label="Patient ID" 
                value={filters.patientId} onChange={(e) => handleFilterChange('patientId', e.target.value)} 
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField 
                fullWidth size="small" label="Patient Name" 
                value={filters.name} onChange={(e) => handleFilterChange('name', e.target.value)} 
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField 
                fullWidth size="small" label="Mobile Number" 
                value={filters.phone} onChange={(e) => handleFilterChange('phone', e.target.value)} 
              />
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField 
                fullWidth select size="small" label="Test Type" 
                value={filters.testType} onChange={(e) => handleFilterChange('testType', e.target.value)}
              >
                <MenuItem value="ALL">All Test Types</MenuItem>
                <MenuItem value="FREE EYE TEST">FREE EYE TEST</MenuItem>
                <MenuItem value="COMPREHENSIVE EYE TEST">COMPREHENSIVE EYE TEST</MenuItem>
                <MenuItem value="CONTACT LENS EVALUATION">CONTACT LENS EVALUATION</MenuItem>
                <MenuItem value="ROUTINE REFRACTION">ROUTINE REFRACTION</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField 
                fullWidth select size="small" label="Optometrist / Doctor" 
                value={filters.optometrist} onChange={(e) => handleFilterChange('optometrist', e.target.value)}
              >
                <MenuItem value="ALL">All Optometrists</MenuItem>
                <MenuItem value="Ananya Roy">Dr. Ananya Roy</MenuItem>
                <MenuItem value="Suresh Varma">Dr. Suresh Varma</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField 
                fullWidth select size="small" label="Gender" 
                value={filters.gender} onChange={(e) => handleFilterChange('gender', e.target.value)}
              >
                <MenuItem value="ALL">All Genders</MenuItem>
                <MenuItem value="Male">Male</MenuItem>
                <MenuItem value="Female">Female</MenuItem>
                <MenuItem value="Other">Other</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField 
                fullWidth select size="small" label="Status" 
                value={filters.status} onChange={(e) => handleFilterChange('status', e.target.value)}
              >
                <MenuItem value="ALL">All Statuses</MenuItem>
                <MenuItem value="Completed">Completed</MenuItem>
                <MenuItem value="Pending">Pending</MenuItem>
                <MenuItem value="Cancelled">Cancelled</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <QuickDatePickerField 
                label="Date From" value={filters.fromDate} 
                onChange={(d) => handleFilterChange('fromDate', d)} 
              />
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <QuickDatePickerField 
                label="Date To" value={filters.toDate} 
                onChange={(d) => handleFilterChange('toDate', d)} 
              />
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <QuickDatePickerField 
                label="Next Review Visit" value={filters.nextVisit} 
                onChange={(d) => handleFilterChange('nextVisit', d)} 
              />
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField 
                fullWidth size="small" label="Age" type="number"
                value={filters.age} onChange={(e) => handleFilterChange('age', e.target.value)} 
              />
            </Grid>
          </Grid>

          <Box sx={{ mt: 2.5, display: 'flex', justifyContent: 'flex-end', gap: 1.5 }}>
            <Button variant="outlined" size="small" onClick={handleResetFilters} sx={{ fontWeight: 700 }}>Reset Filters</Button>
            <Button variant="contained" size="small" onClick={() => setFilterPanelOpen(false)} sx={{ fontWeight: 700 }}>Apply Filters</Button>
          </Box>
        </Collapse>
      </Card>

      {/* 📊 SUMMARY DASHBOARD KPI CARDS */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        {/* Card 1: Total Eye Tests */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: `4px solid ${COLORS.primary}`, bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>TOTAL EYE TESTS</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: 'primary.50', color: 'primary.main' }}><ExamIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} color="primary.main">{metrics.total}</Typography>
            <Typography variant="caption" color="success.main" fontWeight={700} sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mt: 0.5 }}>
              ↑ +12.4% <span style={{ color: '#64748b', fontWeight: 500 }}>vs last month</span>
            </Typography>
          </Paper>
        </Grid>

        {/* Card 2: Today's Eye Tests */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: `4px solid ${COLORS.secondary}`, bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>TODAY'S EYE TESTS</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: '#f3e8ff', color: COLORS.secondary }}><CalendarIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} sx={{ color: COLORS.secondary }}>{metrics.todayCount}</Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ mt: 0.5, display: 'block' }}>
              Logged today in clinic
            </Typography>
          </Paper>
        </Grid>

        {/* Card 3: Free Eye Tests */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: `4px solid ${COLORS.info}`, bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>FREE EYE TESTS</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: '#e0f2fe', color: COLORS.info }}><FreeIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} sx={{ color: COLORS.info }}>{metrics.freeCount}</Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ mt: 0.5, display: 'block' }}>
              Community & Camp Tests
            </Typography>
          </Paper>
        </Grid>

        {/* Card 4: Paid Eye Tests */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: `4px solid ${COLORS.success}`, bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>PAID EYE TESTS</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: '#d1fae5', color: COLORS.success }}><PaidIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} color="success.main">{metrics.paidCount}</Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ mt: 0.5, display: 'block' }}>
              Revenue Generating
            </Typography>
          </Paper>
        </Grid>

        {/* Card 5: Follow-up Patients */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: `4px solid ${COLORS.warning}`, bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>FOLLOW-UP REVIEWS</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: '#fef3c7', color: COLORS.warning }}><CalendarIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} sx={{ color: COLORS.warning }}>{metrics.followupCount}</Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ mt: 0.5, display: 'block' }}>
              Scheduled Appointments
            </Typography>
          </Paper>
        </Grid>

        {/* Card 6: Average Age */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #64748b', bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>AVG PATIENT AGE</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: '#f1f5f9', color: '#475569' }}><PersonIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} sx={{ color: '#334155' }}>{metrics.avgAge} <span style={{ fontSize: '1rem' }}>yrs</span></Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ mt: 0.5, display: 'block' }}>
              Demographic Span
            </Typography>
          </Paper>
        </Grid>

        {/* Card 7: Male Patients */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #3b82f6', bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>MALE PATIENTS</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: '#dbeafe', color: '#2563eb' }}><MaleIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} sx={{ color: '#2563eb' }}>{metrics.maleCount}</Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ mt: 0.5, display: 'block' }}>
              {metrics.total > 0 ? Math.round((metrics.maleCount / metrics.total) * 100) : 0}% of Total
            </Typography>
          </Paper>
        </Grid>

        {/* Card 8: Female Patients */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #ec4899', bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>FEMALE PATIENTS</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: '#fce7f3', color: '#ec4899' }}><FemaleIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} sx={{ color: '#ec4899' }}>{metrics.femaleCount}</Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ mt: 0.5, display: 'block' }}>
              {metrics.total > 0 ? Math.round((metrics.femaleCount / metrics.total) * 100) : 0}% of Total
            </Typography>
          </Paper>
        </Grid>

        {/* Card 9: Avg Exam Time */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #8b5cf6', bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>AVG EXAM TIME</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: '#ede9fe', color: '#7c3aed' }}><TimeIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} sx={{ color: '#7c3aed' }}>18 <span style={{ fontSize: '1rem' }}>mins</span></Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ mt: 0.5, display: 'block' }}>
              Clinical Efficiency
            </Typography>
          </Paper>
        </Grid>

        {/* Card 10: Completed Reports */}
        <Grid item xs={12} sm={6} md={2.4}>
          <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: '4px solid #10b981', bgcolor: '#ffffff' }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
              <Typography variant="caption" color="text.secondary" fontWeight={800}>COMPLETED REPORTS</Typography>
              <Avatar sx={{ width: 32, height: 32, bgcolor: '#d1fae5', color: '#10b981' }}><SuccessIcon fontSize="small" /></Avatar>
            </Box>
            <Typography variant="h4" fontWeight={850} color="success.main">{metrics.completedCount}</Typography>
            <Typography variant="caption" color="success.main" fontWeight={700} sx={{ mt: 0.5, display: 'block' }}>
              {metrics.completionRate}% Finalized Ratio
            </Typography>
          </Paper>
        </Grid>
      </Grid>

      {/* 📈 ANALYTICS CHARTS DASHBOARD (COLLAPSIBLE) */}
      <Card variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3.5, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="subtitle1" fontWeight={850} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ChartIcon /> Eye Examination Clinical Analytics Dashboard
          </Typography>
          <Button 
            size="small" 
            variant="outlined" 
            onClick={() => setShowCharts(!showCharts)}
            sx={{ fontWeight: 700, borderRadius: 2 }}
          >
            {showCharts ? 'Hide Analytics Charts' : 'Show Analytics Charts'}
          </Button>
        </Box>

        <Collapse in={showCharts} timeout="auto" unmountOnExit>
          <Grid container spacing={3} sx={{ pt: 1 }}>
            {/* Chart 1: Daily Eye Test Trend */}
            <Grid item xs={12} md={6}>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 2 }}>Daily Examination Volume Trend</Typography>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData.dailyTrend}>
                    <defs>
                      <linearGradient id="colorTests" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.8}/>
                        <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0.0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="date" stroke="#64748b" fontSize={12} />
                    <YAxis stroke="#64748b" fontSize={12} />
                    <RechartsTooltip />
                    <Area type="monotone" dataKey="tests" stroke={COLORS.primary} strokeWidth={3} fillOpacity={1} fill="url(#colorTests)" />
                  </AreaChart>
                </ResponsiveContainer>
              </Paper>
            </Grid>

            {/* Chart 2: Test Type Distribution */}
            <Grid item xs={12} md={6}>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 2 }}>Test Type Category Breakdown</Typography>
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={chartData.typeDistribution} cx="50%" cy="50%" innerRadius={50} outerRadius={80} paddingAngle={4} dataKey="value">
                      {chartData.typeDistribution.map((entry, index) => (
                        <Cell key={`cell-${index}`} fill={COLORS.chart[index % COLORS.chart.length]} />
                      ))}
                    </Pie>
                    <RechartsTooltip />
                    <Legend verticalAlign="bottom" height={36} iconType="circle" />
                  </PieChart>
                </ResponsiveContainer>
              </Paper>
            </Grid>

            {/* Chart 3: Most Common Diagnoses */}
            <Grid item xs={12} md={6}>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 2 }}>Top Ophthalmic Diagnoses Frequency</Typography>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData.diagnosisDistribution} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                    <XAxis type="number" stroke="#64748b" fontSize={12} />
                    <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={11} width={130} />
                    <RechartsTooltip />
                    <Bar dataKey="count" fill={COLORS.secondary} radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Paper>
            </Grid>

            {/* Chart 4: Doctor-wise Examinations */}
            <Grid item xs={12} md={6}>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 2 }}>Doctor-wise Clinical Examinations</Typography>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData.doctorDistribution}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="doctor" stroke="#64748b" fontSize={12} />
                    <YAxis stroke="#64748b" fontSize={12} />
                    <RechartsTooltip />
                    <Bar dataKey="tests" fill={COLORS.success} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Paper>
            </Grid>
          </Grid>
        </Collapse>
      </Card>

      {/* 📋 ENTERPRISE EYE TEST REPORT DATA TABLE */}
      <Paper variant="outlined" sx={{ borderRadius: 3.5, borderColor: '#cbd5e1', overflow: 'hidden', bgcolor: '#ffffff', boxShadow: '0 4px 20px rgba(0,0,0,0.03)' }}>
        {/* Table Batch Operations Toolbar */}
        <Box sx={{ p: 2, bgcolor: '#f8fafc', borderBottom: '1px solid', borderColor: 'divider', display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1 }}>
          <Typography variant="subtitle2" fontWeight={850} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ExamIcon /> Clinical Examination Records Directory ({filteredExaminations.length})
          </Typography>

          {selectedIds.length > 0 && (
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip label={`${selectedIds.length} Rows Selected`} size="small" color="primary" sx={{ fontWeight: 800 }} />
              <Button size="small" variant="contained" color="success" startIcon={<ExcelIcon />} onClick={handleExportExcel} sx={{ fontWeight: 700 }}>
                Export Selected ({selectedIds.length})
              </Button>
            </Stack>
          )}
        </Box>

        {/* Data Table */}
        <TableContainer sx={{ maxHeight: 600 }}>
          <Table stickyHeader size="small">
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 850, bgcolor: '#0f172a', color: '#ffffff', fontSize: '0.82rem' } }}>
                <TableCell padding="checkbox">
                  <Checkbox 
                    indeterminate={selectedIds.length > 0 && selectedIds.length < filteredExaminations.length}
                    checked={filteredExaminations.length > 0 && selectedIds.length === filteredExaminations.length}
                    onChange={handleSelectAll}
                    sx={{ color: '#fff', '&.Mui-checked': { color: '#fff' } }}
                  />
                </TableCell>
                <TableCell sx={{ cursor: 'pointer' }} onClick={() => { setOrderBy('testNo'); setOrder(order === 'asc' ? 'desc' : 'asc'); }}>
                  Test No {orderBy === 'testNo' ? (order === 'asc' ? '↑' : '↓') : ''}
                </TableCell>
                <TableCell sx={{ cursor: 'pointer' }} onClick={() => { setOrderBy('date'); setOrder(order === 'asc' ? 'desc' : 'asc'); }}>
                  Date {orderBy === 'date' ? (order === 'asc' ? '↑' : '↓') : ''}
                </TableCell>
                <TableCell>Patient ID</TableCell>
                <TableCell sx={{ cursor: 'pointer' }} onClick={() => { setOrderBy('name'); setOrder(order === 'asc' ? 'desc' : 'asc'); }}>
                  Patient Name {orderBy === 'name' ? (order === 'asc' ? '↑' : '↓') : ''}
                </TableCell>
                <TableCell>Age / Gender</TableCell>
                <TableCell>Mobile Number</TableCell>
                <TableCell>Test Type</TableCell>
                <TableCell>Optometrist</TableCell>
                <TableCell>OD Vision (Right)</TableCell>
                <TableCell>OS Vision (Left)</TableCell>
                <TableCell>Diagnosis</TableCell>
                <TableCell>Next Visit</TableCell>
                <TableCell>Status</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>

            <TableBody>
              {paginatedRows.length === 0 ? (
                /* EMPTY STATE */
                <TableRow>
                  <TableCell colSpan={15} align="center" sx={{ py: 8 }}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                      <EyeIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 1.5 }} />
                      <Typography variant="h6" fontWeight={800} color="text.secondary">No Eye Test Reports Found</Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 450, mt: 0.5, mb: 2.5 }}>
                        Clinical reports will appear here after patient examinations are completed. Adjust search query or filters.
                      </Typography>
                      <Button 
                        variant="contained" 
                        color="primary" 
                        startIcon={<AddIcon />}
                        onClick={() => navigate('/optical/eyetest')}
                        sx={{ fontWeight: 800, borderRadius: 2.5, px: 3 }}
                      >
                        Create New Eye Test
                      </Button>
                    </Box>
                  </TableCell>
                </TableRow>
              ) : (
                paginatedRows.map((row) => {
                  const isSelected = selectedIds.includes(row.id);
                  return (
                    <TableRow 
                      key={row.id} 
                      hover 
                      selected={isSelected}
                      sx={{ 
                        '&:hover': { bgcolor: 'action.hover' },
                        cursor: 'pointer'
                      }}
                      onClick={() => handleOpenDetails(row)}
                    >
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                        <Checkbox 
                          checked={isSelected}
                          onChange={() => handleSelectOne(row.id)}
                        />
                      </TableCell>

                      <TableCell sx={{ fontWeight: 850, color: 'primary.main' }}>
                        {row.testNo}
                      </TableCell>
                      
                      <TableCell sx={{ fontWeight: 600 }}>
                        {row.date}
                      </TableCell>

                      <TableCell sx={{ fontWeight: 700, color: 'text.secondary' }}>
                        {row.patientId}
                      </TableCell>

                      <TableCell sx={{ fontWeight: 800 }}>
                        {row.name}
                      </TableCell>

                      <TableCell>
                        <Stack direction="row" spacing={0.5} alignItems="center">
                          <Typography variant="body2" fontWeight={700}>{row.age} yrs</Typography>
                          <Chip 
                            label={row.gender} 
                            size="small" 
                            sx={{ 
                              height: 18, fontSize: '0.65rem', fontWeight: 800,
                              bgcolor: row.gender === 'Male' ? '#dbeafe' : '#fce7f3',
                              color: row.gender === 'Male' ? '#1e40af' : '#9d174d'
                            }} 
                          />
                        </Stack>
                      </TableCell>

                      <TableCell sx={{ fontWeight: 600, color: 'text.secondary' }}>
                        {row.phone}
                      </TableCell>

                      <TableCell>
                        <Chip 
                          label={row.testType.replace(' EYE TEST', '')} 
                          size="small"
                          sx={{ 
                            fontWeight: 800, fontSize: '0.7rem',
                            bgcolor: row.testType === 'FREE EYE TEST' ? '#e0f2fe' : '#ede9fe',
                            color: row.testType === 'FREE EYE TEST' ? '#0369a1' : '#6d28d9'
                          }} 
                        />
                      </TableCell>

                      <TableCell sx={{ fontWeight: 600 }}>
                        {row.assignedOptometrist.replace('Dr. ', '')}
                      </TableCell>

                      <TableCell sx={{ fontWeight: 700, color: '#2563eb' }}>
                        {row.vaRight}
                      </TableCell>

                      <TableCell sx={{ fontWeight: 700, color: '#7c3aed' }}>
                        {row.vaLeft}
                      </TableCell>

                      <TableCell>
                        {row.diagnoses && row.diagnoses.length > 0 ? (
                          <Chip 
                            label={row.diagnoses[0]} 
                            size="small" 
                            variant="outlined"
                            color="primary"
                            sx={{ fontWeight: 700, fontSize: '0.7rem' }} 
                          />
                        ) : '—'}
                      </TableCell>

                      <TableCell sx={{ fontWeight: 600 }}>
                        {row.nextReviewDate || 'N/A'}
                      </TableCell>

                      <TableCell>
                        <Chip 
                          label={row.status} 
                          size="small"
                          color={row.status === 'Completed' ? 'success' : (row.status === 'Pending' ? 'warning' : 'error')}
                          sx={{ fontWeight: 800, height: 22, fontSize: '0.7rem' }}
                        />
                      </TableCell>

                      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                        <Stack direction="row" spacing={0.5} justifyContent="center">
                          <Tooltip title="View Detailed Report Drawer">
                            <IconButton size="small" color="primary" onClick={() => handleOpenDetails(row)}>
                              <EyeIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Print Hospital Prescription">
                            <IconButton size="small" color="secondary" onClick={() => { setSelectedExam(row); setPrintModalOpen(true); }}>
                              <PrintIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Export Single PDF">
                            <IconButton size="small" color="error" onClick={handleExportPdf}>
                              <PdfIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Delete Examination Record">
                            <IconButton size="small" color="default" onClick={() => handleDeleteExam(row)}>
                              <DeleteIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>
                        </Stack>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </TableContainer>

        {/* Pagination */}
        <TablePagination
          rowsPerPageOptions={[5, 10, 25, 50]}
          component="div"
          count={filteredExaminations.length}
          rowsPerPage={rowsPerPage}
          page={page}
          onPageChange={(e, newPage) => setPage(newPage)}
          onRowsPerPageChange={(e) => {
            setRowsPerPage(parseInt(e.target.value, 10));
            setPage(0);
          }}
        />
      </Paper>

      {/* 🏥 EYE TEST DETAILS DRAWER (RIGHT SIDE SLIDE-OUT) */}
      <Drawer
        anchor="right"
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        PaperProps={{
          sx: { width: { xs: '100%', sm: 620, md: 680 }, p: 0, bgcolor: '#f8fafc' }
        }}
      >
        {selectedExam && (
          <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Drawer Header */}
            <Box sx={{ p: 2.5, bgcolor: '#0f172a', color: '#ffffff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Box>
                <Typography variant="h6" fontWeight={850} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                  <EyeIcon color="primary" /> Eye Clinical Examination #{selectedExam.testNo}
                </Typography>
                <Typography variant="caption" sx={{ color: '#94a3b8' }}>
                  Recorded on {selectedExam.date} | {selectedExam.branch}
                </Typography>
              </Box>
              <IconButton onClick={() => setDrawerOpen(false)} sx={{ color: '#fff' }}>
                <CloseIcon />
              </IconButton>
            </Box>

            {/* Scrollable Content */}
            <Box sx={{ p: 3, flexGrow: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 2.5 }}>
              
              {/* Section A: Patient Profile Info Header */}
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
                <Grid container spacing={2} alignItems="center">
                  <Grid item xs="auto">
                    <Avatar 
                      sx={{ 
                        width: 64, height: 64, bgcolor: 'primary.main', 
                        fontSize: '1.5rem', fontWeight: 800 
                      }}
                    >
                      {selectedExam.name ? selectedExam.name.charAt(0) : 'P'}
                    </Avatar>
                  </Grid>

                  <Grid item xs>
                    <Typography variant="h6" fontWeight={850}>{selectedExam.name}</Typography>
                    <Stack direction="row" spacing={1} alignItems="center" sx={{ mt: 0.5, flexWrap: 'wrap' }}>
                      <Chip label={`ID: ${selectedExam.patientId}`} size="small" sx={{ fontWeight: 800, bgcolor: '#e2e8f0' }} />
                      <Chip label={`${selectedExam.age} Years`} size="small" />
                      <Chip label={selectedExam.gender} size="small" color={selectedExam.gender === 'Male' ? 'primary' : 'secondary'} />
                    </Stack>
                  </Grid>
                </Grid>

                <Divider sx={{ my: 2 }} />

                <Grid container spacing={1.5}>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>MOBILE NUMBER</Typography>
                    <Typography variant="body2" fontWeight={800}>{selectedExam.phone}</Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>EMAIL ADDRESS</Typography>
                    <Typography variant="body2" fontWeight={700}>{selectedExam.email}</Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>OCCUPATION</Typography>
                    <Typography variant="body2">{selectedExam.occupation}</Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>OPTOMETRIST</Typography>
                    <Typography variant="body2" fontWeight={800} color="primary.main">{selectedExam.assignedOptometrist}</Typography>
                  </Grid>
                  <Grid item xs={12}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>RESIDENTIAL ADDRESS</Typography>
                    <Typography variant="body2">{selectedExam.address}</Typography>
                  </Grid>
                </Grid>
              </Paper>

              {/* Section B: Visual Acuity */}
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
                <Typography variant="subtitle2" fontWeight={850} color="primary.main" sx={{ mb: 1.5 }}>
                  1. Visual Acuity Record
                </Typography>
                <Grid container spacing={2}>
                  <Grid item xs={6}>
                    <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: '#eff6ff', border: '1px solid #bfdbfe' }}>
                      <Typography variant="caption" fontWeight={800} color="primary.main">RIGHT EYE (OD)</Typography>
                      <Typography variant="h6" fontWeight={850}>{selectedExam.vaRight}</Typography>
                      <Typography variant="caption" color="text.secondary">Distance & Near Vision</Typography>
                    </Box>
                  </Grid>

                  <Grid item xs={6}>
                    <Box sx={{ p: 1.5, borderRadius: 2, bgcolor: '#f5f3ff', border: '1px solid #ddd6fe' }}>
                      <Typography variant="caption" fontWeight={800} color="secondary.main">LEFT EYE (OS)</Typography>
                      <Typography variant="h6" fontWeight={850}>{selectedExam.vaLeft}</Typography>
                      <Typography variant="caption" color="text.secondary">Distance & Near Vision</Typography>
                    </Box>
                  </Grid>
                </Grid>
              </Paper>

              {/* Section C: Subjective Refraction Table */}
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
                <Typography variant="subtitle2" fontWeight={850} color="primary.main" sx={{ mb: 1.5 }}>
                  2. Subjective Refraction Parameters
                </Typography>

                <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                  <Table size="small">
                    <TableHead sx={{ bgcolor: '#0f172a' }}>
                      <TableRow>
                        <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Eye</TableCell>
                        <TableCell sx={{ color: '#fff', fontWeight: 800 }}>SPH</TableCell>
                        <TableCell sx={{ color: '#fff', fontWeight: 800 }}>CYL</TableCell>
                        <TableCell sx={{ color: '#fff', fontWeight: 800 }}>AXIS</TableCell>
                        <TableCell sx={{ color: '#fff', fontWeight: 800 }}>ADD</TableCell>
                        <TableCell sx={{ color: '#fff', fontWeight: 800 }}>PRISM</TableCell>
                      </TableRow>
                    </TableHead>

                    <TableBody>
                      <TableRow>
                        <TableCell sx={{ fontWeight: 850, color: 'primary.main' }}>OD (Right)</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>{selectedExam.refraction?.od?.sph || '0.00'}</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>{selectedExam.refraction?.od?.cyl || '0.00'}</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>{selectedExam.refraction?.od?.axis || '0'}°</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>{selectedExam.refraction?.od?.add || '0.00'}</TableCell>
                        <TableCell>{selectedExam.refraction?.od?.prism || '0.0'}</TableCell>
                      </TableRow>

                      <TableRow>
                        <TableCell sx={{ fontWeight: 850, color: 'secondary.main' }}>OS (Left)</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>{selectedExam.refraction?.os?.sph || '0.00'}</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>{selectedExam.refraction?.os?.cyl || '0.00'}</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>{selectedExam.refraction?.os?.axis || '0'}°</TableCell>
                        <TableCell sx={{ fontWeight: 800 }}>{selectedExam.refraction?.os?.add || '0.00'}</TableCell>
                        <TableCell>{selectedExam.refraction?.os?.prism || '0.0'}</TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>
                </TableContainer>
              </Paper>

              {/* Section D: Keratometry & Intraocular Pressure */}
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
                <Typography variant="subtitle2" fontWeight={850} color="primary.main" sx={{ mb: 1.5 }}>
                  3. Corneal & Intraocular Health (Keratometry & IOP)
                </Typography>
                <Grid container spacing={2}>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>KERATOMETRY OD (RIGHT)</Typography>
                    <Typography variant="body2" fontWeight={800}>{selectedExam.keratometry?.od || 'N/A'}</Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>KERATOMETRY OS (LEFT)</Typography>
                    <Typography variant="body2" fontWeight={800}>{selectedExam.keratometry?.os || 'N/A'}</Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>IOP OD (RIGHT)</Typography>
                    <Typography variant="body2" fontWeight={800} color="success.main">{selectedExam.iop?.od || '14 mmHg'}</Typography>
                  </Grid>
                  <Grid item xs={6}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>IOP OS (LEFT)</Typography>
                    <Typography variant="body2" fontWeight={800} color="success.main">{selectedExam.iop?.os || '15 mmHg'}</Typography>
                  </Grid>
                </Grid>
              </Paper>

              {/* Section E: Diagnosis & ICD-10 Badges */}
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
                <Typography variant="subtitle2" fontWeight={850} color="primary.main" sx={{ mb: 1.5 }}>
                  4. Clinical Diagnoses & ICD-10 Classification
                </Typography>
                <Stack direction="row" spacing={1} sx={{ flexWrap: 'wrap', gap: 1 }}>
                  {selectedExam.diagnoses && selectedExam.diagnoses.map((d, i) => (
                    <Chip 
                      key={i}
                      label={`${d} (${selectedExam.icdCodes?.[i] || 'ICD-10'})`}
                      color="primary"
                      variant="outlined"
                      sx={{ fontWeight: 800 }}
                    />
                  ))}
                </Stack>
              </Paper>

              {/* Section F: Recommended Optical Products */}
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
                <Typography variant="subtitle2" fontWeight={850} color="primary.main" sx={{ mb: 1.5 }}>
                  5. Recommended Optical Products & Spectacle Dispensing
                </Typography>
                <Stack spacing={1}>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>FRAME RECOMMENDATION:</Typography>
                    <Typography variant="body2" fontWeight={800}>{selectedExam.products?.frame || 'Standard Acetate Frame'}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>OPHTHALMIC LENS TYPE:</Typography>
                    <Typography variant="body2" fontWeight={800} color="primary.main">{selectedExam.products?.lens || 'Blue Cut Anti-Reflective Lens'}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>COATING & TREATMENTS:</Typography>
                    <Typography variant="body2">{selectedExam.products?.coating || 'Anti-Reflective Coating'}</Typography>
                  </Box>
                  <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
                    <Typography variant="caption" color="text.secondary" fontWeight={700}>ACCESSORIES & SOLUTIONS:</Typography>
                    <Typography variant="body2">{selectedExam.products?.accessories || 'Microfiber Spray Kit'}</Typography>
                  </Box>
                </Stack>
              </Paper>

              {/* Section G: Doctor Remarks */}
              <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 3, bgcolor: '#ffffff' }}>
                <Typography variant="subtitle2" fontWeight={850} color="primary.main" sx={{ mb: 1 }}>
                  6. Optometrist Clinical Notes & Ergonomic Advice
                </Typography>
                <Box sx={{ p: 2, borderRadius: 2, bgcolor: '#f8fafc', border: '1px solid #e2e8f0', maxHeight: 120, overflowY: 'auto' }}>
                  <Typography variant="body2" color="text.secondary" sx={{ fontStyle: 'italic' }}>
                    "{selectedExam.remarks}"
                  </Typography>
                </Box>
              </Paper>

              {/* Section H: Next Review */}
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, bgcolor: '#ecfdf5', borderColor: '#a7f3d0' }}>
                <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <Box>
                    <Typography variant="caption" fontWeight={800} color="success.main">NEXT SCHEDULED REVIEW VISIT</Typography>
                    <Typography variant="h6" fontWeight={850} color="success.main">{selectedExam.nextReviewDate || 'In 6 Months'}</Typography>
                  </Box>
                  <Chip label="WhatsApp Reminder Active" color="success" size="small" sx={{ fontWeight: 800 }} />
                </Box>
              </Paper>
            </Box>

            {/* Drawer Bottom Actions */}
            <Paper elevation={4} sx={{ p: 2, borderTop: '1px solid', borderColor: 'divider', bgcolor: '#ffffff' }}>
              <Stack direction="row" spacing={1.5} justifyContent="space-between">
                <Button 
                  variant="outlined" 
                  color="inherit" 
                  onClick={() => setDrawerOpen(false)}
                  sx={{ fontWeight: 700 }}
                >
                  Close
                </Button>

                <Stack direction="row" spacing={1}>
                  <Button 
                    variant="outlined" 
                    color="primary" 
                    startIcon={<CalendarIcon />}
                    onClick={() => navigate('/optical/appointment')}
                    sx={{ fontWeight: 700 }}
                  >
                    Book Appointment
                  </Button>

                  <Button 
                    variant="contained" 
                    color="primary" 
                    startIcon={<PrintIcon />}
                    onClick={() => setPrintModalOpen(true)}
                    sx={{ fontWeight: 700 }}
                  >
                    Print Prescription
                  </Button>
                </Stack>
              </Stack>
            </Paper>
          </Box>
        )}
      </Drawer>

      {/* 🖨️ PRINT PRESCRIPTION DIALOG */}
      <Dialog 
        open={printModalOpen} 
        onClose={() => setPrintModalOpen(false)} 
        maxWidth="lg" 
        fullWidth
        PaperProps={{ style: { borderRadius: 12 } }}
      >
        <Box sx={{ p: 2, bgcolor: '#0f172a', color: '#fff', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="h6" fontWeight={850} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PrintIcon color="secondary" /> Official Hospital Letterhead Prescription Preview
          </Typography>
          <IconButton onClick={() => setPrintModalOpen(false)} sx={{ color: '#fff' }}><CloseIcon /></IconButton>
        </Box>
        <Box sx={{ p: 2, bgcolor: '#f8fafc' }}>
          {selectedExam && (
            <PrintPrescriptionCard
              patientData={{
                name: selectedExam.name,
                id: selectedExam.patientId,
                age: selectedExam.age,
                gender: selectedExam.gender,
                phone: selectedExam.phone,
                date: selectedExam.date,
                assignedOptometrist: selectedExam.assignedOptometrist
              }}
              subjectiveRefraction={selectedExam.refraction}
              diagnosis={{
                primary: selectedExam.diagnoses?.[0] || 'Routine Refraction',
                icdCode: selectedExam.icdCodes?.[0] || 'H52.1',
                remarks: selectedExam.remarks,
                nextReviewDate: selectedExam.nextReviewDate
              }}
              prescription={{
                selectedLenses: [selectedExam.products?.lens || 'Blue Cut Lens']
              }}
            />
          )}
        </Box>
      </Dialog>

      {/* 🗑️ DELETE CONFIRMATION DIALOG */}
      <Dialog open={deleteConfirmOpen} onClose={() => setDeleteConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Confirm Deletion</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            Are you sure you want to delete Eye Examination Record <strong>{examToDelete?.testNo}</strong> for <strong>{examToDelete?.name}</strong>? This action cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setDeleteConfirmOpen(false)}>Cancel</Button>
          <Button variant="contained" color="error" onClick={confirmDelete} sx={{ fontWeight: 700 }}>Delete Record</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
