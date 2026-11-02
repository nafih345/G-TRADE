import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Box, Card, Typography, Button, Grid, Table, TableBody,
  TableCell, TableContainer, TableHead, TableRow, Paper, Chip, TextField,
  MenuItem, Stack, IconButton, Divider, Tooltip, Checkbox, Avatar,
  Collapse, TablePagination, Alert, Dialog, DialogTitle, DialogContent,
  DialogActions, LinearProgress
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
  Close as CloseIcon,
  Delete as DeleteIcon,
  ExpandMore as ExpandMoreIcon,
  ExpandLess as ExpandLessIcon,
  BarChart as ChartIcon,
  Male as MaleIcon,
  Female as FemaleIcon,
  VolunteerActivism as FreeIcon,
  AttachMoney as PaidIcon,
  HourglassTop as PendingFeeIcon,
  Groups as PatientsIcon
} from '@mui/icons-material';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell, Legend
} from 'recharts';
import axios from 'axios';
import QuickDatePickerField from '../common/QuickDatePickerField';
import EyeTestReportDialog from '../optical/EyeTestReportDialog';
import { fetchAllPages } from '../../utils/fetchAllPages';
import { reportFromExam } from '../../utils/eyeTestReport';
import { FEE_STATUS_LABELS } from '../../utils/eyeTestBill';
import { notify } from '../../utils/notify';

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

const FEE_CHIP = {
  FREE: { bg: '#e0f2fe', fg: '#0369a1' },
  PAID: { bg: '#d1fae5', fg: '#047857' },
  PENDING: { bg: '#fef3c7', fg: '#b45309' },
  BILLED: { bg: '#ede9fe', fg: '#6d28d9' },
};

const pad2 = (n) => String(n).padStart(2, '0');
const localIsoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

// "6/6 (N6)" — distance VA (corrected, else unaided) with the near VA alongside, '' when not recorded.
const vaText = (eye) => {
  const dist = eye.bcva || eye.ucva;
  if (dist && eye.near) return `${dist} (${eye.near})`;
  return dist || eye.near || '';
};

const normGender = (g) => {
  const s = String(g || '').trim().toLowerCase();
  if (s.startsWith('m')) return 'Male';
  if (s.startsWith('f')) return 'Female';
  return s ? 'Other' : '';
};

// One table row from a backend EyeExamination — every value comes from the DB record (flat
// columns + its raw_data snapshot via reportFromExam); nothing is defaulted or invented.
const toRow = (item) => {
  const r = reportFromExam(item);
  const clinical = Object.fromEntries(r.clinical);
  const ageNum = parseInt(r.patient.age, 10);
  const freeTest = item.fee_status === 'FREE' || item.is_free_test === true
    || (!item.fee_status && /FREE/i.test(r.visit.testType));
  return {
    id: item.id,
    backendId: item.id,
    exam: item,
    testNo: r.visit.testNo,
    date: r.visit.date,
    time: r.visit.time,
    patientId: r.patient.id,
    name: r.patient.name,
    age: Number.isFinite(ageNum) ? ageNum : null,
    gender: normGender(r.patient.gender),
    phone: r.patient.phone,
    testType: (r.visit.testType || '').toUpperCase(),
    optometrist: r.visit.optometrist,
    vaRight: vaText(r.visualAcuity.od),
    vaLeft: vaText(r.visualAcuity.os),
    diagnosis: clinical['Primary Diagnosis'] || '',
    nextReviewDate: clinical['Next Review'] || '',
    feeStatus: item.fee_status || '',
    isFree: freeTest,
  };
};

const EMPTY_FILTERS = {
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
  feeStatus: 'ALL'
};

const has = (v, q) => String(v || '').toLowerCase().includes(q);

export default function EyeTestClinicalReport() {
  const navigate = useNavigate();

  // Live examination records from the database
  const [examinations, setExaminations] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState('');

  const loadExams = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      // The list endpoint is paginated — read every page, not just the newest 20.
      const data = await fetchAllPages('/api/sales/eye-examinations/');
      setExaminations(Array.isArray(data) ? data.map(toRow) : []);
    } catch (e) {
      setLoadError('Could not load eye examination records from the server.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadExams(); }, [loadExams]);

  // Filter States
  const [filterPanelOpen, setFilterPanelOpen] = useState(false);
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [searchQuery, setSearchQuery] = useState('');

  // Toggle Charts Visibility
  const [showCharts, setShowCharts] = useState(true);

  // Selection & Pagination
  const [selectedIds, setSelectedIds] = useState([]);
  const [page, setPage] = useState(0);
  const [rowsPerPage, setRowsPerPage] = useState(10);

  // Sorting
  const [orderBy, setOrderBy] = useState('date');
  const [order, setOrder] = useState('desc');

  // Report dialog & delete confirmation
  const [reportExam, setReportExam] = useState(null);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [examToDelete, setExamToDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  // Stable identity — the dialog reloads whenever its `exam` prop changes.
  const reportDialogExam = useMemo(
    () => (reportExam ? { ...reportExam.exam, backendId: reportExam.backendId } : null),
    [reportExam]
  );

  // Filter dropdown options come from the records themselves
  const testTypeOptions = useMemo(
    () => [...new Set(examinations.map(e => e.testType).filter(Boolean))].sort(),
    [examinations]
  );
  const optometristOptions = useMemo(
    () => [...new Set(examinations.map(e => e.optometrist).filter(Boolean))].sort(),
    [examinations]
  );

  const handleFilterChange = (field, value) => {
    setFilters(prev => ({ ...prev, [field]: value }));
    setPage(0);
  };

  const handleResetFilters = () => {
    setFilters(EMPTY_FILTERS);
    setSearchQuery('');
    setPage(0);
  };

  const handleSort = (field) => {
    if (orderBy === field) setOrder(order === 'asc' ? 'desc' : 'asc');
    else { setOrderBy(field); setOrder('asc'); }
  };

  // Filter Logic
  const filteredExaminations = useMemo(() => {
    return examinations.filter(item => {
      if (searchQuery.trim()) {
        const q = searchQuery.trim().toLowerCase();
        const matchesQuery =
          has(item.testNo, q) || has(item.patientId, q) || has(item.name, q) ||
          has(item.phone, q) || has(item.optometrist, q) || has(item.diagnosis, q);
        if (!matchesQuery) return false;
      }

      if (filters.testNo && !has(item.testNo, filters.testNo.toLowerCase())) return false;
      if (filters.patientId && !has(item.patientId, filters.patientId.toLowerCase())) return false;
      if (filters.name && !has(item.name, filters.name.toLowerCase())) return false;
      if (filters.phone && !has(item.phone, filters.phone.toLowerCase())) return false;
      if (filters.testType !== 'ALL' && item.testType !== filters.testType) return false;
      if (filters.optometrist !== 'ALL' && item.optometrist !== filters.optometrist) return false;
      if (filters.gender !== 'ALL' && item.gender !== filters.gender) return false;
      if (filters.feeStatus !== 'ALL' && item.feeStatus !== filters.feeStatus) return false;
      if (filters.age && item.age !== parseInt(filters.age, 10)) return false;

      if (filters.fromDate && item.date < filters.fromDate) return false;
      if (filters.toDate && item.date > filters.toDate) return false;
      if (filters.nextVisit && item.nextReviewDate !== filters.nextVisit) return false;

      return true;
    });
  }, [examinations, searchQuery, filters]);

  // Sort Logic
  const sortedExaminations = useMemo(() => {
    return [...filteredExaminations].sort((a, b) => {
      let aVal = a[orderBy] ?? '';
      let bVal = b[orderBy] ?? '';
      if (orderBy === 'testNo') {
        // Numeric-aware so ET-1000 sorts after ET-999
        const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
        return order === 'asc' ? cmp : -cmp;
      }
      if (orderBy === 'date') {
        aVal = `${a.date} ${a.time}`;
        bVal = `${b.date} ${b.time}`;
      }
      if (aVal < bVal) return order === 'asc' ? -1 : 1;
      if (aVal > bVal) return order === 'asc' ? 1 : -1;
      return 0;
    });
  }, [filteredExaminations, orderBy, order]);

  const paginatedRows = useMemo(() => {
    return sortedExaminations.slice(page * rowsPerPage, page * rowsPerPage + rowsPerPage);
  }, [sortedExaminations, page, rowsPerPage]);

  // Multi-Select Logic
  const handleSelectAll = (event) => {
    setSelectedIds(event.target.checked ? filteredExaminations.map(n => n.id) : []);
  };

  const handleSelectOne = (id) => {
    setSelectedIds(prev =>
      prev.includes(id) ? prev.filter(item => item !== id) : [...prev, id]
    );
  };

  // KPI Metrics Calculation
  const metrics = useMemo(() => {
    const total = filteredExaminations.length;
    const now = new Date();
    const todayStr = localIsoDate(now);
    const thisMonth = todayStr.slice(0, 7);
    const lastMonth = localIsoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)).slice(0, 7);

    const todayCount = filteredExaminations.filter(e => e.date === todayStr).length;
    const thisMonthCount = filteredExaminations.filter(e => e.date.startsWith(thisMonth)).length;
    const lastMonthCount = filteredExaminations.filter(e => e.date.startsWith(lastMonth)).length;
    const freeCount = filteredExaminations.filter(e => e.isFree).length;
    const paidCount = total - freeCount;
    const followupCount = filteredExaminations.filter(e => e.nextReviewDate).length;
    const pendingFeeCount = filteredExaminations.filter(e => e.feeStatus === 'PENDING').length;
    const uniquePatients = new Set(filteredExaminations.map(e => e.patientId || e.name).filter(Boolean)).size;

    const ages = filteredExaminations.map(e => e.age).filter(a => a !== null);
    const avgAge = ages.length > 0 ? (ages.reduce((a, b) => a + b, 0) / ages.length).toFixed(1) : null;

    const maleCount = filteredExaminations.filter(e => e.gender === 'Male').length;
    const femaleCount = filteredExaminations.filter(e => e.gender === 'Female').length;

    const monthChange = lastMonthCount > 0
      ? Math.round(((thisMonthCount - lastMonthCount) / lastMonthCount) * 100)
      : null;

    return {
      total, todayCount, thisMonthCount, lastMonthCount, monthChange,
      freeCount, paidCount, followupCount, pendingFeeCount, uniquePatients,
      avgAge, maleCount, femaleCount
    };
  }, [filteredExaminations]);

  // Chart Data Calculations
  const chartData = useMemo(() => {
    const dailyMap = {};
    filteredExaminations.forEach(e => {
      if (e.date) dailyMap[e.date] = (dailyMap[e.date] || 0) + 1;
    });
    const dailyTrend = Object.keys(dailyMap).sort().map(date => ({
      date: date.substring(5),
      tests: dailyMap[date]
    }));

    const typeMap = {};
    filteredExaminations.forEach(e => {
      const t = e.testType || 'NOT SPECIFIED';
      typeMap[t] = (typeMap[t] || 0) + 1;
    });
    const typeDistribution = Object.keys(typeMap).map(type => ({
      name: type.replace(' EYE TEST', '').replace(' EVALUATION', ''),
      value: typeMap[type]
    }));

    const diagMap = {};
    filteredExaminations.forEach(e => {
      if (e.diagnosis) diagMap[e.diagnosis] = (diagMap[e.diagnosis] || 0) + 1;
    });
    const diagnosisDistribution = Object.keys(diagMap)
      .map(name => ({ name, count: diagMap[name] }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 5);

    const doctorMap = {};
    filteredExaminations.forEach(e => {
      const doc = (e.optometrist || 'Not recorded').replace(/^Dr\.?\s*/i, '').replace(/\s*\(.*\)\s*$/, '');
      doctorMap[doc] = (doctorMap[doc] || 0) + 1;
    });
    const doctorDistribution = Object.keys(doctorMap).map(doc => ({
      doctor: doc,
      tests: doctorMap[doc]
    }));

    return { dailyTrend, typeDistribution, diagnosisDistribution, doctorDistribution };
  }, [filteredExaminations]);

  // Export Actions
  const handleExportExcel = () => {
    const rows = selectedIds.length > 0
      ? sortedExaminations.filter(e => selectedIds.includes(e.id))
      : sortedExaminations;
    const csv = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csvHeader = 'Test No,Date,Patient ID,Patient Name,Age,Gender,Phone,Test Type,Optometrist,OD Vision,OS Vision,Diagnosis,Next Visit,Fee Status\n';
    const csvRows = rows.map(e => [
      e.testNo, e.date, e.patientId, e.name, e.age ?? '', e.gender, e.phone, e.testType,
      e.optometrist, e.vaRight, e.vaLeft, e.diagnosis, e.nextReviewDate,
      FEE_STATUS_LABELS[e.feeStatus] || e.feeStatus
    ].map(csv).join(',')).join('\n');

    const blob = new Blob([csvHeader + csvRows], { type: 'text/csv' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `Eye_Test_Clinical_Report_${localIsoDate(new Date())}.csv`;
    a.click();
    window.URL.revokeObjectURL(url);
  };

  const handlePrintReport = () => {
    window.print();
  };

  const handleDeleteExam = (exam) => {
    setExamToDelete(exam);
    setDeleteConfirmOpen(true);
  };

  const confirmDelete = async () => {
    if (!examToDelete) return;
    setDeleting(true);
    try {
      await axios.delete(`/api/sales/eye-examinations/${examToDelete.backendId}/`);
      setExaminations(prev => prev.filter(e => e.id !== examToDelete.id));
      setSelectedIds(prev => prev.filter(id => id !== examToDelete.id));
      setDeleteConfirmOpen(false);
      setExamToDelete(null);
    } catch (e) {
      notify('Could not delete the examination record. Please try again.', 'error');
    } finally {
      setDeleting(false);
    }
  };

  const activeFilterCount = Object.entries(filters).filter(([k, v]) => v && v !== EMPTY_FILTERS[k]).length;
  const sortMark = (field) => (orderBy === field ? (order === 'asc' ? ' ↑' : ' ↓') : '');
  const dash = (v) => (v === null || v === undefined || v === '' ? '—' : v);

  const kpiCards = [
    {
      label: 'TOTAL EYE TESTS', value: metrics.total, color: COLORS.primary, bg: '#dbeafe', icon: <ExamIcon fontSize="small" />,
      note: metrics.monthChange === null
        ? `${metrics.thisMonthCount} this month`
        : `${metrics.monthChange >= 0 ? '↑ +' : '↓ '}${metrics.monthChange}% vs last month`
    },
    { label: "TODAY'S EYE TESTS", value: metrics.todayCount, color: COLORS.secondary, bg: '#f3e8ff', icon: <CalendarIcon fontSize="small" />, note: 'Logged today in clinic' },
    { label: 'FREE EYE TESTS', value: metrics.freeCount, color: COLORS.info, bg: '#e0f2fe', icon: <FreeIcon fontSize="small" />, note: 'No fee charged' },
    { label: 'PAID EYE TESTS', value: metrics.paidCount, color: COLORS.success, bg: '#d1fae5', icon: <PaidIcon fontSize="small" />, note: 'Fee charged' },
    { label: 'FOLLOW-UP REVIEWS', value: metrics.followupCount, color: COLORS.warning, bg: '#fef3c7', icon: <CalendarIcon fontSize="small" />, note: 'Next review date set' },
    {
      label: 'AVG PATIENT AGE', value: metrics.avgAge === null ? '—' : <>{metrics.avgAge} <span style={{ fontSize: '1rem' }}>yrs</span></>,
      color: '#334155', bg: '#f1f5f9', icon: <PersonIcon fontSize="small" />, note: 'Of records with age'
    },
    {
      label: 'MALE PATIENTS', value: metrics.maleCount, color: '#2563eb', bg: '#dbeafe', icon: <MaleIcon fontSize="small" />,
      note: `${metrics.total > 0 ? Math.round((metrics.maleCount / metrics.total) * 100) : 0}% of Total`
    },
    {
      label: 'FEMALE PATIENTS', value: metrics.femaleCount, color: '#ec4899', bg: '#fce7f3', icon: <FemaleIcon fontSize="small" />,
      note: `${metrics.total > 0 ? Math.round((metrics.femaleCount / metrics.total) * 100) : 0}% of Total`
    },
    { label: 'PENDING FEES', value: metrics.pendingFeeCount, color: '#b45309', bg: '#fef3c7', icon: <PendingFeeIcon fontSize="small" />, note: 'Deferred to next sale' },
    { label: 'UNIQUE PATIENTS', value: metrics.uniquePatients, color: '#0f766e', bg: '#ccfbf1', icon: <PatientsIcon fontSize="small" />, note: 'Distinct patients examined' },
  ];

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

        <Stack direction="row" spacing={1.5} sx={{ flexWrap: 'wrap', gap: 1 }}>
          <Button
            variant="outlined"
            color="inherit"
            startIcon={<ResetIcon />}
            onClick={loadExams}
            disabled={loading}
            sx={{ fontWeight: 700, borderRadius: 2.5, textTransform: 'none' }}
          >
            Refresh
          </Button>
          <Button
            variant="contained"
            color="success"
            startIcon={<ExcelIcon />}
            onClick={handleExportExcel}
            disabled={filteredExaminations.length === 0}
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
            Print / PDF
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

      {loadError && (
        <Alert severity="error" sx={{ mb: 2 }} action={<Button color="inherit" size="small" onClick={loadExams}>Retry</Button>}>
          {loadError}
        </Alert>
      )}

      {/* 🔍 SEARCH & ADVANCED FILTER PANEL */}
      <Card variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3.5, bgcolor: '#ffffff', borderColor: '#cbd5e1', boxShadow: '0 2px 10px rgba(0,0,0,0.02)' }}>
        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2} alignItems="center" justifyContent="space-between">
          <TextField
            fullWidth
            size="small"
            placeholder="Search Test No, Patient Name, ID, Mobile, Doctor, Diagnosis..."
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setPage(0); }}
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
              variant={filterPanelOpen ? 'contained' : 'outlined'}
              color="primary"
              startIcon={<FilterIcon />}
              endIcon={filterPanelOpen ? <ExpandLessIcon /> : <ExpandMoreIcon />}
              onClick={() => setFilterPanelOpen(!filterPanelOpen)}
              sx={{ fontWeight: 700, borderRadius: 2.5, textTransform: 'none', whiteSpace: 'nowrap' }}
            >
              Advanced Filters {activeFilterCount > 0 && `(${activeFilterCount})`}
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

        <Collapse in={filterPanelOpen} timeout="auto" unmountOnExit>
          <Divider sx={{ my: 2.5 }} />
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6} md={3}>
              <TextField fullWidth size="small" label="Test Number"
                value={filters.testNo} onChange={(e) => handleFilterChange('testNo', e.target.value)} />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField fullWidth size="small" label="Patient ID"
                value={filters.patientId} onChange={(e) => handleFilterChange('patientId', e.target.value)} />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField fullWidth size="small" label="Patient Name"
                value={filters.name} onChange={(e) => handleFilterChange('name', e.target.value)} />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField fullWidth size="small" label="Mobile Number"
                value={filters.phone} onChange={(e) => handleFilterChange('phone', e.target.value)} />
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField fullWidth select size="small" label="Test Type"
                value={filters.testType} onChange={(e) => handleFilterChange('testType', e.target.value)}>
                <MenuItem value="ALL">All Test Types</MenuItem>
                {testTypeOptions.map(t => <MenuItem key={t} value={t}>{t}</MenuItem>)}
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField fullWidth select size="small" label="Optometrist / Doctor"
                value={filters.optometrist} onChange={(e) => handleFilterChange('optometrist', e.target.value)}>
                <MenuItem value="ALL">All Optometrists</MenuItem>
                {optometristOptions.map(d => <MenuItem key={d} value={d}>{d}</MenuItem>)}
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField fullWidth select size="small" label="Gender"
                value={filters.gender} onChange={(e) => handleFilterChange('gender', e.target.value)}>
                <MenuItem value="ALL">All Genders</MenuItem>
                <MenuItem value="Male">Male</MenuItem>
                <MenuItem value="Female">Female</MenuItem>
                <MenuItem value="Other">Other</MenuItem>
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField fullWidth select size="small" label="Fee Status"
                value={filters.feeStatus} onChange={(e) => handleFilterChange('feeStatus', e.target.value)}>
                <MenuItem value="ALL">All Fee Statuses</MenuItem>
                {Object.entries(FEE_STATUS_LABELS).map(([k, label]) => <MenuItem key={k} value={k}>{label}</MenuItem>)}
              </TextField>
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <QuickDatePickerField label="Date From" value={filters.fromDate}
                onChange={(d) => handleFilterChange('fromDate', d)} />
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <QuickDatePickerField label="Date To" value={filters.toDate}
                onChange={(d) => handleFilterChange('toDate', d)} />
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <QuickDatePickerField label="Next Review Visit" value={filters.nextVisit}
                onChange={(d) => handleFilterChange('nextVisit', d)} />
            </Grid>

            <Grid item xs={12} sm={6} md={3}>
              <TextField fullWidth size="small" label="Age" type="number"
                value={filters.age} onChange={(e) => handleFilterChange('age', e.target.value)} />
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
        {kpiCards.map(card => (
          <Grid item xs={12} sm={6} md={2.4} key={card.label}>
            <Paper variant="outlined" sx={{ p: 2, borderRadius: 3, borderLeft: `4px solid ${card.color}`, bgcolor: '#ffffff' }}>
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
                <Typography variant="caption" color="text.secondary" fontWeight={800}>{card.label}</Typography>
                <Avatar sx={{ width: 32, height: 32, bgcolor: card.bg, color: card.color }}>{card.icon}</Avatar>
              </Box>
              <Typography variant="h4" fontWeight={850} sx={{ color: card.color }}>{card.value}</Typography>
              <Typography variant="caption" color="text.secondary" fontWeight={500} sx={{ mt: 0.5, display: 'block' }}>
                {card.note}
              </Typography>
            </Paper>
          </Grid>
        ))}
      </Grid>

      {/* 📈 ANALYTICS CHARTS DASHBOARD (COLLAPSIBLE) */}
      <Card variant="outlined" sx={{ p: 2.5, mb: 3, borderRadius: 3.5, bgcolor: '#ffffff', borderColor: '#cbd5e1' }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="subtitle1" fontWeight={850} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ChartIcon /> Eye Examination Clinical Analytics Dashboard
          </Typography>
          <Button size="small" variant="outlined" onClick={() => setShowCharts(!showCharts)} sx={{ fontWeight: 700, borderRadius: 2 }}>
            {showCharts ? 'Hide Analytics Charts' : 'Show Analytics Charts'}
          </Button>
        </Box>

        <Collapse in={showCharts} timeout="auto" unmountOnExit>
          <Grid container spacing={3} sx={{ pt: 1 }}>
            <Grid item xs={12} md={6}>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 2 }}>Daily Examination Volume Trend</Typography>
                <ResponsiveContainer width="100%" height={220}>
                  <AreaChart data={chartData.dailyTrend}>
                    <defs>
                      <linearGradient id="colorTests" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor={COLORS.primary} stopOpacity={0.8} />
                        <stop offset="95%" stopColor={COLORS.primary} stopOpacity={0.0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="date" stroke="#64748b" fontSize={12} />
                    <YAxis stroke="#64748b" fontSize={12} allowDecimals={false} />
                    <RechartsTooltip />
                    <Area type="monotone" dataKey="tests" stroke={COLORS.primary} strokeWidth={3} fillOpacity={1} fill="url(#colorTests)" />
                  </AreaChart>
                </ResponsiveContainer>
              </Paper>
            </Grid>

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

            <Grid item xs={12} md={6}>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 2 }}>Top Ophthalmic Diagnoses Frequency</Typography>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData.diagnosisDistribution} layout="vertical">
                    <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#e2e8f0" />
                    <XAxis type="number" stroke="#64748b" fontSize={12} allowDecimals={false} />
                    <YAxis dataKey="name" type="category" stroke="#64748b" fontSize={11} width={130} />
                    <RechartsTooltip />
                    <Bar dataKey="count" fill={COLORS.secondary} radius={[0, 6, 6, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Paper>
            </Grid>

            <Grid item xs={12} md={6}>
              <Paper variant="outlined" sx={{ p: 2, borderRadius: 3 }}>
                <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 2 }}>Doctor-wise Clinical Examinations</Typography>
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={chartData.doctorDistribution}>
                    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e2e8f0" />
                    <XAxis dataKey="doctor" stroke="#64748b" fontSize={12} />
                    <YAxis stroke="#64748b" fontSize={12} allowDecimals={false} />
                    <RechartsTooltip />
                    <Bar dataKey="tests" fill={COLORS.success} radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </Paper>
            </Grid>
          </Grid>
        </Collapse>
      </Card>

      {/* 📋 EYE TEST RECORDS TABLE */}
      <Paper variant="outlined" sx={{ borderRadius: 3.5, borderColor: '#cbd5e1', overflow: 'hidden', bgcolor: '#ffffff', boxShadow: '0 4px 20px rgba(0,0,0,0.03)' }}>
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

        {loading && <LinearProgress />}

        <TableContainer sx={{ maxHeight: 600, overflowX: 'auto' }}>
          <Table
            stickyHeader
            size="small"
            sx={{
              // Every cell stays on one line — names, dates and phone numbers never stack.
              '& th, & td': { whiteSpace: 'nowrap', fontSize: '0.8rem', px: 1.25, py: 0.9, verticalAlign: 'middle' },
            }}
          >
            <TableHead>
              <TableRow sx={{ '& th': { fontWeight: 800, bgcolor: '#0f172a', color: '#ffffff', fontSize: '0.78rem' } }}>
                <TableCell padding="checkbox">
                  <Checkbox
                    size="small"
                    indeterminate={selectedIds.length > 0 && selectedIds.length < filteredExaminations.length}
                    checked={filteredExaminations.length > 0 && selectedIds.length === filteredExaminations.length}
                    onChange={handleSelectAll}
                    sx={{ color: '#fff', '&.Mui-checked, &.MuiCheckbox-indeterminate': { color: '#fff' } }}
                  />
                </TableCell>
                <TableCell sx={{ cursor: 'pointer' }} onClick={() => handleSort('testNo')}>Test No{sortMark('testNo')}</TableCell>
                <TableCell sx={{ cursor: 'pointer' }} onClick={() => handleSort('date')}>Date{sortMark('date')}</TableCell>
                <TableCell>Patient ID</TableCell>
                <TableCell sx={{ cursor: 'pointer' }} onClick={() => handleSort('name')}>Patient Name{sortMark('name')}</TableCell>
                <TableCell>Age / Gender</TableCell>
                <TableCell>Mobile</TableCell>
                <TableCell>Test Type</TableCell>
                <TableCell>Optometrist</TableCell>
                <TableCell>OD (Right)</TableCell>
                <TableCell>OS (Left)</TableCell>
                <TableCell>Diagnosis</TableCell>
                <TableCell>Next Visit</TableCell>
                <TableCell>Fee Status</TableCell>
                <TableCell align="center">Actions</TableCell>
              </TableRow>
            </TableHead>

            <TableBody>
              {paginatedRows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={15} align="center" sx={{ py: 8, whiteSpace: 'normal !important' }}>
                    <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
                      <EyeIcon sx={{ fontSize: 64, color: 'text.disabled', mb: 1.5 }} />
                      <Typography variant="h6" fontWeight={800} color="text.secondary">
                        {loading ? 'Loading eye test records…' : 'No Eye Test Reports Found'}
                      </Typography>
                      {!loading && (
                        <>
                          <Typography variant="body2" color="text.secondary" sx={{ maxWidth: 450, mt: 0.5, mb: 2.5 }}>
                            Clinical reports appear here after patient examinations are saved. Adjust the search or filters.
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
                        </>
                      )}
                    </Box>
                  </TableCell>
                </TableRow>
              ) : (
                paginatedRows.map((row) => {
                  const isSelected = selectedIds.includes(row.id);
                  const fee = FEE_CHIP[row.feeStatus];
                  return (
                    <TableRow
                      key={row.id}
                      hover
                      selected={isSelected}
                      sx={{ cursor: 'pointer' }}
                      onClick={() => setReportExam(row)}
                    >
                      <TableCell padding="checkbox" onClick={(e) => e.stopPropagation()}>
                        <Checkbox size="small" checked={isSelected} onChange={() => handleSelectOne(row.id)} />
                      </TableCell>

                      <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{dash(row.testNo)}</TableCell>

                      <TableCell sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{dash(row.date)}</TableCell>

                      <TableCell sx={{ fontWeight: 700, color: 'text.secondary' }}>{dash(row.patientId)}</TableCell>

                      <TableCell sx={{ fontWeight: 700 }}>{dash(row.name)}</TableCell>

                      <TableCell>
                        <Stack direction="row" spacing={0.75} alignItems="center">
                          <span style={{ fontWeight: 700 }}>{row.age !== null ? `${row.age} yrs` : '—'}</span>
                          {row.gender && (
                            <Chip
                              label={row.gender}
                              size="small"
                              sx={{
                                height: 18, fontSize: '0.65rem', fontWeight: 800,
                                bgcolor: row.gender === 'Male' ? '#dbeafe' : row.gender === 'Female' ? '#fce7f3' : '#f1f5f9',
                                color: row.gender === 'Male' ? '#1e40af' : row.gender === 'Female' ? '#9d174d' : '#475569'
                              }}
                            />
                          )}
                        </Stack>
                      </TableCell>

                      <TableCell sx={{ fontWeight: 600, color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{dash(row.phone)}</TableCell>

                      <TableCell>
                        {row.testType ? (
                          <Chip
                            label={row.testType.replace(' EYE TEST', '')}
                            size="small"
                            sx={{
                              height: 22, fontWeight: 800, fontSize: '0.68rem',
                              bgcolor: row.isFree ? '#e0f2fe' : '#ede9fe',
                              color: row.isFree ? '#0369a1' : '#6d28d9'
                            }}
                          />
                        ) : '—'}
                      </TableCell>

                      <TableCell sx={{ fontWeight: 600 }}>{dash(row.optometrist)}</TableCell>

                      <TableCell sx={{ fontWeight: 700, color: '#2563eb' }}>{dash(row.vaRight)}</TableCell>

                      <TableCell sx={{ fontWeight: 700, color: '#7c3aed' }}>{dash(row.vaLeft)}</TableCell>

                      <TableCell>
                        {row.diagnosis ? (
                          <Tooltip title={row.diagnosis}>
                            <Chip
                              label={row.diagnosis}
                              size="small"
                              variant="outlined"
                              color="primary"
                              sx={{ height: 22, maxWidth: 200, fontWeight: 700, fontSize: '0.68rem' }}
                            />
                          </Tooltip>
                        ) : '—'}
                      </TableCell>

                      <TableCell sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{dash(row.nextReviewDate)}</TableCell>

                      <TableCell>
                        {fee ? (
                          <Chip
                            label={FEE_STATUS_LABELS[row.feeStatus]}
                            size="small"
                            sx={{ fontWeight: 800, height: 22, fontSize: '0.68rem', bgcolor: fee.bg, color: fee.fg }}
                          />
                        ) : '—'}
                      </TableCell>

                      <TableCell align="center" onClick={(e) => e.stopPropagation()}>
                        <Stack direction="row" spacing={0.25} justifyContent="center">
                          <Tooltip title="View Eye Test Report">
                            <IconButton size="small" color="primary" onClick={() => setReportExam(row)}>
                              <EyeIcon fontSize="small" />
                            </IconButton>
                          </Tooltip>

                          <Tooltip title="Print / Save as PDF">
                            <IconButton size="small" color="error" onClick={() => setReportExam(row)}>
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

      {/* 🏥 FULL EYE TEST REPORT (preview + print) — loads the record and its bill links from the server */}
      <EyeTestReportDialog
        open={Boolean(reportExam)}
        exam={reportDialogExam}
        onClose={() => setReportExam(null)}
      />

      {/* 🗑️ DELETE CONFIRMATION DIALOG */}
      <Dialog open={deleteConfirmOpen} onClose={() => !deleting && setDeleteConfirmOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontWeight: 800 }}>Confirm Deletion</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary">
            Are you sure you want to delete Eye Examination Record <strong>{examToDelete?.testNo}</strong> for <strong>{examToDelete?.name}</strong>? This permanently removes it from the database and cannot be undone.
          </Typography>
        </DialogContent>
        <DialogActions sx={{ p: 2 }}>
          <Button onClick={() => setDeleteConfirmOpen(false)} disabled={deleting}>Cancel</Button>
          <Button variant="contained" color="error" onClick={confirmDelete} disabled={deleting} sx={{ fontWeight: 700 }}>
            {deleting ? 'Deleting…' : 'Delete Record'}
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
