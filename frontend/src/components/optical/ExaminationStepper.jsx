import React from 'react';
import { Box, Paper, Typography, Stack, Chip, Button } from '@mui/material';
import { 
  Person as Step1Icon, 
  MedicalServices as Step2Icon, 
  Visibility as Step3Icon, 
  Analytics as Step4Icon, 
  CheckCircle as Step5Icon, 
  RemoveRedEye as Step6Icon, 
  Healing as Step7Icon, 
  AssignmentTurnedIn as Step8Icon, 
  LocalShippingOutlined as Step9Icon, 
  Print as Step10Icon,
  Check as CompletedCheckIcon
} from '@mui/icons-material';

export const stepsList = [
  { label: 'Patient Info', icon: <Step1Icon fontSize="small" /> },
  { label: 'Medical History', icon: <Step2Icon fontSize="small" /> },
  { label: 'Visual Acuity', icon: <Step3Icon fontSize="small" /> },
  { label: 'Objective Refraction', icon: <Step4Icon fontSize="small" /> },
  { label: 'Subjective Refraction', icon: <Step5Icon fontSize="small" /> },
  { label: 'Binocular Vision', icon: <Step6Icon fontSize="small" /> },
  { label: 'Eye Health', icon: <Step7Icon fontSize="small" /> },
  { label: 'Diagnosis', icon: <Step8Icon fontSize="small" /> },
  { label: 'Prescription', icon: <Step9Icon fontSize="small" /> },
  { label: 'Review & Print', icon: <Step10Icon fontSize="small" /> }
];

export default function ExaminationStepper({ activeStep, setActiveStep, completedSteps }) {
  return (
    <Paper
      elevation={0}
      sx={{
        p: 1.5,
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 3,
        mb: 3,
        overflowX: 'auto',
        bgcolor: 'background.paper',
        '&::-webkit-scrollbar': { height: '5px' },
        '&::-webkit-scrollbar-thumb': { bgcolor: 'rgba(37, 99, 235, 0.2)', borderRadius: '4px' }
      }}
    >
      <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 'max-content' }}>
        {stepsList.map((step, idx) => {
          const isActive = activeStep === idx;
          const isCompleted = idx < activeStep;

          return (
            <Button
              key={idx}
              onClick={() => setActiveStep(idx)}
              variant={isActive ? 'contained' : isCompleted ? 'outlined' : 'text'}
              color={isActive ? 'primary' : isCompleted ? 'success' : 'inherit'}
              size="small"
              startIcon={isCompleted ? <CompletedCheckIcon fontSize="small" /> : step.icon}
              sx={{
                borderRadius: 2,
                px: 2,
                py: 1,
                fontWeight: isActive ? 800 : isCompleted ? 700 : 500,
                fontSize: '0.8rem',
                textTransform: 'none',
                whiteSpace: 'nowrap',
                transition: 'all 0.2s ease',
                bgcolor: isActive ? 'primary.main' : isCompleted ? 'rgba(16, 185, 129, 0.06)' : 'transparent',
                borderColor: isCompleted ? 'success.main' : 'divider',
                boxShadow: isActive ? '0 4px 12px rgba(37, 99, 235, 0.25)' : 'none',
                '&:hover': {
                  transform: 'translateY(-1px)'
                }
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.8 }}>
                <Typography component="span" sx={{ fontSize: '0.75rem', opacity: 0.8 }}>
                  {idx + 1}.
                </Typography>
                {step.label}
              </Box>
            </Button>
          );
        })}
      </Stack>
    </Paper>
  );
}
