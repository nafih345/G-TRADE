import React, { useState } from 'react';
import { 
  Box, Card, Typography, Grid, TextField, MenuItem, 
  Table, TableBody, TableCell, TableContainer, TableHead, 
  TableRow, Paper, Button, Stack, Chip 
} from '@mui/material';
import { Visibility as EyeIcon, CheckCircle as FinalRxIcon, History as HistoryIcon } from '@mui/icons-material';

export default function Step5SubjectiveRefraction({ subjectiveRefraction = {}, setSubjectiveRefraction, savedExams = [] }) {
  const [activeTab, setActiveTab] = useState('prescription');

  const handleEyeChange = (eye, field, value) => {
    setSubjectiveRefraction(prev => ({
      ...prev,
      [eye]: {
        ...(prev[eye] || {}),
        [field]: value
      }
    }));
  };

  const handleDirectChange = (field, value) => {
    setSubjectiveRefraction(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3.5, bgcolor: '#ffffff' }}>
      {/* Step Header */}
      <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <FinalRxIcon /> Step 5: Clinical Refraction & Prescription Grid
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2.5 }}>
        Record patient Distance Vision (DV), Near Vision (NV), Interpupillary Distance (IPD), and Addition (ADD) powers.
      </Typography>

      {/* 📌 LEGACY MODEL CLINICAL GRID (MATCHES IMAGE 2 EXACTLY) */}
      <Card elevation={0} sx={{ border: '2px solid #0f172a', borderRadius: 3, overflow: 'hidden', mb: 3 }}>
        
        {/* Top Header Tabs Bar: Prescription vs Power History */}
        <Box sx={{ bgcolor: '#0f172a', px: 2, py: 1, display: 'flex', gap: 1.5, alignItems: 'center' }}>
          <Button 
            size="small"
            variant="contained"
            onClick={() => setActiveTab('prescription')}
            sx={{ 
              bgcolor: activeTab === 'prescription' ? '#1e293b' : 'transparent',
              color: activeTab === 'prescription' ? '#facc15' : '#94a3b8',
              fontWeight: 900,
              fontSize: '0.85rem',
              borderRadius: 1.5,
              px: 2.5, py: 0.6,
              textTransform: 'none',
              border: activeTab === 'prescription' ? '1px solid #facc15' : '1px solid transparent',
              '&:hover': { bgcolor: '#334155' }
            }}
          >
            Prescription
          </Button>

          <Button 
            size="small"
            variant="contained"
            onClick={() => setActiveTab('history')}
            sx={{ 
              bgcolor: activeTab === 'history' ? '#1e293b' : 'transparent',
              color: activeTab === 'history' ? '#facc15' : '#94a3b8',
              fontWeight: 900,
              fontSize: '0.85rem',
              borderRadius: 1.5,
              px: 2.5, py: 0.6,
              textTransform: 'none',
              border: activeTab === 'history' ? '1px solid #facc15' : '1px solid transparent',
              '&:hover': { bgcolor: '#334155' }
            }}
          >
            Power History
          </Button>
        </Box>

        {activeTab === 'prescription' ? (
          <Box sx={{ p: 2.5, bgcolor: '#f8fafc' }}>
            <Grid container spacing={1.5} alignItems="flex-start">
              
              {/* Row Selector Pills (DV / NV) */}
              <Grid item xs={12} sm={1.5} sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: { xs: 0, sm: 6 } }}>
                <Paper 
                  elevation={0}
                  sx={{ 
                    bgcolor: '#0f172a', 
                    color: '#facc15', 
                    fontWeight: 900, 
                    py: 1.2, 
                    textAlign: 'center',
                    borderRadius: 2,
                    fontSize: '0.9rem',
                    letterSpacing: 1
                  }}
                >
                  DV
                </Paper>
                <Paper 
                  elevation={0}
                  sx={{ 
                    bgcolor: '#0f172a', 
                    color: '#facc15', 
                    fontWeight: 900, 
                    py: 1.2, 
                    textAlign: 'center',
                    borderRadius: 2,
                    fontSize: '0.9rem',
                    letterSpacing: 1
                  }}
                >
                  NV
                </Paper>
              </Grid>

              {/* RIGHT (OD) EYE BLOCK */}
              <Grid item xs={12} sm={5.25}>
                <Paper variant="outlined" sx={{ border: '2px solid #2563eb', borderRadius: 2.5, overflow: 'hidden', bgcolor: '#ffffff' }}>
                  <Box sx={{ bgcolor: '#2563eb', color: '#ffffff', py: 0.75, textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', letterSpacing: 1 }}>
                    RIGHT (OD)
                  </Box>

                  <Table size="small">
                    <TableHead sx={{ bgcolor: '#eff6ff' }}>
                      <TableRow>
                        <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.78rem' }}>SPH</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.78rem' }}>CYL</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.78rem' }}>AXIS</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.78rem' }}>VA</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {/* DV Row */}
                      <TableRow>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.od?.sph || ''} onChange={(e) => handleEyeChange('od', 'sph', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800, color: '#2563eb' } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.od?.cyl || ''} onChange={(e) => handleEyeChange('od', 'cyl', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.od?.axis || ''} onChange={(e) => handleEyeChange('od', 'axis', e.target.value)} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.od?.va || ''} onChange={(e) => handleEyeChange('od', 'va', e.target.value)} placeholder="6/6" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                      </TableRow>

                      {/* NV Row */}
                      <TableRow>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.odNv?.sph || ''} onChange={(e) => handleEyeChange('odNv', 'sph', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.odNv?.cyl || ''} onChange={(e) => handleEyeChange('odNv', 'cyl', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.odNv?.axis || ''} onChange={(e) => handleEyeChange('odNv', 'axis', e.target.value)} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.odNv?.va || ''} onChange={(e) => handleEyeChange('odNv', 'va', e.target.value)} placeholder="N6" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>

                  {/* Bottom Row: IPD & ADD */}
                  <Box sx={{ p: 1, bgcolor: '#f1f5f9', borderTop: '1px solid #cbd5e1', display: 'flex', gap: 1 }}>
                    <TextField 
                      fullWidth
                      size="small" 
                      label="IPD" 
                      placeholder="mm" 
                      value={subjectiveRefraction?.odIpd || subjectiveRefraction?.pd || ''} 
                      onChange={(e) => {
                        handleDirectChange('odIpd', e.target.value);
                        handleDirectChange('pd', e.target.value);
                      }}
                      inputProps={{ style: { fontWeight: 800 } }} 
                    />
                    <TextField 
                      fullWidth
                      size="small" 
                      label="ADD" 
                      placeholder="+1.00" 
                      value={subjectiveRefraction?.odAdd || subjectiveRefraction?.nearAdd || ''} 
                      onChange={(e) => {
                        handleDirectChange('odAdd', e.target.value);
                        handleDirectChange('nearAdd', e.target.value);
                      }}
                      inputProps={{ style: { fontWeight: 800, color: '#2563eb' } }} 
                    />
                  </Box>
                </Paper>
              </Grid>

              {/* LEFT (OS) EYE BLOCK */}
              <Grid item xs={12} sm={5.25}>
                <Paper variant="outlined" sx={{ border: '2px solid #059669', borderRadius: 2.5, overflow: 'hidden', bgcolor: '#ffffff' }}>
                  <Box sx={{ bgcolor: '#059669', color: '#ffffff', py: 0.75, textAlign: 'center', fontWeight: 900, fontSize: '0.9rem', letterSpacing: 1 }}>
                    LEFT (OS)
                  </Box>

                  <Table size="small">
                    <TableHead sx={{ bgcolor: '#ecfdf5' }}>
                      <TableRow>
                        <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.78rem' }}>SPH</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.78rem' }}>CYL</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.78rem' }}>AXIS</TableCell>
                        <TableCell align="center" sx={{ fontWeight: 900, py: 0.75, fontSize: '0.78rem' }}>VA</TableCell>
                      </TableRow>
                    </TableHead>
                    <TableBody>
                      {/* DV Row */}
                      <TableRow>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.os?.sph || ''} onChange={(e) => handleEyeChange('os', 'sph', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800, color: '#059669' } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.os?.cyl || ''} onChange={(e) => handleEyeChange('os', 'cyl', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.os?.axis || ''} onChange={(e) => handleEyeChange('os', 'axis', e.target.value)} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.os?.va || ''} onChange={(e) => handleEyeChange('os', 'va', e.target.value)} placeholder="6/6" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                      </TableRow>

                      {/* NV Row */}
                      <TableRow>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.osNv?.sph || ''} onChange={(e) => handleEyeChange('osNv', 'sph', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.osNv?.cyl || ''} onChange={(e) => handleEyeChange('osNv', 'cyl', e.target.value)} placeholder="0.00" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.osNv?.axis || ''} onChange={(e) => handleEyeChange('osNv', 'axis', e.target.value)} placeholder="0" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                        <TableCell sx={{ p: 0.6 }}>
                          <TextField size="small" value={subjectiveRefraction?.osNv?.va || ''} onChange={(e) => handleEyeChange('osNv', 'va', e.target.value)} placeholder="N6" inputProps={{ style: { textAlign: 'center', fontWeight: 800 } }} />
                        </TableCell>
                      </TableRow>
                    </TableBody>
                  </Table>

                  {/* Bottom Row: IPD & ADD */}
                  <Box sx={{ p: 1, bgcolor: '#f1f5f9', borderTop: '1px solid #cbd5e1', display: 'flex', gap: 1 }}>
                    <TextField 
                      fullWidth
                      size="small" 
                      label="IPD" 
                      placeholder="mm" 
                      value={subjectiveRefraction?.osIpd || subjectiveRefraction?.pd || ''} 
                      onChange={(e) => handleDirectChange('osIpd', e.target.value)}
                      inputProps={{ style: { fontWeight: 800 } }} 
                    />
                    <TextField 
                      fullWidth
                      size="small" 
                      label="ADD" 
                      placeholder="+1.00" 
                      value={subjectiveRefraction?.osAdd || subjectiveRefraction?.nearAdd || ''} 
                      onChange={(e) => handleDirectChange('osAdd', e.target.value)}
                      inputProps={{ style: { fontWeight: 800, color: '#059669' } }} 
                    />
                  </Box>
                </Paper>
              </Grid>

            </Grid>
          </Box>
        ) : (
          /* POWER HISTORY TAB VIEW */
          <Box sx={{ p: 3, bgcolor: '#ffffff' }}>
            <Typography variant="subtitle2" fontWeight={850} color="primary.main" sx={{ mb: 1.5, display: 'flex', alignItems: 'center', gap: 1 }}>
              <HistoryIcon /> Patient Historical Optical Refraction Log
            </Typography>
            {savedExams && savedExams.length > 0 ? (
              <TableContainer component={Paper} variant="outlined" sx={{ borderRadius: 2 }}>
                <Table size="small">
                  <TableHead sx={{ bgcolor: '#0f172a' }}>
                    <TableRow>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Date</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>Optometrist</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>OD (Sph / Cyl / Axis)</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>OS (Sph / Cyl / Axis)</TableCell>
                      <TableCell sx={{ color: '#fff', fontWeight: 800 }}>ADD</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {savedExams.map((ex, i) => (
                      <TableRow key={i} hover>
                        <TableCell sx={{ fontWeight: 700 }}>{ex.testDate || '2026-07-23'}</TableCell>
                        <TableCell>{ex.optometrist || 'Dr. Ananya Roy'}</TableCell>
                        <TableCell sx={{ fontWeight: 700, color: 'primary.main' }}>
                          {`${ex.subjectiveRefraction?.od?.sph || '0.00'} / ${ex.subjectiveRefraction?.od?.cyl || '0.00'} x ${ex.subjectiveRefraction?.od?.axis || '0'}`}
                        </TableCell>
                        <TableCell sx={{ fontWeight: 700, color: '#059669' }}>
                          {`${ex.subjectiveRefraction?.os?.sph || '0.00'} / ${ex.subjectiveRefraction?.os?.cyl || '0.00'} x ${ex.subjectiveRefraction?.os?.axis || '0'}`}
                        </TableCell>
                        <TableCell sx={{ fontWeight: 800, color: 'primary.main' }}>{ex.subjectiveRefraction?.nearAdd || '+1.00'}</TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </TableContainer>
            ) : (
              <Typography variant="body2" color="text.secondary" fontWeight={600}>
                No prior clinical power history records logged in database.
              </Typography>
            )}
          </Box>
        )}
      </Card>

      {/* Refinement Tests */}
      <Grid container spacing={2.5}>
        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            label="Fogging Technique Notes"
            value={subjectiveRefraction.fogging || ''}
            onChange={(e) => handleDirectChange('fogging', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            label="Duochrome Red/Green Test"
            value={subjectiveRefraction.duochrome || ''}
            onChange={(e) => handleDirectChange('duochrome', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={4}>
          <TextField
            fullWidth
            label="Jackson Cross Cylinder (JCC)"
            value={subjectiveRefraction.crossCylinder || ''}
            onChange={(e) => handleDirectChange('crossCylinder', e.target.value)}
            size="small"
          />
        </Grid>
      </Grid>
    </Card>
  );
}
