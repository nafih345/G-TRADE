import React from 'react';
import { Box, Typography } from '@mui/material';

export const GreensolLogo = ({ iconOnly = false, size = 'medium' }) => {
  const iconDimensions = size === 'small' ? 32 : size === 'large' ? 44 : 38;
  const fontSizeMain = size === 'small' ? '1.15rem' : size === 'large' ? '1.5rem' : '1.3rem';
  const fontSizeSub = size === 'small' ? '0.6rem' : size === 'large' ? '0.7rem' : '0.65rem';

  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.25, userSelect: 'none' }}>
      {/* Greensol Emblem Icon */}
      <Box
        sx={{
          width: iconDimensions,
          height: iconDimensions,
          borderRadius: '10px',
          background: 'linear-gradient(135deg, #059669 0%, #10b981 60%, #34d399 100%)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          boxShadow: '0 4px 14px 0 rgba(16, 185, 129, 0.35)',
          flexShrink: 0,
          transition: 'all 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          '&:hover': {
            transform: 'scale(1.05) rotate(-3deg)',
            boxShadow: '0 6px 20px 0 rgba(16, 185, 129, 0.5)',
          }
        }}
      >
        <svg
          width={iconDimensions * 0.62}
          height={iconDimensions * 0.62}
          viewBox="0 0 24 24"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          {/* Eye / Optical Lens combined with Greensol Leaf emblem */}
          <path
            d="M2 12C2 12 5.5 5.5 12 5.5C18.5 5.5 22 12 22 12C22 12 18.5 18.5 12 18.5C5.5 18.5 2 12 2 12Z"
            stroke="#ffffff"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
          {/* Inner Optical Lens Pupil / Iris */}
          <circle cx="12" cy="12" r="3.8" fill="#ffffff" />
          <circle cx="12" cy="12" r="1.8" fill="#059669" />
          {/* Leaf Sparkle Accent */}
          <path
            d="M16.5 7.5C17.5 6.5 19 6.5 19 6.5C19 6.5 19 8 18 9"
            stroke="#ffffff"
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </svg>
      </Box>

      {/* Greensol Brand Text */}
      {!iconOnly && (
        <Box sx={{ display: 'flex', flexDirection: 'column' }}>
          <Typography
            component="span"
            sx={{
              fontWeight: 800,
              fontSize: fontSizeMain,
              letterSpacing: '-0.02em',
              background: 'linear-gradient(135deg, #10b981 0%, #059669 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              lineHeight: 1.1,
              fontFamily: '"Outfit", "Plus Jakarta Sans", sans-serif',
            }}
          >
            Greensol
          </Typography>
          <Typography
            component="span"
            sx={{
              fontWeight: 700,
              fontSize: fontSizeSub,
              letterSpacing: '0.14em',
              color: 'text.secondary',
              textTransform: 'uppercase',
              lineHeight: 1,
              mt: 0.3,
            }}
          >
            Optical ERP
          </Typography>
        </Box>
      )}
    </Box>
  );
};

export default GreensolLogo;
