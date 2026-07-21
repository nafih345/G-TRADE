import { createTheme } from '@mui/material/styles';

const baseDesignTokens = (mode) => ({
  palette: {
    mode,
    primary: {
      main: '#6366f1', // Vibrant Indigo
      light: '#818cf8',
      dark: '#4f46e5',
      contrastText: '#ffffff',
    },
    secondary: {
      main: '#a855f7', // Radiant Purple/Violet
      light: '#c084fc',
      dark: '#9333ea',
    },
    background: {
      default: mode === 'dark' ? '#090d16' : '#f8fafc',
      paper: mode === 'dark' ? '#111827' : '#ffffff',
      sidebar: mode === 'dark' ? '#0f172a' : '#f1f5f9',
    },
    text: {
      primary: mode === 'dark' ? '#f3f4f6' : '#0f172a',
      secondary: mode === 'dark' ? '#9ca3af' : '#475569',
    },
    divider: mode === 'dark' ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)',
  },
  typography: {
    fontFamily: '"Plus Jakarta Sans", "Outfit", "Inter", sans-serif',
    h1: { fontWeight: 800, letterSpacing: '-0.02em' },
    h2: { fontWeight: 700, letterSpacing: '-0.01em' },
    h3: { fontWeight: 700 },
    h4: { fontWeight: 600 },
    h5: { fontWeight: 600 },
    h6: { fontWeight: 600 },
    subtitle1: { fontWeight: 500 },
    body1: { fontSize: '0.925rem' },
    button: { textTransform: 'none', fontWeight: 600 },
  },
  shape: {
    borderRadius: 12,
  },
});

export const getTheme = (mode) => {
  const tokens = baseDesignTokens(mode);
  return createTheme({
    ...tokens,
    components: {
      MuiButton: {
        styleOverrides: {
          root: {
            borderRadius: 10,
            padding: '8px 20px',
            boxShadow: 'none',
            '&:hover': {
              boxShadow: 'none',
            },
          },
          containedPrimary: {
            background: 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)',
            '&:hover': {
              background: 'linear-gradient(135deg, #4f46e5 0%, #4338ca 100%)',
            },
          },
        },
      },
      MuiCard: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
            borderRadius: 16,
            boxShadow: mode === 'dark' 
              ? '0 4px 20px 0 rgba(0, 0, 0, 0.3)' 
              : '0 4px 20px 0 rgba(99, 102, 241, 0.05)',
            border: mode === 'dark' ? '1px solid rgba(255, 255, 255, 0.05)' : '1px solid rgba(0, 0, 0, 0.04)',
          },
        },
      },
      MuiPaper: {
        styleOverrides: {
          root: {
            backgroundImage: 'none',
          },
        },
      },
    },
  });
};
