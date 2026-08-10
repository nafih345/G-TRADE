import React from 'react';
import { 
  Box, Card, Typography, Grid, TextField, Chip, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Stack, Divider 
} from '@mui/material';
import { 
  LocalShippingOutlined as LensIcon, 
  Check as CheckIcon 
} from '@mui/icons-material';

const lensOptions = [
  'Single Vision', 'Bifocal', 'Progressive', 'Blue Cut', 
  'Photochromic', 'High Index', 'Anti Reflection', 'UV Protection', 
  'Scratch Resistant', 'Office Lens', 'Computer Lens', 'Polarized', 
  'Tinted', 'Children Lens'
];

export default function Step9Prescription({ subjectiveRefraction, prescription, setPrescription }) {
  const toggleLens = (lens) => {
    const current = prescription.selectedLenses || [];
    let updated;
    if (current.includes(lens)) {
      updated = current.filter(l => l !== lens);
    } else {
      updated = [...current, lens];
    }
    setPrescription(prev => ({ ...prev, selectedLenses: updated }));
  };

  const handleTextChange = (field, value) => {
    setPrescription(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
      <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <LensIcon /> Step 9: Optical Prescription & Lens Recommendations
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Review distance and near refraction summary, and select modern lens features and coatings for optical dispensing.
      </Typography>

      {/* Distance & Near Refraction Preview */}
      <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2, mb: 3.5 }}>
        <Table size="small">
          <TableHead sx={{ bgcolor: 'action.hover' }}>
            <TableRow>
              <TableCell sx={{ fontWeight: 800 }}>Eye</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>SPH</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>CYL</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>AXIS</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>VA</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>Near Add</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>P.D. (mm)</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {/* OD */}
            <TableRow>
              <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>OD (Right Eye)</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>{subjectiveRefraction?.od?.sph || '0.00'}</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>{subjectiveRefraction?.od?.cyl || '0.00'}</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>{subjectiveRefraction?.od?.axis || '0'}°</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>{subjectiveRefraction?.od?.va || '6/6'}</TableCell>
              <TableCell rowSpan={2} sx={{ fontWeight: 800, verticalAlign: 'middle' }}>
                {subjectiveRefraction?.nearAdd || '+0.00'}
              </TableCell>
              <TableCell rowSpan={2} sx={{ fontWeight: 800, verticalAlign: 'middle' }}>
                {subjectiveRefraction?.pd || '63'}
              </TableCell>
            </TableRow>

            {/* OS */}
            <TableRow>
              <TableCell sx={{ fontWeight: 800, color: '#059669' }}>OS (Left Eye)</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>{subjectiveRefraction?.os?.sph || '0.00'}</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>{subjectiveRefraction?.os?.cyl || '0.00'}</TableCell>
              <TableCell sx={{ fontWeight: 800 }}>{subjectiveRefraction?.os?.axis || '0'}°</TableCell>
              <TableCell sx={{ fontWeight: 700 }}>{subjectiveRefraction?.os?.va || '6/6'}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </TableContainer>

      {/* Selectable Modern Lens Chips */}
      <Box sx={{ mb: 3.5, p: 2.5, bgcolor: 'rgba(37, 99, 235, 0.03)', borderRadius: 2.5, border: '1px solid rgba(37, 99, 235, 0.12)' }}>
        <Typography variant="subtitle2" fontWeight={800} color="primary.main" sx={{ mb: 1.5 }}>
          Recommended Lens Types & Coating Features (Selectable Chips)
        </Typography>

        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1 }}>
          {lensOptions.map((lens) => {
            const isSelected = (prescription.selectedLenses || []).includes(lens);
            return (
              <Chip
                key={lens}
                label={lens}
                clickable
                color={isSelected ? 'primary' : 'default'}
                variant={isSelected ? 'filled' : 'outlined'}
                icon={isSelected ? <CheckIcon fontSize="small" /> : undefined}
                onClick={() => toggleLens(lens)}
                sx={{ 
                  borderRadius: 2, 
                  fontWeight: isSelected ? 700 : 500,
                  fontSize: '0.85rem',
                  py: 2,
                  px: 0.5,
                  transition: 'all 0.2s ease',
                  boxShadow: isSelected ? '0 4px 12px rgba(37, 99, 235, 0.2)' : 'none'
                }}
              />
            );
          })}
        </Box>
      </Box>

      <Grid container spacing={2.5}>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Specific Lens Recommendation"
            value={prescription.lensRecommendation || ''}
            onChange={(e) => handleTextChange('lensRecommendation', e.target.value)}
            placeholder="e.g. 1.61 High Index Blue Cut Lens with Hydrophobic AR"
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6}>
          <TextField
            fullWidth
            label="Frame Specification & Size Recommendation"
            value={prescription.frameRecommendation || ''}
            onChange={(e) => handleTextChange('frameRecommendation', e.target.value)}
            placeholder="e.g. Medium Full Rim Titanium / Acetate Frame"
            size="small"
          />
        </Grid>
      </Grid>
    </Card>
  );
}
