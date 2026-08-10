import React, { useState, useRef } from 'react';
import { 
  Box, TextField, InputAdornment, IconButton, Menu, 
  MenuItem, Typography, Divider, Stack, Chip, Tooltip 
} from '@mui/material';
import { 
  Event as EventIcon, 
  ArrowDropDown as DropDownIcon,
  Schedule as ScheduleIcon,
  Today as TodayIcon
} from '@mui/icons-material';

/**
 * Enhanced Date Picker Field with Interactive Calendar & Quick Date Selection Presets
 */
export default function QuickDatePickerField({
  label = "Date",
  value = "",
  onChange,
  baseDate = new Date(),
  quickPresets = [],
  showChips = false,
  chipPresets = [],
  size = "small",
  fullWidth = true,
  required = false,
  disabled = false,
  sx = {}
}) {
  const inputRef = useRef(null);
  const [anchorEl, setAnchorEl] = useState(null);

  // Ensure value is in YYYY-MM-DD format for native HTML <input type="date">
  const normalizeDateValue = (val) => {
    if (!val) return '';
    if (typeof val === 'string' && val.includes('T')) {
      return val.split('T')[0];
    }
    // If format is DD-MM-YYYY, convert to YYYY-MM-DD
    if (typeof val === 'string' && val.includes('-')) {
      const parts = val.split('-');
      if (parts[0].length === 2 && parts[2].length === 4) {
        return `${parts[2]}-${parts[1]}-${parts[0]}`;
      }
    }
    return val;
  };

  const formattedValue = normalizeDateValue(value);

  // Calculate relative date offset
  const calculateOffsetDate = (type, amount) => {
    let reference = baseDate ? new Date(baseDate) : new Date();
    if (isNaN(reference.getTime())) {
      reference = new Date();
    }

    const d = new Date(reference.getTime());

    if (type === 'today') {
      const now = new Date();
      return now.toISOString().split('T')[0];
    }
    if (type === 'yesterday') {
      d.setDate(d.getDate() - 1);
    } else if (type === 'tomorrow') {
      d.setDate(d.getDate() + 1);
    } else if (type === 'days') {
      d.setDate(d.getDate() + amount);
    } else if (type === 'weeks') {
      d.setDate(d.getDate() + (amount * 7));
    } else if (type === 'months') {
      d.setMonth(d.getMonth() + amount);
    } else if (type === 'years') {
      d.setFullYear(d.getFullYear() + amount);
    }

    return d.toISOString().split('T')[0];
  };

  const handleOpenPicker = (e) => {
    if (e) e.stopPropagation();
    if (inputRef.current) {
      if (typeof inputRef.current.showPicker === 'function') {
        try {
          inputRef.current.showPicker();
        } catch (err) {
          inputRef.current.focus();
        }
      } else {
        inputRef.current.focus();
      }
    }
  };

  const handleSelectPreset = (type, amount) => {
    const calculated = calculateOffsetDate(type, amount);
    if (onChange) onChange(calculated);
    setAnchorEl(null);
  };

  // Default Presets if none provided
  const defaultPresets = quickPresets.length > 0 ? quickPresets : [
    { label: 'Today', type: 'today' },
    { label: 'In 1 Week (+7 Days)', type: 'weeks', amount: 1 },
    { label: 'In 1 Month', type: 'months', amount: 1 },
    { label: 'In 3 Months', type: 'months', amount: 3 },
    { label: 'In 6 Months', type: 'months', amount: 6 },
    { label: 'In 1 Year', type: 'years', amount: 1 },
  ];

  // Default Quick Chips if enabled
  const activeChips = chipPresets.length > 0 ? chipPresets : [
    { label: '+1M', type: 'months', amount: 1 },
    { label: '+3M', type: 'months', amount: 3 },
    { label: '+6M', type: 'months', amount: 6 },
    { label: '+1Y', type: 'years', amount: 1 },
  ];

  return (
    <Box sx={{ width: fullWidth ? '100%' : 'auto', position: 'relative', ...sx }}>
      <TextField
        fullWidth={fullWidth}
        type="date"
        size={size}
        label={label}
        value={formattedValue}
        required={required}
        disabled={disabled}
        onChange={(e) => onChange && onChange(e.target.value)}
        inputRef={inputRef}
        InputLabelProps={{ shrink: true }}
        sx={{
          '& input::-webkit-calendar-picker-indicator': {
            display: 'none !important',
            '-webkit-appearance': 'none !important'
          },
          '& input::-webkit-inner-spin-button': {
            display: 'none !important',
            '-webkit-appearance': 'none !important'
          },
          '& .MuiOutlinedInput-root': {
            pr: 0.5,
            borderRadius: 2.5
          },
          '& input': {
            py: size === 'small' ? 0.6 : 1,
            fontSize: '0.8rem',
            fontWeight: 600
          }
        }}
        InputProps={{
          endAdornment: (
            <InputAdornment position="end" sx={{ ml: 0 }}>
              <Stack direction="row" spacing={0} alignItems="center">
                {defaultPresets.length > 0 && (
                  <Tooltip title="Quick Date Selection Menu">
                    <IconButton
                      size="small"
                      disabled={disabled}
                      onClick={(e) => {
                        e.stopPropagation();
                        setAnchorEl(e.currentTarget);
                      }}
                      sx={{ color: 'primary.main', p: 0.2 }}
                    >
                      <DropDownIcon sx={{ fontSize: 16 }} />
                    </IconButton>
                  </Tooltip>
                )}
                <Tooltip title="Click to Open Calendar Picker">
                  <IconButton
                    size="small"
                    disabled={disabled}
                    onClick={handleOpenPicker}
                    sx={{ color: 'action.active', p: 0.2, '&:hover': { color: 'primary.main', bgcolor: 'action.hover' } }}
                  >
                    <EventIcon sx={{ fontSize: 18 }} />
                  </IconButton>
                </Tooltip>
              </Stack>
            </InputAdornment>
          ),
          onClick: (e) => {
            if (e.target.tagName === 'INPUT' && !disabled) {
              handleOpenPicker();
            }
          }
        }}
      />

      {/* Quick Selection Dropdown Menu */}
      <Menu
        anchorEl={anchorEl}
        open={Boolean(anchorEl)}
        onClose={() => setAnchorEl(null)}
        PaperProps={{
          elevation: 4,
          sx: { borderRadius: 2.5, mt: 1, minWidth: 190, border: '1px solid', borderColor: 'divider' }
        }}
      >
        <Box sx={{ px: 2, py: 1, bgcolor: '#f8fafc' }}>
          <Typography variant="caption" sx={{ fontWeight: 800, color: 'primary.main', display: 'flex', alignItems: 'center', gap: 0.5 }}>
            <ScheduleIcon fontSize="inherit" /> Date Selection Shortcuts
          </Typography>
        </Box>
        <Divider />
        {defaultPresets.map((preset, idx) => (
          <MenuItem
            key={idx}
            onClick={() => handleSelectPreset(preset.type, preset.amount)}
            sx={{ fontSize: '0.82rem', fontWeight: 600, py: 0.8 }}
          >
            {preset.label}
          </MenuItem>
        ))}
        <Divider />
        <MenuItem
          onClick={() => { if (onChange) onChange(''); setAnchorEl(null); }}
          sx={{ fontSize: '0.82rem', color: 'error.main', fontWeight: 700, py: 0.8 }}
        >
          Clear Date
        </MenuItem>
      </Menu>

      {/* Optional Quick Action Chips below Field */}
      {showChips && (
        <Stack direction="row" spacing={0.5} sx={{ mt: 0.5, flexWrap: 'wrap', gap: 0.4 }}>
          {activeChips.map((chip, idx) => (
            <Chip
              key={idx}
              label={chip.label}
              size="small"
              onClick={() => handleSelectPreset(chip.type, chip.amount)}
              sx={{ 
                height: 20, 
                fontSize: '0.68rem', 
                fontWeight: 700, 
                cursor: 'pointer',
                bgcolor: 'primary.50',
                color: 'primary.main',
                border: '1px solid',
                borderColor: 'primary.200',
                '&:hover': { bgcolor: 'primary.main', color: '#fff' }
              }}
            />
          ))}
        </Stack>
      )}
    </Box>
  );
}
