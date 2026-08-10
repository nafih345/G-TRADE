import React from 'react';
import { 
  Box, Card, Typography, Grid, TextField, MenuItem, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper 
} from '@mui/material';
import { Visibility as EyeIcon } from '@mui/icons-material';

const snellenOptions = ['6/60', '6/36', '6/24', '6/18', '6/12', '6/9', '6/6', '6/5', 'FC 1M', 'HM', 'PL+'];
const nearOptions = ['N36', 'N24', 'N18', 'N12', 'N10', 'N8', 'N6', 'N5'];

export default function Step3VisualAcuity({ visualAcuity, setVisualAcuity }) {
  const handleNestedChange = (category, field, value) => {
    setVisualAcuity(prev => ({
      ...prev,
      [category]: {
        ...prev[category],
        [field]: value
      }
    }));
  };

  const handleDirectChange = (field, value) => {
    setVisualAcuity(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
      <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <EyeIcon /> Step 3: Visual Acuity & Functional Assessment
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Record distance and near visual acuity with and without optical correction, pinhole test, color vision, and ocular dominance.
      </Typography>

      {/* Visual Acuity Grid Table */}
      <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, mb: 3 }}>
        <Table size="small">
          <TableHead sx={{ bgcolor: 'action.hover' }}>
            <TableRow>
              <TableCell sx={{ fontWeight: 800 }}>Eye & Test Type</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>Without Correction (Unaided)</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>With Current Correction (Aided)</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>Pinhole (PH)</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {/* Distance OD */}
            <TableRow>
              <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>Distance OD (Right Eye)</TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.distance?.odWo || '6/18'}
                  onChange={(e) => handleNestedChange('distance', 'odWo', e.target.value)}
                >
                  {snellenOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.distance?.odWith || '6/6'}
                  onChange={(e) => handleNestedChange('distance', 'odWith', e.target.value)}
                >
                  {snellenOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.distance?.odPinhole || '6/6'}
                  onChange={(e) => handleNestedChange('distance', 'odPinhole', e.target.value)}
                >
                  {snellenOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
            </TableRow>

            {/* Distance OS */}
            <TableRow>
              <TableCell sx={{ fontWeight: 800, color: '#059669' }}>Distance OS (Left Eye)</TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.distance?.osWo || '6/24'}
                  onChange={(e) => handleNestedChange('distance', 'osWo', e.target.value)}
                >
                  {snellenOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.distance?.osWith || '6/6'}
                  onChange={(e) => handleNestedChange('distance', 'osWith', e.target.value)}
                >
                  {snellenOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.distance?.osPinhole || '6/6'}
                  onChange={(e) => handleNestedChange('distance', 'osPinhole', e.target.value)}
                >
                  {snellenOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
            </TableRow>

            {/* Near OD */}
            <TableRow>
              <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>Near Vision OD (Right Eye)</TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.near?.odWo || 'N8'}
                  onChange={(e) => handleNestedChange('near', 'odWo', e.target.value)}
                >
                  {nearOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.near?.odWith || 'N6'}
                  onChange={(e) => handleNestedChange('near', 'odWith', e.target.value)}
                >
                  {nearOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
              <TableCell sx={{ bgcolor: 'action.disabledBackground' }}>-</TableCell>
            </TableRow>

            {/* Near OS */}
            <TableRow>
              <TableCell sx={{ fontWeight: 800, color: '#059669' }}>Near Vision OS (Left Eye)</TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.near?.osWo || 'N10'}
                  onChange={(e) => handleNestedChange('near', 'osWo', e.target.value)}
                >
                  {nearOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
              <TableCell>
                <TextField
                  select
                  fullWidth
                  size="small"
                  value={visualAcuity?.near?.osWith || 'N6'}
                  onChange={(e) => handleNestedChange('near', 'osWith', e.target.value)}
                >
                  {nearOptions.map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
                </TextField>
              </TableCell>
              <TableCell sx={{ bgcolor: 'action.disabledBackground' }}>-</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>

      {/* Additional Visual Functional Tests */}
      <Grid container spacing={2.5}>
        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            label="Color Vision (Ishihara Test)"
            value={visualAcuity.colorVision || 'Normal (14/14)'}
            onChange={(e) => handleDirectChange('colorVision', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            label="Contrast Sensitivity"
            value={visualAcuity.contrastSensitivity || 'Normal'}
            onChange={(e) => handleDirectChange('contrastSensitivity', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            select
            label="Dominant Eye"
            value={visualAcuity.dominantEye || 'Right (OD)'}
            onChange={(e) => handleDirectChange('dominantEye', e.target.value)}
            size="small"
          >
            <MenuItem value="Right (OD)">Right Eye (OD)</MenuItem>
            <MenuItem value="Left (OS)">Left Eye (OS)</MenuItem>
          </TextField>
        </Grid>
      </Grid>
    </Card>
  );
}
