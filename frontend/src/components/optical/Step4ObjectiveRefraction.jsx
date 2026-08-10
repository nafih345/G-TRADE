import React from 'react';
import { 
  Box, Card, Typography, Grid, TextField, MenuItem, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, InputAdornment 
} from '@mui/material';
import { Analytics as AnalyticsIcon } from '@mui/icons-material';

export default function Step4ObjectiveRefraction({ objectiveRefraction, setObjectiveRefraction }) {
  const handleNestedChange = (category, eye, field, value) => {
    setObjectiveRefraction(prev => ({
      ...prev,
      [category]: {
        ...prev[category],
        [eye]: {
          ...prev[category]?.[eye],
          [field]: value
        }
      }
    }));
  };

  const handleKChange = (field, value) => {
    setObjectiveRefraction(prev => ({
      ...prev,
      kReading: {
        ...prev.kReading,
        [field]: value
      }
    }));
  };

  return (
    <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
      <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <AnalyticsIcon /> Step 4: Objective Refraction & Keratometry
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Record objective measurements from Auto-Refractor (AR), Streak Retinoscopy, and Keratometry readings.
      </Typography>

      {/* Auto Refraction Table */}
      <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1, color: 'text.primary' }}>
        Auto-Refractor (AR) Data
      </Typography>
      <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, mb: 3 }}>
        <Table size="small">
          <TableHead sx={{ bgcolor: 'action.hover' }}>
            <TableRow>
              <TableCell sx={{ fontWeight: 800 }}>Eye</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>SPH</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>CYL</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>AXIS (°)</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>VA</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>Mono P.D. (mm)</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {/* OD */}
            <TableRow>
              <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>OD (Right Eye)</TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.od?.sph || '-1.50'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'od', 'sph', e.target.value)}
                />
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.od?.cyl || '-0.75'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'od', 'cyl', e.target.value)}
                />
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.od?.axis || '90'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'od', 'axis', e.target.value)}
                />
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.od?.va || '6/6'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'od', 'va', e.target.value)}
                />
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.od?.pd || '31.5'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'od', 'pd', e.target.value)}
                />
              </TableCell>
            </TableRow>

            {/* OS */}
            <TableRow>
              <TableCell sx={{ fontWeight: 800, color: '#059669' }}>OS (Left Eye)</TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.os?.sph || '-1.75'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'os', 'sph', e.target.value)}
                />
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.os?.cyl || '-0.50'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'os', 'cyl', e.target.value)}
                />
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.os?.axis || '100'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'os', 'axis', e.target.value)}
                />
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.os?.va || '6/6'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'os', 'va', e.target.value)}
                />
              </TableCell>
              <TableCell>
                <TextField
                  size="small"
                  value={objectiveRefraction?.autoRefraction?.os?.pd || '31.5'}
                  onChange={(e) => handleNestedChange('autoRefraction', 'os', 'pd', e.target.value)}
                />
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>

      {/* Keratometry & Retinoscopy Grid */}
      <Typography variant="subtitle2" fontWeight={800} sx={{ mb: 1.5, color: 'text.primary' }}>
        Keratometry (K Readings) & Corneal Radius
      </Typography>

      <Grid container spacing={2.5}>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="OD Keratometry K1"
            value={objectiveRefraction?.kReading?.odK1 || '43.25 @ 180'}
            onChange={(e) => handleKChange('odK1', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="OD Keratometry K2"
            value={objectiveRefraction?.kReading?.odK2 || '44.00 @ 90'}
            onChange={(e) => handleKChange('odK2', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="OS Keratometry K1"
            value={objectiveRefraction?.kReading?.osK1 || '43.50 @ 180'}
            onChange={(e) => handleKChange('osK1', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="OS Keratometry K2"
            value={objectiveRefraction?.kReading?.osK2 || '44.25 @ 90'}
            onChange={(e) => handleKChange('osK2', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Corneal Radius & Topography"
            value={objectiveRefraction?.kReading?.cornealRadius || '7.8 mm'}
            onChange={(e) => handleKChange('cornealRadius', e.target.value)}
            size="small"
          />
        </Grid>

        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Streak Retinoscopy Notes"
            value={objectiveRefraction?.kReading?.streakNotes || 'With movement in horizontal, neutral in vertical'}
            onChange={(e) => handleKChange('streakNotes', e.target.value)}
            size="small"
          />
        </Grid>
      </Grid>
    </Card>
  );
}
