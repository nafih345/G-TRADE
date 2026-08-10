import React from 'react';
import { 
  Dialog, DialogTitle, DialogContent, DialogActions, 
  Typography, Button, Box, Stack, Avatar 
} from '@mui/material';
import { Warning as WarningIcon, Delete as DeleteIcon, HelpOutline as QuestionIcon } from '@mui/icons-material';

/**
 * Modern Material UI Confirmation Dialog to replace ugly browser window.confirm() popups
 */
export default function ConfirmActionDialog({
  open = false,
  title = "Confirm Action",
  message = "Are you sure you want to proceed?",
  confirmText = "Confirm",
  cancelText = "Cancel",
  type = "warning", // 'danger' | 'warning' | 'info'
  onConfirm,
  onClose
}) {
  const getHeaderBg = () => {
    if (type === 'danger') return '#fef2f2';
    if (type === 'warning') return '#fffbeb';
    return '#f0f9ff';
  };

  const getHeaderColor = () => {
    if (type === 'danger') return '#dc2626';
    if (type === 'warning') return '#d97706';
    return '#0284c7';
  };

  const getIcon = () => {
    if (type === 'danger') return <DeleteIcon sx={{ color: '#dc2626', fontSize: 28 }} />;
    if (type === 'warning') return <WarningIcon sx={{ color: '#d97706', fontSize: 28 }} />;
    return <QuestionIcon sx={{ color: '#0284c7', fontSize: 28 }} />;
  };

  return (
    <Dialog 
      open={open} 
      onClose={onClose} 
      maxWidth="xs" 
      fullWidth
      PaperProps={{
        sx: {
          borderRadius: 4,
          overflow: 'hidden',
          boxShadow: '0 20px 25px -5px rgba(0,0,0,0.1), 0 10px 10px -5px rgba(0,0,0,0.04)'
        }
      }}
    >
      <Box sx={{ p: 3, bgcolor: getHeaderBg() }}>
        <Stack direction="row" spacing={2} alignItems="center">
          <Avatar sx={{ bgcolor: '#ffffff', width: 48, height: 48, boxShadow: '0 2px 4px rgba(0,0,0,0.06)' }}>
            {getIcon()}
          </Avatar>
          <Box>
            <Typography variant="h6" fontWeight={850} sx={{ color: getHeaderColor(), lineHeight: 1.2 }}>
              {title}
            </Typography>
            <Typography variant="caption" color="text.secondary" fontWeight={600}>
              Action Confirmation Required
            </Typography>
          </Box>
        </Stack>
      </Box>

      <DialogContent sx={{ p: 3, pt: 2.5 }}>
        <Typography variant="body2" sx={{ color: '#334155', lineHeight: 1.6, fontWeight: 500 }}>
          {message}
        </Typography>
      </DialogContent>

      <DialogActions sx={{ p: 2.5, bgcolor: '#f8fafc', gap: 1 }}>
        <Button 
          onClick={onClose}
          variant="outlined"
          sx={{ borderRadius: 2.5, px: 2.5, fontWeight: 700, borderColor: '#cbd5e1', color: '#475569' }}
        >
          {cancelText}
        </Button>
        <Button 
          onClick={() => {
            if (onConfirm) onConfirm();
            if (onClose) onClose();
          }}
          variant="contained"
          color={type === 'danger' ? 'error' : (type === 'warning' ? 'warning' : 'primary')}
          sx={{ borderRadius: 2.5, px: 3, fontWeight: 700, boxShadow: 'none' }}
        >
          {confirmText}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
