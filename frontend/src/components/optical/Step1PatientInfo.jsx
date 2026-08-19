import React from 'react';
import { 
  Box, Card, Typography, Grid, TextField, MenuItem, 
  Button, Chip, Divider, InputAdornment, Autocomplete 
} from '@mui/material';
import { 
  Person as PersonIcon, 
  Badge as BadgeIcon, 
  Phone as PhoneIcon, 
  Search as SearchIcon,
  Refresh as ResetIcon
} from '@mui/icons-material';

export default function Step1PatientInfo({ patientData, setPatientData, onOpenSearchModal, doctorsList = [] }) {
  const handleChange = (field, value) => {
    setPatientData(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
      {/* Header with Search Button */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 3, flexWrap: 'wrap', gap: 2 }}>
        <Box>
          <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <PersonIcon /> Step 1: Patient Information & Registration
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Select an existing patient or fill in demographics for new clinical registration.
          </Typography>
        </Box>

        <Button 
          variant="contained" 
          color="primary" 
          startIcon={<SearchIcon />}
          onClick={onOpenSearchModal}
          sx={{ borderRadius: 2, textTransform: 'none', fontWeight: 700 }}
        >
          Search Existing Patient
        </Button>
      </Box>

      <Grid container spacing={2.5}>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Patient ID"
            value={patientData.id || ''}
            size="small"
            InputProps={{
              readOnly: true,
              startAdornment: <InputAdornment position="start"><BadgeIcon color="action" fontSize="small" /></InputAdornment>
            }}
          />
        </Grid>

        <Grid item xs={12} sm={6} md={4}>
          <TextField
            fullWidth
            required
            label="Full Patient Name"
            value={patientData.name || ''}
            onChange={(e) => handleChange('name', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={6} sm={3} md={2}>
          <TextField
            fullWidth
            label="Age"
            type="number"
            value={patientData.age || ''}
            onChange={(e) => handleChange('age', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={6} sm={3} md={3}>
          <TextField
            fullWidth
            select
            label="Gender"
            value={patientData.gender || 'Male'}
            onChange={(e) => handleChange('gender', e.target.value)}
            size="small"
          >
            <MenuItem value="Male">Male</MenuItem>
            <MenuItem value="Female">Female</MenuItem>
            <MenuItem value="Other">Other</MenuItem>
          </TextField>
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            required
            label="Mobile Number"
            value={patientData.phone || ''}
            onChange={(e) => handleChange('phone', e.target.value)}
            size="small"
            InputProps={{
              startAdornment: <InputAdornment position="start"><PhoneIcon color="action" fontSize="small" /></InputAdornment>
            }}
          />
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Email Address"
            value={patientData.email || ''}
            onChange={(e) => handleChange('email', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Place / City"
            placeholder="e.g. Kozhikode, Calicut"
            value={patientData.place || patientData.city || ''}
            onChange={(e) => {
              handleChange('place', e.target.value);
              handleChange('city', e.target.value);
            }}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Occupation"
            value={patientData.occupation || ''}
            onChange={(e) => handleChange('occupation', e.target.value)}
            size="small"
            placeholder="e.g. Engineer, Student"
          />
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Clinic Branch"
            value={patientData.branch || 'Main Branch'}
            onChange={(e) => handleChange('branch', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Appointment Number"
            value={patientData.appointmentNum || ''}
            onChange={(e) => handleChange('appointmentNum', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Visit Number"
            value={patientData.visitNum || ''}
            onChange={(e) => handleChange('visitNum', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6} md={3}>
          <Autocomplete
            freeSolo
            options={doctorsList}
            value={patientData.assignedOptometrist || ''}
            onInputChange={(event, newValue) => handleChange('assignedOptometrist', newValue || '')}
            onChange={(event, newValue) => handleChange('assignedOptometrist', newValue || '')}
            renderInput={(params) => (
              <TextField
                {...params}
                fullWidth
                label="Attending Optometrist"
                placeholder="Type or Select Doctor..."
                size="small"
              />
            )}
          />
        </Grid>

        <Grid item xs={12}>
          <TextField
            fullWidth
            multiline
            rows={2}
            label="Residential Address"
            value={patientData.address || ''}
            onChange={(e) => handleChange('address', e.target.value)}
            size="small"
          />
        </Grid>
      </Grid>
    </Card>
  );
}
