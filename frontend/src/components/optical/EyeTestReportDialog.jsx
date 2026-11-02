import React, { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import {
  Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, LinearProgress,
  MenuItem, TextField, ToggleButton, ToggleButtonGroup, Typography, Alert,
} from '@mui/material';
import { Close as CloseIcon, Print as PrintIcon, Assessment as ReportIcon } from '@mui/icons-material';
import { buildEyeTestReportHtml, reportFromExam, splitTimestamp } from '../../utils/eyeTestReport';
import { fetchStoreProfile, readCachedProfile } from '../../utils/storeProfile';

const isUuid = (id) => typeof id === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
const backendIdOf = (exam) => (exam ? (exam.backendId || (isUuid(exam.id) ? exam.id : null)) : null);
const visitLabel = (exam) => {
  const r = reportFromExam(exam);
  return [r.visit.testNo && `Test No ${r.visit.testNo}`, r.visit.date || splitTimestamp(exam.examination_date).date,
    r.visit.optometrist].filter(Boolean).join(' · ') || 'Visit';
};

/**
 * Eye Test Report — the complete record of one visit (patient, examiner, date & time, test type,
 * every refraction/VA/health finding, clinical notes and the billing reference), previewed exactly
 * as it prints. `visits` (optional) lets the user switch between the patient's visits.
 */
export default function EyeTestReportDialog({ open, exam, visits = [], onClose }) {
  const [current, setCurrent] = useState(exam);
  const [server, setServer] = useState(null); // { exam, billing } from /report/
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [paperSize, setPaperSize] = useState('A4');
  const [store, setStore] = useState(() => readCachedProfile() || {});
  const frameRef = useRef(null);

  useEffect(() => { if (open) setCurrent(exam); }, [open, exam]);

  useEffect(() => {
    if (!open) return;
    fetchStoreProfile().then((p) => p && setStore(p)).catch(() => {});
  }, [open]);

  const backendId = backendIdOf(current);
  useEffect(() => {
    if (!open || !current) return undefined;
    setServer(null);
    setError('');
    if (!backendId) return undefined;
    let cancelled = false;
    setLoading(true);
    axios.get(`/api/sales/eye-examinations/${backendId}/report/`)
      .then((res) => { if (!cancelled) setServer(res.data); })
      .catch(() => { if (!cancelled) setError('Could not load the latest record and bill links from the server — showing the copy on this device.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, current, backendId]);

  const html = useMemo(() => {
    if (!current) return '';
    const report = server ? reportFromExam(server.exam, server.billing) : reportFromExam(current, null);
    return buildEyeTestReportHtml(report, { store, paperSize });
  }, [current, server, store, paperSize]);

  const handlePrint = () => {
    const win = frameRef.current?.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  };

  const visitOptions = visits.filter(Boolean);
  const keyOf = (v) => v?.backendId || v?.id;
  const currentIndex = visitOptions.findIndex((v) => v === current || (keyOf(v) && keyOf(v) === keyOf(current)));

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth PaperProps={{ sx: { height: '94vh' } }}>
      <DialogTitle component="div" sx={{ display: 'flex', alignItems: 'center', gap: 1.5, pr: 6, flexWrap: 'wrap' }}>
        <ReportIcon color="primary" />
        <Typography variant="h6" fontWeight={800} sx={{ flexGrow: 1 }}>Eye Test Report</Typography>
        {visitOptions.length > 1 && (
          <TextField
            select
            size="small"
            label="Visit"
            value={currentIndex >= 0 ? currentIndex : ''}
            onChange={(e) => setCurrent(visitOptions[Number(e.target.value)])}
            sx={{ minWidth: 280 }}
          >
            {visitOptions.map((v, i) => (
              <MenuItem key={v.backendId || v.id || i} value={i}>{visitLabel(v)}</MenuItem>
            ))}
          </TextField>
        )}
        <ToggleButtonGroup size="small" exclusive value={paperSize} onChange={(e, v) => v && setPaperSize(v)}>
          <ToggleButton value="A4" sx={{ fontWeight: 700, px: 2 }}>A4</ToggleButton>
          <ToggleButton value="A5" sx={{ fontWeight: 700, px: 2 }}>A5</ToggleButton>
        </ToggleButtonGroup>
        <IconButton onClick={onClose} sx={{ position: 'absolute', right: 8, top: 8 }}><CloseIcon /></IconButton>
      </DialogTitle>
      {loading && <LinearProgress />}
      <DialogContent dividers sx={{ p: 0, display: 'flex', flexDirection: 'column', bgcolor: '#e2e8f0' }}>
        {error && <Alert severity="warning" sx={{ borderRadius: 0 }}>{error}</Alert>}
        {!backendId && current && (
          <Alert severity="info" sx={{ borderRadius: 0 }}>This visit is only stored on this device, so its linked bills can't be looked up.</Alert>
        )}
        <Box sx={{ flexGrow: 1, display: 'flex', justifyContent: 'center', p: 2, overflow: 'auto' }}>
          <Box
            component="iframe"
            ref={frameRef}
            title="Eye Test Report"
            srcDoc={html}
            sx={{ width: paperSize === 'A5' ? '160mm' : '215mm', maxWidth: '100%', height: '100%', minHeight: 600, border: 0, bgcolor: '#fff', boxShadow: 3 }}
          />
        </Box>
      </DialogContent>
      <DialogActions sx={{ px: 3, py: 1.5 }}>
        <Button onClick={onClose} sx={{ textTransform: 'none', fontWeight: 700 }}>Close</Button>
        <Button variant="contained" startIcon={<PrintIcon />} onClick={handlePrint} disabled={!html || loading}
          sx={{ textTransform: 'none', fontWeight: 800 }}>
          Print {paperSize}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
