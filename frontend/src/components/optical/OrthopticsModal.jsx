import React from 'react';
import { 
  Dialog, DialogTitle, DialogContent, DialogActions, 
  Button, Typography, Grid, TextField, MenuItem, Box, Paper, Divider 
} from '@mui/material';
import { RemoveRedEye as OrthopticIcon, Save as SaveIcon, Close as CloseIcon } from '@mui/icons-material';

export default function OrthopticsModal({ 
  open, 
  onClose, 
  binocularVision = {}, 
  setBinocularVision 
}) {
  const handleChange = (field, value) => {
    if (setBinocularVision) {
      setBinocularVision(prev => ({ ...prev, [field]: value }));
    }
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth paperProps={{ style: { borderRadius: 12 } }}>
      <DialogTitle sx={{ bgcolor: '#0f172a', color: '#ffffff', py: 1.5, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <Typography variant="h6" fontWeight={800} sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
          <OrthopticIcon color="info" /> Orthoptics & Binocular Vision Evaluation Form
        </Typography>
        <Button size="small" onClick={onClose} sx={{ color: '#fff', minWidth: 'auto' }}>
          <CloseIcon />
        </Button>
      </DialogTitle>

      <DialogContent dividers sx={{ p: 3, bgcolor: '#f8fafc' }}>
        <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 2, bgcolor: '#ffffff', mb: 2 }}>
          <Typography variant="subtitle2" fontWeight={800} color="primary" sx={{ mb: 2 }}>
            1. Binocular Motor & Sensory Status
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth size="small" label="Near Point of Convergence (NPC)"
                placeholder="e.g. 6 cm (Break/Recovery)"
                value={binocularVision.npc || ''}
                onChange={(e) => handleChange('npc', e.target.value)}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth size="small" label="Cover / Uncover Test"
                placeholder="e.g. Orthophoria / Exophoria"
                value={binocularVision.coverTest || ''}
                onChange={(e) => handleChange('coverTest', e.target.value)}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth size="small" label="Heterophoria / Tropia"
                placeholder="e.g. 4 Prism Diopters Eso"
                value={binocularVision.phoria || ''}
                onChange={(e) => handleChange('phoria', e.target.value)}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth size="small" label="Fusional Vergence Ranges"
                placeholder="e.g. BI 12/16/8 | BO 20/24/14"
                value={binocularVision.vergence || ''}
                onChange={(e) => handleChange('vergence', e.target.value)}
              />
            </Grid>
          </Grid>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 2, bgcolor: '#ffffff', mb: 2 }}>
          <Typography variant="subtitle2" fontWeight={800} color="primary" sx={{ mb: 2 }}>
            2. Accommodation & Sensory Fusion
          </Typography>
          <Grid container spacing={2}>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth size="small" label="Amplitude of Accommodation"
                placeholder="e.g. 10.5 D (Donder's Push-up)"
                value={binocularVision.accommodation || ''}
                onChange={(e) => handleChange('accommodation', e.target.value)}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth size="small" label="Worth Four Dot Test"
                placeholder="e.g. 4 Dots (Normal Fusion)"
                value={binocularVision.worthFourDot || ''}
                onChange={(e) => handleChange('worthFourDot', e.target.value)}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth size="small" label="Stereo Vision (Stereopsis)"
                placeholder="e.g. 40 sec of arc (Randot)"
                value={binocularVision.stereoVision || ''}
                onChange={(e) => handleChange('stereoVision', e.target.value)}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth select size="small" label="Ocular Dominance"
                value={binocularVision.eyeDominance || ''}
                onChange={(e) => handleChange('eyeDominance', e.target.value)}
              >
                <MenuItem value="">-- Select Dominant Eye --</MenuItem>
                <MenuItem value="Right Eye (OD)">Right Eye (OD)</MenuItem>
                <MenuItem value="Left Eye (OS)">Left Eye (OS)</MenuItem>
              </TextField>
            </Grid>
          </Grid>
        </Paper>

        <Paper variant="outlined" sx={{ p: 2.5, borderRadius: 2, bgcolor: '#ffffff' }}>
          <Typography variant="subtitle2" fontWeight={800} color="primary" sx={{ mb: 1.5 }}>
            3. Orthoptic Therapy & Prism Recommendations
          </Typography>
          <TextField
            fullWidth multiline rows={3} size="small"
            placeholder="Enter vision therapy exercises, pencil push-ups, Brock string protocol, or prism prescription notes..."
            value={binocularVision.therapyNotes || ''}
            onChange={(e) => handleChange('therapyNotes', e.target.value)}
          />
        </Paper>
      </DialogContent>

      <DialogActions sx={{ p: 2, bgcolor: '#ffffff' }}>
        <Button onClick={onClose} variant="outlined" color="inherit">
          Cancel
        </Button>
        <Button onClick={onClose} variant="contained" color="success" startIcon={<SaveIcon />}>
          Save Orthoptics Evaluation
        </Button>
      </DialogActions>
    </Dialog>
  );
}
