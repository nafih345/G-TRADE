import React, { useState } from 'react';
import { 
  Box, Card, CardContent, TextField, Button, 
  Typography, Container, Alert, Stack, CircularProgress 
} from '@mui/material';
import { useAuth } from '../context/AuthContext';

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('password');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      const result = await login(username, password);
      if (!result.success) {
        setError('Invalid username or password.');
      }
    } catch (err) {
      setError('An error occurred. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const handleQuickSelect = (roleName) => {
    setUsername(roleName.toLowerCase());
    setPassword('password');
  };

  return (
    <Box sx={{
      minHeight: '100vh',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'radial-gradient(circle at 10% 20%, rgba(99, 102, 241, 0.08) 0%, transparent 40%), radial-gradient(circle at 90% 80%, rgba(168, 85, 247, 0.08) 0%, transparent 40%)',
      backgroundColor: 'background.default',
      py: 4
    }}>
      <Container maxWidth="sm">
        <Box sx={{ textCenter: 'center', mb: 4, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
          <Typography variant="h3" sx={{ fontWeight: 900, mb: 1, display: 'flex', alignItems: 'center', gap: 1.5 }}>
            <span style={{ fontSize: '2.5rem' }}>⚡</span>
            <span className="gradient-text">GREENSOL</span>
          </Typography>
          <Typography variant="body1" color="text.secondary">
            Enterprise Resource Planning Core System
          </Typography>
        </Box>

        <Card sx={{ 
          background: 'background.paper',
          backdropFilter: 'blur(20px)',
          border: '1px solid',
          borderColor: 'divider',
          boxShadow: '0 20px 40px rgba(99, 102, 241, 0.05)',
          borderRadius: 4
        }}>
          <CardContent sx={{ p: 4 }}>
            <Typography variant="h5" sx={{ fontWeight: 700, mb: 3 }}>
              Welcome back
            </Typography>

            {error && <Alert severity="error" sx={{ mb: 3, borderRadius: 2 }}>{error}</Alert>}

            <form onSubmit={handleSubmit}>
              <Stack spacing={2.5}>
                <TextField
                  label="Username or Email"
                  variant="outlined"
                  fullWidth
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      backgroundColor: 'action.hover',
                    }
                  }}
                />
                <TextField
                  label="Password"
                  type="password"
                  variant="outlined"
                  fullWidth
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  sx={{
                    '& .MuiOutlinedInput-root': {
                      backgroundColor: 'action.hover',
                    }
                  }}
                />

                <Button 
                  type="submit" 
                  variant="contained" 
                  size="large"
                  disabled={loading}
                  sx={{ py: 1.8, fontSize: '1rem', position: 'relative' }}
                >
                  {loading ? <CircularProgress size={24} sx={{ color: 'white' }} /> : 'Sign In'}
                </Button>
              </Stack>
            </form>

            <Box sx={{ mt: 4 }}>
              <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1.5, textAlign: 'center', fontWeight: 600 }}>
                QUICK ACCESS ROLES (DEMO PRESETS)
              </Typography>
              <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap sx={{ justifyContent: 'center', gap: 1 }}>
                {['admin', 'manager', 'accountant', 'cashier'].map((role) => (
                  <Button 
                    key={role} 
                    size="small" 
                    variant="outlined"
                    onClick={() => handleQuickSelect(role)}
                    sx={{ 
                      borderRadius: 5, 
                      fontSize: '0.75rem', 
                      py: 0.5, 
                      borderColor: 'divider',
                      color: 'text.secondary',
                      '&:hover': {
                        borderColor: 'primary.main',
                        color: 'primary.main'
                      }
                    }}
                  >
                    {role.toUpperCase()}
                  </Button>
                ))}
              </Stack>
            </Box>
          </CardContent>
        </Card>
      </Container>
    </Box>
  );
}
