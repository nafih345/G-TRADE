import React from 'react';
import { 
  Box, Card, Typography, Divider, Chip, Button, 
  Avatar, Alert, Stack, Tooltip 
} from '@mui/material';
import { 
  Visibility as EyeIcon, 
  CompareArrows as CompareIcon,
  Warning as WarningIcon,
  CheckCircleOutlined as CheckIcon,
  Print as PrintIcon,
  Schedule as ClockIcon,
  MedicalServices as MedicalIcon,
  NoteAltOutlined as NoteIcon
} from '@mui/icons-material';

export default function ExaminationSummarySidebar({
  patientData,
  medicalHistory,
  subjectiveRefraction,
  diagnosis,
  prescription,
  eyeHealth,
  activeStep,
  setActiveStep,
  onOpenCompareModal,
  onSaveDraft,
  onPrint
}) {
  const iopOD = parseFloat(eyeHealth?.iop?.od || '0');
  const iopOS = parseFloat(eyeHealth?.iop?.os || '0');
  const hasHighIOP = iopOD > 21 || iopOS > 21;
  const hasDiabetes = medicalHistory?.hasDiabetes || (typeof medicalHistory?.medicalHistory === 'string' && medicalHistory.medicalHistory.toLowerCase().includes('diabet'));

  return (
    <Card
      elevation={0}
      sx={{
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 3,
        p: 2.5,
        position: 'sticky',
        top: 20,
        backgroundColor: 'background.paper',
        boxShadow: '0 4px 20px rgba(0,0,0,0.03)'
      }}
    >
      {/* Sidebar Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 2 }}>
        <Typography variant="subtitle1" fontWeight={800} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <EyeIcon sx={{ color: 'primary.main', fontSize: 20 }} /> Live Examination Summary
        </Typography>
        <Chip label="Auto-Saving" size="small" color="success" variant="outlined" sx={{ height: 20, fontSize: '0.65rem' }} />
      </Box>

      <Divider sx={{ mb: 2 }} />

      {/* Patient Mini Card */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mb: 2, p: 1.5, bgcolor: 'action.hover', borderRadius: 2, border: '1px solid rgba(0,0,0,0.04)' }}>
        <Avatar sx={{ bgcolor: 'primary.main', width: 42, height: 42, fontWeight: 700 }}>
          {patientData?.name ? patientData.name.charAt(0).toUpperCase() : 'P'}
        </Avatar>
        <Box sx={{ flexGrow: 1, minWidth: 0 }}>
          <Typography variant="subtitle2" fontWeight={700} noWrap>
            {patientData?.name || 'Unregistered Patient'}
          </Typography>
          <Typography variant="caption" color="text.secondary" display="block">
            {patientData?.id} • {patientData?.age} Yrs • {patientData?.gender}
          </Typography>
          <Typography variant="caption" color="primary.main" fontWeight={600}>
            {patientData?.phone || 'No Mobile'}
          </Typography>
        </Box>
      </Box>

      {/* Clinical Alerts */}
      {hasHighIOP && (
        <Alert severity="error" icon={<WarningIcon />} sx={{ py: 0.5, px: 1.5, mb: 1.5, fontSize: '0.75rem', borderRadius: 2 }}>
          <strong>High IOP Alert!</strong> OD: {eyeHealth?.iop?.od} | OS: {eyeHealth?.iop?.os} mmHg
        </Alert>
      )}

      {hasDiabetes && (
        <Alert severity="warning" icon={<MedicalIcon />} sx={{ py: 0.5, px: 1.5, mb: 1.5, fontSize: '0.75rem', borderRadius: 2 }}>
          <strong>Diabetic Patient:</strong> Ocular Fundus check advised.
        </Alert>
      )}

      {/* Current Refraction Summary */}
      <Box sx={{ mb: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
          <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            Current Refraction (Final Rx)
          </Typography>
          <Button size="small" variant="text" onClick={onOpenCompareModal} startIcon={<CompareIcon />} sx={{ fontSize: '0.7rem', py: 0 }}>
            Compare Rx
          </Button>
        </Box>

        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1 }}>
          {/* OD (Right) */}
          <Box sx={{ p: 1.25, borderRadius: 2, bgcolor: 'rgba(37, 99, 235, 0.05)', border: '1px solid rgba(37, 99, 235, 0.15)' }}>
            <Typography variant="caption" fontWeight={800} color="primary.main">RIGHT EYE (OD)</Typography>
            <Typography variant="body2" fontWeight={700} sx={{ mt: 0.5 }}>
              SPH: {subjectiveRefraction?.od?.sph || '—'}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
              CYL: {subjectiveRefraction?.od?.cyl || '—'} {subjectiveRefraction?.od?.axis ? `@ ${subjectiveRefraction.od.axis}°` : ''}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
              VA: {subjectiveRefraction?.od?.va || '—'}
            </Typography>
          </Box>

          {/* OS (Left) */}
          <Box sx={{ p: 1.25, borderRadius: 2, bgcolor: 'rgba(16, 185, 129, 0.05)', border: '1px solid rgba(16, 185, 129, 0.15)' }}>
            <Typography variant="caption" fontWeight={800} sx={{ color: '#059669' }}>LEFT EYE (OS)</Typography>
            <Typography variant="body2" fontWeight={700} sx={{ mt: 0.5 }}>
              SPH: {subjectiveRefraction?.os?.sph || '—'}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
              CYL: {subjectiveRefraction?.os?.cyl || '—'} {subjectiveRefraction?.os?.axis ? `@ ${subjectiveRefraction.os.axis}°` : ''}
            </Typography>
            <Typography variant="caption" color="text.secondary" display="block">
              VA: {subjectiveRefraction?.os?.va || '—'}
            </Typography>
          </Box>
        </Box>

        {/* Add & PD */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mt: 1, px: 1, py: 0.5, bgcolor: 'action.hover', borderRadius: 1.5 }}>
          <Typography variant="caption" fontWeight={600}>Near Add: <strong>{subjectiveRefraction?.nearAdd || '—'}</strong></Typography>
          <Typography variant="caption" fontWeight={600}>PD: <strong>{subjectiveRefraction?.pd ? `${subjectiveRefraction.pd} mm` : '—'}</strong></Typography>
        </Box>
      </Box>

      {/* Diagnosis */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', mb: 0.5 }}>
          Diagnosis
        </Typography>
        <Typography variant="body2" fontWeight={600} color="text.primary">
          {diagnosis?.primary || 'Pending Diagnostic Assessment'}
        </Typography>
        {diagnosis?.icdCode && (
          <Chip label={`ICD: ${diagnosis.icdCode}`} size="small" sx={{ height: 18, fontSize: '0.65rem', mt: 0.5 }} />
        )}
      </Box>

      {/* Recommended Lenses */}
      <Box sx={{ mb: 2 }}>
        <Typography variant="caption" fontWeight={700} color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', mb: 0.8 }}>
          Recommended Lenses
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.5 }}>
          {prescription?.selectedLenses?.length > 0 ? (
            prescription.selectedLenses.map((lens, i) => (
              <Chip key={i} label={lens} size="small" color="primary" variant="outlined" sx={{ fontSize: '0.68rem', height: 22, fontWeight: 700 }} />
            ))
          ) : (
            <Typography variant="caption" color="text.secondary" fontStyle="italic">No lens types selected yet.</Typography>
          )}
        </Box>
      </Box>

      {/* Follow Up & Doctor */}
      <Box sx={{ p: 1.5, borderRadius: 2, border: '1px dashed', borderColor: 'divider', mb: 2.5 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', mb: 0.5 }}>
          <Typography variant="caption" color="text.secondary">Optometrist:</Typography>
          <Typography variant="caption" fontWeight={700}>{patientData?.assignedOptometrist || 'Unassigned'}</Typography>
        </Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between' }}>
          <Typography variant="caption" color="text.secondary">Next Review:</Typography>
          <Typography variant="caption" fontWeight={700} color="primary.main">{diagnosis?.nextReview || 'Not Scheduled'}</Typography>
        </Box>
      </Box>

      {/* Action Buttons */}
      <Stack spacing={1}>
        <Button 
          variant="contained" 
          color="primary" 
          fullWidth
          startIcon={<PrintIcon />}
          onClick={onPrint}
          sx={{ fontWeight: 700, borderRadius: 2, textTransform: 'none', py: 1.2 }}
        >
          Review & Print Rx
        </Button>
        <Button 
          variant="outlined" 
          color="inherit" 
          fullWidth
          onClick={onSaveDraft}
          sx={{ fontWeight: 600, borderRadius: 2, textTransform: 'none', py: 1 }}
        >
          Save Clinical Draft
        </Button>
      </Stack>
    </Card>
  );
}
