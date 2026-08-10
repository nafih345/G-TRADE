import React from 'react';
import { 
  Box, Card, Typography, Grid, TextField, Chip, 
  FormControlLabel, Switch, Alert, Stack 
} from '@mui/material';
import { MedicalServices as HistoryIcon, Warning as AlertIcon } from '@mui/icons-material';

const commonComplaints = [
  'Blurred Distance Vision', 'Blurred Near Vision', 'Headache', 'Eye Strain', 
  'Redness', 'Watering Eyes', 'Itching', 'Burning Sensation', 
  'Double Vision', 'Light Sensitivity', 'Broken Glasses', 'Contact Lens Problem', 'Routine Check-up'
];

export default function Step2MedicalHistory({ medicalHistory, setMedicalHistory }) {
  const handleChange = (field, value) => {
    setMedicalHistory(prev => ({ ...prev, [field]: value }));
  };

  const toggleComplaint = (complaint) => {
    const current = medicalHistory.chiefComplaints || [];
    if (current.includes(complaint)) {
      handleChange('chiefComplaints', current.filter(c => c !== complaint));
    } else {
      handleChange('chiefComplaints', [...current, complaint]);
    }
  };

  return (
    <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
      <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <HistoryIcon /> Step 2: Medical & Ocular History
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Record chief complaints, systemic medical conditions, ocular history, allergies, and lifestyle habits.
      </Typography>

      {/* Chief Complaints Chips */}
      <Box sx={{ mb: 3.5, p: 2, bgcolor: 'action.hover', borderRadius: 2, border: '1px solid rgba(0,0,0,0.04)' }}>
        <Typography variant="subtitle2" fontWeight={700} sx={{ mb: 1 }}>
          Chief Complaints (Click to Select)
        </Typography>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.8 }}>
          {commonComplaints.map((item) => {
            const isSelected = (medicalHistory.chiefComplaints || []).includes(item);
            return (
              <Chip
                key={item}
                label={item}
                clickable
                color={isSelected ? 'primary' : 'default'}
                variant={isSelected ? 'filled' : 'outlined'}
                onClick={() => toggleComplaint(item)}
                sx={{ borderRadius: 2, fontWeight: isSelected ? 700 : 500 }}
              />
            );
          })}
        </Box>
      </Box>

      {/* Systemic Flags */}
      <Grid container spacing={2} sx={{ mb: 3 }}>
        <Grid item xs={12} sm={6}>
          <Box sx={{ p: 2, border: '1px solid', borderColor: medicalHistory.hasDiabetes ? 'warning.main' : 'divider', borderRadius: 2, bgcolor: medicalHistory.hasDiabetes ? 'rgba(245, 158, 11, 0.06)' : 'transparent' }}>
            <FormControlLabel
              control={
                <Switch
                  checked={Boolean(medicalHistory.hasDiabetes)}
                  onChange={(e) => handleChange('hasDiabetes', e.target.checked)}
                  color="warning"
                />
              }
              label={<Typography fontWeight={700}>Diabetes Mellitus Positive</Typography>}
            />
            <Typography variant="caption" color="text.secondary" display="block">
              Triggers Diabetic Retinopathy clinical exam alerts.
            </Typography>
          </Box>
        </Grid>
        <Grid item xs={12} sm={6}>
          <Box sx={{ p: 2, border: '1px solid', borderColor: medicalHistory.hasHypertension ? 'error.main' : 'divider', borderRadius: 2, bgcolor: medicalHistory.hasHypertension ? 'rgba(239, 68, 68, 0.06)' : 'transparent' }}>
            <FormControlLabel
              control={
                <Switch
                  checked={Boolean(medicalHistory.hasHypertension)}
                  onChange={(e) => handleChange('hasHypertension', e.target.checked)}
                  color="error"
                />
              }
              label={<Typography fontWeight={700}>Hypertension / High BP</Typography>}
            />
            <Typography variant="caption" color="text.secondary" display="block">
              Triggers Vascular Retinopathy clinical exam alerts.
            </Typography>
          </Box>
        </Grid>
      </Grid>

      <Grid container spacing={2.5}>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Systemic Medical History"
            value={medicalHistory.medicalHistory || ''}
            onChange={(e) => handleChange('medicalHistory', e.target.value)}
            placeholder="e.g. Hypertension, Diabetes, Thyroid, Asthma"
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Ocular & Family History"
            value={medicalHistory.familyHistory || ''}
            onChange={(e) => handleChange('familyHistory', e.target.value)}
            placeholder="e.g. Glaucoma in family, Cataract, AMD"
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Previous Surgery"
            value={medicalHistory.previousSurgery || ''}
            onChange={(e) => handleChange('previousSurgery', e.target.value)}
            placeholder="e.g. LASIK, Cataract Surgery, Retinal Laser"
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Previous Glasses Specs"
            value={medicalHistory.previousGlasses || ''}
            onChange={(e) => handleChange('previousGlasses', e.target.value)}
            placeholder="e.g. Single Vision distance glasses 2 years ago"
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            label="Current Medications"
            value={medicalHistory.currentMedication || ''}
            onChange={(e) => handleChange('currentMedication', e.target.value)}
            placeholder="e.g. Antihypertensives, Eyedrops"
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            label="Allergies"
            value={medicalHistory.allergy || ''}
            onChange={(e) => handleChange('allergy', e.target.value)}
            placeholder="e.g. Penicillin, Pollen, Preservatives"
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            label="Contact Lens History"
            value={medicalHistory.contactLensHistory || ''}
            onChange={(e) => handleChange('contactLensHistory', e.target.value)}
            placeholder="e.g. Soft Toric Daily Disposables"
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Lifestyle & Visual Ergonomics"
            value={medicalHistory.lifestyle || ''}
            onChange={(e) => handleChange('lifestyle', e.target.value)}
            placeholder="e.g. 10 hours screen work, Night driving"
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            multiline
            rows={2}
            label="Clinical Examination Notes"
            value={medicalHistory.notes || ''}
            onChange={(e) => handleChange('notes', e.target.value)}
            size="small"
          />
        </Grid>
      </Grid>
    </Card>
  );
}
