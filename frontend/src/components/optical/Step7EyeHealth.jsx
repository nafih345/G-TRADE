import React from 'react';
import { 
  Box, Card, Typography, Grid, TextField, MenuItem, 
  Alert, InputAdornment 
} from '@mui/material';
import { Healing as HealthIcon, Warning as WarningIcon } from '@mui/icons-material';

export default function Step7EyeHealth({ eyeHealth, setEyeHealth }) {
  const handleAnteriorChange = (field, value) => {
    setEyeHealth(prev => ({
      ...prev,
      anterior: { ...prev.anterior, [field]: value }
    }));
  };

  const handlePosteriorChange = (field, value) => {
    setEyeHealth(prev => ({
      ...prev,
      posterior: { ...prev.posterior, [field]: value }
    }));
  };

  const handleIopChange = (field, value) => {
    setEyeHealth(prev => ({
      ...prev,
      iop: { ...prev.iop, [field]: value }
    }));
  };

  const handleCdChange = (field, value) => {
    setEyeHealth(prev => ({
      ...prev,
      cupDiscRatio: { ...prev.cupDiscRatio, [field]: value }
    }));
  };

  const iopOD = parseFloat(eyeHealth?.iop?.od || '0');
  const iopOS = parseFloat(eyeHealth?.iop?.os || '0');
  const isHighIOP = iopOD > 21 || iopOS > 21;

  return (
    <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
      <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <HealthIcon /> Step 7: Ocular Health Assessment (Slit Lamp & IOP)
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Biomicroscopic slit lamp anterior segment examination, Intraocular Pressure (IOP), cup-disc ratio, and ophthalmoscopy.
      </Typography>

      {/* Intraocular Pressure (IOP) Card */}
      <Box sx={{ mb: 3.5, p: 2.5, border: '1px solid', borderColor: isHighIOP ? 'error.main' : 'divider', borderRadius: 2, bgcolor: isHighIOP ? 'rgba(239, 68, 68, 0.05)' : 'action.hover' }}>
        <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1.5, color: isHighIOP ? 'error.main' : 'text.primary' }}>
          Intraocular Pressure (IOP Tonometry)
        </Typography>

        {isHighIOP && (
          <Alert severity="error" icon={<WarningIcon />} sx={{ mb: 2, borderRadius: 2 }}>
            <strong>High IOP Detected!</strong> Intraocular pressure exceeds 21 mmHg. Recommend Glaucoma screening & Pachymetry.
          </Alert>
        )}

        <Grid container spacing={2}>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth
              label="IOP Right Eye (OD)"
              value={eyeHealth?.iop?.od || ''}
              onChange={(e) => handleIopChange('od', e.target.value)}
              size="small"
              InputProps={{
                endAdornment: <InputAdornment position="end">mmHg</InputAdornment>
              }}
              sx={{ '& input': { fontWeight: 800, color: iopOD > 21 ? 'error.main' : 'text.primary' } }}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth
              label="IOP Left Eye (OS)"
              value={eyeHealth?.iop?.os || ''}
              onChange={(e) => handleIopChange('os', e.target.value)}
              size="small"
              InputProps={{
                endAdornment: <InputAdornment position="end">mmHg</InputAdornment>
              }}
              sx={{ '& input': { fontWeight: 800, color: iopOS > 21 ? 'error.main' : 'text.primary' } }}
            />
          </Grid>
          <Grid item xs={12} sm={4}>
            <TextField
              fullWidth
              select
              label="Tonometry Method"
              value={eyeHealth?.iop?.method || ''}
              onChange={(e) => handleIopChange('method', e.target.value)}
              size="small"
            >
              <MenuItem value="Non-Contact Tonometer">Non-Contact Tonometer (NCT)</MenuItem>
              <MenuItem value="Goldmann Applanation">Goldmann Applanation (GAT)</MenuItem>
              <MenuItem value="Perkins Tonometer">Perkins Tonometer</MenuItem>
              <MenuItem value="Icare Rebound">Icare Rebound Tonometer</MenuItem>
            </TextField>
          </Grid>
        </Grid>
      </Box>

      {/* Anterior Segment Slit Lamp */}
      <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1.5, color: 'text.primary' }}>
        Anterior Segment (Slit Lamp Biomicroscopy)
      </Typography>

      <Grid container spacing={2} sx={{ mb: 3.5 }}>
        <Grid item xs={12} sm={4} md={3}>
          <TextField
            fullWidth
            label="Lids & Adnexa"
            value={eyeHealth?.anterior?.lids || ''}
            onChange={(e) => handleAnteriorChange('lids', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4} md={3}>
          <TextField
            fullWidth
            label="Lashes & Margins"
            value={eyeHealth?.anterior?.lashes || ''}
            onChange={(e) => handleAnteriorChange('lashes', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4} md={3}>
          <TextField
            fullWidth
            label="Conjunctiva & Sclera"
            value={eyeHealth?.anterior?.conjunctiva || ''}
            onChange={(e) => handleAnteriorChange('conjunctiva', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4} md={3}>
          <TextField
            fullWidth
            label="Cornea"
            value={eyeHealth?.anterior?.cornea || ''}
            onChange={(e) => handleAnteriorChange('cornea', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4} md={3}>
          <TextField
            fullWidth
            label="Iris & Pupil"
            value={eyeHealth?.anterior?.iris || ''}
            onChange={(e) => handleAnteriorChange('iris', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4} md={3}>
          <TextField
            fullWidth
            label="Crystalline Lens"
            value={eyeHealth?.anterior?.lens || ''}
            onChange={(e) => handleAnteriorChange('lens', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4} md={6}>
          <TextField
            fullWidth
            label="Anterior Chamber (AC)"
            value={eyeHealth?.anterior?.anteriorChamber || ''}
            onChange={(e) => handleAnteriorChange('anteriorChamber', e.target.value)}
            size="small"
          />
        </Grid>
      </Grid>

      {/* Posterior Segment Ophthalmoscopy */}
      <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1.5, color: 'text.primary' }}>
        Posterior Segment & Ocular Fundus
      </Typography>

      <Grid container spacing={2}>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Optic Disc Margin"
            value={eyeHealth?.posterior?.disc || ''}
            onChange={(e) => handlePosteriorChange('disc', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Macula & Fovea"
            value={eyeHealth?.posterior?.macula || ''}
            onChange={(e) => handlePosteriorChange('macula', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Retinal Background"
            value={eyeHealth?.posterior?.retina || ''}
            onChange={(e) => handlePosteriorChange('retina', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Retinal Blood Vessels"
            value={eyeHealth?.posterior?.vessels || ''}
            onChange={(e) => handlePosteriorChange('vessels', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <TextField
            fullWidth
            label="OD Cup-Disc Ratio"
            value={eyeHealth?.cupDiscRatio?.od || ''}
            onChange={(e) => handleCdChange('od', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={6} sm={3}>
          <TextField
            fullWidth
            label="OS Cup-Disc Ratio"
            value={eyeHealth?.cupDiscRatio?.os || ''}
            onChange={(e) => handleCdChange('os', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            select
            label="Dilated Examination Status"
            value={eyeHealth?.dilatedExam || ''}
            onChange={(e) => setEyeHealth(prev => ({ ...prev, dilatedExam: e.target.value }))}
            size="small"
          >
            <MenuItem value="Not Dilated">Not Dilated</MenuItem>
            <MenuItem value="Dilated with Tropicamide 1%">Dilated with Tropicamide 1%</MenuItem>
            <MenuItem value="Dilated with Cyclopentolate 1%">Dilated with Cyclopentolate 1%</MenuItem>
            <MenuItem value="Dilated with Phenylephrine 2.5%">Dilated with Phenylephrine 2.5%</MenuItem>
          </TextField>
        </Grid>
      </Grid>
    </Card>
  );
}
