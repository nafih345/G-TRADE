import React from 'react';
import { 
  Box, Card, Typography, Grid, TextField, MenuItem, 
  Autocomplete, Chip 
} from '@mui/material';
import { AssignmentTurnedIn as DiagnosisIcon } from '@mui/icons-material';

const commonDiagnoses = [
  { label: 'Simple Myopia', icd: 'H52.1' },
  { label: 'Compound Myopic Astigmatism', icd: 'H52.223' },
  { label: 'Simple Hyperopia', icd: 'H52.0' },
  { label: 'Compound Hyperopic Astigmatism', icd: 'H52.221' },
  { label: 'Presbyopia', icd: 'H52.4' },
  { label: 'Computer Vision Syndrome (Asthenopia)', icd: 'H53.1' },
  { label: 'Dry Eye Syndrome', icd: 'H04.123' },
  { label: 'Immature Senile Cataract', icd: 'H25.8' },
  { label: 'Primary Open Angle Glaucoma Suspect', icd: 'H40.01' },
  { label: 'Diabetic Retinopathy Non-Proliferative', icd: 'E11.319' },
  { label: 'Allergic Conjunctivitis', icd: 'H10.1' }
];

export default function Step8Diagnosis({ diagnosis, setDiagnosis }) {
  const handleChange = (field, value) => {
    setDiagnosis(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
      <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <DiagnosisIcon /> Step 8: Clinical Diagnosis & Management Plan
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Select primary ophthalmic diagnosis, ICD-10 code, medical treatment, ergonomic advice, and review schedule.
      </Typography>

      <Grid container spacing={2.5}>
        <Grid item xs={12} sm={8}>
          <Autocomplete
            freeSolo
            options={commonDiagnoses.map(d => d.label)}
            value={diagnosis.primary || ''}
            onChange={(e, newValue) => {
              handleChange('primary', newValue || '');
              const matched = commonDiagnoses.find(d => d.label === newValue);
              if (matched) {
                handleChange('icdCode', matched.icd);
              }
            }}
            renderInput={(params) => (
              <TextField
                {...params}
                label="Primary Optical / Ophthalmic Diagnosis"
                size="small"
                required
              />
            )}
          />
        </Grid>

        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            label="ICD-10 Diagnostic Code"
            value={diagnosis.icdCode || ''}
            onChange={(e) => handleChange('icdCode', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Clinical Procedures Performed"
            value={diagnosis.procedure || ''}
            onChange={(e) => handleChange('procedure', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Prescribed Eye Medication"
            value={diagnosis.medicine || ''}
            onChange={(e) => handleChange('medicine', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Patient Ergonomic Advice"
            value={diagnosis.advice || ''}
            onChange={(e) => handleChange('advice', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            select
            label="Next Review / Follow-up Schedule"
            value={diagnosis.nextReview || ''}
            onChange={(e) => handleChange('nextReview', e.target.value)}
            size="small"
          >
            <MenuItem value="1 Week">1 Week</MenuItem>
            <MenuItem value="1 Month">1 Month</MenuItem>
            <MenuItem value="3 Months">3 Months</MenuItem>
            <MenuItem value="6 Months">6 Months</MenuItem>
            <MenuItem value="1 Year">1 Year</MenuItem>
            <MenuItem value="PRN (As Needed)">PRN (As Needed)</MenuItem>
          </TextField>
        </Grid>

        <Grid item xs={12}>
          <TextField
            fullWidth
            multiline
            rows={2}
            label="Clinical Remarks & Dispensing Notes"
            value={diagnosis.remarks || ''}
            onChange={(e) => handleChange('remarks', e.target.value)}
            size="small"
          />
        </Grid>
      </Grid>
    </Card>
  );
}
