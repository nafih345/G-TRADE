import React from 'react';
import { 
  Dialog, DialogTitle, DialogContent, DialogActions, 
  Button, Box, Typography, Table, TableBody, TableCell, 
  TableContainer, TableHead, TableRow, Paper, Chip, Divider 
} from '@mui/material';
import { CompareArrows as CompareIcon, TrendingUp as ShiftIcon } from '@mui/icons-material';

export default function RxCompareModal({ open, onClose, previousRx, currentRx, patientName }) {
  // Helper to parse numeric values
  const getNum = (val) => {
    if (!val) return 0;
    const clean = val.toString().replace('+', '').trim();
    const num = parseFloat(clean);
    return isNaN(num) ? 0 : num;
  };

  const calcDiff = (curr, prev) => {
    const diff = getNum(curr) - getNum(prev);
    if (diff === 0) return { text: '0.00', color: 'text.secondary', status: 'Unchanged' };
    const sign = diff > 0 ? '+' : '';
    const formatted = `${sign}${diff.toFixed(2)}`;
    return {
      text: formatted,
      color: diff > 0 ? 'error.main' : 'success.main',
      status: diff > 0 ? 'Increased' : 'Decreased'
    };
  };

  const odSphDiff = calcDiff(currentRx?.od?.sph, previousRx?.od?.sph || '-1.00');
  const odCylDiff = calcDiff(currentRx?.od?.cyl, previousRx?.od?.cyl || '-0.50');
  const osSphDiff = calcDiff(currentRx?.os?.sph, previousRx?.os?.sph || '-1.25');
  const osCylDiff = calcDiff(currentRx?.os?.cyl, previousRx?.os?.cyl || '-0.50');

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth PaperProps={{ sx: { borderRadius: 3 } }}>
      <DialogTitle sx={{ display: 'flex', alignItems: 'center', gap: 1, fontWeight: 800, pb: 1 }}>
        <CompareIcon color="primary" /> Refraction Delta Comparison - {patientName || 'Patient'}
      </DialogTitle>
      <Divider />
      <DialogContent sx={{ py: 3 }}>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
          Comparing historical refraction card with today's newly assessed subjective refraction values.
        </Typography>

        <TableContainer component={Paper} elevation={0} sx={{ border: '1px solid', borderColor: 'divider', borderRadius: 2 }}>
          <Table size="small">
            <TableHead sx={{ bgcolor: 'action.hover' }}>
              <TableRow>
                <TableCell sx={{ fontWeight: 800 }}>Eye Parameter</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>Previous Rx</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>Current Rx</TableCell>
                <TableCell sx={{ fontWeight: 800 }}>Spherical/Cyl Shift</TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {/* OD Right Eye SPH */}
              <TableRow>
                <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>OD (Right Eye) SPH</TableCell>
                <TableCell>{previousRx?.od?.sph || '-1.00'}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>{currentRx?.od?.sph || '0.00'}</TableCell>
                <TableCell>
                  <Chip label={odSphDiff.text} size="small" color={odSphDiff.text === '0.00' ? 'default' : 'warning'} sx={{ fontWeight: 700 }} />
                </TableCell>
              </TableRow>

              {/* OD Right Eye CYL */}
              <TableRow>
                <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>OD (Right Eye) CYL</TableCell>
                <TableCell>{previousRx?.od?.cyl || '-0.50'}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>{currentRx?.od?.cyl || '0.00'}</TableCell>
                <TableCell>
                  <Chip label={odCylDiff.text} size="small" color={odCylDiff.text === '0.00' ? 'default' : 'info'} sx={{ fontWeight: 700 }} />
                </TableCell>
              </TableRow>

              {/* OS Left Eye SPH */}
              <TableRow>
                <TableCell sx={{ fontWeight: 700, color: '#059669' }}>OS (Left Eye) SPH</TableCell>
                <TableCell>{previousRx?.os?.sph || '-1.25'}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>{currentRx?.os?.sph || '0.00'}</TableCell>
                <TableCell>
                  <Chip label={osSphDiff.text} size="small" color={osSphDiff.text === '0.00' ? 'default' : 'warning'} sx={{ fontWeight: 700 }} />
                </TableCell>
              </TableRow>

              {/* OS Left Eye CYL */}
              <TableRow>
                <TableCell sx={{ fontWeight: 700, color: '#059669' }}>OS (Left Eye) CYL</TableCell>
                <TableCell>{previousRx?.os?.cyl || '-0.50'}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>{currentRx?.os?.cyl || '0.00'}</TableCell>
                <TableCell>
                  <Chip label={osCylDiff.text} size="small" color={osCylDiff.text === '0.00' ? 'default' : 'info'} sx={{ fontWeight: 700 }} />
                </TableCell>
              </TableRow>

              {/* Near Add */}
              <TableRow>
                <TableCell sx={{ fontWeight: 700 }}>Near Add</TableCell>
                <TableCell>{previousRx?.nearAdd || '+1.00'}</TableCell>
                <TableCell sx={{ fontWeight: 700 }}>{currentRx?.nearAdd || '+0.00'}</TableCell>
                <TableCell>
                  <Typography variant="caption" color="text.secondary">Addition updated</Typography>
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </TableContainer>

        <Box sx={{ mt: 3, p: 2, borderRadius: 2, bgcolor: 'rgba(37, 99, 235, 0.04)', border: '1px solid rgba(37, 99, 235, 0.12)' }}>
          <Typography variant="subtitle2" fontWeight={700} color="primary.main" sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
            <ShiftIcon fontSize="small" /> Clinical Insight
          </Typography>
          <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
            {odSphDiff.text !== '0.00' || osSphDiff.text !== '0.00'
              ? 'Myopic Progression detected. Patient requires updated prescription lenses for distance clarity.'
              : 'Prescription remains stable with negligible change in refractive error since the previous visit.'}
          </Typography>
        </Box>
      </DialogContent>
      <DialogActions sx={{ p: 2.5 }}>
        <Button onClick={onClose} variant="contained" sx={{ textTransform: 'none', borderRadius: 2, px: 3 }}>
          Close Comparison
        </Button>
      </DialogActions>
    </Dialog>
  );
}
