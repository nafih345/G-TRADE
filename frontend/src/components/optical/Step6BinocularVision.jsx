import React from 'react';
import { 
  Box, Card, Typography, Grid, TextField, MenuItem 
} from '@mui/material';
import { RemoveRedEye as BinocularIcon } from '@mui/icons-material';

export default function Step6BinocularVision({ binocularVision, setBinocularVision }) {
  const handleChange = (field, value) => {
    setBinocularVision(prev => ({ ...prev, [field]: value }));
  };

  return (
    <Card elevation={0} sx={{ p: 3, border: '1px solid', borderColor: 'divider', borderRadius: 3 }}>
      <Typography variant="h6" fontWeight={800} color="primary.main" sx={{ mb: 1, display: 'flex', alignItems: 'center', gap: 1 }}>
        <BinocularIcon /> Step 6: Binocular Vision & Orthoptic Evaluation
      </Typography>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 3 }}>
        Assess Near Point of Convergence (NPC), cover test, phoria/tropia, vergence ranges, accommodation, Worth 4 Dot, and stereopsis.
      </Typography>

      <Grid container spacing={2.5}>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Near Point of Convergence (NPC)"
            value={binocularVision.npc || ''}
            onChange={(e) => handleChange('npc', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Cover / Uncover Test"
            value={binocularVision.coverTest || ''}
            onChange={(e) => handleChange('coverTest', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Heterophoria / Tropia"
            value={binocularVision.phoria || ''}
            onChange={(e) => handleChange('phoria', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Fusional Vergence Ranges"
            value={binocularVision.vergence || ''}
            onChange={(e) => handleChange('vergence', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Amplitude of Accommodation"
            value={binocularVision.accommodation || ''}
            onChange={(e) => handleChange('accommodation', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Worth Four Dot Test"
            value={binocularVision.worthFourDot || ''}
            onChange={(e) => handleChange('worthFourDot', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            label="Stereo Vision (Stereopsis)"
            value={binocularVision.stereoVision || ''}
            onChange={(e) => handleChange('stereoVision', e.target.value)}
            size="small"
          />
        </Grid>
        <Grid item xs={12} sm={6} md={3}>
          <TextField
            fullWidth
            select
            label="Ocular Dominance"
            value={binocularVision.eyeDominance || ''}
            onChange={(e) => handleChange('eyeDominance', e.target.value)}
            size="small"
          >
            <MenuItem value="Right Eye">Right Eye (OD)</MenuItem>
            <MenuItem value="Left Eye">Left Eye (OS)</MenuItem>
          </TextField>
        </Grid>
      </Grid>
    </Card>
  );
}
